/** 永久版：离线授权与页面历史版本 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

export interface LicenseStatus {
  active: boolean;
  name: string | null;
  id: string | null;
  issuedAt: string | null;
  configured: boolean;
  purchaseUrl: string;
}

export interface PageVersionMeta {
  id: string;
  pageId: string;
  createdAt: string;
  title: string;
  reason: "edit" | "sync" | "restore" | string;
  size: number;
}

export interface PageVersionView {
  meta: PageVersionMeta;
  icon: string;
  blocks: { blockType: string; text: string }[];
  isDatabase: boolean;
  columnNames: string[];
  rowCount: number;
}

const BROWSER_STATUS: LicenseStatus = {
  active: false,
  name: null,
  id: null,
  issuedAt: null,
  configured: false,
  purchaseUrl: "https://fwpt.cn/xynote.html",
};

export async function getLicenseStatus(): Promise<LicenseStatus> {
  if (!isTauriRuntime()) return BROWSER_STATUS;
  return invoke<LicenseStatus>("license_status");
}

export async function activateLicense(license: string): Promise<LicenseStatus> {
  if (!isTauriRuntime()) throw new Error("请在桌面客户端中激活");
  return invoke<LicenseStatus>("license_activate", { license });
}

export async function deactivateLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_deactivate");
}

export async function listPageVersions(pageId: string): Promise<PageVersionMeta[]> {
  return invoke<PageVersionMeta[]>("page_versions_list", { pageId });
}

export async function getPageVersion(versionId: string): Promise<PageVersionView> {
  return invoke<PageVersionView>("page_version_get", { versionId });
}

export async function restorePageVersion(versionId: string): Promise<string> {
  return invoke<string>("page_version_restore", { versionId });
}

export const PRO_FEATURES: { title: string; desc: string }[] = [
  { title: "页面历史版本", desc: "自动保存每篇笔记的历史，误删、改错或被同步覆盖都能找回" },
  { title: "后续高级功能", desc: "之后新增的高级功能，买断后一并可用" },
  { title: "支持持续开发", desc: "小悦笔记的基础功能会一直免费，你的购买让它走得更远" },
];
