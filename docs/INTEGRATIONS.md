# Integrations

Two real jobs wired up, as worked examples. Each comes as a patch you can read
first and apply when you like — nothing here changes your projects by itself.

## Bridge fetch (beat-byte) — Python, patch + watcher

**Script:** `fetch.py` from the beat-byte session's scratchpad. It downloads
Encore charts in batches of 25 into `/Volumes/Samsung SSD/beatbyte-bridge-work`
and logs one line per batch:

```
00:53:40 batch 34: 850/1000, 27.71 GB downloaded
```

### Without touching the script: a logtail watcher

[`examples/integrations/watchers-bridge.json`](../examples/integrations/watchers-bridge.json)
reads the last of those lines from `fetch2.log`:

```json
{ "id": "bridge", "type": "logtail", "label": "Bridge", "icon": "⬇",
  "path": "/Volumes/Samsung SSD/beatbyte-bridge-work/fetch2.log",
  "pattern": "batch \\d+: (?<done>\\d+)/(?<total>\\d+), (?<bytes>[\\d.]+ GB) downloaded",
  "unit": "songs", "stalled_after": 900, "active_within": 3600 }
```

- **`stalled_after: 900`** — the log moves once per batch (~2.5 min), and a
  batch ends with the bridge import, which waits while the game runs. With the
  60 s default the job would read as stalled between every batch.
- **`active_within: 3600`** — an hour after the last line the old log stops
  showing up.
- A new run that logs to another file (`fetch3.log`) needs the `path` updated.

Copy it to `~/.claude/taskline/watchers.json` (or merge its entry into the
`watchers` list there). taskline picks the change up within a second.

### Better: report from the script — [`bridge-fetch.patch`](../examples/integrations/bridge-fetch.patch)

```bash
cd <folder with fetch.py> && patch -p1 < /path/to/taskline/examples/integrations/bridge-fetch.patch
```

What it adds (13 lines):

1. `from taskline import Progress` in a `try` — without the helper installed,
   the script runs exactly as before.
2. The batch loop moves into `run(todo, total, p)` and runs inside
   `with Progress("bridge", total=len(todo), unit="songs", stalled_after=900)`.
3. After every song: `p.update(start + len(handled), bytes=total)` — the band
   moves per song (not per batch), with the downloaded bytes beside it.

Effects: per-song progress and speed, an ETA, **aborted** if the process dies
(its pid is recorded), **error** with the exception if it crashes, **done** at
the end. Tested with `curl` and the bridge import stubbed out: 30 songs in two
batches end as `done 30/30, 30 MB`.

> If the 200 GB cap stops the run early, `Progress` still ends as *done* and
> fills the bar.

Run the patched script with the Python that has `taskline` (after `./install.sh`
that is the Homebrew `python3`).

## gta2d map data — Node, patch — [`gta2d-fetch.patch`](../examples/integrations/gta2d-fetch.patch)

**Script:** `~/claude/gta-berlin-2d/tools/osm/fetch.mjs` (`npm run map:fetch`):
LOR, the Geofabrik PBF (~100 MB), the tree cadastre in pages of 20,000,
density, traffic and the VBB timetable (~80 MB).

```bash
cd ~/claude/gta-berlin-2d && patch -p1 < /path/to/taskline/examples/integrations/gta2d-fetch.patch
```

No dependency: the patch inlines a 20-line `progress()` helper that writes
`~/.claude/progress/gta2d-map.json` atomically (temp file + rename), at most
once a second, and swallows its own errors. It reports:

| Stage | Shown as |
|---|---|
| `Karte · LOR` | spinner |
| `Karte · OSM`, `Karte · Fahrplan` | bytes against `content-length` — bar, MB/s, ETA |
| `Karte · Straßenbäume`, `Anlagenbäume`, `Dichte`, `Verkehr` | features against the WFS `numberMatched` |
| end | `✔ Karte in 4:12`, or red `✖ abgebrochen (exit 1)` under the stage that failed |

Downloads are counted with a `Transform` in the existing `pipeline`, so the
file is written exactly as before. Comments are German like the rest of that
codebase. Tested against a slow local server (4 MB in 200 KB chunks): bytes
appear while it downloads, `done` at the end, the file arrives intact; a
refused connection ends red under `Karte · Fahrplan`.

`TASKLINE_DIR` overrides the directory, as for the Python helper.
