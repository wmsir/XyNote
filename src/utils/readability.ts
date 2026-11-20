/**
 * 网页正文提取（简化版 Readability）：去掉导航、页脚、评论、广告等，
 * 找出文字最多、链接最少的那一块作为正文。
 */

const NOISE_TAGS = "script,style,noscript,iframe,form,nav,footer,aside,button,input,select,textarea,svg,canvas";
const NOISE_RE = /(comment|footer|foot|nav|menu|sidebar|side-bar|banner|advert|\bad\b|ads|share|social|related|recommend|subscribe|newsletter|popup|modal|cookie|breadcrumb|pagination|toolbar|header-nav)/i;
const POSITIVE_RE = /(article|content|post|entry|main|body|text|story|blog|rich_media)/i;

export interface ExtractedArticle {
  title: string;
  html: string;
  byline: string;
  siteName: string;
}

function textLen(el: Element): number {
  return (el.textContent || "").replace(/\s+/g, " ").trim().length;
}

function linkDensity(el: Element): number {
  const total = textLen(el) || 1;
  let links = 0;
  el.querySelectorAll("a").forEach((a) => (links += textLen(a)));
  return links / total;
}

function meta(doc: Document, ...names: string[]): string {
  for (const n of names) {
    const el =
      doc.querySelector(`meta[property="${n}"]`) || doc.querySelector(`meta[name="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return "";
}

export function extractArticle(html: string, url: string): ExtractedArticle {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 懒加载图片：把 data-src 换成 src
  doc.querySelectorAll("img").forEach((img) => {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-actualsrc");
    if (lazy) img.setAttribute("src", lazy);
    const src = img.getAttribute("src");
    if (src) {
      try {
        img.setAttribute("src", new URL(src, url).toString());
      } catch {
        /* ignore */
      }
    }
  });
  doc.querySelectorAll("a[href]").forEach((a) => {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href") || "", url).toString());
    } catch {
      /* ignore */
    }
  });

  const title =
    meta(doc, "og:title", "twitter:title") ||
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title.trim() ||
    url;
  const siteName = meta(doc, "og:site_name", "application-name") || (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const byline = meta(doc, "author", "article:author");

  doc.querySelectorAll(NOISE_TAGS).forEach((el) => el.remove());
  doc.querySelectorAll("[class],[id]").forEach((el) => {
    const sig = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
    if (NOISE_RE.test(sig) && !POSITIVE_RE.test(sig) && el.tagName !== "BODY" && el.tagName !== "ARTICLE") {
      el.remove();
    }
  });
  doc.querySelectorAll("[hidden],[aria-hidden='true']").forEach((el) => el.remove());

  // 候选：<article>、<main>，以及包含段落最多的容器
  let best: Element | null = null;
  let bestScore = 0;
  const candidates = new Set<Element>();
  doc.querySelectorAll("article, main, [role='main']").forEach((el) => candidates.add(el));
  doc.querySelectorAll("p").forEach((p) => {
    if (p.parentElement) candidates.add(p.parentElement);
    if (p.parentElement?.parentElement) candidates.add(p.parentElement.parentElement);
  });
  candidates.forEach((el) => {
    const len = textLen(el);
    if (len < 140) return;
    const paras = el.querySelectorAll("p").length;
    const sig = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
    let score = len * (1 - linkDensity(el)) + paras * 40;
    if (el.tagName === "ARTICLE" || el.tagName === "MAIN") score *= 1.25;
    if (POSITIVE_RE.test(sig)) score *= 1.15;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  });
  const root: Element = best ?? doc.body;

  // 正文开头和标题重复的 h1 去掉
  const firstH1 = root.querySelector("h1");
  if (firstH1 && firstH1.textContent?.trim() === title) firstH1.remove();

  return { title, html: root.innerHTML, byline, siteName };
}
