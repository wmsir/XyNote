import React from "react";
import { PageIcon } from "../../icons/pageIcon";
import { ArrowUpRight, Link2, Plus } from "lucide-react";
import type { BacklinkItem, Page } from "../../types/notion";

export interface PageFooterExtrasProps {
  subpages: Page[];
  backlinks: BacklinkItem[];
  onNavigatePage: (pageId: string) => void;
  onCreateSubpage: () => void;
}

export const PageFooterExtras: React.FC<PageFooterExtrasProps> = ({
  subpages,
  backlinks,
  onNavigatePage,
  onCreateSubpage,
}) => {
  if (subpages.length === 0 && backlinks.length === 0) {
    return null;
  }

  return (
    <div className="nb-page-extras page-footer-extras">
      {subpages.length > 0 && (
        <section>
          <div className="nb-extras-group-title">
            <span>子页面 ({subpages.length})</span>
            <button
              type="button"
              className="nb-subtle-pill-btn"
              onClick={onCreateSubpage}
            >
              <Plus size={13} /> 新建子页面
            </button>
          </div>
          <div className="nb-subpages-grid">
            {subpages.map((child) => (
              <button
                key={child.id}
                type="button"
                className="nb-subpage-card"
                onClick={() => onNavigatePage(child.id)}
              >
                <PageIcon icon={child.icon} size={16} className="nb-inline-page-icon" />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontWeight: 500,
                  }}
                >
                  {child.title || "无标题"}
                </span>
                <ArrowUpRight
                  size={14}
                  style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                />
              </button>
            ))}
          </div>
        </section>
      )}

      {backlinks.length > 0 && (
        <section>
          <div className="nb-extras-group-title">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <Link2 size={13} /> 反向链接 ({backlinks.length})
            </span>
          </div>
          <div className="nb-backlinks-list">
            {backlinks.map((bl) => (
              <button
                key={bl.sourcePageId}
                type="button"
                className="nb-backlink-item"
                onClick={() => onNavigatePage(bl.sourcePageId)}
              >
                <div className="nb-backlink-source">
                  <span>{bl.sourceIcon || "📄"}</span>
                  <span>{bl.sourceTitle || "无标题"}</span>
                </div>
                {bl.excerpt && (
                  <div className="nb-backlink-excerpt">{bl.excerpt}</div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
