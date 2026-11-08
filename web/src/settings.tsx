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

/** The guard before logout or clearing: pending changes are never lost by accident (§11.6). */
export function LeaveDevice(props: { mode: 'logout' | 'clear'; st: Status; store: Store; onDone: () => void }) {
  const { mode, st, store } = props;
  const n = st.pending.length;
  const verb = mode === 'logout' ? 'Log out' : 'Clear this device';
  const finish = async () => {
    if (mode === 'logout') await store.logoutAndClear();
    else await store.clearDevice();
    props.onDone();
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
        {n === 0 ? (
          <>
            <p>Nothing is waiting to sync. This device’s copy of your planner will be removed.</p>
            <div class="sheet-actions">
              <button class="btn primary" onClick={finish}>
                {verb}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>
                {n} {n === 1 ? 'change has' : 'changes have'} not reached the server yet.
              </strong>{' '}
              Choose what to do with {n === 1 ? 'it' : 'them'} first.
            </p>
            <div class="menu">
              <button class="menu-item" onClick={() => void store.sync()}>
                Sync now
              </button>
              <button class="menu-item" onClick={() => download(`hohe-pending-${new Date().toISOString().slice(0, 16)}.json`, store.exportPending())}>
                Export pending changes to a file
              </button>
              <button
                class="menu-item danger"
                onClick={async () => {
                  if (!confirm(`Discard ${n} unsynced ${n === 1 ? 'change' : 'changes'}? ${n === 1 ? 'It' : 'They'} will be lost for good.`)) return;
                  await store.discardPending();
                  await finish();
                }}
              >
                Discard {n} pending {n === 1 ? 'change' : 'changes'} and {verb.toLowerCase()}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
