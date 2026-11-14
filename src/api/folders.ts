/**
 * 侧栏「文件夹」与磁盘笔记相关的 API：读取 / 新建 / 重命名 / 移动 / 回收站、全文搜索、
 * 磁盘监听，以及磁盘笔记里的图片保存。仅桌面端可用。
 * 从 client.ts 拆出，client.ts 会重新导出这里的全部内容。
 */
import { invoke } from "@tauri-apps/api/core";
import type { FolderEntry, FolderListing, FolderSearchHit } from "../types/notion";
import { isTauriRuntime } from "./client";

/** 粘贴到磁盘笔记里的图片：存到笔记旁边的 assets/ 并返回相对路径 */
export interface LocalNoteImage {
  relativePath: string;
  filePath: string;
  displayUrl: string;
}

export async function saveLocalNoteImage(
  notePath: string,
  filename: string,
  dataBase64: string,
  mimeType: string
): Promise<LocalNoteImage | null> {
  if (isTauriRuntime()) {
    return invoke<LocalNoteImage>("save_local_note_image", {
      notePath,
      filename,
      dataBase64,
      mimeType,
    });
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 侧栏「文件夹」：读取磁盘文件夹（仅桌面端；浏览器无法直接访问本地路径）
 * ------------------------------------------------------------------------- */

const FOLDER_DESKTOP_ONLY = "打开本地文件夹仅支持桌面客户端";

export async function listFolderEntries(path: string): Promise<FolderListing> {
  if (isTauriRuntime()) {
    return invoke<FolderListing>("list_folder_entries", { path });
  }
  throw new Error(FOLDER_DESKTOP_ONLY);
}

export async function createFolderEntry(
  parent: string,
  name: string,
  isDir: boolean
): Promise<FolderEntry> {
  if (isTauriRuntime()) {
    return invoke<FolderEntry>("create_folder_entry", { parent, name, isDir });
  }
  throw new Error(FOLDER_DESKTOP_ONLY);
}

export async function renameFolderEntry(
  path: string,
  newName: string
): Promise<FolderEntry> {
  if (isTauriRuntime()) {
    return invoke<FolderEntry>("rename_folder_entry", { path, newName });
  }
  throw new Error(FOLDER_DESKTOP_ONLY);
}

export async function moveFolderEntry(path: string, targetDir: string): Promise<FolderEntry> {
  if (isTauriRuntime()) {
    return invoke<FolderEntry>("move_folder_entry", { path, targetDir });
  }
  throw new Error(FOLDER_DESKTOP_ONLY);
}

/** 移到系统回收站 */
export async function trashFolderEntry(path: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("trash_folder_entry", { path });
  }
  throw new Error(FOLDER_DESKTOP_ONLY);
}

export async function searchFolderNotes(
  roots: Array<[string, string]>,
  query: string
): Promise<FolderSearchHit[]> {
  if (isTauriRuntime() && roots.length > 0 && query.trim()) {
    return invoke<FolderSearchHit[]>("search_folder_notes", { roots, query });
  }
  return [];
}

/** 设置要监听的文件夹与文件；变化通过 onFsChanged 回调 */
export async function setWatchedPaths(dirs: string[], files: string[]): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("set_watched_paths", { dirs, files });
  }
}

export async function onFsChanged(handler: (paths: string[]) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>("xynote://fs-changed", (e) => handler(e.payload ?? []));
}
