// Sync status: the summary chip, the plain banners, and the Sync page (conflict tray, rejected
// actions, changes waiting to sync). "All synced" is shown only when nothing is waiting, no
// conflict needs a choice and no rejected action needs attention.

import { Component, type ComponentChildren } from 'preact';
import type { Ctx } from './ctx';
import { intents } from './intents';
import type { Attention } from './db';
import type { QueuedOp } from './local';
import { list, type SrvConflict } from './server';
import type { Status } from './store';

// ── pure helpers (tested) ────────────────────────────────────────────────────

export function ageText(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export interface Summary {
  tone: 'ok' | 'waiting' | 'attention' | 'offline';
  text: string;
}

export function syncSummary(st: Status, conflicts: SrvConflict[], now: number): Summary {
  const parts: string[] = [];
  const waiting = st.pending.length;
  if (waiting > 0) {
    const oldest = Math.min(...st.pending.map((q) => q.createdAt));
    parts.push(`${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting to sync (oldest ${ageText(now - oldest)})`);
  }
  if (conflicts.length > 0) parts.push(`${conflicts.length} ${conflicts.length === 1 ? 'conflict needs' : 'conflicts need'} a choice`);
  if (st.attention.length > 0) parts.push(`${st.attention.length} rejected ${st.attention.length === 1 ? 'action needs' : 'actions need'} attention`);
  const offline = st.net === 'unreachable' || st.net === 'server-error';
  if (parts.length === 0) {
    if (offline) return { tone: 'offline', text: 'Server unreachable · nothing waiting' };
    if (st.needsLogin) return { tone: 'attention', text: 'Logged out' };
    if (st.lastSyncAt === null) return { tone: 'waiting', text: 'Not synced yet' };
    return { tone: 'ok', text: 'All synced' };
  }
  const tone = conflicts.length > 0 || st.attention.length > 0 ? 'attention' : offline ? 'offline' : 'waiting';
  return { tone, text: parts.join(' · ') };
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const ACTION_LABELS: Record<string, string> = {
  'keep-server': 'Keep server',
  'use-mine': 'Use mine',
  discard: 'Discard',
  'restore-and-apply': 'Restore and apply',
  'reopen-and-apply': 'Reopen and apply',
  'apply-anyway': 'Apply anyway',
  dismiss: 'Dismiss',
};

// ── components ───────────────────────────────────────────────────────────────

/** Contains a render failure to its own section, so one bad row never blanks the screen. */
export class Guard extends Component<{ label: string; children: ComponentChildren }, { error: string | null }> {
  state = { error: null as string | null };
  componentDidCatch(e: unknown) {
    this.setState({ error: e instanceof Error ? e.message : String(e) });
  }
  render() {
    if (this.state.error) {
      return (
        <div class="note warn" role="alert">
          {this.props.label} could not be shown ({this.state.error}). The rest of HOHE still works.
        </div>
      );
    }
    return this.props.children;
  }
}

export function PendingBadge(props: { ctx: Ctx; taskId: string }) {
  const since = props.ctx.pendingTasks.get(props.taskId);
  if (since === undefined) return null;
  return <span class="badge pending">waiting to sync · {ageText(props.ctx.now - since)}</span>;
}

export function StatusChip(props: { st: Status; conflicts: SrvConflict[]; now: number; onOpen: () => void }) {
  const sum = syncSummary(props.st, props.conflicts, props.now);
  return (
    <button class={`sync-chip tone-${sum.tone}`} onClick={props.onOpen} aria-label={`Sync status: ${sum.text}`}>
      {props.st.syncing ? 'Syncing… ' : ''}
      {sum.text}
    </button>
  );
}

export function Banners(props: { st: Status; now: number; onLogin: () => void }) {
  const { st } = props;
  const waiting = st.pending.length;
  const kept = waiting > 0 ? ` ${waiting} ${waiting === 1 ? 'change is' : 'changes are'} saved on this device and will sync when it is back.` : '';
  const last = st.lastSyncAt ? ` Last synced ${ageText(props.now - st.lastSyncAt)} ago.` : '';
  return (
    <>
      {st.storageError && (
        <div class="banner danger" role="alert">
          {st.storageError}
        </div>
      )}
      {st.net === 'unreachable' && (
        <div class="banner offline" role="alert">
          <strong>Server unreachable.</strong> You are working from this device's copy.{last}
          {kept}
        </div>
      )}
      {st.net === 'server-error' && (
        <div class="banner offline" role="alert">
          <strong>The server had a problem</strong> and saved nothing from the last attempt. HOHE will retry.{kept}
        </div>
      )}
      {st.net === 'refused' && (
        <div class="banner danger" role="alert">
          <strong>The server refused this device's changes:</strong> {st.netMessage}. They stay saved on this device; see Sync.
        </div>
      )}
      {st.needsLogin && st.hasServerCopy && (
        <div class="banner attention" role="alert">
          <strong>Log in to sync.</strong>
          {waiting > 0 ? ` ${waiting} ${waiting === 1 ? 'change is' : 'changes are'} kept on this device until then.` : ''}{' '}
          <button class="btn small primary" onClick={props.onLogin}>
            Log in
          </button>
        </div>
      )}
    </>
  );
}

export function ConflictTray(props: { ctx: Ctx; conflicts: SrvConflict[] }) {
  const { ctx } = props;
  const conflicts = list(props.conflicts);
  return (
    <section aria-label="Conflict tray">
      <h3 class="sub">Conflicts needing a choice ({conflicts.length})</h3>
      {conflicts.length === 0 && <p class="muted empty">No conflicts.</p>}
      <ul class="dump-list">
        {conflicts.map((c) => (
          <Guard key={c.id} label="This conflict">
            <ConflictRow ctx={ctx} c={c} />
          </Guard>
        ))}
      </ul>
    </section>
  );
}

function ConflictRow(props: { ctx: Ctx; c: SrvConflict }) {
  const { ctx, c } = props;
  const held = list(c.heldOps);
  const actions = list(c.actions);
  const task = c.taskId ? ctx.s.tasks.find((t) => t.id === c.taskId) : undefined;
  const showValues = c.kind === 'field' || c.kind === 'setting';
  return (
    <li class="conflict">
      <div class="title-cell">
        <span class="title">{task ? task.title : c.field ? `Setting: ${c.field}` : 'A change'}</span>
        <span class="muted">{c.message}</span>
        {showValues && (
          <dl class="values">
            <dt>Server ({c.field})</dt>
            <dd>{formatValue(c.serverValue)}</dd>
            <dt>Yours</dt>
            <dd>{formatValue(c.proposedValue)}</dd>
          </dl>
        )}
        {held.length > 0 && (
          <span class="muted">
            {held.length} later {held.length === 1 ? 'change waits' : 'changes wait'} on this choice.
          </span>
        )}
      </div>
      <span class="row-actions wrap">
        {actions.length === 0 && <span class="muted">No action offered; it stays here.</span>}
        {actions.map((a) => (
          <button
            key={a}
            class={`btn small ${a === 'keep-server' ? 'primary' : ''}`}
            onClick={() => ctx.act(intents.resolve(c.id, a), `${ACTION_LABELS[a] ?? a}: chosen`, { keepOpen: true })}
          >
            {ACTION_LABELS[a] ?? a}
          </button>
        ))}
      </span>
    </li>
  );
}

export function AttentionList(props: { items: Attention[]; onDismiss: (id: string) => void }) {
  const items = list(props.items);
  return (
    <section aria-label="Rejected actions">
      <h3 class="sub">Rejected actions needing attention ({items.length})</h3>
      {items.length === 0 && <p class="muted empty">Nothing was rejected.</p>}
      <ul class="dump-list">
        {items.map((a) => (
          <Guard key={a.id} label="This rejected action">
            <li class="attention">
              <div class="title-cell">
                <span class="title">{a.q?.label ?? a.id}</span>
                <span class="muted">Not applied: {a.reason}</span>
              </div>
              <button class="btn small" onClick={() => props.onDismiss(a.id)}>
                Dismiss
              </button>
            </li>
          </Guard>
        ))}
      </ul>
    </section>
  );
}

export function PendingList(props: { items: QueuedOp[]; now: number }) {
  const items = list(props.items);
  return (
    <section aria-label="Waiting to sync">
      <h3 class="sub">Waiting to sync ({items.length})</h3>
      {items.length === 0 && <p class="muted empty">Nothing is waiting.</p>}
      <ul class="dump-list">
        {items.map((q) => (
          <li key={q.op.id} class="dump-row">
            <div class="title-cell">
              <span class="title">{q.label}</span>
              <span class="badge pending">saved on this device · waiting {ageText(props.now - q.createdAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
