import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import * as vscode from "vscode";

import { AutoDLSnapshot } from "./types";

export interface RemoteForwardConfig {
  remotePort: number;
  localHost: string;
  localPort: number;
}

export interface ManagedSshHostOptions {
  identityFile?: string;
  remoteForward?: RemoteForwardConfig;
}

export interface RemoteSettingsToggleResult {
  settingsPath: string;
  action: "enabled" | "disabled";
}

export interface RemoteSettingsEnsureResult {
  settingsPath: string;
  action: "written" | "skipped";
}

export function jupyterUrl(snapshot: AutoDLSnapshot): string | undefined {
  if (!snapshot.jupyter_domain) {
    return undefined;
  }
  const base = `https://${snapshot.jupyter_domain}`;
  return snapshot.jupyter_token ? `${base}/?token=${encodeURIComponent(snapshot.jupyter_token)}` : base;
}

export function serviceUrl(domain: string | undefined, protocol: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }
  return `${protocol || "http"}://${domain}`;
}

export function formatSnapshotSummary(
  instanceUuid: string,
  snapshot: AutoDLSnapshot,
): string {
  const usage = snapshot.usage_info || {};
  const lines = [
    `Instance: ${instanceUuid}`,
    `GPU: ${snapshot.snapshot_gpu_alias_name || ""}`,
    `Region: ${snapshot.region_sign || ""}`,
    `Price: payg=${snapshot.payg_price ?? ""}, origin=${snapshot.origin_pay_price ?? ""}`,
    `CPU: ${snapshot.chip_corp || ""} ${snapshot.cpu_arch || ""}`.trim(),
    `SSH: ${snapshot.ssh_command || ""}`,
    `SSH host: ${snapshot.proxy_host || ""}`,
    `SSH port: ${snapshot.ssh_port ?? ""}`,
    `Root password: ${snapshot.root_password || ""}`,
    `Jupyter: ${jupyterUrl(snapshot) || ""}`,
    `Jupyter token: ${snapshot.jupyter_token || ""}`,
    `Service 6006: ${serviceUrl(snapshot.service_6006_domain, snapshot.service_6006_port_protocol) || ""}`,
    `Service 6008: ${serviceUrl(snapshot.service_6008_domain, snapshot.service_6008_port_protocol) || ""}`,
    `Container: ${usage.container_id || ""}`,
    `Usage: cpu=${usage.cpu_usage_percent ?? ""}%, mem=${usage.mem_usage_percent ?? ""}% (${formatBytes(usage.mem_usage)} / ${formatBytes(usage.mem_limit)})`,
    `Root FS: ${formatBytes(usage.root_fs_used_size)} / ${formatBytes(usage.root_fs_total_size)}`,
    `Data disk: ${formatBytes(usage.data_disk_used_size)} / ${formatBytes(usage.data_disk_total_size)}`,
    `Image progress: pull=${usage.pull_image_progress ?? ""}, download=${usage.download_image_progress ?? ""}`,
    `Usage valid: ${usage.valid ?? ""}`,
    `Valid at: ${usage.valid_at || ""}`,
  ];
  return lines.join("\n");
}

export async function connectWithRemoteSsh(
  instanceUuid: string,
  snapshot: AutoDLSnapshot,
  remotePath: string,
  output: vscode.OutputChannel,
  options: ManagedSshHostOptions = {},
): Promise<string> {
  const alias = await writeManagedSshHost(instanceUuid, snapshot, options);
  const remoteUri = remoteSshUri(alias, remotePath);

  output.show(true);
  output.appendLine("");
  output.appendLine(formatSnapshotSummary(instanceUuid, snapshot));
  output.appendLine("");
  output.appendLine(`SSH config host alias: ${alias}`);

  if (snapshot.root_password) {
    await vscode.env.clipboard.writeText(snapshot.root_password);
    output.appendLine("Root password copied to clipboard.");
  }
  if (options.identityFile) {
    output.appendLine(`Using SSH identity file: ${options.identityFile}`);
  }
  if (options.remoteForward) {
    output.appendLine(
      `Remote proxy forward: ${options.remoteForward.remotePort} -> ${options.remoteForward.localHost}:${options.remoteForward.localPort}`,
    );
  }

  if (!vscode.extensions.getExtension("ms-vscode-remote.remote-ssh")) {
    void vscode.window.showWarningMessage(
      "VS Code Remote - SSH extension is not installed. Install it if the remote window does not open.",
    );
  }

  await vscode.commands.executeCommand("vscode.openFolder", remoteUri, {
    forceNewWindow: true,
  });
  return alias;
}

export async function removeRecentlyOpenedRemoteSshEntries(
  instanceUuid: string,
  remotePaths: string | readonly string[],
  output?: vscode.OutputChannel,
): Promise<void> {
  const alias = sshAlias(instanceUuid);
  const requestedPaths = typeof remotePaths === "string" ? [remotePaths] : remotePaths;
  const pathCandidates = [
    ...new Set(
      [...requestedPaths, "/root"].map((value) => value.trim()).filter(Boolean),
    ),
  ];

  for (const pathCandidate of pathCandidates) {
    const remoteUri = remoteSshUri(alias, pathCandidate);
    try {
      await vscode.commands.executeCommand("vscode.removeFromRecentlyOpened", remoteUri);
    } catch (error) {
      output?.appendLine(
        `Warning: failed to remove VS Code recent entry ${remoteUri.toString()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export async function writeManagedSshHost(
  instanceUuid: string,
  snapshot: AutoDLSnapshot,
  optionsOrIdentityFile: ManagedSshHostOptions | string = {},
): Promise<string> {
  const options =
    typeof optionsOrIdentityFile === "string"
      ? { identityFile: optionsOrIdentityFile }
      : optionsOrIdentityFile;
  const identityFile = options.identityFile;
  const remoteForward = options.remoteForward
    ? normalizeRemoteForward(options.remoteForward)
    : undefined;
  const host = sanitizeConfigValue(snapshot.proxy_host, "proxy_host");
  const port = Number(snapshot.ssh_port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Snapshot does not contain a valid ssh_port.");
  }

  const alias = sshAlias(instanceUuid);
  const sshDir = path.join(os.homedir(), ".ssh");
  const configPath = path.join(sshDir, "config");
  await fs.mkdir(sshDir, { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const block = [
    `# >>> autodl-vscode ${alias}`,
    `Host ${alias}`,
    `  HostName ${host}`,
    "  User root",
    `  Port ${port}`,
    "  PreferredAuthentications publickey,password",
    "  PasswordAuthentication yes",
    `  HostKeyAlias ${alias}`,
    "  StrictHostKeyChecking no",
    "  CheckHostIP no",
    "  UpdateHostKeys no",
    "  UserKnownHostsFile ~/.ssh/autodl-vscode-known_hosts",
    ...(identityFile ? [`  IdentityFile ${quoteSshConfigValue(identityFile)}`] : []),
    ...(identityFile ? ["  IdentitiesOnly yes"] : []),
    ...(remoteForward
      ? [
          `  RemoteForward ${remoteForward.remotePort} ${remoteForward.localHost}:${remoteForward.localPort}`,
        ]
      : []),
    `# <<< autodl-vscode ${alias}`,
    "",
  ].join("\n");

  const pattern = new RegExp(
    `\\n?# >>> autodl-vscode ${escapeRegExp(alias)}[\\s\\S]*?# <<< autodl-vscode ${escapeRegExp(alias)}\\n?`,
    "m",
  );
  const withoutOldBlock = existing.replace(pattern, "\n").trimEnd();
  const next = `${block}${withoutOldBlock ? `\n${withoutOldBlock}` : ""}`;
  await fs.writeFile(configPath, next, "utf8");
  return alias;
}

export async function writeRemoteVsCodeSettings(
  alias: string,
  values: Record<string, unknown>,
): Promise<string> {
  const settingsPath = "/root/.vscode-server/data/Machine/settings.json";
  const existing = await readRemoteFile(alias, settingsPath);
  const parsed = parseRemoteSettings(existing);
  const next = `${JSON.stringify({ ...parsed, ...values }, null, 2)}\n`;
  await writeRemoteFile(alias, settingsPath, next);
  return settingsPath;
}

export async function ensureRemoteVsCodeSettings(
  alias: string,
  values: Record<string, unknown>,
): Promise<RemoteSettingsEnsureResult> {
  const settingsPath = "/root/.vscode-server/data/Machine/settings.json";
  const existing = await readRemoteFile(alias, settingsPath);
  const parsed = parseRemoteSettings(existing);
  const keys = Object.keys(values);
  const alreadyWritten = keys.every((key) => sameJsonValue(parsed[key], values[key]));

  if (alreadyWritten) {
    return {
      settingsPath,
      action: "skipped",
    };
  }

  const next = `${JSON.stringify({ ...parsed, ...values }, null, 2)}\n`;
  await writeRemoteFile(alias, settingsPath, next);
  return {
    settingsPath,
    action: "written",
  };
}

export async function toggleRemoteVsCodeSettings(
  alias: string,
  values: Record<string, unknown>,
): Promise<RemoteSettingsToggleResult> {
  const settingsPath = "/root/.vscode-server/data/Machine/settings.json";
  const existing = await readRemoteFile(alias, settingsPath);
  const parsed = parseRemoteSettings(existing);
  const keys = Object.keys(values);
  const currentlyEnabled = keys.every((key) => sameJsonValue(parsed[key], values[key]));

  if (currentlyEnabled) {
    for (const key of keys) {
      delete parsed[key];
    }
  } else {
    Object.assign(parsed, values);
  }

  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  await writeRemoteFile(alias, settingsPath, next);
  return {
    settingsPath,
    action: currentlyEnabled ? "disabled" : "enabled",
  };
}

export function runManagedSshCommand(
  alias: string,
  command: string,
  timeoutMs: number,
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return runSshCommand(alias, command, input, timeoutMs);
}

export function copyManagedDirectoryToRemote(
  alias: string,
  localDirectory: string,
  remoteParentDirectory: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return runScpDirectory(alias, localDirectory, remoteParentDirectory, timeoutMs);
}

export async function removeManagedSshHost(instanceUuid: string): Promise<boolean> {
  return removeManagedSshBlock(sshAlias(instanceUuid));
}

export async function removeAllManagedSshHosts(): Promise<number> {
  const configPath = sshConfigPath();
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  const next = existing.replace(
    /\n?# >>> autodl-vscode [^\n]+[\s\S]*?# <<< autodl-vscode [^\n]+\n?/g,
    () => {
      removed += 1;
      return "\n";
    },
  ).trimEnd();
  if (removed > 0) {
    await fs.writeFile(configPath, `${next}${next ? "\n" : ""}`, "utf8");
  }
  return removed;
}

export function sshAlias(instanceUuid: string): string {
  return `autodl-${instanceUuid.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

async function removeManagedSshBlock(alias: string): Promise<boolean> {
  const configPath = sshConfigPath();
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const pattern = new RegExp(
    `\\n?# >>> autodl-vscode ${escapeRegExp(alias)}[\\s\\S]*?# <<< autodl-vscode ${escapeRegExp(alias)}\\n?`,
    "m",
  );
  if (!pattern.test(existing)) {
    return false;
  }
  const next = existing.replace(pattern, "\n").trimEnd();
  await fs.writeFile(configPath, `${next}${next ? "\n" : ""}`, "utf8");
  return true;
}

function sshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

function normalizeRemoteForward(value: RemoteForwardConfig): RemoteForwardConfig {
  const remotePort = Number(value.remotePort);
  const localPort = Number(value.localPort);
  if (
    !Number.isInteger(remotePort) ||
    remotePort <= 0 ||
    remotePort > 65535 ||
    !Number.isInteger(localPort) ||
    localPort <= 0 ||
    localPort > 65535
  ) {
    throw new Error("RemoteForward ports must be integers between 1 and 65535.");
  }
  const localHost = sanitizeConfigValue(value.localHost, "remoteForward.localHost");
  return { remotePort, localHost, localPort };
}

async function readRemoteFile(alias: string, remotePath: string): Promise<string> {
  const command = `test -f ${quoteRemotePath(remotePath)} && cat ${quoteRemotePath(remotePath)} || true`;
  const result = await runSshCommand(alias, command, undefined, 15_000);
  return result.stdout;
}

async function writeRemoteFile(
  alias: string,
  remotePath: string,
  content: string,
): Promise<void> {
  const directory = path.posix.dirname(remotePath);
  const command = `umask 077 && mkdir -p ${quoteRemotePath(directory)} && cat > ${quoteRemotePath(remotePath)}`;
  await runSshCommand(alias, command, content, 15_000);
}

function parseRemoteSettings(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Remote VS Code settings must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Remote VS Code settings are not valid JSON; open Remote Settings JSON and fix it first. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runSshCommand(
  alias: string,
  command: string,
  input: string | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "CheckHostIP=no",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ExitOnForwardFailure=no",
        "-o",
        `HostKeyAlias=${alias}`,
        "-o",
        `UserKnownHostsFile=${toPosixPath(
          path.join(os.homedir(), ".ssh", "autodl-vscode-known_hosts"),
        )}`,
        alias,
        command,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ssh timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const cleanedStderr = cleanSshCommandStderr(stderr);
      if (code && code !== 0) {
        const details = [cleanedStderr, stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(`ssh failed: ${details || `exit code ${code}`}`));
        return;
      }
      resolve({ stdout, stderr: cleanedStderr });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

function runScpDirectory(
  alias: string,
  localDirectory: string,
  remoteParentDirectory: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const sourceParent = path.dirname(localDirectory);
    const sourceName = path.basename(localDirectory);
    const remoteParent = remoteParentDirectory.replace(/\/+$/, "");
    const tar = cp.spawn("tar", ["-czf", "-", "-C", sourceParent, sourceName], {
      windowsHide: true,
    });
    const ssh = cp.spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "CheckHostIP=no",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        `HostKeyAlias=${alias}`,
        "-o",
        `UserKnownHostsFile=${toPosixPath(
          path.join(os.homedir(), ".ssh", "autodl-vscode-known_hosts"),
        )}`,
        alias,
        `mkdir -p ${shellQuote(remoteParent)} && tar -xzf - -C ${shellQuote(remoteParent)}`,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      tar.kill();
      ssh.kill();
      finish(new Error(`extension copy timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (error: Error | undefined, result?: { stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result || { stdout, stderr: cleanSshCommandStderr(stderr) });
      }
    };

    ssh.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    ssh.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    tar.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const tarDone = waitForProcess(tar, "tar");
    const sshDone = waitForProcess(ssh, "ssh");
    pipeline(tar.stdout!, ssh.stdin!)
      .then(() => Promise.all([tarDone, sshDone]))
      .then(() => {
        finish(undefined, { stdout, stderr: cleanSshCommandStderr(stderr) });
      })
      .catch((error) => {
        tar.kill();
        ssh.kill();
        finish(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function waitForProcess(child: cp.ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(`${label} failed with exit code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

function cleanSshCommandStderr(value: string): string {
  return value
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^Warning: remote port forwarding failed for listen port \d+\.?$/.test(
          line.trim(),
        ),
    )
    .join("\n")
    .trim();
}

function encodeRemotePath(remotePath: string): string {
  const value = remotePath.trim() || "/root";
  const normalized = value.startsWith("/") ? value : `/${value}`;
  return encodeURI(normalized);
}

export function remoteSshUri(alias: string, remotePath: string): vscode.Uri {
  return vscode.Uri.parse(
    `vscode-remote://ssh-remote+${alias}${encodeRemotePath(remotePath)}`,
  );
}

function quoteRemotePath(value: string): string {
  return shellQuote(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sanitizeConfigValue(value: string | undefined, fieldName: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Snapshot does not contain a valid ${fieldName}.`);
  }
  return value.trim();
}

function quoteSshConfigValue(value: string): string {
  const trimmed = sanitizeConfigValue(value, "identityFile");
  return trimmed.includes(" ") ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "";
  }
  if (value === 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}
