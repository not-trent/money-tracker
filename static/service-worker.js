const CACHE_NAME = "money-tracker-shell-v11";
const SHELL = [
  "/",
  "/static/app.css",
  "/static/device-store.js",
  "/static/app.js",
  "/static/manifest.webmanifest",
  "/static/vendor/chart.umd.js",
  "/static/icons/house.svg",
  "/static/icons/target.svg",
  "/static/icons/chart-column.svg",
  "/static/icons/history.svg",
  "/static/icons/settings.svg",
  "/static/icons/upload.svg",
  "/static/icons/landmark.svg",
  "/static/icons/wallet.svg",
  "/static/icons/arrow-left-right.svg",
  "/static/icons/piggy-bank.svg",
  "/static/icons/arrow-down-left.svg",
  "/static/icons/arrow-up-right.svg",
  "/static/icons/receipt-text.svg",
  "/static/icons/check.svg",
  "/static/icons/plus.svg",
  "/static/icons/pencil.svg",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-512.png",
  "/static/icons/apple-touch-icon.png",
  "/static/icons/favicon-48.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname === "/static/manifest.webmanifest") {
    event.respondWith(fetch(request, { cache: "no-cache" }).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put("/", copy));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});