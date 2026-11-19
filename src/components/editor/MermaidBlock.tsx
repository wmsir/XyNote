import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import {
  AlertTriangle,
  Check,
  Code2,
  Columns2,
  Copy,
  Download,
  Eye,
  GitBranch,
  Maximize2,
  RotateCcw,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { EditorPreferences } from "../../types/notion";
import { saveSvgFileDialog } from "../../api/client";
import { matchesActionShortcut } from "./editorKeybindings";
import {
  detectMermaidDiagramLabel,
  MERMAID_TEMPLATE_PRESETS,
} from "./editorUtils";

type MermaidViewMode = "preview" | "split" | "code";
type ActiveThemeName = "light" | "dark" | "sepia";

export interface MermaidBlockProps {
  blockId: string;
  code: string;
  mermaidView?: MermaidViewMode;
  readOnly?: boolean;
  preferences?: EditorPreferences;
  focusRef?: (node: HTMLElement | null) => void;
  onChangeCode?: (nextCode: string) => void;
  onChangeView?: (nextView: MermaidViewMode) => void;
  onExitBelow?: () => void;
  onConvertEmptyToParagraph?: () => void;
}

/* ============================================================================
 * Serialized Mermaid v11 Render Queue & Theme Configuration
 * ========================================================================== */

let renderSequence = 0;
let lastConfiguredTheme: ActiveThemeName | null = null;
let renderQueue: Promise<void> = Promise.resolve();

function detectDocumentTheme(): ActiveThemeName {
  if (typeof document === "undefined") return "light";
  const html = document.documentElement;
  const attr = (html.getAttribute("data-theme") || "").toLowerCase();
  if (attr === "dark" || html.classList.contains("theme-dark")) {
    return "dark";
  }
  if (attr === "sepia" || html.classList.contains("theme-sepia")) {
    return "sepia";
  }
  return "light";
}

function ensureMermaidThemeInitialized(themeName: ActiveThemeName): void {
  if (lastConfiguredTheme === themeName) return;
  lastConfiguredTheme = themeName;

  if (themeName === "dark") {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: true,
      suppressErrorRendering: true,
      theme: "dark",
      darkMode: true,
      fontFamily:
        'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      themeVariables: {
        primaryColor: "#1f2937",
        primaryTextColor: "#f3f4f6",
        primaryBorderColor: "#60a5fa",
        lineColor: "#9ca3af",
        secondaryColor: "#1e293b",
        tertiaryColor: "#111827",
        clusterBkg: "rgba(30, 41, 59, 0.72)",
        clusterBorder: "#475569",
        edgeLabelBackground: "#1f2937",
      },
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true,
        curve: "basis",
        padding: 14,
      },
      sequence: {
        useMaxWidth: true,
      },
      gantt: {
        useMaxWidth: true,
      },
    });
    return;
  }

  if (themeName === "sepia") {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: true,
      suppressErrorRendering: true,
      theme: "base",
      darkMode: false,
      fontFamily:
        'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      themeVariables: {
        primaryColor: "#f3ead8",
        primaryTextColor: "#3d352b",
        primaryBorderColor: "#b59a74",
        lineColor: "#78664e",
        secondaryColor: "#ebe0cb",
        tertiaryColor: "#f8f2e6",
        clusterBkg: "#f7f0e2",
        clusterBorder: "#cbb594",
        edgeLabelBackground: "#f6efe2",
      },
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true,
        curve: "basis",
        padding: 14,
      },
      sequence: {
        useMaxWidth: true,
      },
      gantt: {
        useMaxWidth: true,
      },
    });
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: true,
    suppressErrorRendering: true,
    theme: "default",
    darkMode: false,
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
      curve: "basis",
      padding: 14,
    },
    sequence: {
      useMaxWidth: true,
    },
    gantt: {
      useMaxWidth: true,
    },
  });
}

function cleanupStrayMermaidDom(renderId: string): void {
  if (typeof document === "undefined") return;
  for (const candidateId of [renderId, `d${renderId}`]) {
    const stray = document.getElementById(candidateId);
    if (stray && stray.parentElement === document.body) {
      stray.remove();
    }
  }
}

function enqueueMermaidSvgRender(
  rawCode: string,
  themeName: ActiveThemeName
): Promise<{ svg: string }> {
  const job = renderQueue.then(async () => {
    ensureMermaidThemeInitialized(themeName);
    const trimmed = rawCode.trim();
    const renderId = `nb-mmd-svg-${++renderSequence}`;
    try {
      await mermaid.parse(trimmed);
      const rendered = await mermaid.render(renderId, trimmed);
      return { svg: rendered.svg };
    } finally {
      cleanupStrayMermaidDom(renderId);
    }
  });

  renderQueue = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}

function formatMermaidError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message.split("\n").slice(0, 3).join("\n").trim();
  }
  return String(err || "Mermaid 语法解析失败，请检查节点括号或箭头格式");
}

function normalizeMermaidSvg(rawSvg: string): {
  svg: string;
  width: number;
  height: number;
} {
  const openMatch = /<svg\b([^>]*)>/i.exec(rawSvg);
  if (!openMatch) {
    return { svg: rawSvg, width: 640, height: 360 };
  }

  let attrs = openMatch[1];
  let width = 0;
  let height = 0;

  const viewBoxMatch = /\bviewBox\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
  const viewBoxRaw = (viewBoxMatch?.[1] || viewBoxMatch?.[2] || "").trim();
  if (viewBoxRaw) {
    const nums = viewBoxRaw
      .split(/[\s,]+/)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 4 && nums[2] > 1 && nums[3] > 1) {
      width = nums[2];
      height = nums[3];
    }
  }

  if (width <= 1 || height <= 1) {
    const styleMatch = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const styleVal = styleMatch?.[1] || styleMatch?.[2] || "";
    const maxWMatch = /max-width\s*:\s*([0-9]+(?:\.[0-9]+)?)px/i.exec(styleVal);
    if (maxWMatch) {
      const mw = Number(maxWMatch[1]);
      if (Number.isFinite(mw) && mw > 1) width = mw;
    }

    const wAttrMatch = /\bwidth\s*=\s*(?:"([0-9]+(?:\.[0-9]+)?)(?:px)?"|'([0-9]+(?:\.[0-9]+)?)(?:px)?')/i.exec(
      attrs
    );
    const wAttrNum = Number(wAttrMatch?.[1] || wAttrMatch?.[2] || 0);
    if (width <= 1 && Number.isFinite(wAttrNum) && wAttrNum > 1) {
      width = wAttrNum;
    }

    const hAttrMatch = /\bheight\s*=\s*(?:"([0-9]+(?:\.[0-9]+)?)(?:px)?"|'([0-9]+(?:\.[0-9]+)?)(?:px)?')/i.exec(
      attrs
    );
    const hAttrNum = Number(hAttrMatch?.[1] || hAttrMatch?.[2] || 0);
    if (height <= 1 && Number.isFinite(hAttrNum) && hAttrNum > 1) {
      height = hAttrNum;
    }
  }

  if (!Number.isFinite(width) || width <= 1) width = 640;
  if (!Number.isFinite(height) || height <= 1) height = 360;

  const roundedW = Math.round(width);
  const roundedH = Math.round(height);

  // Strip fluid width="100%" & inline max-width so SVG keeps predictable intrinsic aspect ratio
  attrs = attrs
    .replace(/\s+\bwidth\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s+\bheight\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\bstyle\s*=\s*"([^"]*)"/gi, (_full, inner: string) => {
      const cleaned = inner.replace(/max-width\s*:[^;]+;?/gi, "").trim();
      return cleaned ? `style="${cleaned}"` : "";
    })
    .replace(/\bstyle\s*=\s*'([^']*)'/gi, (_full, inner: string) => {
      const cleaned = inner.replace(/max-width\s*:[^;]+;?/gi, "").trim();
      return cleaned ? `style='${cleaned}'` : "";
    });

  const normalizedOpenTag = `<svg${attrs} width="${roundedW}" height="${roundedH}">`;
  const normalizedSvg =
    rawSvg.slice(0, openMatch.index) +
    normalizedOpenTag +
    rawSvg.slice(openMatch.index + openMatch[0].length);

  return {
    svg: normalizedSvg,
    width: roundedW,
    height: roundedH,
  };
}

/* ============================================================================
 * Typora-Grade Offline Mermaid Diagram Component
 * ========================================================================== */

export const MermaidBlock: React.FC<MermaidBlockProps> = ({
  blockId,
  code,
  mermaidView = "preview",
  readOnly = false,
  preferences,
  focusRef,
  onChangeCode,
  onChangeView,
  onExitBelow,
  onConvertEmptyToParagraph,
}) => {
  const [activeTheme, setActiveTheme] = useState<ActiveThemeName>(() =>
    detectDocumentTheme()
  );
  const [localView, setLocalView] = useState<MermaidViewMode>(mermaidView);
  const [svgHtml, setSvgHtml] = useState<string>("");
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  }>({ width: 640, height: 360 });
  const [stageInnerWidth, setStageInnerWidth] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerHeight : 900
  );
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [fitWidth, setFitWidth] = useState<boolean>(true);
  const [copiedSource, setCopiedSource] = useState<boolean>(false);
  const [exportedSvg, setExportedSvg] = useState<boolean>(false);
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);

  // Fullscreen Lightbox state (pan + wheel zoom, default auto-fit)
  const [lightboxOpen, setLightboxOpen] = useState<boolean>(false);
  const [lightboxFit, setLightboxFit] = useState<boolean>(true);
  const [lightboxScale, setLightboxScale] = useState<number>(1);
  const [lightboxPan, setLightboxPan] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [isPanning, setIsPanning] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lightboxViewportRef = useRef<HTMLDivElement | null>(null);
  const templateMenuRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Always default to auto-fit when switching blocks
  useEffect(() => {
    setFitWidth(true);
    setZoomPct(100);
  }, [blockId]);

  // Sync external `mermaidView` prop when changed
  useEffect(() => {
    setLocalView(mermaidView);
  }, [mermaidView]);

  // Observe Light / Dark / Sepia theme attribute mutations on `<html>`
  useEffect(() => {
    if (typeof document === "undefined") return;
    const htmlEl = document.documentElement;
    const syncTheme = () => {
      const next = detectDocumentTheme();
      setActiveTheme((prev) => (prev === next ? prev : next));
    };
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(htmlEl, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);

  // Close preset template popover on outside click
  useEffect(() => {
    if (!templatesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        templateMenuRef.current &&
        !templateMenuRef.current.contains(e.target as Node)
      ) {
        setTemplatesOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [templatesOpen]);

  // Close Lightbox on Escape
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setLightboxOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightboxOpen]);

  const effectiveView: MermaidViewMode = readOnly
    ? "preview"
    : code.trim().length === 0 && localView === "preview"
    ? "split"
    : localView;

  const diagramBadge = useMemo(
    () => detectMermaidDiagramLabel(code),
    [code]
  );

  // Render Mermaid SVG whenever `code` or `activeTheme` changes
  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvgHtml("");
      setNaturalSize({ width: 640, height: 360 });
      setSyntaxError(null);
      return;
    }

    const timer = window.setTimeout(() => {
      enqueueMermaidSvgRender(trimmed, activeTheme)
        .then(({ svg }) => {
          if (cancelled) return;
          const normalized = normalizeMermaidSvg(svg);
          setSvgHtml(normalized.svg);
          setNaturalSize({
            width: normalized.width,
            height: normalized.height,
          });
          setSyntaxError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSyntaxError(formatMermaidError(err));
        });
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, activeTheme]);

  // Measure inline Mermaid stage container width + viewport height for true auto-fit scaling
  useLayoutEffect(() => {
    const el = stageRef.current;
    const syncStageSize = () => {
      if (el) {
        const innerW = Math.max(180, el.clientWidth - 36);
        setStageInnerWidth((prev) => (prev === innerW ? prev : innerW));
      }
      if (typeof window !== "undefined") {
        setViewportHeight((prev) =>
          prev === window.innerHeight ? prev : window.innerHeight
        );
      }
    };
    syncStageSize();

    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(syncStageSize);
      ro.observe(el);
    }
    window.addEventListener("resize", syncStageSize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncStageSize);
    };
  }, [effectiveView, svgHtml]);

  const computeLightboxFitScale = useCallback(() => {
    const vp = lightboxViewportRef.current;
    const availW = vp
      ? Math.max(240, vp.clientWidth - 96)
      : Math.max(240, (typeof window !== "undefined" ? window.innerWidth : 1280) - 112);
    const availH = vp
      ? Math.max(220, vp.clientHeight - 96)
      : Math.max(220, (typeof window !== "undefined" ? window.innerHeight : 800) - 150);
    const ratio = Math.min(
      availW / Math.max(1, naturalSize.width),
      availH / Math.max(1, naturalSize.height),
      1.5
    );
    return Math.max(0.2, Math.min(2.0, Math.round(ratio * 1000) / 1000));
  }, [naturalSize.height, naturalSize.width]);

  // Re-sync fullscreen lightbox auto-fit scale on open & viewport resize
  useLayoutEffect(() => {
    if (!lightboxOpen || !lightboxFit) return;
    const syncFit = () => {
      setLightboxScale(computeLightboxFitScale());
      setLightboxPan({ x: 0, y: 0 });
    };
    syncFit();
    window.addEventListener("resize", syncFit);
    return () => window.removeEventListener("resize", syncFit);
  }, [lightboxOpen, lightboxFit, computeLightboxFitScale]);

  const fitScale = useMemo(() => {
    const maxStageH = Math.max(260, Math.min(680, Math.round(viewportHeight * 0.68)));
    const wRatio = stageInnerWidth > 0 ? stageInnerWidth / naturalSize.width : 1;
    const hRatio = maxStageH / naturalSize.height;
    const raw = Math.min(1, wRatio, hRatio);
    return Math.max(0.15, Math.min(1, Math.round(raw * 1000) / 1000));
  }, [naturalSize.height, naturalSize.width, stageInnerWidth, viewportHeight]);

  const activeScale = fitWidth ? fitScale : zoomPct / 100;
  const displayWidth = Math.max(48, Math.round(naturalSize.width * activeScale));
  const displayHeight = Math.max(32, Math.round(naturalSize.height * activeScale));

  // Auto-resize Mermaid code textarea in `code` or `split` mode
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(150, Math.min(540, ta.scrollHeight + 8))}px`;
  }, [code, effectiveView]);

  const switchViewMode = useCallback(
    (nextMode: MermaidViewMode) => {
      setLocalView(nextMode);
      onChangeView?.(nextMode);
    },
    [onChangeView]
  );

  const handleCopySource = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const temp = document.createElement("textarea");
      temp.value = code;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      document.body.removeChild(temp);
    }
    setCopiedSource(true);
    window.setTimeout(() => setCopiedSource(false), 1800);
  };

  const buildStandaloneSvg = (rawSvg: string): string => {
    let svg = rawSvg.trim();
    if (!/\sxmlns=/.test(svg)) {
      svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!svg.startsWith("<?xml")) {
      svg = `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`;
    }
    return svg;
  };

  const handleExportSvg = async () => {
    if (!svgHtml) return;
    try {
      const payload = buildStandaloneSvg(svgHtml);
      const savedPath = await saveSvgFileDialog(
        `mermaid-diagram-${Date.now()}.svg`,
        payload
      );
      if (savedPath) {
        setExportedSvg(true);
        window.setTimeout(() => setExportedSvg(false), 1800);
      }
    } catch {
      // Ignore user cancellation or restricted download contexts
    }
  };

  const openLightbox = () => {
    if (!svgHtml) return;
    setLightboxFit(true);
    setLightboxScale(computeLightboxFitScale());
    setLightboxPan({ x: 0, y: 0 });
    setLightboxOpen(true);
  };

  const tabSize = Math.max(2, Math.min(8, preferences?.tabSize ?? 2));
  const codeWordWrap = preferences?.codeWordWrap !== false;

  const bindPrimaryFocus = useCallback(
    (node: HTMLElement | null) => {
      focusRef?.(node);
    },
    [focusRef]
  );

  const renderCodeEditorPane = () => (
    <div className="nb-mermaid-code-pane">
      <textarea
        ref={(node) => {
          textareaRef.current = node;
          if (effectiveView !== "preview") {
            bindPrimaryFocus(node);
          }
        }}
        className="nb-mermaid-textarea"
        spellCheck={false}
        style={{
          tabSize,
          whiteSpace: codeWordWrap ? "pre-wrap" : "pre",
          overflowX: codeWordWrap ? "hidden" : "auto",
        }}
        placeholder={`输入 Mermaid 语法，例如：\nflowchart TB\n  A["入口请求"] --> B{"核保规则判定"}\n  B -->|通过| C["自动放行"]`}
        value={code}
        onChange={(e) => onChangeCode?.(e.target.value)}
        onKeyDown={(e) => {
          const ta = e.currentTarget;
          if (
            (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
            matchesActionShortcut(e, "block.insertBelow", preferences?.keybindings)
          ) {
            e.preventDefault();
            e.stopPropagation();
            switchViewMode("preview");
            onExitBelow?.();
            return;
          }
          if (e.key === "Escape" && code.trim().length > 0) {
            e.preventDefault();
            switchViewMode("preview");
            return;
          }
          if (
            e.key === "Backspace" &&
            ta.value.length === 0 &&
            !e.ctrlKey &&
            !e.metaKey
          ) {
            e.preventDefault();
            onConvertEmptyToParagraph?.();
            return;
          }
          if (e.key === "Tab") {
            e.preventDefault();
            const spaces = " ".repeat(tabSize);
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            if (!e.shiftKey) {
              const nextVal =
                ta.value.slice(0, start) + spaces + ta.value.slice(end);
              onChangeCode?.(nextVal);
              window.requestAnimationFrame(() => {
                ta.selectionStart = start + spaces.length;
                ta.selectionEnd = start + spaces.length;
              });
            } else {
              const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
              const slice = ta.value.slice(lineStart, end);
              const unindented = slice.startsWith(spaces)
                ? slice.slice(spaces.length)
                : slice.replace(/^[ \t]{1,2}/, "");
              const delta = slice.length - unindented.length;
              const nextVal =
                ta.value.slice(0, lineStart) + unindented + ta.value.slice(end);
              onChangeCode?.(nextVal);
              window.requestAnimationFrame(() => {
                ta.selectionStart = Math.max(lineStart, start - delta);
                ta.selectionEnd = Math.max(lineStart, end - delta);
              });
            }
          }
        }}
      />
    </div>
  );

  const renderDiagramStage = () => (
    <div
      ref={(node) => {
        stageRef.current = node;
        if (effectiveView === "preview") {
          bindPrimaryFocus(node);
        }
      }}
      tabIndex={effectiveView === "preview" ? 0 : -1}
      className={`nb-mermaid-stage ${fitWidth ? "is-fit-width" : "is-custom-zoom"}`}
      onDoubleClick={() => {
        if (!readOnly && effectiveView === "preview") {
          switchViewMode("split");
        }
      }}
      onKeyDown={(e) => {
        if (readOnly) return;
        if (e.key === "Enter") {
          e.preventDefault();
          switchViewMode("split");
        }
      }}
    >
      {syntaxError && (
        <div className="nb-mermaid-error-banner" role="status">
          <AlertTriangle size={14} className="nb-mermaid-error-icon" />
          <div className="nb-mermaid-error-text">
            <strong>Mermaid 语法提示：</strong>
            <span>{syntaxError}</span>
          </div>
        </div>
      )}

      {svgHtml ? (
        <div
          className="nb-mermaid-svg-canvas"
          style={
            {
              "--mmd-w": `${displayWidth}px`,
              "--mmd-h": `${displayHeight}px`,
            } as React.CSSProperties
          }
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      ) : !syntaxError ? (
        <div className="nb-mermaid-empty-hint">
          <GitBranch size={18} />
          <span>在左侧输入 Mermaid 代码或点击上方「预设模板」一键生成架构图</span>
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className={`nb-mermaid-wrap view-${effectiveView}`}
      data-mermaid-view={effectiveView}
    >
      <div className="nb-mermaid-topbar">
        <div className="nb-mermaid-topbar-left">
          <span className="nb-mermaid-badge">
            <GitBranch size={13} />
            <span>{diagramBadge}</span>
          </span>

          {!readOnly && (
            <div
              className="nb-mermaid-seg"
              role="tablist"
              aria-label="Mermaid 视图模式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={effectiveView === "preview"}
                className={`nb-mermaid-seg-btn ${
                  effectiveView === "preview" ? "is-active" : ""
                }`}
                onClick={() => switchViewMode("preview")}
              >
                <Eye size={12} />
                <span>预览图表</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveView === "split"}
                className={`nb-mermaid-seg-btn ${
                  effectiveView === "split" ? "is-active" : ""
                }`}
                onClick={() => switchViewMode("split")}
              >
                <Columns2 size={12} />
                <span>双栏对照</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveView === "code"}
                className={`nb-mermaid-seg-btn ${
                  effectiveView === "code" ? "is-active" : ""
                }`}
                onClick={() => switchViewMode("code")}
              >
                <Code2 size={12} />
                <span>源码</span>
              </button>
            </div>
          )}
        </div>

        <div className="nb-mermaid-topbar-right">
          {effectiveView !== "code" && svgHtml && (
            <div className="nb-mermaid-zoom-group">
              <button
                type="button"
                className="nb-mermaid-tool-btn is-icon"
                title="缩小图表"
                onClick={() => {
                  const base = fitWidth ? Math.round(activeScale * 100) : zoomPct;
                  setFitWidth(false);
                  setZoomPct(Math.max(25, base - 15));
                }}
              >
                <ZoomOut size={13} />
              </button>
              <button
                type="button"
                className="nb-mermaid-zoom-readout"
                title="点击切换为 100% 原始尺寸"
                onClick={() => {
                  setFitWidth(false);
                  setZoomPct(100);
                }}
              >
                {Math.round(activeScale * 100)}%
              </button>
              <button
                type="button"
                className="nb-mermaid-tool-btn is-icon"
                title="放大图表"
                onClick={() => {
                  const base = fitWidth ? Math.round(activeScale * 100) : zoomPct;
                  setFitWidth(false);
                  setZoomPct(Math.min(300, base + 15));
                }}
              >
                <ZoomIn size={13} />
              </button>
              <button
                type="button"
                aria-pressed={fitWidth}
                className={`nb-mermaid-tool-btn${fitWidth ? " is-active" : ""}`}
                title="自动适配容器可视尺寸（小图保持 1:1 清晰比例，大图自动等比缩放）"
                onClick={() => {
                  setFitWidth(true);
                  setZoomPct(100);
                }}
              >
                自适应
              </button>
              <button
                type="button"
                className="nb-mermaid-tool-btn"
                title="全屏大图查看（支持滚轮缩放与拖拽平移）"
                onClick={openLightbox}
              >
                <Maximize2 size={12} />
                <span>全屏大图</span>
              </button>
            </div>
          )}

          {!readOnly && (
            <div className="nb-mermaid-template-anchor" ref={templateMenuRef}>
              <button
                type="button"
                className="nb-mermaid-tool-btn"
                title="插入常用 Mermaid 架构图模板"
                onClick={() => setTemplatesOpen((v) => !v)}
              >
                <Sparkles size={12} />
                <span>预设模板</span>
              </button>

              {templatesOpen && (
                <div
                  className="nb-mermaid-template-popover"
                  role="menu"
                  aria-label="Mermaid 预设模板"
                >
                  <div className="nb-mermaid-template-title">
                    选择图表模板（点击替换当前源码）
                  </div>
                  {MERMAID_TEMPLATE_PRESETS.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="nb-mermaid-template-item"
                      onClick={() => {
                        onChangeCode?.(tpl.code);
                        setTemplatesOpen(false);
                      }}
                    >
                      <span>{tpl.label}</span>
                      <span className="nb-mermaid-template-tag">
                        {tpl.badge}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className={`nb-mermaid-tool-btn ${copiedSource ? "is-copied" : ""}`}
            title="复制 Mermaid 源码"
            onClick={() => {
              handleCopySource().catch(() => {});
            }}
          >
            {copiedSource ? (
              <>
                <Check size={12} />
                <span>已复制</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>复制源码</span>
              </>
            )}
          </button>

          {svgHtml && (
            <button
              type="button"
              className="nb-mermaid-tool-btn"
              title="导出矢量 SVG 文件"
              onClick={handleExportSvg}
            >
              {exportedSvg ? (
                <>
                  <Check size={12} />
                  <span>已导出</span>
                </>
              ) : (
                <>
                  <Download size={12} />
                  <span>导出 SVG</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {effectiveView === "preview" && renderDiagramStage()}

      {effectiveView === "code" && renderCodeEditorPane()}

      {effectiveView === "split" && (
        <div className="nb-mermaid-split-grid">
          {renderCodeEditorPane()}
          {renderDiagramStage()}
        </div>
      )}

      {lightboxOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="nb-mermaid-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid 全屏架构图查看器"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setLightboxOpen(false);
              }
            }}
          >
            <div className="nb-mermaid-lightbox-bar">
              <div className="nb-mermaid-lightbox-title">
                <GitBranch size={15} />
                <span>{diagramBadge} · 全屏查看（滚轮缩放 / 按住拖拽平移）</span>
              </div>

              <div className="nb-mermaid-lightbox-controls">
                <button
                  type="button"
                  className="nb-mermaid-lightbox-btn"
                  title="缩小"
                  onClick={() => {
                    setLightboxFit(false);
                    setLightboxScale((s) => Math.max(0.2, +(s - 0.2).toFixed(2)));
                  }}
                >
                  <ZoomOut size={14} />
                </button>
                <span className="nb-mermaid-lightbox-scale">
                  {Math.round(lightboxScale * 100)}%
                </span>
                <button
                  type="button"
                  className="nb-mermaid-lightbox-btn"
                  title="放大"
                  onClick={() => {
                    setLightboxFit(false);
                    setLightboxScale((s) => Math.min(4.5, +(s + 0.2).toFixed(2)));
                  }}
                >
                  <ZoomIn size={14} />
                </button>
                <button
                  type="button"
                  aria-pressed={lightboxFit}
                  className={`nb-mermaid-lightbox-btn${lightboxFit ? " is-active" : ""}`}
                  title="自动适配全屏视口尺寸"
                  onClick={() => {
                    setLightboxFit(true);
                    setLightboxScale(computeLightboxFitScale());
                    setLightboxPan({ x: 0, y: 0 });
                  }}
                >
                  <span>自适应</span>
                </button>
                <button
                  type="button"
                  className="nb-mermaid-lightbox-btn"
                  title="重置为 100% 原始大小"
                  onClick={() => {
                    setLightboxFit(false);
                    setLightboxScale(1);
                    setLightboxPan({ x: 0, y: 0 });
                  }}
                >
                  <RotateCcw size={13} />
                  <span>100%</span>
                </button>
                <button
                  type="button"
                  className="nb-mermaid-lightbox-btn"
                  onClick={handleExportSvg}
                >
                  {exportedSvg ? (
                    <>
                      <Check size={13} />
                      <span>已导出</span>
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      <span>导出 SVG</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="nb-mermaid-lightbox-btn is-close"
                  onClick={() => setLightboxOpen(false)}
                >
                  <X size={15} />
                  <span>关闭 (Esc)</span>
                </button>
              </div>
            </div>

            <div
              ref={lightboxViewportRef}
              className={`nb-mermaid-lightbox-viewport ${
                isPanning ? "is-panning" : ""
              }`}
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 0.14 : -0.14;
                setLightboxFit(false);
                setLightboxScale((s) =>
                  Math.max(0.2, Math.min(4.5, +(s + delta).toFixed(2)))
                );
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                setIsPanning(true);
                panStartRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: lightboxPan.x,
                  origY: lightboxPan.y,
                };
              }}
              onMouseMove={(e) => {
                if (!isPanning || !panStartRef.current) return;
                const dx = e.clientX - panStartRef.current.startX;
                const dy = e.clientY - panStartRef.current.startY;
                setLightboxPan({
                  x: panStartRef.current.origX + dx,
                  y: panStartRef.current.origY + dy,
                });
              }}
              onMouseUp={() => {
                setIsPanning(false);
                panStartRef.current = null;
              }}
              onMouseLeave={() => {
                setIsPanning(false);
                panStartRef.current = null;
              }}
            >
              <div
                className="nb-mermaid-lightbox-canvas"
                style={{
                  transform: `translate(${lightboxPan.x}px, ${lightboxPan.y}px) scale(${lightboxScale})`,
                }}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
