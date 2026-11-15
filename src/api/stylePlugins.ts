/**
 * 主题与样式插件 API（桌面端走 Tauri 命令，浏览器预览用 localStorage 模拟）。
 * 从 client.ts 拆出，client.ts 会重新导出这里的全部内容。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  SaveStylePluginInput,
  StylePluginItem,
  StylePluginState,
  ThemeTokens,
} from "../types/notion";
import { isTauriRuntime, loadBrowserStorageConfig, loadStore, nowIso } from "./client";

/* ============================================================================
 * Commercial v0.3.0 — Portable Theme & Shareable Style Plugins API + Fallback
 * ========================================================================== */

const BROWSER_STYLE_PLUGINS_KEY = "notion_desktop_style_plugins_v030";

interface BrowserStylePluginStore {
  activeThemeId: string;
  customCssGlobal: string;
  plugins: StylePluginItem[];
}

function buildSeededBrowserStylePlugins(
  themesDir: string,
  snippetsDir: string
): StylePluginItem[] {
  const ts = "2026-11-14T18:00:00.000Z";
  return [
    {
      id: "github-tech",
      kind: "theme",
      name: "GitHub 经典技术白",
      author: "XyNote Official",
      version: "1.0.0",
      description: "清爽严谨的 GitHub 文档视觉体系，带 H1/H2 章节底部分隔线与柔和代码块底色",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "github-tech.xynote-theme.json",
      filePath: `${themesDir}\\github-tech.xynote-theme.json`,
      tokens: {
        bgPrimary: "#ffffff",
        bgSecondary: "#f6f8fa",
        bgSidebar: "#f6f8fa",
        bgHover: "rgba(31, 35, 40, 0.06)",
        bgElevated: "#ffffff",
        textPrimary: "#24292f",
        textSecondary: "#57606a",
        textMuted: "#6e7781",
        borderColor: "#d0d7de",
        accentColor: "#0969da",
        codeInlineColor: "#cf222e",
        codeInlineBg: "rgba(175, 184, 193, 0.2)",
        codeBlockBg: "#f6f8fa",
        tableHeaderBg: "#f6f8fa",
        calloutBg: "#ddf4ff",
        selectionBg: "rgba(9, 105, 218, 0.18)",
        radiusMd: "6px",
      },
      customCss:
        ".nb-editor-h1, .nb-editor-h2 { padding-bottom: 0.28em; border-bottom: 1px solid var(--border-color); }",
      updatedAt: ts,
    },
    {
      id: "dracula-dark",
      kind: "theme",
      name: "Dracula 暗夜极客紫",
      author: "XyNote Official",
      version: "1.0.0",
      description: "经典 Dracula 极客暗色配色，高对比紫粉语法点缀，夜间编码与架构设计首选",
      baseMode: "dark",
      enabled: false,
      builtin: true,
      fileName: "dracula-dark.xynote-theme.json",
      filePath: `${themesDir}\\dracula-dark.xynote-theme.json`,
      tokens: {
        bgPrimary: "#282a36",
        bgSecondary: "#21222c",
        bgSidebar: "#21222c",
        bgHover: "rgba(248, 248, 242, 0.07)",
        bgElevated: "#313442",
        textPrimary: "#f8f8f2",
        textSecondary: "#c5c8d9",
        textMuted: "#8be9fd",
        borderColor: "#44475a",
        accentColor: "#bd93f9",
        codeInlineColor: "#ff79c6",
        codeInlineBg: "rgba(255, 121, 198, 0.14)",
        codeBlockBg: "#1e1f29",
        tableHeaderBg: "#21222c",
        calloutBg: "rgba(189, 147, 249, 0.12)",
        selectionBg: "rgba(189, 147, 249, 0.28)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "nord-dark",
      kind: "theme",
      name: "Nord 极地冰川蓝",
      author: "XyNote Official",
      version: "1.0.0",
      description: "北欧极地冷峻蓝灰调，柔和低眩光对比度，长时间沉浸阅读不刺眼",
      baseMode: "dark",
      enabled: false,
      builtin: true,
      fileName: "nord-dark.xynote-theme.json",
      filePath: `${themesDir}\\nord-dark.xynote-theme.json`,
      tokens: {
        bgPrimary: "#2e3440",
        bgSecondary: "#272c36",
        bgSidebar: "#272c36",
        bgHover: "rgba(236, 239, 244, 0.06)",
        bgElevated: "#3b4252",
        textPrimary: "#eceff4",
        textSecondary: "#d8dee9",
        textMuted: "#81a1c1",
        borderColor: "#434c5e",
        accentColor: "#88c0d0",
        codeInlineColor: "#a3be8c",
        codeInlineBg: "rgba(136, 192, 208, 0.14)",
        codeBlockBg: "#242933",
        tableHeaderBg: "#3b4252",
        calloutBg: "rgba(136, 192, 208, 0.12)",
        selectionBg: "rgba(136, 192, 208, 0.26)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "ink-editorial",
      kind: "theme",
      name: "墨韵书卷 (东方人文)",
      author: "XyNote Official",
      version: "1.0.0",
      description: "温润宣纸底色配朱砂印泥点缀与人文衬线标题，适合深度长文、读书笔记与随笔创作",
      baseMode: "sepia",
      enabled: false,
      builtin: true,
      fileName: "ink-editorial.xynote-theme.json",
      filePath: `${themesDir}\\ink-editorial.xynote-theme.json`,
      tokens: {
        bgPrimary: "#faf6ee",
        bgSecondary: "#f2ecdf",
        bgSidebar: "#f2ecdf",
        bgHover: "rgba(43, 38, 35, 0.05)",
        bgElevated: "#fffcf6",
        textPrimary: "#2b2623",
        textSecondary: "#5e554d",
        textMuted: "#8c8177",
        borderColor: "rgba(43, 38, 35, 0.12)",
        accentColor: "#b83b2a",
        codeInlineColor: "#b83b2a",
        codeInlineBg: "rgba(184, 59, 42, 0.09)",
        codeBlockBg: "#f3ede2",
        tableHeaderBg: "#f2ecdf",
        calloutBg: "#f5efe2",
        selectionBg: "rgba(184, 59, 42, 0.18)",
        radiusMd: "6px",
      },
      customCss:
        ".nb-editor-h1, .nb-editor-h2, .nb-editor-h3, .nb-page-title-input { font-family: var(--font-serif); letter-spacing: 0.01em; }",
      updatedAt: ts,
    },
    {
      id: "meadow-green",
      kind: "theme",
      name: "清风豆沙护眼绿",
      author: "XyNote Official",
      version: "1.0.0",
      description: "柔和鼠尾草豆沙绿纸面，缓解屏幕蓝光疲劳，适合全天候知识整理",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "meadow-green.xynote-theme.json",
      filePath: `${themesDir}\\meadow-green.xynote-theme.json`,
      tokens: {
        bgPrimary: "#edf5ee",
        bgSecondary: "#e3eee5",
        bgSidebar: "#e3eee5",
        bgHover: "rgba(36, 51, 40, 0.06)",
        bgElevated: "#f5faf6",
        textPrimary: "#243328",
        textSecondary: "#4b6352",
        textMuted: "#748c7b",
        borderColor: "rgba(36, 51, 40, 0.12)",
        accentColor: "#2e7d5b",
        codeInlineColor: "#1f6848",
        codeInlineBg: "rgba(46, 125, 91, 0.12)",
        codeBlockBg: "#e4efe6",
        tableHeaderBg: "#e3eee5",
        calloutBg: "#e1efe4",
        selectionBg: "rgba(46, 125, 91, 0.2)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "colorful-headings",
      kind: "snippet",
      name: "多彩分级标题侧边条",
      author: "XyNote Official",
      version: "1.0.0",
      description: "为 H1 / H2 / H3 标题添加鲜明的左侧彩色竖条与微底色，一眼区分文档层级结构",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "colorful-headings.css",
      filePath: `${snippetsDir}\\colorful-headings.css`,
      tokens: {},
      customCss: [
        "/* @name: 多彩分级标题侧边条 */",
        ".nb-editor-h1 {",
        "  border-left: 4px solid var(--accent-color, #2383e2);",
        "  padding-left: 12px;",
        "  background: linear-gradient(90deg, rgba(35, 131, 226, 0.08), transparent 72%);",
        "  border-radius: 0 6px 6px 0;",
        "}",
        ".nb-editor-h2 {",
        "  border-left: 3.5px solid #0f9d58;",
        "  padding-left: 10px;",
        "  background: linear-gradient(90deg, rgba(15, 157, 88, 0.07), transparent 65%);",
        "  border-radius: 0 6px 6px 0;",
        "}",
        ".nb-editor-h3 {",
        "  border-left: 3px solid #e67c23;",
        "  padding-left: 9px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "academic-numbering",
      kind: "snippet",
      name: "学术文档标题自动编号 (1. / 1.1 / 1.1.1)",
      author: "XyNote Official",
      version: "1.0.0",
      description: "基于纯 CSS 计数器自动为 H1 / H2 / H3 生成严谨的多级章节序号，无需手写维护",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "academic-numbering.css",
      filePath: `${snippetsDir}\\academic-numbering.css`,
      tokens: {},
      customCss: [
        "/* @name: 学术文档标题自动编号 (1. / 1.1 / 1.1.1) */",
        ".nb-editor-root, .nb-editor-canvas {",
        "  counter-reset: nb-sec-h1;",
        "}",
        ".nb-editor-h1 {",
        "  counter-increment: nb-sec-h1;",
        "  counter-reset: nb-sec-h2;",
        "}",
        ".nb-editor-h1::before {",
        "  content: counter(nb-sec-h1) \". \";",
        "  color: var(--accent-color, #2383e2);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 4px;",
        "}",
        ".nb-editor-h2 {",
        "  counter-increment: nb-sec-h2;",
        "  counter-reset: nb-sec-h3;",
        "}",
        ".nb-editor-h2::before {",
        "  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \" \";",
        "  color: var(--accent-color, #2383e2);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 6px;",
        "}",
        ".nb-editor-h3 {",
        "  counter-increment: nb-sec-h3;",
        "}",
        ".nb-editor-h3::before {",
        "  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \".\" counter(nb-sec-h3) \" \";",
        "  color: var(--text-secondary);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 6px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "dot-grid-canvas",
      kind: "snippet",
      name: "工程师点阵网格信纸背景",
      author: "XyNote Official",
      version: "1.0.0",
      description: "在编辑画布铺设细腻低对比度手帐点阵网格，提升架构草图与技术笔记质感",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "dot-grid-canvas.css",
      filePath: `${snippetsDir}\\dot-grid-canvas.css`,
      tokens: {},
      customCss: [
        "/* @name: 工程师点阵网格信纸背景 */",
        ".nb-page-scroll, .page-scroll-container {",
        "  background-image: radial-gradient(var(--border-strong, rgba(55, 53, 47, 0.16)) 1px, transparent 1px);",
        "  background-size: 20px 20px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "mac-code-window",
      kind: "snippet",
      name: "Mac 窗口三色圆点代码块",
      author: "XyNote Official",
      version: "1.0.0",
      description: "为代码块顶部工具栏注入 macOS 红黄绿窗口圆点装饰与精致立体阴影",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "mac-code-window.css",
      filePath: `${snippetsDir}\\mac-code-window.css`,
      tokens: {},
      customCss: [
        "/* @name: Mac 窗口三色圆点代码块 */",
        ".nb-editor-code-wrap {",
        "  border-radius: 10px !important;",
        "  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);",
        "}",
        ".nb-editor-code-topbar::before {",
        "  content: \"\";",
        "  display: inline-block;",
        "  width: 11px;",
        "  height: 11px;",
        "  border-radius: 50%;",
        "  background: #ff5f56;",
        "  box-shadow: 18px 0 0 #ffbd2e, 36px 0 0 #27c93f;",
        "  margin-right: 44px;",
        "  flex-shrink: 0;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "compact-dense-table",
      kind: "snippet",
      name: "高密度斑马纹技术表格",
      author: "XyNote Official",
      version: "1.0.0",
      description: "紧凑化数据表格内边距并启用奇偶行交替斑马纹底色，适合大型接口字典与配置表",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "compact-dense-table.css",
      filePath: `${snippetsDir}\\compact-dense-table.css`,
      tokens: {},
      customCss: [
        "/* @name: 高密度斑马纹技术表格 */",
        ".nb-editor-table th, .nb-editor-table td {",
        "  padding: 5px 10px !important;",
        "  font-size: 13px !important;",
        "}",
        ".nb-editor-table tbody tr:nth-child(even) td {",
        "  background: var(--bg-hover, rgba(55, 53, 47, 0.03));",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
  ];
}

function getBrowserPluginDirs(): {
  pluginsDir: string;
  themesDir: string;
  snippetsDir: string;
} {
  const cfg = loadBrowserStorageConfig();
  const base = cfg.activeDataDir.replace(/[\\/]+$/, "");
  const pluginsDir = `${base}\\plugins`;
  return {
    pluginsDir,
    themesDir: `${pluginsDir}\\themes`,
    snippetsDir: `${pluginsDir}\\snippets`,
  };
}

function loadBrowserStylePluginStore(): BrowserStylePluginStore {
  const dirs = getBrowserPluginDirs();
  try {
    const raw = localStorage.getItem(BROWSER_STYLE_PLUGINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BrowserStylePluginStore;
      if (parsed && Array.isArray(parsed.plugins) && parsed.plugins.length > 0) {
        return {
          activeThemeId: parsed.activeThemeId || "light",
          customCssGlobal: parsed.customCssGlobal || "",
          plugins: parsed.plugins,
        };
      }
    }
  } catch {
    // Re-seed on parse failure
  }
  const store = loadStore();
  const initialTheme =
    store.settings.theme === "dark" ||
    store.settings.theme === "sepia" ||
    store.settings.theme === "system"
      ? store.settings.theme
      : "light";
  const seeded: BrowserStylePluginStore = {
    activeThemeId: initialTheme,
    customCssGlobal: "",
    plugins: buildSeededBrowserStylePlugins(dirs.themesDir, dirs.snippetsDir),
  };
  saveBrowserStylePluginStore(seeded);
  return seeded;
}

function saveBrowserStylePluginStore(data: BrowserStylePluginStore): void {
  try {
    localStorage.setItem(BROWSER_STYLE_PLUGINS_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage quota issues
  }
}

function toStylePluginState(data: BrowserStylePluginStore): StylePluginState {
  const dirs = getBrowserPluginDirs();
  return {
    pluginsDir: dirs.pluginsDir,
    themesDir: dirs.themesDir,
    snippetsDir: dirs.snippetsDir,
    activeThemeId: data.activeThemeId,
    plugins: data.plugins.map((p) => ({
      ...p,
      tokens: { ...(p.tokens || {}) },
    })),
    customCssGlobal: data.customCssGlobal || "",
  };
}

function slugifyPluginId(rawName: string, fallbackPrefix = "plugin"): string {
  const ascii = rawName
    .trim()
    .toLowerCase()
    .replace(/\.((xynote|notion)-theme\.json|json|css)$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `${fallbackPrefix}-${Date.now().toString(36)}`;
}

function parseCssPluginMetadata(
  filename: string,
  cssText: string
): SaveStylePluginInput {
  const stem = filename
    .replace(/^.*[\\/]/, "")
    .replace(/\.((xynote|notion)-theme\.json|theme\.css|css|json)$/i, "")
    .trim();
  const meta: Record<string, string> = {};
  const headerMatch = cssText.match(/\/\*([\s\S]*?)\*\//);
  if (headerMatch) {
    const lines = headerMatch[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/@([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
      if (m) {
        meta[m[1].toLowerCase()] = m[2].trim();
      }
    }
  }
  const kindRaw = (meta.kind || "").toLowerCase();
  const isTheme =
    kindRaw === "theme" || /\.theme\.css$/i.test(filename);
  const modeRaw = (meta.mode || meta.basemode || "light").toLowerCase();
  const baseMode: "light" | "dark" | "sepia" =
    modeRaw === "dark" ? "dark" : modeRaw === "sepia" ? "sepia" : "light";

  return {
    id: meta.id ? slugifyPluginId(meta.id) : slugifyPluginId(stem || "custom-style"),
    kind: isTheme ? "theme" : "snippet",
    name: meta.name || stem || "外部样式插件",
    author: meta.author || "Community",
    version: meta.version || "1.0.0",
    description: meta.description || `从 ${filename} 导入的样式插件`,
    baseMode,
    enabled: true,
    tokens: {},
    customCss: cssText,
  };
}

function notifyStylePluginsChanged(): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent("notion-style-plugins-changed"));
  }
}

export async function listStylePlugins(): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    return invoke<StylePluginState>("list_style_plugins");
  }
  return toStylePluginState(loadBrowserStylePluginStore());
}

export async function saveStylePlugin(
  input: SaveStylePluginInput
): Promise<StylePluginItem> {
  if (isTauriRuntime()) {
    const saved = await invoke<StylePluginItem>("save_style_plugin", { input });
    notifyStylePluginsChanged();
    return saved;
  }
  const data = loadBrowserStylePluginStore();
  const dirs = getBrowserPluginDirs();
  const ts = nowIso();
  const targetId = input.id?.trim()
    ? slugifyPluginId(input.id)
    : slugifyPluginId(input.name, input.kind);

  const existingIdx = data.plugins.findIndex((p) => p.id === targetId);
  const existing = existingIdx >= 0 ? data.plugins[existingIdx] : null;
  const kind = input.kind ?? existing?.kind ?? "snippet";
  const baseMode = input.baseMode ?? existing?.baseMode ?? "light";
  const ext = kind === "theme" ? ".xynote-theme.json" : ".css";
  const fileName = existing?.fileName ?? `${targetId}${ext}`;
  const filePath =
    existing?.filePath ??
    `${kind === "theme" ? dirs.themesDir : dirs.snippetsDir}\\${fileName}`;

  const enabled =
    input.enabled !== undefined
      ? input.enabled
      : existing
      ? existing.enabled
      : true;

  const item: StylePluginItem = {
    id: targetId,
    kind,
    name: input.name?.trim() || existing?.name || "未命名样式插件",
    author: input.author?.trim() || existing?.author || "Custom User",
    version: input.version?.trim() || existing?.version || "1.0.0",
    description: input.description?.trim() ?? existing?.description ?? "",
    baseMode,
    enabled,
    builtin: existing?.builtin ?? false,
    fileName,
    filePath,
    tokens: input.tokens ? { ...input.tokens } : { ...(existing?.tokens || {}) },
    customCss: input.customCss ?? existing?.customCss ?? "",
    updatedAt: ts,
  };

  if (existingIdx >= 0) {
    data.plugins[existingIdx] = item;
  } else {
    data.plugins.push(item);
  }

  if (item.kind === "theme" && item.enabled) {
    for (const p of data.plugins) {
      if (p.kind === "theme" && p.id !== item.id) {
        p.enabled = false;
      }
    }
    data.activeThemeId = `plugin:${item.id}`;
  }

  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return { ...item, tokens: { ...item.tokens } };
}

export async function toggleStylePlugin(
  id: string,
  enabled: boolean
): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    const updated = await invoke<StylePluginState>("toggle_style_plugin", {
      id,
      enabled,
    });
    notifyStylePluginsChanged();
    return updated;
  }
  const data = loadBrowserStylePluginStore();

  if (id === "light" || id === "dark" || id === "sepia" || id === "system") {
    if (enabled) {
      data.activeThemeId = id;
      for (const p of data.plugins) {
        if (p.kind === "theme") {
          p.enabled = false;
        }
      }
    }
    saveBrowserStylePluginStore(data);
    notifyStylePluginsChanged();
    return toStylePluginState(data);
  }

  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const target = data.plugins.find((p) => p.id === cleanId);
  if (!target) {
    throw new Error(`未找到样式插件 (${cleanId})`);
  }

  if (target.kind === "theme") {
    if (enabled) {
      for (const p of data.plugins) {
        if (p.kind === "theme") {
          p.enabled = p.id === cleanId;
        }
      }
      data.activeThemeId = `plugin:${cleanId}`;
    } else {
      target.enabled = false;
      if (data.activeThemeId === `plugin:${cleanId}`) {
        data.activeThemeId = "light";
      }
    }
  } else {
    target.enabled = enabled;
  }

  target.updatedAt = nowIso();
  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return toStylePluginState(data);
}

export async function deleteStylePlugin(id: string): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    const updated = await invoke<StylePluginState>("delete_style_plugin", { id });
    notifyStylePluginsChanged();
    return updated;
  }
  const data = loadBrowserStylePluginStore();
  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const target = data.plugins.find((p) => p.id === cleanId);
  if (!target) {
    throw new Error(`未找到要删除的插件 (${cleanId})`);
  }
  if (target.builtin) {
    throw new Error("内置预设主题与官方样式插件不可删除，可直接关闭启用开关");
  }
  data.plugins = data.plugins.filter((p) => p.id !== cleanId);
  if (data.activeThemeId === `plugin:${cleanId}`) {
    data.activeThemeId = "light";
  }
  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return toStylePluginState(data);
}

export async function importStylePluginContent(
  filename: string,
  content: string
): Promise<StylePluginItem> {
  if (isTauriRuntime()) {
    const imported = await invoke<StylePluginItem>(
      "import_style_plugin_content",
      {
        filename,
        content,
      }
    );
    notifyStylePluginsChanged();
    return imported;
  }
  const trimmed = content.trim();
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".json") || trimmed.startsWith("{")) {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const kind: "theme" | "snippet" =
      raw.kind === "snippet" ? "snippet" : "theme";
    const rawMode = String(raw.baseMode ?? raw.base_mode ?? "light").toLowerCase();
    const baseMode: "light" | "dark" | "sepia" =
      rawMode === "dark" ? "dark" : rawMode === "sepia" ? "sepia" : "light";
    const tokens =
      raw.tokens && typeof raw.tokens === "object"
        ? (raw.tokens as ThemeTokens)
        : {};
    const stem = filename
      .replace(/^.*[\\/]/, "")
      .replace(/\.((xynote|notion)-theme\.json|json)$/i, "");
    return saveStylePlugin({
      id: typeof raw.id === "string" ? raw.id : slugifyPluginId(stem || "imported-theme"),
      kind,
      name:
        typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : stem || "导入主题插件",
      author: typeof raw.author === "string" ? raw.author : "Community",
      version: typeof raw.version === "string" ? raw.version : "1.0.0",
      description:
        typeof raw.description === "string"
          ? raw.description
          : `从 ${filename} 导入的主题插件`,
      baseMode,
      enabled: raw.enabled !== false,
      tokens,
      customCss:
        typeof raw.customCss === "string"
          ? raw.customCss
          : typeof raw.custom_css === "string"
          ? raw.custom_css
          : "",
    });
  }

  const parsedCssInput = parseCssPluginMetadata(filename, content);
  return saveStylePlugin(parsedCssInput);
}

export async function importStylePluginDialog(): Promise<StylePluginItem | null> {
  if (isTauriRuntime()) {
    const imported = await invoke<StylePluginItem | null>(
      "import_style_plugin_dialog"
    );
    if (imported) {
      notifyStylePluginsChanged();
    }
    return imported;
  }
  if (typeof document === "undefined") return null;
  return new Promise<StylePluginItem | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".css,.json,.xynote-theme.json";
    input.style.display = "none";
    let settled = false;
    const cleanup = () => {
      input.remove();
    };
    input.addEventListener("change", async () => {
      if (settled) return;
      settled = true;
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const imported = await importStylePluginContent(file.name, text);
        resolve(imported);
      } catch {
        resolve(null);
      }
    });
    input.addEventListener("cancel", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function exportStylePluginDialog(
  id: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("export_style_plugin_dialog", { id });
  }
  const data = loadBrowserStylePluginStore();
  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const plugin = data.plugins.find((p) => p.id === cleanId);
  if (!plugin) {
    throw new Error(`未找到样式插件 (${cleanId})`);
  }

  let exportFilename = plugin.fileName;
  let payloadText = "";
  let mime = "text/plain;charset=utf-8";

  if (plugin.kind === "theme") {
    if (!exportFilename.endsWith(".json")) {
      exportFilename = `${plugin.id}.xynote-theme.json`;
    }
    mime = "application/json;charset=utf-8";
    payloadText = JSON.stringify(
      {
        id: plugin.id,
        kind: "theme",
        name: plugin.name,
        author: plugin.author,
        version: plugin.version,
        description: plugin.description,
        baseMode: plugin.baseMode,
        tokens: plugin.tokens,
        customCss: plugin.customCss,
      },
      null,
      2
    );
  } else {
    if (!exportFilename.endsWith(".css")) {
      exportFilename = `${plugin.id}.css`;
    }
    mime = "text/css;charset=utf-8";
    const hasHeader = /\/\*[\s\S]*?@name\s*:/.test(plugin.customCss);
    const header = hasHeader
      ? ""
      : [
          "/*",
          ` * @name: ${plugin.name}`,
          ` * @author: ${plugin.author}`,
          ` * @version: ${plugin.version}`,
          ` * @description: ${plugin.description}`,
          ` * @kind: snippet`,
          ` * @mode: ${plugin.baseMode}`,
          " */",
          "",
        ].join("\n");
    payloadText = `${header}${plugin.customCss}`;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const blob = new Blob([payloadText], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ignore headless download restrictions
    }
  }

  return exportFilename;
}

export async function saveSvgFileDialog(
  defaultName: string,
  content: string
): Promise<string | null> {
  const cleanName = defaultName.trim().toLowerCase().endsWith(".svg")
    ? defaultName.trim()
    : `${defaultName.trim() || "mermaid-diagram"}.svg`;

  if (isTauriRuntime()) {
    return invoke<string | null>("save_svg_file_dialog", {
      defaultName: cleanName,
      content,
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const blob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cleanName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return cleanName;
  }

  return null;
}
