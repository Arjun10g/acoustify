// Series index (#/series) and series pages (#/series/<slug>): the show, venue or channel a
// recording comes from (NPR Tiny Desk, Western AF, Red Barn Radio…).
import { icon } from "../icons.js";
import { albumCard, artistCard, emptyState, grid, hero, html, playFab, sectionBlock, seriesCard, shelf, skeletonGrid, trackList } from "../ui.js";
import { formatDurationLong, pluralize } from "../utils.js";
import {
  directoryEmpty,
  directoryFilter,
  directoryItem,
  directorySwitch,
  isNewAny,
  libraryEmptyAction,
  matchesFilter,
  mountDirectoryFilter,
  pageTop,
  withRecordingLabels
} from "./artists.js";

const HERO_ARTIST_LINKS = 3;

function call(fn, fallback, ...args) {
  if (typeof fn !== "function") return fallback;
  try {
    return fn(...args);
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function safeSlug(value) {
  const text = String(value ?? "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function lookupSeries(catalog, slug) {
  return catalog?.seriesBySlug?.get?.(slug) || catalog?.series?.find?.((series) => series.slug === slug) || null;
}

function lookupSource(catalog, id) {
  return catalog?.sourceById?.get?.(id) || catalog?.sources?.find?.((source) => source.id === id) || null;
}

function lookupArtist(catalog, slug) {
  return catalog?.artistBySlug?.get?.(slug) || catalog?.artists?.find?.((artist) => artist.slug === slug) || null;
}

function lookupTrack(catalog, key) {
  return catalog?.trackByKey?.get?.(key) || catalog?.tracks?.find?.((track) => track.key === key) || null;
}

// Songs in page order: sessions in the index's order (newest added first, the same order the
// controller's play-series uses, so Play plays the list top to bottom), album order within each.
export function seriesTracks(catalog, series, sources) {
  const tracks = [];
  const seen = new Set();
  for (const source of sources) {
    for (const entry of source.tracks || []) {
      const track = entry?.key ? lookupTrack(catalog, entry.key) || entry : null;
      if (!track || seen.has(track.key)) continue;
      seen.add(track.key);
      tracks.push(track);
    }
  }
  for (const key of series?.trackKeys || []) {
    if (seen.has(key)) continue;
    const track = lookupTrack(catalog, key);
    if (!track) continue;
    seen.add(key);
    tracks.push(track);
  }
  return tracks;
}

// Artists heard in the series, most songs first.
export function seriesArtists(catalog, tracks) {
  const counts = new Map();
  for (const track of tracks) {
    for (const slug of new Set(track.artistSlugs || [])) counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([slug, songs]) => ({ artist: lookupArtist(catalog, slug), songs }))
    .filter((entry) => entry.artist)
    .sort((a, b) => b.songs - a.songs || a.artist.name.localeCompare(b.artist.name))
    .map((entry) => entry.artist);
}

function totalDuration(tracks) {
  return tracks.reduce((sum, track) => {
    const seconds = Number(track?.duration ?? Number(track?.end) - Number(track?.start));
    return sum + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
  }, 0);
}

// "A & B", "A, B & C", or "A, B, C & 2 more".
function artistLinks(artists) {
  const shown = artists.slice(0, HERO_ARTIST_LINKS);
  const links = shown.map((artist) => html`<a href="#/artist/${encodeURIComponent(artist.slug)}">${artist.name}</a>`);
  const more = artists.length - shown.length;
  const tail = more > 0 ? pluralize(more, "more", "more") : links.pop();
  if (!links.length) return html`${tail}`;
  return html`${links.map((link, index) => html`${index ? ", " : ""}${link}`)} &amp; ${tail}`;
}

function offlineReadyFor(ctx) {
  if (typeof ctx?.downloadState !== "function") return null;
  const cache = new Map();
  return (track) => {
    if (!cache.has(track.sourceId)) cache.set(track.sourceId, call(ctx.downloadState, null, track.sourceId)?.state === "done");
    return cache.get(track.sourceId);
  };
}

/* ------------------------------------------------------------------ #/series */

export function renderSeriesIndex(ctx, route) {
  const catalog = ctx?.catalog;
  const title = "Series";
  const head = html`<div class="page-title-row"><h1>${title}</h1>${directorySwitch("series")}</div>`;

  if (!catalog) {
    return { title, html: String(html`<div class="page directory directory--series">${head}${skeletonGrid(6)}</div>`) };
  }

  const list = Array.isArray(catalog.series) ? catalog.series : [];
  if (!list.length) {
    const empty = emptyState({
      iconName: "series",
      title: "No series yet",
      body: "Shows and live sessions such as NPR Tiny Desk appear here once your library has them.",
      actionHtml: libraryEmptyAction(ctx) || html`<a class="btn btn-secondary" href="#/artists">Browse artists</a>`
    });
    return { title, html: String(html`<div class="page directory directory--series">${head}${empty}</div>`) };
  }

  const query = String(route?.params?.get?.("q") ?? "").trim();
  let shown = 0;
  const items = list.map((series) => {
    const match = matchesFilter(series.name, query);
    if (match) shown += 1;
    return directoryItem(seriesCard(series), { filterText: series.name, isNew: isNewAny(ctx, series.sourceIds || []), hidden: !match });
  });
  const countLabel = (n) => pluralize(n, "series", "series");

  const markup = html`<div class="page directory directory--series">${head}${directoryFilter({ query, placeholder: `Search ${countLabel(list.length)}`, label: "Filter series" })}<p class="sr-only" role="status" data-directory-status>${query ? countLabel(shown) : ""}</p>${grid(items, { variant: "series" })}${directoryEmpty({ noun: "series", query, hidden: shown > 0 })}</div>`;

  return {
    title,
    html: String(markup),
    after(root) {
      return mountDirectoryFilter(root, { ctx, basePath: "#/series", noun: "series", countLabel });
    }
  };
}

/* ------------------------------------------------------------------ #/series/<slug> */

function seriesNotFound() {
  const empty = emptyState({
    iconName: "series",
    title: "Series not found",
    body: "This series isn’t in your library anymore.",
    actionHtml: html`<a class="btn btn-secondary" href="#/series">Browse series</a>`
  });
  return { title: "Series not found", html: String(html`<div class="page series-page">${pageTop()}${empty}</div>`) };
}

export function renderSeries(ctx, route, slugArg) {
  const catalog = ctx?.catalog;
  const slug = safeSlug(slugArg ?? route?.segments?.[1] ?? "");
  if (!catalog) {
    return { title: "Series", html: String(html`<div class="page series-page">${skeletonGrid(6)}</div>`) };
  }
  const series = lookupSeries(catalog, slug);
  if (!series) return seriesNotFound();

  const sources = (series.sourceIds || []).map((id) => lookupSource(catalog, id)).filter(Boolean);
  const tracks = seriesTracks(catalog, series, sources);
  const artists = seriesArtists(catalog, tracks);
  const sessions = sources.filter((source) => (source.tracks?.length || 0) > 1);
  const multiArtist = artists.length > 1;

  // Shuffle only means something with two songs or more.
  const shuffle = tracks.length > 1
    ? html`<button class="icon-btn" type="button" data-action="shuffle-series" data-series="${series.slug}" aria-label="Shuffle ${series.name}">${icon("shuffle", { size: 24 })}</button>`
    : "";
  const actions = tracks.length
    ? html`${playFab({ action: "play-series", attrs: { series: series.slug, playSeries: series.slug }, label: `Play ${series.name}` })}${shuffle}`
    : "";

  const heroMarkup = hero({
    artItem: series,
    kicker: "Series",
    title: series.name,
    subtitleHtml: artistLinks(artists),
    meta: [
      pluralize(sources.length, "session"),
      pluralize(tracks.length, "song"),
      tracks.length ? formatDurationLong(totalDuration(tracks)) : ""
    ],
    actionsHtml: actions
  });

  // The hero already links up to three artists; a shelf earns its place when there are more, or
  // when no session cards name them.
  const artistsBlock = multiArtist && (artists.length > HERO_ARTIST_LINKS || !sessions.length)
    ? sectionBlock({ title: "Artists", body: shelf(artists.map(artistCard)), className: "series-section" })
    : "";

  // Every session a single song: the song list below already is the full picture.
  const sessionsBlock = sessions.length
    ? sectionBlock({
      title: "Sessions",
      body: html`<div class="series-sessions">${grid(sources.map((source) => albumCard(source, { isNew: Boolean(call(ctx?.isNew, false, source.id)) })))}</div>`,
      className: "series-section"
    })
    : "";

  const queueId = call(ctx?.registerQueue, undefined, `series-${series.slug}`, tracks) || undefined;
  // Multi-artist series: the artist name says it all, plus the year when known.
  const rowTracks = multiArtist
    ? tracks.map((track) => ({ ...track, sourceTitle: String(lookupSource(catalog, track.sourceId)?.year || "") }))
    : withRecordingLabels(catalog, tracks, { series: series.name });
  const songsBlock = tracks.length
    ? sectionBlock({
      title: "Songs",
      body: trackList(rowTracks, {
        queueId,
        numbered: false,
        showArt: true,
        showArtist: multiArtist,
        showAlbum: true,
        context: { type: "series", id: series.slug },
        currentKey: ctx?.currentKey ?? null,
        isPlaying: Boolean(ctx?.isPlaying),
        likedKeys: ctx?.likedKeys instanceof Set ? ctx.likedKeys : new Set(),
        offlineReady: offlineReadyFor(ctx)
      }),
      className: "series-section series-section--songs"
    })
    : emptyState({ iconName: "songs", title: "No songs yet", body: "Songs from this series will appear here." });

  const markup = html`<div class="page series-page">${pageTop()}${heroMarkup}${artistsBlock}${sessionsBlock}${songsBlock}</div>`;
  return { title: series.name, html: String(markup) };
}
