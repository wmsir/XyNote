import React, { useMemo } from "react";
import { ListTree } from "lucide-react";
import type { Block } from "../../types/notion";
import { stripHtmlToText } from "./editorUtils";

export interface OutlinePanelProps {
  blocks: Block[];
  activeBlockId: string | null;
  onSelectHeading: (blockId: string) => void;
}

interface HeadingOutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  title: string;
}

export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  blocks,
  activeBlockId,
  onSelectHeading,
}) => {
  const headings = useMemo<HeadingOutlineEntry[]>(() => {
    const items: HeadingOutlineEntry[] = [];
    for (const blk of blocks) {
      if (
        blk.blockType === "heading1" ||
        blk.blockType === "heading2" ||
        blk.blockType === "heading3"
      ) {
        const level =
          blk.blockType === "heading1"
            ? 1
            : blk.blockType === "heading2"
            ? 2
            : 3;
        const cleanTitle = stripHtmlToText(blk.content).trim() || "无标题章节";
        items.push({ id: blk.id, level, title: cleanTitle });
      }
    }
    return items;
  }, [blocks]);

  return (
    <aside className="nb-editor-outline-panel" aria-label="文档大纲目录">
      <div className="nb-editor-outline-header">
        <span className="nb-editor-outline-title">
          <ListTree size={14} />
          <span>大纲目录</span>
        </span>
        {headings.length > 0 && (
          <span className="nb-editor-outline-count">{headings.length}</span>
        )}
      </div>

      {headings.length === 0 ? (
        <div className="nb-editor-outline-empty">
          文档暂无标题结构。在正文输入 <code>#</code>、<code>##</code> 或{" "}
          <code>###</code> 加空格即可自动生成大纲。
        </div>
      ) : (
        <nav className="nb-editor-outline-list">
          {headings.map((h) => {
            const isActive = h.id === activeBlockId;
            return (
              <button
                key={h.id}
                type="button"
                data-level={h.level}
                className={`nb-editor-outline-item is-h${h.level} ${
                  isActive ? "is-active" : ""
                }`}
                title={h.title}
                onClick={() => onSelectHeading(h.id)}
              >
                <span className="nb-editor-outline-dot" />
                <span className="nb-editor-outline-label">{h.title}</span>
              </button>
            );
          })}
        </nav>
      )}
    </aside>
  );
};
