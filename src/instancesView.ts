import * as vscode from "vscode";

import { instanceUuidOf } from "./client";
import { AutoDLInstance } from "./types";

export interface InstancesState {
  hasToken: boolean;
  instances: AutoDLInstance[];
}

type TreeNode = InstanceItem | DetailItem | ActionItem;

export class InstancesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  private instances: AutoDLInstance[] = [];

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly loadState: () => Promise<InstancesState>,
    private readonly onError: (error: unknown) => void,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof InstanceItem) {
      return instanceDetailItems(element.instance);
    }
    if (element) {
      return [];
    }

    try {
      const state = await this.loadState();
      this.instances = state.instances;
      if (state.instances.length > 0) {
        return state.instances.map((instance) => new InstanceItem(instance));
      }
      return emptyStateItems(state.hasToken);
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
    const status = instance.status || "unknown";
    const displayName = instance.name || instance.gpu_alias_name || instance.gpu_name || uuid;
    super(displayName, vscode.TreeItemCollapsibleState.Expanded);

    this.id = uuid;
    this.description = status;
    this.tooltip = instanceTooltip(instance);
    this.iconPath = iconForStatus(status);
  }
}

class DetailItem extends vscode.TreeItem {
  constructor(label: string, value: string | number | undefined) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value === undefined || value === "" ? "-" : String(value);
    this.iconPath = new vscode.ThemeIcon("circle-small");
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(
    label: string,
    command: string,
    icon: string,
    description?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command,
      title: label,
    };
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

function emptyStateItems(hasToken: boolean): ActionItem[] {
  if (!hasToken) {
    return [
      new ActionItem("Set Token", "autodl.setToken", "key", "required before API calls"),
      new ActionItem("Quick Create", "autodl.quickCreate", "zap", "create from default profiles"),
    ];
  }
  return [
    new ActionItem("Quick Create", "autodl.quickCreate", "zap", "create from default profiles"),
    new ActionItem("Select Server", "autodl.selectServer", "server", "customize profile fields"),
    new ActionItem("Refresh", "autodl.refresh", "refresh", "reload instances"),
  ];
}

function instanceDetailItems(instance: AutoDLInstance): DetailItem[] {
  const uuid = instanceUuidOf(instance) || "";
  const gpuName = instance.gpu_alias_name || instance.gpu_name || instance.gpu_spec_uuid;
  const region = instance.region_name || instance.region_sign;
  return [
    new DetailItem("UUID", uuid),
    new DetailItem("GPU", gpuName),
    new DetailItem("GPU Count", instance.req_gpu_amount),
    new DetailItem("Region", region),
    new DetailItem("Charge", instance.charge_type),
    new DetailItem("PAYG Price", instance.payg_price),
    new DetailItem("Started", timeValue(instance.started_at)),
    new DetailItem("Created", timeValue(instance.created_at)),
  ].filter((item) => item.description !== "-");
}

function instanceTooltip(instance: AutoDLInstance): string {
  return [
    `UUID: ${instanceUuidOf(instance) || ""}`,
    `Name: ${instance.name || ""}`,
    `Status: ${instance.status || ""}`,
    `GPU: ${instance.gpu_alias_name || instance.gpu_name || instance.gpu_spec_uuid || ""}`,
    `Amount: ${instance.req_gpu_amount ?? ""}`,
    `Region: ${instance.region_name || instance.region_sign || ""}`,
    `Charge: ${instance.charge_type || ""}`,
    `PAYG Price: ${instance.payg_price ?? ""}`,
    `Started: ${timeValue(instance.started_at)}`,
  ].join("\n");
}

function timeValue(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.Valid && record.Time) {
      return String(record.Time);
    }
    if (record.time) {
      return String(record.time);
    }
  }
  return String(value);
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
