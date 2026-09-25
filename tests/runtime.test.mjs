import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildCatalogIndex, entitySlug, listCatalogProblems, mergeCatalog, parseChapterLines, sortName, validateCatalog } from "../assets/js/catalog.js";
import {
  LIBRARY_URL,
  LibrarySync,
  OfflineStore,
  describeTokenAccess,
  diffLibraries,
  ensureStreamable,
  fetchRemoteLibrary,
  fileUrl,
  isLibraryUrl,
  isValidLibrary,
  libraryToCatalog,
  setToken,
  clearToken,
  getToken,
  tokenAccess,
  verifyToken,
  warmArtworkCache
} from "../assets/js/cloud.js";
import { CONFIG } from "../assets/js/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "1111111111111111111111111111111111111111";
const DATASET = "https://huggingface.co/datasets/arjun10g/acoustify-library";

// ---------------------------------------------------------------------------
// Fixtures

function librarySource(overrides) {
  return {
    provider: "local",
    timingStatus: "official-chapters",
    tags: ["live"],
    ...overrides
  };
}

function makeLibrary({ revision = HEAD, generated = "2026-09-24T22:40:00Z", sources } = {}) {
  return {
    schema: 2,
    app: "acoustify",
    generated,
    repo: "arjun10g/acoustify-library",
    hub: "https://huggingface.co",
    revision,
    catalogVersion: 5,
    sources: sources || [
      librarySource({
        id: "the-red-clay-strays-live-af-laramie-2023",
        title: "Live AF (Laramie, 2023)",
        artist: "The Red Clay Strays",
        artists: ["The Red Clay Strays"],
        series: "Western AF",
        year: 2023,
        youtubeId: "wZL7rPowq2w",
        duration: 887.49,
        added: "2026-09-20",
        tags: ["live", "session"],
        audio: { path: "media/wZL7rPowq2w.m4a", rev: "aaaa000000000000000000000000000000000001", bytes: 14234567, sha256: "sha-red-clay", type: "audio/mp4" },
        art: { path: "artwork/wZL7rPowq2w.jpg", rev: "aaaa000000000000000000000000000000000002", bytes: 81234 },
        tracks: [
          { id: "stones-throw", title: "Stone's Throw", start: 0, end: 205, timingConfidence: "official" },
          { id: "wondering-why", title: "Wondering Why", start: 205, end: 480, timingConfidence: "official" },
          { id: "moments", title: "Moments", start: 480, end: 887.49, timingConfidence: "official" }
        ]
      }),
      librarySource({
        id: "tyler-childers-chris-stapleton-duets",
        title: "Duets",
        artist: "Tyler Childers & Chris Stapleton",
        artists: ["Tyler Childers", "Chris Stapleton"],
        series: "Western AF",
        youtubeId: "AAAAAAAAAAA",
        duration: 400,
        added: "2026-09-24",
        tags: ["duet"],
        audio: { path: "media/AAAAAAAAAAA.m4a", rev: "bbbb000000000000000000000000000000000001", bytes: 5000, sha256: "sha-duets", type: "audio/mp4" },
        art: { path: "artwork/AAAAAAAAAAA.jpg", rev: "bbbb000000000000000000000000000000000002", bytes: 900 },
        tracks: [
          { id: "together", title: "Together", start: 0, end: 200 },
          { id: "solo", title: "Solo", start: 200, end: 400, artists: ["Chris Stapleton"], artist: "Chris Stapleton" }
        ]
      }),
      librarySource({
        id: "of-monsters-and-men-live-from-skarkali",
        title: "Live from Skarkali",
        artist: "Of Monsters and Men",
        artists: ["Of Monsters and Men"],
        youtubeId: "JoUq869LXeA",
        duration: 2233.47,
        added: "2026-09-24",
        audio: { path: "media/JoUq869LXeA.m4a", rev: "cccc000000000000000000000000000000000001", bytes: 7000, sha256: "sha-omam", type: "audio/mp4" },
        art: null,
        tracks: [
          { id: "ordinary-creature", title: "Ordinary Creature", start: 115, end: 393 },
          { id: "dream-team", title: "Dream Team", start: 393, end: 2233.47 }
        ]
      }),
      librarySource({
        id: "the-lumineers-tiny-desk",
        title: "Tiny Desk Concert",
        artist: "The Lumineers",
        artists: ["The Lumineers"],
        series: "NPR Tiny Desk",
        youtubeId: "BBBBBBBBBBB",
        duration: 900,
        added: "2026-09-22",
        tags: ["acoustic"],
        audio: { path: "media/BBBBBBBBBBB.m4a", bytes: 9000, sha256: "sha-lumineers", type: "audio/mp4" },
        art: { path: "artwork/BBBBBBBBBBB.jpg" },
        tracks: [{ id: "ho-hey", title: "Ho Hey", start: 0, end: 900 }]
      })
    ]
  };
}

function catalogSource(overrides) {
  return {
    id: "an-artist-a-session",
    title: "A Session",
    artist: "An Artist",
    artists: ["An Artist"],
    provider: "local",
    youtubeId: "CCCCCCCCCCC",
    duration: 300,
    audio: "media/CCCCCCCCCCC.m4a",
    artwork: "artwork/CCCCCCCCCCC.jpg",
    added: "2026-09-24",
    tracks: [
      { id: "one", title: "One", start: 0, end: 100 },
      { id: "two", title: "Two", start: 100, end: 300 }
    ],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Browser-ish stand-ins for Cache Storage and fetch

class MemoryCache {
  entries = new Map();

  static key(request, { ignoreSearch = false } = {}) {
    const url = new URL(typeof request === "string" ? request : request.url);
    if (ignoreSearch) url.search = "";
    return url.href;
  }

  async match(request, options = {}) {
    if (options.ignoreSearch) {
      const wanted = MemoryCache.key(request, options);
      for (const [key, response] of this.entries) {
        if (MemoryCache.key(key, options) === wanted) return response.clone();
      }
      return undefined;
    }
    return this.entries.get(MemoryCache.key(request))?.clone();
  }

  async put(request, response) {
    const body = await response.arrayBuffer();
    this.entries.set(MemoryCache.key(request), new Response(body, { status: response.status, headers: response.headers }));
  }

  async delete(request, options = {}) {
    const wanted = MemoryCache.key(request, options);
    for (const key of this.entries.keys()) {
      if (MemoryCache.key(key, options) === wanted) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  stores = new Map();

  constructor(names = []) {
    for (const name of names) this.stores.set(name, new MemoryCache());
  }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async has(name) {
    return this.stores.has(name);
  }

  async delete(name) {
    return this.stores.delete(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }
}

function withGlobals(values, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const restore = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return Promise.resolve()
    .then(run)
    .finally(restore);
}

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

async function waitUntil(predicate, { timeout = 2000, label = "condition" } = {}) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// db.js logs when IndexedDB is missing (always, in Node); keep test output clean.
function quietWarnings() {
  const warn = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = warn;
  };
}

// ---------------------------------------------------------------------------
// cloud.js: URLs and library documents

test("library URLs are immutable per file", () => {
  assert.equal(LIBRARY_URL, `${DATASET}/resolve/main/library.json`);
  assert.equal(fileUrl("media/wZL7rPowq2w.m4a", "abc"), `${DATASET}/resolve/abc/media/wZL7rPowq2w.m4a`);
  assert.equal(fileUrl("media/wZL7rPowq2w.m4a"), `${DATASET}/resolve/main/media/wZL7rPowq2w.m4a`);
  assert.equal(isLibraryUrl(fileUrl("artwork/x.jpg", "r")), true);
  assert.equal(isLibraryUrl("https://huggingface.co/datasets/arjun10g/other/resolve/main/x"), false);
  assert.equal(isLibraryUrl("https://huggingface.co/datasets/arjun10g/acoustify-library-evil/resolve/main/x"), false);
  assert.equal(isLibraryUrl("https://evil.example/datasets/arjun10g/acoustify-library/resolve/main/x"), false);
  assert.equal(isLibraryUrl("./media/x.m4a"), false);
  assert.equal(isLibraryUrl(""), false);
  assert.equal(CONFIG.APP_VERSION.length > 0, true);
});

test("libraryToCatalog builds per-file-revision URLs and runtime fields", () => {
  const library = makeLibrary();
  const catalog = libraryToCatalog(library);
  assert.equal(catalog.revision, HEAD);
  assert.equal(catalog.generated, library.generated);
  assert.equal(catalog.version, 5);
  assert.equal(catalog.sources.length, 4);

  const [redClay, duets, omam, lumineers] = catalog.sources;
  assert.equal(redClay.audioUrl, `${DATASET}/resolve/aaaa000000000000000000000000000000000001/media/wZL7rPowq2w.m4a`);
  assert.equal(redClay.artwork, `${DATASET}/resolve/aaaa000000000000000000000000000000000002/artwork/wZL7rPowq2w.jpg`);
  assert.equal(redClay.fallbackArtwork, "https://i.ytimg.com/vi/wZL7rPowq2w/hqdefault.jpg");
  assert.equal(redClay.bytes, 14234567);
  assert.equal(redClay.sha256, "sha-red-clay");
  assert.equal(redClay.audio.path, "media/wZL7rPowq2w.m4a");
  assert.equal(redClay.series, "Western AF");
  assert.deepEqual(duets.artists, ["Tyler Childers", "Chris Stapleton"]);
  // No art in the library: artwork is null, the YouTube thumbnail is the fallback.
  assert.equal(omam.artwork, null);
  assert.equal(omam.fallbackArtwork, "https://i.ytimg.com/vi/JoUq869LXeA/hqdefault.jpg");
  // A file without its own rev resolves at the library head revision.
  assert.equal(lumineers.audioUrl, `${DATASET}/resolve/${HEAD}/media/BBBBBBBBBBB.m4a`);
  assert.equal(lumineers.artwork, `${DATASET}/resolve/${HEAD}/artwork/BBBBBBBBBBB.jpg`);

  const noArtists = libraryToCatalog(makeLibrary({ sources: [librarySource({ ...library.sources[3], artists: undefined, youtubeId: undefined })] }));
  assert.deepEqual(noArtists.sources[0].artists, ["The Lumineers"]);
  assert.equal(noArtists.sources[0].fallbackArtwork, "./assets/icons/icon-512.png");

  // Adding a song publishes a new head revision but must not move existing URLs (downloads stay valid).
  const next = libraryToCatalog(makeLibrary({ revision: "2222222222222222222222222222222222222222" }));
  assert.equal(next.sources[0].audioUrl, redClay.audioUrl);
});

test("isValidLibrary accepts schema 2 and rejects broken documents", () => {
  assert.equal(isValidLibrary(makeLibrary()), true);
  assert.equal(isValidLibrary(null), false);
  assert.equal(isValidLibrary([]), false);
  assert.equal(isValidLibrary({ ...makeLibrary(), schema: 1 }), false);
  assert.equal(isValidLibrary({ ...makeLibrary(), app: "papers" }), false);
  assert.equal(isValidLibrary({ ...makeLibrary(), sources: [] }), false);
  assert.equal(isValidLibrary({ ...makeLibrary(), sources: "nope" }), false);
  const library = makeLibrary();
  library.sources[1].id = library.sources[0].id;
  assert.equal(isValidLibrary(library), false, "duplicate ids");
  const noAudio = makeLibrary();
  noAudio.sources[0].audio = "media/wZL7rPowq2w.m4a";
  assert.equal(isValidLibrary(noAudio), false, "audio must be an object");
  const badTrack = makeLibrary();
  badTrack.sources[0].tracks[0].start = "0";
  assert.equal(isValidLibrary(badTrack), false, "numeric timings");
  const noTracks = makeLibrary();
  noTracks.sources[0].tracks = [];
  assert.equal(isValidLibrary(noTracks), false);
});

test("diffLibraries reports added, removed and changed sources", () => {
  const prev = makeLibrary();
  const next = makeLibrary({ revision: "2222222222222222222222222222222222222222" });
  next.sources = next.sources.filter((source) => source.id !== "the-lumineers-tiny-desk");
  next.sources.push(librarySource({
    id: "new-session",
    title: "New",
    artist: "New Artist",
    artists: ["New Artist"],
    duration: 10,
    audio: { path: "media/DDDDDDDDDDD.m4a", sha256: "sha-new" },
    tracks: [{ id: "a", title: "A", start: 0, end: 10 }]
  }));
  next.sources[0].audio.sha256 = "sha-red-clay-v2";
  next.sources[1].tracks[0].title = "Together (Live)";
  next.sources[2].title = "Only metadata changed";
  assert.deepEqual(diffLibraries(prev, next), {
    added: ["new-session"],
    removed: ["the-lumineers-tiny-desk"],
    changed: ["the-red-clay-strays-live-af-laramie-2023", "tyler-childers-chris-stapleton-duets"]
  });
  assert.deepEqual(diffLibraries(prev, prev), { added: [], removed: [], changed: [] });
  assert.deepEqual(diffLibraries(null, prev).added.length, 4);
});

// ---------------------------------------------------------------------------
// catalog.js: merge

function baseCatalog() {
  return libraryToCatalog(makeLibrary());
}

test("mergeCatalog: an edit override changes only editable fields", () => {
  const base = baseCatalog();
  const override = structuredClone(base.sources[0]);
  override.title = "Laramie (Edited)";
  override.artist = "Red Clay Strays";
  override.description = "Edited on the phone.";
  override.tags = ["favorite"];
  override.tracks = [
    { id: "stones-throw", title: "Stone's Throw", start: 0, end: 210, key: "stale::key", sourceTitle: "stale" },
    { id: "wondering-why", title: "Wondering Why?", start: 210, end: 480 },
    { id: "moments", title: "Moments", start: 480, end: 887 }
  ];
  // Fields an edit may not change:
  override.audioUrl = "https://example.com/other.m4a";
  override.artwork = "https://example.com/other.jpg";
  override.duration = 1;
  override.artists = ["Somebody Else"];
  override.series = "Other Series";
  override.added = "2000-01-01";
  override.youtubeId = "XXXXXXXXXXX";

  const merged = mergeCatalog(base, [override]);
  const source = merged.sourceById.get(override.id);
  assert.equal(merged.sources.length, 4);
  assert.equal(source.title, "Laramie (Edited)");
  assert.equal(source.artist, "Red Clay Strays");
  assert.equal(source.description, "Edited on the phone.");
  assert.deepEqual(source.tags, ["favorite"]);
  assert.equal(source.audioUrl, base.sources[0].audioUrl);
  assert.equal(source.artwork, base.sources[0].artwork);
  assert.equal(source.duration, 887.49);
  assert.deepEqual(source.artists, ["The Red Clay Strays"]);
  assert.equal(source.series, "Western AF");
  assert.equal(source.added, "2026-09-20");
  assert.equal(source.youtubeId, "wZL7rPowq2w");
  assert.equal(source.overridden, true);
  assert.deepEqual(source.tracks.map((track) => [track.title, track.start, track.end]), [
    ["Stone's Throw", 0, 210],
    ["Wondering Why?", 210, 480],
    ["Moments", 480, 887.49]
  ]);
  assert.equal(source.tracks[0].key, `${override.id}::stones-throw`);
  assert.equal(source.tracks[0].sourceTitle, "Laramie (Edited)");
  assert.equal(merged.trackByKey.get(`${override.id}::wondering-why`).title, "Wondering Why?");
  // Untouched sources are unchanged.
  assert.equal(merged.sourceById.get("the-lumineers-tiny-desk").title, "Tiny Desk Concert");
});

test("mergeCatalog: legacy v2 overrides with ./media paths never replace library files", () => {
  const base = baseCatalog();
  const legacy = {
    id: "of-monsters-and-men-live-from-skarkali",
    title: "Live from Skarkali (my titles)",
    artist: "Of Monsters and Men",
    provider: "local",
    youtubeId: "JoUq869LXeA",
    duration: 2233,
    audioUrl: "./media/JoUq869LXeA.m4a",
    artwork: "./assets/artwork/JoUq869LXeA.jpg",
    fallbackArtwork: "./assets/artwork/JoUq869LXeA.jpg",
    tracks: [
      { id: "ordinary-creature", title: "Ordinary Creature", start: 115, end: 393 },
      { id: "dream-team", title: "Dream Team!", start: 393, end: 2233 }
    ]
  };
  const merged = mergeCatalog(base, [legacy]);
  const source = merged.sourceById.get(legacy.id);
  assert.equal(source.title, "Live from Skarkali (my titles)");
  assert.equal(source.audioUrl, base.sources[2].audioUrl);
  assert.equal(source.artwork, null);
  assert.equal(source.fallbackArtwork, "https://i.ytimg.com/vi/JoUq869LXeA/hqdefault.jpg");
  assert.equal(source.duration, 2233.47);
  // 0.47 s off the re-encoded duration: titles kept, last boundary snapped.
  assert.equal(source.tracks[1].title, "Dream Team!");
  assert.equal(source.tracks[1].end, 2233.47);
  assert.doesNotThrow(() => validateCatalog({ sources: merged.sources }));

  // A legacy copy whose id was renamed attaches to the same recording instead of duplicating it.
  const renamed = { ...structuredClone(legacy), id: "omam-skarkali-old-id" };
  const byRecording = mergeCatalog(base, [renamed]);
  assert.equal(byRecording.sources.length, 4);
  assert.equal(byRecording.sourceById.get(legacy.id).title, "Live from Skarkali (my titles)");
  assert.equal(byRecording.sourceById.has("omam-skarkali-old-id"), false);

  // A legacy copy of a recording that is no longer in the library cannot play: dropped.
  const orphan = { ...structuredClone(legacy), id: "gone", youtubeId: "ZZZZZZZZZZZ", audioUrl: "./media/ZZZZZZZZZZZ.m4a" };
  assert.equal(mergeCatalog(base, [orphan]).sourceById.has("gone"), false);
});

test("mergeCatalog: imported audio (local asset) overrides playback fields", () => {
  const base = baseCatalog();
  const override = {
    ...structuredClone(base.sources[3]),
    provider: "local",
    assetId: "audio-123",
    assetMeta: { name: "Tiny Desk.m4a", duration: 905 },
    duration: 905,
    audioUrl: "./media/BBBBBBBBBBB.m4a",
    tracks: [{ id: "ho-hey", title: "Ho Hey", start: 0, end: 905 }]
  };
  const source = mergeCatalog(base, [override]).sourceById.get(override.id);
  assert.equal(source.assetId, "audio-123");
  assert.equal(source.duration, 905);
  assert.equal(source.tracks[0].end, 905);
  // The library file stays available as the fallback if the imported blob is missing.
  assert.equal(source.audioUrl, base.sources[3].audioUrl);
  assert.equal(source.artwork, base.sources[3].artwork);
});

test("mergeCatalog: a YouTube override plays from YouTube", () => {
  const base = baseCatalog();
  const override = {
    ...structuredClone(base.sources[0]),
    provider: "youtube",
    duration: 890,
    tracks: [
      { id: "stones-throw", title: "Stone's Throw", start: 2, end: 207 },
      { id: "rest", title: "The rest", start: 207, end: 890 }
    ]
  };
  const merged = mergeCatalog(base, [override]);
  const source = merged.sourceById.get(override.id);
  assert.equal(source.provider, "youtube");
  assert.equal(source.youtubeId, "wZL7rPowq2w");
  assert.equal(source.duration, 890);
  assert.equal(source.audioUrl, undefined);
  assert.equal(source.artwork, base.sources[0].artwork, "library artwork is kept");
  assert.equal(source.tracks.length, 2);
  assert.equal(merged.trackByKey.get(`${override.id}::rest`).provider, "youtube");
});

test("mergeCatalog: override tracks that do not fit the library duration are dropped", () => {
  const base = baseCatalog();
  const override = structuredClone(base.sources[1]);
  override.title = "Duets (edited)";
  override.tracks = [
    { id: "together", title: "Together", start: 0, end: 200 },
    { id: "solo", title: "Solo", start: 200, end: 460 }
  ];
  const source = mergeCatalog(base, [override]).sourceById.get(override.id);
  assert.equal(source.title, "Duets (edited)");
  assert.deepEqual(source.tracks.map((track) => track.end), [200, 400]);

  const gap = structuredClone(base.sources[1]);
  gap.tracks = [
    { id: "together", title: "Together", start: 0, end: 150 },
    { id: "solo", title: "Solo", start: 200, end: 400 }
  ];
  assert.deepEqual(mergeCatalog(base, [gap]).sourceById.get(gap.id).tracks.map((track) => track.end), [200, 400]);
});

test("mergeCatalog keeps user-only sources", () => {
  const base = baseCatalog();
  const youtube = {
    id: "my-youtube-find",
    title: "A Find",
    artist: "Someone",
    provider: "youtube",
    youtubeId: "EEEEEEEEEEE",
    duration: 120,
    tracks: [{ id: "find", title: "Find", start: 0, end: 120 }]
  };
  const merged = mergeCatalog(base, [youtube]);
  assert.equal(merged.sources.length, 5);
  const source = merged.sourceById.get("my-youtube-find");
  assert.equal(source.userSource, true);
  assert.equal(source.artwork, "https://i.ytimg.com/vi/EEEEEEEEEEE/maxresdefault.jpg");
  assert.equal(merged.artistBySlug.get("someone").songCount, 1);
});

test("mergeCatalog: addresses restored from a backup must be https (or an inline image)", () => {
  const base = baseCatalog();
  const imported = {
    id: "imported",
    title: "Imported",
    artist: "Someone",
    provider: "local",
    duration: 60,
    audioUrl: "https://example.com/song.m4a",
    artwork: "javascript:alert(1)",
    fallbackArtwork: "http://tracker.example/pixel.gif",
    tracks: [{ id: "a", title: "A", start: 0, end: 60 }]
  };
  const source = mergeCatalog(base, [imported]).sourceById.get("imported");
  assert.equal(source.audioUrl, "https://example.com/song.m4a");
  assert.equal(source.artwork, null);
  assert.equal(source.fallbackArtwork, "./assets/icons/icon-512.png");
  const inline = mergeCatalog(base, [{ ...imported, artwork: "data:image/png;base64,iVBORw0KGgo=" }]).sourceById.get("imported");
  assert.equal(inline.artwork, "data:image/png;base64,iVBORw0KGgo=");
  // Nothing left to play from: dropped instead of listed as a song that can never play.
  for (const audioUrl of ["javascript:alert(1)", "http://example.com/a.m4a", "https://user:pw@example.com/a.m4a", "/etc/passwd", "data:audio/mp4;base64,AAAA"]) {
    assert.equal(mergeCatalog(base, [{ ...imported, audioUrl }]).sourceById.has("imported"), false, audioUrl);
  }
  // Imported audio (a file kept on the device) needs no address at all.
  const asset = mergeCatalog(base, [{ ...imported, audioUrl: "javascript:x", assetId: "audio-1" }]).sourceById.get("imported");
  assert.equal(asset.assetId, "audio-1");
  assert.equal(asset.audioUrl, undefined);
  // A playback override on a library source cannot bring in a script URL as artwork either.
  const youtube = { ...structuredClone(base.sources[2]), provider: "youtube", artwork: "javascript:alert(1)" };
  assert.equal(mergeCatalog(base, [youtube]).sourceById.get(youtube.id).artwork, "https://i.ytimg.com/vi/JoUq869LXeA/maxresdefault.jpg");
  const cover = { ...youtube, artwork: "https://example.com/cover.jpg" };
  assert.equal(mergeCatalog(base, [cover]).sourceById.get(cover.id).artwork, "https://example.com/cover.jpg");
});

// ---------------------------------------------------------------------------
// catalog.js: index

test("buildCatalogIndex groups artists and series", () => {
  const index = buildCatalogIndex(baseCatalog());
  assert.deepEqual(index.artists.map((artist) => artist.name), [
    "Chris Stapleton",
    "The Lumineers",
    "Of Monsters and Men",
    "The Red Clay Strays",
    "Tyler Childers"
  ]);
  assert.deepEqual(index.artists.map((artist) => artist.slug), [
    "chris-stapleton",
    "the-lumineers",
    "of-monsters-and-men",
    "the-red-clay-strays",
    "tyler-childers"
  ]);

  const chris = index.artistBySlug.get("chris-stapleton");
  assert.deepEqual(chris.sourceIds, ["tyler-childers-chris-stapleton-duets"]);
  assert.equal(chris.songCount, 2);
  assert.equal(chris.sourceCount, 1);
  assert.deepEqual(chris.series, ["Western AF"]);
  const tyler = index.artistBySlug.get("tyler-childers");
  // Track-level credits: the solo song is Chris's only.
  assert.deepEqual(tyler.trackKeys, ["tyler-childers-chris-stapleton-duets::together"]);
  assert.equal(tyler.songCount, 1);
  assert.equal(tyler.latestAdded, "2026-09-24");
  assert.equal(tyler.artwork, index.sourceById.get("tyler-childers-chris-stapleton-duets").artwork);

  const omam = index.artistBySlug.get("of-monsters-and-men");
  assert.equal(omam.artwork, null, "no library artwork anywhere");
  assert.equal(omam.fallbackArtwork, "https://i.ytimg.com/vi/JoUq869LXeA/hqdefault.jpg");
  assert.deepEqual(omam.series, []);

  assert.deepEqual(index.series.map((item) => [item.name, item.slug, item.sourceCount]), [
    ["Western AF", "western-af", 2],
    ["NPR Tiny Desk", "npr-tiny-desk", 1]
  ]);
  const western = index.seriesBySlug.get("western-af");
  assert.deepEqual(western.sourceIds, ["tyler-childers-chris-stapleton-duets", "the-red-clay-strays-live-af-laramie-2023"], "newest first");
  assert.equal(western.songCount, 5);
  assert.equal(western.latestAdded, "2026-09-24");
  assert.equal(western.artwork, index.sourceById.get("tyler-childers-chris-stapleton-duets").artwork);

  assert.deepEqual(index.sourcesByAdded.map((source) => source.id), [
    "tyler-childers-chris-stapleton-duets",
    "of-monsters-and-men-live-from-skarkali",
    "the-lumineers-tiny-desk",
    "the-red-clay-strays-live-af-laramie-2023"
  ]);
  assert.deepEqual(index.tags, ["acoustic", "duet", "live", "session"]);

  const solo = index.trackByKey.get("tyler-childers-chris-stapleton-duets::solo");
  assert.equal(solo.artist, "Chris Stapleton");
  assert.deepEqual(solo.artists, ["Chris Stapleton"]);
  assert.deepEqual(solo.artistSlugs, ["chris-stapleton"]);
  assert.equal(solo.series, "Western AF");
  assert.equal(solo.duration, 200);
  assert.equal(solo.index, 1);
  assert.equal(solo.added, "2026-09-24");
  const together = index.trackByKey.get("tyler-childers-chris-stapleton-duets::together");
  assert.equal(together.artist, "Tyler Childers & Chris Stapleton");
  assert.deepEqual(together.artistSlugs, ["tyler-childers", "chris-stapleton"]);
  const firstOmam = index.trackByKey.get("of-monsters-and-men-live-from-skarkali::ordinary-creature");
  assert.equal(firstOmam.artwork, "https://i.ytimg.com/vi/JoUq869LXeA/hqdefault.jpg");
  assert.equal(firstOmam.duration, 278);
  assert.equal(index.tracks.length, 8);
  assert.equal(index.sourceById.get("tyler-childers-chris-stapleton-duets").tracks[1], solo, "source tracks are the indexed tracks");
});

test("slugs are stable and sortName ignores a leading The", () => {
  assert.equal(entitySlug("Sigur Rós"), "sigur-ros");
  assert.equal(entitySlug("The Red Clay Strays"), "the-red-clay-strays");
  const japanese = entitySlug("宇多田ヒカル", "artist");
  assert.match(japanese, /^artist-[a-z0-9]+$/);
  assert.equal(entitySlug("宇多田ヒカル", "artist"), japanese, "deterministic for non-Latin names");
  assert.equal(sortName("The Lumineers"), "Lumineers");
  assert.equal(sortName("Theo Katzman"), "Theo Katzman");
  const index = buildCatalogIndex({
    sources: [
      catalogSource({ id: "a", artist: "the band", artists: ["the band"] }),
      catalogSource({ id: "b", artist: "Alabama Shakes", artists: ["Alabama Shakes"] }),
      catalogSource({ id: "c", artist: "Theo Katzman", artists: ["Theo Katzman"] })
    ]
  });
  assert.deepEqual(index.artists.map((artist) => artist.name), ["Alabama Shakes", "the band", "Theo Katzman"]);
});

// ---------------------------------------------------------------------------
// catalog.js: validation and chapters

test("validateCatalog enforces the v5 schema", () => {
  const good = { version: 5, sources: [catalogSource({})] };
  assert.equal(validateCatalog(good), true);
  const cases = [
    [{ artists: [] }, /artists list/],
    [{ artists: ["ok", " "] }, /artists list/],
    [{ audio: "./media/CCCCCCCCCCC.m4a" }, /audio must look like/],
    [{ audio: "media/CCCCCCCCCCC.mp3" }, /audio must look like/],
    [{ artwork: "artwork/CCCCCCCCCCC.png" }, /artwork must look like/],
    [{ added: "24/09/2026" }, /added date/],
    [{ added: "2026-13-45" }, /added date/],
    [{ provider: "youtube" }, /provider "local"/],
    [{ tracks: [{ id: "one", title: "One", start: 0, end: 100 }, { id: "two", title: "Two", start: 101, end: 300 }] }, /continuous/],
    [{ tracks: [{ id: "one", title: "One", start: 0, end: 100 }, { id: "one", title: "Two", start: 100, end: 300 }] }, /Duplicate track id/],
    [{ tracks: [{ id: "one", title: "One", start: 0, end: 100 }, { id: "two", title: "Two", start: 100, end: 299 }] }, /final track/],
    [{ tracks: [{ id: "one", title: "One", start: -1, end: 300 }] }, /Invalid timing/],
    [{ tracks: [{ id: "one", title: "One", start: 0, end: 301 }] }, /ends after/],
    [{ tracks: [] }, /at least one track/]
  ];
  for (const [patch, pattern] of cases) {
    assert.throws(() => validateCatalog({ version: 5, sources: [catalogSource(patch)] }), pattern, JSON.stringify(patch));
  }
  // Within 0.01 s is contiguous.
  assert.equal(validateCatalog({ version: 5, sources: [catalogSource({ tracks: [{ id: "one", title: "One", start: 0, end: 100 }, { id: "two", title: "Two", start: 100.005, end: 300.009 }] })] }), true);
  assert.throws(() => validateCatalog({ version: 5, sources: [catalogSource({}), catalogSource({})] }), /Duplicate source id/);
  assert.throws(() => validateCatalog({}), /sources array/);

  const problems = listCatalogProblems({ version: 5, sources: [catalogSource({ artists: [], added: "" })] });
  assert.equal(problems.length, 2);
  try {
    validateCatalog({ version: 5, sources: [catalogSource({ artists: [], added: "" })] });
  } catch (error) {
    assert.deepEqual(error.errors, problems);
    assert.match(error.message, /\(\+1 more\)/);
  }

  // Runtime shapes (browser overrides, backups) use the structural rules.
  assert.equal(validateCatalog({ version: 1, sources: [{ id: "x", title: "X", artist: "Y", provider: "youtube", youtubeId: "EEEEEEEEEEE", duration: 10, tracks: [{ id: "a", title: "A", start: 0, end: 10 }] }] }), true);
  assert.throws(() => validateCatalog({ version: 1, sources: [{ id: "x", title: "X", artist: "Y", provider: "youtube", youtubeId: "nope", duration: 10, tracks: [{ id: "a", title: "A", start: 0, end: 10 }] }] }), /YouTube id/);
});

// An album joined from a YouTube playlist: no video of its own, one video per song.
function playlistAlbum(overrides) {
  return catalogSource({
    id: "the-red-clay-strays-live-at-the-ryman",
    title: "Live at the Ryman",
    artist: "The Red Clay Strays",
    artists: ["The Red Clay Strays"],
    series: "Ryman Auditorium",
    youtubeId: undefined,
    youtubePlaylistId: "PLDtVvFL-MTp4S1vFu91Yd9XKWNyOwDY3R",
    audio: "media/rcs-live-at-the-ryman.m4a",
    artwork: "artwork/rcs-live-at-the-ryman.jpg",
    tracks: [
      { id: "wanna-be-loved", title: "Wanna Be Loved", start: 0, end: 100, timingConfidence: "official", youtubeId: "qyA6gOeRIyQ" },
      { id: "im-still-fine", title: "I'm Still Fine", start: 100, end: 300, timingConfidence: "official", youtubeId: "9r78xTZ7q08" }
    ],
    ...overrides
  });
}

test("validateCatalog accepts a playlist album whose songs carry their own video ids", () => {
  const { youtubeId: _none, ...album } = playlistAlbum({});
  assert.equal(validateCatalog({ version: 5, sources: [album] }), true);
  assert.equal(validateCatalog({ version: 5, sources: [playlistAlbum({ youtubeId: "" })] }), true, "an empty youtubeId counts as none");
  assert.equal(validateCatalog({ version: 5, sources: [playlistAlbum({ youtubeId: "CCCCCCCCCCC" })] }), true, "a playlist source may also name a video");
  // Readable file names are fine; anything path-like is not.
  assert.equal(validateCatalog({ version: 5, sources: [catalogSource({ audio: "media/some_album-2024.m4a", artwork: "artwork/some_album-2024.jpg" })] }), true);
  const cases = [
    [{ youtubePlaylistId: undefined }, /valid YouTube id/],
    [{ youtubePlaylistId: "PL" }, /playlist id/],
    [{ youtubePlaylistId: "PL/../x-yyyyyyyyyy" }, /playlist id/],
    [{ youtubeId: "short" }, /valid YouTube id/],
    [{ audio: "media/live at the ryman.m4a" }, /audio must look like/],
    [{ audio: "media/../secret.m4a" }, /audio must look like/],
    [{ artwork: "artwork/rcs.live.jpg" }, /artwork must look like/],
    [{ tracks: [{ id: "one", title: "One", start: 0, end: 300, youtubeId: "nope" }] }, /invalid YouTube id/]
  ];
  for (const [patch, pattern] of cases) {
    assert.throws(() => validateCatalog({ version: 5, sources: [playlistAlbum(patch)] }), pattern, JSON.stringify(patch));
  }
  // Runtime shapes keep the structural rules only.
  assert.equal(validateCatalog({ version: 1, sources: [playlistAlbum({ tracks: [{ id: "one", title: "One", start: 0, end: 300, youtubeId: "nope" }] })] }), true);
});

test("a playlist album gets its first song's still as fallback artwork and keeps per-song video ids", () => {
  const library = makeLibrary({
    sources: [
      librarySource({
        ...playlistAlbum({ youtubeId: undefined }),
        audio: { path: "media/rcs-live-at-the-ryman.m4a", rev: "cccc000000000000000000000000000000000001", bytes: 49260238, sha256: "sha-ryman", type: "audio/mp4" },
        art: { path: "artwork/rcs-live-at-the-ryman.jpg", rev: "cccc000000000000000000000000000000000002", bytes: 30218 }
      })
    ]
  });
  delete library.sources[0].artwork;
  assert.equal(isValidLibrary(library), true);
  assert.equal(libraryToCatalog(library).sources[0].fallbackArtwork, "https://i.ytimg.com/vi/qyA6gOeRIyQ/hqdefault.jpg",
    "libraryToCatalog already picks the first song's still");
  const index = buildCatalogIndex(libraryToCatalog(library));
  const album = index.sourceById.get("the-red-clay-strays-live-at-the-ryman");
  assert.equal(album.youtubeId, "");
  assert.equal(album.youtubePlaylistId, "PLDtVvFL-MTp4S1vFu91Yd9XKWNyOwDY3R");
  assert.equal(album.audioUrl, `${DATASET}/resolve/cccc000000000000000000000000000000000001/media/rcs-live-at-the-ryman.m4a`);
  assert.equal(album.artwork, `${DATASET}/resolve/cccc000000000000000000000000000000000002/artwork/rcs-live-at-the-ryman.jpg`);
  assert.equal(album.fallbackArtwork, "https://i.ytimg.com/vi/qyA6gOeRIyQ/hqdefault.jpg", "not the app icon");
  const song = index.trackByKey.get("the-red-clay-strays-live-at-the-ryman::im-still-fine");
  assert.equal(song.youtubeId, "9r78xTZ7q08", "each song keeps its own video");
  assert.equal(song.fallbackArtwork, album.fallbackArtwork);
  assert.equal(index.seriesBySlug.get("ryman-auditorium").songCount, 2);

  // Without per-song videos there is nothing better than the icon.
  const bare = buildCatalogIndex({ sources: [playlistAlbum({ youtubeId: undefined, tracks: [{ id: "one", title: "One", start: 0, end: 300 }] })] });
  assert.equal(bare.sources[0].fallbackArtwork, "./assets/icons/icon-512.png");
  // A source with its own video keeps that video's still.
  assert.equal(buildCatalogIndex({ sources: [playlistAlbum({ youtubeId: "CCCCCCCCCCC" })] }).sources[0].fallbackArtwork,
    "https://i.ytimg.com/vi/CCCCCCCCCCC/hqdefault.jpg");

  // Editing song times keeps each song's video id from the library.
  const override = structuredClone(album);
  override.tracks = [
    { id: "wanna-be-loved", title: "Wanna Be Loved (edited)", start: 0, end: 110 },
    { id: "im-still-fine", title: "I'm Still Fine", start: 110, end: 300 }
  ];
  const merged = mergeCatalog(libraryToCatalog(library), [override]).sourceById.get(album.id);
  assert.deepEqual(merged.tracks.map((track) => [track.title, track.start, track.youtubeId]), [
    ["Wanna Be Loved (edited)", 0, "qyA6gOeRIyQ"],
    ["I'm Still Fine", 110, "9r78xTZ7q08"]
  ]);
  assert.equal(merged.fallbackArtwork, "https://i.ytimg.com/vi/qyA6gOeRIyQ/hqdefault.jpg");
});

test("validateCatalog accepts data/catalog.json once it is on schema 5", (t) => {
  const file = path.join(root, "data", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number(catalog.version) < 5) {
    t.skip(`data/catalog.json is still version ${catalog.version}`);
    return;
  }
  assert.equal(validateCatalog(catalog), true);
  const index = buildCatalogIndex(catalog);
  assert.equal(index.tracks.length, catalog.sources.reduce((total, source) => total + source.tracks.length, 0));
  assert.ok(index.artists.length > 0);
  for (const artist of index.artists) assert.equal(index.artistBySlug.get(artist.slug), artist);
});

test("data/library.json (when published) is a valid schema 2 library", (t) => {
  const file = path.join(root, "data", "library.json");
  if (!fs.existsSync(file)) {
    t.skip("data/library.json has not been generated yet");
    return;
  }
  const library = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(isValidLibrary(library), true);
  const catalog = libraryToCatalog(library);
  for (const source of catalog.sources) {
    assert.ok(isLibraryUrl(source.audioUrl), source.id);
    assert.ok(source.artwork === null || isLibraryUrl(source.artwork), source.id);
  }
  assert.doesNotThrow(() => buildCatalogIndex(catalog));
});

test("parseChapterLines", () => {
  const chapters = parseChapterLines("0:00 First\n3:30 Second\n7:05 Third", 600);
  assert.deepEqual(chapters.map((track) => [track.start, track.end]), [[0, 210], [210, 425], [425, 600]]);
  assert.throws(() => parseChapterLines("0:00 First\n0:00 Duplicate", 100), /strictly increasing/);
  assert.throws(() => parseChapterLines("0:00 First\n2:00 Too late", 120), /before the full source duration/);
  const repeatedTitles = parseChapterLines("0:00 Intro\n1:00 Intro\n2:00 Intro", 180);
  assert.deepEqual(repeatedTitles.map((track) => track.id), ["intro", "intro-2", "intro-3"]);
  const trailing = parseChapterLines("Opening - 0:00\nClosing | 1:02:03.5", 4000);
  assert.deepEqual(trailing.map((track) => [track.title, track.start]), [["Opening", 0], ["Closing", 3723.5]]);
  assert.equal(trailing.at(-1).end, 4000);
  assert.equal(trailing[0].timingConfidence, "user");
  assert.throws(() => parseChapterLines("", 100), /at least one/);
  assert.throws(() => parseChapterLines("no time here", 100), /Could not parse/);
});

// ---------------------------------------------------------------------------
// sw.js in a sandbox

function loadServiceWorker({ cacheNames = [], fetchImpl, scope = "https://arjun10g.github.io/acoustify/" } = {}) {
  const listeners = {};
  const cachesStub = new MemoryCacheStorage(cacheNames);
  const calls = { skipWaiting: 0, claim: 0, fetches: [], navigated: [] };
  const windows = [`${scope}#/home`, `${scope}index.html`].map((url) => ({
    url,
    navigate: async (target) => {
      calls.navigated.push(target);
    }
  }));
  const self = {
    location: new URL(`${scope}sw.js`),
    registration: { scope },
    clients: {
      claim: async () => { calls.claim += 1; },
      matchAll: async () => windows
    },
    skipWaiting: async () => { calls.skipWaiting += 1; },
    addEventListener: (type, listener) => { listeners[type] = listener; }
  };
  const context = vm.createContext({
    self,
    caches: cachesStub,
    fetch: async (input, init) => {
      calls.fetches.push({ input: typeof input === "string" ? input : input.url, cache: typeof input === "string" ? init?.cache : input.cache, init });
      if (!fetchImpl) throw new TypeError("offline");
      return fetchImpl(input, init);
    },
    URL,
    Request,
    Response,
    Headers,
    Blob,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, "sw.js"), "utf8"), context, { filename: "sw.js" });
  async function dispatch(type, event) {
    const pending = [];
    let response;
    const full = {
      ...event,
      waitUntil: (promise) => pending.push(promise),
      respondWith: (promise) => { response = promise; }
    };
    listeners[type](full);
    await Promise.all(pending);
    return response === undefined ? undefined : await response;
  }
  return { context, caches: cachesStub, calls, dispatch, listeners };
}

test("sw.js parseRange handles every Range form", () => {
  const { context } = loadServiceWorker();
  const parseRange = context.parseRange;
  const plain = (value) => (value ? { start: value.start, end: value.end } : value);
  assert.equal(typeof parseRange, "function");
  assert.deepEqual(plain(parseRange("bytes=0-", 1000)), { start: 0, end: 999 });
  assert.deepEqual(plain(parseRange("bytes=0-1", 1000)), { start: 0, end: 1 });
  assert.deepEqual(plain(parseRange("bytes=500-", 1000)), { start: 500, end: 999 });
  assert.deepEqual(plain(parseRange("bytes=500-5000", 1000)), { start: 500, end: 999 });
  assert.deepEqual(plain(parseRange("bytes=-100", 1000)), { start: 900, end: 999 });
  assert.deepEqual(plain(parseRange("bytes=-5000", 1000)), { start: 0, end: 999 });
  assert.deepEqual(plain(parseRange(" bytes=10-20 ", 1000)), { start: 10, end: 20 });
  assert.equal(parseRange("bytes=1000-", 1000), null);
  assert.equal(parseRange("bytes=20-10", 1000), null);
  assert.equal(parseRange("bytes=-0", 1000), null);
  assert.equal(parseRange("bytes=-", 1000), null);
  assert.equal(parseRange("bytes=0-1,5-6", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange("bytes=0-", 0), null);
});

test("sw.js serves downloaded audio with 200, 206 and 416", async () => {
  const { caches: storage, dispatch } = loadServiceWorker();
  const url = `${DATASET}/resolve/abc/media/wZL7rPowq2w.m4a`;
  const bytes = new Uint8Array(1000).map((_, index) => index % 256);
  const audio = await storage.open("acoustify-audio-v1");
  await audio.put(url, new Response(bytes, { headers: { "Content-Type": "audio/mp4", "Content-Length": "1000" } }));

  const full = await dispatch("fetch", { request: new Request(url) });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal((await full.arrayBuffer()).byteLength, 1000);

  const partial = await dispatch("fetch", { request: new Request(url, { headers: { Range: "bytes=100-199" } }) });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal(partial.headers.get("content-type"), "audio/mp4");
  const body = new Uint8Array(await partial.arrayBuffer());
  assert.equal(body.length, 100);
  assert.equal(body[0], 100);

  const unsatisfiable = await dispatch("fetch", { request: new Request(url, { headers: { Range: "bytes=5000-" } }) });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), "bytes */1000");
});

test("sw.js adds the token only to library requests", async () => {
  const seen = [];
  const { caches: storage, dispatch, listeners } = loadServiceWorker({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: typeof input === "string" ? input : input.url, auth: headers.get("authorization"), range: headers.get("range"), mode: init?.mode, credentials: init?.credentials });
      return new Response("ok", { status: 206 });
    }
  });
  const auth = await storage.open("acoustify-auth");
  await auth.put("https://arjun10g.github.io/acoustify/__hf_token__", new Response("hf_test_token"));

  const media = `${DATASET}/resolve/abc/media/wZL7rPowq2w.m4a`;
  await dispatch("fetch", { request: new Request(media, { headers: { Range: "bytes=0-1" } }) });
  assert.deepEqual(seen.at(-1), { url: media, auth: "Bearer hf_test_token", range: "bytes=0-1", mode: "cors", credentials: "omit" });

  // Offline downloads (no-store) do not also fill the HTTP cache.
  let lastInit = null;
  const recorder = loadServiceWorker({ fetchImpl: async (input, init) => { lastInit = init; return new Response("ok"); } });
  await recorder.dispatch("fetch", { request: new Request(media, { cache: "no-store" }) });
  assert.equal(lastInit.cache, "no-store");
  await recorder.dispatch("fetch", { request: new Request(media, { headers: { Range: "bytes=0-" } }) });
  assert.equal(lastInit.cache, undefined);

  // A request that carries its own key keeps it (token verification).
  await dispatch("fetch", { request: new Request(LIBRARY_URL, { headers: { Authorization: "Bearer hf_candidate" } }) });
  assert.equal(seen.at(-1).auth, "Bearer hf_candidate");

  // Never leaked anywhere else.
  assert.equal(await dispatch("fetch", { request: new Request("https://example.com/x.m4a") }), undefined);
  assert.equal(await dispatch("fetch", { request: new Request("https://huggingface.co/datasets/someone/else/resolve/main/media/x.m4a") }), undefined);

  // Token changes are picked up after TOKEN_CHANGED, which is acknowledged so the page can wait for it.
  await auth.delete("https://arjun10g.github.io/acoustify/__hf_token__");
  const port = { messages: [], postMessage(message) { this.messages.push(message); } };
  listeners.message({ data: { type: "TOKEN_CHANGED" }, ports: [port] });
  assert.equal(port.messages[0]?.type, "TOKEN_ACK");
  await dispatch("fetch", { request: new Request(`${DATASET}/resolve/abc/artwork/wZL7rPowq2w.jpg`) });
  assert.equal(seen.at(-1).auth, null);
});

test("sw.js answers SKIP_WAITING and GET_VERSION", () => {
  const { listeners, calls } = loadServiceWorker();
  listeners.message({ data: { type: "SKIP_WAITING" } });
  assert.equal(calls.skipWaiting, 1);
  const port = { messages: [], postMessage(message) { this.messages.push(message); } };
  listeners.message({ data: { type: "GET_VERSION" }, ports: [port] });
  assert.equal(port.messages[0]?.version, "dev");
  listeners.message({ data: null });
});

test("sw.js keeps APP_VERSION and the dataset in step with config.js", () => {
  const source = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.match(source, new RegExp(`const APP_VERSION = "${CONFIG.APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`));
  assert.match(source, new RegExp(`const HUB = "${CONFIG.HUB}";`));
  assert.match(source, new RegExp(`const REPO = "${CONFIG.REPO}";`));
});

test("sw.js activate only removes its own old shell caches", async () => {
  const names = ["shell-test", "shell-2026.09.16-1", "audio-v1", "docs-v1", "art-v1", "acoustify-shell-v2.1.0", "acoustify-shell-old", "acoustify-audio-v1", "acoustify-art-v1", "acoustify-auth", "acoustify-shell-dev"];
  const { caches: storage, calls, dispatch } = loadServiceWorker({ cacheNames: names });
  await dispatch("activate", {});
  assert.deepEqual(await storage.keys(), names.filter((name) => !["acoustify-shell-v2.1.0", "acoustify-shell-old"].includes(name)));
  assert.equal(calls.claim, 1);
  // Replacing the v2 app reloads its open windows into this release (after activation settles).
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.navigated, ["https://arjun10g.github.io/acoustify/#/home", "https://arjun10g.github.io/acoustify/index.html"]);

  // A normal release-to-release activation never reloads anyone.
  const normal = loadServiceWorker({ cacheNames: ["acoustify-shell-previous", "shell-test"] });
  await normal.dispatch("activate", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await normal.caches.keys(), ["shell-test"]);
  assert.deepEqual(normal.calls.navigated, []);
});

test("sw.js install precaches the shell and only skips waiting over the legacy app", async () => {
  const ok = () => async (input) => new Response(`file ${typeof input === "string" ? input : input.url}`, { status: 200 });
  const fresh = loadServiceWorker({ fetchImpl: ok() });
  await fresh.dispatch("install", {});
  const shell = await fresh.caches.open("acoustify-shell-dev");
  assert.ok(await shell.match("https://arjun10g.github.io/acoustify/index.html"));
  assert.ok(await shell.match("https://arjun10g.github.io/acoustify/assets/js/views/edit.js"));
  assert.ok(await shell.match("https://arjun10g.github.io/acoustify/data/library.json"));
  assert.equal(fresh.calls.skipWaiting, 0);
  assert.equal(fresh.calls.fetches[0].input, "https://arjun10g.github.io/acoustify/");
  assert.ok(fresh.calls.fetches.every((call) => call.cache === "reload"), "precache bypasses the HTTP cache");

  const legacy = loadServiceWorker({ cacheNames: ["acoustify-shell-v2.1.0"], fetchImpl: ok() });
  await legacy.dispatch("install", {});
  assert.equal(legacy.calls.skipWaiting, 1);

  // One missing optional file is tolerated; a missing index.html fails the install.
  const missingIcon = loadServiceWorker({ fetchImpl: async (input) => new Response("x", { status: String(input.url || input).endsWith("maskable-512.png") ? 404 : 200 }) });
  await missingIcon.dispatch("install", {});
  const noIndex = loadServiceWorker({ fetchImpl: async (input) => new Response("x", { status: String(input.url || input).endsWith("index.html") ? 404 : 200 }) });
  await assert.rejects(noIndex.dispatch("install", {}), /precache failed/);

  // Navigations to the app come straight from the shell cache.
  const navigation = { url: "https://arjun10g.github.io/acoustify/#/home", method: "GET", mode: "navigate", cache: "default", headers: new Headers() };
  const page = await fresh.dispatch("fetch", { request: navigation });
  assert.match(await page.text(), /index\.html/);
  // Other apps on the shared origin are never intercepted.
  assert.equal(await fresh.dispatch("fetch", { request: new Request("https://arjun10g.github.io/Papers_Audio/app/app.js") }), undefined);
});

// ---------------------------------------------------------------------------
// cloud.js against stubbed browser storage

test("token storage round-trips through Cache Storage", async () => {
  await withGlobals({ caches: new MemoryCacheStorage() }, async () => {
    assert.equal(await getToken(), "");
    await setToken("  Bearer hf_abc123  ");
    assert.equal(await getToken(), "hf_abc123");
    const stored = await (await globalThis.caches.open("acoustify-auth")).match("http://localhost/__hf_token__");
    assert.equal(await stored.text(), "hf_abc123");
    await clearToken();
    assert.equal(await getToken(), "");
  });
});

test("fetchRemoteLibrary classifies responses", async () => {
  const restoreWarn = quietWarnings();
  try {
    const storage = new MemoryCacheStorage();
    let respond = () => new Response(JSON.stringify(makeLibrary()), { status: 200 });
    const requests = [];
    await withGlobals({
      caches: storage,
      localStorage: memoryLocalStorage(),
      fetch: async (input, init) => {
        requests.push({ input, init });
        return respond(input, init);
      }
    }, async () => {
      assert.deepEqual(await fetchRemoteLibrary(), { library: null, status: "unauthorized", httpStatus: 0 });
      assert.equal(requests.length, 0, "no token, no request");
      await setToken("hf_abc");
      const ok = await fetchRemoteLibrary();
      assert.equal(ok.status, "ok");
      assert.equal(ok.library.revision, HEAD);
      assert.equal(new Headers(requests.at(-1).init.headers).get("authorization"), "Bearer hf_abc");
      assert.equal(requests.at(-1).init.cache, "no-store");
      respond = () => new Response("nope", { status: 401 });
      assert.equal((await fetchRemoteLibrary()).status, "unauthorized");
      respond = () => new Response("nope", { status: 404, headers: { "X-Error-Code": "RepoNotFound" } });
      assert.equal((await fetchRemoteLibrary()).status, "unauthorized");
      respond = () => new Response("nope", { status: 404, headers: { "X-Error-Code": "EntryNotFound" } });
      assert.deepEqual(await fetchRemoteLibrary(), { library: null, status: "error", httpStatus: 404 });
      respond = () => new Response(JSON.stringify({ schema: 2, sources: [] }), { status: 200 });
      assert.equal((await fetchRemoteLibrary()).status, "error");
      respond = () => {
        throw new TypeError("Failed to fetch");
      };
      assert.equal((await fetchRemoteLibrary()).status, "offline");
    });
  } finally {
    restoreWarn();
  }
});

test("LibrarySync starts from the bundled copy and adopts a newer remote library", async () => {
  const restoreWarn = quietWarnings();
  try {
    const bundled = makeLibrary({ generated: "2026-09-20T00:00:00Z" });
    bundled.sources = bundled.sources.slice(0, 3);
    const remote = makeLibrary({ revision: "3333333333333333333333333333333333333333", generated: "2026-09-24T22:40:00Z" });
    const storage = new MemoryCacheStorage();
    await withGlobals({
      caches: storage,
      localStorage: memoryLocalStorage(),
      fetch: async (input) => {
        const url = String(input);
        if (url === "./data/library.json") return new Response(JSON.stringify(bundled), { status: 200 });
        if (url === LIBRARY_URL) return new Response(JSON.stringify(remote), { status: 200 });
        throw new TypeError("unexpected");
      }
    }, async () => {
      await setToken("hf_abc");
      const sync = new LibrarySync({ intervalMs: 0 });
      const events = [];
      sync.addEventListener("library", (event) => events.push(event.detail));
      const statuses = [];
      sync.addEventListener("status", (event) => statuses.push(event.detail.state));
      const started = await sync.start();
      assert.equal(started.origin, "bundled");
      assert.equal(started.library.sources.length, 3);
      assert.equal(sync.status.hasToken, true);
      const result = await new Promise((resolve) => {
        sync.addEventListener("status", (event) => {
          if (event.detail.state === "ok") resolve(event.detail);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(result.revision, remote.revision);
      assert.equal(result.origin, "network");
      assert.ok(result.lastSyncedAt > 0);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].diff.added, ["the-lumineers-tiny-desk"]);
      assert.equal(events[0].origin, "network");
      assert.equal(sync.library.revision, remote.revision);
      assert.ok(statuses.includes("syncing"));
      // The adopted remote library is the next launch's cached copy.
      const relaunch = new LibrarySync({ intervalMs: 0 });
      const again = await relaunch.start();
      relaunch.stop();
      assert.equal(again.origin, "cache");
      assert.equal(again.library.revision, remote.revision);
      // Same revision and generated: unchanged, no event.
      assert.equal(await sync.refresh({ force: true }), "unchanged");
      assert.equal(events.length, 1);
      // Within the minimum gap a non-forced refresh does not hit the network.
      assert.equal(await sync.refresh(), "unchanged");
      await clearToken();
      assert.equal(await sync.refresh({ force: true }), "unauthorized");
      assert.equal(sync.status.state, "unauthorized");
      assert.equal(sync.status.hasToken, false);
      sync.stop();
    });
  } finally {
    restoreWarn();
  }
});

test("OfflineStore downloads with the token, reports progress and prunes", async () => {
  const restoreWarn = quietWarnings();
  try {
    const catalog = libraryToCatalog(makeLibrary());
    const source = { ...catalog.sources[1], bytes: 5000 };
    const storage = new MemoryCacheStorage();
    const seenAuth = [];
    let status = 200;
    await withGlobals({
      caches: storage,
      localStorage: memoryLocalStorage(),
      fetch: async (input, init) => {
        seenAuth.push(new Headers(init?.headers).get("authorization"));
        if (status !== 200) return new Response("no", { status });
        const chunks = [new Uint8Array(2000), new Uint8Array(3000)];
        return new Response(new ReadableStream({
          pull(controller) {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          }
        }), { status: 200, headers: { "Content-Length": "5000" } });
      }
    }, async () => {
      await setToken("hf_dl");
      const store = new OfflineStore();
      await store.init();
      const states = [];
      store.addEventListener("change", (event) => states.push([event.detail.state, event.detail.sourceId]));
      assert.equal(store.isDownloaded(source.audioUrl), false);
      assert.equal(await store.download(source), true);
      assert.equal(seenAuth.at(-1), "Bearer hf_dl");
      assert.equal(store.isDownloaded(source.audioUrl), true);
      assert.equal(store.stateOf(source.audioUrl), "done");
      assert.deepEqual(states.at(0), ["downloading", source.id]);
      assert.deepEqual(states.at(-1), ["done", source.id]);
      const cached = await (await storage.open("acoustify-audio-v1")).match(source.audioUrl);
      assert.equal(cached.headers.get("content-type"), "audio/mp4");
      assert.equal(cached.headers.get("accept-ranges"), "bytes");
      assert.equal(cached.headers.get("content-length"), "5000");
      assert.deepEqual(await store.usage(), { count: 1, bytes: 5000 });

      // A fresh store finds existing downloads and their sources.
      const reopened = new OfflineStore();
      await reopened.init();
      assert.equal(reopened.isDownloaded(source.audioUrl), true);

      // Size mismatch against the library is an error, not a silent partial file.
      const short = { ...catalog.sources[0], bytes: 9999 };
      assert.equal(await store.download(short), false);
      assert.deepEqual(states.at(-1), ["error", short.id]);
      assert.equal(store.isDownloaded(short.audioUrl), false);

      // Auth failures stop a batch instead of failing every song.
      status = 401;
      const before = seenAuth.length;
      const batch = await store.downloadMany([catalog.sources[0], catalog.sources[2], catalog.sources[3]]);
      assert.equal(batch.reason, "auth");
      assert.equal(batch.completed, 0);
      assert.equal(seenAuth.length - before, 1);
      assert.equal(store.stateOf(catalog.sources[2].audioUrl), "none");

      assert.deepEqual(await store.prune([catalog.sources[0].audioUrl]), [source.audioUrl]);
      assert.equal(store.isDownloaded(source.audioUrl), false);
      assert.deepEqual(await store.usage(), { count: 0, bytes: 0 });
    });
  } finally {
    restoreWarn();
  }
});

test("sw.js treats every pre-v3 release (acoustify-shell-v<semver>) as the legacy app", async () => {
  const ok = async (input) => new Response(`file ${typeof input === "string" ? input : input.url}`, { status: 200 });
  for (const legacyName of ["acoustify-shell-v2.0.1", "acoustify-shell-v1.3.0", "acoustify-shell-v2.1.0"]) {
    const worker = loadServiceWorker({ cacheNames: [legacyName, "shell-test"], fetchImpl: ok });
    await worker.dispatch("install", {});
    assert.equal(worker.calls.skipWaiting, 1, `${legacyName}: no waiting behind an app with no update UI`);
    await worker.dispatch("activate", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await worker.caches.keys(), ["shell-test", "acoustify-shell-dev"], legacyName);
    assert.equal(worker.calls.navigated.length, 2, `${legacyName}: its windows reload into this release`);
  }
  // Stamped releases (a commit SHA) and other apps' caches are not the legacy app.
  for (const name of ["acoustify-shell-1a2b3c4", "shell-v2.0.1", "acoustify-shell-v2.0.1-beta"]) {
    const worker = loadServiceWorker({ cacheNames: [name], fetchImpl: ok });
    await worker.dispatch("install", {});
    assert.equal(worker.calls.skipWaiting, 0, name);
    await worker.dispatch("activate", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(worker.calls.navigated, [], name);
  }
});

test("sw.js install fails unless every script and stylesheet is precached", async () => {
  const failing = (suffix) => async (input) => new Response("x", { status: String(input.url || input).endsWith(suffix) ? 404 : 200 });
  for (const critical of ["index.html", "assets/js/app.js", "assets/js/views/edit.js", "assets/js/ui.js", "assets/css/app.css"]) {
    await assert.rejects(loadServiceWorker({ fetchImpl: failing(critical) }).dispatch("install", {}), /precache failed/, critical);
  }
  for (const optional of ["manifest.webmanifest", "data/library.json", "assets/icons/icon-192.png"]) {
    await loadServiceWorker({ fetchImpl: failing(optional) }).dispatch("install", {});
  }
});

test("describeTokenAccess tells a read-only library token from account-wide and write tokens", () => {
  const who = (accessToken) => ({ name: "arjun10g", auth: { type: "access_token", accessToken } });
  const library = { type: "dataset", name: "arjun10g/acoustify-library" };
  const fine = (permissions, entity = library, global = []) =>
    who({ role: "fineGrained", fineGrained: { global, scoped: [{ entity, permissions }] } });
  assert.deepEqual(describeTokenAccess(who({ role: "write" })), { role: "write", canWrite: true, onlyThisLibrary: false });
  assert.deepEqual(describeTokenAccess(who({ role: "read" })), { role: "read", canWrite: false, onlyThisLibrary: false });
  assert.deepEqual(describeTokenAccess(fine(["repo.content.read"])), { role: "fineGrained", canWrite: false, onlyThisLibrary: true });
  assert.equal(describeTokenAccess(fine(["repo.content.read", "repo.write"])).canWrite, true);
  assert.equal(describeTokenAccess(fine(["repo.content.read"], library, ["inference.serverless.write"])).canWrite, true, "paid inference is a write");
  assert.equal(describeTokenAccess(fine(["repo.content.read"], { type: "user", name: "arjun10g" })).onlyThisLibrary, false, "every repo of the account");
  assert.equal(describeTokenAccess(fine(["repo.content.read"], { type: "dataset", name: "arjun10g/other" })).onlyThisLibrary, false);
  assert.equal(describeTokenAccess(fine(["repo.content.read"], library, ["repo.content.read"])).onlyThisLibrary, false);
  assert.deepEqual(describeTokenAccess(who({ role: "fineGrained" })), { role: "fineGrained", canWrite: false, onlyThisLibrary: false });
  assert.deepEqual(describeTokenAccess(null), { role: "unknown", canWrite: false, onlyThisLibrary: false });
  assert.deepEqual(describeTokenAccess({ name: "x", auth: { accessToken: { role: "admin" } } }), { role: "unknown", canWrite: false, onlyThisLibrary: false });
});

test("verifyToken and tokenAccess report what a token can do", async () => {
  const whoami = { name: "arjun10g", auth: { accessToken: { role: "write" } } };
  let whoamiUp = true;
  const requests = [];
  await withGlobals({
    caches: new MemoryCacheStorage(),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "https://huggingface.co/api/whoami-v2") {
        if (!whoamiUp) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(whoami), { status: 200 });
      }
      if (url === LIBRARY_URL) return new Response("{}", { status: 200 });
      throw new TypeError("unexpected");
    }
  }, async () => {
    const check = await verifyToken("hf_abcdefgh");
    assert.equal(check.ok, true);
    assert.equal(check.user, "arjun10g");
    assert.deepEqual(check.access, { role: "write", canWrite: true, onlyThisLibrary: false });
    assert.ok(requests.every((request) => request.auth === "Bearer hf_abcdefgh"));
    // The stored token by default; nothing stored, nothing asked.
    assert.equal(await tokenAccess(), null);
    await setToken("hf_stored1");
    assert.deepEqual(await tokenAccess(), { role: "write", canWrite: true, onlyThisLibrary: false });
    assert.equal(requests.at(-1).auth, "Bearer hf_stored1");
    // whoami unreachable: the key still verifies, its access is simply unknown.
    whoamiUp = false;
    const offline = await verifyToken("hf_abcdefgh");
    assert.equal(offline.ok, true);
    assert.equal(offline.access, null);
    assert.equal(offline.user, undefined);
    assert.equal(await tokenAccess(), null);
  });
});

test("LibrarySync: connecting or disconnecting mid-sync settles on the new token", async () => {
  const restoreWarn = quietWarnings();
  try {
    const library = makeLibrary();
    const held = new Set();
    const releases = [];
    const seen = [];
    await withGlobals({
      caches: new MemoryCacheStorage(),
      localStorage: memoryLocalStorage(),
      fetch: async (input, init) => {
        if (String(input) === "./data/library.json") return new Response("none", { status: 404 });
        const auth = new Headers(init?.headers).get("authorization");
        seen.push(auth);
        if (held.has(auth)) {
          // A slow link: the request stays open until released or aborted.
          await new Promise((resolve, reject) => {
            releases.push(resolve);
            init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          });
        }
        if (auth === "Bearer hf_expired") return new Response("expired", { status: 401 });
        return new Response(JSON.stringify(library), { status: 200 });
      }
    }, async () => {
      // (A) An automatic sync with an expired key is out when a valid key is connected.
      held.add("Bearer hf_expired");
      await setToken("hf_expired");
      const sync = new LibrarySync({ intervalMs: 0, warmArtwork: false });
      const states = [];
      sync.addEventListener("status", (event) => states.push(event.detail.state));
      await sync.start();
      await waitUntil(() => seen.length === 1, { label: "catch-up sync in flight" });
      const automatic = sync.refresh({ force: true });
      await setToken("hf_valid");
      assert.equal(await sync.refresh({ force: true }), "updated");
      assert.equal(await automatic, "updated", "the automatic sync's callers get the new key's answer too");
      assert.equal(sync.status.state, "ok");
      assert.equal(sync.status.hasToken, true);
      assert.deepEqual(seen, ["Bearer hf_expired", "Bearer hf_valid"]);
      assert.ok(!states.includes("unauthorized") && !states.includes("offline"), `no stale state flashed: ${states.join(",")}`);

      // (B) Disconnecting while a sync with a working key is out.
      held.add("Bearer hf_valid");
      const running = sync.refresh({ force: true });
      await waitUntil(() => releases.length === 2, { label: "second sync in flight" });
      await clearToken();
      assert.equal(await sync.refresh({ force: true }), "unauthorized");
      assert.equal(await running, "unauthorized");
      assert.equal(sync.status.state, "unauthorized");
      assert.equal(sync.status.hasToken, false);

      // (C) A sync that finished just before the key changed is not handed out as the answer.
      held.clear();
      await setToken("hf_expired");
      assert.equal(await sync.refresh({ force: true }), "unauthorized");
      const finishing = sync.refresh({ force: true });
      await setToken("hf_valid");
      await finishing;
      assert.equal(await sync.refresh({ force: true }), "unchanged");
      assert.equal(sync.status.state, "ok");
      sync.stop();
    });
  } finally {
    restoreWarn();
  }
});

test("LibrarySync: the account's library replaces a bundled copy even when the bundle is newer", async () => {
  const restoreWarn = quietWarnings();
  try {
    // e.g. a dry-run publish rewrote data/library.json with an album that was never uploaded.
    const bundled = makeLibrary({ revision: "4444444444444444444444444444444444444444", generated: "2026-09-25T04:40:00Z" });
    bundled.sources.push(librarySource({
      id: "phantom-album",
      title: "Never published",
      artist: "Nobody",
      duration: 10,
      audio: { path: "media/phantom.m4a", rev: "main" },
      tracks: [{ id: "a", title: "A", start: 0, end: 10 }]
    }));
    let remote = makeLibrary({ generated: "2026-09-25T04:09:00Z" });
    await withGlobals({
      caches: new MemoryCacheStorage(),
      localStorage: memoryLocalStorage(),
      fetch: async (input) => {
        const url = String(input);
        if (url === "./data/library.json") return new Response(JSON.stringify(bundled), { status: 200 });
        if (url === LIBRARY_URL) return new Response(JSON.stringify(remote), { status: 200 });
        throw new TypeError("unexpected");
      }
    }, async () => {
      await setToken("hf_abc");
      const sync = new LibrarySync({ intervalMs: 0, warmArtwork: false });
      const events = [];
      sync.addEventListener("library", (event) => events.push(event.detail));
      assert.equal((await sync.start()).origin, "bundled");
      await waitUntil(() => sync.status.state === "ok", { label: "first sync" });
      assert.equal(events.length, 1);
      assert.equal(events[0].origin, "network");
      assert.deepEqual(events[0].diff.removed, ["phantom-album"]);
      assert.equal(sync.library.revision, HEAD);
      // Once synced, an older answer (a stale CDN copy) never rolls the library back.
      remote = makeLibrary({ revision: "5555555555555555555555555555555555555555", generated: "2026-09-24T00:00:00Z" });
      assert.equal(await sync.refresh({ force: true }), "unchanged");
      assert.equal(sync.library.revision, HEAD);
      sync.stop();
    });
  } finally {
    restoreWarn();
  }
});

test("warmArtworkCache fills the artwork cache with library covers only; LibrarySync runs it after a sync", async () => {
  const restoreWarn = quietWarnings();
  try {
    const library = makeLibrary();
    const covers = libraryToCatalog(library).sources.map((source) => source.artwork).filter(Boolean);
    assert.equal(covers.length, 3);
    const storage = new MemoryCacheStorage();
    const requests = [];
    let coverStatus = 200;
    await withGlobals({
      caches: storage,
      localStorage: memoryLocalStorage(),
      fetch: async (input, init) => {
        const url = String(input);
        if (url === "./data/library.json") return new Response("none", { status: 404 });
        if (url === LIBRARY_URL) return new Response(JSON.stringify(library), { status: 200 });
        requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: coverStatus, headers: { "Content-Type": "image/jpeg" } });
      }
    }, async () => {
      const art = await storage.open("acoustify-art-v1");
      assert.deepEqual(await warmArtworkCache(covers), { fetched: 0, skipped: 0, failed: 0 }, "no token, nothing to do");
      assert.equal(requests.length, 0);

      await setToken("hf_art");
      await art.put(covers[0], new Response("cached"));
      const urls = [...covers, covers[1], null, "https://evil.example/pixel.jpg", "https://i.ytimg.com/vi/x/hqdefault.jpg"];
      assert.deepEqual(await warmArtworkCache(urls), { fetched: 2, skipped: 1, failed: 0 });
      assert.deepEqual(requests.map((request) => request.url), covers.slice(1));
      assert.ok(requests.every((request) => request.auth === "Bearer hf_art"));
      for (const cover of covers) assert.ok(await art.match(cover), cover);

      // A refused key stops the pass instead of asking for every cover.
      for (const cover of covers) await art.delete(cover);
      coverStatus = 401;
      requests.length = 0;
      assert.equal((await warmArtworkCache(covers, { concurrency: 1 })).failed, 1);
      assert.equal(requests.length, 1);

      // After a successful sync the library's covers are fetched in the background.
      coverStatus = 200;
      requests.length = 0;
      const sync = new LibrarySync({ intervalMs: 0, warmDelayMs: 0 });
      await sync.start();
      await waitUntil(async () => (await art.keys()).length === covers.length, { label: "covers warmed" });
      assert.equal(requests.length, covers.length);
      // Same library again: nothing is fetched twice.
      assert.equal(await sync.refresh({ force: true }), "unchanged");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(requests.length, covers.length);
      sync.stop();
    });
  } finally {
    restoreWarn();
  }
});

test("OfflineStore only downloads library audio, so the token never leaves the library", async () => {
  const restoreWarn = quietWarnings();
  try {
    const requests = [];
    await withGlobals({
      caches: new MemoryCacheStorage(),
      localStorage: memoryLocalStorage(),
      fetch: async (input, init) => {
        requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return new Response("x", { status: 200 });
      }
    }, async () => {
      await setToken("hf_secret");
      const store = new OfflineStore();
      await store.init();
      const evil = { id: "evil", audioUrl: "https://evil.example/steal.m4a" };
      const lookalike = { id: "lookalike", audioUrl: "https://huggingface.co/datasets/arjun10g/acoustify-library-evil/resolve/main/media/x.m4a" };
      assert.equal(await store.download(evil), false);
      assert.equal(await store.download(lookalike), false);
      assert.deepEqual(await store.downloadMany([evil, lookalike]), { completed: 0, failed: 0, cancelled: false, reason: "" });
      assert.equal(store.stateOf(evil.audioUrl), "none");
      assert.deepEqual(requests, []);
      // Streaming without a service worker never sends the token elsewhere either.
      assert.equal(await ensureStreamable(evil.audioUrl), evil.audioUrl);
      assert.deepEqual(requests, []);
    });
  } finally {
    restoreWarn();
  }
});

test("OfflineStore: Cancel or Remove during the final write leaves nothing behind", async () => {
  const restoreWarn = quietWarnings();
  try {
    const catalog = libraryToCatalog(makeLibrary());
    const source = { ...catalog.sources[1], bytes: 5 };
    // Cache Storage writes cannot be interrupted; hold them open to land a tap mid-write.
    class SlowCache extends MemoryCache {
      writes = [];
      async put(request, response) {
        await new Promise((resolve) => this.writes.push(resolve));
        return super.put(request, response);
      }
    }
    const storage = new MemoryCacheStorage();
    const audioCache = new SlowCache();
    storage.stores.set("acoustify-audio-v1", audioCache);
    await withGlobals({
      caches: storage,
      localStorage: memoryLocalStorage(),
      fetch: async () => new Response(new Uint8Array(5), { status: 200 })
    }, async () => {
      await setToken("hf_dl");
      const store = new OfflineStore();
      await store.init();
      const states = [];
      store.addEventListener("change", (event) => states.push(event.detail.state));
      assert.equal(store.busy, false);

      for (const tap of [(url) => store.cancel(url), (url) => store.remove(url)]) {
        states.length = 0;
        const downloading = store.download(source);
        await waitUntil(() => audioCache.writes.length === 1, { label: "write started" });
        assert.equal(store.busy, true);
        const tapped = tap(source.audioUrl);
        audioCache.writes.shift()();
        assert.equal(await downloading, false);
        await tapped;
        assert.equal(store.isDownloaded(source.audioUrl), false);
        assert.equal(store.stateOf(source.audioUrl), "none");
        assert.equal(await audioCache.match(source.audioUrl), undefined, "no file left in storage");
        assert.ok(!states.includes("done"), `never reported as downloaded: ${states.join(",")}`);
        assert.equal(store.busy, false);
      }

      // Nothing tapped: the write lands as before.
      const done = store.download(source);
      await waitUntil(() => audioCache.writes.length === 1, { label: "write started" });
      audioCache.writes.shift()();
      assert.equal(await done, true);
      assert.equal(store.isDownloaded(source.audioUrl), true);
    });
  } finally {
    restoreWarn();
  }
});

test("a download or stream that stops delivering bytes fails instead of hanging", async () => {
  const restoreWarn = quietWarnings();
  const realSetTimeout = globalThis.setTimeout;
  try {
    const catalog = libraryToCatalog(makeLibrary());
    const source = catalog.sources[1];
    await withGlobals({
      caches: new MemoryCacheStorage(),
      localStorage: memoryLocalStorage(),
      // Every delay is capped so the 20 s stall window passes in a moment.
      setTimeout: (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 25), ...args),
      fetch: async (input, init) => new Response(new ReadableStream({
        start(controller) {
          // One chunk, then silence: the connection died without closing.
          controller.enqueue(new Uint8Array(100));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
        }
      }), { status: 200 })
    }, async () => {
      await setToken("hf_slow");
      const store = new OfflineStore();
      await store.init();
      const errors = [];
      store.addEventListener("change", (event) => {
        if (event.detail.state === "error") errors.push(event.detail);
      });
      assert.equal(await store.download(source), false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].reason, "offline", "a batch stops instead of stalling on every album");
      assert.match(errors[0].error, /connection dropped/);
      assert.equal(store.busy, false);

      await assert.rejects(ensureStreamable(source.audioUrl), (error) => error.kind === "network" && /Check your connection/.test(error.message));
    });
  } finally {
    restoreWarn();
  }
});
