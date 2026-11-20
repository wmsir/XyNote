import { createPage, getSettings, listPages, setSetting } from "./client";
import type { Page } from "../types/notion";
import { dailyTitle, dateKey } from "../utils/dueDate";

/** 每日笔记的设置，存在 settings 表的 dailyNotes 键里 */
export interface DailyNotesConfig {
  /** 「每日笔记」父页面 */
  rootId: string | null;
  /** 日期 → 页面 id */
  map: Record<string, string>;
  /** 新建每日笔记时套用的模板（custom:<id> 或内置模板 id），空 = 空白页 */
  templateId: string | null;
}

const KEY = "dailyNotes";

export async function loadDailyConfig(): Promise<DailyNotesConfig> {
  try {
    const raw = (await getSettings())[KEY];
    if (raw) {
      const v = JSON.parse(raw) as Partial<DailyNotesConfig>;
      return { rootId: v.rootId ?? null, map: v.map ?? {}, templateId: v.templateId ?? null };
    }
  } catch {
    /* 设置损坏时从头开始 */
  }
  return { rootId: null, map: {}, templateId: null };
}

export async function saveDailyConfig(cfg: DailyNotesConfig): Promise<void> {
  await setSetting(KEY, JSON.stringify(cfg));
}

/** 已存在（且不在回收站）的每日笔记日期 */
export function existingDailyDates(cfg: DailyNotesConfig, pages: Page[]): Set<string> {
  const alive = new Set(pages.map((p) => p.id));
  return new Set(Object.entries(cfg.map).filter(([, id]) => alive.has(id)).map(([k]) => k));
}

/**
 * 找到某天的每日笔记，没有就创建。
 * 页面都放在「每日笔记」父页面下；父页面被删了会重新建一个。
 */
export async function ensureDailyNote(day: Date): Promise<{ page: Page; created: boolean }> {
  const cfg = await loadDailyConfig();
  const pages = await listPages();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const key = dateKey(day);

  const existing = cfg.map[key] ? byId.get(cfg.map[key]) : undefined;
  if (existing) return { page: existing, created: false };

  let root = cfg.rootId ? byId.get(cfg.rootId) : undefined;
  if (!root) {
    root = pages.find((p) => p.parentId === null && p.title === "每日笔记");
  }
  if (!root) {
    root = await createPage({ parentId: null, title: "每日笔记", icon: "📅", pageType: "doc" });
  }

  // 用户手动建过同名页面就直接用
  const adopted = pages.find((p) => p.parentId === root!.id && p.title.startsWith(key));
  const page =
    adopted ??
    (await createPage({
      parentId: root.id,
      title: dailyTitle(day),
      icon: "📝",
      pageType: "doc",
      templateId: cfg.templateId || null,
    }));

  const next: DailyNotesConfig = { ...cfg, rootId: root.id, map: { ...cfg.map, [key]: page.id } };
  await saveDailyConfig(next);
  return { page, created: !adopted };
}
