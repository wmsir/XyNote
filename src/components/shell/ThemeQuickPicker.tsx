import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import type { StylePluginItem, StylePluginState, ThemeTokens } from "../../types/notion";
import { getActiveThemePlugin } from "./stylePluginEngine";

type BaseMode = "light" | "dark" | "sepia";
export type ThemePref = BaseMode | "system";

export interface ThemePreview {
  baseMode?: BaseMode;
  tokens?: ThemeTokens | null;
  extraCss?: string;
}

export interface ThemeQuickPickerProps {
  /** 当前实际显示的明暗基调 */
  effectiveTheme: BaseMode;
  themePref: ThemePref;
  styleState: StylePluginState | null;
  onSelectMode: (pref: ThemePref) => void;
  onSelectThemePlugin: (plugin: StylePluginItem) => void;
  /** 鼠标悬停时临时预览；null 表示恢复 */
  onPreview: (preview: ThemePreview | null) => void;
  onOpenThemeSettings: () => void;
}

const BASE_COLORS: Record<BaseMode, { bg: string; side: string; text: string; accent: string }> = {
  light: { bg: "#ffffff", side: "#f7f7f5", text: "#37352f", accent: "#2383e2" },
  dark: { bg: "#191919", side: "#202020", text: "#d4d4d4", accent: "#529cca" },
  sepia: { bg: "#fbf7ee", side: "#f3ecdc", text: "#433422", accent: "#b5651d" },
};

const MODES: { id: ThemePref; label: string; icon: React.ReactNode }[] = [
  { id: "light", label: "浅色", icon: <Sun size={15} /> },
  { id: "dark", label: "深色", icon: <Moon size={15} /> },
  { id: "sepia", label: "护眼", icon: <BookOpen size={15} /> },
  { id: "system", label: "跟随系统", icon: <Monitor size={15} /> },
];

function swatchOf(p: StylePluginItem) {
  const base = BASE_COLORS[p.baseMode] ?? BASE_COLORS.light;
  return {
    bg: p.tokens?.bgPrimary || base.bg,
    side: p.tokens?.bgSidebar || p.tokens?.bgSecondary || base.side,
    text: p.tokens?.textPrimary || base.text,
    accent: p.tokens?.accentColor || base.accent,
  };
}

/** 迷你窗口缩略图：侧栏、标题线、正文线和强调色 */
function Swatch({ c }: { c: { bg: string; side: string; text: string; accent: string } }) {
  return (
    <svg className="nb-themepick-swatch" viewBox="0 0 72 44" aria-hidden="true">
      <rect width="72" height="44" rx="5" fill={c.bg} />
      <rect width="20" height="44" rx="5" fill={c.side} />
      <rect x="15" width="5" height="44" fill={c.side} />
      <rect x="5" y="8" width="10" height="2.5" rx="1.25" fill={c.text} opacity="0.35" />
      <rect x="5" y="14" width="8" height="2.5" rx="1.25" fill={c.text} opacity="0.25" />
      <rect x="27" y="9" width="28" height="4" rx="2" fill={c.text} opacity="0.85" />
      <rect x="27" y="18" width="38" height="2.5" rx="1.25" fill={c.text} opacity="0.35" />
      <rect x="27" y="24" width="33" height="2.5" rx="1.25" fill={c.text} opacity="0.35" />
      <rect x="27" y="32" width="14" height="5" rx="2.5" fill={c.accent} />
    </svg>
  );
}

/** 顶栏的「外观」按钮：一步切换浅色 / 深色 / 护眼 / 跟随系统和主题插件，悬停即可预览 */
export function ThemeQuickPicker({
  effectiveTheme,
  themePref,
  styleState,
  onSelectMode,
  onSelectThemePlugin,
  onPreview,
  onOpenThemeSettings,
}: ThemeQuickPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activePlugin = getActiveThemePlugin(styleState);
  const themes = useMemo(() => (styleState?.plugins ?? []).filter((p) => p.kind === "theme"), [styleState]);

  const close = () => {
    setOpen(false);
    onPreview(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ButtonIcon = activePlugin ? Palette : effectiveTheme === "dark" ? Moon : effectiveTheme === "sepia" ? BookOpen : Sun;
  const currentName = activePlugin ? activePlugin.name : MODES.find((m) => m.id === themePref)?.label ?? "浅色";

  return (
    <div className="nb-themepick-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`nb-icon-btn${open ? " is-mode-on" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        title={`外观主题：${currentName}`}
        aria-label="外观主题"
        aria-expanded={open}
      >
        <ButtonIcon size={16} />
      </button>

      {open && (
        <div className="nb-popover nb-themepick" role="dialog" aria-label="外观主题" onMouseLeave={() => onPreview(null)}>
          <div className="nb-themepick-label">外观</div>
          <div className="nb-themepick-modes" role="radiogroup" aria-label="明暗模式">
            {MODES.map((m) => {
              const active = !activePlugin && themePref === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`nb-themepick-mode${active ? " is-active" : ""}`}
                  onMouseEnter={() =>
                    m.id !== "system" && onPreview({ baseMode: m.id as BaseMode, tokens: {}, extraCss: "" })
                  }
                  onFocus={() => m.id !== "system" && onPreview({ baseMode: m.id as BaseMode, tokens: {}, extraCss: "" })}
                  onClick={() => {
                    onPreview(null);
                    onSelectMode(m.id);
                  }}
                >
                  {m.icon}
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>

          {themes.length > 0 && (
            <>
              <div className="nb-themepick-label">主题</div>
              <div className="nb-themepick-grid">
                {themes.map((p) => {
                  const active = activePlugin?.id === p.id;
                  const preview = () => onPreview({ baseMode: p.baseMode, tokens: p.tokens ?? {}, extraCss: p.customCss });
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`nb-themepick-card${active ? " is-active" : ""}`}
                      onMouseEnter={preview}
                      onFocus={preview}
                      onClick={() => {
                        onPreview(null);
                        onSelectThemePlugin(p);
                      }}
                      title={p.description || p.name}
                      aria-pressed={active}
                    >
                      <Swatch c={swatchOf(p)} />
                      <span className="nb-themepick-name" data-i18n-skip={p.builtin ? undefined : ""}>
                        {p.name}
                      </span>
                      {active && (
                        <span className="nb-themepick-check" aria-hidden="true">
                          <Check size={12} strokeWidth={2.5} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <button
            type="button"
            className="nb-themepick-more"
            onClick={() => {
              close();
              onOpenThemeSettings();
            }}
          >
            <Palette size={14} /> 主题工坊与样式插件…
          </button>
        </div>
      )}
    </div>
  );
}
