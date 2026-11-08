// Browser tests against the real Go server, with synthetic data only.
// These are automated Chromium results; physical iPhone checks are recorded separately.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { cleanup, Hohe, PASSWORD } from './harness';

const PORT = 18089;
let srv: Hohe;
let n = 0;

test.beforeEach(async () => {
  srv = new Hohe(PORT, `t${++n}`);
  await srv.start('e2e-1');
});
test.afterEach(async () => {
  await srv.stop();
});
test.afterAll(() => cleanup());

const chip = (p: Page) => p.locator('.sync-chip');

async function login(p: Page) {
  await p.goto(srv.url);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Log in' }).click();
  await expect(chip(p)).toHaveText('All synced');
}

/** Offline loading needs the service worker installed and its shell cached first. */
async function waitForOfflineShell(p: Page) {
  await p.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => p.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('hohe-app-'))), { timeout: 20_000 }).toBe(true);
}

async function capture(p: Page, title: string) {
  await p.getByLabel('Capture a task to the Task Dump').fill(title);
  await p.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(p.locator('.toast')).toContainText(`Saved to the Task Dump: "${title}"`);
}

async function syncNow(p: Page) {
  await p.getByRole('button', { name: 'Sync', exact: true }).click();
  await p.getByRole('button', { name: 'Sync now' }).click();
}

/** Make /api/sync fail as if the server were unreachable, for this context only. */
async function blockSync(ctx: BrowserContext) {
  await ctx.route('**/api/sync', (r) => r.abort('connectionrefused'));
}

async function openDumpRow(p: Page, title: string) {
  await p.getByRole('button', { name: 'Task Dump' }).click();
  await p.getByRole('tab', { name: /All open/ }).click();
  await p.getByRole('button', { name: `Actions for ${title}` }).click();
}

test('capture offline → edit → assign B1 → reload → reconnect', async ({ page }) => {
  await login(page);
  await waitForOfflineShell(page);
  await srv.stop();

  await capture(page, 'Renew passport');
  await expect(page.getByRole('alert').filter({ hasText: 'Server unreachable.' })).toBeVisible();
  await expect(chip(page)).toContainText('1 change waiting to sync (oldest under a minute)');

  await openDumpRow(page, 'Renew passport');
  await page.getByRole('button', { name: /Edit…/ }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Title' }).fill('Renew passport (form DS-82)');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('tab', { name: /Captured/ }).click();
  await page.getByRole('button', { name: 'Assign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'B · important' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

  await page.getByRole('button', { name: 'Today', exact: true }).first().click();
  await page.getByRole('button', { name: /^Priority B\./ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'B1', exact: true }).click();
  await expect(page.locator('.pdtl')).toContainText('B1');
  await expect(page.locator('.pdtl')).toContainText('Renew passport (form DS-82)');
  await expect(page.locator('.pdtl')).toContainText('waiting to sync');
  await expect(chip(page)).toContainText('5 changes waiting to sync');

  // A refresh while the server is down loses nothing: the shell comes from the service
  // worker, the queue from IndexedDB.
  await page.reload();
  await expect(page.locator('.pdtl')).toContainText('Renew passport (form DS-82)');
  await expect(chip(page)).toContainText('5 changes waiting to sync');

  await srv.start('e2e-1');
  await syncNow(page);
  await expect(chip(page)).toHaveText('All synced');

  const st = await srv.serverState();
  const t = st.tasks.find((x) => x.title === 'Renew passport (form DS-82)');
  expect(t, 'task on the server').toBeTruthy();
  expect(t!.priority).toBe('B');
  expect(st.tasks.filter((x) => x.title.startsWith('Renew passport'))).toHaveLength(1);
  const pl = st.placements.find((p) => p.taskId === t!.id && p.outcome === '');
  expect(pl).toMatchObject({ letter: 'B', rank: 1 });
});

test('an expired session keeps the queue, asks for login, then syncs', async ({ page, context }) => {
  await login(page);
  await srv.stop();
  await capture(page, 'Written while logged out');
  await context.clearCookies(); // the session is gone, as after expiry
  await srv.start('e2e-1');
  await syncNow(page);
  const banner = page.getByRole('alert').filter({ hasText: 'Log in to sync.' });
  await expect(banner).toContainText('1 change is kept on this device until then.');
  await expect(chip(page)).toContainText('1 change waiting to sync');
  await banner.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('dialog', { name: 'Log in' }).getByLabel('Password').fill(PASSWORD);
  await page.getByRole('dialog', { name: 'Log in' }).getByRole('button', { name: 'Log in' }).click();
  await expect(chip(page)).toHaveText('All synced');
  const st = await srv.serverState();
  expect(st.tasks.filter((t) => t.title === 'Written while logged out')).toHaveLength(1);
});

test('two tabs never send the queue at the same time, and nothing is applied twice', async ({ context }) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  await context.route('**/api/sync', async (r) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 1200)); // a slow server makes overlap likely
    try {
      await r.continue();
    } finally {
      inFlight--;
    }
  });
  const a = await context.newPage();
  await login(a);
  const b = await context.newPage();
  await b.goto(srv.url);
  await expect(chip(b)).toHaveText('All synced');

  await capture(a, 'From tab A');
  await capture(b, 'From tab B');
  await Promise.all([syncNow(a), syncNow(b)]);
  await capture(a, 'From tab A again');
  await Promise.all([syncNow(a), syncNow(b)]);
  await expect(chip(a)).toHaveText('All synced', { timeout: 20_000 });
  await expect(chip(b)).toHaveText('All synced', { timeout: 20_000 });

  expect(maxInFlight, 'concurrent /api/sync requests').toBe(1);
  expect(calls).toBeGreaterThan(0);
  const st = await srv.serverState();
  for (const title of ['From tab A', 'From tab B', 'From tab A again']) {
    expect(st.tasks.filter((t) => t.title === title), title).toHaveLength(1);
  }
});

test('closing the app during a sync request loses nothing and duplicates nothing', async ({ context }) => {
  const p = await context.newPage();
  await login(p);
  let first = true;
  let applied!: () => void;
  const appliedP = new Promise<void>((r) => (applied = r));
  await context.route('**/api/sync', async (r) => {
    if (!first) return r.continue();
    first = false;
    await r.fetch(); // the server applies the batch…
    applied();
    // …and the answer never reaches the app, which is closed below.
  });
  await capture(p, 'Closed mid-request');
  await appliedP;
  await p.close();

  const again = await context.newPage();
  await again.goto(srv.url);
  await expect(chip(again)).toHaveText('All synced');
  const st = await srv.serverState();
  expect(st.tasks.filter((t) => t.title === 'Closed mid-request')).toHaveLength(1);
  await again.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(again.getByText('Nothing was rejected.')).toBeVisible();
});

test('a stale same-field edit goes to the conflict tray: Keep server, then Use mine', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a);
  await capture(a, 'Conflict me');
  await expect(chip(a)).toHaveText('All synced');
  await login(b);

  for (const round of [
    { choice: 'Keep server', expected: 'Title from A (1)' },
    { choice: 'Use mine', expected: 'Title from B (2)' },
  ]) {
    const n = round.choice === 'Keep server' ? 1 : 2;
    const current = n === 1 ? 'Conflict me' : 'Title from A (1)';
    await syncNow(b);
    await expect(chip(b)).toHaveText('All synced');
    await blockSync(ctxB);
    await openDumpRow(b, current);
    await b.getByRole('button', { name: /Edit…/ }).click();
    await b.getByRole('dialog').getByRole('textbox', { name: 'Title' }).fill(`Title from B (${n})`);
    await b.getByRole('button', { name: 'Save' }).click();

    await openDumpRow(a, current);
    await a.getByRole('button', { name: /Edit…/ }).click();
    await a.getByRole('dialog').getByRole('textbox', { name: 'Title' }).fill(`Title from A (${n})`);
    await a.getByRole('button', { name: 'Save' }).click();
    // A's edit must be on the server before B's stale one arrives.
    await expect
      .poll(async () => (await srv.serverState()).tasks.some((t) => t.title === `Title from A (${n})`), { timeout: 15_000 })
      .toBe(true);

    await ctxB.unroute('**/api/sync');
    await syncNow(b);
    await expect(chip(b)).toHaveText('1 conflict needs a choice');
    const tray = b.getByRole('region', { name: 'Conflict tray' });
    await expect(tray).toContainText(`Title from A (${n})`);
    await expect(tray).toContainText(`Title from B (${n})`);
    await expect(tray.getByRole('button', { name: 'Keep server' })).toBeVisible();
    await tray.getByRole('button', { name: round.choice }).click();
    await expect(tray).toContainText('No conflicts.');
    await expect(chip(b)).toHaveText('All synced');
    const st = await srv.serverState();
    expect(st.tasks.find((t) => t.title.startsWith('Title from') || t.title === 'Conflict me')!.title).toBe(round.expected);
    expect(st.conflicts).toHaveLength(0);
  }
  await ctxA.close();
  await ctxB.close();
});

test('Settings shows the running version and the real persistent-storage answer', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('This app:')).toContainText('e2e-1');
  await expect(page.getByText('Server:')).toContainText('e2e-1 (e2e)');
  const real = await page.evaluate(() => navigator.storage.persisted());
  await expect(page.getByTestId('persist-result')).toHaveText(real ? /^Persistent/ : /^Not persistent/);
});

test('an update is offered, never forced, and keeps pending changes', async ({ page, context }) => {
  await login(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 42));

  await blockSync(context);
  await capture(page, 'Survives the update');
  await page.getByLabel('Capture a task to the Task Dump').fill('half-typed draft');

  await srv.stop();
  await srv.start('e2e-2');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  const prompt = page.getByRole('status').filter({ hasText: 'A new version of HOHE is ready.' });
  await expect(prompt).toBeVisible();

  // Nothing reloaded under the edit.
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);
  await expect(page.getByLabel('Capture a task to the Task Dump')).toHaveValue('half-typed draft');
  await expect(page.locator('.footer')).toContainText('HOHE e2e-1');

  await Promise.all([page.waitForEvent('framenavigated'), prompt.getByRole('button', { name: 'Update now' }).click()]);
  await expect(page.locator('.footer')).toContainText('HOHE e2e-2');
  await expect(chip(page)).toContainText('1 change waiting to sync');
  expect(await page.evaluate(() => caches.keys())).toEqual(['hohe-app-e2e-2']);

  await context.unroute('**/api/sync');
  await syncNow(page);
  await expect(chip(page)).toHaveText('All synced');
  const st = await srv.serverState();
  expect(st.tasks.filter((t) => t.title === 'Survives the update')).toHaveLength(1);
});

test('replacing the Phase 2 spike at the same origin removes its cached files', async ({ page }) => {
  await srv.startSpike();
  await page.goto(srv.url);
  await expect(page).toHaveTitle('HOHE spike');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain('hohe-spike-shell-v2');

  await srv.start('e2e-1');
  await page.goto(srv.url);
  await expect(page).toHaveTitle('HOHE');
  await expect.poll(() => page.evaluate(() => caches.keys()), { timeout: 15_000 }).toEqual(['hohe-app-e2e-1']);

  // With the server gone, the cached shell is the new app's, never the spike's.
  await srv.stop();
  await page.reload();
  await expect(page).toHaveTitle('HOHE');
  await expect(page.locator('body')).not.toContainText('Phase 2 spike');
  await srv.start('e2e-1'); // for afterEach
});

// ── review corrections, 2026-11-08 (second round) ──────────────────────────

/** Make the app refresh from the server now (the 'online' event schedules an immediate sync). */
async function refreshNow(p: Page) {
  const got = p.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await got;
}

async function editFromDump(p: Page, title: string) {
  await openDumpRow(p, title);
  await p.getByRole('button', { name: /Edit…/ }).click();
  return p.getByRole('dialog', { name: 'Edit task' });
}

test('an open edit keeps its baseline: a remote notes change survives a local title edit', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a);
  await capture(a, 'Baseline task');
  await expect.poll(async () => (await srv.serverState()).tasks.length).toBe(1);
  await login(b);

  const dlgB = await editFromDump(b, 'Baseline task'); // B opens its edit first
  const dlgA = await editFromDump(a, 'Baseline task');
  await dlgA.getByRole('textbox', { name: 'Notes' }).fill('Notes written on A');
  await dlgA.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await srv.serverState()).tasks[0].revisions.notes).toBe(2);

  await refreshNow(b); // B's copy now holds A's notes, under B's still-open dialog
  await dlgB.getByRole('textbox', { name: 'Title' }).fill('Title written on B');
  await dlgB.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await srv.serverState()).tasks[0].title, { timeout: 15_000 }).toBe('Title written on B');
  await expect(chip(b)).toHaveText('All synced');

  const st = await srv.serverState();
  expect(st.tasks[0]).toMatchObject({ title: 'Title written on B' });
  expect((st.tasks[0] as unknown as { notes: string }).notes).toBe('Notes written on A');
  expect(st.conflicts).toHaveLength(0);
});

test('an open edit keeps its baseline: competing title edits reach the conflict tray', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a);
  await capture(a, 'Contested title');
  await expect.poll(async () => (await srv.serverState()).tasks.length).toBe(1);
  await login(b);

  const dlgB = await editFromDump(b, 'Contested title');
  const dlgA = await editFromDump(a, 'Contested title');
  await dlgA.getByRole('textbox', { name: 'Title' }).fill('Title from A');
  await dlgA.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await srv.serverState()).tasks[0].title).toBe('Title from A');

  await refreshNow(b); // the refresh must not rebase B's unfinished edit onto A's revision
  await dlgB.getByRole('textbox', { name: 'Title' }).fill('Title from B');
  await dlgB.getByRole('button', { name: 'Save' }).click();
  await expect(chip(b)).toHaveText('1 conflict needs a choice');
  await b.getByRole('button', { name: 'Sync', exact: true }).click();
  const tray = b.getByRole('region', { name: 'Conflict tray' });
  await expect(tray).toContainText('Title from A');
  await expect(tray).toContainText('Title from B');
  expect((await srv.serverState()).tasks[0].title).toBe('Title from A');
});

test('logout during a delayed sync response: the late answer cannot restore cleared data, and timers stop', async ({ page, context }) => {
  await login(page);
  let calls = 0;
  await context.route('**/api/sync', async (r) => {
    calls++;
    await new Promise((res) => setTimeout(res, 3000));
    await r.continue().catch(() => undefined);
  });
  await capture(page, 'In flight at logout');
  await expect.poll(() => calls).toBe(1); // the request is outstanding
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  const guard = page.getByRole('dialog', { name: 'Log out' });
  await expect(guard.getByTestId('outstanding')).toHaveText('1 change has not reached the server yet.');
  page.once('dialog', (d) => d.accept());
  await guard.getByRole('button', { name: /^Discard 1 pending change and log out/ }).click();

  await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 });
  const stored = await page.evaluate(
    () =>
      new Promise<{ confirmed: unknown; ops: number }>((resolve) => {
        const r = indexedDB.open('hohe');
        r.onsuccess = () => {
          const tx = r.result.transaction(['meta', 'ops'], 'readonly');
          const c = tx.objectStore('meta').get('confirmed');
          const o = tx.objectStore('ops').count();
          tx.oncomplete = () => resolve({ confirmed: c.result ?? null, ops: o.result });
        };
      }),
  );
  expect(stored).toEqual({ confirmed: null, ops: 0 });
  const before = calls;
  await page.waitForTimeout(4000);
  expect(calls, 'no sync after logout').toBe(before);
});

test('another tab adds work during the clearing flow: fresh confirmation with the new count', async ({ context }) => {
  const a = await context.newPage();
  await login(a);
  const b = await context.newPage();
  await b.goto(srv.url);
  await expect(chip(b)).toHaveText('All synced');
  let calls = 0;
  await context.route('**/api/sync', async (r) => {
    calls++;
    if (calls === 1) {
      await new Promise((res) => setTimeout(res, 3000)); // tab B's first sync holds the lock
      return r.continue().catch(() => undefined);
    }
    return r.abort('connectionrefused');
  });
  await capture(b, 'First from tab B');
  await expect.poll(() => calls).toBe(1);

  await a.getByRole('button', { name: 'Settings' }).click();
  await a.getByRole('button', { name: 'Log out' }).click();
  const guard = a.getByRole('dialog', { name: 'Log out' });
  await expect(guard.getByTestId('outstanding')).toHaveText('1 change has not reached the server yet.');
  a.once('dialog', (d) => d.accept());
  await guard.getByRole('button', { name: /^Discard 1 pending change and log out/ }).click();
  await capture(b, 'Second from tab B'); // added after A confirmed, while A waits for the lock

  await expect(guard.getByRole('alert')).toContainText('Another tab added work after you confirmed, so nothing was removed.');
  await expect(guard.getByRole('alert')).toContainText('1 change has not reached the server yet.');
  await expect(guard.getByTestId('outstanding')).toHaveText('1 change has not reached the server yet.');
  await expect(chip(b)).toContainText('1 change waiting to sync'); // still there

  a.once('dialog', (d) => d.accept());
  await guard.getByRole('button', { name: /^Discard 1 pending change and log out/ }).click();
  await expect(a.getByLabel('Password')).toBeVisible({ timeout: 15_000 });
  await expect(b.getByRole('alert').filter({ hasText: 'Log in to sync.' }).or(b.getByLabel('Password'))).toBeVisible();
  const before = calls;
  await a.waitForTimeout(4000);
  expect(calls, 'no tab keeps syncing after logout').toBe(before);
});

test('zero pending and one rejected action: guarded, exported, then discarded', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a);
  const add = a.getByLabel(/^Add a task to/);
  await add.fill('B2 Pay the rent');
  await a.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveValue(''); // the first add is stored and the field cleared
  await add.fill('B Call the plumber');
  await a.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => (await srv.serverState()).placements.length).toBe(2);
  await login(b);

  await blockSync(ctxB);
  await a.getByRole('checkbox', { name: 'Complete: Pay the rent' }).click(); // B2 becomes reserved
  await expect.poll(async () => (await srv.serverState()).placements.some((p) => p.outcome === 'completed')).toBe(true);
  await b.locator('li.row', { hasText: 'Call the plumber' }).getByRole('button', { name: /^Priority B\./ }).click();
  await b.getByRole('dialog').getByRole('button', { name: 'B2', exact: true }).click(); // stale: B2 looks free
  await ctxB.unroute('**/api/sync');
  await syncNow(b);
  await expect(chip(b)).toHaveText('1 rejected action needs attention');

  await b.getByRole('button', { name: 'Settings' }).click();
  await b.getByRole('button', { name: 'Log out' }).click();
  const guard = b.getByRole('dialog', { name: 'Log out' });
  await expect(guard.getByTestId('outstanding')).toHaveText('1 rejected action was refused by the server and never applied.');
  await expect(guard).not.toContainText('Nothing is waiting');
  const discard = guard.getByRole('button', { name: /^Discard 1 rejected action and log out/ });
  await expect(discard).toBeDisabled();

  const [dl] = await Promise.all([b.waitForEvent('download'), guard.getByRole('button', { name: 'Export rejected actions to a file' }).click()]);
  const doc = JSON.parse(await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8'));
  expect(doc.pending).toEqual([]);
  expect(doc.rejected).toHaveLength(1);
  expect(doc.rejected[0].q.label).toBe('Number B2: Call the plumber');
  expect(doc.rejected[0].q.op).toMatchObject({ type: 'setRank', rank: 2 });
  expect(doc.rejected[0].reason).toBeTruthy();

  await expect(discard).toBeEnabled();
  let asked = '';
  b.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await discard.click();
  await expect(b.getByLabel('Password')).toBeVisible({ timeout: 15_000 });
  expect(asked).toBe('Discard 1 rejected action and log out? This cannot be undone.');
  await ctxA.close();
  await ctxB.close();
});

test('placement-id recovery at the failure boundary: server created it, client never stored the answer', async ({ page, context }) => {
  await login(page);
  await blockSync(context); // queue everything first
  await capture(page, 'Placement recovery');
  await page.getByRole('button', { name: 'Task Dump' }).click();
  await page.getByRole('button', { name: 'Assign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'B · important' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).first().click();
  await page.getByRole('button', { name: /^Priority B\./ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'B1', exact: true }).click();
  await expect(chip(page)).toContainText('4 changes waiting to sync');

  await context.unroute('**/api/sync');
  const sent: { type: string; placementId?: string }[][] = [];
  let first = true;
  let applied!: () => void;
  const appliedP = new Promise<void>((r) => (applied = r));
  await context.route('**/api/sync', async (r) => {
    sent.push(JSON.parse(r.request().postData()!).ops);
    if (!first) return r.continue();
    first = false;
    await r.fetch(); // the server creates the placement…
    applied();
    // …and the client is gone before it can store the answer or the id mapping.
  });
  await syncNow(page);
  await appliedP;
  await page.close();

  const mid = await srv.serverState();
  const t = mid.tasks.find((x) => x.title === 'Placement recovery')!;
  const created = mid.placements.filter((p) => p.taskId === t.id);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ letter: 'B', rank: 0 }); // the rank was held back for the mapping
  expect(sent[0].map((o) => o.type)).toEqual(['capture', 'edit', 'assign']);

  const again = await context.newPage();
  await again.goto(srv.url);
  await expect(chip(again)).toHaveText('All synced');
  const end = await srv.serverState();
  const pls = end.placements.filter((p) => p.taskId === t.id);
  expect(pls).toHaveLength(1);
  expect(pls[0]).toMatchObject({ id: created[0].id, letter: 'B', rank: 1, outcome: '' });
  const rankOp = sent.flat().filter((o) => o.type === 'setRank');
  expect(rankOp).toHaveLength(1);
  expect(rankOp[0].placementId).toBe(created[0].id);
  expect(sent[1].map((o) => o.type)).toEqual(['capture', 'edit', 'assign']); // the replay
  expect(end.tasks.filter((x) => x.title === 'Placement recovery')).toHaveLength(1);
  await again.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(again.getByText('Nothing was rejected.')).toBeVisible();
  await expect(again.getByText('Nothing is waiting.')).toBeVisible();
});
