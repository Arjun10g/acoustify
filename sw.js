/* Acoustify service worker.
 *
 * 1. Precaches the app shell per release (acoustify-shell-<APP_VERSION>).
 * 2. Adds the Hugging Face read token to requests for the private library
 *    dataset, so <audio> and <img> can load it directly.
 * 3. Serves downloaded songs from acoustify-audio-v1 with real Range support
 *    (media elements cannot seek without 206 responses).
 *
 * arjun10g.github.io also hosts other apps (Papers_Audio keeps "shell-*",
 * "audio-v1", ... caches on this origin), so this worker only ever deletes its
 * own superseded "acoustify-shell-*" caches.
 */

const APP_VERSION = "dev";

const SHELL_PREFIX = "acoustify-shell-";
const SHELL_CACHE = `${SHELL_PREFIX}${APP_VERSION}`;
// Every pre-v3 release named its shell "acoustify-shell-v<semver>" (v1.0.1 to
// v2.1.0); stamped releases use a commit SHA or "dev", never that form.
const LEGACY_SHELL = /^acoustify-shell-v\d+\.\d+\.\d+$/;
const AUDIO_CACHE = "acoustify-audio-v1";
const ART_CACHE = "acoustify-art-v1";
const AUTH_CACHE = "acoustify-auth";
const ART_MAX_ENTRIES = 300;
const BUNDLED_LIBRARY_TIMEOUT_MS = 4000;

// Keep in step with assets/js/config.js (HUB, REPO).
const HUB = "https://huggingface.co";
const REPO = "arjun10g/acoustify-library";
const LIBRARY_PREFIX = `${HUB}/datasets/${REPO}/`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./data/library.json",
  "./assets/css/app.css",
  "./assets/css/nowplaying.css",
  "./assets/css/views/home.css",
  "./assets/css/views/search.css",
  "./assets/css/views/artists.css",
  "./assets/css/views/library.css",
  "./assets/css/views/album.css",
  "./assets/css/views/settings.css",
  "./assets/js/app.js",
  "./assets/js/catalog.js",
  "./assets/js/cloud.js",
  "./assets/js/config.js",
  "./assets/js/db.js",
  "./assets/js/icons.js",
  "./assets/js/nowplaying.js",
  "./assets/js/player.js",
  "./assets/js/ui.js",
  "./assets/js/utils.js",
  "./assets/js/views/home.js",
  "./assets/js/views/search.js",
  "./assets/js/views/songs.js",
  "./assets/js/views/artists.js",
  "./assets/js/views/series.js",
  "./assets/js/views/library.js",
  "./assets/js/views/album.js",
  "./assets/js/views/playlist.js",
  "./assets/js/views/settings.js",
  "./assets/js/views/edit.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-512.png",
  "./assets/icons/apple-touch-icon.png"
];

// The page, its scripts (app.js statically imports every module, so one
// missing file stops the whole app) and its styles. A failed precache of any
// of them fails the install, and the browser retries later with the previous
// shell still intact. Icons, the manifest and the bundled library can be
// fetched later.
const CRITICAL_SHELL = SHELL_FILES.filter((path) =>
  path === "./index.html" || path.startsWith("./assets/js/") || path.startsWith("./assets/css/"));

function isLegacyShell(name) {
  return name !== SHELL_CACHE && LEGACY_SHELL.test(name);
}

/* Pure Range parser (unit-tested by loading this file in node:vm).
 * Returns { start, end } (inclusive, clamped) or null when the header is
 * absent, malformed, multi-range, or unsatisfiable (the caller answers 416). */
function parseRange(header, total) {
  if (typeof header !== "string" || !(total > 0)) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (!hasStart) {
    // Suffix form: "bytes=-500" is the last 500 bytes.
    const length = parseInt(match[2], 10);
    if (!(length > 0)) return null;
    start = Math.max(0, total - length);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    if (!Number.isFinite(start) || start >= total) return null;
    end = hasEnd ? parseInt(match[2], 10) : total - 1;
    if (!Number.isFinite(end)) return null;
    if (end >= total) end = total - 1;
    if (end < start) return null;
  }
  return { start, end };
}

function isLibraryUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`.startsWith(LIBRARY_PREFIX);
  } catch (error) {
    return false;
  }
}

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

/* ── token ──────────────────────────────────────────────────────────────── */

let tokenMemo = null;

function readToken() {
  if (!tokenMemo) {
    tokenMemo = (async () => {
      try {
        const cache = await caches.open(AUTH_CACHE);
        const hit = await cache.match(scopeUrl("./__hf_token__"));
        return hit ? (await hit.text()).trim() : "";
      } catch (error) {
        return "";
      }
    })();
  }
  return tokenMemo;
}

/* ── lifecycle ──────────────────────────────────────────────────────────── */

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const results = await Promise.all(SHELL_FILES.map(async (path) => {
      try {
        // Bypass the HTTP cache so a release never precaches the previous release's files.
        const response = await fetch(new Request(scopeUrl(path), { cache: "reload" }));
        if (!response.ok) return false;
        await cache.put(scopeUrl(path), response);
        return true;
      } catch (error) {
        return false;
      }
    }));
    const failed = SHELL_FILES.filter((path, index) => !results[index]);
    if (failed.some((path) => CRITICAL_SHELL.includes(path))) {
      throw new Error(`Acoustify shell precache failed: ${failed.join(", ")}`);
    }
    // Pre-v3 apps have no "update ready" UI, so waiting would strand them forever.
    if ((await caches.keys()).some(isLegacyShell)) await self.skipWaiting();
  })());
});

async function reloadWindows() {
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) client.navigate(client.url).catch(() => null);
}

self.addEventListener("activate", (event) => {
  const activation = (async () => {
    const names = await caches.keys();
    const replacingLegacyApp = names.some(isLegacyShell);
    await Promise.all(
      names
        .filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
    return replacingLegacyApp;
  })();
  event.waitUntil(activation);
  // Windows still running a pre-v3 app keep asking for files this release no
  // longer ships (./media/, catalog.json), so reload them into it. Only once
  // activation has settled: their navigations are fetch events, which wait for
  // activation, so awaiting them inside waitUntil would deadlock.
  activation.then((replacingLegacyApp) => (replacingLegacyApp ? reloadWindows() : null)).catch(() => null);
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (type === "TOKEN_CHANGED") {
    tokenMemo = null;
    // The page waits for this so its next request cannot race the old token.
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: "TOKEN_ACK" });
  } else if (type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: "VERSION", version: APP_VERSION });
  }
});

/* ── responses ──────────────────────────────────────────────────────────── */

function rangeResponse(blob, range, type) {
  return new Response(blob.slice(range.start, range.end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": type,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${blob.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    }
  });
}

async function serveCachedMedia(request, cached) {
  const type = cached.headers.get("Content-Type") || "audio/mp4";
  const header = request.headers.get("range");
  const blob = await cached.blob();

  if (!header) {
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(blob.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      }
    });
  }

  const range = parseRange(header, blob.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers: { "Content-Range": `bytes */${blob.size}`, "Accept-Ranges": "bytes" }
    });
  }
  return rangeResponse(blob, range, type);
}

function offlinePage() {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>Acoustify</title><body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0a0b;color:#f5f5f6;" +
      "font:15px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center\"><div><h1 style=\"font-size:22px\">You're offline</h1>" +
      "<p style=\"color:#a3a3ab\">Acoustify will open once you're connected.</p></div></body>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

// Navigations must not be answered with a redirected response.
async function unredirected(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - max; index += 1) await cache.delete(keys[index]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── routes ─────────────────────────────────────────────────────────────── */

async function navigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(scopeUrl("./index.html"), { ignoreSearch: true, ignoreVary: true })
    || await cache.match(scopeUrl("./"), { ignoreSearch: true, ignoreVary: true });
  if (cached) return unredirected(cached);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(scopeUrl("./index.html"), response.clone()).catch(() => {});
      return unredirected(response);
    }
    return response;
  } catch (error) {
    return offlinePage();
  }
}

async function bundledLibrary() {
  const key = scopeUrl("./data/library.json");
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key, { ignoreSearch: true, ignoreVary: true });
  const network = fetch(key, { cache: "no-store" }).then((response) => {
    if (response.ok) cache.put(key, response.clone()).catch(() => {});
    return response;
  });
  if (!cached) return network;
  const fallback = () => cached;
  // A slow connection must not stall startup: after a few seconds use the release copy.
  return Promise.race([
    network.then((response) => (response.ok ? response : cached), fallback),
    delay(BUNDLED_LIBRARY_TIMEOUT_MS).then(fallback)
  ]);
}

async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200 && response.type === "basic") cache.put(request, response.clone()).catch(() => {});
  return response;
}

async function authenticatedFetch(request, url, { forwardRange = false, noStore = false } = {}) {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (forwardRange && range) headers.set("Range", range);
  // A request that brings its own key (e.g. verifying a newly pasted token) keeps it.
  const own = request.headers.get("authorization");
  const token = own ? "" : await readToken();
  if (own) headers.set("Authorization", own);
  else if (token) headers.set("Authorization", `Bearer ${token}`);
  const init = { method: "GET", headers, mode: "cors", credentials: "omit", redirect: "follow" };
  // Offline downloads ask for no-store: they land in acoustify-audio-v1 and must
  // not also fill the HTTP disk cache with a second copy.
  if (noStore || request.cache === "no-store") init.cache = "no-store";
  if (request.signal) init.signal = request.signal;
  return fetch(url.href, init);
}

async function libraryMedia(request, url) {
  const cache = await caches.open(AUDIO_CACHE);
  // Match on the URL string, never on the Request: a Request that carries a
  // Range header makes cache.match() synthesize its own partial response.
  const cached = await cache.match(url.href, { ignoreSearch: true, ignoreVary: true });
  if (cached) return serveCachedMedia(request, cached);
  return authenticatedFetch(request, url, { forwardRange: true });
}

async function libraryArtwork(request, url) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(url.href, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  const response = await authenticatedFetch(request, url);
  if (response.status === 200) {
    cache.put(url.href, response.clone()).then(() => trimCache(cache, ART_MAX_ENTRIES)).catch(() => {});
  }
  return response;
}

async function youtubeImage(request, url) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(url.href, { ignoreVary: true });
  if (hit) return hit;
  let response;
  try {
    // i.ytimg.com sends CORS headers; a CORS copy avoids the large quota padding of opaque entries.
    response = await fetch(url.href, { mode: "cors", credentials: "omit" });
  } catch (error) {
    response = await fetch(request);
  }
  if (response.status === 200 || response.type === "opaque") {
    cache.put(url.href, response.clone()).then(() => trimCache(cache, ART_MAX_ENTRIES)).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  if (url.origin === self.location.origin) {
    const scope = new URL(self.registration.scope);
    if (!url.pathname.startsWith(scope.pathname)) return;
    const relative = url.pathname.slice(scope.pathname.length);
    if (request.mode === "navigate") {
      // Only the app entry; other pages (404.html redirect, raw files) behave normally.
      if (relative === "" || relative === "index.html") event.respondWith(navigate(request));
      return;
    }
    if (relative === "data/library.json") {
      event.respondWith(bundledLibrary());
      return;
    }
    if (relative === "sw.js" || request.headers.has("range")) return;
    event.respondWith(shellFirst(request));
    return;
  }

  if (isLibraryUrl(url)) {
    if (url.pathname.includes("/media/")) event.respondWith(libraryMedia(request, url));
    else if (url.pathname.includes("/artwork/")) event.respondWith(libraryArtwork(request, url));
    else event.respondWith(authenticatedFetch(request, url, { noStore: true }));
    return;
  }

  if (url.hostname === "i.ytimg.com") event.respondWith(youtubeImage(request, url));
});
