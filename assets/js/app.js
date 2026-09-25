// Acoustify controller: app state, routing, the action registry, and the wiring
// between library sync, offline downloads, the player and the views.
// Markup lives in views/*.js and ui.js; this file decides what to show and when.
import { CONFIG } from "./config.js";
import {
  LibrarySync,
  OfflineStore,
  clearToken as clearStoredToken,
  diffLibraries,
  ensureStreamable,
  isLibraryUrl,
  libraryToCatalog,
  mediaSessionArtwork,
  setToken as storeToken,
  tokenAccess,
  verifyToken
} from "./cloud.js";
import { mergeCatalog, validateCatalog } from "./catalog.js";
import { clearAudioAssets, deleteAudioAsset, getAudioAsset, getValue, setValue } from "./db.js";
import { icon } from "./icons.js";
import { createNowPlaying } from "./nowplaying.js";
import { PlaybackController } from "./player.js";
import { actionSheet, confirmDialog, emptyState, html, initUI, promptDialog, skeletonGrid, toast } from "./ui.js";
import { clamp, debounce, deepClone, downloadJson, formatBytes, joinMeta, pluralize } from "./utils.js";
import { renderAlbum } from "./views/album.js";
import { renderArtist, renderArtists } from "./views/artists.js";
import { renderEdit } from "./views/edit.js";
import { renderHome } from "./views/home.js";
import { renderDownloads, renderHistory, renderLibrary, renderLiked } from "./views/library.js";
import { renderPlaylist } from "./views/playlist.js";
import { renderSearch } from "./views/search.js";
import { renderSeries, renderSeriesIndex } from "./views/series.js";
import { renderSettings } from "./views/settings.js";
import { renderSongs, sortSongs } from "./views/songs.js";

// ---------------------------------------------------------------------------
// Constants

const STATE_KEY = "app-state-v2"; // v2 name kept so likes, playlists and history carry over
const STATE_VERSION = 5;
const HISTORY_LIMIT = 500;
const SEEN_LIMIT = 4000;
const QUEUE_REGISTRY_LIMIT = 300;
const SCROLL_MEMORY_LIMIT = 60;
const SCROLL_STORAGE_KEY = "acoustify:scroll-v1";
const PLAYBACK_PERSIST_MS = 5000;
const UPDATE_CHECK_GAP_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
const AUTO_UPDATE_AFTER_LAUNCH_MS = 10_000;
const AUTO_UPDATE_AFTER_RESUME_MS = 20_000;
const TOAST_DEDUPE_MS = 3000;
const CONNECT_SYNC_WAIT_MS = 8000;
// A saved position this close to the end is a finished song, so it resumes from the start.
const RESUME_END_SLACK_S = 1.5;
const HOME_HASH = "#/home";
const CONNECT_HASH = "#/settings?focus=library";
const DESKTOP_QUERY = "(min-width: 1024px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REPEAT_MODES = ["off", "all", "one"];
const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.86,
  repeat: "off",
  shuffle: false,
  autoplay: true,
  playerPanelOpen: false,
  segmentLeadIn: 0.5,
  keepScreenAwake: false,
  autoDownload: false
});
const SETTING_TYPES = Object.freeze({
  volume: "number",
  repeat: "string",
  shuffle: "boolean",
  autoplay: "boolean",
  playerPanelOpen: "boolean",
  segmentLeadIn: "number",
  keepScreenAwake: "boolean",
  autoDownload: "boolean"
});
// What a stored song-time edit keeps. Everything else is re-derived from the
// library on each load, so a later publish can still fix artwork, audio, etc.
const OVERRIDE_FIELDS = [
  "id", "title", "artist", "artists", "series", "year", "provider", "youtubeId", "duration", "description", "tags",
  "added", "timingStatus", "timingNote", "assetId", "assetMeta", "localPlaybackFor", "restorePackagedSource", "youtubeFallback"
];
const USER_SOURCE_FIELDS = ["artwork", "fallbackArtwork", "audioUrl"];
const EDITABLE_FIELDS = ["title", "artist", "description", "year", "tags"];
// Top-level nav item for each route; routes without one keep the last tab lit.
const NAV_FOR_ROUTE = {
  home: "home",
  search: "search",
  songs: "songs",
  artists: "artists",
  artist: "artists",
  series: "artists",
  library: "library",
  liked: "liked",
  history: "history",
  downloads: "downloads",
  settings: "settings"
};
const TAB_FOR_NAV = { home: "home", search: "search", artists: "artists", library: "library", songs: "library", liked: "library", history: "library", downloads: "library" };
// The route each mobile tab opens at; tapping the current tab while below it returns here.
const TAB_ROOTS = { home: "home", search: "search", artists: "artists", library: "library" };
// Songs that moved to another album when the library was reorganised, so
// likes, playlists and history follow them instead of being pruned.
const TRACK_KEY_ALIASES = Object.freeze({
  "the-red-clay-strays-im-still-fine-live-at-the-ryman::im-still-fine": "the-red-clay-strays-live-at-the-ryman::im-still-fine"
});
const PLAY_HOOKS = [
  ["playSource", "source"],
  ["playArtist", "artist"],
  ["playSeries", "series"],
  ["playPlaylist", "playlist"],
  ["playLiked", "liked"],
  ["playHistory", "history"],
  ["playSongs", "songs"]
];
const PLAY_HOOK_SELECTOR = PLAY_HOOKS.map(([attribute]) => `[data-${attribute.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`).join(",");

const dom = {
  app: document.getElementById("app"),
  main: document.getElementById("main"),
  view: document.getElementById("view"),
  playlistNav: document.getElementById("playlist-nav"),
  playerBar: document.getElementById("player-bar"),
  nowPlaying: document.getElementById("now-playing"),
  audio: document.getElementById("local-audio"),
  playlistDialog: document.getElementById("dialog-playlist"),
  playlistForm: document.getElementById("playlist-form"),
  backupImport: document.getElementById("backup-import")
};

// ---------------------------------------------------------------------------
// Runtime state

let state = defaultState();
let seen = new Set();
let likedSet = new Set();

let library = null;
let libraryOrigin = "none";
let baseCatalog = { version: 0, sources: [] };
let catalog = mergeCatalog(baseCatalog, []);
let artworkAllowed = false;

let sync = null;
let offline = null;
let player = null;
let nowPlaying = null;

let ready = false;
let pendingLibraryEvent = null;
let pendingConnectLinkWarning = false;
let lastSyncStatus = null;
let warnedTokenRejected = false;
let checkedTokenAccess = false;
let lastAnnouncedUpdate = false;

let activeContext = null; // { type, id } of the list playback was started from
let unrecordedKey = null; // restored paused: counts as a play once it actually plays
let lastPlaybackPersistAt = 0;
let queueSeq = 0;
const queueRegistry = new Map();

let currentRoute = null;
let currentEntry = null; // { id, idx } stamped on each history entry
let renderedEntryIdx = 0;
let renderSeq = 0;
let viewCleanup = null;
let lastTab = "home";
const tabMemory = new Map(); // mobile tab → { hash, entryId } of the page it last showed
let pendingTabScroll = null; // { path, top } for the page a tab switch is about to show
let staleView = false;
let pendingSearchFocus = false;
const scrollMemory = loadScrollMemory();

const launchedAt = Date.now();
let returnedFromHiddenAt = 0;
let lastInteractionAt = 0;
let swRegistration = null;
let waitingWorker = null;
let updateToast = null;
let reloadOnControllerChange = false;
let lastUpdateCheckAt = 0;
let deferredInstallPrompt = null;
let installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const recentToasts = new Map();
let connectToast = null;

// ---------------------------------------------------------------------------
// Small helpers

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const enc = (value) => encodeURIComponent(String(value ?? ""));
const isDesktop = () => matchMedia(DESKTOP_QUERY).matches;
const prefersReducedMotion = () => matchMedia(REDUCED_MOTION_QUERY).matches;

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueStrings(values) {
  return Array.isArray(values) ? [...new Set(values.filter((value) => typeof value === "string" && value))] : [];
}

function pick(object, fields) {
  const out = {};
  for (const field of fields) if (object[field] !== undefined) out[field] = deepClone(object[field]);
  return out;
}

function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function isEditable(element) {
  if (!(element instanceof Element)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "reset", "submit", "file", "color", "image"].includes(element.type);
  }
  return false;
}

function notify(message, options = {}) {
  const opts = typeof options === "string" ? { type: options } : options || {};
  return toast(message, opts);
}

// The same failure can arrive from several places at once (player event,
// rejected promise, download queue); show it once.
function notifyOnce(message, options = {}) {
  const now = Date.now();
  const last = recentToasts.get(message);
  if (last && now - last < TOAST_DEDUPE_MS) return null;
  recentToasts.set(message, now);
  if (recentToasts.size > 20) recentToasts.delete(recentToasts.keys().next().value);
  return notify(message, options);
}

function reportError(error, fallback = "Something went wrong.") {
  if (error?.reported) return;
  console.error(error);
  notifyOnce(error?.message || fallback, { type: "error", duration: 5200 });
}

function runSafely(fn) {
  return Promise.resolve().then(fn).catch((error) => reportError(error));
}

// ---------------------------------------------------------------------------
// Persistent state

function defaultState() {
  return {
    version: STATE_VERSION,
    liked: [],
    history: [],
    playCounts: {},
    playlists: [],
    userSources: [],
    seenSources: null, // null until the first library arrives; then everything present counts as seen
    settings: { ...DEFAULT_SETTINGS },
    playback: emptyPlayback()
  };
}

function emptyPlayback() {
  return { trackKey: null, absolutePosition: 0, updatedAt: null, queue: [], context: null };
}

const CONTEXT_TYPES = new Set(["source", "artist", "series", "playlist", "liked", "history", "songs", "search"]);

function normalizeContext(input) {
  if (!isObject(input) || !CONTEXT_TYPES.has(input.type)) return null;
  return { type: input.type, id: typeof input.id === "string" ? input.id : "" };
}

// Backups are files anyone can hand over: a song-time edit or imported
// source may only point at the library, YouTube stills or this app's own
// files, never at an arbitrary host (a tracking beacon, or a URL the
// download code would send the token to).
function isSafeUserUrl(url, { image = false } = {}) {
  if (typeof url !== "string" || !url) return false;
  if (isLibraryUrl(url)) return true;
  let parsed;
  try {
    parsed = new URL(url, document.baseURI);
  } catch {
    return false;
  }
  if (image && parsed.protocol === "https:" && parsed.hostname === "i.ytimg.com") return true;
  return parsed.origin === location.origin;
}

function sanitizeUserSource(source) {
  const clean = { ...source };
  if (clean.audioUrl !== undefined && !isSafeUserUrl(clean.audioUrl)) delete clean.audioUrl;
  for (const field of ["artwork", "fallbackArtwork"]) {
    if (clean[field] !== undefined && clean[field] !== null && !isSafeUserUrl(clean[field], { image: true })) delete clean[field];
  }
  return clean;
}

function normalizeSettings(input, version) {
  const raw = isObject(input) ? input : {};
  const volume = Number(raw.volume);
  const leadIn = Number(raw.segmentLeadIn);
  let segmentLeadIn = Number.isFinite(leadIn) ? clamp(leadIn, 0, 5) : DEFAULT_SETTINGS.segmentLeadIn;
  // Cuts are song-start accurate since state v3, so the old 1.5 s default mostly
  // replayed pre-song talk. Only the untouched default is migrated.
  if (version < 3 && leadIn === 1.5) segmentLeadIn = 0.5;
  return {
    volume: Number.isFinite(volume) ? clamp(volume, 0, 1) : DEFAULT_SETTINGS.volume,
    repeat: REPEAT_MODES.includes(raw.repeat) ? raw.repeat : "off",
    shuffle: raw.shuffle === true,
    autoplay: raw.autoplay !== false,
    playerPanelOpen: raw.playerPanelOpen === true,
    segmentLeadIn,
    keepScreenAwake: raw.keepScreenAwake === true,
    autoDownload: raw.autoDownload === true
  };
}

function normalizePlaylists(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).filter(isObject).map((playlist) => {
    let id = typeof playlist.id === "string" && playlist.id ? playlist.id : uid();
    if (ids.has(id)) id = uid();
    ids.add(id);
    const now = Date.now();
    return {
      id,
      name: String(playlist.name ?? "").trim() || "Untitled playlist",
      description: String(playlist.description ?? "").trim(),
      trackKeys: uniqueStrings(playlist.trackKeys),
      createdAt: Number(playlist.createdAt) || now,
      updatedAt: Number(playlist.updatedAt) || now
    };
  });
}

function normalizeState(input) {
  const raw = isObject(input) ? input : {};
  const version = Number(raw.version) || 0;
  const playback = isObject(raw.playback) ? raw.playback : {};
  const position = Number(playback.absolutePosition);
  const playCounts = {};
  if (isObject(raw.playCounts)) {
    for (const [key, count] of Object.entries(raw.playCounts)) {
      if (Number(count) > 0) playCounts[key] = Math.floor(Number(count));
    }
  }
  return {
    version: STATE_VERSION,
    liked: uniqueStrings(raw.liked),
    history: (Array.isArray(raw.history) ? raw.history : [])
      .filter((entry) => isObject(entry) && typeof entry.trackKey === "string" && entry.trackKey)
      .map((entry) => ({ trackKey: entry.trackKey, playedAt: Number(entry.playedAt) || 0, position: Number(entry.position) || 0 }))
      .slice(0, HISTORY_LIMIT),
    playCounts,
    playlists: normalizePlaylists(raw.playlists),
    userSources: (Array.isArray(raw.userSources) ? raw.userSources : [])
      .filter((source) => isObject(source) && typeof source.id === "string" && source.id)
      .map(sanitizeUserSource),
    seenSources: Array.isArray(raw.seenSources) ? uniqueStrings(raw.seenSources).slice(-SEEN_LIMIT) : null,
    settings: normalizeSettings(raw.settings, version),
    playback: {
      trackKey: typeof playback.trackKey === "string" && playback.trackKey ? playback.trackKey : null,
      absolutePosition: Number.isFinite(position) && position >= 0 ? position : 0,
      updatedAt: Number(playback.updatedAt) || null,
      queue: uniqueStrings(playback.queue),
      context: normalizeContext(playback.context)
    }
  };
}

function adoptState(next) {
  state = next;
  seen = new Set(state.seenSources || []);
  likedSet = new Set(state.liked);
}

let persistWarned = false;

async function persistNow() {
  try {
    await setValue(STATE_KEY, state);
  } catch (error) {
    if (!persistWarned) {
      persistWarned = true;
      notify("Couldn't save your changes on this device.", { type: "error" });
    }
    throw error;
  }
}

const persistState = debounce(() => {
  persistNow().catch(() => {});
}, 250);

// ---------------------------------------------------------------------------
// Catalog

// Library artwork is private: without a working token every request is a 401,
// so pages use the public YouTube stills until the library is connected.
function canLoadLibraryArtwork(status = getSyncStatus()) {
  return Boolean(status?.hasToken) && status.state !== "unauthorized";
}

function withoutLibraryArtwork(source) {
  return source.artwork && isLibraryUrl(source.artwork) ? { ...source, artwork: null } : source;
}

function rebuildCatalog() {
  try {
    baseCatalog = library ? libraryToCatalog(library) : { version: 0, sources: [] };
  } catch (error) {
    console.error("The library could not be read.", error);
    baseCatalog = { version: 0, sources: [] };
  }
  artworkAllowed = canLoadLibraryArtwork();
  if (!artworkAllowed) baseCatalog = { ...baseCatalog, sources: baseCatalog.sources.map(withoutLibraryArtwork) };
  catalog = mergeCatalog(baseCatalog, state.userSources);
  // A bundled copy can be older than the account's library; only prune saved
  // references against a library that came from (or was cached from) the network.
  if (catalog.sources.length && libraryOrigin !== "bundled" && libraryOrigin !== "none") {
    migrateTrackKeys();
    pruneReferences();
  }
  if (state.seenSources === null && catalog.sources.length) {
    state.seenSources = catalog.sources.map((source) => source.id);
    seen = new Set(state.seenSources);
    persistState();
  }
}

// Only once the library really has the new key and no longer has the old one,
// so a device still on the previous publish keeps what it has.
function migrateTrackKeys() {
  const moves = new Map(Object.entries(TRACK_KEY_ALIASES)
    .filter(([from, to]) => !catalog.trackByKey.has(from) && catalog.trackByKey.has(to)));
  if (!moves.size) return;
  let changed = false;
  const moveAll = (keys) => {
    if (!keys.some((key) => moves.has(key))) return keys;
    changed = true;
    return uniqueStrings(keys.map((key) => moves.get(key) || key));
  };
  state.liked = moveAll(state.liked);
  likedSet = new Set(state.liked);
  for (const entry of state.history) {
    if (!moves.has(entry.trackKey)) continue;
    entry.trackKey = moves.get(entry.trackKey);
    changed = true;
  }
  for (const [from, to] of moves) {
    if (!state.playCounts[from]) continue;
    state.playCounts[to] = playCount(to) + state.playCounts[from];
    delete state.playCounts[from];
    changed = true;
  }
  for (const playlist of state.playlists) playlist.trackKeys = moveAll(playlist.trackKeys);
  const { playback } = state;
  playback.queue = moveAll(playback.queue);
  if (moves.has(playback.trackKey)) {
    // The song sits at a different point in the new recording.
    playback.trackKey = moves.get(playback.trackKey);
    playback.absolutePosition = 0;
    changed = true;
  }
  if (changed) persistState();
}

function pruneReferences() {
  const valid = catalog.trackByKey;
  const keep = (key) => valid.has(key);
  let changed = false;
  const liked = state.liked.filter(keep);
  if (liked.length !== state.liked.length) {
    state.liked = liked;
    likedSet = new Set(liked);
    changed = true;
  }
  const history = state.history.filter((entry) => keep(entry.trackKey));
  if (history.length !== state.history.length) {
    state.history = history;
    changed = true;
  }
  for (const playlist of state.playlists) {
    const keys = playlist.trackKeys.filter(keep);
    if (keys.length !== playlist.trackKeys.length) {
      playlist.trackKeys = keys;
      changed = true;
    }
  }
  const queue = state.playback.queue.filter(keep);
  if (queue.length !== state.playback.queue.length) {
    state.playback.queue = queue;
    changed = true;
  }
  if (state.playback.trackKey && !keep(state.playback.trackKey)) {
    state.playback = emptyPlayback();
    changed = true;
  }
  if (changed) persistState();
}

const trackFor = (key) => (key ? catalog.trackByKey.get(key) || null : null);
const sourceFor = (id) => (id ? catalog.sourceById.get(id) || null : null);
const isCatalogTrack = (track) => Boolean(track?.key && catalog.trackByKey.has(track.key));
const hasOverride = (sourceId) => state.userSources.some((source) => source.id === sourceId);
const isPackaged = (sourceId) => baseCatalog.sources.some((source) => source.id === sourceId);

function seriesSlugFor(source) {
  if (!source?.series) return "";
  return source.seriesSlug || catalog.series.find((item) => item.name === source.series)?.slug || "";
}

// ---------------------------------------------------------------------------
// ctx helpers (§11)

function registerQueue(prefix, tracks) {
  const keys = (Array.isArray(tracks) ? tracks : [])
    .map((track) => (typeof track === "string" ? track : track?.key))
    .filter(Boolean);
  queueSeq += 1;
  const id = `${String(prefix || "q").replace(/[^\w-]/g, "").slice(0, 40) || "q"}-${queueSeq.toString(36)}`;
  queueRegistry.set(id, keys);
  while (queueRegistry.size > QUEUE_REGISTRY_LIMIT) queueRegistry.delete(queueRegistry.keys().next().value);
  return id;
}

function isNew(sourceId) {
  if (state.seenSources === null || seen.has(sourceId)) return false;
  const source = sourceFor(sourceId);
  return Boolean(source && !source.userSource);
}

function markSeen(sourceId) {
  if (!sourceId || state.seenSources === null || seen.has(sourceId)) return;
  seen.add(sourceId);
  state.seenSources.push(sourceId);
  if (state.seenSources.length > SEEN_LIMIT) state.seenSources.splice(0, state.seenSources.length - SEEN_LIMIT);
  persistState();
}

function playCount(key) {
  return Number(state.playCounts[key]) || 0;
}

function recentTracks(limit = 20) {
  const max = Number.isFinite(limit) ? limit : Infinity;
  const picked = new Set();
  const result = [];
  for (const entry of state.history) {
    if (result.length >= max) break;
    if (picked.has(entry.trackKey)) continue;
    const track = trackFor(entry.trackKey);
    if (!track) continue;
    picked.add(entry.trackKey);
    result.push({ ...track, playedAt: entry.playedAt, savedPosition: entry.position });
  }
  return result;
}

function recentSources(limit = 8) {
  const max = Number.isFinite(limit) ? limit : Infinity;
  const picked = new Set();
  const result = [];
  for (const entry of state.history) {
    if (result.length >= max) break;
    const track = trackFor(entry.trackKey);
    if (!track || picked.has(track.sourceId)) continue;
    const source = sourceFor(track.sourceId);
    if (!source) continue;
    picked.add(source.id);
    result.push(source);
  }
  return result;
}

// The saved track and where it resumes (`position` is absolute, null = from
// the start). A queue that ran out parks on the last song's final moment;
// that song counts as finished and plays again from the top.
function resumeInfo() {
  const track = trackFor(state.playback.trackKey);
  const source = track ? sourceFor(track.sourceId) : null;
  if (!track || !source) return null;
  const saved = Number(state.playback.absolutePosition) || track.start;
  const finished = saved >= track.end - RESUME_END_SLACK_S;
  const position = finished ? null : saved;
  const elapsed = finished ? 0 : clamp(saved - track.start, 0, Math.max(0, track.end - track.start));
  return { track, source, elapsed, position };
}

// ctx.resume(): only a cold start has something to resume. Once the player
// holds a track, the mini player and player bar are the way back to it
// (Home folds its "Continue listening" card away then).
function resumeOffer() {
  return player?.currentTrack ? null : resumeInfo();
}

function savedQueueFor(track) {
  return state.playback.queue.includes(track.key) ? state.playback.queue : null;
}

function topTracksForArtist(slug, limit = 5) {
  const artist = catalog.artistBySlug.get(slug);
  if (!artist) return [];
  const order = new Map(catalog.sourcesByAdded.map((source, index) => [source.id, index]));
  const tracks = [...new Set(artist.trackKeys)].map(trackFor).filter(Boolean);
  tracks.sort((a, b) => playCount(b.key) - playCount(a.key) || order.get(a.sourceId) - order.get(b.sourceId) || a.index - b.index);
  return Number.isFinite(limit) ? tracks.slice(0, Math.max(0, limit)) : tracks;
}

function canDownload(source) {
  return Boolean(offline?.supported !== false && source?.audioUrl && isLibraryUrl(source.audioUrl) && source.provider !== "youtube");
}

function downloadState(sourceId) {
  const source = sourceFor(sourceId);
  if (!canDownload(source) || !offline) return { state: "none", progress: 0, available: false };
  const url = source.audioUrl;
  if (offline.isDownloaded(url)) return { state: "done", progress: 1, available: true };
  const progress = offline.progress(url);
  const current = typeof offline.stateOf === "function" ? offline.stateOf(url) : progress ? "downloading" : "none";
  if (current === "queued") return { state: "queued", progress: 0, available: true };
  if (current === "downloading" || progress) {
    const fraction = progress?.total ? clamp(progress.loaded / progress.total, 0, 1) : 0;
    return { state: "downloading", progress: fraction, available: true };
  }
  return { state: "none", progress: 0, available: true };
}

function isOfflineReady(sourceId) {
  const source = sourceFor(sourceId);
  if (!source || source.provider === "youtube") return false;
  if (source.assetId) return true;
  return Boolean(source.audioUrl && offline?.isDownloaded(source.audioUrl));
}

// { count, bytes } of downloaded music; falls back to the library's sizes when
// Cache Storage can't be read.
async function storageUsage() {
  const usage = await offline?.usage?.().catch(() => null);
  if (usage?.bytes) return usage;
  const done = catalog.sources.filter((source) => source.audioUrl && offline?.isDownloaded(source.audioUrl));
  return { count: done.length, bytes: done.reduce((sum, source) => sum + (Number(source.bytes) || 0), 0) };
}

function currentTrackKey() {
  return player?.currentTrack?.key || state.playback.trackKey || null;
}

function getSyncStatus() {
  return sync?.status || { state: "idle", lastSyncedAt: 0, revision: "", origin: libraryOrigin, hasToken: false };
}

function buildCtx() {
  return {
    state,
    settings: state.settings,
    catalog,
    player,
    syncStatus: getSyncStatus(),
    // Network status (home.js reads it as a boolean). The download store is ctx.downloads.
    offline: !navigator.onLine,
    online: navigator.onLine,
    downloads: offline,
    storageUsage,
    appVersion: CONFIG.APP_VERSION,
    install: { installed, canPrompt: Boolean(deferredInstallPrompt) && !installed },
    updateWaiting: Boolean(waitingWorker),
    registerQueue,
    isNew,
    isLiked: (key) => likedSet.has(key),
    likedKeys: likedSet,
    downloadState,
    playCount,
    recentSources,
    recentTracks,
    resume: resumeOffer,
    topTracksForArtist,
    currentKey: currentTrackKey(),
    isPlaying: Boolean(player?.isPlaying),
    navigate: (hash) => navigate(hash),
    actions: ctxActions
  };
}

const ctxActions = Object.freeze({
  toast: (message, options) => notify(message, options),
  confirm: (options) => confirmDialog(options),
  prompt: (options) => promptDialog(options),
  saveSourceOverride: (source) => saveSourceOverride(source),
  resetSource: (sourceId) => resetSource(sourceId),
  setToken: (token) => connectLibrary(token),
  clearToken: () => disconnectLibrary(),
  syncNow: () => syncNow(),
  playCalibration: (sourceId) => playCalibration(sourceId),
  setSetting: (key, value) => setSetting(key, value)
});

// ---------------------------------------------------------------------------
// Routing

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRoute(hash = location.hash) {
  const text = String(hash || "").replace(/^#\/?/, "");
  const split = text.indexOf("?");
  const path = split >= 0 ? text.slice(0, split) : text;
  const query = split >= 0 ? text.slice(split + 1) : "";
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  return { name: segments[0] || "home", segments, params: new URLSearchParams(query), key: `${path || "home"}?${query}` };
}

function normalizeHash(hash) {
  const text = String(hash || "");
  if (text.startsWith("#")) return text;
  return `#/${text.replace(/^\/+/, "")}`;
}

function redirectFor(route) {
  const hash = location.hash;
  if (!hash || hash === "#" || hash === "#/") return HOME_HASH;
  const id = route.segments[1];
  switch (route.name) {
    case "source": // v2 album route
      return id ? `#/album/${enc(id)}` : HOME_HASH;
    case "studio": { // v2 add/edit route; adding music is now done by the publish tools
      const sourceId = route.params.get("source");
      return sourceId ? `#/edit/${enc(sourceId)}` : HOME_HASH;
    }
    case "album":
      return id ? null : "#/library?tab=albums";
    case "artist":
      return id ? null : "#/artists";
    case "playlist":
      return id ? null : "#/library?tab=playlists";
    case "edit":
      return id ? null : HOME_HASH;
    default:
      return null;
  }
}

// #/connect?token= links are not honoured: the browser has already written
// the token into its (synced) history, where scrubbing the address bar can't
// reach it. Clear the address bar before anything else runs, drop the token,
// and send the listener to the paste field with a warning.
function consumeConnectLink() {
  const route = parseRoute(location.hash);
  if (route.name !== "connect") return;
  const hadToken = Boolean((route.params.get("token") || "").trim());
  history.replaceState(history.state, "", CONNECT_HASH);
  if (hadToken) pendingConnectLinkWarning = true;
}

function resolveRoute() {
  let route = parseRoute(location.hash);
  const redirect = redirectFor(route);
  if (redirect) {
    history.replaceState(history.state, "", redirect);
    route = parseRoute(redirect);
  }
  return route;
}

function navigate(hash, { replace = false, remember = true } = {}) {
  const target = normalizeHash(hash);
  if (remember) rememberTab();
  if (replace) {
    history.replaceState(history.state, "", target);
    if (currentEntry) scrollMemory.delete(currentEntry.id);
    renderRoute({ mode: "navigate" });
    return;
  }
  if (target === location.hash) {
    renderRoute({ mode: "navigate" });
    return;
  }
  restamp();
  location.hash = target;
}

function goBack() {
  if ((currentEntry?.idx ?? 0) > 0) history.back();
  else navigate(HOME_HASH, { replace: true });
}

// Mobile tab bar: like iOS, each tab keeps the page it was showing (and its
// scroll), and its root page's own state: Search its query, Library its tab.
const routePath = (route) => route.segments.join("/");

function rememberTab() {
  if (!currentRoute || !currentEntry || transitionPending) return;
  // Only when the address bar shows the page on screen (it can already point
  // at the next page while a navigation is on its way).
  if (routePath(parseRoute(location.hash)) !== routePath(currentRoute)) return;
  const page = { hash: location.hash || HOME_HASH, entryId: currentEntry.id };
  const atRoot = currentRoute.name === TAB_ROOTS[lastTab];
  tabMemory.set(lastTab, { ...page, root: atRoot ? page : tabMemory.get(lastTab)?.root || null });
}

function showTabPage(tab, page, fallbackHash) {
  const target = page?.hash || fallbackHash;
  pendingTabScroll = { path: routePath(parseRoute(target)), top: (page && scrollMemory.get(page.entryId)) || 0 };
  // Pages without a tab of their own (albums, playlists) light the tab they were opened from.
  lastTab = tab;
  navigate(target, { remember: false });
}

function openTab(tab, rootHash) {
  if (!currentRoute || !TAB_ROOTS[tab]) {
    navigate(rootHash);
    return;
  }
  rememberTab();
  const memory = tabMemory.get(tab);
  if (tab !== lastTab) {
    showTabPage(tab, memory, rootHash);
  } else if (currentRoute.name !== TAB_ROOTS[tab]) {
    showTabPage(tab, memory?.root, rootHash); // back to the tab's first page
  } else if (readScroll() > 4) {
    writeScroll(0, prefersReducedMotion() ? "instant" : "smooth");
  } else if (tab === "search") {
    focusSearchInput();
  }
}

function takeTabScroll(route) {
  const pending = pendingTabScroll;
  pendingTabScroll = null;
  return pending && pending.path === routePath(route) ? pending.top : 0;
}

// History entries carry { id, idx } so back/forward can restore scroll and a
// fresh navigation can start at the top. Other code may replace the state
// (search syncs ?q=), so the stamp is re-applied before leaving an entry.
function writeStamp() {
  const base = isObject(history.state) ? history.state : {};
  history.replaceState({ ...base, acoustify: currentEntry }, "");
}

function restamp() {
  if (currentEntry && history.state?.acoustify?.id !== currentEntry.id) writeStamp();
}

function initHistoryEntry() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const stamped = history.state?.acoustify;
  currentEntry = stamped?.id ? { id: stamped.id, idx: Number(stamped.idx) || 0 } : { id: uid(), idx: 0 };
  if (!stamped?.id) writeStamp();
  renderedEntryIdx = currentEntry.idx;
}

function onHashChange() {
  saveScroll();
  consumeConnectLink();
  const stamped = history.state?.acoustify;
  let mode = "navigate";
  let direction = "forward";
  if (stamped?.id) {
    currentEntry = { id: stamped.id, idx: Number(stamped.idx) || 0 };
    mode = "restore";
    direction = currentEntry.idx < renderedEntryIdx ? "back" : "forward";
  } else {
    currentEntry = { id: uid(), idx: (currentEntry?.idx ?? -1) + 1 };
    writeStamp();
  }
  renderRoute({ mode, direction });
  warnAboutConnectLink();
}

// ---------------------------------------------------------------------------
// Scroll memory

function loadScrollMemory() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SCROLL_STORAGE_KEY) || "[]");
    return new Map(Array.isArray(stored) ? stored.filter((entry) => Array.isArray(entry) && entry.length === 2) : []);
  } catch {
    return new Map();
  }
}

function storeScrollMemory() {
  try {
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify([...scrollMemory].slice(-SCROLL_MEMORY_LIMIT)));
  } catch {
    // Private mode or storage disabled: scroll memory just lasts for this page.
  }
}

function readScroll() {
  return Math.max(dom.main?.scrollTop || 0, document.scrollingElement?.scrollTop || 0);
}

// #main scrolls in the shipped layout; the document is set too so a layout
// change in CSS never silently breaks restoration.
function writeScroll(top, behavior = "instant") {
  for (const element of [dom.main, document.scrollingElement]) {
    if (!element) continue;
    try {
      element.scrollTo({ top, left: 0, behavior });
    } catch {
      element.scrollTop = top;
    }
  }
}

function saveScroll() {
  if (!currentEntry) return;
  scrollMemory.delete(currentEntry.id);
  scrollMemory.set(currentEntry.id, readScroll());
  while (scrollMemory.size > SCROLL_MEMORY_LIMIT) scrollMemory.delete(scrollMemory.keys().next().value);
}

let scrollFrame = 0;
function onAnyScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    saveScroll();
  });
}

// ---------------------------------------------------------------------------
// Rendering

const VIEWS = {
  home: (ctx, route) => renderHome(ctx, route),
  search: (ctx, route) => renderSearch(ctx, route),
  songs: (ctx, route) => renderSongs(ctx, route),
  artists: (ctx, route) => renderArtists(ctx, route),
  artist: (ctx, route) => renderArtist(ctx, route, route.segments[1]),
  series: (ctx, route) => (route.segments[1] ? renderSeries(ctx, route, route.segments[1]) : renderSeriesIndex(ctx, route)),
  library: (ctx, route) => renderLibrary(ctx, route),
  liked: (ctx, route) => renderLiked(ctx, route),
  history: (ctx, route) => renderHistory(ctx, route),
  downloads: (ctx, route) => renderDownloads(ctx, route),
  album: (ctx, route) => renderAlbum(ctx, route, route.segments[1]),
  playlist: (ctx, route) => renderPlaylist(ctx, route, route.segments[1]),
  settings: (ctx, route) => renderSettings(ctx, route),
  edit: (ctx, route) => renderEdit(ctx, route, route.segments[1])
};

function messageView(title, { iconName, heading, body, actionHtml }) {
  return { title, html: html`<div class="page">${emptyState({ iconName, title: heading, body, actionHtml })}</div>` };
}

function notFoundView() {
  return messageView("Not found", {
    iconName: "alert",
    heading: "Page not found",
    body: "That page doesn't exist anymore.",
    actionHtml: html`<a class="btn btn-primary" href="#/home">Go home</a>`
  });
}

function errorView() {
  return messageView("Something went wrong", {
    iconName: "alert",
    heading: "Something went wrong",
    body: "This page couldn't be shown. Reloading usually fixes it.",
    actionHtml: html`<button class="btn btn-primary" type="button" data-action="reload-app">Reload</button>`
  });
}

function renderView(ctx, route) {
  const view = VIEWS[route.name];
  if (!view) return notFoundView();
  try {
    const result = view(ctx, route);
    if (!result || typeof result !== "object") throw new Error(`The ${route.name} view returned nothing.`);
    return result;
  } catch (error) {
    console.error(error);
    return errorView();
  }
}

function runViewCleanup() {
  const cleanup = viewCleanup;
  viewCleanup = null;
  if (typeof cleanup !== "function") return;
  try {
    cleanup();
  } catch (error) {
    console.error(error);
  }
}

function runViewAfter(result, seq) {
  if (typeof result.after !== "function") return;
  let cleanup;
  try {
    cleanup = result.after(dom.view);
  } catch (error) {
    console.error(error);
    return;
  }
  if (typeof cleanup?.then === "function") {
    cleanup.then((fn) => {
      if (typeof fn !== "function") return;
      if (seq === renderSeq) viewCleanup = fn;
      else fn();
    }, (error) => console.error(error));
  } else if (typeof cleanup === "function") {
    viewCleanup = cleanup;
  }
}

// Every page gets exactly one h1 (screen readers and focusHeading rely on it);
// pages that are only an empty state ("Artist not found") promote its title.
function ensurePageHeading() {
  if (dom.view.querySelector("h1")) return;
  const title = dom.view.querySelector(".empty-title");
  if (!title) return;
  const heading = document.createElement("h1");
  heading.className = title.className;
  heading.innerHTML = title.innerHTML;
  title.replaceWith(heading);
}

function focusHeading() {
  const heading = dom.view.querySelector("h1");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

// A background re-render should not strand keyboard focus on <body>.
function focusDescriptor() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !dom.view.contains(element)) return null;
  const attributes = ["data-action", "data-track-key", "data-like-key", "data-source-id", "data-playlist-id", "data-download-source", "href"];
  const parts = attributes
    .filter((name) => element.hasAttribute(name))
    .map((name) => `[${name}="${CSS.escape(element.getAttribute(name))}"]`);
  return parts.length ? `${element.tagName.toLowerCase()}${parts.join("")}` : null;
}

function restoreFocus(selector) {
  try {
    dom.view.querySelector(selector)?.focus({ preventScroll: true });
  } catch {
    // Selector built from unusual attribute values; losing focus is acceptable.
  }
}

function shouldAnimate(mode) {
  return (mode === "navigate" || mode === "restore")
    && typeof document.startViewTransition === "function"
    && document.visibilityState === "visible"
    && !prefersReducedMotion();
}

const supportsTransitionTypes = (() => {
  try {
    return typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype;
  } catch {
    return false;
  }
})();

function withViewTransition(update, direction) {
  let transition;
  try {
    transition = supportsTransitionTypes
      ? document.startViewTransition({ update, types: [direction === "back" ? "nav-back" : "nav-forward"] })
      : document.startViewTransition(update);
  } catch {
    update();
    return;
  }
  transition.ready?.catch(() => {});
  transition.finished?.catch(() => {});
  transition.updateCallbackDone?.catch((error) => console.error(error));
}

function pageTitle(title) {
  const text = String(title ?? "").trim();
  return text && text !== "Acoustify" ? `${text} · Acoustify` : "Acoustify";
}

function renderRoute({ mode = "navigate", direction = "forward" } = {}) {
  const route = resolveRoute();
  currentRoute = route;
  staleView = false;
  const result = renderView(buildCtx(), route);
  const seq = ++renderSeq;
  const entryIdx = currentEntry?.idx ?? 0;
  const scrollTop = mode === "refresh" ? readScroll() : mode === "navigate" ? takeTabScroll(route) : scrollMemory.get(currentEntry?.id) ?? 0;
  const focusSelector = mode === "refresh" ? focusDescriptor() : null;

  const commit = () => {
    if (seq !== renderSeq) return; // a newer render already replaced this one
    transitionPending = false;
    runViewCleanup();
    dom.view.innerHTML = String(result.html ?? "");
    document.title = pageTitle(result.title);
    ensurePageHeading();
    renderedEntryIdx = entryIdx;
    updateNav(route);
    writeScroll(scrollTop);
    if (mode === "navigate" || mode === "restore") focusHeading();
    else if (focusSelector) restoreFocus(focusSelector);
    syncLiveState(dom.view);
    runViewAfter(result, seq);
    afterRouteShown(route);
    rememberTab();
    if (refreshAfterCommit) {
      refreshAfterCommit = false;
      scheduleRefresh();
    }
  };

  if (shouldAnimate(mode)) {
    transitionPending = true;
    withViewTransition(commit, direction);
  } else {
    commit();
  }
}

function afterRouteShown(route) {
  if (route.name === "album") markSeen(route.segments[1]);
  // ?focus= is a one-shot request: drop it so background re-renders (sync
  // status, downloads) don't pull focus back into the token field.
  if (route.params.has("focus")) {
    const params = new URLSearchParams(route.params);
    params.delete("focus");
    const query = params.toString();
    history.replaceState(history.state, "", `#/${route.segments.map(enc).join("/")}${query ? `?${query}` : ""}`);
  }
  if (pendingSearchFocus && route.name === "search") {
    pendingSearchFocus = false;
    focusSearchInput();
  }
}

// Views read ctx at render time, so data changes re-render the visible route
// in place (scroll kept). Routes where the listener is typing wait instead.
let refreshFrame = 0;
let refreshAll = false;
let refreshRoutes = new Set();
// While a navigation's view transition waits to swap the DOM, a refresh would
// render the new route with the old page's scroll; it runs after the swap instead.
let transitionPending = false;
let refreshAfterCommit = false;

function routeMatches(route, names) {
  if (names.has(route.name)) return true;
  return route.name === "library" && route.params.get("tab") === "downloads" && names.has("downloads");
}

function isUserBusyInView() {
  if (currentRoute?.name === "edit") return true;
  return isEditable(document.activeElement) && dom.view.contains(document.activeElement);
}

function scheduleRefresh(routes = null) {
  if (!routes) refreshAll = true;
  else for (const name of routes) refreshRoutes.add(name);
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    const all = refreshAll;
    const names = refreshRoutes;
    refreshAll = false;
    refreshRoutes = new Set();
    if (!ready || !currentRoute) return;
    if (!all && !routeMatches(currentRoute, names)) return;
    if (transitionPending) {
      refreshAfterCommit = true;
      return;
    }
    if (isUserBusyInView()) {
      staleView = true;
      return;
    }
    renderRoute({ mode: "refresh" });
  });
}

// Catch up on a deferred refresh once the listener has left the input, but
// never swap the DOM under a tap that is still in progress.
let pointerIsDown = false;

function onViewFocusOut() {
  if (!staleView) return;
  setTimeout(() => {
    if (staleView && !pointerIsDown && !isUserBusyInView()) scheduleRefresh();
  }, 600);
}

function updateNav(route) {
  const navKey = route.name === "library" && route.params.get("tab") === "downloads" ? "downloads" : NAV_FOR_ROUTE[route.name] || null;
  const tabKey = (navKey && TAB_FOR_NAV[navKey]) || (route.name === "playlist" ? "library" : lastTab);
  lastTab = tabKey;
  for (const link of document.querySelectorAll("[data-nav]")) {
    const active = link.closest("#tabbar") ? link.dataset.nav === tabKey : link.dataset.nav === navKey;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const playlistId = route.name === "playlist" ? route.segments[1] : null;
  for (const link of dom.playlistNav?.querySelectorAll("[data-playlist-nav]") ?? []) {
    const active = link.dataset.playlistNav === playlistId;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function renderPlaylistNav() {
  if (!dom.playlistNav) return;
  dom.playlistNav.innerHTML = String(html`${state.playlists.map((playlist) => html`<a class="nav-link" href="#/playlist/${enc(playlist.id)}" data-playlist-nav="${playlist.id}">${icon("list", { size: 22 })}<span class="nav-label">${playlist.name}</span></a>`)}`);
  if (currentRoute) updateNav(currentRoute);
}

function focusSearchInput() {
  const input = dom.view.querySelector(".search-bar input, input[type='search']");
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select?.();
}

// ---------------------------------------------------------------------------
// Live-state hooks (§9): update rendered markup in place, never re-render.

function setIcon(element, name) {
  const use = element.querySelector("svg use");
  if (!use) return;
  const href = `#i-${name}`;
  const previous = use.getAttribute("href") || "";
  if (previous === href) return;
  use.setAttribute("href", href);
  const svg = use.closest("svg");
  if (svg) {
    svg.classList.remove(`icon-${previous.replace(/^#i-/, "")}`);
    svg.classList.add(`icon-${name}`);
  }
}

function iconName(element) {
  return (element.querySelector("svg use")?.getAttribute("href") || "").replace(/^#i-/, "");
}

// Icon buttons carry a matching tooltip; keep it in step with the label.
function setLabel(element, label) {
  if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
  if (element.hasAttribute("title") && element.getAttribute("title") !== label) element.setAttribute("title", label);
}

function setPlayingLabel(element, playing) {
  const label = element.getAttribute("aria-label");
  if (!label) return;
  if (playing && /^Play\b/.test(label)) setLabel(element, label.replace(/^Play\b/, "Pause"));
  else if (!playing && /^Pause\b/.test(label)) setLabel(element, label.replace(/^Pause\b/, "Play"));
}

function isContextActive(type, id) {
  const track = player?.currentTrack;
  if (!track) return false;
  if (type === "source") return track.sourceId === id;
  return activeContext?.type === type && activeContext.id === id;
}

function syncTrackRows(root) {
  const key = currentTrackKey();
  const playing = Boolean(player?.isPlaying);
  const readiness = new Map();
  for (const row of root.querySelectorAll(".track[data-track-key]")) {
    const current = row.dataset.trackKey === key;
    row.classList.toggle("is-current", current);
    row.classList.toggle("is-playing", current && playing);
    const sourceId = row.dataset.sourceId;
    if (!readiness.has(sourceId)) readiness.set(sourceId, isOfflineReady(sourceId));
    row.toggleAttribute("data-offline-ready", readiness.get(sourceId));
    const main = row.querySelector(".track-main");
    if (main) setPlayingLabel(main, current && playing);
  }
}

function syncLikes(root) {
  for (const button of root.querySelectorAll("[data-like-key]")) {
    const liked = likedSet.has(button.dataset.likeKey);
    button.classList.toggle("is-active", liked);
    button.setAttribute("aria-pressed", String(liked));
    setIcon(button, liked ? "heart-fill" : "heart");
  }
}

function syncPlayButtons(root) {
  const playing = Boolean(player?.isPlaying);
  for (const button of root.querySelectorAll(PLAY_HOOK_SELECTOR)) {
    const hook = PLAY_HOOKS.find(([attribute]) => button.dataset[attribute] !== undefined);
    if (!hook) continue;
    const on = playing && isContextActive(hook[1], button.dataset[hook[0]]);
    button.classList.toggle("is-playing", on);
    const current = iconName(button);
    if (current === "play-fill" || current === "pause-fill") setIcon(button, on ? "pause-fill" : "play-fill");
    else if (current === "play" || current === "pause") setIcon(button, on ? "pause" : "play");
    setPlayingLabel(button, on);
  }
}

const DOWNLOAD_LABELS = { none: "Download", queued: "Cancel download", downloading: "Cancel download", done: "Remove download" };

function syncDownloads(root) {
  for (const button of root.querySelectorAll("[data-download-source]")) {
    const { state: status, progress } = downloadState(button.dataset.downloadSource);
    if (button.dataset.state !== status) button.dataset.state = status;
    button.style.setProperty("--progress", progress.toFixed(3));
    if (button.hasAttribute("aria-label")) setLabel(button, DOWNLOAD_LABELS[status]);
    if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(status === "done"));
    const current = iconName(button);
    if (current === "download" || current === "downloaded") setIcon(button, status === "done" ? "downloaded" : "download");
  }
}

function syncLiveState(root = document) {
  syncTrackRows(root);
  syncLikes(root);
  syncPlayButtons(root);
  syncDownloads(root);
}

let liveFrame = 0;
function scheduleLiveSync() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    syncLiveState(document);
  });
}

let downloadFrame = 0;
function scheduleDownloadSync() {
  if (downloadFrame) return;
  downloadFrame = requestAnimationFrame(() => {
    downloadFrame = 0;
    syncDownloads(document);
    syncTrackRows(document);
  });
}

function updateNetworkClass() {
  const isOffline = !navigator.onLine;
  document.documentElement.classList.toggle("is-offline", isOffline);
  dom.app?.classList.toggle("is-offline", isOffline);
}

// ---------------------------------------------------------------------------
// Library sync (§8)

function onLibraryEvent(event) {
  const detail = event.detail || {};
  if (!ready) {
    pendingLibraryEvent = detail;
    return;
  }
  adoptLibrary(detail);
}

function adoptLibrary({ library: next, diff, origin } = {}) {
  if (!next || next === library) return;
  if (library && next.revision === library.revision && next.generated === library.generated) {
    library = next;
    return;
  }
  const previous = library;
  const hadMusic = Boolean(previous?.sources?.length);
  const change = diff || diffLibraries(previous, next);
  const previousUrls = new Map(baseCatalog.sources.map((source) => [source.id, source.audioUrl]));

  library = next;
  libraryOrigin = origin || "network";
  rebuildCatalog();

  if (player && !player.currentTrack) {
    player.setQueue(state.playback.queue);
    renderPersistedPlayback();
  }
  nowPlaying?.render();

  const added = (change.added || []).map(sourceFor).filter(Boolean);
  const newSongs = added.reduce((count, source) => count + source.tracks.length, 0);
  lastAnnouncedUpdate = hadMusic && newSongs > 0;
  if (lastAnnouncedUpdate) {
    const artists = [...new Set(added.map((source) => source.artist))];
    const message = artists.length === 1 ? `${pluralize(newSongs, "new song")} from ${artists[0]}` : pluralize(newSongs, "new song");
    notify(message, { type: "success", actionLabel: "View", onAction: () => navigate(HOME_HASH), duration: 6500 });
  }

  manageDownloadsAfterUpdate(added, change, previousUrls, libraryOrigin);
  renderPlaylistNav();
  scheduleRefresh();
  scheduleLiveSync();
}

function manageDownloadsAfterUpdate(added, change, previousUrls, origin) {
  if (!offline) return;
  const wanted = [];
  if (state.settings.autoDownload) wanted.push(...added.filter(canDownload));
  // Someone who kept a recording offline wants the corrected version offline too.
  for (const id of change.changed || []) {
    const oldUrl = previousUrls.get(id);
    const source = sourceFor(id);
    if (oldUrl && source && source.audioUrl !== oldUrl && offline.isDownloaded(oldUrl) && canDownload(source)) wanted.push(source);
  }
  if (origin !== "bundled" && origin !== "none") {
    const keep = new Set(baseCatalog.sources.map((source) => source.audioUrl).filter(Boolean));
    const playingUrl = player?.currentSource?.audioUrl;
    if (playingUrl) keep.add(playingUrl); // never pull the file out from under the audio element
    offline.prune(keep).catch((error) => console.warn("Pruning downloads failed.", error));
  }
  const unique = [...new Map(wanted.map((source) => [source.audioUrl, source])).values()];
  if (unique.length && getSyncStatus().hasToken) {
    offline.downloadMany(unique).catch((error) => console.warn("Background downloads failed.", error));
  }
}

function onSyncStatusEvent(event) {
  const next = event.detail || getSyncStatus();
  const previous = lastSyncStatus;
  lastSyncStatus = { ...next };
  if (!ready) return;
  const authChanged = (previous?.state === "unauthorized") !== (next.state === "unauthorized") || previous?.hasToken !== next.hasToken;
  if (canLoadLibraryArtwork(next) !== artworkAllowed) {
    rebuildCatalog();
    renderPersistedPlayback();
    nowPlaying?.render();
    scheduleRefresh();
  }
  if (next.state === "unauthorized" && next.hasToken && previous?.state !== "unauthorized" && !warnedTokenRejected) {
    warnedTokenRejected = true;
    promptConnect("Your access token stopped working. Connect again to keep your music up to date.");
  }
  if (next.state === "ok" && next.hasToken) checkStoredTokenAccess();
  if (authChanged) scheduleRefresh(["home", "settings"]);
  else if (previous?.state !== next.state || previous?.lastSyncedAt !== next.lastSyncedAt || previous?.revision !== next.revision) {
    scheduleRefresh(["settings"]);
  }
}

// Devices connected before tokens were checked (see connectLibrary) may hold
// one that can change the account; say so once per launch until it's replaced.
async function checkStoredTokenAccess() {
  if (checkedTokenAccess) return;
  checkedTokenAccess = true;
  const access = await tokenAccess().catch(() => null);
  if (!access?.canWrite) return;
  notify("This device's access token can change your Hugging Face account. Replace it with a fine-grained, read-only token.", {
    type: "error",
    duration: 12000,
    actionLabel: "Settings",
    onAction: () => navigate(CONNECT_HASH)
  });
}

function promptConnect(message = "Connect your library to play music.") {
  connectToast?.dismiss();
  connectToast = notify(message, { actionLabel: "Connect", onAction: () => navigate(CONNECT_HASH), duration: 6500 });
}

function needsConnection(source) {
  if (!source || source.provider !== "local" || source.assetId) return false;
  const url = source.audioUrl;
  if (!url || !isLibraryUrl(url) || offline?.isDownloaded(url)) return false;
  const status = getSyncStatus();
  return !status.hasToken || status.state === "unauthorized";
}

async function connectLibrary(token) {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, message: "Paste your access token first." };
  if (!/^hf_\w{8,}$/.test(value)) return { ok: false, message: "That doesn't look like a Hugging Face token. They start with hf_." };
  const check = await verifyToken(value);
  if (check.reason === "unauthorized") return { ok: false, message: "That token can't open the library. Check that it has read access." };
  if (!check.ok && check.reason !== "offline") return { ok: false, message: "Couldn't reach Hugging Face. Try again in a moment." };
  // The token lives in this site's storage, which other pages on the same
  // host can read; one that can change the account must never be stored.
  const access = check.access || null;
  if (access?.canWrite) {
    return { ok: false, message: `This token can change your Hugging Face account. Create a fine-grained, read-only token for ${CONFIG.REPO} instead.` };
  }
  try {
    await storeToken(value);
  } catch (error) {
    return { ok: false, message: error?.message || "This browser couldn't save the token." };
  }
  warnedTokenRejected = false;
  connectToast?.dismiss();
  if (!check.ok) {
    scheduleRefresh(["home", "settings"]);
    return { ok: true, message: "Saved. Acoustify will connect when you're back online." };
  }
  // Wait (briefly) for the first sync so the next render already shows the
  // connected library instead of flashing the old "Not connected" state.
  const refreshed = sync?.refresh({ force: true }).catch(() => "error");
  await Promise.race([refreshed, new Promise((resolve) => setTimeout(resolve, CONNECT_SYNC_WAIT_MS))]);
  scheduleRefresh(["home", "settings"]);
  const connected = check.user ? `Connected as ${check.user}` : "Library connected";
  // A classic read token (or a broad fine-grained one) opens every private repo on the account.
  if (access && !access.onlyThisLibrary) return { ok: true, message: `${connected}. A fine-grained token for just this library is safer.` };
  return { ok: true, message: connected };
}

async function disconnectLibrary() {
  await clearStoredToken();
  await sync?.refresh({ force: true }).catch(() => {});
  scheduleRefresh(["home", "settings"]);
  return { ok: true, message: "Library disconnected" };
}

function warnAboutConnectLink() {
  if (!ready || !pendingConnectLinkWarning) return;
  pendingConnectLinkWarning = false;
  notify("Paste your token here instead of opening a link. Links with a token stay in your browser history, so delete that entry too.", { duration: 9000 });
}

async function syncNow() {
  if (!sync) return "error";
  if (!navigator.onLine) {
    notify("You're offline. Your library will update when you reconnect.");
    return "offline";
  }
  lastAnnouncedUpdate = false;
  const result = await sync.refresh({ force: true });
  switch (result) {
    case "updated":
      if (!lastAnnouncedUpdate) notify("Library updated", { type: "success" });
      break;
    case "unchanged":
      notify("Your library is up to date");
      break;
    case "unauthorized":
      promptConnect("Connect your library to sync your music.");
      break;
    case "offline":
      notify("You're offline. Your library will update when you reconnect.");
      break;
    default:
      notify("Couldn't reach your library. Try again in a moment.", { type: "error" });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Offline downloads

// A reload drops the in-memory download queue, so updates wait for it.
const downloadsBusy = () => Boolean(offline?.busy);

function onDownloadChange(event) {
  const detail = event.detail || {};
  scheduleDownloadSync();
  if (detail.state === "done" || detail.state === "removed") scheduleRefresh(["downloads", "settings"]);
  if (detail.state !== "error") return;
  const source = sourceFor(detail.sourceId) || catalog.sources.find((item) => item.audioUrl === detail.url);
  if (detail.reason === "auth") promptConnect("Connect your library to download music.");
  else notifyOnce(detail.error || `Couldn't download ${source ? `“${source.title}”` : "that album"}.`, { type: "error", duration: 5200 });
}

async function downloadSource(source) {
  if (!canDownload(source)) {
    notify("This one can't be downloaded.");
    return false;
  }
  if (!getSyncStatus().hasToken) {
    promptConnect("Connect your library to download music.");
    return false;
  }
  const ok = await offline.download(source);
  if (ok) notify(`Downloaded “${source.title}”`, { type: "success" });
  return ok;
}

async function removeDownload(source) {
  if (!source?.audioUrl) return;
  await offline.remove(source.audioUrl);
  notify(`Removed “${source.title}” from downloads`);
}

async function toggleDownload(sourceId) {
  const source = sourceFor(sourceId);
  if (!source) return;
  const { state: status } = downloadState(sourceId);
  if (status === "done") await removeDownload(source);
  else if (status === "downloading" || status === "queued") offline.cancel(source.audioUrl);
  else await downloadSource(source);
}

async function downloadAll() {
  if (!offline) return;
  const pending = catalog.sources.filter((source) => canDownload(source) && !offline.isDownloaded(source.audioUrl));
  if (!pending.length) {
    notify("All your music is downloaded.", { type: "success" });
    return;
  }
  if (!getSyncStatus().hasToken) {
    promptConnect("Connect your library to download music.");
    return;
  }
  const bytes = pending.reduce((sum, source) => sum + (Number(source.bytes) || 0), 0);
  const ok = await confirmDialog({
    title: "Download all music?",
    body: `${joinMeta([pluralize(pending.length, "album"), bytes ? formatBytes(bytes) : ""])}. Downloaded music plays without a connection.`,
    confirmLabel: "Download"
  });
  if (!ok) return;
  const result = await offline.downloadMany(pending);
  if (result?.cancelled) return;
  if (result?.failed) notify(`${pluralize(result.completed, "album")} downloaded, ${result.failed} failed.`, { type: "error" });
  else if (result?.completed) notify(`${pluralize(result.completed, "album")} downloaded`, { type: "success" });
}

async function removeAllDownloads() {
  if (!offline) return;
  const ok = await confirmDialog({
    title: "Remove all downloads?",
    body: "Your music stays in your library and streams when you're online.",
    confirmLabel: "Remove",
    danger: true
  });
  if (!ok) return;
  await offline.removeAll();
  notify("All downloads removed");
  scheduleRefresh(["downloads", "settings", "library"]);
}

// ---------------------------------------------------------------------------
// Playback

async function startPlayback(key, { queue = null, context = null, resumePosition = null } = {}) {
  const track = trackFor(key);
  if (!track) {
    notify("That song isn't in your library anymore.");
    return false;
  }
  if (needsConnection(sourceFor(track.sourceId))) {
    promptConnect();
    return false;
  }
  activeContext = context;
  try {
    await player.loadByKey(key, { autoplay: true, queue, resumePosition });
    return true;
  } catch (error) {
    reportError(error, "Couldn't play that song.");
    return false;
  } finally {
    scheduleLiveSync();
  }
}

async function playKeys(keys, { shuffle = false, context = null } = {}) {
  let queue = [...new Set(keys)].filter((key) => catalog.trackByKey.has(key));
  if (!queue.length) {
    notify("Nothing to play here yet.");
    return false;
  }
  if (shuffle) queue = shuffled(queue);
  return startPlayback(queue[0], { queue, context });
}

function contextKeys(type, id) {
  switch (type) {
    case "source":
      return sourceFor(id)?.tracks.map((track) => track.key) || [];
    case "artist":
      return topTracksForArtist(id, Infinity).map((track) => track.key);
    case "series": {
      const series = catalog.seriesBySlug.get(id);
      return series ? series.sourceIds.flatMap((sourceId) => sourceFor(sourceId)?.tracks.map((track) => track.key) || []) : [];
    }
    case "playlist":
      return state.playlists.find((playlist) => playlist.id === id)?.trackKeys || [];
    case "liked":
      return state.liked;
    case "history":
      return recentTracks(Infinity).map((track) => track.key);
    case "songs":
      return sortSongs(catalog, id).map((track) => track.key);
    default:
      return [];
  }
}

async function playContext(type, id, { shuffle = false } = {}) {
  if (!shuffle && isContextActive(type, id)) {
    await player.toggle();
    return;
  }
  await playKeys(contextKeys(type, id), { shuffle, context: { type, id } });
}

function contextForRoute(route) {
  const id = route?.segments[1] || "";
  switch (route?.name) {
    case "album":
      return { type: "source", id };
    case "artist":
      return { type: "artist", id };
    case "series":
      return id ? { type: "series", id } : null;
    case "playlist":
      return { type: "playlist", id };
    case "liked":
      return { type: "liked", id: "" };
    case "history":
      return { type: "history", id: "" };
    case "songs":
      return { type: "songs", id: route.params.get("sort") || "title" };
    case "search": // the view rewrites ?q= as you type, so read the live address
      return { type: "search", id: (parseRoute(location.hash).params.get("q") || "").trim() };
    default:
      return null;
  }
}

async function playTrackFromList(element) {
  const key = element.dataset.trackKey;
  if (!key) return;
  if (player.currentTrack?.key === key) {
    await player.toggle();
    return;
  }
  const registered = queueRegistry.get(element.dataset.queueId);
  const track = trackFor(key);
  const queue = registered?.includes(key) ? registered : sourceFor(track?.sourceId)?.tracks.map((item) => item.key) || null;
  await startPlayback(key, { queue, context: contextForRoute(currentRoute) });
}

// "Continue listening" and the restored player bar's play button. A resume
// control only ever starts music: a card rendered before the first play can
// still be tapped once the song is loaded, and must not pause it.
async function resumePlayback() {
  const info = resumeInfo();
  if (!info) return;
  if (player.currentTrack?.key === info.track.key) {
    if (!player.isPlaying) await player.play();
    return;
  }
  await startPlayback(info.track.key, { queue: savedQueueFor(info.track), context: state.playback.context, resumePosition: info.position });
}

// Prev/next/seek on the restored (not yet loaded) track: load it paused with
// its queue so the transport acts on it exactly as on a live track. Returns
// once the player holds the track; the stream keeps opening behind it.
function restorePausedPlayback() {
  if (player.currentTrack) return true;
  const info = resumeInfo();
  if (!info) return false;
  if (needsConnection(info.source)) {
    promptConnect();
    return false;
  }
  activeContext = state.playback.context;
  unrecordedKey = info.track.key;
  player.loadByKey(info.track.key, { autoplay: false, queue: savedQueueFor(info.track), resumePosition: info.position })
    .catch((error) => {
      // A step right after this supersedes the load; real failures were reported by the player.
      if (!error?.reported) console.debug("Restoring playback failed.", error);
    });
  scheduleLiveSync();
  return Boolean(player.currentTrack);
}

// "Playing from" for the now-playing views (the saved list before the first
// play). Albums, and anything started outside a list, fall back to the
// song's own album there.
function playbackContextLink() {
  const context = player?.currentTrack ? activeContext : state.playback.context;
  if (!context) return null;
  const id = context.id;
  switch (context.type) {
    case "artist": {
      const artist = catalog.artistBySlug.get(id);
      return artist ? { label: artist.name, href: `#/artist/${enc(artist.slug)}` } : null;
    }
    case "series": {
      const series = catalog.seriesBySlug.get(id);
      return series ? { label: series.name, href: `#/series/${enc(series.slug)}` } : null;
    }
    case "playlist": {
      const playlist = playlistById(id);
      return playlist ? { label: playlist.name, href: `#/playlist/${enc(playlist.id)}` } : null;
    }
    case "liked":
      return { label: "Liked Songs", href: "#/liked" };
    case "history":
      return { label: "Recently played", href: "#/history" };
    case "songs":
      return { label: "Songs", href: id && id !== "title" ? `#/songs?sort=${enc(id)}` : "#/songs" };
    case "search":
      return id ? { label: `“${id}” in Search`, href: `#/search?q=${enc(id)}` } : { label: "Search", href: "#/search" };
    default:
      return null;
  }
}

async function togglePlayback() {
  if (player.currentTrack) {
    await player.toggle();
    return;
  }
  if (resumeInfo()) {
    await resumePlayback();
    return;
  }
  const first = catalog.sourcesByAdded[0];
  if (first) await playContext("source", first.id);
}

async function playNext(key) {
  const track = trackFor(key);
  if (!track) return;
  if (!player.currentTrack) {
    await startPlayback(key, { queue: [key] });
    return;
  }
  const added = typeof player.playNext === "function" ? player.playNext(key) : player.addToQueue(key, { next: true });
  notify(added ? `“${track.title}” plays next` : `“${track.title}” is already up next`);
}

async function addToQueue(keys) {
  const valid = keys.filter((key) => catalog.trackByKey.has(key));
  if (!valid.length) return;
  if (!player.currentTrack) {
    await startPlayback(valid[0], { queue: valid });
    return;
  }
  let added = 0;
  for (const key of valid) if (player.addToQueue(key)) added += 1;
  if (valid.length === 1) {
    const title = trackFor(valid[0]).title;
    notify(added ? `Added “${title}” to the queue` : `“${title}” is already in the queue`);
  } else {
    notify(added ? `Added ${pluralize(added, "song")} to the queue` : "Those songs are already in the queue");
  }
}

// Plays the whole recording with no song boundaries, for the song-time editor.
async function playCalibration(sourceId) {
  const source = sourceFor(sourceId);
  if (!source) return false;
  if (needsConnection(source)) {
    promptConnect();
    return false;
  }
  const track = {
    id: "__full-recording",
    key: `${source.id}::__full-recording`,
    sourceId: source.id,
    sourceTitle: source.title,
    title: `${source.title} (full recording)`,
    artist: source.artist,
    artists: source.artists,
    artistSlugs: source.artistSlugs || [],
    series: source.series,
    artwork: source.artwork || source.fallbackArtwork,
    fallbackArtwork: source.fallbackArtwork,
    provider: source.provider,
    index: 0,
    start: 0,
    end: source.duration,
    duration: source.duration,
    added: source.added
  };
  activeContext = null;
  try {
    await player.load(track, source, { autoplay: true, queue: [], preciseStart: true });
    return true;
  } catch (error) {
    reportError(error, "Couldn't play the recording.");
    return false;
  }
}

function rememberPlayback(snapshot, { force = false } = {}) {
  const track = snapshot?.track;
  if (!isCatalogTrack(track)) return;
  const position = Number(snapshot.currentTime) || track.start;
  state.playback = {
    trackKey: track.key,
    absolutePosition: position,
    updatedAt: Date.now(),
    queue: [...(snapshot.queue || [])],
    context: activeContext ? { type: activeContext.type, id: activeContext.id } : null
  };
  const entry = state.history.find((item) => item.trackKey === track.key);
  if (entry) entry.position = position;
  if (force || Date.now() - lastPlaybackPersistAt > PLAYBACK_PERSIST_MS) {
    lastPlaybackPersistAt = Date.now();
    persistState();
  }
}

async function persistPlaybackNow() {
  if (player?.currentTrack) rememberPlayback(player.snapshot(), { force: true });
  try {
    await setValue(STATE_KEY, state);
  } catch (error) {
    console.debug("Playback position could not be saved.", error);
  }
}

function recordTrackStart(snapshot) {
  const track = snapshot?.track;
  if (!isCatalogTrack(track)) return;
  const now = Date.now();
  const first = state.history[0];
  if (first?.trackKey === track.key && now - first.playedAt < 30_000) {
    first.playedAt = now;
    first.position = snapshot.currentTime;
  } else {
    state.history.unshift({ trackKey: track.key, playedAt: now, position: snapshot.currentTime });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    state.playCounts[track.key] = playCount(track.key) + 1;
  }
  markSeen(track.sourceId);
  rememberPlayback(snapshot, { force: true });
}

// Also clears the bar when the saved song left the library ({} = nothing).
function renderPersistedPlayback() {
  if (player?.currentTrack) return;
  nowPlaying?.renderPersisted(resumeInfo() || {});
}

function onPlayerError(event) {
  const { error, kind, source } = event.detail || {};
  if (kind === "auth") {
    promptConnect("Connect your library to play this song.");
    return;
  }
  const url = source?.audioUrl;
  const offlineAndMissing = !navigator.onLine && url && !offline?.isDownloaded(url);
  const message = offlineAndMissing ? "You're offline and this song isn't downloaded." : error?.message || "Playback stopped unexpectedly.";
  notifyOnce(message, { type: "error", duration: 5200 });
}

function wirePlayerEvents() {
  player.addEventListener("trackchange", (event) => {
    const detail = event.detail;
    // A restored song loaded paused isn't a play yet (see restorePausedPlayback).
    if (detail?.track?.key && detail.track.key === unrecordedKey) {
      rememberPlayback(detail, { force: true });
    } else {
      unrecordedKey = null;
      recordTrackStart(detail);
    }
    scheduleLiveSync();
  });
  player.addEventListener("statechange", (event) => {
    const detail = event.detail;
    if (detail?.isPlaying && unrecordedKey && detail.track?.key === unrecordedKey) {
      unrecordedKey = null;
      recordTrackStart(detail);
    }
    if (!detail?.isPlaying) rememberPlayback(detail, { force: true });
    scheduleLiveSync();
  });
  player.addEventListener("progress", (event) => rememberPlayback(event.detail));
  player.addEventListener("segmentended", (event) => rememberPlayback(event.detail));
  player.addEventListener("queuechange", (event) => {
    // The song-time editor's full-recording track has no queue worth resuming.
    if (player.currentTrack && !isCatalogTrack(player.currentTrack)) return;
    state.playback.queue = [...(event.detail?.queue || [])];
    persistState();
  });
  player.addEventListener("optionschange", (event) => {
    const detail = event.detail || {};
    if (REPEAT_MODES.includes(detail.repeat)) state.settings.repeat = detail.repeat;
    for (const key of ["shuffle", "autoplay", "keepScreenAwake"]) {
      if (typeof detail[key] === "boolean") state.settings[key] = detail[key];
    }
    if (Number.isFinite(detail.segmentLeadIn)) state.settings.segmentLeadIn = detail.segmentLeadIn;
    persistState();
  });
  player.addEventListener("volumechange", (event) => {
    if (Number.isFinite(event.detail?.volume)) state.settings.volume = event.detail.volume;
    persistState();
  });
  player.addEventListener("error", onPlayerError);
}

function activePlaybackFor(sourceId) {
  const track = player?.currentTrack;
  if (!track || track.sourceId !== sourceId || !isCatalogTrack(track)) return null;
  return { sourceId, key: track.key, position: player.currentTime, playing: player.isPlaying, queue: [...player.queue] };
}

// After song times change, reload the playing song so its boundaries match.
async function reloadActivePlayback(playback) {
  if (!playback) return;
  let key = playback.key;
  if (!catalog.trackByKey.has(key)) {
    const tracks = sourceFor(playback.sourceId)?.tracks || [];
    key = (tracks.find((track) => playback.position >= track.start && playback.position < track.end) || tracks[0])?.key;
  }
  if (!key) return;
  const queue = playback.queue.filter((item) => catalog.trackByKey.has(item));
  try {
    await player.loadByKey(key, { autoplay: playback.playing, resumePosition: playback.position, queue: queue.includes(key) ? queue : null });
  } catch (error) {
    reportError(error);
  }
}

// ---------------------------------------------------------------------------
// Likes, playlists, history

function toggleLike(key) {
  if (!key || !catalog.trackByKey.has(key)) return null;
  const liked = !likedSet.has(key);
  state.liked = liked ? [key, ...state.liked.filter((item) => item !== key)] : state.liked.filter((item) => item !== key);
  likedSet = new Set(state.liked);
  persistState();
  syncLikes(document);
  nowPlaying?.refreshLike();
  scheduleRefresh(["liked", "library"]);
  return liked;
}

function playlistById(id) {
  return state.playlists.find((playlist) => playlist.id === id) || null;
}

function touchPlaylists({ nav = false } = {}) {
  persistState();
  if (nav) renderPlaylistNav();
  if (activeContext?.type === "playlist") nowPlaying?.render(); // "Playing from" shows its name
  scheduleRefresh(["library", "playlist"]);
}

function createPlaylist({ name, description = "", trackKeys = [] }) {
  const now = Date.now();
  const playlist = { id: uid(), name, description, trackKeys: uniqueStrings(trackKeys), createdAt: now, updatedAt: now };
  state.playlists.push(playlist);
  touchPlaylists({ nav: true });
  return playlist;
}

function addToPlaylist(playlistId, keys) {
  const playlist = playlistById(playlistId);
  if (!playlist) return;
  const fresh = keys.filter((key) => catalog.trackByKey.has(key) && !playlist.trackKeys.includes(key));
  if (!fresh.length) {
    notify(keys.length === 1 ? `Already in “${playlist.name}”` : `Those songs are already in “${playlist.name}”`);
    return;
  }
  playlist.trackKeys.push(...fresh);
  playlist.updatedAt = Date.now();
  touchPlaylists();
  notify(fresh.length === 1 ? `Added to “${playlist.name}”` : `Added ${pluralize(fresh.length, "song")} to “${playlist.name}”`, { type: "success" });
}

function removeFromPlaylist(playlistId, key) {
  const playlist = playlistById(playlistId);
  if (!playlist || !playlist.trackKeys.includes(key)) return;
  playlist.trackKeys = playlist.trackKeys.filter((item) => item !== key);
  playlist.updatedAt = Date.now();
  touchPlaylists();
  notify(`Removed from “${playlist.name}”`);
}

async function renamePlaylist(playlistId) {
  const playlist = playlistById(playlistId);
  if (!playlist) return;
  const name = await promptDialog({ title: "Rename playlist", label: "Name", value: playlist.name, confirmLabel: "Save" });
  if (!name || name === playlist.name) return;
  playlist.name = name;
  playlist.updatedAt = Date.now();
  touchPlaylists({ nav: true });
}

async function deletePlaylist(playlistId) {
  const playlist = playlistById(playlistId);
  if (!playlist) return;
  const ok = await confirmDialog({
    title: "Delete playlist?",
    body: `“${playlist.name}” will be deleted. Its songs stay in your library.`,
    confirmLabel: "Delete",
    danger: true
  });
  if (!ok) return;
  state.playlists = state.playlists.filter((item) => item.id !== playlistId);
  if (activeContext?.type === "playlist" && activeContext.id === playlistId) {
    activeContext = null;
    nowPlaying?.render();
  }
  touchPlaylists({ nav: true });
  notify(`Deleted “${playlist.name}”`);
  if (currentRoute?.name === "playlist" && currentRoute.segments[1] === playlistId) navigate("#/library?tab=playlists", { replace: true });
}

function openPlaylistDialog(trackKeys = []) {
  const dialog = dom.playlistDialog;
  const form = dom.playlistForm;
  if (!dialog?.showModal || !form) {
    promptDialog({ title: "New playlist", label: "Name", confirmLabel: "Create" }).then((name) => {
      if (name) finishPlaylistCreation({ name, description: "", trackKeys });
    });
    return;
  }
  form.reset();
  if (form.elements.trackKey) form.elements.trackKey.value = trackKeys.join("\n");
  dialog.showModal();
  requestAnimationFrame(() => form.elements.name?.focus());
}

function finishPlaylistCreation({ name, description, trackKeys }) {
  const keys = trackKeys.filter((key) => catalog.trackByKey.has(key));
  const playlist = createPlaylist({ name, description, trackKeys: keys });
  if (keys.length) {
    notify(keys.length === 1 ? `Added to “${playlist.name}”` : `Added ${pluralize(keys.length, "song")} to “${playlist.name}”`, { type: "success" });
  } else {
    notify(`Created “${playlist.name}”`, { type: "success" });
    navigate(`#/playlist/${enc(playlist.id)}`);
  }
}

function onPlaylistFormSubmit(event) {
  event.preventDefault();
  const form = dom.playlistForm;
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) {
    form.elements.name?.focus();
    return;
  }
  const description = String(data.get("description") || "").trim();
  const trackKeys = String(data.get("trackKey") || "").split("\n").filter(Boolean);
  dom.playlistDialog?.close("save");
  finishPlaylistCreation({ name, description, trackKeys });
}

async function clearHistory() {
  if (!state.history.length) return;
  const ok = await confirmDialog({
    title: "Clear listening history?",
    body: "Your liked songs, playlists and downloads stay.",
    confirmLabel: "Clear",
    danger: true
  });
  if (!ok) return;
  state.history = [];
  persistState();
  scheduleRefresh(["history", "home", "library"]);
  notify("Listening history cleared");
}

// ---------------------------------------------------------------------------
// Song-time edits (user overrides)

function cleanTrack(track, index) {
  const out = {
    id: String(track?.id ?? "").trim() || `track-${index + 1}`,
    title: String(track?.title ?? "").trim(),
    start: Number(track?.start),
    end: Number(track?.end)
  };
  if (track?.timingConfidence) out.timingConfidence = String(track.timingConfidence);
  return out;
}

async function saveSourceOverride(nextSource) {
  const id = nextSource?.id;
  const current = id ? sourceFor(id) : null;
  if (!current) throw new Error("That album is no longer in your library.");
  const edited = { ...deepClone(current), tracks: (Array.isArray(nextSource.tracks) ? nextSource.tracks : []).map(cleanTrack) };
  for (const field of EDITABLE_FIELDS) {
    if (nextSource[field] !== undefined && nextSource[field] !== null) edited[field] = deepClone(nextSource[field]);
  }
  edited.timingStatus = "user-calibrated";
  validateCatalog({ version: 1, sources: [edited] }, { strict: false });

  const override = pick(edited, OVERRIDE_FIELDS);
  if (current.userSource) Object.assign(override, pick(edited, USER_SOURCE_FIELDS));
  override.tracks = edited.tracks;

  const previous = state.userSources;
  const playback = activePlaybackFor(id);
  state.userSources = [...state.userSources.filter((source) => source.id !== id), override];
  try {
    await persistNow();
  } catch (error) {
    state.userSources = previous;
    throw error;
  }
  rebuildCatalog();
  markSeen(id);
  await reloadActivePlayback(playback);
  nowPlaying?.render();
  scheduleLiveSync();
  notify("Song times saved", { type: "success" });
  return sourceFor(id);
}

async function resetSource(sourceId) {
  const override = state.userSources.find((source) => source.id === sourceId);
  if (!override) return false;
  const packaged = isPackaged(sourceId);
  const playback = activePlaybackFor(sourceId);
  const previous = state.userSources;
  state.userSources = state.userSources.filter((source) => source.id !== sourceId);
  try {
    await persistNow();
  } catch (error) {
    state.userSources = previous;
    throw error;
  }
  if (override.assetId) await deleteAudioAsset(override.assetId).catch(() => {});
  rebuildCatalog();
  if (packaged) await reloadActivePlayback(playback);
  else if (playback) await player.pause().catch(() => {});
  nowPlaying?.render();
  scheduleRefresh();
  notify(packaged ? "Restored the library version" : "Removed from Acoustify", { type: "success" });
  return true;
}

async function confirmResetSource(sourceId) {
  const source = sourceFor(sourceId);
  if (!source) return;
  const packaged = isPackaged(sourceId);
  const ok = await confirmDialog(packaged
    ? { title: "Reset changes?", body: `Your song-time edits to “${source.title}” will be replaced by the library version.`, confirmLabel: "Reset", danger: true }
    : { title: "Remove from Acoustify?", body: `“${source.title}” will be removed from this device.`, confirmLabel: "Remove", danger: true });
  if (ok) await resetSource(sourceId);
}

// ---------------------------------------------------------------------------
// Menus (action sheets)

// Items that open another overlay run after the sheet has fully closed, so
// two overlays never fight over focus.
async function openMenu({ title, subtitle = "", artItem = null, anchor = null, items }) {
  let deferred = null;
  const list = items.filter((item) => item && !item.hidden).map(({ run, defer, ...item }) => ({
    ...item,
    onSelect: () => {
      if (defer) deferred = run;
      else runSafely(run);
    }
  }));
  if (!list.length) return;
  await actionSheet({ title, subtitle, artItem, anchor, items: list });
  if (deferred) await runSafely(deferred);
}

function artistItems(names = [], slugs = []) {
  return names.map((name, index) => ({
    icon: "artists",
    label: names.length > 1 ? `Go to ${name}` : "Go to artist",
    hidden: !slugs[index],
    run: () => navigate(`#/artist/${enc(slugs[index])}`)
  }));
}

function openExternal(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// Albums indexed from a YouTube playlist link to the playlist; everything else to its video.
function youtubeUrlFor({ youtubeId, youtubePlaylistId } = {}) {
  if (youtubeId) return `https://www.youtube.com/watch?v=${enc(youtubeId)}`;
  if (youtubePlaylistId) return `https://www.youtube.com/playlist?list=${enc(youtubePlaylistId)}`;
  return "";
}

function downloadItem(source) {
  if (!canDownload(source)) return null;
  const { state: status } = downloadState(source.id);
  if (status === "done") return { icon: "trash", label: "Remove download", run: () => removeDownload(source) };
  if (status === "downloading" || status === "queued") return { icon: "close", label: "Cancel download", run: () => offline.cancel(source.audioUrl) };
  return { icon: "download", label: source.tracks.length > 1 ? "Download album" : "Download", run: () => downloadSource(source) };
}

async function openTrackMenu(element) {
  const key = element.dataset.trackKey;
  const track = trackFor(key);
  if (!track) return;
  const source = sourceFor(track.sourceId);
  const contextType = element.dataset.contextType || "";
  const contextId = element.dataset.contextId || "";
  const isCurrent = player?.currentTrack?.key === key;
  const liked = likedSet.has(key);
  await openMenu({
    title: track.title,
    subtitle: joinMeta([track.artist, track.sourceTitle]),
    artItem: track,
    anchor: element,
    items: [
      { icon: "queue", label: "Play next", hidden: isCurrent, run: () => playNext(key) },
      { icon: "list", label: "Add to queue", hidden: isCurrent, run: () => addToQueue([key]) },
      {
        icon: liked ? "heart-fill" : "heart",
        label: liked ? "Remove from Liked Songs" : "Add to Liked Songs",
        run: () => {
          const now = toggleLike(key);
          if (now !== null) notify(now ? "Added to Liked Songs" : "Removed from Liked Songs");
        }
      },
      { icon: "plus", label: "Add to playlist…", defer: true, run: () => openAddToPlaylist([key], element) },
      {
        icon: "close",
        label: "Remove from this playlist",
        hidden: contextType !== "playlist" || !playlistById(contextId),
        run: () => removeFromPlaylist(contextId, key)
      },
      ...artistItems(track.artists, track.artistSlugs),
      {
        icon: "disc",
        label: "Go to album",
        hidden: contextType === "album" && contextId === track.sourceId,
        run: () => navigate(`#/album/${enc(track.sourceId)}`)
      },
      downloadItem(source),
      // Songs of an album built from separate videos each have their own.
      { icon: "external", label: "View on YouTube", hidden: !track.youtubeId, run: () => openExternal(youtubeUrlFor({ youtubeId: track.youtubeId })) }
    ]
  });
}

async function openSourceMenu(element) {
  const source = sourceFor(element.dataset.sourceId);
  if (!source) return;
  const keys = source.tracks.map((track) => track.key);
  const seriesSlug = seriesSlugFor(source);
  const overridden = hasOverride(source.id);
  const packaged = isPackaged(source.id);
  const youtubeUrl = youtubeUrlFor(source);
  await openMenu({
    title: source.title,
    subtitle: joinMeta([source.artist, source.year]),
    artItem: source,
    anchor: element,
    items: [
      { icon: "list", label: "Add to queue", run: () => addToQueue(keys) },
      { icon: "plus", label: "Add to playlist…", defer: true, run: () => openAddToPlaylist(keys, element) },
      downloadItem(source),
      ...artistItems(source.artists, source.artistSlugs),
      { icon: "series", label: "Go to series", hidden: !seriesSlug, run: () => navigate(`#/series/${enc(seriesSlug)}`) },
      { icon: "edit", label: "Edit song times", run: () => navigate(`#/edit/${enc(source.id)}`) },
      { icon: "external", label: "View on YouTube", hidden: !youtubeUrl, run: () => openExternal(youtubeUrl) },
      {
        icon: packaged ? "refresh" : "trash",
        label: packaged ? "Reset changes" : "Remove from Acoustify",
        danger: !packaged,
        hidden: !overridden,
        defer: true,
        run: () => confirmResetSource(source.id)
      }
    ]
  });
}

async function openPlaylistMenu(element) {
  const playlist = playlistById(element.dataset.playlistId);
  if (!playlist) return;
  await openMenu({
    title: playlist.name,
    subtitle: pluralize(playlist.trackKeys.filter((key) => catalog.trackByKey.has(key)).length, "song"),
    anchor: element,
    items: [
      { icon: "edit", label: "Rename", defer: true, run: () => renamePlaylist(playlist.id) },
      { icon: "trash", label: "Delete playlist", danger: true, defer: true, run: () => deletePlaylist(playlist.id) }
    ]
  });
}

async function openAddToPlaylist(keys, anchor = null) {
  const valid = keys.filter((key) => catalog.trackByKey.has(key));
  if (!valid.length) return;
  await openMenu({
    title: "Add to playlist",
    subtitle: valid.length === 1 ? trackFor(valid[0]).title : pluralize(valid.length, "song"),
    anchor: anchor?.isConnected ? anchor : null,
    items: [
      { icon: "plus", label: "New playlist", defer: true, run: () => openPlaylistDialog(valid) },
      ...state.playlists.map((playlist) => ({
        icon: "list",
        label: playlist.name,
        checked: valid.every((key) => playlist.trackKeys.includes(key)),
        run: () => addToPlaylist(playlist.id, valid)
      }))
    ]
  });
}

// ---------------------------------------------------------------------------
// Settings, backup, reset, install

function setSetting(key, value) {
  const type = SETTING_TYPES[key];
  if (!type) return;
  let next = type === "boolean" ? value === true || value === "true" || value === "on" : type === "number" ? Number(value) : String(value);
  if (type === "number" && !Number.isFinite(next)) return;
  switch (key) {
    case "volume":
      next = clamp(next, 0, 1);
      player?.setVolume(next);
      break;
    case "segmentLeadIn":
      next = clamp(next, 0, 5);
      player?.setSegmentLeadIn(next);
      break;
    case "repeat":
      if (!REPEAT_MODES.includes(next)) return;
      player?.setRepeat(next);
      break;
    case "shuffle":
      player?.setShuffle(next);
      break;
    case "autoplay":
      player?.setAutoplay(next);
      break;
    case "keepScreenAwake":
      player?.setKeepScreenAwake(next);
      break;
    case "playerPanelOpen":
      // nowplaying owns the panel (and remembers it); open() toggles on desktop
      // and the panel only shows once there is something to show.
      if (isDesktop() && nowPlaying && (player?.currentTrack || resumeInfo()) && nowPlaying.isOpen() !== next) {
        if (next) nowPlaying.open();
        else nowPlaying.close();
      }
      break;
    case "autoDownload":
      if (next && !state.settings.autoDownload) notify("New music will download automatically.");
      break;
    default:
      break;
  }
  state.settings[key] = next;
  persistState();
}

function onSettingInput(input) {
  const key = input.dataset.setting;
  if (input.type === "checkbox") setSetting(key, input.checked);
  else if (input.type === "number" || input.type === "range") setSetting(key, Number(input.value));
  else setSetting(key, input.value);
}

async function onTokenFormSubmit(form) {
  if (form.getAttribute("aria-busy") === "true") return;
  const input = form.elements.token;
  const buttons = [...form.querySelectorAll("button")];
  form.setAttribute("aria-busy", "true");
  for (const button of buttons) button.disabled = true;
  let result;
  try {
    result = await connectLibrary(input?.value || "");
  } finally {
    form.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  }
  notify(result.message, { type: result.ok ? "success" : "error" });
  if (result.ok && input) {
    input.value = "";
    input.blur();
  } else {
    input?.focus();
  }
  scheduleRefresh(["settings", "home"]);
}

function exportBackup() {
  const date = new Date().toISOString().slice(0, 10);
  downloadJson(`acoustify-backup-${date}.json`, {
    app: "Acoustify",
    formatVersion: STATE_VERSION,
    exportedAt: new Date().toISOString(),
    note: "Likes, playlists, history, settings and song-time edits. Music is not included.",
    state: deepClone(state)
  });
  notify("Backup downloaded", { type: "success" });
}

function isValidOverride(source) {
  if (isPackaged(source.id)) return true; // merged onto the library, which drops anything that doesn't fit
  try {
    validateCatalog({ version: 1, sources: [source] }, { strict: false });
    return true;
  } catch {
    return false;
  }
}

async function importBackupFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't an Acoustify backup.");
  }
  const raw = isObject(parsed?.state) ? parsed.state : parsed;
  if (!isObject(raw) || !["liked", "playlists", "history", "settings", "userSources"].some((key) => key in raw)) {
    throw new Error("That file isn't an Acoustify backup.");
  }
  const next = normalizeState(raw);
  next.userSources = next.userSources.filter(isValidOverride);
  const summary = joinMeta([pluralize(next.liked.length, "liked song"), pluralize(next.playlists.length, "playlist")]);
  const ok = await confirmDialog({
    title: "Restore this backup?",
    body: `${summary}. This replaces the likes, playlists, history and settings on this device.`,
    confirmLabel: "Restore"
  });
  if (!ok) return;
  // NEW badges are about this device's library, so keep what it has already seen.
  if (state.seenSources !== null) next.seenSources = [...new Set([...(next.seenSources || []), ...state.seenSources])].slice(-SEEN_LIMIT);
  adoptState(next);
  await persistNow();
  rebuildCatalog();
  player.configure(state.settings);
  if (!player.currentTrack) {
    player.setQueue(state.playback.queue);
    renderPersistedPlayback();
  }
  renderPlaylistNav();
  nowPlaying?.refreshLike();
  scheduleRefresh();
  scheduleLiveSync();
  notify("Backup restored", { type: "success" });
}

async function resetApp() {
  const ok = await confirmDialog({
    title: "Reset Acoustify?",
    body: "This erases your likes, playlists, history, settings and song-time edits on this device. Downloads and your library connection stay.",
    confirmLabel: "Reset",
    danger: true
  });
  if (!ok) return;
  await player?.pause().catch(() => {});
  await clearAudioAssets().catch(() => {});
  const fresh = defaultState();
  fresh.seenSources = catalog.sources.map((source) => source.id);
  adoptState(fresh);
  await persistNow();
  history.replaceState(null, "", HOME_HASH);
  location.reload();
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function installApp() {
  if (installed) {
    notify("Acoustify is already installed.");
    return;
  }
  const prompt = deferredInstallPrompt;
  if (!prompt) {
    notify(isIOS() ? "Tap Share, then Add to Home Screen." : "Use your browser's menu and choose Install app.", { duration: 6000 });
    return;
  }
  deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => null);
  if (choice?.outcome === "accepted") notify("Installing Acoustify…", { type: "success" });
  scheduleRefresh(["settings"]);
}

// ---------------------------------------------------------------------------
// App-shell updates (§8)

// A silent reload is only for an idle app the listener just opened or came
// back to. A song that is still opening, a download queue, or any tap or key
// since then means someone is using it: they get the "Update ready" toast.
function canAutoApplyUpdate() {
  if (player?.isPlaying || player?.isBuffering || player?.localLoad) return false;
  if (downloadsBusy()) return false;
  if (document.visibilityState !== "visible") return false;
  if (currentRoute?.name === "edit" || document.querySelector("dialog[open]")) return false;
  if (isEditable(document.activeElement)) return false;
  if (lastInteractionAt > Math.max(launchedAt, returnedFromHiddenAt)) return false;
  const now = Date.now();
  return now - launchedAt < AUTO_UPDATE_AFTER_LAUNCH_MS
    || (returnedFromHiddenAt > 0 && now - returnedFromHiddenAt < AUTO_UPDATE_AFTER_RESUME_MS);
}

function onUpdateReady(worker) {
  if (!worker || worker === waitingWorker) return;
  waitingWorker = worker;
  scheduleRefresh(["settings"]);
  if (canAutoApplyUpdate()) {
    applyUpdate();
    return;
  }
  showUpdateToast();
}

function showUpdateToast() {
  updateToast?.dismiss();
  updateToast = notify("Update ready", { sticky: true, actionLabel: "Restart", onAction: () => applyUpdate() });
}

async function applyUpdate() {
  const worker = waitingWorker || swRegistration?.waiting;
  if (!worker) {
    notify("You're on the latest version.");
    return;
  }
  if (reloadOnControllerChange) return; // already applying
  updateToast?.dismiss();
  updateToast = null;
  saveScroll();
  storeScrollMemory();
  await persistPlaybackNow();
  reloadOnControllerChange = true;
  worker.postMessage({ type: "SKIP_WAITING" });
  // If the new worker never claims this page, reload once it is active so
  // the update lands. Reloading earlier (the old worker can still be
  // finishing a media request) would come back on the old shell.
  const fallback = () => {
    if (!reloadOnControllerChange) return;
    if (worker.state === "activated") location.reload();
    else if (worker.state !== "redundant") setTimeout(fallback, 1000);
    else reloadOnControllerChange = false;
  };
  setTimeout(fallback, 4000);
}

async function checkForAppUpdate({ force = false } = {}) {
  if (!swRegistration) return;
  if (!force && Date.now() - lastUpdateCheckAt < UPDATE_CHECK_GAP_MS) return;
  lastUpdateCheckAt = Date.now();
  try {
    await swRegistration.update();
  } catch {
    // Offline or the worker script is unreachable; try again next time.
  }
}

async function checkUpdatesAction() {
  if (!swRegistration) {
    notify("Updates install automatically when Acoustify is opened from the web.");
    return;
  }
  if (waitingWorker || swRegistration.waiting) {
    waitingWorker = waitingWorker || swRegistration.waiting;
    showUpdateToast();
    return;
  }
  await checkForAppUpdate({ force: true });
  if (swRegistration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = swRegistration.waiting;
    scheduleRefresh(["settings"]);
    showUpdateToast();
  } else if (swRegistration.installing) {
    notify("Downloading the update…");
  } else {
    notify("You're on the latest version.");
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The first install also fires this; only reload when an update was accepted.
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    location.reload();
  });
  try {
    swRegistration = (await navigator.serviceWorker.register("./sw.js", { scope: "./" })) || null;
  } catch (error) {
    console.debug("Service worker registration skipped.", error);
  }
  if (!swRegistration) return;
  lastUpdateCheckAt = Date.now(); // register() just checked
  const watchInstall = (worker) => worker?.addEventListener("statechange", () => {
    if (worker.state === "installed" && navigator.serviceWorker.controller) onUpdateReady(worker);
  });
  if (swRegistration.waiting && navigator.serviceWorker.controller) onUpdateReady(swRegistration.waiting);
  // The launch's own update check can already be installing a new version
  // (its updatefound fired before this listener existed).
  else watchInstall(swRegistration.installing);
  swRegistration.addEventListener("updatefound", () => watchInstall(swRegistration.installing));
  setInterval(() => {
    if (document.visibilityState === "visible") checkForAppUpdate({ force: true });
  }, UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Action registry (§11)

const ACTIONS = {
  "play-source": (el) => playContext("source", el.dataset.sourceId || el.dataset.playSource),
  "shuffle-source": (el) => playContext("source", el.dataset.sourceId || el.dataset.playSource, { shuffle: true }),
  "play-track": (el) => playTrackFromList(el),
  "track-menu": (el) => openTrackMenu(el),
  "source-menu": (el) => openSourceMenu(el),
  "play-artist": (el) => playContext("artist", el.dataset.artist || el.dataset.playArtist),
  "shuffle-artist": (el) => playContext("artist", el.dataset.artist || el.dataset.playArtist, { shuffle: true }),
  "play-series": (el) => playContext("series", el.dataset.series || el.dataset.playSeries),
  "shuffle-series": (el) => playContext("series", el.dataset.series || el.dataset.playSeries, { shuffle: true }),
  "play-playlist": (el) => playContext("playlist", el.dataset.playlistId || el.dataset.playPlaylist),
  "shuffle-playlist": (el) => playContext("playlist", el.dataset.playlistId || el.dataset.playPlaylist, { shuffle: true }),
  "playlist-menu": (el) => openPlaylistMenu(el),
  "play-liked": () => playContext("liked", ""),
  "shuffle-liked": () => playContext("liked", "", { shuffle: true }),
  "play-history": () => playContext("history", ""),
  "play-all-songs": (el) => playContext("songs", el.dataset.sort || currentRoute?.params.get("sort") || "title"),
  "shuffle-all-songs": (el) => playContext("songs", el.dataset.sort || currentRoute?.params.get("sort") || "title", { shuffle: true }),
  resume: () => resumePlayback(),
  "toggle-like": (el) => {
    toggleLike(el.dataset.likeKey || el.dataset.trackKey);
  },
  "toggle-download": (el) => toggleDownload(el.dataset.downloadSource || el.dataset.sourceId),
  "download-all": () => downloadAll(),
  "remove-all-downloads": () => removeAllDownloads(),
  "new-playlist": () => openPlaylistDialog(),
  "clear-history": () => clearHistory(),
  "sync-now": () => syncNow(),
  "connect-library": () => navigate(CONNECT_HASH),
  "disconnect-library": async () => {
    const ok = await confirmDialog({
      title: "Disconnect your library?",
      body: "Downloaded music keeps playing. Everything else needs your access token again.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!ok) return;
    await disconnectLibrary();
    notify("Library disconnected");
  },
  "check-updates": () => checkUpdatesAction(),
  "apply-update": () => applyUpdate(),
  "install-app": () => installApp(),
  "export-backup": () => exportBackup(),
  "import-backup": () => {
    if (!dom.backupImport) return;
    dom.backupImport.value = "";
    dom.backupImport.click();
  },
  "reset-app": () => resetApp(),
  "open-now-playing": () => {
    if (nowPlaying && !nowPlaying.isOpen()) nowPlaying.open();
  },
  "go-back": () => goBack(),
  "skip-to-content": () => dom.main?.focus({ preventScroll: true }),
  "reload-app": () => location.reload()
};

const busyActions = new Set();
const EXCLUSIVE_ACTIONS = new Set(["sync-now", "check-updates", "download-all", "remove-all-downloads", "reset-app", "install-app", "disconnect-library"]);

async function runAction(name, element, event) {
  if (EXCLUSIVE_ACTIONS.has(name)) {
    if (busyActions.has(name)) return;
    busyActions.add(name);
  }
  try {
    await ACTIONS[name](element, event);
  } catch (error) {
    reportError(error);
  } finally {
    busyActions.delete(name);
  }
}

// ---------------------------------------------------------------------------
// DOM wiring

function onDocumentClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  const element = event.target.closest?.("[data-action]");
  if (element) {
    const name = element.dataset.action;
    // Unknown names belong to view-local handlers wired in after(root).
    if (!Object.hasOwn(ACTIONS, name)) return;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    runAction(name, element, event);
    return;
  }
  const link = event.target.closest?.("a[href^='#']");
  if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const tab = link.closest("#tabbar") ? link.dataset.nav : null;
  if (tab && TAB_ROOTS[tab]) {
    event.preventDefault();
    openTab(tab, link.getAttribute("href"));
    return;
  }
  rememberTab();
  restamp();
  // Tapping the link for the page you're on scrolls it back to the top.
  if (link.getAttribute("href") === location.hash) {
    event.preventDefault();
    writeScroll(0, prefersReducedMotion() ? "instant" : "smooth");
  }
}

function onDocumentChange(event) {
  const target = event.target;
  if (target === dom.backupImport) {
    const file = target.files?.[0];
    target.value = "";
    if (file) runSafely(() => importBackupFile(file));
    return;
  }
  if (target instanceof HTMLElement && target.matches("input[data-setting], select[data-setting]")) onSettingInput(target);
}

function onDocumentSubmit(event) {
  const form = event.target;
  if (form === dom.playlistForm) {
    onPlaylistFormSubmit(event);
    return;
  }
  if (form instanceof HTMLFormElement && form.matches("form[data-form='token']")) {
    if (event.defaultPrevented) return; // the settings view handled it itself
    event.preventDefault();
    runSafely(() => onTokenFormSubmit(form));
  }
}

const INTERACTIVE = "button, input, select, textarea, summary, [role='button'], [role='slider'], [role='switch'], [role='menuitem'], [contenteditable='true']";

function onKeyDown(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  if (document.querySelector("dialog[open]") || document.querySelector("#sheet-root .sheet-layer")) return;
  const target = event.target instanceof Element ? event.target : null;
  if (isEditable(target)) return;
  const interactive = target?.closest(INTERACTIVE);
  if (event.key === " " || event.key === "Spacebar") {
    if (interactive || event.repeat) return;
    event.preventDefault();
    runSafely(() => togglePlayback());
  } else if (event.key === "/") {
    event.preventDefault();
    if (currentRoute?.name === "search") focusSearchInput();
    else {
      pendingSearchFocus = true;
      navigate("#/search");
    }
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (interactive?.matches("input, select, textarea, [role='slider']") || !player?.currentTrack) return;
    event.preventDefault();
    const step = (event.shiftKey ? 30 : 5) * (event.key === "ArrowRight" ? 1 : -1);
    const now = typeof player.positionAt === "function" ? player.positionAt() : player.currentTime;
    runSafely(() => player.seekAbsolute(now + step));
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    saveScroll();
    storeScrollMemory();
    persistPlaybackNow();
    return;
  }
  returnedFromHiddenAt = Date.now();
  player?.syncPlaybackState();
  checkForAppUpdate().then(() => {
    if (waitingWorker && canAutoApplyUpdate()) applyUpdate();
  });
}

// Views that rewrite their own query in place (library tabs, song sort) announce
// it, so the current route and the lit nav item follow without a re-render.
function onRouteReplaced() {
  if (!ready) return;
  currentRoute = parseRoute(location.hash);
  updateNav(currentRoute);
  rememberTab();
  if (dom.view) syncPlayButtons(dom.view);
}

function wireDomEvents() {
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("acoustify:route-replaced", onRouteReplaced);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("change", onDocumentChange);
  document.addEventListener("submit", onDocumentSubmit);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  dom.view.addEventListener("focusout", onViewFocusOut);
  document.addEventListener("pointerdown", () => {
    pointerIsDown = true;
    lastInteractionAt = Date.now();
  }, { capture: true, passive: true });
  document.addEventListener("keydown", () => { lastInteractionAt = Date.now(); }, { capture: true, passive: true });
  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, () => { pointerIsDown = false; }, { capture: true, passive: true });
  }
  window.addEventListener("pagehide", () => {
    saveScroll();
    storeScrollMemory();
    persistPlaybackNow();
  });
  window.addEventListener("pageshow", () => player?.syncPlaybackState());
  window.addEventListener("online", () => {
    updateNetworkClass();
    scheduleRefresh(["settings", "downloads"]);
  });
  window.addEventListener("offline", () => {
    updateNetworkClass();
    notify("You're offline. Downloaded music keeps playing.", { duration: 4500 });
    scheduleRefresh(["settings", "downloads"]);
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    scheduleRefresh(["settings"]);
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredInstallPrompt = null;
    scheduleRefresh(["settings"]);
  });
}

// ---------------------------------------------------------------------------
// Startup

function renderLoading() {
  if (dom.view.childElementCount) return;
  dom.view.innerHTML = String(html`<div class="page">${skeletonGrid(8)}</div>`);
}

function renderFatal(error) {
  console.error(error);
  dom.view.innerHTML = String(html`<div class="page">${emptyState({
    iconName: "alert",
    title: "Acoustify couldn't start",
    body: "Something went wrong while opening your library. Reloading usually fixes it.",
    actionHtml: html`<button class="btn btn-primary" type="button" data-action="reload-app">Reload</button>`
  })}</div>`);
  // Startup may have failed before the global click delegation was wired.
  dom.view.querySelector("[data-action='reload-app']")?.addEventListener("click", () => location.reload());
}

function createPlayer() {
  // nowplaying builds #youtube-player-wrap during mount(); the player needs it.
  nowPlaying = createNowPlaying({
    appRoot: dom.app,
    barRoot: dom.playerBar,
    sheetRoot: dom.nowPlaying,
    getCatalog: () => catalog,
    isLiked: (key) => likedSet.has(key),
    onNavigate: (hash) => navigate(hash),
    getContext: playbackContextLink,
    restorePlayback: restorePausedPlayback
  });
  nowPlaying.mount();
  player = new PlaybackController({
    resolveTrack: (key) => catalog.trackByKey.get(key),
    resolveSource: (id) => catalog.sourceById.get(id),
    getAudioAsset,
    audio: dom.audio,
    youtubeWrap: document.getElementById("youtube-player-wrap"),
    youtubeContainerId: "youtube-player",
    ensureStreamable,
    mediaSessionArtwork
  });
  nowPlaying.attach(player);
  player.configure(state.settings);
  player.setQueue(state.playback.queue);
  wirePlayerEvents();
  renderPersistedPlayback();
}

async function init() {
  initUI();
  updateNetworkClass();
  consumeConnectLink();
  initHistoryEntry();
  renderLoading();

  adoptState(normalizeState(await getValue(STATE_KEY, null)));

  sync = new LibrarySync();
  sync.addEventListener("status", onSyncStatusEvent);
  // Attached before start(): a library adopted before the first render is queued, not lost.
  sync.addEventListener("library", onLibraryEvent);
  offline = new OfflineStore();
  offline.addEventListener("change", onDownloadChange);
  const offlineScan = offline.init().catch((error) => console.warn("Downloads could not be read.", error));

  const start = await sync.start();
  library = start?.library || null;
  libraryOrigin = start?.origin || "none";
  lastSyncStatus = { ...getSyncStatus() };
  rebuildCatalog();

  createPlayer();
  wireDomEvents();
  renderPlaylistNav();
  ready = true;
  renderRoute({ mode: "initial" });
  if (lastSyncStatus?.state === "ok" && lastSyncStatus.hasToken) checkStoredTokenAccess();

  if (pendingLibraryEvent) {
    const detail = pendingLibraryEvent;
    pendingLibraryEvent = null;
    adoptLibrary(detail);
  }
  warnAboutConnectLink();
  offlineScan.then(() => {
    scheduleDownloadSync();
    scheduleRefresh(["downloads", "settings"]);
  });
  registerServiceWorker();
}

init().catch(renderFatal);
