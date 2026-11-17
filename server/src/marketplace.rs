//! 小悦笔记社区插件与模板市场：主题配色（.xynote-theme.json）、CSS 样式片段（.css）与自定义模板（.json）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_PER_HOUR: i64 = 10;
pub const MAX_CONTENT_BYTES: usize = 256 * 1024;

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS marketplace_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        owner_user_id INTEGER NULL REFERENCES users(id),
        version TEXT NOT NULL DEFAULT '1.0.0',
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        base_mode TEXT NOT NULL DEFAULT 'light',
        preview_json TEXT NOT NULL DEFAULT '{}',
        content TEXT NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        featured INTEGER NOT NULL DEFAULT 0,
        client_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mp_kind_pop
        ON marketplace_items(kind, featured DESC, likes DESC, downloads DESC, id DESC);
    CREATE TABLE IF NOT EXISTS marketplace_likes (
        item_id INTEGER NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
        client_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, client_key)
    );
";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishInput {
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub base_mode: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSummary {
    pub id: i64,
    pub slug: String,
    pub kind: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub tags: Vec<String>,
    pub base_mode: String,
    pub preview: Value,
    pub filename: String,
    pub ascii_filename: String,
    pub downloads: i64,
    pub likes: i64,
    pub featured: bool,
    pub liked: bool,
    pub can_delete: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDetail {
    #[serde(flatten)]
    pub summary: MarketplaceSummary,
    pub content: String,
}

pub struct DownloadPayload {
    pub kind: String,
    pub filename: String,
    pub ascii_filename: String,
    pub content: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn clip(s: &str, max_chars: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(max_chars).collect()
}

fn clip_multiline(s: &str, max_chars: usize) -> String {
    s.trim()
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max_chars)
        .collect()
}

fn slugify(raw: &str) -> String {
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
    let trimmed = slug.trim_matches('-').chars().take(48).collect::<String>();
    if trimmed.is_empty() {
        "xynote-item".to_string()
    } else {
        trimmed
    }
}

fn ext_for_kind(kind: &str) -> &'static str {
    match kind {
        "theme" => "xynote-theme.json",
        "snippet" => "css",
        _ => "xynote-templates.json",
    }
}

fn filenames(id: i64, slug: &str, kind: &str) -> (String, String) {
    let ext = ext_for_kind(kind);
    let safe_slug: String = slug.chars().filter(|c| *c != '"' && *c != '/' && *c != '\\').collect();
    let display = format!("{}.{}", if safe_slug.is_empty() { format!("xynote-{}", id) } else { safe_slug }, ext);
    let ascii_stem: String = slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let ascii = if ascii_stem.is_empty() {
        format!("xynote-{}-{}.{}", kind, id, ext)
    } else {
        format!("{}-{}.{}", ascii_stem, id, ext)
    };
    (display, ascii)
}

fn is_safe_css_color(val: &str) -> bool {
    let s = val.trim();
    if s.is_empty() || s.len() > 48 || s.contains(';') || s.contains('<') || s.contains('>') {
        return false;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = s.to_ascii_lowercase();
    if (lower.starts_with("rgb(") || lower.starts_with("rgba(")) && lower.ends_with(')') {
        let inner = &lower[lower.find('(').unwrap() + 1..lower.len() - 1];
        return !inner.is_empty()
            && inner
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | '%' | ' ' | '/'));
    }
    false
}

fn parse_tags(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split([',', '，', ';', '；', ' ']) {
        let t = clip(part, 18);
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
            if out.len() >= 6 {
                break;
            }
        }
    }
    out
}

fn strip_css_comment_header(css: &str) -> &str {
    let trimmed = css.trim_start();
    if let Some(rest) = trimmed.strip_prefix("/*") {
        if let Some(end) = rest.find("*/") {
            let block = &rest[..end];
            if block.contains("@name:") || block.contains("@author:") || block.contains("@kind:") {
                return rest[end + 2..].trim();
            }
        }
    }
    trimmed
}

fn extract_css_header_tag(css: &str, key: &str) -> Option<String> {
    let trimmed = css.trim_start();
    let rest = trimmed.strip_prefix("/*")?;
    let end = rest.find("*/")?;
    for line in rest[..end].lines() {
        let l = line.trim().trim_start_matches('*').trim();
        if let Some(v) = l.strip_prefix(key) {
            if let Some(val) = v.trim_start().strip_prefix(':') {
                let c = clip(val, 80);
                if !c.is_empty() {
                    return Some(c);
                }
            }
        }
    }
    None
}

fn normalize_theme(input: &PublishInput, fallback_author: &str) -> Result<(String, String, String, String, String, String, Value, String), String> {
    let v: Value = serde_json::from_str(input.content.trim())
        .map_err(|e| format!("主题插件必须是合法的 .xynote-theme.json JSON 文件：{}", e))?;
    let obj = v.as_object().ok_or("主题 JSON 顶层必须是对象")?;

    let raw_name = if !input.name.trim().is_empty() {
        clip(&input.name, 60)
    } else {
        clip(obj.get("name").and_then(|x| x.as_str()).unwrap_or(""), 60)
    };
    if raw_name.chars().count() < 2 {
        return Err("请填写至少 2 个字的主题名称".into());
    }
    let slug = slugify(&raw_name);
    let author = clip(
        if !input.author.trim().is_empty() {
            &input.author
        } else {
            obj.get("author").and_then(|x| x.as_str()).unwrap_or(fallback_author)
        },
        40,
    );
    let author = if author.is_empty() { fallback_author.to_string() } else { author };
    let version = clip(
        if !input.version.trim().is_empty() {
            &input.version
        } else {
            obj.get("version").and_then(|x| x.as_str()).unwrap_or("1.0.0")
        },
        24,
    );
    let version = if version.is_empty() { "1.0.0".to_string() } else { version };
    let desc = clip_multiline(
        if !input.description.trim().is_empty() {
            &input.description
        } else {
            obj.get("description").and_then(|x| x.as_str()).unwrap_or("")
        },
        600,
    );
    let mode_raw = if !input.base_mode.trim().is_empty() {
        input.base_mode.trim()
    } else {
        obj.get("baseMode").and_then(|x| x.as_str()).unwrap_or("light")
    };
    let base_mode = match mode_raw.to_ascii_lowercase().as_str() {
        "dark" => "dark",
        "sepia" | "warm" => "sepia",
        _ => "light",
    }
    .to_string();

    let tokens_val = obj
        .get("tokens")
        .and_then(|t| t.as_object())
        .ok_or("主题 JSON 缺少 tokens 配色对象（至少包含 bgPrimary、textPrimary 等颜色变量）")?;
    if tokens_val.is_empty() {
        return Err("主题 tokens 配色不能为空".into());
    }
    let custom_css = obj
        .get("customCss")
        .or_else(|| obj.get("custom_css"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let lower_css = custom_css.to_ascii_lowercase();
    if lower_css.contains("<script") || lower_css.contains("</style") {
        return Err("主题 customCss 包含不允许的标签".into());
    }

    let mut preview_map = serde_json::Map::new();
    for key in ["bgPrimary", "bgSidebar", "textPrimary", "accentColor", "codeBlockBg", "borderColor"] {
        if let Some(s) = tokens_val.get(key).and_then(|x| x.as_str()) {
            if is_safe_css_color(s) {
                preview_map.insert(key.to_string(), json!(s.trim()));
            }
        }
    }

    let normalized_json = json!({
        "id": slug,
        "kind": "theme",
        "name": raw_name,
        "author": author,
        "version": version,
        "description": desc,
        "baseMode": base_mode,
        "builtin": false,
        "tokens": Value::Object(tokens_val.clone()),
        "customCss": custom_css,
        "updatedAt": now(),
    });
    let canonical = serde_json::to_string_pretty(&normalized_json).map_err(|e| e.to_string())?;
    Ok((slug, raw_name, author, version, desc, base_mode, Value::Object(preview_map), canonical))
}

fn normalize_snippet(input: &PublishInput, fallback_author: &str) -> Result<(String, String, String, String, String, String, Value, String), String> {
    let raw = input.content.trim();
    if raw.is_empty() {
        return Err("请粘贴或上传 CSS 样式代码".into());
    }
    let lower = raw.to_ascii_lowercase();
    if lower.contains("<script") || lower.contains("</style") {
        return Err("CSS 内容中不能包含 <script> 或 </style> 标签".into());
    }
    let body = strip_css_comment_header(raw);
    if !body.contains('{') || !body.contains('}') {
        return Err("CSS 样式必须包含至少一条合法的选择器规则（例如 .nb-editor-h1 { ... }）".into());
    }

    let raw_name = if !input.name.trim().is_empty() {
        clip(&input.name, 60)
    } else {
        extract_css_header_tag(raw, "@name").unwrap_or_default()
    };
    if raw_name.chars().count() < 2 {
        return Err("请填写至少 2 个字的样式插件名称".into());
    }
    let slug = slugify(&raw_name);
    let author = if !input.author.trim().is_empty() {
        clip(&input.author, 40)
    } else {
        extract_css_header_tag(raw, "@author").unwrap_or_else(|| fallback_author.to_string())
    };
    let version = if !input.version.trim().is_empty() {
        clip(&input.version, 24)
    } else {
        extract_css_header_tag(raw, "@version").unwrap_or_else(|| "1.0.0".to_string())
    };
    let desc = if !input.description.trim().is_empty() {
        clip_multiline(&input.description, 600)
    } else {
        extract_css_header_tag(raw, "@description").unwrap_or_default()
    };
    let mode_str = if !input.base_mode.trim().is_empty() {
        input.base_mode.clone()
    } else {
        extract_css_header_tag(raw, "@mode").unwrap_or_else(|| "light".to_string())
    };
    let base_mode = match mode_str.trim().to_ascii_lowercase().as_str() {
        "dark" => "dark",
        "sepia" | "warm" => "sepia",
        _ => "light",
    }
    .to_string();

    let canonical = format!(
        "/*\n * @name: {}\n * @author: {}\n * @version: {}\n * @description: {}\n * @kind: snippet\n * @mode: {}\n */\n\n{}\n",
        raw_name,
        author,
        version,
        desc.replace('\n', " "),
        base_mode,
        body
    );
    let snippet_preview: String = body.chars().take(180).collect();
    let preview = json!({ "snippetPreview": snippet_preview });
    Ok((slug, raw_name, author, version, desc, base_mode, preview, canonical))
}

fn normalize_template(input: &PublishInput, fallback_author: &str) -> Result<(String, String, String, String, String, String, Value, String), String> {
    let v: Value = serde_json::from_str(input.content.trim())
        .map_err(|e| format!("模板文件必须是 XyNote 导出的 .json 格式：{}", e))?;
    let items: Vec<Value> = if let Some(arr) = v.as_array() {
        arr.clone()
    } else if let Some(arr) = v.get("templates").and_then(|t| t.as_array()) {
        arr.clone()
    } else if v.is_object() && v.get("payload").is_some() {
        vec![v.clone()]
    } else {
        return Err("模板 JSON 格式不正确：需要包含 templates 数组（请在软件「模板中心 → 导出」）".into());
    };
    if items.is_empty() {
        return Err("模板文件里至少要包含 1 个模板".into());
    }
    let first = items[0].as_object().ok_or("模板项必须是 JSON 对象")?;
    let payload = first.get("payload").and_then(|p| p.as_object()).ok_or("模板缺少 payload 数据")?;
    let page_type = match first.get("pageType").and_then(|p| p.as_str()).unwrap_or("doc") {
        "database" => "database",
        _ => "doc",
    };

    let raw_name = if !input.name.trim().is_empty() {
        clip(&input.name, 60)
    } else {
        clip(first.get("title").and_then(|x| x.as_str()).unwrap_or(""), 60)
    };
    if raw_name.chars().count() < 2 {
        return Err("请填写至少 2 个字的模板名称".into());
    }
    let slug = slugify(&raw_name);
    let author = if !input.author.trim().is_empty() {
        clip(&input.author, 40)
    } else {
        fallback_author.to_string()
    };
    let version = if !input.version.trim().is_empty() {
        clip(&input.version, 24)
    } else {
        "1.0.0".to_string()
    };
    let desc = if !input.description.trim().is_empty() {
        clip_multiline(&input.description, 600)
    } else {
        clip_multiline(first.get("description").and_then(|x| x.as_str()).unwrap_or(""), 600)
    };
    let icon = clip(first.get("icon").and_then(|x| x.as_str()).unwrap_or(if page_type == "database" { "🗂️" } else { "📝" }), 12);

    let mut summary_lines: Vec<String> = Vec::new();
    if page_type == "database" {
        if let Some(cols) = payload.get("columns").and_then(|c| c.as_array()) {
            let names: Vec<String> = cols
                .iter()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                .take(5)
                .map(|s| clip(s, 20))
                .collect();
            if !names.is_empty() {
                summary_lines.push(format!("字段：{}", names.join(" · ")));
            }
        }
        let rows_count = payload.get("rows").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
        summary_lines.push(format!("示例数据：{} 行 · 支持表格/看板/画廊切换", rows_count));
    } else if let Some(blocks) = payload.get("blocks").and_then(|b| b.as_array()) {
        for b in blocks {
            let line = b
                .get("plainText")
                .or_else(|| b.get("content"))
                .and_then(|s| s.as_str())
                .map(|s| clip(s, 48))
                .unwrap_or_default();
            if !line.is_empty() {
                summary_lines.push(line);
                if summary_lines.len() >= 4 {
                    break;
                }
            }
        }
    }

    let wrapped = json!({
        "schema": "xynote-templates-v1",
        "exportedAt": now(),
        "templates": items,
    });
    let canonical = serde_json::to_string_pretty(&wrapped).map_err(|e| e.to_string())?;
    let preview = json!({
        "icon": icon,
        "pageType": page_type,
        "templateCount": items.len(),
        "lines": summary_lines,
    });
    Ok((slug, raw_name, author, version, desc, page_type.to_string(), preview, canonical))
}

pub fn publish(
    conn: &Connection,
    user_id: Option<i64>,
    fallback_author: &str,
    client_key: &str,
    input: &PublishInput,
) -> Result<MarketplaceDetail, String> {
    if input.content.len() > MAX_CONTENT_BYTES {
        return Err("上传内容过大（最大支持 256 KB）".into());
    }
    let hour_ago = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    let recent: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM marketplace_items WHERE client_key = ?1 AND created_at > ?2",
            params![client_key, hour_ago],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if recent >= MAX_PER_HOUR {
        return Err("发布得太频繁了，请一小时后再试".into());
    }

    let kind = match input.kind.trim().to_ascii_lowercase().as_str() {
        "theme" => "theme",
        "snippet" => "snippet",
        "template" => "template",
        _ => return Err("插件类型只能是 theme（主题）、snippet（CSS 样式）或 template（模板）".into()),
    };

    let (slug, name, author, version, desc, base_mode, preview, canonical) = match kind {
        "theme" => normalize_theme(input, fallback_author)?,
        "snippet" => normalize_snippet(input, fallback_author)?,
        _ => normalize_template(input, fallback_author)?,
    };

    let tags_vec = parse_tags(&input.tags);
    let tags_joined = tags_vec.join(",");
    let preview_str = serde_json::to_string(&preview).map_err(|e| e.to_string())?;
    let at = now();

    conn.execute(
        "INSERT INTO marketplace_items
         (slug, kind, name, author, owner_user_id, version, description, tags, base_mode, preview_json, content, client_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            slug,
            kind,
            name,
            author,
            user_id,
            version,
            desc,
            tags_joined,
            base_mode,
            preview_str,
            canonical,
            client_key,
            at
        ],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    get_detail(conn, id, client_key, user_id, false)?
        .ok_or_else(|| "写入后读取失败".to_string())
}

fn row_to_summary(r: &rusqlite::Row<'_>, viewer_user_id: Option<i64>, is_admin: bool) -> rusqlite::Result<MarketplaceSummary> {
    let id: i64 = r.get(0)?;
    let slug: String = r.get(1)?;
    let kind: String = r.get(2)?;
    let tags_raw: String = r.get(7)?;
    let preview_raw: String = r.get(9)?;
    let owner_id: Option<i64> = r.get(13)?;
    let (filename, ascii_filename) = filenames(id, &slug, &kind);
    let preview: Value = serde_json::from_str(&preview_raw).unwrap_or_else(|_| json!({}));
    Ok(MarketplaceSummary {
        id,
        slug,
        kind,
        name: r.get(3)?,
        author: r.get(4)?,
        version: r.get(5)?,
        description: r.get(6)?,
        tags: parse_tags(&tags_raw),
        base_mode: r.get(8)?,
        preview,
        filename,
        ascii_filename,
        downloads: r.get(10)?,
        likes: r.get(11)?,
        featured: r.get::<_, i64>(12)? != 0,
        liked: r.get::<_, i64>(14)? != 0,
        can_delete: is_admin || (viewer_user_id.is_some() && owner_id == viewer_user_id),
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

pub fn list(
    conn: &Connection,
    kind: Option<&str>,
    query: &str,
    sort: &str,
    only_owner_id: Option<i64>,
    viewer_key: &str,
    viewer_user_id: Option<i64>,
    is_admin: bool,
) -> Result<Vec<MarketplaceSummary>, String> {
    let kind_filter = kind.map(str::trim).filter(|k| matches!(*k, "theme" | "snippet" | "template"));
    let escaped = query.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let like = format!("%{}%", escaped);
    let order = match sort {
        "newest" => "m.id DESC",
        "downloads" => "m.downloads DESC, m.likes DESC, m.id DESC",
        _ => "m.featured DESC, m.likes DESC, m.downloads DESC, m.id DESC",
    };
    let sql = format!(
        "SELECT m.id, m.slug, m.kind, m.name, m.author, m.version, m.description, m.tags, m.base_mode, m.preview_json,
                m.downloads, m.likes, m.featured, m.owner_user_id,
                EXISTS(SELECT 1 FROM marketplace_likes l WHERE l.item_id = m.id AND l.client_key = ?1) AS liked,
                m.created_at, m.updated_at
         FROM marketplace_items m
         WHERE (?2 IS NULL OR m.kind = ?2)
           AND (?3 = '%%' OR m.name LIKE ?3 ESCAPE '\\' OR m.description LIKE ?3 ESCAPE '\\' OR m.tags LIKE ?3 ESCAPE '\\' OR m.author LIKE ?3 ESCAPE '\\')
           AND (?4 IS NULL OR m.owner_user_id = ?4)
         ORDER BY {}
         LIMIT 200",
        order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![viewer_key, kind_filter, like, only_owner_id], |r| {
            row_to_summary(r, viewer_user_id, is_admin)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get_detail(
    conn: &Connection,
    id: i64,
    viewer_key: &str,
    viewer_user_id: Option<i64>,
    is_admin: bool,
) -> Result<Option<MarketplaceDetail>, String> {
    conn.query_row(
        "SELECT m.id, m.slug, m.kind, m.name, m.author, m.version, m.description, m.tags, m.base_mode, m.preview_json,
                m.downloads, m.likes, m.featured, m.owner_user_id,
                EXISTS(SELECT 1 FROM marketplace_likes l WHERE l.item_id = m.id AND l.client_key = ?1) AS liked,
                m.created_at, m.updated_at, m.content
         FROM marketplace_items m
         WHERE m.id = ?2",
        params![viewer_key, id],
        |r| {
            let summary = row_to_summary(r, viewer_user_id, is_admin)?;
            let content: String = r.get(17)?;
            Ok(MarketplaceDetail { summary, content })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn record_download(conn: &Connection, id: i64) -> Result<Option<DownloadPayload>, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT slug, kind, content FROM marketplace_items WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((slug, kind, content)) = row else { return Ok(None) };
    let _ = conn.execute("UPDATE marketplace_items SET downloads = downloads + 1 WHERE id = ?1", params![id]);
    let (filename, ascii_filename) = filenames(id, &slug, &kind);
    Ok(Some(DownloadPayload { kind, filename, ascii_filename, content }))
}

pub fn toggle_like(conn: &Connection, id: i64, client_key: &str) -> Result<Option<(bool, i64)>, String> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM marketplace_items WHERE id = ?1)", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(None);
    }
    let already: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM marketplace_likes WHERE item_id = ?1 AND client_key = ?2)",
            params![id, client_key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let liked = if already {
        conn.execute(
            "DELETE FROM marketplace_likes WHERE item_id = ?1 AND client_key = ?2",
            params![id, client_key],
        )
        .map_err(|e| e.to_string())?;
        false
    } else {
        conn.execute(
            "INSERT INTO marketplace_likes (item_id, client_key, created_at) VALUES (?1, ?2, ?3)",
            params![id, client_key, now()],
        )
        .map_err(|e| e.to_string())?;
        true
    };
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM marketplace_likes WHERE item_id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE marketplace_items SET likes = ?1 WHERE id = ?2", params![count, id])
        .map_err(|e| e.to_string())?;
    Ok(Some((liked, count)))
}

pub fn delete_item(conn: &Connection, id: i64, caller_user_id: Option<i64>, is_admin: bool) -> Result<(), String> {
    let owner: Option<Option<i64>> = conn
        .query_row("SELECT owner_user_id FROM marketplace_items WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(owner_uid) = owner else {
        return Err("插件或模板不存在".into());
    };
    if !is_admin && (caller_user_id.is_none() || owner_uid != caller_user_id) {
        return Err("只能删除自己发布的插件或模板".into());
    }
    conn.execute("DELETE FROM marketplace_items WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_featured(conn: &Connection, id: i64, featured: bool) -> Result<bool, String> {
    let n = conn
        .execute("UPDATE marketplace_items SET featured = ?1 WHERE id = ?2", params![if featured { 1 } else { 0 }, id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn count_total(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM marketplace_items", [], |r| r.get(0)).unwrap_or(0)
}

/// 首次启动时填充精选主题、CSS 样式插件与实用模板示例，让市场开箱即可下载试用。
pub fn seed_if_empty(conn: &Connection) -> Result<(), String> {
    if count_total(conn) > 0 {
        return Ok(());
    }
    let ts = "2026-11-17T00:00:00Z";
    struct Seed<'a> {
        slug: &'a str,
        kind: &'a str,
        name: &'a str,
        author: &'a str,
        desc: &'a str,
        tags: &'a str,
        base_mode: &'a str,
        preview: Value,
        content: String,
    }

    let theme_catppuccin = json!({
        "id": "catppuccin-mocha",
        "kind": "theme",
        "name": "Catppuccin Mocha 柔和星夜",
        "author": "XyNote 官方精选",
        "version": "1.0.0",
        "description": "柔和马卡龙色调与低眩光深空灰紫底色，长时间夜间写作眼睛依然舒适。",
        "baseMode": "dark",
        "builtin": false,
        "tokens": {
            "bgPrimary": "#1e1e2e",
            "bgSecondary": "#181825",
            "bgSidebar": "#181825",
            "bgHover": "#313244",
            "bgElevated": "#242438",
            "textPrimary": "#cdd6f4",
            "textSecondary": "#a6adc8",
            "textMuted": "#6c7086",
            "borderColor": "#313244",
            "accentColor": "#cba6f7",
            "codeInlineColor": "#f38ba8",
            "codeInlineBg": "rgba(243, 139, 168, 0.14)",
            "codeBlockBg": "#11111b",
            "tableHeaderBg": "#26263a",
            "calloutBg": "rgba(203, 166, 247, 0.12)",
            "selectionBg": "rgba(203, 166, 247, 0.25)",
            "radiusMd": "8px"
        },
        "customCss": ".nb-editor-h1, .nb-editor-h2 {\n  color: #f5e0dc;\n}\n.nb-editor-quote {\n  border-left: 3px solid #cba6f7;\n}",
        "updatedAt": ts
    });

    let theme_solarized = json!({
        "id": "solarized-paper",
        "kind": "theme",
        "name": "Solarized 暖阳护眼纸张",
        "author": "XyNote 官方精选",
        "version": "1.0.0",
        "description": "经典 Solarized Light 科学护眼配色，低对比暖米色纸感底色配合青蓝强调，适合白天阅读长文。",
        "baseMode": "sepia",
        "builtin": false,
        "tokens": {
            "bgPrimary": "#fdf6e3",
            "bgSecondary": "#f5ecd3",
            "bgSidebar": "#eee8d5",
            "bgHover": "#e6dfc9",
            "bgElevated": "#fffaf0",
            "textPrimary": "#475a61",
            "textSecondary": "#657b83",
            "textMuted": "#93a1a1",
            "borderColor": "#dfd6bf",
            "accentColor": "#268bd2",
            "codeInlineColor": "#d33682",
            "codeInlineBg": "rgba(211, 54, 130, 0.08)",
            "codeBlockBg": "#eee8d5",
            "tableHeaderBg": "#eee8d5",
            "calloutBg": "rgba(38, 139, 210, 0.09)",
            "selectionBg": "rgba(38, 139, 210, 0.2)",
            "radiusMd": "6px"
        },
        "customCss": ".nb-editor-p { line-height: 1.82; }\n.nb-editor-h1 { border-bottom: 1px dashed #d3cbb8; padding-bottom: 6px; }",
        "updatedAt": ts
    });

    let css_editorial = "/*\n * @name: 杂志级中文排版增强\n * @author: XyNote 官方精选\n * @version: 1.0.0\n * @description: 优化中文段落行距、首行与标题阶梯节奏，为二级标题添加左侧书签色条，阅读体验如独立出版物。\n * @kind: snippet\n * @mode: light\n */\n\n.nb-editor-p, .nb-editor-bullet, .nb-editor-numbered {\n  line-height: 1.85;\n  letter-spacing: 0.012em;\n}\n.nb-editor-h2 {\n  padding-left: 10px;\n  border-left: 3.5px solid var(--accent-color, #2383e2);\n}\n.nb-editor-quote {\n  border-radius: 0 10px 10px 0;\n  padding: 10px 14px;\n  background: color-mix(in srgb, var(--accent-color, #2383e2) 6%, transparent);\n}\n".to_string();

    let css_keycaps = "/*\n * @name: 立体键盘按键与温柔荧光笔\n * @author: XyNote 官方精选\n * @version: 1.0.0\n * @description: 让行内代码和快捷键呈现拟物键帽质感，并将高亮文字升级为渐变水彩笔划过效果。\n * @kind: snippet\n * @mode: light\n */\n\n.nb-editor-root code:not(pre code) {\n  border: 1px solid var(--border-color, #d0d7de);\n  box-shadow: 0 1px 0 var(--border-color, #d0d7de);\n  border-radius: 5px;\n  padding: 1px 6px;\n  font-size: 0.88em;\n}\nmark, .nb-mark {\n  background: linear-gradient(120deg, rgba(254, 240, 138, 0.65) 0%, rgba(253, 224, 71, 0.45) 100%);\n  border-radius: 4px;\n  padding: 0 4px;\n}\n".to_string();

    let css_card_blocks = "/*\n * @name: 彩虹渐变分割线与浮雕提示卡\n * @author: XyNote 官方精选\n * @version: 1.0.0\n * @description: 为高亮提示块 Callout 与图片增加柔和投影卡片质感，并将普通分割线替换为柔光渐变线。\n * @kind: snippet\n * @mode: light\n */\n\n.nb-callout {\n  border: 1px solid var(--border-color, #e6e6e3);\n  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.05);\n  border-radius: 10px;\n}\n.nb-editor-divider hr {\n  height: 2px;\n  border: none;\n  background: linear-gradient(90deg, transparent, var(--accent-color, #2383e2), transparent);\n  opacity: 0.55;\n}\n".to_string();

    let tpl_okr = serde_json::to_string_pretty(&json!({
        "schema": "xynote-templates-v1",
        "exportedAt": ts,
        "templates": [{
            "id": "tpl-okr-board",
            "title": "OKR 目标与关键结果看板",
            "icon": "🎯",
            "description": "按季度拆解 Objective 与可量化 KR，支持表格打分与看板推进。",
            "pageType": "database",
            "payload": {
                "blocks": [],
                "activeView": "board",
                "groupByColId": "col_status",
                "columns": [
                    { "id": "col_title", "name": "目标 / 关键结果", "colType": "title", "options": [], "width": 260, "sortOrder": 0 },
                    {
                        "id": "col_status", "name": "推进状态", "colType": "status",
                        "options": [
                            { "id": "st_plan", "label": "规划中", "color": "gray" },
                            { "id": "st_track", "label": "正常推进", "color": "blue" },
                            { "id": "st_risk", "label": "需关注", "color": "amber" },
                            { "id": "st_done", "label": "已达成", "color": "green" }
                        ],
                        "width": 140, "sortOrder": 1
                    },
                    {
                        "id": "col_q", "name": "周期", "colType": "select",
                        "options": [
                            { "id": "q1", "label": "Q1", "color": "purple" },
                            { "id": "q2", "label": "Q2", "color": "blue" },
                            { "id": "q3", "label": "Q3", "color": "green" },
                            { "id": "q4", "label": "Q4", "color": "amber" }
                        ],
                        "width": 100, "sortOrder": 2
                    },
                    { "id": "col_metric", "name": "量化指标", "colType": "text", "options": [], "width": 200, "sortOrder": 3 },
                    { "id": "col_due", "name": "截止日期", "colType": "date", "options": [], "width": 130, "sortOrder": 4 }
                ],
                "rows": [
                    { "cells": { "col_title": "O1：建立个人第二大脑知识库", "col_status": "st_track", "col_q": "q4", "col_metric": "完成 20 篇深度主题卡片", "col_due": "2026-12-31" }, "sortOrder": 0 },
                    { "cells": { "col_title": "KR1：每周稳定输出 2 篇读书或项目复盘", "col_status": "st_done", "col_q": "q4", "col_metric": "已连续打卡 6 周", "col_due": "2026-12-15" }, "sortOrder": 1 },
                    { "cells": { "col_title": "KR2：整理常用模板与样式插件库", "col_status": "st_plan", "col_q": "q4", "col_metric": "沉淀至少 5 套常用模板", "col_due": "2026-12-20" }, "sortOrder": 2 }
                ]
            },
            "createdAt": ts,
            "updatedAt": ts
        }]
    }))
    .unwrap();

    let tpl_cornell = serde_json::to_string_pretty(&json!({
        "schema": "xynote-templates-v1",
        "exportedAt": ts,
        "templates": [{
            "id": "tpl-cornell-reading",
            "title": "康奈尔深度读书与论文笔记",
            "icon": "📖",
            "description": "把书目元信息、核心论点摘录、疑问追问与行动清单拆成四段，读完直接留存精华。",
            "pageType": "doc",
            "payload": {
                "blocks": [
                    { "blockType": "callout", "content": "📚 书名 / 论文：《填写标题》 · 作者： · 评分：★★★★★", "plainText": "📚 书名 / 论文：《填写标题》 · 作者： · 评分：★★★★★", "props": { "icon": "📖" }, "sortOrder": 0 },
                    { "blockType": "heading2", "content": "一、核心问题与一句话总结", "plainText": "一、核心问题与一句话总结", "props": {}, "sortOrder": 1 },
                    { "blockType": "quote", "content": "这本书 / 文章最核心想解决的问题是：", "plainText": "这本书 / 文章最核心想解决的问题是：", "props": {}, "sortOrder": 2 },
                    { "blockType": "heading2", "content": "二、关键论点与原文摘录", "plainText": "二、关键论点与原文摘录", "props": {}, "sortOrder": 3 },
                    { "blockType": "bullet", "content": "论点 1（Pxx）：", "plainText": "论点 1（Pxx）：", "props": {}, "sortOrder": 4 },
                    { "blockType": "bullet", "content": "论点 2（Pxx）：", "plainText": "论点 2（Pxx）：", "props": {}, "sortOrder": 5 },
                    { "blockType": "heading2", "content": "三、思考追问与关联笔记", "plainText": "三、思考追问与关联笔记", "props": {}, "sortOrder": 6 },
                    { "blockType": "paragraph", "content": "可用 [[ 链接到工作区里的相关概念页面，形成知识网络。", "plainText": "可用 [[ 链接到工作区里的相关概念页面，形成知识网络。", "props": {}, "sortOrder": 7 },
                    { "blockType": "heading2", "content": "四、可落地的行动清单", "plainText": "四、可落地的行动清单", "props": {}, "sortOrder": 8 },
                    { "blockType": "todo", "content": "挑选一个立刻能应用到工作中的方法试行 7 天", "plainText": "挑选一个立刻能应用到工作中的方法试行 7 天", "props": { "checked": false }, "sortOrder": 9 }
                ],
                "columns": [],
                "activeView": null,
                "groupByColId": null,
                "rows": []
            },
            "createdAt": ts,
            "updatedAt": ts
        }]
    }))
    .unwrap();

    let seeds = [
        Seed {
            slug: "catppuccin-mocha",
            kind: "theme",
            name: "Catppuccin Mocha 柔和星夜",
            author: "XyNote 官方精选",
            desc: "柔和马卡龙色调与低眩光深空灰紫底色，长时间夜间写作眼睛依然舒适。",
            tags: "暗色,护眼,马卡龙",
            base_mode: "dark",
            preview: json!({
                "bgPrimary": "#1e1e2e", "bgSidebar": "#181825", "textPrimary": "#cdd6f4",
                "accentColor": "#cba6f7", "codeBlockBg": "#11111b", "borderColor": "#313244"
            }),
            content: serde_json::to_string_pretty(&theme_catppuccin).unwrap(),
        },
        Seed {
            slug: "solarized-paper",
            kind: "theme",
            name: "Solarized 暖阳护眼纸张",
            author: "XyNote 官方精选",
            desc: "经典 Solarized 暖米色纸感底色配合青蓝强调，适合白天长时间阅读与长文写作。",
            tags: "浅色,护眼,纸感",
            base_mode: "sepia",
            preview: json!({
                "bgPrimary": "#fdf6e3", "bgSidebar": "#eee8d5", "textPrimary": "#475a61",
                "accentColor": "#268bd2", "codeBlockBg": "#eee8d5", "borderColor": "#dfd6bf"
            }),
            content: serde_json::to_string_pretty(&theme_solarized).unwrap(),
        },
        Seed {
            slug: "editorial-chinese-typography",
            kind: "snippet",
            name: "杂志级中文排版增强",
            author: "XyNote 官方精选",
            desc: "优化中文行高字距，为二级标题添加左侧书签色条、为引用块加上淡雅底色，让笔记如独立出版物。",
            tags: "排版,中文,引用",
            base_mode: "light",
            preview: json!({ "snippetPreview": ".nb-editor-p { line-height: 1.85; }\n.nb-editor-h2 { border-left: 3.5px solid var(--accent-color); }" }),
            content: css_editorial,
        },
        Seed {
            slug: "keycap-and-watercolor-highlight",
            kind: "snippet",
            name: "立体键盘按键与温柔荧光笔",
            author: "XyNote 官方精选",
            desc: "把行内代码修饰成拟物键盘按键，并将高亮文本变成水彩荧光笔效果。",
            tags: "快捷键,高亮,精致",
            base_mode: "light",
            preview: json!({ "snippetPreview": "code:not(pre code) { box-shadow: 0 1px 0 var(--border-color); }\nmark { background: linear-gradient(...); }" }),
            content: css_keycaps,
        },
        Seed {
            slug: "rainbow-divider-and-cards",
            kind: "snippet",
            name: "彩虹渐变分割线与浮雕提示卡",
            author: "XyNote 官方精选",
            desc: "为提示块 Callout 添加轻盈浮雕边框与阴影，并将分割线美化成渐变光带。",
            tags: "卡片,分割线,美化",
            base_mode: "light",
            preview: json!({ "snippetPreview": ".nb-callout { box-shadow: 0 4px 14px rgba(15,23,42,.05); }\nhr { background: linear-gradient(90deg, ...); }" }),
            content: css_card_blocks,
        },
        Seed {
            slug: "okr-board-template",
            kind: "template",
            name: "OKR 目标与关键结果看板",
            author: "XyNote 官方精选",
            desc: "按季度拆解 Objective 与可量化 KR，预置「状态」看板分组、周期单选与示例数据，导入即用。",
            tags: "OKR,多维表格,效率",
            base_mode: "database",
            preview: json!({
                "icon": "🎯",
                "pageType": "database",
                "templateCount": 1,
                "lines": ["字段：目标 / 关键结果 · 推进状态 · 周期 · 量化指标 · 截止日期", "示例数据：3 行 · 支持表格/看板/画廊切换"]
            }),
            content: tpl_okr,
        },
        Seed {
            slug: "cornell-reading-notes",
            kind: "template",
            name: "康奈尔深度读书与论文笔记",
            author: "XyNote 官方精选",
            desc: "拆分为元信息卡、核心问题、原文摘录、[[双向链接]]思考与行动清单，适合系统化阅读沉淀。",
            tags: "读书笔记,康奈尔,文档",
            base_mode: "doc",
            preview: json!({
                "icon": "📖",
                "pageType": "doc",
                "templateCount": 1,
                "lines": ["一、核心问题与一句话总结", "二、关键论点与原文摘录", "三、思考追问与关联笔记", "四、可落地的行动清单"]
            }),
            content: tpl_cornell,
        },
    ];

    for s in seeds {
        let preview_str = serde_json::to_string(&s.preview).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO marketplace_items
             (slug, kind, name, author, owner_user_id, version, description, tags, base_mode, preview_json, content, featured, client_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, '1.0.0', ?5, ?6, ?7, ?8, ?9, 1, 'seed', ?10, ?10)",
            params![s.slug, s.kind, s.name, s.author, s.desc, s.tags, s.base_mode, preview_str, s.content, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO users (id) VALUES (10);")
            .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        seed_if_empty(&conn).unwrap();
        conn
    }

    #[test]
    fn seeds_load_and_support_publish_like_download_delete() {
        let conn = test_db();
        let initial = list(&conn, None, "", "popular", None, "u:1", Some(1), false).unwrap();
        assert_eq!(initial.len(), 7);
        // Re-running seed_if_empty is a no-op
        seed_if_empty(&conn).unwrap();
        assert_eq!(count_total(&conn), 7);

        // Publish CSS snippet
        let snip = publish(
            &conn,
            Some(10),
            "Alice",
            "u:10",
            &PublishInput {
                kind: "snippet".into(),
                name: "樱花高亮".into(),
                author: String::new(),
                version: "1.2.0".into(),
                description: "粉色柔和背景高亮".into(),
                tags: "粉色,高亮".into(),
                base_mode: "light".into(),
                content: "mark { background: pink; }".into(),
            },
        )
        .unwrap();
        assert_eq!(snip.summary.author, "Alice");
        assert!(snip.content.contains("@name: 樱花高亮"));

        // Reject unsafe script in CSS
        let bad = publish(
            &conn,
            Some(10),
            "Alice",
            "u:10",
            &PublishInput {
                kind: "snippet".into(),
                name: "恶意测试".into(),
                author: "x".into(),
                version: "1.0.0".into(),
                description: "".into(),
                tags: "".into(),
                base_mode: "light".into(),
                content: "<script>alert(1)</script> a { color: red; }".into(),
            },
        );
        assert!(bad.is_err());

        // Publish Theme JSON
        let theme = publish(
            &conn,
            Some(10),
            "Alice",
            "u:10",
            &PublishInput {
                kind: "theme".into(),
                name: "极光青".into(),
                author: "Alice".into(),
                version: "1.0.0".into(),
                description: "清爽主题".into(),
                tags: "极光".into(),
                base_mode: "light".into(),
                content: r##"{"tokens":{"bgPrimary":"#ffffff","textPrimary":"#111111","accentColor":"#00aa99"}}"##.into(),
            },
        )
        .unwrap();
        assert!(theme.summary.filename.ends_with(".xynote-theme.json"));
        assert_eq!(theme.summary.preview["accentColor"], "#00aa99");

        // Publish Template JSON
        let tpl = publish(
            &conn,
            Some(10),
            "Alice",
            "u:10",
            &PublishInput {
                kind: "template".into(),
                name: "每日复盘".into(),
                author: "Alice".into(),
                version: "1.0.0".into(),
                description: "极简日记".into(),
                tags: "复盘".into(),
                base_mode: "".into(),
                content: r#"{"schema":"xynote-templates-v1","templates":[{"title":"每日复盘","icon":"☀️","pageType":"doc","payload":{"blocks":[{"blockType":"heading2","content":"今日三件事","plainText":"今日三件事","props":{},"sortOrder":0}]}}]}"#.into(),
            },
        )
        .unwrap();
        assert_eq!(tpl.summary.base_mode, "doc");
        assert_eq!(tpl.summary.preview["templateCount"], 1);

        // Like toggle & download counter
        let (liked, count) = toggle_like(&conn, snip.summary.id, "u:2").unwrap().unwrap();
        assert!(liked && count == 1);
        let (liked2, count2) = toggle_like(&conn, snip.summary.id, "u:2").unwrap().unwrap();
        assert!(!liked2 && count2 == 0);
        let dl = record_download(&conn, snip.summary.id).unwrap().unwrap();
        assert!(dl.content.contains("background: pink"));
        let after = get_detail(&conn, snip.summary.id, "u:2", Some(2), false).unwrap().unwrap();
        assert_eq!(after.summary.downloads, 1);

        // Ownership delete check
        assert!(delete_item(&conn, snip.summary.id, Some(2), false).is_err());
        assert!(delete_item(&conn, snip.summary.id, Some(10), false).is_ok());
        assert!(delete_item(&conn, theme.summary.id, None, true).is_ok());
    }
}
