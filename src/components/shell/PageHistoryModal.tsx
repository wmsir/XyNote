import React, { useEffect, useState } from "react";
import { PageIcon } from "../../icons/pageIcon";
import { History, RotateCcw, X } from "lucide-react";
import {
  getPageVersion,
  listPageVersions,
  restorePageVersion,
  type PageVersionMeta,
  type PageVersionView,
} from "../../api/pro";
import { relativeTime, syncErrorText } from "../../api/sync";

export interface PageHistoryModalProps {
  open: boolean;
  pageId: string | null;
  pageTitle: string;
  onClose: () => void;
  /** 恢复完成后由 App 刷新页面 */
  onRestored: (pageId: string) => Promise<void> | void;
  onNotify: (msg: string) => void;
}

const REASON_LABEL: Record<string, string> = {
  edit: "自动保存",
  sync: "同步覆盖前",
  restore: "恢复前",
};

function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function PageHistoryModal({
  open,
  pageId,
  pageTitle,
  onClose,
  onRestored,
  onNotify,
}: PageHistoryModalProps) {
  const [versions, setVersions] = useState<PageVersionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<PageVersionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !pageId) return;
    setVersions(null);
    setView(null);
    setError(null);
    listPageVersions(pageId)
      .then((v) => {
        setVersions(v);
        setSelected(v[0]?.id ?? null);
      })
      .catch((e) => setError(syncErrorText(e)));
  }, [open, pageId]);

  useEffect(() => {
    if (!selected) {
      setView(null);
      return;
    }
    let alive = true;
    getPageVersion(selected)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(syncErrorText(e)));
    return () => {
      alive = false;
    };
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const id = await restorePageVersion(selected);
      await onRestored(id);
      onNotify("已恢复到所选版本，恢复前的内容也保存在历史里");
      onClose();
    } catch (e) {
      setError(syncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nb-modal-card is-wide nb-history-card"
        role="dialog"
        aria-modal="true"
        aria-label="历史版本"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <History size={17} />
            <span>历史版本 · {pageTitle || "无标题"}</span>
          </div>
          <button type="button" className="nb-icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {(
          <div className="nb-history-body">
            <div className="nb-history-list" role="listbox" aria-label="版本列表">
              {versions === null && !error && <div className="nb-settings-sub nb-history-empty">正在读取…</div>}
              {versions?.length === 0 && (
                <div className="nb-settings-sub nb-history-empty">
                  还没有历史版本。编辑这篇笔记后，每隔约 10 分钟会自动保存一份。
                </div>
              )}
              {versions?.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="option"
                  aria-selected={selected === v.id}
                  className={`nb-history-item${selected === v.id ? " is-active" : ""}`}
                  onClick={() => setSelected(v.id)}
                >
                  <span className="nb-settings-label">{fullTime(v.createdAt)}</span>
                  <span className="nb-settings-sub">
                    {relativeTime(v.createdAt)} · {REASON_LABEL[v.reason] ?? v.reason}
                  </span>
                </button>
              ))}
            </div>

            <div className="nb-history-preview">
              {view ? (
                <>
                  <div className="nb-history-preview-title">
                    <PageIcon icon={view.icon} size={18} /> {view.meta.title || "无标题"}
                  </div>
                  <div className="nb-history-preview-body">
                    {view.isDatabase ? (
                      <div className="nb-settings-sub">
                        表格：{view.columnNames.join("、") || "无列"}，共 {view.rowCount} 行
                      </div>
                    ) : view.blocks.length === 0 ? (
                      <div className="nb-settings-sub">（空白页面）</div>
                    ) : (
                      view.blocks.map((b, i) => (
                        <p key={i} className={`nb-history-block is-${b.blockType}`}>
                          {b.text || " "}
                        </p>
                      ))
                    )}
                  </div>
                  <div className="nb-history-actions">
                    <span className="nb-settings-sub">恢复前会先保存当前内容，可以随时再恢复回来。</span>
                    <button type="button" className="nb-btn-primary" disabled={busy} onClick={restore}>
                      <RotateCcw size={14} />
                      {busy ? "正在恢复…" : "恢复此版本"}
                    </button>
                  </div>
                </>
              ) : (
                versions && versions.length > 0 && <div className="nb-settings-sub nb-history-empty">选择左侧的版本查看内容</div>
              )}
              {error && (
                <div className="nb-sync-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
