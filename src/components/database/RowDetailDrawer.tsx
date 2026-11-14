import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Clock, FileText, Trash2, X } from "lucide-react";
import type { DbColumn, DbRow, Page, SelectOption } from "../../types/notion";
import { getRowTitle, getTitleColumn } from "./dbUtils";
import { ColumnIcon, detectThemeStyles } from "./ColumnIcon";
import { CellEditor } from "./CellEditor";

export interface RowDetailDrawerProps {
  row: DbRow | null;
  columns: DbColumn[];
  allRows: DbRow[];
  pages: Page[];
  hostEl: HTMLElement | null;
  onClose: () => void;
  onUpdateCell: (
    rowId: string,
    colId: string,
    value: unknown,
    immediate?: boolean
  ) => void;
  onAddColumnOption: (col: DbColumn, newOption: SelectOption) => void;
  onDeleteRow: (rowId: string) => void;
  onOpenOrCreateLinkedPage: (row: DbRow) => void;
}

export const RowDetailDrawer: React.FC<RowDetailDrawerProps> = ({
  row,
  columns,
  allRows,
  pages,
  hostEl,
  onClose,
  onUpdateCell,
  onAddColumnOption,
  onDeleteRow,
  onOpenOrCreateLinkedPage,
}) => {
  const titleCol = getTitleColumn(columns);
  const currentTitle = row ? getRowTitle(row, columns) : "";

  const [titleDraft, setTitleDraft] = useState(currentTitle);
  const isComposingRef = useRef(false);
  const isTitleFocusedRef = useRef(false);

  useEffect(() => {
    if (!isTitleFocusedRef.current) {
      setTitleDraft(currentTitle);
    }
  }, [currentTitle, row?.id]);

  useEffect(() => {
    if (!row) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [row, onClose]);

  if (!row || typeof document === "undefined") return null;

  const { isDark, vars } = detectThemeStyles(hostEl);
  const linkedPage = row.linkedPageId
    ? pages.find((p) => p.id === row.linkedPageId && !p.isTrashed)
    : undefined;

  const nonTitleCols = columns.filter((c) => c.id !== titleCol?.id);

  const formatTimestamp = (iso: string): string => {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return createPortal(
    <div
      className="nb-db-root nb-db-drawer-backdrop"
      data-nb-dark={isDark ? "true" : "false"}
      style={vars}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        className="nb-db-drawer-panel"
        role="dialog"
        aria-label="数据库记录详情"
      >
        {/* Top Bar */}
        <div className="nb-db-drawer-topbar">
          <button
            type="button"
            className="nb-db-open-page-btn is-prominent"
            onClick={() => {
              onOpenOrCreateLinkedPage(row);
              onClose();
            }}
          >
            <ArrowUpRight size={14} />
            <span>
              {linkedPage
                ? `打开关联页面 (${linkedPage.icon || "📄"} ${
                    linkedPage.title || "未命名"
                  })`
                : "打开为完整 Notion 页面"}
            </span>
          </button>

          <div className="nb-db-drawer-topbar-right">
            <button
              type="button"
              className="nb-db-icon-btn is-danger"
              title="删除此记录"
              onClick={() => {
                onDeleteRow(row.id);
                onClose();
              }}
            >
              <Trash2 size={15} />
            </button>
            <button
              type="button"
              className="nb-db-icon-btn"
              title="关闭侧边栏 (Esc)"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="nb-db-drawer-body">
          {/* Large Editable Title */}
          <div className="nb-db-drawer-title-block">
            <span className="nb-db-drawer-page-icon">
              {linkedPage?.icon ? (
                <span>{linkedPage.icon}</span>
              ) : (
                <FileText size={22} />
              )}
            </span>
            <input
              type="text"
              className="nb-db-drawer-title-input"
              placeholder="未命名记录"
              value={titleDraft}
              onFocus={() => {
                isTitleFocusedRef.current = true;
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                const next = e.currentTarget.value;
                setTitleDraft(next);
                if (titleCol) {
                  onUpdateCell(row.id, titleCol.id, next, false);
                }
              }}
              onChange={(e) => {
                const next = e.target.value;
                setTitleDraft(next);
                if (!isComposingRef.current && titleCol) {
                  onUpdateCell(row.id, titleCol.id, next, false);
                }
              }}
              onBlur={() => {
                isTitleFocusedRef.current = false;
                if (titleCol) {
                  onUpdateCell(row.id, titleCol.id, titleDraft, true);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isComposingRef.current) {
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>

          {/* Properties Grid */}
          <div className="nb-db-drawer-props">
            {nonTitleCols.map((col) => (
              <div key={col.id} className="nb-db-drawer-prop-row">
                <div className="nb-db-drawer-prop-label" title={col.name}>
                  <ColumnIcon colType={col.colType} size={14} />
                  <span>{col.name}</span>
                </div>
                <div className="nb-db-drawer-prop-val">
                  <CellEditor
                    row={row}
                    col={col}
                    allRows={allRows}
                    variant="drawer"
                    onUpdateCell={onUpdateCell}
                    onAddColumnOption={onAddColumnOption}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Metadata Footer */}
          <div className="nb-db-drawer-meta">
            <div className="nb-db-drawer-meta-item">
              <Clock size={12} />
              <span>创建于 {formatTimestamp(row.createdAt)}</span>
            </div>
            <div className="nb-db-drawer-meta-item">
              <Clock size={12} />
              <span>最后更新 {formatTimestamp(row.updatedAt)}</span>
            </div>
          </div>
        </div>
      </aside>
    </div>,
    document.body
  );
};
