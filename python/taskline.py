"""Report the progress of long-running jobs to taskline.

taskline is a Claude Code mod that shows every running job above the prompt.
A job reports itself by keeping ``~/.claude/progress/<id>.json`` up to date
(see PROTOCOL.md). This module writes that file correctly: atomically,
throttled, and with ``done``/``error`` set for you when the job ends.

    from taskline import Progress

    with Progress("bridge", total=1000, label="Bridge", unit="files") as p:
        for item in items:
            fetch(item)
            p.advance()

Standard library only, Python 3.8+. Also a CLI: ``python3 -m taskline --help``.

© 2026 Martin Pfeffer | celox.io — MIT License
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, Iterator, List, Optional

__all__ = [
    "Progress",
    "report",
    "finish",
    "fail",
    "remove",
    "clear",
    "tasks",
    "track",
    "progress_dir",
    "PROTOCOL_VERSION",
]
__version__ = "0.1.0"

PROTOCOL_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
STATUSES = ("running", "done", "error")
_UNSET: Any = object()


def progress_dir() -> str:
    """The directory taskline reads; ``$TASKLINE_DIR`` overrides it (tests, sandboxes)."""
    custom = os.environ.get("TASKLINE_DIR")
    if custom:
        return os.path.expanduser(custom)
    return os.path.join(os.path.expanduser("~"), ".claude", "progress")


def _check_id(task_id: str) -> str:
    if not isinstance(task_id, str) or not ID_RE.match(task_id):
        raise ValueError(
            f"invalid task id {task_id!r}: use 1-64 of A-Z a-z 0-9 . _ - (not starting with . _ -)"
        )
    return task_id


def _path(task_id: str) -> str:
    return os.path.join(progress_dir(), _check_id(task_id) + ".json")


def _read(task_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_path(task_id), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write(task_id: str, data: Dict[str, Any]) -> None:
    """Write atomically: temp file in the same directory, then rename over the target."""
    directory = progress_dir()
    os.makedirs(directory, exist_ok=True)
    target = _path(task_id)
    tmp = os.path.join(directory, f".{task_id}.json.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, target)


def _clean(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", str(value)).strip()
    return text[:limit] or None


def report(
    task_id: str,
    done: float,
    total: Optional[float] = _UNSET,
    *,
    label: Optional[str] = _UNSET,
    unit: Optional[str] = _UNSET,
    icon: Optional[str] = _UNSET,
    bytes: Optional[float] = _UNSET,  # noqa: A002 - mirrors the protocol field
    bytes_total: Optional[float] = _UNSET,
    status: str = "running",
    message: Optional[str] = _UNSET,
    pid: Optional[int] = _UNSET,
) -> Dict[str, Any]:
    """Write one progress state now (no throttling) and return it.

    Fields left out keep their previous value from the existing file, so
    ``report("bridge", 276)`` only moves the counter. ``started_at`` is kept
    from the first report.
    """
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}, not {status!r}")
    prev = _read(task_id) or {}
    now = time.time()

    def pick(name: str, value: Any) -> Any:
        return prev.get(name) if value is _UNSET else value

    data: Dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "id": task_id,
        "label": _clean(pick("label", label), 40) or task_id,
        "icon": _clean(pick("icon", icon), 4),
        "done": max(0, done),
        "total": pick("total", total),
        "unit": _clean(pick("unit", unit), 16) or "items",
        "bytes": pick("bytes", bytes),
        "bytes_total": pick("bytes_total", bytes_total),
        "status": status,
        "message": _clean(pick("message", message), 200),
        "started_at": prev.get("started_at") if prev.get("status", "running") == "running" and prev else now,
        "updated_at": now,
        "pid": pick("pid", pid),
    }
    if data["started_at"] is None:
        data["started_at"] = now
    data = {k: v for k, v in data.items() if v is not None or k == "total"}
    _write(task_id, data)
    return data


def finish(task_id: str, message: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Mark a task done. A known total is filled up so the bar ends at 100 %."""
    prev = _read(task_id)
    if prev is None:
        return None
    done = prev.get("total") if isinstance(prev.get("total"), (int, float)) else prev.get("done", 0)
    return report(task_id, done, status="done", message=message if message is not None else _UNSET)


def fail(task_id: str, message: Optional[str] = None) -> Dict[str, Any]:
    """Mark a task failed; it stays visible (red) until removed or its TTL passes."""
    prev = _read(task_id) or {}
    return report(task_id, prev.get("done", 0), status="error", message=message or "failed")


def remove(task_id: str) -> bool:
    """Delete a task's file. Returns whether there was one."""
    try:
        os.remove(_path(task_id))
        return True
    except FileNotFoundError:
        return False


def tasks() -> List[Dict[str, Any]]:
    """Every readable task file, newest update first."""
    out: List[Dict[str, Any]] = []
    try:
        names = os.listdir(progress_dir())
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json") or name.startswith("."):
            continue
        task_id = name[: -len(".json")]
        if not ID_RE.match(task_id):
            continue
        data = _read(task_id)
        if data is not None:
            data["id"] = task_id
            out.append(data)
    out.sort(key=lambda d: d.get("updated_at") or 0, reverse=True)
    return out


def _alive(pid: Any) -> Optional[bool]:
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


def clear(include_running: bool = False, stalled_after: float = 60.0) -> List[str]:
    """Remove finished tasks (done, error, aborted). With ``include_running``,
    stalled ones too. Returns the removed ids."""
    removed = []
    now = time.time()
    for data in tasks():
        status = data.get("status", "running")
        aborted = status == "running" and _alive(data.get("pid")) is False
        stalled = status == "running" and now - float(data.get("updated_at") or 0) > stalled_after
        if status in ("done", "error") or aborted or (include_running and stalled):
            if remove(data["id"]):
                removed.append(data["id"])
    return removed


class Progress:
    """A task that reports itself, throttled to one write per ``throttle`` seconds.

    Used as a context manager it ends as ``done`` on success and as ``error``
    (with the exception as message) when an exception escapes. Reporting never
    raises into your job: a full disk costs the display, not the download.
    """

    def __init__(
        self,
        task_id: str,
        total: Optional[float] = None,
        *,
        label: Optional[str] = None,
        unit: str = "items",
        icon: Optional[str] = None,
        bytes_total: Optional[float] = None,
        done: float = 0,
        throttle: float = 1.0,
        pid: Optional[int] = _UNSET,
        keep: bool = False,
    ) -> None:
        self.id = _check_id(task_id)
        self.total = total
        self.label = label or task_id
        self.unit = unit
        self.icon = icon
        self.bytes: Optional[float] = None
        self.bytes_total = bytes_total
        self.done = done
        self.message: Optional[str] = None
        self.throttle = throttle
        self.pid = os.getpid() if pid is _UNSET else pid
        self.keep = keep
        self.closed = False
        self._last_write = 0.0
        self._started = False

    # -- reporting -----------------------------------------------------
    def update(
        self,
        done: Optional[float] = None,
        *,
        total: Optional[float] = _UNSET,
        bytes: Optional[float] = None,  # noqa: A002
        bytes_total: Optional[float] = _UNSET,
        message: Optional[str] = _UNSET,
        force: bool = False,
    ) -> None:
        """Set the absolute state. Writes at most once per ``throttle`` seconds."""
        if done is not None:
            self.done = done
        if total is not _UNSET:
            self.total = total
        if bytes is not None:
            self.bytes = bytes
        if bytes_total is not _UNSET:
            self.bytes_total = bytes_total
        if message is not _UNSET:
            self.message = message
        self._flush(force=force)

    def advance(self, n: float = 1, *, add_bytes: float = 0) -> None:
        """Add ``n`` to ``done`` (and ``add_bytes`` to ``bytes``)."""
        self.done += n
        if add_bytes:
            self.bytes = (self.bytes or 0) + add_bytes
        self._flush()

    def finish(self, message: Optional[str] = None) -> None:
        self._end("done", message)

    def fail(self, message: str = "failed") -> None:
        self._end("error", message)

    def _end(self, status: str, message: Optional[str]) -> None:
        if self.closed:
            return
        if status == "done" and isinstance(self.total, (int, float)):
            self.done = max(self.done, self.total)
        if status == "done" and isinstance(self.bytes_total, (int, float)):
            self.bytes = max(self.bytes or 0, self.bytes_total)
        if message is not None:
            self.message = message
        self._flush(force=True, status=status)
        self.closed = True

    def _flush(self, force: bool = False, status: str = "running") -> None:
        if self.closed:
            return
        now = time.monotonic()
        if not force and self._started and now - self._last_write < self.throttle:
            return
        try:
            if not self._started and not self.keep:
                remove(self.id)  # a leftover file from an earlier run must not lend its started_at
            report(
                self.id,
                self.done,
                self.total,
                label=self.label,
                unit=self.unit,
                icon=self.icon,
                bytes=self.bytes,
                bytes_total=self.bytes_total,
                status=status,
                message=self.message,
                pid=self.pid,
            )
            self._started = True
            self._last_write = now
        except OSError:
            pass  # the display is best effort; the job is not

    # -- context manager ---------------------------------------------------
    def __enter__(self) -> "Progress":
        self._flush(force=True)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.finish()
        elif issubclass(exc_type, KeyboardInterrupt):
            self.fail("interrupted")
        else:
            self.fail(f"{exc_type.__name__}: {exc}" if str(exc) else exc_type.__name__)
        return False


def track(
    iterable: Iterable[Any],
    task_id: str,
    total: Optional[float] = None,
    **kwargs: Any,
) -> Iterator[Any]:
    """Wrap an iterable: ``for url in track(urls, "fetch", label="Fetch"): ...``"""
    if total is None:
        try:
            total = len(iterable)  # type: ignore[arg-type]
        except TypeError:
            total = None
    with Progress(task_id, total, **kwargs) as p:
        for item in iterable:
            yield item
            p.advance()


# -- CLI ------------------------------------------------------------------------

USAGE = """\
usage: taskline <command> [args]

  set <id> <done> [total] [options]   report progress (total "-" = unknown)
      --label TEXT  --unit UNIT  --icon GLYPH  --message TEXT
      --bytes N  --bytes-total N  --pid PID
  add <id> [n] [--bytes N]            add n (default 1) to done
  done <id> [--message TEXT]          mark done
  fail <id> [message]                 mark failed
  rm <id>...                          remove tasks
  clear [--all]                       remove finished tasks (--all: stalled too)
  ls [--json]                         list tasks
  dir                                 print the progress directory

Shell scripts: pass --pid $$ so a killed script shows as aborted.
Sizes accept suffixes: 3.1G, 512M, 20K.
"""


def _num(text: str) -> float:
    match = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([kKmMgGtT]?)i?[bB]?\s*", text)
    if not match:
        raise ValueError(f"not a number: {text!r}")
    factor = {"": 1, "k": 1e3, "m": 1e6, "g": 1e9, "t": 1e12}[match.group(2).lower()]
    value = float(match.group(1)) * factor
    return int(value) if value.is_integer() else value


def _opts(args: List[str], flags: Dict[str, str]) -> tuple:
    pos: List[str] = []
    opts: Dict[str, str] = {}
    it = iter(args)
    for arg in it:
        if arg.startswith("--"):
            name, eq, value = arg[2:].partition("=")
            if name not in flags:
                raise ValueError(f"unknown option --{name}")
            if not eq:
                try:
                    value = next(it)
                except StopIteration:
                    raise ValueError(f"--{name} needs a value") from None
            opts[flags[name]] = value
        else:
            pos.append(arg)
    return pos, opts


def _fmt_line(data: Dict[str, Any], now: float) -> str:
    total = data.get("total")
    done = data.get("done", 0)
    pct = f"{100 * done / total:5.1f}%" if isinstance(total, (int, float)) and total > 0 else "   ?  "
    age = now - float(data.get("updated_at") or now)
    status = data.get("status", "running")
    if status == "running" and _alive(data.get("pid")) is False:
        status = "aborted"
    of = f"/{total:g}" if isinstance(total, (int, float)) else ""
    msg = f"  {data['message']}" if data.get("message") else ""
    return f"{data['id']:<20} {status:<8} {pct}  {done:g}{of} {data.get('unit', 'items')}  ({age:.0f}s ago){msg}"


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE, end="")
        return 0
    cmd, rest = args[0], args[1:]
    try:
        if cmd == "set":
            pos, o = _opts(rest, {"label": "label", "unit": "unit", "icon": "icon", "message": "message",
                                  "bytes": "bytes", "bytes-total": "bytes_total", "pid": "pid"})
            if len(pos) not in (2, 3):
                raise ValueError("set needs <id> <done> [total]")
            kw: Dict[str, Any] = {k: v for k, v in o.items() if k in ("label", "unit", "icon", "message")}
            for key in ("bytes", "bytes_total"):
                if key in o:
                    kw[key] = _num(o[key])
            if "pid" in o:
                kw["pid"] = int(o["pid"])
            if len(pos) == 3:
                kw["total"] = None if pos[2] in ("-", "?", "null") else _num(pos[2])
            report(pos[0], _num(pos[1]), **kw)
        elif cmd == "add":
            pos, o = _opts(rest, {"bytes": "bytes"})
            if len(pos) not in (1, 2):
                raise ValueError("add needs <id> [n]")
            prev = _read(_check_id(pos[0])) or {}
            kw = {}
            if "bytes" in o:
                kw["bytes"] = (prev.get("bytes") or 0) + _num(o["bytes"])
            report(pos[0], (prev.get("done") or 0) + (_num(pos[1]) if len(pos) == 2 else 1), **kw)
        elif cmd == "done":
            pos, o = _opts(rest, {"message": "message"})
            if len(pos) != 1:
                raise ValueError("done needs <id>")
            if finish(pos[0], o.get("message")) is None:
                report(pos[0], 0, status="done", message=o.get("message"))
        elif cmd == "fail":
            if not rest:
                raise ValueError("fail needs <id> [message]")
            fail(rest[0], " ".join(rest[1:]) or None)
        elif cmd == "rm":
            if not rest:
                raise ValueError("rm needs <id>")
            missing = [t for t in rest if not remove(t)]
            if missing:
                print(f"taskline: no such task: {' '.join(missing)}", file=sys.stderr)
                return 1
        elif cmd == "clear":
            removed = clear(include_running="--all" in rest)
            print(f"removed {len(removed)} task(s)" + (f": {' '.join(removed)}" if removed else ""))
        elif cmd == "ls":
            data = tasks()
            if "--json" in rest:
                print(json.dumps(data, ensure_ascii=False, indent=2))
            elif not data:
                print("no tasks")
            else:
                now = time.time()
                for item in data:
                    print(_fmt_line(item, now))
        elif cmd == "dir":
            print(progress_dir())
        elif cmd in ("-V", "--version", "version"):
            print(f"taskline {__version__} (protocol v{PROTOCOL_VERSION})")
        else:
            print(f"taskline: unknown command {cmd!r}\n\n{USAGE}", end="", file=sys.stderr)
            return 2
    except ValueError as err:
        print(f"taskline: {err}", file=sys.stderr)
        return 2
    except OSError as err:
        print(f"taskline: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
