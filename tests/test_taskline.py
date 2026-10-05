"""Tests for python/taskline.py: the reporting library and the CLI."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import taskline  # noqa: E402


@pytest.fixture(autouse=True)
def progress_dir(tmp_path, monkeypatch):
    d = tmp_path / "progress"
    monkeypatch.setenv("TASKLINE_DIR", str(d))
    return d


def load(d, task_id):
    return json.loads((d / f"{task_id}.json").read_text())


def test_report_writes_a_v1_file(progress_dir):
    taskline.report("bridge", 275, 1000, label="Bridge", unit="files", icon="⬇", bytes=3.1e9)
    data = load(progress_dir, "bridge")
    assert data["v"] == 1
    assert (data["done"], data["total"], data["unit"], data["label"], data["icon"]) == (275, 1000, "files", "Bridge", "⬇")
    assert data["status"] == "running"
    assert data["bytes"] == 3.1e9
    assert data["started_at"] <= data["updated_at"] <= time.time()


def test_report_keeps_fields_not_given_and_the_start_time(progress_dir):
    taskline.report("t", 1, 10, label="T", unit="files")
    first = load(progress_dir, "t")
    time.sleep(0.01)
    taskline.report("t", 2)
    second = load(progress_dir, "t")
    assert (second["total"], second["label"], second["unit"]) == (10, "T", "files")
    assert second["started_at"] == first["started_at"]
    assert second["updated_at"] > first["updated_at"]


def test_unknown_total_is_written_as_null(progress_dir):
    taskline.report("scan", 5, None)
    assert load(progress_dir, "scan")["total"] is None


def test_writes_are_atomic_and_leave_no_temp_files(progress_dir):
    for i in range(50):
        taskline.report("a", i, 50)
    assert [p.name for p in progress_dir.iterdir()] == ["a.json"]


@pytest.mark.parametrize("bad", ["", "../etc", ".hidden", "a b", "x" * 65, "-x", None])
def test_invalid_ids_are_refused(bad):
    with pytest.raises(ValueError):
        taskline.report(bad, 1)


def test_control_characters_are_stripped(progress_dir):
    taskline.report("x", 1, label="\x1b[31mred\x1b[0m", message="a\x07b")
    data = load(progress_dir, "x")
    assert data["label"] == "[31mred[0m" and data["message"] == "ab"


def test_progress_context_manager_ends_done_with_a_full_bar(progress_dir):
    with taskline.Progress("job", total=10, label="Job", unit="files") as p:
        for _ in range(7):
            p.advance()
    data = load(progress_dir, "job")
    assert data["status"] == "done"
    assert data["done"] == 10
    assert data["pid"] == os.getpid()


def test_progress_marks_an_exception_as_error_and_reraises(progress_dir):
    with pytest.raises(RuntimeError):
        with taskline.Progress("job", total=10) as p:
            p.advance(3)
            raise RuntimeError("disk full")
    data = load(progress_dir, "job")
    assert data["status"] == "error"
    assert data["message"] == "RuntimeError: disk full"
    assert data["done"] == 3


def test_progress_marks_ctrl_c_as_interrupted(progress_dir):
    with pytest.raises(KeyboardInterrupt):
        with taskline.Progress("job"):
            raise KeyboardInterrupt
    assert load(progress_dir, "job")["message"] == "interrupted"


def test_progress_throttles_but_always_writes_first_and_last(progress_dir, monkeypatch):
    writes = []
    real = taskline._write
    monkeypatch.setattr(taskline, "_write", lambda i, d: (writes.append(d["done"]), real(i, d)))
    with taskline.Progress("t", total=1000, throttle=60) as p:
        for _ in range(1000):
            p.advance()
    assert writes == [0, 1000]


def test_progress_starts_fresh_over_a_leftover_file(progress_dir):
    taskline.report("t", 99, 100, label="Old", status="error", message="old")
    with taskline.Progress("t", total=5) as p:
        p.update(1)
        data = load(progress_dir, "t")
        assert data["status"] == "running" and "message" not in data and data["label"] == "t"


def test_progress_counts_bytes(progress_dir):
    with taskline.Progress("dl", total=2, bytes_total=300, throttle=0) as p:
        p.advance(add_bytes=100)
        assert load(progress_dir, "dl")["bytes"] == 100
    data = load(progress_dir, "dl")
    assert data["bytes"] == 300 and data["bytes_total"] == 300


def test_progress_never_raises_on_write_failure(progress_dir, monkeypatch):
    def boom(*_):
        raise OSError("read-only")

    monkeypatch.setattr(taskline, "_write", boom)
    with taskline.Progress("t", total=3) as p:
        p.advance()  # must not raise


def test_track_wraps_an_iterable(progress_dir):
    assert list(taskline.track(["a", "b", "c"], "it", label="It")) == ["a", "b", "c"]
    data = load(progress_dir, "it")
    assert (data["done"], data["total"], data["status"]) == (3, 3, "done")


def test_finish_fail_remove_and_tasks(progress_dir):
    taskline.report("a", 3, 10)
    taskline.finish("a")
    assert load(progress_dir, "a")["done"] == 10
    taskline.fail("b", "boom")
    assert load(progress_dir, "b")["status"] == "error"
    assert {t["id"] for t in taskline.tasks()} == {"a", "b"}
    assert taskline.remove("a") is True
    assert taskline.remove("a") is False
    assert taskline.finish("nope") is None


def test_clear_removes_finished_and_aborted_keeps_running(progress_dir):
    taskline.report("run", 1, 9, pid=os.getpid())
    taskline.report("ok", 1, 9, status="done")
    taskline.report("bad", 1, 9, status="error")
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    taskline.report("dead", 1, 9, pid=dead.pid)
    assert sorted(taskline.clear()) == ["bad", "dead", "ok"]
    assert [t["id"] for t in taskline.tasks()] == ["run"]


def test_tasks_skips_broken_and_foreign_files(progress_dir):
    taskline.report("good", 1)
    (progress_dir / "broken.json").write_text("{")
    (progress_dir / ".tmp.json").write_text("{}")
    (progress_dir / "notes.txt").write_text("x")
    assert [t["id"] for t in taskline.tasks()] == ["good"]


# -- CLI ------------------------------------------------------------------------------


def cli(*args, env=None):
    return subprocess.run(
        [sys.executable, str(ROOT / "bin" / "taskline"), *args],
        capture_output=True, text=True, env={**os.environ, **(env or {})},
    )


def test_cli_set_add_done(progress_dir):
    assert cli("set", "dl", "3", "10", "--label", "Download", "--unit", "files", "--bytes", "1.5G", "--pid", "123").returncode == 0
    data = load(progress_dir, "dl")
    assert (data["done"], data["total"], data["label"], data["bytes"], data["pid"]) == (3, 10, "Download", 1_500_000_000, 123)
    cli("add", "dl", "2", "--bytes", "500M")
    data = load(progress_dir, "dl")
    assert (data["done"], data["bytes"]) == (5, 2_000_000_000)
    cli("done", "dl")
    assert load(progress_dir, "dl")["status"] == "done"


def test_cli_unknown_total_fail_rm(progress_dir):
    cli("set", "scan", "12", "-")
    assert load(progress_dir, "scan")["total"] is None
    cli("fail", "scan", "network", "down")
    assert load(progress_dir, "scan")["message"] == "network down"
    assert cli("rm", "scan").returncode == 0
    assert cli("rm", "scan").returncode == 1


def test_cli_ls_and_json(progress_dir):
    cli("set", "a", "1", "4")
    assert "a" in cli("ls").stdout and "25.0%" in cli("ls").stdout
    assert json.loads(cli("ls", "--json").stdout)[0]["id"] == "a"


def test_cli_errors_are_exit_2_with_a_message(progress_dir):
    for args in (["set", "x"], ["set", "../x", "1"], ["set", "x", "abc"], ["set", "x", "1", "--nope", "1"], ["bogus"]):
        r = cli(*args)
        assert r.returncode == 2, args
        assert r.stderr.startswith("taskline:"), r.stderr


def test_cli_help_and_version():
    assert "usage: taskline" in cli("--help").stdout
    assert "protocol v1" in cli("--version").stdout


def test_cli_ls_marks_stalled_tasks(progress_dir):
    taskline.report("old", 1, 4)
    data = load(progress_dir, "old")
    data["updated_at"] -= 120
    (progress_dir / "old.json").write_text(json.dumps(data))
    assert "stalled" in cli("ls").stdout


def test_stalled_after_is_written_by_progress_and_cli(progress_dir):
    with taskline.Progress("slow", total=3, stalled_after=600) as p:
        p.advance()
        assert load(progress_dir, "slow")["stalled_after"] == 600
    cli("set", "batchy", "1", "9", "--stalled-after", "300")
    assert load(progress_dir, "batchy")["stalled_after"] == 300
