//! 永久版授权：本地离线校验，结果保存在 app_settings 的 `license.key`。

use crate::db::Database;
use crate::models::AppError;
use crate::license_format::{parse_hex32, verify, LicensePayload};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const K_LICENSE: &str = "license.key";

/// 发码工具 `xynote-license keygen` 生成的公钥（十六进制），可在构建时用环境变量覆盖
pub fn public_key() -> Option<[u8; 32]> {
    let raw = option_env!("XYNOTE_LICENSE_PUBKEY").unwrap_or(include_str!("../license_pubkey.txt"));
    raw.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).and_then(parse_hex32)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub active: bool,
    pub name: Option<String>,
    pub id: Option<String>,
    pub issued_at: Option<String>,
    /// 这个构建是否配置了授权公钥（未配置时无法激活）
    pub configured: bool,
    pub purchase_url: String,
}

fn status_from(payload: Option<LicensePayload>) -> LicenseStatus {
    LicenseStatus {
        active: payload.is_some(),
        name: payload.as_ref().map(|p| p.name.clone()),
        id: payload.as_ref().map(|p| p.id.clone()),
        issued_at: payload.map(|p| p.issued_at),
        configured: public_key().is_some(),
        purchase_url: crate::sync_config::official_pricing_url().to_string(),
    }
}

fn stored_payload(conn: &Connection) -> Option<LicensePayload> {
    let key = public_key()?;
    let lic: String = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![K_LICENSE], |r| r.get(0))
        .optional()
        .ok()
        .flatten()?;
    verify(&lic, &key).ok()
}

/// 每次都重新校验签名，手改数据库无效
pub fn is_pro_conn(conn: &Connection) -> bool {
    stored_payload(conn).is_some()
}

pub fn is_pro(db: &Database) -> bool {
    db.lock().map(|c| is_pro_conn(&c)).unwrap_or(false)
}

pub fn status(db: &Database) -> Result<LicenseStatus, AppError> {
    let conn = db.lock()?;
    Ok(status_from(stored_payload(&conn)))
}

pub fn activate(db: &Database, license: &str) -> Result<LicenseStatus, AppError> {
    let key = public_key().ok_or_else(|| AppError::Validation("此版本未配置授权公钥，请从官网下载正式版".into()))?;
    let payload = verify(license, &key).map_err(AppError::Validation)?;
    let compact: String = license.chars().filter(|c| !c.is_whitespace()).collect();
    db.set_setting(K_LICENSE, &compact)?;
    Ok(status_from(Some(payload)))
}

pub fn deactivate(db: &Database) -> Result<LicenseStatus, AppError> {
    db.delete_setting(K_LICENSE)?;
    Ok(status_from(None))
}
