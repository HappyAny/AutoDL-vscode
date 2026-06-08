import * as vscode from "vscode";

import { instanceUuidOf } from "./client";
import { AutoDLInstance } from "./types";

export class InstancesProvider implements vscode.TreeDataProvider<InstanceItem> {
  private readonly changed = new vscode.EventEmitter<InstanceItem | undefined>();
  private instances: AutoDLInstance[] = [];

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly loadInstances: () => Promise<AutoDLInstance[]>,
    private readonly onError: (error: unknown) => void,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: InstanceItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: InstanceItem): Promise<InstanceItem[]> {
    if (element) {
      return [];
    }

    try {
      this.instances = await this.loadInstances();
      return this.instances.map((instance) => new InstanceItem(instance));
    } catch (error) {
      this.onError(error);
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  currentInstances(): AutoDLInstance[] {
    return [...this.instances];
  }
}

export class InstanceItem extends vscode.TreeItem {
  readonly contextValue = "autodlInstance";

  constructor(readonly instance: AutoDLInstance) {
    const uuid = instanceUuidOf(instance) || "unknown";
    const name = instance.name || uuid;
    super(name, vscode.TreeItemCollapsibleState.None);

    const status = instance.status || "unknown";
    const gpu = instance.gpu_spec_uuid || "";
    const region = instance.region_name || instance.region_sign || "";
    this.id = uuid;
    this.description = [status, gpu, region].filter(Boolean).join(" | ");
    this.tooltip = [
      `UUID: ${uuid}`,
      `Name: ${instance.name || ""}`,
      `Status: ${status}`,
      `GPU: ${gpu}`,
      `Amount: ${instance.req_gpu_amount ?? ""}`,
      `Region: ${region}`,
      `Charge: ${instance.charge_type || ""}`,
    ].join("\n");
    this.iconPath = iconForStatus(status);
  }
}

function iconForStatus(status: string): vscode.ThemeIcon {
  const normalized = status.toLowerCase();
  if (normalized === "running") {
    return new vscode.ThemeIcon("vm-running");
  }
  if (normalized === "stopped" || normalized === "shutdown") {
    return new vscode.ThemeIcon("debug-stop");
  }
  return new vscode.ThemeIcon("vm");
}
