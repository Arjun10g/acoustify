# Podcast Audio Extractor

A small local desktop app for saving **authorized public YouTube videos or playlists** as audio files for offline podcast-style listening.

## Important permission note

Use this only when you own the content, have the rights holder's permission, the content is public domain or appropriately licensed, or YouTube expressly provides/authorizes downloading. YouTube's terms generally restrict downloading except when the service or rights holders authorize it.

This app deliberately does **not** include login-cookie import, DRM circumvention, paywall bypass, age-gate bypass, geographic-restriction bypass, or private-video access.

## What “full quality” means

YouTube audio is already compressed. Creating a WAV or FLAC file would make it much larger without restoring information that YouTube removed.

| Mode | What it does | Fidelity | Compatibility |
|---|---|---:|---:|
| **Best source** | Keeps the highest-quality available YouTube audio stream without re-encoding | Best | Usually Opus (`.opus`) or AAC/M4A; VLC and many players work well |
| **M4A / AAC** | Prefers native M4A; converts Opus only when needed | Very good, but conversion can be lossy | Excellent on Apple devices and podcast players |
| **MP3 320 kb/s** | Converts the best source to high-bitrate MP3 | Very good, but conversion is lossy | Widest support |

For maximum fidelity, choose **Best source**. For Apple Music, Books, or a player that rejects WebM/Opus, choose **M4A**.

## macOS setup

1. Extract the ZIP.
2. Double-click `install_macos.command`.
3. After setup, use `run_macos.command` to open the app.

The installer uses Homebrew to install Python/Tk, FFmpeg, and Deno, then creates an isolated local Python environment. If macOS blocks the first launch, right-click the `.command` file and choose **Open**.

## Windows setup

1. Extract the ZIP.
2. Right-click `install_windows.ps1` and choose **Run with PowerShell**. If script execution is blocked, open PowerShell in the folder and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install_windows.ps1
   ```

3. Use `run_windows.bat` afterward.

The installer uses WinGet for Python, FFmpeg, and Deno when they are missing.

## Linux setup

```bash
chmod +x install_linux.sh
./install_linux.sh
```

Use `./run_linux.sh` afterward.

## Using the app

1. Paste a specific YouTube episode URL.
2. Choose a save folder.
3. Select **Best source**, **M4A**, or **MP3**.
4. Optionally enable a playlist and set a maximum number of episodes. The app rejects channel and search-page URLs to prevent accidental channel-wide downloads.
5. Confirm that you are authorized to save the content.
6. Select **Download audio**.

The default folder is `~/Music/YouTube Podcasts`. Metadata, artwork, and creator-provided chapter markers are embedded when the output container supports them.

## Command-line fallback

The GUI has a CLI fallback that does not require Tkinter:

```bash
.venv/bin/python cli.py "https://www.youtube.com/watch?v=VIDEO_ID" --confirm-rights
```

Examples:

```bash
# Preserve the best source stream
.venv/bin/python cli.py URL --format best --confirm-rights

# Apple-friendly M4A
.venv/bin/python cli.py URL --format m4a --confirm-rights

# Up to 10 authorized playlist episodes
.venv/bin/python cli.py PLAYLIST_URL --playlist --playlist-limit 10 --confirm-rights
```

On Windows, replace `.venv/bin/python` with `.venv\Scripts\python.exe`.

## Updating

YouTube changes frequently, so keep the extraction engine current:

- macOS: double-click `update_macos.command`
- Windows: double-click `update_windows.bat`
- Linux: run `./update_linux.sh`

## Troubleshooting

- **“No formats found” or extraction errors:** run the included updater. Confirm the video is public and playable without signing in.
- **Deno warning:** install Deno; modern yt-dlp uses a JavaScript runtime for full YouTube support.
- **FFmpeg missing:** rerun the installer. FFmpeg and FFprobe must be actual system executables, not the unrelated Python package named `ffmpeg`.
- **Best-source file will not import into an Apple app:** choose M4A instead. The original best stream may be saved losslessly as an Opus (`.opus`) file.
- **Cancelled download leaves `.part`:** rerun the same URL to resume, or delete the `.part` file manually.
- **Playlist stops early:** unavailable/private entries count as errors; the app stops after repeated playlist failures and never attempts to bypass access controls.

## Privacy and security

- Runs locally.
- Does not operate a public web service.
- Does not collect telemetry.
- Invokes yt-dlp with `--ignore-config`, so unknown global yt-dlp configuration files cannot silently add cookies, proxies, or other behavior.
- Uses argument arrays rather than shell interpolation, preventing pasted URLs from becoming shell commands.
- Accepts only specific YouTube video/playlist URL forms and rejects channel/search URLs.

## Tests

```bash
python -m unittest discover -s tests -v
```

## License

The app code is MIT-licensed. yt-dlp, FFmpeg, Deno, Python, and their dependencies have their own licenses; see `THIRD_PARTY_NOTICES.md`.
