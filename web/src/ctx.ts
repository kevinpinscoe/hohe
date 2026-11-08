import type { Day } from './dates';
import type { Baseline, Intent } from './intents';
import type { State } from './model';

export type View = 'today' | 'dump' | 'review' | 'sync' | 'settings';

export type DialogSpec =
  | { kind: 'rank'; placementId: string }
  | { kind: 'actions'; taskId: string }
  | { kind: 'edit'; taskId: string }
  | { kind: 'forward'; taskId: string }
  | { kind: 'delegate'; taskId: string }
  | { kind: 'assign'; taskId: string }
  | { kind: 'priority'; taskId: string }
  | { kind: 'plan'; taskId: string; suggestedDay?: Day }
  | { kind: 'about' };

export interface ActOptions {
  /** Keep the open dialog open after acting. */
  keepOpen?: boolean;
  /** An action that reverses this one, offered as Undo in the toast. */
  undo?: Intent;
}

/** What every view receives. */
export interface Ctx {
  /** The display state: the server's confirmed state with this device's pending changes applied. */
  s: State;
  /**
   * Queue an action. Resolves true once it is stored on this device (the toast then shows),
   * false if it could not be stored; the caller keeps any typed text in that case.
   */
  act: (intent: Intent, message?: string, opts?: ActOptions) => Promise<boolean>;
  /** Show a toast without changing state (for refusals and hints). */
  notify: (message: string) => void;
  open: (d: DialogSpec) => void;
  close: () => void;
  go: (view: View, day?: Day) => void;
  viewDay: Day;
  /** Task ids with changes still waiting to sync, and the time of the oldest one. */
  pendingTasks: Map<string, number>;
  /** Wall-clock now, for "waiting for 12 min". */
  now: number;
  /** An edit dialog's baseline: field values and revisions as of when it opens. */
  editBaseline: (taskId: string, fields: string[]) => Baseline;
}
