const CACHE_VERSION = "acoustify-shell-v2.0.1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./404.html",
  "./manifest.webmanifest",
  "./data/catalog.json",
  "./data/catalog.schema.json",
  "./assets/css/app.css",
  "./assets/js/app.js",
  "./assets/js/catalog.js",
  "./assets/js/db.js",
  "./assets/js/player.js",
  "./assets/js/utils.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/artwork/JoUq869LXeA.jpg",
  "./assets/artwork/Y25LDO6OLzQ.jpg",
  "./assets/artwork/BuUkI05OLHQ.jpg",
  "./assets/artwork/nuUVSzwAE0A.jpg",
  "./assets/artwork/J1vTi9ycpiA.jpg",
  "./assets/artwork/uJ3Pusp6R_s.jpg",
  "./assets/artwork/HbYhMAI4tL4.jpg",
  "./assets/artwork/jGUASAxXwg4.jpg",
  "./assets/artwork/kTlaky9zzhw.jpg",
  "./assets/artwork/RdF2zb3KjZE.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Optional third-party sources stay under their provider's normal network
  // behavior. The built-in library is entirely same-origin.
  if (url.origin !== self.location.origin) return;

  // Let the browser request media byte ranges directly. Caching partial 206
  // responses would make seeking unreliable, and downloading the whole library
  // during service-worker installation would make installation fragile.
  if (url.pathname.includes("/media/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_VERSION).then((cache) => cache.put("./index.html", response.clone()));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  const networkFirst = url.pathname.endsWith("/data/catalog.json") || url.pathname.endsWith("/sw.js");
  if (networkFirst) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
      return response;
    }))
  );
});
