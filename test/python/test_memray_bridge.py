"""
test_memray_bridge.py — Unit tests for scripts/memray_bridge.py

Tests cover:
  - aggregate_from_records(): converts AllocationRecord list -> (heap_bytes, top_frames)
  - build_snapshot(): assembles final JSON-ready dict
  - emit_json(): writes compact JSON line to stdout
  - parse_args(): CLI argument parsing (--bin-path based)
  - run_file_reader(): end-to-end with mocked FileReader (polling model)
"""

from __future__ import annotations

import io
import json
import os
import signal
import sys
import time
import types
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Make the scripts/ directory importable as a module without installing it.
# ---------------------------------------------------------------------------
import importlib
import pathlib

SCRIPTS_DIR = pathlib.Path(__file__).parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import memray_bridge  # noqa: E402  (imported after sys.path manipulation)
from memray_bridge import (  # noqa: E402
    aggregate_from_records,
    build_snapshot,
    emit_json,
    parse_args,
)


# ===========================================================================
# Helpers
# ===========================================================================


def make_record(
    size: int,
    stack: list[tuple[str, str, int]],
    n_allocations: int = 1,
) -> MagicMock:
    """Build a fake AllocationRecord that mimics the real memray API."""
    record = MagicMock()
    record.size = size
    record.n_allocations = n_allocations
    # stack_trace() returns list of (func, file, line) tuples
    record.stack_trace = MagicMock(return_value=[list(f) for f in stack])
    return record


# ===========================================================================
# aggregate_from_records
# ===========================================================================


class TestAggregateFromRecords(unittest.TestCase):
    def test_empty_records_yields_zero_heap(self):
        heap_bytes, top = aggregate_from_records([], top_n=5)
        self.assertEqual(heap_bytes, 0)
        self.assertEqual(top, [])

    def test_single_record_sums_size(self):
        records = [make_record(1024, [("fn", "a.py", 1)])]
        heap_bytes, top = aggregate_from_records(records, top_n=5)
        self.assertEqual(heap_bytes, 1024)

    def test_multiple_records_sum_heap(self):
        records = [
            make_record(1024, [("fn_a", "a.py", 1)]),
            make_record(512, [("fn_b", "b.py", 2)]),
        ]
        heap_bytes, _ = aggregate_from_records(records, top_n=5)
        self.assertEqual(heap_bytes, 1536)

    def test_top_sorted_by_mem_descending(self):
        records = [
            make_record(100, [("light", "a.py", 1)]),
            make_record(1000, [("heavy", "b.py", 1)]),
            make_record(500, [("medium", "c.py", 1)]),
        ]
        _, top = aggregate_from_records(records, top_n=10)
        mems = [e["mem"] for e in top]
        self.assertEqual(mems, sorted(mems, reverse=True))

    def test_top_n_limits_entries(self):
        records = [make_record(i * 100, [(f"fn{i}", "a.py", i)]) for i in range(1, 11)]
        _, top = aggregate_from_records(records, top_n=3)
        self.assertLessEqual(len(top), 3)

    def test_top_entry_has_required_fields(self):
        records = [make_record(512, [("fn", "a.py", 1)])]
        _, top = aggregate_from_records(records, top_n=5)
        self.assertTrue(len(top) > 0)
        entry = top[0]
        for field in ("func", "file", "line", "mem", "allocs"):
            self.assertIn(field, entry)

    def test_frames_aggregated_across_records(self):
        """Same frame appearing in two records should be summed together."""
        r1 = make_record(200, [("shared_fn", "x.py", 10)])
        r2 = make_record(300, [("shared_fn", "x.py", 10)])
        _, top = aggregate_from_records([r1, r2], top_n=5)
        top_by_func = {e["func"]: e for e in top}
        self.assertIn("shared_fn", top_by_func)
        self.assertEqual(top_by_func["shared_fn"]["mem"], 500)

    def test_stack_trace_exception_is_handled_gracefully(self):
        """If stack_trace() raises, the record's heap bytes still count."""
        record = MagicMock()
        record.size = 128
        record.n_allocations = 1
        record.stack_trace = MagicMock(side_effect=RuntimeError("boom"))
        heap_bytes, top = aggregate_from_records([record], top_n=5)
        self.assertEqual(heap_bytes, 128)
        # No frames added since stack_trace failed
        self.assertEqual(top, [])

    def test_two_element_stack_frame_uses_zero_line(self):
        record = MagicMock()
        record.size = 64
        record.n_allocations = 1
        record.stack_trace = MagicMock(return_value=[["fn_two", "t.py"]])
        _, top = aggregate_from_records([record], top_n=5)
        entry = top[0]
        self.assertEqual(entry["func"], "fn_two")
        self.assertEqual(entry["line"], 0)


# ===========================================================================
# build_snapshot
# ===========================================================================


class TestBuildSnapshot(unittest.TestCase):
    def test_payload_contains_required_keys(self):
        payload = build_snapshot(heap_bytes=0, peak_bytes=0, top=[])
        for key in ("ts", "rss", "heap", "peak", "top"):
            self.assertIn(key, payload)

    def test_ts_is_recent_milliseconds(self):
        before = int(time.time() * 1000)
        payload = build_snapshot(heap_bytes=0, peak_bytes=0, top=[])
        after = int(time.time() * 1000)
        self.assertGreaterEqual(payload["ts"], before)
        self.assertLessEqual(payload["ts"], after + 50)

    def test_rss_equals_heap(self):
        payload = build_snapshot(heap_bytes=777, peak_bytes=1000, top=[])
        self.assertEqual(payload["rss"], payload["heap"])
        self.assertEqual(payload["rss"], 777)

    def test_peak_is_set(self):
        payload = build_snapshot(heap_bytes=100, peak_bytes=4096, top=[])
        self.assertEqual(payload["peak"], 4096)


# ===========================================================================
# emit_json
# ===========================================================================


class TestEmitJson(unittest.TestCase):
    def test_output_is_valid_json_line(self):
        payload = {"ts": 1000, "rss": 512, "heap": 512, "peak": 512, "top": []}
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            emit_json(payload)
        output = buf.getvalue()
        self.assertTrue(output.endswith("\n"))
        json.loads(output.strip())  # must not raise

    def test_multiple_emissions_produce_multiple_lines(self):
        payload = {"ts": 1, "rss": 0, "heap": 0, "peak": 0, "top": []}
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            emit_json(payload)
            emit_json(payload)
        lines = [line for line in buf.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 2)

    def test_each_line_is_independently_parseable(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            emit_json({"ts": 1, "rss": 128, "heap": 128, "peak": 256, "top": []})
        for line in buf.getvalue().splitlines():
            if line.strip():
                json.loads(line)  # must not raise

    def test_output_uses_compact_separators(self):
        payload = {"ts": 1, "rss": 0, "heap": 0, "peak": 0, "top": []}
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            emit_json(payload)
        output = buf.getvalue().strip()
        # Compact JSON has no spaces after : or ,
        self.assertNotIn(": ", output)
        self.assertNotIn(", ", output)


# ===========================================================================
# parse_args
# ===========================================================================


class TestParseArgs(unittest.TestCase):
    def test_required_bin_path_raises_when_missing(self):
        with self.assertRaises(SystemExit) as ctx:
            parse_args([])
        self.assertEqual(ctx.exception.code, 2)

    def test_defaults(self):
        args = parse_args(["--bin-path", "/tmp/test.bin"])
        self.assertEqual(args.bin_path, "/tmp/test.bin")
        self.assertAlmostEqual(args.interval, 0.5)
        self.assertEqual(args.top_n, 20)
        self.assertAlmostEqual(args.wait_timeout, 30.0)

    def test_custom_values(self):
        args = parse_args(
            [
                "--bin-path",
                "/some/path.bin",
                "--interval",
                "1.0",
                "--top-n",
                "10",
                "--wait-timeout",
                "5.0",
            ]
        )
        self.assertEqual(args.bin_path, "/some/path.bin")
        self.assertAlmostEqual(args.interval, 1.0)
        self.assertEqual(args.top_n, 10)
        self.assertAlmostEqual(args.wait_timeout, 5.0)


# ===========================================================================
# run_file_reader — end-to-end with mocked FileReader (polling model)
# ===========================================================================


class TestRunFileReaderMocked(unittest.TestCase):
    """
    Verifies run_file_reader works end-to-end with a fake FileReader
    injected via the memray module mock.

    The real FileReader API used by the bridge:
      - FileReader(bin_path)
      - reader.get_high_watermark_allocation_records(merge_threads=True) -> list
    """

    def _make_args(self, bin_path: str = "/tmp/fake.bin", **kwargs):
        import types as _types

        base = _types.SimpleNamespace(
            bin_path=bin_path,
            interval=0.0,  # no sleep between polls in tests
            top_n=5,
            wait_timeout=1.0,
        )
        for k, v in kwargs.items():
            setattr(base, k, v)
        return base

    def _make_file_reader(self, record_batches: list[list]):
        """
        Build a fake FileReader whose get_high_watermark_allocation_records()
        yields successive batches on each call.
        """
        reader = MagicMock()
        reader.get_high_watermark_allocation_records = MagicMock(
            side_effect=record_batches
        )
        return reader

    def test_emits_json_for_each_poll(self):
        """One JSON line emitted per poll cycle until _stop is set."""
        records = [make_record(1024, [("fn_a", "a.py", 1)])]
        fake_reader = self._make_file_reader([records])

        fake_memray = types.ModuleType("memray")
        fake_memray.FileReader = MagicMock(return_value=fake_reader)

        args = self._make_args()

        buf = io.StringIO()

        # We need the poll loop to exit after one iteration.
        # Inject a _stop flag by patching signal handling so one iteration runs.
        original_run = memray_bridge.run_file_reader

        call_count = [0]

        def patched_time_sleep(interval):
            call_count[0] += 1
            # Simulate SIGTERM after first poll by setting _stop via side-effect
            raise KeyboardInterrupt  # breaks the while loop cleanly for testing

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with (
                patch("sys.stdout", buf),
                patch("os.path.exists", return_value=True),
                patch("time.sleep", side_effect=patched_time_sleep),
            ):
                try:
                    memray_bridge.run_file_reader(args)
                except KeyboardInterrupt:
                    pass  # expected — loop exited

        lines = [line for line in buf.getvalue().splitlines() if line.strip()]
        self.assertGreater(len(lines), 0)
        for line in lines:
            parsed = json.loads(line)
            self.assertIn("ts", parsed)
            self.assertIn("peak", parsed)
            self.assertIn("top", parsed)

    def test_returns_3_when_file_not_found_within_timeout(self):
        """If the .bin file never appears, exit code should be 3."""
        fake_memray = types.ModuleType("memray")
        fake_memray.FileReader = MagicMock()

        args = self._make_args(wait_timeout=0.0)  # immediate timeout

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with patch("os.path.exists", return_value=False):
                code = memray_bridge.run_file_reader(args)

        self.assertEqual(code, 3)

    def test_returns_2_when_memray_not_importable(self):
        """If memray cannot be imported, exit code should be 2."""
        args = self._make_args()
        with patch.dict(sys.modules, {"memray": None}):
            importlib.reload(memray_bridge)
            code = memray_bridge.run_file_reader(args)
        self.assertEqual(code, 2)

    def test_peak_watermark_is_tracked_across_polls(self):
        """Peak should reflect the highest heap seen, not just the latest poll."""
        big_records = [make_record(4096, [("big", "x.py", 1)])]
        small_records = [make_record(100, [("small", "y.py", 1)])]

        fake_reader_big = MagicMock()
        fake_reader_big.get_high_watermark_allocation_records = MagicMock(
            return_value=big_records
        )
        fake_reader_small = MagicMock()
        fake_reader_small.get_high_watermark_allocation_records = MagicMock(
            return_value=small_records
        )

        poll_count = [0]
        fake_memray = types.ModuleType("memray")

        def make_reader(path):
            poll_count[0] += 1
            return fake_reader_big if poll_count[0] == 1 else fake_reader_small

        fake_memray.FileReader = MagicMock(side_effect=make_reader)

        captured: list[dict] = []

        sleep_calls = [0]

        def patched_sleep(interval):
            sleep_calls[0] += 1
            if sleep_calls[0] >= 2:
                raise KeyboardInterrupt  # stop after 2 polls

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with (
                patch("os.path.exists", return_value=True),
                patch("time.sleep", side_effect=patched_sleep),
                patch("memray_bridge.emit_json", side_effect=captured.append),
            ):
                try:
                    memray_bridge.run_file_reader(args)
                except KeyboardInterrupt:
                    pass

        # Final snapshot should still have peak=4096 even though current heap=100
        self.assertTrue(
            len(captured) >= 2, f"expected >= 2 snapshots, got {len(captured)}"
        )
        final = captured[-1]
        self.assertEqual(final["peak"], 4096)
        self.assertEqual(final["rss"], 100)

    def test_read_error_is_skipped_gracefully(self):
        """If FileReader raises on a poll, the bridge should skip that tick."""
        fake_memray = types.ModuleType("memray")
        fake_memray.FileReader = MagicMock(side_effect=OSError("partial write"))

        sleep_calls = [0]

        def patched_sleep(interval):
            sleep_calls[0] += 1
            if sleep_calls[0] >= 1:
                raise KeyboardInterrupt

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with (
                patch("os.path.exists", return_value=True),
                patch("time.sleep", side_effect=patched_sleep),
                patch("sys.stdout", io.StringIO()),
            ):
                try:
                    memray_bridge.run_file_reader(args)
                except KeyboardInterrupt:
                    pass
        # No assertions needed — the test passes if no unhandled exception is raised.


if __name__ == "__main__":
    unittest.main()
