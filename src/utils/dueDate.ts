/** 待办时间与每日笔记共用的本地日期工具（一律按本机时区，不转 UTC） */
import { currentUiLang } from "../i18n/domTranslator";

const isEn = () => {
  try {
    return currentUiLang() === "en";
  } catch {
    return false;
  }
};

const pad = (n: number) => String(n).padStart(2, "0");

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAYS_LONG = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 2026-11-21 */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 2026-11-21T18:00（与 <input type="datetime-local"> 的值相同） */
export function toDueString(d: Date): string {
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 解析 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm 为本地时间；只有日期时视为当天 09:00 */
export function parseDue(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 每日笔记标题：2026-11-21 星期六 */
export function dailyTitle(d: Date): string {
  return `${dateKey(d)} ${WEEKDAYS_LONG[d.getDay()]}`;
}

/** 给人看的时间：今天 18:00 / 明天 09:00 / 昨天 / 11月25日 周二 09:00 / 2027年1月3日 */
export function formatDue(s: string | null | undefined, now: Date = new Date()): string {
  const d = parseDue(s);
  if (!d) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  if (isEn()) {
    if (diff === 0) return `Today ${hm}`;
    if (diff === 1) return `Tomorrow ${hm}`;
    if (diff === -1) return `Yesterday ${hm}`;
    const opts: Intl.DateTimeFormatOptions =
      d.getFullYear() !== now.getFullYear()
        ? { year: "numeric", month: "short", day: "numeric" }
        : { weekday: "short", month: "short", day: "numeric" };
    return `${d.toLocaleDateString("en-US", opts)} ${hm}`;
  }
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${hm}`;
}

export type DueBucket = "overdue" | "today" | "upcoming" | "later" | "none";

/** 待办汇总的分组：已逾期 / 今天 / 未来 7 天 / 更晚 / 没有日期 */
export function dueBucket(s: string | null | undefined, now: Date = new Date()): DueBucket {
  const d = parseDue(s);
  if (!d) return "none";
  if (d.getTime() < now.getTime()) return "overdue";
  const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  if (days === 0) return "today";
  if (days <= 7) return "upcoming";
  return "later";
}

/** 下一个周一（今天是周一则取下周一） */
export function nextMonday(now: Date = new Date()): Date {
  const day = now.getDay();
  const delta = ((8 - day) % 7) || 7;
  return addDays(startOfDay(now), delta);
}

export function atTime(d: Date, h: number, m = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
}

/** 月历标题：2026年11月 / November 2026 */
export function formatMonth(d: Date): string {
  if (isEn()) return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 周一开头的星期表头 */
export function weekHeads(): string[] {
  return isEn() ? ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] : ["一", "二", "三", "四", "五", "六", "日"];
}
