// Playlist page (#/playlist/<id>): mosaic cover, name, description, actions and the song list.
import { icon } from "../icons.js";
import { art, emptyState, html, playFab, skeletonList, trackList } from "../ui.js";
import { formatDurationLong, pluralize } from "../utils.js";
import { listState, moreButton, pageTop, registerQueue, rowLabels, safeDecode, totalDuration, tracksFor } from "./library.js";

// Up to four different recordings, in playlist order, for the cover.
export function coverItems(tracks = []) {
  const seen = new Set();
  const covers = [];
  for (const track of tracks) {
    const key = track?.sourceId || track?.artwork || track?.fallbackArtwork;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    covers.push(track);
    if (covers.length === 4) break;
  }
  return covers;
}

function coverMarkup(covers) {
  if (covers.length === 4) return html`<span class="mosaic">${covers.map((item) => art(item, { size: 160, eager: true }))}</span>`;
  if (covers.length) return art(covers[0], { size: 320, eager: true });
  return html`<span class="card-placeholder">${icon("songs", { size: 64 })}</span>`;
}

function playlistHero(playlist, tracks) {
  const covers = coverItems(tracks);
  const name = playlist.name || "Untitled playlist";
  const description = String(playlist.description || "").trim();
  const meta = tracks.length ? [pluralize(tracks.length, "song"), formatDurationLong(totalDuration(tracks))] : ["No songs yet"];
  const backdrop = covers.length ? html`<div class="hero-backdrop" aria-hidden="true">${art(covers[0], { size: 160, eager: true })}</div>` : "";
  return html`<header class="hero hero--playlist">${backdrop}<div class="hero-art playlist-cover">${coverMarkup(covers)}</div><div class="hero-text"><p class="hero-kicker">Playlist</p><h1 class="hero-title">${name}</h1>${description ? html`<p class="hero-desc">${description}</p>` : ""}<p class="hero-meta">${meta.map((item) => html`<span>${item}</span>`)}</p></div></header>`;
}

function notFoundView() {
  const empty = emptyState({
    iconName: "list",
    title: "Playlist not found",
    body: "It may have been deleted on this device.",
    actionHtml: html`<a class="btn btn-secondary" href="#/library?tab=playlists">Your playlists</a>`
  });
  return { title: "Playlist not found", html: String(html`<div class="page playlist-page">${pageTop()}${empty}</div>`) };
}

export function renderPlaylist(ctx, route, playlistIdArg) {
  const id = safeDecode(playlistIdArg ?? route?.segments?.[1] ?? "");
  const playlists = Array.isArray(ctx?.state?.playlists) ? ctx.state.playlists : [];
  const playlist = playlists.find((item) => item?.id === id);
  if (!playlist) return notFoundView();

  const name = playlist.name || "Untitled playlist";
  const catalog = ctx?.catalog;
  const keys = Array.isArray(playlist.trackKeys) ? playlist.trackKeys : [];
  const tracks = tracksFor(catalog, keys);
  const menu = moreButton({ action: "playlist-menu", data: { "playlist-id": playlist.id }, label: `More options for ${name}` });

  // Songs saved before the library has loaded would otherwise flash an "empty playlist" state.
  const waiting = keys.length && !tracks.length && (!catalog?.sources?.length) && ["syncing", "idle"].includes(ctx?.syncStatus?.state);
  // With nothing to play, the ••• menu (Rename, Delete) moves up beside the back button instead of
  // standing alone in an otherwise empty actions row.
  if (!catalog || waiting) {
    return { title: name, html: String(html`<div class="page playlist-page">${pageTop({ trailing: menu })}${playlistHero(playlist, [])}${skeletonList(Math.min(8, keys.length || 6))}</div>`) };
  }

  if (!tracks.length) {
    const empty = emptyState({
      iconName: "search",
      title: "Let’s find some songs",
      body: "Use ••• on any song and choose Add to playlist.",
      actionHtml: html`<a class="btn btn-primary" href="#/songs">Browse songs</a><a class="btn btn-secondary" href="#/search">Search</a>`
    });
    return { title: name, html: String(html`<div class="page playlist-page playlist-page--empty">${pageTop({ trailing: menu })}${playlistHero(playlist, [])}${empty}</div>`) };
  }

  const shuffle = tracks.length > 1
    ? html`<button class="icon-btn" type="button" data-action="shuffle-playlist" data-playlist-id="${playlist.id}" aria-label="Shuffle ${name}">${icon("shuffle")}</button>`
    : "";
  const actions = html`${playFab({ action: "play-playlist", attrs: { playlistId: playlist.id, playPlaylist: playlist.id }, label: `Play ${name}` })}${shuffle}${menu}`;
  const list = trackList(rowLabels(catalog, tracks), {
    ...listState(ctx),
    queueId: registerQueue(ctx, `playlist-${playlist.id}`, tracks),
    numbered: false,
    showArt: true,
    showAlbum: true,
    context: { type: "playlist", id: playlist.id }
  });
  return { title: name, html: String(html`<div class="page playlist-page">${pageTop()}${playlistHero(playlist, tracks)}<div class="actions-row">${actions}</div>${list}</div>`) };
}
