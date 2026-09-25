// Search: instant results as you type. Only #search-results is re-rendered, so the input keeps
// focus, caret and IME state; the query is mirrored into the URL with replaceState.
import { icon } from "../icons.js";
import { albumCard, art, artistCard, chips, emptyState, grid, html, sectionBlock, seriesCard, shelf, skeletonList, trackList } from "../ui.js";
import { joinMeta, pluralize, sortName } from "../utils.js";
import { releaseKind } from "./library.js";
import { trackListState, tracksForDisplay } from "./songs.js";

const DEBOUNCE_MS = 80;
const SONG_LIMIT = 8;
const SPLIT_SONG_LIMIT = 4; // rows beside the top result on wide layouts (CSS hides the rest)
const SHELF_LIMIT = 12;
const BROWSE_SERIES_LIMIT = 8;
const BROWSE_ARTIST_LIMIT = 16;
const TOP_RESULT_MIN = 55;
const AMBIGUITY_PENALTY = 20;
const MEMO_TTL = 2000;
const DESKTOP_QUERY = "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

const enc = (value) => encodeURIComponent(String(value ?? ""));

/* ------------------------------------------------------------------ matching (pure) */

// Case-, accent- and punctuation-insensitive: "Peña" → "pena", "Stone's Throw" → "stones throw".
export function foldText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['`\u2018\u2019\u00b4]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// `bare` is the name without a leading "The", so "red" starts "The Red Clay Strays" as well.
function entry(item, order, primary, fields) {
  return {
    item,
    order,
    primary: foldText(primary),
    bare: foldText(sortName(primary)),
    text: ` ${foldText(fields.filter((field) => field !== null && field !== undefined && field !== "").join(" "))}`
  };
}

// Built once per catalog object; a library update produces a new catalog and so a new index.
const indexCache = new WeakMap();

function searchIndex(catalog) {
  const cached = indexCache.get(catalog);
  if (cached) return cached;
  const sources = catalog.sources || [];
  const sourceById = catalog.sourceById || new Map(sources.map((source) => [source.id, source]));
  const index = {
    songs: (catalog.tracks || []).map((track, order) => {
      const source = sourceById.get(track.sourceId);
      return entry(track, order, track.title, [track.title, track.artist, ...(track.artists || []), track.sourceTitle, track.series, ...(source?.tags || [])]);
    }),
    albums: sources.map((source, order) => entry(source, order, source.title, [source.title, source.artist, ...(source.artists || []), source.series, source.year, ...(source.tags || [])])),
    artists: (catalog.artists || []).map((artist, order) => entry(artist, order, artist.name, [artist.name])),
    series: (catalog.series || []).map((series, order) => entry(series, order, series.name, [series.name]))
  };
  indexCache.set(catalog, index);
  return index;
}

// Short words must start a word ("af" → "Western AF"); longer ones may match anywhere ("ilder" → "Childers").
function hasWord(text, word) {
  return text.includes(` ${word}`) || (word.length >= 3 && text.includes(word));
}

function scoreEntry(item, words, phrase) {
  for (const word of words) if (!hasWord(item.text, word)) return 0;
  const { primary, bare } = item;
  if (primary === phrase || bare === phrase) return 100;
  if (primary.startsWith(phrase) || bare.startsWith(phrase)) return 85;
  const spaced = ` ${primary}`;
  if (spaced.includes(` ${phrase}`)) return 70;
  if (words.every((word) => hasWord(spaced, word))) return 55;
  return 20; // matched through artist / album / series / tags only
}

function rank(entries, words, phrase, boost) {
  const hits = [];
  for (const item of entries) {
    const score = scoreEntry(item, words, phrase);
    if (score) hits.push({ item, score, boost: boost ? boost(item.item) : 0 });
  }
  hits.sort((a, b) => b.score - a.score || b.boost - a.boost || a.item.order - b.item.order);
  return hits;
}

// Two equally good hits of one kind ("tiny desk" → two Tiny Desk sessions) make that kind a weak
// top result; the series or artist that groups them is the better answer.
function topCandidate(kind, hits, priority) {
  if (!hits.length) return null;
  const ambiguous = hits.length > 1 && hits[1].score === hits[0].score;
  return { kind, item: hits[0].item.item, score: hits[0].score - (ambiguous ? AMBIGUITY_PENALTY : 0), priority };
}

export function searchCatalog(catalog, query, { playCount } = {}) {
  const phrase = foldText(query);
  const words = phrase ? [...new Set(phrase.split(" "))] : [];
  if (!catalog || !words.length) return { query: phrase, top: null, songs: [], artists: [], albums: [], series: [], total: 0 };
  const index = searchIndex(catalog);
  const plays = typeof playCount === "function" ? (track) => Number(playCount(track.key)) || 0 : null;
  const songs = rank(index.songs, words, phrase, plays);
  const artists = rank(index.artists, words, phrase, (artist) => artist.songCount || 0);
  const albums = rank(index.albums, words, phrase);
  const series = rank(index.series, words, phrase, (item) => item.sourceCount || 0);
  const [top] = [topCandidate("artist", artists, 3), topCandidate("series", series, 2), topCandidate("album", albums, 1)]
    .filter((candidate) => candidate && candidate.score >= TOP_RESULT_MIN)
    .sort((a, b) => b.score - a.score || b.priority - a.priority);
  const items = (hits) => hits.map((hit) => hit.item.item);
  return {
    query: phrase,
    top: top ? { kind: top.kind, item: top.item } : null,
    songs: items(songs),
    artists: items(artists),
    albums: items(albums),
    series: items(series),
    total: songs.length + artists.length + albums.length + series.length
  };
}

/* ------------------------------------------------------------------ markup */

function topCard({ kind, href, title, artItem, circle = false, label, meta, playAttrs }) {
  return html`<article class="card top-result top-result--${kind}"><div class="card-art top-result-art">${art(artItem, { size: 208, shape: circle ? "circle" : "square" })}</div><a class="card-link top-result-link" href="${href}" title="${title}"><span class="top-result-title">${title}</span></a><p class="top-result-sub"><span class="badge">${label}</span>${meta ? html`<span class="top-result-meta">${meta}</span>` : ""}</p><button class="card-play" type="button"${playAttrs} aria-label="Play ${title}">${icon("play-fill", { size: 22 })}</button></article>`;
}

function topResultMarkup({ kind, item }) {
  if (kind === "artist") {
    return topCard({
      kind,
      href: `#/artist/${enc(item.slug)}`,
      title: item.name,
      artItem: item,
      circle: true,
      label: "Artist",
      meta: item.songCount ? pluralize(item.songCount, "song") : "",
      playAttrs: html` data-action="play-artist" data-artist="${item.slug}" data-play-artist="${item.slug}"`
    });
  }
  if (kind === "series") {
    return topCard({
      kind,
      href: `#/series/${enc(item.slug)}`,
      title: item.name,
      artItem: item,
      label: "Series",
      meta: joinMeta([item.sourceCount ? pluralize(item.sourceCount, "session") : "", item.songCount ? pluralize(item.songCount, "song") : ""]),
      playAttrs: html` data-action="play-series" data-series="${item.slug}" data-play-series="${item.slug}"`
    });
  }
  return topCard({
    kind: "album",
    href: `#/album/${enc(item.id)}`,
    title: item.title,
    artItem: item,
    label: releaseKind(item),
    meta: item.artist,
    playAttrs: html` data-action="play-source" data-source-id="${item.id}" data-play-source="${item.id}"`
  });
}

function songsSection(ctx, songs, { split, expanded }) {
  const shown = expanded ? songs : songs.slice(0, SONG_LIMIT);
  const queueId = typeof ctx.registerQueue === "function" ? ctx.registerQueue("search", songs) : undefined;
  const hiddenWhenStacked = split && !expanded && songs.length > SPLIT_SONG_LIMIT && songs.length <= SONG_LIMIT;
  const canToggle = expanded || songs.length > (split ? SPLIT_SONG_LIMIT : SONG_LIMIT);
  const toggle = canToggle
    ? html`<button class="section-link search-more${hiddenWhenStacked ? " search-more--split-only" : ""}" type="button" data-search-more aria-expanded="${expanded ? "true" : "false"}">${expanded ? "Show less" : "Show all"}</button>`
    : "";
  const list = trackList(tracksForDisplay(ctx.catalog, shown), {
    queueId,
    numbered: false,
    showArt: true,
    showAlbum: true,
    context: { type: "search", id: "" },
    ...trackListState(ctx, shown)
  });
  return html`<section class="section search-songs"><div class="section-head"><h2>Songs</h2>${toggle}</div>${list}</section>`;
}

function capitalize(text) {
  const value = String(text || "");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function browseMarkup(catalog) {
  if (!catalog.sources?.length) {
    return emptyState({ iconName: "search", title: "Nothing to search yet", body: "Your music will show up here once your library syncs." });
  }
  const tags = catalog.tags || [];
  const tagChips = tags.length
    ? html`<div class="search-tags">${chips(tags.map((tag) => ({ label: capitalize(tag), href: `#/search?q=${enc(tag)}`, attrs: { searchTerm: tag } })))}</div>`
    : "";
  const allSeries = catalog.series || [];
  const seriesBlock = allSeries.length
    ? sectionBlock({
      title: "Browse",
      href: allSeries.length > BROWSE_SERIES_LIMIT ? "#/series" : "",
      linkLabel: "All series",
      body: grid(allSeries.slice(0, BROWSE_SERIES_LIMIT).map(seriesCard), { variant: "series" })
    })
    : "";
  const artists = [...(catalog.artists || [])]
    .sort((a, b) => (b.songCount || 0) - (a.songCount || 0))
    .slice(0, BROWSE_ARTIST_LIMIT);
  const artistBlock = artists.length
    ? sectionBlock({ title: "Artists", href: "#/artists", body: shelf(artists.map(artistCard)) })
    : "";
  return html`${tagChips}${seriesBlock}${artistBlock}`;
}

// → { markup, total } where total is -1 for the browse page (nothing was searched).
function resultsMarkup(ctx, query, { expanded = false } = {}) {
  const catalog = ctx.catalog;
  if (!catalog) return { markup: skeletonList(6), total: -1 };
  if (!foldText(query)) return { markup: browseMarkup(catalog), total: -1 };

  const result = searchCatalog(catalog, query, { playCount: ctx.playCount });
  if (!result.total) {
    return {
      markup: emptyState({ iconName: "search", title: `No results for “${String(query).trim()}”`, body: "Try a different spelling or a shorter search." }),
      total: 0
    };
  }

  const split = Boolean(result.top && result.songs.length);
  const top = result.top
    ? html`<section class="section search-top-result"><div class="section-head"><h2>Top result</h2></div>${topResultMarkup(result.top)}</section>`
    : "";
  const songs = result.songs.length ? songsSection(ctx, result.songs, { split, expanded }) : "";
  const topRow = top || songs
    ? html`<div class="search-top${split ? " search-top--split" : ""}${expanded ? " is-expanded" : ""}">${top}${songs}</div>`
    : "";
  const artists = result.artists.length
    ? sectionBlock({ title: "Artists", body: shelf(result.artists.slice(0, SHELF_LIMIT).map(artistCard)) })
    : "";
  const albums = result.albums.length
    ? sectionBlock({ title: "Albums", body: shelf(result.albums.slice(0, SHELF_LIMIT).map((source) => albumCard(source))) })
    : "";
  const series = result.series.length
    ? sectionBlock({ title: "Series", body: shelf(result.series.slice(0, SHELF_LIMIT).map(seriesCard)) })
    : "";
  return { markup: html`${topRow}${artists}${albums}${series}`, total: result.total };
}

/* ------------------------------------------------------------------ view */

// Survives one re-render of this view (e.g. a library update while typing) so focus, caret,
// an unflushed keystroke and the expanded Songs list are not lost.
let focusMemo = null;

function isDesktop() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.(DESKTOP_QUERY).matches);
}

function isSearchHash(hash) {
  return /^#\/search(?:[?/]|$)/.test(hash);
}

function syncUrl(query) {
  if (!isSearchHash(location.hash)) return; // navigation already moved on; never clobber it
  const q = String(query || "").trim();
  const hash = q ? `#/search?q=${enc(q)}` : "#/search";
  if (location.hash === hash) return;
  try {
    history.replaceState(history.state, "", hash);
  } catch {
    // Sandboxed documents can refuse replaceState; results are already on screen.
  }
}

function statusText(total, query) {
  if (total < 0) return "";
  return total ? `${pluralize(total, "result")} for ${String(query).trim()}` : `No results for ${String(query).trim()}`;
}

export function renderSearch(ctx, route) {
  const query = route?.params?.get?.("q") || "";
  const initial = resultsMarkup(ctx, query);
  const markup = html`<div class="page page--search"><div class="page-title-row"><h1>Search</h1></div><form class="search-bar" role="search" action="#/search" autocomplete="off">${icon("search")}<input id="search-input" type="search" name="q" value="${query}" placeholder="Artists, songs or series" aria-label="Search your music" aria-controls="search-results" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></form><p id="search-status" class="sr-only" role="status" aria-live="polite"></p><div id="search-results" class="search-results">${initial.markup}</div></div>`;
  return {
    title: "Search",
    html: String(markup),
    after: (root) => mountSearch(root, ctx, query)
  };
}

function mountSearch(root, ctx, initialQuery) {
  const input = root.querySelector("#search-input");
  const form = input?.form || root.querySelector(".search-bar");
  const results = root.querySelector("#search-results");
  const status = root.querySelector("#search-status");
  if (!input || !results) return undefined;

  let committed = initialQuery; // query currently rendered in #search-results and mirrored in the URL
  let expanded = false;
  let timer = 0;

  const scrollResultsIntoView = () => {
    const bar = form?.getBoundingClientRect();
    const top = results.getBoundingClientRect().top;
    const scroller = root.closest(".main") || document.getElementById("main");
    // Only when the user had scrolled past the start of the results: new results start at the top.
    if (bar && scroller && top < bar.bottom) scroller.scrollTop -= bar.bottom - top;
  };

  const render = ({ keepPosition = false } = {}) => {
    const { markup, total } = resultsMarkup(ctx, committed, { expanded });
    results.innerHTML = String(markup);
    if (status) status.textContent = statusText(total, committed);
    if (!keepPosition) scrollResultsIntoView();
  };

  const commit = (value, { force = false } = {}) => {
    clearTimeout(timer);
    timer = 0;
    const changed = foldText(value) !== foldText(committed);
    committed = value;
    syncUrl(value);
    if (!changed && !force) return;
    expanded = false;
    render();
  };

  const onInput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => commit(input.value), DEBOUNCE_MS);
  };

  const onSubmit = (event) => {
    event.preventDefault();
    commit(input.value);
    if (!isDesktop()) input.blur(); // "Search" on a phone keyboard means "show me", so drop the keyboard
  };

  const onKeydown = (event) => {
    if (event.key !== "ArrowDown" || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    if (timer) commit(input.value);
    const first = results.querySelector("a[href], button:not([disabled])");
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const term = target.closest("[data-search-term]");
    if (term && root.contains(term)) {
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      input.value = term.dataset.searchTerm || "";
      commit(input.value, { force: true });
      if (isDesktop()) input.focus({ preventScroll: true });
      return;
    }
    const more = target.closest("[data-search-more]");
    if (more && results.contains(more)) {
      expanded = !expanded;
      render({ keepPosition: true });
      const toggle = results.querySelector("[data-search-more]");
      toggle?.focus({ preventScroll: expanded });
    }
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  form?.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);

  const memo = focusMemo;
  focusMemo = null;
  const sameState = memo && Date.now() - memo.at < MEMO_TTL && memo.urlQuery.trim() === String(initialQuery).trim();
  if (sameState) {
    if (memo.value !== input.value || memo.expanded) {
      input.value = memo.value;
      committed = memo.value;
      expanded = memo.expanded;
      syncUrl(committed);
      render({ keepPosition: true });
    }
    if (memo.focused) {
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(memo.start, memo.end);
      } catch {
        // Some input types refuse selection APIs; focus is what matters.
      }
    }
  } else if (isDesktop()) {
    input.focus({ preventScroll: true });
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      // See above.
    }
  }

  return () => {
    clearTimeout(timer);
    focusMemo = {
      at: Date.now(),
      value: input.value,
      urlQuery: committed,
      expanded,
      focused: document.activeElement === input,
      start: input.selectionStart ?? input.value.length,
      end: input.selectionEnd ?? input.value.length
    };
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKeydown);
    form?.removeEventListener("submit", onSubmit);
    root.removeEventListener("click", onClick);
  };
}
