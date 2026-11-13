/**
 * FastChange Service Worker
 * 
 * Cache strategy:
 * - Static assets (JS/CSS with hashes): Cache-first (already immutable via HTTP)
 * - Navigation (HTML): Network-first, fallback to cache (offline support)
 * - API/Supabase calls: Network-only (never cache dynamic data)
 * - Images: Cache-first (avoid re-downloading)
 * 
 * The cache is versioned so a new deploy replaces the old cache entirely.
 */

const CACHE_NAME = 'fc-v1';

// Resources that are always needed for the app shell
// Note: only add URLs that are guaranteed to exist!
const SHELL_URLS = ['/', '/offline.html'];

// ── Install: pre-cache the app shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Pre-cache what we can; if offline.html doesn't exist, that's ok
      return cache.addAll(SHELL_URLS).catch(() => {
        /* One of the URLs might fail in some edge cases — fail silently */
      });
    })
  );
  // Activate immediately — don't wait for page reload
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open pages immediately
  self.clients.claim();
});

// ── Fetch: smart caching strategy ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip non-GET requests ──
  if (request.method !== 'GET') return;

  // ── Skip Supabase API calls ──
  if (url.hostname.includes('supabase.co')) return;

  // ── Skip CDN proxy ──
  if (url.hostname.includes('api.foranly.cloud') || url.hostname.includes('api.foranly.space') || url.href.includes('/cdn/')) return;

  // ── Static assets: cache-first (stale-while-revalidate) ──
  // These are JS/CSS files with content hashes in their names,
  // served from /assets/ with Cache-Control: immutable.
  // The SW gives an extra layer: even if the HTTP cache misses,
  // the SW cache serves instantly and refreshes in background.
  if (
    url.pathname.startsWith('/assets/') &&
    (url.pathname.endsWith('.js') ||
     url.pathname.endsWith('.css') ||
     url.pathname.endsWith('.svg') ||
     url.pathname.endsWith('.png') ||
     url.pathname.endsWith('.jpg') ||
     url.pathname.endsWith('.webp') ||
     url.pathname.endsWith('.woff2'))
  ) {
    event.respondWith(cacheFirstRefresh(request));
    return;
  }

  // ── Navigation (HTML pages): network-first, cache fallback ──
  // This gives us offline support: if the network fails,
  // we serve the last cached version of the page.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstCache(request));
    return;
  }

  // ── Everything else: network-only (avatars, external resources) ──
  // Don't cache — let the browser's HTTP cache handle it.
});

/**
 * Cache-first with background refresh.
 * Serve from cache immediately, then fetch from network to update cache.
 * Perfect for immutable hashed assets.
 */
async function cacheFirstRefresh(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh cache in background (don't block the response)
    fetch(request)
      .then((response) => {
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response));
        }
      })
      .catch(() => {
        /* offline — cached version is fine */
      });
    return cached;
  }

  // Cache miss — fetch from network and cache
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cloned = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
    }
    return response;
  } catch (err) {
    // Offline and not in cache — return a fallback
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Network-first with cache fallback.
 * Try the network first; if it fails (offline), serve the cached version.
 * Perfect for navigation requests (HTML).
 */
async function networkFirstCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cloned = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;

    // Last resort: try the root cache entry
    const rootCached = await caches.match('/');
    if (rootCached) return rootCached;

    return new Response('Offline', { status: 503 });
  }
}
