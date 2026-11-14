import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Code,
  Highlighter,
  Italic,
  Link2,
  Strikethrough,
  Underline,
  Unlink,
  X,
} from "lucide-react";
import type { KeybindingMap } from "../../types/notion";
import { formatTooltipWithShortcut } from "./editorKeybindings";
import { normalizeInlineLinkHref } from "./editorUtils";

export interface InlineToolbarProps {
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  pageId: string;
  keybindings?: KeybindingMap;
}

interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  highlight: boolean;
  linkHref: string | null;
}

function findEnclosingEditable(
  node: Node | null,
  root: HTMLElement | null
): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr !== root) {
    if (
      curr instanceof HTMLElement &&
      curr.classList.contains("nb-editor-editable")
    ) {
      return curr;
    }
    curr = curr.parentNode;
  }
  return null;
}

function findAncestorTag(
  node: Node | null,
  editable: HTMLElement,
  tagNames: string[]
): HTMLElement | null {
  const upperSet = new Set(tagNames.map((t) => t.toUpperCase()));
  let curr: Node | null = node;
  while (curr && curr !== editable) {
    if (curr instanceof HTMLElement && upperSet.has(curr.tagName)) {
      if (curr.tagName === "A" && curr.classList.contains("nb-wiki-link")) {
        return null;
      }
      return curr;
    }
    curr = curr.parentNode;
  }
  return null;
}

function unwrapElementPreservingSelection(targetEl: HTMLElement): void {
  const parent = targetEl.parentNode;
  if (!parent) return;

  const firstChild = targetEl.firstChild;
  const lastChild = targetEl.lastChild;

  while (targetEl.firstChild) {
    parent.insertBefore(targetEl.firstChild, targetEl);
  }
  parent.removeChild(targetEl);

  const sel = window.getSelection();
  if (sel && firstChild && lastChild) {
    const nextRange = document.createRange();
    nextRange.setStartBefore(firstChild);
    nextRange.setEndAfter(lastChild);
    sel.removeAllRanges();
    sel.addRange(nextRange);
  }
}

function wrapRangeWithElement(range: Range, wrapper: HTMLElement): void {
  const contents = range.extractContents();
  wrapper.appendChild(contents);
  range.insertNode(wrapper);

  const sel = window.getSelection();
  if (sel) {
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(nextRange);
  }
}

function notifyEditableInput(editable: HTMLElement): void {
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

export const InlineToolbar: React.FC<InlineToolbarProps> = ({
  editorRootRef,
  pageId,
  keybindings,
}) => {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
  const [formats, setFormats] = useState<ActiveFormats>({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    highlight: false,
    linkHref: null,
  });
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const savedEditableRef = useRef<HTMLElement | null>(null);

  // Reset toolbar when switching pages
  useEffect(() => {
    setVisible(false);
    setLinkMode(false);
    savedRangeRef.current = null;
    savedEditableRef.current = null;
  }, [pageId]);

  const computeFormatsAndPosition = useCallback(() => {
    // Keep toolbar open while typing inside the URL input
    if (linkMode) return;

    const root = editorRootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setVisible(false);
      return;
    }

    const range = sel.getRangeAt(0);
    const selectedText = range.toString();
    if (!selectedText || selectedText.trim().length === 0) {
      setVisible(false);
      return;
    }

    const startEditable = findEnclosingEditable(range.startContainer, root);
    const endEditable = findEnclosingEditable(range.endContainer, root);
    if (!startEditable || startEditable !== endEditable) {
      setVisible(false);
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setVisible(false);
      return;
    }

    const anchorNode = range.commonAncestorContainer;
    const codeEl = findAncestorTag(anchorNode, startEditable, ["CODE"]);
    const markEl = findAncestorTag(anchorNode, startEditable, ["MARK"]);
    const linkEl = findAncestorTag(anchorNode, startEditable, ["A"]);

    let cmdBold = false;
    let cmdItalic = false;
    let cmdUnderline = false;
    let cmdStrike = false;
    try {
      cmdBold = document.queryCommandState("bold");
      cmdItalic = document.queryCommandState("italic");
      cmdUnderline = document.queryCommandState("underline");
      cmdStrike = document.queryCommandState("strikeThrough");
    } catch {
      // Ignore queryCommandState exceptions in restricted contexts
    }

    setFormats({
      bold:
        cmdBold ||
        Boolean(findAncestorTag(anchorNode, startEditable, ["B", "STRONG"])),
      italic:
        cmdItalic ||
        Boolean(findAncestorTag(anchorNode, startEditable, ["I", "EM"])),
      underline:
        cmdUnderline ||
        Boolean(findAncestorTag(anchorNode, startEditable, ["U"])),
      strike:
        cmdStrike ||
        Boolean(
          findAncestorTag(anchorNode, startEditable, ["S", "STRIKE", "DEL"])
        ),
      code: Boolean(codeEl),
      highlight: Boolean(markEl),
      linkHref: linkEl ? linkEl.getAttribute("href") : null,
    });

    const toolbarWidth = 246;
    const viewportW = window.innerWidth;
    const centeredLeft = rect.left + rect.width / 2 - toolbarWidth / 2;
    const clampedLeft = Math.max(
      12,
      Math.min(centeredLeft, viewportW - toolbarWidth - 12)
    );
    const desiredTop = rect.top - 44;
    const clampedTop = desiredTop < 12 ? rect.bottom + 8 : desiredTop;

    savedRangeRef.current = range.cloneRange();
    savedEditableRef.current = startEditable;
    setCoords({ left: clampedLeft, top: clampedTop });
    setVisible(true);
  }, [editorRootRef, linkMode]);

  useEffect(() => {
    const onSelectionChange = () => {
      computeFormatsAndPosition();
    };

    const onScroll = () => {
      if (visible && !linkMode) {
        computeFormatsAndPosition();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [computeFormatsAndPosition, linkMode, visible]);

  const applyExecCommand = (command: string) => {
    const root = editorRootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;

    const editable = findEnclosingEditable(sel.getRangeAt(0).startContainer, root);
    if (!editable) return;

    editable.focus();
    document.execCommand(command, false);
    notifyEditableInput(editable);
    computeFormatsAndPosition();
  };

  const toggleCustomInlineTag = (
    tagName: "code" | "mark",
    className: string
  ) => {
    const root = editorRootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    const editable = findEnclosingEditable(range.startContainer, root);
    if (!editable) return;

    const existing = findAncestorTag(range.commonAncestorContainer, editable, [
      tagName,
    ]);
    if (existing) {
      unwrapElementPreservingSelection(existing);
    } else {
      const el = document.createElement(tagName);
      el.className = className;
      wrapRangeWithElement(range, el);
    }

    notifyEditableInput(editable);
    computeFormatsAndPosition();
  };

  const openLinkEditor = () => {
    const sel = window.getSelection();
    const root = editorRootRef.current;
    if (sel && sel.rangeCount > 0 && root) {
      const r = sel.getRangeAt(0);
      const editable = findEnclosingEditable(r.startContainer, root);
      if (editable) {
        savedRangeRef.current = r.cloneRange();
        savedEditableRef.current = editable;
      }
    }
    setLinkUrl(formats.linkHref ?? "");
    setLinkMode(true);
    window.setTimeout(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    }, 10);
  };

  const applyLinkUrl = (rawUrl: string) => {
    const savedRange = savedRangeRef.current;
    const editable = savedEditableRef.current;
    setLinkMode(false);

    if (!savedRange || !editable) {
      setVisible(false);
      return;
    }

    editable.focus();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(savedRange);

    const existingAnchor = findAncestorTag(
      savedRange.commonAncestorContainer,
      editable,
      ["A"]
    );

    const trimmed = rawUrl.trim();
    if (!trimmed) {
      if (existingAnchor) {
        unwrapElementPreservingSelection(existingAnchor);
        notifyEditableInput(editable);
      }
      setVisible(false);
      return;
    }

    const normalizedHref = normalizeInlineLinkHref(trimmed);
    const isHttp = /^https?:\/\//i.test(normalizedHref);
    const isLocalFile = /^file:\/\//i.test(normalizedHref);

    const applyAnchorAttrs = (anchor: HTMLElement) => {
      anchor.setAttribute("href", normalizedHref);
      if (isHttp) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.removeAttribute("data-local-file");
      } else if (isLocalFile) {
        anchor.removeAttribute("target");
        anchor.removeAttribute("rel");
        anchor.setAttribute("data-local-file", "true");
        anchor.setAttribute("title", "点击在资源管理器中显示本地文件");
      }
      anchor.classList.add("nb-inline-link");
    };

    if (existingAnchor) {
      applyAnchorAttrs(existingAnchor);
    } else {
      const anchor = document.createElement("a");
      applyAnchorAttrs(anchor);
      wrapRangeWithElement(savedRange, anchor);
    }

    notifyEditableInput(editable);
    computeFormatsAndPosition();
  };

  const handleRemoveLink = () => {
    applyLinkUrl("");
  };

  if (!visible) return null;

  return (
    <div
      ref={toolbarRef}
      className="nb-editor-inline-toolbar"
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      role="toolbar"
      aria-label="行内富文本格式工具栏"
    >
      {linkMode ? (
        <form
          className="nb-editor-inline-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            applyLinkUrl(linkUrl);
          }}
        >
          <input
            ref={linkInputRef}
            type="text"
            className="nb-editor-inline-link-input"
            placeholder="粘贴或输入链接 https://..."
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setLinkMode(false);
                if (savedEditableRef.current && savedRangeRef.current) {
                  savedEditableRef.current.focus();
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(savedRangeRef.current);
                }
              }
            }}
          />
          <button type="submit" className="nb-editor-inline-link-submit">
            确认
          </button>
          {formats.linkHref && (
            <button
              type="button"
              className="nb-editor-inline-btn"
              title="移除链接"
              onMouseDown={(e) => {
                e.preventDefault();
                handleRemoveLink();
              }}
            >
              <Unlink size={14} />
            </button>
          )}
          <button
            type="button"
            className="nb-editor-inline-btn"
            title="取消"
            onMouseDown={(e) => {
              e.preventDefault();
              setLinkMode(false);
            }}
          >
            <X size={14} />
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.bold ? "is-active" : ""}`}
            title={formatTooltipWithShortcut("加粗", "format.bold", keybindings)}
            onMouseDown={(e) => {
              e.preventDefault();
              applyExecCommand("bold");
            }}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.italic ? "is-active" : ""}`}
            title={formatTooltipWithShortcut(
              "斜体",
              "format.italic",
              keybindings
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              applyExecCommand("italic");
            }}
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.underline ? "is-active" : ""}`}
            title={formatTooltipWithShortcut(
              "下划线",
              "format.underline",
              keybindings
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              applyExecCommand("underline");
            }}
          >
            <Underline size={15} />
          </button>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.strike ? "is-active" : ""}`}
            title={formatTooltipWithShortcut(
              "删除线",
              "format.strike",
              keybindings
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              applyExecCommand("strikeThrough");
            }}
          >
            <Strikethrough size={15} />
          </button>

          <div className="nb-editor-inline-sep" />

          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.code ? "is-active" : ""}`}
            title={formatTooltipWithShortcut(
              "行内代码",
              "format.code",
              keybindings
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              toggleCustomInlineTag("code", "nb-inline-code");
            }}
          >
            <Code size={15} />
          </button>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.highlight ? "is-active" : ""}`}
            title={formatTooltipWithShortcut(
              "背景高亮",
              "format.highlight",
              keybindings
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              toggleCustomInlineTag("mark", "nb-inline-highlight");
            }}
          >
            <Highlighter size={15} />
          </button>
          <button
            type="button"
            className={`nb-editor-inline-btn ${formats.linkHref ? "is-active" : ""}`}
            title={formats.linkHref ? `编辑链接 (${formats.linkHref})` : "添加超链接"}
            onMouseDown={(e) => {
              e.preventDefault();
              openLinkEditor();
            }}
          >
            <Link2 size={15} />
          </button>
        </>
      )}
    </div>
  );
};
