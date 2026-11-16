import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, FilePlus2, FolderOpen, Sparkles, Trash2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSyncController } from "./hooks/useSyncController";
import { exportPageFile, exportPageHtml } from "./api/pro";
import { printHtmlDocument } from "./utils/printHtml";
import { PageHistoryModal } from "./components/shell/PageHistoryModal";
import { TextEditor } from "./components/editor/TextEditor";
import {
  isBinaryFileError,
  isMarkdownPath,
  openTextFile,
  openWithSystemApp,
  textErrorText,
  type TextFileDocument,
} from "./api/textfile";
import { createFolderEntry } from "./api/folders";
import { initialPageFromUrl, openNewWindow, saveExportImages } from "./api/desktop";
import { renderHtmlToPngParts } from "./utils/exportImage";
import { UpdateNotice } from "./components/shell/UpdateCheck";
import type { ExportFormat } from "./components/shell/Topbar";
import { savePageAsTemplate } from "./api/templates";
import {
  convertMarkdownBlocks,
  createPage,
  deletePagePermanently,
  duplicatePage,
  emptyTrash,
  exportPageMarkdown,
  getPageDetail,
  getSettings,
  getStorageInfo,
  importLocalPaths,
  importMarkdownPage,
  importMarkdownTree,
  importNotionZipBytes,
  importStylePluginContent,
  isTauriRuntime,
  listPages,
  listStylePlugins,
  listTrashedPages,
  openLocalMarkdownFile,
  openPathInExplorer,
  pickFolderDialog,
  pickMarkdownFileDialog,
  registerBrowserLocalMarkdownFile,
  restorePage,
  saveLocalMarkdownFile,
  saveMarkdownFileDialog,
  savePageBlocks,
  setSetting,
  toggleStylePlugin,
  trashPage,
  updatePage,
} from "./api/client";
import type {
  BatchImportResult,
  Block,
  CreatePageInput,
  DocumentStats,
  EditorPreferences,
  EditorViewMode,
  KeybindingMap,
  LocalMarkdownDocument,
  WorkspaceFolder,
  MarkdownExport,
  Page,
  PageDetail,
  SaveBlockItem,
  StorageConfigInfo,
  StylePluginState,
  ThemeTokens,
  UpdatePagePatch,
} from "./types/notion";
import { BlockEditor } from "./components/editor/BlockEditor";
import { DatabaseView } from "./components/database/DatabaseView";
import { RecentLocalMdItem, Sidebar } from "./components/shell/Sidebar";
import {
  FontStyleMode,
  ThemeMode,
  Topbar,
} from "./components/shell/Topbar";
import { PageHeader } from "./components/shell/PageHeader";
import { CommandPalette } from "./components/shell/CommandPalette";
import { TemplatesModal } from "./components/shell/TemplatesModal";
import { TrashModal } from "./components/shell/TrashModal";
import { FileConflictDialog } from "./components/shell/FileConflictDialog";
import { useDiskSync } from "./hooks/useDiskSync";
import { MarkdownModal } from "./components/shell/MarkdownModal";
import { PageFooterExtras } from "./components/shell/PageFooterExtras";
import {
  SettingsModal,
  SettingsTabId,
  ThemePreference,
} from "./components/shell/SettingsModal";
import { StatusBar } from "./components/shell/StatusBar";
import {
  collectFilesFromDataTransfer,
  filterImportableOsPaths,
  formatBatchImportSummary,
  isStylePluginFilePath,
  readFileAsBase64,
} from "./components/shell/fileDropUtils";
import {
  DEFAULT_KEYBINDINGS,
  extractKeybindingOverrides,
  mergeKeybindings,
  normalizeKeyboardEventToShortcut,
} from "./components/shell/keybindingRegistry";
import {
  applyRuntimeStylePluginsToDom,
  resolveEffectiveBaseMode,
} from "./components/shell/stylePluginEngine";

const EnhancedBlockEditor = BlockEditor as React.ComponentType<
  React.ComponentProps<typeof BlockEditor> & {
    preferences?: EditorPreferences;
    rawMarkdownOverride?: string | null;
    onViewModeChange?: (mode: EditorViewMode) => void;
    onRawMarkdownChange?: (markdown: string, parsedBlocks: Block[]) => void;
    onStatsChange?: (stats: DocumentStats) => void;
  }
>;

const DEFAULT_EDITOR_PREFS: EditorPreferences = {
  viewMode: "wysiwyg",
  focusMode: false,
  typewriterMode: false,
  showOutline: false,
  smartMarkdownPaste: true,
  inlineMarkdownShortcuts: true,
  codeLineNumbers: true,
  codeWordWrap: true,
  tabSize: 2,
  spellcheck: false,
  imageSaveMode: "assets",
};

function computeFallbackStats(blocks: Block[]): DocumentStats {
  const joined = blocks
    .map((b) =>
      b.blockType === "code" ||
      b.blockType === "math" ||
      b.blockType === "mermaid"
        ? b.content
        : b.plainText || b.content.replace(/<[^>]+>/g, "")
    )
    .join("\n");
  const cjkMatches = joined.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkWords = joined
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const words = cjkCount + nonCjkWords;
  const chars = joined.replace(/\r?\n/g, "").length;
  const lines = joined ? joined.split(/\r?\n/).length : 0;
  const readingMinutes = Math.max(1, Math.ceil(words / 300));
  return {
    words,
    chars,
    lines,
    readingMinutes,
    blockCount: blocks.length,
  };
}

export const App: React.FC = () => {
  const [pages, setPages] = useState<Page[]>([]);
  const [trashedPages, setTrashedPages] = useState<Page[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [highlightBlockId, setHighlightBlockId] = useState<string | null>(null);

  // Direct local .md file mode (Typora workflow)
  const [activeLocalMd, setActiveLocalMd] =
    useState<LocalMarkdownDocument | null>(null);
  const [recentLocalMdFiles, setRecentLocalMdFiles] = useState<
    RecentLocalMdItem[]
  >([]);
  // 侧栏「文件夹」里挂载的磁盘文件夹
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  /** 文本编辑器里打开的磁盘文件（.txt、.json、代码等） */
  const [activeTextFile, setActiveTextFile] = useState<TextFileDocument | null>(null);

  // Appearance & Layout
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [zenMode, setZenMode] = useState(false);
  const preZenSidebarRef = useRef(false);

  const [themePref, setThemePref] = useState<ThemePreference>("light");
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );
  const [fontStyle, setFontStyle] = useState<FontStyleMode>("sans");
  const [editorFontSize, setEditorFontSize] = useState<number>(16);
  const [editorLineHeight, setEditorLineHeight] = useState<number>(1.68);
  const [fullWidth, setFullWidth] = useState(true);
  const [showStatusBar, setShowStatusBar] = useState(true);

  // Commercial v0.3.0 Editor Preferences, Keybindings, Style Plugins, Storage & Stats
  const [editorPrefs, setEditorPrefs] =
    useState<EditorPreferences>(DEFAULT_EDITOR_PREFS);
  const [keybindings, setKeybindings] = useState<KeybindingMap>(() => ({
    ...DEFAULT_KEYBINDINGS,
  }));
  const [stylePluginState, setStylePluginState] =
    useState<StylePluginState | null>(null);
  const [themePreviewOverride, setThemePreviewOverride] = useState<{
    baseMode?: ThemeMode;
    tokens?: ThemeTokens | null;
    extraCss?: string;
  } | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageConfigInfo | null>(null);
  const [docStats, setDocStats] = useState<DocumentStats>({
    words: 0,
    chars: 0,
    lines: 0,
    readingMinutes: 1,
    blockCount: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isBatchImporting, setIsBatchImporting] = useState(false);
  const [windowDragActive, setWindowDragActive] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [focusTitleRequest, setFocusTitleRequest] = useState<{
    pageId: string;
    token: number;
  } | null>(null);
  const focusTokenRef = useRef(0);

  // Modal states
  const [searchOpen, setSearchOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateFocusId, setTemplateFocusId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsTabId>("storage");
  const [markdownModalMode, setMarkdownModalMode] = useState<
    "import" | "notion-zip" | "export" | null
  >(null);
  const [exportPayload, setExportPayload] = useState<MarkdownExport | null>(
    null
  );

  // Pending save trackers
  const pendingSaveRef = useRef<{
    timer: number;
    pageId: string;
    items: SaveBlockItem[];
  } | null>(null);
  const pendingLocalMdSaveRef = useRef<{
    timer: number;
    filePath: string;
    items: SaveBlockItem[] | null;
    rawMarkdown: string | null;
  } | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const detailRef = useRef<PageDetail | null>(null);
  const activeLocalMdRef = useRef<LocalMarkdownDocument | null>(null);
  const editorPrefsRef = useRef<EditorPreferences>(DEFAULT_EDITOR_PREFS);
  const keybindingsRef = useRef<KeybindingMap>(keybindings);
  const dragDepthRef = useRef<number>(0);
  const browserMdInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    activeLocalMdRef.current = activeLocalMd;
  }, [activeLocalMd]);

  useEffect(() => {
    editorPrefsRef.current = editorPrefs;
  }, [editorPrefs]);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  const effectiveEditorPrefs = useMemo<EditorPreferences>(
    () => ({
      ...editorPrefs,
      keybindings,
    }),
    [editorPrefs, keybindings]
  );

  // System color scheme listener
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (ev: MediaQueryListEvent) => setSystemDark(ev.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const effectiveTheme: ThemeMode = useMemo(() => {
    if (themePreviewOverride?.baseMode) {
      return themePreviewOverride.baseMode;
    }
    return resolveEffectiveBaseMode(stylePluginState, themePref, systemDark);
  }, [stylePluginState, themePref, systemDark, themePreviewOverride]);

  // Apply theme attribute & class to document root
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    document.documentElement.className = `theme-${effectiveTheme}`;
  }, [effectiveTheme]);

  // Inject custom ThemeTokens & active CSS Snippet Plugins into <head>
  useEffect(() => {
    applyRuntimeStylePluginsToDom(stylePluginState, themePreviewOverride);
  }, [stylePluginState, themePreviewOverride]);

  // Apply dynamic CSS variables for editor typography
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${editorFontSize}px`
    );
    document.documentElement.style.setProperty(
      "--editor-line-height",
      String(editorLineHeight)
    );
  }, [editorFontSize, editorLineHeight]);

  // Keep baseline stats synchronized when switching documents
  useEffect(() => {
    if (activeLocalMd) {
      setDocStats(computeFallbackStats(activeLocalMd.blocks));
    } else if (detail && detail.page.pageType === "doc") {
      setDocStats(computeFallbackStats(detail.blocks));
    }
  }, [activeLocalMd?.filePath, detail?.page.id]);

  const showToast = useCallback((msg: string, durationMs = 2800) => {
    setToastMessage(msg);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, durationMs);
  }, []);

  // 磁盘文件：冲突检测、带冲突检测的保存、磁盘监听（见 hooks/useDiskSync.ts）
  const {
    localMtimeRef,
    localSaveChainRef,
    localConflict,
    setLocalConflict,
    rememberLocalMtime,
    saveLocalChecked,
    conflictBusy,
    resolveConflict,
  } = useDiskSync({
    activeLocalMd,
    activeLocalMdRef,
    pendingLocalMdSaveRef,
    setActiveLocalMd,
    setIsSaving,
    showToast,
    workspaceFolders,
    activeTextPath: activeTextFile?.filePath ?? null,
  });

  const flushPendingBlockSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingSaveRef.current = null;
      setIsSaving(true);
      try {
        await savePageBlocks(pending.pageId, pending.items);
      } catch {
        // Ignore transient save failure
      } finally {
        setIsSaving(false);
      }
    }

    const pendingLocal = pendingLocalMdSaveRef.current;
    if (pendingLocal) {
      window.clearTimeout(pendingLocal.timer);
      pendingLocalMdSaveRef.current = null;
      setIsSaving(true);
      try {
        const saved = await saveLocalChecked(
          pendingLocal.filePath,
          pendingLocal.items,
          pendingLocal.rawMarkdown
        );
        if (saved) setActiveLocalMd((prev) =>
          prev && prev.filePath === saved.filePath
            ? { ...prev, markdown: saved.markdown, updatedAt: saved.updatedAt }
            : prev
        );
      } catch {
        // Ignore transient save failure
      } finally {
        setIsSaving(false);
      }
    }
  }, [saveLocalChecked]);

  const refreshSidebarLists = useCallback(async () => {
    const [activeList, trashList] = await Promise.all([
      listPages(),
      listTrashedPages(),
    ]);
    setPages(activeList);
    setTrashedPages(trashList);
    return { activeList, trashList };
  }, []);

  const loadPageDetailById = useCallback(
    async (pageId: string, blockIdToHighlight: string | null = null) => {
      await flushPendingBlockSave();
      const loaded = await getPageDetail(pageId);
      setActiveLocalMd(null);
      setActiveTextFile(null);
      setActivePageId(pageId);
      setDetail(loaded);
      setHighlightBlockId(blockIdToHighlight);
      setSetting("lastActivePageId", pageId).catch(() => {});
    },
    [flushPendingBlockSave]
  );

  /** 同步下载了远端变更：刷新列表；当前页在别处被改过或被删除时重新载入 */
  const handleRemoteSyncChanges = useCallback(async () => {
    const { activeList } = await refreshSidebarLists();
    const cur = detailRef.current;
    if (!cur || activeLocalMdRef.current) return;
    const stamp = (d: PageDetail) =>
      [d.page.updatedAt, ...d.blocks.map((b) => b.updatedAt)].sort().pop() ?? "";
    try {
      const fresh = await getPageDetail(cur.page.id);
      if (stamp(fresh) > stamp(cur) || fresh.page.title !== cur.page.title) {
        setDetail(fresh);
      }
    } catch {
      const next = activeList[0];
      if (next) {
        await loadPageDetailById(next.id);
      } else {
        setActivePageId(null);
        setDetail(null);
      }
    }
  }, [refreshSidebarLists, loadPageDetailById]);

  // 多窗口：切回这个窗口时，载入其他窗口里的修改（页面列表与当前页面）
  const focusRefreshAt = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - focusRefreshAt.current < 1500) return;
      focusRefreshAt.current = now;
      handleRemoteSyncChanges().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [handleRemoteSyncChanges]);

  const { syncConfig, setSyncConfig, syncing, syncNow } = useSyncController({
    ready: !isLoading,
    isSaving,
    flushPendingSaves: flushPendingBlockSave,
    onRemoteChanges: handleRemoteSyncChanges,
    showToast,
  });

  const [historyOpen, setHistoryOpen] = useState(false);

  const handleVersionRestored = useCallback(
    async (pageId: string) => {
      await refreshSidebarLists();
      if (detailRef.current?.page.id === pageId) {
        setDetail(await getPageDetail(pageId));
      }
    },
    [refreshSidebarLists]
  );

  const pushRecentLocalMd = useCallback((doc: { filePath: string; fileName: string; title: string }) => {
    setRecentLocalMdFiles((prev) => {
      const filtered = prev.filter((item) => item.filePath !== doc.filePath);
      const next = [
        {
          filePath: doc.filePath,
          fileName: doc.fileName,
          title: doc.title,
        },
        ...filtered,
      ].slice(0, 12);
      setSetting("recentLocalMdFiles", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleRemoveRecentLocalMd = useCallback((filePath: string) => {
    setRecentLocalMdFiles((prev) => {
      const next = prev.filter((item) => item.filePath !== filePath);
      setSetting("recentLocalMdFiles", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const openLocalMdByPath = useCallback(
    async (filePath: string) => {
      await flushPendingBlockSave();
      try {
        const doc = await openLocalMarkdownFile(filePath);
        rememberLocalMtime(doc);
        setActiveTextFile(null);
        setActiveLocalMd(doc);
        pushRecentLocalMd(doc);
        showToast(`正在直编本地文件：${doc.fileName}`);
      } catch (err) {
        showToast(
          `无法打开文件：${err instanceof Error ? err.message : String(err)}`,
          3800
        );
      }
    },
    [flushPendingBlockSave, pushRecentLocalMd, rememberLocalMtime, showToast]
  );

  /** 打开磁盘文件：Markdown 用块编辑器，其他文本用文本编辑器，二进制交给系统程序 */
  const openFileByPath = useCallback(
    async (filePath: string) => {
      if (isMarkdownPath(filePath)) {
        await openLocalMdByPath(filePath);
        return;
      }
      await flushPendingBlockSave();
      try {
        const doc = await openTextFile(filePath);
        setActiveLocalMd(null);
        setActiveTextFile(doc);
        pushRecentLocalMd({ filePath: doc.filePath, fileName: doc.fileName, title: doc.fileName });
      } catch (err) {
        if (isBinaryFileError(err)) {
          try {
            await openWithSystemApp(filePath);
            showToast("这个文件不是文本，已用系统默认程序打开");
          } catch (e2) {
            showToast(`无法打开：${textErrorText(e2)}`, 3800);
          }
          return;
        }
        showToast(`无法打开文件：${textErrorText(err)}`, 3800);
      }
    },
    [openLocalMdByPath, flushPendingBlockSave, pushRecentLocalMd, showToast]
  );

  // 打开了 Markdown 文件时关掉文本编辑器
  useEffect(() => {
    if (activeLocalMd) setActiveTextFile(null);
  }, [activeLocalMd?.filePath]);

  const persistWorkspaceFolders = useCallback((next: WorkspaceFolder[]) => {
    setSetting("workspaceFolders", JSON.stringify(next)).catch(() => {});
  }, []);

  const handleAddWorkspaceFolder = useCallback(async () => {
    let chosen: string | null = null;
    try {
      chosen = await pickFolderDialog(undefined, "选择要在侧栏打开的文件夹");
    } catch (err) {
      showToast(`无法打开文件夹：${err instanceof Error ? err.message : String(err)}`, 3600);
      return;
    }
    if (!chosen) return;
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const name = chosen.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || chosen;
    setWorkspaceFolders((prev) => {
      if (prev.some((f) => norm(f.path) === norm(chosen as string))) {
        showToast(`「${name}」已在侧栏中`);
        return prev;
      }
      const next = [...prev, { path: chosen as string, name }];
      persistWorkspaceFolders(next);
      return next;
    });
  }, [persistWorkspaceFolders, showToast]);

  const handleRemoveWorkspaceFolder = useCallback(
    (path: string) => {
      setWorkspaceFolders((prev) => {
        const next = prev.filter((f) => f.path !== path);
        persistWorkspaceFolders(next);
        return next;
      });
    },
    [persistWorkspaceFolders]
  );

  // 文件或文件夹改名后：正在编辑的文件换到新路径，最近列表同步更新
  const handleFolderEntryRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      const remap = (p: string): string | null => {
        const a = p.replace(/\\/g, "/");
        const o = oldPath.replace(/\\/g, "/");
        if (a.toLowerCase() === o.toLowerCase()) return newPath;
        if (a.toLowerCase().startsWith(o.toLowerCase() + "/")) {
          const sep = newPath.includes("\\") ? "\\" : "/";
          return newPath + sep + a.slice(o.length + 1).split("/").join(sep);
        }
        return null;
      };
      setRecentLocalMdFiles((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          const moved = remap(item.filePath);
          if (!moved) return item;
          changed = true;
          const fileName = moved.split(/[\\/]/).pop() || item.fileName;
          return { ...item, filePath: moved, fileName };
        });
        if (changed) setSetting("recentLocalMdFiles", JSON.stringify(next)).catch(() => {});
        return changed ? next : prev;
      });
      const current = activeLocalMdRef.current;
      const movedActive = current ? remap(current.filePath) : null;
      if (movedActive) {
        openLocalMarkdownFile(movedActive)
          .then((doc) => {
            localMtimeRef.current[doc.filePath] = doc.updatedAt;
            setActiveLocalMd(doc);
          })
          .catch(() => {});
      }
    },
    []
  );

  // 文件或文件夹移到回收站后：关闭正在编辑的文件，并从最近列表移除
  const handleFolderEntryRemoved = useCallback((removedPath: string) => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const r = norm(removedPath);
    const gone = (p: string) => norm(p) === r || norm(p).startsWith(r + "/");
    setRecentLocalMdFiles((prev) => {
      const next = prev.filter((item) => !gone(item.filePath));
      if (next.length !== prev.length) setSetting("recentLocalMdFiles", JSON.stringify(next)).catch(() => {});
      return next;
    });
    const cur = activeLocalMdRef.current;
    if (cur && gone(cur.filePath)) {
      const pending = pendingLocalMdSaveRef.current;
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingLocalMdSaveRef.current = null;
      }
      setActiveLocalMd(null);
    }
  }, []);

  const handleOpenLocalMdDialog = useCallback(async () => {
    if (isTauriRuntime()) {
      const chosen = await pickMarkdownFileDialog();
      if (chosen) {
        await openFileByPath(chosen);
      }
      return;
    }
    browserMdInputRef.current?.click();
  }, [openFileByPath]);

  const handleCreateLocalMdFile = useCallback(async () => {
    const initialMd = "# 新建笔记\n\n";
    if (isTauriRuntime() && workspaceFolders.length > 0) {
      // 已经打开了文件夹：直接建在当前文件所在的文件夹（或第一个文件夹）里，在侧栏就地命名
      const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const currentPath = activeTextFile?.filePath ?? activeLocalMd?.filePath ?? null;
      const currentDir = currentPath ? currentPath.replace(/[\\/][^\\/]*$/, "") : null;
      const parent =
        currentDir && workspaceFolders.some((f) => norm(currentDir) === norm(f.path) || norm(currentDir).startsWith(norm(f.path) + "/"))
          ? currentDir
          : workspaceFolders[0].path;
      const handled = !window.dispatchEvent(
        new CustomEvent("xynote:folder-new-file", { detail: { parent }, cancelable: true })
      );
      if (!handled) {
        try {
          const entry = await createFolderEntry(parent, "未命名笔记", false);
          await openFileByPath(entry.path);
        } catch (err) {
          showToast(`新建失败：${textErrorText(err)}`, 3600);
        }
      }
      return;
    }
    if (isTauriRuntime()) {
      const savedPath = await saveMarkdownFileDialog("新建笔记.md", initialMd);
      if (savedPath) {
        await openLocalMdByPath(savedPath);
      }
      return;
    }
    await flushPendingBlockSave();
    const doc = registerBrowserLocalMarkdownFile(
      `新建笔记-${Date.now().toString().slice(-4)}.md`,
      initialMd
    );
    setActiveLocalMd(doc);
    pushRecentLocalMd(doc);
    showToast(`已新建本地 .md 文件直编：${doc.fileName}`);
  }, [flushPendingBlockSave, openLocalMdByPath, openFileByPath, pushRecentLocalMd, showToast, workspaceFolders, activeTextFile, activeLocalMd]);

  const handleBrowserMdFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      await flushPendingBlockSave();
      const text = await file.text();
      const doc = registerBrowserLocalMarkdownFile(file.name, text);
      setActiveLocalMd(doc);
      pushRecentLocalMd(doc);
      showToast(`已打开本地文件直编：${doc.fileName}`);
    },
    [flushPendingBlockSave, pushRecentLocalMd, showToast]
  );

  const handleBatchImportSuccess = useCallback(
    async (res: BatchImportResult) => {
      await refreshSidebarLists();
      if (res.firstPageId) {
        await loadPageDetailById(res.firstPageId, null);
      }
      getStorageInfo()
        .then(setStorageInfo)
        .catch(() => {});
      showToast(formatBatchImportSummary(res), 4200);
    },
    [loadPageDetailById, refreshSidebarLists, showToast]
  );

  // Tauri v2 Native Window Drag-and-Drop Subscription
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let eligibleHover = false;
    let unlistenFn: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (disposed) return;
        const payload = event.payload;

        if (payload.type === "enter") {
          const importable = filterImportableOsPaths(payload.paths);
          eligibleHover = importable.length > 0;
          setWindowDragActive(eligibleHover);
        } else if (payload.type === "over") {
          if (eligibleHover) {
            setWindowDragActive(true);
          }
        } else if (payload.type === "leave") {
          eligibleHover = false;
          setWindowDragActive(false);
        } else if (payload.type === "drop") {
          eligibleHover = false;
          setWindowDragActive(false);
          const importable = filterImportableOsPaths(payload.paths);
          if (importable.length === 0) return;

          const currentParentId =
            detailRef.current?.page.pageType === "doc"
              ? detailRef.current.page.id
              : null;

          const onlyStylePlugins =
            importable.length > 0 && importable.every(isStylePluginFilePath);

          setIsBatchImporting(true);
          showToast(
            onlyStylePlugins
              ? "正在安装拖入的主题与样式插件..."
              : "正在导入拖入的文件与目录树...",
            6000
          );
          try {
            await flushPendingBlockSave();
            const res = await importLocalPaths(importable, currentParentId);
            setMarkdownModalMode(null);
            const refreshedPlugins = await listStylePlugins().catch(() => null);
            if (refreshedPlugins) {
              setStylePluginState(refreshedPlugins);
            }
            if (onlyStylePlugins && res.importedPages === 0) {
              showToast(`已成功安装并启用 ${importable.length} 个样式插件`);
            } else {
              await handleBatchImportSuccess(res);
            }
          } catch (err) {
            showToast(
              `导入失败：${err instanceof Error ? err.message : String(err)}`,
              4000
            );
          } finally {
            setIsBatchImporting(false);
          }
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, [flushPendingBlockSave, handleBatchImportSuccess, showToast]);

  // Browser / HTML5 Window Drag-and-Drop Fallback (only external file drops)
  const isExternalFileDrag = (e: React.DragEvent): boolean => {
    if (isTauriRuntime() || markdownModalMode !== null) return false;
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes("Files")) return false;
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    if (
      items.length > 0 &&
      items.every(
        (it) => it.kind === "file" && it.type.startsWith("image/")
      )
    ) {
      return false;
    }
    return true;
  };

  const handleShellDragEnter = (e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setWindowDragActive(true);
  };

  const handleShellDragOver = (e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!windowDragActive) setWindowDragActive(true);
  };

  const handleShellDragLeave = (e: React.DragEvent) => {
    if (isTauriRuntime() || markdownModalMode !== null) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setWindowDragActive(false);
    }
  };

  const handleShellDrop = async (e: React.DragEvent) => {
    if (isTauriRuntime() || markdownModalMode !== null) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) {
      return;
    }
    dragDepthRef.current = 0;
    setWindowDragActive(false);

    if (e.defaultPrevented) return;

    const { zipFiles, treeEntries, stylePluginFiles } =
      await collectFilesFromDataTransfer(e.dataTransfer);
    if (
      zipFiles.length === 0 &&
      treeEntries.length === 0 &&
      stylePluginFiles.length === 0
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const currentParentId =
      detailRef.current?.page.pageType === "doc"
        ? detailRef.current.page.id
        : null;

    setIsBatchImporting(true);
    showToast("正在批量解析并导入文件...", 6000);
    try {
      await flushPendingBlockSave();

      if (stylePluginFiles.length > 0) {
        for (const spf of stylePluginFiles) {
          await importStylePluginContent(spf.filename, spf.content);
        }
        const freshPlugins = await listStylePlugins().catch(() => null);
        if (freshPlugins) {
          setStylePluginState(freshPlugins);
        }
      }

      if (zipFiles.length === 0 && treeEntries.length === 0) {
        showToast(`已安装并启用 ${stylePluginFiles.length} 个样式插件`);
        return;
      }

      const combined: BatchImportResult = {
        importedPages: 0,
        importedDatabases: 0,
        importedBlocks: 0,
        resolvedLinks: 0,
        rootPageIds: [],
        firstPageId: null,
      };

      for (const zf of zipFiles) {
        const b64 = await readFileAsBase64(zf);
        const r = await importNotionZipBytes(b64, currentParentId);
        combined.importedPages += r.importedPages;
        combined.importedDatabases += r.importedDatabases;
        combined.importedBlocks += r.importedBlocks;
        combined.resolvedLinks += r.resolvedLinks;
        combined.rootPageIds.push(...r.rootPageIds);
        if (!combined.firstPageId && r.firstPageId) {
          combined.firstPageId = r.firstPageId;
        }
      }

      if (treeEntries.length > 0) {
        const r = await importMarkdownTree(treeEntries, currentParentId);
        combined.importedPages += r.importedPages;
        combined.importedDatabases += r.importedDatabases;
        combined.importedBlocks += r.importedBlocks;
        combined.resolvedLinks += r.resolvedLinks;
        combined.rootPageIds.push(...r.rootPageIds);
        if (!combined.firstPageId && r.firstPageId) {
          combined.firstPageId = r.firstPageId;
        }
      }

      await handleBatchImportSuccess(combined);
    } catch (err) {
      showToast(
        `导入失败：${err instanceof Error ? err.message : String(err)}`,
        4000
      );
    } finally {
      setIsBatchImporting(false);
    }
  };

  // Initial workspace bootstrap
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [
          settings,
          activeList,
          trashList,
          initialStorage,
          initialPlugins,
        ] = await Promise.all([
          getSettings(),
          listPages(),
          listTrashedPages(),
          getStorageInfo().catch(() => null),
          listStylePlugins().catch(() => null),
        ]);
        if (!mounted) return;

        if (initialStorage) {
          setStorageInfo(initialStorage);
        }

        if (initialPlugins) {
          setStylePluginState(initialPlugins);
          if (
            initialPlugins.activeThemeId === "light" ||
            initialPlugins.activeThemeId === "dark" ||
            initialPlugins.activeThemeId === "sepia" ||
            initialPlugins.activeThemeId === "system"
          ) {
            setThemePref(initialPlugins.activeThemeId);
          }
        }

        if (settings["keymap.overrides"]) {
          try {
            const parsedOverrides = JSON.parse(
              settings["keymap.overrides"]
            ) as KeybindingMap;
            setKeybindings(mergeKeybindings(parsedOverrides));
          } catch {
            // Keep default keybindings
          }
        }

        if (
          !initialPlugins?.activeThemeId?.startsWith("plugin:") &&
          (settings.theme === "light" ||
            settings.theme === "dark" ||
            settings.theme === "sepia" ||
            settings.theme === "system")
        ) {
          setThemePref(settings.theme);
        }
        if (
          settings.fontStyle === "sans" ||
          settings.fontStyle === "serif" ||
          settings.fontStyle === "mono"
        ) {
          setFontStyle(settings.fontStyle);
        }
        if (settings.editorFontSize) {
          const parsedFs = Number(settings.editorFontSize);
          if (parsedFs >= 14 && parsedFs <= 20) setEditorFontSize(parsedFs);
        }
        if (settings.editorLineHeight) {
          const parsedLh = Number(settings.editorLineHeight);
          if (parsedLh >= 1.5 && parsedLh <= 2.0) setEditorLineHeight(parsedLh);
        }
        if (settings["appearance.adaptiveWidth"] === "false") {
          setFullWidth(false);
        } else {
          setFullWidth(true);
        }
        if (settings.showStatusBar === "false") {
          setShowStatusBar(false);
        }
        if (settings.sidebarCollapsed === "true") {
          setSidebarCollapsed(true);
        }
        if (settings.editorPreferences) {
          try {
            const parsedPrefs = JSON.parse(
              settings.editorPreferences
            ) as Partial<EditorPreferences>;
            setEditorPrefs((prev) => ({
              ...prev,
              ...parsedPrefs,
              imageSaveMode:
                initialStorage?.imageSaveMode ??
                parsedPrefs.imageSaveMode ??
                "assets",
            }));
          } catch {
            // Keep default prefs
          }
        } else if (initialStorage?.imageSaveMode) {
          setEditorPrefs((prev) => ({
            ...prev,
            imageSaveMode: initialStorage.imageSaveMode,
          }));
        }

        if (settings.workspaceFolders) {
          try {
            const parsedFolders = JSON.parse(settings.workspaceFolders) as WorkspaceFolder[];
            if (Array.isArray(parsedFolders)) {
              setWorkspaceFolders(
                parsedFolders.filter((f) => f && typeof f.path === "string" && f.path)
              );
            }
          } catch {
            // Ignore
          }
        }

        if (settings.recentLocalMdFiles) {
          try {
            const parsedRecent = JSON.parse(
              settings.recentLocalMdFiles
            ) as RecentLocalMdItem[];
            if (Array.isArray(parsedRecent)) {
              setRecentLocalMdFiles(parsedRecent);
            }
          } catch {
            // Ignore
          }
        }

        setPages(activeList);
        setTrashedPages(trashList);

        const remembered = settings.lastActivePageId;
        // 新窗口通过 ?page=xxx 指定要打开的页面
        const requested = initialPageFromUrl();
        const targetPage =
          (requested ? activeList.find((p) => p.id === requested) ?? (await getPageDetail(requested).then((d) => d.page).catch(() => null)) : null) ??
          activeList.find((p) => p.id === remembered) ??
          activeList[0] ??
          null;

        if (targetPage) {
          const initialDetail = await getPageDetail(targetPage.id);
          if (mounted) {
            setActivePageId(targetPage.id);
            setDetail(initialDetail);
          }
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const handleUpdateEditorPrefs = useCallback(
    (patch: Partial<EditorPreferences>) => {
      setEditorPrefs((prev) => {
        const next = { ...prev, ...patch };
        setSetting("editorPreferences", JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    []
  );

  const handleRefreshStylePlugins =
    useCallback(async (): Promise<StylePluginState | null> => {
      try {
        const loaded = await listStylePlugins();
        setStylePluginState(loaded);
        return loaded;
      } catch {
        return null;
      }
    }, []);

  useEffect(() => {
    const onPluginsChanged = () => {
      handleRefreshStylePlugins().catch(() => {});
    };
    window.addEventListener("notion-style-plugins-changed", onPluginsChanged);
    return () =>
      window.removeEventListener(
        "notion-style-plugins-changed",
        onPluginsChanged
      );
  }, [handleRefreshStylePlugins]);

  const handleChangeKeybindings = useCallback((nextMerged: KeybindingMap) => {
    const merged = mergeKeybindings(nextMerged);
    setKeybindings(merged);
    const overrides = extractKeybindingOverrides(merged);
    setSetting("keymap.overrides", JSON.stringify(overrides)).catch(() => {});
  }, []);

  const handleChangeThemePref = useCallback((next: ThemePreference) => {
    setThemePref(next);
    setSetting("theme", next).catch(() => {});
    toggleStylePlugin(next, true)
      .then((updatedState) => {
        setStylePluginState(updatedState);
      })
      .catch(() => {
        setStylePluginState((prev) =>
          prev
            ? {
                ...prev,
                activeThemeId: next,
                plugins: prev.plugins.map((p) =>
                  p.kind === "theme" ? { ...p, enabled: false } : p
                ),
              }
            : prev
        );
      });
  }, []);

  const handleChangeThemeFromTopbar = useCallback(
    (next: ThemeMode) => {
      handleChangeThemePref(next);
    },
    [handleChangeThemePref]
  );

  const handleChangeFontStyle = useCallback((next: FontStyleMode) => {
    setFontStyle(next);
    setSetting("fontStyle", next).catch(() => {});
  }, []);

  const handleChangeFontSize = useCallback((next: number) => {
    const clamped = Math.min(20, Math.max(14, Math.round(next)));
    setEditorFontSize(clamped);
    setSetting("editorFontSize", String(clamped)).catch(() => {});
  }, []);

  const handleChangeLineHeight = useCallback((next: number) => {
    const clamped = Math.min(2.0, Math.max(1.5, Number(next.toFixed(2))));
    setEditorLineHeight(clamped);
    setSetting("editorLineHeight", String(clamped)).catch(() => {});
  }, []);

  const handleSetAdaptiveWidth = useCallback((next: boolean) => {
    setFullWidth(next);
    setSetting("appearance.adaptiveWidth", String(next)).catch(() => {});
  }, []);

  const handleToggleFullWidth = useCallback(() => {
    setFullWidth((prev) => {
      const next = !prev;
      setSetting("appearance.adaptiveWidth", String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleToggleShowStatusBar = useCallback(() => {
    setShowStatusBar((prev) => {
      const next = !prev;
      setSetting("showStatusBar", String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      setSetting("sidebarCollapsed", String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleToggleZenMode = useCallback(() => {
    setZenMode((prev) => {
      if (!prev) {
        preZenSidebarRef.current = sidebarCollapsed;
        setSidebarCollapsed(true);
        showToast("已进入禅模式沉浸写作");
        return true;
      }
      setSidebarCollapsed(preZenSidebarRef.current);
      showToast("已退出禅模式");
      return false;
    });
  }, [sidebarCollapsed, showToast]);

  const handleCreatePage = useCallback(
    async (input: CreatePageInput) => {
      await flushPendingBlockSave();
      const created = await createPage(input);
      await refreshSidebarLists();
      await loadPageDetailById(created.id, null);
      focusTokenRef.current += 1;
      setFocusTitleRequest({
        pageId: created.id,
        token: focusTokenRef.current,
      });
      getStorageInfo()
        .then(setStorageInfo)
        .catch(() => {});
      return created;
    },
    [flushPendingBlockSave, loadPageDetailById, refreshSidebarLists]
  );

  const handleConsumeFocusTitle = useCallback(() => {
    setFocusTitleRequest(null);
  }, []);

  const handleSaveImmediate = useCallback(async () => {
    await flushPendingBlockSave();
    const curLocal = activeLocalMdRef.current;
    if (curLocal) {
      setIsSaving(true);
      try {
        const items: SaveBlockItem[] = curLocal.blocks.map((b, idx) => ({
          id: b.id,
          blockType: b.blockType,
          content: b.content,
          plainText: b.plainText,
          props: b.props,
          sortOrder: idx,
        }));
        const saved = await saveLocalChecked(curLocal.filePath, items, null);
        if (saved) {
          setActiveLocalMd(saved);
          showToast(`已保存至磁盘：${saved.fileName}`);
        }
      } finally {
        setIsSaving(false);
      }
      return;
    }

    const curDetail = detailRef.current;
    if (curDetail && curDetail.page.pageType === "doc") {
      setIsSaving(true);
      try {
        const items: SaveBlockItem[] = curDetail.blocks.map((b, idx) => ({
          id: b.id,
          blockType: b.blockType,
          content: b.content,
          plainText: b.plainText,
          props: b.props,
          sortOrder: idx,
        }));
        await savePageBlocks(curDetail.page.id, items);
        showToast("文档已立即保存至本地数据库");
      } finally {
        setIsSaving(false);
      }
    }
  }, [flushPendingBlockSave, showToast]);

  const handleSaveAsMarkdown = useCallback(async () => {
    await flushPendingBlockSave();
    const curLocal = activeLocalMdRef.current;
    if (curLocal) {
      const items: SaveBlockItem[] = curLocal.blocks.map((b, idx) => ({
        id: b.id,
        blockType: b.blockType,
        content: b.content,
        plainText: b.plainText,
        props: b.props,
        sortOrder: idx,
      }));
      const converted = await convertMarkdownBlocks({ blocks: items });
      const savedPath = await saveMarkdownFileDialog(
        curLocal.fileName,
        converted.markdown
      );
      if (savedPath) {
        const opened = await openLocalMarkdownFile(savedPath);
        rememberLocalMtime(opened);
        setActiveLocalMd(opened);
        pushRecentLocalMd(opened);
        showToast(`已另存为：${opened.fileName}`);
      }
      return;
    }

    const curDetail = detailRef.current;
    if (curDetail) {
      const exported = await exportPageMarkdown(curDetail.page.id);
      const savedPath = await saveMarkdownFileDialog(
        exported.filename,
        exported.markdown
      );
      if (savedPath) {
        showToast(`已另存为本地 Markdown：${savedPath}`);
      }
    }
  }, [flushPendingBlockSave, pushRecentLocalMd, showToast]);

  const handleImportActiveLocalMdToWorkspace = useCallback(async () => {
    const curLocal = activeLocalMdRef.current;
    if (!curLocal) return;
    await flushPendingBlockSave();
    const items: SaveBlockItem[] = curLocal.blocks.map((b, idx) => ({
      id: b.id,
      blockType: b.blockType,
      content: b.content,
      plainText: b.plainText,
      props: b.props,
      sortOrder: idx,
    }));
    const converted = await convertMarkdownBlocks({ blocks: items });
    const createdPage = await importMarkdownPage(
      curLocal.title,
      converted.markdown,
      null
    );
    await refreshSidebarLists();
    await loadPageDetailById(createdPage.id, null);
    getStorageInfo()
      .then(setStorageInfo)
      .catch(() => {});
    showToast(`已将「${createdPage.title}」收入 SQLite 工作区知识库`);
  }, [flushPendingBlockSave, loadPageDetailById, refreshSidebarLists, showToast]);

  const handleOpenSettingsAtTab = useCallback((tab: SettingsTabId = "storage") => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  // Global Configurable Keyboard Shortcuts (driven by keybindingsRef)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const combo = normalizeKeyboardEventToShortcut(e);
      if (!combo) return;

      const kb = keybindingsRef.current;

      if (combo === kb["editor.focusMode"]) {
        e.preventDefault();
        const next = !editorPrefsRef.current.focusMode;
        handleUpdateEditorPrefs({ focusMode: next });
        showToast(next ? `已开启专注模式 (${combo})` : "已关闭专注模式");
        return;
      }

      if (combo === kb["editor.typewriterMode"]) {
        e.preventDefault();
        const next = !editorPrefsRef.current.typewriterMode;
        handleUpdateEditorPrefs({ typewriterMode: next });
        showToast(next ? `已开启打字机居中模式 (${combo})` : "已关闭打字机模式");
        return;
      }

      if (combo === kb["app.settings"]) {
        e.preventDefault();
        setSettingsInitialTab("storage");
        setSettingsOpen((v) => !v);
        return;
      }

      if (combo === kb["app.search"]) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }

      if (combo === kb["app.toggleSidebar"]) {
        e.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (combo === kb["app.newWindow"]) {
        e.preventDefault();
        openNewWindow(null).catch((err) => showToast(`无法打开新窗口：${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      if (combo === kb["app.newPage"]) {
        e.preventDefault();
        handleCreatePage({ pageType: "doc", icon: "📄", title: "无标题" }).catch(
          () => {}
        );
        return;
      }

      if (combo === kb["app.openMd"]) {
        e.preventDefault();
        handleOpenLocalMdDialog().catch(() => {});
        return;
      }

      if (combo === kb["editor.toggleOutline"]) {
        e.preventDefault();
        const next = !editorPrefsRef.current.showOutline;
        handleUpdateEditorPrefs({ showOutline: next });
        return;
      }

      if (combo === kb["app.saveMd"]) {
        e.preventDefault();
        handleSaveImmediate().catch(() => {});
        return;
      }

      if (combo === kb["app.saveAsMd"]) {
        e.preventDefault();
        handleSaveAsMarkdown().catch(() => {});
        return;
      }

      if (combo === kb["editor.toggleSource"]) {
        e.preventDefault();
        const cur = editorPrefsRef.current.viewMode ?? "wysiwyg";
        const nextMode: EditorViewMode =
          cur === "wysiwyg" ? "source" : "wysiwyg";
        handleUpdateEditorPrefs({ viewMode: nextMode });
        return;
      }

      if (combo === kb["editor.toggleSplit"]) {
        e.preventDefault();
        const cur = editorPrefsRef.current.viewMode ?? "wysiwyg";
        const nextMode: EditorViewMode =
          cur === "split" ? "wysiwyg" : "split";
        handleUpdateEditorPrefs({ viewMode: nextMode });
        return;
      }

      if (combo === kb["editor.zenMode"]) {
        e.preventDefault();
        handleToggleZenMode();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    handleCreatePage,
    handleOpenLocalMdDialog,
    handleSaveAsMarkdown,
    handleSaveImmediate,
    handleToggleSidebar,
    handleToggleZenMode,
    handleUpdateEditorPrefs,
    showToast,
  ]);

  const handleStorageUpdated = useCallback(
    async (info: StorageConfigInfo, shouldReloadWorkspace = false) => {
      setStorageInfo(info);
      setEditorPrefs((prev) => ({
        ...prev,
        imageSaveMode: info.imageSaveMode,
      }));
      listStylePlugins()
        .then(setStylePluginState)
        .catch(() => {});
      if (shouldReloadWorkspace) {
        // Cancel any stale pre-restore pending block timer so it cannot overwrite restored DB
        if (pendingSaveRef.current) {
          window.clearTimeout(pendingSaveRef.current.timer);
          pendingSaveRef.current = null;
        }
        const { activeList } = await refreshSidebarLists();
        setActiveLocalMd(null);
        const keepId =
          activePageId && activeList.some((p) => p.id === activePageId)
            ? activePageId
            : activeList[0]?.id ?? null;
        if (keepId) {
          const freshDetail = await getPageDetail(keepId);
          setActivePageId(keepId);
          setDetail(freshDetail);
        } else {
          setActivePageId(null);
          setDetail(null);
        }
      }
    },
    [activePageId, refreshSidebarLists]
  );

  const handleUpdateActivePage = useCallback(
    async (patch: UpdatePagePatch) => {
      if (!detail) return;
      const targetId = detail.page.id;
      setIsSaving(true);
      try {
        const updated = await updatePage(targetId, patch);
        setPages((prev) => prev.map((p) => (p.id === targetId ? updated : p)));
        setDetail((prev) => {
          if (!prev || prev.page.id !== targetId) return prev;
          const updatedCrumbs = prev.breadcrumbs.map((c) =>
            c.id === targetId
              ? { ...c, title: updated.title, icon: updated.icon }
              : c
          );
          return {
            ...prev,
            page: updated,
            breadcrumbs: updatedCrumbs,
          };
        });
      } finally {
        setIsSaving(false);
      }
    },
    [detail]
  );

  const handleToggleFavoriteForPage = useCallback(
    async (target: Page) => {
      const updated = await updatePage(target.id, {
        isFavorite: !target.isFavorite,
      });
      setPages((prev) => prev.map((p) => (p.id === target.id ? updated : p)));
      setDetail((prev) =>
        prev && prev.page.id === target.id ? { ...prev, page: updated } : prev
      );
      showToast(updated.isFavorite ? "已加入收藏夹" : "已取消收藏");
    },
    [showToast]
  );

  const handleBlocksChange = useCallback(
    (nextBlocks: Block[]) => {
      if (!detail) return;
      const pageId = detail.page.id;

      setDetail((prev) =>
        prev && prev.page.id === pageId ? { ...prev, blocks: nextBlocks } : prev
      );

      const saveItems: SaveBlockItem[] = nextBlocks.map((b, idx) => ({
        id: b.id,
        blockType: b.blockType,
        content: b.content,
        plainText: b.plainText,
        props: b.props,
        sortOrder: idx,
      }));

      if (pendingSaveRef.current && pendingSaveRef.current.pageId === pageId) {
        window.clearTimeout(pendingSaveRef.current.timer);
      }

      setIsSaving(true);
      const timer = window.setTimeout(async () => {
        pendingSaveRef.current = null;
        try {
          await savePageBlocks(pageId, saveItems);
        } finally {
          setIsSaving(false);
        }
      }, 300);

      pendingSaveRef.current = {
        timer,
        pageId,
        items: saveItems,
      };
    },
    [detail]
  );

  const handleLocalMdBlocksChange = useCallback((nextBlocks: Block[]) => {
    const cur = activeLocalMdRef.current;
    if (!cur) return;
    const filePath = cur.filePath;

    setActiveLocalMd((prev) =>
      prev && prev.filePath === filePath
        ? { ...prev, blocks: nextBlocks }
        : prev
    );

    const saveItems: SaveBlockItem[] = nextBlocks.map((b, idx) => ({
      id: b.id,
      blockType: b.blockType,
      content: b.content,
      plainText: b.plainText,
      props: b.props,
      sortOrder: idx,
    }));

    if (
      pendingLocalMdSaveRef.current &&
      pendingLocalMdSaveRef.current.filePath === filePath
    ) {
      window.clearTimeout(pendingLocalMdSaveRef.current.timer);
    }

    setIsSaving(true);
    const timer = window.setTimeout(async () => {
      pendingLocalMdSaveRef.current = null;
      try {
        const saved = await saveLocalChecked(filePath, saveItems, null);
        if (saved) setActiveLocalMd((prev) =>
          prev && prev.filePath === filePath
            ? {
                ...prev,
                title: saved.title,
                markdown: saved.markdown,
                updatedAt: saved.updatedAt,
              }
            : prev
        );
      } finally {
        setIsSaving(false);
      }
    }, 300);

    pendingLocalMdSaveRef.current = {
      timer,
      filePath,
      items: saveItems,
      rawMarkdown: null,
    };
  }, []);

  const handleLocalMdRawChange = useCallback(
    (rawMarkdown: string, parsedBlocks: Block[]) => {
      const cur = activeLocalMdRef.current;
      if (!cur) return;
      const filePath = cur.filePath;

      setActiveLocalMd((prev) =>
        prev && prev.filePath === filePath
          ? { ...prev, markdown: rawMarkdown, blocks: parsedBlocks }
          : prev
      );

      if (
        pendingLocalMdSaveRef.current &&
        pendingLocalMdSaveRef.current.filePath === filePath
      ) {
        window.clearTimeout(pendingLocalMdSaveRef.current.timer);
      }

      setIsSaving(true);
      const timer = window.setTimeout(async () => {
        pendingLocalMdSaveRef.current = null;
        try {
          const saved = await saveLocalChecked(filePath, null, rawMarkdown);
          if (saved) setActiveLocalMd((prev) =>
            prev && prev.filePath === filePath
              ? {
                  ...prev,
                  title: saved.title,
                  markdown: saved.markdown,
                  updatedAt: saved.updatedAt,
                }
              : prev
          );
        } finally {
          setIsSaving(false);
        }
      }, 300);

      pendingLocalMdSaveRef.current = {
        timer,
        filePath,
        items: null,
        rawMarkdown,
      };
    },
    []
  );

  const handleTrashPage = useCallback(
    async (pageId: string) => {
      await flushPendingBlockSave();
      await trashPage(pageId);
      const { activeList } = await refreshSidebarLists();
      getStorageInfo()
        .then(setStorageInfo)
        .catch(() => {});
      showToast("已移至回收站");

      if (
        activePageId === pageId ||
        !activeList.some((p) => p.id === activePageId)
      ) {
        if (activeList.length > 0) {
          await loadPageDetailById(activeList[0].id, null);
        } else {
          setActivePageId(null);
          setDetail(null);
        }
      } else if (activePageId) {
        const refreshed = await getPageDetail(activePageId);
        setDetail(refreshed);
      }
    },
    [
      activePageId,
      flushPendingBlockSave,
      loadPageDetailById,
      refreshSidebarLists,
      showToast,
    ]
  );

  const handleRestorePage = useCallback(
    async (pageId: string) => {
      const restored = await restorePage(pageId);
      await refreshSidebarLists();
      await loadPageDetailById(restored.id, null);
      getStorageInfo()
        .then(setStorageInfo)
        .catch(() => {});
      showToast("页面已还原");
    },
    [loadPageDetailById, refreshSidebarLists, showToast]
  );

  const handleDeletePermanent = useCallback(
    async (pageId: string) => {
      await deletePagePermanently(pageId);
      await refreshSidebarLists();
      showToast("页面已彻底删除");
    },
    [refreshSidebarLists, showToast]
  );

  const handleEmptyTrash = useCallback(async () => {
    await emptyTrash();
    await refreshSidebarLists();
    showToast("回收站已清空");
  }, [refreshSidebarLists, showToast]);

  const handleDuplicatePage = useCallback(
    async (pageId: string) => {
      await flushPendingBlockSave();
      const copy = await duplicatePage(pageId);
      await refreshSidebarLists();
      await loadPageDetailById(copy.id, null);
      showToast("已创建页面副本");
    },
    [flushPendingBlockSave, loadPageDetailById, refreshSidebarLists, showToast]
  );

  const handleExportMarkdown = useCallback(
    async (pageId: string) => {
      await flushPendingBlockSave();
      const exported = await exportPageMarkdown(pageId);
      setExportPayload(exported);
      setMarkdownModalMode("export");
    },
    [flushPendingBlockSave]
  );

  /** 导出：HTML / Word 存文件，PDF 走系统打印（选择「另存为 PDF」） */
  const handleExportAs = useCallback(
    async (pageId: string, format: ExportFormat) => {
      await flushPendingBlockSave();
      try {
        if (format === "pdf") {
          const { filename, html } = await exportPageHtml(pageId);
          await printHtmlDocument(html, filename);
          return;
        }
        if (format === "png") {
          showToast("正在生成图片…");
          const { filename, html } = await exportPageHtml(pageId);
          const parts = await renderHtmlToPngParts(html);
          const saved = await saveExportImages(filename, parts);
          if (saved) showToast(parts.length > 1 ? `已导出 ${parts.length} 张图片：${saved}` : `已导出：${saved}`);
          return;
        }
        const saved = await exportPageFile(pageId, format);
        if (saved) showToast(`已导出：${saved}`);
      } catch (err) {
        showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [flushPendingBlockSave, showToast]
  );

  const handleImportMarkdownSubmit = useCallback(
    async (title: string, markdown: string, parentId: string | null) => {
      const imported = await importMarkdownPage(title, markdown, parentId);
      await refreshSidebarLists();
      await loadPageDetailById(imported.id, null);
      getStorageInfo()
        .then(setStorageInfo)
        .catch(() => {});
      showToast("Markdown 导入成功");
    },
    [loadPageDetailById, refreshSidebarLists, showToast]
  );

  // Subpage creation callback for BlockEditor `/page` command
  const handleEditorCreateSubpage = useCallback(
    async (subTitle: string): Promise<Page> => {
      const parentId = detail?.page.id ?? null;
      const created = await createPage({
        parentId,
        title: subTitle.trim() || "无标题子页面",
        icon: "📄",
        pageType: "doc",
      });
      await refreshSidebarLists();
      if (parentId && activePageId === parentId) {
        const refreshed = await getPageDetail(parentId);
        setDetail((prev) =>
          prev && prev.page.id === parentId
            ? { ...prev, children: refreshed.children }
            : prev
        );
      }
      return created;
    },
    [activePageId, detail?.page.id, refreshSidebarLists]
  );

  // Linked page creation callback for DatabaseView row "Open Page"
  const handleCreateDatabaseLinkedPage = useCallback(
    async (rowTitle: string, parentId: string): Promise<Page> => {
      const created = await createPage({
        parentId,
        title: rowTitle.trim() || "无标题记录",
        icon: "📄",
        pageType: "doc",
      });
      await refreshSidebarLists();
      return created;
    },
    [refreshSidebarLists]
  );

  const cycleViewMode = useCallback(() => {
    const cur = editorPrefsRef.current.viewMode ?? "wysiwyg";
    const next: EditorViewMode =
      cur === "wysiwyg" ? "source" : cur === "source" ? "split" : "wysiwyg";
    handleUpdateEditorPrefs({ viewMode: next });
  }, [handleUpdateEditorPrefs]);

  const fontClass =
    fontStyle === "serif"
      ? "nb-font-serif"
      : fontStyle === "mono"
      ? "nb-font-mono"
      : "nb-font-sans";

  const activeViewMode = editorPrefs.viewMode ?? "wysiwyg";
  const isSourceOrSplit =
    activeViewMode === "source" || activeViewMode === "split";
  const effectiveAdaptiveWidth = fullWidth || isSourceOrSplit;
  const containerModeClass =
    !activeLocalMd && detail?.page.pageType === "database"
      ? "is-database"
      : effectiveAdaptiveWidth
      ? "is-full-width"
      : "is-reading-centered";

  return (
    <div
      className={`nb-app-shell${zenMode ? " is-zen-mode" : ""}`}
      onDragEnter={handleShellDragEnter}
      onDragOver={handleShellDragOver}
      onDragLeave={handleShellDragLeave}
      onDrop={handleShellDrop}
    >
      {/* Hidden Browser Fallback File Picker for Ctrl+O Direct .md Editing */}
      <input
        ref={browserMdInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        style={{ display: "none" }}
        onChange={handleBrowserMdFilePicked}
      />

      <Sidebar
        pages={pages}
        activePageId={activePageId}
        activeLocalMdPath={activeTextFile?.filePath ?? activeLocalMd?.filePath ?? null}
        recentLocalMdFiles={recentLocalMdFiles}
        collapsed={sidebarCollapsed}
        trashedCount={trashedPages.length}
        isTauri={isTauriRuntime()}
        onToggleCollapse={handleToggleSidebar}
        onSelectPage={(id) => {
          loadPageDetailById(id, null).catch(() => {});
        }}
        onOpenLocalMdDialog={() => {
          handleOpenLocalMdDialog().catch(() => {});
        }}
        onCreateLocalMdFile={() => {
          handleCreateLocalMdFile().catch(() => {});
        }}
        onSelectLocalMdFile={(fp) => {
          openFileByPath(fp).catch(() => {});
        }}
        onRemoveRecentLocalMdFile={handleRemoveRecentLocalMd}
        onCreateDoc={(parentId) => {
          handleCreatePage({
            parentId: parentId ?? null,
            pageType: "doc",
            icon: "📄",
            title: "无标题",
          }).catch(() => {});
        }}
        onCreateDatabase={(parentId) => {
          handleCreatePage({
            parentId: parentId ?? null,
            pageType: "database",
            icon: "🗃️",
            title: "无标题数据库",
          }).catch(() => {});
        }}
        onDuplicatePage={(id) => {
          handleDuplicatePage(id).catch(() => {});
        }}
        onToggleFavorite={(pg) => {
          handleToggleFavoriteForPage(pg).catch(() => {});
        }}
        onTrashPage={(id) => {
          handleTrashPage(id).catch(() => {});
        }}
        onExportMarkdown={(id) => {
          handleExportMarkdown(id).catch(() => {});
        }}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenTemplates={() => setTemplatesOpen(true)}
        onOpenTrash={() => setTrashOpen(true)}
        onOpenImportMarkdown={() => setMarkdownModalMode("import")}
        onOpenSettings={() => handleOpenSettingsAtTab("storage")}
        workspaceFolders={workspaceFolders}
        onAddWorkspaceFolder={() => {
          handleAddWorkspaceFolder().catch(() => {});
        }}
        onRemoveWorkspaceFolder={handleRemoveWorkspaceFolder}
        onFolderEntryRenamed={handleFolderEntryRenamed}
        onBeforeFolderRename={flushPendingBlockSave}
        onFolderEntryRemoved={handleFolderEntryRemoved}
        notify={showToast}
      />

      <main className="nb-main-area">
        <Topbar
          page={detail?.page ?? null}
          activeLocalMd={activeLocalMd}
          textFile={activeTextFile}
          breadcrumbs={detail?.breadcrumbs ?? []}
          sidebarCollapsed={sidebarCollapsed}
          isSaving={isSaving || isBatchImporting}
          theme={effectiveTheme}
          fontStyle={fontStyle}
          fullWidth={fullWidth}
          viewMode={editorPrefs.viewMode ?? "wysiwyg"}
          focusMode={Boolean(editorPrefs.focusMode)}
          typewriterMode={Boolean(editorPrefs.typewriterMode)}
          showOutline={Boolean(editorPrefs.showOutline)}
          zenMode={zenMode}
          onToggleSidebar={handleToggleSidebar}
          onNavigatePage={(id) => {
            loadPageDetailById(id, null).catch(() => {});
          }}
          onToggleFavorite={() => {
            if (detail?.page) {
              handleToggleFavoriteForPage(detail.page).catch(() => {});
            }
          }}
          onChangeTheme={handleChangeThemeFromTopbar}
          onChangeFontStyle={handleChangeFontStyle}
          onToggleFullWidth={handleToggleFullWidth}
          onSetFullWidth={handleSetAdaptiveWidth}
          onChangeViewMode={(mode) => handleUpdateEditorPrefs({ viewMode: mode })}
          onToggleFocusMode={() =>
            handleUpdateEditorPrefs({ focusMode: !editorPrefs.focusMode })
          }
          onToggleTypewriterMode={() =>
            handleUpdateEditorPrefs({
              typewriterMode: !editorPrefs.typewriterMode,
            })
          }
          onToggleOutline={() =>
            handleUpdateEditorPrefs({ showOutline: !editorPrefs.showOutline })
          }
          onToggleZenMode={handleToggleZenMode}
          onOpenSettings={() => handleOpenSettingsAtTab("storage")}
          onOpenLocalMdDialog={() => {
            handleOpenLocalMdDialog().catch(() => {});
          }}
          onSaveImmediate={() => {
            handleSaveImmediate().catch(() => {});
          }}
          onSaveAsMarkdown={() => {
            handleSaveAsMarkdown().catch(() => {});
          }}
          onImportLocalMdToWorkspace={() => {
            handleImportActiveLocalMdToWorkspace().catch(() => {});
          }}
          onDuplicatePage={() => {
            if (detail?.page) {
              handleDuplicatePage(detail.page.id).catch(() => {});
            }
          }}
          onExportMarkdown={() => {
            if (detail?.page) {
              handleExportMarkdown(detail.page.id).catch(() => {});
            }
          }}
          onExportAs={(fmt) => {
            if (detail?.page) {
              handleExportAs(detail.page.id, fmt).catch(() => {});
            }
          }}
          onOpenInNewWindow={() => {
            if (!detail) return;
            void flushPendingBlockSave().then(() =>
              openNewWindow(detail.page.id).catch((err) => showToast(`无法打开新窗口：${err instanceof Error ? err.message : String(err)}`))
            );
          }}
          onSaveAsTemplate={async () => {
            if (!detail) return;
            await flushPendingBlockSave();
            try {
              const t = await savePageAsTemplate(detail.page.id);
              setTemplateFocusId(t.id);
              setTemplatesOpen(true);
              showToast(`已把「${t.title}」存为模板`);
            } catch (err) {
              showToast(`存为模板失败：${err instanceof Error ? err.message : String(err)}`, 3600);
            }
          }}
          onOpenHistory={async () => {
            await flushPendingBlockSave();
            setHistoryOpen(true);
          }}
          onOpenImportMarkdown={() => setMarkdownModalMode("import")}
          onTrashPage={() => {
            if (detail?.page) {
              handleTrashPage(detail.page.id).catch(() => {});
            }
          }}
          onOpenSearch={() => setSearchOpen(true)}
        />

        <div className="nb-page-scroll">
          {isLoading ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-tertiary)",
              }}
            >
              正在加载本地工作区...
            </div>
          ) : activeTextFile ? (
            <TextEditor
              key={activeTextFile.filePath}
              doc={activeTextFile}
              keybindings={keybindings}
              onNotify={showToast}
              onSavingChange={setIsSaving}
              onRevealInExplorer={(p) => {
                openPathInExplorer(p).catch(() => {});
              }}
            />
          ) : activeLocalMd ? (
            <div
              className={`nb-page-container page-content-column page-editor-container ${containerModeClass} ${fontClass}`.trim()}
              style={{ paddingTop: "36px" }}
            >
              <div style={{ marginBottom: "18px" }}>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                    marginBottom: "6px",
                  }}
                >
                  {activeLocalMd.filePath}
                </div>
                {/* 正文第一块已经是一级标题时不再重复显示标题，否则用文件名作标题 */}
                {activeLocalMd.blocks.find((blk) => blk.blockType !== "divider")?.blockType !== "heading1" && (
                  <h1
                    style={{
                      margin: 0,
                      fontSize: "32px",
                      fontWeight: 700,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    {activeLocalMd.fileName.replace(/\.(md|markdown|mdown|mkd|txt)$/i, "") || activeLocalMd.title}
                  </h1>
                )}
              </div>

              <EnhancedBlockEditor
                pageId={`local:${activeLocalMd.filePath}`}
                blocks={activeLocalMd.blocks}
                pages={pages}
                fullWidth={effectiveAdaptiveWidth}
                fontStyle={fontStyle}
                highlightBlockId={null}
                preferences={effectiveEditorPrefs}
                rawMarkdownOverride={activeLocalMd.markdown}
                onViewModeChange={(mode) =>
                  handleUpdateEditorPrefs({ viewMode: mode })
                }
                onRawMarkdownChange={handleLocalMdRawChange}
                onStatsChange={setDocStats}
                onBlocksChange={handleLocalMdBlocksChange}
                onNavigatePage={(id: string) => {
                  loadPageDetailById(id, null).catch(() => {});
                }}
              />
            </div>
          ) : detail ? (
            <>
              <PageHeader
                page={detail.page}
                fontClass={fontClass}
                containerModeClass={containerModeClass}
                focusTitleRequest={focusTitleRequest}
                onConsumeFocusTitle={handleConsumeFocusTitle}
                onUpdatePage={(patch) => {
                  handleUpdateActivePage(patch).catch(() => {});
                }}
                onCreateSubpage={() => {
                  handleCreatePage({
                    parentId: detail.page.id,
                    pageType: "doc",
                    icon: "📄",
                    title: "无标题",
                  }).catch(() => {});
                }}
              />

              <div
                className={`nb-page-container page-content-column page-editor-container ${containerModeClass} ${fontClass}`.trim()}
              >
                {detail.page.pageType === "database" ? (
                  <DatabaseView
                    pageId={detail.page.id}
                    pages={pages}
                    onOpenPage={(id: string) => {
                      loadPageDetailById(id, null).catch(() => {});
                    }}
                    onCreateLinkedPage={handleCreateDatabaseLinkedPage}
                  />
                ) : (
                  <EnhancedBlockEditor
                    pageId={detail.page.id}
                    blocks={detail.blocks}
                    pages={pages}
                    fullWidth={effectiveAdaptiveWidth}
                    fontStyle={fontStyle}
                    highlightBlockId={highlightBlockId}
                    preferences={effectiveEditorPrefs}
                    onViewModeChange={(mode) =>
                      handleUpdateEditorPrefs({ viewMode: mode })
                    }
                    onStatsChange={setDocStats}
                    onBlocksChange={handleBlocksChange}
                    onNavigatePage={(id: string) => {
                      loadPageDetailById(id, null).catch(() => {});
                    }}
                    onCreateSubpage={handleEditorCreateSubpage}
                  />
                )}

                <PageFooterExtras
                  subpages={detail.children}
                  backlinks={detail.backlinks}
                  onNavigatePage={(id) => {
                    loadPageDetailById(id, null).catch(() => {});
                  }}
                  onCreateSubpage={() => {
                    handleCreatePage({
                      parentId: detail.page.id,
                      pageType: "doc",
                      icon: "📄",
                      title: "无标题",
                    }).catch(() => {});
                  }}
                />
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "14px",
                padding: "32px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "40px" }}>📓</div>
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
                当前工作区暂无打开的页面
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-secondary)",
                  maxWidth: "440px",
                }}
              >
                创建一篇新的块级笔记、按 Ctrl+O 直接打开本地 .md 文件直编，或拖入 Markdown 文件夹 / Notion 导出 .zip 包构建知识库。
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: "10px",
                  marginTop: "6px",
                }}
              >
                <button
                  type="button"
                  className="nb-btn-primary"
                  onClick={() => {
                    handleCreatePage({
                      pageType: "doc",
                      icon: "📄",
                      title: "欢迎回来",
                    }).catch(() => {});
                  }}
                >
                  <FilePlus2 size={15} /> 新建空白页面
                </button>
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={() => {
                    handleOpenLocalMdDialog().catch(() => {});
                  }}
                >
                  <FolderOpen size={15} /> 打开本地 .md (Ctrl+O)
                </button>
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={() => setMarkdownModalMode("notion-zip")}
                >
                  <Archive size={15} /> 导入 / Notion 迁移
                </button>
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={() => setTemplatesOpen(true)}
                >
                  <Sparkles size={15} /> 浏览模板中心
                </button>
                {trashedPages.length > 0 && (
                  <button
                    type="button"
                    className="nb-btn-secondary"
                    onClick={() => setTrashOpen(true)}
                  >
                    <Trash2 size={15} /> 打开回收站 ({trashedPages.length})
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {showStatusBar && !activeTextFile && (
          <StatusBar
            storageInfo={storageInfo}
            activeLocalMd={activeLocalMd}
            isDatabasePage={
              !activeLocalMd && detail?.page.pageType === "database"
            }
            isSaving={isSaving || isBatchImporting}
            stats={docStats}
            editorPrefs={editorPrefs}
            onOpenStorageSettings={() => handleOpenSettingsAtTab("storage")}
            sync={
              syncConfig
                ? {
                    mode: syncConfig.mode,
                    syncing,
                    lastAt: syncConfig.lastAt,
                    lastError: syncConfig.lastError,
                  }
                : null
            }
            onOpenSyncSettings={() => handleOpenSettingsAtTab("sync")}
            onRevealActiveLocalMd={(fp) => {
              if (isTauriRuntime()) {
                openPathInExplorer(fp).catch(() => {});
              } else {
                handleOpenSettingsAtTab("storage");
              }
            }}
            onToggleFocusMode={() =>
              handleUpdateEditorPrefs({ focusMode: !editorPrefs.focusMode })
            }
            onToggleTypewriterMode={() =>
              handleUpdateEditorPrefs({
                typewriterMode: !editorPrefs.typewriterMode,
              })
            }
            onToggleOutline={() =>
              handleUpdateEditorPrefs({ showOutline: !editorPrefs.showOutline })
            }
            onCycleViewMode={cycleViewMode}
          />
        )}
      </main>

      {/* Sleek Full-Window Drag-and-Drop Overlay */}
      {windowDragActive && (
        <div className="nb-drop-overlay">
          <div className="nb-drop-overlay-card">
            <div className="nb-drop-overlay-icon">
              <Archive size={24} />
            </div>
            <div style={{ fontSize: "17px", fontWeight: 700 }}>
              松开鼠标，批量导入至本地 Notion 工作区
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                lineHeight: 1.55,
              }}
            >
              支持单个或多个 <b>.md / .csv</b> 文件、完整 <b>Markdown 文件夹</b>（自动保留子目录结构）以及 <b>Notion 官方导出的 .zip 压缩包</b>（自动剥离哈希后缀并还原数据库与双链）
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <CommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        folderRoots={workspaceFolders.map((f) => [f.path, f.name] as [string, string])}
        onOpenFile={(fp) => {
          openLocalMdByPath(fp).catch(() => {});
        }}
        onSelectResult={(pageId, blockId) => {
          loadPageDetailById(pageId, blockId).catch(() => {});
        }}
        onCreateDoc={() => {
          handleCreatePage({
            pageType: "doc",
            icon: "📄",
            title: "无标题",
          }).catch(() => {});
        }}
        onCreateDatabase={() => {
          handleCreatePage({
            pageType: "database",
            icon: "🗃️",
            title: "无标题数据库",
          }).catch(() => {});
        }}
        onOpenTemplates={() => setTemplatesOpen(true)}
        onOpenTrash={() => setTrashOpen(true)}
        onOpenSettings={() => handleOpenSettingsAtTab("storage")}
        onOpenLocalMdDialog={() => {
          handleOpenLocalMdDialog().catch(() => {});
        }}
        onCreateLocalMdFile={() => {
          handleCreateLocalMdFile().catch(() => {});
        }}
        onToggleViewMode={() => {
          const cur = editorPrefs.viewMode ?? "wysiwyg";
          handleUpdateEditorPrefs({
            viewMode: cur === "wysiwyg" ? "source" : "wysiwyg",
          });
        }}
        onChangeTheme={handleChangeThemeFromTopbar}
      />

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsInitialTab}
        storageInfo={storageInfo}
        editorPrefs={effectiveEditorPrefs}
        keybindings={keybindings}
        styleState={stylePluginState}
        themePref={themePref}
        fontStyle={fontStyle}
        fontSize={editorFontSize}
        lineHeight={editorLineHeight}
        fullWidth={fullWidth}
        showStatusBar={showStatusBar}
        onClose={() => setSettingsOpen(false)}
        onStorageUpdated={handleStorageUpdated}
        onChangeEditorPrefs={handleUpdateEditorPrefs}
        onChangeKeybindings={handleChangeKeybindings}
        onStyleStateChange={setStylePluginState}
        onPreviewThemeOverride={setThemePreviewOverride}
        onRefreshStylePlugins={handleRefreshStylePlugins}
        onChangeThemePref={handleChangeThemePref}
        onChangeFontStyle={handleChangeFontStyle}
        onChangeFontSize={handleChangeFontSize}
        onChangeLineHeight={handleChangeLineHeight}
        onToggleFullWidth={handleToggleFullWidth}
        onSetFullWidth={handleSetAdaptiveWidth}
        onToggleShowStatusBar={handleToggleShowStatusBar}
        onNotify={showToast}
        syncing={syncing}
        onRunSync={syncNow}
        onSyncConfigChanged={setSyncConfig}
      />

      <PageHistoryModal
        open={historyOpen}
        pageId={detail?.page.id ?? null}
        pageTitle={detail?.page.title ?? ""}
        onClose={() => setHistoryOpen(false)}
        onRestored={handleVersionRestored}
        onNotify={showToast}
      />

      <UpdateNotice onOpenAbout={() => handleOpenSettingsAtTab("about")} />

      <TemplatesModal
        open={templatesOpen}
        onClose={() => {
          setTemplatesOpen(false);
          setTemplateFocusId(null);
        }}
        currentPage={!activeLocalMd && !activeTextFile && detail ? { id: detail.page.id, title: detail.page.title } : null}
        onNotify={showToast}
        focusTemplateId={templateFocusId}
        onUseTemplate={(input) => {
          handleCreatePage(input).catch(() => {});
        }}
      />

      {localConflict && (
        <FileConflictDialog
          fileName={localConflict.filePath.split(/[\\/]/).pop() || localConflict.filePath}
          busy={conflictBusy}
          onReload={() => void resolveConflict("reload")}
          onOverwrite={() => void resolveConflict("overwrite")}
          onSaveCopy={() => void resolveConflict("copy")}
        />
      )}

      <TrashModal
        open={trashOpen}
        trashedPages={trashedPages}
        onClose={() => setTrashOpen(false)}
        onRestore={(id) => {
          handleRestorePage(id).catch(() => {});
        }}
        onDeletePermanent={(id) => {
          handleDeletePermanent(id).catch(() => {});
        }}
        onEmptyTrash={() => {
          handleEmptyTrash().catch(() => {});
        }}
      />

      <MarkdownModal
        mode={markdownModalMode}
        exportData={exportPayload}
        pages={pages}
        defaultParentId={
          detail?.page.pageType === "doc" ? detail.page.id : null
        }
        onClose={() => setMarkdownModalMode(null)}
        onImportSubmit={handleImportMarkdownSubmit}
        onBatchImported={handleBatchImportSuccess}
        onRequestExportCurrent={async () => {
          if (detail?.page) {
            await flushPendingBlockSave();
            const exported = await exportPageMarkdown(detail.page.id);
            setExportPayload(exported);
          }
        }}
      />

      {toastMessage && <div className="nb-toast">{toastMessage}</div>}
    </div>
  );
};

export default App;
