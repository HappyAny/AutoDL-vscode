# Contributing

## Local Setup

```powershell
npm install
npm run compile
npm run package
```

Use `.\scripts\install.ps1` to build and install the local VSIX into VS Code.

## Development Notes

- Keep AutoDL tokens and SSH credentials out of the repository.
- Do not commit `out/`, `dist/`, `node_modules/`, `.npm-cache/`, or `.env*` files.
- Prefer small, focused changes with a fresh `npm run package` before committing.
- The extension stores AutoDL tokens in VS Code SecretStorage. `AUTODL_TOKEN` is only a local fallback.
- AutoDL managed SSH config blocks are bounded by `# >>> autodl-vscode ...` markers.

## Pull Request Checklist

- `npm run package` passes.
- `git diff --check` passes.
- README or CHANGELOG is updated when user-visible behavior changes.
- No API tokens, root passwords, private keys, instance UUIDs, or personal hostnames are committed.
