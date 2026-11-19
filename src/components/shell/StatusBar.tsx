import React from "react";
import {
  AlignCenter,
  Columns2,
  Eye,
  FileCode2,
  FileText,
  FolderOpen,
  ListTree,
  RefreshCw,
  CloudOff,
  Cloud,
  Target,
} from "lucide-react";
import type {
  DocumentStats,
  EditorPreferences,
  EditorViewMode,
  LocalMarkdownDocument,
  StorageConfigInfo,
} from "../../types/notion";
import { relativeTime, type SyncMode } from "../../api/sync";

export interface StatusBarSync {
  mode: SyncMode;
  syncing: boolean;
  lastAt: string | null;
  lastError: string | null;
}

export interface StatusBarProps {
  storageInfo: StorageConfigInfo | null;
  activeLocalMd: LocalMarkdownDocument | null;
  isDatabasePage: boolean;
  isSaving: boolean;
  stats: DocumentStats;
  editorPrefs: EditorPreferences;
  onOpenStorageSettings: () => void;
  onRevealActiveLocalMd: (filePath: string) => void;
  onToggleFocusMode: () => void;
  onToggleTypewriterMode: () => void;
  onToggleOutline: () => void;
  onCycleViewMode: () => void;
  sync?: StatusBarSync | null;
  onOpenSyncSettings?: () => void;
}

const VIEW_MODE_LABELS: Record<EditorViewMode, string> = {
  wysiwyg: "所见即所得",
  source: "源码模式",
  split: "分屏预览",
};

function shortenPathForBadge(fullPath: string, maxLen = 42): string {
  if (fullPath.length <= maxLen) return fullPath;
  const parts = fullPath.replace(/\//g, "\\").split("\\");
  if (parts.length <= 2) {
    return `${fullPath.slice(0, 18)}...${fullPath.slice(-18)}`;
  }
  const tail = parts.slice(-2).join("\\");
  return `${parts[0]}\\...\\${tail}`;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  storageInfo,
  activeLocalMd,
  isDatabasePage,
  isSaving,
  stats,
  editorPrefs,
  onOpenStorageSettings,
  onRevealActiveLocalMd,
  onToggleFocusMode,
  sync,
  onOpenSyncSettings,
  onToggleTypewriterMode,
  onToggleOutline,
  onCycleViewMode,
}) => {
  const viewMode: EditorViewMode = editorPrefs.viewMode ?? "wysiwyg";

  const storageLabel = storageInfo
    ? storageInfo.isDefaultPortableDir
      ? "便携目录 .\\data"
      : shortenPathForBadge(storageInfo.activeDataDir, 36)
    : "便携目录 .\\data";

  return (
    <footer className="nb-statusbar" role="contentinfo" aria-label="工作区状态栏">
      <div className="nb-statusbar-left">
        {activeLocalMd ? (
          <button
            type="button"
            className="nb-statusbar-item is-clickable is-highlight"
            onClick={() => onRevealActiveLocalMd(activeLocalMd.filePath)}
            title={`当前直编本地 Markdown 文件：${activeLocalMd.filePath}（点击定位）`}
          >
            <FileText size={12} />
            <span>📄 {shortenPathForBadge(activeLocalMd.filePath, 46)}</span>
          </button>
        ) : (
          <button
            type="button"
            className="nb-statusbar-item is-clickable"
            onClick={onOpenStorageSettings}
            title={`数据存储目录：${storageInfo?.activeDataDir ?? ".\\data"}（点击管理存储与路径）`}
          >
            <FolderOpen size={12} />
            <span>📁 {storageLabel}</span>
          </button>
        )}

        <span className="nb-statusbar-sep">·</span>

        <span className="nb-statusbar-item" title="本地持久化同步状态">
          <span className={`nb-save-dot${isSaving ? " is-saving" : ""}`} />
          <span>
            {isSaving
              ? "正在写入本地磁盘..."
              : activeLocalMd
              ? "本地 .md 实时直写"
              : storageInfo?.autoSyncMarkdown
              ? "本地 + .md 实时同步"
              : "已保存到本地"}
          </span>
        </span>

        {sync && sync.mode !== "local" && (
          <>
            <span className="nb-statusbar-sep">·</span>
            <button
              type="button"
              className={`nb-statusbar-item is-clickable${sync.lastError ? " is-sync-error" : ""}`}
              onClick={onOpenSyncSettings}
              title={sync.lastError ? `同步失败：${sync.lastError}` : "打开同步设置"}
            >
              {sync.syncing ? (
                <RefreshCw size={12} className="nb-spin" />
              ) : sync.lastError ? (
                <CloudOff size={12} />
              ) : (
                <Cloud size={12} />
              )}
              <span>
                {sync.syncing
                  ? "正在同步…"
                  : sync.lastError
                  ? "同步失败"
                  : `已同步 · ${relativeTime(sync.lastAt)}`}
              </span>
            </button>
          </>
        )}
      </div>

      <div className="nb-statusbar-right">
        {!isDatabasePage && (
          <>
            <button
              type="button"
              className={`nb-statusbar-pill${editorPrefs.focusMode ? " is-active" : ""}`}
              onClick={onToggleFocusMode}
              title="切换专注模式 (F8)"
            >
              <Target size={11} />
              <span>专注 F8</span>
            </button>

            <button
              type="button"
              className={`nb-statusbar-pill${
                editorPrefs.typewriterMode ? " is-active" : ""
              }`}
              onClick={onToggleTypewriterMode}
              title="切换打字机居中滚动模式 (F9)"
            >
              <AlignCenter size={11} />
              <span>打字机 F9</span>
            </button>

            <button
              type="button"
              className={`nb-statusbar-pill${editorPrefs.showOutline ? " is-active" : ""}`}
              onClick={onToggleOutline}
              title="显示或隐藏文档大纲目录 (Ctrl+Shift+1)"
            >
              <ListTree size={11} />
              <span>大纲</span>
            </button>

            <button
              type="button"
              className="nb-statusbar-pill is-mode"
              onClick={onCycleViewMode}
              title="切换编辑模式：所见即所得 / 源码 / 分屏 (Ctrl+/)"
            >
              {viewMode === "wysiwyg" && <Eye size={11} />}
              {viewMode === "source" && <FileCode2 size={11} />}
              {viewMode === "split" && <Columns2 size={11} />}
              <span>{VIEW_MODE_LABELS[viewMode]}</span>
            </button>

            <span className="nb-statusbar-sep">·</span>

            <span className="nb-statusbar-stats" title={`共 ${stats.lines} 行 · ${stats.blockCount} 个内容块`}>
              字数 {stats.words} · 字符 {stats.chars} · 约{" "}
              {Math.max(1, stats.readingMinutes || 1)} 分钟阅读
            </span>
          </>
        )}
      </div>
    </footer>
  );
};
