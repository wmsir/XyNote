import React, { useEffect, useMemo, useRef, useState } from "react";
import { Flame, Target, X } from "lucide-react";
import { addDays, dateKey, startOfDay } from "../../utils/dueDate";
import { writingStreak } from "../../hooks/useWritingStats";

interface Props {
  words: number;
  goal: number | null;
  daily: Record<string, number>;
  canSetGoal: boolean;
  onSetGoal: (goal: number | null) => void;
  onClose: () => void;
}

const WEEKS = 18;

function level(n: number): number {
  if (n <= 0) return 0;
  if (n < 200) return 1;
  if (n < 600) return 2;
  if (n < 1500) return 3;
  return 4;
}

/** 状态栏上弹出的写作统计：本页字数目标 + 每日写作热力图 */
export const WritingStatsPanel: React.FC<Props> = ({ words, goal, daily, canSetGoal, onSetGoal, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(goal ? String(goal) : "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const today = startOfDay(new Date());
  const todayWords = daily[dateKey(today)] ?? 0;
  const weekWords = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += daily[dateKey(addDays(today, -i))] ?? 0;
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daily]);
  const streak = writingStreak(daily);

  // 热力图：最后一列是本周，周一在最上面
  const columns = useMemo(() => {
    const dow = (today.getDay() + 6) % 7;
    const lastMonday = addDays(today, -dow);
    const first = addDays(lastMonday, -(WEEKS - 1) * 7);
    return Array.from({ length: WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = goal ? Math.min(100, Math.round((words / goal) * 100)) : 0;

  return (
    <div className="nb-wstats" ref={ref} role="dialog" aria-label="写作统计">
      <div className="nb-wstats-head">
        <span>写作统计</span>
        <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="关闭">
          <X size={14} />
        </button>
      </div>

      {canSetGoal && (
        <div className="nb-wstats-goal">
          <div className="nb-wstats-goal-row">
            <Target size={14} />
            <span>本页字数目标</span>
            <input
              type="number"
              min={0}
              step={100}
              inputMode="numeric"
              placeholder="例如 2000"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSetGoal(Number(draft) || null);
              }}
              onBlur={() => onSetGoal(Number(draft) || null)}
              aria-label="本页字数目标"
            />
          </div>
          {goal ? (
            <>
              <div className="nb-wstats-bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} className={pct >= 100 ? "is-done" : ""} />
              </div>
              <div className="nb-wstats-goal-text" data-i18n-skip="">
                {words} / {goal}（{pct}%）{pct >= 100 ? " ✓" : ""}
              </div>
            </>
          ) : null}
        </div>
      )}

      <div className="nb-wstats-nums">
        <div>
          <strong data-i18n-skip="">{todayWords}</strong>
          <span>今天新写</span>
        </div>
        <div>
          <strong data-i18n-skip="">{weekWords}</strong>
          <span>近 7 天</span>
        </div>
        <div>
          <strong data-i18n-skip="">
            {streak}
            {streak > 0 && <Flame size={13} className="nb-wstats-flame" />}
          </strong>
          <span>连续天数</span>
        </div>
      </div>

      <div className="nb-wstats-heat" role="img" aria-label={`最近 ${WEEKS} 周每天新写的字数`}>
        {columns.map((col, i) => (
          <div key={i} className="nb-wstats-col">
            {col.map((d) => {
              const k = dateKey(d);
              const n = daily[k] ?? 0;
              const future = d.getTime() > today.getTime();
              return (
                <span
                  key={k}
                  className={`nb-wstats-cell l${future ? "x" : level(n)}`}
                  title={future ? "" : `${k}：${n} 字`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="nb-wstats-note">删除不扣分，一次粘贴超过 300 字不计入；记录保存在这台电脑上。</p>
    </div>
  );
};
