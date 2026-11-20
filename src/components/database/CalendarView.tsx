import React, { useMemo, useState } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { DbColumn, DbRow } from "../../types/notion";
import { findSelectOption, getRowTitle, normalizeOptionColor, toDateInputValue } from "./dbUtils";
import { addDays, dateKey, formatMonth, startOfDay, weekHeads } from "../../utils/dueDate";

export interface CalendarViewProps {
  columns: DbColumn[];
  rows: DbRow[];
  /** 用哪一个日期列排日历 */
  dateColId: string | null;
  onChangeDateCol: (colId: string) => void;
  onCreateDateColumn: () => void;
  onUpdateCell: (rowId: string, colId: string, value: unknown, immediate?: boolean) => void;
  onCreateRowWithCells: (cells: Record<string, unknown>, openDrawer?: boolean) => void;
  onOpenRowDrawer: (rowId: string) => void;
}

const MAX_PER_DAY = 3;

/** 数据库日历视图：按日期列把记录排在月历上，可拖动改日期、点空白日期新建 */
export const CalendarView: React.FC<CalendarViewProps> = ({
  columns,
  rows,
  dateColId,
  onChangeDateCol,
  onCreateDateColumn,
  onUpdateCell,
  onCreateRowWithCells,
  onOpenRowDrawer,
}) => {
  const today = startOfDay(new Date());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);

  const dateCols = columns.filter((c) => c.colType === "date");
  const dateCol = dateCols.find((c) => c.id === dateColId) ?? dateCols[0];
  const colorCol = columns.find((c) => c.colType === "status" || c.colType === "select");

  const byDay = useMemo(() => {
    const map = new Map<string, DbRow[]>();
    if (!dateCol) return map;
    for (const r of rows) {
      const k = toDateInputValue(r.cells[dateCol.id]);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return map;
  }, [rows, dateCol]);

  const undated = dateCol ? rows.filter((r) => !toDateInputValue(r.cells[dateCol.id])).length : 0;

  const cells = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    const first = addDays(month, -offset);
    // 只显示需要的周数（4~6 周）
    const lastOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const span = offset + lastOfMonth.getDate();
    const weeks = Math.ceil(span / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
  }, [month]);

  if (!dateCol) {
    return (
      <div className="nb-db-cal-empty">
        <CalendarPlus size={22} />
        <p>日历视图需要一个「日期」列，记录会按这个日期排在月历上。</p>
        <button type="button" className="nb-db-primary-btn" onClick={onCreateDateColumn}>
          <Plus size={15} />
          <span>添加日期列</span>
        </button>
      </div>
    );
  }

  const chipColor = (r: DbRow) => {
    if (!colorCol) return "gray";
    const opt = findSelectOption(colorCol, r.cells[colorCol.id], false);
    return opt ? normalizeOptionColor(opt.color) : "gray";
  };

  const todayKey = dateKey(today);

  return (
    <div className="nb-db-cal">
      <div className="nb-db-cal-bar">
        <div className="nb-db-cal-nav">
          <button
            type="button"
            className="nb-db-ghost-btn"
            aria-label="上个月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="nb-db-cal-month" data-i18n-skip="">
            {formatMonth(month)}
          </span>
          <button
            type="button"
            className="nb-db-ghost-btn"
            aria-label="下个月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="nb-db-ghost-btn"
            onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
          >
            今天
          </button>
        </div>
        <div className="nb-db-cal-opts">
          {undated > 0 && <span className="nb-db-cal-undated">{`${undated} 条没有日期`}</span>}
          {dateCols.length > 1 && (
            <label className="nb-db-cal-colsel">
              <span>按</span>
              <select value={dateCol.id} onChange={(e) => onChangeDateCol(e.target.value)}>
                {dateCols.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span>排列</span>
            </label>
          )}
        </div>
      </div>

      <div className="nb-db-cal-grid" role="grid">
        {weekHeads().map((w) => (
          <div key={w} className="nb-db-cal-wd" data-i18n-skip="">
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const k = dateKey(d);
          const list = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          const showAll = expanded === k;
          const shown = showAll ? list : list.slice(0, MAX_PER_DAY);
          return (
            <div
              key={k}
              role="gridcell"
              className={[
                "nb-db-cal-day",
                inMonth ? "" : "is-out",
                k === todayKey ? "is-today" : "",
                overDay === k ? "is-drop" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onDragOver={(e) => {
                if (!dragRow) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overDay !== k) setOverDay(k);
              }}
              onDragLeave={() => setOverDay((v) => (v === k ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragRow || e.dataTransfer.getData("text/plain");
                setOverDay(null);
                setDragRow(null);
                if (id) onUpdateCell(id, dateCol.id, k, true);
              }}
            >
              <div className="nb-db-cal-day-head">
                <span className="nb-db-cal-num">{d.getDate()}</span>
                <button
                  type="button"
                  className="nb-db-cal-add"
                  title={`在 ${k} 新建记录`}
                  aria-label={`在 ${k} 新建记录`}
                  onClick={() => onCreateRowWithCells({ [dateCol.id]: k }, true)}
                >
                  <Plus size={12} />
                </button>
              </div>
              <div className="nb-db-cal-items">
                {shown.map((r) => {
                  const title = getRowTitle(r, columns);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      draggable
                      className={`nb-db-cal-chip nb-db-pill-${chipColor(r)}${dragRow === r.id ? " is-dragging" : ""}`}
                      title={title || "未命名"}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", r.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragRow(r.id);
                      }}
                      onDragEnd={() => {
                        setDragRow(null);
                        setOverDay(null);
                      }}
                      onClick={() => onOpenRowDrawer(r.id)}
                    >
                      <span data-i18n-skip="">{title || "未命名"}</span>
                    </button>
                  );
                })}
                {list.length > MAX_PER_DAY && (
                  <button
                    type="button"
                    className="nb-db-cal-more"
                    onClick={() => setExpanded(showAll ? null : k)}
                  >
                    {showAll ? "收起" : `还有 ${list.length - MAX_PER_DAY} 条`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
