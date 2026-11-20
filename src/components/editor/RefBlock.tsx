import React, { useCallback, useEffect, useState } from "react";
import { CornerDownRight, Link2Off, RefreshCw } from "lucide-react";
import type { Block, Page } from "../../types/notion";
import { getPageDetail } from "../../api/client";
import { sanitizeRichInlineHtml } from "./sanitizeHtml";

interface Props {
  block: Block;
  pages: Page[];
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; source: Block; pageTitle: string; pageIcon: string }
  | { kind: "missing"; reason: string };

/**
 * 块引用：显示另一个页面里某个块的当前内容（只读）。
 * 原文改了，这里会在切回窗口或 20 秒内刷新；要修改请点「跳到原文」。
 */
export const RefBlock: React.FC<Props> = ({ block, pages }) => {
  const { refPageId, refBlockId } = block.props;
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!refPageId || !refBlockId) {
      setState({ kind: "missing", reason: "引用不完整" });
      return;
    }
    try {
      const d = await getPageDetail(refPageId);
      if (d.page.isTrashed) {
        setState({ kind: "missing", reason: "原文所在页面已移到回收站" });
        return;
      }
      const src = d.blocks.find((b) => b.id === refBlockId);
      if (!src) {
        setState({ kind: "missing", reason: "原文的这一块已被删除" });
        return;
      }
      setState({ kind: "ok", source: src, pageTitle: d.page.title || "无标题", pageIcon: d.page.icon || "📄" });
    } catch {
      setState({ kind: "missing", reason: "找不到原文所在页面" });
    }
  }, [refPageId, refBlockId]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(t);
    };
  }, [load]);

  // 页面列表变化（改名等）时也刷新标题
  const pageStamp = pages.find((p) => p.id === refPageId)?.updatedAt;
  useEffect(() => {
    if (pageStamp) void load();
  }, [pageStamp, load]);

  const jump = () => {
    if (!refPageId) return;
    window.dispatchEvent(new CustomEvent("xynote:open-page", { detail: { pageId: refPageId, blockId: refBlockId ?? null } }));
  };

  if (state.kind === "missing") {
    return (
      <div className="nb-refblock is-missing" contentEditable={false}>
        <Link2Off size={14} />
        <span>{state.reason}</span>
        <button type="button" className="nb-refblock-retry" onClick={() => void load()} title="重新查找">
          <RefreshCw size={12} />
        </button>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="nb-refblock is-loading" contentEditable={false}>
        <span>正在读取引用的内容…</span>
      </div>
    );
  }

  const src = state.source;
  const isRaw = src.blockType === "code" || src.blockType === "math" || src.blockType === "mermaid";
  let body: React.ReactNode;
  if (isRaw) {
    body = <pre className="nb-refblock-pre">{src.content}</pre>;
  } else if (src.content && !["image", "bookmark", "embed", "file", "table", "divider"].includes(src.blockType)) {
    body = (
      <div
        className={`nb-refblock-rich is-${src.blockType}`}
        dangerouslySetInnerHTML={{ __html: sanitizeRichInlineHtml(src.content) }}
      />
    );
  } else {
    body = <div className="nb-refblock-rich">{src.plainText || "（这个块没有文字内容）"}</div>;
  }

  return (
    <div className="nb-refblock" contentEditable={false}>
      {src.blockType === "todo" && (
        <span className={`nb-refblock-todo${src.props.checked ? " is-checked" : ""}`} aria-hidden="true" />
      )}
      <div className="nb-refblock-body" data-i18n-skip="">
        {body}
      </div>
      <button type="button" className="nb-refblock-source" onClick={jump} title="跳到原文修改">
        <CornerDownRight size={12} />
        <span>来自</span>
        <span className="nb-refblock-page" data-i18n-skip="">
          {state.pageIcon && !state.pageIcon.startsWith("lucide:") ? `${state.pageIcon} ` : ""}
          {state.pageTitle}
        </span>
      </button>
    </div>
  );
};
