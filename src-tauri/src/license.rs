//! 永久版授权。
//!
//! - 用 FWPT 通行证登录：第一次登录赠送一年永久版权限。
//! - 购买后输入激活码 `XYP-…` 激活，一个激活码最多 3 台电脑。
//! - 登录 / 激活时把本机信息（机器指纹、名称、系统、版本）发给服务器，用于核对和统计。
//! - 服务器返回签名授权令牌，保存在 app_settings 的 `license.key`；使用时离线校验签名、本机指纹和到期时间。
//!   发码工具签发的离线授权（不绑定机器）仍可直接粘贴激活。

use crate::db::Database;
use crate::license_format::{parse_hex32, verify, LicensePayload};
use crate::models::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::Duration;

pub const K_LICENSE: &str = "license.key";
const K_ACCOUNT: &str = "license.account";
const K_LAST_INFO: &str = "license.lastInfo";
const K_MACHINE_FALLBACK: &str = "license.machineFallback";
/// 通行证令牌（以 sync.secret. 开头，不会出现在设置导出里）
const S_ACCOUNT_TOKEN: &str = "sync.secret.licenseToken";

/// 发码工具 `xynote-license keygen` 生成的公钥（十六进制），可在构建时用环境变量覆盖
pub fn public_key() -> Option<[u8; 32]> {
    let raw = option_env!("XYNOTE_LICENSE_PUBKEY").unwrap_or(include_str!("../license_pubkey.txt"));
    raw.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).and_then(parse_hex32)
}

/* ---------------- 本机信息 ---------------- */

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不闪黑框
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 操作系统提供的机器标识（重装软件不变）
fn os_machine_id() -> Option<String> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| {
        #[cfg(target_os = "windows")]
        let raw = command_output("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
            .and_then(|o| o.lines().find(|l| l.contains("MachineGuid")).and_then(|l| l.split_whitespace().last().map(str::to_string)));
        #[cfg(target_os = "macos")]
        let raw = command_output("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"]).and_then(|o| {
            o.lines()
                .find(|l| l.contains("IOPlatformUUID"))
                .and_then(|l| l.rsplit('"').nth(1).map(str::to_string))
        });
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let raw = ["/etc/machine-id", "/var/lib/dbus/machine-id"].iter().find_map(|p| std::fs::read_to_string(p).ok());
        raw.map(|s| s.trim().to_lowercase()).filter(|s| s.len() >= 8)
    })
    .clone()
}

/// 机器指纹：系统标识的哈希（不上传原始标识）；取不到时用本机保存的随机值
pub fn machine_id_conn(conn: &Connection) -> String {
    let raw = os_machine_id().unwrap_or_else(|| {
        let saved: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", params![K_MACHINE_FALLBACK], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        saved.unwrap_or_else(|| {
            let v = uuid::Uuid::new_v4().to_string();
            let _ = conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![K_MACHINE_FALLBACK, v],
            );
            v
        })
    });
    let digest = Sha256::digest(format!("xynote-machine-v1:{}", raw).as_bytes());
    digest.iter().take(16).map(|b| format!("{:02x}", b)).collect()
}

pub fn machine_name() -> String {
    let from_env = |k: &str| std::env::var(k).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    from_env("COMPUTERNAME")
        .or_else(|| from_env("HOSTNAME"))
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .or_else(|| command_output("hostname", &[]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "我的电脑".into())
}

fn device_json(conn: &Connection) -> Value {
    serde_json::json!({
        "machineId": machine_id_conn(conn),
        "machineName": machine_name(),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "appVersion": env!("CARGO_PKG_VERSION"),
    })
}

/* ---------------- 本地校验 ---------------- */

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .filter(|v: &String| !v.is_empty())
}

fn expired(p: &LicensePayload) -> bool {
    p.expires_at
        .as_deref()
        .map(|t| chrono::DateTime::parse_from_rfc3339(t).map(|t| t <= chrono::Utc::now()).unwrap_or(true))
        .unwrap_or(false)
}

/// 签名有效、属于本机（若绑定）的授权；`include_expired` 为 false 时排除已到期的
fn stored_payload(conn: &Connection, include_expired: bool) -> Option<LicensePayload> {
    let key = public_key()?;
    let p = verify(&setting(conn, K_LICENSE)?, &key).ok()?;
    if let Some(m) = &p.machine {
        if *m != machine_id_conn(conn) {
            return None;
        }
    }
    (include_expired || !expired(&p)).then_some(p)
}

/// 每次都重新校验签名、本机和到期时间，手改数据库无效
pub fn is_pro_conn(conn: &Connection) -> bool {
    stored_payload(conn, false).is_some()
}

pub fn is_pro(db: &Database) -> bool {
    db.lock().map(|c| is_pro_conn(&c)).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// 当前可以使用付费功能
    pub active: bool,
    /// lifetime 永久版 / trial 注册赠送 / null
    pub edition: Option<String>,
    pub name: Option<String>,
    pub id: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    /// 有授权但已到期（免费期结束）
    pub expired: bool,
    /// 这个构建是否配置了授权公钥（未配置时无法激活）
    pub configured: bool,
    pub purchase_url: String,
    pub logged_in: bool,
    pub account: Option<String>,
    pub machine_name: String,
    /// 服务器最近一次返回的激活码与设备占用
    pub code: Option<String>,
    pub devices_used: Option<i64>,
    pub max_devices: Option<i64>,
    pub trial_until: Option<String>,
}

fn status_conn(conn: &Connection) -> LicenseStatus {
    let current = stored_payload(conn, true);
    let info: Value = setting(conn, K_LAST_INFO).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let text = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_string);
    let num = |k: &str| info.get(k).and_then(Value::as_i64);
    let is_expired = current.as_ref().map(expired).unwrap_or(false);
    LicenseStatus {
        active: current.is_some() && !is_expired,
        edition: current.as_ref().map(|p| p.edition.clone()),
        name: current.as_ref().map(|p| p.name.clone()),
        id: current.as_ref().map(|p| p.id.clone()),
        issued_at: current.as_ref().map(|p| p.issued_at.clone()),
        expires_at: current.as_ref().and_then(|p| p.expires_at.clone()),
        expired: is_expired,
        configured: public_key().is_some(),
        purchase_url: crate::sync_config::official_pricing_url().to_string(),
        logged_in: setting(conn, S_ACCOUNT_TOKEN).is_some(),
        account: setting(conn, K_ACCOUNT),
        machine_name: machine_name(),
        code: text("code"),
        devices_used: num("devicesUsed"),
        max_devices: num("maxDevices"),
        trial_until: text("trialUntil"),
    }
}

pub fn status(db: &Database) -> Result<LicenseStatus, AppError> {
    let conn = db.lock()?;
    Ok(status_conn(&conn))
}

/* ---------------- 与授权服务器通信 ---------------- */

enum CallError {
    Unauthorized,
    Other(String),
}

fn call(path: &str, token: Option<&str>, body: Option<Value>) -> Result<Value, CallError> {
    let base = crate::sync_config::official_server_url().trim_end_matches('/');
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(20)).build();
    let url = format!("{}{}", base, path);
    let mut req = match body {
        Some(_) => agent.post(&url).set("Content-Type", "application/json"),
        None => agent.get(&url),
    };
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {}", t));
    }
    let res = match body {
        Some(b) => req.send_string(&b.to_string()),
        None => req.call(),
    };
    let parse = |r: ureq::Response| -> Value { r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null) };
    match res {
        Ok(r) => Ok(parse(r)),
        Err(ureq::Error::Status(401, _)) => Err(CallError::Unauthorized),
        Err(ureq::Error::Status(code, r)) => {
            let v = parse(r);
            Err(CallError::Other(
                v.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("授权服务返回错误 {}", code)),
            ))
        }
        Err(_) => Err(CallError::Other("无法连接授权服务，请检查网络后重试".into())),
    }
}

fn set(db: &Database, key: &str, value: &str) -> Result<(), AppError> {
    db.set_setting(key, value)
}

fn account_token(db: &Database) -> Result<Option<String>, AppError> {
    let conn = db.lock()?;
    Ok(setting(&conn, S_ACCOUNT_TOKEN))
}

/// 向服务器激活（code 为空表示按账号恢复：已激活的本机、名下激活码空位或一年免费期）
fn activate_online(db: &Database, token: &str, code: Option<&str>) -> Result<LicenseStatus, AppError> {
    let mut body = {
        let conn = db.lock()?;
        device_json(&conn)
    };
    if let Some(c) = code {
        body["code"] = Value::String(c.trim().to_string());
    }
    match call("/api/v1/license/activate", Some(token), Some(body)) {
        Ok(v) => {
            let lic = v.get("token").and_then(Value::as_str).ok_or_else(|| AppError::Validation("授权服务返回的数据无法识别".into()))?;
            let key = public_key().ok_or_else(|| AppError::Validation("此版本未配置授权公钥，请从官网下载正式版".into()))?;
            verify(lic, &key).map_err(AppError::Validation)?;
            set(db, K_LICENSE, lic)?;
            if let Some(info) = v.get("entitlement") {
                set(db, K_LAST_INFO, &info.to_string())?;
            }
            if let Some(a) = v.get("account").and_then(Value::as_str) {
                set(db, K_ACCOUNT, a)?;
            }
            status(db)
        }
        Err(CallError::Unauthorized) => {
            db.delete_setting(S_ACCOUNT_TOKEN)?;
            Err(AppError::Validation("登录已过期，请重新登录通行证".into()))
        }
        Err(CallError::Other(m)) => Err(AppError::Validation(m)),
    }
}

/// 用 FWPT 通行证登录；第一次登录会获得一年永久版权限
pub fn login(db: &Database, account: &str, password: &str) -> Result<LicenseStatus, AppError> {
    if account.trim().is_empty() || password.is_empty() {
        return Err(AppError::Validation("请输入通行证账号和密码".into()));
    }
    let res = crate::sync_remote::server_auth(crate::sync_config::official_server_url(), "login", account, password)?;
    set(db, S_ACCOUNT_TOKEN, &res.token)?;
    set(db, K_ACCOUNT, &res.account.email)?;
    match activate_online(db, &res.token, None) {
        Ok(s) => Ok(s),
        // 免费期已结束等情况：登录本身成功，提示交给界面
        Err(AppError::Validation(m)) if !m.contains("登录已过期") => {
            let mut s = status(db)?;
            s.logged_in = true;
            set(db, K_LAST_INFO, &serde_json::json!({ "notice": m }).to_string())?;
            Ok(s)
        }
        Err(e) => Err(e),
    }
}

/// 启动时调用：已登录则向服务器报到并刷新授权；离线时保留本地授权
pub fn refresh(db: &Database) -> Result<LicenseStatus, AppError> {
    match account_token(db)? {
        Some(token) => activate_online(db, &token, None),
        None => status(db),
    }
}

/// 输入激活码；`XYNOTE1.` 开头的离线授权直接校验，其余向服务器激活（需要先登录）
pub fn activate(db: &Database, input: &str) -> Result<LicenseStatus, AppError> {
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(AppError::Validation("请输入激活码".into()));
    }
    if compact.starts_with(crate::license_format::PREFIX) {
        let key = public_key().ok_or_else(|| AppError::Validation("此版本未配置授权公钥，请从官网下载正式版".into()))?;
        let p = verify(&compact, &key).map_err(AppError::Validation)?;
        if expired(&p) {
            return Err(AppError::Validation("这个授权已到期".into()));
        }
        set(db, K_LICENSE, &compact)?;
        return status(db);
    }
    let token = account_token(db)?.ok_or_else(|| AppError::Validation("请先登录 FWPT 通行证，激活码会绑定到你的账号".into()))?;
    activate_online(db, &token, Some(&compact))
}

/// 在本机停用：释放激活码的一个位置，换电脑时使用
pub fn deactivate(db: &Database) -> Result<LicenseStatus, AppError> {
    if let Some(token) = account_token(db)? {
        let machine = {
            let conn = db.lock()?;
            machine_id_conn(&conn)
        };
        match call("/api/v1/license/deactivate", Some(&token), Some(serde_json::json!({ "machineId": machine }))) {
            Ok(_) | Err(CallError::Unauthorized) => {}
            Err(CallError::Other(m)) => return Err(AppError::Validation(m)),
        }
    }
    db.delete_setting(K_LICENSE)?;
    db.delete_setting(K_LAST_INFO)?;
    status(db)
}

/// 退出通行证；本机已有的授权保留到期
pub fn logout(db: &Database) -> Result<LicenseStatus, AppError> {
    db.delete_setting(S_ACCOUNT_TOKEN)?;
    db.delete_setting(K_ACCOUNT)?;
    status(db)
}

/// 在软件里创建购买订单（显示付款码和订单信息）
pub fn create_order(db: &Database) -> Result<Value, AppError> {
    let token = account_token(db)?.ok_or_else(|| AppError::Validation("请先登录 FWPT 通行证".into()))?;
    match call("/api/v1/store/orders", Some(&token), Some(serde_json::json!({ "product": "lifetime" }))) {
        Ok(v) => Ok(v),
        Err(CallError::Unauthorized) => {
            db.delete_setting(S_ACCOUNT_TOKEN)?;
            Err(AppError::Validation("登录已过期，请重新登录通行证".into()))
        }
        Err(CallError::Other(m)) => Err(AppError::Validation(m)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license_format::sign;
    use ed25519_dalek::SigningKey;

    #[test]
    fn machine_id_is_stable_and_safe() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.lock().unwrap();
        let a = machine_id_conn(&conn);
        assert_eq!(a, machine_id_conn(&conn));
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!machine_name().is_empty());
    }

    #[test]
    fn payload_rules_for_machine_and_expiry() {
        let key = SigningKey::from_bytes(&[3u8; 32]);
        let pubkey = key.verifying_key().to_bytes();
        let base = LicensePayload {
            v: 1,
            id: "XYP-TEST".into(),
            name: "测试".into(),
            edition: "trial".into(),
            issued_at: chrono::Utc::now().to_rfc3339(),
            expires_at: Some((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339()),
            machine: Some("m1".into()),
        };
        let p = verify(&sign(&base, &key), &pubkey).unwrap();
        assert!(!expired(&p));
        let mut old = base.clone();
        old.expires_at = Some((chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339());
        assert!(expired(&verify(&sign(&old, &key), &pubkey).unwrap()));
        let mut lifetime = base;
        lifetime.expires_at = None;
        assert!(!expired(&lifetime));
    }
}
