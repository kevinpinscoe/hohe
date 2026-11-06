// HOHE prototype task model. Pure functions over an immutable state.
// Priority (A/B/C) is independent of placement on a day. A task keeps one
// identity; each day it appears on is a placement record. Closed placements
// are never moved or rewritten (except an explicit correction).

import { addDays, daysBetween, type Day } from './dates';

export type Letter = 'A' | 'B' | 'C';
export type Effort = 'S' | 'M' | 'L';
export type TaskState = 'active' | 'waiting' | 'completed' | 'deleted';
export type Outcome = 'completed' | 'forwarded' | 'carried' | 'delegated' | 'returned' | 'deleted';
export type Designation = 'room' | 'full' | 'rest';

export interface Task {
  id: string;
  title: string;
  priority: Letter | null;
  deadline?: Day;
  effort?: Effort;
  state: TaskState;
  delegate?: string;
  followUp?: Day;
  createdDay: Day;
  completedDay?: Day;
  deletedDay?: Day;
}

export interface Placement {
  id: string;
  taskId: string;
  day: Day;
  letter: Letter | null;
  rank: number | null;
  outcome: Outcome | null; // null = open
  target?: Day; // where it was carried or forwarded to
  by: 'kevin' | 'rollover';
  touched: boolean; // Kevin acted on this placement (ends a carry span)
  inProgress?: boolean;
}

export interface State {
  version: number;
  today: Day;
  tasks: Task[];
  placements: Placement[];
  designations: Record<Day, Designation>;
  snoozes: Record<string, Day>; // taskId -> snoozed until
  pausedUntil: Day | null;
  cardDismissedDay: Day | null;
  rolledOverTo: Day[]; // rollover ledger (idempotency)
  plannedDays: Day[]; // days whose Plan My Day has been done or skipped
  nextId: number;
}

export const SUGGESTION_MIN_AGE_DAYS = 14; // proposed default, still open
export const DEADLINE_WINDOW_DAYS = 7; // proposed default, still open
export const SNOOZE_DAYS = 7; // proposed default, still open
export const A_WARNING = 4; // proposed default, still open
const EFFORT_POINTS: Record<Effort, number> = { S: 1, M: 2, L: 3 };

// ── queries ─────────────────────────────────────────────────────────────────

export const taskById = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

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
  const chain = s.placements
    .filter((p) => p.taskId === pl.taskId)
    .sort((a, b) => a.day.localeCompare(b.day));
  const idx = chain.findIndex((p) => p.id === pl.id);
  if (idx < 0) return null;
  // A link exists between chain[i] and chain[i+1] when chain[i] was carried automatically
  // into chain[i+1] and chain[i+1] was created by rollover.
  const linked = (i: number) =>
    i >= 0 &&
    i + 1 < chain.length &&
    chain[i].outcome === 'carried' &&
    chain[i + 1].by === 'rollover' &&
    chain[i].target === chain[i + 1].day;
  // Consecutive links share a span unless Kevin acted on the placement between them.
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
    .reduce((sum, p) => sum + EFFORT_POINTS[taskById(s, p.taskId).effort ?? 'S'], 0);
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
 * One suggestion: an unscheduled C task, planned (not promoted) onto today while planning
 * or a day Kevin marked "room available". Unmarked days are never assumed to be free.
 */
export function suggest(s: State, opts: { includeToday: boolean }): Suggestion | null {
  if (s.pausedUntil && s.pausedUntil > s.today) return null;
  const candidates = s.tasks.filter((t) => {
    if (t.state !== 'active' || t.priority !== 'C' || openPlacement(s, t.id)) return false;
    const snooze = s.snoozes[t.id];
    if (snooze && snooze > s.today) return false;
    const deadlineSoon = t.deadline !== undefined && daysBetween(s.today, t.deadline) <= DEADLINE_WINDOW_DAYS;
    return deadlineSoon || ageDays(s, t) >= SUGGESTION_MIN_AGE_DAYS; // deadline bypasses minimum age
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const da = a.deadline ? daysBetween(s.today, a.deadline) : 9999;
    const db = b.deadline ? daysBetween(s.today, b.deadline) : 9999;
    if (da !== db) return da - db;
    return ageDays(s, b) - ageDays(s, a);
  });
  const roomDays: Day[] = [];
  if (opts.includeToday && s.designations[s.today] !== 'full' && s.designations[s.today] !== 'rest') {
    roomDays.push(s.today);
  }
  for (let i = 1; i <= 7; i++) {
    const d = addDays(s.today, i);
    if (s.designations[d] === 'room') roomDays.push(d);
  }
  if (roomDays.length === 0) return null;
  const task = candidates[0];
  const usable = task.deadline ? roomDays.filter((d) => d <= task.deadline!) : roomDays;
  const days = usable.length > 0 ? usable : roomDays;
  const day = [...days].sort((a, b) => dayLoad(s, a) - dayLoad(s, b) || a.localeCompare(b))[0];
  const reason = task.deadline && daysBetween(s.today, task.deadline) <= DEADLINE_WINDOW_DAYS
    ? `due in ${daysBetween(s.today, task.deadline)} days`
    : `waiting ${ageDays(s, task)} days`;
  return { taskId: task.id, day, reason };
}

// ── operations (each returns a new state) ───────────────────────────────────

function newId(s: State, prefix: string): [string, State] {
  return [`${prefix}${s.nextId}`, { ...s, nextId: s.nextId + 1 }];
}

function updatePlacement(s: State, id: string, patch: Partial<Placement>): State {
  return { ...s, placements: s.placements.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

function updateTask(s: State, id: string, patch: Partial<Task>): State {
  return { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function addPlacement(s: State, p: Omit<Placement, 'id'>): State {
  const [id, s2] = newId(s, 'p');
  return { ...s2, placements: [...s2.placements, { ...p, id }] };
}

/** Capture: title only, lands in the Task Dump with no letter and no day. */
export function capture(s: State, title: string): State {
  const [id, s2] = newId(s, 't');
  return { ...s2, tasks: [...s2.tasks, { id, title, priority: null, state: 'active', createdDay: s.today }] };
}

/** Add a task explicitly planned for a day; an optional prefix like "A2 " or "B " sets the letter/rank. */
export function addToDay(s: State, day: Day, raw: string): { state: State; message?: string } {
  const m = raw.match(/^([ABCabc])(\d+)?\s+(.+)$/);
  const letter = m ? (m[1].toUpperCase() as Letter) : null;
  const title = m ? m[3] : raw;
  const [id, s2] = newId(s, 't');
  let next: State = { ...s2, tasks: [...s2.tasks, { id, title, priority: letter, state: 'active', createdDay: s.today }] };
  next = addPlacement(next, { taskId: id, day, letter, rank: null, outcome: null, by: 'kevin', touched: true });
  if (m && m[2]) {
    const pl = openPlacement(next, id)!;
    return setRank(next, pl.id, Number(m[2]));
  }
  return { state: next };
}

/** Assign from the Dump: letter, optional day and deadline. Keeps the task's identity. */
export function assign(s: State, taskId: string, letter: Letter | null, day: Day | null, deadline?: Day, effort?: Effort): State {
  let next = updateTask(s, taskId, { priority: letter, deadline, effort });
  if (day) {
    const open = openPlacement(next, taskId);
    if (open && open.day !== day) next = updatePlacement(next, open.id, { outcome: 'forwarded', target: day, touched: true });
    if (!open || open.day !== day) {
      next = addPlacement(next, { taskId, day, letter, rank: null, outcome: null, by: 'kevin', touched: true });
    } else {
      next = updatePlacement(next, open.id, { letter, rank: open.letter === letter ? open.rank : null, touched: true });
    }
  }
  return next;
}

export function complete(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  let next = updateTask(s, taskId, { state: 'completed', completedDay: s.today });
  if (open) next = updatePlacement(next, open.id, { outcome: 'completed', touched: true, inProgress: false });
  return next;
}

/** Explicit reopen (undo of a completion made on the same placement). */
export function reopen(s: State, taskId: string): State {
  const done = s.placements.find((p) => p.taskId === taskId && p.outcome === 'completed' && p.day === s.today);
  let next = updateTask(s, taskId, { state: 'active', completedDay: undefined });
  if (done) next = updatePlacement(next, done.id, { outcome: null });
  return next;
}

export function forward(s: State, taskId: string, day: Day): State {
  const open = openPlacement(s, taskId);
  if (!open) return s;
  let next = updatePlacement(s, open.id, { outcome: 'forwarded', target: day, touched: true, inProgress: false });
  next = addPlacement(next, { taskId, day, letter: open.letter, rank: null, outcome: null, by: 'kevin', touched: true });
  return next;
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
  // Restore onto its day only if that day is still today or later; otherwise back to the Dump.
  if (del && del.day >= s.today) next = updatePlacement(next, del.id, { outcome: null });
  return next;
}

export function delegate(s: State, taskId: string, who: string, followUp: Day): State {
  const open = openPlacement(s, taskId);
  let next = updateTask(s, taskId, { state: 'waiting', delegate: who, followUp });
  if (open) next = updatePlacement(next, open.id, { outcome: 'delegated', target: followUp, touched: true });
  return next;
}

export function toggleInProgress(s: State, taskId: string): State {
  const open = openPlacement(s, taskId);
  return open ? updatePlacement(s, open.id, { inProgress: !open.inProgress, touched: true }) : s;
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

/**
 * Typed rank. Reserved numbers (held by closed entries that day and letter) are refused.
 * A number held by an open task moves that task, and any after it, to the next free numbers.
 */
export function setRank(s: State, placementId: string, rank: number): { state: State; message?: string } {
  const pl = s.placements.find((p) => p.id === placementId)!;
  if (!pl.letter) return { state: s, message: 'Give the task a letter first.' };
  const reserved = reservedRanks(s, pl.day, pl.letter);
  if (reserved.has(rank)) {
    return { state: s, message: `${pl.letter}${rank} is already used today by a closed entry. Numbers stay unique for the day.` };
  }
  const open = s.placements.filter(
    (p) => p.day === pl.day && p.letter === pl.letter && p.outcome === null && p.id !== pl.id && p.rank !== null,
  );
  let next = updatePlacement(s, pl.id, { rank, touched: true });
  const holder = open.find((p) => p.rank === rank);
  if (holder) {
    // Shift the holder and every open task ranked after it to the next free numbers.
    const toShift = open.filter((p) => (p.rank as number) >= rank).sort((a, b) => (a.rank as number) - (b.rank as number));
    const taken = new Set([...reserved, rank, ...open.filter((p) => (p.rank as number) < rank).map((p) => p.rank as number)]);
    let n = rank;
    for (const p of toShift) {
      do n++; while (taken.has(n));
      taken.add(n);
      next = updatePlacement(next, p.id, { rank: n });
    }
  }
  return { state: next };
}

/** Explicit reorder of a group's open entries: lowest numbers not reserved, in the given order. */
export function reorderGroup(s: State, day: Day, letter: Letter, orderedIds: string[]): State {
  const reserved = reservedRanks(s, day, letter);
  let next = s;
  let n = 0;
  for (const id of orderedIds) {
    do n++; while (reserved.has(n));
    next = updatePlacement(next, id, { rank: n, touched: true });
  }
  return next;
}

/** Move one open entry up or down within its letter group, then renumber that group. */
export function moveInGroup(s: State, placementId: string, dir: -1 | 1): State {
  const pl = s.placements.find((p) => p.id === placementId)!;
  if (!pl.letter) return s;
  const group = sortForDay(s.placements.filter((p) => p.day === pl.day && p.letter === pl.letter && p.outcome === null));
  const i = group.findIndex((p) => p.id === pl.id);
  const j = i + dir;
  if (j < 0 || j >= group.length) return s;
  const ids = group.map((p) => p.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return reorderGroup(s, pl.day, pl.letter, ids);
}

/** Plan a C task onto a day. It stays C: planning never promotes. */
export function planIt(s: State, taskId: string, day: Day): State {
  const t = taskById(s, taskId);
  return assign(s, taskId, t.priority, day, t.deadline, t.effort);
}

export function snooze(s: State, taskId: string): State {
  return { ...s, snoozes: { ...s.snoozes, [taskId]: addDays(s.today, SNOOZE_DAYS) } };
}

export function pauseSuggestions(s: State): State {
  return { ...s, pausedUntil: addDays(s.today, SNOOZE_DAYS) };
}

export function setDesignation(s: State, day: Day, d: Designation | null): State {
  const designations = { ...s.designations };
  if (d) designations[day] = d;
  else delete designations[day];
  return { ...s, designations };
}

/**
 * Rollover to the next planner day. Appends history; never rewrites it. Idempotent through
 * the ledger: rolling over to a day already processed changes nothing.
 */
export function rollover(s: State): State {
  const newDay = addDays(s.today, 1);
  if (s.rolledOverTo.includes(newDay)) return { ...s, today: newDay };
  let next: State = { ...s, today: newDay, rolledOverTo: [...s.rolledOverTo, newDay], cardDismissedDay: null };
  for (const p of s.placements.filter((p) => p.outcome === null && p.day < newDay)) {
    next = updatePlacement(next, p.id, { outcome: 'carried', target: newDay, inProgress: false });
    next = addPlacement(next, { taskId: p.taskId, day: newDay, letter: p.letter, rank: null, outcome: null, by: 'rollover', touched: false });
  }
  // Delegated tasks reappear on their follow-up day as a "check on" item; they never carry.
  for (const t of s.tasks.filter((t) => t.state === 'waiting' && t.followUp === newDay)) {
    next = updateTask(next, t.id, { state: 'active' });
    next = addPlacement(next, { taskId: t.id, day: newDay, letter: t.priority, rank: null, outcome: null, by: 'rollover', touched: false });
  }
  return next;
}
