# Codex Explain — Diff-Focused Agent Review IDE

## Summary and fixed scope

Build a macOS-first Electron application for understanding agent-generated changes. It is read-only, optimized for fast source navigation, and uses AI strictly to explain intent and mechanics—not to edit code, approve changes, or produce code-review findings.

- SvelteKit/Svelte 5 renders a static Electron UI with system light/dark themes.
- Changed files use a full-file, side-by-side old/new diff; unchanged files use a single read-only source viewer.
- The sidebar exposes the complete tracked tree at the comparison’s new snapshot, plus deleted paths.
- AI preparation starts automatically after configuration validation.
- v1 targets Apple Silicon, macOS 13+, and an unsigned local app/DMG. Windows, Linux, signing, notarization, updates, and publishing are deferred.
- Remove the template’s demo routes and Paraglide integration; v1 is English-only.
- The original repository and supplied Codex session must remain unmodified.

### Launch contract

Support both terminal arguments and an in-app setup screen:

```text
codex-explain \
  --root <repository-path> \
  --commit <git-revision-expression> \
  (--session <local-codex-thread-id> | --context <message>) \
  [--mode commit|range]
```

- `--mode` defaults to `commit`.
- Exactly one existing session ID or new context message is required. A context message creates a pinned base Codex turn in the frozen snapshot before explanation branches are created.
- Missing or invalid arguments open the setup screen with native folder selection and inline validation.
- Accept Git revision expressions such as hashes, tags, branches, and `abc~`, but reject option-like or non-commit values.
- Display resolved comparison endpoints before starting.

Comparison behavior:

- `commit`: compare the selected commit with its first parent; compare a root commit with Git’s empty tree. Merge commits use their first parent.
- `range`: compare the supplied revision exactly with `HEAD` plus staged and unstaged tracked edits. Passing `abc~` therefore includes the changes introduced by `abc`.
- Untracked files are always excluded.
- Conflicted/unmerged repositories block range mode until resolved.

## Product behavior

### Navigation and diff viewer

- Use a resizable file-tree sidebar with directory-first sorting, file icons, change badges, AI status, current-file highlight, and a stronger Story Mode highlight.
- Show all tracked files at the new snapshot. Add deleted old-only files as navigable tree entries.
- Changed text files open in a read-only CodeMirror 6 `MergeView`; added/deleted files show an empty opposite pane. Its merge support provides synchronized split panes, line gutters, virtualized rendering, and inserted/deleted text emphasis. ([CodeMirror merge reference](https://codemirror.net/docs/ref/#merge.MergeView))
- Show the entire file by default—do not collapse unchanged ranges.
- Disable editing, merge controls, wrapping, and mutation commands.
- Map Git-parsed hunk line ranges onto CodeMirror decorations so Git hunks—not CodeMirror’s internal chunking—remain authoritative for IDs, tooltips, progress, and Story Mode.
- Use accessible semantic colors: green additions, coral/red deletions, stronger inline changed-word backgrounds, and a blue/violet selection accent. Always pair color with `+`/`−`, status text, gutter marks, or borders.
- The file header shows:
  - the file’s role;
  - why it changed;
  - how it changed;
  - analysis/skipped/error state.
- Unchanged files show “Not part of this comparison” instead of triggering AI analysis.

### Hunk explanations and queue priority

- Hovering an unprepared hunk for roughly 250 ms promotes it in the analysis queue; clicking/selecting promotes it immediately.
- A pending tooltip shows “Preparing explanation…” and its queue state.
- A completed tooltip shows a short title and two-to-four sentences covering purpose and mechanics.
- Include “Expand explanation” for the fuller structured explanation and “Ask about this hunk” for Q&A.
- Clicking a hunk pins its tooltip and applies a persistent selection highlight.
- Jobs are serialized within a file thread and run across at most three files concurrently.
- Queue priority is: selected hunk, hovered hunk, current file, remaining foreground work, background FIFO. Add aging to avoid starvation.
- A demanded hunk may run once its file overview is ready, even while other file overviews are still preparing.

### Progress and limits

The top-right progress ring uses these labels:

1. `Indexing`
2. `Preparing overview (x/y)`
3. `Preparing details (x/y)`
4. `Preparing story`

- Overview totals count every touched file; detail totals count every textual Git hunk.
- Cached and skipped entries advance immediately.
- If detail work is completed early through prioritization, retain that count when the visible phase reaches details.
- On success, morph the ring into the `Story Mode` button.
- Retry transient Codex failures twice with bounded exponential backoff.
- After permanent failures, show Retry and `Build story with gaps`; failed entries receive explicit placeholders.

Automatically skip AI for:

- binary files and submodule gitlinks;
- common lockfiles, sourcemaps, minified files, vendored paths, and files marked generated/vendored through Git attributes;
- files where either side exceeds 2 MiB;
- patches over 5,000 lines;
- files with more than 100 hunks.

Skipped files and hunks remain visible and count in navigation. Their header contains a warning banner and `Analyze anyway`; forcing analysis invalidates and rebuilds the story.

### Search

- `Cmd/Ctrl+P` opens a centered fuzzy file palette over the complete tree, including deleted files.
- `Cmd/Ctrl+Shift+F` opens a search panel with:
  - case-sensitive, whole-word, and regex toggles;
  - `Search only in diff`, unchecked by default.
- Default search queries all tracked text at the new snapshot.
- Diff-only search restricts matches to added/replaced new-side lines; removed old-side text does not match.
- Group results by file with line number and snippet; selecting a result opens and reveals the line.
- Validate regular expressions and cap each result page to avoid blocking the renderer.
- Retain CodeMirror’s current-file find command for `Cmd/Ctrl+F`.

### Q&A and Story Mode

- “Ask about this hunk” opens a resizable bottom panel.
- Maintain one lazy multi-turn Q&A thread per hunk. Switching hunks restores that hunk’s history.
- If prerequisite analysis is missing, open the panel immediately but show “Preparing context” and promote the required jobs before submitting.
- Stream SDK item updates into the answer and support cancel/retry.
- Q&A remains explanation-only and cannot modify the snapshot.

Story generation creates a teaching order containing every touched file exactly once:

1. foundations, configuration, schemas, and shared types;
2. core/domain behavior;
3. integrations, callers, routes, and UI;
4. tests;
5. documentation and generated artifacts.

- Codex supplies the preferred order and transition text; validate uniqueness/completeness and request one repair if invalid.
- Fall back deterministically to the grouping above if repair fails.
- Within each file, preserve Git hunk order from top to bottom.
- The toolbar shows `Hunk i of N`, Previous, and Next. `N` includes skipped/failed textual hunks; binary-only files remain in the narrative but have no hunk step.
- Starting Story Mode changes the top-right control to `Stop` and highlights the active file in the tree.
- On a cross-file transition:
  - highlight the new tree item immediately;
  - switch to the file and scroll to its header;
  - show a top-center `File changed: <path>` banner and overview;
  - smoothly scroll for about one second to the first story hunk and pin its explanation.
- Respect reduced-motion preferences by replacing animation with immediate positioning.
- Support toolbar buttons plus Left/Right arrows; Escape or Stop exits Story Mode without cancelling analysis.

## Architecture and interfaces

### Electron boundary

Use Electron 43/Node 24 on macOS arm64 so the backend can use the built-in `node:sqlite` module without a native SQLite dependency. ([Electron release/runtime matrix](https://releases.electronjs.org/), [Node SQLite API](https://nodejs.org/api/sqlite.html))

- Convert SvelteKit to `adapter-static`.
- Main process owns application lifecycle, windows, custom `app://` protocol, setup dialogs, and validated IPC routing.
- A sandboxed preload exposes a narrow typed `window.reviewApi`.
- A Node utility process owns Git, temporary snapshots, SQLite, the queue, Codex SDK, and app-server. Long-running analysis cannot stall the window.
- Use existing Vite builds for renderer/main/preload/worker and Electron Forge for unsigned `.app`, ZIP, and DMG artifacts.
- Load only packaged local assets in production through a custom protocol.
- Enable renderer sandboxing and context isolation; disable Node integration, navigation, popups, remote content, and unexpected permissions. This follows Electron’s recommended main/renderer/preload split and security model. ([Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security))

### Frozen Git snapshot

Create an owned temporary local clone for each review:

- `commit` mode checks out the resolved selected commit.
- `range` mode checks out `HEAD`, overlays only tracked staged/unstaged changes from the selected root, stages them inside the temporary clone, and computes a synthetic new tree SHA.
- Use local/shared Git objects so snapshot creation does not require network access or duplicate the complete object store.
- Generate the file manifest, search data, contents, and diff from the temporary snapshot.
- Execute Git with argument arrays, never interpolated shell commands; disable external diff/textconv behavior.
- Remove the temporary clone when the review closes.

Productionize `docs/parse-diff.ts` into a parser that supports modified/added/deleted/renamed/type-changed files, quoted paths, spaces, CRLF, missing-newline markers, zero-count hunks, binary markers, modes, and submodules.

Each hunk receives:

- stable file/change ID;
- old/new path and line ranges;
- canonical patch text;
- old/new full-file hashes;
- SHA-256 semantic ID.

Watch the source repository for HEAD, index, and tracked-content changes. The rendered snapshot remains frozen, but new AI/story work pauses behind a stale banner until `Reload Review` rebuilds the snapshot and reuses only hash-valid cache entries.

### Codex orchestration

The TypeScript SDK supports starting/resuming server-side threads and structured output but does not expose conversation forking; the lower-level local app-server exposes `thread/fork`. ([Codex SDK](https://developers.openai.com/codex/sdk/), [app-server thread lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))

Use a hybrid adapter:

1. Pin matching exact stable versions of `@openai/codex-sdk` and `@openai/codex`; use the same unpacked Codex binary for both app-server and SDK via `codexPathOverride`.
2. Start one local stdio app-server, perform its initialize handshake, and runtime-validate the narrow JSON-RPC subset used by the app.
3. Read the required local session, verify its recorded working directory belongs to the same Git common directory as the selected root, and capture its last completed turn ID.
4. Fork every file/story thread from that exact baseline turn so later activity in the original session cannot alter the review context.
5. Resume each child through `@openai/codex-sdk`.
6. Archive all generated file, story, and Q&A child threads when the review closes; persist IDs immediately so crash recovery can archive leftovers on the next launch.

Codex thread options:

- temporary snapshot as working directory;
- read-only sandbox;
- approval policy `never`;
- network and web search disabled;
- inherited baseline model;
- explicit analysis-only instructions;
- strict JSON output schemas for automated results.

Structured outputs:

- `FileOverview`: `role`, `whyChanged`, `howChanged`.
- `HunkExplanation`: `title`, `summary`, `expandedExplanation`.
- `StoryPlan`: `title`, `summary`, ordered file IDs, and transition text.

A file child receives one overview turn followed by one self-contained turn per hunk. Hunk prompts must not depend on prior hunk order so hover-driven reordering and partial cache hits remain valid.

Q&A forks from the completed file child when available. If all file analysis came from cache, fork the baseline and seed the Q&A child with the cached file/hunk context.

### Renderer API and domain types

Expose no raw filesystem, shell, Git, SQLite, or Codex objects.

Core shared types:

- `ReviewConfig`: root, revision expression, exactly one session ID or context message, mode.
- `ResolvedComparison`: resolved SHAs/tree IDs, dirty fingerprint, labels, baseline turn ID.
- `DiffFile`: paths, status, hashes, language, binary/generated state, hunks.
- `DiffHunk`: stable ID, line ranges, canonical lines, analysis state.
- `FileOverview`, `HunkExplanation`, `StoryPlan`.
- `ReviewProgress`: phase, completed, total, warning/error state.
- `ReviewEvent`: progress, file/hunk update, Q&A delta, stale state, and fatal error.

Typed preload methods:

- validate/start/reload/close review;
- load file tree and file contents;
- prioritize/select hunk;
- run/cancel search;
- list/ask/cancel Q&A;
- enter/stop/navigate Story Mode;
- subscribe/unsubscribe from review events;
- inspect/clear cache.

Validate every IPC payload and sender on both sides.

### SQLite cache

Store one database under Electron `userData` using `node:sqlite`, WAL mode, foreign keys, prepared statements, and versioned migrations.

- Store response JSON, Q&A messages, status metadata, hashes, usage, and child thread IDs.
- Do not store full source files or raw diffs.
- Cache keys include analysis kind/version, repository identity, baseline session and turn IDs, resolved comparison/tree, model, prompt/schema version, paths, old/new file hashes, and canonical hunk hash.
- Story keys derive from the complete ordered set of file/hunk analysis keys.
- A cache hit avoids both thread creation and Codex calls.
- Prune entries unused for 30 days and then oldest entries until total size is at most 1 GiB.
- Provide cache size and Clear Cache controls.

## Reliability, security, and performance requirements

- The selected source repository is read-only from the application’s perspective; all writable Git operations happen only inside the owned temporary clone.
- Never use shell-interpolated paths or revisions; reject traversal and option injection.
- Keep app-server on local stdio only.
- Render model output as escaped/sanitized content rather than trusted HTML.
- Do not log source, prompts, session contents, or Q&A bodies.
- Existing local Codex authentication is required; v1 does not collect API keys or import cloud-only sessions.
- Missing Git/Codex/auth, invalid revisions, active/unforkable sessions, repo mismatch, conflicts, cache corruption, and app-server crashes receive actionable setup/error states.
- Raw diff browsing remains usable when AI is unavailable; cached story/Q&A remains available offline.
- Target an interactive shell within one second after window creation, normal file switches under 150 ms, first search results under 300 ms on the reference fixture, and smooth virtualized scrolling without renderer tasks over 50 ms. AI latency is excluded.
- Load file contents and language support lazily and dispose inactive editors.

## Test plan and acceptance criteria

### Automated tests

- Diff parser fixtures: ordinary changes, additions, deletions, renames, spaces/quoted paths, Unicode, CRLF, root commits, merge commits, binary files, submodules, modes, and missing newlines.
- Temporary Git repository integration tests:
  - default commit-only behavior;
  - literal `abc~` range behavior;
  - staged/unstaged tracked overlays;
  - untracked exclusion;
  - synthetic tree stability;
  - stale detection and reload;
  - original repository status unchanged.
- Cache tests: deterministic keys, session-turn invalidation, file/hunk invalidation, migrations, corruption recovery, LRU/age pruning, and cache-hit call suppression.
- Queue tests: per-file serialization, concurrency limit, hover/selection promotion, dependency promotion, aging, cancellation, retries, skips, and partial completion.
- Mock app-server tests: handshake, thread read/fork/archive/unarchive, last-turn pinning, mismatched repositories, malformed responses, timeout, crash, and restart.
- Mock SDK tests: structured output validation/repair, streaming Q&A, aborts, unavailable model/auth, and no mutation events.
- Svelte component tests: tree states, progress phases, tooltip pending/expanded states, warning banners, search controls/results, bottom Q&A panel, and system themes.
- Electron Playwright tests:
  - CLI-prefilled and setup-screen launches;
  - full-tree navigation and split diff rendering;
  - word-level highlights;
  - Ctrl/Cmd shortcuts;
  - hover priority;
  - forced oversized analysis;
  - Story Mode navigation, file highlight, banner, and one-second transition;
  - reduced-motion behavior;
  - stale review flow;
  - partial-failure story flow.
- Add an opt-in live Codex contract test using a disposable local session; keep normal CI fully mocked and offline.
- Smoke-test the packaged arm64 `.app` and DMG, including the unpacked Codex binary.

### Acceptance criteria

- The original Git worktree and supplied baseline session are byte-for-byte/unmodified after a complete review.
- Commit and range diffs match their defined Git endpoints, including tracked edits and `~` expressions.
- Every touched textual hunk is addressable, counted, selectable, cacheable, and navigable.
- Reopening an identical review produces no AI calls when all cache entries are valid.
- Hovering an unprepared hunk moves it ahead of background work.
- Story ordering contains every touched file exactly once and preserves hunk order within files.
- File transitions visibly highlight the tree entry, show the overview/banner, then move to the first hunk.
- Search defaults to the new snapshot and its checkbox restricts results to new-side changed lines.
- Stale source changes cannot silently contaminate ongoing AI analysis.
- Renderer code has no direct Node/filesystem/shell access.

### Explicit assumptions

- v1 is a single-user, single-window, English-only, Apple-Silicon developer tool.
- The user has system Git and an existing local Codex login.
- The supplied session is persisted in the same `CODEX_HOME` and belongs to the same repository or one of its worktrees.
- Automated AI output explains changes only; defect findings, severity rankings, editing, accept/reject controls, comments, collaboration, and remote hosting are out of scope.
- Submodule contents are not traversed recursively.
- Cached generated text and Q&A are local application data and are not promised encrypted storage.
