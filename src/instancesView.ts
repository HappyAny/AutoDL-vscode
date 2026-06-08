import * as vscode from "vscode";

import { currentGpuCatalog } from "./catalog";
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
      await vscode.commands.executeCommand("setContext", "autodl.hasToken", state.hasToken);
      await vscode.commands.executeCommand(
        "setContext",
        "autodl.hasInstances",
        state.instances.length > 0,
      );
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
  constructor(readonly instance: AutoDLInstance) {
    const uuid = instanceUuidOf(instance) || "unknown";
    const status = instance.status || "unknown";
    const displayName = instance.name || uuid;
    super(displayName, vscode.TreeItemCollapsibleState.Expanded);

    this.id = uuid;
    this.description = status;
    this.tooltip = instanceTooltip(instance);
    this.iconPath = iconForStatus(status);
    this.contextValue = instanceContextValue(status);
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
  const gpuName = displayGpu(instance);
  const gpuSpec = instance.gpu_spec_uuid ? ` (${instance.gpu_spec_uuid})` : "";
  const region = instance.region_name || instance.region_sign;
  return [
    new DetailItem("GPU", gpuName ? `${gpuName}${gpuSpec}` : undefined),
    new DetailItem("GPU Count", instance.req_gpu_amount),
    new DetailItem("CPU", displayCpu(instance)),
    new DetailItem("Region", region),
    new DetailItem("Charge", displayCharge(instance.charge_type)),
    new DetailItem("折扣后按量价格", displayPrice(instance.payg_price)),
    new DetailItem("原按量价格", displayPrice(instance.origin_pay_price)),
    new DetailItem("Started", startedValue(instance.started_at)),
    new DetailItem("Created", timeValue(instance.created_at)),
  ].filter((item) => item.description !== "-");
}

function instanceTooltip(instance: AutoDLInstance): string {
  return tooltipLines([
    ["Name", instance.name],
    ["UUID", instanceUuidOf(instance)],
    ["Status", instance.status],
    ["GPU", displayGpu(instance)],
    ["GPU Spec", instance.gpu_spec_uuid],
    ["GPU Count", instance.req_gpu_amount],
    ["CPU", displayCpu(instance)],
    ["Region", instance.region_name || instance.region_sign],
    ["Charge", displayCharge(instance.charge_type)],
    ["折扣后按量价格", displayPrice(instance.payg_price)],
    ["原按量价格", displayPrice(instance.origin_pay_price)],
    ["Started", startedValue(instance.started_at)],
  ]);
}

function displayGpu(instance: AutoDLInstance): string {
  const explicit =
    stringField(instance, "gpu_alias_name") ||
    stringField(instance, "snapshot_gpu_alias_name") ||
    stringField(instance, "gpu_name") ||
    stringField(instance, "gpu_model");
  if (explicit) {
    return explicit;
  }
  const spec = stringField(instance, "gpu_spec_uuid");
  const known = currentGpuCatalog().find((item) => item.gpuSpecUuid === spec);
  return known?.label || spec;
}

function displayCpu(instance: AutoDLInstance): string {
  const parts = [
    stringField(instance, "cpu_name") ||
      stringField(instance, "cpu_model") ||
      stringField(instance, "cpu_arch") ||
      stringField(instance, "chip_corp"),
    stringField(instance, "cpu_num") ||
      stringField(instance, "cpu_count") ||
      stringField(instance, "cpu_cores") ||
      stringField(instance, "req_cpu_num") ||
      stringField(instance, "vcpu_num"),
  ].filter(Boolean);
  return parts.join(" / ");
}

function displayCharge(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value.toLowerCase();
  const labels: Record<string, string> = {
    payg: "按量计费",
    postpaid: "按量计费",
    "post-paid": "按量计费",
    prepaid: "包年包月",
    "pre-paid": "包年包月",
    monthly: "包月",
    hourly: "按小时",
    free: "免费",
  };
  const label = labels[normalized];
  return label ? `${label} (${value})` : value;
}

function displayPrice(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return String(value);
}

function tooltipLines(entries: Array<[string, unknown]>): string {
  return entries
    .map(([label, value]) => tooltipLine(label, value))
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function tooltipLine(label: string, value: unknown): string | undefined {
  const text = tooltipValue(value);
  return text ? `${label}: ${text}` : undefined;
}

function tooltipValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).trim();
  return text === "-" ? "" : text;
}

function stringField(instance: AutoDLInstance, key: string): string {
  const value = instance[key];
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return String(value);
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
    if (record.Time) {
      return String(record.Time);
    }
    if (record.time) {
      return String(record.time);
    }
    if (record.value) {
      return String(record.value);
    }
    return "";
  }
  return String(value);
}

function startedValue(value: unknown): string {
  if (!value) {
    return "暂未启动";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.Valid === false) {
      return "暂未启动";
    }
  }
  return timeValue(value) || "暂未启动";
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

function instanceContextValue(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "running") {
    return "autodlInstanceRunning";
  }
  if (normalized === "stopped" || normalized === "shutdown") {
    return "autodlInstanceShutdown";
  }
  return "autodlInstanceOther";
}
