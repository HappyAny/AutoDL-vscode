import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

import {
  AutoDLInstance,
  AutoDLListData,
  AutoDLPrivateImage,
  AutoDLResponse,
  AutoDLSnapshot,
  CreateInstancePayload,
} from "./types";

const networkRetryAttempts = 3;
const retryBaseDelayMs = 500;
const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export class AutoDLApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly requestId?: string,
    readonly endpoint?: string,
    readonly payload?: object,
  ) {
    super(message);
  }
}

export class AutoDLClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async createInstance(payload: CreateInstancePayload): Promise<AutoDLResponse<unknown>> {
    return this.request("POST", "/api/v1/dev/instance/pro/create", payload);
  }

  async snapshot(instanceUuid: string): Promise<AutoDLResponse<AutoDLSnapshot>> {
    return this.request("GET", "/api/v1/dev/instance/pro/snapshot", {
      instance_uuid: instanceUuid,
    });
  }

  async status(instanceUuid: string): Promise<AutoDLResponse<string>> {
    return this.request("GET", "/api/v1/dev/instance/pro/status", {
      instance_uuid: instanceUuid,
    });
  }

  async listInstances(
    pageIndex: number,
    pageSize: number,
  ): Promise<AutoDLResponse<AutoDLListData<AutoDLInstance>>> {
    return this.request("POST", "/api/v1/dev/instance/pro/list", {
      page_index: pageIndex,
      page_size: pageSize,
    });
  }

  async listPrivateImages(
    pageIndex: number,
    pageSize: number,
  ): Promise<AutoDLResponse<AutoDLListData<AutoDLPrivateImage>>> {
    return this.request("POST", "/api/v1/dev/instance/pro/image/private/list", {
      page_index: pageIndex,
      page_size: pageSize,
    });
  }

  async powerOff(instanceUuid: string): Promise<AutoDLResponse<unknown>> {
    return this.request("POST", "/api/v1/dev/instance/pro/power_off", {
      instance_uuid: instanceUuid,
    });
  }

  async powerOn(instanceUuid: string): Promise<AutoDLResponse<unknown>> {
    return this.request("POST", "/api/v1/dev/instance/pro/power_on", {
      instance_uuid: instanceUuid,
      payload: "gpu",
    });
  }

  async release(instanceUuid: string): Promise<AutoDLResponse<unknown>> {
    return this.request("POST", "/api/v1/dev/instance/pro/release", {
      instance_uuid: instanceUuid,
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    payload: object,
  ): Promise<AutoDLResponse<T>> {
    try {
      return await this.sendRequestWithRetry<T>(method, path, payload, "body");
    } catch (error) {
      if (
        method === "GET" &&
        error instanceof AutoDLApiError &&
        error.code === "RequestParameterIsWrong"
      ) {
        return this.sendRequestWithRetry<T>(method, path, payload, "query");
      }
      throw error;
    }
  }

  private async sendRequestWithRetry<T>(
    method: "GET" | "POST",
    path: string,
    payload: object,
    payloadMode: "body" | "query",
  ): Promise<AutoDLResponse<T>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= networkRetryAttempts; attempt += 1) {
      try {
        return await this.sendRequest<T>(method, path, payload, payloadMode);
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === networkRetryAttempts) {
          throw wrapNetworkError(error, method, path, payload, payloadMode, attempt);
        }
        await sleep(retryBaseDelayMs * attempt);
      }
    }
    throw wrapNetworkError(
      lastError,
      method,
      path,
      payload,
      payloadMode,
      networkRetryAttempts,
    );
  }

  private async sendRequest<T>(
    method: "GET" | "POST",
    path: string,
    payload: object,
    payloadMode: "body" | "query",
  ): Promise<AutoDLResponse<T>> {
    const body = payloadMode === "body" ? JSON.stringify(payload) : "";
    const url = new URL(`${this.baseUrl}${path}`);
    if (payloadMode === "query") {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const transport = url.protocol === "http:" ? http : https;
    const headers: Record<string, string | number> = {
      Accept: "application/json",
      Authorization: this.token,
      "User-Agent": "autodl-vscode/0.1.0",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          timeout: this.timeoutMs,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              reject(
                new AutoDLApiError(
                  `HTTP ${res.statusCode}: ${raw.slice(0, 500)}; endpoint=${method} ${path}; payloadMode=${payloadMode}; payload=${JSON.stringify(payload)}`,
                  undefined,
                  undefined,
                  `${method} ${path}`,
                  payload,
                ),
              );
              return;
            }

            let parsed: AutoDLResponse<T>;
            try {
              parsed = JSON.parse(raw) as AutoDLResponse<T>;
            } catch (error) {
              reject(new AutoDLApiError(`API returned invalid JSON: ${raw.slice(0, 500)}`));
              return;
            }

            if (parsed.code !== "Success") {
              reject(
                new AutoDLApiError(
                  `AutoDL API error ${parsed.code}: ${parsed.msg || "unknown error"}; endpoint=${method} ${path}; payloadMode=${payloadMode}; payload=${JSON.stringify(payload)}`,
                  parsed.code,
                  parsed.request_id,
                  `${method} ${path}`,
                  payload,
                ),
              );
              return;
            }

            resolve(parsed);
          });
        },
      );

      req.on("timeout", () => {
        const error = new Error(`Request timed out after ${this.timeoutMs}ms`);
        (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
        req.destroy(error);
      });
      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

export function extractInstanceUuid(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  for (const key of ["instance_uuid", "uuid", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function instanceUuidOf(instance: AutoDLInstance): string | undefined {
  return instance.uuid || instance.instance_uuid;
}

export async function listAllInstances(client: AutoDLClient): Promise<AutoDLInstance[]> {
  const pageSize = 1;
  const first = await client.listInstances(1, pageSize);
  const data = first.data || {};
  const rows = [...(data.list || [])];
  const maxPage = Number(data.max_page || 1);

  for (let page = 2; page <= maxPage; page += 1) {
    const next = await client.listInstances(page, pageSize);
    rows.push(...(next.data?.list || []));
  }

  return rows;
}

export async function listAllPrivateImages(client: AutoDLClient): Promise<AutoDLPrivateImage[]> {
  const pageSize = 20;
  const first = await client.listPrivateImages(1, pageSize);
  const data = first.data || {};
  const rows = [...(data.list || [])];
  const maxPage = Number(data.max_page || 1);

  for (let page = 2; page <= maxPage; page += 1) {
    const next = await client.listPrivateImages(page, pageSize);
    rows.push(...(next.data?.list || []));
  }

  return rows;
}

export async function enrichInstancesWithSnapshots(
  client: AutoDLClient,
  instances: AutoDLInstance[],
): Promise<AutoDLInstance[]> {
  return Promise.all(instances.map((instance) => enrichInstanceWithSnapshot(client, instance)));
}

async function enrichInstanceWithSnapshot(
  client: AutoDLClient,
  instance: AutoDLInstance,
): Promise<AutoDLInstance> {
  const uuid = instanceUuidOf(instance);
  if (!uuid) {
    return instance;
  }
  try {
    const response = await client.snapshot(uuid);
    return mergeSnapshotFields(instance, response.data || {});
  } catch {
    return instance;
  }
}

function mergeSnapshotFields(
  instance: AutoDLInstance,
  snapshot: AutoDLSnapshot,
): AutoDLInstance {
  return {
    ...snapshot,
    ...instance,
    region_sign: instance.region_sign || snapshot.region_sign,
    payg_price: instance.payg_price ?? snapshot.payg_price,
    origin_pay_price: instance.origin_pay_price ?? snapshot.origin_pay_price,
    snapshot_gpu_alias_name: instance.snapshot_gpu_alias_name || snapshot.snapshot_gpu_alias_name,
    cpu_arch: instance.cpu_arch || snapshot.cpu_arch,
    chip_corp: instance.chip_corp || snapshot.chip_corp,
  };
}

export async function waitForStatus(
  client: AutoDLClient,
  instanceUuid: string,
  target: string | string[],
  timeoutMs: number,
  intervalMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  const targets = Array.isArray(target) ? target : [target];

  while (Date.now() <= deadline) {
    const response = await client.status(instanceUuid);
    last = String(response.data || "");
    if (targets.includes(last)) {
      return last;
    }
    await sleep(intervalMs);
  }

  throw new AutoDLApiError(
    `Timed out waiting for ${instanceUuid}: current=${last || "unknown"}, target=${targets.join("/")}`,
  );
}

export async function snapshotWithRetry(
  client: AutoDLClient,
  instanceUuid: string,
  attempts = 5,
  intervalMs = 3_000,
): Promise<AutoDLSnapshot> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await client.snapshot(instanceUuid);
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(intervalMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isActiveInstance(instance: AutoDLInstance): boolean {
  if (!instanceUuidOf(instance)) {
    return false;
  }
  const status = String(instance.status || "").toLowerCase();
  return !["released", "deleted", "destroyed", "releasing"].includes(status);
}

export function needsPowerOff(instance: AutoDLInstance): boolean {
  const status = String(instance.status || "").toLowerCase();
  return !["stopped", "shutdown"].includes(status);
}

export function isAlreadyStoppedError(error: unknown): boolean {
  return (
    error instanceof AutoDLApiError &&
    error.code === "BadRequest" &&
    error.message.includes("已关机")
  );
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof AutoDLApiError) {
    return error.code === "NetworkError";
  }
  const code = errorCode(error);
  const message = errorMessage(error);
  return (
    retryableNetworkCodes.has(code) ||
    message.includes("Client network socket disconnected before secure TLS connection was established") ||
    message.includes("socket hang up")
  );
}

function wrapNetworkError(
  error: unknown,
  method: "GET" | "POST",
  path: string,
  payload: object,
  payloadMode: "body" | "query",
  attempts: number,
): Error {
  if (error instanceof AutoDLApiError) {
    return error;
  }
  const code = errorCode(error);
  const codePrefix = code ? `${code}: ` : "";
  return new AutoDLApiError(
    `Network error calling AutoDL ${method} ${path} (${payloadMode}) after ${attempts} attempt(s): ${codePrefix}${errorMessage(error)}`,
    "NetworkError",
    undefined,
    `${method} ${path}`,
    payload,
  );
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
