/** 桌面端功能：多窗口、检查更新、保存前端生成的导出文件 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

/** 新建窗口；pageId 有值时新窗口直接打开这个页面。返回窗口标识 */
export async function openNewWindow(pageId?: string | null): Promise<string> {
  if (!isTauriRuntime()) {
    // 浏览器预览：在新标签页打开
    const url = new URL(window.location.href);
    if (pageId) url.searchParams.set("page", pageId);
    else url.searchParams.delete("page");
    window.open(url.toString(), "_blank");
    return "browser";
  }
  return invoke<string>("open_new_window", { pageId: pageId ?? null });
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  notes: string;
  publishedAt: string;
  releaseUrl: string;
  assetUrl: string;
  assetName: string;
  assetSize: number;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauriRuntime()) throw new Error("检查更新仅支持桌面客户端");
  return invoke<UpdateInfo>("check_for_update");
}

/** 保存前端生成的 PNG（可多张），返回保存路径；取消时为 null */
export async function saveExportImages(filename: string, parts: string[]): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error("导出图片仅支持桌面客户端");
  return invoke<string | null>("save_export_images", { filename, parts });
}

/** 从启动地址 ?page=xxx 里读出要打开的页面（新窗口用） */
export function initialPageFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("page");
  } catch {
    return null;
  }
}

export interface ShellIntegrationStatus {
  supported: boolean;
  contextMenuRegistered: boolean;
  openWithRegistered: boolean;
  isDefaultMdHandler: boolean;
  currentExePath: string;
  registeredExePath: string | null;
  pathMatchesCurrentExe: boolean;
  currentUserChoiceProgId: string | null;
}

export async function takePendingOpenFiles(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  return invoke<string[]>("take_pending_open_files");
}

export async function onExternalOpenFiles(
  handler: (paths: string[]) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>("xynote://open-files", (ev) => {
    const paths = Array.isArray(ev.payload) ? ev.payload : [];
    if (paths.length > 0) handler(paths);
  });
}

export async function getShellIntegrationStatus(): Promise<ShellIntegrationStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<ShellIntegrationStatus>("get_shell_integration_status");
}

export async function registerShellIntegration(): Promise<ShellIntegrationStatus> {
  if (!isTauriRuntime()) {
    throw new Error("Windows 右键菜单与文件关联仅支持桌面客户端");
  }
  return invoke<ShellIntegrationStatus>("register_shell_integration");
}

export async function unregisterShellIntegration(): Promise<ShellIntegrationStatus> {
  if (!isTauriRuntime()) {
    throw new Error("Windows 右键菜单与文件关联仅支持桌面客户端");
  }
  return invoke<ShellIntegrationStatus>("unregister_shell_integration");
}

export async function promptDefaultMdAssociation(): Promise<ShellIntegrationStatus> {
  if (!isTauriRuntime()) {
    throw new Error("设置默认 .md 打开程序仅支持桌面客户端");
  }
  return invoke<ShellIntegrationStatus>("prompt_default_md_association");
}

/* ---------------- 自动检查更新的设置 ---------------- */

const LS_AUTO = "xynote.update.autoCheck";
const LS_LAST = "xynote.update.lastCheck";
const LS_SKIP = "xynote.update.skipVersion";

export function getAutoUpdateCheck(): boolean {
  try {
    return localStorage.getItem(LS_AUTO) !== "0";
  } catch {
    return true;
  }
}
export function setAutoUpdateCheck(on: boolean) {
  try {
    localStorage.setItem(LS_AUTO, on ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}
/** 距离上次自动检查是否超过一天 */
export function autoCheckDue(): boolean {
  try {
    const last = Number(localStorage.getItem(LS_LAST) || 0);
    return Date.now() - last > 24 * 3600 * 1000;
  } catch {
    return true;
  }
}
export function markAutoChecked() {
  try {
    localStorage.setItem(LS_LAST, String(Date.now()));
  } catch {
    /* 忽略 */
  }
}
export function getSkippedVersion(): string {
  try {
    return localStorage.getItem(LS_SKIP) ?? "";
  } catch {
    return "";
  }
}
export function skipVersion(v: string) {
  try {
    localStorage.setItem(LS_SKIP, v);
  } catch {
    /* 忽略 */
  }
}
