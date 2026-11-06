// Smoke test: every page and dialog renders without throwing, using the synthetic seed.

import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { Ctx, DialogSpec } from './ctx';
import { DayPage } from './day';
import { DialogHost } from './dialogs';
import { DumpPage, PlanMyDay, ReviewPage } from './lists';
import { addDays } from './dates';
import { rollover, type State } from './model';
import { buildSeed } from './seed';

const ctxFor = (s: State, viewDay = s.today): Ctx => ({
  s,
  viewDay,
  act: () => {},
  notify: () => {},
  open: () => {},
  close: () => {},
  go: () => {},
});

describe('renders', () => {
  const s = buildSeed('2026-11-06');
  it('today, a past day with a carry span, and a future day', () => {
    const html = render(<DayPage ctx={ctxFor(s)} />);
    expect(html).toContain('Prioritized Daily Task List');
    expect(html).toContain('carried ×2');
    expect(render(<DayPage ctx={ctxFor(s, addDays(s.today, -1))} />)).toContain('carried Wed → Fri');
    expect(render(<DayPage ctx={ctxFor(s, addDays(s.today, 1))} />)).toContain('Call the pharmacy');
  });
  it('Task Dump, C Review and Plan My Day', () => {
    expect(render(<DumpPage ctx={ctxFor(s)} />)).toContain('Look into a cheaper phone plan');
    const review = render(<ReviewPage ctx={ctxFor(s)} />);
    expect(review).toContain('Plan it');
    expect(review).toContain('stays C');
    const next = rollover(s);
    expect(render(<PlanMyDay ctx={ctxFor(next)} onFinish={() => {}} />)).toContain('Carried in');
  });
  it('every dialog', () => {
    const task = s.tasks.find((t) => t.title.startsWith('Call Sarah'))!;
    const pl = s.placements.find((p) => p.taskId === task.id)!;
    const specs: DialogSpec[] = [
      { kind: 'actions', taskId: task.id },
      { kind: 'rank', placementId: pl.id },
      { kind: 'forward', taskId: task.id },
      { kind: 'delegate', taskId: task.id },
      { kind: 'assign', taskId: task.id },
      { kind: 'priority', taskId: task.id },
      { kind: 'plan', taskId: task.id },
      { kind: 'about' },
    ];
    for (const spec of specs) expect(render(<DialogHost ctx={ctxFor(s)} spec={spec} />).length).toBeGreaterThan(50);
    expect(render(<DialogHost ctx={ctxFor(s)} spec={{ kind: 'rank', placementId: pl.id }} />)).toContain('reserved');
  });
});
