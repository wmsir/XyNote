/**
 * 把从网页、Word、飞书等复制来的 HTML 转成干净的 Markdown，再交给现有的
 * Markdown → 块 解析。只保留结构（标题、列表、待办、引用、代码、表格、图片、链接、
 * 粗体斜体删除线），去掉样式、脚本和各种包装 div。
 */

const BACKTICK = String.fromCharCode(96);

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "HR", "FIGURE", "FIGCAPTION", "DL", "DT", "DD",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "TITLE", "HEAD", "SVG", "BUTTON"]);

function escapeInline(text: string): string {
  // 只转义会被误当成 Markdown 语法的字符
  return text.replace(/([\\\x60*_[\]])/g, "\\$1");
}

function collapseWs(text: string): string {
  return text.replace(/[ \t\r\n ]+/g, " ");
}

function isBold(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") {
    // Google Docs 会用 <b style="font-weight:normal"> 包整段
    return !/font-weight\s*:\s*(normal|400)/i.test(el.getAttribute("style") || "");
  }
  const fw = /font-weight\s*:\s*(\d+|bold)/i.exec(el.getAttribute("style") || "");
  return !!fw && (fw[1] === "bold" || Number(fw[1]) >= 600);
}

function isItalic(el: HTMLElement): boolean {
  if (el.tagName === "I" || el.tagName === "EM") return true;
  return /font-style\s*:\s*italic/i.test(el.getAttribute("style") || "");
}

function isStrike(el: HTMLElement): boolean {
  if (el.tagName === "S" || el.tagName === "DEL" || el.tagName === "STRIKE") return true;
  return /text-decoration[^;]*line-through/i.test(el.getAttribute("style") || "");
}

function absoluteUrl(url: string, base: string | null): string {
  if (!url) return "";
  if (/^(https?:|data:|mailto:)/i.test(url)) return url;
  if (base) {
    try {
      return new URL(url, base).toString();
    } catch {
      /* ignore */
    }
  }
  return url;
}

/** 行内内容 → Markdown（不含换行结构） */
function inlineToMd(node: Node, base: string | null): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeInline(collapseWs(node.textContent || ""));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return "";
  if (tag === "BR") return "\n";
  if (tag === "IMG") {
    const src = absoluteUrl(el.getAttribute("src") || el.getAttribute("data-src") || "", base);
    if (!src) return "";
    const alt = (el.getAttribute("alt") || "").replace(/[[\]]/g, "");
    return `![${alt}](${src})`;
  }
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox") return input.checked ? "[x] " : "[ ] ";
    return "";
  }
  if (tag === "CODE" && el.parentElement?.tagName !== "PRE") {
    const t = el.textContent || "";
    if (!t) return "";
    const fence = t.includes(BACKTICK) ? BACKTICK + BACKTICK : BACKTICK;
    return fence + t + fence;
  }

  let inner = "";
  el.childNodes.forEach((c) => {
    inner += inlineToMd(c, base);
  });

  if (tag === "A") {
    const href = absoluteUrl(el.getAttribute("href") || "", base);
    const text = inner.trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return inner;
    if (!text) return "";
    if (text === href || text === escapeInline(href)) return href;
    return `[${text}](${href})`;
  }

  const trimmed = inner.trim();
  if (!trimmed) return inner;
  // 保留两侧空格，标记只包住文字
  const lead = inner.match(/^\s*/)?.[0] ?? "";
  const tail = inner.match(/\s*$/)?.[0] ?? "";
  let wrapped = trimmed;
  if (isStrike(el)) wrapped = `~~${wrapped}~~`;
  if (isItalic(el)) wrapped = `*${wrapped}*`;
  if (isBold(el)) wrapped = `**${wrapped}**`;
  if (tag === "MARK") wrapped = `==${wrapped}==`;
  return lead + wrapped + tail;
}

const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).map((t) => t.toLowerCase()).join(",");

/** 元素里面是否还有块级结构（Google Docs 会用 <b> 包住多个 <p>） */
function hasBlockChild(el: Element): boolean {
  return !!el.querySelector(BLOCK_SELECTOR);
}

function tableToMd(table: HTMLTableElement, base: string | null): string {
  const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
  if (rows.length === 0) return "";
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === "TD" || c.tagName === "TH")
      .map((c) =>
        inlineToMd(c, base)
          .replace(/\n+/g, " ")
          .replace(/\|/g, "\\|")
          .trim()
      )
  );
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return "";
  const norm = grid.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const head = norm[0];
  const body = norm.slice(1);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function listToMd(list: HTMLElement, depth: number, base: string | null): string[] {
  const ordered = list.tagName === "OL";
  let n = Number(list.getAttribute("start") || "1") || 1;
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") {
      if (li.tagName === "UL" || li.tagName === "OL") out.push(...listToMd(li as HTMLElement, depth + 1, base));
      continue;
    }
    let text = "";
    const nested: string[] = [];
    li.childNodes.forEach((c) => {
      if (c.nodeType === Node.ELEMENT_NODE && ((c as Element).tagName === "UL" || (c as Element).tagName === "OL")) {
        nested.push(...listToMd(c as HTMLElement, depth + 1, base));
      } else if (c.nodeType === Node.ELEMENT_NODE && ((c as Element).tagName === "P" || (c as Element).tagName === "DIV")) {
        text += " " + inlineToMd(c, base);
      } else {
        text += inlineToMd(c, base);
      }
    });
    text = text.replace(/\s*\n\s*/g, " ").trim();
    // 待办：<li><input type=checkbox> 或 data-checked / 「☐ ☑」
    let marker = ordered ? `${n}.` : "-";
    const checkbox = /^\[( |x)\]\s*/.exec(text);
    const checkedAttr = li.getAttribute("data-checked") ?? li.getAttribute("aria-checked");
    if (checkbox) {
      marker = `- [${checkbox[1]}]`;
      text = text.slice(checkbox[0].length);
    } else if (checkedAttr === "true" || checkedAttr === "false") {
      marker = `- [${checkedAttr === "true" ? "x" : " "}]`;
    } else if (/^[☐□]\s*/.test(text)) {
      marker = "- [ ]";
      text = text.replace(/^[☐□]\s*/, "");
    } else if (/^[☑☒✅]\s*/.test(text)) {
      marker = "- [x]";
      text = text.replace(/^[☑☒✅]\s*/, "");
    }
    out.push(`${indent}${marker} ${text}`.trimEnd());
    out.push(...nested);
    n += 1;
  }
  return out;
}

function blockToMd(el: Element, out: string[], base: string | null): void {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return;
  const push = (s: string) => {
    if (s.trim()) out.push(s.trimEnd());
  };
  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Math.min(3, Number(tag[1]));
      const text = inlineToMd(el, base).replace(/\n+/g, " ").trim().replace(/^\*\*(.*)\*\*$/, "$1");
      if (text) push(`${"#".repeat(level)} ${text}`);
      return;
    }
    case "UL":
    case "OL":
      push(listToMd(el as HTMLElement, 0, base).join("\n"));
      return;
    case "BLOCKQUOTE": {
      const inner: string[] = [];
      walk(el, inner, base);
      const text = inner.join("\n\n").trim();
      if (text) push(text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
      return;
    }
    case "PRE": {
      const code = el.querySelector("code");
      const langCls = (code?.className || el.className || "").match(/(?:language|lang)-([\w+#-]+)/);
      const body = (el.textContent || "").replace(/\n$/, "");
      const ticks = BACKTICK.repeat(3);
      const fence = body.includes(ticks) ? "~~~" : ticks;
      push(`${fence}${langCls ? langCls[1] : ""}\n${body}\n${fence}`);
      return;
    }
    case "TABLE":
      push(tableToMd(el as HTMLTableElement, base));
      return;
    case "HR":
      push("---");
      return;
    case "IMG":
      push(inlineToMd(el, base));
      return;
    default:
      break;
  }
  if (hasBlockChild(el)) {
    walk(el, out, base);
    return;
  }
  const text = inlineToMd(el, base)
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
  if (text) push(text);
}

function walk(root: Element, out: string[], base: string | null): void {
  let inlineBuf = "";
  const flush = () => {
    const t = inlineBuf
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .trim();
    if (t) out.push(t);
    inlineBuf = "";
  };
  root.childNodes.forEach((c) => {
    if (
      c.nodeType === Node.ELEMENT_NODE &&
      (BLOCK_TAGS.has((c as Element).tagName) || hasBlockChild(c as Element))
    ) {
      flush();
      blockToMd(c as Element, out, base);
    } else if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName === "IMG") {
      flush();
      blockToMd(c as Element, out, base);
    } else {
      inlineBuf += inlineToMd(c, base);
    }
  });
  flush();
}

/** 剪贴板 HTML → Markdown；没有可用内容时返回空字符串 */
export function htmlToMarkdown(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  // Windows 剪贴板 HTML 带 Version/SourceURL 头和 <!--StartFragment--> 标记
  const sourceUrl = /SourceURL:(\S+)/.exec(html)?.[1] ?? null;
  const start = html.indexOf("<!--StartFragment-->");
  const end = html.indexOf("<!--EndFragment-->");
  const fragment =
    start >= 0 && end > start ? html.slice(start + "<!--StartFragment-->".length, end) : html.replace(/SourceURL:\S+/g, "");
  const doc = new DOMParser().parseFromString(fragment, "text/html");
  const base = doc.querySelector("base")?.getAttribute("href") || sourceUrl;
  const out: string[] = [];
  walk(doc.body, out, base);
  return out
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 这段 HTML 是否值得按结构粘贴：有标题、列表、表格、引用、代码块、图片，或多个段落。
 * 来自代码编辑器（VS Code 等）的 HTML 只是带颜色的代码，按纯文本处理。
 */
export function isStructuredHtml(html: string): boolean {
  if (!html) return false;
  if (/vscode|monaco|JetBrains|white-space:\s*pre/i.test(html) && !/<(h[1-6]|li|table)\b/i.test(html)) {
    return false;
  }
  if (/<(h[1-6]|ul|ol|table|blockquote|pre|img|hr)\b/i.test(html)) return true;
  const paras = html.match(/<(p|div)\b/gi);
  return !!paras && paras.length >= 2;
}
