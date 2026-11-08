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
