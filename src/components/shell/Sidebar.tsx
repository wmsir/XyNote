import React, { useEffect, useMemo, useRef, useState } from "react";
import { isSvgIcon, PageIcon } from "../../icons/pageIcon";
import {
  ChevronRight,
  Copy,
  Database,
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Page, WorkspaceFolder } from "../../types/notion";
import { XyLogoIcon } from "./XyLogoIcon";
import { FolderTree } from "./FolderTree";

export interface RecentLocalMdItem {
  filePath: string;
  fileName: string;
  title: string;
}

export interface SidebarProps {
  pages: Page[];
  activePageId: string | null;
  activeLocalMdPath: string | null;
  recentLocalMdFiles: RecentLocalMdItem[];
  collapsed: boolean;
  trashedCount: number;
  isTauri: boolean;
  onToggleCollapse: () => void;
  onSelectPage: (pageId: string) => void;
  onOpenLocalMdDialog: () => void;
  onCreateLocalMdFile: () => void;
  onSelectLocalMdFile: (filePath: string) => void;
  onRemoveRecentLocalMdFile: (filePath: string) => void;
  onCreateDoc: (parentId?: string | null) => void;
  onCreateDatabase: (parentId?: string | null) => void;
  onDuplicatePage: (pageId: string) => void;
  onToggleFavorite: (page: Page) => void;
  onTrashPage: (pageId: string) => void;
  onExportMarkdown: (pageId: string) => void;
  onOpenSearch: () => void;
  onOpenTemplates: () => void;
  onOpenTrash: () => void;
  onOpenImportMarkdown: () => void;
  onOpenSettings: () => void;
  /** 侧栏挂载的磁盘文件夹 */
  workspaceFolders: WorkspaceFolder[];
  onAddWorkspaceFolder: () => void;
  onRemoveWorkspaceFolder: (path: string) => void;
  onFolderEntryRenamed: (oldPath: string, newPath: string) => void;
  onBeforeFolderRename: () => Promise<void>;
  onFolderEntryRemoved: (path: string) => void;
  notify: (message: string, durationMs?: number) => void;
}

const SIDEBAR_WIDTH_KEY = "xynote.sidebarWidth";
const SIDEBAR_DEFAULT = 256;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

const DEFAULT_DOC_ICONS = new Set(["", "📄"]);
const DEFAULT_DB_ICONS = new Set(["", "📄", "🗃️"]);

/** Renders the unified left glyph for a workspace doc or database page. */
const PageNodeGlyph: React.FC<{ page: Page }> = ({ page }) => {
  const isDb = page.pageType === "database";
  const rawIcon = (page.icon ?? "").trim();
  const hasCustomEmoji = isDb
    ? !DEFAULT_DB_ICONS.has(rawIcon)
    : !DEFAULT_DOC_ICONS.has(rawIcon);

  if (isSvgIcon(rawIcon)) {
    return (
      <span className="nb-tree-emoji-wrap">
        <PageIcon icon={rawIcon} size={16} strokeWidth={1.7} className="nb-tree-glyph-svg" />
        {isDb && (
          <span className="nb-tree-db-corner" aria-hidden="true">
            <Database size={8} strokeWidth={2.2} />
          </span>
        )}
      </span>
    );
  }

  if (isDb) {
    if (!hasCustomEmoji) {
      return (
        <Database size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
      );
    }
    return (
      <span className="nb-tree-emoji-wrap">
        <span className="nb-tree-emoji">{rawIcon}</span>
        <span className="nb-tree-db-corner" aria-hidden="true">
          <Database size={8} strokeWidth={2.2} />
        </span>
      </span>
    );
  }

  if (!hasCustomEmoji) {
    return (
      <FileText size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
    );
  }

  return <span className="nb-tree-emoji">{rawIcon}</span>;
};

export const Sidebar: React.FC<SidebarProps> = ({
  pages,
  activePageId,
  activeLocalMdPath,
  recentLocalMdFiles,
  collapsed,
  trashedCount,
  isTauri,
  onToggleCollapse,
  onSelectPage,
  onOpenLocalMdDialog,
  onCreateLocalMdFile,
  onSelectLocalMdFile,
  onRemoveRecentLocalMdFile,
  onCreateDoc,
  onCreateDatabase,
  onDuplicatePage,
  onToggleFavorite,
  onTrashPage,
  onExportMarkdown,
  onOpenSearch,
  onOpenTemplates,
  onOpenTrash,
  onOpenImportMarkdown,
  onOpenSettings,
  workspaceFolders,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder,
  onFolderEntryRenamed,
  onBeforeFolderRename,
  onFolderEntryRemoved,
  notify,
}) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({
    "page-welcome": true,
  });
  const [favOpen, setFavOpen] = useState(true);
  const [wsOpen, setWsOpen] = useState(true);
  const [localMdOpen, setLocalMdOpen] = useState(true);
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const [resizing, setResizing] = useState(false);

  const applyWidth = (w: number, persist: boolean) => {
    const next = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
    setWidth(next);
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      } catch {
        // 忽略
      }
    }
  };

  /** 拖动右边缘调整侧栏宽度 */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
    let latest = width;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      latest = ev.clientX - left;
      applyWidth(latest, false);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      setResizing(false);
      applyWidth(latest, true);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const [menuState, setMenuState] = useState<{
    page: Page;
    top: number;
    left: number;
  } | null>(null);

  const sidebarRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const childrenMap = useMemo(() => {
    const map = new Map<string | null, Page[]>();
    const pageSet = new Set(pages.map((p) => p.id));
    for (const p of pages) {
      const normalizedParent =
        p.parentId && pageSet.has(p.parentId) ? p.parentId : null;
      const list = map.get(normalizedParent) ?? [];
      list.push(p);
      map.set(normalizedParent, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
      );
    }
    return map;
  }, [pages]);

  // Auto-expand ancestor chain (and active parent page if it has children)
  useEffect(() => {
    if (!activePageId) return;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const toExpand: string[] = [];
    if ((childrenMap.get(activePageId)?.length ?? 0) > 0) {
      toExpand.push(activePageId);
    }
    let cur = byId.get(activePageId);
    const guard = new Set<string>();
    while (cur && cur.parentId && !guard.has(cur.id)) {
      guard.add(cur.id);
      toExpand.push(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    if (toExpand.length > 0) {
      setExpandedIds((prev) => {
        const next = { ...prev };
        for (const id of toExpand) next[id] = true;
        return next;
      });
    }
  }, [activePageId, pages, childrenMap]);

  // Keep newly created / selected page or local file visible inside its scroll container
  useEffect(() => {
    if (collapsed || !sidebarRef.current) return;
    const timer = window.setTimeout(() => {
      const activeEl = sidebarRef.current?.querySelector(
        ".nb-tree-row.is-active"
      ) as HTMLElement | null;
      activeEl?.scrollIntoView({ block: "nearest" });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [activePageId, activeLocalMdPath, collapsed, pages.length]);

  useEffect(() => {
    if (!menuState) return;
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuState(null);
      }
    };
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [menuState]);

  const favorites = useMemo(() => pages.filter((p) => p.isFavorite), [pages]);
  const rootPages = childrenMap.get(null) ?? [];
  const hasLocalMdFiles = recentLocalMdFiles.length > 0;

  const toggleExpand = (e: React.MouseEvent, pageId: string) => {
    e.stopPropagation();
    setExpandedIds((prev) => ({ ...prev, [pageId]: !prev[pageId] }));
  };

  const openRowMenu = (e: React.MouseEvent, page: Page) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - 230);
    const left = Math.min(rect.left, window.innerWidth - 235);
    setMenuState({ page, top, left });
  };

  const renderTreeNode = (page: Page, depth: number): React.ReactNode => {
    const kids = childrenMap.get(page.id) ?? [];
    const hasChildren = kids.length > 0;
    const isExpanded = Boolean(expandedIds[page.id]);
    const isActive = !activeLocalMdPath && page.id === activePageId;
    const isMenuOpen = menuState?.page.id === page.id;

    return (
      <div key={page.id}>
        <div
          className={`nb-tree-row${isActive ? " is-active" : ""}${
            isMenuOpen ? " menu-open" : ""
          }`}
          style={{ paddingLeft: `${8 + depth * 15}px` }}
          onClick={() => onSelectPage(page.id)}
          title={page.title || "无标题"}
        >
          <div
            className={`nb-tree-leading${hasChildren ? " is-expandable" : ""}`}
          >
            <span className="nb-tree-glyph">
              <PageNodeGlyph page={page} />
            </span>

            {hasChildren && (
              <button
                type="button"
                className={`nb-tree-chevron-btn${
                  isExpanded ? " is-expanded" : ""
                }`}
                onClick={(e) => toggleExpand(e, page.id)}
                title={isExpanded ? "折叠子页面" : "展开子页面"}
                aria-label={isExpanded ? "折叠子页面" : "展开子页面"}
                aria-expanded={isExpanded}
              >
                <ChevronRight size={16} strokeWidth={1.6} />
              </button>
            )}
          </div>

          <span className="nb-tree-title">{page.title || "无标题"}</span>

          <div className="nb-tree-actions">
            <button
              type="button"
              className="nb-tree-action-btn"
              title="更多操作"
              aria-label="更多操作"
              onClick={(e) => openRowMenu(e, page)}
            >
              <MoreHorizontal size={16} strokeWidth={1.6} />
            </button>
            <button
              type="button"
              className="nb-tree-action-btn"
              title="新建子页面"
              aria-label="在此页面下新建子页面"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedIds((prev) => ({ ...prev, [page.id]: true }));
                onCreateDoc(page.id);
              }}
            >
              <Plus size={16} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        {isExpanded && hasChildren && (
          <div>{kids.map((child) => renderTreeNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className={`nb-sidebar${collapsed ? " is-collapsed" : ""}${resizing ? " is-resizing" : ""}`}
      style={collapsed ? undefined : { width, minWidth: width, maxWidth: width }}
    >
      {/* Workspace Brand Header */}
      <div className="nb-sidebar-workspace">
        <div className="nb-workspace-brand">
          <XyLogoIcon size={22} />
          <div className="nb-workspace-title-wrap">
            <span className="nb-workspace-name">小悦 (XyNote)</span>
            <span className="nb-workspace-sub">
              {`v${__APP_VERSION__}`}{isTauri ? "" : " · 浏览器预览"}
            </span>
          </div>
        </div>

        <div className="nb-sidebar-top-actions">
          <button
            type="button"
            className="nb-icon-btn"
            onClick={() => onCreateDoc(null)}
            title="新建页面 (Ctrl+N)"
            aria-label="新建页面"
          >
            <SquarePen size={16} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className="nb-icon-btn"
            onClick={onToggleCollapse}
            title="收起侧边栏 (Ctrl+Shift+L)"
            aria-label="收起侧边栏"
          >
            <PanelLeftClose size={16} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="nb-sidebar-quick">
        <button
          type="button"
          className="nb-sidebar-item"
          onClick={onOpenSearch}
          title="全局搜索与命令面板 (Ctrl+K)"
        >
          <Search size={16} strokeWidth={1.6} />
          <span className="nb-sidebar-item-label">搜索</span>
          <kbd className="nb-kbd">Ctrl+K</kbd>
        </button>

        <button
          type="button"
          className="nb-sidebar-item"
          onClick={onOpenTemplates}
          title="打开模板中心"
        >
          <Sparkles size={16} strokeWidth={1.6} />
          <span className="nb-sidebar-item-label">模板中心</span>
        </button>

        <button
          type="button"
          className="nb-sidebar-item"
          onClick={onOpenSettings}
          title="打开偏好设置 (Ctrl+,)"
        >
          <Settings size={16} strokeWidth={1.6} />
          <span className="nb-sidebar-item-label">偏好设置</span>
          <kbd className="nb-kbd">Ctrl+,</kbd>
        </button>
      </div>

      {/* Scrollable Workspace Tree Sections (Favorites + Workspace Pages) */}
      <div className="nb-sidebar-scroll">
        {favorites.length > 0 && (
          <div className="nb-sidebar-section">
            <div className="nb-sidebar-section-header">
              <button
                type="button"
                className="nb-sidebar-section-toggle"
                onClick={() => setFavOpen((v) => !v)}
                aria-expanded={favOpen}
              >
                <ChevronRight
                  size={16}
                  strokeWidth={1.6}
                  className={`nb-section-chevron${
                    favOpen ? " is-expanded" : ""
                  }`}
                />
                <span>收藏夹</span>
              </button>
            </div>

            {favOpen &&
              favorites.map((fav) => (
                <div
                  key={`fav-${fav.id}`}
                  className={`nb-tree-row${
                    !activeLocalMdPath && fav.id === activePageId
                      ? " is-active"
                      : ""
                  }`}
                  style={{ paddingLeft: "8px" }}
                  onClick={() => onSelectPage(fav.id)}
                  title={fav.title || "无标题"}
                >
                  <div className="nb-tree-leading">
                    <span className="nb-tree-glyph">
                      <PageNodeGlyph page={fav} />
                    </span>
                  </div>
                  <span className="nb-tree-title">{fav.title || "无标题"}</span>
                  <div className="nb-tree-actions">
                    <button
                      type="button"
                      className="nb-tree-action-btn"
                      title="取消收藏"
                      aria-label="取消收藏"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(fav);
                      }}
                    >
                      <Star size={16} strokeWidth={1.6} fill="currentColor" />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* 工作区：页面、数据库和打开的磁盘文件夹都在这里 */}
        <div className="nb-sidebar-section nb-ws-section">
          <div className="nb-sidebar-section-header nb-ws-header">
            <button
              type="button"
              className="nb-sidebar-section-toggle"
              onClick={() => setWsOpen((v) => !v)}
              aria-expanded={wsOpen}
            >
              <ChevronRight
                size={16}
                strokeWidth={1.6}
                className={`nb-section-chevron${wsOpen ? " is-expanded" : ""}`}
              />
              <span>工作区</span>
            </button>

            <div className="nb-section-actions nb-ws-actions">
              <button
                type="button"
                className="nb-section-action-btn is-lg"
                title="新建页面 (Ctrl+N)：保存在小悦笔记里，可同步"
                aria-label="新建页面"
                onClick={() => onCreateDoc(null)}
              >
                <Plus size={19} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="nb-section-action-btn is-lg"
                title="新建多维数据库：表格、看板、画廊"
                aria-label="新建多维数据库"
                onClick={() => onCreateDatabase(null)}
              >
                <Database size={18} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="nb-section-action-btn is-lg"
                title={
                  isTauri && workspaceFolders.length > 0
                    ? "新建 Markdown 文件：直接建在打开的文件夹里"
                    : "新建 Markdown 文件：保存在电脑上的 .md 文件，需要选择存放位置（先打开一个文件夹就不用每次选）"
                }
                aria-label="新建 Markdown 文件"
                onClick={onCreateLocalMdFile}
              >
                <FilePlus2 size={18} strokeWidth={1.7} />
              </button>
              {isTauri && (
                <button
                  type="button"
                  className="nb-section-action-btn is-lg"
                  title="打开文件夹"
                  aria-label="打开文件夹"
                  onClick={onAddWorkspaceFolder}
                >
                  <FolderPlus size={18} strokeWidth={1.7} />
                </button>
              )}
            </div>
          </div>

          {wsOpen && (
            <>
              {rootPages.map((page) => renderTreeNode(page, 0))}

              {workspaceFolders.length > 0 && (
                <FolderTree
                  folders={workspaceFolders}
                  activeFilePath={activeLocalMdPath}
                  isTauri={isTauri}
                  embedded
                  onAddFolder={onAddWorkspaceFolder}
                  onRemoveFolder={onRemoveWorkspaceFolder}
                  onOpenFile={onSelectLocalMdFile}
                  onEntryRenamed={onFolderEntryRenamed}
                  onBeforeRename={onBeforeFolderRename}
                  onEntryRemoved={onFolderEntryRemoved}
                  notify={notify}
                />
              )}

              {rootPages.length === 0 && workspaceFolders.length === 0 && !hasLocalMdFiles && (
                <div className="nb-tree-empty">
                  点上方的 + 新建页面{isTauri ? "，或打开一个放笔记的文件夹" : ""}
                </div>
              )}

              {/* 最近打开的单个 .md 文件 */}
              {hasLocalMdFiles && (
                <div className="nb-recent-files">
                  <button
                    type="button"
                    className="nb-recent-toggle"
                    onClick={() => setLocalMdOpen((v) => !v)}
                    aria-expanded={localMdOpen}
                  >
                    <ChevronRight
                      size={14}
                      strokeWidth={1.8}
                      className={`nb-section-chevron${localMdOpen ? " is-expanded" : ""}`}
                    />
                    <span>最近打开的文件</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="nb-recent-open"
                      title="打开文件 (Ctrl+O)"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenLocalMdDialog();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          onOpenLocalMdDialog();
                        }
                      }}
                    >
                      打开…
                    </span>
                  </button>
                  {localMdOpen &&
                    recentLocalMdFiles.slice(0, 8).map((item) => {
                      const isCurrent = activeLocalMdPath === item.filePath;
                      return (
                        <div
                          key={item.filePath}
                          className={`nb-tree-row${isCurrent ? " is-active" : ""}`}
                          style={{ paddingLeft: "8px" }}
                          onClick={() => onSelectLocalMdFile(item.filePath)}
                          title={item.filePath}
                        >
                          <div className="nb-tree-leading">
                            <span className="nb-tree-glyph">
                              <FileCode2 size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
                            </span>
                          </div>
                          <span className="nb-tree-title">{item.fileName || item.title}</span>
                          <div className="nb-tree-actions">
                            <button
                              type="button"
                              className="nb-tree-action-btn"
                              title="从最近列表移除"
                              aria-label="从最近列表移除"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemoveRecentLocalMdFile(item.filePath);
                              }}
                            >
                              <X size={16} strokeWidth={1.6} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bottom Utility Actions */}
      <div className="nb-sidebar-footer">
        <button
          type="button"
          className="nb-sidebar-item"
          onClick={onOpenImportMarkdown}
          title="批量导入 Markdown 文件夹或 Notion .zip 导出包"
        >
          <Upload size={16} strokeWidth={1.6} />
          <span className="nb-sidebar-item-label">导入 / 数据迁移</span>
        </button>

        <button
          type="button"
          className="nb-sidebar-item"
          onClick={onOpenTrash}
          title="查看已移至回收站的页面"
        >
          <Trash2 size={16} strokeWidth={1.6} />
          <span className="nb-sidebar-item-label">回收站</span>
          {trashedCount > 0 && (
            <span className="nb-trash-count">{trashedCount}</span>
          )}
        </button>
      </div>

      {/* Context Menu Popover */}
      {menuState && (
        <div
          ref={menuRef}
          className="nb-popover"
          style={{
            position: "fixed",
            top: `${menuState.top}px`,
            left: `${menuState.left}px`,
          }}
        >
          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              onToggleFavorite(menuState.page);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Star size={14} />
              {menuState.page.isFavorite ? "取消收藏" : "加入收藏夹"}
            </span>
          </button>

          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              setExpandedIds((prev) => ({ ...prev, [menuState.page.id]: true }));
              onCreateDoc(menuState.page.id);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <FileText size={14} />
              新建子文档
            </span>
          </button>

          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              setExpandedIds((prev) => ({ ...prev, [menuState.page.id]: true }));
              onCreateDatabase(menuState.page.id);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Database size={14} />
              新建子数据库
            </span>
          </button>

          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              onDuplicatePage(menuState.page.id);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Copy size={14} />
              复制页面副本
            </span>
          </button>

          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              onExportMarkdown(menuState.page.id);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Download size={14} />
              导出 Markdown
            </span>
          </button>

          <div className="nb-menu-divider" />

          <button
            type="button"
            className="nb-menu-item is-danger"
            onClick={() => {
              onTrashPage(menuState.page.id);
              setMenuState(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Trash2 size={14} />
              移至回收站
            </span>
          </button>
        </div>
      )}
      {!collapsed && (
        <div
          className="nb-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={width}
          tabIndex={0}
          title="拖动调整宽度，双击恢复默认"
          onPointerDown={startResize}
          onDoubleClick={() => applyWidth(SIDEBAR_DEFAULT, true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") applyWidth(width - 16, true);
            if (e.key === "ArrowRight") applyWidth(width + 16, true);
          }}
        />
      )}
    </aside>
  );
};
