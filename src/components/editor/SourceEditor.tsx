import { LineNumberGutter } from "./LineNumberGutter";
import React, { useLayoutEffect, useMemo, useRef } from "react";
import katex from "katex";
import {
  Check,
  Code2,
  Eye,
  ExternalLink,
  Film,
  Globe,
} from "lucide-react";
import { openPathInExplorer } from "../../api/client";
import { openExternalUrl } from "../../api/sync";
import type {
  Block,
  EditorPreferences,
  EditorViewMode,
  Page,
} from "../../types/notion";
import {
  activateInlineHref,
  escapeHtml,
  looksLikeMermaidCode,
  normalizeExternalUrl,
  parseEmbedSource,
} from "./editorUtils";
import {
  eventToCanonicalShortcut,
  matchesShortcutCombo,
  resolveActionShortcut,
} from "./editorKeybindings";
import { upgradeResidualInlineMarkdown } from "./markdownCodec";
import { MermaidBlock } from "./MermaidBlock";
import { sanitizeRichInlineHtml } from "./sanitizeHtml";

export interface SourceEditorProps {
  mode: Extract<EditorViewMode, "source" | "split">;
  markdown: string;
  previewBlocks: Block[];
  pages?: Page[];
  preferences?: EditorPreferences;
  onChangeMarkdown: (nextMarkdown: string) => void;
  onToggleTodoInPreview?: (blockId: string) => void;
  onNavigatePage: (pageId: string) => void;
  onToggleViewMode?: (nextMode: EditorViewMode) => void;
}

function renderLivePreviewBlock(
  blk: Block,
  numberedIdx: number,
  pages: Page[],
  onToggleTodo?: (blockId: string) => void
): React.ReactNode {
  switch (blk.blockType) {
    case "heading1":
      return (
        <h1
          key={blk.id}
          data-preview-block-id={blk.id}
          className="nb-editor-preview-h1 nb-editor-h1"
          dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
        />
      );
    case "heading2":
      return (
        <h2
          key={blk.id}
          data-preview-block-id={blk.id}
          className="nb-editor-preview-h2 nb-editor-h2"
          dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
        />
      );
    case "heading3":
      return (
        <h3
          key={blk.id}
          data-preview-block-id={blk.id}
          className="nb-editor-preview-h3 nb-editor-h3"
          dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
        />
      );
    case "paragraph":
      return (
        <p
          key={blk.id}
          data-preview-block-id={blk.id}
          className="nb-editor-preview-p"
          dangerouslySetInnerHTML={{
            __html: sanitizeRichInlineHtml(blk.content) || "&nbsp;",
          }}
        />
      );
    case "bullet":
      return (
        <div key={blk.id} className="nb-editor-list-wrap nb-editor-preview-row">
          <span className="nb-editor-bullet-marker">•</span>
          <div
            className="nb-editor-preview-inline"
            dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
          />
        </div>
      );
    case "numbered":
      return (
        <div key={blk.id} className="nb-editor-list-wrap nb-editor-preview-row">
          <span className="nb-editor-number-marker">{numberedIdx}.</span>
          <div
            className="nb-editor-preview-inline"
            dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
          />
        </div>
      );
    case "todo": {
      const checked = Boolean(blk.props.checked);
      return (
        <div
          key={blk.id}
          className={`nb-editor-todo-wrap nb-editor-preview-row ${
            checked ? "is-checked" : ""
          }`}
        >
          <button
            type="button"
            className={`nb-editor-checkbox ${checked ? "is-checked" : ""}`}
            onClick={() => onToggleTodo?.(blk.id)}
          >
            {checked && <Check size={11} strokeWidth={3} />}
          </button>
          <div
            className={`nb-editor-preview-inline ${
              checked ? "is-checked-text" : ""
            }`}
            dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
          />
        </div>
      );
    }
    case "quote":
      return (
        <blockquote
          key={blk.id}
          className="nb-editor-quote-wrap nb-editor-preview-quote"
          dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
        />
      );
    case "callout":
      return (
        <div
          key={blk.id}
          className="nb-editor-callout-wrap"
          data-callout-color={blk.props.color || "amber"}
        >
          <span className="nb-editor-callout-icon-btn">
            {blk.props.calloutIcon || "💡"}
          </span>
          <div
            className="nb-editor-preview-inline"
            dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(blk.content) }}
          />
        </div>
      );
    case "toggle":
      return (
        <details
          key={blk.id}
          open={!blk.props.collapsed}
          className="nb-editor-preview-details"
        >
          <summary
            dangerouslySetInnerHTML={{
              __html: sanitizeRichInlineHtml(blk.content) || "折叠标题",
            }}
          />
          {blk.props.childrenText && (
            <div className="nb-editor-preview-details-body">
              {blk.props.childrenText}
            </div>
          )}
        </details>
      );
    case "mermaid":
      return (
        <MermaidBlock
          key={blk.id}
          blockId={blk.id}
          code={blk.content}
          readOnly
        />
      );
    case "code": {
      const isMermaid =
        blk.props.language?.trim().toLowerCase() === "mermaid" ||
        looksLikeMermaidCode(blk.content);
      if (isMermaid) {
        return (
          <MermaidBlock
            key={blk.id}
            blockId={blk.id}
            code={blk.content}
            readOnly
          />
        );
      }
      const wrapCode = blk.props.wordWrap ?? true;
      return (
        <div key={blk.id} className="nb-editor-code-wrap">
          <div className="nb-editor-code-topbar">
            <span className="nb-editor-code-lang">
              {blk.props.language || "code"}
            </span>
          </div>
          <pre
            className="nb-editor-preview-pre"
            style={{
              whiteSpace: wrapCode ? "pre-wrap" : "pre",
              wordBreak: wrapCode ? "break-word" : "normal",
            }}
          >
            <code>{blk.content}</code>
          </pre>
        </div>
      );
    }
    case "math": {
      let mathHtml = "";
      try {
        mathHtml = katex.renderToString(blk.content.trim() || "\\;", {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        mathHtml = escapeHtml(blk.content);
      }
      return (
        <div key={blk.id} className="nb-editor-math-wrap">
          <div className="nb-editor-math-display">
            <div
              className="nb-editor-math-katex"
              dangerouslySetInnerHTML={{ __html: mathHtml }}
            />
          </div>
        </div>
      );
    }
    case "divider":
      return (
        <div key={blk.id} className="nb-editor-divider-wrap">
          <hr className="nb-editor-divider-line" />
        </div>
      );
    case "table": {
      const headers = blk.props.headers ?? ["列 1", "列 2"];
      const rows = blk.props.rows ?? [];
      const colAlignments = blk.props.colAlignments ?? [];
      return (
        <div key={blk.id} className="nb-editor-table-outer">
          <div className="nb-editor-table-scroll" style={{ maxWidth: "100%" }}>
            <table className="nb-editor-table">
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <th
                      key={i}
                      className="nb-editor-preview-cell"
                      style={{ textAlign: colAlignments[i] || "left" }}
                      dangerouslySetInnerHTML={{
                        __html: sanitizeRichInlineHtml(
                          upgradeResidualInlineMarkdown(h || "", pages)
                        ),
                      }}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    {headers.map((_, ci) => (
                      <td
                        key={ci}
                        className="nb-editor-preview-cell"
                        style={{ textAlign: colAlignments[ci] || "left" }}
                        dangerouslySetInnerHTML={{
                          __html: sanitizeRichInlineHtml(
                            upgradeResidualInlineMarkdown(r[ci] ?? "", pages)
                          ),
                        }}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case "image": {
      const url = blk.props.url || blk.content;
      if (!url) return null;
      return (
        <figure
          key={blk.id}
          className="nb-editor-image-figure"
          data-image-width={blk.props.imageWidth || "full"}
        >
          <div className="nb-editor-image-stage">
            <img
              src={url}
              alt={blk.props.caption || ""}
              className="nb-editor-image-el"
            />
          </div>
          {blk.props.caption && (
            <figcaption className="nb-editor-preview-caption">
              {blk.props.caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case "bookmark": {
      const url = blk.props.url || "";
      if (!url) return null;
      const safeUrl = normalizeExternalUrl(url);
      return (
        <div
          key={blk.id}
          className="nb-editor-bookmark-card"
          onClick={() => {
            if (safeUrl && /^https?:\/\//i.test(safeUrl)) {
              openExternalUrl(safeUrl).catch(() =>
                window.open(safeUrl, "_blank", "noopener,noreferrer")
              );
            }
          }}
        >
          <div className="nb-editor-bookmark-body">
            <div className="nb-editor-bookmark-title">
              {blk.props.bookmarkTitle || url}
            </div>
            {blk.props.bookmarkDesc && (
              <div className="nb-editor-bookmark-desc">
                {blk.props.bookmarkDesc}
              </div>
            )}
            <div className="nb-editor-bookmark-meta">
              <Globe size={13} className="nb-editor-bookmark-globe" />
              <span className="nb-editor-bookmark-url">{url}</span>
            </div>
          </div>
          <ExternalLink size={14} />
        </div>
      );
    }
    case "embed": {
      const parsed = parseEmbedSource(blk.props.url || "");
      if (!parsed) return null;
      return (
        <div key={blk.id} className="nb-editor-embed-wrap">
          <div className="nb-editor-embed-card">
            <div className="nb-editor-embed-topbar">
              <span className="nb-editor-embed-badge">
                <Film size={12} />
                <span>{blk.props.embedProvider || parsed.provider}</span>
              </span>
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
                  title={parsed.provider}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
                  className="nb-editor-embed-iframe"
                />
              )}
            </div>
          </div>
        </div>
      );
    }
  }
}

export const SourceEditor: React.FC<SourceEditorProps> = ({
  mode,
  markdown,
  previewBlocks,
  pages = [],
  preferences,
  onChangeMarkdown,
  onToggleTodoInPreview,
  onNavigatePage,
  onToggleViewMode,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const showLineNumbers = preferences?.codeLineNumbers !== false;
  const wordWrap = preferences?.codeWordWrap !== false;
  const tabSize = Math.max(2, Math.min(8, preferences?.tabSize ?? 2));
  const spellCheck = preferences?.spellcheck ?? false;


  // Auto-grow source textarea cleanly in single-pane `source` mode
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (mode === "source") {
      ta.style.height = "auto";
      ta.style.height = `${Math.max(460, ta.scrollHeight + 16)}px`;
    } else {
      ta.style.height = "100%";
    }
  }, [markdown, mode, wordWrap]);

  const wrapSelectionWith = (prefix: string, suffix: string, fallback = "") => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);

    // Toggle off if already wrapped right around selection
    if (
      start >= prefix.length &&
      ta.value.slice(start - prefix.length, start) === prefix &&
      ta.value.slice(end, end + suffix.length) === suffix
    ) {
      const unwrapped =
        ta.value.slice(0, start - prefix.length) +
        selected +
        ta.value.slice(end + suffix.length);
      onChangeMarkdown(unwrapped);
      window.requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start - prefix.length, end - prefix.length);
      });
      return;
    }

    const inner = selected || fallback;
    const nextVal =
      ta.value.slice(0, start) + prefix + inner + suffix + ta.value.slice(end);
    onChangeMarkdown(nextVal);
    window.requestAnimationFrame(() => {
      ta.focus();
      const selStart = start + prefix.length;
      const selEnd = selStart + inner.length;
      ta.setSelectionRange(selStart, selEnd);
    });
  };

  const handleSourceKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const kb = preferences?.keybindings;
    const combo = eventToCanonicalShortcut(e);

    if (matchesShortcutCombo(combo, "editor.toggleSource", kb)) {
      e.preventDefault();
      e.stopPropagation();
      onToggleViewMode?.("wysiwyg");
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const spaces = " ".repeat(tabSize);
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      if (start === end && !e.shiftKey) {
        const nextVal = ta.value.slice(0, start) + spaces + ta.value.slice(end);
        onChangeMarkdown(nextVal);
        window.requestAnimationFrame(() => {
          ta.setSelectionRange(start + spaces.length, start + spaces.length);
        });
        return;
      }

      // Multi-line or Shift+Tab indent/outdent
      const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
      const blockSlice = ta.value.slice(lineStart, end);
      const lines = blockSlice.split("\n");
      const transformed = lines.map((line) => {
        if (e.shiftKey) {
          if (line.startsWith(spaces)) return line.slice(spaces.length);
          return line.replace(/^[ \t]{1,2}/, "");
        }
        return spaces + line;
      });
      const joined = transformed.join("\n");
      const nextVal =
        ta.value.slice(0, lineStart) + joined + ta.value.slice(end);
      onChangeMarkdown(nextVal);
      window.requestAnimationFrame(() => {
        ta.setSelectionRange(lineStart, lineStart + joined.length);
      });
      return;
    }

    if (matchesShortcutCombo(combo, "format.bold", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("**", "**", "加粗文字");
      return;
    }
    if (matchesShortcutCombo(combo, "format.italic", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("*", "*", "斜体文字");
      return;
    }
    if (matchesShortcutCombo(combo, "format.underline", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("<u>", "</u>", "下划线文字");
      return;
    }
    if (matchesShortcutCombo(combo, "format.strike", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("~~", "~~", "删除线文字");
      return;
    }
    if (matchesShortcutCombo(combo, "format.code", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("`", "`", "code");
      return;
    }
    if (matchesShortcutCombo(combo, "format.highlight", kb)) {
      e.preventDefault();
      e.stopPropagation();
      wrapSelectionWith("==", "==", "高亮文字");
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (
      mod &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "k" &&
      ta.selectionStart !== ta.selectionEnd
    ) {
      // Selection link wrapper `[label](https://)` when text is selected inside SourceEditor
      e.preventDefault();
      e.stopPropagation();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const label = ta.value.slice(start, end);
      const urlPlaceholder = "https://";
      const inserted = `[${label}](${urlPlaceholder})`;
      const nextVal =
        ta.value.slice(0, start) + inserted + ta.value.slice(end);
      onChangeMarkdown(nextVal);
      window.requestAnimationFrame(() => {
        ta.focus();
        const urlStart = start + label.length + 3;
        ta.setSelectionRange(urlStart, urlStart + urlPlaceholder.length);
      });
    }
  };

  // Compute consecutive numbered list index for Split Preview
  const previewNumberedIndices = useMemo(() => {
    let c = 0;
    return previewBlocks.map((b) => {
      if (b.blockType === "numbered") {
        c += 1;
        return c;
      }
      c = 0;
      return 0;
    });
  }, [previewBlocks]);

  const sourceHintParts = useMemo(() => {
    const kb = preferences?.keybindings;
    const parts: string[] = [];
    const toggleKey = resolveActionShortcut("editor.toggleSource", kb);
    const boldKey = resolveActionShortcut("format.bold", kb);
    const italicKey = resolveActionShortcut("format.italic", kb);
    const strikeKey = resolveActionShortcut("format.strike", kb);
    const codeKey = resolveActionShortcut("format.code", kb);
    if (toggleKey) parts.push(`${toggleKey} 切换所见即所得`);
    if (boldKey) parts.push(`${boldKey} 加粗`);
    if (italicKey) parts.push(`${italicKey} 斜体`);
    if (strikeKey) parts.push(`${strikeKey} 删除线`);
    if (codeKey) parts.push(`${codeKey} 代码`);
    return parts.join(" · ");
  }, [preferences?.keybindings]);

  const renderSourcePane = () => (
    <div className="nb-editor-source-pane">
      <div className="nb-editor-source-topbar">
        <span className="nb-editor-source-badge">
          <Code2 size={13} />
          <span>Markdown 源代码模式</span>
        </span>
        {sourceHintParts && (
          <span className="nb-editor-source-hint">{sourceHintParts}</span>
        )}
      </div>

      <div className="nb-editor-source-body">
        <textarea
          ref={textareaRef}
          className={`nb-editor-source-textarea ${
            wordWrap ? "is-wrapped" : "is-nowrap"
          }`}
          spellCheck={spellCheck}
          style={{ tabSize }}
          placeholder="# 输入 Markdown 源码（支持标题、GFM 富文本表格、Mermaid 图表、$$ 数学公式、代码块与 [[双链]]）…"
          value={markdown}
          onChange={(e) => onChangeMarkdown(e.target.value)}
          onKeyDown={handleSourceKeyDown}
          onScroll={(e) => {
            if (gutterRef.current) {
              gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            }
          }}
        />
        {showLineNumbers && (
          <LineNumberGutter
            gutterRef={gutterRef}
            textareaRef={textareaRef}
            text={markdown}
            wrap={wordWrap}
            className="nb-editor-source-gutter"
            lineClassName="nb-editor-source-line-num"
          />
        )}
      </div>
    </div>
  );

  if (mode === "source") {
    return <div className="nb-editor-source-only">{renderSourcePane()}</div>;
  }

  return (
    <div className="nb-editor-split-layout">
      {renderSourcePane()}

      <div
        className="nb-editor-preview-pane"
        onClick={(e) => {
          const target = e.target as HTMLElement | null;
          const wiki = target?.closest(
            ".nb-wiki-link, a[data-page-id]"
          ) as HTMLElement | null;
          if (wiki) {
            e.preventDefault();
            const pid = wiki.getAttribute("data-page-id");
            if (pid) onNavigatePage(pid);
            return;
          }
          const inlineLink = target?.closest(
            "a.nb-inline-link, a[href]"
          ) as HTMLAnchorElement | null;
          if (inlineLink) {
            const href = inlineLink.getAttribute("href") || "";
            if (href && href !== "#") {
              e.preventDefault();
              activateInlineHref(href, openPathInExplorer);
            }
          }
        }}
      >
        <div className="nb-editor-source-topbar">
          <span className="nb-editor-source-badge">
            <Eye size={13} />
            <span>实时渲染预览 (Live Preview)</span>
          </span>
          <span className="nb-editor-source-hint">
            同步渲染全部 18 种块、Mermaid 图表与公式
          </span>
        </div>

        <div className="nb-editor-preview-scroll nb-editor-canvas">
          {previewBlocks.map((blk, i) =>
            renderLivePreviewBlock(
              blk,
              previewNumberedIndices[i],
              pages,
              onToggleTodoInPreview
            )
          )}
        </div>
      </div>
    </div>
  );
};
