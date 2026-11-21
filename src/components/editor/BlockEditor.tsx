import {
  clearBlockHistory,
  createBlockHistory,
  firstChangedBlockId,
  recordBlockChange,
  takeRedo,
  takeUndo,
} from "./blockHistory";
import { reconcileBlockIds } from "./blockReconcile";
import { useStableCallback } from "../../hooks/useStableCallback";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { iconAsText } from "../../icons/pageIcon";
import { openPathInExplorer, saveAssetImage, saveLocalNoteImage } from "../../api/client";
import type {
  Block,
  BlockProps,
  BlockType,
  DocumentStats,
  EditorPreferences,
  EditorViewMode,
  Page,
} from "../../types/notion";
import { BlockActionMenu } from "./BlockActionMenu";
import { BlockRow } from "./BlockRow";
import {
  BLOCK_COLOR_ACTION_ENTRIES,
  eventToCanonicalShortcut,
  matchesShortcutCombo,
  TURN_INTO_ACTION_BLOCK_TYPES,
} from "./editorKeybindings";
import {
  activateInlineHref,
  buildPropsForBlockType,
  computeBlockPlainText,
  createNewBlock,
  DEFAULT_MERMAID_STARTER,
  deleteCharsBeforeCaret,
  DetectedTrigger,
  escapeHtml,
  generateBlockId,
  insertHtmlAtCaret,
  isHtmlVisuallyEmpty,
  isRichTextEditableBlock,
  isStandaloneStructuralBlock,
  normalizeCleanHtml,
  placeCaretAtEnd,
  placeCaretAtStart,
  placeCaretAtTextOffset,
  SlashActionType,
  stripHtmlToText,
} from "./editorUtils";
import { InlineToolbar } from "./InlineToolbar";
import {
  blocksToMarkdown,
  computeDocumentStats,
  markdownToBlocks,
  upgradeResidualInlineMarkdown,
} from "./markdownCodec";
import { OutlinePanel } from "./OutlinePanel";
import { SlashMenu } from "./SlashMenu";
import { SourceEditor } from "./SourceEditor";
import { WikiLinkMenu } from "./WikiLinkMenu";
import "./editor.css";

export interface BlockEditorProps {
  pageId: string;
  blocks: Block[];
  pages: Page[];
  fullWidth?: boolean;
  fontStyle?: "sans" | "serif" | "mono" | "custom";
  highlightBlockId?: string | null;
  preferences?: EditorPreferences;
  rawMarkdownOverride?: string | null;
  onViewModeChange?: (mode: EditorViewMode) => void;
  onRawMarkdownChange?: (markdown: string, parsedBlocks: Block[]) => void;
  onStatsChange?: (stats: DocumentStats) => void;
  onBlocksChange: (blocks: Block[]) => void;
  onNavigatePage: (pageId: string) => void;
  onCreateSubpage?: (title: string) => Promise<Page>;
}

interface ActiveTriggerMenuState {
  mode: "slash" | "wikilink";
  blockId: string;
  query: string;
  removeChars: number;
  anchor: { x: number; y: number; bottom: number };
  openedFromGutter?: boolean;
}

interface ActionMenuState {
  blockId: string;
  anchorRect: { left: number; top: number };
}

type FocusPlacement = "start" | "end" | { offset: number };

function normalizeIncomingBlocks(
  pageId: string,
  incoming: Block[],
  pages: Page[]
): Block[] {
  if (!incoming || incoming.length === 0) {
    return [createNewBlock(pageId, "paragraph", 0, "")];
  }
  return [...incoming]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((rawBlk, idx) => {
      let blk =
        rawBlk.sortOrder === idx ? rawBlk : { ...rawBlk, sortOrder: idx };

      // Never touch raw text blocks (`code`, `math`, `mermaid`)
      if (
        blk.blockType === "code" ||
        blk.blockType === "math" ||
        blk.blockType === "mermaid"
      ) {
        return blk;
      }

      if (isRichTextEditableBlock(blk.blockType) && blk.content) {
        const upgraded = upgradeResidualInlineMarkdown(blk.content, pages);
        if (upgraded !== blk.content) {
          blk = {
            ...blk,
            content: upgraded,
            plainText: computeBlockPlainText(
              blk.blockType,
              upgraded,
              blk.props
            ),
          };
        }
      } else if (blk.blockType === "table") {
        const prevHeaders = blk.props.headers ?? [];
        const prevRows = blk.props.rows ?? [];
        let tableChanged = false;
        const nextHeaders = prevHeaders.map((h) => {
          const up = upgradeResidualInlineMarkdown(h || "", pages);
          if (up !== h) tableChanged = true;
          return up;
        });
        const nextRows = prevRows.map((row) =>
          row.map((cell) => {
            const up = upgradeResidualInlineMarkdown(cell || "", pages);
            if (up !== cell) tableChanged = true;
            return up;
          })
        );
        if (tableChanged) {
          const nextProps: BlockProps = {
            ...blk.props,
            headers: nextHeaders,
            rows: nextRows,
          };
          blk = {
            ...blk,
            props: nextProps,
            plainText: computeBlockPlainText("table", blk.content, nextProps),
          };
        }
      }

      return blk;
    });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const BlockEditor: React.FC<BlockEditorProps> = ({
  pageId,
  blocks,
  pages,
  fullWidth = true,
  fontStyle = "sans",
  highlightBlockId = null,
  preferences,
  rawMarkdownOverride = null,
  onViewModeChange,
  onRawMarkdownChange,
  onStatsChange,
  onBlocksChange,
  onNavigatePage,
  onCreateSubpage,
}) => {
  const [localBlocks, setLocalBlocks] = useState<Block[]>(() =>
    normalizeIncomingBlocks(pageId, blocks, pages)
  );
  const [fallbackViewMode, setFallbackViewMode] =
    useState<EditorViewMode>("wysiwyg");
  const effectiveViewMode: EditorViewMode =
    preferences?.viewMode ?? fallbackViewMode;

  const [sourceText, setSourceText] = useState<string>(() =>
    rawMarkdownOverride !== null && rawMarkdownOverride !== undefined
      ? rawMarkdownOverride
      : blocksToMarkdown(normalizeIncomingBlocks(pageId, blocks, pages), pages)
  );
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<ActiveTriggerMenuState | null>(
    null
  );
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    blockId: string;
    position: "top" | "bottom";
  } | null>(null);
  const [pulsingBlockId, setPulsingBlockId] = useState<string | null>(null);

  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const prevPageIdRef = useRef<string>(pageId);
  const prevViewModeRef = useRef<EditorViewMode>(effectiveViewMode);
  const lastEmittedRef = useRef<Block[] | null>(null);
  // 所见即所得的撤销 / 重做（跨块：分段、删除、转换、拖动都能撤销）
  const historyRef = useRef(createBlockHistory());
  const localBlocksRef = useRef<Block[]>(localBlocks);
  localBlocksRef.current = localBlocks;
  const focusTargetsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pendingFocusRef = useRef<{
    blockId: string;
    placement: FocusPlacement;
  } | null>(null);

  const changeViewMode = useCallback(
    (nextMode: EditorViewMode) => {
      setFallbackViewMode(nextMode);
      onViewModeChange?.(nextMode);
    },
    [onViewModeChange]
  );

  // Sync blocks cleanly on page switch or genuine external reload
  useEffect(() => {
    if (prevPageIdRef.current !== pageId) {
      prevPageIdRef.current = pageId;
      lastEmittedRef.current = null;
      clearBlockHistory(historyRef.current);
      setActiveMenu(null);
      setActionMenu(null);
      setDraggingBlockId(null);
      setDropTarget(null);
      setFocusedBlockId(null);
      const normalized = normalizeIncomingBlocks(pageId, blocks, pages);
      setLocalBlocks(normalized);
      setSourceText(
        rawMarkdownOverride !== null && rawMarkdownOverride !== undefined
          ? rawMarkdownOverride
          : blocksToMarkdown(normalized, pages)
      );
      return;
    }

    if (blocks !== lastEmittedRef.current) {
      // 外部改动（磁盘文件被改、同步拉取等）后旧的撤销记录不再对应当前内容
      clearBlockHistory(historyRef.current);
      const normalized = normalizeIncomingBlocks(pageId, blocks, pages);
      setLocalBlocks(normalized);
      const isSourceTextareaFocused =
        typeof document !== "undefined" &&
        document.activeElement?.classList.contains("nb-editor-source-textarea");
      if (effectiveViewMode !== "wysiwyg" && !isSourceTextareaFocused) {
        setSourceText(
          rawMarkdownOverride !== null && rawMarkdownOverride !== undefined
            ? rawMarkdownOverride
            : blocksToMarkdown(normalized, pages)
        );
      }
    }
  }, [blocks, effectiveViewMode, pageId, pages, rawMarkdownOverride]);

  // Serialize latest blocks into sourceText when transitioning from WYSIWYG -> Source / Split
  useEffect(() => {
    const prevMode = prevViewModeRef.current;
    if (prevMode !== effectiveViewMode) {
      prevViewModeRef.current = effectiveViewMode;
      setActiveMenu(null);
      setActionMenu(null);
      if (prevMode === "wysiwyg" && effectiveViewMode !== "wysiwyg") {
        setSourceText(blocksToMarkdown(localBlocksRef.current, pages));
      }
    }
  }, [effectiveViewMode, pages]);

  // Live DocumentStats computation & notification
  const liveStats = useMemo<DocumentStats>(
    () =>
      computeDocumentStats(
        localBlocks,
        effectiveViewMode !== "wysiwyg" ? sourceText : rawMarkdownOverride
      ),
    [effectiveViewMode, localBlocks, rawMarkdownOverride, sourceText]
  );

  useEffect(() => {
    onStatsChange?.(liveStats);
  }, [liveStats, onStatsChange]);

  // Typora Typewriter Mode (F9): smoothly keep active edited block vertically centered
  useEffect(() => {
    if (
      !preferences?.typewriterMode ||
      effectiveViewMode !== "wysiwyg" ||
      !focusedBlockId
    ) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      const root = editorRootRef.current;
      if (!root) return;
      const escapedId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(focusedBlockId)
          : focusedBlockId;
      const targetRow = root.querySelector(
        `[data-block-id="${escapedId}"]`
      ) as HTMLElement | null;
      if (targetRow) {
        targetRow.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [
    effectiveViewMode,
    focusedBlockId,
    localBlocks,
    preferences?.typewriterMode,
  ]);

  // Pulse-highlight target block when navigated from Ctrl+K search
  useEffect(() => {
    if (!highlightBlockId) {
      setPulsingBlockId(null);
      return;
    }
    setPulsingBlockId(highlightBlockId);
    const timer = window.setTimeout(() => {
      setPulsingBlockId((curr) => (curr === highlightBlockId ? null : curr));
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [highlightBlockId, pageId]);

  // Execute queued imperative focus right after DOM updates
  useLayoutEffect(() => {
    const req = pendingFocusRef.current;
    if (!req) return;
    const el = focusTargetsRef.current.get(req.blockId);
    if (!el) return;
    pendingFocusRef.current = null;
    setFocusedBlockId(req.blockId);

    if (el.isContentEditable) {
      if (req.placement === "start") {
        placeCaretAtStart(el);
      } else if (req.placement === "end") {
        placeCaretAtEnd(el);
      } else {
        placeCaretAtTextOffset(el, req.placement.offset);
      }
      return;
    }

    if (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLInputElement
    ) {
      el.focus();
      const pos =
        req.placement === "start"
          ? 0
          : req.placement === "end"
          ? el.value.length
          : Math.min(req.placement.offset, el.value.length);
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        // Ignore selection range on unsupported input types
      }
      return;
    }

    el.focus();
  }, [localBlocks, effectiveViewMode]);

  const registerFocusTarget = useCallback(
    (blockId: string, el: HTMLElement | null) => {
      if (el) {
        focusTargetsRef.current.set(blockId, el);
      } else {
        focusTargetsRef.current.delete(blockId);
      }
    },
    []
  );

  const commitBlocks = useCallback(
    (nextList: Block[]) => {
      const safeList =
        nextList.length > 0
          ? nextList
          : [createNewBlock(pageId, "paragraph", 0, "")];

      const reindexed = safeList.map((blk, idx) =>
        blk.sortOrder === idx ? blk : { ...blk, sortOrder: idx }
      );
      recordBlockChange(historyRef.current, localBlocksRef.current, reindexed);
      lastEmittedRef.current = reindexed;
      setLocalBlocks(reindexed);
      onBlocksChange(reindexed);
    },
    [onBlocksChange, pageId]
  );

  // Compute consecutive 1. 2. 3. numbering across adjacent numbered blocks
  const numberedIndices = useMemo<number[]>(() => {
    let count = 0;
    return localBlocks.map((blk) => {
      if (blk.blockType === "numbered") {
        count += 1;
        return count;
      }
      count = 0;
      return 0;
    });
  }, [localBlocks]);

  const handleContentChange = useCallback(
    (blockId: string, nextContent: string) => {
      const now = new Date().toISOString();
      const updated = localBlocks.map((blk) => {
        if (blk.id !== blockId) return blk;
        return {
          ...blk,
          content: nextContent,
          plainText: computeBlockPlainText(
            blk.blockType,
            nextContent,
            blk.props
          ),
          updatedAt: now,
        };
      });
      commitBlocks(updated);
    },
    [commitBlocks, localBlocks]
  );

  const handlePropsChange = useCallback(
    (blockId: string, nextProps: BlockProps) => {
      const now = new Date().toISOString();
      const updated = localBlocks.map((blk) => {
        if (blk.id !== blockId) return blk;
        return {
          ...blk,
          props: nextProps,
          plainText: computeBlockPlainText(
            blk.blockType,
            blk.content,
            nextProps
          ),
          updatedAt: now,
        };
      });
      commitBlocks(updated);
    },
    [commitBlocks, localBlocks]
  );

  const convertBlockTypeInternal = useCallback(
    (
      blockId: string,
      targetType: BlockType,
      overrideHtml?: string,
      extraProps?: BlockProps
    ) => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const current = localBlocks[idx];
      const now = new Date().toISOString();
      const mergedProps = buildPropsForBlockType(targetType, {
        ...current.props,
        ...extraProps,
      });

      let nextContent =
        overrideHtml !== undefined ? overrideHtml : current.content;

      const isCurrentRaw =
        current.blockType === "code" ||
        current.blockType === "math" ||
        current.blockType === "mermaid";
      const isTargetRaw =
        targetType === "code" ||
        targetType === "math" ||
        targetType === "mermaid";

      // Cleanly bridge HTML <-> raw unescaped text for `code`, `math`, and `mermaid` blocks
      if (isTargetRaw && !isCurrentRaw) {
        // When `overrideHtml` is explicitly passed for `math` or `mermaid` (e.g. `$$a < b$$` or starter diagram), keep raw text intact!
        if (overrideHtml === undefined || targetType === "code") {
          nextContent = stripHtmlToText(nextContent);
        }
        if (
          targetType === "mermaid" &&
          !nextContent.trim() &&
          overrideHtml === undefined
        ) {
          nextContent = DEFAULT_MERMAID_STARTER;
        }
      } else if (isCurrentRaw && isRichTextEditableBlock(targetType)) {
        nextContent = escapeHtml(nextContent).replace(/\r?\n/g, "<br>");
      } else if (
        targetType === "divider" ||
        targetType === "table" ||
        targetType === "image" ||
        targetType === "bookmark" ||
        targetType === "embed"
      ) {
        if (
          !mergedProps.url &&
          (targetType === "image" ||
            targetType === "bookmark" ||
            targetType === "embed")
        ) {
          const candidateText = stripHtmlToText(current.content).trim();
          if (/^https?:\/\/\S+$/i.test(candidateText)) {
            mergedProps.url = candidateText;
          }
        }
        nextContent = "";
      }

      const converted: Block = {
        ...current,
        blockType: targetType,
        content: nextContent,
        plainText: computeBlockPlainText(targetType, nextContent, mergedProps),
        props: mergedProps,
        updatedAt: now,
      };

      const nextList = [...localBlocks];
      nextList[idx] = converted;

      // When inserting a divider, ensure there's a writable block right below and focus it
      if (targetType === "divider") {
        if (idx === nextList.length - 1) {
          const trailing = createNewBlock(pageId, "paragraph", idx + 1, "");
          nextList.push(trailing);
          pendingFocusRef.current = {
            blockId: trailing.id,
            placement: "start",
          };
        } else {
          pendingFocusRef.current = {
            blockId: nextList[idx + 1].id,
            placement: "start",
          };
        }
      } else {
        pendingFocusRef.current = {
          blockId: converted.id,
          placement: nextContent ? "end" : "start",
        };
      }

      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks, pageId]
  );

  const handleMarkdownConvert = useCallback(
    (
      blockId: string,
      nextType: BlockType,
      remainingHtml: string,
      extraProps?: BlockProps
    ) => {
      convertBlockTypeInternal(blockId, nextType, remainingHtml, extraProps);
    },
    [convertBlockTypeInternal]
  );

  const handleSplitBlockOnEnter = useCallback(
    (blockId: string, beforeHtml: string, afterHtml: string) => {
      setActiveMenu(null);
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const current = localBlocks[idx];
      const now = new Date().toISOString();

      const updatedCurrent: Block = {
        ...current,
        content: beforeHtml,
        plainText: computeBlockPlainText(
          current.blockType,
          beforeHtml,
          current.props
        ),
        updatedAt: now,
      };

      const continuationType: BlockType =
        current.blockType === "bullet" ||
        current.blockType === "numbered" ||
        current.blockType === "todo"
          ? current.blockType
          : "paragraph";

      const nextBlock = createNewBlock(
        pageId,
        continuationType,
        idx + 1,
        afterHtml,
        continuationType === "todo" ? { checked: false } : undefined
      );

      const nextList = [
        ...localBlocks.slice(0, idx),
        updatedCurrent,
        nextBlock,
        ...localBlocks.slice(idx + 1),
      ];

      pendingFocusRef.current = { blockId: nextBlock.id, placement: "start" };
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks, pageId]
  );

  const handleConvertEmptyToParagraph = useCallback(
    (blockId: string) => {
      setActiveMenu(null);
      convertBlockTypeInternal(blockId, "paragraph", "");
    },
    [convertBlockTypeInternal]
  );

  const handleBackspaceAtStart = useCallback(
    (blockId: string, currentHtml: string) => {
      setActiveMenu(null);
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const current = localBlocks[idx];

      // 1. Non-paragraph blocks convert back to plain paragraph first (Notion standard UX)
      if (current.blockType !== "paragraph") {
        convertBlockTypeInternal(blockId, "paragraph", currentHtml);
        return;
      }

      // 2. First block on page stays intact
      if (idx === 0) return;

      const prev = localBlocks[idx - 1];

      // 3. Merge into previous rich-text block if possible
      if (isRichTextEditableBlock(prev.blockType)) {
        const prevCharLen = stripHtmlToText(prev.content).length;
        const mergedHtml = normalizeCleanHtml(
          `${prev.content}${currentHtml}`
        );
        const now = new Date().toISOString();
        const updatedPrev: Block = {
          ...prev,
          content: mergedHtml,
          plainText: computeBlockPlainText(
            prev.blockType,
            mergedHtml,
            prev.props
          ),
          updatedAt: now,
        };

        const nextList = [
          ...localBlocks.slice(0, idx - 1),
          updatedPrev,
          ...localBlocks.slice(idx + 1),
        ];

        pendingFocusRef.current = {
          blockId: updatedPrev.id,
          placement: { offset: prevCharLen },
        };
        commitBlocks(nextList);
        return;
      }

      // 4. If current paragraph is empty and previous block is divider/code/table, remove empty block & focus prev
      if (isHtmlVisuallyEmpty(currentHtml)) {
        const nextList = localBlocks.filter((b) => b.id !== blockId);
        pendingFocusRef.current = { blockId: prev.id, placement: "end" };
        commitBlocks(nextList);
      } else {
        pendingFocusRef.current = { blockId: prev.id, placement: "end" };
      }
    },
    [commitBlocks, convertBlockTypeInternal, localBlocks]
  );

  const handleDeleteBlock = useCallback(
    (blockId: string) => {
      setActiveMenu(null);
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      if (localBlocks.length === 1) {
        const fresh = createNewBlock(pageId, "paragraph", 0, "");
        pendingFocusRef.current = { blockId: fresh.id, placement: "start" };
        commitBlocks([fresh]);
        return;
      }

      const nextFocusTarget =
        idx > 0 ? localBlocks[idx - 1] : localBlocks[idx + 1];
      const nextList = localBlocks.filter((b) => b.id !== blockId);
      if (nextFocusTarget) {
        pendingFocusRef.current = {
          blockId: nextFocusTarget.id,
          placement: idx > 0 ? "end" : "start",
        };
      }
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks, pageId]
  );

  const handleExitBlockBelow = useCallback(
    (blockId: string) => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      if (idx < localBlocks.length - 1) {
        const nextBlk = localBlocks[idx + 1];
        const nextEl = focusTargetsRef.current.get(nextBlk.id);
        if (nextEl) {
          if (nextEl.isContentEditable) {
            placeCaretAtStart(nextEl);
          } else {
            nextEl.focus();
          }
          return;
        }
      }

      const inserted = createNewBlock(pageId, "paragraph", idx + 1, "");
      const nextList = [
        ...localBlocks.slice(0, idx + 1),
        inserted,
        ...localBlocks.slice(idx + 1),
      ];
      pendingFocusRef.current = { blockId: inserted.id, placement: "start" };
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks, pageId]
  );

  const handleFocusAdjacentBlock = useCallback(
    (blockId: string, direction: "up" | "down") => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= localBlocks.length) return;

      const targetBlk = localBlocks[targetIdx];
      const el = focusTargetsRef.current.get(targetBlk.id);
      if (!el) return;

      if (el.isContentEditable) {
        if (direction === "up") {
          placeCaretAtEnd(el);
        } else {
          placeCaretAtStart(el);
        }
      } else if (
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement
      ) {
        el.focus();
        const pos = direction === "up" ? el.value.length : 0;
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          // Ignore unsupported selectionRange
        }
      } else {
        el.focus();
      }
    },
    [localBlocks]
  );

  const handleTriggerMenuChange = useCallback(
    (
      blockId: string,
      trigger: DetectedTrigger | null,
      anchor: { x: number; y: number; bottom: number }
    ) => {
      if (!trigger) {
        setActiveMenu((prev) =>
          prev && !prev.openedFromGutter ? null : prev
        );
        return;
      }

      setActiveMenu({
        mode: trigger.mode,
        blockId,
        query: trigger.query,
        removeChars: trigger.removeChars,
        anchor,
        openedFromGutter: false,
      });
    },
    []
  );

  // Left Gutter `+`: insert block below & immediately open `/` menu
  const handleGutterAddBelow = useCallback(
    (blockId: string, buttonEl: HTMLElement) => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const rect = buttonEl.getBoundingClientRect();
      const inserted = createNewBlock(pageId, "paragraph", idx + 1, "");
      const nextList = [
        ...localBlocks.slice(0, idx + 1),
        inserted,
        ...localBlocks.slice(idx + 1),
      ];

      pendingFocusRef.current = { blockId: inserted.id, placement: "start" };
      commitBlocks(nextList);

      setActiveMenu({
        mode: "slash",
        blockId: inserted.id,
        query: "",
        removeChars: 0,
        anchor: {
          x: rect.right + 12,
          y: rect.bottom + 4,
          bottom: rect.bottom + 8,
        },
        openedFromGutter: true,
      });
    },
    [commitBlocks, localBlocks, pageId]
  );

  // Insert wiki-link HTML into a target block cleanly
  const insertWikiLinkIntoBlock = useCallback(
    (blockId: string, removeChars: number, targetPage: Page) => {
      const icon = escapeHtml(
        iconAsText(targetPage.icon, targetPage.pageType === "database" ? "🗃️" : "📄")
      );
      const title = escapeHtml(targetPage.title || "无标题");
      const linkHtml = `<a href="#" data-page-id="${escapeHtml(
        targetPage.id
      )}" class="nb-wiki-link">${icon} ${title}</a>&nbsp;`;

      const el = focusTargetsRef.current.get(blockId);
      if (el && el.isContentEditable && document.body.contains(el)) {
        el.focus();
        if (removeChars > 0) {
          deleteCharsBeforeCaret(el, removeChars);
        }
        insertHtmlAtCaret(el, linkHtml);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      // Fallback if element lost focus during async subpage creation
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const blk = localBlocks[idx];
      const nextHtml = normalizeCleanHtml(`${blk.content}${linkHtml}`);
      handleContentChange(blockId, nextHtml);
      pendingFocusRef.current = { blockId, placement: "end" };
    },
    [handleContentChange, localBlocks]
  );

  // Slash Menu item selection
  const handleSelectSlashCommand = useCallback(
    async (actionType: SlashActionType) => {
      const menuSnapshot = activeMenu;
      if (!menuSnapshot) return;
      setActiveMenu(null);

      const { blockId, removeChars, openedFromGutter } = menuSnapshot;
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const el = focusTargetsRef.current.get(blockId);
      let cleanedHtml = localBlocks[idx].content;

      if (
        !openedFromGutter &&
        removeChars > 0 &&
        el &&
        el.isContentEditable
      ) {
        el.focus();
        deleteCharsBeforeCaret(el, removeChars);
        cleanedHtml = normalizeCleanHtml(el.innerHTML);
      }

      // Handle subpage creation & wiki-link insertion
      if (actionType === "subpage") {
        if (!onCreateSubpage) return;
        // Commit cleaned text first so `/page` trigger disappears immediately
        handleContentChange(blockId, cleanedHtml);
        try {
          const created = await onCreateSubpage("无标题子页面");
          const icon = escapeHtml(iconAsText(created.icon));
          const title = escapeHtml(created.title || "无标题子页面");
          const linkHtml = `<a href="#" data-page-id="${escapeHtml(
            created.id
          )}" class="nb-wiki-link">${icon} ${title}</a>&nbsp;`;
          const combined = normalizeCleanHtml(
            cleanedHtml ? `${cleanedHtml} ${linkHtml}` : linkHtml
          );
          const now = new Date().toISOString();
          clearBlockHistory(historyRef.current);
          setLocalBlocks((prev) => {
            const next = prev.map((b) =>
              b.id === blockId
                ? {
                    ...b,
                    content: combined,
                    plainText: computeBlockPlainText(
                      b.blockType,
                      combined,
                      b.props
                    ),
                    updatedAt: now,
                  }
                : b
            );
            lastEmittedRef.current = next;
            onBlocksChange(next);
            return next;
          });
          pendingFocusRef.current = { blockId, placement: "end" };
        } catch {
          // Ignore subpage creation cancellation/failure
        }
        return;
      }

      // If current block already has text AND user chose a standalone structural block, insert below
      const hasExistingText = !isHtmlVisuallyEmpty(cleanedHtml);
      if (hasExistingText && isStandaloneStructuralBlock(actionType)) {
        const now = new Date().toISOString();
        const updatedCurrent: Block = {
          ...localBlocks[idx],
          content: cleanedHtml,
          plainText: computeBlockPlainText(
            localBlocks[idx].blockType,
            cleanedHtml,
            localBlocks[idx].props
          ),
          updatedAt: now,
        };

        const structuralInitial =
          actionType === "mermaid" ? DEFAULT_MERMAID_STARTER : "";
        const structuralBlock = createNewBlock(
          pageId,
          actionType,
          idx + 1,
          structuralInitial
        );
        const nextList = [
          ...localBlocks.slice(0, idx),
          updatedCurrent,
          structuralBlock,
          ...localBlocks.slice(idx + 1),
        ];

        if (actionType === "divider") {
          const afterDivider = createNewBlock(pageId, "paragraph", idx + 2, "");
          nextList.splice(idx + 2, 0, afterDivider);
          pendingFocusRef.current = {
            blockId: afterDivider.id,
            placement: "start",
          };
        } else {
          pendingFocusRef.current = {
            blockId: structuralBlock.id,
            placement: "start",
          };
        }

        commitBlocks(nextList);
        return;
      }

      if (actionType === "mermaid") {
        const initialMermaid = hasExistingText
          ? stripHtmlToText(cleanedHtml)
          : DEFAULT_MERMAID_STARTER;
        convertBlockTypeInternal(blockId, "mermaid", initialMermaid, {
          mermaidView: "preview",
        });
        return;
      }

      if (actionType === "code" || actionType === "math") {
        const initialRaw = hasExistingText ? stripHtmlToText(cleanedHtml) : "";
        convertBlockTypeInternal(blockId, actionType, initialRaw);
        return;
      }

      convertBlockTypeInternal(blockId, actionType, cleanedHtml);
    },
    [
      activeMenu,
      commitBlocks,
      convertBlockTypeInternal,
      handleContentChange,
      localBlocks,
      onBlocksChange,
      onCreateSubpage,
      pageId,
    ]
  );

  // WikiLink Menu item selection
  const handleSelectWikiPage = useCallback(
    (targetPage: Page) => {
      const snapshot = activeMenu;
      if (!snapshot) return;
      setActiveMenu(null);
      insertWikiLinkIntoBlock(
        snapshot.blockId,
        snapshot.removeChars,
        targetPage
      );
    },
    [activeMenu, insertWikiLinkIntoBlock]
  );

  const handleCreateAndLinkSubpage = useCallback(
    async (subpageTitle: string) => {
      const snapshot = activeMenu;
      if (!snapshot || !onCreateSubpage) return;
      setActiveMenu(null);

      const el = focusTargetsRef.current.get(snapshot.blockId);
      let baseHtml =
        localBlocks.find((b) => b.id === snapshot.blockId)?.content ?? "";
      if (el && el.isContentEditable && snapshot.removeChars > 0) {
        el.focus();
        deleteCharsBeforeCaret(el, snapshot.removeChars);
        baseHtml = normalizeCleanHtml(el.innerHTML);
        handleContentChange(snapshot.blockId, baseHtml);
      }

      try {
        const created = await onCreateSubpage(subpageTitle);
        const icon = escapeHtml(iconAsText(created.icon));
        const title = escapeHtml(created.title || subpageTitle);
        const linkHtml = `<a href="#" data-page-id="${escapeHtml(
          created.id
        )}" class="nb-wiki-link">${icon} ${title}</a>&nbsp;`;
        const merged = normalizeCleanHtml(`${baseHtml}${linkHtml}`);
        const now = new Date().toISOString();
        clearBlockHistory(historyRef.current);
        setLocalBlocks((prev) => {
          const next = prev.map((b) =>
            b.id === snapshot.blockId
              ? {
                  ...b,
                  content: merged,
                  plainText: computeBlockPlainText(
                    b.blockType,
                    merged,
                    b.props
                  ),
                  updatedAt: now,
                }
              : b
          );
          lastEmittedRef.current = next;
          onBlocksChange(next);
          return next;
        });
        pendingFocusRef.current = {
          blockId: snapshot.blockId,
          placement: "end",
        };
      } catch {
        // Ignore subpage creation error
      }
    },
    [activeMenu, handleContentChange, localBlocks, onBlocksChange, onCreateSubpage]
  );

  // Context Menu (`⋮⋮` or `block.openMenu` shortcut) Actions
  const handleOpenActionMenu = useCallback(
    (blockId: string, buttonEl: HTMLElement) => {
      setActiveMenu(null);
      const rect = buttonEl.getBoundingClientRect();
      setActionMenu((prev) =>
        prev?.blockId === blockId
          ? null
          : {
              blockId,
              anchorRect: { left: rect.left, top: rect.bottom + 4 },
            }
      );
    },
    []
  );

  const openActionMenuForBlockId = useCallback((blockId: string) => {
    setActiveMenu(null);
    setActionMenu((prev) => {
      if (prev?.blockId === blockId) {
        return null;
      }
      const root = editorRootRef.current;
      let anchorRect = { left: 120, top: 140 };
      if (root) {
        const escapedId =
          typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(blockId)
            : blockId;
        const rowEl = root.querySelector(
          `[data-block-id="${escapedId}"]`
        ) as HTMLElement | null;
        if (rowEl) {
          const dragBtn = rowEl.querySelector(
            ".nb-editor-gutter-drag"
          ) as HTMLElement | null;
          const dragRect = dragBtn?.getBoundingClientRect();
          if (dragRect && dragRect.width > 0 && dragRect.height > 0) {
            anchorRect = { left: dragRect.left, top: dragRect.bottom + 4 };
          } else {
            const rowRect = rowEl.getBoundingClientRect();
            anchorRect = {
              left: Math.max(16, rowRect.left),
              top: rowRect.top + 28,
            };
          }
        }
      }
      return { blockId, anchorRect };
    });
  }, []);

  const handleInsertBlockBelow = useCallback(
    (blockId: string) => {
      setActiveMenu(null);
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const inserted = createNewBlock(pageId, "paragraph", idx + 1, "");
      const nextList = [
        ...localBlocks.slice(0, idx + 1),
        inserted,
        ...localBlocks.slice(idx + 1),
      ];
      pendingFocusRef.current = { blockId: inserted.id, placement: "start" };
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks, pageId]
  );

  const handleTurnIntoFromActionMenu = useCallback(
    (blockId: string, nextType: BlockType) => {
      convertBlockTypeInternal(blockId, nextType);
    },
    [convertBlockTypeInternal]
  );

  const handleChangeBlockColor = useCallback(
    (blockId: string, color: string) => {
      const blk = localBlocks.find((b) => b.id === blockId);
      if (!blk) return;
      const nextProps: BlockProps = { ...blk.props };
      if (color === "default" && blk.blockType !== "callout") {
        delete nextProps.color;
      } else {
        nextProps.color = color;
      }
      handlePropsChange(blockId, nextProps);
    },
    [handlePropsChange, localBlocks]
  );

  const handleDuplicateBlock = useCallback(
    (blockId: string) => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const src = localBlocks[idx];
      const now = new Date().toISOString();
      const clonedProps: BlockProps = {
        ...src.props,
        ...(src.props.headers ? { headers: [...src.props.headers] } : {}),
        ...(src.props.rows
          ? { rows: src.props.rows.map((r) => [...r]) }
          : {}),
        ...(src.props.colAlignments
          ? { colAlignments: [...src.props.colAlignments] }
          : {}),
      };
      const duplicate: Block = {
        ...src,
        id: generateBlockId(),
        props: clonedProps,
        sortOrder: idx + 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextList = [
        ...localBlocks.slice(0, idx + 1),
        duplicate,
        ...localBlocks.slice(idx + 1),
      ];
      pendingFocusRef.current = { blockId: duplicate.id, placement: "end" };
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks]
  );

  const handleMoveBlock = useCallback(
    (blockId: string, delta: -1 | 1) => {
      const idx = localBlocks.findIndex((b) => b.id === blockId);
      const targetIdx = idx + delta;
      if (idx === -1 || targetIdx < 0 || targetIdx >= localBlocks.length) {
        return;
      }
      const nextList = [...localBlocks];
      const [moved] = nextList.splice(idx, 1);
      nextList.splice(targetIdx, 0, moved);
      pendingFocusRef.current = { blockId: moved.id, placement: "end" };
      commitBlocks(nextList);
    },
    [commitBlocks, localBlocks]
  );

  // Drag & Drop Reordering
  const handleDragStartBlock = useCallback(
    (blockId: string, e: React.DragEvent<HTMLElement>) => {
      setActionMenu(null);
      setActiveMenu(null);
      setDraggingBlockId(blockId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", blockId);
    },
    []
  );

  const handleDragOverBlock = useCallback(
    (targetBlockId: string, e: React.DragEvent<HTMLDivElement>) => {
      if (!draggingBlockId || draggingBlockId === targetBlockId) {
        if (dropTarget) setDropTarget(null);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position: "top" | "bottom" = e.clientY < midY ? "top" : "bottom";

      if (
        !dropTarget ||
        dropTarget.blockId !== targetBlockId ||
        dropTarget.position !== position
      ) {
        setDropTarget({ blockId: targetBlockId, position });
      }
    },
    [draggingBlockId, dropTarget]
  );

  const handleDropOnBlock = useCallback(
    (targetBlockId: string, e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const sourceId =
        draggingBlockId || e.dataTransfer.getData("text/plain");
      const currentDrop = dropTarget;

      setDraggingBlockId(null);
      setDropTarget(null);

      if (!sourceId || sourceId === targetBlockId) return;

      const fromIdx = localBlocks.findIndex((b) => b.id === sourceId);
      const targetIdx = localBlocks.findIndex((b) => b.id === targetBlockId);
      if (fromIdx === -1 || targetIdx === -1) return;

      const nextList = [...localBlocks];
      const [moved] = nextList.splice(fromIdx, 1);

      const newTargetIdx = nextList.findIndex((b) => b.id === targetBlockId);
      const insertAt =
        currentDrop?.position === "bottom" ? newTargetIdx + 1 : newTargetIdx;

      nextList.splice(insertAt, 0, moved);
      commitBlocks(nextList);
    },
    [commitBlocks, draggingBlockId, dropTarget, localBlocks]
  );

  const handleDragEndBlock = useCallback(() => {
    setDraggingBlockId(null);
    setDropTarget(null);
  }, []);

  // Smart Multi-line / Block Markdown Paste -> Splices rich Notion/Typora blocks at current block
  const handleSmartMarkdownPaste = useCallback(
    (blockId: string, markdown: string) => {
      const parsed = markdownToBlocks(pageId, markdown, pages);
      if (parsed.length === 0) return;

      const currentList = localBlocksRef.current;
      const idx = currentList.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      const currentBlk = currentList[idx];
      const replaceCurrent =
        currentBlk.blockType === "paragraph" &&
        isHtmlVisuallyEmpty(currentBlk.content);

      const nextList = replaceCurrent
        ? [
            ...currentList.slice(0, idx),
            ...parsed,
            ...currentList.slice(idx + 1),
          ]
        : [
            ...currentList.slice(0, idx + 1),
            ...parsed,
            ...currentList.slice(idx + 1),
          ];

      const lastPasted = parsed[parsed.length - 1];
      if (lastPasted.blockType === "divider") {
        const trailing = createNewBlock(
          pageId,
          "paragraph",
          nextList.length,
          ""
        );
        nextList.push(trailing);
        pendingFocusRef.current = { blockId: trailing.id, placement: "start" };
      } else {
        pendingFocusRef.current = { blockId: lastPasted.id, placement: "end" };
      }

      commitBlocks(nextList);
    },
    [commitBlocks, pageId, pages]
  );

  // Clipboard Screenshot / Local Image Paste -> Saves to `<activeDataDir>/assets/` (or Base64 fallback)
  const handlePasteImageFile = useCallback(
    async (blockId: string, file: File, replaceCurrentBlock: boolean) => {
      let dataUrl = "";
      try {
        dataUrl = await readFileAsDataUrl(file);
      } catch {
        return;
      }
      if (!dataUrl) return;

      const mimeType = file.type || "image/png";
      const ext =
        mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
      const fileName =
        file.name && !/^image\.(png|jpe?g|webp|gif)$/i.test(file.name)
          ? file.name
          : `paste-${Date.now()}.${ext}`;

      let resolvedUrl = dataUrl;
      // 磁盘笔记：图片存到笔记旁边的 assets/，Markdown 里写相对路径，换电脑或用其他编辑器也能看到
      let resolvedLocalSrc: string | undefined;
      if (pageId.startsWith("local:")) {
        try {
          const b64Payload = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
          const saved = await saveLocalNoteImage(pageId.slice("local:".length), fileName, b64Payload, mimeType);
          if (saved) {
            resolvedUrl = saved.displayUrl;
            resolvedLocalSrc = saved.relativePath;
          }
        } catch {
          // 写不进去（只读目录等）时退回内嵌图片
        }
      } else if (preferences?.imageSaveMode !== "base64") {
        try {
          const b64Payload = dataUrl.includes(",")
            ? dataUrl.split(",")[1]
            : dataUrl;
          const saved = await saveAssetImage(fileName, b64Payload, mimeType);
          if (saved && saved.assetUrl) {
            resolvedUrl = saved.assetUrl;
          }
        } catch {
          // Offline / browser fallback keeps dataUrl seamlessly
        }
      }

      const defaultCaption =
        file.name && !/^image\.(png|jpe?g|webp|gif)$/i.test(file.name)
          ? file.name.replace(/\.[^.]+$/, "")
          : "";

      const currentList = localBlocksRef.current;
      const idx = currentList.findIndex((b) => b.id === blockId);
      const now = new Date().toISOString();

      // Case 1: Updating an existing `image` block directly
      if (idx !== -1 && currentList[idx].blockType === "image") {
        const target = currentList[idx];
        const nextProps: BlockProps = {
          ...target.props,
          url: resolvedUrl,
          localSrc: resolvedLocalSrc,
          caption: target.props.caption || defaultCaption,
          imageWidth: target.props.imageWidth || "full",
        };
        const updatedImg: Block = {
          ...target,
          props: nextProps,
          plainText: computeBlockPlainText("image", target.content, nextProps),
          updatedAt: now,
        };
        const nextList = [...currentList];
        nextList[idx] = updatedImg;
        commitBlocks(nextList);
        return;
      }

      const imgBlock = createNewBlock(pageId, "image", 0, "", {
        url: resolvedUrl,
        ...(resolvedLocalSrc ? { localSrc: resolvedLocalSrc } : {}),
        caption: defaultCaption,
        imageWidth: "full",
      });

      // Case 2: Pasted into an empty block -> replace block (and ensure writable paragraph below if last)
      if (idx !== -1 && replaceCurrentBlock) {
        const nextList = [
          ...currentList.slice(0, idx),
          imgBlock,
          ...currentList.slice(idx + 1),
        ];
        if (idx === currentList.length - 1) {
          const afterPara = createNewBlock(
            pageId,
            "paragraph",
            nextList.length,
            ""
          );
          nextList.push(afterPara);
          pendingFocusRef.current = {
            blockId: afterPara.id,
            placement: "start",
          };
        }
        commitBlocks(nextList);
        return;
      }

      // Case 3: Insert new image block immediately after target block (or at end)
      const insertAfter = idx !== -1 ? idx + 1 : currentList.length;
      const nextList = [
        ...currentList.slice(0, insertAfter),
        imgBlock,
        ...currentList.slice(insertAfter),
      ];
      commitBlocks(nextList);
    },
    [commitBlocks, pageId, preferences?.imageSaveMode]
  );

  // Markdown Source / Split Live Preview handlers
  const handleSourceMarkdownChange = useCallback(
    (nextMd: string) => {
      // 源码框有自己的撤销；回到所见即所得后不再撤销到源码编辑之前
      clearBlockHistory(historyRef.current);
      setSourceText(nextMd);
      const parsed = reconcileBlockIds(
        localBlocksRef.current,
        markdownToBlocks(pageId, nextMd, pages)
      );
      const reindexed = parsed.map((blk, idx) =>
        blk.sortOrder === idx ? blk : { ...blk, sortOrder: idx }
      );
      lastEmittedRef.current = reindexed;
      setLocalBlocks(reindexed);
      onBlocksChange(reindexed);
      onRawMarkdownChange?.(nextMd, reindexed);
    },
    [onBlocksChange, onRawMarkdownChange, pageId, pages]
  );

  const handleToggleTodoInPreview = useCallback(
    (blockId: string) => {
      const now = new Date().toISOString();
      const updated = localBlocksRef.current.map((blk) => {
        if (blk.id !== blockId) return blk;
        const nextProps: BlockProps = {
          ...blk.props,
          checked: !blk.props.checked,
        };
        return {
          ...blk,
          props: nextProps,
          plainText: computeBlockPlainText(
            blk.blockType,
            blk.content,
            nextProps
          ),
          updatedAt: now,
        };
      });
      const reindexed = updated.map((blk, idx) =>
        blk.sortOrder === idx ? blk : { ...blk, sortOrder: idx }
      );
      const nextMd = blocksToMarkdown(reindexed, pages);
      setSourceText(nextMd);
      lastEmittedRef.current = reindexed;
      setLocalBlocks(reindexed);
      onBlocksChange(reindexed);
      onRawMarkdownChange?.(nextMd, reindexed);
    },
    [onBlocksChange, onRawMarkdownChange, pages]
  );

  // Active section heading tracking for Typora Outline TOC
  const activeHeadingId = useMemo<string | null>(() => {
    if (!focusedBlockId) {
      const firstHeading = localBlocks.find(
        (b) =>
          b.blockType === "heading1" ||
          b.blockType === "heading2" ||
          b.blockType === "heading3"
      );
      return firstHeading?.id ?? null;
    }
    const focusIdx = localBlocks.findIndex((b) => b.id === focusedBlockId);
    if (focusIdx === -1) return null;
    for (let i = focusIdx; i >= 0; i--) {
      const bt = localBlocks[i].blockType;
      if (bt === "heading1" || bt === "heading2" || bt === "heading3") {
        return localBlocks[i].id;
      }
    }
    return null;
  }, [focusedBlockId, localBlocks]);

  const handleSelectOutlineHeading = useCallback(
    (headingBlockId: string) => {
      setFocusedBlockId(headingBlockId);
      setPulsingBlockId(headingBlockId);
      window.setTimeout(() => {
        setPulsingBlockId((curr) =>
          curr === headingBlockId ? null : curr
        );
      }, 1800);

      const root = editorRootRef.current;
      if (!root) return;

      const escapedId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(headingBlockId)
          : headingBlockId;

      if (effectiveViewMode === "wysiwyg") {
        const rowEl = root.querySelector(
          `[data-block-id="${escapedId}"]`
        ) as HTMLElement | null;
        if (rowEl) {
          rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        const editable = focusTargetsRef.current.get(headingBlockId);
        if (editable) {
          if (editable.isContentEditable) {
            placeCaretAtEnd(editable);
          } else {
            editable.focus();
          }
        }
        return;
      }

      if (effectiveViewMode === "split") {
        const previewEl = root.querySelector(
          `[data-preview-block-id="${escapedId}"]`
        ) as HTMLElement | null;
        if (previewEl) {
          previewEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }

      // Source mode: locate heading text inside textarea and jump caret
      const headingBlk = localBlocksRef.current.find(
        (b) => b.id === headingBlockId
      );
      const ta = root.querySelector(
        ".nb-editor-source-textarea"
      ) as HTMLTextAreaElement | null;
      if (headingBlk && ta) {
        const prefix =
          headingBlk.blockType === "heading1"
            ? "# "
            : headingBlk.blockType === "heading2"
            ? "## "
            : "### ";
        const plainTitle = stripHtmlToText(headingBlk.content).trim();
        const needle = `${prefix}${plainTitle}`;
        const charIdx = ta.value.indexOf(needle);
        ta.focus();
        if (charIdx >= 0) {
          ta.setSelectionRange(
            charIdx + needle.length,
            charIdx + needle.length
          );
        }
      }
    },
    [effectiveViewMode]
  );

  // Configurable Editor Keybindings: Source Mode Toggle, 18 Turn-Into Shortcuts, Block Actions & Block Colors
  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;

    const kb = preferences?.keybindings;
    const combo = eventToCanonicalShortcut(e);
    if (!combo) return;

    if (matchesShortcutCombo(combo, "editor.toggleSource", kb)) {
      e.preventDefault();
      e.stopPropagation();
      const nextMode: EditorViewMode =
        effectiveViewMode === "wysiwyg" ? "source" : "wysiwyg";
      changeViewMode(nextMode);
      return;
    }

    if (effectiveViewMode !== "wysiwyg") return;

    if (
      e.target instanceof HTMLElement &&
      Boolean(e.target.closest(".nb-editor-inline-toolbar"))
    ) {
      return;
    }

    const domBlockId =
      e.target instanceof HTMLElement
        ? e.target.closest("[data-block-id]")?.getAttribute("data-block-id") ??
          null
        : null;
    const targetId =
      domBlockId ?? focusedBlockId ?? localBlocksRef.current[0]?.id ?? null;
    if (!targetId) return;

    // 1. All 18 `block.turnInto.<type>` shortcuts
    for (const bt of TURN_INTO_ACTION_BLOCK_TYPES) {
      if (matchesShortcutCombo(combo, `block.turnInto.${bt}`, kb)) {
        e.preventDefault();
        e.stopPropagation();
        setActiveMenu(null);
        setActionMenu(null);
        convertBlockTypeInternal(targetId, bt);
        return;
      }
    }

    // 2. Block Action Menu & Structural Actions
    if (matchesShortcutCombo(combo, "block.openMenu", kb)) {
      e.preventDefault();
      e.stopPropagation();
      openActionMenuForBlockId(targetId);
      return;
    }

    if (matchesShortcutCombo(combo, "block.duplicate", kb)) {
      e.preventDefault();
      e.stopPropagation();
      setActiveMenu(null);
      setActionMenu(null);
      handleDuplicateBlock(targetId);
      return;
    }

    if (matchesShortcutCombo(combo, "block.moveUp", kb)) {
      e.preventDefault();
      e.stopPropagation();
      setActiveMenu(null);
      setActionMenu(null);
      handleMoveBlock(targetId, -1);
      return;
    }

    if (matchesShortcutCombo(combo, "block.moveDown", kb)) {
      e.preventDefault();
      e.stopPropagation();
      setActiveMenu(null);
      setActionMenu(null);
      handleMoveBlock(targetId, 1);
      return;
    }

    if (matchesShortcutCombo(combo, "block.delete", kb)) {
      e.preventDefault();
      e.stopPropagation();
      setActiveMenu(null);
      setActionMenu(null);
      handleDeleteBlock(targetId);
      return;
    }

    if (matchesShortcutCombo(combo, "block.insertBelow", kb)) {
      e.preventDefault();
      e.stopPropagation();
      setActiveMenu(null);
      setActionMenu(null);
      handleInsertBlockBelow(targetId);
      return;
    }

    // 3. Block Color Swatch Shortcuts (`block.color.*`)
    for (const colorEntry of BLOCK_COLOR_ACTION_ENTRIES) {
      if (matchesShortcutCombo(combo, colorEntry.actionId, kb)) {
        e.preventDefault();
        e.stopPropagation();
        setActiveMenu(null);
        setActionMenu(null);
        handleChangeBlockColor(targetId, colorEntry.colorValue);
        return;
      }
    }
  };

  // Fallback root clipboard image paste when focus is on non-editable block (e.g. divider/image)
  const handleRootPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || effectiveViewMode !== "wysiwyg") return;
    const clipItems = e.clipboardData?.items
      ? Array.from(e.clipboardData.items)
      : [];
    const imageItem = clipItems.find(
      (it) => it.kind === "file" && it.type.startsWith("image/")
    );
    const imgFile = imageItem?.getAsFile();
    if (!imgFile) return;

    e.preventDefault();
    const anchorId =
      focusedBlockId ??
      localBlocksRef.current[localBlocksRef.current.length - 1]?.id ??
      "";
    handlePasteImageFile(anchorId, imgFile, false).catch(() => {});
  };

  // Click delegation for `.nb-wiki-link` bidirectional page navigation
  const handleEditorClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const wikiLink = target.closest(
      ".nb-wiki-link, a[data-page-id]"
    ) as HTMLElement | null;
    if (wikiLink) {
      e.preventDefault();
      e.stopPropagation();
      const targetPageId = wikiLink.getAttribute("data-page-id");
      if (targetPageId) {
        onNavigatePage(targetPageId);
      }
      return;
    }

    const inlineLink = target.closest(
      "a.nb-inline-link, .nb-editor-editable a[href]"
    ) as HTMLAnchorElement | null;
    if (inlineLink && !inlineLink.classList.contains("nb-wiki-link")) {
      const sel = window.getSelection();
      const isSelectingText = Boolean(
        sel && sel.rangeCount > 0 && !sel.isCollapsed
      );
      if (!isSelectingText || e.ctrlKey || e.metaKey) {
        const href = inlineLink.getAttribute("href") || "";
        if (href && href !== "#") {
          e.preventDefault();
          e.stopPropagation();
          activateInlineHref(href, openPathInExplorer);
          return;
        }
      }
    }
  };

  // Clicking empty whitespace below the last block focuses or appends trailing paragraph
  const handleBottomPadClick = () => {
    if (localBlocks.length === 0) {
      const fresh = createNewBlock(pageId, "paragraph", 0, "");
      pendingFocusRef.current = { blockId: fresh.id, placement: "start" };
      commitBlocks([fresh]);
      return;
    }

    const last = localBlocks[localBlocks.length - 1];
    if (
      last.blockType === "paragraph" &&
      isHtmlVisuallyEmpty(last.content)
    ) {
      const el = focusTargetsRef.current.get(last.id);
      if (el) {
        setFocusedBlockId(last.id);
        placeCaretAtEnd(el);
        return;
      }
    }

    const appended = createNewBlock(
      pageId,
      "paragraph",
      localBlocks.length,
      ""
    );
    pendingFocusRef.current = { blockId: appended.id, placement: "start" };
    commitBlocks([...localBlocks, appended]);
  };

  const actionMenuBlockIndex = actionMenu
    ? localBlocks.findIndex((b) => b.id === actionMenu.blockId)
    : -1;
  const actionMenuBlock =
    actionMenuBlockIndex >= 0 ? localBlocks[actionMenuBlockIndex] : null;

  const fontModeClass =
    fontStyle === "serif"
      ? "nb-editor-font-serif"
      : fontStyle === "mono"
      ? "nb-editor-font-mono"
      : fontStyle === "custom"
      ? "nb-editor-font-custom"
      : "nb-editor-font-sans";

  const activeFocusedId =
    focusedBlockId ??
    (preferences?.focusMode && localBlocks.length > 0
      ? localBlocks[0].id
      : null);

  const applyHistorySnapshot = useCallback(
    (target: Block[]) => {
      const current = localBlocksRef.current;
      const focusId = firstChangedBlockId(current, target);
      lastEmittedRef.current = target;
      setLocalBlocks(target);
      onBlocksChange(target);
      setActiveMenu(null);
      setActionMenu(null);
      if (focusId) pendingFocusRef.current = { blockId: focusId, placement: "end" };
    },
    [onBlocksChange]
  );

  // Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做。
  // 统一走编辑器自己的记录（不用浏览器逐字撤销），连续输入合并成一步。
  const handleHistoryKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing || e.altKey) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey && !e.shiftKey);
      if (!isUndo && !isRedo) return;
      // 单行输入框（链接地址、表格里的输入框等）保留原生撤销
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      e.stopPropagation();
      const h = historyRef.current;
      const current = localBlocksRef.current;
      const target = isUndo ? takeUndo(h, current) : takeRedo(h, current);
      if (target) applyHistorySnapshot(target);
    },
    [applyHistorySnapshot]
  );

  // 传给每一行的回调保持同一个引用：BlockRow 是 memo 组件，
  // 输入时只有被编辑的那一行重新渲染，长文档不再整页重算。
  const stableRow = {
    contentChange: useStableCallback(handleContentChange),
    propsChange: useStableCallback(handlePropsChange),
    markdownConvert: useStableCallback(handleMarkdownConvert),
    splitBlockOnEnter: useStableCallback(handleSplitBlockOnEnter),
    convertEmptyToParagraph: useStableCallback(handleConvertEmptyToParagraph),
    backspaceAtStart: useStableCallback(handleBackspaceAtStart),
    deleteBlock: useStableCallback(handleDeleteBlock),
    exitBlockBelow: useStableCallback(handleExitBlockBelow),
    focusAdjacentBlock: useStableCallback(handleFocusAdjacentBlock),
    gutterAddBelow: useStableCallback(handleGutterAddBelow),
    smartMarkdownPaste: useStableCallback(handleSmartMarkdownPaste),
    dragOverBlock: useStableCallback(handleDragOverBlock),
    dropOnBlock: useStableCallback(handleDropOnBlock),
    pasteImageFile: useStableCallback((id: string, file: File, replace: boolean) => {
      handlePasteImageFile(id, file, replace).catch(() => {});
    }),
  };

  return (
    <div
      ref={editorRootRef}
      data-view-mode={effectiveViewMode}
      className={[
        "nb-editor-root",
        fontModeClass,
        fullWidth || effectiveViewMode !== "wysiwyg" ? "is-full-width" : "",
        preferences?.focusMode ? "nb-focus-mode" : "",
        preferences?.typewriterMode ? "nb-typewriter-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={handleEditorClick}
      onKeyDown={handleRootKeyDown}
      onPaste={handleRootPaste}
    >
      <div
        className={`nb-editor-workspace-row ${
          preferences?.showOutline ? "has-outline" : ""
        }`}
      >
        <div className="nb-editor-main-col">
          {effectiveViewMode === "wysiwyg" ? (
            <>
              <div className="nb-editor-list nb-editor-canvas" onKeyDownCapture={handleHistoryKeyDownCapture}>
                {localBlocks.map((blk, idx) => (
                  <BlockRow
                    key={blk.id}
                    block={blk}
                    pages={pages}
                    isOnlyBlock={localBlocks.length === 1}
                    numberedIndex={numberedIndices[idx]}
                    isHighlighted={pulsingBlockId === blk.id}
                    isFocusedBlock={activeFocusedId === blk.id}
                    isActionMenuOpen={actionMenu?.blockId === blk.id}
                    isDragging={draggingBlockId === blk.id}
                    dropIndicator={
                      dropTarget?.blockId === blk.id
                        ? dropTarget.position
                        : null
                    }
                    preferences={preferences}
                    registerFocusTarget={registerFocusTarget}
                    onBlockFocus={setFocusedBlockId}
                    onContentChange={stableRow.contentChange}
                    onPropsChange={stableRow.propsChange}
                    onMarkdownConvert={stableRow.markdownConvert}
                    onSplitBlockOnEnter={stableRow.splitBlockOnEnter}
                    onConvertEmptyToParagraph={stableRow.convertEmptyToParagraph}
                    onBackspaceAtStart={stableRow.backspaceAtStart}
                    onDeleteBlock={stableRow.deleteBlock}
                    onExitBlockBelow={stableRow.exitBlockBelow}
                    onFocusAdjacentBlock={stableRow.focusAdjacentBlock}
                    onTriggerMenuChange={handleTriggerMenuChange}
                    onGutterAddBelow={stableRow.gutterAddBelow}
                    onOpenActionMenu={handleOpenActionMenu}
                    onSmartMarkdownPaste={stableRow.smartMarkdownPaste}
                    onPasteImageFile={stableRow.pasteImageFile}
                    onDragStartBlock={handleDragStartBlock}
                    onDragOverBlock={stableRow.dragOverBlock}
                    onDropOnBlock={stableRow.dropOnBlock}
                    onDragEndBlock={handleDragEndBlock}
                  />
                ))}
              </div>

              <div
                className="nb-editor-bottom-pad"
                aria-hidden="true"
                onClick={handleBottomPadClick}
              />
            </>
          ) : (
            <SourceEditor
              mode={effectiveViewMode}
              markdown={sourceText}
              previewBlocks={localBlocks}
              pages={pages}
              preferences={preferences}
              onChangeMarkdown={handleSourceMarkdownChange}
              onToggleTodoInPreview={handleToggleTodoInPreview}
              onNavigatePage={onNavigatePage}
              onToggleViewMode={changeViewMode}
            />
          )}
        </div>

        {preferences?.showOutline && (
          <OutlinePanel
            blocks={localBlocks}
            activeBlockId={activeHeadingId}
            onSelectHeading={handleSelectOutlineHeading}
          />
        )}
      </div>

      {effectiveViewMode === "wysiwyg" && (
        <>
          <SlashMenu
            open={activeMenu?.mode === "slash"}
            query={activeMenu?.mode === "slash" ? activeMenu.query : ""}
            anchorPoint={
              activeMenu?.anchor ?? { x: 120, y: 120, bottom: 144 }
            }
            canCreateSubpage={Boolean(onCreateSubpage)}
            keybindings={preferences?.keybindings}
            onSelect={(actionType) => {
              handleSelectSlashCommand(actionType).catch(() => {});
            }}
            onClose={() => setActiveMenu(null)}
          />

          <WikiLinkMenu
            open={activeMenu?.mode === "wikilink"}
            query={activeMenu?.mode === "wikilink" ? activeMenu.query : ""}
            currentPageId={pageId}
            pages={pages}
            anchorPoint={
              activeMenu?.anchor ?? { x: 120, y: 120, bottom: 144 }
            }
            canCreateSubpage={Boolean(onCreateSubpage)}
            onSelectPage={handleSelectWikiPage}
            onCreateAndLinkSubpage={
              onCreateSubpage
                ? (title) => {
                    handleCreateAndLinkSubpage(title).catch(() => {});
                  }
                : undefined
            }
            onClose={() => setActiveMenu(null)}
          />

          <BlockActionMenu
            open={Boolean(actionMenu && actionMenuBlock)}
            block={actionMenuBlock}
            blockIndex={actionMenuBlockIndex}
            totalBlocks={localBlocks.length}
            anchorRect={actionMenu?.anchorRect ?? { left: 100, top: 100 }}
            keybindings={preferences?.keybindings}
            onTurnInto={handleTurnIntoFromActionMenu}
            onChangeColor={handleChangeBlockColor}
            onInsertBelow={handleInsertBlockBelow}
            onDuplicate={handleDuplicateBlock}
            onMoveUp={(id) => handleMoveBlock(id, -1)}
            onMoveDown={(id) => handleMoveBlock(id, 1)}
            onDelete={handleDeleteBlock}
            onClose={() => setActionMenu(null)}
          />

          <InlineToolbar
            editorRootRef={editorRootRef}
            pageId={pageId}
            keybindings={preferences?.keybindings}
          />
        </>
      )}
    </div>
  );
};

export default BlockEditor;
