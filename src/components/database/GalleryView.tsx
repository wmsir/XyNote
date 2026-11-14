import React from "react";
import { ArrowUpRight, FileText, Plus, Trash2 } from "lucide-react";
import type { DbColumn, DbRow, Page } from "../../types/notion";
import {
  findSelectOption,
  getRowTitle,
  normalizeOptionColor,
} from "./dbUtils";
import { CardBadges } from "./CardBadges";

export interface GalleryViewProps {
  columns: DbColumn[];
  rows: DbRow[];
  pages: Page[];
  onUpdateCell: (
    rowId: string,
    colId: string,
    value: unknown,
    immediate?: boolean
  ) => void;
  onCreateCard: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenOrCreateLinkedPage: (row: DbRow) => void;
  onOpenRowDrawer: (rowId: string) => void;
}

export const GalleryView: React.FC<GalleryViewProps> = ({
  columns,
  rows,
  pages,
  onUpdateCell,
  onCreateCard,
  onDeleteRow,
  onOpenOrCreateLinkedPage,
  onOpenRowDrawer,
}) => {
  const primaryColorCol = columns.find(
    (c) => c.colType === "status" || c.colType === "select"
  );

  const getCardBannerTint = (row: DbRow): string => {
    if (!primaryColorCol) return "gray";
    const opt = findSelectOption(
      primaryColorCol,
      row.cells[primaryColorCol.id],
      false
    );
    return opt ? normalizeOptionColor(opt.color) : "gray";
  };

  const getLinkedPageIcon = (row: DbRow): string | null => {
    if (!row.linkedPageId) return null;
    const found = pages.find((p) => p.id === row.linkedPageId && !p.isTrashed);
    return found?.icon || null;
  };

  return (
    <div className="nb-db-gallery-grid">
      {rows.map((row) => {
        const title = getRowTitle(row, columns);
        const tint = getCardBannerTint(row);
        const pageEmoji = getLinkedPageIcon(row);

        return (
          <div
            key={row.id}
            className="nb-db-gallery-card"
            onClick={() => onOpenRowDrawer(row.id)}
          >
            {/* Subtle Notion Header Tint + Icon + Hover Quick Actions */}
            <div className={`nb-db-gallery-banner nb-db-tint-${tint}`}>
              <div className="nb-db-gallery-icon-chip">
                {pageEmoji ? (
                  <span className="nb-db-gallery-emoji">{pageEmoji}</span>
                ) : (
                  <FileText size={16} />
                )}
              </div>

              <div className="nb-db-gallery-hover-actions">
                <button
                  type="button"
                  className="nb-db-open-page-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenOrCreateLinkedPage(row);
                  }}
                  title={
                    row.linkedPageId
                      ? "打开关联页面"
                      : "创建并打开完整 Notion 页面"
                  }
                >
                  <ArrowUpRight size={13} />
                  <span>打开页面</span>
                </button>
                <button
                  type="button"
                  className="nb-db-card-action-btn is-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteRow(row.id);
                  }}
                  title="删除卡片"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Card Body */}
            <div className="nb-db-gallery-body">
              <div
                className={`nb-db-gallery-title ${
                  !title ? "is-untitled" : ""
                }`}
              >
                {title || "未命名"}
              </div>

              <CardBadges
                row={row}
                columns={columns}
                onToggleCheckbox={(rId, cId, nextVal) =>
                  onUpdateCell(rId, cId, nextVal, true)
                }
              />
            </div>
          </div>
        );
      })}

      {/* "+ 新建卡片" Tile */}
      <button
        type="button"
        className="nb-db-gallery-new-tile"
        onClick={onCreateCard}
      >
        <Plus size={18} />
        <span>新建卡片</span>
      </button>
    </div>
  );
};
