#!/usr/bin/env python3
"""Simulate parallel jobs so you can watch taskline live.

    python3 demo.py            # three jobs, ~40 s
    python3 demo.py --fast     # ~12 s
    python3 demo.py --fail     # the scan ends in an error instead

Jobs:
  Bridge  a download with a known size: files and bytes, bar, speed, ETA
  Index   an unknown amount of work: spinner, counter, rate
  Tiles   a job that hangs: its last update is 90 s old, so it shows as stalled

Everything goes through the real library (python/taskline.py), so this is also
an end-to-end check of the protocol. Ctrl+C marks the running jobs as
interrupted, exactly as it would for your own jobs.

© 2026 Martin Pfeffer | celox.io
"""

import argparse
import math
import os
import random
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "python"))

import taskline  # noqa: E402


def bridge(scale: float, stop: threading.Event) -> None:
    files, size = 1000, 3_100_000_000
    duration = 30 * scale
    with taskline.Progress("demo-bridge", total=files, label="Bridge", unit="files", icon="⬇", bytes_total=size) as p:
        t0 = time.monotonic()
        while not stop.is_set():
            t = time.monotonic() - t0
            if t >= duration:
                break
            # bursty, like a real download: speed swings around its average
            f = t / duration + 0.04 * math.sin(t * 1.3) * (1 - t / duration) * (t / duration)
            f = max(0.0, min(1.0, f))
            p.update(int(files * f), bytes=int(size * f))
            stop.wait(0.2)
        if stop.is_set():
            raise KeyboardInterrupt


def index(scale: float, fail: bool, stop: threading.Event) -> None:
    duration = 34 * scale
    with taskline.Progress("demo-index", label="Index", unit="items", icon="🔍") as p:
        t0 = time.monotonic()
        while time.monotonic() - t0 < duration and not stop.is_set():
            p.advance(random.randint(3, 40))
            stop.wait(0.15)
        if stop.is_set():
            raise KeyboardInterrupt
        if fail:
            raise ConnectionError("index server went away")


def tiles() -> None:
    """A job that hung 90 s ago: written once, backdated, never updated again."""
    taskline.report("demo-tiles", 412, 3400, label="Tiles", unit="files", icon="⬇")
    path = os.path.join(taskline.progress_dir(), "demo-tiles.json")
    data = taskline._read("demo-tiles") or {}
    data["updated_at"] = time.time() - 90
    data["started_at"] = time.time() - 600
    taskline._write("demo-tiles", data)
    print(f"  Tiles   stalled  ({path})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--fast", action="store_true", help="run ~3x faster")
    ap.add_argument("--fail", action="store_true", help="let the Index job fail")
    ap.add_argument("--keep", action="store_true", help="leave the stalled Tiles job behind")
    args = ap.parse_args()
    scale = 0.35 if args.fast else 1.0

    print(f"taskline demo — writing to {taskline.progress_dir()}")
    print("  Bridge  download, known size\n  Index   unknown amount")
    tiles()
    stop = threading.Event()
    errors = []

    def guard(fn, *a):
        try:
            fn(*a)
        except KeyboardInterrupt:
            pass
        except Exception as err:  # the job "failed": taskline shows it in red
            errors.append(err)

    threads = [
        threading.Thread(target=guard, args=(bridge, scale, stop)),
        threading.Thread(target=guard, args=(index, scale, args.fail, stop)),
    ]
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(0.2)
    except KeyboardInterrupt:
        stop.set()
        for t in threads:
            t.join()
        print("\ninterrupted — the jobs show as errors (\"interrupted\")")
    if not args.keep:
        taskline.remove("demo-tiles")
    for err in errors:
        print(f"  Index failed as asked: {err}")
    print("done — finished jobs fade out after a few seconds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
