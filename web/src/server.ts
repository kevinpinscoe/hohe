// The server's JSON shapes (server/internal/domain and server/internal/api). The server is
// authoritative; these types describe what it sends and accepts, nothing more.

export interface SrvTask {
  id: string;
  title: string;
  notes: string;
  priority: string; // "", "A", "B", "C"
  deadline: string;
  effort: string; // "", "S", "M", "L"
  tags: string[] | null;
  state: string; // active, waiting, completed, deleted, purged
  delegate: string;
  followUp: string;
  createdDay: string;
  createdAt: string;
  completedDay: string;
  deletedDay: string;
  deletedAt: string;
  purgedAt: string;
  source: string;
  revisions: Record<string, number> | null;
  rev: number;
}

export interface SrvPlacement {
  id: string;
  taskId: string;
  day: string;
  letter: string;
  rank: number; // 0 = unnumbered
  outcome: string; // "" = open
  target: string;
  by: string;
  catchUp: boolean;
  touched: boolean;
  inProgress: boolean;
  createdAt: string;
  closedAt: string;
  rev: number;
}

export interface SrvSettings {
  timeZone: string;
  rollover: string;
  aWarning: number;
  minAgeDays: number;
  deadlineWindowDays: number;
  snoozeDays: number;
  cardEarliest: string;
  deleteRetentionDays: number;
  weekStart: string;
  revisions: Record<string, number> | null;
}

export interface SrvPlanning {
  designations: Record<string, string> | null;
  snoozes: Record<string, string> | null;
  pausedUntil: string;
  cardDismissedDay: string;
  plannedDays: string[] | null;
}

export interface Op {
  id: string;
  type: string;
  taskId?: string;
  placementId?: string;
  basePlacementId?: string;
  title?: string;
  field?: string;
  value?: unknown;
  letter?: string;
  rank?: number;
  day?: string;
  deadline?: string;
  effort?: string;
  who?: string;
  order?: string[];
  outcome?: string;
  bool?: boolean;
  baseRevision?: number;
  dependsOn?: string;
  resolves?: string;
  clientPlannerDay?: string;
  clientTime?: string;
}

export interface SrvConflict {
  id: string;
  kind: string;
  opId: string;
  deviceId: string;
  taskId: string;
  field: string;
  serverValue: unknown;
  serverRevision: number;
  proposedValue: unknown;
  baseRevision: number;
  message: string;
  actions: string[] | null;
  op: Op | null;
  heldOps: Op[] | null;
  status: string;
  createdAt: string;
  resolvedAt: string;
}

export interface SrvSuggestion {
  taskId: string;
  title: string;
  day: string;
  reason: string;
}

export interface SrvView {
  serverPlannerDay: string;
  lastRolled: string;
  settings: SrvSettings;
  planning: SrvPlanning;
  tasks: SrvTask[] | null;
  placements: SrvPlacement[] | null;
  conflicts: SrvConflict[] | null;
  groupRevisions: Record<string, number> | null;
  suggestion: SrvSuggestion | null;
  card: SrvSuggestion | null;
  counts: Record<string, number> | null;
}

export interface Result {
  opId: string;
  status: 'applied' | 'noop' | 'conflict' | 'held' | 'rejected';
  replayed?: boolean;
  taskId?: string;
  placementId?: string;
  revision?: number;
  conflictId?: string;
  reason?: string;
  notice?: string;
  serverPlannerDay?: string;
  plannerDayMismatch?: boolean;
}

export interface Build {
  version: string;
  commit: string;
}

/** Lists the server documents as never null are still read defensively (Phase 2 finding 1). */
export const list = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
export const map = <T,>(v: Record<string, T> | null | undefined): Record<string, T> =>
  v && typeof v === 'object' ? v : {};
