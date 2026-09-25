// Home: greeting, resume card and a few calm shelves. Pure string builder (no after hook needed).
import { icon } from "../icons.js";
import { albumCard, art, artistCard, emptyState, grid, html, sectionBlock, seriesCard, shelf, skeletonGrid } from "../ui.js";
import { clamp, formatTime, joinMeta, sortName } from "../utils.js";

const RECENT_LIMIT = 12;
const JUMP_BACK_LIMIT = 8;
const ARTIST_LIMIT = 12;
const SERIES_MIN_SOURCES = 2;

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

function isNew(ctx, sourceId) {
  return typeof ctx.isNew === "function" ? Boolean(ctx.isNew(sourceId)) : false;
}

// The gear is a phone affordance; on desktop Settings lives in the sidebar.
function titleRow(title) {
  return html`<div class="page-title-row"><h1>${title}</h1><a class="icon-btn mobile-only" href="#/settings" aria-label="Settings" title="Settings">${icon("settings")}</a></div>`;
}

function connectBanner() {
  return html`<a class="banner banner--accent" href="#/settings?focus=library">${icon("cloud", { size: 22 })}<span><strong>Connect your library to play</strong><small>Add your access token in Settings.</small></span>${icon("chevron-right", { size: 20 })}</a>`;
}

// resume().elapsed is the position inside the track; tolerate an absolute source position too.
function resumeProgress(track, elapsedInput) {
  const duration = Math.max(0, Number(track.duration ?? (track.end - track.start)) || 0);
  let elapsed = Math.max(0, Number(elapsedInput) || 0);
  const start = Number(track.start) || 0;
  if (elapsed > duration + 1 && elapsed >= start && elapsed <= Number(track.end) + 1) elapsed -= start;
  elapsed = clamp(elapsed, 0, duration);
  return { duration, elapsed, ratio: duration > 0 ? elapsed / duration : 0 };
}

function resumeSection(resume) {
  const track = resume?.track;
  if (!track) return "";
  const { duration, elapsed, ratio } = resumeProgress(track, resume.elapsed);
  const remaining = duration - elapsed;
  const albumTitle = resume.source?.title || track.sourceTitle;
  const artItem = track.artwork || track.fallbackArtwork ? track : resume.source;
  return html`<section class="section home-resume" aria-label="Continue listening"><button class="resume-card" type="button" data-action="resume" aria-label="Continue listening: ${track.title} by ${track.artist}"><span class="resume-art">${art(artItem, { size: 112, eager: true })}</span><span class="resume-text"><span class="resume-kicker">Continue listening</span><span class="resume-title">${track.title}</span><span class="resume-sub">${joinMeta([track.artist, albumTitle])}</span></span>${remaining >= 1 && elapsed >= 1 ? html`<span class="resume-left">${formatTime(remaining)} left</span>` : ""}<span class="resume-play" aria-hidden="true">${icon("play-fill", { size: 20 })}</span><span class="resume-progress" style="--progress: ${ratio.toFixed(4)}" aria-hidden="true"></span></button></section>`;
}

// "Continue listening" is the call to action after a cold start only. Once a song is loaded the mini
// player / player bar shows it with a live play-pause button, and a second, static ▶ would only
// disagree with it.
function coldStartResume(ctx) {
  if (ctx.player?.currentTrack) return null;
  try {
    return typeof ctx.resume === "function" ? ctx.resume() || null : null;
  } catch {
    return null;
  }
}

// The card was the way in; when playback starts (from it or anywhere else) it folds away.
function foldResumeWhenPlaying(root, player) {
  const section = root.querySelector(".home-resume");
  if (!section || typeof player?.addEventListener !== "function") return undefined;
  const events = ["trackchange", "statechange"];
  const stop = () => events.forEach((type) => player.removeEventListener(type, onChange));
  function onChange() {
    if (!player.currentTrack) return;
    stop();
    if (section.isConnected) collapse(section);
  }
  events.forEach((type) => player.addEventListener(type, onChange));
  return stop;
}

function collapse(element) {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || typeof element.animate !== "function") {
    element.remove();
    return;
  }
  const style = getComputedStyle(element);
  element.style.overflow = "hidden";
  const animation = element.animate([
    { opacity: 1, height: `${element.offsetHeight}px`, marginTop: style.marginTop, marginBottom: style.marginBottom },
    { opacity: 0, height: "0px", marginTop: "0px", marginBottom: "0px" }
  ], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" });
  animation.onfinish = () => element.remove();
  animation.oncancel = () => element.remove();
}

// One card leaves half a row empty, and a shelf that repeats how Recently added starts adds nothing.
export function worthJumpingBack(played, byAdded) {
  if (played.length < 2) return false;
  return !played.every((source, index) => byAdded[index]?.id === source.id);
}

function resolveSources(catalog, list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry === "string" ? catalog.sourceById?.get(entry) : entry?.id ? catalog.sourceById?.get(entry.id) || entry : null))
    .filter(Boolean);
}

function artistPlays(ctx, artist) {
  if (typeof ctx.playCount !== "function") return 0;
  let total = 0;
  for (const key of artist.trackKeys || []) total += Number(ctx.playCount(key)) || 0;
  return total;
}

export function homeArtists(ctx, catalog, limit = ARTIST_LIMIT) {
  return (catalog.artists || [])
    .map((artist) => ({ artist, plays: artistPlays(ctx, artist) }))
    .sort((a, b) => b.plays - a.plays
      || String(b.artist.latestAdded || "").localeCompare(String(a.artist.latestAdded || ""))
      || (b.artist.songCount || 0) - (a.artist.songCount || 0)
      || collator.compare(sortName(a.artist.name), sortName(b.artist.name)))
    .slice(0, limit)
    .map(({ artist }) => artist);
}

function albumsByArtist(sources) {
  return [...sources].sort((a, b) => collator.compare(sortName(a.artist), sortName(b.artist))
    || (Number(b.year) || 0) - (Number(a.year) || 0)
    || collator.compare(a.title, b.title));
}

function emptyLibrary(ctx) {
  const state = ctx.syncStatus?.state;
  if (state === "syncing") return skeletonGrid(6);
  if (state === "unauthorized") {
    return emptyState({
      iconName: "cloud",
      title: "Connect your library",
      body: "Your music lives in your private library. Connect it once and everything shows up here.",
      actionHtml: html`<a class="btn btn-primary" href="#/settings?focus=library">Connect</a>`
    });
  }
  if (state === "offline" || ctx.offline) {
    return emptyState({ iconName: "cloud-off", title: "You're offline", body: "Your music will appear as soon as you're back online." });
  }
  return emptyState({ iconName: "songs", title: "No music yet", body: "New music you publish shows up here on its own." });
}

export function renderHome(ctx, route) {
  const catalog = ctx.catalog;
  const hello = greeting();
  const needsConnect = ctx.syncStatus?.state === "unauthorized";
  const head = html`${titleRow(hello)}${needsConnect ? connectBanner() : ""}`;

  if (!catalog) {
    return { title: "Home", html: String(html`<div class="page page--home">${head}${skeletonGrid(6)}</div>`) };
  }
  const sources = Array.isArray(catalog.sources) ? catalog.sources : [];
  if (!sources.length) {
    // The empty state already says "Connect", so the banner would only repeat it.
    return { title: "Home", html: String(html`<div class="page page--home">${titleRow(hello)}${emptyLibrary(ctx)}</div>`) };
  }

  const resume = coldStartResume(ctx);

  const byAdded = (catalog.sourcesByAdded || sources).slice(0, RECENT_LIMIT);
  const recent = sectionBlock({
    title: "Recently added",
    href: sources.length > RECENT_LIMIT ? "#/library?tab=albums" : "",
    body: shelf(byAdded.map((source) => albumCard(source, { isNew: isNew(ctx, source.id) })))
  });

  const played = typeof ctx.recentSources === "function" ? resolveSources(catalog, ctx.recentSources(JUMP_BACK_LIMIT)) : [];
  const jumpBack = worthJumpingBack(played, byAdded)
    ? sectionBlock({ title: "Jump back in", body: shelf(played.map((source) => albumCard(source))) })
    : "";

  const artists = homeArtists(ctx, catalog);
  const artistShelf = artists.length
    ? sectionBlock({ title: "Artists", href: "#/artists", body: shelf(artists.map(artistCard)) })
    : "";

  const series = (catalog.series || []).filter((item) => (item.sourceCount ?? item.sourceIds?.length ?? 0) >= SERIES_MIN_SOURCES);
  const seriesShelf = series.length
    ? sectionBlock({ title: "Series", href: "#/series", body: shelf(series.map(seriesCard)) })
    : "";

  const allAlbums = sectionBlock({ title: "All albums", body: grid(albumsByArtist(sources).map((source) => albumCard(source))) });

  return {
    title: "Home",
    html: String(html`<div class="page page--home">${head}${resumeSection(resume)}${recent}${jumpBack}${artistShelf}${seriesShelf}${allAlbums}</div>`),
    after: resume ? (root) => foldResumeWhenPlaying(root, ctx.player) : undefined
  };
}
