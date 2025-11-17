const APP_CACHE = 'dfpwm-app-shell-v3';
const SONG_CACHE = 'dfpwm-song-cache-v1';
const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const APP_SHELL = [
  './',
  'index.html',
  'script.js',
  'manifest.json',
  'icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![APP_CACHE, SONG_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

const isSongAsset = (url) => {
  const pathname = url.pathname || '';
  return pathname.endsWith('.dfpwm');
};

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(APP_CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })).catch(() => caches.match('index.html'))
    );
    return;
  }

  if (url.href === SONGS_JSON_URL || isSongAsset(url)) {
    event.respondWith(
      caches.open(SONG_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => caches.match(event.request))
    );
  }
});
