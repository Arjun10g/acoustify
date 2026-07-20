from __future__ import annotations

import importlib.util
import os
import platform
import re
import shutil
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Sequence
from urllib.parse import parse_qs, urlparse


APP_NAME = "Podcast Audio Extractor"
DEFAULT_OUTPUT_DIR = Path.home() / "Music" / "YouTube Podcasts"


class AudioMode(str, Enum):
    """Supported output modes."""

    BEST_SOURCE = "best"
    M4A = "m4a"
    MP3 = "mp3"


MODE_LABELS: dict[AudioMode, str] = {
    AudioMode.BEST_SOURCE: "Best source — no audio re-encode",
    AudioMode.M4A: "M4A / AAC — Apple and podcast-player friendly",
    AudioMode.MP3: "MP3 320 kb/s — widest compatibility",
}

MODE_DESCRIPTIONS: dict[AudioMode, str] = {
    AudioMode.BEST_SOURCE: (
        "Keeps YouTube's highest-quality available audio stream unchanged. "
        "The file is usually Opus (.opus) or AAC/M4A."
    ),
    AudioMode.M4A: (
        "Prefers an existing M4A stream. If only Opus is available, FFmpeg converts it to AAC, "
        "which improves compatibility but cannot add quality."
    ),
    AudioMode.MP3: (
        "Converts the best source stream to 320 kb/s MP3. This is convenient, but it is a lossy "
        "conversion from an already-lossy source."
    ),
}


@dataclass(frozen=True)
class DownloadOptions:
    url: str
    output_dir: Path
    mode: AudioMode = AudioMode.BEST_SOURCE
    include_playlist: bool = False
    playlist_limit: int = 25
    embed_metadata: bool = True
    embed_thumbnail: bool = True


@dataclass(frozen=True)
class DependencyStatus:
    ytdlp_prefix: tuple[str, ...] | None
    ffmpeg: str | None
    ffprobe: str | None
    deno: str | None

    @property
    def required_ok(self) -> bool:
        return bool(self.ytdlp_prefix and self.ffmpeg and self.ffprobe)

    @property
    def missing_required(self) -> tuple[str, ...]:
        missing: list[str] = []
        if not self.ytdlp_prefix:
            missing.append("yt-dlp")
        if not self.ffmpeg:
            missing.append("ffmpeg")
        if not self.ffprobe:
            missing.append("ffprobe")
        return tuple(missing)


@dataclass(frozen=True)
class StatusEvent:
    kind: str
    value: str = ""
    extra: tuple[str, ...] = ()


class ValidationError(ValueError):
    pass


def _is_youtube_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    host = hostname.lower().rstrip(".")
    return (
        host in {"youtube.com", "youtu.be", "youtube-nocookie.com"}
        or host.endswith(".youtube.com")
        or host.endswith(".youtube-nocookie.com")
    )


def validate_youtube_url(url: str, include_playlist: bool = False) -> str:
    """Validate and normalize a public YouTube video or playlist URL.

    Channel, search, and home-page URLs are intentionally rejected so an accidental
    paste cannot trigger a large channel-wide download.
    """

    cleaned = url.strip()
    if not cleaned:
        raise ValidationError("Paste a YouTube video or playlist URL.")

    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"}:
        raise ValidationError("The URL must begin with http:// or https://.")
    if parsed.username or parsed.password:
        raise ValidationError(
            "URLs containing usernames or passwords are not accepted."
        )
    if not _is_youtube_host(parsed.hostname):
        raise ValidationError("Only YouTube and youtu.be links are supported.")

    host = (parsed.hostname or "").lower().rstrip(".")
    path = parsed.path.rstrip("/") or "/"
    query = parse_qs(parsed.query)

    if host == "youtu.be" or host.endswith(".youtu.be"):
        if path == "/":
            raise ValidationError("This youtu.be link does not contain a video ID.")
        return cleaned

    is_watch = path == "/watch" and any(query.get("v", []))
    is_playlist = path == "/playlist" and any(query.get("list", []))
    is_direct_video = any(
        path.startswith(prefix)
        for prefix in ("/shorts/", "/live/", "/embed/", "/clip/")
    )
    is_podcast_page = path.startswith("/podcast/")

    if is_playlist and not include_playlist:
        raise ValidationError(
            "This is a playlist URL. Turn on ‘Download playlist’ or paste one episode's watch URL."
        )
    if is_watch or is_playlist or is_direct_video or is_podcast_page:
        return cleaned

    raise ValidationError(
        "Use a specific YouTube video, Short, live replay, podcast, or playlist URL—not a channel, "
        "search page, or YouTube home page."
    )


def resolve_ytdlp_prefix() -> tuple[str, ...] | None:
    """Return a safe argv prefix for invoking yt-dlp."""

    try:
        if importlib.util.find_spec("yt_dlp") is not None:
            return (sys.executable, "-m", "yt_dlp")
    except (ImportError, AttributeError, ValueError):
        pass

    executable = shutil.which("yt-dlp")
    if executable:
        return (executable,)
    return None


def check_dependencies() -> DependencyStatus:
    return DependencyStatus(
        ytdlp_prefix=resolve_ytdlp_prefix(),
        ffmpeg=shutil.which("ffmpeg"),
        ffprobe=shutil.which("ffprobe"),
        deno=shutil.which("deno"),
    )


def build_command(
    options: DownloadOptions,
    ytdlp_prefix: Sequence[str] | None = None,
) -> list[str]:
    """Create a shell-free yt-dlp command as an argv list."""

    normalized_url = validate_youtube_url(options.url, options.include_playlist)
    if not 1 <= options.playlist_limit <= 250:
        raise ValidationError("Playlist limit must be between 1 and 250 episodes.")

    output_dir = options.output_dir.expanduser().resolve()
    prefix = tuple(ytdlp_prefix or resolve_ytdlp_prefix() or ())
    if not prefix:
        raise RuntimeError("yt-dlp is not installed.")

    if options.include_playlist:
        output_template = (
            "%(playlist).60s/%(playlist_index)03d - %(title).110s [%(id)s].%(ext)s"
        )
    else:
        output_template = "%(uploader).50s - %(title).130s [%(id)s].%(ext)s"

    command = [
        *prefix,
        "--ignore-config",
        "--no-colors",
        "--newline",
        "--progress",
        "--progress-delta",
        "0.25",
        "--progress-template",
        "download:__PAE_PROGRESS__|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--progress-template",
        "postprocess:__PAE_POST__|%(progress.status)s|%(progress.postprocessor)s",
        "--print",
        "before_dl:__PAE_TITLE__|%(title)s",
        "--print",
        "after_move:__PAE_OUTPUT__|%(filepath)s",
        "--no-simulate",
        "--continue",
        "--no-overwrites",
        "--no-post-overwrites",
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--extractor-retries",
        "5",
        "--file-access-retries",
        "5",
        "--concurrent-fragments",
        "4",
        "--no-mark-watched",
        "--compat-options",
        "no-youtube-channel-redirect",
        "--output-na-placeholder",
        "Unknown",
        "--paths",
        str(output_dir),
        "--output",
        output_template,
        "--format",
        "bestaudio/best",
        "--extract-audio",
    ]

    if options.mode == AudioMode.BEST_SOURCE:
        command.extend(["--audio-format", "best"])
    elif options.mode == AudioMode.M4A:
        # Prefer a native M4A stream to avoid transcoding whenever possible.
        format_index = command.index("bestaudio/best")
        command[format_index] = "bestaudio[ext=m4a]/bestaudio/best"
        command.extend(["--audio-format", "m4a", "--audio-quality", "0"])
    elif options.mode == AudioMode.MP3:
        command.extend(["--audio-format", "mp3", "--audio-quality", "320K"])
    else:  # pragma: no cover - Enum prevents this in normal use
        raise ValidationError(f"Unsupported audio mode: {options.mode}")

    if options.embed_metadata:
        command.extend(
            [
                "--embed-metadata",
                "--embed-chapters",
                "--parse-metadata",
                "%(uploader|)s:%(meta_artist)s",
            ]
        )
    if options.embed_thumbnail:
        command.extend(["--embed-thumbnail", "--convert-thumbnails", "jpg"])

    if options.include_playlist:
        command.extend(
            [
                "--yes-playlist",
                "--playlist-end",
                str(options.playlist_limit),
                "--skip-playlist-after-errors",
                "3",
            ]
        )
    else:
        command.append("--no-playlist")

    if platform.system() == "Windows":
        command.append("--windows-filenames")

    command.append(normalized_url)
    return command


_ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def parse_status_line(raw_line: str) -> StatusEvent:
    """Parse only the stable, explicitly templated lines emitted by this app."""

    line = _ANSI_ESCAPE.sub("", raw_line).strip()
    if not line:
        return StatusEvent("empty")

    if line.startswith("__PAE_PROGRESS__|"):
        parts = line.split("|", 3)
        while len(parts) < 4:
            parts.append("")
        return StatusEvent(
            "progress", parts[1].strip(), (parts[2].strip(), parts[3].strip())
        )
    if line.startswith("__PAE_POST__|"):
        parts = line.split("|", 2)
        while len(parts) < 3:
            parts.append("")
        return StatusEvent("postprocess", parts[1].strip(), (parts[2].strip(),))
    if line.startswith("__PAE_TITLE__|"):
        return StatusEvent("title", line.split("|", 1)[1].strip())
    if line.startswith("__PAE_OUTPUT__|"):
        return StatusEvent("output", line.split("|", 1)[1].strip())
    if line.lower().startswith("error:"):
        return StatusEvent("error", line)
    if line.lower().startswith("warning:"):
        return StatusEvent("warning", line)
    return StatusEvent("log", line)


def percent_as_float(text: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    return max(0.0, min(100.0, float(match.group(1))))


def open_folder(path: Path) -> None:
    target = str(path.expanduser().resolve())
    system = platform.system()
    if system == "Windows":
        os.startfile(target)  # type: ignore[attr-defined]
    elif system == "Darwin":
        import subprocess

        subprocess.Popen(["open", target])
    else:
        import subprocess

        subprocess.Popen(["xdg-open", target])
