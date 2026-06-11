import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import * as vscode from "vscode";

import {
  currentGpuCatalog,
  currentImageCatalog,
  GpuCatalogItem,
  ImageCatalogItem,
  loadCatalogCache,
  refreshCatalogCache,
} from "./catalog";
import {
  AutoDLApiError,
  AutoDLClient,
  enrichInstancesWithSnapshots,
  extractInstanceUuid,
  instanceUuidOf,
  isAlreadyStoppedError,
  isActiveInstance,
  listAllInstances,
  needsPowerOff,
  snapshotWithRetry,
  waitForStatus,
} from "./client";
import {
  buildQuickCreatePayload,
  clearToken,
  ensureToken,
  getSettings,
  getToken,
  mergeStartCommandWithSshKey,
  profileQuickPickItems,
  promptAndStoreToken,
  RemoteCommandConfig,
} from "./config";
import { InstancesProvider, InstanceItem } from "./instancesView";
import {
  connectWithRemoteSsh,
  ensureRemoteVsCodeSettings,
  formatSnapshotSummary,
  jupyterUrl,
  ManagedSshHostOptions,
  removeAllManagedSshHosts,
  removeManagedSshHost,
  removeRecentlyOpenedRemoteSshEntries,
  remoteSshUri,
  runManagedSshCommand,
  sshAlias,
  toggleRemoteVsCodeSettings,
  writeManagedSshHost,
} from "./ssh";
import {
  checkRemoteVsCodeServerReady,
  installRemoteVsCodeExtension,
} from "./remoteExtensions";
import { remoteProxySettingsPayload, remoteProxyUrl, resolveRemoteProxy } from "./remoteProxy";
import {
  activeFolderSyncAliases,
  startFolderSync,
  stopAllFolderSync,
  stopFolderSync,
  uploadFolderOnce,
} from "./sync";
import { AutoDLInstance, CreateInstancePayload, QuickCreateBuildResult } from "./types";

let output: vscode.OutputChannel;
let provider: InstancesProvider;
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
const recentRemotePathsKey = "autodl.recentRemotePathsByInstance";
type RecentRemotePathsByInstance = Record<string, string[]>;
const remoteHomeWipeTimeoutMs = 5 * 60 * 1000;
const remoteHomeWipeCommand = [
  "set -eu",
  'home="${HOME:-/root}"',
  'case "$home" in ""|"/") echo "Refusing to wipe unsafe HOME: $home" >&2; exit 64;; esac',
  'echo "Remote home wipe target: $home"',
  'if [ -d "$home" ]; then for attempt in 1 2 3; do find "$home" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; sync || true; remaining="$(find "$home" -mindepth 1 -maxdepth 1 -print -quit)"; [ -z "$remaining" ] && break; echo "Remote home wipe retry $attempt; first remaining entry: $remaining" >&2; sleep 1; done; remaining="$(find "$home" -mindepth 1 -maxdepth 1 -print -quit)"; if [ -n "$remaining" ]; then echo "Remote home wipe verification failed; first remaining entry: $remaining" >&2; exit 65; fi; remaining_count="$(find "$home" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d " ")"; else remaining_count=0; fi; echo "Remote home wipe remaining entries: ${remaining_count:-0}"',
  'echo "Remote home wipe verified: $home"',
].join("; ");
type RemoteHomeWipeResult = "verified" | "skipped";
const remoteCodexAuthFoundMarker = "__AUTODL_CODEX_AUTH_FOUND__";
const remoteCodexAuthMissingMarker = "__AUTODL_CODEX_AUTH_MISSING__";
const remoteCodexAuthUploadCommand = [
  "set -eu",
  'codex_dir="${HOME:-/root}/.codex"',
  'mkdir -p "$codex_dir"',
  'chmod 700 "$codex_dir"',
  "umask 077",
  'cat > "$codex_dir/auth.json"',
  'chmod 600 "$codex_dir/auth.json"',
  'echo "Remote Codex auth written: $codex_dir/auth.json"',
].join("; ");
const remoteCodexAuthDownloadCommand = [
  "set -eu",
  'auth_file="${HOME:-/root}/.codex/auth.json"',
  'if [ -f "$auth_file" ]; then',
  `  printf '${remoteCodexAuthFoundMarker}\\n'`,
  '  cat "$auth_file"',
  "else",
  `  printf '${remoteCodexAuthMissingMarker}\\n'`,
  "fi",
].join("\n");

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("AutoDL");
  await loadCatalogCache(context);
  provider = new InstancesProvider(async () => {
    const token = await getToken(context);
    if (!token) {
      syncAutoRefresh([]);
      return { hasToken: false, instances: [] };
    }
    const client = new AutoDLClient(token, getSettings().apiBaseUrl);
    try {
      const instances = await enrichInstancesWithSnapshots(client, await listAllInstances(client));
      syncAutoRefresh(instances);
      return {
        hasToken: true,
        instances,
      };
    } catch (error) {
      stopAutoRefresh();
      throw error;
    }
  }, reportErrorToOutput);

  context.subscriptions.push(output);
  context.subscriptions.push({ dispose: stopAutoRefresh });
  context.subscriptions.push({ dispose: stopAllFolderSync });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("autodlInstances", provider),
    vscode.commands.registerCommand("autodl.setToken", async () => {
      await promptAndStoreToken(context);
      provider.refresh();
    }),
    vscode.commands.registerCommand("autodl.clearToken", async () => {
      await clearToken(context);
      provider.refresh();
      void vscode.window.showInformationMessage("AutoDL token cleared.");
    }),
    vscode.commands.registerCommand("autodl.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("autodl.refreshCatalogs", () => refreshCatalogs(context)),
    vscode.commands.registerCommand("autodl.quickCreate", () => quickCreate(context)),
    vscode.commands.registerCommand("autodl.selectServer", () => selectServer(context)),
    vscode.commands.registerCommand("autodl.setSshPublicKey", () => setSshPublicKey()),
    vscode.commands.registerCommand("autodl.prepareRemote", (item?: InstanceItem) =>
      prepareRemote(context, item),
    ),
    vscode.commands.registerCommand("autodl.configureProxy", () => configureProxySettings()),
    vscode.commands.registerCommand("autodl.writeRemoteProxySettings", (item?: InstanceItem) =>
      writeRemoteProxySettings(context, item),
    ),
    vscode.commands.registerCommand("autodl.installRemoteCodex", (item?: InstanceItem) =>
      installRemoteCodex(context, item),
    ),
    vscode.commands.registerCommand("autodl.toggleRemoteCodexAutoInstall", () =>
      toggleRemoteCodexAutoInstall(),
    ),
    vscode.commands.registerCommand("autodl.configureRemoteCommands", () =>
      configureRemoteCommands(),
    ),
    vscode.commands.registerCommand("autodl.runRemoteCommand", (item?: InstanceItem) =>
      runRemoteCommand(context, item),
    ),
    vscode.commands.registerCommand("autodl.openSettings", () => openAutoDLSettings()),
    vscode.commands.registerCommand("autodl.setSyncFolders", () => setSyncFolders()),
    vscode.commands.registerCommand("autodl.startFolderSync", (item?: InstanceItem) =>
      startFolderSyncForInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.uploadSyncFolder", (item?: InstanceItem) =>
      uploadSyncFolder(context, item),
    ),
    vscode.commands.registerCommand("autodl.stopFolderSync", () => stopFolderSyncCommand()),
    vscode.commands.registerCommand("autodl.cleanSshConfig", () => cleanSshConfig()),
    vscode.commands.registerCommand("autodl.quickCreateLow", () => quickCreate(context, "low")),
    vscode.commands.registerCommand("autodl.quickCreateMid", () => quickCreate(context, "mid")),
    vscode.commands.registerCommand("autodl.quickCreateHigh", () => quickCreate(context, "high")),
    vscode.commands.registerCommand("autodl.connect", (item?: InstanceItem) =>
      connectInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.openJupyter", (item?: InstanceItem) =>
      openJupyter(context, item),
    ),
    vscode.commands.registerCommand("autodl.stop", (item?: InstanceItem) =>
      stopInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.turnOn", (item?: InstanceItem) =>
      turnOnInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.release", (item?: InstanceItem) =>
      releaseInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.quickCloseAll", () => quickCloseAll(context)),
  );
}

export function deactivate(): void {
  stopAutoRefresh();
  stopAllFolderSync();
}

function syncAutoRefresh(instances: AutoDLInstance[]): void {
  const hasTransitionalInstance = instances.some((instance) => !isStableStatus(instance.status));
  if (hasTransitionalInstance && !autoRefreshTimer) {
    autoRefreshTimer = setInterval(() => provider?.refresh(), 3_000);
  }
  if (!hasTransitionalInstance) {
    stopAutoRefresh();
  }
}

function stopAutoRefresh(): void {
  if (!autoRefreshTimer) {
    return;
  }
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = undefined;
}

function isStableStatus(status: string | undefined): boolean {
  const normalized = String(status || "").toLowerCase();
  return ["running", "shutdown", "stopped", "released", "deleted", "destroyed"].includes(
    normalized,
  );
}

async function createClient(context: vscode.ExtensionContext): Promise<AutoDLClient | undefined> {
  const token = await ensureToken(context);
  if (!token) {
    return undefined;
  }
  return new AutoDLClient(token, getSettings().apiBaseUrl);
}

async function refreshCatalogs(context: vscode.ExtensionContext): Promise<void> {
  await runSafely(async () => {
    const token = await getToken(context);
    const client = token ? new AutoDLClient(token, getSettings().apiBaseUrl) : undefined;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AutoDL refresh GPU and image catalogs",
        cancellable: false,
      },
      () => refreshCatalogCache(context, client),
    );
    provider.refresh();
    const message = `AutoDL catalogs refreshed: ${result.gpuCount} GPU, ${result.imageCount} image(s), ${result.privateImageCount} private image(s).`;
    if (!result.docsOk || !result.privateImagesOk) {
      void vscode.window.showWarningMessage(
        `${message} Some sources failed; cached/default entries were kept.`,
      );
      return;
    }
    void vscode.window.showInformationMessage(message);
  });
}

async function quickCreate(
  context: vscode.ExtensionContext,
  profileName?: string,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const settings = getSettings();
    const selectedProfile = profileName || (await pickProfile());
    if (!selectedProfile) {
      return;
    }
    const sshPublicKey = settings.injectSshPublicKeyOnCreate ? settings.sshPublicKey : undefined;
    const plan = buildQuickCreatePayload(selectedProfile, settings.quickCreate, sshPublicKey);
    await createFromPlan(client, plan, "AutoDL quick create");

    provider.refresh();
  });
}

async function selectServer(context: vscode.ExtensionContext): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const settings = getSettings();
    const payload = await promptServerPayload(
      {
        req_gpu_amount: settings.quickCreate.defaults.gpu_amount,
        expand_system_disk_by_gb: settings.quickCreate.defaults.system_disk,
        gpu_spec_uuid: "",
        image_uuid: settings.quickCreate.defaults.image_uuid,
        cuda_v_from: settings.quickCreate.defaults.cuda_min,
        data_center_list: settings.quickCreate.defaults.data_centers,
      },
      settings.injectSshPublicKeyOnCreate ? settings.sshPublicKey : "",
    );
    if (!payload) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Create AutoDL server with ${payload.gpu_spec_uuid}, ${payload.req_gpu_amount} GPU, CUDA ${payload.cuda_v_from}?`,
      { modal: true },
      "Create",
    );
    if (confirm !== "Create") {
      return;
    }
    await createFromPlan(
      client,
      {
        profileName: "custom",
        label: "Custom Server",
        payload,
      },
      "AutoDL select server",
    );
    provider.refresh();
  });
}

async function createFromPlan(
  client: AutoDLClient,
  plan: QuickCreateBuildResult,
  title: string,
): Promise<void> {
  output.show(true);
  output.appendLine("");
  output.appendLine(`Create profile: ${plan.profileName}`);
  output.appendLine(`Create payload: ${JSON.stringify(plan.payload)}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${title}: ${plan.label}`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Creating instance" });
      const created = await client.createInstance(plan.payload);
      const instanceUuid = extractInstanceUuid(created.data);
      if (!instanceUuid) {
        throw new Error("Create API did not return an instance UUID.");
      }

      output.appendLine(`Created instance: ${instanceUuid}`);
      progress.report({ message: "Reading snapshot if ready" });
      try {
        const snapshot = await snapshotWithRetry(client, instanceUuid, 2, 2_000);
        output.appendLine(formatSnapshotSummary(instanceUuid, snapshot));
      } catch (error) {
        output.appendLine(
          `Snapshot is not ready yet. Use SSH Connect after the instance reaches running state. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

async function connectInstance(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    const snapshot = await snapshotWithRetry(client, uuid, 3);
    const settings = getSettings();
    const alias = await connectWithRemoteSsh(
      uuid,
      snapshot,
      settings.openRemotePath,
      output,
      managedSshHostOptions(settings),
    );
    if (settings.remoteCodex.autoInstall) {
      void installRemoteCodexForAlias(alias, settings, "auto").catch((error) =>
        reportErrorToOutput(error),
      );
    }
    try {
      await rememberRecentRemotePath(context, uuid, settings.openRemotePath);
    } catch (error) {
      output.appendLine(
        `Warning: failed to remember VS Code recent path for ${uuid}: ${formatError(error)}`,
      );
    }
  });
}

async function openJupyter(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    const snapshot = await snapshotWithRetry(client, uuid, 3);
    const url = jupyterUrl(snapshot);
    if (!url) {
      throw new Error("Snapshot does not contain a Jupyter domain.");
    }
    if (snapshot.jupyter_token) {
      await vscode.env.clipboard.writeText(snapshot.jupyter_token);
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });
}

async function stopInstance(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    await powerOffIfNeeded(client, uuid);
    await waitForStatus(
      client,
      uuid,
      ["stopped", "shutdown"],
      getSettings().waitTimeoutMs,
      getSettings().waitIntervalMs,
    );
    provider.refresh();
    void vscode.window.showInformationMessage(`AutoDL instance shutdown: ${uuid}`);
  });
}

async function turnOnInstance(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    await client.powerOn(uuid);
    provider.refresh();
    void vscode.window.showInformationMessage(`AutoDL instance starting: ${uuid}`);
  });
}

async function releaseInstance(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    const choice = await vscode.window.showWarningMessage(
      `Release AutoDL instance ${uuid}? AutoDL will wipe the remote home directory before release. This cannot be undone.`,
      { modal: true },
      "Release",
    );
    if (choice !== "Release") {
      return;
    }
    const settings = getSettings();
    let cleanupResult: RemoteHomeWipeResult | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AutoDL release ${uuid}`,
        cancellable: false,
      },
      async (progress) => {
        output.show(true);
        output.appendLine("");
        appendReleaseLog(`${uuid}: release requested`);
        progress.report({ message: "Backing up remote Codex auth" });
        try {
          await backupRemoteCodexAuthBeforeRelease(client, instance, settings);
        } catch (error) {
          appendReleaseLog(
            `${uuid}: release aborted before remote home wipe because Codex auth backup failed`,
          );
          throw error;
        }
        progress.report({ message: "Wiping and verifying remote home" });
        try {
          cleanupResult = await wipeRemoteHomeBeforeRelease(client, instance, settings);
        } catch (error) {
          appendReleaseLog(
            `${uuid}: release aborted before AutoDL API release because remote cleanup verification failed`,
          );
          throw error;
        }
        if (needsPowerOff(instance)) {
          progress.report({ message: "Stopping instance" });
          appendReleaseLog(`${uuid}: stopping instance before release`);
          await powerOffIfNeeded(client, uuid);
          await waitForStatus(
            client,
            uuid,
            ["stopped", "shutdown"],
            settings.waitTimeoutMs,
            settings.waitIntervalMs,
          );
        }
        progress.report({ message: "Calling AutoDL release API" });
        appendReleaseLog(`${uuid}: calling AutoDL release API`);
        await client.release(uuid);
        appendReleaseLog(`${uuid}: AutoDL release API completed`);
        await cleanupReleasedInstance(context, uuid, [settings.openRemotePath]);
        appendReleaseLog(`${uuid}: local SSH config and recent entries cleanup completed`);
      },
    );
    provider.refresh();
    void vscode.window.showInformationMessage(
      cleanupResult === "verified"
        ? `AutoDL instance released: ${uuid}. Remote home cleanup verified.`
        : `AutoDL instance released: ${uuid}. Remote cleanup was skipped because the instance was already stopped.`,
    );
  });
}

async function quickCloseAll(context: vscode.ExtensionContext): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Stop and release all active AutoDL instances? AutoDL will wipe each reachable remote home directory before release. This cannot be undone.",
      { modal: true },
      "Stop and Release All",
    );
    if (choice !== "Stop and Release All") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AutoDL quick close all",
        cancellable: false,
      },
      async (progress) => {
        const settings = getSettings();
        const instances = (await listAllInstances(client)).filter(isActiveInstance);
        let verifiedCleanupCount = 0;
        let skippedCleanupCount = 0;
        output.show(true);
        output.appendLine("");
        output.appendLine(`Quick close target count: ${instances.length}`);

        for (let index = 0; index < instances.length; index += 1) {
          const instance = instances[index];
          const uuid = mustInstanceUuid(instance);
          progress.report({ message: `${index + 1}/${instances.length}: ${uuid}` });
          appendReleaseLog(`${uuid}: quick close target ${index + 1}/${instances.length}`);
          try {
            await backupRemoteCodexAuthBeforeRelease(client, instance, settings);
          } catch (error) {
            appendReleaseLog(
              `${uuid}: quick close aborted before remote home wipe because Codex auth backup failed`,
            );
            throw error;
          }
          try {
            const cleanupResult = await wipeRemoteHomeBeforeRelease(client, instance, settings);
            if (cleanupResult === "verified") {
              verifiedCleanupCount += 1;
            } else {
              skippedCleanupCount += 1;
            }
          } catch (error) {
            appendReleaseLog(
              `${uuid}: quick close aborted before release because remote cleanup verification failed`,
            );
            throw error;
          }
          if (needsPowerOff(instance)) {
            appendReleaseLog(`${uuid}: stopping instance before release`);
            await powerOffIfNeeded(client, uuid);
            await waitForStatus(
              client,
              uuid,
              ["stopped", "shutdown"],
              getSettings().waitTimeoutMs,
              getSettings().waitIntervalMs,
            );
          }
          appendReleaseLog(`${uuid}: calling AutoDL release API`);
          await client.release(uuid);
          appendReleaseLog(`${uuid}: AutoDL release API completed`);
          await cleanupReleasedInstance(context, uuid, [settings.openRemotePath]);
          appendReleaseLog(`${uuid}: local SSH config and recent entries cleanup completed`);
        }
        appendReleaseLog(
          `quick close completed; remote cleanup verified=${verifiedCleanupCount}, skipped=${skippedCleanupCount}`,
        );
      },
    );

    provider.refresh();
    void vscode.window.showInformationMessage("AutoDL quick close completed. See AutoDL output for cleanup verification logs.");
  });
}

async function cleanupReleasedInstance(
  context: vscode.ExtensionContext,
  instanceUuid: string,
  remotePaths: string[],
): Promise<void> {
  stopFolderSync(sshAlias(instanceUuid));
  await runBestEffortCleanup(`remove SSH config for ${instanceUuid}`, () =>
    removeManagedSshHost(instanceUuid),
  );
  await runBestEffortCleanup(`remove VS Code recent entries for ${instanceUuid}`, () =>
    removeRecentlyOpenedRemoteSshEntries(
      instanceUuid,
      [...recentRemotePathsForInstance(context, instanceUuid), ...remotePaths],
      output,
    ),
  );
  await runBestEffortCleanup(`clear recent path state for ${instanceUuid}`, () =>
    forgetRecentRemotePathsForInstance(context, instanceUuid),
  );
}

async function backupRemoteCodexAuthBeforeRelease(
  client: AutoDLClient,
  instance: AutoDLInstance,
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const uuid = mustInstanceUuid(instance);
  const localPath = settings.remoteCodex.authJsonPath.trim();
  if (!localPath) {
    appendReleaseLog(
      `${uuid}: Codex auth backup skipped because autodl.remoteCodex.authJsonPath is empty`,
    );
    return;
  }
  if (!needsPowerOff(instance)) {
    appendReleaseLog(
      `${uuid}: Codex auth backup skipped because the instance is already stopped and cannot be reached over SSH`,
    );
    return;
  }

  appendReleaseLog(`${uuid}: checking remote Codex auth before home wipe`);
  const snapshot = await snapshotWithRetry(client, uuid, 3);
  const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(settings));
  const result = await runManagedSshCommand(alias, remoteCodexAuthDownloadCommand, 30_000);
  if (result.stderr.trim()) {
    appendReleaseCommandOutput(`${uuid}: remote Codex auth backup stderr`, result.stderr);
  }

  const parsed = parseRemoteCodexAuthDownload(result.stdout);
  if (!parsed.found) {
    appendReleaseLog(`${uuid}: remote Codex auth not found; no local overwrite needed`);
    return;
  }

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, parsed.content, "utf8");
  appendReleaseLog(`${uuid}: remote Codex auth downloaded to ${localPath}`);
}

async function wipeRemoteHomeBeforeRelease(
  client: AutoDLClient,
  instance: AutoDLInstance,
  settings: ReturnType<typeof getSettings>,
): Promise<RemoteHomeWipeResult> {
  const uuid = mustInstanceUuid(instance);
  if (!needsPowerOff(instance)) {
    appendReleaseLog(
      `${uuid}: remote home wipe skipped because the instance is already stopped; AutoDL release will clear instance data`,
    );
    return "skipped";
  }

  output.show(true);
  appendReleaseLog(`${uuid}: fetching snapshot for remote cleanup`);
  const snapshot = await snapshotWithRetry(client, uuid, 3);
  appendReleaseLog(`${uuid}: writing managed SSH host for remote cleanup`);
  const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(settings));
  appendReleaseLog(`${uuid}: running remote home wipe over SSH alias ${alias}`);
  const wipeResult = await runManagedSshCommand(
    alias,
    remoteHomeWipeCommand,
    remoteHomeWipeTimeoutMs,
  );
  appendReleaseCommandOutput(`${uuid}: remote cleanup stdout`, wipeResult.stdout);
  appendReleaseCommandOutput(`${uuid}: remote cleanup stderr`, wipeResult.stderr);
  appendReleaseLog(`${uuid}: remote home cleanup verified; continuing to release`);
  return "verified";
}

function appendReleaseLog(message: string): void {
  output.appendLine(`[release ${new Date().toISOString()}] ${message}`);
}

function appendReleaseCommandOutput(label: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  appendReleaseLog(`${label}:`);
  for (const line of trimmed.split(/\r?\n/)) {
    output.appendLine(`  ${line}`);
  }
}

async function runBestEffortCleanup(
  label: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    output.appendLine(`Warning: failed to ${label}: ${formatError(error)}`);
  }
}

async function startFolderSyncForInstance(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const settings = getSettings();
    if (!settings.sync.localFolder) {
      await setSyncFolders();
    }
    const nextSettings = getSettings();
    if (!nextSettings.sync.localFolder) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    const snapshot = await snapshotWithRetry(client, uuid, 3);
    const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(nextSettings));
    await startFolderSyncForAlias(alias, nextSettings.sync);
  });
}

async function uploadSyncFolder(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    let settings = getSettings();
    if (!settings.sync.localFolder) {
      await setSyncFolders();
      settings = getSettings();
    }
    if (!settings.sync.localFolder) {
      return;
    }

    const uuid = mustInstanceUuid(instance);
    const snapshot = await snapshotWithRetry(client, uuid, 3);
    const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(settings));
    await uploadFolderOnce({
      alias,
      localFolder: settings.sync.localFolder,
      remoteFolder: settings.sync.remoteFolder,
      excludeNames: settings.sync.excludeNames,
      output,
    });
  });
}

async function writeRemoteProxySettings(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    if (!resolveRemoteProxy(getSettings().remoteProxy)) {
      void vscode.window.showInformationMessage(
        "AutoDL remote proxy is not configured. Set autodl.remoteProxy.proxyUrl first.",
      );
      return;
    }
    const resolved = await resolveInstanceAlias(context, item);
    if (!resolved) {
      return;
    }
    await toggleRemoteProxyForAlias(resolved.alias, resolved.settings);
  });
}

async function prepareRemote(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(plug) Configure Proxy",
          description: "local and forwarded proxy address",
          id: "proxy",
        },
        {
          label: "$(extensions) Install / Prepare Codex",
          description: "prepare the selected remote VS Code session",
          id: "codex",
        },
        {
          label: "$(terminal) Configure Remote Commands",
          description: "saved commands and local .sh scripts",
          id: "commands",
        },
        {
          label: "$(settings-gear) Open AutoDL Settings",
          description: "all extension settings",
          id: "settings",
        },
      ] satisfies Array<vscode.QuickPickItem & { id: string }>,
      {
        title: "AutoDL Remote Tools",
        placeHolder: "Choose what to configure",
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      return;
    }
    if (picked.id === "proxy") {
      await promptAndSaveProxySettings();
      return;
    }
    if (picked.id === "codex") {
      const resolved = await resolveInstanceAlias(context, item);
      if (!resolved) {
        return;
      }
      await installRemoteCodexForAlias(resolved.alias, resolved.settings, "manual");
      return;
    }
    if (picked.id === "commands") {
      await configureRemoteCommandsCore();
      return;
    }
    await openAutoDLSettings();
  });
}

async function installRemoteCodex(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const resolved = await resolveInstanceAlias(context, item);
    if (!resolved) {
      return;
    }
    await installRemoteCodexForAlias(resolved.alias, resolved.settings, "manual");
  });
}

async function toggleRemoteCodexAutoInstall(): Promise<void> {
  await runSafely(async () => {
    const config = vscode.workspace.getConfiguration("autodl");
    const next = !getSettings().remoteCodex.autoInstall;
    await config.update("remoteCodex.autoInstall", next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `AutoDL remote Codex auto install ${next ? "enabled" : "disabled"}.`,
    );
  });
}

async function configureProxySettings(): Promise<void> {
  await runSafely(async () => {
    await promptAndSaveProxySettings();
  });
}

async function promptAndSaveProxySettings(): Promise<boolean> {
  const settings = getSettings();
  const proxyUrl = await vscode.window.showInputBox({
    title: "AutoDL Remote Proxy URL",
    prompt: "Local proxy URL forwarded to the remote. Leave empty to disable AutoDL proxy forwarding.",
    value: settings.remoteProxy.proxyUrl,
    placeHolder: "http://127.0.0.1:7890 or socks5://127.0.0.1:7890",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      try {
        resolveRemoteProxy({
          enabled: true,
          proxyUrl: trimmed,
          localForwardHost: settings.remoteProxy.localForwardHost,
          remoteForwardPort: settings.remoteProxy.remoteForwardPort,
        });
        return undefined;
      } catch (error) {
        return formatError(error);
      }
    },
  });
  if (proxyUrl === undefined) {
    return false;
  }

  if (!proxyUrl.trim()) {
    await vscode.workspace
      .getConfiguration("autodl")
      .update("remoteProxy.proxyUrl", "", vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      "AutoDL remote proxy URL cleared; proxy forwarding will not be configured.",
    );
    return true;
  }

  const localForwardHost = await vscode.window.showInputBox({
    title: "AutoDL SSH RemoteForward Local Host",
    prompt: "Host on this computer that SSH should forward to from the remote.",
    value: settings.remoteProxy.localForwardHost || "127.0.0.1",
    placeHolder: "127.0.0.1",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim() || /[\r\n]/.test(value)) {
        return "RemoteForward local host cannot be empty or contain line breaks.";
      }
      return undefined;
    },
  });
  if (localForwardHost === undefined) {
    return false;
  }

  const remoteForwardPort = await vscode.window.showInputBox({
    title: "AutoDL Remote Proxy Forward Port",
    prompt: "Use 0 to reuse the port from the proxy URL.",
    value: String(settings.remoteProxy.remoteForwardPort || 0),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = Number(value.trim());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return "Remote forward port must be 0 or an integer between 1 and 65535.";
      }
      return undefined;
    },
  });
  if (remoteForwardPort === undefined) {
    return false;
  }

  const parsedRemoteForwardPort = Number(remoteForwardPort.trim());
  const config = vscode.workspace.getConfiguration("autodl");
  await config.update("remoteProxy.enabled", true, vscode.ConfigurationTarget.Global);
  await config.update("remoteProxy.proxyUrl", proxyUrl.trim(), vscode.ConfigurationTarget.Global);
  await config.update(
    "remoteProxy.localForwardHost",
    localForwardHost.trim(),
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "remoteProxy.remoteForwardPort",
    parsedRemoteForwardPort,
    vscode.ConfigurationTarget.Global,
  );

  const proxy = resolveRemoteProxy({
    enabled: true,
    proxyUrl: proxyUrl.trim(),
    localForwardHost: localForwardHost.trim(),
    remoteForwardPort: parsedRemoteForwardPort,
  });
  const message = proxy
    ? `AutoDL proxy configured: remote ${proxy.remoteForwardPort} -> ${proxy.localHost}:${proxy.localPort}`
    : "AutoDL remote proxy URL is empty; proxy forwarding will not be configured.";
  void vscode.window.showInformationMessage(message);
  return true;
}

async function configureRemoteCommands(): Promise<void> {
  await runSafely(async () => {
    await configureRemoteCommandsCore();
  });
}

async function configureRemoteCommandsCore(): Promise<void> {
  const savedCommands = getSettings().remoteCommands.commands;
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(terminal) Add Remote Command",
        description: "save a shell command",
        id: "addCommand",
      },
      {
        label: "$(file-code) Add Local .sh Script",
        description: "save a script upload command",
        id: "addScript",
      },
      {
        label: "$(trash) Remove Saved Command",
        description: `${savedCommands.length} saved`,
        id: "remove",
      },
      {
        label: "$(settings-gear) Open Remote Command Settings",
        description: "edit JSON settings directly",
        id: "settings",
      },
    ] satisfies Array<vscode.QuickPickItem & { id: string }>,
    {
      title: "AutoDL Remote Commands",
      placeHolder: "Configure reusable commands",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  if (picked.id === "addCommand") {
    const entry = await promptRemoteCommandEntry();
    if (entry) {
      await saveRemoteCommandWithPrompt(entry);
    }
    return;
  }
  if (picked.id === "addScript") {
    const entry = await promptLocalScriptEntry();
    if (entry) {
      await saveRemoteCommandWithPrompt(entry);
    }
    return;
  }
  if (picked.id === "remove") {
    await removeSavedRemoteCommand();
    return;
  }
  await vscode.commands.executeCommand("workbench.action.openSettings", "autodl.remoteCommands");
}

async function runRemoteCommand(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const instance = await resolveInstance(client, item);
    if (!instance) {
      return;
    }
    const entry = await pickRemoteCommandForRun();
    if (!entry) {
      return;
    }
    const uuid = mustInstanceUuid(instance);
    const settings = getSettings();
    const snapshot = await snapshotWithRetry(client, uuid, 3);
    const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(settings));
    await executeRemoteCommand(alias, entry, settings);
  });
}

async function pickRemoteCommandForRun(): Promise<RemoteCommandConfig | undefined> {
  const savedCommands = getSettings().remoteCommands.commands;
  type CommandPick = vscode.QuickPickItem & {
    action?: "input" | "script" | "saved";
    command?: RemoteCommandConfig;
  };
  const items: CommandPick[] = [
    {
      label: "$(terminal) Enter Remote Command...",
      description: "run once or save",
      action: "input",
    },
    {
      label: "$(file-code) Select Local .sh Script...",
      description: "upload, chmod +x, run once or save",
      action: "script",
    },
  ];
  if (savedCommands.length) {
    items.push({ label: "Saved Commands", kind: vscode.QuickPickItemKind.Separator });
    items.push(
      ...savedCommands.map((command) => ({
        label: command.name,
        description: command.type === "localScript" ? "script" : "command",
        detail: command.type === "localScript" ? command.localPath : command.command,
        action: "saved" as const,
        command,
      })),
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "AutoDL Run Remote Command",
    placeHolder: "Enter a command, choose a local .sh, or run a saved command",
    ignoreFocusOut: true,
  });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) {
    return undefined;
  }
  if (picked.action === "saved") {
    return picked.command;
  }
  const entry =
    picked.action === "script" ? await promptLocalScriptEntry() : await promptRemoteCommandEntry();
  if (!entry) {
    return undefined;
  }
  await maybeSaveRemoteCommand(entry);
  return entry;
}

async function promptRemoteCommandEntry(): Promise<RemoteCommandConfig | undefined> {
  const settings = getSettings();
  const command = await vscode.window.showInputBox({
    title: "AutoDL Remote Command",
    prompt: "Shell command executed on the selected AutoDL instance.",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Command cannot be empty."),
  });
  if (!command) {
    return undefined;
  }
  return {
    name: guessRemoteCommandName(command),
    type: "command",
    command: command.trim(),
    cwd: settings.remoteCommands.defaultCwd || "/root",
  };
}

async function promptLocalScriptEntry(): Promise<RemoteCommandConfig | undefined> {
  const settings = getSettings();
  const selected = await vscode.window.showOpenDialog({
    title: "AutoDL Local .sh Script",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "Shell scripts": ["sh"],
      "All files": ["*"],
    },
    openLabel: "Use Script",
  });
  const localPath = selected?.[0]?.fsPath;
  if (!localPath) {
    return undefined;
  }
  return {
    name: path.basename(localPath, path.extname(localPath)) || path.basename(localPath),
    type: "localScript",
    localPath,
    remotePath: defaultRemoteScriptPath(localPath, settings),
    cwd: settings.remoteCommands.defaultCwd || "/root",
  };
}

async function maybeSaveRemoteCommand(entry: RemoteCommandConfig): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Save "${entry.name}" for reuse?`,
    "Save",
    "Run Once",
  );
  if (choice === "Save") {
    await saveRemoteCommandWithPrompt(entry);
  }
}

async function saveRemoteCommandWithPrompt(entry: RemoteCommandConfig): Promise<boolean> {
  const name = await inputValue("Remote command name", entry.name || "AutoDL command");
  if (!name) {
    return false;
  }
  const finalEntry = { ...entry, name: name.trim() };
  const settings = getSettings();
  const existingIndex = settings.remoteCommands.commands.findIndex(
    (command) => command.name.toLowerCase() === finalEntry.name.toLowerCase(),
  );
  const nextCommands = [...settings.remoteCommands.commands];
  if (existingIndex >= 0) {
    const choice = await vscode.window.showWarningMessage(
      `Remote command "${finalEntry.name}" already exists.`,
      "Overwrite",
      "Cancel",
    );
    if (choice !== "Overwrite") {
      return false;
    }
    nextCommands[existingIndex] = finalEntry;
  } else {
    nextCommands.push(finalEntry);
  }
  await vscode.workspace
    .getConfiguration("autodl")
    .update("remoteCommands.commands", nextCommands, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`AutoDL remote command saved: ${finalEntry.name}`);
  return true;
}

async function removeSavedRemoteCommand(): Promise<void> {
  const commands = getSettings().remoteCommands.commands;
  if (!commands.length) {
    void vscode.window.showInformationMessage("No saved AutoDL remote commands.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    commands.map((command) => ({
      label: command.name,
      description: command.type === "localScript" ? "script" : "command",
      detail: command.type === "localScript" ? command.localPath : command.command,
      command,
    })),
    {
      title: "Remove AutoDL Remote Command",
      placeHolder: "Choose a saved command to remove",
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  const nextCommands = commands.filter((command) => command.name !== picked.command.name);
  await vscode.workspace
    .getConfiguration("autodl")
    .update("remoteCommands.commands", nextCommands, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`AutoDL remote command removed: ${picked.command.name}`);
}

async function executeRemoteCommand(
  alias: string,
  entry: RemoteCommandConfig,
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const timeoutMs = remoteCommandTimeoutMs(entry, settings);
  output.show(true);
  output.appendLine("");
  output.appendLine(`Running AutoDL remote command on ${alias}: ${entry.name}`);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AutoDL: running ${entry.name}`,
      cancellable: false,
    },
    async () => {
      if (entry.type === "localScript") {
        return executeRemoteScript(alias, entry, settings, timeoutMs);
      }
      return executeRemoteShellCommand(alias, entry, settings, timeoutMs);
    },
  );
  appendCommandOutput("stdout", result.stdout);
  appendCommandOutput("stderr", result.stderr);
  void vscode.window.showInformationMessage(`AutoDL remote command finished: ${entry.name}`);
}

async function executeRemoteShellCommand(
  alias: string,
  entry: RemoteCommandConfig,
  settings: ReturnType<typeof getSettings>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const command = entry.command?.trim();
  if (!command) {
    throw new Error(`Remote command "${entry.name}" is empty.`);
  }
  const cwd = normalizeRemotePath(entry.cwd || settings.remoteCommands.defaultCwd || "/root");
  const remoteCommand = [`cd ${remoteShellQuote(cwd)}`, command].join("\n");
  return runManagedSshCommand(alias, remoteCommand, timeoutMs);
}

async function executeRemoteScript(
  alias: string,
  entry: RemoteCommandConfig,
  settings: ReturnType<typeof getSettings>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const localPath = entry.localPath?.trim();
  if (!localPath) {
    throw new Error(`Remote script "${entry.name}" does not have a localPath.`);
  }
  const content = await fs.readFile(localPath, "utf8");
  const remotePath = normalizeRemotePath(
    entry.remotePath || defaultRemoteScriptPath(localPath, settings),
  );
  const remoteDirectory = path.posix.dirname(remotePath);
  const cwd = normalizeRemotePath(entry.cwd || settings.remoteCommands.defaultCwd || "/root");
  const command = [
    "set -eu",
    `mkdir -p ${remoteShellQuote(remoteDirectory)}`,
    `cat > ${remoteShellQuote(remotePath)}`,
    `chmod +x ${remoteShellQuote(remotePath)}`,
    `cd ${remoteShellQuote(cwd)}`,
    `if head -n 1 ${remoteShellQuote(remotePath)} | grep -q '^#!'; then ${remoteShellQuote(remotePath)}; elif command -v bash >/dev/null 2>&1; then bash ${remoteShellQuote(remotePath)}; else sh ${remoteShellQuote(remotePath)}; fi`,
  ].join("\n");
  output.appendLine(`Uploading script: ${localPath} -> ${alias}:${remotePath}`);
  return runManagedSshCommand(alias, command, timeoutMs, content);
}

function appendCommandOutput(label: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  output.appendLine(`${label}:`);
  for (const line of trimmed.split(/\r?\n/)) {
    output.appendLine(`  ${line}`);
  }
}

function defaultRemoteScriptPath(
  localPath: string,
  settings: ReturnType<typeof getSettings>,
): string {
  const directory = normalizeRemotePath(
    settings.remoteCommands.defaultRemoteDirectory || "/root/autodl-scripts",
  ).replace(/\/+$/, "");
  const fileName = sanitizeRemoteFileName(path.basename(localPath) || "autodl-command.sh");
  return `${directory}/${fileName}`;
}

function sanitizeRemoteFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "autodl-command.sh";
}

function guessRemoteCommandName(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 40 ? `${compact.slice(0, 37)}...` : compact || "AutoDL command";
}

function remoteCommandTimeoutMs(
  entry: RemoteCommandConfig,
  settings: ReturnType<typeof getSettings>,
): number {
  const seconds = entry.timeoutSeconds || settings.remoteCommands.defaultTimeoutMs / 1000 || 3600;
  const parsed = Number(seconds);
  return (Number.isFinite(parsed) ? Math.max(1, parsed) : 3600) * 1000;
}

function remoteShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

async function openAutoDLSettings(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@ext:happyan.autodl-vscode",
  );
}

async function installRemoteCodexForAlias(
  alias: string,
  settings: ReturnType<typeof getSettings>,
  mode: "auto" | "manual",
): Promise<void> {
  const extensionId = settings.remoteCodex.extensionId || "openai.chatgpt";
  const proxy = resolveRemoteProxy(settings.remoteProxy);
  output.show(true);
  output.appendLine("");
  output.appendLine(
    `${mode === "auto" ? "Auto installing" : "Installing"} remote VS Code extension ${extensionId} on ${alias}.`,
  );
  const serverStatus = await checkRemoteVsCodeServerReady(
    alias,
    Math.min(settings.remoteCodex.installTimeoutMs, 60_000),
  );
  output.appendLine(serverStatus.output);
  if (!serverStatus.ready) {
    void vscode.window.showWarningMessage(
      `AutoDL remote VS Code Server is not ready on ${alias}. Open it with Remote SSH once, then retry Codex install.`,
    );
    return;
  }
  if (proxy) {
    try {
      const remoteSettings = remoteProxySettingsPayload(proxy);
      const proxyResult = await ensureRemoteVsCodeSettings(alias, remoteSettings);
      output.appendLine(
        proxyResult.action === "written"
          ? `Remote proxy settings written: ${proxyResult.settingsPath}`
          : `Remote proxy settings already present; skipped rewrite: ${proxyResult.settingsPath}`,
      );
    } catch (error) {
      output.appendLine(`Warning: failed to write remote proxy settings: ${formatError(error)}`);
    }
  }

  const installResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AutoDL: installing ${extensionId} on ${alias}`,
      cancellable: false,
    },
    () =>
      installRemoteVsCodeExtension({
        alias,
        extensionId,
        proxyUrl: proxy ? remoteProxyUrl(proxy) : undefined,
        timeoutMs: settings.remoteCodex.installTimeoutMs,
      }),
  );
  output.appendLine(
    installResult.output || `VS Code extension install command finished: ${extensionId}`,
  );
  if (installResult.status === "serverNotReady") {
    void vscode.window.showWarningMessage(
      `AutoDL remote VS Code Server is not ready on ${alias}. Open it with Remote SSH once, then retry Codex install.`,
    );
    return;
  }
  await uploadLocalCodexAuthAfterInstall(alias, settings);
  await reloadRemoteWindowAfterCodexInstall(alias, settings);
  void vscode.window.showInformationMessage(`AutoDL remote Codex extension installed: ${alias}`);
}

async function uploadLocalCodexAuthAfterInstall(
  alias: string,
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const localPath = settings.remoteCodex.authJsonPath.trim();
  if (!localPath) {
    output.appendLine("Codex auth upload skipped: autodl.remoteCodex.authJsonPath is empty.");
    return;
  }

  let content: string;
  try {
    content = await fs.readFile(localPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    output.appendLine(
      code === "ENOENT"
        ? `Codex auth upload skipped: local auth file was not found at ${localPath}.`
        : `Warning: failed to read local Codex auth file ${localPath}: ${formatError(error)}`,
    );
    return;
  }

  try {
    const result = await runManagedSshCommand(alias, remoteCodexAuthUploadCommand, 30_000, content);
    if (result.stdout.trim()) {
      output.appendLine(result.stdout.trim());
    }
    if (result.stderr.trim()) {
      output.appendLine(result.stderr.trim());
    }
    output.appendLine(`Codex auth uploaded from ${localPath} to ${alias}:~/.codex/auth.json`);
  } catch (error) {
    output.appendLine(`Warning: failed to upload Codex auth to ${alias}: ${formatError(error)}`);
  }
}

function parseRemoteCodexAuthDownload(
  stdout: string,
): { found: true; content: string } | { found: false } {
  const firstLineEnd = stdout.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? stdout : stdout.slice(0, firstLineEnd)).replace(
    /\r$/,
    "",
  );
  const rest = firstLineEnd === -1 ? "" : stdout.slice(firstLineEnd + 1);
  if (firstLine === remoteCodexAuthFoundMarker) {
    return { found: true, content: rest };
  }
  if (firstLine === remoteCodexAuthMissingMarker) {
    return { found: false };
  }
  throw new Error("Remote Codex auth backup returned an unexpected response.");
}

async function reloadRemoteWindowAfterCodexInstall(
  alias: string,
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const remoteUri = remoteSshUri(alias, settings.openRemotePath);
  const targetAuthority = remoteUri.authority.toLowerCase();
  const currentWindowIsTarget = (vscode.workspace.workspaceFolders || []).some(
    (folder) =>
      folder.uri.scheme === "vscode-remote" &&
      folder.uri.authority.toLowerCase() === targetAuthority,
  );

  let postInstallAction = settings.remoteCodex.postInstallAction;

  if (!settings.remoteCodex.postInstallActionEnabled || postInstallAction === "none") {
    output.appendLine("Remote window post-install action is disabled.");
    const action = currentWindowIsTarget ? "Reconnect Remote Window" : "Open Remote Window";
    const choice = await vscode.window.showInformationMessage(
      `AutoDL remote Codex extension installed on ${alias}. Reconnect the Remote SSH window to enable it cleanly.`,
      action,
    );
    if (choice !== action) {
      return;
    }
    postInstallAction = "reconnect";
  }

  if (postInstallAction === "reload") {
    output.appendLine(`Reloading current Remote SSH window: ${remoteUri.toString()}`);
    if (currentWindowIsTarget) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else {
      await vscode.commands.executeCommand("vscode.openFolder", remoteUri, {
        forceNewWindow: true,
      });
    }
    return;
  }

  output.appendLine(`Reconnecting Remote SSH window: ${remoteUri.toString()}`);
  const replacementStarted = await openReplacementRemoteWindow(remoteUri);
  if (currentWindowIsTarget) {
    if (!replacementStarted) {
      output.appendLine("Replacement Remote SSH window was not started; keeping current window open.");
      return;
    }
    output.appendLine("Replacement Remote SSH window launch was requested.");
    const choice = await vscode.window.showInformationMessage(
      "AutoDL requested a new Remote SSH window. Close this old remote window after you confirm the new one is open.",
      "Close Old Window",
    );
    if (choice === "Close Old Window") {
      await vscode.commands.executeCommand("workbench.action.closeWindow");
    }
  }
}

async function openReplacementRemoteWindow(remoteUri: vscode.Uri): Promise<boolean> {
  if (await spawnCodeNewWindow(remoteUri)) {
    return true;
  }

  const externalUri = remoteSshExternalUri(remoteUri);
  output.appendLine(`VS Code CLI launch failed; opening external URI: ${externalUri.toString()}`);
  try {
    return await vscode.env.openExternal(externalUri);
  } catch (error) {
    output.appendLine(`Failed to open external Remote SSH URI: ${formatError(error)}`);
    return false;
  }
}

async function spawnCodeNewWindow(remoteUri: vscode.Uri): Promise<boolean> {
  const args = ["--new-window", remoteUri.toString(true)];
  for (const command of codeCliCandidates()) {
    output.appendLine(`Opening replacement Remote SSH window with VS Code CLI: ${command}`);
    if (await spawnCodeCommand(command, args)) {
      return true;
    }
  }
  return false;
}

async function spawnCodeCommand(command: string, args: string[]): Promise<boolean> {
  const invocation = codeCommandInvocation(command, args);
  try {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        output.appendLine(`VS Code CLI did not exit after 5s; not treating it as a confirmed launch: ${command}`);
        child.kill();
        finish(false);
      }, 5000);
      child.once("error", (error) => {
        output.appendLine(`Failed to launch VS Code CLI ${command}: ${formatError(error)}`);
        finish(false);
      });
      child.once("exit", (code) => {
        if (code === 0) {
          finish(true);
          return;
        }
        output.appendLine(`VS Code CLI exited before opening a window: ${command} exit=${code}`);
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        if (details) {
          output.appendLine(details.slice(0, 2000));
        }
        finish(false);
      });
    });
  } catch (error) {
    output.appendLine(`Failed to launch VS Code CLI ${command}: ${formatError(error)}`);
    return false;
  }
}

function codeCommandInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const commandLine = [command, ...args].map(quoteWindowsCommandArg).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

function codeCliCandidates(): string[] {
  const commandName = vscode.env.appName.toLowerCase().includes("insiders")
    ? "code-insiders"
    : "code";
  const extension = process.platform === "win32" ? ".cmd" : "";
  const candidates = [
    path.join(path.dirname(process.execPath), "bin", `${commandName}${extension}`),
    `${commandName}${extension}`,
  ];
  if (commandName !== "code") {
    candidates.push(process.platform === "win32" ? "code.cmd" : "code");
  }
  return [...new Set(candidates)];
}

function remoteSshExternalUri(remoteUri: vscode.Uri): vscode.Uri {
  const pathPart = encodeURI(remoteUri.path || "/root");
  return vscode.Uri.parse(`${vscode.env.uriScheme}://vscode-remote/${remoteUri.authority}${pathPart}`);
}

async function resolveInstanceAlias(
  context: vscode.ExtensionContext,
  item?: InstanceItem,
): Promise<{ alias: string; settings: ReturnType<typeof getSettings> } | undefined> {
  const client = await createClient(context);
  if (!client) {
    return undefined;
  }
  const instance = await resolveInstance(client, item);
  if (!instance) {
    return undefined;
  }
  const uuid = mustInstanceUuid(instance);
  const settings = getSettings();
  const snapshot = await snapshotWithRetry(client, uuid, 3);
  const alias = await writeManagedSshHost(uuid, snapshot, managedSshHostOptions(settings));
  return { alias, settings };
}

async function toggleRemoteProxyForAlias(
  alias: string,
  settings: ReturnType<typeof getSettings>,
): Promise<"enabled" | "disabled"> {
  const proxy = resolveRemoteProxy(settings.remoteProxy);
  if (!proxy) {
    throw new Error("AutoDL remote proxy forwarding is not configured.");
  }
  const remoteSettings = remoteProxySettingsPayload(proxy);
  const result = await toggleRemoteVsCodeSettings(alias, remoteSettings);
  output.show(true);
  output.appendLine("");
  output.appendLine(
    `Remote proxy settings ${result.action} for ${alias}: ${result.settingsPath}`,
  );
  output.appendLine(
    `SSH RemoteForward ${proxy.remoteForwardPort} ${proxy.localHost}:${proxy.localPort}`,
  );
  output.appendLine(`Remote http.proxy: ${String(remoteSettings["http.proxy"])}`);
  void vscode.window.showInformationMessage(
    `AutoDL remote proxy ${result.action}: ${alias}`,
  );
  return result.action;
}

async function startFolderSyncForAlias(
  alias: string,
  sync: ReturnType<typeof getSettings>["sync"],
): Promise<void> {
  if (!sync.localFolder) {
    return;
  }
  await startFolderSync({
    alias,
    localFolder: sync.localFolder,
    remoteFolder: sync.remoteFolder,
    intervalMs: sync.intervalMs,
    excludeNames: sync.excludeNames,
    output,
  });
}

function managedSshHostOptions(
  settings: ReturnType<typeof getSettings>,
): ManagedSshHostOptions {
  const proxy = resolveRemoteProxy(settings.remoteProxy);
  return {
    identityFile: settings.sshIdentityFile || undefined,
    remoteForward: proxy
      ? {
          remotePort: proxy.remoteForwardPort,
          localHost: proxy.localHost,
          localPort: proxy.localPort,
        }
      : undefined,
  };
}

async function rememberRecentRemotePath(
  context: vscode.ExtensionContext,
  instanceUuid: string,
  remotePath: string,
): Promise<void> {
  const normalized = normalizeRemotePath(remotePath);
  const pathsByInstance = context.globalState.get<RecentRemotePathsByInstance>(
    recentRemotePathsKey,
    {},
  );
  const paths = new Set(pathsByInstance[instanceUuid] || []);
  paths.add(normalized);
  await context.globalState.update(recentRemotePathsKey, {
    ...pathsByInstance,
    [instanceUuid]: [...paths],
  });
}

function recentRemotePathsForInstance(
  context: vscode.ExtensionContext,
  instanceUuid: string,
): string[] {
  const pathsByInstance = context.globalState.get<RecentRemotePathsByInstance>(
    recentRemotePathsKey,
    {},
  );
  return pathsByInstance[instanceUuid] || [];
}

async function forgetRecentRemotePathsForInstance(
  context: vscode.ExtensionContext,
  instanceUuid: string,
): Promise<void> {
  const pathsByInstance = context.globalState.get<RecentRemotePathsByInstance>(
    recentRemotePathsKey,
    {},
  );
  if (!pathsByInstance[instanceUuid]) {
    return;
  }
  const next = { ...pathsByInstance };
  delete next[instanceUuid];
  await context.globalState.update(recentRemotePathsKey, next);
}

function normalizeRemotePath(remotePath: string): string {
  const trimmed = remotePath.trim() || "/root";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function setSyncFolders(): Promise<void> {
  await runSafely(async () => {
    const settings = getSettings();
    const selected = await vscode.window.showOpenDialog({
      title: "AutoDL Sync Local Folder",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: settings.sync.localFolder
        ? vscode.Uri.file(settings.sync.localFolder)
        : vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: "Use Folder",
    });
    const localFolder = selected?.[0]?.fsPath;
    if (!localFolder) {
      return;
    }
    const remoteFolder = await inputValue(
      "AutoDL sync remote folder",
      settings.sync.remoteFolder || settings.openRemotePath || "/root/autodl-sync",
    );
    if (!remoteFolder) {
      return;
    }
    const config = vscode.workspace.getConfiguration("autodl");
    await config.update("sync.localFolder", localFolder, vscode.ConfigurationTarget.Global);
    await config.update("sync.remoteFolder", remoteFolder.trim(), vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `AutoDL folder sync configured: ${localFolder} <-> ${remoteFolder.trim()}`,
    );
  });
}

async function stopFolderSyncCommand(): Promise<void> {
  const aliases = activeFolderSyncAliases();
  if (!aliases.length) {
    void vscode.window.showInformationMessage("No active AutoDL folder sync sessions.");
    return;
  }
  const picked =
    aliases.length === 1
      ? aliases[0]
      : await vscode.window.showQuickPick(["All", ...aliases], {
          title: "Stop AutoDL folder sync",
        });
  if (!picked) {
    return;
  }
  const stopped = picked === "All" ? stopAllFolderSync() : Number(stopFolderSync(picked));
  void vscode.window.showInformationMessage(`Stopped ${stopped} AutoDL folder sync session(s).`);
}

async function powerOffIfNeeded(client: AutoDLClient, uuid: string): Promise<void> {
  try {
    await client.powerOff(uuid);
  } catch (error) {
    if (isAlreadyStoppedError(error)) {
      output.appendLine(`Already stopped: ${uuid}`);
      return;
    }
    throw error;
  }
}

async function promptServerPayload(
  defaults: CreateInstancePayload,
  sshPublicKey: string,
): Promise<CreateInstancePayload | undefined> {
  const gpu = await pickGpuSpec();
  if (!gpu) {
    return undefined;
  }
  const gpuSpec = gpu.gpuSpecUuid;
  const gpuAmount = await inputNumber("GPU amount", defaults.req_gpu_amount);
  if (gpuAmount === undefined) {
    return undefined;
  }

  const image = await pickImage(defaults.image_uuid);
  if (!image) {
    return undefined;
  }
  const imageUuid = image.imageUuid;
  const cudaMin = await inputNumber("CUDA lower bound", defaults.cuda_v_from || image.cudaMin);
  if (cudaMin === undefined) {
    return undefined;
  }
  const systemDisk = await inputNumber(
    "Extra system storage GB",
    defaults.expand_system_disk_by_gb,
  );
  if (systemDisk === undefined) {
    return undefined;
  }
  const dataCenters = await inputValue(
    "Data centers, comma separated; empty means AutoDL chooses",
    defaults.data_center_list?.join(",") || "",
    false,
  );
  if (dataCenters === undefined) {
    return undefined;
  }
  const name = await inputValue("Instance name, optional", defaults.instance_name || "", false);
  if (name === undefined) {
    return undefined;
  }
  const startCommand = await inputValue(
    "Start command, optional",
    defaults.start_command || "",
    false,
  );
  if (startCommand === undefined) {
    return undefined;
  }

  const payload: CreateInstancePayload = {
    req_gpu_amount: gpuAmount,
    expand_system_disk_by_gb: systemDisk,
    gpu_spec_uuid: gpuSpec,
    image_uuid: imageUuid,
    cuda_v_from: cudaMin,
  };
  const centers = dataCenters
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (centers.length) {
    payload.data_center_list = centers;
  }
  if (name.trim()) {
    payload.instance_name = name.trim();
  }
  const mergedStartCommand = mergeStartCommandWithSshKey(startCommand, sshPublicKey);
  if (mergedStartCommand) {
    payload.start_command = mergedStartCommand;
  }
  return payload;
}

async function pickGpuSpec(): Promise<GpuCatalogItem | undefined> {
  const custom: GpuCatalogItem = {
    label: "Custom GPU spec UUID",
    description: "manual",
    detail: "Enter an AutoDL gpu_spec_uuid manually",
    gpuSpecUuid: "",
  };
  const picked = await vscode.window.showQuickPick([...currentGpuCatalog(), custom], {
    title: "Select GPU type",
    placeHolder: "Choose a readable GPU model",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.gpuSpecUuid) {
    return picked;
  }
  const manual = await inputValue("GPU spec UUID", "");
  if (!manual) {
    return undefined;
  }
  return {
    label: manual,
    description: manual,
    gpuSpecUuid: manual,
  };
}

async function pickImage(defaultImageUuid: string): Promise<ImageCatalogItem | undefined> {
  const picked = await vscode.window.showQuickPick(currentImageCatalog(), {
    title: "Select image",
    placeHolder: "Choose a base image or enter a custom image UUID",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.imageUuid) {
    return picked;
  }
  const manual = await inputValue("Image UUID", defaultImageUuid);
  if (!manual) {
    return undefined;
  }
  return {
    label: manual,
    description: manual,
    imageUuid: manual,
    cudaMin: 130,
  };
}

async function setSshPublicKey(): Promise<void> {
  await runSafely(async () => {
    const detected = await readDefaultPublicKey();
    const key = await vscode.window.showInputBox({
      title: "AutoDL SSH Public Key",
      prompt: "Public key injected during new instance creation. Existing instances still use password unless the key is already installed.",
      value: getSettings().sshPublicKey || detected.publicKey,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Public key cannot be empty.";
        }
        if (!/^ssh-(ed25519|rsa|ecdsa)\s+/.test(trimmed)) {
          return "Expected an OpenSSH public key, for example ssh-ed25519 AAAA...";
        }
        return undefined;
      },
    });
    if (!key) {
      return;
    }
    await vscode.workspace
      .getConfiguration("autodl")
      .update("sshPublicKey", key.trim(), vscode.ConfigurationTarget.Global);
    if (detected.identityFile) {
      await vscode.workspace
        .getConfiguration("autodl")
        .update("sshIdentityFile", detected.identityFile, vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showInformationMessage("AutoDL SSH public key saved.");
  });
}

async function cleanSshConfig(): Promise<void> {
  await runSafely(async () => {
    const choice = await vscode.window.showWarningMessage(
      "Remove all SSH config blocks managed by AutoDL Control?",
      { modal: true },
      "Clean",
    );
    if (choice !== "Clean") {
      return;
    }
    const removed = await removeAllManagedSshHosts();
    void vscode.window.showInformationMessage(`Removed ${removed} AutoDL SSH config block(s).`);
  });
}

async function readDefaultPublicKey(): Promise<{ publicKey: string; identityFile: string }> {
  const sshDir = path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"]) {
    try {
      const value = await fs.readFile(path.join(sshDir, name), "utf8");
      if (value.trim()) {
        return {
          publicKey: value.trim(),
          identityFile: path.join(sshDir, name.replace(/\.pub$/, "")),
        };
      }
    } catch {
      // Try the next conventional key path.
    }
  }
  return { publicKey: "", identityFile: "" };
}

async function inputValue(
  title: string,
  value: string,
  required = true,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    value,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (required && !input.trim()) {
        return `${title} is required.`;
      }
      return undefined;
    },
  });
}

async function inputNumber(title: string, value: number): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: String(value),
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return `${title} must be a non-negative integer.`;
      }
      return undefined;
    },
  });
  if (input === undefined) {
    return undefined;
  }
  return Number(input);
}

async function pickProfile(): Promise<string | undefined> {
  const settings = getSettings();
  const selected = await vscode.window.showQuickPick(profileQuickPickItems(settings.quickCreate), {
    title: "AutoDL Quick Create",
    placeHolder: "Choose a machine profile",
  });
  return selected?.description;
}

async function resolveInstance(
  client: AutoDLClient,
  item?: InstanceItem,
): Promise<AutoDLInstance | undefined> {
  if (item) {
    return item.instance;
  }

  const cached = provider.currentInstances();
  const instances = cached.length ? cached : await listAllInstances(client);
  const picked = await vscode.window.showQuickPick(
    instances
      .filter((instance) => instanceUuidOf(instance))
      .map((instance) => ({
        label: instance.name || mustInstanceUuid(instance),
        description: mustInstanceUuid(instance),
        detail: [instance.status, instance.gpu_spec_uuid, instance.region_name || instance.region_sign]
          .filter(Boolean)
          .join(" | "),
        instance,
      })),
    {
      title: "AutoDL Instance",
      placeHolder: "Choose an instance",
    },
  );
  return picked?.instance;
}

function mustInstanceUuid(instance: AutoDLInstance): string {
  const uuid = instanceUuidOf(instance);
  if (!uuid) {
    throw new Error("Instance does not contain a UUID.");
  }
  return uuid;
}

async function runSafely(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = reportErrorToOutput(error);
    void vscode.window.showErrorMessage(message);
  }
}

function reportErrorToOutput(error: unknown): string {
  const message = formatError(error);
  output.show(true);
  output.appendLine("");
  output.appendLine(`Error: ${message}`);
  if (error instanceof AutoDLApiError) {
    if (error.endpoint) {
      output.appendLine(`Endpoint: ${error.endpoint}`);
    }
    if (error.payload) {
      output.appendLine(`Payload: ${JSON.stringify(error.payload)}`);
    }
    if (error.requestId) {
      output.appendLine(`Request ID: ${error.requestId}`);
    }
    if (error.code === "RequestParameterIsWrong") {
      output.appendLine(
        "Hint: check the endpoint payload above. For quick-create, common causes are cuda_min/cuda_v_from, image_uuid, gpu_spec_uuid, gpu_amount, and system_disk.",
      );
    }
    if (error.code === "NetworkError") {
      output.appendLine(
        "Hint: this is a network/TLS failure before AutoDL returned a response. Check local VPN/proxy, DNS, firewall, and autodl.apiBaseUrl.",
      );
    }
  }
  return message;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
