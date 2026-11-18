import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../api/client";

export const XYNOTE_FONT_GUIDE_URL = "https://fwpt.cn/xynote/#font-guide";
export const CUSTOM_FONT_FACE_FAMILY = "XyNoteUserCustomFont";
export const CUSTOM_FONT_FALLBACK_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export type FontStylePref = "sans" | "serif" | "mono" | "custom";

export interface CustomFontEntry {
  id: string;
  name: string;
  /** 本地字体文件完整路径、XyNote-data 相对路径 (`fonts/...`)，或系统已安装字体家族名 */
  path: string;
  portable?: boolean;
  addedAt: string;
}

export interface CustomFontConfig {
  activeId: string | null;
  applyGlobalUi: boolean;
  fonts: CustomFontEntry[];
}

export const DEFAULT_CUSTOM_FONT_CONFIG: CustomFontConfig = {
  activeId: null,
  applyGlobalUi: false,
  fonts: [],
};

const ephemeralBrowserFontBuffers = new Map<string, ArrayBuffer>();
const loadedCustomFontFaces = new Map<string, FontFace>();

export function normalizeFontPathInput(raw: string): string {
  let cleaned = raw.trim();
  while (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned.replace(/^["']+|["']+$/g, "").trim();
}

export function isLikelyFontFilePath(input: string): boolean {
  const clean = normalizeFontPathInput(input);
  if (!clean) return false;
  if (
    /[\\/]/.test(clean) ||
    /^[A-Za-z]:/.test(clean) ||
    clean.startsWith("~") ||
    clean.startsWith("file://")
  ) {
    return true;
  }
  return /\.(ttf|otf|woff2?|ttc)$/i.test(clean);
}

export function deriveFontDisplayName(pathOrName: string): string {
  const clean = normalizeFontPathInput(pathOrName);
  if (!clean) return "自定义字体";
  if (!isLikelyFontFilePath(clean)) return clean;
  const normalized = clean.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() || clean;
  const stem = fileName.replace(/\.(ttf|otf|woff2?|ttc)$/i, "").trim();
  return stem || fileName;
}

export function registerBrowserFontBuffer(key: string, buffer: ArrayBuffer): void {
  ephemeralBrowserFontBuffers.set(normalizeFontPathInput(key), buffer);
}

export function parseCustomFontConfig(raw?: string | null): CustomFontConfig {
  if (!raw || !raw.trim()) {
    return { ...DEFAULT_CUSTOM_FONT_CONFIG, fonts: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CustomFontConfig>;
    const rawFonts = Array.isArray(parsed.fonts) ? parsed.fonts : [];
    const fonts: CustomFontEntry[] = rawFonts
      .filter(
        (item): item is CustomFontEntry =>
          Boolean(item) &&
          typeof item.id === "string" &&
          typeof item.path === "string" &&
          normalizeFontPathInput(item.path).length > 0
      )
      .map((item) => ({
        id: item.id,
        path: normalizeFontPathInput(item.path),
        name:
          (typeof item.name === "string" && item.name.trim()) ||
          deriveFontDisplayName(item.path),
        portable: Boolean(item.portable),
        addedAt:
          typeof item.addedAt === "string" && item.addedAt
            ? item.addedAt
            : new Date().toISOString(),
      }));
    const activeId =
      typeof parsed.activeId === "string" &&
      fonts.some((f) => f.id === parsed.activeId)
        ? parsed.activeId
        : fonts[0]?.id ?? null;
    return {
      activeId,
      applyGlobalUi: Boolean(parsed.applyGlobalUi),
      fonts,
    };
  } catch {
    return { ...DEFAULT_CUSTOM_FONT_CONFIG, fonts: [] };
  }
}

export function serializeCustomFontConfig(cfg: CustomFontConfig): string {
  return JSON.stringify(cfg);
}

function toArrayBuffer(payload: unknown): ArrayBuffer {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    return payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength
    ) as ArrayBuffer;
  }
  if (Array.isArray(payload)) {
    return new Uint8Array(payload).buffer as ArrayBuffer;
  }
  throw new Error("字体数据格式异常，请确认文件未损坏");
}

function replaceActiveDocumentFontFace(nextFace: FontFace): void {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  for (const existing of Array.from(document.fonts)) {
    if (existing.family === CUSTOM_FONT_FACE_FAMILY) {
      document.fonts.delete(existing);
    }
  }
  document.fonts.add(nextFace);
}

export async function loadAndActivateCustomFont(
  pathOrFamily: string
): Promise<{ familyCss: string; resolvedDisplayName: string }> {
  const clean = normalizeFontPathInput(pathOrFamily);
  if (!clean) {
    throw new Error("请输入字体文件路径或字体名称");
  }

  if (!isLikelyFontFilePath(clean)) {
    const safeFamily = clean.replace(/["\\;{}<>]/g, "").trim();
    if (!safeFamily) {
      throw new Error("字体名称格式无效");
    }
    return {
      familyCss: `"${safeFamily}", ${CUSTOM_FONT_FALLBACK_STACK}`,
      resolvedDisplayName: safeFamily,
    };
  }

  const cached = loadedCustomFontFaces.get(clean);
  if (cached) {
    replaceActiveDocumentFontFace(cached);
    return {
      familyCss: `"${CUSTOM_FONT_FACE_FAMILY}", ${CUSTOM_FONT_FALLBACK_STACK}`,
      resolvedDisplayName: deriveFontDisplayName(clean),
    };
  }

  let fontBytes: ArrayBuffer | null =
    ephemeralBrowserFontBuffers.get(clean) ?? null;

  if (!fontBytes) {
    if (!isTauriRuntime()) {
      throw new Error(
        "浏览器预览模式下不支持直接读取任意磁盘绝对路径，请点击「浏览选择字体文件…」或使用桌面客户端。"
      );
    }
    const raw = await invoke<unknown>("load_custom_font_file", {
      path: clean,
    });
    fontBytes = toArrayBuffer(raw);
  }

  if (typeof FontFace === "undefined") {
    throw new Error("当前运行环境不支持 FontFace 动态字体加载");
  }

  const face = new FontFace(CUSTOM_FONT_FACE_FAMILY, fontBytes);
  const loadedFace = await face.load();
  loadedCustomFontFaces.set(clean, loadedFace);
  replaceActiveDocumentFontFace(loadedFace);

  return {
    familyCss: `"${CUSTOM_FONT_FACE_FAMILY}", ${CUSTOM_FONT_FALLBACK_STACK}`,
    resolvedDisplayName: deriveFontDisplayName(clean),
  };
}

export async function syncCustomFontDomVariables(
  cfg: CustomFontConfig,
  fontStyle: FontStylePref
): Promise<void> {
  if (typeof document === "undefined") return;
  const rootStyle = document.documentElement.style;
  const activeEntry =
    cfg.fonts.find((f) => f.id === cfg.activeId) ?? cfg.fonts[0] ?? null;

  if (!activeEntry) {
    rootStyle.removeProperty("--font-custom");
    rootStyle.removeProperty("--font-sans");
    return;
  }

  let familyCss = `"${CUSTOM_FONT_FACE_FAMILY}", ${CUSTOM_FONT_FALLBACK_STACK}`;
  try {
    const loaded = await loadAndActivateCustomFont(activeEntry.path);
    familyCss = loaded.familyCss;
    rootStyle.setProperty("--font-custom", familyCss);
  } catch {
    rootStyle.setProperty("--font-custom", familyCss);
  }

  if (fontStyle === "custom" && cfg.applyGlobalUi) {
    rootStyle.setProperty("--font-sans", familyCss);
  } else {
    rootStyle.removeProperty("--font-sans");
  }
}
