// HOHE service worker. The build (vite.config.ts) replaces __VERSION__ and __ASSETS__.
//
// - Each version precaches its own complete shell (the page at "/" plus every built asset) into
//   its own cache, "hohe-app-<version>". Pages are served from that cache, so one version's
//   index.html is never mixed with another version's assets.
// - An update installs alongside and WAITS. It takes over only when the page asks
//   (SKIP_WAITING, sent by the "Update now" button), so HOHE never reloads under an edit.
// - Replacing the Phase 2 spike at the same hostname: the spike's worker lives at the same
//   URL (/sw.js), so the browser replaces it with this one. When no "hohe-app-" cache exists
//   yet (the first install, or the spike is what is running), this worker activates at once
//   and deletes every other cache, including "hohe-spike-shell-v2", so the spike's cached
//   files can never be served again. Nothing here touches IndexedDB: the app's queue and
//   state survive every update.
// - /api/*, /healthz and /version always go to the network.

const VERSION = '__VERSION__';
const CACHE = `hohe-app-${VERSION}`;
const ASSETS = __ASSETS__;
// "/" rather than "/index.html": Go's file server redirects the latter, and a redirected
// response cannot answer a navigation.
const SHELL = ['/', ...ASSETS];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: 'reload' bypasses the HTTP cache, so the shell is exactly this build's files.
      await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
      const keys = await caches.keys();
      const hasApp = keys.some((k) => k.startsWith('hohe-app-') && k !== CACHE);
      if (!hasApp) await self.skipWaiting(); // first install, or replacing the spike
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/version') return;
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match('/')) || fetch(req);
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(url.pathname)) || fetch(req);
    })(),
  );
});
