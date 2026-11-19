import React, { useCallback, useEffect, useRef, useState } from "react";
import { UpdateCard } from "./UpdateCheck";
import { getUiLangPref, setUiLangPref, type UiLangPref } from "../../i18n/lang";
import {
  AlignCenter,
  Archive,
  Heart,
  MessageSquareText,
  Cloud,
  BookOpen,
  CheckCircle2,
  Columns2,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  Maximize2,
  Monitor,
  Moon,
  Network,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Trash2,
  Type,
  ExternalLink,
  X,
} from "lucide-react";
import {
  createBackupNow,
  exportWorkspaceZip,
  getSettings,
  getStorageInfo,
  importFontToDataDir,
  isTauriRuntime,
  listBackups,
  openPathInExplorer,
  pickFolderDialog,
  pickFontFileDialog,
  resetStorageToDefault,
  restoreBackup,
  setSetting,
  syncAllPagesToMarkdown,
  updateStorageConfig,
} from "../../api/client";
import type {
  BackupEntry,
  EditorPreferences,
  EditorViewMode,
  KbStatus,
  KeybindingMap,
  StorageConfigInfo,
  StylePluginState,
  ThemeTokens,
} from "../../types/notion";
import type { FontStyleMode, ThemeMode } from "./Topbar";
import { KeybindingSettingsPanel } from "./KeybindingSettingsPanel";
import { ThemeStudioPanel } from "./ThemeStudioPanel";
import { XyLogoIcon } from "./XyLogoIcon";
import { SyncSettingsPanel } from "./SyncSettingsPanel";
import { DonatePanel } from "./DonatePanel";
import { FeedbackPanel } from "./FeedbackPanel";
import { openExternalUrl, type SyncConfig } from "../../api/sync";
import {
  getShellIntegrationStatus,
  promptDefaultMdAssociation,
  registerShellIntegration,
  unregisterShellIntegration,
  type ShellIntegrationStatus,
} from "../../api/desktop";
import {
  deriveFontDisplayName,
  loadAndActivateCustomFont,
  normalizeFontPathInput,
  registerBrowserFontBuffer,
  XYNOTE_FONT_GUIDE_URL,
  type CustomFontConfig,
  type CustomFontEntry,
} from "../../utils/customFont";

const KbSettingsPanel = React.lazy(() =>
  import("../kb/KbSettingsPanel").then((m) => ({ default: m.KbSettingsPanel }))
);

export type SettingsTabId =
  | "storage"
  | "sync"
  | "kb"
  | "donate"
  | "feedback"
  | "themes"
  | "appearance"
  | "shortcuts"
  | "editor"
  | "backup"
  | "about";

export type ThemePreference = "light" | "dark" | "sepia" | "system";

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTabId;
  storageInfo: StorageConfigInfo | null;
  editorPrefs: EditorPreferences;
  keybindings: KeybindingMap;
  styleState: StylePluginState | null;
  themePref: ThemePreference;
  fontStyle: FontStyleMode;
  customFontConfig?: CustomFontConfig;
  fontSize: number;
  lineHeight: number;
  fullWidth: boolean;
  showStatusBar: boolean;
  onClose: () => void;
  onStorageUpdated: (
    info: StorageConfigInfo,
    shouldReloadWorkspace?: boolean
  ) => Promise<void> | void;
  onChangeEditorPrefs: (patch: Partial<EditorPreferences>) => void;
  onChangeKeybindings: (nextMerged: KeybindingMap) => void;
  onStyleStateChange: (nextState: StylePluginState) => void;
  onPreviewThemeOverride: (
    override: {
      baseMode?: ThemeMode;
      tokens?: ThemeTokens | null;
      extraCss?: string;
    } | null
  ) => void;
  onRefreshStylePlugins: () => Promise<StylePluginState | null>;
  onChangeThemePref: (next: ThemePreference) => void;
  onChangeFontStyle: (next: FontStyleMode) => void;
  onChangeCustomFontConfig?: (next: CustomFontConfig) => void;
  onChangeFontSize: (next: number) => void;
  onChangeLineHeight: (next: number) => void;
  onToggleFullWidth: () => void;
  onSetFullWidth?: (adaptive: boolean) => void;
  onToggleShowStatusBar: () => void;
  onNotify: (msg: string) => void;
  syncing: boolean;
  onRunSync: () => Promise<void>;
  onSyncConfigChanged: (cfg: SyncConfig) => void;
  kbStatus?: KbStatus | null;
  onKbStatusChange?: (next: KbStatus) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = "storage",
  storageInfo,
  editorPrefs,
  keybindings,
  styleState,
  themePref,
  fontStyle,
  customFontConfig = { activeId: null, applyGlobalUi: false, fonts: [] },
  fontSize,
  lineHeight,
  fullWidth,
  showStatusBar,
  onClose,
  onStorageUpdated,
  onChangeEditorPrefs,
  onChangeKeybindings,
  onStyleStateChange,
  onPreviewThemeOverride,
  onRefreshStylePlugins,
  onChangeThemePref,
  onChangeFontStyle,
  onChangeCustomFontConfig,
  onChangeFontSize,
  onChangeLineHeight,
  onToggleFullWidth,
  onSetFullWidth,
  onToggleShowStatusBar,
  onNotify,
  syncing,
  onRunSync,
  onSyncConfigChanged,
  kbStatus = null,
  onKbStatusChange,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [localInfo, setLocalInfo] = useState<StorageConfigInfo | null>(storageInfo);
  const [customDataDir, setCustomDataDir] = useState("");
  const [customMdSyncDir, setCustomMdSyncDir] = useState("");
  const [migrateOnChange, setMigrateOnChange] = useState(true);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const [fontPathDraft, setFontPathDraft] = useState("");
  const [fontNameDraft, setFontNameDraft] = useState("");
  const [shellStatus, setShellStatus] = useState<ShellIntegrationStatus | null>(
    null
  );
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const browserFontInputRef = useRef<HTMLInputElement | null>(null);

  const activeCustomFont =
    customFontConfig.fonts.find((f) => f.id === customFontConfig.activeId) ??
    customFontConfig.fonts[0] ??
    null;

  const prevOpenRef = useRef(false);

  const handleCloseClean = useCallback(() => {
    onPreviewThemeOverride(null);
    onClose();
  }, [onClose, onPreviewThemeOverride]);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [info, snapshotList, shellInfo, appSettings] = await Promise.all([
        getStorageInfo(),
        listBackups(),
        getShellIntegrationStatus().catch(() => null),
        getSettings().catch(() => null),
      ]);
      setLocalInfo(info);
      setCustomDataDir(info.activeDataDir);
      setCustomMdSyncDir(info.markdownSyncDir);
      setBackups(snapshotList);
      setShellStatus(shellInfo);
      if (appSettings) {
        const raw = appSettings.telemetryEnabled;
        setTelemetryEnabled(raw !== "false" && raw !== "disabled" && raw !== "0");
      }
    } catch {
      // Keep existing state if transient error
    }
  }, []);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setActiveTab(initialTab);
      setBanner(null);
      if (activeCustomFont?.path) {
        setFontPathDraft(activeCustomFont.path);
      }
      refreshDiagnostics().catch(() => {});
      onRefreshStylePlugins().catch(() => {});
    } else if (!open && prevOpenRef.current) {
      onPreviewThemeOverride(null);
    }
    prevOpenRef.current = open;
  }, [
    open,
    initialTab,
    activeCustomFont?.path,
    onPreviewThemeOverride,
    onRefreshStylePlugins,
    refreshDiagnostics,
  ]);

  const activateCustomFontFromInput = useCallback(
    async (rawPath: string, rawName?: string, portable?: boolean) => {
      const cleanPath = normalizeFontPathInput(rawPath);
      if (!cleanPath) {
        setBanner({
          kind: "error",
          text: "请粘贴本地字体文件路径（例如 C:\\Windows\\Fonts\\simkai.ttf），或点击「浏览选择字体文件…」",
        });
        return;
      }
      setBusyAction("custom-font");
      setBanner(null);
      try {
        const loaded = await loadAndActivateCustomFont(cleanPath);
        const displayName =
          rawName?.trim() ||
          loaded.resolvedDisplayName ||
          deriveFontDisplayName(cleanPath);
        const normKey = cleanPath.toLowerCase();
        const existing = customFontConfig.fonts.find(
          (f) => f.path.toLowerCase() === normKey
        );
        const entryId = existing?.id ?? `cfont-${Date.now().toString(36)}`;
        const nextEntry: CustomFontEntry = {
          id: entryId,
          name: displayName,
          path: cleanPath,
          portable: portable ?? existing?.portable ?? cleanPath.toLowerCase().startsWith("fonts/"),
          addedAt: existing?.addedAt ?? new Date().toISOString(),
        };
        const nextFonts = existing
          ? customFontConfig.fonts.map((f) => (f.id === entryId ? nextEntry : f))
          : [nextEntry, ...customFontConfig.fonts];

        onChangeCustomFontConfig?.({
          ...customFontConfig,
          activeId: entryId,
          fonts: nextFonts,
        });
        onChangeFontStyle("custom");
        setFontPathDraft(cleanPath);
        setFontNameDraft("");
        const msg = `已加载并启用自定义字体「${displayName}」`;
        setBanner({ kind: "success", text: msg });
        onNotify(msg);
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyAction(null);
      }
    },
    [customFontConfig, onChangeCustomFontConfig, onChangeFontStyle, onNotify]
  );

  const handleBrowseCustomFont = useCallback(async () => {
    if (!isTauriRuntime()) {
      browserFontInputRef.current?.click();
      return;
    }
    try {
      const picked = await pickFontFileDialog();
      if (!picked) return;
      setFontPathDraft(picked);
      await activateCustomFontFromInput(picked, fontNameDraft, false);
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [activateCustomFontFromInput, fontNameDraft]);

  const handleBrowserFontFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        registerBrowserFontBuffer(file.name, buffer);
        setFontPathDraft(file.name);
        await activateCustomFontFromInput(file.name, fontNameDraft, false);
      } catch (err) {
        setBanner({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activateCustomFontFromInput, fontNameDraft]
  );

  const handleImportFontPortable = useCallback(async () => {
    if (!isTauriRuntime()) {
      onNotify("拷入 XyNote-data/fonts 便携保存仅支持桌面客户端");
      return;
    }
    let srcPath = normalizeFontPathInput(fontPathDraft);
    if (!srcPath) {
      const picked = await pickFontFileDialog().catch(() => null);
      if (!picked) return;
      srcPath = picked;
    }
    setBusyAction("import-portable-font");
    setBanner(null);
    try {
      const imported = await importFontToDataDir(srcPath);
      await activateCustomFontFromInput(
        imported.storedPath,
        fontNameDraft.trim() || imported.displayName,
        true
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  }, [activateCustomFontFromInput, fontNameDraft, fontPathDraft, onNotify]);

  const handleDeleteSavedFont = useCallback(
    (fontId: string) => {
      const nextFonts = customFontConfig.fonts.filter((f) => f.id !== fontId);
      const nextActiveId =
        customFontConfig.activeId === fontId
          ? nextFonts[0]?.id ?? null
          : customFontConfig.activeId;
      onChangeCustomFontConfig?.({
        ...customFontConfig,
        activeId: nextActiveId,
        fonts: nextFonts,
      });
      if (!nextActiveId && fontStyle === "custom") {
        onChangeFontStyle("sans");
      }
    },
    [customFontConfig, fontStyle, onChangeCustomFontConfig, onChangeFontStyle]
  );

  useEffect(() => {
    if (storageInfo) {
      setLocalInfo(storageInfo);
    }
  }, [storageInfo]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        handleCloseClean();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleCloseClean]);

  if (!open) return null;

  const isTauri = isTauriRuntime();
  const info = localInfo;
  const defaultPortableDisplay = info
    ? info.defaultDataDir || `${info.exeDir}\\data`
    : ".\\data";

  const handleBrowseDataDir = async () => {
    const chosen = await pickFolderDialog(
      customDataDir || info?.activeDataDir,
      "选择 小悦 (XyNote) 数据存储根目录"
    );
    if (chosen) {
      setCustomDataDir(chosen);
    } else if (!isTauri) {
      setBanner({
        kind: "success",
        text: "当前为浏览器预览环境，可直接在上方输入框填写自定义目录路径测试迁移。",
      });
    }
  };

  const handleBrowseMdSyncDir = async () => {
    const chosen = await pickFolderDialog(
      customMdSyncDir || info?.markdownSyncDir,
      "选择本地 Markdown 实时镜像输出文件夹"
    );
    if (chosen) {
      setCustomMdSyncDir(chosen);
    } else if (!isTauri) {
      setBanner({
        kind: "success",
        text: "当前为浏览器预览环境，可直接在输入框修改 Markdown 同步路径。",
      });
    }
  };

  const handleApplyDataDir = async () => {
    const target = customDataDir.trim();
    if (!target) return;
    setBusyAction("apply-dir");
    setBanner(null);
    try {
      const updated = await updateStorageConfig({
        activeDataDir: target,
        migrateExistingData: migrateOnChange,
      });
      setLocalInfo(updated);
      setCustomDataDir(updated.activeDataDir);
      setCustomMdSyncDir(updated.markdownSyncDir);
      const nextBackups = await listBackups();
      setBackups(nextBackups);
      await onStorageUpdated(updated, true);
      setBanner({
        kind: "success",
        text: `存储路径已切换至 ${updated.activeDataDir}${
          migrateOnChange ? "（已完成现有数据无缝迁移）" : ""
        }`,
      });
      onNotify("数据存储目录已更新");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `更改存储目录失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetDefaultDir = async () => {
    setBusyAction("reset-dir");
    setBanner(null);
    try {
      const updated = await resetStorageToDefault(migrateOnChange);
      setLocalInfo(updated);
      setCustomDataDir(updated.activeDataDir);
      setCustomMdSyncDir(updated.markdownSyncDir);
      const nextBackups = await listBackups();
      setBackups(nextBackups);
      await onStorageUpdated(updated, true);
      setBanner({
        kind: "success",
        text: `已恢复便携默认目录：${updated.activeDataDir}`,
      });
      onNotify("已恢复软件同目录便携存储");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `恢复默认路径失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleAutoSyncMd = async () => {
    if (!info) return;
    const nextVal = !info.autoSyncMarkdown;
    try {
      const updated = await updateStorageConfig({ autoSyncMarkdown: nextVal });
      setLocalInfo(updated);
      await onStorageUpdated(updated, false);
      setBanner({
        kind: "success",
        text: nextVal
          ? "已开启页面实时同步保存为本地 .md 文件"
          : "已关闭实时 .md 磁盘镜像同步",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: `更新同步开关失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleApplyMdSyncDir = async () => {
    const target = customMdSyncDir.trim();
    if (!target) return;
    setBusyAction("apply-md-dir");
    try {
      const updated = await updateStorageConfig({ markdownSyncDir: target });
      setLocalInfo(updated);
      setCustomMdSyncDir(updated.markdownSyncDir);
      await onStorageUpdated(updated, false);
      setBanner({
        kind: "success",
        text: `Markdown 实时同步目录已更新为：${updated.markdownSyncDir}`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: `更新同步目录失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncAllMarkdownNow = async () => {
    setBusyAction("sync-all-md");
    try {
      const count = await syncAllPagesToMarkdown();
      setBanner({
        kind: "success",
        text: `全量同步完成：已将 ${count} 篇页面导出镜像至 ${
          info?.markdownSyncDir ?? "pages/"
        }`,
      });
      onNotify(`已全量同步 ${count} 篇 .md 到本地目录`);
    } catch (err) {
      setBanner({
        kind: "error",
        text: `全量同步失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleChangeImageSavePolicy = async (mode: "assets" | "base64") => {
    try {
      const updated = await updateStorageConfig({ imageSaveMode: mode });
      setLocalInfo(updated);
      onChangeEditorPrefs({ imageSaveMode: mode });
      await onStorageUpdated(updated, false);
      setBanner({
        kind: "success",
        text:
          mode === "assets"
            ? `粘贴图片将自动保存至本地 ${updated.assetsDir}`
            : "粘贴图片将以 Base64 内嵌于文档中",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: `更新图片策略失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleCreateBackupNow = async () => {
    setBusyAction("create-backup");
    setBanner(null);
    try {
      const created = await createBackupNow();
      const [nextBackups, freshInfo] = await Promise.all([
        listBackups(),
        getStorageInfo(),
      ]);
      setBackups(nextBackups);
      setLocalInfo(freshInfo);
      setBanner({
        kind: "success",
        text: `已创建数据库快照：${created.filename} (${formatBytes(created.sizeBytes)})`,
      });
      onNotify("数据库备份快照已创建");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `创建备份失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestoreSnapshot = async (entry: BackupEntry) => {
    setBusyAction(`restore-${entry.filename}`);
    setBanner(null);
    try {
      const updated = await restoreBackup(entry.fullPath);
      setLocalInfo(updated);
      await onStorageUpdated(updated, true);
      const nextBackups = await listBackups();
      setBackups(nextBackups);
      setBanner({
        kind: "success",
        text: `已一键还原至快照「${entry.filename}」，工作区所有页面与块已即时刷新！`,
      });
      onNotify("已还原备份快照并刷新工作区");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `还原备份失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportWorkspaceZip = async () => {
    setBusyAction("export-zip");
    setBanner(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const res = await exportWorkspaceZip(`notion-workspace-${stamp}.zip`);
      if (res.savedPath) {
        setBanner({
          kind: "success",
          text: `整库 Markdown + CSV 压缩包已导出：${res.savedPath}`,
        });
        onNotify("整库 ZIP 导出成功");
      }
    } catch (err) {
      setBanner({
        kind: "error",
        text: `整库导出失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenExplorer = async (targetPath?: string) => {
    if (!targetPath) return;
    await openPathInExplorer(targetPath);
    if (!isTauri) {
      onNotify(`预览模式路径：${targetPath}`);
    }
  };

  const handleRegisterShellIntegration = async () => {
    setBusyAction("shell-register");
    setBanner(null);
    try {
      const updated = await registerShellIntegration();
      setShellStatus(updated);
      const msg =
        "已写入 Windows 右键菜单「用小悦笔记 (XyNote) 打开」与打开方式关联！";
      setBanner({ kind: "success", text: msg });
      onNotify("Windows 右键菜单与文件关联已更新");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `注册右键菜单失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePromptDefaultMd = async () => {
    setBusyAction("shell-default");
    setBanner(null);
    try {
      const updated = await promptDefaultMdAssociation();
      setShellStatus(updated);
      const msg = updated.isDefaultMdHandler
        ? "已将当前小悦笔记设为系统默认 .md 打开程序！"
        : "已在系统打开方式中注册小悦笔记；请在弹出窗口选择「小悦笔记 (XyNote)」并点「始终」即可双击直开 .md。";
      setBanner({ kind: "success", text: msg });
      onNotify(
        updated.isDefaultMdHandler
          ? "已设为默认 .md 打开程序"
          : "请在系统窗口中选择小悦笔记并点始终"
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `唤醒系统默认应用设置失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleUnregisterShellIntegration = async () => {
    setBusyAction("shell-unregister");
    setBanner(null);
    try {
      const updated = await unregisterShellIntegration();
      setShellStatus(updated);
      setBanner({
        kind: "success",
        text: "已清理当前用户在 Windows 注册表中的小悦笔记右键菜单与 .md 关联项。",
      });
      onNotify("已移除 Windows 右键菜单与关联");
    } catch (err) {
      setBanner({
        kind: "error",
        text: `移除右键菜单失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const navItems: Array<{
    id: SettingsTabId;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: "storage", label: "存储与路径", icon: <HardDrive size={15} /> },
    { id: "sync", label: "同步", icon: <Cloud size={15} /> },
    { id: "kb", label: "知识库引擎 (SAG2)", icon: <Network size={15} /> },
    { id: "themes", label: "主题与样式插件", icon: <Sparkles size={15} /> },
    { id: "shortcuts", label: "快捷键配置", icon: <Keyboard size={15} /> },
    { id: "editor", label: "编辑器与排版模式", icon: <Sliders size={15} /> },
    { id: "appearance", label: "外观与排版", icon: <Palette size={15} /> },
    { id: "backup", label: "备份与数据安全", icon: <ShieldCheck size={15} /> },
    { id: "donate", label: "支持作者", icon: <Heart size={15} /> },
    { id: "feedback", label: "意见反馈", icon: <MessageSquareText size={15} /> },
    { id: "about", label: "关于软件", icon: <Info size={15} /> },
  ];

  const currentViewMode: EditorViewMode = editorPrefs.viewMode ?? "wysiwyg";

  return (
    <div className="nb-modal-backdrop nb-settings-backdrop" onMouseDown={handleCloseClean}>
      <div
        className="nb-modal-card nb-settings-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="偏好设置中心"
      >
        {/* Header */}
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Settings size={17} />
            <span>偏好设置中心</span>
            <span className="nb-settings-version-pill">v{__APP_VERSION__}</span>
          </div>
          <button
            type="button"
            className="nb-icon-btn"
            onClick={handleCloseClean}
            title="关闭设置 (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        <div className="nb-settings-body">
          {/* Left Commercial Navigation */}
          <nav className="nb-settings-sidebar" aria-label="设置分类">
            <div className="nb-settings-nav-group">工作区与引擎</div>
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-settings-tab={item.id}
                className={`nb-settings-nav-btn${
                  activeTab === item.id ? " is-active" : ""
                }`}
                onClick={() => {
                  if (item.id !== "themes") {
                    onPreviewThemeOverride(null);
                  }
                  setActiveTab(item.id);
                  setBanner(null);
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          {/* Right Panel */}
          <div className="nb-settings-content">
            {banner && (
              <div
                className={`nb-settings-banner ${
                  banner.kind === "error" ? "is-error" : "is-success"
                }`}
              >
                <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                <span>{banner.text}</span>
              </div>
            )}

            {/* TAB 1: 存储与路径 */}
            {activeTab === "storage" && (
              <div className="nb-settings-section-stack">
                <div>
                  <h3 className="nb-settings-heading">便携式存储与自定义路径管理</h3>
                  <p className="nb-settings-desc">
                    所有笔记、多维数据库、双向链接与本地图片均离线保存在你的硬盘目录中，支持免重启热切换路径与一键迁移。
                  </p>
                </div>

                {/* Portable Default Callout */}
                <div className="nb-storage-portable-banner">
                  <div className="nb-storage-portable-top">
                    <span className="nb-storage-badge">
                      {info?.isDefaultPortableDir !== false
                        ? "便携模式（绿色免安装同目录）"
                        : "自定义数据目录模式"}
                    </span>
                    <span className="nb-storage-meta">
                      {info?.exeDirWritable !== false
                        ? "✓ 软件所在目录可读写"
                        : "系统目录只读（已自动回退 AppData）"}
                    </span>
                  </div>
                  <div className="nb-storage-portable-line">
                    默认存储在当前软件目录: <code>{defaultPortableDisplay}</code>
                  </div>
                </div>

                {shellStatus?.supported && (
                  <div className="nb-settings-card-box">
                    <div className="nb-settings-row-head">
                      <div>
                        <div className="nb-settings-label">
                          Windows 右键菜单与默认打开 .md 文件（免管理员即时生效）
                        </div>
                        <div className="nb-settings-sub">
                          即使使用便携版 <code>portable.exe</code>，无需管理员权限也可在文件右键看到{" "}
                          <b>「用小悦笔记 (XyNote) 打开」</b>，双击即可直接用块编辑器打开本地{" "}
                          <code>.md</code> 文档
                        </div>
                      </div>
                      <span
                        className="nb-storage-meta"
                        style={
                          shellStatus.isDefaultMdHandler
                            ? undefined
                            : { color: "var(--text-secondary)" }
                        }
                      >
                        {shellStatus.isDefaultMdHandler
                          ? "✓ 已设为默认 .md 程序"
                          : shellStatus.contextMenuRegistered &&
                              shellStatus.pathMatchesCurrentExe
                            ? "✓ 右键菜单已就绪"
                            : "尚未关联当前程序路径"}
                      </span>
                    </div>

                    <div className="nb-storage-kv-grid">
                      <div className="nb-storage-kv-item">
                        <span className="nb-storage-kv-key">当前绑定程序路径</span>
                        <code className="nb-storage-kv-val" title={shellStatus.currentExePath}>
                          {shellStatus.registeredExePath || shellStatus.currentExePath}
                        </code>
                        <span className="nb-storage-kv-tag">
                          {shellStatus.pathMatchesCurrentExe ? "路径一致" : "待刷新"}
                        </span>
                      </div>
                      <div className="nb-storage-kv-item">
                        <span className="nb-storage-kv-key">资源管理器右键与打开方式</span>
                        <span className="nb-storage-kv-tag">
                          {shellStatus.contextMenuRegistered ? "右键菜单已开启" : "未开启右键"}
                        </span>
                        <span className="nb-storage-kv-tag">
                          {shellStatus.openWithRegistered ? "打开方式列表已注册" : "未注册打开方式"}
                        </span>
                      </div>
                    </div>

                    <div className="nb-settings-actions-bar">
                      <button
                        type="button"
                        className="nb-btn-primary"
                        disabled={busyAction !== null}
                        onClick={() => {
                          handlePromptDefaultMd().catch(() => {});
                        }}
                      >
                        <Sparkles size={14} />
                        {busyAction === "shell-default"
                          ? "正在唤醒系统选择..."
                          : "设为默认打开 .md 程序"}
                      </button>

                      <button
                        type="button"
                        className="nb-btn-secondary"
                        disabled={busyAction !== null}
                        onClick={() => {
                          handleRegisterShellIntegration().catch(() => {});
                        }}
                      >
                        <RefreshCw size={14} />
                        {busyAction === "shell-register"
                          ? "正在写入注册表..."
                          : "一键注册 / 修复右键菜单"}
                      </button>

                      <button
                        type="button"
                        className="nb-btn-secondary"
                        disabled={busyAction !== null}
                        onClick={() => {
                          handleUnregisterShellIntegration().catch(() => {});
                        }}
                      >
                        <Trash2 size={14} /> 移除右键菜单与关联
                      </button>
                    </div>
                  </div>
                )}

                {/* Active Data Directory Editor */}
                <div className="nb-settings-card-box">
                  <div className="nb-settings-row-head">
                    <div>
                      <div className="nb-settings-label">当前数据存储根目录 (activeDataDir)</div>
                      <div className="nb-settings-sub">
                        包含 SQLite 数据库、自动备份与粘贴图片资源文件夹
                      </div>
                    </div>
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={() => handleOpenExplorer(info?.activeDataDir)}
                    >
                      <FolderOpen size={14} /> 在资源管理器中打开
                    </button>
                  </div>

                  <div className="nb-path-input-group">
                    <input
                      type="text"
                      className="nb-input nb-mono-input"
                      value={customDataDir}
                      onChange={(e) => setCustomDataDir(e.target.value)}
                      placeholder="例如 D:\MyKnowledgeBase\data"
                    />
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={handleBrowseDataDir}
                    >
                      浏览选择文件夹...
                    </button>
                  </div>

                  <label className="nb-checkbox-row">
                    <input
                      type="checkbox"
                      checked={migrateOnChange}
                      onChange={(e) => setMigrateOnChange(e.target.checked)}
                    />
                    <span>切换路径时自动迁移现有数据库、.md 镜像与图片资源</span>
                  </label>

                  <div className="nb-settings-actions-bar">
                    <button
                      type="button"
                      className="nb-btn-primary"
                      disabled={busyAction !== null}
                      onClick={handleApplyDataDir}
                    >
                      <HardDrive size={14} />
                      {busyAction === "apply-dir"
                        ? "正在迁移并切换..."
                        : "更改路径并迁移现有数据"}
                    </button>

                    <button
                      type="button"
                      className="nb-btn-secondary"
                      disabled={busyAction !== null}
                      onClick={handleResetDefaultDir}
                    >
                      <RotateCcw size={14} />
                      恢复默认（当前软件所在目录）
                    </button>
                  </div>

                  {/* Detailed Sub-paths */}
                  <div className="nb-storage-kv-grid">
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">主数据库文件</span>
                      <code className="nb-storage-kv-val">
                        {info?.dbFilePath ?? ".\\XyNote-data\\xynote.db"}
                      </code>
                      <span className="nb-storage-kv-tag">
                        {formatBytes(info?.dbSizeBytes ?? 0)} · {info?.pageCount ?? 0} 页 /{" "}
                        {info?.blockCount ?? 0} 块
                      </span>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">图片附件目录 (assets)</span>
                      <code className="nb-storage-kv-val">
                        {info?.assetsDir ?? ".\\XyNote-data\\assets"}
                      </code>
                      <button
                        type="button"
                        className="nb-link-btn"
                        onClick={() => handleOpenExplorer(info?.assetsDir)}
                      >
                        打开
                      </button>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">自动快照目录 (backups)</span>
                      <code className="nb-storage-kv-val">
                        {info?.backupsDir ?? ".\\XyNote-data\\backups"}
                      </code>
                      <button
                        type="button"
                        className="nb-link-btn"
                        onClick={() => handleOpenExplorer(info?.backupsDir)}
                      >
                        打开
                      </button>
                    </div>
                  </div>
                </div>

                {/* Live Markdown Mirror Sync */}
                <div className="nb-settings-card-box">
                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">
                        实时将页面同步保存为本地 <code>.md</code> 文件
                      </div>
                      <div className="nb-settings-sub">
                        每次编辑自动在磁盘生成层级清晰的纯文本 Markdown 镜像，随时可用 Obsidian / Git 或任意 Markdown 工具直接查阅
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        info?.autoSyncMarkdown !== false ? " is-on" : ""
                      }`}
                      onClick={handleToggleAutoSyncMd}
                      aria-label="实时将页面同步保存为本地 .md 文件"
                    />
                  </div>

                  <div className="nb-path-input-group">
                    <input
                      type="text"
                      className="nb-input nb-mono-input"
                      value={customMdSyncDir}
                      onChange={(e) => setCustomMdSyncDir(e.target.value)}
                      placeholder="Markdown 镜像输出目录"
                    />
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={handleBrowseMdSyncDir}
                    >
                      浏览...
                    </button>
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={handleApplyMdSyncDir}
                    >
                      应用目录
                    </button>
                  </div>

                  <div className="nb-settings-actions-bar">
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      disabled={busyAction !== null}
                      onClick={handleSyncAllMarkdownNow}
                    >
                      <RefreshCw size={14} />
                      {busyAction === "sync-all-md"
                        ? "正在同步..."
                        : "立即全量同步 .md 到磁盘"}
                    </button>
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={() => handleOpenExplorer(info?.markdownSyncDir)}
                    >
                      <FolderOpen size={14} /> 打开 .md 镜像目录
                    </button>
                  </div>
                </div>

                {/* Image Paste Storage Policy */}
                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">剪贴板粘贴图片存储方式 (Ctrl+V 截图)</div>
                  <div className="nb-settings-radio-grid">
                    <button
                      type="button"
                      className={`nb-choice-card${
                        (info?.imageSaveMode ?? editorPrefs.imageSaveMode ?? "assets") ===
                        "assets"
                          ? " is-selected"
                          : ""
                      }`}
                      onClick={() => handleChangeImageSavePolicy("assets")}
                    >
                      <div className="nb-choice-title">
                        保存到本地 assets 目录 <span className="nb-rec-tag">推荐</span>
                      </div>
                      <div className="nb-choice-desc">
                        自动将截图保存为独立图片文件至 <code>assets/</code>，数据库极速轻量
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        (info?.imageSaveMode ?? editorPrefs.imageSaveMode) === "base64"
                          ? " is-selected"
                          : ""
                      }`}
                      onClick={() => handleChangeImageSavePolicy("base64")}
                    >
                      <div className="nb-choice-title">内嵌 Base64 编码</div>
                      <div className="nb-choice-desc">
                        将图片编码直接内嵌至文档内容中，单文件分享无外部依赖
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: 编辑器与排版模式 */}
            {activeTab === "editor" && (
              <div className="nb-settings-section-stack">
                <div>
                  <h3 className="nb-settings-heading">编辑器与双模体验</h3>
                  <p className="nb-settings-desc">
                    融合 Notion 块级灵活编排与零延迟源码/分屏写作体验（快捷键{" "}
                    <code>Ctrl + /</code> 随时切换）。
                  </p>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">当前 / 默认编辑视图模式</div>
                  <div className="nb-settings-mode-grid">
                    <button
                      type="button"
                      className={`nb-choice-card${
                        currentViewMode === "wysiwyg" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeEditorPrefs({ viewMode: "wysiwyg" })}
                    >
                      <div className="nb-choice-title">
                        <Eye size={15} /> 所见即所得 (WYSIWYG)
                      </div>
                      <div className="nb-choice-desc">
                        Notion 块级拖拽 + 行内语法实时渲染
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        currentViewMode === "source" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeEditorPrefs({ viewMode: "source" })}
                    >
                      <div className="nb-choice-title">
                        <FileCode2 size={15} /> Markdown 源码模式
                      </div>
                      <div className="nb-choice-desc">
                        带行号等宽纯 Markdown 编辑器，双向无损同步
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        currentViewMode === "split" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeEditorPrefs({ viewMode: "split" })}
                    >
                      <div className="nb-choice-title">
                        <Columns2 size={15} /> 分屏实时预览 (Split)
                      </div>
                      <div className="nb-choice-desc">
                        左侧编写 Markdown 源码，右侧实时渲染公式与表格
                      </div>
                    </button>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">专注模式 Focus Mode (F8)</div>
                      <div className="nb-settings-sub">
                        仅保持当前正在输入的段落清晰高亮，淡化其余上下文干扰
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.focusMode ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({ focusMode: !editorPrefs.focusMode })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">
                        打字机居中模式 Typewriter Mode (F9)
                      </div>
                      <div className="nb-settings-sub">
                        长文创作时将当前编辑行自动保持在屏幕垂直中央区域
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.typewriterMode ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({
                          typewriterMode: !editorPrefs.typewriterMode,
                        })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">
                        显示右侧文档大纲目录 Outline TOC (Ctrl+Shift+1)
                      </div>
                      <div className="nb-settings-sub">
                        自动提取 H1 / H2 / H3 标题树，点击即可平滑跳转定位
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.showOutline ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({ showOutline: !editorPrefs.showOutline })
                      }
                    />
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">智能多行 Markdown 粘贴解析</div>
                      <div className="nb-settings-sub">
                        粘贴包含标题、代码块、GFM 表格、任务列表或公式的文本时自动拆分为富文本块
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.smartMarkdownPaste !== false ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({
                          smartMarkdownPaste:
                            editorPrefs.smartMarkdownPaste === false ? true : false,
                        })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">行内 Markdown 实时转换</div>
                      <div className="nb-settings-sub">
                        支持 <code>**加粗**</code>、<code>*斜体*</code>、
                        <code>==高亮==</code>、<code>| 表格 |</code> 与 <code>$$公式$$</code>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.inlineMarkdownShortcuts !== false ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({
                          inlineMarkdownShortcuts:
                            editorPrefs.inlineMarkdownShortcuts === false ? true : false,
                        })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">代码块与源码显示行号</div>
                      <div className="nb-settings-sub">
                        在代码块及 Markdown 源码编辑器左侧展示行号栏
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.codeLineNumbers !== false ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({
                          codeLineNumbers:
                            editorPrefs.codeLineNumbers === false ? true : false,
                        })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">代码块自动折行 (Word Wrap)</div>
                      <div className="nb-settings-sub">
                        默认开启超长代码自动换行，关闭则保持横向滚动
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.codeWordWrap !== false ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({
                          codeWordWrap:
                            editorPrefs.codeWordWrap === false ? true : false,
                        })
                      }
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">Tab 缩进空格宽度</div>
                      <div className="nb-settings-sub">
                        控制源码模式与代码块内按下 Tab 键插入的空格数量
                      </div>
                    </div>
                    <div className="nb-segmented-mini">
                      {[2, 4].map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          className={`nb-seg-btn${
                            (editorPrefs.tabSize ?? 2) === sz ? " is-active" : ""
                          }`}
                          onClick={() => onChangeEditorPrefs({ tabSize: sz })}
                        >
                          {sz} 空格
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">浏览器 / 系统拼写检查</div>
                      <div className="nb-settings-sub">
                        对英文单词启用拼写波浪线提示（默认关闭以保持视觉纯净）
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        editorPrefs.spellcheck ? " is-on" : ""
                      }`}
                      onClick={() =>
                        onChangeEditorPrefs({ spellcheck: !editorPrefs.spellcheck })
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: 外观与排版 */}
            {activeTab === "appearance" && (
              <div className="nb-settings-section-stack">
                <div>
                  <h3 className="nb-settings-heading">外观主题与阅读排版</h3>
                  <p className="nb-settings-desc">
                    定制温润纸面配色、正文字体族、字号与行距，打造长时间写作不疲劳的桌面阅读环境。
                  </p>
                </div>

                <UiLanguageCard />

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">界面配色主题</div>
                  <div className="nb-theme-cards-grid">
                    <button
                      type="button"
                      className={`nb-choice-card${
                        themePref === "light" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeThemePref("light")}
                    >
                      <div className="nb-choice-title">
                        <Sun size={15} /> 浅色纸面
                      </div>
                      <div className="nb-choice-desc">#FFFFFF 纯净日光白纸</div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        themePref === "dark" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeThemePref("dark")}
                    >
                      <div className="nb-choice-title">
                        <Moon size={15} /> 深色夜间
                      </div>
                      <div className="nb-choice-desc">#191919 柔和暗夜石墨</div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        themePref === "sepia" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeThemePref("sepia")}
                    >
                      <div className="nb-choice-title">
                        <BookOpen size={15} /> 护眼暖色
                      </div>
                      <div className="nb-choice-desc">#FBF7EE 羊皮纸电纸书</div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${
                        themePref === "system" ? " is-selected" : ""
                      }`}
                      onClick={() => onChangeThemePref("system")}
                    >
                      <div className="nb-choice-title">
                        <Monitor size={15} /> 跟随系统
                      </div>
                      <div className="nb-choice-desc">自动同步 Windows 深浅色</div>
                    </button>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">全局正文排版字体</div>
                  <div className="nb-font-switcher">
                    <button
                      type="button"
                      className={`nb-font-option nb-font-sans${
                        fontStyle === "sans" ? " is-active" : ""
                      }`}
                      onClick={() => onChangeFontStyle("sans")}
                    >
                      <span className="nb-font-option-sample">Ag 永</span>
                      <span className="nb-font-option-name">现代无衬线 (Sans)</span>
                    </button>
                    <button
                      type="button"
                      className={`nb-font-option nb-font-serif${
                        fontStyle === "serif" ? " is-active" : ""
                      }`}
                      onClick={() => onChangeFontStyle("serif")}
                    >
                      <span className="nb-font-option-sample">Ag 永</span>
                      <span className="nb-font-option-name">人文衬线体 (Serif)</span>
                    </button>
                    <button
                      type="button"
                      className={`nb-font-option nb-font-mono${
                        fontStyle === "mono" ? " is-active" : ""
                      }`}
                      onClick={() => onChangeFontStyle("mono")}
                    >
                      <span className="nb-font-option-sample">Ag 01</span>
                      <span className="nb-font-option-name">等宽代码体 (Mono)</span>
                    </button>
                    <button
                      type="button"
                      className={`nb-font-option nb-font-custom${
                        fontStyle === "custom" ? " is-active" : ""
                      }`}
                      onClick={() => {
                        if (!activeCustomFont) {
                          setBanner({
                            kind: "error",
                            text: "请先在下方粘贴本地字体文件路径并点击「加载并启用字体」",
                          });
                          return;
                        }
                        onChangeFontStyle("custom");
                      }}
                    >
                      <span className="nb-font-option-sample">Ag 字</span>
                      <span className="nb-font-option-name">
                        {activeCustomFont
                          ? `自定义：${activeCustomFont.name}`
                          : "自定义字体 (Custom)"}
                      </span>
                    </button>
                  </div>

                  <div className="nb-custom-font-panel">
                    <div className="nb-custom-font-head">
                      <div>
                        <div className="nb-settings-label">
                          自定义本地字体（输入字体路径即可使用）
                        </div>
                        <div className="nb-settings-sub">
                          支持 <code>.ttf</code> / <code>.otf</code> / <code>.woff2</code> /{" "}
                          <code>.woff</code> / <code>.ttc</code>，粘贴文件地址或直接浏览选择即可生效
                        </div>
                      </div>
                      <button
                        type="button"
                        className="nb-custom-font-guide-btn"
                        onClick={() => {
                          openExternalUrl(XYNOTE_FONT_GUIDE_URL).catch(() => {});
                        }}
                      >
                        <ExternalLink size={13} />
                        <span>不会配置？查看官网字体配置与使用教程</span>
                      </button>
                    </div>

                    <input
                      ref={browserFontInputRef}
                      type="file"
                      accept=".ttf,.otf,.woff2,.woff,.ttc"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        handleBrowserFontFileSelected(e).catch(() => {});
                      }}
                    />

                    <div className="nb-custom-font-fields">
                      <input
                        type="text"
                        className="nb-custom-font-input nb-mono-input"
                        value={fontPathDraft}
                        onChange={(e) => setFontPathDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            activateCustomFontFromInput(fontPathDraft, fontNameDraft).catch(
                              () => {}
                            );
                          }
                        }}
                        placeholder="粘贴字体路径，如 C:\Windows\Fonts\simkai.ttf 或 D:\Fonts\LXGWWenKai.ttf"
                        aria-label="自定义字体文件路径"
                      />
                      <input
                        type="text"
                        className="nb-custom-font-input"
                        value={fontNameDraft}
                        onChange={(e) => setFontNameDraft(e.target.value)}
                        placeholder="显示名称（选填，留空自动识别）"
                        aria-label="自定义字体显示名称"
                      />
                    </div>

                    <div className="nb-custom-font-hint-line">
                      <span>Windows 技巧：按住 Shift + 右键点击字体文件 →「复制文件地址」直接粘贴；也可点击教程查看 macOS / Linux 路径与开源字体推荐</span>
                    </div>

                    <div className="nb-settings-actions-bar">
                      <button
                        type="button"
                        className="nb-btn-primary"
                        disabled={busyAction !== null}
                        onClick={() => {
                          activateCustomFontFromInput(fontPathDraft, fontNameDraft).catch(
                            () => {}
                          );
                        }}
                      >
                        <Type size={14} />
                        {busyAction === "custom-font"
                          ? "正在加载字体..."
                          : "加载并启用字体"}
                      </button>

                      <button
                        type="button"
                        className="nb-btn-secondary"
                        disabled={busyAction !== null}
                        onClick={() => {
                          handleBrowseCustomFont().catch(() => {});
                        }}
                      >
                        <FolderOpen size={14} /> 浏览选择字体文件…
                      </button>

                      <button
                        type="button"
                        className="nb-btn-secondary"
                        disabled={busyAction !== null}
                        title="把字体复制到 XyNote-data/fonts 目录并用相对路径保存，U 盘便携带走不丢字体"
                        onClick={() => {
                          handleImportFontPortable().catch(() => {});
                        }}
                      >
                        <Archive size={14} />
                        {busyAction === "import-portable-font"
                          ? "正在拷入便携库..."
                          : "拷入 XyNote-data/fonts 便携保存"}
                      </button>
                    </div>

                    {customFontConfig.fonts.length > 0 && (
                      <div className="nb-custom-font-list">
                        {customFontConfig.fonts.map((entry) => {
                          const isCurrent =
                            activeCustomFont?.id === entry.id &&
                            fontStyle === "custom";
                          return (
                            <div
                              key={entry.id}
                              className={`nb-custom-font-item${
                                isCurrent ? " is-active" : ""
                              }`}
                            >
                              <button
                                type="button"
                                className="nb-custom-font-item-main"
                                onClick={() => {
                                  setFontPathDraft(entry.path);
                                  activateCustomFontFromInput(
                                    entry.path,
                                    entry.name,
                                    entry.portable
                                  ).catch(() => {});
                                }}
                              >
                                <div className="nb-custom-font-item-title">
                                  <span>{entry.name}</span>
                                  <span
                                    className={`nb-custom-font-tag${
                                      entry.portable ? " is-portable" : ""
                                    }`}
                                  >
                                    {entry.portable ? "便携库内" : "本地路径"}
                                  </span>
                                  {isCurrent && (
                                    <span className="nb-custom-font-tag is-portable">
                                      当前使用中
                                    </span>
                                  )}
                                </div>
                                <div className="nb-custom-font-item-path" title={entry.path}>
                                  {entry.path}
                                </div>
                              </button>

                              <button
                                type="button"
                                className="nb-link-btn"
                                title="从列表中移除此字体"
                                aria-label={`删除自定义字体 ${entry.name}`}
                                onClick={() => handleDeleteSavedFont(entry.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="nb-settings-toggle-row">
                      <div>
                        <div className="nb-settings-label">
                          同时应用到侧边栏与软件全局界面
                        </div>
                        <div className="nb-settings-sub">
                          开启并选用自定义字体后，不仅正文文档生效，侧边栏、弹窗与界面文字也会同步换肤
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`nb-toggle-switch${
                          customFontConfig.applyGlobalUi ? " is-on" : ""
                        }`}
                        aria-label="同时应用到侧边栏与软件全局界面"
                        onClick={() => {
                          onChangeCustomFontConfig?.({
                            ...customFontConfig,
                            applyGlobalUi: !customFontConfig.applyGlobalUi,
                          });
                        }}
                      />
                    </div>

                    {activeCustomFont && (
                      <div className="nb-custom-font-preview">
                        <div className="nb-custom-font-preview-label">
                          实时字体效果预览（{activeCustomFont.name}）：
                        </div>
                        <div className="nb-custom-font-preview-sample">
                          春江潮水连海平，海上明月共潮生。XyNote 块级笔记 0123456789 ABCdef!
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-slider-block">
                    <div className="nb-slider-header">
                      <span className="nb-settings-label">编辑器正文字号</span>
                      <span className="nb-slider-value">{fontSize}px</span>
                    </div>
                    <input
                      type="range"
                      min={14}
                      max={20}
                      step={1}
                      value={fontSize}
                      onChange={(e) => onChangeFontSize(Number(e.target.value))}
                      className="nb-range-slider"
                      aria-label="编辑器正文字号"
                    />
                    <div className="nb-slider-ticks">
                      <span>紧凑 14px</span>
                      <span>标准 16px</span>
                      <span>舒朗 20px</span>
                    </div>
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-slider-block">
                    <div className="nb-slider-header">
                      <span className="nb-settings-label">编辑器正文行距</span>
                      <span className="nb-slider-value">{lineHeight.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={1.5}
                      max={2.0}
                      step={0.05}
                      value={lineHeight}
                      onChange={(e) => onChangeLineHeight(Number(e.target.value))}
                      className="nb-range-slider"
                      aria-label="编辑器正文行距"
                    />
                    <div className="nb-slider-ticks">
                      <span>1.50</span>
                      <span>1.68 默认</span>
                      <span>2.00 宽松</span>
                    </div>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">页面版心宽度布局</div>
                  <div className="nb-settings-radio-grid">
                    <button
                      type="button"
                      className={`nb-choice-card${fullWidth ? " is-selected" : ""}`}
                      onClick={() => {
                        if (onSetFullWidth) {
                          onSetFullWidth(true);
                        } else if (!fullWidth) {
                          onToggleFullWidth();
                        }
                      }}
                    >
                      <div className="nb-choice-title">
                        <Maximize2 size={15} /> 自适应窗口宽度{" "}
                        <span className="nb-rec-tag">默认开启</span>
                      </div>
                      <div className="nb-choice-desc">
                        100% 响应式铺满工作区视口，宽表、代码块与 Mermaid 架构图无遮挡舒展展示
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`nb-choice-card${!fullWidth ? " is-selected" : ""}`}
                      onClick={() => {
                        if (onSetFullWidth) {
                          onSetFullWidth(false);
                        } else if (fullWidth) {
                          onToggleFullWidth();
                        }
                      }}
                    >
                      <div className="nb-choice-title">
                        <AlignCenter size={15} /> 居中阅读版心 (960px)
                      </div>
                      <div className="nb-choice-desc">
                        960px 舒适阅读栏宽，源码模式与左右分屏自动保持全宽
                      </div>
                    </button>
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">显示底部商业级状态栏</div>
                      <div className="nb-settings-sub">
                        常驻展示便携目录状态、专注/打字机开关及实时字数与阅读时长统计
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${showStatusBar ? " is-on" : ""}`}
                      onClick={onToggleShowStatusBar}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: 备份与数据安全 */}
            {activeTab === "backup" && (
              <div className="nb-settings-section-stack">
                <div>
                  <h3 className="nb-settings-heading">滚动快照备份与整库安全导出</h3>
                  <p className="nb-settings-desc">
                    自动为 SQLite 主数据库建立时间点快照，支持零重启一键回滚及全工作区开放格式 ZIP 导出。
                  </p>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">启动软件时自动创建安全备份</div>
                      <div className="nb-settings-sub">
                        每次启动自动在 <code>backups/</code> 生成一致性快照并按保留上限滚动清理
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`nb-toggle-switch${
                        info?.autoBackupOnLaunch !== false ? " is-on" : ""
                      }`}
                      onClick={async () => {
                        const updated = await updateStorageConfig({
                          autoBackupOnLaunch: !(info?.autoBackupOnLaunch !== false),
                        });
                        setLocalInfo(updated);
                        await onStorageUpdated(updated, false);
                      }}
                    />
                  </div>

                  <div className="nb-menu-divider" />

                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">最大保留历史快照数量</div>
                      <div className="nb-settings-sub">超出数量上限的旧备份将自动轮转清理</div>
                    </div>
                    <div className="nb-segmented-mini">
                      {[5, 10, 20].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          className={`nb-seg-btn${
                            (info?.maxBackups ?? 10) === cnt ? " is-active" : ""
                          }`}
                          onClick={async () => {
                            const updated = await updateStorageConfig({
                              maxBackups: cnt,
                            });
                            setLocalInfo(updated);
                            await onStorageUpdated(updated, false);
                          }}
                        >
                          {cnt} 份
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="nb-settings-actions-bar">
                    <button
                      type="button"
                      className="nb-btn-primary"
                      disabled={busyAction !== null}
                      onClick={handleCreateBackupNow}
                    >
                      <Database size={14} />
                      {busyAction === "create-backup"
                        ? "正在创建快照..."
                        : "立即创建备份"}
                    </button>

                    <button
                      type="button"
                      className="nb-btn-secondary"
                      disabled={busyAction !== null}
                      onClick={handleExportWorkspaceZip}
                    >
                      <Archive size={14} />
                      {busyAction === "export-zip"
                        ? "正在打包 ZIP..."
                        : "整库导出为 Markdown ZIP 包"}
                    </button>

                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={() => handleOpenExplorer(info?.backupsDir)}
                    >
                      <FolderOpen size={14} /> 打开备份目录
                    </button>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-row-head">
                    <div className="nb-settings-label">
                      可用历史备份快照 ({backups.length})
                    </div>
                    <button
                      type="button"
                      className="nb-link-btn"
                      onClick={() => refreshDiagnostics()}
                    >
                      刷新列表
                    </button>
                  </div>

                  {backups.length === 0 ? (
                    <div className="nb-backup-empty">
                      暂无历史快照，点击上方「立即创建备份」生成第一份时间点快照。
                    </div>
                  ) : (
                    <div className="nb-backup-list">
                      {backups.map((b) => (
                        <div key={b.fullPath} className="nb-backup-row">
                          <div className="nb-backup-meta">
                            <div className="nb-backup-name">{b.filename}</div>
                            <div className="nb-backup-sub">
                              {formatDateTime(b.createdAt)} · {formatBytes(b.sizeBytes)}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="nb-btn-secondary"
                            disabled={busyAction !== null}
                            onClick={() => handleRestoreSnapshot(b)}
                          >
                            <RotateCcw size={13} />
                            {busyAction === `restore-${b.filename}`
                              ? "还原中..."
                              : "一键还原此备份"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: 主题与样式插件 */}
            {activeTab === "sync" && (
              <SyncSettingsPanel
                syncing={syncing}
                onRunSync={onRunSync}
                onConfigChanged={onSyncConfigChanged}
                onNotify={onNotify}
              />
            )}

            {activeTab === "kb" && (
              <React.Suspense
                fallback={
                  <div className="nb-settings-desc">正在加载 SAG2 本地知识库设置面板…</div>
                }
              >
                <KbSettingsPanel
                  status={kbStatus}
                  onStatusChange={(next) => onKbStatusChange?.(next)}
                  onNotify={onNotify}
                  onOpenIndexFolder={(dbPath) => handleOpenExplorer(dbPath)}
                />
              </React.Suspense>
            )}

            {activeTab === "donate" && <DonatePanel />}

            {activeTab === "feedback" && <FeedbackPanel onNotify={onNotify} />}

            {activeTab === "themes" && (
              <ThemeStudioPanel
                styleState={styleState}
                themePref={themePref}
                onStyleStateChange={onStyleStateChange}
                onSelectBuiltinTheme={onChangeThemePref}
                onPreviewThemeOverride={onPreviewThemeOverride}
                onRefreshPlugins={onRefreshStylePlugins}
                onNotify={onNotify}
              />
            )}

            {/* TAB: 快捷键配置 */}
            {activeTab === "shortcuts" && (
              <KeybindingSettingsPanel
                keybindings={keybindings}
                onChangeKeybindings={onChangeKeybindings}
                onNotify={onNotify}
              />
            )}

            {/* TAB 6: 关于软件 */}
            {activeTab === "about" && (
              <div className="nb-settings-section-stack">
                <div className="nb-about-hero">
                  <XyLogoIcon size={44} />
                  <div>
                    <div className="nb-about-title">
                      小悦 · 轻量知识笔记 (XyNote)
                      <span className="nb-settings-version-pill">
                        v{__APP_VERSION__}
                      </span>
                    </div>
                    <div className="nb-about-sub">
                      悦享服务、愉悦记录 · 块级结构与多维表格知识库 · Markdown 双模桌面端
                    </div>
                  </div>
                </div>

                <UpdateCard />

                <div className="nb-settings-card-box">
                  <div className="nb-settings-toggle-row">
                    <div>
                      <div className="nb-settings-label">匿名装机与活跃统计</div>
                      <div className="nb-settings-sub">
                        仅在每日首次启动或升级后后台上报匿名设备哈希、系统架构与版本号（不含任何笔记内容与个人信息），随时可关闭
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={telemetryBusy}
                      className={`nb-toggle-switch${
                        telemetryEnabled ? " is-on" : ""
                      }`}
                      onClick={async () => {
                        const next = !telemetryEnabled;
                        setTelemetryEnabled(next);
                        setTelemetryBusy(true);
                        try {
                          await setSetting(
                            "telemetryEnabled",
                            next ? "true" : "false"
                          );
                          onNotify(
                            next
                              ? "已开启匿名装机与活跃统计"
                              : "已关闭匿名装机与活跃统计"
                          );
                        } catch {
                          setTelemetryEnabled(!next);
                          onNotify("保存统计偏好失败");
                        } finally {
                          setTelemetryBusy(false);
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">品牌故事与命名理念</div>
                  <ul className="nb-about-list">
                    <li>
                      <b>中文名「小悦」</b>（全称 <b>「小悦 · 轻量知识笔记」</b> / <b>「小悦笔记」</b>，日常简称 <b>「小悦」</b>）：寓意“悦享服务、愉悦记录”，天然带有服务平台的亲和力与流畅感，没有传统工具软件的冰冷感。
                    </li>
                    <li>
                      <b>英文名「XyNote」</b>：简洁 6 字母，<code>Xy</code> 既对应 XiaoYue 首字母，又像坐标系的 X-Y 轴，暗合软件的块级结构与多维表格特性。
                    </li>
                  </ul>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">官方信息与技术支持</div>
                  <div className="nb-storage-kv-grid">
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">官方网站</span>
                      <a
                        className="nb-storage-kv-val"
                        href="https://fwpt.cn/"
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          if (isTauri) {
                            e.preventDefault();
                            openExternalUrl("https://fwpt.cn/").catch(() => {});
                          }
                        }}
                      >
                        https://fwpt.cn/
                      </a>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">联系与技术支持</span>
                      <a
                        className="nb-storage-kv-val"
                        href="mailto:admin@fwpt.cn"
                        onClick={(e) => {
                          if (isTauri) {
                            e.preventDefault();
                            openExternalUrl("mailto:admin@fwpt.cn").catch(() => {});
                          }
                        }}
                      >
                        admin@fwpt.cn
                      </a>
                    </div>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">运行环境与存储诊断摘要</div>
                  <div className="nb-storage-kv-grid">
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">桌面引擎版本</span>
                      <span className="nb-storage-kv-val">
                        v{__APP_VERSION__} (
                        {isTauri
                          ? "Tauri v2 Native + Rust SQLite WAL/FTS5"
                          : "Browser Preview LocalStorage Engine"}
                        )
                      </span>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">软件运行目录 (exeDir)</span>
                      <code className="nb-storage-kv-val">
                        {info?.exeDir ?? "C:\\XyNote"}
                      </code>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">当前主数据库路径</span>
                      <code className="nb-storage-kv-val">
                        {info?.dbFilePath ?? ".\\XyNote-data\\xynote.db"}
                      </code>
                    </div>
                    <div className="nb-storage-kv-item">
                      <span className="nb-storage-kv-key">工作区数据统计</span>
                      <span className="nb-storage-kv-val">
                        {info?.pageCount ?? 0} 篇活跃页面 · {info?.blockCount ?? 0} 个内容块 ·
                        数据库大小 {formatBytes(info?.dbSizeBytes ?? 0)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="nb-settings-card-box">
                  <div className="nb-settings-label">核心架构特性</div>
                  <ul className="nb-about-list">
                    <li>
                      <b>绿色便携即拷即用</b>：默认在软件同级目录自动初始化{" "}
                      <code>XyNote-data\</code>（含 SQLite、Markdown 镜像、<code>plugins\</code> 样式插件库与滚动快照）。
                    </li>
                    <li>
                      <b>可定制主题工坊与全量快捷键录制</b>：内置 5 套精选主题与 5 款可叠加 CSS 样式增强插件，支持 51 项块级与全局快捷键实时录制及冲突检测。
                    </li>
                    <li>
                      <b>块级编辑 + Markdown 双剑合璧</b>：同时具备 18 种块级组件（含原生 Mermaid 图表与 KaTeX 公式）、三视图数据库以及所见即所得 / 源码 / 分屏三态切换。
                    </li>
                    <li>
                      <b>隐私优先架构</b>：全部笔记与图片 100% 本地离线存储、免登录即用；仅做可选的匿名设备去重计数，绝不上传任何笔记内容，可在上方随时关闭。
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** 界面语言：中文 / English / 跟随系统 */
function UiLanguageCard() {
  const [pref, setPref] = React.useState<UiLangPref>(() => getUiLangPref());
  const options: { id: UiLangPref; label: string; sub: string }[] = [
    { id: "zh", label: "简体中文", sub: "Chinese" },
    { id: "en", label: "English", sub: "英文" },
    { id: "system", label: "跟随系统", sub: "System" },
  ];
  return (
    <div className="nb-settings-card-box">
      <div className="nb-settings-label">界面语言 / Language</div>
      <div className="nb-theme-cards-grid">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`nb-choice-card${pref === o.id ? " is-selected" : ""}`}
            onClick={() => {
              setPref(o.id);
              setUiLangPref(o.id);
            }}
          >
            <div className="nb-choice-title" data-i18n-skip={o.id === "system" ? undefined : ""}>
              {o.label}
            </div>
            <div className="nb-choice-desc" data-i18n-skip="">
              {o.sub}
            </div>
          </button>
        ))}
      </div>
      <div className="nb-settings-sub">笔记内容不会被翻译，只切换界面文字。</div>
    </div>
  );
}
