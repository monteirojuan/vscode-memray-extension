"""
test_memray_bridge.py — Unit tests for scripts/memray_bridge.py

Tests cover:
  - aggregate_snapshot(): converts AllocationRecord list -> JSON payload + peak tracking
  - emit_json(): writes compact JSON line to stdout
  - parse_args(): CLI argument parsing
  - run_socket_reader(): end-to-end with mocked SocketReader (polling model)
"""

from __future__ import annotations

import io
import json
import sys
import time
import types
import unittest
from unittest.mock import MagicMock, PropertyMock, patch

# ---------------------------------------------------------------------------
# Make the scripts/ directory importable as a module without installing it.
# ---------------------------------------------------------------------------
import importlib
import pathlib

SCRIPTS_DIR = pathlib.Path(__file__).parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import memray_bridge  # noqa: E402  (imported after sys.path manipulation)
from memray_bridge import (  # noqa: E402
    aggregate_snapshot,
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
# aggregate_snapshot
# ===========================================================================


class TestAggregateSnapshot(unittest.TestCase):
    def test_empty_records_yields_zero_heap(self):
        payload, peak = aggregate_snapshot([], peak_bytes=0, top_n=5)
        self.assertEqual(payload["rss"], 0)
        self.assertEqual(payload["heap"], 0)
        self.assertEqual(payload["peak"], 0)
        self.assertEqual(payload["top"], [])

    def test_single_record_sums_size(self):
        records = [make_record(1024, [("fn", "a.py", 1)])]
        payload, peak = aggregate_snapshot(records, peak_bytes=0, top_n=5)
        self.assertEqual(payload["rss"], 1024)
        self.assertEqual(payload["heap"], 1024)
        self.assertEqual(peak, 1024)

    def test_multiple_records_sum_heap(self):
        records = [
            make_record(1024, [("fn_a", "a.py", 1)]),
            make_record(512, [("fn_b", "b.py", 2)]),
        ]
        payload, peak = aggregate_snapshot(records, peak_bytes=0, top_n=5)
        self.assertEqual(payload["rss"], 1536)

    def test_peak_is_preserved_across_calls(self):
        records_big = [make_record(4096, [("big", "c.py", 5)])]
        _, peak = aggregate_snapshot(records_big, peak_bytes=0, top_n=5)
        self.assertEqual(peak, 4096)

        # Now call with smaller records — peak must stay at 4096
        records_small = [make_record(100, [("small", "d.py", 1)])]
        payload, peak2 = aggregate_snapshot(records_small, peak_bytes=peak, top_n=5)
        self.assertEqual(peak2, 4096)
        self.assertEqual(payload["peak"], 4096)

    def test_top_sorted_by_mem_descending(self):
        records = [
            make_record(100, [("light", "a.py", 1)]),
            make_record(1000, [("heavy", "b.py", 1)]),
            make_record(500, [("medium", "c.py", 1)]),
        ]
        payload, _ = aggregate_snapshot(records, peak_bytes=0, top_n=10)
        mems = [e["mem"] for e in payload["top"]]
        self.assertEqual(mems, sorted(mems, reverse=True))

    def test_top_n_limits_entries(self):
        records = [make_record(i * 100, [(f"fn{i}", "a.py", i)]) for i in range(1, 11)]
        payload, _ = aggregate_snapshot(records, peak_bytes=0, top_n=3)
        self.assertLessEqual(len(payload["top"]), 3)

    def test_top_entry_has_required_fields(self):
        records = [make_record(512, [("fn", "a.py", 1)])]
        payload, _ = aggregate_snapshot(records, peak_bytes=0, top_n=5)
        self.assertTrue(len(payload["top"]) > 0)
        entry = payload["top"][0]
        for field in ("func", "file", "line", "mem", "allocs"):
            self.assertIn(field, entry)

    def test_payload_contains_required_keys(self):
        payload, _ = aggregate_snapshot([], peak_bytes=0, top_n=5)
        for key in ("ts", "rss", "heap", "peak", "top"):
            self.assertIn(key, payload)

    def test_ts_is_recent_milliseconds(self):
        before = int(time.time() * 1000)
        payload, _ = aggregate_snapshot([], peak_bytes=0, top_n=5)
        after = int(time.time() * 1000)
        self.assertGreaterEqual(payload["ts"], before)
        self.assertLessEqual(payload["ts"], after + 50)

    def test_frames_aggregated_across_records(self):
        """Same frame appearing in two records should be summed together."""
        r1 = make_record(200, [("shared_fn", "x.py", 10)])
        r2 = make_record(300, [("shared_fn", "x.py", 10)])
        payload, _ = aggregate_snapshot([r1, r2], peak_bytes=0, top_n=5)
        top_by_func = {e["func"]: e for e in payload["top"]}
        self.assertIn("shared_fn", top_by_func)
        self.assertEqual(top_by_func["shared_fn"]["mem"], 500)

    def test_stack_trace_exception_is_handled_gracefully(self):
        """If stack_trace() raises, the record should be counted but have no frames."""
        record = MagicMock()
        record.size = 128
        record.n_allocations = 1
        record.stack_trace = MagicMock(side_effect=RuntimeError("boom"))
        payload, _ = aggregate_snapshot([record], peak_bytes=0, top_n=5)
        self.assertEqual(payload["rss"], 128)
        # No frames added since stack_trace failed
        self.assertEqual(payload["top"], [])

    def test_two_element_stack_frame_uses_zero_line(self):
        record = MagicMock()
        record.size = 64
        record.n_allocations = 1
        record.stack_trace = MagicMock(return_value=[["fn_two", "t.py"]])
        payload, _ = aggregate_snapshot([record], peak_bytes=0, top_n=5)
        entry = payload["top"][0]
        self.assertEqual(entry["func"], "fn_two")
        self.assertEqual(entry["line"], 0)

    def test_rss_equals_heap(self):
        records = [make_record(777, [("fn", "a.py", 1)])]
        payload, _ = aggregate_snapshot(records, peak_bytes=0, top_n=5)
        self.assertEqual(payload["rss"], payload["heap"])


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
        lines = [l for l in buf.getvalue().splitlines() if l.strip()]
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
    def test_required_port_raises_when_missing(self):
        with self.assertRaises(SystemExit) as ctx:
            parse_args([])
        self.assertEqual(ctx.exception.code, 2)

    def test_defaults(self):
        args = parse_args(["--port", "9876"])
        self.assertEqual(args.port, 9876)
        self.assertAlmostEqual(args.interval, 0.5)
        self.assertEqual(args.top_n, 20)

    def test_custom_values(self):
        args = parse_args(
            [
                "--port",
                "1234",
                "--interval",
                "1.0",
                "--top-n",
                "10",
            ]
        )
        self.assertEqual(args.port, 1234)
        self.assertAlmostEqual(args.interval, 1.0)
        self.assertEqual(args.top_n, 10)


# ===========================================================================
# run_socket_reader — end-to-end with mocked SocketReader (polling model)
# ===========================================================================


class TestRunSocketReaderMocked(unittest.TestCase):
    """
    Verifies run_socket_reader works end-to-end with a fake SocketReader
    injected via the memray module mock.

    The real SocketReader API:
      - Context manager: `with SocketReader(port=N) as reader`
      - reader.get_current_snapshot(merge_threads=False) -> list[AllocationRecord]
      - reader.is_active -> bool (False when target process finishes)
    """

    def _make_args(self, **kwargs):
        base = types.SimpleNamespace(
            port=9999,
            interval=0.0,  # no sleep between polls in tests
            top_n=5,
        )
        for k, v in kwargs.items():
            setattr(base, k, v)
        return base

    def _make_context_reader(self, snapshots: list[list], is_active_values: list[bool]):
        """
        Build a fake SocketReader that:
        - Acts as a context manager (__enter__ returns self)
        - Returns successive snapshot lists from get_current_snapshot()
        - Returns successive is_active property values

        is_active is a property on the real SocketReader, so we use
        type(reader).is_active = PropertyMock(...) to make attribute
        access return the desired values rather than a MagicMock object.
        """
        reader = MagicMock()
        reader.__enter__ = MagicMock(return_value=reader)
        reader.__exit__ = MagicMock(return_value=False)
        reader.get_current_snapshot = MagicMock(side_effect=snapshots)
        type(reader).is_active = PropertyMock(side_effect=is_active_values)
        return reader

    def test_emits_json_for_each_poll(self):
        """One JSON line should be emitted per poll cycle."""
        records = [make_record(1024, [("fn_a", "a.py", 1)])]
        # Two polls: first active, second not active (stops loop)
        reader = self._make_context_reader(
            snapshots=[records, []],
            is_active_values=[True, False],
        )

        fake_memray = types.ModuleType("memray")
        fake_memray.SocketReader = MagicMock(return_value=reader)

        buf = io.StringIO()
        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with patch("sys.stdout", buf):
                code = memray_bridge.run_socket_reader(args)

        self.assertEqual(code, 0)
        # SocketReader must be called with keyword port=
        fake_memray.SocketReader.assert_called_once_with(port=9999)
        lines = [l for l in buf.getvalue().splitlines() if l.strip()]
        self.assertGreater(len(lines), 0)
        for line in lines:
            parsed = json.loads(line)
            self.assertIn("ts", parsed)
            self.assertIn("peak", parsed)
            self.assertIn("top", parsed)

    def test_returns_3_when_connection_fails(self):
        fake_memray = types.ModuleType("memray")
        fake_memray.SocketReader = MagicMock(
            side_effect=ConnectionRefusedError("refused")
        )

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            code = memray_bridge.run_socket_reader(args)

        self.assertEqual(code, 3)

    def test_returns_2_when_memray_not_importable(self):
        args = self._make_args()
        with patch.dict(sys.modules, {"memray": None}):
            importlib.reload(memray_bridge)
            code = memray_bridge.run_socket_reader(args)
        self.assertEqual(code, 2)

    def test_peak_watermark_is_tracked_across_polls(self):
        """Peak should reflect the highest heap seen, not just the latest poll."""
        big_records = [make_record(4096, [("big", "x.py", 1)])]
        small_records = [make_record(100, [("small", "y.py", 1)])]

        reader = self._make_context_reader(
            snapshots=[big_records, small_records],
            is_active_values=[True, False],
        )

        fake_memray = types.ModuleType("memray")
        fake_memray.SocketReader = MagicMock(return_value=reader)

        captured: list[dict] = []

        def fake_emit_json(payload):
            captured.append(payload)

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with patch("memray_bridge.emit_json", fake_emit_json):
                memray_bridge.run_socket_reader(args)

        # Last snapshot should still have peak=4096 even though current heap=100
        self.assertTrue(len(captured) >= 2)
        final = captured[-1]
        self.assertEqual(final["peak"], 4096)
        self.assertEqual(final["rss"], 100)

    def test_loop_exits_when_not_active(self):
        """reader.is_active == False should stop the poll loop after one cycle."""
        reader = self._make_context_reader(
            snapshots=[[]],
            is_active_values=[False],
        )

        fake_memray = types.ModuleType("memray")
        fake_memray.SocketReader = MagicMock(return_value=reader)

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with patch("sys.stdout", io.StringIO()):
                code = memray_bridge.run_socket_reader(args)

        self.assertEqual(code, 0)
        # get_current_snapshot called exactly once
        self.assertEqual(reader.get_current_snapshot.call_count, 1)

    def test_snapshot_error_breaks_loop_gracefully(self):
        """If get_current_snapshot raises, the bridge should exit with code 0."""
        reader = MagicMock()
        reader.__enter__ = MagicMock(return_value=reader)
        reader.__exit__ = MagicMock(return_value=False)
        reader.get_current_snapshot = MagicMock(
            side_effect=RuntimeError("socket closed")
        )

        fake_memray = types.ModuleType("memray")
        fake_memray.SocketReader = MagicMock(return_value=reader)

        args = self._make_args()

        with patch.dict(sys.modules, {"memray": fake_memray}):
            importlib.reload(memray_bridge)
            with patch("sys.stdout", io.StringIO()):
                code = memray_bridge.run_socket_reader(args)

        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
