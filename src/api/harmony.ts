/**
 * 鸿蒙 PC (HarmonyOS 5 / OpenHarmony API 12+ 2in1) ArkWeb 原生桥接层
 *
 * 当运行在鸿蒙 PC 原生 .hap (ArkWeb) 容器中时，宿主通过 javaScriptProxy 注入
 * `window.__XYNOTE_HARMONY__`，提供本地沙箱文件持久化、原生 DocumentViewPicker 导出保存、
 * PC 多窗口控制与外部浏览器跳转能力。
 */

export interface HarmonyBridgeApi {
  readonly platform: "harmonyos-pc";
  readonly appVersion?: string;
  readStorage?: () => string | null;
  writeStorage?: (json: string) => boolean;
  saveFile?: (filename: string, contentBase64: string, mimeType: string) => Promise<string | null> | string | null;
  openExternalUrl?: (url: string) => Promise<boolean> | boolean;
  windowAction?: (action: "minimize" | "toggleMaximize" | "close") => Promise<void> | void;
}

declare global {
  interface Window {
    __XYNOTE_HARMONY__?: HarmonyBridgeApi;
  }
}

export function getHarmonyBridge(): HarmonyBridgeApi | null {
  if (typeof window === "undefined") return null;
  const bridge = window.__XYNOTE_HARMONY__;
  if (bridge && bridge.platform === "harmonyos-pc") {
    return bridge;
  }
  return null;
}

export function isHarmonyRuntime(): boolean {
  return getHarmonyBridge() !== null;
}

export function isHarmonyOSBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("openharmony") || ua.includes("harmonyos");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

export function readHarmonyWorkspaceJson(): string | null {
  const bridge = getHarmonyBridge();
  if (!bridge?.readStorage) return null;
  try {
    const raw = bridge.readStorage();
    return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeHarmonyWorkspaceJson(json: string): boolean {
  const bridge = getHarmonyBridge();
  if (!bridge?.writeStorage) return false;
  try {
    return Boolean(bridge.writeStorage(json));
  } catch {
    return false;
  }
}

export async function saveFileViaHarmony(
  filename: string,
  data: string | Uint8Array,
  mimeType = "application/octet-stream"
): Promise<string | null> {
  const bridge = getHarmonyBridge();
  if (!bridge?.saveFile) return null;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const b64 = bytesToBase64(bytes);
  const res = await bridge.saveFile(filename, b64, mimeType);
  return typeof res === "string" && res.length > 0 ? res : null;
}

export async function openExternalViaHarmony(url: string): Promise<boolean> {
  const bridge = getHarmonyBridge();
  if (!bridge?.openExternalUrl) return false;
  try {
    return Boolean(await bridge.openExternalUrl(url));
  } catch {
    return false;
  }
}
