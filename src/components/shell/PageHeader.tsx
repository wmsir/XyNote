import React, { useEffect, useRef, useState } from "react";
import { Image, Plus, Smile, X } from "lucide-react";
import type { Page, UpdatePagePatch } from "../../types/notion";
import { PageIcon } from "../../icons/pageIcon";
import { IconPicker } from "./IconPicker";


const COVER_PRESETS: Array<{ label: string; value: string }> = [
  {
    label: "暖米亚麻",
    value: "linear-gradient(120deg, #f6efe2 0%, #e9dfd0 52%, #dce5ea 100%)",
  },
  {
    label: "雾霭青灰",
    value: "linear-gradient(120deg, #dfe7ec 0%, #cfdce5 50%, #e6ece8 100%)",
  },
  {
    label: "鼠尾草绿",
    value: "linear-gradient(120deg, #e4ece2 0%, #d1dfd0 55%, #e8e6da 100%)",
  },
  {
    label: "暮色陶土",
    value: "linear-gradient(120deg, #f2dfd7 0%, #e6c9bc 55%, #ead9cb 100%)",
  },
  {
    label: "静谧深空",
    value: "linear-gradient(120deg, #2c3440 0%, #1f252e 55%, #343d4b 100%)",
  },
  {
    label: "松烟墨色",
    value: "linear-gradient(120deg, #323230 0%, #232321 55%, #3f3d38 100%)",
  },
  {
    label: "晨曦琥珀",
    value: "linear-gradient(120deg, #f7ebd2 0%, #eed7b5 55%, #f4e3d7 100%)",
  },
  {
    label: "淡雅薰衣",
    value: "linear-gradient(120deg, #e8e4f0 0%, #dad4e8 55%, #e6eaf2 100%)",
  },
];

export interface PageHeaderProps {
  page: Page;
  fontClass: string;
  containerModeClass?: string;
  focusTitleRequest?: { pageId: string; token: number } | null;
  onConsumeFocusTitle?: () => void;
  onUpdatePage: (patch: UpdatePagePatch) => void;
  onCreateSubpage: () => void;
}

/** 把光标放到正文第一个可编辑位置（所见即所得的第一块，或源码模式的文本框开头） */
function focusEditorStart(): boolean {
  const root = document.querySelector(".page-editor-container");
  if (!root) return false;
  const target = root.querySelector<HTMLElement>(
    '.nb-editor-source-textarea, [contenteditable="true"], textarea'
  );
  if (!target) return false;
  target.focus({ preventScroll: false });
  if (target instanceof HTMLTextAreaElement) {
    target.setSelectionRange(0, 0);
    target.scrollTop = 0;
  } else {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  return true;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  page,
  fontClass,
  containerModeClass = "",
  focusTitleRequest = null,
  onConsumeFocusTitle,
  onUpdatePage,
  onCreateSubpage,
}) => {
  const [localTitle, setLocalTitle] = useState(page.title);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [customCoverUrl, setCustomCoverUrl] = useState("");

  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const emojiPopoverRef = useRef<HTMLDivElement | null>(null);
  const coverPopoverRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLocalTitle(page.title);
    setEmojiOpen(false);
    setCoverOpen(false);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [page.id]);

  // Sync external updates (e.g. restored or duplicated title updates) when not focused
  useEffect(() => {
    if (document.activeElement !== titleRef.current) {
      setLocalTitle(page.title);
    }
  }, [page.title]);

  useEffect(() => {
    if (!titleRef.current) return;
    titleRef.current.style.height = "auto";
    titleRef.current.style.height = `${titleRef.current.scrollHeight}px`;
  }, [localTitle, page.id]);

  // Auto-focus and select placeholder title immediately after creating a new page/database
  useEffect(() => {
    if (!focusTitleRequest || focusTitleRequest.pageId !== page.id) return;
    const raf = window.requestAnimationFrame(() => {
      const el = titleRef.current;
      if (!el) return;
      el.focus();
      const val = el.value.trim();
      if (val === "无标题" || val === "无标题数据库") {
        el.select();
      } else {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
      onConsumeFocusTitle?.();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [focusTitleRequest, page.id, onConsumeFocusTitle]);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (
        emojiOpen &&
        emojiPopoverRef.current &&
        !emojiPopoverRef.current.contains(e.target as Node)
      ) {
        setEmojiOpen(false);
      }
      if (
        coverOpen &&
        coverPopoverRef.current &&
        !coverPopoverRef.current.contains(e.target as Node)
      ) {
        setCoverOpen(false);
      }
    };
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [emojiOpen, coverOpen]);

  const handleTitleChange = (val: string) => {
    setLocalTitle(val);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      onUpdatePage({ title: val.trim() || "无标题" });
    }, 240);
  };

  const handleTitleBlur = () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const normalized = localTitle.trim() || "无标题";
    if (normalized !== page.title) {
      onUpdatePage({ title: normalized });
    }
  };

  const getCoverStyle = (coverValue: string): React.CSSProperties => {
    if (
      coverValue.startsWith("http://") ||
      coverValue.startsWith("https://") ||
      coverValue.startsWith("data:")
    ) {
      return { backgroundImage: `url("${coverValue}")` };
    }
    return { background: coverValue };
  };

  return (
    <>
      {page.cover && (
        <div
          className={`nb-cover-banner${coverOpen ? " picker-open" : ""}`}
          style={getCoverStyle(page.cover)}
        >
          <div className="nb-cover-actions">
            <button
              type="button"
              className="nb-cover-btn"
              onClick={() => setCoverOpen((v) => !v)}
            >
              <Image size={13} /> 更换封面
            </button>
            <button
              type="button"
              className="nb-cover-btn"
              onClick={() => onUpdatePage({ cover: null })}
            >
              <X size={13} /> 移除
            </button>
          </div>

          {coverOpen && (
            <div
              ref={coverPopoverRef}
              className="nb-popover"
              style={{ right: "28px", bottom: "-205px", width: "310px" }}
            >
              <div className="nb-menu-label">精选封面色板</div>
              <div className="nb-cover-grid">
                {COVER_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="nb-cover-swatch"
                    style={{ background: preset.value }}
                    title={preset.label}
                    onClick={() => {
                      onUpdatePage({ cover: preset.value });
                      setCoverOpen(false);
                    }}
                  />
                ))}
              </div>
              <div className="nb-menu-divider" />
              <div style={{ display: "flex", gap: "6px", padding: "4px 2px" }}>
                <input
                  type="url"
                  className="nb-input"
                  placeholder="粘贴图片链接 https://..."
                  value={customCoverUrl}
                  onChange={(e) => setCustomCoverUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="nb-btn-primary"
                  onClick={() => {
                    if (customCoverUrl.trim()) {
                      onUpdatePage({ cover: customCoverUrl.trim() });
                      setCustomCoverUrl("");
                      setCoverOpen(false);
                    }
                  }}
                >
                  应用
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className={`nb-page-container page-content-column page-header-inner ${containerModeClass} ${fontClass}`.trim()}
        style={{ paddingBottom: 0 }}
      >
        <div className={`nb-page-header${page.cover ? " has-cover" : ""}`}>
          <div className="nb-page-icon-row">
            <div style={{ position: "relative" }} ref={emojiPopoverRef}>
              <button
                type="button"
                className="nb-page-icon-btn"
                onClick={() => setEmojiOpen((v) => !v)}
                title="点击更换页面图标"
              >
                <PageIcon icon={page.icon} size={56} strokeWidth={1.5} fallback="📄" />
              </button>

              {emojiOpen && (
                <IconPicker
                  value={page.icon ?? ""}
                  style={{ left: 0, top: "74px", position: "absolute" }}
                  onClose={() => setEmojiOpen(false)}
                  onChange={(icon, opts) => {
                    onUpdatePage({ icon: icon || (page.pageType === "database" ? "🗃️" : "📄") });
                    // 换颜色时保持打开；选了新图标或表情就关闭
                    if (!opts?.keepOpen) setEmojiOpen(false);
                  }}
                />
              )}
            </div>

            <div className="nb-header-hover-tools">
              <button
                type="button"
                className="nb-subtle-pill-btn"
                onClick={() => setEmojiOpen(true)}
              >
                <Smile size={14} /> 更换图标
              </button>
              {!page.cover && (
                <button
                  type="button"
                  className="nb-subtle-pill-btn"
                  onClick={() =>
                    onUpdatePage({ cover: COVER_PRESETS[0].value })
                  }
                >
                  <Image size={14} /> 添加封面
                </button>
              )}
              <button
                type="button"
                className="nb-subtle-pill-btn"
                onClick={onCreateSubpage}
              >
                <Plus size={14} /> 新建子页面
              </button>
            </div>
          </div>

          <textarea
            ref={titleRef}
            rows={1}
            className={`nb-page-title-input ${fontClass}`}
            placeholder="无标题"
            value={localTitle}
            onChange={(e) => handleTitleChange(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={(e) => {
              // 中文输入法用回车确认候选词时不能当成「标题写完了」
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              const el = e.currentTarget as HTMLTextAreaElement;
              const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
              if (e.key === "Enter" || (e.key === "ArrowDown" && atEnd)) {
                e.preventDefault();
                // 回车或在标题末尾按向下键：进入正文开头继续写
                if (page.pageType === "database" || !focusEditorStart()) el.blur();
              }
            }}
          />
        </div>
      </div>
    </>
  );
};
