//! 匿名装机与活跃设备统计（零感知、每台机器只计一台）。
//!
//! 原则：
//! 1. 不阻塞冷启动：后台线程延迟 8 秒后执行，3s 连接 / 5s 总超时；
//! 2. 极低频节流：仅在首次启动、UTC 跨天或升级新版本后各上报一次；
//! 3. 硬件去重隔离：复用系统级机器标识并以独立盐值单向 SHA-256，与账号/授权指纹彻底隔离；
//! 4. 最小字段集 + 可随时关闭：`telemetryEnabled = "false"` 即立即停用。

use crate::db::Database;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const K_TELEMETRY_ENABLED: &str = "telemetryEnabled";

fn k_install_fallback() -> String {
    crate::obf!("telemetry.installFallback")
}
fn k_last_ping_day() -> String {
    crate::obf!("telemetry.lastPingDay")
}
fn k_last_ping_version() -> String {
    crate::obf!("telemetry.lastPingVersion")
}
fn k_telemetry_salt() -> String {
    crate::obf!("xynote-install-v1:")
}
fn k_telemetry_endpoint() -> String {
    crate::obf!("/api/v1/telemetry/ping")
}

/// 生成单机唯一且不可反推原硬件号的 32 位匿名装机 ID（与授权 fingerprint 域隔离）。
pub fn install_id_conn(conn: &Connection) -> String {
    let raw = crate::license::os_machine_id().unwrap_or_else(|| {
        let fb_key = k_install_fallback();
        let saved: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![&fb_key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .filter(|v: &String| !v.is_empty());
        saved.unwrap_or_else(|| {
            let v = uuid::Uuid::new_v4().to_string();
            let _ = conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![&fb_key, &v],
            );
            v
        })
    });
    let salt = k_telemetry_salt();
    let digest = Sha256::digest(format!("{}{}", salt, raw).as_bytes());
    digest.iter().take(16).map(|b| format!("{:02x}", b)).collect()
}

/// 识别客户端分发形态，帮助评估便携版与安装版占比。
pub fn detect_channel() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let full = exe.to_string_lossy().to_ascii_lowercase();
            let is_installed_dir =
                full.contains("\\program files\\")
                    || full.contains("\\program files (x86)\\")
                    || full.contains("\\appdata\\local\\programs\\");
            if !is_installed_dir {
                if let Some(dir) = exe.parent() {
                    if dir.join("xynote-config.json").is_file() || dir.join("XyNote-data").is_dir() {
                        return "portable";
                    }
                }
            }
        }
        "installed"
    }
    #[cfg(target_os = "macos")]
    {
        if std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS"))
            .unwrap_or(false)
        {
            return "dmg";
        }
        "binary"
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "package"
        }
    }
}

pub fn should_ping_today(
    last_day: Option<&str>,
    last_ver: Option<&str>,
    today: &str,
    cur_ver: &str,
) -> bool {
    last_day.map(str::trim) != Some(today) || last_ver.map(str::trim) != Some(cur_ver)
}

pub fn is_enabled(db: &Database) -> bool {
    !matches!(
        db.get_setting_raw(K_TELEMETRY_ENABLED)
            .ok()
            .flatten()
            .as_deref()
            .map(str::trim),
        Some("false") | Some("disabled") | Some("0")
    )
}

/// 同步执行一次节流后的匿名装机/日活上报；成功记下当天日期与版本，失败静默忽略。
pub fn maybe_ping_blocking(db: &Database, base_url: &str) -> bool {
    if !is_enabled(db) {
        return false;
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let cur_ver = env!("CARGO_PKG_VERSION");

    let k_day = k_last_ping_day();
    let k_ver = k_last_ping_version();
    let last_day = db.get_setting_raw(&k_day).ok().flatten();
    let last_ver = db.get_setting_raw(&k_ver).ok().flatten();

    if !should_ping_today(last_day.as_deref(), last_ver.as_deref(), &today, cur_ver) {
        return false;
    }

    let install_id = {
        let Ok(conn) = db.lock() else {
            return false;
        };
        install_id_conn(&conn)
    };

    let body = serde_json::json!({
        "installId": install_id,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "appVersion": cur_ver,
        "channel": detect_channel(),
    })
    .to_string();

    let url = format!("{}{}", base_url.trim_end_matches('/'), k_telemetry_endpoint());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build();

    let res = crate::security::send_signed_ureq(
        &agent,
        "POST",
        &url,
        None,
        Some("application/json"),
        Some(body.as_bytes()),
    );
    if matches!(res, Ok(r) if (200..300).contains(&r.status())) {
        let _ = db.set_setting(&k_day, &today);
        let _ = db.set_setting(&k_ver, cur_ver);
        return true;
    }
    false
}

/// 启动后在后台线程延迟执行，绝对不拖慢冷启动或打扰离线体验。
#[cfg(not(test))]
pub fn spawn_background_ping(app: tauri::AppHandle) {
    use tauri::Manager;
    let _ = std::thread::Builder::new()
        .name("xy-telemetry".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(8));
            let db = app.state::<Database>();
            let _ = maybe_ping_blocking(&db, crate::sync_config::official_server_url());
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_id_is_deterministic_and_isolated_from_license_machine_id() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.lock().unwrap();
        let id1 = install_id_conn(&conn);
        let id2 = install_id_conn(&conn);
        let lic_id = crate::license::machine_id_conn(&conn);
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 32);
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id1, lic_id, "装机 ID 必须与授权指纹域隔离");
    }

    #[test]
    fn throttle_only_pings_once_per_day_or_on_version_upgrade() {
        assert!(should_ping_today(None, None, "2026-11-19", "0.8.3"));
        assert!(!should_ping_today(Some("2026-11-19"), Some("0.8.3"), "2026-11-19", "0.8.3"));
        assert!(should_ping_today(Some("2026-11-18"), Some("0.8.3"), "2026-11-19", "0.8.3"));
        assert!(should_ping_today(Some("2026-11-19"), Some("0.8.2"), "2026-11-19", "0.8.3"));
    }

    #[test]
    fn opt_out_setting_skips_ping_completely() {
        let db = Database::open_in_memory().unwrap();
        assert!(is_enabled(&db));
        db.set_setting(K_TELEMETRY_ENABLED, "false").unwrap();
        assert!(!is_enabled(&db));
        assert!(!maybe_ping_blocking(&db, "http://127.0.0.1:1"));
    }
}
