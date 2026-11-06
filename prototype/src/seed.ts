// Synthetic demonstration data. Every task here is invented; nothing is real personal data.
// Dates are relative to the current planner day so the demo always looks current.

import { addDays, type Day } from './dates';
import type { Effort, Letter, Outcome, Placement, State, Task } from './model';

export const STATE_VERSION = 1;

export function buildSeed(today: Day): State {
  const tasks: Task[] = [];
  const placements: Placement[] = [];
  let n = 1;
  const d = (offset: number) => addDays(today, offset);

  const task = (title: string, priority: Letter | null, createdOffset: number, extra: Partial<Task> = {}): string => {
    const id = `t${n++}`;
    tasks.push({ id, title, priority, state: 'active', createdDay: d(createdOffset), ...extra });
    return id;
  };
  const place = (
    taskId: string,
    offset: number,
    letter: Letter | null,
    rank: number | null,
    outcome: Outcome | null = null,
    extra: Partial<Placement> = {},
  ) => {
    placements.push({ id: `p${n++}`, taskId, day: d(offset), letter, rank, outcome, by: 'kevin', touched: true, ...extra });
  };
  const effort = (e: Effort) => ({ effort: e });

  // ── history: earlier days ────────────────────────────────────────────────
  const books = task('Return the library books', 'A', -4, { state: 'completed', completedDay: d(-3) });
  place(books, -3, 'A', 1, 'completed');
  const cleaning = task('Pick up the dry cleaning', 'B', -4, { state: 'completed', completedDay: d(-3) });
  place(cleaning, -3, 'B', 1, 'completed');

  // A task carried automatically through two unattended days: a carry span.
  const furnace = task('Schedule the annual furnace inspection before the first cold snap', 'B', -5, effort('S'));
  place(furnace, -2, 'B', 2, 'carried', { target: d(-1) });
  place(furnace, -1, 'B', null, 'carried', { target: d(0), by: 'rollover', touched: false });
  place(furnace, 0, 'B', null, null, { by: 'rollover', touched: false });

  // A task deliberately forwarded to tomorrow.
  const pharmacy = task('Call the pharmacy about the refill', 'A', -2);
  place(pharmacy, -1, 'A', 1, 'forwarded', { target: d(1) });
  place(pharmacy, 1, 'A', null);

  // ── today: a busy day ────────────────────────────────────────────────────
  const physical = task("Make a doctor's appointment for the annual physical", 'A', -1, {
    state: 'completed',
    completedDay: d(0),
  });
  place(physical, 0, 'A', 1, 'completed');
  place(task('Call Sarah about the weekend plans', 'A', -1), 0, 'A', 2);
  place(task('Pay the electric bill', 'A', -3, { deadline: d(2) }), 0, 'A', 3);
  place(task('Renew the car registration online before the late fee starts on the fifteenth', 'A', -6, effort('M')), 0, 'A', 4);

  place(task('Go to the grocery store: milk, eggs, coffee, and the good bread from the bakery counter', 'B', 0, effort('M')), 0, 'B', 1);
  place(task('Email the landlord about the dripping kitchen faucet', 'B', -2), 0, 'B', 2, null, { inProgress: true });
  place(task('Pick up the prescription', 'B', -1), 0, 'B', 3);
  place(task('Back up the phone photos to the computer', 'B', -2), 0, 'B', 4);
  const mower = task('Get the lawn mower blade sharpened', 'B', -4, { state: 'waiting', delegate: 'Jamie', followUp: d(2) });
  place(mower, 0, 'B', 5, 'delegated', { target: d(2) });

  place(task('Sort the mail pile on the kitchen counter', 'C', -8), 0, 'C', 1);
  place(task('Return the extra charging cable to the store', 'C', -12), 0, 'C', 2);
  const plants = task('Water the plants', 'C', 0, { state: 'completed', completedDay: d(0) });
  place(plants, 0, 'C', 3, 'completed');
  place(task('Replace the burned-out porch light bulb', 'C', -15, effort('S')), 0, 'C', 4);
  place(task('Look up the hours for the recycling drop-off', 'C', -6), 0, 'C', 5);
  place(task('Clean out the junk drawer in the kitchen', 'C', -10), 0, 'C', null);
  place(task('Text Mom a photo of the new bookshelf', null, 0), 0, null, null);

  // ── upcoming ─────────────────────────────────────────────────────────────
  place(task('Drop off the donation bag at the thrift store', 'C', -18), 1, 'C', 1);
  place(task('Meet the plumber at 9 am', 'A', -3), 2, 'A', 1);

  // ── Task Dump: captured, no priority, no day ─────────────────────────────
  task('Look into a cheaper phone plan', null, -1);
  task('Buy a birthday card for Alex', null, 0);
  task('Find the warranty for the dishwasher', null, -2);
  task('Ask about the neighborhood cleanup day', null, 0);

  // ── triaged but unscheduled ──────────────────────────────────────────────
  task('Book flights for the holiday trip', 'A', -5, { deadline: d(10), ...effort('M') });
  task('Update the emergency contact list', 'B', -9);

  // ── C backlog (unscheduled C tasks) ──────────────────────────────────────
  task('Clean out the garage', 'C', -40, effort('L'));
  task('Donate the old winter coats', 'C', -25, effort('S'));
  task('Renew the library card', 'C', -3, { deadline: d(4), ...effort('S') }); // young, but deadline bypasses minimum age
  task('Organize the hall closet', 'C', -16, effort('M'));
  task('Replace the shower curtain liner', 'C', -21, effort('S'));
  task('Fix the wobbly kitchen chair', 'C', -9, effort('S')); // too young to suggest yet

  return {
    version: STATE_VERSION,
    today,
    tasks,
    placements,
    designations: { [d(1)]: 'room', [d(2)]: 'full', [d(3)]: 'room', [d(5)]: 'rest' },
    snoozes: {},
    pausedUntil: null,
    cardDismissedDay: null,
    rolledOverTo: [today],
    plannedDays: [],
    nextId: n,
  };
}
