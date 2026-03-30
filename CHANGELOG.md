# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Upgraded `d3-color` from 1.0.3 to 3.1.0 to fix a ReDoS vulnerability in color string parsing (SNYK-JS-D3COLOR-1076592).  #4
- Upgraded `picomatch` to 4.0.4 / 2.3.2 to fix two security vulnerabilities (CVE-2026-33671, CVE-2026-33672).  #7
- Upgraded `undici` from 7.22.0 to 7.24.4 to fix a prototype pollution vulnerability.  #3

### Changed
- Upgraded `d3` from 4.13.0 to 7.9.0 and `d3-flame-graph` from 4.0.6 to 4.1.3.  #4

## [0.4.0] - 2026-03-30

### Added
- **Live Mode**: Real-time memory profiling for Python scripts.
  - Visualize heap usage and peak memory in a live chart.
  - Track top allocators (functions/files) as the process runs.
  - Direct source code navigation from the live top allocators table.
  - Automatic generation of post-session artifacts (flamegraphs, stats) once the process ends.
- Configuration `memray.liveUpdateIntervalSeconds` to control the granularity of live snapshots.

## [0.3.0] - 2026-03-19

### Added
- Auto-cleanup for old Memray results based on a configurable number of days.
- Dedicated command to manually clean up old results.
- Enhanced command structure with context conditions for better UI integration.
- Integration tests for extension activation and core functionality.
- Unit tests for flamegraph, stats, and Python detection logic.
- Workflow-level read permissions for GitHub Actions (CI and Publish).

## [0.2.2] - 2026-03-13

### Changed
- Improved `.vscodeignore` to reduce extension package size.
- Included build step in the publish workflow.

## [0.2.1] - 2026-03-13

### Changed
- Restricted tag patterns for release workflows to `v*`.

## [0.2.0] - 2026-03-13

### Added
- Native flamegraph support within VS Code.
- Flamegraph UI enhancements: frame information display and improved source navigation.
- New configuration options for native tracing and output directory.
- GitHub Actions workflow for automated publishing.

### Fixed
- Prevented clearing flamegraph container to maintain D3 references and improve resizing.
- Retained webview context when hidden to prevent loss of state.
- Updated `.gitignore` to include `.memray` artifacts and `.vsix` files.

## [0.1.0] - 2026-03-13

### Added
- Core Memray profiling functionality for Python files.
- Stats summary display and error handling for profiling runs.
- Results view in the Activity Bar with support for viewing, deleting, and refreshing results.
- Commands to profile the active file or files from the Explorer context menu.
- Command to clear all stored results.
- Export results as HTML.
- MIT License.
- CI workflow and basic test infrastructure.

### Fixed
- Updated publisher and repository metadata in `package.json`.
- Refactored to ES modules for better modern JavaScript support.
