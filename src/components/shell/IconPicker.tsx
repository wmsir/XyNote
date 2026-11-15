import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { formatSvgIcon, parseSvgIcon, useIconLibrary } from "../../icons/pageIcon";
import { ICON_COLORS, iconMatches, POPULAR_ICONS, splitIconName } from "../../icons/iconKeywords";
import { EMOJIS } from "../../icons/emojiList";


const MAX_VISIBLE = 240;

export interface IconPickerProps {
  value: string;
  /** keepOpen：只是换了颜色，选择器不必关闭 */
  onChange: (icon: string, opts?: { keepOpen?: boolean }) => void;
  onClose: () => void;
  /** 允许「移除图标」（回到默认图标） */
  allowRemove?: boolean;
  style?: React.CSSProperties;
}

/** 页面图标选择：SVG 图标库（中英文搜索、颜色）与表情 */
export function IconPicker({ value, onChange, onClose, allowRemove = true, style }: IconPickerProps) {
  const current = parseSvgIcon(value);
  const [tab, setTab] = useState<"icons" | "emoji">(current || !value ? "icons" : "emoji");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState<string | null>(current?.color ?? null);
  const [limit, setLimit] = useState(MAX_VISIBLE);
  const lib = useIconLibrary(tab === "icons");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  useEffect(() => setLimit(MAX_VISIBLE), [query, tab]);

  const iconNames = useMemo(() => {
    if (!lib) return [];
    const all = Object.keys(lib);
    if (!query.trim()) {
      const popular = POPULAR_ICONS.filter((n) => lib[n]);
      const seen = new Set(popular);
      return [...popular, ...all.filter((n) => !seen.has(n))];
    }
    return all.filter((n) => iconMatches(n, query));
  }, [lib, query]);

  const emojis = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMOJIS;
    return EMOJIS.filter(([em, kw]) => em === q || q.split(/\s+/).every((t) => kw.toLowerCase().includes(t)));
  }, [query]);

  const pickIcon = (name: string) => onChange(formatSvgIcon(name, color));

  const changeColor = (c: string | null) => {
    setColor(c);
    // 已经选了 SVG 图标时，直接换颜色
    if (current) onChange(formatSvgIcon(current.name, c), { keepOpen: true });
  };

  return (
    <div className="nb-popover nb-iconpick" style={style} ref={rootRef} role="dialog" aria-label="选择页面图标">
      <div className="nb-iconpick-head">
        <div className="nb-iconpick-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "icons"} className={tab === "icons" ? "is-active" : ""} onClick={() => setTab("icons")}>
            图标
          </button>
          <button type="button" role="tab" aria-selected={tab === "emoji"} className={tab === "emoji" ? "is-active" : ""} onClick={() => setTab("emoji")}>
            表情
          </button>
        </div>
        {allowRemove && value && (
          <button type="button" className="nb-iconpick-remove" onClick={() => onChange("")} title="改回默认图标">
            <Trash2 size={13} /> 移除
          </button>
        )}
      </div>

      <div className="nb-iconpick-search">
        <Search size={14} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "icons" ? "搜索图标，中英文都可以：文件、日历、rocket…" : "搜索表情：笔记、目标、coffee…"}
          aria-label="搜索图标"
        />
      </div>

      {tab === "icons" && (
        <div className="nb-iconpick-colors" role="radiogroup" aria-label="图标颜色">
          {ICON_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              role="radio"
              aria-checked={color === c.id}
              title={c.label}
              aria-label={c.label}
              className={`nb-iconpick-color${color === c.id ? " is-active" : ""}${c.id ? "" : " is-default"}`}
              style={c.id ? { background: c.id } : undefined}
              onClick={() => changeColor(c.id)}
            />
          ))}
        </div>
      )}

      <div
        className="nb-iconpick-grid-wrap"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) setLimit((l) => l + MAX_VISIBLE);
        }}
      >
        {tab === "icons" ? (
          !lib ? (
            <div className="nb-iconpick-empty">正在加载图标…</div>
          ) : iconNames.length === 0 ? (
            <div className="nb-iconpick-empty">没有找到「{query}」相关的图标，换个说法试试</div>
          ) : (
            <>
              {!query.trim() && <div className="nb-iconpick-label">常用 · 共 {Object.keys(lib).length} 个图标</div>}
              <div className="nb-iconpick-grid">
                {iconNames.slice(0, limit).map((name) => {
                  const Cmp = lib[name];
                  const selected = current?.name === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`nb-iconpick-cell${selected ? " is-selected" : ""}`}
                      title={splitIconName(name).join(" ")}
                      aria-label={splitIconName(name).join(" ")}
                      onClick={() => pickIcon(name)}
                    >
                      <Cmp size={20} strokeWidth={1.8} color={color ?? "currentColor"} />
                    </button>
                  );
                })}
              </div>
            </>
          )
        ) : emojis.length === 0 ? (
          <div className="nb-iconpick-empty">没有找到相关表情</div>
        ) : (
          <div className="nb-iconpick-grid">
            {emojis.map(([em, kw]) => (
              <button
                key={em}
                type="button"
                className={`nb-iconpick-cell is-emoji${value === em ? " is-selected" : ""}`}
                title={kw}
                onClick={() => onChange(em)}
              >
                {em}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
