// ==============================
// Config
// ==============================
const APP_CACHE   = 'dfpwm-app-shell-v3';
const SONG_CACHE  = 'dfpwm-song-cache-v1';
const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';

// IMPORTANT: use absolute paths for better cross-platform behavior.
const APP_SHELL = [
  '/',            // main entry / navigation fallback
  '/index.html',
  '/script.js',
  '/manifest.json',
  '/icon.png',
];

// ==============================
// Install — precache app shell
// ==============================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(async cache => {
      // Cache each shell asset individually so one failure
      // doesn’t abort the whole install on iOS/Safari.
      await Promise.all(
        APP_SHELL.map(path =>
          cache.add(path).catch(() => undefined)
        )
      );
    })
  );
  self.skipWaiting();
});

// ==============================
// Activate — cleanup old caches
// ==============================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== APP_CACHE && k !== SONG_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ==============================
// Helpers
// ==============================
const isSongAsset = url => {
  try {
    const p = url.pathname.toLowerCase();
    return p.endsWith('.dfpwm');
  } catch {
    return false;
  }
};

async function handleNavigation(request) {
  const cache = await caches.open(APP_CACHE);

  // Try cached index first (offline-first SPA behavior)
  const cached = await cache.match('/index.html');
  if (cached) return cached;

  // If not cached (first load with network), fetch and cache
  try {
    const resp = await fetch('/index.html', { cache: 'no-store' });
    if (resp && resp.ok) {
      cache.put('/index.html', resp.clone());
    }
    return resp;
  } catch (err) {
    // No cache, network failed → hard offline failure
    return new Response(
      '<h1>Offline</h1><p>The app shell is not cached yet.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Stale-while-revalidate in background
    fetch(request).then(resp => {
      if (resp && resp.ok) cache.put(request, resp.clone());
    }).catch(() => {});
    return cached;
  }

  // Nothing in cache → try network, then optionally cache
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (err) {
    // For non-navigation static requests, just fail if not cached
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function handleSongsJson(request) {
  const cache = await caches.open(SONG_CACHE);
  const cached = await cache.match(request);

  // Prefer fresh list, but fall back to cache or empty array
  try {
    const resp = await fetch(request, { cache: 'no-store' });
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
      return resp;
    }
    if (cached) return cached;
  } catch (err) {
    if (cached) return cached;
  }

  // Offline and no cached list yet
  return new Response('[]', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleSongFile(request) {
  const cache = await caches.open(SONG_CACHE);
  const cached = await cache.match(request);

  // Cache-first for offline reliability
  if (cached) return cached;

  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      // Clone once for cache, once for streaming to page
      cache.put(request, resp.clone());
      return resp;
    }
    // Network error or non-OK, but not cached
    return resp;
  } catch (err) {
    // Offline and not cached
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ==============================
// Fetch
// ==============================
self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1) Navigation requests → app shell (index.html)
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 2) Songs JSON (remote list)
  if (url.href === SONGS_JSON_URL) {
    event.respondWith(handleSongsJson(request));
    return;
  }

  // 3) Song assets (.dfpwm), cross-origin or same-origin
  if (isSongAsset(url)) {
    event.respondWith(handleSongFile(request));
    return;
  }

  // 4) Same-origin static assets (JS, CSS, icons, etc.)
  if (url.origin === self.location.origin) {
    event.respondWith(handleStaticAsset(request));
    return;
  }

  // 5) Everything else: pass through untouched
  // (analytics, other CDNs, etc.)
});

// ==============================
// Optional: background song caching via postMessage
// (not used by current script.js, but safe to keep)
// ==============================
self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'CACHE_SONG_URL' && typeof data.url === 'string') {
    (async () => {
      try {
        const req = new Request(data.url, { method: 'GET' });
        await handleSongFile(req);
      } catch (err) {
        // ignore
      }
    })();
  }
});
