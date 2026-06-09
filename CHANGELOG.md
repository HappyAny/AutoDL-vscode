# Changelog

## 0.1.21

- Added local UI extension placement for cross-platform Remote - SSH behavior.
- Added macOS/Linux install script and Chinese README.
- Documented AutoDL Pro API verification requirements, stopped-instance retention, billing rules, and shutdown/release cost guidance.
- Added a one-shot upload action for running instances.
- Added a view-title folder button to configure local and remote sync folders.
- Switched transfer progress to streaming byte-level accounting in the VS Code status bar.
- Isolated AutoDL managed SSH host keys in `~/.ssh/autodl-vscode-known_hosts`.
- Kept upload progress text compact: percentage plus transferred size over total size.

## 0.1.14 - 0.1.20

- Added readable instance details, charge labels, GPU model labels, and lifecycle-specific actions.
- Added GPU and image catalog caching with manual refresh.
- Added AutoDL folder sync and managed SSH config cleanup.
- Added DL extension icons for the Activity Bar and extension list.

## 0.1.0

- Initial AutoDL Pro instance control from a VS Code Activity Bar view.
