import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";
import { exportPageHtml } from "./pro";

export interface PublishedInfo {
  url: string;
  slug: string;
}

/** 把页面发布成只读网页（需要小悦同步服务器），返回网址 */
export async function publishPageWeb(pageId: string, title: string): Promise<PublishedInfo> {
  if (!isTauriRuntime()) throw new Error("发布网页只在桌面版里可用");
  const { html } = await exportPageHtml(pageId);
  return invoke<PublishedInfo>("publish_page_web", { pageId, title, html });
}

export async function unpublishPageWeb(pageId: string): Promise<void> {
  await invoke("unpublish_page_web", { pageId });
}

export async function publishedPageUrl(pageId: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return invoke<string | null>("published_page_url", { pageId });
}

export interface InboxRemoteItem {
  id: number;
  text: string;
}

export async function pullServerInbox(): Promise<InboxRemoteItem[]> {
  if (!isTauriRuntime()) return [];
  return invoke<InboxRemoteItem[]>("server_inbox_pull");
}

export async function ackServerInbox(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await invoke("server_inbox_ack", { ids });
}
