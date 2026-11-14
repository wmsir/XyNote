import React, { useState } from "react";
import {
  ArrowDownZA,
  ArrowUpAZ,
  Check,
  Palette,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  ColumnType,
  DbColumn,
  SelectOption,
  UpsertDbColumnInput,
} from "../../types/notion";
import {
  COLUMN_TYPE_LIST,
  NOTION_COLORS,
  SortDirection,
  generateLocalId,
  getDefaultOptionsForType,
  normalizeOptionColor,
  pickNextOptionColor,
} from "./dbUtils";
import { ColumnIcon, FloatingPopover } from "./ColumnIcon";

export interface ColumnSchemaPopoverProps {
  col: DbColumn;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onSaveColumn: (input: UpsertDbColumnInput) => void;
  onDeleteColumn: (colId: string) => void;
  onQuickSort: (colId: string, direction: SortDirection) => void;
}

export const ColumnSchemaPopover: React.FC<ColumnSchemaPopoverProps> = ({
  col,
  anchorEl,
  onClose,
  onSaveColumn,
  onDeleteColumn,
  onQuickSort,
}) => {
  const [nameDraft, setNameDraft] = useState(col.name);
  const [newOptLabel, setNewOptLabel] = useState("");
  const [colorPickerOptId, setColorPickerOptId] = useState<string | null>(null);
  const [typeSectionOpen, setTypeSectionOpen] = useState(false);

  const isTitle = col.colType === "title";
  const supportsOptions =
    col.colType === "status" ||
    col.colType === "select" ||
    col.colType === "multi_select";

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== col.name) {
      onSaveColumn({
        id: col.id,
        pageId: col.pageId,
        name: trimmed,
        colType: col.colType,
        options: col.options,
        width: col.width,
        sortOrder: col.sortOrder,
      });
    } else if (!trimmed) {
      setNameDraft(col.name);
    }
  };

  const handleSwitchType = (nextType: ColumnType) => {
    if (isTitle || nextType === col.colType) return;
    const nextOptions =
      (nextType === "status" ||
        nextType === "select" ||
        nextType === "multi_select") &&
      col.options.length === 0
        ? getDefaultOptionsForType(nextType)
        : col.options;

    onSaveColumn({
      id: col.id,
      pageId: col.pageId,
      name: nameDraft.trim() || col.name,
      colType: nextType,
      options: nextOptions,
      width: col.width,
      sortOrder: col.sortOrder,
    });
    setTypeSectionOpen(false);
  };

  const handleUpdateOptions = (nextOptions: SelectOption[]) => {
    onSaveColumn({
      id: col.id,
      pageId: col.pageId,
      name: nameDraft.trim() || col.name,
      colType: col.colType,
      options: nextOptions,
      width: col.width,
      sortOrder: col.sortOrder,
    });
  };

  const handleAddOption = () => {
    const label = newOptLabel.trim();
    if (!label) return;
    const nextOpt: SelectOption = {
      id: generateLocalId("opt"),
      label,
      color: pickNextOptionColor(col.options.length),
    };
    handleUpdateOptions([...col.options, nextOpt]);
    setNewOptLabel("");
  };

  const handleRenameOption = (optId: string, nextLabel: string) => {
    const trimmed = nextLabel.trim();
    if (!trimmed) return;
    handleUpdateOptions(
      col.options.map((o) => (o.id === optId ? { ...o, label: trimmed } : o))
    );
  };

  const handleRecolorOption = (optId: string, color: string) => {
    handleUpdateOptions(
      col.options.map((o) => (o.id === optId ? { ...o, color } : o))
    );
    setColorPickerOptId(null);
  };

  const handleRemoveOption = (optId: string) => {
    handleUpdateOptions(col.options.filter((o) => o.id !== optId));
  };

  const currentTypeMeta = COLUMN_TYPE_LIST.find((t) => t.type === col.colType);

  return (
    <FloatingPopover
      anchorEl={anchorEl}
      onClose={() => {
        commitName();
        onClose();
      }}
      width={284}
    >
      {/* Rename Column Input */}
      <div className="nb-db-col-pop-top">
        <div className="nb-db-col-name-edit">
          <ColumnIcon colType={col.colType} size={15} />
          <input
            type="text"
            className="nb-db-input"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitName();
                onClose();
              }
            }}
            placeholder="属性列名称..."
          />
        </div>
      </div>

      {/* Switch Property Type (non-title columns) */}
      {!isTitle && (
        <div className="nb-db-col-section">
          <button
            type="button"
            className="nb-db-pop-item"
            onClick={() => setTypeSectionOpen((v) => !v)}
          >
            <span className="nb-db-pop-item-left">
              <span className="nb-db-muted-label">属性类型</span>
            </span>
            <span className="nb-db-type-current">
              {currentTypeMeta?.label ?? col.colType}
            </span>
          </button>

          {typeSectionOpen && (
            <div className="nb-db-type-picker-list">
              {COLUMN_TYPE_LIST.filter((t) => t.creatable).map((meta) => {
                const active = meta.type === col.colType;
                return (
                  <button
                    key={meta.type}
                    type="button"
                    className={`nb-db-pop-item ${active ? "is-selected" : ""}`}
                    onClick={() => handleSwitchType(meta.type)}
                  >
                    <span className="nb-db-pop-item-left">
                      <ColumnIcon colType={meta.type} size={14} />
                      <span>{meta.label}</span>
                    </span>
                    {active && <Check size={14} className="nb-db-accent-icon" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Option Tag Manager for status / select / multi_select */}
      {supportsOptions && (
        <div className="nb-db-col-section">
          <div className="nb-db-col-section-label">选项配置</div>
          <div className="nb-db-opt-manager-list">
            {col.options.map((opt) => (
              <div key={opt.id} className="nb-db-opt-manager-item">
                <div className="nb-db-opt-manager-row">
                  <button
                    type="button"
                    className={`nb-db-color-dot nb-db-dot-${normalizeOptionColor(
                      opt.color
                    )}`}
                    title="切换标签颜色"
                    onClick={() =>
                      setColorPickerOptId((prev) =>
                        prev === opt.id ? null : opt.id
                      )
                    }
                  >
                    <Palette size={10} />
                  </button>
                  <input
                    type="text"
                    className="nb-db-opt-label-input"
                    defaultValue={opt.label}
                    onBlur={(e) => handleRenameOption(opt.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="nb-db-icon-btn"
                    title="删除选项"
                    onClick={() => handleRemoveOption(opt.id)}
                  >
                    <X size={13} />
                  </button>
                </div>

                {colorPickerOptId === opt.id && (
                  <div className="nb-db-color-swatches">
                    {NOTION_COLORS.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        className={`nb-db-swatch nb-db-dot-${c.key} ${
                          normalizeOptionColor(opt.color) === c.key
                            ? "is-active"
                            : ""
                        }`}
                        title={c.label}
                        onClick={() => handleRecolorOption(opt.id, c.key)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="nb-db-opt-add-row">
            <input
              type="text"
              className="nb-db-input nb-db-flex-1"
              placeholder="新增选项名称..."
              value={newOptLabel}
              onChange={(e) => setNewOptLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddOption();
                }
              }}
            />
            <button
              type="button"
              className="nb-db-ghost-btn"
              onClick={handleAddOption}
            >
              <Plus size={14} />
              <span>添加</span>
            </button>
          </div>
        </div>
      )}

      {/* Quick Sort & Delete Actions */}
      <div className="nb-db-pop-divider" />
      <div className="nb-db-pop-list">
        <button
          type="button"
          className="nb-db-pop-item"
          onClick={() => {
            onQuickSort(col.id, "asc");
            onClose();
          }}
        >
          <span className="nb-db-pop-item-left">
            <ArrowUpAZ size={14} />
            <span>按此列升序排列</span>
          </span>
        </button>
        <button
          type="button"
          className="nb-db-pop-item"
          onClick={() => {
            onQuickSort(col.id, "desc");
            onClose();
          }}
        >
          <span className="nb-db-pop-item-left">
            <ArrowDownZA size={14} />
            <span>按此列降序排列</span>
          </span>
        </button>

        {!isTitle && (
          <>
            <div className="nb-db-pop-divider" />
            <button
              type="button"
              className="nb-db-pop-item is-danger"
              onClick={() => {
                onDeleteColumn(col.id);
                onClose();
              }}
            >
              <span className="nb-db-pop-item-left">
                <Trash2 size={14} />
                <span>删除属性列</span>
              </span>
            </button>
          </>
        )}
      </div>
    </FloatingPopover>
  );
};

export interface AddColumnPopoverProps {
  pageId: string;
  existingColumns: DbColumn[];
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onCreateColumn: (input: UpsertDbColumnInput) => void;
}

export const AddColumnPopover: React.FC<AddColumnPopoverProps> = ({
  pageId,
  existingColumns,
  anchorEl,
  onClose,
  onCreateColumn,
}) => {
  const [customName, setCustomName] = useState("");

  const buildUniqueColumnName = (baseName: string): string => {
    const existingNames = new Set(existingColumns.map((c) => c.name));
    if (!existingNames.has(baseName)) return baseName;
    let idx = 2;
    while (existingNames.has(`${baseName} ${idx}`)) {
      idx++;
    }
    return `${baseName} ${idx}`;
  };

  const handleSelectNewType = (colType: ColumnType, defaultName: string) => {
    const chosenName =
      customName.trim() || buildUniqueColumnName(defaultName);
    const nextOrder =
      existingColumns.reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1;

    onCreateColumn({
      pageId,
      name: chosenName,
      colType,
      options: getDefaultOptionsForType(colType),
      width: colType === "checkbox" ? 110 : 180,
      sortOrder: nextOrder,
    });
    onClose();
  };

  return (
    <FloatingPopover
      anchorEl={anchorEl}
      onClose={onClose}
      width={248}
      align="end"
    >
      <div className="nb-db-pop-header">
        <span className="nb-db-pop-title">新建属性列</span>
      </div>
      <div className="nb-db-opt-search-wrap">
        <input
          type="text"
          className="nb-db-input"
          placeholder="属性名称（可选，留空自动命名）"
          autoFocus
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && customName.trim()) {
              handleSelectNewType("text", customName.trim());
            }
          }}
        />
      </div>
      <div className="nb-db-col-section-label">选择属性类型</div>
      <div className="nb-db-pop-list">
        {COLUMN_TYPE_LIST.filter((m) => m.creatable).map((meta) => (
          <button
            key={meta.type}
            type="button"
            className="nb-db-pop-item"
            onClick={() => handleSelectNewType(meta.type, meta.defaultName)}
          >
            <span className="nb-db-pop-item-left">
              <ColumnIcon colType={meta.type} size={14} />
              <span>{meta.label}</span>
            </span>
          </button>
        ))}
      </div>
    </FloatingPopover>
  );
};
