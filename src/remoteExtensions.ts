import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { copyManagedDirectoryToRemote, runManagedSshCommand } from "./ssh";

export interface RemoteExtensionInstallOptions {
  alias: string;
  extensionId: string;
  proxyUrl?: string;
  timeoutMs: number;
}

export interface RemoteExtensionInstallResult {
  status: "installed" | "serverNotReady";
  output: string;
}

export interface RemoteVsCodeServerStatus {
  ready: boolean;
  output: string;
}

interface LocalExtension {
  extensionPath: string;
  manifest: ExtensionManifest;
}

interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  __metadata?: Record<string, unknown>;
}

interface StagedExtension {
  root: string;
  directory: string;
  directoryName: string;
}

export async function installRemoteVsCodeExtension(
  options: RemoteExtensionInstallOptions,
): Promise<RemoteExtensionInstallResult> {
  const alias = validateAlias(options.alias);
  const extensionId = validateExtensionId(options.extensionId);
  const timeoutMs = Math.max(options.timeoutMs, 30_000);
  try {
    const result = await runManagedSshCommand(
      alias,
      remoteInstallScript(extensionId, options.proxyUrl),
      timeoutMs,
    );
    return {
      status: "installed",
      output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
    };
  } catch (error) {
    if (isRemoteVsCodeServerCliMissing(error)) {
      return {
        status: "serverNotReady",
        output: [
          `Remote VS Code Server CLI was not found on ${alias}; skipped extension install.`,
          "Open this AutoDL target with Remote SSH once, wait for VS Code Server initialization to finish, then run AutoDL: Prepare Remote Proxy and Codex again.",
          "No remote proxy settings write, local extension copy, upload, install verification, or remote window refresh was attempted.",
          `Original error: ${formatError(error)}`,
        ].join("\n"),
      };
    }
    const fallback = await installFromLocalExtensionCopy(alias, extensionId, timeoutMs);
    return {
      status: "installed",
      output: [
        `Marketplace install did not verify; fell back to local extension copy.`,
        `Original error: ${formatError(error)}`,
        fallback,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

export async function checkRemoteVsCodeServerReady(
  alias: string,
  timeoutMs: number,
): Promise<RemoteVsCodeServerStatus> {
  const safeAlias = validateAlias(alias);
  try {
    const result = await runManagedSshCommand(
      safeAlias,
      remoteServerCliProbeScript(),
      Math.max(timeoutMs, 30_000),
    );
    return {
      ready: true,
      output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
    };
  } catch (error) {
    if (!isRemoteVsCodeServerCliMissing(error)) {
      throw error;
    }
    return {
      ready: false,
      output: [
        `Remote VS Code Server CLI was not found on ${safeAlias}; skipped remote proxy settings and Codex install.`,
        "Open this AutoDL target with Remote SSH once, wait for VS Code Server initialization to finish, then run AutoDL: Prepare Remote Proxy and Codex again.",
        "No /root/.vscode-server/data/Machine/settings.json write, local extension copy, upload, install verification, or remote window refresh was attempted.",
        `Original error: ${formatError(error)}`,
      ].join("\n"),
    };
  }
}

function validateAlias(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("Remote SSH alias is invalid.");
  }
  return trimmed;
}

function validateExtensionId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    throw new Error("VS Code extension id must look like publisher.extension.");
  }
  return trimmed;
}

function remoteInstallScript(extensionId: string, proxyUrl: string | undefined): string {
  const quotedExtensionId = shellQuote(extensionId);
  return [
    "set -eu",
    remoteProxyExports(proxyUrl),
    `extension_id=${quotedExtensionId}`,
    "server_roots=\"${VSCODE_AGENT_FOLDER:-$HOME/.vscode-server} $HOME/.vscode-server $HOME/.vscode-server-insiders\"",
    "extensions_dir=\"$HOME/.vscode-server/extensions\"",
    "mkdir -p \"$extensions_dir\"",
    "find_code_cli() {",
    "  for root in $server_roots; do",
    "    [ -d \"$root\" ] || continue",
    "    for candidate in \\",
    "      \"$root/bin\"/*/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code-insiders \\",
    "      \"$root/cli/servers\"/*/server/bin/code; do",
    "      [ -f \"$candidate\" ] && printf '%s\\n' \"$candidate\"",
    "    done",
    "  done",
    "}",
    "code_cli=\"$(find_code_cli | sort -u | tail -n 1)\"",
    "if [ -z \"$code_cli\" ]; then",
    "  echo \"VS Code server CLI not found. Open the AutoDL target with Remote SSH once, then retry.\" >&2",
    "  echo \"Searched under: $server_roots\" >&2",
    "  exit 127",
    "fi",
    "echo \"Using remote VS Code server CLI: $code_cli\"",
    "\"$code_cli\" --extensions-dir \"$extensions_dir\" --install-extension \"$extension_id\" --force",
    "echo \"Remote extension list after install:\"",
    "extension_list=\"$(\"$code_cli\" --extensions-dir \"$extensions_dir\" --list-extensions | tr -d '\\r')\"",
    "printf '%s\\n' \"$extension_list\" | sort",
    "if ! printf '%s\\n' \"$extension_list\" | grep -Fxi -- \"$extension_id\" >/dev/null; then",
    `  echo "Extension ${extensionId} is not listed by remote code-server after install." >&2`,
    "  exit 1",
    "fi",
    "find_extension_dir() {",
    "  for root in $server_roots; do",
    "    [ -d \"$root/extensions\" ] || continue",
    "    find \"$root/extensions\" -maxdepth 1 -type d -iname \"$extension_id-*\" 2>/dev/null",
    "  done",
    "}",
    "extension_dir=\"$(find_extension_dir | sort -u | tail -n 1)\"",
    "if [ -z \"$extension_dir\" ]; then",
    `  echo "Extension ${extensionId} is listed but no matching directory was found under the VS Code server extension roots." >&2`,
    "  exit 1",
    "fi",
    "echo \"Verified remote extension directory: $extension_dir\"",
  ]
    .filter(Boolean)
    .join("\n");
}

function remoteServerCliProbeScript(): string {
  return [
    "set -eu",
    "server_roots=\"${VSCODE_AGENT_FOLDER:-$HOME/.vscode-server} $HOME/.vscode-server $HOME/.vscode-server-insiders\"",
    "find_code_cli() {",
    "  for root in $server_roots; do",
    "    [ -d \"$root\" ] || continue",
    "    for candidate in \\",
    "      \"$root/bin\"/*/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code-insiders \\",
    "      \"$root/cli/servers\"/*/server/bin/code; do",
    "      [ -f \"$candidate\" ] && printf '%s\\n' \"$candidate\"",
    "    done",
    "  done",
    "}",
    "code_cli=\"$(find_code_cli | sort -u | tail -n 1)\"",
    "if [ -z \"$code_cli\" ]; then",
    "  echo \"VS Code server CLI not found. Open the AutoDL target with Remote SSH once, then retry.\" >&2",
    "  echo \"Searched under: $server_roots\" >&2",
    "  exit 127",
    "fi",
    "echo \"Remote VS Code server CLI ready: $code_cli\"",
  ].join("\n");
}

async function installFromLocalExtensionCopy(
  alias: string,
  extensionId: string,
  timeoutMs: number,
): Promise<string> {
  const localExtension = await findLocalExtension(extensionId);
  const staged = await stageExtensionForLinux(localExtension);
  const remoteTempParent = `/tmp/autodl-vscode-${safeRemoteName(staged.directoryName)}-${Date.now()}`;
  try {
    await runManagedSshCommand(
      alias,
      `rm -rf ${shellQuote(remoteTempParent)} && mkdir -p ${shellQuote(remoteTempParent)}`,
      30_000,
    );
    const copyResult = await copyManagedDirectoryToRemote(
      alias,
      staged.directory,
      remoteTempParent,
      timeoutMs,
    );
    const finalizeResult = await runManagedSshCommand(
      alias,
      remoteCopyInstallScript(extensionId, staged.directoryName, remoteTempParent),
      Math.max(timeoutMs, 120_000),
    );
    return [
      `Copied local extension directory: ${localExtension.extensionPath}`,
      copyResult.stderr.trim(),
      finalizeResult.stdout.trim(),
      finalizeResult.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n");
  } finally {
    await fs.rm(staged.root, { recursive: true, force: true });
  }
}

async function findLocalExtension(extensionId: string): Promise<LocalExtension> {
  const fromVscode = vscode.extensions.getExtension(extensionId);
  if (fromVscode) {
    return {
      extensionPath: fromVscode.extensionPath,
      manifest: validateManifest(fromVscode.packageJSON, extensionId),
    };
  }

  const extensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  const matches: LocalExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(`${extensionId.toLowerCase()}-`)) {
      continue;
    }
    const extensionPath = path.join(extensionsRoot, entry.name);
    try {
      const raw = await fs.readFile(path.join(extensionPath, "package.json"), "utf8");
      const manifest = validateManifest(JSON.parse(raw), extensionId);
      matches.push({ extensionPath, manifest });
    } catch {
      // Ignore unrelated or partially removed extension directories.
    }
  }
  matches.sort((left, right) =>
    `${left.manifest.version}:${left.extensionPath}`.localeCompare(
      `${right.manifest.version}:${right.extensionPath}`,
    ),
  );
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(
      `Local extension ${extensionId} is not installed, so AutoDL cannot copy it to the remote fallback.`,
    );
  }
  return latest;
}

function validateManifest(value: unknown, extensionId: string): ExtensionManifest {
  const manifest = value as Partial<ExtensionManifest>;
  const actualId = `${manifest.publisher || ""}.${manifest.name || ""}`.toLowerCase();
  if (
    !manifest ||
    typeof manifest.name !== "string" ||
    typeof manifest.publisher !== "string" ||
    typeof manifest.version !== "string" ||
    actualId !== extensionId.toLowerCase()
  ) {
    throw new Error(`Local extension manifest does not match ${extensionId}.`);
  }
  return {
    ...(manifest as ExtensionManifest),
    __metadata:
      manifest.__metadata && typeof manifest.__metadata === "object"
        ? manifest.__metadata
        : {},
  };
}

async function stageExtensionForLinux(localExtension: LocalExtension): Promise<StagedExtension> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autodl-vscode-extension-"));
  const directoryName = `${localExtension.manifest.publisher}.${localExtension.manifest.name}-${localExtension.manifest.version}-linux-x64`;
  const directory = path.join(root, directoryName);
  await fs.cp(localExtension.extensionPath, directory, {
    recursive: true,
    filter: (source) => shouldCopyExtensionPath(localExtension.extensionPath, source),
  });
  await patchStagedManifest(directory, localExtension.manifest);
  return { root, directory, directoryName };
}

function shouldCopyExtensionPath(extensionRoot: string, source: string): boolean {
  const relative = toPosix(path.relative(extensionRoot, source));
  return !(
    relative === "bin/windows-x86_64" ||
    relative.startsWith("bin/windows-x86_64/") ||
    relative === "bin/darwin-x86_64" ||
    relative.startsWith("bin/darwin-x86_64/") ||
    relative === "bin/darwin-aarch64" ||
    relative.startsWith("bin/darwin-aarch64/")
  );
}

async function patchStagedManifest(
  stagedDirectory: string,
  manifest: ExtensionManifest,
): Promise<void> {
  const packageJsonPath = path.join(stagedDirectory, "package.json");
  const nextManifest = {
    ...manifest,
    __metadata: {
      ...(manifest.__metadata || {}),
      targetPlatform: "linux-x64",
    },
  };
  await fs.writeFile(packageJsonPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");

  const vsixManifestPath = path.join(stagedDirectory, ".vsixmanifest");
  try {
    const xml = await fs.readFile(vsixManifestPath, "utf8");
    const nextXml = xml.replace(/TargetPlatform="[^"]*"/, 'TargetPlatform="linux-x64"');
    await fs.writeFile(vsixManifestPath, nextXml, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function remoteCopyInstallScript(
  extensionId: string,
  directoryName: string,
  remoteTempParent: string,
): string {
  const [publisher, name] = extensionId.split(".");
  return [
    "set -eu",
    `extension_id=${shellQuote(extensionId)}`,
    `publisher=${shellQuote(publisher)}`,
    `name=${shellQuote(name)}`,
    `directory_name=${shellQuote(directoryName)}`,
    `remote_temp_parent=${shellQuote(remoteTempParent)}`,
    "extension_source=\"$remote_temp_parent/$directory_name\"",
    "server_roots=\"${VSCODE_AGENT_FOLDER:-$HOME/.vscode-server} $HOME/.vscode-server $HOME/.vscode-server-insiders\"",
    "extensions_dir=\"$HOME/.vscode-server/extensions\"",
    "if [ ! -d \"$extension_source\" ]; then",
    "  echo \"Copied extension directory was not found: $extension_source\" >&2",
    "  exit 1",
    "fi",
    "mkdir -p \"$extensions_dir\"",
    "rm -rf \"$extensions_dir/$directory_name\"",
    "mv \"$extension_source\" \"$extensions_dir/$directory_name\"",
    "rm -rf \"$remote_temp_parent\"",
    "chmod -R u+rwX \"$extensions_dir/$directory_name\"",
    "if [ -d \"$extensions_dir/$directory_name/bin/linux-x86_64\" ]; then",
    "  find \"$extensions_dir/$directory_name/bin/linux-x86_64\" -type f -exec chmod u+x {} +",
    "fi",
    "package_file=\"$extensions_dir/$directory_name/package.json\"",
    "if ! grep -Eq '\"publisher\"[[:space:]]*:[[:space:]]*\"'\"$publisher\"'\"' \"$package_file\"; then",
    "  echo \"Copied extension package publisher does not match $publisher.\" >&2",
    "  exit 1",
    "fi",
    "if ! grep -Eq '\"name\"[[:space:]]*:[[:space:]]*\"'\"$name\"'\"' \"$package_file\"; then",
    "  echo \"Copied extension package name does not match $name.\" >&2",
    "  exit 1",
    "fi",
    "find_code_cli() {",
    "  for root in $server_roots; do",
    "    [ -d \"$root\" ] || continue",
    "    for candidate in \\",
    "      \"$root/bin\"/*/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/code-server \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code \\",
    "      \"$root/cli/servers\"/*/server/bin/remote-cli/code-insiders \\",
    "      \"$root/cli/servers\"/*/server/bin/code; do",
    "      [ -f \"$candidate\" ] && printf '%s\\n' \"$candidate\"",
    "    done",
    "  done",
    "}",
    "find_node_cli() {",
    "  for root in $server_roots; do",
    "    [ -d \"$root\" ] || continue",
    "    for candidate in \\",
    "      \"$root/bin\"/*/node \\",
    "      \"$root/cli/servers\"/*/server/node; do",
    "      [ -f \"$candidate\" ] && printf '%s\\n' \"$candidate\"",
    "    done",
    "  done",
    "}",
    "node_cli=\"$(find_node_cli | sort -u | tail -n 1)\"",
    "if [ -n \"$node_cli\" ]; then",
    "  \"$node_cli\" - \"$extensions_dir\" \"$directory_name\" \"$extension_id\" <<'NODE'",
    "const fs = require('fs');",
    "const path = require('path');",
    "const [extensionsDir, directoryName, extensionId] = process.argv.slice(2);",
    "const packagePath = path.posix.join(extensionsDir, directoryName, 'package.json');",
    "const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));",
    "const metadata = { ...(packageJson.__metadata || {}) };",
    "metadata.targetPlatform = 'linux-x64';",
    "metadata.source = metadata.source || 'gallery';",
    "metadata.pinned = Boolean(metadata.pinned);",
    "metadata.updated = metadata.updated !== false;",
    "metadata.private = Boolean(metadata.private);",
    "metadata.isPreReleaseVersion = Boolean(metadata.isPreReleaseVersion || metadata.preRelease);",
    "metadata.hasPreReleaseVersion = Boolean(metadata.hasPreReleaseVersion);",
    "const extensionsJsonPath = path.posix.join(extensionsDir, 'extensions.json');",
    "let entries = [];",
    "try {",
    "  const raw = fs.readFileSync(extensionsJsonPath, 'utf8').trim();",
    "  entries = raw ? JSON.parse(raw) : [];",
    "} catch {",
    "  entries = [];",
    "}",
    "if (!Array.isArray(entries)) entries = [];",
    "const extensionPath = path.posix.join(extensionsDir, directoryName);",
    "const entry = {",
    "  identifier: {",
    "    id: extensionId,",
    "    ...(typeof metadata.id === 'string' ? { uuid: metadata.id } : {}),",
    "  },",
    "  version: packageJson.version,",
    "  location: { $mid: 1, path: extensionPath, scheme: 'file' },",
    "  relativeLocation: directoryName,",
    "  metadata,",
    "};",
    "const next = entries.filter((item) => item && item.identifier && String(item.identifier.id).toLowerCase() !== extensionId.toLowerCase());",
    "next.push(entry);",
    "fs.writeFileSync(extensionsJsonPath, JSON.stringify(next));",
    "NODE",
    "else",
    "  echo \"VS Code server node was not found; copied extension metadata could not be written.\" >&2",
    "fi",
    "code_cli=\"$(find_code_cli | sort -u | tail -n 1)\"",
    "if [ -n \"$code_cli\" ]; then",
    "  extension_list=\"$(\"$code_cli\" --extensions-dir \"$extensions_dir\" --list-extensions | tr -d '\\r')\"",
    "  if ! printf '%s\\n' \"$extension_list\" | grep -Fxi -- \"$extension_id\" >/dev/null; then",
    "    echo \"Copied extension exists but is not listed by code-server yet. Reload the Remote SSH window if it is not visible immediately.\" >&2",
    "  fi",
    "fi",
    "echo \"Verified copied remote extension directory: $extensions_dir/$directory_name\"",
  ].join("\n");
}

function remoteProxyExports(proxyUrl: string | undefined): string {
  if (!proxyUrl) {
    return "";
  }
  const quoted = shellQuote(proxyUrl);
  return [
    `export HTTP_PROXY=${quoted}`,
    `export HTTPS_PROXY=${quoted}`,
    `export ALL_PROXY=${quoted}`,
    `export http_proxy=${quoted}`,
    `export https_proxy=${quoted}`,
    `export all_proxy=${quoted}`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function safeRemoteName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function isRemoteVsCodeServerCliMissing(error: unknown): boolean {
  const message = formatError(error);
  return (
    message.includes("VS Code server CLI not found") ||
    message.includes("VS Code Server CLI was not found")
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
