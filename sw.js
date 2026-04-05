const APP_CACHE = 'dfpwm-app-shell-v4';
const SONG_CACHE = 'dfpwm-song-cache-v1';
const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const APP_SHELL_FILES = ['./', './index.html', './script.js', './manifest.json', './sw.js', './icon.png'];

function appShellUrls() {
  return APP_SHELL_FILES.map(path => new URL(path, self.registration.scope).toString());
}

function getIndexUrl() {
  return new URL('./index.html', self.registration.scope).toString();
}

function isSongAsset(url) {
  try {
    return url.pathname.toLowerCase().endsWith('.dfpwm');
  } catch {
    return false;
  }
}

async function safeCachePut(cacheName, request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    const urls = appShellUrls();
    const results = await Promise.allSettled(
      urls.map(async url => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to precache ${url}: HTTP ${response.status}`);
        await cache.put(url, response.clone());
      })
    );

    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      console.warn('App shell precache had failures:', failures.map(result => result.reason?.message || result.reason));
    }
  })());

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key !== APP_CACHE && key !== SONG_CACHE)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

async function handleNavigation() {
  const indexUrl = getIndexUrl();
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(indexUrl);
  if (cached) return cached;

  try {
    const response = await fetch(indexUrl, { cache: 'no-store' });
    if (response && response.ok) {
      await cache.put(indexUrl, response.clone());
    }
    return response;
  } catch {
    return new Response(
      '<!doctype html><title>Offline</title><h1>Offline</h1><p>The app shell is not cached yet.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    fetch(request)
      .then(response => safeCachePut(APP_CACHE, request, response))
      .catch(() => {});
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function handleSongsJson(request) {
  const cache = await caches.open(SONG_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      await cache.put(request, response.clone());
      return response;
    }
    if (cached) return cached;
  } catch {
    if (cached) return cached;
  }

  return new Response('[]', {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function handleSongFile(request) {
  const cache = await caches.open(SONG_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation());
    return;
  }

  if (url.href === SONGS_JSON_URL) {
    event.respondWith(handleSongsJson(request));
    return;
  }

  if (isSongAsset(url)) {
    event.respondWith(
      handleSongFile(request).catch(() => new Response('', { status: 504, statusText: 'Offline' }))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleStaticAsset(request));
  }
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  const replyPort = event.ports && event.ports[0];
  const respond = payload => {
    if (replyPort) replyPort.postMessage(payload);
  };

  if (data.type === 'CACHE_SONG_URL' && typeof data.url === 'string') {
    event.waitUntil((async () => {
      try {
        const request = new Request(data.url, { method: 'GET' });
        const response = await handleSongFile(request);
        if (!response || !response.ok) {
          throw new Error(`HTTP ${response?.status || 'cache failed'}`);
        }
        respond({ ok: true, url: data.url });
      } catch (err) {
        respond({ ok: false, error: err?.message || 'Failed to cache song.' });
      }
    })());
  }
});
