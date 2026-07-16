# Codex Explain

Codex Explain is a macOS-first, read-only Electron workspace for understanding agent-authored Git changes. It freezes a commit or tracked working-tree range into an owned temporary clone, renders the complete file tree and side-by-side diff, and prepares explanation-only overviews, hunk details, Q&A, and a teaching-order Story Mode through Codex.

The selected repository and any supplied Codex session are never edited. Git, SQLite, the analysis queue, and Codex orchestration run in an Electron utility process; the sandboxed renderer receives only the typed API exposed by preload.

## Launch

With all arguments supplied, the app validates and opens the review automatically:

```sh
yarn dev -- \
  --root /path/to/repository \
  --commit abc123 \
  --session 019... \
  --mode commit
```

Instead of resuming a session, start a new base chat from a context message:

```sh
yarn dev -- \
  --root /path/to/repository \
  --commit abc123 \
  --context "Focus on the migration intent and compatibility constraints" \
  --mode commit
```

Exactly one of `--session <thread-id>` or `--context <message>` is required. `--context-message` is accepted as an alias for `--context`. With a context message, Codex first analyzes the pinned commit/range in the frozen snapshot; every file and hunk explanation then branches from that completed base turn. The setup screen exposes the same choice.

`--mode` accepts two values:

- `commit` (default): compares the selected commit with its first parent. A root commit is compared with Git's object-format empty tree.
- `range`: compares the selected revision with the current `HEAD`, including staged and unstaged changes to tracked files. Untracked files are excluded.

Analysis defaults to `gpt-5.4-mini` with medium reasoning effort. Override the model with the optional `--model <model-id>` argument:

```sh
yarn dev -- \
  --root /path/to/repository \
  --commit abc123 \
  --session 019... \
  --mode commit \
  --model gpt-5.3-codex
```

The setup screen provides the same setting as a free-text model field with a dropdown of predefined choices.

Generated explanations default to compact level `2`. Use `--detail-level <1-5>` to choose their size, where `1` is very small and `5` is very detailed. The setup screen exposes the same control.

Analysis is generated on demand by default. Use `--full-preparation` to eagerly prepare every changed file overview and hunk with the prioritized background queue.

For example, to review everything since `HEAD~3`, including current tracked working-tree changes:

```sh
yarn dev -- \
  --root /path/to/repository \
  --commit HEAD~3 \
  --session 019... \
  --mode range
```

Invalid or missing arguments open the setup screen.

The packaged app is intentionally unsigned and targets Apple Silicon/macOS 13+ for v1:

```sh
yarn make
```

This produces the local `.app`, ZIP, and DMG artifacts through Electron Forge.

## Development and verification

```sh
yarn dev                 # Vite + Electron development shell
yarn run check           # Svelte and Electron TypeScript checks
yarn test:unit --run     # Node backend + Chromium component tests
yarn test:e2e            # Build and Electron smoke tests
yarn build               # Static renderer and Electron utility bundles
```

The first browser-test run may require `yarn playwright install chromium`. Codex’s optional platform package must be installed for live analysis (`@openai/codex-darwin-arm64` on Apple Silicon); normal tests use a mock app-server and never contact the network.

## Project layout

- `src/lib/shared/` — renderer/Electron domain types, schemas, and IPC channel names.
- `electron/backend/git-snapshot.ts` — revision validation, owned temporary clones, range overlays, tree manifests, lazy content, and search.
- `electron/backend/diff-parser.ts` — Git unified-diff parser with stable SHA-256 hunk IDs.
- `electron/backend/cache.ts` — versioned WAL SQLite cache with Q&A/thread recovery and pruning.
- `electron/backend/codex-adapter.ts` and `app-server.ts` — pinned app-server fork handshake and read-only SDK analysis.
- `electron/backend/review-service.ts` — queue priorities, retries, progress phases, Q&A, Story Mode, and stale detection.
- `electron/main.ts`, `preload.ts`, and `worker.ts` — secure Electron boundary and isolated review engine.
- `src/lib/components/` — file tree, CodeMirror MergeView, search palette, Q&A, progress, and Story Mode UI.

AI is strictly explanatory. The app has no edit, approve, merge, defect-finding, severity, comment, or remote-hosting workflow.
