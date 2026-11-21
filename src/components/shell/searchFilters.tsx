import React from "react";
import type { SearchResult } from "../../types/notion";
import { currentUiLang } from "../../i18n/domTranslator";

export type SearchTypeFilter = "all" | "doc" | "database";
export type SearchTimeFilter = "any" | "today" | "7d" | "30d";

export const SEARCH_TYPE_OPTIONS: { id: SearchTypeFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "doc", label: "文档" },
  { id: "database", label: "数据库" },
];

export const SEARCH_TIME_OPTIONS: { id: SearchTimeFilter; label: string }[] = [
  { id: "any", label: "任何时间" },
  { id: "today", label: "今天" },
  { id: "7d", label: "7 天内" },
  { id: "30d", label: "30 天内" },
];

const TYPE_ALIASES: Record<string, SearchTypeFilter> = {
  doc: "doc",
  docs: "doc",
  page: "doc",
  文档: "doc",
  页面: "doc",
  db: "database",
  database: "database",
  数据库: "database",
  表格: "database",
  all: "all",
  全部: "all",
};

const TIME_ALIASES: Record<string, SearchTimeFilter> = {
  today: "today",
  今天: "today",
  "1d": "today",
  "7d": "7d",
  week: "7d",
  本周: "7d",
  "7天": "7d",
  "30d": "30d",
  month: "30d",
  本月: "30d",
  "30天": "30d",
  any: "any",
};

export interface ParsedSearchQuery {
  /** 去掉筛选语法后的搜索词 */
  text: string;
  /** 用于高亮的词 */
  terms: string[];
  type?: SearchTypeFilter;
  time?: SearchTimeFilter;
}

/** 解析 `type:db`、`类型:文档`、`updated:7d`、`时间:今天` 这类筛选写法 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let type: SearchTypeFilter | undefined;
  let time: SearchTimeFilter | undefined;
  const rest: string[] = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    const m = /^(type|类型|updated|time|时间)[:：](.+)$/i.exec(tok);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if ((key === "type" || key === "类型") && TYPE_ALIASES[val]) {
        type = TYPE_ALIASES[val];
        continue;
      }
      if ((key === "updated" || key === "time" || key === "时间") && TIME_ALIASES[val]) {
        time = TIME_ALIASES[val];
        continue;
      }
    }
    rest.push(tok);
  }
  const text = rest.join(" ");
  return { text, terms: rest.filter((t) => t.length > 0), type, time };
}

export function filterSearchResults(
  list: SearchResult[],
  type: SearchTypeFilter,
  time: SearchTimeFilter,
  now: Date = new Date()
): SearchResult[] {
  let cutoff = 0;
  if (time === "today") cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  else if (time === "7d") cutoff = now.getTime() - 7 * 86400000;
  else if (time === "30d") cutoff = now.getTime() - 30 * 86400000;
  return list.filter((r) => {
    if (type !== "all" && r.pageType !== type) return false;
    if (cutoff) {
      const t = Date.parse(r.updatedAt);
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    return true;
  });
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把搜索词在文字里高亮出来（不区分大小写） */
export const Highlight: React.FC<{ text: string; terms: string[] }> = ({ text, terms }) => {
  const usable = terms.filter((t) => t.trim().length > 0).slice(0, 8);
  if (usable.length === 0 || !text) return <>{text}</>;
  const re = new RegExp(`(${usable.map(escapeRe).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <span data-i18n-skip="">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="nb-cmd-mark">
            {p}
          </mark>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </span>
  );
};

/** 刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 4 天前 / 2026-10-02 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const en = (() => {
    try {
      return currentUiLang() === "en";
    } catch {
      return false;
    }
  })();
  const diff = Math.max(0, now.getTime() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return en ? "just now" : "刚刚";
  if (min < 60) return en ? `${min} min ago` : `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return en ? `${hr} h ago` : `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return en ? "yesterday" : "昨天";
  if (day < 30) return en ? `${day} days ago` : `${day} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
