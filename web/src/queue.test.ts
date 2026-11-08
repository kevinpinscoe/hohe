// The offline queue and the sync engine, against fake-indexeddb and a fake server.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestTimeout } from './api';
import * as db from './db';
import { buildCtx, intents, IntentError, type Intent } from './intents';
import { displayState, fromServer } from './local';
import { openPlacement } from './model';
import type { Op, Result, SrvView } from './server';
import { drainQueue, planBatch, withSyncLock } from './sync';
import { placement, task, TODAY, view } from './fixtures.test-util';

const enqueue = (i: Intent) => db.enqueue((s) => i(buildCtx(s, TODAY)));

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db.resetDbHandle();
  await db.deviceId();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRequestTimeout(15_000);
});

/** A tiny in-memory imitation of the server's sync endpoint, enough for queue tests. */
function fakeServer(initial: SrvView) {
  const state = structuredClone(initial);
  const seen = new Map<string, Result>();
  let pseq = 100;
  const calls: Op[][] = [];
  const handle = (op: Op): Result => {
    if (seen.has(op.id)) return { ...seen.get(op.id)!, replayed: true };
    let r: Result = { opId: op.id, status: 'applied' };
    const t = state.tasks!.find((x) => x.id === op.taskId);
    switch (op.type) {
      case 'capture':
      case 'create':
        state.tasks!.push(task(op.taskId!, op.title!));
        r = { ...r, taskId: op.taskId, revision: 1 };
        break;
      case 'edit': {
        if (!t) {
          r = { opId: op.id, status: 'rejected', reason: `unknown task ${op.taskId}` };
          break;
        }
        const base = op.dependsOn ? seen.get(op.dependsOn)?.revision : op.baseRevision;
        const cur = t.revisions![op.field!];
        if (base !== cur) {
          r = { opId: op.id, status: 'conflict', conflictId: 'c-1', revision: cur };
          break;
        }
        (t as unknown as Record<string, unknown>)[op.field!] = op.value;
        t.revisions![op.field!] = cur + 1;
        if (op.field === 'priority') {
          const p = state.placements!.find((x) => x.taskId === t.id && x.outcome === '');
          if (p) p.letter = op.value as string;
        }
        r = { ...r, taskId: t.id, revision: cur + 1 };
        break;
      }
      case 'assign': {
        const id = `p-${pseq++}`;
        state.placements!.push(placement(id, op.taskId!, op.day!, { letter: t!.priority }));
        r = { ...r, taskId: op.taskId, placementId: id };
        break;
      }
      case 'setRank': {
        const p = state.placements!.find((x) => x.id === op.placementId);
        if (!p) r = { opId: op.id, status: 'rejected', reason: `unknown placement ${op.placementId}` };
        else p.rank = op.rank!;
        break;
      }
    }
    seen.set(op.id, r);
    return r;
  };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/state') return new Response(JSON.stringify({ state, build: { version: 't', commit: 't' } }));
    if (url === '/api/sync') {
      const body = JSON.parse(String(init!.body)) as { ops: Op[] };
      calls.push(body.ops);
      const results = body.ops.map(handle);
      return new Response(JSON.stringify({ results, state, build: { version: 't', commit: 't' } }));
    }
    return new Response('{}', { status: 404 });
  });
  return { state, calls, fetchImpl, seen };
}

describe('saving before showing', () => {
  it('enqueue resolves only after the op is stored, and the stored op is what is shown', async () => {
    const [q] = await enqueue(intents.capture('Buy stamps'));
    expect(q.seq).toBeTypeOf('number');
    const snap = await db.readAll();
    expect(snap.pending.map((p) => p.op.id)).toEqual([q.op.id]);
    const shown = displayState(fromServer(view(), TODAY), snap.pending);
    expect(shown.tasks.map((t) => t.title)).toEqual(['Buy stamps']);
  });

  it('a failed storage write rejects and stores nothing', async () => {
    const bad: Intent = (c) => [{ ...intents.capture('x')(c)[0], label: (() => 1) as unknown as string }]; // not cloneable
    await expect(enqueue(bad)).rejects.toThrow();
    expect((await db.readAll()).pending).toEqual([]);
  });

  it('an impossible action is refused without storing anything', async () => {
    await expect(enqueue(intents.capture('   '))).rejects.toBeInstanceOf(IntentError);
    expect((await db.readAll()).pending).toEqual([]);
  });
});

describe('dependencies', () => {
  it('capture offline → edit → assign B → number 1: each later op builds on the earlier ones', async () => {
    const [cap] = await enqueue(intents.capture('Renew passport'));
    const tid = cap.op.taskId!;
    const [edit] = await enqueue(intents.edit(tid, 'title', 'Renew passport (form DS-82)'));
    expect(edit.op.dependsOn).toBe(cap.op.id);
    const assigned = await enqueue(intents.assign(tid, 'B', TODAY, '', undefined));
    expect(assigned.map((q) => q.op.type)).toEqual(['edit', 'assign']);
    expect(assigned[0].op).toMatchObject({ field: 'priority', value: 'B', dependsOn: cap.op.id });
    expect(assigned[1].createsPlacement?.localId).toMatch(/^lp-/);
    const snap = await db.readAll();
    const shown = displayState(fromServer(view(), TODAY), snap.pending);
    const pl = openPlacement(shown, tid)!;
    expect(pl.id).toBe(assigned[1].createsPlacement!.localId);
    const [rank] = await enqueue(intents.setRank(pl.id, 1));
    expect(rank.op.placementId).toBe(pl.id);
    const after = displayState(fromServer(view(), TODAY), (await db.readAll()).pending);
    expect(openPlacement(after, tid)).toMatchObject({ letter: 'B', rank: 1 });
    const [edit2] = await enqueue(intents.edit(tid, 'title', 'Renew passport today'));
    expect(edit2.op.dependsOn).toBe(edit.op.id);
  });

  it('an edit of a task the server knows uses its confirmed field revision', async () => {
    await db.saveConfirmed(view({ tasks: [task('t1', 'Old', { revisions: { title: 4 } })] }));
    const [e] = await enqueue(intents.edit('t1', 'title', 'New'));
    expect(e.op).toMatchObject({ baseRevision: 4 });
    expect(e.op.dependsOn).toBeUndefined();
  });
});

describe('server state and the queue stay separate', () => {
  it('saving a fresh /api/state never changes queued ops', async () => {
    await enqueue(intents.capture('Queued'));
    await db.saveConfirmed(view({ tasks: [task('t9', 'From server')] }));
    const snap = await db.readAll();
    expect(snap.pending).toHaveLength(1);
    const shown = displayState(fromServer(snap.confirmed!.view, TODAY), snap.pending);
    expect(shown.tasks.map((t) => t.title).sort()).toEqual(['From server', 'Queued']);
  });
});

describe('sync', () => {
  it('capture → edit → assign B → B1 reaches the server correctly, in two batches', async () => {
    const srv = fakeServer(view());
    vi.stubGlobal('fetch', srv.fetchImpl);
    const [cap] = await enqueue(intents.capture('Renew passport'));
    const tid = cap.op.taskId!;
    await enqueue(intents.edit(tid, 'title', 'Renew passport (DS-82)'));
    const [, asg] = await enqueue(intents.assign(tid, 'B', TODAY, '', undefined));
    await enqueue(intents.setRank(asg.createsPlacement!.localId, 1));

    const out = await drainQueue((await db.readAll()).deviceId!);
    expect(out.kind).toBe('ok');
    expect(srv.calls.map((c) => c.map((o) => o.type))).toEqual([['capture', 'edit', 'edit', 'assign'], ['setRank']]);
    expect(srv.calls[1][0].placementId).toBe('p-100');
    const t = srv.state.tasks!.find((x) => x.id === tid)!;
    expect(t).toMatchObject({ title: 'Renew passport (DS-82)', priority: 'B' });
    expect(srv.state.placements!.find((p) => p.taskId === tid)).toMatchObject({ id: 'p-100', letter: 'B', rank: 1 });
    expect((await db.readAll()).pending).toEqual([]);
  });

  it('a session expiry keeps the whole queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'login required' }), { status: 401 })),
    );
    await enqueue(intents.capture('A'));
    await enqueue(intents.capture('B'));
    const out = await drainQueue('dev');
    expect(out.kind).toBe('unauthorized');
    expect((await db.readAll()).pending).toHaveLength(2);
  });

  it('a stalled request times out as unreachable and keeps the queue', async () => {
    setRequestTimeout(50);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      ),
    );
    await enqueue(intents.capture('A'));
    const out = await drainQueue('dev');
    expect(out).toMatchObject({ kind: 'unreachable' });
    expect(out.message).toContain('no answer');
    expect((await db.readAll()).pending).toHaveLength(1);
  });

  it('closing the app after the server applied a batch: the resend is a replay, not a duplicate', async () => {
    const srv = fakeServer(view());
    await enqueue(intents.capture('Once only'));
    // First attempt: the server applies the batch, but the answer never arrives.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        await srv.fetchImpl(url, init);
        throw new TypeError('connection lost');
      }),
    );
    expect((await drainQueue('dev')).kind).toBe('unreachable');
    expect((await db.readAll()).pending).toHaveLength(1);
    vi.stubGlobal('fetch', srv.fetchImpl);
    expect((await drainQueue('dev')).kind).toBe('ok');
    expect(srv.state.tasks!.filter((t) => t.title === 'Once only')).toHaveLength(1);
    expect((await db.readAll()).pending).toEqual([]);
  });

  it('a rejected op leaves the queue and waits in the attention list', async () => {
    const srv = fakeServer(view());
    vi.stubGlobal('fetch', srv.fetchImpl);
    await db.saveConfirmed(view({ tasks: [task('ghost', 'Gone')] })); // the device believes it exists
    await enqueue(intents.edit('ghost', 'title', 'x'));
    const out = await drainQueue('dev');
    expect(out).toMatchObject({ kind: 'ok', rejected: 1 });
    const snap = await db.readAll();
    expect(snap.pending).toEqual([]);
    expect(snap.attention).toHaveLength(1);
    expect(snap.attention[0].reason).toContain('unknown task');
  });

  it('the batch planner stops after an op whose new placement a later op uses', async () => {
    await enqueue(intents.capture('X'));
    const tid = (await db.readAll()).pending[0].op.taskId!;
    const [asg] = await enqueue(intents.planIt(tid, TODAY));
    await enqueue(intents.setRank(asg.createsPlacement!.localId, 2));
    const snap = await db.readAll();
    expect(planBatch(snap, {}).batch.map((b) => b.op.type)).toEqual(['capture', 'planIt']);
    const mapped = planBatch(snap, { [asg.createsPlacement!.localId]: 'p-7' });
    expect(mapped.batch.map((b) => b.op.placementId ?? '')).toEqual(['', '', 'p-7']);
  });
});

describe('one sync at a time', () => {
  it('a second holder is turned away while the lock is held', async () => {
    let held = false;
    const locks = {
      request: async (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => {
        if (held) return cb(null);
        held = true;
        try {
          return await cb({});
        } finally {
          held = false;
        }
      },
    };
    vi.stubGlobal('navigator', { locks });
    let release!: () => void;
    const first = withSyncLock(() => new Promise<string>((r) => (release = () => r('first'))));
    const second = await withSyncLock(async () => 'second');
    expect(second).toBeNull();
    release();
    expect(await first).toBe('first');
  });
});
