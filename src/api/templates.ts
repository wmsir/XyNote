/** 我的模板（自定义模板）：保存在本机数据库里 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./client";
import type { PageType } from "../types/notion";

export interface CustomTemplateBlock {
  blockType: string;
  content: string;
  plainText: string;
  props: Record<string, unknown>;
  sortOrder: number;
}

export interface CustomTemplateColumn {
  id: string;
  name: string;
  colType: string;
  options: unknown[];
  width: number;
  sortOrder: number;
}

export interface CustomTemplate {
  id: string;
  title: string;
  icon: string;
  description: string;
  pageType: PageType;
  payload: {
    blocks: CustomTemplateBlock[];
    columns: CustomTemplateColumn[];
    activeView: string | null;
    groupByColId: string | null;
    rows: { cells: Record<string, unknown>; sortOrder: number }[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface TemplateMeta {
  title?: string;
  icon?: string;
  description?: string;
}

const DESKTOP_ONLY = "自定义模板仅支持桌面客户端";

export async function listCustomTemplates(): Promise<CustomTemplate[]> {
  if (!isTauriRuntime()) return [];
  return invoke<CustomTemplate[]>("list_custom_templates");
}

export async function savePageAsTemplate(pageId: string, meta?: TemplateMeta, replaceId?: string): Promise<CustomTemplate> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<CustomTemplate>("save_page_as_template", { pageId, meta: meta ?? null, replaceId: replaceId ?? null });
}

export async function updateCustomTemplate(id: string, meta: TemplateMeta): Promise<CustomTemplate> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<CustomTemplate>("update_custom_template", { id, meta });
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<void>("delete_custom_template", { id });
}

export async function importCustomTemplates(items: CustomTemplate[]): Promise<number> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_ONLY);
  return invoke<number>("import_custom_templates", { items });
}

export const TEMPLATE_FILE_SCHEMA = "xynote-templates-v1";

/** 模板第一屏的文字预览 */
export function templatePreviewLines(t: CustomTemplate, max = 8): string[] {
  if (t.pageType === "database") {
    const cols = t.payload.columns.map((c) => c.name).filter(Boolean);
    return [`列：${cols.join("、") || "（无）"}`, `示例行：${t.payload.rows.length} 行`];
  }
  return t.payload.blocks
    .map((b) => (b.plainText || b.content.replace(/<[^>]+>/g, "")).trim())
    .filter(Boolean)
    .slice(0, max);
}
