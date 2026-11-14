import type {
  StylePluginItem,
  StylePluginState,
  ThemeTokens,
} from "../../types/notion";
import type { ThemeMode } from "./Topbar";
import type { ThemePreference } from "./SettingsModal";

export const THEME_TOKENS_STYLE_ID = "notion-active-theme-tokens";
export const STYLE_PLUGINS_STYLE_ID = "notion-active-style-plugins";

function ensureHeadStyleElement(id: string): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  } else if (el.parentElement === document.head && document.head.lastElementChild !== el) {
    // Keep runtime theme/plugin styles at the end of <head> so they always override static bundle defaults
    document.head.appendChild(el);
  }
  return el;
}

export function getActiveThemePlugin(
  state: StylePluginState | null
): StylePluginItem | null {
  if (!state) return null;
  if (state.activeThemeId && state.activeThemeId.startsWith("plugin:")) {
    const pluginId = state.activeThemeId.slice("plugin:".length);
    const matched = state.plugins.find(
      (p) => p.kind === "theme" && p.id === pluginId
    );
    if (matched) return matched;
  }
  const fallbackEnabled = state.plugins.find(
    (p) => p.kind === "theme" && p.enabled
  );
  return fallbackEnabled ?? null;
}

export function resolveEffectiveBaseMode(
  state: StylePluginState | null,
  themePref: ThemePreference,
  systemDark: boolean
): ThemeMode {
  const activePlugin = getActiveThemePlugin(state);
  if (activePlugin) {
    return activePlugin.baseMode;
  }
  const modeCandidate =
    state?.activeThemeId === "light" ||
    state?.activeThemeId === "dark" ||
    state?.activeThemeId === "sepia" ||
    state?.activeThemeId === "system"
      ? state.activeThemeId
      : themePref;
  if (modeCandidate === "system") {
    return systemDark ? "dark" : "light";
  }
  return modeCandidate;
}

export function buildThemeTokensCss(tokens?: ThemeTokens | null): string {
  if (!tokens) return "";
  const lines: string[] = [];
  const push = (varName: string, val?: string) => {
    const trimmed = val?.trim();
    if (trimmed) {
      lines.push(`  ${varName}: ${trimmed};`);
    }
  };

  push("--bg-primary", tokens.bgPrimary);
  push("--bg-secondary", tokens.bgSecondary);
  push("--bg-sidebar", tokens.bgSidebar ?? tokens.bgSecondary);
  push("--bg-subtle", tokens.bgSecondary);
  push("--bg-hover", tokens.bgHover);
  push("--bg-elevated", tokens.bgElevated ?? tokens.bgPrimary);
  push("--bg-modal", tokens.bgElevated ?? tokens.bgPrimary);
  push("--bg-code", tokens.codeBlockBg ?? tokens.bgSecondary);

  push("--text-primary", tokens.textPrimary);
  push("--text-secondary", tokens.textSecondary);
  push("--text-muted", tokens.textMuted);
  push("--text-tertiary", tokens.textMuted ?? tokens.textSecondary);

  push("--border-color", tokens.borderColor);
  push("--accent-color", tokens.accentColor);

  push("--code-inline-fg", tokens.codeInlineColor);
  push("--code-inline-bg", tokens.codeInlineBg);
  push("--code-block-bg", tokens.codeBlockBg);
  push("--table-header-bg", tokens.tableHeaderBg);
  push("--callout-bg", tokens.calloutBg);
  push("--selection-bg", tokens.selectionBg);

  push("--font-sans", tokens.fontSans);
  push("--font-serif", tokens.fontSerif);
  push("--font-mono", tokens.fontMono);
  push("--radius-md", tokens.radiusMd);

  if (lines.length === 0) return "";

  const selector = [
    ":root",
    '[data-theme="light"]',
    '[data-theme="dark"]',
    '[data-theme="sepia"]',
    ".theme-light",
    ".theme-dark",
    ".theme-sepia",
  ].join(",\n");

  const selectionRule = tokens.selectionBg?.trim()
    ? `\n::selection {\n  background: ${tokens.selectionBg.trim()};\n}`
    : "";

  return `${selector} {\n${lines.join("\n")}\n}${selectionRule}\n`;
}

export function applyRuntimeStylePluginsToDom(
  state: StylePluginState | null,
  previewOverride?: {
    baseMode?: ThemeMode;
    tokens?: ThemeTokens | null;
    extraCss?: string;
  } | null
): void {
  const tokenStyleEl = ensureHeadStyleElement(THEME_TOKENS_STYLE_ID);
  const pluginStyleEl = ensureHeadStyleElement(STYLE_PLUGINS_STYLE_ID);
  if (!tokenStyleEl || !pluginStyleEl) return;

  const activeTheme = getActiveThemePlugin(state);
  const effectiveTokens = previewOverride?.tokens ?? activeTheme?.tokens ?? null;
  tokenStyleEl.textContent = buildThemeTokensCss(effectiveTokens);

  const cssBlocks: string[] = [];
  if (activeTheme?.customCss?.trim()) {
    cssBlocks.push(
      `/* [Theme Plugin: ${activeTheme.id}] */\n${activeTheme.customCss.trim()}`
    );
  }

  if (state?.plugins) {
    for (const p of state.plugins) {
      if (p.kind === "snippet" && p.enabled && p.customCss?.trim()) {
        cssBlocks.push(
          `/* [Style Snippet: ${p.id}] */\n${p.customCss.trim()}`
        );
      }
    }
  }

  if (state?.customCssGlobal?.trim()) {
    cssBlocks.push(`/* [Global Custom CSS] */\n${state.customCssGlobal.trim()}`);
  }

  if (previewOverride?.extraCss?.trim()) {
    cssBlocks.push(
      `/* [Theme Builder Live Preview] */\n${previewOverride.extraCss.trim()}`
    );
  }

  pluginStyleEl.textContent = cssBlocks.join("\n\n");
}
