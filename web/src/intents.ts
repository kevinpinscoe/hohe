// User actions → queued server operations.
//
// Each intent runs inside the IndexedDB write transaction (db.enqueue), against a consistent
// snapshot of the confirmed state and the queue. That is where an edit's dependency is worked
// out: the latest queued op on the same task field (or the queued capture that created the
// task), or else the field revision the server last confirmed.
//
// Ids are chosen here, on the device:
// - a new task gets a UUID, which the server accepts as the task's permanent id, so later
//   queued ops name the task directly and nothing is remapped;
// - a new placement gets a local id ("lp-…"). The server assigns placement ids itself, so the
//   sync engine stops a batch after the op that creates the placement, learns the server's id
//   from that op's result (a replay returns the same result), and rewrites later ops before
//   sending them.

import type { Day } from './dates';
import type { Snapshot } from './db';
import { displayState, emptyState, fromServer, newId, newLocalPlacementId, type QueuedOp } from './local';
import { findTask, movedOrder, openPlacement, type Effort, type Letter, type State } from './model';
import type { Op } from './server';

export interface BuildCtx {
  snap: Snapshot;
  confirmed: State;
  display: State;
  today: Day;
}

export type Intent = (c: BuildCtx) => QueuedOp[];

export function buildCtx(snap: Snapshot, today: Day): BuildCtx {
  const confirmed = snap.confirmed ? fromServer(snap.confirmed.view, today) : emptyState(today);
  return { snap, confirmed, display: displayState(confirmed, snap.pending), today };
}

export class IntentError extends Error {}

function q(c: BuildCtx, op: Omit<Op, 'id'> & { id?: string }, label: string, extra: Partial<QueuedOp> = {}): QueuedOp {
  return {
    op: { id: newId(), clientPlannerDay: c.today, clientTime: new Date().toISOString(), ...op } as Op,
    createdAt: Date.now(),
    label,
    ...extra,
  };
}

function title(c: BuildCtx, taskId: string): string {
  return findTask(c.display, taskId)?.title ?? 'a task';
}

/** The base an edit of `field` builds on, given what is queued before it in `queued`. */
function editBase(c: BuildCtx, queued: QueuedOp[], taskId: string, field: string): Pick<Op, 'dependsOn' | 'baseRevision'> {
  const all = [...c.snap.pending, ...queued];
  for (let i = all.length - 1; i >= 0; i--) {
    const o = all[i].op;
    if (o.taskId !== taskId) continue;
    if ((o.type === 'edit' && o.field === field) || o.type === 'capture' || o.type === 'create') return { dependsOn: o.id };
  }
  const t = findTask(c.confirmed, taskId);
  if (!t) throw new IntentError('This task is not known on this device yet.');
  return { baseRevision: t.revisions[field] ?? 1 };
}

/**
 * What an edit dialog keeps from the moment it opens: each field's value and the base its edit
 * will build on (the queued op it follows, or the server revision). Submitting against the
 * baseline means a refresh while the dialog is open never rebases the edit silently: a field
 * changed elsewhere in the meantime goes to the conflict tray instead of being overwritten.
 */
export interface Baseline {
  taskId: string;
  values: Record<string, unknown>;
  bases: Record<string, Pick<Op, 'dependsOn' | 'baseRevision'>>;
}

const fieldValue = (t: ReturnType<typeof findTask>, f: string): unknown => {
  if (!t) return '';
  switch (f) {
    case 'priority':
      return t.priority ?? '';
    case 'deadline':
      return t.deadline ?? '';
    case 'effort':
      return t.effort ?? '';
    default:
      return (t as unknown as Record<string, unknown>)[f] ?? '';
  }
};

export function editBaseline(c: BuildCtx, taskId: string, fields: string[]): Baseline {
  const t = findTask(c.display, taskId);
  const b: Baseline = { taskId, values: {}, bases: {} };
  for (const f of fields) {
    b.values[f] = fieldValue(t, f);
    try {
      b.bases[f] = editBase(c, [], taskId, f);
    } catch {
      /* unknown task: editFrom refuses it */
    }
  }
  return b;
}

/** Edits for the fields that differ from the baseline, each built on the baseline's base. */
function editsFrom(c: BuildCtx, base: Baseline, current: Record<string, unknown>, label: string): QueuedOp[] {
  if (!findTask(c.display, base.taskId)) throw new IntentError('That task is no longer here.');
  const out: QueuedOp[] = [];
  for (const [field, value] of Object.entries(current)) {
    if (!(field in base.values) || String(value ?? '') === String(base.values[field] ?? '')) continue;
    const b = base.bases[field];
    if (!b) throw new IntentError('This task is not known on this device yet.');
    out.push(q(c, { type: 'edit', taskId: base.taskId, field, value, ...b }, label));
  }
  return out;
}

function lifecycle(c: BuildCtx, type: string, taskId: string, label: string, more: Partial<Op> = {}, extra: Partial<QueuedOp> = {}) {
  const open = openPlacement(c.display, taskId);
  return q(c, { type, taskId, basePlacementId: open?.id, ...more }, label, extra);
}

function edits(c: BuildCtx, taskId: string, changes: Record<string, unknown>, label: string): QueuedOp[] {
  const out: QueuedOp[] = [];
  for (const [field, value] of Object.entries(changes)) {
    out.push(q(c, { type: 'edit', taskId, field, value, ...editBase(c, out, taskId, field) }, label));
  }
  return out;
}

const placing = (c: BuildCtx, type: string, taskId: string, day: Day, label: string): QueuedOp => {
  const localId = newLocalPlacementId();
  return lifecycle(c, type, taskId, label, { day }, { createsPlacement: { localId, taskId, day } });
};

// ── the intents ────────────────────────────────────────────────────────────

export const intents = {
  capture: (raw: string): Intent => (c) => {
    const t = raw.trim();
    if (!t) throw new IntentError('Type a task first.');
    return [q(c, { type: 'capture', taskId: newId(), title: t }, `Capture: ${t}`)];
  },

  /** Add to a day; an optional prefix like "A2 " or "B " sets the letter and number. */
  addToDay: (raw: string, day: Day): Intent => (c) => {
    const m = raw.trim().match(/^([ABCabc])(\d+)?\s+(.+)$/);
    const letter = m ? m[1].toUpperCase() : '';
    const t = (m ? m[3] : raw).trim();
    if (!t) throw new IntentError('Type a task first.');
    const taskId = newId();
    const localId = newLocalPlacementId();
    const rank = m && m[2] ? Number(m[2]) : 0;
    return [
      q(
        c,
        { type: 'create', taskId, title: t, day, letter: letter || undefined, rank: rank || undefined },
        `Add to ${day}: ${letter}${rank || ''} ${t}`.replace(/ +/g, ' '),
        { createsPlacement: { localId, taskId, day } },
      ),
    ];
  },

  edit: (taskId: string, field: string, value: unknown): Intent => (c) =>
    edits(c, taskId, { [field]: value }, `Edit ${field}: ${title(c, taskId)}`),

  /** An edit dialog's save: only fields changed from the baseline it opened with. */
  editFrom: (base: Baseline, current: Record<string, unknown>): Intent => (c) => {
    if ('title' in current && !String(current.title).trim()) throw new IntentError('A task needs a title.');
    return editsFrom(c, base, current, `Edit: ${title(c, base.taskId)}`);
  },

  changePriority: (taskId: string, letter: Letter | null): Intent => (c) =>
    edits(c, taskId, { priority: letter ?? '' }, `Priority ${letter ?? 'none'}: ${title(c, taskId)}`),

  /**
   * Triage from the Dump: letter, deadline and effort as edits (against the dialog's baseline
   * when one is given), then an optional day.
   */
  assign: (taskId: string, letter: Letter | null, day: Day | null, deadline: Day | '', effort: Effort | undefined, base?: Baseline): Intent => (c) => {
    const t = findTask(c.display, taskId);
    if (!t) throw new IntentError('That task is no longer here.');
    const current = { priority: letter ?? '', deadline, effort: effort ?? '' };
    const b = base ?? editBaseline(c, taskId, Object.keys(current));
    const out = editsFrom(c, b, current, `Assign: ${t.title}`);
    if (day) out.push(placing(c, 'assign', taskId, day, `Assign to ${day}: ${t.title}`));
    return out;
  },

  planIt: (taskId: string, day: Day): Intent => (c) => [placing(c, 'planIt', taskId, day, `Plan for ${day}: ${title(c, taskId)}`)],
  forward: (taskId: string, day: Day): Intent => (c) => [placing(c, 'forward', taskId, day, `Forward to ${day}: ${title(c, taskId)}`)],
  complete: (taskId: string): Intent => (c) => [lifecycle(c, 'complete', taskId, `Complete: ${title(c, taskId)}`)],
  reopen: (taskId: string): Intent => (c) => [q(c, { type: 'reopen', taskId }, `Reopen: ${title(c, taskId)}`)],
  backToDump: (taskId: string): Intent => (c) => [lifecycle(c, 'backToDump', taskId, `Back to Dump: ${title(c, taskId)}`)],
  delete: (taskId: string): Intent => (c) => [q(c, { type: 'delete', taskId }, `Delete: ${title(c, taskId)}`)],
  restore: (taskId: string): Intent => (c) => [q(c, { type: 'restore', taskId }, `Restore: ${title(c, taskId)}`)],
  delegate: (taskId: string, who: string, day: Day): Intent => (c) => [
    lifecycle(c, 'delegate', taskId, `Delegate to ${who}: ${title(c, taskId)}`, { who, day }),
  ],
  inProgress: (taskId: string, on: boolean): Intent => (c) => [
    lifecycle(c, 'inProgress', taskId, `${on ? 'In progress' : 'Not in progress'}: ${title(c, taskId)}`, { bool: on }),
  ],
  keepToday: (taskId: string): Intent => (c) => [lifecycle(c, 'keepToday', taskId, `Keep today: ${title(c, taskId)}`)],

  setRank: (placementId: string, rank: number): Intent => (c) => {
    const pl = c.display.placements.find((p) => p.id === placementId);
    if (!pl) throw new IntentError('That entry is no longer on this day.');
    return [q(c, { type: 'setRank', placementId, taskId: pl.taskId, rank }, `Number ${pl.letter ?? ''}${rank}: ${title(c, pl.taskId)}`)];
  },

  move: (placementId: string, dir: -1 | 1): Intent => (c) => {
    const mv = movedOrder(c.display, placementId, dir);
    if (!mv) return [];
    const groupQueued = c.snap.pending.some((p) => p.op.day === mv.day || p.createsPlacement?.day === mv.day);
    const base = c.confirmed.groupRevisions[`${mv.day}/${mv.letter}`];
    return [
      q(
        c,
        { type: 'reorder', day: mv.day, letter: mv.letter, order: mv.order, baseRevision: groupQueued || base === undefined ? undefined : base },
        `Reorder ${mv.letter} on ${mv.day}`,
      ),
    ];
  },

  snooze: (taskId: string): Intent => (c) => [q(c, { type: 'snooze', taskId }, `Snooze: ${title(c, taskId)}`)],
  pauseSuggestions: (): Intent => (c) => [q(c, { type: 'pauseSuggestions' }, 'Pause suggestions')],
  resumeSuggestions: (): Intent => (c) => [q(c, { type: 'resumeSuggestions' }, 'Resume suggestions')],
  dismissCard: (): Intent => (c) => [q(c, { type: 'dismissCard', day: c.today }, 'Hide the suggestion for today')],
  designate: (day: Day, value: string): Intent => (c) => [q(c, { type: 'designate', day, value }, `Mark ${day} ${value || 'unmarked'}`)],
  markPlanned: (day: Day): Intent => (c) => [q(c, { type: 'markPlanned', day }, `Plan my day done for ${day}`)],

  setting: (field: string, value: unknown): Intent => (c) => {
    const queuedSame = c.snap.pending.some((p) => p.op.type === 'setting' && p.op.field === field);
    const base = c.confirmed.settings.revisions?.[field];
    return [q(c, { type: 'setting', field, value, baseRevision: queuedSame ? undefined : (base ?? 0) }, `Setting ${field}: ${String(value)}`)];
  },

  resolve: (conflictId: string, action: string): Intent => (c) => [
    q(c, { type: 'resolve', resolves: conflictId, value: action }, `Conflict choice: ${action}`),
  ],
};
