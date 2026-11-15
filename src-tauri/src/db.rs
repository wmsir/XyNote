use crate::markdown::{
    derive_markdown_title, export_database_to_markdown, export_doc_to_markdown, is_raw_text_block,
    parse_markdown_to_blocks, strip_html,
};
use crate::models::{
    AppError, BacklinkItem, Block, BlockProps, BreadcrumbItem, CreatePageInput, DatabaseFull,
    DbColumn, DbRow, MarkdownExport, Page, PageDetail, SaveBlockItem, SearchResult, SelectOption,
    UpdatePagePatch, UpsertBlockInput, UpsertDbColumnInput, UpsertDbRowInput,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

pub(crate) struct DbInner {
    pub(crate) conn: Connection,
    pub(crate) storage: Option<crate::storage::ManagedStorage>,
    pub(crate) ephemeral_plugins_dir: Option<std::path::PathBuf>,
}

impl Drop for DbInner {
    fn drop(&mut self) {
        if let Some(ref temp_dir) = self.ephemeral_plugins_dir {
            let _ = std::fs::remove_dir_all(temp_dir);
        }
    }
}

impl std::ops::Deref for DbInner {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        &self.conn
    }
}

impl std::ops::DerefMut for DbInner {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.conn
    }
}

pub struct Database {
    pub(crate) inner: Mutex<DbInner>,
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    let mut chars = trimmed.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}…", taken)
    } else {
        taken
    }
}

fn make_snippet_around(text: &str, needle: &str, max_chars: usize) -> String {
    let clean = text.replace('\n', " ").trim().to_string();
    if clean.is_empty() {
        return String::new();
    }
    let clean_chars: Vec<char> = clean.chars().collect();
    if clean_chars.len() <= max_chars {
        return clean;
    }
    let lower_clean: Vec<char> = clean.to_lowercase().chars().collect();
    let lower_needle: Vec<char> = needle.trim().to_lowercase().chars().collect();
    if !lower_needle.is_empty() && lower_clean.len() >= lower_needle.len() {
        if let Some(pos) = lower_clean
            .windows(lower_needle.len())
            .position(|w| w == lower_needle.as_slice())
        {
            let start = pos.saturating_sub(24);
            let end = (start + max_chars).min(clean_chars.len());
            let slice: String = clean_chars[start..end].iter().collect();
            let prefix = if start > 0 { "…" } else { "" };
            let suffix = if end < clean_chars.len() { "…" } else { "" };
            return format!("{}{}{}", prefix, slice, suffix);
        }
    }
    truncate_chars(&clean, max_chars)
}

pub(crate) fn effective_plain_text(
    block_type: &str,
    content: &str,
    plain_text: &str,
    props: &BlockProps,
) -> String {
    if is_raw_text_block(block_type) {
        if !content.is_empty() {
            return content.to_string();
        }
        return plain_text.to_string();
    }
    if !plain_text.trim().is_empty() {
        return plain_text.to_string();
    }
    match block_type {
        "table" => {
            let mut parts = Vec::new();
            if let Some(headers) = &props.headers {
                parts.extend(headers.iter().map(|h| strip_html(h)).filter(|s| !s.is_empty()));
            }
            if let Some(rows) = &props.rows {
                for r in rows {
                    parts.extend(r.iter().map(|c| strip_html(c)).filter(|s| !s.is_empty()));
                }
            }
            parts.join(" ")
        }
        "image" => {
            let mut parts = Vec::new();
            if let Some(cap) = props.caption.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                parts.push(cap.to_string());
            }
            if let Some(url) = props
                .url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with("data:"))
            {
                parts.push(url.to_string());
            }
            parts.join(" ")
        }
        "bookmark" => {
            let mut parts = Vec::new();
            for opt in [
                props.bookmark_title.as_deref(),
                props.bookmark_desc.as_deref(),
                props.bookmark_site.as_deref(),
                props.url.as_deref(),
            ] {
                if let Some(s) = opt.map(str::trim).filter(|s| !s.is_empty()) {
                    parts.push(s.to_string());
                }
            }
            parts.join(" ")
        }
        "embed" => {
            let mut parts = Vec::new();
            for opt in [
                props.caption.as_deref(),
                props.embed_provider.as_deref(),
                props.url.as_deref(),
            ] {
                if let Some(s) = opt.map(str::trim).filter(|s| !s.is_empty()) {
                    parts.push(s.to_string());
                }
            }
            parts.join(" ")
        }
        _ => strip_html(content),
    }
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppError> {
        let path_ref = path.as_ref();
        if let Some(parent) = path_ref.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path_ref)?;
        Self::initialize_conn(&conn, true)?;
        let storage = path_ref.parent().map(|data_dir| {
            let clean_data =
                crate::win_dialogs::normalize_win32_path_str(&data_dir.to_string_lossy());
            let clean_pages = crate::win_dialogs::normalize_win32_path_str(
                &data_dir.join("pages").to_string_lossy(),
            );
            crate::storage::ManagedStorage {
                config: crate::storage::StorageConfig {
                    active_data_dir: clean_data,
                    markdown_sync_dir: clean_pages,
                    auto_sync_markdown: false,
                    image_save_mode: "assets".to_string(),
                    auto_backup_on_launch: false,
                    max_backups: 10,
                },
                config_file_path: data_dir.join("notion-config.json"),
                exe_dir: data_dir.to_path_buf(),
                default_data_dir: data_dir.to_path_buf(),
                exe_dir_writable: true,
            }
        });
        Ok(Self {
            inner: Mutex::new(DbInner {
                conn,
                storage,
                ephemeral_plugins_dir: None,
            }),
        })
    }

    pub fn open_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        Self::initialize_conn(&conn, true)?;
        Ok(Self {
            inner: Mutex::new(DbInner {
                conn,
                storage: None,
                ephemeral_plugins_dir: None,
            }),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory_unseeded() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        Self::initialize_conn(&conn, false)?;
        Ok(Self {
            inner: Mutex::new(DbInner {
                conn,
                storage: None,
                ephemeral_plugins_dir: None,
            }),
        })
    }

    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, DbInner>, AppError> {
        self.inner.lock().map_err(|_| AppError::LockPoisoned)
    }

    pub(crate) fn initialize_conn(conn: &Connection, seed_if_empty: bool) -> Result<(), AppError> {
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY,
                parent_id TEXT NULL,
                title TEXT NOT NULL,
                icon TEXT NOT NULL,
                cover TEXT NULL,
                page_type TEXT NOT NULL DEFAULT 'doc',
                is_favorite INTEGER NOT NULL DEFAULT 0,
                is_trashed INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                block_type TEXT NOT NULL,
                content TEXT NOT NULL,
                plain_text TEXT NOT NULL,
                props_json TEXT NOT NULL DEFAULT '{}',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS page_links (
                source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                excerpt TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (source_page_id, target_page_id)
            );

            CREATE TABLE IF NOT EXISTS db_meta (
                page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
                active_view TEXT NOT NULL DEFAULT 'table',
                group_by_col_id TEXT NULL
            );

            CREATE TABLE IF NOT EXISTS db_columns (
                id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                col_type TEXT NOT NULL,
                options_json TEXT NOT NULL DEFAULT '[]',
                width INTEGER NOT NULL DEFAULT 180,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS db_rows (
                id TEXT PRIMARY KEY,
                page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                cells_json TEXT NOT NULL DEFAULT '{}',
                linked_page_id TEXT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id, is_trashed, sort_order);
            CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_page_id);
            CREATE INDEX IF NOT EXISTS idx_db_columns_page ON db_columns(page_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_db_rows_page ON db_rows(page_id, sort_order);

            CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
                page_id UNINDEXED,
                title,
                tokenize = 'unicode61'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
                block_id UNINDEXED,
                page_id UNINDEXED,
                plain_text,
                extra_text,
                tokenize = 'unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS trg_pages_ai AFTER INSERT ON pages BEGIN
                INSERT INTO pages_fts(page_id, title) VALUES (new.id, new.title);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_pages_au AFTER UPDATE OF title ON pages BEGIN
                DELETE FROM pages_fts WHERE page_id = old.id;
                INSERT INTO pages_fts(page_id, title) VALUES (new.id, new.title);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_pages_ad AFTER DELETE ON pages BEGIN
                DELETE FROM pages_fts WHERE page_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS trg_blocks_ai AFTER INSERT ON blocks BEGIN
                INSERT INTO blocks_fts(block_id, page_id, plain_text, extra_text)
                VALUES (new.id, new.page_id, new.plain_text, CASE WHEN instr(new.props_json, 'data:') > 0 THEN '' ELSE new.props_json END);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_blocks_au AFTER UPDATE ON blocks BEGIN
                DELETE FROM blocks_fts WHERE block_id = old.id;
                INSERT INTO blocks_fts(block_id, page_id, plain_text, extra_text)
                VALUES (new.id, new.page_id, new.plain_text, CASE WHEN instr(new.props_json, 'data:') > 0 THEN '' ELSE new.props_json END);
            END;
            CREATE TRIGGER IF NOT EXISTS trg_blocks_ad AFTER DELETE ON blocks BEGIN
                DELETE FROM blocks_fts WHERE block_id = old.id;
            END;
            ",
        )?;
        // 同步基线与删除墓碑（见 sync.rs）
        conn.execute_batch(crate::sync::SCHEMA_SQL)?;

        // Seed default settings if absent
        let default_settings = [
            ("theme", "light"),
            ("fontStyle", "sans"),
            ("fullWidth", "false"),
        ];
        for (k, v) in default_settings {
            conn.execute(
                "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
                params![k, v],
            )?;
        }

        if seed_if_empty {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
            if count == 0 {
                Self::seed_starter_workspace(conn)?;
            } else {
                let _ = conn.execute(
                    "UPDATE pages SET title = '欢迎使用 小悦 (XyNote)' WHERE id = 'page-welcome' AND title = '欢迎使用 Notion Desktop'",
                    [],
                );
            }
        }

        Ok(())
    }

    /// 新工作区只带一篇使用说明，其余内容由用户自己创建
    fn seed_starter_workspace(conn: &Connection) -> Result<(), AppError> {
        let ts = now_iso();
        let welcome_id = "page-welcome";

        conn.execute(
            "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
             VALUES (?1, NULL, ?2, ?3, NULL, 'doc', 0, 0, 0, ?4, ?4)",
            params![welcome_id, "欢迎使用 小悦 (XyNote)", "🏠", ts],
        )?;

        let insert_block = |page_id: &str,
                            sort: i64,
                            block_type: &str,
                            content: &str,
                            props: BlockProps|
         -> Result<(), AppError> {
            let plain = effective_plain_text(block_type, content, "", &props);
            let props_json = serde_json::to_string(&props)?;
            conn.execute(
                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![new_id(), page_id, block_type, content, plain, props_json, sort, ts],
            )?;
            Ok(())
        };

        insert_block(
            welcome_id,
            0,
            "callout",
            "小悦是本地优先的桌面笔记：工作区页面保存在本机数据库里，侧栏「文件夹」可以直接打开并编辑磁盘上的 Markdown 文件。",
            BlockProps {
                callout_icon: Some("💡".into()),
                color: Some("gray".into()),
                ..Default::default()
            },
        )?;
        insert_block(
            welcome_id,
            1,
            "heading2",
            "开始使用",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            2,
            "bullet",
            "<strong>新建页面</strong>：点侧栏「工作区页面」右侧的 +，或按 <code>Ctrl + N</code>。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            3,
            "bullet",
            "<strong>打开文件夹</strong>：点侧栏「文件夹」右侧的按钮选择目录，可以同时打开多个；点击笔记即可编辑，改动直接保存回原文件。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            4,
            "bullet",
            "<strong>插入内容</strong>：在空行输入 <code>/</code>，选择标题、待办、表格、代码、公式或 Mermaid 图表。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            5,
            "bullet",
            "<strong>关联页面</strong>：输入 <code>[[</code> 引用其他页面，被引用的页面底部会显示反向链接。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            6,
            "bullet",
            "<strong>搜索</strong>：按 <code>Ctrl + K</code> 全文搜索，并快速跳转到页面或命令。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            7,
            "heading2",
            "侧栏文件夹",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            8,
            "bullet",
            "右键文件夹：新建笔记、新建文件夹、刷新、在文件管理器中显示、复制路径。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            9,
            "bullet",
            "右键笔记：重命名（也可以按 <code>F2</code>）、在文件管理器中显示、复制路径。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            10,
            "bullet",
            "只显示子文件夹和 .md / .markdown / .txt 笔记；隐藏文件、node_modules 等目录不会出现。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            11,
            "bullet",
            "从侧栏移除文件夹只是不再显示，不会删除磁盘上的任何文件。",
            BlockProps::default(),
        )?;
        insert_block(
            welcome_id,
            12,
            "toggle",
            "常用快捷键",
            BlockProps {
                collapsed: Some(true),
                children_text: Some("Ctrl + K：搜索与命令面板\nCtrl + N：新建页面\nCtrl + O：打开单个 .md 文件\nCtrl + S：立即保存\nCtrl + /：切换源码模式\nCtrl + Shift + L：显示或隐藏侧栏\nCtrl + ,：偏好设置（可自定义全部快捷键）".into()),
                ..Default::default()
            },
        )?;
        insert_block(
            welcome_id,
            13,
            "paragraph",
            "这篇文档可以随意修改或删除。",
            BlockProps::default(),
        )?;

        Ok(())
    }

    pub(crate) fn row_to_page(row: &rusqlite::Row<'_>) -> rusqlite::Result<Page> {
        Ok(Page {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            title: row.get(2)?,
            icon: row.get(3)?,
            cover: row.get(4)?,
            page_type: row.get(5)?,
            is_favorite: row.get::<_, i64>(6)? != 0,
            is_trashed: row.get::<_, i64>(7)? != 0,
            sort_order: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }

    fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
        let props_str: String = row.get(5)?;
        let props: BlockProps = serde_json::from_str(&props_str).unwrap_or_default();
        Ok(Block {
            id: row.get(0)?,
            page_id: row.get(1)?,
            block_type: row.get(2)?,
            content: row.get(3)?,
            plain_text: row.get(4)?,
            props,
            sort_order: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }

    pub(crate) fn get_page_by_id_conn(conn: &Connection, id: &str) -> Result<Page, AppError> {
        conn.query_row(
            "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
             FROM pages WHERE id = ?1",
            params![id],
            Self::row_to_page,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("Page not found: {}", id)))
    }

    pub(crate) fn get_blocks_for_page_conn(conn: &Connection, page_id: &str) -> Result<Vec<Block>, AppError> {
        let mut stmt = conn.prepare(
            "SELECT id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at
             FROM blocks WHERE page_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )?;
        let iter = stmt.query_map(params![page_id], Self::row_to_block)?;
        let mut out = Vec::new();
        for b in iter {
            out.push(b?);
        }
        Ok(out)
    }

    pub(crate) fn next_sibling_sort_order(conn: &Connection, parent_id: Option<&str>) -> Result<i64, AppError> {
        let max_order: Option<i64> = match parent_id {
            Some(pid) => conn.query_row(
                "SELECT MAX(sort_order) FROM pages WHERE parent_id = ?1 AND is_trashed = 0",
                params![pid],
                |r| r.get(0),
            )?,
            None => conn.query_row(
                "SELECT MAX(sort_order) FROM pages WHERE parent_id IS NULL AND is_trashed = 0",
                [],
                |r| r.get(0),
            )?,
        };
        Ok(max_order.map(|m| m + 1).unwrap_or(0))
    }

    fn collect_descendant_ids(conn: &Connection, root_id: &str) -> Result<Vec<String>, AppError> {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE tree(id) AS (
                SELECT id FROM pages WHERE id = ?1
                UNION ALL
                SELECT p.id FROM pages p JOIN tree t ON p.parent_id = t.id
             )
             SELECT id FROM tree",
        )?;
        let rows = stmt.query_map(params![root_id], |r| r.get::<_, String>(0))?;
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for r in rows {
            let id = r?;
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    fn extract_data_page_ids(html: &str) -> Vec<String> {
        let mut found = Vec::new();
        for attr in ["data-page-id=\"", "data-page-id='"] {
            let quote = attr.chars().last().unwrap();
            let mut rest = html;
            while let Some(pos) = rest.find(attr) {
                let after = &rest[pos + attr.len()..];
                if let Some(end) = after.find(quote) {
                    let candidate = after[..end].trim();
                    if !candidate.is_empty() {
                        found.push(candidate.to_string());
                    }
                    rest = &after[end + 1..];
                } else {
                    break;
                }
            }
        }
        found
    }

    fn extract_wiki_mentions(text: &str) -> Vec<String> {
        let mut mentions = Vec::new();
        let mut rest = text;
        while let Some(open) = rest.find("[[") {
            let after = &rest[open + 2..];
            if let Some(close) = after.find("]]") {
                let title = after[..close].trim();
                if !title.is_empty() && !title.contains('\n') {
                    mentions.push(title.to_string());
                }
                rest = &after[close + 2..];
            } else {
                break;
            }
        }
        mentions
    }

    pub(crate) fn rebuild_page_links_internal(
        conn: &Connection,
        source_page_id: &str,
    ) -> Result<(), AppError> {
        conn.execute(
            "DELETE FROM page_links WHERE source_page_id = ?1",
            params![source_page_id],
        )?;

        let blocks = Self::get_blocks_for_page_conn(conn, source_page_id)?;
        if blocks.is_empty() {
            return Ok(());
        }

        // Load active candidate target pages
        let mut stmt =
            conn.prepare("SELECT id, title FROM pages WHERE is_trashed = 0 AND id != ?1")?;
        let active_pages: Vec<(String, String)> = stmt
            .query_map(params![source_page_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let valid_ids: HashSet<&str> = active_pages.iter().map(|(id, _)| id.as_str()).collect();
        let mut recorded: HashSet<String> = HashSet::new();

        for blk in &blocks {
            let is_raw = is_raw_text_block(&blk.block_type);
            let excerpt_base = if is_raw {
                if !blk.content.is_empty() {
                    blk.content.clone()
                } else {
                    blk.plain_text.clone()
                }
            } else if !blk.plain_text.trim().is_empty() {
                blk.plain_text.clone()
            } else {
                strip_html(&blk.content)
            };
            let excerpt = truncate_chars(&excerpt_base, 140);

            // 1. Scan data-page-id="..." in HTML content & rich table cells
            if !is_raw {
                let mut html_sources: Vec<&str> = vec![blk.content.as_str()];
                if blk.block_type == "table" {
                    if let Some(headers) = &blk.props.headers {
                        html_sources.extend(headers.iter().map(String::as_str));
                    }
                    if let Some(rows) = &blk.props.rows {
                        for r in rows {
                            html_sources.extend(r.iter().map(String::as_str));
                        }
                    }
                }
                for html_src in html_sources {
                    for target_id in Self::extract_data_page_ids(html_src) {
                        if valid_ids.contains(target_id.as_str())
                            && recorded.insert(target_id.clone())
                        {
                            conn.execute(
                                "INSERT OR REPLACE INTO page_links (source_page_id, target_page_id, excerpt)
                                 VALUES (?1, ?2, ?3)",
                                params![source_page_id, target_id, excerpt],
                            )?;
                        }
                    }
                }
            }

            // 2. Scan [[Page Title]] mentions across plain_text, stripped content, table cells, and toggle childrenText
            let mut combined_text = excerpt_base;
            if !is_raw {
                let stripped = strip_html(&blk.content);
                if stripped != combined_text {
                    combined_text.push(' ');
                    combined_text.push_str(&stripped);
                }
                if blk.block_type == "table" {
                    if let Some(headers) = &blk.props.headers {
                        for h in headers {
                            combined_text.push(' ');
                            combined_text.push_str(&strip_html(h));
                        }
                    }
                    if let Some(rows) = &blk.props.rows {
                        for r in rows {
                            for c in r {
                                combined_text.push(' ');
                                combined_text.push_str(&strip_html(c));
                            }
                        }
                    }
                }
            }
            if let Some(children) = &blk.props.children_text {
                combined_text.push(' ');
                combined_text.push_str(children);
            }

            for mention in Self::extract_wiki_mentions(&combined_text) {
                let mention_lower = mention.trim().to_lowercase();
                // Prefer exact title match first; fallback to bilingual prefix/suffix match
                let matched = active_pages
                    .iter()
                    .find(|(_, title)| title.trim().to_lowercase() == mention_lower)
                    .or_else(|| {
                        if mention_lower.chars().count() < 2 {
                            return None;
                        }
                        active_pages.iter().find(|(_, title)| {
                            let tl = title.trim().to_lowercase();
                            tl.ends_with(&format!(" {}", mention_lower))
                                || tl.starts_with(&format!("{} ", mention_lower))
                        })
                    });

                if let Some((target_id, _)) = matched {
                    if recorded.insert(target_id.clone()) {
                        conn.execute(
                            "INSERT OR REPLACE INTO page_links (source_page_id, target_page_id, excerpt)
                             VALUES (?1, ?2, ?3)",
                            params![source_page_id, target_id, excerpt],
                        )?;
                    }
                }
            }
        }

        Ok(())
    }

    pub fn list_pages(&self) -> Result<Vec<Page>, AppError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
             FROM pages
             WHERE is_trashed = 0
             ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_page)?;
        let mut pages = Vec::new();
        for r in rows {
            pages.push(r?);
        }
        Ok(pages)
    }

    pub fn list_trashed_pages(&self) -> Result<Vec<Page>, AppError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
             FROM pages
             WHERE is_trashed = 1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_page)?;
        let mut pages = Vec::new();
        for r in rows {
            pages.push(r?);
        }
        Ok(pages)
    }

    pub fn get_page_detail(&self, id: &str) -> Result<PageDetail, AppError> {
        let conn = self.lock()?;
        let page = Self::get_page_by_id_conn(&conn, id)?;
        let blocks = Self::get_blocks_for_page_conn(&conn, id)?;

        // Breadcrumbs from root ancestor down to current page
        let mut breadcrumbs = Vec::new();
        let mut visited = HashSet::new();
        let mut cursor_opt = Some(page.clone());
        while let Some(curr) = cursor_opt {
            if !visited.insert(curr.id.clone()) {
                break;
            }
            breadcrumbs.push(BreadcrumbItem {
                id: curr.id.clone(),
                title: curr.title.clone(),
                icon: curr.icon.clone(),
            });
            cursor_opt = match &curr.parent_id {
                Some(pid) => conn
                    .query_row(
                        "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
                         FROM pages WHERE id = ?1 AND is_trashed = 0",
                        params![pid],
                        Self::row_to_page,
                    )
                    .optional()?,
                None => None,
            };
        }
        breadcrumbs.reverse();

        // Backlinks from active (non-trashed) pages
        let mut bl_stmt = conn.prepare(
            "SELECT pl.source_page_id, p.title, p.icon, pl.excerpt
             FROM page_links pl
             JOIN pages p ON p.id = pl.source_page_id
             WHERE pl.target_page_id = ?1 AND p.is_trashed = 0
             ORDER BY p.updated_at DESC",
        )?;
        let backlinks = bl_stmt
            .query_map(params![id], |r| {
                Ok(BacklinkItem {
                    source_page_id: r.get(0)?,
                    source_title: r.get(1)?,
                    source_icon: r.get(2)?,
                    excerpt: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Direct non-trashed children
        let mut ch_stmt = conn.prepare(
            "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
             FROM pages
             WHERE parent_id = ?1 AND is_trashed = 0
             ORDER BY sort_order ASC, created_at ASC",
        )?;
        let children = ch_stmt
            .query_map(params![id], Self::row_to_page)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PageDetail {
            page,
            blocks,
            breadcrumbs,
            backlinks,
            children,
        })
    }

    pub fn create_page(&self, input: CreatePageInput) -> Result<Page, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let ts = now_iso();
        let page_id = new_id();
        let parent_id = input
            .parent_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        let custom_title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "无标题")
            .map(String::from);

        let template_id = input
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let is_db_template = matches!(
            template_id,
            Some("product-roadmap" | "task-hub" | "reading-list")
        );

        let page_type = if is_db_template {
            "database".to_string()
        } else if template_id.is_some() {
            "doc".to_string()
        } else {
            match input.page_type.as_deref() {
                Some("database") => "database".to_string(),
                _ => "doc".to_string(),
            }
        };

        let (default_title, default_icon) = match template_id {
            Some("meeting-notes") => ("团队周会纪要", "📝"),
            Some("eng-spec") => ("技术方案设计 RFC", "⚙️"),
            Some("weekly-journal") => ("每周复盘与计划", "🗓️"),
            Some("product-roadmap") => ("产品路线图", "🗺️"),
            Some("task-hub") => ("任务管理看板", "✅"),
            Some("reading-list") => ("阅读书单与笔记", "📚"),
            _ => (
                "无标题",
                if page_type == "database" {
                    "🗃️"
                } else {
                    "📄"
                },
            ),
        };

        let final_title = custom_title.unwrap_or_else(|| default_title.to_string());
        let final_icon = input
            .icon
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| default_icon.to_string());

        let sort_order = Self::next_sibling_sort_order(&tx, parent_id.as_deref())?;

        tx.execute(
            "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8, ?8)",
            params![
                page_id,
                parent_id,
                final_title,
                final_icon,
                input.cover,
                page_type,
                sort_order,
                ts
            ],
        )?;

        if let Some(tpl) = template_id {
            Self::populate_template(&tx, &page_id, tpl, &ts)?;
        } else if page_type == "database" {
            Self::ensure_database_initialized_conn(&tx, &page_id)?;
        } else {
            tx.execute(
                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, 'paragraph', '', '', '{}', 0, ?3, ?3)",
                params![new_id(), page_id, ts],
            )?;
        }

        if page_type == "doc" {
            Self::rebuild_page_links_internal(&tx, &page_id)?;
        }

        let created = Self::get_page_by_id_conn(&tx, &page_id)?;
        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &created.id);
        Ok(created)
    }

    fn populate_template(
        conn: &Connection,
        page_id: &str,
        template_id: &str,
        ts: &str,
    ) -> Result<(), AppError> {
        let add_block = |sort: i64,
                         btype: &str,
                         content: &str,
                         plain_override: Option<&str>,
                         props: BlockProps|
         -> Result<(), AppError> {
            let plain = match plain_override {
                Some(p) => p.to_string(),
                None => effective_plain_text(btype, content, "", &props),
            };
            conn.execute(
                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    new_id(),
                    page_id,
                    btype,
                    content,
                    plain,
                    serde_json::to_string(&props)?,
                    sort,
                    ts
                ],
            )?;
            Ok(())
        };

        let date_today = ts.chars().take(10).collect::<String>();

        match template_id {
            "meeting-notes" => {
                add_block(
                    0,
                    "callout",
                    &format!("日期：{} ｜ 参会人：产品、研发、设计", date_today),
                    None,
                    BlockProps {
                        callout_icon: Some("📅".into()),
                        color: Some("gray".into()),
                        ..Default::default()
                    },
                )?;
                add_block(1, "heading2", "会议议程 Agenda", None, BlockProps::default())?;
                add_block(
                    2,
                    "bullet",
                    "上周里程碑交付回顾与核心指标同步",
                    None,
                    BlockProps::default(),
                )?;
                add_block(
                    3,
                    "bullet",
                    "本周关键阻塞项讨论与方案决策",
                    None,
                    BlockProps::default(),
                )?;
                add_block(4, "heading2", "行动项 Action Items", None, BlockProps::default())?;
                add_block(
                    5,
                    "todo",
                    "整理需求评审结论并同步至产品路线图",
                    None,
                    BlockProps {
                        checked: Some(false),
                        ..Default::default()
                    },
                )?;
                add_block(
                    6,
                    "todo",
                    "跟进客户端性能优化压测报告",
                    None,
                    BlockProps {
                        checked: Some(false),
                        ..Default::default()
                    },
                )?;
            }
            "eng-spec" => {
                add_block(
                    0,
                    "callout",
                    "状态：草案评审中 ｜ 作者：Engineering Team",
                    None,
                    BlockProps {
                        callout_icon: Some("🛠️".into()),
                        color: Some("blue".into()),
                        ..Default::default()
                    },
                )?;
                add_block(
                    1,
                    "heading2",
                    "1. 背景与目标 Motivation",
                    None,
                    BlockProps::default(),
                )?;
                add_block(
                    2,
                    "paragraph",
                    "阐述当前系统痛点、核心业务诉求以及本次架构演进预期达成的量化指标。",
                    None,
                    BlockProps::default(),
                )?;
                add_block(
                    3,
                    "heading2",
                    "2. 核心架构与数据模型 Design",
                    None,
                    BlockProps::default(),
                )?;
                let code = "pub struct DocumentEngine {\n    pub wal_enabled: bool,\n    pub fts_indexed: bool,\n}";
                add_block(
                    4,
                    "code",
                    code,
                    Some(code),
                    BlockProps {
                        language: Some("rust".into()),
                        ..Default::default()
                    },
                )?;
                add_block(
                    5,
                    "heading2",
                    "3. 风险评估与回滚预案",
                    None,
                    BlockProps::default(),
                )?;
                add_block(
                    6,
                    "table",
                    "",
                    None,
                    BlockProps {
                        headers: Some(vec!["潜在风险".into(), "影响等级".into(), "缓解措施".into()]),
                        rows: Some(vec![
                            vec![
                                "历史数据迁移耗时".into(),
                                "中".into(),
                                "采用增量事务批处理与断点续传".into(),
                            ],
                            vec![
                                "全文索引体积增长".into(),
                                "低".into(),
                                "定期执行 FTS5 optimize 压缩".into(),
                            ],
                        ]),
                        ..Default::default()
                    },
                )?;
            }
            "weekly-journal" => {
                add_block(0, "heading2", "✨ 本周高光收获 Wins", None, BlockProps::default())?;
                add_block(
                    1,
                    "bullet",
                    "完成了关键模块的端到端联调",
                    None,
                    BlockProps::default(),
                )?;
                add_block(2, "heading2", "🧩 遇到的挑战与反思", None, BlockProps::default())?;
                add_block(
                    3,
                    "quote",
                    "把复杂问题拆解为可验证的小步迭代。",
                    None,
                    BlockProps::default(),
                )?;
                add_block(4, "heading2", "🎯 下周三件事 Top 3", None, BlockProps::default())?;
                add_block(
                    5,
                    "todo",
                    "推进核心特性体验走查",
                    None,
                    BlockProps {
                        checked: Some(false),
                        ..Default::default()
                    },
                )?;
                add_block(
                    6,
                    "todo",
                    "阅读并沉淀一篇技术笔记",
                    None,
                    BlockProps {
                        checked: Some(false),
                        ..Default::default()
                    },
                )?;
            }
            "product-roadmap" | "task-hub" | "reading-list" => {
                let c_title = new_id();
                let c_status = new_id();
                let c_select = new_id();
                let c_date = new_id();
                let c_check = new_id();

                let is_reading = template_id == "reading-list";
                let active_view = match template_id {
                    "task-hub" => "board",
                    "reading-list" => "gallery",
                    _ => "table",
                };

                conn.execute(
                    "INSERT INTO db_meta (page_id, active_view, group_by_col_id) VALUES (?1, ?2, ?3)",
                    params![page_id, active_view, c_status],
                )?;

                let s1 = SelectOption {
                    id: new_id(),
                    label: if is_reading { "想读" } else { "待处理" }.into(),
                    color: "gray".into(),
                };
                let s2 = SelectOption {
                    id: new_id(),
                    label: if is_reading { "在读" } else { "进行中" }.into(),
                    color: "blue".into(),
                };
                let s3 = SelectOption {
                    id: new_id(),
                    label: if is_reading { "已读完" } else { "已完成" }.into(),
                    color: "green".into(),
                };

                let p1 = SelectOption {
                    id: new_id(),
                    label: if is_reading {
                        "★★★★★ 必读"
                    } else {
                        "高优 P0"
                    }
                    .into(),
                    color: "red".into(),
                };
                let p2 = SelectOption {
                    id: new_id(),
                    label: if is_reading {
                        "★★★★ 推荐"
                    } else {
                        "中优 P1"
                    }
                    .into(),
                    color: "amber".into(),
                };

                let cols = [
                    (
                        &c_title,
                        if is_reading { "书名 / 文章" } else { "事项名称" },
                        "title",
                        vec![],
                        250i64,
                        0i64,
                    ),
                    (&c_status, "状态", "status", vec![s1.clone(), s2.clone(), s3], 150, 1),
                    (
                        &c_select,
                        if is_reading { "推荐度" } else { "优先级" },
                        "select",
                        vec![p1.clone(), p2.clone()],
                        150,
                        2,
                    ),
                    (&c_date, "目标日期", "date", vec![], 140, 3),
                    (&c_check, "已完成", "checkbox", vec![], 100, 4),
                ];

                for (cid, name, ctype, opts, width, sort) in cols {
                    conn.execute(
                        "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![cid, page_id, name, ctype, serde_json::to_string(&opts)?, width, sort],
                    )?;
                }

                let row1 = json!({
                    &c_title: if is_reading { "《设计数据密集型应用》DDIA" } else { "完成核心交互原型评审" },
                    &c_status: s2.id,
                    &c_select: p1.id,
                    &c_date: date_today,
                    &c_check: false
                });
                let row2 = json!({
                    &c_title: if is_reading { "《Rust 原子操作与锁》" } else { "整理发布前回归测试清单" },
                    &c_status: s1.id,
                    &c_select: p2.id,
                    &c_date: date_today,
                    &c_check: false
                });

                for (idx, cells_val) in [row1, row2].iter().enumerate() {
                    conn.execute(
                        "INSERT INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)",
                        params![new_id(), page_id, serde_json::to_string(cells_val)?, idx as i64, ts],
                    )?;
                }
            }
            _ => {
                add_block(0, "paragraph", "", None, BlockProps::default())?;
            }
        }

        Ok(())
    }

    pub fn update_page(&self, id: &str, patch: UpdatePagePatch) -> Result<Page, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let existing = Self::get_page_by_id_conn(&tx, id)?;
        let new_title = patch.title.unwrap_or(existing.title);
        let new_icon = patch.icon.unwrap_or(existing.icon);
        let new_cover = match patch.cover {
            Some(explicit_cover) => explicit_cover,
            None => existing.cover,
        };
        let new_is_fav = patch.is_favorite.unwrap_or(existing.is_favorite);
        let new_sort = patch.sort_order.unwrap_or(existing.sort_order);

        let new_parent = match patch.parent_id {
            Some(Some(ref candidate)) => {
                if candidate == id {
                    existing.parent_id
                } else {
                    // Prevent hierarchy cycle
                    let descendants = Self::collect_descendant_ids(&tx, id)?;
                    if descendants.iter().any(|d| d == candidate) {
                        return Err(AppError::Validation(
                            "Cannot move a page inside its own descendant".into(),
                        ));
                    }
                    Some(candidate.clone())
                }
            }
            Some(None) => None,
            None => existing.parent_id,
        };

        let ts = now_iso();
        tx.execute(
            "UPDATE pages
             SET title = ?1, icon = ?2, cover = ?3, is_favorite = ?4, parent_id = ?5, sort_order = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                new_title,
                new_icon,
                new_cover,
                if new_is_fav { 1i64 } else { 0i64 },
                new_parent,
                new_sort,
                ts,
                id
            ],
        )?;

        let updated = Self::get_page_by_id_conn(&tx, id)?;
        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);
        Ok(updated)
    }

    pub fn trash_page(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let _ = Self::get_page_by_id_conn(&tx, id)?;
        let ids = Self::collect_descendant_ids(&tx, id)?;
        let ts = now_iso();
        for target_id in ids {
            tx.execute(
                "UPDATE pages SET is_trashed = 1, updated_at = ?1 WHERE id = ?2",
                params![ts, target_id],
            )?;
        }
        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);
        Ok(())
    }

    pub fn restore_page(&self, id: &str) -> Result<Page, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let target = Self::get_page_by_id_conn(&tx, id)?;

        // Check if parent is missing or trashed -> promote to root (None)
        let mut promote_to_root = false;
        if let Some(ref pid) = target.parent_id {
            let parent_active: Option<i64> = tx
                .query_row(
                    "SELECT is_trashed FROM pages WHERE id = ?1",
                    params![pid],
                    |r| r.get(0),
                )
                .optional()?;
            if parent_active != Some(0) {
                promote_to_root = true;
            }
        }

        let ts = now_iso();
        if promote_to_root {
            tx.execute(
                "UPDATE pages SET parent_id = NULL WHERE id = ?1",
                params![id],
            )?;
        }

        let ids = Self::collect_descendant_ids(&tx, id)?;
        for target_id in ids {
            tx.execute(
                "UPDATE pages SET is_trashed = 0, updated_at = ?1 WHERE id = ?2",
                params![ts, target_id],
            )?;
        }

        let restored = Self::get_page_by_id_conn(&tx, id)?;
        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);
        Ok(restored)
    }

    pub fn delete_page_permanently(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let ids = Self::collect_descendant_ids(&tx, id)?;
        for target_id in ids.into_iter().rev() {
            tx.execute(
                "UPDATE db_rows SET linked_page_id = NULL WHERE linked_page_id = ?1",
                params![target_id],
            )?;
            tx.execute("DELETE FROM pages WHERE id = ?1", params![target_id])?;
        }
        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);
        Ok(())
    }

    pub fn empty_trash(&self) -> Result<(), AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let trashed_roots: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM pages WHERE is_trashed = 1")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut all_to_delete = HashSet::new();
        for tid in trashed_roots {
            for desc in Self::collect_descendant_ids(&tx, &tid)? {
                all_to_delete.insert(desc);
            }
        }
        for del_id in all_to_delete {
            tx.execute(
                "UPDATE db_rows SET linked_page_id = NULL WHERE linked_page_id = ?1",
                params![del_id],
            )?;
            tx.execute("DELETE FROM pages WHERE id = ?1", params![del_id])?;
        }
        tx.commit()?;
        crate::storage::after_tree_mutated(&conn);
        Ok(())
    }

    pub fn duplicate_page(&self, id: &str) -> Result<Page, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let orig = Self::get_page_by_id_conn(&tx, id)?;
        let copy_id = new_id();
        let ts = now_iso();
        let next_sort = Self::next_sibling_sort_order(&tx, orig.parent_id.as_deref())?;
        let copy_title = format!("{} (副本)", orig.title);

        tx.execute(
            "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8, ?8)",
            params![
                copy_id,
                orig.parent_id,
                copy_title,
                orig.icon,
                orig.cover,
                orig.page_type,
                next_sort,
                ts
            ],
        )?;

        if orig.page_type == "database" {
            let orig_db = Self::get_database_conn(&tx, id)?;
            let mut col_map: HashMap<String, String> = HashMap::new();
            for col in &orig_db.columns {
                let new_col_id = new_id();
                col_map.insert(col.id.clone(), new_col_id.clone());
                tx.execute(
                    "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        new_col_id,
                        copy_id,
                        col.name,
                        col.col_type,
                        serde_json::to_string(&col.options)?,
                        col.width,
                        col.sort_order
                    ],
                )?;
            }

            let mapped_group = orig_db
                .group_by_col_id
                .as_ref()
                .and_then(|gid| col_map.get(gid).cloned());
            tx.execute(
                "INSERT INTO db_meta (page_id, active_view, group_by_col_id) VALUES (?1, ?2, ?3)",
                params![copy_id, orig_db.active_view, mapped_group],
            )?;

            for row in &orig_db.rows {
                let mut new_cells = Map::new();
                for (k, v) in &row.cells {
                    let mapped_k = col_map.get(k).cloned().unwrap_or_else(|| k.clone());
                    new_cells.insert(mapped_k, v.clone());
                }
                tx.execute(
                    "INSERT INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)",
                    params![
                        new_id(),
                        copy_id,
                        serde_json::to_string(&new_cells)?,
                        row.sort_order,
                        ts
                    ],
                )?;
            }
        } else {
            let orig_blocks = Self::get_blocks_for_page_conn(&tx, id)?;
            for blk in orig_blocks {
                tx.execute(
                    "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![
                        new_id(),
                        copy_id,
                        blk.block_type,
                        blk.content,
                        blk.plain_text,
                        serde_json::to_string(&blk.props)?,
                        blk.sort_order,
                        ts
                    ],
                )?;
            }
            Self::rebuild_page_links_internal(&tx, &copy_id)?;
        }

        let copy_page = Self::get_page_by_id_conn(&tx, &copy_id)?;
        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &copy_page.id);
        Ok(copy_page)
    }

    pub fn upsert_block(&self, input: UpsertBlockInput) -> Result<Block, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let ts = now_iso();
        let block_id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(new_id);

        let plain = effective_plain_text(
            &input.block_type,
            &input.content,
            &input.plain_text,
            &input.props,
        );
        let props_json = serde_json::to_string(&input.props)?;

        let existing_created: Option<String> = tx
            .query_row(
                "SELECT created_at FROM blocks WHERE id = ?1",
                params![block_id],
                |r| r.get(0),
            )
            .optional()?;

        if existing_created.is_some() {
            tx.execute(
                "UPDATE blocks
                 SET page_id = ?1, block_type = ?2, content = ?3, plain_text = ?4, props_json = ?5, sort_order = ?6, updated_at = ?7
                 WHERE id = ?8",
                params![
                    input.page_id,
                    input.block_type,
                    input.content,
                    plain,
                    props_json,
                    input.sort_order,
                    ts,
                    block_id
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    block_id,
                    input.page_id,
                    input.block_type,
                    input.content,
                    plain,
                    props_json,
                    input.sort_order,
                    ts
                ],
            )?;
        }

        tx.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            params![ts, input.page_id],
        )?;
        Self::rebuild_page_links_internal(&tx, &input.page_id)?;

        let saved = tx.query_row(
            "SELECT id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at
             FROM blocks WHERE id = ?1",
            params![block_id],
            Self::row_to_block,
        )?;
        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &saved.page_id);
        Ok(saved)
    }

    pub fn save_page_blocks(
        &self,
        page_id: &str,
        blocks: Vec<SaveBlockItem>,
    ) -> Result<Vec<Block>, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let _ = Self::get_page_by_id_conn(&tx, page_id)?;
        let ts = now_iso();

        // Preserve existing created_at timestamps for blocks on this page
        let existing_created_map: HashMap<String, String> = {
            let mut stmt =
                tx.prepare("SELECT id, created_at FROM blocks WHERE page_id = ?1")?;
            let rows = stmt.query_map(params![page_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<HashMap<_, _>, _>>()?
        };

        tx.execute("DELETE FROM blocks WHERE page_id = ?1", params![page_id])?;

        for (idx, item) in blocks.into_iter().enumerate() {
            let bid = if item.id.trim().is_empty() {
                new_id()
            } else {
                item.id
            };
            let created_at = existing_created_map
                .get(&bid)
                .cloned()
                .unwrap_or_else(|| ts.clone());
            let plain = effective_plain_text(
                &item.block_type,
                &item.content,
                &item.plain_text,
                &item.props,
            );
            let props_json = serde_json::to_string(&item.props)?;
            let sort_order = if item.sort_order == 0 && idx > 0 {
                idx as i64
            } else {
                item.sort_order
            };

            tx.execute(
                "INSERT INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    bid,
                    page_id,
                    item.block_type,
                    item.content,
                    plain,
                    props_json,
                    sort_order,
                    created_at,
                    ts
                ],
            )?;
        }

        tx.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            params![ts, page_id],
        )?;

        Self::rebuild_page_links_internal(&tx, page_id)?;
        let saved_blocks = Self::get_blocks_for_page_conn(&tx, page_id)?;
        tx.commit()?;
        crate::storage::after_page_mutated(&conn, page_id);
        Ok(saved_blocks)
    }

    pub fn delete_block(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let page_id: Option<String> = tx
            .query_row(
                "SELECT page_id FROM blocks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;

        tx.execute("DELETE FROM blocks WHERE id = ?1", params![id])?;

        if let Some(ref pid) = page_id {
            tx.execute(
                "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
                params![now_iso(), pid],
            )?;
            Self::rebuild_page_links_internal(&tx, pid)?;
        }

        tx.commit()?;
        if let Some(ref pid) = page_id {
            crate::storage::after_page_mutated(&conn, pid);
        }
        Ok(())
    }

    pub(crate) fn ensure_database_initialized_conn(
        conn: &Connection,
        page_id: &str,
    ) -> Result<DatabaseFull, AppError> {
        let _ = Self::get_page_by_id_conn(conn, page_id)?;
        let col_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM db_columns WHERE page_id = ?1",
            params![page_id],
            |r| r.get(0),
        )?;

        if col_count == 0 {
            let ts = now_iso();
            let date_today = ts.chars().take(10).collect::<String>();
            let title_col_id = new_id();
            let status_col_id = new_id();
            let tag_col_id = new_id();
            let date_col_id = new_id();

            let s1 = SelectOption {
                id: new_id(),
                label: "未开始".into(),
                color: "gray".into(),
            };
            let s2 = SelectOption {
                id: new_id(),
                label: "进行中".into(),
                color: "blue".into(),
            };
            let s3 = SelectOption {
                id: new_id(),
                label: "已完成".into(),
                color: "green".into(),
            };

            let t1 = SelectOption {
                id: new_id(),
                label: "重要".into(),
                color: "red".into(),
            };
            let t2 = SelectOption {
                id: new_id(),
                label: "设计".into(),
                color: "purple".into(),
            };
            let t3 = SelectOption {
                id: new_id(),
                label: "研发".into(),
                color: "blue".into(),
            };

            let default_cols = [
                (&title_col_id, "名称", "title", vec![], 240i64, 0i64),
                (
                    &status_col_id,
                    "状态",
                    "status",
                    vec![s1.clone(), s2.clone(), s3],
                    150,
                    1,
                ),
                (
                    &tag_col_id,
                    "标签",
                    "multi_select",
                    vec![t1.clone(), t2, t3.clone()],
                    180,
                    2,
                ),
                (&date_col_id, "日期", "date", vec![], 140, 3),
            ];

            for (cid, name, ctype, opts, width, sort) in default_cols {
                conn.execute(
                    "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![cid, page_id, name, ctype, serde_json::to_string(&opts)?, width, sort],
                )?;
            }

            conn.execute(
                "INSERT OR IGNORE INTO db_meta (page_id, active_view, group_by_col_id)
                 VALUES (?1, 'table', ?2)",
                params![page_id, status_col_id],
            )?;

            let existing_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM db_rows WHERE page_id = ?1",
                params![page_id],
                |r| r.get(0),
            )?;

            if existing_rows == 0 {
                let r1 = json!({
                    &title_col_id: "示例条目 1",
                    &status_col_id: s2.id,
                    &tag_col_id: [t1.id],
                    &date_col_id: date_today
                });
                let r2 = json!({
                    &title_col_id: "示例条目 2",
                    &status_col_id: s1.id,
                    &tag_col_id: [t3.id],
                    &date_col_id: date_today
                });
                for (idx, r_val) in [r1, r2].iter().enumerate() {
                    conn.execute(
                        "INSERT INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)",
                        params![new_id(), page_id, serde_json::to_string(r_val)?, idx as i64, ts],
                    )?;
                }
            }
        }

        Self::get_database_conn(conn, page_id)
    }

    fn get_database_conn(conn: &Connection, page_id: &str) -> Result<DatabaseFull, AppError> {
        let mut col_stmt = conn.prepare(
            "SELECT id, page_id, name, col_type, options_json, width, sort_order
             FROM db_columns WHERE page_id = ?1 ORDER BY sort_order ASC, rowid ASC",
        )?;
        let columns: Vec<DbColumn> = col_stmt
            .query_map(params![page_id], |r| {
                let opts_raw: String = r.get(4)?;
                let options: Vec<SelectOption> = serde_json::from_str(&opts_raw).unwrap_or_default();
                Ok(DbColumn {
                    id: r.get(0)?,
                    page_id: r.get(1)?,
                    name: r.get(2)?,
                    col_type: r.get(3)?,
                    options,
                    width: r.get(5)?,
                    sort_order: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let meta_opt: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT active_view, group_by_col_id FROM db_meta WHERE page_id = ?1",
                params![page_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let (active_view, group_by_col_id) = match meta_opt {
            Some((view, group)) => (view, group),
            None => {
                let default_group = columns
                    .iter()
                    .find(|c| c.col_type == "status" || c.col_type == "select")
                    .map(|c| c.id.clone());
                conn.execute(
                    "INSERT INTO db_meta (page_id, active_view, group_by_col_id) VALUES (?1, 'table', ?2)",
                    params![page_id, default_group],
                )?;
                ("table".to_string(), default_group)
            }
        };

        let mut row_stmt = conn.prepare(
            "SELECT id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at
             FROM db_rows WHERE page_id = ?1 ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows: Vec<DbRow> = row_stmt
            .query_map(params![page_id], |r| {
                let cells_raw: String = r.get(2)?;
                let cells: Map<String, Value> = serde_json::from_str(&cells_raw).unwrap_or_default();
                Ok(DbRow {
                    id: r.get(0)?,
                    page_id: r.get(1)?,
                    cells,
                    linked_page_id: r.get(3)?,
                    sort_order: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(DatabaseFull {
            page_id: page_id.to_string(),
            active_view,
            group_by_col_id,
            columns,
            rows,
        })
    }

    pub fn get_database(&self, page_id: &str) -> Result<DatabaseFull, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let db_full = Self::ensure_database_initialized_conn(&tx, page_id)?;
        tx.commit()?;
        Ok(db_full)
    }

    pub fn update_database_view(
        &self,
        page_id: &str,
        active_view: &str,
        group_by_col_id: Option<String>,
    ) -> Result<DatabaseFull, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let _ = Self::ensure_database_initialized_conn(&tx, page_id)?;
        tx.execute(
            "INSERT INTO db_meta (page_id, active_view, group_by_col_id)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(page_id) DO UPDATE SET active_view = excluded.active_view, group_by_col_id = excluded.group_by_col_id",
            params![page_id, active_view, group_by_col_id],
        )?;
        let db_full = Self::get_database_conn(&tx, page_id)?;
        tx.commit()?;
        Ok(db_full)
    }

    pub fn upsert_db_column(&self, column: UpsertDbColumnInput) -> Result<DbColumn, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let col_id = column
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(new_id);

        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT width, sort_order FROM db_columns WHERE id = ?1",
                params![col_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let options_json = serde_json::to_string(&column.options)?;

        let (final_width, final_sort) = if let Some((prev_w, prev_sort)) = existing {
            let w = column.width.unwrap_or(prev_w);
            let s = column.sort_order.unwrap_or(prev_sort);
            tx.execute(
                "UPDATE db_columns
                 SET name = ?1, col_type = ?2, options_json = ?3, width = ?4, sort_order = ?5
                 WHERE id = ?6",
                params![column.name, column.col_type, options_json, w, s, col_id],
            )?;
            (w, s)
        } else {
            let max_sort: Option<i64> = tx.query_row(
                "SELECT MAX(sort_order) FROM db_columns WHERE page_id = ?1",
                params![column.page_id],
                |r| r.get(0),
            )?;
            let w = column.width.unwrap_or(180);
            let s = column
                .sort_order
                .unwrap_or_else(|| max_sort.map(|m| m + 1).unwrap_or(0));
            tx.execute(
                "INSERT INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    col_id,
                    column.page_id,
                    column.name,
                    column.col_type,
                    options_json,
                    w,
                    s
                ],
            )?;
            (w, s)
        };

        tx.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            params![now_iso(), column.page_id],
        )?;

        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &column.page_id);
        Ok(DbColumn {
            id: col_id,
            page_id: column.page_id,
            name: column.name,
            col_type: column.col_type,
            options: column.options,
            width: final_width,
            sort_order: final_sort,
        })
    }

    pub fn delete_db_column(&self, id: &str) -> Result<(), AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let page_id_opt: Option<String> = tx
            .query_row(
                "SELECT page_id FROM db_columns WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;

        tx.execute("DELETE FROM db_columns WHERE id = ?1", params![id])?;

        if let Some(ref page_id) = page_id_opt {
            // Strip deleted column key from all rows on this database page
            let rows_to_clean: Vec<(String, String)> = {
                let mut stmt =
                    tx.prepare("SELECT id, cells_json FROM db_rows WHERE page_id = ?1")?;
                let mapped = stmt.query_map(params![page_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                mapped.collect::<Result<Vec<_>, _>>()?
            };
            for (rid, raw_cells) in rows_to_clean {
                if let Ok(mut map) = serde_json::from_str::<Map<String, Value>>(&raw_cells) {
                    if map.remove(id).is_some() {
                        tx.execute(
                            "UPDATE db_rows SET cells_json = ?1 WHERE id = ?2",
                            params![serde_json::to_string(&map)?, rid],
                        )?;
                    }
                }
            }

            // Reassign group_by_col_id if it pointed to the deleted column
            let current_group: Option<Option<String>> = tx
                .query_row(
                    "SELECT group_by_col_id FROM db_meta WHERE page_id = ?1",
                    params![page_id],
                    |r| r.get(0),
                )
                .optional()?;
            if current_group == Some(Some(id.to_string())) {
                let fallback_group: Option<String> = tx
                    .query_row(
                        "SELECT id FROM db_columns
                         WHERE page_id = ?1 AND col_type IN ('status', 'select')
                         ORDER BY sort_order ASC LIMIT 1",
                        params![page_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                tx.execute(
                    "UPDATE db_meta SET group_by_col_id = ?1 WHERE page_id = ?2",
                    params![fallback_group, page_id],
                )?;
            }
        }

        tx.commit()?;
        if let Some(ref pid) = page_id_opt {
            crate::storage::after_page_mutated(&conn, pid);
        }
        Ok(())
    }

    pub fn upsert_db_row(&self, row: UpsertDbRowInput) -> Result<DbRow, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let ts = now_iso();
        let row_id = row
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(new_id);

        let existing: Option<(Option<String>, i64, String)> = tx
            .query_row(
                "SELECT linked_page_id, sort_order, created_at FROM db_rows WHERE id = ?1",
                params![row_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;

        let cells_json = serde_json::to_string(&row.cells)?;

        let (final_linked, final_sort, created_at) =
            if let Some((prev_linked, prev_sort, prev_created)) = existing {
                let linked = match row.linked_page_id {
                    Some(explicit) => explicit,
                    None => prev_linked,
                };
                let sort = row.sort_order.unwrap_or(prev_sort);
                tx.execute(
                    "UPDATE db_rows
                     SET cells_json = ?1, linked_page_id = ?2, sort_order = ?3, updated_at = ?4
                     WHERE id = ?5",
                    params![cells_json, linked, sort, ts, row_id],
                )?;
                (linked, sort, prev_created)
            } else {
                let max_sort: Option<i64> = tx.query_row(
                    "SELECT MAX(sort_order) FROM db_rows WHERE page_id = ?1",
                    params![row.page_id],
                    |r| r.get(0),
                )?;
                let linked = row.linked_page_id.flatten();
                let sort = row
                    .sort_order
                    .unwrap_or_else(|| max_sort.map(|m| m + 1).unwrap_or(0));
                tx.execute(
                    "INSERT INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![row_id, row.page_id, cells_json, linked, sort, ts],
                )?;
                (linked, sort, ts.clone())
            };

        tx.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            params![ts, row.page_id],
        )?;

        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &row.page_id);
        Ok(DbRow {
            id: row_id,
            page_id: row.page_id,
            cells: row.cells,
            linked_page_id: final_linked,
            sort_order: final_sort,
            created_at,
            updated_at: ts,
        })
    }

    pub fn delete_db_row(&self, id: &str) -> Result<(), AppError> {
        let conn = self.lock()?;
        let page_id_opt: Option<String> = conn
            .query_row(
                "SELECT page_id FROM db_rows WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        conn.execute("DELETE FROM db_rows WHERE id = ?1", params![id])?;
        if let Some(ref pid) = page_id_opt {
            crate::storage::after_page_mutated(&conn, pid);
        }
        Ok(())
    }

    fn build_fts5_match_query(raw_query: &str) -> Option<String> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        for ch in raw_query.chars() {
            if ch.is_alphanumeric() || ch == '_' {
                current.push(ch);
            } else if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        if tokens.is_empty() {
            None
        } else {
            let parts: Vec<String> = tokens
                .into_iter()
                .map(|t| format!("\"{}\"*", t.replace('"', "")))
                .collect();
            Some(parts.join(" "))
        }
    }

    pub fn search_workspace(&self, query: &str) -> Result<Vec<SearchResult>, AppError> {
        let conn = self.lock()?;
        let trimmed = query.trim();

        // Empty query returns recent active pages for Ctrl+K quick jump
        if trimmed.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT id, title, icon, page_type, updated_at
                 FROM pages
                 WHERE is_trashed = 0
                 ORDER BY updated_at DESC
                 LIMIT 15",
            )?;
            let recent = stmt
                .query_map([], |r| {
                    let ptype: String = r.get(3)?;
                    let snippet = if ptype == "database" {
                        "多维数据库页面".to_string()
                    } else {
                        "最近访问的文档页面".to_string()
                    };
                    Ok(SearchResult {
                        page_id: r.get(0)?,
                        page_title: r.get(1)?,
                        page_icon: r.get(2)?,
                        page_type: ptype,
                        block_id: None,
                        snippet,
                        updated_at: r.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(recent);
        }

        let mut results: Vec<SearchResult> = Vec::new();
        let mut seen_keys: HashSet<String> = HashSet::new();
        let first_needle = trimmed.split_whitespace().next().unwrap_or(trimmed);

        // Phase 1: SQLite FTS5 BM25 ranked search across pages_fts & blocks_fts
        if let Some(fts_expr) = Self::build_fts5_match_query(trimmed) {
            if let Ok(mut p_stmt) = conn.prepare(
                "SELECT p.id, p.title, p.icon, p.page_type, p.updated_at
                 FROM pages_fts
                 JOIN pages p ON p.id = pages_fts.page_id
                 WHERE pages_fts MATCH ?1 AND p.is_trashed = 0
                 ORDER BY bm25(pages_fts) ASC
                 LIMIT 15",
            ) {
                if let Ok(rows) = p_stmt.query_map(params![fts_expr], |r| {
                    let pid: String = r.get(0)?;
                    let title: String = r.get(1)?;
                    Ok(SearchResult {
                        page_id: pid,
                        page_title: title.clone(),
                        page_icon: r.get(2)?,
                        page_type: r.get(3)?,
                        block_id: None,
                        snippet: title,
                        updated_at: r.get(4)?,
                    })
                }) {
                    for item in rows.flatten() {
                        let key = format!("page:{}", item.page_id);
                        if seen_keys.insert(key) {
                            results.push(item);
                        }
                    }
                }
            }

            if let Ok(mut b_stmt) = conn.prepare(
                "SELECT p.id, p.title, p.icon, p.page_type, b.id, b.plain_text, b.props_json, b.updated_at
                 FROM blocks_fts
                 JOIN blocks b ON b.id = blocks_fts.block_id
                 JOIN pages p ON p.id = b.page_id
                 WHERE blocks_fts MATCH ?1 AND p.is_trashed = 0
                 ORDER BY bm25(blocks_fts) ASC
                 LIMIT 20",
            ) {
                if let Ok(rows) = b_stmt.query_map(params![fts_expr], |r| {
                    let plain: String = r.get(5)?;
                    let props_raw: String = r.get(6)?;
                    let display = if !plain.trim().is_empty() {
                        plain
                    } else if let Ok(p) = serde_json::from_str::<BlockProps>(&props_raw) {
                        p.children_text.unwrap_or_default()
                    } else {
                        String::new()
                    };
                    Ok(SearchResult {
                        page_id: r.get(0)?,
                        page_title: r.get(1)?,
                        page_icon: r.get(2)?,
                        page_type: r.get(3)?,
                        block_id: Some(r.get(4)?),
                        snippet: make_snippet_around(&display, first_needle, 110),
                        updated_at: r.get(7)?,
                    })
                }) {
                    for item in rows.flatten() {
                        if let Some(ref bid) = item.block_id {
                            if seen_keys.insert(format!("block:{}", bid)) {
                                results.push(item);
                            }
                        }
                    }
                }
            }
        }

        // Phase 2: Case-insensitive CJK & multi-token substring fallback across pages, blocks, and db_rows
        let lower_tokens: Vec<String> = trimmed
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect();

        let matches_all_tokens = |haystack: &str| -> bool {
            let lower = haystack.to_lowercase();
            lower_tokens.iter().all(|tok| lower.contains(tok))
        };

        // 2a. Pages title substring check
        let mut all_pages_stmt = conn.prepare(
            "SELECT id, title, icon, page_type, updated_at
             FROM pages WHERE is_trashed = 0 ORDER BY updated_at DESC",
        )?;
        let active_pages: Vec<(String, String, String, String, String)> = all_pages_stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let page_lookup: HashMap<String, (String, String, String)> = active_pages
            .iter()
            .map(|(id, title, icon, ptype, _)| {
                (id.clone(), (title.clone(), icon.clone(), ptype.clone()))
            })
            .collect();

        for (pid, title, icon, ptype, updated_at) in &active_pages {
            if matches_all_tokens(title) && seen_keys.insert(format!("page:{}", pid)) {
                results.push(SearchResult {
                    page_id: pid.clone(),
                    page_title: title.clone(),
                    page_icon: icon.clone(),
                    page_type: ptype.clone(),
                    block_id: None,
                    snippet: title.clone(),
                    updated_at: updated_at.clone(),
                });
            }
        }

        // 2b. Blocks substring check (plain_text + toggle childrenText + table cells)
        let mut blk_stmt = conn.prepare(
            "SELECT b.id, b.page_id, b.block_type, b.content, b.plain_text, b.props_json, b.updated_at
             FROM blocks b
             JOIN pages p ON p.id = b.page_id
             WHERE p.is_trashed = 0
             ORDER BY b.updated_at DESC",
        )?;
        let blk_rows = blk_stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;

        for row_res in blk_rows {
            if results.len() >= 30 {
                break;
            }
            let (bid, pid, btype, content, plain, props_raw, updated_at) = row_res?;
            if seen_keys.contains(&format!("block:{}", bid)) {
                continue;
            }
            let Some((ptitle, picon, ptype)) = page_lookup.get(&pid) else {
                continue;
            };
            let props: BlockProps = serde_json::from_str(&props_raw).unwrap_or_default();
            let mut searchable = if is_raw_text_block(&btype) {
                if !content.is_empty() {
                    content
                } else {
                    plain
                }
            } else if !plain.trim().is_empty() {
                plain
            } else {
                effective_plain_text(&btype, &content, "", &props)
            };
            for extra in [
                props.children_text.as_deref(),
                props.caption.as_deref(),
                props.bookmark_title.as_deref(),
                props.bookmark_desc.as_deref(),
                props.bookmark_site.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                if !extra.is_empty() && !searchable.contains(extra) {
                    searchable.push(' ');
                    searchable.push_str(extra);
                }
            }
            if !searchable.is_empty() && matches_all_tokens(&searchable) {
                seen_keys.insert(format!("block:{}", bid));
                results.push(SearchResult {
                    page_id: pid,
                    page_title: ptitle.clone(),
                    page_icon: picon.clone(),
                    page_type: ptype.clone(),
                    block_id: Some(bid),
                    snippet: make_snippet_around(&searchable, first_needle, 110),
                    updated_at,
                });
            }
        }

        // 2c. Database rows substring check (including select/status option labels)
        if results.len() < 30 {
            let mut opt_labels: HashMap<String, String> = HashMap::new();
            let mut opt_stmt = conn.prepare("SELECT options_json FROM db_columns")?;
            let opt_iter = opt_stmt.query_map([], |r| r.get::<_, String>(0))?;
            for raw in opt_iter.flatten() {
                if let Ok(opts) = serde_json::from_str::<Vec<SelectOption>>(&raw) {
                    for o in opts {
                        opt_labels.insert(o.id, o.label);
                    }
                }
            }

            let mut dbr_stmt = conn.prepare(
                "SELECT r.id, r.page_id, r.cells_json, r.updated_at
                 FROM db_rows r
                 JOIN pages p ON p.id = r.page_id
                 WHERE p.is_trashed = 0
                 ORDER BY r.updated_at DESC",
            )?;
            let dbr_rows = dbr_stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;

            for dbr in dbr_rows {
                if results.len() >= 30 {
                    break;
                }
                let (rid, pid, cells_raw, updated_at) = dbr?;
                let Some((ptitle, picon, ptype)) = page_lookup.get(&pid) else {
                    continue;
                };
                if let Ok(map) = serde_json::from_str::<Map<String, Value>>(&cells_raw) {
                    let mut parts = Vec::new();
                    for val in map.values() {
                        match val {
                            Value::String(s) => {
                                if let Some(lbl) = opt_labels.get(s) {
                                    parts.push(lbl.clone());
                                } else {
                                    parts.push(s.clone());
                                }
                            }
                            Value::Number(n) => parts.push(n.to_string()),
                            Value::Array(arr) => {
                                for item in arr {
                                    if let Some(s) = item.as_str() {
                                        if let Some(lbl) = opt_labels.get(s) {
                                            parts.push(lbl.clone());
                                        } else {
                                            parts.push(s.to_string());
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    let joined = parts.join(" · ");
                    if !joined.is_empty()
                        && matches_all_tokens(&joined)
                        && seen_keys.insert(format!("dbrow:{}", rid))
                    {
                        results.push(SearchResult {
                            page_id: pid,
                            page_title: ptitle.clone(),
                            page_icon: picon.clone(),
                            page_type: ptype.clone(),
                            block_id: None,
                            snippet: make_snippet_around(&joined, first_needle, 110),
                            updated_at,
                        });
                    }
                }
            }
        }

        results.truncate(30);
        Ok(results)
    }

    pub fn export_page_markdown(&self, id: &str) -> Result<MarkdownExport, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let page = Self::get_page_by_id_conn(&tx, id)?;
        let exported = if page.page_type == "database" {
            let db_full = Self::ensure_database_initialized_conn(&tx, id)?;
            export_database_to_markdown(&page, &db_full)
        } else {
            let blocks = Self::get_blocks_for_page_conn(&tx, id)?;
            export_doc_to_markdown(&page, &blocks)
        };
        tx.commit()?;
        Ok(exported)
    }

    pub fn import_markdown_page(
        &self,
        title: &str,
        markdown: &str,
        parent_id: Option<String>,
    ) -> Result<Page, AppError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let ts = now_iso();
        let page_id = new_id();
        let normalized_parent = parent_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let final_title = derive_markdown_title(title, markdown);
        let next_sort = Self::next_sibling_sort_order(&tx, normalized_parent.as_deref())?;

        tx.execute(
            "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, '📄', NULL, 'doc', 0, 0, ?4, ?5, ?5)",
            params![page_id, normalized_parent, final_title, next_sort, ts],
        )?;

        let drafts = parse_markdown_to_blocks(markdown);
        for (idx, draft) in drafts.into_iter().enumerate() {
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
        }

        Self::rebuild_page_links_internal(&tx, &page_id)?;
        let created = Self::get_page_by_id_conn(&tx, &page_id)?;
        tx.commit()?;
        crate::storage::after_page_mutated(&conn, &created.id);
        Ok(created)
    }

    pub fn get_settings(&self) -> Result<HashMap<String, String>, AppError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = HashMap::new();
        for r in rows {
            let (k, v) = r?;
            // 同步密码、令牌等只在后端使用，不返回给界面
            if k.starts_with(crate::sync_config::SECRET_PREFIX) {
                continue;
            }
            out.insert(k, v);
        }
        Ok(out)
    }

    /// 读取单个设置（含后端专用的密钥类设置）
    pub fn get_setting_raw(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.lock()?;
        Ok(conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get::<_, String>(0))
            .optional()?)
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), AppError> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_seeded_workspace_has_only_the_guide() {
        let db = Database::open_in_memory().expect("open seeded in-memory db");
        let pages = db.list_pages().unwrap();
        assert_eq!(pages.len(), 1, "new workspace should only contain the built-in guide");
        assert_eq!(pages[0].id, "page-welcome");
        assert_eq!(pages[0].page_type, "doc");

        let welcome = db.get_page_detail("page-welcome").unwrap();
        assert!(welcome.blocks.len() >= 10);
        assert!(welcome
            .blocks
            .iter()
            .any(|b| b.plain_text.contains("打开文件夹")));
        assert!(welcome.backlinks.is_empty());
    }

    #[test]
    fn test_fts5_and_chinese_cjk_substring_search() {
        let db = Database::open_in_memory().expect("open seeded db");

        // Seeded guide is searchable by a Chinese mid-sentence substring
        let guide_hits = db.search_workspace("反向链接").unwrap();
        assert!(guide_hits.iter().any(|h| h.page_id == "page-welcome"));

        let page = db
            .create_page(CreatePageInput {
                title: Some("产品路线图".into()),
                ..Default::default()
            })
            .unwrap();
        db.save_page_blocks(
            &page.id,
            vec![SaveBlockItem {
                id: "fts-1".into(),
                block_type: "paragraph".into(),
                content: "结合 SQLite FTS5 倒排索引实现毫秒级中英双语搜索".into(),
                plain_text: String::new(),
                props: BlockProps::default(),
                sort_order: 0,
            }],
        )
        .unwrap();

        // 1. English multi-token FTS5 query
        let fts_hits = db.search_workspace("SQLite FTS5").unwrap();
        assert!(fts_hits.iter().any(|h| h.page_id == page.id));

        // 2. Mid-phrase Chinese substring query
        let cjk_hits = db.search_workspace("路线图").unwrap();
        assert!(cjk_hits.iter().any(|h| h.page_id == page.id));
        let mid_hits = db.search_workspace("倒排索引").unwrap();
        assert!(mid_hits.iter().any(|h| h.page_id == page.id));
    }

    #[test]
    fn test_save_blocks_extracts_both_data_page_id_and_wikilinks() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let target_a = db
            .create_page(CreatePageInput {
                title: Some("Design System".into()),
                icon: Some("🎨".into()),
                ..Default::default()
            })
            .unwrap();
        let target_b = db
            .create_page(CreatePageInput {
                title: Some("季度规划文档".into()),
                icon: Some("📊".into()),
                ..Default::default()
            })
            .unwrap();
        let source = db
            .create_page(CreatePageInput {
                title: Some("Sprint Notes".into()),
                ..Default::default()
            })
            .unwrap();

        let saved = db
            .save_page_blocks(
                &source.id,
                vec![
                    SaveBlockItem {
                        id: "b-link-1".into(),
                        block_type: "paragraph".into(),
                        content: format!(
                            "See <a href=\"#\" data-page-id=\"{}\" class=\"nb-wiki-link\">Design System</a>",
                            target_a.id
                        ),
                        plain_text: "See Design System".into(),
                        props: BlockProps::default(),
                        sort_order: 0,
                    },
                    SaveBlockItem {
                        id: "b-link-2".into(),
                        block_type: "paragraph".into(),
                        content: "另见 [[季度规划文档]] 了解排期".into(),
                        plain_text: "另见 [[季度规划文档]] 了解排期".into(),
                        props: BlockProps::default(),
                        sort_order: 1,
                    },
                ],
            )
            .unwrap();
        assert_eq!(saved.len(), 2);

        let detail_a = db.get_page_detail(&target_a.id).unwrap();
        assert_eq!(detail_a.backlinks.len(), 1);
        assert_eq!(detail_a.backlinks[0].source_page_id, source.id);

        let detail_b = db.get_page_detail(&target_b.id).unwrap();
        assert_eq!(detail_b.backlinks.len(), 1);
        assert_eq!(detail_b.backlinks[0].source_page_id, source.id);
    }

    #[test]
    fn test_trash_restore_orphan_promotion_and_cascade_delete() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let parent = db
            .create_page(CreatePageInput {
                title: Some("Parent".into()),
                ..Default::default()
            })
            .unwrap();
        let child = db
            .create_page(CreatePageInput {
                parent_id: Some(parent.id.clone()),
                title: Some("Child".into()),
                ..Default::default()
            })
            .unwrap();

        // Trashing parent also trashes child
        db.trash_page(&parent.id).unwrap();
        assert!(db.list_pages().unwrap().is_empty());
        assert_eq!(db.list_trashed_pages().unwrap().len(), 2);

        // Restoring child while parent is still trashed promotes child's parent_id to None
        let restored_child = db.restore_page(&child.id).unwrap();
        assert!(!restored_child.is_trashed);
        assert_eq!(restored_child.parent_id, None);

        // Empty trash permanently removes trashed parent
        db.empty_trash().unwrap();
        assert!(db.list_trashed_pages().unwrap().is_empty());
        assert_eq!(db.list_pages().unwrap().len(), 1);
    }

    #[test]
    fn test_templates_duplicate_database_and_markdown_roundtrip() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let task_db_page = db
            .create_page(CreatePageInput {
                template_id: Some("task-hub".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(task_db_page.page_type, "database");

        let full = db.get_database(&task_db_page.id).unwrap();
        assert_eq!(full.active_view, "board");
        assert!(!full.columns.is_empty());
        assert_eq!(full.rows.len(), 2);

        // Duplicate database page and verify column IDs were remapped in rows
        let dup_page = db.duplicate_page(&task_db_page.id).unwrap();
        let dup_full = db.get_database(&dup_page.id).unwrap();
        assert_eq!(dup_full.columns.len(), full.columns.len());
        assert_ne!(dup_full.columns[0].id, full.columns[0].id);
        let new_title_col_id = &dup_full.columns[0].id;
        assert!(dup_full.rows[0].cells.contains_key(new_title_col_id));

        // Import and export markdown
        let imported = db
            .import_markdown_page(
                "",
                "# 架构笔记\n\n- [x] 第一项\n- [ ] 第二项\n\n```sql\nSELECT 1;\n```",
                None,
            )
            .unwrap();
        assert_eq!(imported.title, "架构笔记");
        let exported = db.export_page_markdown(&imported.id).unwrap();
        assert!(exported.markdown.contains("- [x] 第一项"));
        assert!(exported.markdown.contains("```sql"));

        // Settings CRUD
        db.set_setting("theme", "dark").unwrap();
        let settings = db.get_settings().unwrap();
        assert_eq!(settings.get("theme").map(String::as_str), Some("dark"));
    }

    #[test]
    fn test_raw_code_blocks_and_dangling_linked_page_cleanup() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let host = db
            .create_page(CreatePageInput {
                title: Some("代码片段".into()),
                ..Default::default()
            })
            .unwrap();

        // 1. Saving a code block with `<T>` generics and empty plain_text preserves raw text
        let saved_blk = db
            .upsert_block(UpsertBlockInput {
                id: None,
                page_id: host.id.clone(),
                block_type: "code".into(),
                content: "fn map<T, U>(v: Vec<T>) -> Vec<U> { todo!() }".into(),
                plain_text: String::new(),
                props: BlockProps {
                    language: Some("rust".into()),
                    ..Default::default()
                },
                sort_order: 0,
            })
            .unwrap();
        assert_eq!(
            saved_blk.plain_text,
            "fn map<T, U>(v: Vec<T>) -> Vec<U> { todo!() }"
        );
        let detail = db.get_page_detail(&host.id).unwrap();
        let code = detail
            .blocks
            .iter()
            .find(|b| b.block_type == "code")
            .expect("saved code block");
        assert_eq!(code.plain_text, "fn map<T, U>(v: Vec<T>) -> Vec<U> { todo!() }");

        // 2. Deleting a linked page clears db_rows.linked_page_id (both permanent delete & empty_trash)
        let tasks = db
            .create_page(CreatePageInput {
                template_id: Some("task-hub".into()),
                ..Default::default()
            })
            .unwrap();
        let before = db.get_database(&tasks.id).unwrap();
        assert!(before.rows.len() >= 2);

        let link_row = |row_idx: usize, target: &str| {
            let full = db.get_database(&tasks.id).unwrap();
            let row = &full.rows[row_idx];
            db.upsert_db_row(UpsertDbRowInput {
                id: Some(row.id.clone()),
                page_id: tasks.id.clone(),
                cells: row.cells.clone(),
                linked_page_id: Some(Some(target.to_string())),
                sort_order: Some(row.sort_order),
            })
            .unwrap();
        };

        let spec = db
            .create_page(CreatePageInput {
                title: Some("Spec".into()),
                ..Default::default()
            })
            .unwrap();
        link_row(0, &spec.id);
        assert_eq!(
            db.get_database(&tasks.id).unwrap().rows[0].linked_page_id.as_deref(),
            Some(spec.id.as_str())
        );
        db.delete_page_permanently(&spec.id).unwrap();
        assert_eq!(db.get_database(&tasks.id).unwrap().rows[0].linked_page_id, None);

        let doc2 = db
            .create_page(CreatePageInput {
                title: Some("Row Spec".into()),
                ..Default::default()
            })
            .unwrap();
        link_row(1, &doc2.id);
        assert_eq!(
            db.get_database(&tasks.id).unwrap().rows[1].linked_page_id.as_deref(),
            Some(doc2.id.as_str())
        );
        db.trash_page(&doc2.id).unwrap();
        db.empty_trash().unwrap();
        assert_eq!(db.get_database(&tasks.id).unwrap().rows[1].linked_page_id, None);
    }

    #[test]
    fn test_raw_math_and_rich_media_blocks_search_and_save() {
        let db = Database::open_in_memory_unseeded().unwrap();
        let page = db
            .create_page(CreatePageInput {
                title: Some("数学与媒体测试页".into()),
                ..Default::default()
            })
            .unwrap();

        let latex = "\\forall x < y, \\quad \\sum_{i=1}^{n} a_i > 0";
        let saved = db
            .save_page_blocks(
                &page.id,
                vec![
                    SaveBlockItem {
                        id: "m1".into(),
                        block_type: "math".into(),
                        content: latex.into(),
                        plain_text: String::new(),
                        props: BlockProps::default(),
                        sort_order: 0,
                    },
                    SaveBlockItem {
                        id: "bm1".into(),
                        block_type: "bookmark".into(),
                        content: String::new(),
                        plain_text: String::new(),
                        props: BlockProps {
                            url: Some("https://www.rust-lang.org".into()),
                            bookmark_title: Some("Rust 程序设计语言官网".into()),
                            bookmark_desc: Some("构建可靠且高效的软件系统".into()),
                            bookmark_site: Some("rust-lang.org".into()),
                            ..Default::default()
                        },
                        sort_order: 1,
                    },
                ],
            )
            .unwrap();

        assert_eq!(saved[0].content, latex);
        assert_eq!(saved[0].plain_text, latex);
        assert!(!saved[0].plain_text.contains("&lt;"));

        let math_hits = db.search_workspace("\\sum_{i=1}^{n}").unwrap();
        assert!(math_hits.iter().any(|h| h.page_id == page.id));

        let bm_hits = db.search_workspace("程序设计语言").unwrap();
        assert!(bm_hits.iter().any(|h| h.page_id == page.id));
    }

    #[test]
    fn test_mermaid_and_rich_table_db_roundtrip_and_search() {
        let db = Database::open_in_memory().unwrap();
        let mermaid_src = "flowchart TB\n  subgraph Triggers[\"一、四大业务调用入口\"]\n    UI_UW[\"① 投保单人工核保页<br/>uwDetail.js (62)\"]\n    BAK[\"getNewDecisionResultBak(actualId)<br/>返回 Map&lt;String,String&gt;\"]\n  end\n  UI_UW --> BAK";
        let md = format!(
            "```mermaid\n{}\n```\n\n| 层级 | 实现类 | 方法 |\n| :--- | :---: | ---: |\n| **Controller** | [PlcRiskAppraisalControllerImpl](file:///d:/src/PlcRiskAppraisalControllerImpl.java#L42) | `getNewDecisionResult` |\n",
            mermaid_src
        );

        let imported = db.import_markdown_page("核保架构设计", &md, None).unwrap();
        let detail = db.get_page_detail(&imported.id).unwrap();
        assert_eq!(detail.blocks.len(), 2);
        assert_eq!(detail.blocks[0].block_type, "mermaid");
        assert_eq!(detail.blocks[0].content, mermaid_src);
        assert_eq!(detail.blocks[0].plain_text, mermaid_src);
        assert!(detail.blocks[0].content.contains("<br/>"));
        assert!(detail.blocks[0].content.contains("Map&lt;String,String&gt;"));

        assert_eq!(detail.blocks[1].block_type, "table");
        assert_eq!(
            detail.blocks[1].props.col_alignments.as_ref().unwrap(),
            &vec!["left".to_string(), "center".to_string(), "right".to_string()]
        );
        let row0 = &detail.blocks[1].props.rows.as_ref().unwrap()[0];
        assert_eq!(row0[0], "<b>Controller</b>");
        assert!(row0[1].contains("file:///d:/src/PlcRiskAppraisalControllerImpl.java#L42"));
        assert_eq!(row0[2], "<code>getNewDecisionResult</code>");

        // Search finds both raw Mermaid CJK/identifier and stripped table cell text
        let m_hits = db.search_workspace("四大业务调用入口").unwrap();
        assert!(m_hits.iter().any(|h| h.page_id == imported.id));
        let t_hits = db.search_workspace("getNewDecisionResult").unwrap();
        assert!(t_hits.iter().any(|h| h.page_id == imported.id));

        // Export preserves exact Mermaid & GFM table row
        let exported = db.export_page_markdown(&imported.id).unwrap();
        assert!(exported.markdown.contains("```mermaid\nflowchart TB"));
        assert!(exported.markdown.contains("<br/>uwDetail.js (62)"));
        assert!(exported.markdown.contains("Map&lt;String,String&gt;"));
        assert!(exported.markdown.contains("| **Controller** | [PlcRiskAppraisalControllerImpl](file:///d:/src/PlcRiskAppraisalControllerImpl.java#L42) | `getNewDecisionResult` |"));
    }
}
