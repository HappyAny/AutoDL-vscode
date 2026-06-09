import * as cp from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Transform, TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as vscode from "vscode";

export interface FolderSyncConfig {
  enabled: boolean;
  localFolder: string;
  remoteFolder: string;
  intervalMs: number;
  excludeNames: string[];
}

export interface FolderSyncStartOptions {
  alias: string;
  localFolder: string;
  remoteFolder: string;
  intervalMs: number;
  excludeNames: string[];
  output: vscode.OutputChannel;
}

export interface FolderUploadOptions {
  alias: string;
  localFolder: string;
  remoteFolder: string;
  excludeNames: string[];
  output: vscode.OutputChannel;
}

interface FileRecord {
  mtimeMs: number;
  size: number;
}

interface SyncedRecord {
  local?: FileRecord;
  remote?: FileRecord;
}

interface SyncCounters {
  uploads: number;
  downloads: number;
  conflicts: number;
}

interface SyncContext {
  alias: string;
  localFolder: string;
  remoteFolder: string;
  excludeNames: Set<string>;
  output: vscode.OutputChannel;
  operationLabel: string;
  statusLabel: string;
  progressBaseBytes?: number;
  progressTotalBytes?: number;
}

interface SyncSession extends SyncContext {
  intervalMs: number;
  previous: Map<string, SyncedRecord>;
  running: boolean;
  disposed: boolean;
  activeChildren: Set<cp.ChildProcess>;
  timer: ReturnType<typeof setInterval>;
}

const sessions = new Map<string, SyncSession>();
let statusBarItem: vscode.StatusBarItem | undefined;

export async function startFolderSync(options: FolderSyncStartOptions): Promise<void> {
  const localFolder = expandHome(options.localFolder);
  await ensureExistingDirectory(localFolder);

  stopFolderSync(options.alias);
  const session: SyncSession = {
    alias: options.alias,
    localFolder,
    remoteFolder: normalizeRemoteFolder(options.remoteFolder),
    intervalMs: Math.max(options.intervalMs, 3_000),
    excludeNames: new Set(options.excludeNames.filter(Boolean)),
    output: options.output,
    operationLabel: "Folder sync",
    statusLabel: "AutoDL Sync",
    previous: new Map(),
    running: false,
    disposed: false,
    activeChildren: new Set(),
    timer: setInterval(() => {
      void runSyncCycle(session);
    }, Math.max(options.intervalMs, 3_000)),
  };

  sessions.set(options.alias, session);
  options.output.show(true);
  options.output.appendLine("");
  options.output.appendLine(
    `Folder sync started: ${localFolder} <-> ${options.alias}:${session.remoteFolder}`,
  );
  updateIdleStatus();
  void runSyncCycle(session);
}

export async function uploadFolderOnce(options: FolderUploadOptions): Promise<void> {
  const localFolder = expandHome(options.localFolder);
  await ensureExistingDirectory(localFolder);

  const context: SyncContext = {
    alias: options.alias,
    localFolder,
    remoteFolder: normalizeRemoteFolder(options.remoteFolder),
    excludeNames: new Set(options.excludeNames.filter(Boolean)),
    output: options.output,
    operationLabel: "Folder upload",
    statusLabel: "AutoDL Upload",
  };

  try {
    context.output.show(true);
    context.output.appendLine("");
    context.output.appendLine(
      `Folder upload started: ${localFolder} -> ${context.alias}:${context.remoteFolder}`,
    );

    updateStatus(`$(sync~spin) AutoDL Upload: scanning ${context.alias}`);
    await runSsh(context.alias, `mkdir -p ${quoteRemotePath(context.remoteFolder)}`, 30_000);
    const local = await scanLocal(context.localFolder, context.excludeNames);
    const entries = [...local.entries()].sort(([left], [right]) => left.localeCompare(right));
    const totalBytes = entries.reduce((sum, [, record]) => sum + record.size, 0);

    if (!entries.length) {
      context.output.appendLine(`Folder upload ${context.alias}: no files to upload.`);
      return;
    }

    let completedBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const [relativePath, record] = entries[index];
      context.progressBaseBytes = completedBytes;
      context.progressTotalBytes = totalBytes;
      updateTransferStatus(context, "upload", completedBytes, totalBytes);
      await uploadFile(context, relativePath, relativePath, record.size);
      completedBytes += record.size;
    }

    context.output.appendLine(
      `Folder upload completed: ${context.alias}, ${entries.length} file(s), ${formatBytes(totalBytes)}`,
    );
  } finally {
    updateIdleStatus();
  }
}

export function stopFolderSync(alias: string): boolean {
  const session = sessions.get(alias);
  if (!session) {
    return false;
  }
  session.disposed = true;
  clearInterval(session.timer);
  sessions.delete(alias);
  for (const child of [...session.activeChildren]) {
    try {
      child.kill();
    } catch {
      // Best-effort cancellation for in-flight ssh commands.
    }
  }
  session.output.appendLine(`Folder sync stopped: ${alias}`);
  updateIdleStatus();
  return true;
}

export function stopAllFolderSync(): number {
  let stopped = 0;
  for (const alias of [...sessions.keys()]) {
    if (stopFolderSync(alias)) {
      stopped += 1;
    }
  }
  return stopped;
}

export function activeFolderSyncAliases(): string[] {
  return [...sessions.keys()];
}

async function runSyncCycle(session: SyncSession): Promise<void> {
  if (session.running || session.disposed) {
    return;
  }
  session.running = true;
  try {
    updateStatus(`$(sync~spin) AutoDL Sync: scanning ${session.alias}`);
    await runSsh(session, `mkdir -p ${quoteRemotePath(session.remoteFolder)}`, 30_000);
    throwIfDisposed(session);
    const local = await scanLocal(session.localFolder, session.excludeNames, () => session.disposed);
    throwIfDisposed(session);
    const remote = await scanRemote(session, session.remoteFolder, session.excludeNames);
    throwIfDisposed(session);
    const counters = await reconcile(session, local, remote);
    throwIfDisposed(session);
    const finalLocal = await scanLocal(
      session.localFolder,
      session.excludeNames,
      () => session.disposed,
    );
    throwIfDisposed(session);
    const finalRemote = await scanRemote(session, session.remoteFolder, session.excludeNames);
    session.previous = buildSyncedState(finalLocal, finalRemote);
    if (counters.uploads || counters.downloads || counters.conflicts) {
      session.output.appendLine(
        `Folder sync ${session.alias}: upload=${counters.uploads}, download=${counters.downloads}, conflict=${counters.conflicts}`,
      );
    }
  } catch (error) {
    if (session.disposed) {
      return;
    }
    session.output.show(true);
    session.output.appendLine(
      `Folder sync error (${session.alias}): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    session.running = false;
    updateIdleStatus();
  }
}

async function reconcile(
  session: SyncSession,
  local: Map<string, FileRecord>,
  remote: Map<string, FileRecord>,
): Promise<SyncCounters> {
  const counters: SyncCounters = { uploads: 0, downloads: 0, conflicts: 0 };
  const allRelativePaths = new Set([...local.keys(), ...remote.keys()]);
  const total = allRelativePaths.size;
  let checked = 0;

  for (const relativePath of [...allRelativePaths].sort()) {
    throwIfDisposed(session);
    checked += 1;
    updateStatus(
      `$(sync~spin) AutoDL Sync: ${checked}/${total}`,
      `${session.alias}\nChecking ${relativePath}`,
    );
    const localRecord = local.get(relativePath);
    const remoteRecord = remote.get(relativePath);
    const previous = session.previous.get(relativePath);

    if (localRecord && !remoteRecord) {
      await uploadFile(session, relativePath, relativePath, localRecord.size);
      counters.uploads += 1;
      continue;
    }

    if (!localRecord && remoteRecord) {
      await downloadFile(session, relativePath, relativePath, remoteRecord.size);
      counters.downloads += 1;
      continue;
    }

    if (!localRecord || !remoteRecord || sameRecord(localRecord, remoteRecord)) {
      continue;
    }

    if (!previous) {
      const conflictPath = conflictRelativePath(
        relativePath,
        localRecord.mtimeMs >= remoteRecord.mtimeMs ? "local" : "remote",
      );
      if (localRecord.mtimeMs >= remoteRecord.mtimeMs) {
        await uploadFile(session, relativePath, conflictPath, localRecord.size);
      } else {
        await downloadFile(session, relativePath, conflictPath, remoteRecord.size);
      }
      counters.conflicts += 1;
      continue;
    }

    const localChanged = !previous.local || !sameRecord(localRecord, previous.local);
    const remoteChanged = !previous.remote || !sameRecord(remoteRecord, previous.remote);

    if (localChanged && !remoteChanged) {
      await uploadFile(session, relativePath, relativePath, localRecord.size);
      counters.uploads += 1;
      continue;
    }

    if (!localChanged && remoteChanged) {
      await downloadFile(session, relativePath, relativePath, remoteRecord.size);
      counters.downloads += 1;
      continue;
    }

    if (localChanged && remoteChanged) {
      await uploadFile(
        session,
        relativePath,
        conflictRelativePath(relativePath, "local"),
        localRecord.size,
      );
      await downloadFile(
        session,
        relativePath,
        conflictRelativePath(relativePath, "remote"),
        remoteRecord.size,
      );
      counters.conflicts += 1;
    }
  }

  return counters;
}

async function uploadFile(
  session: SyncContext,
  sourceRelativePath: string,
  targetRelativePath: string,
  totalBytes: number,
): Promise<void> {
  if (session.progressTotalBytes !== undefined) {
    updateTransferStatus(
      session,
      "upload",
      session.progressBaseBytes ?? 0,
      session.progressTotalBytes,
    );
  } else {
    updateStatus(
      `$(cloud-upload) ${session.statusLabel}: ${shortPath(sourceRelativePath)}`,
      `${session.alias}\nUpload ${sourceRelativePath}`,
    );
  }
  session.output.appendLine(
    `${session.operationLabel} ${session.alias}: upload ${sourceRelativePath} -> ${targetRelativePath}`,
  );
  const localPath = localFilePath(session.localFolder, sourceRelativePath);
  const remotePath = remoteFilePath(session.remoteFolder, targetRelativePath);
  await runSsh(
    session.alias,
    `mkdir -p ${quoteRemotePath(posixDirname(remotePath))}`,
    30_000,
  );
  await streamUpload(session, localPath, remotePath, sourceRelativePath, totalBytes);
}

async function downloadFile(
  session: SyncContext,
  sourceRelativePath: string,
  targetRelativePath: string,
  totalBytes: number,
): Promise<void> {
  updateStatus(
    `$(cloud-download) ${session.statusLabel}: ${shortPath(sourceRelativePath)}`,
    `${session.alias}\nDownload ${sourceRelativePath}`,
  );
  session.output.appendLine(
    `${session.operationLabel} ${session.alias}: download ${sourceRelativePath} -> ${targetRelativePath}`,
  );
  const localPath = localFilePath(session.localFolder, targetRelativePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  const remotePath = remoteFilePath(session.remoteFolder, sourceRelativePath);
  await streamDownload(session, remotePath, localPath, sourceRelativePath, totalBytes);
}

async function streamUpload(
  session: SyncContext,
  localPath: string,
  remotePath: string,
  relativePath: string,
  totalBytes: number,
): Promise<void> {
  const tmpRemotePath = `${remotePath}.autodl-sync-${process.pid}-${Date.now()}.tmp`;
  const command = [
    `cat > ${quoteRemotePath(tmpRemotePath)}`,
    `mv ${quoteRemotePath(tmpRemotePath)} ${quoteRemotePath(remotePath)}`,
  ].join(" && ");
  const child = cp.spawn("ssh", sshArgs(session.alias, command), {
    windowsHide: true,
  });
  trackChild(session, child);
  child.stdout?.resume();

  const stderr = collectStderr(child);
  const updateProgress = transferProgress(session, "upload", relativePath, totalBytes);
  const source = createReadStream(localPath);
  const progressStream = createProgressStream(updateProgress);

  try {
    updateProgress(0, true);
    await Promise.all([
      pipeline(source, progressStream, child.stdin),
      waitForChild(child, stderr, `upload ${relativePath}`),
    ]);
    updateProgress(totalBytes, true);
    session.output.appendLine(
      `${session.operationLabel} ${session.alias}: upload complete ${relativePath} (${formatBytes(totalBytes)})`,
    );
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function streamDownload(
  session: SyncContext,
  remotePath: string,
  localPath: string,
  relativePath: string,
  totalBytes: number,
): Promise<void> {
  const tmpLocalPath = `${localPath}.autodl-sync-${process.pid}-${Date.now()}.tmp`;
  const child = cp.spawn(
    "ssh",
    sshArgs(session.alias, `cat ${quoteRemotePath(remotePath)}`),
    {
      windowsHide: true,
    },
  );
  trackChild(session, child);

  const stderr = collectStderr(child);
  const updateProgress = transferProgress(session, "download", relativePath, totalBytes);
  const target = createWriteStream(tmpLocalPath);
  const progressStream = createProgressStream(updateProgress);

  try {
    updateProgress(0, true);
    await Promise.all([
      pipeline(child.stdout, progressStream, target),
      waitForChild(child, stderr, `download ${relativePath}`),
    ]);
    await fs.rename(tmpLocalPath, localPath);
    updateProgress(totalBytes, true);
    session.output.appendLine(
      `${session.operationLabel} ${session.alias}: download complete ${relativePath} (${formatBytes(totalBytes)})`,
    );
  } catch (error) {
    child.kill();
    await fs.rm(tmpLocalPath, { force: true });
    throw error;
  }
}

async function scanLocal(
  localFolder: string,
  excludeNames: Set<string>,
  shouldCancel?: () => boolean,
): Promise<Map<string, FileRecord>> {
  const files = new Map<string, FileRecord>();
  await scanLocalDirectory(localFolder, "", excludeNames, files, shouldCancel);
  return files;
}

async function scanLocalDirectory(
  root: string,
  relativeDirectory: string,
  excludeNames: Set<string>,
  files: Map<string, FileRecord>,
  shouldCancel?: () => boolean,
): Promise<void> {
  if (shouldCancel?.()) {
    throw new Error("Folder sync stopped.");
  }
  const directory = relativeDirectory ? path.join(root, relativeDirectory) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldCancel?.()) {
      throw new Error("Folder sync stopped.");
    }
    if (excludeNames.has(entry.name)) {
      continue;
    }
    const relativePath = relativeDirectory
      ? path.posix.join(toPosixPath(relativeDirectory), entry.name)
      : entry.name;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      await scanLocalDirectory(root, relativePath, excludeNames, files, shouldCancel);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    files.set(relativePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
}

async function scanRemote(
  context: string | SyncContext,
  remoteFolder: string,
  excludeNames: Set<string>,
): Promise<Map<string, FileRecord>> {
  const prune = remoteFindPrune(excludeNames);
  const command = `cd ${quoteRemotePath(remoteFolder)} && find . ${prune} -type f -printf '%P\t%T@\t%s\n'`;
  const { stdout } = await runSsh(context, command, 60_000);
  const files = new Map<string, FileRecord>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [relativePath, rawMtime, rawSize] = line.split("\t");
    if (!relativePath || isExcludedPath(relativePath, excludeNames)) {
      continue;
    }
    files.set(relativePath, {
      mtimeMs: Number(rawMtime) * 1000,
      size: Number(rawSize),
    });
  }
  return files;
}

function remoteFindPrune(excludeNames: Set<string>): string {
  const names = [...excludeNames];
  if (!names.length) {
    return "";
  }
  const clauses = names.map((name) => `-name ${quoteRemotePath(name)}`).join(" -o ");
  return `\\( -type d \\( ${clauses} \\) -prune \\) -o`;
}

function buildSyncedState(
  local: Map<string, FileRecord>,
  remote: Map<string, FileRecord>,
): Map<string, SyncedRecord> {
  const state = new Map<string, SyncedRecord>();
  for (const relativePath of new Set([...local.keys(), ...remote.keys()])) {
    state.set(relativePath, {
      local: local.get(relativePath),
      remote: remote.get(relativePath),
    });
  }
  return state;
}

async function runSsh(
  context: string | SyncContext,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const alias = typeof context === "string" ? context : context.alias;
  return runCommand(
    "ssh",
    sshArgs(alias, command),
    timeoutMs,
    typeof context === "string" ? undefined : context,
  );
}

function sshArgs(alias: string, command: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "CheckHostIP=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `HostKeyAlias=${alias}`,
    "-o",
    `UserKnownHostsFile=${toPosixPath(
      path.join(os.homedir(), ".ssh", "autodl-vscode-known_hosts"),
    )}`,
    alias,
    command,
  ];
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  context?: SyncContext,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    trackChild(context, child);
  });
}

function throwIfDisposed(session: SyncSession): void {
  if (session.disposed) {
    throw new Error("Folder sync stopped.");
  }
}

function trackChild(context: SyncContext | undefined, child: cp.ChildProcess): void {
  if (!isSyncSession(context)) {
    return;
  }
  context.activeChildren.add(child);
  const untrack = () => context.activeChildren.delete(child);
  child.once("close", untrack);
  child.once("error", untrack);
  if (context.disposed) {
    child.kill();
  }
}

function isSyncSession(context: SyncContext | undefined): context is SyncSession {
  return Boolean(context && "activeChildren" in context);
}

function collectStderr(child: cp.ChildProcess): () => string {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4_000) {
      stderr = stderr.slice(-4_000);
    }
  });
  return () => stderr.trim();
}

function waitForChild(
  child: cp.ChildProcess,
  stderr: () => string,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${label} failed: ${stderr() || `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`}`,
        ),
      );
    });
  });
}

function createProgressStream(
  updateProgress: (transferredBytes: number, force?: boolean) => void,
): Transform {
  let transferredBytes = 0;
  return new Transform({
    transform(
      chunk: Buffer | string,
      encoding: BufferEncoding,
      callback: TransformCallback,
    ): void {
      transferredBytes += Buffer.byteLength(chunk, encoding);
      updateProgress(transferredBytes);
      callback(null, chunk);
    },
  });
}

async function ensureExistingDirectory(localFolder: string): Promise<void> {
  const stat = await fs.stat(localFolder);
  if (!stat.isDirectory()) {
    throw new Error(`Sync local path is not a directory: ${localFolder}`);
  }
}

function normalizeRemoteFolder(remoteFolder: string): string {
  const trimmed = remoteFolder.trim() || "/root/autodl-sync";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") || "/" : `/${trimmed}`;
}

function localFilePath(localFolder: string, relativePath: string): string {
  return path.join(localFolder, ...relativePath.split("/"));
}

function remoteFilePath(remoteFolder: string, relativePath: string): string {
  return `${normalizeRemoteFolder(remoteFolder).replace(/\/+$/, "")}/${relativePath}`;
}

function posixDirname(value: string): string {
  return path.posix.dirname(value);
}

function conflictRelativePath(relativePath: string, side: "local" | "remote"): string {
  const directory = path.posix.dirname(relativePath);
  const extension = path.posix.extname(relativePath);
  const basename = path.posix.basename(relativePath, extension);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const filename = `${basename}.${side}-conflict-${stamp}${extension}`;
  return directory === "." ? filename : path.posix.join(directory, filename);
}

function sameRecord(left: FileRecord, right: FileRecord): boolean {
  return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 2_000;
}

function quoteRemotePath(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isExcludedPath(relativePath: string, excludeNames: Set<string>): boolean {
  return relativePath.split("/").some((part) => excludeNames.has(part));
}

function updateStatus(text: string, tooltip?: string): void {
  const item = ensureStatusBarItem();
  item.text = text;
  item.tooltip = tooltip || "AutoDL folder sync is running. Click to stop sync.";
  item.show();
}

function updateIdleStatus(): void {
  if (!sessions.size) {
    statusBarItem?.dispose();
    statusBarItem = undefined;
    return;
  }
  const item = ensureStatusBarItem();
  item.text = `$(sync) AutoDL Sync: ${sessions.size} active`;
  item.tooltip = [
    "AutoDL folder sync is active. Click to stop sync.",
    "",
    ...[...sessions.values()].map(
      (session) => `${session.alias}: ${session.localFolder} <-> ${session.remoteFolder}`,
    ),
  ].join("\n");
  item.show();
}

function ensureStatusBarItem(): vscode.StatusBarItem {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = "autodl.stopFolderSync";
  }
  return statusBarItem;
}

function shortPath(relativePath: string): string {
  const value = relativePath.length <= 28 ? relativePath : `...${relativePath.slice(-25)}`;
  return value.replace(/\s+/g, " ");
}

function transferProgress(
  session: SyncContext,
  direction: "upload" | "download",
  relativePath: string,
  totalBytes: number,
): (transferredBytes: number, force?: boolean) => void {
  let lastUpdate = 0;
  const icon = direction === "upload" ? "$(cloud-upload)" : "$(cloud-download)";
  const verb = direction === "upload" ? "Upload" : "Download";
  return (transferredBytes: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdate < 100 && transferredBytes < totalBytes) {
      return;
    }
    lastUpdate = now;
    const displayedBytes = (session.progressBaseBytes ?? 0) + transferredBytes;
    const displayedTotal = session.progressTotalBytes ?? totalBytes;
    updateTransferStatus(session, direction, displayedBytes, displayedTotal, [
      `${session.alias}`,
      `${verb}: ${relativePath}`,
    ]);
  };
}

function updateTransferStatus(
  session: SyncContext,
  direction: "upload" | "download",
  transferredBytes: number,
  totalBytes: number,
  tooltipPrefix: string[] = [session.alias],
): void {
  const icon = direction === "upload" ? "$(cloud-upload)" : "$(cloud-download)";
  const percent =
    totalBytes > 0 ? Math.min(100, Math.floor((transferredBytes / totalBytes) * 100)) : 100;
  const transferText = `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}`;
  updateStatus(
    `${icon} ${percent}% ${transferText}`,
    [...tooltipPrefix, `${transferText} (${percent}%)`].join("\n"),
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 10 || unitIndex === 0 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}
