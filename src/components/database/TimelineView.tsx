import React, { useMemo, useState } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { DbColumn, DbRow } from "../../types/notion";
import { findSelectOption, getRowTitle, normalizeOptionColor, toDateInputValue } from "./dbUtils";
import { addDays, dateKey, parseDateKey, startOfDay } from "../../utils/dueDate";

export interface TimelineViewProps {
  columns: DbColumn[];
  rows: DbRow[];
  startColId: string | null;
  endColId: string | null;
  onChangeStartCol: (colId: string) => void;
  onChangeEndCol: (colId: string | null) => void;
  onCreateDateColumn: () => void;
  onOpenRowDrawer: (rowId: string) => void;
}

type Zoom = "week" | "month";
const DAY_W: Record<Zoom, number> = { week: 44, month: 18 };
const SPAN: Record<Zoom, number> = { week: 28, month: 84 };

/** 时间线（甘特）视图：开始日期到结束日期画成横条，适合排期 */
export const TimelineView: React.FC<TimelineViewProps> = ({
  columns,
  rows,
  startColId,
  endColId,
  onChangeStartCol,
  onChangeEndCol,
  onCreateDateColumn,
  onOpenRowDrawer,
}) => {
  const today = startOfDay(new Date());
  const [zoom, setZoom] = useState<Zoom>("week");
  const [origin, setOrigin] = useState(() => addDays(today, -7));

  const dateCols = columns.filter((c) => c.colType === "date");
  const startCol = dateCols.find((c) => c.id === startColId) ?? dateCols[0];
  const endCol = dateCols.find((c) => c.id === endColId && c.id !== startCol?.id) ?? null;
  const colorCol = columns.find((c) => c.colType === "status" || c.colType === "select");

  const span = SPAN[zoom];
  const dayW = DAY_W[zoom];
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(origin, i)), [origin, span]);

  const items = useMemo(() => {
    if (!startCol) return [];
    return rows
      .map((r) => {
        const s = parseDateKey(toDateInputValue(r.cells[startCol.id]));
        if (!s) return null;
        let e = endCol ? parseDateKey(toDateInputValue(r.cells[endCol.id])) : null;
        if (!e || e < s) e = s;
        return { row: r, start: s, end: e };
      })
      .filter((x): x is { row: DbRow; start: Date; end: Date } => !!x)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [rows, startCol, endCol]);

  if (!startCol) {
    return (
      <div className="nb-db-cal-empty">
        <CalendarPlus size={22} />
        <p>时间线视图需要「日期」列：一个做开始日期，可选再加一个做结束日期。</p>
        <button type="button" className="nb-db-primary-btn" onClick={onCreateDateColumn}>
          <Plus size={15} />
          <span>添加日期列</span>
        </button>
      </div>
    );
  }

  const dayIndex = (d: Date) => Math.round((startOfDay(d).getTime() - origin.getTime()) / 86400000);
  const todayIdx = dayIndex(today);
  const shift = zoom === "week" ? 7 : 28;
  const undated = rows.length - items.length;

  const colorOf = (r: DbRow) => {
    if (!colorCol) return "blue";
    const opt = findSelectOption(colorCol, r.cells[colorCol.id], false);
    return opt ? normalizeOptionColor(opt.color) : "blue";
  };

  return (
    <div className="nb-db-tl">
      <div className="nb-db-cal-bar">
        <div className="nb-db-cal-nav">
          <button type="button" className="nb-db-ghost-btn" aria-label="往前" onClick={() => setOrigin(addDays(origin, -shift))}>
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="nb-db-ghost-btn" onClick={() => setOrigin(addDays(today, zoom === "week" ? -7 : -14))}>
            今天
          </button>
          <button type="button" className="nb-db-ghost-btn" aria-label="往后" onClick={() => setOrigin(addDays(origin, shift))}>
            <ChevronRight size={15} />
          </button>
          <div className="nb-db-tl-zoom" role="group" aria-label="缩放">
            <button type="button" className={zoom === "week" ? "is-on" : ""} onClick={() => setZoom("week")}>
              按天
            </button>
            <button type="button" className={zoom === "month" ? "is-on" : ""} onClick={() => setZoom("month")}>
              按月
            </button>
          </div>
        </div>
        <div className="nb-db-cal-opts">
          {undated > 0 && <span className="nb-db-cal-undated">{`${undated} 条没有开始日期`}</span>}
          <label className="nb-db-cal-colsel">
            <span>开始</span>
            <select value={startCol.id} onChange={(e) => onChangeStartCol(e.target.value)}>
              {dateCols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="nb-db-cal-colsel">
            <span>结束</span>
            <select value={endCol?.id ?? ""} onChange={(e) => onChangeEndCol(e.target.value || null)}>
              <option value="">（同一天）</option>
              {dateCols
                .filter((c) => c.id !== startCol.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>

      <div className="nb-db-tl-scroll">
        <div className="nb-db-tl-canvas" style={{ width: 200 + span * dayW }}>
          <div className="nb-db-tl-head">
            <div className="nb-db-tl-label-col">记录</div>
            {days.map((d, i) => {
              const showLabel = zoom === "week" || d.getDate() === 1 || i === 0 || d.getDay() === 1;
              return (
                <div
                  key={dateKey(d)}
                  className={`nb-db-tl-day${d.getDay() === 0 || d.getDay() === 6 ? " is-weekend" : ""}${
                    i === todayIdx ? " is-today" : ""
                  }`}
                  style={{ width: dayW }}
                  title={dateKey(d)}
                >
                  {showLabel && (
                    <span data-i18n-skip="">
                      {d.getDate() === 1 || i === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : d.getDate()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {items.length === 0 && <div className="nb-db-tl-none">这段时间没有记录，用左右箭头看看别的时间。</div>}

          {items.map(({ row, start, end }) => {
            const s = dayIndex(start);
            const e = dayIndex(end);
            const visible = e >= 0 && s < span;
            const left = Math.max(0, s) * dayW;
            const width = (Math.min(span - 1, e) - Math.max(0, s) + 1) * dayW;
            const title = getRowTitle(row, columns) || "未命名";
            const days = e - s + 1;
            return (
              <div key={row.id} className="nb-db-tl-row">
                <button type="button" className="nb-db-tl-label" onClick={() => onOpenRowDrawer(row.id)} title={title}>
                  <span data-i18n-skip="">{title}</span>
                </button>
                <div className="nb-db-tl-track" style={{ width: span * dayW }}>
                  {todayIdx >= 0 && todayIdx < span && (
                    <span className="nb-db-tl-todayline" style={{ left: todayIdx * dayW + dayW / 2 }} aria-hidden="true" />
                  )}
                  {visible ? (
                    <button
                      type="button"
                      className={`nb-db-tl-bar nb-db-pill-${colorOf(row)}${s < 0 ? " cut-left" : ""}${e >= span ? " cut-right" : ""}`}
                      style={{ left, width: Math.max(width, dayW) }}
                      title={`${title}：${dateKey(start)}${days > 1 ? ` → ${dateKey(end)}（${days} 天）` : ""}`}
                      onClick={() => onOpenRowDrawer(row.id)}
                    >
                      <span data-i18n-skip="">{title}</span>
                    </button>
                  ) : (
                    <span className="nb-db-tl-off" data-i18n-skip="">
                      {s >= span ? `${dateKey(start)} →` : `← ${dateKey(end)}`}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
