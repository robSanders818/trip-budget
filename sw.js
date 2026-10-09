// Offline support: always try GitHub for the newest files, fall back to the saved copy
// when offline or when the network is too slow.
const CACHE = 'tripbudget-v2';
const NETWORK_TIMEOUT_MS = 3000;
const ASSETS = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the phone's HTTP cache so a new install never saves stale files.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req.url;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'no-cache' makes the phone check with GitHub instead of reusing a copy for 10 minutes.
    const network = fetch(req.url, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    e.waitUntil(network.catch(() => {})); // keep updating the saved copy even if we time out
    try {
      return await Promise.race([network,
        new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS))]);
    } catch {
      return (await cache.match(key, { ignoreSearch: true })) || network;
    }
  })());
});
