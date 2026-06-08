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
- `AutoDL: Refresh Instances`
- `AutoDL: Quick Create`
- `AutoDL: Quick Create Low`
- `AutoDL: Quick Create Mid`
- `AutoDL: Quick Create High`
- `AutoDL: Stop and Release All Active Instances`

Instance actions in the tree:

- Connect with Remote SSH
- Open Jupyter
- Stop Instance
- Release Instance

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

After quick-create or Connect, the extension:

1. Calls AutoDL snapshot for the instance.
2. Writes a managed host entry to `~/.ssh/config`.
3. Copies the root password to the clipboard.
4. Opens `vscode-remote://ssh-remote+autodl-<instance>/root`.

The VS Code Remote - SSH extension should be installed for the remote window to open cleanly.

## Development

```powershell
npm install
npm run compile
npm run package
```
