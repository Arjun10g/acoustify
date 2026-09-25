// Now-playing surfaces: the mobile mini player + full-screen sheet, and the
// desktop player bar + right panel. The DOM is built once in mount(); player
// events only patch the nodes whose values actually changed, and progress is
// painted from a requestAnimationFrame loop with transforms only.
import { icon } from "./icons.js";
import { art, toast } from "./ui.js";
import { clamp, escapeHtml, formatTime, slugify } from "./utils.js";

const DESKTOP_QUERY = "(min-width: 1024px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const PANEL_PREF_KEY = "acoustify:now-playing-panel";
const TINT_STORE_KEY = "acoustify:artwork-tints";
const TINT_STORE_LIMIT = 240;
const HISTORY_MARKER = "acoustifyNowPlaying";
const EASE_OUT = "cubic-bezier(.2,.8,.2,1)";
const SHEET_MS = 280;
const QUEUE_LIMIT = 200;
const FLIP_LIMIT = 60;
const SEEK_HOLD_MS = 1500;
const NEUTRAL_RGB = [58, 58, 66];
const MINUS = "−";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

// iOS-style resistance: grows quickly at first, then asymptotically to `limit`.
export function rubberBand(distance, limit = 120, coefficient = 0.55) {
  const value = Math.max(0, Number(distance) || 0);
  return (1 - 1 / ((value * coefficient) / limit + 1)) * limit;
}

// Pointer velocity in px/ms (positive = downward) over the last ~100 ms, so a
// finger that pauses before lifting reads as zero rather than its old speed.
export function releaseVelocity(samples, now, windowMs = 100) {
  const recent = samples.filter((sample) => now - sample.t <= windowMs);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

export function shouldDismiss({ offset, velocity, height }) {
  if (!(offset > 0)) return false;
  if (velocity >= 0.5) return true;
  if (velocity <= -0.25) return false;
  return offset >= Math.min(height * 0.25, 220);
}

// Remaining time counts down in step with the elapsed clock and always adds up
// to the total shown elsewhere (floor(duration)).
export function remainingSeconds(elapsed, duration) {
  return Math.max(0, Math.floor(Number(duration) || 0) - Math.floor(Number(elapsed) || 0));
}

export function artistsForTrack(track, source) {
  const lists = [track?.artists, source?.artists];
  const names = lists.find((list) => Array.isArray(list) && list.length)
    || [track?.artist || source?.artist].filter(Boolean);
  const slugs = Array.isArray(track?.artistSlugs) && track.artistSlugs.length === names.length ? track.artistSlugs : null;
  return names.map((name, index) => ({ name: String(name), slug: slugs?.[index] || slugify(name) }));
}

// Splits a display credit ("Tyler Childers & Chris Stapleton") into text and
// linkable artist segments so the "&" and ordering of the credit survive.
export function creditSegments(credit, artists = []) {
  const text = String(credit || "").trim();
  const named = artists.filter((artist) => artist?.name && artist?.slug);
  const joined = () => named.flatMap((artist, index) => (index ? [{ text: ", " }] : []).concat({ text: artist.name, slug: artist.slug }));
  if (!text) return joined();
  const lower = text.toLowerCase();
  const caseSafe = lower.length === text.length;
  const haystack = caseSafe ? lower : text;
  const segments = [];
  let cursor = 0;
  for (const artist of named) {
    const needle = caseSafe ? artist.name.toLowerCase() : artist.name;
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) continue;
    if (at > cursor) segments.push({ text: text.slice(cursor, at) });
    segments.push({ text: text.slice(at, at + needle.length), slug: artist.slug });
    cursor = at + needle.length;
  }
  if (!segments.some((segment) => segment.slug)) return named.length ? joined() : [{ text }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

export function creditHtml(credit, artists) {
  return creditSegments(credit, artists).map((segment) => (segment.slug
    ? `<a href="#/artist/${encodeURIComponent(segment.slug)}">${escapeHtml(segment.text)}</a>`
    : escapeHtml(segment.text))).join("");
}

function rgbToHsl(r, g, b) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l].map((value) => Math.round(value * 255));
  const channel = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [channel(p, q, h + 1 / 3), channel(p, q, h), channel(p, q, h - 1 / 3)].map((value) => Math.round(value * 255));
}

// Saturation-weighted mean: colourful mid-tones carry the artwork's mood,
// while black borders, white text and grey stage floors mostly do not.
export function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    if (data[index + 3] < 128) continue;
    const pr = data[index];
    const pg = data[index + 1];
    const pb = data[index + 2];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const chroma = (max - min) / 255;
    const light = (max + min) / 510;
    const weight = 0.06 + chroma * chroma * 4 * (1 - Math.abs(light - 0.5));
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
    total += weight;
  }
  return total ? [r / total, g / total, b / total].map(Math.round) : null;
}

function relativeLuminance([r, g, b]) {
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// Keeps the artwork's hue but darkens until white clears `minContrast`, so
// the 68%-white secondary text still passes AA; bright hues like yellow need
// a lower lightness than blue does. Saturation is tamed so neon art stays calm.
function darkTone(h, s, lightness, minContrast) {
  let l = lightness;
  let rgb = hslToRgb(h, s, l);
  while (l > 0.06 && 1.05 / (relativeLuminance(rgb) + 0.05) < minContrast) {
    l -= 0.01;
    rgb = hslToRgb(h, s, l);
  }
  return rgb;
}

export function tintFromRgb(rgb) {
  const [r, g, b] = Array.isArray(rgb) && rgb.length === 3 ? rgb : NEUTRAL_RGB;
  const [h, s] = rgbToHsl(r, g, b);
  const sat = Math.min(s, 0.52);
  const top = darkTone(h, sat, 0.25, 8);
  const deep = darkTone(h, sat * 0.8, 0.15, 11);
  const hex = (channels) => `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return { top: `rgb(${top.join(" ")})`, deep: `rgb(${deep.join(" ")})`, topHex: hex(top) };
}

function formatListLength(count, seconds) {
  const songs = `${count} ${count === 1 ? "song" : "songs"}`;
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes < 1) return songs;
  if (minutes < 60) return `${songs} · ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${songs} · ${hours} hr${rest ? ` ${rest} min` : ""}`;
}

function trackDuration(track) {
  if (!track) return 0;
  const span = Number(track.end) - Number(track.start);
  return Number.isFinite(span) ? Math.max(0, span) : Math.max(0, Number(track.duration) || 0);
}

function albumHref(sourceId) {
  return sourceId ? `#/album/${encodeURIComponent(sourceId)}` : "#/library";
}

function safely(task) {
  try {
    const result = task();
    if (result && typeof result.catch === "function") {
      result.catch((error) => console.debug("Now playing action failed.", error));
    }
  } catch (error) {
    console.debug("Now playing action failed.", error);
  }
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

function setAttr(node, name, value) {
  if (!node) return;
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const text = value === true ? "" : String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

// The accessible name and the desktop tooltip always say the same thing.
function setLabel(node, label) {
  setAttr(node, "aria-label", label);
  if (node?.hasAttribute("title")) setAttr(node, "title", label);
}

// Swaps an icon only when it changes. Reads the sprite <use> so it stays in
// sync even when the controller rewrote the icon itself (like buttons).
function setIcon(host, name, size) {
  if (!host) return;
  const use = host.querySelector("use");
  const current = use ? (use.getAttribute("href") || use.getAttribute("xlink:href") || "").replace(/^#i-/, "") : host.dataset.icon;
  if (current === name) return;
  host.dataset.icon = name;
  host.innerHTML = icon(name, { size: Number(size || host.dataset.iconSize) || 24 });
}

// iOS and iPadOS leave media volume to the hardware buttons: an element's
// volume can't be set there (it always reads back 1), so a slider would do nothing.
function mediaVolumeIsLocked() {
  try {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) > 0.01;
  } catch {
    return false;
  }
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch { /* storage unavailable: preference just isn't remembered */ }
}

// ---------------------------------------------------------------------------
// Artwork tint sampling (fetch → createImageBitmap → tiny canvas), cached per
// artwork URL in memory and, best effort, across launches.

const tintMemory = new Map();
let tintStore = null;

function loadTintStore() {
  if (tintStore) return tintStore;
  tintStore = new Map();
  try {
    const parsed = JSON.parse(readStorage(TINT_STORE_KEY) || "[]");
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) tintStore.set(entry[0], entry[1]);
      }
    }
  } catch { /* corrupt cache: start fresh */ }
  return tintStore;
}

function rememberTint(url, rgb) {
  const store = loadTintStore();
  store.delete(url);
  store.set(url, rgb);
  while (store.size > TINT_STORE_LIMIT) store.delete(store.keys().next().value);
  writeStorage(TINT_STORE_KEY, JSON.stringify([...store]));
}

async function sampleArtwork(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`Artwork request failed (${response.status})`);
  const blob = await response.blob();
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { resizeWidth: 24, resizeHeight: 24, resizeQuality: "medium" });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const size = 24;
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement("canvas"), { width: size, height: size });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, size, size);
  bitmap.close?.();
  return averageColor(context.getImageData(0, 0, size, size).data);
}

function artworkTint(urls) {
  const candidates = urls.filter((url) => url && !/\/assets\/icons\//.test(url));
  const key = candidates[0];
  if (!key) return Promise.resolve(null);
  const stored = loadTintStore().get(key);
  if (stored) return Promise.resolve(stored);
  if (tintMemory.has(key)) return tintMemory.get(key);
  const job = (async () => {
    for (const url of candidates) {
      try {
        const rgb = await sampleArtwork(url);
        if (rgb) {
          rememberTint(key, rgb);
          return rgb;
        }
      } catch (error) {
        console.debug("Artwork colour sampling skipped.", error);
      }
    }
    return null;
  })();
  tintMemory.set(key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Artwork slot: crossfades to a new image only once it has decoded, walks the
// artwork → fallbackArtwork chain, and ends on a calm placeholder.

// Every surface frames artwork the same way: a square, cropped to cover,
// exactly like the album hero, cards and queue thumbnails.
class ArtSlot {
  constructor(host, { iconSize = 24 } = {}) {
    this.host = host;
    this.iconSize = iconSize;
    this.key = null;
    this.token = 0;
    this.#placeholder();
  }

  set(item) {
    const urls = [...new Set([item?.artwork, item?.fallbackArtwork].filter(Boolean))];
    const key = urls.join("\n");
    if (key === this.key) return;
    this.key = key;
    const token = ++this.token;
    if (!urls.length) {
      this.#placeholder();
      return;
    }
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    img.className = "np-img";
    let index = 0;
    const attempt = () => {
      if (token !== this.token) return;
      if (index >= urls.length) {
        this.#placeholder();
        return;
      }
      img.src = urls[index];
      index += 1;
      img.decode().then(() => {
        if (token === this.token) this.#show(img);
      }, attempt);
    };
    attempt();
  }

  #placeholder() {
    const only = this.host.children.length === 1 ? this.host.firstElementChild : null;
    if (only?.classList.contains("np-art-ph")) return;
    const node = document.createElement("span");
    node.className = "np-art-ph";
    node.innerHTML = icon("disc", { size: this.iconSize });
    this.#show(node);
  }

  #show(node) {
    const previous = [...this.host.children].filter((child) => child !== node);
    node.classList.add("is-entering");
    this.host.append(node);
    void node.offsetWidth;
    node.classList.remove("is-entering");
    if (previous.length) setTimeout(() => previous.forEach((child) => child.remove()), 260);
  }
}

// ---------------------------------------------------------------------------
// Pointer slider used for the scrubbers and the volume control. It paints with
// transforms only and owns its own drag state, so a playback tick can never
// yank the thumb from under a finger.

class Slider {
  constructor(host, { label, onPreview, onCommit, onEnd, describe, bubble = false, wheel = false, keyStep = () => 0.05 } = {}) {
    this.host = host;
    this.onPreview = onPreview;
    this.onCommit = onCommit;
    this.onEnd = onEnd;
    this.describe = describe;
    this.keyStep = keyStep;
    this.value = 0;
    this.dragValue = 0;
    this.dragging = false;
    this.pointerId = null;
    this.rect = null;
    this.disabled = false;
    host.classList.add("np-slider");
    host.setAttribute("role", "slider");
    host.setAttribute("tabindex", "0");
    host.setAttribute("aria-label", label);
    host.setAttribute("aria-valuemin", "0");
    host.innerHTML = `
      <span class="np-slider-track"><span class="np-slider-fill"></span></span>
      <span class="np-slider-rail"><span class="np-slider-thumb"></span></span>
      ${bubble ? '<span class="np-slider-bubble" aria-hidden="true"></span>' : ""}`;
    this.track = host.querySelector(".np-slider-track");
    this.fill = host.querySelector(".np-slider-fill");
    this.rail = host.querySelector(".np-slider-rail");
    this.bubble = host.querySelector(".np-slider-bubble");
    host.addEventListener("pointerdown", (event) => this.#down(event));
    host.addEventListener("pointermove", (event) => this.#move(event));
    host.addEventListener("pointerup", (event) => this.#up(event));
    host.addEventListener("pointercancel", () => this.#cancel());
    // Capture moving here from the touched child fires a bubbling
    // lostpointercapture on that child; only our own loss ends a drag.
    host.addEventListener("lostpointercapture", (event) => {
      if (event.target === host) this.#cancel();
    });
    host.addEventListener("keydown", (event) => this.#key(event));
    if (wheel) host.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    this.#paint(0);
  }

  set(fraction) {
    this.value = clamp(Number(fraction) || 0, 0, 1);
    if (!this.dragging) this.#paint(this.value);
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    setAttr(this.host, "aria-disabled", this.disabled ? "true" : null);
    setAttr(this.host, "tabindex", this.disabled ? "-1" : "0");
    if (this.disabled && this.dragging) this.#cancel();
  }

  syncAria() {
    const info = this.describe?.(this.dragging ? this.dragValue : this.value);
    if (!info) return;
    setAttr(this.host, "aria-valuemax", info.max);
    setAttr(this.host, "aria-valuenow", info.now);
    setAttr(this.host, "aria-valuetext", info.text);
  }

  #fractionAt(clientX) {
    const rect = this.rect || this.track.getBoundingClientRect();
    return rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
  }

  #paint(fraction) {
    this.fill.style.transform = `scaleX(${fraction})`;
    this.rail.style.transform = `translateX(${(fraction - 1) * 100}%)`;
  }

  #placeBubble(fraction, text) {
    if (!this.bubble) return;
    const width = (this.rect || this.track.getBoundingClientRect()).width;
    this.bubble.textContent = text;
    this.bubble.style.transform = `translateX(${Math.round(fraction * width)}px) translateX(-50%)`;
  }

  #preview(fraction) {
    this.dragValue = fraction;
    this.#paint(fraction);
    const text = this.onPreview?.(fraction);
    if (text) this.#placeBubble(fraction, text);
    this.syncAria();
  }

  #down(event) {
    if (this.disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    this.host.focus({ preventScroll: true });
    try {
      this.host.setPointerCapture(event.pointerId);
    } catch { /* pointer already gone */ }
    this.pointerId = event.pointerId;
    this.rect = this.track.getBoundingClientRect();
    this.dragging = true;
    this.host.classList.add("is-dragging");
    this.#preview(this.#fractionAt(event.clientX));
  }

  #move(event) {
    if (this.dragging && event.pointerId === this.pointerId) this.#preview(this.#fractionAt(event.clientX));
  }

  #up(event) {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const fraction = this.#fractionAt(event.clientX);
    this.#finish();
    this.value = fraction;
    this.#paint(fraction);
    this.onCommit?.(fraction);
    this.onEnd?.();
  }

  #cancel() {
    if (!this.dragging) return;
    this.#finish();
    this.#paint(this.value);
    this.onEnd?.();
  }

  #finish() {
    this.dragging = false;
    this.pointerId = null;
    this.rect = null;
    this.host.classList.remove("is-dragging");
  }

  #key(event) {
    if (this.disabled) return;
    const step = this.keyStep();
    const targets = {
      ArrowRight: this.value + step,
      ArrowUp: this.value + step,
      ArrowLeft: this.value - step,
      ArrowDown: this.value - step,
      PageUp: this.value + 0.1,
      PageDown: this.value - 0.1,
      Home: 0,
      End: 1
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    event.stopPropagation();
    const fraction = clamp(targets[event.key], 0, 1);
    this.value = fraction;
    this.#paint(fraction);
    this.onCommit?.(fraction);
    this.syncAria();
  }

  #wheel(event) {
    if (this.disabled) return;
    event.preventDefault();
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? -event.deltaY : event.deltaX;
    if (!delta) return;
    const fraction = clamp(this.value + Math.sign(delta) * 0.05, 0, 1);
    this.value = fraction;
    this.#paint(fraction);
    this.onCommit?.(fraction);
    this.syncAria();
  }
}

// ---------------------------------------------------------------------------
// Markup (built once)

function playButton(className, iconSize) {
  return `
    <button class="np-play ${className}" type="button" data-np="play" aria-label="Play" title="Play" disabled>
      <span class="np-ic" data-icon-size="${iconSize}">${icon("play-fill", { size: iconSize })}</span>
      <svg class="np-spinner" viewBox="0 0 50 50" aria-hidden="true"><circle cx="25" cy="25" r="23"></circle></svg>
    </button>`;
}

// Icon-only controls carry a tooltip matching their label (see setLabel).
function iconButton({ className = "", np = "", label, name, size = 24, extra = "" }) {
  const text = escapeHtml(label);
  return `<button class="np-btn ${className}" type="button"${np ? ` data-np="${np}"` : ""} aria-label="${text}" title="${text}" data-icon-size="${size}"${extra ? ` ${extra}` : ""}>${icon(name, { size })}</button>`;
}

function barMarkup() {
  return `
    <div class="pb">
      <button class="pb-open" type="button" data-np="open" aria-label="Open now playing"></button>
      <div class="pb-now">
        <button class="pb-art" type="button" data-np="open" aria-label="Show now playing view"><span class="np-artbox" data-ref="barArt"></span></button>
        <div class="pb-text">
          <a class="pb-title" data-ref="barTitle" href="#/library">Nothing playing</a>
          <div class="pb-sub" data-ref="barArtists">Pick a song to start listening</div>
        </div>
        ${iconButton({ className: "np-like pb-like", label: "Like", name: "heart", size: 18, extra: 'data-action="toggle-like" data-like-key="" aria-pressed="false"' })}
      </div>
      <div class="pb-center">
        <div class="pb-transport">
          ${iconButton({ className: "np-toggle pb-shuffle", np: "shuffle", label: "Shuffle", name: "shuffle", size: 18, extra: 'aria-pressed="false"' })}
          ${iconButton({ className: "np-skip pb-prev", np: "prev", label: "Previous", name: "prev", size: 20 })}
          ${playButton("pb-play", 18)}
          ${iconButton({ className: "np-skip pb-next", np: "next", label: "Next", name: "next", size: 20 })}
          ${iconButton({ className: "np-toggle pb-repeat", np: "repeat", label: "Repeat off", name: "repeat", size: 18, extra: 'aria-pressed="false"' })}
        </div>
        <div class="pb-scrub">
          <span class="np-time pb-elapsed" data-ref="barElapsed">0:00</span>
          <div class="pb-slider" data-ref="barSlider"></div>
          <span class="np-time pb-total" data-ref="barTotal">0:00</span>
        </div>
      </div>
      <div class="pb-extras">
        ${iconButton({ className: "np-toggle pb-panel", np: "panel", label: "Now playing view", name: "queue", size: 18, extra: 'aria-pressed="false"' })}
        <div class="pb-volume">
          ${iconButton({ className: "pb-mute", np: "mute", label: "Mute", name: "volume", size: 18 })}
          <div class="pb-vol-slider" data-ref="volSlider"></div>
        </div>
      </div>
      <div class="pb-line" aria-hidden="true"><span class="pb-line-fill" data-ref="lineFill"></span></div>
    </div>`;
}

function sheetMarkup() {
  return `
    <div class="np-backdrop" data-np="close" aria-hidden="true"></div>
    <div class="np-sheet" data-ref="sheet" aria-label="Now playing" tabindex="-1">
      <div class="np-bg" aria-hidden="true"></div>
      <div class="np-grabber" aria-hidden="true"></div>
      <header class="np-head">
        ${iconButton({ className: "np-collapse", np: "close", label: "Close now playing", name: "chevron-down", size: 28 })}
        <div class="np-context">
          <span class="np-context-label">Playing from</span>
          <a class="np-context-link" data-ref="contextLink" href="#/library"></a>
        </div>
        ${iconButton({ className: "np-more", label: "More options", name: "more", size: 24, extra: 'data-action="track-menu" data-track-key="" data-context-type="now-playing" data-context-id=""' })}
        ${iconButton({ className: "np-dismiss", np: "close", label: "Close now playing view", name: "close", size: 20 })}
      </header>
      <div class="np-body" data-ref="body">
        <div class="np-main" data-ref="main">
          <div class="np-stage" data-ref="stage">
            <div class="np-art np-artbox" data-ref="sheetArt"></div>
            <div id="youtube-player-wrap" class="np-video" hidden><div id="youtube-player"></div></div>
            <span class="np-ad" data-ref="ad" hidden>Ad playing on YouTube</span>
          </div>
          <div class="np-info">
            <div class="np-titles">
              <a class="np-title" data-ref="sheetTitle" href="#/library"></a>
              <div class="np-artists" data-ref="sheetArtists"></div>
            </div>
            ${iconButton({ className: "np-like np-like--sheet", label: "Like", name: "heart", size: 26, extra: 'data-action="toggle-like" data-like-key="" aria-pressed="false"' })}
          </div>
          <div class="np-empty">
            <span class="np-empty-icon">${icon("disc", { size: 32 })}</span>
            <p class="np-empty-title">Nothing playing</p>
            <p class="np-empty-body">Songs you play show up here, with what's coming up next.</p>
          </div>
        </div>
        <section class="np-queue" data-ref="queue" aria-label="Queue">
          <div class="npq-now">
            <p class="npq-label">Now playing</p>
            <div class="npq-now-row">
              <span class="np-artbox npq-now-art" data-ref="queueArt"></span>
              <span class="npq-text">
                <span class="npq-title" data-ref="queueTitle"></span>
                <span class="npq-sub" data-ref="queueArtist"></span>
              </span>
              <span class="np-eq" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>
          </div>
          <div class="npq-head">
            <div class="npq-heading">
              <h2 class="npq-label">Up next</h2>
              <span class="npq-caption" data-ref="queueCaption"></span>
            </div>
            <button class="np-text-btn npq-edit" type="button" data-np="queue-edit" aria-pressed="false">Edit</button>
            <button class="np-text-btn npq-clear" type="button" data-np="queue-clear">Clear</button>
          </div>
          <div class="npq-scroll" data-ref="queueScroll">
            <div class="npq-list" role="list" data-ref="queueList"></div>
            <p class="npq-empty" data-ref="queueEmpty">Nothing up next. Use <b>Play next</b> or <b>Add to queue</b> on any song.</p>
            <p class="npq-more" data-ref="queueMore" hidden></p>
          </div>
        </section>
      </div>
      <div class="np-controls">
        <div class="np-scrub">
          <div class="np-sheet-slider" data-ref="sheetSlider"></div>
          <div class="np-times">
            <span class="np-time" data-ref="sheetElapsed">0:00</span>
            <span class="np-time" data-ref="sheetRemaining">${MINUS}0:00</span>
          </div>
        </div>
        <div class="np-transport">
          ${iconButton({ className: "np-toggle np-shuffle", np: "shuffle", label: "Shuffle", name: "shuffle", size: 22, extra: 'aria-pressed="false"' })}
          ${iconButton({ className: "np-skip np-prev", np: "prev", label: "Previous", name: "prev", size: 34 })}
          ${playButton("np-play--sheet", 34)}
          ${iconButton({ className: "np-skip np-next", np: "next", label: "Next", name: "next", size: 34 })}
          ${iconButton({ className: "np-toggle np-repeat", np: "repeat", label: "Repeat off", name: "repeat", size: 22, extra: 'aria-pressed="false"' })}
        </div>
        <div class="np-foot">
          ${iconButton({ className: "np-fs", np: "fullscreen", label: "Full screen video", name: "external", size: 22 })}
          <span class="np-foot-spacer"></span>
          ${iconButton({ className: "np-toggle np-queue-toggle", np: "queue", label: "Up next", name: "queue", size: 22, extra: 'aria-pressed="false"' })}
        </div>
      </div>
    </div>`;
}

function queueRowHtml(track) {
  const title = escapeHtml(track.title || "Untitled");
  const artist = escapeHtml(track.artist || "");
  return `
    <div class="npq-row" role="listitem" data-key="${escapeHtml(track.key)}">
      <button class="npq-main" type="button" data-npq="play" aria-label="Play ${title}${artist ? ` by ${artist}` : ""}">
        <span class="npq-art">${art(track, { size: 40, alt: "" })}</span>
        <span class="npq-text"><span class="npq-title">${title}</span><span class="npq-sub">${artist}</span></span>
        <span class="npq-dur">${formatTime(trackDuration(track))}</span>
      </button>
      <span class="npq-actions">
        <button class="np-btn npq-act" type="button" data-npq="up" aria-label="Move ${title} up" title="Move up">${icon("arrow-up", { size: 18 })}</button>
        <button class="np-btn npq-act" type="button" data-npq="down" aria-label="Move ${title} down" title="Move down">${icon("arrow-down", { size: 18 })}</button>
        <button class="np-btn npq-act" type="button" data-npq="remove" aria-label="Remove ${title} from queue" title="Remove from queue">${icon("close", { size: 18 })}</button>
      </span>
    </div>`;
}

// ---------------------------------------------------------------------------

// getContext() → { label, href } | null names the list playback came from
// ("Playing from"); null falls back to the song's album. restorePlayback()
// loads the saved song paused so prev/next/seek work before the first play;
// it returns true once the player holds it.
export function createNowPlaying({
  appRoot,
  barRoot,
  sheetRoot,
  getCatalog = () => null,
  isLiked = () => false,
  onNavigate = null,
  getContext = () => null,
  restorePlayback = null
} = {}) {
  const desktopQuery = matchMedia(DESKTOP_QUERY);
  const reducedQuery = matchMedia(REDUCED_MOTION_QUERY);
  const refs = {};
  const slots = {};
  const sliders = {};
  const buttons = { play: [], shuffle: [], repeat: [], prev: [], next: [], like: [], fullscreen: [] };
  const playerListeners = [];

  let mounted = false;
  let player = null;
  let snap = null;
  let snapAt = 0;
  let persisted = null;
  let buffering = false;
  let rafId = 0;
  let seekHold = null;
  let scrubbing = false;
  let lastSecond = -1;
  let lastTotal = -1;
  let lastTrackSig = null;
  let lastStateSig = null;
  let lastOptionsSig = null;
  let lastVolume = -1;
  let lastBackend = null;
  let lastQueueRef = null;
  let lastQueueSig = null;
  let lastMode = null;
  let lastProgressKey = "";
  let restoreVolume = 0.8;
  let sheetOpen = false;
  let panelOpen = readPanelPref();
  let queueMode = false;
  let queueEditing = false;
  let historyMarked = false;
  let ignoreNextPop = false;
  let pendingNavigation = null;
  let returnFocus = null;
  let closeTimer = 0;
  let suppressClickUntil = 0;
  let tint = tintFromRgb(NEUTRAL_RGB);
  let tintToken = 0;
  let themeMeta = null;
  let themeDefault = "";
  let drag = null;

  const isDesktop = () => desktopQuery.matches;
  const reducedMotion = () => reducedQuery.matches;

  function readPanelPref() {
    const stored = readStorage(PANEL_PREF_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return typeof window !== "undefined" && window.innerWidth >= 1280;
  }

  // -- model --------------------------------------------------------------

  function sourceFor(track) {
    if (!track) return null;
    return getCatalog()?.sourceById?.get?.(track.sourceId) || null;
  }

  function playbackContext() {
    try {
      const context = getContext?.();
      return context?.label && context?.href ? context : null;
    } catch {
      return null;
    }
  }

  function restore() {
    if (typeof restorePlayback !== "function") return false;
    try {
      return Boolean(restorePlayback());
    } catch (error) {
      console.debug("Could not restore the saved song.", error);
      return false;
    }
  }

  function model() {
    if (snap?.track) {
      const duration = Number.isFinite(snap.duration) ? snap.duration : trackDuration(snap.track);
      return {
        mode: "live",
        track: snap.track,
        source: snap.source || sourceFor(snap.track),
        elapsed: Number.isFinite(snap.elapsed) ? snap.elapsed : 0,
        duration,
        isPlaying: Boolean(snap.isPlaying),
        isBuffering: typeof snap.isBuffering === "boolean" ? snap.isBuffering : buffering,
        queue: snap.queue || [],
        queueIndex: Number.isInteger(snap.queueIndex) ? snap.queueIndex : -1,
        shuffle: Boolean(snap.shuffle),
        repeat: snap.repeat || "off",
        volume: Number.isFinite(snap.volume) ? snap.volume : 1,
        backend: snap.backend || null
      };
    }
    const base = {
      elapsed: 0,
      duration: 0,
      isPlaying: false,
      isBuffering: false,
      queue: snap?.queue || [],
      queueIndex: -1,
      shuffle: Boolean(snap?.shuffle),
      repeat: snap?.repeat || "off",
      volume: Number.isFinite(snap?.volume) ? snap.volume : 1,
      backend: null
    };
    if (persisted?.track) {
      const duration = trackDuration(persisted.track);
      const queue = base.queue;
      return {
        ...base,
        mode: "persisted",
        track: persisted.track,
        source: persisted.source || sourceFor(persisted.track),
        elapsed: clamp(Number(persisted.elapsed) || 0, 0, duration),
        duration,
        queueIndex: queue.indexOf(persisted.track.key)
      };
    }
    return { ...base, mode: "empty", track: null, source: null };
  }

  // -- rendering ----------------------------------------------------------

  // Prev/next and the scrubbers work on a restored song too: the first use loads it.
  function canTransport(m) {
    return m.mode === "live" || (m.mode === "persisted" && typeof restorePlayback === "function");
  }

  function apply(snapshot) {
    if (snapshot) {
      snap = snapshot;
      snapAt = performance.now();
      if (snapshot.track) persisted = null;
    }
    if (!mounted) return;
    const m = model();
    renderMode(m);
    renderTrack(m);
    renderPlayState(m);
    renderOptions(m);
    renderVolume(m);
    renderBackend(m);
    renderQueue(m);
    if (!rafId) drawProgress(m.mode === "live" ? liveElapsed(m) : m.elapsed, m.duration);
    syncLoop();
  }

  function renderMode(m) {
    if (m.mode === lastMode) return;
    const previous = lastMode;
    lastMode = m.mode;
    for (const root of [barRoot, sheetRoot]) root.dataset.state = m.mode;
    appRoot?.classList.toggle("np-idle", m.mode === "empty");
    syncBarHidden();
    const inactive = !canTransport(m);
    sliders.bar?.setDisabled(inactive);
    sliders.sheet?.setDisabled(inactive);
    for (const button of [...buttons.prev, ...buttons.next]) button.disabled = inactive;
    setAttr(refs.panelToggle, "disabled", m.mode === "empty");
    for (const button of [refs.more, ...buttons.like]) setAttr(button, "disabled", m.mode === "empty");
    if (m.mode === "empty" && sheetOpen) closeSheet();
    if (previous === null || previous === "empty" || m.mode === "empty") applyPanel();
  }

  function renderTrack(m) {
    const { track, source } = m;
    const artwork = track ? track.artwork ?? source?.artwork ?? null : null;
    const fallbackArtwork = track ? track.fallbackArtwork ?? source?.fallbackArtwork ?? null : null;
    const context = track ? playbackContext() : null;
    const sig = track
      ? [track.key, track.title, track.artist, (track.artists || []).join(","), source?.id, source?.title, artwork, fallbackArtwork, context?.label, context?.href].join("\u0001")
      : "";
    if (sig === lastTrackSig) return;
    lastTrackSig = sig;

    const item = track ? { artwork, fallbackArtwork } : null;
    for (const slot of Object.values(slots)) slot.set(item);

    if (!track) {
      setText(refs.barTitle, "Nothing playing");
      refs.barTitle.setAttribute("href", "#/library");
      refs.barArtists.textContent = "Pick a song to start listening";
      setText(refs.sheetTitle, "");
      refs.sheetArtists.textContent = "";
      setText(refs.contextLink, "");
      setText(refs.queueTitle, "");
      setText(refs.queueArtist, "");
      for (const button of buttons.like) button.dataset.likeKey = "";
      refs.more.dataset.trackKey = "";
      refs.more.dataset.contextId = "";
      setAttr(refs.openButton, "aria-label", "Open now playing");
      applyTint(null);
      refreshLike();
      return;
    }

    const sourceId = source?.id || track.sourceId || "";
    const href = albumHref(sourceId);
    const credit = track.artist || source?.artist || "";
    const artists = artistsForTrack(track, source);
    const linked = creditHtml(credit, artists);

    setText(refs.barTitle, track.title);
    refs.barTitle.setAttribute("href", href);
    refs.barArtists.innerHTML = linked;
    setText(refs.sheetTitle, track.title);
    refs.sheetTitle.setAttribute("href", href);
    refs.sheetArtists.innerHTML = linked;
    setText(refs.contextLink, context?.label || source?.title || track.sourceTitle || "");
    refs.contextLink.setAttribute("href", context?.href || href);
    setText(refs.queueTitle, track.title);
    setText(refs.queueArtist, credit);
    refs.more.dataset.trackKey = track.key;
    refs.more.dataset.contextId = sourceId;
    for (const button of buttons.like) button.dataset.likeKey = track.key;
    setAttr(refs.openButton, "aria-label", `Open now playing: ${track.title}${credit ? `, ${credit}` : ""}`);
    applyTint([artwork, fallbackArtwork]);
    refreshLike();
  }

  function renderPlayState(m) {
    const busy = m.mode === "live" && m.isBuffering;
    const showPause = m.mode === "live" && (m.isPlaying || busy);
    const sig = `${m.mode}|${showPause}|${busy}|${m.isPlaying}`;
    if (sig === lastStateSig) return;
    lastStateSig = sig;
    for (const button of buttons.play) {
      setIcon(button.querySelector(".np-ic"), showPause ? "pause-fill" : "play-fill");
      setLabel(button, showPause ? "Pause" : m.mode === "persisted" ? "Resume" : "Play");
      button.classList.toggle("is-buffering", busy);
      button.disabled = m.mode === "empty";
      // Before the first play the player has nothing loaded; the controller's
      // "resume" action restores the saved track and position instead.
      if (m.mode === "persisted") button.dataset.action = "resume";
      else delete button.dataset.action;
    }
    const playing = m.mode === "live" && m.isPlaying;
    barRoot.classList.toggle("is-playing", playing);
    sheetRoot.classList.toggle("is-playing", playing);
  }

  function renderOptions(m) {
    const lastInQueue = !m.shuffle && m.repeat !== "all" && m.queueIndex >= m.queue.length - 1;
    // A restored song missing from its saved queue resumes with its album, which may go on.
    const atEnd = m.mode === "live" ? lastInQueue : m.mode === "persisted" && m.queueIndex >= 0 && lastInQueue;
    const sig = `${m.mode}|${m.shuffle}|${m.repeat}|${atEnd}`;
    if (sig === lastOptionsSig) return;
    lastOptionsSig = sig;
    const disabled = m.mode === "empty";
    for (const button of buttons.shuffle) {
      button.classList.toggle("is-active", m.shuffle);
      setAttr(button, "aria-pressed", String(m.shuffle));
      setLabel(button, m.shuffle ? "Shuffle on" : "Shuffle off");
      button.disabled = disabled;
    }
    const repeatLabel = { off: "Repeat off", all: "Repeat all", one: "Repeat one" }[m.repeat] || "Repeat off";
    for (const button of buttons.repeat) {
      button.classList.toggle("is-active", m.repeat !== "off");
      setAttr(button, "aria-pressed", String(m.repeat !== "off"));
      setLabel(button, repeatLabel);
      setIcon(button, m.repeat === "one" ? "repeat-one" : "repeat");
      button.disabled = disabled;
    }
    if (canTransport(m)) for (const button of buttons.next) button.disabled = atEnd;
  }

  function renderVolume(m) {
    const volume = clamp(m.volume, 0, 1);
    if (volume === lastVolume) return;
    lastVolume = volume;
    if (volume > 0.01) restoreVolume = volume;
    sliders.volume?.set(volume);
    sliders.volume?.syncAria();
    setIcon(refs.muteButton, volume <= 0.001 ? "volume-mute" : "volume");
    setLabel(refs.muteButton, volume <= 0.001 ? "Unmute" : "Mute");
  }

  function renderBackend(m) {
    const backend = m.mode === "live" ? m.backend || "local" : "none";
    if (backend === lastBackend) return;
    const previous = lastBackend;
    lastBackend = backend;
    const youtube = backend === "youtube";
    refs.stage.dataset.backend = backend;
    const wrap = refs.stage.querySelector("#youtube-player-wrap");
    if (wrap) wrap.hidden = !youtube;
    for (const button of buttons.fullscreen) button.hidden = !youtube;
    if (!youtube) setAd(false);
    // A video has to stay on screen to keep playing, so bring the panel up
    // on desktop when a YouTube-backed song starts.
    if (youtube && previous !== null && isDesktop() && !panelOpen) setPanel(true, { remember: false });
  }

  function renderQueue(m) {
    const queue = m.queue || [];
    const index = m.queueIndex;
    const prefix = `${index}|${m.mode}|${m.shuffle}|`;
    if (queue === lastQueueRef && lastQueueSig?.startsWith(prefix)) return;
    const sig = `${prefix}${queue.length}|${queue.join("\n")}`;
    lastQueueRef = queue;
    if (sig === lastQueueSig) return;
    lastQueueSig = sig;

    const catalog = getCatalog();
    const lookup = (key) => catalog?.trackByKey?.get?.(key) || null;
    const upcomingKeys = index >= 0 ? queue.slice(index + 1) : m.mode === "empty" ? queue : [];
    const tracks = [];
    let totalSeconds = 0;
    let resolvedCount = 0;
    for (const key of upcomingKeys) {
      const track = lookup(key);
      if (!track) continue;
      resolvedCount += 1;
      totalSeconds += trackDuration(track);
      if (tracks.length < QUEUE_LIMIT) tracks.push(track);
    }

    reconcileRows(tracks, resolvedCount > tracks.length);
    const hasUpcoming = resolvedCount > 0;
    refs.queueEmpty.hidden = hasUpcoming;
    const canClear = hasUpcoming && m.mode !== "empty";
    refs.queueClear.hidden = !canClear;
    refs.queueClear.disabled = !canClear;
    refs.queueEdit.hidden = !hasUpcoming;
    if (!hasUpcoming && queueEditing) setQueueEditing(false);
    const notes = [];
    if (hasUpcoming) notes.push(formatListLength(resolvedCount, totalSeconds));
    if (m.shuffle && hasUpcoming) notes.push("shuffle on");
    setText(refs.queueCaption, notes.join(" · "));
    const hidden = resolvedCount - tracks.length;
    refs.queueMore.hidden = hidden <= 0;
    setText(refs.queueMore, hidden > 0 ? `+ ${hidden} more ${hidden === 1 ? "song" : "songs"}` : "");
  }

  function queueVisible() {
    if (isDesktop()) return panelOpen && appRoot?.classList.contains("panel-open");
    return sheetOpen && queueMode;
  }

  function reconcileRows(tracks, hasMoreBeyond) {
    const list = refs.queueList;
    const animate = queueVisible() && !reducedMotion() && tracks.length <= FLIP_LIMIT && list.children.length <= FLIP_LIMIT;
    const before = new Map();
    if (animate) for (const row of list.children) before.set(row, row.getBoundingClientRect().top);

    const existing = new Map();
    for (const row of list.children) existing.set(row.dataset.key, row);
    const wanted = tracks.map((track) => {
      const sig = `${track.title}\u0001${track.artist}\u0001${track.artwork}\u0001${trackDuration(track)}`;
      const current = existing.get(track.key);
      if (current && current.dataset.sig === sig) return current;
      const template = document.createElement("template");
      template.innerHTML = queueRowHtml(track).trim();
      const row = template.content.firstElementChild;
      row.dataset.sig = sig;
      return row;
    });
    const keep = new Set(wanted);
    for (const row of [...list.children]) if (!keep.has(row)) row.remove();
    wanted.forEach((row, position) => {
      if (list.children[position] !== row) list.insertBefore(row, list.children[position] || null);
      const up = row.querySelector('[data-npq="up"]');
      const down = row.querySelector('[data-npq="down"]');
      if (up) up.disabled = position === 0;
      if (down) down.disabled = position === wanted.length - 1 && !hasMoreBeyond;
    });

    if (!animate || !before.size) return;
    for (const row of wanted) {
      const top = before.get(row);
      if (top === undefined) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
        continue;
      }
      const dy = top - row.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) {
        row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 260, easing: EASE_OUT });
      }
    }
  }

  // -- progress -------------------------------------------------------------

  function liveElapsed(m = null, now = performance.now()) {
    const track = snap?.track;
    if (!track) return m?.elapsed || 0;
    const duration = Number.isFinite(snap.duration) ? snap.duration : trackDuration(track);
    let absolute;
    if (snap.isPlaying && typeof player?.positionAt === "function") absolute = player.positionAt(now);
    else absolute = (Number(snap.currentTime) || 0) + (snap.isPlaying ? (now - snapAt) / 1000 : 0);
    let elapsed = clamp((Number(absolute) || 0) - (Number(track.start) || 0), 0, duration);
    if (seekHold) {
      if (seekHold.key !== track.key || now > seekHold.until || Math.abs(elapsed - seekHold.elapsed) < 0.75) seekHold = null;
      else elapsed = seekHold.elapsed;
    }
    return elapsed;
  }

  function drawProgress(elapsed, duration) {
    const fraction = duration > 0 ? clamp(elapsed / duration, 0, 1) : 0;
    const desktop = isDesktop();
    // Only surfaces that can be seen are painted. The key carries which
    // surface is visible, so opening the sheet or switching layout repaints
    // the newly shown one on the very next frame.
    const key = `${desktop ? "d" : sheetOpen ? "s" : "m"}${fraction.toFixed(5)}`;
    if (key !== lastProgressKey) {
      lastProgressKey = key;
      if (desktop) {
        sliders.bar.set(fraction);
      } else {
        refs.lineFill.style.transform = `scaleX(${fraction})`;
        if (sheetOpen) sliders.sheet.set(fraction);
      }
    }
    const second = Math.floor(elapsed);
    const total = Math.floor(duration);
    if (second === lastSecond && total === lastTotal) return;
    lastSecond = second;
    lastTotal = total;
    if (!scrubbing) writeTimes(elapsed, duration);
    sliders.bar.syncAria();
    sliders.sheet.syncAria();
  }

  function writeTimes(elapsed, duration) {
    const text = formatTime(elapsed);
    setText(refs.barElapsed, text);
    setText(refs.sheetElapsed, text);
    setText(refs.barTotal, formatTime(duration));
    setText(refs.sheetRemaining, `${MINUS}${formatTime(remainingSeconds(elapsed, duration))}`);
  }

  function loopWanted() {
    return Boolean(mounted && player && snap?.track && snap.isPlaying && document.visibilityState === "visible");
  }

  function syncLoop() {
    if (loopWanted()) {
      if (!rafId) rafId = requestAnimationFrame(tick);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick() {
    rafId = 0;
    if (!loopWanted()) return;
    drawProgress(liveElapsed(), Number.isFinite(snap.duration) ? snap.duration : trackDuration(snap.track));
    rafId = requestAnimationFrame(tick);
  }

  function currentDuration() {
    return model().duration;
  }

  // The desktop bar shows the dragged time in its elapsed label (a floating
  // bubble there would sit on the transport); the sheet uses its bubble too.
  function scrubPreview(fraction) {
    const duration = currentDuration();
    const seconds = fraction * duration;
    scrubbing = true;
    writeTimes(seconds, duration);
    return formatTime(seconds);
  }

  function scrubCommit(fraction) {
    const m = model();
    if (!player || m.mode === "empty") return;
    const target = clamp(fraction, 0, 1) * m.duration;
    // A restored song is loaded paused first; the seek then moves where it resumes.
    if (m.mode === "persisted" && !restore()) {
      lastProgressKey = "";
      drawProgress(m.elapsed, m.duration);
      return;
    }
    seekHold = { key: m.track.key, elapsed: target, until: performance.now() + SEEK_HOLD_MS };
    safely(() => player.seekRelative(target));
    lastSecond = -1;
    drawProgress(target, m.duration);
  }

  function scrubEnd() {
    scrubbing = false;
    lastSecond = -1;
    const m = model();
    drawProgress(m.mode === "live" ? liveElapsed(m) : m.elapsed, m.duration);
  }

  function describeScrub(fraction) {
    const duration = currentDuration();
    const now = Math.floor(fraction * duration);
    return { max: Math.floor(duration), now, text: `${formatTime(now)} of ${formatTime(duration)}` };
  }

  // -- like / tint / ads ----------------------------------------------------

  function refreshLike() {
    const key = buttons.like[0]?.dataset.likeKey || "";
    let liked = false;
    try {
      liked = Boolean(key && isLiked(key));
    } catch { /* treat as not liked */ }
    for (const button of buttons.like) {
      button.classList.toggle("is-active", liked);
      setAttr(button, "aria-pressed", String(liked));
      setLabel(button, liked ? "Remove from Liked Songs" : "Save to Liked Songs");
      setIcon(button, liked ? "heart-fill" : "heart");
    }
  }

  function paintTint(next) {
    tint = next;
    for (const root of [barRoot, sheetRoot]) {
      root.style.setProperty("--np-tint", next.top);
      root.style.setProperty("--np-tint-deep", next.deep);
    }
    if (sheetOpen) setThemeColor(next.topHex);
  }

  function applyTint(urls) {
    const token = ++tintToken;
    if (!urls) {
      paintTint(tintFromRgb(NEUTRAL_RGB));
      return;
    }
    artworkTint(urls.filter(Boolean)).then((rgb) => {
      if (token === tintToken) paintTint(tintFromRgb(rgb || NEUTRAL_RGB));
    }, () => {
      if (token === tintToken) paintTint(tintFromRgb(NEUTRAL_RGB));
    });
  }

  function setThemeColor(color) {
    if (!themeMeta) return;
    themeMeta.setAttribute("content", color || themeDefault);
  }

  function setAd(active) {
    refs.ad.hidden = !active;
  }

  // -- panel (desktop) ------------------------------------------------------

  function setPanel(open, { remember = true } = {}) {
    panelOpen = Boolean(open);
    if (remember) writeStorage(PANEL_PREF_KEY, panelOpen ? "1" : "0");
    applyPanel();
  }

  function applyPanel() {
    const desktop = isDesktop();
    const show = desktop && panelOpen && lastMode !== "empty";
    appRoot?.classList.toggle("panel-open", show);
    refs.panelToggle?.classList.toggle("is-active", show);
    setAttr(refs.panelToggle, "aria-pressed", String(show));
    if (desktop) refs.sheet.inert = !show;
  }

  // -- sheet (mobile) -------------------------------------------------------

  // Mobile hides the idle mini player outright; desktop keeps a calm empty bar.
  function syncBarHidden() {
    barRoot.hidden = !isDesktop() && lastMode === "empty";
  }

  function applyLayout() {
    const desktop = isDesktop();
    syncBarHidden();
    if (desktop) {
      if (sheetOpen) {
        sheetOpen = false;
        clearTimeout(closeTimer);
        sheetRoot.classList.remove("is-open");
        appRoot?.classList.remove("np-open");
        setThemeColor(null);
        dropHistoryMarker();
      }
      refs.sheet.removeAttribute("role");
      refs.sheet.removeAttribute("aria-modal");
    } else {
      refs.sheet.setAttribute("role", "dialog");
      refs.sheet.setAttribute("aria-modal", "true");
      refs.sheet.inert = !sheetOpen;
    }
    applyQueueMode();
    applyPanel();
  }

  function open() {
    if (!mounted || lastMode === "empty") return;
    if (isDesktop()) {
      setPanel(!panelOpen);
      return;
    }
    if (sheetOpen) return;
    clearTimeout(closeTimer);
    sheetOpen = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    apply(null);
    pushHistoryMarker();
    resetSheetInline();
    refs.sheet.inert = false;
    sheetRoot.classList.add("is-open");
    appRoot?.classList.add("np-open");
    setThemeColor(tint.topHex);
    requestAnimationFrame(() => refs.collapse.focus({ preventScroll: true }));
  }

  function close() {
    if (!mounted) return;
    if (isDesktop()) {
      setPanel(false);
      return;
    }
    closeSheet();
  }

  function closeSheet({ fromHistory = false, settleMs = SHEET_MS } = {}) {
    if (!sheetOpen) return;
    sheetOpen = false;
    if (!fromHistory) dropHistoryMarker();
    else historyMarked = false;
    if (refs.sheet.contains(document.activeElement)) {
      const target = returnFocus?.isConnected && !refs.sheet.contains(returnFocus) ? returnFocus : refs.openButton;
      target?.focus({ preventScroll: true });
    }
    returnFocus = null;
    sheetRoot.classList.remove("is-open");
    appRoot?.classList.remove("np-open");
    refs.sheet.inert = true;
    setThemeColor(null);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      resetSheetInline();
      if (!sheetOpen && queueMode) {
        queueMode = false;
        setQueueEditing(false);
        applyQueueMode();
      }
    }, settleMs + 80);
  }

  function toggle() {
    if (isDesktop()) {
      if (lastMode !== "empty") setPanel(!panelOpen);
    } else if (sheetOpen) {
      close();
    } else {
      open();
    }
  }

  function isOpen() {
    return isDesktop() ? Boolean(appRoot?.classList.contains("panel-open")) : sheetOpen;
  }

  function showQueue(show = true) {
    const wanted = Boolean(show);
    if (isDesktop()) {
      if (wanted && !panelOpen) setPanel(true);
      requestAnimationFrame(() => {
        const top = wanted ? Math.max(0, refs.queue.offsetTop - 12) : 0;
        refs.body.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
      });
      return;
    }
    queueMode = wanted;
    if (!wanted) setQueueEditing(false);
    applyQueueMode();
    if (wanted && !sheetOpen) open();
  }

  function applyQueueMode() {
    const desktop = isDesktop();
    refs.sheet.classList.toggle("is-queue", queueMode && !desktop);
    refs.queueToggle.classList.toggle("is-active", queueMode);
    setAttr(refs.queueToggle, "aria-pressed", String(queueMode));
    refs.main.inert = !desktop && queueMode;
    refs.queue.inert = !desktop && !queueMode;
  }

  function setQueueEditing(editing) {
    queueEditing = Boolean(editing);
    refs.queue.classList.toggle("is-editing", queueEditing);
    setText(refs.queueEdit, queueEditing ? "Done" : "Edit");
    setAttr(refs.queueEdit, "aria-pressed", String(queueEditing));
  }

  function resetSheetInline() {
    refs.sheet.style.transition = "";
    refs.sheet.style.transform = "";
    refs.backdrop.style.transition = "";
    refs.backdrop.style.opacity = "";
    refs.sheet.classList.remove("is-dragging");
  }

  // Android back / browser back closes the sheet: opening pushes a same-URL
  // history entry that the next back press consumes.
  function pushHistoryMarker() {
    if (historyMarked) return;
    try {
      const state = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...state, [HISTORY_MARKER]: true }, "");
      historyMarked = true;
    } catch { /* history unavailable (sandboxed frame) */ }
  }

  function dropHistoryMarker() {
    if (historyMarked && history.state?.[HISTORY_MARKER]) {
      ignoreNextPop = true;
      history.back();
    } else if (pendingNavigation) {
      const target = pendingNavigation;
      pendingNavigation = null;
      navigateTo(target);
    }
    historyMarked = false;
  }

  function onPopState() {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      if (pendingNavigation) {
        const target = pendingNavigation;
        pendingNavigation = null;
        navigateTo(target);
      }
      return;
    }
    if (sheetOpen && !history.state?.[HISTORY_MARKER]) {
      closeSheet({ fromHistory: true });
      return;
    }
    // A marker left behind by navigating away from inside the sheet: step
    // over it so the back button never needs an extra press.
    if (!sheetOpen && history.state?.[HISTORY_MARKER]) history.back();
  }

  function onHashChange() {
    if (!sheetOpen) return;
    closeSheet({ fromHistory: true });
  }

  function navigateTo(hash) {
    if (typeof onNavigate === "function") onNavigate(hash);
    else location.hash = hash;
  }

  // -- drag to dismiss ------------------------------------------------------

  function beginDrag(y, time) {
    clearTimeout(closeTimer);
    drag = { ...(drag || {}), active: true, startY: y, offset: 0, height: refs.sheet.offsetHeight || window.innerHeight, samples: [{ t: time, y }] };
    refs.sheet.classList.add("is-dragging");
    refs.sheet.style.transition = "none";
    refs.backdrop.style.transition = "none";
    suppressClickUntil = Infinity;
  }

  function moveDrag(y, time) {
    if (!drag?.active) return;
    const raw = y - drag.startY;
    const offset = raw >= 0 ? raw : -rubberBand(-raw, 56);
    drag.offset = offset;
    drag.samples.push({ t: time, y });
    if (drag.samples.length > 12) drag.samples.shift();
    refs.sheet.style.transform = `translate3d(0, ${offset}px, 0)`;
    refs.backdrop.style.opacity = String(1 - clamp(offset / drag.height, 0, 1));
  }

  function endDrag(time, { cancelled = false } = {}) {
    if (!drag?.active) {
      drag = null;
      return;
    }
    const { offset, height, samples } = drag;
    drag = null;
    suppressClickUntil = performance.now() + 350;
    const velocity = cancelled ? 0 : releaseVelocity(samples, time);
    if (!cancelled && shouldDismiss({ offset, velocity, height })) {
      const remaining = Math.max(0, height - offset);
      const duration = Math.round(clamp(remaining / Math.max(velocity, 1.4), 120, SHEET_MS));
      // The flick's own speed carries the sheet out; visibility must flip only
      // once it is off screen.
      refs.sheet.style.transition = `transform ${duration}ms cubic-bezier(.25,.6,.3,1), visibility 0s linear ${duration}ms`;
      refs.backdrop.style.transition = `opacity ${duration}ms linear`;
      // Reduced motion fades out where the finger left it instead of sliding.
      if (!reducedMotion()) refs.sheet.style.transform = "";
      refs.backdrop.style.opacity = "";
      closeSheet({ settleMs: duration });
      return;
    }
    refs.sheet.classList.remove("is-dragging");
    refs.sheet.style.transition = `transform 340ms ${EASE_OUT}, border-radius 340ms ${EASE_OUT}`;
    refs.backdrop.style.transition = `opacity 340ms ${EASE_OUT}`;
    refs.sheet.style.transform = "";
    refs.backdrop.style.opacity = "";
    clearTimeout(closeTimer);
    closeTimer = setTimeout(resetSheetInline, 380);
  }

  function wireSheetDrag() {
    const sheet = refs.sheet;
    const noDrag = ".np-slider, .npq-scroll, input, textarea, select, #youtube-player-wrap";

    sheet.addEventListener("pointerdown", (event) => {
      if (isDesktop() || !sheetOpen || drag?.active) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest(noDrag)) return;
      drag = { active: false, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    });
    sheet.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.active) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) <= Math.abs(dx)) {
          drag = null;
          return;
        }
        try {
          sheet.setPointerCapture(event.pointerId);
        } catch { /* pointer already released */ }
        beginDrag(drag.startY, event.timeStamp);
      }
      moveDrag(event.clientY, event.timeStamp);
    });
    const finish = (event, cancelled) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active && !cancelled) drag.samples.push({ t: event.timeStamp, y: event.clientY });
      endDrag(event.timeStamp, { cancelled });
    };
    sheet.addEventListener("pointerup", (event) => finish(event, false));
    sheet.addEventListener("pointercancel", (event) => finish(event, true));
    sheet.addEventListener("lostpointercapture", (event) => {
      if (event.target === sheet) finish(event, false);
    });

    // The queue list scrolls natively; pulling down once it is at the top
    // hands the gesture to the sheet, like the system music players.
    const scroller = refs.queueScroll;
    let touch = null;
    scroller.addEventListener("touchstart", (event) => {
      if (isDesktop() || !sheetOpen || event.touches.length !== 1) {
        touch = null;
        return;
      }
      touch = { x: event.touches[0].clientX, y: event.touches[0].clientY, dragging: false };
    }, { passive: true });
    scroller.addEventListener("touchmove", (event) => {
      if (!touch) return;
      const point = event.touches[0];
      if (!touch.dragging) {
        const dy = point.clientY - touch.y;
        const dx = point.clientX - touch.x;
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        if (dy <= 0 || scroller.scrollTop > 0 || Math.abs(dx) > Math.abs(dy) || !event.cancelable) {
          touch = null;
          return;
        }
        touch.dragging = true;
        drag = { active: false, pointerId: "touch" };
        beginDrag(point.clientY, event.timeStamp);
      }
      event.preventDefault();
      moveDrag(point.clientY, event.timeStamp);
    }, { passive: false });
    const touchEnd = (event, cancelled) => {
      if (touch?.dragging) {
        const point = event.changedTouches?.[0];
        if (point && drag?.active && !cancelled) drag.samples.push({ t: event.timeStamp, y: point.clientY });
        endDrag(event.timeStamp, { cancelled });
      }
      touch = null;
    };
    scroller.addEventListener("touchend", (event) => touchEnd(event, false));
    scroller.addEventListener("touchcancel", (event) => touchEnd(event, true));
  }

  // A quick upward swipe on the mini player opens the sheet.
  function wireMiniSwipe() {
    let start = null;
    barRoot.addEventListener("pointerdown", (event) => {
      if (isDesktop() || lastMode === "empty" || event.target.closest(".np-play, .np-btn")) return;
      start = { id: event.pointerId, y: event.clientY, t: event.timeStamp };
    });
    barRoot.addEventListener("pointerup", (event) => {
      if (!start || start.id !== event.pointerId) return;
      const dy = event.clientY - start.y;
      const dt = event.timeStamp - start.t;
      start = null;
      if (dy < -24 && dt < 600) {
        suppressClickUntil = performance.now() + 350;
        open();
      }
    });
    barRoot.addEventListener("pointercancel", () => {
      start = null;
    });
  }

  // -- DOM events -----------------------------------------------------------

  function onCaptureClick(event) {
    // Never let a drag that lost its pointer block taps for good.
    if (suppressClickUntil === Infinity && !drag?.active) suppressClickUntil = 0;
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onRootClick(event) {
    const link = event.target.closest("a[href^='#']");
    if (link && sheetRoot.contains(link)) {
      handleSheetLink(event, link);
      return;
    }
    const queueControl = event.target.closest("[data-npq]");
    if (queueControl) {
      handleQueueControl(queueControl);
      return;
    }
    const control = event.target.closest("[data-np]");
    if (!control || control.disabled) return;
    handleControl(control.dataset.np, control);
  }

  function handleSheetLink(event, link) {
    if (isDesktop() || !sheetOpen) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const hash = link.getAttribute("href");
    if (!hash || hash === "#") return;
    event.preventDefault();
    if (hash === location.hash) {
      closeSheet();
      return;
    }
    // Pop our history marker first, then navigate, so the new page is a
    // normal entry and back returns to where the listener was.
    pendingNavigation = hash;
    closeSheet();
  }

  function handleControl(action, control) {
    const m = model();
    switch (action) {
      case "open":
        open();
        break;
      case "panel":
        toggle();
        break;
      case "close":
        close();
        break;
      case "play":
        if (m.mode === "live" && player) safely(() => player.toggle());
        break;
      case "prev":
      case "next":
        if (!player || !canTransport(m) || (m.mode === "persisted" && !restore())) break;
        safely(() => (action === "next" ? player.next() : player.previous()));
        break;
      case "shuffle":
        if (player) safely(() => player.setShuffle(!m.shuffle));
        break;
      case "repeat":
        if (player) safely(() => player.cycleRepeat());
        break;
      case "mute":
        if (player) safely(() => player.setVolume(m.volume > 0.001 ? 0 : restoreVolume || 0.8));
        break;
      case "queue":
        showQueue(!queueMode);
        break;
      case "queue-edit":
        setQueueEditing(!queueEditing);
        break;
      case "queue-clear":
        clearUpcoming();
        break;
      case "fullscreen":
        if (player) safely(() => player.enterVideoFullscreen());
        break;
      default:
        break;
    }
  }

  function handleQueueControl(control) {
    if (!player || control.disabled) return;
    const row = control.closest(".npq-row");
    const key = row?.dataset.key;
    if (!key) return;
    switch (control.dataset.npq) {
      case "play":
        if (queueEditing) return;
        safely(() => player.loadByKey(key, { queue: [...(player.queue || [])] }));
        break;
      case "up":
        safely(() => player.moveInQueue(key, -1));
        break;
      case "down":
        safely(() => player.moveInQueue(key, 1));
        break;
      case "remove":
        safely(() => player.removeFromQueue(key));
        break;
      default:
        break;
    }
  }

  function clearUpcoming() {
    if (!player) return;
    const previous = [...(player.queue || [])];
    const m = model();
    let cleared = false;
    try {
      if (m.mode === "persisted") {
        // Nothing is loaded yet, so the player can't tell what is upcoming:
        // keep the restored song and drop what follows it.
        const index = previous.indexOf(m.track.key);
        if (index >= 0 && index < previous.length - 1) {
          player.setQueue(previous.slice(0, index + 1));
          cleared = true;
        }
      } else {
        cleared = Boolean(player.clearUpcoming());
      }
    } catch (error) {
      console.debug("Could not clear the queue.", error);
    }
    if (!cleared) return;
    setQueueEditing(false);
    toast("Cleared up next", {
      actionLabel: "Undo",
      onAction: () => safely(() => player.setQueue(previous, player.currentTrack?.key || null))
    });
  }

  function onSheetKeydown(event) {
    if (isDesktop() || !sheetOpen) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      closeSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...refs.sheet.querySelectorAll("a[href], button:not([disabled]), [tabindex='0']")]
      .filter((node) => !node.closest("[inert], [hidden]") && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") {
      lastSecond = -1;
      lastProgressKey = "";
      apply(null);
    }
    syncLoop();
  }

  // -- public API -----------------------------------------------------------

  function mount() {
    if (mounted) return api;
    if (!barRoot || !sheetRoot) throw new Error("Now playing needs #player-bar and #now-playing.");
    barRoot.innerHTML = barMarkup();
    sheetRoot.innerHTML = sheetMarkup();
    barRoot.classList.add("np-bar-root");
    sheetRoot.classList.add("np-root");
    sheetRoot.setAttribute("aria-label", "Now playing");
    for (const node of [...barRoot.querySelectorAll("[data-ref]"), ...sheetRoot.querySelectorAll("[data-ref]")]) {
      refs[node.dataset.ref] = node;
    }
    refs.backdrop = sheetRoot.querySelector(".np-backdrop");
    refs.openButton = barRoot.querySelector(".pb-open");
    refs.panelToggle = barRoot.querySelector(".pb-panel");
    refs.muteButton = barRoot.querySelector(".pb-mute");
    refs.collapse = sheetRoot.querySelector(".np-collapse");
    refs.more = sheetRoot.querySelector(".np-more");
    refs.queueToggle = sheetRoot.querySelector(".np-queue-toggle");
    refs.queueEdit = sheetRoot.querySelector(".npq-edit");
    refs.queueClear = sheetRoot.querySelector(".npq-clear");
    const all = (selector) => [...barRoot.querySelectorAll(selector), ...sheetRoot.querySelectorAll(selector)];
    buttons.play = all(".np-play");
    buttons.shuffle = all('[data-np="shuffle"]');
    buttons.repeat = all('[data-np="repeat"]');
    buttons.prev = all('[data-np="prev"]');
    buttons.next = all('[data-np="next"]');
    buttons.like = all(".np-like");
    buttons.fullscreen = all('[data-np="fullscreen"]');
    for (const button of buttons.fullscreen) button.hidden = true;

    slots.bar = new ArtSlot(refs.barArt, { iconSize: 22 });
    slots.sheet = new ArtSlot(refs.sheetArt, { iconSize: 72 });
    slots.queue = new ArtSlot(refs.queueArt, { iconSize: 20 });

    sliders.bar = new Slider(refs.barSlider, {
      label: "Seek",
      onPreview: scrubPreview,
      onCommit: scrubCommit,
      onEnd: scrubEnd,
      describe: describeScrub,
      keyStep: () => (currentDuration() > 0 ? 5 / currentDuration() : 0.05)
    });
    sliders.sheet = new Slider(refs.sheetSlider, {
      label: "Seek",
      bubble: true,
      onPreview: scrubPreview,
      onCommit: scrubCommit,
      onEnd: scrubEnd,
      describe: describeScrub,
      keyStep: () => (currentDuration() > 0 ? 5 / currentDuration() : 0.05)
    });
    if (mediaVolumeIsLocked()) {
      barRoot.querySelector(".pb-volume").hidden = true;
    } else {
      sliders.volume = new Slider(refs.volSlider, {
        label: "Volume",
        wheel: true,
        onPreview: (fraction) => {
          if (player) safely(() => player.setVolume(fraction));
          return "";
        },
        onCommit: (fraction) => {
          if (player) safely(() => player.setVolume(fraction));
        },
        describe: (fraction) => ({ max: 100, now: Math.round(fraction * 100), text: `${Math.round(fraction * 100)}%` })
      });
    }

    themeMeta = document.querySelector('meta[name="theme-color"]');
    themeDefault = themeMeta?.getAttribute("content") || "#0a0a0b";

    for (const root of [barRoot, sheetRoot]) {
      root.addEventListener("click", onCaptureClick, true);
      root.addEventListener("click", onRootClick);
    }
    refs.sheet.addEventListener("keydown", onSheetKeydown);
    wireSheetDrag();
    wireMiniSwipe();
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("visibilitychange", onVisibility);
    desktopQuery.addEventListener("change", applyLayout);

    mounted = true;
    paintTint(tint);
    applyLayout();
    apply(player ? player.snapshot() : null);
    return api;
  }

  function attach(nextPlayer) {
    for (const [type, handler] of playerListeners.splice(0)) player?.removeEventListener(type, handler);
    player = nextPlayer || null;
    if (!player) {
      apply(null);
      return api;
    }
    const on = (type, handler) => {
      player.addEventListener(type, handler);
      playerListeners.push([type, handler]);
    };
    const update = (event) => apply(event.detail?.track !== undefined ? event.detail : player.snapshot());
    for (const type of ["trackchange", "statechange", "progress", "queuechange", "optionschange", "volumechange", "backendchange"]) on(type, update);
    on("buffering", (event) => {
      buffering = Boolean(event.detail?.buffering);
      apply(player.snapshot());
    });
    on("adbreak", (event) => setAd(Boolean(event.detail?.active) && lastBackend === "youtube"));
    on("error", () => {
      buffering = false;
      apply(player.snapshot());
    });
    apply(player.snapshot());
    return api;
  }

  function render() {
    lastTrackSig = null;
    lastQueueSig = null;
    lastStateSig = null;
    lastOptionsSig = null;
    lastSecond = -1;
    lastProgressKey = "";
    apply(player ? player.snapshot() : null);
  }

  function renderPersisted({ track = null, source = null, elapsed = 0 } = {}) {
    if (snap?.track) return;
    persisted = track ? { track, source, elapsed } : null;
    lastSecond = -1;
    lastProgressKey = "";
    apply(null);
  }

  const api = {
    mount,
    attach,
    render,
    renderPersisted,
    refreshLike,
    open,
    close,
    toggle,
    isOpen,
    showQueue
  };
  return api;
}
