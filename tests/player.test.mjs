import assert from "node:assert/strict";

// Minimal browser surface for the controller; installed before importing
// player.js so nothing it touches at construction time is missing.
const documentStub = Object.assign(new EventTarget(), {
  baseURI: "https://app.test/acoustify/",
  visibilityState: "visible",
  elements: new Map(),
  getElementById(id) {
    return this.elements.get(id) || null;
  }
});
globalThis.document = documentStub;

const {
  PlaybackController,
  PlaybackError,
  PLAYBACK_ERROR_KINDS,
  classifyAudioUrl,
  continuousRunEnd,
  continuousTrackIndexAtTime,
  errorKindForMediaCode,
  errorKindForStatus,
  errorKindForYouTubeCode,
  interpolatePosition,
  isResumePosition,
  playbackErrorMessage,
  queueWithAddedTrack,
  queueWithoutTrack,
  queueWithMovedTrack
} = await import("../assets/js/player.js");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 2000, label = "condition" } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await tick(5);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers ported from tools/unit-test.mjs (fixture = The Cabin Sessions
// timings from the v2 catalog, so the original expectations still hold).
// ---------------------------------------------------------------------------

const cabinStarts = [0, 284, 490, 767, 977, 1130, 1408, 1658, 1951, 2211, 2469, 2698, 2949, 3123, 3416];
const cabinIds = ["dirty-paws", "from-finner", "king-and-lionheart", "mountain-sound", "numb-bears", "six-weeks", "sloom",
  "slow-and-steady", "your-bones", "lakehouse", "little-talks", "love-love-love", "sinking-man", "yellow-light"];
const cabinSourceId = "of-monsters-and-men-the-cabin-sessions";
const cabinTracks = new Map(cabinIds.map((id, index) => {
  const key = `${cabinSourceId}::${id}`;
  return [key, { key, id, sourceId: cabinSourceId, start: cabinStarts[index], end: cabinStarts[index + 1] }];
}));
const cabinQueue = [...cabinTracks.keys()];
const resolveCabin = (key) => cabinTracks.get(key);

assert.equal(cabinTracks.get(`${cabinSourceId}::six-weeks`).start, 1130);
assert.equal(continuousRunEnd(cabinQueue, 0, resolveCabin), 3416);
assert.equal(continuousRunEnd(cabinQueue, 2, resolveCabin, { enabled: false }), 767);
assert.equal(continuousTrackIndexAtTime(cabinQueue, 0, 1131, resolveCabin), 5);
assert.equal(continuousTrackIndexAtTime(cabinQueue, 5, 1200, resolveCabin), 5);
assert.equal(isResumePosition(null), false);
assert.equal(isResumePosition(undefined), false);
assert.equal(isResumePosition(""), false);
assert.equal(isResumePosition(120.5), true);

const queue = ["played", "current", "next-a", "next-b"];
assert.deepEqual(queueWithAddedTrack([], -1, "first-song"), ["first-song"]);
assert.deepEqual(queueWithAddedTrack(queue, 1, "new-song"), [...queue, "new-song"]);
assert.deepEqual(queueWithAddedTrack(queue, 1, "new-song", { next: true }), ["played", "current", "new-song", "next-a", "next-b"]);
assert.deepEqual(queueWithAddedTrack(queue, 1, "next-a"), queue);
assert.deepEqual(queueWithAddedTrack(queue, 1, "played"), ["current", "next-a", "next-b", "played"]);
assert.deepEqual(queueWithoutTrack(queue, 1, "current"), queue);
assert.deepEqual(queueWithoutTrack(queue, 1, "next-a"), ["played", "current", "next-b"]);
assert.deepEqual(queueWithMovedTrack(queue, 1, "next-b", -1), ["played", "current", "next-b", "next-a"]);
assert.deepEqual(queueWithMovedTrack(queue, 1, "next-a", -1), queue);

// Continuity stops at a gap or at a different source.
const gapTracks = new Map([
  ["s::a", { key: "s::a", sourceId: "s", start: 0, end: 100 }],
  ["s::b", { key: "s::b", sourceId: "s", start: 101, end: 200 }],
  ["t::c", { key: "t::c", sourceId: "t", start: 200, end: 300 }]
]);
assert.equal(continuousRunEnd(["s::a", "s::b"], 0, (key) => gapTracks.get(key)), 100);
assert.equal(continuousRunEnd(["s::b", "t::c"], 0, (key) => gapTracks.get(key)), 200);
assert.equal(continuousTrackIndexAtTime(["s::b", "t::c"], 0, 250, (key) => gapTracks.get(key)), 0);
assert.equal(continuousRunEnd([], 0, (key) => gapTracks.get(key)), 0);

// ---------------------------------------------------------------------------
// New pure helpers
// ---------------------------------------------------------------------------

const anchor = { time: 100, at: 1000 };
assert.equal(interpolatePosition(anchor, 1500, { playing: true, start: 0, end: 200 }), 100.5);
assert.equal(interpolatePosition(anchor, 1500, { playing: false, start: 0, end: 200 }), 100);
assert.equal(interpolatePosition(anchor, 1250, { playing: true, rate: 2, start: 0, end: 200 }), 100.5);
assert.equal(interpolatePosition(anchor, 1500, { playing: true, start: 0, end: 100.2 }), 100.2, "clamped to track end");
assert.equal(interpolatePosition(anchor, 900, { playing: true, start: 0, end: 200 }), 100, "never runs backwards");
assert.equal(interpolatePosition(anchor, 60_000, { playing: true, start: 0, end: 500 }), 101.5, "extrapolation is capped");
assert.equal(interpolatePosition(anchor, 60_000, { playing: true, start: 0, end: 500, maxAhead: 10 }), 110);
assert.equal(interpolatePosition({ time: 5, at: 0 }, 0, { start: 10, end: 20 }), 10, "clamped to track start");
assert.equal(interpolatePosition(null, 0, { start: 3, end: 9 }), 3);
assert.equal(interpolatePosition(anchor, Number.NaN, { playing: true, start: 0, end: 200 }), 100);
// Smoothness: 60 frames interpolate linearly with no steps.
const frames = Array.from({ length: 60 }, (_, index) => interpolatePosition(anchor, 1000 + index * 16.667, { playing: true, end: 1000 }));
for (let index = 1; index < frames.length; index += 1) {
  assert.ok(Math.abs(frames[index] - frames[index - 1] - 0.016667) < 1e-6);
}

assert.equal(errorKindForStatus(401), "auth");
assert.equal(errorKindForStatus(403), "auth");
assert.equal(errorKindForStatus(404), "decode");
assert.equal(errorKindForStatus(206), "decode");
assert.equal(errorKindForStatus(200), "decode");
assert.equal(errorKindForStatus(503), "network");
assert.equal(errorKindForStatus(429), "network");
assert.equal(errorKindForMediaCode(2), "network");
assert.equal(errorKindForMediaCode(3), "decode");
assert.equal(errorKindForMediaCode(4), "unsupported");
assert.equal(errorKindForMediaCode(1), "unknown");
assert.equal(errorKindForYouTubeCode(150), "unsupported");
assert.equal(errorKindForYouTubeCode(101), "unsupported");
assert.equal(errorKindForYouTubeCode(100), "unsupported");
assert.equal(errorKindForYouTubeCode(5), "decode");
assert.equal(errorKindForYouTubeCode(2), "unknown");
assert.match(playbackErrorMessage("decode", 404), /isn't available/);
assert.match(playbackErrorMessage("auth"), /Connect your library/);
assert.equal(playbackErrorMessage("nonsense"), playbackErrorMessage("unknown"));
assert.deepEqual([...PLAYBACK_ERROR_KINDS], ["auth", "network", "decode", "unsupported", "unknown"]);

const typed = new PlaybackError("", "auth", { status: 401 });
assert.equal(typed.kind, "auth");
assert.equal(typed.status, 401);
assert.match(typed.message, /Connect your library/);
assert.equal(new PlaybackError("x", "bogus").kind, "unknown");
assert.ok(typed instanceof Error);

{
  const seen = [];
  const fetchStatus = (status) => async (url, init) => {
    seen.push({ url, init });
    return { status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } };
  };
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: fetchStatus(401) }), { kind: "auth", status: 401 });
  assert.equal(seen[0].init.headers.Range, "bytes=0-1");
  assert.equal(seen[0].init.cache, "no-store");
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: fetchStatus(403) }), { kind: "auth", status: 403 });
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: fetchStatus(404) }), { kind: "decode", status: 404 });
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: fetchStatus(206) }), { kind: "decode", status: 206 });
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: fetchStatus(502) }), { kind: "network", status: 502 });
  const offline = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: offline }), { kind: "network", status: 0 });
  let aborted = false;
  const hanging = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
  });
  assert.deepEqual(await classifyAudioUrl("https://hub.test/a.m4a", { fetchImpl: hanging, timeoutMs: 20 }), { kind: "network", status: 0 });
  assert.equal(aborted, true, "a timed-out probe is aborted");
  assert.deepEqual(await classifyAudioUrl("", { fetchImpl: fetchStatus(200) }), { kind: "unknown", status: 0 });
}

// ---------------------------------------------------------------------------
// PlaybackController against a fake <audio> element
// ---------------------------------------------------------------------------

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this._src = "";
    this.currentSrc = "";
    this._time = 0;
    this.readyState = 0;
    this.networkState = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.error = null;
    this.volume = 1;
    this.srcAssignments = 0;
    this.generation = 0;
    this.pendingPlay = null;
    this.failCode = 0;
    this.metadataDelay = 2;
    this.blockAutoplay = false;
    this.hang = false; // the request is never answered: no metadata, no error
  }

  fire(type) {
    this.dispatchEvent(new Event(type));
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = value;
    this.currentSrc = value;
    this.srcAssignments += 1;
    this.#startLoad();
  }

  load() {
    this.#startLoad();
  }

  removeAttribute(name) {
    if (name !== "src") return;
    this._src = "";
    this.currentSrc = "";
  }

  #startLoad() {
    const generation = ++this.generation;
    this.#rejectPendingPlay("AbortError");
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.error = null;
    this._time = 0;
    // No source: the element empties itself and waits (NETWORK_EMPTY).
    this.networkState = this._src ? 2 : 0;
    if (!this._src || this.hang) return;
    setTimeout(() => {
      if (generation !== this.generation) return;
      if (this.failCode) {
        this.error = { code: this.failCode };
        this.networkState = 3;
        this.fire("error");
        return;
      }
      this.readyState = 4;
      this.networkState = 1;
      this.fire("loadedmetadata");
      this.fire("canplay");
    }, this.metadataDelay);
  }

  get currentTime() {
    return this._time;
  }

  set currentTime(value) {
    this._time = value;
    if (this.readyState === 0) return;
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
      this.fire("seeked");
      this.fire("timeupdate");
    }, 1);
  }

  play() {
    if (this.error) return Promise.reject(Object.assign(new Error("No supported source."), { name: "NotSupportedError" }));
    if (this.blockAutoplay) return Promise.reject(Object.assign(new Error("Autoplay blocked."), { name: "NotAllowedError" }));
    if (!this.paused && !this.pendingPlay) return Promise.resolve();
    this.paused = false;
    this.ended = false;
    setTimeout(() => this.fire("play"), 0);
    return new Promise((resolve, reject) => {
      this.pendingPlay = { resolve, reject };
      setTimeout(() => {
        if (!this.pendingPlay || this.paused) return;
        this.pendingPlay = null;
        this.fire("playing");
        resolve();
      }, 3);
    });
  }

  pause() {
    this.#rejectPendingPlay("AbortError");
    if (this.paused) return;
    this.paused = true;
    setTimeout(() => this.fire("pause"), 0);
  }

  #rejectPendingPlay(name) {
    if (!this.pendingPlay) return;
    const { reject } = this.pendingPlay;
    this.pendingPlay = null;
    reject(Object.assign(new Error("Interrupted."), { name }));
  }

  // Test helper: move the playhead as if playback advanced.
  advance(time) {
    this._time = time;
    this.fire("timeupdate");
  }
}

const tracksBySource = {
  s: [["a", 0, 10], ["b", 10, 20], ["c", 20, 30]],
  t: [["t1", 0, 15]],
  u: [["u1", 0, 12]],
  y: [["y1", 0, 40], ["y2", 40, 90]]
};

function makeCatalog() {
  const sources = new Map();
  const tracks = new Map();
  for (const [sourceId, list] of Object.entries(tracksBySource)) {
    const source = {
      id: sourceId,
      title: `Album ${sourceId}`,
      artist: `Artist ${sourceId}`,
      provider: sourceId === "y" ? "youtube" : "local",
      youtubeId: sourceId === "y" ? "abcdefghijk" : undefined,
      audioUrl: ["s", "t"].includes(sourceId) ? `media/${sourceId}.m4a` : undefined,
      assetId: sourceId === "u" ? "asset-u" : undefined,
      artwork: `https://hub.test/artwork/${sourceId}.jpg`,
      fallbackArtwork: `https://i.ytimg.com/vi/${sourceId}/hqdefault.jpg`,
      duration: list.at(-1)[2],
      tracks: []
    };
    for (const [id, start, end] of list) {
      const track = { key: `${sourceId}::${id}`, id, sourceId, title: `Song ${id}`, artist: source.artist, start, end };
      source.tracks.push(track);
      tracks.set(track.key, track);
    }
    sources.set(sourceId, source);
  }
  return { sources, tracks };
}

function makeHarness(overrides = {}) {
  const catalog = makeCatalog();
  const audio = new FakeAudio();
  const calls = { ensure: [], probe: [], assets: [] };
  const harness = { probe: async () => ({ status: 206, ok: true }) };
  const player = new PlaybackController({
    resolveTrack: (key) => catalog.tracks.get(key),
    resolveSource: (id) => catalog.sources.get(id),
    getAudioAsset: async (id) => {
      calls.assets.push(id);
      return { blob: new Blob(["fake audio"], { type: "audio/mp4" }) };
    },
    audio,
    ensureStreamable: async (url) => {
      calls.ensure.push(url);
      await tick(1);
      return url;
    },
    fetchImpl: async (url, init) => {
      calls.probe.push({ url, init });
      return harness.probe(url, init);
    },
    ...overrides
  });
  const events = {};
  for (const type of ["trackchange", "statechange", "progress", "buffering", "queuechange", "segmentended", "error", "backendchange", "adbreak"]) {
    events[type] = [];
    player.addEventListener(type, (event) => events[type].push(event.detail));
  }
  return Object.assign(harness, { player, audio, calls, events, catalog });
}

// Play, continuous same-source advance, positionAt, next/previous.
{
  const { player, audio, calls, events } = makeHarness();
  assert.equal(player.isBuffering, false);
  assert.equal(await player.loadByKey("s::a"), true);
  assert.equal(player.currentTrack.key, "s::a");
  assert.equal(player.backend, "local");
  assert.equal(player.isPlaying, true);
  assert.equal(player.isBuffering, false);
  assert.equal(player.snapshot().isBuffering, false);
  assert.deepEqual(player.queue, ["s::a", "s::b", "s::c"]);
  assert.equal(player.queueIndex, 0);
  assert.deepEqual(calls.ensure, ["https://app.test/acoustify/media/s.m4a"], "library audio goes through ensureStreamable");
  assert.equal(audio.srcAssignments, 1);
  assert.ok(events.buffering.some((detail) => detail.buffering === true), "opening a stream reports buffering");
  assert.equal(events.buffering.at(-1).buffering, false);
  assert.equal(events.backendchange.length, 1);

  await tick(20);
  audio.advance(4.2);
  assert.equal(player.positionAt(), 4.2, "local positionAt reads the element clock");
  assert.equal(player.currentTime, 4.2);

  // Crossing the boundary inside one recording swaps the track, not the stream.
  audio.advance(9.95);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(player.queueIndex, 1);
  assert.equal(audio.srcAssignments, 1);
  assert.equal(calls.ensure.length, 1);
  assert.ok(events.segmentended.length >= 1);
  assert.equal(events.trackchange.at(-1).track.key, "s::b");
  audio.advance(11);
  assert.equal(player.snapshot().elapsed, 1);

  // Progress is throttled to ~4/s even when timeupdate fires faster.
  const before = events.progress.length;
  for (let index = 0; index < 10; index += 1) audio.advance(11 + index * 0.01);
  assert.ok(events.progress.length - before <= 1, "progress is throttled");

  // Next within the same source seeks; no reload, no ensureStreamable call.
  assert.equal(await player.next(), true);
  assert.equal(player.currentTrack.key, "s::c");
  assert.equal(audio.currentTime, 20);
  assert.equal(audio.srcAssignments, 1);
  assert.equal(calls.ensure.length, 1);

  // Previous inside the first 4 s goes to the previous track...
  audio.advance(21);
  assert.equal(await player.previous(), true);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(audio.currentTime, 10);
  // ...and after 4 s restarts the current one.
  await tick(10);
  audio.advance(15);
  assert.equal(await player.previous(), true);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(audio.currentTime, 10);

  // playNext + cross-source next reloads the element through ensureStreamable.
  assert.equal(player.playNext("t::t1"), true);
  assert.deepEqual(player.queue, ["s::a", "s::b", "t::t1", "s::c"]);
  assert.equal(player.playNext("t::t1"), false, "already next");
  assert.equal(await player.next(), true);
  assert.equal(player.currentTrack.key, "t::t1");
  assert.equal(audio.srcAssignments, 2);
  assert.equal(calls.ensure.at(-1), "https://app.test/acoustify/media/t.m4a");
  assert.equal(player.isPlaying, true);

  // Reaching the end of a source that is followed by another source jumps.
  await tick(10);
  audio.advance(14.9);
  await waitFor(() => player.currentTrack.key === "s::c", { label: "cross-source track change" });
  assert.equal(player.isBuffering, true, "buffering shows from the moment the stream swap starts");
  await waitFor(() => player.isPlaying && !player.isBuffering && audio.srcAssignments === 3, { label: "cross-source advance" });
  assert.equal(audio.srcAssignments, 3);
  assert.equal(audio.currentTime, 20);

  // Paused: positionAt is the last known time, not extrapolated.
  await player.pause();
  await tick(5);
  assert.equal(player.isPlaying, false);
  const paused = player.positionAt();
  assert.equal(player.positionAt(performance.now() + 5000), paused);

  // Seeking clamps to the track and emits progress immediately.
  const progressBefore = events.progress.length;
  await player.seekAbsolute(999);
  assert.equal(player.currentTime, 29.95);
  assert.equal(events.progress.length, progressBefore + 1);
  await player.seekRelative(2);
  assert.equal(audio.currentTime, 22);
  assert.equal(events.error.length, 0);
  player.destroy();
}

// End of queue with autoplay pauses at the track end; repeat all wraps.
{
  const { player, audio } = makeHarness();
  await player.loadByKey("t::t1", { queue: ["t::t1"] });
  await tick(10);
  audio.advance(14.95);
  await waitFor(() => !player.isPlaying, { label: "pause at end" });
  assert.equal(player.currentTrack.key, "t::t1");
  assert.ok(player.currentTime >= 14.88, "parked at the end of the last track");
  // Play while parked at the end starts the song again instead of re-ending.
  assert.equal(await player.play(), true);
  await tick(10);
  assert.equal(audio.currentTime, 0);
  assert.equal(player.isPlaying, true);
  player.setRepeat("all");
  await player.seekAbsolute(10);
  await tick(10);
  audio.advance(14.95);
  await waitFor(() => player.isPlaying && Math.abs(audio.currentTime) < 0.01, { label: "repeat-all wrap" });
  assert.equal(player.currentTrack.key, "t::t1");
  player.destroy();
}

// A superseded load resolves false and never touches the newer one.
{
  const { player, audio } = makeHarness();
  await player.loadByKey("s::a");
  const first = player.loadByKey("t::t1");
  const second = player.loadByKey("s::b");
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(audio.currentSrc, "https://app.test/acoustify/media/s.m4a");
  player.destroy();
}

// Buffering follows waiting/stalled/playing/canplay.
{
  const { player, audio, events } = makeHarness();
  await player.loadByKey("s::a");
  await tick(10);
  audio.readyState = 2;
  audio.fire("waiting");
  assert.equal(player.isBuffering, true);
  assert.equal(events.buffering.at(-1).buffering, true);
  assert.equal(events.buffering.at(-1).isBuffering, true);
  const frozen = player.positionAt();
  assert.equal(player.positionAt(performance.now() + 3000), frozen, "no extrapolation while buffering");
  audio.readyState = 4;
  audio.fire("playing");
  assert.equal(player.isBuffering, false);
  audio.readyState = 1;
  audio.fire("stalled");
  assert.equal(player.isBuffering, true);
  audio.readyState = 4;
  audio.fire("canplay");
  assert.equal(player.isBuffering, false);
  await player.pause();
  audio.fire("stalled");
  assert.equal(player.isBuffering, false, "a paused element is never buffering");
  player.destroy();
}

// Pausing while a stream is still opening cancels its autoplay.
{
  const { player, audio } = makeHarness();
  audio.metadataDelay = 40;
  const loading = player.loadByKey("t::t1");
  await tick(5);
  await player.pause();
  assert.equal(await loading, true);
  await tick(10);
  assert.equal(audio.paused, true);
  assert.equal(player.isPlaying, false);
  assert.equal(player.isBuffering, false);
  // ...and play() during an open resumes the intent.
  const reopening = player.loadByKey("s::a");
  await tick(1);
  assert.equal(await player.play(), true);
  assert.equal(await reopening, true);
  assert.equal(audio.paused, false);
  player.destroy();
}

// A request that is never answered fails as a network error once the stream
// has been quiet for the stall window; the next play opens a fresh request.
{
  const { player, audio, events } = makeHarness({ stallTimeoutMs: 60 });
  audio.hang = true;
  const loading = player.loadByKey("t::t1");
  await tick(10);
  assert.equal(player.isBuffering, true);
  await assert.rejects(loading, (error) => error instanceof PlaybackError && error.kind === "network");
  assert.equal(events.error.length, 1, "reported once");
  assert.equal(events.error[0].kind, "network");
  assert.match(events.error[0].error.message, /Check your connection/);
  assert.equal(player.isBuffering, false, "the spinner stops");
  assert.equal(player.isPlaying, false);
  assert.equal(audio.src, "", "the dead request is dropped");
  audio.hang = false;
  const assignments = audio.srcAssignments;
  assert.equal(await player.play(), true);
  assert.equal(audio.srcAssignments, assignments + 1, "play reopens the stream");
  assert.equal(player.currentTrack.key, "t::t1");
  assert.equal(player.isPlaying, true);
  assert.equal(events.error.length, 1);
  player.destroy();
}

// A slow stream that keeps delivering is never failed, neither is a paused
// open; play after a long quiet spell starts over instead of waiting on it.
{
  const { player, audio, events } = makeHarness({ stallTimeoutMs: 60 });
  audio.hang = true;
  const loading = player.loadByKey("s::b");
  for (let index = 0; index < 6; index += 1) {
    await tick(20);
    audio.fire("progress");
  }
  assert.equal(events.error.length, 0, "progress keeps the load alive");
  assert.equal(player.isBuffering, true);
  await player.pause();
  await tick(150);
  assert.equal(events.error.length, 0, "nobody is waiting for sound");
  audio.hang = false;
  const assignments = audio.srcAssignments;
  const playing = player.play();
  assert.equal(await loading, false, "the quiet load is replaced");
  assert.equal(await playing, true);
  assert.equal(audio.srcAssignments, assignments + 1, "with a fresh request");
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(audio.currentTime, 10);
  assert.equal(player.isPlaying, true);
  assert.equal(events.error.length, 0);
  player.destroy();
}

// Autoplay blocked: the track stays loaded and paused, no error.
{
  const { player, audio, events } = makeHarness();
  audio.blockAutoplay = true;
  assert.equal(await player.loadByKey("s::b"), true);
  await tick(5);
  assert.equal(player.isPlaying, false);
  assert.equal(player.isBuffering, false);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(audio.currentTime, 10);
  assert.equal(events.error.length, 0);
  player.destroy();
}

// Error classification: media failures on library URLs are probed.
async function expectLoadFailure({ key = "t::t1", setup, kind, status, probed = true }) {
  const harness = makeHarness();
  setup(harness);
  const { player, calls, events } = harness;
  await assert.rejects(player.loadByKey(key), (error) => {
    assert.ok(error instanceof PlaybackError);
    assert.equal(error.kind, kind);
    assert.equal(error.reported, true);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
  assert.equal(events.error.length, 1, "reported exactly once");
  assert.equal(events.error[0].kind, kind);
  assert.equal(events.error[0].track.key, key);
  assert.equal(player.isPlaying, false);
  assert.equal(player.isBuffering, false);
  assert.equal(calls.probe.length > 0, probed);
  if (probed) assert.equal(calls.probe[0].url, "https://app.test/acoustify/media/t.m4a");
  player.destroy();
  return events.error[0];
}

await expectLoadFailure({
  setup: (h) => {
    h.audio.failCode = 4;
    h.probe = async () => ({ status: 401, ok: false });
  },
  kind: "auth",
  status: 401
});
await expectLoadFailure({
  setup: (h) => {
    h.audio.failCode = 4;
    h.probe = async () => {
      throw new TypeError("Failed to fetch");
    };
  },
  kind: "network",
  status: 0
});
const missing = await expectLoadFailure({
  setup: (h) => {
    h.audio.failCode = 4;
    h.probe = async () => ({ status: 404, ok: false });
  },
  kind: "decode",
  status: 404
});
assert.equal(missing.status, 404);
assert.match(missing.error.message, /isn't available/);
await expectLoadFailure({
  setup: (h) => {
    h.audio.failCode = 3;
    h.probe = async () => ({ status: 206, ok: true });
  },
  kind: "decode",
  status: 206
});
// Imported blobs are local: the media error code is enough, no probe.
await expectLoadFailure({ key: "u::u1", setup: (h) => (h.audio.failCode = 3), kind: "decode", probed: false });
await expectLoadFailure({ key: "u::u1", setup: (h) => (h.audio.failCode = 4), kind: "unsupported", probed: false });

// ensureStreamable failures carry their own reason.
for (const [thrown, kind] of [
  [Object.assign(new Error("401"), { status: 401 }), "auth"],
  [Object.assign(new Error("nope"), { kind: "network" }), "network"],
  [new TypeError("Failed to fetch"), "network"],
  [Object.assign(new Error("The connection stalled."), { name: "TimeoutError" }), "network"],
  [new Error("mystery"), "unknown"]
]) {
  const { player, events } = makeHarness({
    ensureStreamable: async () => {
      throw thrown;
    }
  });
  await assert.rejects(player.loadByKey("s::a"), (error) => error.kind === kind);
  assert.equal(events.error.length, 1);
  assert.equal(events.error[0].kind, kind);
  player.destroy();
}

// A provider the player cannot handle is "unsupported".
{
  const { player, catalog, events } = makeHarness();
  catalog.sources.get("t").provider = "spotify";
  await assert.rejects(player.loadByKey("t::t1"), (error) => error.kind === "unsupported");
  assert.equal(events.error[0].kind, "unsupported");
  player.destroy();
}

// Mid-playback media error is classified and reported once; play() reopens.
{
  const harness = makeHarness();
  const { player, audio, events } = harness;
  await player.loadByKey("s::b");
  await tick(10);
  audio.advance(13.5);
  harness.probe = async () => {
    throw new TypeError("Failed to fetch");
  };
  audio.error = { code: 2 };
  audio.networkState = 3;
  audio.paused = true;
  audio.fire("error");
  await waitFor(() => events.error.length === 1, { label: "mid-playback error" });
  assert.equal(events.error[0].kind, "network");
  assert.equal(player.isPlaying, false);
  // Aborted media errors are not failures.
  audio.error = { code: 1 };
  audio.fire("error");
  await tick(5);
  assert.equal(events.error.length, 1);
  audio.error = { code: 2 };
  harness.probe = async () => ({ status: 206, ok: true });
  const assignments = audio.srcAssignments;
  assert.equal(await player.play(), true);
  assert.equal(audio.srcAssignments, assignments + 1, "a failed element is reopened");
  assert.equal(player.currentTrack.key, "s::b");
  assert.ok(Math.abs(audio.currentTime - 13.5) < 0.01, "resumes where it stopped");
  assert.equal(player.isPlaying, true);
  player.destroy();
}

// Media Session: text immediately, artwork swapped in when resolved, only
// for the source that is still current; same-source advances reuse it.
{
  const metadataLog = [];
  const handlers = new Map();
  const mediaSession = {
    playbackState: "none",
    set metadata(value) {
      metadataLog.push(value);
    },
    get metadata() {
      return metadataLog.at(-1) || null;
    },
    setActionHandler(action, handler) {
      handlers.set(action, handler);
    },
    setPositionState() {}
  };
  Object.defineProperty(globalThis.navigator, "mediaSession", { value: mediaSession, configurable: true });
  globalThis.MediaMetadata = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  const artworkRequests = [];
  const releases = [];
  const { player, audio } = makeHarness({
    mediaSessionArtwork: (source) => {
      artworkRequests.push(source.id);
      return new Promise((resolve) => releases.push(() => resolve([{ src: `data:image/jpeg;base64,${source.id}`, sizes: "512x512", type: "image/jpeg" }])));
    }
  });
  assert.ok(handlers.has("nexttrack") && handlers.has("seekto"));
  await player.loadByKey("s::a");
  const first = metadataLog.at(-1);
  assert.equal(first.title, "Song a");
  assert.equal(first.album, "Album s");
  assert.equal(first.artwork[0].src, "https://i.ytimg.com/vi/s/hqdefault.jpg", "fallback art until resolved");
  assert.ok(first.artwork.every((item) => !item.src.startsWith("https://hub.test/")), "private art URLs are never handed to the OS");
  assert.deepEqual(artworkRequests, ["s"]);
  releases.shift()();
  await tick(1);
  assert.equal(metadataLog.at(-1).artwork[0].src, "data:image/jpeg;base64,s");
  assert.equal(metadataLog.at(-1).title, "Song a");
  await tick(10);
  audio.advance(10.2);
  assert.equal(player.currentTrack.key, "s::b");
  assert.equal(metadataLog.at(-1).title, "Song b");
  assert.equal(metadataLog.at(-1).artwork[0].src, "data:image/jpeg;base64,s", "same source reuses art without a flicker");
  assert.deepEqual(artworkRequests, ["s"]);

  // Art for a source that is no longer current is cached but not applied.
  await player.loadByKey("t::t1");
  assert.deepEqual(artworkRequests, ["s", "t"]);
  await player.loadByKey("s::c");
  releases.shift()();
  await tick(1);
  assert.equal(metadataLog.at(-1).title, "Song c");
  assert.equal(metadataLog.at(-1).artwork[0].src, "data:image/jpeg;base64,s");

  // Lock-screen seekto is relative to the current track.
  handlers.get("seekto")({ seekTime: 3 });
  await tick(1);
  assert.equal(audio.currentTime, 23);
  player.destroy();
  assert.equal(handlers.get("play"), null, "destroy releases media session handlers");
  delete globalThis.navigator.mediaSession;
  delete globalThis.MediaMetadata;
}

// YouTube backend: lead-in, continuous end bound, buffering, interpolation,
// ad detection and error kinds, against a fake IFrame API.
{
  const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  let ytPlayer;
  class FakeYTPlayer {
    constructor(elementId, options) {
      ytPlayer = this;
      this.elementId = elementId;
      this.options = options;
      this.calls = [];
      this.time = 0;
      this.state = PlayerState.UNSTARTED;
      setTimeout(() => options.events.onReady({ target: this }), 1);
    }
    setVolume(value) { this.calls.push(["setVolume", value]); }
    loadVideoById(request) { this.calls.push(["loadVideoById", request]); this.time = request.startSeconds; }
    cueVideoById(request) { this.calls.push(["cueVideoById", request]); }
    seekTo(time) { this.calls.push(["seekTo", time]); this.time = time; }
    playVideo() { this.calls.push(["playVideo"]); }
    pauseVideo() { this.calls.push(["pauseVideo"]); }
    getCurrentTime() { return this.time; }
    getPlayerState() { return this.state; }
    getPlaybackQuality() { return "hd720"; }
    emitState(state) {
      this.state = state;
      this.options.events.onStateChange({ data: state });
    }
  }
  globalThis.YT = { Player: FakeYTPlayer, PlayerState };
  const wrap = { hidden: true };
  documentStub.elements.set("youtube-player", { id: "youtube-player" });
  const { player, events } = makeHarness({ youtubeWrap: wrap });
  await player.loadByKey("y::y2");
  await waitFor(() => ytPlayer?.calls.some(([name]) => name === "loadVideoById"), { label: "YouTube load" });
  assert.equal(ytPlayer.elementId, "youtube-player");
  assert.equal(wrap.hidden, false);
  assert.equal(player.backend, "youtube");
  const [, request] = ytPlayer.calls.find(([name]) => name === "loadVideoById");
  assert.equal(request.videoId, "abcdefghijk");
  assert.equal(request.startSeconds, 39.5, "YouTube starts half a second early");
  assert.equal(request.endSeconds, 90);
  assert.equal(player.isBuffering, true);
  ytPlayer.emitState(PlayerState.BUFFERING);
  assert.equal(player.isBuffering, true);
  ytPlayer.time = 41;
  ytPlayer.emitState(PlayerState.PLAYING);
  assert.equal(player.isPlaying, true);
  assert.equal(player.isBuffering, false);
  const now = performance.now();
  const at = player.positionAt(now);
  assert.ok(Math.abs(player.positionAt(now + 500) - at - 0.5) < 1e-6, "YouTube position is interpolated between reads");
  ytPlayer.emitState(PlayerState.PAUSED);
  assert.equal(player.isPlaying, false);
  assert.equal(player.positionAt(now + 5000), 41);
  ytPlayer.options.events.onError({ data: 150 });
  assert.equal(events.error.at(-1).kind, "unsupported");
  assert.match(events.error.at(-1).error.message, /doesn't allow/);
  player.destroy();
  delete globalThis.YT;
}

console.log("Player tests passed: queue helpers, continuity, interpolation, buffering, error classification, media session, YouTube.");
