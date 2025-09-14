/* Service Worker v3.1 — safe caching */
const VERSION = 'v3.3-2025-09-14';
const ASSET_CACHE = `assets-${VERSION}`;
const HTML_CACHE  = `html-${VERSION}`;

const ASSET_EXTENSIONS = [
  '.js','.css','.png','.jpg','.jpeg','.gif','.webp','.svg',
  '.woff','.woff2','.ttf','.otf','.eot','.mp3','.mp4','.webm','.m4a','.ogg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.endsWith(VERSION) ? Promise.resolve() : caches.delete(k))));
    await self.clients.claim();
    const clients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
    for (const c of clients) c.postMessage({ type: 'NEW_VERSION', version: VERSION });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle http(s) requests; ignore chrome-extension:, data:, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname === '/sw-version') {
    event.respondWith(new Response(VERSION, { status: 200, headers: { 'content-type': 'text/plain' } }));
    return;
  }

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, HTML_CACHE));
    return;
  }

  if (sameOrigin && ASSET_EXTENSIONS.some((ext) => url.pathname.endsWith(ext))) {
    event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }

  event.respondWith(networkFirst(req, ASSET_CACHE));
});

async function safePut(cache, request, response) {
  try {
    // Only cache http(s) GET requests
    const url = new URL(request.url);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && response && response.ok) {
      await cache.put(request, response.clone());
    }
  } catch (e) {
    // Swallow caching errors (e.g. opaque responses, extensions, cross-origin with no-cors)
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(cacheName);
    await safePut(cache, request, response);
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(async (response) => {
    await safePut(cache, request, response);
    return response;
  }).catch(() => null);
  return cached || networkPromise || fetch(request).catch(() => cached || new Response('Offline', {status: 503}));
}
