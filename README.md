# AutoDL Control for VS Code

VS Code extension for controlling AutoDL Pro instances from the Activity Bar.

[中文文档](README.zh-CN.md)

## Features

- List AutoDL Pro instances with readable GPU, CPU, region, status, and price details.
- Quick-create default machine profiles or select GPU, image, storage, CUDA, and region manually.
- Connect to running instances with VS Code Remote - SSH.
- Open Jupyter from an instance snapshot.
- Start, stop, release, and bulk close instances.
- Remove matching VS Code Open Recent Remote - SSH entries after releasing instances.
- Cache GPU and image catalogs locally and refresh them on demand.
- Configure local and remote sync folders, run background sync, or upload a folder once.

## Requirements

- VS Code 1.90 or newer.
- Node.js and npm for local development.
- The VS Code Remote - SSH extension for remote windows.
- Local OpenSSH `ssh` available on PATH.
- An AutoDL Pro API token.
- AutoDL requires personal real-name verification or enterprise verification before using the Container Instance Pro API.
- The extension runs on the local VS Code UI side. This keeps AutoDL API calls, SSH config writes, and folder sync operations on your local machine, including when you open a Remote - SSH window.

## AutoDL Account and Billing Notes

Check the current AutoDL documentation before running production workloads:

- The Container Instance Pro API requires personal real-name verification or enterprise verification.
- Pro API instance creation uses pay-as-you-go billing by default. The API docs currently say other billing modes are not supported at create time through this endpoint.
- For pay-as-you-go instances, AutoDL starts billing when the instance powers on and stops billing when it shuts down. Billing time follows instance power-on and shutdown time, not GPU utilization.
- Stopped instances keep their data for a limited period. AutoDL documents a release rule of 15 consecutive shutdown days; after release, instance data is cleared and cannot be recovered.
- Shutdown is not the same as saving a long-term image. Save an image first if you need to keep the system environment, and check AutoDL image storage billing before keeping many or large images.
- Paid data disks, file storage, saved images, and other storage products may continue to generate separate charges even when the instance is shut down.

Cost reminder: when you finish using an instance, shut it down first to stop compute billing, then release it when you no longer need the instance data. This avoids unnecessary spend and stale resources.

References: [Container Instance Pro API](https://www.autodl.com/docs/instance_pro_api/), [instance data retention](https://www.autodl.com/docs/instance_data/), and [billing](https://www.autodl.com/docs/price/).

## Fast Install

Windows PowerShell:

```powershell
.\scripts\install.ps1
```

macOS or Linux:

```bash
chmod +x ./scripts/install.sh
./scripts/install.sh
```

The install script runs `npm install`, builds `dist/autodl-control.vsix`, and installs it into VS Code with `code --install-extension`.

Manual install:

```powershell
npm install
npm run package
code --install-extension ./dist/autodl-control.vsix --force
```

## Usage

Open the AutoDL icon in the VS Code Activity Bar.

Commands:

- `AutoDL: Set Token`
- `AutoDL: Set SSH Public Key`
- `AutoDL: Clean SSH Config`
- `AutoDL: Refresh Instances`
- `AutoDL: Refresh GPU and Image Catalogs` - update cached GPU specs, public images, and private images
- `AutoDL: Set Sync Folders`
- `AutoDL: Start Folder Sync`
- `AutoDL: Upload Sync Folder`
- `AutoDL: Stop Folder Sync`
- `AutoDL: Quick Create`
- `AutoDL: Select Server` - choose GPU model, GPU count, image, CUDA, extra system storage, data centers, name, and start command
- `AutoDL: Quick Create Low`
- `AutoDL: Quick Create Mid`
- `AutoDL: Quick Create High`
- `AutoDL: Stop and Release All Active Instances`

Instance actions in the tree:

- Running instances: Connect with Remote SSH, Open Jupyter, Upload Sync Folder, Shutdown Instance, Release Instance
- Shutdown instances: Turn On Instance, Release Instance

When a reachable running instance is released through the extension, AutoDL Control first wipes the remote home directory contents over SSH, including Codex and VS Code server data under `/root`, verifies the remote home directory is empty, then shuts down and releases the instance. The AutoDL output panel logs every release step and prints the remote verification result, including the remaining-entry count. If that verification still finds remaining entries, release is aborted. Already stopped instances cannot be wiped over SSH, so release relies on AutoDL clearing the instance data. After release, the managed `Host autodl-<instance>` SSH config block and matching VS Code Open Recent Remote - SSH entry are removed. Use `AutoDL: Clean SSH Config` to remove all stale AutoDL-managed blocks.

The GPU and image catalogs are cached in VS Code global storage. Use the cloud-download icon in the AutoDL view title to refresh them from the AutoDL API docs and your private image list.

## Folder Sync

Use `AutoDL: Set Sync Folders` to choose a local folder and a remote folder. Connecting with Remote - SSH does not start sync automatically; use `AutoDL: Start Folder Sync` when you explicitly want background bidirectional sync.

The folder icon in the AutoDL view title runs the same folder configuration command, so you can reselect both local and remote sync folders without opening the command palette.

Use the cloud-upload button on a running instance, or run `AutoDL: Upload Sync Folder`, for a one-shot local-to-remote upload. It uses the same configured local and remote folders, overwrites remote files with the same relative path, and does not delete remote-only files.

Sync behavior is conservative:

- New files on either side are copied to the other side.
- A file changed on only one side overwrites the unchanged copy on the other side.
- If both sides changed the same file, the extension writes a `*.local-conflict-*` or `*.remote-conflict-*` copy instead of overwriting either file.
- Deletes are not synced.
- Default ignored names include `.git`, `node_modules`, virtualenv folders, and Python cache folders.

Folder sync and one-shot upload use local `ssh` with `BatchMode=yes`, so they require key-based SSH login. Run `AutoDL: Set SSH Public Key` before creating new instances for hands-free sync.

Progress is visible in two places:

- The VS Code status bar shows scanning and streaming byte-level transfer progress, including percentage and transferred size. Click it to stop active sync sessions.
- The AutoDL output panel logs each uploaded, downloaded, or conflict-copied file plus the per-cycle summary.

## Defaults

Quick-create defaults are configured through VS Code settings under `autodl.quickCreate`:

- `low`: 4080(S) 32G, `v-32g-p`
- `mid`: 5090 32G, `5090-p`
- `high`: RTX PRO 6000, `pro6000-p`
- default image: `base-image-l2t43iu6uk`
- default CUDA lower bound: `130`
- default GPU count: `1`
- default system disk expansion: `0`
- default data centers: empty, letting AutoDL choose

Token is stored in VS Code SecretStorage. `AUTODL_TOKEN` is supported as a fallback.

## Settings

Important settings:

- `autodl.apiBaseUrl`
- `autodl.openRemotePath`
- `autodl.sshPublicKey`
- `autodl.sshIdentityFile`
- `autodl.injectSshPublicKeyOnCreate`
- `autodl.remoteProxy.enabled`
- `autodl.remoteProxy.proxyUrl`
- `autodl.remoteProxy.remoteForwardPort`
- `autodl.remoteCodex.autoInstall`
- `autodl.remoteCodex.autoReloadRemoteWindow`
- `autodl.remoteCodex.extensionId`
- `autodl.remoteCodex.authJsonPath`
- `autodl.remoteCodex.installTimeoutSeconds`
- `autodl.sync.localFolder`
- `autodl.sync.remoteFolder`
- `autodl.sync.intervalSeconds`
- `autodl.sync.excludeNames`
- `autodl.quickCreate`

## Remote SSH Behavior

Quick Create and Select Server only create the instance and refresh the list. They do not automatically connect, because the instance may not be fully ready yet.

When Connect is clicked, the extension:

1. Calls AutoDL snapshot for the instance.
2. Writes a managed host entry to `~/.ssh/config`.
3. Copies the root password to the clipboard.
4. Opens `vscode-remote://ssh-remote+autodl-<instance>/root`.

Managed `autodl-*` SSH hosts use a separate `~/.ssh/autodl-vscode-known_hosts` file and non-interactive host-key acceptance so AutoDL proxy endpoints do not block folder upload or sync.

Managed `autodl-*` SSH hosts also include a local-proxy remote forward by default:

```sshconfig
RemoteForward 7890 127.0.0.1:7890
```

This lets the remote VS Code server use a local HTTP or SOCKS5 proxy on port 7890 through the existing SSH connection. The extension does not change your local VS Code proxy settings. Use `AutoDL: Toggle Remote Proxy Settings` to write these remote VS Code settings for the selected instance; run it again to remove the same keys:

```json
{
  "http.proxy": "http://127.0.0.1:7890",
  "http.proxyStrictSSL": false,
  "http.proxySupport": "on"
}
```

The proxy URL can be changed with `autodl.remoteProxy.proxyUrl`; `http`, `https`, `socks`, `socks4`, and `socks5` URLs are accepted.

### Remote Proxy and Codex

Use `AutoDL: Prepare Remote Proxy and Codex` from the view title to enable the remote proxy and install the configured Codex VS Code extension in one action. If the proxy settings are already present, the same action removes them and skips the install. Instance context actions remain separate: `AutoDL: Toggle Remote Proxy Settings` only toggles proxy settings, and `AutoDL: Install Remote Codex Extension` installs the configured extension.

The default extension id is `openai.chatgpt`. Installs run through the remote VS Code server CLI over SSH, support both legacy and current VS Code server layouts, and are verified with the remote extension list plus the remote extension directory.

Important behavior:

- If the remote VS Code Server CLI is not initialized yet, AutoDL logs a first-connection reminder and skips remote proxy settings, local extension copy, upload, install verification, and remote window refresh. Open the target with Remote SSH once, wait for server initialization, then retry.
- If remote Marketplace installation fails after the server CLI exists, AutoDL falls back to copying the locally installed extension to the remote Linux extension directory through a compressed tar stream, writes remote extension metadata, and restores executable bits for bundled Linux tools.
- Codex installation writes remote proxy settings only when they are missing or do not match the configured values. Once they match, it skips rewriting them until you explicitly change or remove them with `AutoDL: Toggle Remote Proxy Settings`.
- If `autodl.remoteCodex.authJsonPath` is set, AutoDL uploads that local `auth.json` to `~/.codex/auth.json` after a successful remote Codex install, and downloads the remote file back to the same local path before wiping a reachable running instance during release. Leave the setting empty to disable auth upload and download.
- After a successful installation, AutoDL reloads the current matching Remote SSH window. When the command is run from another window, it opens the AutoDL remote folder in a new window so the remote extension state refreshes. Set `autodl.remoteCodex.autoReloadRemoteWindow` to `false` to disable this behavior.

Toggle `AutoDL: Toggle Remote Codex Auto Install`, or set `autodl.remoteCodex.autoInstall`, to install Codex automatically after Connect.

The VS Code Remote - SSH extension should be installed for the remote window to open cleanly.

VS Code Remote SSH does not provide a reliable extension API for typing the password into its prompt. For hands-free login, run `AutoDL: Set SSH Public Key` before creating new instances. The extension injects that public key into `/root/.ssh/authorized_keys` through the create start command and writes the matching private key path into the managed SSH config.

## Repository Safety

This repository intentionally excludes build output, packaged VSIX files, npm cache files, local config, and `.env*` files. Do not commit AutoDL tokens, root passwords, SSH private keys, generated catalog caches, or personal SSH config contents.

## Empty State

If no token is configured, the AutoDL view shows Set Token and Quick Create actions. If a token is configured but there are no instances, it shows create actions. When instances exist, the view shows only the expanded instance list. Instance rows use readable GPU model names where known, not raw AutoDL spec ids.

## Development

```powershell
npm install
npm run compile
npm run package
```

## GitHub Actions Packaging

The CI workflow builds the VSIX on every push, pull request, or manual workflow run. Download `autodl-control-vsix` from the workflow run artifacts when you need a test package.

To publish a GitHub Release with the compiled VSIX attached, push a version tag:

```powershell
git tag v0.2.19
git push origin v0.2.19
```

The release job creates a GitHub Release for the tag, uploads the platform VSIX files, and uses the matching `CHANGELOG.md` section as the release notes.
