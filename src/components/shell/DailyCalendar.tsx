import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, dateKey, formatMonth, startOfDay, weekHeads } from "../../utils/dueDate";

export interface DailyTemplateOption {
  id: string;
  title: string;
}

export interface DailyCalendarProps {
  /** 已经有每日笔记的日期 YYYY-MM-DD */
  noteDates: Set<string>;
  templateId: string | null;
  templates: DailyTemplateOption[];
  onPick: (day: Date) => void;
  onChangeTemplate: (templateId: string | null) => void;
  onClose: () => void;
}


/** 每日笔记的月历：有笔记的日期带圆点，点哪天就打开（或新建）哪天 */
export const DailyCalendar: React.FC<DailyCalendarProps> = ({
  noteDates,
  templateId,
  templates,
  onPick,
  onChangeTemplate,
  onClose,
}) => {
  const today = startOfDay(new Date());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const cells = useMemo(() => {
    // 周一开头
    const offset = (month.getDay() + 6) % 7;
    const first = addDays(month, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [month]);

  const todayKey = dateKey(today);

  return (
    <div className="nb-daycal" ref={ref} role="dialog" aria-label="每日笔记日历">
      <div className="nb-daycal-head">
        <button
          type="button"
          className="nb-icon-btn"
          aria-label="上个月"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          <ChevronLeft size={15} />
        </button>
        <span className="nb-daycal-month" data-i18n-skip="">
          {formatMonth(month)}
        </span>
        <button
          type="button"
          className="nb-icon-btn"
          aria-label="下个月"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="nb-daycal-grid" role="grid">
        {weekHeads().map((w) => (
          <span key={w} className="nb-daycal-wd" aria-hidden="true" data-i18n-skip="">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const k = dateKey(d);
          const inMonth = d.getMonth() === month.getMonth();
          const has = noteDates.has(k);
          return (
            <button
              key={k}
              type="button"
              className={[
                "nb-daycal-day",
                inMonth ? "" : "is-out",
                k === todayKey ? "is-today" : "",
                has ? "has-note" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={has ? `${k}：打开这天的笔记` : `${k}：新建这天的笔记`}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="nb-daycal-foot">
        <button
          type="button"
          className="nb-daycal-today"
          onClick={() => {
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            onPick(today);
          }}
        >
          今天
        </button>
        <label className="nb-daycal-tpl">
          <span>新笔记模板</span>
          <select
            value={templateId ?? ""}
            onChange={(e) => onChangeTemplate(e.target.value || null)}
          >
            <option value="">空白页</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
};
