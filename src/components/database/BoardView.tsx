import React, { useState } from "react";
import {
  ArrowUpRight,
  Columns3,
  FileText,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import type { DbColumn, DbRow, SelectOption } from "../../types/notion";
import {
  findSelectOption,
  generateLocalId,
  getOptionWriteValue,
  getRowTitle,
  normalizeOptionColor,
  pickNextOptionColor,
} from "./dbUtils";
import { CardBadges } from "./CardBadges";

export interface BoardViewProps {
  columns: DbColumn[];
  rows: DbRow[];
  allRows: DbRow[];
  groupByColId: string | null;
  onUpdateCell: (
    rowId: string,
    colId: string,
    value: unknown,
    immediate?: boolean
  ) => void;
  onAddColumnOption: (col: DbColumn, newOption: SelectOption) => void;
  onCreateDefaultStatusColumn: () => void;
  onCreateRowWithCells: (
    initialCells: Record<string, unknown>,
    openDrawer?: boolean
  ) => void;
  onDeleteRow: (rowId: string) => void;
  onOpenOrCreateLinkedPage: (row: DbRow) => void;
  onOpenRowDrawer: (rowId: string) => void;
}

const UNGROUPED_ID = "__nb_ungrouped__";

interface KanbanBucket {
  id: string;
  label: string;
  color: string;
  option: SelectOption | null;
  items: DbRow[];
}

export const BoardView: React.FC<BoardViewProps> = ({
  columns,
  rows,
  allRows,
  groupByColId,
  onUpdateCell,
  onAddColumnOption,
  onCreateDefaultStatusColumn,
  onCreateRowWithCells,
  onDeleteRow,
  onOpenOrCreateLinkedPage,
  onOpenRowDrawer,
}) => {
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragOverBucketId, setDragOverBucketId] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupLabel, setNewGroupLabel] = useState("");

  const groupableCols = columns.filter(
    (c) => c.colType === "status" || c.colType === "select"
  );
  const groupCol =
    groupableCols.find((c) => c.id === groupByColId) ?? groupableCols[0];

  if (!groupCol) {
    return (
      <div className="nb-db-board-empty-schema">
        <div className="nb-db-board-empty-card">
          <Columns3 size={28} className="nb-db-muted-icon" />
          <h3>看板视图需要「状态」或「单选」属性列</h3>
          <p>
            自动创建一个带有「待开始 / 进行中 / 已完成」选项的状态列，即可启用拖拽看板。
          </p>
          <button
            type="button"
            className="nb-db-primary-btn"
            onClick={onCreateDefaultStatusColumn}
          >
            <Plus size={15} />
            <span>创建「状态」属性列</span>
          </button>
        </div>
      </div>
    );
  }

  // Partition rows into option buckets + ungrouped bucket
  const bucketMap = new Map<string, DbRow[]>();
  for (const opt of groupCol.options) {
    bucketMap.set(opt.id, []);
  }
  const ungroupedRows: DbRow[] = [];

  for (const row of rows) {
    const raw = row.cells[groupCol.id];
    const matched = findSelectOption(groupCol, raw, false);
    if (matched && bucketMap.has(matched.id)) {
      bucketMap.get(matched.id)!.push(row);
    } else {
      ungroupedRows.push(row);
    }
  }

  const buckets: KanbanBucket[] = groupCol.options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    color: normalizeOptionColor(opt.color),
    option: opt,
    items: bucketMap.get(opt.id) ?? [],
  }));

  // Include "未分组" bucket whenever there are ungrouped rows, no options, or while dragging
  if (
    ungroupedRows.length > 0 ||
    buckets.length === 0 ||
    draggingRowId !== null
  ) {
    buckets.push({
      id: UNGROUPED_ID,
      label: "未分组",
      color: "gray",
      option: null,
      items: ungroupedRows,
    });
  }

  const handleDropOnBucket = (e: React.DragEvent, bucket: KanbanBucket) => {
    e.preventDefault();
    const transferredId = e.dataTransfer.getData("text/plain");
    const targetRowId = transferredId || draggingRowId;
    setDragOverBucketId(null);
    setDraggingRowId(null);

    if (!targetRowId) return;
    const nextVal = bucket.option
      ? getOptionWriteValue(groupCol, bucket.option, allRows)
      : "";
    onUpdateCell(targetRowId, groupCol.id, nextVal, true);
  };

  const handleCreateGroup = () => {
    const trimmed = newGroupLabel.trim();
    if (!trimmed) {
      setAddingGroup(false);
      return;
    }
    const newOpt: SelectOption = {
      id: generateLocalId("opt"),
      label: trimmed,
      color: pickNextOptionColor(groupCol.options.length),
    };
    onAddColumnOption(groupCol, newOpt);
    setNewGroupLabel("");
    setAddingGroup(false);
  };

  return (
    <div className="nb-db-board-scroll">
      <div className="nb-db-board-lanes">
        {buckets.map((bucket) => {
          const isDropTarget = dragOverBucketId === bucket.id;
          return (
            <div
              key={bucket.id}
              className={`nb-db-kanban-col ${
                isDropTarget ? "is-drag-over" : ""
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverBucketId !== bucket.id) {
                  setDragOverBucketId(bucket.id);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragOverBucketId((prev) =>
                    prev === bucket.id ? null : prev
                  );
                }
              }}
              onDrop={(e) => handleDropOnBucket(e, bucket)}
            >
              {/* Column Header */}
              <div className="nb-db-kanban-header">
                <div className="nb-db-kanban-header-left">
                  <span className={`nb-db-pill nb-db-pill-${bucket.color}`}>
                    {groupCol.colType === "status" && (
                      <span className="nb-db-pill-dot" />
                    )}
                    <span>{bucket.label}</span>
                  </span>
                  <span className="nb-db-kanban-count">
                    {bucket.items.length}
                  </span>
                </div>

                <button
                  type="button"
                  className="nb-db-icon-btn"
                  title={`在「${bucket.label}」中新建记录`}
                  onClick={() => {
                    const cells: Record<string, unknown> = bucket.option
                      ? {
                          [groupCol.id]: getOptionWriteValue(
                            groupCol,
                            bucket.option,
                            allRows
                          ),
                        }
                      : {};
                    onCreateRowWithCells(cells, true);
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* Cards Stack */}
              <div className="nb-db-kanban-cards">
                {bucket.items.map((row) => {
                  const title = getRowTitle(row, columns);
                  const isDragging = draggingRowId === row.id;

                  return (
                    <div
                      key={row.id}
                      draggable
                      className={`nb-db-kanban-card ${
                        isDragging ? "is-dragging" : ""
                      }`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", row.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingRowId(row.id);
                      }}
                      onDragEnd={() => {
                        setDraggingRowId(null);
                        setDragOverBucketId(null);
                      }}
                      onClick={() => onOpenRowDrawer(row.id)}
                    >
                      <div className="nb-db-card-top">
                        <div className="nb-db-card-title-row">
                          <GripVertical
                            size={13}
                            className="nb-db-card-grip"
                          />
                          {row.linkedPageId && (
                            <FileText
                              size={13}
                              className="nb-db-card-doc-icon"
                            />
                          )}
                          <span
                            className={`nb-db-card-title ${
                              !title ? "is-untitled" : ""
                            }`}
                          >
                            {title || "未命名"}
                          </span>
                        </div>

                        <div className="nb-db-card-hover-btns">
                          <button
                            type="button"
                            className="nb-db-card-action-btn"
                            title="打开关联 Notion 页面"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenOrCreateLinkedPage(row);
                            }}
                          >
                            <ArrowUpRight size={13} />
                          </button>
                          <button
                            type="button"
                            className="nb-db-card-action-btn is-danger"
                            title="删除记录"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteRow(row.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      <CardBadges
                        row={row}
                        columns={columns}
                        excludeColIds={[groupCol.id]}
                        onToggleCheckbox={(rId, cId, nextVal) =>
                          onUpdateCell(rId, cId, nextVal, true)
                        }
                      />
                    </div>
                  );
                })}
              </div>

              {/* Bottom "+ 新建" inside Kanban Column */}
              <button
                type="button"
                className="nb-db-kanban-new-btn"
                onClick={() => {
                  const cells: Record<string, unknown> = bucket.option
                    ? {
                        [groupCol.id]: getOptionWriteValue(
                          groupCol,
                          bucket.option,
                          allRows
                        ),
                      }
                    : {};
                  onCreateRowWithCells(cells, false);
                }}
              >
                <Plus size={14} />
                <span>新建</span>
              </button>
            </div>
          );
        })}

        {/* Add New Kanban Group Column */}
        <div className="nb-db-kanban-add-lane">
          {addingGroup ? (
            <div className="nb-db-kanban-add-form">
              <input
                type="text"
                className="nb-db-input"
                placeholder="输入新分组名称..."
                autoFocus
                value={newGroupLabel}
                onChange={(e) => setNewGroupLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreateGroup();
                  } else if (e.key === "Escape") {
                    setAddingGroup(false);
                    setNewGroupLabel("");
                  }
                }}
                onBlur={handleCreateGroup}
              />
            </div>
          ) : (
            <button
              type="button"
              className="nb-db-kanban-add-group-btn"
              onClick={() => setAddingGroup(true)}
            >
              <Plus size={14} />
              <span>新建分组</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
