const CACHE_NAME = 'prospect-tracker-v1';
const urlsToCache = [
  '/',
  '/index.html',
  // NOTE: Add other essential files here if you add them later (e.g., CSS, other JS files)
  '/images/icon-192x192.png',
  '/images/icon-512x512.png'
];

// Install the service worker and cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Serve cached content when offline
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});