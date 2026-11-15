import React, { useEffect, useMemo, useRef, useState } from "react";
import { PageIcon } from "../../icons/pageIcon";
import {
  CornerDownLeft,
  Database,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Moon,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { searchFolderNotes, searchWorkspace } from "../../api/client";
import type { FolderSearchHit, SearchResult } from "../../types/notion";
import type { ThemeMode } from "./Topbar";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelectResult: (pageId: string, blockId: string | null) => void;
  onCreateDoc: () => void;
  onCreateDatabase: () => void;
  onOpenTemplates: () => void;
  onOpenTrash: () => void;
  onOpenSettings: () => void;
  onOpenLocalMdDialog: () => void;
  onCreateLocalMdFile: () => void;
  onToggleViewMode: () => void;
  onChangeTheme: (theme: ThemeMode) => void;
  /** 侧栏挂载的文件夹 [路径, 显示名]，一起参与搜索 */
  folderRoots?: Array<[string, string]>;
  onOpenFile?: (path: string) => void;
}

interface QuickActionItem {
  id: string;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  run: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onSelectResult,
  onCreateDoc,
  onCreateDatabase,
  onOpenTemplates,
  onOpenTrash,
  onOpenSettings,
  onOpenLocalMdDialog,
  onCreateLocalMdFile,
  onToggleViewMode,
  onChangeTheme,
  folderRoots = [],
  onOpenFile,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [fileHits, setFileHits] = useState<FolderSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const quickActions: QuickActionItem[] = useMemo(
    () => [
      {
        id: "act-new-doc",
        label: "新建空白文档页面",
        sublabel: "快速创建一篇新的空白文档 (Ctrl+N)",
        icon: <FilePlus2 size={16} />,
        run: () => {
          onClose();
          onCreateDoc();
        },
      },
      {
        id: "act-open-local-md",
        label: "打开本地 Markdown 文件直编",
        sublabel: "直接读写磁盘上的独立 .md 文件 (Ctrl+O)",
        icon: <FolderOpen size={16} />,
        run: () => {
          onClose();
          onOpenLocalMdDialog();
        },
      },
      {
        id: "act-new-local-md",
        label: "新建本地 .md 文件直编",
        sublabel: "选择磁盘路径新建独立 Markdown 文件并直接编辑",
        icon: <FilePlus2 size={16} />,
        run: () => {
          onClose();
          onCreateLocalMdFile();
        },
      },
      {
        id: "act-toggle-source",
        label: "切换 Markdown 源码 / 所见即所得视图",
        sublabel: "在富文本块画布与纯 Markdown 源码间无缝切换 (Ctrl+/)",
        icon: <FileCode2 size={16} />,
        run: () => {
          onClose();
          onToggleViewMode();
        },
      },
      {
        id: "act-settings",
        label: "打开偏好设置中心",
        sublabel: "管理便携存储目录、编辑器偏好、字号排版与自动备份 (Ctrl+,)",
        icon: <Settings size={16} />,
        run: () => {
          onClose();
          onOpenSettings();
        },
      },
      {
        id: "act-new-db",
        label: "新建多维数据库",
        sublabel: "包含表格、看板与画廊三视图的数据库",
        icon: <Database size={16} />,
        run: () => {
          onClose();
          onCreateDatabase();
        },
      },
      {
        id: "act-templates",
        label: "打开模板中心",
        sublabel: "从会议纪要、路线图、RFC 方案等精选模板开始",
        icon: <Sparkles size={16} />,
        run: () => {
          onClose();
          onOpenTemplates();
        },
      },
      {
        id: "act-trash",
        label: "查看回收站",
        sublabel: "还原或彻底清理已删除页面",
        icon: <Trash2 size={16} />,
        run: () => {
          onClose();
          onOpenTrash();
        },
      },
      {
        id: "act-theme-dark",
        label: "切换至深色模式",
        sublabel: "适合夜间沉浸写作 (#191919)",
        icon: <Moon size={16} />,
        run: () => {
          onChangeTheme("dark");
          onClose();
        },
      },
      {
        id: "act-theme-light",
        label: "切换至浅色模式",
        sublabel: "温润白纸阅读感 (#FFFFFF)",
        icon: <Sun size={16} />,
        run: () => {
          onChangeTheme("light");
          onClose();
        },
      },
    ],
    [
      onChangeTheme,
      onClose,
      onCreateDatabase,
      onCreateDoc,
      onOpenLocalMdDialog,
      onOpenSettings,
      onOpenTemplates,
      onOpenTrash,
      onToggleViewMode,
    ]
  );

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return quickActions.slice(0, 5);
    return quickActions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) || a.sublabel.toLowerCase().includes(q)
    );
  }, [query, quickActions]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchWorkspace(query)
        .then((res) => {
          if (!cancelled) {
            setResults(res);
            setActiveIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 65);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  // 文件夹里的笔记：输入停顿一下再搜，避免每敲一个字就扫一遍磁盘
  const rootsKey = JSON.stringify(folderRoots);
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q || folderRoots.length === 0) {
      setFileHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchFolderNotes(folderRoots, q)
        .then((hits) => {
          if (!cancelled) setFileHits(hits);
        })
        .catch(() => {
          if (!cancelled) setFileHits([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, rootsKey]);

  if (!open) return null;

  const totalItems = results.length + fileHits.length + filteredActions.length;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (totalItems === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + totalItems) % totalItems);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < results.length) {
        const chosen = results[activeIndex];
        onSelectResult(chosen.pageId, chosen.blockId);
        onClose();
      } else if (activeIndex < results.length + fileHits.length) {
        const hit = fileHits[activeIndex - results.length];
        onOpenFile?.(hit.path);
        onClose();
      } else {
        const action = filteredActions[activeIndex - results.length - fileHits.length];
        action?.run();
      }
    }
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nb-modal-card"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="nb-cmd-input-row">
          <Search size={18} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            type="text"
            className="nb-cmd-input"
            placeholder="搜索页面、文件夹里的笔记或命令…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="nb-icon-btn"
              onClick={() => setQuery("")}
              title="清空搜索词"
            >
              <X size={15} />
            </button>
          ) : (
            <kbd className="nb-kbd">ESC</kbd>
          )}
        </div>

        <div className="nb-cmd-list">
          {results.length > 0 && (
            <>
              <div className="nb-cmd-group-label">
                {query.trim() ? "匹配结果" : "最近访问与更新"}
              </div>
              {results.map((item, idx) => {
                const isSelected = idx === activeIndex;
                return (
                  <button
                    key={`${item.pageId}-${item.blockId ?? "page"}-${idx}`}
                    type="button"
                    className={`nb-cmd-item${isSelected ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => {
                      onSelectResult(item.pageId, item.blockId);
                      onClose();
                    }}
                  >
                    <PageIcon icon={item.pageIcon} size={17} className="nb-inline-page-icon" />
                    <div className="nb-cmd-item-body">
                      <div className="nb-cmd-item-title">
                        {item.pageTitle || "无标题"}
                        {item.pageType === "database" && (
                          <span
                            className="nb-tree-badge"
                            style={{ marginLeft: "6px", verticalAlign: "middle" }}
                          >
                            数据库
                          </span>
                        )}
                      </div>
                      {item.snippet && (
                        <div className="nb-cmd-item-snippet">{item.snippet}</div>
                      )}
                    </div>
                    {isSelected && (
                      <CornerDownLeft
                        size={14}
                        style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                      />
                    )}
                  </button>
                );
              })}
            </>
          )}

          {fileHits.length > 0 && (
            <>
              <div className="nb-cmd-group-label">文件夹中的笔记</div>
              {fileHits.map((hit, idx) => {
                const globalIdx = results.length + idx;
                const isSelected = globalIdx === activeIndex;
                return (
                  <button
                    key={`file-${hit.path}-${hit.line}`}
                    type="button"
                    className={`nb-cmd-item${isSelected ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(globalIdx)}
                    onClick={() => {
                      onOpenFile?.(hit.path);
                      onClose();
                    }}
                    title={hit.path}
                  >
                    <span style={{ color: "var(--text-secondary)", display: "inline-flex", flexShrink: 0 }}>
                      <FileCode2 size={16} />
                    </span>
                    <div className="nb-cmd-item-body">
                      <div className="nb-cmd-item-title">
                        {hit.name.replace(/\.(md|markdown|mdown|mkd)$/i, "")}
                        <span className="nb-cmd-item-meta">{hit.rootName}</span>
                      </div>
                      <div className="nb-cmd-item-snippet">
                        {hit.line > 0 ? `第 ${hit.line} 行 · ${hit.snippet}` : "文件名匹配"}
                      </div>
                    </div>
                    {isSelected && (
                      <CornerDownLeft size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                    )}
                  </button>
                );
              })}
            </>
          )}

          {filteredActions.length > 0 && (
            <>
              <div className="nb-cmd-group-label">快捷操作</div>
              {filteredActions.map((act, idx) => {
                const globalIdx = results.length + fileHits.length + idx;
                const isSelected = globalIdx === activeIndex;
                return (
                  <button
                    key={act.id}
                    type="button"
                    className={`nb-cmd-item${isSelected ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(globalIdx)}
                    onClick={act.run}
                  >
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        flexShrink: 0,
                      }}
                    >
                      {act.icon}
                    </span>
                    <div className="nb-cmd-item-body">
                      <div className="nb-cmd-item-title">{act.label}</div>
                      <div className="nb-cmd-item-snippet">{act.sublabel}</div>
                    </div>
                    {isSelected && (
                      <CornerDownLeft
                        size={14}
                        style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                      />
                    )}
                  </button>
                );
              })}
            </>
          )}

          {totalItems === 0 && (
            <div
              style={{
                padding: "36px 16px",
                textAlign: "center",
                color: "var(--text-tertiary)",
              }}
            >
              未找到与「{query}」匹配的页面或笔记内容
            </div>
          )}
        </div>

        <div className="nb-cmd-footer">
          <span>↑↓ 选择条目 · Enter 跳转打开 · Esc 关闭</span>
          <span>{folderRoots.length > 0 ? "工作区 + 文件夹全文检索" : "工作区全文检索"}</span>
        </div>
      </div>
    </div>
  );
};
