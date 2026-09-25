import { CONFIG } from "./config.js";
import { getValue, requestPersistentStorage, setValue } from "./db.js";

// Everything here must stay importable in Node (tests use the pure helpers),
// so browser globals are only touched inside functions.

const HUB = CONFIG.HUB.replace(/\/+$/, "");
const DATASET_PREFIX = `${HUB}/datasets/${CONFIG.REPO}/`;
// Cache names are shared with sw.js; keep them in step.
const AUTH_CACHE = "acoustify-auth";
const AUDIO_CACHE = "acoustify-audio-v1";
const ART_CACHE = "acoustify-art-v1";
const TOKEN_PATH = "./__hf_token__";
const LIBRARY_CACHE_KEY = "library-cache";
const SYNCED_AT_KEY = "library-synced-at";
const DEFAULT_ARTWORK = "./assets/icons/icon-512.png";
const LIBRARY_SCHEMA = 2;
const REMOTE_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 15_000;
// A transfer that delivers no bytes for this long is treated as dead.
const STALL_TIMEOUT_MS = 20_000;
const MAX_OBJECT_URLS = 2;
const ARTWORK_MEMO_SIZE = 30;
const ARTWORK_SIZE = 512;
const ARTWORK_WARM_DELAY_MS = 4000;
const ARTWORK_WARM_CONCURRENCY = 3;
const PROGRESS_INTERVAL_MS = 120;

export const LIBRARY_URL = `${DATASET_PREFIX}resolve/main/${CONFIG.LIBRARY_FILE}`;

// ---------------------------------------------------------------------------
// URLs

function encodePath(path) {
  return String(path || "")
    .replace(/^\.?\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function datasetFileUrl(hub, repo, rev, path) {
  return `${String(hub).replace(/\/+$/, "")}/datasets/${repo}/resolve/${encodeURIComponent(rev || "main")}/${encodePath(path)}`;
}

export function fileUrl(path, rev = "main") {
  return datasetFileUrl(HUB, CONFIG.REPO, rev, path);
}

export function isLibraryUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`.startsWith(DATASET_PREFIX);
  } catch {
    return false;
  }
}

function documentBase() {
  return globalThis.document?.baseURI || globalThis.location?.href || "http://localhost/";
}

function absoluteUrl(url) {
  try {
    return new URL(url, documentBase()).href;
  } catch {
    return String(url || "");
  }
}

// ---------------------------------------------------------------------------
// Errors

function isOffline() {
  return globalThis.navigator?.onLine === false;
}

// fetch() rejects with a TypeError for every network-level failure (DNS, TLS,
// CORS, connection reset) and an AbortError for our own timeouts.
function networkReason(error) {
  if (isOffline()) return "offline";
  const name = error?.name || "";
  return name === "TypeError" || name === "AbortError" || name === "TimeoutError" ? "offline" : "error";
}

function authFailure(response) {
  if (response.status === 401 || response.status === 403) return true;
  // HF answers 404 RepoNotFound when a valid token cannot see the private dataset.
  return response.status === 404 && response.headers.get("x-error-code") === "RepoNotFound";
}

function httpError(status, message) {
  const error = new Error(message || `Request failed (${status}).`);
  error.status = status;
  error.kind = status === 401 || status === 403 ? "auth" : "http";
  return error;
}

function withTimeout(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(new DOMException("Cancelled", "AbortError")),
    done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

// An idle timeout rather than a total one: a big file on a slow link may take
// minutes, but a request that stops delivering bytes (a dead connection the
// browser never reports) must not hang forever. Call touch() on each chunk.
function stallGuard(controller, ms = STALL_TIMEOUT_MS) {
  let timer = 0;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("The connection stalled.", "TimeoutError")), ms);
  };
  touch();
  return { touch, done: () => clearTimeout(timer) };
}

function isStall(error) {
  return error?.name === "TimeoutError";
}

// The library token only ever travels to the library dataset, whatever URL a
// caller (or an imported backup) hands in.
function authHeaders(url, token) {
  return token && isLibraryUrl(url) ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// Token (Cache Storage so the service worker can read it too)

function tokenKey() {
  return new URL(TOKEN_PATH, documentBase()).href;
}

function cleanToken(token) {
  return String(token ?? "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/\s+/g, "");
}

// Messages and fetch events reach the worker on separate channels, so a bare
// postMessage could land after the next library request. Waiting for the ack
// guarantees that once setToken/clearToken resolve, playback uses the new key.
function postAndWait(worker, message, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let channel;
    try {
      channel = new MessageChannel();
    } catch {
      worker.postMessage(message);
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, timeoutMs);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(true);
    };
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function notifyServiceWorker() {
  const container = globalThis.navigator?.serviceWorker;
  if (!container) return;
  const workers = new Set();
  if (container.controller) workers.add(container.controller);
  try {
    const registration = await container.getRegistration();
    for (const worker of [registration?.installing, registration?.waiting, registration?.active]) {
      if (worker) workers.add(worker);
    }
  } catch {
    // No registration yet: the next worker reads the token fresh anyway.
  }
  const live = [...workers].filter((worker) => worker.state !== "redundant");
  await Promise.all(live.map((worker) => postAndWait(worker, { type: "TOKEN_CHANGED" })));
}

export async function getToken() {
  if (typeof caches === "undefined") return "";
  try {
    const cache = await caches.open(AUTH_CACHE);
    const hit = await cache.match(tokenKey());
    return hit ? cleanToken(await hit.text()) : "";
  } catch {
    return "";
  }
}

export async function setToken(token) {
  const value = cleanToken(token);
  if (!value) return clearToken();
  if (typeof caches === "undefined") throw new Error("This browser can't store your access token (a secure https page is required).");
  const cache = await caches.open(AUTH_CACHE);
  await cache.put(tokenKey(), new Response(value, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } }));
  await notifyServiceWorker();
}

export async function clearToken() {
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(AUTH_CACHE);
      await cache.delete(tokenKey());
    } catch {
      // Nothing stored.
    }
  }
  await notifyServiceWorker();
}

const WRITE_PERMISSION = /(^|\.)write$/;

// What a token may do, from its /api/whoami-v2 answer. The token sits in
// storage every page on this origin can read, so only a fine-grained,
// read-only token limited to the library dataset is a safe thing to keep:
//   role             "read" | "write" | "fineGrained" | "unknown"
//   canWrite         it can change something on the account (repos, discussions,
//                    paid inference, ...): classic write tokens and fine-grained
//                    tokens with any "*.write" permission
//   onlyThisLibrary  it can read the library dataset and nothing else
export function describeTokenAccess(whoami) {
  const token = whoami?.auth?.accessToken;
  const role = ["read", "write", "fineGrained"].includes(token?.role) ? token.role : "unknown";
  if (role !== "fineGrained") return { role, canWrite: role === "write", onlyThisLibrary: false };
  const fine = isPlainObject(token.fineGrained) ? token.fineGrained : {};
  const global = Array.isArray(fine.global) ? fine.global.map(String) : [];
  const scoped = Array.isArray(fine.scoped) ? fine.scoped : [];
  const permissions = [...global, ...scoped.flatMap((entry) => (Array.isArray(entry?.permissions) ? entry.permissions.map(String) : []))];
  const canWrite = permissions.some((permission) => WRITE_PERMISSION.test(permission));
  const onlyThisLibrary = !canWrite
    && scoped.length > 0
    && !global.some((permission) => permission.startsWith("repo."))
    && scoped.every((entry) => entry?.entity?.type === "dataset" && entry.entity.name === CONFIG.REPO);
  return { role, canWrite, onlyThisLibrary };
}

async function fetchWhoAmI(token) {
  const timeout = withTimeout(5000);
  try {
    const response = await fetch(`${HUB}/api/whoami-v2`, {
      headers: { Authorization: `Bearer ${token}` },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: timeout.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    return isPlainObject(data) ? data : null;
  } catch {
    return null;
  } finally {
    timeout.done();
  }
}

// { role, canWrite, onlyThisLibrary } for a token (the stored one by default),
// or null when Hugging Face could not be asked (offline, or the token is dead).
export async function tokenAccess(token) {
  const value = cleanToken(token === undefined ? await getToken() : token);
  if (!value) return null;
  const whoami = await fetchWhoAmI(value);
  return whoami ? describeTokenAccess(whoami) : null;
}

// Resolves { ok, status, reason, user?, access?, libraryMissing? }. `access` is
// describeTokenAccess() of the token, or null when whoami could not be read.
export async function verifyToken(token) {
  const value = cleanToken(token);
  if (!value) return { ok: false, status: 0, reason: "unauthorized" };
  const whoami = fetchWhoAmI(value);
  const identity = async () => {
    const data = await whoami;
    return { user: typeof data?.name === "string" ? data.name : undefined, access: data ? describeTokenAccess(data) : null };
  };
  const timeout = withTimeout(VERIFY_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(LIBRARY_URL, {
      headers: { Authorization: `Bearer ${value}` },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: timeout.signal
    });
  } catch (error) {
    return { ok: false, status: 0, reason: networkReason(error) };
  } finally {
    timeout.done();
  }
  response.body?.cancel().catch(() => {});
  if (response.ok) return { ok: true, status: response.status, reason: "ok", ...(await identity()) };
  if (authFailure(response)) return { ok: false, status: response.status, reason: "unauthorized" };
  // The key works but nothing has been published yet.
  if (response.status === 404 && response.headers.get("x-error-code") === "EntryNotFound") {
    return { ok: true, status: response.status, reason: "ok", ...(await identity()), libraryMissing: true };
  }
  return { ok: false, status: response.status, reason: "error" };
}

// ---------------------------------------------------------------------------
// Library documents

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isValidLibrary(obj) {
  if (!isPlainObject(obj) || obj.schema !== LIBRARY_SCHEMA) return false;
  if (obj.app !== undefined && obj.app !== "acoustify") return false;
  for (const field of ["hub", "repo", "revision", "generated"]) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") return false;
  }
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) return false;
  const ids = new Set();
  for (const source of obj.sources) {
    if (!isPlainObject(source) || typeof source.id !== "string" || !source.id || ids.has(source.id)) return false;
    ids.add(source.id);
    if (typeof source.title !== "string") return false;
    if (!isPlainObject(source.audio) || typeof source.audio.path !== "string" || !source.audio.path) return false;
    if (source.art != null && (!isPlainObject(source.art) || typeof source.art.path !== "string")) return false;
    if (!Array.isArray(source.tracks) || source.tracks.length === 0) return false;
    for (const track of source.tracks) {
      if (!isPlainObject(track) || typeof track.id !== "string" || !Number.isFinite(track.start) || !Number.isFinite(track.end)) return false;
    }
  }
  return true;
}

export function libraryToCatalog(library) {
  const hub = library?.hub || HUB;
  const repo = library?.repo || CONFIG.REPO;
  const headRev = library?.revision || "main";
  const sources = (Array.isArray(library?.sources) ? library.sources : []).map((entry) => {
    const { audio, art, ...fields } = entry;
    const audioMeta = isPlainObject(audio) ? { ...audio } : null;
    const artMeta = isPlainObject(art) ? { ...art } : null;
    const artists = Array.isArray(fields.artists) && fields.artists.length ? [...fields.artists] : [fields.artist].filter(Boolean);
    // An album joined from a playlist has no video of its own; its public still is the first song's.
    const stillId = fields.youtubeId || (Array.isArray(fields.tracks) ? fields.tracks.find((track) => track?.youtubeId)?.youtubeId : "") || "";
    return {
      ...fields,
      provider: fields.provider || "local",
      artists,
      audio: audioMeta,
      art: artMeta,
      audioUrl: audioMeta?.path ? datasetFileUrl(hub, repo, audioMeta.rev || headRev, audioMeta.path) : null,
      artwork: artMeta?.path ? datasetFileUrl(hub, repo, artMeta.rev || headRev, artMeta.path) : null,
      fallbackArtwork: stillId ? `https://i.ytimg.com/vi/${stillId}/hqdefault.jpg` : DEFAULT_ARTWORK,
      bytes: Number(audioMeta?.bytes) || 0,
      sha256: audioMeta?.sha256 || ""
    };
  });
  return {
    version: library?.catalogVersion ?? null,
    revision: library?.revision || "",
    generated: library?.generated || "",
    sources
  };
}

function audioIdentity(source) {
  return source?.audio?.sha256 || `${source?.audio?.path || ""}@${source?.audio?.rev || ""}`;
}

export function diffLibraries(prev, next) {
  const before = new Map((Array.isArray(prev?.sources) ? prev.sources : []).map((source) => [source.id, source]));
  const after = Array.isArray(next?.sources) ? next.sources : [];
  const seen = new Set();
  const added = [];
  const changed = [];
  for (const source of after) {
    seen.add(source.id);
    const old = before.get(source.id);
    if (!old) added.push(source.id);
    else if (audioIdentity(old) !== audioIdentity(source) || JSON.stringify(old.tracks || []) !== JSON.stringify(source.tracks || [])) {
      changed.push(source.id);
    }
  }
  const removed = [...before.keys()].filter((id) => !seen.has(id));
  return { added, removed, changed };
}

export async function loadCachedLibrary() {
  try {
    const library = await getValue(LIBRARY_CACHE_KEY, null);
    return isValidLibrary(library) ? library : null;
  } catch {
    return null;
  }
}

export async function loadBundledLibrary() {
  try {
    const response = await fetch(CONFIG.BUNDLED_LIBRARY_URL, { cache: "no-cache" });
    if (!response.ok) return null;
    const library = await response.json();
    return isValidLibrary(library) ? library : null;
  } catch {
    return null;
  }
}

export async function fetchRemoteLibrary({ signal, token: given } = {}) {
  const token = given === undefined ? await getToken() : cleanToken(given);
  if (!token) return { library: null, status: "unauthorized", httpStatus: 0 };
  let response;
  try {
    response = await fetch(LIBRARY_URL, {
      headers: { Authorization: `Bearer ${token}` },
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal
    });
  } catch (error) {
    return { library: null, status: networkReason(error), httpStatus: 0 };
  }
  if (authFailure(response)) return { library: null, status: "unauthorized", httpStatus: response.status };
  if (!response.ok) return { library: null, status: "error", httpStatus: response.status };
  let library;
  try {
    library = await response.json();
  } catch (error) {
    return { library: null, status: error?.name === "AbortError" ? networkReason(error) : "error", httpStatus: response.status };
  }
  if (!isValidLibrary(library)) return { library: null, status: "error", httpStatus: response.status };
  await setValue(LIBRARY_CACHE_KEY, library).catch(() => {});
  return { library, status: "ok", httpStatus: response.status };
}

function sameVersion(a, b) {
  return Boolean(a && b) && (a.revision || "") === (b.revision || "") && (a.generated || "") === (b.generated || "");
}

function isOlder(candidate, current) {
  return Boolean(candidate?.generated && current?.generated) && candidate.generated < current.generated;
}

// Fills the service worker's artwork cache ahead of time, so covers that were
// never on screen while online still show offline (the whole library is about
// 3 MB). Library artwork only, only what is missing, never on Data Saver.
// Resolves { fetched, skipped, failed }.
export async function warmArtworkCache(urls, { signal, concurrency = ARTWORK_WARM_CONCURRENCY } = {}) {
  const result = { fetched: 0, skipped: 0, failed: 0 };
  if (typeof caches === "undefined" || globalThis.navigator?.connection?.saveData) return result;
  const wanted = [...new Set([...(urls || [])].filter(Boolean).map(absoluteUrl))].filter(isLibraryUrl);
  const token = wanted.length ? await getToken() : "";
  if (!token || signal?.aborted) return result;
  const cache = await caches.open(ART_CACHE);
  let next = 0;
  let rejected = false;
  const worker = async () => {
    while (next < wanted.length && !rejected && !signal?.aborted) {
      const url = wanted[next];
      next += 1;
      try {
        // Same key and match options as sw.js, so the worker serves these.
        if (await cache.match(url, { ignoreSearch: true, ignoreVary: true })) {
          result.skipped += 1;
          continue;
        }
        const response = await fetch(url, { headers: authHeaders(url, token), mode: "cors", credentials: "omit", priority: "low", signal });
        if (response.status !== 200) {
          response.body?.cancel().catch(() => {});
          result.failed += 1;
          // Every other cover would be refused the same way.
          if (authFailure(response)) rejected = true;
          continue;
        }
        await cache.put(url, response);
        result.fetched += 1;
      } catch {
        if (!signal?.aborted) result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), wanted.length) }, worker));
  return result;
}

export class LibrarySync extends EventTarget {
  #intervalMs;
  #minGapMs;
  #warmArtwork;
  #warmDelayMs;
  #library = null;
  #origin = "none";
  #state = "idle";
  #lastSyncedAt = 0;
  #hasToken = false;
  #lastAttemptAt = 0;
  #lastResult = null;
  #inflight = null;
  #tokenInUse = null;
  #abort = null;
  #timer = 0;
  #running = false;
  #detach = null;
  #warmTimer = 0;
  #warming = null;
  #warmedVersion = "";

  constructor({ intervalMs = 15 * 60_000, minGapMs = 60_000, warmArtwork = true, warmDelayMs = ARTWORK_WARM_DELAY_MS } = {}) {
    super();
    this.#intervalMs = intervalMs;
    this.#minGapMs = minGapMs;
    this.#warmArtwork = Boolean(warmArtwork);
    this.#warmDelayMs = Math.max(0, Number(warmDelayMs) || 0);
  }

  get library() {
    return this.#library;
  }

  get status() {
    return {
      state: this.#state,
      lastSyncedAt: this.#lastSyncedAt,
      revision: this.#library?.revision || "",
      origin: this.#origin,
      hasToken: this.#hasToken
    };
  }

  async start() {
    if (this.#running) return { library: this.#library, origin: this.#origin };
    this.#running = true;
    const [cached, syncedAt, token] = await Promise.all([
      loadCachedLibrary(),
      getValue(SYNCED_AT_KEY, 0).catch(() => 0),
      getToken()
    ]);
    this.#lastSyncedAt = Number(syncedAt) || 0;
    this.#hasToken = Boolean(token);
    if (cached) {
      this.#library = cached;
      this.#origin = "cache";
    } else {
      const bundled = await loadBundledLibrary();
      if (bundled) {
        this.#library = bundled;
        this.#origin = "bundled";
      }
    }
    this.#installAutoRefresh();
    this.#emitStatus();
    // Never hold the first paint for the network; catch up right after.
    setTimeout(() => this.#catchUp(), 0);
    return { library: this.#library, origin: this.#origin };
  }

  async refresh({ force = false } = {}) {
    const pending = this.#inflight;
    if (pending) {
      // Connected or disconnected while a sync was out: that sync's answer is
      // about the old key. Cut it short (it starts over with the new key) and
      // hand the caller a result for the key that is stored now.
      const token = await getToken();
      if (token === this.#tokenInUse) return pending;
      this.#abort?.abort();
      return pending.then((result) => (this.#tokenInUse === token ? result : this.refresh({ force: true })));
    }
    if (!force && this.#lastResult && Date.now() - this.#lastAttemptAt < this.#minGapMs) {
      return this.#lastResult === "updated" ? "unchanged" : this.#lastResult;
    }
    this.#inflight = this.#refreshNow().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  stop() {
    this.#running = false;
    this.#detach?.();
    this.#detach = null;
    this.#clearTimer();
    this.#abort?.abort();
    this.#stopWarming();
  }

  async #catchUp() {
    if (!this.#running) return;
    const result = await this.refresh({ force: true });
    // Without a reachable remote, a redeployed app may still ship a newer copy.
    if (this.#running && result !== "updated" && result !== "unchanged" && this.#origin !== "bundled") {
      const bundled = await loadBundledLibrary();
      if (bundled && this.#running && (!this.#library || (!sameVersion(bundled, this.#library) && !isOlder(bundled, this.#library)))) {
        this.#adopt(bundled, "bundled");
        this.#emitStatus();
      }
    }
  }

  async #refreshNow() {
    this.#lastAttemptAt = Date.now();
    for (;;) {
      const token = await getToken();
      this.#tokenInUse = token;
      this.#hasToken = Boolean(token);
      if (!token) {
        this.#stopWarming();
        return this.#finish("unauthorized");
      }
      if (isOffline()) return this.#finish("offline");
      this.#setState("syncing");
      const timeout = withTimeout(REMOTE_TIMEOUT_MS);
      this.#abort = timeout;
      let result;
      try {
        result = await fetchRemoteLibrary({ signal: timeout.signal, token });
      } finally {
        timeout.done();
        this.#abort = null;
      }
      if (!this.#running) return result.status === "ok" ? "unchanged" : result.status;
      // The key changed while the request was out: ask again with the new one.
      if ((await getToken()) !== token) continue;
      if (result.status !== "ok") {
        if (result.status === "unauthorized") this.#stopWarming();
        return this.#finish(result.status);
      }
      this.#lastSyncedAt = Date.now();
      setValue(SYNCED_AT_KEY, this.#lastSyncedAt).catch(() => {});
      const next = result.library;
      // A stale CDN copy must never roll a synced library back. The copy
      // bundled with the app is only a stand-in until the first sync (and can
      // be ahead of what is actually published), so the account's copy always
      // replaces it.
      const unchanged = sameVersion(next, this.#library) || (this.#origin !== "bundled" && isOlder(next, this.#library));
      if (!unchanged) this.#adopt(next, "network");
      this.#scheduleWarm();
      return this.#finish(unchanged ? "unchanged" : "updated");
    }
  }

  #scheduleWarm() {
    const library = this.#library;
    const version = library ? `${library.revision || ""}@${library.generated || ""}` : "";
    if (!this.#warmArtwork || !this.#running || !version || version === this.#warmedVersion || this.#warmTimer || this.#warming) return;
    this.#warmTimer = setTimeout(async () => {
      this.#warmTimer = 0;
      // A newer library arrived meanwhile: its own sync schedules the next pass.
      if (!this.#running || this.#library !== library) return;
      const controller = new AbortController();
      this.#warming = controller;
      try {
        const urls = libraryToCatalog(library).sources.map((source) => source.artwork);
        const { failed } = await warmArtworkCache(urls, { signal: controller.signal });
        if (!failed && !controller.signal.aborted) this.#warmedVersion = version;
      } catch {
        // Best effort: the next successful sync tries again.
      } finally {
        if (this.#warming === controller) this.#warming = null;
      }
    }, this.#warmDelayMs);
  }

  #stopWarming() {
    if (this.#warmTimer) clearTimeout(this.#warmTimer);
    this.#warmTimer = 0;
    this.#warming?.abort();
    this.#warming = null;
    // A later connect (maybe a different account) starts from scratch.
    this.#warmedVersion = "";
  }

  #adopt(library, origin) {
    const diff = diffLibraries(this.#library, library);
    this.#library = library;
    this.#origin = origin;
    this.dispatchEvent(new CustomEvent("library", { detail: { library, diff, origin } }));
  }

  #finish(result) {
    this.#lastResult = result;
    this.#setState(result === "updated" || result === "unchanged" ? "ok" : result);
    return result;
  }

  #setState(state) {
    this.#state = state;
    this.#emitStatus();
  }

  #emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
  }

  #installAutoRefresh() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const visible = () => document.visibilityState === "visible";
    const onVisible = () => {
      if (!visible()) {
        this.#clearTimer();
        return;
      }
      if (Date.now() - this.#lastAttemptAt >= this.#minGapMs) this.refresh({ force: true });
      this.#armTimer();
    };
    const onPageShow = (event) => {
      if (event.persisted) onVisible();
    };
    const onOnline = () => this.refresh({ force: true });
    const onOffline = () => {
      if (this.#state !== "syncing") this.#setState("offline");
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    this.#detach = () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    if (visible()) this.#armTimer();
  }

  #armTimer() {
    this.#clearTimer();
    if (!this.#running || !(this.#intervalMs > 0)) return;
    this.#timer = setTimeout(async () => {
      this.#timer = 0;
      if (!this.#running || document.visibilityState !== "visible") return;
      await this.refresh({ force: true });
      this.#armTimer();
    }, this.#intervalMs);
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = 0;
  }
}

// ---------------------------------------------------------------------------
// Playback helpers

const objectUrls = new Map();
const pendingBlobs = new Map();

async function waitForController(maxWaitMs = 3000) {
  const container = globalThis.navigator?.serviceWorker;
  if (!container) return false;
  if (container.controller) return true;
  let registration = null;
  try {
    registration = await container.getRegistration();
  } catch {
    return false;
  }
  if (!registration) return false;
  if (container.controller) return true;
  // An already-active worker that is not controlling means a hard reload
  // (Shift+Reload bypasses the worker): it will not take over this page.
  const wait = registration.active?.state === "activated" ? 300 : maxWaitMs;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", finish);
      resolve(Boolean(container.controller));
    };
    const timer = setTimeout(finish, wait);
    container.addEventListener("controllerchange", finish);
  });
}

async function fetchLibraryBlob(url) {
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(AUDIO_CACHE);
      const hit = await cache.match(url, { ignoreSearch: true, ignoreVary: true });
      if (hit) return await hit.blob();
    } catch {
      // Fall through to the network.
    }
  }
  const token = await getToken();
  const controller = new AbortController();
  const stall = stallGuard(controller);
  try {
    const response = await fetch(url, { headers: authHeaders(url, token), mode: "cors", credentials: "omit", signal: controller.signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw httpError(response.status, response.status === 401 ? "Connect your library to play this." : undefined);
    }
    if (!response.body?.getReader) {
      // No stream to watch for progress: only the wait for headers was guarded.
      stall.done();
      return await response.blob();
    }
    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      stall.touch();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "" });
  } catch (error) {
    // The player reads `kind` to say "check your connection" instead of a generic failure.
    if (isStall(error)) throw Object.assign(new Error("Couldn't reach your music. Check your connection and try again."), { kind: "network", cause: error });
    throw error;
  } finally {
    stall.done();
  }
}

function rememberObjectUrl(url, objectUrl) {
  objectUrls.delete(url);
  objectUrls.set(url, objectUrl);
  while (objectUrls.size > MAX_OBJECT_URLS) {
    const [oldest, oldUrl] = objectUrls.entries().next().value;
    objectUrls.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
}

export async function ensureStreamable(url) {
  if (!url || !isLibraryUrl(url)) return url;
  if (await waitForController()) return url;
  // No service worker to add the Authorization header: the media element
  // cannot send it, so play from an in-memory copy instead.
  const existing = objectUrls.get(url);
  if (existing) {
    rememberObjectUrl(url, existing);
    return existing;
  }
  if (!pendingBlobs.has(url)) {
    const pending = fetchLibraryBlob(url)
      .then((blob) => {
        const typed = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: "audio/mp4" });
        const objectUrl = URL.createObjectURL(typed);
        rememberObjectUrl(url, objectUrl);
        return objectUrl;
      })
      .finally(() => pendingBlobs.delete(url));
    pendingBlobs.set(url, pending);
  }
  return pendingBlobs.get(url);
}

const artworkMemo = new Map();

function fallbackArtworkImages(source) {
  const icon = absoluteUrl(DEFAULT_ARTWORK);
  const images = [];
  const fallback = source?.fallbackArtwork ? absoluteUrl(source.fallbackArtwork) : "";
  if (fallback && fallback !== icon) images.push({ src: fallback, sizes: "480x360", type: "image/jpeg" });
  images.push({ src: icon, sizes: "512x512", type: "image/png" });
  return images;
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Lock screens and OS media controls fetch artwork outside the page, without
// the service worker, so private artwork is handed over as a data URL.
async function renderArtwork(url) {
  const token = globalThis.navigator?.serviceWorker?.controller ? "" : await getToken();
  const response = await fetch(url, { headers: authHeaders(url, token), mode: "cors", credentials: "omit" });
  if (!response.ok) throw httpError(response.status);
  const image = await decodeImage(await response.blob());
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw new Error("Artwork has no size.");
  const canvas = document.createElement("canvas");
  canvas.width = ARTWORK_SIZE;
  canvas.height = ARTWORK_SIZE;
  const context = canvas.getContext("2d");
  const scale = Math.max(ARTWORK_SIZE / width, ARTWORK_SIZE / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  context.drawImage(image, (ARTWORK_SIZE - drawWidth) / 2, (ARTWORK_SIZE - drawHeight) / 2, drawWidth, drawHeight);
  image.close?.();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export async function mediaSessionArtwork(source) {
  const fallback = fallbackArtworkImages(source);
  if (!source?.artwork) return fallback;
  const url = absoluteUrl(source.artwork);
  if (!isLibraryUrl(url)) return [{ src: url }, ...fallback];
  if (artworkMemo.has(url)) {
    const memo = artworkMemo.get(url);
    artworkMemo.delete(url);
    artworkMemo.set(url, memo);
    return memo;
  }
  const pending = renderArtwork(url)
    .then((dataUrl) => [{ src: dataUrl, sizes: `${ARTWORK_SIZE}x${ARTWORK_SIZE}`, type: "image/jpeg" }])
    .catch(() => {
      artworkMemo.delete(url);
      return fallback;
    });
  artworkMemo.set(url, pending);
  while (artworkMemo.size > ARTWORK_MEMO_SIZE) artworkMemo.delete(artworkMemo.keys().next().value);
  return pending;
}

// ---------------------------------------------------------------------------
// Offline downloads

function cacheKey(url) {
  return absoluteUrl(url);
}

function downloadFailure(error) {
  if (error?.status === 401 || error?.status === 403) return { reason: "auth", message: "Connect your library to download music." };
  const text = `${error?.name || ""} ${error?.message || ""}`;
  if (/quota/i.test(text)) return { reason: "quota", message: "Storage is full. Remove a download and try again." };
  if (isStall(error)) return { reason: "offline", message: "The connection dropped. Try again when you're back online." };
  if (error?.name === "TypeError" || isOffline()) return { reason: "offline", message: "You're offline. Try again when you're connected." };
  return { reason: "error", message: error?.message || "The download failed." };
}

export class OfflineStore extends EventTarget {
  #done = new Set();
  #sourceIds = new Map();
  #active = new Map();
  #queued = new Map();
  #generation = 0;
  #persistRequested = false;
  #scanning = null;

  get supported() {
    return typeof caches !== "undefined";
  }

  // True while anything is downloading or waiting to: the queue lives only in
  // this page, so reloading it (e.g. to apply an app update) would drop it.
  get busy() {
    return this.#active.size > 0 || this.#queued.size > 0;
  }

  async init() {
    if (!this.#scanning) {
      this.#scanning = this.#scan().finally(() => {
        this.#scanning = null;
      });
    }
    return this.#scanning;
  }

  async #scan() {
    if (!this.supported) return;
    try {
      const cache = await caches.open(AUDIO_CACHE);
      const requests = await cache.keys();
      this.#done = new Set(requests.map((request) => request.url));
      await Promise.all(requests.map(async (request) => {
        const response = await cache.match(request);
        const sourceId = response?.headers.get("x-acoustify-source");
        if (sourceId) this.#sourceIds.set(request.url, decodeURIComponent(sourceId));
      }));
    } catch {
      // Storage unavailable (private mode); everything reads as not downloaded.
    }
  }

  isDownloaded(url) {
    return Boolean(url) && this.#done.has(cacheKey(url));
  }

  progress(url) {
    if (!url) return null;
    const key = cacheKey(url);
    const job = this.#active.get(key);
    if (job) return { loaded: job.loaded, total: job.total };
    if (this.#queued.has(key)) return { loaded: 0, total: this.#queued.get(key).total };
    return null;
  }

  stateOf(url) {
    if (!url) return "none";
    const key = cacheKey(url);
    if (this.#done.has(key)) return "done";
    if (this.#active.has(key)) return "downloading";
    if (this.#queued.has(key)) return "queued";
    return "none";
  }

  async download(source) {
    return (await this.#download(source)).ok;
  }

  async #download(source) {
    if (!source?.audioUrl) return { ok: false, reason: "error" };
    const key = cacheKey(source.audioUrl);
    // Only library recordings are downloadable (they are the only ones the token may fetch).
    if (!isLibraryUrl(key)) return { ok: false, reason: "error" };
    if (this.#done.has(key)) return { ok: true };
    const running = this.#active.get(key);
    if (running) return running.promise;
    this.#queued.delete(key);
    this.#sourceIds.set(key, source.id);
    if (!this.supported) {
      this.#emit(key, "error", { error: "Downloads need a secure (https) connection.", reason: "error" });
      return { ok: false, reason: "error" };
    }
    const job = { controller: new AbortController(), loaded: 0, total: Number(source.bytes || source.audio?.bytes) || 0 };
    job.promise = this.#run(key, source, job).finally(() => this.#active.delete(key));
    this.#active.set(key, job);
    return job.promise;
  }

  async #run(key, source, job) {
    this.#emit(key, "downloading", { loaded: 0, total: job.total });
    // cancel() aborts job.controller; a stalled connection aborts only the
    // transfer, so it reads as a failure rather than a cancellation.
    const transfer = new AbortController();
    const cancelTransfer = () => transfer.abort(job.controller.signal.reason);
    if (job.controller.signal.aborted) cancelTransfer();
    else job.controller.signal.addEventListener("abort", cancelTransfer, { once: true });
    const stall = stallGuard(transfer);
    try {
      const token = await getToken();
      const response = await fetch(key, {
        headers: authHeaders(key, token),
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: transfer.signal
      });
      if (!response.ok) throw httpError(response.status);
      const expected = Number(source.bytes || source.audio?.bytes) || 0;
      job.total = expected || Number(response.headers.get("content-length")) || 0;
      const chunks = [];
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        let lastEmit = 0;
        for (;;) {
          stall.touch();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          job.loaded += value.byteLength;
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
            lastEmit = now;
            this.#emit(key, "downloading", { loaded: job.loaded, total: job.total });
          }
        }
      } else {
        // No stream to watch for progress: only the wait for headers was guarded.
        stall.done();
        const buffer = await response.arrayBuffer();
        chunks.push(new Uint8Array(buffer));
        job.loaded = buffer.byteLength;
      }
      stall.done();
      if (expected && job.loaded !== expected) throw new Error("The download ended early. Try again.");
      const type = source.audio?.type || "audio/mp4";
      const blob = new Blob(chunks, { type });
      const cache = await caches.open(AUDIO_CACHE);
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      await cache.put(key, new Response(blob, {
        status: 200,
        headers: {
          "Content-Type": type,
          "Content-Length": String(blob.size),
          "Accept-Ranges": "bytes",
          "X-Acoustify-Source": encodeURIComponent(source.id || "")
        }
      }));
      // Cancel or Remove tapped while the file was being written: the write
      // cannot be interrupted, so undo it instead of reporting "Downloaded".
      if (job.controller.signal.aborted) {
        await cache.delete(key).catch(() => false);
        throw job.controller.signal.reason;
      }
      this.#done.add(key);
      this.#requestPersistence();
      this.#emit(key, "done", { loaded: blob.size, total: blob.size });
      return { ok: true };
    } catch (error) {
      if (job.controller.signal.aborted) {
        this.#emit(key, "cancelled", { loaded: job.loaded, total: job.total });
        return { ok: false, reason: "cancelled" };
      }
      const failure = downloadFailure(error);
      this.#emit(key, "error", { loaded: job.loaded, total: job.total, error: failure.message, reason: failure.reason });
      return { ok: false, reason: failure.reason };
    } finally {
      stall.done();
      job.controller.signal.removeEventListener("abort", cancelTransfer);
    }
  }

  async downloadMany(sources) {
    const generation = this.#generation;
    const pending = [];
    const seen = new Set();
    for (const source of Array.isArray(sources) ? sources : []) {
      if (!source?.audioUrl) continue;
      const key = cacheKey(source.audioUrl);
      if (seen.has(key) || this.#done.has(key) || !isLibraryUrl(key)) continue;
      seen.add(key);
      pending.push(source);
      if (!this.#active.has(key) && !this.#queued.has(key)) {
        const total = Number(source.bytes || source.audio?.bytes) || 0;
        this.#queued.set(key, { sourceId: source.id, total });
        this.#sourceIds.set(key, source.id);
        this.#emit(key, "queued", { loaded: 0, total });
      }
    }
    let completed = 0;
    let failed = 0;
    let stopReason = "";
    for (const source of pending) {
      if (generation !== this.#generation) break;
      const key = cacheKey(source.audioUrl);
      if (this.#done.has(key)) continue;
      if (!this.#queued.has(key) && !this.#active.has(key)) continue;
      const result = await this.#download(source);
      if (result.ok) completed += 1;
      else if (result.reason !== "cancelled") failed += 1;
      // These fail the same way for every remaining song; stop instead of repeating the error.
      if (result.reason === "auth" || result.reason === "quota" || result.reason === "offline") {
        stopReason = result.reason;
        break;
      }
    }
    for (const source of pending) {
      const key = cacheKey(source.audioUrl);
      if (this.#queued.delete(key)) this.#emit(key, "cancelled", { loaded: 0, total: 0 });
    }
    return { completed, failed, cancelled: generation !== this.#generation, reason: stopReason };
  }

  cancel(url) {
    if (!url) return;
    const key = cacheKey(url);
    if (this.#queued.delete(key)) this.#emit(key, "cancelled", { loaded: 0, total: 0 });
    this.#active.get(key)?.controller.abort();
  }

  cancelAll() {
    this.#generation += 1;
    for (const key of [...this.#queued.keys()]) {
      this.#queued.delete(key);
      this.#emit(key, "cancelled", { loaded: 0, total: 0 });
    }
    for (const job of this.#active.values()) job.controller.abort();
  }

  // Cancels the given downloads and waits until each has let go of its cache
  // entry, so a delete that follows cannot be overtaken by a finishing write.
  async #settle(jobs) {
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.promise));
  }

  async remove(url) {
    if (!url) return false;
    const key = cacheKey(url);
    const job = this.#active.get(key);
    this.cancel(url);
    if (job) await this.#settle([job]);
    let removed = false;
    if (this.supported) {
      try {
        const cache = await caches.open(AUDIO_CACHE);
        removed = await cache.delete(key, { ignoreSearch: true, ignoreVary: true });
      } catch {
        removed = false;
      }
    }
    if (this.#done.delete(key) || removed) this.#emit(key, "removed", { loaded: 0, total: 0 });
    return removed;
  }

  async removeAll() {
    const jobs = [...this.#active.values()];
    this.cancelAll();
    await this.#settle(jobs);
    if (!this.supported) return;
    const cache = await caches.open(AUDIO_CACHE);
    const requests = await cache.keys();
    for (const request of requests) {
      await cache.delete(request);
      this.#done.delete(request.url);
      this.#emit(request.url, "removed", { loaded: 0, total: 0 });
    }
    for (const key of [...this.#done]) {
      this.#done.delete(key);
      this.#emit(key, "removed", { loaded: 0, total: 0 });
    }
  }

  async prune(validUrls) {
    const keep = new Set([...(validUrls || [])].filter(Boolean).map(cacheKey));
    const dropped = [...this.#active].filter(([key]) => !keep.has(key)).map(([, job]) => job);
    for (const key of [...this.#queued.keys()]) {
      if (!keep.has(key)) this.cancel(key);
    }
    await this.#settle(dropped);
    if (!this.supported) return [];
    const removed = [];
    try {
      const cache = await caches.open(AUDIO_CACHE);
      for (const request of await cache.keys()) {
        if (keep.has(request.url)) continue;
        await cache.delete(request);
        this.#done.delete(request.url);
        removed.push(request.url);
        this.#emit(request.url, "removed", { loaded: 0, total: 0 });
      }
    } catch {
      // Leave storage alone if it cannot be read.
    }
    return removed;
  }

  async usage() {
    if (!this.supported) return { count: 0, bytes: 0 };
    try {
      const cache = await caches.open(AUDIO_CACHE);
      const requests = await cache.keys();
      let bytes = 0;
      for (const request of requests) {
        const response = await cache.match(request);
        const length = Number(response?.headers.get("content-length"));
        bytes += Number.isFinite(length) && length > 0 ? length : (await response?.blob())?.size || 0;
      }
      return { count: requests.length, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  #requestPersistence() {
    if (this.#persistRequested) return;
    this.#persistRequested = true;
    requestPersistentStorage().catch(() => false);
  }

  #emit(url, state, extra = {}) {
    this.dispatchEvent(new CustomEvent("change", {
      detail: { url, sourceId: this.#sourceIds.get(url) || "", state, loaded: 0, total: 0, error: null, ...extra }
    }));
  }
}
