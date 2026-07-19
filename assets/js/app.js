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
  relativeDate,
  safeArtwork,
  slugify
} from "./utils.js";

const STATE_KEY = "app-state-v2";
const APP_VERSION = 2;
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
    segmentLeadIn: 1.5
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
  memoryImport: document.getElementById("memory-import")
};

let state = deepClone(DEFAULT_STATE);
let baseCatalog = null;
let catalog = null;
let player = null;
let viewQueues = new Map();
let pendingLocalFile = null;
let pendingConfirm = null;
let activeAddTrackKey = null;
let userSeeking = false;
let lastPlaybackPersistAt = 0;
let currentRouteKey = "";

const persistState = debounce(async () => {
  try {
    await setValue(STATE_KEY, state);
  } catch (error) {
    toast(`Could not save local memory: ${error.message}`, "error");
  }
}, 180);

function normalizeState(input) {
  const candidate = input && typeof input === "object" ? input : {};
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
      ...(candidate.settings || {})
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
  return source.provider === "local" ? "Local master" : "YouTube source";
}

function timingLabel(source) {
  if (source.timingStatus === "calibration-required") return "Needs calibration";
  if (source.timingStatus === "album-derived") return "Mapped chapters";
  if (source.timingStatus === "user-calibrated") return "Calibrated";
  return "Track mapped";
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
        <span class="badge ${source.provider === "local" ? "local" : ""}">${source.provider === "local" ? "Original file" : "Video source"}</span>
        ${warning ? '<span class="badge warning">Draft cuts</span>' : ""}
      </div>
      <div class="card-art">
        <img ${artworkAttrs(source)} alt="${escapeHtml(source.title)} artwork" loading="lazy">
        <button class="card-play" type="button" data-action="play-source" data-source-id="${escapeHtml(source.id)}" aria-label="Play ${escapeHtml(source.title)}">▶</button>
      </div>
      <h3>${escapeHtml(source.title)}</h3>
      <p>${escapeHtml(source.artist)} · ${source.tracks.length} separated track${source.tracks.length === 1 ? "" : "s"}</p>
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
      <p>${playlist.trackKeys.length} track${playlist.trackKeys.length === 1 ? "" : "s"}${playlist.description ? ` · ${escapeHtml(playlist.description)}` : ""}</p>
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
  emptyTitle = "No tracks here yet",
  emptyCopy = "Add a source or save tracks to this collection."
} = {}) {
  if (!tracks.length) return emptyState({ title: emptyTitle, copy: emptyCopy, action: "go-studio", actionLabel: "Open Catalog Studio" });
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
        <thead><tr><th>#</th><th>Title</th>${showSource ? '<th class="source-col">Source</th>' : ""}<th class="duration-col">Time</th><th class="action-col"></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderPlaylistNav() {
  if (!state.playlists.length) {
    dom.playlistNav.innerHTML = '<div class="empty-nav">Create a playlist to group favorite cuts.</div>';
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
        <p class="eyebrow">Your rare-recording library</p>
        <h1>Long sessions, finally split into songs.</h1>
        <p>Acoustify remembers where you stopped, what you liked, and how every long-form source is divided—entirely in this browser.</p>
        <div class="hero-actions">
          ${resumeTrack ? `<button class="button primary" type="button" data-action="resume-last">▶ Resume ${escapeHtml(resumeTrack.title)}</button>` : `<button class="button primary" type="button" data-action="play-source" data-source-id="${escapeHtml(sources[0]?.id || "")}">▶ Start listening</button>`}
          <button class="button secondary" type="button" data-action="go-studio">＋ Add a source</button>
        </div>
        <div class="stat-strip">
          <div class="stat-card"><strong>${sources.length}</strong><span>source albums</span></div>
          <div class="stat-card"><strong>${catalog.tracks.length}</strong><span>separated tracks</span></div>
          <div class="stat-card"><strong>${state.liked.length}</strong><span>liked tracks</span></div>
          <div class="stat-card"><strong>${formatTime(totalDuration, totalDuration >= 3600)}</strong><span>mapped listening time</span></div>
        </div>
      </div>
    </section>

    <section class="view-section">
      <div class="section-heading"><div><h2>Jump back in</h2><p>Each source behaves like an album, even when it began as one long video.</p></div></div>
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
      <div class="section-heading"><div><h2>Source albums</h2><p>Seeded sessions and anything you add in Catalog Studio.</p></div><a href="#/library" data-route>Show all</a></div>
      <div class="card-grid">${sources.map(sourceCard).join("")}</div>
    </section>

    ${recent.length ? `
      <section class="view-section">
        <div class="section-heading"><div><h2>Recently played</h2><p>Stored locally, with no account or server.</p></div><a href="#/history" data-route>Full history</a></div>
        ${trackTable(recent, { prefix: recentQueueId, showSource: true })}
      </section>` : ""}

    <section class="view-section">
      <div class="info-banner">
        <span class="info-icon">◇</span>
        <div><h3>Two quality paths</h3><p>YouTube playback uses the official adaptive player. A local FLAC, WAV, ALAC, or other master you own is read directly from browser storage without Acoustify re-encoding it.</p></div>
        <button class="button ghost small-button" type="button" data-action="open-settings">Quality details</button>
      </div>
    </section>`;
}

function renderSearch(route) {
  const query = route.params.get("q") || "";
  const tags = [...new Set(catalog.sources.flatMap((source) => source.tags || []))].sort();
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Find anything</p><h1>Search</h1><p>Search track titles, artists, source albums, and tags.</p></div>
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
        <div class="section-heading"><div><h2>Browse every source</h2><p>${catalog.tracks.length} separated tracks are ready.</p></div></div>
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
    <p class="search-summary">${tracks.length} track${tracks.length === 1 ? "" : "s"} and ${sources.length} source${sources.length === 1 ? "" : "s"} match “${escapeHtml(query)}”.</p>
    ${sources.length ? `<section class="view-section"><div class="section-heading"><h2>Sources</h2></div><div class="card-grid">${sources.map(sourceCard).join("")}</div></section>` : ""}
    <section class="view-section"><div class="section-heading"><h2>Tracks</h2></div>${tracks.length ? trackTable(tracks, { prefix: queueId, showSource: true }) : emptyState({ symbol: "⌕", title: "No matching tracks", copy: "Try fewer words or browse a source album." })}</section>`;
}

function renderLibrary() {
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Everything saved here</p><h1>Your Library</h1><p>Source albums, playlists, likes, and local masters live together in this browser.</p></div>
      <div class="page-actions"><button class="button primary" type="button" data-action="go-studio">＋ Add source</button><button class="button secondary" type="button" data-action="new-playlist">＋ Playlist</button></div>
    </div>
    <section class="view-section">
      <div class="section-heading"><div><h2>Source albums</h2><p>${catalog.sources.length} long-form source${catalog.sources.length === 1 ? "" : "s"} mapped into ${catalog.tracks.length} tracks.</p></div></div>
      <div class="card-grid">${catalog.sources.map(sourceCard).join("")}</div>
    </section>
    <section class="view-section">
      <div class="section-heading"><div><h2>Playlists</h2><p>Your own groupings stay on this device.</p></div></div>
      ${state.playlists.length ? `<div class="card-grid">${state.playlists.map(playlistCard).join("")}</div>` : emptyState({ symbol: "＋", title: "Build your first playlist", copy: "Group individual cuts from any source album.", action: "new-playlist", actionLabel: "Create playlist" })}
    </section>`;
}

function renderLiked() {
  const tracks = state.liked.map((key) => catalog.trackByKey.get(key)).filter(Boolean);
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Personal collection</p><h1>Liked Tracks</h1><p>${tracks.length} track${tracks.length === 1 ? "" : "s"} you marked for quick access.</p></div>
      ${tracks.length ? '<div class="page-actions"><button class="button primary" type="button" data-action="play-liked">▶ Play all</button></div>' : ""}
    </div>
    ${trackTable(tracks, { prefix: "liked", showSource: true, emptyTitle: "No liked tracks yet", emptyCopy: "Tap the heart beside any separated track to keep it here." })}`;
}

function renderHistory() {
  const tracks = uniqueHistoryTracks(100);
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Browser memory</p><h1>Listening History</h1><p>Your most recent unique tracks. This history never leaves the browser unless you export it.</p></div>
      ${tracks.length ? '<div class="page-actions"><button class="button ghost" type="button" data-action="clear-history">Clear history</button></div>' : ""}
    </div>
    ${trackTable(tracks, { prefix: "history", showSource: true, emptyTitle: "Nothing played yet", emptyCopy: "Start a source album and your recent listening will appear here." })}`;
}

function renderSource(sourceId) {
  const source = catalog.sourceById.get(sourceId);
  if (!source) {
    dom.view.innerHTML = emptyState({ symbol: "?", title: "Source not found", copy: "It may have been removed from this browser.", action: "go-library", actionLabel: "Back to library" });
    return;
  }
  const duration = formatTime(source.duration, source.duration >= 3600);
  const canOpenYouTube = source.provider === "youtube" && source.youtubeId;
  dom.view.innerHTML = `
    <section class="collection-hero">
      <img class="collection-art" ${artworkAttrs(source)} alt="${escapeHtml(source.title)} artwork">
      <div class="collection-copy">
        <p class="eyebrow">Source album</p>
        <h1>${escapeHtml(source.title)}</h1>
        <p>${escapeHtml(source.description || "A long-form source divided into individually playable tracks.")}</p>
        <div class="collection-meta"><strong>${escapeHtml(source.artist)}</strong><span>•</span><span>${source.year || "Personal archive"}</span><span>•</span><span>${source.tracks.length} tracks</span><span>•</span><span>${duration}</span><span>•</span><span>${providerLabel(source)}</span></div>
      </div>
    </section>
    <div class="collection-controls">
      <button class="play-button big-play" type="button" data-action="play-source" data-source-id="${escapeHtml(source.id)}" aria-label="Play source">▶</button>
      <button class="button ghost small-button" type="button" data-action="shuffle-source" data-source-id="${escapeHtml(source.id)}">⤨ Shuffle</button>
      <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">${source.timingStatus === "calibration-required" ? "Calibrate cuts" : "Edit timings"}</button>
      ${canOpenYouTube ? `<a class="button ghost small-button" href="https://www.youtube.com/watch?v=${encodeURIComponent(source.youtubeId)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>` : ""}
    </div>
    ${source.timingStatus === "calibration-required" ? `
      <div class="info-banner warning-banner">
        <span class="info-icon">!</span>
        <div><h3>One calibration pass recommended</h3><p>${escapeHtml(source.timingNote || "These boundaries are a first-pass map. Capture each song start while listening for precise cuts.")}</p></div>
        <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">Open calibrator</button>
      </div>` : `
      <div class="info-banner">
        <span class="info-icon">✓</span>
        <div><h3>${escapeHtml(timingLabel(source))}</h3><p>${escapeHtml(source.timingNote || "Every row jumps to its own timestamp boundary in the source.")}</p></div>
      </div>`}
    <section class="view-section">
      ${trackTable(source.tracks, { prefix: `source-${source.id}`, showSource: false })}
    </section>`;
}

function renderPlaylist(playlistId) {
  const playlist = state.playlists.find((item) => item.id === playlistId);
  if (!playlist) {
    dom.view.innerHTML = emptyState({ symbol: "?", title: "Playlist not found", copy: "It may have been deleted from local memory.", action: "go-library", actionLabel: "Back to library" });
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
        <p>${escapeHtml(playlist.description || "A personal collection of separated tracks.")}</p>
        <div class="collection-meta"><strong>Personal archive</strong><span>•</span><span>${tracks.length} tracks</span><span>•</span><span>${formatTime(total, total >= 3600)}</span><span>•</span><span>Updated ${relativeDate(playlist.updatedAt)}</span></div>
      </div>
    </section>
    <div class="collection-controls">
      ${tracks.length ? `<button class="play-button big-play" type="button" data-action="play-playlist" data-playlist-id="${escapeHtml(playlist.id)}">▶</button>` : ""}
      <button class="button ghost small-button" type="button" data-action="delete-playlist" data-playlist-id="${escapeHtml(playlist.id)}">Delete playlist</button>
    </div>
    <section class="view-section">${trackTable(tracks, { prefix: `playlist-${playlist.id}`, showSource: true, playlistId: playlist.id, emptyTitle: "This playlist is empty", emptyCopy: "Use the plus button beside any track to add it here." })}</section>`;
}

function chapterTextForSource(source) {
  return source.tracks.map((track) => `${formatTime(track.start, track.start >= 3600)} ${track.title}`).join("\n");
}

function renderStudio(route) {
  const sourceId = route.params.get("source") || "";
  const source = sourceId ? catalog.sourceById.get(sourceId) : null;
  const provider = source?.provider || "youtube";
  const chapters = source ? chapterTextForSource(source) : "0:00 First track\n3:42 Second track\n7:15 Third track";
  const duration = source ? formatTime(source.duration, source.duration >= 3600) : "";
  const localMeta = source?.assetMeta || {};
  pendingLocalFile = null;

  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Catalog Studio</p><h1>${source ? "Tune a source" : "Add a source"}</h1><p>${source ? `Adjust the separated tracks for ${escapeHtml(source.title)}.` : "Turn another long YouTube upload or local master into a track-based source album."}</p></div>
      ${source ? `<div class="page-actions"><button class="button ghost" type="button" data-action="studio-reset">＋ New source</button></div>` : ""}
    </div>

    <div class="studio-layout">
      <section class="surface-card">
        <h2>Source details</h2>
        <p>Acoustify saves this catalog entry in IndexedDB. It does not upload files or mutate your GitHub repository.</p>
        <form id="studio-form">
          <input type="hidden" name="id" value="${escapeHtml(source?.id || "")}">
          <input type="hidden" name="assetId" value="${escapeHtml(source?.assetId || "")}">
          <input type="hidden" name="assetName" value="${escapeHtml(localMeta.name || "")}">
          <input type="hidden" name="assetType" value="${escapeHtml(localMeta.type || "")}">
          <input type="hidden" name="assetSize" value="${escapeHtml(localMeta.size || "")}">
          <div class="form-grid">
            <fieldset class="field full provider-choice">
              <legend>Playback source</legend>
              <label class="provider-option"><input type="radio" name="provider" value="youtube" ${provider === "youtube" ? "checked" : ""}><span>▶ YouTube player</span></label>
              <label class="provider-option"><input type="radio" name="provider" value="local" ${provider === "local" ? "checked" : ""}><span>◇ Local master file</span></label>
            </fieldset>
            <label class="field"><span>Source title</span><input name="title" required maxlength="140" value="${escapeHtml(source?.title || "")}" placeholder="The Cabin Sessions"></label>
            <label class="field"><span>Artist</span><input name="artist" required maxlength="120" value="${escapeHtml(source?.artist || "")}" placeholder="Of Monsters and Men"></label>
            <label class="field full youtube-field" ${provider !== "youtube" ? "hidden" : ""}><span>YouTube URL or video ID</span><input name="youtubeInput" value="${escapeHtml(source?.youtubeId || "")}" placeholder="https://youtu.be/…"><small>The video remains inside the official visible YouTube player.</small></label>
            <div class="field full local-field" ${provider !== "local" ? "hidden" : ""}>
              <span>Local audio master</span>
              <label class="file-drop"><input id="local-file-input" type="file" accept="audio/*,.flac,.wav,.aiff,.aif,.m4a,.alac"><span id="local-file-label">${source?.assetId ? `<strong>${escapeHtml(localMeta.name || "File already stored")}</strong><br>Choose a replacement only when needed.` : `<strong>Choose an audio file you own</strong><br>FLAC/WAV remain untouched; playback support depends on the browser.`}</span></label>
            </div>
            <label class="field"><span>Full duration</span><input name="duration" required value="${escapeHtml(duration)}" placeholder="56:55"><small>Used to close the final track boundary.</small></label>
            <label class="field"><span>Year</span><input name="year" inputmode="numeric" value="${escapeHtml(source?.year || "")}" placeholder="2026"></label>
            <label class="field full"><span>Artwork URL</span><input name="artwork" value="${escapeHtml(source?.artwork || "")}" placeholder="Optional; YouTube thumbnail is automatic"></label>
            <label class="field full"><span>Description</span><textarea name="description" rows="3" placeholder="What makes this source useful?">${escapeHtml(source?.description || "")}</textarea></label>
            <label class="field full"><span>Tags</span><input name="tags" value="${escapeHtml((source?.tags || []).join(", "))}" placeholder="live, acoustic, rare"></label>
            <label class="field full"><span>Track starts</span><textarea id="chapter-input" name="chapters" rows="${source ? Math.min(18, Math.max(7, source.tracks.length + 1)) : 8}" required>${escapeHtml(chapters)}</textarea><small>One line per track: <span class="mono">0:00 Song title</span>. The next start automatically becomes the current track’s end.</small></label>
          </div>
          <div class="form-actions">
            <button class="button ghost" type="button" data-action="preview-chapters">Preview cuts</button>
            <button class="button primary" type="submit">${source ? "Save calibration" : "Add to library"}</button>
          </div>
        </form>
      </section>

      <aside class="surface-card">
        <h2>Track preview</h2>
        <p>Confirm ordering and duration before saving.</p>
        <div id="chapter-preview" class="preview-list"></div>
        <div class="studio-tip">For seamless transitions, put the next track’s timestamp at the first audible moment of that track. Acoustify automatically advances when the current segment reaches that boundary.</div>
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
        <div><h2>Timestamp calibrator</h2><p>Play the uninterrupted source, then capture the exact start of each song. Saving the form above applies the updated cuts.</p></div>
        <div class="page-actions">
          <div class="calibration-clock"><span>Current</span><strong id="calibration-clock">0:00.0</strong></div>
          <button class="button secondary small-button" type="button" data-action="play-calibration-source" data-source-id="${escapeHtml(source.id)}">▶ Play full source</button>
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
      <p class="calibration-help">Tip: pause at the first transient, tap ●, then use ±0.5 seconds for fine adjustment. Starts must remain strictly increasing.</p>
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
  dom.view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Local-first controls</p><h1>Settings</h1><p>Manage playback behavior, browser memory, source overrides, and local audio storage.</p></div>
    </div>
    <div class="settings-grid">
      <section class="setting-card">
        <h3>Playback</h3><p>These choices are remembered across sessions.</p>
        <div class="setting-row"><div><strong>Automatic next track</strong><div class="muted small">Advance at each timestamp boundary.</div></div><label class="toggle"><input id="setting-autoplay" type="checkbox" ${state.settings.autoplay ? "checked" : ""}><span></span></label></div>
        <div class="setting-row"><div><strong>Open source video panel on desktop</strong><div class="muted small">Leave this off for a cleaner listening layout.</div></div><label class="toggle"><input id="setting-panel" type="checkbox" ${state.settings.playerPanelOpen ? "checked" : ""}><span></span></label></div>
        <label class="setting-row setting-number"><div><strong>Segment lead-in</strong><div class="muted small">Start YouTube cuts slightly before the saved timestamp.</div></div><input id="setting-lead-in" type="number" min="0" max="5" step="0.5" value="${escapeHtml(state.settings.segmentLeadIn)}" aria-label="Segment lead-in seconds"><span>sec</span></label>
      </section>
      <section class="setting-card">
        <h3>Audio quality</h3><p>YouTube determines the adaptive audio/video representation. Acoustify does not extract or transcode it. Local files are handed directly to the browser.</p>
        <div class="info-banner"><span class="info-icon">◇</span><div><h3>Best-fidelity path</h3><p>Import a master file you own. The exact Blob is retained in IndexedDB; browser codec support still applies.</p></div></div>
      </section>
      <section class="setting-card">
        <h3>Browser storage</h3><p id="storage-description">Checking storage usage…</p>
        <div class="storage-meter"><span id="storage-meter-fill"></span></div>
        <div class="storage-copy"><span id="storage-used">—</span><span id="storage-quota">—</span></div>
        <div class="setting-actions" style="margin-top:15px"><button class="button secondary small-button" type="button" data-action="request-persistent">Request persistent storage</button><button class="button ghost small-button" type="button" data-action="clear-local-audio">Clear local audio</button></div>
      </section>
      <section class="setting-card">
        <h3>Memory backup</h3><p>Export likes, history, playlists, settings, and catalog entries as JSON. Large local audio Blobs are intentionally not included.</p>
        <div class="setting-actions"><button class="button secondary small-button" type="button" data-action="export-memory">Export memory</button><button class="button ghost small-button" type="button" data-action="import-memory">Import memory</button><button class="button danger small-button" type="button" data-action="reset-memory">Reset app memory</button></div>
      </section>
      <section class="setting-card" style="grid-column:1/-1">
        <h3>Catalog entries and overrides</h3><p>Editing a built-in source creates a browser override. Removing that override restores the packaged catalog. Custom entries disappear when their local override is removed.</p>
        <div class="source-manager">
          ${catalog.sources.map((source) => `
            <div class="source-manager-row">
              <img ${artworkAttrs(source)} alt="">
              <div><strong>${escapeHtml(source.title)}</strong><span>${escapeHtml(source.artist)} · ${timingLabel(source)}${sourceIsUserOverride(source.id) ? " · browser override" : " · packaged"}</span></div>
              <div class="page-actions">
                <button class="button ghost small-button" type="button" data-action="edit-source" data-source-id="${escapeHtml(source.id)}">Edit</button>
                ${sourceIsUserOverride(source.id) ? `<button class="button ghost small-button" type="button" data-action="delete-user-source" data-source-id="${escapeHtml(source.id)}">Remove override</button>` : ""}
              </div>
            </div>`).join("")}
        </div>
        <div class="setting-actions" style="margin-top:15px"><button class="button secondary small-button" type="button" data-action="export-catalog">Export custom catalog</button><button class="button primary small-button" type="button" data-action="go-studio">＋ Add source</button></div>
      </section>
    </div>`;
  refreshStorageEstimate();
}

function renderNotFound() {
  dom.view.innerHTML = emptyState({ symbol: "?", title: "Page not found", copy: "This route does not exist in Acoustify.", action: "go-home", actionLabel: "Go home" });
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
  if (route.name === "source") return catalog.sourceById.get(route.segments[1])?.title || "Source";
  if (route.name === "playlist") return state.playlists.find((item) => item.id === route.segments[1])?.name || "Playlist";
  const labels = { home: "Home", search: "Search", library: "Your Library", liked: "Liked Tracks", history: "History", studio: "Catalog Studio", settings: "Settings" };
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
  dom.barTrackArtist.textContent = `${track.artist} · ${source?.title || track.sourceTitle || "Source"}`;
  dom.panelTrackTitle.textContent = track.title;
  dom.panelArtwork.src = art;
  dom.panelArtwork.onerror = () => { dom.panelArtwork.src = "./assets/icons/icon-512.png"; };
  dom.panelTitle.textContent = track.title;
  dom.panelArtist.textContent = track.artist;
  dom.sourceNote.textContent = source?.timingNote || "Playback is bounded by this track’s saved start and end timestamps.";
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
  dom.queueCount.textContent = `${tracks.length} track${tracks.length === 1 ? "" : "s"}`;
  if (!tracks.length) {
    dom.queueList.innerHTML = '<div class="muted small" style="padding:12px 5px">A queue appears when you start a source or playlist.</div>';
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
    button.setAttribute("aria-label", liked ? "Unlike track" : "Like track");
  });
  const key = player?.currentTrack?.key || state.playback.trackKey;
  const liked = key ? state.liked.includes(key) : false;
  dom.barLike.classList.toggle("active", liked);
  dom.barLike.textContent = liked ? "♥" : "♡";
}

async function playTrack(trackKey, queue = null, { resume = false } = {}) {
  const track = catalog.trackByKey.get(trackKey);
  if (!track) return toast("That track is no longer in the catalog.", "error");
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
  if (!keys.length) return toast("This playlist has no playable tracks yet.");
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
  dom.playlistDialogTitle.textContent = trackKey ? "Create playlist and add track" : "Create playlist";
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
      <span><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.trackKeys.length} track${playlist.trackKeys.length === 1 ? "" : "s"}</span></span>
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
    title: `${source.title} — full calibration stream`,
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
    toast("Full source is playing. Capture each boundary with ●.", "success");
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
    toast(`File selected, but duration could not be read: ${error.message}`, "error");
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
    assetMeta
  });
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
  toast(`${source.title} saved to this browser.`, "success");
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
    description.textContent = "Includes app memory, cached shell files, and any local masters stored by this origin.";
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
    renderPlayerSnapshot(event.detail);
  });
  player.addEventListener("qualitychange", (event) => renderPlayerSnapshot(event.detail));
  player.addEventListener("queuechange", (event) => renderQueue(event.detail));
  player.addEventListener("optionschange", (event) => {
    state.settings.repeat = event.detail.repeat;
    state.settings.shuffle = event.detail.shuffle;
    state.settings.autoplay = event.detail.autoplay;
    state.settings.segmentLeadIn = event.detail.segmentLeadIn;
    persistState();
    renderPlayerSnapshot(event.detail);
  });
  player.addEventListener("volumechange", (event) => {
    state.settings.volume = event.detail.volume;
    persistState();
  });
  player.addEventListener("segmentended", (event) => updatePlaybackMemory(event.detail));
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
    case "toggle-shuffle": player.setShuffle(!player.shuffle); break;
    case "cycle-repeat": player.cycleRepeat(); break;
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
      confirmAction("Delete playlist?", `“${playlist.name}” will be removed from this browser. Its source tracks stay in the library.`, () => {
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
    case "clear-history": confirmAction("Clear listening history?", "Likes, playlists, and sources will remain. This only removes recently played entries.", () => {
      state.history = [];
      persistState();
      renderRoute();
    }); break;
    case "edit-source": navigate(`studio?source=${encodeURIComponent(sourceId)}`); break;
    case "delete-user-source": {
      const source = catalog.sourceById.get(sourceId);
      confirmAction("Remove browser override?", sourceIsPackaged(sourceId)
        ? `Your changes to “${source?.title || sourceId}” will be removed and the packaged version will return.`
        : `“${source?.title || sourceId}” will be removed from this browser.`, async () => {
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
      toast("Memory backup exported.", "success");
      break;
    }
    case "import-memory": dom.memoryImport.click(); break;
    case "export-catalog": {
      downloadJson(`acoustify-custom-catalog-${new Date().toISOString().slice(0,10)}.json`, { version: 1, sources: state.userSources });
      toast("Custom catalog exported.", "success");
      break;
    }
    case "request-persistent": {
      const granted = await requestPersistentStorage();
      toast(granted ? "Browser granted persistent storage." : "Persistent storage was not granted; exports remain your safest backup.", granted ? "success" : "info");
      break;
    }
    case "clear-local-audio": confirmAction("Clear local audio files?", "Stored audio Blobs will be deleted. Local catalog entries will remain but cannot play until their files are re-imported.", async () => {
      await clearAudioAssets();
      toast("Local audio storage cleared.", "success");
      refreshStorageEstimate();
    }); break;
    case "reset-memory": confirmAction("Reset Acoustify memory?", "This clears likes, history, playlists, settings, and browser catalog overrides. Local audio files are cleared too.", async () => {
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
      if (!Array.isArray(normalized.userSources)) throw new Error("The file does not contain valid Acoustify memory.");
      for (const source of normalized.userSources) validateCatalog({ version: 1, sources: [source] });
      state = normalized;
      await setValue(STATE_KEY, state);
      rebuildCatalog();
      player.configure(state.settings);
      renderRoute();
      renderPersistedPlaybackPreview();
      toast("Memory backup imported. Local audio files must remain in this browser or be re-imported.", "success", 6000);
    } catch (error) {
      toast(`Import failed: ${error.message}`, "error", 6500);
    }
  });
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
  dom.view.innerHTML = '<div class="loading-view"><div><div class="loading-disc"></div><p>Opening your archive…</p></div></div>';
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
    dom.view.innerHTML = `<div class="error-view"><p class="eyebrow">Startup error</p><h1>Acoustify could not open</h1><p>${escapeHtml(error.message)}</p><button class="button primary" type="button" onclick="location.reload()">Try again</button></div>`;
  }
}

init();
