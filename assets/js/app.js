import {
  clearAudioAssets,
  deleteAudioAsset,
  getAudioAsset,
  getValue,
  putAudioAsset,
  requestPersistentStorage,
  setValue,
  storageEstimate
} from "./db.js";
import {
  loadBaseCatalog,
  mergeCatalog,
  parseChapterLines,
  sourceFromStudioForm,
  sourceWithLocalAudio,
  validateCatalog
} from "./catalog.js";
import { PlaybackController } from "./player.js";
import {
  clamp,
  debounce,
  deepClone,
  downloadJson,
  escapeHtml,
  formatTime,
  parseExtractedYouTubeId,
  relativeDate,
  safeArtwork,
  slugify
} from "./utils.js";

const STATE_KEY = "app-state-v2";
const APP_VERSION = 3;
const DEFAULT_STATE = {
  version: APP_VERSION,
  liked: [],
  history: [],
  playCounts: {},
  playlists: [],
  userSources: [],
  settings: {
    volume: 0.86,
    repeat: "off",
    shuffle: false,
    autoplay: true,
    playerPanelOpen: false,
    segmentLeadIn: 0.5,
    keepScreenAwake: false
  },
  playback: {
    trackKey: null,
    absolutePosition: 0,
    updatedAt: null
  }
};

const dom = {
  shell: document.getElementById("app-shell"),
  view: document.getElementById("view"),
  mainStage: document.getElementById("main-stage"),
  playlistNav: document.getElementById("playlist-nav"),
  networkPill: document.getElementById("network-pill"),
  playerPanel: document.getElementById("player-panel"),
  panelTrackTitle: document.getElementById("panel-track-title"),
  panelArtwork: document.getElementById("panel-artwork"),
  panelTitle: document.getElementById("panel-title"),
  panelArtist: document.getElementById("panel-artist"),
  qualityReadout: document.getElementById("quality-readout"),
  sourceNote: document.getElementById("source-note"),
  queueCount: document.getElementById("queue-count"),
  queueList: document.getElementById("queue-list"),
  barArtwork: document.getElementById("bar-artwork"),
  barTrackTitle: document.getElementById("bar-track-title"),
  barTrackArtist: document.getElementById("bar-track-artist"),
  barLike: document.getElementById("bar-like"),
  playButton: document.getElementById("play-button"),
  shuffleButton: document.getElementById("shuffle-button"),
  repeatButton: document.getElementById("repeat-button"),
  elapsedTime: document.getElementById("elapsed-time"),
  durationTime: document.getElementById("duration-time"),
  progress: document.getElementById("progress-control"),
  volume: document.getElementById("volume-control"),
  toastRegion: document.getElementById("toast-region"),
  playlistDialog: document.getElementById("playlist-dialog"),
  playlistForm: document.getElementById("playlist-form"),
  playlistDialogTitle: document.getElementById("playlist-dialog-title"),
  addDialog: document.getElementById("add-to-playlist-dialog"),
  addDialogList: document.getElementById("add-to-playlist-list"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmMessage: document.getElementById("confirm-message"),
  memoryImport: document.getElementById("memory-import"),
  extractedAudioImport: document.getElementById("extracted-audio-import"),
  adBanner: document.getElementById("ad-banner")
};

let state = deepClone(DEFAULT_STATE);
let baseCatalog = null;
let catalog = null;
let player = null;
let viewQueues = new Map();
let pendingLocalFile = null;
let pendingExtractedSourceId = "";
let pendingConfirm = null;
let activeAddTrackKey = null;
let userSeeking = false;
let lastPlaybackPersistAt = 0;
let currentRouteKey = "";
let deferredInstallPrompt = null;
let appInstalled = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallState();
});

window.addEventListener("appinstalled", () => {
  appInstalled = true;
  deferredInstallPrompt = null;
  updateInstallState();
});

const persistState = debounce(async () => {
  try {
    await setValue(STATE_KEY, state);
  } catch (error) {
    toast(`Couldn't save your changes: ${error.message}`, "error");
  }
}, 180);

function normalizeState(input) {
  const candidate = input && typeof input === "object" ? input : {};
  const candidateSettings = { ...(candidate.settings || {}) };
  // Cuts are song-start accurate now, so the old 1.5s default lead-in mostly
  // replayed pre-song talk. Migrate only the untouched default.
  if (Number(candidate.version) < 3 && Number(candidateSettings.segmentLeadIn) === 1.5) {
    candidateSettings.segmentLeadIn = 0.5;
  }
  return {
    ...deepClone(DEFAULT_STATE),
    ...candidate,
    version: APP_VERSION,
    liked: Array.isArray(candidate.liked) ? [...new Set(candidate.liked.filter(Boolean))] : [],
    history: Array.isArray(candidate.history) ? candidate.history.filter((item) => item?.trackKey).slice(0, 500) : [],
    playCounts: candidate.playCounts && typeof candidate.playCounts === "object" ? candidate.playCounts : {},
    playlists: Array.isArray(candidate.playlists)
      ? candidate.playlists.map((playlist) => ({
          id: playlist.id || crypto.randomUUID(),
          name: playlist.name || "Untitled playlist",
          description: playlist.description || "",
          trackKeys: [...new Set((playlist.trackKeys || []).filter(Boolean))],
          createdAt: playlist.createdAt || Date.now(),
          updatedAt: playlist.updatedAt || Date.now()
        }))
      : [],
    userSources: Array.isArray(candidate.userSources) ? candidate.userSources : [],
    settings: {
      ...DEFAULT_STATE.settings,
      ...candidateSettings
    },
    playback: {
      ...DEFAULT_STATE.playback,
      ...(candidate.playback || {})
    }
  };
}

function rebuildCatalog() {
  catalog = mergeCatalog(baseCatalog, state.userSources);
  const validKeys = new Set(catalog.tracks.map((track) => track.key));
  state.liked = state.liked.filter((key) => validKeys.has(key));
  state.history = state.history.filter((entry) => validKeys.has(entry.trackKey));
  state.playlists = state.playlists.map((playlist) => ({
    ...playlist,
    trackKeys: playlist.trackKeys.filter((key) => validKeys.has(key))
  }));
  if (state.playback.trackKey && !validKeys.has(state.playback.trackKey)) {
    state.playback = deepClone(DEFAULT_STATE.playback);
  }
  renderPlaylistNav();
}

function currentHash() {
  return location.hash || "#/home";
}

function parseRoute() {
  const raw = currentHash().replace(/^#\/?/, "");
  const [pathPart = "home", queryPart = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const name = segments[0] || "home";
  return {
    name,
    segments,
    params: new URLSearchParams(queryPart),
    key: `${pathPart}?${queryPart}`
  };
}

function navigate(path) {
  const target = path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
  if (location.hash === target) renderRoute();
  else location.hash = target;
}

function artworkAttrs(sourceOrTrack) {
  const primary = escapeHtml(safeArtwork(sourceOrTrack));
  const fallback = escapeHtml(sourceOrTrack?.fallbackArtwork || "./assets/icons/icon-512.png");
  return `src="${primary}" onerror="this.onerror=null;this.src='${fallback}'"`;
}

function providerLabel(source) {
  if (source.provider === "local" && source.assetId) return "My audio";
  if (source.provider === "local" && source.audioUrl) return "Included";
  return "YouTube";
}

function timingLabel(source) {
  if (source.timingStatus === "calibration-required") return "Check song times";
  if (source.timingStatus === "album-derived") return "Album timings";
  if (source.timingStatus === "comment-derived") return "Comment timings";
  if (source.timingStatus === "user-calibrated") return "Edited timings";
  return "Ready";
}

function sourceIsUserOverride(sourceId) {
  return state.userSources.some((source) => source.id === sourceId);
}

function registerQueue(prefix, tracks) {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  viewQueues.set(id, tracks.map((track) => track.key));
  return id;
}

function resolveQueue(id, fallbackTrack = null) {
  if (id && viewQueues.has(id)) return viewQueues.get(id);
  if (fallbackTrack) {
    const source = catalog.sourceById.get(fallbackTrack.sourceId);
    return source?.tracks.map((track) => track.key) || [fallbackTrack.key];
  }
  return [];
}

function uniqueHistoryTracks(limit = 20) {
  const seen = new Set();
  const result = [];
  for (const entry of state.history) {
    if (seen.has(entry.trackKey)) continue;
    const track = catalog.trackByKey.get(entry.trackKey);
    if (!track) continue;
    seen.add(entry.trackKey);
    result.push({ ...track, playedAt: entry.playedAt, savedPosition: entry.position });
    if (result.length >= limit) break;
  }
  return result;
}

function sourceCard(source) {
  const warning = source.timingStatus === "calibration-required";
  return `
    <article class="card source-card" tabindex="0" data-action="open-source" data-source-id="${escapeHtml(source.id)}">
      <div class="card-badges">
        <span class="badge ${source.provider === "local" ? "local" : ""}">${source.provider === "local" ? source.assetId ? "My audio" : "Included" : "YouTube"}</span>
        ${warning ? '<span class="badge warning">Check times</span>' : ""}
      </div>
      <div class="card-art">
        <img ${artworkAttrs(source)} alt="${escapeHtml(source.title)} artwork" loading="lazy">
        <button class="card-play" type="button" data-action="play-source" data-source-id="${escapeHtml(source.id)}" aria-label="Play ${escapeHtml(source.title)}">▶</button>
      </div>
      <h3>${escapeHtml(source.title)}</h3>
      <p>${escapeHtml(source.artist)} · ${source.tracks.length} song${source.tracks.length === 1 ? "" : "s"}</p>
    </article>`;
}

function playlistArtwork(playlist) {
  const tracks = playlist.trackKeys.map((key) => catalog.trackByKey.get(key)).filter(Boolean).slice(0, 4);
  if (!tracks.length) return '<div class="playlist-placeholder">♫</div>';
  return tracks.map((track) => `<img ${artworkAttrs(track)} alt="" loading="lazy">`).join("");
}

function playlistCard(playlist) {
  return `
    <article class="card playlist-card" tabindex="0" data-action="open-playlist" data-playlist-id="${escapeHtml(playlist.id)}">
      <div class="card-art">
        ${playlistArtwork(playlist)}
        <button class="card-play" type="button" data-action="play-playlist" data-playlist-id="${escapeHtml(playlist.id)}" aria-label="Play ${escapeHtml(playlist.name)}">▶</button>
      </div>
      <h3>${escapeHtml(playlist.name)}</h3>
      <p>${playlist.trackKeys.length} song${playlist.trackKeys.length === 1 ? "" : "s"}${playlist.description ? ` · ${escapeHtml(playlist.description)}` : ""}</p>
    </article>`;
}

function emptyState({ symbol = "♫", title, copy, action = "", actionLabel = "" }) {
  return `
    <div class="empty-state">
      <div>
        <span class="empty-symbol">${symbol}</span>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(copy)}</p>
        ${action ? `<button class="button primary" type="button" data-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>` : ""}
      </div>
    </div>`;
}

function trackTable(tracks, {
  prefix = "tracks",
  showSource = false,
  playlistId = null,
  emptyTitle = "No songs here yet",
  emptyCopy = "Add some music or save songs here."
} = {}) {
  if (!tracks.length) return emptyState({ title: emptyTitle, copy: emptyCopy, action: "go-studio", actionLabel: "Add music" });
  const queueId = registerQueue(prefix, tracks);
  const currentKey = player?.currentTrack?.key;
  const body = tracks.map((track, index) => {
    const source = catalog.sourceById.get(track.sourceId);
    const liked = state.liked.includes(track.key);
    const isActive = currentKey === track.key;
    const duration = Math.max(0, track.end - track.start);
    const removeButton = playlistId
      ? `<button class="icon-button" type="button" data-action="remove-from-playlist" data-playlist-id="${escapeHtml(playlistId)}" data-track-key="${escapeHtml(track.key)}" aria-label="Remove from playlist">−</button>`
      : `<button class="icon-button" type="button" data-action="add-to-playlist" data-track-key="${escapeHtml(track.key)}" aria-label="Add to playlist">＋</button>`;
    return `
      <tr class="track-row ${isActive ? "active" : ""}" data-track-key="${escapeHtml(track.key)}">
        <td>
          <span class="row-index">${index + 1}</span>
          <button class="row-play" type="button" data-action="play-track" data-track-key="${escapeHtml(track.key)}" data-queue-id="${escapeHtml(queueId)}" aria-label="Play ${escapeHtml(track.title)}">${isActive && player?.isPlaying ? "Ⅱ" : "▶"}</button>
        </td>
        <td class="track-title-cell">
          <div class="track-title-wrap">
            ${showSource ? `<img class="track-thumb" ${artworkAttrs(track)} alt="" loading="lazy">` : ""}
            <div class="track-copy">
              <strong>${escapeHtml(track.title)}</strong>
              <span>${escapeHtml(track.artist)}</span>
            </div>
          </div>
        </td>
        ${showSource ? `<td class="source-col"><button class="source-link" type="button" data-action="open-source" data-source-id="${escapeHtml(track.sourceId)}">${escapeHtml(track.sourceTitle)}</button></td>` : ""}
        <td class="duration-col mono">${formatTime(duration)}</td>
        <td class="action-col">
          <div class="track-actions">
            <button class="icon-button ${liked ? "active" : ""}" type="button" data-action="toggle-like" data-track-key="${escapeHtml(track.key)}" aria-label="${liked ? "Unlike" : "Like"} ${escapeHtml(track.title)}">${liked ? "♥" : "♡"}</button>
            ${removeButton}
          </div>
        </td>
      </tr>`;
  }).join("");

  return `
    <div class="track-table-wrap">
      <table class="track-list">
        <thead><tr><th>#</th><th>Title</th>${showSource ? '<th class="source-col">Album</th>' : ""}<th class="duration-col">Time</th><th class="action-col"></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderPlaylistNav() {
  if (!state.playlists.length) {
    dom.playlistNav.innerHTML = '<div class="empty-nav">Your playlists will show up here.</div>';
    return;
  }
  dom.playlistNav.innerHTML = state.playlists.map((playlist) => `
    <a href="#/playlist/${encodeURIComponent(playlist.id)}" data-route data-playlist-nav="${escapeHtml(playlist.id)}">
      <span class="nav-icon">♫</span><span>${escapeHtml(playlist.name)}</span>
    </a>`).join("");
}

function renderHome() {
  const sources = catalog.sources;
  const recent = uniqueHistoryTracks(6);
  const resumeTrack = catalog.trackByKey.get(state.playback.trackKey);
  const totalDuration = sources.reduce((sum, source) => sum + source.duration, 0);
  const quick = sources.slice(0, 6);
  const recentQueueId = registerQueue("recent-home", recent);

  dom.view.innerHTML = `
    <section class="home-hero">
      <div class="hero-copy">
        <p class="eyebrow">Your music</p>
        <h1>${resumeTrack ? "Pick up where you left off." : "What do you want to hear?"}</h1>
        <p>Live sessions and acoustic sets, ready to play song by song.</p>
        <div class="hero-actions">
          ${resumeTrack ? `<button class="button primary" type="button" data-action="resume-last">▶ Resume ${escapeHtml(resumeTrack.title)}</button>` : `<button class="button primary" type="button" data-action="play-source" data-source-id="${escapeHtml(sources[0]?.id || "")}">▶ Start listening</button>`}
          <button class="button secondary" type="button" data-action="go-studio">＋ Add music</button>
        </div>
        <div class="stat-strip">
          <div class="stat-card"><strong>${sources.length}</strong><span>albums</span></div>
          <div class="stat-card"><strong>${catalog.tracks.length}</strong><span>songs</span></div>
          <div class="stat-card"><strong>${state.liked.length}</strong><span>liked</span></div>
          <div class="stat-card"><strong>${formatTime(totalDuration, totalDuration >= 3600)}</strong><span>total time</span></div>
        </div>
      </div>
    </section>

    <section class="view-section">
      <div class="section-heading"><div><h2>Jump back in</h2></div></div>
      <div class="quick-grid">
        ${quick.map((source) => `
          <article class="quick-item" data-action="open-source" data-source-id="${escapeHtml(source.id)}">
            <img ${artworkAttrs(source)} alt="" loading="lazy">
            <strong>${escapeHtml(source.title)}</strong>
            <button class="icon-button quick-play" type="button" data-action="play-source" data-source-id="${escapeHtml(source.id)}" aria-label="Play ${escapeHtml(source.title)}">▶</button>
          </article>`).join("")}
      </div>
    </section>

    <section class="view-section">
      <div class="section-heading"><div><h2>Albums and sessions</h2></div><a href="#/library" data-route>Show all</a></div>
      <div class="card-grid">${sources.map(sourceCard).join("")}</div>
    </section>

    ${recent.length ? `
      <section class="view-section">
        <div class="section-heading"><div><h2>Recently played</h2></div><a href="#/history" data-route>See all</a></div>
        ${trackTable(recent, { prefix: recentQueueId, showSource: true })}
      </section>` : ""}`;
}

function renderSearch(route) {
  const query = route.params.get("q") || "";
  const tags = [...new Set(catalog.sources.flatMap((source) => source.tags || []))].sort();
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Find a song</p><h1>Search</h1><p>Search by song, artist, album, or tag.</p></div>
    </div>
    <div class="search-box">
      <span class="search-symbol">⌕</span>
      <input id="search-input" type="search" autocomplete="off" value="${escapeHtml(query)}" placeholder="What do you want to hear?" autofocus>
      <button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search">×</button>
    </div>
    <div class="tag-cloud">${tags.map((tag) => `<button class="tag-button" type="button" data-action="search-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}</div>
    <div id="search-results"></div>`;
  renderSearchResults(query);
  setTimeout(() => document.getElementById("search-input")?.focus(), 0);
}

function renderSearchResults(query) {
  const container = document.getElementById("search-results");
  if (!container) return;
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    container.innerHTML = `
      <section class="view-section">
        <div class="section-heading"><div><h2>Browse all music</h2><p>${catalog.tracks.length} songs</p></div></div>
        <div class="card-grid">${catalog.sources.map(sourceCard).join("")}</div>
      </section>`;
    return;
  }
  const words = needle.split(/\s+/).filter(Boolean);
  const matches = (value) => words.every((word) => String(value).toLowerCase().includes(word));
  const sources = catalog.sources.filter((source) => matches([source.title, source.artist, ...(source.tags || [])].join(" ")));
  const tracks = catalog.tracks.filter((track) => {
    const source = catalog.sourceById.get(track.sourceId);
    return matches([track.title, track.artist, track.sourceTitle, ...(source?.tags || [])].join(" "));
  });
  const queueId = registerQueue("search", tracks);
  container.innerHTML = `
    <p class="search-summary">${tracks.length} song${tracks.length === 1 ? "" : "s"} and ${sources.length} album${sources.length === 1 ? "" : "s"} found for “${escapeHtml(query)}”.</p>
    ${sources.length ? `<section class="view-section"><div class="section-heading"><h2>Albums</h2></div><div class="card-grid">${sources.map(sourceCard).join("")}</div></section>` : ""}
    <section class="view-section"><div class="section-heading"><h2>Songs</h2></div>${tracks.length ? trackTable(tracks, { prefix: queueId, showSource: true }) : emptyState({ symbol: "⌕", title: "Nothing found", copy: "Try a shorter search." })}</section>`;
}

function allSongTracks() {
  return [...catalog.tracks].sort((a, b) => a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist));
}

function renderSongs() {
  const tracks = allSongTracks();
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">All music</p><h1>Songs</h1><p>${tracks.length} song${tracks.length === 1 ? "" : "s"} from ${catalog.sources.length} album${catalog.sources.length === 1 ? "" : "s"}.</p></div>
      ${tracks.length ? '<div class="page-actions"><button class="button primary" type="button" data-action="play-songs">▶ Play all</button><button class="button secondary" type="button" data-action="shuffle-songs">⤨ Shuffle</button></div>' : ""}
    </div>
    ${trackTable(tracks, { prefix: "songs", showSource: true, emptyTitle: "No songs yet", emptyCopy: "Add some music to get started." })}`;
}

function renderLibrary() {
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your music</p><h1>Library</h1><p>Albums, playlists, and liked songs.</p></div>
      <div class="page-actions"><button class="button primary" type="button" data-action="go-studio">＋ Add music</button><button class="button secondary" type="button" data-action="new-playlist">＋ Playlist</button></div>
    </div>
    <section class="view-section">
      <div class="section-heading"><div><h2>Albums and sessions</h2><p>${catalog.sources.length} albums · ${catalog.tracks.length} songs</p></div></div>
      <div class="card-grid">${catalog.sources.map(sourceCard).join("")}</div>
    </section>
    <section class="view-section">
      <div class="section-heading"><div><h2>Playlists</h2></div></div>
      ${state.playlists.length ? `<div class="card-grid">${state.playlists.map(playlistCard).join("")}</div>` : emptyState({ symbol: "＋", title: "No playlists yet", copy: "Make one for whatever you're in the mood for.", action: "new-playlist", actionLabel: "Create playlist" })}
    </section>`;
}

function renderLiked() {
  const tracks = state.liked.map((key) => catalog.trackByKey.get(key)).filter(Boolean);
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Your favorites</p><h1>Liked Songs</h1><p>${tracks.length} liked song${tracks.length === 1 ? "" : "s"}.</p></div>
      ${tracks.length ? '<div class="page-actions"><button class="button primary" type="button" data-action="play-liked">▶ Play all</button></div>' : ""}
    </div>
    ${trackTable(tracks, { prefix: "liked", showSource: true, emptyTitle: "No liked songs yet", emptyCopy: "Tap the heart next to a song to save it here." })}`;
}

function renderHistory() {
  const tracks = uniqueHistoryTracks(100);
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Recently played</p><h1>History</h1><p>Your latest songs.</p></div>
      ${tracks.length ? '<div class="page-actions"><button class="button ghost" type="button" data-action="clear-history">Clear history</button></div>' : ""}
    </div>
    ${trackTable(tracks, { prefix: "history", showSource: true, emptyTitle: "Nothing here yet", emptyCopy: "Songs you play will show up here." })}`;
}

function renderSource(sourceId) {
  const source = catalog.sourceById.get(sourceId);
  if (!source) {
    dom.view.innerHTML = emptyState({ symbol: "?", title: "Album not found", copy: "It may have been removed.", action: "go-library", actionLabel: "Back to library" });
    return;
  }
  const duration = formatTime(source.duration, source.duration >= 3600);
  const canOpenYouTube = Boolean(source.youtubeId);
  const canRestoreYouTube = source.provider === "local" && source.youtubeId && sourceIsUserOverride(source.id);
  const packagedSource = baseCatalog.sources.find((item) => item.id === source.id);
  const restoreLabel = packagedSource?.provider === "local" ? "Use included audio" : "Use YouTube";
  dom.view.innerHTML = `
    <section class="collection-hero">
      <img class="collection-art" ${artworkAttrs(source)} alt="${escapeHtml(source.title)} artwork">
      <div class="collection-copy">
        <p class="eyebrow">Album</p>
        <h1>${escapeHtml(source.title)}</h1>
        <p>${escapeHtml(source.description || `${source.tracks.length} songs by ${source.artist}.`)}</p>
        <div class="collection-meta"><strong>${escapeHtml(source.artist)}</strong><span>•</span><span>${source.year || "Live session"}</span><span>•</span><span>${source.tracks.length} song${source.tracks.length === 1 ? "" : "s"}</span><span>•</span><span>${duration}</span><span>•</span><span>${providerLabel(source)}</span></div>
      </div>
    </section>
    <div class="collection-controls">
      <button class="play-button big-play" type="button" data-action="play-source" data-source-id="${escapeHtml(source.id)}" aria-label="Play source">▶</button>
      <button class="button ghost small-button" type="button" data-action="shuffle-source" data-source-id="${escapeHtml(source.id)}">⤨ Shuffle</button>
      <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">${source.timingStatus === "calibration-required" ? "Fix song times" : "Edit song times"}</button>
      ${source.youtubeId ? `<button class="button secondary small-button" type="button" data-action="attach-extracted-audio" data-source-id="${escapeHtml(source.id)}">${source.provider === "local" ? "Change audio" : "Use my audio"}</button>` : ""}
      ${canRestoreYouTube ? `<button class="button ghost small-button" type="button" data-action="restore-youtube-source" data-source-id="${escapeHtml(source.id)}">${restoreLabel}</button>` : ""}
      ${canOpenYouTube ? `<a class="button ghost small-button" href="https://www.youtube.com/watch?v=${encodeURIComponent(source.youtubeId)}" target="_blank" rel="noopener noreferrer">View on YouTube ↗</a>` : ""}
    </div>
    ${source.timingStatus === "calibration-required" ? `
      <div class="info-banner warning-banner">
        <span class="info-icon">!</span>
        <div><h3>Check the song times</h3><p>${escapeHtml(source.timingNote || "Listen through once and mark where each song starts.")}</p></div>
        <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">Fix times</button>
      </div>` : ""}
    <section class="view-section">
      ${trackTable(source.tracks, { prefix: `source-${source.id}`, showSource: false })}
    </section>`;
}

function renderPlaylist(playlistId) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  if (!playlist) {
    dom.view.innerHTML = emptyState({ symbol: "?", title: "Playlist not found", copy: "It may have been deleted.", action: "go-library", actionLabel: "Back to library" });
    return;
  }
  const tracks = playlist.trackKeys.map((key) => catalog.trackByKey.get(key)).filter(Boolean);
  const total = tracks.reduce((sum, track) => sum + track.end - track.start, 0);
  dom.view.innerHTML = `
    <section class="collection-hero">
      <div class="collection-art playlist-art">♫</div>
      <div class="collection-copy">
        <p class="eyebrow">Playlist</p>
        <h1>${escapeHtml(playlist.name)}</h1>
        <p>${escapeHtml(playlist.description || "A playlist you made.")}</p>
        <div class="collection-meta"><strong>My playlist</strong><span>•</span><span>${tracks.length} songs</span><span>•</span><span>${formatTime(total, total >= 3600)}</span><span>•</span><span>Updated ${relativeDate(playlist.updatedAt)}</span></div>
      </div>
    </section>
    <div class="collection-controls">
      ${tracks.length ? `<button class="play-button big-play" type="button" data-action="play-playlist" data-playlist-id="${escapeHtml(playlist.id)}">▶</button>` : ""}
      <button class="button ghost small-button" type="button" data-action="delete-playlist" data-playlist-id="${escapeHtml(playlist.id)}">Delete playlist</button>
    </div>
    <section class="view-section">${trackTable(tracks, { prefix: `playlist-${playlist.id}`, showSource: true, playlistId: playlist.id, emptyTitle: "This playlist is empty", emptyCopy: "Use the plus button next to a song to add it." })}</section>`;
}

function chapterTextForSource(source) {
  return source.tracks.map((track) => `${formatTime(track.start, track.start >= 3600)} ${track.title}`).join("\n");
}

function renderStudio(route) {
  const sourceId = route.params.get("source") || "";
  const source = sourceId ? catalog.sourceById.get(sourceId) : null;
  const provider = source?.provider || "youtube";
  const chapters = source ? chapterTextForSource(source) : "0:00 First song\n3:42 Second song\n7:15 Third song";
  const duration = source ? formatTime(source.duration, source.duration >= 3600) : "";
  const localMeta = source?.assetMeta || {};
  pendingLocalFile = null;

  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">${source ? "Edit music" : "New music"}</p><h1>${source ? "Edit album" : "Add music"}</h1><p>${source ? `Change the song times for ${escapeHtml(source.title)}.` : "Add a YouTube session or an audio file."}</p></div>
      ${source ? `<div class="page-actions"><button class="button ghost" type="button" data-action="studio-reset">＋ Add something else</button></div>` : ""}
    </div>

    <div class="studio-layout">
      <section class="surface-card">
        <h2>Details</h2>
        <p>Anything you add here stays on this device.</p>
        <form id="studio-form">
          <input type="hidden" name="id" value="${escapeHtml(source?.id || "")}">
          <input type="hidden" name="assetId" value="${escapeHtml(source?.assetId || "")}">
          <input type="hidden" name="audioUrl" value="${escapeHtml(source?.audioUrl || "")}">
          <input type="hidden" name="assetName" value="${escapeHtml(localMeta.name || "")}">
          <input type="hidden" name="assetType" value="${escapeHtml(localMeta.type || "")}">
          <input type="hidden" name="assetSize" value="${escapeHtml(localMeta.size || "")}">
          <div class="form-grid">
            <fieldset class="field full provider-choice">
              <legend>Where is the music?</legend>
              <label class="provider-option"><input type="radio" name="provider" value="youtube" ${provider === "youtube" ? "checked" : ""}><span>▶ YouTube link</span></label>
              <label class="provider-option"><input type="radio" name="provider" value="local" ${provider === "local" ? "checked" : ""}><span>◇ Audio file</span></label>
            </fieldset>
            <label class="field"><span>Album or session name</span><input name="title" required maxlength="140" value="${escapeHtml(source?.title || "")}" placeholder="The Cabin Sessions"></label>
            <label class="field"><span>Artist</span><input name="artist" required maxlength="120" value="${escapeHtml(source?.artist || "")}" placeholder="Of Monsters and Men"></label>
            <label class="field full youtube-field" ${provider !== "youtube" ? "hidden" : ""}><span>YouTube link</span><input name="youtubeInput" value="${escapeHtml(source?.youtubeId || "")}" placeholder="https://youtu.be/…"><small>This will play through YouTube.</small></label>
            <div class="field full local-field" ${provider !== "local" ? "hidden" : ""}>
              <span>Audio file</span>
              <label class="file-drop"><input id="local-file-input" type="file" accept="audio/*,.flac,.wav,.aiff,.aif,.m4a,.alac"><span id="local-file-label">${source?.assetId ? `<strong>${escapeHtml(localMeta.name || "Audio saved")}</strong><br>Choose another file to replace it.` : source?.audioUrl ? `<strong>Audio included</strong><br>Choose another file to replace it on this device.` : `<strong>Choose an audio file</strong><br>Use a file you own or have permission to play.`}</span></label>
            </div>
            <label class="field"><span>Total length</span><input name="duration" required value="${escapeHtml(duration)}" placeholder="56:55"><small>For example, 56:55.</small></label>
            <label class="field"><span>Year</span><input name="year" inputmode="numeric" value="${escapeHtml(source?.year || "")}" placeholder="2026"></label>
            <label class="field full"><span>Cover image URL</span><input name="artwork" value="${escapeHtml(source?.artwork || "")}" placeholder="Optional"></label>
            <label class="field full"><span>Description</span><textarea name="description" rows="3" placeholder="Optional note">${escapeHtml(source?.description || "")}</textarea></label>
            <label class="field full"><span>Tags</span><input name="tags" value="${escapeHtml((source?.tags || []).join(", "))}" placeholder="live, acoustic, rare"></label>
            <label class="field full"><span>Song start times</span><textarea id="chapter-input" name="chapters" rows="${source ? Math.min(18, Math.max(7, source.tracks.length + 1)) : 8}" required>${escapeHtml(chapters)}</textarea><small>One per line, like <span class="mono">0:00 Song title</span>.</small></label>
          </div>
          <div class="form-actions">
            <button class="button ghost" type="button" data-action="preview-chapters">Check song list</button>
            <button class="button primary" type="submit">${source ? "Save changes" : "Add to library"}</button>
          </div>
        </form>
      </section>

      <aside class="surface-card">
        <h2>Songs</h2>
        <p>Check the order and times before saving.</p>
        <div id="chapter-preview" class="preview-list"></div>
        <div class="studio-tip">Set each time to the moment the song starts.</div>
      </aside>

      ${source ? renderCalibration(source) : ""}
    </div>`;
  updateProviderFields();
  previewStudioChapters(false);
}

function renderCalibration(source) {
  return `
    <section class="surface-card calibration-card" data-calibration-source="${escapeHtml(source.id)}">
      <div class="calibration-head">
        <div><h2>Fix song times</h2><p>Play the full recording and mark the start of each song.</p></div>
        <div class="page-actions">
          <div class="calibration-clock"><span>Current</span><strong id="calibration-clock">0:00.0</strong></div>
          <button class="button secondary small-button" type="button" data-action="play-calibration-source" data-source-id="${escapeHtml(source.id)}">▶ Play full recording</button>
        </div>
      </div>
      <div class="calibration-table">
        ${source.tracks.map((track, index) => `
          <div class="calibration-row" data-cal-row="${index}">
            <span class="track-num">${index + 1}</span>
            <strong title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</strong>
            <input class="calibration-start" data-track-title="${escapeHtml(track.title)}" value="${formatPreciseTime(track.start)}" aria-label="Start time for ${escapeHtml(track.title)}">
            <button class="icon-button" type="button" data-cal-action="minus" title="Move 0.5 seconds earlier">−.5</button>
            <button class="icon-button" type="button" data-cal-action="capture" title="Set to current player time">●</button>
            <button class="icon-button" type="button" data-cal-action="plus" title="Move 0.5 seconds later">+.5</button>
          </div>`).join("")}
      </div>
      <p class="calibration-help">Pause when the song starts, tap ●, then nudge the time if needed.</p>
    </section>`;
}

function formatPreciseTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function renderSettings() {
  const userSources = state.userSources;
  const includedSourceCount = baseCatalog.sources.filter((source) => source.provider === "local" && source.audioUrl).length;
  const youtubeSourceCount = catalog.sources.filter((source) => source.provider === "youtube").length;
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Acoustify</p><h1>Settings</h1></div>
    </div>
    <div class="settings-grid">
      <section class="setting-card">
        <h3>Playback</h3>
        <div class="setting-row"><div><strong>Play the next song</strong><div class="muted small">Keep playing through an album.</div></div><label class="toggle"><input id="setting-autoplay" type="checkbox" ${state.settings.autoplay ? "checked" : ""}><span></span></label></div>
        ${youtubeSourceCount ? `
          <div class="setting-row"><div><strong>Show YouTube video</strong><div class="muted small">Open the video panel on desktop.</div></div><label class="toggle"><input id="setting-panel" type="checkbox" ${state.settings.playerPanelOpen ? "checked" : ""}><span></span></label></div>
          <label class="setting-row setting-number"><div><strong>Start a little early</strong><div class="muted small">Helps avoid clipping the first note on YouTube.</div></div><input id="setting-lead-in" type="number" min="0" max="5" step="0.5" value="${escapeHtml(state.settings.segmentLeadIn)}" aria-label="Start early by this many seconds"><span>sec</span></label>
          <div class="setting-row"><div><strong>Keep screen awake for YouTube</strong><div class="muted small">${"wakeLock" in navigator ? "Stops your phone from locking while YouTube plays." : "Not available in this browser."}</div></div><label class="toggle"><input id="setting-keep-awake" type="checkbox" ${state.settings.keepScreenAwake ? "checked" : ""} ${"wakeLock" in navigator ? "" : "disabled"}><span></span></label></div>
        ` : ""}
      </section>
      <section class="setting-card">
        <h3>Install on your phone</h3><p id="install-status">${appInstalled ? "Installed on this device." : deferredInstallPrompt ? "Ready to install." : "Open Chrome's menu and choose Add to Home screen."}</p>
        ${!appInstalled && deferredInstallPrompt ? `<div class="setting-actions"><button id="install-app-button" class="button primary small-button" type="button" data-action="install-app">Install Acoustify</button></div>` : ""}
        <div class="device-status"><span>Included</span><strong>${includedSourceCount} albums and sessions</strong></div>
        <div class="device-status"><span>Background play</span><strong>Keeps playing when you leave Chrome or lock your phone</strong></div>
      </section>
      <section class="setting-card">
        <h3>Add audio files</h3><p>Import your own files or use the extractor for music you have permission to download.</p>
        <div class="setting-actions"><a class="button secondary small-button" href="./downloads/youtube_podcast_audio_extractor.zip" download>Get extractor</a><button class="button primary small-button" type="button" data-action="attach-extracted-audio">Import audio</button></div>
      </section>
      ${youtubeSourceCount ? `<section class="setting-card">
        <h3>YouTube ads</h3><p>YouTube may play ads. Open the video when you need its Skip button.</p>
        <div class="device-status"><span>No ads</span><strong>Included audio and your own files never have YouTube ads</strong></div>
      </section>` : ""}
      <section class="setting-card">
        <h3>Storage on this device</h3><p id="storage-description">Checking storage…</p>
        <div class="storage-meter"><span id="storage-meter-fill"></span></div>
        <div class="storage-copy"><span id="storage-used">—</span><span id="storage-quota">—</span></div>
        <div class="setting-actions" style="margin-top:15px"><button class="button secondary small-button" type="button" data-action="request-persistent">Keep data on this device</button><button class="button ghost small-button" type="button" data-action="clear-local-audio">Clear imported audio</button></div>
      </section>
      <section class="setting-card">
        <h3>Backup</h3><p>Save your likes, history, playlists, settings, and added music. Audio files are not included.</p>
        <div class="setting-actions"><button class="button secondary small-button" type="button" data-action="export-memory">Export backup</button><button class="button ghost small-button" type="button" data-action="import-memory">Import backup</button><button class="button danger small-button" type="button" data-action="reset-memory">Reset Acoustify</button></div>
      </section>
      <section class="setting-card" style="grid-column:1/-1">
        <h3>Albums and sessions</h3><p>Edit your music or reset anything you've changed.</p>
        <div class="source-manager">
          ${catalog.sources.map((source) => `
            <div class="source-manager-row">
              <img ${artworkAttrs(source)} alt="">
              <div><strong>${escapeHtml(source.title)}</strong><span>${escapeHtml(source.artist)} · ${timingLabel(source)}${sourceIsUserOverride(source.id) ? " · changed" : " · included"}</span></div>
              <div class="page-actions">
                <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">Edit</button>
                ${sourceIsUserOverride(source.id) ? source.provider === "local" && source.youtubeId
                  ? `<button class="button ghost small-button" type="button" data-action="restore-youtube-source" data-source-id="${escapeHtml(source.id)}">${baseCatalog.sources.find((item) => item.id === source.id)?.provider === "local" ? "Use included audio" : "Use YouTube"}</button>`
                  : `<button class="button ghost small-button" type="button" data-action="delete-user-source" data-source-id="${escapeHtml(source.id)}">Reset</button>` : ""}
              </div>
            </div>`).join("")}
        </div>
        <div class="setting-actions" style="margin-top:15px"><button class="button secondary small-button" type="button" data-action="export-catalog">Export music list</button><button class="button primary small-button" type="button" data-action="go-studio">＋ Add music</button></div>
      </section>
    </div>`;
  refreshStorageEstimate();
}

function updateInstallState() {
  const status = document.getElementById("install-status");
  const button = document.getElementById("install-app-button");
  if (status) status.textContent = appInstalled ? "Installed on this device." : deferredInstallPrompt ? "Ready to install." : "Open Chrome's menu and choose Add to Home screen.";
  if (button) button.disabled = !deferredInstallPrompt;
}

function renderNotFound() {
  dom.view.innerHTML = emptyState({ symbol: "?", title: "Page not found", copy: "That page doesn't exist.", action: "go-home", actionLabel: "Go home" });
}

function renderRoute() {
  if (!catalog) return;
  const route = parseRoute();
  currentRouteKey = route.key;
  viewQueues = new Map();
  updateActiveNavigation(route);
  dom.mainStage.scrollTop = 0;
  switch (route.name) {
    case "home": renderHome(); break;
    case "search": renderSearch(route); break;
    case "songs": renderSongs(); break;
    case "library": renderLibrary(); break;
    case "liked": renderLiked(); break;
    case "history": renderHistory(); break;
    case "source": renderSource(route.segments[1]); break;
    case "playlist": renderPlaylist(route.segments[1]); break;
    case "studio": renderStudio(route); break;
    case "settings": renderSettings(); break;
    default: renderNotFound();
  }
  syncLikeButtons();
  syncActiveTrackRows();
  document.title = `${pageTitle(route)} · Acoustify`;
}

function pageTitle(route) {
  if (route.name === "source") return catalog.sourceById.get(route.segments[1])?.title || "Album";
  if (route.name === "playlist") return state.playlists.find((item) => item.id === route.segments[1])?.name || "Playlist";
  const labels = { home: "Home", search: "Search", songs: "Songs", library: "Library", liked: "Liked Songs", history: "History", studio: "Add Music", settings: "Settings" };
  return labels[route.name] || "Acoustify";
}

function updateActiveNavigation(route = parseRoute()) {
  document.querySelectorAll("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === route.name));
  document.querySelectorAll("[data-playlist-nav]").forEach((link) => link.classList.toggle("active", route.name === "playlist" && link.dataset.playlistNav === route.segments[1]));
}

function recordTrackStart(snapshot) {
  const track = snapshot.track;
  if (!track || !catalog.trackByKey.has(track.key)) return;
  const now = Date.now();
  const first = state.history[0];
  if (first?.trackKey === track.key && now - first.playedAt < 30_000) {
    first.playedAt = now;
    first.position = snapshot.currentTime;
  } else {
    state.history.unshift({ trackKey: track.key, playedAt: now, position: snapshot.currentTime });
    state.history = state.history.slice(0, 500);
    state.playCounts[track.key] = (state.playCounts[track.key] || 0) + 1;
  }
  state.playback = { trackKey: track.key, absolutePosition: snapshot.currentTime, updatedAt: now };
  persistState();
}

function updatePlaybackMemory(snapshot) {
  if (!snapshot.track || !catalog.trackByKey.has(snapshot.track.key)) return;
  const now = Date.now();
  state.playback = { trackKey: snapshot.track.key, absolutePosition: snapshot.currentTime, updatedAt: now };
  const historyEntry = state.history.find((entry) => entry.trackKey === snapshot.track.key);
  if (historyEntry) historyEntry.position = snapshot.currentTime;
  if (now - lastPlaybackPersistAt > 5000) {
    lastPlaybackPersistAt = now;
    persistState();
  }
}

function renderPlayerSnapshot(snapshot = player?.snapshot()) {
  if (!snapshot?.track) {
    renderPersistedPlaybackPreview();
    return;
  }
  const { track, source } = snapshot;
  const art = safeArtwork(track) || safeArtwork(source);
  dom.barArtwork.src = art;
  dom.barArtwork.onerror = () => { dom.barArtwork.src = "./assets/icons/icon-192.png"; };
  dom.barTrackTitle.textContent = track.title;
  dom.barTrackArtist.textContent = `${track.artist} · ${source?.title || track.sourceTitle || "Album"}`;
  dom.panelTrackTitle.textContent = track.title;
  dom.panelArtwork.src = art;
  dom.panelArtwork.onerror = () => { dom.panelArtwork.src = "./assets/icons/icon-512.png"; };
  dom.panelTitle.textContent = track.title;
  dom.panelArtist.textContent = track.artist;
  dom.sourceNote.textContent = source?.provider === "youtube" ? "Playing from YouTube." : "Plays in the background.";
  dom.qualityReadout.innerHTML = `<span class="quality-dot"></span><span>${escapeHtml(snapshot.qualityLabel || "Preparing playback")}</span>`;
  dom.playButton.textContent = snapshot.isPlaying ? "Ⅱ" : "▶";
  dom.playButton.setAttribute("aria-label", snapshot.isPlaying ? "Pause" : "Play");
  dom.elapsedTime.textContent = formatTime(snapshot.elapsed);
  dom.durationTime.textContent = formatTime(snapshot.duration);
  if (!userSeeking) {
    const value = Math.round(clamp(snapshot.progress, 0, 1) * 1000);
    dom.progress.value = String(value);
    setRangeFill(dom.progress, value / 10);
  }
  dom.barLike.classList.toggle("active", state.liked.includes(track.key));
  dom.barLike.textContent = state.liked.includes(track.key) ? "♥" : "♡";
  dom.shuffleButton.classList.toggle("active", snapshot.shuffle);
  dom.repeatButton.classList.toggle("active", snapshot.repeat !== "off");
  dom.repeatButton.textContent = snapshot.repeat === "one" ? "↻¹" : "↻";
  renderQueue(snapshot);
  updateCalibrationClock(snapshot.currentTime);
}

// Runs on every playback tick, so it only touches the time-dependent nodes.
// Track, queue, artwork, and option state re-render through their own events.
function renderPlaybackProgress(snapshot) {
  if (!snapshot?.track) return;
  dom.elapsedTime.textContent = formatTime(snapshot.elapsed);
  dom.durationTime.textContent = formatTime(snapshot.duration);
  if (!userSeeking) {
    const value = Math.round(clamp(snapshot.progress, 0, 1) * 1000);
    dom.progress.value = String(value);
    setRangeFill(dom.progress, value / 10);
  }
  updateCalibrationClock(snapshot.currentTime);
}

function renderPersistedPlaybackPreview() {
  const track = catalog?.trackByKey.get(state.playback.trackKey);
  if (!track) return;
  const source = catalog.sourceById.get(track.sourceId);
  dom.barArtwork.src = safeArtwork(track);
  dom.barTrackTitle.textContent = track.title;
  dom.barTrackArtist.textContent = `${track.artist} · resume available`;
  dom.panelTrackTitle.textContent = track.title;
  dom.panelArtwork.src = safeArtwork(track);
  dom.panelTitle.textContent = track.title;
  dom.panelArtist.textContent = track.artist;
  dom.sourceNote.textContent = `Resume from ${formatTime(Math.max(0, state.playback.absolutePosition - track.start))} in ${source.title}.`;
  dom.qualityReadout.innerHTML = '<span class="quality-dot"></span><span>Ready to resume</span>';
  const elapsed = clamp(state.playback.absolutePosition - track.start, 0, track.end - track.start);
  const duration = track.end - track.start;
  dom.elapsedTime.textContent = formatTime(elapsed);
  dom.durationTime.textContent = formatTime(duration);
  dom.progress.value = String(Math.round((elapsed / duration) * 1000));
  setRangeFill(dom.progress, (elapsed / duration) * 100);
  dom.barLike.classList.toggle("active", state.liked.includes(track.key));
  dom.barLike.textContent = state.liked.includes(track.key) ? "♥" : "♡";
}

function renderQueue(snapshot) {
  const tracks = snapshot.queue.map((key) => catalog.trackByKey.get(key)).filter(Boolean);
  dom.queueCount.textContent = `${tracks.length} song${tracks.length === 1 ? "" : "s"}`;
  if (!tracks.length) {
    dom.queueList.innerHTML = '<div class="muted small" style="padding:12px 5px">Songs will show up here when you start playing.</div>';
    return;
  }
  dom.queueList.innerHTML = tracks.map((track, index) => `
    <div class="queue-item ${track.key === snapshot.track?.key ? "active" : ""}" data-action="play-queue-track" data-track-key="${escapeHtml(track.key)}">
      <span class="queue-index">${track.key === snapshot.track?.key && snapshot.isPlaying ? "♫" : index + 1}</span>
      <span class="queue-copy"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></span>
      <span class="queue-duration">${formatTime(track.end - track.start)}</span>
    </div>`).join("");
}

function syncActiveTrackRows() {
  const currentKey = player?.currentTrack?.key;
  document.querySelectorAll(".track-row[data-track-key]").forEach((row) => {
    const active = row.dataset.trackKey === currentKey;
    row.classList.toggle("active", active);
    const play = row.querySelector(".row-play");
    if (play) play.textContent = active && player.isPlaying ? "Ⅱ" : "▶";
  });
}

function syncLikeButtons() {
  document.querySelectorAll('[data-action="toggle-like"][data-track-key]').forEach((button) => {
    const liked = state.liked.includes(button.dataset.trackKey);
    button.classList.toggle("active", liked);
    button.textContent = liked ? "♥" : "♡";
    button.setAttribute("aria-label", liked ? "Unlike song" : "Like song");
  });
  const key = player?.currentTrack?.key || state.playback.trackKey;
  const liked = key ? state.liked.includes(key) : false;
  dom.barLike.classList.toggle("active", liked);
  dom.barLike.textContent = liked ? "♥" : "♡";
}

async function playTrack(trackKey, queue = null, { resume = false } = {}) {
  const track = catalog.trackByKey.get(trackKey);
  if (!track) return toast("That song isn't in your library anymore.", "error");
  const resumePosition = resume && state.playback.trackKey === trackKey ? state.playback.absolutePosition : null;
  try {
    await player.loadByKey(trackKey, { autoplay: true, queue, resumePosition });
  } catch (error) {
    toast(error.message, "error", 6500);
  }
}

async function playSource(sourceId, { shuffle = false } = {}) {
  const source = catalog.sourceById.get(sourceId);
  if (!source?.tracks.length) return;
  let tracks = [...source.tracks];
  if (shuffle) tracks = shuffleArray(tracks);
  await playTrack(tracks[0].key, tracks.map((track) => track.key));
}

async function playPlaylist(playlistId) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  const keys = playlist?.trackKeys.filter((key) => catalog.trackByKey.has(key)) || [];
  if (!keys.length) return toast("This playlist is empty.");
  await playTrack(keys[0], keys);
}

function shuffleArray(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function toggleLike(trackKey) {
  if (!catalog.trackByKey.has(trackKey)) return;
  if (state.liked.includes(trackKey)) state.liked = state.liked.filter((key) => key !== trackKey);
  else state.liked.unshift(trackKey);
  persistState();
  if (parseRoute().name === "liked") renderRoute();
  else syncLikeButtons();
}

function openPlaylistDialog(trackKey = "") {
  dom.playlistForm.reset();
  dom.playlistForm.elements.trackKey.value = trackKey;
  dom.playlistDialogTitle.textContent = trackKey ? "Create playlist and add song" : "Create playlist";
  dom.playlistDialog.showModal();
  setTimeout(() => dom.playlistForm.elements.name.focus(), 20);
}

function openAddToPlaylistDialog(trackKey) {
  activeAddTrackKey = trackKey;
  if (!state.playlists.length) {
    openPlaylistDialog(trackKey);
    return;
  }
  dom.addDialogList.innerHTML = state.playlists.map((playlist) => `
    <button type="button" data-action="add-track-to-playlist" data-playlist-id="${escapeHtml(playlist.id)}">
      <span class="playlist-placeholder" style="display:grid;place-items:center;width:42px;height:42px;border-radius:5px;background:#173d25;color:#49e683">♫</span>
      <span><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.trackKeys.length} song${playlist.trackKeys.length === 1 ? "" : "s"}</span></span>
      <span>＋</span>
    </button>`).join("");
  dom.addDialog.showModal();
}

function addTrackToPlaylist(playlistId, trackKey) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  const track = catalog.trackByKey.get(trackKey);
  if (!playlist || !track) return;
  if (playlist.trackKeys.includes(trackKey)) {
    toast(`“${track.title}” is already in ${playlist.name}.`);
    return;
  }
  playlist.trackKeys.push(trackKey);
  playlist.updatedAt = Date.now();
  persistState();
  renderPlaylistNav();
  toast(`Added “${track.title}” to ${playlist.name}.`, "success");
}

function removeTrackFromPlaylist(playlistId, trackKey) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  if (!playlist) return;
  playlist.trackKeys = playlist.trackKeys.filter((key) => key !== trackKey);
  playlist.updatedAt = Date.now();
  persistState();
  renderRoute();
}

function confirmAction(title, message, onAccept) {
  pendingConfirm = onAccept;
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmDialog.showModal();
}

function toast(message, type = "info", duration = 3600) {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.innerHTML = `<span>${type === "error" ? "!" : type === "success" ? "✓" : "◇"}</span><p>${escapeHtml(message)}</p>`;
  dom.toastRegion.append(item);
  setTimeout(() => item.remove(), duration);
}

function updateProviderFields() {
  const form = document.getElementById("studio-form");
  if (!form) return;
  const provider = form.elements.provider.value;
  document.querySelectorAll(".youtube-field").forEach((element) => { element.hidden = provider !== "youtube"; });
  document.querySelectorAll(".local-field").forEach((element) => { element.hidden = provider !== "local"; });
}

function previewStudioChapters(showErrors = true) {
  const form = document.getElementById("studio-form");
  const preview = document.getElementById("chapter-preview");
  if (!form || !preview) return null;
  try {
    const durationText = form.elements.duration.value;
    const parts = durationText.trim().split(":").map(Number);
    const duration = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : Number(durationText);
    const tracks = parseChapterLines(form.elements.chapters.value, duration);
    preview.innerHTML = tracks.map((track, index) => `
      <div class="preview-track"><span>${index + 1}</span><strong>${escapeHtml(track.title)}</strong><time>${formatTime(track.start, track.start >= 3600)}–${formatTime(track.end, track.end >= 3600)}</time></div>`).join("");
    return tracks;
  } catch (error) {
    preview.innerHTML = `<div class="error-view"><strong>Preview unavailable</strong><p class="small">${escapeHtml(error.message)}</p></div>`;
    if (showErrors) toast(error.message, "error");
    return null;
  }
}

function syncCalibrationToChapters() {
  const inputs = [...document.querySelectorAll(".calibration-start")];
  const chapterInput = document.getElementById("chapter-input");
  if (!inputs.length || !chapterInput) return;
  chapterInput.value = inputs.map((input) => `${input.value.trim()} ${input.dataset.trackTitle}`).join("\n");
  previewStudioChapters(false);
}

function updateCalibrationClock(seconds) {
  const clock = document.getElementById("calibration-clock");
  if (clock) clock.textContent = formatPreciseTime(seconds || 0);
}

async function playCalibrationSource(sourceId) {
  const source = catalog.sourceById.get(sourceId);
  if (!source) return;
  const calibrationTrack = {
    id: "calibration-stream",
    key: `${source.id}::__calibration-stream`,
    sourceId: source.id,
    title: `${source.title} — full recording`,
    artist: source.artist,
    sourceTitle: source.title,
    artwork: source.artwork,
    start: 0,
    end: source.duration,
    provider: source.provider
  };
  try {
    await player.load(calibrationTrack, source, { autoplay: true, queue: [], preciseStart: true });
    setPanelOpen(true);
    toast("Full recording is playing. Tap ● when each song starts.", "success");
  } catch (error) {
    toast(error.message, "error", 6500);
  }
}

async function handleLocalFile(file) {
  if (!file) return;
  pendingLocalFile = file;
  const label = document.getElementById("local-file-label");
  const form = document.getElementById("studio-form");
  if (label) label.innerHTML = `<strong>${escapeHtml(file.name)}</strong><br>${formatBytes(file.size)} · ${escapeHtml(file.type || "audio file")}`;
  try {
    const duration = await readAudioDuration(file);
    if (form && Number.isFinite(duration)) form.elements.duration.value = formatPreciseTime(duration);
    if (form && !form.elements.title.value.trim()) form.elements.title.value = file.name.replace(/\.[^.]+$/, "");
    previewStudioChapters(false);
  } catch (error) {
    toast(`Couldn't read the length of that file: ${error.message}`, "error");
  }
}

function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      Number.isFinite(duration) ? resolve(duration) : reject(new Error("Unknown duration"));
    };
    audio.onerror = () => { cleanup(); reject(new Error("The browser could not decode this format.")); };
    audio.src = url;
  });
}

function sourceForExtractedFile(filename, requestedSourceId = "") {
  const fileYouTubeId = parseExtractedYouTubeId(filename);
  const requestedSource = requestedSourceId ? catalog.sourceById.get(requestedSourceId) : null;
  if (requestedSourceId && !requestedSource) throw new Error("That source is no longer in the catalog.");
  if (requestedSource && !requestedSource.youtubeId) throw new Error("That source has no YouTube ID for audio matching.");
  if (requestedSource && fileYouTubeId && requestedSource.youtubeId !== fileYouTubeId) {
    throw new Error(`This file belongs to a different YouTube video (${fileYouTubeId}).`);
  }
  if (requestedSource) return requestedSource;
  if (!fileYouTubeId) throw new Error("The filename must end with a YouTube ID in brackets, such as [Y25LDO6OLzQ].m4a.");

  const matches = catalog.sources.filter((source) => source.youtubeId === fileYouTubeId);
  if (!matches.length) throw new Error(`No catalog source matches YouTube ID ${fileYouTubeId}.`);
  if (matches.length > 1) throw new Error("More than one source uses this YouTube ID. Import from the source page instead.");
  return matches[0];
}

function activePlaybackForSource(sourceId) {
  if (player?.currentTrack?.sourceId !== sourceId) return null;
  return {
    key: player.currentTrack.key,
    position: player.currentTime,
    playing: player.isPlaying,
    queue: [...player.queue]
  };
}

async function reloadActiveSource(playback) {
  if (!playback || !catalog.trackByKey.has(playback.key)) return;
  const queue = playback.queue.filter((key) => catalog.trackByKey.has(key));
  await player.loadByKey(playback.key, {
    autoplay: playback.playing,
    resumePosition: playback.position,
    queue
  });
}

async function handleExtractedAudioFile(file, requestedSourceId = "", { quiet = false } = {}) {
  if (!file) return;
  const source = sourceForExtractedFile(file.name, requestedSourceId);
  const duration = await readAudioDuration(file);
  const assetId = `audio-${crypto.randomUUID()}`;
  const override = sourceWithLocalAudio(source, {
    assetId,
    name: file.name,
    type: file.type,
    size: file.size,
    duration,
    lastModified: file.lastModified
  });
  validateCatalog({ version: 1, sources: [override] });

  const previousSources = deepClone(state.userSources);
  const previousOverride = state.userSources.find((item) => item.id === source.id);
  if (previousOverride?.provider !== "local") override.restorePackagedSource = !previousOverride;
  const activePlayback = activePlaybackForSource(source.id);
  await putAudioAsset({
    id: assetId,
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified
  });

  try {
    const existingIndex = state.userSources.findIndex((item) => item.id === override.id);
    if (existingIndex >= 0) state.userSources[existingIndex] = override;
    else state.userSources.push(override);
    await setValue(STATE_KEY, state);
    rebuildCatalog();
  } catch (error) {
    state.userSources = previousSources;
    rebuildCatalog();
    await deleteAudioAsset(assetId).catch(() => {});
    throw error;
  }

  let reloadFailed = false;
  try {
    await reloadActiveSource(activePlayback);
  } catch (error) {
    reloadFailed = true;
    console.debug("The active source could not be reloaded after importing audio.", error);
  }
  if (previousOverride?.provider === "local" && previousOverride.assetId && previousOverride.assetId !== assetId) {
    await deleteAudioAsset(previousOverride.assetId).catch(() => {});
  }
  requestPersistentStorage().catch(() => false);
  refreshStorageEstimate();
  if (!quiet) {
    toast(reloadFailed ? `${override.title} now uses your audio. Tap Play to reload it.` : `${override.title} now uses your audio.`, "success", 5200);
    navigate(`source/${encodeURIComponent(override.id)}`);
  }
  return { override, reloadFailed };
}

async function restoreYouTubeSource(sourceId) {
  const source = catalog.sourceById.get(sourceId);
  const userSource = state.userSources.find((item) => item.id === sourceId);
  if (!source?.youtubeId || userSource?.provider !== "local") return;
  const previousSources = deepClone(state.userSources);
  const activePlayback = activePlaybackForSource(sourceId);
  const packagedSource = baseCatalog.sources.find((item) => item.id === sourceId);

  if (userSource.restorePackagedSource && sourceIsPackaged(sourceId)) {
    state.userSources = state.userSources.filter((item) => item.id !== sourceId);
  } else if (packagedSource?.provider === "local" && packagedSource.audioUrl) {
    const restored = deepClone(userSource);
    restored.provider = "local";
    restored.audioUrl = packagedSource.audioUrl;
    delete restored.assetId;
    delete restored.assetMeta;
    delete restored.localPlaybackFor;
    delete restored.youtubeFallback;
    delete restored.restorePackagedSource;
    validateCatalog({ version: 1, sources: [restored] });
    state.userSources[state.userSources.findIndex((item) => item.id === sourceId)] = restored;
  } else {
    const restored = deepClone(userSource.youtubeFallback || userSource);
    restored.provider = "youtube";
    delete restored.assetId;
    delete restored.assetMeta;
    delete restored.localPlaybackFor;
    delete restored.youtubeFallback;
    delete restored.restorePackagedSource;
    validateCatalog({ version: 1, sources: [restored] });
    state.userSources[state.userSources.findIndex((item) => item.id === sourceId)] = restored;
  }

  try {
    await setValue(STATE_KEY, state);
    rebuildCatalog();
  } catch (error) {
    state.userSources = previousSources;
    rebuildCatalog();
    throw error;
  }
  try {
    await reloadActiveSource(activePlayback);
  } catch (error) {
    console.debug("The active source could not be reloaded after restoring its packaged playback source.", error);
  }
  if (userSource.assetId) await deleteAudioAsset(userSource.assetId).catch(() => {});
  refreshStorageEstimate();
  const restoredSource = catalog.sourceById.get(sourceId);
  toast(`${source.title} now uses ${providerLabel(restoredSource).toLowerCase()}.`, "success");
  navigate(`source/${encodeURIComponent(sourceId)}`);
}

async function saveStudioForm(form) {
  const data = new FormData(form);
  const provider = data.get("provider");
  const existingSourceId = String(data.get("id") || "");
  const previousSource = existingSourceId ? catalog.sourceById.get(existingSourceId) : null;
  let assetId = String(data.get("assetId") || "");
  let assetMeta = assetId ? {
    name: String(data.get("assetName") || ""),
    type: String(data.get("assetType") || ""),
    size: Number(data.get("assetSize") || 0)
  } : undefined;

  if (provider === "local" && pendingLocalFile) {
    assetId = assetId || `audio-${crypto.randomUUID()}`;
    assetMeta = { name: pendingLocalFile.name, type: pendingLocalFile.type, size: pendingLocalFile.size };
  }

  const source = sourceFromStudioForm({
    id: existingSourceId || undefined,
    title: String(data.get("title") || ""),
    artist: String(data.get("artist") || ""),
    provider,
    youtubeInput: String(data.get("youtubeInput") || ""),
    duration: String(data.get("duration") || ""),
    artwork: String(data.get("artwork") || ""),
    description: String(data.get("description") || ""),
    tags: String(data.get("tags") || ""),
    chapters: String(data.get("chapters") || ""),
    assetId,
    assetMeta,
    audioUrl: String(data.get("audioUrl") || "")
  });
  if (provider === "local" && previousSource?.youtubeId) {
    source.youtubeId = previousSource.youtubeId;
    source.localPlaybackFor = previousSource.localPlaybackFor || previousSource.youtubeId;
    if (!pendingLocalFile && previousSource.assetMeta) source.assetMeta = deepClone(previousSource.assetMeta);
    const packagedSource = baseCatalog.sources.find((item) => item.id === source.id);
    if (packagedSource?.provider === "local") {
      delete source.youtubeFallback;
      source.restorePackagedSource = true;
    } else {
      source.youtubeFallback = deepClone(source);
      source.youtubeFallback.provider = "youtube";
      delete source.youtubeFallback.assetId;
      delete source.youtubeFallback.assetMeta;
      delete source.youtubeFallback.audioUrl;
      delete source.youtubeFallback.localPlaybackFor;
      delete source.youtubeFallback.youtubeFallback;
      delete source.youtubeFallback.restorePackagedSource;
      source.restorePackagedSource = false;
    }
  }
  const year = Number(data.get("year"));
  if (Number.isFinite(year) && year > 0) source.year = year;
  validateCatalog({ version: 1, sources: [source] });

  // Only persist a potentially large Blob after every metadata/timing check has
  // passed, preventing failed forms from leaving orphaned audio in IndexedDB.
  if (provider === "local" && pendingLocalFile) {
    await putAudioAsset({
      id: assetId,
      file: pendingLocalFile,
      name: pendingLocalFile.name,
      type: pendingLocalFile.type,
      size: pendingLocalFile.size,
      lastModified: pendingLocalFile.lastModified
    });
  }

  if (previousSource?.provider === "local" && previousSource.assetId && previousSource.assetId !== source.assetId) {
    await deleteAudioAsset(previousSource.assetId).catch(() => {});
  }

  const existingIndex = state.userSources.findIndex((item) => item.id === source.id);
  if (existingIndex >= 0) state.userSources[existingIndex] = source;
  else state.userSources.push(source);
  await setValue(STATE_KEY, state);
  rebuildCatalog();
  pendingLocalFile = null;
  toast(`${source.title} saved.`, "success");
  navigate(`source/${encodeURIComponent(source.id)}`);
}

async function refreshStorageEstimate() {
  const description = document.getElementById("storage-description");
  const fill = document.getElementById("storage-meter-fill");
  const used = document.getElementById("storage-used");
  const quota = document.getElementById("storage-quota");
  if (!description || !fill || !used || !quota) return;
  try {
    const estimate = await storageEstimate();
    if (!estimate) throw new Error("Storage estimates are not supported in this browser.");
    const usage = estimate.usage || 0;
    const available = estimate.quota || 0;
    const percentage = available ? (usage / available) * 100 : 0;
    fill.style.width = `${clamp(percentage, 0, 100)}%`;
    used.textContent = `${formatBytes(usage)} used`;
    quota.textContent = `${formatBytes(available)} available quota`;
    description.textContent = "Includes Acoustify data and any audio files you've imported.";
  } catch (error) {
    description.textContent = error.message;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}

function setRangeFill(input, percent) {
  input.style.setProperty("--fill", `${clamp(Number(percent), 0, 100)}%`);
}

function setPanelOpen(open) {
  const compact = matchMedia("(max-width: 1120px)").matches;
  if (compact) {
    dom.shell.classList.toggle("player-panel-open", Boolean(open));
    dom.shell.classList.remove("panel-collapsed");
  } else {
    dom.shell.classList.remove("player-panel-open");
    dom.shell.classList.toggle("panel-collapsed", !open);
  }
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  dom.networkPill.classList.toggle("offline", !online);
  dom.networkPill.querySelector("span:last-child").textContent = online ? "Online" : "Offline shell";
}

function wirePlayerEvents() {
  player.addEventListener("trackchange", (event) => {
    recordTrackStart(event.detail);
    renderPlayerSnapshot(event.detail);
    syncActiveTrackRows();
  });
  player.addEventListener("statechange", (event) => {
    renderPlayerSnapshot(event.detail);
    syncActiveTrackRows();
  });
  player.addEventListener("progress", (event) => {
    updatePlaybackMemory(event.detail);
    renderPlaybackProgress(event.detail);
  });
  player.addEventListener("qualitychange", (event) => renderPlayerSnapshot(event.detail));
  player.addEventListener("queuechange", (event) => renderQueue(event.detail));
  player.addEventListener("optionschange", (event) => {
    state.settings.repeat = event.detail.repeat;
    state.settings.shuffle = event.detail.shuffle;
    state.settings.autoplay = event.detail.autoplay;
    state.settings.segmentLeadIn = event.detail.segmentLeadIn;
    state.settings.keepScreenAwake = event.detail.keepScreenAwake;
    persistState();
    renderPlayerSnapshot(event.detail);
  });
  player.addEventListener("volumechange", (event) => {
    state.settings.volume = event.detail.volume;
    persistState();
  });
  player.addEventListener("segmentended", (event) => updatePlaybackMemory(event.detail));
  player.addEventListener("adbreak", (event) => {
    dom.adBanner.hidden = !event.detail.active;
  });
  player.addEventListener("error", (event) => toast(event.detail.error?.message || "Playback failed.", "error", 6500));
}

async function handleAction(action, element, event) {
  const trackKey = element.dataset.trackKey;
  const sourceId = element.dataset.sourceId;
  const playlistId = element.dataset.playlistId;
  switch (action) {
    case "history-back": history.back(); break;
    case "history-forward": history.forward(); break;
    case "open-settings": navigate("settings"); break;
    case "go-home": navigate("home"); break;
    case "go-library": navigate("library"); break;
    case "go-studio": navigate("studio"); break;
    case "studio-reset": navigate("studio"); break;
    case "open-source": navigate(`source/${encodeURIComponent(sourceId)}`); break;
    case "open-current-source": {
      const key = player?.currentTrack?.key || state.playback.trackKey;
      const track = catalog.trackByKey.get(key);
      if (track) navigate(`source/${encodeURIComponent(track.sourceId)}`);
      break;
    }
    case "open-playlist": navigate(`playlist/${encodeURIComponent(playlistId)}`); break;
    case "open-player": setPanelOpen(true); break;
    case "close-player": setPanelOpen(false); break;
    case "play-track": {
      const queue = resolveQueue(element.dataset.queueId, catalog.trackByKey.get(trackKey));
      if (player?.currentTrack?.key === trackKey) await player.toggle();
      else await playTrack(trackKey, queue);
      break;
    }
    case "play-queue-track": await playTrack(trackKey, player.queue); break;
    case "play-source": await playSource(sourceId); break;
    case "shuffle-source": await playSource(sourceId, { shuffle: true }); break;
    case "play-playlist": await playPlaylist(playlistId); break;
    case "play-liked": {
      const keys = state.liked.filter((key) => catalog.trackByKey.has(key));
      if (keys.length) await playTrack(keys[0], keys);
      break;
    }
    case "resume-last": {
      if (state.playback.trackKey) await playTrack(state.playback.trackKey, null, { resume: true });
      break;
    }
    case "toggle-play": {
      if (player.currentTrack) await player.toggle();
      else if (state.playback.trackKey) await playTrack(state.playback.trackKey, null, { resume: true });
      else if (catalog.tracks[0]) await playTrack(catalog.tracks[0].key, catalog.sourceById.get(catalog.tracks[0].sourceId).tracks.map((track) => track.key));
      break;
    }
    case "previous": await player.previous(); break;
    case "next": await player.next(); break;
    case "show-video-for-ad": setPanelOpen(true); break;
    case "video-fullscreen": {
      if (!(await player.enterVideoFullscreen())) toast("Play something from YouTube first.", "info");
      break;
    }
    case "play-songs": {
      const tracks = allSongTracks();
      if (tracks.length) await playTrack(tracks[0].key, tracks.map((track) => track.key));
      break;
    }
    case "shuffle-songs": {
      const tracks = shuffleArray(allSongTracks());
      if (tracks.length) await playTrack(tracks[0].key, tracks.map((track) => track.key));
      break;
    }
    case "seek-back": if (player.currentTrack) await player.seekAbsolute(player.currentTime - 10); break;
    case "seek-forward": if (player.currentTrack) await player.seekAbsolute(player.currentTime + 10); break;
    case "jump-to-time": {
      if (!player.currentTrack) break;
      const snapshot = player.snapshot();
      const input = window.prompt(`Jump to a time in “${snapshot.track.title}” (0:00 – ${formatTime(snapshot.duration)})`, formatTime(snapshot.elapsed));
      if (input === null || !input.trim()) break;
      await player.seekRelative(parsePreciseTime(input));
      break;
    }
    case "toggle-shuffle": player.setShuffle(!player.shuffle); break;
    case "cycle-repeat": player.cycleRepeat(); break;
    case "install-app": {
      if (!deferredInstallPrompt) {
        toast("Use Chrome's menu and choose Add to Home screen.", "info");
        break;
      }
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") toast("Acoustify is being added to your phone.", "success");
      updateInstallState();
      break;
    }
    case "toggle-like": toggleLike(trackKey); break;
    case "like-current": {
      const key = player.currentTrack?.key || state.playback.trackKey;
      if (key) toggleLike(key);
      break;
    }
    case "new-playlist": openPlaylistDialog(); break;
    case "add-to-playlist": openAddToPlaylistDialog(trackKey); break;
    case "new-playlist-for-track": dom.addDialog.close(); openPlaylistDialog(activeAddTrackKey); break;
    case "add-track-to-playlist": {
      addTrackToPlaylist(playlistId, activeAddTrackKey);
      dom.addDialog.close();
      break;
    }
    case "remove-from-playlist": removeTrackFromPlaylist(playlistId, trackKey); break;
    case "delete-playlist": {
      const playlist = state.playlists.find((item) => item.id === playlistId);
      if (!playlist) break;
      confirmAction("Delete playlist?", `“${playlist.name}” will be deleted. The songs will stay in your library.`, () => {
        state.playlists = state.playlists.filter((item) => item.id !== playlistId);
        persistState();
        renderPlaylistNav();
        navigate("library");
      });
      break;
    }
    case "close-playlist-dialog": dom.playlistDialog.close(); break;
    case "close-add-dialog": dom.addDialog.close(); break;
    case "confirm-cancel": pendingConfirm = null; dom.confirmDialog.close(); break;
    case "confirm-accept": {
      const callback = pendingConfirm;
      pendingConfirm = null;
      dom.confirmDialog.close();
      await callback?.();
      break;
    }
    case "clear-history": confirmAction("Clear history?", "Your liked songs, playlists, and albums will stay.", () => {
      state.history = [];
      persistState();
      renderRoute();
    }); break;
    case "edit-source": navigate(`studio?source=${encodeURIComponent(sourceId)}`); break;
    case "attach-extracted-audio":
      pendingExtractedSourceId = sourceId || "";
      dom.extractedAudioImport.value = "";
      dom.extractedAudioImport.click();
      break;
    case "restore-youtube-source": {
      const source = catalog.sourceById.get(sourceId);
      if (!source) break;
      const restoresIncludedAudio = baseCatalog.sources.find((item) => item.id === sourceId)?.provider === "local";
      confirmAction(restoresIncludedAudio ? "Use included audio?" : "Use YouTube?", `Your imported audio for “${source.title}” will be removed. The song times will stay the same.`, () => restoreYouTubeSource(sourceId));
      break;
    }
    case "delete-user-source": {
      const source = catalog.sourceById.get(sourceId);
      confirmAction(sourceIsPackaged(sourceId) ? "Reset changes?" : "Remove this album?", sourceIsPackaged(sourceId)
        ? `“${source?.title || sourceId}” will go back to the included version.`
        : `“${source?.title || sourceId}” will be removed from Acoustify.`, async () => {
          const userSource = state.userSources.find((item) => item.id === sourceId);
          if (userSource?.provider === "local" && userSource.assetId) await deleteAudioAsset(userSource.assetId).catch(() => {});
          state.userSources = state.userSources.filter((item) => item.id !== sourceId);
          rebuildCatalog();
          persistState();
          renderRoute();
        });
      break;
    }
    case "preview-chapters": previewStudioChapters(true); break;
    case "play-calibration-source": await playCalibrationSource(sourceId); break;
    case "clear-search": {
      const input = document.getElementById("search-input");
      if (input) { input.value = ""; input.focus(); renderSearchResults(""); }
      break;
    }
    case "search-tag": {
      const input = document.getElementById("search-input");
      if (input) { input.value = element.dataset.tag || ""; input.focus(); renderSearchResults(input.value); }
      break;
    }
    case "export-memory": {
      downloadJson(`acoustify-memory-${new Date().toISOString().slice(0,10)}.json`, {
        app: "Acoustify",
        formatVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        note: "Local audio file Blobs are not included.",
        state
      });
      toast("Backup downloaded.", "success");
      break;
    }
    case "import-memory": dom.memoryImport.click(); break;
    case "export-catalog": {
      downloadJson(`acoustify-custom-catalog-${new Date().toISOString().slice(0,10)}.json`, { version: 1, sources: state.userSources });
      toast("Music list downloaded.", "success");
      break;
    }
    case "request-persistent": {
      const granted = await requestPersistentStorage();
      toast(granted ? "Your browser will keep Acoustify's data on this device." : "Your browser could not promise to keep the data. Download a backup to be safe.", granted ? "success" : "info");
      break;
    }
    case "clear-local-audio": confirmAction("Clear imported audio?", "Your imported files will be deleted. Add them again if you want to play them later.", async () => {
      await clearAudioAssets();
      toast("Imported audio cleared.", "success");
      refreshStorageEstimate();
    }); break;
    case "reset-memory": confirmAction("Reset Acoustify?", "This clears your likes, history, playlists, settings, changes, and imported audio.", async () => {
      await player.pause().catch(() => {});
      await clearAudioAssets();
      state = deepClone(DEFAULT_STATE);
      await setValue(STATE_KEY, state);
      location.hash = "#/home";
      location.reload();
    }); break;
    default:
      if (element.dataset.calAction) handleCalibrationAction(element.dataset.calAction, element);
  }
  event?.stopPropagation();
}

function sourceIsPackaged(sourceId) {
  return baseCatalog.sources.some((source) => source.id === sourceId);
}

function handleCalibrationAction(action, button) {
  const row = button.closest(".calibration-row");
  const input = row?.querySelector(".calibration-start");
  if (!input) return;
  const current = parsePreciseTime(input.value);
  if (action === "capture") input.value = formatPreciseTime(player?.currentTime || 0);
  if (action === "minus") input.value = formatPreciseTime(Math.max(0, current - 0.5));
  if (action === "plus") input.value = formatPreciseTime(current + 0.5);
  syncCalibrationToChapters();
}

function parsePreciseTime(value) {
  const parts = String(value).trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return Math.max(0, parts[0] || 0);
}

function wireDomEvents() {
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  window.addEventListener("pagehide", () => persistPlaybackImmediately());
  window.addEventListener("pageshow", () => player?.syncPlaybackState());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistPlaybackImmediately();
    else player?.syncPlaybackState();
  });
  window.addEventListener("resize", debounce(() => {
    if (matchMedia("(max-width: 1120px)").matches) {
      dom.shell.classList.remove("panel-collapsed");
    } else {
      dom.shell.classList.remove("player-panel-open");
      setPanelOpen(state.settings.playerPanelOpen);
    }
  }, 100));

  document.addEventListener("click", async (event) => {
    const actionElement = event.target.closest("[data-action], [data-cal-action]");
    if (!actionElement) return;
    event.preventDefault();
    try {
      await handleAction(actionElement.dataset.action || "", actionElement, event);
    } catch (error) {
      console.error(error);
      toast(error.message || "Something went wrong.", "error", 6500);
    }
  });

  document.addEventListener("keydown", async (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const card = target.closest?.(".card[data-action], .quick-item[data-action]");
    if (card && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      await handleAction(card.dataset.action, card, event);
      return;
    }
    if (!typing && event.code === "Space") {
      event.preventDefault();
      await handleAction("toggle-play", document.body, event);
      return;
    }
    if (!typing && event.key === "/") {
      event.preventDefault();
      navigate("search");
    }
    if (!typing && player?.currentTrack && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const step = event.shiftKey ? 30 : 5;
      await player.seekAbsolute(player.currentTime + (event.key === "ArrowRight" ? step : -step));
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "search-input") renderSearchResults(target.value);
    if (target.id === "volume-control") {
      const value = Number(target.value) / 100;
      player.setVolume(value);
      setRangeFill(target, Number(target.value));
    }
    if (target.id === "progress-control") {
      userSeeking = true;
      const snapshot = player.snapshot();
      const fraction = Number(target.value) / 1000;
      dom.elapsedTime.textContent = formatTime(snapshot.duration * fraction);
      setRangeFill(target, fraction * 100);
    }
    if (target.classList.contains("calibration-start")) syncCalibrationToChapters();
    if (target.id === "chapter-input" || target.name === "duration") previewStudioChapters(false);
  });

  document.addEventListener("change", async (event) => {
    const target = event.target;
    if (target.matches('input[name="provider"]')) updateProviderFields();
    if (target.id === "local-file-input") await handleLocalFile(target.files?.[0]);
    if (target.id === "progress-control") {
      const fraction = Number(target.value) / 1000;
      userSeeking = false;
      if (player.currentTrack) await player.seekRelative(player.snapshot().duration * fraction);
    }
    if (target.id === "setting-autoplay") {
      state.settings.autoplay = target.checked;
      player.setAutoplay(target.checked);
      persistState();
    }
    if (target.id === "setting-panel") {
      state.settings.playerPanelOpen = target.checked;
      persistState();
      if (!matchMedia("(max-width: 1120px)").matches) setPanelOpen(target.checked);
    }
    if (target.id === "setting-keep-awake") {
      state.settings.keepScreenAwake = target.checked;
      player.setKeepScreenAwake(target.checked);
      persistState();
    }
    if (target.id === "setting-lead-in") {
      const parsedLeadIn = Number(target.value);
      state.settings.segmentLeadIn = Number.isFinite(parsedLeadIn) ? clamp(parsedLeadIn, 0, 5) : DEFAULT_STATE.settings.segmentLeadIn;
      target.value = String(state.settings.segmentLeadIn);
      player.setSegmentLeadIn(state.settings.segmentLeadIn);
      persistState();
    }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id === "playlist-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const playlist = {
        id: crypto.randomUUID(),
        name: String(data.get("name") || "").trim(),
        description: String(data.get("description") || "").trim(),
        trackKeys: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (!playlist.name) return;
      const trackKey = String(data.get("trackKey") || "");
      if (trackKey && catalog.trackByKey.has(trackKey)) playlist.trackKeys.push(trackKey);
      state.playlists.push(playlist);
      persistState();
      renderPlaylistNav();
      dom.playlistDialog.close();
      toast(`${playlist.name} created.`, "success");
      if (!trackKey) navigate(`playlist/${encodeURIComponent(playlist.id)}`);
    }
    if (event.target.id === "studio-form") {
      event.preventDefault();
      try {
        await saveStudioForm(event.target);
      } catch (error) {
        toast(error.message, "error", 6500);
      }
    }
  });

  dom.memoryImport.addEventListener("change", async () => {
    const file = dom.memoryImport.files?.[0];
    dom.memoryImport.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = parsed.state || parsed;
      const normalized = normalizeState(imported);
      if (!Array.isArray(normalized.userSources)) throw new Error("That does not look like an Acoustify backup.");
      for (const source of normalized.userSources) validateCatalog({ version: 1, sources: [source] });
      state = normalized;
      await setValue(STATE_KEY, state);
      rebuildCatalog();
      player.configure(state.settings);
      renderRoute();
      renderPersistedPlaybackPreview();
      toast("Backup restored. You may need to import your audio files again.", "success", 6000);
    } catch (error) {
      toast(`Import failed: ${error.message}`, "error", 6500);
    }
  });

  dom.extractedAudioImport.addEventListener("change", async () => {
    const files = [...(dom.extractedAudioImport.files || [])];
    const requestedSourceId = pendingExtractedSourceId;
    dom.extractedAudioImport.value = "";
    pendingExtractedSourceId = "";
    if (!files.length) return;

    if (files.length === 1) {
      try {
        await handleExtractedAudioFile(files[0], requestedSourceId);
      } catch (error) {
        console.error(error);
        toast(`Couldn't import that audio: ${error.message}`, "error", 7000);
      }
      return;
    }

    const imported = [];
    const failures = [];
    toast(`Importing ${files.length} audio files...`, "info", 8000);
    for (const file of files) {
      try {
        const result = await handleExtractedAudioFile(file, "", { quiet: true });
        imported.push(result.override);
      } catch (error) {
        console.error(error);
        failures.push({ file: file.name, error });
      }
    }
    navigate("settings");
    if (imported.length) {
      toast(`${imported.length} album${imported.length === 1 ? "" : "s"} now use your audio.`, "success", 6000);
    }
    if (failures.length) {
      toast(`${failures.length} file${failures.length === 1 ? "" : "s"} could not be imported. ${failures[0].file}: ${failures[0].error.message}`, "error", 9000);
    }
  });
}

async function persistPlaybackImmediately() {
  if (!player?.currentTrack) return;
  updatePlaybackMemory(player.snapshot());
  try {
    await setValue(STATE_KEY, state);
  } catch (error) {
    console.debug("Playback position could not be saved during page suspension.", error);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    registration.update().catch(() => {});
  } catch (error) {
    console.debug("Service worker registration skipped.", error);
  }
}

async function init() {
  dom.view.innerHTML = '<div class="loading-view"><div><div class="loading-disc"></div><p>Loading your music…</p></div></div>';
  try {
    [baseCatalog, state] = await Promise.all([
      loadBaseCatalog(),
      getValue(STATE_KEY, deepClone(DEFAULT_STATE)).then(normalizeState)
    ]);
    rebuildCatalog();
    player = new PlaybackController({
      resolveTrack: (key) => catalog.trackByKey.get(key),
      resolveSource: (id) => catalog.sourceById.get(id),
      getAudioAsset
    });
    player.configure(state.settings);
    dom.volume.value = String(Math.round(state.settings.volume * 100));
    setRangeFill(dom.volume, state.settings.volume * 100);
    setRangeFill(dom.progress, 0);
    wirePlayerEvents();
    wireDomEvents();
    updateNetworkStatus();
    setPanelOpen(!matchMedia("(max-width: 1120px)").matches && state.settings.playerPanelOpen);
    if (!location.hash) history.replaceState(null, "", "#/home");
    renderRoute();
    renderPersistedPlaybackPreview();
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    dom.view.innerHTML = `<div class="error-view"><p class="eyebrow">Something went wrong</p><h1>Couldn't open Acoustify</h1><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" onclick="location.reload()">Try again</button></div>`;
  }
}

init();
