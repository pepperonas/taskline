# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The plugin directory's blocking check: `register.tsx` named `h` in a type (`ReturnType<typeof h>`); it is now `RenderNode`, and a guard test keeps `h` and `Fragment` out of every `.tsx` module.

## [0.2.1] - 2026-10-06

### Changed

- Plugin directory review: `$` is passed only to the mod's own top-level functions (state through `$.state.get`/`set` with literal keys instead of the imported `read`/`update` helpers), every call written as `$.noun.method(…)` on one line.
- README: what the mod sends (nothing), the exact programs it runs and why, the files it reads and writes, the environment variables it reads, and which shipped scripts it never runs — held to the code by a new drift guard.

## [0.2.0] - 2026-10-06

### Added

- A 1024 px listing icon for the Claude plugin directory, drawn from an SVG in `docs/` and rendered by `npm run screenshots`.
- The finish: when a running bar fills, it bursts into sparks and a green check with **CHECK!!** plays above the band — a truecolor `Raster` repainted at 30 fps (`$.ui.blit`), compact in narrower bands, one line on the desktop app or with animation off. Setting `celebrate`, command `/taskline check`, README animation and filmstrip rendered from the real frames.
- A glob in the file name of a `filesize` or `logtail` path (`~/w/fetch*.log`) follows the most recently modified match; a new file counts as a new run.
- `stalled_after` per task (protocol, watchers, Python `Progress`, CLI `--stalled-after`): jobs that report once per batch no longer read as stalled between batches.
- Social card (1280×640) at the top of the README, rendered by `npm run screenshots`.
- `docs/INTEGRATIONS.md` with two worked examples (Bridge fetch in Python, gta2d map fetch in Node) as patches, and a logtail watcher for the Bridge log.

## [0.1.0] - 2026-10-06

### Added

- The band: every job that reports progress, live above the Claude Code prompt — bar with eighth-cell precision, count, bytes, speed, ETA; spinner for unknown totals.
- Phases: running, stalled (no update for `stalledAfter`), aborted (writer `pid` gone), error (stays red), done (green, then cleaned up).
- Width-aware layout: one line when everything fits, else one row per task; bar → extras → label shrink in that order, then `+N more`. Never wraps.
- Smoothed ETA: time-based EMA sampled at each job's own update time, counting down between updates.
- Progress protocol v1 (`PROTOCOL.md`): one JSON file per job in `~/.claude/progress/`, written atomically.
- Python helper `taskline` (stdlib only): `Progress` context manager, `track()`, `report()`, `finish()`, `fail()`, throttled to one write per second.
- `taskline` CLI for shell scripts: `set`, `add`, `done`, `fail`, `rm`, `clear`, `ls`, `dir`.
- Watchers for jobs that report nothing: `filesize`, `logtail` (last regex match in the log's tail), `dircount`.
- `/taskline` command: list, clear, rm, hide/show, layout, demo.
- `install.sh` / `uninstall.sh` with an install record and `--dry-run`; `demo.py` simulating three parallel jobs.
- Node, engine and Python test suites with drift guards; every guarded behaviour mutation-tested.
