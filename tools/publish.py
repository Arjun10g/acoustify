#!/usr/bin/env python3
"""Publish Acoustify's music to its private Hugging Face dataset.

    npm run publish                       # sync library/ + data/catalog.json to the dataset
    python tools/publish.py --dry-run     # show what would change; writes nothing, locally or remotely
    python tools/publish.py --list-missing  # catalog sources whose audio is neither local nor remote
    python tools/publish.py --ci          # GitHub Actions: no local audio, build from the dataset
    python tools/publish.py --self-test   # offline checks of the library builder

What it does, in order:

1. Reads data/catalog.json (schema 5) — the source of truth.
2. Hashes library/media/<name>.m4a and library/artwork/<name>.jpg and uploads only
   files whose sha256 differs from the dataset's copy, all in ONE commit (plus
   a dataset card the first time).
3. Builds library.json (schema 2). Every audio/artwork file carries its own
   `rev` — the commit that last changed it — so file URLs never move and the
   phone's offline downloads (keyed by URL) survive later publishes.
4. Uploads library.json in a second commit (only when its content changed).
5. Writes data/library.json, the app's bundled offline fallback — only ever
   with the library the dataset actually serves, so never on a dry run and
   never before the library.json commit has landed. A bundle ahead of the
   dataset would show phones songs whose files don't exist yet.

Auth: --token, else $HF_TOKEN, else HF_TOKEN in the repo's .env, else the
token saved by `hf auth login`. The token is never printed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
OUTPUT = ROOT / "data" / "library.json"
LIBRARY_DIR = ROOT / "library"
ENV_FILE = ROOT / ".env"

REPO_ID = "arjun10g/acoustify-library"
REPO_TYPE = "dataset"
HUB = "https://huggingface.co"
SCHEMA = 2
CATALOG_VERSION = 5
LIBRARY_FILE = "library.json"
PENDING_REV = "main"  # dry run: files that would be uploaded have no commit yet (never written to disk)

# Named after the YouTube id, or readable (media/rcs-live-at-the-ryman.m4a) for an album joined from a playlist.
AUDIO_RE = re.compile(r"^media/[\w-]+\.m4a$")
ARTWORK_RE = re.compile(r"^artwork/[\w-]+\.jpg$")
YOUTUBE_ID_RE = re.compile(r"^[\w-]{11}$")
PLAYLIST_ID_RE = re.compile(r"^[\w-]{12,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MIME = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}

README = """---
pretty_name: Acoustify library
viewer: false
tags:
  - audio
  - music
---

# Acoustify library

The private music library behind [Acoustify](https://arjun10g.github.io/acoustify/),
a personal player for live sessions.

The recordings belong to their artists. They are kept here for personal
listening only — **keep this dataset private** and do not redistribute it.

- `library.json` — what the app reads: sources, songs, and a pinned revision for every file
- `media/<youtubeId or album name>.m4a` — audio
- `artwork/<youtubeId or album name>.jpg` — cover art

Managed by `tools/publish.py` in the Acoustify repository. Do not edit by hand.
"""


# ── Small pure helpers ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FileInfo:
    """A file's identity, locally or on the dataset. `blob` is the git blob id,
    used only when the remote copy is a plain git file without an LFS sha256."""
    bytes: int | None
    sha256: str | None = None
    blob: str | None = None


def parse_env(text: str) -> dict[str, str]:
    """Minimal .env parser: KEY=value, optional `export`, quotes, # comments."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value).strip()
        out[key] = value
    return out


def resolve_token(cli_token: str | None) -> tuple[str | None, str]:
    """(token, where it came from). Never log the token itself."""
    if cli_token:
        return cli_token.strip(), "--token"
    if os.environ.get("HF_TOKEN", "").strip():
        return os.environ["HF_TOKEN"].strip(), "$HF_TOKEN"
    if ENV_FILE.exists():
        token = parse_env(ENV_FILE.read_text(encoding="utf-8")).get("HF_TOKEN", "").strip()
        if token:
            return token, ".env"
    return None, "hf auth login (if any)"


def token_scope_problem(whoami: dict | None) -> str | None:
    """Why the publishing token is broader than it needs to be, or None.

    Publishing only needs write access to this one dataset. A classic write
    token, or a fine-grained one that can write anywhere else, can change
    every repo it reaches — and CI runs third-party packages with it."""
    token = ((whoami or {}).get("auth") or {}).get("accessToken") or {}
    role = token.get("role")
    if role in ("write", "admin"):
        return (f"this is a classic {role} token, so it can change every repo on the account. "
                f"Use a fine-grained token with write access to {REPO_ID} only.")
    if role != "fineGrained":
        return None
    elsewhere: list[str] = []
    for scope in (token.get("fineGrained") or {}).get("scoped") or []:
        entity = scope.get("entity") or {}
        if entity.get("name") == REPO_ID or not any("write" in str(p) for p in scope.get("permissions") or []):
            continue
        name = entity.get("name") or "?"
        elsewhere.append(f"every repo of {name}" if entity.get("type") in ("user", "org") else name)
    if elsewhere:
        return f"this fine-grained token can also write to {', '.join(elsewhere[:3])}. Limit it to {REPO_ID}."
    return None


def file_url(path: str, rev: str = "main") -> str:
    return f"{HUB}/datasets/{REPO_ID}/resolve/{rev}/{path}"


def mime_type(path: str) -> str:
    return MIME.get(Path(path).suffix.lower(), "application/octet-stream")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def human_bytes(n: int | None) -> str:
    if not n:
        return "0 B"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def hash_file(path: Path) -> FileInfo:
    """sha256 plus git blob id in one pass (the blob id needs the size up front)."""
    size = path.stat().st_size
    sha = hashlib.sha256()
    blob = hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
            blob.update(chunk)
    return FileInfo(bytes=size, sha256=sha.hexdigest(), blob=blob.hexdigest())


def same_content(local: FileInfo, remote: FileInfo | None) -> bool:
    if remote is None:
        return False
    if remote.sha256:
        return remote.sha256 == local.sha256
    return bool(remote.blob) and remote.blob == local.blob


def validate_catalog(catalog: dict) -> list[str]:
    """The data/catalog.json rules publishing depends on (SPEC §2). The full
    validator is tools/validate-catalog.mjs; this keeps a broken catalog from
    ever reaching the phones even when publish runs on its own."""
    errors: list[str] = []
    if catalog.get("version") != CATALOG_VERSION:
        errors.append(f"catalog version must be {CATALOG_VERSION} (found {catalog.get('version')!r})")
    sources = catalog.get("sources")
    if not isinstance(sources, list):
        return errors + ["catalog.sources must be an array"]
    seen: set[str] = set()
    files: dict[str, str] = {}
    videos: dict[str, str] = {}

    def claim_video(yid: str, owner: str, label: str) -> None:
        if yid in videos:
            errors.append(f"{label}: youtubeId {yid} is already used by {videos[yid]}")
        else:
            videos[yid] = owner

    for i, s in enumerate(sources):
        sid = s.get("id") if isinstance(s, dict) else None
        label = sid or f"sources[{i}]"
        if not isinstance(s, dict) or not isinstance(sid, str) or not sid:
            errors.append(f"{label}: missing id")
            continue
        if sid in seen:
            errors.append(f"{sid}: duplicate source id")
        seen.add(sid)
        artists = s.get("artists")
        if not isinstance(artists, list) or not artists or not all(isinstance(a, str) and a.strip() for a in artists):
            errors.append(f"{sid}: artists must be a non-empty list of names")
        # One YouTube video per source, or a playlist whose songs carry their own video ids.
        yid, playlist = s.get("youtubeId"), s.get("youtubePlaylistId")
        if playlist is not None and not PLAYLIST_ID_RE.match(str(playlist)):
            errors.append(f"{sid}: youtubePlaylistId must be a YouTube playlist id")
        if yid is not None or playlist is None:
            if not YOUTUBE_ID_RE.match(str(yid or "")):
                errors.append(f"{sid}: youtubeId must be an 11-character YouTube id (or set youtubePlaylistId)")
            else:
                claim_video(yid, sid, sid)
        for key, pattern, shape in (("audio", AUDIO_RE, "media/<name>.m4a"), ("artwork", ARTWORK_RE, "artwork/<name>.jpg")):
            path = str(s.get(key, ""))
            if not pattern.match(path):
                errors.append(f"{sid}: {key} must look like {shape} (letters, digits, - and _)")
            elif path in files:
                errors.append(f"{sid}: {path} is already used by {files[path]}")
            else:
                files[path] = sid
        if not DATE_RE.match(str(s.get("added", ""))):
            errors.append(f"{sid}: added must be YYYY-MM-DD")
        duration = s.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            errors.append(f"{sid}: duration must be a positive number of seconds")
            continue
        tracks = s.get("tracks")
        if not isinstance(tracks, list) or not tracks:
            errors.append(f"{sid}: needs at least one track")
            continue
        track_ids: set[str] = set()
        for j, t in enumerate(tracks):
            tid = t.get("id")
            if not tid or tid in track_ids:
                errors.append(f"{sid}: track {j + 1} id missing or duplicated ({tid!r})")
            track_ids.add(tid)
            tyid = t.get("youtubeId")
            if tyid is not None:
                if not YOUTUBE_ID_RE.match(str(tyid)):
                    errors.append(f"{sid}/{tid}: youtubeId must be an 11-character YouTube id")
                elif tyid != yid:
                    claim_video(tyid, f"{sid}/{tid}", f"{sid}/{tid}")
            start, end = t.get("start"), t.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
                errors.append(f"{sid}/{tid}: start/end must be numbers with end > start")
                continue
            if j == 0 and start < 0:
                errors.append(f"{sid}/{tid}: first track starts before 0")
            if j > 0 and isinstance(tracks[j - 1].get("end"), (int, float)) and abs(start - tracks[j - 1]["end"]) > 0.01:
                errors.append(f"{sid}/{tid}: starts at {start}, previous track ends at {tracks[j - 1]['end']}")
            if end > duration + 0.01:
                errors.append(f"{sid}/{tid}: ends after the recording ({end} > {duration})")
        last_end = tracks[-1].get("end")
        if isinstance(last_end, (int, float)) and abs(last_end - duration) > 0.01:
            errors.append(f"{sid}: last track ends at {last_end}, recording is {duration}")
    return errors


def catalog_paths(catalog: dict) -> list[str]:
    """Every file the catalog references, in catalog order, without duplicates."""
    paths: list[str] = []
    for s in catalog.get("sources", []):
        for key in ("audio", "artwork"):
            p = s.get(key)
            if isinstance(p, str) and p and p not in paths:
                paths.append(p)
    return paths


def plan_uploads(catalog: dict, local: dict[str, FileInfo], remote: dict[str, FileInfo]) -> list[str]:
    """Catalog files present locally whose content the dataset doesn't have yet."""
    return [p for p in catalog_paths(catalog) if p in local and not same_content(local[p], remote.get(p))]


def missing_audio(catalog: dict, local: dict[str, FileInfo], remote: dict[str, FileInfo]) -> list[str]:
    return [s["id"] for s in catalog.get("sources", [])
            if s.get("audio") not in local and s.get("audio") not in remote]


def previous_revs(prev: dict | None) -> dict[str, tuple[str, str]]:
    """path -> (rev, sha256) from a previously published schema-2 library."""
    out: dict[str, tuple[str, str]] = {}
    if not isinstance(prev, dict) or prev.get("schema") != SCHEMA:
        return out
    for s in prev.get("sources") or []:
        for key in ("audio", "art"):
            f = s.get(key) if isinstance(s, dict) else None
            if isinstance(f, dict) and f.get("path") and f.get("rev") and f.get("sha256"):
                out[f["path"]] = (f["rev"], f["sha256"])
    return out


def build_library(
    catalog: dict,
    *,
    local: dict[str, FileInfo],
    remote: dict[str, FileInfo],
    prev: dict | None,
    uploaded: set[str],
    upload_rev: str | None,
    head_sha: str | None,
    generated: str,
    last_commits: dict[str, str] | None = None,
) -> tuple[dict, list[str], list[str]]:
    """Pure: (library.json dict, skipped source ids, warnings).

    rev rule (SPEC §3): uploaded in this run → that commit; unchanged → the rev
    the previous library.json pinned when its sha256 still matches; otherwise
    the commit that last touched the file (`last_commits`, when known) or the
    current head — the file is there either way. A dry run pins pending
    uploads to PENDING_REV since their commit doesn't exist yet.
    """
    prev_rev = previous_revs(prev)
    last_commits = last_commits or {}
    skipped: list[str] = []
    warnings: list[str] = []

    def describe(path: str) -> dict | None:
        loc, rem = local.get(path), remote.get(path)
        if path in uploaded:
            info, rev = loc, upload_rev or PENDING_REV
        elif rem is not None:
            # Prefer the remote identity; a local copy only adds a sha256 when
            # the dataset stored the file without LFS.
            sha = rem.sha256 or (loc.sha256 if loc and same_content(loc, rem) else None)
            info = FileInfo(bytes=rem.bytes if rem.bytes is not None else (loc.bytes if loc else None), sha256=sha)
            old = prev_rev.get(path)
            rev = old[0] if old and sha and old[1] == sha else (last_commits.get(path) or head_sha or PENDING_REV)
        else:
            return None
        entry = {"path": path, "rev": rev, "bytes": info.bytes}
        if info.sha256:
            entry["sha256"] = info.sha256
        entry["type"] = mime_type(path)
        return entry

    sources_out: list[dict] = []
    for s in catalog.get("sources", []):
        audio = describe(s.get("audio", ""))
        if audio is None:
            skipped.append(s["id"])
            continue
        art = describe(s["artwork"]) if s.get("artwork") else None
        if s.get("artwork") and art is None:
            warnings.append(f"{s['id']}: artwork {s['artwork']} is neither local nor on the dataset — published without art")
        out: dict = {}
        for key, value in s.items():
            if key == "audio":
                out["audio"] = audio
            elif key == "artwork":
                out["art"] = art
            else:
                out[key] = value
        out.setdefault("art", art)
        sources_out.append(out)

    library = {
        "schema": SCHEMA,
        "app": "acoustify",
        "generated": generated,
        "repo": REPO_ID,
        "hub": HUB,
        "revision": upload_rev or head_sha or PENDING_REV,
        "catalogVersion": catalog.get("version"),
        "sources": sources_out,
    }
    return library, skipped, warnings


def unpinned_paths(catalog: dict, remote: dict[str, FileInfo], prev: dict | None, uploaded: set[str]) -> list[str]:
    """Remote files whose rev the previous library can't vouch for; publish
    looks up the commit that last changed each so their URLs stay stable."""
    prev_rev = previous_revs(prev)
    out = []
    for p in catalog_paths(catalog):
        rem = remote.get(p)
        if p in uploaded or rem is None:
            continue
        old = prev_rev.get(p)
        if not (old and rem.sha256 and old[1] == rem.sha256):
            out.append(p)
    return out


def library_content(library: dict | None) -> dict | None:
    """The parts of library.json that matter for "did anything change?"."""
    if not isinstance(library, dict):
        return None
    return {k: v for k, v in library.items() if k not in ("generated", "revision")}


def settle_library(library: dict, prev: dict | None) -> tuple[dict, bool]:
    """(library to publish, changed?). Unchanged content keeps the previous
    stamp so the app's "same revision + generated" check sees no update."""
    if prev is not None and library_content(library) == library_content(prev):
        return {**library, "generated": prev.get("generated"), "revision": prev.get("revision")}, False
    return library, True


def to_json(library: dict) -> str:
    return json.dumps(library, indent=2, ensure_ascii=False) + "\n"


def song_count(library: dict) -> int:
    return sum(len(s.get("tracks") or []) for s in library.get("sources", []))


def library_changes(prev: dict | None, library: dict, limit: int = 12) -> list[str]:
    """Readable differences from the published library, one source per line:
    + added (with its song count), - removed, ~ changed."""
    before = {s.get("id"): s for s in (prev or {}).get("sources") or [] if isinstance(s, dict)}
    after = {s.get("id"): s for s in library.get("sources") or []}

    def songs(source: dict) -> str:
        n = len(source.get("tracks") or [])
        return f"{n} song{'' if n == 1 else 's'}"

    lines = [f"+ {sid} ({songs(s)})" for sid, s in after.items() if sid not in before]
    lines += [f"- {sid}" for sid in before if sid not in after]
    lines += [f"~ {sid}" for sid, s in after.items() if sid in before and s != before[sid]]
    if len(lines) > limit:
        lines = lines[:limit] + [f"… and {len(lines) - limit} more"]
    return lines


# ── I/O ──────────────────────────────────────────────────────────────────────

def load_catalog() -> dict:
    try:
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"error: {CATALOG.relative_to(ROOT)} not found")
    except json.JSONDecodeError as e:
        sys.exit(f"error: {CATALOG.relative_to(ROOT)} is not valid JSON ({e})")


def scan_local(catalog: dict) -> dict[str, FileInfo]:
    out: dict[str, FileInfo] = {}
    for p in catalog_paths(catalog):
        f = LIBRARY_DIR / p
        if f.is_file() and f.stat().st_size > 0:
            out[p] = hash_file(f)
    return out


def check_durations(catalog: dict) -> list[str]:
    """Warn when a staged file's real length drifts from the catalog duration
    (tracks end at the catalog duration, so a mismatch means clipped songs)."""
    try:
        from mutagen.mp4 import MP4
    except ImportError:
        return []
    warnings = []
    for s in catalog.get("sources", []):
        f = LIBRARY_DIR / str(s.get("audio", ""))
        if not f.is_file():
            continue
        try:
            actual = float(MP4(str(f)).info.length)
        except Exception:
            continue
        if abs(actual - float(s.get("duration") or 0)) > 1.0:
            warnings.append(f"{s['id']}: catalog duration {s.get('duration')} s but {f.name} is {actual:.2f} s")
    return warnings


class Remote:
    """The dataset as it is right now."""

    def __init__(self, api) -> None:
        self.api = api
        self.exists = False
        self.private = True
        self.head: str | None = None
        self.files: dict[str, FileInfo] = {}

    def refresh(self) -> "Remote":
        from huggingface_hub.errors import RepositoryNotFoundError
        try:
            info = self.api.repo_info(REPO_ID, repo_type=REPO_TYPE, files_metadata=True)
        except RepositoryNotFoundError:
            self.exists, self.head, self.files = False, None, {}
            return self
        self.exists = True
        self.private = bool(info.private)
        self.head = info.sha
        files = {}
        for s in info.siblings or []:
            lfs = getattr(s, "lfs", None)
            sha = (lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)) if lfs else None
            files[s.rfilename] = FileInfo(bytes=getattr(s, "size", None), sha256=sha, blob=getattr(s, "blob_id", None))
        self.files = files
        return self

    def last_commits(self, paths: list[str]) -> dict[str, str]:
        """path -> oid of the commit that last changed it (best effort)."""
        out: dict[str, str] = {}
        for i in range(0, len(paths), 50):
            try:
                infos = self.api.get_paths_info(REPO_ID, paths[i:i + 50], expand=True,
                                                revision=self.head, repo_type=REPO_TYPE)
            except Exception as e:
                print(f"  (could not look up file history: {type(e).__name__}; pinning to head)")
                return out
            for f in infos:
                commit = getattr(f, "last_commit", None)
                if commit is not None and getattr(commit, "oid", None):
                    out[f.path] = commit.oid
        return out

    def library(self) -> dict | None:
        """The published library.json at head, or None (first publish / unreadable)."""
        if not self.exists or LIBRARY_FILE not in self.files:
            return None
        import tempfile
        from huggingface_hub import hf_hub_download
        try:
            with tempfile.TemporaryDirectory() as tmp:
                p = hf_hub_download(REPO_ID, LIBRARY_FILE, repo_type=REPO_TYPE, revision=self.head,
                                    token=self.api.token, cache_dir=tmp)
                return json.loads(Path(p).read_text(encoding="utf-8"))
        except Exception as e:  # corrupt or unreadable — rebuild from scratch
            print(f"  (previous library.json unreadable: {type(e).__name__}; rebuilding)")
            return None


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token", default=None,
                    help=f"fine-grained HF token with write access to {REPO_ID} (default: $HF_TOKEN, then .env)")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would upload and how library.json would change; write nothing")
    ap.add_argument("--list-missing", action="store_true",
                    help="print ids of catalog sources whose audio is neither in library/ nor on the dataset")
    ap.add_argument("--ci", action="store_true",
                    help="ignore library/; build purely from the dataset and fail if any source's audio is missing")
    ap.add_argument("--self-test", action="store_true", help="run offline checks of the library builder and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    sys.stdout.reconfigure(line_buffering=True)  # keep stdout/stderr in order in CI logs

    catalog = load_catalog()
    problems = validate_catalog(catalog)
    if problems:
        print(f"data/catalog.json has {len(problems)} problem(s):", file=sys.stderr)
        for p in problems[:40]:
            print(f"  - {p}", file=sys.stderr)
        print("Fix them (node tools/validate-catalog.mjs gives details) and re-run.", file=sys.stderr)
        return 1

    try:
        from huggingface_hub import CommitOperationAdd, HfApi
        from huggingface_hub.errors import HfHubHTTPError
    except ImportError:
        print("error: huggingface_hub is not installed. Use the repo's .venv (npm run publish)\n"
              "       or: pip install --require-hashes --only-binary=:all: -r tools/requirements.lock", file=sys.stderr)
        return 1

    token, token_source = resolve_token(args.token)
    api = HfApi(token=token)

    try:
        remote = Remote(api).refresh()
        if not remote.exists:
            api.whoami()  # a bad token makes a private dataset look missing — rule that out
    except HfHubHTTPError as e:
        return auth_hint(e, token_source)
    except Exception as e:  # no token anywhere, or offline
        print(f"error: could not reach Hugging Face ({type(e).__name__}).", file=sys.stderr)
        if token is None:
            print(f"  No token found: put HF_TOKEN=hf_… in .env (a fine-grained token with write access to\n"
                  f"  {REPO_ID} only; never commit it).", file=sys.stderr)
        return 1

    local = {} if args.ci else scan_local(catalog)

    if args.list_missing:
        for sid in missing_audio(catalog, local, remote.files):
            print(sid)
        for s in catalog["sources"]:
            if s["artwork"] not in local and s["artwork"] not in remote.files:
                print(f"  (artwork missing for {s['id']})", file=sys.stderr)
        return 0

    mode = "CI" if args.ci else ("dry run" if args.dry_run else "publish")
    print(f"Acoustify publish ({mode}) → {HUB}/datasets/{REPO_ID}  (token from {token_source})")
    if remote.exists:
        print(f"  dataset head {remote.head[:10] if remote.head else '?'} · {len(remote.files)} files · "
              f"{'private' if remote.private else 'PUBLIC'}")
    else:
        print("  dataset does not exist yet — it will be created (private)")

    if token is not None:
        try:
            problem = token_scope_problem(api.whoami())
        except Exception:  # best effort: whoami is rate limited, and publishing works without it
            problem = None
        if problem:
            note = f"the token from {token_source} is too broad: {problem}"
            print(f"::warning::{note}" if args.ci else f"  warning: {note}")

    if remote.exists and not remote.private:
        msg = (f"The dataset is PUBLIC. It must stay private: open {HUB}/datasets/{REPO_ID}/settings, "
               "make it private, then re-run.")
        if not args.dry_run:
            print(f"error: {msg}", file=sys.stderr)
            return 1
        print(f"  warning: {msg}")

    missing = missing_audio(catalog, local, remote.files)
    if missing:
        where = "on the dataset" if args.ci else "in library/ or on the dataset"
        print(f"  {len(missing)} source(s) have no audio {where}: {', '.join(missing)}")
        if args.ci:
            print("error: publish those files from the laptop first (npm run publish), then re-run CI.",
                  file=sys.stderr)
            return 1
        print("  → they are left out of library.json until their audio is staged (npm run add)")

    for w in ([] if args.ci else check_durations(catalog)):
        print(f"  warning: {w}")

    uploads = plan_uploads(catalog, local, remote.files)
    upload_bytes = sum(local[p].bytes or 0 for p in uploads)
    new_count = sum(1 for p in uploads if p not in remote.files)
    print(f"  {len(uploads)} file(s) to upload ({new_count} new, {len(uploads) - new_count} changed, "
          f"{human_bytes(upload_bytes)})")
    for p in uploads:
        print(f"    + {p}  {human_bytes(local[p].bytes)}{'' if p not in remote.files else '  (changed)'}")

    referenced = set(catalog_paths(catalog))
    orphans = sorted(p for p in remote.files if p.startswith(("media/", "artwork/")) and p not in referenced)
    if orphans:
        print(f"  note: {len(orphans)} dataset file(s) not in the catalog (left in place): "
              f"{', '.join(orphans[:6])}{' …' if len(orphans) > 6 else ''}")

    prev = remote.library()
    need_readme = not remote.exists or "README.md" not in remote.files
    if need_readme:
        print("  + README.md (dataset card)")
    upload_rev: str | None = None

    try:
        if not args.dry_run:
            if not remote.exists:
                api.create_repo(REPO_ID, repo_type=REPO_TYPE, private=True, exist_ok=True)
                print(f"  created private dataset {HUB}/datasets/{REPO_ID}")
                remote.refresh()
            ops = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(LIBRARY_DIR / p)) for p in uploads]
            if need_readme:
                ops.append(CommitOperationAdd(path_in_repo="README.md", path_or_fileobj=README.encode("utf-8")))
            if ops:
                info = api.create_commit(
                    REPO_ID, repo_type=REPO_TYPE, operations=ops, parent_commit=remote.head,
                    commit_message=(f"Add {len(uploads)} file(s)" if uploads else "Add dataset card"),
                )
                print(f"  committed {info.oid[:10]} ({len(ops)} file(s))")
                if uploads:
                    upload_rev = info.oid
                remote.head = info.oid
    except Exception as e:  # HTTP errors and dropped connections alike
        return auth_hint(e, token_source)

    if upload_rev:
        remote.refresh()  # sizes/shas of what was just uploaded
    unpinned = unpinned_paths(catalog, remote.files, prev, set(uploads))
    last_commits = remote.last_commits(unpinned) if unpinned else {}

    library, skipped, warnings = build_library(
        catalog, local=local, remote=remote.files, prev=prev,
        uploaded=set(uploads), upload_rev=upload_rev,
        head_sha=remote.head, generated=utc_now(), last_commits=last_commits,
    )
    for w in warnings:
        print(f"  warning: {w}")
    library, changed = settle_library(library, prev)
    blob = to_json(library)
    summary = f"{len(library['sources'])} sources, {song_count(library)} songs"
    print(f"  library.json: {summary}{' (skipped: ' + ', '.join(skipped) + ')' if skipped else ''}")
    for line in library_changes(prev, library):
        print(f"    {line}")

    if args.dry_run:
        # Pending uploads are pinned to "main" here and 404 until they exist, so a
        # dry run must never leave this library where the app (or a commit) finds it.
        if prev is not None and OUTPUT.exists() and OUTPUT.read_text(encoding="utf-8") != to_json(prev):
            print(f"  note: {OUTPUT.relative_to(ROOT)} differs from the dataset's library.json; "
                  "the next real publish (or CI) rewrites it.")
        print("dry run — nothing uploaded, data/library.json left as it is. "
              + (f"library.json would change ({summary})." if changed else "library.json is already up to date."))
        return 0

    if changed:
        try:
            info = api.create_commit(
                REPO_ID, repo_type=REPO_TYPE, parent_commit=remote.head,
                operations=[CommitOperationAdd(path_in_repo=LIBRARY_FILE, path_or_fileobj=blob.encode("utf-8"))],
                commit_message=f"library.json: {summary}",
            )
        except Exception as e:
            return auth_hint(e, token_source)
        print(f"  published {file_url(LIBRARY_FILE)} ({info.oid[:10]})")

    # Only now does the bundle match what the dataset serves.
    if write_bundle(blob):
        print(f"  wrote {OUTPUT.relative_to(ROOT)}")
    print("Phones pick up the new library on their next open." if changed
          else "library.json is already up to date on the dataset — nothing to publish.")
    return 0


def write_bundle(blob: str, output: Path | None = None) -> bool:
    """Write the app's bundled data/library.json when it differs. True if written."""
    output = output or OUTPUT
    if output.exists() and output.read_text(encoding="utf-8") == blob:
        return False
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(blob, encoding="utf-8")
    return True


def auth_hint(error: Exception, token_source: str) -> int:
    """Explain a failed Hub request. Nothing is half-published: each commit is atomic,
    and a re-run skips files that already made it."""
    status = getattr(getattr(error, "response", None), "status_code", None)
    detail = getattr(error, "server_message", None) or ""
    print(f"error: Hugging Face request failed ({status or type(error).__name__}){': ' + detail if detail else ''}.",
          file=sys.stderr)
    if status in (401, 403):
        print(f"  The token from {token_source} was rejected or lacks access to {REPO_ID}.\n"
              f"  Publishing needs a fine-grained token with write access to {REPO_ID}:\n"
              "  put HF_TOKEN=hf_… in .env (never commit it).", file=sys.stderr)
    elif status in (409, 412):
        print("  The dataset changed while publishing (another publish ran). Re-run.", file=sys.stderr)
    else:
        print("  Check your connection and re-run; files that already uploaded are skipped.", file=sys.stderr)
    return 1


# ── Self-test (no network) ───────────────────────────────────────────────────

def self_test() -> int:
    checks = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal checks
        if not cond:
            raise AssertionError(msg)
        checks += 1

    def source(yid: str, sid: str, duration: float = 200.0, **extra) -> dict:
        return {
            "id": sid, "title": sid.title(), "artist": "A", "artists": ["A"], "provider": "local",
            "youtubeId": yid, "duration": duration, "audio": f"media/{yid}.m4a",
            "artwork": f"artwork/{yid}.jpg", "added": "2026-09-24", "tags": [],
            "tracks": [{"id": "t", "title": "T", "start": 0, "end": duration}], **extra,
        }

    ids = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD", "EEEEEEEEEEE"]
    catalog = {"version": 5, "sources": [source(y, f"s{i}") for i, y in enumerate(ids)]}
    check(validate_catalog(catalog) == [], f"valid catalog flagged: {validate_catalog(catalog)}")

    # s0: new locally · s1: changed locally · s2: unchanged, prev rev matches
    # s3: remote only, prev sha differs → head · s4: nowhere
    L = lambda sha, n=100: FileInfo(bytes=n, sha256=sha, blob="b" + sha)  # noqa: E731
    local = {
        "media/AAAAAAAAAAA.m4a": L("a1"), "artwork/AAAAAAAAAAA.jpg": L("a1art", 10),
        "media/BBBBBBBBBBB.m4a": L("b2"),
        "media/CCCCCCCCCCC.m4a": L("c1"), "artwork/CCCCCCCCCCC.jpg": L("c1art", 10),
    }
    remote = {
        "media/BBBBBBBBBBB.m4a": L("b1"), "artwork/BBBBBBBBBBB.jpg": L("b1art", 10),
        "media/CCCCCCCCCCC.m4a": L("c1"), "artwork/CCCCCCCCCCC.jpg": L("c1art", 10),
        "media/DDDDDDDDDDD.m4a": L("d2", 300), "artwork/DDDDDDDDDDD.jpg": FileInfo(bytes=12, sha256=None, blob="gitblob"),
        "media/ZZZZZZZZZZZ.m4a": L("orphan"),
    }
    prev = {"schema": 2, "generated": "2026-09-01T00:00:00Z", "revision": "rev-prev", "sources": [
        {"id": "s2", "audio": {"path": "media/CCCCCCCCCCC.m4a", "rev": "rev-c", "sha256": "c1"},
         "art": {"path": "artwork/CCCCCCCCCCC.jpg", "rev": "rev-cart", "sha256": "c1art"}},
        {"id": "s3", "audio": {"path": "media/DDDDDDDDDDD.m4a", "rev": "rev-d-old", "sha256": "d1"}},
    ]}

    uploads = plan_uploads(catalog, local, remote)
    check(uploads == ["media/AAAAAAAAAAA.m4a", "artwork/AAAAAAAAAAA.jpg", "media/BBBBBBBBBBB.m4a"],
          f"plan_uploads: {uploads}")
    check(missing_audio(catalog, local, remote) == ["s4"], "missing_audio")
    check(missing_audio(catalog, {}, remote) == ["s0", "s4"], "missing_audio (ci)")
    check(same_content(FileInfo(1, None, "x"), FileInfo(1, None, "x")), "blob fallback comparison")

    unpinned = unpinned_paths(catalog, remote, prev, set(uploads))
    check(unpinned == ["artwork/BBBBBBBBBBB.jpg", "media/DDDDDDDDDDD.m4a", "artwork/DDDDDDDDDDD.jpg"],
          f"unpinned_paths {unpinned}")
    history = {"artwork/DDDDDDDDDDD.jpg": "rev-d-art"}  # what get_paths_info(expand=True) would say
    lib, skipped, warnings = build_library(
        catalog, local=local, remote=remote, prev=prev, uploaded=set(uploads),
        upload_rev="rev-new", head_sha="rev-head", generated="2026-09-24T00:00:00Z", last_commits=history)
    by_id = {s["id"]: s for s in lib["sources"]}
    check(skipped == ["s4"], f"skipped {skipped}")
    check(lib["schema"] == 2 and lib["revision"] == "rev-new" and lib["repo"] == REPO_ID and lib["hub"] == HUB,
          "top-level fields")
    check(lib["catalogVersion"] == 5 and lib["app"] == "acoustify", "catalogVersion/app")
    a0 = by_id["s0"]["audio"]
    check(a0 == {"path": "media/AAAAAAAAAAA.m4a", "rev": "rev-new", "bytes": 100, "sha256": "a1", "type": "audio/mp4"},
          f"uploaded audio entry {a0}")
    check(by_id["s0"]["art"]["rev"] == "rev-new" and by_id["s0"]["art"]["type"] == "image/jpeg", "uploaded art rev")
    check(by_id["s1"]["audio"]["rev"] == "rev-new" and by_id["s1"]["audio"]["sha256"] == "b2", "changed audio → new rev")
    check(by_id["s1"]["art"]["rev"] == "rev-head", "remote-only art without prev → head")
    check(by_id["s2"]["audio"]["rev"] == "rev-c" and by_id["s2"]["art"]["rev"] == "rev-cart", "unchanged keeps prev rev")
    check(by_id["s3"]["audio"]["rev"] == "rev-head" and by_id["s3"]["audio"]["bytes"] == 300,
          "prev sha mismatch → head")
    check("sha256" not in by_id["s3"]["art"] and by_id["s3"]["art"]["rev"] == "rev-d-art",
          "non-LFS art: no sha, pinned to the commit that last changed it")
    keys = list(by_id["s0"].keys())
    check("artwork" not in keys and keys.index("audio") < keys.index("art") < keys.index("added"),
          f"field order {keys}")
    check(isinstance(by_id["s0"]["audio"], dict) and by_id["s0"]["tracks"] == catalog["sources"][0]["tracks"],
          "catalog fields carried over")
    check(warnings == [], f"warnings {warnings}")

    # Art missing everywhere → art: null + warning, source still published.
    cat2 = {"version": 5, "sources": [source("FFFFFFFFFFF", "f")]}
    lib2, _, warn2 = build_library(cat2, local={}, remote={"media/FFFFFFFFFFF.m4a": L("f")}, prev=None,
                                   uploaded=set(), upload_rev=None, head_sha="h", generated="g")
    check(lib2["sources"][0]["art"] is None and len(warn2) == 1, "missing art → null + warning")

    # Dry run: pending uploads pin to "main"; revision = head.
    lib3, _, _ = build_library(catalog, local=local, remote=remote, prev=prev, uploaded=set(uploads),
                               upload_rev=None, head_sha="rev-head", generated="g")
    check({s["id"]: s for s in lib3["sources"]}["s0"]["audio"]["rev"] == PENDING_REV, "dry-run pending rev")
    check(lib3["revision"] == "rev-head", "dry-run revision = head")

    # Second publish with nothing new: every rev comes from the first publish, content equal → no commit.
    remote_after = {**remote, **{p: local[p] for p in uploads}}
    first, _ = settle_library(lib, prev)
    check(unpinned_paths(catalog, remote_after, first, set()) == ["artwork/DDDDDDDDDDD.jpg"],
          "after a publish only non-LFS files need a history lookup")
    again, _, _ = build_library(catalog, local=local, remote=remote_after, prev=first, uploaded=set(),
                                upload_rev=None, head_sha="rev-libjson", generated="2026-09-25T00:00:00Z",
                                last_commits=history)
    settled, changed = settle_library(again, first)
    check(not changed, "republishing the same content must be a no-op")
    check(settled["generated"] == first["generated"] and settled["revision"] == first["revision"],
          "no-op keeps previous stamp")
    check(to_json(settled) == to_json(first), "no-op produces byte-identical library.json")
    edited = json.loads(json.dumps(catalog))
    edited["sources"][2]["title"] = "Renamed"
    again2, _, _ = build_library(edited, local=local, remote=remote_after, prev=first, uploaded=set(),
                                 upload_rev=None, head_sha="rev-libjson", generated="later", last_commits=history)
    settled2, changed2 = settle_library(again2, first)
    check(changed2 and settled2["revision"] == "rev-libjson", "metadata edit → new library, head revision")
    check({s["id"]: s for s in settled2["sources"]}["s2"]["audio"]["rev"] == "rev-c",
          "metadata edit keeps audio rev (offline downloads survive)")

    # Catalog validation catches the rules publish relies on.
    bad = json.loads(json.dumps(catalog))
    bad["sources"][0]["tracks"] = [{"id": "x", "title": "X", "start": 0, "end": 50},
                                   {"id": "x", "title": "Y", "start": 60, "end": 200}]
    bad["sources"][1]["audio"] = "media/../short.m4a"
    bad["sources"][2]["id"] = "s0"
    bad["sources"][3]["artists"] = []
    errs = "\n".join(validate_catalog(bad))
    for needle in ("duplicated", "starts at 60", "audio must", "duplicate source id", "artists must"):
        check(needle in errs, f"validate_catalog should report {needle!r}:\n{errs}")
    check(validate_catalog({"version": 4, "sources": []}) != [], "old catalog version rejected")

    # An album joined from a playlist: readable file names, no video of its own, one video per song.
    album = source("ignored0000", "album", 300.0, youtubePlaylistId="PLDtVvFL-MTp4S1vFu91Yd9XKWNyOwDY3R",
                   audio="media/rcs-live-at-the-ryman.m4a", artwork="artwork/rcs-live-at-the-ryman.jpg",
                   tracks=[{"id": "a", "title": "A", "start": 0, "end": 100, "youtubeId": "qyA6gOeRIyQ"},
                           {"id": "b", "title": "B", "start": 100, "end": 300, "youtubeId": "9r78xTZ7q08"}])
    del album["youtubeId"]
    with_album = {"version": 5, "sources": [*catalog["sources"], album]}
    check(validate_catalog(with_album) == [], f"playlist album flagged: {validate_catalog(with_album)}")
    check(catalog_paths({"sources": [album]}) == ["media/rcs-live-at-the-ryman.m4a", "artwork/rcs-live-at-the-ryman.jpg"],
          "album paths")
    for mutate, needle in (
        (lambda c: c["sources"][-1].pop("youtubePlaylistId"), "youtubeId must be"),
        (lambda c: c["sources"][-1].update(youtubePlaylistId="PL"), "youtubePlaylistId must be"),
        (lambda c: c["sources"][-1]["tracks"][0].update(youtubeId="nope"), "a: youtubeId must be"),
        (lambda c: c["sources"][-1]["tracks"][1].update(youtubeId="AAAAAAAAAAA"), "already used by s0"),
        (lambda c: c["sources"].append(source("9r78xTZ7q08", "single")), "already used by album/b"),
        (lambda c: c["sources"][-1].update(audio="media/AAAAAAAAAAA.m4a"), "media/AAAAAAAAAAA.m4a is already used by s0"),
        (lambda c: c["sources"][-1].update(artwork="artwork/live at.jpg"), "artwork must look like"),
    ):
        broken = json.loads(json.dumps(with_album))
        mutate(broken)
        errs = "\n".join(validate_catalog(broken))
        check(needle in errs, f"validate_catalog should report {needle!r}:\n{errs}")

    # How library.json changes, as printed before publishing.
    grown = {"sources": [*lib["sources"][1:], {"id": "new", "tracks": [{}, {}]}]}
    grown["sources"][0] = {**grown["sources"][0], "title": "Renamed"}
    check(library_changes(lib, grown) == ["+ new (2 songs)", "- s0", "~ s1"], f"library_changes {library_changes(lib, grown)}")
    check(library_changes(None, {"sources": [{"id": "a", "tracks": [{}]}]}) == ["+ a (1 song)"], "first publish lists everything")
    check(library_changes(lib, lib) == [], "no changes")
    many = library_changes(None, {"sources": [{"id": f"x{i}", "tracks": []} for i in range(20)]}, limit=3)
    check(len(many) == 4 and many[-1] == "… and 17 more", f"library_changes limit {many}")

    # The bundle is written only when it differs.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "data" / "library.json"
        check(write_bundle("a\n", out) and out.read_text() == "a\n", "write_bundle creates the file")
        check(not write_bundle("a\n", out), "write_bundle skips identical content")
        check(write_bundle("b\n", out) and out.read_text() == "b\n", "write_bundle replaces changed content")

    # Token scope: only a token limited to this dataset passes quietly.
    who = lambda token: {"auth": {"type": "access_token", "accessToken": token}}  # noqa: E731
    check("classic write" in (token_scope_problem(who({"role": "write"})) or ""), "classic write token flagged")
    check(token_scope_problem(who({"role": "read"})) is None, "read token not flagged (the write fails on its own)")
    dataset_only = {"role": "fineGrained", "fineGrained": {"global": [], "scoped": [
        {"entity": {"type": "dataset", "name": REPO_ID}, "permissions": ["repo.content.read", "repo.write"]}]}}
    check(token_scope_problem(who(dataset_only)) is None, "dataset-scoped fine-grained token passes")
    account = {"role": "fineGrained", "fineGrained": {"scoped": [
        {"entity": {"type": "user", "name": "arjun10g"}, "permissions": ["repo.content.read", "repo.write"]}]}}
    check("every repo of arjun10g" in (token_scope_problem(who(account)) or ""), "account-wide fine-grained token flagged")
    two = {"role": "fineGrained", "fineGrained": {"scoped": [*dataset_only["fineGrained"]["scoped"],
        {"entity": {"type": "model", "name": "arjun10g/other"}, "permissions": ["repo.write"]},
        {"entity": {"type": "space", "name": "arjun10g/read-only"}, "permissions": ["repo.content.read"]}]}}
    check(token_scope_problem(who(two)) == f"this fine-grained token can also write to arjun10g/other. Limit it to {REPO_ID}.",
          f"write access to another repo flagged: {token_scope_problem(who(two))}")
    check(token_scope_problem(None) is None and token_scope_problem({}) is None, "missing whoami tolerated")

    # .env parsing and URLs.
    env = parse_env('# comment\nexport HF_TOKEN="hf_abc"\nOTHER = x # note\nQUOTED=\'y z\'\nbad line\n')
    check(env == {"HF_TOKEN": "hf_abc", "OTHER": "x", "QUOTED": "y z"}, f"parse_env {env}")
    check(file_url("media/x.m4a", "abc") == f"{HUB}/datasets/{REPO_ID}/resolve/abc/media/x.m4a", "file_url")
    check(previous_revs({"schema": 1, "sources": []}) == {}, "schema-1 library ignored")
    check(human_bytes(1536) == "1.5 KB" and human_bytes(0) == "0 B", "human_bytes")

    print(f"publish.py self-test: {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
