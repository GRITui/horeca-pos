/* Sidekick service worker — local-first PWA app shell.
 *
 * VERSION LOCKSTEP: SW_VERSION tracks APP_VERSION in app.js.
 *   app.js  APP_VERSION = '0.9.37'
 *   sw.js   SW_VERSION   = 'sidekick-v0.9.37'
 * Bump BOTH together on every deploy, and keep the ?v= query on the precached
 * app.js / styles.css in step (they double as cache-busters).
 *
 * No backend, no secrets: this SW only precaches the versioned shell and serves
 * same-origin assets cache-first so the app works fully offline.
 *
 * Formerly "freelanz-gym-shell-" — that prefix existed because this app used
 * to co-host with a separate "Freelanz" app on the same origin (root vs /gym/)
 * and Cache Storage is scoped per-origin, not per-path. That sibling app has
 * been retired; the activate handler below still only deletes keys matching
 * ITS OWN current prefix, so an old 'freelanz-gym-shell-*' cache from before
 * this rename is simply left alone (harmless, and evicted by the browser's
 * normal cache-storage limits over time) rather than actively cleaned up.
 */
const SW_VERSION = 'sidekick-v0.9.37';
const CACHE_PREFIX = 'sidekick-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}${SW_VERSION}`;

// BASE is derived from the SW's own location so the app works mounted at any
// subpath (e.g. /freelanz/ on shared hosting), not just the domain root.
const BASE = new URL('./', self.location).pathname;

const SHELL_ASSETS = [
  BASE,
  BASE + 'index.html',
  BASE + 'login.html',
  BASE + 'app.js?v=0.9.37',
  BASE + 'dataClient.js?v=0.9.37',
  BASE + 'tax.js?v=0.9.37',
  BASE + 'invoices.js?v=0.9.37',
  BASE + 'docgen.js?v=0.9.37',
  BASE + 'bookings.js?v=0.9.37',
  BASE + 'followups.js?v=0.9.37',
  BASE + 'portfolio.js?v=0.9.37',
  BASE + 'research.js?v=0.9.37',
  BASE + 'styles.css?v=0.9.37',
  BASE + 'manifest.json',
  BASE + 'icons/icon.svg',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/apple-touch-icon.png',
  BASE + 'fonts/schibsted-grotesk-variable.woff2',
  BASE + 'fonts/spline-sans-mono-variable.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== SHELL_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // don't intercept cross-origin

  // Navigations → serve the matching precached page (offline-safe), else network,
  // else fall back to the app entry so a deep link still boots offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match(url.pathname);
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return (await caches.match(BASE + 'index.html')) || (await caches.match(BASE));
      }
    })());
    return;
  }

  // Same-origin static assets → cache-first, then populate the cache.
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((resp) => {
        // Only cache successful, same-origin ('basic') responses — never error
        // pages, redirects, or opaque cross-origin responses.
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached))
  );
});

// Let the page tell a waiting SW to activate immediately.
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// Tapping an app-triggered OS notification (app.js's showOsNotification())
// focuses an already-open tab if there is one, otherwise opens a new one —
// standard PWA notification-click behavior.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsList) {
      if (c.url.startsWith(BASE) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(BASE);
  })());
});
