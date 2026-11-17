import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft,
  Calendar,
  CheckSquare,
  ChevronDownCircle,
  CircleDot,
  Hash,
  Link2,
  Tags,
  Type,
} from "lucide-react";
import type { ColumnType } from "../../types/notion";

export interface ColumnIconProps {
  colType: ColumnType;
  size?: number;
  className?: string;
}

export const ColumnIcon: React.FC<ColumnIconProps> = ({
  colType,
  size = 14,
  className = "nb-db-col-icon",
}) => {
  switch (colType) {
    case "title":
      return <Type size={size} className={className} />;
    case "status":
      return <CircleDot size={size} className={className} />;
    case "select":
      return <ChevronDownCircle size={size} className={className} />;
    case "multi_select":
      return <Tags size={size} className={className} />;
    case "date":
      return <Calendar size={size} className={className} />;
    case "checkbox":
      return <CheckSquare size={size} className={className} />;
    case "number":
      return <Hash size={size} className={className} />;
    case "url":
      return <Link2 size={size} className={className} />;
    case "text":
    default:
      return <AlignLeft size={size} className={className} />;
  }
};

export function detectThemeStyles(sourceEl: HTMLElement | null): {
  isDark: boolean;
  vars: React.CSSProperties;
} {
  if (typeof window === "undefined") {
    return { isDark: false, vars: {} };
  }
  const varSource =
    (sourceEl?.closest(
      ".nb-db-drawer-panel, .nb-db-popover, .nb-db-root:not(.nb-db-drawer-backdrop)"
    ) as HTMLElement | null) ?? document.documentElement;
  const computed = window.getComputedStyle(varSource);
  let isDark: boolean | null = null;

  // Prefer explicit theme attributes before inspecting computed backgroundColor
  // (e.g. RowDetailDrawer backdrop uses semi-transparent overlay rgba(15,15,15,0.35))
  const explicitNb = sourceEl
    ?.closest("[data-nb-dark]")
    ?.getAttribute("data-nb-dark");
  if (explicitNb === "true") {
    isDark = true;
  } else if (explicitNb === "false") {
    isDark = false;
  }

  if (isDark === null) {
    const themeHost =
      sourceEl?.closest(
        "[data-theme], .dark, .theme-dark, .theme-light, .theme-sepia"
      ) ?? document.documentElement;
    const dt = themeHost.getAttribute("data-theme");
    if (
      dt === "dark" ||
      themeHost.classList.contains("dark") ||
      themeHost.classList.contains("theme-dark")
    ) {
      isDark = true;
    } else if (
      dt === "light" ||
      dt === "sepia" ||
      themeHost.classList.contains("theme-light") ||
      themeHost.classList.contains("theme-sepia")
    ) {
      isDark = false;
    }
  }

  if (isDark === null) {
    const bg = computed.backgroundColor || "";
    const rgbMatch =
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?/.exec(bg);
    if (rgbMatch) {
      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);
      const alpha = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
      isDark =
        alpha >= 0.8 &&
        r + g + b > 0 &&
        (r * 299 + g * 587 + b * 114) / 1000 < 110;
    } else {
      isDark = false;
    }
  }

  const varNames = [
    "--bg-primary",
    "--bg-secondary",
    "--bg-hover",
    "--bg-elevated",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--border-color",
    "--accent-color",
  ];
  const vars: Record<string, string> = {};
  for (const name of varNames) {
    const val = computed.getPropertyValue(name).trim();
    if (val) {
      vars[name] = val;
    }
  }

  return { isDark, vars: vars as React.CSSProperties };
}

export interface FloatingPopoverProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  width?: number;
  align?: "start" | "end";
  className?: string;
  children: React.ReactNode;
}

export const FloatingPopover: React.FC<FloatingPopoverProps> = ({
  anchorEl,
  onClose,
  width = 260,
  align = "start",
  className = "",
  children,
}) => {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });

  const { isDark, vars } = detectThemeStyles(anchorEl);

  useLayoutEffect(() => {
    if (!anchorEl) return;

    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const popHeight = popRef.current?.offsetHeight ?? 260;
      const popWidth = popRef.current?.offsetWidth ?? width;

      let left = align === "end" ? rect.right - popWidth : rect.left;
      left = Math.max(12, Math.min(left, window.innerWidth - popWidth - 12));

      let top = rect.bottom + 6;
      if (top + popHeight > window.innerHeight - 12 && rect.top > popHeight + 16) {
        top = rect.top - popHeight - 6;
      } else {
        top = Math.max(12, Math.min(top, window.innerHeight - 48));
      }

      setCoords({ top, left });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorEl, width, align]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorEl, onClose]);

  if (!anchorEl || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popRef}
      className={`nb-db-root nb-db-popover ${className}`.trim()}
      data-nb-dark={isDark ? "true" : "false"}
      style={{
        ...vars,
        position: "fixed",
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: `${width}px`,
        zIndex: 9500,
      }}
    >
      {children}
    </div>,
    document.body
  );
};
