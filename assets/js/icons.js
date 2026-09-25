// Icon helper for the SVG sprite in index.html (<symbol id="i-NAME">).
// Returns a plain markup string; ui.html`` recognises this exact shape and never escapes it.

export const ICON_NAMES = Object.freeze([
  "home", "search", "library", "artists", "songs", "series", "settings",
  "play", "pause", "prev", "next", "shuffle", "repeat", "repeat-one",
  "heart", "heart-fill", "more", "plus", "check", "close",
  "chevron-down", "chevron-left", "chevron-right",
  "download", "downloaded", "queue", "volume", "volume-mute",
  "edit", "external", "refresh", "cloud", "cloud-off", "trash", "clock", "disc",
  "sort", "info", "alert", "key", "mic", "sparkle", "arrow-up", "arrow-down",
  "list", "grid", "play-fill", "pause-fill"
]);

const ATTR_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (char) => ATTR_ESCAPES[char]);
}

function cleanClassName(value) {
  return String(value || "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, " ");
}

export function icon(name, { size = 24, className = "", label = "" } = {}) {
  const id = String(name || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const px = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.round(Number(size)) : 24;
  const classes = ["icon", `icon-${id}`, cleanClassName(className)].filter(Boolean).join(" ");
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true"';
  return `<svg class="${classes}" width="${px}" height="${px}" ${a11y} focusable="false"><use href="#i-${id}"></use></svg>`;
}

// Used by ui.html`` to pass icon() output (or several concatenated) through untouched. Only the exact
// shape icon() emits matches, and that shape can only reference a sprite symbol, so a lookalike is harmless.
const ICON_MARKUP = /^(?:<svg class="icon icon-[a-z0-9-]*(?: [\w -]*)?" width="\d+" height="\d+" (?:aria-hidden="true"|role="img" aria-label="[^"<>]*") focusable="false"><use href="#i-[a-z0-9-]*"><\/use><\/svg>)+$/;

export function isIconMarkup(value) {
  return typeof value === "string" && value.length < 2000 && ICON_MARKUP.test(value);
}
