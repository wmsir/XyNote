import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Calendar as CalendarIcon,
  Check,
  ExternalLink,
  FileText,
  Plus,
  X,
} from "lucide-react";
import type { DbColumn, DbRow, SelectOption } from "../../types/notion";
import {
  findSelectOption,
  formatDateFriendly,
  generateLocalId,
  getOffsetDateISO,
  getOptionWriteValue,
  isCheckboxChecked,
  normalizeExternalUrl,
  normalizeOptionColor,
  pickNextOptionColor,
  resolveMultiSelectOptions,
  toDateInputValue,
} from "./dbUtils";
import { FloatingPopover } from "./ColumnIcon";

export interface CellEditorProps {
  row: DbRow;
  col: DbColumn;
  allRows: DbRow[];
  variant?: "table" | "drawer";
  onUpdateCell: (
    rowId: string,
    colId: string,
    value: unknown,
    immediate?: boolean
  ) => void;
  onAddColumnOption: (col: DbColumn, newOption: SelectOption) => void;
  onOpenOrCreateLinkedPage?: (row: DbRow) => void;
  onOpenRowDrawer?: (rowId: string) => void;
}

export const CellEditor: React.FC<CellEditorProps> = ({
  row,
  col,
  allRows,
  variant = "table",
  onUpdateCell,
  onAddColumnOption,
  onOpenOrCreateLinkedPage,
  onOpenRowDrawer,
}) => {
  const rawValue = row.cells[col.id];

  // Local text draft for smooth Chinese IME & zero cursor jump on text/title/number/url
  const toDisplayString = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    return String(v);
  };

  const [draft, setDraft] = useState<string>(() => toDisplayString(rawValue));
  const isFocusedRef = useRef(false);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraft(toDisplayString(rawValue));
    }
  }, [rawValue, row.id]);

  // Popover state for status / select / multi_select / date
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [optionQuery, setOptionQuery] = useState("");
  const cellAnchorRef = useRef<HTMLDivElement | null>(null);

  // 1. CHECKBOX
  if (col.colType === "checkbox") {
    const checked = isCheckboxChecked(rawValue);
    return (
      <div
        className={`nb-db-cell nb-db-cell-checkbox ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          className={`nb-db-checkbox ${checked ? "is-checked" : ""}`}
          onClick={() => onUpdateCell(row.id, col.id, !checked, true)}
        >
          {checked && <Check size={12} strokeWidth={3} />}
        </button>
      </div>
    );
  }

  // 2. STATUS & SELECT
  if (col.colType === "status" || col.colType === "select") {
    const selectedOpt = findSelectOption(col, rawValue, true);
    const trimmedQuery = optionQuery.trim();
    const filteredOptions = col.options.filter((o) =>
      o.label.toLowerCase().includes(trimmedQuery.toLowerCase())
    );
    const exactExists = col.options.some(
      (o) => o.label.toLowerCase() === trimmedQuery.toLowerCase()
    );

    const handleSelectOption = (opt: SelectOption) => {
      const writeVal = getOptionWriteValue(col, opt, allRows);
      onUpdateCell(row.id, col.id, writeVal, true);
      setOptionQuery("");
      setPopoverOpen(false);
    };

    const handleCreateAndSelect = () => {
      if (!trimmedQuery) return;
      const newOpt: SelectOption = {
        id: generateLocalId("opt"),
        label: trimmedQuery,
        color: pickNextOptionColor(col.options.length),
      };
      onAddColumnOption(col, newOpt);
      const writeVal = getOptionWriteValue(col, newOpt, allRows);
      onUpdateCell(row.id, col.id, writeVal, true);
      setOptionQuery("");
      setPopoverOpen(false);
    };

    return (
      <div
        ref={cellAnchorRef}
        className={`nb-db-cell nb-db-cell-clickable ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
        onClick={() => setPopoverOpen(true)}
      >
        {selectedOpt ? (
          <span
            className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
              selectedOpt.color
            )}`}
          >
            {col.colType === "status" && <span className="nb-db-pill-dot" />}
            <span>{selectedOpt.label}</span>
          </span>
        ) : (
          <span className="nb-db-cell-placeholder">
            {variant === "drawer" ? "选择选项..." : ""}
          </span>
        )}

        {popoverOpen && (
          <FloatingPopover
            anchorEl={cellAnchorRef.current}
            onClose={() => {
              setPopoverOpen(false);
              setOptionQuery("");
            }}
            width={236}
          >
            <div className="nb-db-opt-search-wrap">
              <input
                type="text"
                className="nb-db-input"
                placeholder="搜索或新建选项..."
                autoFocus
                value={optionQuery}
                onChange={(e) => setOptionQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (filteredOptions.length > 0 && exactExists) {
                      handleSelectOption(filteredOptions[0]);
                    } else if (trimmedQuery) {
                      handleCreateAndSelect();
                    }
                  }
                }}
              />
            </div>

            <div className="nb-db-pop-list">
              {filteredOptions.map((opt) => {
                const isSelected = selectedOpt?.id === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`nb-db-pop-item ${
                      isSelected ? "is-selected" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectOption(opt);
                    }}
                  >
                    <span
                      className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
                        opt.color
                      )}`}
                    >
                      {col.colType === "status" && (
                        <span className="nb-db-pill-dot" />
                      )}
                      <span>{opt.label}</span>
                    </span>
                    {isSelected && (
                      <Check size={14} className="nb-db-accent-icon" />
                    )}
                  </button>
                );
              })}

              {trimmedQuery && !exactExists && (
                <button
                  type="button"
                  className="nb-db-pop-item nb-db-create-opt-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateAndSelect();
                  }}
                >
                  <span className="nb-db-pop-item-left">
                    <Plus size={13} />
                    <span>创建</span>
                    <span
                      className={`nb-db-pill nb-db-pill-${pickNextOptionColor(
                        col.options.length
                      )}`}
                    >
                      {trimmedQuery}
                    </span>
                  </span>
                </button>
              )}

              {selectedOpt && (
                <>
                  <div className="nb-db-pop-divider" />
                  <button
                    type="button"
                    className="nb-db-pop-item nb-db-muted-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdateCell(row.id, col.id, "", true);
                      setPopoverOpen(false);
                    }}
                  >
                    <span className="nb-db-pop-item-left">
                      <X size={13} />
                      <span>清除选择</span>
                    </span>
                  </button>
                </>
              )}
            </div>
          </FloatingPopover>
        )}
      </div>
    );
  }

  // 3. MULTI-SELECT
  if (col.colType === "multi_select") {
    const selectedOpts = resolveMultiSelectOptions(col, rawValue);
    const trimmedQuery = optionQuery.trim();
    const filteredOptions = col.options.filter((o) =>
      o.label.toLowerCase().includes(trimmedQuery.toLowerCase())
    );
    const exactExists = col.options.some(
      (o) => o.label.toLowerCase() === trimmedQuery.toLowerCase()
    );

    const writeOptionsList = (nextOpts: SelectOption[]) => {
      const nextValues = nextOpts.map((o) =>
        getOptionWriteValue(col, o, allRows)
      );
      onUpdateCell(row.id, col.id, nextValues, true);
    };

    const handleToggleMultiOpt = (opt: SelectOption) => {
      const exists = selectedOpts.some((s) => s.id === opt.id);
      const nextOpts = exists
        ? selectedOpts.filter((s) => s.id !== opt.id)
        : [...selectedOpts, opt];
      writeOptionsList(nextOpts);
    };

    const handleRemoveTag = (e: React.MouseEvent, optId: string) => {
      e.stopPropagation();
      const nextOpts = selectedOpts.filter((s) => s.id !== optId);
      writeOptionsList(nextOpts);
    };

    const handleCreateMultiTag = () => {
      if (!trimmedQuery) return;
      const newOpt: SelectOption = {
        id: generateLocalId("tag"),
        label: trimmedQuery,
        color: pickNextOptionColor(col.options.length),
      };
      onAddColumnOption(col, newOpt);
      writeOptionsList([...selectedOpts, newOpt]);
      setOptionQuery("");
    };

    return (
      <div
        ref={cellAnchorRef}
        className={`nb-db-cell nb-db-cell-clickable nb-db-cell-multiselect ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
        onClick={() => setPopoverOpen(true)}
      >
        {selectedOpts.length > 0 ? (
          <div className="nb-db-tag-wrap">
            {selectedOpts.map((opt) => (
              <span
                key={opt.id}
                className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
                  opt.color
                )}`}
              >
                <span>{opt.label}</span>
                <button
                  type="button"
                  className="nb-db-pill-remove"
                  onClick={(e) => handleRemoveTag(e, opt.id)}
                  title={`移除 ${opt.label}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="nb-db-cell-placeholder">
            {variant === "drawer" ? "添加标签..." : ""}
          </span>
        )}

        {popoverOpen && (
          <FloatingPopover
            anchorEl={cellAnchorRef.current}
            onClose={() => {
              setPopoverOpen(false);
              setOptionQuery("");
            }}
            width={256}
          >
            <div className="nb-db-opt-search-wrap">
              <input
                type="text"
                className="nb-db-input"
                placeholder="搜索或新建标签..."
                autoFocus
                value={optionQuery}
                onChange={(e) => setOptionQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (filteredOptions.length > 0 && exactExists) {
                      handleToggleMultiOpt(filteredOptions[0]);
                      setOptionQuery("");
                    } else if (trimmedQuery) {
                      handleCreateMultiTag();
                    }
                  }
                }}
              />
            </div>

            <div className="nb-db-pop-list">
              {filteredOptions.map((opt) => {
                const isSelected = selectedOpts.some((s) => s.id === opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`nb-db-pop-item ${
                      isSelected ? "is-selected" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleMultiOpt(opt);
                    }}
                  >
                    <span
                      className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
                        opt.color
                      )}`}
                    >
                      {opt.label}
                    </span>
                    {isSelected && (
                      <Check size={14} className="nb-db-accent-icon" />
                    )}
                  </button>
                );
              })}

              {trimmedQuery && !exactExists && (
                <button
                  type="button"
                  className="nb-db-pop-item nb-db-create-opt-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateMultiTag();
                  }}
                >
                  <span className="nb-db-pop-item-left">
                    <Plus size={13} />
                    <span>新建标签</span>
                    <span
                      className={`nb-db-pill nb-db-pill-${pickNextOptionColor(
                        col.options.length
                      )}`}
                    >
                      {trimmedQuery}
                    </span>
                  </span>
                </button>
              )}
            </div>
          </FloatingPopover>
        )}
      </div>
    );
  }

  // 4. DATE
  if (col.colType === "date") {
    const dateVal = toDateInputValue(rawValue);
    const formatted = formatDateFriendly(rawValue);

    return (
      <div
        ref={cellAnchorRef}
        className={`nb-db-cell nb-db-cell-clickable nb-db-cell-date ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
        onClick={() => setPopoverOpen(true)}
      >
        {formatted ? (
          <span className="nb-db-date-badge">
            <CalendarIcon size={13} className="nb-db-muted-icon" />
            <span>{formatted}</span>
          </span>
        ) : (
          <span className="nb-db-cell-placeholder">
            {variant === "drawer" ? "选择日期..." : ""}
          </span>
        )}

        {popoverOpen && (
          <FloatingPopover
            anchorEl={cellAnchorRef.current}
            onClose={() => setPopoverOpen(false)}
            width={236}
          >
            <div className="nb-db-pop-header">
              <span className="nb-db-pop-title">选择日期</span>
            </div>
            <div className="nb-db-date-pop-body" onClick={(e) => e.stopPropagation()}>
              <input
                type="date"
                className="nb-db-input nb-db-full-width"
                value={dateVal}
                autoFocus
                onChange={(e) => {
                  onUpdateCell(row.id, col.id, e.target.value || null, true);
                }}
              />
              <div className="nb-db-date-presets">
                <button
                  type="button"
                  className="nb-db-chip-btn"
                  onClick={() => {
                    onUpdateCell(row.id, col.id, getOffsetDateISO(0), true);
                    setPopoverOpen(false);
                  }}
                >
                  今天
                </button>
                <button
                  type="button"
                  className="nb-db-chip-btn"
                  onClick={() => {
                    onUpdateCell(row.id, col.id, getOffsetDateISO(1), true);
                    setPopoverOpen(false);
                  }}
                >
                  明天
                </button>
                <button
                  type="button"
                  className="nb-db-chip-btn"
                  onClick={() => {
                    onUpdateCell(row.id, col.id, getOffsetDateISO(7), true);
                    setPopoverOpen(false);
                  }}
                >
                  下周
                </button>
                {formatted && (
                  <button
                    type="button"
                    className="nb-db-chip-btn is-danger"
                    onClick={() => {
                      onUpdateCell(row.id, col.id, null, true);
                      setPopoverOpen(false);
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          </FloatingPopover>
        )}
      </div>
    );
  }

  // 5. NUMBER
  if (col.colType === "number") {
    const commitNumber = (text: string, immediate: boolean) => {
      const trimmed = text.trim();
      if (!trimmed) {
        onUpdateCell(row.id, col.id, null, immediate);
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isNaN(parsed)) {
        onUpdateCell(row.id, col.id, parsed, immediate);
      }
    };

    return (
      <div
        className={`nb-db-cell nb-db-cell-number ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          className="nb-db-inline-input nb-db-number-input"
          placeholder={variant === "drawer" ? "输入数字..." : ""}
          value={draft}
          onFocus={() => {
            isFocusedRef.current = true;
          }}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" || /^-?\d*\.?\d*$/.test(val)) {
              setDraft(val);
              commitNumber(val, false);
            }
          }}
          onBlur={() => {
            isFocusedRef.current = false;
            commitNumber(draft, true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
    );
  }

  // 6. URL
  if (col.colType === "url") {
    const validHref = draft.trim() ? normalizeExternalUrl(draft) : "";
    return (
      <div
        className={`nb-db-cell nb-db-cell-url ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
      >
        <input
          type="text"
          className="nb-db-inline-input nb-db-url-input"
          placeholder={variant === "drawer" ? "https://..." : ""}
          value={draft}
          onFocus={() => {
            isFocusedRef.current = true;
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const next = e.currentTarget.value;
            setDraft(next);
            onUpdateCell(row.id, col.id, next, false);
          }}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (!isComposingRef.current) {
              onUpdateCell(row.id, col.id, next, false);
            }
          }}
          onBlur={() => {
            isFocusedRef.current = false;
            onUpdateCell(row.id, col.id, draft.trim(), true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isComposingRef.current) {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {validHref && (
          <a
            href={validHref}
            target="_blank"
            rel="noopener noreferrer"
            className="nb-db-url-open-btn"
            title={`打开外部链接: ${validHref}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    );
  }

  // 7. TITLE (with hover "打开页面" button!)
  if (col.colType === "title") {
    return (
      <div
        className={`nb-db-cell nb-db-cell-title ${
          variant === "drawer" ? "is-drawer" : ""
        }`}
      >
        {row.linkedPageId && (
          <span
            className="nb-db-linked-doc-indicator"
            title="已关联独立 Notion 页面"
          >
            <FileText size={14} />
          </span>
        )}
        <input
          type="text"
          className="nb-db-inline-input nb-db-title-input"
          placeholder="未命名"
          value={draft}
          onFocus={() => {
            isFocusedRef.current = true;
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const next = e.currentTarget.value;
            setDraft(next);
            onUpdateCell(row.id, col.id, next, false);
          }}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (!isComposingRef.current) {
              onUpdateCell(row.id, col.id, next, false);
            }
          }}
          onBlur={() => {
            isFocusedRef.current = false;
            onUpdateCell(row.id, col.id, draft, true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isComposingRef.current) {
              (e.target as HTMLInputElement).blur();
            }
          }}
        />

        {variant === "table" && (
          <div className="nb-db-title-hover-actions">
            {onOpenRowDrawer && (
              <button
                type="button"
                className="nb-db-open-page-btn is-subtle"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenRowDrawer(row.id);
                }}
                title="侧边预览属性"
              >
                <span>详情</span>
              </button>
            )}
            {onOpenOrCreateLinkedPage && (
              <button
                type="button"
                className="nb-db-open-page-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenOrCreateLinkedPage(row);
                }}
                title={
                  row.linkedPageId
                    ? "打开关联页面"
                    : "创建并打开完整 Notion 页面"
                }
              >
                <ArrowUpRight size={13} />
                <span>打开页面</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // 8. TEXT (default)
  return (
    <div
      className={`nb-db-cell nb-db-cell-text ${
        variant === "drawer" ? "is-drawer" : ""
      }`}
    >
      <input
        type="text"
        className="nb-db-inline-input"
        placeholder={variant === "drawer" ? "输入文本..." : ""}
        value={draft}
        onFocus={() => {
          isFocusedRef.current = true;
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          const next = e.currentTarget.value;
          setDraft(next);
          onUpdateCell(row.id, col.id, next, false);
        }}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (!isComposingRef.current) {
            onUpdateCell(row.id, col.id, next, false);
          }
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          onUpdateCell(row.id, col.id, draft, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isComposingRef.current) {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
};
