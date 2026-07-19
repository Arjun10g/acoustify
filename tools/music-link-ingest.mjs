import { parseChapterLines, validateCatalog } from "../assets/js/catalog.js";
import { formatTime, parseTimecode, parseYouTubeId, slugify, unique } from "../assets/js/utils.js";

const SKIP_STATUSES = new Set(["skip", "skipped", "done", "imported"]);

function clean(value) {
  return String(value ?? "").trim();
}

function firstValue(entry, names) {
  for (const name of names) {
    if (entry[name] !== undefined && entry[name] !== null && clean(entry[name])) return entry[name];
  }
  return "";
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return unique(tags.map(clean));
  return unique(clean(tags).split(",").map(clean));
}

function normalizeChapterTime(value) {
  const raw = clean(value);
  if (raw.includes(":")) return raw;
  const seconds = parseTimecode(value);
  if (!Number.isFinite(seconds)) return raw;
  return formatTime(seconds, seconds >= 3600);
}

function chapterArrayToText(chapters) {
  return chapters.map((chapter, index) => {
    if (typeof chapter === "string") return chapter.trim();
    if (!chapter || typeof chapter !== "object") throw new Error(`Chapter ${index + 1} must be a string or object.`);
    const start = firstValue(chapter, ["start", "time", "at"]);
    const title = firstValue(chapter, ["title", "name"]);
    if (!clean(start) || !clean(title)) throw new Error(`Chapter ${index + 1} needs start and title.`);
    return `${normalizeChapterTime(start)} ${clean(title)}`;
  }).filter(Boolean).join("\n");
}

function chapterTextForEntry(entry, fallbackTitle) {
  const chapters = entry.chapters ?? entry.tracks ?? entry.trackStarts;
  if (Array.isArray(chapters)) return chapterArrayToText(chapters);
  const text = clean(chapters);
  return text || `0:00 ${fallbackTitle}`;
}

export function getMusicLinkEntries(payload) {
  const links = Array.isArray(payload) ? payload : payload?.links;
  if (!Array.isArray(links)) throw new Error("Music links file must contain a top-level links array.");
  return links
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && typeof entry === "object")
    .filter(({ entry }) => entry.skip !== true && !SKIP_STATUSES.has(clean(entry.status).toLowerCase()));
}

export function sourceFromMusicLink(entry, index = 0) {
  const url = firstValue(entry, ["url", "youtubeUrl", "youtubeInput", "youtubeId"]);
  const youtubeId = parseYouTubeId(url);
  if (!youtubeId) throw new Error(`Link ${index + 1} needs a valid YouTube URL or 11-character video id.`);

  const title = clean(firstValue(entry, ["title", "sourceTitle", "album"]));
  const artist = clean(firstValue(entry, ["artist", "creator", "channel"]));
  if (!title) throw new Error(`Link ${index + 1} needs a title.`);
  if (!artist) throw new Error(`Link ${index + 1} needs an artist.`);

  const durationValue = firstValue(entry, ["duration", "fullDuration", "length", "durationSeconds"]);
  const duration = parseTimecode(durationValue);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Link ${index + 1} needs a positive duration such as 4:12 or 42:30.`);

  const tracks = parseChapterLines(chapterTextForEntry(entry, title), duration);
  const source = {
    id: clean(entry.id) || slugify(`${artist}-${title}`),
    title,
    artist,
    provider: "youtube",
    youtubeId,
    duration,
    artwork: clean(entry.artwork) || `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`,
    fallbackArtwork: clean(entry.fallbackArtwork) || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    description: clean(entry.description) || "Imported from a provided YouTube link.",
    timingStatus: clean(entry.timingStatus) || (tracks.length === 1 ? "single-track" : "user-calibrated"),
    timingNote: clean(entry.timingNote) || "Imported through the repository music-link intake. Adjust in Catalog Studio if a cut is off.",
    tags: normalizeTags(entry.tags),
    tracks
  };

  const year = Number(entry.year);
  if (Number.isInteger(year) && year > 0) source.year = year;
  validateCatalog({ version: 1, sources: [source] });
  return source;
}

export function applyMusicLinksToCatalog(catalog, entries, options = {}) {
  const imported = entries.map(({ entry, index }) => sourceFromMusicLink(entry, index));
  const sources = catalog.sources.map((source) => structuredClone(source));
  const summary = { added: [], updated: [], skipped: [] };

  for (const source of imported) {
    const existingIndex = sources.findIndex((item) => item.id === source.id || item.youtubeId === source.youtubeId);
    if (existingIndex >= 0) {
      const existing = sources[existingIndex];
      const shouldReplace = options.replace || entries.find(({ entry }) => clean(entry.id) === source.id || parseYouTubeId(firstValue(entry, ["url", "youtubeUrl", "youtubeInput", "youtubeId"])) === source.youtubeId)?.entry.replace === true;
      if (!shouldReplace) throw new Error(`${source.title} already exists as ${existing.id}. Set "replace": true on that link or pass --replace.`);
      sources[existingIndex] = source;
      summary.updated.push(source.id);
    } else {
      sources.push(source);
      summary.added.push(source.id);
    }
  }

  const nextCatalog = {
    ...catalog,
    generatedAt: new Date().toISOString().slice(0, 10),
    sources
  };
  validateCatalog(nextCatalog);
  return { catalog: nextCatalog, summary };
}
