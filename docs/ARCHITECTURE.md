# Architecture

## Overview
The VS Code Memray Extension is designed to provide a seamless memory profiling experience for Python developers. It bridges the gap between the `memray` CLI tool and the VS Code environment by automating execution, parsing results, and providing interactive visualizations.

## Project Structure
```
vscode-memray-extension/
├── src/
│   ├── extension.ts              # Main entry point, activation, deactivation
│   ├── commands/                 # Command implementations (profile, clear, etc.)
│   ├── views/                    # UI Components (Tree views, Webviews)
│   ├── memray/                   # Memray-specific logic (Executor, Parser)
│   ├── utils/                    # Shared utilities (Python detection, logging)
│   └── config.ts                 # Configuration management
├── media/                        # Webview assets (CSS, JS)
├── test/                         # Test suite
├── package.json                  # Extension manifest
└── docs/                         # Documentation
```

## Core Modules
- **`memray/executor.ts`**: Handles the execution of the `memray run` subprocess.
- **`memray/liveProvider.ts`**: Orchestrates the Live Mode session, managing the target process and the bridge middleware.
- **`memray/parser.ts`**: Processes `.bin` files and extracts data for the UI.
- **`views/flamegraphWebview.ts`**: Manages the D3-based interactive flamegraph.
- **`views/liveWebview.ts`**: Manages the real-time charting and top-allocators table UI.
- **`utils/pythonDetection.ts`**: Logic to locate the best Python interpreter and verify `memray` installation.

## Live Mode Architecture
The Live Mode uses a bridge pattern to stream real-time data from a running process:

1. **Target Process**: `memray run --output <binPath>` is executed on the Python script.
2. **Bridge Middleware (`scripts/memray_bridge.py`)**: A Python subprocess that polls the `.bin` file as it's being written using `memray.FileReader`. It aggregates high-watermark records into snapshots.
3. **Communication**: The bridge emits newline-delimited JSON objects to `stdout`.
4. **Extension Host**: `liveProvider.ts` parses these JSON lines and forwards them to the Webview.
5. **Webview**: Renders a live chart and a sortable table of top allocators.

## Data Flow
1. **Trigger**: User starts profiling via context menu (Standard or Live).
2. **Environment**: Extension detects Python and verifies `memray`.
3. **Execution**: `memray run` is executed on the target script.
4. **Processing**: 
   - **Standard**: Output `.bin` is parsed after completion.
   - **Live**: `memray_bridge.py` polls the `.bin` file in real-time.
5. **Visualization**: Data is sent to the Webview (Flamegraph or Live Dashboard).
6. **Artifact Generation**: After a Live session ends, the extension automatically generates flamegraphs and stats from the captured `.bin` file.

## Key Data Structures
### ProfilingResult
```typescript
interface ProfilingResult {
  id: string;
  timestamp: string;
  script: string;
  bin: string;
  peakMemoryBytes?: number;
  // ... status flags and artifact paths
}
```

### LiveSnapshot
```typescript
interface LiveSnapshot {
  ts: number;    // Unix timestamp in ms
  heap: number;  // Current live heap bytes
  peak: number;  // Session high-watermark
  top: Array<{
    func: string;
    file: string;
    line: number;
    mem: number;
    allocs: number;
  }>;
}
```

