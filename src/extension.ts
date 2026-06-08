import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { GPU_CATALOG, IMAGE_CATALOG, GpuCatalogItem, ImageCatalogItem } from "./catalog";
import {
  AutoDLApiError,
  AutoDLClient,
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
} from "./config";
import { InstancesProvider, InstanceItem } from "./instancesView";
import {
  connectWithRemoteSsh,
  formatSnapshotSummary,
  jupyterUrl,
  removeAllManagedSshHosts,
  removeManagedSshHost,
} from "./ssh";
import { AutoDLInstance, CreateInstancePayload, QuickCreateBuildResult } from "./types";

let output: vscode.OutputChannel;
let provider: InstancesProvider;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("AutoDL");
  provider = new InstancesProvider(async () => {
    const token = await getToken(context);
    if (!token) {
      return { hasToken: false, instances: [] };
    }
    return {
      hasToken: true,
      instances: await listAllInstances(new AutoDLClient(token, getSettings().apiBaseUrl)),
    };
  }, reportErrorToOutput);

  context.subscriptions.push(output);
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
    vscode.commands.registerCommand("autodl.quickCreate", () => quickCreate(context)),
    vscode.commands.registerCommand("autodl.selectServer", () => selectServer(context)),
    vscode.commands.registerCommand("autodl.setSshPublicKey", () => setSshPublicKey()),
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
    vscode.commands.registerCommand("autodl.release", (item?: InstanceItem) =>
      releaseInstance(context, item),
    ),
    vscode.commands.registerCommand("autodl.quickCloseAll", () => quickCloseAll(context)),
  );
}

export function deactivate(): void {
  // No persistent runtime resources.
}

async function createClient(context: vscode.ExtensionContext): Promise<AutoDLClient | undefined> {
  const token = await ensureToken(context);
  if (!token) {
    return undefined;
  }
  return new AutoDLClient(token, getSettings().apiBaseUrl);
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
    await connectWithRemoteSsh(
      uuid,
      snapshot,
      settings.openRemotePath,
      output,
      settings.sshIdentityFile,
    );
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
    await waitForStatus(client, uuid, "stopped", getSettings().waitTimeoutMs, getSettings().waitIntervalMs);
    provider.refresh();
    void vscode.window.showInformationMessage(`AutoDL instance stopped: ${uuid}`);
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
      `Release AutoDL instance ${uuid}? This cannot be undone.`,
      { modal: true },
      "Release",
    );
    if (choice !== "Release") {
      return;
    }
    if (needsPowerOff(instance)) {
      await powerOffIfNeeded(client, uuid);
      await waitForStatus(client, uuid, "stopped", getSettings().waitTimeoutMs, getSettings().waitIntervalMs);
    }
    await client.release(uuid);
    await removeManagedSshHost(uuid);
    provider.refresh();
    void vscode.window.showInformationMessage(`AutoDL instance released: ${uuid}`);
  });
}

async function quickCloseAll(context: vscode.ExtensionContext): Promise<void> {
  await runSafely(async () => {
    const client = await createClient(context);
    if (!client) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Stop and release all active AutoDL instances? This cannot be undone.",
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
        const instances = (await listAllInstances(client)).filter(isActiveInstance);
        output.show(true);
        output.appendLine("");
        output.appendLine(`Quick close target count: ${instances.length}`);

        for (let index = 0; index < instances.length; index += 1) {
          const instance = instances[index];
          const uuid = mustInstanceUuid(instance);
          progress.report({ message: `${index + 1}/${instances.length}: ${uuid}` });
          if (needsPowerOff(instance)) {
            output.appendLine(`Stopping ${uuid}`);
            await powerOffIfNeeded(client, uuid);
            await waitForStatus(
              client,
              uuid,
              "stopped",
              getSettings().waitTimeoutMs,
              getSettings().waitIntervalMs,
            );
          }
          output.appendLine(`Releasing ${uuid}`);
          await client.release(uuid);
          await removeManagedSshHost(uuid);
        }
      },
    );

    provider.refresh();
    void vscode.window.showInformationMessage("AutoDL quick close completed.");
  });
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
  const picked = await vscode.window.showQuickPick([...GPU_CATALOG, custom], {
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
  const picked = await vscode.window.showQuickPick(IMAGE_CATALOG, {
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
  const message = error instanceof Error ? error.message : String(error);
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
  }
  return message;
}
