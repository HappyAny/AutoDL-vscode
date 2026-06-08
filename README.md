# AutoDL Control for VS Code

VS Code extension for controlling AutoDL Pro instances from the Activity Bar.

## Fast Install

From this directory:

```powershell
.\scripts\install.ps1
```

The script runs `npm install`, builds `dist\autodl-control.vsix`, and installs it into VS Code with `code --install-extension`.

Manual install:

```powershell
npm install
npm run package
code --install-extension .\dist\autodl-control.vsix --force
```

## Usage

Open the AutoDL icon in the VS Code Activity Bar.

Commands:

- `AutoDL: Set Token`
- `AutoDL: Set SSH Public Key`
- `AutoDL: Clean SSH Config`
- `AutoDL: Refresh Instances`
- `AutoDL: Refresh GPU and Image Catalogs` - update cached GPU specs, public images, and private images
- `AutoDL: Quick Create`
- `AutoDL: Select Server` - choose GPU model, GPU count, image, CUDA, extra system storage, data centers, name, and start command
- `AutoDL: Quick Create Low`
- `AutoDL: Quick Create Mid`
- `AutoDL: Quick Create High`
- `AutoDL: Stop and Release All Active Instances`

Instance actions in the tree:

- Running instances: Connect with Remote SSH, Open Jupyter, Shutdown Instance, Release Instance
- Shutdown instances: Turn On Instance, Release Instance

When an instance is released through the extension, its managed `Host autodl-<instance>` SSH config block is removed. Use `AutoDL: Clean SSH Config` to remove all stale AutoDL-managed blocks.

The GPU and image catalogs are cached in VS Code global storage. Use the cloud-download icon in the AutoDL view title to refresh them from the AutoDL API docs and your private image list.

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

## Remote SSH Behavior

Quick Create and Select Server only create the instance and refresh the list. They do not automatically connect, because the instance may not be fully ready yet.

When Connect is clicked, the extension:

1. Calls AutoDL snapshot for the instance.
2. Writes a managed host entry to `~/.ssh/config`.
3. Copies the root password to the clipboard.
4. Opens `vscode-remote://ssh-remote+autodl-<instance>/root`.

The VS Code Remote - SSH extension should be installed for the remote window to open cleanly.

VS Code Remote SSH does not provide a reliable extension API for typing the password into its prompt. For hands-free login, run `AutoDL: Set SSH Public Key` before creating new instances. The extension injects that public key into `/root/.ssh/authorized_keys` through the create start command and writes the matching private key path into the managed SSH config.

## Empty State

If no token is configured, the AutoDL view shows Set Token and Quick Create actions. If a token is configured but there are no instances, it shows create actions. When instances exist, the view shows only the expanded instance list. Instance rows use readable GPU model names where known, not raw AutoDL spec ids.

## Development

```powershell
npm install
npm run compile
npm run package
```
