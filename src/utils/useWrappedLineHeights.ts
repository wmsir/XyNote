import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 自动换行时，一行源码在 textarea 里可能占好几行。
 * 这里用一个与 textarea 同字体、同宽度的隐藏镜像量出每一行的实际高度，
 * 让行号栏每个号码的高度与它对应的那一行对齐，行号不会提前「用完」。
 *
 * 不换行时返回 null，行号栏按统一行高排列即可。
 */
export function useWrappedLineHeights(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  text: string,
  enabled: boolean,
  wrap: boolean
): number[] | null {
  const [heights, setHeights] = useState<number[] | null>(null);
  const [width, setWidth] = useState(0);

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

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !enabled || !wrap) {
      setHeights(null);
      return;
    }
    const cs = getComputedStyle(ta);
    const contentWidth =
      ta.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    if (contentWidth <= 0) {
      setHeights(null);
      return;
    }

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

    const lines = text.split("\n");
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement("div");
      // 空行也要占一行高度
      row.textContent = line.length ? line : "​";
      frag.appendChild(row);
    }
    mirror.appendChild(frag);
    document.body.appendChild(mirror);
    const next = Array.from(mirror.children, (el) => (el as HTMLElement).getBoundingClientRect().height);
    mirror.remove();

    setHeights((prev) =>
      prev && prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 0.5) ? prev : next
    );
  }, [textareaRef, text, enabled, wrap, width]);

  return heights;
}
