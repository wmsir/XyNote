import React, { useMemo, useState } from "react";
import { RotateCcw, Search, Trash2, X } from "lucide-react";
import type { Page } from "../../types/notion";

export interface TrashModalProps {
  open: boolean;
  trashedPages: Page[];
  onClose: () => void;
  onRestore: (pageId: string) => void;
  onDeletePermanent: (pageId: string) => void;
  onEmptyTrash: () => void;
}

export const TrashModal: React.FC<TrashModalProps> = ({
  open,
  trashedPages,
  onClose,
  onRestore,
  onDeletePermanent,
  onEmptyTrash,
}) => {
  const [filter, setFilter] = useState("");
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return trashedPages;
    return trashedPages.filter((p) => p.title.toLowerCase().includes(q));
  }, [filter, trashedPages]);

  if (!open) return null;

  return (
    <div
      className="nb-modal-backdrop"
      onMouseDown={() => {
        setConfirmEmpty(false);
        onClose();
      }}
    >
      <div
        className="nb-modal-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Trash2 size={17} />
            <span>回收站 ({trashedPages.length})</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {trashedPages.length > 0 && (
              <button
                type="button"
                className="nb-btn-danger"
                onClick={() => {
                  if (!confirmEmpty) {
                    setConfirmEmpty(true);
                  } else {
                    setConfirmEmpty(false);
                    onEmptyTrash();
                  }
                }}
              >
                {confirmEmpty ? "确认彻底清空？" : "清空回收站"}
              </button>
            )}
            <button
              type="button"
              className="nb-icon-btn"
              onClick={() => {
                setConfirmEmpty(false);
                onClose();
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="nb-cmd-input-row">
          <Search size={16} style={{ color: "var(--text-tertiary)" }} />
          <input
            type="text"
            className="nb-cmd-input"
            placeholder="在回收站中筛选已删除页面..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <div className="nb-cmd-list" style={{ minHeight: "220px" }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "48px 16px",
                textAlign: "center",
                color: "var(--text-tertiary)",
              }}
            >
              {trashedPages.length === 0
                ? "回收站为空，删除的页面会暂存在这里"
                : "没有匹配的已删除页面"}
            </div>
          ) : (
            filtered.map((item) => (
              <div
                key={item.id}
                className="nb-cmd-item"
                style={{ justifyContent: "space-between" }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  <span style={{ fontSize: "18px" }}>{item.icon || "📄"}</span>
                  <div className="nb-cmd-item-body">
                    <div className="nb-cmd-item-title">
                      {item.title || "无标题"}
                    </div>
                    <div className="nb-cmd-item-snippet">
                      删除时间：{item.updatedAt.slice(0, 16).replace("T", " ")}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                  <button
                    type="button"
                    className="nb-btn-secondary"
                    onClick={() => onRestore(item.id)}
                    title="还原至工作区"
                  >
                    <RotateCcw size={13} /> 还原
                  </button>
                  <button
                    type="button"
                    className="nb-btn-danger"
                    onClick={() => onDeletePermanent(item.id)}
                    title="彻底删除，不可恢复"
                  >
                    <Trash2 size={13} /> 永久删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
