// Rendering tests (Phase 2 lesson): every empty state, the conflict tray in every shape the
// server could send, and the status wording. One render failure must not blank the screen.

import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { Ctx, DialogSpec } from './ctx';
import { DayPage } from './day';
import { DialogHost } from './dialogs';
import { DumpPage, PlanMyDay, ReviewPage } from './lists';
import { emptyState, fromServer, type QueuedOp } from './local';
import type { State } from './model';
import type { SrvConflict } from './server';
import { AttentionList, ConflictTray, Guard, PendingList, syncSummary } from './status';
import type { Status } from './store';
import { LeaveDevice, outstandingText, persistText } from './settings';
import { editBaseline } from './intents';
import type { Store } from './store';
import { conflict, placement, task, TODAY, view } from './fixtures.test-util';

const ctxFor = (s: State, viewDay = s.today): Ctx => ({
  s,
  viewDay,
  act: async () => true,
  notify: () => {},
  open: () => {},
  close: () => {},
  go: () => {},
  pendingTasks: new Map(),
  now: Date.parse('2026-11-09T15:00:00Z'),
  editBaseline: (taskId, fields) =>
    editBaseline({ snap: { confirmed: null, pending: [], attention: [], deviceId: null, placementMap: {}, epoch: 0 }, confirmed: s, display: s, today: s.today }, taskId, fields),
});

const status = (over: Partial<Status> = {}): Status => ({
  loaded: true,
  hasServerCopy: true,
  net: 'ok',
  netMessage: '',
  needsLogin: false,
  syncing: false,
  lastSyncAt: Date.now(),
  pending: [],
  attention: [],
  storageError: null,
  serverBuild: null,
  ...over,
});

const NOW = Date.parse('2026-11-09T15:00:00Z');
const q = (label: string, createdAt = NOW - 12 * 60_000): QueuedOp => ({ op: { id: label, type: 'capture' }, createdAt, label });

describe('empty states', () => {
  const s = emptyState(TODAY);
  it('every page renders with no tasks at all', () => {
    expect(render(<DayPage ctx={ctxFor(s)} />)).toContain('Nothing planned for this day.');
    expect(render(<DumpPage ctx={ctxFor(s)} />)).toContain('Nothing here.');
    const review = render(<ReviewPage ctx={ctxFor(s)} />);
    expect(review).toContain('No day yet (0)');
    expect(review).toContain('Nothing here.');
    expect(render(<PlanMyDay ctx={ctxFor(s)} onFinish={() => {}} />)).toContain('Nothing carried in');
  });
  it('the Sync page lists render empty', () => {
    expect(render(<ConflictTray ctx={ctxFor(s)} conflicts={[]} />)).toContain('No conflicts.');
    expect(render(<AttentionList items={[]} onDismiss={() => {}} />)).toContain('Nothing was rejected.');
    expect(render(<PendingList items={[]} now={Date.now()} />)).toContain('Nothing is waiting.');
  });
  it('a server view with null lists still renders (the defect fixed in Phase 2)', () => {
    const v = view({ tasks: null, placements: null, conflicts: null, groupRevisions: null });
    v.planning = { designations: null, snoozes: null, pausedUntil: '', cardDismissedDay: '', plannedDays: null };
    const st = fromServer(v, TODAY);
    expect(render(<DayPage ctx={ctxFor(st)} />)).toContain('Nothing planned');
    expect(render(<ConflictTray ctx={ctxFor(st)} conflicts={null as unknown as SrvConflict[]} />)).toContain('No conflicts.');
  });
});

describe('conflict tray', () => {
  const s = fromServer(view({ tasks: [task('t1', 'Call the bank')] }), TODAY);
  it('a conflict with no held ops renders, whether heldOps is [], null or missing', () => {
    for (const heldOps of [[], null, undefined]) {
      const c = conflict('c-1', { heldOps: heldOps as SrvConflict['heldOps'] });
      const html = render(<ConflictTray ctx={ctxFor(s)} conflicts={[c]} />);
      expect(html).toContain('Call the bank');
      expect(html).toContain('Server title');
      expect(html).toContain('My title');
      expect(html).toContain('Keep server');
      expect(html).toContain('Use mine');
      expect(html).not.toContain('later change');
    }
  });
  it('held ops and every resolution action are shown', () => {
    const c = conflict('c-2', {
      kind: 'deleted',
      heldOps: [{ id: 'h1', type: 'edit' }, { id: 'h2', type: 'edit' }],
      actions: ['restore-and-apply', 'discard'],
    });
    const html = render(<ConflictTray ctx={ctxFor(s)} conflicts={[c]} />);
    expect(html).toContain('2 later changes wait on this choice.');
    expect(html).toContain('Restore and apply');
    expect(html).toContain('Discard');
  });
  it('null actions do not break the row', () => {
    const html = render(<ConflictTray ctx={ctxFor(s)} conflicts={[conflict('c-3', { actions: null })]} />);
    expect(html).toContain('No action offered');
  });
});

describe('status wording', () => {
  const now = NOW;
  it('"All synced" only when nothing is waiting, conflicted or rejected', () => {
    expect(syncSummary(status(), [], now).text).toBe('All synced');
    expect(syncSummary(status({ pending: [q('a')] }), [], now).text).toBe('1 change waiting to sync (oldest 12 min)');
    const withConflict = syncSummary(status(), [conflict('c')], now);
    expect(withConflict.text).toBe('1 conflict needs a choice');
    expect(withConflict.tone).toBe('attention');
    const att = { id: 'x', q: q('x'), status: 'rejected' as const, reason: 'r', at: now };
    expect(syncSummary(status({ attention: [att] }), [], now).text).toBe('1 rejected action needs attention');
    expect(syncSummary(status({ pending: [q('a'), q('b')], attention: [att] }), [conflict('c'), conflict('d')], now).text).toBe(
      '2 changes waiting to sync (oldest 12 min) · 2 conflicts need a choice · 1 rejected action needs attention',
    );
  });
  it('never says synced while the server is unreachable or before the first sync', () => {
    expect(syncSummary(status({ net: 'unreachable' }), [], now).text).toBe('Server unreachable · nothing waiting');
    expect(syncSummary(status({ lastSyncAt: null }), [], now).text).toBe('Not synced yet');
  });
  it('states the real persistent-storage answer', () => {
    expect(persistText(true)).toMatch(/^Persistent/);
    expect(persistText(false)).toMatch(/^Not persistent/);
    expect(persistText(null)).toMatch(/^Unknown/);
  });
});

describe('the logout and clear guard', () => {
  const att = { id: 'r1', q: q('Number B2: Call the plumber'), status: 'rejected' as const, reason: 'B2 is reserved', at: NOW };
  it('zero pending and one rejected action is not "nothing outstanding"', () => {
    expect(outstandingText(0, 1)).toBe('1 rejected action was refused by the server and never applied.');
    expect(outstandingText(0, 1)).not.toContain('Nothing');
    const html = render(<LeaveDevice mode="logout" st={status({ attention: [att] })} store={{} as Store} onDone={() => {}} />);
    expect(html).toContain('1 rejected action was refused by the server');
    expect(html).not.toContain('Nothing is waiting');
    expect(html).toContain('Export rejected actions to a file');
    expect(html).toContain('Exporting keeps a copy of each one before discarding.');
    // Export is offered, not required: Discard is available (behind its own confirmation).
    expect(html).toMatch(/<button class="menu-item danger">Discard 1 rejected action and log out/);
    expect(html).not.toContain('Sync now');
  });
  it('counts both kinds', () => {
    expect(outstandingText(2, 1)).toBe('2 changes have not reached the server yet, and 1 rejected action was refused by the server and never applied.');
    expect(outstandingText(0, 0)).toBe('Nothing is waiting to sync and no rejected actions remain.');
  });
});

describe('isolation', () => {
  it('one failing section does not blank the rest', () => {
    const Boom = () => {
      throw new Error('bad row');
    };
    // preact-render-to-string has no error boundaries, so this checks the Guard's fallback directly.
    const g = new Guard({ label: 'This conflict', children: null });
    g.state = { error: 'bad row' };
    expect(render(<>{g.render()}</>)).toContain('This conflict could not be shown (bad row)');
    expect(() => render(<Boom />)).toThrow();
  });
});

describe('pages with data', () => {
  const v = view({
    tasks: [task('t1', 'Pay the water bill', { priority: 'A' }), task('t2', 'Sort the garage', { priority: 'C', createdDay: '2026-10-01' })],
    placements: [placement('p-1', 't1', TODAY, { letter: 'A', rank: 1 })],
  });
  const s = fromServer(v, TODAY);
  it('a day, the Dump and the review render tasks and pending badges', () => {
    const ctx = { ...ctxFor(s), pendingTasks: new Map([['t1', Date.now() - 5 * 60_000]]) };
    const day = render(<DayPage ctx={ctx} />);
    expect(day).toContain('Pay the water bill');
    expect(day).toContain('A1');
    expect(day).toContain('waiting to sync');
    expect(render(<ReviewPage ctx={ctx} />)).toContain('Sort the garage');
  });
  it('every dialog renders', () => {
    const specs: DialogSpec[] = [
      { kind: 'actions', taskId: 't1' },
      { kind: 'edit', taskId: 't1' },
      { kind: 'rank', placementId: 'p-1' },
      { kind: 'rank', placementId: 'gone' },
      { kind: 'forward', taskId: 't1' },
      { kind: 'delegate', taskId: 't1' },
      { kind: 'assign', taskId: 't2' },
      { kind: 'priority', taskId: 't1' },
      { kind: 'plan', taskId: 't2' },
      { kind: 'about' },
    ];
    for (const spec of specs) expect(render(<DialogHost ctx={ctxFor(s)} spec={spec} />).length).toBeGreaterThan(20);
  });
});
