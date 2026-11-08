// IndexedDB: the device's copy of the server state and its queue of pending operations.
//
// Rules this file keeps:
// - An operation is shown as saved on this device only after the transaction that writes it
//   has completed (`enqueue` resolves on `complete`, and rejects if the write fails).
// - The confirmed server state and the queue are separate stores. Refreshing the state never
//   touches the queue, and acknowledging ops and storing the state that results from them
//   happen in one transaction, so a reader never sees one without the other.
// - The database is never deleted or downgraded by an update. A later schema version must
//   migrate in `onupgradeneeded`, keeping every store's data.
// - It is a different database from the Phase 2 spike's ("hohe-spike"), which is left alone.

import type { QueuedOp } from './local';
import type { SrvView } from './server';

export const DB_NAME = 'hohe';
export const DB_VERSION = 1;

export interface Confirmed {
  view: SrvView;
  at: number; // when the server sent it
}

/** Where a local placement id now points: the server's id, or how to find it. */
export type PlacementTarget = string | { taskId: string; day: string };

export interface Attention {
  id: string; // the op id
  q: QueuedOp;
  status: 'rejected';
  reason: string;
  at: number;
}

export interface Snapshot {
  confirmed: Confirmed | null;
  pending: QueuedOp[];
  attention: Attention[];
  deviceId: string | null;
  placementMap: Record<string, PlacementTarget>;
}

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      // Version 1. Later versions add migrations here; they never drop a store.
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('attention')) db.createObjectStore('attention', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab opening a newer schema asks this one to let go; it reloads on its own terms.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => {
      dbp = null;
      reject(r.error ?? new Error('IndexedDB could not be opened'));
    };
    r.onblocked = () => {
      /* waits for the other tab to close its connection */
    };
  });
  return dbp;
}

/** Forget the open connection (tests, and after clearing the device). */
export function resetDbHandle() {
  dbp = null;
}

const STORES = ['meta', 'ops', 'attention'] as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function readIn(tx: IDBTransaction): Promise<Snapshot> {
  const meta = tx.objectStore('meta');
  const [confirmed, deviceId, placementMap, pending, attention] = await Promise.all([
    req(meta.get('confirmed')),
    req(meta.get('deviceId')),
    req(meta.get('placementMap')),
    req(tx.objectStore('ops').getAll()),
    req(tx.objectStore('attention').getAll()),
  ]);
  return {
    confirmed: (confirmed as Confirmed | undefined) ?? null,
    deviceId: (deviceId as string | undefined) ?? null,
    placementMap: (placementMap as Record<string, PlacementTarget> | undefined) ?? {},
    pending: (pending as QueuedOp[]).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    attention: (attention as Attention[]).sort((a, b) => a.at - b.at),
  };
}

export async function readAll(): Promise<Snapshot> {
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readonly');
  const out = readIn(tx);
  await done(tx);
  return out;
}

/** The device id, created once and kept until the device is cleared. */
export async function deviceId(): Promise<string> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  let id = (await req(store.get('deviceId'))) as string | undefined;
  if (!id) {
    id = crypto.randomUUID();
    store.put(id, 'deviceId');
  }
  await done(tx);
  return id;
}

/**
 * Queue operations. `build` runs inside the write transaction with a consistent snapshot of
 * the confirmed state and the queue, so the dependencies it computes cannot race another tab.
 * Resolves only after the transaction has committed; rejects (and stores nothing) otherwise.
 */
export async function enqueue(build: (snap: Snapshot) => QueuedOp[]): Promise<QueuedOp[]> {
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readwrite');
  const finished = done(tx);
  let added: QueuedOp[] = [];
  try {
    const snap = await readIn(tx);
    added = build(snap);
    const ops = tx.objectStore('ops');
    const keys = await Promise.all(added.map((q) => req(ops.add(q))));
    added = added.map((q, i) => ({ ...q, seq: keys[i] as number }));
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    await finished.catch(() => undefined);
    throw e;
  }
  await finished;
  return added;
}

export async function saveConfirmed(view: SrvView): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ view, at: Date.now() } satisfies Confirmed, 'confirmed');
  await done(tx);
}

export interface SyncCommit {
  acknowledged: number[]; // seqs the server answered
  rejected: Attention[];
  placementMap: Record<string, PlacementTarget>;
  view: SrvView;
}

/** Record a sync answer atomically: drop answered ops, keep rejections, save the new state. */
export async function commitSync(c: SyncCommit): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readwrite');
  const ops = tx.objectStore('ops');
  for (const seq of c.acknowledged) ops.delete(seq);
  const att = tx.objectStore('attention');
  for (const a of c.rejected) att.put(a);
  const meta = tx.objectStore('meta');
  meta.put(c.placementMap, 'placementMap');
  meta.put({ view: c.view, at: Date.now() } satisfies Confirmed, 'confirmed');
  await done(tx);
}

/** Move one queued op to the attention list without sending it (it cannot be sent as is). */
export async function rejectLocally(q: QueuedOp, reason: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['ops', 'attention'], 'readwrite');
  if (q.seq !== undefined) tx.objectStore('ops').delete(q.seq);
  tx.objectStore('attention').put({ id: q.op.id, q, status: 'rejected', reason, at: Date.now() } satisfies Attention);
  await done(tx);
}

export async function dismissAttention(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('attention', 'readwrite');
  tx.objectStore('attention').delete(id);
  await done(tx);
}

/** Discard pending ops by seq (only after Kevin confirmed, naming the count). */
export async function discardPending(seqs: number[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('ops', 'readwrite');
  for (const s of seqs) tx.objectStore('ops').delete(s);
  await done(tx);
}

/** Clear everything on this device (logout, "Clear this device"). */
export async function clearDevice(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  await done(tx);
}
