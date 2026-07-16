#!/usr/bin/env python3
"""Launch Codex Review with the active Codex session and workspace repository."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


BUNDLE_ID = "dev.codex-explain.app"
DEVELOPMENT_APP = Path(
    "/Users/yoshijaeger/Desktop/Projects/Personal/codex-explain/codex-explain/"
    "out/Codex Review-darwin-arm64/Codex Review.app"
)
LEGACY_DEVELOPMENT_APP = Path(
    "/Users/yoshijaeger/Desktop/Projects/Personal/codex-explain/codex-explain/"
    "out/Codex Explain-darwin-arm64/Codex Explain.app"
)


def git(root: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Git command failed")
    return result.stdout.strip() if result.returncode == 0 else ""


def repository_root(workspace: Path, explicit: str | None) -> Path:
    candidate = Path(explicit).expanduser() if explicit else workspace
    top = git(candidate, "rev-parse", "--show-toplevel", check=False)
    if top:
        return Path(top).resolve()
    repositories: list[Path] = []
    if candidate.is_dir():
        for child in candidate.iterdir():
            if child.is_dir():
                child_top = git(child, "rev-parse", "--show-toplevel", check=False)
                if child_top and Path(child_top).resolve() == child.resolve():
                    repositories.append(child.resolve())
    if len(repositories) == 1:
        return repositories[0]
    if not repositories:
        raise RuntimeError(f"No Git repository found in workspace: {candidate}")
    raise RuntimeError("The workspace contains multiple Git repositories; rerun with --root <repository>.")


def application_path(explicit: str | None) -> Path:
    candidates = [
        explicit,
        os.environ.get("CODEX_REVIEW_APP"),
        os.environ.get("CODEX_EXPLAIN_APP"),
        "/Applications/Codex Review.app",
        str(Path.home() / "Applications/Codex Review.app"),
        "/Applications/Codex Explain.app",
        str(Path.home() / "Applications/Codex Explain.app"),
        str(DEVELOPMENT_APP),
        str(LEGACY_DEVELOPMENT_APP),
    ]
    for value in candidates:
        if value and Path(value).expanduser().is_dir():
            return Path(value).expanduser().resolve()
    if sys.platform == "darwin":
        result = subprocess.run(
            ["mdfind", f"kMDItemCFBundleIdentifier == '{BUNDLE_ID}'"],
            check=False,
            capture_output=True,
            text=True,
        )
        for value in result.stdout.splitlines():
            if value.endswith(".app") and Path(value).is_dir():
                return Path(value).resolve()
    raise RuntimeError(
        "Codex Review.app was not found. Install/package it, set CODEX_REVIEW_APP, or pass --app."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root")
    parser.add_argument("--session", default=os.environ.get("CODEX_THREAD_ID"))
    parser.add_argument("--commit")
    parser.add_argument("--mode", choices=("commit", "range"))
    parser.add_argument("--detail-level", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--full-preparation", action="store_true")
    parser.add_argument("--app")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    if not options.session:
        raise RuntimeError("CODEX_THREAD_ID is unavailable; pass the active session with --session.")
    workspace = Path(os.environ.get("CODEX_WORKSPACE_ROOT", os.getcwd())).resolve()
    root = repository_root(workspace, options.root)
    tracked_changes = bool(git(root, "status", "--porcelain", "--untracked-files=no"))
    mode = options.mode or ("range" if tracked_changes else "commit")
    revision = options.commit or "HEAD"
    app = application_path(options.app)
    launch_args = [
        "--root", str(root),
        "--commit", revision,
        "--session", options.session,
        "--mode", mode,
        "--detail-level", str(options.detail_level),
    ]
    if options.full_preparation:
        launch_args.append("--full-preparation")
    if options.dry_run:
        print(json.dumps({"app": str(app), "workspace": str(workspace), "args": launch_args}, indent=2))
        return 0
    if sys.platform != "darwin":
        raise RuntimeError("The packaged Codex Review launcher currently supports macOS.")
    subprocess.run(["open", "-na", str(app), "--args", *launch_args], check=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"open-codex-review: {error}", file=sys.stderr)
        raise SystemExit(1)
