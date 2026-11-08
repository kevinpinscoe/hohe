// HOHE client task model: the display state and the pure functions that read it, plus the
// optimistic versions of each operation that `local.ts` applies to pending changes.
//
// The server is authoritative. The client shows the last state the server confirmed with the
// device's pending operations applied on top, so every function here takes explicit ids (a
// task id, or a local placement id) chosen when the operation was queued. Priority (A/B/C) is
// independent of placement on a day; a task keeps one identity, and each day it appears on is
// a placement.

import { addDays, daysBetween, type Day } from './dates';
import type { SrvConflict, SrvSettings, SrvSuggestion } from './server';

export type Letter = 'A' | 'B' | 'C';
export type Effort = 'S' | 'M' | 'L';
export type TaskState = 'active' | 'waiting' | 'completed' | 'deleted' | 'purged';
export type Outcome = 'completed' | 'forwarded' | 'carried' | 'delegated' | 'returned' | 'deleted';
export type Designation = 'room' | 'full' | 'rest';

export interface Task {
  id: string;
  title: string;
  notes: string;
  priority: Letter | null;
  deadline?: Day;
  effort?: Effort;
  state: TaskState;
  delegate?: string;
  followUp?: Day;
  createdDay: Day;
  completedDay?: Day;
  deletedDay?: Day;
  revisions: Record<string, number>;
}

export interface Placement {
  id: string;
  taskId: string;
  day: Day;
  letter: Letter | null;
  rank: number | null;
  outcome: Outcome | null; // null = open
  target?: Day; // where it was carried, forwarded or delegated to
  by: string; // kevin, rollover, capture, import
  touched: boolean; // Kevin acted on this placement (ends a carry span)
  inProgress?: boolean;
}

export interface State {
  today: Day;
  serverDay: Day;
  tasks: Task[];
  placements: Placement[];
  designations: Record<Day, Designation>;
  snoozes: Record<string, Day>; // taskId -> snoozed until
  pausedUntil: Day | null;
  cardDismissedDay: Day | null;
  plannedDays: Day[]; // days whose Plan My Day has been done or skipped
  settings: SrvSettings;
  conflicts: SrvConflict[];
  groupRevisions: Record<string, number>;
  suggestion: SrvSuggestion | null; // the server's suggestion for planning today
  card: SrvSuggestion | null; // the server's once-a-day card, when allowed now
}

const EFFORT_POINTS: Record<Effort, number> = { S: 1, M: 2, L: 3 };

// ── queries ─────────────────────────────────────────────────────────────────

export const findTask = (s: State, id: string): Task | undefined => s.tasks.find((t) => t.id === id);

/** A task by id. A placeholder stands in for one that is missing, so one bad row never blanks a page. */
export const taskById = (s: State, id: string): Task =>
  findTask(s, id) ?? {
    id,
    title: '(task not found)',
    notes: '',
    priority: null,
    state: 'active',
    createdDay: s.today,
    revisions: {},
  };

export const openPlacement = (s: State, taskId: string) =>
  s.placements.find((p) => p.taskId === taskId && p.outcome === null);

export const placementsOn = (s: State, day: Day) => s.placements.filter((p) => p.day === day);

export const LETTER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

/** Sort a day's entries: A1…, B1…, C1…; unnumbered last in their letter; unlettered after C. */
export function sortForDay(list: Placement[]): Placement[] {
  return [...list].sort((a, b) => {
    const la = a.letter ? LETTER_ORDER[a.letter] : 3;
    const lb = b.letter ? LETTER_ORDER[b.letter] : 3;
    if (la !== lb) return la - lb;
    const ra = a.rank ?? 999;
    const rb = b.rank ?? 999;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

/** Ranks reserved in a day+letter group by closed entries. */
export function reservedRanks(s: State, day: Day, letter: Letter): Set<number> {
  return new Set(
    s.placements
      .filter((p) => p.day === day && p.letter === letter && p.outcome !== null && p.rank !== null)
      .map((p) => p.rank as number),
  );
}

/** The carry span a placement belongs to, if any: first and last day of the run. */
export function carrySpan(s: State, pl: Placement): { from: Day; to: Day; days: number } | null {
  const chain = s.placements.filter((p) => p.taskId === pl.taskId).sort((a, b) => a.day.localeCompare(b.day));
  const idx = chain.findIndex((p) => p.id === pl.id);
  if (idx < 0) return null;
  const linked = (i: number) =>
    i >= 0 &&
    i + 1 < chain.length &&
    chain[i].outcome === 'carried' &&
    chain[i + 1].by === 'rollover' &&
    chain[i].target === chain[i + 1].day;
  let start: number;
  let end: number;
  if (linked(idx)) {
    start = idx;
    end = idx + 1;
  } else if (linked(idx - 1)) {
    start = idx - 1;
    end = idx;
  } else {
    return null;
  }
  while (linked(start - 1) && !chain[start].touched) start--;
  while (linked(end) && !chain[end].touched) end++;
  return { from: chain[start].day, to: chain[end].day, days: daysBetween(chain[start].day, chain[end].day) };
}

/** Days the task has moved forward unfinished since first placed (or since last Back to Dump). */
export function carriedCount(s: State, taskId: string): number {
  const chain = s.placements.filter((p) => p.taskId === taskId).sort((a, b) => a.day.localeCompare(b.day));
  let n = 0;
  for (const p of chain) {
    if (p.outcome === 'returned') n = 0;
    else if (p.outcome === 'carried') n++;
  }
  return n;
}

export function dayLoad(s: State, day: Day): number {
  return s.placements
    .filter((p) => p.day === day && p.outcome === null)
    .reduce((sum, p) => sum + EFFORT_POINTS[findTask(s, p.taskId)?.effort ?? 'S'], 0);
}

export function ageDays(s: State, t: Task): number {
  return daysBetween(t.createdDay, s.today);
}

export interface Suggestion {
  taskId: string;
  day: Day;
  reason: string;
}

/**
 * The server's suggestion, if it still applies to what this device shows (a pending change may
 * already have planned, snoozed, completed or deleted the task, or paused suggestions).
 */
export function liveSuggestion(s: State, which: 'suggestion' | 'card'): Suggestion | null {
  const sg = which === 'card' ? s.card : s.suggestion;
  if (!sg) return null;
  if (s.pausedUntil && s.pausedUntil > s.today) return null;
  if (which === 'card' && s.cardDismissedDay === s.today) return null;
  const t = findTask(s, sg.taskId);
  if (!t || t.state !== 'active' || openPlacement(s, t.id)) return null;
  const snooze = s.snoozes[t.id];
  if (snooze && snooze > s.today) return null;
  if (sg.day < s.today) return null;
  return { taskId: sg.taskId, day: sg.day, reason: sg.reason };
}

// ── optimistic operations (each returns a new state) ────────────────────────

function updatePlacement(s: State, id: string, patch: Partial<Placement>): State {
  return { ...s, placements: s.placements.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

function updateTask(s: State, id: string, patch: Partial<Task>): State {
  return { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function addPlacement(s: State, p: Placement): State {
  return { ...s, placements: [...s.placements, p] };
}

export function capture(s: State, taskId: string, title: string, letter: Letter | null = null): State {
  if (findTask(s, taskId)) return s;
  return {
    ...s,
    tasks: [...s.tasks, { id: taskId, title, notes: '', priority: letter, state: 'active', createdDay: s.today, revisions: {} }],
  };
}

/** Place a task on a day without changing its letter. Forwards an open entry on another day. */
export function place(s: State, taskId: string, day: Day, newPlacementId: string): State {
  const t = findTask(s, taskId);
  if (!t) return s;
  const open = openPlacement(s, taskId);
  if (open && open.day === day) return updatePlacement(s, open.id, { touched: true });
  let next = s;
  if (open) next = updatePlacement(next, open.id, { outcome: 'forwarded', target: day, touched: true, inProgress: false });
  return addPlacement(next, { id: newPlacementId, taskId, day, letter: t.priority, rank: null, outcome: null, by: 'kevin', touched: true });
}

export function editField(s: State, taskId: string, field: string, value: unknown): State {
  const t = findTask(s, taskId);
  if (!t) return s;
  const str = typeof value === 'string' ? value : '';
  switch (field) {
    case 'priority':
      return changePriority(s, taskId, (str || null) as Letter | null);
    case 'title':
      return updateTask(s, taskId, { title: str });
    case 'notes':
      return updateTask(s, taskId, { notes: str });
    case 'deadline':
      return updateTask(s, taskId, { deadline: str || undefined });
    case 'effort':
      return updateTask(s, taskId, { effort: (str || undefined) as Effort | undefined });
    default:
      return s;
  }
}

export function complete(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  let next = updateTask(s, taskId, { state: 'completed', completedDay: s.today });
  if (open) next = updatePlacement(next, open.id, { outcome: 'completed', touched: true, inProgress: false });
  return next;
}

/** Explicit reopen (undo of a completion made on the same placement). */
export function reopen(s: State, taskId: string): State {
  const done = s.placements.find((p) => p.taskId === taskId && p.outcome === 'completed' && p.day >= s.today);
  let next = updateTask(s, taskId, { state: 'active', completedDay: undefined });
  if (done) next = updatePlacement(next, done.id, { outcome: null });
  return next;
}

export function forward(s: State, taskId: string, day: Day, newPlacementId: string): State {
  const open = openPlacement(s, taskId);
  if (!open) return place(s, taskId, day, newPlacementId);
  if (open.day === day) return s;
  const next = updatePlacement(s, open.id, { outcome: 'forwarded', target: day, touched: true, inProgress: false });
  return addPlacement(next, { id: newPlacementId, taskId, day, letter: open.letter, rank: null, outcome: null, by: 'kevin', touched: true });
}

/** Back to Dump: closes the placement, clears the day, keeps the priority. */
export function backToDump(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  if (!open) return s;
  return updatePlacement(s, open.id, { outcome: 'returned', touched: true, inProgress: false });
}

export function softDelete(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  let next = updateTask(s, taskId, { state: 'deleted', deletedDay: s.today });
  if (open) next = updatePlacement(next, open.id, { outcome: 'deleted', touched: true });
  return next;
}

export function restore(s: State, taskId: string): State {
  const del = s.placements.find((p) => p.taskId === taskId && p.outcome === 'deleted');
  let next = updateTask(s, taskId, { state: 'active', deletedDay: undefined });
  if (del && del.day >= s.today) next = updatePlacement(next, del.id, { outcome: null });
  return next;
}

export function delegate(s: State, taskId: string, who: string, followUp: Day): State {
  const open = openPlacement(s, taskId);
  let next = updateTask(s, taskId, { state: 'waiting', delegate: who, followUp });
  if (open) next = updatePlacement(next, open.id, { outcome: 'delegated', target: followUp, touched: true });
  return next;
}

export function setInProgress(s: State, taskId: string, on: boolean): State {
  const open = openPlacement(s, taskId);
  return open ? updatePlacement(s, open.id, { inProgress: on, touched: true }) : s;
}

export function changePriority(s: State, taskId: string, letter: Letter | null): State {
  let next = updateTask(s, taskId, { priority: letter });
  const open = openPlacement(next, taskId);
  if (open && open.letter !== letter) next = updatePlacement(next, open.id, { letter, rank: null, touched: true });
  return next;
}

/** Acknowledge a carried-in task in Plan My Day ("keep for today"); ends its carry span. */
export function keepToday(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  return open ? updatePlacement(s, open.id, { touched: true }) : s;
}

/** Why a typed rank would be refused here, or null if it is allowed. */
export function rankRefusal(s: State, placementId: string, rank: number): string | null {
  const pl = s.placements.find((p) => p.id === placementId);
  if (!pl) return 'That entry is no longer on this day.';
  if (!pl.letter) return 'Give the task a letter first.';
  if (reservedRanks(s, pl.day, pl.letter).has(rank)) {
    return `${pl.letter}${rank} is already used today by a closed entry. Numbers stay unique for the day.`;
  }
  return null;
}

/**
 * Typed rank. Reserved numbers (held by closed entries that day and letter) are refused.
 * A number held by an open task moves that task, and any after it, to the next free numbers.
 */
export function setRank(s: State, placementId: string, rank: number): State {
  const pl = s.placements.find((p) => p.id === placementId);
  if (!pl || !pl.letter || rankRefusal(s, placementId, rank)) return s;
  const reserved = reservedRanks(s, pl.day, pl.letter);
  const open = s.placements.filter(
    (p) => p.day === pl.day && p.letter === pl.letter && p.outcome === null && p.id !== pl.id && p.rank !== null,
  );
  let next = updatePlacement(s, pl.id, { rank, touched: true });
  if (open.some((p) => p.rank === rank)) {
    const toShift = open.filter((p) => (p.rank as number) >= rank).sort((a, b) => (a.rank as number) - (b.rank as number));
    const taken = new Set([...reserved, rank, ...open.filter((p) => (p.rank as number) < rank).map((p) => p.rank as number)]);
    let n = rank;
    for (const p of toShift) {
      do n++;
      while (taken.has(n));
      taken.add(n);
      next = updatePlacement(next, p.id, { rank: n });
    }
  }
  return next;
}

/** Explicit reorder of a group's open entries: lowest numbers not reserved, in the given order. */
export function reorderGroup(s: State, day: Day, letter: Letter, orderedIds: string[]): State {
  const reserved = reservedRanks(s, day, letter);
  let next = s;
  let n = 0;
  for (const id of orderedIds) {
    do n++;
    while (reserved.has(n));
    next = updatePlacement(next, id, { rank: n, touched: true });
  }
  return next;
}

/** The order a group would have after moving one open entry up or down, or null. */
export function movedOrder(s: State, placementId: string, dir: -1 | 1): { day: Day; letter: Letter; order: string[] } | null {
  const pl = s.placements.find((p) => p.id === placementId);
  if (!pl || !pl.letter) return null;
  const group = sortForDay(s.placements.filter((p) => p.day === pl.day && p.letter === pl.letter && p.outcome === null));
  const i = group.findIndex((p) => p.id === pl.id);
  const j = i + dir;
  if (j < 0 || j >= group.length) return null;
  const ids = group.map((p) => p.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { day: pl.day, letter: pl.letter, order: ids };
}

export function snooze(s: State, taskId: string, until: Day): State {
  return { ...s, snoozes: { ...s.snoozes, [taskId]: until } };
}

export function pauseSuggestions(s: State, until: Day): State {
  return { ...s, pausedUntil: until };
}

export function setDesignation(s: State, day: Day, d: Designation | null): State {
  const designations = { ...s.designations };
  if (d) designations[day] = d;
  else delete designations[day];
  return { ...s, designations };
}

export function markPlanned(s: State, day: Day): State {
  return s.plannedDays.includes(day) ? s : { ...s, plannedDays: [...s.plannedDays, day] };
}

export function defaultSnoozeUntil(s: State): Day {
  return addDays(s.today, s.settings.snoozeDays || 7);
}
