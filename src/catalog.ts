import * as vscode from "vscode";

export interface GpuCatalogItem extends vscode.QuickPickItem {
  gpuSpecUuid: string;
}

export interface ImageCatalogItem extends vscode.QuickPickItem {
  imageUuid: string;
  cudaMin: number;
}

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

export const IMAGE_CATALOG: ImageCatalogItem[] = [
  {
    label: "PyTorch 2.0.0 / CUDA 11.8",
    description: "base-image-l2t43iu6uk",
    detail: "cuda11.8-cudnn8-devel-ubuntu20.04-py38-torch2.0.0",
    imageUuid: "base-image-l2t43iu6uk",
    cudaMin: 118,
  },
  {
    label: "PyTorch 1.11.0 / CUDA 11.3",
    description: "base-image-l374uiucui",
    detail: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.11.0",
    imageUuid: "base-image-l374uiucui",
    cudaMin: 113,
  },
  {
    label: "PyTorch 1.10.0 / CUDA 11.3",
    description: "base-image-u9r24vthlk",
    detail: "cuda11.3-cudnn8-devel-ubuntu20.04-py38-torch1.10.0",
    imageUuid: "base-image-u9r24vthlk",
    cudaMin: 113,
  },
  {
    label: "Miniconda / CUDA 11.6",
    description: "base-image-mbr2n4urrc",
    detail: "cuda11.6-cudnn8-devel-ubuntu20.04-py38",
    imageUuid: "base-image-mbr2n4urrc",
    cudaMin: 116,
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
