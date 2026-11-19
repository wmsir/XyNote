/**
 * 编辑器富文本与链接白名单清洗工具（兼容 Safari 13.1+ / macOS 12 WKWebView，不使用正则 lookbehind）
 */

const ALLOWED_INLINE_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "strike",
  "mark",
  "code",
  "br",
  "sub",
  "sup",
  "kbd",
  "span",
  "div",
  "p",
  "a",
  "font",
  // KaTeX MathML / SVG 安全子集
  "math",
  "semantics",
  "mrow",
  "mi",
  "mo",
  "mn",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mtable",
  "mtr",
  "mtd",
  "mtext",
  "mspace",
  "mpadded",
  "mphantom",
  "menclose",
  "mover",
  "munder",
  "munderover",
  "mstyle",
  "merror",
  "annotation",
  "svg",
  "path",
  "line",
  "rect",
  "g",
]);

/** 连同子树整棵移除的危险或交互标签 */
const BLOCKED_SUBTREE_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "template",
  "noscript",
  "title",
  "textarea",
  "select",
  "option",
  "foreignobject",
  "animate",
  "set",
  "use",
  "feimage",
  "img",
  "audio",
  "video",
  "source",
  "track",
  "input",
  "button",
  "link",
  "meta",
  "base",
  "frame",
  "frameset",
]);

const ALLOWED_LINK_ATTRS = new Set([
  "href",
  "class",
  "target",
  "rel",
  "title",
  "data-page-id",
  "data-local-file",
  "data-md-rel-href",
]);

const ALLOWED_GENERAL_ATTRS = new Set([
  "class",
  "style",
  "contenteditable",
  "data-latex",
  "aria-hidden",
  "role",
  "xmlns",
  "encoding",
  "mathcolor",
  "mathbackground",
  "viewbox",
  "width",
  "height",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "rx",
  "ry",
  "fill",
  "stroke",
  "stroke-width",
  "transform",
  "preserveaspectratio",
  "focusable",
  "color",
  "dir",
]);

const BLOCKED_ATTRS = new Set([
  "src",
  "srcset",
  "srcdoc",
  "action",
  "formaction",
  "background",
  "poster",
  "xlink:href",
]);

/**
 * 校验行内超链接目标是否安全（先剥离控制符与空白，防绕过）。
 * 严格拒绝 javascript:、vbscript:、data:；允许 http(s):、mailto:、tel:、file:、vscode: 与站内/相对路径。
 */
export function isSafeInlineHref(rawHref: string): boolean {
  if (!rawHref) return false;
  const compact = rawHref.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (!compact) return false;
  if (
    compact.startsWith("javascript:") ||
    compact.startsWith("vbscript:") ||
    compact.startsWith("data:")
  ) {
    return false;
  }
  if (
    compact.startsWith("http:") ||
    compact.startsWith("https:") ||
    compact.startsWith("mailto:") ||
    compact.startsWith("tel:") ||
    compact.startsWith("file:") ||
    compact.startsWith("vscode:") ||
    compact.startsWith("#") ||
    compact.startsWith("./") ||
    compact.startsWith("../") ||
    compact.startsWith("/")
  ) {
    return true;
  }
  // 不含 scheme 前缀的相对文件/锚点引用（例如 `docs/arch.md`）
  return !/^[a-z][a-z0-9+.-]*:/.test(compact);
}

function isSafeInlineStyle(styleVal: string): boolean {
  const compact = styleVal.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (
    compact.includes("url(") ||
    compact.includes("expression(") ||
    compact.includes("@import") ||
    compact.includes("javascript:") ||
    compact.includes("behavior:")
  ) {
    return false;
  }
  return true;
}

function sanitizeNodeTree(root: Node): void {
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      root.removeChild(child);
      continue;
    }

    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (BLOCKED_SUBTREE_TAGS.has(tag)) {
      root.removeChild(el);
      continue;
    }

    if (!ALLOWED_INLINE_TAGS.has(tag)) {
      sanitizeNodeTree(el);
      while (el.firstChild) {
        root.insertBefore(el.firstChild, el);
      }
      root.removeChild(el);
      continue;
    }

    const allowedSet = tag === "a" ? ALLOWED_LINK_ATTRS : ALLOWED_GENERAL_ATTRS;
    for (const attr of Array.from(el.attributes)) {
      const nameLower = attr.name.toLowerCase();
      if (
        nameLower.startsWith("on") ||
        BLOCKED_ATTRS.has(nameLower) ||
        !allowedSet.has(nameLower)
      ) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (nameLower === "href" && !isSafeInlineHref(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (nameLower === "style" && !isSafeInlineStyle(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }

    sanitizeNodeTree(el);
  }
}

/**
 * 在写入 DOM innerHTML / dangerouslySetInnerHTML 前清洗富文本片段：
 * 保留安全排版、双向链接与 KaTeX 公式节点，剥离脚本、事件属性及危险协议链接。
 */
export function sanitizeRichInlineHtml(html: string): string {
  if (!html || !html.includes("<")) {
    return html;
  }

  if (typeof document === "undefined") {
    return html
      .replace(/<\s*(script|style|iframe|object|embed|form|img|svg)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
      .replace(/<\s*(script|style|iframe|object|embed|form|img|svg)\b[^>]*\/?>/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  sanitizeNodeTree(tpl.content);
  return tpl.innerHTML;
}
