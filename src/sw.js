// App-shell service worker: cache-first for local assets so the app opens with no network.
const CACHE = 'loan-recovery-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './js/install.js',
  './js/help.js',
  './help/content.js',
  './js/api.js',
  './js/ui.js',
  './js/supervisor.js',
  './js/app.js',
  './js/logic.js',
  './js/store.js',
  './js/slips.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only the app shell is cached. API calls (live data, slips) and other origins go straight to the network.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/') || url.pathname.includes('/admin')) return;
  // Stale-while-revalidate: serve the cached copy instantly, refresh it in the background.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      if (hit) e.waitUntil(fresh);
      return hit || fresh;
    })
  );
});
