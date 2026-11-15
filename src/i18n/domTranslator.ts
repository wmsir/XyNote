/**
 * 界面翻译层：英文模式下，把界面上的中文原文按词典换成英文。
 *
 * 只替换「整段文字与词典完全一致」的文字节点和 title / placeholder / aria-label / alt 属性，
 * 带 {0} 占位符的词条按模式匹配；笔记正文、文件内容等用户数据所在区域一律跳过。
 * 切回中文时恢复原文。
 */
import { resolveUiLang, UI_LANG_EVENT, type UiLang } from "./lang";

const HAN = /[㐀-鿿]/;
const ATTRS = ["title", "placeholder", "aria-label", "alt"];

/** 用户内容区域：不翻译 */
const SKIP_SELECTOR = [
  "[contenteditable='true']",
  "[contenteditable='']",
  "[data-i18n-skip]",
  "textarea",
  "pre",
  "code",
  "svg",
  ".katex",
  ".nb-texted-lines",
  ".nb-texted-mark",
  ".nb-texted-status-path",
  ".nb-tree-title",
  ".nb-breadcrumb-item",
  ".nb-local-md-filename",
  ".nb-history-preview-body",
  ".nb-db-card-title",
  ".nb-db-gallery-title",
  ".nb-tpl-preview-line",
].join(",");

let dict: Map<string, string> | null = null;
let patterns: { re: RegExp; groups: number[]; out: string }[] = [];
let lang: UiLang = "zh";
let observer: MutationObserver | null = null;

/** 文字节点的中文原文与已写入的译文 */
const textOrig = new WeakMap<Text, { orig: string; shown: string }>();
/** 元素属性的中文原文 */
const attrOrig = new WeakMap<Element, Map<string, { orig: string; shown: string }>>();

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPatterns(src: Record<string, string>) {
  dict = new Map();
  patterns = [];
  for (const [zh, en] of Object.entries(src)) {
    if (!/\{\d+\}/.test(zh)) {
      dict.set(zh, en);
      continue;
    }
    const groups: number[] = [];
    const re = zh
      .split(/(\{\d+\})/)
      .map((part) => {
        const m = part.match(/^\{(\d+)\}$/);
        if (m) {
          groups.push(Number(m[1]));
          return "([\\s\\S]*?)";
        }
        return escapeRe(part);
      })
      .join("");
    patterns.push({ re: new RegExp(`^${re}$`), groups, out: en });
  }
  // 长的模式优先，避免短模式抢先匹配
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}

function translateCore(s: string, depth = 0): string | null {
  if (!dict) return null;
  const exact = dict.get(s);
  if (exact !== undefined) return exact;
  if (depth > 1) return null;
  for (const p of patterns) {
    const m = s.match(p.re);
    if (!m) continue;
    return p.out.replace(/\{(\d+)\}/g, (_, n) => {
      const idx = p.groups.indexOf(Number(n));
      const v = idx >= 0 ? m[idx + 1] ?? "" : "";
      return (HAN.test(v) && translateCore(v.trim(), depth + 1)) || v;
    });
  }
  return null;
}

/** 翻译一段界面文字；没有译文时返回原文（中文模式直接返回原文） */
export function t(text: string): string {
  if (lang !== "en" || !text || !HAN.test(text)) return text;
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const trail = text.match(/\s*$/)?.[0] ?? "";
  const core = text.trim();
  const out = translateCore(core);
  return out === null ? text : lead + out + trail;
}

function skipped(el: Element | null): boolean {
  return !el || !!el.closest(SKIP_SELECTOR);
}

function handleText(node: Text) {
  const rec = textOrig.get(node);
  const data = node.data;
  if (rec && data === rec.shown) return; // 是我们写入的译文
  const orig = data;
  if (lang !== "en") {
    if (rec) textOrig.delete(node);
    return;
  }
  if (!HAN.test(orig) || skipped(node.parentElement)) return;
  const shown = t(orig);
  if (shown === orig) return;
  textOrig.set(node, { orig, shown });
  node.data = shown;
}

function handleAttrs(el: Element) {
  if (lang !== "en") return;
  // 输入框自身的 placeholder 等要翻译（里面的内容不翻译）；其他元素在用户内容区域里就跳过
  const isField = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  const host = isField ? el.parentElement : el;
  if (host && skipped(host)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    let map = attrOrig.get(el);
    const rec = map?.get(a);
    if (rec && v === rec.shown) continue;
    if (!HAN.test(v)) continue;
    const shown = t(v);
    if (shown === v) continue;
    if (!map) {
      map = new Map();
      attrOrig.set(el, map);
    }
    map.set(a, { orig: v, shown });
    el.setAttribute(a, shown);
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    handleText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  const el = root as Element;
  if (root.nodeType === Node.ELEMENT_NODE) {
    handleAttrs(el);
    if (el.matches?.(SKIP_SELECTOR) && el.tagName !== "TEXTAREA") return;
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element;
        handleAttrs(e);
        return e.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = tw.nextNode())) handleText(n as Text);
}

/** 切回中文：把译文还原成原文 */
function restoreAll(root: Node) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n: Node | null = root;
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) {
      const rec = textOrig.get(n as Text);
      if (rec && (n as Text).data === rec.shown) (n as Text).data = rec.orig;
      textOrig.delete(n as Text);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const map = attrOrig.get(n as Element);
      map?.forEach((rec, a) => {
        if ((n as Element).getAttribute(a) === rec.shown) (n as Element).setAttribute(a, rec.orig);
      });
      attrOrig.delete(n as Element);
    }
    n = tw.nextNode();
  }
}

const nativeConfirm = window.confirm.bind(window);
const nativeAlert = window.alert.bind(window);
const nativePrompt = window.prompt.bind(window);

function patchDialogs() {
  window.confirm = (msg?: string) => nativeConfirm(msg === undefined ? msg : t(String(msg)));
  window.alert = (msg?: unknown) => nativeAlert(msg === undefined ? msg : t(String(msg)));
  window.prompt = (msg?: string, def?: string) => nativePrompt(msg === undefined ? msg : t(String(msg)), def);
}

async function ensureDict() {
  if (dict) return;
  const mod = await import("./en");
  buildPatterns(mod.default);
}

async function apply(next: UiLang) {
  lang = next;
  document.documentElement.lang = next === "en" ? "en" : "zh-CN";
  if (next === "en") {
    await ensureDict();
    walk(document.body);
    observer?.disconnect();
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") handleText(r.target as Text);
        else if (r.type === "attributes") handleAttrs(r.target as Element);
        else r.addedNodes.forEach((n) => walk(n));
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  } else {
    observer?.disconnect();
    observer = null;
    restoreAll(document.body);
  }
}

/** 应用启动时调用：英文模式下先加载词典再渲染，避免先闪出中文 */
export async function initUiLanguage() {
  patchDialogs();
  const initial = resolveUiLang();
  if (initial === "en") await ensureDict();
  lang = initial;
  window.addEventListener(UI_LANG_EVENT, (e) => void apply((e as CustomEvent<UiLang>).detail));
  // DOM 渲染后开始监听
  queueMicrotask(() => void apply(initial));
}

export function currentUiLang(): UiLang {
  return lang;
}
