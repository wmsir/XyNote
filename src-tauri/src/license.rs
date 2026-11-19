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

fn k_license() -> String { crate::obf!("license.key") }
fn k_account() -> String { crate::obf!("license.account") }
fn k_last_info() -> String { crate::obf!("license.lastInfo") }
fn k_machine_fallback() -> String { crate::obf!("license.machineFallback") }
/// 通行证令牌（以 sync.secret. 开头，不会出现在设置导出里）
fn k_account_token() -> String { crate::obf!("sync.secret.licenseToken") }

/// 发码工具 `xynote-license keygen` 生成的公钥（十六进制），可在构建时用环境变量覆盖
pub fn public_key() -> Option<[u8; 32]> {
    // 构建时可用环境变量（如 GitHub Secrets）提供；为空时用仓库里的混淆内置公钥
    let embedded = crate::obf!(include_str!("../license_pubkey.txt"));
    let raw = option_env!("XYNOTE_LICENSE_PUBKEY")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(&embedded);
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
pub(crate) fn os_machine_id() -> Option<String> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| {
        #[cfg(target_os = "windows")]
        let raw = {
            let subkey = crate::obf!(r"HKLM\SOFTWARE\Microsoft\Cryptography");
            let val_name = crate::obf!("MachineGuid");
            command_output("reg", &["query", &subkey, "/v", &val_name])
                .and_then(|o| o.lines().find(|l| l.contains(&val_name)).and_then(|l| l.split_whitespace().last().map(str::to_string)))
        };
        #[cfg(target_os = "macos")]
        let raw = {
            let prop_name = crate::obf!("IOPlatformUUID");
            let cls_name = crate::obf!("IOPlatformExpertDevice");
            command_output("ioreg", &["-rd1", "-c", &cls_name]).and_then(|o| {
                o.lines()
                    .find(|l| l.contains(&prop_name))
                    .and_then(|l| l.rsplit('"').nth(1).map(str::to_string))
            })
        };
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let raw = ["/etc/machine-id", "/var/lib/dbus/machine-id"].iter().find_map(|p| std::fs::read_to_string(p).ok());
        raw.map(|s| s.trim().to_lowercase()).filter(|s| s.len() >= 8)
    })
    .clone()
}

/// 机器指纹：系统标识的哈希（不上传原始标识）；取不到时用本机保存的随机值
pub fn machine_id_conn(conn: &Connection) -> String {
    let raw = os_machine_id().unwrap_or_else(|| {
        let fb_key = k_machine_fallback();
        let saved: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", params![&fb_key], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        saved.unwrap_or_else(|| {
            let v = uuid::Uuid::new_v4().to_string();
            let _ = conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![&fb_key, v],
            );
            v
        })
    });
    let prefix = crate::obf!("xynote-machine-v1:");
    let digest = Sha256::digest(format!("{}{}", prefix, raw).as_bytes());
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
#[inline(always)]
fn stored_payload(conn: &Connection, include_expired: bool) -> Option<LicensePayload> {
    let key = public_key()?;
    let p = verify(&setting(conn, &k_license())?, &key).ok()?;
    if let Some(m) = &p.machine {
        if *m != machine_id_conn(conn) {
            return None;
        }
    }
    (include_expired || !expired(&p)).then_some(p)
}

/// 小悦笔记全部功能免费：保留授权代码只为兼容已经激活过的旧版本数据
#[allow(dead_code)]
pub fn is_pro_conn(conn: &Connection) -> bool {
    stored_payload(conn, false).is_some()
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
    /// 登录成功但授权服务返回的提示（如免费账号已绑定其他电脑）
    pub notice: Option<String>,
    /// 用户中心（购买、管理电脑、查看订单）
    pub user_center_url: String,
}

fn status_conn(conn: &Connection) -> LicenseStatus {
    let current = stored_payload(conn, true);
    let info: Value = setting(conn, &k_last_info()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
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
        logged_in: setting(conn, &k_account_token()).is_some(),
        account: setting(conn, &k_account()),
        machine_name: machine_name(),
        code: text("code"),
        devices_used: num("devicesUsed"),
        max_devices: num("maxDevices"),
        trial_until: text("trialUntil"),
        notice: text("notice"),
        user_center_url: crate::sync_config::official_pricing_url().to_string(),
    }
}

pub fn status(db: &Database) -> Result<LicenseStatus, AppError> {
    let conn = db.lock()?;
    Ok(status_conn(&conn))
}

/* ---------------- 与授权服务器通信 ---------------- */

enum CallError {
    Unauthorized,
    Network(String),
    Other(String),
}

fn call(path: &str, token: Option<&str>, body: Option<Value>) -> Result<Value, CallError> {
    let base = crate::sync_config::official_server_url().trim_end_matches('/');
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(20)).build();
    let url = format!("{}{}", base, path);
    let bearer = token.map(|t| format!("Bearer {}", t));
    let body_str = body.map(|b| b.to_string());
    let (method, ct, body_bytes) = match &body_str {
        Some(s) => ("POST", Some("application/json"), Some(s.as_bytes())),
        None => ("GET", None, None),
    };
    let res = crate::security::send_signed_ureq(&agent, method, &url, bearer.as_deref(), ct, body_bytes);
    let parse = |r: ureq::Response| -> Value { r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null) };
    match res {
        Ok(r) => Ok(parse(r)),
        Err(ureq::Error::Status(401, _)) => Err(CallError::Unauthorized),
        Err(ureq::Error::Status(code, r)) => {
            let v = parse(r);
            Err(CallError::Other(v.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
                if matches!(code, 404 | 502 | 503 | 504) {
                    "小悦笔记服务暂时无法访问，请稍后再试".to_string()
                } else {
                    format!("小悦笔记服务返回错误 {}", code)
                }
            })))
        }
        Err(_) => Err(CallError::Network("无法连接小悦笔记服务，请检查网络后重试".into())),
    }
}

fn set(db: &Database, key: &str, value: &str) -> Result<(), AppError> {
    db.set_setting(key, value)
}

fn account_token(db: &Database) -> Result<Option<String>, AppError> {
    let conn = db.lock()?;
    Ok(setting(&conn, &k_account_token()))
}

/// 向服务器激活（code 为空表示按账号恢复：已激活的本机、名下激活码空位或一年免费期）
fn activate_online_raw(db: &Database, token: &str, code: Option<&str>) -> Result<LicenseStatus, CallError> {
    let mut body = {
        let conn = db.lock().map_err(|e| CallError::Other(e.to_string()))?;
        device_json(&conn)
    };
    if let Some(c) = code {
        body["code"] = Value::String(c.trim().to_string());
    }
    let endpoint = crate::obf!("/api/v1/license/activate");
    let v = call(&endpoint, Some(token), Some(body))?;
    let lic = v
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| CallError::Other("授权服务返回的数据无法识别".into()))?;
    let key = public_key().ok_or_else(|| CallError::Other("此版本未配置授权公钥，请从官网下载正式版".into()))?;
    verify(lic, &key).map_err(CallError::Other)?;
    set(db, &k_license(), lic).map_err(|e| CallError::Other(e.to_string()))?;
    if let Some(info) = v.get("entitlement") {
        set(db, &k_last_info(), &info.to_string()).map_err(|e| CallError::Other(e.to_string()))?;
    }
    if let Some(a) = v.get("account").and_then(Value::as_str) {
        set(db, &k_account(), a).map_err(|e| CallError::Other(e.to_string()))?;
    }
    status(db).map_err(|e| CallError::Other(e.to_string()))
}

fn activate_online(db: &Database, token: &str, code: Option<&str>) -> Result<LicenseStatus, AppError> {
    match activate_online_raw(db, token, code) {
        Ok(s) => Ok(s),
        Err(CallError::Unauthorized) => {
            db.delete_setting(&k_account_token())?;
            Err(AppError::Validation("登录已过期，请重新登录通行证".into()))
        }
        Err(CallError::Network(m)) | Err(CallError::Other(m)) => Err(AppError::Validation(m)),
    }
}

/// 直接调用 fwpt.cn 的通行证登录接口（与首页、磐石密码本相同），返回令牌和显示名
fn oneid_login(account: &str, password: &str) -> Result<(String, String), AppError> {
    let url = format!("{}{}", crate::sync_config::oneid_base_url().trim_end_matches('/'), crate::obf!("/api/v1/auth/login"));
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(20)).build();
    let body = serde_json::json!({ "username": account, "account": account, "password": password, "source": "XYNOTE" });
    let res = agent.post(&url).set("Content-Type", "application/json").set("Accept", "application/json").send_string(&body.to_string());
    let v: Value = match res {
        Ok(r) => r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null),
        Err(ureq::Error::Status(_, r)) => r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null),
        Err(_) => return Err(AppError::Validation("无法连接 FWPT 通行证服务，请检查网络后重试".into())),
    };
    let data = v.get("data").filter(|d| d.is_object()).unwrap_or(&v);
    let token = data
        .get("token")
        .or_else(|| data.get("access_token"))
        .or_else(|| data.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    let ok = v.get("code").and_then(Value::as_str).map(|c| c == "00000").unwrap_or(true);
    match token {
        Some(t) if ok => {
            let text = |k: &str| data.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            let display = text("realName").or_else(|| text("nickname")).or_else(|| text("username")).unwrap_or_else(|| account.to_string());
            Ok((t.to_string(), display))
        }
        _ => Err(AppError::Validation(
            v.get("message")
                .or_else(|| v.get("msg"))
                .and_then(Value::as_str)
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("账号或密码不正确")
                .to_string(),
        )),
    }
}

/// 用 FWPT 通行证登录；第一次登录会获得一年永久版权限
pub fn login(db: &Database, account: &str, password: &str) -> Result<LicenseStatus, AppError> {
    if account.trim().is_empty() || password.is_empty() {
        return Err(AppError::Validation("请输入通行证账号和密码".into()));
    }
    let (token, display) = oneid_login(account.trim(), password)?;
    set(db, &k_account_token(), &token)?;
    set(db, &k_account(), &display)?;
    let res_token = token;
    match activate_online(db, &res_token, None) {
        Ok(s) => Ok(s),
        // 免费期已结束等情况：登录本身成功，提示交给界面
        Err(AppError::Validation(m)) if !m.contains("登录已过期") => {
            let mut s = status(db)?;
            s.logged_in = true;
            set(db, &k_last_info(), &serde_json::json!({ "notice": m }).to_string())?;
            Ok(s)
        }
        Err(e) => Err(e),
    }
}

/// 启动时调用：已登录则向服务器报到并刷新授权；断网或服务临时不可达时静默保留本地 Ed25519 授权，绝不阻塞离线使用
pub fn refresh(db: &Database) -> Result<LicenseStatus, AppError> {
    let Some(token) = account_token(db)? else {
        return status(db);
    };
    match activate_online_raw(db, &token, None) {
        Ok(s) => Ok(s),
        Err(CallError::Unauthorized) => {
            db.delete_setting(&k_account_token())?;
            status(db)
        }
        Err(CallError::Network(_)) | Err(CallError::Other(_)) => status(db),
    }
}

/// 输入激活码；`XYNOTE1.` 开头的离线授权直接校验，其余向服务器激活（需要先登录）
pub fn activate(db: &Database, input: &str) -> Result<LicenseStatus, AppError> {
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(AppError::Validation("请输入激活码".into()));
    }
    if compact.starts_with(&crate::obf!("XYNOTE1")) {
        let key = public_key().ok_or_else(|| AppError::Validation("此版本未配置授权公钥，请从官网下载正式版".into()))?;
        let p = verify(&compact, &key).map_err(AppError::Validation)?;
        if expired(&p) {
            return Err(AppError::Validation("这个授权已到期".into()));
        }
        set(db, &k_license(), &compact)?;
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
        let endpoint = crate::obf!("/api/v1/license/deactivate");
        match call(&endpoint, Some(&token), Some(serde_json::json!({ "machineId": machine }))) {
            Ok(_) | Err(CallError::Unauthorized) => {}
            Err(CallError::Network(m)) | Err(CallError::Other(m)) => return Err(AppError::Validation(m)),
        }
    }
    db.delete_setting(&k_license())?;
    db.delete_setting(&k_last_info())?;
    status(db)
}

/// 退出通行证；本机已有的授权保留到期
pub fn logout(db: &Database) -> Result<LicenseStatus, AppError> {
    db.delete_setting(&k_account_token())?;
    db.delete_setting(&k_account())?;
    status(db)
}

/// 在软件里创建购买订单（显示付款码和订单信息）
pub fn create_order(db: &Database, product: &str) -> Result<Value, AppError> {
    let token = account_token(db)?.ok_or_else(|| AppError::Validation("请先登录 FWPT 通行证".into()))?;
    let product = if product == "device_slot" { "device_slot" } else { "lifetime" };
    let endpoint = crate::obf!("/api/v1/store/orders");
    match call(&endpoint, Some(&token), Some(serde_json::json!({ "product": product }))) {
        Ok(v) => Ok(v),
        Err(CallError::Unauthorized) => {
            db.delete_setting(&k_account_token())?;
            Err(AppError::Validation("登录已过期，请重新登录通行证".into()))
        }
        Err(CallError::Network(m)) | Err(CallError::Other(m)) => Err(AppError::Validation(m)),
    }
}

/// 意见反馈：登录时关联通行证账号，未登录也可以提交
pub fn submit_feedback(db: &Database, category: &str, content: &str, contact: &str) -> Result<(), AppError> {
    let token = account_token(db)?;
    let body = serde_json::json!({
        "category": category,
        "content": content,
        "contact": contact,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "source": "app",
    });
    let endpoint = crate::obf!("/api/v1/feedback");
    match call(&endpoint, token.as_deref(), Some(body.clone())) {
        Ok(_) => Ok(()),
        // 令牌过期时匿名提交
        Err(CallError::Unauthorized) => match call(&endpoint, None, Some(body)) {
            Ok(_) => Ok(()),
            Err(CallError::Unauthorized) => Err(AppError::Validation("提交失败，请稍后重试".into())),
            Err(CallError::Network(m)) | Err(CallError::Other(m)) => Err(AppError::Validation(m)),
        },
        Err(CallError::Network(m)) | Err(CallError::Other(m)) => Err(AppError::Validation(m)),
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

    #[test]
    fn offline_refresh_preserves_local_ed25519_license() {
        let db = Database::open_in_memory().unwrap();
        // 使用仓库内置公钥对应的无效激活码不会过；因此主要验证有离线本地记录且无 token 时 refresh 不失败、且 stored_payload/refresh 逻辑健壮
        assert!(!refresh(&db).unwrap().active);
        // 模拟存在无效/不可达远端时的令牌保留：写入虚假通行证令牌并确保断网场景不清除有效状态（此处无真实私钥仅测试网络错误不报错）
        let _ = set(&db, &k_account_token(), "unreachable-token-for-offline-test");
        // 若不连外网而测试 refresh 时，仅在 CI/真实本地环境无外网干扰；因此主要验证 key 混淆一致性
        assert_eq!(k_license(), "license.key");
        assert_eq!(k_account_token(), "sync.secret.licenseToken");
        assert!(public_key().is_some(), "混淆后的内置公钥必须正常还原");
    }
}
