// The sync engine: sends the queue to the server and records the answers.
//
// - One sync at a time per device: a Web Lock ("hohe-sync") is shared by every tab and the
//   installed PWA, so two of them never send or acknowledge the same queue concurrently. A tab
//   that finds the lock held does not wait; the holder broadcasts when it is done.
// - Ops are sent in queue order. Each answered op is removed from the queue in the same
//   IndexedDB transaction that stores the state the server returned, so the screen never
//   double-applies or loses one.
// - Closing the app mid-request is safe: unanswered ops stay queued and are resent, and the
//   server returns the original result for an op id it has already applied.
// - An authentication failure stops the sync and leaves the queue untouched.
// - A batch stops after an op that creates a placement a later queued op refers to; the
//   server's placement id from that op's result replaces the local id before the later op is
//   sent (see intents.ts).

import { api, ApiError } from './api';
import { commitSync, DeviceClearedError, readAll, rejectLocally, type Attention, type PlacementTarget, type Snapshot } from './db';
import { isLocalPlacement, type QueuedOp } from './local';
import { list, type Op, type Result, type SrvView } from './server';

export const MAX_BATCH = 200;
const MAX_ROUNDS = 50;

export type SyncKind = 'ok' | 'busy' | 'unreachable' | 'unauthorized' | 'refused' | 'server' | 'storage' | 'cleared';

export interface SyncOutcome {
  kind: SyncKind;
  message?: string;
  sent: number;
  savedOnServer: number; // applied or no-op
  conflicts: number; // sent to the conflict tray or held with a conflict
  rejected: number;
  notices: string[];
}

type Locks = { request: (name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown> };

/**
 * Run `fn` holding the device-wide sync lock, WAITING for it if a sync (in any tab) holds it.
 * Logout and "Clear this device" use this, so they never interleave with a sync.
 */
export async function withSyncLockWaiting<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  if (!locks) return fn(); // no Web Locks: the epoch check in commitSync still guards the data
  let out!: T;
  await locks.request('hohe-sync', {}, async () => {
    out = await fn();
  });
  return out;
}

/** Run `fn` holding the device-wide sync lock, or return null if another tab holds it. */
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  if (!locks) return fn(); // no Web Locks: ops are still replay-safe on the server
  let out: T | null = null;
  await locks.request('hohe-sync', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    out = await fn();
  });
  return out;
}

type Ref = { id: string } | { wait: true } | { missing: true };

/** Resolve a placement reference against the map, the queue and the confirmed state. */
export function resolveRef(id: string, snap: Snapshot, map: Record<string, PlacementTarget>, inBatch: Set<string>): Ref {
  if (!isLocalPlacement(id)) return { id };
  const t = map[id];
  if (typeof t === 'string') return { id: t };
  if (t) {
    const ps = list(snap.confirmed?.view.placements).filter((p) => p.taskId === t.taskId && p.day === t.day);
    const pick = ps.find((p) => p.outcome === '') ?? ps[ps.length - 1];
    return pick ? { id: pick.id } : { missing: true };
  }
  if (inBatch.has(id)) return { wait: true };
  if (snap.pending.some((q) => q.createsPlacement?.localId === id)) return { wait: true };
  return { missing: true };
}

interface Planned {
  batch: { q: QueuedOp; op: Op }[];
  unsendable: { q: QueuedOp; reason: string }[];
}

/** Choose the next batch, rewriting local placement ids where the server's id is known. */
export function planBatch(snap: Snapshot, map: Record<string, PlacementTarget>): Planned {
  const batch: Planned['batch'] = [];
  const unsendable: Planned['unsendable'] = [];
  const created = new Set<string>(); // local placements created by ops already in this batch
  for (const q of snap.pending) {
    if (batch.length >= MAX_BATCH) break;
    const op: Op = { ...q.op };
    let wait = false;
    let missing = false;
    const fix = (id: string | undefined): string | undefined => {
      if (!id) return id;
      const r = resolveRef(id, snap, map, created);
      if ('wait' in r) wait = true;
      if ('missing' in r) missing = true;
      return 'id' in r ? r.id : id;
    };
    op.placementId = fix(op.placementId);
    if (op.order) op.order = op.order.map((id) => fix(id) as string);
    if (op.basePlacementId) {
      // The base only makes a stale check possible; without a server id, send none.
      const r = resolveRef(op.basePlacementId, snap, map, created);
      if ('wait' in r) wait = true;
      op.basePlacementId = 'id' in r ? r.id : undefined;
    }
    if (wait) break; // the creating op must be answered first
    if (missing && (op.type === 'setRank' || op.type === 'reorder')) {
      unsendable.push({ q, reason: 'The entry this change refers to was never created on the server.' });
      continue;
    }
    batch.push({ q, op });
    if (q.createsPlacement) created.add(q.createsPlacement.localId);
  }
  return { batch, unsendable };
}

/** Send the queue until it is empty or the server cannot take more. Caller holds the lock. */
export async function drainQueue(deviceId: string): Promise<SyncOutcome> {
  const out: SyncOutcome = { kind: 'ok', sent: 0, savedOnServer: 0, conflicts: 0, rejected: 0, notices: [] };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const snap = await readAll();
      if (snap.pending.length === 0) {
        if (round === 0) {
          const r = await api.state();
          await commitSync({ acknowledged: [], rejected: [], placementMap: pruneMap(snap.placementMap), view: r.state, epoch: snap.epoch });
        }
        return out;
      }
      const map = { ...snap.placementMap };
      const plan = planBatch(snap, map);
      for (const u of plan.unsendable) {
        await rejectLocally(u.q, u.reason);
        out.rejected++;
      }
      if (plan.batch.length === 0) continue;
      const resp = await api.sync(
        deviceId,
        plan.batch.map((b) => b.op),
      );
      const results = list(resp.results);
      if (results.length !== plan.batch.length || !resp.state) {
        throw new ApiError('server', 'the server answered a different number of changes than were sent');
      }
      const rejected: Attention[] = [];
      plan.batch.forEach((b, i) => {
        const r: Result = results[i];
        out.sent++;
        if (r.status === 'applied' || r.status === 'noop') out.savedOnServer++;
        else if (r.status === 'conflict' || r.status === 'held') out.conflicts++;
        else {
          out.rejected++;
          rejected.push({ id: b.op.id, q: b.q, status: 'rejected', reason: r.reason || 'refused by the server', at: Date.now() });
        }
        if (r.notice) out.notices.push(r.notice);
        const cp = b.q.createsPlacement;
        if (cp) map[cp.localId] = r.placementId ? r.placementId : { taskId: cp.taskId, day: cp.day };
      });
      await commitSync({
        acknowledged: plan.batch.map((b) => b.q.seq as number),
        rejected,
        placementMap: pruneMap(map),
        view: resp.state as SrvView,
        epoch: snap.epoch,
      });
    }
    return out;
  } catch (e) {
    if (e instanceof DeviceClearedError) {
      out.kind = 'cleared';
      out.message = e.message;
      return out;
    }
    if (e instanceof ApiError) {
      out.kind = e.kind === 'locked' ? 'refused' : e.kind;
      out.message = e.message;
      return out;
    }
    out.kind = 'storage';
    out.message = e instanceof Error ? e.message : String(e);
    return out;
  }
}

/** Keep the newest 1000 placement mappings, so the map cannot grow without bound. */
function pruneMap(map: Record<string, PlacementTarget>): Record<string, PlacementTarget> {
  const keys = Object.keys(map);
  if (keys.length <= 1000) return map;
  const out: Record<string, PlacementTarget> = {};
  for (const k of keys.slice(keys.length - 1000)) out[k] = map[k];
  return out;
}

export async function syncNow(deviceId: string): Promise<SyncOutcome> {
  const r = await withSyncLock(() => drainQueue(deviceId));
  return r ?? { kind: 'busy', sent: 0, savedOnServer: 0, conflicts: 0, rejected: 0, notices: [] };
}
