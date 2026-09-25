// Settings: calm grouped rows in the iOS style. The page itself is a pure string builder;
// after(root) adds what has to be live: the token form (inline feedback + reveal toggle),
// download progress, the measured storage figure, the "Updated …" clock and ?focus=library.
import { CONFIG } from "../config.js";
import { icon } from "../icons.js";
import { html, raw } from "../ui.js";
import { formatBytes, joinMeta, pluralize, relativeDate } from "../utils.js";
import { pageTop } from "./library.js";

const LEAD_IN_OPTIONS = [0, 0.5, 1, 1.5, 2, 3];
const TOKEN_PATTERN = /hf_[A-Za-z0-9]{8,}/;

/* ------------------------------------------------------------------ pure helpers */

export { formatBytes };

export function shortRevision(revision) {
  const text = String(revision || "").trim();
  if (!text) return "";
  return /^[0-9a-f]{12,}$/i.test(text) ? text.slice(0, 7) : text.slice(0, 12);
}

// A pasted deep link, "Bearer hf_…" or a token with stray spaces all reduce to the token itself.
export function extractToken(text) {
  const value = String(text ?? "").trim();
  const match = value.match(TOKEN_PATTERN);
  return match ? match[0] : value;
}

function isOnline(ctx) {
  if (typeof ctx.online === "boolean") return ctx.online;
  if (typeof ctx.offline === "boolean") return !ctx.offline;
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// The download store (cloud.OfflineStore): spec'd as ctx.offline, the controller may expose it as ctx.downloads.
function downloadStore(ctx) {
  for (const candidate of [ctx.downloads, ctx.offline]) {
    if (candidate && typeof candidate === "object" && typeof candidate.isDownloaded === "function") return candidate;
  }
  return null;
}

// Wording for someone who never needs to know what a token or a revision is.
export function describeLibrary(syncStatus = {}, { online = true } = {}) {
  const status = syncStatus || {};
  const hasToken = Boolean(status.hasToken);
  const state = status.state || "idle";
  const updated = status.lastSyncedAt ? `Updated ${relativeDate(status.lastSyncedAt)}` : "";
  if (!hasToken) {
    return { tone: "off", iconName: "cloud-off", title: "Not connected", detail: "Add your access token to play your music.", connected: false, canSync: false };
  }
  if (state === "unauthorized") {
    return { tone: "warn", iconName: "alert", title: "Token not accepted", detail: "Your access token no longer opens the library. Paste a new one below.", connected: false, canSync: false };
  }
  if (!online || state === "offline") {
    return { tone: "off", iconName: "cloud-off", title: "Offline", detail: joinMeta(["Downloaded music still plays", updated]), connected: true, canSync: false };
  }
  if (state === "syncing") {
    return { tone: "busy", iconName: "refresh", title: "Checking for new music…", detail: updated || "This only takes a moment.", connected: true, canSync: false, syncing: true };
  }
  if (state === "error") {
    return { tone: "warn", iconName: "alert", title: "Couldn't reach your library", detail: joinMeta(["Acoustify will try again soon", updated]), connected: true, canSync: true };
  }
  return { tone: "ok", iconName: "cloud", title: "Connected", detail: updated || "Your music is up to date.", connected: true, canSync: true };
}

function downloadableSources(ctx) {
  const sources = Array.isArray(ctx.catalog?.sources) ? ctx.catalog.sources : [];
  return sources.filter((source) => {
    if (!source?.audioUrl || source.provider === "youtube" || source.assetId) return false;
    const state = typeof ctx.downloadState === "function" ? ctx.downloadState(source.id) : null;
    return state?.available !== false;
  });
}

// Everything the Downloads rows show, derived from ctx.downloadState (live) and library byte counts.
export function downloadSummary(ctx) {
  const sources = downloadableSources(ctx);
  const summary = { count: sources.length, done: 0, busy: 0, totalBytes: 0, doneBytes: 0, pendingBytes: 0, progress: 0 };
  let movingBytes = 0;
  let movingUnits = 0;
  for (const source of sources) {
    const bytes = Math.max(0, Number(source.bytes) || 0);
    const info = typeof ctx.downloadState === "function" ? ctx.downloadState(source.id) || {} : {};
    summary.totalBytes += bytes;
    if (info.state === "done") {
      summary.done += 1;
      summary.doneBytes += bytes;
      continue;
    }
    summary.pendingBytes += bytes;
    if (info.state === "downloading" || info.state === "queued") {
      summary.busy += 1;
      const fraction = Math.min(1, Math.max(0, Number(info.progress) || 0));
      movingBytes += bytes * fraction;
      movingUnits += fraction;
    }
  }
  if (summary.count) {
    summary.progress = summary.totalBytes
      ? (summary.doneBytes + movingBytes) / summary.totalBytes
      : (summary.done + movingUnits) / summary.count;
  }
  return summary;
}

function downloadAllText(summary) {
  if (!summary.count) return "Nothing to download yet.";
  if (summary.busy) {
    const position = Math.min(summary.count, summary.done + 1);
    return `Downloading ${position} of ${summary.count} · ${Math.floor(summary.progress * 100)}%`;
  }
  if (summary.done === summary.count) return `All ${pluralize(summary.count, "album")} are on this device.`;
  const left = summary.count - summary.done;
  return joinMeta([summary.done ? `${left} of ${summary.count} albums left` : pluralize(summary.count, "album"), summary.pendingBytes ? formatBytes(summary.pendingBytes) : ""]);
}

function versionLabel(version) {
  const text = String(version || "").trim();
  if (!text || text === "dev") return "Development";
  return text;
}

function hasWakeLock() {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/* ------------------------------------------------------------------ markup pieces */

function group({ id, title, rows, note = "", className = "" }) {
  const titleId = `${id}-title`;
  return html`<section class="settings-group${className ? ` ${className}` : ""}" id="${id}" aria-labelledby="${titleId}"><h2 class="settings-group-title" id="${titleId}">${title}</h2><div class="list-group">${rows}</div>${note ? html`<p class="settings-note">${note}</p>` : ""}</section>`;
}

function rowLabel(title, sub = "", { titleId = "", subId = "", subAttrs = "" } = {}) {
  return html`<span class="list-row-label"><span class="settings-row-title"${titleId ? html` id="${titleId}"` : ""}>${title}</span>${sub ? html`<small${subId ? html` id="${subId}"` : ""}${raw(subAttrs)}>${sub}</small>` : ""}</span>`;
}

function toggleRow({ key, title, sub = "", checked = false, disabled = false }) {
  const id = `setting-${key}`;
  return html`<label class="list-row settings-toggle-row${disabled ? " is-disabled" : ""}" for="${id}">${rowLabel(title, sub, { titleId: `${id}-label`, subId: sub ? `${id}-sub` : "" })}<input class="toggle" type="checkbox" role="switch" id="${id}" data-setting="${key}" aria-labelledby="${id}-label"${sub ? html` aria-describedby="${id}-sub"` : ""}${checked ? raw(" checked") : ""}${disabled ? raw(" disabled") : ""}></label>`;
}

function actionRow({ action, title, sub = "", tone = "", trailing = "", attrs = "" }) {
  return html`<button class="list-row settings-action${tone ? ` settings-action--${tone}` : ""}" type="button" data-action="${action}"${raw(attrs)}>${rowLabel(title, sub)}${trailing}</button>`;
}

function infoRow({ title, sub = "", detail = "", detailAttrs = "", className = "" }) {
  return html`<div class="list-row${className ? ` ${className}` : ""}">${rowLabel(title, sub)}${detail !== "" ? html`<span class="list-row-detail"${raw(detailAttrs)}>${detail}</span>` : ""}</div>`;
}

const SPINNER = raw('<span class="settings-spinner" aria-hidden="true"></span>');

function statusRow(info, syncStatus) {
  const revision = shortRevision(syncStatus?.revision);
  // While a sync runs the spinning tile says so; the button returns when it's done.
  const syncButton = info.connected && !info.syncing
    ? html`<span class="list-row-control"><button class="btn btn-secondary btn-sm settings-sync" type="button" data-action="sync-now"${info.canSync ? "" : raw(" disabled")}>Sync now</button></span>`
    : "";
  const updatedAttr = syncStatus?.lastSyncedAt ? html` data-updated-at="${Number(syncStatus.lastSyncedAt)}"` : "";
  return html`<div class="list-row settings-status settings-status--${info.tone}" data-library-status><span class="list-row-icon settings-status-icon" aria-hidden="true">${icon(info.iconName, { size: 20 })}</span><span class="list-row-label"><span class="settings-row-title settings-status-title">${info.title}</span><small><span data-status-detail${updatedAttr}>${info.detail}</span>${revision && info.connected ? html`<span class="settings-rev" title="Library version"> · <span class="settings-rev-sha">${revision}</span></span>` : ""}</small></span>${syncButton}</div>`;
}

function tokenForm({ autofocusHint = false } = {}) {
  const helpUrl = CONFIG.TOKEN_HELP_URL || "https://huggingface.co/settings/tokens";
  return html`<form class="settings-token-form" data-form="token" novalidate autocomplete="off"><label class="field-label" for="settings-token">Access token</label><div class="settings-token-field"><input class="input settings-token-input" id="settings-token" name="token" type="password" placeholder="hf_…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" data-1p-ignore data-lpignore="true" aria-describedby="settings-token-help settings-token-message"${autofocusHint ? raw(' data-focus-target=""') : ""}><button class="settings-reveal" type="button" data-token-reveal aria-controls="settings-token" aria-pressed="false" aria-label="Show token">Show</button></div><p class="field-hint settings-token-help" id="settings-token-help">Use a fine-grained, read-only Hugging Face token that can open only your music library. It stays on this device.</p><p class="settings-token-message" id="settings-token-message" role="status" aria-live="polite" hidden></p><div class="settings-token-actions"><button class="btn btn-primary" type="submit" data-token-submit disabled>Connect</button><a class="btn btn-ghost settings-token-link" href="${helpUrl}" target="_blank" rel="noopener noreferrer">Create a token${icon("external", { size: 16 })}</a></div></form>`;
}

/* ------------------------------------------------------------------ groups */

function libraryGroup(ctx, info) {
  const rows = [statusRow(info, ctx.syncStatus)];
  let note;
  if (info.connected) {
    rows.push(html`<details class="settings-token" data-token-details><summary class="list-row settings-token-summary">${rowLabel("Access token", "Saved on this device")}<span class="list-row-detail settings-token-change">Change${icon("chevron-down", { size: 18 })}</span></summary><div class="settings-token-body">${tokenForm()}</div></details>`);
    rows.push(actionRow({ action: "disconnect-library", title: "Disconnect", tone: "danger" }));
    note = "New music shows up by itself whenever you open Acoustify.";
  } else {
    rows.push(html`<div class="list-row list-row--stack settings-token-row">${tokenForm({ autofocusHint: true })}</div>`);
    note = "Your token is only ever sent to Hugging Face, to open your private library.";
  }
  return group({ id: "settings-library", title: "Library", rows, note });
}

function offlineGroup(ctx, info) {
  const summary = downloadSummary(ctx);
  const allDone = summary.count > 0 && summary.done === summary.count;
  const store = downloadStore(ctx);
  // Downloads need the library's access token; until it is connected the row only says so.
  const needsConnect = !info.connected && !summary.busy && !allDone;
  let control;
  if (needsConnect) {
    control = html`<button class="btn btn-secondary btn-sm" type="button" data-action="download-all" disabled>Download</button>`;
  } else if (summary.busy) {
    control = store && typeof store.cancelAll === "function"
      ? html`<button class="btn btn-secondary btn-sm" type="button" data-downloads-stop>Stop</button>`
      : html`<span class="settings-inline-status">${SPINNER}</span>`;
  } else if (allDone) {
    control = html`<span class="settings-done" aria-label="Done">${icon("check", { size: 20 })}</span>`;
  } else {
    control = html`<button class="btn btn-secondary btn-sm" type="button" data-action="download-all"${summary.count ? "" : raw(" disabled")}>Download</button>`;
  }
  const progressHidden = summary.busy ? "" : raw(" hidden");
  const rows = [
    html`<div class="list-row settings-download-row" data-download-all-row${needsConnect ? raw(" data-needs-connect") : ""}>${rowLabel("Download all music", needsConnect ? "Connect your library first." : downloadAllText(summary), { subAttrs: " data-download-all-text" })}<span class="list-row-control" data-download-all-control>${control}</span><span class="settings-progress" style="--progress: ${summary.progress.toFixed(4)}" data-download-all-progress aria-hidden="true"${progressHidden}></span></div>`,
    toggleRow({ key: "autoDownload", title: "Download new music automatically", sub: "New albums are saved to this device as soon as they arrive.", checked: Boolean(ctx.settings?.autoDownload) }),
    infoRow({
      title: "Used on this device",
      sub: summary.done ? `${pluralize(summary.done, "album")} downloaded` : "Nothing downloaded yet",
      detail: formatBytes(summary.doneBytes),
      detailAttrs: " data-storage-used"
    })
  ];
  if (summary.done || summary.busy) {
    rows.push(actionRow({ action: "remove-all-downloads", title: "Remove all downloads", tone: "danger" }));
  }
  return group({ id: "settings-offline", title: "Downloads", rows, note: "Downloaded music plays anywhere, even in airplane mode." });
}

function playbackGroup(ctx) {
  const settings = ctx.settings || {};
  const sources = Array.isArray(ctx.catalog?.sources) ? ctx.catalog.sources : [];
  const rows = [toggleRow({ key: "autoplay", title: "Continuous play", sub: "Keep going to the next song on the album.", checked: settings.autoplay !== false })];
  if (sources.some((source) => source?.provider === "youtube")) {
    const leadIn = Number.isFinite(Number(settings.segmentLeadIn)) ? Number(settings.segmentLeadIn) : 0.5;
    const options = LEAD_IN_OPTIONS.includes(leadIn) ? LEAD_IN_OPTIONS : [...LEAD_IN_OPTIONS, leadIn].sort((a, b) => a - b);
    const wakeLock = hasWakeLock();
    rows.push(toggleRow({ key: "playerPanelOpen", title: "Show YouTube video", sub: "Show the video next to the music on larger screens.", checked: Boolean(settings.playerPanelOpen) }));
    rows.push(html`<div class="list-row settings-select-row"><label class="list-row-label" for="setting-segmentLeadIn"><span class="settings-row-title">Start YouTube songs early</span><small>Avoids clipping the first note.</small></label><span class="list-row-control"><select class="input settings-select" id="setting-segmentLeadIn" data-setting="segmentLeadIn">${options.map((value) => html`<option value="${value}"${value === leadIn ? raw(" selected") : ""}>${value === 0 ? "Off" : `${value} sec`}</option>`)}</select></span></div>`);
    rows.push(toggleRow({
      key: "keepScreenAwake",
      title: "Keep screen on for YouTube",
      sub: wakeLock ? "Stops your phone locking while a video plays." : "Not available in this browser.",
      checked: wakeLock && Boolean(settings.keepScreenAwake),
      disabled: !wakeLock
    }));
  }
  return group({ id: "settings-playback", title: "Playback", rows });
}

function appGroup(ctx) {
  const install = ctx.install || {};
  const rows = [infoRow({ title: "Version", detail: versionLabel(ctx.appVersion ?? CONFIG.APP_VERSION) })];
  if (ctx.updateWaiting) {
    rows.push(html`<div class="list-row settings-update-row">${rowLabel("Update ready", "Restart to get the newest version.")}<span class="list-row-control"><button class="btn btn-primary btn-sm" type="button" data-action="apply-update">Restart</button></span></div>`);
  } else {
    rows.push(actionRow({ action: "check-updates", title: "Check for updates", sub: "Updates also install on their own.", trailing: icon("refresh", { size: 18, className: "settings-trailing-icon" }) }));
  }
  if (install.installed) {
    rows.push(html`<div class="list-row">${rowLabel("Installed on this device")}<span class="settings-done" aria-hidden="true">${icon("check", { size: 20 })}</span></div>`);
  } else if (install.canPrompt) {
    rows.push(actionRow({ action: "install-app", title: "Install Acoustify", sub: "Opens full screen from your home screen.", tone: "accent" }));
  } else {
    rows.push(infoRow({
      title: "Add to Home Screen",
      sub: isIOS() ? "In Safari, tap Share, then Add to Home Screen." : "Use your browser menu and choose Install or Add to Home Screen."
    }));
  }
  return group({ id: "settings-app", title: "App", rows });
}

function dataGroup() {
  const rows = [
    actionRow({ action: "export-backup", title: "Export backup", sub: "Save likes, playlists, history and song-time edits to a file." }),
    actionRow({ action: "import-backup", title: "Import backup", sub: "Restore from a backup file." }),
    actionRow({ action: "reset-app", title: "Reset Acoustify", sub: "Erase likes, playlists, history and edits on this device.", tone: "danger" })
  ];
  return group({ id: "settings-data", title: "Your data", rows, note: "Backups never include the music itself or your access token." });
}

/* ------------------------------------------------------------------ view */

export function renderSettings(ctx, route) {
  const info = describeLibrary(ctx.syncStatus, { online: isOnline(ctx) });
  // Settings is pushed from the gear on Home and Library, so phones get a way back (desktop: sidebar).
  const markup = html`<div class="page settings-page">${pageTop({ mobileOnly: true })}<div class="page-title-row"><h1>Settings</h1></div><div class="settings">${libraryGroup(ctx, info)}${offlineGroup(ctx, info)}${playbackGroup(ctx)}${appGroup(ctx)}${dataGroup()}</div></div>`;
  return {
    title: "Settings",
    html: markup,
    after: (root) => wireSettings(root, ctx, route)
  };
}

/* ------------------------------------------------------------------ interactivity */

function wireSettings(root, ctx, route) {
  const page = root.querySelector(".settings-page") || root;
  const disposers = [];
  let disposed = false;
  const listen = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  };

  for (const form of page.querySelectorAll("form[data-form='token']")) wireTokenForm(form, ctx, listen, () => disposed);
  wireDownloads(page, ctx, listen, disposers);
  refreshStorageFigure(page, ctx, () => disposed);
  keepRelativeTimeFresh(page, disposers);
  if (route?.params?.get?.("focus") === "library") focusTokenInput(page);

  return () => {
    disposed = true;
    while (disposers.length) {
      try {
        disposers.pop()();
      } catch (error) {
        console.error(error);
      }
    }
  };
}

function wireTokenForm(form, ctx, listen, isDisposed) {
  const input = form.elements.token;
  const submit = form.querySelector("[data-token-submit]");
  const reveal = form.querySelector("[data-token-reveal]");
  const message = form.querySelector(".settings-token-message");
  if (!input || !submit) return;
  let busy = false;

  const setMessage = (text, tone = "") => {
    if (!message) return;
    message.textContent = text || "";
    message.hidden = !text;
    message.dataset.tone = tone;
  };
  const syncSubmit = () => {
    submit.disabled = busy || !input.value.trim();
  };

  listen(input, "input", () => {
    input.removeAttribute("aria-invalid");
    if (message?.dataset.tone === "error") setMessage("");
    syncSubmit();
  });
  listen(input, "paste", () => {
    // Let the paste land first, then keep only the token part of whatever was copied.
    setTimeout(() => {
      const cleaned = extractToken(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      syncSubmit();
    }, 0);
  });
  listen(reveal, "click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    reveal.textContent = show ? "Hide" : "Show";
    reveal.setAttribute("aria-pressed", show ? "true" : "false");
    reveal.setAttribute("aria-label", show ? "Hide token" : "Show token");
    const end = input.value.length;
    input.focus({ preventScroll: true });
    try {
      input.setSelectionRange(end, end);
    } catch {
      // Some input types refuse selection APIs; the caret position is cosmetic.
    }
  });

  // Handled here (not by the controller's fallback) so a failure can be explained right under the field.
  listen(form, "submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const token = extractToken(input.value);
    if (!token) {
      setMessage("Paste your access token first.", "error");
      input.focus();
      return;
    }
    busy = true;
    form.setAttribute("aria-busy", "true");
    input.readOnly = true;
    submit.disabled = true;
    submit.innerHTML = `${SPINNER}Connecting`;
    setMessage("");
    let result;
    try {
      result = await ctx.actions?.setToken?.(token);
    } catch (error) {
      result = { ok: false, message: error?.message || "" };
    }
    if (!result || typeof result !== "object") result = { ok: false, message: "" };
    busy = false;
    form.removeAttribute("aria-busy");
    input.readOnly = false;
    submit.textContent = "Connect";
    syncSubmit();
    const text = result.message || (result.ok ? "Library connected" : "That token didn't work. Check it and try again.");
    if (result.ok) {
      ctx.actions?.toast?.(text, { type: "success" });
      if (isDisposed()) return;
      input.value = "";
      input.type = "password";
      syncSubmit();
      setMessage(text, "success");
      input.blur();
      const details = form.closest("details");
      if (details) details.open = false;
    } else if (isDisposed()) {
      ctx.actions?.toast?.(text, { type: "error" });
    } else {
      setMessage(text, "error");
      input.setAttribute("aria-invalid", "true");
      input.focus();
      input.select?.();
    }
  });
  syncSubmit();
}

function wireDownloads(page, ctx, listen, disposers) {
  const row = page.querySelector("[data-download-all-row]");
  if (!row) return;
  const store = downloadStore(ctx);
  const text = row.querySelector("[data-download-all-text]");
  const bar = row.querySelector("[data-download-all-progress]");
  const control = row.querySelector("[data-download-all-control]");

  listen(row, "click", (event) => {
    if (!event.target.closest?.("[data-downloads-stop]")) return;
    event.preventDefault();
    store?.cancelAll?.();
  });

  // Nothing can download before the library is connected; connecting re-renders this page.
  if (!store || typeof store.addEventListener !== "function" || row.hasAttribute("data-needs-connect")) return;
  let frame = 0;
  let wasBusy = row.querySelector("[data-downloads-stop], .settings-inline-status") !== null;
  const update = () => {
    frame = 0;
    const summary = downloadSummary(ctx);
    if (text) text.textContent = downloadAllText(summary);
    if (bar) {
      bar.hidden = !summary.busy;
      bar.style.setProperty("--progress", summary.progress.toFixed(4));
    }
    const busy = summary.busy > 0;
    if (control && busy !== wasBusy) {
      // Swap only the button so focus is not thrown away mid-download.
      control.innerHTML = busy
        ? (typeof store.cancelAll === "function" ? '<button class="btn btn-secondary btn-sm" type="button" data-downloads-stop>Stop</button>' : `<span class="settings-inline-status">${SPINNER}</span>`)
        : summary.count && summary.done === summary.count
          ? `<span class="settings-done" aria-label="Done">${icon("check", { size: 20 })}</span>`
          : '<button class="btn btn-secondary btn-sm" type="button" data-action="download-all">Download</button>';
      wasBusy = busy;
    }
  };
  const onChange = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  listen(store, "change", onChange);
  disposers.push(() => {
    if (frame) cancelAnimationFrame(frame);
  });
}

async function refreshStorageFigure(page, ctx, isDisposed) {
  const target = page.querySelector("[data-storage-used]");
  if (!target) return;
  let usage = null;
  try {
    if (typeof ctx.storageUsage === "function") usage = await ctx.storageUsage();
    else usage = await downloadStore(ctx)?.usage?.();
  } catch {
    usage = null;
  }
  if (isDisposed() || !target.isConnected || !usage) return;
  const bytes = Number(usage.bytes);
  if (Number.isFinite(bytes) && bytes > 0) target.textContent = formatBytes(bytes);
}

function keepRelativeTimeFresh(page, disposers) {
  const target = page.querySelector("[data-updated-at]");
  if (!target || typeof setInterval !== "function") return;
  const stamp = Number(target.dataset.updatedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return;
  const timer = setInterval(() => {
    if (!target.isConnected) return;
    const current = target.textContent;
    const next = current.replace(/Updated .+$/, `Updated ${relativeDate(stamp)}`);
    if (next !== current) target.textContent = next;
  }, 30_000);
  disposers.push(() => clearInterval(timer));
}

function focusTokenInput(page) {
  const section = page.querySelector("#settings-library");
  const details = section?.querySelector("details[data-token-details]");
  if (details) details.open = true;
  const input = section?.querySelector("input[name='token']");
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  section?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  input?.focus({ preventScroll: true });
  section?.classList.add("is-highlighted");
  setTimeout(() => section?.classList.remove("is-highlighted"), 1600);
}
