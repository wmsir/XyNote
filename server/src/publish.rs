//! 发布为网页（只读分享链接）和手机随手记收件箱。

use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS published_pages (
        slug TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_published_user ON published_pages(user_id, updated_at);
    CREATE TABLE IF NOT EXISTS inbox_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox_items(user_id, id);
";

pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PAGES_PER_USER: i64 = 300;
pub const MAX_INBOX_TEXT: usize = 20_000;
pub const MAX_INBOX_ITEMS: i64 = 2_000;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn page_path(data_dir: &Path, slug: &str) -> PathBuf {
    data_dir.join("published").join(format!("{}.html", slug))
}

/// 只允许 8~40 位字母数字和短横线
pub fn valid_slug(s: &str) -> bool {
    (8..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn new_slug() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPage {
    pub slug: String,
    pub title: String,
    pub size: i64,
    pub updated_at: String,
}

#[derive(Debug)]
pub enum PublishError {
    TooLarge,
    TooMany,
    NotOwner,
    Io(String),
}

/// 发布或更新一个页面；slug 为空时新建，返回 slug
pub fn publish(
    conn: &Connection,
    data_dir: &Path,
    user_id: i64,
    slug: Option<&str>,
    title: &str,
    html: &str,
) -> Result<String, PublishError> {
    if html.len() > MAX_PAGE_BYTES {
        return Err(PublishError::TooLarge);
    }
    let title: String = title.trim().chars().take(200).collect();
    let existing_owner = |s: &str| -> Option<i64> {
        conn.query_row("SELECT user_id FROM published_pages WHERE slug = ?1", params![s], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    };
    let slug = match slug.filter(|s| valid_slug(s)) {
        Some(s) => {
            match existing_owner(s) {
                Some(owner) if owner != user_id => return Err(PublishError::NotOwner),
                Some(_) => s.to_string(),
                None => s.to_string(),
            }
        }
        None => {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM published_pages WHERE user_id = ?1", params![user_id], |r| r.get(0))
                .unwrap_or(0);
            if count >= MAX_PAGES_PER_USER {
                return Err(PublishError::TooMany);
            }
            let mut s = new_slug();
            while existing_owner(&s).is_some() {
                s = new_slug();
            }
            s
        }
    };
    let path = page_path(data_dir, &slug);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| PublishError::Io(e.to_string()))?;
    }
    std::fs::write(&path, html.as_bytes()).map_err(|e| PublishError::Io(e.to_string()))?;
    let ts = now();
    conn.execute(
        "INSERT INTO published_pages (slug, user_id, title, size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(slug) DO UPDATE SET title = excluded.title, size = excluded.size, updated_at = excluded.updated_at",
        params![slug, user_id, title, html.len() as i64, ts],
    )
    .map_err(|e| PublishError::Io(e.to_string()))?;
    Ok(slug)
}

pub fn unpublish(conn: &Connection, data_dir: &Path, user_id: i64, slug: &str) -> bool {
    let n = conn
        .execute("DELETE FROM published_pages WHERE slug = ?1 AND user_id = ?2", params![slug, user_id])
        .unwrap_or(0);
    if n > 0 {
        let _ = std::fs::remove_file(page_path(data_dir, slug));
    }
    n > 0
}

pub fn list(conn: &Connection, user_id: i64) -> Vec<PublishedPage> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT slug, title, size, updated_at FROM published_pages WHERE user_id = ?1 ORDER BY updated_at DESC",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![user_id], |r| {
        Ok(PublishedPage { slug: r.get(0)?, title: r.get(1)?, size: r.get(2)?, updated_at: r.get(3)? })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// 公开访问：读出已发布的页面
pub fn load(conn: &Connection, data_dir: &Path, slug: &str) -> Option<String> {
    if !valid_slug(slug) {
        return None;
    }
    let exists: Option<String> = conn
        .query_row("SELECT slug FROM published_pages WHERE slug = ?1", params![slug], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    exists?;
    std::fs::read_to_string(page_path(data_dir, slug)).ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: i64,
    pub text: String,
    pub created_at: String,
}

pub fn inbox_add(conn: &Connection, user_id: i64, text: &str) -> Result<i64, &'static str> {
    let t = text.trim();
    if t.is_empty() {
        return Err("内容是空的");
    }
    if t.len() > MAX_INBOX_TEXT {
        return Err("一次最多 2 万字");
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM inbox_items WHERE user_id = ?1", params![user_id], |r| r.get(0))
        .unwrap_or(0);
    if count >= MAX_INBOX_ITEMS {
        return Err("收件箱已满，请先在电脑上同步一次");
    }
    conn.execute(
        "INSERT INTO inbox_items (user_id, text, created_at) VALUES (?1, ?2, ?3)",
        params![user_id, t, now()],
    )
    .map_err(|_| "保存失败")?;
    Ok(conn.last_insert_rowid())
}

pub fn inbox_list(conn: &Connection, user_id: i64) -> Vec<InboxItem> {
    let Ok(mut stmt) = conn.prepare("SELECT id, text, created_at FROM inbox_items WHERE user_id = ?1 ORDER BY id LIMIT 500") else {
        return Vec::new();
    };
    stmt.query_map(params![user_id], |r| Ok(InboxItem { id: r.get(0)?, text: r.get(1)?, created_at: r.get(2)? }))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

pub fn inbox_delete(conn: &Connection, user_id: i64, id: i64) -> bool {
    conn.execute("DELETE FROM inbox_items WHERE id = ?1 AND user_id = ?2", params![id, user_id])
        .map(|n| n > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Connection, PathBuf) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2);")
            .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        let dir = std::env::temp_dir().join(format!("xy-pub-{}", rand::random::<u64>()));
        (conn, dir)
    }

    #[test]
    fn publish_update_and_owner_check() {
        let (conn, dir) = db();
        let slug = publish(&conn, &dir, 1, None, "周报", "<p>v1</p>").unwrap();
        assert!(valid_slug(&slug));
        assert_eq!(load(&conn, &dir, &slug).unwrap(), "<p>v1</p>");
        // 同一个人更新
        assert_eq!(publish(&conn, &dir, 1, Some(&slug), "周报", "<p>v2</p>").unwrap(), slug);
        assert_eq!(load(&conn, &dir, &slug).unwrap(), "<p>v2</p>");
        // 别人不能覆盖
        assert!(matches!(publish(&conn, &dir, 2, Some(&slug), "x", "<p>x</p>"), Err(PublishError::NotOwner)));
        assert_eq!(list(&conn, 1).len(), 1);
        assert!(!unpublish(&conn, &dir, 2, &slug));
        assert!(unpublish(&conn, &dir, 1, &slug));
        assert!(load(&conn, &dir, &slug).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_slugs_and_large_pages() {
        let (conn, dir) = db();
        assert!(load(&conn, &dir, "../../etc/passwd").is_none());
        assert!(!valid_slug("short"));
        let big = "x".repeat(MAX_PAGE_BYTES + 1);
        assert!(matches!(publish(&conn, &dir, 1, None, "t", &big), Err(PublishError::TooLarge)));
    }

    #[test]
    fn inbox_roundtrip_is_per_user() {
        let (conn, _) = db();
        let id = inbox_add(&conn, 1, "  买牛奶 ").unwrap();
        assert!(inbox_add(&conn, 1, "   ").is_err());
        assert_eq!(inbox_list(&conn, 1)[0].text, "买牛奶");
        assert!(inbox_list(&conn, 2).is_empty());
        assert!(!inbox_delete(&conn, 2, id));
        assert!(inbox_delete(&conn, 1, id));
        assert!(inbox_list(&conn, 1).is_empty());
    }
}
