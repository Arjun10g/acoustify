import { deepClone, parseTimecode, parseYouTubeId, slugify, unique } from "./utils.js";

export async function loadBaseCatalog() {
  const response = await fetch("./data/catalog.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
  const data = await response.json();
  validateCatalog(data);
  return data;
}

export function validateCatalog(data) {
  if (!data || !Array.isArray(data.sources)) throw new Error("Catalog must include a sources array.");
  const sourceIds = new Set();
  for (const source of data.sources) {
    if (!source.id || !source.title || !source.artist || !source.provider) throw new Error("Every source needs id, title, artist, and provider.");
    if (sourceIds.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    if (!Number.isFinite(source.duration) || source.duration <= 0) throw new Error(`${source.title} needs a positive duration.`);
    if (source.provider === "youtube" && !/^[\w-]{11}$/.test(source.youtubeId || "")) throw new Error(`${source.title} needs a valid YouTube id.`);
    if (source.provider === "local" && !source.assetId) throw new Error(`${source.title} needs a local asset id.`);
    if (!Array.isArray(source.tracks) || source.tracks.length === 0) throw new Error(`${source.title} needs at least one track.`);
    let lastEnd = -1;
    const trackIds = new Set();
    for (const [index, track] of source.tracks.entries()) {
      if (!track.id || !track.title) throw new Error(`A track in ${source.title} is missing id/title.`);
      if (trackIds.has(track.id)) throw new Error(`Duplicate track id ${track.id} in ${source.title}.`);
      trackIds.add(track.id);
      if (!Number.isFinite(track.start) || !Number.isFinite(track.end) || track.start < 0 || track.end <= track.start) {
        throw new Error(`Invalid timing for ${track.title}.`);
      }
      if (index > 0 && Math.abs(track.start - lastEnd) > 0.01) throw new Error(`Track boundaries must be continuous in ${source.title}.`);
      if (track.end > source.duration + 0.01) throw new Error(`${track.title} ends after ${source.title}.`);
      lastEnd = track.end;
    }
    if (Math.abs(lastEnd - source.duration) > 0.01) throw new Error(`The final track in ${source.title} must end at the source duration.`);
  }
  return true;
}

export function mergeCatalog(baseCatalog, userSources = []) {
  const byId = new Map(baseCatalog.sources.map((source) => [source.id, deepClone(source)]));
  for (const source of userSources) byId.set(source.id, deepClone(source));
  const sources = [...byId.values()].map(normalizeSource);
  return buildCatalogIndex({ version: baseCatalog.version, sources });
}

export function buildCatalogIndex(catalog) {
  const sourceById = new Map();
  const trackByKey = new Map();
  const tracks = [];
  for (const source of catalog.sources.map(normalizeSource)) {
    sourceById.set(source.id, source);
    source.tracks.forEach((track, index) => {
      const normalizedTrack = {
        ...track,
        sourceId: source.id,
        key: `${source.id}::${track.id}`,
        artist: track.artist || source.artist,
        sourceTitle: source.title,
        provider: source.provider,
        artwork: track.artwork || source.artwork || source.fallbackArtwork,
        index
      };
      source.tracks[index] = normalizedTrack;
      tracks.push(normalizedTrack);
      trackByKey.set(normalizedTrack.key, normalizedTrack);
    });
  }
  return { ...catalog, sourceById, trackByKey, tracks };
}

export function normalizeSource(input) {
  const source = deepClone(input);
  source.id = source.id || slugify(`${source.artist}-${source.title}`);
  source.title = source.title || "Untitled source";
  source.artist = source.artist || "Unknown artist";
  source.tags = unique(source.tags || []);
  if (source.provider === "youtube" && !source.youtubeId && source.url) source.youtubeId = parseYouTubeId(source.url);
  if (!source.artwork && source.youtubeId) source.artwork = `https://i.ytimg.com/vi/${source.youtubeId}/maxresdefault.jpg`;
  if (!source.fallbackArtwork && source.youtubeId) source.fallbackArtwork = `https://i.ytimg.com/vi/${source.youtubeId}/hqdefault.jpg`;
  source.tracks = (source.tracks || []).map((track, index) => ({
    ...track,
    id: track.id || slugify(track.title || `track-${index + 1}`),
    title: track.title || `Track ${index + 1}`,
    start: Number(track.start || 0),
    end: Number(track.end || source.duration || Number(track.start || 0) + 1)
  }));
  source.duration = Number(source.duration || source.tracks.at(-1)?.end || 0);
  return source;
}

export function sourceWithLocalAudio(sourceInput, { assetId, name, type, size, duration, lastModified } = {}) {
  const source = normalizeSource(sourceInput);
  const youtubeFallback = normalizeSource(source.youtubeFallback || source);
  const parsedDuration = Number(duration);
  const finalTrack = source.tracks.at(-1);
  if (!source.youtubeId) throw new Error("This source does not have a YouTube ID to match against the extracted file.");
  if (!assetId) throw new Error("A local audio asset id is required.");
  if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) throw new Error("The browser could not read a valid audio duration.");
  if (!finalTrack || parsedDuration <= finalTrack.start + 0.25) throw new Error("The audio ends before the final saved track begins.");

  const allowedDifference = Math.max(8, source.duration * 0.003);
  if (Math.abs(parsedDuration - source.duration) > allowedDifference) {
    throw new Error(
      `This file is ${Math.round(Math.abs(parsedDuration - source.duration))} seconds different from the saved source. Choose audio extracted from the same video.`
    );
  }

  source.provider = "local";
  source.assetId = assetId;
  source.assetMeta = {
    name: name || "Extracted audio",
    type: type || "audio/*",
    size: Number(size) || 0,
    duration: parsedDuration,
    lastModified: Number(lastModified) || 0,
    youtubeId: source.youtubeId,
    importKind: "authorized-extract"
  };
  source.duration = parsedDuration;
  finalTrack.end = parsedDuration;
  source.localPlaybackFor = source.youtubeId;

  for (const candidate of [source, youtubeFallback]) {
    for (const track of candidate.tracks) {
      delete track.sourceId;
      delete track.key;
      delete track.sourceTitle;
      delete track.provider;
      delete track.index;
    }
  }
  youtubeFallback.provider = "youtube";
  delete youtubeFallback.assetId;
  delete youtubeFallback.assetMeta;
  delete youtubeFallback.localPlaybackFor;
  delete youtubeFallback.youtubeFallback;
  source.youtubeFallback = youtubeFallback;
  return source;
}

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

export function sourceFromStudioForm({ id, title, artist, provider, youtubeInput, duration, artwork, description, tags, chapters, assetId, assetMeta }) {
  const youtubeId = provider === "youtube" ? parseYouTubeId(youtubeInput) : "";
  if (provider === "youtube" && !youtubeId) throw new Error("Enter a valid YouTube URL or 11-character video id.");
  if (provider === "local" && !assetId) throw new Error("Choose a local audio file.");
  const parsedDuration = parseTimecode(duration);
  if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) throw new Error("Enter the full source duration, such as 56:55.");
  const tracks = parseChapterLines(chapters, parsedDuration);
  const sourceId = id || slugify(`${artist}-${title}`);
  return normalizeSource({
    id: sourceId,
    title: title.trim(),
    artist: artist.trim(),
    provider,
    youtubeId,
    assetId: provider === "local" ? assetId : undefined,
    assetMeta: provider === "local" ? assetMeta : undefined,
    duration: parsedDuration,
    artwork: artwork.trim() || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : "./assets/icons/icon-512.png"),
    fallbackArtwork: youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : "./assets/icons/icon-512.png",
    description: description.trim(),
    tags: String(tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
    timingStatus: "user-calibrated",
    timingNote: "Saved in this browser through Catalog Studio.",
    tracks
  });
}
