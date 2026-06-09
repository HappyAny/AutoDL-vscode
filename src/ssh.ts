import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { AutoDLSnapshot } from "./types";

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
  identityFile?: string,
): Promise<string> {
  const alias = await writeManagedSshHost(instanceUuid, snapshot, identityFile);
  const remoteUri = vscode.Uri.parse(
    `vscode-remote://ssh-remote+${alias}${encodeRemotePath(remotePath)}`,
  );

  output.show(true);
  output.appendLine("");
  output.appendLine(formatSnapshotSummary(instanceUuid, snapshot));
  output.appendLine("");
  output.appendLine(`SSH config host alias: ${alias}`);

  if (snapshot.root_password) {
    await vscode.env.clipboard.writeText(snapshot.root_password);
    output.appendLine("Root password copied to clipboard.");
  }
  if (identityFile) {
    output.appendLine(`Using SSH identity file: ${identityFile}`);
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

export async function writeManagedSshHost(
  instanceUuid: string,
  snapshot: AutoDLSnapshot,
  identityFile?: string,
): Promise<string> {
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

function encodeRemotePath(remotePath: string): string {
  const value = remotePath.trim() || "/root";
  const normalized = value.startsWith("/") ? value : `/${value}`;
  return encodeURI(normalized);
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
