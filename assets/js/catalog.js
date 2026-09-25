import { deepClone, parseTimecode, parseYouTubeId, slugify, unique } from "./utils.js";

const YOUTUBE_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{12,64}$/;
// Named after the YouTube id, or readable (media/rcs-live-at-the-ryman.m4a) for an album joined from a playlist.
const AUDIO_PATH = /^media\/[\w-]+\.m4a$/;
const ARTWORK_PATH = /^artwork\/[\w-]+\.jpg$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ARTWORK = "./assets/icons/icon-512.png";
// The v2 app shipped audio and artwork inside the site. Browser overrides saved
// by that version still carry these paths (./media/..., ./assets/artwork/...),
// which no longer exist; safeUserUrl() drops the artwork ones.
const LEGACY_AUDIO = /^\.?\/?media\//;
const EDITABLE_FIELDS = ["title", "artist", "description", "year", "tags"];
const TRACK_FIT_TOLERANCE = 1;
const TIMING_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// Small pure helpers

function cleanString(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function cleanNames(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const names = [];
  for (const value of values) {
    const name = cleanString(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// Artist and series slugs end up in URLs (#/artist/<slug>), so they must be
// identical on every load. utils.slugify falls back to a random id for names
// with no Latin letters; this falls back to a hash of the name instead.
export function entitySlug(name, prefix = "item") {
  const text = cleanString(name);
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `${prefix}-${hashString(text.toLowerCase())}`;
}

// "The Red Clay Strays" files under R, like every music library does.
export function sortName(name) {
  return cleanString(name).replace(/^the\s+/i, "");
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { sensitivity: "base", numeric: true }) : null;

function compareNames(a, b) {
  const left = sortName(a);
  const right = sortName(b);
  const result = collator ? collator.compare(left, right) : left.localeCompare(right);
  return result || String(a).localeCompare(String(b));
}

function maxDate(a = "", b = "") {
  return String(a) > String(b) ? String(a) : String(b);
}

function isLegacyAudioUrl(value) {
  return typeof value === "string" && LEGACY_AUDIO.test(value);
}

// Browser overrides come back from backup files, which can be edited by hand
// or handed over by someone else. A URL taken from one must be an https
// address (or, for artwork, an inline image): never javascript:, a plain-http
// address, or a path into this site.
function safeUserUrl(value, { image = false } = {}) {
  const text = cleanString(value);
  if (!text) return "";
  if (image && /^data:image\/(?:png|jpe?g|webp|gif);base64,[\w+/=]+$/i.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Normalization

export function normalizeSource(input) {
  const source = deepClone(input || {});
  source.title = cleanString(source.title) || "Untitled";
  source.artists = cleanNames(source.artists);
  source.artist = cleanString(source.artist) || source.artists.join(" & ") || "Unknown artist";
  if (source.artists.length === 0) source.artists = [source.artist];
  source.id = cleanString(source.id) || slugify(`${source.artist}-${source.title}`);
  source.series = cleanString(source.series);
  source.tags = unique((Array.isArray(source.tags) ? source.tags : []).map(cleanString));
  source.added = cleanString(source.added);
  if (!source.youtubeId && source.url) source.youtubeId = parseYouTubeId(source.url);
  source.youtubeId = cleanString(source.youtubeId);
  const playlistId = cleanString(source.youtubePlaylistId);
  if (playlistId) source.youtubePlaylistId = playlistId;
  else delete source.youtubePlaylistId;
  if (!source.provider) source.provider = source.audioUrl || source.assetId || !source.youtubeId ? "local" : "youtube";
  if (!source.artwork && source.provider === "youtube" && source.youtubeId) {
    source.artwork = `https://i.ytimg.com/vi/${source.youtubeId}/maxresdefault.jpg`;
  }
  if (!source.artwork) source.artwork = null;
  source.tracks = (Array.isArray(source.tracks) ? source.tracks : []).map((track, index) => {
    const start = Number(track.start || 0);
    const next = {
      ...track,
      id: cleanString(track.id) || slugify(track.title || `track-${index + 1}`),
      title: cleanString(track.title) || `Track ${index + 1}`,
      start,
      end: Number(track.end || source.duration || start + 1)
    };
    const artists = cleanNames(track.artists);
    if (artists.length) next.artists = artists;
    else delete next.artists;
    const youtubeId = cleanString(track.youtubeId);
    if (youtubeId) next.youtubeId = youtubeId;
    else delete next.youtubeId;
    return next;
  });
  // An album joined from a playlist has no video of its own: its public still is the first song's.
  // (cloud.libraryToCatalog fills in the app icon for any source without a youtubeId.)
  const stillId = source.youtubeId || source.tracks.find((track) => track.youtubeId)?.youtubeId || "";
  if (!source.fallbackArtwork || (source.fallbackArtwork === DEFAULT_ARTWORK && !source.youtubeId && stillId)) {
    source.fallbackArtwork = stillId ? `https://i.ytimg.com/vi/${stillId}/hqdefault.jpg` : DEFAULT_ARTWORK;
  }
  source.duration = Number(source.duration || source.tracks.at(-1)?.end || 0);
  return source;
}

// ---------------------------------------------------------------------------
// Validation

function validTiming(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sourceProblems(source, index, { strict }) {
  const problems = [];
  const label = source?.title || source?.id || `Source ${index + 1}`;
  if (!source || typeof source !== "object") return [`Source ${index + 1} is not an object.`];
  if (!cleanString(source.id)) problems.push(`${label} needs an id.`);
  if (!cleanString(source.title)) problems.push(`${label} needs a title.`);
  if (!cleanString(source.artist)) problems.push(`${label} needs an artist.`);
  if (!source.provider) problems.push(`${label} needs a provider.`);
  if (!validTiming(source.duration) || source.duration <= 0) problems.push(`${label} needs a positive duration.`);

  if (strict) {
    if (source.provider !== "local") problems.push(`${label} must use provider "local".`);
    if (!Array.isArray(source.artists) || source.artists.length === 0 || source.artists.some((name) => typeof name !== "string" || !name.trim())) {
      problems.push(`${label} needs an artists list with at least one name.`);
    }
    // A source is one YouTube video, or an album joined from a playlist (its songs carry their own video ids).
    if (source.youtubePlaylistId != null && !PLAYLIST_ID.test(String(source.youtubePlaylistId))) {
      problems.push(`${label} needs a valid YouTube playlist id.`);
    }
    if ((source.youtubeId != null && source.youtubeId !== "") || source.youtubePlaylistId == null) {
      if (!YOUTUBE_ID.test(source.youtubeId || "")) problems.push(`${label} needs a valid YouTube id.`);
    }
    if (!AUDIO_PATH.test(source.audio || "")) problems.push(`${label} audio must look like media/<id>.m4a.`);
    if (!ARTWORK_PATH.test(source.artwork || "")) problems.push(`${label} artwork must look like artwork/<id>.jpg.`);
    if (!ISO_DATE.test(source.added || "") || Number.isNaN(Date.parse(`${source.added}T00:00:00Z`))) {
      problems.push(`${label} needs an added date (YYYY-MM-DD).`);
    }
    if (source.series != null && typeof source.series !== "string") problems.push(`${label} series must be text.`);
    if (source.year != null && !Number.isInteger(source.year)) problems.push(`${label} year must be a whole number.`);
    if (source.tags != null && (!Array.isArray(source.tags) || source.tags.some((tag) => typeof tag !== "string"))) {
      problems.push(`${label} tags must be a list of text.`);
    }
  } else {
    if (source.provider === "youtube" && !YOUTUBE_ID.test(source.youtubeId || "")) problems.push(`${label} needs a valid YouTube id.`);
    if (source.provider === "local" && !source.assetId && !source.audioUrl && !source.audio) {
      problems.push(`${label} needs a local asset id or library audio.`);
    }
  }

  if (!Array.isArray(source.tracks) || source.tracks.length === 0) {
    problems.push(`${label} needs at least one track.`);
    return problems;
  }
  const trackIds = new Set();
  let lastEnd = null;
  for (const [trackIndex, track] of source.tracks.entries()) {
    const trackLabel = track?.title || track?.id || `Track ${trackIndex + 1}`;
    if (!track || !cleanString(track.id) || !cleanString(track.title)) {
      problems.push(`A track in ${label} is missing its id or title.`);
      continue;
    }
    if (trackIds.has(track.id)) problems.push(`Duplicate track id ${track.id} in ${label}.`);
    trackIds.add(track.id);
    if (!validTiming(track.start) || !validTiming(track.end) || track.start < 0 || track.end <= track.start) {
      problems.push(`Invalid timing for ${trackLabel} in ${label}.`);
      lastEnd = validTiming(track.end) ? track.end : lastEnd;
      continue;
    }
    if (lastEnd !== null && Math.abs(track.start - lastEnd) > TIMING_TOLERANCE) {
      problems.push(`Track boundaries must be continuous in ${label} (${trackLabel}).`);
    }
    if (validTiming(source.duration) && track.end > source.duration + TIMING_TOLERANCE) {
      problems.push(`${trackLabel} ends after ${label}.`);
    }
    if (strict && track.artists != null && (!Array.isArray(track.artists) || track.artists.some((name) => typeof name !== "string" || !name.trim()))) {
      problems.push(`${trackLabel} in ${label} has an invalid artists list.`);
    }
    if (strict && track.youtubeId != null && !YOUTUBE_ID.test(String(track.youtubeId))) {
      problems.push(`${trackLabel} in ${label} has an invalid YouTube id.`);
    }
    lastEnd = track.end;
  }
  if (lastEnd !== null && validTiming(source.duration) && Math.abs(lastEnd - source.duration) > TIMING_TOLERANCE) {
    problems.push(`The final track in ${label} must end at the source duration.`);
  }
  return problems;
}

// Every problem in the catalog, in order. Schema 5 (data/catalog.json) gets the
// strict library rules; older/runtime shapes (browser overrides, backups) get
// the structural rules only.
export function listCatalogProblems(data, { strict } = {}) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sources)) return ["Catalog must include a sources array."];
  const useStrict = strict ?? Number(data.version) >= 5;
  const problems = [];
  const ids = new Set();
  data.sources.forEach((source, index) => {
    if (source?.id) {
      if (ids.has(source.id)) problems.push(`Duplicate source id: ${source.id}`);
      ids.add(source.id);
    }
    problems.push(...sourceProblems(source, index, { strict: useStrict }));
  });
  return problems;
}

export function validateCatalog(data, options = {}) {
  const problems = listCatalogProblems(data, options);
  if (problems.length === 0) return true;
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
  const error = new Error(`${problems[0]}${more}`);
  error.errors = problems;
  throw error;
}

// ---------------------------------------------------------------------------
// Merging browser overrides onto the published library

function tracksFit(tracks, duration) {
  if (!Array.isArray(tracks) || tracks.length === 0 || !(duration > 0)) return false;
  let lastEnd = null;
  for (const track of tracks) {
    const start = Number(track?.start);
    const end = Number(track?.end);
    if (!track || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return false;
    if (start >= duration) return false;
    if (lastEnd !== null && Math.abs(start - lastEnd) > TIMING_TOLERANCE) return false;
    lastEnd = end;
  }
  return Math.abs(lastEnd - duration) <= TRACK_FIT_TOLERANCE;
}

const DERIVED_TRACK_FIELDS = ["key", "sourceId", "sourceTitle", "provider", "index", "artwork", "fallbackArtwork", "artistSlugs", "series", "added", "duration"];

// Tracks saved from an indexed catalog carry derived fields; they must not leak back in as data.
function stripDerivedTrackFields(tracks) {
  return deepClone(tracks).map((track) => {
    const copy = { ...track };
    for (const key of DERIVED_TRACK_FIELDS) delete copy[key];
    return copy;
  });
}

// An override on library audio may only retitle and retime songs. Per-song
// credits and video ids always come from the library so a later publish can correct them.
function overrideTracksOnLibraryAudio(tracks, base) {
  const baseTracks = new Map((base.tracks || []).map((track) => [track.id, track]));
  const next = tracks.map((track) => {
    const baseTrack = baseTracks.get(track.id);
    const copy = { id: track.id, title: track.title, start: Number(track.start), end: Number(track.end) };
    if (track.timingConfidence) copy.timingConfidence = track.timingConfidence;
    if (baseTrack?.artists) copy.artists = deepClone(baseTrack.artists);
    if (baseTrack?.artist) copy.artist = baseTrack.artist;
    if (baseTrack?.youtubeId) copy.youtubeId = baseTrack.youtubeId;
    return copy;
  });
  // Snap the last boundary so a sub-second duration change (re-encode) keeps the set contiguous.
  next[next.length - 1].end = base.duration;
  return next;
}

function isPlaybackOverride(override) {
  return (override.provider === "local" && Boolean(override.assetId)) || override.provider === "youtube";
}

function applyOverride(base, override) {
  const merged = deepClone(base);
  for (const field of EDITABLE_FIELDS) {
    if (override[field] !== undefined && override[field] !== null) merged[field] = deepClone(override[field]);
  }

  if (isPlaybackOverride(override)) {
    merged.provider = override.provider;
    if (override.youtubeId) merged.youtubeId = override.youtubeId;
    if (Number(override.duration) > 0) merged.duration = Number(override.duration);
    if (Array.isArray(override.tracks) && override.tracks.length) merged.tracks = stripDerivedTrackFields(override.tracks);
    if (override.provider === "local") {
      merged.assetId = override.assetId;
      if (override.assetMeta) merged.assetMeta = deepClone(override.assetMeta);
      if (override.localPlaybackFor) merged.localPlaybackFor = override.localPlaybackFor;
      // audioUrl stays: the player falls back to it if the imported blob is gone.
    } else {
      // Playing from YouTube: the library file is not used, so it must not be offered for download.
      delete merged.audioUrl;
      delete merged.assetId;
      delete merged.assetMeta;
    }
    if (override.youtubeFallback) merged.youtubeFallback = deepClone(override.youtubeFallback);
    const artwork = safeUserUrl(override.artwork, { image: true });
    if (!merged.artwork && artwork) merged.artwork = artwork;
  } else if (Array.isArray(override.tracks)) {
    merged.tracks = tracksFit(override.tracks, base.duration)
      ? overrideTracksOnLibraryAudio(override.tracks, base)
      : deepClone(base.tracks);
  }

  merged.overridden = true;
  return merged;
}

// An old-app copy of a packaged source: it only ever played the bundled file.
function isOrphanedLegacyCopy(source) {
  const provider = source.provider || (source.youtubeId && !source.audioUrl && !source.assetId ? "youtube" : "local");
  return provider !== "youtube" && !source.assetId && (isLegacyAudioUrl(source.audioUrl) || !source.audioUrl);
}

export function mergeCatalog(baseCatalog, userSources = []) {
  const baseSources = Array.isArray(baseCatalog?.sources) ? baseCatalog.sources : [];
  const byId = new Map(baseSources.map((source) => [source.id, deepClone(source)]));
  const originals = new Map(baseSources.map((source) => [source.id, source]));

  // Ids may have been renamed between catalog versions; the recording is the stable identity.
  const idsByYouTube = new Map();
  for (const source of baseSources) {
    if (!source.youtubeId) continue;
    idsByYouTube.set(source.youtubeId, idsByYouTube.has(source.youtubeId) ? null : source.id);
  }

  const userOnly = new Map();
  for (const override of Array.isArray(userSources) ? userSources : []) {
    if (!override || typeof override !== "object" || !override.id) continue;
    let targetId = originals.has(override.id) ? override.id : null;
    const derivedFromLibrary = isLegacyAudioUrl(override.audioUrl) || Boolean(override.localPlaybackFor || override.restorePackagedSource);
    if (!targetId && override.youtubeId && derivedFromLibrary) targetId = idsByYouTube.get(override.youtubeId) || null;
    if (targetId) {
      byId.set(targetId, applyOverride(originals.get(targetId), override));
      continue;
    }
    if (isOrphanedLegacyCopy(override)) continue;
    const own = deepClone(override);
    for (const [field, image] of [["audioUrl", false], ["artwork", true], ["fallbackArtwork", true]]) {
      if (own[field] == null) continue;
      const url = safeUserUrl(own[field], { image });
      if (url) own[field] = url;
      else delete own[field];
    }
    // Nothing left to play from (its only audio address was unusable).
    if (isOrphanedLegacyCopy(own)) continue;
    own.userSource = true;
    userOnly.set(own.id, own);
  }

  const { sources: _ignored, ...meta } = baseCatalog || {};
  return buildCatalogIndex({ ...meta, sources: [...byId.values(), ...userOnly.values()] });
}

// ---------------------------------------------------------------------------
// Index: tracks, artists, series

function createGroup(slug, name) {
  return { slug, name, sourceIds: [], trackKeys: [], songCount: 0, sourceCount: 0, artwork: null, fallbackArtwork: DEFAULT_ARTWORK, latestAdded: "" };
}

function addSourceToGroup(group, source) {
  if (!group.sourceIds.includes(source.id)) group.sourceIds.push(source.id);
  group.latestAdded = maxDate(group.latestAdded, source.added);
}

function finishGroups(groups, sourceById, sourcesByAdded) {
  const order = new Map(sourcesByAdded.map((source, index) => [source.id, index]));
  for (const group of groups.values()) {
    group.sourceIds.sort((a, b) => order.get(a) - order.get(b));
    group.sourceCount = group.sourceIds.length;
    group.songCount = group.trackKeys.length;
    const newest = sourceById.get(group.sourceIds[0]);
    const withArt = group.sourceIds.map((id) => sourceById.get(id)).find((source) => source.artwork);
    group.artwork = withArt?.artwork || null;
    group.fallbackArtwork = newest?.fallbackArtwork || DEFAULT_ARTWORK;
  }
}

export function buildCatalogIndex(catalog) {
  const sources = (Array.isArray(catalog?.sources) ? catalog.sources : []).map(normalizeSource);
  const sourceById = new Map();
  const trackByKey = new Map();
  const tracks = [];
  const artistGroups = new Map();
  const seriesGroups = new Map();
  const tags = new Set();

  const artistGroup = (name) => {
    const slug = entitySlug(name, "artist");
    if (!artistGroups.has(slug)) artistGroups.set(slug, { ...createGroup(slug, name), series: [] });
    return artistGroups.get(slug);
  };

  for (const source of sources) {
    sourceById.set(source.id, source);
    source.artistSlugs = source.artists.map((name) => entitySlug(name, "artist"));
    source.seriesSlug = source.series ? entitySlug(source.series, "series") : "";
    for (const tag of source.tags) tags.add(tag);

    const series = source.series ? seriesGroups.get(source.seriesSlug) || createGroup(source.seriesSlug, source.series) : null;
    if (series) {
      seriesGroups.set(series.slug, series);
      addSourceToGroup(series, source);
    }
    for (const name of source.artists) addSourceToGroup(artistGroup(name), source);

    source.tracks = source.tracks.map((track, index) => {
      const artists = track.artists?.length ? track.artists : source.artists;
      const indexed = {
        ...track,
        key: `${source.id}::${track.id}`,
        sourceId: source.id,
        sourceTitle: source.title,
        artist: cleanString(track.artist) || (track.artists?.length ? track.artists.join(" & ") : source.artist),
        artists,
        artistSlugs: artists.map((name) => entitySlug(name, "artist")),
        series: source.series,
        artwork: track.artwork || source.artwork || source.fallbackArtwork,
        fallbackArtwork: source.fallbackArtwork,
        provider: source.provider,
        index,
        duration: Math.max(0, track.end - track.start),
        added: source.added
      };
      tracks.push(indexed);
      trackByKey.set(indexed.key, indexed);
      series?.trackKeys.push(indexed.key);
      for (const name of artists) {
        const group = artistGroup(name);
        addSourceToGroup(group, source);
        group.trackKeys.push(indexed.key);
      }
      return indexed;
    });
  }

  // Stable sort keeps catalog order for sources added on the same day.
  const sourcesByAdded = [...sources].sort((a, b) => (a.added === b.added ? 0 : a.added > b.added ? -1 : 1));

  finishGroups(artistGroups, sourceById, sourcesByAdded);
  finishGroups(seriesGroups, sourceById, sourcesByAdded);
  for (const artist of artistGroups.values()) {
    artist.series = unique(artist.sourceIds.map((id) => sourceById.get(id).series)).sort(compareNames);
  }

  const artists = [...artistGroups.values()].sort((a, b) => compareNames(a.name, b.name));
  const series = [...seriesGroups.values()].sort((a, b) => b.sourceCount - a.sourceCount || compareNames(a.name, b.name));

  return {
    ...catalog,
    sources,
    sourceById,
    tracks,
    trackByKey,
    artists,
    artistBySlug: new Map(artists.map((artist) => [artist.slug, artist])),
    series,
    seriesBySlug: new Map(series.map((item) => [item.slug, item])),
    sourcesByAdded,
    tags: [...tags].sort((a, b) => (collator ? collator.compare(a, b) : a.localeCompare(b)))
  };
}

// ---------------------------------------------------------------------------
// Chapter text → tracks (used by the song-times editor)

export function parseChapterLines(text, sourceDuration = 0) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const matchAtStart = line.match(/^((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:[-–—|:]\s*)?(.+)$/);
      const matchAtEnd = line.match(/^(.+?)\s*(?:[-–—|]\s*)?((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)$/);
      const match = matchAtStart || matchAtEnd;
      if (!match) throw new Error(`Could not parse chapter line ${index + 1}: “${line}”`);
      const startsWithTime = match === matchAtStart;
      const time = parseTimecode(startsWithTime ? match[1] : match[2]);
      const title = (startsWithTime ? match[2] : match[1]).trim();
      if (!Number.isFinite(time) || !title) throw new Error(`Invalid chapter line ${index + 1}.`);
      return { title, start: time };
    })
    .sort((a, b) => a.start - b.start);

  if (rows.length === 0) throw new Error("Add at least one chapter line.");
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].start <= rows[i - 1].start) throw new Error("Chapter starts must be strictly increasing.");
  }
  const requestedDuration = Number(sourceDuration || 0);
  if (Number.isFinite(requestedDuration) && requestedDuration > 0 && rows.at(-1).start >= requestedDuration) {
    throw new Error("Every chapter start must be before the full source duration.");
  }
  const finalDuration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? requestedDuration : rows.at(-1).start + 1;
  const usedIds = new Set();
  return rows.map((row, index) => {
    const baseId = slugify(row.title);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    return {
      id,
      title: row.title,
      start: row.start,
      end: index < rows.length - 1 ? rows[index + 1].start : finalDuration,
      timingConfidence: "user"
    };
  });
}
