import React, { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  BookOpen,
  Columns2,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileInput,
  FolderOpen,
  History,
  ListTree,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelLeftOpen,
  Save,
  Search,
  Settings,
  Star,
  Sun,
  Target,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  BreadcrumbItem,
  EditorViewMode,
  LocalMarkdownDocument,
  Page,
} from "../../types/notion";

export type ThemeMode = "light" | "dark" | "sepia";
export type FontStyleMode = "sans" | "serif" | "mono";

export interface TopbarProps {
  page: Page | null;
  activeLocalMd: LocalMarkdownDocument | null;
  /** 文本编辑器里打开的文件；有值时顶栏只显示文件名 */
  textFile?: { filePath: string; fileName: string } | null;
  breadcrumbs: BreadcrumbItem[];
  sidebarCollapsed: boolean;
  isSaving: boolean;
  theme: ThemeMode;
  fontStyle: FontStyleMode;
  fullWidth: boolean;
  viewMode: EditorViewMode;
  focusMode: boolean;
  typewriterMode: boolean;
  showOutline: boolean;
  zenMode: boolean;
  onToggleSidebar: () => void;
  onNavigatePage: (pageId: string) => void;
  onToggleFavorite: () => void;
  onChangeTheme: (theme: ThemeMode) => void;
  onChangeFontStyle: (font: FontStyleMode) => void;
  onToggleFullWidth: () => void;
  onSetFullWidth?: (adaptive: boolean) => void;
  onChangeViewMode: (mode: EditorViewMode) => void;
  onToggleFocusMode: () => void;
  onToggleTypewriterMode: () => void;
  onToggleOutline: () => void;
  onToggleZenMode: () => void;
  onOpenSettings: () => void;
  onOpenLocalMdDialog: () => void;
  onSaveImmediate: () => void;
  onSaveAsMarkdown: () => void;
  onImportLocalMdToWorkspace: () => void;
  onDuplicatePage: () => void;
  onExportMarkdown: () => void;
  /** 导出：html / pdf / docx */
  onExportAs: (format: "html" | "pdf" | "docx") => void;
  onOpenHistory: () => void;
  onOpenImportMarkdown: () => void;
  onTrashPage: () => void;
  onOpenSearch: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  page,
  activeLocalMd,
  textFile = null,
  breadcrumbs,
  sidebarCollapsed,
  isSaving,
  theme,
  fontStyle,
  fullWidth,
  viewMode,
  focusMode,
  typewriterMode,
  showOutline,
  zenMode,
  onToggleSidebar,
  onNavigatePage,
  onToggleFavorite,
  onChangeTheme,
  onChangeFontStyle,
  onToggleFullWidth,
  onSetFullWidth,
  onChangeViewMode,
  onToggleFocusMode,
  onToggleTypewriterMode,
  onToggleOutline,
  onToggleZenMode,
  onOpenSettings,
  onOpenLocalMdDialog,
  onSaveImmediate,
  onSaveAsMarkdown,
  onImportLocalMdToWorkspace,
  onDuplicatePage,
  onExportMarkdown,
  onExportAs,
  onOpenHistory,
  onOpenImportMarkdown,
  onTrashPage,
  onOpenSearch,
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
    <header className="nb-topbar">
      <div className="nb-topbar-left">
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
            <nav className="nb-breadcrumbs" aria-label="页面路径">
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
                      <span>{isLast ? page.icon : crumb.icon || "📄"}</span>
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

      <div className="nb-topbar-right">
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
                </div>

                <div className="nb-menu-divider" />

                <div className="nb-menu-label">外观主题</div>
                <button
                  type="button"
                  className="nb-menu-item"
                  onClick={() => onChangeTheme("light")}
                >
                  <span className="nb-menu-item-left">
                    <Sun size={14} /> 浅色纸面 (#FFFFFF)
                  </span>
                  {theme === "light" && <span>✓</span>}
                </button>
                <button
                  type="button"
                  className="nb-menu-item"
                  onClick={() => onChangeTheme("dark")}
                >
                  <span className="nb-menu-item-left">
                    <Moon size={14} /> 深色夜间 (#191919)
                  </span>
                  {theme === "dark" && <span>✓</span>}
                </button>
                <button
                  type="button"
                  className="nb-menu-item"
                  onClick={() => onChangeTheme("sepia")}
                >
                  <span className="nb-menu-item-left">
                    <BookOpen size={14} /> 护眼暖色 (#FBF7EE)
                  </span>
                  {theme === "sepia" && <span>✓</span>}
                </button>

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

                <div className="nb-menu-divider" />

                <button
                  type="button"
                  className="nb-menu-item"
                  onClick={() => {
                    onOpenLocalMdDialog();
                    setMenuOpen(false);
                  }}
                >
                  <span className="nb-menu-item-left">
                    <FolderOpen size={14} /> 打开 .md 文件… (Ctrl+O)
                  </span>
                </button>

                <button
                  type="button"
                  className="nb-menu-item"
                  onClick={() => {
                    onOpenSettings();
                    setMenuOpen(false);
                  }}
                >
                  <span className="nb-menu-item-left">
                    <Settings size={14} /> 偏好设置中心 (Ctrl+,)
                  </span>
                </button>

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

                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onExportMarkdown();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Download size={14} /> 导出 Markdown
                      </span>
                    </button>

                    {(
                      [
                        ["html", "导出 HTML"],
                        ["pdf", "导出 PDF"],
                        ["docx", "导出 Word"],
                      ] as const
                    ).map(([fmt, label]) => (
                      <button
                        key={fmt}
                        type="button"
                        className="nb-menu-item"
                        onClick={() => {
                          onExportAs(fmt);
                          setMenuOpen(false);
                        }}
                      >
                        <span className="nb-menu-item-left">
                          <Download size={14} /> {label}
                        </span>
                      </button>
                    ))}

                    <button
                      type="button"
                      className="nb-menu-item"
                      onClick={() => {
                        onOpenImportMarkdown();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="nb-menu-item-left">
                        <Upload size={14} /> 导入 Markdown
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
    </header>
  );
};
