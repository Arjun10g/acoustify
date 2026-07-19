import { clamp, safeArtwork } from "./utils.js";

let youtubeApiPromise;

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
    this.segmentLeadIn = 1.5;
    this.volume = 0.86;

    this.youtubePlayer = null;
    this.youtubeReady = false;
    this.youtubeVideoId = null;
    this.pendingYouTubeLoad = null;
    this.monitorTimer = null;
    this.localObjectUrl = null;
    this.segmentEndedLock = false;

    this.youtubeWrap = document.getElementById("youtube-player-wrap");
    this.localWrap = document.getElementById("local-player-wrap");
    this.localAudio = document.getElementById("local-audio");
    this.localArtwork = document.getElementById("local-artwork");
    this.emptyPlayer = document.getElementById("empty-player");

    this.#bindLocalAudio();
    this.#configureMediaSession();
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  configure({ volume, repeat, shuffle, autoplay, segmentLeadIn } = {}) {
    if (Number.isFinite(Number(volume))) this.setVolume(Number(volume), false);
    if (["off", "all", "one"].includes(repeat)) this.repeat = repeat;
    if (typeof shuffle === "boolean") this.shuffle = shuffle;
    if (typeof autoplay === "boolean") this.autoplay = autoplay;
    if (Number.isFinite(Number(segmentLeadIn))) this.segmentLeadIn = clamp(Number(segmentLeadIn), 0, 5);
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
      queue: [...this.queue],
      queueIndex: this.queueIndex,
      repeat: this.repeat,
      shuffle: this.shuffle,
      autoplay: this.autoplay,
      segmentLeadIn: this.segmentLeadIn,
      volume: this.volume
    };
  }

  setQueue(trackKeys, activeKey = null) {
    this.queue = [...new Set((trackKeys || []).filter((key) => this.resolveTrack(key)))];
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
    const hasResumePosition = Number.isFinite(Number(resumePosition));
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
    this.pendingYouTubeLoad = { videoId: source.youtubeId, startAt, endAt: this.currentTrack.end, autoplay };
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

  #applyPendingYouTubeLoad() {
    if (!this.youtubeReady || !this.pendingYouTubeLoad) return;
    const request = this.pendingYouTubeLoad;
    this.pendingYouTubeLoad = null;
    this.youtubeVideoId = request.videoId;
    // Reload the bounded segment even when the next track belongs to the same
    // upload. This preserves YouTube's native endSeconds guard in background
    // tabs where JavaScript timers may be throttled.
    if (request.autoplay) {
      this.youtubePlayer.loadVideoById({
        videoId: request.videoId,
        startSeconds: request.startAt,
        endSeconds: request.endAt
      });
    } else {
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
    if (event.data === window.YT.PlayerState.PLAYING) this.isPlaying = true;
    if ([window.YT.PlayerState.PAUSED, window.YT.PlayerState.CUED, window.YT.PlayerState.ENDED].includes(event.data)) this.isPlaying = false;
    if (event.data === window.YT.PlayerState.ENDED && this.currentTrack) this.#handleSegmentEnd();
    this.emit("statechange", this.snapshot());
  }

  async #loadLocal(source, startAt, autoplay) {
    this.youtubePlayer?.pauseVideo?.();
    const asset = await this.getAudioAsset(source.assetId);
    if (!asset?.blob) throw new Error("This local audio file is not stored in this browser. Re-import it in Catalog Studio.");
    if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
    this.localObjectUrl = URL.createObjectURL(asset.blob);
    this.localAudio.src = this.localObjectUrl;
    this.localAudio.volume = this.volume;
    this.localArtwork.src = safeArtwork(source);
    this.qualityLabel = `Original local file · ${asset.type || "audio"} · no app re-encoding`;
    this.emit("qualitychange", this.snapshot());
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
    this.localAudio.currentTime = startAt;
    if (autoplay) await this.localAudio.play();
  }

  #bindLocalAudio() {
    this.localAudio.addEventListener("play", () => {
      this.isPlaying = true;
      this.emit("statechange", this.snapshot());
    });
    this.localAudio.addEventListener("pause", () => {
      this.isPlaying = false;
      this.emit("statechange", this.snapshot());
    });
    this.localAudio.addEventListener("ended", () => this.#handleSegmentEnd());
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
    clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(() => this.#monitor(), 250);
  }

  #monitor() {
    if (!this.currentTrack) return;
    try {
      if (this.backend === "youtube" && this.youtubeReady) {
        const time = this.youtubePlayer.getCurrentTime?.();
        if (Number.isFinite(time)) this.currentTime = time;
        const reportedQuality = this.youtubePlayer.getPlaybackQuality?.();
        if (reportedQuality && reportedQuality !== "unknown") {
          const quality = String(reportedQuality).replace("hd", "HD ").toUpperCase();
          this.qualityLabel = `YouTube adaptive · ${quality}`;
        }
      } else if (this.backend === "local") {
        this.currentTime = this.localAudio.currentTime || this.currentTrack.start;
      }
      if (!this.segmentEndedLock && this.currentTime >= this.currentTrack.end - 0.12) this.#handleSegmentEnd();
      this.#updateMediaPosition();
      this.emit("progress", this.snapshot());
    } catch (error) {
      console.debug("Playback monitor skipped a tick.", error);
    }
  }

  async #handleSegmentEnd() {
    if (this.segmentEndedLock || !this.currentTrack) return;
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

  async play() {
    if (!this.currentTrack) return false;
    this.segmentEndedLock = false;
    if (this.backend === "youtube") {
      if (!this.youtubeReady) return false;
      this.youtubePlayer.playVideo();
      return true;
    }
    await this.localAudio.play();
    return true;
  }

  async pause() {
    if (this.backend === "youtube") this.youtubePlayer?.pauseVideo?.();
    if (this.backend === "local") this.localAudio.pause();
    this.isPlaying = false;
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

  #updateMediaMetadata() {
    if (!("mediaSession" in navigator) || !this.currentTrack || !this.currentSource) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.currentTrack.title,
        artist: this.currentTrack.artist || this.currentSource.artist,
        album: this.currentSource.title,
        artwork: [
          { src: safeArtwork(this.currentSource), sizes: "512x512" }
        ]
      });
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
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  }

  #updateMediaPosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || !this.currentTrack) return;
    const duration = Math.max(1, this.currentTrack.end - this.currentTrack.start);
    const position = clamp(this.currentTime - this.currentTrack.start, 0, duration - 0.01);
    try {
      navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
      navigator.mediaSession.playbackState = this.isPlaying ? "playing" : "paused";
    } catch { /* transient invalid position */ }
  }

  destroy() {
    clearInterval(this.monitorTimer);
    this.localAudio.pause();
    if (this.localObjectUrl) URL.revokeObjectURL(this.localObjectUrl);
  }
}
