import type {
  ColumnType,
  DbColumn,
  DbRow,
  SelectOption,
} from "../../types/notion";

export type ViewMode = "table" | "board" | "gallery";

export type FilterOperator =
  | "contains"
  | "equals"
  | "is_empty"
  | "is_not_empty"
  | "checked"
  | "unchecked";

export interface FilterRule {
  id: string;
  colId: string;
  operator: FilterOperator;
  value: string;
}

export type SortDirection = "asc" | "desc";

export interface SortRule {
  id: string;
  colId: string;
  direction: SortDirection;
}

export type CalcType =
  | "none"
  | "count"
  | "filled"
  | "empty"
  | "percent_done"
  | "sum"
  | "avg";

export interface OptionColorMeta {
  key: string;
  label: string;
}

export const NOTION_COLORS: OptionColorMeta[] = [
  { key: "gray", label: "灰色" },
  { key: "brown", label: "棕色" },
  { key: "orange", label: "橙色" },
  { key: "amber", label: "琥珀" },
  { key: "green", label: "绿色" },
  { key: "teal", label: "青色" },
  { key: "blue", label: "蓝色" },
  { key: "indigo", label: "靛蓝" },
  { key: "purple", label: "紫色" },
  { key: "pink", label: "粉色" },
  { key: "red", label: "红色" },
];

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "包含",
  equals: "等于",
  is_empty: "为空",
  is_not_empty: "不为空",
  checked: "已勾选",
  unchecked: "未勾选",
};

export interface ColumnTypeMeta {
  type: ColumnType;
  label: string;
  defaultName: string;
  creatable: boolean;
}

export const COLUMN_TYPE_LIST: ColumnTypeMeta[] = [
  { type: "title", label: "标题 (Title)", defaultName: "名称", creatable: false },
  { type: "status", label: "状态 (Status)", defaultName: "状态", creatable: true },
  { type: "select", label: "单选 (Select)", defaultName: "分类", creatable: true },
  {
    type: "multi_select",
    label: "多选 (Multi-select)",
    defaultName: "标签",
    creatable: true,
  },
  { type: "date", label: "日期 (Date)", defaultName: "截止日期", creatable: true },
  {
    type: "checkbox",
    label: "复选框 (Checkbox)",
    defaultName: "已完成",
    creatable: true,
  },
  { type: "number", label: "数字 (Number)", defaultName: "数值", creatable: true },
  { type: "url", label: "链接 (URL)", defaultName: "链接", creatable: true },
  { type: "text", label: "文本 (Text)", defaultName: "备注", creatable: true },
];

const VALID_COLOR_KEYS = new Set(NOTION_COLORS.map((c) => c.key));

export function normalizeOptionColor(color: string | undefined | null): string {
  if (!color) return "gray";
  const lower = color.trim().toLowerCase();
  if (VALID_COLOR_KEYS.has(lower)) return lower;
  if (lower === "yellow" || lower === "gold") return "amber";
  if (lower === "default" || lower === "slate" || lower === "neutral") return "gray";
  if (lower === "violet") return "purple";
  if (lower === "cyan" || lower === "emerald" || lower === "mint") return "teal";
  if (lower === "rose" || lower === "crimson") return "red";
  if (lower === "sky") return "blue";
  return "gray";
}

export function pickNextOptionColor(existingCount: number): string {
  const cycle = [
    "blue",
    "green",
    "amber",
    "purple",
    "red",
    "teal",
    "orange",
    "pink",
    "indigo",
    "brown",
    "gray",
  ];
  return cycle[existingCount % cycle.length];
}

export function generateLocalId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function getDefaultOptionsForType(colType: ColumnType): SelectOption[] {
  if (colType === "status") {
    return [
      { id: "status_todo", label: "待开始", color: "gray" },
      { id: "status_doing", label: "进行中", color: "blue" },
      { id: "status_done", label: "已完成", color: "green" },
    ];
  }
  if (colType === "select") {
    return [
      { id: "opt_p0", label: "P0 紧急", color: "red" },
      { id: "opt_p1", label: "P1 重要", color: "amber" },
      { id: "opt_p2", label: "P2 常规", color: "blue" },
    ];
  }
  if (colType === "multi_select") {
    return [
      { id: "tag_product", label: "产品", color: "purple" },
      { id: "tag_eng", label: "研发", color: "blue" },
      { id: "tag_design", label: "设计", color: "pink" },
    ];
  }
  return [];
}

export function getSortedColumns(columns: DbColumn[]): DbColumn[] {
  return [...columns].sort((a, b) => {
    if (a.colType === "title" && b.colType !== "title") return -1;
    if (b.colType === "title" && a.colType !== "title") return 1;
    return a.sortOrder - b.sortOrder;
  });
}

export function getTitleColumn(columns: DbColumn[]): DbColumn | undefined {
  return columns.find((c) => c.colType === "title") ?? columns[0];
}

export function getRowTitle(row: DbRow, columns: DbColumn[]): string {
  const titleCol = getTitleColumn(columns);
  if (!titleCol) return "";
  const raw = row.cells[titleCol.id];
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

/**
 * Matches an option by exact id, exact label, or case-insensitive id/label.
 * If the cell holds a non-empty string not yet in col.options, returns a fallback pill
 * so seeded or imported string values are always visible.
 */
export function findSelectOption(
  col: DbColumn,
  raw: unknown,
  allowFallback = true
): SelectOption | null {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;

  const exact = col.options.find((o) => o.id === str || o.label === str);
  if (exact) return exact;

  const lower = str.toLowerCase();
  const insensitive = col.options.find(
    (o) => o.id.toLowerCase() === lower || o.label.toLowerCase() === lower
  );
  if (insensitive) return insensitive;

  if (allowFallback) {
    return { id: str, label: str, color: "gray" };
  }
  return null;
}

export function getMultiSelectRawTokens(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (item === null || item === undefined ? "" : String(item).trim()))
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function resolveMultiSelectOptions(
  col: DbColumn,
  raw: unknown
): SelectOption[] {
  const tokens = getMultiSelectRawTokens(raw);
  const result: SelectOption[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const opt = findSelectOption(col, token, true);
    if (opt && !seen.has(opt.id)) {
      seen.add(opt.id);
      result.push(opt);
    }
  }
  return result;
}

/**
 * Preserves convention used by existing rows in the database (either option.id or option.label).
 */
export function getOptionWriteValue(
  col: DbColumn,
  opt: SelectOption,
  rows: DbRow[]
): string {
  for (const r of rows) {
    const val = r.cells[col.id];
    if (typeof val === "string" && val.trim()) {
      if (col.options.some((o) => o.label === val && o.id !== val)) {
        return opt.label;
      }
      if (col.options.some((o) => o.id === val)) {
        return opt.id;
      }
    } else if (Array.isArray(val) && val.length > 0) {
      const first = String(val[0]);
      if (col.options.some((o) => o.label === first && o.id !== first)) {
        return opt.label;
      }
      if (col.options.some((o) => o.id === first)) {
        return opt.id;
      }
    }
  }
  return opt.id;
}

export function isCheckboxChecked(val: unknown): boolean {
  return val === true || val === 1 || val === "true" || val === "1";
}

export function isDoneStatusOption(opt: SelectOption | null): boolean {
  if (!opt) return false;
  const text = `${opt.id} ${opt.label}`.toLowerCase();
  return (
    text.includes("done") ||
    text.includes("complete") ||
    text.includes("shipped") ||
    text.includes("已完成") ||
    text.includes("完成") ||
    text.includes("已上线") ||
    text.includes("已发布")
  );
}

export function isCellEmpty(col: DbColumn, val: unknown): boolean {
  if (col.colType === "checkbox") {
    return !isCheckboxChecked(val);
  }
  if (val === null || val === undefined) return true;
  if (col.colType === "multi_select") {
    return getMultiSelectRawTokens(val).length === 0;
  }
  if (col.colType === "number") {
    if (typeof val === "number") return Number.isNaN(val);
    const trimmed = String(val).trim();
    return trimmed === "" || Number.isNaN(Number(trimmed));
  }
  return String(val).trim() === "";
}

export function getCellSearchText(col: DbColumn, val: unknown): string {
  if (val === null || val === undefined) return "";
  if (col.colType === "status" || col.colType === "select") {
    const opt = findSelectOption(col, val, true);
    return opt ? `${opt.label} ${opt.id}` : String(val);
  }
  if (col.colType === "multi_select") {
    return resolveMultiSelectOptions(col, val)
      .map((o) => `${o.label} ${o.id}`)
      .join(" ");
  }
  if (col.colType === "checkbox") {
    return isCheckboxChecked(val) ? "true checked 已勾选 是" : "false unchecked 未勾选 否";
  }
  return String(val);
}

export function matchesFilterRule(
  row: DbRow,
  rule: FilterRule,
  columns: DbColumn[]
): boolean {
  const col = columns.find((c) => c.id === rule.colId);
  if (!col) return true;
  const val = row.cells[col.id];

  switch (rule.operator) {
    case "checked":
      return isCheckboxChecked(val);
    case "unchecked":
      return !isCheckboxChecked(val);
    case "is_empty":
      if (col.colType === "checkbox") return !isCheckboxChecked(val);
      return isCellEmpty(col, val);
    case "is_not_empty":
      if (col.colType === "checkbox") return isCheckboxChecked(val);
      return !isCellEmpty(col, val);
    case "contains": {
      const needle = rule.value.trim().toLowerCase();
      if (!needle) return true;
      const haystack = getCellSearchText(col, val).toLowerCase();
      return haystack.includes(needle);
    }
    case "equals": {
      const needle = rule.value.trim().toLowerCase();
      if (!needle) return true;
      if (col.colType === "status" || col.colType === "select") {
        const opt = findSelectOption(col, val, true);
        if (!opt) return false;
        return (
          opt.label.toLowerCase() === needle || opt.id.toLowerCase() === needle
        );
      }
      if (col.colType === "multi_select") {
        const opts = resolveMultiSelectOptions(col, val);
        return opts.some(
          (o) =>
            o.label.toLowerCase() === needle || o.id.toLowerCase() === needle
        );
      }
      if (col.colType === "number") {
        const numA = Number(val);
        const numB = Number(needle);
        if (!Number.isNaN(numA) && !Number.isNaN(numB) && String(val).trim() !== "") {
          return numA === numB;
        }
      }
      return String(val ?? "").trim().toLowerCase() === needle;
    }
    default:
      return true;
  }
}

function compareRowsByColumn(
  a: DbRow,
  b: DbRow,
  col: DbColumn,
  direction: SortDirection
): number {
  const valA = a.cells[col.id];
  const valB = b.cells[col.id];
  const emptyA = col.colType === "checkbox" ? false : isCellEmpty(col, valA);
  const emptyB = col.colType === "checkbox" ? false : isCellEmpty(col, valB);

  // Keep empty cells at the bottom regardless of sort direction for clean Notion UX
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;

  const mult = direction === "asc" ? 1 : -1;

  if (col.colType === "checkbox") {
    const boolA = isCheckboxChecked(valA) ? 1 : 0;
    const boolB = isCheckboxChecked(valB) ? 1 : 0;
    return (boolA - boolB) * mult;
  }

  if (col.colType === "number") {
    const numA = Number(valA);
    const numB = Number(valB);
    return (numA - numB) * mult;
  }

  if (col.colType === "date") {
    const timeA = Date.parse(String(valA));
    const timeB = Date.parse(String(valB));
    if (!Number.isNaN(timeA) && !Number.isNaN(timeB)) {
      return (timeA - timeB) * mult;
    }
  }

  if (col.colType === "status" || col.colType === "select") {
    const optA = findSelectOption(col, valA, true);
    const optB = findSelectOption(col, valB, true);
    const idxA = optA ? col.options.findIndex((o) => o.id === optA.id) : -1;
    const idxB = optB ? col.options.findIndex((o) => o.id === optB.id) : -1;
    if (idxA !== -1 && idxB !== -1 && idxA !== idxB) {
      return (idxA - idxB) * mult;
    }
    const labelA = optA?.label ?? String(valA);
    const labelB = optB?.label ?? String(valB);
    return (
      labelA.localeCompare(labelB, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      }) * mult
    );
  }

  if (col.colType === "multi_select") {
    const strA = resolveMultiSelectOptions(col, valA)
      .map((o) => o.label)
      .join(", ");
    const strB = resolveMultiSelectOptions(col, valB)
      .map((o) => o.label)
      .join(", ");
    return (
      strA.localeCompare(strB, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      }) * mult
    );
  }

  const textA = String(valA ?? "");
  const textB = String(valB ?? "");
  return (
    textA.localeCompare(textB, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    }) * mult
  );
}

export function applyFiltersAndSorts(
  rows: DbRow[],
  columns: DbColumn[],
  searchQuery: string,
  filters: FilterRule[],
  sorts: SortRule[]
): DbRow[] {
  const q = searchQuery.trim().toLowerCase();

  const filtered = rows.filter((row) => {
    if (q) {
      const matchedSearch = columns.some((col) =>
        getCellSearchText(col, row.cells[col.id]).toLowerCase().includes(q)
      );
      if (!matchedSearch) return false;
    }

    for (const rule of filters) {
      if (!matchesFilterRule(row, rule, columns)) {
        return false;
      }
    }
    return true;
  });

  return [...filtered].sort((a, b) => {
    for (const sort of sorts) {
      const col = columns.find((c) => c.id === sort.colId);
      if (!col) continue;
      const cmp = compareRowsByColumn(a, b, col, sort.direction);
      if (cmp !== 0) return cmp;
    }
    return a.sortOrder - b.sortOrder;
  });
}

export function getDefaultCalcForColumn(col: DbColumn): CalcType {
  if (col.colType === "title") return "count";
  if (col.colType === "checkbox" || col.colType === "status") return "percent_done";
  if (col.colType === "number") return "sum";
  return "none";
}

export function computeColumnCalculation(
  rows: DbRow[],
  col: DbColumn,
  calcType: CalcType
): { label: string; value: string } | null {
  if (calcType === "none") return null;
  const total = rows.length;

  if (calcType === "count") {
    return { label: "计数", value: `${total}` };
  }

  if (calcType === "filled") {
    const filled = rows.filter((r) => !isCellEmpty(col, r.cells[col.id])).length;
    return { label: "已填写", value: `${filled}` };
  }

  if (calcType === "empty") {
    const empty = rows.filter((r) => isCellEmpty(col, r.cells[col.id])).length;
    return { label: "未填写", value: `${empty}` };
  }

  if (calcType === "percent_done") {
    if (total === 0) return { label: "已完成", value: "0%" };
    let doneCount = 0;
    for (const r of rows) {
      const val = r.cells[col.id];
      if (col.colType === "checkbox") {
        if (isCheckboxChecked(val)) doneCount++;
      } else if (col.colType === "status" || col.colType === "select") {
        const opt = findSelectOption(col, val, false);
        if (isDoneStatusOption(opt)) doneCount++;
      } else if (!isCellEmpty(col, val)) {
        doneCount++;
      }
    }
    const pct = Math.round((doneCount / total) * 100);
    return { label: "已完成", value: `${pct}%` };
  }

  if (calcType === "sum" || calcType === "avg") {
    const nums: number[] = [];
    for (const r of rows) {
      const raw = r.cells[col.id];
      if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
        const n = Number(raw);
        if (!Number.isNaN(n)) nums.push(n);
      }
    }
    const sum = nums.reduce((acc, n) => acc + n, 0);
    if (calcType === "sum") {
      const formatted = Number.isInteger(sum)
        ? String(sum)
        : sum.toFixed(2).replace(/\.?0+$/, "");
      return { label: "求和", value: formatted };
    }
    if (nums.length === 0) return { label: "平均值", value: "0" };
    const avg = sum / nums.length;
    const formatted = Number.isInteger(avg)
      ? String(avg)
      : avg.toFixed(2).replace(/\.?0+$/, "");
    return { label: "平均值", value: formatted };
  }

  return null;
}

export function formatDateFriendly(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (!str) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]}`;
  }
  return str;
}

export function toDateInputValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(str);
  return match ? match[1] : "";
}

export function getOffsetDateISO(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function normalizeExternalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}
