//! 匿名装机与活跃设备统计（服务端）。
//!
//! - 一台机器一条记录（主键 `install_id` 为硬件单向加盐哈希，重装/升级/多打开便携版自动去重）；
//! - 与账号/邮箱体系彻底解耦，仅统计台数、平台架构、版本与发布渠道；
//! - 上报接口配合 `X-Xy-Sig` HMAC 强校验 + Nonce 防重放 + 单 IP 小时级新增上限，防止脚本刷量。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS installations (
        install_id TEXT PRIMARY KEY,
        os TEXT NOT NULL DEFAULT '',
        arch TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ping_days INTEGER NOT NULL DEFAULT 1,
        last_ip TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_installations_first_seen ON installations(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_installations_last_seen ON installations(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_installations_ip_first ON installations(last_ip, first_seen_at);
";

/// 同一出口 IP 每小时允许新增的不同装机上限（避免机房/NAT 正常办公室误杀，同时遏制刷库）。
pub const MAX_NEW_PER_IP_PER_HOUR: i64 = 30;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingInput {
    pub install_id: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub channel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountBucket {
    pub key: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSummary {
    pub total: i64,
    pub new_24h: i64,
    pub new_7d: i64,
    pub active_1d: i64,
    pub active_7d: i64,
    pub active_30d: i64,
    pub by_os: Vec<CountBucket>,
    pub by_version: Vec<CountBucket>,
    pub by_channel: Vec<CountBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRow {
    pub install_id_masked: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub channel: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub ping_days: i64,
}

#[derive(Debug)]
pub enum PingError {
    BadRequest(String),
    RateLimited(String),
    Internal(String),
}

fn clip_token(s: &str, max_chars: usize) -> String {
    s.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(max_chars)
        .collect()
}

fn valid_install_id(id: &str) -> bool {
    let t = id.trim();
    (16..=64).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit())
}

fn mask_id(id: &str) -> String {
    if id.len() <= 10 {
        return id.to_string();
    }
    format!("{}…{}", &id[..6], &id[id.len() - 4..])
}

pub fn record_ping(
    conn: &Connection,
    client_ip: &str,
    input: &PingInput,
) -> Result<(), PingError> {
    if !valid_install_id(&input.install_id) {
        return Err(PingError::BadRequest("installId 格式无效".into()));
    }
    let id = input.install_id.trim().to_ascii_lowercase();
    let os = clip_token(&input.os, 32).to_ascii_lowercase();
    let arch = clip_token(&input.arch, 32).to_ascii_lowercase();
    let app_version = clip_token(&input.app_version, 32);
    let channel = clip_token(&input.channel, 32).to_ascii_lowercase();
    let ip = clip_token(client_ip, 64);

    let now_dt = chrono::Utc::now();
    let now_iso = now_dt.to_rfc3339();
    let today_utc = now_dt.format("%Y-%m-%d").to_string();

    let existing_last: Option<String> = conn
        .query_row(
            "SELECT last_seen_at FROM installations WHERE install_id = ?1",
            params![&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| PingError::Internal(e.to_string()))?;

    if let Some(prev_last) = existing_last {
        let same_utc_day = prev_last.len() >= 10 && prev_last[..10] == today_utc;
        let inc = if same_utc_day { 0 } else { 1 };
        conn.execute(
            "UPDATE installations
             SET os = CASE WHEN ?2 <> '' THEN ?2 ELSE os END,
                 arch = CASE WHEN ?3 <> '' THEN ?3 ELSE arch END,
                 app_version = CASE WHEN ?4 <> '' THEN ?4 ELSE app_version END,
                 channel = CASE WHEN ?5 <> '' THEN ?5 ELSE channel END,
                 last_seen_at = ?6,
                 last_ip = ?7,
                 ping_days = ping_days + ?8
             WHERE install_id = ?1",
            params![&id, &os, &arch, &app_version, &channel, &now_iso, &ip, inc],
        )
        .map_err(|e| PingError::Internal(e.to_string()))?;
        return Ok(());
    }

    if !ip.is_empty() && ip != "unknown" {
        let hour_ago = (now_dt - chrono::Duration::hours(1)).to_rfc3339();
        let recent_new: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM installations WHERE last_ip = ?1 AND first_seen_at > ?2",
                params![&ip, &hour_ago],
                |r| r.get(0),
            )
            .map_err(|e| PingError::Internal(e.to_string()))?;
        if recent_new >= MAX_NEW_PER_IP_PER_HOUR {
            return Err(PingError::RateLimited("同 IP 新增设备过于频繁".into()));
        }
    }

    conn.execute(
        "INSERT INTO installations (install_id, os, arch, app_version, channel, first_seen_at, last_seen_at, ping_days, last_ip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7)",
        params![&id, &os, &arch, &app_version, &channel, &now_iso, &ip],
    )
    .map_err(|e| PingError::Internal(e.to_string()))?;

    Ok(())
}

fn query_buckets(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<CountBucket>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(CountBucket {
            key: r.get::<_, String>(0)?,
            count: r.get(1)?,
        })
    })?;
    rows.collect()
}

pub fn summary(conn: &Connection) -> rusqlite::Result<InstallSummary> {
    let now = chrono::Utc::now();
    let ago_1d = (now - chrono::Duration::days(1)).to_rfc3339();
    let ago_7d = (now - chrono::Duration::days(7)).to_rfc3339();
    let ago_30d = (now - chrono::Duration::days(30)).to_rfc3339();

    let one = |sql: &str, arg: Option<&str>| -> rusqlite::Result<i64> {
        match arg {
            Some(a) => conn.query_row(sql, params![a], |r| r.get(0)),
            None => conn.query_row(sql, [], |r| r.get(0)),
        }
    };

    Ok(InstallSummary {
        total: one("SELECT COUNT(*) FROM installations", None)?,
        new_24h: one("SELECT COUNT(*) FROM installations WHERE first_seen_at >= ?1", Some(&ago_1d))?,
        new_7d: one("SELECT COUNT(*) FROM installations WHERE first_seen_at >= ?1", Some(&ago_7d))?,
        active_1d: one("SELECT COUNT(*) FROM installations WHERE last_seen_at >= ?1", Some(&ago_1d))?,
        active_7d: one("SELECT COUNT(*) FROM installations WHERE last_seen_at >= ?1", Some(&ago_7d))?,
        active_30d: one("SELECT COUNT(*) FROM installations WHERE last_seen_at >= ?1", Some(&ago_30d))?,
        by_os: query_buckets(
            conn,
            "SELECT TRIM(CASE WHEN arch <> '' THEN os || ' (' || arch || ')' ELSE os END) AS k, COUNT(*) AS c
             FROM installations GROUP BY k ORDER BY c DESC, k ASC LIMIT 12",
        )?,
        by_version: query_buckets(
            conn,
            "SELECT CASE WHEN app_version <> '' THEN app_version ELSE '未知' END AS k, COUNT(*) AS c
             FROM installations GROUP BY k ORDER BY c DESC, k DESC LIMIT 15",
        )?,
        by_channel: query_buckets(
            conn,
            "SELECT CASE WHEN channel <> '' THEN channel ELSE '未知' END AS k, COUNT(*) AS c
             FROM installations GROUP BY k ORDER BY c DESC, k ASC LIMIT 10",
        )?,
    })
}

pub fn list_recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<InstallRow>> {
    let mut stmt = conn.prepare(
        "SELECT install_id, os, arch, app_version, channel, first_seen_at, last_seen_at, ping_days
         FROM installations ORDER BY last_seen_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit.clamp(1, 500)], |r| {
        let raw_id: String = r.get(0)?;
        Ok(InstallRow {
            install_id_masked: mask_id(&raw_id),
            os: r.get(1)?,
            arch: r.get(2)?,
            app_version: r.get(3)?,
            channel: r.get(4)?,
            first_seen_at: r.get(5)?,
            last_seen_at: r.get(6)?,
            ping_days: r.get(7)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    #[test]
    fn deduplicates_same_machine_and_aggregates_counts() {
        let conn = mem_conn();
        let m1 = PingInput {
            install_id: "0123456789abcdef0123456789abcdef".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            app_version: "0.8.2".into(),
            channel: "portable".into(),
        };
        let m1_upg = PingInput {
            app_version: "0.8.3".into(),
            ..m1.clone()
        };
        let m2 = PingInput {
            install_id: "fedcba9876543210fedcba9876543210".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            app_version: "0.8.3".into(),
            channel: "dmg".into(),
        };

        record_ping(&conn, "1.2.3.4", &m1).unwrap();
        record_ping(&conn, "1.2.3.4", &m1_upg).unwrap();
        record_ping(&conn, "5.6.7.8", &m2).unwrap();

        let s = summary(&conn).unwrap();
        assert_eq!(s.total, 2, "同一台机器升级前后仍只计 1 台");
        assert_eq!(s.new_24h, 2);
        assert_eq!(s.active_1d, 2);
        assert_eq!(s.by_version[0].key, "0.8.3");
        assert_eq!(s.by_version[0].count, 2);

        let recent = list_recent(&conn, 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent[0].install_id_masked.contains('…'));
    }

    #[test]
    fn rejects_bad_id_and_enforces_ip_rate_limit() {
        let conn = mem_conn();
        let bad = PingInput {
            install_id: "not-hex!".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            app_version: "0.8.3".into(),
            channel: "installed".into(),
        };
        assert!(matches!(record_ping(&conn, "9.9.9.9", &bad), Err(PingError::BadRequest(_))));

        for i in 0..MAX_NEW_PER_IP_PER_HOUR {
            let p = PingInput {
                install_id: format!("{:032x}", i + 1),
                os: "linux".into(),
                arch: "x86_64".into(),
                app_version: "0.8.3".into(),
                channel: "appimage".into(),
            };
            record_ping(&conn, "9.9.9.9", &p).unwrap();
        }
        let overflow = PingInput {
            install_id: format!("{:032x}", 9999),
            os: "linux".into(),
            arch: "x86_64".into(),
            app_version: "0.8.3".into(),
            channel: "appimage".into(),
        };
        assert!(matches!(record_ping(&conn, "9.9.9.9", &overflow), Err(PingError::RateLimited(_))));
    }
}
