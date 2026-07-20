#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "catalog.json"
EXTRACTOR_DIR = ROOT / "tools" / "audio-extractor"
DEFAULT_OUTPUT_DIR = ROOT / "local-audio"


def load_sources() -> list[dict[str, object]]:
    with CATALOG_PATH.open(encoding="utf-8") as catalog_file:
        catalog = json.load(catalog_file)
    return list(catalog.get("sources", []))


def find_source(value: str, sources: list[dict[str, object]]) -> dict[str, object]:
    for source in sources:
        if value in {source.get("id"), source.get("youtubeId")}:
            return source
    raise ValueError(f"No packaged source matches {value!r}. Run with --list to see source IDs.")


def extractor_python() -> Path:
    candidates = [
        EXTRACTOR_DIR / ".venv" / "bin" / "python",
        EXTRACTOR_DIR / ".venv" / "Scripts" / "python.exe",
    ]
    return next((candidate for candidate in candidates if candidate.exists()), Path(sys.executable))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract authorized audio for an Acoustify source using the bundled local extractor."
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--source", help="Catalog source ID or YouTube ID")
    target.add_argument("--url", help="A specific YouTube video URL")
    parser.add_argument("--list", action="store_true", help="List packaged source IDs")
    parser.add_argument("--format", choices=("best", "m4a", "mp3"), default="m4a")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--no-metadata", action="store_true")
    parser.add_argument("--no-thumbnail", action="store_true")
    parser.add_argument(
        "--confirm-rights",
        action="store_true",
        help="Confirm that you own or are authorized to download this content",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    sources = load_sources()
    if args.list:
        for source in sources:
            youtube_id = source.get("youtubeId", "no-youtube-id")
            print(f"{source.get('id')}\n  {source.get('artist')} - {source.get('title')} [{youtube_id}]")
        return 0
    if not args.source and not args.url:
        print("Choose --source SOURCE_ID or --url YOUTUBE_URL. Run with --list to see packaged sources.")
        return 2

    if args.source:
        try:
            source = find_source(args.source, sources)
        except ValueError as error:
            print(f"Error: {error}")
            return 2
        youtube_id = str(source.get("youtubeId") or "")
        if not youtube_id:
            print("Error: that source does not have a YouTube ID.")
            return 2
        url = f"https://www.youtube.com/watch?v={youtube_id}"
        print(f"Acoustify source: {source.get('artist')} - {source.get('title')}")
    else:
        url = args.url

    cli_path = EXTRACTOR_DIR / "cli.py"
    if not cli_path.exists():
        print(f"Error: bundled extractor is missing at {cli_path}")
        return 3

    output_dir = args.output.expanduser().resolve()
    command = [
        str(extractor_python()),
        str(cli_path),
        str(url),
        "--output",
        str(output_dir),
        "--format",
        args.format,
    ]
    if args.no_metadata:
        command.append("--no-metadata")
    if args.no_thumbnail:
        command.append("--no-thumbnail")
    if args.confirm_rights:
        command.append("--confirm-rights")

    print(f"Output folder: {output_dir}")
    result = subprocess.run(command, cwd=EXTRACTOR_DIR, check=False)
    if result.returncode == 0:
        print("Import the generated file from its Acoustify source page; the [YouTube ID] filename preserves automatic matching.")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
