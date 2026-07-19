import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogIndex, mergeCatalog, parseChapterLines } from "../assets/js/catalog.js";
import { formatTime, parseTimecode, parseYouTubeId } from "../assets/js/utils.js";
import { applyMusicLinksToCatalog, getMusicLinkEntries, sourceFromMusicLink } from "./music-link-ingest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "data", "catalog.json"), "utf8"));

assert.equal(parseYouTubeId("https://youtu.be/Y25LDO6OLzQ?si=test"), "Y25LDO6OLzQ");
assert.equal(parseYouTubeId("https://www.youtube.com/watch?v=JoUq869LXeA"), "JoUq869LXeA");
assert.equal(parseYouTubeId("https://www.youtube.com/live/Y25LDO6OLzQ?feature=share"), "Y25LDO6OLzQ");
assert.equal(parseYouTubeId("https://youtu.be/not-valid"), "");
assert.equal(parseTimecode("1:02:03.5"), 3723.5);
assert.equal(formatTime(3415), "56:55");

const chapters = parseChapterLines("0:00 First\n3:30 Second\n7:05 Third", 600);
assert.deepEqual(chapters.map((track) => [track.start, track.end]), [[0, 210], [210, 425], [425, 600]]);
assert.throws(() => parseChapterLines("0:00 First\n0:00 Duplicate", 100), /strictly increasing/);
assert.throws(() => parseChapterLines("0:00 First\n2:00 Too late", 120), /before the full source duration/);
const repeatedTitles = parseChapterLines("0:00 Intro\n1:00 Intro\n2:00 Intro", 180);
assert.deepEqual(repeatedTitles.map((track) => track.id), ["intro", "intro-2", "intro-3"]);

const indexed = buildCatalogIndex(base);
assert.equal(indexed.sources.length, 2);
assert.equal(indexed.tracks.length, 21);
assert.equal(indexed.trackByKey.get("of-monsters-and-men-the-cabin-sessions::six-weeks").start, 1126);

const override = structuredClone(base.sources[0]);
override.title = "Browser Override";
const merged = mergeCatalog(base, [override]);
assert.equal(merged.sources.length, 2);
assert.equal(merged.sourceById.get(override.id).title, "Browser Override");

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
