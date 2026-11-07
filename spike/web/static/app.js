// HOHE Phase 2 spike client. Synthetic data only.
import { kv } from "./idb.js";
import { plannerDay, defaultTimeZone } from "./plannerday.js";
import { newId, captureOp, editOp, applyResults, syncLabel, heldCount } from "./sync.js";

const $ = (id) => document.getElementById(id);
const state = {
  deviceId: null,
  queue: [],          // pending operations, persisted
  tasks: [],          // last known server tasks, persisted (offline cache)
  conflicts: [],
  settings: { timeZone: "America/New_York", rollover: "03:00", revision: 0 }, // server copy, persisted
  serverPlannerDay: null,
  lastBatch: null,    // the last batch sent, persisted, for the duplicate test
  persisted: "unknown",
  online: navigator.onLine,
  version: "",
  lastResult: "",
};

const text = (s) => document.createTextNode(String(s));
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(typeof k === "string" ? text(k) : k);
  return e;
}

async function save() {
  await kv.set("queue", state.queue);
  await kv.set("tasks", state.tasks);
  await kv.set("settings", state.settings);
  await kv.set("lastBatch", state.lastBatch);
}

const clientDay = () => plannerDay(new Date(), state.settings.timeZone, state.settings.rollover);

// Optimistic local view: server tasks with pending ops applied on top, marked pending.
function view() {
  const tasks = state.tasks.map((t) => ({ ...t, pending: new Set() }));
  for (const op of state.queue) {
    if (op.type === "capture") tasks.push({ id: `local:${op.id}`, title: op.value, plannerDay: op.clientPlannerDay, revisions: {}, local: true, pending: new Set(["title"]) });
    if (op.type === "edit") {
      const t = tasks.find((x) => x.id === op.taskId);
      if (t) { t[op.field] = op.value; t.pending.add(op.field); }
    }
  }
  return tasks;
}

function render() {
  const pending = state.queue.length > 0;
  $("sync-state").textContent = syncLabel(state.queue, state.online && !$("pause-sync").checked);
  $("sync-state").classList.toggle("pending", pending);
  $("planner-day").textContent = `planner day ${clientDay()} (${state.settings.timeZone}, rollover ${state.settings.rollover})`;

  const ul = $("tasks");
  ul.replaceChildren();
  for (const t of view()) {
    const title = el("span", {}, t.title);
    const li = el("li", {}, el("strong", {}, t.priority ? `${t.priority} ` : ""), title, " ");
    if (t.pending.size) li.append(el("span", { class: "pending" }, `⟳ ${[...t.pending].join(", ")} waiting`));
    li.append(el("div", { class: "meta" }, `${t.id} · day ${t.plannerDay || "?"} · title rev ${t.revisions?.title ?? "–"}`));
    if (!t.local) li.append(el("button", { type: "button", onclick: () => editTitle(t) }, "Edit title"));
    ul.append(li);
  }

  const cl = $("conflicts");
  cl.replaceChildren();
  const open = state.conflicts.filter((c) => c.status === "open");
  if (!open.length) cl.append(el("li", { class: "muted" }, "Nothing waiting."));
  for (const c of open) {
    cl.append(el("li", { class: "conflict" },
      el("div", {}, `Task ${c.taskId}, field ${c.field}`),
      el("div", {}, "Server (kept): ", el("strong", {}, c.serverValue), ` (rev ${c.serverRevision})`),
      el("div", {}, "Your edit: ", el("strong", {}, c.proposedValue), ` (based on rev ${c.baseRevision})`),
      heldCount(c) ? el("div", { class: "meta" }, `${heldCount(c)} later edit(s) held with it`) : "",
      el("button", { type: "button", onclick: () => keepServer(c) }, "Keep server value"), " ",
      el("button", { type: "button", onclick: () => useMine(c) }, "Use mine")));
  }

  const now = new Date();
  const diag = {
    "Version": state.version || "(offline)",
    "Device id": state.deviceId,
    "Installed (standalone)": String(window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true),
    "Persistent storage": state.persisted,
    "Browser default time zone": defaultTimeZone(),
    "Explicit time zone (server setting)": state.settings.timeZone,
    "Client planner day (explicit zone)": clientDay(),
    "Server planner day (last seen)": state.serverPlannerDay || "(not yet)",
    "Device clock": now.toISOString(),
    "Online (navigator)": String(state.online),
    "Pending ops": String(state.queue.length),
  };
  const dl = $("diag");
  dl.replaceChildren();
  for (const [k, v] of Object.entries(diag)) dl.append(el("dt", {}, k), el("dd", {}, v));
  $("last-result").textContent = state.lastResult;
  $("footer").textContent = `HOHE spike ${state.version || ""} — synthetic, in-memory server data; it is lost whenever the server container is recreated.`;
}

async function enqueue(op) {
  state.queue.push(op);
  await save();
  render();
  sync();
}

function editTitle(t) {
  const v = prompt("New title (synthetic)", t.title);
  if (v === null || !v.trim()) return;
  const server = state.tasks.find((x) => x.id === t.id);
  enqueue(editOp({ deviceId: state.deviceId, queue: state.queue, task: server, field: "title", value: v.trim(), clientPlannerDay: clientDay() }));
}

async function keepServer(c) {
  const r = await fetch(`/api/conflicts/${encodeURIComponent(c.id)}/keep-server`, { method: "POST" });
  state.lastResult = r.ok ? `Kept the server value for ${c.taskId}.` : `Keep server failed: ${r.status}`;
  await refresh();
}

function useMine(c) {
  const task = state.tasks.find((t) => t.id === c.taskId);
  // A new operation against the CURRENT revision, marked as resolving the conflict.
  enqueue(editOp({ deviceId: state.deviceId, queue: [], task, field: c.field, value: c.proposedValue, clientPlannerDay: clientDay(), resolves: c.id }));
}

let syncing = false;
async function send(batch) {
  const r = await fetch("/api/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops: batch }) });
  if (!r.ok) throw new Error(`ops: HTTP ${r.status}`);
  return (await r.json()).results;
}

async function sync() {
  if (syncing || $("pause-sync").checked || state.queue.length === 0) return;
  syncing = true;
  const batch = state.queue.slice();
  try {
    const results = await send(batch);
    state.lastBatch = batch;
    state.queue = applyResults(state.queue, results);
    const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    const mism = results.filter((r) => r.plannerDayMismatch).length;
    state.lastResult = `Sent ${batch.length}: ${JSON.stringify(counts)}${mism ? `, ${mism} planner-day mismatch` : ""}.`;
    await save();
    await refresh();
  } catch (e) {
    state.lastResult = `Sync failed (${e.message}); ${state.queue.length} kept for retry.`;
    render();
  } finally {
    syncing = false;
  }
}

async function replayLast() {
  if (!state.lastBatch?.length) { state.lastResult = "No batch sent yet."; render(); return; }
  try {
    const results = await send(state.lastBatch);
    const replayed = results.filter((r) => r.replayed).length;
    state.lastResult = `Resent ${state.lastBatch.length} op(s): ${replayed} recognised as duplicates (replayed=true); nothing applied twice.`;
    await refresh();
  } catch (e) {
    state.lastResult = `Resend failed: ${e.message}`;
    render();
  }
}

async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    state.tasks = s.tasks;
    state.conflicts = s.conflicts;
    state.settings = s.settings;
    state.serverPlannerDay = s.serverPlannerDay;
    state.version = s.version;
    await save();
  } catch (e) {
    state.lastResult ||= `Offline: showing the cached copy (${e.message}).`;
  }
  render();
}

async function init() {
  state.deviceId = (await kv.get("deviceId")) || newId();
  await kv.set("deviceId", state.deviceId);
  state.queue = (await kv.get("queue")) || [];
  state.tasks = (await kv.get("tasks")) || [];
  state.settings = (await kv.get("settings")) || state.settings;
  state.lastBatch = (await kv.get("lastBatch")) || null;
  if (navigator.storage?.persist) {
    const granted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    state.persisted = granted ? "granted" : "not granted";
  } else {
    state.persisted = "API unavailable";
  }
  $("capture").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("capture-title").value.trim();
    if (!title) return;
    $("capture-title").value = "";
    enqueue(captureOp({ deviceId: state.deviceId, title, clientPlannerDay: clientDay() }));
  });
  $("sync-now").addEventListener("click", sync);
  $("replay-last").addEventListener("click", replayLast);
  $("refresh").addEventListener("click", refresh);
  $("pause-sync").addEventListener("change", () => { render(); sync(); });
  window.addEventListener("online", () => { state.online = true; sync(); });
  window.addEventListener("offline", () => { state.online = false; render(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh().then(sync); } });
  setInterval(() => { render(); sync(); }, 20000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  render();
  await refresh();
  sync();
}

init();
