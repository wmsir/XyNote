import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { KeybindingMap, Page } from "../../types/notion";
import {
  eventToCanonicalShortcut,
  matchesShortcutCombo,
} from "./editorKeybindings";
import {
  escapeHtml,
  insertHtmlAtCaret,
  isHtmlVisuallyEmpty,
  normalizeCleanHtml,
  toggleSelectionInlineTag,
  tryApplyInlineMarkdownAtCaret,
} from "./editorUtils";
import { upgradeResidualInlineMarkdown } from "./markdownCodec";
import { sanitizeRichInlineHtml } from "./sanitizeHtml";

export interface TableCellRichEditorProps {
  value: string;
  pages: Page[];
  isHeader?: boolean;
  align?: "left" | "center" | "right";
  placeholder?: string;
  spellCheck?: boolean;
  inlineMarkdownShortcuts?: boolean;
  keybindings?: KeybindingMap;
  focusRef?: (node: HTMLDivElement | null) => void;
  onChange: (nextHtml: string) => void;
  onNavigateCell?: (direction: "next" | "prev" | "down" | "up") => void;
}

export const TableCellRichEditor: React.FC<TableCellRichEditorProps> = ({
  value,
  pages,
  isHeader = false,
  align = "left",
  placeholder = "",
  spellCheck = false,
  inlineMarkdownShortcuts = true,
  keybindings,
  focusRef,
  onChange,
  onNavigateCell,
}) => {
  const cellRef = useRef<HTMLDivElement | null>(null);
  const mountedNodesRef = useRef<WeakSet<HTMLDivElement>>(new WeakSet());
  const isComposingRef = useRef<boolean>(false);

  const normalizedHtml = useMemo(
    () => upgradeResidualInlineMarkdown(value || "", pages),
    [pages, value]
  );

  const latestHtmlRef = useRef<string>(normalizedHtml);
  latestHtmlRef.current = normalizedHtml;
  const lastCommittedRef = useRef<string>(normalizedHtml);

  useLayoutEffect(() => {
    const el = cellRef.current;
    if (!el || isComposingRef.current) return;
    if (normalizedHtml !== lastCommittedRef.current) {
      el.innerHTML = sanitizeRichInlineHtml(normalizedHtml);
      lastCommittedRef.current = normalizedHtml;
      el.setAttribute(
        "data-empty",
        isHtmlVisuallyEmpty(normalizedHtml) ? "true" : "false"
      );
    }
  }, [normalizedHtml]);

  const bindCellRef = useCallback(
    (node: HTMLDivElement | null) => {
      cellRef.current = node;
      focusRef?.(node);
      if (node && !mountedNodesRef.current.has(node)) {
        mountedNodesRef.current.add(node);
        node.innerHTML = sanitizeRichInlineHtml(latestHtmlRef.current);
        lastCommittedRef.current = latestHtmlRef.current;
        node.setAttribute(
          "data-empty",
          isHtmlVisuallyEmpty(latestHtmlRef.current) ? "true" : "false"
        );
      }
    },
    [focusRef]
  );

  const commitCellDom = (el: HTMLDivElement) => {
    if (inlineMarkdownShortcuts) {
      tryApplyInlineMarkdownAtCaret(el);
    }
    const nextHtml = normalizeCleanHtml(el.innerHTML);
    lastCommittedRef.current = nextHtml;
    el.setAttribute(
      "data-empty",
      isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
    );
    onChange(nextHtml);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    const el = cellRef.current;
    if (!el) return;

    // Configurable inline formatting shortcuts (format.bold, format.italic, format.underline, format.strike, format.code, format.highlight)
    const combo = eventToCanonicalShortcut(e);
    if (combo) {
      const sel = window.getSelection();
      const hasSelection = Boolean(
        sel && sel.rangeCount > 0 && !sel.isCollapsed
      );
      let formatted = false;

      if (matchesShortcutCombo(combo, "format.bold", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("bold");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.italic", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("italic");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.underline", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("underline");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.strike", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("strikeThrough");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.code", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        if (hasSelection) {
          formatted = toggleSelectionInlineTag(el, "code", "nb-inline-code");
        }
      } else if (matchesShortcutCombo(combo, "format.highlight", keybindings)) {
        e.preventDefault();
        e.stopPropagation();
        if (hasSelection) {
          formatted = toggleSelectionInlineTag(
            el,
            "mark",
            "nb-inline-highlight"
          );
        }
      }

      if (formatted) {
        const nextHtml = normalizeCleanHtml(el.innerHTML);
        lastCommittedRef.current = nextHtml;
        el.setAttribute(
          "data-empty",
          isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
        );
        onChange(nextHtml);
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onNavigateCell?.(e.shiftKey ? "prev" : "next");
      return;
    }

    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        insertHtmlAtCaret(el, "<br>\u200B");
        const nextHtml = normalizeCleanHtml(el.innerHTML);
        lastCommittedRef.current = nextHtml;
        el.setAttribute(
          "data-empty",
          isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
        );
        onChange(nextHtml);
      } else {
        onNavigateCell?.("down");
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = cellRef.current;
    if (!el) return;
    const plain = e.clipboardData.getData("text/plain");
    if (!plain) return;

    e.preventDefault();
    e.stopPropagation();
    const richSnippet = upgradeResidualInlineMarkdown(
      escapeHtml(plain).replace(/\r?\n/g, "<br>"),
      pages
    );
    insertHtmlAtCaret(el, richSnippet);
    const nextHtml = normalizeCleanHtml(el.innerHTML);
    lastCommittedRef.current = nextHtml;
    el.setAttribute(
      "data-empty",
      isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
    );
    onChange(nextHtml);
  };

  const isEmpty = isHtmlVisuallyEmpty(normalizedHtml);

  return (
    <div
      ref={bindCellRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={spellCheck}
      className={`nb-editor-editable nb-editor-table-cell-editable ${
        isHeader ? "is-header-cell" : ""
      }`.trim()}
      style={{ textAlign: align }}
      data-placeholder={placeholder}
      data-empty={isEmpty ? "true" : "false"}
      onCompositionStart={() => {
        isComposingRef.current = true;
      }}
      onCompositionEnd={(e) => {
        isComposingRef.current = false;
        commitCellDom(e.currentTarget);
      }}
      onInput={(e) => {
        const nativeInput = e.nativeEvent as InputEvent;
        if (isComposingRef.current || Boolean(nativeInput.isComposing)) {
          e.currentTarget.setAttribute(
            "data-empty",
            isHtmlVisuallyEmpty(e.currentTarget.innerHTML) ? "true" : "false"
          );
          return;
        }
        commitCellDom(e.currentTarget);
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  );
};
