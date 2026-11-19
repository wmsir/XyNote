use crate::db::{now_iso, Database, DbInner};
use crate::models::{
    AppError, SaveStylePluginInput, StylePluginItem, StylePluginState, ThemeTokens,
};
use crate::win_dialogs::normalize_win32_path_str;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const PLUGIN_STATE_FILENAME: &str = "plugin-state.json";

const BUILTIN_THEME_ORDER: [&str; 5] = [
    "github-tech",
    "dracula-dark",
    "nord-dark",
    "ink-editorial",
    "meadow-green",
];

const BUILTIN_SNIPPET_ORDER: [&str; 5] = [
    "colorful-headings",
    "academic-numbering",
    "dot-grid-canvas",
    "mac-code-window",
    "compact-dense-table",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginStateFile {
    pub seeded_builtin_v030: bool,
    pub active_theme_id: String,
    pub enabled_snippet_ids: Vec<String>,
    pub custom_css_global: String,
}

impl Default for PluginStateFile {
    fn default() -> Self {
        Self {
            seeded_builtin_v030: false,
            active_theme_id: "light".to_string(),
            enabled_snippet_ids: Vec::new(),
            custom_css_global: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ThemeDiskFile {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub base_mode: String,
    pub builtin: bool,
    pub tokens: ThemeTokens,
    pub custom_css: String,
    pub updated_at: String,
}

impl Default for ThemeDiskFile {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "theme".to_string(),
            name: String::new(),
            author: "Community".to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            base_mode: "light".to_string(),
            builtin: false,
            tokens: ThemeTokens::default(),
            custom_css: String::new(),
            updated_at: String::new(),
        }
    }
}

fn clean_display_path(p: &Path) -> String {
    normalize_win32_path_str(&p.to_string_lossy())
}

fn system_time_to_iso(st: SystemTime) -> String {
    let dt: DateTime<Utc> = st.into();
    dt.to_rfc3339()
}

fn normalize_base_mode(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "dark" => "dark".to_string(),
        "sepia" | "warm" => "sepia".to_string(),
        _ => "light".to_string(),
    }
}

fn normalize_kind(raw: &str) -> String {
    if raw.trim().eq_ignore_ascii_case("theme") {
        "theme".to_string()
    } else {
        "snippet".to_string()
    }
}

pub fn slugify_plugin_id(raw: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if ('\u{4E00}'..='\u{9FFF}').contains(&ch) {
            slug.push(ch);
            prev_dash = false;
        } else if matches!(ch, '-' | '_' | ' ' | '.') && !slug.is_empty() && !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let cleaned = slug.trim_matches('-').to_string();
    if cleaned.is_empty() {
        format!(
            "plugin-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        )
    } else {
        cleaned
    }
}

fn strip_plugin_ext(filename: &str) -> &str {
    let trimmed = filename.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.ends_with(".xynote-theme.json") && trimmed.len() > 18 {
        &trimmed[..trimmed.len() - 18]
    } else if lower.ends_with(".notion-theme.json") && trimmed.len() > 18 {
        &trimmed[..trimmed.len() - 18]
    } else if lower.ends_with(".theme.json") && trimmed.len() > 11 {
        &trimmed[..trimmed.len() - 11]
    } else if lower.ends_with(".json") && trimmed.len() > 5 {
        &trimmed[..trimmed.len() - 5]
    } else if lower.ends_with(".css") && trimmed.len() > 4 {
        &trimmed[..trimmed.len() - 4]
    } else {
        trimmed
    }
}

fn is_builtin_id(id: &str) -> bool {
    BUILTIN_THEME_ORDER.contains(&id) || BUILTIN_SNIPPET_ORDER.contains(&id)
}

fn load_plugin_state_file(state_path: &Path) -> PluginStateFile {
    if let Ok(raw) = std::fs::read_to_string(state_path) {
        if let Ok(mut parsed) = serde_json::from_str::<PluginStateFile>(&raw) {
            if parsed.active_theme_id.trim().is_empty() {
                parsed.active_theme_id = "light".to_string();
            }
            return parsed;
        }
    }
    PluginStateFile::default()
}

fn save_plugin_state_file(state_path: &Path, state: &PluginStateFile) -> Result<(), AppError> {
    if let Some(parent) = state_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let pretty = serde_json::to_string_pretty(state)?;
    std::fs::write(state_path, pretty.as_bytes())?;
    Ok(())
}

fn builtin_themes_seed() -> Vec<ThemeDiskFile> {
    let ts = "2026-11-14T00:00:00Z".to_string();
    vec![
        ThemeDiskFile {
            id: "github-tech".into(),
            kind: "theme".into(),
            name: "GitHub 经典技术白".into(),
            author: "XyNote Official".into(),
            version: "1.0.0".into(),
            description: "清爽现代的 GitHub 技术文档风格，带有经典 H1/H2 标题底部分割线与高对比代码高亮。".into(),
            base_mode: "light".into(),
            builtin: true,
            tokens: ThemeTokens {
                bg_primary: Some("#ffffff".into()),
                bg_secondary: Some("#f6f8fa".into()),
                bg_sidebar: Some("#f6f8fa".into()),
                bg_hover: Some("#eaeef2".into()),
                bg_elevated: Some("#ffffff".into()),
                text_primary: Some("#24292f".into()),
                text_secondary: Some("#57606a".into()),
                text_muted: Some("#8c959f".into()),
                border_color: Some("#d0d7de".into()),
                accent_color: Some("#0969da".into()),
                code_inline_color: Some("#cf222e".into()),
                code_inline_bg: Some("rgba(175, 184, 193, 0.2)".into()),
                code_block_bg: Some("#f6f8fa".into()),
                table_header_bg: Some("#f6f8fa".into()),
                callout_bg: Some("#ddf4ff".into()),
                selection_bg: Some("rgba(9, 105, 218, 0.18)".into()),
                radius_md: Some("6px".into()),
                ..Default::default()
            },
            custom_css: ".nb-editor-h1, .nb-editor-h2 {\n  padding-bottom: 0.28em;\n  border-bottom: 1px solid var(--border-color, #d0d7de);\n}".into(),
            updated_at: ts.clone(),
        },
        ThemeDiskFile {
            id: "dracula-dark".into(),
            kind: "theme".into(),
            name: "Dracula 暗夜极客紫".into(),
            author: "XyNote Official".into(),
            version: "1.0.0".into(),
            description: "深受开发者喜爱的 Dracula 暗夜紫配色，柔和低眩光且行内代码色彩层次鲜明。".into(),
            base_mode: "dark".into(),
            builtin: true,
            tokens: ThemeTokens {
                bg_primary: Some("#282a36".into()),
                bg_secondary: Some("#21222c".into()),
                bg_sidebar: Some("#21222c".into()),
                bg_hover: Some("#343746".into()),
                bg_elevated: Some("#2f3241".into()),
                text_primary: Some("#f8f8f2".into()),
                text_secondary: Some("#cfd2e6".into()),
                text_muted: Some("#6272a4".into()),
                border_color: Some("#44475a".into()),
                accent_color: Some("#bd93f9".into()),
                code_inline_color: Some("#ff79c6".into()),
                code_inline_bg: Some("rgba(255, 121, 198, 0.14)".into()),
                code_block_bg: Some("#1e1f29".into()),
                table_header_bg: Some("#313445".into()),
                callout_bg: Some("rgba(189, 147, 249, 0.12)".into()),
                selection_bg: Some("rgba(189, 147, 249, 0.28)".into()),
                radius_md: Some("8px".into()),
                ..Default::default()
            },
            custom_css: ".nb-editor-quote-wrap, .nb-editor-quote {\n  border-left-color: #bd93f9;\n}".into(),
            updated_at: ts.clone(),
        },
        ThemeDiskFile {
            id: "nord-dark".into(),
            kind: "theme".into(),
            name: "Nord 极地冰川蓝".into(),
            author: "XyNote Official".into(),
            version: "1.0.0".into(),
            description: "源自北极冰川的冷峻低饱和暗色主题，适合长时间沉浸式架构设计与技术写作。".into(),
            base_mode: "dark".into(),
            builtin: true,
            tokens: ThemeTokens {
                bg_primary: Some("#2e3440".into()),
                bg_secondary: Some("#272c36".into()),
                bg_sidebar: Some("#272c36".into()),
                bg_hover: Some("#3b4252".into()),
                bg_elevated: Some("#3b4252".into()),
                text_primary: Some("#eceff4".into()),
                text_secondary: Some("#d8dee9".into()),
                text_muted: Some("#81a1c1".into()),
                border_color: Some("#434c5e".into()),
                accent_color: Some("#88c0d0".into()),
                code_inline_color: Some("#a3be8c".into()),
                code_inline_bg: Some("rgba(136, 192, 208, 0.14)".into()),
                code_block_bg: Some("#242933".into()),
                table_header_bg: Some("#3b4252".into()),
                callout_bg: Some("rgba(129, 161, 193, 0.14)".into()),
                selection_bg: Some("rgba(136, 192, 208, 0.25)".into()),
                radius_md: Some("8px".into()),
                ..Default::default()
            },
            custom_css: ".nb-editor-code-wrap {\n  border-color: #434c5e;\n}".into(),
            updated_at: ts.clone(),
        },
        ThemeDiskFile {
            id: "ink-editorial".into(),
            kind: "theme".into(),
            name: "墨韵书卷 (东方人文)".into(),
            author: "XyNote Official".into(),
            version: "1.0.0".into(),
            description: "温润宣纸底色配朱砂点缀与人文衬线标题，兼具古籍书卷质感与现代阅读体验。".into(),
            base_mode: "sepia".into(),
            builtin: true,
            tokens: ThemeTokens {
                bg_primary: Some("#faf6ee".into()),
                bg_secondary: Some("#f2ecdf".into()),
                bg_sidebar: Some("#f2ecdf".into()),
                bg_hover: Some("#e9e0ce".into()),
                bg_elevated: Some("#fffdf8".into()),
                text_primary: Some("#2b2623".into()),
                text_secondary: Some("#5c534c".into()),
                text_muted: Some("#8d8278".into()),
                border_color: Some("#dfd5c3".into()),
                accent_color: Some("#b83b2a".into()),
                code_inline_color: Some("#b83b2a".into()),
                code_inline_bg: Some("rgba(184, 59, 42, 0.09)".into()),
                code_block_bg: Some("#f3ede1".into()),
                table_header_bg: Some("#efe7d6".into()),
                callout_bg: Some("#f4ece0".into()),
                selection_bg: Some("rgba(184, 59, 42, 0.18)".into()),
                font_serif: Some("\"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", Georgia, serif".into()),
                radius_md: Some("6px".into()),
                ..Default::default()
            },
            custom_css: ".nb-editor-h1, .nb-editor-h2, .nb-editor-h3, .nb-page-title-input, .page-title-input {\n  font-family: var(--font-serif, \"Noto Serif SC\", \"Songti SC\", Georgia, serif);\n  letter-spacing: 0.02em;\n}".into(),
            updated_at: ts.clone(),
        },
        ThemeDiskFile {
            id: "meadow-green".into(),
            kind: "theme".into(),
            name: "清风豆沙护眼绿".into(),
            author: "XyNote Official".into(),
            version: "1.0.0".into(),
            description: "柔和草木豆沙绿护眼底色，降低日间白屏眩光，缓解长篇写作与审阅视觉疲劳。".into(),
            base_mode: "light".into(),
            builtin: true,
            tokens: ThemeTokens {
                bg_primary: Some("#edf5ee".into()),
                bg_secondary: Some("#e3eee5".into()),
                bg_sidebar: Some("#e3eee5".into()),
                bg_hover: Some("#d5e5d8".into()),
                bg_elevated: Some("#f5faf6".into()),
                text_primary: Some("#243328".into()),
                text_secondary: Some("#496150".into()),
                text_muted: Some("#728c79".into()),
                border_color: Some("#c5dac9".into()),
                accent_color: Some("#2e7d5b".into()),
                code_inline_color: Some("#1f6347".into()),
                code_inline_bg: Some("rgba(46, 125, 91, 0.12)".into()),
                code_block_bg: Some("#e2ede4".into()),
                table_header_bg: Some("#dfece1".into()),
                callout_bg: Some("#e1f0e5".into()),
                selection_bg: Some("rgba(46, 125, 91, 0.2)".into()),
                radius_md: Some("8px".into()),
                ..Default::default()
            },
            custom_css: ".nb-editor-callout-wrap, .nb-editor-callout {\n  border-left: 3px solid #2e7d5b;\n}".into(),
            updated_at: ts,
        },
    ]
}

struct BuiltinSnippetSeed {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    css_body: &'static str,
}

fn builtin_snippets_seed() -> Vec<BuiltinSnippetSeed> {
    vec![
        BuiltinSnippetSeed {
            id: "colorful-headings",
            name: "多彩分级标题侧边条",
            description: "为 H1 / H2 / H3 标题添加鲜明的彩色左侧导引条与柔和底纹，章节层级一目了然。",
            css_body: "\
.nb-editor-h1 {
  border-left: 4px solid var(--accent-color, #2383e2);
  padding-left: 12px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent-color, #2383e2) 9%, transparent), transparent 72%);
  border-radius: 0 6px 6px 0;
}
.nb-editor-h2 {
  border-left: 3.5px solid #10b981;
  padding-left: 10px;
}
.nb-editor-h3 {
  border-left: 3px solid #f59e0b;
  padding-left: 9px;
}",
        },
        BuiltinSnippetSeed {
            id: "academic-numbering",
            name: "学术文档标题自动编号",
            description: "使用纯 CSS 计数器自动为正文标题生成 1. / 1.1 / 1.1.1 多级学术规范编号。",
            css_body: "\
.nb-editor-root {
  counter-reset: nb-sec-h1;
}
.nb-editor-h1 {
  counter-reset: nb-sec-h2;
  counter-increment: nb-sec-h1;
}
.nb-editor-h1:not(:empty)::before {
  content: counter(nb-sec-h1) \". \";
  color: var(--accent-color, #2383e2);
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
}
.nb-editor-h2 {
  counter-reset: nb-sec-h3;
  counter-increment: nb-sec-h2;
}
.nb-editor-h2:not(:empty)::before {
  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \" \";
  color: var(--accent-color, #2383e2);
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
}
.nb-editor-h3 {
  counter-increment: nb-sec-h3;
}
.nb-editor-h3:not(:empty)::before {
  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \".\" counter(nb-sec-h3) \" \";
  color: var(--accent-color, #2383e2);
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
}",
        },
        BuiltinSnippetSeed {
            id: "dot-grid-canvas",
            name: "工程师点阵网格信纸背景",
            description: "为编辑画布铺设细腻的工程手账点阵网格底纹，兼顾极客美感与视觉对齐感。",
            css_body: "\
.nb-page-scroll,
.nb-editor-source-pane,
.page-scroll-container,
.nb-source-editor-root {
  background-image: radial-gradient(color-mix(in srgb, var(--text-muted, #8b949e) 24%, transparent) 1px, transparent 1px);
  background-size: 20px 20px;
}",
        },
        BuiltinSnippetSeed {
            id: "mac-code-window",
            name: "Mac 窗口三色圆点代码块",
            description: "为代码块顶部工具栏添加经典 macOS 红黄绿三色窗口圆点装饰与立体卡片感。",
            css_body: "\
.nb-editor-code-topbar::before {
  content: \"\";
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ff5f57;
  box-shadow: 18px 0 0 #febc2e, 36px 0 0 #28c840;
  margin-right: 44px;
  flex-shrink: 0;
}
.nb-editor-code-wrap {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}",
        },
        BuiltinSnippetSeed {
            id: "compact-dense-table",
            name: "高密度斑马纹技术表格",
            description: "紧凑单元格内边距、交替斑马纹底色与高辨识度表头，适合大型接口与架构映射表。",
            css_body: "\
.nb-editor-table th,
.nb-editor-table td {
  padding: 6px 10px !important;
  font-size: 0.92em;
}
.nb-editor-table tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--bg-secondary, #f7f7f5) 65%, transparent);
}",
        },
    ]
}

pub fn format_css_with_metadata_header(
    name: &str,
    author: &str,
    version: &str,
    description: &str,
    kind: &str,
    base_mode: &str,
    builtin: bool,
    css_body: &str,
) -> String {
    let mut header = String::from("/*\n");
    header.push_str(&format!(" * @name: {}\n", name.trim()));
    header.push_str(&format!(" * @author: {}\n", author.trim()));
    header.push_str(&format!(" * @version: {}\n", version.trim()));
    if !description.trim().is_empty() {
        header.push_str(&format!(" * @description: {}\n", description.trim()));
    }
    header.push_str(&format!(" * @kind: {}\n", kind.trim()));
    header.push_str(&format!(" * @mode: {}\n", base_mode.trim()));
    if builtin {
        header.push_str(" * @builtin: true\n");
    }
    header.push_str(" */\n\n");
    header.push_str(css_body.trim());
    header.push('\n');
    header
}

/// Ensure `<active_data_dir>/plugins/{themes,snippets}` exist and auto-seed the 5 built-in
/// showcase themes + 5 showcase CSS snippets on first initialization.
pub fn ensure_plugins_initialized_on_disk(
    active_data_dir: &Path,
) -> Result<PluginStateFile, AppError> {
    let plugins_dir = active_data_dir.join("plugins");
    let themes_dir = plugins_dir.join("themes");
    let snippets_dir = plugins_dir.join("snippets");
    std::fs::create_dir_all(&themes_dir)?;
    std::fs::create_dir_all(&snippets_dir)?;

    let state_path = plugins_dir.join(PLUGIN_STATE_FILENAME);
    let mut state = load_plugin_state_file(&state_path);

    // 早期版本的主题文件扩展名是 .notion-theme.json，统一改成 .xynote-theme.json
    if let Ok(read) = std::fs::read_dir(&themes_dir) {
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".notion-theme.json") {
                let target = themes_dir.join(format!("{}.xynote-theme.json", stem));
                if !target.exists() {
                    let _ = std::fs::rename(item.path(), target);
                }
            }
        }
    }

    if !state.seeded_builtin_v030 {
        for theme in builtin_themes_seed() {
            let file_path = themes_dir.join(format!("{}.xynote-theme.json", theme.id));
            if !file_path.exists() {
                let pretty = serde_json::to_string_pretty(&theme)?;
                std::fs::write(&file_path, pretty.as_bytes())?;
            }
        }

        for snip in builtin_snippets_seed() {
            let file_path = snippets_dir.join(format!("{}.css", snip.id));
            if !file_path.exists() {
                let formatted = format_css_with_metadata_header(
                    snip.name,
                    "XyNote Official",
                    "1.0.0",
                    snip.description,
                    "snippet",
                    "light",
                    true,
                    snip.css_body,
                );
                std::fs::write(&file_path, formatted.as_bytes())?;
            }
        }

        state.seeded_builtin_v030 = true;
        save_plugin_state_file(&state_path, &state)?;
    } else if !state_path.exists() {
        save_plugin_state_file(&state_path, &state)?;
    }

    Ok(state)
}

#[derive(Default)]
struct ParsedCssMeta {
    id: Option<String>,
    name: Option<String>,
    author: Option<String>,
    version: Option<String>,
    description: Option<String>,
    kind: Option<String>,
    base_mode: Option<String>,
    builtin: Option<bool>,
    stripped_body: String,
}

fn parse_css_metadata_and_body(raw_css: &str) -> ParsedCssMeta {
    let without_bom = raw_css.strip_prefix('\u{feff}').unwrap_or(raw_css);
    let trimmed_start = without_bom.trim_start();
    let mut meta = ParsedCssMeta::default();

    if let Some(after_open) = trimmed_start.strip_prefix("/*") {
        if let Some(close_idx) = after_open.find("*/") {
            let comment_block = &after_open[..close_idx];
            let mut found_meta_tag = false;
            for line in comment_block.lines() {
                let clean_line = line.trim().trim_start_matches('*').trim();
                if let Some(rest) = clean_line.strip_prefix('@') {
                    let (key, val) = if let Some((k, v)) = rest.split_once(':') {
                        (k.trim(), v.trim())
                    } else if let Some((k, v)) = rest.split_once(char::is_whitespace) {
                        (k.trim(), v.trim())
                    } else {
                        continue;
                    };
                    if val.is_empty() {
                        continue;
                    }
                    match key.to_ascii_lowercase().as_str() {
                        "id" => {
                            meta.id = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "name" | "title" => {
                            meta.name = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "author" => {
                            meta.author = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "version" => {
                            meta.version = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "description" | "desc" => {
                            meta.description = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "kind" | "type" => {
                            meta.kind = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "mode" | "basemode" | "base_mode" => {
                            meta.base_mode = Some(val.to_string());
                            found_meta_tag = true;
                        }
                        "builtin" => {
                            meta.builtin = Some(val.eq_ignore_ascii_case("true"));
                            found_meta_tag = true;
                        }
                        _ => {}
                    }
                }
            }

            if found_meta_tag {
                meta.stripped_body = after_open[close_idx + 2..].trim().to_string();
                return meta;
            }
        }
    }

    meta.stripped_body = without_bom.trim().to_string();
    meta
}

fn extract_root_theme_tokens_from_css(css: &str) -> (ThemeTokens, usize) {
    let mut tokens = ThemeTokens::default();
    let mut matched = 0usize;

    for raw_line in css.lines() {
        let line = raw_line.trim();
        let Some(rest) = line.strip_prefix("--") else {
            continue;
        };
        let Some((var_name, raw_val)) = rest.split_once(':') else {
            continue;
        };
        let val = raw_val
            .trim()
            .trim_end_matches(';')
            .trim_end_matches("!important")
            .trim();
        if val.is_empty() {
            continue;
        }
        let s = Some(val.to_string());
        match var_name.trim() {
            "bg-primary" => {
                tokens.bg_primary = s;
                matched += 1;
            }
            "bg-secondary" => {
                tokens.bg_secondary = s;
                matched += 1;
            }
            "bg-sidebar" => {
                tokens.bg_sidebar = s;
                matched += 1;
            }
            "bg-hover" => {
                tokens.bg_hover = s;
                matched += 1;
            }
            "bg-elevated" => {
                tokens.bg_elevated = s;
                matched += 1;
            }
            "text-primary" => {
                tokens.text_primary = s;
                matched += 1;
            }
            "text-secondary" => {
                tokens.text_secondary = s;
                matched += 1;
            }
            "text-muted" => {
                tokens.text_muted = s;
                matched += 1;
            }
            "border-color" => {
                tokens.border_color = s;
                matched += 1;
            }
            "accent-color" => {
                tokens.accent_color = s;
                matched += 1;
            }
            "code-inline-fg" | "code-inline-color" => {
                tokens.code_inline_color = s;
                matched += 1;
            }
            "code-inline-bg" => {
                tokens.code_inline_bg = s;
                matched += 1;
            }
            "code-block-bg" => {
                tokens.code_block_bg = s;
                matched += 1;
            }
            "table-header-bg" => {
                tokens.table_header_bg = s;
                matched += 1;
            }
            "callout-bg" => {
                tokens.callout_bg = s;
                matched += 1;
            }
            "selection-bg" => {
                tokens.selection_bg = s;
                matched += 1;
            }
            "font-sans" => tokens.font_sans = s,
            "font-serif" => tokens.font_serif = s,
            "font-mono" => tokens.font_mono = s,
            "radius-md" => tokens.radius_md = s,
            _ => {}
        }
    }

    (tokens, matched)
}

fn parse_plugin_file_on_disk(
    path: &Path,
    default_kind_hint: &str,
    state: &PluginStateFile,
) -> Option<StylePluginItem> {
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    let lower_name = file_name.to_ascii_lowercase();
    if file_name == PLUGIN_STATE_FILENAME || file_name.starts_with('.') {
        return None;
    }

    let raw_content = std::fs::read_to_string(path).ok()?;
    let mtime_iso = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(system_time_to_iso)
        .unwrap_or_else(|_| now_iso());

    let stem = strip_plugin_ext(&file_name);

    if lower_name.ends_with(".json") {
        let disk_obj: ThemeDiskFile = serde_json::from_str(
            raw_content.strip_prefix('\u{feff}').unwrap_or(&raw_content),
        )
        .ok()?;
        let id = if disk_obj.id.trim().is_empty() {
            slugify_plugin_id(stem)
        } else {
            slugify_plugin_id(&disk_obj.id)
        };
        let kind = if disk_obj.kind.trim().is_empty() {
            normalize_kind(default_kind_hint)
        } else {
            normalize_kind(&disk_obj.kind)
        };
        let name = if disk_obj.name.trim().is_empty() {
            stem.to_string()
        } else {
            disk_obj.name.trim().to_string()
        };
        let enabled = if kind == "theme" {
            state.active_theme_id == format!("plugin:{}", id)
        } else {
            state.enabled_snippet_ids.iter().any(|s| s == &id)
        };
        let updated_at = if disk_obj.updated_at.trim().is_empty() {
            mtime_iso
        } else {
            disk_obj.updated_at
        };

        Some(StylePluginItem {
            builtin: disk_obj.builtin || is_builtin_id(&id),
            id,
            kind,
            name,
            author: if disk_obj.author.trim().is_empty() {
                "Community".to_string()
            } else {
                disk_obj.author.trim().to_string()
            },
            version: if disk_obj.version.trim().is_empty() {
                "1.0.0".to_string()
            } else {
                disk_obj.version.trim().to_string()
            },
            description: disk_obj.description.trim().to_string(),
            base_mode: normalize_base_mode(&disk_obj.base_mode),
            enabled,
            file_name,
            file_path: clean_display_path(path),
            tokens: disk_obj.tokens,
            custom_css: disk_obj.custom_css,
            updated_at,
        })
    } else if lower_name.ends_with(".css") {
        let meta = parse_css_metadata_and_body(&raw_content);
        let (extracted_tokens, token_count) =
            extract_root_theme_tokens_from_css(&meta.stripped_body);
        let id = meta
            .id
            .as_deref()
            .map(slugify_plugin_id)
            .unwrap_or_else(|| slugify_plugin_id(stem));
        let kind = if let Some(ref k) = meta.kind {
            normalize_kind(k)
        } else if default_kind_hint == "theme" || token_count >= 3 {
            "theme".to_string()
        } else {
            "snippet".to_string()
        };
        let name = meta
            .name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| stem.replace(['-', '_'], " "));
        let enabled = if kind == "theme" {
            state.active_theme_id == format!("plugin:{}", id)
        } else {
            state.enabled_snippet_ids.iter().any(|s| s == &id)
        };

        Some(StylePluginItem {
            builtin: meta.builtin.unwrap_or_else(|| is_builtin_id(&id)),
            id,
            kind,
            name,
            author: meta.author.unwrap_or_else(|| "Community".to_string()),
            version: meta.version.unwrap_or_else(|| "1.0.0".to_string()),
            description: meta.description.unwrap_or_default(),
            base_mode: meta
                .base_mode
                .as_deref()
                .map(normalize_base_mode)
                .unwrap_or_else(|| "light".to_string()),
            enabled,
            file_name,
            file_path: clean_display_path(path),
            tokens: extracted_tokens,
            custom_css: meta.stripped_body,
            updated_at: mtime_iso,
        })
    } else {
        None
    }
}

fn plugin_sort_rank(item: &StylePluginItem) -> (u8, usize, String) {
    if item.kind == "theme" {
        if let Some(pos) = BUILTIN_THEME_ORDER.iter().position(|&id| id == item.id) {
            return (0, pos, String::new());
        }
        (1, 0, item.name.to_lowercase())
    } else {
        if let Some(pos) = BUILTIN_SNIPPET_ORDER.iter().position(|&id| id == item.id) {
            return (2, pos, String::new());
        }
        (3, 0, item.name.to_lowercase())
    }
}

fn scan_style_plugin_state(active_data_dir: &Path) -> Result<StylePluginState, AppError> {
    let mut state = ensure_plugins_initialized_on_disk(active_data_dir)?;
    let plugins_dir = active_data_dir.join("plugins");
    let themes_dir = plugins_dir.join("themes");
    let snippets_dir = plugins_dir.join("snippets");
    let state_path = plugins_dir.join(PLUGIN_STATE_FILENAME);

    let mut by_id: HashMap<String, StylePluginItem> = HashMap::new();

    for (dir, kind_hint) in [(&themes_dir, "theme"), (&snippets_dir, "snippet")] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut paths: Vec<PathBuf> =
                entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            paths.sort();
            for p in paths {
                if let Some(item) = parse_plugin_file_on_disk(&p, kind_hint, &state) {
                    by_id.insert(item.id.clone(), item);
                }
            }
        }
    }

    // If active_theme_id points to a deleted plugin, fall back safely to "light"
    if let Some(target_id) = state.active_theme_id.strip_prefix("plugin:") {
        let valid_theme = by_id
            .get(target_id)
            .map(|p| p.kind == "theme")
            .unwrap_or(false);
        if !valid_theme {
            state.active_theme_id = "light".to_string();
            let _ = save_plugin_state_file(&state_path, &state);
        }
    }

    let mut plugins: Vec<StylePluginItem> = by_id
        .into_values()
        .map(|mut item| {
            item.enabled = if item.kind == "theme" {
                state.active_theme_id == format!("plugin:{}", item.id)
            } else {
                state.enabled_snippet_ids.iter().any(|s| s == &item.id)
            };
            item
        })
        .collect();

    plugins.sort_by_key(plugin_sort_rank);

    Ok(StylePluginState {
        plugins_dir: clean_display_path(&plugins_dir),
        themes_dir: clean_display_path(&themes_dir),
        snippets_dir: clean_display_path(&snippets_dir),
        active_theme_id: state.active_theme_id,
        plugins,
        custom_css_global: state.custom_css_global,
    })
}

fn resolve_active_plugins_base_dir(inner: &mut DbInner) -> Result<PathBuf, AppError> {
    if let Some(ref st) = inner.storage {
        return Ok(st.active_data_path());
    }
    if let Some(ref dir) = inner.ephemeral_plugins_dir {
        return Ok(dir.clone());
    }
    let temp = std::env::temp_dir().join(format!(
        "notion_mem_plugins_{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&temp)?;
    inner.ephemeral_plugins_dir = Some(temp.clone());
    Ok(temp)
}

impl Database {
    pub fn list_style_plugins(&self) -> Result<StylePluginState, AppError> {
        let mut inner = self.lock()?;
        let base_dir = resolve_active_plugins_base_dir(&mut inner)?;
        scan_style_plugin_state(&base_dir)
    }

    pub fn save_style_plugin(
        &self,
        input: SaveStylePluginInput,
    ) -> Result<StylePluginItem, AppError> {
        let mut inner = self.lock()?;
        let base_dir = resolve_active_plugins_base_dir(&mut inner)?;
        let mut state = ensure_plugins_initialized_on_disk(&base_dir)?;

        let plugins_dir = base_dir.join("plugins");
        let themes_dir = plugins_dir.join("themes");
        let snippets_dir = plugins_dir.join("snippets");
        let state_path = plugins_dir.join(PLUGIN_STATE_FILENAME);

        let kind = normalize_kind(&input.kind);
        let clean_name = {
            let t = input.name.trim();
            if t.is_empty() {
                if kind == "theme" {
                    "自定义主题".to_string()
                } else {
                    "自定义样式片段".to_string()
                }
            } else {
                t.to_string()
            }
        };

        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.strip_prefix("plugin:").unwrap_or(s))
            .map(slugify_plugin_id)
            .unwrap_or_else(|| slugify_plugin_id(&clean_name));

        let current_snapshot = scan_style_plugin_state(&base_dir)?;
        let existing = current_snapshot.plugins.iter().find(|p| p.id == id);
        let is_new = existing.is_none();
        let preserve_builtin = existing.map(|p| p.builtin).unwrap_or(false);

        // If changing kind or overwriting an older file with a different extension, remove old file
        if let Some(prev) = existing {
            let prev_path = Path::new(&prev.file_path);
            let target_path = if kind == "theme" {
                themes_dir.join(format!("{}.xynote-theme.json", id))
            } else {
                snippets_dir.join(format!("{}.css", id))
            };
            if prev_path != target_path && prev_path.is_file() {
                let _ = std::fs::remove_file(prev_path);
            }
        }

        let author = input
            .author
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| existing.map(|e| e.author.clone()))
            .unwrap_or_else(|| "User".to_string());
        let version = input
            .version
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| existing.map(|e| e.version.clone()))
            .unwrap_or_else(|| "1.0.0".to_string());
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .map(String::from)
            .or_else(|| existing.map(|e| e.description.clone()))
            .unwrap_or_default();
        let base_mode = input
            .base_mode
            .as_deref()
            .map(normalize_base_mode)
            .or_else(|| existing.map(|e| e.base_mode.clone()))
            .unwrap_or_else(|| "light".to_string());
        let tokens = input
            .tokens
            .or_else(|| existing.map(|e| e.tokens.clone()))
            .unwrap_or_default();
        let custom_css = input
            .custom_css
            .map(|c| parse_css_metadata_and_body(&c).stripped_body)
            .or_else(|| existing.map(|e| e.custom_css.clone()))
            .unwrap_or_default();
        let ts = now_iso();

        let should_enable = input
            .enabled
            .unwrap_or_else(|| if is_new { true } else { existing.map(|e| e.enabled).unwrap_or(false) });

        if kind == "theme" {
            let disk_theme = ThemeDiskFile {
                id: id.clone(),
                kind: "theme".to_string(),
                name: clean_name,
                author,
                version,
                description,
                base_mode,
                builtin: preserve_builtin,
                tokens,
                custom_css,
                updated_at: ts,
            };
            let file_path = themes_dir.join(format!("{}.xynote-theme.json", id));
            std::fs::write(&file_path, serde_json::to_string_pretty(&disk_theme)?.as_bytes())?;

            if should_enable {
                state.active_theme_id = format!("plugin:{}", id);
            } else if state.active_theme_id == format!("plugin:{}", id) {
                state.active_theme_id = "light".to_string();
            }
        } else {
            let formatted_css = format_css_with_metadata_header(
                &clean_name,
                &author,
                &version,
                &description,
                "snippet",
                &base_mode,
                preserve_builtin,
                &custom_css,
            );
            let file_path = snippets_dir.join(format!("{}.css", id));
            std::fs::write(&file_path, formatted_css.as_bytes())?;

            if should_enable {
                if !state.enabled_snippet_ids.iter().any(|s| s == &id) {
                    state.enabled_snippet_ids.push(id.clone());
                }
            } else {
                state.enabled_snippet_ids.retain(|s| s != &id);
            }
        }

        save_plugin_state_file(&state_path, &state)?;
        let refreshed = scan_style_plugin_state(&base_dir)?;
        refreshed
            .plugins
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::NotFound(format!("Saved style plugin not found: {}", id)))
    }

    pub fn toggle_style_plugin(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<StylePluginState, AppError> {
        let mut inner = self.lock()?;
        let base_dir = resolve_active_plugins_base_dir(&mut inner)?;
        let mut state = ensure_plugins_initialized_on_disk(&base_dir)?;
        let state_path = base_dir.join("plugins").join(PLUGIN_STATE_FILENAME);

        let trimmed = id.trim();
        if matches!(trimmed, "light" | "dark" | "sepia" | "system") {
            state.active_theme_id = if enabled {
                trimmed.to_string()
            } else {
                "light".to_string()
            };
            save_plugin_state_file(&state_path, &state)?;
            return scan_style_plugin_state(&base_dir);
        }

        let clean_id = trimmed.strip_prefix("plugin:").unwrap_or(trimmed);
        let snapshot = scan_style_plugin_state(&base_dir)?;
        let target = snapshot
            .plugins
            .iter()
            .find(|p| p.id == clean_id)
            .ok_or_else(|| AppError::NotFound(format!("未找到样式插件: {}", clean_id)))?;

        if target.kind == "theme" {
            let plugin_ref = format!("plugin:{}", target.id);
            if enabled {
                state.active_theme_id = plugin_ref;
            } else if state.active_theme_id == plugin_ref {
                state.active_theme_id = "light".to_string();
            }
        } else if enabled {
            if !state.enabled_snippet_ids.iter().any(|s| s == &target.id) {
                state.enabled_snippet_ids.push(target.id.clone());
            }
        } else {
            state.enabled_snippet_ids.retain(|s| s != &target.id);
        }

        save_plugin_state_file(&state_path, &state)?;
        scan_style_plugin_state(&base_dir)
    }

    pub fn delete_style_plugin(&self, id: &str) -> Result<StylePluginState, AppError> {
        let mut inner = self.lock()?;
        let base_dir = resolve_active_plugins_base_dir(&mut inner)?;
        let mut state = ensure_plugins_initialized_on_disk(&base_dir)?;
        let state_path = base_dir.join("plugins").join(PLUGIN_STATE_FILENAME);

        let clean_id = id.trim().strip_prefix("plugin:").unwrap_or(id.trim());
        let snapshot = scan_style_plugin_state(&base_dir)?;
        let target = snapshot
            .plugins
            .iter()
            .find(|p| p.id == clean_id)
            .ok_or_else(|| AppError::NotFound(format!("未找到要删除的插件: {}", clean_id)))?;

        if target.builtin {
            return Err(AppError::Validation(
                "内置预设主题与官方样式插件不可删除，可直接关闭启用开关".into(),
            ));
        }

        let file_path = Path::new(&target.file_path);
        if file_path.is_file() {
            std::fs::remove_file(file_path)?;
        }

        state.enabled_snippet_ids.retain(|s| s != &target.id);
        if state.active_theme_id == format!("plugin:{}", target.id) {
            state.active_theme_id = "light".to_string();
        }
        save_plugin_state_file(&state_path, &state)?;
        scan_style_plugin_state(&base_dir)
    }

    pub fn import_style_plugin_content(
        &self,
        filename: &str,
        content: &str,
    ) -> Result<StylePluginItem, AppError> {
        let clean_fname = Path::new(filename.trim())
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "imported-style.css".to_string());
        let lower = clean_fname.to_ascii_lowercase();
        let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content).trim();
        if without_bom.is_empty() {
            return Err(AppError::Validation("导入的插件文件内容为空".into()));
        }

        let stem = strip_plugin_ext(&clean_fname);

        if lower.ends_with(".json") || without_bom.starts_with('{') {
            let parsed: ThemeDiskFile = serde_json::from_str(without_bom).map_err(|e| {
                AppError::Validation(format!("无效的主题 JSON 格式: {}", e))
            })?;
            let id = if parsed.id.trim().is_empty() || is_builtin_id(parsed.id.trim()) {
                let candidate = slugify_plugin_id(if parsed.id.trim().is_empty() {
                    stem
                } else {
                    parsed.id.trim()
                });
                if is_builtin_id(&candidate) {
                    format!("{}-custom", candidate)
                } else {
                    candidate
                }
            } else {
                slugify_plugin_id(&parsed.id)
            };
            let kind = if parsed.kind.trim().is_empty() {
                "theme".to_string()
            } else {
                normalize_kind(&parsed.kind)
            };
            let name = if parsed.name.trim().is_empty() {
                stem.to_string()
            } else {
                parsed.name.trim().to_string()
            };

            self.save_style_plugin(SaveStylePluginInput {
                id: Some(id),
                kind,
                name,
                author: Some(parsed.author),
                version: Some(parsed.version),
                description: Some(parsed.description),
                base_mode: Some(parsed.base_mode),
                enabled: Some(true),
                tokens: Some(parsed.tokens),
                custom_css: Some(parsed.custom_css),
            })
        } else {
            let meta = parse_css_metadata_and_body(without_bom);
            let (extracted_tokens, token_count) =
                extract_root_theme_tokens_from_css(&meta.stripped_body);
            let kind = if let Some(ref k) = meta.kind {
                normalize_kind(k)
            } else if token_count >= 3 {
                "theme".to_string()
            } else {
                "snippet".to_string()
            };
            let raw_id = meta
                .id
                .as_deref()
                .map(slugify_plugin_id)
                .unwrap_or_else(|| slugify_plugin_id(stem));
            let id = if is_builtin_id(&raw_id) {
                format!("{}-custom", raw_id)
            } else {
                raw_id
            };
            let name = meta
                .name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| stem.to_string());

            self.save_style_plugin(SaveStylePluginInput {
                id: Some(id),
                kind,
                name,
                author: meta.author,
                version: meta.version,
                description: meta.description,
                base_mode: meta.base_mode,
                enabled: Some(true),
                tokens: if token_count > 0 {
                    Some(extracted_tokens)
                } else {
                    None
                },
                custom_css: Some(meta.stripped_body),
            })
        }
    }

    pub fn serialize_style_plugin_for_export(
        &self,
        id: &str,
    ) -> Result<(StylePluginItem, String, String), AppError> {
        let mut inner = self.lock()?;
        let base_dir = resolve_active_plugins_base_dir(&mut inner)?;
        let state = scan_style_plugin_state(&base_dir)?;
        let clean_id = id.trim().strip_prefix("plugin:").unwrap_or(id.trim());
        let item = state
            .plugins
            .iter()
            .find(|p| p.id == clean_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("未找到要导出的插件: {}", clean_id)))?;

        if item.kind == "theme" {
            let export_obj = ThemeDiskFile {
                id: item.id.clone(),
                kind: "theme".to_string(),
                name: item.name.clone(),
                author: item.author.clone(),
                version: item.version.clone(),
                description: item.description.clone(),
                base_mode: item.base_mode.clone(),
                builtin: false,
                tokens: item.tokens.clone(),
                custom_css: item.custom_css.clone(),
                updated_at: item.updated_at.clone(),
            };
            let json = serde_json::to_string_pretty(&export_obj)?;
            let default_fname = format!("{}.xynote-theme.json", item.id);
            Ok((item, default_fname, format!("{}\n", json)))
        } else {
            let css = format_css_with_metadata_header(
                &item.name,
                &item.author,
                &item.version,
                &item.description,
                "snippet",
                &item.base_mode,
                false,
                &item.custom_css,
            );
            let default_fname = format!("{}.css", item.id);
            Ok((item, default_fname, css))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirGuard(PathBuf);
    impl TempDirGuard {
        fn new(label: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "notion_plugins_test_{}_{}",
                label,
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_auto_seed_5_themes_and_5_snippets_and_toggle_stacking() {
        let root = TempDirGuard::new("seed_stack");
        let exe_dir = root.0.join("app");
        let fallback_dir = root.0.join("appdata");
        std::fs::create_dir_all(&exe_dir).unwrap();

        let db = Database::open_portable(&exe_dir, &fallback_dir, false).unwrap();

        // Confirm cold-start `open_portable` immediately created 5 `.xynote-theme.json` + 5 `.css` files on disk
        let themes_dir = exe_dir.join("XyNote-data").join("plugins").join("themes");
        let snippets_dir = exe_dir.join("XyNote-data").join("plugins").join("snippets");
        assert!(themes_dir.is_dir());
        assert!(snippets_dir.is_dir());

        let theme_files: Vec<_> = std::fs::read_dir(&themes_dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .ends_with(".xynote-theme.json")
            })
            .collect();
        let snippet_files: Vec<_> = std::fs::read_dir(&snippets_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".css"))
            .collect();
        assert_eq!(theme_files.len(), 5);
        assert_eq!(snippet_files.len(), 5);

        let initial = db.list_style_plugins().unwrap();
        assert_eq!(initial.active_theme_id, "light");
        assert_eq!(
            initial.plugins.iter().filter(|p| p.kind == "theme").count(),
            5
        );
        assert_eq!(
            initial
                .plugins
                .iter()
                .filter(|p| p.kind == "snippet")
                .count(),
            5
        );
        // All 5 snippets start disabled
        assert!(initial
            .plugins
            .iter()
            .filter(|p| p.kind == "snippet")
            .all(|p| !p.enabled));

        // Activate `dracula-dark` theme AND stack 3 CSS snippets simultaneously
        db.toggle_style_plugin("dracula-dark", true).unwrap();
        db.toggle_style_plugin("colorful-headings", true).unwrap();
        db.toggle_style_plugin("academic-numbering", true).unwrap();
        let stacked = db.toggle_style_plugin("mac-code-window", true).unwrap();

        assert_eq!(stacked.active_theme_id, "plugin:dracula-dark");
        let dracula = stacked
            .plugins
            .iter()
            .find(|p| p.id == "dracula-dark")
            .unwrap();
        assert!(dracula.enabled);
        assert_eq!(dracula.tokens.bg_primary.as_deref(), Some("#282a36"));
        assert!(dracula.custom_css.contains(".nb-editor-quote-wrap"));

        let dot_grid = stacked
            .plugins
            .iter()
            .find(|p| p.id == "dot-grid-canvas")
            .unwrap();
        assert!(dot_grid.custom_css.contains(".nb-page-scroll"));
        assert!(dot_grid.custom_css.contains(".nb-editor-source-pane"));

        let ink_theme = stacked
            .plugins
            .iter()
            .find(|p| p.id == "ink-editorial")
            .unwrap();
        assert!(ink_theme.custom_css.contains(".nb-page-title-input"));

        let meadow_theme = stacked
            .plugins
            .iter()
            .find(|p| p.id == "meadow-green")
            .unwrap();
        assert!(meadow_theme.custom_css.contains(".nb-editor-callout-wrap"));

        let enabled_snips: Vec<&str> = stacked
            .plugins
            .iter()
            .filter(|p| p.kind == "snippet" && p.enabled)
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(
            enabled_snips,
            vec!["colorful-headings", "academic-numbering", "mac-code-window"]
        );

        // Switching to built-in "sepia" keeps all 3 stacked CSS snippets enabled
        let switched_builtin = db.toggle_style_plugin("sepia", true).unwrap();
        assert_eq!(switched_builtin.active_theme_id, "sepia");
        assert!(switched_builtin
            .plugins
            .iter()
            .filter(|p| p.kind == "theme")
            .all(|p| !p.enabled));
        assert_eq!(
            switched_builtin
                .plugins
                .iter()
                .filter(|p| p.kind == "snippet" && p.enabled)
                .count(),
            3
        );
    }

    #[test]
    fn test_custom_theme_create_import_external_css_export_and_delete() {
        let root = TempDirGuard::new("crud_import_export");
        let exe_dir = root.0.join("app");
        let fallback_dir = root.0.join("appdata");
        std::fs::create_dir_all(&exe_dir).unwrap();

        let db = Database::open_portable(&exe_dir, &fallback_dir, false).unwrap();

        // 1. Create a custom theme in the Theme Studio
        let created_theme = db
            .save_style_plugin(SaveStylePluginInput {
                id: None,
                kind: "theme".into(),
                name: "赛博琥珀黑".into(),
                author: Some("Meng".into()),
                version: Some("1.1.0".into()),
                description: Some("高对比琥珀金暗色工程主题".into()),
                base_mode: Some("dark".into()),
                enabled: Some(true),
                tokens: Some(ThemeTokens {
                    bg_primary: Some("#141210".into()),
                    text_primary: Some("#f7efe2".into()),
                    accent_color: Some("#f59e0b".into()),
                    ..Default::default()
                }),
                custom_css: Some(".nb-editor-h1 { letter-spacing: 0.03em; }".into()),
            })
            .unwrap();
        assert_eq!(created_theme.kind, "theme");
        assert!(created_theme.enabled);
        assert!(!created_theme.builtin);
        assert!(Path::new(&created_theme.file_path).is_file());

        // 2. Import an external `.css` snippet with `@name` metadata header
        let external_css = "\
/*
 * @name: 霓虹玻璃提示框
 * @author: Alice
 * @version: 2.0.1
 * @description: 为 Callout 块赋予青色霓虹边框与毛玻璃光感
 * @kind: snippet
 */
.nb-editor-callout {
  border: 1.5px solid #00f5d4;
  backdrop-filter: blur(6px);
}
";
        let imported_snip = db
            .import_style_plugin_content("neon-callout.css", external_css)
            .unwrap();
        assert_eq!(imported_snip.id, "neon-callout");
        assert_eq!(imported_snip.name, "霓虹玻璃提示框");
        assert_eq!(imported_snip.author, "Alice");
        assert_eq!(imported_snip.version, "2.0.1");
        assert_eq!(imported_snip.kind, "snippet");
        assert!(imported_snip.enabled);
        assert!(!imported_snip.builtin);
        assert!(imported_snip.custom_css.contains("border: 1.5px solid #00f5d4;"));

        // 3. Export for sharing & verify round-trip metadata
        let (_meta, fname, exported_payload) = db
            .serialize_style_plugin_for_export("neon-callout")
            .unwrap();
        assert_eq!(fname, "neon-callout.css");
        assert!(exported_payload.contains("@name: 霓虹玻璃提示框"));
        assert!(exported_payload.contains("@author: Alice"));
        assert!(exported_payload.contains(".nb-editor-callout"));

        let (_tmeta, tfname, exported_theme_json) = db
            .serialize_style_plugin_for_export(&created_theme.id)
            .unwrap();
        assert!(tfname.ends_with(".xynote-theme.json"));
        assert!(exported_theme_json.contains("\"bgPrimary\": \"#141210\""));

        // 4. Built-in plugins are protected from deletion
        assert!(db.delete_style_plugin("dracula-dark").is_err());

        // 5. Deleting custom theme & snippet removes disk files and reverts active_theme_id to "light"
        let after_del_theme = db.delete_style_plugin(&created_theme.id).unwrap();
        assert_eq!(after_del_theme.active_theme_id, "light");
        assert!(!Path::new(&created_theme.file_path).exists());

        let after_del_snip = db.delete_style_plugin("neon-callout").unwrap();
        assert!(!after_del_snip.plugins.iter().any(|p| p.id == "neon-callout"));
        assert!(!Path::new(&imported_snip.file_path).exists());
    }
}
