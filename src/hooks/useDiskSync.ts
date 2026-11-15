import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  convertMarkdownBlocks,
  isTauriRuntime,
  LocalFileConflictError,
  onFsChanged,
  openLocalMarkdownFile,
  saveLocalMarkdownFile,
  saveMarkdownFileDialog,
  setWatchedPaths,
} from "../api/client";
import type { LocalMarkdownDocument, SaveBlockItem, WorkspaceFolder } from "../types/notion";

/** 尚未写入磁盘的本地文件改动（由 App 的防抖保存维护） */
export interface PendingLocalSave {
  timer: number;
  filePath: string;
  items: SaveBlockItem[] | null;
  rawMarkdown: string | null;
}

interface Options {
  activeLocalMd: LocalMarkdownDocument | null;
  activeLocalMdRef: React.MutableRefObject<LocalMarkdownDocument | null>;
  pendingLocalMdSaveRef: React.MutableRefObject<PendingLocalSave | null>;
  setActiveLocalMd: React.Dispatch<React.SetStateAction<LocalMarkdownDocument | null>>;
  setIsSaving: (saving: boolean) => void;
  showToast: (message: string, durationMs?: number) => void;
  workspaceFolders: WorkspaceFolder[];
  /** 文本编辑器里打开的文件，同样需要监听外部修改 */
  activeTextPath?: string | null;
}

/**
 * 磁盘文件同步：
 * - 保存时带上打开 / 上次保存时的修改时间，磁盘被其他程序改过就不覆盖，转为冲突处理；
 * - 监听挂载的文件夹与正在编辑的文件，外部改动实时反映到文件夹树和编辑器。
 */
export function useDiskSync({
  activeLocalMd,
  activeLocalMdRef,
  pendingLocalMdSaveRef,
  setActiveLocalMd,
  setIsSaving,
  showToast,
  workspaceFolders,
  activeTextPath = null,
}: Options) {
  // ===== 磁盘文件的冲突检测 =====
  // 记录每个磁盘文件「打开 / 上次保存」时的修改时间；保存时带上，磁盘被其他程序改过就不覆盖
  const localMtimeRef = useRef<Record<string, string>>({});
  // 同一时间只跑一个磁盘保存，避免前一次还没返回、后一次拿旧时间误报冲突
  const localSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [localConflict, setLocalConflict] = useState<{
    filePath: string;
    items: SaveBlockItem[] | null;
    rawMarkdown: string | null;
  } | null>(null);

  const rememberLocalMtime = useCallback((doc: LocalMarkdownDocument) => {
    localMtimeRef.current[doc.filePath] = doc.updatedAt;
  }, []);

  /** 带冲突检测的保存；冲突时弹出处理对话框并返回 null */
  const saveLocalChecked = useCallback(
    (filePath: string, items: SaveBlockItem[] | null, rawMarkdown: string | null) => {
      const run = async (): Promise<LocalMarkdownDocument | null> => {
        try {
          const saved = await saveLocalMarkdownFile(
            filePath,
            items,
            rawMarkdown,
            localMtimeRef.current[filePath] ?? null
          );
          localMtimeRef.current[saved.filePath] = saved.updatedAt;
          return saved;
        } catch (err) {
          if (err instanceof LocalFileConflictError) {
            setLocalConflict({ filePath, items, rawMarkdown });
            return null;
          }
          throw err;
        }
      };
      const next = localSaveChainRef.current.then(run, run);
      localSaveChainRef.current = next.catch(() => {});
      return next;
    },
    []
  );

  // ===== 监听磁盘变化：挂载的文件夹（递归）+ 正在编辑的文件 =====
  const activeLocalPath = activeLocalMd?.filePath ?? null;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    setWatchedPaths(
      workspaceFolders.map((f) => f.path),
      [activeLocalPath, activeTextPath].filter((p): p is string => !!p)
    ).catch(() => {});
  }, [workspaceFolders, activeLocalPath, activeTextPath]);

  // 正在编辑的文件被其他程序改了：没有未写入的改动就直接载入新内容，否则弹出冲突处理
  const checkExternalChangeRef = useRef<(filePath: string) => Promise<void>>(async () => {});
  checkExternalChangeRef.current = async (filePath: string) => {
    await localSaveChainRef.current;
    const cur = activeLocalMdRef.current;
    if (!cur || cur.filePath !== filePath) return;
    let disk: LocalMarkdownDocument;
    try {
      disk = await openLocalMarkdownFile(filePath);
    } catch {
      showToast(`「${cur.fileName}」已被删除或移动，当前内容只在编辑器里`, 4200);
      return;
    }
    if (disk.updatedAt === localMtimeRef.current[filePath]) return;
    const pending = pendingLocalMdSaveRef.current;
    if (pending && pending.filePath === filePath) {
      window.clearTimeout(pending.timer);
      pendingLocalMdSaveRef.current = null;
      setIsSaving(false);
      setLocalConflict({ filePath, items: pending.items, rawMarkdown: pending.rawMarkdown });
      return;
    }
    rememberLocalMtime(disk);
    setActiveLocalMd(disk);
    showToast(`已载入「${disk.fileName}」在别处的修改`);
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    onFsChanged((paths) => {
      // 文件夹树自己订阅这个事件来刷新
      window.dispatchEvent(new CustomEvent("xynote:fs-changed", { detail: paths }));
      const cur = activeLocalMdRef.current;
      if (cur && paths.some((p) => norm(p) === norm(cur.filePath))) {
        void checkExternalChangeRef.current(cur.filePath);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const [conflictBusy, setConflictBusy] = useState(false);
  const resolveConflict = useCallback(
    async (choice: "reload" | "overwrite" | "copy") => {
      const conflict = localConflict;
      if (!conflict) return;
      setConflictBusy(true);
      try {
        if (choice === "overwrite") {
          const saved = await saveLocalMarkdownFile(conflict.filePath, conflict.items, conflict.rawMarkdown, null);
          rememberLocalMtime(saved);
          setActiveLocalMd((prev) =>
            prev && prev.filePath === saved.filePath
              ? { ...prev, title: saved.title, markdown: saved.markdown, updatedAt: saved.updatedAt }
              : prev
          );
          showToast(`已用你的版本覆盖：${saved.fileName}`);
        } else {
          if (choice === "copy") {
            const content =
              conflict.rawMarkdown ??
              (await convertMarkdownBlocks({ blocks: conflict.items ?? [] })).markdown;
            const base = (conflict.filePath.split(/[\\/]/).pop() || "笔记.md").replace(/\.[^.]+$/, "");
            const copyPath = await saveMarkdownFileDialog(`${base}（我的版本）.md`, content);
            if (!copyPath) return; // 取消另存时保持对话框
            showToast("你的版本已另存，原文件载入磁盘上的版本");
          }
          const disk = await openLocalMarkdownFile(conflict.filePath);
          rememberLocalMtime(disk);
          setActiveLocalMd(disk);
        }
        setLocalConflict(null);
      } catch (err) {
        showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`, 3800);
      } finally {
        setConflictBusy(false);
      }
    },
    [localConflict, rememberLocalMtime, showToast]
  );


  return {
    localMtimeRef,
    localSaveChainRef,
    localConflict,
    setLocalConflict,
    rememberLocalMtime,
    saveLocalChecked,
    conflictBusy,
    resolveConflict,
  };
}
