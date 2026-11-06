// App shell: capture bar, navigation, demo controls, persistence and undo.

import { useEffect, useState } from 'preact/hooks';
import { currentPlannerDay, relativeLabel, shortLabel, type Day } from './dates';
import type { Ctx, DialogSpec, View } from './ctx';
import { DayPage } from './day';
import { DialogHost } from './dialogs';
import { DumpPage, PlanMyDay, ReviewPage } from './lists';
import { capture, placementsOn, rollover, type State } from './model';
import { buildSeed, STATE_VERSION } from './seed';

const STORAGE_KEY = 'hohe-prototype';

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s.version === STATE_VERSION) return s;
    }
  } catch {
    // Corrupt or blocked storage: fall back to fresh demo data.
  }
  return buildSeed(currentPlannerDay());
}

interface Toast {
  message: string;
  undo?: State;
}

export function App() {
  const [s, setS] = useState<State>(load);
  const [view, setView] = useState<View>('today');
  const [viewDay, setViewDay] = useState<Day>(s.today);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [captureText, setCaptureText] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // Storage may be unavailable (private mode); the demo still works in memory.
    }
  }, [s]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const planPending =
    !s.plannedDays.includes(s.today) &&
    placementsOn(s, s.today).some((p) => p.outcome === null && p.by === 'rollover' && !p.touched);

  const ctx: Ctx = {
    s,
    viewDay,
    act: (fn, message, keepOpen) => {
      const before = s;
      const after = fn(s);
      setS(after);
      if (!keepOpen) setDialog(null);
      if (message) setToast({ message, undo: before });
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

  const doCapture = () => {
    const title = captureText.trim();
    if (!title) return;
    setCaptureText('');
    ctx.act((st) => capture(st, title), `Saved to the Task Dump: "${title}"`);
  };

  const nextDay = () => {
    const after = rollover(s);
    setS(after);
    setViewDay(after.today);
    setView('today');
    setToast({ message: `Rolled over to ${shortLabel(after.today)}. Unfinished tasks carried automatically.`, undo: s });
  };

  const reset = () => {
    if (!confirm('Reset the demo? This replaces every change with fresh synthetic tasks.')) return;
    const fresh = buildSeed(currentPlannerDay());
    setS(fresh);
    setViewDay(fresh.today);
    setView('today');
    setToast({ message: 'Demo data reset' });
  };

  const finishPlan = () => setS({ ...s, plannedDays: [...s.plannedDays, s.today] });

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="logo">HOHE</span>
          <span class="tag">visual prototype · synthetic tasks</span>
        </div>
        <form
          class="capture"
          onSubmit={(e) => {
            e.preventDefault();
            doCapture();
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
        </nav>
      </header>

      <div class="demo-bar" aria-label="Demo controls">
        <span class="muted">Demo:</span>
        <button class="btn small" onClick={() => setS({ ...s, plannedDays: s.plannedDays.filter((d) => d !== s.today) })}>
          Plan my day
        </button>
        <button class="btn small" onClick={nextDay}>
          Next day (simulate rollover)
        </button>
        <button class="btn small" onClick={reset}>
          Reset demo
        </button>
        <button class="btn small quiet" onClick={() => ctx.open({ kind: 'about' })}>
          About
        </button>
      </div>

      <main>
        {view === 'today' && <DayPage ctx={ctx} />}
        {view === 'dump' && <DumpPage ctx={ctx} />}
        {view === 'review' && <ReviewPage ctx={ctx} />}
      </main>

      {planPending && view === 'today' && <PlanMyDay ctx={ctx} onFinish={finishPlan} />}
      {dialog && <DialogHost ctx={ctx} spec={dialog} />}

      {toast && (
        <div class="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              class="btn small"
              onClick={() => {
                setS(toast.undo!);
                setViewDay(toast.undo!.today < viewDay ? toast.undo!.today : viewDay);
                setToast(null);
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
