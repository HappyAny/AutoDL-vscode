# Changelog

## 0.2.19

- Added optional `autodl.remoteCodex.authJsonPath` for Codex `auth.json` handoff.
- Upload the configured local auth file to `~/.codex/auth.json` after a successful remote Codex extension install.
- Before releasing a reachable running instance, download `~/.codex/auth.json` back to the same configured local path if it exists, then wipe the remote home directory.

## 0.2.18

- Probe the remote VS Code Server CLI before writing remote proxy settings for Codex setup.
- Skip remote proxy settings, extension copy, upload, install verification, and remote refresh when the VS Code Server has not been initialized.

## 0.2.17

- Stop remote Codex installation when the remote VS Code Server CLI is not initialized yet.
- Log a clear first-connection reminder instead of copying local extensions, uploading files, or refreshing the remote window.

## 0.2.16

- Added visible release logs for remote home cleanup, verification, stop, release, and local cleanup steps.
- Show remote cleanup command output, including the verified remaining-entry count, before continuing to release.
- Mark releases as aborted in the AutoDL output panel when remote cleanup verification fails.

## 0.2.15

- Verified the remote home directory is empty after the pre-release wipe.
- Abort release if the remote wipe verification still finds remaining home-directory entries.

## 0.2.14

- Wipe the remote home directory before releasing a reachable running AutoDL instance.
- Added the same pre-release wipe to the bulk stop-and-release flow.

## 0.2.13

- Stopped remote Codex installation from rewriting proxy settings when they already match the desired values.
- Kept remote proxy settings corrected to the configured values when they are missing or stale.

## 0.2.12

- Added automatic Remote SSH window refresh after remote Codex extension installation.
- Added `autodl.remoteCodex.autoReloadRemoteWindow` to disable that refresh when needed.

## 0.2.11

- Switched the local Codex extension fallback copy from recursive `scp` to a compressed tar stream.
- Wrote the remote `extensions.json` install metadata after fallback copies so VS Code can enable the extension after one reload.

## 0.2.10

- Added a local-extension copy fallback when remote Marketplace installation does not appear in the Remote SSH extension list.
- Staged copied extensions as `linux-x64` and restored executable bits for bundled Linux tools on the remote.
- Explicitly passed the Remote SSH extension directory to remote VS Code server extension commands.

## 0.2.9

- Found the remote VS Code server CLI in both legacy `bin/*/bin/code-server` and newer `cli/servers/*/server/bin/*` layouts.
- Suppressed duplicate `RemoteForward` listen-port warnings from one-shot SSH command output.

## 0.2.8

- Installed Codex on the real Remote SSH target by invoking the remote VS Code server CLI over SSH.
- Verified remote installs through the remote `code-server --list-extensions` output and matching remote extension directory.

## 0.2.7

- Verified remote Codex VS Code extension installs by checking the remote extension list after install.
- Merged the view-title proxy and Codex actions into one remote preparation action.
- Changed remote proxy settings to toggle on second click, including instance context actions.

## 0.2.6

- Added manual and optional automatic installation of the configured Codex VS Code extension on AutoDL Remote SSH targets.
- Added settings for the remote Codex extension id and install timeout.

## 0.2.5

- Added default AutoDL managed SSH `RemoteForward` proxy forwarding on port 7890.
- Added a command and view button to write remote VS Code proxy settings for an AutoDL instance.

## 0.2.4

- Stopped the transient-instance auto-refresh timer after AutoDL list/network errors.
- Cancelled in-flight SSH sync commands when folder sync is stopped.

## 0.2.3

- Stopped automatically starting folder sync after Remote - SSH connect.
- Folder sync now starts only from explicit sync or upload actions.

## 0.2.0

- Added cross-platform VSIX packaging jobs for Windows, macOS, and Ubuntu.
- Improved AutoDL network/TLS retry diagnostics.
- Fixed cross-platform Remote - SSH runtime placement behavior.

## 0.1.23

- Added short retries and clearer diagnostics for transient AutoDL network/TLS failures.

## 0.1.22

- Removed matching VS Code Open Recent Remote - SSH entries after releasing AutoDL instances.

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
