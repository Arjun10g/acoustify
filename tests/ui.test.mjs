// Design-system tests: markup builders, escaping and the live-state hooks app.js relies on.
// Run: node tests/ui.test.mjs  (ui.js must stay import-safe without a DOM)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_NAMES, icon, isIconMarkup } from "../assets/js/icons.js";
import * as ui from "../assets/js/ui.js";
import { formatBytes, formatDurationLong, joinMeta, pluralize, sortName } from "../assets/js/utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}
const str = (value) => String(value);
const attrsOf = (markup, selectorRe) => [...str(markup).matchAll(selectorRe)].map((match) => match[0]);

const source = {
  id: "the-red-clay-strays-live-af-laramie-2023",
  title: "Live AF <Laramie> & \"Friends\"",
  artist: "The Red Clay Strays",
  artists: ["The Red Clay Strays"],
  year: 2023,
  artwork: "https://huggingface.co/datasets/arjun10g/acoustify-library/resolve/abc/artwork/wZL7rPowq2w.jpg",
  fallbackArtwork: "https://i.ytimg.com/vi/wZL7rPowq2w/hqdefault.jpg",
  tracks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
};
const tracks = [
  { key: `${source.id}::stones-throw`, sourceId: source.id, title: "Stone's Throw", artist: "The Red Clay Strays", sourceTitle: "Live AF", duration: 205, artwork: source.artwork, fallbackArtwork: source.fallbackArtwork },
  { key: `${source.id}::<script>`, sourceId: source.id, title: "<img src=x onerror=alert(1)>", artist: "A & B", sourceTitle: "Live AF", start: 205, end: 400 }
];

test("module is import-safe and exports the documented API", () => {
  for (const name of ["html", "raw", "art", "albumCard", "artistCard", "seriesCard", "playlistCard", "sectionBlock", "shelf", "grid", "hero", "playFab", "trackList", "emptyState", "chips", "skeletonGrid", "skeletonList", "toast", "confirmDialog", "promptDialog", "actionSheet", "initUI"]) {
    assert.equal(typeof ui[name], "function", `ui.${name}`);
  }
  // DOM helpers degrade to no-ops without a document.
  assert.doesNotThrow(() => ui.initUI());
  assert.equal(typeof ui.toast("hi").dismiss, "function");
});

test("html escapes interpolations and passes html``/raw() through", () => {
  const out = str(ui.html`<p title="${'"quoted" & <b>'}">${"<b>bold</b>"}${ui.raw("<i>ok</i>")}${ui.html`<em>${"x<y"}</em>`}</p>`);
  assert.equal(out, '<p title="&quot;quoted&quot; &amp; &lt;b&gt;">&lt;b&gt;bold&lt;/b&gt;<i>ok</i><em>x&lt;y</em></p>');
});

test("html joins arrays, drops null/undefined/booleans, keeps numbers", () => {
  const out = str(ui.html`<ul>${["<a>", ui.html`<li>${1}</li>`, null, undefined, false, true, 0]}</ul>`);
  assert.equal(out, "<ul>&lt;a&gt;<li>1</li>0</ul>");
  assert.equal(str(ui.html`${new Set(["a", "b"])}`), "ab");
});

test("html output behaves like a string", () => {
  const out = ui.html`<b>${"x"}</b>`;
  assert.ok(out.includes("<b>x</b>"));
  assert.equal(`${out}`, "<b>x</b>");
  assert.equal(out + "", "<b>x</b>");
  assert.equal(JSON.stringify({ out }), '{"out":"<b>x</b>"}');
});

test("icon() builds a sprite reference and html`` never escapes it", () => {
  const plain = icon("play-fill");
  assert.equal(typeof plain, "string");
  assert.equal(plain, '<svg class="icon icon-play-fill" width="24" height="24" aria-hidden="true" focusable="false"><use href="#i-play-fill"></use></svg>');
  const labelled = icon("heart", { size: 20, className: "extra big", label: 'Like "it"' });
  assert.match(labelled, /class="icon icon-heart extra big"/);
  assert.match(labelled, /width="20" height="20"/);
  assert.match(labelled, /role="img" aria-label="Like &quot;it&quot;"/);
  assert.doesNotMatch(labelled, /aria-hidden/);
  assert.ok(isIconMarkup(plain) && isIconMarkup(labelled));
  assert.equal(str(ui.html`<button>${plain}</button>`), `<button>${plain}</button>`);
  assert.equal(str(ui.html`${plain + labelled}`), plain + labelled);
  // Names are sanitised; lookalike strings with extra markup are escaped.
  assert.match(icon('x"><script>'), /icon-xscript/);
  assert.ok(!isIconMarkup(`${plain}<script>`));
  assert.match(str(ui.html`${`${plain}<b>`}`), /&lt;svg/);
});

test("index.html sprite defines every icon name", () => {
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const name of ICON_NAMES) assert.match(indexHtml, new RegExp(`<symbol id="i-${name}" viewBox="0 0 24 24">`), `missing i-${name}`);
  for (const id of ["app", "sidebar", "playlist-nav", "main", "view", "player-bar", "now-playing", "tabbar", "local-audio", "sheet-root", "toast-region", "dialog-playlist", "playlist-form", "dialog-confirm", "dialog-prompt", "backup-import", "icon-sprite"]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(indexHtml, /<div id="player-bar"[^>]*><\/div>/, "#player-bar must be empty");
  assert.match(indexHtml, /<section id="now-playing"[^>]*><\/section>/, "#now-playing must be empty");
  const navs = new Set([...indexHtml.matchAll(/data-nav="([a-z]+)"/g)].map((match) => match[1]));
  for (const nav of ["home", "search", "artists", "songs", "library", "liked", "history", "downloads", "settings"]) assert.ok(navs.has(nav), `data-nav=${nav}`);
  const css = [...indexHtml.matchAll(/<link rel="stylesheet" href="\.\/assets\/css\/([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(css, ["app.css", "nowplaying.css", "views/home.css", "views/search.css", "views/artists.css", "views/library.css", "views/album.css", "views/settings.css"]);
});

test("art() renders lazy img with fallback chain and never inline handlers", () => {
  const out = str(ui.art(source, { size: 200 }));
  assert.match(out, /^<img class="art art--square" /);
  assert.match(out, new RegExp(`src="${source.artwork.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(out, /loading="lazy"/);
  assert.match(out, /decoding="async"/);
  assert.match(out, /width="200" height="200"/);
  assert.match(out, /data-fallback="\[&quot;https:\/\/i\.ytimg\.com\/vi\/wZL7rPowq2w\/hqdefault\.jpg&quot;,&quot;\.\/assets\/icons\/icon-512\.png&quot;\]"/);
  assert.doesNotMatch(out, /onerror|onload/);
  const eager = str(ui.art(source, { eager: true, shape: "circle", alt: "Cover" }));
  assert.doesNotMatch(eager, /loading=/);
  assert.match(eager, /class="art art--circle"/);
  assert.match(eager, /alt="Cover"/);
  const noArt = str(ui.art({}, {}));
  assert.match(noArt, /src="\.\/assets\/icons\/icon-512\.png"/);
  assert.doesNotMatch(noArt, /data-fallback/);
});

test("trackList renders every live-state hook", () => {
  const liked = new Set([tracks[0].key]);
  const out = str(ui.trackList(tracks, {
    queueId: "q-album-1", context: { type: "album", id: source.id }, currentKey: tracks[0].key, isPlaying: true, likedKeys: liked, showArt: true, showAlbum: true
  }));
  assert.match(out, /^<div class="tracks tracks--numbered tracks--art" role="list" data-queue-id="q-album-1">/);
  const rows = attrsOf(out, /<div class="track[^"]*" role="listitem"[^>]*>/g);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /class="track is-current is-playing"/);
  assert.match(rows[0], new RegExp(`data-track-key="${tracks[0].key}"`));
  assert.match(rows[0], new RegExp(`data-source-id="${source.id}"`));
  assert.equal(rows[1].includes("is-current"), false);
  assert.match(rows[1], /data-track-key="the-red-clay-strays-live-af-laramie-2023::&lt;script&gt;"/);

  const mains = attrsOf(out, /<button class="track-main"[^>]*>/g);
  assert.equal(mains.length, 2);
  assert.match(mains[0], /data-action="play-track"/);
  assert.match(mains[0], new RegExp(`data-track-key="${tracks[0].key}"`));
  assert.match(mains[0], /data-queue-id="q-album-1"/);
  assert.match(mains[0], /aria-label="Play Stone&#039;s Throw"/);

  const likes = attrsOf(out, /<button class="icon-btn track-like[^"]*"[^>]*>/g);
  assert.match(likes[0], /class="icon-btn track-like is-active"/);
  assert.match(likes[0], /data-action="toggle-like"/);
  assert.match(likes[0], new RegExp(`data-like-key="${tracks[0].key}"`));
  assert.match(likes[0], /aria-pressed="true"/);
  assert.match(likes[1], /aria-pressed="false"/);
  assert.ok(out.includes("#i-heart-fill") && out.includes("#i-heart\""));

  const menus = attrsOf(out, /<button class="icon-btn track-more"[^>]*>/g);
  assert.match(menus[0], /data-action="track-menu"/);
  assert.match(menus[0], new RegExp(`data-track-key="${tracks[0].key}"`));
  assert.match(menus[0], /data-context-type="album"/);
  assert.match(menus[0], new RegExp(`data-context-id="${source.id}"`));
  assert.match(menus[0], /aria-label="More options for Stone&#039;s Throw"/);
  // actionSheet flips aria-expanded on this button while its menu is open.
  assert.match(menus[0], /aria-haspopup="menu"/);

  // Eq bars are always present so app.js only toggles classes; durations fall back to end - start.
  assert.equal((out.match(/class="track-eq"/g) || []).length, 2);
  assert.match(out, /<span class="track-num">1<\/span>/);
  assert.match(out, /<span class="track-dur">3:25<\/span>/);
  assert.match(out, /<span class="track-dur">3:15<\/span>/);
  assert.match(out, /<span class="track-sub">The Red Clay Strays · Live AF<\/span>/);
  // Hostile titles are escaped everywhere.
  assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("trackList options: unnumbered art overlay, no queue id, offline-ready keys, array likedKeys", () => {
  const out = str(ui.trackList(tracks, { numbered: false, showArt: true, showArtist: false, likedKeys: [tracks[1].key], offlineReady: new Set([tracks[1].key]) }));
  assert.doesNotMatch(out, /track-num/);
  assert.match(out, /<span class="track-art"><img[^>]*><span class="track-eq"/);
  assert.doesNotMatch(out, /data-queue-id/);
  assert.doesNotMatch(out, /track-sub/);
  assert.match(out, /data-context-type="songs" data-context-id=""/);
  const rows = attrsOf(out, /<div class="track[^"]*" role="listitem"[^>]*>/g);
  assert.doesNotMatch(rows[0], /data-offline-ready/);
  assert.match(rows[1], /data-offline-ready=""/);
  assert.match(out, /track-like is-active" type="button" data-action="toggle-like" data-like-key="[^"]*::&lt;script&gt;"/);
  assert.equal(str(ui.trackList([])), '<div class="tracks tracks--numbered" role="list"></div>');
});

test("albumCard links to the album and carries play hooks", () => {
  const out = str(ui.albumCard(source, { isNew: true }));
  assert.match(out, /^<article class="card" data-source-id="the-red-clay-strays-live-af-laramie-2023">/);
  assert.match(out, /<a class="card-link" href="#\/album\/the-red-clay-strays-live-af-laramie-2023"/);
  assert.match(out, /<button class="card-play" type="button" data-action="play-source" data-source-id="the-red-clay-strays-live-af-laramie-2023" data-play-source="the-red-clay-strays-live-af-laramie-2023" aria-label="Play Live AF &lt;Laramie&gt; &amp; &quot;Friends&quot;">/);
  assert.match(out, /<span class="badge badge--new">New<\/span>/);
  assert.match(out, /<span class="card-title">Live AF &lt;Laramie&gt; &amp; &quot;Friends&quot;<\/span>/);
  // One subtitle formula: the artist alone (no year, never a song count).
  assert.match(out, /<span class="card-sub">The Red Clay Strays<\/span>/);
  const noYear = str(ui.albumCard({ ...source, year: undefined }));
  assert.match(noYear, /<span class="card-sub">The Red Clay Strays<\/span>/);
  assert.doesNotMatch(noYear, /songs|badge--new/);
  assert.doesNotMatch(str(ui.albumCard({ ...source, artist: "" })), /card-sub/);
  assert.match(str(ui.albumCard(source, { subtitle: "Custom" })), /<span class="card-sub">Custom<\/span>/);
});

test("artistCard, seriesCard and playlistCard link to their routes", () => {
  const artist = str(ui.artistCard({ slug: "the-red-clay-strays", name: "The Red Clay Strays", songCount: 14, artwork: source.artwork }));
  assert.match(artist, /^<a class="artist-tile" href="#\/artist\/the-red-clay-strays"/);
  assert.match(artist, /class="art art--circle"/);
  assert.match(artist, /<span class="card-sub">14 songs<\/span>/);
  const series = str(ui.seriesCard({ slug: "western-af", name: "Western AF", songCount: 9, sourceCount: 3 }));
  assert.match(series, /^<a class="series-tile" href="#\/series\/western-af"/);
  assert.match(series, /<span class="series-tile-name">Western AF<\/span>/);
  const mosaic = str(ui.playlistCard({ id: "p1", name: "Porch <songs>" }, [1, 2, 3, 4, 5].map((n) => ({ key: `s${n}::t`, sourceId: `s${n}`, artwork: `https://x/${n}.jpg` }))));
  assert.match(mosaic, /<a class="card-link" href="#\/playlist\/p1"/);
  assert.equal((mosaic.match(/<img /g) || []).length, 4);
  assert.match(mosaic, /data-action="play-playlist" data-playlist-id="p1" data-play-playlist="p1"/);
  assert.match(mosaic, /Porch &lt;songs&gt;/);
  const empty = str(ui.playlistCard({ id: "p2", name: "Empty" }, []));
  assert.match(empty, /card-placeholder/);
  assert.doesNotMatch(empty, /card-play/);
});

test("layout helpers compose trusted markup without double escaping", () => {
  const cards = [ui.albumCard(source), ui.albumCard({ ...source, id: "two" })];
  const joined = ui.raw(cards.join(""));
  for (const body of [ui.shelf(cards), ui.shelf([joined]), ui.grid(cards), ui.grid(joined), ui.grid(new Set(cards))]) {
    assert.equal((str(body).match(/<article class="card"/g) || []).length, 2);
    assert.doesNotMatch(str(body), /&lt;article/);
  }
  assert.match(str(ui.shelf(cards)), /^<div class="shelf-wrap"><div class="shelf"><article/);
  assert.match(str(ui.shelf(cards)), /data-shelf-scroll="-1" tabindex="-1" aria-hidden="true"/);
  assert.match(str(ui.grid([ui.artistCard({ slug: "a", name: "A" })], { variant: "artists" })), /^<div class="grid grid--artists">/);
  assert.match(str(ui.grid([], { variant: "series" })), /^<div class="grid grid--series">/);
  const section = str(ui.sectionBlock({ title: "Recently added", href: "#/songs?sort=added", body: joined }));
  assert.match(section, /^<section class="section"><div class="section-head"><h2>Recently added<\/h2><a class="section-link" href="#\/songs\?sort=added">Show all<\/a><\/div><article/);
  assert.doesNotMatch(section, /&lt;article/);
});

test("hero and playFab", () => {
  const out = str(ui.hero({
    artItem: source, shape: "circle", kicker: "Artist", title: "The <Red> Clay Strays",
    subtitleHtml: ui.html`<a href="#/artist/x">X</a>`, meta: ["14 songs", ui.html`<a href="#/series/w">W</a>`, "", null],
    actionsHtml: ui.playFab({ action: "play-artist", attrs: { artist: "the-red-clay-strays", playArtist: "the-red-clay-strays" }, label: "Play The Red Clay Strays" })
  }));
  assert.match(out, /^<header class="hero hero--circle">/);
  assert.match(out, /<h1 class="hero-title">The &lt;Red&gt; Clay Strays<\/h1>/);
  assert.match(out, /<p class="hero-sub"><a href="#\/artist\/x">X<\/a><\/p>/);
  assert.match(out, /<p class="hero-meta"><span>14 songs<\/span><span><a href="#\/series\/w">W<\/a><\/span><\/p>/);
  assert.match(out, /<div class="actions-row"><button class="play-fab" type="button" data-action="play-artist" data-artist="the-red-clay-strays" data-play-artist="the-red-clay-strays" aria-label="Play The Red Clay Strays">/);
  assert.equal((out.match(/<h1/g) || []).length, 1);
  assert.doesNotMatch(str(ui.hero({ title: "No art" })), /hero-art|actions-row/);
});

test("markup parameters escape plain strings (library data never becomes markup)", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const heroOut = str(ui.hero({ title: "T", subtitleHtml: hostile, actionsHtml: hostile }));
  assert.doesNotMatch(heroOut, /<img src=x/);
  assert.match(heroOut, /<p class="hero-sub">&lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
  assert.match(heroOut, /<div class="actions-row">&lt;img/);
  for (const out of [
    ui.sectionBlock({ title: "S", body: hostile }),
    ui.shelf([hostile]),
    ui.shelf(hostile),
    ui.grid([ui.albumCard(source), hostile]),
    ui.emptyState({ title: "E", actionHtml: hostile })
  ]) {
    assert.doesNotMatch(str(out), /<img src=x/);
    assert.match(str(out), /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  // icon() output is the one plain string that passes, exactly as in html``.
  assert.match(str(ui.emptyState({ title: "E", actionHtml: icon("plus") })), /<div class="empty-action"><svg class="icon icon-plus"/);
});

test("emptyState, chips and skeletons", () => {
  const empty = str(ui.emptyState({ iconName: "heart", title: "Nothing <yet>", body: "Like songs", actionHtml: ui.html`<a class="btn" href="#/songs">Browse</a>` }));
  assert.match(empty, /^<div class="empty"><span class="empty-icon"><svg class="icon icon-heart"/);
  assert.match(str(ui.emptyState({ title: "Songs you like live here" })), /empty-icon/);
  assert.match(str(ui.emptyState({ iconName: null, title: "No icon" })), /^<div class="empty"><h2 class="empty-title">No icon<\/h2>/);
  assert.match(empty, /<h2 class="empty-title">Nothing &lt;yet&gt;<\/h2>/);
  assert.match(empty, /<div class="empty-action"><a class="btn" href="#\/songs">Browse<\/a><\/div>/);
  const chipRow = str(ui.chips([
    { label: "Title", href: "#/songs?sort=title", active: true },
    { label: "Artist", action: "set-sort", value: "artist" },
    { label: "Plain" }
  ]));
  assert.match(chipRow, /<a class="chip is-active" href="#\/songs\?sort=title" aria-current="true">Title<\/a>/);
  assert.match(chipRow, /<button class="chip" type="button" data-action="set-sort" data-value="artist" aria-pressed="false">Artist<\/button>/);
  assert.match(chipRow, /<span class="chip">Plain<\/span>/);
  assert.equal((str(ui.skeletonGrid(3)).match(/card--skeleton/g) || []).length, 3);
  assert.equal((str(ui.skeletonList()).match(/track--skeleton/g) || []).length, 8);
  assert.match(str(ui.skeletonList(2)), /aria-busy="true"/);
});

test("utils additions", () => {
  assert.equal(pluralize(1, "song"), "1 song");
  assert.equal(pluralize(0, "song"), "0 songs");
  assert.equal(pluralize(3, "series", "series"), "3 series");
  assert.equal(formatDurationLong(4330), "1 hr 12 min");
  assert.equal(formatDurationLong(840), "14 min");
  assert.equal(formatDurationLong(3600), "1 hr");
  assert.equal(formatDurationLong(3599.6), "1 hr");
  assert.equal(formatDurationLong(42), "42 sec");
  assert.equal(formatDurationLong(null), "0 sec");
  assert.equal(sortName("The Red Clay Strays"), "Red Clay Strays");
  assert.equal(sortName("Theo Katzman"), "Theo Katzman");
  assert.equal(sortName("The"), "The");
  assert.equal(joinMeta(["Western AF", null, "", 2023, false, "4 songs"]), "Western AF · 2023 · 4 songs");
  // Decimal units everywhere (Settings, Library and the download prompt must agree).
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(34_148), "34 KB");
  assert.equal(formatBytes(356_844_808), "357 MB");
  assert.equal(formatBytes(1_234_000_000), "1.2 GB");
});

console.log(`ui tests: ${passed} passed`);
