// What the screen shows: the last state the server confirmed, with this device's pending
// operations applied on top in queue order. Neither half ever overwrites the other: a fresh
// /api/state replaces only the confirmed half, and the queue is kept separately in IndexedDB.

import type { Day } from './dates';
import * as m from './model';
import { list, map, type Op, type SrvView } from './server';

/** One queued operation, exactly as stored in IndexedDB. */
export interface QueuedOp {
  seq?: number; // IndexedDB key (auto-increment): the device's queue order, shared by every tab
  op: Op;
  createdAt: number; // ms since the epoch, for "waiting since"
  label: string; // what Kevin did, in words, for the pending and attention lists
  /** Set when the op creates a placement on this device: its local id and where it lands. */
  createsPlacement?: { localId: string; taskId: string; day: Day };
}

export const LOCAL_PLACEMENT_PREFIX = 'lp-';
export const isLocalPlacement = (id: string | undefined) => !!id && id.startsWith(LOCAL_PLACEMENT_PREFIX);

export function newId(): string {
  return crypto.randomUUID();
}

export function newLocalPlacementId(): string {
  return LOCAL_PLACEMENT_PREFIX + crypto.randomUUID();
}

const letterOf = (v: string): m.Letter | null => (v === 'A' || v === 'B' || v === 'C' ? v : null);
const opt = (v: string) => (v ? v : undefined);

/** Convert the server's view into display state for `today` (the client's planner day). */
export function fromServer(v: SrvView, today: Day): m.State {
  const planning = v.planning ?? ({} as SrvView['planning']);
  return {
    today,
    serverDay: v.serverPlannerDay,
    tasks: list(v.tasks).map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes ?? '',
      priority: letterOf(t.priority),
      deadline: opt(t.deadline),
      effort: opt(t.effort) as m.Effort | undefined,
      state: t.state as m.TaskState,
      delegate: opt(t.delegate),
      followUp: opt(t.followUp),
      createdDay: t.createdDay,
      completedDay: opt(t.completedDay),
      deletedDay: opt(t.deletedDay),
      revisions: map(t.revisions),
    })),
    placements: list(v.placements).map((p) => ({
      id: p.id,
      taskId: p.taskId,
      day: p.day,
      letter: letterOf(p.letter),
      rank: p.rank > 0 ? p.rank : null,
      outcome: (p.outcome || null) as m.Outcome | null,
      target: opt(p.target),
      by: p.by,
      touched: p.touched,
      inProgress: p.inProgress,
    })),
    designations: map(planning.designations) as Record<Day, m.Designation>,
    snoozes: map(planning.snoozes),
    pausedUntil: planning.pausedUntil || null,
    cardDismissedDay: planning.cardDismissedDay || null,
    plannedDays: list(planning.plannedDays),
    settings: { ...v.settings, revisions: map(v.settings?.revisions) },
    conflicts: list(v.conflicts).filter((c) => c && c.status === 'open'),
    groupRevisions: map(v.groupRevisions),
    suggestion: v.suggestion ?? null,
    card: v.card ?? null,
  };
}

/** An empty state, for a device that has never reached the server. */
export function emptyState(today: Day): m.State {
  return fromServer(
    {
      serverPlannerDay: today,
      lastRolled: '',
      settings: {
        timeZone: 'America/New_York',
        rollover: '03:00',
        aWarning: 4,
        minAgeDays: 14,
        deadlineWindowDays: 7,
        snoozeDays: 7,
        cardEarliest: '07:00',
        deleteRetentionDays: 30,
        weekStart: 'monday',
        revisions: {},
      },
      planning: { designations: {}, snoozes: {}, pausedUntil: '', cardDismissedDay: '', plannedDays: [] },
      tasks: [],
      placements: [],
      conflicts: [],
      groupRevisions: {},
      suggestion: null,
      card: null,
      counts: {},
    },
    today,
  );
}

/** Apply one pending operation optimistically. Unknown or inapplicable ops change nothing. */
export function applyLocal(s: m.State, q: QueuedOp): m.State {
  const op = q.op;
  const tid = op.taskId ?? '';
  const newPl = q.createsPlacement?.localId ?? '';
  switch (op.type) {
    case 'capture':
    case 'create': {
      let next = m.capture(s, tid, op.title ?? '', letterOf(op.letter ?? ''));
      if (op.day && newPl) next = m.place(next, tid, op.day, newPl);
      return next;
    }
    case 'edit':
      return m.editField(s, tid, op.field ?? '', op.value);
    case 'assign':
    case 'planIt':
      return op.day && newPl ? m.place(s, tid, op.day, newPl) : s;
    case 'forward':
      return op.day && newPl ? m.forward(s, tid, op.day, newPl) : s;
    case 'complete':
      return m.complete(s, tid);
    case 'reopen':
      return m.reopen(s, tid);
    case 'backToDump':
      return m.backToDump(s, tid);
    case 'delete':
      return m.softDelete(s, tid);
    case 'restore':
      return m.restore(s, tid);
    case 'delegate':
      return m.delegate(s, tid, op.who ?? '', op.day ?? '');
    case 'inProgress':
      return m.setInProgress(s, tid, op.bool ?? true);
    case 'keepToday':
      return m.keepToday(s, tid);
    case 'setRank':
      return m.setRank(s, op.placementId ?? '', op.rank ?? 0);
    case 'reorder':
      return op.day && letterOf(op.letter ?? '') ? m.reorderGroup(s, op.day, letterOf(op.letter ?? '')!, op.order ?? []) : s;
    case 'snooze':
      return m.snooze(s, tid, op.day ?? m.defaultSnoozeUntil(s));
    case 'pauseSuggestions':
      return m.pauseSuggestions(s, op.day ?? m.defaultSnoozeUntil(s));
    case 'resumeSuggestions':
      return { ...s, pausedUntil: null };
    case 'dismissCard':
      return { ...s, cardDismissedDay: op.day ?? s.today };
    case 'designate':
      return m.setDesignation(s, op.day ?? '', ((op.value as string) || null) as m.Designation | null);
    case 'markPlanned':
      return m.markPlanned(s, op.day ?? s.today);
    case 'setting':
      return op.field ? { ...s, settings: { ...s.settings, [op.field]: op.value } } : s;
    case 'resolve':
      // The choice is queued; the entry leaves the tray, and the server's answer settles it.
      return { ...s, conflicts: s.conflicts.filter((c) => c.id !== op.resolves) };
    default:
      return s;
  }
}

/** Confirmed state plus every pending op, in queue order. */
export function displayState(confirmed: m.State, pending: QueuedOp[]): m.State {
  return pending.reduce(applyLocal, confirmed);
}

/** Task ids touched by pending ops, with the time of the oldest pending change for each. */
export function pendingByTask(pending: QueuedOp[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of pending) {
    const id = q.op.taskId;
    if (id && !out.has(id)) out.set(id, q.createdAt);
  }
  return out;
}
