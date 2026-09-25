#!/usr/bin/env node
// Validates data/catalog.json against catalog schema version 5 (see data/catalog.schema.json).
//
//   node tools/validate-catalog.mjs                 structural checks only (what CI runs)
//   node tools/validate-catalog.mjs --local         also checks library/<audio> and library/<artwork>
//   node tools/validate-catalog.mjs --catalog=path  validate another catalog file
//
// Plain Node (>=20), no dependencies and no browser globals. Import validateCatalog() to reuse the rules.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CATALOG_VERSION = 5;
export const TIMING_STATUSES = Object.freeze([
  "official-chapters",
  "comment-derived",
  "user-calibrated",
  "single-track",
  "album-derived",
  "calibration-required"
]);

const TOLERANCE = 0.01;
// Seconds the catalog duration may drift from the real file before --local complains.
const DURATION_WARN = 0.5;
const DURATION_ERROR = 1.5;

const ROOT_KEYS = new Set(["$schema", "version", "generatedAt", "sources"]);
const SOURCE_KEYS = new Set([
  "id", "title", "artist", "artists", "series", "year", "provider", "youtubeId", "youtubePlaylistId", "duration",
  "audio", "artwork", "added", "description", "timingStatus", "timingNote", "tags", "tracks"
]);
const TRACK_KEYS = new Set(["id", "title", "start", "end", "timingConfidence", "artist", "artists", "youtubeId"]);
const LEGACY_KEYS = new Map([
  ["audioUrl", "use \"audio\": \"media/<youtubeId>.m4a\""],
  ["fallbackArtwork", "the app derives it from youtubeId"],
  ["assetId", "user-imported audio belongs in on-device overrides, not the catalog"]
]);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YOUTUBE_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{12,64}$/;
// Usually named after the YouTube id; an album joined from a playlist uses a readable name.
const AUDIO_PATH = /^media\/[\w-]+\.m4a$/;
const ARTWORK_PATH = /^artwork\/[\w-]+\.jpg$/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Loose identity for spotting two spellings of one name: case, accents, "&"/"and",
// punctuation and a leading "The" are ignored ("Red Clay Strays" == "The Red Clay Strays").
export function nameKey(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, "");
}

function checkNameList(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array of names.`);
    return [];
  }
  const names = [];
  const seen = new Set();
  for (const name of value) {
    if (!isText(name)) {
      errors.push(`${label} contains an empty or non-string name.`);
      continue;
    }
    if (name !== name.trim()) errors.push(`${label}: "${name}" has leading or trailing spaces.`);
    if (seen.has(nameKey(name))) errors.push(`${label}: "${name}" is listed twice.`);
    seen.add(nameKey(name));
    names.push(name);
  }
  return names;
}

function checkKeys(object, allowed, label, errors) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    if (LEGACY_KEYS.has(key)) errors.push(`${label}: "${key}" is a legacy field — ${LEGACY_KEYS.get(key)}.`);
    else errors.push(`${label}: unknown field "${key}".`);
  }
}

// Collects every spelling seen for one loose key so inconsistencies are reported once, with all variants.
function recordSpelling(registry, name, where) {
  const key = nameKey(name);
  if (!registry.has(key)) registry.set(key, new Map());
  const spellings = registry.get(key);
  if (!spellings.has(name)) spellings.set(name, []);
  spellings.get(name).push(where);
}

function reportSpellings(registry, kind, errors) {
  for (const spellings of registry.values()) {
    if (spellings.size < 2) continue;
    const variants = [...spellings].map(([name, where]) => `"${name}" (${where.length}× e.g. ${where[0]})`);
    errors.push(`${kind} is spelled ${spellings.size} ways: ${variants.join(", ")}.`);
  }
}

// claimVideo(youtubeId, label, owner) records which source or track uses a YouTube video and reports reuse.
function checkTracks(source, label, errors, claimVideo) {
  if (!Array.isArray(source.tracks) || source.tracks.length === 0) {
    errors.push(`${label}: at least one track is required.`);
    return [];
  }
  const duration = isFiniteNumber(source.duration) ? source.duration : null;
  const trackIds = new Set();
  const trackArtistNames = [];
  let priorEnd = null;
  source.tracks.forEach((track, index) => {
    const trackLabel = `${label} / track ${index + 1}${isText(track?.title) ? ` "${track.title}"` : ""}`;
    if (!isPlainObject(track)) {
      errors.push(`${trackLabel}: must be an object.`);
      priorEnd = null;
      return;
    }
    checkKeys(track, TRACK_KEYS, trackLabel, errors);
    if (!isText(track.id) || !SLUG.test(track.id)) errors.push(`${trackLabel}: id must be a lowercase slug.`);
    else if (trackIds.has(track.id)) errors.push(`${trackLabel}: duplicate track id "${track.id}".`);
    trackIds.add(track.id);
    if (!isText(track.title)) errors.push(`${trackLabel}: title is required.`);
    if (track.timingConfidence !== undefined && !isText(track.timingConfidence)) errors.push(`${trackLabel}: timingConfidence must be a non-empty string.`);
    if (track.artist !== undefined && !isText(track.artist)) errors.push(`${trackLabel}: artist must be a non-empty string.`);
    if (track.artists !== undefined) trackArtistNames.push(...checkNameList(track.artists, `${trackLabel} artists`, errors));
    if (track.youtubeId !== undefined) {
      if (!YOUTUBE_ID.test(String(track.youtubeId))) errors.push(`${trackLabel}: youtubeId must be an 11-character YouTube id.`);
      else if (track.youtubeId !== source.youtubeId) claimVideo(track.youtubeId, trackLabel, `track ${index + 1} of "${source.id}"`);
    }

    if (!isFiniteNumber(track.start) || !isFiniteNumber(track.end)) {
      errors.push(`${trackLabel}: start and end must be finite numbers.`);
      priorEnd = null;
      return;
    }
    if (track.start < 0) errors.push(`${trackLabel}: start ${track.start} is negative.`);
    if (track.end <= track.start) errors.push(`${trackLabel}: end ${track.end} must be after start ${track.start}.`);
    if (priorEnd !== null && Math.abs(track.start - priorEnd) > TOLERANCE) {
      errors.push(`${trackLabel}: starts at ${track.start} but the previous track ends at ${priorEnd}.`);
    }
    if (duration !== null && track.end > duration + TOLERANCE) errors.push(`${trackLabel}: ends at ${track.end}, after the source duration ${duration}.`);
    priorEnd = track.end;
  });
  const last = source.tracks.at(-1);
  if (duration !== null && isFiniteNumber(last?.end) && Math.abs(last.end - duration) > TOLERANCE) {
    errors.push(`${label}: the last track ends at ${last.end} but the duration is ${duration}.`);
  }
  return trackArtistNames;
}

/**
 * Validates a parsed catalog. Pure except for the optional --local file checks.
 * @param {object} catalog parsed data/catalog.json
 * @param {{ libraryRoot?: string, local?: boolean }} [options] libraryRoot is required when local is true
 * @returns {{ errors: string[], warnings: string[], stats: { sources: number, tracks: number, artists: string[], series: string[] } }}
 */
export function validateCatalog(catalog, { libraryRoot = "", local = false } = {}) {
  const errors = [];
  const warnings = [];
  const stats = { sources: 0, tracks: 0, artists: [], series: [] };
  if (!isPlainObject(catalog)) {
    errors.push("The catalog must be a JSON object.");
    return { errors, warnings, stats };
  }
  checkKeys(catalog, ROOT_KEYS, "catalog", errors);
  if (catalog.version !== CATALOG_VERSION) errors.push(`catalog: version must be ${CATALOG_VERSION} (found ${JSON.stringify(catalog.version)}).`);
  if (!isIsoDate(catalog.generatedAt)) errors.push("catalog: generatedAt must be a YYYY-MM-DD date.");
  if (!Array.isArray(catalog.sources) || catalog.sources.length === 0) {
    errors.push("catalog: sources must be a non-empty array.");
    return { errors, warnings, stats };
  }

  const sourceIds = new Set();
  const youtubeIds = new Map();
  const playlistIds = new Map();
  const filePaths = new Map();
  // One YouTube video is one recording: it may back a single source or one album track, never both.
  const claimVideo = (youtubeId, label, owner) => {
    if (youtubeIds.has(youtubeId)) errors.push(`${label}: youtubeId ${youtubeId} is already used by ${youtubeIds.get(youtubeId)}.`);
    else youtubeIds.set(youtubeId, owner);
  };
  const claimFile = (file, label, owner) => {
    if (filePaths.has(file)) errors.push(`${label}: ${file} is already used by ${filePaths.get(file)}.`);
    else filePaths.set(file, owner);
  };
  const artistSpellings = new Map();
  const seriesSpellings = new Map();

  catalog.sources.forEach((source, index) => {
    const label = `source ${index + 1}${isText(source?.id) ? ` "${source.id}"` : ""}`;
    if (!isPlainObject(source)) {
      errors.push(`${label}: must be an object.`);
      return;
    }
    checkKeys(source, SOURCE_KEYS, label, errors);

    if (!isText(source.id) || !SLUG.test(source.id)) errors.push(`${label}: id must be a lowercase slug.`);
    else if (sourceIds.has(source.id)) errors.push(`${label}: duplicate source id.`);
    sourceIds.add(source.id);
    if (!isText(source.title)) errors.push(`${label}: title is required.`);
    if (!isText(source.artist)) errors.push(`${label}: artist (display credit) is required.`);
    for (const name of checkNameList(source.artists, `${label} artists`, errors)) recordSpelling(artistSpellings, name, source.id);
    if (source.series !== undefined) {
      if (isText(source.series)) recordSpelling(seriesSpellings, source.series, source.id);
      else errors.push(`${label}: series must be a non-empty string when present.`);
    }
    if (source.year !== undefined && (!Number.isInteger(source.year) || source.year < 1900 || source.year > 2100)) {
      errors.push(`${label}: year must be a four-digit integer.`);
    }
    if (source.provider !== "local") errors.push(`${label}: provider must be "local" for packaged music.`);

    const hasVideo = source.youtubeId !== undefined;
    const hasPlaylist = source.youtubePlaylistId !== undefined;
    if (hasVideo || !hasPlaylist) {
      if (!YOUTUBE_ID.test(String(source.youtubeId ?? ""))) {
        errors.push(`${label}: youtubeId must be an 11-character YouTube id${hasPlaylist ? "" : " (or set youtubePlaylistId for an album joined from a playlist)"}.`);
      } else claimVideo(source.youtubeId, label, `"${source.id}"`);
    }
    if (hasPlaylist) {
      if (!PLAYLIST_ID.test(String(source.youtubePlaylistId))) errors.push(`${label}: youtubePlaylistId must be a YouTube playlist id.`);
      else if (playlistIds.has(source.youtubePlaylistId)) {
        errors.push(`${label}: youtubePlaylistId ${source.youtubePlaylistId} is already used by "${playlistIds.get(source.youtubePlaylistId)}".`);
      } else playlistIds.set(source.youtubePlaylistId, source.id);
    }

    if (!AUDIO_PATH.test(source.audio ?? "")) errors.push(`${label}: audio must look like "media/<youtubeId or name>.m4a" (letters, digits, - and _).`);
    else {
      claimFile(source.audio, label, `"${source.id}"`);
      if (YOUTUBE_ID.test(source.youtubeId ?? "") && source.audio !== `media/${source.youtubeId}.m4a`) {
        warnings.push(`${label}: audio ${source.audio} is not named after youtubeId ${source.youtubeId}.`);
      }
    }
    if (!ARTWORK_PATH.test(source.artwork ?? "")) errors.push(`${label}: artwork must look like "artwork/<youtubeId or name>.jpg" (letters, digits, - and _).`);
    else {
      claimFile(source.artwork, label, `"${source.id}"`);
      if (YOUTUBE_ID.test(source.youtubeId ?? "") && source.artwork !== `artwork/${source.youtubeId}.jpg`) {
        warnings.push(`${label}: artwork ${source.artwork} is not named after youtubeId ${source.youtubeId}.`);
      }
    }
    if (!isFiniteNumber(source.duration) || source.duration <= 0) errors.push(`${label}: duration must be a positive number of seconds.`);
    if (!isIsoDate(source.added)) errors.push(`${label}: added must be a YYYY-MM-DD date.`);

    if (source.description !== undefined && typeof source.description !== "string") errors.push(`${label}: description must be a string.`);
    if (source.timingNote !== undefined && typeof source.timingNote !== "string") errors.push(`${label}: timingNote must be a string.`);
    if (source.timingStatus !== undefined && !TIMING_STATUSES.includes(source.timingStatus)) {
      errors.push(`${label}: timingStatus must be one of ${TIMING_STATUSES.join(", ")}.`);
    }
    if (source.tags !== undefined) {
      if (!Array.isArray(source.tags) || source.tags.some((tag) => !isText(tag))) errors.push(`${label}: tags must be an array of non-empty strings.`);
      else if (new Set(source.tags).size !== source.tags.length) errors.push(`${label}: tags contain duplicates.`);
    }

    for (const name of checkTracks(source, label, errors, claimVideo)) recordSpelling(artistSpellings, name, source.id);
    stats.tracks += Array.isArray(source.tracks) ? source.tracks.length : 0;

    if (local && libraryRoot) checkLocalFiles(source, label, libraryRoot, errors, warnings);
  });

  reportSpellings(artistSpellings, "Artist", errors);
  reportSpellings(seriesSpellings, "Series", errors);

  if (local && libraryRoot) {
    const referenced = new Set(catalog.sources.flatMap((source) => [source?.audio, source?.artwork]).filter(Boolean));
    for (const folder of ["media", "artwork"]) {
      const dir = path.join(libraryRoot, folder);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith(".")) continue;
        if (!referenced.has(`${folder}/${file}`)) warnings.push(`library/${folder}/${file} is not referenced by the catalog.`);
      }
    }
  }

  stats.sources = catalog.sources.length;
  stats.artists = [...artistSpellings.values()].map((spellings) => [...spellings.keys()][0]);
  stats.series = [...seriesSpellings.values()].map((spellings) => [...spellings.keys()][0]);
  return { errors, warnings, stats };
}

function checkLocalFiles(source, label, libraryRoot, errors, warnings) {
  const audioOk = AUDIO_PATH.test(source.audio ?? "");
  const artworkOk = ARTWORK_PATH.test(source.artwork ?? "");
  if (audioOk) {
    const file = path.join(libraryRoot, source.audio);
    const header = readHead(file, 12);
    if (!header) errors.push(`${label}: library/${source.audio} is missing or empty.`);
    else if (header.toString("latin1", 4, 8) !== "ftyp") errors.push(`${label}: library/${source.audio} is not an MP4/M4A file.`);
    else if (isFiniteNumber(source.duration)) {
      const actual = mp4Duration(file);
      if (actual === null) warnings.push(`${label}: could not read the duration of library/${source.audio}.`);
      else {
        const drift = Math.abs(actual - source.duration);
        const message = `${label}: duration ${source.duration} s differs from library/${source.audio} (${actual.toFixed(2)} s) by ${drift.toFixed(2)} s.`;
        if (drift > DURATION_ERROR) errors.push(message);
        else if (drift > DURATION_WARN) warnings.push(message);
      }
    }
  }
  if (artworkOk) {
    const header = readHead(path.join(libraryRoot, source.artwork), 3);
    if (!header) errors.push(`${label}: library/${source.artwork} is missing or empty.`);
    else if (header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) errors.push(`${label}: library/${source.artwork} is not a JPEG.`);
  }
}

function readHead(file, length) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return read === length ? buffer : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Reads the movie header (moov/mvhd) by walking box headers, so even large files cost a few small reads.
export function mp4Duration(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    const readAt = (buffer, position, length = buffer.length) => fs.readSync(fd, buffer, 0, length, position) === length;
    const findBox = (type, start, end) => {
      let offset = start;
      while (offset + 8 <= end) {
        if (!readAt(header, offset, 8)) return null;
        let boxSize = header.readUInt32BE(0);
        let headerSize = 8;
        if (boxSize === 1) {
          if (!readAt(header, offset, 16)) return null;
          boxSize = Number(header.readBigUInt64BE(8));
          headerSize = 16;
        } else if (boxSize === 0) {
          boxSize = end - offset;
        }
        if (boxSize < headerSize) return null;
        if (header.toString("latin1", 4, 8) === type) return { start: offset + headerSize, end: offset + boxSize };
        offset += boxSize;
      }
      return null;
    };
    const moov = findBox("moov", 0, size);
    const mvhd = moov && findBox("mvhd", moov.start, moov.end);
    if (!mvhd) return null;
    const body = Buffer.alloc(32);
    if (!readAt(body, mvhd.start, Math.min(32, mvhd.end - mvhd.start))) return null;
    const version = body[0];
    const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
    const units = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
    return timescale > 0 ? units / timescale : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const local = argv.includes("--local");
  const catalogArg = argv.find((arg) => arg.startsWith("--catalog="));
  const catalogPath = catalogArg ? path.resolve(catalogArg.slice("--catalog=".length)) : path.join(repoRoot, "data", "catalog.json");
  const unknown = argv.filter((arg) => arg !== "--local" && !arg.startsWith("--catalog="));
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: node tools/validate-catalog.mjs [--local] [--catalog=path]`);
    return 2;
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) {
    console.error(`Could not read ${path.relative(process.cwd(), catalogPath) || catalogPath}: ${error.message}`);
    return 1;
  }

  const libraryRoot = path.join(repoRoot, "library");
  if (local && !fs.existsSync(libraryRoot)) {
    console.error("--local needs the library/ staging folder (library/media, library/artwork).");
    return 1;
  }
  const { errors, warnings, stats } = validateCatalog(catalog, { libraryRoot, local });
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length) {
    console.error(`Catalog validation failed with ${errors.length} issue(s):`);
    for (const error of errors) console.error(` - ${error}`);
    return 1;
  }
  const scope = local ? " (library files checked)" : "";
  console.log(`Catalog valid${scope}: ${stats.sources} sources, ${stats.tracks} tracks, ${stats.artists.length} artists, ${stats.series.length} series.`);
  return 0;
}

function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
