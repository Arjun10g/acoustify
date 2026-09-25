// Album / session page (#/album/<sourceId>): hero, actions, numbered song list, notes and
// "More by" the same artist.
import { icon } from "../icons.js";
import { albumCard, emptyState, hero, html, playFab, sectionBlock, shelf, skeletonList, trackList } from "../ui.js";
import { formatDurationLong, pluralize } from "../utils.js";
import { call, downloadToggle, isLiked, listState, lookupSource, moreButton, pageTop, registerQueue, releaseKind, releaseSubtitle, safeDecode, totalDuration } from "./library.js";

const MORE_LIMIT = 12;

const enc = (value) => encodeURIComponent(String(value ?? ""));

function artistSlugFor(catalog, source, index) {
  const slug = source.artistSlugs?.[index];
  if (slug) return slug;
  const name = source.artists?.[index];
  return catalog?.artists?.find?.((artist) => artist.name === name)?.slug || "";
}

function seriesSlugFor(catalog, source) {
  if (!source.series) return "";
  return source.seriesSlug || catalog?.series?.find?.((series) => series.name === source.series)?.slug || "";
}

// The display credit with each canonical artist linked in place: "Tyler Childers and the Food Stamps"
// → "<a>Tyler Childers</a> and the Food Stamps". Artists the credit does not name are appended.
export function creditMarkup(catalog, source) {
  const names = (Array.isArray(source.artists) ? source.artists : []).filter(Boolean);
  const credit = String(source.artist || names.join(" & ") || "");
  const lower = credit.toLowerCase();
  const found = [];
  const missing = [];
  names.forEach((name, index) => {
    const slug = artistSlugFor(catalog, source, index);
    const at = lower.indexOf(name.toLowerCase());
    const overlaps = found.some((match) => at < match.at + match.name.length && match.at < at + name.length);
    if (at >= 0 && !overlaps) found.push({ at, name: credit.slice(at, at + name.length), slug });
    else if (at < 0) missing.push({ name, slug });
  });
  found.sort((a, b) => a.at - b.at);
  const link = ({ name, slug }) => (slug ? html`<a href="#/artist/${enc(slug)}">${name}</a>` : html`${name}`);
  const parts = [];
  let cursor = 0;
  for (const match of found) {
    parts.push(html`${credit.slice(cursor, match.at)}`, link(match));
    cursor = match.at + match.name.length;
  }
  parts.push(html`${credit.slice(cursor)}`);
  missing.forEach((entry, index) => {
    const separator = parts.length > 1 || credit ? (index === missing.length - 1 ? " & " : ", ") : "";
    parts.push(html`${separator}`, link(entry));
  });
  return html`${parts}`;
}

function formatAdded(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Other recordings by the primary artist, else from the same series; newest first.
function moreSection(ctx, source) {
  const catalog = ctx.catalog;
  // Under "More by <artist>" the artist goes without saying; under "More from <series>" it is the point.
  const card = (item, subtitle) => albumCard(item, { isNew: Boolean(call(ctx.isNew, false, item.id)), subtitle });
  const others = (ids) => (Array.isArray(ids) ? ids : []).filter((id) => id !== source.id).map((id) => lookupSource(catalog, id)).filter(Boolean);

  const slug = artistSlugFor(catalog, source, 0);
  const artist = slug ? catalog?.artistBySlug?.get?.(slug) : null;
  const byArtist = others(artist?.sourceIds);
  if (artist && byArtist.length) {
    return sectionBlock({
      title: `More by ${artist.name}`,
      href: byArtist.length > MORE_LIMIT ? `#/artist/${enc(artist.slug)}` : "",
      body: shelf(byArtist.slice(0, MORE_LIMIT).map((item) => card(item, releaseSubtitle(item)))),
      className: "album-more"
    });
  }
  const seriesSlug = seriesSlugFor(catalog, source);
  const series = seriesSlug ? catalog?.seriesBySlug?.get?.(seriesSlug) : null;
  const inSeries = others(series?.sourceIds);
  if (series && inSeries.length) {
    return sectionBlock({
      title: `More from ${series.name}`,
      href: inSeries.length > MORE_LIMIT ? `#/series/${enc(series.slug)}` : "",
      body: shelf(inSeries.slice(0, MORE_LIMIT).map((item) => card(item))),
      className: "album-more"
    });
  }
  return "";
}

// Description and date only. Where the song times came from is shown on the Edit song times page;
// here the only timing line is the way in when a recording still has none.
function footer(source) {
  const added = formatAdded(source.added);
  const description = String(source.description || "").trim();
  const needsTimes = source.timingStatus === "calibration-required";
  if (!description && !added && !needsTimes) return "";
  return html`<footer class="album-footer">${description ? html`<p class="album-description">${description}</p>` : ""}${added ? html`<p class="album-added">Added ${added}</p>` : ""}${needsTimes ? html`<p class="album-note"><a href="#/edit/${enc(source.id)}">Set song times</a></p>` : ""}</footer>`;
}

function loadingView() {
  return {
    title: "Album",
    html: String(html`<div class="page album-page">${pageTop()}<div class="album-skeleton-hero" aria-hidden="true"><span class="skeleton album-skeleton-art"></span><span class="album-skeleton-text"><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-text skeleton-text--short"></span></span></div>${skeletonList(6)}</div>`)
  };
}

function notFoundView() {
  const empty = emptyState({
    iconName: "disc",
    title: "Album not found",
    body: "It may have been removed from your library.",
    actionHtml: html`<a class="btn btn-secondary" href="#/library?tab=albums">Browse albums</a>`
  });
  return { title: "Album not found", html: String(html`<div class="page album-page">${pageTop()}${empty}</div>`) };
}

export function renderAlbum(ctx, route, sourceIdArg) {
  const id = safeDecode(sourceIdArg ?? route?.segments?.[1] ?? "");
  const catalog = ctx?.catalog;
  const syncing = ["syncing", "idle"].includes(ctx?.syncStatus?.state);
  if (!catalog || (!catalog.sources?.length && syncing)) return loadingView();

  const source = lookupSource(catalog, id);
  if (!source) return notFoundView();

  const tracks = Array.isArray(source.tracks) ? source.tracks.filter(Boolean) : [];
  const isSession = tracks.length > 1;
  const title = source.title || "Untitled";
  const duration = totalDuration(tracks) || Number(source.duration) || 0;
  const seriesSlug = seriesSlugFor(catalog, source);
  const seriesMeta = source.series
    ? (seriesSlug ? html`<a href="#/series/${enc(seriesSlug)}">${source.series}</a>` : source.series)
    : "";

  let secondary = "";
  if (isSession) {
    secondary = html`<button class="icon-btn" type="button" data-action="shuffle-source" data-source-id="${source.id}" aria-label="Shuffle ${title}">${icon("shuffle")}</button>`;
  } else if (tracks.length === 1) {
    // A single is one song, so the album page can like it directly.
    const track = tracks[0];
    const liked = isLiked(ctx, track.key);
    secondary = html`<button class="icon-btn${liked ? " is-active" : ""}" type="button" data-action="toggle-like" data-like-key="${track.key}" aria-pressed="${liked ? "true" : "false"}" aria-label="Like ${track.title || title}">${icon(liked ? "heart-fill" : "heart")}</button>`;
  }
  const actions = html`${tracks.length ? playFab({ action: "play-source", attrs: { sourceId: source.id, playSource: source.id }, label: `Play ${title}` }) : ""}${secondary}${downloadToggle(ctx, source)}${moreButton({ action: "source-menu", data: { "source-id": source.id }, label: `More options for ${title}` })}`;

  const heroMarkup = hero({
    artItem: source,
    shape: "square",
    kicker: releaseKind(source),
    title,
    subtitleHtml: creditMarkup(catalog, source),
    meta: [seriesMeta, source.year ? String(source.year) : "", isSession ? pluralize(tracks.length, "song") : "", duration ? formatDurationLong(duration) : ""],
    actionsHtml: actions
  });

  const list = tracks.length
    ? trackList(tracks, {
      ...listState(ctx),
      queueId: registerQueue(ctx, `album-${source.id}`, tracks),
      numbered: true,
      showArt: false,
      showAlbum: false,
      // Only worth a line when a song credits someone other than the album artist.
      showArtist: tracks.some((track) => track.artist && track.artist !== source.artist),
      context: { type: "album", id: source.id }
    })
    : emptyState({ iconName: "songs", title: "No songs listed", body: "This recording has no song list yet.", actionHtml: html`<a class="btn btn-secondary" href="#/edit/${enc(source.id)}">Set song times</a>` });

  const markup = html`<div class="page album-page${isSession ? " album-page--session" : " album-page--single"}">${pageTop()}${heroMarkup}<div class="album-tracks">${list}</div>${footer(source)}${moreSection(ctx, source)}</div>`;
  return { title, html: String(markup) };
}
