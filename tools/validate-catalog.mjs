import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "data", "catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const errors = [];

if (!Number.isInteger(catalog.version) || catalog.version < 1) errors.push("Catalog version must be a positive integer.");
if (!Array.isArray(catalog.sources) || catalog.sources.length === 0) errors.push("Catalog needs at least one source.");

const sourceIds = new Set();
for (const source of catalog.sources || []) {
  const label = source.title || source.id || "unknown source";
  if (!source.id || !source.title || !source.artist || !source.provider) errors.push(`${label}: id, title, artist, and provider are required.`);
  if (sourceIds.has(source.id)) errors.push(`${label}: duplicate source id ${source.id}.`);
  sourceIds.add(source.id);
  if (source.provider === "youtube" && !/^[\w-]{11}$/.test(source.youtubeId || "")) errors.push(`${label}: invalid YouTube id.`);
  if (source.provider === "local" && !source.assetId) errors.push(`${label}: local source needs assetId.`);
  if (!Number.isFinite(source.duration) || source.duration <= 0) errors.push(`${label}: duration must be positive.`);
  if (!Array.isArray(source.tracks) || source.tracks.length === 0) {
    errors.push(`${label}: at least one track is required.`);
    continue;
  }
  const trackIds = new Set();
  let priorEnd = -1;
  for (const [index, track] of source.tracks.entries()) {
    const trackLabel = `${label} / ${track.title || index + 1}`;
    if (!track.id || !track.title) errors.push(`${trackLabel}: id and title are required.`);
    if (trackIds.has(track.id)) errors.push(`${trackLabel}: duplicate track id ${track.id}.`);
    trackIds.add(track.id);
    if (!Number.isFinite(track.start) || !Number.isFinite(track.end)) errors.push(`${trackLabel}: start/end must be finite numbers.`);
    if (track.start < 0 || track.end <= track.start) errors.push(`${trackLabel}: invalid boundary ${track.start}–${track.end}.`);
    if (index > 0 && Math.abs(track.start - priorEnd) > 0.01) errors.push(`${trackLabel}: must begin where the preceding track ends.`);
    if (track.end > source.duration + 0.01) errors.push(`${trackLabel}: ends after source duration.`);
    priorEnd = track.end;
  }
  if (Math.abs(source.tracks.at(-1).end - source.duration) > 0.01) errors.push(`${label}: final track must end at source duration.`);
}

if (errors.length) {
  console.error(`Catalog validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

const trackCount = catalog.sources.reduce((sum, source) => sum + source.tracks.length, 0);
console.log(`Catalog valid: ${catalog.sources.length} sources, ${trackCount} tracks.`);
