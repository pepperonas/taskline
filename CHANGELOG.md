# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
