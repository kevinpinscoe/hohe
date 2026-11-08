// App shell: capture bar, navigation, sync status, login and the update prompt.

import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { relativeLabel, type Day } from './dates';
import type { ActOptions, Ctx, DialogSpec, View } from './ctx';
import { DayPage } from './day';
import { DialogHost } from './dialogs';
import { IntentError, intents, type Intent } from './intents';
import { DumpPage, PlanMyDay, ReviewPage } from './lists';
import { placementsOn } from './model';
import { SettingsPage } from './settings';
import { AttentionList, Banners, ConflictTray, Guard, PendingList, StatusChip } from './status';
import type { Store } from './store';
import { APP_VERSION, applyUpdate, onUpdateReady } from './update';
import { ApiError } from './api';

interface Toast {
  message: string;
  undo?: Intent;
  error?: boolean;
}

/**
 * Subscribe to the store. The store starts before this component's effects run, so an update
 * can arrive before the subscription exists; re-reading `store.current` right after
 * subscribing means none is missed (a missed "loaded" left the app on "Opening HOHE…").
 */
function useStore(store: Store) {
  const [snap, setSnap] = useState(store.current);
  useLayoutEffect(() => {
    const update = () => setSnap(store.current);
    const unsubscribe = store.subscribe(update);
    update();
    return unsubscribe;
  }, [store]);
  return snap;
}

export function App(props: { store: Store }) {
  const { store } = props;
  const cur = useStore(store);
  const { status: st, view: s } = cur;
  const [view, setView] = useState<View>('today');
  const [viewDay, setViewDay] = useState<Day>(cur.today);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [captureText, setCaptureText] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => onUpdateReady(setUpdateReady), []);
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      store.tick();
    }, 30_000);
    return () => clearInterval(id);
  }, [store]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const ctx: Ctx = {
    s,
    viewDay,
    now,
    pendingTasks: cur.pendingTasks,
    editBaseline: (taskId, fields) => store.editBaseline(taskId, fields),
    act: async (intent: Intent, message?: string, opts: ActOptions = {}) => {
      try {
        await store.act(intent);
      } catch (e) {
        setToast({ message: e instanceof IntentError ? e.message : (e as Error).message, error: true });
        return false;
      }
      if (!opts.keepOpen) setDialog(null);
      if (message) setToast({ message, undo: opts.undo });
      return true;
    },
    notify: (message) => setToast({ message }),
    open: (d) => setDialog(d),
    close: () => setDialog(null),
    go: (v, day) => {
      setView(v);
      if (day) setViewDay(day);
      setDialog(null);
    },
  };

  if (!st.loaded) return <div class="app loading">Opening HOHE…</div>;
  if (st.storageError && !st.hasServerCopy && st.pending.length === 0 && !st.needsLogin) {
    return (
      <div class="app">
        <Banners st={st} now={now} onLogin={() => setLoginOpen(true)} />
      </div>
    );
  }
  if (st.needsLogin && !st.hasServerCopy) return <LoginScreen store={store} pending={st.pending.length} />;
  if (!st.hasServerCopy && st.net === 'unreachable') {
    return (
      <div class="app">
        <Banners st={st} now={now} onLogin={() => setLoginOpen(true)} />
        <p class="note">HOHE needs to reach the server once to load your planner on this device.</p>
        <button class="btn" onClick={() => void store.checkSession()}>
          Try again
        </button>
      </div>
    );
  }

  const doCapture = async () => {
    const title = captureText.trim();
    if (!title) return;
    if (await ctx.act(intents.capture(title), `Saved to the Task Dump: "${title}"`)) setCaptureText('');
  };

  const planPending =
    !s.plannedDays.includes(s.today) &&
    placementsOn(s, s.today).some((p) => p.outcome === null && p.by === 'rollover' && !p.touched);
  const finishPlan = () => void ctx.act(intents.markPlanned(s.today));

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="logo">HOHE</span>
          <StatusChip st={st} conflicts={s.conflicts} now={now} onOpen={() => ctx.go('sync')} />
        </div>
        <form
          class="capture"
          onSubmit={(e) => {
            e.preventDefault();
            void doCapture();
          }}
        >
          <input
            value={captureText}
            aria-label="Capture a task to the Task Dump"
            placeholder="Capture a task… (no letter or day needed)"
            onInput={(e) => setCaptureText((e.target as HTMLInputElement).value)}
          />
          <button class="btn primary" type="submit">
            Capture
          </button>
        </form>
        <nav class="tabs" aria-label="Pages">
          <button class={view === 'today' ? 'on' : ''} onClick={() => ctx.go('today', viewDay)}>
            {viewDay === s.today ? 'Today' : relativeLabel(viewDay, s.today)}
          </button>
          <button class={view === 'dump' ? 'on' : ''} onClick={() => ctx.go('dump')}>
            Task Dump
          </button>
          <button class={view === 'review' ? 'on' : ''} onClick={() => ctx.go('review')}>
            C Review
          </button>
          <button class={view === 'sync' ? 'on' : ''} onClick={() => ctx.go('sync')}>
            Sync
          </button>
          <button class={view === 'settings' ? 'on' : ''} onClick={() => ctx.go('settings')}>
            Settings
          </button>
        </nav>
      </header>

      <Banners st={st} now={now} onLogin={() => setLoginOpen(true)} />
      {updateReady && (
        <div class="banner update" role="status">
          A new version of HOHE is ready. Your changes are kept.{' '}
          <button class="btn small primary" onClick={() => applyUpdate()}>
            Update now
          </button>
        </div>
      )}

      <main>
        <Guard label="This page">
          {view === 'today' && <DayPage ctx={ctx} />}
          {view === 'dump' && <DumpPage ctx={ctx} />}
          {view === 'review' && <ReviewPage ctx={ctx} />}
          {view === 'sync' && (
            <section class="page single">
              <h2>Sync</h2>
              <p>
                <button class="btn" disabled={st.syncing || st.needsLogin} onClick={() => void store.sync()}>
                  {st.syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </p>
              <Guard label="The conflict tray">
                <ConflictTray ctx={ctx} conflicts={s.conflicts} />
              </Guard>
              <Guard label="Rejected actions">
                <AttentionList items={st.attention} onDismiss={(id) => void store.dismissAttention(id)} />
              </Guard>
              <Guard label="Changes waiting to sync">
                <PendingList items={st.pending} now={now} />
              </Guard>
            </section>
          )}
          {view === 'settings' && <SettingsPage ctx={ctx} st={st} store={store} />}
        </Guard>
      </main>

      <footer class="footer muted">
        HOHE {APP_VERSION}
        <button class="btn small quiet" onClick={() => ctx.open({ kind: 'about' })}>
          About
        </button>
      </footer>

      {planPending && view === 'today' && <PlanMyDay ctx={ctx} onFinish={finishPlan} />}
      {dialog && (
        <Guard label="This dialog">
          <DialogHost ctx={ctx} spec={dialog} />
        </Guard>
      )}
      {loginOpen && <LoginSheet store={store} pending={st.pending.length} onDone={() => setLoginOpen(false)} />}

      {toast && (
        <div class={`toast ${toast.error ? 'error' : ''}`} role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              class="btn small"
              onClick={() => {
                const u = toast.undo!;
                setToast(null);
                void ctx.act(u, 'Undone');
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LoginForm(props: { store: Store; pending: number; onDone?: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          await props.store.login(pw);
          setPw('');
          props.onDone?.();
        } catch (x) {
          const kind = x instanceof ApiError ? x.kind : '';
          setErr(
            kind === 'unauthorized'
              ? 'Wrong password.'
              : kind === 'locked'
                ? 'Too many failed attempts. Logins are locked for 15 minutes.'
                : kind === 'unreachable'
                  ? 'Server unreachable. Your changes stay on this device; try again when it is back.'
                  : (x as Error).message,
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {props.pending > 0 && (
        <p class="note">
          {props.pending} {props.pending === 1 ? 'change is' : 'changes are'} saved on this device and will sync after you log in.
        </p>
      )}
      <label class="field">
        Password
        <input type="password" autocomplete="current-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
      </label>
      {err && (
        <p class="note warn" role="alert">
          {err}
        </p>
      )}
      <div class="sheet-actions">
        <button class="btn primary" type="submit" disabled={busy || !pw}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </div>
    </form>
  );
}

function LoginScreen(props: { store: Store; pending: number }) {
  return (
    <div class="app">
      <section class="page single narrow">
        <h1 class="logo">HOHE</h1>
        <LoginForm store={props.store} pending={props.pending} />
      </section>
    </div>
  );
}

function LoginSheet(props: { store: Store; pending: number; onDone: () => void }) {
  return (
    <div class="overlay" onClick={props.onDone}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Log in" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <h2>Log in to sync</h2>
          <button class="icon-btn" aria-label="Close" onClick={props.onDone}>
            ✕
          </button>
        </div>
        <LoginForm store={props.store} pending={props.pending} onDone={props.onDone} />
      </div>
    </div>
  );
}
