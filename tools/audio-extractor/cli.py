from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from core import (
    DEFAULT_OUTPUT_DIR,
    AudioMode,
    DownloadOptions,
    ValidationError,
    build_command,
    check_dependencies,
    parse_status_line,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Save an authorized public YouTube video or playlist as an audio file. "
            "No authentication, DRM, paywall, age-gate, or geo-restriction bypass is included."
        )
    )
    parser.add_argument("url", nargs="?", help="YouTube video or playlist URL")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Save folder (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=[mode.value for mode in AudioMode],
        default=AudioMode.BEST_SOURCE.value,
        help="best = source stream; m4a = AAC/M4A; mp3 = 320 kb/s MP3",
    )
    parser.add_argument("--playlist", action="store_true", help="Download a playlist")
    parser.add_argument(
        "--playlist-limit",
        type=int,
        default=25,
        help="Maximum playlist episodes (1–250)",
    )
    parser.add_argument("--no-metadata", action="store_true")
    parser.add_argument("--no-thumbnail", action="store_true")
    parser.add_argument(
        "--confirm-rights",
        action="store_true",
        help="Confirm that you own or are authorized to download the content",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    url = args.url or input("YouTube episode or playlist URL: ").strip()

    if not args.confirm_rights:
        answer = input(
            "Confirm you own this content, have permission, or the service/license expressly permits "
            "the download [type YES]: "
        ).strip()
        if answer != "YES":
            print("Authorization was not confirmed; nothing was downloaded.")
            return 2

    dependencies = check_dependencies()
    if not dependencies.required_ok or not dependencies.ytdlp_prefix:
        print(
            "Missing required dependencies: " + ", ".join(dependencies.missing_required)
        )
        print("Run the installer included with this package.")
        return 3
    if not dependencies.deno:
        print(
            "Warning: Deno is not installed; current YouTube extraction may be less reliable."
        )

    options = DownloadOptions(
        url=url,
        output_dir=args.output,
        mode=AudioMode(args.format),
        include_playlist=args.playlist,
        playlist_limit=args.playlist_limit,
        embed_metadata=not args.no_metadata,
        embed_thumbnail=not args.no_thumbnail,
    )

    try:
        options.output_dir.expanduser().mkdir(parents=True, exist_ok=True)
        command = build_command(options, dependencies.ytdlp_prefix)
    except (ValidationError, RuntimeError, OSError) as exc:
        print(f"Error: {exc}")
        return 2

    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            event = parse_status_line(raw_line)
            if event.kind == "progress":
                speed = event.extra[0] if event.extra else ""
                eta = event.extra[1] if len(event.extra) > 1 else ""
                print(
                    f"\r{event.value:>7}  {speed:>12}  ETA {eta:>8}", end="", flush=True
                )
            elif event.kind == "title":
                print(f"\nDownloading: {event.value}")
            elif event.kind == "postprocess":
                processor = event.extra[0] if event.extra else "audio"
                print(f"\nFinishing: {processor}")
            elif event.kind == "output":
                print(f"\nSaved: {event.value}")
            elif event.kind in {"error", "warning", "log"}:
                print(f"\n{event.value}")
        return process.wait()
    except KeyboardInterrupt:
        print("\nCancelling…")
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
