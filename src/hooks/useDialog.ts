import { useEffect, useRef } from "react";

/** 打开中的对话框，后打开的在最上层；Esc 只关最上层那一个 */
const openDialogs: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

interface UseDialogOptions {
  /** 为 false 时 Esc 不关闭（例如正在导入、关掉会丢进度） */
  closeOnEscape?: boolean;
}

/**
 * 模态对话框的通用键盘行为：
 * - Esc 关闭（只关最上层；输入法组字时按 Esc 不算）
 * - 打开时焦点移进对话框，Tab / Shift+Tab 在对话框内循环
 * - 关闭后焦点回到打开前的位置（如果焦点没被别处接走）
 *
 * 返回的 ref 挂到对话框卡片上；卡片建议带 role="dialog" aria-modal="true" tabIndex={-1}。
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  options: UseDialogOptions = {}
) {
  const cardRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(options.closeOnEscape !== false);
  closeOnEscapeRef.current = options.closeOnEscape !== false;

  useEffect(() => {
    if (!open) return;
    const id = Symbol("dialog");
    openDialogs.push(id);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const raf = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card || card.contains(document.activeElement)) return;
      const preferred = card.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? card).focus({ preventScroll: true });
    });

    const onKey = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      const card = cardRef.current;
      if (e.key === "Escape") {
        if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (closeOnEscapeRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !card) return;
      const items = focusableIn(card);
      if (items.length === 0) {
        e.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && card.contains(active);
      if (e.shiftKey && (active === first || active === card || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      const idx = openDialogs.lastIndexOf(id);
      if (idx !== -1) openDialogs.splice(idx, 1);
      // 关闭后如果焦点落回了页面空白处，交还给打开对话框前的元素
      const active = document.activeElement;
      const focusLost =
        !active || active === document.body || (cardRef.current?.contains(active) ?? false);
      if (focusLost && previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return cardRef;
}
