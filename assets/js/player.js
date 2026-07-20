import { clamp, safeArtwork } from "./utils.js";

let youtubeApiPromise;
const SEGMENT_BOUNDARY_TOLERANCE = 0.35;
const SEGMENT_END_EPSILON = 0.12;

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

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("The YouTube player API could not be loaded."));
      document.head.append(script);
    }
    setTimeout(() => {
      if (!window.YT?.Player) reject(new Error("The YouTube player took too long to load."));
    }, 20000);
  });
  return youtubeApiPromise;
}

export class PlaybackController extends EventTarget {
  constructor({ resolveTrack, resolveSource, getAudioAsset }) {
    super();
    this.resolveTrack = resolveTrack;
    this.resolveSource = resolveSource;
    this.getAudioAsset = getAudioAsset;

    this.currentTrack = null;
    this.currentSource = null;
    this.currentTime = 0;
    this.isPlaying = false;
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

    this.youtubePlayer = null;
    this.youtubeReady = false;
    this.youtubeVideoId = null;
    this.appliedYouTubeEnd = NaN;
    this.pendingYouTubeLoad = null;
    this.monitorTimer = null;
    this.localObjectUrl = null;
    this.segmentEndedLock = false;
    this.queueSnapshotCache = null;
    this.adWatch = { lastTime: -1, stalledSince: 0, active: false };
    this.wakeLockSentinel = null;
    this.wakeLockPending = false;
    this.lastPositionState = { position: -1, duration: -1, at: 0 };

    this.youtubeWrap = document.getElementById("youtube-player-wrap");
    this.localWrap = document.getElementById("local-player-wrap");
    this.localAudio = document.getElementById("local-audio");
    this.localArtwork = document.getElementById("local-artwork");
    this.emptyPlayer = document.getElementById("empty-player");

    this.#bindLocalAudio();
    this.#configureMediaSession();
    this.#configureAudioSession();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.#syncWakeLock();
    });
  }

  // Safari exposes navigator.audioSession; declaring "playback" keeps local
  // audio running with the Ring/Silent switch on and while backgrounded.
  #configureAudioSession() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
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

  setQueue(trackKeys, activeKey = null) {
    this.queue = [...new Set((trackKeys || []).filter((key) => this.resolveTrack(key)))];
    this.queueSnapshotCache = null;
    const key = activeKey || this.currentTrack?.key;
    this.queueIndex = key ? this.queue.indexOf(key) : -1;
    this.emit("queuechange", this.snapshot());
  }

  async loadByKey(trackKey, options = {}) {
    const track = this.resolveTrack(trackKey);
    if (!track) throw new Error("That track is no longer in the catalog.");
    const source = this.resolveSource(track.sourceId);
    if (!source) throw new Error("The track source could not be found.");
    return this.load(track, source, options);
  }

  async load(track, source, { autoplay = true, resumePosition = null, queue = null, preciseStart = false } = {}) {
    if (!track || !source) throw new Error("A track and source are required.");
    if (queue) this.setQueue(queue, track.key);
    else if (!this.queue.includes(track.key)) this.setQueue(source.tracks.map((item) => item.key), track.key);
    else this.queueIndex = this.queue.indexOf(track.key);

    this.segmentEndedLock = false;
    this.#clearAdWatch();
    const hasResumePosition = isResumePosition(resumePosition);
    const requestedPosition = clamp(
      hasResumePosition ? Number(resumePosition) : track.start,
      track.start,
      Math.max(track.start, track.end - 0.2)
    );
    this.currentTrack = track;
    this.currentSource = source;
    this.currentTime = this.#playbackStartFor(source, track, requestedPosition, { hasResumePosition, preciseStart });
    this.backend = source.provider;
    this.#showBackend(source.provider);
    this.#updateMediaMetadata();
    this.emit("trackchange", this.snapshot());

    try {
      if (source.provider === "youtube") {
        await this.#loadYouTube(source, this.currentTime, autoplay);
      } else if (source.provider === "local") {
        await this.#loadLocal(source, this.currentTime, autoplay);
      } else {
        throw new Error(`Unsupported playback provider: ${source.provider}`);
      }
      this.#startMonitor();
    } catch (error) {
      this.isPlaying = false;
      this.emit("error", { error, ...this.snapshot() });
      throw error;
    }
  }

  async #loadYouTube(source, startAt, autoplay) {
    this.localAudio.pause();
    const YT = await loadYouTubeApi();
    this.pendingYouTubeLoad = {
      videoId: source.youtubeId,
      startAt,
      endAt: this.#continuousRunEndForCurrentTrack(),
      autoplay
    };
    if (!this.youtubePlayer) {
      this.youtubePlayer = new YT.Player("youtube-player", {
        width: "100%",
        height: "100%",
        videoId: source.youtubeId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          ...(location.origin !== "null" ? { origin: location.origin } : {})
        },
        events: {
          onReady: (event) => {
            this.youtubeReady = true;
            event.target.setVolume(Math.round(this.volume * 100));
            this.#applyPendingYouTubeLoad();
          },
          onStateChange: (event) => this.#onYouTubeState(event),
          onPlaybackQualityChange: (event) => {
            const quality = String(event.data || "auto").replace("hd", "HD ").toUpperCase();
            this.qualityLabel = `YouTube adaptive · ${quality}`;
            this.emit("qualitychange", this.snapshot());
          },
          onError: (event) => {
            const error = new Error(`YouTube playback error (${event.data}). Open the source on YouTube to confirm embedding is allowed.`);
            this.emit("error", { error, ...this.snapshot() });
          }
        }
      });
    } else if (this.youtubeReady) {
      this.#applyPendingYouTubeLoad();
    }
    this.qualityLabel = "YouTube adaptive · highest available chosen by YouTube";
    this.emit("qualitychange", this.snapshot());
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
    if (!window.YT) return;
    if (event.data === window.YT.PlayerState.PLAYING) {
      this.isPlaying = true;
      // Re-assert our metadata as playback starts so the media notification
      // shows the segmented track, not the iframe's own video title.
      this.#updateMediaMetadata();
    }
    if ([window.YT.PlayerState.PAUSED, window.YT.PlayerState.CUED, window.YT.PlayerState.ENDED].includes(event.data)) this.isPlaying = false;
    if (event.data === window.YT.PlayerState.ENDED && this.currentTrack) {
      const time = this.youtubePlayer?.getCurrentTime?.();
      if (Number.isFinite(time)) this.currentTime = time;
      this.#syncContinuousTrackAtCurrentTime();
      this.#handleSegmentEnd();
    }
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
  }

  async #loadLocal(source, startAt, autoplay) {
    this.youtubePlayer?.pauseVideo?.();
    const asset = source.assetId ? await this.getAudioAsset(source.assetId) : null;
    let shouldLoad = true;
    if (asset?.blob) {
      if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
      this.localObjectUrl = URL.createObjectURL(asset.blob);
      this.localAudio.src = this.localObjectUrl;
      this.qualityLabel = `Original local file · ${asset.type || "audio"} · no app re-encoding`;
    } else if (source.audioUrl) {
      if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
      this.localObjectUrl = null;
      const packagedUrl = new URL(source.audioUrl, document.baseURI).href;
      shouldLoad = this.localAudio.src !== packagedUrl || this.localAudio.readyState === 0;
      if (shouldLoad) this.localAudio.src = packagedUrl;
      this.qualityLabel = "Included AAC audio · native background playback";
    } else {
      throw new Error("This local audio file is not stored in this browser. Re-import it in Catalog Studio.");
    }
    this.localAudio.volume = this.volume;
    this.localArtwork.src = safeArtwork(source);
    this.emit("qualitychange", this.snapshot());
    if (shouldLoad) {
      await new Promise((resolve, reject) => {
        const ready = () => {
          cleanup();
          resolve();
        };
        const fail = () => {
          cleanup();
          reject(new Error("The browser could not decode this local audio file."));
        };
        const cleanup = () => {
          this.localAudio.removeEventListener("loadedmetadata", ready);
          this.localAudio.removeEventListener("error", fail);
        };
        this.localAudio.addEventListener("loadedmetadata", ready, { once: true });
        this.localAudio.addEventListener("error", fail, { once: true });
        this.localAudio.load();
      });
    }
    this.localAudio.currentTime = startAt;
    if (autoplay) await this.localAudio.play();
  }

  #bindLocalAudio() {
    this.localAudio.addEventListener("play", () => {
      this.isPlaying = true;
      this.#updateMediaMetadata();
      this.#updateMediaPlaybackState();
      this.emit("statechange", this.snapshot());
    });
    this.localAudio.addEventListener("pause", () => {
      this.isPlaying = false;
      this.#updateMediaPlaybackState();
      this.emit("statechange", this.snapshot());
    });
    this.localAudio.addEventListener("timeupdate", () => this.#monitor());
    this.localAudio.addEventListener("ended", () => {
      this.currentTime = this.localAudio.currentTime || this.currentSource?.duration || this.currentTime;
      this.#syncContinuousTrackAtCurrentTime();
      this.#handleSegmentEnd();
    });
    this.localAudio.addEventListener("error", () => {
      const error = new Error("Local audio playback failed.");
      this.emit("error", { error, ...this.snapshot() });
    });
  }

  #showBackend(provider) {
    this.emptyPlayer.hidden = true;
    this.youtubeWrap.hidden = provider !== "youtube";
    this.localWrap.hidden = provider !== "local";
    this.emit("backendchange", this.snapshot());
  }

  #startMonitor() {
    clearTimeout(this.monitorTimer);
    const tick = () => {
      this.#monitor();
      this.monitorTimer = setTimeout(tick, this.#monitorDelay());
    };
    this.monitorTimer = setTimeout(tick, this.#monitorDelay());
  }

  // Poll quickly only when a segment boundary is close; otherwise a slower
  // cadence keeps the UI current at a fraction of the wake-ups.
  #monitorDelay() {
    if (!this.isPlaying) return 1500;
    const remaining = this.currentTrack ? this.currentTrack.end - this.currentTime : Infinity;
    return remaining <= 3 ? 250 : 600;
  }

  #monitor() {
    if (!this.currentTrack) return;
    try {
      if (this.backend === "youtube" && this.youtubeReady) {
        const time = this.youtubePlayer.getCurrentTime?.();
        if (Number.isFinite(time)) {
          this.currentTime = time;
          this.#watchForAd(time, this.youtubePlayer.getPlayerState?.());
        }
        const reportedQuality = this.youtubePlayer.getPlaybackQuality?.();
        if (reportedQuality && reportedQuality !== "unknown") {
          const quality = String(reportedQuality).replace("hd", "HD ").toUpperCase();
          const label = `YouTube adaptive · ${quality}`;
          if (label !== this.qualityLabel) {
            this.qualityLabel = label;
            this.emit("qualitychange", this.snapshot());
          }
        }
      } else if (this.backend === "local") {
        this.currentTime = this.localAudio.currentTime || this.currentTrack.start;
      }
      this.#syncContinuousTrackAtCurrentTime();
      if (!this.segmentEndedLock && this.currentTime >= this.currentTrack.end - 0.12) this.#handleSegmentEnd();
      this.#updateMediaPosition();
      this.emit("progress", this.snapshot());
    } catch (error) {
      console.debug("Playback monitor skipped a tick.", error);
    }
  }

  async #handleSegmentEnd() {
    if (this.segmentEndedLock || !this.currentTrack) return;
    const advanced = this.#syncContinuousTrackAtCurrentTime();
    if (advanced && this.currentTime < this.currentTrack.end - 0.12) return;
    this.segmentEndedLock = true;
    this.emit("segmentended", this.snapshot());
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
    this.currentTime = this.currentTrack.end;
    this.emit("progress", this.snapshot());
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
    return true;
  }

  async play() {
    if (!this.currentTrack) return false;
    this.segmentEndedLock = false;
    if (this.backend === "youtube") {
      if (!this.youtubeReady) return false;
      this.youtubePlayer.playVideo();
      this.#updateMediaPlaybackState("playing");
      return true;
    }
    await this.localAudio.play();
    return true;
  }

  async pause() {
    if (this.backend === "youtube") this.youtubePlayer?.pauseVideo?.();
    if (this.backend === "local") this.localAudio.pause();
    this.isPlaying = false;
    this.#updateMediaPlaybackState("paused");
    this.emit("statechange", this.snapshot());
  }

  async toggle() {
    return this.isPlaying ? this.pause() : this.play();
  }

  async seekAbsolute(seconds, allowSeekAhead = true) {
    if (!this.currentTrack) return;
    const target = clamp(Number(seconds), this.currentTrack.start, Math.max(this.currentTrack.start, this.currentTrack.end - 0.05));
    this.segmentEndedLock = false;
    if (this.backend === "youtube") this.youtubePlayer?.seekTo?.(target, allowSeekAhead);
    if (this.backend === "local") this.localAudio.currentTime = target;
    this.currentTime = target;
    this.emit("progress", this.snapshot());
  }

  async seekRelative(seconds, allowSeekAhead = true) {
    if (!this.currentTrack) return;
    return this.seekAbsolute(this.currentTrack.start + clamp(Number(seconds), 0, this.currentTrack.end - this.currentTrack.start), allowSeekAhead);
  }

  async previous() {
    if (!this.currentTrack) return false;
    if (this.currentTime - this.currentTrack.start > 4) {
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
    await this.loadByKey(key, { autoplay: true });
    return true;
  }

  setVolume(value, emit = true) {
    this.volume = clamp(Number(value), 0, 1);
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
    if (playerState !== window.YT?.PlayerState?.PLAYING) {
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
    if (this.backend !== "youtube" || !this.youtubeWrap) return false;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (this.youtubeWrap.requestFullscreen) {
        await this.youtubeWrap.requestFullscreen();
      } else if (this.youtubeWrap.webkitRequestFullscreen) {
        this.youtubeWrap.webkitRequestFullscreen();
      } else {
        return false;
      }
      return true;
    } catch (error) {
      this.emit("error", { error: new Error("The browser blocked fullscreen for the video."), ...this.snapshot() });
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
    if (!("wakeLock" in navigator) || this.wakeLockPending) return;
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
    if (this.backend === "youtube" && this.youtubeReady && window.YT) {
      const state = this.youtubePlayer?.getPlayerState?.();
      this.isPlaying = state === window.YT.PlayerState.PLAYING;
    } else if (this.backend === "local") {
      this.isPlaying = !this.localAudio.paused && !this.localAudio.ended;
    }
    this.#monitor();
    this.#updateMediaPlaybackState();
    this.emit("statechange", this.snapshot());
  }

  #updateMediaMetadata() {
    if (!("mediaSession" in navigator) || !this.currentTrack || !this.currentSource) return;
    try {
      // Sized artwork entries let Android/desktop media notifications pick a
      // resolution instead of dropping the image; the app icon is the floor.
      const artwork = [{ src: safeArtwork(this.currentSource), sizes: "1280x720" }];
      if (this.currentSource.fallbackArtwork) artwork.push({ src: this.currentSource.fallbackArtwork, sizes: "480x360" });
      artwork.push({ src: new URL("../icons/icon-512.png", import.meta.url).href, sizes: "512x512", type: "image/png" });
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

  #configureMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.previous(),
      nexttrack: () => this.next(),
      seekbackward: (details) => this.seekAbsolute(this.currentTime - (details.seekOffset || 10)),
      seekforward: (details) => this.seekAbsolute(this.currentTime + (details.seekOffset || 10)),
      seekto: (details) => this.seekRelative(details.seekTime || 0)
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, (details) => {
          Promise.resolve(handler(details)).catch((error) => this.emit("error", { error, ...this.snapshot() }));
        });
      } catch { /* unsupported action */ }
    }
  }

  #updateMediaPlaybackState(forcedState = null) {
    this.#syncWakeLock();
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = forcedState || (this.isPlaying ? "playing" : "paused");
    } catch { /* unsupported state */ }
  }

  #updateMediaPosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || !this.currentTrack) return;
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
    clearTimeout(this.monitorTimer);
    this.localAudio.pause();
    if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
    this.keepScreenAwake = false;
    this.#syncWakeLock();
  }
}
