import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogIndex, mergeCatalog, parseChapterLines, sourceWithLocalAudio } from "../assets/js/catalog.js";
import { continuousRunEnd, continuousTrackIndexAtTime, isResumePosition } from "../assets/js/player.js";
import { formatTime, parseExtractedYouTubeId, parseTimecode, parseYouTubeId } from "../assets/js/utils.js";
import { applyMusicLinksToCatalog, getMusicLinkEntries, sourceFromMusicLink } from "./music-link-ingest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "data", "catalog.json"), "utf8"));

assert.equal(base.sources.length, 10);
for (const source of base.sources) {
  assert.equal(source.provider, "local");
  assert.match(source.audioUrl, /^\.\/media\/[\w-]{11}\.m4a$/);
  assert.match(source.artwork, /^\.\/assets\/artwork\/[\w-]{11}\.jpg$/);
  assert.equal(source.fallbackArtwork, source.artwork);
}

assert.equal(parseYouTubeId("https://youtu.be/Y25LDO6OLzQ?si=test"), "Y25LDO6OLzQ");
assert.equal(parseYouTubeId("https://www.youtube.com/watch?v=JoUq869LXeA"), "JoUq869LXeA");
assert.equal(parseYouTubeId("https://www.youtube.com/live/Y25LDO6OLzQ?feature=share"), "Y25LDO6OLzQ");
assert.equal(parseYouTubeId("https://youtu.be/not-valid"), "");
assert.equal(parseExtractedYouTubeId("Artist - Session [Y25LDO6OLzQ].m4a"), "Y25LDO6OLzQ");
assert.equal(parseExtractedYouTubeId("Artist - Session [Y25LDO6OLzQ].webm.opus"), "Y25LDO6OLzQ");
assert.equal(parseExtractedYouTubeId("Artist - Session.m4a"), "");
assert.equal(parseTimecode("1:02:03.5"), 3723.5);
assert.equal(formatTime(3415), "56:55");

const chapters = parseChapterLines("0:00 First\n3:30 Second\n7:05 Third", 600);
assert.deepEqual(chapters.map((track) => [track.start, track.end]), [[0, 210], [210, 425], [425, 600]]);
assert.throws(() => parseChapterLines("0:00 First\n0:00 Duplicate", 100), /strictly increasing/);
assert.throws(() => parseChapterLines("0:00 First\n2:00 Too late", 120), /before the full source duration/);
const repeatedTitles = parseChapterLines("0:00 Intro\n1:00 Intro\n2:00 Intro", 180);
assert.deepEqual(repeatedTitles.map((track) => track.id), ["intro", "intro-2", "intro-3"]);

const indexed = buildCatalogIndex(base);
assert.ok(indexed.sources.length >= 2);
assert.equal(indexed.sources.length, base.sources.length);
assert.equal(indexed.tracks.length, base.sources.reduce((total, source) => total + source.tracks.length, 0));
assert.equal(indexed.trackByKey.get("of-monsters-and-men-the-cabin-sessions::six-weeks").start, 1130);

const cabinQueue = indexed.sourceById.get("of-monsters-and-men-the-cabin-sessions").tracks.map((track) => track.key);
assert.equal(continuousRunEnd(cabinQueue, 0, (key) => indexed.trackByKey.get(key)), 3416);
assert.equal(continuousRunEnd(cabinQueue, 2, (key) => indexed.trackByKey.get(key), { enabled: false }), 767);
assert.equal(continuousTrackIndexAtTime(cabinQueue, 0, 1131, (key) => indexed.trackByKey.get(key)), 5);
assert.equal(continuousTrackIndexAtTime(cabinQueue, 5, 1200, (key) => indexed.trackByKey.get(key)), 5);
assert.equal(isResumePosition(null), false);
assert.equal(isResumePosition(undefined), false);
assert.equal(isResumePosition(""), false);
assert.equal(isResumePosition(120.5), true);

const override = structuredClone(base.sources[0]);
override.title = "Browser Override";
const merged = mergeCatalog(base, [override]);
assert.equal(merged.sources.length, base.sources.length);
assert.equal(merged.sourceById.get(override.id).title, "Browser Override");

const localOverride = sourceWithLocalAudio(base.sources[0], {
  assetId: "audio-test",
  name: "Session [JoUq869LXeA].m4a",
  type: "audio/mp4",
  size: 1024,
  duration: base.sources[0].duration + 0.4,
  lastModified: 123
});
assert.equal(localOverride.provider, "local");
assert.equal(localOverride.youtubeId, base.sources[0].youtubeId);
assert.equal(localOverride.tracks.at(-1).end, localOverride.duration);
assert.equal(localOverride.assetMeta.importKind, "authorized-extract");
assert.equal(localOverride.youtubeFallback.provider, "youtube");
assert.equal(localOverride.youtubeFallback.audioUrl, undefined);
assert.equal(localOverride.youtubeFallback.duration, base.sources[0].duration);
assert.throws(() => sourceWithLocalAudio(base.sources[0], {
  assetId: "audio-wrong",
  duration: base.sources[0].duration + 60
}), /different from the saved source/);

const singleLinkSource = sourceFromMusicLink({
  url: "https://youtu.be/dQw4w9WgXcQ",
  title: "Example Song",
  artist: "Example Artist",
  duration: "3:33",
  tags: "test, acoustic"
});
assert.equal(singleLinkSource.youtubeId, "dQw4w9WgXcQ");
assert.equal(singleLinkSource.tracks.length, 1);
assert.equal(singleLinkSource.tracks[0].end, 213);
assert.deepEqual(singleLinkSource.tags, ["test", "acoustic"]);

const linkEntries = getMusicLinkEntries({
  links: [
    { skip: true, url: "https://youtu.be/Y25LDO6OLzQ" },
    {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      title: "Chaptered Source",
      artist: "Example Artist",
      duration: "10:00",
      chapters: [
        { start: 0, title: "Opening" },
        { start: "3:30", title: "Middle" }
      ]
    }
  ]
});
assert.equal(linkEntries.length, 1);
const applied = applyMusicLinksToCatalog(base, linkEntries);
assert.equal(applied.summary.added.length, 1);
assert.equal(applied.catalog.sources.at(-1).tracks[1].start, 210);

console.log("Unit tests passed: parsing, boundaries, indexing, and browser overrides.");
