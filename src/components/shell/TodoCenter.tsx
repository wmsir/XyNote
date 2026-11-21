import React, { useMemo, useState } from "react";
import { Check, ListTodo, RefreshCw, X } from "lucide-react";
import type { TodoItem } from "../../types/notion";
import { dueBucket, parseDue, type DueBucket } from "../../utils/dueDate";
import { TodoDueChip } from "../editor/TodoDue";
import { PageIcon, isSvgIcon } from "../../icons/pageIcon";

export interface TodoCenterProps {
  open: boolean;
  todos: TodoItem[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenItem: (item: TodoItem) => void;
  onToggleDone: (item: TodoItem) => void;
  onSetDue: (item: TodoItem, dueAt: string | null) => void;
}

const GROUPS: { id: DueBucket; label: string }[] = [
  { id: "overdue", label: "已逾期" },
  { id: "today", label: "今天" },
  { id: "upcoming", label: "未来 7 天" },
  { id: "later", label: "以后" },
  { id: "none", label: "没有设时间" },
];

/** 待办汇总：把所有页面里没做完的待办按时间集中起来 */
export const TodoCenter: React.FC<TodoCenterProps> = ({
  open,
  todos,
  loading,
  onClose,
  onRefresh,
  onOpenItem,
  onToggleDone,
  onSetDue,
}) => {
  const [onlyDated, setOnlyDated] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const now = new Date();
    const map = new Map<DueBucket, TodoItem[]>();
    for (const t of todos) {
      const b = dueBucket(t.dueAt, now);
      if (onlyDated && b === "none") continue;
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(t);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (parseDue(a.dueAt)?.getTime() ?? Infinity) - (parseDue(b.dueAt)?.getTime() ?? Infinity));
    }
    return map;
  }, [todos, onlyDated]);

  if (!open) return null;

  const total = todos.length;

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div className="nb-modal-card nb-todoc" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <ListTodo size={17} />
            <span>待办汇总</span>
            <span className="nb-todoc-count">{total} 项未完成</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label className="nb-todoc-filter">
              <input type="checkbox" checked={onlyDated} onChange={(e) => setOnlyDated(e.target.checked)} />
              只看有时间的
            </label>
            <button type="button" className="nb-icon-btn" onClick={onRefresh} title="刷新" aria-label="刷新">
              <RefreshCw size={15} className={loading ? "nb-spin" : ""} />
            </button>
            <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="nb-todoc-body">
          {total === 0 && !loading && (
            <div className="nb-todoc-empty">
              <p>所有待办都完成了。</p>
              <p className="nb-todoc-empty-hint">
                在任意页面输入 <kbd>/todo</kbd> 或 <kbd>[]</kbd> 加一条待办，悬停时点闹钟图标可以设提醒时间。
              </p>
            </div>
          )}
          {GROUPS.map((g) => {
            const list = grouped.get(g.id);
            if (!list || list.length === 0) return null;
            return (
              <section key={g.id} className={`nb-todoc-group is-${g.id}`}>
                <h3 className="nb-todoc-group-title">
                  {g.label}
                  <span>{list.length}</span>
                </h3>
                <ul>
                  {list.map((t) => {
                    const done = doneIds.has(t.blockId);
                    return (
                      <li key={t.blockId} className={`nb-todoc-item${done ? " is-done" : ""}`}>
                        <button
                          type="button"
                          className={`nb-editor-checkbox${done ? " is-checked" : ""}`}
                          aria-label="标记为已完成"
                          disabled={done}
                          onClick={() => {
                            setDoneIds((s) => new Set(s).add(t.blockId));
                            onToggleDone(t);
                          }}
                        >
                          {done && <Check size={11} strokeWidth={3} />}
                        </button>
                        <button type="button" className="nb-todoc-text" onClick={() => onOpenItem(t)} title="打开所在页面">
                          <span className="nb-todoc-title" data-i18n-skip="">
                            {t.text || "（未命名待办）"}
                          </span>
                          <span className="nb-todoc-page" data-i18n-skip="">
                            {t.pageIcon && !isSvgIcon(t.pageIcon) ? (
                              <span aria-hidden="true">{t.pageIcon}</span>
                            ) : t.pageIcon ? (
                              <PageIcon icon={t.pageIcon} size={12} />
                            ) : null}
                            {t.pageTitle || "无标题"}
                          </span>
                        </button>
                        <TodoDueChip dueAt={t.dueAt} checked={done} onChange={(d) => onSetDue(t, d)} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};
