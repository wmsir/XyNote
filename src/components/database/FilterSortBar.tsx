import React, { useRef, useState } from "react";
import {
  ArrowUpDown,
  Check,
  Columns3,
  Filter,
  Layers,
  LayoutGrid,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import type { DbColumn } from "../../types/notion";
import {
  FILTER_OPERATOR_LABELS,
  FilterOperator,
  FilterRule,
  SortDirection,
  SortRule,
  ViewMode,
  generateLocalId,
  normalizeOptionColor,
} from "./dbUtils";
import { ColumnIcon, FloatingPopover } from "./ColumnIcon";

export interface FilterSortBarProps {
  activeView: ViewMode;
  columns: DbColumn[];
  groupByColId: string | null;
  searchQuery: string;
  filters: FilterRule[];
  sorts: SortRule[];
  totalCount: number;
  visibleCount: number;
  onSwitchView: (view: ViewMode) => void;
  onChangeGroupBy: (colId: string) => void;
  onCreateDefaultStatusColumn: () => void;
  onSearchChange: (q: string) => void;
  onFiltersChange: (filters: FilterRule[]) => void;
  onSortsChange: (sorts: SortRule[]) => void;
  onCreateRow: () => void;
}

const ALL_OPERATORS: FilterOperator[] = [
  "contains",
  "equals",
  "is_empty",
  "is_not_empty",
  "checked",
  "unchecked",
];

const NO_VALUE_OPERATORS = new Set<FilterOperator>([
  "is_empty",
  "is_not_empty",
  "checked",
  "unchecked",
]);

export const FilterSortBar: React.FC<FilterSortBarProps> = ({
  activeView,
  columns,
  groupByColId,
  searchQuery,
  filters,
  sorts,
  totalCount,
  visibleCount,
  onSwitchView,
  onChangeGroupBy,
  onCreateDefaultStatusColumn,
  onSearchChange,
  onFiltersChange,
  onSortsChange,
  onCreateRow,
}) => {
  const [openMenu, setOpenMenu] = useState<"filter" | "sort" | "group" | null>(
    null
  );
  const filterBtnRef = useRef<HTMLButtonElement | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const groupBtnRef = useRef<HTMLButtonElement | null>(null);

  const groupableColumns = columns.filter(
    (c) => c.colType === "status" || c.colType === "select"
  );
  const activeGroupCol =
    groupableColumns.find((c) => c.id === groupByColId) ?? groupableColumns[0];

  const handleAddFilter = () => {
    const defaultCol = columns[0];
    if (!defaultCol) return;
    const defaultOp: FilterOperator =
      defaultCol.colType === "checkbox" ? "checked" : "contains";
    const next: FilterRule = {
      id: generateLocalId("flt"),
      colId: defaultCol.id,
      operator: defaultOp,
      value: "",
    };
    onFiltersChange([...filters, next]);
  };

  const handleUpdateFilter = (id: string, patch: Partial<FilterRule>) => {
    onFiltersChange(
      filters.map((f) => {
        if (f.id !== id) return f;
        const updated = { ...f, ...patch };
        if (patch.colId && patch.colId !== f.colId) {
          const targetCol = columns.find((c) => c.id === patch.colId);
          if (targetCol?.colType === "checkbox") {
            updated.operator = "checked";
            updated.value = "";
          } else if (
            updated.operator === "checked" ||
            updated.operator === "unchecked"
          ) {
            updated.operator = "contains";
          }
        }
        return updated;
      })
    );
  };

  const handleRemoveFilter = (id: string) => {
    onFiltersChange(filters.filter((f) => f.id !== id));
  };

  const handleAddSort = () => {
    const unusedCol =
      columns.find((c) => !sorts.some((s) => s.colId === c.id)) ?? columns[0];
    if (!unusedCol) return;
    const next: SortRule = {
      id: generateLocalId("srt"),
      colId: unusedCol.id,
      direction: "asc",
    };
    onSortsChange([...sorts, next]);
  };

  const handleUpdateSort = (id: string, patch: Partial<SortRule>) => {
    onSortsChange(sorts.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const handleRemoveSort = (id: string) => {
    onSortsChange(sorts.filter((s) => s.id !== id));
  };

  const isFiltered = searchQuery.trim().length > 0 || filters.length > 0;

  return (
    <div className="nb-db-toolbar-wrap">
      <div className="nb-db-toolbar">
        {/* Left: View Switcher Tabs */}
        <div className="nb-db-view-tabs" role="tablist" aria-label="数据库视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "table"}
            className={`nb-db-view-tab ${
              activeView === "table" ? "is-active" : ""
            }`}
            onClick={() => onSwitchView("table")}
          >
            <Table2 size={15} />
            <span>表格视图</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "board"}
            className={`nb-db-view-tab ${
              activeView === "board" ? "is-active" : ""
            }`}
            onClick={() => onSwitchView("board")}
          >
            <Columns3 size={15} />
            <span>看板视图</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "gallery"}
            className={`nb-db-view-tab ${
              activeView === "gallery" ? "is-active" : ""
            }`}
            onClick={() => onSwitchView("gallery")}
          >
            <LayoutGrid size={15} />
            <span>画廊视图</span>
          </button>
        </div>

        {/* Right: Search, Group By (Board), Filter, Sort, + New Record */}
        <div className="nb-db-toolbar-actions">
          {isFiltered && (
            <span className="nb-db-match-count" title="当前筛选匹配的记录数量">
              {visibleCount} / {totalCount} 条
            </span>
          )}

          {/* Instant Search Input */}
          <div className="nb-db-search-box">
            <Search size={14} className="nb-db-search-icon" />
            <input
              type="text"
              className="nb-db-search-input"
              placeholder="搜索记录..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="搜索数据库记录"
            />
            {searchQuery && (
              <button
                type="button"
                className="nb-db-search-clear"
                onClick={() => onSearchChange("")}
                title="清空搜索"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Group By selector when in Board view */}
          {activeView === "board" && (
            <button
              ref={groupBtnRef}
              type="button"
              className={`nb-db-tool-btn ${
                openMenu === "group" || !activeGroupCol ? "is-highlighted" : ""
              }`}
              onClick={() =>
                setOpenMenu((prev) => (prev === "group" ? null : "group"))
              }
            >
              <Layers size={14} />
              <span>
                分组：{activeGroupCol ? activeGroupCol.name : "未设置状态列"}
              </span>
            </button>
          )}

          {/* Filter Button */}
          <button
            ref={filterBtnRef}
            type="button"
            className={`nb-db-tool-btn ${
              filters.length > 0 ? "is-highlighted" : ""
            }`}
            onClick={() =>
              setOpenMenu((prev) => (prev === "filter" ? null : "filter"))
            }
          >
            <Filter size={14} />
            <span>筛选{filters.length > 0 ? ` (${filters.length})` : ""}</span>
          </button>

          {/* Sort Button */}
          <button
            ref={sortBtnRef}
            type="button"
            className={`nb-db-tool-btn ${
              sorts.length > 0 ? "is-highlighted" : ""
            }`}
            onClick={() =>
              setOpenMenu((prev) => (prev === "sort" ? null : "sort"))
            }
          >
            <ArrowUpDown size={14} />
            <span>排序{sorts.length > 0 ? ` (${sorts.length})` : ""}</span>
          </button>

          {/* Primary New Record Button */}
          <button
            type="button"
            className="nb-db-primary-btn"
            onClick={onCreateRow}
          >
            <Plus size={15} />
            <span>新建记录</span>
          </button>
        </div>
      </div>

      {/* Group By Popover */}
      {openMenu === "group" && (
        <FloatingPopover
          anchorEl={groupBtnRef.current}
          onClose={() => setOpenMenu(null)}
          width={250}
          align="end"
        >
          <div className="nb-db-pop-header">
            <span className="nb-db-pop-title">看板分组依据</span>
          </div>
          {groupableColumns.length === 0 ? (
            <div className="nb-db-pop-empty">
              <p>当前数据库没有「状态」或「单选」属性列。</p>
              <button
                type="button"
                className="nb-db-primary-btn nb-db-full-width"
                onClick={() => {
                  onCreateDefaultStatusColumn();
                  setOpenMenu(null);
                }}
              >
                <Plus size={14} />
                <span>自动创建「状态」列</span>
              </button>
            </div>
          ) : (
            <div className="nb-db-pop-list">
              {groupableColumns.map((col) => {
                const selected = activeGroupCol?.id === col.id;
                return (
                  <button
                    key={col.id}
                    type="button"
                    className={`nb-db-pop-item ${selected ? "is-selected" : ""}`}
                    onClick={() => {
                      onChangeGroupBy(col.id);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="nb-db-pop-item-left">
                      <ColumnIcon colType={col.colType} size={14} />
                      <span>{col.name}</span>
                    </span>
                    {selected && <Check size={14} className="nb-db-accent-icon" />}
                  </button>
                );
              })}
              <div className="nb-db-pop-divider" />
              <button
                type="button"
                className="nb-db-pop-item"
                onClick={() => {
                  onCreateDefaultStatusColumn();
                  setOpenMenu(null);
                }}
              >
                <span className="nb-db-pop-item-left">
                  <Plus size={14} />
                  <span>新建状态属性列</span>
                </span>
              </button>
            </div>
          )}
        </FloatingPopover>
      )}

      {/* Filter Popover */}
      {openMenu === "filter" && (
        <FloatingPopover
          anchorEl={filterBtnRef.current}
          onClose={() => setOpenMenu(null)}
          width={440}
          align="end"
        >
          <div className="nb-db-pop-header">
            <span className="nb-db-pop-title">筛选条件</span>
            {filters.length > 0 && (
              <button
                type="button"
                className="nb-db-pop-link-btn"
                onClick={() => onFiltersChange([])}
              >
                清空全部
              </button>
            )}
          </div>

          {filters.length === 0 ? (
            <div className="nb-db-pop-hint">
              尚未添加筛选规则，点击下方按钮按任意属性过滤记录。
            </div>
          ) : (
            <div className="nb-db-rule-list">
              {filters.map((rule, idx) => {
                const ruleCol = columns.find((c) => c.id === rule.colId);
                const hideValueInput = NO_VALUE_OPERATORS.has(rule.operator);
                const hasSelectOptions =
                  !hideValueInput &&
                  ruleCol &&
                  (ruleCol.colType === "status" ||
                    ruleCol.colType === "select" ||
                    ruleCol.colType === "multi_select") &&
                  ruleCol.options.length > 0;

                return (
                  <div key={rule.id} className="nb-db-rule-block">
                    <div className="nb-db-rule-row">
                      <span className="nb-db-rule-conjunction">
                        {idx === 0 ? "当" : "且"}
                      </span>
                      <select
                        className="nb-db-select"
                        value={rule.colId}
                        onChange={(e) =>
                          handleUpdateFilter(rule.id, { colId: e.target.value })
                        }
                      >
                        {columns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>

                      <select
                        className="nb-db-select"
                        value={rule.operator}
                        onChange={(e) =>
                          handleUpdateFilter(rule.id, {
                            operator: e.target.value as FilterOperator,
                          })
                        }
                      >
                        {ALL_OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {FILTER_OPERATOR_LABELS[op]}
                          </option>
                        ))}
                      </select>

                      {!hideValueInput && (
                        <input
                          type={ruleCol?.colType === "date" ? "date" : "text"}
                          className="nb-db-input nb-db-rule-input"
                          placeholder="输入匹配值..."
                          value={rule.value}
                          onChange={(e) =>
                            handleUpdateFilter(rule.id, {
                              value: e.target.value,
                            })
                          }
                        />
                      )}

                      <button
                        type="button"
                        className="nb-db-icon-btn"
                        onClick={() => handleRemoveFilter(rule.id)}
                        title="移除此筛选条件"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {hasSelectOptions && ruleCol && (
                      <div className="nb-db-rule-QuickOpts">
                        {ruleCol.options.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
                              opt.color
                            )} nb-db-pill-clickable ${
                              rule.value === opt.label ? "is-ring" : ""
                            }`}
                            onClick={() =>
                              handleUpdateFilter(rule.id, { value: opt.label })
                            }
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="nb-db-pop-footer">
            <button
              type="button"
              className="nb-db-ghost-btn"
              onClick={handleAddFilter}
            >
              <Plus size={14} />
              <span>添加筛选条件</span>
            </button>
          </div>
        </FloatingPopover>
      )}

      {/* Sort Popover */}
      {openMenu === "sort" && (
        <FloatingPopover
          anchorEl={sortBtnRef.current}
          onClose={() => setOpenMenu(null)}
          width={340}
          align="end"
        >
          <div className="nb-db-pop-header">
            <span className="nb-db-pop-title">排序规则</span>
            {sorts.length > 0 && (
              <button
                type="button"
                className="nb-db-pop-link-btn"
                onClick={() => onSortsChange([])}
              >
                清空排序
              </button>
            )}
          </div>

          {sorts.length === 0 ? (
            <div className="nb-db-pop-hint">
              当前按默认顺序排列，可添加按任意属性升序或降序规则。
            </div>
          ) : (
            <div className="nb-db-rule-list">
              {sorts.map((sort) => (
                <div key={sort.id} className="nb-db-rule-row">
                  <select
                    className="nb-db-select nb-db-flex-1"
                    value={sort.colId}
                    onChange={(e) =>
                      handleUpdateSort(sort.id, { colId: e.target.value })
                    }
                  >
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>

                  <select
                    className="nb-db-select"
                    value={sort.direction}
                    onChange={(e) =>
                      handleUpdateSort(sort.id, {
                        direction: e.target.value as SortDirection,
                      })
                    }
                  >
                    <option value="asc">升序 (A → Z / ↑)</option>
                    <option value="desc">降序 (Z → A / ↓)</option>
                  </select>

                  <button
                    type="button"
                    className="nb-db-icon-btn"
                    onClick={() => handleRemoveSort(sort.id)}
                    title="移除此排序规则"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="nb-db-pop-footer">
            <button
              type="button"
              className="nb-db-ghost-btn"
              onClick={handleAddSort}
            >
              <Plus size={14} />
              <span>添加排序规则</span>
            </button>
          </div>
        </FloatingPopover>
      )}
    </div>
  );
};
