import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

export interface AttachmentInfo {
  relPath: string;
  fileName: string;
  size: number;
  mime: string;
  /** 图片会直接存成图片资源，返回 data URL */
  imageDataUrl?: string;
}

/** 去掉后端错误前缀，给人看 */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^(Validation error|IO error|Not found):\s*/i, "");
}

export async function attachPaths(paths: string[]): Promise<{ items: AttachmentInfo[]; errors: string[] }> {
  return invoke("attach_paths", { paths });
}

export async function attachFileBytes(fileName: string, dataBase64: string): Promise<AttachmentInfo> {
  if (!isTauriRuntime()) {
    // 浏览器预览：没有磁盘，只记文件名
    return { relPath: "", fileName, size: Math.floor((dataBase64.length * 3) / 4), mime: "" };
  }
  return invoke("attach_file_bytes", { fileName, dataBase64 });
}

export async function openAttachment(relPath: string): Promise<void> {
  await invoke("open_attachment", { relPath });
}

export async function revealAttachment(relPath: string): Promise<void> {
  await invoke("reveal_attachment", { relPath });
}

/** 把网页图片下载为本地图片（data URL）；浏览器预览里返回 null */
export async function downloadImageAsset(url: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return invoke<string>("download_image_asset", { url });
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
