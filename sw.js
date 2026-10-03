const CACHE = 'wealth-os-v1-7-4';
const ASSETS = [
  './', './index.html', './styles.css', './manifest-v174.webmanifest',
  './js/app.js', './js/db.js', './js/calc.js', './js/defaults.js',
  './icons/wealth-os-v173-32.png', './icons/wealth-os-v173-180.png', './icons/wealth-os-v173-192.png', './icons/wealth-os-v173-512.png', './icons/wealth-os-v173-1024.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
