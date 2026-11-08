// Synthetic server views for tests. Every value is invented.

import type { SrvConflict, SrvPlacement, SrvTask, SrvView } from './server';

export const TODAY = '2026-11-09';

export function task(id: string, title: string, over: Partial<SrvTask> = {}): SrvTask {
  return {
    id,
    title,
    notes: '',
    priority: '',
    deadline: '',
    effort: '',
    tags: [],
    state: 'active',
    delegate: '',
    followUp: '',
    createdDay: '2026-11-01',
    createdAt: '2026-11-01T12:00:00Z',
    completedDay: '',
    deletedDay: '',
    deletedAt: '',
    purgedAt: '',
    source: 'device:test',
    revisions: { title: 1, notes: 1, priority: 1, deadline: 1, effort: 1, tags: 1, delegate: 1, followUp: 1 },
    rev: 1,
    ...over,
  };
}

export function placement(id: string, taskId: string, day: string, over: Partial<SrvPlacement> = {}): SrvPlacement {
  return {
    id,
    taskId,
    day,
    letter: '',
    rank: 0,
    outcome: '',
    target: '',
    by: 'kevin',
    catchUp: false,
    touched: true,
    inProgress: false,
    createdAt: '2026-11-01T12:00:00Z',
    closedAt: '',
    rev: 1,
    ...over,
  };
}

export function conflict(id: string, over: Partial<SrvConflict> = {}): SrvConflict {
  return {
    id,
    kind: 'field',
    opId: 'op-x',
    deviceId: 'dev-2',
    taskId: 't1',
    field: 'title',
    serverValue: 'Server title',
    serverRevision: 3,
    proposedValue: 'My title',
    baseRevision: 2,
    message: 'title was changed on another device (revision 3) after this edit’s base (revision 2).',
    actions: ['keep-server', 'use-mine'],
    op: null,
    heldOps: [],
    status: 'open',
    createdAt: '2026-11-09T12:00:00Z',
    resolvedAt: '',
    ...over,
  };
}

export function view(over: Partial<SrvView> = {}): SrvView {
  return {
    serverPlannerDay: TODAY,
    lastRolled: TODAY,
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
    ...over,
  };
}
