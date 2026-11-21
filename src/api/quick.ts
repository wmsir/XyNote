import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPage, getPageDetail, getSettings, listPages, setSetting, upsertBlock } from "./client";
import { isTauriRuntime } from "./client";
import type { Page } from "../types/notion";

export interface QuickCaptureConfig {
  shortcut: string;
  tray: boolean;
  closeToTray: boolean;
  shortcutActive: boolean;
  trayAvailable: boolean;
}

export const DEFAULT_QUICK_SHORTCUT = "CommandOrControl+Alt+N";

export async function getQuickCaptureConfig(): Promise<QuickCaptureConfig | null> {
  if (!isTauriRuntime()) return null;
  return invoke<QuickCaptureConfig>("quick_capture_get_config");
}

export async function setQuickCaptureConfig(cfg: {
  shortcut: string;
  tray: boolean;
  closeToTray: boolean;
}): Promise<QuickCaptureConfig> {
  return invoke<QuickCaptureConfig>("quick_capture_set_config", {
    shortcut: cfg.shortcut,
    tray: cfg.tray,
    closeToTray: cfg.closeToTray,
  });
}

export async function hideQuickWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("quick_capture_hide");
}

const INBOX_KEY = "quickCapture.inboxId";

/** 找到「收件箱」页面，没有就建一个 */
export async function ensureInbox(): Promise<Page> {
  const pages = await listPages();
  const id = (await getSettings())[INBOX_KEY];
  let inbox = id ? pages.find((p) => p.id === id) : undefined;
  if (!inbox) inbox = pages.find((p) => p.parentId === null && p.title === "收件箱");
  if (!inbox) {
    inbox = await createPage({ parentId: null, title: "收件箱", icon: "📥", pageType: "doc" });
  }
  if (inbox.id !== id) await setSetting(INBOX_KEY, inbox.id);
  return inbox;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TODO_RE = /^\s*(?:[-*]\s*)?\[\s?\]\s+/;

/**
 * 把一段快速记录追加到收件箱末尾。
 * 每行一块；以 `[] ` 或 `- [ ] ` 开头的行变成待办。
 */
export async function appendToInbox(text: string): Promise<Page> {
  const inbox = await ensureInbox();
  const detail = await getPageDetail(inbox.id);
  let order = detail.blocks.reduce((m, b) => Math.max(m, b.sortOrder), -1) + 1;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 去掉首尾空行
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const line of lines) {
    const isTodo = TODO_RE.test(line);
    const body = isTodo ? line.replace(TODO_RE, "") : line;
    await upsertBlock({
      pageId: inbox.id,
      blockType: isTodo ? "todo" : "paragraph",
      content: escapeHtml(body),
      plainText: body,
      props: isTodo ? { checked: false } : {},
      sortOrder: order++,
    });
  }
  return inbox;
}

/** 键盘事件 → 加速键字符串（Tauri 格式），只按了修饰键时返回 null */
export function eventToAccelerator(e: KeyboardEvent | React.KeyboardEvent, isMac: boolean): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (code === "Enter") key = "Enter";
  else if (code === "Backquote") key = "`";
  else if (code === "Slash") key = "/";
  else if (code === "Period") key = ".";
  else if (code === "Comma") key = ",";
  if (!key) return null;
  const parts: string[] = [];
  if (isMac) {
    if (e.metaKey) parts.push("CommandOrControl");
    if (e.ctrlKey) parts.push("Control");
  } else if (e.ctrlKey) {
    parts.push("CommandOrControl");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // 全局快捷键至少要一个修饰键（F 键除外），否则会吃掉正常输入
  if (parts.length === 0 && !/^F\d+$/.test(key)) return null;
  parts.push(key);
  return parts.join("+");
}

/** 加速键 → 给人看的写法 */
export function displayAccelerator(accel: string, isMac: boolean): string {
  if (!accel) return "";
  return accel
    .split("+")
    .map((p) => {
      if (p === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
      if (p === "Control") return isMac ? "⌃" : "Ctrl";
      if (p === "Alt") return isMac ? "⌥" : "Alt";
      if (p === "Shift") return isMac ? "⇧" : "Shift";
      return p;
    })
    .join(isMac ? "" : "+");
}
