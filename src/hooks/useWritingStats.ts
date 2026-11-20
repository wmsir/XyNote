import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, setSetting } from "../api/client";
import { dateKey } from "../utils/dueDate";

const DAILY_KEY = "xynote.writing.daily";
const GOALS_KEY = "wordGoals";
/** 一次增加超过这么多字视为粘贴或导入，不计入「今天写了多少」 */
const PASTE_THRESHOLD = 300;

function loadDaily(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * 写作统计：按天累计新写的字数（删字不倒扣，粘贴大段不计），以及每个页面的字数目标。
 * 按天的记录存在本机；字数目标存在设置里。
 */
export function useWritingStats(pageKey: string | null, words: number) {
  const [daily, setDaily] = useState<Record<string, number>>(loadDaily);
  const [goals, setGoals] = useState<Record<string, number>>({});
  const baseline = useRef<{ key: string | null; words: number }>({ key: null, words: 0 });
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        try {
          const v = JSON.parse(s[GOALS_KEY] || "{}");
          if (v && typeof v === "object") setGoals(v);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const b = baseline.current;
    // 换了页面：只记下起点，不算新写的字
    if (b.key !== pageKey) {
      baseline.current = { key: pageKey, words };
      return;
    }
    const delta = words - b.words;
    baseline.current = { key: pageKey, words };
    if (!pageKey || delta <= 0 || delta > PASTE_THRESHOLD) return;
    const today = dateKey(new Date());
    setDaily((prev) => {
      const next = { ...prev, [today]: (prev[today] ?? 0) + delta };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        try {
          // 只保留最近一年
          const keys = Object.keys(next).sort();
          const trimmed = Object.fromEntries(keys.slice(-370).map((k) => [k, next[k]]));
          localStorage.setItem(DAILY_KEY, JSON.stringify(trimmed));
        } catch {
          /* ignore */
        }
      }, 1500);
      return next;
    });
  }, [pageKey, words]);

  const setGoal = useCallback((key: string, goal: number | null) => {
    setGoals((prev) => {
      const next = { ...prev };
      if (goal && goal > 0) next[key] = Math.round(goal);
      else delete next[key];
      setSetting(GOALS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  return {
    daily,
    goal: pageKey ? goals[pageKey] ?? null : null,
    setGoal,
  };
}

/** 连续写作天数（今天还没写时从昨天往前数） */
export function writingStreak(daily: Record<string, number>, now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!(daily[dateKey(d)] > 0)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (daily[dateKey(d)] > 0) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
