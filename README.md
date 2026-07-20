# Acoustify

Acoustify is a dependency-free, local-first music library for long-form sources. It makes one YouTube performance or local audio master behave like an album: every timestamp range becomes its own track, the player advances at the saved boundary, and your browser remembers likes, history, playlists, volume, repeat/shuffle state, and the last playback position.

The project is designed to deploy as-is to **GitHub Pages**. There is no application server, cloud database, API key, build framework, or account system.

## What is already implemented

- Spotify-influenced dark listening interface with an original Acoustify identity.
- Responsive desktop, tablet, mobile, and installable PWA layouts.
- Android media-session controls for play, pause, seek, previous, and next.
- Official, visible YouTube IFrame Player API playback.
- Long-video segmentation: selecting a row seeks to the track start, while adjacent tracks from the same source continue without reloading the underlying media.
- Local master mode for audio files you own. The Blob is stored in IndexedDB and played without Acoustify transcoding it.
- Authorized-audio import that matches the extractor's `[YouTube ID]` filename to an existing source and keeps its saved track cuts.
- Browser memory for:
  - likes;
  - listening history and play counts;
  - playlists;
  - volume, shuffle, repeat, autoplay, and panel preferences;
  - current track and resume position;
  - custom sources and timing overrides.
- JSON memory backup/import.
- JSON custom-catalog export.
- Catalog Studio for adding more long videos or local audio files.
- Timestamp calibrator with uninterrupted source playback, current-time capture, and ±0.5-second nudging.
- Offline app shell. YouTube streams and remote artwork still require a connection.
- GitHub Actions deployment and catalog/static-shell validation.

## Seed catalog

### Of Monsters and Men — The Cabin Sessions

YouTube ID: `Y25LDO6OLzQ`

Fourteen separated tracks are included:

1. Dirty Paws
2. From Finner
3. King and Lionheart
4. Mountain Sound
5. Numb Bears
6. Six Weeks
7. Sloom
8. Slow and Steady
9. Your Bones
10. Lakehouse
11. Little Talks
12. Love Love Love
13. Sinking Man
14. Yellow Light

The included starts follow the complete tracklist in the top YouTube comment, which had about 8,200 likes when checked. They are editable in Catalog Studio.

### Of Monsters and Men — Live from Skarkali

YouTube ID: `JoUq869LXeA`

Seven separated tracks are included:

1. Ordinary Creature
2. Dream Team
3. The Towering Skyscraper at the End of the Road
4. Fruit Bat
5. Television Love
6. The Block
7. Mouse Parade

The included starts follow a highly rated timestamp list in the YouTube comments. A second credible list placed some openings slightly later, so the earlier starts were used to avoid clipping the beginning of a performance.

## Audio-quality model

### YouTube sources

The Pages app uses the official embedded player. YouTube chooses an adaptive audio/video representation according to the source, device, connection, and its own player logic. The static site cannot run an extractor or turn a YouTube stream into lossless audio.

The source player remains available for YouTube playback. For a true no-video path, use a local master source.

If YouTube seeks land a little late and clip the first moment of a song, open **Settings** and adjust **Segment lead-in**. This starts segmented playback slightly before the saved cut without changing the catalog timestamps. Use **Catalog Studio** for cuts that are structurally wrong or drift across the source.

### Mobile and background playback

On Android Chrome, install Acoustify from **Settings → Phone app** for a standalone layout and lock-screen media controls. The app saves the current position as Chrome backgrounds the page and resynchronizes the logical track when it returns.

Adjacent songs from one long source play as one uninterrupted stream, avoiding a media reload at every timestamp. This materially improves background continuity. YouTube and Chrome can still pause an embedded YouTube player when the browser is backgrounded or the screen is locked; a web app cannot override that provider policy. A local master played through the native audio element is the reliable background-audio path.

Two settings help each path:

- **Keep screen awake for YouTube** (Settings → Playback) holds a screen wake lock while a YouTube source is playing, so the phone does not auto-lock mid-session and playback runs hands-free. It has no effect on local masters, which do not need it.
- Local masters declare a "playback" audio session where supported (Safari/iOS), so they keep playing with the Ring/Silent switch on and while the app is backgrounded.

### YouTube ads

Ads are served by YouTube inside the official embedded player, and Acoustify does not (and will not) block, mute, or auto-skip them. What it does instead:

- **Ad banner with a skip shortcut.** The player watches for the tell-tale stall where the content clock freezes while the player reports "playing." When that happens, a banner appears with a one-tap **Show video** action (and a fullscreen shortcut) so YouTube's own Skip button is reachable even when the video panel is closed.
- **Fewer ad opportunities.** Selecting another track from the same long source now seeks within the already-loaded video instead of reloading it. Reloads are what create fresh pre-roll slots, so staying inside one load means fewer ads across an album.
- **Ad-free paths.** A YouTube Premium account signed into the same browser plays embeds without ads. Local master files never have ads.

### Watching outside the app (Android picture-in-picture)

Use the ⛶ button in the now-playing panel to take the video fullscreen. On Android, swiping home from fullscreen hands the video to the system picture-in-picture window, where it keeps playing while you use other apps. This is the supported way to keep a YouTube source audible outside the browser.

### Local master sources

For the highest-fidelity path, add a FLAC, WAV, AIFF, ALAC/M4A, MP3, AAC, or other browser-supported file that you lawfully possess:

1. Open **Catalog Studio**.
2. Select **Local master file**.
3. Choose the audio file.
4. Add the track-start lines.
5. Save.

The original file Blob is written to IndexedDB. Acoustify does not alter its bytes. Decoding support and the final device output path still depend on the browser and operating system.

**Never commit master audio files into this repository.** Files imported through the app remain in that browser and are not included in the GitHub Pages artifact or JSON backup.

### Extractor-assisted local playback

The repository includes the root-level extractor under `tools/audio-extractor` and publishes its original ZIP from **Settings -> Local audio**. It runs on your computer, not inside GitHub Pages. Use it only for content you own, have permission to download, or are otherwise authorized to save.

Set up the extractor with the installer for your operating system, then list the packaged sources:

```bash
npm run audio:list
```

For an authorized source, M4A is the most compatible choice for phone playback:

```bash
npm run audio:extract -- --source of-monsters-and-men-the-cabin-sessions --format m4a --confirm-rights
```

The wrapper saves into the ignored `local-audio/` folder by default. The extractor app can also be used directly and normally saves into `~/Music/YouTube Podcasts`.

To attach the result:

1. Open that source in Acoustify.
2. Choose **Use local audio**.
3. Select the generated file.

The extractor puts `[VIDEO_ID]` at the end of every filename. **Settings -> Local audio -> Import extracted audio** can therefore match a file without first opening its source. Acoustify checks both the ID and duration, retains all saved song starts, stores the file in IndexedDB, and exposes **Use YouTube** as a reversible fallback.

For a future music link, add/import the catalog entry first using the flow below, then run the wrapper with `--url` or the extractor desktop app. Once the source exists in Acoustify, the same filename matching applies.

## Deploy to GitHub Pages

### Fastest route

1. Create a new GitHub repository, for example `acoustify`.
2. Put every file in this project at the repository root.
3. Commit and push to the `main` branch.
4. In the repository, open **Settings → Pages**.
5. Under **Build and deployment**, choose **GitHub Actions** as the source.
6. Open the **Actions** tab and run **Deploy Acoustify to GitHub Pages** if the push did not trigger it automatically.
7. The deployment job publishes the URL shown in the `github-pages` environment.

The included workflow:

- validates `data/catalog.json`;
- verifies required static assets;
- stages only the public site files;
- uploads a Pages artifact;
- deploys that artifact.

### Local preview

You need a local HTTP server because module imports, service workers, and catalog fetching do not work correctly from a raw `file://` URL.

```bash
npm test
npm run serve
```

Then open:

```text
http://localhost:8080/#/home
```

Python can also be used directly:

```bash
python3 -m http.server 8080
```

## Personal-use and privacy notes

Acoustify has no telemetry and sends no library memory to an Acoustify server because there is no server. Likes, history, playlists, custom catalog entries, and local audio stay in the browser origin.

However, a normal GitHub Pages site is a static website, not an authenticated private application. Treat the deployed HTML, JavaScript, and packaged `data/catalog.json` as publicly inspectable. Do not place secrets, private URLs, access tokens, or copyrighted audio files in the repository. Local-file imports are not part of the deployed site.

A client-side PIN would not provide meaningful protection for files committed to a public static site. Real access control would require a different hosting/authentication layer or an eligible private Pages configuration.

## Add another YouTube source in the app

1. Open **Catalog Studio**.
2. Leave **YouTube player** selected.
3. Enter the source title, artist, YouTube URL, and full duration.
4. Enter one line per track:

```text
0:00 Opening Song
4:12 Second Song
8:47 Third Song
13:31 Final Song
```

5. Choose **Preview cuts**.
6. Save.

The next timestamp is automatically used as the current track’s end. The final track ends at the full source duration.

The new source is stored in IndexedDB, not automatically written into the GitHub repository. Use **Settings → Export custom catalog** to create a JSON backup.

## Add future music links to the repository

For links you want packaged into the default catalog, use the local intake file:

```bash
cp music-links.example.json music-links.json
```

Add new items under the `links` array. `music-links.json` is intentionally ignored by git and excluded from the GitHub Pages artifact, so pending/private link requests do not ship with the site.

For a single-song YouTube video, chapters can be omitted:

```json
{
  "links": [
    {
      "url": "https://youtu.be/VIDEO_ID_HERE",
      "title": "Song title",
      "artist": "Artist name",
      "duration": "4:12",
      "tags": ["acoustic"]
    }
  ]
}
```

For a long source, add chapter starts:

```json
{
  "links": [
    {
      "url": "https://www.youtube.com/watch?v=VIDEO_ID_HERE",
      "title": "Session title",
      "artist": "Artist name",
      "duration": "42:30",
      "chapters": [
        "0:00 First song",
        "3:45 Second song",
        "8:10 Third song"
      ],
      "tags": ["session", "live"]
    }
  ]
}
```

Then run:

```bash
npm run links:check
npm run links:import
npm test
```

If a link already exists in `data/catalog.json`, set `"replace": true` on that link entry or run `npm run links:import -- --replace`.

## Package a source for every installation

To make a source part of the repository’s default catalog, edit `data/catalog.json`:

```json
{
  "id": "artist-session-name",
  "title": "Session Name",
  "artist": "Artist",
  "provider": "youtube",
  "youtubeId": "abcdefghijk",
  "duration": 900,
  "artwork": "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
  "fallbackArtwork": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
  "timingStatus": "user-calibrated",
  "tracks": [
    { "id": "first-song", "title": "First Song", "start": 0, "end": 252 },
    { "id": "second-song", "title": "Second Song", "start": 252, "end": 527 },
    { "id": "third-song", "title": "Third Song", "start": 527, "end": 900 }
  ]
}
```

Then run:

```bash
npm test
```

Rules enforced by validation:

- source IDs are unique;
- track IDs are unique within a source;
- YouTube IDs have 11 characters;
- starts and ends are finite and positive;
- tracks do not overlap;
- no track ends after the source duration;
- the last track ends at the source duration.

## Calibrate a long source precisely

1. Open the source album.
2. Choose **Calibrate cuts** or **Edit timings**.
3. In **Timestamp calibrator**, choose **Play full source**.
4. Pause at the first audible moment of a song.
5. Tap **●** on that song’s row.
6. Use **−.5** or **+.5** to nudge the start.
7. Repeat for every track.
8. Check the preview and choose **Save calibration**.

Editing a packaged source creates a browser override with the same source ID. Removing that override in Settings restores the packaged timings.

## Memory backup and migration

Open **Settings → Export memory**. The JSON contains app state and custom catalog entries but intentionally excludes large local audio Blobs.

On another browser/device:

1. deploy/open the same Acoustify site;
2. import the memory JSON;
3. re-import any local master files through Catalog Studio.

The site’s origin matters. Browser storage for `https://username.github.io/acoustify/` is separate from localhost and from any custom domain.

## File map

```text
.
├── index.html                    # Application shell
├── 404.html                      # Safe Pages fallback
├── manifest.webmanifest          # PWA metadata
├── sw.js                         # Offline shell cache
├── music-links.example.json      # Template for local future-link intake
├── data/
│   ├── catalog.json              # Packaged source/track map
│   └── catalog.schema.json       # Catalog shape reference
├── assets/
│   ├── css/app.css               # Responsive interface
│   ├── icons/                    # PWA icons
│   └── js/
│       ├── app.js                # Routes, views, state, studio
│       ├── catalog.js            # Catalog parsing/validation/indexing
│       ├── db.js                 # IndexedDB memory and audio Blobs
│       ├── player.js             # YouTube/local segmented playback
│       └── utils.js              # Shared helpers
├── tools/
│   ├── import-music-links.mjs    # Imports local music-links.json into the catalog
│   ├── music-link-ingest.mjs     # Link-intake parsing helpers
│   ├── validate-catalog.mjs
│   ├── unit-test.mjs
│   └── smoke-test.mjs
└── .github/workflows/deploy-pages.yml
```

## Architecture

```text
GitHub Pages
    │
    ├── static app shell + packaged catalog
    │
    ├── YouTube IFrame Player API ── official adaptive stream
    │
    └── browser-local data
          ├── IndexedDB kv store: memory + custom source maps
          └── IndexedDB audio store: original local file Blobs
```

There is deliberately no backend. That makes deployment simple and keeps personal memory local, but it also means:

- there is no cross-device sync unless you export/import JSON;
- local audio must be re-imported per browser;
- Catalog Studio cannot directly commit to GitHub;
- there is no secure server-side user authentication;
- YouTube availability and embedding permissions remain controlled by YouTube/uploaders.

## Keyboard and mobile behavior

- `Space`: play/pause when focus is not inside a form field.
- `/`: open Search.
- On mobile, the player becomes a slide-in panel and the bottom bar remains compact.
- The PWA can be installed from a compatible browser.

## Troubleshooting

### The YouTube player shows an error

Open the original source to confirm that it still exists and allows embedding. Some videos are region restricted, age restricted, private, deleted, or configured against embedding.

### A cut is early or late

Use Catalog Studio’s calibrator. The player checks the saved end boundary frequently and advances from there, but stream seek precision can vary slightly around keyframes/buffering.

### A local FLAC/ALAC file will not play

The file is still stored without re-encoding, but the browser may not support that codec/container. Try a browser with support for the format, or create a compatible copy outside Acoustify while retaining your original master.

### Memory disappeared

Browser storage can be cleared by the user, privacy tools, storage pressure, or origin/domain changes. Export memory periodically and use **Request persistent storage** in Settings where supported.

### The app works locally but not under a repository path

All project URLs are intentionally relative. Keep the files at the Pages artifact root and do not add a `<base>` tag unless you update every routing/caching assumption.
