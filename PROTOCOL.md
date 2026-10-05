# taskline progress protocol — v1

Any long-running job can report its progress by keeping **one JSON file** up to
date. taskline (the Claude Code mod) reads these files once a second and draws
them above the prompt. Nothing else is needed: no socket, no daemon, no
library. The Python module and the `taskline` CLI in this repo are just
convenient ways to write the file correctly.

## Where

```
~/.claude/progress/<id>.json
```

- `<id>` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Files whose name does
  not match are ignored, so a stray `../` can never point the reader elsewhere.
- Only `*.json` files are read. Names starting with `.` are ignored, which is
  where writers put their temp files.
- The **file name is the identity**. An `id` field inside the file that
  disagrees is ignored.

## Writing atomically

Readers must never see half a file. Always write a temp file in the **same
directory** and rename it over the target:

```
~/.claude/progress/.bridge.json.4242.tmp   →   rename   →   ~/.claude/progress/bridge.json
```

`rename(2)` within one directory is atomic on every local filesystem, so a
reader sees either the old or the new file, never a mix.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | int | yes | Protocol version, `1`. A missing `v` is read as `1`; a higher one is read best-effort. |
| `id` | string | no | Informational; the file name wins. |
| `label` | string | no | Short display name (default: the id). Cut to 40 characters. |
| `icon` | string | no | One glyph shown before the label, e.g. `⬇`. |
| `done` | number | yes | Work done so far, ≥ 0. |
| `total` | number \| null | no | Total work. `null` or absent = unknown → spinner instead of a bar. |
| `unit` | string | no | `"items"` (default), `"files"`, `"bytes"`, `"pages"` … `"bytes"` is shown as KB/MB/GB. |
| `bytes` | number | no | Secondary counter in bytes, for jobs counted in files but also measured in size (`275/1000 files · 3.1 GB`). |
| `bytes_total` | number | no | Expected total bytes. When present, the ETA is computed from bytes. |
| `status` | string | no | `"running"` (default), `"done"` or `"error"`. |
| `message` | string | no | Short note; shown for errors. Cut to 200 characters. |
| `started_at` | number | no | Unix time in seconds (fractions allowed). |
| `updated_at` | number | yes | Unix time in seconds of the last real progress. Drives stall detection. |
| `pid` | int | no | Process id of the writer. If set and the process is gone while `status` is still `running`, the task is shown as **aborted**. |

Unknown fields are ignored, so later versions can add fields without breaking
older readers. All strings are stripped of control characters (including
ANSI escapes) before they reach the terminal.

### Example

```json
{
  "v": 1,
  "id": "bridge",
  "label": "Bridge",
  "icon": "⬇",
  "done": 275,
  "total": 1000,
  "unit": "files",
  "bytes": 3100000000,
  "status": "running",
  "started_at": 1759700000.0,
  "updated_at": 1759700123.4,
  "pid": 4242
}
```

## Lifecycle as the reader sees it

| Condition | Shown as | Visible for |
|---|---|---|
| `running`, updated recently | bar, count, rate, ETA (spinner if `total` is unknown) | while it runs |
| `running`, no update for `stalledAfter` s (default 60) | ⏸ stalled, with the age | until it updates again |
| `running`, `pid` set and that process is gone | ✖ aborted | `errorVisible` s (default 3600) |
| `done` | ✔ in green, with the elapsed time | `doneVisible` s (default 10), then the file is removed |
| `error` | ✖ in red, with `message` | `errorVisible` s, then the file is removed |

Removing a file is how a task disappears for good: `taskline rm <id>`,
`taskline clear`, `/taskline clear` in Claude Code, or plain `rm`.

## Writing rate

Write as often as you like, but more than once a second buys nothing: the
reader polls at 1 Hz. The Python helper throttles to one write per second and
always writes the first and the final state.

## Versioning

The protocol version only increases for changes an old reader would
misread. Adding optional fields does not bump it.
