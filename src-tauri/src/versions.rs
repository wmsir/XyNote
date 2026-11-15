//! 页面历史版本（永久版功能）。
//!
//! 编辑前按时间间隔自动保存一份页面快照（与同步用的是同一种快照，含正文块与表格数据）；
//! 被同步覆盖前、恢复旧版本前也会各存一份。历史只保存在本机，不参与同步。

use crate::models::AppError;
use crate::sync::{apply_snapshot, export_snapshot, PageSnapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// 两次自动保存之间至少间隔
pub const AUTO_GAP_MINUTES: i64 = 10;
/// 每个页面最多保留的版本数
pub const MAX_PER_PAGE: i64 = 60;

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS page_versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        size INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, created_at);
    CREATE TRIGGER IF NOT EXISTS trg_pages_versions_cleanup AFTER DELETE ON pages BEGIN
        DELETE FROM page_versions WHERE page_id = OLD.id;
    END;
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageVersionMeta {
    pub id: String,
    pub page_id: String,
    pub created_at: String,
    pub title: String,
    /// edit = 编辑前自动保存，sync = 被同步覆盖前，restore = 恢复旧版本前
    pub reason: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBlock {
    pub block_type: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageVersionView {
    pub meta: PageVersionMeta,
    pub icon: String,
    pub blocks: Vec<VersionBlock>,
    pub is_database: bool,
    pub column_names: Vec<String>,
    pub row_count: usize,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 保存当前页面的一份快照。`gap_minutes` 内已有版本、或内容与上一版相同则跳过。返回是否保存。
pub fn checkpoint(conn: &Connection, page_id: &str, reason: &str, gap_minutes: i64) -> Result<bool, AppError> {
    let Some(snap) = export_snapshot(conn, page_id)? else { return Ok(false) };
    let json = serde_json::to_string(&snap).map_err(|e| AppError::Validation(e.to_string()))?;
    let last: Option<(String, String)> = conn
        .query_row(
            "SELECT created_at, snapshot_json FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC LIMIT 1",
            params![page_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((at, last_json)) = &last {
        if *last_json == json {
            return Ok(false);
        }
        if gap_minutes > 0 {
            let recent = chrono::DateTime::parse_from_rfc3339(at)
                .map(|t| chrono::Utc::now().signed_duration_since(t) < chrono::Duration::minutes(gap_minutes))
                .unwrap_or(false);
            if recent {
                return Ok(false);
            }
        }
    }
    conn.execute(
        "INSERT INTO page_versions (id, page_id, created_at, title, reason, size, snapshot_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![uuid::Uuid::new_v4().to_string(), page_id, now(), snap.page.title, reason, json.len() as i64, json],
    )?;
    conn.execute(
        "DELETE FROM page_versions WHERE page_id = ?1 AND id NOT IN (
             SELECT id FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
        params![page_id, MAX_PER_PAGE],
    )?;
    Ok(true)
}

fn meta_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PageVersionMeta> {
    Ok(PageVersionMeta {
        id: r.get(0)?,
        page_id: r.get(1)?,
        created_at: r.get(2)?,
        title: r.get(3)?,
        reason: r.get(4)?,
        size: r.get(5)?,
    })
}

pub fn list(conn: &Connection, page_id: &str) -> Result<Vec<PageVersionMeta>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, page_id, created_at, title, reason, size FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![page_id], meta_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn count(conn: &Connection, page_id: &str) -> Result<i64, AppError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM page_versions WHERE page_id = ?1", params![page_id], |r| r.get(0))?)
}

fn load(conn: &Connection, version_id: &str) -> Result<(PageVersionMeta, PageSnapshot), AppError> {
    let (meta, json): (PageVersionMeta, String) = conn
        .query_row(
            "SELECT id, page_id, created_at, title, reason, size, snapshot_json FROM page_versions WHERE id = ?1",
            params![version_id],
            |r| Ok((meta_from_row(r)?, r.get(6)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("这个历史版本已不存在".into()))?;
    let snap: PageSnapshot = serde_json::from_str(&json).map_err(|_| AppError::Validation("历史版本数据已损坏".into()))?;
    Ok((meta, snap))
}

pub fn get(conn: &Connection, version_id: &str) -> Result<PageVersionView, AppError> {
    let (meta, snap) = load(conn, version_id)?;
    let mut blocks = snap.blocks.clone();
    blocks.sort_by_key(|b| b.sort_order);
    Ok(PageVersionView {
        meta,
        icon: snap.page.icon.clone(),
        blocks: blocks
            .into_iter()
            .map(|b| VersionBlock {
                text: if b.plain_text.trim().is_empty() { b.content } else { b.plain_text },
                block_type: b.block_type,
            })
            .collect(),
        is_database: snap.page.page_type == "database",
        column_names: {
            let mut cols = snap.db_columns.clone();
            cols.sort_by_key(|c| c.sort_order);
            cols.into_iter().map(|c| c.name).collect()
        },
        row_count: snap.db_rows.len(),
    })
}

/// 恢复到某个版本：先把当前内容存一份，再写回旧内容。页面所在位置、收藏和回收站状态保持不变。
pub fn restore(conn: &Connection, version_id: &str) -> Result<String, AppError> {
    let (meta, mut snap) = load(conn, version_id)?;
    checkpoint(conn, &meta.page_id, "restore", 0)?;
    if let Some(cur) = export_snapshot(conn, &meta.page_id)? {
        snap.page.parent_id = cur.page.parent_id;
        snap.page.sort_order = cur.page.sort_order;
        snap.page.is_favorite = cur.page.is_favorite;
        snap.page.is_trashed = cur.page.is_trashed;
    }
    // 恢复本身是一次新的编辑：时间更新为现在，同步时才会以它为准
    snap.page.updated_at = now();
    apply_snapshot(conn, &snap)?;
    crate::db::Database::rebuild_page_links_internal(conn, &meta.page_id)?;
    Ok(meta.page_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::{BlockProps, CreatePageInput, SaveBlockItem};

    fn block(text: &str) -> SaveBlockItem {
        SaveBlockItem {
            id: "v-1".into(),
            block_type: "paragraph".into(),
            content: text.into(),
            plain_text: text.into(),
            props: BlockProps::default(),
            sort_order: 0,
        }
    }

    #[test]
    fn checkpoints_are_spaced_deduped_and_restorable() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(CreatePageInput { title: Some("周报".into()), ..Default::default() }).unwrap();
        db.save_page_blocks(&p.id, vec![block("第一版")]).unwrap();

        let conn = db.lock().unwrap();
        assert!(checkpoint(&conn, &p.id, "edit", AUTO_GAP_MINUTES).unwrap());
        assert!(!checkpoint(&conn, &p.id, "edit", 0).unwrap(), "内容没变不重复保存");
        drop(conn);

        db.save_page_blocks(&p.id, vec![block("第二版")]).unwrap();
        let conn = db.lock().unwrap();
        assert!(!checkpoint(&conn, &p.id, "edit", AUTO_GAP_MINUTES).unwrap(), "十分钟内不重复保存");
        let versions = list(&conn, &p.id).unwrap();
        assert_eq!(versions.len(), 1);
        let view = get(&conn, &versions[0].id).unwrap();
        assert_eq!(view.blocks[0].text, "第一版");

        let page_id = restore(&conn, &versions[0].id).unwrap();
        assert_eq!(page_id, p.id);
        assert_eq!(count(&conn, &p.id).unwrap(), 2, "恢复前的「第二版」也保存了");
        drop(conn);
        let detail = db.get_page_detail(&p.id).unwrap();
        assert_eq!(detail.blocks[0].plain_text, "第一版");
    }

    #[test]
    fn versions_are_capped_and_removed_with_the_page() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(CreatePageInput { title: Some("草稿".into()), ..Default::default() }).unwrap();
        for i in 0..(MAX_PER_PAGE + 5) {
            db.save_page_blocks(&p.id, vec![block(&format!("第 {} 版", i))]).unwrap();
            let conn = db.lock().unwrap();
            checkpoint(&conn, &p.id, "edit", 0).unwrap();
        }
        let conn = db.lock().unwrap();
        assert_eq!(count(&conn, &p.id).unwrap(), MAX_PER_PAGE);
        conn.execute("DELETE FROM pages WHERE id = ?1", params![p.id]).unwrap();
        assert_eq!(count(&conn, &p.id).unwrap(), 0);
    }
}
