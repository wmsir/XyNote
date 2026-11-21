import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 自动换行时，一行源码在 textarea 里可能占好几行。
 * 这里用一个与 textarea 同字体、同宽度的隐藏镜像量出每一行的实际高度，
 * 让行号栏每个号码的高度与它对应的那一行对齐，行号不会提前「用完」。
 *
 * 不换行时返回 null，行号栏按统一行高排列即可。
 *
 * 每行的高度按「行文本」缓存，宽度或字体变化时整体失效。输入时通常只有一两行是新的，
 * 只测量这些行，长文档每次按键不再把几千行全部重新排版。
 */

/** 缓存超过这个数量就整体清空，避免长时间编辑后无限增长 */
const MAX_CACHED_LINES = 20000;
export function useWrappedLineHeights(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  text: string,
  enabled: boolean,
  wrap: boolean
): number[] | null {
  const [heights, setHeights] = useState<number[] | null>(null);
  const [width, setWidth] = useState(0);
  const [fontEpoch, setFontEpoch] = useState(0);
  const cacheRef = useRef<{ key: string; map: Map<string, number> }>({ key: "", map: new Map() });

  // 宽度变化（拖动窗口、开关侧栏、分栏）时重新测量
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !enabled || !wrap || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(ta.clientWidth));
    });
    ro.observe(ta);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [textareaRef, enabled, wrap]);

  // 网页字体加载完成后字形宽度会变，清掉缓存重新测量
  useLayoutEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!enabled || !wrap || !fonts || typeof fonts.addEventListener !== "function") return;
    const onFontsLoaded = () => {
      cacheRef.current.key = "";
      setFontEpoch((n) => n + 1);
    };
    fonts.addEventListener("loadingdone", onFontsLoaded);
    return () => fonts.removeEventListener("loadingdone", onFontsLoaded);
  }, [enabled, wrap]);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !enabled || !wrap) {
      setHeights(null);
      return;
    }
    // 宽度用 ResizeObserver 记下的值，按键时不读 clientWidth，避免强制整页同步排版；
    // getComputedStyle 读字体和内边距只需要样式计算，开销小，字号设置改了也能马上生效
    const cs = getComputedStyle(ta);
    const taWidth = width > 0 ? width : ta.clientWidth;
    const contentWidth =
      taWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    if (contentWidth <= 0) {
      setHeights(null);
      return;
    }

    const signature = [
      contentWidth,
      cs.fontFamily,
      cs.fontSize,
      cs.fontWeight,
      cs.fontStyle,
      cs.letterSpacing,
      cs.wordSpacing,
      cs.lineHeight,
      cs.tabSize,
      cs.wordBreak,
      cs.overflowWrap,
    ].join("|");
    const cache = cacheRef.current;
    if (cache.key !== signature || cache.map.size > MAX_CACHED_LINES) {
      cache.key = signature;
      cache.map = new Map();
    }

    const lines = text.split("\n");
    const missing: string[] = [];
    const queued = new Set<string>();
    for (const line of lines) {
      if (!cache.map.has(line) && !queued.has(line)) {
        queued.add(line);
        missing.push(line);
      }
    }

    if (missing.length > 0) {
      const mirror = document.createElement("div");
      mirror.setAttribute("aria-hidden", "true");
      const s = mirror.style;
      s.position = "absolute";
      s.left = "-99999px";
      s.top = "0";
      s.visibility = "hidden";
      s.pointerEvents = "none";
      s.boxSizing = "content-box";
      s.width = `${contentWidth}px`;
      s.padding = "0";
      s.border = "0";
      s.fontFamily = cs.fontFamily;
      s.fontSize = cs.fontSize;
      s.fontWeight = cs.fontWeight;
      s.fontStyle = cs.fontStyle;
      s.fontFeatureSettings = cs.fontFeatureSettings;
      s.fontVariantLigatures = cs.fontVariantLigatures;
      s.letterSpacing = cs.letterSpacing;
      s.wordSpacing = cs.wordSpacing;
      s.lineHeight = cs.lineHeight;
      s.tabSize = cs.tabSize;
      s.whiteSpace = "pre-wrap";
      s.wordBreak = cs.wordBreak;
      s.overflowWrap = cs.overflowWrap === "normal" ? "break-word" : cs.overflowWrap;

      const frag = document.createDocumentFragment();
      for (const line of missing) {
        const row = document.createElement("div");
        // 空行也要占一行高度
        row.textContent = line.length ? line : "\u200B";
        frag.appendChild(row);
      }
      mirror.appendChild(frag);
      document.body.appendChild(mirror);
      const rows = mirror.children;
      for (let i = 0; i < missing.length; i += 1) {
        cache.map.set(missing[i], (rows[i] as HTMLElement).getBoundingClientRect().height);
      }
      mirror.remove();
    }

    const next = lines.map((line) => cache.map.get(line) ?? 0);

    setHeights((prev) =>
      prev && prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 0.5) ? prev : next
    );
  }, [textareaRef, text, enabled, wrap, width, fontEpoch]);

  return heights;
}
