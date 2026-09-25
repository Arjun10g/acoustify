// Catalog data tests (schema v5). Run: node tests/catalog.test.mjs
// Library-file checks run only when the local library/ staging folder exists (never in CI).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIsoDate, mp4Duration, nameKey, validateCatalog } from "../tools/validate-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data", "catalog.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "data", "catalog.schema.json"), "utf8"));
const libraryRoot = path.join(root, "library");
const sources = catalog.sources;
const byId = new Map(sources.map((source) => [source.id, source]));
const byYoutubeId = new Map(sources.filter((source) => source.youtubeId).map((source) => [source.youtubeId, source]));

// Ids are the keys for likes, playlists and history on every device, so they must never change.
const ORIGINAL_IDS = [
  "of-monsters-and-men-live-from-skarkali",
  "of-monsters-and-men-the-cabin-sessions",
  "lord-huron-the-night-we-met-live-at-austin-city-limits-radio",
  "chance-pena-sleep-deprivation-live-at-austin-city-limits-radio",
  "caamp-tiny-desk-concert",
  "the-red-clay-strays-tiny-desk-concert",
  "kodaline-brother-acoustic-from-the-streets-of-warsaw",
  "kodaline-all-i-want-official-live-video",
  "the-red-clay-strays-wondering-why-live-at-austin-city-limits-radio",
  "the-white-buffalo-oh-darlin-what-have-i-done-audiotree-live",
  "houndmouth-sedona-live-at-austin-city-limits-radio",
  "mumford-sons-the-cave-live-on-the-current",
  "walk-the-moon-shut-up-and-dance-acoustic-on-the-current",
  "tyler-childers-feathered-indians-live-at-the-current",
  "foster-the-people-pumped-up-kicks-acoustic-on-the-current",
  "rayland-baxter-yellow-eyes-live-at-paste-studios",
  "hollow-coves-audiotree-live",
  "chance-pena-i-am-not-who-i-was-live-at-pnc-studio",
  "chance-pena-live-at-darien-lake",
  "tyler-childers-all-your-n-live-at-red-rocks",
  "tyler-childers-and-the-food-stamps-messed-up-kid-somersessions",
  "tyler-childers-jersey-giant"
];
// Sources added by the v5 build. "I'm Still Fine (Live at the Ryman)" (9r78xTZ7q08) was one of them until
// the full Live at the Ryman album replaced it (it is that album's third song).
const NEW_YOUTUBE_IDS = [
  "wZL7rPowq2w", "NmPbgBy9d1A", "1O31IIprXWM",
  "_lsran_Slzc", "YI6zVQ7gCtQ", "YvKZw4a2hUI", "y9x0Myp9sBE", "kp_T3ljeHkQ", "1Lwzn5nLRPw",
  "2slZN8YFsPg", "tiwJadn-Nso", "orDpIGFqg8U", "LqidfoTbHts", "6xcqb_ituUQ"
];
const OFFICIAL_SESSIONS = {
  "the-red-clay-strays-live-af-laramie-2023": {
    youtubeId: "wZL7rPowq2w",
    duration: 887.49,
    chapters: [[0, "Stone's Throw"], [205, "Killers"], [435, "Wondering Why"], [669, "Don't Care"]]
  },
  "the-red-clay-strays-live-af-mobile-2024": {
    youtubeId: "NmPbgBy9d1A",
    duration: 1168.47,
    chapters: [[33, "Wanna Be Loved"], [253, "Devil in My Ear"], [498, "No One Else Like Me"], [814, "Drowning"]]
  }
};

// The Red Clay Strays' Live at the Ryman: the official 11-song playlist plus "Till Things Get Right",
// joined into one file. Each start is the exact sum of the uploads before it.
const RYMAN = {
  id: "the-red-clay-strays-live-at-the-ryman",
  playlist: "PLDtVvFL-MTp4S1vFu91Yd9XKWNyOwDY3R",
  duration: 3045.9,
  songs: [
    [0, "Wanna Be Loved", "qyA6gOeRIyQ"], [254.77, "Wondering Why", "zWcVL9j3lRk"],
    [488.9, "I'm Still Fine", "9r78xTZ7q08"], [764.19, "Will The Lord Remember Me", "w7jdhDkP9jA"],
    [977.7, "Stone's Throw", "fp66L0_utvM"], [1174.12, "No One Else Like Me", "JEyrCtEKKvI"],
    [1565.74, "Ramblin'", "E7zMSVvk4BI"], [1725.57, "Drowning", "EkSHng7ksTk"],
    [2022.04, "Disaster", "v8dLq6Dw-_c"], [2284.61, "Don't Care", "NPuqJmp46aY"],
    [2523.22, "Ghosts", "1TBVfa1XQgs"], [2811.47, "Till Things Get Right", "U2BxSUl2wsU"]
  ]
};
const REMOVED_IDS = ["the-red-clay-strays-im-still-fine-live-at-the-ryman"];

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, error: null });
  } catch (error) {
    results.push({ name, error });
  }
}

const clone = (value) => structuredClone(value);
const allArtistNames = () => sources.flatMap((source) => [...source.artists, ...source.tracks.flatMap((track) => track.artists || [])]);
const decimals = (value) => (String(value).split(".")[1] || "").length;

function errorsFor(mutate) {
  const copy = clone(catalog);
  mutate(copy);
  return validateCatalog(copy).errors;
}

function assertRejects(mutate, pattern, message) {
  const errors = errorsFor(mutate);
  assert.ok(errors.some((error) => pattern.test(error)), `${message}: expected an error matching ${pattern}, got ${JSON.stringify(errors)}`);
}

test("catalog header is schema version 5", () => {
  assert.equal(catalog.version, 5);
  assert.ok(isIsoDate(catalog.generatedAt), "generatedAt is a real YYYY-MM-DD date");
  assert.ok(catalog.generatedAt >= "2026-09-24");
  assert.equal(schema.properties.version.const, 5);
});

test("catalog has the 22 original sources, the 14 v5 additions and the Ryman album", () => {
  assert.ok(sources.length >= 37, `expected at least 37 sources, found ${sources.length}`);
  for (const id of ORIGINAL_IDS) assert.ok(byId.has(id), `original source ${id} still exists with the same id`);
  for (const youtubeId of NEW_YOUTUBE_IDS) assert.ok(byYoutubeId.has(youtubeId), `new source ${youtubeId} is present`);
  assert.equal(new Set([...ORIGINAL_IDS.map((id) => byId.get(id).youtubeId), ...NEW_YOUTUBE_IDS]).size, 36);
  assert.ok(byId.has(RYMAN.id), "the Live at the Ryman album is present");
  for (const id of REMOVED_IDS) assert.ok(!byId.has(id), `${id} was replaced by the album`);
  assert.deepEqual(sources.slice(0, ORIGINAL_IDS.length).map((source) => source.id), ORIGINAL_IDS, "original catalog order is kept");
});

test("validator accepts the catalog", () => {
  const { errors, stats } = validateCatalog(catalog);
  assert.deepEqual(errors, []);
  assert.equal(stats.sources, sources.length);
  assert.equal(stats.tracks, sources.reduce((sum, source) => sum + source.tracks.length, 0));
});

test("every source follows the v5 field contract", () => {
  const allowed = new Set(Object.keys(schema.$defs.source.properties));
  for (const source of sources) {
    const label = source.id;
    for (const key of Object.keys(source)) assert.ok(allowed.has(key), `${label}: field ${key} is in the schema`);
    for (const key of schema.$defs.source.required) assert.ok(key in source, `${label}: required field ${key}`);
    assert.equal(source.provider, "local", label);
    if ("youtubeId" in source) {
      assert.match(source.youtubeId, /^[\w-]{11}$/, label);
      assert.equal(source.audio, `media/${source.youtubeId}.m4a`, label);
      assert.equal(source.artwork, `artwork/${source.youtubeId}.jpg`, label);
    } else {
      // An album joined from a playlist: readable file names, one video per song.
      assert.match(source.youtubePlaylistId, /^[\w-]{12,64}$/, `${label}: youtubePlaylistId when there is no youtubeId`);
      assert.match(source.audio, /^media\/[a-z0-9]+(?:-[a-z0-9]+)*\.m4a$/, label);
      assert.equal(source.artwork, source.audio.replace(/^media\/(.*)\.m4a$/, "artwork/$1.jpg"), `${label}: artwork named like the audio`);
      assert.ok(source.tracks.every((track) => /^[\w-]{11}$/.test(track.youtubeId)), `${label}: every song names its video`);
    }
    assert.ok(!("audioUrl" in source) && !("fallbackArtwork" in source), `${label}: legacy playback fields removed`);
    assert.ok(isIsoDate(source.added), `${label}: added is a date`);
    assert.ok(source.added <= catalog.generatedAt, `${label}: added is not in the future`);
    assert.ok(Array.isArray(source.artists) && source.artists.length > 0, `${label}: artists is non-empty`);
    assert.ok(source.artists.every((name) => typeof name === "string" && name.trim() === name && name.length > 0), `${label}: artist names are trimmed`);
    assert.ok(source.duration > 0 && decimals(source.duration) <= 2, `${label}: duration is positive with at most 2 decimals`);
    if ("series" in source) assert.ok(typeof source.series === "string" && source.series.trim().length > 0, `${label}: series is text`);
    if ("year" in source) assert.ok(Number.isInteger(source.year) && source.year >= 1900, `${label}: year`);
    assert.ok(typeof source.description === "string" && source.description.length > 0, `${label}: has a description`);
  }
});

test("track timings are contiguous and end exactly at the source duration", () => {
  for (const source of sources) {
    const ids = new Set();
    source.tracks.forEach((track, index) => {
      const label = `${source.id}::${track.id}`;
      assert.ok(!ids.has(track.id), `${label}: unique track id`);
      ids.add(track.id);
      assert.match(track.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, label);
      assert.ok(track.title.trim().length > 0, label);
      assert.ok(track.start >= 0 && track.end > track.start, `${label}: ${track.start}–${track.end}`);
      if (index > 0) assert.ok(Math.abs(track.start - source.tracks[index - 1].end) <= 0.01, `${label}: starts where the previous track ends`);
      assert.ok(track.end <= source.duration + 0.01, `${label}: ends within the recording`);
    });
    assert.ok(Math.abs(source.tracks.at(-1).end - source.duration) <= 0.01, `${source.id}: last track ends at the duration`);
  }
});

test("existing track timings and titles survived the migration", () => {
  const caamp = byId.get("caamp-tiny-desk-concert");
  assert.deepEqual(caamp.tracks.map((track) => [track.id, track.start, track.end]), [
    ["by-and-by", 12, 312], ["millions", 312, 692], ["so-cool", 692, 958], ["all-the-debts-i-owe", 958, 1172]
  ]);
  assert.equal(byId.get("houndmouth-sedona-live-at-austin-city-limits-radio").tracks[0].start, 207);
  assert.equal(byId.get("of-monsters-and-men-the-cabin-sessions").tracks.length, 14);
  assert.equal(byId.get("chance-pena-live-at-darien-lake").tracks.length, 11);
  assert.equal(byId.get("the-red-clay-strays-tiny-desk-concert").tracks[2].id, "i-m-still-fine");
  const originalTracks = ORIGINAL_IDS.reduce((sum, id) => sum + byId.get(id).tracks.length, 0);
  assert.equal(originalTracks, 62);
});

test("artist names are canonical and spelled one way everywhere", () => {
  const spellings = new Map();
  for (const name of allArtistNames()) {
    const key = nameKey(name);
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key).add(name);
  }
  for (const names of spellings.values()) assert.equal(names.size, 1, `one spelling for ${[...names].join(" / ")}`);
  assert.deepEqual([...spellings.get(nameKey("Red Clay Strays"))], ["The Red Clay Strays"]);
  assert.deepEqual([...spellings.get(nameKey("tyler childers"))], ["Tyler Childers"]);

  const foodStamps = byId.get("tyler-childers-and-the-food-stamps-messed-up-kid-somersessions");
  assert.equal(foodStamps.artist, "Tyler Childers and the Food Stamps", "display credit unchanged");
  assert.deepEqual(foodStamps.artists, ["Tyler Childers"]);
  assert.ok(!allArtistNames().includes("Tyler Childers and the Food Stamps"), "backing-band credit is not an artist entity");

  // The display credit should always name the primary canonical artist.
  for (const source of sources) {
    assert.ok(nameKey(source.artist).includes(nameKey(source.artists[0])), `${source.id}: "${source.artist}" credits ${source.artists[0]}`);
  }
});

test("artist and series indexes have the expected members", () => {
  const sourceCount = (name) => sources.filter((source) => source.artists.includes(name)).length;
  assert.ok(sourceCount("The Red Clay Strays") >= 6);
  assert.ok(sourceCount("Tyler Childers") >= 15);
  assert.ok(sourceCount("Chance Peña") >= 3);
  assert.ok(sourceCount("Chris Stapleton") >= 1);
  const seriesCount = (name) => sources.filter((source) => source.series === name).length;
  for (const [name, minimum] of [
    ["Austin City Limits Radio", 4], ["The Current", 4], ["Red Barn Radio", 4], ["Western AF", 3],
    ["NPR Tiny Desk", 2], ["Audiotree Live", 2], ["Paste Studios", 1], ["PNC Live Studio", 1], ["SomerSessions", 1],
    ["Ryman Auditorium", 1]
  ]) assert.ok(seriesCount(name) >= minimum, `${name} has at least ${minimum} sources`);
  const seriesKeys = new Map();
  for (const source of sources.filter((item) => item.series)) {
    const key = nameKey(source.series);
    if (!seriesKeys.has(key)) seriesKeys.set(key, new Set());
    seriesKeys.get(key).add(source.series);
  }
  for (const names of seriesKeys.values()) assert.equal(names.size, 1, `one spelling for series ${[...names].join(" / ")}`);
});

test("new Live AF sessions use the official chapter starts", () => {
  for (const [id, expected] of Object.entries(OFFICIAL_SESSIONS)) {
    const source = byId.get(id);
    assert.ok(source, `${id} exists`);
    assert.equal(source.youtubeId, expected.youtubeId);
    assert.equal(source.artist, "The Red Clay Strays");
    assert.deepEqual(source.artists, ["The Red Clay Strays"]);
    assert.equal(source.series, "Western AF");
    assert.equal(source.timingStatus, "official-chapters");
    assert.equal(source.duration, expected.duration);
    assert.deepEqual(source.tracks.map((track) => [track.start, track.title]), expected.chapters);
    assert.equal(source.tracks.at(-1).end, expected.duration);
    assert.ok(source.tracks.every((track) => track.timingConfidence === "official"));
  }
});

test("new singles are full-length single tracks added on 2026-09-24", () => {
  for (const youtubeId of NEW_YOUTUBE_IDS) {
    const source = byYoutubeId.get(youtubeId);
    assert.equal(source.added, "2026-09-24", `${source.id}: added date`);
    if (source.timingStatus === "official-chapters") continue;
    assert.equal(source.timingStatus, "single-track", source.id);
    assert.equal(source.tracks.length, 1, source.id);
    assert.equal(source.tracks[0].start, 0, source.id);
    assert.equal(source.tracks[0].end, source.duration, source.id);
    assert.ok(!/\(/.test(source.tracks[0].title), `${source.id}: the track title is just the song name`);
  }
  const virgie = byYoutubeId.get("y9x0Myp9sBE");
  assert.equal(virgie.artist, "Tyler Childers & Chris Stapleton");
  assert.deepEqual(virgie.artists, ["Tyler Childers", "Chris Stapleton"]);
});

test("Live at the Ryman is one 12-song album with exact boundaries and a video per song", () => {
  const album = byId.get(RYMAN.id);
  assert.equal(album.title, "Live at the Ryman");
  assert.equal(album.artist, "The Red Clay Strays");
  assert.deepEqual(album.artists, ["The Red Clay Strays"]);
  assert.equal(album.series, "Ryman Auditorium");
  assert.equal(album.year, 2024);
  assert.equal(album.added, "2026-09-24");
  assert.ok(!("youtubeId" in album), "no single video stands for the album");
  assert.equal(album.youtubePlaylistId, RYMAN.playlist);
  assert.equal(album.audio, "media/rcs-live-at-the-ryman.m4a");
  assert.equal(album.artwork, "artwork/rcs-live-at-the-ryman.jpg");
  assert.equal(album.timingStatus, "official-chapters");
  assert.deepEqual(album.tags, ["live", "concert"]);
  assert.equal(album.duration, RYMAN.duration);
  assert.deepEqual(album.tracks.map((track) => [track.start, track.title, track.youtubeId]), RYMAN.songs);
  assert.equal(album.tracks.at(-1).end, RYMAN.duration);
  assert.ok(album.tracks.every((track) => track.timingConfidence === "official"));
  assert.equal(album.tracks[2].id, "im-still-fine", "same song id the removed single used");
  // The single it replaced must not come back as a second copy of the same recording.
  assert.ok(!byYoutubeId.has("9r78xTZ7q08"), "I'm Still Fine is only a song on the album");
  const otherRyman = sources.filter((source) => source !== album && source.artists.includes("The Red Clay Strays") && /ryman/i.test(source.title));
  assert.deepEqual(otherRyman.map((source) => source.id), [], "the band's Ryman songs live on the album only");
});

test("no duplicate youtube ids, source ids or library paths", () => {
  const unique = (values) => new Set(values).size === values.length;
  assert.ok(unique(sources.map((source) => source.id)), "source ids");
  const videos = sources.flatMap((source) => [
    source.youtubeId,
    ...source.tracks.map((track) => track.youtubeId).filter((id) => id && id !== source.youtubeId)
  ]).filter(Boolean);
  assert.ok(unique(videos), "each YouTube video backs one source or one song");
  assert.ok(unique(sources.map((source) => source.youtubePlaylistId).filter(Boolean)), "playlist ids");
  assert.ok(unique(sources.map((source) => source.audio)), "audio paths");
  assert.ok(unique(sources.map((source) => source.artwork)), "artwork paths");
});

test("validator rejects broken catalogs", () => {
  assertRejects((copy) => { copy.version = 3; }, /version must be 5/, "old version");
  assertRejects((copy) => { copy.sources[1].id = copy.sources[0].id; }, /duplicate source id/, "duplicate id");
  assertRejects((copy) => { copy.sources[1].youtubeId = copy.sources[0].youtubeId; }, /already used/, "duplicate youtubeId");
  assertRejects((copy) => { copy.sources[0].audio = "./media/JoUq869LXeA.m4a"; }, /audio must look like/, "old audio path");
  assertRejects((copy) => { copy.sources[0].artwork = "assets/artwork/JoUq869LXeA.jpg"; }, /artwork must look like/, "old artwork path");
  assertRejects((copy) => { copy.sources[0].audioUrl = "./media/JoUq869LXeA.m4a"; }, /legacy field/, "legacy audioUrl");
  assertRejects((copy) => { copy.sources[0].seires = "Typo"; }, /unknown field "seires"/, "misspelled field");
  assertRejects((copy) => { copy.sources[0].artists = []; }, /non-empty array/, "empty artists");
  assertRejects((copy) => { copy.sources[0].artists = [" Of Monsters and Men"]; }, /leading or trailing spaces/, "untrimmed artist");
  assertRejects((copy) => { copy.sources[0].added = "2026-02-30"; }, /added must be/, "impossible date");
  assertRejects((copy) => { copy.sources[0].timingStatus = "guessed"; }, /timingStatus must be one of/, "unknown timingStatus");
  assertRejects((copy) => { copy.sources[0].provider = "youtube"; }, /provider must be "local"/, "youtube provider");
  assertRejects((copy) => { copy.sources[1].tracks[1].start += 5; }, /previous track ends/, "gap between tracks");
  assertRejects((copy) => { copy.sources[1].tracks.at(-1).end -= 1; }, /last track ends/, "short last track");
  assertRejects((copy) => { copy.sources[1].tracks.at(-1).end += 1; }, /after the source duration/, "track past the end");
  assertRejects((copy) => { copy.sources[1].tracks[1].id = copy.sources[1].tracks[0].id; }, /duplicate track id/, "duplicate track id");
  assertRejects((copy) => {
    copy.sources.find((source) => source.id === RYMAN.id).artists = ["Red Clay Strays"];
  }, /Artist is spelled 2 ways/, "two spellings of one artist");
  // Album sources (schema 5 playlist albums).
  const album = (copy) => copy.sources.find((source) => source.id === RYMAN.id);
  assertRejects((copy) => { delete album(copy).youtubePlaylistId; }, /youtubeId must be an 11-character YouTube id \(or set youtubePlaylistId/, "no video and no playlist");
  assertRejects((copy) => { album(copy).youtubePlaylistId = "PL"; }, /youtubePlaylistId must be/, "bad playlist id");
  assertRejects((copy) => { album(copy).youtubeId = "nope"; }, /youtubeId must be an 11-character/, "bad album youtubeId");
  assertRejects((copy) => { album(copy).tracks[0].youtubeId = "nope"; }, /track 1 "Wanna Be Loved": youtubeId must be/, "bad track youtubeId");
  assertRejects((copy) => { album(copy).tracks[1].youtubeId = album(copy).tracks[0].youtubeId; }, /already used by track 1 of/, "one video, two songs");
  assertRejects((copy) => { album(copy).tracks[0].youtubeId = copy.sources[0].youtubeId; }, /already used by "of-monsters-and-men-live-from-skarkali"/, "song reuses a source video");
  assertRejects((copy) => {
    copy.sources.push({ ...clone(copy.sources[0]), id: "the-red-clay-strays-im-still-fine-live-at-the-ryman", youtubeId: "9r78xTZ7q08",
      audio: "media/9r78xTZ7q08.m4a", artwork: "artwork/9r78xTZ7q08.jpg" });
  }, /youtubeId 9r78xTZ7q08 is already used by track 3 of "the-red-clay-strays-live-at-the-ryman"/, "re-adding the Ryman single");
  assertRejects((copy) => {
    const other = copy.sources.find((source) => source.youtubePlaylistId === undefined);
    other.youtubePlaylistId = RYMAN.playlist;
  }, /youtubePlaylistId .* is already used/, "duplicate playlist");
  assertRejects((copy) => { copy.sources[1].audio = album(copy).audio; }, /media\/rcs-live-at-the-ryman\.m4a is already used/, "two sources, one audio file");
  assertRejects((copy) => { copy.sources[1].artwork = album(copy).artwork; }, /artwork\/rcs-live-at-the-ryman\.jpg is already used/, "two sources, one cover");
  assertRejects((copy) => { album(copy).audio = "media/live at the ryman.m4a"; }, /audio must look like/, "spaces in a file name");
  assertRejects((copy) => { album(copy).artwork = "artwork/../rcs.jpg"; }, /artwork must look like/, "path-like artwork");
  assertRejects((copy) => { album(copy).tracks[0].videoId = "qyA6gOeRIyQ"; }, /unknown field "videoId"/, "misspelled track field");
  assertRejects((copy) => {
    copy.sources.find((source) => source.series === "NPR Tiny Desk").series = "npr tiny desk";
  }, /Series is spelled 2 ways/, "two spellings of one series");
});

test("mp4Duration reads mvhd from version 0 and version 1 headers", () => {
  const box = (type, body) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, "latin1");
    return Buffer.concat([header, body]);
  };
  const mvhd0 = Buffer.alloc(100);
  mvhd0.writeUInt32BE(44100, 12);
  mvhd0.writeUInt32BE(44100 * 90 + 22050, 16);
  const mvhd1 = Buffer.alloc(112);
  mvhd1[0] = 1;
  mvhd1.writeUInt32BE(1000, 20);
  mvhd1.writeBigUInt64BE(887490n, 24);
  const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0isomM4A ", "latin1"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acoustify-catalog-test-"));
  try {
    const v0 = path.join(dir, "v0.m4a");
    const v1 = path.join(dir, "v1.m4a");
    // moov after mdat, as many encoders write it.
    fs.writeFileSync(v0, Buffer.concat([ftyp, box("mdat", Buffer.alloc(64)), box("moov", box("mvhd", mvhd0))]));
    fs.writeFileSync(v1, Buffer.concat([ftyp, box("moov", Buffer.concat([box("udta", Buffer.alloc(4)), box("mvhd", mvhd1)]))]));
    assert.equal(mp4Duration(v0), 90.5);
    assert.equal(mp4Duration(v1), 887.49);
    assert.equal(mp4Duration(path.join(dir, "missing.m4a")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (fs.existsSync(path.join(libraryRoot, "media"))) {
  test("local library staging has every file and durations match the audio", () => {
    const { errors, warnings } = validateCatalog(catalog, { libraryRoot, local: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings.filter((warning) => /differs from/.test(warning)), [], "no duration drift over 0.5 s");
  });
}

const failed = results.filter((result) => result.error);
for (const { name, error } of results) {
  console.log(`${error ? "✗" : "✓"} ${name}`);
  if (error) console.error(`  ${String(error.message).split("\n").join("\n  ")}`);
}
console.log(`\ncatalog tests: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
