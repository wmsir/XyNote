import React, { useEffect, useRef, useState } from "react";
import { PageIcon } from "../../icons/pageIcon";
import {
  AlignCenter,
  BookOpen,
  Columns2,
  Copy,
  Lock,
  LockOpen,
  Download,
  Eye,
  FileCode2,
  FileInput,
  FileText,
  FileType2,
  Globe,
  History,
  Image as ImageIcon,
  ListTree,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Network,
  PanelLeftOpen,
  Printer,
  Save,
  Search,
  Sigma,
  Star,
  Target,
  Trash2,
  LayoutTemplate,
  AppWindow,
} from "lucide-react";
import { ThemeQuickPicker, type ThemeQuickPickerProps } from "./ThemeQuickPicker";
import { WindowControls } from "./WindowControls";
import type {
  BreadcrumbItem,
  EditorViewMode,
  LocalMarkdownDocument,
  Page,
} from "../../types/notion";

/** 页面导出格式 */
export type ExportFormat = "md" | "html" | "pdf" | "docx" | "epub" | "png" | "latex" | "opml";

export type ThemeMode = "light" | "dark" | "sepia";
export type FontStyleMode = "sans" | "serif" | "mono" | "custom";

export interface TopbarProps {
  page: Page | null;
  activeLocalMd: LocalMarkdownDocument | null;
  /** 文本编辑器里打开的文件；有值时顶栏只显示文件名 */
  textFile?: { filePath: string; fileName: string } | null;
  breadcrumbs: BreadcrumbItem[];
  sidebarCollapsed: boolean;
  isSaving: boolean;
  /** 旧接口保留：主题现在由 themeControl 控制 */
  theme?: ThemeMode;
  fontStyle: FontStyleMode;
  customFontName?: string | null;
  fullWidth: boolean;
  viewMode: EditorViewMode;
  focusMode: boolean;
  typewriterMode: boolean;
  showOutline: boolean;
  zenMode: boolean;
  onToggleSidebar: () => void;
  onNavigatePage: (pageId: string) => void;
  onToggleFavorite: () => void;
  onChangeTheme?: (theme: ThemeMode) => void;
  onChangeFontStyle: (font: FontStyleMode) => void;
  onToggleFullWidth: () => void;
  onSetFullWidth?: (adaptive: boolean) => void;
  onChangeViewMode: (mode: EditorViewMode) => void;
  onToggleFocusMode: () => void;
  onToggleTypewriterMode: () => void;
  onToggleOutline: () => void;
  onToggleZenMode: () => void;
  onOpenSettings?: () => void;
  onOpenFontSettings?: () => void;
  onOpenLocalMdDialog?: () => void;
  onSaveImmediate: () => void;
  onSaveAsMarkdown: () => void;
  onImportLocalMdToWorkspace: () => void;
  onDuplicatePage: () => void;
  onExportMarkdown: () => void;
  /** 当前页面是否锁定（防误改） */
  pageLocked?: boolean;
  onToggleLock?: () => void;
  /** 发布为网页 */
  onOpenPublish?: () => void;
  /** 导出：html / pdf / docx */
  onExportAs?: (format: ExportFormat) => void;
  /** 在新窗口中打开当前页面 */
  onOpenInNewWindow?: () => void;
  onOpenHistory: () => void;
  /** 把当前页面存为自定义模板 */
  onSaveAsTemplate?: () => void;
  onOpenImportMarkdown?: () => void;
  onTrashPage: () => void;
  onOpenSearch: () => void;
  /** 顶栏「外观」按钮：主题快速切换 */
  themeControl?: ThemeQuickPickerProps;
  kbEnabled?: boolean;
  showKbPanel?: boolean;
  onToggleKbPanel?: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  page,
  activeLocalMd,
  textFile = null,
  breadcrumbs,
  sidebarCollapsed,
  isSaving,
  fontStyle,
  customFontName = null,
  fullWidth,
  viewMode,
  focusMode,
  typewriterMode,
  showOutline,
  zenMode,
  onToggleSidebar,
  onNavigatePage,
  onToggleFavorite,
  onChangeFontStyle,
  onToggleFullWidth,
  onSetFullWidth,
  onChangeViewMode,
  onToggleFocusMode,
  onToggleTypewriterMode,
  onToggleOutline,
  onToggleZenMode,
  onOpenFontSettings,
  onSaveImmediate,
  onSaveAsMarkdown,
  onImportLocalMdToWorkspace,
  onDuplicatePage,
  pageLocked = false,
  onToggleLock,
  onOpenPublish,
  onExportMarkdown,
  onExportAs,
  onOpenInNewWindow,
  onOpenHistory,
  onSaveAsTemplate,
  onTrashPage,
  onOpenSearch,
  themeControl,
  kbEnabled = false,
  showKbPanel = false,
  onToggleKbPanel,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  const isDocMode = !textFile && Boolean(activeLocalMd || (page && page.pageType === "doc"));

  return (
    <header className={`nb-topbar${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`} data-tauri-drag-region>
      <div className="nb-topbar-left" data-tauri-drag-region>
        {sidebarCollapsed && (
          <button
            type="button"
            className="nb-icon-btn"
            onClick={onToggleSidebar}
            title="展开侧边栏 (Ctrl+Shift+L)"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {textFile ? (
          <div className="nb-local-md-bar">
            <span className="nb-local-md-badge" title="直接编辑磁盘上的文件">文本文件</span>
            <span className="nb-local-md-filename" title={textFile.filePath}>
              {textFile.fileName}
            </span>
          </div>
        ) : activeLocalMd ? (
          <div className="nb-local-md-bar">
            <span className="nb-local-md-badge" title="直接编辑磁盘上的文件，保存即写回">磁盘文件</span>
            <span
              className="nb-local-md-filename"
              title={activeLocalMd.filePath}
            >
              {activeLocalMd.fileName}
            </span>
          </div>
        ) : (
          page && (
            <nav className="nb-breadcrumbs" aria-label="页面路径" data-tauri-drag-region>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <React.Fragment key={crumb.id}>
                    {index > 0 && <span className="nb-breadcrumb-sep">/</span>}
                    <button
                      type="button"
                      className={`nb-breadcrumb-item${isLast ? " is-current" : ""}`}
                      onClick={() => onNavigatePage(crumb.id)}
                      title={crumb.title || "无标题"}
                    >
                      <PageIcon icon={isLast ? page.icon : crumb.icon} size={15} />
                      <span>
                        {(isLast ? page.title : crumb.title) || "无标题"}
                      </span>
                    </button>
                  </React.Fragment>
                );
              })}
            </nav>
          )
        )}
      </div>

      <div className="nb-topbar-right" data-tauri-drag-region>
        {isDocMode && (
          <>
            {/* Segmented Typora View Mode Switcher */}
            <div
              className="nb-typora-switcher"
              role="group"
              aria-label="编辑视图切换"
            >
              <button
                type="button"
                className={`nb-typora-seg${
                  viewMode === "wysiwyg" ? " is-active" : ""
                }`}
                onClick={() => onChangeViewMode("wysiwyg")}
                title="所见即所得富文本视图 (Ctrl+/)"
              >
                <Eye size={12} />
                <span>所见即所得</span>
              </button>
              <button
                type="button"
                className={`nb-typora-seg${
                  viewMode === "source" ? " is-active" : ""
                }`}
                onClick={() => onChangeViewMode("source")}
                title="Markdown 纯源码视图 (Ctrl+/)"
              >
                <FileCode2 size={12} />
                <span>源码</span>
              </button>
              <button
                type="button"
                className={`nb-typora-seg${
                  viewMode === "split" ? " is-active" : ""
                }`}
                onClick={() => onChangeViewMode("split")}
                title="左右分屏实时预览"
              >
                <Columns2 size={12} />
                <span>分屏</span>
              </button>
            </div>

            {/* Quick Immersion Toggles */}
            <button
              type="button"
              className={`nb-icon-btn${showOutline ? " is-mode-on" : ""}`}
              onClick={onToggleOutline}
              title="大纲目录 TOC (Ctrl+Shift+1)"
            >
              <ListTree size={15} />
            </button>

            <span className="nb-topbar-divider" />
          </>
        )}

        {kbEnabled && onToggleKbPanel && (
          <button
            type="button"
            className={`nb-icon-btn${showKbPanel ? " is-mode-on" : ""}`}
            onClick={onToggleKbPanel}
            title="关联知识面板"
          >
            <Network size={15} />
          </button>
        )}

        {!textFile && (page || activeLocalMd) && (
          <span className="nb-save-pill" title="实时本地持久化">
            <span className={`nb-save-dot${isSaving ? " is-saving" : ""}`} />
            {isSaving ? "保存中..." : "已保存"}
          </span>
        )}

        <button
          type="button"
          className="nb-icon-btn"
          onClick={onOpenSearch}
          title="全局搜索 (Ctrl+K)"
        >
          <Search size={16} />
        </button>

        {themeControl && <ThemeQuickPicker {...themeControl} />}

        {page && !activeLocalMd && !textFile && (
          <button
            type="button"
            className={`nb-icon-btn${page.isFavorite ? " is-active" : ""}`}
            onClick={onToggleFavorite}
            title={page.isFavorite ? "取消收藏" : "加入收藏夹"}
          >
            <Star size={16} fill={page.isFavorite ? "currentColor" : "none"} />
          </button>
        )}

        {!textFile && (page || activeLocalMd) && (
          <div ref={menuWrapRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="nb-icon-btn"
              onClick={() => setMenuOpen((v) => !v)}
              title="页面排版与更多操作"
            >
              <MoreHorizontal size={17} />
            </button>

            {menuOpen && (
              <div
                className="nb-popover"
                style={{ right: 0, top: "32px", width: "256px" }}
              >
                {activeLocalMd && (
                  <>
                    <div className="nb-menu-label">磁盘文件</div>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onSaveImmediate();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Save size={14} /> 立即保存
                      </span>
                      <kbd className="nb-menu-kbd">Ctrl+S</kbd>
                    </button>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onSaveAsMarkdown();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Download size={14} /> 另存为…
                      </span>
                      <kbd className="nb-menu-kbd">Ctrl+Shift+S</kbd>
                    </button>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onImportLocalMdToWorkspace();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <FileInput size={14} /> 复制一份到工作区页面
                      </span>
                    </button>
                    <div className="nb-menu-divider" />
                  </>
                )}

                {isDocMode && (
                  <>
                    <div className="nb-menu-label">写作模式</div>
                    <button type="button" className="nb-menu-item" onClick={onToggleFocusMode}>
                      <span className="nb-menu-item-left">
                        <Target size={14} /> 专注模式
                      </span>
                      <span className="nb-menu-check">{focusMode ? "✓" : <kbd className="nb-menu-kbd">F8</kbd>}</span>
                    </button>
                    <button type="button" className="nb-menu-item" onClick={onToggleTypewriterMode}>
                      <span className="nb-menu-item-left">
                        <AlignCenter size={14} /> 打字机居中
                      </span>
                      <span className="nb-menu-check">{typewriterMode ? "✓" : <kbd className="nb-menu-kbd">F9</kbd>}</span>
                    </button>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onToggleZenMode();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        {zenMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />} 禅模式
                      </span>
                      <span className="nb-menu-check">{zenMode ? "✓" : <kbd className="nb-menu-kbd">F11</kbd>}</span>
                    </button>
                    <div className="nb-menu-divider" />
                  </>
                )}

                <div className="nb-menu-label">字体风格</div>
                <div className="nb-font-switcher">
                  <button
                    type="button"
                    className={`nb-font-option nb-font-sans${
                      fontStyle === "sans" ? " is-active" : ""
                    }`}
                    onClick={() => onChangeFontStyle("sans")}
                  >
                    <span className="nb-font-option-sample">Ag</span>
                    <span className="nb-font-option-name">默认</span>
                  </button>
                  <button
                    type="button"
                    className={`nb-font-option nb-font-serif${
                      fontStyle === "serif" ? " is-active" : ""
                    }`}
                    onClick={() => onChangeFontStyle("serif")}
                  >
                    <span className="nb-font-option-sample">Ag</span>
                    <span className="nb-font-option-name">衬线体</span>
                  </button>
                  <button
                    type="button"
                    className={`nb-font-option nb-font-mono${
                      fontStyle === "mono" ? " is-active" : ""
                    }`}
                    onClick={() => onChangeFontStyle("mono")}
                  >
                    <span className="nb-font-option-sample">Ag</span>
                    <span className="nb-font-option-name">等宽</span>
                  </button>
                  <button
                    type="button"
                    className={`nb-font-option nb-font-custom${
                      fontStyle === "custom" ? " is-active" : ""
                    }`}
                    title={
                      customFontName
                        ? `启用自定义字体：${customFontName}`
                        : "点击前往设置字体文件路径或官网教程"
                    }
                    onClick={() => {
                      if (!customFontName && onOpenFontSettings) {
                        onOpenFontSettings();
                        setMenuOpen(false);
                      } else {
                        onChangeFontStyle("custom");
                      }
                    }}
                  >
                    <span className="nb-font-option-sample">字</span>
                    <span className="nb-font-option-name">自定义</span>
                  </button>
                </div>
                {onOpenFontSettings && (
                  <button
                    type="button"
                    className="nb-topbar-font-config-link"
                    onClick={() => {
                      onOpenFontSettings();
                      setMenuOpen(false);
                    }}
                  >
                    {customFontName
                      ? `管理自定义字体（当前：${customFontName}）…`
                      : "配置本地字体路径 / 教程…"}
                  </button>
                )}

                {isDocMode && (
                  <>
                    <div className="nb-menu-divider" />
                    <div className="nb-menu-label">页面版心布局</div>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        if (onSetFullWidth) onSetFullWidth(true);
                        else if (!fullWidth) onToggleFullWidth();
                      }}
                    >
                      <span className="nb-menu-item-left">
                        自适应窗口宽度
                        <span className="nb-rec-tag">默认开启</span>
                      </span>
                      {fullWidth && <span>✓</span>}
                    </button>
                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        if (onSetFullWidth) onSetFullWidth(false);
                        else if (fullWidth) onToggleFullWidth();
                      }}
                    >
                      <span className="nb-menu-item-left">居中阅读版心 (960px)</span>
                      {!fullWidth && <span>✓</span>}
                    </button>
                  </>
                )}

                {(page || activeLocalMd) && onExportAs && (
                  <>
                    <div className="nb-menu-divider" />
                    <div className="nb-menu-label-row">
                      <span className="nb-menu-label" style={{ padding: 0 }}>导出此页</span>
                      <span className="nb-menu-item-hint">8 种格式</span>
                    </div>
                    <div className="nb-menu-export-grid">
                      {(
                        [
                          { id: "pdf", name: "PDF", ext: ".pdf", icon: <Printer size={13} /> },
                          { id: "opml", name: "思维导图", ext: ".opml", icon: <ListTree size={13} /> },
                          { id: "docx", name: "Word", ext: ".docx", icon: <FileType2 size={13} /> },
                          { id: "md", name: "Markdown", ext: ".md", icon: <FileText size={13} /> },
                          { id: "html", name: "网页", ext: ".html", icon: <Globe size={13} /> },
                          { id: "png", name: "图片", ext: ".png", icon: <ImageIcon size={13} /> },
                          { id: "epub", name: "电子书", ext: ".epub", icon: <BookOpen size={13} /> },
                          { id: "latex", name: "LaTeX", ext: ".tex", icon: <Sigma size={13} /> },
                        ] as { id: ExportFormat; name: string; ext: string; icon: React.ReactNode }[]
                      ).map((fmt) => (
                        <button
                          key={fmt.id}
                          type="button"
                          className="nb-menu-export-chip"
                          title={`导出为 ${fmt.name} (${fmt.ext})`}
                          onClick={() => {
                            onExportAs(fmt.id);
                            setMenuOpen(false);
                          }}
                        >
                          <span className="nb-menu-export-chip-icon">{fmt.icon}</span>
                          <span className="nb-menu-export-chip-name">{fmt.name}</span>
                          <span className="nb-menu-export-chip-ext" data-i18n-skip="">{fmt.ext}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {page && !activeLocalMd && (
                  <>
                    <div className="nb-menu-divider" />

                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onDuplicatePage();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Copy size={14} /> 复制页面副本
                      </span>
                    </button>

                    {onOpenPublish && (
                      <button
                        type="button"
                        className="nb-menu-item"
                        onClick={() => {
                          onOpenPublish();
                          setMenuOpen(false);
                        }}
                      >
                        <span className="nb-menu-item-left">
                          <Globe size={14} />
                          发布为网页…
                        </span>
                      </button>
                    )}

                    {onToggleLock && (
                      <button
                        type="button"
                        className="nb-menu-item"
                        onClick={() => {
                          onToggleLock();
                          setMenuOpen(false);
                        }}
                      >
                        <span className="nb-menu-item-left">
                          {pageLocked ? <LockOpen size={14} /> : <Lock size={14} />}
                          {pageLocked ? "解锁页面" : "锁定页面（防误改）"}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onOpenHistory();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <History size={14} /> 历史版本
                      </span>
                    </button>

                    {onOpenInNewWindow && page && !activeLocalMd && (
                      <button
                        type="button"
                        className="nb-menu-item"
                        onClick={() => {
                          onOpenInNewWindow();
                          setMenuOpen(false);
                        }}
                      >
                        <span className="nb-menu-item-left">
                          <AppWindow size={14} /> 在新窗口中打开
                        </span>
                      </button>
                    )}

                    {onSaveAsTemplate && page && !activeLocalMd && (
                      <button
                        type="button"
                        className="nb-menu-item"
                        onClick={() => {
                          onSaveAsTemplate();
                          setMenuOpen(false);
                        }}
                      >
                        <span className="nb-menu-item-left">
                          <LayoutTemplate size={14} /> 存为模板
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onExportMarkdown();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Download size={14} /> 更多导出与源码…
                      </span>
                    </button>

                    <div className="nb-menu-divider" />

                    <button
                      type="button"
                      className="nb-menu-item is-danger"
                      onClick={() => {
                        onTrashPage();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Trash2 size={14} /> 移至回收站
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <WindowControls />
    </header>
  );
};
