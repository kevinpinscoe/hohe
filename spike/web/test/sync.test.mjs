import test from "node:test";
import assert from "node:assert/strict";
import { captureOp, editOp, applyResults, syncLabel, heldCount } from "../static/sync.js";

const task = { id: "seed-1", revisions: { title: 3, notes: 1, priority: 1 } };

test("capture carries a unique id and the client planner day", () => {
  const a = captureOp({ deviceId: "d", title: "x", clientPlannerDay: "2026-11-06" });
  const b = captureOp({ deviceId: "d", title: "x", clientPlannerDay: "2026-11-06" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.clientPlannerDay, "2026-11-06");
});

test("first edit names the base revision; a later same-field edit depends on it", () => {
  const q = [];
  const e1 = editOp({ deviceId: "d", queue: q, task, field: "title", value: "v1" });
  assert.equal(e1.baseRevision, 3);
  assert.equal(e1.dependsOn, undefined);
  q.push(e1);
  const e2 = editOp({ deviceId: "d", queue: q, task, field: "title", value: "v2" });
  assert.equal(e2.dependsOn, e1.id);
  assert.equal(e2.baseRevision, undefined);
  const e3 = editOp({ deviceId: "d", queue: q, task, field: "notes", value: "n" });
  assert.equal(e3.baseRevision, 1);
});

test("decided ops leave the queue; undecided ops stay", () => {
  const q = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const left = applyResults(q, [{ opId: "a", status: "applied" }, { opId: "b", status: "conflict" }]);
  assert.deepEqual(left.map((o) => o.id), ["c"]);
});

test("sync label", () => {
  assert.equal(syncLabel([], true), "All synced");
  assert.equal(syncLabel([{}, {}, {}], false), "3 changes waiting to sync");
});

test("heldCount tolerates a null or missing held-edit list", () => {
  assert.equal(heldCount({ heldOps: null }), 0);
  assert.equal(heldCount({}), 0);
  assert.equal(heldCount(undefined), 0);
  assert.equal(heldCount({ heldOps: [] }), 0);
  assert.equal(heldCount({ heldOps: [{ id: "a" }, { id: "b" }] }), 2);
});
