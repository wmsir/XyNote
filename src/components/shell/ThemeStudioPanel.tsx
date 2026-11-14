import React, { useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  Code2,
  Download,
  Edit3,
  FolderOpen,
  Monitor,
  Moon,
  Palette,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import {
  deleteStylePlugin,
  exportStylePluginDialog,
  importStylePluginContent,
  importStylePluginDialog,
  isTauriRuntime,
  openPathInExplorer,
  saveStylePlugin,
  toggleStylePlugin,
} from "../../api/client";
import type {
  StylePluginItem,
  StylePluginState,
  ThemeTokens,
} from "../../types/notion";
import type { ThemePreference } from "./SettingsModal";
import type { ThemeMode } from "./Topbar";

export interface ThemeStudioPanelProps {
  styleState: StylePluginState | null;
  themePref: ThemePreference;
  onStyleStateChange: (nextState: StylePluginState) => void;
  onSelectBuiltinTheme: (mode: ThemePreference) => Promise<void> | void;
  onPreviewThemeOverride: (
    override: {
      baseMode?: ThemeMode;
      tokens?: ThemeTokens | null;
      extraCss?: string;
    } | null
  ) => void;
  onRefreshPlugins: () => Promise<StylePluginState | null>;
  onNotify: (msg: string) => void;
}

interface TokenFieldSpec {
  key: keyof ThemeTokens;
  label: string;
  fallbackHex: string;
}

const TOKEN_FIELDS: TokenFieldSpec[] = [
  { key: "bgPrimary", label: "主画布背景 (bgPrimary)", fallbackHex: "#ffffff" },
  { key: "bgSidebar", label: "侧边栏背景 (bgSidebar)", fallbackHex: "#f7f7f5" },
  { key: "bgSecondary", label: "次级区块背景 (bgSecondary)", fallbackHex: "#f1f1ef" },
  { key: "bgElevated", label: "弹窗浮层背景 (bgElevated)", fallbackHex: "#ffffff" },
  { key: "textPrimary", label: "正文主文字色 (textPrimary)", fallbackHex: "#37352f" },
  { key: "textSecondary", label: "次级说明文字 (textSecondary)", fallbackHex: "#787774" },
  { key: "accentColor", label: "品牌强调主色 (accentColor)", fallbackHex: "#2383e2" },
  { key: "borderColor", label: "分隔边框颜色 (borderColor)", fallbackHex: "#e5e5e3" },
  { key: "codeInlineColor", label: "行内代码字色 (codeInlineColor)", fallbackHex: "#eb5757" },
  { key: "codeBlockBg", label: "代码块底色 (codeBlockBg)", fallbackHex: "#f7f6f3" },
  { key: "tableHeaderBg", label: "表格表头底色 (tableHeaderBg)", fallbackHex: "#f7f6f3" },
  { key: "calloutBg", label: "高亮提示块底色 (calloutBg)", fallbackHex: "#f1f1ef" },
];

const DEFAULT_BUILDER_TOKENS_LIGHT: ThemeTokens = {
  bgPrimary: "#fffdf9",
  bgSidebar: "#f5f1e8",
  bgSecondary: "#f5f1e8",
  bgElevated: "#ffffff",
  textPrimary: "#2c2825",
  textSecondary: "#6e665e",
  borderColor: "rgba(44, 40, 37, 0.12)",
  accentColor: "#c95d3f",
  codeInlineColor: "#b84225",
  codeInlineBg: "rgba(201, 93, 63, 0.11)",
  codeBlockBg: "#f6f2ea",
  tableHeaderBg: "#f3eee4",
  calloutBg: "#f9f4eb",
};

function toHexPickerSafe(val: string | undefined, fallback: string): string {
  if (!val) return fallback;
  const trimmed = val.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

const BASE_MODE_LABEL: Record<"light" | "dark" | "sepia", string> = {
  light: "浅色基调",
  dark: "深色基调",
  sepia: "暖色基调",
};

export const ThemeStudioPanel: React.FC<ThemeStudioPanelProps> = ({
  styleState,
  themePref,
  onStyleStateChange,
  onSelectBuiltinTheme,
  onPreviewThemeOverride,
  onRefreshPlugins,
  onNotify,
}) => {
  const browserPluginInputRef = useRef<HTMLInputElement | null>(null);

  // Visual Theme Builder State
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderEditId, setBuilderEditId] = useState<string | null>(null);
  const [builderName, setBuilderName] = useState("我的专属主题");
  const [builderAuthor, setBuilderAuthor] = useState("Custom Studio");
  const [builderDesc, setBuilderDesc] = useState("自定义桌面阅读与代码高亮配色方案");
  const [builderBaseMode, setBuilderBaseMode] = useState<"light" | "dark" | "sepia">("light");
  const [builderTokens, setBuilderTokens] = useState<ThemeTokens>({
    ...DEFAULT_BUILDER_TOKENS_LIGHT,
  });
  const [builderCustomCss, setBuilderCustomCss] = useState("");
  const [livePreview, setLivePreview] = useState(true);

  // CSS Snippet Editor State
  const [snippetEditorOpen, setSnippetEditorOpen] = useState(false);
  const [snippetEditId, setSnippetEditId] = useState<string | null>(null);
  const [snippetName, setSnippetName] = useState("");
  const [snippetDesc, setSnippetDesc] = useState("");
  const [snippetCss, setSnippetCss] = useState("");
  const [showCheatSheet, setShowCheatSheet] = useState(false);

  const themePlugins = useMemo(
    () => (styleState?.plugins ?? []).filter((p) => p.kind === "theme"),
    [styleState]
  );

  const snippetPlugins = useMemo(
    () => (styleState?.plugins ?? []).filter((p) => p.kind === "snippet"),
    [styleState]
  );

  const activeThemeId = styleState?.activeThemeId || themePref;

  const syncLivePreview = (
    nextOpen: boolean,
    nextPreview: boolean,
    nextBaseMode: "light" | "dark" | "sepia",
    nextTokens: ThemeTokens,
    nextCss: string
  ) => {
    if (nextOpen && nextPreview) {
      onPreviewThemeOverride({
        baseMode: nextBaseMode,
        tokens: nextTokens,
        extraCss: nextCss,
      });
    } else {
      onPreviewThemeOverride(null);
    }
  };

  const handleOpenNewThemeBuilder = () => {
    const nextTokens = { ...DEFAULT_BUILDER_TOKENS_LIGHT };
    setBuilderEditId(null);
    setBuilderName("琥珀暖阳主题");
    setBuilderAuthor("Custom Studio");
    setBuilderDesc("温润低眩光琥珀色调自定义主题");
    setBuilderBaseMode("light");
    setBuilderTokens(nextTokens);
    setBuilderCustomCss("");
    setBuilderOpen(true);
    syncLivePreview(true, livePreview, "light", nextTokens, "");
  };

  const handleEditThemeInBuilder = (plugin: StylePluginItem) => {
    const nextTokens = { ...plugin.tokens };
    setBuilderEditId(plugin.builtin ? `${plugin.id}-custom` : plugin.id);
    setBuilderName(plugin.builtin ? `${plugin.name} (定制版)` : plugin.name);
    setBuilderAuthor(plugin.builtin ? "Custom Studio" : plugin.author);
    setBuilderDesc(plugin.description);
    setBuilderBaseMode(plugin.baseMode);
    setBuilderTokens(nextTokens);
    setBuilderCustomCss(plugin.customCss || "");
    setBuilderOpen(true);
    syncLivePreview(
      true,
      livePreview,
      plugin.baseMode,
      nextTokens,
      plugin.customCss || ""
    );
  };

  const handleCloseBuilder = () => {
    setBuilderOpen(false);
    onPreviewThemeOverride(null);
  };

  const handleSaveThemeFromBuilder = async (alsoExport = false) => {
    if (!builderName.trim()) {
      onNotify("请输入主题名称");
      return;
    }
    try {
      const saved = await saveStylePlugin({
        id: builderEditId ?? undefined,
        kind: "theme",
        name: builderName.trim(),
        author: builderAuthor.trim() || "Custom Studio",
        version: "1.0.0",
        description: builderDesc.trim(),
        baseMode: builderBaseMode,
        enabled: true,
        tokens: builderTokens,
        customCss: builderCustomCss,
      });
      const updatedState = await toggleStylePlugin(saved.id, true);
      onPreviewThemeOverride(null);
      onStyleStateChange(updatedState);
      setBuilderEditId(saved.id);
      setBuilderOpen(false);
      onNotify(`主题插件「${saved.name}」已保存并立即生效`);
      if (alsoExport) {
        const outPath = await exportStylePluginDialog(saved.id);
        if (outPath) {
          onNotify(`已导出分享主题包：${outPath}`);
        }
      }
    } catch (err) {
      onNotify(
        `保存主题插件失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleActivateThemePlugin = async (plugin: StylePluginItem) => {
    try {
      onPreviewThemeOverride(null);
      const next = await toggleStylePlugin(plugin.id, true);
      onStyleStateChange(next);
      onNotify(`已切换至主题「${plugin.name}」`);
    } catch (err) {
      onNotify(
        `启用主题失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleToggleSnippet = async (plugin: StylePluginItem) => {
    try {
      const next = await toggleStylePlugin(plugin.id, !plugin.enabled);
      onStyleStateChange(next);
      onNotify(
        !plugin.enabled
          ? `已开启样式插件「${plugin.name}」`
          : `已关闭样式插件「${plugin.name}」`
      );
    } catch (err) {
      onNotify(
        `切换插件状态失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleDeletePlugin = async (plugin: StylePluginItem) => {
    try {
      const next = await deleteStylePlugin(plugin.id);
      onStyleStateChange(next);
      onNotify(`已删除自定义插件「${plugin.name}」`);
    } catch (err) {
      onNotify(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExportPlugin = async (plugin: StylePluginItem) => {
    try {
      const savedPath = await exportStylePluginDialog(plugin.id);
      if (savedPath) {
        onNotify(`插件已导出分享文件：${savedPath}`);
      }
    } catch (err) {
      onNotify(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleImportExternalPluginClick = async () => {
    if (isTauriRuntime()) {
      try {
        const imported = await importStylePluginDialog();
        if (imported) {
          const fresh = await onRefreshPlugins();
          if (fresh) onStyleStateChange(fresh);
          onNotify(`已安装样式插件「${imported.name}」`);
        }
      } catch (err) {
        onNotify(
          `安装外部插件失败：${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }
    browserPluginInputRef.current?.click();
  };

  const handleBrowserPluginFilePicked = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const imported = await importStylePluginContent(file.name, text);
      const fresh = await onRefreshPlugins();
      if (fresh) onStyleStateChange(fresh);
      onNotify(`已安装并启用样式插件「${imported.name}」`);
    } catch (err) {
      onNotify(
        `解析插件文件失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleOpenNewSnippetEditor = () => {
    setSnippetEditId(null);
    setSnippetName("自定义卡片阴影代码块");
    setSnippetDesc("自定义编辑器标题、表格或代码块视觉增强片段");
    setSnippetCss(
      [
        "/* @name: 自定义卡片阴影代码块 */",
        ".nb-editor-callout {",
        "  border-left: 4px solid var(--accent-color);",
        "  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);",
        "}",
      ].join("\n")
    );
    setSnippetEditorOpen(true);
  };

  const handleEditSnippet = (plugin: StylePluginItem) => {
    setSnippetEditId(plugin.id);
    setSnippetName(plugin.name);
    setSnippetDesc(plugin.description);
    setSnippetCss(plugin.customCss);
    setSnippetEditorOpen(true);
  };

  const handleSaveSnippet = async () => {
    if (!snippetName.trim()) {
      onNotify("请输入 CSS 样式插件名称");
      return;
    }
    try {
      const saved = await saveStylePlugin({
        id: snippetEditId ?? undefined,
        kind: "snippet",
        name: snippetName.trim(),
        author: "Custom Studio",
        version: "1.0.0",
        description: snippetDesc.trim(),
        baseMode: "light",
        enabled: true,
        tokens: {},
        customCss: snippetCss,
      });
      const fresh = await onRefreshPlugins();
      if (fresh) onStyleStateChange(fresh);
      setSnippetEditorOpen(false);
      onNotify(`CSS 样式插件「${saved.name}」已保存并启用`);
    } catch (err) {
      onNotify(
        `保存 CSS 插件失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <div className="nb-settings-section-stack">
      <input
        ref={browserPluginInputRef}
        type="file"
        accept=".css,.json,.notion-theme.json"
        style={{ display: "none" }}
        onChange={handleBrowserPluginFilePicked}
      />

      <div className="nb-settings-row-head">
        <div>
          <h3 className="nb-settings-heading">自定义主题工坊与可分享样式插件生态</h3>
          <p className="nb-settings-desc">
            支持一键切换精选设计师主题、可视化定制专属配色，或自由叠加多个{" "}
            <code>.css</code> 样式增强插件并导出分享给他人（也可直接将 <code>.css</code> /{" "}
            <code>.notion-theme.json</code> 拖入窗口安装）。
          </p>
        </div>
        <div className="nb-kb-actions-group">
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={handleImportExternalPluginClick}
          >
            <Upload size={14} /> 安装外部插件 (.css / .json)
          </button>
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={() => {
              if (styleState?.pluginsDir) {
                openPathInExplorer(styleState.pluginsDir).catch(() => {});
                if (!isTauriRuntime()) {
                  onNotify(`便携插件目录：${styleState.pluginsDir}`);
                }
              }
            }}
          >
            <FolderOpen size={14} /> 打开本地插件目录
          </button>
        </div>
      </div>

      {/* Section 1: Built-in Modes + Installed Theme Plugins Grid */}
      <div className="nb-settings-card-box">
        <div className="nb-settings-row-head">
          <div>
            <div className="nb-settings-label">原生基础模式与已安装主题插件</div>
            <div className="nb-settings-sub">
              点击任意主题卡片即可实时切换全局界面、编辑器与 Mermaid 图表配色
            </div>
          </div>
          <button
            type="button"
            className="nb-btn-primary"
            onClick={() =>
              builderOpen ? handleCloseBuilder() : handleOpenNewThemeBuilder()
            }
          >
            <Palette size={14} />
            {builderOpen ? "收起主题工坊" : "新建自定义主题"}
          </button>
        </div>

        {/* 4 Built-in Base Modes */}
        <div className="nb-theme-cards-grid">
          <button
            type="button"
            data-theme-card="light"
            className={`nb-choice-card${
              activeThemeId === "light" ? " is-selected" : ""
            }`}
            onClick={() => {
              onPreviewThemeOverride(null);
              onSelectBuiltinTheme("light");
            }}
          >
            <div className="nb-choice-title">
              <Sun size={15} /> 浅色纸面
            </div>
            <div className="nb-choice-desc">#FFFFFF 纯净日光白纸</div>
          </button>

          <button
            type="button"
            data-theme-card="dark"
            className={`nb-choice-card${
              activeThemeId === "dark" ? " is-selected" : ""
            }`}
            onClick={() => {
              onPreviewThemeOverride(null);
              onSelectBuiltinTheme("dark");
            }}
          >
            <div className="nb-choice-title">
              <Moon size={15} /> 深色夜间
            </div>
            <div className="nb-choice-desc">#191919 柔和暗夜石墨</div>
          </button>

          <button
            type="button"
            data-theme-card="sepia"
            className={`nb-choice-card${
              activeThemeId === "sepia" ? " is-selected" : ""
            }`}
            onClick={() => {
              onPreviewThemeOverride(null);
              onSelectBuiltinTheme("sepia");
            }}
          >
            <div className="nb-choice-title">
              <BookOpen size={15} /> 护眼暖色
            </div>
            <div className="nb-choice-desc">#FBF7EE 羊皮纸电纸书</div>
          </button>

          <button
            type="button"
            data-theme-card="system"
            className={`nb-choice-card${
              activeThemeId === "system" ? " is-selected" : ""
            }`}
            onClick={() => {
              onPreviewThemeOverride(null);
              onSelectBuiltinTheme("system");
            }}
          >
            <div className="nb-choice-title">
              <Monitor size={15} /> 跟随系统
            </div>
            <div className="nb-choice-desc">自动同步 Windows 深浅色</div>
          </button>
        </div>

        <div className="nb-menu-divider" />

        {/* Theme Plugins Grid */}
        <div className="nb-settings-label" style={{ marginBottom: "8px" }}>
          主题插件库 ({themePlugins.length})
        </div>
        <div className="nb-plugin-theme-grid">
          {themePlugins.map((tp) => {
            const isActive = activeThemeId === `plugin:${tp.id}`;
            const bg = tp.tokens.bgPrimary || "#ffffff";
            const sb = tp.tokens.bgSidebar || tp.tokens.bgSecondary || "#f6f8fa";
            const ac = tp.tokens.accentColor || "#2383e2";
            const fg = tp.tokens.textPrimary || "#24292f";

            return (
              <div
                key={tp.id}
                data-theme-plugin-id={tp.id}
                className={`nb-plugin-theme-card${isActive ? " is-active" : ""}`}
                onClick={() => handleActivateThemePlugin(tp)}
              >
                <div
                  className="nb-plugin-swatch-bar"
                  style={{ background: bg, borderColor: tp.tokens.borderColor || "var(--border-color)" }}
                >
                  <span
                    className="nb-swatch-sidebar"
                    style={{ background: sb }}
                  />
                  <div className="nb-swatch-canvas">
                    <span
                      className="nb-swatch-line is-title"
                      style={{ background: fg }}
                    />
                    <span
                      className="nb-swatch-line is-sub"
                      style={{ background: ac }}
                    />
                    <div className="nb-swatch-dots">
                      <span style={{ background: bg }} title={`画布 ${bg}`} />
                      <span style={{ background: sb }} title={`侧栏 ${sb}`} />
                      <span style={{ background: ac }} title={`强调 ${ac}`} />
                      <span
                        style={{ background: tp.tokens.codeInlineColor || fg }}
                        title="代码高亮"
                      />
                    </div>
                  </div>
                </div>

                <div className="nb-plugin-theme-body">
                  <div className="nb-plugin-theme-head">
                    <span className="nb-plugin-theme-name">{tp.name}</span>
                    <span className="nb-plugin-mode-tag">
                      {BASE_MODE_LABEL[tp.baseMode]}
                    </span>
                  </div>
                  <div className="nb-plugin-theme-desc">{tp.description}</div>

                  <div
                    className="nb-plugin-theme-foot"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-activate-theme={tp.id}
                      className={isActive ? "nb-btn-primary is-compact" : "nb-btn-secondary is-compact"}
                      onClick={() => handleActivateThemePlugin(tp)}
                    >
                      {isActive ? (
                        <>
                          <Check size={12} /> 当前使用中
                        </>
                      ) : (
                        "启用主题"
                      )}
                    </button>

                    <div className="nb-plugin-icon-actions">
                      <button
                        type="button"
                        className="nb-icon-btn"
                        title="以此为模板定制配色"
                        onClick={() => handleEditThemeInBuilder(tp)}
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        type="button"
                        className="nb-icon-btn"
                        title="导出 .notion-theme.json 分享给他人"
                        onClick={() => handleExportPlugin(tp)}
                      >
                        <Download size={13} />
                      </button>
                      {!tp.builtin && (
                        <button
                          type="button"
                          className="nb-icon-btn"
                          title="删除自定义主题"
                          onClick={() => handleDeletePlugin(tp)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 2: Visual Theme Builder */}
      {builderOpen && (
        <div className="nb-settings-card-box nb-studio-builder-box" data-testid="visual-theme-builder">
          <div className="nb-settings-row-head">
            <div>
              <div className="nb-settings-label">
                <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />
                可视化自定义主题工坊 (Visual Theme Builder)
              </div>
              <div className="nb-settings-sub">
                自由调配主画布、侧边栏、代码块与强调色，支持实时预览并一键保存为独立 <code>.notion-theme.json</code> 插件文件
              </div>
            </div>
            <label className="nb-checkbox-row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={livePreview}
                onChange={(e) => {
                  const nextVal = e.target.checked;
                  setLivePreview(nextVal);
                  syncLivePreview(
                    builderOpen,
                    nextVal,
                    builderBaseMode,
                    builderTokens,
                    builderCustomCss
                  );
                }}
              />
              <span>实时预览</span>
            </label>
          </div>

          <div className="nb-studio-meta-grid">
            <div>
              <label className="nb-studio-field-label">主题名称</label>
              <input
                type="text"
                data-testid="theme-builder-name"
                className="nb-input"
                value={builderName}
                onChange={(e) => setBuilderName(e.target.value)}
                placeholder="例如：极昼琥珀 / 赛博深空"
              />
            </div>
            <div>
              <label className="nb-studio-field-label">作者署名</label>
              <input
                type="text"
                className="nb-input"
                value={builderAuthor}
                onChange={(e) => setBuilderAuthor(e.target.value)}
                placeholder="作者或团队名称"
              />
            </div>
            <div>
              <label className="nb-studio-field-label">明暗对比基调 (影响图表与阴影)</label>
              <div className="nb-segmented-mini">
                {(["light", "dark", "sepia"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`nb-seg-btn${builderBaseMode === m ? " is-active" : ""}`}
                    onClick={() => {
                      setBuilderBaseMode(m);
                      syncLivePreview(
                        builderOpen,
                        livePreview,
                        m,
                        builderTokens,
                        builderCustomCss
                      );
                    }}
                  >
                    {BASE_MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="nb-studio-field-label">主题简介说明</label>
            <input
              type="text"
              className="nb-input"
              value={builderDesc}
              onChange={(e) => setBuilderDesc(e.target.value)}
              placeholder="简短描述该配色的适用场景"
            />
          </div>

          <div className="nb-studio-tokens-grid">
            {TOKEN_FIELDS.map((field) => {
              const rawVal = builderTokens[field.key] ?? "";
              return (
                <div key={field.key} className="nb-studio-token-item">
                  <span className="nb-studio-token-label">{field.label}</span>
                  <div className="nb-studio-color-row">
                    <input
                      type="color"
                      className="nb-color-swatch-input"
                      value={toHexPickerSafe(rawVal, field.fallbackHex)}
                      onChange={(e) => {
                        const nextTokens = {
                          ...builderTokens,
                          [field.key]: e.target.value,
                        };
                        setBuilderTokens(nextTokens);
                        syncLivePreview(
                          builderOpen,
                          livePreview,
                          builderBaseMode,
                          nextTokens,
                          builderCustomCss
                        );
                      }}
                    />
                    <input
                      type="text"
                      data-token-input={field.key}
                      className="nb-input nb-mono-input"
                      value={rawVal}
                      placeholder={field.fallbackHex}
                      onChange={(e) => {
                        const nextTokens = {
                          ...builderTokens,
                          [field.key]: e.target.value,
                        };
                        setBuilderTokens(nextTokens);
                        syncLivePreview(
                          builderOpen,
                          livePreview,
                          builderBaseMode,
                          nextTokens,
                          builderCustomCss
                        );
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <label className="nb-studio-field-label">附加主题专属 CSS（可选）</label>
            <textarea
              className="nb-input nb-mono-input nb-studio-css-textarea"
              rows={3}
              value={builderCustomCss}
              onChange={(e) => {
                const val = e.target.value;
                setBuilderCustomCss(val);
                syncLivePreview(
                  builderOpen,
                  livePreview,
                  builderBaseMode,
                  builderTokens,
                  val
                );
              }}
              placeholder=".nb-editor-h1 { letter-spacing: -0.02em; }"
            />
          </div>

          <div className="nb-settings-actions-bar">
            <button
              type="button"
              data-testid="save-custom-theme-btn"
              className="nb-btn-primary"
              onClick={() => handleSaveThemeFromBuilder(false)}
            >
              <Check size={14} /> 保存为主题插件并启用
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              onClick={() => handleSaveThemeFromBuilder(true)}
            >
              <Download size={14} /> 保存并导出分享 (.notion-theme.json)
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              onClick={handleCloseBuilder}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Section 3: Composable CSS Style Snippets */}
      <div className="nb-settings-card-box">
        <div className="nb-settings-row-head">
          <div>
            <div className="nb-settings-label">
              可叠加 CSS 样式增强插件 (Style Snippets · {snippetPlugins.length})
            </div>
            <div className="nb-settings-sub">
              与任意主题自由组合叠加，支持同时开启多个样式增强片段（保存在 <code>data\plugins\snippets\*.css</code>）
            </div>
          </div>
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={() =>
              snippetEditorOpen
                ? setSnippetEditorOpen(false)
                : handleOpenNewSnippetEditor()
            }
          >
            <Plus size={14} />
            {snippetEditorOpen ? "收起 CSS 编辑器" : "新建 CSS 插件"}
          </button>
        </div>

        {snippetEditorOpen && (
          <div className="nb-snippet-editor-panel" data-testid="css-snippet-editor">
            <div className="nb-studio-meta-grid">
              <div>
                <label className="nb-studio-field-label">插件名称</label>
                <input
                  type="text"
                  data-testid="snippet-name-input"
                  className="nb-input"
                  value={snippetName}
                  onChange={(e) => setSnippetName(e.target.value)}
                  placeholder="例如：彩虹引用竖线 / 学术紧凑段落"
                />
              </div>
              <div>
                <label className="nb-studio-field-label">功能说明</label>
                <input
                  type="text"
                  className="nb-input"
                  value={snippetDesc}
                  onChange={(e) => setSnippetDesc(e.target.value)}
                  placeholder="简述该 CSS 插件的排版效果"
                />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={() => setShowCheatSheet((v) => !v)}
                >
                  <Code2 size={14} />
                  {showCheatSheet ? "隐藏类名速查表" : "CSS 变量与类名速查"}
                </button>
              </div>
            </div>

            {showCheatSheet && (
              <div className="nb-css-cheatsheet">
                <div>
                  <b>常用钩子类名：</b>
                  <code>.nb-editor-root</code> · <code>.nb-editor-h1</code> /{" "}
                  <code>.nb-editor-h2</code> / <code>.nb-editor-h3</code> ·{" "}
                  <code>.nb-editor-code-wrap</code> · <code>.nb-editor-code-topbar</code> ·{" "}
                  <code>.nb-editor-table</code> · <code>.nb-editor-callout</code> ·{" "}
                  <code>.nb-mermaid-wrap</code> · <code>.nb-page-scroll</code>
                </div>
                <div>
                  <b>主题 CSS 变量：</b>
                  <code>var(--bg-primary)</code> · <code>var(--bg-sidebar)</code> ·{" "}
                  <code>var(--text-primary)</code> · <code>var(--accent-color)</code> ·{" "}
                  <code>var(--code-inline-fg)</code> · <code>var(--code-block-bg)</code> ·{" "}
                  <code>var(--border-color)</code>
                </div>
              </div>
            )}

            <textarea
              data-testid="snippet-css-textarea"
              className="nb-input nb-mono-input nb-studio-css-textarea"
              rows={7}
              value={snippetCss}
              onChange={(e) => setSnippetCss(e.target.value)}
              placeholder="/* 在此编写标准 CSS 规则，保存后立即注入生效 */"
            />

            <div className="nb-settings-actions-bar">
              <button
                type="button"
                data-testid="save-snippet-btn"
                className="nb-btn-primary"
                onClick={handleSaveSnippet}
              >
                <Check size={14} /> 保存并启用 CSS 插件
              </button>
              <button
                type="button"
                className="nb-btn-secondary"
                onClick={() => setSnippetEditorOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="nb-snippet-list">
          {snippetPlugins.map((sp) => (
            <div
              key={sp.id}
              data-snippet-id={sp.id}
              className={`nb-snippet-row${sp.enabled ? " is-enabled" : ""}`}
            >
              <div className="nb-snippet-info">
                <div className="nb-snippet-title-row">
                  <span className="nb-settings-label">{sp.name}</span>
                  <code className="nb-snippet-filename">{sp.fileName}</code>
                  {sp.builtin && <span className="nb-plugin-mode-tag">官方精选</span>}
                </div>
                <div className="nb-settings-sub">{sp.description}</div>
              </div>

              <div className="nb-snippet-controls">
                <button
                  type="button"
                  className="nb-icon-btn"
                  title="编辑 CSS 源码"
                  onClick={() => handleEditSnippet(sp)}
                >
                  <Edit3 size={14} />
                </button>
                <button
                  type="button"
                  className="nb-icon-btn"
                  title="导出 .css 分享文件"
                  onClick={() => handleExportPlugin(sp)}
                >
                  <Download size={14} />
                </button>
                {!sp.builtin && (
                  <button
                    type="button"
                    className="nb-icon-btn"
                    title="删除此 CSS 插件"
                    onClick={() => handleDeletePlugin(sp)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  type="button"
                  data-snippet-toggle={sp.id}
                  aria-label={`切换 ${sp.name}`}
                  className={`nb-toggle-switch${sp.enabled ? " is-on" : ""}`}
                  onClick={() => handleToggleSnippet(sp)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
