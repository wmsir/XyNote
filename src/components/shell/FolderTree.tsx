import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  createFolderEntry,
  listFolderEntries,
  moveFolderEntry,
  openPathInExplorer,
  renameFolderEntry,
  trashFolderEntry,
} from "../../api/client";
import { openWithSystemApp } from "../../api/textfile";
import type { FolderEntry, WorkspaceFolder } from "../../types/notion";

/**
 * 侧栏「文件夹」：把磁盘上的多个文件夹以树形结构挂在侧栏。
 * - 逐层按需读取，展开状态记在本机；窗口重新获得焦点时刷新已展开的目录；
 * - 显示子文件夹和全部文件：Markdown 用块编辑器打开，文本和代码用文本编辑器打开，其他文件交给系统程序；
 * - 支持新建笔记、新建文件夹、重命名、在文件管理器中显示、复制路径、移除根文件夹。
 */

export interface FolderTreeProps {
  folders: WorkspaceFolder[];
  activeFilePath: string | null;
  isTauri: boolean;
  /** 嵌在「工作区」里：没有文件夹时不显示占位 */
  embedded?: boolean;
  onAddFolder: () => void;
  onRemoveFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** 文件或文件夹改名后通知外层：正在编辑的文件需要换成新路径 */
  onEntryRenamed: (oldPath: string, newPath: string) => void;
  /** 改名前先把正在编辑的内容写回磁盘，避免写到旧路径 */
  onBeforeRename: () => Promise<void>;
  /** 文件或文件夹被移到回收站后通知外层：正在编辑的文件需要关闭 */
  onEntryRemoved: (path: string) => void;
  /** 挂载的根文件夹在磁盘上改名后，让外层更新侧栏里记录的路径；不传则根文件夹不能改名 */
  onRootRenamed?: (oldPath: string, newPath: string, newName: string) => void;
  /** 外部（全局快捷键）请求重命名某个文件：展开它所在的文件夹并出现输入框 */
  renameRequest?: { path: string; nonce: number } | null;
  notify: (message: string, durationMs?: number) => void;
}

interface Listing {
  entries: FolderEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

type EditState =
  | { kind: "rename"; path: string; isDir: boolean; parent: string; value: string; isRoot?: boolean }
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
const INITIAL_VISIBLE = 100;
const LOAD_MORE_STEP = 200;

function LoadMoreSentinel({
  depth,
  shown,
  total,
  onMore,
  onShowAll,
}: {
  depth: number;
  shown: number;
  total: number;
  onMore: () => void;
  onShowAll: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const triggeredForShownRef = useRef(-1);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && triggeredForShownRef.current !== shown) {
          triggeredForShownRef.current = shown;
          onMore();
        }
      },
      { rootMargin: "160px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onMore, shown]);

  return (
    <div
      ref={sentinelRef}
      className="nb-folder-hint"
      style={{ paddingLeft: `${30 + depth * 14}px`, flexWrap: "wrap" }}
    >
      <span>{`已显示 ${shown} / 共 ${total} 项`}</span>
      <button type="button" className="nb-folder-link" onClick={onMore}>
        加载更多
      </button>
      <button type="button" className="nb-folder-link" onClick={onShowAll}>
        显示全部
      </button>
    </div>
  );
}

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

/** Markdown 笔记显示时去掉 .md 一类的扩展名，其他文件保留扩展名以示区别 */
function displayName(entry: FolderEntry): string {
  if (entry.isDir) return entry.name;
  if (entry.kind === "note" && entry.ext) {
    return entry.name.slice(0, entry.name.length - entry.ext.length - 1) || entry.name;
  }
  return entry.name;
}

function FileGlyph({ entry }: { entry: FolderEntry }) {
  if (entry.kind === "note") return <FileText size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />;
  if (entry.kind === "text") return <FileCode2 size={16} strokeWidth={1.6} className="nb-tree-glyph-svg" />;
  return <File size={16} strokeWidth={1.6} className="nb-tree-glyph-svg is-other" />;
}

/** 路径统一成「/」分隔、去掉末尾分隔符、小写，用于比较 */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** dir 是否在 root 里（含 root 本身）；兼容盘符根目录「D:\」 */
function isUnder(dir: string, root: string): boolean {
  const d = normPath(dir);
  const r = normPath(root);
  return d === r || d.startsWith(r.endsWith("/") ? r : r + "/");
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
  embedded,
  onAddFolder,
  onRemoveFolder,
  onOpenFile,
  onEntryRenamed,
  onBeforeRename,
  onEntryRemoved,
  onRootRenamed,
  renameRequest,
  notify,
}) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [visibleLimits, setVisibleLimits] = useState<Record<string, number>>({});
  const [edit, setEdit] = useState<EditState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  // 拖拽：正在拖动的条目与当前悬停的目标文件夹
  const dragRef = useRef<{ path: string; parent: string; isDir: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const inFlightRef = useRef<Set<string>>(new Set());
  const lastLoadedAtRef = useRef<Record<string, number>>({});
  const fsTimersRef = useRef<Map<string, number>>(new Map());

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
    const key = normPath(dir);
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    lastLoadedAtRef.current[key] = Date.now();
    if (!quiet || !listingsRef.current[dir]) {
      setListings((prev) => ({
        ...prev,
        [dir]: {
          entries: prev[dir]?.entries ?? [],
          truncated: prev[dir]?.truncated ?? false,
          error: null,
          loading: !quiet || !prev[dir],
        },
      }));
    }
    try {
      const res = await listFolderEntries(dir);
      lastLoadedAtRef.current[key] = Date.now();
      const apply = () =>
        setListings((prev) => ({
          ...prev,
          [dir]: { entries: res.entries, truncated: res.truncated, error: null, loading: false },
        }));
      if (res.entries.length > 80) {
        React.startTransition(apply);
      } else {
        apply();
      }
    } catch (err) {
      setListings((prev) => ({
        ...prev,
        [dir]: { entries: [], truncated: false, error: errText(err), loading: false },
      }));
    } finally {
      inFlightRef.current.delete(key);
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
        const underRoot = folders.some((f) => isUnder(dir, f.path));
        if (underRoot) void load(dir);
      }
    });
  }, [expanded, folders, isTauri, load]);

  // 磁盘监听：变化路径所在的目录（以及变化的目录本身）若已读取过，按 350ms 防抖静默刷新
  useEffect(() => {
    if (!isTauri) return;
    const timers = fsTimersRef.current;
    const onChanged = (e: Event) => {
      const paths = (e as CustomEvent<string[]>).detail ?? [];
      const loaded = Object.keys(listingsRef.current);
      const targets = new Set<string>();
      paths.forEach((p) => {
        const np = normPath(p);
        const parent = np.slice(0, Math.max(np.lastIndexOf("/"), 0));
        loaded.forEach((dir) => {
          const nd = normPath(dir);
          if (nd === parent || nd === np) targets.add(dir);
        });
      });
      targets.forEach((dir) => {
        const prevTimer = timers.get(dir);
        if (prevTimer !== undefined) window.clearTimeout(prevTimer);
        const timer = window.setTimeout(() => {
          timers.delete(dir);
          void load(dir, true);
        }, 350);
        timers.set(dir, timer);
      });
    };
    window.addEventListener("xynote:fs-changed", onChanged);
    return () => {
      window.removeEventListener("xynote:fs-changed", onChanged);
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, [isTauri, load]);

  // 回到窗口时静默刷新已展开的目录；刚加载过（< 5 秒，如关闭选择文件夹弹窗时）直接跳过
  useEffect(() => {
    if (!isTauri) return;
    const onFocus = () => {
      const now = Date.now();
      Object.keys(listingsRef.current).forEach((dir) => {
        if (!expandedRef.current[dir]) return;
        const lastAt = lastLoadedAtRef.current[normPath(dir)] ?? 0;
        if (now - lastAt < 5000) return;
        void load(dir, true);
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
    const nextOpen = force ?? !expandedRef.current[dir];
    if (!nextOpen) {
      setVisibleLimits((prev) => {
        if (prev[dir] === undefined) return prev;
        const next = { ...prev };
        delete next[dir];
        return next;
      });
    }
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

  // 侧栏顶部「新建 .md 文件」：在指定文件夹里就地输入名称
  const startCreateRef = useRef(startCreate);
  startCreateRef.current = startCreate;
  useEffect(() => {
    if (!isTauri) return;
    const onNew = (e: Event) => {
      const parent = (e as CustomEvent<{ parent: string }>).detail?.parent;
      if (!parent || !folders.some((f) => isUnder(parent, f.path))) return;
      e.preventDefault();
      // 一路展开到目标文件夹
      setExpanded((prev) => {
        const next = { ...prev };
        folders.forEach((f) => {
          if (!isUnder(parent, f.path)) return;
          const sep = f.path.includes("\\") ? "\\" : "/";
          const rest = parent.slice(f.path.replace(/[\\/]+$/, "").length).split(/[\\/]/).filter(Boolean);
          let cur = f.path.replace(/[\\/]+$/, "");
          next[f.path] = true;
          rest.forEach((seg) => {
            cur = cur + sep + seg;
            next[cur] = true;
          });
        });
        persistExpanded(next);
        return next;
      });
      startCreateRef.current(parent, "new-file");
    };
    window.addEventListener("xynote:folder-new-file", onNew);
    return () => window.removeEventListener("xynote:folder-new-file", onNew);
  }, [folders, isTauri, persistExpanded]);

  // 全局快捷键请求重命名当前打开的文件：展开它所在的各级文件夹，再出现输入框
  useEffect(() => {
    if (!renameRequest) return;
    const target = renameRequest.path;
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const root = folders.find((f) => norm(target).startsWith(norm(f.path) + "/"));
    if (!root) return;
    const sep = target.includes("\\") ? "\\" : "/";
    const rel = target.slice(root.path.replace(/[\\/]+$/, "").length + 1).split(/[\\/]/);
    const name = rel.pop() || "";
    let dir = root.path.replace(/[\\/]+$/, "");
    const chain = [dir];
    for (const part of rel) {
      dir = dir + sep + part;
      chain.push(dir);
    }
    for (const d of chain) toggle(d, true);
    setEdit({ kind: "rename", path: target, isDir: false, parent: chain[chain.length - 1], value: name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest?.nonce]);

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
        if (current.isRoot) {
          // 根文件夹改名：它和里面所有子文件夹的展开状态都换到新路径下
          const oldNorm = current.path.replace(/\\/g, "/").toLowerCase();
          const sep = entry.path.includes("\\") ? "\\" : "/";
          setExpanded((prev) => {
            const next: Record<string, boolean> = {};
            for (const [k, v] of Object.entries(prev as Record<string, boolean>)) {
              const kn = k.replace(/\\/g, "/").toLowerCase();
              if (kn === oldNorm) next[entry.path] = v;
              else if (kn.startsWith(oldNorm + "/")) next[entry.path + sep + k.slice(current.path.length + 1)] = v;
              else next[k] = v;
            }
            persistExpanded(next);
            return next;
          });
          onRootRenamed?.(current.path, entry.path, entry.name);
          onEntryRenamed(current.path, entry.path);
          return;
        }
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


  const moveInto = async (targetDir: string) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (!drag || samePath(drag.parent, targetDir) || samePath(drag.path, targetDir)) return;
    try {
      await onBeforeRename();
      const moved = await moveFolderEntry(drag.path, targetDir);
      await Promise.all([load(drag.parent, true), load(targetDir, true)]);
      toggle(targetDir, true);
      onEntryRenamed(drag.path, moved.path);
      notify(`已移动到「${targetDir.split(/[\\/]/).pop()}」`);
    } catch (err) {
      notify(errText(err), 3600);
    }
  };

  const dropHandlers = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const drag = dragRef.current;
      if (!drag || samePath(drag.path, dir) || samePath(drag.parent, dir)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropTarget !== dir) setDropTarget(dir);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
        setDropTarget((cur) => (cur === dir ? null : cur));
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void moveInto(dir);
    },
  });

  const moveToTrash = async (m: MenuState) => {
    setMenu(null);
    setConfirmTrash(false);
    try {
      await onBeforeRename();
      await trashFolderEntry(m.path);
      await load(m.parent, true);
      onEntryRemoved(m.path);
      notify(`已将「${m.name}」移到回收站`);
    } catch (err) {
      notify(errText(err), 3600);
    }
  };

  const openMenu = (e: React.MouseEvent, m: Omit<MenuState, "top" | "left">) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmTrash(false);
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
          aria-label={edit.kind === "rename" ? "新名称" : isDir ? "文件夹名称" : "文件名（不写扩展名时为 .md 笔记）"}
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
    const totalCount = dirs.length + files.length;
    const limit = visibleLimits[dir] ?? INITIAL_VISIBLE;
    const visibleDirs = dirs.slice(0, limit);
    const remainingSlots = Math.max(0, limit - visibleDirs.length);
    const visibleFiles = files.slice(0, remainingSlots);
    const visibleCount = visibleDirs.length + visibleFiles.length;

    return (
      <>
        {creatingHere?.kind === "new-dir" && renderEditRow(depth, true)}
        {visibleDirs.map((entry) => renderEntry(entry, dir, depth))}
        {creatingHere?.kind === "new-file" && renderEditRow(depth, false)}
        {visibleFiles.map((entry) => renderEntry(entry, dir, depth))}
        {listing.entries.length === 0 && !creatingHere && (
          <div className="nb-folder-hint" style={{ paddingLeft: `${30 + depth * 14}px` }}>
            空文件夹
          </div>
        )}
        {totalCount > visibleCount && (
          <LoadMoreSentinel
            depth={depth}
            shown={visibleCount}
            total={totalCount}
            onMore={() =>
              React.startTransition(() => {
                setVisibleLimits((prev) => ({
                  ...prev,
                  [dir]: (prev[dir] ?? INITIAL_VISIBLE) + LOAD_MORE_STEP,
                }));
              })
            }
            onShowAll={() =>
              React.startTransition(() => {
                setVisibleLimits((prev) => ({ ...prev, [dir]: totalCount }));
              })
            }
          />
        )}
        {listing.truncated && totalCount <= visibleCount && (
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
          className={`nb-tree-row nb-folder-row${isActive ? " is-active" : ""}${menuOpen ? " menu-open" : ""}${
            entry.isDir && dropTarget === entry.path ? " is-drop-target" : ""
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          title={entry.path}
          tabIndex={0}
          draggable
          onDragStart={(e) => {
            dragRef.current = { path: entry.path, parent, isDir: entry.isDir };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", entry.path);
          }}
          onDragEnd={() => {
            dragRef.current = null;
            setDropTarget(null);
          }}
          {...(entry.isDir ? dropHandlers(entry.path) : dropHandlers(parent))}
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
                <FileGlyph entry={entry} />
              )}
            </span>
          </div>
          <span className={`nb-tree-title${entry.kind === "other" ? " is-other" : ""}`}>{displayName(entry)}</span>
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

  if (embedded && (!isTauri || folders.length === 0)) return null;

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
          <FolderOpen size={15} strokeWidth={1.6} />
          <span>打开文件夹</span>
        </button>
      )}

      {folders.map((root) => {
        const isOpen = Boolean(expanded[root.path]);
        const listing = listings[root.path];
        const menuOpen = menu ? samePath(menu.path, root.path) : false;
        const renamingRoot = edit?.kind === "rename" && edit.isRoot && samePath(edit.path, root.path);
        return (
          <div key={root.path} className="nb-folder-root" role="treeitem" aria-expanded={isOpen}>
            {renamingRoot ? renderEditRow(0, true) : (
            <div
              {...dropHandlers(root.path)}
              className={`nb-tree-row nb-folder-root-row${menuOpen ? " menu-open" : ""}${
                dropTarget === root.path ? " is-drop-target" : ""
              }`}
              style={{ paddingLeft: "8px" }}
              title={root.path}
              tabIndex={0}
              onClick={() => toggle(root.path)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter") toggle(root.path);
                else if (e.key === "F2" && onRootRenamed && isTauri) {
                  e.preventDefault();
                  setEdit({ kind: "rename", path: root.path, isDir: true, parent: "", value: root.name, isRoot: true });
                }
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
            )}
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
          {!menu.isDir && (
            <button
              type="button"
              className="nb-menu-item"
              onClick={() => {
                openWithSystemApp(menu.path).catch((err) => notify(errText(err), 3200));
                setMenu(null);
              }}
            >
              <span className="nb-menu-item-left">
                <AppWindow size={14} />
                用系统默认程序打开
              </span>
            </button>
          )}
          {(!menu.isRoot || (onRootRenamed && isTauri)) && (
            <button
              type="button"
              className="nb-menu-item"
              onClick={() => {
                setEdit({ kind: "rename", path: menu.path, isDir: menu.isDir, parent: menu.parent, value: menu.name, isRoot: menu.isRoot });
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
          {!menu.isRoot && (
            <>
              <div className="nb-menu-divider" />
              <button
                type="button"
                className="nb-menu-item is-danger"
                onClick={() => {
                  if (!confirmTrash) setConfirmTrash(true);
                  else void moveToTrash(menu);
                }}
              >
                <span className="nb-menu-item-left">
                  <Trash2 size={14} />
                  {confirmTrash ? "再点一次确认移到回收站" : "移到回收站"}
                </span>
              </button>
            </>
          )}
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
