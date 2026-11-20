import React, { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appendToInbox, hideQuickWindow } from "../../api/quick";
import { isTauriRuntime } from "../../api/client";

/**
 * 全局快捷键唤出的快速记录小窗。
 * 回车存进「收件箱」，Shift+回车换行，Esc 收起。
 */
export const QuickCapture: React.FC = () => {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const focusInput = useCallback(() => {
    window.setTimeout(() => ref.current?.focus(), 30);
  }, []);

  useEffect(() => {
    focusInput();
    if (!isTauriRuntime()) return;
    const unlisten: Array<() => void> = [];
    listen("quick-capture:show", () => {
      setStatus("idle");
      focusInput();
    })
      .then((u) => unlisten.push(u))
      .catch(() => {});
    getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload) focusInput();
      })
      .then((u) => unlisten.push(u))
      .catch(() => {});
    return () => unlisten.forEach((u) => u());
  }, [focusInput]);

  // 跟随系统深浅色
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const mode = mq?.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", mode);
      document.documentElement.className = `theme-${mode}`;
    };
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, []);

  const close = () => {
    hideQuickWindow().catch(() => {});
  };

  const save = async () => {
    const value = text.trim();
    if (!value || status === "saving") return;
    setStatus("saving");
    setError("");
    try {
      await appendToInbox(value);
      setText("");
      setStatus("saved");
      emit("quick-capture:saved").catch(() => {});
      window.setTimeout(() => {
        setStatus("idle");
        close();
      }, 650);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="nb-quick" data-tauri-drag-region>
      <div className="nb-quick-head" data-tauri-drag-region>
        <Inbox size={14} aria-hidden="true" />
        <span data-tauri-drag-region>记到收件箱</span>
      </div>
      <textarea
        ref={ref}
        className="nb-quick-input"
        value={text}
        placeholder="想到什么就写下来…  以 [] 开头会变成待办"
        aria-label="快速记录内容"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="nb-quick-foot">
        {status === "saved" ? (
          <span className="nb-quick-ok">已存入收件箱</span>
        ) : status === "error" ? (
          <span className="nb-quick-err">保存失败：{error}</span>
        ) : (
          <span className="nb-quick-hint">
            <kbd>Enter</kbd> 保存　<kbd>Shift</kbd>+<kbd>Enter</kbd> 换行　<kbd>Esc</kbd> 收起
          </span>
        )}
      </div>
    </div>
  );
};
