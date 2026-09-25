// Edit song times for one album/session. The markup is a pure string; after(root) runs the
// editor: a rAF clock of the player position, per-row nudges and "Now", add/remove with undo,
// live validation (friendly per-row checks, then catalog.parseChapterLines as the final word),
// an unsaved draft kept on this device, and save/reset through ctx.actions.
import { parseChapterLines } from "../catalog.js";
import { icon } from "../icons.js";
import { art, emptyState, html, raw } from "../ui.js";
import { formatTime, pluralize } from "../utils.js";

const NUDGE = 0.5;
const SEEK_STEP = 5;
const KEY_STEP = 0.1;
const DRAFT_PREFIX = "acoustify-edit-draft:";
const DRAFT_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const IDLE_POLL_MS = 250;

/* ------------------------------------------------------------------ time helpers (pure) */

const round2 = (value) => Math.round(value * 100) / 100;
const clampNum = (value, min, max) => Math.min(max, Math.max(min, value));

// "3:25.4" / "1:02:03.5" — tenths, for inputs and the clock.
export function formatPreciseTime(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const secs = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

// Hundredths, in the exact shape parseChapterLines accepts (hours once past 59:59).
export function chapterTimecode(seconds) {
  const hundredths = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const hours = Math.floor(hundredths / 360000);
  const minutes = Math.floor((hundredths % 360000) / 6000);
  const secs = ((hundredths % 6000) / 100).toFixed(2).padStart(5, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

// Accepts "3:25", "3:25.4", "205", "205.4", "1:02:03" (a decimal comma too). NaN when it isn't a time.
export function parseTimeInput(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!value) return NaN;
  let match = value.match(/^(\d+(?:\.\d+)?)$/);
  if (match) return round2(Number(match[1]));
  match = value.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (match) return round2(Number(match[1]) * 60 + Number(match[2]));
  match = value.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (match) return round2(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
  return NaN;
}

/* ------------------------------------------------------------------ row model (pure) */

let uidSeq = 0;
const nextUid = () => `r${(uidSeq += 1).toString(36)}`;

export function rowsFromTracks(tracks = []) {
  return (Array.isArray(tracks) ? tracks : []).map((track) => ({
    uid: nextUid(),
    id: String(track?.id ?? ""),
    title: String(track?.title ?? ""),
    start: round2(Number(track?.start) || 0)
  }));
}

// Per-row problems in plain words, plus whether the list is out of time order.
export function validateRows(rows, duration) {
  const errors = rows.map(() => ({}));
  const total = Number(duration) || 0;
  rows.forEach((row, index) => {
    if (!String(row.title || "").trim()) errors[index].title = "Give this song a name.";
    if (!Number.isFinite(row.start)) errors[index].start = "Use minutes and seconds, like 3:05.";
    else if (total > 0 && row.start >= total) errors[index].start = `This is after the recording ends (${formatTime(total, total >= 3600)}).`;
  });
  const seen = new Map();
  rows.forEach((row, index) => {
    if (!Number.isFinite(row.start) || errors[index].start) return;
    const key = Math.round(row.start * 100);
    if (seen.has(key)) {
      errors[index].start = "Another song already starts at this time.";
      const first = seen.get(key);
      if (!errors[first].start) errors[first].start = "Another song already starts at this time.";
    } else {
      seen.set(key, index);
    }
  });
  let outOfOrder = false;
  for (let index = 1; index < rows.length; index += 1) {
    if (Number.isFinite(rows[index].start) && Number.isFinite(rows[index - 1].start) && rows[index].start < rows[index - 1].start) {
      outOfOrder = true;
      break;
    }
  }
  const invalidCount = errors.filter((entry) => entry.title || entry.start).length;
  return { errors, invalidCount, valid: rows.length > 0 && invalidCount === 0, outOfOrder };
}

// Final tracks for saveSourceOverride. parseChapterLines is the authority on shape and order;
// ids of existing songs are kept (likes and playlists point at them), new songs get fresh ids.
export function buildTracks(rows, source) {
  const duration = Number(source?.duration) || 0;
  const sorted = rows
    .map((row) => ({ ...row, title: String(row.title || "").trim() }))
    .sort((a, b) => a.start - b.start);
  const parsed = parseChapterLines(sorted.map((row) => `${chapterTimecode(row.start)} ${row.title}`).join("\n"), duration);
  if (parsed.length !== sorted.length) throw new Error("Some songs couldn't be read. Check the names and times.");
  const originals = new Map((source?.tracks || []).map((track) => [String(track.id), track]));
  const used = new Set(sorted.filter((row) => row.id && originals.has(row.id)).map((row) => row.id));
  return parsed.map((track, index) => {
    const row = sorted[index];
    const original = row.id ? originals.get(row.id) : null;
    let id = original ? row.id : "";
    if (!id) {
      const base = track.id || `song-${index + 1}`;
      id = base;
      for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
      used.add(id);
    }
    const start = round2(row.start);
    const end = index < sorted.length - 1 ? round2(sorted[index + 1].start) : duration;
    const unchanged = original && Math.abs(Number(original.start) - start) < 0.005 && Math.abs(Number(original.end) - end) < 0.005;
    const next = { id, title: row.title, start, end, timingConfidence: unchanged && original.timingConfidence ? original.timingConfidence : "user" };
    if (original?.artists) next.artists = [...original.artists];
    if (original?.artist) next.artist = original.artist;
    return next;
  });
}

function rowsSignature(rows) {
  return JSON.stringify(rows.map((row) => [row.id, String(row.title || "").trim(), Number.isFinite(row.start) ? round2(row.start) : null]));
}

function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

function sourceSignature(source) {
  return hashText(JSON.stringify([Number(source.duration) || 0, (source.tracks || []).map((track) => [track.id, track.title, track.start, track.end])]));
}

/* ------------------------------------------------------------------ drafts (this device only) */

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readDraft(sourceId, signature) {
  const store = storage();
  if (!store) return null;
  try {
    const text = store.getItem(DRAFT_PREFIX + sourceId);
    if (!text) return null;
    const draft = JSON.parse(text);
    const fresh = draft?.v === 1 && draft.sig === signature && Array.isArray(draft.rows) && Date.now() - Number(draft.at || 0) < DRAFT_MAX_AGE;
    if (!fresh) {
      store.removeItem(DRAFT_PREFIX + sourceId);
      return null;
    }
    const rows = draft.rows
      .filter((row) => row && typeof row === "object")
      .map((row) => ({ uid: nextUid(), id: String(row.id || ""), title: String(row.title || ""), start: row.start === null ? NaN : round2(Number(row.start)) }));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function writeDraft(sourceId, signature, rows) {
  try {
    storage()?.setItem(DRAFT_PREFIX + sourceId, JSON.stringify({
      v: 1,
      sig: signature,
      at: Date.now(),
      rows: rows.map((row) => ({ id: row.id, title: row.title, start: Number.isFinite(row.start) ? row.start : null }))
    }));
  } catch {
    // Storage full or blocked: the draft is a convenience, the editor keeps working.
  }
}

function clearDraft(sourceId) {
  try {
    storage()?.removeItem(DRAFT_PREFIX + sourceId);
  } catch {
    // Nothing to clean up.
  }
}

/* ------------------------------------------------------------------ markup */

function rowLength(rows, index, duration) {
  const start = rows[index].start;
  if (!Number.isFinite(start)) return "";
  const later = rows.map((row) => row.start).filter((value) => Number.isFinite(value) && value > start);
  const end = later.length ? Math.min(...later) : duration;
  const length = end - start;
  return length > 0 ? formatTime(length, length >= 3600) : "";
}

function rowMarkup(row, index, rows, duration) {
  const n = index + 1;
  const name = `song ${n}`; // index-based so labels never go stale while a title is being typed
  const startText = Number.isFinite(row.start) ? formatPreciseTime(row.start) : (row.text ?? "");
  return html`<li class="edit-row" data-uid="${row.uid}"><span class="edit-num" aria-hidden="true">${n}</span><input class="input edit-title" type="text" value="${row.title}" placeholder="Song name" maxlength="140" autocomplete="off" enterkeyhint="next" aria-label="Song ${n} name" data-field="title"><div class="edit-time" role="group" aria-label="Start of ${name}"><input class="input edit-start" type="text" value="${startText}" placeholder="0:00.0" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Song ${n} start time" data-field="start"><button class="edit-step" type="button" data-nudge="${-NUDGE}" aria-label="Start ${name} half a second earlier">−0.5</button><button class="edit-step edit-now" type="button" data-now aria-label="Start ${name} at the current playback time">Now</button><button class="edit-step" type="button" data-nudge="${NUDGE}" aria-label="Start ${name} half a second later">+0.5</button></div><span class="edit-len" data-len>${rowLength(rows, index, duration)}</span><button class="icon-btn icon-btn--sm edit-preview" type="button" data-preview aria-label="Play ${name} from its start">${icon("play-fill", { size: 16 })}</button><button class="icon-btn icon-btn--sm edit-remove" type="button" data-remove aria-label="Remove ${name}"${rows.length <= 1 ? raw(" disabled") : ""}>${icon("close", { size: 18 })}</button><p class="edit-error" data-error hidden></p></li>`;
}

function rowsMarkup(rows, duration) {
  return rows.map((row, index) => rowMarkup(row, index, rows, duration));
}

function marksMarkup(rows, duration, errors = []) {
  if (!(duration > 0)) return "";
  return rows.map((row, index) => (Number.isFinite(row.start) && row.start < duration
    ? html`<span class="edit-mark${errors[index]?.start ? " is-invalid" : ""}" style="--at: ${(row.start / duration).toFixed(5)}"></span>`
    : ""));
}

function findSource(catalog, sourceId) {
  if (!sourceId || !catalog) return null;
  return catalog.sourceById?.get?.(sourceId) || (catalog.sources || []).find((source) => source.id === sourceId) || null;
}

function hasOverride(ctx, source) {
  if (source.userSource) return false; // user-only music has no library version to go back to
  return Boolean(source.overridden) || Boolean(ctx.state?.userSources?.some?.((entry) => entry?.id === source.id));
}

function notFound(title, body) {
  return {
    title: "Edit song times",
    html: html`<div class="page edit-page">${emptyState({ iconName: "alert", title, body, actionHtml: html`<button class="btn btn-primary" type="button" data-action="go-back">Go back</button>` })}</div>`
  };
}

/* ------------------------------------------------------------------ view */

export function renderEdit(ctx, route, sourceId) {
  const source = findSource(ctx.catalog, sourceId);
  if (!source) return notFound("Album not found", "It may have been removed from your library.");
  const duration = Number(source.duration) || 0;
  if (!(duration > 0)) return notFound("Can't edit this recording", "Its length isn't known yet.");

  const signature = sourceSignature(source);
  const libraryRows = rowsFromTracks(source.tracks);
  if (!libraryRows.length) libraryRows.push({ uid: nextUid(), id: "", title: "", start: 0 });
  const draftRows = readDraft(source.id, signature);
  const rows = draftRows || libraryRows;
  const check = validateRows(rows, duration);
  const total = formatTime(duration, duration >= 3600);
  const resettable = hasOverride(ctx, source);
  const albumHref = `#/album/${encodeURIComponent(source.id)}`;
  // Where the current song times came from ("…the chapters in the video description."). It only
  // matters while editing them, so it lives here rather than on the album page.
  const origin = source.timingStatus === "single-track" ? "" : String(source.timingNote || "").trim();

  const markup = html`<div class="page edit-page" data-edit-source="${source.id}"><div class="page-top"><button class="btn btn-ghost btn-sm edit-back" type="button" data-action="go-back" data-edit-cancel>${icon("chevron-left", { size: 18 })}Cancel</button></div><header class="edit-head"><span class="edit-art">${art(source, { size: 128, eager: true })}</span><div class="edit-head-text"><h1>Edit song times</h1><p class="edit-sub"><a href="${albumHref}">${source.title}</a><span>${source.artist}</span></p></div></header>${draftRows ? html`<div class="banner edit-draft" data-edit-draft>${icon("info", { size: 20 })}<span>You have unsaved changes from before.</span><button class="btn btn-ghost btn-sm" type="button" data-edit-discard>Discard</button></div>` : ""}<p class="edit-intro">${origin ? html`${origin} ` : ""}Play the full recording. When a song begins, select <strong>Now</strong> on that song, then nudge it by half a second if needed.</p><div class="edit-transport" data-edit-transport><div class="edit-transport-main"><button class="edit-play" type="button" data-edit-play aria-label="Play full recording">${icon("play-fill", { size: 22, className: "edit-play-icon" })}</button><div class="edit-clock"><span class="edit-clock-time" data-edit-clock aria-hidden="true">0:00.0</span><span class="edit-clock-caption" data-edit-caption>Full recording · ${total}</span></div><div class="edit-seek"><button class="edit-step" type="button" data-seek="${-SEEK_STEP}" aria-label="Back 5 seconds">−5s</button><button class="edit-step" type="button" data-seek="${SEEK_STEP}" aria-label="Forward 5 seconds">+5s</button></div><button class="btn btn-primary btn-sm edit-save" type="submit" form="edit-form" data-edit-save disabled>Save</button></div><div class="edit-timeline" data-edit-timeline role="slider" tabindex="0" aria-label="Position in the full recording" aria-valuemin="0" aria-valuemax="${Math.round(duration)}" aria-valuenow="0" aria-valuetext="0:00"><span class="edit-timeline-track"><span class="edit-timeline-fill" data-edit-fill></span></span><span class="edit-marks" data-edit-marks>${marksMarkup(rows, duration, check.errors)}</span><span class="edit-playhead" data-edit-playhead></span></div></div><form class="edit-form" id="edit-form" data-edit-form novalidate autocomplete="off"><div class="edit-list-head"><h2>Songs</h2><span class="edit-count" data-edit-count>${pluralize(rows.length, "song")}</span></div><ol class="edit-rows" data-edit-rows>${rowsMarkup(rows, duration)}</ol><div class="edit-list-foot"><button class="btn btn-secondary btn-sm edit-add" type="button" data-edit-add>${icon("plus", { size: 18 })}Add a song</button><p class="edit-summary" data-edit-summary role="status" aria-live="polite"></p></div></form>${resettable ? html`<div class="edit-reset"><button class="btn btn-ghost btn-sm edit-reset-btn" type="button" data-edit-reset>Reset to library version</button><p class="micro">Undo every song-time change you've made to this album.</p></div>` : ""}</div>`;

  return {
    title: "Edit song times",
    html: markup,
    after: (root) => mountEditor(root, ctx, source, { rows, libraryRows, signature, fromDraft: Boolean(draftRows) })
  };
}

/* ------------------------------------------------------------------ editor */

function mountEditor(root, ctx, source, initial) {
  const page = root.querySelector(".edit-page[data-edit-source]") || root;
  const form = page.querySelector("[data-edit-form]");
  const list = page.querySelector("[data-edit-rows]");
  if (!form || !list) return undefined;

  const duration = Number(source.duration) || 0;
  const player = ctx.player || null;
  let baseline = rowsSignature(initial.libraryRows);
  const dom = {
    count: page.querySelector("[data-edit-count]"),
    summary: page.querySelector("[data-edit-summary]"),
    saves: [...page.querySelectorAll("[data-edit-save]")],
    marks: page.querySelector("[data-edit-marks]"),
    clock: page.querySelector("[data-edit-clock]"),
    caption: page.querySelector("[data-edit-caption]"),
    play: page.querySelector("[data-edit-play]"),
    fill: page.querySelector("[data-edit-fill]"),
    playhead: page.querySelector("[data-edit-playhead]"),
    timeline: page.querySelector("[data-edit-timeline]"),
    transport: page.querySelector("[data-edit-transport]")
  };

  let rows = initial.rows.map((row) => ({ ...row }));
  const touched = new Set(); // "uid:field" pairs the listener has finished editing
  let showAll = false;
  let saving = false;
  let allowLeave = false;
  let disposed = false;
  let draftTimer = 0;
  const disposers = [];
  const listen = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  };

  const isDirty = () => rowsSignature(rows) !== baseline;
  const rowEl = (uid) => list.querySelector(`.edit-row[data-uid="${CSS.escape(uid)}"]`);
  const rowIndex = (uid) => rows.findIndex((row) => row.uid === uid);

  /* ---------------- validation + in-place updates */

  function refresh() {
    const check = validateRows(rows, duration);
    const dirty = isDirty();
    let visibleErrors = 0;
    rows.forEach((row, index) => {
      const element = rowEl(row.uid);
      if (!element) return;
      const errors = check.errors[index];
      const titleError = errors.title && (showAll || touched.has(`${row.uid}:title`)) ? errors.title : "";
      const startError = errors.start && (showAll || touched.has(`${row.uid}:start`) || row.startFromControl) ? errors.start : "";
      const message = startError || titleError;
      if (message) visibleErrors += 1;
      element.classList.toggle("is-invalid", Boolean(message));
      element.querySelector(".edit-title")?.setAttribute("aria-invalid", titleError ? "true" : "false");
      element.querySelector(".edit-start")?.setAttribute("aria-invalid", startError ? "true" : "false");
      const errorEl = element.querySelector("[data-error]");
      if (errorEl) {
        if (errorEl.textContent !== message) errorEl.textContent = message;
        errorEl.hidden = !message;
      }
      const len = element.querySelector("[data-len]");
      const lengthText = rowLength(rows, index, duration);
      if (len && len.textContent !== lengthText) len.textContent = lengthText;
    });
    if (dom.marks) dom.marks.innerHTML = String(html`${marksMarkup(rows, duration, check.errors)}`);
    if (dom.count) dom.count.textContent = pluralize(rows.length, "song");
    for (const button of dom.saves) button.disabled = saving || !dirty;
    setSummary(check, dirty, visibleErrors);
    return check;
  }

  function setSummary(check, dirty, visibleErrors) {
    if (!dom.summary) return;
    let text = "";
    let tone = "";
    let sortable = false;
    if (visibleErrors) {
      text = visibleErrors === 1 ? "Fix the highlighted song to save." : `Fix the ${visibleErrors} highlighted songs to save.`;
      tone = "error";
    } else if (check.outOfOrder) {
      text = "Songs are out of time order. They'll be sorted when you save.";
      sortable = true;
    } else if (dirty) {
      text = "Unsaved changes";
      tone = "dirty";
    }
    dom.summary.dataset.tone = tone;
    dom.summary.hidden = !text;
    dom.summary.replaceChildren(document.createTextNode(text));
    if (sortable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "edit-link";
      button.dataset.editSort = "";
      button.textContent = "Sort now";
      dom.summary.append(" ", button);
    }
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 400);
  }

  function persistDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (isDirty()) writeDraft(source.id, initial.signature, rows);
    else clearDraft(source.id);
  }

  function changed() {
    refresh();
    scheduleDraft();
    syncCurrentRow(true);
  }

  function renderRows({ focus } = {}) {
    list.innerHTML = String(html`${rowsMarkup(rows, duration)}`);
    if (focus) {
      const element = rowEl(focus.uid)?.querySelector(focus.field === "start" ? ".edit-start" : ".edit-title");
      element?.focus({ preventScroll: true });
      element?.closest(".edit-row")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    lastCurrentUid = "";
    changed();
  }

  function setRowStart(uid, value, { fromControl = true } = {}) {
    const index = rowIndex(uid);
    if (index < 0) return;
    const next = round2(clampNum(value, 0, Math.max(0, duration - 0.1)));
    rows[index] = { ...rows[index], start: next, startFromControl: fromControl || rows[index].startFromControl };
    const input = rowEl(uid)?.querySelector(".edit-start");
    if (input) {
      input.value = formatPreciseTime(next);
      flash(input);
    }
    changed();
  }

  function flash(element) {
    element.classList.remove("is-flash");
    void element.offsetWidth; // restart the animation when the same field changes twice quickly
    element.classList.add("is-flash");
  }

  /* ---------------- player bridge */

  const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function liveTrack() {
    const track = player?.currentTrack;
    if (!track) return null;
    const owner = track.sourceId ?? player.currentSource?.id;
    return owner === source.id ? track : null;
  }

  function position() {
    if (!player) return 0;
    const value = typeof player.positionAt === "function" ? player.positionAt() : player.currentTime;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  async function seekTo(seconds, { play = false } = {}) {
    if (!player) return;
    const target = clampNum(seconds, 0, Math.max(0, duration - 0.05));
    let track = liveTrack();
    if (!track || target < Number(track.start) - 0.01 || target >= Number(track.end)) {
      const ok = await ctx.actions?.playCalibration?.(source.id);
      if (ok === false || disposed) return;
      track = liveTrack();
      if (!track) return;
    }
    await player.seekAbsolute?.(target);
    if (play && !player.isPlaying) await player.play?.();
    wake();
  }

  async function togglePlay() {
    if (!player && !ctx.actions?.playCalibration) return;
    if (liveTrack()) await player.toggle?.();
    else await ctx.actions?.playCalibration?.(source.id);
    wake();
  }

  /* ---------------- live clock (rAF while playing, a slow poll otherwise) */

  let frame = 0;
  let pollTimer = 0;
  let lastClock = "";
  let lastCaption = "";
  let lastPlaying = null;
  let lastRatio = -1;
  let lastCurrentUid = "";
  let lastLive = null;

  function syncCurrentRow(force = false) {
    const live = liveTrack();
    let uid = "";
    if (live) {
      const now = position();
      let best = -Infinity;
      for (const row of rows) {
        if (Number.isFinite(row.start) && row.start <= now + 0.05 && row.start > best) {
          best = row.start;
          uid = row.uid;
        }
      }
    }
    if (!force && uid === lastCurrentUid) return;
    if (lastCurrentUid !== uid || force) {
      list.querySelectorAll(".edit-row.is-current").forEach((element) => {
        if (element.dataset.uid !== uid) element.classList.remove("is-current");
      });
      if (uid) rowEl(uid)?.classList.add("is-current");
      lastCurrentUid = uid;
    }
  }

  function paint() {
    const live = liveTrack();
    const playing = Boolean(live && player?.isPlaying);
    const now = live ? position() : 0;
    const clock = formatPreciseTime(now);
    if (clock !== lastClock) {
      dom.clock.textContent = clock;
      lastClock = clock;
    }
    const caption = live ? `of ${formatTime(duration, duration >= 3600)}` : `Full recording · ${formatTime(duration, duration >= 3600)}`;
    if (caption !== lastCaption) {
      dom.caption.textContent = caption;
      lastCaption = caption;
    }
    if (live !== lastLive) {
      page.classList.toggle("is-live", Boolean(live));
      lastLive = live;
    }
    if (playing !== lastPlaying) {
      dom.play.classList.toggle("is-playing", playing);
      dom.play.setAttribute("aria-label", playing ? "Pause" : live ? "Play" : "Play full recording");
      dom.play.innerHTML = icon(playing ? "pause-fill" : "play-fill", { size: 22, className: "edit-play-icon" });
      lastPlaying = playing;
    }
    const ratio = duration > 0 ? clampNum(now / duration, 0, 1) : 0;
    if (Math.abs(ratio - lastRatio) > 0.0004) {
      dom.fill?.style.setProperty("--at", ratio.toFixed(5));
      dom.playhead?.style.setProperty("--at", ratio.toFixed(5));
      dom.timeline?.setAttribute("aria-valuenow", String(Math.round(now)));
      dom.timeline?.setAttribute("aria-valuetext", formatTime(now, now >= 3600));
      lastRatio = ratio;
    }
    syncCurrentRow();
    return playing;
  }

  function loop() {
    frame = 0;
    if (disposed) return;
    const playing = paint();
    if (playing) frame = requestAnimationFrame(loop);
    else pollTimer = setTimeout(() => {
      pollTimer = 0;
      if (!disposed && !frame) frame = requestAnimationFrame(loop);
    }, IDLE_POLL_MS);
  }

  function wake() {
    if (disposed) return;
    clearTimeout(pollTimer);
    pollTimer = 0;
    if (!frame) frame = requestAnimationFrame(loop);
  }

  /* ---------------- events */

  listen(list, "input", (event) => {
    const input = event.target;
    const element = input.closest?.(".edit-row");
    if (!element) return;
    const index = rowIndex(element.dataset.uid);
    if (index < 0) return;
    if (input.dataset.field === "title") {
      rows[index] = { ...rows[index], title: input.value };
    } else if (input.dataset.field === "start") {
      const parsed = parseTimeInput(input.value);
      const current = rows[index].start;
      // Typing back the value that is already shown keeps its hidden hundredths.
      const keep = Number.isFinite(current) && input.value.trim() === formatPreciseTime(current);
      rows[index] = { ...rows[index], start: keep ? current : parsed, text: input.value, startFromControl: false };
    }
    changed();
  });

  listen(list, "focusout", (event) => {
    const input = event.target;
    const element = input.closest?.(".edit-row");
    if (!element || !input.dataset?.field) return;
    const uid = element.dataset.uid;
    touched.add(`${uid}:${input.dataset.field}`);
    if (input.dataset.field === "start") {
      const row = rows[rowIndex(uid)];
      if (row && Number.isFinite(row.start)) input.value = formatPreciseTime(row.start);
    }
    refresh();
  });

  listen(list, "keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.field) return;
    const element = input.closest(".edit-row");
    if (event.key === "Enter") {
      event.preventDefault();
      const fields = [...list.querySelectorAll(".edit-title, .edit-start")];
      const next = fields[fields.indexOf(input) + 1];
      if (next) next.focus();
      else input.blur();
      return;
    }
    if (input.dataset.field === "start" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const row = rows[rowIndex(element.dataset.uid)];
      const base = Number.isFinite(row?.start) ? row.start : 0;
      const step = (event.shiftKey ? 1 : KEY_STEP) * (event.key === "ArrowUp" ? 1 : -1);
      setRowStart(element.dataset.uid, base + step, { fromControl: true });
    }
  });

  listen(list, "click", (event) => {
    const button = event.target.closest?.("button");
    const element = button?.closest(".edit-row");
    if (!button || !element || button.disabled) return;
    const uid = element.dataset.uid;
    const row = rows[rowIndex(uid)];
    if (!row) return;
    if (button.hasAttribute("data-nudge")) {
      const base = Number.isFinite(row.start) ? row.start : 0;
      setRowStart(uid, base + Number(button.dataset.nudge));
    } else if (button.hasAttribute("data-now")) {
      if (!liveTrack()) {
        ctx.actions?.toast?.("Play the recording first, then select Now when this song starts.");
        return;
      }
      setRowStart(uid, Math.round(position() * 10) / 10);
    } else if (button.hasAttribute("data-preview")) {
      if (!Number.isFinite(row.start)) return;
      seekTo(row.start, { play: true }).catch((error) => reportError(error));
    } else if (button.hasAttribute("data-remove")) {
      removeRow(uid);
    }
  });

  function removeRow(uid) {
    if (rows.length <= 1) return;
    const index = rowIndex(uid);
    if (index < 0) return;
    const [removed] = rows.splice(index, 1);
    const neighbour = rows[Math.min(index, rows.length - 1)];
    renderRows();
    // Focus a button, not a text field, so a phone keyboard doesn't pop up after deleting.
    const focusTarget = rowEl(neighbour.uid)?.querySelector(".edit-remove:not(:disabled)") || page.querySelector("[data-edit-add]");
    focusTarget?.focus({ preventScroll: true });
    const name = String(removed.title || "").trim();
    ctx.actions?.toast?.(name ? `Removed “${name}”` : "Removed a song", {
      actionLabel: "Undo",
      onAction: () => {
        if (disposed || rows.some((row) => row.uid === removed.uid)) return;
        rows.splice(Math.min(index, rows.length), 0, removed);
        renderRows({ focus: { uid: removed.uid, field: "title" } });
      }
    });
  }

  function addRow() {
    const live = liveTrack();
    const starts = rows.map((row) => row.start).filter(Number.isFinite);
    let start;
    if (live) {
      start = Math.round(position() * 10) / 10;
    } else {
      const last = starts.length ? Math.max(...starts) : 0;
      start = Math.round(last + Math.max(1, (duration - last) / 2));
    }
    start = clampNum(start, 0, Math.max(0, duration - 0.1));
    const taken = new Set(starts.map((value) => Math.round(value * 100)));
    while (taken.has(Math.round(start * 100)) && start < duration - 0.6) start = round2(start + NUDGE);
    const row = { uid: nextUid(), id: "", title: "", start: round2(start) };
    // Slot it in by time so the list keeps reading top to bottom.
    let index = rows.findIndex((entry) => Number.isFinite(entry.start) && entry.start > row.start);
    if (index < 0) index = rows.length;
    rows.splice(index, 0, row);
    renderRows({ focus: { uid: row.uid, field: "title" } });
  }

  function sortRows() {
    rows = [...rows].sort((a, b) => {
      const x = Number.isFinite(a.start) ? a.start : Infinity;
      const y = Number.isFinite(b.start) ? b.start : Infinity;
      return x - y;
    });
    renderRows();
  }

  listen(page.querySelector("[data-edit-add]"), "click", addRow);
  listen(dom.summary, "click", (event) => {
    if (event.target.closest?.("[data-edit-sort]")) sortRows();
  });
  listen(dom.play, "click", () => {
    togglePlay().catch((error) => reportError(error));
  });
  listen(dom.transport, "click", (event) => {
    const button = event.target.closest?.("[data-seek]");
    if (!button) return;
    const base = liveTrack() ? position() : 0;
    seekTo(base + Number(button.dataset.seek)).catch((error) => reportError(error));
  });

  // Timeline: tap/drag to scrub (the seek happens on release), arrows for keyboard users.
  let scrubbing = false;
  const ratioAt = (clientX) => {
    const rect = dom.timeline.getBoundingClientRect();
    return rect.width > 0 ? clampNum((clientX - rect.left) / rect.width, 0, 1) : 0;
  };
  const preview = (ratio) => {
    dom.fill?.style.setProperty("--at", ratio.toFixed(5));
    dom.playhead?.style.setProperty("--at", ratio.toFixed(5));
    dom.clock.textContent = formatPreciseTime(ratio * duration);
    lastClock = "";
    lastRatio = -1;
  };
  listen(dom.timeline, "pointerdown", (event) => {
    if (event.button !== 0) return;
    scrubbing = true;
    dom.timeline.setPointerCapture?.(event.pointerId);
    dom.timeline.classList.add("is-scrubbing");
    preview(ratioAt(event.clientX));
  });
  listen(dom.timeline, "pointermove", (event) => {
    if (scrubbing) preview(ratioAt(event.clientX));
  });
  const endScrub = (event, commit) => {
    if (!scrubbing) return;
    scrubbing = false;
    dom.timeline.classList.remove("is-scrubbing");
    if (commit) seekTo(ratioAt(event.clientX) * duration).catch((error) => reportError(error));
    else wake();
  };
  listen(dom.timeline, "pointerup", (event) => endScrub(event, true));
  listen(dom.timeline, "pointercancel", (event) => endScrub(event, false));
  listen(dom.timeline, "keydown", (event) => {
    const steps = { ArrowLeft: -SEEK_STEP, ArrowDown: -SEEK_STEP, ArrowRight: SEEK_STEP, ArrowUp: SEEK_STEP, PageDown: -30, PageUp: 30 };
    let target = null;
    if (event.key in steps) target = (liveTrack() ? position() : 0) + steps[event.key];
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = duration - 1;
    if (target === null) return;
    event.preventDefault();
    seekTo(target).catch((error) => reportError(error));
  });

  // Save / leave

  function leave() {
    allowLeave = true;
    const idx = Number(history.state?.acoustify?.idx);
    const back = page.querySelector("[data-edit-cancel]");
    if (Number.isFinite(idx) && idx > 0 && back) back.click();
    else ctx.navigate?.(`#/album/${encodeURIComponent(source.id)}`);
  }

  function setSaving(value) {
    saving = value;
    form.setAttribute("aria-busy", value ? "true" : "false");
    for (const button of dom.saves) {
      button.disabled = value || !isDirty();
      button.textContent = value ? "Saving…" : "Save";
    }
  }

  async function save() {
    if (saving) return;
    showAll = true;
    const check = refresh();
    if (!check.valid) {
      const first = list.querySelector(".edit-row.is-invalid");
      const field = first?.querySelector(".edit-start[aria-invalid='true']") || first?.querySelector(".edit-title[aria-invalid='true']");
      field?.focus({ preventScroll: true });
      first?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    let tracks;
    try {
      tracks = buildTracks(rows, source);
    } catch (error) {
      if (dom.summary) {
        dom.summary.dataset.tone = "error";
        dom.summary.textContent = error?.message || "These song times can't be saved.";
      }
      return;
    }
    const next = {
      id: source.id,
      title: source.title,
      artist: source.artist,
      description: source.description,
      year: source.year,
      tags: source.tags,
      duration,
      tracks,
      timingStatus: "user-calibrated",
      timingNote: "Song times edited on this device."
    };
    setSaving(true);
    try {
      await ctx.actions.saveSourceOverride(next);
    } catch (error) {
      if (disposed) return;
      setSaving(false);
      const message = error?.message || "Couldn't save the song times.";
      if (dom.summary) {
        dom.summary.dataset.tone = "error";
        dom.summary.textContent = message;
      }
      ctx.actions?.toast?.(message, { type: "error" });
      return;
    }
    clearDraft(source.id);
    baseline = rowsSignature(rows); // saved: nothing left to warn about or keep as a draft
    if (disposed) return;
    setSaving(false);
    for (const button of dom.saves) button.disabled = true;
    leave();
  }

  listen(form, "submit", (event) => {
    event.preventDefault();
    save().catch((error) => reportError(error));
  });

  // Cancel with unsaved edits asks first; the go-back action then runs through the controller.
  listen(page, "click", async (event) => {
    const cancel = event.target.closest?.("[data-edit-cancel]");
    if (!cancel || allowLeave || !isDirty() || saving) return;
    event.preventDefault();
    const ok = await (ctx.actions?.confirm?.({ title: "Discard your changes?", body: "Your song-time edits won't be saved.", confirmLabel: "Discard", danger: true }) ?? Promise.resolve(true));
    if (!ok || disposed) return;
    clearDraft(source.id);
    rows = initial.libraryRows.map((row) => ({ ...row }));
    allowLeave = true;
    cancel.click();
  });

  listen(page.querySelector("[data-edit-discard]"), "click", () => {
    clearDraft(source.id);
    rows = initial.libraryRows.map((row) => ({ ...row, uid: nextUid() }));
    touched.clear();
    showAll = false;
    page.querySelector("[data-edit-draft]")?.remove();
    renderRows();
  });

  listen(page.querySelector("[data-edit-reset]"), "click", async () => {
    const ok = await ctx.actions?.confirm?.({
      title: "Reset song times?",
      body: `“${source.title}” will go back to the song times from your library.`,
      confirmLabel: "Reset",
      danger: true
    });
    if (!ok || disposed) return;
    try {
      await ctx.actions.resetSource(source.id);
    } catch (error) {
      reportError(error);
      return;
    }
    clearDraft(source.id);
    rows = initial.libraryRows;
    allowLeave = true;
    // Re-render this page from the fresh catalog.
    ctx.navigate?.(`#/edit/${encodeURIComponent(source.id)}`);
  });

  function reportError(error) {
    console.error(error);
    ctx.actions?.toast?.(error?.message || "Something went wrong.", { type: "error" });
  }

  const onVisibility = () => {
    if (document.visibilityState === "hidden") persistDraft();
    else wake();
  };
  listen(document, "visibilitychange", onVisibility);
  listen(window, "pagehide", persistDraft);

  refresh();
  wake();

  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(pollTimer);
    const dirty = isDirty() && !allowLeave;
    persistDraft();
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        console.error(error);
      }
    }
    const stillHere = typeof location !== "undefined" && location.hash.startsWith(`#/edit/${encodeURIComponent(source.id)}`);
    if (dirty && !stillHere) {
      ctx.actions?.toast?.("Your song-time edits were kept for later.", {
        actionLabel: "Open",
        onAction: () => ctx.navigate?.(`#/edit/${encodeURIComponent(source.id)}`)
      });
    }
  };
}
