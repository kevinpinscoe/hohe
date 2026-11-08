// Settings: the running version, this device's storage, the planner settings, and the
// guarded Log out / Clear this device actions.

import { useEffect, useState } from 'preact/hooks';
import type { Ctx } from './ctx';
import { intents } from './intents';
import type { Status, Store } from './store';
import { APP_VERSION } from './update';

interface StorageInfo {
  persisted: boolean | null; // null: the browser cannot say
  usage: number | null;
  quota: number | null;
}

export async function readStorageInfo(): Promise<StorageInfo> {
  const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (st?.persisted) persisted = await st.persisted();
  } catch {
    persisted = null;
  }
  try {
    if (st?.estimate) {
      const e = await st.estimate();
      usage = e.usage ?? null;
      quota = e.quota ?? null;
    }
  } catch {
    /* unknown */
  }
  return { persisted, usage, quota };
}

export function persistText(p: boolean | null): string {
  if (p === true) return 'Persistent: the browser will not evict this device’s copy to free space.';
  if (p === false) return 'Not persistent: the browser may evict this device’s copy under storage pressure. Unsynced changes would be lost.';
  return 'Unknown: this browser does not report whether storage is persistent.';
}

const mb = (n: number | null) => (n === null ? '?' : `${(n / 1_048_576).toFixed(1)} MB`);

const FIELDS: { key: string; label: string; kind: 'text' | 'number' }[] = [
  { key: 'timeZone', label: 'Time zone', kind: 'text' },
  { key: 'rollover', label: 'Rollover time (HH:MM)', kind: 'text' },
  { key: 'aWarning', label: 'Warn above this many A tasks', kind: 'number' },
  { key: 'minAgeDays', label: 'Suggest C tasks older than (days)', kind: 'number' },
  { key: 'deadlineWindowDays', label: 'Deadline window (days)', kind: 'number' },
  { key: 'snoozeDays', label: 'Snooze length (days)', kind: 'number' },
  { key: 'cardEarliest', label: 'Earliest suggestion card (HH:MM)', kind: 'text' },
  { key: 'deleteRetentionDays', label: 'Keep deleted tasks (days)', kind: 'number' },
];

export function SettingsPage(props: { ctx: Ctx; st: Status; store: Store }) {
  const { ctx, st, store } = props;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [leaving, setLeaving] = useState<null | 'logout' | 'clear'>(null);
  useEffect(() => {
    void readStorageInfo().then(setInfo);
  }, []);
  const settings = ctx.s.settings as unknown as Record<string, unknown>;

  return (
    <section class="page single">
      <h2>Settings</h2>

      <h3 class="sub">Version</h3>
      <p>
        This app: <strong class="mono">{APP_VERSION}</strong>
        <br />
        Server: <strong class="mono">{st.serverBuild ? `${st.serverBuild.version} (${st.serverBuild.commit})` : 'not known yet'}</strong>
      </p>

      <h3 class="sub">This device’s storage</h3>
      <p data-testid="persist-result">{info ? persistText(info.persisted) : 'Checking…'}</p>
      {info && (
        <p class="muted">
          Using {mb(info.usage)} of {mb(info.quota)}.
        </p>
      )}
      {info && info.persisted === false && (
        <button
          class="btn small"
          onClick={async () => {
            try {
              await navigator.storage.persist();
            } catch {
              /* the result below says what happened */
            }
            setInfo(await readStorageInfo());
          }}
        >
          Ask the browser again
        </button>
      )}

      <h3 class="sub">Planner</h3>
      <form
        class="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget as HTMLFormElement);
          for (const f of FIELDS) {
            const raw = String(fd.get(f.key) ?? '');
            const value = f.kind === 'number' ? Number(raw) : raw;
            if (String(settings[f.key]) !== String(value)) void ctx.act(intents.setting(f.key, value), 'Setting saved', { keepOpen: true });
          }
        }}
      >
        {FIELDS.map((f) => (
          <label key={f.key} class="field">
            {f.label}
            <input name={f.key} type={f.kind} defaultValue={String(settings[f.key] ?? '')} />
          </label>
        ))}
        <div class="sheet-actions">
          <button class="btn primary" type="submit">
            Save settings
          </button>
        </div>
      </form>

      <h3 class="sub">Session and device</h3>
      <div class="sheet-actions left">
        <button class="btn" onClick={() => setLeaving('logout')} disabled={st.needsLogin}>
          Log out
        </button>
        <button class="btn danger" onClick={() => setLeaving('clear')}>
          Clear this device
        </button>
      </div>
      {leaving && <LeaveDevice mode={leaving} st={st} store={store} onDone={() => setLeaving(null)} />}
    </section>
  );
}

/** Downloads text as a file. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What is outstanding on this device, in words: pending changes and rejected actions both count. */
export function outstandingText(pending: number, rejected: number): string {
  const parts: string[] = [];
  if (pending > 0) parts.push(`${plural(pending, 'change has', 'changes have')} not reached the server yet`);
  if (rejected > 0) parts.push(`${plural(rejected, 'rejected action was', 'rejected actions were')} refused by the server and never applied`);
  if (parts.length === 0) return 'Nothing is waiting to sync and no rejected actions remain.';
  return parts.join(', and ') + '.';
}

/**
 * The guard before logout or clearing (§11.6). Pending changes and rejected actions are never
 * lost by accident: both are counted, exported and named in the discard confirmation, and
 * rejected actions must be exported before Discard is offered. The store rechecks the counts
 * under the sync lock immediately before clearing; if another tab added work after the
 * confirmation, nothing is cleared and this asks again with the new counts.
 */
export function LeaveDevice(props: { mode: 'logout' | 'clear'; st: Status; store: Store; onDone: () => void }) {
  const { mode, st, store } = props;
  const [exported, setExported] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const n = st.pending.length;
  const r = st.attention.length;
  const verb = mode === 'logout' ? 'Log out' : 'Clear this device';
  const ids = () => new Set([...st.pending.map((q) => q.op.id), ...st.attention.map((a) => a.id)]);
  const rejectedExported = st.attention.every((a) => exported.has(a.id));

  const leave = async () => {
    setBusy(true);
    try {
      const res = await store.leave(mode, ids());
      if (res.cleared) {
        props.onDone();
        return;
      }
      setNotice(
        `Another tab added work after you confirmed, so nothing was removed. Now ${outstandingText(res.pending.length, res.attention.length).replace(/^./, (c) => c.toLowerCase())} Confirm again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    const text = await store.exportPending();
    download(`hohe-outstanding-${new Date().toISOString().slice(0, 16)}.json`, text);
    const doc = JSON.parse(text) as { pending: { op: { id: string } }[]; rejected: { id: string }[] };
    setExported(new Set([...doc.pending.map((q) => q.op.id), ...doc.rejected.map((a) => a.id)]));
  };

  return (
    <div class="overlay">
      <div class="sheet" role="dialog" aria-modal="true" aria-label={verb}>
        <div class="sheet-head">
          <h2>{verb}</h2>
          <button class="icon-btn" aria-label="Close" onClick={props.onDone}>
            ✕
          </button>
        </div>
        {notice && (
          <p class="note warn" role="alert">
            {notice}
          </p>
        )}
        <p data-testid="outstanding">
          <strong>{outstandingText(n, r)}</strong>
        </p>
        {n + r === 0 ? (
          <>
            <p>This device’s copy of your planner will be removed.</p>
            <div class="sheet-actions">
              <button class="btn primary" disabled={busy} onClick={() => void leave()}>
                {verb}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>Choose what to do with {n + r === 1 ? 'it' : 'them'} first.</p>
            <div class="menu">
              {n > 0 && (
                <button class="menu-item" onClick={() => void store.sync()}>
                  Sync now
                </button>
              )}
              <button class="menu-item" onClick={() => void exportAll()}>
                Export {[n > 0 ? 'pending changes' : '', r > 0 ? 'rejected actions' : ''].filter(Boolean).join(' and ')} to a file
              </button>
              {!rejectedExported && <p class="hint">Rejected actions are not on the server. Export them before they can be discarded.</p>}
              <button
                class="menu-item danger"
                disabled={busy || !rejectedExported}
                onClick={() => {
                  const what = [n > 0 ? plural(n, 'unsynced change', 'unsynced changes') : '', r > 0 ? plural(r, 'rejected action', 'rejected actions') : '']
                    .filter(Boolean)
                    .join(' and ');
                  if (!confirm(`Discard ${what} and ${verb.toLowerCase()}? This cannot be undone.`)) return;
                  void leave();
                }}
              >
                Discard {[n > 0 ? plural(n, 'pending change', 'pending changes') : '', r > 0 ? plural(r, 'rejected action', 'rejected actions') : ''].filter(Boolean).join(' and ')} and{' '}
                {verb.toLowerCase()}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
