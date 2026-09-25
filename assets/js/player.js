import { clamp, safeArtwork } from "./utils.js";

let youtubeApiPromise;
const SEGMENT_BOUNDARY_TOLERANCE = 0.35;
const SEGMENT_END_EPSILON = 0.12;
const PREVIOUS_RESTART_SECONDS = 4;
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_MIN_GAP_MS = 200;
const IDLE_MONITOR_MS = 1500;
const MIN_MONITOR_MS = 40;
const MAX_EXTRAPOLATION_SECONDS = 1.5;
const SEEK_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 8000;
// How long a stream may go without any network activity while someone waits
// for it to start before the load is given up as unreachable.
const LOAD_STALL_MS = 20_000;
const LOAD_ACTIVITY_EVENTS = ["loadstart", "progress", "loadedmetadata", "loadeddata", "canplay", "seeked", "playing"];
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const NETWORK_EMPTY = 0;
const NETWORK_LOADING = 2;
const NETWORK_NO_SOURCE = 3;
const MEDIA_ERR_ABORTED = 1;

export const PLAYBACK_ERROR_KINDS = Object.freeze(["auth", "network", "decode", "unsupported", "unknown"]);

const ERROR_MESSAGES = {
  auth: "Connect your library to play this song.",
  network: "Couldn't reach your music. Check your connection and try again.",
  decode: "This recording couldn't be played.",
  unsupported: "This recording can't be played in this browser.",
  unknown: "Playback stopped unexpectedly."
};

export function isResumePosition(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function continuousRunEnd(queue, queueIndex, resolveTrack, { enabled = true } = {}) {
  let track = resolveTrack(queue[queueIndex]);
  if (!track) return 0;
  if (!enabled) return track.end;

  for (let index = queueIndex + 1; index < queue.length; index += 1) {
    const next = resolveTrack(queue[index]);
    if (!next || next.sourceId !== track.sourceId || Math.abs(next.start - track.end) > SEGMENT_BOUNDARY_TOLERANCE) break;
    track = next;
  }
  return track.end;
}

export function continuousTrackIndexAtTime(queue, queueIndex, currentTime, resolveTrack) {
  let index = queueIndex;
  let track = resolveTrack(queue[index]);
  if (!track) return queueIndex;

  while (index + 1 < queue.length && currentTime >= track.end - SEGMENT_END_EPSILON) {
    const next = resolveTrack(queue[index + 1]);
    if (!next || next.sourceId !== track.sourceId || Math.abs(next.start - track.end) > SEGMENT_BOUNDARY_TOLERANCE) break;
    index += 1;
    track = next;
  }
  return index;
}

export function queueWithAddedTrack(queue, queueIndex, trackKey, { next = false } = {}) {
  const result = [...queue];
  const existingIndex = result.indexOf(trackKey);
  if (existingIndex >= 0 && (existingIndex === queueIndex || existingIndex > queueIndex)) return result;
  let activeIndex = queueIndex;
  if (existingIndex >= 0) {
    result.splice(existingIndex, 1);
    if (existingIndex < activeIndex) activeIndex -= 1;
  }
  result.splice(next && activeIndex >= 0 ? activeIndex + 1 : result.length, 0, trackKey);
  return result;
}

export function queueWithoutTrack(queue, queueIndex, trackKey) {
  const index = queue.indexOf(trackKey);
  if (index < 0 || index === queueIndex) return [...queue];
  return queue.filter((key) => key !== trackKey);
}

export function queueWithMovedTrack(queue, queueIndex, trackKey, direction) {
  const result = [...queue];
  const index = result.indexOf(trackKey);
  if (index < 0 || index <= queueIndex) return result;
  const target = index + Math.sign(Number(direction) || 0);
  if (target <= queueIndex || target < 0 || target >= result.length) return result;
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

// Extrapolates a playback clock read at `anchor.at` (ms) to `nowMs`. The cap
// keeps a progress bar from running away when the real clock silently froze
// (a stall that never fired "waiting", or a YouTube ad) between two reads.
export function interpolatePosition(anchor, nowMs, {
  playing = false,
  rate = 1,
  start = 0,
  end = Infinity,
  maxAhead = MAX_EXTRAPOLATION_SECONDS
} = {}) {
  const upper = Math.max(start, end);
  const base = Number(anchor?.time);
  if (!Number.isFinite(base)) return clamp(0, start, upper);
  let time = base;
  if (playing) {
    const elapsedMs = Number(nowMs) - Number(anchor.at);
    const speed = Number(rate) > 0 ? Number(rate) : 1;
    if (Number.isFinite(elapsedMs) && elapsedMs > 0) time += Math.min((elapsedMs / 1000) * speed, maxAhead);
  }
  return clamp(time, start, upper);
}

export function errorKindForStatus(status) {
  const code = Number(status);
  if (code === 401 || code === 403) return "auth";
  if (code === 408 || code === 429 || code >= 500) return "network";
  return "decode";
}

// MediaError codes: 1 aborted, 2 network, 3 decode, 4 source not supported.
export function errorKindForMediaCode(code) {
  if (code === 2) return "network";
  if (code === 3) return "decode";
  if (code === 4) return "unsupported";
  return "unknown";
}

// IFrame API error codes: 2 bad parameter, 5 HTML5 player error,
// 100 removed/private, 101 and 150 embedding disabled by the owner.
export function errorKindForYouTubeCode(code) {
  const value = Number(code);
  if (value === 5) return "decode";
  if (value === 100 || value === 101 || value === 150) return "unsupported";
  return "unknown";
}

export function playbackErrorMessage(kind, status = 0) {
  if (Number(status) === 404 || Number(status) === 410) return "This recording isn't available right now.";
  return ERROR_MESSAGES[kind] || ERROR_MESSAGES.unknown;
}

// A two-byte Range probe travels the same path as the <audio> request (the
// service worker adds the library token), so its status says why the media
// element gave up: auth, reachability, or a response the decoder rejected.
export async function classifyAudioUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function" || !url) return { kind: "unknown", status: 0 };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const response = await Promise.race([
      fetchImpl(url, { headers: { Range: "bytes=0-1" }, cache: "no-store", signal: controller?.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error("The audio probe timed out."));
        }, timeoutMs);
      })
    ]);
    const status = Number(response?.status) || 0;
    Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    return { kind: errorKindForStatus(status), status };
  } catch {
    return { kind: "network", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export class PlaybackError extends Error {
  constructor(message, kind = "unknown", { cause, status = 0 } = {}) {
    const safeKind = PLAYBACK_ERROR_KINDS.includes(kind) ? kind : "unknown";
    super(message || playbackErrorMessage(safeKind, status), cause ? { cause } : undefined);
    this.name = "PlaybackError";
    this.kind = safeKind;
    this.status = Number(status) || 0;
  }
}

function staleLoad() {
  return Object.assign(new Error("A newer playback request replaced this one."), { stale: true });
}

function mediaFailure() {
  return Object.assign(new Error("The media element reported an error."), { media: true });
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function absoluteUrl(url) {
  const base = globalThis.document?.baseURI || globalThis.location?.href;
  try {
    return base ? new URL(url, base).href : String(url);
  } catch {
    return String(url);
  }
}

function hasMediaSession() {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

function artworkKey(source) {
  return `${source?.id || ""}\n${source?.artwork || ""}\n${source?.fallbackArtwork || ""}`;
}

function youtubeQualityLabel(value) {
  return `YouTube · ${String(value || "auto").replace("hd", "HD ").toUpperCase()}`;
}

function loadYouTubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previous = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(globalThis.YT);
    };
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        script.remove();
        reject(new Error("The YouTube player API could not be loaded."));
      };
      document.head.append(script);
    }
    setTimeout(() => {
      if (!globalThis.YT?.Player) reject(new Error("The YouTube player took too long to load."));
    }, 20000);
  });
  // A failed attempt must not poison every later YouTube load in this session.
  youtubeApiPromise.catch(() => {
    youtubeApiPromise = null;
  });
  return youtubeApiPromise;
}

export class PlaybackController extends EventTarget {
  constructor({
    resolveTrack,
    resolveSource,
    getAudioAsset = async () => null,
    audio = null,
    youtubeWrap = null,
    youtubeContainerId = "youtube-player",
    ensureStreamable = async (url) => url,
    mediaSessionArtwork = null,
    fetchImpl = null,
    stallTimeoutMs = LOAD_STALL_MS
  } = {}) {
    super();
    if (typeof resolveTrack !== "function" || typeof resolveSource !== "function") {
      throw new TypeError("PlaybackController needs resolveTrack and resolveSource functions.");
    }
    this.resolveTrack = resolveTrack;
    this.resolveSource = resolveSource;
    this.getAudioAsset = getAudioAsset;
    this.ensureStreamable = typeof ensureStreamable === "function" ? ensureStreamable : async (url) => url;
    this.mediaSessionArtwork = typeof mediaSessionArtwork === "function" ? mediaSessionArtwork : null;
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.stallTimeoutMs = Number(stallTimeoutMs) > 0 ? Number(stallTimeoutMs) : LOAD_STALL_MS;

    this.currentTrack = null;
    this.currentSource = null;
    this.currentTime = 0;
    this.isPlaying = false;
    this.isBuffering = false;
    this.backend = null;
    this.qualityLabel = "Nothing playing";
    this.queue = [];
    this.queueIndex = -1;
    this.repeat = "off";
    this.shuffle = false;
    this.autoplay = true;
    this.segmentLeadIn = 0.5;
    this.volume = 0.86;
    this.keepScreenAwake = false;

    this.youtubeWrap = youtubeWrap;
    this.youtubeContainerId = youtubeContainerId;
    this.youtubePlayer = null;
    this.youtubeReady = false;
    this.youtubeVideoId = null;
    this.appliedYouTubeEnd = NaN;
    this.pendingYouTubeLoad = null;

    this.localAudio = audio || globalThis.document?.getElementById("local-audio") || new Audio();
    this.localObjectUrl = null;
    this.localAssetId = null;
    this.localSourceUrl = null;
    this.localLoad = null;

    this.loadAbort = null;
    this.monitorTimer = null;
    this.segmentEndedLock = false;
    this.queueSnapshotCache = null;
    this.clock = { time: 0, at: nowMs() };
    this.lastProgress = { at: -Infinity, time: NaN, key: null };
    this.artworkCache = { key: "", artwork: null };
    this.artworkPending = "";
    this.adWatch = { lastTime: -1, stalledSince: 0, active: false };
    this.wakeLockSentinel = null;
    this.wakeLockPending = false;
    this.lastPositionState = { position: -1, duration: -1, at: 0 };
    this.listeners = new AbortController();

    this.#bindLocalAudio();
    this.#configureMediaSession();
    this.#configureAudioSession();
    globalThis.document?.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      this.#syncWakeLock();
      if (this.currentTrack) this.#monitor({ forceProgress: true });
    }, { signal: this.listeners.signal });
  }

  // Safari exposes navigator.audioSession; declaring "playback" keeps local
  // audio running with the Ring/Silent switch on and while backgrounded.
  #configureAudioSession() {
    try {
      if (typeof navigator !== "undefined" && navigator.audioSession) navigator.audioSession.type = "playback";
    } catch { /* unsupported */ }
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  configure({ volume, repeat, shuffle, autoplay, segmentLeadIn, keepScreenAwake } = {}) {
    if (Number.isFinite(Number(volume))) this.setVolume(Number(volume), false);
    if (["off", "all", "one"].includes(repeat)) this.repeat = repeat;
    if (typeof shuffle === "boolean") this.shuffle = shuffle;
    if (typeof autoplay === "boolean") this.autoplay = autoplay;
    if (Number.isFinite(Number(segmentLeadIn))) this.segmentLeadIn = clamp(Number(segmentLeadIn), 0, 5);
    if (typeof keepScreenAwake === "boolean") {
      this.keepScreenAwake = keepScreenAwake;
      this.#syncWakeLock();
    }
    this.emit("optionschange", this.snapshot());
  }

  snapshot() {
    const start = this.currentTrack?.start ?? 0;
    const end = this.currentTrack?.end ?? start;
    const elapsed = clamp(this.currentTime - start, 0, Math.max(0, end - start));
    return {
      track: this.currentTrack,
      source: this.currentSource,
      currentTime: this.currentTime,
      elapsed,
      duration: Math.max(0, end - start),
      progress: end > start ? elapsed / (end - start) : 0,
      isPlaying: this.isPlaying,
      isBuffering: this.isBuffering,
      backend: this.backend,
      qualityLabel: this.qualityLabel,
      queue: this.#queueCopy(),
      queueIndex: this.queueIndex,
      repeat: this.repeat,
      shuffle: this.shuffle,
      autoplay: this.autoplay,
      segmentLeadIn: this.segmentLeadIn,
      keepScreenAwake: this.keepScreenAwake,
      volume: this.volume
    };
  }

  // Snapshots are emitted several times per second while playing; reuse one
  // queue copy until the queue actually changes instead of reallocating.
  #queueCopy() {
    if (!this.queueSnapshotCache) this.queueSnapshotCache = [...this.queue];
    return this.queueSnapshotCache;
  }

  // Absolute media time for this frame. Local audio reads the element clock
  // directly (it is exact and cheap); YouTube only reports a cached value a
  // few times a second, so it is extrapolated from the last monitor read.
  positionAt(now = nowMs()) {
    const track = this.currentTrack;
    if (!track) return 0;
    const end = Math.max(track.start, track.end);
    const audio = this.localAudio;
    if (this.backend === "local" && this.isPlaying && !this.localLoad && audio.readyState >= HAVE_METADATA && !audio.seeking) {
      const time = audio.currentTime;
      if (Number.isFinite(time)) return clamp(time, track.start, end);
    }
    return interpolatePosition(this.clock, now, {
      playing: this.isPlaying && !this.isBuffering && !this.adWatch.active,
      start: track.start,
      end
    });
  }

  setQueue(trackKeys, activeKey = null) {
    this.queue = [...new Set((trackKeys || []).filter((key) => this.resolveTrack(key)))];
    this.queueSnapshotCache = null;
    const key = activeKey || this.currentTrack?.key;
    this.queueIndex = key ? this.queue.indexOf(key) : -1;
    this.emit("queuechange", this.snapshot());
  }

  addToQueue(trackKey, options = {}) {
    if (!this.resolveTrack(trackKey) || trackKey === this.currentTrack?.key) return false;
    const nextQueue = queueWithAddedTrack(this.queue, this.queueIndex, trackKey, options);
    if (nextQueue.join("\n") === this.queue.join("\n")) return false;
    this.setQueue(nextQueue, this.currentTrack?.key);
    return true;
  }

  playNext(trackKey) {
    return this.addToQueue(trackKey, { next: true });
  }

  removeFromQueue(trackKey) {
    const nextQueue = queueWithoutTrack(this.queue, this.queueIndex, trackKey);
    if (nextQueue.join("\n") === this.queue.join("\n")) return false;
    this.setQueue(nextQueue, this.currentTrack?.key);
    return true;
  }

  moveInQueue(trackKey, direction) {
    const nextQueue = queueWithMovedTrack(this.queue, this.queueIndex, trackKey, direction);
    if (nextQueue.join("\n") === this.queue.join("\n")) return false;
    this.setQueue(nextQueue, this.currentTrack?.key);
    return true;
  }

  clearUpcoming() {
    const nextQueue = this.queueIndex >= 0 ? this.queue.slice(0, this.queueIndex + 1) : [];
    if (nextQueue.length === this.queue.length) return false;
    this.setQueue(nextQueue, this.currentTrack?.key);
    return true;
  }

  async loadByKey(trackKey, options = {}) {
    const track = this.resolveTrack(trackKey);
    if (!track) throw new PlaybackError("That song isn't in your library anymore.", "unknown");
    const source = this.resolveSource(track.sourceId);
    if (!source) throw new PlaybackError("That album could not be found.", "unknown");
    return this.load(track, source, options);
  }

  // Resolves true once the track is loaded (and playing when autoplay is on),
  // false when a newer load superseded it. Failures emit "error" and reject
  // with a PlaybackError whose `reported` flag says the event already fired.
  async load(track, source, { autoplay = true, resumePosition = null, queue = null, preciseStart = false } = {}) {
    if (!track || !source) throw new PlaybackError("Choose a song to play.", "unknown");
    this.loadAbort?.abort();
    const loadAbort = new AbortController();
    this.loadAbort = loadAbort;
    const { signal } = loadAbort;

    this.currentTrack = track;
    this.currentSource = source;
    let queueIndexMoved = false;
    if (queue) {
      this.setQueue(queue, track.key);
    } else if (!this.queue.includes(track.key)) {
      this.setQueue(source.tracks.map((item) => item.key), track.key);
    } else {
      const index = this.queue.indexOf(track.key);
      queueIndexMoved = index !== this.queueIndex;
      this.queueIndex = index;
    }

    this.segmentEndedLock = false;
    this.#clearAdWatch();
    const hasResumePosition = isResumePosition(resumePosition);
    const requestedPosition = clamp(
      hasResumePosition ? Number(resumePosition) : track.start,
      track.start,
      Math.max(track.start, track.end - 0.2)
    );
    this.#setClock(this.#playbackStartFor(source, track, requestedPosition, { hasResumePosition, preciseStart }));
    this.#showBackend(source.provider);
    this.#updateMediaMetadata();
    this.emit("trackchange", this.snapshot());
    if (queueIndexMoved) this.emit("queuechange", this.snapshot());
    this.#emitProgress(true);

    try {
      if (source.provider === "youtube") {
        await this.#loadYouTube(source, this.currentTime, autoplay, signal);
      } else if (source.provider === "local") {
        await this.#loadLocal(source, this.currentTime, autoplay, signal);
      } else {
        throw new PlaybackError("This recording can't be played here.", "unsupported");
      }
      if (signal.aborted) return false;
      this.#startMonitor();
      return true;
    } catch (error) {
      if (signal.aborted || error?.stale) return false;
      const failure = error instanceof PlaybackError
        ? error
        : new PlaybackError(error?.message || playbackErrorMessage("unknown"), "unknown", { cause: error });
      this.isPlaying = false;
      this.#setBuffering(false);
      this.#updateMediaPlaybackState();
      this.emit("statechange", this.snapshot());
      this.#emitError(failure);
      throw failure;
    }
  }

  async #loadYouTube(source, startAt, autoplay, signal) {
    this.localAudio.pause();
    if (!source.youtubeId) throw new PlaybackError("This recording has no YouTube video to play.", "unsupported");
    let YT;
    try {
      YT = await loadYouTubeApi();
    } catch (error) {
      throw new PlaybackError("YouTube couldn't be reached. Check your connection and try again.", "network", { cause: error });
    }
    if (signal.aborted) throw staleLoad();
    this.pendingYouTubeLoad = {
      videoId: source.youtubeId,
      startAt,
      endAt: this.#continuousRunEndForCurrentTrack(),
      autoplay
    };
    this.#setBuffering(Boolean(autoplay));
    if (!this.youtubePlayer) {
      if (!document.getElementById(this.youtubeContainerId)) {
        throw new PlaybackError("The video player isn't ready yet. Try again in a moment.", "unknown");
      }
      this.youtubePlayer = new YT.Player(this.youtubeContainerId, {
        width: "100%",
        height: "100%",
        videoId: source.youtubeId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          ...(globalThis.location?.origin && globalThis.location.origin !== "null" ? { origin: globalThis.location.origin } : {})
        },
        events: {
          onReady: (event) => {
            this.youtubeReady = true;
            event.target.setVolume(Math.round(this.volume * 100));
            this.#applyPendingYouTubeLoad();
          },
          onStateChange: (event) => this.#onYouTubeState(event),
          onPlaybackQualityChange: (event) => {
            this.qualityLabel = youtubeQualityLabel(event.data);
            this.emit("qualitychange", this.snapshot());
          },
          onError: (event) => this.#onYouTubeError(event.data)
        }
      });
    } else if (this.youtubeReady) {
      this.#applyPendingYouTubeLoad();
    }
    this.qualityLabel = "Playing from YouTube";
    this.emit("qualitychange", this.snapshot());
  }

  #onYouTubeError(code) {
    if (this.backend !== "youtube") return;
    const kind = errorKindForYouTubeCode(code);
    const messages = {
      2: "YouTube didn't accept this video link.",
      5: "YouTube couldn't play this video right now.",
      100: "This video is no longer available on YouTube.",
      101: "This video's owner doesn't allow it to play here. Open it on YouTube instead.",
      150: "This video's owner doesn't allow it to play here. Open it on YouTube instead."
    };
    this.isPlaying = false;
    this.#setBuffering(false);
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
    this.#emitError(new PlaybackError(messages[code] || `YouTube playback error (${code}).`, kind));
  }

  #playbackStartFor(source, track, requestedPosition, { hasResumePosition, preciseStart }) {
    const leadIn = clamp(Number(this.segmentLeadIn) || 0, 0, 5);
    const canLeadIn = source.provider === "youtube" && !hasResumePosition && !preciseStart && track.start > 0 && leadIn > 0;
    return canLeadIn ? Math.max(0, requestedPosition - leadIn) : requestedPosition;
  }

  #continuousRunEndForCurrentTrack() {
    const enabled = this.autoplay && this.repeat !== "one" && !this.shuffle;
    return continuousRunEnd(this.queue, this.queueIndex, this.resolveTrack, { enabled }) || this.currentTrack.end;
  }

  #applyPendingYouTubeLoad() {
    if (!this.youtubeReady || !this.pendingYouTubeLoad) return;
    const request = this.pendingYouTubeLoad;
    this.pendingYouTubeLoad = null;
    // Every loadVideoById is a fresh ad opportunity, so seek inside the
    // already-loaded upload whenever the segment monitor can guard the
    // boundary itself: the tab is visible (timers unthrottled) and the new
    // range fits inside the endSeconds bound from the last real load.
    const canSeekInPlace = request.autoplay
      && this.youtubeVideoId === request.videoId
      && document.visibilityState === "visible"
      && Number.isFinite(this.appliedYouTubeEnd)
      && request.endAt <= this.appliedYouTubeEnd + 0.01;
    this.youtubeVideoId = request.videoId;
    if (canSeekInPlace) {
      this.youtubePlayer.seekTo(request.startAt, true);
      this.youtubePlayer.playVideo();
    } else if (request.autoplay) {
      this.appliedYouTubeEnd = request.endAt;
      this.youtubePlayer.loadVideoById({
        videoId: request.videoId,
        startSeconds: request.startAt,
        endSeconds: request.endAt
      });
    } else {
      this.appliedYouTubeEnd = request.endAt;
      this.youtubePlayer.cueVideoById({
        videoId: request.videoId,
        startSeconds: request.startAt,
        endSeconds: request.endAt
      });
    }
    this.youtubePlayer.setVolume(Math.round(this.volume * 100));
  }

  #onYouTubeState(event) {
    const YT = globalThis.YT;
    if (!YT || this.backend !== "youtube") return;
    const { PLAYING, PAUSED, CUED, ENDED, BUFFERING } = YT.PlayerState;
    const time = this.youtubePlayer?.getCurrentTime?.();
    if (Number.isFinite(time)) this.#setClock(time);
    if (event.data === PLAYING) {
      this.isPlaying = true;
      this.#setBuffering(false);
      // Re-assert our metadata as playback starts so the media notification
      // shows the segmented track, not the iframe's own video title.
      this.#updateMediaMetadata();
      this.#startMonitor();
    }
    if (event.data === BUFFERING) this.#setBuffering(true);
    if ([PAUSED, CUED, ENDED].includes(event.data)) {
      this.isPlaying = false;
      this.#setBuffering(false);
    }
    if (event.data === ENDED && this.currentTrack) {
      this.#syncContinuousTrackAtCurrentTime();
      this.#handleSegmentEnd();
    }
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
  }

  async #loadLocal(source, startAt, autoplay, signal) {
    this.youtubePlayer?.pauseVideo?.();
    // The intent is shared with play()/pause()/seekAbsolute() so taps made
    // while a stream is still opening are honored once it is ready.
    const intent = { signal, autoplay: Boolean(autoplay), startAt, lastActivity: NaN };
    this.localLoad = intent;
    const watchdog = this.#watchLocalLoad(intent);
    try {
      const mode = await this.#assignLocalSource(source, signal);
      watchdog.start();
      this.localAudio.volume = this.volume;
      this.emit("qualitychange", this.snapshot());
      if (mode !== "ready") {
        if (intent.autoplay) this.#setBuffering(true);
        await watchdog.guard(this.#waitForMetadata(signal, { reload: mode === "load" }));
      }
      await watchdog.guard(this.#seekLocal(intent.startAt, signal));
      if (intent.autoplay) await watchdog.guard(this.#playLocal(signal));
      else if (!this.localAudio.paused) this.localAudio.pause();
    } catch (error) {
      if (signal.aborted || error?.stale) throw staleLoad();
      if (error instanceof PlaybackError) throw error;
      throw await this.#classifyLocalFailure(this.localAudio.error, error);
    } finally {
      watchdog.stop();
      if (this.localLoad === intent) this.localLoad = null;
    }
    if (signal.aborted) throw staleLoad();
    this.#syncLocalPlaying();
  }

  // "ready": the element already holds this stream (continuous same-source
  // playback, no reload); "wait": it is still opening it; "load": new src.
  async #assignLocalSource(source, signal) {
    const audio = this.localAudio;
    const healthy = !audio.error && Boolean(audio.currentSrc || audio.src);
    const modeFor = () => (audio.readyState >= HAVE_METADATA ? "ready" : audio.networkState === NETWORK_LOADING ? "wait" : "load");

    if (source.assetId) {
      let asset = null;
      try {
        asset = await this.getAudioAsset(source.assetId);
      } catch (error) {
        throw new PlaybackError("That audio file couldn't be opened on this device.", "unknown", { cause: error });
      }
      if (signal.aborted) throw staleLoad();
      if (asset?.blob) {
        this.qualityLabel = "Your audio file";
        if (healthy && this.localAssetId === source.assetId && this.localObjectUrl) {
          const mode = modeFor();
          if (mode !== "load") return mode;
        }
        this.#beginStreamSwap();
        this.#revokeLocalObjectUrl();
        this.localObjectUrl = URL.createObjectURL(asset.blob);
        this.localAssetId = source.assetId;
        this.localSourceUrl = null;
        audio.src = this.localObjectUrl;
        return "load";
      }
    }

    if (source.audioUrl) {
      const url = absoluteUrl(source.audioUrl);
      this.qualityLabel = "Your library";
      if (healthy && !this.localAssetId && this.localSourceUrl === url) {
        const mode = modeFor();
        if (mode !== "load") return mode;
      }
      this.#beginStreamSwap();
      let streamUrl;
      try {
        streamUrl = await this.ensureStreamable(url);
      } catch (error) {
        if (signal.aborted) throw staleLoad();
        throw this.#streamFailure(error);
      }
      if (signal.aborted) throw staleLoad();
      this.#revokeLocalObjectUrl();
      this.localAssetId = null;
      this.localSourceUrl = url;
      audio.src = streamUrl || url;
      return "load";
    }

    throw new PlaybackError("That audio file isn't on this device. Import it again from Settings.", "unsupported");
  }

  // A request the network never answers (a dead connection, a captive portal)
  // leaves the element waiting without ever firing "error". While someone is
  // waiting for sound, a stretch with no network activity fails the load: the
  // spinner stops, the error shows, and the next tap on play starts a fresh
  // request. A paused load (a restored session) may sit idle without failing.
  #watchLocalLoad(intent) {
    const audio = this.localAudio;
    const listeners = new AbortController();
    const touch = () => {
      intent.lastActivity = nowMs();
    };
    let timer = 0;
    let fail = () => {};
    const stalled = new Promise((_, reject) => {
      fail = reject;
    });
    stalled.catch(() => {}); // only observed through guard()
    const pollMs = clamp(this.stallTimeoutMs / 4, 10, 1000);
    const check = () => {
      if (intent.signal.aborted) return;
      if (intent.autoplay && nowMs() - intent.lastActivity >= this.stallTimeoutMs) {
        this.#abandonLocalStream();
        fail(new PlaybackError(playbackErrorMessage("network"), "network"));
        return;
      }
      timer = setTimeout(check, pollMs);
    };
    return {
      // Called once the element has its new source: opening the stream (a
      // service-worker-less download, say) has its own timeout in cloud.js.
      start: () => {
        touch();
        for (const type of LOAD_ACTIVITY_EVENTS) audio.addEventListener(type, touch, { signal: listeners.signal });
        timer = setTimeout(check, pollMs);
      },
      guard: (promise) => Promise.race([promise, stalled]),
      stop: () => {
        clearTimeout(timer);
        listeners.abort();
      }
    };
  }

  // Drops the element's stream so its request is cancelled and the next play
  // opens a new one instead of waiting on the dead one.
  #abandonLocalStream() {
    const audio = this.localAudio;
    this.localSourceUrl = null;
    try {
      audio.removeAttribute?.("src");
      audio.load?.();
    } catch { /* element already empty */ }
    this.#revokeLocalObjectUrl();
  }

  // Stop the previous recording now: opening the next stream can take a
  // moment and it must not keep playing underneath the new track's title.
  #beginStreamSwap() {
    if (!this.localAudio.paused) this.localAudio.pause();
    if (this.localLoad?.autoplay) this.#setBuffering(true);
  }

  #waitForMetadata(signal, { reload }) {
    const audio = this.localAudio;
    return new Promise((resolve, reject) => {
      const cleanup = new AbortController();
      const settle = (fn) => () => {
        cleanup.abort();
        fn();
      };
      audio.addEventListener("loadedmetadata", settle(resolve), { signal: cleanup.signal });
      audio.addEventListener("error", settle(() => reject(mediaFailure())), { signal: cleanup.signal });
      signal.addEventListener("abort", settle(() => reject(staleLoad())), { signal: cleanup.signal });
      if (reload) audio.load();
      else if (audio.readyState >= HAVE_METADATA) settle(resolve)();
    });
  }

  async #seekLocal(startAt, signal) {
    const audio = this.localAudio;
    const target = Math.max(0, Number(startAt) || 0);
    if (target < 0.05) {
      audio.currentTime = target;
      return;
    }
    if (Math.abs(audio.currentTime - target) < 0.5) return;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise((resolve, reject) => {
        const cleanup = new AbortController();
        const settle = (fn) => () => {
          clearTimeout(timer);
          cleanup.abort();
          fn();
        };
        const timer = setTimeout(settle(resolve), SEEK_TIMEOUT_MS);
        audio.addEventListener("seeked", settle(resolve), { signal: cleanup.signal });
        audio.addEventListener("error", settle(() => reject(mediaFailure())), { signal: cleanup.signal });
        signal?.addEventListener("abort", settle(() => reject(staleLoad())), { signal: cleanup.signal });
        audio.currentTime = target;
      });
      if (Math.abs(audio.currentTime - target) < 0.5) return;
    }

    throw new PlaybackError("This song's start couldn't be reached. Check your connection and try again.", "network");
  }

  async #playLocal(signal) {
    try {
      await this.localAudio.play();
      return true;
    } catch (error) {
      // AbortError: a pause() or a newer load interrupted the request.
      if (signal?.aborted || error?.name === "AbortError") return false;
      // NotAllowedError: no user gesture yet (e.g. a restored session). The
      // track stays loaded and paused; the next tap on play starts it.
      if (error?.name === "NotAllowedError") {
        this.isPlaying = false;
        this.#setBuffering(false);
        this.#updateMediaPlaybackState();
        this.emit("statechange", this.snapshot());
        return false;
      }
      throw error;
    }
  }

  #syncLocalPlaying() {
    const audio = this.localAudio;
    const playing = !audio.paused && !audio.ended;
    if (!playing) this.#setBuffering(false);
    if (playing === this.isPlaying) return;
    this.isPlaying = playing;
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
  }

  #localNeedsReload() {
    const audio = this.localAudio;
    return Boolean(audio.error)
      || audio.networkState === NETWORK_NO_SOURCE
      || audio.networkState === NETWORK_EMPTY
      || !audio.src;
  }

  #reloadCurrent({ autoplay = true } = {}) {
    const track = this.currentTrack;
    const inQueue = this.queue.includes(track.key);
    return this.load(track, this.currentSource, {
      autoplay,
      resumePosition: this.currentTime,
      preciseStart: true,
      queue: inQueue ? null : [...this.queue]
    }).catch(() => false);
  }

  #streamFailure(error) {
    const status = Number(error?.status ?? error?.httpStatus) || 0;
    let kind = "unknown";
    if (PLAYBACK_ERROR_KINDS.includes(error?.kind)) kind = error.kind;
    else if (status > 0) kind = errorKindForStatus(status);
    else if (error?.name === "TypeError" || error?.name === "TimeoutError" || (typeof navigator !== "undefined" && navigator.onLine === false)) kind = "network";
    return new PlaybackError(playbackErrorMessage(kind, status), kind, { cause: error, status });
  }

  // Remote streams are probed so a 401 reads as "connect your library" rather
  // than a corrupt file; blob sources are already on the device, so the media
  // error code alone is trustworthy.
  async #classifyLocalFailure(mediaError, cause) {
    const isMediaFailure = Boolean(mediaError) || Boolean(cause?.media) || cause?.name === "NotSupportedError";
    if (!isMediaFailure) {
      const kind = typeof navigator !== "undefined" && navigator.onLine === false ? "network" : "unknown";
      return new PlaybackError(kind === "unknown" && cause?.message ? cause.message : playbackErrorMessage(kind), kind, { cause });
    }
    const assigned = this.localAudio.currentSrc || this.localAudio.src || "";
    if (this.localSourceUrl && /^https?:/i.test(assigned)) {
      const { kind, status } = await classifyAudioUrl(this.localSourceUrl, { fetchImpl: this.fetchImpl });
      return new PlaybackError(playbackErrorMessage(kind, status), kind, { cause: cause || mediaError, status });
    }
    const mediaKind = errorKindForMediaCode(mediaError?.code);
    const kind = mediaKind === "unknown" ? "decode" : mediaKind;
    return new PlaybackError(playbackErrorMessage(kind), kind, { cause: cause || mediaError });
  }

  async #onLocalMediaError() {
    const audio = this.localAudio;
    const mediaError = audio.error;
    // During a load, the load path owns the failure (and reports it once).
    if (this.backend !== "local" || this.localLoad) return;
    if (!mediaError || mediaError.code === MEDIA_ERR_ABORTED || !(audio.currentSrc || audio.src)) return;
    const signal = this.loadAbort?.signal;
    const failure = await this.#classifyLocalFailure(mediaError);
    if (signal?.aborted || this.backend !== "local" || this.localLoad) return;
    this.isPlaying = false;
    this.#setBuffering(false);
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
    this.#emitError(failure);
  }

  #bindLocalAudio() {
    const audio = this.localAudio;
    const on = (type, handler) => audio.addEventListener(type, handler, { signal: this.listeners.signal });
    const active = () => this.backend === "local";
    const starving = () => !audio.paused && !audio.ended && audio.readyState < HAVE_FUTURE_DATA;

    on("play", () => {
      if (!active()) return;
      this.isPlaying = true;
      this.#setBuffering(starving());
      this.#updateMediaMetadata();
      this.#updateMediaPlaybackState();
      this.#startMonitor();
      this.emit("statechange", this.snapshot());
    });
    on("playing", () => {
      if (!active()) return;
      this.#setBuffering(false);
      if (!this.localLoad) this.#setClock(audio.currentTime);
    });
    on("pause", () => {
      // A load that swaps streams pauses the old one; it settles the final
      // state itself, so the UI does not flash "paused" between tracks.
      if (!active() || this.localLoad) return;
      this.isPlaying = false;
      this.#setBuffering(false);
      this.#setClock(audio.currentTime);
      this.#updateMediaPlaybackState();
      this.emit("statechange", this.snapshot());
    });
    on("waiting", () => {
      if (active() && !audio.paused) this.#setBuffering(true);
    });
    on("stalled", () => {
      if (active() && starving()) this.#setBuffering(true);
    });
    on("canplay", () => {
      if (active() && !this.localLoad && !starving()) this.#setBuffering(false);
    });
    on("seeked", () => {
      if (active() && !this.localLoad) this.#setBuffering(starving());
    });
    on("timeupdate", () => this.#monitor());
    on("ended", () => {
      if (!active() || this.localLoad) return;
      this.#setClock(audio.currentTime || this.currentSource?.duration || this.currentTime);
      this.#syncContinuousTrackAtCurrentTime();
      this.#handleSegmentEnd();
    });
    on("error", () => {
      this.#onLocalMediaError();
    });
  }

  #resolveYouTubeWrap() {
    return this.youtubeWrap || globalThis.document?.getElementById(`${this.youtubeContainerId}-wrap`) || null;
  }

  #showBackend(provider) {
    const changed = this.backend !== provider;
    this.backend = provider;
    const wrap = this.#resolveYouTubeWrap();
    if (wrap) wrap.hidden = provider !== "youtube";
    if (changed) this.emit("backendchange", this.snapshot());
  }

  #setBuffering(value) {
    const buffering = Boolean(value);
    if (buffering === this.isBuffering) return;
    this.isBuffering = buffering;
    if (!buffering) this.#setClock(this.#readBackendTime() ?? this.currentTime);
    this.emit("buffering", { ...this.snapshot(), buffering });
  }

  #readBackendTime() {
    if (this.backend === "local" && !this.localLoad && this.localAudio.readyState >= HAVE_METADATA) {
      const time = this.localAudio.currentTime;
      return Number.isFinite(time) ? time : null;
    }
    if (this.backend === "youtube" && this.youtubeReady) {
      const time = this.youtubePlayer?.getCurrentTime?.();
      return Number.isFinite(time) ? time : null;
    }
    return null;
  }

  #setClock(time) {
    const value = Number(time);
    if (!Number.isFinite(value)) return;
    this.currentTime = value;
    this.clock = { time: value, at: nowMs() };
  }

  #emitProgress(force = false) {
    const now = nowMs();
    const last = this.lastProgress;
    const key = this.currentTrack?.key || null;
    if (!force) {
      if (now - last.at < PROGRESS_MIN_GAP_MS) return;
      if (!this.isPlaying && last.time === this.currentTime && last.key === key) return;
    }
    this.lastProgress = { at: now, time: this.currentTime, key };
    this.emit("progress", this.snapshot());
  }

  #startMonitor() {
    clearTimeout(this.monitorTimer);
    const tick = () => {
      this.#monitor();
      this.monitorTimer = setTimeout(tick, this.#monitorDelay());
    };
    this.monitorTimer = setTimeout(tick, this.#monitorDelay());
  }

  // ~4 ticks a second while playing (progress events + boundary checks);
  // near a segment end the next tick lands on the boundary itself so a
  // stop or cross-source jump happens on time. Idle: a slow keep-alive.
  #monitorDelay() {
    if (!this.isPlaying || !this.currentTrack) return IDLE_MONITOR_MS;
    const untilBoundaryMs = (this.currentTrack.end - SEGMENT_END_EPSILON - this.positionAt()) * 1000;
    return Math.round(clamp(untilBoundaryMs + 5, MIN_MONITOR_MS, PROGRESS_INTERVAL_MS));
  }

  #monitor({ forceProgress = false } = {}) {
    if (!this.currentTrack) return;
    try {
      if (this.backend === "youtube" && this.youtubeReady) {
        const time = this.youtubePlayer.getCurrentTime?.();
        if (Number.isFinite(time)) {
          this.#setClock(time);
          this.#watchForAd(time, this.youtubePlayer.getPlayerState?.());
        }
        const reportedQuality = this.youtubePlayer.getPlaybackQuality?.();
        if (reportedQuality && reportedQuality !== "unknown") {
          const label = youtubeQualityLabel(reportedQuality);
          if (label !== this.qualityLabel) {
            this.qualityLabel = label;
            this.emit("qualitychange", this.snapshot());
          }
        }
      } else if (this.backend === "local" && !this.localLoad) {
        // While a load is in flight the element still reports the previous
        // stream's clock; the load's own start position stays authoritative.
        const audio = this.localAudio;
        if (audio.readyState >= HAVE_METADATA) this.#setClock(audio.currentTime);
        if (this.isPlaying && !audio.paused) {
          const starving = !audio.ended && audio.readyState < HAVE_FUTURE_DATA && !audio.seeking;
          if (starving !== this.isBuffering && !(this.isBuffering && audio.seeking)) this.#setBuffering(starving);
        }
      }
      this.#syncContinuousTrackAtCurrentTime();
      if (!this.segmentEndedLock && this.isPlaying && !this.localLoad && this.currentTime >= this.currentTrack.end - SEGMENT_END_EPSILON) {
        this.#handleSegmentEnd();
      }
      this.#updateMediaPosition();
      this.#emitProgress(forceProgress);
    } catch (error) {
      console.debug("Playback monitor skipped a tick.", error);
    }
  }

  async #handleSegmentEnd() {
    if (this.segmentEndedLock || !this.currentTrack) return;
    const advanced = this.#syncContinuousTrackAtCurrentTime();
    if (advanced && this.currentTime < this.currentTrack.end - SEGMENT_END_EPSILON) return;
    this.segmentEndedLock = true;
    this.emit("segmentended", this.snapshot());
    try {
      if (this.repeat === "one") {
        await this.seekAbsolute(this.currentTrack.start);
        await this.play();
        this.segmentEndedLock = false;
        return;
      }
      if (this.autoplay) {
        const moved = await this.next({ fromEnd: true });
        if (moved) return;
      }
      await this.pause();
      this.#setClock(this.currentTrack.end);
      this.#emitProgress(true);
    } catch (error) {
      // load() already reported the failure through the "error" event.
      if (!error?.reported) console.debug("Segment transition failed.", error);
    }
  }

  #syncContinuousTrackAtCurrentTime() {
    if (!this.autoplay || this.repeat === "one" || this.shuffle || this.queueIndex < 0 || !this.currentTrack) return false;
    const targetIndex = continuousTrackIndexAtTime(this.queue, this.queueIndex, this.currentTime, this.resolveTrack);
    if (targetIndex <= this.queueIndex) return false;

    this.emit("segmentended", this.snapshot());
    const track = this.resolveTrack(this.queue[targetIndex]);
    const source = track && this.resolveSource(track.sourceId);
    if (!track || !source) return false;
    this.queueIndex = targetIndex;
    this.currentTrack = track;
    this.currentSource = source;
    this.segmentEndedLock = false;
    this.#updateMediaMetadata();
    this.#updateMediaPosition();
    this.emit("trackchange", this.snapshot());
    this.emit("queuechange", this.snapshot());
    this.#emitProgress(true);
    return true;
  }

  async play() {
    if (!this.currentTrack) return false;
    // Parked at the end of the queue: play means "again", not an instant
    // re-trigger of the end-of-track pause.
    const parkedAtEnd = this.segmentEndedLock && !this.localLoad
      && this.positionAt() >= this.currentTrack.end - SEGMENT_END_EPSILON - 0.05;
    this.segmentEndedLock = false;
    if (parkedAtEnd) await this.seekAbsolute(this.currentTrack.start);
    if (this.backend === "youtube") {
      if (!this.youtubeReady) {
        if (this.pendingYouTubeLoad) this.pendingYouTubeLoad.autoplay = true;
        return false;
      }
      this.youtubePlayer.playVideo();
      this.#updateMediaPlaybackState("playing");
      return true;
    }
    if (this.backend !== "local") return false;
    if (this.localLoad) {
      const pending = this.localLoad;
      // Paused while its stream went quiet for longer than a load may: start
      // over with a fresh request instead of waiting on the dead one.
      if (!pending.autoplay && nowMs() - pending.lastActivity >= this.stallTimeoutMs) {
        this.loadAbort?.abort();
        this.#abandonLocalStream();
        return this.#reloadCurrent({ autoplay: true });
      }
      pending.autoplay = true;
      this.#setBuffering(true);
      return true;
    }
    // A failed or emptied element (bad token since fixed, network back,
    // stream never opened) reopens in place at the current position.
    if (this.#localNeedsReload()) return this.#reloadCurrent({ autoplay: true });
    try {
      await this.localAudio.play();
      return true;
    } catch (error) {
      if (error?.name === "AbortError") return false;
      if (error?.name === "NotAllowedError") {
        this.#syncLocalPlaying();
        return false;
      }
      // Media failures surface through the element's "error" event.
      if (error?.name === "NotSupportedError" || this.localAudio.error) return false;
      this.#emitError(new PlaybackError(error?.message || playbackErrorMessage("unknown"), "unknown", { cause: error }));
      return false;
    }
  }

  async pause() {
    if (this.localLoad) this.localLoad.autoplay = false;
    if (this.pendingYouTubeLoad) this.pendingYouTubeLoad.autoplay = false;
    if (this.backend === "youtube") this.youtubePlayer?.pauseVideo?.();
    if (this.backend === "local") this.localAudio.pause();
    const time = this.#readBackendTime();
    if (time !== null) this.#setClock(time);
    this.isPlaying = false;
    this.#setBuffering(false);
    this.#updateMediaPlaybackState("paused");
    this.emit("statechange", this.snapshot());
  }

  async toggle() {
    return this.isPlaying ? this.pause() : this.play();
  }

  async seekAbsolute(seconds, allowSeekAhead = true) {
    if (!this.currentTrack) return;
    const requested = Number(seconds);
    if (!Number.isFinite(requested)) return;
    const target = clamp(requested, this.currentTrack.start, Math.max(this.currentTrack.start, this.currentTrack.end - 0.05));
    this.segmentEndedLock = false;
    if (this.backend === "youtube") this.youtubePlayer?.seekTo?.(target, allowSeekAhead);
    if (this.backend === "local") {
      if (this.localLoad) this.localLoad.startAt = target;
      else this.localAudio.currentTime = target;
    }
    this.#setClock(target);
    this.#updateMediaPosition();
    this.#emitProgress(true);
  }

  async seekRelative(seconds, allowSeekAhead = true) {
    if (!this.currentTrack) return;
    return this.seekAbsolute(this.currentTrack.start + clamp(Number(seconds) || 0, 0, this.currentTrack.end - this.currentTrack.start), allowSeekAhead);
  }

  async previous() {
    if (!this.currentTrack) return false;
    if (this.positionAt() - this.currentTrack.start > PREVIOUS_RESTART_SECONDS) {
      await this.seekAbsolute(this.currentTrack.start);
      return true;
    }
    const index = this.#previousQueueIndex();
    if (index < 0) {
      await this.seekAbsolute(this.currentTrack.start);
      return false;
    }
    return this.#loadQueueIndex(index);
  }

  async next({ fromEnd = false } = {}) {
    if (this.queue.length === 0) return false;
    const index = this.#nextQueueIndex();
    if (index < 0) {
      if (fromEnd) await this.pause();
      return false;
    }
    return this.#loadQueueIndex(index);
  }

  #nextQueueIndex() {
    if (this.queue.length === 0) return -1;
    if (this.shuffle && this.queue.length > 1) {
      let next = this.queueIndex;
      while (next === this.queueIndex) next = Math.floor(Math.random() * this.queue.length);
      return next;
    }
    const next = this.queueIndex + 1;
    if (next < this.queue.length) return next;
    return this.repeat === "all" ? 0 : -1;
  }

  #previousQueueIndex() {
    if (this.queue.length === 0) return -1;
    const previous = this.queueIndex - 1;
    if (previous >= 0) return previous;
    return this.repeat === "all" ? this.queue.length - 1 : -1;
  }

  async #loadQueueIndex(index) {
    const key = this.queue[index];
    const track = this.resolveTrack(key);
    if (!track) return false;
    this.queueIndex = index;
    try {
      return (await this.loadByKey(key, { autoplay: true })) !== false;
    } catch (error) {
      // Already surfaced through the "error" event; transport buttons and
      // lock-screen controls should not also see a rejected promise.
      if (error?.reported) return false;
      throw error;
    }
  }

  setVolume(value, emit = true) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.volume = clamp(parsed, 0, 1);
    this.localAudio.volume = this.volume;
    this.youtubePlayer?.setVolume?.(Math.round(this.volume * 100));
    if (emit) this.emit("volumechange", this.snapshot());
  }

  setRepeat(mode) {
    this.repeat = ["off", "all", "one"].includes(mode) ? mode : "off";
    this.emit("optionschange", this.snapshot());
  }

  cycleRepeat() {
    const order = ["off", "all", "one"];
    this.setRepeat(order[(order.indexOf(this.repeat) + 1) % order.length]);
  }

  setShuffle(enabled) {
    this.shuffle = Boolean(enabled);
    this.emit("optionschange", this.snapshot());
  }

  setAutoplay(enabled) {
    this.autoplay = Boolean(enabled);
    this.emit("optionschange", this.snapshot());
  }

  setSegmentLeadIn(seconds) {
    const parsed = Number(seconds);
    this.segmentLeadIn = Number.isFinite(parsed) ? clamp(parsed, 0, 5) : 0;
    this.emit("optionschange", this.snapshot());
  }

  // The IFrame API exposes no ad state, but during an ad break the content
  // clock freezes while the player still reports PLAYING. Watching for that
  // stall lets the UI tell the listener an ad is running so they can reach
  // YouTube's own Skip button. Nothing here blocks or skips the ad itself.
  #watchForAd(time, playerState) {
    const watch = this.adWatch;
    if (playerState !== globalThis.YT?.PlayerState?.PLAYING) {
      this.#clearAdWatch();
      watch.lastTime = time;
      return;
    }
    if (Math.abs(time - watch.lastTime) > 0.2) {
      watch.lastTime = time;
      watch.stalledSince = 0;
      if (watch.active) {
        watch.active = false;
        this.emit("adbreak", { active: false });
      }
      return;
    }
    const now = Date.now();
    if (!watch.stalledSince) {
      watch.stalledSince = now;
    } else if (!watch.active && now - watch.stalledSince > 3500) {
      watch.active = true;
      this.emit("adbreak", { active: true });
    }
  }

  #clearAdWatch() {
    this.adWatch.stalledSince = 0;
    if (this.adWatch.active) {
      this.adWatch.active = false;
      this.emit("adbreak", { active: false });
    }
  }

  // Fullscreen on the player wrap. On Android, swiping home from fullscreen
  // moves the video into a system picture-in-picture window, which is the
  // supported way to keep a YouTube source playing while using other apps.
  async enterVideoFullscreen() {
    const wrap = this.#resolveYouTubeWrap();
    if (this.backend !== "youtube" || !wrap) return false;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (wrap.requestFullscreen) {
        await wrap.requestFullscreen();
      } else if (wrap.webkitRequestFullscreen) {
        wrap.webkitRequestFullscreen();
      } else {
        return false;
      }
      return true;
    } catch (error) {
      this.#emitError(new PlaybackError("The browser blocked fullscreen for the video.", "unknown", { cause: error }));
      return false;
    }
  }

  setKeepScreenAwake(enabled) {
    this.keepScreenAwake = Boolean(enabled);
    this.#syncWakeLock();
    this.emit("optionschange", this.snapshot());
  }

  // Holds a screen wake lock while a YouTube source plays so the phone does
  // not auto-lock mid-session. Local audio does not need it: the native audio
  // element keeps playing with the screen off.
  async #syncWakeLock() {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator) || this.wakeLockPending) return;
    const wanted = this.keepScreenAwake && this.isPlaying && this.backend === "youtube" && document.visibilityState === "visible";
    if (wanted === Boolean(this.wakeLockSentinel)) return;
    this.wakeLockPending = true;
    try {
      if (wanted) {
        const sentinel = await navigator.wakeLock.request("screen");
        sentinel.addEventListener("release", () => {
          if (this.wakeLockSentinel === sentinel) this.wakeLockSentinel = null;
        });
        this.wakeLockSentinel = sentinel;
      } else {
        const sentinel = this.wakeLockSentinel;
        this.wakeLockSentinel = null;
        await sentinel.release();
      }
    } catch (error) {
      console.debug("Screen wake lock unavailable.", error);
      if (wanted) this.wakeLockSentinel = null;
    } finally {
      this.wakeLockPending = false;
    }
  }

  syncPlaybackState() {
    if (this.backend === "youtube" && this.youtubeReady && globalThis.YT) {
      const state = this.youtubePlayer?.getPlayerState?.();
      this.isPlaying = state === globalThis.YT.PlayerState.PLAYING;
      if (state !== globalThis.YT.PlayerState.BUFFERING) this.#setBuffering(false);
    } else if (this.backend === "local" && !this.localLoad) {
      const audio = this.localAudio;
      this.isPlaying = !audio.paused && !audio.ended;
      this.#setBuffering(this.isPlaying && audio.readyState < HAVE_FUTURE_DATA);
    }
    this.#monitor({ forceProgress: true });
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
  }

  #emitError(error) {
    error.reported = true;
    this.emit("error", { ...this.snapshot(), error, kind: error.kind || "unknown", status: error.status || 0 });
  }

  #revokeLocalObjectUrl() {
    if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
    this.localObjectUrl = null;
    this.localAssetId = null;
  }

  #iconArtwork() {
    return { src: new URL("../icons/icon-512.png", import.meta.url).href, sizes: "512x512", type: "image/png" };
  }

  // Shown until the injected helper resolves the real (authenticated) art.
  // Without a helper, the source artwork URL itself is offered first.
  #fallbackArtwork(source) {
    const artwork = [];
    if (!this.mediaSessionArtwork) artwork.push({ src: safeArtwork(source), sizes: "1280x720" });
    if (source.fallbackArtwork) artwork.push({ src: source.fallbackArtwork, sizes: "480x360" });
    artwork.push(this.#iconArtwork());
    return artwork;
  }

  #updateMediaMetadata() {
    if (!hasMediaSession() || !this.currentTrack || !this.currentSource) return;
    const source = this.currentSource;
    const key = artworkKey(source);
    const resolved = this.artworkCache.key === key ? this.artworkCache.artwork : null;
    this.#applyMediaMetadata(resolved || this.#fallbackArtwork(source));
    if (!resolved && this.mediaSessionArtwork) this.#resolveMediaArtwork(source, key);
  }

  #applyMediaMetadata(artwork) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.currentTrack.title,
        artist: this.currentTrack.artist || this.currentSource.artist,
        album: this.currentSource.title,
        artwork
      });
      this.#updateMediaPlaybackState();
    } catch (error) {
      console.debug("Media Session metadata was not accepted.", error);
    }
  }

  async #resolveMediaArtwork(source, key) {
    if (this.artworkPending === key) return;
    this.artworkPending = key;
    try {
      const artwork = await this.mediaSessionArtwork(source);
      if (!Array.isArray(artwork) || artwork.length === 0) return;
      this.artworkCache = { key, artwork };
      // Artwork belongs to the source, so any track of it may take it; a
      // different source playing by now keeps its own metadata untouched.
      if (this.currentTrack && this.currentSource && artworkKey(this.currentSource) === key) this.#applyMediaMetadata(artwork);
    } catch (error) {
      console.debug("Media Session artwork could not be prepared.", error);
    } finally {
      if (this.artworkPending === key) this.artworkPending = "";
    }
  }

  #configureMediaSession() {
    if (!hasMediaSession()) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.previous(),
      nexttrack: () => this.next(),
      seekbackward: (details) => this.seekAbsolute(this.positionAt() - (details.seekOffset || 10)),
      seekforward: (details) => this.seekAbsolute(this.positionAt() + (details.seekOffset || 10)),
      seekto: (details) => this.seekRelative(details.seekTime || 0)
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, (details) => {
          Promise.resolve(handler(details)).catch((error) => {
            if (!error?.reported) this.#emitError(error instanceof PlaybackError ? error : new PlaybackError(error?.message, "unknown", { cause: error }));
          });
        });
      } catch { /* unsupported action */ }
    }
  }

  #updateMediaPlaybackState(forcedState = null) {
    this.#syncWakeLock();
    if (!hasMediaSession()) return;
    try {
      navigator.mediaSession.playbackState = forcedState || (this.isPlaying ? "playing" : "paused");
    } catch { /* unsupported state */ }
  }

  #updateMediaPosition() {
    if (!hasMediaSession() || !navigator.mediaSession.setPositionState || !this.currentTrack) return;
    const duration = Math.max(1, this.currentTrack.end - this.currentTrack.start);
    const position = clamp(this.currentTime - this.currentTrack.start, 0, duration - 0.01);
    // Lock screens interpolate between reports; once a second is enough
    // unless the duration changed (new track) or the position jumped (seek).
    const last = this.lastPositionState;
    const now = Date.now();
    if (last.duration === duration && Math.abs(position - last.position) < 2 && now - last.at < 1000) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
      this.lastPositionState = { position, duration, at: now };
      this.#updateMediaPlaybackState();
    } catch { /* transient invalid position */ }
  }

  destroy() {
    this.loadAbort?.abort();
    clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
    this.listeners.abort();
    this.localAudio.pause();
    this.#revokeLocalObjectUrl();
    try {
      this.youtubePlayer?.destroy?.();
    } catch { /* iframe already gone */ }
    this.youtubePlayer = null;
    this.youtubeReady = false;
    this.isPlaying = false;
    this.keepScreenAwake = false;
    this.#syncWakeLock();
    if (hasMediaSession()) {
      for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch { /* unsupported action */ }
      }
    }
  }
}
