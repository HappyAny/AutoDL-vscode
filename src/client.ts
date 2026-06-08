import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

import {
  AutoDLInstance,
  AutoDLListData,
  AutoDLResponse,
  AutoDLSnapshot,
  CreateInstancePayload,
} from "./types";

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

  async powerOff(instanceUuid: string): Promise<AutoDLResponse<unknown>> {
    return this.request("POST", "/api/v1/dev/instance/pro/power_off", {
      instance_uuid: instanceUuid,
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
      return await this.sendRequest<T>(method, path, payload, "body");
    } catch (error) {
      if (
        method === "GET" &&
        error instanceof AutoDLApiError &&
        error.code === "RequestParameterIsWrong"
      ) {
        return this.sendRequest<T>(method, path, payload, "query");
      }
      throw error;
    }
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
        req.destroy(new AutoDLApiError(`Request timed out after ${this.timeoutMs}ms`));
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

export async function waitForStatus(
  client: AutoDLClient,
  instanceUuid: string,
  target: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() <= deadline) {
    const response = await client.status(instanceUuid);
    last = String(response.data || "");
    if (last === target) {
      return last;
    }
    await sleep(intervalMs);
  }

  throw new AutoDLApiError(
    `Timed out waiting for ${instanceUuid}: current=${last || "unknown"}, target=${target}`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
