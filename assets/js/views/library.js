// Library (#/library?tab=…, #/downloads), Liked Songs (#/liked) and Recently played (#/history).
// Also exports the small helpers album.js and playlist.js share: queue registration, live list state,
// row labels, the download toggle and the back button.
import { icon } from "../icons.js";
import { albumCard, artistCard, art, chips, emptyState, grid, hero, html, playFab, playlistCard, raw, sectionBlock, skeletonGrid, skeletonList, trackList } from "../ui.js";
import { formatBytes, formatDurationLong, joinMeta, pluralize, relativeDate } from "../utils.js";

export const LIBRARY_TABS = Object.freeze([
  Object.freeze({ value: "playlists", label: "Playlists" }),
  Object.freeze({ value: "albums", label: "Albums" }),
  Object.freeze({ value: "artists", label: "Artists" }),
  Object.freeze({ value: "downloads", label: "Downloads" })
]);

const DOWNLOAD_STATES = new Set(["none", "queued", "downloading", "done"]);
// Must match the labels app.js writes when it updates a toggle in place.
const DOWNLOAD_LABELS = Object.freeze({ none: "Download", queued: "Cancel download", downloading: "Cancel download", done: "Remove download" });
const DAY_MS = 24 * 60 * 60 * 1000;

// The tab picked last in this session, so Library reopens where the listener left it.
let rememberedTab = "";

/* ------------------------------------------------------------------ shared helpers */

const enc = (value) => encodeURIComponent(String(value ?? ""));

export function call(fn, fallback, ...args) {
  if (typeof fn !== "function") return fallback;
  try {
    const value = fn(...args);
    return value === undefined ? fallback : value;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

export function safeDecode(value) {
  const text = String(value ?? "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function lookupSource(catalog, id) {
  if (!id) return null;
  return catalog?.sourceById?.get?.(id) || catalog?.sources?.find?.((source) => source.id === id) || null;
}

export function lookupTrack(catalog, key) {
  if (!key) return null;
  return catalog?.trackByKey?.get?.(key) || catalog?.tracks?.find?.((track) => track.key === key) || null;
}

export function tracksFor(catalog, keys = []) {
  const seen = new Set();
  const tracks = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    if (seen.has(key)) continue;
    const track = lookupTrack(catalog, key);
    if (!track) continue;
    seen.add(key);
    tracks.push(track);
  }
  return tracks;
}

export function totalDuration(tracks = []) {
  return tracks.reduce((sum, track) => {
    const seconds = Number(track?.duration ?? Number(track?.end) - Number(track?.start));
    return sum + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
  }, 0);
}

export function registerQueue(ctx, prefix, tracks) {
  return call(ctx?.registerQueue, undefined, prefix, tracks) || undefined;
}

export function isLiked(ctx, key) {
  if (typeof ctx?.isLiked === "function") return Boolean(call(ctx.isLiked, false, key));
  return ctx?.likedKeys instanceof Set ? ctx.likedKeys.has(key) : false;
}

// Normalized { state, progress, available } for a source's download toggle.
export function downloadInfo(ctx, sourceId) {
  if (typeof ctx?.downloadState !== "function") return { state: "none", progress: 0, available: false };
  const info = call(ctx.downloadState, null, sourceId) || {};
  const state = DOWNLOAD_STATES.has(info.state) ? info.state : "none";
  const progress = Number(info.progress);
  return {
    state,
    progress: state === "done" ? 1 : Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    available: info.available !== false
  };
}

// Current row, like and offline state for a freshly rendered trackList (app.js keeps them live afterwards).
export function listState(ctx) {
  const currentKey = ctx?.player?.currentTrack?.key ?? ctx?.currentKey ?? null;
  const isPlaying = typeof ctx?.isPlaying === "boolean" ? ctx.isPlaying : Boolean(ctx?.player?.isPlaying);
  const likedKeys = ctx?.likedKeys instanceof Set ? ctx.likedKeys : new Set(Array.isArray(ctx?.state?.liked) ? ctx.state.liked : []);
  let offlineReady = null;
  if (typeof ctx?.downloadState === "function") {
    const cache = new Map();
    offlineReady = (track) => {
      if (!cache.has(track.sourceId)) cache.set(track.sourceId, downloadInfo(ctx, track.sourceId).state === "done");
      return cache.get(track.sourceId);
    };
  }
  return { currentKey, isPlaying, likedKeys, offlineReady };
}

function fold(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// What a list row prints on its album line. Sessions keep their title; a single's "album" is
// usually its own song title again ("The Cave (Live on The Current)"), so it gets whichever of
// "(Live at …)", series or year the row title does not already say.
export function recordingLabel(track, source) {
  if (!source) return track?.sourceTitle || "";
  if ((source.tracks?.length || 0) > 1) return source.title || track?.sourceTitle || "";
  const title = fold(track?.title);
  const inner = String(source.title || "").match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || "";
  const candidates = [
    /^(with|feat\.?|ft\.?)\s/i.test(inner) ? "" : inner,
    source.series,
    source.year ? String(source.year) : ""
  ];
  return candidates.find((text) => text && !title.includes(fold(text))) || "";
}

// Row copies for trackList; keys and queue contents are unchanged.
export function rowLabels(catalog, tracks = []) {
  return tracks.map((track) => ({ ...track, sourceTitle: recordingLabel(track, lookupSource(catalog, track.sourceId)) }));
}

export function downloadToggle(ctx, source, { className = "" } = {}) {
  if (!source?.id) return "";
  const info = downloadInfo(ctx, source.id);
  if (!info.available) return "";
  const done = info.state === "done";
  return html`<button class="icon-btn download-toggle${className ? ` ${className}` : ""}" type="button" data-action="toggle-download" data-download-source="${source.id}" data-state="${info.state}" style="--progress:${info.progress.toFixed(3)}" aria-pressed="${done ? "true" : "false"}" aria-label="${DOWNLOAD_LABELS[info.state]}">${icon(done ? "downloaded" : "download")}</button>`;
}

// data: { "source-id": "…" } → data-source-id="…"
export function moreButton({ action, data = {}, label }) {
  const attrs = Object.entries(data).map(([name, value]) => html` data-${name}="${value}"`);
  return html`<button class="icon-btn" type="button" data-action="${action}"${attrs} aria-haspopup="menu" aria-label="${label}">${icon("more")}</button>`;
}

// Back button row; `trailing` (e.g. a ••• menu) sits at the far end, like a navigation bar.
export function pageTop({ mobileOnly = false, trailing = "" } = {}) {
  return html`<div class="page-top${mobileOnly ? " page-top--mobile" : ""}"><button class="icon-btn" type="button" data-action="go-back" aria-label="Back">${icon("chevron-left")}</button>${trailing}</div>`;
}

// What a recording is: a released album (backed by a YouTube playlist), a multi-song session or a single.
export function releaseKind(source) {
  if (source?.youtubePlaylistId) return "Album";
  return (source?.tracks?.length || 0) > 1 ? "Session" : "Single";
}

// Card subtitle where the artist goes without saying (artist pages, "More by …"): series and year.
export function releaseSubtitle(source) {
  return joinMeta([source?.series, source?.year]) || releaseKind(source);
}

export { formatBytes };

function isLoading(ctx) {
  const state = ctx?.syncStatus?.state;
  return state === "syncing" || state === "idle";
}

// What to show where a list would be, when the library itself has nothing yet.
export function noMusicState(ctx, { loading = () => skeletonGrid(6) } = {}) {
  const state = ctx?.syncStatus?.state;
  if (state === "syncing") return loading();
  if (state === "unauthorized") {
    return emptyState({
      iconName: "cloud",
      title: "Connect your library",
      body: "Add your access key in Settings and your music will appear here.",
      actionHtml: html`<a class="btn btn-primary" href="#/settings?focus=library">Connect library</a>`
    });
  }
  if (state === "offline") {
    return emptyState({ iconName: "cloud-off", title: "You’re offline", body: "Your music will appear here when you’re back online." });
  }
  return emptyState({ iconName: "disc", title: "No music yet", body: "New music shows up here as soon as it’s published." });
}

/* ------------------------------------------------------------------ library data */

function sortedPlaylists(ctx) {
  const list = Array.isArray(ctx?.state?.playlists) ? ctx.state.playlists.filter((playlist) => playlist?.id) : [];
  // Most recently changed first, like a "Recents" list; creation order breaks ties.
  return list
    .map((playlist, index) => ({ playlist, index }))
    .sort((a, b) => (Number(b.playlist.updatedAt) || 0) - (Number(a.playlist.updatedAt) || 0) || a.index - b.index)
    .map((entry) => entry.playlist);
}

export function likedTracks(ctx) {
  return tracksFor(ctx?.catalog, ctx?.state?.liked);
}

export function historyTracks(ctx) {
  const tracks = call(ctx?.recentTracks, [], Infinity);
  return Array.isArray(tracks) ? tracks.filter((track) => track?.key) : [];
}

function albumsByAdded(catalog) {
  return Array.isArray(catalog?.sourcesByAdded) ? catalog.sourcesByAdded : Array.isArray(catalog?.sources) ? catalog.sources : [];
}

function isTab(value) {
  return LIBRARY_TABS.some((tab) => tab.value === value);
}

function pickTab(ctx, route, forced) {
  if (isTab(forced)) return forced;
  const asked = route?.params?.get?.("tab");
  if (isTab(asked)) return asked;
  if (isTab(rememberedTab)) return rememberedTab;
  return sortedPlaylists(ctx).length ? "playlists" : "albums";
}

const tabHref = (value) => `#/library?tab=${value}`;

/* ------------------------------------------------------------------ library panels */

function createPlaylistCard() {
  return html`<button class="card card--create" type="button" data-action="new-playlist"><span class="card-art card-create-art">${icon("plus", { size: 34 })}</span><span class="card-title">New playlist</span><span class="card-sub">Start a collection</span></button>`;
}

function playlistsPanel(ctx) {
  const playlists = sortedPlaylists(ctx);
  if (!playlists.length) {
    return emptyState({
      iconName: "list",
      title: "Make your first playlist",
      body: "Gather favorites from any session. Use ••• on a song and choose Add to playlist.",
      actionHtml: html`<button class="btn btn-primary" type="button" data-action="new-playlist">${icon("plus")}New playlist</button>`
    });
  }
  const cards = playlists.map((playlist) => playlistCard(playlist, tracksFor(ctx.catalog, playlist.trackKeys)));
  return html`<p class="library-count">${pluralize(playlists.length, "playlist")}</p>${grid([createPlaylistCard(), ...cards])}`;
}

function albumsPanel(ctx) {
  const sources = albumsByAdded(ctx.catalog);
  if (!sources.length) return noMusicState(ctx);
  const sessions = sources.filter((source) => (source.tracks?.length || 0) > 1).length;
  const singles = sources.length - sessions;
  const count = joinMeta([sessions ? pluralize(sessions, "session") : "", singles ? pluralize(singles, "single") : ""]);
  const cards = sources.map((source) => albumCard(source, { isNew: Boolean(call(ctx.isNew, false, source.id)) }));
  return html`<p class="library-count">${count} <span class="library-count-sort">· Recently added</span></p>${grid(cards)}`;
}

function artistsPanel(ctx) {
  const artists = Array.isArray(ctx.catalog?.artists) ? ctx.catalog.artists : [];
  if (!artists.length) return noMusicState(ctx);
  return html`<p class="library-count">${pluralize(artists.length, "artist")}</p>${grid(artists.map(artistCard), { variant: "artists" })}`;
}

function downloadRow(ctx, source, info) {
  const inProgress = info.state === "downloading" || info.state === "queued";
  const sub = joinMeta([source.artist, source.bytes ? formatBytes(source.bytes) : ""]);
  const glyph = inProgress
    ? ""
    : html`<span class="dl-state" data-download-source="${source.id}" data-state="${info.state}">${icon(info.state === "done" ? "downloaded" : "download", { size: 14 })}</span>`;
  // Finished rows get the album menu (Remove download lives there) so one stray tap never deletes.
  const trailing = inProgress
    ? downloadToggle(ctx, source)
    : moreButton({ action: "source-menu", data: { "source-id": source.id }, label: `More options for ${source.title}` });
  return html`<div class="dl-row" role="listitem" data-source-id="${source.id}"><a class="dl-link" href="#/album/${enc(source.id)}"><span class="dl-art">${art(source, { size: 112 })}</span><span class="dl-text"><span class="dl-title">${source.title}</span><span class="dl-sub">${glyph}<span class="dl-sub-text">${sub}</span></span></span></a>${trailing}</div>`;
}

function downloadsInvite(ctx, entries) {
  const bytes = entries.reduce((sum, entry) => sum + (Number(entry.source.bytes) || 0), 0);
  const body = ["Downloaded albums play anywhere, even without a connection.", bytes ? `Your whole library is about ${formatBytes(bytes)}.` : ""]
    .filter(Boolean)
    .join(" ");
  if (ctx?.syncStatus?.state === "unauthorized") {
    return emptyState({
      iconName: "download",
      title: "Listen offline",
      body: "Connect your library first, then download albums to play them anywhere.",
      actionHtml: html`<a class="btn btn-primary" href="#/settings?focus=library">Connect library</a>`
    });
  }
  return emptyState({
    iconName: "download",
    title: "Listen offline",
    body,
    actionHtml: html`<button class="btn btn-primary" type="button" data-action="download-all">${icon("download")}Download all</button><a class="btn btn-secondary" href="${tabHref("albums")}" data-library-tab="albums">Browse albums</a>`
  });
}

function downloadsPanel(ctx) {
  const sources = albumsByAdded(ctx.catalog);
  if (!sources.length) return noMusicState(ctx, { loading: () => skeletonList(4) });
  const entries = sources.map((source) => ({ source, info: downloadInfo(ctx, source.id) })).filter((entry) => entry.info.available);
  if (!entries.length) {
    return emptyState({ iconName: "cloud-off", title: "Downloads aren’t available here", body: "This browser can’t keep music for offline listening. Your library still streams when you’re online." });
  }
  const done = entries.filter((entry) => entry.info.state === "done");
  // Actively downloading first, then the queue in the order it will run.
  const active = [
    ...entries.filter((entry) => entry.info.state === "downloading"),
    ...entries.filter((entry) => entry.info.state === "queued")
  ];
  if (!done.length && !active.length) return downloadsInvite(ctx, entries);

  const bytes = done.reduce((sum, entry) => sum + (Number(entry.source.bytes) || 0), 0);
  const waiting = entries.length - done.length - active.length;
  const fill = entries.length ? done.length / entries.length : 0;
  const usage = html`<span>${done.length} of ${pluralize(entries.length, "album")}</span><span data-dl-bytes${bytes ? "" : raw(" hidden")}>${bytes ? formatBytes(bytes) : ""}</span>`;
  const summaryActions = html`${waiting > 0 ? html`<button class="btn btn-secondary btn-sm" type="button" data-action="download-all">${icon("download")}${done.length || active.length ? `Download ${waiting} more` : "Download all"}</button>` : ""}${done.length ? html`<button class="btn btn-ghost btn-sm dl-remove-all" type="button" data-action="remove-all-downloads">Remove all</button>` : ""}`;
  const summary = html`<div class="dl-summary"><div class="dl-summary-text"><p class="dl-summary-title">On this device</p><p class="dl-summary-sub">${usage}</p><span class="dl-meter" style="--fill:${fill.toFixed(3)}" aria-hidden="true"></span></div>${String(summaryActions).trim() ? html`<div class="dl-summary-actions">${summaryActions}</div>` : ""}</div>`;

  const list = (items) => html`<div class="dl-list" role="list">${items.map((entry) => downloadRow(ctx, entry.source, entry.info))}</div>`;
  const activeSection = active.length ? sectionBlock({ title: "Downloading", body: list(active), className: "dl-section" }) : "";
  const doneSection = done.length ? sectionBlock({ title: "Downloaded", body: list(done), className: "dl-section" }) : "";
  return html`${summary}${activeSection}${doneSection}`;
}

const PANELS = { playlists: playlistsPanel, albums: albumsPanel, artists: artistsPanel, downloads: downloadsPanel };

function quickRow({ href, tile, iconName, label, sub }) {
  return html`<a class="list-row library-quick-row" href="${href}"><span class="list-row-icon library-tile library-tile--${tile}">${icon(iconName, { size: 20 })}</span><span class="list-row-label">${label}<small>${sub}</small></span>${icon("chevron-right", { size: 20 })}</a>`;
}

// Liked Songs, Recently played and every song in the library (#/songs has no tab of its own on phones).
function quickRows(ctx) {
  const liked = Array.isArray(ctx?.state?.liked) ? tracksFor(ctx.catalog, ctx.state.liked).length : 0;
  const recent = call(ctx?.recentTracks, [], 1)?.[0] || null;
  const when = recent && Number(recent.playedAt) > 0 ? relativeDate(recent.playedAt) : "";
  const songs = Array.isArray(ctx?.catalog?.tracks) ? ctx.catalog.tracks.length : 0;
  return html`<nav class="list-group library-quick" aria-label="Your music">${[
    quickRow({ href: "#/liked", tile: "liked", iconName: "heart-fill", label: "Liked Songs", sub: liked ? pluralize(liked, "song") : "Songs you like appear here" }),
    quickRow({ href: "#/history", tile: "history", iconName: "clock", label: "Recently played", sub: recent ? joinMeta([recent.title, when]) : "Nothing played yet" }),
    quickRow({ href: "#/songs", tile: "songs", iconName: "songs", label: "Songs", sub: songs ? pluralize(songs, "song") : "Every song in your library" })
  ]}</nav>`;
}

// New playlist and Settings are phone affordances; on desktop the sidebar has both.
function libraryHead(title) {
  return html`<div class="page-title-row library-title-row"><h1>${title}</h1><div class="library-title-actions mobile-only"><button class="icon-btn" type="button" data-action="new-playlist" aria-label="New playlist" title="New playlist">${icon("plus")}</button><a class="icon-btn" href="#/settings" aria-label="Settings" title="Settings">${icon("settings")}</a></div></div>`;
}

function libraryTabs(active) {
  const items = LIBRARY_TABS.map((tab) => ({
    label: tab.label,
    href: tabHref(tab.value),
    active: tab.value === active,
    attrs: { libraryTab: tab.value, "aria-controls": `library-panel-${tab.value}` }
  }));
  return html`<span class="library-tabs-sentinel" aria-hidden="true"></span><nav class="library-tabs" aria-label="Library sections">${chips(items)}</nav>`;
}

function panelMarkup(ctx, tab, active) {
  let body;
  try {
    body = PANELS[tab.value](ctx);
  } catch (error) {
    console.error(error);
    body = emptyState({ iconName: "alert", title: "Couldn’t show this list", body: "Reloading usually fixes it." });
  }
  return html`<section class="library-panel library-panel--${tab.value}" id="library-panel-${tab.value}" data-library-panel="${tab.value}" aria-label="${tab.label}"${tab.value === active ? "" : raw(" hidden")}>${body}</section>`;
}

/* ------------------------------------------------------------------ library view-local behaviour */

function scrollerOf(root) {
  return root.closest?.(".main") || document.scrollingElement || document.documentElement;
}

function mountLibrary(root, ctx, { active: initial }) {
  const tabsEl = root.querySelector(".library-tabs");
  const sentinel = root.querySelector(".library-tabs-sentinel");
  let active = initial;
  let disposed = false;
  let observer = null;

  const updateUsage = () => {
    if (typeof ctx?.storageUsage !== "function") return;
    Promise.resolve()
      .then(() => ctx.storageUsage())
      .then((usage) => {
        const target = root.querySelector("[data-dl-bytes]");
        const bytes = Number(usage?.bytes) || 0;
        if (disposed || !target || !bytes) return;
        target.textContent = formatBytes(bytes);
        target.hidden = false;
      })
      .catch(() => {});
  };

  const setTab = (next) => {
    if (!isTab(next) || next === active) return;
    active = next;
    rememberedTab = next;
    for (const panel of root.querySelectorAll("[data-library-panel]")) {
      const on = panel.dataset.libraryPanel === next;
      // Downloads change underneath the page; rebuild that panel when it is opened.
      if (on && next === "downloads") {
        const tab = LIBRARY_TABS.find((item) => item.value === next);
        panel.outerHTML = String(panelMarkup(ctx, tab, next));
      } else {
        panel.hidden = !on;
      }
    }
    const shown = root.querySelector(`[data-library-panel="${next}"]`);
    // When the tab bar is pinned, start the new list right below it instead of mid-way down.
    if (shown && tabsEl?.classList.contains("is-stuck")) {
      const scroller = scrollerOf(root);
      const delta = shown.getBoundingClientRect().top - tabsEl.getBoundingClientRect().bottom - 8;
      if (scroller && delta < 0) scroller.scrollTop += delta;
    }
    // Only a tab switch fades in; background re-renders of the page must not flash.
    if (shown) {
      shown.classList.remove("is-entering");
      void shown.offsetWidth;
      shown.classList.add("is-entering");
      shown.addEventListener("animationend", () => shown.classList.remove("is-entering"), { once: true });
    }
    for (const chip of root.querySelectorAll(".library-tabs [data-library-tab]")) {
      const on = chip.dataset.libraryTab === next;
      chip.classList.toggle("is-active", on);
      if (on) chip.setAttribute("aria-current", "true");
      else chip.removeAttribute("aria-current");
    }
    if (next === "downloads") updateUsage();
    // Replace, not push: switching tabs is not somewhere the back button should revisit.
    if (/^#\/library(?:[?/]|$)/.test(location.hash)) {
      try {
        history.replaceState(history.state, "", tabHref(next));
        // Lets the controller re-light the sidebar (Library vs Downloads) without a re-render.
        window.dispatchEvent(new CustomEvent("acoustify:route-replaced"));
      } catch {
        // Sandboxed documents can refuse replaceState; the tab is already shown.
      }
    }
  };

  const onClick = (event) => {
    const link = event.target.closest?.("a[data-library-tab]");
    if (!link || !root.contains(link)) return;
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // #/downloads is its own route (sidebar entry); leaving it is a real navigation.
    if (!/^#\/library(?:[?/]|$)/.test(location.hash)) return;
    event.preventDefault();
    const next = link.dataset.libraryTab;
    if (next === active) {
      // Tapping the tab you are on goes back to the top of its list, like the tab bar does.
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      scrollerOf(root)?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      return;
    }
    setTab(next);
    if (!link.closest(".library-tabs")) root.querySelector(`.library-tabs [data-library-tab="${next}"]`)?.focus({ preventScroll: true });
  };

  // A hairline under the tab bar only while it is pinned over scrolled content.
  if (tabsEl && sentinel && typeof IntersectionObserver === "function") {
    const scroller = scrollerOf(root);
    const top = parseFloat(getComputedStyle(tabsEl).top) || 0;
    observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      // rootBounds already includes the sticky offset (rootMargin), so "above" means scrolled past.
      const above = entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
      tabsEl.classList.toggle("is-stuck", !entry.isIntersecting && above);
    }, { root: scroller === document.scrollingElement || scroller === document.documentElement ? null : scroller, rootMargin: `${-Math.round(top)}px 0px 0px 0px`, threshold: 0 });
    observer.observe(sentinel);
  }

  if (active === "downloads") updateUsage();
  root.addEventListener("click", onClick);
  return () => {
    disposed = true;
    observer?.disconnect();
    root.removeEventListener("click", onClick);
  };
}

function libraryPage(ctx, route, { forced = "", title = "Library" } = {}) {
  const catalog = ctx?.catalog;
  const active = pickTab(ctx, route, forced);
  if (!forced && route?.params?.get?.("tab") && isTab(active)) rememberedTab = active;

  if (!catalog) {
    return { title, html: String(html`<div class="page library-page">${libraryHead("Library")}${skeletonGrid(6)}</div>`) };
  }

  const panels = LIBRARY_TABS.map((tab) => panelMarkup(ctx, tab, active));
  const markup = html`<div class="page library-page">${libraryHead("Library")}${quickRows(ctx)}${libraryTabs(active)}<div class="library-panels">${panels}</div></div>`;
  return {
    title,
    html: String(markup),
    after(root) {
      return mountLibrary(root, ctx, { active });
    }
  };
}

/* ------------------------------------------------------------------ #/library, #/downloads */

export function renderLibrary(ctx, route) {
  return libraryPage(ctx, route);
}

export function renderDownloads(ctx, route) {
  return libraryPage(ctx, route, { forced: "downloads", title: "Downloads" });
}

/* ------------------------------------------------------------------ Liked Songs, Recently played */

// Liked Songs has no artwork of its own: a tinted tile (and a glow of the same colour) stands in for it.
function collectionHero({ variant, iconName, kicker, title, meta = [] }) {
  const items = meta.filter(Boolean);
  return html`<header class="hero hero--collection hero--${variant}"><div class="hero-backdrop collection-glow" aria-hidden="true"></div><div class="hero-art collection-art collection-art--${variant}" aria-hidden="true">${icon(iconName, { size: 76 })}</div><div class="hero-text"><p class="hero-kicker">${kicker}</p><h1 class="hero-title">${title}</h1>${items.length ? html`<p class="hero-meta">${items.map((item) => html`<span>${item}</span>`)}</p>` : ""}</div></header>`;
}

function collectionPage(variant, parts) {
  return html`<div class="page collection-page collection-page--${variant}">${pageTop({ mobileOnly: true })}${parts}</div>`;
}

export function renderLiked(ctx, route) {
  const title = "Liked Songs";
  const catalog = ctx?.catalog;
  const heroFor = (tracks) => collectionHero({
    variant: "liked",
    iconName: "heart-fill",
    kicker: "Playlist",
    title,
    meta: tracks.length ? [pluralize(tracks.length, "song"), formatDurationLong(totalDuration(tracks))] : []
  });

  if (!catalog || (!catalog.sources?.length && ctx?.state?.liked?.length && isLoading(ctx))) {
    return { title, html: String(collectionPage("liked", html`${heroFor([])}${skeletonList(8)}`)) };
  }

  const tracks = likedTracks(ctx);
  if (!tracks.length) {
    // The heart tile above already carries the symbol; a second heart would only repeat it.
    const empty = emptyState({
      iconName: null,
      title: "Songs you like live here",
      body: "Save a song with the heart in the player, or from the ••• menu on any song.",
      actionHtml: html`<a class="btn btn-primary" href="#/songs">Browse songs</a>`
    });
    return { title, html: String(collectionPage("liked", html`${heroFor([])}${empty}`)) };
  }

  const actions = html`${playFab({ action: "play-liked", attrs: { playLiked: "" }, label: "Play Liked Songs" })}${tracks.length > 1 ? html`<button class="icon-btn" type="button" data-action="shuffle-liked" aria-label="Shuffle Liked Songs">${icon("shuffle")}</button>` : ""}`;
  const list = trackList(rowLabels(catalog, tracks), {
    ...listState(ctx),
    queueId: registerQueue(ctx, "liked", tracks),
    numbered: false,
    showArt: true,
    showAlbum: true,
    context: { type: "liked", id: "" }
  });
  return { title, html: String(collectionPage("liked", html`${heroFor(tracks)}<div class="actions-row">${actions}</div>${list}`)) };
}

// Today / Yesterday / Earlier this week / Earlier this month / Older, newest first.
export function groupByDay(tracks, now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const buckets = [
    { label: "Today", from: today },
    { label: "Yesterday", from: today - DAY_MS },
    { label: "Earlier this week", from: today - 6 * DAY_MS },
    { label: "Earlier this month", from: today - 30 * DAY_MS },
    { label: "Older", from: -Infinity }
  ].map((bucket) => ({ ...bucket, tracks: [] }));
  for (const track of tracks) {
    const at = Number(track.playedAt) || 0;
    (buckets.find((bucket) => at >= bucket.from) || buckets.at(-1)).tracks.push(track);
  }
  return buckets.filter((bucket) => bucket.tracks.length);
}

// The same header as the other song collections (title, meta line, actions row with the play button),
// without a cover tile: the rows carry the artwork, so a big tile would only push them down.
export function renderHistory(ctx, route) {
  const title = "Recently played";
  const catalog = ctx?.catalog;
  const head = (meta = "", actionsHtml = "") => hero({ title, meta: [meta], actionsHtml });

  if (!catalog || (!catalog.sources?.length && ctx?.state?.history?.length && isLoading(ctx))) {
    return { title, html: String(collectionPage("history", html`${head()}${skeletonList(8)}`)) };
  }

  const tracks = historyTracks(ctx);
  if (!tracks.length) {
    const empty = emptyState({
      iconName: "clock",
      title: "Nothing played yet",
      body: "Songs you play show up here, so it’s easy to get back to them.",
      actionHtml: html`<a class="btn btn-primary" href="#/home">Find something to play</a>`
    });
    return { title, html: String(collectionPage("history", html`${head()}${empty}`)) };
  }

  const queueId = registerQueue(ctx, "history", tracks);
  const state = listState(ctx);
  const body = groupByDay(tracks).map((group) => html`<section class="history-group"><h2 class="history-day">${group.label}</h2>${trackList(rowLabels(catalog, group.tracks), {
    ...state,
    queueId,
    numbered: false,
    showArt: true,
    showAlbum: true,
    context: { type: "history", id: "" }
  })}</section>`);
  const actions = html`${playFab({ action: "play-history", attrs: { playHistory: "" }, label: "Play Recently played" })}<button class="icon-btn" type="button" data-action="clear-history" aria-label="Clear listening history">${icon("trash")}</button>`;
  return { title, html: String(collectionPage("history", html`${head(pluralize(tracks.length, "song"), actions)}${body}`)) };
}
