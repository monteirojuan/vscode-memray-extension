# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
