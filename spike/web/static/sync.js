// Outbound operation queue: pure functions over plain objects, so they can be unit-tested
// without a browser. The app persists the queue in IndexedDB.

export function newId() {
  return crypto.randomUUID();
}

export function captureOp({ deviceId, title, clientPlannerDay, now = new Date(), id = newId() }) {
  return { id, deviceId, type: "capture", value: title, clientPlannerDay, clientTime: now.toISOString() };
}

/**
 * An edit operation. If an earlier queued (unsent or unacknowledged) edit touches the same
 * task field, this one depends on it instead of naming a base revision: it builds on that edit.
 */
export function editOp({ deviceId, queue, task, field, value, clientPlannerDay, now = new Date(), id = newId(), resolves }) {
  const op = { id, deviceId, type: "edit", taskId: task.id, field, value, clientPlannerDay, clientTime: now.toISOString() };
  const prior = [...queue].reverse().find((q) => q.type === "edit" && q.taskId === task.id && q.field === field);
  if (prior) op.dependsOn = prior.id;
  else op.baseRevision = task.revisions[field];
  if (resolves) op.resolves = resolves;
  return op;
}

/**
 * Apply server results to the queue. Every op the server has decided (applied, noop,
 * conflict, held, rejected) leaves the queue: conflicts and held ops now live in the server's
 * conflict tray. Ops without a result stay queued for the next attempt.
 */
export function applyResults(queue, results) {
  const decided = new Set(results.filter((r) => r && r.opId).map((r) => r.opId));
  return queue.filter((op) => !decided.has(op.id));
}

// Number of later edits held with a conflict. Tolerates a missing or null list, so one odd
// server record can never stop the conflict tray from rendering.
export function heldCount(conflict) {
  return Array.isArray(conflict?.heldOps) ? conflict.heldOps.length : 0;
}

export function syncLabel(queue, online) {
  if (queue.length === 0) return online ? "All synced" : "All synced (offline)";
  return `${queue.length} change${queue.length === 1 ? "" : "s"} waiting to sync`;
}
