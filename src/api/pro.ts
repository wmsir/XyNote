/** 永久版：通行证登录、激活码激活（最多 3 台电脑）、页面历史与导出 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

export interface LicenseStatus {
  /** 当前可以使用付费功能 */
  active: boolean;
  /** lifetime 永久版 / trial 注册赠送的一年 */
  edition: "lifetime" | "trial" | string | null;
  name: string | null;
  id: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /** 有授权但已到期 */
  expired: boolean;
  configured: boolean;
  purchaseUrl: string;
  loggedIn: boolean;
  account: string | null;
  machineName: string;
  code: string | null;
  devicesUsed: number | null;
  maxDevices: number | null;
  trialUntil: string | null;
  /** 登录成功但授权服务给出的提示（如免费账号已绑定其他电脑） */
  notice: string | null;
  /** 用户中心：购买、管理电脑、查看订单 */
  userCenterUrl: string;
}

export type ProProduct = "lifetime" | "device_slot";

export interface StoreOrder {
  id: string;
  product: string;
  productName: string;
  amountCents: number;
  payRef: string;
  status: string;
  createdAt: string;
  license: string | null;
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
  edition: null,
  name: null,
  id: null,
  issuedAt: null,
  expiresAt: null,
  expired: false,
  configured: false,
  purchaseUrl: "https://fwpt.cn/xynote/",
  loggedIn: false,
  account: null,
  machineName: "浏览器预览",
  code: null,
  devicesUsed: null,
  maxDevices: null,
  trialUntil: null,
  notice: null,
  userCenterUrl: "https://fwpt.cn/xynote/",
};

export const PRO_PRICE = "¥9.9";
export const PRO_SUPPORT_EMAIL = "admin@fwpt.cn";
export const FWPT_REGISTER_URL = "https://fwpt.cn/?action=register";
const PRO_CACHE_KEY = "xynote.proCache";

/** 上次的授权状态（启动时先用，避免自定义主题闪一下） */
export function cachedProActive(): boolean {
  try {
    return localStorage.getItem(PRO_CACHE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(s: LicenseStatus): LicenseStatus {
  try {
    localStorage.setItem(PRO_CACHE_KEY, s.active ? "1" : "0");
  } catch {
    // 忽略
  }
  return s;
}

function needDesktop(): never {
  throw new Error("请在桌面客户端中使用");
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  if (!isTauriRuntime()) return BROWSER_STATUS;
  return remember(await invoke<LicenseStatus>("x_s0"));
}

/** 用 FWPT 通行证登录；第一次登录赠送一年永久版权限 */
export async function licenseLogin(account: string, password: string): Promise<LicenseStatus> {
  if (!isTauriRuntime()) needDesktop();
  return remember(await invoke<LicenseStatus>("x_s1", { account, password }));
}

/** 启动时向服务器报到并刷新授权（离线时保留本地授权） */
export async function licenseRefresh(): Promise<LicenseStatus> {
  if (!isTauriRuntime()) return BROWSER_STATUS;
  return remember(await invoke<LicenseStatus>("x_s2"));
}

/** 输入激活码（XYP-…）；也接受离线授权（XYNOTE1.…） */
export async function activateLicense(license: string): Promise<LicenseStatus> {
  if (!isTauriRuntime()) needDesktop();
  return remember(await invoke<LicenseStatus>("x_s3", { license }));
}

/** 在本机停用授权，空出激活码的一个位置 */
export async function deactivateLicense(): Promise<LicenseStatus> {
  return remember(await invoke<LicenseStatus>("x_s4"));
}

export async function licenseLogout(): Promise<LicenseStatus> {
  return remember(await invoke<LicenseStatus>("x_s5"));
}

export async function createProOrder(product: ProProduct = "lifetime"): Promise<StoreOrder> {
  if (!isTauriRuntime()) needDesktop();
  return invoke<StoreOrder>("x_s6", { product });
}

export const PRODUCT_INFO: Record<ProProduct, { name: string; price: string }> = {
  lifetime: { name: "小悦笔记永久版", price: "¥9.9" },
  device_slot: { name: "增加 1 台电脑", price: "¥3" },
};

export type FeedbackCategory = "idea" | "bug" | "other";

/** 提交意见反馈（登录时关联通行证账号） */
export async function submitFeedback(category: FeedbackCategory, content: string, contact: string): Promise<void> {
  if (!isTauriRuntime()) needDesktop();
  return invoke<void>("x_s7", { category, content, contact });
}

export async function exportPageHtml(pageId: string): Promise<{ filename: string; html: string }> {
  return invoke<{ filename: string; html: string }>("export_page_html", { pageId });
}

/** 导出 HTML / Word / EPUB / LaTeX / OPML / Markdown 文件，返回保存路径；取消时为 null */
export async function exportPageFile(pageId: string, format: "md" | "html" | "docx" | "epub" | "latex" | "opml"): Promise<string | null> {
  return invoke<string | null>("export_page_file", { pageId, format });
}

export async function exportMarkdownHtml(filename: string, markdown: string): Promise<{ filename: string; html: string }> {
  return invoke<{ filename: string; html: string }>("export_markdown_html", { filename, markdown });
}

export async function exportMarkdownFile(
  filename: string,
  markdown: string,
  format: "md" | "html" | "docx" | "epub" | "latex" | "opml"
): Promise<string | null> {
  return invoke<string | null>("export_markdown_file", { filename, markdown, format });
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
  { title: "自定义主题与样式", desc: "可视化调配色、字体与圆角，安装或编写 CSS 样式插件" },
  { title: "导出 HTML、PDF、Word", desc: "一键把笔记导出成网页、PDF 或 Word 文档，图片一并带上" },
  { title: "页面历史版本", desc: "自动保存每篇笔记的历史，改错、误删都能找回" },
  { title: "后续高级功能", desc: "之后新增的高级功能一并可用" },
];
