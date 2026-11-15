//! 意见反馈：软件「偏好设置 → 意见反馈」和用户中心提交，管理后台查看、回复、标记处理。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NULL REFERENCES users(id),
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        client_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_client ON feedback(client_key, created_at);
";

/// 同一来源（账号或 IP）一小时内最多提交的条数
pub const MAX_PER_HOUR: i64 = 10;
pub const MAX_LEN: usize = 5000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    #[serde(default)]
    pub category: String,
    pub content: String,
    #[serde(default)]
    pub contact: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub os: String,
    /// app / web
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub contact: String,
    pub app_version: String,
    pub os: String,
    pub source: String,
    /// new 待处理 / done 已处理
    pub status: String,
    pub reply: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_email: Option<String>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(n).collect()
}

pub fn category_label(c: &str) -> &'static str {
    match c {
        "bug" => "问题",
        "idea" => "建议",
        _ => "其他",
    }
}

pub fn submit(conn: &Connection, user_id: Option<i64>, client_key: &str, f: &FeedbackInput) -> Result<i64, String> {
    let content = clip(&f.content, MAX_LEN);
    if content.chars().count() < 4 {
        return Err("请多写几个字，描述一下你的问题或建议".into());
    }
    let hour_ago = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    let recent: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM feedback WHERE client_key = ?1 AND created_at > ?2",
            params![client_key, hour_ago],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if recent >= MAX_PER_HOUR {
        return Err("提交得太频繁了，请稍后再试".into());
    }
    let category = match f.category.as_str() {
        "bug" | "idea" => f.category.clone(),
        _ => "other".into(),
    };
    let at = now();
    conn.execute(
        "INSERT INTO feedback (user_id, category, content, contact, app_version, os, source, client_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            user_id,
            category,
            content,
            clip(&f.contact, 120),
            clip(&f.app_version, 30),
            clip(&f.os, 40),
            clip(&f.source, 10),
            client_key,
            at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

const COLS: &str = "f.id, f.category, f.content, f.contact, f.app_version, f.os, f.source, f.status, f.reply, f.created_at, f.updated_at, COALESCE(u.display_name, u.email), u.contact_email";

fn from_row(r: &rusqlite::Row<'_>, with_account: bool) -> rusqlite::Result<Feedback> {
    Ok(Feedback {
        id: r.get(0)?,
        category: r.get(1)?,
        content: r.get(2)?,
        contact: r.get(3)?,
        app_version: r.get(4)?,
        os: r.get(5)?,
        source: r.get(6)?,
        status: r.get(7)?,
        reply: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        account: if with_account { r.get(11)? } else { None },
        account_email: if with_account { r.get(12)? } else { None },
    })
}

pub fn list_mine(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<Feedback>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.user_id = ?1 ORDER BY f.created_at DESC LIMIT 50",
        COLS
    ))?;
    let rows = stmt.query_map(params![user_id], |r| from_row(r, false))?.collect();
    rows
}

pub fn list_admin(conn: &Connection, status: Option<&str>) -> rusqlite::Result<Vec<Feedback>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE (?1 IS NULL OR f.status = ?1) ORDER BY f.created_at DESC LIMIT 300",
        COLS
    ))?;
    let rows = stmt.query_map(params![status], |r| from_row(r, true))?.collect();
    rows
}

pub fn update(conn: &Connection, id: i64, status: Option<&str>, reply: Option<&str>) -> Result<Feedback, String> {
    if let Some(s) = status {
        if s != "new" && s != "done" {
            return Err("status 只能是 new 或 done".into());
        }
    }
    let n = conn
        .execute(
            "UPDATE feedback SET status = COALESCE(?1, status), reply = COALESCE(?2, reply), updated_at = ?3 WHERE id = ?4",
            params![status, reply.map(|r| clip(r, MAX_LEN)), now(), id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("反馈不存在".into());
    }
    conn.query_row(
        &format!("SELECT {} FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ?1", COLS),
        params![id],
        |r| from_row(r, true),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "反馈不存在".into())
}

pub fn count_new(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM feedback WHERE status = 'new'", [], |r| r.get(0)).unwrap_or(0)
}
