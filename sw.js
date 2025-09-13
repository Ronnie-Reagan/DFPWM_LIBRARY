// sw.js — minimal service worker

self.addEventListener("install", (event) => {
  // Activate worker immediately after install
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of all clients right away
  event.waitUntil(clients.claim());
});

self.addEventListener("fetch", (event) => {
  // For now, just pass all requests through to the network
  event.respondWith(fetch(event.request));
});
