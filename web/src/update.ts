// Service-worker registration and the update prompt.
//
// A new version installs in the background and then WAITS. HOHE never reloads on its own: it
// shows "Update available", and only Kevin's click activates the new worker and reloads.
// IndexedDB is untouched by an update, so pending changes survive it.

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

type Listener = (ready: boolean) => void;

let waiting: ServiceWorker | null = null;
let userAsked = false;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) l(waiting !== null);
}

export function onUpdateReady(fn: Listener): () => void {
  listeners.add(fn);
  fn(waiting !== null);
  return () => listeners.delete(fn);
}

function track(reg: ServiceWorkerRegistration) {
  const consider = (w: ServiceWorker | null) => {
    // Only an update counts: with no controller this is the first install, nothing to prompt.
    if (w && navigator.serviceWorker.controller) {
      waiting = w;
      notify();
    }
  };
  if (reg.waiting) consider(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener('statechange', () => {
      if (w.state === 'installed') consider(reg.waiting ?? w);
    });
  });
}

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  // Reload only after Kevin asked for the update. A controller change that he did not ask for
  // (the first install claiming the page, or the spike's worker being replaced) never reloads.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAsked) location.reload();
  });
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    track(reg);
    const check = () => void reg.update().catch(() => undefined);
    setInterval(check, 30 * 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch {
    // No worker (private mode, or the server is unreachable on first load): HOHE still runs.
  }
}

/** Activate the waiting version and reload. Called only from the update prompt's button. */
export function applyUpdate() {
  if (!waiting) return;
  userAsked = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}
