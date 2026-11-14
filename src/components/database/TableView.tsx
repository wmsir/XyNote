import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type {
  DbColumn,
  DbRow,
  SelectOption,
  UpsertDbColumnInput,
} from "../../types/notion";
import {
  CalcType,
  SortDirection,
  computeColumnCalculation,
  getDefaultCalcForColumn,
} from "./dbUtils";
import { ColumnIcon, FloatingPopover } from "./ColumnIcon";
import { CellEditor } from "./CellEditor";
import {
  AddColumnPopover,
  ColumnSchemaPopover,
} from "./ColumnHeaderPopover";

export interface TableViewProps {
  pageId: string;
  columns: DbColumn[];
  rows: DbRow[];
  allRows: DbRow[];
  onUpdateCell: (
    rowId: string,
    colId: string,
    value: unknown,
    immediate?: boolean
  ) => void;
  onAddColumnOption: (col: DbColumn, newOption: SelectOption) => void;
  onSaveColumn: (input: UpsertDbColumnInput) => void;
  onDeleteColumn: (colId: string) => void;
  onCreateRow: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenOrCreateLinkedPage: (row: DbRow) => void;
  onOpenRowDrawer: (rowId: string) => void;
  onQuickSort: (colId: string, direction: SortDirection) => void;
}

const CALC_OPTIONS: Array<{
  type: CalcType;
  label: string;
  numericOnly?: boolean;
}> = [
  { type: "none", label: "不计算" },
  { type: "count", label: "计数 (总行数)" },
  { type: "filled", label: "已填写数量" },
  { type: "empty", label: "未填写数量" },
  { type: "percent_done", label: "已完成 %" },
  { type: "sum", label: "求和 (Sum)", numericOnly: true },
  { type: "avg", label: "平均值 (Avg)", numericOnly: true },
];

export const TableView: React.FC<TableViewProps> = ({
  pageId,
  columns,
  rows,
  allRows,
  onUpdateCell,
  onAddColumnOption,
  onSaveColumn,
  onDeleteColumn,
  onCreateRow,
  onDeleteRow,
  onOpenOrCreateLinkedPage,
  onOpenRowDrawer,
  onQuickSort,
}) => {
  // Local live column widths during drag-resize
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const [resizingColId, setResizingColId] = useState<string | null>(null);

  // Column header popover state
  const [activeHeaderColId, setActiveHeaderColId] = useState<string | null>(
    null
  );
  const headerBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Add column button popover
  const [addColOpen, setAddColOpen] = useState(false);
  const addColBtnRef = useRef<HTMLButtonElement | null>(null);

  // Calculation bar per-column override
  const [calcOverrides, setCalcOverrides] = useState<Record<string, CalcType>>(
    {}
  );
  const [activeCalcColId, setActiveCalcColId] = useState<string | null>(null);
  const calcBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    setLiveWidths({});
    setActiveHeaderColId(null);
    setAddColOpen(false);
    setActiveCalcColId(null);
  }, [pageId]);

  const getColWidth = (col: DbColumn): number => {
    return liveWidths[col.id] ?? (col.width > 0 ? col.width : 180);
  };

  const handleStartResize = (
    e: React.MouseEvent,
    col: DbColumn
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startWidth = getColWidth(col);
    let latestWidth = startWidth;
    setResizingColId(col.id);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      latestWidth = Math.max(96, Math.min(620, Math.round(startWidth + delta)));
      setLiveWidths((prev) => ({ ...prev, [col.id]: latestWidth }));
    };

    const handleMouseUp = () => {
      setResizingColId(null);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (latestWidth !== col.width) {
        onSaveColumn({
          id: col.id,
          pageId: col.pageId,
          name: col.name,
          colType: col.colType,
          options: col.options,
          width: latestWidth,
          sortOrder: col.sortOrder,
        });
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const activeSchemaCol = columns.find((c) => c.id === activeHeaderColId);
  const activeCalcCol = columns.find((c) => c.id === activeCalcColId);

  return (
    <div className="nb-db-table-wrapper">
      <div className="nb-db-table-scroll">
        <table className="nb-db-table">
          <thead>
            <tr>
              {columns.map((col) => {
                const width = getColWidth(col);
                return (
                  <th
                    key={col.id}
                    className={`nb-db-th ${
                      resizingColId === col.id ? "is-resizing" : ""
                    }`}
                    style={{
                      width: `${width}px`,
                      minWidth: `${width}px`,
                      maxWidth: `${width}px`,
                    }}
                  >
                    <button
                      ref={(el) => {
                        headerBtnRefs.current[col.id] = el;
                      }}
                      type="button"
                      className={`nb-db-th-btn ${
                        activeHeaderColId === col.id ? "is-active" : ""
                      }`}
                      onClick={() =>
                        setActiveHeaderColId((prev) =>
                          prev === col.id ? null : col.id
                        )
                      }
                      title="点击编辑属性名称、类型或选项"
                    >
                      <ColumnIcon colType={col.colType} size={14} />
                      <span className="nb-db-th-name">{col.name}</span>
                    </button>

                    <div
                      className={`nb-db-col-resizer ${
                        resizingColId === col.id ? "is-active" : ""
                      }`}
                      onMouseDown={(e) => handleStartResize(e, col)}
                      title="拖拽调整列宽"
                    />
                  </th>
                );
              })}

              {/* Far-right Add Property Column Header */}
              <th className="nb-db-th nb-db-th-add">
                <button
                  ref={addColBtnRef}
                  type="button"
                  className="nb-db-add-col-btn"
                  onClick={() => setAddColOpen((v) => !v)}
                  title="新建属性列"
                >
                  <Plus size={15} />
                </button>
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr className="nb-db-empty-tr">
                <td colSpan={columns.length + 1} className="nb-db-empty-td">
                  暂无符合条件的记录，点击下方「+ 新建行」立即创建。
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="nb-db-tr">
                  {columns.map((col) => {
                    const width = getColWidth(col);
                    return (
                      <td
                        key={col.id}
                        className="nb-db-td"
                        style={{
                          width: `${width}px`,
                          minWidth: `${width}px`,
                          maxWidth: `${width}px`,
                        }}
                      >
                        <CellEditor
                          row={row}
                          col={col}
                          allRows={allRows}
                          variant="table"
                          onUpdateCell={onUpdateCell}
                          onAddColumnOption={onAddColumnOption}
                          onOpenOrCreateLinkedPage={onOpenOrCreateLinkedPage}
                          onOpenRowDrawer={onOpenRowDrawer}
                        />
                      </td>
                    );
                  })}

                  {/* Row Hover Delete Action */}
                  <td className="nb-db-td nb-db-td-actions">
                    <button
                      type="button"
                      className="nb-db-row-del-btn"
                      onClick={() => onDeleteRow(row.id)}
                      title="删除此行记录"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))
            )}

            {/* Notion Bottom "+ 新建行" Row */}
            <tr className="nb-db-new-row-tr">
              <td colSpan={columns.length + 1} className="nb-db-new-row-td">
                <button
                  type="button"
                  className="nb-db-new-row-btn"
                  onClick={onCreateRow}
                >
                  <Plus size={14} />
                  <span>新建行</span>
                </button>
              </td>
            </tr>
          </tbody>

          {/* Bottom Calculation Bar (计数 Count, 已完成 %, 求和 Sum) */}
          <tfoot>
            <tr className="nb-db-calc-tr">
              {columns.map((col) => {
                const width = getColWidth(col);
                const activeCalc =
                  calcOverrides[col.id] ?? getDefaultCalcForColumn(col);
                const computed = computeColumnCalculation(
                  rows,
                  col,
                  activeCalc
                );

                return (
                  <td
                    key={col.id}
                    className="nb-db-calc-td"
                    style={{
                      width: `${width}px`,
                      minWidth: `${width}px`,
                      maxWidth: `${width}px`,
                    }}
                  >
                    <button
                      ref={(el) => {
                        calcBtnRefs.current[col.id] = el;
                      }}
                      type="button"
                      className={`nb-db-calc-btn ${
                        computed ? "has-value" : ""
                      }`}
                      onClick={() =>
                        setActiveCalcColId((prev) =>
                          prev === col.id ? null : col.id
                        )
                      }
                    >
                      {computed ? (
                        <>
                          <span className="nb-db-calc-label">
                            {computed.label}
                          </span>
                          <span className="nb-db-calc-val">
                            {computed.value}
                          </span>
                        </>
                      ) : (
                        <span className="nb-db-calc-hover-hint">
                          <span>计算</span>
                          <ChevronDown size={12} />
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
              <td className="nb-db-calc-td nb-db-td-actions" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Column Schema Popover */}
      {activeSchemaCol && (
        <ColumnSchemaPopover
          col={activeSchemaCol}
          anchorEl={headerBtnRefs.current[activeSchemaCol.id] ?? null}
          onClose={() => setActiveHeaderColId(null)}
          onSaveColumn={onSaveColumn}
          onDeleteColumn={onDeleteColumn}
          onQuickSort={onQuickSort}
        />
      )}

      {/* Add New Column Popover */}
      {addColOpen && (
        <AddColumnPopover
          pageId={pageId}
          existingColumns={columns}
          anchorEl={addColBtnRef.current}
          onClose={() => setAddColOpen(false)}
          onCreateColumn={onSaveColumn}
        />
      )}

      {/* Calculation Picker Popover */}
      {activeCalcCol && (
        <FloatingPopover
          anchorEl={calcBtnRefs.current[activeCalcCol.id] ?? null}
          onClose={() => setActiveCalcColId(null)}
          width={190}
        >
          <div className="nb-db-pop-list">
            {CALC_OPTIONS.filter(
              (opt) => !opt.numericOnly || activeCalcCol.colType === "number"
            ).map((opt) => {
              const current =
                calcOverrides[activeCalcCol.id] ??
                getDefaultCalcForColumn(activeCalcCol);
              return (
                <button
                  key={opt.type}
                  type="button"
                  className={`nb-db-pop-item ${
                    current === opt.type ? "is-selected" : ""
                  }`}
                  onClick={() => {
                    setCalcOverrides((prev) => ({
                      ...prev,
                      [activeCalcCol.id]: opt.type,
                    }));
                    setActiveCalcColId(null);
                  }}
                >
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </FloatingPopover>
      )}
    </div>
  );
};
