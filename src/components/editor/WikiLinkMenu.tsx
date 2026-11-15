import React, { useEffect, useMemo, useRef, useState } from "react";
import { PageIcon } from "../../icons/pageIcon";
import { FilePlus2 } from "lucide-react";
import type { Page } from "../../types/notion";

export interface WikiLinkMenuProps {
  open: boolean;
  query: string;
  currentPageId: string;
  pages: Page[];
  anchorPoint: { x: number; y: number; bottom: number };
  canCreateSubpage: boolean;
  onSelectPage: (page: Page) => void;
  onCreateAndLinkSubpage?: (title: string) => void;
  onClose: () => void;
}

type WikiCandidate =
  | { kind: "page"; page: Page }
  | { kind: "create"; title: string };

export const WikiLinkMenu: React.FC<WikiLinkMenuProps> = ({
  open,
  query,
  currentPageId,
  pages,
  anchorPoint,
  canCreateSubpage,
  onSelectPage,
  onCreateAndLinkSubpage,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const candidates = useMemo<WikiCandidate[]>(() => {
    const q = query.trim().toLowerCase();
    const activePages = pages
      .filter((p) => !p.isTrashed)
      .filter((p) => {
        if (!q) return p.id !== currentPageId;
        const title = (p.title || "无标题").toLowerCase();
        return title.includes(q);
      })
      .sort((a, b) => {
        // Put non-current pages first, then favorites, then updatedAt desc
        if ((a.id === currentPageId) !== (b.id === currentPageId)) {
          return a.id === currentPageId ? 1 : -1;
        }
        if (a.isFavorite !== b.isFavorite) {
          return a.isFavorite ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });

    const list: WikiCandidate[] = activePages.map((page) => ({
      kind: "page",
      page,
    }));

    const trimmedTitle = query.trim();
    const exactExists = activePages.some(
      (p) => p.title.trim().toLowerCase() === trimmedTitle.toLowerCase()
    );
    if (canCreateSubpage && onCreateAndLinkSubpage && trimmedTitle && !exactExists) {
      list.push({ kind: "create", title: trimmedTitle });
    }

    return list;
  }, [canCreateSubpage, currentPageId, onCreateAndLinkSubpage, pages, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const activeBtn = itemRefs.current[selectedIndex];
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (candidates.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev + 1) % candidates.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(
          (prev) => (prev - 1 + candidates.length) % candidates.length
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const chosen = candidates[selectedIndex] ?? candidates[0];
        if (!chosen) return;
        if (chosen.kind === "page") {
          onSelectPage(chosen.page);
        } else if (onCreateAndLinkSubpage) {
          onCreateAndLinkSubpage(chosen.title);
        }
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [
    candidates,
    onClose,
    onCreateAndLinkSubpage,
    onSelectPage,
    open,
    selectedIndex,
  ]);

  if (!open) return null;

  const menuWidth = 304;
  const estimatedHeight = 310;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;

  const left = Math.max(12, Math.min(anchorPoint.x, viewportW - menuWidth - 16));
  const placeAbove =
    anchorPoint.bottom + estimatedHeight > viewportH - 12 &&
    anchorPoint.y > estimatedHeight + 16;
  const top = placeAbove
    ? Math.max(12, anchorPoint.y - estimatedHeight - 6)
    : Math.min(anchorPoint.bottom + 6, viewportH - 120);

  return (
    <div
      ref={menuRef}
      className="nb-editor-floating-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="listbox"
      aria-label="双向页面链接选择器"
    >
      <div className="nb-editor-menu-header">
        <span>{query ? `链接至页面: [[${query}` : "链接至页面 [[...]]"}</span>
        <span>↑↓ 选择 · ↵ 插入</span>
      </div>

      <div className="nb-editor-menu-scroll">
        {candidates.length === 0 ? (
          <div className="nb-editor-menu-empty">
            未找到匹配的页面{canCreateSubpage ? "，继续输入名称可新建子页面" : ""}
          </div>
        ) : (
          candidates.map((cand, idx) => {
            const isActive = idx === selectedIndex;
            if (cand.kind === "page") {
              const p = cand.page;
              return (
                <button
                  key={p.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={`nb-editor-menu-item ${isActive ? "is-active" : ""}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectPage(p);
                  }}
                >
                  <span className="nb-editor-menu-item-icon">
                    <PageIcon icon={p.icon} size={16} fallback={p.pageType === "database" ? "🗃️" : "📄"} />
                  </span>
                  <span className="nb-editor-menu-item-body">
                    <span className="nb-editor-menu-item-title">
                      {p.title || "无标题"}
                    </span>
                    <span className="nb-editor-menu-item-desc">
                      {p.pageType === "database" ? "多维数据库" : "文档页面"}
                      {p.isFavorite ? " · ★ 收藏" : ""}
                    </span>
                  </span>
                </button>
              );
            }

            return (
              <button
                key={`create-${cand.title}`}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`nb-editor-menu-item ${isActive ? "is-active" : ""}`}
                onMouseEnter={() => setSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (onCreateAndLinkSubpage) {
                    onCreateAndLinkSubpage(cand.title);
                  }
                }}
              >
                <span className="nb-editor-menu-item-icon">
                  <FilePlus2 size={16} />
                </span>
                <span className="nb-editor-menu-item-body">
                  <span className="nb-editor-menu-item-title">
                    新建子页面「{cand.title}」
                  </span>
                  <span className="nb-editor-menu-item-desc">
                    立即创建子文档并插入双向引用链接
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
