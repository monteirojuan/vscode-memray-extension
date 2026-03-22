#!/usr/bin/env python3
"""
memray_bridge.py — Live Mode middleware for the VS Code Memray extension.

Architecture:
  1. Waits for a .bin file to appear (written by `memray run --output <binPath>`).
  2. Polls the file at fixed intervals using memray.FileReader, which can read
     a partially-written .bin file while the target process is still running.
  3. Aggregates the current high-watermark allocation records into a snapshot
     JSON object and emits it as a compact line to stdout for Node.js to parse.
  4. Exits cleanly when SIGINT/SIGTERM is received (the parent Node.js process
     kills the bridge once the target exits).

JSON schema emitted to stdout (one compact object per line):
  {
    "ts":    <int>   — Unix timestamp in milliseconds
    "heap":  <int>   — total live heap bytes (sum of high-watermark record sizes)
    "peak":  <int>   — high watermark across the whole session (bytes)
    "top":   [       — top N allocator frames by current live bytes
      {
        "func":   <str>
        "file":   <str>
        "line":   <int>
        "mem":    <int>  — bytes attributed to this frame
        "allocs": <int>  — allocation count attributed
      }
    ]
  }

Exit codes:
  0 — clean stop (SIGINT / SIGTERM)
  1 — startup / argument error
  2 — memray import error
  3 — file not found / read error
"""

from __future__ import annotations

import argparse
import json
import os
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
        description=(
            "Live memray bridge — polls a .bin file written by memray run "
            "and emits JSON snapshots to stdout."
        )
    )
    parser.add_argument(
        "--bin-path",
        required=True,
        help="Path to the .bin file being written by `memray run --output`.",
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
    parser.add_argument(
        "--wait-timeout",
        type=float,
        default=30.0,
        help="Seconds to wait for the .bin file to appear (default: 30).",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# Snapshot aggregation from FileReader records
# ---------------------------------------------------------------------------

# Maps (func, file, line) -> (total_mem_bytes, total_alloc_count)
FrameStats = Dict[Tuple[str, str, int], Tuple[int, int]]


def aggregate_from_records(records: list, top_n: int) -> Tuple[int, list]:
    """
    Convert a list of AllocationRecord objects into (heap_bytes, top_frames).

    Each AllocationRecord has:
      .size          — bytes for this allocation group
      .n_allocations — number of allocations in this group
      .stack_trace() — list of (func, file, line) tuples, innermost first
    """
    heap_bytes = sum(int(getattr(r, "size", 0) or 0) for r in records)

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

    return heap_bytes, top


def build_snapshot(heap_bytes: int, peak_bytes: int, top: list) -> dict:
    return {
        "ts": int(time.time() * 1000),
        "heap": heap_bytes,
        "peak": peak_bytes,
        "top": top,
    }


def emit_json(payload: dict) -> None:
    """Write one JSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Core loop — FileReader polling path
# ---------------------------------------------------------------------------


def run_file_reader(args: argparse.Namespace) -> int:
    """
    Poll a .bin file being written by `memray run --output <path>` using
    memray's FileReader and emit JSON snapshots at each interval.
    """
    try:
        from memray import FileReader  # type: ignore[import]
    except ImportError as exc:
        sys.stderr.write(f"[memray_bridge] Cannot import memray: {exc}\n")
        return 2

    _stop = [False]

    def _handle_signal(signum: int, _frame: object) -> None:
        _stop[0] = True

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    bin_path = args.bin_path
    interval = args.interval
    top_n = args.top_n
    wait_timeout = args.wait_timeout

    # --- Wait for the .bin file to appear ---
    deadline = time.monotonic() + wait_timeout
    while not os.path.exists(bin_path):
        if _stop[0]:
            return 0
        if time.monotonic() > deadline:
            sys.stderr.write(f"[memray_bridge] Timed out waiting for {bin_path}\n")
            return 3
        time.sleep(0.1)

    sys.stderr.write(f"[memray_bridge] File found: {bin_path}\n")
    sys.stderr.flush()

    peak_bytes = 0

    # --- Poll loop ---
    while not _stop[0]:
        try:
            reader = FileReader(bin_path)
            records = list(
                reader.get_high_watermark_allocation_records(merge_threads=True)
            )
            heap_bytes, top = aggregate_from_records(records, top_n)
            peak_bytes = max(peak_bytes, heap_bytes)
            payload = build_snapshot(heap_bytes, peak_bytes, top)
            emit_json(payload)
        except Exception as exc:
            # File may still be in a partial/unreadable state — skip this tick
            sys.stderr.write(f"[memray_bridge] Read error (skipping): {exc}\n")

        time.sleep(interval)

    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    args = parse_args()
    return run_file_reader(args)


if __name__ == "__main__":
    raise SystemExit(main())
