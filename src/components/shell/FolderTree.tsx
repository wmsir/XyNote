import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import {
  createFolderEntry,
  listFolderEntries,
  openPathInExplorer,
  renameFolderEntry,
} from "../../api/client";
import type { FolderEntry, WorkspaceFolder } from "../../types/notion";

/**
 * 侧栏「文件夹」：把磁盘上的多个文件夹以树形结构挂在侧栏。
 * - 逐层按需读取，展开状态记在本机；窗口重新获得焦点时刷新已展开的目录；
 * - 只显示子文件夹与笔记文件（.md / .txt 等），点击笔记直接在编辑器里打开磁盘文件；
 * - 支持新建笔记、新建文件夹、重命名、在文件管理器中显示、复制路径、移除根文件夹。
 */

export interface FolderTreeProps {
  folders: WorkspaceFolder[];
  activeFilePath: string | null;
  isTauri: boolean;
  onAddFolder: () => void;
  onRemoveFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** 文件或文件夹改名后通知外层：正在编辑的文件需要换成新路径 */
  onEntryRenamed: (oldPath: string, newPath: string) => void;
  /** 改名前先把正在编辑的内容写回磁盘，避免写到旧路径 */
  onBeforeRename: () => Promise<void>;
  notify: (message: string, durationMs?: number) => void;
}

interface Listing {
  entries: FolderEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

type EditState =
  | { kind: "rename"; path: string; isDir: boolean; parent: string; value: string }
  | { kind: "new-file" | "new-dir"; parent: string; value: string }
  | null;

interface MenuState {
  path: string;
  isDir: boolean;
  isRoot: boolean;
  parent: string;
  name: string;
  top: number;
  left: number;
}

const EXPANDED_KEY = "xynote.folderTree.expanded";

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^(Not found|Validation error|IO error):\s*/i, "");
}

/** 笔记文件显示时去掉 .md 一类的扩展名，.txt 保留以示区别 */
function displayName(entry: FolderEntry): string {
  if (entry.isDir) return entry.name;
  if (entry.ext && entry.ext !== "txt") {
    return entry.name.slice(0, entry.name.length - entry.ext.length - 1) || entry.name;
  }
  return entry.name;
}

function samePath(a: string | null, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  // Windows / macOS 默认不区分大小写
  return x === y || x.toLowerCase() === y.toLowerCase();
}

export const FolderTree: React.FC<FolderTreeProps> = ({
  folders,
  activeFilePath,
  isTauri,
  onAddFolder,
  onRemoveFolder,
  onOpenFile,
  onEntryRenamed,
  onBeforeRename,
  notify,
}) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [edit, setEdit] = useState<EditState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const persistExpanded = useCallback((next: Record<string, boolean>) => {
    try {
      // 只记展开的，避免无限增长
      const compact: Record<string, boolean> = {};
      Object.keys(next).forEach((k) => {
        if (next[k]) compact[k] = true;
      });
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(compact));
    } catch {
      /* 存储不可用时忽略 */
    }
  }, []);

  const load = useCallback(async (dir: string, quiet = false) => {
    setListings((prev) => ({
      ...prev,
      [dir]: {
        entries: prev[dir]?.entries ?? [],
        truncated: prev[dir]?.truncated ?? false,
        error: null,
        loading: !quiet || !prev[dir],
      },
    }));
    try {
      const res = await listFolderEntries(dir);
      setListings((prev) => ({
        ...prev,
        [dir]: { entries: res.entries, truncated: res.truncated, error: null, loading: false },
      }));
    } catch (err) {
      setListings((prev) => ({
        ...prev,
        [dir]: { entries: [], truncated: false, error: errText(err), loading: false },
      }));
    }
  }, []);

  // 新挂载的根文件夹默认展开并读取
  useEffect(() => {
    if (!isTauri) return;
    folders.forEach((f) => {
      if (expandedRef.current[f.path] === undefined) {
        setExpanded((prev) => {
          const next = { ...prev, [f.path]: true };
          persistExpanded(next);
          return next;
        });
      }
    });
  }, [folders, isTauri, persistExpanded]);

  // 展开了但还没读过的目录：读取
  useEffect(() => {
    if (!isTauri) return;
    Object.keys(expanded).forEach((dir) => {
      if (expanded[dir] && !listingsRef.current[dir]) {
        const underRoot = folders.some(
          (f) => samePath(dir, f.path) || dir.replace(/\\/g, "/").startsWith(f.path.replace(/\\/g, "/") + "/")
        );
        if (underRoot) void load(dir);
      }
    });
  }, [expanded, folders, isTauri, load]);

  // 回到窗口时静默刷新已展开的目录，反映在文件管理器里做的改动
  useEffect(() => {
    if (!isTauri) return;
    const onFocus = () => {
      Object.keys(listingsRef.current).forEach((dir) => {
        if (expandedRef.current[dir]) void load(dir, true);
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isTauri, load]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const toggle = (dir: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = { ...prev, [dir]: force ?? !prev[dir] };
      persistExpanded(next);
      return next;
    });
  };

  const startCreate = (parent: string, kind: "new-file" | "new-dir") => {
    toggle(parent, true);
    if (!listingsRef.current[parent]) void load(parent);
    setEdit({ kind, parent, value: kind === "new-file" ? "未命名笔记" : "新建文件夹" });
    setMenu(null);
  };

  // 回车提交后输入框卸载可能再触发一次 blur，用标记避免重复新建 / 重命名
  const committingRef = useRef(false);
  const commitEdit = async () => {
    const current = edit;
    if (!current || committingRef.current) return;
    committingRef.current = true;
    setEdit(null);
    setTimeout(() => {
      committingRef.current = false;
    }, 0);
    const value = current.value.trim();
    try {
      if (current.kind === "rename") {
        if (!value) return;
        const oldName = current.path.split(/[\\/]/).pop() ?? "";
        if (value === oldName) return;
        await onBeforeRename();
        const entry = await renameFolderEntry(current.path, value);
        // 展开状态跟着新路径走
        setExpanded((prev) => {
          if (!prev[current.path]) return prev;
          const next = { ...prev, [entry.path]: true };
          delete next[current.path];
          persistExpanded(next);
          return next;
        });
        await load(current.parent, true);
        onEntryRenamed(current.path, entry.path);
      } else {
        if (!value) return;
        const entry = await createFolderEntry(current.parent, value, current.kind === "new-dir");
        await load(current.parent, true);
        if (entry.isDir) {
          toggle(entry.path, true);
        } else {
          onOpenFile(entry.path);
        }
      }
    } catch (err) {
      notify(errText(err), 3600);
    }
  };

  const openMenu = (e: React.MouseEvent, m: Omit<MenuState, "top" | "left">) => {
    e.preventDefault();
    e.stopPropagation();
    const top = Math.min(e.clientY + 4, window.innerHeight - 260);
    const left = Math.min(e.clientX, window.innerWidth - 230);
    setMenu({ ...m, top, left });
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify("已复制路径");
    } catch {
      notify("复制失败", 2400);
    }
  };

  const renderEditRow = (depth: number, isDir: boolean) => {
    if (!edit) return null;
    return (
      <div className="nb-tree-row nb-folder-edit-row" style={{ paddingLeft: `${8 + depth * 14}px` }}>
        <div className="nb-tree-leading">
          <span className="nb-tree-glyph">
            {isDir ? (
              <Folder size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
            ) : (
              <FileText size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
            )}
          </span>
        </div>
        <input
          className="nb-folder-input"
          autoFocus
          value={edit.value}
          spellCheck={false}
          aria-label={edit.kind === "rename" ? "新名称" : isDir ? "文件夹名称" : "笔记名称"}
          onFocus={(e) => {
            // 重命名文件时只选中文件名部分，不选扩展名
            const v = e.currentTarget.value;
            const dot = edit.kind === "rename" && !isDir ? v.lastIndexOf(".") : -1;
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
          }}
          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              committingRef.current = true;
              setEdit(null);
              setTimeout(() => {
                committingRef.current = false;
              }, 0);
            }
          }}
          onBlur={() => void commitEdit()}
        />
      </div>
    );
  };

  const renderChildren = (dir: string, depth: number): React.ReactNode => {
    const listing = listings[dir];
    const creatingHere = edit && edit.kind !== "rename" && samePath(edit.parent, dir) ? edit : null;
    if (!listing || (listing.loading && listing.entries.length === 0)) {
      return (
        <>
          {creatingHere && renderEditRow(depth, creatingHere.kind === "new-dir")}
          <div className="nb-folder-hint" style={{ paddingLeft: `${30 + depth * 14}px` }}>
            读取中…
          </div>
        </>
      );
    }
    if (listing.error) {
      return (
        <div className="nb-folder-hint is-error" style={{ paddingLeft: `${30 + depth * 14}px` }}>
          {listing.error}
          <button type="button" className="nb-folder-link" onClick={() => void load(dir)}>
            重试
          </button>
        </div>
      );
    }
    const dirs = listing.entries.filter((e) => e.isDir);
    const files = listing.entries.filter((e) => !e.isDir);
    return (
      <>
        {creatingHere?.kind === "new-dir" && renderEditRow(depth, true)}
        {dirs.map((entry) => renderEntry(entry, dir, depth))}
        {creatingHere?.kind === "new-file" && renderEditRow(depth, false)}
        {files.map((entry) => renderEntry(entry, dir, depth))}
        {listing.entries.length === 0 && !creatingHere && (
          <div className="nb-folder-hint" style={{ paddingLeft: `${30 + depth * 14}px` }}>
            没有笔记文件
          </div>
        )}
        {listing.truncated && (
          <div className="nb-folder-hint" style={{ paddingLeft: `${30 + depth * 14}px` }}>
            条目太多，只显示前 2000 项
          </div>
        )}
      </>
    );
  };

  const renderEntry = (entry: FolderEntry, parent: string, depth: number): React.ReactNode => {
    if (edit?.kind === "rename" && samePath(edit.path, entry.path)) {
      return <React.Fragment key={entry.path}>{renderEditRow(depth, entry.isDir)}</React.Fragment>;
    }
    const isOpen = Boolean(expanded[entry.path]);
    const isActive = !entry.isDir && samePath(activeFilePath, entry.path);
    const menuOpen = menu ? samePath(menu.path, entry.path) : false;
    const onActivate = () => (entry.isDir ? toggle(entry.path) : onOpenFile(entry.path));
    return (
      <div key={entry.path} role="treeitem" aria-expanded={entry.isDir ? isOpen : undefined}>
        <div
          className={`nb-tree-row nb-folder-row${isActive ? " is-active" : ""}${menuOpen ? " menu-open" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          title={entry.path}
          tabIndex={0}
          onClick={onActivate}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter") onActivate();
            else if (e.key === "F2") {
              e.preventDefault();
              setEdit({ kind: "rename", path: entry.path, isDir: entry.isDir, parent, value: entry.name });
            } else if (entry.isDir && e.key === "ArrowRight") toggle(entry.path, true);
            else if (entry.isDir && e.key === "ArrowLeft") toggle(entry.path, false);
          }}
          onContextMenu={(e) =>
            openMenu(e, { path: entry.path, isDir: entry.isDir, isRoot: false, parent, name: entry.name })
          }
        >
          <div className="nb-tree-leading">
            <span className="nb-tree-glyph">
              {entry.isDir ? (
                <ChevronRight
                  size={15}
                  strokeWidth={1.8}
                  className={`nb-tree-glyph-svg nb-folder-caret${isOpen ? " is-open" : ""}`}
                />
              ) : (
                <FileText size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
              )}
            </span>
          </div>
          <span className="nb-tree-title">{displayName(entry)}</span>
          <div className="nb-tree-actions">
            <button
              type="button"
              className="nb-tree-action-btn"
              title="更多操作"
              aria-label="更多操作"
              onClick={(e) =>
                openMenu(e, { path: entry.path, isDir: entry.isDir, isRoot: false, parent, name: entry.name })
              }
            >
              <MoreHorizontal size={16} strokeWidth={1.6} />
            </button>
            {entry.isDir && (
              <button
                type="button"
                className="nb-tree-action-btn"
                title="在此文件夹新建笔记"
                aria-label="在此文件夹新建笔记"
                onClick={(e) => {
                  e.stopPropagation();
                  startCreate(entry.path, "new-file");
                }}
              >
                <FilePlus2 size={15} strokeWidth={1.6} />
              </button>
            )}
          </div>
        </div>
        {entry.isDir && isOpen && <div role="group">{renderChildren(entry.path, depth + 1)}</div>}
      </div>
    );
  };

  if (!isTauri) {
    return (
      <div className="nb-folder-empty">
        <p>打开本地文件夹需要桌面客户端。</p>
      </div>
    );
  }

  return (
    <div className="nb-folder-tree" role="tree" aria-label="文件夹">
      {folders.length === 0 && (
        <button type="button" className="nb-folder-add-ghost" onClick={onAddFolder}>
          <FolderPlus size={15} strokeWidth={1.6} />
          <span>打开文件夹</span>
        </button>
      )}

      {folders.map((root) => {
        const isOpen = Boolean(expanded[root.path]);
        const listing = listings[root.path];
        const menuOpen = menu ? samePath(menu.path, root.path) : false;
        return (
          <div key={root.path} className="nb-folder-root" role="treeitem" aria-expanded={isOpen}>
            <div
              className={`nb-tree-row nb-folder-root-row${menuOpen ? " menu-open" : ""}`}
              style={{ paddingLeft: "8px" }}
              title={root.path}
              tabIndex={0}
              onClick={() => toggle(root.path)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && e.key === "Enter") toggle(root.path);
              }}
              onContextMenu={(e) =>
                openMenu(e, { path: root.path, isDir: true, isRoot: true, parent: "", name: root.name })
              }
            >
              <div className="nb-tree-leading">
                <span className="nb-tree-glyph">
                  {isOpen ? (
                    <FolderOpen size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
                  ) : (
                    <Folder size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />
                  )}
                </span>
              </div>
              <span className="nb-tree-title nb-folder-root-name">{root.name}</span>
              <div className="nb-tree-actions">
                <button
                  type="button"
                  className="nb-tree-action-btn"
                  title="更多操作"
                  aria-label="更多操作"
                  onClick={(e) =>
                    openMenu(e, { path: root.path, isDir: true, isRoot: true, parent: "", name: root.name })
                  }
                >
                  <MoreHorizontal size={16} strokeWidth={1.6} />
                </button>
                <button
                  type="button"
                  className="nb-tree-action-btn"
                  title="新建笔记"
                  aria-label="新建笔记"
                  onClick={(e) => {
                    e.stopPropagation();
                    startCreate(root.path, "new-file");
                  }}
                >
                  <FilePlus2 size={15} strokeWidth={1.6} />
                </button>
              </div>
            </div>
            {isOpen && (
              <div role="group">
                {listing?.error ? (
                  <div className="nb-folder-hint is-error" style={{ paddingLeft: "30px" }}>
                    {listing.error}
                    <button type="button" className="nb-folder-link" onClick={() => void load(root.path)}>
                      重试
                    </button>
                    <button type="button" className="nb-folder-link" onClick={() => onRemoveFolder(root.path)}>
                      移除
                    </button>
                  </div>
                ) : (
                  renderChildren(root.path, 1)
                )}
              </div>
            )}
          </div>
        );
      })}

      {menu && (
        <div
          ref={menuRef}
          className="nb-popover"
          role="menu"
          style={{ position: "fixed", top: `${menu.top}px`, left: `${menu.left}px` }}
        >
          {menu.isDir && (
            <>
              <button type="button" className="nb-menu-item" onClick={() => startCreate(menu.path, "new-file")}>
                <span className="nb-menu-item-left">
                  <FilePlus2 size={14} />
                  新建笔记
                </span>
              </button>
              <button type="button" className="nb-menu-item" onClick={() => startCreate(menu.path, "new-dir")}>
                <span className="nb-menu-item-left">
                  <FolderPlus size={14} />
                  新建文件夹
                </span>
              </button>
              <button
                type="button"
                className="nb-menu-item"
                onClick={() => {
                  void load(menu.path);
                  setMenu(null);
                }}
              >
                <span className="nb-menu-item-left">
                  <RefreshCw size={14} />
                  刷新
                </span>
              </button>
              <div className="nb-menu-divider" />
            </>
          )}
          {!menu.isRoot && (
            <button
              type="button"
              className="nb-menu-item"
              onClick={() => {
                setEdit({ kind: "rename", path: menu.path, isDir: menu.isDir, parent: menu.parent, value: menu.name });
                setMenu(null);
              }}
            >
              <span className="nb-menu-item-left">
                <Pencil size={14} />
                重命名
                <kbd className="nb-menu-kbd">F2</kbd>
              </span>
            </button>
          )}
          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              openPathInExplorer(menu.path).catch((err) => notify(errText(err), 3200));
              setMenu(null);
            }}
          >
            <span className="nb-menu-item-left">
              <ExternalLink size={14} />
              在文件管理器中显示
            </span>
          </button>
          <button
            type="button"
            className="nb-menu-item"
            onClick={() => {
              void copyPath(menu.path);
              setMenu(null);
            }}
          >
            <span className="nb-menu-item-left">
              <Copy size={14} />
              复制路径
            </span>
          </button>
          {menu.isRoot && (
            <>
              <div className="nb-menu-divider" />
              <button
                type="button"
                className="nb-menu-item"
                onClick={() => {
                  onRemoveFolder(menu.path);
                  setMenu(null);
                }}
              >
                <span className="nb-menu-item-left">
                  <X size={14} />
                  从侧栏移除（不删除文件）
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
