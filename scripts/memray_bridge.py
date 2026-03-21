#!/usr/bin/env python3
"""
memray_bridge.py — Live Mode middleware for the VS Code Memray extension.

Architecture (from PLAN_LIVE_PROFILE_FEATURE.md §3):
  1. Connects to a `memray run --live-remote --live-port <PORT>` socket via
     memray's SocketReader context-manager API.
  2. Polls the reader at fixed intervals (default 500 ms) using
     get_current_snapshot(merge_threads=False), which returns the current
     live allocation state as a list of AllocationRecord objects.
  3. Aggregates the snapshot into a single JSON object and emits it as a
     compact line to stdout for Node.js to parse.
  4. Exits cleanly when the target process finishes (reader.is_active == False)
     or when SIGINT/SIGTERM is received.

JSON schema emitted to stdout (one compact object per line):
  {
    "ts":    <int>   — Unix timestamp in milliseconds
    "rss":   <int>   — total heap bytes (sum of all live allocation sizes)
    "heap":  <int>   — same as rss (kept for schema compatibility)
    "peak":  <int>   — high watermark across the whole session (bytes)
    "top":   [       — top N allocator frames by current live bytes
      {
        "func":   <str>
        "file":   <str>
        "line":   <int>
        "mem":    <int>  — bytes currently attributed to this frame
        "allocs": <int>  — allocation count currently attributed
      }
    ]
  }

Exit codes:
  0 — clean stop (SIGINT / SIGTERM / target process finished)
  1 — startup / argument error
  2 — memray import error
  3 — connection error
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Live memray bridge — polls allocation snapshots and emits JSON to stdout."
    )
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help="TCP port where `memray run --live-remote` is listening.",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="Poll interval in seconds (default: 0.5).",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=20,
        help="Number of top allocator frames to include per snapshot (default: 20).",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# Snapshot aggregation
# ---------------------------------------------------------------------------

# Maps (func, file, line) -> (total_mem_bytes, total_alloc_count)
FrameStats = Dict[Tuple[str, str, int], Tuple[int, int]]


def aggregate_snapshot(
    records: list,
    peak_bytes: int,
    top_n: int,
) -> Tuple[dict, int]:
    """
    Convert a list of AllocationRecord objects (from get_current_snapshot) into
    the JSON dict we emit, and return the updated peak_bytes watermark.

    Each AllocationRecord has:
      .size          — bytes currently live for this allocation group
      .n_allocations — number of live allocations in this group
      .stack_trace() — list of (func, file, line) tuples, innermost first
    """
    heap_bytes = sum(int(getattr(r, "size", 0) or 0) for r in records)
    peak_bytes = max(peak_bytes, heap_bytes)

    # Aggregate per (func, file, line) frame across all records
    frame_stats: FrameStats = defaultdict(lambda: (0, 0))
    for record in records:
        size = int(getattr(record, "size", 0) or 0)
        n_allocs = int(getattr(record, "n_allocations", 0) or 0)
        try:
            stack = list(record.stack_trace()) or []
        except Exception:
            stack = []
        for frame in stack:
            if isinstance(frame, (list, tuple)) and len(frame) >= 3:
                key = (str(frame[0]), str(frame[1]), int(frame[2] or 0))
            elif isinstance(frame, (list, tuple)) and len(frame) == 2:
                key = (str(frame[0]), str(frame[1]), 0)
            else:
                key = (str(frame), "<unknown>", 0)
            prev_mem, prev_cnt = frame_stats[key]
            frame_stats[key] = (prev_mem + size, prev_cnt + n_allocs)

    top = sorted(
        (
            {
                "func": key[0],
                "file": key[1],
                "line": key[2],
                "mem": mem,
                "allocs": cnt,
            }
            for key, (mem, cnt) in frame_stats.items()
            if mem > 0
        ),
        key=lambda x: x["mem"],
        reverse=True,
    )[:top_n]

    payload = {
        "ts": int(time.time() * 1000),
        "rss": heap_bytes,
        "heap": heap_bytes,
        "peak": peak_bytes,
        "top": top,
    }
    return payload, peak_bytes


def emit_json(payload: dict) -> None:
    """Write one JSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Core loop — SocketReader polling path
# ---------------------------------------------------------------------------


def run_socket_reader(args: argparse.Namespace) -> int:
    """
    Connect to a live-remote socket using memray's SocketReader context manager
    and poll get_current_snapshot() at the configured interval.
    """
    try:
        from memray import SocketReader  # type: ignore[import]
    except ImportError as exc:
        sys.stderr.write(f"[memray_bridge] Cannot import memray: {exc}\n")
        return 2

    _stop = [False]

    def _handle_signal(signum: int, _frame: object) -> None:
        _stop[0] = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        reader = SocketReader(port=args.port)
    except Exception as exc:
        sys.stderr.write(f"[memray_bridge] Connection failed: {exc}\n")
        return 3

    peak_bytes = 0
    interval = args.interval
    top_n = args.top_n

    try:
        with reader:
            while not _stop[0]:
                try:
                    records = list(reader.get_current_snapshot(merge_threads=False))
                except Exception as exc:
                    sys.stderr.write(f"[memray_bridge] Snapshot error: {exc}\n")
                    break

                payload, peak_bytes = aggregate_snapshot(records, peak_bytes, top_n)
                emit_json(payload)

                if not reader.is_active:
                    break

                time.sleep(interval)

    except Exception as exc:
        sys.stderr.write(f"[memray_bridge] Stream error: {exc}\n")

    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    args = parse_args()
    return run_socket_reader(args)


if __name__ == "__main__":
    raise SystemExit(main())
