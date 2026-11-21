import React, { useEffect, useRef, useState } from "react";
import { AlarmClock, X } from "lucide-react";
import { addDays, atTime, formatDue, nextMonday, parseDue, startOfDay, toDueString } from "../../utils/dueDate";

interface DuePickerProps {
  value: string | null | undefined;
  onChange: (dueAt: string | null) => void;
  onClose: () => void;
  align?: "left" | "right";
}

/** 设置待办提醒时间的小弹层：常用时间一键选，也可以自己填 */
export const DuePicker: React.FC<DuePickerProps> = ({ value, onChange, onClose, align = "left" }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(() => {
    const d = parseDue(value) ?? atTime(addDays(startOfDay(new Date()), 1), 9);
    return toDueString(d);
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const now = new Date();
  const today = startOfDay(now);
  const tonight = atTime(today, 18);
  const presets: { label: string; at: Date }[] = [
    // 已过 18 点就不提供「今天 18:00」
    ...(tonight.getTime() > now.getTime() ? [{ label: "今天 18:00", at: tonight }] : []),
    { label: "1 小时后", at: new Date(Math.ceil((now.getTime() + 3600000) / 300000) * 300000) },
    { label: "明天 09:00", at: atTime(addDays(today, 1), 9) },
    { label: "下周一 09:00", at: atTime(nextMonday(now), 9) },
  ];

  const pick = (d: Date) => {
    onChange(toDueString(d));
    onClose();
  };

  return (
    <div
      ref={ref}
      className={`nb-duepick${align === "right" ? " is-right" : ""}`}
      role="dialog"
      aria-label="设置提醒时间"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="nb-duepick-presets">
        {presets.map((p) => (
          <button key={p.label} type="button" className="nb-duepick-preset" onClick={() => pick(p.at)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="nb-duepick-custom">
        <input
          type="datetime-local"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const d = parseDue(custom);
              if (d) pick(d);
            }
          }}
          aria-label="自定义时间"
        />
        <button
          type="button"
          className="nb-duepick-ok"
          onClick={() => {
            const d = parseDue(custom);
            if (d) pick(d);
          }}
        >
          设定
        </button>
      </div>
      {value && (
        <button
          type="button"
          className="nb-duepick-clear"
          onClick={() => {
            onChange(null);
            onClose();
          }}
        >
          <X size={13} /> 清除提醒
        </button>
      )}
    </div>
  );
};

interface TodoDueChipProps {
  dueAt: string | null | undefined;
  checked: boolean;
  readOnly?: boolean;
  onChange: (dueAt: string | null) => void;
}

/** 待办块右侧的时间标签；没设时间时悬停才出现闹钟按钮 */
export const TodoDueChip: React.FC<TodoDueChipProps> = ({ dueAt, checked, readOnly, onChange }) => {
  const [open, setOpen] = useState(false);
  const d = parseDue(dueAt);
  const overdue = !!d && !checked && d.getTime() < Date.now();
  if (readOnly && !d) return null;
  return (
    <span className="nb-todo-due-anchor" contentEditable={false}>
      <button
        type="button"
        className={[
          "nb-todo-due",
          d ? "has-due" : "",
          overdue ? "is-overdue" : "",
          checked ? "is-done" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={d ? "修改提醒时间" : "设置提醒时间"}
        aria-label={d ? `提醒时间 ${formatDue(dueAt)}，点击修改` : "设置提醒时间"}
        disabled={readOnly}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <AlarmClock size={12} strokeWidth={2} />
        {d && <span data-i18n-skip="">{formatDue(dueAt)}</span>}
      </button>
      {open && <DuePicker value={dueAt} onChange={onChange} onClose={() => setOpen(false)} align="right" />}
    </span>
  );
};
