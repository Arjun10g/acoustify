#!/usr/bin/env python3
"""Add music to Acoustify from YouTube links — one command from link to catalog.

    npm run add                           # import every pending link in music-links.json
    npm run add -- --dry-run              # show the planned catalog entries; download nothing
    npm run add -- --url https://youtu.be/ID --title "Song (Live at X)" --artist "Artist" \\
                   --series "Austin City Limits Radio" --year 2024
    npm run add -- --url … --chapters "0:00 First song
    3:41 Second song"

For each link it downloads the best audio to library/media/<id>.m4a and the
thumbnail to library/artwork/<id>.jpg (yt-dlp + ffmpeg), measures the real
duration with ffprobe, takes song boundaries from the link's "chapters" (else
the video's own YouTube chapters, else one song for the whole video), appends a
schema-5 source to data/catalog.json and marks the link "imported".

Then `npm run publish` uploads it; phones pick it up on their next open.
Title/artist/series/year are guessed from YouTube when not given — check the
printed entry (or run with --dry-run first).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
LINKS = ROOT / "music-links.json"
LIBRARY_DIR = ROOT / "library"
MEDIA_DIR = LIBRARY_DIR / "media"
ART_DIR = LIBRARY_DIR / "artwork"

CATALOG_VERSION = 5
SKIP_STATUSES = {"imported", "skip", "skipped", "done"}
YOUTUBE_ID = re.compile(r"^[\w-]{11}$")
UPGRADE_HINT = "YouTube changed something on its side. Run `brew upgrade yt-dlp` (or `pip install -U yt-dlp`) and try again."

CONFIDENCE = {"official-chapters": "official", "comment-derived": "community", "user-calibrated": "user",
              "single-track": "official", "album-derived": "official", "calibration-required": "user"}
TIMING_NOTES = {
    "official-chapters": "Song starts follow the chapters in the video description.",
    "user-calibrated": "Song starts come from the timestamps added with the link.",
    "comment-derived": "Song starts come from a timestamped YouTube comment.",
    "single-track": "Single-song performance.",
}
# Show/venue series recognised in a video's title or channel when --series isn't given.
KNOWN_SERIES = {
    "NPR Tiny Desk": ("tiny desk",),
    "Western AF": ("western af",),
    "Red Barn Radio": ("red barn radio",),
    "The Current": ("the current",),
    "Audiotree Live": ("audiotree",),
    "Austin City Limits Radio": ("austin city limits radio", "acl radio"),
    "Paste Studios": ("paste studio",),
    "SomerSessions": ("somersession",),
    "KEXP": ("kexp",),
    "COLORS": ("a colors show",),
    "Mahogany Sessions": ("mahogany session",),
    "Sofar Sounds": ("sofar sounds",),
    "LR Baggs": ("lr baggs",),
    "Whispering Beard": ("whispering beard",),
    "Farm Aid": ("farm aid",),
    "The Record Exchange": ("record exchange",),
    "Ryman Auditorium": ("ryman",),
}
NON_SONG_CHAPTER = re.compile(r"^(intro(duction)?|outro|credits?|banter|talk(ing)?|interview|tuning|applause|end)$", re.I)
NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
                "Eleven", "Twelve"]


class ImportFailed(Exception):
    """One link could not be imported; the message is shown to the user."""


# ── Pure helpers ─────────────────────────────────────────────────────────────

def clean(value) -> str:
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()


def slugify(value: str, fallback: str = "item") -> str:
    """Like assets/js/utils.js slugify, but drops apostrophes ("I'm" → "im")."""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"['’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or fallback


def num(value: float) -> float | int:
    """Round to 2 decimals and drop a trailing .0 (matches the JSON style of the catalog)."""
    value = round(float(value), 2)
    return int(value) if value.is_integer() else value


def parse_youtube_id(value: str) -> str:
    value = clean(value)
    if YOUTUBE_ID.match(value):
        return value
    try:
        url = urlparse(value if "://" in value else f"https://{value}")
    except ValueError:
        return ""
    host = (url.hostname or "").lower()
    parts = [p for p in url.path.split("/") if p]
    candidate = ""
    if host == "youtu.be" or host.endswith(".youtu.be"):
        candidate = parts[0] if parts else ""
    elif host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com"):
        if parts and parts[0] in ("shorts", "embed", "live", "v") and len(parts) > 1:
            candidate = parts[1]
        else:
            candidate = (parse_qs(url.query).get("v") or [""])[0]
    return candidate if YOUTUBE_ID.match(candidate) else ""


def parse_timecode(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, float(value))
    text = clean(value)
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = text.split(":")
    if len(parts) > 3 or not all(re.fullmatch(r"\d+(\.\d+)?", p) for p in parts):
        return None
    seconds = 0.0
    for p in parts:
        seconds = seconds * 60 + float(p)
    return seconds


def format_time(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


LINE_AT_START = re.compile(r"^((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*(?:[-–—|:]\s*)?(.+)$")
LINE_AT_END = re.compile(r"^(.+?)\s*(?:[-–—|]\s*)?((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)$")


def chapter_rows(chapters) -> list[tuple[float, str]]:
    """(start, title) rows from "0:00 Title" lines (list or newline/';' string) or
    {start|time, title|name} objects — the same line format as the in-app editor."""
    if isinstance(chapters, str):
        items = [line for line in re.split(r"[\r\n;]+", chapters)]
    elif isinstance(chapters, list):
        items = chapters
    else:
        raise ImportFailed("chapters must be a list of \"0:00 Song\" lines")
    rows = []
    for i, item in enumerate(items, 1):
        if isinstance(item, dict):
            start = parse_timecode(item.get("start", item.get("time", item.get("at"))))
            title = clean(item.get("title") or item.get("name"))
        else:
            line = clean(item)
            if not line:
                continue
            m = LINE_AT_START.match(line)
            n = None if m else LINE_AT_END.match(line)
            if not m and not n:
                raise ImportFailed(f"could not read chapter line {i}: “{line}” (use “3:41 Song title”)")
            start = parse_timecode(m.group(1) if m else n.group(2))
            title = clean(m.group(2) if m else n.group(1))
        if start is None or not title:
            raise ImportFailed(f"chapter {i} needs a start time and a title")
        rows.append((start, title))
    rows.sort(key=lambda r: r[0])
    if not rows:
        raise ImportFailed("chapters is empty")
    for a, b in zip(rows, rows[1:]):
        if b[0] <= a[0]:
            raise ImportFailed(f"two chapters start at {format_time(a[0])} — starts must increase")
    return rows


def clean_chapter_title(title: str, artist: str = "") -> str:
    title = re.sub(r"^\s*(?:\d{1,2}\s*[.)\-:]\s+|#\d+\s+)", "", clean(title))
    if artist:
        title = re.sub(rf"^{re.escape(artist)}\s*[-–—:]\s*", "", title, flags=re.I)
    quoted = re.fullmatch(r"[\"“'‘](.+)[\"”'’]", title)
    return clean(quoted.group(1)) if quoted else title


def youtube_chapter_rows(chapters: list[dict], artist: str = "") -> list[tuple[float, str]]:
    """Rows from yt-dlp's chapters, without intro/outro/banter chapters:
    a leading one is dropped (the first song simply starts later), later ones
    fold into the song before them."""
    rows = [(float(c.get("start_time") or 0), clean_chapter_title(c.get("title", ""), artist))
            for c in chapters if clean(c.get("title"))]
    rows.sort(key=lambda r: r[0])
    return [r for r in rows if not NON_SONG_CHAPTER.match(r[1])]


def build_tracks(rows: list[tuple[float, str]], duration: float, confidence: str) -> list[dict]:
    """Contiguous tracks: each ends where the next starts; the last ends at the duration."""
    kept = [r for r in rows if r[0] < duration - 0.5]
    if not kept:
        raise ImportFailed(f"every chapter starts after the end of the recording ({format_time(duration)})")
    if len(kept) < len(rows):
        dropped = ", ".join(t for _, t in rows[len(kept):])
        raise ImportFailed(f"chapter(s) start after the recording ends ({format_time(duration)}): {dropped}")
    used: set[str] = set()
    tracks = []
    for i, (start, title) in enumerate(kept):
        base = slugify(title, f"track-{i + 1}")
        tid, n = base, 2
        while tid in used:
            tid, n = f"{base}-{n}", n + 1
        used.add(tid)
        end = kept[i + 1][0] if i + 1 < len(kept) else duration
        tracks.append({"id": tid, "title": title, "start": num(start), "end": num(end), "timingConfidence": confidence})
    return tracks


def strip_qualifiers(title: str) -> str:
    """"I'm Still Fine (Live at the Ryman) [Official Video]" → "I'm Still Fine"."""
    out = re.sub(r"\s*[(\[][^()\[\]]*[)\]]\s*$", "", title)
    while out != title:
        title, out = out, re.sub(r"\s*[(\[][^()\[\]]*[)\]]\s*$", "", out)
    out = re.sub(r"\s*[-–—|]\s*(official|live|acoustic|audio|video|lyric|session)\b.*$", "", out, flags=re.I)
    return clean(out) or clean(title)


def guess_artist_title(meta: dict) -> tuple[str, str]:
    """Best guess at (artist, title) from YouTube metadata."""
    yt_title = clean(meta.get("title"))
    m = re.match(r"^(.+?)\s+[-–—|]\s+(.+)$", yt_title)
    if m:
        return m.group(1), m.group(2)
    artist = clean(meta.get("artist") or meta.get("creator"))
    if artist:
        return artist.split(",")[0].strip(), clean(meta.get("track")) or yt_title
    channel = re.sub(r"\s*(-\s*Topic|VEVO|Official)$", "", clean(meta.get("channel") or meta.get("uploader")), flags=re.I)
    return channel, yt_title


def fold(name: str) -> str:
    text = unicodedata.normalize("NFKD", name)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower().strip()
    return re.sub(r"^the\s+", "", re.sub(r"[^a-z0-9& ]+", "", text)).strip()


def canonical_artist(name: str, known: list[str]) -> str:
    """Reuse the catalog's spelling of an artist ("Red Clay Strays" → "The Red Clay Strays")."""
    folded = fold(name)
    return next((k for k in known if fold(k) == folded), name)


def infer_series(*texts: str) -> str:
    haystack = " ".join(clean(t).lower() for t in texts if t)
    for name, needles in KNOWN_SERIES.items():
        if any(n in haystack for n in needles):
            return name
    return ""


def possessive(name: str) -> str:
    return f"{name}’" if name.endswith("s") else f"{name}’s"


def default_description(artist: str, title: str, tracks: list[dict], series: str) -> str:
    if len(tracks) == 1:
        venue = re.search(r"[(\[]\s*(live\s+(?:at|on|from|in)\s+[^)\]]+?)\s*[)\]]", title, re.I)
        where = f" {venue.group(1)[0].lower()}{venue.group(1)[1:]}" if venue else ""
        # "live at the Ryman" already names the Ryman Auditorium series.
        if series and not any(n in where.lower() for n in (series.lower(), *KNOWN_SERIES.get(series, ()))):
            where += f" for {series}"
        return f"{artist} performing {tracks[0]['title']}{where}."
    count = NUMBER_WORDS[len(tracks)] if len(tracks) < len(NUMBER_WORDS) else str(len(tracks))
    return f"{count} songs from {possessive(artist)} {title}."


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [clean(v) for v in value.split(",") if clean(v)]
    return [clean(v) for v in value if clean(v)]


def dedupe(items: list[str]) -> list[str]:
    seen, out = set(), []
    for item in items:
        if item and item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
    return out


def build_source(entry: dict, meta: dict, duration: float, *, today: str, catalog: dict,
                 replacing: dict | None = None) -> tuple[dict, list[str]]:
    """Pure: (schema-5 source, notes about guesses). `entry` holds the link's fields."""
    notes: list[str] = []
    yid = parse_youtube_id(entry.get("url") or entry.get("youtubeId") or "")
    if not yid:
        raise ImportFailed("needs a valid YouTube URL or 11-character video id")
    sources = catalog.get("sources", [])
    known_artists = dedupe([a for s in sources for a in s.get("artists", [])])

    guessed_artist, guessed_title = guess_artist_title(meta) if meta else ("", "")
    artist = clean(entry.get("artist"))
    if not artist:
        artist = canonical_artist(guessed_artist, known_artists)
        if artist:
            notes.append(f"artist guessed from YouTube: {artist!r} (pass --artist to set it)")
    title = clean(entry.get("title"))
    if not title:
        title = guessed_title
        if title:
            notes.append(f"title guessed from YouTube: {title!r} (pass --title to set it)")
    if not artist or not title:
        raise ImportFailed("needs a title and an artist (couldn't guess them from YouTube)")

    artists = dedupe([canonical_artist(a, known_artists) for a in as_list(entry.get("artists"))]) \
        or [canonical_artist(artist, known_artists)]
    series = clean(entry.get("series"))
    if not series and meta:
        series = infer_series(title, meta.get("title", ""), meta.get("channel", ""))
        if series:
            notes.append(f"series guessed: {series!r} (pass --series to change it)")

    year = entry.get("year")
    if year in (None, "") and meta and re.fullmatch(r"\d{8}", str(meta.get("upload_date", ""))):
        year = int(str(meta["upload_date"])[:4])
        notes.append(f"year taken from the upload date: {year}")
    year = int(year) if str(year or "").strip().isdigit() else None

    chapters = entry.get("chapters") or entry.get("tracks")
    status = clean(entry.get("timingStatus"))
    if chapters:
        rows = chapter_rows(chapters)
        status = status or ("single-track" if len(rows) == 1 else "user-calibrated")
    elif meta and len(meta.get("chapters") or []) > 1 and youtube_chapter_rows(meta["chapters"], artist):
        rows = youtube_chapter_rows(meta["chapters"], artist)
        status = status or "official-chapters"
    else:
        rows = [(0.0, strip_qualifiers(title))]
        status = status or "single-track"
    if status not in CONFIDENCE:
        raise ImportFailed(f"unknown timingStatus {status!r}")
    tracks = build_tracks(rows, duration, CONFIDENCE[status])
    if len(tracks) == 1 and status in ("user-calibrated", "official-chapters"):
        status = "single-track"

    tags = dedupe(as_list(entry.get("tags")) or
                  ["live"] + (["acoustic"] if "acoustic" in title.lower() else []) + (["session"] if len(tracks) > 1 else []))

    taken = {s["id"] for s in sources if not replacing or s["id"] != replacing["id"]}
    sid = clean(entry.get("id")) or (replacing or {}).get("id") or slugify(f"{artist} {title}", yid.lower())
    if sid in taken:
        base = f"{sid}-{year}" if year and not sid.endswith(str(year)) else sid
        sid, n = base, 2
        while sid in taken:
            sid, n = f"{base}-{n}", n + 1

    source: dict = {"id": sid, "title": title, "artist": artist, "artists": artists}
    if series:
        source["series"] = series
    if year:
        source["year"] = year
    source.update({
        "provider": "local",
        "youtubeId": yid,
        "duration": num(duration),
        "audio": f"media/{yid}.m4a",
        "artwork": f"artwork/{yid}.jpg",
        "added": (replacing or {}).get("added") or today,
        "description": clean(entry.get("description")) or default_description(artist, title, tracks, series),
        "timingStatus": status,
        "timingNote": clean(entry.get("timingNote")) or TIMING_NOTES.get(status, ""),
        "tags": tags,
        "tracks": tracks,
    })
    return source, notes


def validate_source(source: dict) -> list[str]:
    """The catalog rules (SPEC §2) for one source."""
    errors = []
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", source.get("id", "")):
        errors.append("id must be a lowercase slug")
    if not source.get("artists"):
        errors.append("artists is empty")
    # One video per source; only an album joined from a playlist may go without (its songs name their videos).
    if "youtubeId" in source or "youtubePlaylistId" not in source:
        if not YOUTUBE_ID.match(str(source.get("youtubeId") or "")):
            errors.append("bad youtubeId")
    if "youtubePlaylistId" in source and not re.fullmatch(r"[\w-]{12,64}", str(source["youtubePlaylistId"])):
        errors.append("bad youtubePlaylistId")
    if not re.fullmatch(r"media/[\w-]+\.m4a", source.get("audio", "")):
        errors.append("bad audio path")
    if not re.fullmatch(r"artwork/[\w-]+\.jpg", source.get("artwork", "")):
        errors.append("bad artwork path")
    tracks, duration = source.get("tracks") or [], source.get("duration") or 0
    if not tracks:
        errors.append("no tracks")
    ids = [t["id"] for t in tracks]
    if len(ids) != len(set(ids)):
        errors.append("duplicate track ids")
    for i, t in enumerate(tracks):
        if t["end"] <= t["start"]:
            errors.append(f"track {t['id']} ends before it starts")
        if i and abs(t["start"] - tracks[i - 1]["end"]) > 0.01:
            errors.append(f"track {t['id']} does not start where the previous one ends")
    if tracks and (tracks[0]["start"] < 0 or abs(tracks[-1]["end"] - duration) > 0.01):
        errors.append("tracks must cover the recording up to its duration")
    return errors


def find_existing(catalog: dict, yid: str, sid: str = "") -> dict | None:
    return next((s for s in catalog.get("sources", []) if s.get("youtubeId") == yid or (sid and s.get("id") == sid)), None)


def find_album_song(catalog: dict, yid: str) -> tuple[dict, int] | None:
    """(album, song number) when the video is already one song of an album (e.g. Live at the Ryman)."""
    for s in catalog.get("sources", []):
        if s.get("youtubeId") == yid:
            continue
        for i, t in enumerate(s.get("tracks") or [], 1):
            if isinstance(t, dict) and t.get("youtubeId") == yid:
                return s, i
    return None


def pending_links(payload) -> list[dict]:
    links = payload.get("links") if isinstance(payload, dict) else payload
    if not isinstance(links, list):
        raise ImportFailed("music-links.json must contain a top-level \"links\" array")
    return [e for e in links if isinstance(e, dict) and e.get("skip") is not True
            and clean(e.get("status")).lower() not in SKIP_STATUSES]


# ── External tools ───────────────────────────────────────────────────────────

def require(tool: str, hint: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise SystemExit(f"error: {tool} not found. {hint}")
    return path


def yt_dlp_base(args) -> list[str]:
    cmd = [require("yt-dlp", "Install it with `brew install yt-dlp`."), "--no-playlist", "--no-warnings"]
    if args.cookies_from_browser:
        cmd += ["--cookies-from-browser", args.cookies_from_browser]
    return cmd


def explain_failure(stderr: str) -> str:
    tail = "\n".join(f"    {line.strip()}" for line in stderr.strip().splitlines()[-6:] if line.strip())
    low = stderr.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        hint = "YouTube wants a signed-in session: re-run with --cookies-from-browser chrome (or safari)."
    elif re.search(r"private video|video (is )?unavailable|has been removed|not available in your country", low):
        hint = "The video is private, removed, or blocked — check the link."
    elif any(s in low for s in ("403", "forbidden", "nsig", "signature", "unable to extract", "requested format is not available")):
        hint = UPGRADE_HINT
    else:
        hint = f"If this keeps happening: {UPGRADE_HINT}"
    return f"{tail}\n  → {hint}" if tail else f"→ {hint}"


def fetch_metadata(url: str, args) -> dict:
    proc = subprocess.run(yt_dlp_base(args) + ["-J", "--skip-download", url], capture_output=True, text=True)
    if proc.returncode != 0:
        raise ImportFailed(f"yt-dlp could not read the video:\n{explain_failure(proc.stderr)}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise ImportFailed("yt-dlp returned unreadable metadata")


def probe_duration(path: Path) -> float:
    ffprobe = require("ffprobe", "Install it with `brew install ffmpeg`.")
    proc = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                           "-of", "default=noprint_wrappers=1:nokey=1", str(path)], capture_output=True, text=True)
    try:
        value = float(proc.stdout.strip())
    except ValueError:
        raise ImportFailed(f"ffprobe could not read {path.name}: {proc.stderr.strip()[:200]}")
    if value <= 0:
        raise ImportFailed(f"{path.name} has no audio")
    return round(value, 2)


def download(url: str, yid: str, args) -> tuple[Path, Path]:
    """Audio + artwork into a temp folder, then moved into library/ only when both are good."""
    require("ffmpeg", "Install it with `brew install ffmpeg`.")
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    ART_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".incoming-", dir=LIBRARY_DIR) as tmp:
        cmd = yt_dlp_base(args) + [
            "-f", "bestaudio[ext=m4a]/bestaudio/best",
            "-x", "--audio-format", "m4a",
            "--write-thumbnail", "--convert-thumbnails", "jpg",
            "--no-mtime", "--progress", "--quiet",
            "-o", str(Path(tmp) / f"{yid}.%(ext)s"),
            url,
        ]
        proc = subprocess.run(cmd, stdout=None, stderr=subprocess.PIPE, text=True)
        audio_tmp, art_tmp = Path(tmp) / f"{yid}.m4a", Path(tmp) / f"{yid}.jpg"
        if proc.returncode != 0 or not audio_tmp.is_file():
            raise ImportFailed(f"download failed:\n{explain_failure(proc.stderr)}")
        if not art_tmp.is_file():
            raise ImportFailed(f"no thumbnail was saved for {yid}.\n  → {UPGRADE_HINT}")
        probe_duration(audio_tmp)  # refuse to stage a broken file
        audio, art = MEDIA_DIR / f"{yid}.m4a", ART_DIR / f"{yid}.jpg"
        os.replace(audio_tmp, audio)
        os.replace(art_tmp, art)
    return audio, art


def yt_dlp_age_days() -> int | None:
    try:
        out = subprocess.run([shutil.which("yt-dlp") or "yt-dlp", "--version"], capture_output=True, text=True).stdout
        y, m, d = (int(x) for x in out.strip().split(".")[:3])
        return (dt.date.today() - dt.date(y, m, d)).days
    except Exception:
        return None


# ── Files ────────────────────────────────────────────────────────────────────

def read_json(path: Path, fallback=None):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"error: {path.name} is not valid JSON ({e})")


def write_json(path: Path, data) -> None:
    """Atomic write, same style as the rest of the repo (2-space indent, UTF-8, trailing newline)."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def entry_from_args(args) -> dict:
    entry: dict = {"url": args.url}
    for key in ("title", "artist", "series", "description", "id"):
        if getattr(args, key):
            entry[key] = getattr(args, key)
    if args.artists:
        entry["artists"] = [a for value in args.artists for a in value.split(";")]
    if args.year:
        entry["year"] = args.year
    if args.chapters:
        entry["chapters"] = args.chapters
    if args.tags:
        entry["tags"] = args.tags
    if args.timing_note:
        entry["timingNote"] = args.timing_note
    return entry


def label(entry: dict) -> str:
    who = " — ".join(x for x in (clean(entry.get("artist")), clean(entry.get("title"))) if x)
    return who or clean(entry.get("url"))


# ── Main ─────────────────────────────────────────────────────────────────────

def import_one(entry: dict, catalog: dict, args, today: str) -> dict:
    url = clean(entry.get("url") or entry.get("youtubeId"))
    yid = parse_youtube_id(url)
    if not yid:
        raise ImportFailed(f"not a YouTube link: {url or '(empty)'}")
    album_song = find_album_song(catalog, yid)
    if album_song:
        album, number = album_song
        raise ImportFailed(f"already in the catalog as song {number} of {album['id']} "
                           f"(“{album['tracks'][number - 1].get('title', '')}”) — remove the link.")
    existing = find_existing(catalog, yid, clean(entry.get("id")))
    replace = args.replace or entry.get("replace") is True
    if existing and not replace:
        raise ImportFailed(f"already in the catalog as {existing['id']}. Remove the link, add \"replace\": true, "
                           "or run with --replace to re-import it.")
    watch_url = f"https://www.youtube.com/watch?v={yid}"
    meta = fetch_metadata(watch_url, args)

    audio, art = MEDIA_DIR / f"{yid}.m4a", ART_DIR / f"{yid}.jpg"
    if args.dry_run:
        duration = float(meta.get("duration") or 0)
        if duration <= 0:
            raise ImportFailed("YouTube did not report a duration (live stream?)")
        print(f"  would download {watch_url} → library/media/{yid}.m4a + library/artwork/{yid}.jpg")
    else:
        if audio.is_file() and art.is_file() and not args.redownload:
            print("  using the files already in library/ (pass --redownload to fetch again)")
        else:
            print("  downloading audio + artwork…")
            download(watch_url, yid, args)
        duration = probe_duration(audio)
        print(f"  {audio.stat().st_size / 1e6:.1f} MB · {format_time(duration)}")

    expected = parse_timecode(entry.get("duration")) if entry.get("duration") else None
    if expected and abs(expected - duration) > 5:
        print(f"  note: the link says {format_time(expected)} but the recording is {format_time(duration)}")

    source, notes = build_source(entry, meta, duration, today=today, catalog=catalog,
                                 replacing=existing if replace else None)
    for n in notes:
        print(f"  {n}")
    problems = validate_source(source)
    if problems:
        raise ImportFailed("the new entry is invalid: " + "; ".join(problems))
    return source


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", type=Path, default=LINKS, help="links file (default: music-links.json)")
    ap.add_argument("--url", help="import one link instead of the pending links in music-links.json")
    ap.add_argument("--title", help="album/session title, e.g. \"Tiny Desk Concert\" or \"Sedona (Live at …)\"")
    ap.add_argument("--artist", help="display credit, e.g. \"Tyler Childers & Chris Stapleton\"")
    ap.add_argument("--artists", action="append",
                    help="canonical artist for browsing; repeat (or separate with ';') for several")
    ap.add_argument("--series", help="show/venue series, e.g. \"NPR Tiny Desk\"")
    ap.add_argument("--year", type=int)
    ap.add_argument("--chapters", help="song starts, one \"0:00 Song\" per line (or separated by ';')")
    ap.add_argument("--tags", help="comma-separated tags (default: live[, acoustic][, session])")
    ap.add_argument("--description")
    ap.add_argument("--timing-note")
    ap.add_argument("--id", help="catalog id (default: slug of artist + title)")
    ap.add_argument("--replace", action="store_true", help="re-import links already in the catalog")
    ap.add_argument("--redownload", action="store_true", help="download again even if library/ has the files")
    ap.add_argument("--cookies-from-browser", metavar="BROWSER", help="passed to yt-dlp, e.g. chrome")
    ap.add_argument("--dry-run", action="store_true", help="print the planned entries; download and change nothing")
    ap.add_argument("--self-test", action="store_true", help="run offline checks of the entry builder and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    sys.stdout.reconfigure(line_buffering=True)  # keep our lines in order with yt-dlp's progress
    if not args.url and any((args.title, args.artist, args.artists, args.series, args.year, args.chapters)):
        ap.error("--title/--artist/--series/--year/--chapters describe a single --url")

    catalog = read_json(CATALOG)
    if not isinstance(catalog, dict) or catalog.get("version") != CATALOG_VERSION:
        raise SystemExit(f"error: data/catalog.json must be a version-{CATALOG_VERSION} catalog")

    links_path = args.file if args.file.is_absolute() else ROOT / args.file
    links_doc = read_json(links_path, {"links": []})
    if isinstance(links_doc, list):  # a bare array of links is accepted too
        links_doc = {"links": links_doc}
    if args.url:
        entries = [entry_from_args(args)]
    else:
        if not links_path.exists():
            print(f"No {links_path.name}. Copy music-links.example.json to music-links.json and add links, "
                  "or run: npm run add -- --url <youtube link>")
            return 0
        try:
            entries = pending_links(links_doc)
        except ImportFailed as e:
            raise SystemExit(f"error: {e}")
        if not entries:
            print(f"Nothing to import — every link in {links_path.name} is already imported.")
            return 0

    require("yt-dlp", "Install it with `brew install yt-dlp`.")
    age = yt_dlp_age_days()
    if age is not None and age > 90:
        print(f"note: yt-dlp is {age} days old; if downloads fail, run `brew upgrade yt-dlp`.")

    today = dt.date.today().isoformat()
    imported, failed = [], []
    print(f"{'Planning' if args.dry_run else 'Importing'} {len(entries)} link(s)…")
    for entry in entries:
        print(f"\n• {label(entry)}")
        try:
            source = import_one(entry, catalog, args, today)
        except ImportFailed as e:
            print(f"  ✗ {e}")
            failed.append(entry)
            continue

        if args.dry_run:
            print(json.dumps(source, indent=2, ensure_ascii=False))
            catalog["sources"].append(source)  # in memory only, so later links see it (duplicates, ids)
            imported.append(source)
            continue

        existing = find_existing(catalog, source["youtubeId"], source["id"])
        if existing:
            catalog["sources"][catalog["sources"].index(existing)] = source
        else:
            catalog["sources"].append(source)
        catalog["generatedAt"] = today
        write_json(CATALOG, catalog)

        # A one-off --url is logged in music-links.json too, so the file stays a record of everything added.
        link = entry if not args.url else next(
            (e for e in links_doc.setdefault("links", []) if isinstance(e, dict)
             and parse_youtube_id(clean(e.get("url") or e.get("youtubeId"))) == source["youtubeId"]), None)
        if link is None:
            link = {"url": args.url, "title": source["title"], "artist": source["artist"]}
            links_doc["links"].append(link)
        link["status"] = "imported"
        link["id"] = source["id"]
        write_json(links_path, links_doc)
        songs = len(source["tracks"])
        print(f"  ✓ {'replaced' if existing else 'added'} {source['id']} ({songs} song{'s' if songs != 1 else ''}, "
              f"{source['timingStatus']})")
        imported.append(source)

    print()
    if args.dry_run:
        print(f"Dry run: {len(imported)} ready, {len(failed)} failed. Nothing was downloaded or changed.")
    else:
        print(f"Imported {len(imported)}, failed {len(failed)}.")
        if imported:
            print("Next: npm run publish   (uploads to Hugging Face; phones update on next open)")
    return 1 if failed else 0


# ── Self-test (no network) ───────────────────────────────────────────────────

def self_test() -> int:
    checks = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal checks
        if not cond:
            raise AssertionError(msg)
        checks += 1

    for value, expected in [
        ("https://youtu.be/9r78xTZ7q08?si=hHuRzQAhty-Hnur-", "9r78xTZ7q08"),
        ("https://www.youtube.com/watch?v=wZL7rPowq2w&t=42s", "wZL7rPowq2w"),
        ("youtube.com/shorts/QVyMBdfrr-E", "QVyMBdfrr-E"),
        ("https://m.youtube.com/live/_lsran_Slzc?feature=share", "_lsran_Slzc"),
        ("S90ruG91Y_U", "S90ruG91Y_U"),
        ("https://example.com/watch?v=9r78xTZ7q08", ""),
        ("not a link", ""),
    ]:
        check(parse_youtube_id(value) == expected, f"parse_youtube_id({value!r})")

    check(slugify("I'm Still Fine (Live at the Ryman)") == "im-still-fine-live-at-the-ryman", "slugify apostrophes")
    check(slugify("Chance Peña — Sleep Deprivation") == "chance-pena-sleep-deprivation", "slugify diacritics")
    check(slugify("!!!", "x") == "x", "slugify fallback")
    check(parse_timecode("1:02:03.5") == 3723.5 and parse_timecode("3:41") == 221 and parse_timecode("x") is None,
          "parse_timecode")
    check(num(221.0) == 221 and isinstance(num(221.0), int) and num(275.304) == 275.3, "num")

    rows = chapter_rows(["0:12 By and By", "Millions - 5:12", {"start": "11:32", "title": "So Cool"}])
    check(rows == [(12.0, "By and By"), (312.0, "Millions"), (692.0, "So Cool")], f"chapter_rows {rows}")
    check(chapter_rows("0:00 One\n3:10 Two;6:00 Three")[2] == (360.0, "Three"), "chapter string forms")
    for bad in (["0:00 A", "0:00 B"], ["nonsense"], []):
        try:
            chapter_rows(bad)
            check(False, f"chapter_rows should reject {bad}")
        except ImportFailed:
            checks += 1

    tracks = build_tracks(rows, 1172.43, "user")
    check([t["start"] for t in tracks] == [12, 312, 692] and tracks[-1]["end"] == 1172.43, "track bounds")
    check(tracks[0]["end"] == tracks[1]["start"] and tracks[0]["id"] == "by-and-by", "contiguous + ids")
    check([t["id"] for t in build_tracks([(0, "Song"), (60, "Song")], 120, "user")] == ["song", "song-2"],
          "unique track ids")
    try:
        build_tracks([(0, "A"), (500, "B")], 300, "user")
        check(False, "chapters past the end must fail")
    except ImportFailed:
        checks += 1

    yt = youtube_chapter_rows([{"start_time": 0, "title": "Intro"}, {"start_time": 15, "title": "1. Ramblin'"},
                               {"start_time": 200, "title": "Banter"}, {"start_time": 230, "title": "The Red Clay Strays - Moments"},
                               {"start_time": 400, "title": "Outro"}], "The Red Clay Strays")
    check(yt == [(15.0, "Ramblin'"), (230.0, "Moments")], f"youtube_chapter_rows {yt}")

    check(guess_artist_title({"title": "The Red Clay Strays - I'm Still Fine (Live At The Ryman)", "channel": "Red Clay Strays"})
          == ("The Red Clay Strays", "I'm Still Fine (Live At The Ryman)"), "guess from 'Artist - Title'")
    check(guess_artist_title({"title": "Sedona", "channel": "HoundmouthVEVO"}) == ("Houndmouth", "Sedona"), "guess from channel")
    check(strip_qualifiers("I'm Still Fine (Live at the Ryman) [Official Video]") == "I'm Still Fine", "strip_qualifiers")
    check(strip_qualifiers("Sedona - Live at ACL") == "Sedona", "strip dash qualifier")
    check(canonical_artist("Red Clay Strays", ["The Red Clay Strays"]) == "The Red Clay Strays", "canonical artist")
    check(infer_series("Tiny Desk Concert") == "NPR Tiny Desk" and infer_series("Wondering Why (Live at Austin City Limits Radio)")
          == "Austin City Limits Radio" and infer_series("Just a song") == "", "infer_series")

    catalog = {"version": 5, "sources": [{"id": "the-red-clay-strays-sunshine", "youtubeId": "1O31IIprXWM",
                                         "artists": ["The Red Clay Strays"], "added": "2026-09-01"}]}
    meta = {"title": "The Red Clay Strays - I'm Still Fine (Live At The Ryman)", "channel": "Red Clay Strays",
            "upload_date": "20241004", "duration": 275, "chapters": None}
    src, notes = build_source({"url": "https://youtu.be/9r78xTZ7q08?si=x"}, meta, 275.3, today="2026-09-24", catalog=catalog)
    check(src["id"] == "the-red-clay-strays-im-still-fine-live-at-the-ryman", f"id {src['id']}")
    check(src["artist"] == "The Red Clay Strays" and src["artists"] == ["The Red Clay Strays"], "artist")
    check(src["year"] == 2024 and src["added"] == "2026-09-24" and src["provider"] == "local", "year/added/provider")
    check(src["audio"] == "media/9r78xTZ7q08.m4a" and src["artwork"] == "artwork/9r78xTZ7q08.jpg", "paths")
    check(src["tracks"] == [{"id": "im-still-fine", "title": "I'm Still Fine", "start": 0, "end": 275.3,
                             "timingConfidence": "official"}], f"single track {src['tracks']}")
    check(src["timingStatus"] == "single-track" and src["series"] == "Ryman Auditorium" and len(notes) == 4,
          f"status/series/notes {notes}")
    check(src["description"] == "The Red Clay Strays performing I'm Still Fine live At The Ryman.", src["description"])
    check(default_description("Houndmouth", "Sedona (Live at Austin City Limits Radio)", [{"title": "Sedona"}],
                              "Austin City Limits Radio") == "Houndmouth performing Sedona live at Austin City Limits Radio.",
          "description with venue + series")
    check(validate_source(src) == [], f"valid source {validate_source(src)}")
    check(list(src)[:4] == ["id", "title", "artist", "artists"] and list(src)[-1] == "tracks", "field order")

    duo, _ = build_source({"url": "hli7lApCEXU", "title": "Tiny Desk Concert", "artist": "Tyler Childers & Chris Stapleton",
                           "artists": ["Tyler Childers", "Chris Stapleton"], "year": 2025,
                           "chapters": ["0:30 First", "4:00 Second"]}, {}, 600, today="2026-09-24", catalog=catalog)
    check(duo["artists"] == ["Tyler Childers", "Chris Stapleton"] and duo["timingStatus"] == "user-calibrated", "multi")
    check(duo["tracks"][0]["start"] == 30 and duo["description"] == "Two songs from Tyler Childers & Chris Stapleton’s Tiny Desk Concert.",
          f"description {duo['description']}")
    check(duo["tags"] == ["live", "session"] and validate_source(duo) == [], "tags + valid")

    official, _ = build_source({"url": "PdcwiATrJJk", "title": "Live at Darien Lake", "artist": "Chance Peña", "series": "X"},
                               {"chapters": [{"start_time": 0, "title": "Song A"}, {"start_time": 100, "title": "Song B"}]},
                               200, today="2026-09-24", catalog=catalog)
    check(official["timingStatus"] == "official-chapters" and official["tracks"][1]["timingConfidence"] == "official",
          "youtube chapters")

    clash, _ = build_source({"url": "AAAAAAAAAAA", "id": "the-red-clay-strays-sunshine", "title": "t", "artist": "a",
                             "year": 2023}, {}, 60, today="2026-09-24", catalog=catalog)
    check(clash["id"] == "the-red-clay-strays-sunshine-2023", f"id clash {clash['id']}")
    replaced, _ = build_source({"url": "1O31IIprXWM", "title": "Sunshine", "artist": "The Red Clay Strays"}, {}, 60,
                               today="2026-09-24", catalog=catalog, replacing=catalog["sources"][0])
    check(replaced["id"] == "the-red-clay-strays-sunshine" and replaced["added"] == "2026-09-01",
          "replace keeps id and added date")
    check(find_existing(catalog, "1O31IIprXWM")["id"] == "the-red-clay-strays-sunshine", "find_existing")

    # A video that is already a song of a playlist album is never imported again as a single.
    album = {"id": "the-red-clay-strays-live-at-the-ryman", "title": "Live at the Ryman", "artists": ["The Red Clay Strays"],
             "youtubePlaylistId": "PLDtVvFL-MTp4S1vFu91Yd9XKWNyOwDY3R", "duration": 300,
             "audio": "media/rcs-live-at-the-ryman.m4a", "artwork": "artwork/rcs-live-at-the-ryman.jpg",
             "tracks": [{"id": "wanna-be-loved", "title": "Wanna Be Loved", "start": 0, "end": 100, "youtubeId": "qyA6gOeRIyQ"},
                        {"id": "im-still-fine", "title": "I'm Still Fine", "start": 100, "end": 300, "youtubeId": "9r78xTZ7q08"}]}
    with_album = {"version": 5, "sources": [*catalog["sources"], album]}
    found = find_album_song(with_album, "9r78xTZ7q08")
    check(found is not None and found[0]["id"] == album["id"] and found[1] == 2, f"find_album_song {found}")
    check(find_album_song(with_album, "1O31IIprXWM") is None and find_album_song(with_album, "zzzzzzzzzzz") is None,
          "find_album_song ignores sources' own videos and unknown ids")
    try:
        import_one({"url": "https://youtu.be/9r78xTZ7q08"}, with_album, argparse.Namespace(replace=True), "2026-09-25")
        check(False, "an album song must not be re-imported, even with --replace")
    except ImportFailed as e:
        check("song 2 of the-red-clay-strays-live-at-the-ryman" in str(e), f"album song message: {e}")
    check(validate_source(album) == [], f"playlist album is valid: {validate_source(album)}")
    check(validate_source({**album, "youtubePlaylistId": "PL"}) == ["bad youtubePlaylistId"], "bad playlist id")
    check(validate_source({k: v for k, v in album.items() if k != "youtubePlaylistId"}) == ["bad youtubeId"],
          "a source needs a video or a playlist")
    check(validate_source({**album, "audio": "media/live at.m4a"}) == ["bad audio path"], "file names stay simple")
    check(infer_series("I'm Still Fine (Live At The Ryman)") == "Ryman Auditorium", "Ryman series")
    check(len(pending_links({"links": [{"url": "a", "status": "imported"}, {"url": "b"}, {"url": "c", "skip": True},
                                       {"url": "d", "status": "Done"}]})) == 1, "pending_links")
    check("brew upgrade yt-dlp" in explain_failure("ERROR: unable to download video data: HTTP Error 403: Forbidden"),
          "403 → upgrade hint")
    check("cookies-from-browser" in explain_failure("Sign in to confirm you’re not a bot"), "bot check → cookies hint")
    check("check the link" in explain_failure("ERROR: [youtube] x: This video is unavailable"), "unavailable → link hint")

    print(f"add_music.py self-test: {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
