use crate::db::{effective_plain_text, new_id, now_iso, Database};
use crate::markdown::{
    escape_html, inline_markdown_to_html, is_raw_text_block, parse_markdown_to_blocks, strip_html,
};
use crate::models::{AppError, BatchImportResult, MarkdownTreeEntry, SelectOption};
use base64::Engine;
use rusqlite::{params, Connection};
use serde_json::{Map, Number, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_IMAGE_INLINE_BYTES: usize = 2 * 1024 * 1024; // 2 MB
const MAX_NESTED_ZIP_BYTES: usize = 128 * 1024 * 1024; // 128 MB safety cap
const NOTION_SELECT_COLORS: [&str; 8] = [
    "blue", "green", "amber", "purple", "red", "gray", "pink", "teal",
];

#[derive(Debug, Clone)]
struct CreatedPageMeta {
    id: String,
    title: String,
    icon: String,
    is_folder_placeholder: bool,
}

#[derive(Debug, Clone)]
struct PreparedItem {
    norm_path: String,
    dir_path: String,
    ext: String,
    raw_stem: String,
    is_all_csv: bool,
    clean_title: String,
    clean_dir_parts: Vec<String>,
    clean_key: String,
    depth: usize,
    content: String,
}

fn strip_ascii_all_suffix(s: &str) -> Option<&str> {
    if s.len() > 4 && s.as_bytes()[s.len() - 4..].eq_ignore_ascii_case(b"_all") {
        Some(&s[..s.len() - 4])
    } else {
        None
    }
}

/// Strip Notion's trailing 32-hex UUID (or 36-char hyphenated UUID) and `_all` CSV suffix.
pub fn strip_notion_uuid(raw: &str) -> String {
    let mut s = raw.trim();
    if s.is_empty() {
        return "无标题".to_string();
    }

    // Handle `<Title> <32hex>_all` on Notion CSV stems
    if let Some(without_all) = strip_ascii_all_suffix(s).map(str::trim_end) {
        if has_trailing_notion_uuid(without_all) || is_exact_32_hex(without_all) {
            s = without_all;
        }
    }

    if is_exact_32_hex(s) {
        return "无标题".to_string();
    }

    if let Some(stripped) = strip_trailing_uuid_once(s) {
        let trimmed = stripped.trim();
        if trimmed.is_empty() {
            "无标题".to_string()
        } else {
            trimmed.to_string()
        }
    } else {
        s.to_string()
    }
}

fn is_exact_32_hex(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_hyphenated_uuid_36(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    for (idx, b) in s.bytes().enumerate() {
        if matches!(idx, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn has_trailing_notion_uuid(s: &str) -> bool {
    strip_trailing_uuid_once(s).is_some()
}

fn strip_trailing_uuid_once(s: &str) -> Option<&str> {
    if s.len() > 33 {
        let split_at = s.len() - 33;
        if s.is_char_boundary(split_at) {
            let tail = &s[split_at..];
            if let Some(hex32) = tail.strip_prefix(' ') {
                if is_exact_32_hex(hex32) {
                    return Some(&s[..split_at]);
                }
            }
        }
    }
    if s.len() > 37 {
        let split_at = s.len() - 37;
        if s.is_char_boundary(split_at) {
            let tail = &s[split_at..];
            if let Some(uuid36) = tail.strip_prefix(' ') {
                if is_hyphenated_uuid_36(uuid36) {
                    return Some(&s[..split_at]);
                }
            }
        }
    }
    None
}

pub fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn normalize_posix_path(raw: &str) -> Option<String> {
    let unified = raw.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        let s = seg.trim();
        if s.is_empty() || s == "." {
            continue;
        }
        if s == ".." {
            parts.pop();
            continue;
        }
        if s == "__MACOSX" || s == ".DS_Store" || s == "Thumbs.db" || s == ".git" || s == "node_modules" {
            return None;
        }
        parts.push(s);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn resolve_relative_posix_path(base_dir: &str, raw_rel: &str) -> String {
    let clean_rel = raw_rel
        .split(['#', '?'])
        .next()
        .unwrap_or(raw_rel)
        .trim();
    let decoded = url_decode(clean_rel).replace('\\', "/");
    if decoded.starts_with('/') {
        return normalize_posix_path(&decoded).unwrap_or_default();
    }
    let mut stack: Vec<&str> = if base_dir.trim().is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in decoded.split('/') {
        let s = seg.trim();
        if s.is_empty() || s == "." {
            continue;
        }
        if s == ".." {
            stack.pop();
        } else {
            stack.push(s);
        }
    }
    stack.join("/")
}

fn image_mime_for_path(lower_path: &str) -> Option<&'static str> {
    if lower_path.ends_with(".png") {
        Some("image/png")
    } else if lower_path.ends_with(".jpg") || lower_path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower_path.ends_with(".gif") {
        Some("image/gif")
    } else if lower_path.ends_with(".webp") {
        Some("image/webp")
    } else if lower_path.ends_with(".svg") {
        Some("image/svg+xml")
    } else if lower_path.ends_with(".bmp") {
        Some("image/bmp")
    } else if lower_path.ends_with(".ico") {
        Some("image/x-icon")
    } else if lower_path.ends_with(".avif") {
        Some("image/avif")
    } else {
        None
    }
}

fn is_text_import_path(lower_path: &str) -> bool {
    lower_path.ends_with(".md")
        || lower_path.ends_with(".markdown")
        || lower_path.ends_with(".txt")
        || lower_path.ends_with(".csv")
}

fn encode_data_uri(mime: &str, bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", mime, encoded)
}

/// Parse RFC 4180 CSV supporting UTF-8 BOM, quoted commas, `""` escapes, and multiline cells.
pub fn parse_rfc4180_csv(raw: &str) -> Vec<Vec<String>> {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    field.push('"');
                    i += 2;
                } else {
                    in_quotes = false;
                    i += 1;
                }
            } else {
                field.push(ch);
                i += 1;
            }
        } else {
            match ch {
                '"' if field.trim().is_empty() => {
                    field.clear();
                    in_quotes = true;
                    i += 1;
                }
                ',' => {
                    current_row.push(std::mem::take(&mut field).trim().to_string());
                    i += 1;
                }
                '\r' | '\n' => {
                    if ch == '\r' && i + 1 < chars.len() && chars[i + 1] == '\n' {
                        i += 2;
                    } else {
                        i += 1;
                    }
                    current_row.push(std::mem::take(&mut field).trim().to_string());
                    if current_row.iter().any(|c| !c.is_empty()) {
                        rows.push(std::mem::take(&mut current_row));
                    } else {
                        current_row.clear();
                    }
                }
                _ => {
                    field.push(ch);
                    i += 1;
                }
            }
        }
    }

    if !field.is_empty() || !current_row.is_empty() {
        current_row.push(field.trim().to_string());
        if current_row.iter().any(|c| !c.is_empty()) {
            rows.push(current_row);
        }
    }

    rows
}

fn is_checkbox_token(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "yes" | "no" | "true" | "false" | "checked" | "unchecked"
    ) || matches!(v.trim(), "是" | "否" | "✅" | "⬜")
}

fn parse_checkbox_bool(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "yes" | "true" | "checked" | "1"
    ) || matches!(v.trim(), "是" | "✅")
}

fn parse_and_normalize_date(v: &str) -> Option<String> {
    let t = v.trim();
    if t.len() < 8 {
        return None;
    }
    // 1. YYYY-MM-DD or YYYY/MM/DD (with optional time suffix)
    let date_part = t.split(['T', ' ']).next().unwrap_or(t);
    let sep = if date_part.contains('-') {
        Some('-')
    } else if date_part.contains('/') {
        Some('/')
    } else {
        None
    };
    if let Some(dlm) = sep {
        let segs: Vec<&str> = date_part.split(dlm).collect();
        if segs.len() == 3 && segs[0].len() == 4 && segs[0].bytes().all(|b| b.is_ascii_digit()) {
            if let (Ok(y), Ok(m), Ok(d)) = (
                segs[0].parse::<u32>(),
                segs[1].parse::<u32>(),
                segs[2].parse::<u32>(),
            ) {
                if (1900..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
                    return Some(format!("{:04}-{:02}-{:02}", y, m, d));
                }
            }
        }
    }

    // 2. Notion English date format: `November 14, 2026` or `Nov 14, 2026`
    if let Some(comma_idx) = t.find(',') {
        let before = t[..comma_idx].trim();
        let after = t[comma_idx + 1..].trim();
        let year_tok = after.split_whitespace().next().unwrap_or("");
        let mut bp = before.split_whitespace();
        if let (Some(mon_str), Some(day_str)) = (bp.next(), bp.next()) {
            let month_num = match mon_str.to_ascii_lowercase().as_str() {
                "jan" | "january" => Some(1),
                "feb" | "february" => Some(2),
                "mar" | "march" => Some(3),
                "apr" | "april" => Some(4),
                "may" => Some(5),
                "jun" | "june" => Some(6),
                "jul" | "july" => Some(7),
                "aug" | "august" => Some(8),
                "sep" | "sept" | "september" => Some(9),
                "oct" | "october" => Some(10),
                "nov" | "november" => Some(11),
                "dec" | "december" => Some(12),
                _ => None,
            };
            if let (Some(m), Ok(d), Ok(y)) =
                (month_num, day_str.parse::<u32>(), year_tok.parse::<u32>())
            {
                if (1900..=2200).contains(&y) && (1..=31).contains(&d) {
                    return Some(format!("{:04}-{:02}-{:02}", y, m, d));
                }
            }
        }
    }

    // 3. Chinese date format: `2026年11月14日`
    if let Some(y_idx) = t.find('年') {
        if let Some(m_rel) = t[y_idx + '年'.len_utf8()..].find('月') {
            let m_idx = y_idx + '年'.len_utf8() + m_rel;
            if let Some(d_rel) = t[m_idx + '月'.len_utf8()..].find('日') {
                let d_idx = m_idx + '月'.len_utf8() + d_rel;
                if let (Ok(y), Ok(m), Ok(d)) = (
                    t[..y_idx].trim().parse::<u32>(),
                    t[y_idx + '年'.len_utf8()..m_idx].trim().parse::<u32>(),
                    t[m_idx + '月'.len_utf8()..d_idx].trim().parse::<u32>(),
                ) {
                    if (1900..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d)
                    {
                        return Some(format!("{:04}-{:02}-{:02}", y, m, d));
                    }
                }
            }
        }
    }

    None
}

fn color_for_status_label(label: &str, idx: usize) -> String {
    let lower = label.trim().to_lowercase();
    if lower.contains("done")
        || lower.contains("complete")
        || lower.contains("shipped")
        || lower.contains("已完成")
        || lower.contains("已上线")
    {
        "green".to_string()
    } else if lower.contains("progress")
        || lower.contains("doing")
        || lower.contains("active")
        || lower.contains("review")
        || lower.contains("进行中")
        || lower.contains("处理中")
    {
        "blue".to_string()
    } else if lower.contains("block") || lower.contains("urgent") || lower.contains("阻塞") {
        "red".to_string()
    } else if lower.contains("todo")
        || lower.contains("not started")
        || lower.contains("backlog")
        || lower.contains("待办")
        || lower.contains("未开始")
        || lower.contains("待处理")
    {
        "gray".to_string()
    } else {
        NOTION_SELECT_COLORS[idx % NOTION_SELECT_COLORS.len()].to_string()
    }
}

fn is_select_header_hint(col_name: &str) -> bool {
    let lower = col_name.trim().to_lowercase();
    matches!(
        lower.as_str(),
        "priority"
            | "tag"
            | "tags"
            | "category"
            | "type"
            | "stage"
            | "phase"
            | "team"
            | "department"
            | "role"
            | "level"
            | "优先级"
            | "标签"
            | "分类"
            | "类型"
            | "阶段"
            | "团队"
            | "部门"
            | "模块"
    )
}

fn populate_csv_database_conn(
    tx: &Connection,
    page_id: &str,
    csv_content: &str,
    ts: &str,
) -> Result<HashMap<String, String>, AppError> {
    let matrix = parse_rfc4180_csv(csv_content);
    let mut row_title_to_row_id: HashMap<String, String> = HashMap::new();

    if matrix.is_empty() {
        let _ = Database::ensure_database_initialized_conn(tx, page_id)?;
        return Ok(row_title_to_row_id);
    }

    let headers: Vec<String> = matrix[0]
        .iter()
        .enumerate()
        .map(|(idx, h)| {
            let trimmed = h.trim();
            if trimmed.is_empty() {
                format!("列 {}", idx + 1)
            } else {
                trimmed.to_string()
            }
        })
        .collect();
    let data_rows = &matrix[1..];

    struct ColSpec {
        id: String,
        col_type: String,
        options: Vec<SelectOption>,
    }

    let mut col_specs: Vec<ColSpec> = Vec::with_capacity(headers.len());
    let mut group_by_col_id: Option<String> = None;

    for (col_idx, col_name) in headers.iter().enumerate() {
        let col_id = new_id();
        if col_idx == 0 {
            tx.execute(
                "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
                 VALUES (?1, ?2, ?3, 'title', '[]', 240, 0)",
                params![col_id, page_id, col_name],
            )?;
            col_specs.push(ColSpec {
                id: col_id,
                col_type: "title".to_string(),
                options: Vec::new(),
            });
            continue;
        }

        let non_empty: Vec<&str> = data_rows
            .iter()
            .filter_map(|r| r.get(col_idx).map(|s| s.trim()).filter(|s| !s.is_empty()))
            .collect();

        let mut distinct: Vec<String> = Vec::new();
        let mut seen_vals: HashSet<String> = HashSet::new();
        for &v in &non_empty {
            if seen_vals.insert(v.to_string()) {
                distinct.push(v.to_string());
            }
        }

        let lower_name = col_name.trim().to_lowercase();
        let (col_type, options) = if lower_name == "status" || col_name.trim() == "状态" {
            let labels = if distinct.is_empty() {
                vec![
                    "待处理".to_string(),
                    "进行中".to_string(),
                    "已完成".to_string(),
                ]
            } else {
                distinct
            };
            let opts: Vec<SelectOption> = labels
                .into_iter()
                .enumerate()
                .map(|(idx, lbl)| {
                    let color = color_for_status_label(&lbl, idx);
                    SelectOption {
                        id: new_id(),
                        label: lbl,
                        color,
                    }
                })
                .collect();
            if group_by_col_id.is_none() {
                group_by_col_id = Some(col_id.clone());
            }
            ("status".to_string(), opts)
        } else if !non_empty.is_empty() && non_empty.iter().all(|v| is_checkbox_token(v)) {
            ("checkbox".to_string(), Vec::new())
        } else if !non_empty.is_empty()
            && non_empty
                .iter()
                .all(|v| v.parse::<f64>().map(|n| n.is_finite()).unwrap_or(false))
        {
            ("number".to_string(), Vec::new())
        } else if !non_empty.is_empty()
            && non_empty
                .iter()
                .all(|v| parse_and_normalize_date(v).is_some())
        {
            ("date".to_string(), Vec::new())
        } else if !non_empty.is_empty()
            && non_empty.iter().all(|v| {
                let lv = v.to_ascii_lowercase();
                (lv.starts_with("http://") || lv.starts_with("https://")) && !v.contains(' ')
            })
        {
            ("url".to_string(), Vec::new())
        } else if !distinct.is_empty()
            && distinct.len() <= 12
            && distinct
                .iter()
                .all(|v| v.chars().count() <= 28 && !v.contains('\n'))
            && (distinct.len() < non_empty.len() || is_select_header_hint(col_name))
        {
            let opts: Vec<SelectOption> = distinct
                .into_iter()
                .enumerate()
                .map(|(idx, lbl)| SelectOption {
                    id: new_id(),
                    label: lbl,
                    color: NOTION_SELECT_COLORS[idx % NOTION_SELECT_COLORS.len()].to_string(),
                })
                .collect();
            if group_by_col_id.is_none() {
                group_by_col_id = Some(col_id.clone());
            }
            ("select".to_string(), opts)
        } else {
            ("text".to_string(), Vec::new())
        };

        tx.execute(
            "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, 175, ?6)",
            params![
                col_id,
                page_id,
                col_name,
                col_type,
                serde_json::to_string(&options)?,
                col_idx as i64
            ],
        )?;
        col_specs.push(ColSpec {
            id: col_id,
            col_type,
            options,
        });
    }

    tx.execute(
        "INSERT INTO db_meta (page_id, active_view, group_by_col_id) VALUES (?1, 'table', ?2)",
        params![page_id, group_by_col_id],
    )?;

    for (row_idx, raw_row) in data_rows.iter().enumerate() {
        let row_id = new_id();
        let mut cells = Map::new();
        let mut row_clean_title = String::new();

        for (col_idx, spec) in col_specs.iter().enumerate() {
            let raw_val = raw_row.get(col_idx).map(|s| s.trim()).unwrap_or("");
            let cell_val = match spec.col_type.as_str() {
                "title" => {
                    let cleaned = if raw_val.is_empty() {
                        String::new()
                    } else {
                        strip_notion_uuid(raw_val)
                    };
                    row_clean_title = cleaned.clone();
                    Value::String(cleaned)
                }
                "checkbox" => Value::Bool(parse_checkbox_bool(raw_val)),
                "number" => {
                    if raw_val.is_empty() {
                        Value::String(String::new())
                    } else if let Ok(iv) = raw_val.parse::<i64>() {
                        Value::Number(Number::from(iv))
                    } else if let Ok(fv) = raw_val.parse::<f64>() {
                        Number::from_f64(fv)
                            .map(Value::Number)
                            .unwrap_or_else(|| Value::String(raw_val.to_string()))
                    } else {
                        Value::String(raw_val.to_string())
                    }
                }
                "date" => {
                    if raw_val.is_empty() {
                        Value::String(String::new())
                    } else {
                        Value::String(
                            parse_and_normalize_date(raw_val)
                                .unwrap_or_else(|| raw_val.to_string()),
                        )
                    }
                }
                "status" | "select" => {
                    if raw_val.is_empty() {
                        Value::String(String::new())
                    } else if let Some(opt) = spec.options.iter().find(|o| o.label == raw_val) {
                        Value::String(opt.id.clone())
                    } else {
                        Value::String(raw_val.to_string())
                    }
                }
                _ => Value::String(raw_val.to_string()),
            };
            cells.insert(spec.id.clone(), cell_val);
        }

        tx.execute(
            "INSERT INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)",
            params![
                row_id,
                page_id,
                serde_json::to_string(&cells)?,
                row_idx as i64,
                ts
            ],
        )?;

        if !row_clean_title.is_empty() {
            row_title_to_row_id
                .entry(row_clean_title.to_lowercase())
                .or_insert(row_id);
        }
    }

    Ok(row_title_to_row_id)
}

fn extract_zip_recursive(
    zip_bytes: &[u8],
    prefix: &str,
    depth: usize,
    text_entries: &mut Vec<MarkdownTreeEntry>,
    asset_data_uris: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    if depth > 4 {
        return Ok(());
    }

    let cursor = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;

    for idx in 0..archive.len() {
        let entry = archive.by_index(idx)?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        if raw_name.contains("__MACOSX") {
            continue;
        }
        let combined = if prefix.is_empty() {
            raw_name
        } else {
            format!("{}/{}", prefix, raw_name)
        };
        let Some(norm_path) = normalize_posix_path(&combined) else {
            continue;
        };
        let lower_path = norm_path.to_lowercase();

        // Nested `.zip` inside `.zip` (Notion's "Export all workspace content" format)
        if lower_path.ends_with(".zip") {
            if entry.size() <= MAX_NESTED_ZIP_BYTES as u64 {
                let mut inner_bytes = Vec::with_capacity(entry.size() as usize);
                entry
                    .take(MAX_NESTED_ZIP_BYTES as u64)
                    .read_to_end(&mut inner_bytes)?;
                extract_zip_recursive(
                    &inner_bytes,
                    prefix,
                    depth + 1,
                    text_entries,
                    asset_data_uris,
                )?;
            }
            continue;
        }

        if is_text_import_path(&lower_path) {
            let mut buf = Vec::with_capacity(entry.size().min(16 * 1024 * 1024) as usize);
            entry.take(16 * 1024 * 1024).read_to_end(&mut buf)?;
            let content = String::from_utf8(buf)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
            text_entries.push(MarkdownTreeEntry {
                relative_path: norm_path,
                content,
            });
            continue;
        }

        if let Some(mime) = image_mime_for_path(&lower_path) {
            if entry.size() <= MAX_IMAGE_INLINE_BYTES as u64 {
                let mut img_bytes = Vec::with_capacity(entry.size() as usize);
                entry
                    .take((MAX_IMAGE_INLINE_BYTES + 1) as u64)
                    .read_to_end(&mut img_bytes)?;
                if img_bytes.len() <= MAX_IMAGE_INLINE_BYTES {
                    asset_data_uris.insert(lower_path, encode_data_uri(mime, &img_bytes));
                }
            }
        }
    }

    Ok(())
}

/// Unwrap Notion's synthetic `Export-<uuid>/` wrapper folder when every archive entry sits inside it.
fn unwrap_synthetic_export_root(
    text_entries: &mut [MarkdownTreeEntry],
    asset_data_uris: &mut HashMap<String, String>,
) {
    let mut wrapper_candidate: Option<String> = None;
    for entry in text_entries.iter() {
        let Some((first, _rest)) = entry.relative_path.split_once('/') else {
            return;
        };
        if !first.starts_with("Export-") {
            return;
        }
        match &wrapper_candidate {
            None => wrapper_candidate = Some(first.to_string()),
            Some(prev) if prev != first => return,
            _ => {}
        }
    }

    let Some(wrapper) = wrapper_candidate else {
        return;
    };
    let prefix = format!("{}/", wrapper);
    let prefix_lower = prefix.to_lowercase();

    for entry in text_entries.iter_mut() {
        if let Some(stripped) = entry.relative_path.strip_prefix(&prefix) {
            entry.relative_path = stripped.to_string();
        }
    }

    let old_assets = std::mem::take(asset_data_uris);
    for (k, v) in old_assets {
        if let Some(stripped) = k.strip_prefix(&prefix_lower) {
            asset_data_uris.insert(stripped.to_string(), v);
        } else {
            asset_data_uris.insert(k, v);
        }
    }
}

fn collect_directory_recursive(
    dir: &Path,
    rel_prefix: &str,
    text_entries: &mut Vec<MarkdownTreeEntry>,
    asset_data_uris: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };

    let mut child_paths: Vec<std::path::PathBuf> =
        read_dir.flatten().map(|e| e.path()).collect();
    child_paths.sort();

    for p in child_paths {
        let Some(name_os) = p.file_name() else {
            continue;
        };
        let name = name_os.to_string_lossy();
        if name.starts_with('.')
            || name == "__MACOSX"
            || name == "node_modules"
            || name == "target"
            || name == "dist"
        {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.into_owned()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        let Some(norm_rel) = normalize_posix_path(&rel) else {
            continue;
        };
        if p.is_dir() {
            collect_directory_recursive(&p, &norm_rel, text_entries, asset_data_uris)?;
        } else if p.is_file() {
            let lower = norm_rel.to_lowercase();
            if is_text_import_path(&lower) {
                if let Ok(bytes) = std::fs::read(&p) {
                    let content = String::from_utf8(bytes)
                        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                    text_entries.push(MarkdownTreeEntry {
                        relative_path: norm_rel,
                        content,
                    });
                }
            } else if let Some(mime) = image_mime_for_path(&lower) {
                if let Ok(meta) = std::fs::metadata(&p) {
                    if meta.len() <= MAX_IMAGE_INLINE_BYTES as u64 {
                        if let Ok(img_bytes) = std::fs::read(&p) {
                            if img_bytes.len() <= MAX_IMAGE_INLINE_BYTES {
                                asset_data_uris.insert(lower, encode_data_uri(mime, &img_bytes));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Scan standalone local `.md` content for `![...](rel_path)` so local sibling images <= 2MB are also embedded.
fn preload_referenced_sibling_images(
    md_file_dir: &Path,
    rel_dir_prefix: &str,
    markdown: &str,
    asset_data_uris: &mut HashMap<String, String>,
) {
    for line in markdown.lines() {
        let t = line.trim();
        if let Some(after_bang) = t.strip_prefix("![") {
            if let Some(close_b) = after_bang.find("](") {
                let after_open_p = &after_bang[close_b + 2..];
                if let Some(close_p) = after_open_p.rfind(')') {
                    let raw_target = after_open_p[..close_p].trim();
                    let lower_t = raw_target.to_ascii_lowercase();
                    if lower_t.starts_with("http://")
                        || lower_t.starts_with("https://")
                        || lower_t.starts_with("data:")
                    {
                        continue;
                    }
                    let decoded_rel = url_decode(raw_target.split(['#', '?']).next().unwrap_or(raw_target));
                    let candidate_disk = md_file_dir.join(decoded_rel.trim_start_matches("./"));
                    if candidate_disk.is_file() {
                        let resolved_virtual =
                            resolve_relative_posix_path(rel_dir_prefix, raw_target).to_lowercase();
                        if let Some(mime) = image_mime_for_path(&resolved_virtual) {
                            if let Ok(meta) = std::fs::metadata(&candidate_disk) {
                                if meta.len() <= MAX_IMAGE_INLINE_BYTES as u64 {
                                    if let Ok(bytes) = std::fs::read(&candidate_disk) {
                                        if bytes.len() <= MAX_IMAGE_INLINE_BYTES {
                                            asset_data_uris.insert(
                                                resolved_virtual,
                                                encode_data_uri(mime, &bytes),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn resolve_embedded_image_uri(
    asset_data_uris: &HashMap<String, String>,
    clean_asset_lookup: &HashMap<String, String>,
    current_dir: &str,
    raw_url: &str,
) -> Option<String> {
    let lower = raw_url.trim().to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
    {
        return None;
    }

    let resolved = resolve_relative_posix_path(current_dir, raw_url);
    if resolved.is_empty() {
        return None;
    }
    let resolved_lower = resolved.to_lowercase();
    if let Some(uri) = asset_data_uris.get(&resolved_lower) {
        return Some(uri.clone());
    }

    // Fallback: match with Notion UUIDs stripped on intermediate folder segments
    let clean_resolved = resolved
        .split('/')
        .map(strip_notion_uuid)
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase();
    if let Some(uri) = clean_asset_lookup.get(&clean_resolved) {
        return Some(uri.clone());
    }

    // Fallback: root-relative lookup if Notion link omitted current folder prefix
    let direct_decoded = normalize_posix_path(&url_decode(raw_url))?.to_lowercase();
    asset_data_uris.get(&direct_decoded).cloned()
}

/// Rewrite `<a href="..." data-md-rel-href="...">Label</a>` tags pointing to imported/workspace pages.
fn rewrite_relative_links_in_html(
    html: &str,
    source_page_id: &str,
    source_dir: &str,
    raw_no_ext_to_page: &HashMap<String, CreatedPageMeta>,
    clean_key_to_page: &HashMap<String, CreatedPageMeta>,
    raw_stem_to_page: &HashMap<String, CreatedPageMeta>,
    title_to_page: &HashMap<String, CreatedPageMeta>,
) -> (String, usize) {
    let marker = "data-md-rel-href=\"";
    if !html.contains(marker) {
        return (html.to_string(), 0);
    }

    let mut out = String::with_capacity(html.len() + 64);
    let mut resolved_count = 0usize;
    let mut cursor = 0usize;

    while let Some(a_rel) = html[cursor..].find("<a ") {
        let a_start = cursor + a_rel;
        out.push_str(&html[cursor..a_start]);

        let after_a = &html[a_start..];
        let Some(open_gt) = after_a.find('>') else {
            out.push_str(after_a);
            cursor = html.len();
            break;
        };
        let open_tag = &after_a[..=open_gt];
        let after_open = &after_a[open_gt + 1..];
        let Some(close_a_rel) = after_open.find("</a>") else {
            out.push_str(after_a);
            cursor = html.len();
            break;
        };
        let full_span_len = open_gt + 1 + close_a_rel + 4;

        if let Some(attr_pos) = open_tag.find(marker) {
            let val_start = attr_pos + marker.len();
            if let Some(val_end_rel) = open_tag[val_start..].find('"') {
                let raw_attr = &open_tag[val_start..val_start + val_end_rel];
                let unescaped_rel = raw_attr
                    .replace("&amp;", "&")
                    .replace("&quot;", "\"")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">");

                if let Some(target) = match_relative_link_target(
                    source_dir,
                    &unescaped_rel,
                    raw_no_ext_to_page,
                    clean_key_to_page,
                    raw_stem_to_page,
                    title_to_page,
                ) {
                    if target.id != source_page_id {
                        resolved_count += 1;
                        out.push_str(&format!(
                            "<a href=\"#\" data-page-id=\"{}\" class=\"nb-wiki-link\">{} {}</a>",
                            target.id,
                            target.icon,
                            escape_html(&target.title)
                        ));
                        cursor = a_start + full_span_len;
                        continue;
                    }
                }
            }
        }

        out.push_str(&after_a[..full_span_len]);
        cursor = a_start + full_span_len;
    }

    if cursor < html.len() {
        out.push_str(&html[cursor..]);
    }

    (out, resolved_count)
}

fn strip_doc_or_csv_ext(path: &str) -> Option<(&str, bool)> {
    let lower = path.to_ascii_lowercase();
    for (ext, is_csv) in [
        (".markdown", false),
        (".md", false),
        (".txt", false),
        (".csv", true),
    ] {
        if lower.ends_with(ext) {
            let cut = path.len() - ext.len();
            if path.is_char_boundary(cut) {
                return Some((&path[..cut], is_csv));
            }
        }
    }
    None
}

fn match_relative_link_target<'a>(
    source_dir: &str,
    raw_rel: &str,
    raw_no_ext_to_page: &'a HashMap<String, CreatedPageMeta>,
    clean_key_to_page: &'a HashMap<String, CreatedPageMeta>,
    raw_stem_to_page: &'a HashMap<String, CreatedPageMeta>,
    title_to_page: &'a HashMap<String, CreatedPageMeta>,
) -> Option<&'a CreatedPageMeta> {
    let resolved = resolve_relative_posix_path(source_dir, raw_rel);
    if resolved.is_empty() {
        return None;
    }

    let (no_ext, _is_csv) = strip_doc_or_csv_ext(&resolved)?;
    let no_ext_lower = no_ext.to_lowercase();

    // 1. Exact relative path without extension (including `_all` stripped variant)
    if let Some(p) = raw_no_ext_to_page.get(&no_ext_lower) {
        return Some(p);
    }
    if let Some(without_all) = no_ext_lower.strip_suffix("_all") {
        if let Some(p) = raw_no_ext_to_page.get(without_all) {
            return Some(p);
        }
    }

    // 2. Clean path with Notion UUIDs stripped on every path component
    let clean_target_key = no_ext
        .split('/')
        .map(strip_notion_uuid)
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase();
    if let Some(p) = clean_key_to_page.get(&clean_target_key) {
        return Some(p);
    }

    // 3. Raw filename stem (including Notion UUID)
    let file_stem = no_ext.rsplit('/').next().unwrap_or(no_ext);
    let stem_lower = file_stem.to_lowercase();
    if let Some(p) = raw_stem_to_page.get(&stem_lower) {
        return Some(p);
    }
    if let Some(without_all) = stem_lower.strip_suffix("_all") {
        if let Some(p) = raw_stem_to_page.get(without_all) {
            return Some(p);
        }
    }

    // 4. Stripped clean title fallback
    let clean_title_lower = strip_notion_uuid(file_stem).to_lowercase();
    title_to_page.get(&clean_title_lower)
}

impl Database {
    pub fn import_markdown_tree(
        &self,
        entries: Vec<MarkdownTreeEntry>,
        parent_id: Option<String>,
    ) -> Result<BatchImportResult, AppError> {
        let asset_data_uris = HashMap::new();
        self.import_virtual_workspace(entries, asset_data_uris, parent_id)
    }

    pub fn import_notion_zip_bytes(
        &self,
        zip_base64: &str,
        parent_id: Option<String>,
    ) -> Result<BatchImportResult, AppError> {
        let payload = match zip_base64.split_once(',') {
            Some((prefix, rest)) if prefix.contains("base64") => rest,
            _ => zip_base64,
        };
        let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        if compact.is_empty() {
            return Err(AppError::Validation("Empty zip archive payload".into()));
        }

        let zip_bytes = base64::engine::general_purpose::STANDARD
            .decode(&compact)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&compact))?;

        let mut text_entries = Vec::new();
        let mut asset_data_uris = HashMap::new();
        extract_zip_recursive(&zip_bytes, "", 0, &mut text_entries, &mut asset_data_uris)?;
        unwrap_synthetic_export_root(&mut text_entries, &mut asset_data_uris);

        self.import_virtual_workspace(text_entries, asset_data_uris, parent_id)
    }

    pub fn import_local_paths(
        &self,
        paths: Vec<String>,
        parent_id: Option<String>,
    ) -> Result<BatchImportResult, AppError> {
        let mut text_entries = Vec::new();
        let mut asset_data_uris = HashMap::new();

        for raw_p in paths {
            let trimmed = raw_p.trim();
            if trimmed.is_empty() {
                continue;
            }
            let p = Path::new(trimmed);
            if !p.exists() {
                continue;
            }
            if p.is_dir() {
                let folder_name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Imported Folder".to_string());
                collect_directory_recursive(
                    p,
                    &folder_name,
                    &mut text_entries,
                    &mut asset_data_uris,
                )?;
            } else if p.is_file() {
                let Some(file_name_os) = p.file_name() else {
                    continue;
                };
                let file_name = file_name_os.to_string_lossy().into_owned();
                let lower = file_name.to_lowercase();
                if lower.ends_with(".zip") {
                    let zip_bytes = std::fs::read(p)?;
                    let mut zip_texts = Vec::new();
                    let mut zip_assets = HashMap::new();
                    extract_zip_recursive(&zip_bytes, "", 0, &mut zip_texts, &mut zip_assets)?;
                    unwrap_synthetic_export_root(&mut zip_texts, &mut zip_assets);
                    text_entries.extend(zip_texts);
                    asset_data_uris.extend(zip_assets);
                } else if lower.ends_with(".css") || lower.ends_with(".notion-theme.json") {
                    let bytes = std::fs::read(p)?;
                    let content = String::from_utf8(bytes)
                        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                    self.import_style_plugin_content(&file_name, &content)?;
                } else if lower.ends_with(".json")
                    && lower != "notion-config.json"
                    && lower != "plugin-state.json"
                {
                    let bytes = std::fs::read(p)?;
                    let content = String::from_utf8(bytes)
                        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                    if content.contains("\"tokens\"")
                        || content.contains("\"baseMode\"")
                        || content.contains("\"customCss\"")
                    {
                        self.import_style_plugin_content(&file_name, &content)?;
                    }
                } else if is_text_import_path(&lower) {
                    let bytes = std::fs::read(p)?;
                    let content = String::from_utf8(bytes)
                        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                    if let Some(parent_dir) = p.parent() {
                        preload_referenced_sibling_images(
                            parent_dir,
                            "",
                            &content,
                            &mut asset_data_uris,
                        );
                    }
                    text_entries.push(MarkdownTreeEntry {
                        relative_path: file_name,
                        content,
                    });
                }
            }
        }

        self.import_virtual_workspace(text_entries, asset_data_uris, parent_id)
    }

    fn import_virtual_workspace(
        &self,
        entries: Vec<MarkdownTreeEntry>,
        asset_data_uris: HashMap<String, String>,
        parent_id: Option<String>,
    ) -> Result<BatchImportResult, AppError> {
        let root_parent = parent_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        let mut prepared: Vec<PreparedItem> = entries
            .into_iter()
            .filter_map(|e| {
                let norm_path = normalize_posix_path(&e.relative_path)?;
                let (no_ext, _is_csv) = strip_doc_or_csv_ext(&norm_path)?;
                let ext = norm_path[no_ext.len() + 1..].to_ascii_lowercase();
                let parts: Vec<&str> = norm_path.split('/').collect();
                let dir_parts = &parts[..parts.len() - 1];
                let raw_stem = no_ext.rsplit('/').next().unwrap_or(no_ext).to_string();
                let is_all_csv = ext == "csv" && strip_ascii_all_suffix(&raw_stem).is_some();
                let clean_title = strip_notion_uuid(&raw_stem);
                let clean_dir_parts: Vec<String> =
                    dir_parts.iter().map(|d| strip_notion_uuid(d)).collect();
                let mut key_parts = clean_dir_parts.clone();
                key_parts.push(clean_title.clone());
                let clean_key = key_parts.join("/").to_lowercase();
                let dir_path = dir_parts.join("/");
                let depth = parts.len();

                Some(PreparedItem {
                    dir_path,
                    norm_path,
                    ext,
                    raw_stem,
                    is_all_csv,
                    clean_title,
                    clean_dir_parts,
                    clean_key,
                    depth,
                    content: e.content,
                })
            })
            .collect();

        if prepared.is_empty() {
            return Ok(BatchImportResult::default());
        }

        // Shallow-first; `.csv` before `.md`; `_all.csv` before filtered `.csv`
        prepared.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then_with(|| {
                    let a_csv_rank = if a.ext == "csv" {
                        if a.is_all_csv {
                            0
                        } else {
                            1
                        }
                    } else {
                        2
                    };
                    let b_csv_rank = if b.ext == "csv" {
                        if b.is_all_csv {
                            0
                        } else {
                            1
                        }
                    } else {
                        2
                    };
                    a_csv_rank.cmp(&b_csv_rank)
                })
                .then_with(|| a.norm_path.cmp(&b.norm_path))
        });

        // Deduplicate Notion `<DB>_all.csv` + `<DB>.csv` pairs sharing the same cleanKey
        let mut seen_db_clean_keys: HashSet<String> = HashSet::new();
        prepared.retain(|item| {
            if item.ext != "csv" {
                return true;
            }
            seen_db_clean_keys.insert(item.clean_key.clone())
        });

        let clean_asset_lookup: HashMap<String, String> = asset_data_uris
            .iter()
            .map(|(k, v)| {
                let clean_k = k
                    .split('/')
                    .map(strip_notion_uuid)
                    .collect::<Vec<_>>()
                    .join("/")
                    .to_lowercase();
                (clean_k, v.clone())
            })
            .collect();

        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let ts = now_iso();

        let mut clean_key_to_page: HashMap<String, CreatedPageMeta> = HashMap::new();
        let mut raw_no_ext_to_page: HashMap<String, CreatedPageMeta> = HashMap::new();
        let mut raw_stem_to_page: HashMap<String, CreatedPageMeta> = HashMap::new();
        let mut title_to_page: HashMap<String, CreatedPageMeta> = HashMap::new();
        let mut db_clean_key_to_rows: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut created_doc_pages: Vec<(String, String)> = Vec::new();

        // Pre-populate existing workspace pages into fallback title map for cross-linking
        {
            let mut stmt =
                tx.prepare("SELECT id, title, icon FROM pages WHERE is_trashed = 0")?;
            let existing = stmt.query_map([], |r| {
                Ok(CreatedPageMeta {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    icon: r.get(2)?,
                    is_folder_placeholder: false,
                })
            })?;
            for meta in existing.flatten() {
                title_to_page
                    .entry(meta.title.trim().to_lowercase())
                    .or_insert(meta);
            }
        }

        let mut imported_pages = 0usize;
        let mut imported_databases = 0usize;
        let mut imported_blocks = 0usize;
        let mut root_page_ids: Vec<String> = Vec::new();

        for item in &prepared {
            // 1. Ensure ancestor folder hierarchy (coalescing with parent pages!)
            let mut cur_parent = root_parent.clone();
            let mut prefix_clean: Vec<String> = Vec::new();
            for folder_clean_name in &item.clean_dir_parts {
                prefix_clean.push(folder_clean_name.clone());
                let folder_key = prefix_clean.join("/").to_lowercase();
                if let Some(existing_folder) = clean_key_to_page.get(&folder_key) {
                    cur_parent = Some(existing_folder.id.clone());
                    continue;
                }

                let folder_id = new_id();
                let next_sort = Database::next_sibling_sort_order(&tx, cur_parent.as_deref())?;
                tx.execute(
                    "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, '📁', NULL, 'doc', 0, 0, ?4, ?5, ?5)",
                    params![folder_id, cur_parent, folder_clean_name, next_sort, ts],
                )?;
                tx.execute(
                    "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, 'paragraph', '', '', '{}', 0, ?3, ?3)",
                    params![new_id(), folder_id, ts],
                )?;

                imported_pages += 1;
                imported_blocks += 1;
                if cur_parent == root_parent {
                    root_page_ids.push(folder_id.clone());
                }

                let meta = CreatedPageMeta {
                    id: folder_id.clone(),
                    title: folder_clean_name.clone(),
                    icon: "📁".to_string(),
                    is_folder_placeholder: true,
                };
                clean_key_to_page.insert(folder_key, meta.clone());
                title_to_page
                    .insert(folder_clean_name.to_lowercase(), meta);
                cur_parent = Some(folder_id);
            }

            let is_db = item.ext == "csv";

            // Extract leading `# Heading` title from `.md` if present (standard Notion export format)
            let (final_title, body_markdown) = if !is_db {
                extract_h1_title_and_body(&item.clean_title, &item.content)
            } else {
                (item.clean_title.clone(), String::new())
            };

            // Coalesce if a synthetic folder placeholder was created earlier for this cleanKey
            let page_meta = match clean_key_to_page.get(&item.clean_key).cloned() {
                Some(existing) if existing.is_folder_placeholder && !is_db => {
                    tx.execute(
                        "UPDATE pages SET title = ?1, icon = '📄', updated_at = ?2 WHERE id = ?3",
                        params![final_title, ts, existing.id],
                    )?;
                    tx.execute("DELETE FROM blocks WHERE page_id = ?1", params![existing.id])?;
                    imported_blocks = imported_blocks.saturating_sub(1);

                    let drafts = parse_markdown_to_blocks(&body_markdown);
                    for (idx, mut draft) in drafts.into_iter().enumerate() {
                        if draft.block_type == "image" {
                            if let Some(raw_u) = draft.props.url.clone() {
                                if let Some(data_uri) = resolve_embedded_image_uri(
                                    &asset_data_uris,
                                    &clean_asset_lookup,
                                    &item.dir_path,
                                    &raw_u,
                                ) {
                                    draft.props.url = Some(data_uri);
                                    draft.plain_text =
                                        draft.props.caption.clone().unwrap_or_default();
                                }
                            }
                        }
                        tx.execute(
                            "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                            params![
                                new_id(),
                                existing.id,
                                draft.block_type,
                                draft.content,
                                draft.plain_text,
                                serde_json::to_string(&draft.props)?,
                                idx as i64,
                                ts
                            ],
                        )?;
                        imported_blocks += 1;
                    }
                    created_doc_pages.push((existing.id.clone(), item.dir_path.clone()));

                    CreatedPageMeta {
                        id: existing.id,
                        title: final_title,
                        icon: "📄".to_string(),
                        is_folder_placeholder: false,
                    }
                }
                _ => {
                    let page_id = new_id();
                    let icon = if is_db { "🗃️" } else { "📄" };
                    let page_type = if is_db { "database" } else { "doc" };
                    let next_sort =
                        Database::next_sibling_sort_order(&tx, cur_parent.as_deref())?;

                    tx.execute(
                        "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, 0, ?6, ?7, ?7)",
                        params![page_id, cur_parent, final_title, icon, page_type, next_sort, ts],
                    )?;

                    if cur_parent == root_parent {
                        root_page_ids.push(page_id.clone());
                    }

                    if is_db {
                        imported_databases += 1;
                        let row_map =
                            populate_csv_database_conn(&tx, &page_id, &item.content, &ts)?;
                        db_clean_key_to_rows.insert(item.clean_key.clone(), row_map);
                    } else {
                        imported_pages += 1;
                        let drafts = parse_markdown_to_blocks(&body_markdown);
                        for (idx, mut draft) in drafts.into_iter().enumerate() {
                            if draft.block_type == "image" {
                                if let Some(raw_u) = draft.props.url.clone() {
                                    if let Some(data_uri) = resolve_embedded_image_uri(
                                        &asset_data_uris,
                                        &clean_asset_lookup,
                                        &item.dir_path,
                                        &raw_u,
                                    ) {
                                        draft.props.url = Some(data_uri);
                                        draft.plain_text =
                                            draft.props.caption.clone().unwrap_or_default();
                                    }
                                }
                            }
                            tx.execute(
                                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                                params![
                                    new_id(),
                                    page_id,
                                    draft.block_type,
                                    draft.content,
                                    draft.plain_text,
                                    serde_json::to_string(&draft.props)?,
                                    idx as i64,
                                    ts
                                ],
                            )?;
                            imported_blocks += 1;
                        }
                        created_doc_pages.push((page_id.clone(), item.dir_path.clone()));
                    }

                    CreatedPageMeta {
                        id: page_id,
                        title: final_title,
                        icon: icon.to_string(),
                        is_folder_placeholder: false,
                    }
                }
            };

            clean_key_to_page.insert(item.clean_key.clone(), page_meta.clone());
            if let Some((no_ext, _)) = strip_doc_or_csv_ext(&item.norm_path) {
                let no_ext_lower = no_ext.to_lowercase();
                raw_no_ext_to_page.insert(no_ext_lower.clone(), page_meta.clone());
                if let Some(without_all) = no_ext_lower.strip_suffix("_all") {
                    raw_no_ext_to_page.insert(without_all.to_string(), page_meta.clone());
                }
            }
            let stem_lower = item.raw_stem.to_lowercase();
            raw_stem_to_page.insert(stem_lower.clone(), page_meta.clone());
            if let Some(without_all) = stem_lower.strip_suffix("_all") {
                raw_stem_to_page.insert(without_all.to_string(), page_meta.clone());
            }
            title_to_page.insert(page_meta.title.trim().to_lowercase(), page_meta.clone());
            title_to_page.insert(item.clean_title.trim().to_lowercase(), page_meta.clone());

            // Link database row `linked_page_id` when `<DB Folder>/<Row Title>.md` is imported
            if !is_db && !item.clean_dir_parts.is_empty() {
                let parent_clean_key = item.clean_dir_parts.join("/").to_lowercase();
                if let Some(row_map) = db_clean_key_to_rows.get(&parent_clean_key) {
                    let matched_row_id = row_map
                        .get(&page_meta.title.trim().to_lowercase())
                        .or_else(|| row_map.get(&item.clean_title.trim().to_lowercase()));
                    if let Some(rid) = matched_row_id {
                        tx.execute(
                            "UPDATE db_rows SET linked_page_id = ?1 WHERE id = ?2 AND linked_page_id IS NULL",
                            params![page_meta.id, rid],
                        )?;
                    }
                }
            }
        }

        // Second pass: rewrite relative `.md`/`.csv` links -> `nb-wiki-link` and rebuild `page_links`
        let mut resolved_links = 0usize;
        for (doc_page_id, dir_path) in &created_doc_pages {
            let blocks = Database::get_blocks_for_page_conn(&tx, doc_page_id)?;
            for blk in blocks {
                if is_raw_text_block(&blk.block_type) {
                    continue;
                }
                if blk.block_type == "table" {
                    let mut props = blk.props.clone();
                    let mut table_resolved = 0usize;
                    if let Some(ref mut headers) = props.headers {
                        for h in headers.iter_mut() {
                            if h.contains("data-md-rel-href=") {
                                let (rh, c) = rewrite_relative_links_in_html(
                                    h,
                                    doc_page_id,
                                    dir_path,
                                    &raw_no_ext_to_page,
                                    &clean_key_to_page,
                                    &raw_stem_to_page,
                                    &title_to_page,
                                );
                                if c > 0 {
                                    *h = rh;
                                    table_resolved += c;
                                }
                            }
                        }
                    }
                    if let Some(ref mut rows) = props.rows {
                        for row in rows.iter_mut() {
                            for cell in row.iter_mut() {
                                if cell.contains("data-md-rel-href=") {
                                    let (rc, c) = rewrite_relative_links_in_html(
                                        cell,
                                        doc_page_id,
                                        dir_path,
                                        &raw_no_ext_to_page,
                                        &clean_key_to_page,
                                        &raw_stem_to_page,
                                        &title_to_page,
                                    );
                                    if c > 0 {
                                        *cell = rc;
                                        table_resolved += c;
                                    }
                                }
                            }
                        }
                    }
                    if table_resolved > 0 {
                        resolved_links += table_resolved;
                        let updated_plain =
                            effective_plain_text(&blk.block_type, &blk.content, "", &props);
                        let props_json = serde_json::to_string(&props)?;
                        tx.execute(
                            "UPDATE blocks SET plain_text = ?1, props_json = ?2 WHERE id = ?3",
                            params![updated_plain, props_json, blk.id],
                        )?;
                    }
                    continue;
                }
                if !blk.content.contains("data-md-rel-href=") {
                    continue;
                }
                let (rewritten_html, count) = rewrite_relative_links_in_html(
                    &blk.content,
                    doc_page_id,
                    dir_path,
                    &raw_no_ext_to_page,
                    &clean_key_to_page,
                    &raw_stem_to_page,
                    &title_to_page,
                );
                if count > 0 {
                    resolved_links += count;
                    let updated_plain =
                        effective_plain_text(&blk.block_type, &rewritten_html, "", &blk.props);
                    tx.execute(
                        "UPDATE blocks SET content = ?1, plain_text = ?2 WHERE id = ?3",
                        params![rewritten_html, updated_plain, blk.id],
                    )?;
                }
            }
            Database::rebuild_page_links_internal(&tx, doc_page_id)?;
        }

        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);

        let first_page_id = root_page_ids
            .first()
            .cloned()
            .or_else(|| created_doc_pages.first().map(|(id, _)| id.clone()));

        Ok(BatchImportResult {
            imported_pages,
            imported_databases,
            imported_blocks,
            resolved_links,
            root_page_ids,
            first_page_id,
        })
    }
}

fn extract_h1_title_and_body(fallback_clean_title: &str, raw_markdown: &str) -> (String, String) {
    let without_bom = raw_markdown
        .strip_prefix('\u{feff}')
        .unwrap_or(raw_markdown);
    let normalized = without_bom.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    if let Some((first_idx, first_line)) = lines
        .iter()
        .enumerate()
        .find(|(_, l)| !l.trim().is_empty())
    {
        if let Some(h1_raw) = first_line.trim().strip_prefix("# ") {
            let clean_h1 = strip_html(&inline_markdown_to_html(h1_raw.trim()));
            let final_title = if !clean_h1.is_empty() {
                strip_notion_uuid(&clean_h1)
            } else {
                fallback_clean_title.to_string()
            };
            let rest = lines[first_idx + 1..].join("\n");
            return (final_title, rest);
        }
    }

    let title = if fallback_clean_title.trim().is_empty() {
        "无标题".to_string()
    } else {
        fallback_clean_title.to_string()
    };
    (title, normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    #[test]
    fn test_strip_notion_uuid_and_rfc4180_csv() {
        assert_eq!(
            strip_notion_uuid("Engineering 0123456789abcdef0123456789abcdef"),
            "Engineering"
        );
        assert_eq!(
            strip_notion_uuid("Tasks 0123456789abcdef0123456789abcdef_all"),
            "Tasks"
        );
        assert_eq!(
            strip_notion_uuid("产品规划 01234567-89ab-cdef-0123-456789abcdef"),
            "产品规划"
        );
        assert_eq!(
            strip_notion_uuid("0123456789abcdef0123456789abcdef"),
            "无标题"
        );

        let csv = "\u{feff}Name,Status,Notes\r\n\"Auth, SSO\",In Progress,\"Line 1\n\"\"Quoted\"\" Line 2\"\r\n";
        let parsed = parse_rfc4180_csv(csv);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], vec!["Name", "Status", "Notes"]);
        assert_eq!(parsed[1][0], "Auth, SSO");
        assert_eq!(parsed[1][1], "In Progress");
        assert_eq!(parsed[1][2], "Line 1\n\"Quoted\" Line 2");
    }

    #[test]
    fn test_import_markdown_tree_hierarchy_and_backlinks() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let entries = vec![
            MarkdownTreeEntry {
                relative_path: "KnowledgeBase/Overview.md".into(),
                content: "# 知识库总览\n\n请参阅配置指南 [安装手册](./Guides/Setup.md) 了解详情。"
                    .into(),
            },
            MarkdownTreeEntry {
                relative_path: "KnowledgeBase/Guides/Setup.md".into(),
                content: "# 安装手册\n\n- [x] 安装 Rust\n- [ ] 构建桌面包".into(),
            },
        ];

        let res = db.import_markdown_tree(entries, None).unwrap();
        // Container folders: KnowledgeBase + Guides, plus Overview + Setup = 4 doc pages
        assert_eq!(res.imported_pages, 4);
        assert_eq!(res.imported_databases, 0);
        assert_eq!(res.resolved_links, 1);
        assert_eq!(res.root_page_ids.len(), 1);

        let pages = db.list_pages().unwrap();
        let setup_page = pages.iter().find(|p| p.title == "安装手册").unwrap();
        let overview_page = pages.iter().find(|p| p.title == "知识库总览").unwrap();
        let guides_folder = pages.iter().find(|p| p.title == "Guides").unwrap();
        assert_eq!(setup_page.parent_id.as_deref(), Some(guides_folder.id.as_str()));

        // Verify relative link was rewritten to nb-wiki-link and backlink was populated!
        let setup_detail = db.get_page_detail(&setup_page.id).unwrap();
        assert_eq!(setup_detail.backlinks.len(), 1);
        assert_eq!(setup_detail.backlinks[0].source_page_id, overview_page.id);

        let overview_detail = db.get_page_detail(&overview_page.id).unwrap();
        assert!(overview_detail.blocks[0]
            .content
            .contains(&format!("data-page-id=\"{}\"", setup_page.id)));
        assert!(overview_detail.blocks[0].content.contains("class=\"nb-wiki-link\""));
    }

    #[test]
    fn test_import_notion_zip_nested_uuid_csv_image_and_backlinks() {
        let db = Database::open_in_memory_unseeded().unwrap();

        // Build inner Export-xxxx.zip containing Notion pages, CSV database, PNG image, and cross-links
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut inner_buf = Cursor::new(Vec::new());
        {
            let mut inner_zip = ZipWriter::new(&mut inner_buf);

            inner_zip
                .start_file(
                    "Export-99887766/Engineering 0123456789abcdef0123456789abcdef.md",
                    opts,
                )
                .unwrap();
            inner_zip
                .write_all(
                    b"# Engineering\n\nCore architecture is documented in [Architecture](Engineering%200123456789abcdef0123456789abcdef/Architecture%20fedcba9876543210fedcba9876543210.md) and tracked in [Tasks](Tasks%20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_all.csv).\n",
                )
                .unwrap();

            inner_zip
                .start_file(
                    "Export-99887766/Engineering 0123456789abcdef0123456789abcdef/Architecture fedcba9876543210fedcba9876543210.md",
                    opts,
                )
                .unwrap();
            inner_zip
                .write_all(
                    b"# Architecture\n\n$$ \\int_0^\\infty e^{-x^2} dx < \\infty $$\n\n![System Diagram](diagram%201.png)\n",
                )
                .unwrap();

            // Tiny valid PNG header bytes for inline base64 verification
            let fake_png: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
            inner_zip
                .start_file(
                    "Export-99887766/Engineering 0123456789abcdef0123456789abcdef/diagram 1.png",
                    opts,
                )
                .unwrap();
            inner_zip.write_all(&fake_png).unwrap();

            inner_zip
                .start_file(
                    "Export-99887766/Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_all.csv",
                    opts,
                )
                .unwrap();
            inner_zip
                .write_all(
                    b"Name,Status,Priority,Shipped,Points,Target Date,Spec URL\nAuth Flow,In Progress,P0,No,8,\"November 20, 2026\",https://example.com/auth\nSearch Engine,Done,P0,Yes,5,2026-11-15,https://example.com/search\n",
                )
                .unwrap();

            inner_zip
                .start_file(
                    "Export-99887766/Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Auth Flow bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.md",
                    opts,
                )
                .unwrap();
            inner_zip
                .write_all(b"# Auth Flow\n\nOAuth2 + PKCE implementation notes.\n")
                .unwrap();

            inner_zip.finish().unwrap();
        }
        let inner_bytes = inner_buf.into_inner();

        // Wrap inner zip inside an outer Notion workspace export `.zip`
        let mut outer_buf = Cursor::new(Vec::new());
        {
            let mut outer_zip = ZipWriter::new(&mut outer_buf);
            outer_zip
                .start_file("Export-99887766-part-1.zip", opts)
                .unwrap();
            outer_zip.write_all(&inner_bytes).unwrap();
            outer_zip.finish().unwrap();
        }
        let outer_b64 =
            base64::engine::general_purpose::STANDARD.encode(outer_buf.into_inner());

        let result = db.import_notion_zip_bytes(&outer_b64, None).unwrap();
        // Pages: Engineering, Architecture, Auth Flow = 3 doc pages (NO duplicate Engineering folder!)
        // Databases: Tasks = 1 database page
        assert_eq!(result.imported_pages, 3);
        assert_eq!(result.imported_databases, 1);
        assert_eq!(result.resolved_links, 2);

        let all_pages = db.list_pages().unwrap();
        assert_eq!(all_pages.len(), 4);

        let eng = all_pages.iter().find(|p| p.title == "Engineering").unwrap();
        let arch = all_pages.iter().find(|p| p.title == "Architecture").unwrap();
        let tasks_db_page = all_pages.iter().find(|p| p.title == "Tasks").unwrap();
        let auth_row_page = all_pages.iter().find(|p| p.title == "Auth Flow").unwrap();

        // Coalesced hierarchy: Architecture is direct child of Engineering!
        assert_eq!(eng.parent_id, None);
        assert_eq!(arch.parent_id.as_deref(), Some(eng.id.as_str()));
        assert_eq!(tasks_db_page.page_type, "database");
        assert_eq!(auth_row_page.parent_id.as_deref(), Some(tasks_db_page.id.as_str()));

        // Verify Architecture blocks: raw unescaped math + base64 embedded PNG!
        let arch_detail = db.get_page_detail(&arch.id).unwrap();
        let math_blk = arch_detail
            .blocks
            .iter()
            .find(|b| b.block_type == "math")
            .expect("math block");
        assert!(math_blk.content.contains("< \\infty"));
        assert!(!math_blk.content.contains("&lt;"));

        let img_blk = arch_detail
            .blocks
            .iter()
            .find(|b| b.block_type == "image")
            .expect("image block");
        assert!(img_blk
            .props
            .url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(img_blk.props.caption.as_deref(), Some("System Diagram"));

        // Verify backlinks on Architecture and Tasks from Engineering!
        assert_eq!(arch_detail.backlinks.len(), 1);
        assert_eq!(arch_detail.backlinks[0].source_page_id, eng.id);

        let tasks_detail = db.get_page_detail(&tasks_db_page.id).unwrap();
        assert_eq!(tasks_detail.backlinks.len(), 1);
        assert_eq!(tasks_detail.backlinks[0].source_page_id, eng.id);

        // Verify CSV database column type inference & linked row page!
        let db_full = db.get_database(&tasks_db_page.id).unwrap();
        let col_types: Vec<&str> = db_full.columns.iter().map(|c| c.col_type.as_str()).collect();
        assert_eq!(
            col_types,
            vec!["title", "status", "select", "checkbox", "number", "date", "url"]
        );
        assert_eq!(db_full.rows.len(), 2);
        assert_eq!(
            db_full.rows[0].linked_page_id.as_deref(),
            Some(auth_row_page.id.as_str())
        );
        let date_col_id = &db_full.columns[5].id;
        assert_eq!(
            db_full.rows[0].cells.get(date_col_id).and_then(|v| v.as_str()),
            Some("2026-11-20")
        );
    }

    #[test]
    fn test_import_local_paths_directory_and_files() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let temp_root = std::env::temp_dir().join(format!("notion_import_test_{}", new_id()));
        let sub_dir = temp_root.join("Specs");
        std::fs::create_dir_all(&sub_dir).unwrap();

        std::fs::write(
            sub_dir.join("API.md"),
            "# API 设计\n\n详见 [数据模型](Schema.md) 以及本地架构图：\n\n![架构](logo.svg)\n",
        )
        .unwrap();
        std::fs::write(sub_dir.join("Schema.md"), "# 数据模型\n\nSQLite WAL 表结构。").unwrap();
        std::fs::write(
            sub_dir.join("logo.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        )
        .unwrap();

        let res = db
            .import_local_paths(vec![sub_dir.to_string_lossy().into_owned()], None)
            .unwrap();
        let _ = std::fs::remove_dir_all(&temp_root);

        // Specs folder container + API + Schema = 3 pages, 1 resolved link
        assert_eq!(res.imported_pages, 3);
        assert_eq!(res.resolved_links, 1);

        let pages = db.list_pages().unwrap();
        let api_page = pages.iter().find(|p| p.title == "API 设计").unwrap();
        let schema_page = pages.iter().find(|p| p.title == "数据模型").unwrap();

        let api_detail = db.get_page_detail(&api_page.id).unwrap();
        let img = api_detail
            .blocks
            .iter()
            .find(|b| b.block_type == "image")
            .unwrap();
        assert!(img
            .props
            .url
            .as_deref()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));

        let schema_detail = db.get_page_detail(&schema_page.id).unwrap();
        assert_eq!(schema_detail.backlinks.len(), 1);
        assert_eq!(schema_detail.backlinks[0].source_page_id, api_page.id);
    }
}
