/**
 * 页面图标：既可以是表情（📄），也可以是 SVG 图标。
 * SVG 图标保存为「lucide:<图标名>[:#颜色]」，例如 lucide:Rocket:#e03e3e。
 */
import React, { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

export const SVG_ICON_PREFIX = "lucide:";

export interface SvgIconRef {
  name: string;
  color: string | null;
}

export function parseSvgIcon(icon: string | null | undefined): SvgIconRef | null {
  const raw = (icon ?? "").trim();
  if (!raw.startsWith(SVG_ICON_PREFIX)) return null;
  const [name, color] = raw.slice(SVG_ICON_PREFIX.length).split(":");
  if (!name) return null;
  return { name, color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null };
}

export function formatSvgIcon(name: string, color?: string | null): string {
  return `${SVG_ICON_PREFIX}${name}${color ? `:${color}` : ""}`;
}

export function isSvgIcon(icon: string | null | undefined): boolean {
  return parseSvgIcon(icon) !== null;
}

/** 只能放文字的地方（双链、Markdown 标题）：SVG 图标换成默认表情 */
export function iconAsText(icon: string | null | undefined, fallback = "📄"): string {
  const raw = (icon ?? "").trim();
  if (!raw || isSvgIcon(raw)) return fallback;
  return raw;
}

/* ---------------- 图标库按需加载 ---------------- */

export type IconMap = Record<string, LucideIcon>;

let library: IconMap | null = null;
let loading: Promise<IconMap> | null = null;
const listeners = new Set<(m: IconMap) => void>();

export function loadIconLibrary(): Promise<IconMap> {
  if (library) return Promise.resolve(library);
  if (!loading) {
    loading = import("./lucideLibrary").then((m) => {
      library = m.icons as unknown as IconMap;
      listeners.forEach((fn) => fn(library!));
      listeners.clear();
      return library;
    });
  }
  return loading;
}

/** 图标库加载好之后返回它；还没加载时返回 null 并开始加载 */
export function useIconLibrary(enabled = true): IconMap | null {
  const [lib, setLib] = useState<IconMap | null>(library);
  useEffect(() => {
    if (!enabled || lib) return;
    let alive = true;
    const fn = (m: IconMap) => alive && setLib(m);
    listeners.add(fn);
    void loadIconLibrary().then(fn);
    return () => {
      alive = false;
      listeners.delete(fn);
    };
  }, [enabled, lib]);
  return lib;
}

export interface PageIconProps {
  icon: string | null | undefined;
  /** 像素大小（SVG 宽高；表情的字号） */
  size?: number;
  /** 没有图标时显示的内容 */
  fallback?: React.ReactNode;
  className?: string;
  strokeWidth?: number;
}

/** 统一渲染页面图标：表情直接显示文字，SVG 图标按需加载后绘制 */
export function PageIcon({ icon, size = 16, fallback = "📄", className, strokeWidth = 1.8 }: PageIconProps) {
  const svg = parseSvgIcon(icon);
  const lib = useIconLibrary(!!svg);
  if (!svg) {
    const text = (icon ?? "").trim();
    return <span className={className}>{text || fallback}</span>;
  }
  const Cmp = lib?.[svg.name];
  if (!Cmp) {
    // 加载中或图标名无效：占位，保持布局不跳动
    return <span className={className} style={{ display: "inline-block", width: size, height: size }} aria-hidden="true" />;
  }
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 0 }}>
      <Cmp size={size} strokeWidth={strokeWidth} color={svg.color ?? "currentColor"} aria-hidden="true" />
    </span>
  );
}
