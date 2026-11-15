/**
 * 同步：纯本地 / 网盘文件夹 / WebDAV / 自建服务器 / 官方云同步。
 * 合并逻辑在 Rust（src-tauri/src/sync.rs），这里只是调用封装；浏览器预览只支持纯本地。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

export type SyncMode = "local" | "folder" | "webdav" | "server" | "official";

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  conflictTitles: string[];
  finishedAt: string;
  encrypted: boolean;
}

export interface SyncConfig {
  mode: SyncMode;
  folder: string;
  webdavUrl: string;
  webdavUser: string;
  hasWebdavPassword: boolean;
  serverUrl: string;
  serverEmail: string;
  serverLoggedIn: boolean;
  officialUrl: string;
  officialEmail: string;
  officialLoggedIn: boolean;
  pricingUrl: string;
  hasPassphrase: boolean;
  autoSync: boolean;
  intervalMinutes: number;
  lastAt: string | null;
  lastReport: SyncReport | null;
  lastError: string | null;
}

/** 密码类字段：undefined 表示不修改，空字符串表示清除 */
export interface SyncConfigInput {
  mode?: SyncMode;
  folder?: string;
  webdavUrl?: string;
  webdavUser?: string;
  webdavPassword?: string;
  serverUrl?: string;
  passphrase?: string;
  autoSync?: boolean;
  intervalMinutes?: number;
}

export interface SyncAccount {
  email: string;
  plan: string;
  planExpiresAt: string | null;
  quotaBytes: number;
  usedBytes: number;
  requiresSubscription: boolean;
  subscriptionActive: boolean;
}

const BROWSER_CONFIG: SyncConfig = {
  mode: "local",
  folder: "",
  webdavUrl: "",
  webdavUser: "",
  hasWebdavPassword: false,
  serverUrl: "",
  serverEmail: "",
  serverLoggedIn: false,
  officialUrl: "",
  officialEmail: "",
  officialLoggedIn: false,
  pricingUrl: "",
  hasPassphrase: false,
  autoSync: false,
  intervalMinutes: 5,
  lastAt: null,
  lastReport: null,
  lastError: null,
};

/** 把后端错误整理成给人看的一句话 */
export function syncErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^(Validation error|Not found|IO error|Database error):\s*/i, "");
}

export async function getSyncConfig(): Promise<SyncConfig> {
  if (!isTauriRuntime()) return BROWSER_CONFIG;
  return invoke<SyncConfig>("sync_get_config");
}

export async function saveSyncConfig(input: SyncConfigInput): Promise<SyncConfig> {
  if (!isTauriRuntime()) throw new Error("同步仅支持桌面客户端");
  return invoke<SyncConfig>("sync_save_config", { input });
}

/** 立即同步；纯本地模式返回 null */
export async function runSync(): Promise<SyncReport | null> {
  if (!isTauriRuntime()) return null;
  return invoke<SyncReport | null>("sync_run");
}

export async function syncAuth(
  official: boolean,
  action: "login" | "register",
  email: string,
  password: string
): Promise<SyncAccount> {
  if (!isTauriRuntime()) throw new Error("同步仅支持桌面客户端");
  return invoke<SyncAccount>("sync_auth", { official, action, email, password });
}

export async function getSyncAccount(official: boolean): Promise<SyncAccount> {
  return invoke<SyncAccount>("sync_account", { official });
}

export async function syncLogout(official: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("sync_logout", { official });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  return invoke<void>("open_external_url", { url });
}

/** 「3 分钟前」这类相对时间 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "从未";
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
