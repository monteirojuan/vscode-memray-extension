#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Memray .bin to normalized flamegraph.json")
    parser.add_argument("--bin", required=True, dest="bin_path")
    parser.add_argument("--output", required=True, dest="output_path")
    parser.add_argument("--run-id", required=True, dest="run_id")
    parser.add_argument("--script", required=True, dest="script")
    parser.add_argument("--stats", required=False, dest="stats_path")
    parser.add_argument("--native-traces", action="store_true", dest="native_traces")
    return parser.parse_args()


def normalize_frame(frame: Any) -> Tuple[str, str, int]:
    if isinstance(frame, dict):
        function = str(frame.get("function") or frame.get("name") or "<unknown>")
        file_name = str(frame.get("file") or frame.get("filename") or "<unknown>")
        line = int(frame.get("line") or frame.get("lineno") or 0)
        return function, file_name, line

    if isinstance(frame, (list, tuple)):
        if len(frame) >= 3:
            return str(frame[0]), str(frame[1]), int(frame[2] or 0)
        if len(frame) == 2:
            return str(frame[0]), str(frame[1]), 0
        if len(frame) == 1:
            return str(frame[0]), "<unknown>", 0

    return str(frame), "<unknown>", 0


def get_record_stack(record: Any) -> List[Tuple[str, str, int]]:
    callables = ["stack_trace", "hybrid_stack_trace"]
    for method_name in callables:
        method = getattr(record, method_name, None)
        if callable(method):
            try:
                stack = method()
            except TypeError:
                continue
            if stack:
                return [normalize_frame(item) for item in stack]
    return []


def load_stats_summary(stats_path: Optional[str]) -> Dict[str, int]:
    if not stats_path:
        return {
            "peakMemoryBytes": 0,
            "totalAllocations": 0,
            "totalBytesAllocated": 0,
            "durationMs": 0,
        }

    try:
        raw = json.loads(Path(stats_path).read_text(encoding="utf-8"))
    except Exception:
        return {
            "peakMemoryBytes": 0,
            "totalAllocations": 0,
            "totalBytesAllocated": 0,
            "durationMs": 0,
        }

    metadata = raw.get("metadata") or {}
    return {
        "peakMemoryBytes": int(metadata.get("peak_memory") or 0),
        "totalAllocations": int(metadata.get("total_allocations") or 0),
        "totalBytesAllocated": int(metadata.get("total_memory_allocated") or 0),
        "durationMs": int(metadata.get("command_line_duration") or metadata.get("duration") or 0),
    }


def get_records(reader: Any) -> Iterable[Any]:
    methods = [
        "get_high_watermark_allocation_records",
        "get_leaked_allocation_records",
        "get_allocation_records",
    ]
    for method_name in methods:
        method = getattr(reader, method_name, None)
        if not callable(method):
            continue
        try:
            return method(merge_threads=True)
        except TypeError:
            try:
                return method()
            except Exception:
                continue
        except Exception:
            continue
    return []


def make_node(name: str, function: str, file_name: str, line: int, thread_id: str) -> Dict[str, Any]:
    return {
        "name": name,
        "function": function,
        "file": file_name,
        "line": line,
        "value": 0,
        "nAllocations": 0,
        "threadId": thread_id,
        "interesting": True,
        "importSystem": False,
        "children": [],
        "_childrenByKey": {},
    }


def get_or_create_child(node: Dict[str, Any], key: str, frame: Tuple[str, str, int], thread_id: str) -> Dict[str, Any]:
    children_by_key = node.get("_childrenByKey")
    if key in children_by_key:
        return children_by_key[key]

    function, file_name, line = frame
    child = make_node(function, function, file_name, line, thread_id)
    node["children"].append(child)
    children_by_key[key] = child
    return child


def strip_internal_keys(node: Dict[str, Any]) -> None:
    node.pop("_childrenByKey", None)
    for child in node.get("children", []):
        strip_internal_keys(child)


def build_tree(records: Iterable[Any]) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    root = make_node("<root>", "<tracker>", "memray", 0, "0x0")
    thread_labels: Dict[str, str] = {}

    for record in records:
        size = int(getattr(record, "size", 0) or 0)
        n_alloc = int(getattr(record, "n_allocations", 1) or 1)
        tid = str(getattr(record, "tid", "0x0") or "0x0")
        thread_labels.setdefault(tid, tid)

        stack = get_record_stack(record)
        ordered_stack = list(reversed(stack)) if stack else [("<unknown>", "<unknown>", 0)]

        current = root
        current["value"] += size
        current["nAllocations"] += n_alloc

        for function, file_name, line in ordered_stack:
            key = f"{function}|{file_name}|{line}|{tid}"
            current = get_or_create_child(current, key, (function, file_name, line), tid)
            current["value"] += size
            current["nAllocations"] += n_alloc

    strip_internal_keys(root)
    threads = [{"id": thread_id, "label": label} for thread_id, label in thread_labels.items()]
    return root, threads


def main() -> int:
    args = parse_args()

    try:
        import memray
        from memray import FileReader
    except Exception as error:
        raise RuntimeError(f"Failed to import memray public API: {error}")

    reader = FileReader(args.bin_path)
    records = list(get_records(reader))
    root, threads = build_tree(records)
    summary = load_stats_summary(args.stats_path)

    payload: Dict[str, Any] = {
        "version": 1,
        "runId": args.run_id,
        "script": args.script,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "nativeTraces": bool(args.native_traces),
        "mergeThreads": True,
        "summary": summary,
        "threads": threads,
        "root": root,
        "memrayVersion": getattr(memray, "__version__", None),
    }

    output_path = Path(args.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
