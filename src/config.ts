import * as vscode from "vscode";

import {
  CreateInstancePayload,
  QuickCreateBuildResult,
  QuickCreateConfig,
  QuickCreateProfile,
} from "./types";

const TOKEN_KEY = "autodl.token";

export const DEFAULT_QUICK_CREATE: QuickCreateConfig = {
  defaults: {
    image_uuid: "base-image-l2t43iu6uk",
    cuda_min: 130,
    gpu_amount: 1,
    system_disk: 0,
    data_centers: [],
  },
  profiles: {
    low: {
      label: "Low 4080(S) 32G",
      gpu_spec_uuid: "v-32g-p",
    },
    mid: {
      label: "Mid 5090 32G",
      gpu_spec_uuid: "5090-p",
    },
    high: {
      label: "High RTX PRO 6000",
      gpu_spec_uuid: "pro6000-p",
    },
  },
};

export interface ExtensionSettings {
  apiBaseUrl: string;
  openRemotePath: string;
  waitTimeoutMs: number;
  waitIntervalMs: number;
  quickCreate: QuickCreateConfig;
}

export function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("autodl");
  return {
    apiBaseUrl: config.get<string>("apiBaseUrl", "https://api.autodl.com"),
    openRemotePath: config.get<string>("openRemotePath", "/root"),
    waitTimeoutMs: config.get<number>("waitTimeoutSeconds", 900) * 1000,
    waitIntervalMs: config.get<number>("waitIntervalSeconds", 5) * 1000,
    quickCreate: normalizeQuickCreateConfig(
      config.get<Partial<QuickCreateConfig>>("quickCreate", DEFAULT_QUICK_CREATE),
    ),
  };
}

export async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(TOKEN_KEY);
  return stored || process.env.AUTODL_TOKEN;
}

export async function promptAndStoreToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: "AutoDL Token",
    prompt: "Paste your AutoDL developer token. It will be stored in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Token cannot be empty."),
  });
  if (!token) {
    return undefined;
  }
  await context.secrets.store(TOKEN_KEY, token.trim());
  return token.trim();
}

export async function ensureToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await getToken(context);
  if (token) {
    return token;
  }
  const choice = await vscode.window.showWarningMessage(
    "AutoDL token is not configured.",
    "Set Token",
  );
  if (choice !== "Set Token") {
    return undefined;
  }
  return promptAndStoreToken(context);
}

export async function clearToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(TOKEN_KEY);
}

export function buildQuickCreatePayload(
  profileName: string,
  quickCreate: QuickCreateConfig,
): QuickCreateBuildResult {
  const profile = quickCreate.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown quick-create profile: ${profileName}`);
  }

  const defaults = quickCreate.defaults;
  const imageUuid = profile.image_uuid || defaults.image_uuid;
  if (!imageUuid) {
    throw new Error("quickCreate.defaults.image_uuid is required.");
  }

  const payload: CreateInstancePayload = {
    req_gpu_amount: numberValue(profile.gpu_amount, defaults.gpu_amount, "gpu_amount"),
    expand_system_disk_by_gb: numberValue(profile.system_disk, defaults.system_disk, "system_disk"),
    gpu_spec_uuid: stringValue(profile.gpu_spec_uuid, "gpu_spec_uuid"),
    image_uuid: imageUuid,
    cuda_v_from: numberValue(profile.cuda_min, defaults.cuda_min, "cuda_min"),
  };

  const dataCenters = profile.data_centers || defaults.data_centers;
  if (dataCenters?.length) {
    payload.data_center_list = dataCenters;
  }
  if (profile.name?.trim()) {
    payload.instance_name = profile.name.trim();
  }
  const startCommand = profile.start_command ?? defaults.start_command;
  if (startCommand?.trim()) {
    payload.start_command = startCommand.trim();
  }

  return {
    profileName,
    label: profile.label || profileName,
    payload,
  };
}

export function profileQuickPickItems(quickCreate: QuickCreateConfig): vscode.QuickPickItem[] {
  return Object.entries(quickCreate.profiles).map(([key, profile]) => ({
    label: profile.label || key,
    description: key,
    detail: `${profile.gpu_spec_uuid}, ${profile.gpu_amount || quickCreate.defaults.gpu_amount} GPU, CUDA ${profile.cuda_min || quickCreate.defaults.cuda_min}`,
  }));
}

function normalizeQuickCreateConfig(value: Partial<QuickCreateConfig>): QuickCreateConfig {
  const defaults = {
    ...DEFAULT_QUICK_CREATE.defaults,
    ...(value.defaults || {}),
  };
  const profiles: Record<string, QuickCreateProfile> = {
    ...DEFAULT_QUICK_CREATE.profiles,
    ...(value.profiles || {}),
  };
  return { defaults, profiles };
}

function stringValue(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }
  return value.trim();
}

function numberValue(value: unknown, fallback: number, fieldName: string): number {
  const raw = value ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number.`);
  }
  return parsed;
}
