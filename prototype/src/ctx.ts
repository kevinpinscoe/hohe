import type { Day } from './dates';
import type { State } from './model';

export type View = 'today' | 'dump' | 'review';

export type DialogSpec =
  | { kind: 'rank'; placementId: string }
  | { kind: 'actions'; taskId: string }
  | { kind: 'forward'; taskId: string }
  | { kind: 'delegate'; taskId: string }
  | { kind: 'assign'; taskId: string }
  | { kind: 'priority'; taskId: string }
  | { kind: 'plan'; taskId: string; suggestedDay?: Day }
  | { kind: 'about' };

/** What every view receives. */
export interface Ctx {
  s: State;
  /** Apply a model operation; the message shows in a toast with Undo. Closes any dialog unless keepOpen. */
  act: (fn: (s: State) => State, message?: string, keepOpen?: boolean) => void;
  /** Show a toast without changing state (for refusals and hints). */
  notify: (message: string) => void;
  open: (d: DialogSpec) => void;
  close: () => void;
  go: (view: View, day?: Day) => void;
  viewDay: Day;
}
