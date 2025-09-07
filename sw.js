/* Upgraded Service Worker – auto-update & safe runtime caching
   - Versioned caches
   - skipWaiting() on install so new SW takes control immediately
   - clients.claim() on activate
   - Old cache cleanup
   - Runtime caching:
       • HTML/doc requests: network-first (fallback to cache when offline)
       • Static assets (js/css/img/fonts): stale-while-revalidate
   - Broadcasts a 'NEW_VERSION' message on activate so pages can refresh
*/

const VERSION = 'v3-2025-09-07';
const ASSET_CACHE = `assets-${VERSION}`;
const HTML_CACHE  = `html-${VERSION}`;

const ASSET_EXTENSIONS = [
  '.js','.css','.png','.jpg','.jpeg','.gif','.webp','.svg',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.mp3','.mp4','.webm','.m4a','.ogg'
];

self.addEventListener('install', (event) => {
  // Take control immediately
  self.skipWaiting();
  // Optionally pre-cache small essentials here if desired.
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  const keep = new Set([ASSET_CACHE, HTML_CACHE]);
  event.waitUntil(
    (async () => {
      // Remove old caches
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => (keep.has(key) ? null : caches.delete(key))));

      // Claim clients so the fresh SW controls all open tabs
      await self.clients.claim();

      // Notify all controlled clients that a new version is active
      const allClients = await self.clients.matchAll({includeUncontrolled: true, type: 'window'});
      for (const client of allClients) {
        client.postMessage({ type: 'NEW_VERSION', version: VERSION });
      }
    })()
  );
});

// Allow page to trigger immediate activation if it detects an update
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests are cacheable
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Special endpoint to expose SW version (useful for debugging)
  if (sameOrigin && url.pathname === '/sw-version') {
    event.respondWith(new Response(VERSION, { status: 200, headers: { 'content-type': 'text/plain' } }));
    return;
  }

  // For navigation requests (HTML), use Network-First
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, HTML_CACHE));
    return;
  }

  // For static assets (same-origin and with known extensions), use Stale-While-Revalidate
  if (sameOrigin && ASSET_EXTENSIONS.some((ext) => url.pathname.endsWith(ext))) {
    event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }

  // Default: try network, fall back to cache for any GET
  event.respondWith(networkFirst(req, ASSET_CACHE));
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Final fallback: offline page can be provided here if pre-cached
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then((response) => {
    cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || networkPromise || fetch(request).catch(() => cached || new Response('Offline', {status: 503}));
}
