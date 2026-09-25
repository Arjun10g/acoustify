// Component builders (pure markup) and overlay UI (toast, dialogs, action sheet).
// Import-safe in node: nothing touches the DOM at module top level.
import { icon, isIconMarkup } from "./icons.js";
import { escapeHtml, formatTime, joinMeta, pluralize } from "./utils.js";

const FALLBACK_ART = "./assets/icons/icon-512.png";
const POPOVER_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 640px)";
const FAILED_ART_TTL = 30_000;
const MAX_TOASTS = 3;

const hasDom = () => typeof document !== "undefined" && typeof window !== "undefined";
const enc = (value) => encodeURIComponent(String(value ?? ""));
const joinClass = (...parts) => parts.flat().filter(Boolean).join(" ");
const reducedMotion = () => hasDom() && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/* ------------------------------------------------------------------ markup */

// A String subclass marks markup as already safe. It still behaves like a string for innerHTML,
// template literals, .includes(), JSON, etc.
class SafeHtml extends String {}

export function raw(markup) {
  if (markup instanceof SafeHtml) return markup;
  return new SafeHtml(markup === null || markup === undefined ? "" : String(markup));
}

function renderValue(value) {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (value instanceof SafeHtml) return value.valueOf();
  if (typeof value === "string") return isIconMarkup(value) ? value : escapeHtml(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (typeof value === "object" && !(value instanceof String) && typeof value[Symbol.iterator] === "function") {
    return Array.from(value, renderValue).join("");
  }
  return escapeHtml(String(value));
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) out += renderValue(values[index]) + strings[index + 1];
  return new SafeHtml(out);
}

// Parameters documented as markup (body, items, subtitleHtml, actionsHtml…) take html`` / raw() output
// or arrays of it. A plain string is text and is escaped exactly as html`` would, so library data can
// never turn into markup by accident; markup joined by hand must be wrapped in raw() on purpose.
function trusted(value) {
  if (value === null || value === undefined || value === false || value === true) return raw("");
  if (value instanceof SafeHtml) return value;
  if (Array.isArray(value)) return raw(value.map((item) => trusted(item).valueOf()).join(""));
  return raw(renderValue(value));
}

function attrName(key) {
  const name = String(key).trim();
  if (/^(data|aria)-/i.test(name)) return name.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const kebab = name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/[^a-z0-9-]/gi, "").toLowerCase();
  return `data-${kebab.replace(/^-+/, "")}`;
}

// { sourceId: "x", "aria-label": "y", playSource: "x" } → ' data-source-id="x" aria-label="y" data-play-source="x"'
function attributes(map = {}) {
  return raw(Object.entries(map || {}).map(([key, value]) => {
    if (value === null || value === undefined || value === false) return "";
    const name = attrName(key);
    if (!name || name === "data-") return "";
    return value === true ? ` ${name}=""` : ` ${name}="${escapeHtml(value)}"`;
  }).join(""));
}

/* ------------------------------------------------------------------ artwork */

const loadedArt = new Set();
const failedArt = new Map();

function artCandidates(item) {
  const list = [item?.artwork, item?.fallbackArtwork, FALLBACK_ART]
    .filter((src) => typeof src === "string" && src.trim())
    .map((src) => src.trim());
  return [...new Set(list)];
}

function recentlyFailed(src) {
  const at = failedArt.get(src);
  return at !== undefined && Date.now() - at < FAILED_ART_TTL;
}

export function art(item, { size = 160, shape = "square", className = "", alt = "", eager = false } = {}) {
  const candidates = artCandidates(item);
  // Skip URLs that just failed so a re-render does not flash through the same error again.
  const usable = candidates.filter((src, index) => index === candidates.length - 1 || !recentlyFailed(src));
  const [src, ...rest] = usable;
  const px = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.round(Number(size)) : 160;
  const classes = joinClass("art", shape === "circle" ? "art--circle" : "art--square", loadedArt.has(src) && "is-loaded", className);
  return html`<img class="${classes}" src="${src}" alt="${alt}" width="${px}" height="${px}"${eager ? "" : raw(' loading="lazy"')} decoding="async" draggable="false"${rest.length ? html` data-fallback="${JSON.stringify(rest)}"` : ""}>`;
}

function isArtImage(target) {
  return typeof HTMLImageElement !== "undefined" && target instanceof HTMLImageElement && target.classList.contains("art");
}

function rememberLoaded(src) {
  if (!src) return;
  loadedArt.delete(src);
  loadedArt.add(src);
  failedArt.delete(src);
  if (loadedArt.size > 600) loadedArt.delete(loadedArt.values().next().value);
}

function onArtLoad(event) {
  const img = event.target;
  if (!isArtImage(img)) return;
  rememberLoaded(img.getAttribute("src"));
  img.classList.add("is-loaded");
}

function onArtError(event) {
  const img = event.target;
  if (!isArtImage(img)) return;
  const src = img.getAttribute("src");
  if (src) failedArt.set(src, Date.now());
  let rest = [];
  try {
    rest = JSON.parse(img.dataset.fallback || "[]");
  } catch {
    rest = [];
  }
  const next = Array.isArray(rest) ? rest.shift() : "";
  img.classList.remove("is-loaded");
  if (next) {
    if (rest.length) img.dataset.fallback = JSON.stringify(rest);
    else img.removeAttribute("data-fallback");
    img.setAttribute("src", next);
  } else {
    img.removeAttribute("data-fallback");
    img.classList.add("is-broken");
  }
}

function settleExistingArt(img) {
  if (!img.complete) return;
  if (img.naturalWidth > 0) {
    rememberLoaded(img.getAttribute("src"));
    img.classList.add("is-loaded");
  } else if (img.getAttribute("src")) {
    onArtError({ target: img });
  }
}

/* ------------------------------------------------------------------ cards */

function cardPlayButton(label, attrs) {
  return html`<button class="card-play" type="button"${attributes(attrs)} aria-label="${label}">${icon("play-fill", { size: 22 })}</button>`;
}

// One subtitle everywhere: the artist, with the whole card width to itself. Pages that already name
// the artist (an artist page, "More by …") pass their own subtitle instead.
export function albumCard(source, { isNew = false, subtitle } = {}) {
  if (!source) return raw("");
  const title = source.title || "Untitled";
  const sub = subtitle ?? String(source.artist || "").trim();
  return html`<article class="card" data-source-id="${source.id}"><div class="card-art">${art(source, { size: 240 })}${isNew ? html`<span class="badge badge--new">New</span>` : ""}${cardPlayButton(`Play ${title}`, { action: "play-source", sourceId: source.id, playSource: source.id })}</div><a class="card-link" href="#/album/${enc(source.id)}" title="${title}"><span class="card-title">${title}</span></a>${sub ? html`<span class="card-sub">${sub}</span>` : ""}</article>`;
}

export function artistCard(artist) {
  if (!artist) return raw("");
  const sub = artist.songCount ? pluralize(artist.songCount, "song") : "Artist";
  return html`<a class="artist-tile" href="#/artist/${enc(artist.slug)}" title="${artist.name}"><span class="artist-tile-art">${art(artist, { size: 220, shape: "circle" })}</span><span class="card-title">${artist.name}</span><span class="card-sub">${sub}</span></a>`;
}

export function seriesCard(series) {
  if (!series) return raw("");
  const songs = series.songCount ?? series.trackKeys?.length ?? 0;
  const sessions = series.sourceCount ?? series.sourceIds?.length ?? 0;
  const sub = songs ? pluralize(songs, "song") : pluralize(sessions, "session");
  return html`<a class="series-tile" href="#/series/${enc(series.slug)}" title="${series.name}"><span class="series-tile-art">${art(series, { size: 360 })}</span><span class="series-tile-text"><span class="series-tile-name">${series.name}</span><span class="series-tile-sub">${sub}</span></span></a>`;
}

export function playlistCard(playlist, tracks = []) {
  if (!playlist) return raw("");
  const list = (tracks || []).filter(Boolean);
  const seen = new Set();
  const covers = [];
  for (const track of list) {
    const key = track.sourceId || track.artwork || track.fallbackArtwork;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    covers.push(track);
    if (covers.length === 4) break;
  }
  let cover;
  if (covers.length === 4) cover = html`<span class="mosaic">${covers.map((track) => art(track, { size: 120 }))}</span>`;
  else if (covers.length) cover = art(covers[0], { size: 240 });
  else cover = html`<span class="card-placeholder">${icon("songs", { size: 40 })}</span>`;
  const name = playlist.name || playlist.title || "Playlist";
  const play = list.length
    ? cardPlayButton(`Play ${name}`, { action: "play-playlist", playlistId: playlist.id, playPlaylist: playlist.id })
    : "";
  return html`<article class="card card--playlist" data-playlist-id="${playlist.id}"><div class="card-art">${cover}${play}</div><a class="card-link" href="#/playlist/${enc(playlist.id)}" title="${name}"><span class="card-title">${name}</span></a><span class="card-sub">${list.length ? pluralize(list.length, "song") : "Empty playlist"}</span></article>`;
}

/* ------------------------------------------------------------------ layout blocks */

export function sectionBlock({ title, href, linkLabel = "Show all", body, className = "" } = {}) {
  return html`<section class="${joinClass("section", className)}">${title || href ? html`<div class="section-head">${title ? html`<h2>${title}</h2>` : ""}${href ? html`<a class="section-link" href="${href}">${linkLabel}</a>` : ""}</div>` : ""}${trusted(body)}</section>`;
}

// Accepts an array (or any iterable) of markup, or one pre-joined markup string.
function markupItems(items) {
  if (items === null || items === undefined) return [];
  if (typeof items === "string" || items instanceof String) return [trusted(items)];
  return Array.from(items, trusted);
}

// Prev/next buttons are a mouse convenience (hidden on touch, skipped by Tab; focus scrolls the row anyway).
const SHELF_NAV = raw(`<button class="shelf-nav shelf-nav--prev" type="button" data-shelf-scroll="-1" tabindex="-1" aria-hidden="true">${icon("chevron-left", { size: 20 })}</button><button class="shelf-nav shelf-nav--next" type="button" data-shelf-scroll="1" tabindex="-1" aria-hidden="true">${icon("chevron-right", { size: 20 })}</button>`);

export function shelf(items = []) {
  return html`<div class="shelf-wrap"><div class="shelf">${markupItems(items)}</div>${SHELF_NAV}</div>`;
}

export function grid(items = [], { variant = "cards" } = {}) {
  const variantClass = variant === "artists" ? "grid--artists" : variant === "series" ? "grid--series" : "";
  return html`<div class="${joinClass("grid", variantClass)}">${markupItems(items)}</div>`;
}

export function hero({ artItem = null, shape = "square", kicker = "", title = "", subtitleHtml = "", meta = [], actionsHtml = "" } = {}) {
  const circle = shape === "circle";
  const metaItems = (Array.isArray(meta) ? meta : [meta]).filter((item) => item !== null && item !== undefined && item !== false && String(item).trim() !== "");
  const heroArt = artItem
    ? html`<div class="hero-backdrop" aria-hidden="true">${art(artItem, { size: 160, eager: true })}</div><div class="hero-art">${art(artItem, { size: 320, shape: circle ? "circle" : "square", eager: true })}</div>`
    : "";
  const actions = String(trusted(actionsHtml)).trim() ? html`<div class="actions-row">${trusted(actionsHtml)}</div>` : "";
  return html`<header class="${joinClass("hero", circle && "hero--circle", !artItem && "hero--no-art")}">${heroArt}<div class="hero-text">${kicker ? html`<p class="hero-kicker">${kicker}</p>` : ""}<h1 class="hero-title">${title}</h1>${String(trusted(subtitleHtml)).trim() ? html`<p class="hero-sub">${trusted(subtitleHtml)}</p>` : ""}${metaItems.length ? html`<p class="hero-meta">${metaItems.map((item) => html`<span>${item}</span>`)}</p>` : ""}</div></header>${actions}`;
}

export function playFab({ action = "play", attrs = {}, label = "Play" } = {}) {
  return html`<button class="play-fab" type="button" data-action="${action}"${attributes(attrs)} aria-label="${label}">${icon("play-fill", { size: 26 })}</button>`;
}

/* ------------------------------------------------------------------ track list */

const EQ_BARS = raw('<span class="track-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');

function toKeySet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function trackDuration(track) {
  const duration = Number(track.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const span = Number(track.end) - Number(track.start);
  return Number.isFinite(span) && span > 0 ? span : 0;
}

export function trackList(tracks = [], {
  queueId,
  numbered = true,
  showArt = false,
  showAlbum = false,
  showArtist = true,
  context = { type: "songs", id: "" },
  currentKey = null,
  isPlaying = false,
  likedKeys = new Set(),
  offlineReady = null
} = {}) {
  const liked = toKeySet(likedKeys);
  const contextType = context?.type || "songs";
  const contextId = context?.id ?? "";
  const readyKeys = offlineReady && typeof offlineReady !== "function" ? toKeySet(offlineReady) : null;
  const isReady = typeof offlineReady === "function" ? offlineReady : readyKeys ? (track) => readyKeys.has(track.key) : null;
  const rows = (tracks || []).filter(Boolean).map((track, index) => {
    const title = track.title || "Untitled";
    const current = Boolean(currentKey) && track.key === currentKey;
    const isLiked = liked.has(track.key);
    const sub = joinMeta([showArtist && track.artist, showAlbum && track.sourceTitle]);
    const duration = trackDuration(track);
    const rowClass = joinClass("track", current && "is-current", current && isPlaying && "is-playing");
    return html`<div class="${rowClass}" role="listitem" data-track-key="${track.key}" data-source-id="${track.sourceId}"${isReady?.(track) ? raw(' data-offline-ready=""') : ""}><button class="track-main" type="button" data-action="play-track" data-track-key="${track.key}"${queueId ? html` data-queue-id="${queueId}"` : ""} aria-label="Play ${title}">${numbered ? html`<span class="track-index" aria-hidden="true"><span class="track-num">${index + 1}</span>${EQ_BARS}<span class="track-hover-play">${icon("play-fill", { size: 16 })}</span></span>` : ""}${showArt ? html`<span class="track-art">${art(track, { size: 96 })}${numbered ? "" : EQ_BARS}</span>` : ""}<span class="track-text"><span class="track-title">${title}</span>${sub ? html`<span class="track-sub">${sub}</span>` : ""}</span><span class="track-dur">${duration ? formatTime(duration) : ""}</span></button><button class="${joinClass("icon-btn", "track-like", isLiked && "is-active")}" type="button" data-action="toggle-like" data-like-key="${track.key}" aria-pressed="${isLiked ? "true" : "false"}" aria-label="Like ${title}">${icon(isLiked ? "heart-fill" : "heart", { size: 20 })}</button><button class="icon-btn track-more" type="button" data-action="track-menu" data-track-key="${track.key}" data-context-type="${contextType}" data-context-id="${contextId}" aria-haspopup="menu" aria-label="More options for ${title}">${icon("more", { size: 20 })}</button></div>`;
  });
  const listClass = joinClass("tracks", numbered && "tracks--numbered", showArt && "tracks--art");
  return html`<div class="${listClass}" role="list"${queueId ? html` data-queue-id="${queueId}"` : ""}>${rows}</div>`;
}

/* ------------------------------------------------------------------ small pieces */

// iconName: null leaves the icon out (for pages whose header already shows the same symbol).
export function emptyState({ iconName = "songs", title = "", body = "", actionHtml = "" } = {}) {
  const action = trusted(actionHtml);
  return html`<div class="empty">${iconName ? html`<span class="empty-icon">${icon(iconName, { size: 28 })}</span>` : ""}${title ? html`<h2 class="empty-title">${title}</h2>` : ""}${body ? html`<p class="empty-body">${body}</p>` : ""}${String(action).trim() ? html`<div class="empty-action">${action}</div>` : ""}</div>`;
}

function chipMarkup(item) {
  const cls = joinClass("chip", item.active && "is-active");
  const lead = item.icon ? icon(item.icon, { size: 16 }) : "";
  if (item.href) {
    return html`<a class="${cls}" href="${item.href}"${item.active ? raw(' aria-current="true"') : ""}${attributes(item.attrs)}>${lead}${item.label}</a>`;
  }
  if (item.action) {
    return html`<button class="${cls}" type="button" data-action="${item.action}"${item.value !== undefined && item.value !== null ? html` data-value="${item.value}"` : ""}${attributes(item.attrs)} aria-pressed="${item.active ? "true" : "false"}">${lead}${item.label}</button>`;
  }
  return html`<span class="${cls}"${attributes(item.attrs)}>${lead}${item.label}</span>`;
}

export function chips(items = []) {
  return html`<div class="chips">${(items || []).filter(Boolean).map(chipMarkup)}</div>`;
}

export function skeletonGrid(n = 6) {
  const cards = Array.from({ length: Math.max(0, n) }, () => raw('<div class="card card--skeleton"><div class="card-art skeleton"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text skeleton-text--short"></div></div>'));
  return html`<div class="skeleton-block" aria-busy="true"><span class="sr-only">Loading</span><div class="grid" aria-hidden="true">${cards}</div></div>`;
}

export function skeletonList(n = 8) {
  const rows = Array.from({ length: Math.max(0, n) }, () => raw('<div class="track track--skeleton"><span class="skeleton skeleton-art"></span><span class="track-text"><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text skeleton-text--short"></span></span></div>'));
  return html`<div class="skeleton-block" aria-busy="true"><span class="sr-only">Loading</span><div class="tracks" aria-hidden="true">${rows}</div></div>`;
}

/* ------------------------------------------------------------------ transitions */

function afterTransition(element, done, fallbackMs) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    element.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);
    done();
  };
  const onEnd = (event) => {
    if (event.target === element) finish();
  };
  element.addEventListener("transitionend", onEnd);
  const timer = setTimeout(finish, fallbackMs);
}

/* ------------------------------------------------------------------ toast */

const toastState = new WeakMap();

function toastRegion() {
  let region = document.getElementById("toast-region");
  if (!region) {
    region = document.createElement("div");
    region.id = "toast-region";
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  return region;
}

export function toast(message, { type = "info", actionLabel, onAction, duration = 3600, sticky = false } = {}) {
  if (!hasDom()) return { dismiss() {} };
  const region = toastRegion();
  const text = String(message ?? "");
  const key = `${type}\n${text}\n${actionLabel || ""}`;

  // An identical toast still on screen is refreshed instead of stacking a duplicate.
  for (const element of region.children) {
    const state = toastState.get(element);
    if (state && !state.leaving && state.key === key) {
      state.onAction = onAction;
      state.restart();
      return state.handle;
    }
  }

  const element = document.createElement("div");
  element.className = joinClass("toast", `toast--${type}`);
  const leadIcon = type === "success" ? icon("check", { size: 20, className: "toast-icon" })
    : type === "error" ? icon("alert", { size: 20, className: "toast-icon" })
      : "";
  element.innerHTML = String(html`${leadIcon}<p class="toast-message">${text}</p>${actionLabel ? html`<button class="toast-action" type="button">${actionLabel}</button>` : ""}${sticky ? html`<button class="icon-btn toast-close" type="button" aria-label="Dismiss">${icon("close", { size: 18 })}</button>` : ""}`);

  let timer = 0;
  let remaining = Math.max(1200, Number(duration) || 3600);
  let startedAt = 0;
  const state = {
    key,
    onAction,
    leaving: false,
    handle: null,
    restart() {
      remaining = Math.max(1200, Number(duration) || 3600);
      schedule();
    }
  };

  const clear = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const schedule = () => {
    clear();
    if (sticky || state.leaving) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  const pause = () => {
    if (!timer) return;
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
    clear();
  };

  function dismiss() {
    if (state.leaving) return;
    state.leaving = true;
    clear();
    element.classList.remove("is-visible");
    element.classList.add("is-leaving");
    afterTransition(element, () => element.remove(), reducedMotion() ? 0 : 260);
  }
  state.handle = { dismiss };
  toastState.set(element, state);

  element.addEventListener("click", (event) => {
    if (event.target.closest(".toast-action")) {
      const handler = state.onAction;
      dismiss();
      if (typeof handler === "function") {
        try {
          Promise.resolve(handler()).catch((error) => console.error(error));
        } catch (error) {
          console.error(error);
        }
      }
    } else if (event.target.closest(".toast-close")) {
      dismiss();
    }
  });
  element.addEventListener("pointerenter", pause);
  element.addEventListener("pointerleave", schedule);
  element.addEventListener("focusin", pause);
  element.addEventListener("focusout", schedule);
  enableToastSwipe(element, dismiss);

  region.append(element);
  const live = [...region.children].filter((child) => !toastState.get(child)?.leaving);
  live.slice(0, Math.max(0, live.length - MAX_TOASTS)).forEach((child) => toastState.get(child)?.handle.dismiss());
  void element.offsetHeight; // commit the hidden state so the enter transition runs
  element.classList.add("is-visible");
  schedule();
  return state.handle;
}

function enableToastSwipe(element, dismiss) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let swiping = false;
  let tracking = false;
  element.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || event.target.closest("button")) return;
    tracking = true;
    swiping = false;
    dx = 0;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
  }, { passive: true });
  element.addEventListener("touchmove", (event) => {
    if (!tracking) return;
    const x = event.touches[0].clientX - startX;
    const y = event.touches[0].clientY - startY;
    if (!swiping) {
      if (Math.abs(y) > Math.abs(x) && Math.abs(y) > 8) {
        tracking = false;
        return;
      }
      if (Math.abs(x) < 8) return;
      swiping = true;
      element.style.transition = "none";
    }
    dx = x;
    element.style.transform = `translateX(${dx}px)`;
    element.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 220));
  }, { passive: true });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!swiping) return;
    element.style.transition = "";
    if (Math.abs(dx) > 80) {
      element.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`;
      element.style.opacity = "0";
      dismiss();
    } else {
      element.style.transform = "";
      element.style.opacity = "";
    }
  };
  element.addEventListener("touchend", end);
  element.addEventListener("touchcancel", end);
}

/* ------------------------------------------------------------------ dialogs */

const pendingDialogs = new WeakMap();

function openDialog(dialog, read, onOpen) {
  if (dialog.open) {
    pendingDialogs.get(dialog)?.();
    dialog.close("cancel");
  }
  return new Promise((resolve) => {
    const settle = (value) => {
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onClick);
      pendingDialogs.delete(dialog);
      resolve(value);
    };
    // A close event queued by a previous request can arrive after this dialog re-opened: ignore it.
    const onClose = () => {
      if (!dialog.open) settle(read(dialog.returnValue));
    };
    const onClick = (event) => {
      if (event.target.closest?.("[data-dialog-close]")) dialog.close("cancel");
    };
    pendingDialogs.set(dialog, () => settle(read("cancel")));
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("click", onClick);
    dialog.returnValue = "";
    dialog.showModal();
    onOpen?.();
  });
}

export function confirmDialog({ title = "Are you sure?", body = "", confirmLabel = "Continue", danger = false } = {}) {
  if (!hasDom()) return Promise.resolve(false);
  const dialog = document.getElementById("dialog-confirm");
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm([title, body].filter(Boolean).join("\n\n")));
  }
  const heading = dialog.querySelector(".dialog-title");
  const text = dialog.querySelector(".dialog-text");
  const confirm = dialog.querySelector("[data-dialog-confirm]");
  const cancel = dialog.querySelector("[data-dialog-cancel]");
  if (heading) heading.textContent = title || "Are you sure?";
  if (text) {
    text.textContent = body || "";
    text.hidden = !body;
  }
  if (confirm) {
    confirm.textContent = confirmLabel || "Continue";
    confirm.className = joinClass("btn", danger ? "btn-danger" : "btn-primary");
  }
  return openDialog(dialog, (value) => value === "confirm", () => {
    // Destructive actions start on Cancel so a stray Enter never deletes anything.
    (danger ? cancel : confirm)?.focus();
  });
}

export function promptDialog({ title = "", label = "", value = "", placeholder = "", confirmLabel = "Save" } = {}) {
  if (!hasDom()) return Promise.resolve(null);
  const dialog = document.getElementById("dialog-prompt");
  if (!dialog || typeof dialog.showModal !== "function") {
    const answer = window.prompt(label || title, value);
    return Promise.resolve(answer === null ? null : answer.trim());
  }
  const heading = dialog.querySelector(".dialog-title");
  const labelEl = dialog.querySelector(".field-label");
  const input = dialog.querySelector("input[name='value']") || dialog.querySelector("input");
  const confirm = dialog.querySelector("[data-dialog-confirm]");
  if (heading) heading.textContent = title || label || "";
  if (labelEl) {
    labelEl.textContent = label || "";
    labelEl.hidden = !label;
  }
  if (input) {
    input.value = value ?? "";
    input.placeholder = placeholder || "";
    input.setAttribute("aria-label", label || title || "Value");
  }
  if (confirm) confirm.textContent = confirmLabel || "Save";
  return openDialog(dialog, (result) => (result === "confirm" && input ? input.value.trim() : null), () => {
    if (!input) return;
    input.focus();
    input.select();
  });
}

/* ------------------------------------------------------------------ action sheet */

let activeSheet = null;
let sheetSeq = 0;

function sheetItemMarkup(item, index, withIcons) {
  const checkable = typeof item.checked === "boolean";
  const lead = item.icon ? icon(item.icon, { size: 22 }) : withIcons ? raw('<span class="sheet-item-spacer"></span>') : "";
  return html`<button class="${joinClass("sheet-item", item.danger && "is-danger")}" type="button" role="${checkable ? "menuitemcheckbox" : "menuitem"}" data-index="${index}"${checkable ? html` aria-checked="${item.checked ? "true" : "false"}"` : ""}${item.disabled ? raw(" disabled") : ""}>${lead}<span class="sheet-item-label">${item.label}</span>${item.checked ? html`<span class="sheet-item-check">${icon("check", { size: 20 })}</span>` : ""}</button>`;
}

function sheetMarkup({ id, title, subtitle, artItem, list }) {
  const withIcons = list.some((item) => item.icon);
  const labelled = title ? html` aria-labelledby="${id}-title"` : raw(' aria-label="Options"');
  const header = title || subtitle || artItem
    ? html`<div class="sheet-header">${artItem ? html`<span class="sheet-art">${art(artItem, { size: 96, eager: true })}</span>` : ""}<div class="sheet-heading">${title ? html`<p class="sheet-title" id="${id}-title">${title}</p>` : ""}${subtitle ? html`<p class="sheet-subtitle">${subtitle}</p>` : ""}</div></div>`
    : "";
  return html`<div class="sheet-backdrop"></div><div class="sheet" role="dialog" aria-modal="true"${labelled} tabindex="-1"><div class="sheet-handle" aria-hidden="true"></div>${header}<div class="sheet-items" role="menu"${labelled}>${list.map((item, index) => sheetItemMarkup(item, index, withIcons))}</div><button class="sheet-close" type="button">Close</button></div>`;
}

// The column the anchor lives in (content, now-playing panel, player bar), so a menu opened near the
// sidebar never spills over it. Anything else is bounded by the viewport.
const POPOVER_COLUMNS = "#main, #now-playing, #player-bar, .sheet";

function popoverBounds(anchor, vw) {
  const column = anchor.closest?.(POPOVER_COLUMNS)?.getBoundingClientRect();
  if (!column || column.width <= 0) return { left: 0, right: vw };
  return { left: Math.max(0, column.left), right: Math.min(vw, column.right) };
}

function positionPopover(panel, anchor) {
  const margin = 8;
  const gap = 4;
  const rect = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  panel.style.maxHeight = `${Math.max(160, vh - margin * 2)}px`;
  // Layout size, not getBoundingClientRect: the panel starts scaled down for its entrance.
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const bounds = popoverBounds(anchor, vw);
  const minLeft = bounds.left + margin;
  const maxLeft = Math.max(minLeft, bounds.right - width - margin);
  // Hang from the anchor's right edge when that fits the column, else open rightwards from its left edge.
  let left = rect.right - width >= minLeft ? rect.right - width : rect.left;
  left = Math.min(Math.max(minLeft, left), maxLeft);
  // A column narrower than the menu still must not push it off screen.
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - width - margin));
  let top = rect.bottom + gap;
  let originY = "top";
  if (top + height > vh - margin) {
    const above = rect.top - gap - height;
    if (above >= margin) {
      top = above;
      originY = "bottom";
    } else {
      top = Math.max(margin, vh - height - margin);
    }
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  const originX = rect.left + rect.width / 2 - left > width / 2 ? "right" : "left";
  panel.style.transformOrigin = `${originX} ${originY}`;
}

function enableSheetDrag(panel, itemsEl, backdrop, dismiss) {
  let startY = 0;
  let dy = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let tracking = false;
  let dragging = false;
  let fromItems = false;

  panel.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }
    tracking = true;
    dragging = false;
    dy = 0;
    velocity = 0;
    startY = lastY = event.touches[0].clientY;
    lastT = event.timeStamp;
    fromItems = Boolean(itemsEl?.contains(event.target));
  }, { passive: true });

  panel.addEventListener("touchmove", (event) => {
    if (!tracking) return;
    const y = event.touches[0].clientY;
    if (!dragging) {
      const delta = y - startY;
      // Upward moves and moves inside a scrolled list belong to the list, not the sheet.
      if (delta < -6 || (fromItems && itemsEl.scrollTop > 0)) {
        tracking = false;
        return;
      }
      if (delta < 6) return;
      dragging = true;
      startY = y;
      panel.style.transition = "none";
      backdrop.style.transition = "none";
    }
    event.preventDefault();
    dy = Math.max(0, y - startY);
    const dt = Math.max(1, event.timeStamp - lastT);
    velocity = (y - lastY) / dt;
    lastY = y;
    lastT = event.timeStamp;
    panel.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 - dy / Math.max(1, panel.offsetHeight)));
  }, { passive: false });

  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    panel.style.transition = "";
    backdrop.style.transition = "";
    backdrop.style.opacity = "";
    if (dy > Math.min(140, panel.offsetHeight * 0.3) || velocity > 0.55) {
      dismiss();
    } else {
      panel.style.transform = "";
    }
  };
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}

export function actionSheet({ title = "", subtitle = "", artItem = null, items = [], anchor = null } = {}) {
  if (!hasDom()) return Promise.resolve(null);
  activeSheet?.close(null, { immediate: true });

  const list = (items || []).filter((item) => item && !item.hidden);
  const root = document.getElementById("sheet-root") || document.body;
  const popover = Boolean(anchor?.isConnected && window.matchMedia?.(POPOVER_QUERY).matches);
  const id = `sheet-${++sheetSeq}`;
  const layer = document.createElement("div");
  layer.className = joinClass("sheet-layer", popover ? "sheet-layer--popover" : "sheet-layer--sheet");
  layer.innerHTML = String(sheetMarkup({ id, title, subtitle, artItem, list }));
  root.append(layer);

  const panel = layer.querySelector(".sheet");
  const backdrop = layer.querySelector(".sheet-backdrop");
  const itemsEl = layer.querySelector(".sheet-items");
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : anchor;
  const app = document.getElementById("app");
  const madeInert = Boolean(app && !app.inert);
  if (madeInert) app.inert = true;
  // The button that opened the menu reports it (and CSS keeps it and its row highlighted, since the
  // inert page loses :hover while the menu is up).
  const expander = anchor instanceof Element && anchor.isConnected ? anchor : null;
  const wasExpanded = expander?.getAttribute("aria-expanded") ?? null;
  expander?.setAttribute("aria-expanded", "true");

  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  let closed = false;

  const focusables = () => [...panel.querySelectorAll(".sheet-item:not(:disabled), .sheet-close")]
    .filter((element) => element.getClientRects().length > 0);
  const menuItems = () => [...panel.querySelectorAll(".sheet-item:not(:disabled)")];

  function close(selected = null, { immediate = false } = {}) {
    if (closed) return;
    closed = true;
    if (activeSheet === controller) activeSheet = null;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("hashchange", onHashChange);
    document.removeEventListener("scroll", onScroll, true);
    if (madeInert) app.inert = false;
    if (expander) {
      if (wasExpanded !== null || expander.hasAttribute("aria-haspopup")) expander.setAttribute("aria-expanded", "false");
      else expander.removeAttribute("aria-expanded");
    }
    const active = document.activeElement;
    if (opener?.isConnected && (!active || active === document.body || layer.contains(active))) {
      opener.focus({ preventScroll: true });
    }
    const finish = () => {
      layer.remove();
      resolvePromise(selected);
    };
    if (immediate || reducedMotion()) {
      finish();
      return;
    }
    layer.classList.remove("is-open");
    layer.classList.add("is-closing");
    panel.style.transform = "";
    afterTransition(panel, finish, popover ? 200 : 360);
  }

  const controller = { close };
  activeSheet = controller;

  function select(item) {
    close(item);
    if (typeof item.onSelect !== "function") return;
    try {
      Promise.resolve(item.onSelect(item)).catch((error) => console.error(error));
    } catch (error) {
      console.error(error);
    }
  }

  function moveFocus(step) {
    const entries = menuItems();
    if (!entries.length) return;
    const index = entries.indexOf(document.activeElement);
    const next = index === -1 ? (step > 0 ? 0 : entries.length - 1) : (index + step + entries.length) % entries.length;
    entries[next].focus();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(null);
    } else if (event.key === "Tab") {
      const entries = focusables();
      if (!entries.length) {
        event.preventDefault();
        return;
      }
      const index = entries.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? entries.length - 1 : index - 1)
        : (index === -1 || index === entries.length - 1 ? 0 : index + 1);
      event.preventDefault();
      entries[next].focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      const entries = menuItems();
      if (!entries.length) return;
      event.preventDefault();
      entries[event.key === "Home" ? 0 : entries.length - 1].focus();
    }
  }

  function onViewportChange() {
    if (popover) close(null, { immediate: true });
  }
  function onScroll(event) {
    if (popover && !panel.contains(event.target)) close(null, { immediate: true });
  }
  function onHashChange() {
    close(null, { immediate: true });
  }

  layer.addEventListener("click", (event) => {
    const button = event.target.closest(".sheet-item");
    if (button) {
      if (!button.disabled) select(list[Number(button.dataset.index)]);
      return;
    }
    if (event.target === backdrop || event.target.closest(".sheet-close")) close(null);
  });
  // Right-click on the dimmed backdrop should dismiss rather than open the browser menu over it.
  backdrop.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    close(null);
  });
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("scroll", onScroll, true);
  if (!popover) enableSheetDrag(panel, itemsEl, backdrop, () => close(null));

  if (popover) positionPopover(panel, anchor);
  void panel.offsetHeight; // commit the closed state so the open transition runs
  layer.classList.add("is-open");
  // Popovers put focus on the first item (menu convention); touch sheets focus the sheet itself.
  const first = popover ? menuItems()[0] || panel : panel;
  first.focus({ preventScroll: true });
  return promise;
}

/* ------------------------------------------------------------------ global wiring */

let uiInitialized = false;
let dialogPointerTarget = null;
let shelfFrame = 0;
const pendingShelves = new Set();

function updateShelfEdges(row) {
  const wrap = row?.parentElement;
  if (!wrap?.classList.contains("shelf-wrap")) return;
  const max = row.scrollWidth - row.clientWidth;
  wrap.dataset.start = String(row.scrollLeft <= 4);
  wrap.dataset.end = String(row.scrollLeft >= max - 4);
}

function onShelfScroll(event) {
  const row = event.target;
  if (!(row instanceof Element) || !row.classList.contains("shelf")) return;
  pendingShelves.add(row);
  if (shelfFrame) return;
  shelfFrame = requestAnimationFrame(() => {
    shelfFrame = 0;
    pendingShelves.forEach(updateShelfEdges);
    pendingShelves.clear();
  });
}

function onShelfPointerOver(event) {
  const wrap = event.target instanceof Element ? event.target.closest(".shelf-wrap") : null;
  if (wrap && !wrap.contains(event.relatedTarget)) updateShelfEdges(wrap.querySelector(":scope > .shelf"));
}

// Icon-only controls show their accessible name as a tooltip for mouse users. The title is copied from
// aria-label while the pointer is over the control, so labels app.js rewrites in place (Play ↔ Pause,
// Download ↔ Remove download, Mute ↔ Unmute) are never stale. A title written in the markup always wins.
const TOOLTIP_TARGETS = ".icon-btn[aria-label], .play-fab[aria-label], .card-play[aria-label], .np-btn[aria-label]";
const autoTitled = new WeakSet();

function onTooltipPointerMove(event) {
  if (event.pointerType && event.pointerType !== "mouse") return;
  const target = event.target instanceof Element ? event.target.closest(TOOLTIP_TARGETS) : null;
  if (!target || (target.hasAttribute("title") && !autoTitled.has(target))) return;
  const label = target.getAttribute("aria-label")?.trim();
  if (!label) return;
  if (target.getAttribute("title") !== label) target.setAttribute("title", label);
  autoTitled.add(target);
}

function onDocumentPointerDown(event) {
  dialogPointerTarget = event.target;
}

function onDocumentClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const shelfButton = target.closest("[data-shelf-scroll]");
  if (shelfButton) {
    const row = shelfButton.parentElement?.querySelector(":scope > .shelf");
    if (row) row.scrollBy({ left: Number(shelfButton.dataset.shelfScroll) * row.clientWidth * 0.85, behavior: reducedMotion() ? "auto" : "smooth" });
    return;
  }
  const closer = target.closest("[data-dialog-close]");
  if (closer) {
    const dialog = closer.closest("dialog");
    if (dialog?.open) {
      event.preventDefault();
      dialog.close("cancel");
    }
    return;
  }
  // Clicks on the ::backdrop target the <dialog> itself; the form inside fills the whole box.
  if (typeof HTMLDialogElement !== "undefined" && target instanceof HTMLDialogElement && target.open
    && target.classList.contains("dialog") && dialogPointerTarget === target) {
    const rect = target.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) target.close("cancel");
  }
}

export function initUI() {
  if (uiInitialized || !hasDom()) return;
  uiInitialized = true;
  document.addEventListener("load", onArtLoad, true);
  document.addEventListener("error", onArtError, true);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("scroll", onShelfScroll, { capture: true, passive: true });
  document.addEventListener("pointerover", onShelfPointerOver, { passive: true });
  document.addEventListener("pointermove", onTooltipPointerMove, { passive: true });
  window.addEventListener("online", () => failedArt.clear());
  document.querySelectorAll("img.art").forEach(settleExistingArt);
  document.documentElement.classList.add("ui-ready");
}
