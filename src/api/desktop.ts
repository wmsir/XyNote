/** 桌面端功能：多窗口、检查更新、保存前端生成的导出文件 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";
import { isHarmonyRuntime, saveFileViaHarmony } from "./harmony";

function parseVerTuple(v: string): [number, number, number] {
  const core = v.trim().replace(/^[vV]/, "").split(/[-+]/)[0] || "";
  const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isVersionNewer(latest: string, current: string): boolean {
  const a = parseVerTuple(latest);
  const b = parseVerTuple(current);
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/** 新建窗口；pageId 有值时新窗口直接打开这个页面。返回窗口标识 */
export async function openNewWindow(pageId?: string | null): Promise<string> {
  if (!isTauriRuntime()) {
    // 浏览器预览：在新标签页打开
    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    url.searchParams.delete("fresh");
    if (pageId) url.searchParams.set("page", pageId);
    else url.searchParams.set("fresh", "1");
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
  if (!isTauriRuntime()) {
    if (isHarmonyRuntime()) {
      const current = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.8.10";
      const resp = await fetch(`https://fwpt.cn/downloads/xynote/latest.json?t=${Math.floor(Date.now() / 1000)}`, {
        cache: "no-store",
      });
      if (!resp.ok) throw new Error(`检查更新失败（${resp.status}）`);
      const rel = (await resp.json()) as {
        tag_name?: string;
        body?: string;
        published_at?: string;
        html_url?: string;
        assets?: Array<{ name: string; browser_download_url: string; size?: number }>;
      };
      const latest = (rel.tag_name || current).replace(/^[vV]/, "");
      const picked = (rel.assets || []).find((a) =>
        a.name.toLowerCase().includes("harmonyos-pc")
      );
      return {
        currentVersion: current,
        latestVersion: latest,
        hasUpdate: isVersionNewer(latest, current),
        notes: (rel.body || "").trim(),
        publishedAt: rel.published_at || "",
        releaseUrl: rel.html_url || "https://fwpt.cn/xynote/#download",
        assetUrl: picked?.browser_download_url || "https://fwpt.cn/xynote/#download",
        assetName: picked?.name || "",
        assetSize: picked?.size || 0,
      };
    }
    throw new Error("检查更新仅支持桌面客户端");
  }
  return invoke<UpdateInfo>("check_for_update");
}

let cachedUpdateInfo: UpdateInfo | null = null;
const updateInfoListeners = new Set<(info: UpdateInfo | null) => void>();

export function getCachedUpdateInfo(): UpdateInfo | null {
  return cachedUpdateInfo;
}

export function setCachedUpdateInfo(info: UpdateInfo | null): void {
  cachedUpdateInfo = info;
  updateInfoListeners.forEach((cb) => {
    try {
      cb(info);
    } catch {
      /* 忽略订阅方错误 */
    }
  });
}

export function subscribeUpdateInfo(
  cb: (info: UpdateInfo | null) => void
): () => void {
  updateInfoListeners.add(cb);
  return () => {
    updateInfoListeners.delete(cb);
  };
}

/** 保存前端生成的 PNG（可多张），返回保存路径；取消时为 null */
export async function saveExportImages(filename: string, parts: string[]): Promise<string | null> {
  if (!isTauriRuntime()) {
    if (isHarmonyRuntime() && parts.length > 0) {
      const first = parts[0] || "";
      const b64 = first.includes(",") ? first.split(",")[1] : first;
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const finalName = filename.toLowerCase().endsWith(".png") ? filename : `${filename}.png`;
      return saveFileViaHarmony(finalName, bytes, "image/png");
    }
    throw new Error("导出图片仅支持桌面客户端");
  }
  return invoke<string | null>("save_export_images", { filename, parts });
}

/** 从启动地址 ?page=xxx 里读出要打开的页面（新窗口用） */
/** 是否是「新建窗口」打开的全新窗口（不恢复上次的页面） */
export function isFreshWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("fresh") === "1";
  } catch {
    return false;
  }
}

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

/**
 * 发一条系统通知（待办到点提醒等）。
 * 桌面端走 tauri-plugin-notification；浏览器里用 Notification API；都不可用时返回 false。
 */
export async function sendSystemNotification(title: string, body: string): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      let granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      if (!granted) {
        const res = await invoke<string>("plugin:notification|request_permission");
        granted = res === "granted";
      }
      if (!granted) return false;
      await invoke("plugin:notification|notify", { options: { title, body } });
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** 当前窗口是不是主窗口（多窗口时只让主窗口发提醒，避免重复） */
export function isMainWindow(): boolean {
  if (!isTauriRuntime()) return true;
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label;
    return !label || label === "main";
  } catch {
    return true;
  }
}
