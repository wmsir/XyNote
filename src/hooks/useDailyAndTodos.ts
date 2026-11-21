import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Page, PageDetail, TodoItem } from "../types/notion";
import { getPageDetail, getSettings, listOpenTodos, setSetting, upsertBlock } from "../api/client";
import { ensureDailyNote, existingDailyDates, loadDailyConfig, saveDailyConfig, type DailyNotesConfig } from "../api/daily";
import { listCustomTemplates } from "../api/templates";
import { isMainWindow, sendSystemNotification } from "../api/desktop";
import { TEMPLATES } from "../components/shell/TemplatesModal";
import { dueBucket, parseDue } from "../utils/dueDate";
import type { DailyTemplateOption } from "../components/shell/DailyCalendar";

const RECENT_KEY = "recentPageIds";
const RECENT_MAX = 15;
const RECENT_SHOWN = 8;
const FIRED_KEY = "xynote.reminders.fired";
/** 启动时只补发最近这么久之内错过的提醒，更早的只在待办汇总里显示为逾期 */
const CATCH_UP_MS = 12 * 3600 * 1000;

interface Options {
  pages: Page[];
  detail: PageDetail | null;
  activePageId: string | null;
  loadPageDetailById: (pageId: string, blockId?: string | null) => Promise<void>;
  refreshSidebarLists: () => Promise<unknown>;
  flushPendingBlockSave: () => Promise<void>;
  showToast: (msg: string, durationMs?: number) => void;
}

function loadFired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveFired(s: Set<string>) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* ignore */
  }
}

/** 每日笔记、最近访问、待办汇总与到点提醒 */
export function useDailyAndTodos({
  pages,
  detail,
  activePageId,
  loadPageDetailById,
  refreshSidebarLists,
  flushPendingBlockSave,
  showToast,
}: Options) {
  // ── 最近访问 ──────────────────────────────────────────────
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const recentLoaded = useRef(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        try {
          const v = JSON.parse(s[RECENT_KEY] || "[]");
          if (Array.isArray(v)) setRecentIds(v.filter((x) => typeof x === "string"));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {})
      .finally(() => {
        recentLoaded.current = true;
      });
  }, []);

  useEffect(() => {
    if (!activePageId || !recentLoaded.current) return;
    setRecentIds((prev) => {
      if (prev[0] === activePageId) return prev;
      const next = [activePageId, ...prev.filter((id) => id !== activePageId)].slice(0, RECENT_MAX);
      setSetting(RECENT_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [activePageId]);

  const recentPages = useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((p): p is Page => !!p)
      .slice(0, RECENT_SHOWN);
  }, [pages, recentIds]);

  const clearRecent = useCallback(() => {
    setRecentIds([]);
    setSetting(RECENT_KEY, "[]").catch(() => {});
  }, []);

  // ── 每日笔记 ──────────────────────────────────────────────
  const [dailyCfg, setDailyCfg] = useState<DailyNotesConfig>({ rootId: null, map: {}, templateId: null });
  const [customTpls, setCustomTpls] = useState<DailyTemplateOption[]>([]);

  useEffect(() => {
    loadDailyConfig().then(setDailyCfg).catch(() => {});
    listCustomTemplates()
      .then((list) =>
        setCustomTpls(list.filter((t) => t.pageType === "doc").map((t) => ({ id: `custom:${t.id}`, title: t.title })))
      )
      .catch(() => {});
  }, []);

  const dailyTemplates = useMemo<DailyTemplateOption[]>(
    () => [
      ...TEMPLATES.filter((t) => t.pageType === "doc").map((t) => ({ id: t.id, title: t.title })),
      ...customTpls,
    ],
    [customTpls]
  );

  const dailyDates = useMemo(() => existingDailyDates(dailyCfg, pages), [dailyCfg, pages]);

  const openDailyNote = useCallback(
    async (day: Date = new Date()) => {
      try {
        await flushPendingBlockSave();
        const { page } = await ensureDailyNote(day);
        await refreshSidebarLists();
        await loadPageDetailById(page.id, null);
        setDailyCfg(await loadDailyConfig());
      } catch (err) {
        showToast(`打开每日笔记失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [flushPendingBlockSave, loadPageDetailById, refreshSidebarLists, showToast]
  );

  const setDailyTemplate = useCallback(async (templateId: string | null) => {
    const cfg = await loadDailyConfig();
    const next = { ...cfg, templateId };
    await saveDailyConfig(next);
    setDailyCfg(next);
  }, []);

  // ── 待办汇总 ──────────────────────────────────────────────
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoLoading, setTodoLoading] = useState(false);

  const refreshTodos = useCallback(async () => {
    setTodoLoading(true);
    try {
      const list = await listOpenTodos();
      setTodos(list);
      return list;
    } catch {
      return null;
    } finally {
      setTodoLoading(false);
    }
  }, []);

  const todoBadge = useMemo(() => {
    const now = new Date();
    return todos.filter((t) => {
      const b = dueBucket(t.dueAt, now);
      return b === "overdue" || b === "today";
    }).length;
  }, [todos]);

  const openTodoCenter = useCallback(() => {
    setTodoOpen(true);
    flushPendingBlockSave()
      .catch(() => {})
      .finally(() => {
        refreshTodos().catch(() => {});
      });
  }, [flushPendingBlockSave, refreshTodos]);

  /** 改某条待办的属性：直接写库；如果它所在页面正开着，重新载入这一页 */
  const patchTodo = useCallback(
    async (item: TodoItem, patch: (props: Record<string, unknown>) => Record<string, unknown>) => {
      await flushPendingBlockSave();
      const d = await getPageDetail(item.pageId);
      const block = d.blocks.find((b) => b.id === item.blockId);
      if (!block) {
        showToast("这条待办已经不存在了");
        await refreshTodos();
        return;
      }
      await upsertBlock({
        id: block.id,
        pageId: block.pageId,
        blockType: block.blockType,
        content: block.content,
        plainText: block.plainText,
        props: patch({ ...block.props }) as typeof block.props,
        sortOrder: block.sortOrder,
      });
      if (detail?.page.id === item.pageId) {
        await loadPageDetailById(item.pageId, null);
      }
    },
    [detail, flushPendingBlockSave, loadPageDetailById, refreshTodos, showToast]
  );

  const completeTodo = useCallback(
    (item: TodoItem) => {
      patchTodo(item, (p) => ({ ...p, checked: true }))
        .then(() => {
          // 留一下勾选动画再从列表里移除
          window.setTimeout(() => {
            setTodos((list) => list.filter((t) => t.blockId !== item.blockId));
          }, 600);
        })
        .catch((err) => showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [patchTodo, showToast]
  );

  const setTodoDue = useCallback(
    (item: TodoItem, dueAt: string | null) => {
      patchTodo(item, (p) => {
        const next = { ...p };
        if (dueAt) next.dueAt = dueAt;
        else delete next.dueAt;
        return next;
      })
        .then(() => setTodos((list) => list.map((t) => (t.blockId === item.blockId ? { ...t, dueAt } : t))))
        .catch((err) => showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [patchTodo, showToast]
  );

  const openTodoItem = useCallback(
    (item: TodoItem) => {
      setTodoOpen(false);
      loadPageDetailById(item.pageId, item.blockId).catch(() => {});
    },
    [loadPageDetailById]
  );

  // ── 到点提醒（只在主窗口里跑，避免多窗口重复弹） ────────────
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    const isMain = isMainWindow();
    let stopped = false;
    const startedAt = Date.now();

    const tick = async () => {
      const list = await refreshTodos();
      if (!list || stopped || !isMain) return;
      const fired = loadFired();
      const now = Date.now();
      let changed = false;
      for (const t of list) {
        const due = parseDue(t.dueAt);
        if (!due) continue;
        const at = due.getTime();
        if (at > now) continue;
        const key = `${t.blockId}@${t.dueAt}`;
        if (fired.has(key)) continue;
        fired.add(key);
        changed = true;
        // 很久以前就过期的不补发通知
        if (at < startedAt - CATCH_UP_MS) continue;
        const body = `${t.text || "（未命名待办）"}\n— ${t.pageTitle || "无标题"}`;
        sendSystemNotification("待办提醒", body).catch(() => false);
        showToastRef.current(`⏰ 待办提醒：${t.text || "（未命名待办）"}`, 6000);
      }
      if (changed) saveFired(fired);
    };

    const first = window.setTimeout(() => void tick(), 1500);
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refreshTodos]);

  // 正在编辑的页面变了之后稍等一下再刷新待办（保存是防抖的）
  const detailStamp = detail ? `${detail.page.id}:${detail.blocks.length}:${detail.page.updatedAt}` : "";
  useEffect(() => {
    if (!detailStamp) return;
    const t = window.setTimeout(() => void refreshTodos(), 2500);
    return () => window.clearTimeout(t);
  }, [detailStamp, refreshTodos]);

  return {
    recentPages,
    clearRecent,
    dailyDates,
    dailyTemplateId: dailyCfg.templateId,
    dailyTemplates,
    openDailyNote,
    setDailyTemplate,
    todos,
    todoOpen,
    setTodoOpen,
    todoLoading,
    todoBadge,
    refreshTodos,
    openTodoCenter,
    completeTodo,
    setTodoDue,
    openTodoItem,
  };
}
