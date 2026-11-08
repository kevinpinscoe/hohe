// The client controller: what the UI reads and the actions it calls.
//
// State lives in IndexedDB (db.ts); this keeps an in-memory copy for rendering, reloads it
// whenever this tab or another one changes it (BroadcastChannel "hohe"), and schedules syncs.

import { api, ApiError } from './api';
import { plannerDay, type Day } from './dates';
import * as db from './db';
import { buildCtx, editBaseline, IntentError, type Baseline, type Intent } from './intents';
import { displayState, emptyState, fromServer, pendingByTask, type QueuedOp } from './local';
import type { State } from './model';
import type { Build } from './server';
import { syncNow, withSyncLockWaiting, type SyncOutcome } from './sync';

export type Net = 'unknown' | 'ok' | 'unreachable' | 'server-error' | 'refused';

export interface Status {
  loaded: boolean;
  hasServerCopy: boolean; // a confirmed state exists on this device
  net: Net;
  netMessage: string;
  needsLogin: boolean;
  syncing: boolean;
  lastSyncAt: number | null; // last successful exchange with the server
  pending: QueuedOp[];
  attention: db.Attention[];
  storageError: string | null;
  serverBuild: Build | null;
}

export interface Snapshot {
  status: Status;
  today: Day;
  confirmed: State;
  view: State; // confirmed + pending
  pendingTasks: Map<string, number>; // taskId -> oldest pending change (ms)
}

type Listener = () => void;

const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const IDLE_SYNC_MS = 60_000;

export class Store {
  private listeners = new Set<Listener>();
  private snap: db.Snapshot = { confirmed: null, pending: [], attention: [], deviceId: null, placementMap: {}, epoch: 0 };
  private deviceIdP: Promise<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private chan: BroadcastChannel | null = null;
  status: Status = {
    loaded: false,
    hasServerCopy: false,
    net: 'unknown',
    netMessage: '',
    needsLogin: false,
    syncing: false,
    lastSyncAt: null,
    pending: [],
    attention: [],
    storageError: null,
    serverBuild: null,
  };
  current: Snapshot;

  constructor(private now: () => Date = () => new Date()) {
    this.current = this.compute();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start() {
    try {
      this.chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('hohe') : null;
      if (this.chan)
        this.chan.onmessage = (e: MessageEvent) => {
          // Another tab logged out or cleared the device: stop syncing here too.
          if (e.data === 'logged-out') this.loggedOutElsewhere();
          void this.reload();
        };
    } catch {
      this.chan = null;
    }
    try {
      this.deviceIdP = db.deviceId();
      await this.deviceIdP;
      await this.reload();
    } catch (e) {
      this.set({ storageError: `This device's storage is unavailable: ${(e as Error).message}`, loaded: true });
      return;
    }
    this.set({ loaded: true });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.schedule(0));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.schedule(0);
      });
    }
    await this.checkSession();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<Status>) {
    this.status = { ...this.status, ...p };
    this.current = this.compute();
    for (const l of this.listeners) l();
  }

  private compute(): Snapshot {
    const settings = this.snap.confirmed?.view.settings;
    const today = plannerDay(this.now(), settings?.timeZone || 'America/New_York', settings?.rollover || '03:00');
    // The server's day wins when it is ahead (proposal §11.5).
    const serverDay = this.snap.confirmed?.view.serverPlannerDay ?? '';
    const day = serverDay > today ? serverDay : today;
    const confirmed = this.snap.confirmed ? fromServer(this.snap.confirmed.view, day) : emptyState(day);
    return { status: this.status, today: day, confirmed, view: displayState(confirmed, this.snap.pending), pendingTasks: pendingByTask(this.snap.pending) };
  }

  /** Re-read IndexedDB (after this tab or another one changed it). */
  async reload() {
    this.snap = await db.readAll();
    this.set({ pending: this.snap.pending, attention: this.snap.attention, hasServerCopy: !!this.snap.confirmed });
  }

  private announce(msg: 'changed' | 'logged-out' = 'changed') {
    try {
      this.chan?.postMessage(msg);
    } catch {
      /* the other tabs reload on focus instead */
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  /**
   * Queue an action. Resolves after it is stored on this device; throws (and stores nothing)
   * if the write fails or the action is not possible, so the caller can keep the user's input.
   */
  async act(intent: Intent): Promise<void> {
    const today = this.current.today;
    try {
      await db.enqueue((s) => intent(buildCtx(s, today)));
    } catch (e) {
      if (e instanceof IntentError) throw e;
      const msg = `Not saved: this device could not store the change (${(e as Error).message}).`;
      this.set({ storageError: msg });
      throw new Error(msg);
    }
    await this.reload();
    this.announce();
    this.schedule(300);
  }

  /** Arrange a sync after `ms`. */
  schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), ms);
  }

  private nextDelay(): number {
    if (this.status.needsLogin) return IDLE_SYNC_MS * 5;
    if (this.status.net === 'ok') return IDLE_SYNC_MS;
    return RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
  }

  async sync(): Promise<SyncOutcome | null> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.status.needsLogin || this.leaving || !this.deviceIdP) {
      this.timer = setTimeout(() => void this.sync(), this.nextDelay());
      return null;
    }
    this.set({ syncing: true });
    const r = await syncNow(await this.deviceIdP);
    await this.reload();
    this.applyOutcome(r);
    this.announce();
    this.timer = setTimeout(() => void this.sync(), this.nextDelay());
    return r;
  }

  private applyOutcome(r: SyncOutcome) {
    const p: Partial<Status> = { syncing: false };
    switch (r.kind) {
      case 'ok':
        this.failures = 0;
        Object.assign(p, { net: 'ok', netMessage: '', lastSyncAt: Date.now(), storageError: null });
        break;
      case 'busy':
        break; // another tab is syncing; its broadcast reloads this one
      case 'unauthorized':
        Object.assign(p, { needsLogin: true, net: 'ok', netMessage: '' });
        break;
      case 'unreachable':
        this.failures++;
        Object.assign(p, { net: 'unreachable', netMessage: r.message ?? '' });
        break;
      case 'server':
        this.failures++;
        Object.assign(p, { net: 'server-error', netMessage: r.message ?? '' });
        break;
      case 'refused':
        this.failures++;
        Object.assign(p, { net: 'refused', netMessage: r.message ?? '' });
        break;
      case 'storage':
        Object.assign(p, { storageError: r.message ?? 'storage error' });
        break;
      case 'cleared':
        break; // the device was cleared mid-request; the answer was not stored
    }
    this.lastOutcome = r;
    this.set(p);
  }

  lastOutcome: SyncOutcome | null = null;

  async checkSession() {
    try {
      const r = await api.session();
      this.set({ needsLogin: !r.loggedIn, net: 'ok', netMessage: '', serverBuild: r.build });
      if (r.loggedIn) await this.sync();
      else this.schedule(this.nextDelay());
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      this.failures++;
      this.set({ net: 'unreachable', netMessage: msg });
      this.schedule(this.nextDelay());
    }
  }

  /** Log in, then resume syncing whatever is queued. The queue is never cleared by a login. */
  async login(password: string): Promise<void> {
    const device = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 60) : 'device';
    await api.login(password, device);
    this.set({ needsLogin: false });
    if (navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        /* reported in Settings */
      }
    }
    await this.sync();
  }

  /**
   * Log out ('logout') or log out and forget this device ('clear').
   *
   * Runs under the device-wide sync lock, so it waits for any sync in any tab to finish and no
   * sync can start until it is done. Immediately before clearing it rechecks what is
   * outstanding: if a pending change or rejected action exists that is not in `confirmedIds`
   * (another tab added it after Kevin confirmed), nothing is cleared and the caller must ask
   * again with the new counts. Clearing moves the epoch on, so a late sync answer is never
   * stored. Every other tab is told to stop syncing and ask for login.
   */
  async leave(mode: 'logout' | 'clear', confirmedIds: Set<string>): Promise<db.ClearResult> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.leaving = true;
    try {
      const r = await withSyncLockWaiting(() => db.clearDeviceIfConfirmed(confirmedIds, mode === 'logout'));
      if (!r.cleared) {
        await this.reload();
        return r;
      }
      try {
        await api.logout();
      } catch {
        // Offline: the server session lasts until it expires. The device's data is gone regardless.
      }
      this.deviceIdP = db.deviceId();
      await this.deviceIdP;
      await this.reload();
      this.set({ needsLogin: true, lastSyncAt: null });
      this.announce('logged-out');
      return r;
    } finally {
      this.leaving = false;
      if (!this.status.needsLogin) this.schedule(this.nextDelay());
    }
  }

  private leaving = false;

  private loggedOutElsewhere() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.set({ needsLogin: true, lastSyncAt: null });
  }

  /** The baseline an edit dialog keeps from the moment it opens (values and revisions). */
  editBaseline(taskId: string, fields: string[]): Baseline {
    return editBaseline(buildCtx(this.snap, this.current.today), taskId, fields);
  }

  async dismissAttention(id: string) {
    await db.dismissAttention(id);
    await this.reload();
    this.announce();
  }

  /** Pending changes and rejected actions as a JSON document, for "Export pending changes". */
  async exportPending(): Promise<string> {
    this.snap = await db.readAll(); // fresh: another tab may have added work
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        deviceId: this.snap.deviceId,
        note: 'pending: saved on this device, not yet on the server. rejected: refused by the server and NOT applied; each entry keeps the full operation.',
        pending: this.snap.pending,
        rejected: this.snap.attention,
      },
      null,
      2,
    );
  }

  /** Recompute "today" (call once a minute so the day turns over while the app is open). */
  tick() {
    this.set({});
  }
}

export { IntentError };
