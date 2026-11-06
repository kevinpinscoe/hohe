// Acceptance scenarios from the HOHE proposal (§15) that the prototype demonstrates.

import { describe, expect, it } from 'vitest';
import { addDays, currentPlannerDay } from './dates';
import {
  carriedCount,
  carrySpan,
  complete,
  moveInGroup,
  openPlacement,
  placementsOn,
  planIt,
  reorderGroup,
  rollover,
  setRank,
  sortForDay,
  suggest,
  taskById,
  type State,
} from './model';
import { buildSeed } from './seed';

const TUE = '2026-11-03';
const seed = () => buildSeed(TUE);
const byTitle = (s: State, title: string) => s.tasks.find((t) => t.title.startsWith(title))!;
const openOn = (s: State, title: string) => openPlacement(s, byTitle(s, title).id)!;
const label = (s: State, day: string, letter: 'A' | 'B' | 'C') =>
  sortForDay(placementsOn(s, day).filter((p) => p.letter === letter)).map((p) => `${p.letter}${p.rank ?? ''}:${p.outcome ?? 'open'}`);

describe('reserved ranks', () => {
  it('keeps completed A1 as A1 when open A2 and A3 are reordered, with no duplicate', () => {
    let s = seed();
    // Seed: A1 completed, A2 and A3 open, A4 open.
    const a3 = openOn(s, 'Pay the electric bill');
    s = moveInGroup(s, a3.id, -1); // move A3 above A2
    const ranks = placementsOn(s, TUE).filter((p) => p.letter === 'A').map((p) => p.rank);
    expect(new Set(ranks).size).toBe(ranks.length); // distinct
    expect(placementsOn(s, TUE).find((p) => p.outcome === 'completed' && p.letter === 'A')!.rank).toBe(1);
    expect(openOn(s, 'Pay the electric bill').rank).toBe(2);
    expect(openOn(s, 'Call Sarah').rank).toBe(3);
  });

  it('refuses a typed rank held by a closed entry, and shifts an open holder to free numbers', () => {
    let s = seed();
    const sarah = openOn(s, 'Call Sarah');
    expect(setRank(s, sarah.id, 1).message).toMatch(/already used/);
    const car = openOn(s, 'Renew the car registration');
    s = setRank(s, car.id, 2).state; // A2 is held by Sarah (open): Sarah and later shift
    expect(label(s, TUE, 'A')).toEqual(['A1:completed', 'A2:open', 'A3:open', 'A4:open']);
    expect(openOn(s, 'Call Sarah').rank).toBe(3);
  });

  it('renumbers around a reserved C3 when reordering C', () => {
    let s = seed();
    const open = sortForDay(placementsOn(s, TUE).filter((p) => p.letter === 'C' && p.outcome === null && p.rank !== null));
    s = reorderGroup(s, TUE, 'C', open.map((p) => p.id).reverse());
    const ranks = placementsOn(s, TUE).filter((p) => p.letter === 'C' && p.rank !== null).map((p) => p.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toContain(3); // the completed C3 keeps it
  });
});

describe('carry history', () => {
  it('Tuesday task carries through Wednesday to Thursday; closed history is preserved', () => {
    let s = seed();
    const t = byTitle(s, 'Call Sarah');
    const tue = openPlacement(s, t.id)!;
    s = rollover(s); // → Wednesday
    const wed = openPlacement(s, t.id)!;
    expect(wed.day).toBe(addDays(TUE, 1));
    const wedBefore = JSON.stringify(wed); // "viewing" Wednesday changes nothing; the model has no view op
    s = rollover(s); // → Thursday
    const wedAfter = s.placements.find((p) => p.id === wed.id)!;
    expect(wedAfter.outcome).toBe('carried'); // open → carried at Thursday's rollover
    expect(JSON.parse(wedBefore).outcome).toBeNull();
    expect(carrySpan(s, wedAfter)).toMatchObject({ from: TUE, to: addDays(TUE, 2), days: 2 });
    expect(carriedCount(s, t.id)).toBe(2);
    s = complete(s, t.id);
    const tueFinal = s.placements.find((p) => p.id === tue.id)!;
    const wedFinal = s.placements.find((p) => p.id === wed.id)!;
    expect(tueFinal.outcome).toBe('carried');
    expect(wedFinal).toEqual(wedAfter); // completion did not touch closed history
    expect(taskById(s, t.id).state).toBe('completed');
  });

  it('rollover is idempotent and never duplicates a task', () => {
    let s = seed();
    s = rollover(s);
    const count = s.placements.length;
    const again = rollover({ ...s, today: TUE }); // replay the same rollover
    expect(again.placements.length).toBe(count);
  });

  it('does not carry unscheduled, future-scheduled or delegated tasks', () => {
    const s0 = seed();
    const s = rollover(s0);
    expect(openPlacement(s, byTitle(s, 'Clean out the garage').id)).toBeUndefined();
    expect(openOn(s, 'Meet the plumber').day).toBe(addDays(TUE, 2)); // stays on its date
    expect(openPlacement(s, byTitle(s, 'Get the lawn mower').id)).toBeUndefined(); // waiting until follow-up
    const s2 = rollover(s);
    expect(openOn(s2, 'Get the lawn mower').day).toBe(addDays(TUE, 2)); // back on its check-on day
  });
});

describe('C tasks and suggestions', () => {
  it('suggests an unscheduled C onto a "room available" day, and Plan it keeps it C', () => {
    let s = seed();
    const sug = suggest(s, { includeToday: false })!;
    expect(sug).not.toBeNull();
    expect(s.designations[sug.day]).toBe('room');
    expect(taskById(s, sug.taskId).priority).toBe('C');
    s = planIt(s, sug.taskId, sug.day);
    expect(taskById(s, sug.taskId).priority).toBe('C');
    expect(openPlacement(s, sug.taskId)!.letter).toBe('C');
    s = complete(s, sug.taskId);
    expect(taskById(s, sug.taskId).priority).toBe('C');
  });

  it('lets an approaching deadline bypass the minimum age', () => {
    const s = seed();
    expect(suggest(s, { includeToday: false })!.taskId).toBe(byTitle(s, 'Renew the library card').id);
  });

  it('never targets unmarked days', () => {
    const s = { ...seed(), designations: {} };
    expect(suggest(s, { includeToday: false })).toBeNull();
  });
});

describe('planner day', () => {
  it('uses the explicit time zone and the 03:00 rollover', () => {
    // 2026-11-06 02:30 in New York is still the 5th; 03:30 is the 6th.
    expect(currentPlannerDay(new Date('2026-11-06T07:30:00Z'))).toBe('2026-11-05');
    expect(currentPlannerDay(new Date('2026-11-06T08:30:00Z'))).toBe('2026-11-06');
  });
});
