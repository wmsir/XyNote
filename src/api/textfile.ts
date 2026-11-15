/**
 * 文本文件编辑器的后端接口：按原编码 / 换行读写磁盘文件。仅桌面端可用。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";

export type TextEncoding = "UTF-8" | "UTF-8 BOM" | "GBK" | "GB18030" | "UTF-16 LE" | "UTF-16 BE";
export type LineEnding = "CRLF" | "LF" | "CR";

export const TEXT_ENCODINGS: TextEncoding[] = ["UTF-8", "UTF-8 BOM", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE"];
export const LINE_ENDINGS: { id: LineEnding; label: string }[] = [
  { id: "CRLF", label: "Windows (CRLF)" },
  { id: "LF", label: "Unix / macOS (LF)" },
  { id: "CR", label: "旧版 Mac (CR)" },
];

export interface TextFileDocument {
  filePath: string;
  fileName: string;
  /** 统一为 \n 的内容 */
  content: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  size: number;
  modifiedMs: number;
  /** 解码时有无法识别的字节 */
  hadErrors: boolean;
}

export interface TextSaveResult {
  size: number;
  modifiedMs: number;
}

const DESKTOP_ONLY = "打开文本文件仅支持桌面客户端";

/** Markdown 用块编辑器打开，其他文件用文本编辑器 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

export async function openTextFile(path: string, encoding?: TextEncoding): Promise<TextFileDocument> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<TextFileDocument>("open_text_file", { path, encoding: encoding ?? null });
}

export async function saveTextFile(
  path: string,
  content: string,
  encoding: TextEncoding,
  lineEnding: LineEnding,
  expectedModifiedMs: number | null
): Promise<TextSaveResult> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<TextSaveResult>("save_text_file", { path, content, encoding, lineEnding, expectedModifiedMs });
}

export async function openWithSystemApp(path: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<void>("open_with_system_app", { path });
}

/** 后端返回的错误：二进制文件 / 外部修改冲突 */
export function isBinaryFileError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err).includes("BINARY:");
}

export function conflictModifiedMs(err: unknown): number | null {
  const m = String(err instanceof Error ? err.message : err).match(/^Conflict: (\d+)/);
  return m ? Number(m[1]) : null;
}

/** 把后端错误整理成给人看的一句话 */
export function textErrorText(err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  return raw
    .replace(/^(Validation error|Not found|IO error): /, "")
    .replace(/^BINARY: /, "");
}
