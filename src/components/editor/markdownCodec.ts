import katex from "katex";
import { iconAsText } from "../../icons/pageIcon";
import type {
  Block,
  BlockProps,
  DocumentStats,
  Page,
} from "../../types/notion";
import {
  computeBlockPlainText,
  createNewBlock,
  escapeHtml,
  looksLikeMermaidCode,
  normalizeCodeLanguage,
  normalizeInlineLinkHref,
  parseEmbedSource,
} from "./editorUtils";
import { sanitizeRichInlineHtml } from "./sanitizeHtml";

/* ============================================================================
 * Lossless Inline HTML <-> Markdown Conversion & Idempotent Residual Upgrader
 * ========================================================================== */

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/\u200B/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function cleanWikiLabelFallback(rawInnerHtml: string): string {
  const plain = decodeHtmlEntities(rawInnerHtml.replace(/<[^>]+>/g, "")).trim();
  // Strip leading emoji + space if present (e.g. "📄 Architecture" -> "Architecture")
  return plain.replace(/^[^\w\u4e00-\u9fff]+\s+/, "").trim() || plain;
}

function renderInlineMathSpan(rawLatex: string): string {
  const trimmed = rawLatex.trim();
  if (!trimmed) return `$${escapeHtml(rawLatex)}$`;
  let rendered = "";
  try {
    rendered = katex.renderToString(trimmed, {
      displayMode: false,
      throwOnError: false,
    });
  } catch {
    rendered = escapeHtml(trimmed);
  }
  return `<span class="nb-inline-math" contenteditable="false" data-latex="${escapeHtml(
    trimmed
  )}">${rendered}</span>`;
}

function buildInlineLinkHtml(labelHtml: string, rawHref: string): string {
  const href = normalizeInlineLinkHref(rawHref);
  if (!href) return labelHtml;
  const isHttp = /^https?:\/\//i.test(href);
  const isLocalFile = /^file:\/\//i.test(href);
  const extraAttrs = isHttp
    ? ' target="_blank" rel="noopener noreferrer"'
    : isLocalFile
    ? ' data-local-file="true" title="点击在资源管理器中显示本地文件"'
    : "";
  return `<a href="${escapeHtml(href)}"${extraAttrs} class="nb-inline-link">${labelHtml}</a>`;
}

/**
 * Balanced-parentheses Markdown link scanner `[label](href)`:
 * Supports `https?://`, `file:///`, `vscode://`, `mailto:`, `./`, `../`, `/`, `#`,
 * spaces inside `file://` URLs, angle-wrapped `(<file:///...>)`, and nested parentheses
 * in filenames such as `Controller(1).java#L62`, while ignoring `![img](...)` and `[[Wiki]]`.
 */
export function replaceBalancedMarkdownLinks(
  input: string,
  onLink: (label: string, rawHref: string) => string
): string {
  if (!input.includes("[") || !input.includes("](")) return input;

  let out = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    if (
      input[i] === "[" &&
      (i === 0 || input[i - 1] !== "!") &&
      input[i + 1] !== "["
    ) {
      let bracketDepth = 1;
      let j = i + 1;
      let closeBracket = -1;
      while (j < len) {
        const ch = input[j];
        if (ch === "\n" || ch === "\r") break;
        if (ch === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (ch === "[") bracketDepth += 1;
        else if (ch === "]") {
          bracketDepth -= 1;
          if (bracketDepth === 0) {
            closeBracket = j;
            break;
          }
        }
        j += 1;
      }

      if (
        closeBracket > i + 1 &&
        closeBracket + 1 < len &&
        input[closeBracket + 1] === "("
      ) {
        const hrefStart = closeBracket + 2;
        let closeParen = -1;

        if (input[hrefStart] === "<") {
          const closeAngle = input.indexOf(">)", hrefStart + 1);
          if (
            closeAngle !== -1 &&
            !input.slice(hrefStart, closeAngle).includes("\n")
          ) {
            closeParen = closeAngle + 1;
          }
        } else {
          let parenDepth = 1;
          let k = hrefStart;
          while (k < len) {
            const ch = input[k];
            if (ch === "\n" || ch === "\r") break;
            if (ch === "\\" && k + 1 < len) {
              k += 2;
              continue;
            }
            if (ch === "(") parenDepth += 1;
            else if (ch === ")") {
              parenDepth -= 1;
              if (parenDepth === 0) {
                closeParen = k;
                break;
              }
            }
            k += 1;
          }
        }

        if (closeParen > hrefStart) {
          const label = input.slice(i + 1, closeBracket);
          const rawHref = input.slice(hrefStart, closeParen).trim();
          if (rawHref.length > 0) {
            out += onLink(label, rawHref);
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    out += input[i];
    i += 1;
  }

  return out;
}

export function htmlToInlineMarkdown(html: string, pages: Page[]): string {
  if (!html) return "";
  let out = html.replace(/\u200B/g, "");

  // 0. Inline KaTeX spans -> `$latex$`
  out = out.replace(
    /<span\b[^>]*data-latex=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/gi,
    (_full, latex: string) => `$${decodeHtmlEntities(latex)}$`
  );

  // 1. Bidirectional [[Page Title]] wiki links
  out = out.replace(
    /<a\b[^>]*data-page-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_full, pageId: string, inner: string) => {
      const target = pages.find((p) => p.id === pageId);
      const title =
        target?.title?.trim() || cleanWikiLabelFallback(inner) || "无标题";
      return `[[${title}]]`;
    }
  );

  // 2. External & local `file:///` hyperlinks (preserve inner `<code>` if present!)
  out = out.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_full, href: string, inner: string) => {
      const innerMd = inner.replace(
        /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
        (_c, codeInner: string) =>
          `\`${decodeHtmlEntities(codeInner.replace(/<[^>]+>/g, ""))}\``
      );
      const label = decodeHtmlEntities(innerMd.replace(/<[^>]+>/g, "")).trim();
      return `[${label || decodeHtmlEntities(href)}](${decodeHtmlEntities(href)})`;
    }
  );

  // 3. Inline code
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_f, inner: string) => {
    const raw = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""));
    return `\`${raw}\``;
  });

  // 4. Highlight (<mark> <-> ==text==)
  out = out.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, " ==$1== ");
  out = out.replace(/ ==([\s\S]*?)== /g, "==$1==");

  // 5. Bold, Italic, Strikethrough
  out = out.replace(
    /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    "**$1**"
  );
  out = out.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");
  out = out.replace(
    /<(?:s|strike|del)\b[^>]*>([\s\S]*?)<\/(?:s|strike|del)>/gi,
    "~~$1~~"
  );

  // 6. Line breaks & strip remaining tags
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/(div|p)>/gi, "\n");
  out = out.replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(out).trim();
}

/**
 * Safari 13–16.3 / macOS 10.15–13.2 WKWebView safe replacement for
 * `/(?<!\*)\*([^*\n]+?)\*(?!\*)/g` (and the trimmed-inner variant):
 * Consuming runs of 2+ asterisks (`\*{2,}`) first avoids ES2018 lookbehind syntax,
 * which throws `SyntaxError` on WebKit < 16.4 (macOS 12 Monterey and older).
 */
function replaceSingleAsteriskItalic(
  input: string,
  trimInnerWhitespace = false
): string {
  const pattern = trimInnerWhitespace
    ? /(\*{2,})|\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g
    : /(\*{2,})|\*([^*\n]+?)\*(?!\*)/g;
  return input.replace(
    pattern,
    (full, multiStars: string | undefined, inner: string | undefined) => {
      if (multiStars !== undefined || inner === undefined) return full;
      return `<i>${inner}</i>`;
    }
  );
}

/**
 * Safari 13–16.3 / macOS 10.15–13.2 WKWebView safe replacement for
 * `/(?<!\$)\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\$)/g` without RegExp lookbehind.
 */
function replaceSingleDollarInlineMath(
  input: string,
  renderFn: (latex: string) => string
): string {
  return input.replace(
    /(\${2,})|\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\$)/g,
    (full, multiDollars: string | undefined, latex: string | undefined) => {
      if (multiDollars !== undefined || latex === undefined) return full;
      return renderFn(latex);
    }
  );
}

export function inlineMarkdownToHtml(text: string, pages: Page[]): string {
  if (!text) return "";

  const tokens: string[] = [];
  const stash = (htmlSnippet: string): string => {
    const idx = tokens.length;
    tokens.push(htmlSnippet);
    return `\u0000MDTOK${idx}\u0000`;
  };

  let working = text;

  // 1. Protect inline `code` first so special chars inside code are untouched
  working = working.replace(/`([^`\n]+)`/g, (_f, codeContent: string) =>
    stash(`<code>${escapeHtml(codeContent)}</code>`)
  );

  // 2. Protect [[Wiki Link]] references
  const activePages = pages.filter((p) => !p.isTrashed);
  working = working.replace(/\[\[([^\]\n]+)\]\]/g, (_f, rawRef: string) => {
    const cleanRef = rawRef.trim();
    const matchedPage = activePages.find(
      (p) => (p.title || "无标题").trim().toLowerCase() === cleanRef.toLowerCase()
    );
    if (matchedPage) {
      const icon = escapeHtml(
        iconAsText(matchedPage.icon, matchedPage.pageType === "database" ? "🗃️" : "📄")
      );
      const title = escapeHtml(matchedPage.title || "无标题");
      return stash(
        `<a href="#" data-page-id="${escapeHtml(
          matchedPage.id
        )}" class="nb-wiki-link">${icon} ${title}</a>`
      );
    }
    return stash(`[[${escapeHtml(cleanRef)}]]`);
  });

  // 3. Preserve explicit `<br>` / `<br/>` line breaks (common in GFM table cells!)
  working = working.replace(/<br\s*\/?>/gi, () => stash("<br>"));

  // 4. Protect universal `[label](url)` links (https://, file:///, vscode://, ./, #)
  working = replaceBalancedMarkdownLinks(
    working,
    (rawLabel: string, rawHref: string) => {
      let formattedLabel = escapeHtml(rawLabel);
      formattedLabel = formattedLabel.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
      formattedLabel = replaceSingleAsteriskItalic(formattedLabel, false);
      return stash(buildInlineLinkHtml(formattedLabel, rawHref));
    }
  );

  // 5. Protect inline `$formula$` KaTeX math
  working = replaceSingleDollarInlineMath(working, (latex) =>
    stash(renderInlineMathSpan(latex))
  );

  // 6. Escape HTML on remaining plain text
  working = escapeHtml(working);

  // 7. Apply ==highlight==, **bold**, *italic*, ~~strike~~
  working = working.replace(
    /==([^\n=]+?)==/g,
    '<mark class="nb-inline-highlight">$1</mark>'
  );
  working = working.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  working = replaceSingleAsteriskItalic(working, false);
  working = working.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  working = working.replace(/\r?\n/g, "<br>");

  // 8. Iteratively restore stashed HTML tokens (including nested code inside links)
  let safety = 0;
  while (/\u0000MDTOK\d+\u0000/.test(working) && safety < 5) {
    working = working.replace(/\u0000MDTOK(\d+)\u0000/g, (_f, idxStr: string) => {
      const idx = Number(idxStr);
      return tokens[idx] ?? "";
    });
    safety += 1;
  }

  return sanitizeRichInlineHtml(working);
}

/**
 * Idempotent Inline Markdown Upgrader for rich-text blocks & table cells:
 * Safely preserves already-rendered HTML (`<b>`, `<code>`, `<a>`, `<mark>`, `.nb-inline-math`)
 * while converting any residual unparsed Markdown syntax (`**bold**`, `` `code` ``,
 * `[label](file:///...)`, `==highlight==`, `~~strike~~`, `*italic*`, `$math$`, `[[Page]]`, `<br/>`).
 */
export function upgradeResidualInlineMarkdown(
  html: string,
  pages: Page[]
): string {
  if (!html) return "";

  // Fast O(1) exit when no Markdown trigger characters exist
  if (
    !html.includes("*") &&
    !html.includes("`") &&
    !html.includes("[") &&
    !html.includes("~") &&
    !html.includes("=") &&
    !html.includes("$") &&
    !html.includes("\n") &&
    !/&lt;br\s*\/?&gt;/i.test(html)
  ) {
    return html.includes("<") ? sanitizeRichInlineHtml(html) : html;
  }

  const tokens: string[] = [];
  const stash = (snippet: string): string => {
    const idx = tokens.length;
    tokens.push(snippet);
    return `\u0000UPGTOK${idx}\u0000`;
  };

  let working = html;

  // 1. Protect atomic existing HTML elements whose interiors must never be reparsed
  working = working.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (m) => stash(m));
  working = working.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => stash(m));
  working = working.replace(
    /<span\b[^>]*class=["'][^"']*nb-inline-math[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
    (m) => stash(m)
  );

  // 2. Convert escaped `&lt;br/&gt;` or `<br/>` into canonical `<br>`
  working = working.replace(/&lt;br\s*\/?&gt;/gi, () => stash("<br>"));
  working = working.replace(/<br\s*\/?>/gi, () => stash("<br>"));

  // 3. Protect all remaining HTML open/close tags (`<b>`, `</b>`, `<mark ...>`, etc.)
  working = working.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => stash(m));

  // 4. Upgrade residual inline `code`
  working = working.replace(/`([^`\n]+)`/g, (_f, rawCode: string) => {
    const clean = escapeHtml(decodeHtmlEntities(rawCode));
    return stash(`<code>${clean}</code>`);
  });

  // 5. Upgrade residual `[[Wiki Link]]`
  const activePages = pages.filter((p) => !p.isTrashed);
  working = working.replace(/\[\[([^\]\n]+)\]\]/g, (_f, rawRef: string) => {
    const cleanRef = decodeHtmlEntities(rawRef).trim();
    const matchedPage = activePages.find(
      (p) => (p.title || "无标题").trim().toLowerCase() === cleanRef.toLowerCase()
    );
    if (matchedPage) {
      const icon = escapeHtml(
        iconAsText(matchedPage.icon, matchedPage.pageType === "database" ? "🗃️" : "📄")
      );
      const title = escapeHtml(matchedPage.title || "无标题");
      return stash(
        `<a href="#" data-page-id="${escapeHtml(
          matchedPage.id
        )}" class="nb-wiki-link">${icon} ${title}</a>`
      );
    }
    return stash(`[[${escapeHtml(cleanRef)}]]`);
  });

  // 6. Upgrade residual `[label](url)` links (including `file:///...` & nested parens!)
  working = replaceBalancedMarkdownLinks(
    working,
    (rawLabel: string, rawHref: string) => {
      const decodedHref = decodeHtmlEntities(rawHref);
      let labelHtml = rawLabel;
      // Preserve any stashed `<code>` token inside `[`code`](url)` while escaping plain text
      if (!labelHtml.includes("\u0000UPGTOK")) {
        labelHtml = escapeHtml(decodeHtmlEntities(labelHtml));
      }
      labelHtml = labelHtml.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
      labelHtml = replaceSingleAsteriskItalic(labelHtml, false);
      return stash(buildInlineLinkHtml(labelHtml, decodedHref));
    }
  );

  // 7. Upgrade residual inline `$formula$` KaTeX math
  working = replaceSingleDollarInlineMath(working, (rawLatex) =>
    stash(renderInlineMathSpan(decodeHtmlEntities(rawLatex)))
  );

  // 8. Upgrade residual ==highlight==, **bold**, *italic*, ~~strike~~, and newlines
  working = working.replace(
    /==([^\n=]+?)==/g,
    '<mark class="nb-inline-highlight">$1</mark>'
  );
  working = working.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  working = replaceSingleAsteriskItalic(working, true);
  working = working.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  working = working.replace(/\r?\n/g, "<br>");

  // 9. Restore stashed HTML tokens iteratively
  let safety = 0;
  while (/\u0000UPGTOK\d+\u0000/.test(working) && safety < 5) {
    working = working.replace(
      /\u0000UPGTOK(\d+)\u0000/g,
      (_f, idxStr: string) => {
        const idx = Number(idxStr);
        return tokens[idx] ?? "";
      }
    );
    safety += 1;
  }

  return sanitizeRichInlineHtml(working);
}

/* ============================================================================
 * Blocks -> GFM / Typora Markdown Serializer (All 17 Block Types)
 * ========================================================================== */

function serializeTableCellToMarkdown(cellHtml: string, pages: Page[]): string {
  const md = htmlToInlineMarkdown(cellHtml, pages).replace(/\r?\n/g, "<br/>");
  // Escape bare `|` outside backtick code spans so GFM pipe columns stay aligned
  let out = "";
  let inBackticks = false;
  for (let i = 0; i < md.length; i++) {
    const ch = md[i];
    if (ch === "`") {
      inBackticks = !inBackticks;
      out += ch;
    } else if (ch === "|" && !inBackticks) {
      out += "\\|";
    } else {
      out += ch;
    }
  }
  return out.trim();
}

export function blocksToMarkdown(blocks: Block[], pages: Page[]): string {
  if (!blocks || blocks.length === 0) return "";

  const sorted = [...blocks].sort((a, b) => a.sortOrder - b.sortOrder);
  const chunks: string[] = [];
  let numberedCounter = 0;

  for (let i = 0; i < sorted.length; i++) {
    const blk = sorted[i];
    if (blk.blockType === "numbered") {
      numberedCounter += 1;
    } else {
      numberedCounter = 0;
    }

    const prevType = i > 0 ? sorted[i - 1].blockType : null;
    const isTightList =
      (blk.blockType === "bullet" && prevType === "bullet") ||
      (blk.blockType === "numbered" && prevType === "numbered") ||
      (blk.blockType === "todo" && prevType === "todo");

    let serialized = "";

    switch (blk.blockType) {
      case "heading1":
        serialized = `# ${htmlToInlineMarkdown(blk.content, pages)}`;
        break;
      case "heading2":
        serialized = `## ${htmlToInlineMarkdown(blk.content, pages)}`;
        break;
      case "heading3":
        serialized = `### ${htmlToInlineMarkdown(blk.content, pages)}`;
        break;
      case "paragraph":
        serialized = htmlToInlineMarkdown(blk.content, pages);
        break;
      case "bullet":
        serialized = `- ${htmlToInlineMarkdown(blk.content, pages)}`;
        break;
      case "numbered":
        serialized = `${numberedCounter}. ${htmlToInlineMarkdown(
          blk.content,
          pages
        )}`;
        break;
      case "todo": {
        const mark = blk.props.checked ? "x" : " ";
        serialized = `- [${mark}] ${htmlToInlineMarkdown(blk.content, pages)}`;
        break;
      }
      case "quote": {
        const quoteLines = htmlToInlineMarkdown(blk.content, pages).split("\n");
        serialized = quoteLines.map((l) => `> ${l}`).join("\n");
        break;
      }
      case "callout": {
        const icon = blk.props.calloutIcon || "💡";
        const body = htmlToInlineMarkdown(blk.content, pages).replace(
          /\n/g,
          "\n> "
        );
        serialized = `> [!NOTE] ${icon} ${body}`.trimEnd();
        break;
      }
      case "toggle": {
        const summary = htmlToInlineMarkdown(blk.content, pages) || "折叠标题";
        const detailsOpen = blk.props.collapsed ? "" : " open";
        const children = (blk.props.childrenText ?? "").trim();
        serialized = `<details${detailsOpen}>\n<summary>${summary}</summary>\n\n${children}\n</details>`;
        break;
      }
      case "mermaid": {
        serialized = `\`\`\`mermaid\n${blk.content}\n\`\`\``;
        break;
      }
      case "code": {
        const lang =
          blk.props.language && blk.props.language !== "plaintext"
            ? blk.props.language
            : "";
        serialized = `\`\`\`${lang}\n${blk.content}\n\`\`\``;
        break;
      }
      case "math": {
        serialized = `$$\n${blk.content}\n$$`;
        break;
      }
      case "divider":
        serialized = "---";
        break;
      case "table": {
        const headers =
          blk.props.headers && blk.props.headers.length > 0
            ? blk.props.headers
            : ["列 1", "列 2", "列 3"];
        const colCount = headers.length;
        const rows =
          blk.props.rows && blk.props.rows.length > 0
            ? blk.props.rows
            : [Array<string>(colCount).fill("")];
        const alignments = blk.props.colAlignments ?? [];

        const headerLine = `| ${headers
          .map((h) => serializeTableCellToMarkdown(h, pages))
          .join(" | ")} |`;
        const sepLine = `| ${headers
          .map((_, idx) => {
            const al = alignments[idx];
            if (al === "center") return ":---:";
            if (al === "right") return "---:";
            if (alignments.length > 0 && al === "left") return ":---";
            return "---";
          })
          .join(" | ")} |`;
        const rowLines = rows.map((r) => {
          const normalizedRow = Array.from(
            { length: colCount },
            (_, idx) => r[idx] ?? ""
          );
          return `| ${normalizedRow
            .map((c) => serializeTableCellToMarkdown(c, pages))
            .join(" | ")} |`;
        });
        serialized = [headerLine, sepLine, ...rowLines].join("\n");
        break;
      }
      case "image": {
        const url = blk.props.url || blk.content || "";
        const caption = blk.props.caption ?? "";
        serialized = `![${caption}](${url})`;
        break;
      }
      case "bookmark": {
        const url = blk.props.url || "";
        const title = blk.props.bookmarkTitle || url || "书签";
        serialized = `[🔖 ${title}](${url})`;
        break;
      }
      case "ref": {
        serialized = `[↪ 块引用](xynote://block/${blk.props.refPageId || ""}/${blk.props.refBlockId || ""})`;
        break;
      }
      case "file": {
        const name = (blk.props.fileName || "附件").replace(/[[\]]/g, "");
        const path = (blk.props.filePath || "").replace(/ /g, "%20");
        serialized = `[📎 ${name}](assets/${path})`;
        break;
      }
      case "embed": {
        const url = blk.props.url || "";
        const caption = blk.props.caption?.trim();
        serialized = caption
          ? `@[embed](${url} "${caption.replace(/"/g, "'")}")`
          : `@[embed](${url})`;
        break;
      }
    }

    if (chunks.length === 0) {
      chunks.push(serialized);
    } else if (isTightList) {
      chunks.push(`\n${serialized}`);
    } else {
      chunks.push(`\n\n${serialized}`);
    }
  }

  return chunks.join("");
}

/* ============================================================================
 * GFM / Typora Markdown -> Blocks Parser (All 18 Block Types incl. Mermaid)
 * ========================================================================== */

function splitPipeRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "";
  let inBackticks = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length && inner[i + 1] === "|") {
      buf += "|";
      i += 1;
    } else if (ch === "`") {
      inBackticks = !inBackticks;
      buf += ch;
    } else if (ch === "|" && !inBackticks) {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

function isPipeTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const cells = splitPipeRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function parsePipeAlignments(
  sepLine: string,
  colCount: number
): Array<"left" | "center" | "right"> {
  const cells = splitPipeRow(sepLine);
  return Array.from({ length: colCount }, (_, idx) => {
    const c = (cells[idx] ?? "").trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });
}

export function markdownToBlocks(
  pageId: string,
  markdown: string,
  pages: Page[]
): Block[] {
  const normalizedMd = markdown.replace(/\r\n/g, "\n");
  const lines = normalizedMd.split("\n");
  const result: Block[] = [];
  let sortOrder = 0;

  const pushBlock = (
    blockType: Block["blockType"],
    content: string,
    props?: BlockProps
  ) => {
    const blk = createNewBlock(pageId, blockType, sortOrder++, content, props);
    blk.plainText = computeBlockPlainText(blockType, blk.content, blk.props);
    result.push(blk);
  };

  // If the entire pasted snippet is a standalone unfenced Mermaid diagram (e.g. `flowchart TB\n  A --> B`)
  if (
    !normalizedMd.includes("```") &&
    !/\n#{1,6}\s+/.test(normalizedMd) &&
    normalizedMd.includes("\n") &&
    looksLikeMermaidCode(normalizedMd)
  ) {
    const singleMermaid = createNewBlock(
      pageId,
      "mermaid",
      0,
      normalizedMd.trim(),
      { mermaidView: "preview" }
    );
    singleMermaid.plainText = computeBlockPlainText(
      "mermaid",
      singleMermaid.content,
      singleMermaid.props
    );
    return [singleMermaid];
  }

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Skip blank separator lines
    if (trimmed === "") {
      i += 1;
      continue;
    }

    // 1. Fenced Code or Mermaid Diagram Block: ```lang ... ```
    const codeFence = /^```([a-zA-Z0-9_+#.-]*)\s*$/.exec(trimmed);
    if (codeFence) {
      const rawFenceLang = codeFence[1].trim();
      const lang = normalizeCodeLanguage(rawFenceLang || "plaintext");
      const bodyLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        bodyLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing ```
      const body = bodyLines.join("\n");
      if (
        lang === "mermaid" ||
        (!rawFenceLang && looksLikeMermaidCode(body))
      ) {
        pushBlock("mermaid", body, { mermaidView: "preview" });
      } else {
        pushBlock("code", body, { language: lang, wordWrap: true });
      }
      continue;
    }

    // 2. Display Math Block: single-line `$$...$$` or multi-line `$$\n...\n$$`
    if (trimmed === "$$") {
      const mathLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "$$") {
        mathLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      pushBlock("math", mathLines.join("\n").trim());
      continue;
    }
    const singleMath = /^\$\$(.+)\$\$$/.exec(trimmed);
    if (singleMath) {
      pushBlock("math", singleMath[1].trim());
      i += 1;
      continue;
    }

    // 3. HTML <details><summary>...</summary>...</details> Toggle Block
    if (/^<details(\s+open)?\s*>/i.test(trimmed)) {
      const isOpen = /^<details\s+open/i.test(trimmed);
      const detailLines: string[] = [rawLine];
      i += 1;
      while (i < lines.length && !/<\/details>/i.test(lines[i])) {
        detailLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        detailLines.push(lines[i]);
        i += 1;
      }
      const joined = detailLines.join("\n");
      const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(joined);
      const summaryMd = summaryMatch ? summaryMatch[1].trim() : "折叠标题";
      const bodyPart = joined
        .replace(/^[\s\S]*?<\/summary>/i, "")
        .replace(/<\/details>\s*$/i, "")
        .trim();
      pushBlock("toggle", inlineMarkdownToHtml(summaryMd, pages), {
        collapsed: !isOpen,
        childrenText: bodyPart,
      });
      continue;
    }

    // 4. GFM Pipe Table: consecutive `| ... |` lines -> Rich HTML WYSIWYG Table Cells!
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|") &&
        lines[i].trim().endsWith("|")
      ) {
        tableLines.push(lines[i].trim());
        i += 1;
      }

      if (tableLines.length >= 1) {
        const rawHeaders = splitPipeRow(tableLines[0]);
        const colCount = Math.max(1, rawHeaders.length);
        const hasSep =
          tableLines.length >= 2 && isPipeTableSeparator(tableLines[1]);
        const bodyStart = hasSep ? 2 : 1;
        const colAlignments = hasSep
          ? parsePipeAlignments(tableLines[1], colCount)
          : undefined;

        const headers = rawHeaders.map((h) => inlineMarkdownToHtml(h, pages));
        const parsedRows = tableLines.slice(bodyStart).map((rLine) => {
          const cells = splitPipeRow(rLine);
          return Array.from({ length: colCount }, (_, cIdx) =>
            inlineMarkdownToHtml(cells[cIdx] ?? "", pages)
          );
        });
        pushBlock("table", "", {
          headers,
          rows:
            parsedRows.length > 0
              ? parsedRows
              : [Array<string>(colCount).fill("")],
          ...(colAlignments ? { colAlignments } : {}),
        });
        continue;
      }
    }

    // 5. Horizontal Divider: --- / *** / ___
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      pushBlock("divider", "");
      i += 1;
      continue;
    }

    // 6. Headings (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const hType =
        level === 1 ? "heading1" : level === 2 ? "heading2" : "heading3";
      pushBlock(hType, inlineMarkdownToHtml(headingMatch[2], pages));
      i += 1;
      continue;
    }

    // 7. Callout (`> [!NOTE] 💡 ...`) or Blockquote (`> ...`)
    if (trimmed.startsWith(">")) {
      const quoteRawLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteRawLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const firstLine = quoteRawLines[0] ?? "";
      const calloutMatch =
        /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(firstLine);
      if (calloutMatch) {
        let restFirst = calloutMatch[1].trim();
        let icon = "💡";
        const leadingEmoji = /^([^\w\s\u4e00-\u9fff]{1,3})\s+(.*)$/.exec(
          restFirst
        );
        if (leadingEmoji) {
          icon = leadingEmoji[1];
          restFirst = leadingEmoji[2];
        }
        const fullCalloutMd = [restFirst, ...quoteRawLines.slice(1)]
          .filter((s, idx) => idx === 0 || s.length > 0)
          .join("\n");
        pushBlock("callout", inlineMarkdownToHtml(fullCalloutMd, pages), {
          calloutIcon: icon,
          color: "amber",
        });
      } else {
        pushBlock(
          "quote",
          inlineMarkdownToHtml(quoteRawLines.join("\n"), pages)
        );
      }
      continue;
    }

    // 8. Todo Checklist (`- [ ] ...` / `- [x] ...`)
    const todoMatch = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (todoMatch) {
      pushBlock("todo", inlineMarkdownToHtml(todoMatch[2], pages), {
        checked: todoMatch[1].toLowerCase() === "x",
      });
      i += 1;
      continue;
    }

    // 9. Bullet List (`- ...` / `* ...` / `+ ...`)
    const bulletMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bulletMatch) {
      pushBlock("bullet", inlineMarkdownToHtml(bulletMatch[1], pages));
      i += 1;
      continue;
    }

    // 10. Numbered List (`1. ...`)
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numberedMatch) {
      pushBlock("numbered", inlineMarkdownToHtml(numberedMatch[1], pages));
      i += 1;
      continue;
    }

    // 11. Standalone Image (`![caption](url)`)
    const imgMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
    if (imgMatch) {
      pushBlock("image", "", {
        caption: imgMatch[1].trim(),
        url: imgMatch[2].trim(),
        imageWidth: "full",
      });
      i += 1;
      continue;
    }

    // 12. Embed (`@[embed](url "caption")` or `[🎬 caption](url)`)
    const embedDirective =
      /^@\[embed\]\(([^\s")]+)(?:\s+"([^"]*)")?\)$/i.exec(trimmed);
    if (embedDirective) {
      const url = embedDirective[1].trim();
      const parsed = parseEmbedSource(url);
      pushBlock("embed", "", {
        url,
        caption: embedDirective[2] ?? "",
        embedProvider: parsed?.provider ?? "网页嵌入",
      });
      i += 1;
      continue;
    }
    const videoLinkEmbed = /^\[🎬\s*([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/.exec(
      trimmed
    );
    if (videoLinkEmbed) {
      const url = videoLinkEmbed[2].trim();
      const parsed = parseEmbedSource(url);
      pushBlock("embed", "", {
        url,
        caption: videoLinkEmbed[1].trim(),
        embedProvider: parsed?.provider ?? "网页嵌入",
      });
      i += 1;
      continue;
    }

    // 13. Bookmark (`[🔖 title](url)`)
    const bookmarkMatch = /^\[🔖\s*([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/.exec(
      trimmed
    );
    if (bookmarkMatch) {
      const url = bookmarkMatch[2].trim();
      let site = "";
      try {
        site = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // Ignore invalid URL
      }
      pushBlock("bookmark", "", {
        url,
        bookmarkTitle: bookmarkMatch[1].trim() || url,
        bookmarkSite: site,
      });
      i += 1;
      continue;
    }

    // 13a. 块引用 (`[↪ 块引用](xynote://block/页面/块)`)
    const refMatch = /^\[↪[^\]]*\]\(xynote:\/\/block\/([^/\s)]+)\/([^/\s)]+)\)$/.exec(trimmed);
    if (refMatch) {
      pushBlock("ref", "", { refPageId: refMatch[1], refBlockId: refMatch[2] });
      i += 1;
      continue;
    }

    // 13b. 附件 (`[📎 name](assets/attachments/x.pdf)`)
    const fileMatch = /^\[📎\s*([^\]]*)\]\((?:assets\/)?([^\s)]*)\)$/.exec(trimmed);
    if (fileMatch) {
      pushBlock("file", "", {
        fileName: fileMatch[1].trim() || "附件",
        filePath: (() => {
          try {
            return decodeURIComponent(fileMatch[2] || "");
          } catch {
            return fileMatch[2] || "";
          }
        })(),
      });
      i += 1;
      continue;
    }

    // 14. Default Paragraph
    pushBlock("paragraph", inlineMarkdownToHtml(trimmed, pages));
    i += 1;
  }

  if (result.length === 0) {
    pushBlock("paragraph", "");
  }

  return result;
}

/**
 * Determines whether pasted plain text contains multi-line or block-level Markdown
 * that should be parsed into rich Notion/Typora blocks rather than inserted as raw text.
 */
export function looksLikeStructuredMarkdown(plain: string): boolean {
  const normalized = plain.replace(/\r\n/g, "\n").trim();
  if (!normalized) return false;

  const lines = normalized.split("\n");
  const blockPattern =
    /^(?:#{1,6}\s+|```|\$\$|(?:-{3,}|\*{3,}|_{3,})$|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+\S+|\d+\.\s+\S+|>\s+|!\[[^\]]*\]\([^)]+\)$|@\[embed\]\(|<details|\|.+\|$)/;

  if (lines.length === 1) {
    return /^(?:#{1,6}\s+|!\[[^\]]*\]\([^)]+\)$|@\[embed\]\(|\|.+\|$|\$\$.+\$\$$)/.test(
      normalized
    );
  }

  if (looksLikeMermaidCode(normalized)) {
    return true;
  }

  return (
    normalized.includes("\n\n") ||
    lines.some((l) => blockPattern.test(l.trim()))
  );
}

/**
 * Computes live commercial Typora-style DocumentStats (CJK + English words, chars, lines, reading time).
 */
export function computeDocumentStats(
  blocks: Block[],
  rawMarkdown?: string | null
): DocumentStats {
  const fullText = blocks
    .map((b) => computeBlockPlainText(b.blockType, b.content, b.props))
    .filter((s) => s.length > 0)
    .join("\n");

  const cjkMatches = fullText.match(
    /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g
  );
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  const nonCjkText = fullText.replace(
    /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g,
    " "
  );
  const wordMatches = nonCjkText.match(
    /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g
  );
  const latinWordCount = wordMatches ? wordMatches.length : 0;

  const words = cjkCount + latinWordCount;
  const chars = fullText.replace(/\r?\n/g, "").length;
  const lines =
    rawMarkdown != null && rawMarkdown.length > 0
      ? rawMarkdown.replace(/\r\n/g, "\n").split("\n").length
      : Math.max(
          1,
          blocks.reduce((sum, blk) => {
            const plain = computeBlockPlainText(
              blk.blockType,
              blk.content,
              blk.props
            );
            return sum + (plain ? plain.split(/\r?\n/).length : 1);
          }, 0)
        );

  const readingMinutes = words === 0 ? 1 : Math.max(1, Math.ceil(words / 300));

  return {
    words,
    chars,
    lines,
    readingMinutes,
    blockCount: blocks.length,
  };
}
