// Songs: every track in the library with Play / Shuffle and in-place sorting. Same header as the
// other song collections (Liked Songs, Recently played, playlists): title, meta, actions row.
import { icon } from "../icons.js";
import { chips, emptyState, hero, html, playFab, skeletonList, trackList } from "../ui.js";
import { formatDurationLong, pluralize, sortName } from "../utils.js";
import { pageTop } from "./library.js";

export const SONG_SORTS = Object.freeze([
  Object.freeze({ value: "title", label: "Title" }),
  Object.freeze({ value: "artist", label: "Artist" }),
  Object.freeze({ value: "added", label: "Recently added" })
]);
const DEFAULT_SORT = "title";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const compare = (a, b) => collator.compare(String(a ?? ""), String(b ?? ""));

export function songSort(value) {
  return SONG_SORTS.some((option) => option.value === value) ? value : DEFAULT_SORT;
}

// The controller should build play-all-songs / shuffle-all-songs queues with this same function
// so "Play" always starts at the first row the user sees.
export function sortSongs(catalog, sort = DEFAULT_SORT) {
  const tracks = [...(catalog?.tracks || [])];
  const key = songSort(sort);
  if (key === "added") {
    const rank = new Map((catalog.sourcesByAdded || catalog.sources || []).map((source, index) => [source.id, index]));
    const at = (track) => rank.get(track.sourceId) ?? Number.MAX_SAFE_INTEGER;
    return tracks.sort((a, b) => at(a) - at(b) || (a.index ?? 0) - (b.index ?? 0));
  }
  if (key === "artist") {
    return tracks.sort((a, b) => compare(sortName(a.artist), sortName(b.artist))
      || compare(a.sourceTitle, b.sourceTitle)
      || (a.index ?? 0) - (b.index ?? 0));
  }
  return tracks.sort((a, b) => compare(sortName(a.title), sortName(b.title))
    || compare(sortName(a.artist), sortName(b.artist))
    || compare(a.sourceTitle, b.sourceTitle));
}

// Live playback / like / offline state for a freshly rendered trackList. Reads the player directly
// because list re-renders (sorting, typing in search) can happen long after ctx was built.
export function trackListState(ctx, tracks = []) {
  const player = ctx?.player;
  const currentKey = player?.currentTrack?.key ?? ctx?.currentKey ?? null;
  const isPlaying = typeof player?.isPlaying === "boolean" ? player.isPlaying : Boolean(ctx?.isPlaying);
  let likedKeys;
  if (typeof ctx?.isLiked === "function") {
    likedKeys = new Set(tracks.filter((track) => ctx.isLiked(track.key)).map((track) => track.key));
  } else {
    likedKeys = ctx?.likedKeys instanceof Set ? ctx.likedKeys : new Set(ctx?.likedKeys || []);
  }
  const offlineReady = typeof ctx?.downloadState === "function"
    ? (track) => ctx.downloadState(track.sourceId)?.state === "done"
    : null;
  return { currentKey, isPlaying, likedKeys, offlineReady };
}

// A single's "album" is usually its own title again ("Cold (Live)" · "Cold (Live)"), so those rows
// show the series instead, or nothing. Copies only; keys and queue contents are unchanged.
export function tracksForDisplay(catalog, tracks = []) {
  return tracks.map((track) => {
    const source = catalog?.sourceById?.get(track.sourceId);
    if (!source || (source.tracks?.length || 0) > 1) return track;
    return { ...track, sourceTitle: track.series || "" };
  });
}

function sortHref(value) {
  return value === DEFAULT_SORT ? "#/songs" : `#/songs?sort=${encodeURIComponent(value)}`;
}

function songRows(ctx, tracks, sort) {
  const queueId = typeof ctx.registerQueue === "function" ? ctx.registerQueue(`songs-${sort}`, tracks) : undefined;
  return trackList(tracksForDisplay(ctx.catalog, tracks), {
    queueId,
    numbered: false,
    showArt: true,
    showAlbum: true,
    context: { type: "songs", id: "" },
    ...trackListState(ctx, tracks)
  });
}

// Phones reach Songs from Library, so it gets the back button there; on desktop it is a sidebar page.
function head(meta = [], actionsHtml = "") {
  return html`${pageTop({ mobileOnly: true })}${hero({ title: "Songs", meta, actionsHtml })}`;
}

// data-play-songs is the live-state hook: the button shows pause while this sort order is playing.
function actionsMarkup(sort, count) {
  const shuffle = count > 1
    ? html`<button class="icon-btn" type="button" data-action="shuffle-all-songs" data-sort="${sort}" aria-label="Shuffle all songs">${icon("shuffle")}</button>`
    : "";
  return html`${playFab({ action: "play-all-songs", attrs: { sort, playSongs: sort }, label: "Play all songs" })}${shuffle}`;
}

export function renderSongs(ctx, route) {
  const catalog = ctx.catalog;
  let sort = songSort(route?.params?.get?.("sort"));

  if (!catalog) {
    return { title: "Songs", html: String(html`<div class="page page--songs">${head()}${skeletonList(10)}</div>`) };
  }
  const tracks = sortSongs(catalog, sort);
  if (!tracks.length) {
    const empty = emptyState({ iconName: "songs", title: "No songs yet", body: "Songs from your library will show up here." });
    return { title: "Songs", html: String(html`<div class="page page--songs">${head()}${empty}</div>`) };
  }

  const total = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  const sortChips = chips(SONG_SORTS.map((option) => ({
    label: option.label,
    href: sortHref(option.value),
    active: option.value === sort,
    attrs: { songSort: option.value }
  })));

  const meta = [pluralize(tracks.length, "song"), total >= 60 ? formatDurationLong(total) : ""];
  const markup = html`<div class="page page--songs">${head(meta, actionsMarkup(sort, tracks.length))}<div class="songs-toolbar"><nav class="songs-sort" aria-label="Sort songs">${sortChips}</nav></div><div class="songs-list">${songRows(ctx, tracks, sort)}</div></div>`;

  return {
    title: "Songs",
    html: String(markup),
    after(root) {
      const list = root.querySelector(".songs-list");
      if (!list) return undefined;

      const applySort = (next) => {
        sort = next;
        list.innerHTML = String(songRows(ctx, sortSongs(ctx.catalog, sort), sort));
        root.querySelectorAll("[data-song-sort]").forEach((chip) => {
          const active = chip.dataset.songSort === sort;
          chip.classList.toggle("is-active", active);
          if (active) chip.setAttribute("aria-current", "true");
          else chip.removeAttribute("aria-current");
        });
        root.querySelectorAll('[data-action="play-all-songs"], [data-action="shuffle-all-songs"]').forEach((button) => {
          button.dataset.sort = sort;
          if (button.dataset.playSongs !== undefined) button.dataset.playSongs = sort;
        });
        // Replace rather than push: re-sorting is not a place the back button should revisit.
        if (/^#\/songs(?:[?/]|$)/.test(location.hash)) {
          try {
            history.replaceState(history.state, "", sortHref(sort));
            // Tell the controller the route's query changed in place (play context follows the sort).
            window.dispatchEvent(new CustomEvent("acoustify:route-replaced"));
          } catch {
            // Sandboxed documents can refuse replaceState; the list is already sorted.
          }
        }
      };

      const onClick = (event) => {
        const chip = event.target.closest?.("[data-song-sort]");
        if (!chip || !root.contains(chip)) return;
        if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const next = songSort(chip.dataset.songSort);
        if (next !== sort) applySort(next);
      };

      root.addEventListener("click", onClick);
      return () => root.removeEventListener("click", onClick);
    }
  };
}
