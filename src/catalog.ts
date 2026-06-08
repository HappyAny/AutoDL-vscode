import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { URL } from "node:url";

import * as vscode from "vscode";

import { AutoDLClient, listAllPrivateImages } from "./client";

export interface GpuCatalogItem extends vscode.QuickPickItem {
  gpuSpecUuid: string;
}

export interface ImageCatalogItem extends vscode.QuickPickItem {
  imageUuid: string;
  cudaMin: number;
}

interface CatalogCache {
  refreshedAt?: string;
  gpuCatalog?: GpuCatalogItem[];
  imageCatalog?: ImageCatalogItem[];
}

export interface CatalogRefreshResult {
  gpuCount: number;
  imageCount: number;
  privateImageCount: number;
  cacheFile: string;
  docsOk: boolean;
  privateImagesOk: boolean;
}

const DOC_URL = "https://www.autodl.com/docs/instance_pro_api/";
const CATALOG_CACHE_FILE = "autodl-catalogs.json";

export const GPU_CATALOG: GpuCatalogItem[] = [
  {
    label: "4080(S) 32G",
    description: "v-32g-p",
    detail: "Low profile, performance type",
    gpuSpecUuid: "v-32g-p",
  },
  {
    label: "5090 32G",
    description: "5090-p",
    detail: "Mid profile, performance type",
    gpuSpecUuid: "5090-p",
  },
  {
    label: "RTX PRO 6000",
    description: "pro6000-p",
    detail: "High profile, performance type",
    gpuSpecUuid: "pro6000-p",
  },
  {
    label: "4090 48G",
    description: "v-48g",
    detail: "General type",
    gpuSpecUuid: "v-48g",
  },
  {
    label: "3090 48G",
    description: "v-48g-350w",
    detail: "General type",
    gpuSpecUuid: "v-48g-350w",
  },
  {
    label: "H800 80G",
    description: "h800",
    detail: "General type",
    gpuSpecUuid: "h800",
  },
  {
    label: "4090D",
    description: "4090D",
    detail: "General type",
    gpuSpecUuid: "4090D",
  },
];

let activeGpuCatalog: GpuCatalogItem[] = GPU_CATALOG;
let activeImageCatalog: ImageCatalogItem[] = [];

export function currentGpuCatalog(): GpuCatalogItem[] {
  return activeGpuCatalog;
}

export function currentImageCatalog(): ImageCatalogItem[] {
  return activeImageCatalog.length ? activeImageCatalog : IMAGE_CATALOG;
}

export async function loadCatalogCache(context: vscode.ExtensionContext): Promise<void> {
  const cache = await readCatalogCache(context);
  if (!cache) {
    activeGpuCatalog = GPU_CATALOG;
    activeImageCatalog = IMAGE_CATALOG;
    return;
  }
  activeGpuCatalog = mergeGpuCatalogs(cache.gpuCatalog || [], GPU_CATALOG);
  activeImageCatalog = imageCatalogWithCustom(
    mergeImageCatalogs(cache.imageCatalog || [], publicImageCatalog()),
  );
}

export async function refreshCatalogCache(
  context: vscode.ExtensionContext,
  client?: AutoDLClient,
): Promise<CatalogRefreshResult> {
  let docsOk = true;
  let docsGpuCatalog: GpuCatalogItem[] = [];
  let docsImageCatalog: ImageCatalogItem[] = [];
  try {
    const docs = await fetchText(DOC_URL);
    docsGpuCatalog = parseGpuCatalogFromDocs(docs);
    docsImageCatalog = parsePublicImageCatalogFromDocs(docs);
  } catch {
    docsOk = false;
  }

  let privateImagesOk = true;
  let privateImageCatalog: ImageCatalogItem[] = [];
  if (client) {
    try {
      privateImageCatalog = (await listAllPrivateImages(client))
        .filter((image) => image.image_uuid)
        .map((image) => ({
          label: image.name || image.image_uuid || "Private image",
          description: image.image_uuid,
          detail: [
            "private",
            image.status,
            image.image_size ? `${image.image_size} bytes` : "",
            image.create_at,
          ]
            .filter(Boolean)
            .join(" | "),
          imageUuid: image.image_uuid || "",
          cudaMin: 130,
        }));
    } catch {
      privateImagesOk = false;
    }
  }

  activeGpuCatalog = mergeGpuCatalogs(docsGpuCatalog, GPU_CATALOG);
  activeImageCatalog = imageCatalogWithCustom(
    mergeImageCatalogs(docsImageCatalog, publicImageCatalog(), privateImageCatalog),
  );

  const cacheFile = await writeCatalogCache(context, {
    refreshedAt: new Date().toISOString(),
    gpuCatalog: activeGpuCatalog,
    imageCatalog: activeImageCatalog,
  });

  return {
    gpuCount: activeGpuCatalog.length,
    imageCount: activeImageCatalog.filter((item) => item.imageUuid).length,
    privateImageCount: privateImageCatalog.length,
    cacheFile,
    docsOk,
    privateImagesOk,
  };
}

function publicImageCatalog(): ImageCatalogItem[] {
  return IMAGE_CATALOG.filter((item) => item.imageUuid);
}

function imageCatalogWithCustom(items: ImageCatalogItem[]): ImageCatalogItem[] {
  const custom = IMAGE_CATALOG.find((item) => !item.imageUuid);
  return custom ? [...items.filter((item) => item.imageUuid), custom] : items;
}

function mergeGpuCatalogs(...catalogs: GpuCatalogItem[][]): GpuCatalogItem[] {
  const items = new Map<string, GpuCatalogItem>();
  for (const item of catalogs.flat()) {
    if (item.gpuSpecUuid && !items.has(item.gpuSpecUuid)) {
      items.set(item.gpuSpecUuid, item);
    }
  }
  return [...items.values()];
}

function mergeImageCatalogs(...catalogs: ImageCatalogItem[][]): ImageCatalogItem[] {
  const items = new Map<string, ImageCatalogItem>();
  for (const item of catalogs.flat()) {
    if (item.imageUuid && !items.has(item.imageUuid)) {
      items.set(item.imageUuid, item);
    }
  }
  return [...items.values()];
}

async function readCatalogCache(
  context: vscode.ExtensionContext,
): Promise<CatalogCache | undefined> {
  try {
    const raw = await fs.readFile(await catalogCachePath(context), "utf8");
    return JSON.parse(raw) as CatalogCache;
  } catch {
    return undefined;
  }
}

async function writeCatalogCache(
  context: vscode.ExtensionContext,
  cache: CatalogCache,
): Promise<string> {
  const filePath = await catalogCachePath(context);
  await fs.writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return filePath;
}

async function catalogCachePath(context: vscode.ExtensionContext): Promise<string> {
  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, CATALOG_CACHE_FILE);
}

function parseGpuCatalogFromDocs(raw: string): GpuCatalogItem[] {
  return htmlToText(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(.+?)\s+(通用型|性能型)\s+([a-z0-9][a-z0-9_-]*)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      label: match[1].trim(),
      description: match[3].trim(),
      detail: match[2].trim(),
      gpuSpecUuid: match[3].trim(),
    }));
}

function parsePublicImageCatalogFromDocs(raw: string): ImageCatalogItem[] {
  return htmlToText(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) =>
      line.match(/\b(base-image-[a-z0-9]+)\b\s+([A-Za-z0-9_.+-]+)\s+(.+)$/i),
    )
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const imageUuid = match[1].trim();
      const framework = match[2].trim();
      const image = match[3].trim();
      const cudaMin = inferCudaMin(image);
      return {
        label: `${framework}${cudaMin ? ` / CUDA ${formatCuda(cudaMin)}` : ""}`,
        description: imageUuid,
        detail: image,
        imageUuid,
        cudaMin: cudaMin || 130,
      };
    });
}

function inferCudaMin(value: string): number | undefined {
  const match = value.match(/cuda(?:gl)?(\d+)\.(\d+)/i);
  if (!match) {
    return undefined;
  }
  return Number(`${match[1]}${match[2]}`);
}

function formatCuda(value: number): string {
  const raw = String(value);
  return raw.length > 2 ? `${raw.slice(0, -1)}.${raw.slice(-1)}` : raw;
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ");
}

function fetchText(urlString: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.request(
      {
        method: "GET",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: "text/html,text/plain",
          "User-Agent": "autodl-vscode",
        },
      },
      (response) => {
        const location = response.headers.location;
        if (
          location &&
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          redirectCount < 3
        ) {
          response.resume();
          resolve(fetchText(new URL(location, url).toString(), redirectCount + 1));
          return;
        }
        if ((response.statusCode || 0) >= 400) {
          response.resume();
          reject(new Error(`Failed to fetch AutoDL docs: HTTP ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("error", reject);
    request.end();
  });
}
export const IMAGE_CATALOG: ImageCatalogItem[] = [
  {
    label: "PyTorch 1.9.0 / CUDA 11.1",
    description: "base-image-12be412037",
    detail: "cuda11.1-cudnn8-devel-ubuntu18.04-py38-torch1.9.0",
    imageUuid: "base-image-12be412037",
    cudaMin: 111,
  },
  {
    label: "PyTorch 1.10.0 / CUDA 11.3",
    description: "base-image-u9r24vthlk",
    detail: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.10.0",
    imageUuid: "base-image-u9r24vthlk",
    cudaMin: 113,
  },
  {
    label: "PyTorch 1.11.0 / CUDA 11.3",
    description: "base-image-l374uiucui",
    detail: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.11.0",
    imageUuid: "base-image-l374uiucui",
    cudaMin: 113,
  },
  {
    label: "PyTorch 2.0.0 / CUDA 11.8",
    description: "base-image-l2t43iu6uk",
    detail: "cuda11.8-cudnn8-devel-ubuntu20.04-py38-torch2.0.0",
    imageUuid: "base-image-l2t43iu6uk",
    cudaMin: 118,
  },
  {
    label: "TensorFlow 2.5.0 / CUDA 11.2",
    description: "base-image-0gxqmciyth",
    detail: "cuda11.2-cudnn8-devel-ubuntu18.04-py38-tf2.5.0",
    imageUuid: "base-image-0gxqmciyth",
    cudaMin: 112,
  },
  {
    label: "TensorFlow 2.9.0 / CUDA 11.2",
    description: "base-image-uxeklgirir",
    detail: "cuda11.2-cudnn8-devel-ubuntu20.04-py38-tf2.9.0",
    imageUuid: "base-image-uxeklgirir",
    cudaMin: 112,
  },
  {
    label: "TensorFlow 1.15.5 / CUDA 11.4",
    description: "base-image-4bpg0tt88l",
    detail: "cuda11.4-py38-tf1.15.5",
    imageUuid: "base-image-4bpg0tt88l",
    cudaMin: 114,
  },
  {
    label: "Miniconda / CUDA 11.6",
    description: "base-image-mbr2n4urrc",
    detail: "cuda11.6-cudnn8-devel-ubuntu20.04-py38",
    imageUuid: "base-image-mbr2n4urrc",
    cudaMin: 116,
  },
  {
    label: "Miniconda / CUDA 10.2",
    description: "base-image-qkkhitpik5",
    detail: "cuda10.2-cudnn7-devel-ubuntu18.04-py38",
    imageUuid: "base-image-qkkhitpik5",
    cudaMin: 102,
  },
  {
    label: "Miniconda / CUDA 11.1",
    description: "base-image-h041hn36yt",
    detail: "cuda11.1-cudnn8-devel-ubuntu18.04-py38",
    imageUuid: "base-image-h041hn36yt",
    cudaMin: 111,
  },
  {
    label: "Miniconda / CUDA GL 11.3",
    description: "base-image-7bn8iqhkb5",
    detail: "cudagl11.3-cudnn8-devel-ubuntu20.04-py38",
    imageUuid: "base-image-7bn8iqhkb5",
    cudaMin: 113,
  },
  {
    label: "Miniconda / CUDA 9.0",
    description: "base-image-k0vep6kyq8",
    detail: "cuda9.0-cudnn7-devel-ubuntu16.04-py36",
    imageUuid: "base-image-k0vep6kyq8",
    cudaMin: 90,
  },
  {
    label: "TensorRT / CUDA 11.8",
    description: "base-image-l2843iu23k",
    detail: "cuda11.8-cudnn8-devel-ubuntu20.04-py38-trt8.5.1",
    imageUuid: "base-image-l2843iu23k",
    cudaMin: 118,
  },
  {
    label: "Custom image UUID",
    description: "manual",
    detail: "Enter an image UUID manually",
    imageUuid: "",
    cudaMin: 130,
  },
];
