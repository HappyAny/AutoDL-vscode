#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSIX="$ROOT/dist/autodl-control.vsix"

if command -v code >/dev/null 2>&1; then
  CODE_COMMAND="code"
elif command -v code-insiders >/dev/null 2>&1; then
  CODE_COMMAND="code-insiders"
else
  echo "Cannot find VS Code CLI. Install VS Code or add the 'code' command to PATH." >&2
  exit 1
fi

cd "$ROOT"
npm install
npm run package
"$CODE_COMMAND" --install-extension "$VSIX" --force
echo "Installed AutoDL Control from $VSIX"
