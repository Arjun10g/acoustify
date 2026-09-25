# Acoustify

A personal, installable music player for live sessions: Tiny Desks, Western AF,
Red Barn Radio, Audiotree and the like. Long recordings are split into songs,
and you browse by artist, series, album or song. It supports likes, playlists,
history, a persistent queue, and offline downloads.

The app is static files on GitHub Pages: vanilla HTML, CSS and ES modules, with
no build step and no server. The music is in a **private Hugging Face dataset**,
and each device unlocks it with its own read-only token.

- App: https://arjun10g.github.io/acoustify/
- Music: `arjun10g/acoustify-library` (dataset, private)

## How it fits together

```
music-links.json ──npm run add──▶ library/ (audio + artwork, local staging, gitignored)
                                   data/catalog.json (source of truth: titles, artists, series, song times)
                                        │
                                  npm run publish
                                        ▼
              Hugging Face dataset (private): media/<id>.m4a · artwork/<id>.jpg · library.json
                                        │  fetched with the device's token
                                        ▼
              Acoustify on the phone: streams, seeks and downloads for offline
```

- `data/catalog.json` (schema 5) is the only file you edit by hand. It holds
  each recording's title, credits, series, year, and the start and end of every
  song. An album joined from a YouTube playlist (like *Live at the Ryman*) has
  `youtubePlaylistId` instead of `youtubeId`, and a `youtubeId` on each song.
- `tools/publish.py` uploads only new or changed files, then writes
  `library.json`. Every file URL in it is pinned to the commit that last
  changed that file, so publishing new music never invalidates downloads
  already saved on the phone. After the dataset has the new `library.json`,
  publish writes the same file to `data/library.json`, which ships with the
  app as an offline fallback. A dry run never writes it, and `npm test` fails
  if it pins a file to anything but a commit.
- The service worker adds the token to requests for the dataset, and nothing
  else. That makes streaming, seeking and artwork work like any public URL.

## Connect a device

1. Create a **fine-grained** token at
   https://huggingface.co/settings/tokens/new?tokenType=fineGrained. Under
   **Repositories permissions**, add `arjun10g/acoustify-library` and tick only
   **Read access to contents of selected repos**. Leave every other box empty.
   It must be read-only and limited to this one dataset. See
   [Security model](#security-model) for why.
2. In the app, open **Settings → Library**, paste the token and choose
   **Connect**. The app refuses a token that can change your account. It
   accepts a classic read token but warns you, because that kind opens every
   private repo you have.

Paste the token. Don't send it to the phone inside a link: the link stays in
the browser's (synced) history and in whatever app carried it, and the app
ignores `#/connect?token=` links for that reason. Send it through a password
manager or type it.

The token stays on that device only. **Disconnect** removes it.

## Add music

Setup on a new machine (one time):

```sh
brew install yt-dlp ffmpeg
python3 -m venv .venv && .venv/bin/pip install --require-hashes --only-binary=:all: -r tools/requirements.lock
echo 'HF_TOKEN=hf_your_write_token' > .env      # .env is gitignored — never commit it
```

The publishing token is a fine-grained token with **Read access to contents
of selected repos** and **Write access to contents/settings of selected repos**
for `arjun10g/acoustify-library` only. `publish.py` warns when the token can
reach more than that.

**From a list of links.** Copy `music-links.example.json` to
`music-links.json`, then add entries under `"links"`. Only `url` is required.
Title, artist, series and year are guessed from YouTube when you leave them
out. Then run:

```sh
npm run sync          # add every pending link → validate → publish
```

**One link.** Run:

```sh
npm run add -- --url https://youtu.be/VIDEO_ID --title "Sedona (Live at Austin City Limits Radio)" \
  --artist "Houndmouth" --series "Austin City Limits Radio" --year 2015
npm run add -- --url https://youtu.be/VIDEO_ID --chapters "0:12 First song
4:05 Second song"
npm run publish
```

`npm run add -- --dry-run` shows the catalog entry it would create without
downloading anything. Song times come from `chapters`. If there are none, the
video's own YouTube chapters are used, and failing that the whole video is one
song. Links that are already imported, or already in the catalog, are skipped,
unless you pass `--replace`.

**Fix a title or song times** by editing `data/catalog.json`, then run
`npm run publish` (or just push; see below). Changes you make on the phone with
**Edit song times** stay on that device only.

If a download fails with **HTTP 403**, YouTube changed something. Run
`brew upgrade yt-dlp` and try again. If YouTube asks you to confirm you're not
a bot, add `--cookies-from-browser chrome`.

`npm run publish -- --dry-run` shows what would upload and which recordings
`library.json` would add, remove or change. It writes nothing, locally or on
the dataset. `--list-missing` lists catalog entries whose audio is neither
local nor on the dataset.

## How updates reach the phone

- **New music.** After `npm run publish`, the app checks `library.json`
  whenever it opens or comes back to the foreground, and every 15 minutes while
  it is open. New songs appear with a "N new songs" toast and a NEW badge. If
  **Automatically download new music** is on, they are also saved for offline
  listening. No reinstall is needed.
- **App code.** A push to `main` runs `.github/workflows/deploy-pages.yml`. It
  runs `npm test`, then `publish.py --ci`, which rebuilds `library.json` from
  the catalog and the files already on the dataset (only when the `HF_TOKEN`
  repository secret is set). It then stamps the version with the commit and
  deploys the app. The installed app gets the new service worker and applies it
  on the next launch. If something is playing, it shows **Update ready**
  instead, and never interrupts playback.
- **The `HF_TOKEN` secret** must be the same kind of token as `.env`:
  fine-grained, with write access to `arjun10g/acoustify-library` only. The
  publish step runs third-party Python packages with it. They are installed
  from `tools/requirements.lock` (exact versions, sha256-checked, wheels only),
  and every action is pinned to a commit. Only the deploy job can write to
  Pages.

CI never downloads or uploads audio. Publish the audio from the laptop first:
`--ci` fails if the catalog lists a recording the dataset doesn't have.

## Local development

```sh
npm run serve         # http://localhost:8080 — connect with your read-only token to play
npm test              # catalog validation → tests/*.test.mjs → static smoke test
node tools/run-tests.mjs runtime    # just the steps matching "runtime"
```

Tests use only Node ≥ 20 and `node:assert`. `tests/pipeline.test.mjs` also runs
the offline self-tests of the Python tools (`publish.py --self-test` and
`add_music.py --self-test`).

| Path | What it is |
|---|---|
| `index.html`, `sw.js`, `manifest.webmanifest` | App shell, service worker (streaming, offline, updates), PWA manifest |
| `assets/js/` | `app.js` controller, `cloud.js` library sync and downloads, `catalog.js`, `player.js`, `nowplaying.js`, `ui.js`, `views/*` |
| `assets/css/` | Design system (`app.css`), player (`nowplaying.css`), per-view styles |
| `data/catalog.json` | Source of truth (not deployed) |
| `data/library.json` | Last published library, bundled as the offline fallback |
| `tools/` | `add_music.py`, `publish.py`, `validate-catalog.mjs`, `stamp-version.mjs`, `run-tests.mjs`, `smoke-test.mjs`; `requirements.txt` (what the Python tools need) and `requirements.lock` (the exact, hashed versions CI installs) |

## Security model

**The app shares its origin.** Acoustify is served from
`arjun10g.github.io/acoustify/`, and every other GitHub Pages site on the
account (about 50) is served from the same origin, `arjun10g.github.io`.
Browsers keep storage per origin, not per path. So any page on any of those
sites can:

- read the saved token (Cache Storage `acoustify-auth`),
- read the downloaded music (`acoustify-audio-v1`), the artwork
  (`acoustify-art-v1`) and the app's IndexedDB `acoustify` database, which
  holds likes, playlists and history,
- message Acoustify's service worker.

They also share one storage quota. The risk is that one of those sites is
compromised, or loads a third-party script that is: several load scripts from
a CDN.

That is why the device token must be fine-grained, read-only and limited to
`arjun10g/acoustify-library`, and why the app refuses a token that can
write. If such a token leaks, the worst it allows is reading the music
library. Revoke it at https://huggingface.co/settings/tokens and connect
again with a new one.

**The real fix is an origin of its own.** Either point a custom domain at this
repository's Pages site (for example `music.<your-domain>`), or move the
repository to a dedicated GitHub organization so it's served from
`<org>.github.io`. The app uses only relative paths, so it works unchanged.
Ship one last build at the old address that deletes the `acoustify-*` caches
and the `acoustify` database, then redirects to the new origin. Devices then
reconnect there with their token.

**Content-Security-Policy.** `index.html` sets one. It limits where scripts,
media and requests can go (the app itself, Hugging Face and YouTube), and it
blocks plugins, `<base>` changes and form submissions. It narrows what an
injected script could do, but it does nothing about the shared origin. The
smoke test checks that the policy is there and still allows everything the app
loads.

## Privacy

The recordings belong to their artists and are for personal listening only.
The dataset must stay **private**. `publish.py` creates it as private and
refuses to upload if it ever finds it public. Keep the publishing token in
`.env` and in the GitHub `HF_TOKEN` secret, nowhere else. `npm test` fails if
anything that looks like a Hugging Face token appears in the repository.
