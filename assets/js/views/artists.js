// Artists index (#/artists) and artist pages (#/artist/<slug>).
// Also home to the directory helpers the series index shares: the Artists/Series switch and the
// instant filter, so both browse pages look and behave the same.
import { icon } from "../icons.js";
import { albumCard, artistCard, chips, emptyState, grid, hero, html, playFab, raw, sectionBlock, shelf, skeletonGrid, trackList } from "../ui.js";
import { formatDurationLong, joinMeta, pluralize } from "../utils.js";
import { releaseSubtitle } from "./library.js";

const POPULAR_COLLAPSED = 5;
const URL_SYNC_DELAY = 250;

// Artist pages whose "Popular" list the listener expanded. Survives re-renders (library refresh,
// returning to the page) for the session; purely a view preference, so it never touches ctx.state.
const expandedPopular = new Set();

/* ------------------------------------------------------------------ small pure helpers */

// Case-, accent- and punctuation-insensitive text for matching: "Chance Peña" → "chance pena",
// "Mumford & Sons" → "mumford and sons".
export function foldText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Every word of the query must appear somewhere in the text ("clay str" finds The Red Clay Strays).
export function matchesFilter(text, query) {
  const words = foldText(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = foldText(text);
  return words.every((word) => haystack.includes(word));
}

function safeSlug(value) {
  const text = String(value ?? "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function call(fn, fallback, ...args) {
  if (typeof fn !== "function") return fallback;
  try {
    return fn(...args);
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function routeQuery(route) {
  return String(route?.params?.get?.("q") ?? "").trim();
}

function totalDuration(tracks) {
  return tracks.reduce((sum, track) => {
    const seconds = Number(track?.duration ?? Number(track?.end) - Number(track?.start));
    return sum + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
  }, 0);
}

// Discography order: newest year first, undated last, then most recently added.
export function compareReleases(a, b) {
  const yearA = Number(a?.year) || 0;
  const yearB = Number(b?.year) || 0;
  if (yearA !== yearB) return yearB - yearA;
  return String(b?.added || "").localeCompare(String(a?.added || ""));
}

function lookupArtist(catalog, slug) {
  return catalog?.artistBySlug?.get?.(slug) || catalog?.artists?.find?.((artist) => artist.slug === slug) || null;
}

function lookupSource(catalog, id) {
  return catalog?.sourceById?.get?.(id) || catalog?.sources?.find?.((source) => source.id === id) || null;
}

function lookupTrack(catalog, key) {
  return catalog?.trackByKey?.get?.(key) || catalog?.tracks?.find?.((track) => track.key === key) || null;
}

// Series entities keyed by display name (artists only carry series names).
function seriesByName(catalog) {
  const map = new Map();
  for (const series of catalog?.series || []) map.set(series.name, series);
  return map;
}

function sourcesOf(catalog, ids = []) {
  return ids.map((id) => lookupSource(catalog, id)).filter(Boolean);
}

export function isNewAny(ctx, sourceIds = []) {
  return sourceIds.some((id) => Boolean(call(ctx?.isNew, false, id)));
}

function offlineReadyFor(ctx) {
  if (typeof ctx?.downloadState !== "function") return null;
  const cache = new Map();
  return (track) => {
    if (!cache.has(track.sourceId)) cache.set(track.sourceId, call(ctx.downloadState, null, track.sourceId)?.state === "done");
    return cache.get(track.sourceId);
  };
}

function listOptions(ctx, context) {
  return {
    context,
    currentKey: ctx?.currentKey ?? null,
    isPlaying: Boolean(ctx?.isPlaying),
    likedKeys: ctx?.likedKeys instanceof Set ? ctx.likedKeys : new Set(),
    offlineReady: offlineReadyFor(ctx)
  };
}

function registerQueue(ctx, prefix, tracks) {
  return call(ctx?.registerQueue, undefined, prefix, tracks) || undefined;
}

/* ------------------------------------------------------------------ artist data */

// Ranked songs for the Popular list: the controller's play-count ranking first, then every other
// song of the artist (most played, newest, then album order) so "Show all" really shows all.
export function rankArtistTracks(ctx, artist) {
  const catalog = ctx?.catalog;
  const own = (artist?.trackKeys || []).map((key) => lookupTrack(catalog, key)).filter(Boolean);
  const ownKeys = new Set(own.map((track) => track.key));
  const ranked = [];
  const seen = new Set();
  const top = call(ctx?.topTracksForArtist, [], artist?.slug, own.length) || [];
  for (const entry of Array.isArray(top) ? top : []) {
    const track = typeof entry === "string" ? lookupTrack(catalog, entry) : entry?.key ? lookupTrack(catalog, entry.key) || entry : null;
    if (!track || seen.has(track.key) || !ownKeys.has(track.key)) continue;
    seen.add(track.key);
    ranked.push(track);
  }
  const order = new Map((artist?.sourceIds || []).map((id, index) => [id, index]));
  const plays = new Map(own.map((track) => [track.key, Number(call(ctx?.playCount, 0, track.key)) || 0]));
  const rest = own
    .filter((track) => !seen.has(track.key))
    .sort((a, b) => (plays.get(b.key) - plays.get(a.key))
      || ((order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0))
      || ((a.index ?? 0) - (b.index ?? 0)));
  return [...ranked, ...rest];
}

// Other artists credited on the same recordings, most shared songs first.
export function collaboratorsOf(catalog, artist) {
  const counts = new Map();
  for (const key of artist?.trackKeys || []) {
    const track = lookupTrack(catalog, key);
    if (!track) continue;
    const source = lookupSource(catalog, track.sourceId);
    const slugs = new Set([...(track.artistSlugs || []), ...(source?.artistSlugs || [])]);
    slugs.delete(artist.slug);
    for (const slug of slugs) counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([slug, shared]) => ({ artist: lookupArtist(catalog, slug), shared }))
    .filter((entry) => entry.artist)
    .sort((a, b) => b.shared - a.shared || a.artist.name.localeCompare(b.artist.name))
    .map((entry) => entry.artist);
}

// The series an artist appears in, with how many of their recordings each holds.
export function artistSeries(catalog, artist, sources) {
  const byName = seriesByName(catalog);
  const counts = new Map();
  for (const source of sources) {
    if (source.series) counts.set(source.series, (counts.get(source.series) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, series: byName.get(name) || null }))
    .filter((entry) => entry.series)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// What tells one recording of a song from another in a list row: the session name for
// multi-song sets, else the "(Live at …)" part of the title, else series and year. Parts that
// just repeat the page's own series are dropped ("Hard Times (Red Barn Radio)" on Red Barn Radio → "2016").
export function recordingLabel(track, source, { series = "" } = {}) {
  if (!source) return "";
  const repeatsSeries = (text) => Boolean(series) && foldText(text).includes(foldText(series));
  if ((source.tracks?.length || 0) > 1) return repeatsSeries(source.title) ? joinMeta([source.year]) : source.title;
  const title = String(source.title || "");
  const inner = title.match(/\(([^()]+)\)\s*$/)?.[1]?.trim() || "";
  if (inner && foldText(title) !== foldText(track?.title) && !repeatsSeries(inner)) return inner;
  return joinMeta([series ? "" : source.series, source.year]);
}

// Row copies whose album line carries recordingLabel (trackList prints sourceTitle there).
export function withRecordingLabels(catalog, tracks, options) {
  return tracks.map((track) => ({ ...track, sourceTitle: recordingLabel(track, lookupSource(catalog, track.sourceId), options) }));
}

/* ------------------------------------------------------------------ shared directory chrome */

export function directorySwitch(active) {
  const link = (key, href, label) => html`<a href="${href}"${active === key ? raw(' aria-current="page" class="is-active"') : ""}>${label}</a>`;
  return html`<nav class="segmented directory-switch" aria-label="Browse by">${link("artists", "#/artists", "Artists")}${link("series", "#/series", "Series")}</nav>`;
}

export function directoryFilter({ query = "", placeholder, label }) {
  return html`<div class="search-bar directory-filter" role="search">${icon("search", { size: 20 })}<input class="directory-filter-input" type="search" value="${query}" placeholder="${placeholder}" aria-label="${label}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" data-directory-filter></div>`;
}

export function directoryItem(markup, { filterText, isNew = false, hidden = false }) {
  return html`<div class="directory-item" data-directory-item data-filter="${foldText(filterText)}"${isNew ? raw(" data-new") : ""}${hidden ? raw(" hidden") : ""}>${markup}${isNew ? html`<span class="badge badge--new directory-new">New</span>` : ""}</div>`;
}

export function directoryEmpty({ noun, query, hidden }) {
  return html`<div class="directory-empty" data-directory-empty${hidden ? raw(" hidden") : ""}>${emptyState({ iconName: "search", title: "No matches", body: noMatchText(noun, query) })}</div>`;
}

function noMatchText(noun, query) {
  return `No ${noun} match “${String(query).trim()}”.`;
}

// Instant filtering without re-rendering: rows are hidden in place, so the input keeps focus,
// caret and IME state. The query is mirrored to ?q= so a re-render or reload keeps it.
export function mountDirectoryFilter(root, { ctx, basePath, noun, countLabel }) {
  const input = root.querySelector("[data-directory-filter]");
  if (!input) return () => {};
  const items = [...root.querySelectorAll("[data-directory-item]")];
  const empty = root.querySelector("[data-directory-empty]");
  const emptyBody = empty?.querySelector(".empty-body");
  const status = root.querySelector("[data-directory-status]");
  let lastFolded = foldText(input.value);
  let frame = 0;
  let urlTimer = 0;

  const syncUrl = () => {
    urlTimer = 0;
    const query = input.value.trim();
    const hash = query ? `${basePath}?q=${encodeURIComponent(query)}` : basePath;
    if (location.hash === hash || !location.hash.startsWith(basePath)) return;
    try {
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    } catch {
      // Safari rate-limits history updates; the filter itself still works.
    }
  };

  const apply = () => {
    frame = 0;
    const folded = foldText(input.value);
    if (folded === lastFolded) return;
    lastFolded = folded;
    const words = folded.split(" ").filter(Boolean);
    let shown = 0;
    for (const item of items) {
      const match = words.every((word) => (item.dataset.filter || "").includes(word));
      item.hidden = !match;
      if (match) shown += 1;
    }
    if (empty) {
      empty.hidden = shown > 0 || items.length === 0;
      if (!empty.hidden && emptyBody) emptyBody.textContent = noMatchText(noun, input.value);
    }
    if (status) status.textContent = words.length ? countLabel(shown) : "";
    clearTimeout(urlTimer);
    urlTimer = setTimeout(syncUrl, URL_SYNC_DELAY);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const onKeydown = (event) => {
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      apply();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (frame) {
        cancelAnimationFrame(frame);
        apply();
      }
      const first = items.find((item) => !item.hidden)?.querySelector("a[href]");
      if (!first || !input.value.trim()) return;
      input.blur();
      const href = first.getAttribute("href");
      if (typeof ctx?.navigate === "function") ctx.navigate(href);
      else location.hash = href;
    }
  };

  input.addEventListener("input", schedule);
  input.addEventListener("search", schedule);
  input.addEventListener("keydown", onKeydown);
  return () => {
    input.removeEventListener("input", schedule);
    input.removeEventListener("search", schedule);
    input.removeEventListener("keydown", onKeydown);
    if (frame) cancelAnimationFrame(frame);
    if (urlTimer) {
      clearTimeout(urlTimer);
      syncUrl();
    }
  };
}

export function pageTop() {
  return html`<div class="page-top"><button class="icon-btn" type="button" data-action="go-back" aria-label="Back">${icon("chevron-left", { size: 24 })}</button></div>`;
}

export function libraryEmptyAction(ctx) {
  return ctx?.syncStatus?.state === "unauthorized"
    ? html`<a class="btn btn-primary" href="#/settings?focus=library">Connect library</a>`
    : "";
}

/* ------------------------------------------------------------------ #/artists */

export function renderArtists(ctx, route) {
  const catalog = ctx?.catalog;
  const title = "Artists";
  const head = html`<div class="page-title-row"><h1>${title}</h1>${directorySwitch("artists")}</div>`;

  if (!catalog) {
    return { title, html: String(html`<div class="page directory directory--artists">${head}${skeletonGrid(9)}</div>`) };
  }

  const artists = Array.isArray(catalog.artists) ? catalog.artists : [];
  if (!artists.length) {
    const empty = emptyState({
      iconName: "artists",
      title: "No artists yet",
      body: "Artists show up here as music is added to your library.",
      actionHtml: libraryEmptyAction(ctx)
    });
    return { title, html: String(html`<div class="page directory directory--artists">${head}${empty}</div>`) };
  }

  const query = routeQuery(route);
  let shown = 0;
  const items = artists.map((artist) => {
    const match = matchesFilter(artist.name, query);
    if (match) shown += 1;
    return directoryItem(artistCard(artist), { filterText: artist.name, isNew: isNewAny(ctx, artist.sourceIds), hidden: !match });
  });
  const countLabel = (n) => pluralize(n, "artist");

  const markup = html`<div class="page directory directory--artists">${head}${directoryFilter({ query, placeholder: `Search ${countLabel(artists.length)}`, label: "Filter artists" })}<p class="sr-only" role="status" data-directory-status>${query ? countLabel(shown) : ""}</p>${grid(items, { variant: "artists" })}${directoryEmpty({ noun: "artists", query, hidden: shown > 0 })}</div>`;

  return {
    title,
    html: String(markup),
    after(root) {
      return mountDirectoryFilter(root, { ctx, basePath: "#/artists", noun: "artists", countLabel });
    }
  };
}

/* ------------------------------------------------------------------ #/artist/<slug> */

function artistNotFound() {
  const empty = emptyState({
    iconName: "artists",
    title: "Artist not found",
    body: "This artist isn’t in your library anymore.",
    actionHtml: html`<a class="btn btn-secondary" href="#/artists">Browse artists</a>`
  });
  return { title: "Artist not found", html: String(html`<div class="page artist-page">${pageTop()}${empty}</div>`) };
}

function popularSection(ctx, artist, tracks) {
  const expanded = expandedPopular.has(artist.slug);
  const collapsible = tracks.length > POPULAR_COLLAPSED;
  const queueId = registerQueue(ctx, `artist-${artist.slug}`, tracks);
  const list = trackList(withRecordingLabels(ctx.catalog, tracks), {
    ...listOptions(ctx, { type: "artist", id: artist.slug }),
    queueId,
    numbered: true,
    showArt: true,
    showArtist: false,
    showAlbum: true
  });
  const listId = `artist-popular-${artist.slug}`;
  const toggle = collapsible
    ? html`<button class="btn btn-ghost btn-sm artist-popular-toggle" type="button" data-popular-toggle aria-expanded="${expanded ? "true" : "false"}" aria-controls="${listId}" data-more-label="Show all ${tracks.length}">${expanded ? "Show less" : `Show all ${tracks.length}`}</button>`
    : "";
  const body = html`<div class="artist-popular${collapsible ? " is-collapsible" : ""}${expanded ? " is-expanded" : ""}" id="${listId}">${list}</div>${toggle}`;
  return sectionBlock({ title: tracks.length > 3 ? "Popular" : "Songs", body, className: "artist-section artist-section--popular" });
}

function releasesSection(ctx, title, sources) {
  if (!sources.length) return "";
  const cards = sources.map((source) => albumCard(source, { isNew: Boolean(call(ctx?.isNew, false, source.id)), subtitle: releaseSubtitle(source) }));
  return sectionBlock({ title, body: html`<div class="artist-releases">${grid(cards)}</div>`, className: "artist-section" });
}

function seriesSection(entries) {
  if (!entries.length) return "";
  const items = entries.map(({ name, count, series }) => ({
    label: count > 1 ? html`${name}<span class="artist-chip-count">${count}</span>` : name,
    href: `#/series/${encodeURIComponent(series.slug)}`,
    icon: "series",
    attrs: { "aria-label": count > 1 ? `${name}, ${pluralize(count, "recording")}` : name }
  }));
  return sectionBlock({ title: "Series", body: chips(items), className: "artist-section artist-section--series" });
}

function appearsWithSection(collaborators) {
  if (!collaborators.length) return "";
  return sectionBlock({ title: "Appears with", body: shelf(collaborators.map(artistCard)), className: "artist-section" });
}

export function renderArtist(ctx, route, slugArg) {
  const catalog = ctx?.catalog;
  const slug = safeSlug(slugArg ?? route?.segments?.[1] ?? "");
  if (!catalog) {
    return { title: "Artist", html: String(html`<div class="page artist-page">${skeletonGrid(6)}</div>`) };
  }
  const artist = lookupArtist(catalog, slug);
  if (!artist) return artistNotFound();

  const sources = sourcesOf(catalog, artist.sourceIds).sort(compareReleases);
  const tracks = rankArtistTracks(ctx, artist);
  const sessions = sources.filter((source) => (source.tracks?.length || 0) > 1);
  const singles = sources.filter((source) => (source.tracks?.length || 0) <= 1);
  // One recording of one song: the song row already says everything a release card would.
  const showReleases = !(sources.length === 1 && tracks.length <= 1);

  // Shuffle only means something with two songs or more.
  const shuffle = tracks.length > 1
    ? html`<button class="icon-btn" type="button" data-action="shuffle-artist" data-artist="${artist.slug}" aria-label="Shuffle ${artist.name}">${icon("shuffle", { size: 24 })}</button>`
    : "";
  const actions = tracks.length
    ? html`${playFab({ action: "play-artist", attrs: { artist: artist.slug, playArtist: artist.slug }, label: `Play ${artist.name}` })}${shuffle}`
    : "";

  const heroMarkup = hero({
    artItem: artist,
    shape: "circle",
    kicker: "Artist",
    title: artist.name,
    meta: [
      pluralize(tracks.length || artist.songCount || 0, "song"),
      pluralize(sources.length || artist.sourceCount || 0, "session"),
      tracks.length ? formatDurationLong(totalDuration(tracks)) : ""
    ],
    actionsHtml: actions
  });

  const markup = html`<div class="page artist-page">${pageTop()}${heroMarkup}${tracks.length ? popularSection(ctx, artist, tracks) : ""}${showReleases ? html`${releasesSection(ctx, "Sessions & albums", sessions)}${releasesSection(ctx, "Singles", singles)}` : ""}${seriesSection(artistSeries(catalog, artist, sources))}${appearsWithSection(collaboratorsOf(catalog, artist))}</div>`;

  return {
    title: artist.name,
    html: String(markup),
    after(root) {
      const onClick = (event) => {
        const button = event.target.closest?.("[data-popular-toggle]");
        if (!button || !root.contains(button)) return;
        const panel = root.querySelector(`#${CSS.escape(button.getAttribute("aria-controls") || "")}`);
        if (!panel) return;
        const expand = !panel.classList.contains("is-expanded");
        panel.classList.toggle("is-expanded", expand);
        button.setAttribute("aria-expanded", String(expand));
        button.textContent = expand ? "Show less" : button.dataset.moreLabel || "Show all";
        if (expand) {
          expandedPopular.add(artist.slug);
        } else {
          expandedPopular.delete(artist.slug);
          // Collapsing a long list can leave the reader far below it; bring the list head back.
          const head = panel.closest(".section");
          if (head && head.getBoundingClientRect().top < 0) {
            const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
            head.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
          }
        }
      };
      root.addEventListener("click", onClick);
      return () => root.removeEventListener("click", onClick);
    }
  };
}
