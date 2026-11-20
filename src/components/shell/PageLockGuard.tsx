import React from "react";
import { Lock } from "lucide-react";

interface Props {
  locked: boolean;
  onUnlock: () => void;
  children: React.ReactNode;
}

/** 锁定页面时仍可阅读、选中、复制、点链接，只拦住会改内容的操作 */
const ALLOWED_PLAIN_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "Escape", "Shift", "Control", "Alt", "Meta", "CapsLock",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
/** Ctrl/⌘ 组合里允许的：复制、全选、查找，以及 App 的全局快捷键 */
const ALLOWED_MOD_KEYS = new Set(["c", "a", "f", "k", "p", "n", "o", "s", "w", ",", "/", "\\"]);

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT";
}

export const PageLockGuard: React.FC<Props> = ({ locked, onUnlock, children }) => {
  if (!locked) return <>{children}</>;
  const block = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      className="nb-page-locked"
      onBeforeInputCapture={block}
      onPasteCapture={block}
      onCutCapture={block}
      onDropCapture={block}
      onDragStartCapture={(e) => {
        // 允许拖动选中的文字到别的程序，不允许拖块重新排序
        if ((e.target as HTMLElement).closest?.("[draggable='true']")) block(e);
      }}
      onKeyDownCapture={(e) => {
        if (ALLOWED_PLAIN_KEYS.has(e.key)) return;
        if (e.ctrlKey || e.metaKey) {
          if (ALLOWED_MOD_KEYS.has(e.key.toLowerCase()) && !e.altKey) return;
          block(e);
          return;
        }
        if (isEditable(e.target)) block(e);
      }}
      onClickCapture={(e) => {
        // 改内容的按钮（勾选待办、添加块、拖动手柄、删除等）在锁定时不响应；链接和「打开」类按钮照常
        const el = (e.target as HTMLElement).closest?.(
          ".nb-editor-checkbox, .nb-editor-gutter, .nb-editor-gutter-btn, .nb-todo-due, .nb-editor-media-upload-btn, .nb-db-primary-btn, .nb-db-cal-add, .nb-header-hover-tools button, .nb-cover-btn, .nb-page-icon-btn, .nb-editor-code-lang, select"
        );
        if (el) block(e);
      }}
      onChangeCapture={(e) => {
        if (isEditable(e.target)) block(e);
      }}
    >
      <div className="nb-lock-banner" role="status">
        <Lock size={13} />
        <span>页面已锁定，可以阅读和复制，不会被误改。</span>
        <button type="button" className="nb-lock-banner-btn" onClick={onUnlock}>
          解锁
        </button>
      </div>
      {children}
    </div>
  );
};
