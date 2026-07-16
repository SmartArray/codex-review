---
name: open-codex-explain
description: Open Codex Explain for the active Codex session and current workspace repository. Use when the user asks to explain, review, walk through, or visualize the changes from the current Codex session in Codex Explain.
---

# Open Codex Explain

Launch Codex Explain with the active session and repository instead of asking the user to copy identifiers.

## Workflow

1. Treat `CODEX_THREAD_ID` as the authoritative current session ID. Do not search session files or guess an ID when it is present.
2. Resolve the workspace repository from the current working directory. If the working directory contains multiple repositories or is not the intended repository, pass the intended repository with `--root`.
3. Run:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/open-codex-explain/scripts/launch.py"
```

The launcher chooses range mode for tracked working-tree changes and commit mode otherwise. It passes `--root`, `--session`, `--commit`, and `--mode` explicitly.

## Options

Forward user choices to the launcher:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/open-codex-explain/scripts/launch.py" \
  --root /path/to/repository \
  --commit HEAD~2 \
  --mode range \
  --detail-level 2 \
  --full-preparation
```

- Use `--root` when Codex is running from a parent workspace rather than inside the repository.
- Preserve an explicitly requested revision or mode.
- Add `--full-preparation` only when the user requests eager analysis.
- The launch opens a GUI application. Request the normal GUI/external-process approval when required by the environment.

If `CODEX_THREAD_ID` is unavailable, stop and explain that the current Codex surface does not expose its session ID. Do not substitute an unrelated recent session.
