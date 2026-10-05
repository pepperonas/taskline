# Design decisions

Why taskline is built the way it is. Each entry: the decision, what it rules out, and why.

## A mod, not a `statusLine` command

The project started as a `statusLine` script (the brief asked for one). The official docs (checked 2026-10-05) settled it:

- A `statusLine` command runs as a **new process on every refresh**; Python alone costs ~22 ms to start on an M-series Mac, ~30 ms with the imports the job needs.
- It refreshes on **conversation events** (a new message, `/compact`, a mode change) — a download in another terminal would freeze on screen while you wait. `refreshInterval` (minimum 1 s) fixes that at the price of one process per second, forever.
- A new trigger **cancels** an in-flight script, and a non-zero exit blanks the line.

A mod (function-hook plugin) lives inside the session: `$.clock.every` instead of a process per frame, a spinner at 4 fps, the desktop app for free, and `$.state`/`$.store` instead of a cache file. The progress protocol and the reporting helpers are the same either way.

## Polling, not watching

There is no file-watch API for mods. A one-second poll of one directory is cheap: one `list`, and a `read` only for files whose mtime or size changed. Logs above 256 KB are tailed with `tail -c 64K` instead of read whole (`$.fs.read` caps at 4 MiB and would copy the file into the plugin each time).

## Samples at the writer's time, not the reader's

The EMA takes a sample per change of `updated_at`, not per poll. Sampling per poll would add zero-progress samples between two writes of a job that reports every 5 s and drag the speed down in a saw-tooth. A job that really stops is reported as **stalled**, not as an ETA creeping to infinity. The EMA weight is time-based (`1 − e^(−Δt/τ)`, τ = 20 s), so uneven write intervals don't distort it. Between writes, the ETA counts down by the time elapsed since the last write.

## Bytes as a second counter

Downloads are naturally counted in files but measured in bytes (`275/1000 · 3.1 GB`). Instead of forcing a choice, the protocol has `bytes`/`bytes_total` beside `done`/`total`; the ETA uses bytes when the byte total is known, since bytes progress more evenly than files of mixed sizes.

## The file name is the identity

`<id>.json` with `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. An `id` inside the file is ignored — otherwise one file could impersonate another, and the cleanup step (which deletes files) would have to trust file contents for a path.

## Problems first, oldest first

Order: error, aborted, stalled, running, done. What needs you comes first; within a phase, the oldest start first, so rows don't jump around when speeds change.

## Shrinking order

Nine detail levels per task, richest first. Fitting walks down the levels — shorter bar, drop the rate, drop the bytes, drop the unit word, percent instead of counts, shorter label — and only folds tasks into `+N more` when even the leanest level does not fit. In `auto`, a single line is used only while every task fits at level 2 or richer; a cramped single line reads worse than one row per task.

## Never wraps, never injects

Every row is clipped to `bodyColumns` with cell widths that count emoji and CJK as two. All strings from files and logs pass through `sanitize`, which removes C0/C1 control characters — including ESC, so no progress file or log can smuggle ANSI or OSC sequences into your terminal.

## Cleanup through the reader

Done and error files are deleted by the mod once they are no longer shown, so `~/.claude/progress` doesn't fill up — but only files that parse as ours, inside our directory, via `rm -f --`. Watchers own no files and are never cleaned up. `cleanup: false` turns it off; the display rules are the same.

## Not done (yet)

- **Base info** (model, directory, branch) — Claude Code's own footer shows it; duplicating it would cost a row.
- **TOML config** — the original brief asked for TOML. A mod has no TOML parser without dependencies; simple settings live in Claude Code's own plugin config (`userConfig`), and watchers are JSON.
- **Recursive `dircount`** — one level keeps a huge tree from costing a full walk per second.
