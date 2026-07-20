from __future__ import annotations

import unittest
from pathlib import Path

from core import (
    AudioMode,
    DownloadOptions,
    ValidationError,
    build_command,
    parse_status_line,
    percent_as_float,
    validate_youtube_url,
)


class UrlValidationTests(unittest.TestCase):
    def test_accepts_watch_url(self) -> None:
        url = "https://www.youtube.com/watch?v=abcdefghijk"
        self.assertEqual(validate_youtube_url(url), url)

    def test_accepts_short_url(self) -> None:
        url = "https://youtu.be/abcdefghijk?t=12"
        self.assertEqual(validate_youtube_url(url), url)

    def test_playlist_requires_opt_in(self) -> None:
        url = "https://www.youtube.com/playlist?list=PL123"
        with self.assertRaises(ValidationError):
            validate_youtube_url(url, include_playlist=False)
        self.assertEqual(validate_youtube_url(url, include_playlist=True), url)

    def test_rejects_channel_url(self) -> None:
        with self.assertRaises(ValidationError):
            validate_youtube_url("https://www.youtube.com/@example")

    def test_rejects_lookalike_domain(self) -> None:
        with self.assertRaises(ValidationError):
            validate_youtube_url("https://youtube.com.example.org/watch?v=x")

    def test_rejects_embedded_credentials(self) -> None:
        with self.assertRaises(ValidationError):
            validate_youtube_url("https://user:pass@youtube.com/watch?v=x")


class CommandBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = DownloadOptions(
            url="https://www.youtube.com/watch?v=abcdefghijk",
            output_dir=Path("./downloads"),
        )

    def test_best_source_does_not_request_lossy_codec(self) -> None:
        command = build_command(self.base, ["yt-dlp"])
        self.assertIn("--extract-audio", command)
        idx = command.index("--audio-format")
        self.assertEqual(command[idx + 1], "best")
        self.assertNotIn("--audio-quality", command)
        self.assertIn("--no-playlist", command)

    def test_m4a_prefers_native_m4a(self) -> None:
        options = DownloadOptions(**{**self.base.__dict__, "mode": AudioMode.M4A})
        command = build_command(options, ["yt-dlp"])
        format_idx = command.index("--format")
        self.assertEqual(command[format_idx + 1], "bestaudio[ext=m4a]/bestaudio/best")
        audio_idx = command.index("--audio-format")
        self.assertEqual(command[audio_idx + 1], "m4a")

    def test_mp3_uses_320k(self) -> None:
        options = DownloadOptions(**{**self.base.__dict__, "mode": AudioMode.MP3})
        command = build_command(options, ["yt-dlp"])
        quality_idx = command.index("--audio-quality")
        self.assertEqual(command[quality_idx + 1], "320K")

    def test_playlist_limit(self) -> None:
        options = DownloadOptions(
            url="https://www.youtube.com/playlist?list=PL123",
            output_dir=Path("./downloads"),
            include_playlist=True,
            playlist_limit=12,
        )
        command = build_command(options, ["yt-dlp"])
        self.assertIn("--yes-playlist", command)
        idx = command.index("--playlist-end")
        self.assertEqual(command[idx + 1], "12")

    def test_command_is_not_shell_interpolated(self) -> None:
        url = "https://www.youtube.com/watch?v=abcdefghijk&list=PL123"
        options = DownloadOptions(url=url, output_dir=Path("./downloads"))
        command = build_command(options, ["yt-dlp"])
        self.assertEqual(command[-1], url)
        self.assertNotIn("shell=True", command)


class StatusParserTests(unittest.TestCase):
    def test_progress(self) -> None:
        event = parse_status_line("__PAE_PROGRESS__| 42.5%|1.2MiB/s|00:10\n")
        self.assertEqual(event.kind, "progress")
        self.assertEqual(percent_as_float(event.value), 42.5)
        self.assertEqual(event.extra, ("1.2MiB/s", "00:10"))

    def test_output_path_can_contain_pipe(self) -> None:
        event = parse_status_line("__PAE_OUTPUT__|/tmp/A | B.m4a")
        self.assertEqual(event.kind, "output")
        self.assertEqual(event.value, "/tmp/A | B.m4a")


if __name__ == "__main__":
    unittest.main()
