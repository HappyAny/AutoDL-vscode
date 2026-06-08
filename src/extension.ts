import * as vscode from "vscode";

import {
  AutoDLClient,
  extractInstanceUuid,
  instanceUuidOf,
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
  profileQuickPickItems,
  promptAndStoreToken,
} from "./config";
import { InstancesProvider, InstanceItem } from "./instancesView";
import { connectWithRemoteSsh, formatSnapshotSummary, jupyterUrl } from "./ssh";
import { AutoDLInstance } from "./types";

let output: vscode.OutputChannel;
let provider: InstancesProvider;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("AutoDL");
  provider = new InstancesProvider(async () => {
    const token = await getToken(context);
    if (!token) {
      return [];
    }
    return listAllInstances(new AutoDLClient(token, getSettings().apiBaseUrl));
  });

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
    const plan = buildQuickCreatePayload(selectedProfile, settings.quickCreate);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AutoDL quick create: ${plan.label}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Creating instance" });
        const created = await client.createInstance(plan.payload);
        const instanceUuid = extractInstanceUuid(created.data);
        if (!instanceUuid) {
          throw new Error("Create API did not return an instance UUID.");
        }

        progress.report({ message: `Created ${instanceUuid}; reading snapshot` });
        const snapshot = await snapshotWithRetry(client, instanceUuid);
        output.show(true);
        output.appendLine("");
        output.appendLine(`Created AutoDL instance with profile ${plan.profileName}.`);
        output.appendLine(formatSnapshotSummary(instanceUuid, snapshot));

        progress.report({ message: "Opening Remote SSH" });
        await connectWithRemoteSsh(instanceUuid, snapshot, settings.openRemotePath, output);
      },
    );

    provider.refresh();
  });
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
    await connectWithRemoteSsh(uuid, snapshot, getSettings().openRemotePath, output);
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
    await client.powerOff(uuid);
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
      await client.powerOff(uuid);
      await waitForStatus(client, uuid, "stopped", getSettings().waitTimeoutMs, getSettings().waitIntervalMs);
    }
    await client.release(uuid);
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
            await client.powerOff(uuid);
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
        }
      },
    );

    provider.refresh();
    void vscode.window.showInformationMessage("AutoDL quick close completed.");
  });
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
    const message = error instanceof Error ? error.message : String(error);
    output.show(true);
    output.appendLine("");
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(message);
  }
}
