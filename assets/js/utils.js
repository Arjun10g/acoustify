export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function slugify(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `item-${crypto.randomUUID().slice(0, 8)}`;
}

export function formatTime(seconds, includeHours = false) {
  const safe = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (includeHours || hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function parseTimecode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length > 3) return NaN;
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return Math.max(0, parts[0]);
}

export function parseYouTubeId(input = "") {
  const value = String(input).trim();
  const valid = (candidate) => (/^[\w-]{11}$/.test(candidate || "") ? candidate : "");
  if (valid(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be" || url.hostname.endsWith(".youtu.be")) {
      return valid(url.pathname.split("/").filter(Boolean)[0]);
    }
    if (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) {
      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/") || url.pathname.startsWith("/live/")) {
        return valid(url.pathname.split("/").filter(Boolean)[1]);
      }
      return valid(url.searchParams.get("v"));
    }
  } catch {
    return "";
  }
  return "";
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function debounce(fn, wait = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function relativeDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000]
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return "just now";
}

export function safeArtwork(source) {
  return source?.artwork || source?.fallbackArtwork || "./assets/icons/icon-512.png";
}

export function deepClone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
