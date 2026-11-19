//! 独立索引库 `kb_index.db` 的建表、工作区快照与增量同步逻辑。
//!
//! 关键约束：
//! - 绝不向 `xynote.db` 写入任何 SAG2 表或触发器；
//! - 总是先从 `xynote.db` 读取纯内存快照并释放锁，再写入 `kb_index.db`，彻底避免双锁死锁；
//! - 关闭/清除时可整库物理删除，不留残留。

use crate::db::{effective_plain_text, now_iso, Database};
use crate::folders::is_text_file;
use crate::kb::tokenizer::{extract_entities, tokenize_for_fts};
use crate::markdown::{derive_markdown_title, strip_html};
use crate::models::{AppError, BlockProps, SelectOption};
use crate::storage::{clean_display_path, normalize_path_key};
use crate::textfile::{decode as decode_text_bytes, looks_binary};
use crate::win_dialogs::normalize_win32_path_str;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KB_DB_FILENAME: &str = "kb_index.db";

const SKIPPED_DISK_DIRS: [&str; 8] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
];
const MAX_DISK_FILES: usize = 3000;
const MAX_DISK_FILE_BYTES: u64 = 1024 * 1024; // 1 MB per text file

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountedFolderRoot {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct BlockSnapshot {
    pub id: String,
    pub block_type: String,
    pub content: String,
    pub plain_text: String,
    pub props_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct DbColSnapshot {
    pub id: String,
    pub name: String,
    pub col_type: String,
    pub options: Vec<SelectOption>,
}

#[derive(Debug, Clone)]
pub struct DbRowSnapshot {
    pub id: String,
    pub cells_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct PageSnapshot {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub page_type: String,
    pub updated_at: String,
    pub blocks: Vec<BlockSnapshot>,
    pub db_cols: Vec<DbColSnapshot>,
    pub db_rows: Vec<DbRowSnapshot>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSnapshot {
    pub pages: Vec<PageSnapshot>,
    pub page_links: Vec<(String, String)>,
    pub mounted_folders: Vec<MountedFolderRoot>,
}

#[derive(Debug, Clone)]
struct EventDraft {
    event_id: String,
    block_id: Option<String>,
    line_start: Option<i64>,
    heading_path: String,
    body: String,
    raw_content: String,
    extra_db_vals: Vec<String>,
    event_time: String,
}

const KB_SCHEMA_SQL: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS kb_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_sources (
    source_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    title TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    root_name TEXT NOT NULL DEFAULT '',
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_events (
    event_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kb_sources(source_id) ON DELETE CASCADE,
    block_id TEXT NULL,
    line_start INTEGER NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    search_tokens TEXT NOT NULL,
    event_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_entities (
    entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    norm_name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    doc_freq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kb_event_entities (
    event_id TEXT NOT NULL REFERENCES kb_events(event_id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES kb_entities(entity_id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 1.0,
    signal TEXT NOT NULL DEFAULT 'term',
    PRIMARY KEY (event_id, entity_id)
);

CREATE TABLE IF NOT EXISTS kb_page_links (
    source_page_id TEXT NOT NULL,
    target_page_id TEXT NOT NULL,
    PRIMARY KEY (source_page_id, target_page_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_events_fts USING fts5(
    event_id UNINDEXED,
    title_tokens,
    heading_tokens,
    body_tokens,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX IF NOT EXISTS idx_kb_events_source ON kb_events(source_id);
CREATE INDEX IF NOT EXISTS idx_kb_ee_entity ON kb_event_entities(entity_id, event_id);
CREATE INDEX IF NOT EXISTS idx_kb_ee_event ON kb_event_entities(event_id);
CREATE INDEX IF NOT EXISTS idx_kb_entities_df ON kb_entities(doc_freq);
CREATE INDEX IF NOT EXISTS idx_kb_page_links_src ON kb_page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_kb_page_links_tgt ON kb_page_links(target_page_id);
";

/// 打开并初始化独立 `kb_index.db` 连接（仅在模块开启时调用）
pub fn open_kb_conn(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch(KB_SCHEMA_SQL)?;
    conn.execute(
        "INSERT OR IGNORE INTO kb_meta (key, value) VALUES ('schema_version', '1')",
        [],
    )?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_kb_conn_in_memory() -> Result<Connection, AppError> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(KB_SCHEMA_SQL)?;
    conn.execute(
        "INSERT OR IGNORE INTO kb_meta (key, value) VALUES ('schema_version', '1')",
        [],
    )?;
    Ok(conn)
}

/// 彻底物理清理 `kb_index.db` 连同 WAL/SHM 旁路文件（须先 drop SQLite 连接）
pub fn delete_kb_index_files(db_path: &Path) {
    let base = db_path.to_string_lossy().into_owned();
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{}", base, suffix));
        if p.exists() {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub fn kb_index_disk_stats(db_path: &Path) -> (bool, u64) {
    let base = db_path.to_string_lossy().into_owned();
    let main_meta = std::fs::metadata(db_path).ok();
    let wal_meta = std::fs::metadata(format!("{}-wal", base)).ok();
    let exists = main_meta.as_ref().is_some_and(|m| m.is_file());
    let size = main_meta.map(|m| m.len()).unwrap_or(0) + wal_meta.map(|m| m.len()).unwrap_or(0);
    (exists, size)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{:02x}", b);
    }
    out
}

fn system_time_iso(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339()
}

fn read_page_snapshot_conn(conn: &Connection, page_id: &str) -> Result<Option<PageSnapshot>, AppError> {
    let page_row: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT id, title, icon, page_type, updated_at
             FROM pages
             WHERE id = ?1 AND is_trashed = 0",
            params![page_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;

    let Some((id, title, icon, page_type, updated_at)) = page_row else {
        return Ok(None);
    };

    let mut b_stmt = conn.prepare(
        "SELECT id, block_type, content, plain_text, props_json, updated_at
         FROM blocks
         WHERE page_id = ?1
         ORDER BY sort_order ASC, rowid ASC",
    )?;
    let blocks: Vec<BlockSnapshot> = b_stmt
        .query_map(params![&id], |r| {
            Ok(BlockSnapshot {
                id: r.get(0)?,
                block_type: r.get(1)?,
                content: r.get(2)?,
                plain_text: r.get(3)?,
                props_json: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut db_cols = Vec::new();
    let mut db_rows = Vec::new();
    if page_type == "database" {
        let mut c_stmt = conn.prepare(
            "SELECT id, name, col_type, options_json
             FROM db_columns
             WHERE page_id = ?1
             ORDER BY sort_order ASC, rowid ASC",
        )?;
        db_cols = c_stmt
            .query_map(params![&id], |r| {
                let opts_raw: String = r.get(3)?;
                let options: Vec<SelectOption> = serde_json::from_str(&opts_raw).unwrap_or_default();
                Ok(DbColSnapshot {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    col_type: r.get(2)?,
                    options,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut r_stmt = conn.prepare(
            "SELECT id, cells_json, updated_at
             FROM db_rows
             WHERE page_id = ?1
             ORDER BY sort_order ASC, created_at ASC",
        )?;
        db_rows = r_stmt
            .query_map(params![&id], |r| {
                Ok(DbRowSnapshot {
                    id: r.get(0)?,
                    cells_json: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    Ok(Some(PageSnapshot {
        id,
        title,
        icon,
        page_type,
        updated_at,
        blocks,
        db_cols,
        db_rows,
    }))
}

pub fn snapshot_single_page(db: &Database, page_id: &str) -> Result<(Option<PageSnapshot>, Vec<(String, String)>), AppError> {
    let conn = db.lock()?;
    let page = read_page_snapshot_conn(&conn, page_id)?;
    let mut link_stmt = conn.prepare(
        "SELECT l.source_page_id, l.target_page_id
         FROM page_links l
         JOIN pages ps ON ps.id = l.source_page_id AND ps.is_trashed = 0
         JOIN pages pt ON pt.id = l.target_page_id AND pt.is_trashed = 0",
    )?;
    let links: Vec<(String, String)> = link_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((page, links))
}

pub fn snapshot_workspace(db: &Database) -> Result<WorkspaceSnapshot, AppError> {
    let conn = db.lock()?;
    let mut p_stmt = conn.prepare(
        "SELECT id FROM pages WHERE is_trashed = 0 ORDER BY sort_order ASC, rowid ASC",
    )?;
    let page_ids: Vec<String> = p_stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut pages = Vec::with_capacity(page_ids.len());
    for pid in page_ids {
        if let Some(p) = read_page_snapshot_conn(&conn, &pid)? {
            pages.push(p);
        }
    }

    let mut link_stmt = conn.prepare(
        "SELECT l.source_page_id, l.target_page_id
         FROM page_links l
         JOIN pages ps ON ps.id = l.source_page_id AND ps.is_trashed = 0
         JOIN pages pt ON pt.id = l.target_page_id AND pt.is_trashed = 0",
    )?;
    let page_links: Vec<(String, String)> = link_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let folders_raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'workspaceFolders'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let mounted_folders: Vec<MountedFolderRoot> = folders_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<MountedFolderRoot>>(s).ok())
        .unwrap_or_default();

    Ok(WorkspaceSnapshot {
        pages,
        page_links,
        mounted_folders,
    })
}

fn resolve_db_cell_text(col: &DbColSnapshot, val: &Value) -> Vec<String> {
    let opt_label = |oid: &str| -> String {
        col.options
            .iter()
            .find(|o| o.id == oid)
            .map(|o| o.label.clone())
            .unwrap_or_else(|| oid.to_string())
    };
    match val {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else if matches!(col.col_type.as_str(), "status" | "select") {
                vec![opt_label(trimmed)]
            } else {
                vec![trimmed.to_string()]
            }
        }
        Value::Array(arr) => {
            let mut out = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str().map(str::trim).filter(|v| !v.is_empty()) {
                    if col.col_type == "multi_select" || col.col_type == "select" {
                        out.push(opt_label(s));
                    } else {
                        out.push(s.to_string());
                    }
                }
            }
            out
        }
        Value::Number(n) => vec![n.to_string()],
        Value::Bool(b) => {
            if *b {
                vec![col.name.clone()]
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

fn build_page_events(page: &PageSnapshot, source_id: &str) -> Vec<EventDraft> {
    let mut drafts: Vec<EventDraft> = Vec::new();

    if page.page_type == "database" {
        for (idx, row) in page.db_rows.iter().enumerate() {
            let cells: serde_json::Map<String, Value> =
                serde_json::from_str(&row.cells_json).unwrap_or_default();
            let mut parts = Vec::new();
            let mut db_vals = Vec::new();
            for col in &page.db_cols {
                if let Some(val) = cells.get(&col.id) {
                    let resolved = resolve_db_cell_text(col, val);
                    if !resolved.is_empty() {
                        parts.push(format!("{}: {}", col.name, resolved.join(", ")));
                        if matches!(
                            col.col_type.as_str(),
                            "title" | "status" | "select" | "multi_select"
                        ) {
                            db_vals.extend(resolved);
                        }
                    }
                }
            }
            let body = parts.join(" · ");
            if body.trim().is_empty() {
                continue;
            }
            drafts.push(EventDraft {
                event_id: format!("{}#r{}", source_id, idx),
                block_id: None,
                line_start: None,
                heading_path: String::new(),
                body: body.clone(),
                raw_content: body,
                extra_db_vals: db_vals,
                event_time: row.updated_at.clone(),
            });
        }
        if drafts.is_empty() {
            drafts.push(EventDraft {
                event_id: format!("{}#title", source_id),
                block_id: None,
                line_start: None,
                heading_path: String::new(),
                body: page.title.clone(),
                raw_content: page.title.clone(),
                extra_db_vals: Vec::new(),
                event_time: page.updated_at.clone(),
            });
        }
        return drafts;
    }

    // 文档页面：按标题树状栈 + 段落边界切分语义块，精确锚定 block_id
    let mut h1: Option<String> = None;
    let mut h2: Option<String> = None;
    let mut h3: Option<String> = None;

    let current_heading_path = |a: &Option<String>, b: &Option<String>, c: &Option<String>| {
        [a.as_deref(), b.as_deref(), c.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" / ")
    };

    let mut cur_block_id: Option<String> = None;
    let mut cur_heading = String::new();
    let mut cur_body = String::new();
    let mut cur_raw = String::new();
    let mut cur_time = page.updated_at.clone();

    let flush_chunk = |drafts: &mut Vec<EventDraft>,
                       source_id: &str,
                       bid: &mut Option<String>,
                       heading: &str,
                       body: &mut String,
                       raw: &mut String,
                       ts: &str| {
        let trimmed_body = body.trim();
        if !trimmed_body.is_empty() {
            let idx = drafts.len();
            drafts.push(EventDraft {
                event_id: format!("{}#c{}", source_id, idx),
                block_id: bid.take(),
                line_start: None,
                heading_path: heading.to_string(),
                body: trimmed_body.to_string(),
                raw_content: std::mem::take(raw),
                extra_db_vals: Vec::new(),
                event_time: ts.to_string(),
            });
        } else {
            *bid = None;
            raw.clear();
        }
        body.clear();
    };

    for blk in &page.blocks {
        let props: BlockProps = serde_json::from_str(&blk.props_json).unwrap_or_default();
        let text = effective_plain_text(&blk.block_type, &blk.content, &blk.plain_text, &props);
        let clean = text.trim();

        match blk.block_type.as_str() {
            "heading1" => {
                flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
                h1 = (!clean.is_empty()).then(|| clean.to_string());
                h2 = None;
                h3 = None;
                cur_heading = current_heading_path(&h1, &h2, &h3);
                if !clean.is_empty() {
                    cur_block_id = Some(blk.id.clone());
                    cur_body = clean.to_string();
                    cur_raw = blk.content.clone();
                    cur_time = blk.updated_at.clone();
                }
                continue;
            }
            "heading2" => {
                flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
                h2 = (!clean.is_empty()).then(|| clean.to_string());
                h3 = None;
                cur_heading = current_heading_path(&h1, &h2, &h3);
                if !clean.is_empty() {
                    cur_block_id = Some(blk.id.clone());
                    cur_body = clean.to_string();
                    cur_raw = blk.content.clone();
                    cur_time = blk.updated_at.clone();
                }
                continue;
            }
            "heading3" => {
                flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
                h3 = (!clean.is_empty()).then(|| clean.to_string());
                cur_heading = current_heading_path(&h1, &h2, &h3);
                if !clean.is_empty() {
                    cur_block_id = Some(blk.id.clone());
                    cur_body = clean.to_string();
                    cur_raw = blk.content.clone();
                    cur_time = blk.updated_at.clone();
                }
                continue;
            }
            "divider" => {
                flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
                continue;
            }
            _ => {}
        }

        if clean.is_empty() && props.children_text.as_deref().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }

        let mut combined_clean = clean.to_string();
        if let Some(sub) = props.children_text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let sub_plain = strip_html(sub);
            if !sub_plain.is_empty() {
                if !combined_clean.is_empty() {
                    combined_clean.push('\n');
                }
                combined_clean.push_str(&sub_plain);
            }
        }

        let is_standalone = matches!(
            blk.block_type.as_str(),
            "code" | "table" | "callout" | "quote" | "mermaid" | "math" | "toggle"
        );
        let cur_chars = cur_body.chars().count();
        let next_chars = combined_clean.chars().count();

        if is_standalone || (cur_chars > 0 && cur_chars + next_chars > 420) {
            flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
        }

        if cur_block_id.is_none() {
            cur_block_id = Some(blk.id.clone());
            cur_heading = current_heading_path(&h1, &h2, &h3);
            cur_time = blk.updated_at.clone();
        }
        if !cur_body.is_empty() {
            cur_body.push('\n');
            cur_raw.push('\n');
        }
        cur_body.push_str(&combined_clean);
        cur_raw.push_str(&blk.content);

        if is_standalone {
            flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);
        }
    }

    flush_chunk(&mut drafts, source_id, &mut cur_block_id, &cur_heading, &mut cur_body, &mut cur_raw, &cur_time);

    if drafts.is_empty() {
        drafts.push(EventDraft {
            event_id: format!("{}#title", source_id),
            block_id: None,
            line_start: None,
            heading_path: String::new(),
            body: page.title.clone(),
            raw_content: page.title.clone(),
            extra_db_vals: Vec::new(),
            event_time: page.updated_at.clone(),
        });
    }

    drafts
}

fn build_disk_file_events(source_id: &str, title: &str, text: &str, event_time: &str) -> Vec<EventDraft> {
    let mut drafts: Vec<EventDraft> = Vec::new();
    let mut h1: Option<String> = None;
    let mut h2: Option<String> = None;
    let mut h3: Option<String> = None;
    let mut in_fence = false;

    let heading_str = |a: &Option<String>, b: &Option<String>, c: &Option<String>| {
        [a.as_deref(), b.as_deref(), c.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" / ")
    };

    let mut cur_line: Option<i64> = None;
    let mut cur_heading = String::new();
    let mut cur_buf = String::new();

    let flush = |drafts: &mut Vec<EventDraft>,
                 source_id: &str,
                 line_start: &mut Option<i64>,
                 heading: &str,
                 buf: &mut String,
                 ts: &str| {
        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            let idx = drafts.len();
            drafts.push(EventDraft {
                event_id: format!("{}#l{}", source_id, idx),
                block_id: None,
                line_start: line_start.take(),
                heading_path: heading.to_string(),
                body: trimmed.to_string(),
                raw_content: trimmed.to_string(),
                extra_db_vals: Vec::new(),
                event_time: ts.to_string(),
            });
        } else {
            *line_start = None;
        }
        buf.clear();
    };

    for (idx, line) in text.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }

        if !in_fence {
            if let Some(rest) = trimmed.strip_prefix("# ") {
                flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);
                h1 = Some(rest.trim().to_string());
                h2 = None;
                h3 = None;
                cur_heading = heading_str(&h1, &h2, &h3);
                cur_line = Some(line_no);
                cur_buf.push_str(rest.trim());
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("## ") {
                flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);
                h2 = Some(rest.trim().to_string());
                h3 = None;
                cur_heading = heading_str(&h1, &h2, &h3);
                cur_line = Some(line_no);
                cur_buf.push_str(rest.trim());
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("### ") {
                flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);
                h3 = Some(rest.trim().to_string());
                cur_heading = heading_str(&h1, &h2, &h3);
                cur_line = Some(line_no);
                cur_buf.push_str(rest.trim());
                continue;
            }
            if trimmed.is_empty() && cur_buf.chars().count() >= 180 {
                flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);
                continue;
            }
        }

        if trimmed.is_empty() && cur_buf.is_empty() {
            continue;
        }
        if cur_buf.chars().count() + trimmed.chars().count() > 450 {
            flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);
        }
        if cur_line.is_none() {
            cur_line = Some(line_no);
            cur_heading = heading_str(&h1, &h2, &h3);
        }
        if !cur_buf.is_empty() {
            cur_buf.push('\n');
        }
        cur_buf.push_str(trimmed);
    }

    flush(&mut drafts, source_id, &mut cur_line, &cur_heading, &mut cur_buf, event_time);

    if drafts.is_empty() && !title.trim().is_empty() {
        drafts.push(EventDraft {
            event_id: format!("{}#title", source_id),
            block_id: None,
            line_start: Some(1),
            heading_path: String::new(),
            body: title.to_string(),
            raw_content: title.to_string(),
            extra_db_vals: Vec::new(),
            event_time: event_time.to_string(),
        });
    }

    drafts
}

#[allow(clippy::too_many_arguments)]
fn write_source_and_events(
    tx: &rusqlite::Transaction<'_>,
    source_id: &str,
    kind: &str,
    ref_id: &str,
    title: &str,
    icon: &str,
    root_name: &str,
    mtime_ms: i64,
    file_size: i64,
    content_hash: &str,
    updated_at: &str,
    drafts: &[EventDraft],
) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM kb_events_fts WHERE event_id IN (SELECT event_id FROM kb_events WHERE source_id = ?1)",
        params![source_id],
    )?;
    tx.execute("DELETE FROM kb_events WHERE source_id = ?1", params![source_id])?;

    tx.execute(
        "INSERT INTO kb_sources (source_id, kind, ref_id, title, icon, root_name, mtime_ms, file_size, content_hash, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(source_id) DO UPDATE SET
           kind = excluded.kind,
           ref_id = excluded.ref_id,
           title = excluded.title,
           icon = excluded.icon,
           root_name = excluded.root_name,
           mtime_ms = excluded.mtime_ms,
           file_size = excluded.file_size,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at",
        params![
            source_id,
            kind,
            ref_id,
            title,
            icon,
            root_name,
            mtime_ms,
            file_size,
            content_hash,
            updated_at
        ],
    )?;

    let title_tokens = tokenize_for_fts(title);

    for d in drafts {
        let heading_tokens = tokenize_for_fts(&d.heading_path);
        let body_tokens = tokenize_for_fts(&d.body);
        tx.execute(
            "INSERT INTO kb_events (event_id, source_id, block_id, line_start, heading_path, body, search_tokens, event_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                d.event_id,
                source_id,
                d.block_id,
                d.line_start,
                d.heading_path,
                d.body,
                body_tokens,
                d.event_time
            ],
        )?;
        tx.execute(
            "INSERT INTO kb_events_fts (event_id, title_tokens, heading_tokens, body_tokens)
             VALUES (?1, ?2, ?3, ?4)",
            params![d.event_id, title_tokens, heading_tokens, body_tokens],
        )?;

        let entities = extract_entities(
            title,
            &d.heading_path,
            &d.body,
            &d.raw_content,
            &d.extra_db_vals,
        );
        for ent in entities {
            tx.execute(
                "INSERT INTO kb_entities (norm_name, display_name, entity_type, doc_freq)
                 VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT(norm_name) DO UPDATE SET
                   display_name = CASE
                     WHEN length(excluded.display_name) >= length(kb_entities.display_name) THEN excluded.display_name
                     ELSE kb_entities.display_name
                   END,
                   entity_type = CASE
                     WHEN excluded.entity_type IN ('wiki_link', 'tag', 'heading') THEN excluded.entity_type
                     ELSE kb_entities.entity_type
                   END",
                params![ent.norm_name, ent.display_name, ent.entity_type],
            )?;
            let ent_id: i64 = tx.query_row(
                "SELECT entity_id FROM kb_entities WHERE norm_name = ?1",
                params![ent.norm_name],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO kb_event_entities (event_id, entity_id, weight, signal)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(event_id, entity_id) DO UPDATE SET
                   weight = MAX(kb_event_entities.weight, excluded.weight)",
                params![d.event_id, ent_id, ent.weight, ent.entity_type],
            )?;
        }
    }

    Ok(())
}

fn delete_source_tx(tx: &rusqlite::Transaction<'_>, source_id: &str) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM kb_events_fts WHERE event_id IN (SELECT event_id FROM kb_events WHERE source_id = ?1)",
        params![source_id],
    )?;
    tx.execute("DELETE FROM kb_sources WHERE source_id = ?1", params![source_id])?;
    Ok(())
}

fn refresh_entity_doc_freqs(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "UPDATE kb_entities SET doc_freq = (
            SELECT COUNT(DISTINCT e.source_id)
            FROM kb_event_entities ee
            JOIN kb_events e ON e.event_id = ee.event_id
            WHERE ee.entity_id = kb_entities.entity_id
        );
        DELETE FROM kb_entities WHERE doc_freq = 0;",
    )?;
    Ok(())
}

fn replace_page_links(conn: &mut Connection, links: &[(String, String)]) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM kb_page_links", [])?;
    for (src, tgt) in links {
        tx.execute(
            "INSERT OR IGNORE INTO kb_page_links (source_page_id, target_page_id) VALUES (?1, ?2)",
            params![src, tgt],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn page_snapshot_hash(page: &PageSnapshot) -> String {
    let mut h = Sha256::new();
    h.update(page.title.as_bytes());
    h.update(b"|");
    h.update(page.icon.as_bytes());
    h.update(b"|");
    h.update(page.page_type.as_bytes());
    for b in &page.blocks {
        h.update(b"\nB:");
        h.update(b.id.as_bytes());
        h.update(b"|");
        h.update(b.block_type.as_bytes());
        h.update(b"|");
        h.update(b.content.as_bytes());
        h.update(b"|");
        h.update(b.plain_text.as_bytes());
        h.update(b"|");
        h.update(b.props_json.as_bytes());
    }
    for c in &page.db_cols {
        h.update(b"\nC:");
        h.update(c.id.as_bytes());
        h.update(b"|");
        h.update(c.name.as_bytes());
        h.update(b"|");
        h.update(c.col_type.as_bytes());
    }
    for r in &page.db_rows {
        h.update(b"\nR:");
        h.update(r.id.as_bytes());
        h.update(b"|");
        h.update(r.cells_json.as_bytes());
    }
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{:02x}", byte);
    }
    out
}

fn is_indexable_disk_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "md" | "markdown" | "mdown" | "mkd" | "txt") || is_text_file(path)
}

fn is_hidden_or_skipped_name(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('~')
        || name.eq_ignore_ascii_case("desktop.ini")
        || SKIPPED_DISK_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
}

fn collect_mounted_files(roots: &[MountedFolderRoot]) -> Vec<(PathBuf, String)> {
    let mut files = Vec::new();
    let mut seen_paths = HashSet::new();

    for root in roots {
        let norm_root = normalize_win32_path_str(&root.path);
        let root_path = PathBuf::from(&norm_root);
        if !root_path.is_dir() {
            continue;
        }
        let mut stack = vec![root_path];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if is_hidden_or_skipped_name(&name) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(path);
                } else if meta.is_file() && meta.len() <= MAX_DISK_FILE_BYTES && is_indexable_disk_file(&path) {
                    let key = normalize_path_key(&path);
                    if seen_paths.insert(key) {
                        files.push((path, root.name.clone()));
                        if files.len() >= MAX_DISK_FILES {
                            return files;
                        }
                    }
                }
            }
        }
    }
    files
}

fn index_disk_file_if_needed(
    conn: &mut Connection,
    path: &Path,
    root_name: &str,
    force_full: bool,
) -> Result<bool, AppError> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(false);
    };
    if !meta.is_file() || meta.len() > MAX_DISK_FILE_BYTES || !is_indexable_disk_file(path) {
        return Ok(false);
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let file_size = meta.len() as i64;
    let source_id = format!("file:{}", normalize_path_key(path));

    let existing: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT mtime_ms, file_size, content_hash FROM kb_sources WHERE source_id = ?1",
            params![&source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    if !force_full {
        if let Some((old_mtime, old_size, _)) = existing {
            if mtime_ms > 0 && old_mtime == mtime_ms && old_size == file_size {
                return Ok(false);
            }
        }
    }

    let Ok(bytes) = std::fs::read(path) else {
        return Ok(false);
    };
    if looks_binary(&bytes) {
        return Ok(false);
    }

    let content_hash = sha256_hex(&bytes);
    if !force_full {
        if let Some((_, _, old_hash)) = existing {
            if old_hash == content_hash {
                conn.execute(
                    "UPDATE kb_sources SET mtime_ms = ?1, file_size = ?2, root_name = ?3 WHERE source_id = ?4",
                    params![mtime_ms, file_size, root_name, &source_id],
                )?;
                return Ok(false);
            }
        }
    }

    let (text, _, _) = decode_text_bytes(&bytes, None);
    let ref_id = clean_display_path(path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "笔记".to_string());
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let title = if matches!(ext.as_str(), "md" | "markdown" | "mdown" | "mkd") {
        derive_markdown_title(&text, &stem)
    } else {
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&stem)
            .to_string()
    };
    let event_time = meta
        .modified()
        .map(system_time_iso)
        .unwrap_or_else(|_| now_iso());

    let drafts = build_disk_file_events(&source_id, &title, &text, &event_time);
    let tx = conn.transaction()?;
    write_source_and_events(
        &tx,
        &source_id,
        "mounted_file",
        &ref_id,
        &title,
        "",
        root_name,
        mtime_ms,
        file_size,
        &content_hash,
        &event_time,
        &drafts,
    )?;
    tx.commit()?;
    Ok(true)
}

/// 执行完整或增量知识库同步（`kb_index.db` 已打开且不含 `xynote.db` 锁）
pub fn sync_workspace_into_kb(
    conn: &mut Connection,
    snapshot: &WorkspaceSnapshot,
    include_folders: bool,
    force_full: bool,
) -> Result<(), AppError> {
    if force_full {
        conn.execute_batch(
            "DELETE FROM kb_events_fts;
             DELETE FROM kb_event_entities;
             DELETE FROM kb_entities;
             DELETE FROM kb_events;
             DELETE FROM kb_sources;",
        )?;
    }

    let mut expected_sources: HashSet<String> = HashSet::new();
    let mut existing_hashes: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT source_id, content_hash FROM kb_sources")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows.flatten() {
            existing_hashes.insert(r.0, r.1);
        }
    }

    let mut changed = force_full;

    // 1. 索引工作区页面与多维表
    for page in &snapshot.pages {
        let source_id = format!("page:{}", page.id);
        expected_sources.insert(source_id.clone());
        let hash = page_snapshot_hash(page);
        if !force_full && existing_hashes.get(&source_id).is_some_and(|h| h == &hash) {
            continue;
        }
        let drafts = build_page_events(page, &source_id);
        let tx = conn.transaction()?;
        write_source_and_events(
            &tx,
            &source_id,
            "workspace_page",
            &page.id,
            &page.title,
            &page.icon,
            "",
            0,
            0,
            &hash,
            &page.updated_at,
            &drafts,
        )?;
        tx.commit()?;
        changed = true;
    }

    // 2. 索引侧栏挂载的本地文件夹（仅写轻量索引，不复制原文）
    if include_folders && !snapshot.mounted_folders.is_empty() {
        let disk_files = collect_mounted_files(&snapshot.mounted_folders);
        for (path, root_name) in disk_files {
            let source_id = format!("file:{}", normalize_path_key(&path));
            expected_sources.insert(source_id);
            if index_disk_file_if_needed(conn, &path, &root_name, force_full)? {
                changed = true;
            }
        }
    }

    // 3. 清理已删除/已移入回收站/已取消挂载的源
    let stale_sources: Vec<String> = existing_hashes
        .keys()
        .filter(|sid| !expected_sources.contains(*sid))
        .cloned()
        .collect();
    if !stale_sources.is_empty() {
        let tx = conn.transaction()?;
        for sid in stale_sources {
            delete_source_tx(&tx, &sid)?;
        }
        tx.commit()?;
        changed = true;
    }

    replace_page_links(conn, &snapshot.page_links)?;
    if changed {
        refresh_entity_doc_freqs(conn)?;
    }

    conn.execute(
        "INSERT INTO kb_meta (key, value) VALUES ('last_indexed_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now_iso()],
    )?;
    Ok(())
}

/// 增量同步单篇工作区页面（编辑保存后后台毫秒级触发）
pub fn sync_single_page_into_kb(
    conn: &mut Connection,
    page: Option<&PageSnapshot>,
    page_id: &str,
    page_links: &[(String, String)],
) -> Result<(), AppError> {
    let source_id = format!("page:{}", page_id);
    let mut changed = false;

    match page {
        None => {
            let tx = conn.transaction()?;
            delete_source_tx(&tx, &source_id)?;
            tx.commit()?;
            changed = true;
        }
        Some(p) => {
            let hash = page_snapshot_hash(p);
            let old_hash: Option<String> = conn
                .query_row(
                    "SELECT content_hash FROM kb_sources WHERE source_id = ?1",
                    params![&source_id],
                    |r| r.get(0),
                )
                .optional()?;
            if old_hash.as_deref() != Some(&hash) {
                let drafts = build_page_events(p, &source_id);
                let tx = conn.transaction()?;
                write_source_and_events(
                    &tx,
                    &source_id,
                    "workspace_page",
                    &p.id,
                    &p.title,
                    &p.icon,
                    "",
                    0,
                    0,
                    &hash,
                    &p.updated_at,
                    &drafts,
                )?;
                tx.commit()?;
                changed = true;
            }
        }
    }

    replace_page_links(conn, page_links)?;
    if changed {
        refresh_entity_doc_freqs(conn)?;
    }
    conn.execute(
        "INSERT INTO kb_meta (key, value) VALUES ('last_indexed_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now_iso()],
    )?;
    Ok(())
}

/// 按文件系统路径列表增量更新/移除挂载目录里的文件索引
pub fn sync_disk_paths_into_kb(
    conn: &mut Connection,
    mounted_folders: &[MountedFolderRoot],
    paths: &[String],
) -> Result<(), AppError> {
    let roots_norm: Vec<(String, String)> = mounted_folders
        .iter()
        .map(|r| (normalize_path_key(Path::new(&normalize_win32_path_str(&r.path))), r.name.clone()))
        .collect();

    let mut changed = false;
    for raw in paths {
        let clean = normalize_win32_path_str(raw);
        let p = Path::new(&clean);
        let key = normalize_path_key(p);

        // 确认该路径仍位于某个已挂载文件夹下
        let matched_root = roots_norm
            .iter()
            .find(|(rk, _)| key == *rk || key.starts_with(&format!("{}/", rk)) || key.starts_with(&format!("{}\\", rk)));

        let Some((_, root_name)) = matched_root else {
            continue;
        };

        if p.is_file() {
            if index_disk_file_if_needed(conn, p, root_name, false)? {
                changed = true;
            }
        } else if !p.exists() {
            let source_id = format!("file:{}", key);
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM kb_sources WHERE source_id = ?1",
                    params![&source_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            if exists {
                let tx = conn.transaction()?;
                delete_source_tx(&tx, &source_id)?;
                tx.commit()?;
                changed = true;
            }
        }
    }

    if changed {
        refresh_entity_doc_freqs(conn)?;
    }
    conn.execute(
        "INSERT INTO kb_meta (key, value) VALUES ('last_indexed_at', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now_iso()],
    )?;
    Ok(())
}

pub fn read_kb_counts(conn: &Connection) -> Result<(usize, usize, usize, Option<String>), AppError> {
    let sources: i64 = conn.query_row("SELECT COUNT(*) FROM kb_sources", [], |r| r.get(0))?;
    let events: i64 = conn.query_row("SELECT COUNT(*) FROM kb_events", [], |r| r.get(0))?;
    let entities: i64 = conn.query_row("SELECT COUNT(*) FROM kb_entities", [], |r| r.get(0))?;
    let last_at: Option<String> = conn
        .query_row(
            "SELECT value FROM kb_meta WHERE key = 'last_indexed_at'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok((
        sources.max(0) as usize,
        events.max(0) as usize,
        entities.max(0) as usize,
        last_at,
    ))
}
