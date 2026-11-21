import { LineNumberGutter } from "./LineNumberGutter";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import katex from "katex";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Film,
  Globe,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sigma,
  Upload,
  WrapText,
  X,
} from "lucide-react";
import { fetchUrlMetadata } from "../../api/client";
import { openExternalUrl } from "../../api/sync";
import type {
  Block,
  BlockProps,
  BlockType,
  EditorPreferences,
  Page,
} from "../../types/notion";
import {
  CALLOUT_ICONS,
  CODE_LANGUAGES,
  deleteCharsBeforeCaret,
  detectMenuTrigger,
  DetectedTrigger,
  escapeHtml,
  getCaretViewportPoint,
  getPlaceholderForBlock,
  getTextBeforeCaret,
  insertHtmlAtCaret,
  isCaretAtEnd,
  isCaretAtStart,
  isHtmlVisuallyEmpty,
  isRichTextEditableBlock,
  looksLikeMermaidCode,
  MATH_SYMBOL_PRESETS,
  matchEnterLineShortcut,
  matchMarkdownShortcut,
  normalizeCleanHtml,
  normalizeCodeLanguage,
  normalizeExternalUrl,
  parseEmbedSource,
  splitElementAtCaret,
  stripHtmlToText,
  toggleSelectionInlineTag,
  tryApplyInlineMarkdownAtCaret,
} from "./editorUtils";
import {
  eventToCanonicalShortcut,
  formatTooltipWithShortcut,
  matchesActionShortcut,
  matchesShortcutCombo,
  resolveActionShortcut,
} from "./editorKeybindings";
import {
  looksLikeStructuredMarkdown,
  upgradeResidualInlineMarkdown,
} from "./markdownCodec";
import { MermaidBlock } from "./MermaidBlock";
import { sanitizeRichInlineHtml } from "./sanitizeHtml";
import { TableCellRichEditor } from "./TableCellRichEditor";

export interface BlockRowProps {
  block: Block;
  pages: Page[];
  isOnlyBlock: boolean;
  numberedIndex: number;
  isHighlighted: boolean;
  isFocusedBlock: boolean;
  isActionMenuOpen: boolean;
  isDragging: boolean;
  dropIndicator: "top" | "bottom" | null;
  preferences?: EditorPreferences;
  registerFocusTarget: (blockId: string, el: HTMLElement | null) => void;
  onBlockFocus: (blockId: string) => void;
  onContentChange: (blockId: string, html: string) => void;
  onPropsChange: (blockId: string, nextProps: BlockProps) => void;
  onMarkdownConvert: (
    blockId: string,
    nextType: BlockType,
    remainingContent: string,
    extraProps?: BlockProps
  ) => void;
  onSplitBlockOnEnter: (
    blockId: string,
    beforeHtml: string,
    afterHtml: string
  ) => void;
  onConvertEmptyToParagraph: (blockId: string) => void;
  onBackspaceAtStart: (blockId: string, currentHtml: string) => void;
  onDeleteBlock: (blockId: string) => void;
  onExitBlockBelow: (blockId: string) => void;
  onFocusAdjacentBlock: (blockId: string, direction: "up" | "down") => void;
  onTriggerMenuChange: (
    blockId: string,
    trigger: DetectedTrigger | null,
    anchor: { x: number; y: number; bottom: number }
  ) => void;
  onGutterAddBelow: (blockId: string, buttonEl: HTMLElement) => void;
  onOpenActionMenu: (blockId: string, buttonEl: HTMLElement) => void;
  onSmartMarkdownPaste: (blockId: string, markdown: string) => void;
  onPasteImageFile: (
    blockId: string,
    file: File,
    replaceCurrentBlock: boolean
  ) => void;
  onDragStartBlock: (blockId: string, e: React.DragEvent<HTMLElement>) => void;
  onDragOverBlock: (blockId: string, e: React.DragEvent<HTMLDivElement>) => void;
  onDropOnBlock: (blockId: string, e: React.DragEvent<HTMLDivElement>) => void;
  onDragEndBlock: () => void;
}

const BlockRowInner: React.FC<BlockRowProps> = ({
  block,
  pages,
  isOnlyBlock,
  numberedIndex,
  isHighlighted,
  isFocusedBlock,
  isActionMenuOpen,
  isDragging,
  dropIndicator,
  preferences,
  registerFocusTarget,
  onBlockFocus,
  onContentChange,
  onPropsChange,
  onMarkdownConvert,
  onSplitBlockOnEnter,
  onConvertEmptyToParagraph,
  onBackspaceAtStart,
  onDeleteBlock,
  onExitBlockBelow,
  onFocusAdjacentBlock,
  onTriggerMenuChange,
  onGutterAddBelow,
  onOpenActionMenu,
  onSmartMarkdownPaste,
  onPasteImageFile,
  onDragStartBlock,
  onDragOverBlock,
  onDropOnBlock,
  onDragEndBlock,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const editableRef = useRef<HTMLDivElement | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mathTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mathWrapRef = useRef<HTMLDivElement | null>(null);
  const toggleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const emojiPopoverRef = useRef<HTMLDivElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const tableCellRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const lastCommittedHtmlRef = useRef<string>(block.content);
  const latestContentRef = useRef<string>(block.content);
  latestContentRef.current = block.content;
  const mountedEditablesRef = useRef<WeakSet<HTMLDivElement>>(new WeakSet());
  const isComposingRef = useRef<boolean>(false);
  const prevBlockTypeRef = useRef<BlockType>(block.blockType);

  const [emojiOpen, setEmojiOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Math block state
  const [mathEditing, setMathEditing] = useState<boolean>(
    () => block.blockType === "math" && block.content.trim().length === 0
  );

  // Image block state
  const [editingImageUrl, setEditingImageUrl] = useState(false);
  const [draftImageUrl, setDraftImageUrl] = useState("");
  const [imageDropHover, setImageDropHover] = useState(false);

  // Bookmark block state
  const [editingBookmark, setEditingBookmark] = useState(false);
  const [draftBookmarkUrl, setDraftBookmarkUrl] = useState("");
  const [loadingBookmark, setLoadingBookmark] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  // Embed block state
  const [editingEmbed, setEditingEmbed] = useState(false);
  const [draftEmbedUrl, setDraftEmbedUrl] = useState("");

  // Auto-open math editor when block converts into `math` in-place (e.g. `$$ ` or `/math`)
  useEffect(() => {
    if (prevBlockTypeRef.current !== block.blockType) {
      prevBlockTypeRef.current = block.blockType;
      if (block.blockType === "math" && block.content.trim().length === 0) {
        setMathEditing(true);
      }
    }
  }, [block.blockType, block.content]);

  // Focus math textarea when mathEditing opens
  useEffect(() => {
    if (block.blockType === "math" && mathEditing && mathTextareaRef.current) {
      mathTextareaRef.current.focus();
    }
  }, [block.blockType, mathEditing]);

  // Close math editor on outside click (if formula is non-empty, or collapse cleanly)
  useEffect(() => {
    if (block.blockType !== "math" || !mathEditing) return;
    const onDown = (e: MouseEvent) => {
      if (
        mathWrapRef.current &&
        !mathWrapRef.current.contains(e.target as Node)
      ) {
        setMathEditing(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [block.blockType, mathEditing]);

  // Scroll into view when highlighted by Ctrl+K global search
  useEffect(() => {
    if (isHighlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isHighlighted]);

  // Close callout emoji picker on outside click
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        emojiPopoverRef.current &&
        !emojiPopoverRef.current.contains(e.target as Node)
      ) {
        setEmojiOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [emojiOpen]);

  // Auto-resize code textarea height cleanly
  useLayoutEffect(() => {
    if (block.blockType === "code" && codeTextareaRef.current) {
      const ta = codeTextareaRef.current;
      ta.style.height = "auto";
      ta.style.height = `${Math.max(54, ta.scrollHeight)}px`;
    }
  }, [
    block.blockType,
    block.content,
    block.props.wordWrap,
    preferences?.codeWordWrap,
    preferences?.codeLineNumbers,
  ]);

  // Auto-resize math textarea height cleanly
  useLayoutEffect(() => {
    if (block.blockType === "math" && mathEditing && mathTextareaRef.current) {
      const ta = mathTextareaRef.current;
      ta.style.height = "auto";
      ta.style.height = `${Math.max(52, ta.scrollHeight)}px`;
    }
  }, [block.blockType, block.content, mathEditing]);

  // Auto-resize toggle nested textarea height cleanly
  useLayoutEffect(() => {
    if (
      block.blockType === "toggle" &&
      !block.props.collapsed &&
      toggleTextareaRef.current
    ) {
      const ta = toggleTextareaRef.current;
      ta.style.height = "auto";
      ta.style.height = `${Math.max(32, ta.scrollHeight)}px`;
    }
  }, [block.blockType, block.props.childrenText, block.props.collapsed]);

  // Keep contentEditable innerHTML synced ONLY on external changes (never during IME or local keystrokes)
  useLayoutEffect(() => {
    if (!isRichTextEditableBlock(block.blockType)) return;
    const el = editableRef.current;
    if (!el || isComposingRef.current) return;

    if (block.content !== lastCommittedHtmlRef.current) {
      el.innerHTML = sanitizeRichInlineHtml(block.content);
      lastCommittedHtmlRef.current = block.content;
    }
  }, [block.blockType, block.content, block.id]);

  const bindEditableRef = useCallback(
    (node: HTMLDivElement | null) => {
      editableRef.current = node;
      registerFocusTarget(block.id, node);
      if (node && !mountedEditablesRef.current.has(node)) {
        mountedEditablesRef.current.add(node);
        node.innerHTML = sanitizeRichInlineHtml(latestContentRef.current);
        lastCommittedHtmlRef.current = latestContentRef.current;
      }
    },
    [block.id, registerFocusTarget]
  );

  const bindCodeTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      codeTextareaRef.current = node;
      registerFocusTarget(block.id, node);
    },
    [block.id, registerFocusTarget]
  );

  const bindMathFocusRef = useCallback(
    (node: HTMLElement | null) => {
      registerFocusTarget(block.id, node);
    },
    [block.id, registerFocusTarget]
  );

  const bindDividerRef = useCallback(
    (node: HTMLDivElement | null) => {
      dividerRef.current = node;
      registerFocusTarget(block.id, node);
    },
    [block.id, registerFocusTarget]
  );

  const bindGenericInputFocusRef = useCallback(
    (node: HTMLInputElement | HTMLElement | null) => {
      registerFocusTarget(block.id, node);
    },
    [block.id, registerFocusTarget]
  );

  // Pre-rendered KaTeX HTML for `math` block
  const renderedMathHtml = useMemo(() => {
    if (block.blockType !== "math") return "";
    const latex = block.content.trim();
    if (!latex) return "";
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
      });
    } catch {
      return escapeHtml(latex);
    }
  }, [block.blockType, block.content]);

  const evaluateEditableInput = (el: HTMLDivElement) => {
    const textBefore = getTextBeforeCaret(el);

    // 1. Check live block-level Markdown auto-shortcuts at block start
    const mdMatch = matchMarkdownShortcut(textBefore);
    if (mdMatch) {
      deleteCharsBeforeCaret(el, mdMatch.removeChars);
      const remainingHtml = normalizeCleanHtml(el.innerHTML);
      lastCommittedHtmlRef.current = remainingHtml;
      el.setAttribute(
        "data-empty",
        isHtmlVisuallyEmpty(remainingHtml) ? "true" : "false"
      );
      onTriggerMenuChange(block.id, null, { x: 0, y: 0, bottom: 0 });
      onMarkdownConvert(
        block.id,
        mdMatch.blockType,
        mdMatch.initialContent !== undefined
          ? mdMatch.initialContent
          : remainingHtml,
        mdMatch.props
      );
      return;
    }

    // 2. Check live WYSIWYG inline Markdown auto-shortcuts (**bold**, *italic*, ~~strike~~, `code`, ==highlight==, [link](url))
    if (preferences?.inlineMarkdownShortcuts !== false) {
      tryApplyInlineMarkdownAtCaret(el);
    }

    // 3. Commit normalized HTML without disturbing browser caret
    const nextHtml = normalizeCleanHtml(el.innerHTML);
    lastCommittedHtmlRef.current = nextHtml;
    el.setAttribute(
      "data-empty",
      isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
    );
    onContentChange(block.id, nextHtml);

    // 4. Detect `/` slash command or `[[` bidirectional wiki link trigger
    const updatedTextBefore = getTextBeforeCaret(el);
    const trigger = detectMenuTrigger(updatedTextBefore);
    if (trigger) {
      const pt = getCaretViewportPoint(el);
      onTriggerMenuChange(block.id, trigger, pt);
    } else {
      onTriggerMenuChange(block.id, null, { x: 0, y: 0, bottom: 0 });
    }
  };

  const handleEditableKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    const el = editableRef.current;
    if (!el) return;

    // Configurable inline formatting shortcuts (format.bold, format.italic, format.underline, format.strike, format.code, format.highlight)
    const kb = preferences?.keybindings;
    const combo = eventToCanonicalShortcut(e);
    if (combo) {
      const sel = window.getSelection();
      const hasSelection = Boolean(
        sel && sel.rangeCount > 0 && !sel.isCollapsed
      );

      let formatted = false;
      if (matchesShortcutCombo(combo, "format.bold", kb)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("bold");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.italic", kb)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("italic");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.underline", kb)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("underline");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.strike", kb)) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("strikeThrough");
        formatted = true;
      } else if (matchesShortcutCombo(combo, "format.code", kb)) {
        e.preventDefault();
        e.stopPropagation();
        if (hasSelection) {
          formatted = toggleSelectionInlineTag(el, "code", "nb-inline-code");
        }
      } else if (matchesShortcutCombo(combo, "format.highlight", kb)) {
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
        lastCommittedHtmlRef.current = nextHtml;
        el.setAttribute(
          "data-empty",
          isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
        );
        onContentChange(block.id, nextHtml);
        return;
      }
    }

    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // Check whole-line Enter shortcuts first (`$$`, `$$...$$`, `![caption](url)`, ```` ```lang ````, `| col1 | col2 |`)
      const enterShortcut = matchEnterLineShortcut(stripHtmlToText(el.innerHTML));
      if (enterShortcut) {
        e.preventDefault();
        el.innerHTML = "";
        lastCommittedHtmlRef.current = "";
        el.setAttribute("data-empty", "true");
        onTriggerMenuChange(block.id, null, { x: 0, y: 0, bottom: 0 });
        onMarkdownConvert(
          block.id,
          enterShortcut.blockType,
          enterShortcut.initialContent ?? "",
          enterShortcut.props
        );
        return;
      }

      e.preventDefault();
      const visuallyEmpty = isHtmlVisuallyEmpty(el.innerHTML);
      if (
        visuallyEmpty &&
        (block.blockType === "bullet" ||
          block.blockType === "numbered" ||
          block.blockType === "todo" ||
          block.blockType === "quote")
      ) {
        onConvertEmptyToParagraph(block.id);
        return;
      }

      const { beforeHtml, afterHtml } = splitElementAtCaret(el);
      lastCommittedHtmlRef.current = beforeHtml;
      el.setAttribute(
        "data-empty",
        isHtmlVisuallyEmpty(beforeHtml) ? "true" : "false"
      );
      onSplitBlockOnEnter(block.id, beforeHtml, afterHtml);
      return;
    }

    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isCaretAtStart(el)) {
        e.preventDefault();
        const currentHtml = normalizeCleanHtml(el.innerHTML);
        onBackspaceAtStart(block.id, currentHtml);
        return;
      }
    }

    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      if (isCaretAtStart(el)) {
        e.preventDefault();
        onFocusAdjacentBlock(block.id, "up");
      }
      return;
    }

    if (
      e.key === "ArrowDown" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      if (isCaretAtEnd(el)) {
        e.preventDefault();
        onFocusAdjacentBlock(block.id, "down");
      }
    }
  };

  const handleEditablePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = editableRef.current;
    if (!el) return;

    // 1. Clipboard Screenshot / Image Paste -> Local `assets/` Folder (or Base64 fallback)
    const clipItems = e.clipboardData?.items
      ? Array.from(e.clipboardData.items)
      : [];
    const imageItem = clipItems.find(
      (item) => item.kind === "file" && item.type.startsWith("image/")
    );
    if (imageItem) {
      const imgFile = imageItem.getAsFile();
      if (imgFile) {
        e.preventDefault();
        e.stopPropagation();
        onPasteImageFile(block.id, imgFile, isHtmlVisuallyEmpty(el.innerHTML));
        return;
      }
    }
    const fallbackFile = e.clipboardData?.files
      ? Array.from(e.clipboardData.files).find((f) =>
          f.type.startsWith("image/")
        )
      : undefined;
    if (fallbackFile) {
      e.preventDefault();
      e.stopPropagation();
      onPasteImageFile(
        block.id,
        fallbackFile,
        isHtmlVisuallyEmpty(el.innerHTML)
      );
      return;
    }

    const plain = e.clipboardData.getData("text/plain");
    if (!plain) return;

    // 2. Smart Multi-line / Structured Markdown Paste -> Parse into rich Notion/Typora blocks
    if (
      preferences?.smartMarkdownPaste !== false &&
      looksLikeStructuredMarkdown(plain)
    ) {
      e.preventDefault();
      onSmartMarkdownPaste(block.id, plain);
      return;
    }

    e.preventDefault();
    const rawEscaped = escapeHtml(plain).replace(/\r?\n/g, "<br>");
    const safeHtml =
      preferences?.smartMarkdownPaste !== false
        ? upgradeResidualInlineMarkdown(rawEscaped, pages)
        : rawEscaped;
    insertHtmlAtCaret(el, safeHtml);
    const nextHtml = normalizeCleanHtml(el.innerHTML);
    lastCommittedHtmlRef.current = nextHtml;
    el.setAttribute(
      "data-empty",
      isHtmlVisuallyEmpty(nextHtml) ? "true" : "false"
    );
    onContentChange(block.id, nextHtml);
  };

  const renderRichEditable = (extraClass = "") => {
    const empty = isHtmlVisuallyEmpty(block.content);
    return (
      <div
        ref={bindEditableRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={preferences?.spellcheck ?? false}
        className={`nb-editor-editable ${extraClass}`.trim()}
        data-block-editable-id={block.id}
        data-placeholder={getPlaceholderForBlock(block.blockType)}
        data-empty={empty ? "true" : "false"}
        data-always-placeholder={isOnlyBlock ? "true" : "false"}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          evaluateEditableInput(e.currentTarget);
        }}
        onInput={(e) => {
          const nativeInput = e.nativeEvent as InputEvent;
          if (isComposingRef.current || Boolean(nativeInput.isComposing)) {
            const rawEmpty = isHtmlVisuallyEmpty(e.currentTarget.innerHTML);
            e.currentTarget.setAttribute(
              "data-empty",
              rawEmpty ? "true" : "false"
            );
            return;
          }
          evaluateEditableInput(e.currentTarget);
        }}
        onKeyDown={handleEditableKeyDown}
        onPaste={handleEditablePaste}
      />
    );
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(block.content);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = block.content;
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand("copy");
      document.body.removeChild(fallback);
    }
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  // Insert a LaTeX snippet preset into the math textarea at cursor
  const handleInsertMathPreset = (snippet: string) => {
    const ta = mathTextareaRef.current;
    if (!ta) {
      const appended = block.content ? `${block.content} ${snippet}` : snippet;
      onContentChange(block.id, appended);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const nextLatex =
      ta.value.slice(0, start) + snippet + ta.value.slice(end);
    onContentChange(block.id, nextLatex);
    window.requestAnimationFrame(() => {
      ta.focus();
      const caret = start + snippet.length;
      ta.selectionStart = caret;
      ta.selectionEnd = caret;
    });
  };

  // Persist uploaded/dropped local image via asset folder (or Base64 fallback)
  const handleLocalImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setEditingImageUrl(false);
    onPasteImageFile(block.id, file, true);
  };

  // Fetch URL metadata for Bookmark Card
  const handleSubmitBookmarkUrl = async (rawInput: string) => {
    const normalized = normalizeExternalUrl(rawInput);
    if (!normalized) return;

    setLoadingBookmark(true);
    setFaviconFailed(false);
    try {
      const meta = await fetchUrlMetadata(normalized);
      onPropsChange(block.id, {
        ...block.props,
        url: meta.url || normalized,
        bookmarkTitle: meta.title || normalized,
        bookmarkDesc: meta.description || "",
        bookmarkSite: meta.siteName || "",
        bookmarkIcon: meta.favicon || "",
      });
    } catch {
      let fallbackHost = normalized;
      try {
        fallbackHost = new URL(normalized).hostname;
      } catch {
        // Keep normalized string
      }
      onPropsChange(block.id, {
        ...block.props,
        url: normalized,
        bookmarkTitle: fallbackHost,
        bookmarkDesc: "",
        bookmarkSite: fallbackHost,
        bookmarkIcon: "",
      });
    } finally {
      setLoadingBookmark(false);
      setEditingBookmark(false);
    }
  };

  const renderBlockBody = () => {
    switch (block.blockType) {
      case "paragraph":
        return renderRichEditable("is-paragraph");

      case "heading1":
        return renderRichEditable("nb-editor-heading1 nb-editor-h1");

      case "heading2":
        return renderRichEditable("nb-editor-heading2 nb-editor-h2");

      case "heading3":
        return renderRichEditable("nb-editor-heading3 nb-editor-h3");

      case "todo": {
        const checked = Boolean(block.props.checked);
        return (
          <div className={`nb-editor-todo-wrap ${checked ? "is-checked" : ""}`}>
            <button
              type="button"
              className={`nb-editor-checkbox ${checked ? "is-checked" : ""}`}
              aria-label={checked ? "标记为未完成" : "标记为已完成"}
              onClick={() =>
                onPropsChange(block.id, {
                  ...block.props,
                  checked: !checked,
                })
              }
            >
              {checked && <Check size={11} strokeWidth={3} />}
            </button>
            {renderRichEditable()}
          </div>
        );
      }

      case "bullet":
        return (
          <div className="nb-editor-list-wrap">
            <span className="nb-editor-bullet-marker" aria-hidden="true">
              •
            </span>
            {renderRichEditable()}
          </div>
        );

      case "numbered":
        return (
          <div className="nb-editor-list-wrap">
            <span className="nb-editor-number-marker" aria-hidden="true">
              {numberedIndex}.
            </span>
            {renderRichEditable()}
          </div>
        );

      case "toggle": {
        const isCollapsed = Boolean(block.props.collapsed);
        return (
          <div className="nb-editor-toggle-wrap">
            <div className="nb-editor-toggle-header">
              <button
                type="button"
                className="nb-editor-toggle-btn"
                title={isCollapsed ? "展开折叠内容" : "收起折叠内容"}
                onClick={() =>
                  onPropsChange(block.id, {
                    ...block.props,
                    collapsed: !isCollapsed,
                  })
                }
              >
                <ChevronRight
                  size={15}
                  className={`nb-editor-toggle-chevron ${
                    !isCollapsed ? "is-expanded" : ""
                  }`}
                />
              </button>
              {renderRichEditable()}
            </div>
            {!isCollapsed && (
              <div className="nb-editor-toggle-body">
                <textarea
                  ref={toggleTextareaRef}
                  rows={1}
                  className="nb-editor-toggle-textarea"
                  placeholder="在此输入折叠详情内容…"
                  value={block.props.childrenText ?? ""}
                  onChange={(e) =>
                    onPropsChange(block.id, {
                      ...block.props,
                      childrenText: e.target.value,
                    })
                  }
                />
              </div>
            )}
          </div>
        );
      }

      case "quote":
        return <div className="nb-editor-quote-wrap">{renderRichEditable()}</div>;

      case "callout": {
        const icon = block.props.calloutIcon || "💡";
        const color = block.props.color || "amber";
        return (
          <div className="nb-editor-callout-wrap" data-callout-color={color}>
            <button
              type="button"
              className="nb-editor-callout-icon-btn"
              title="点击更换提示图标"
              onClick={() => setEmojiOpen((v) => !v)}
            >
              {icon}
            </button>
            {emojiOpen && (
              <div
                ref={emojiPopoverRef}
                className="nb-editor-emoji-popover"
                role="dialog"
                aria-label="选择提示框图标"
              >
                <div className="nb-editor-emoji-grid">
                  {CALLOUT_ICONS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className="nb-editor-emoji-choice"
                      onClick={() => {
                        onPropsChange(block.id, {
                          ...block.props,
                          calloutIcon: em,
                        });
                        setEmojiOpen(false);
                      }}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {renderRichEditable()}
          </div>
        );
      }

      case "mermaid":
        return (
          <MermaidBlock
            blockId={block.id}
            code={block.content}
            mermaidView={block.props.mermaidView}
            preferences={preferences}
            focusRef={(node) => registerFocusTarget(block.id, node)}
            onChangeCode={(next) => onContentChange(block.id, next)}
            onChangeView={(nextView) =>
              onPropsChange(block.id, {
                ...block.props,
                mermaidView: nextView,
              })
            }
            onExitBelow={() => onExitBlockBelow(block.id)}
            onConvertEmptyToParagraph={() => onConvertEmptyToParagraph(block.id)}
          />
        );

      case "code": {
        const langValue = normalizeCodeLanguage(block.props.language);
        if (langValue === "mermaid" || looksLikeMermaidCode(block.content)) {
          return (
            <MermaidBlock
              blockId={block.id}
              code={block.content}
              mermaidView={block.props.mermaidView}
              preferences={preferences}
              focusRef={(node) => registerFocusTarget(block.id, node)}
              onChangeCode={(next) => onContentChange(block.id, next)}
              onChangeView={(nextView) =>
                onPropsChange(block.id, {
                  ...block.props,
                  mermaidView: nextView,
                })
              }
              onExitBelow={() => onExitBlockBelow(block.id)}
              onConvertEmptyToParagraph={() =>
                onConvertEmptyToParagraph(block.id)
              }
            />
          );
        }

        const showCodeLineNumbers = Boolean(preferences?.codeLineNumbers);
        const codeWordWrap =
          block.props.wordWrap ?? preferences?.codeWordWrap ?? true;
        const codeTabSize = Math.max(2, Math.min(8, preferences?.tabSize ?? 2));
        const hasKnownLang = CODE_LANGUAGES.some((l) => l.value === langValue);
        const exitCodeShortcut =
          resolveActionShortcut("block.insertBelow", preferences?.keybindings) ||
          "Ctrl+↵";

        return (
          <div className="nb-editor-code-wrap">
            <div className="nb-editor-code-topbar">
              <select
                className="nb-editor-code-lang"
                aria-label="代码语言"
                value={langValue}
                onChange={(e) => {
                  const chosen = e.target.value;
                  if (chosen === "mermaid") {
                    onMarkdownConvert(block.id, "mermaid", block.content, {
                      ...block.props,
                      language: "mermaid",
                      mermaidView: "preview",
                    });
                    return;
                  }
                  onPropsChange(block.id, {
                    ...block.props,
                    language: chosen,
                  });
                }}
              >
                {!hasKnownLang && (
                  <option value={langValue}>
                    {block.props.language || langValue}
                  </option>
                )}
                {CODE_LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </select>

              <div className="nb-editor-code-actions">
                <span className="nb-editor-code-hint">
                  {exitCodeShortcut} 退出代码块
                </span>
                <button
                  type="button"
                  className={`nb-editor-code-wrap-btn ${
                    codeWordWrap ? "is-active" : ""
                  }`}
                  title={
                    codeWordWrap
                      ? "已开启自动换行（点击切换为横向滚动）"
                      : "已关闭自动换行（点击开启自动换行）"
                  }
                  onClick={() =>
                    onPropsChange(block.id, {
                      ...block.props,
                      wordWrap: !codeWordWrap,
                    })
                  }
                >
                  <WrapText size={12} />
                  <span>自动换行</span>
                </button>
                <button
                  type="button"
                  className={`nb-editor-code-copy-btn ${
                    copiedCode ? "is-copied" : ""
                  }`}
                  onClick={() => {
                    handleCopyCode().catch(() => {});
                  }}
                >
                  {copiedCode ? (
                    <>
                      <Check size={12} />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>复制代码</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="nb-editor-code-body">
              <textarea
                ref={bindCodeTextareaRef}
                className="nb-editor-code-textarea"
                spellCheck={preferences?.spellcheck ?? false}
                rows={2}
                style={{
                  tabSize: codeTabSize,
                  whiteSpace: codeWordWrap ? "pre-wrap" : "pre",
                  wordBreak: codeWordWrap ? "break-word" : "normal",
                  overflowX: codeWordWrap ? "hidden" : "auto",
                }}
                placeholder="// 输入代码，Enter 换行，Ctrl+Enter 跳出到下一块…"
                value={block.content}
                onChange={(e) => onContentChange(block.id, e.target.value)}
                onKeyDown={(e) => {
                  const ta = e.currentTarget;
                  if (
                    (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
                    matchesActionShortcut(
                      e,
                      "block.insertBelow",
                      preferences?.keybindings
                    )
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    onExitBlockBelow(block.id);
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const spaces = " ".repeat(codeTabSize);
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    if (!e.shiftKey) {
                      const nextVal =
                        ta.value.slice(0, start) + spaces + ta.value.slice(end);
                      onContentChange(block.id, nextVal);
                      window.requestAnimationFrame(() => {
                        ta.selectionStart = start + spaces.length;
                        ta.selectionEnd = start + spaces.length;
                      });
                    } else {
                      const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
                      const lineSlice = ta.value.slice(lineStart, end);
                      const unindented = lineSlice.startsWith(spaces)
                        ? lineSlice.slice(spaces.length)
                        : lineSlice.replace(/^[ \t]{1,2}/, "");
                      const delta = lineSlice.length - unindented.length;
                      const nextVal =
                        ta.value.slice(0, lineStart) +
                        unindented +
                        ta.value.slice(end);
                      onContentChange(block.id, nextVal);
                      window.requestAnimationFrame(() => {
                        const nextPos = Math.max(lineStart, start - delta);
                        ta.selectionStart = nextPos;
                        ta.selectionEnd = Math.max(lineStart, end - delta);
                      });
                    }
                    return;
                  }
                  if (
                    e.key === "Backspace" &&
                    ta.value.length === 0 &&
                    !e.ctrlKey &&
                    !e.metaKey
                  ) {
                    e.preventDefault();
                    onConvertEmptyToParagraph(block.id);
                    return;
                  }
                  if (
                    e.key === "ArrowDown" &&
                    !e.shiftKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey
                  ) {
                    if (
                      ta.selectionStart === ta.selectionEnd &&
                      !ta.value.slice(ta.selectionEnd).includes("\n")
                    ) {
                      e.preventDefault();
                      onExitBlockBelow(block.id);
                    }
                    return;
                  }
                  if (
                    e.key === "ArrowUp" &&
                    !e.shiftKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey
                  ) {
                    if (
                      ta.selectionStart === ta.selectionEnd &&
                      !ta.value.slice(0, ta.selectionStart).includes("\n")
                    ) {
                      e.preventDefault();
                      onFocusAdjacentBlock(block.id, "up");
                    }
                  }
                }}
              />
              {showCodeLineNumbers && (
                <LineNumberGutter
                  textareaRef={codeTextareaRef}
                  text={block.content}
                  wrap={codeWordWrap}
                  className="nb-editor-code-gutter"
                  lineClassName="nb-editor-code-line-num"
                />
              )}
            </div>
          </div>
        );
      }

      case "math": {
        const hasFormula = block.content.trim().length > 0;
        const exitMathShortcut =
          resolveActionShortcut("block.insertBelow", preferences?.keybindings) ||
          "Ctrl+↵";
        return (
          <div
            ref={mathWrapRef}
            className={`nb-editor-math-wrap ${
              mathEditing ? "is-editing" : ""
            }`}
          >
            <div
              ref={!mathEditing ? bindMathFocusRef : undefined}
              tabIndex={mathEditing ? -1 : 0}
              role="button"
              aria-label="数学公式块（点击编辑 LaTeX）"
              className="nb-editor-math-display"
              onClick={() => setMathEditing(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setMathEditing(true);
                } else if (e.key === "Backspace" || e.key === "Delete") {
                  if (!hasFormula) {
                    e.preventDefault();
                    onDeleteBlock(block.id);
                  }
                }
              }}
            >
              {hasFormula ? (
                <div
                  className="nb-editor-math-katex"
                  dangerouslySetInnerHTML={{ __html: renderedMathHtml }}
                />
              ) : (
                <div className="nb-editor-math-placeholder">
                  <Sigma size={16} />
                  <span>点击输入 LaTeX 数学公式（如 E = mc^2）</span>
                </div>
              )}
              {!mathEditing && (
                <span className="nb-editor-math-edit-badge">
                  <Pencil size={12} /> 编辑公式
                </span>
              )}
            </div>

            {mathEditing && (
              <div className="nb-editor-math-editor">
                <div className="nb-editor-math-toolbar">
                  <div className="nb-editor-math-presets">
                    {MATH_SYMBOL_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="nb-editor-math-preset-btn"
                        title={preset.latex}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleInsertMathPreset(preset.latex);
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="nb-editor-math-done-btn"
                    onClick={() => setMathEditing(false)}
                  >
                    <Check size={13} /> 完成 ({exitMathShortcut})
                  </button>
                </div>

                <textarea
                  ref={(node) => {
                    mathTextareaRef.current = node;
                    if (node) {
                      registerFocusTarget(block.id, node);
                    }
                  }}
                  className="nb-editor-math-textarea"
                  spellCheck={false}
                  rows={2}
                  placeholder="输入 LaTeX 表达式，例如：\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}"
                  value={block.content}
                  onChange={(e) => onContentChange(block.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
                      matchesActionShortcut(
                        e,
                        "block.insertBelow",
                        preferences?.keybindings
                      )
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      setMathEditing(false);
                      onExitBlockBelow(block.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setMathEditing(false);
                    }
                  }}
                />
              </div>
            )}
          </div>
        );
      }

      case "image": {
        const imageUrl = block.props.url || block.content || "";
        const widthMode = block.props.imageWidth || "full";
        const showPicker = !imageUrl || editingImageUrl;

        return (
          <div className="nb-editor-image-wrap">
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleLocalImageFile(file);
                }
                e.target.value = "";
              }}
            />

            {showPicker ? (
              <div
                className={`nb-editor-media-empty ${
                  imageDropHover ? "is-drop-hover" : ""
                }`}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) {
                    e.preventDefault();
                    e.stopPropagation();
                    setImageDropHover(true);
                  }
                }}
                onDragLeave={() => setImageDropHover(false)}
                onDrop={(e) => {
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    setImageDropHover(false);
                    handleLocalImageFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                <div className="nb-editor-media-empty-top">
                  <div className="nb-editor-media-empty-label">
                    <ImageIcon size={16} />
                    <span>上传本地图片（离线可用）或粘贴图片 URL</span>
                  </div>
                  <button
                    type="button"
                    className="nb-editor-media-upload-btn"
                    onClick={() => imageFileInputRef.current?.click()}
                  >
                    <Upload size={13} /> 选择本地图片
                  </button>
                </div>

                <form
                  className="nb-editor-media-url-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = draftImageUrl.trim();
                    if (!trimmed) return;
                    const normalized = /^(https?:\/\/|data:image\/)/i.test(
                      trimmed
                    )
                      ? trimmed
                      : `https://${trimmed}`;
                    onPropsChange(block.id, {
                      ...block.props,
                      url: normalized,
                      imageWidth: block.props.imageWidth || "full",
                    });
                    setEditingImageUrl(false);
                  }}
                >
                  <input
                    ref={bindGenericInputFocusRef}
                    type="text"
                    className="nb-editor-media-url-input"
                    placeholder="粘贴图片地址 https://example.com/image.png …"
                    value={draftImageUrl}
                    onChange={(e) => setDraftImageUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && imageUrl) {
                        e.preventDefault();
                        setEditingImageUrl(false);
                      }
                    }}
                  />
                  <button type="submit" className="nb-editor-media-submit-btn">
                    嵌入图片
                  </button>
                  {imageUrl && (
                    <button
                      type="button"
                      className="nb-editor-media-cancel-btn"
                      onClick={() => setEditingImageUrl(false)}
                    >
                      取消
                    </button>
                  )}
                </form>
              </div>
            ) : (
              <figure
                className="nb-editor-image-figure"
                data-image-width={widthMode}
              >
                <div className="nb-editor-image-stage">
                  <img
                    src={imageUrl}
                    alt={block.props.caption || "文档图片"}
                    className="nb-editor-image-el"
                    loading="lazy"
                  />
                  <div className="nb-editor-image-toolbar">
                    <button
                      type="button"
                      className={`nb-editor-image-tool-btn ${
                        widthMode === "small" ? "is-active" : ""
                      }`}
                      onClick={() =>
                        onPropsChange(block.id, {
                          ...block.props,
                          imageWidth: "small",
                        })
                      }
                    >
                      小 45%
                    </button>
                    <button
                      type="button"
                      className={`nb-editor-image-tool-btn ${
                        widthMode === "medium" ? "is-active" : ""
                      }`}
                      onClick={() =>
                        onPropsChange(block.id, {
                          ...block.props,
                          imageWidth: "medium",
                        })
                      }
                    >
                      中 72%
                    </button>
                    <button
                      type="button"
                      className={`nb-editor-image-tool-btn ${
                        widthMode === "full" ? "is-active" : ""
                      }`}
                      onClick={() =>
                        onPropsChange(block.id, {
                          ...block.props,
                          imageWidth: "full",
                        })
                      }
                    >
                      宽 100%
                    </button>
                    <span className="nb-editor-image-tool-sep" />
                    <button
                      type="button"
                      className="nb-editor-image-tool-btn"
                      onClick={() => {
                        setDraftImageUrl(
                          imageUrl.startsWith("data:") ? "" : imageUrl
                        );
                        setEditingImageUrl(true);
                      }}
                    >
                      更换
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  className="nb-editor-media-caption"
                  placeholder="添加图片说明…"
                  value={block.props.caption ?? ""}
                  onChange={(e) =>
                    onPropsChange(block.id, {
                      ...block.props,
                      caption: e.target.value,
                    })
                  }
                />
              </figure>
            )}
          </div>
        );
      }

      case "bookmark": {
        const savedUrl = block.props.url || "";
        const showInput = !savedUrl || editingBookmark;

        if (showInput) {
          return (
            <div className="nb-editor-media-empty">
              <div className="nb-editor-media-empty-top">
                <div className="nb-editor-media-empty-label">
                  <Link2 size={16} />
                  <span>创建网页书签卡片（自动提取标题、描述与图标）</span>
                </div>
              </div>
              <form
                className="nb-editor-media-url-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSubmitBookmarkUrl(draftBookmarkUrl).catch(() => {});
                }}
              >
                <input
                  ref={bindGenericInputFocusRef}
                  type="text"
                  disabled={loadingBookmark}
                  className="nb-editor-media-url-input"
                  placeholder="粘贴网页链接 https://... 按回车生成书签"
                  value={draftBookmarkUrl}
                  onChange={(e) => setDraftBookmarkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && savedUrl) {
                      e.preventDefault();
                      setEditingBookmark(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={loadingBookmark || !draftBookmarkUrl.trim()}
                  className="nb-editor-media-submit-btn"
                >
                  {loadingBookmark ? (
                    <>
                      <Loader2 size={13} className="nb-editor-spin" /> 解析中
                    </>
                  ) : (
                    "生成书签"
                  )}
                </button>
                {savedUrl && !loadingBookmark && (
                  <button
                    type="button"
                    className="nb-editor-media-cancel-btn"
                    onClick={() => setEditingBookmark(false)}
                  >
                    取消
                  </button>
                )}
              </form>
            </div>
          );
        }

        const displayTitle = block.props.bookmarkTitle || savedUrl;
        const displayDesc = block.props.bookmarkDesc || "";
        const displaySite = block.props.bookmarkSite || "";
        const iconSrc = !faviconFailed ? block.props.bookmarkIcon : "";
        const safeBookmarkHref = normalizeExternalUrl(savedUrl);
        const openBookmark = () => {
          if (safeBookmarkHref && /^https?:\/\//i.test(safeBookmarkHref)) {
            openExternalUrl(safeBookmarkHref).catch(() =>
              window.open(safeBookmarkHref, "_blank", "noopener,noreferrer")
            );
          }
        };

        return (
          <div
            ref={bindGenericInputFocusRef}
            tabIndex={0}
            role="link"
            className="nb-editor-bookmark-card"
            onClick={openBookmark}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                openBookmark();
              }
            }}
          >
            <div className="nb-editor-bookmark-body">
              <div className="nb-editor-bookmark-title">{displayTitle}</div>
              {displayDesc && (
                <div className="nb-editor-bookmark-desc">{displayDesc}</div>
              )}
              <div className="nb-editor-bookmark-meta">
                {iconSrc ? (
                  <img
                    src={iconSrc}
                    alt=""
                    className="nb-editor-bookmark-favicon"
                    onError={() => setFaviconFailed(true)}
                  />
                ) : (
                  <Globe size={13} className="nb-editor-bookmark-globe" />
                )}
                {displaySite && (
                  <span className="nb-editor-bookmark-site">{displaySite}</span>
                )}
                <span className="nb-editor-bookmark-url">{savedUrl}</span>
              </div>
            </div>

            <div
              className="nb-editor-bookmark-actions"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="nb-editor-bookmark-action-btn"
                title="重新抓取网页信息"
                disabled={loadingBookmark}
                onClick={() => {
                  handleSubmitBookmarkUrl(savedUrl).catch(() => {});
                }}
              >
                <RefreshCw
                  size={13}
                  className={loadingBookmark ? "nb-editor-spin" : ""}
                />
              </button>
              <button
                type="button"
                className="nb-editor-bookmark-action-btn"
                title="修改链接地址"
                onClick={() => {
                  setDraftBookmarkUrl(savedUrl);
                  setEditingBookmark(true);
                }}
              >
                <Pencil size={13} />
              </button>
            </div>
          </div>
        );
      }

      case "embed": {
        const rawUrl = block.props.url || "";
        const parsed = parseEmbedSource(rawUrl);
        const showInput = !parsed || editingEmbed;

        if (showInput) {
          return (
            <div className="nb-editor-media-empty">
              <div className="nb-editor-media-empty-top">
                <div className="nb-editor-media-empty-label">
                  <Film size={16} />
                  <span>
                    嵌入 YouTube、Bilibili、Vimeo、直链 MP4 视频或在线网页
                  </span>
                </div>
              </div>
              <form
                className="nb-editor-media-url-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const resolved = parseEmbedSource(draftEmbedUrl);
                  if (!resolved) return;
                  onPropsChange(block.id, {
                    ...block.props,
                    url: resolved.originalUrl,
                    embedProvider: resolved.provider,
                  });
                  setEditingEmbed(false);
                }}
              >
                <input
                  ref={bindGenericInputFocusRef}
                  type="text"
                  className="nb-editor-media-url-input"
                  placeholder="粘贴 YouTube / Bilibili / MP4 / 网页地址…"
                  value={draftEmbedUrl}
                  onChange={(e) => setDraftEmbedUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && rawUrl) {
                      e.preventDefault();
                      setEditingEmbed(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={!draftEmbedUrl.trim()}
                  className="nb-editor-media-submit-btn"
                >
                  嵌入内容
                </button>
                {rawUrl && (
                  <button
                    type="button"
                    className="nb-editor-media-cancel-btn"
                    onClick={() => setEditingEmbed(false)}
                  >
                    取消
                  </button>
                )}
              </form>
            </div>
          );
        }

        return (
          <div className="nb-editor-embed-wrap">
            <div className="nb-editor-embed-card">
              <div className="nb-editor-embed-topbar">
                <span className="nb-editor-embed-badge">
                  <Film size={12} />
                  <span>{block.props.embedProvider || parsed.provider}</span>
                </span>
                <div className="nb-editor-embed-actions">
                  <button
                    type="button"
                    className="nb-editor-embed-btn"
                    onClick={() => {
                      setDraftEmbedUrl(rawUrl);
                      setEditingEmbed(true);
                    }}
                  >
                    更换链接
                  </button>
                  {/^https?:\/\//i.test(parsed.originalUrl) && (
                    <button
                      type="button"
                      className="nb-editor-embed-btn"
                      onClick={() => {
                        openExternalUrl(parsed.originalUrl).catch(() =>
                          window.open(
                            parsed.originalUrl,
                            "_blank",
                            "noopener,noreferrer"
                          )
                        );
                      }}
                    >
                      <span>打开原链接</span>
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="nb-editor-embed-frame">
                {parsed.kind === "video" ? (
                  <video
                    controls
                    preload="metadata"
                    src={parsed.embedUrl}
                    className="nb-editor-embed-video"
                  />
                ) : (
                  <iframe
                    src={parsed.embedUrl}
                    title={block.props.caption || parsed.provider}
                    sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    loading="lazy"
                    className="nb-editor-embed-iframe"
                  />
                )}
              </div>
            </div>

            <input
              type="text"
              className="nb-editor-media-caption"
              placeholder="添加视频或网页说明…"
              value={block.props.caption ?? ""}
              onChange={(e) =>
                onPropsChange(block.id, {
                  ...block.props,
                  caption: e.target.value,
                })
              }
            />
          </div>
        );
      }

      case "divider":
        return (
          <div
            ref={bindDividerRef}
            tabIndex={0}
            role="separator"
            aria-label="水平分割线（点击选中，按 Backspace 或 Delete 删除）"
            className="nb-editor-divider-wrap"
            onClick={(e) => e.currentTarget.focus()}
            onKeyDown={(e) => {
              if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                onDeleteBlock(block.id);
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                onExitBlockBelow(block.id);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                onFocusAdjacentBlock(block.id, "up");
              }
            }}
          >
            <hr className="nb-editor-divider-line" />
          </div>
        );

      case "table": {
        const headers =
          block.props.headers && block.props.headers.length > 0
            ? block.props.headers
            : ["列 1", "列 2", "列 3"];
        const colCount = headers.length;
        const rawRows =
          block.props.rows && block.props.rows.length > 0
            ? block.props.rows
            : [["", "", ""]];
        const rows = rawRows.map((r) => {
          if (r.length === colCount) return r;
          if (r.length > colCount) return r.slice(0, colCount);
          return [...r, ...Array<string>(colCount - r.length).fill("")];
        });
        const colAlignments: Array<"left" | "center" | "right"> = Array.from(
          { length: colCount },
          (_, idx) => block.props.colAlignments?.[idx] || "left"
        );

        const updateTableData = (
          nextHeaders: string[],
          nextRows: string[][],
          nextAlignments?: Array<"left" | "center" | "right">
        ) => {
          onPropsChange(block.id, {
            ...block.props,
            headers: nextHeaders,
            rows: nextRows,
            colAlignments: nextAlignments ?? block.props.colAlignments,
          });
        };

        const focusCellAt = (targetRow: number, targetCol: number) => {
          window.requestAnimationFrame(() => {
            const cellEl = tableCellRefs.current.get(
              `${targetRow}:${targetCol}`
            );
            if (!cellEl) return;
            cellEl.focus();
            const sel = window.getSelection();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(cellEl);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          });
        };

        const handleCellNavigate = (
          rowIdx: number,
          colIdx: number,
          direction: "next" | "prev" | "down" | "up"
        ) => {
          if (direction === "next") {
            if (colIdx < colCount - 1) {
              focusCellAt(rowIdx, colIdx + 1);
            } else if (rowIdx < rows.length - 1) {
              focusCellAt(rowIdx + 1, 0);
            } else {
              const nextR = [...rows, Array<string>(colCount).fill("")];
              updateTableData(headers, nextR);
              focusCellAt(rows.length, 0);
            }
          } else if (direction === "prev") {
            if (colIdx > 0) {
              focusCellAt(rowIdx, colIdx - 1);
            } else if (rowIdx > -1) {
              focusCellAt(rowIdx - 1, colCount - 1);
            }
          } else if (direction === "down") {
            if (rowIdx < rows.length - 1) {
              focusCellAt(rowIdx + 1, colIdx);
            } else {
              const nextR = [...rows, Array<string>(colCount).fill("")];
              updateTableData(headers, nextR);
              focusCellAt(rows.length, colIdx);
            }
          } else if (direction === "up") {
            if (rowIdx > -1) {
              focusCellAt(rowIdx - 1, colIdx);
            } else {
              onFocusAdjacentBlock(block.id, "up");
            }
          }
        };

        const cycleColumnAlignment = (cIdx: number) => {
          const current = colAlignments[cIdx] || "left";
          const nextAlign: "left" | "center" | "right" =
            current === "left"
              ? "center"
              : current === "center"
              ? "right"
              : "left";
          const nextArr = [...colAlignments];
          nextArr[cIdx] = nextAlign;
          updateTableData(headers, rows, nextArr);
        };

        return (
          <div className="nb-editor-table-outer">
            <div className="nb-editor-table-row-flex">
              <div className="nb-editor-table-scroll">
                <table className="nb-editor-table">
                  <thead>
                    <tr>
                      {headers.map((headerText, cIdx) => {
                        const colAlign = colAlignments[cIdx] || "left";
                        return (
                          <th
                            key={`th-${cIdx}`}
                            style={{ textAlign: colAlign }}
                          >
                            <div className="nb-editor-table-cell-inner is-header">
                                <TableCellRichEditor
                                isHeader
                                value={headerText}
                                pages={pages}
                                align={colAlign}
                                placeholder={`列 ${cIdx + 1}`}
                                spellCheck={preferences?.spellcheck ?? false}
                                inlineMarkdownShortcuts={
                                  preferences?.inlineMarkdownShortcuts !== false
                                }
                                keybindings={preferences?.keybindings}
                                focusRef={(node) => {
                                  if (node) {
                                    tableCellRefs.current.set(
                                      `-1:${cIdx}`,
                                      node
                                    );
                                  } else {
                                    tableCellRefs.current.delete(`-1:${cIdx}`);
                                  }
                                }}
                                onChange={(nextHtml) => {
                                  const nextH = [...headers];
                                  nextH[cIdx] = nextHtml;
                                  updateTableData(nextH, rows);
                                }}
                                onNavigateCell={(dir) =>
                                  handleCellNavigate(-1, cIdx, dir)
                                }
                              />
                              <div className="nb-editor-table-col-tools">
                                <button
                                  type="button"
                                  className="nb-editor-table-align-col"
                                  title={
                                    colAlign === "left"
                                      ? "左对齐（点击切换居中）"
                                      : colAlign === "center"
                                      ? "居中对齐（点击切换右对齐）"
                                      : "右对齐（点击切换左对齐）"
                                  }
                                  onClick={() => cycleColumnAlignment(cIdx)}
                                >
                                  {colAlign === "center" ? (
                                    <AlignCenter size={11} />
                                  ) : colAlign === "right" ? (
                                    <AlignRight size={11} />
                                  ) : (
                                    <AlignLeft size={11} />
                                  )}
                                </button>
                                {headers.length > 1 && (
                                  <button
                                    type="button"
                                    className="nb-editor-table-del-col"
                                    title="删除此列"
                                    onClick={() => {
                                      const nextH = headers.filter(
                                        (_, i) => i !== cIdx
                                      );
                                      const nextR = rows.map((r) =>
                                        r.filter((_, i) => i !== cIdx)
                                      );
                                      const nextA = block.props.colAlignments
                                        ? colAlignments.filter(
                                            (_, i) => i !== cIdx
                                          )
                                        : undefined;
                                      updateTableData(nextH, nextR, nextA);
                                    }}
                                  >
                                    <X size={12} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((rowCells, rIdx) => (
                      <tr key={`tr-${rIdx}`}>
                        {rowCells.map((cellText, cIdx) => {
                          const isLastCol = cIdx === headers.length - 1;
                          const colAlign = colAlignments[cIdx] || "left";
                          return (
                            <td
                              key={`td-${rIdx}-${cIdx}`}
                              style={{ textAlign: colAlign }}
                            >
                              <div className="nb-editor-table-cell-inner">
                                <TableCellRichEditor
                                  value={cellText}
                                  pages={pages}
                                  align={colAlign}
                                  placeholder="输入内容…"
                                  spellCheck={preferences?.spellcheck ?? false}
                                  inlineMarkdownShortcuts={
                                    preferences?.inlineMarkdownShortcuts !==
                                    false
                                  }
                                  keybindings={preferences?.keybindings}
                                  focusRef={(node) => {
                                    if (node) {
                                      tableCellRefs.current.set(
                                        `${rIdx}:${cIdx}`,
                                        node
                                      );
                                    } else {
                                      tableCellRefs.current.delete(
                                        `${rIdx}:${cIdx}`
                                      );
                                    }
                                    if (rIdx === 0 && cIdx === 0) {
                                      bindGenericInputFocusRef(node);
                                    }
                                  }}
                                  onChange={(nextHtml) => {
                                    const nextR = rows.map((r, ri) =>
                                      ri === rIdx
                                        ? r.map((c, ci) =>
                                            ci === cIdx ? nextHtml : c
                                          )
                                        : r
                                    );
                                    updateTableData(headers, nextR);
                                  }}
                                  onNavigateCell={(dir) =>
                                    handleCellNavigate(rIdx, cIdx, dir)
                                  }
                                />
                                {isLastCol && rows.length > 1 && (
                                  <button
                                    type="button"
                                    className="nb-editor-table-del-row"
                                    title="删除此行"
                                    onClick={() => {
                                      const nextR = rows.filter(
                                        (_, ri) => ri !== rIdx
                                      );
                                      updateTableData(headers, nextR);
                                    }}
                                  >
                                    <X size={12} />
                                  </button>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button
                type="button"
                className="nb-editor-table-add-col"
                title="添加一列 (+ 列)"
                onClick={() => {
                  const nextH = [...headers, `列 ${headers.length + 1}`];
                  const nextR = rows.map((r) => [...r, ""]);
                  const nextA = block.props.colAlignments
                    ? [...colAlignments, "left" as const]
                    : undefined;
                  updateTableData(nextH, nextR, nextA);
                }}
              >
                <Plus size={14} />
              </button>
            </div>

            <button
              type="button"
              className="nb-editor-table-add-row"
              onClick={() => {
                const nextR = [...rows, Array<string>(headers.length).fill("")];
                updateTableData(headers, nextR);
              }}
            >
              <Plus size={13} />
              <span>+ 行</span>
            </button>
          </div>
        );
      }
    }
  };

  return (
    <div
      ref={rowRef}
      data-block-id={block.id}
      data-block-type={block.blockType}
      data-block-color={block.props.color || "default"}
      className={[
        "nb-editor-block-row",
        "nb-editor-block",
        isFocusedBlock ? "is-focused-block" : "",
        isHighlighted ? "is-search-highlighted" : "",
        isActionMenuOpen ? "is-menu-open" : "",
        isDragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onFocusCapture={() => onBlockFocus(block.id)}
      onMouseDownCapture={() => onBlockFocus(block.id)}
      onDragOver={(e) => onDragOverBlock(block.id, e)}
      onDrop={(e) => onDropOnBlock(block.id, e)}
    >
      {dropIndicator === "top" && <div className="nb-editor-drop-line is-top" />}

      <div className="nb-editor-gutter" contentEditable={false}>
        <button
          type="button"
          className="nb-editor-gutter-btn nb-editor-gutter-add"
          title={formatTooltipWithShortcut(
            "点击在下方添加新块",
            "block.insertBelow",
            preferences?.keybindings
          )}
          onClick={(e) => onGutterAddBelow(block.id, e.currentTarget)}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          draggable
          className="nb-editor-gutter-btn nb-editor-gutter-drag"
          title={formatTooltipWithShortcut(
            "拖动排序 · 点击打开块菜单",
            "block.openMenu",
            preferences?.keybindings
          )}
          onDragStart={(e) => onDragStartBlock(block.id, e)}
          onDragEnd={onDragEndBlock}
          onClick={(e) => onOpenActionMenu(block.id, e.currentTarget)}
        >
          <GripVertical size={14} />
        </button>
      </div>

      {/* 按块类型加 key：类型变化时整体重建。否则 React 会复用旧的可编辑 div 当外层容器，
          里面用 innerHTML 写入的旧文字残留，出现「我擦 1. 我擦」这种同一行两份内容的问题 */}
      <React.Fragment key={block.blockType}>{renderBlockBody()}</React.Fragment>

      {dropIndicator === "bottom" && (
        <div className="nb-editor-drop-line is-bottom" />
      )}
    </div>
  );
};

// 只有自己的属性变化时才重新渲染：长文档里输入一个字只更新正在编辑的那一行
export const BlockRow = React.memo(BlockRowInner);
BlockRow.displayName = "BlockRow";
