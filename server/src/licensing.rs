//! 小悦笔记永久版授权（官方服务）。
//!
//! - 通行证账号第一次在软件里登录，赠送一年永久版权限（trial），免费账号只能绑定 1 台电脑。
//! - 官网购买后发放激活码 `XYP-XXXX-XXXX-XXXX-XXXX`，一个激活码默认可在 3 台电脑上使用，
//!   第一次激活时绑定到激活的通行证账号；不够用时可以单独购买「增加 1 台电脑」。
//! - 每次登录 / 激活都记录机器信息（机器指纹、名称、系统、版本），用于核对和统计。
//! - 服务器返回用永久版私钥签名的授权令牌，软件离线校验（绑定本机、试用期带到期时间）。

use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const TRIAL_DAYS: i64 = 365;
pub const DEFAULT_MAX_DEVICES: i64 = 3;
/// 免费账号（一年免费期）可绑定的电脑数
pub const TRIAL_MAX_DEVICES: i64 = 1;

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS license_codes (
        code TEXT PRIMARY KEY,
        edition TEXT NOT NULL DEFAULT 'lifetime',
        max_devices INTEGER NOT NULL DEFAULT 3,
        owner_user_id INTEGER NULL REFERENCES users(id),
        order_id TEXT NULL,
        note TEXT NOT NULL DEFAULT '',
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        bound_at TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS license_activations (
        code TEXT NOT NULL REFERENCES license_codes(code),
        machine_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id),
        machine_name TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        PRIMARY KEY (code, machine_id)
    );
    CREATE TABLE IF NOT EXISTS devices (
        user_id INTEGER NOT NULL REFERENCES users(id),
        machine_id TEXT NOT NULL,
        machine_name TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        PRIMARY KEY (user_id, machine_id)
    );
    CREATE INDEX IF NOT EXISTS idx_license_codes_owner ON license_codes(owner_user_id);
    CREATE TABLE IF NOT EXISTS trial_bindings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        machine_id TEXT NOT NULL,
        bound_at TEXT NOT NULL
    );
";

/// 软件上报的机器信息
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub machine_id: String,
    #[serde(default)]
    pub machine_name: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub app_version: String,
}

impl DeviceInfo {
    pub fn validate(&self) -> Result<(), String> {
        let id = self.machine_id.trim();
        if id.len() < 8 || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("机器标识无效".into());
        }
        Ok(())
    }
    fn clip(s: &str, n: usize) -> String {
        s.trim().chars().filter(|c| !c.is_control()).take(n).collect()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    /// lifetime / trial
    pub edition: String,
    pub expires_at: Option<String>,
    pub code: Option<String>,
    pub devices_used: i64,
    pub max_devices: i64,
    pub trial_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LicenseError {
    BadRequest(String),
    NotFound(String),
    Forbidden(String),
    Conflict(String),
    /// 免费期已结束，需要购买
    PaymentRequired(String),
    Internal(String),
}

impl From<rusqlite::Error> for LicenseError {
    fn from(e: rusqlite::Error) -> Self {
        LicenseError::Internal(e.to_string())
    }
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 生成激活码 `XYP-XXXX-XXXX-XXXX-XXXX`（约 79 位随机）
pub fn new_code() -> String {
    let mut rng = rand::thread_rng();
    let body: Vec<String> = (0..4)
        .map(|_| (0..4).map(|_| ALPHABET[(rng.next_u32() as usize) % ALPHABET.len()] as char).collect())
        .collect();
    format!("XYP-{}", body.join("-"))
}

/// 规范化用户输入：忽略大小写、空格和横线
pub fn canonical_code(input: &str) -> Option<String> {
    let norm: String = input.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    let body = norm.strip_prefix("XYP").unwrap_or(&norm);
    if body.len() != 16 || !body.bytes().all(|b| ALPHABET.contains(&b)) {
        return None;
    }
    Some(format!("XYP-{}-{}-{}-{}", &body[0..4], &body[4..8], &body[8..12], &body[12..16]))
}

pub fn create_codes(
    conn: &Connection,
    count: u32,
    max_devices: i64,
    note: &str,
    order_id: Option<&str>,
    owner: Option<i64>,
) -> Result<Vec<String>, String> {
    if count == 0 || count > 10_000 {
        return Err("count 需在 1~10000 之间".into());
    }
    if !(1..=50).contains(&max_devices) {
        return Err("maxDevices 需在 1~50 之间".into());
    }
    let at = now().to_rfc3339();
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let code = new_code();
        conn.execute(
            "INSERT INTO license_codes (code, max_devices, owner_user_id, order_id, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![code, max_devices, owner, order_id, note, at],
        )
        .map_err(|e| e.to_string())?;
        out.push(code);
    }
    Ok(out)
}

/// 记录本次登录 / 激活的机器（统计用）
pub fn record_device(conn: &Connection, user_id: i64, d: &DeviceInfo) -> rusqlite::Result<()> {
    let at = now().to_rfc3339();
    conn.execute(
        "INSERT INTO devices (user_id, machine_id, machine_name, os, app_version, first_at, last_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(user_id, machine_id) DO UPDATE SET
           machine_name = excluded.machine_name, os = excluded.os, app_version = excluded.app_version, last_at = excluded.last_at",
        params![user_id, d.machine_id.trim(), DeviceInfo::clip(&d.machine_name, 80), DeviceInfo::clip(&d.os, 40), DeviceInfo::clip(&d.app_version, 30), at],
    )?;
    Ok(())
}

fn used_slots(conn: &Connection, code: &str, except_machine: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM license_activations WHERE code = ?1 AND machine_id != ?2",
        params![code, except_machine],
        |r| r.get(0),
    )
}

fn bind_machine(conn: &Connection, code: &str, user_id: i64, d: &DeviceInfo) -> rusqlite::Result<()> {
    let at = now().to_rfc3339();
    conn.execute(
        "INSERT INTO license_activations (code, machine_id, user_id, machine_name, os, app_version, first_at, last_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(code, machine_id) DO UPDATE SET
           user_id = excluded.user_id, machine_name = excluded.machine_name, os = excluded.os,
           app_version = excluded.app_version, last_at = excluded.last_at",
        params![
            code,
            d.machine_id.trim(),
            user_id,
            DeviceInfo::clip(&d.machine_name, 80),
            DeviceInfo::clip(&d.os, 40),
            DeviceInfo::clip(&d.app_version, 30),
            at
        ],
    )?;
    conn.execute(
        "UPDATE license_codes SET owner_user_id = ?1, bound_at = COALESCE(bound_at, ?2) WHERE code = ?3 AND owner_user_id IS NULL",
        params![user_id, at, code],
    )?;
    Ok(())
}

fn lifetime(conn: &Connection, code: &str, max_devices: i64, trial_until: Option<String>) -> rusqlite::Result<Entitlement> {
    Ok(Entitlement {
        edition: "lifetime".into(),
        expires_at: None,
        code: Some(code.to_string()),
        devices_used: used_slots(conn, code, "")?,
        max_devices,
        trial_until,
    })
}

/// 登录或输入激活码时调用。`code` 为空表示按账号恢复授权（已激活的本机、名下激活码的空位、或一年免费期）。
pub fn activate(conn: &Connection, user_id: i64, d: &DeviceInfo, code: Option<&str>) -> Result<Entitlement, LicenseError> {
    d.validate().map_err(LicenseError::BadRequest)?;
    record_device(conn, user_id, d)?;
    let machine = d.machine_id.trim();
    let trial_until: Option<String> =
        conn.query_row("SELECT trial_until FROM users WHERE id = ?1", params![user_id], |r| r.get(0)).optional()?.flatten();

    if let Some(input) = code.map(str::trim).filter(|c| !c.is_empty()) {
        let code = canonical_code(input).ok_or_else(|| LicenseError::BadRequest("激活码格式不正确，应为 XYP-XXXX-XXXX-XXXX-XXXX".into()))?;
        let row: Option<(i64, Option<i64>, i64)> = conn
            .query_row(
                "SELECT max_devices, owner_user_id, revoked FROM license_codes WHERE code = ?1",
                params![code],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((max, owner, revoked)) = row else {
            return Err(LicenseError::NotFound("激活码不存在，请检查是否输入正确".into()));
        };
        if revoked != 0 {
            return Err(LicenseError::Forbidden("该激活码已停用，请联系 admin@fwpt.cn".into()));
        }
        if owner.is_some_and(|o| o != user_id) {
            return Err(LicenseError::Forbidden("该激活码已绑定其他通行证账号".into()));
        }
        if used_slots(conn, &code, machine)? >= max {
            return Err(LicenseError::Conflict(format!(
                "该激活码已在 {} 台电脑上使用。请先在不用的电脑上「停用本机授权」，再来激活",
                max
            )));
        }
        bind_machine(conn, &code, user_id, d)?;
        return Ok(lifetime(conn, &code, max, trial_until)?);
    }

    // 本机已用名下激活码激活过
    let active: Option<(String, i64)> = conn
        .query_row(
            "SELECT c.code, c.max_devices FROM license_activations a JOIN license_codes c ON c.code = a.code
             WHERE a.machine_id = ?1 AND c.owner_user_id = ?2 AND c.revoked = 0 LIMIT 1",
            params![machine, user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((code, max)) = active {
        bind_machine(conn, &code, user_id, d)?;
        return Ok(lifetime(conn, &code, max, trial_until)?);
    }

    // 名下激活码还有空位：换电脑登录后自动激活
    let owned: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT code, max_devices FROM license_codes WHERE owner_user_id = ?1 AND revoked = 0 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (code, max) in &owned {
        if used_slots(conn, code, machine)? < *max {
            bind_machine(conn, code, user_id, d)?;
            return Ok(lifetime(conn, code, *max, trial_until)?);
        }
    }

    // 已购永久版但电脑数用满：不再退回免费试用，提示停用旧电脑或加购
    if let Some((_, max)) = owned.iter().max_by_key(|(_, m)| *m) {
        return Err(LicenseError::Conflict(format!(
            "你的永久版已在 {} 台电脑上使用。请先在不用的电脑上「停用本机授权」或到用户中心解绑，也可以在用户中心加购电脑数",
            max
        )));
    }

    // 一年免费期：账号第一次在软件中登录时开始计算
    let trial_until = match trial_until {
        Some(t) => t,
        None => {
            let t = (now() + chrono::Duration::days(TRIAL_DAYS)).to_rfc3339();
            conn.execute("UPDATE users SET trial_until = ?1 WHERE id = ?2", params![t, user_id])?;
            t
        }
    };
    let trial_active = chrono::DateTime::parse_from_rfc3339(&trial_until).map(|t| t > now()).unwrap_or(false);
    if trial_active {
        // 免费账号只能绑定 1 台电脑
        let bound: Option<String> = conn
            .query_row("SELECT machine_id FROM trial_bindings WHERE user_id = ?1", params![user_id], |r| r.get(0))
            .optional()?;
        match bound {
            Some(m) if m != machine => {
                return Err(LicenseError::Conflict(
                    "免费账号只能在 1 台电脑上使用。请先在原来的电脑上「停用本机授权」，或到用户中心解绑；购买永久版可在 3 台电脑使用"
                        .into(),
                ));
            }
            Some(_) => {}
            None => {
                conn.execute(
                    "INSERT INTO trial_bindings (user_id, machine_id, bound_at) VALUES (?1, ?2, ?3)",
                    params![user_id, machine, now().to_rfc3339()],
                )?;
            }
        }
        return Ok(Entitlement {
            edition: "trial".into(),
            expires_at: Some(trial_until.clone()),
            code: None,
            devices_used: 1,
            max_devices: TRIAL_MAX_DEVICES,
            trial_until: Some(trial_until),
        });
    }
    Err(LicenseError::PaymentRequired("一年免费期已结束，购买永久版后输入激活码即可继续使用".into()))
}

/// 在本机停用授权，空出一个位置
pub fn deactivate(conn: &Connection, user_id: i64, machine_id: &str) -> rusqlite::Result<usize> {
    let n = conn.execute(
        "DELETE FROM license_activations WHERE machine_id = ?1
         AND code IN (SELECT code FROM license_codes WHERE owner_user_id = ?2)",
        params![machine_id.trim(), user_id],
    )?;
    let t = conn.execute(
        "DELETE FROM trial_bindings WHERE user_id = ?1 AND machine_id = ?2",
        params![user_id, machine_id.trim()],
    )?;
    Ok(n + t)
}

/// 给账号名下的激活码增加电脑数量（购买「增加 1 台电脑」后调用），返回被增加的激活码
pub fn add_device_slot(conn: &Connection, user_id: i64, count: i64) -> Result<String, String> {
    let code: Option<String> = conn
        .query_row(
            "SELECT code FROM license_codes WHERE owner_user_id = ?1 AND revoked = 0 ORDER BY created_at LIMIT 1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let code = code.ok_or("该账号还没有永久版激活码，请先购买永久版")?;
    conn.execute("UPDATE license_codes SET max_devices = max_devices + ?1 WHERE code = ?2", params![count, code])
        .map_err(|e| e.to_string())?;
    Ok(code)
}

pub fn owns_code(conn: &Connection, user_id: i64) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM license_codes WHERE owner_user_id = ?1 AND revoked = 0",
        params![user_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDevice {
    pub machine_id: String,
    pub machine_name: String,
    pub os: String,
    pub app_version: String,
    pub last_at: String,
    /// lifetime（占用激活码的位置）/ trial（免费账号绑定的那台）
    pub kind: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCode {
    pub code: String,
    pub max_devices: i64,
    pub devices_used: i64,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseSummary {
    pub trial_until: Option<String>,
    pub trial_active: bool,
    pub trial_max_devices: i64,
    pub codes: Vec<UserCode>,
    pub devices: Vec<UserDevice>,
}

/// 用户中心：授权、激活码与已绑定的电脑
pub fn summary(conn: &Connection, user_id: i64) -> rusqlite::Result<LicenseSummary> {
    let trial_until: Option<String> =
        conn.query_row("SELECT trial_until FROM users WHERE id = ?1", params![user_id], |r| r.get(0)).optional()?.flatten();
    let trial_active = trial_until
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t > now())
        .unwrap_or(false);
    let mut stmt = conn.prepare(
        "SELECT c.code, c.max_devices, c.revoked, (SELECT COUNT(*) FROM license_activations a WHERE a.code = c.code)
         FROM license_codes c WHERE c.owner_user_id = ?1 ORDER BY c.created_at",
    )?;
    let codes = stmt
        .query_map(params![user_id], |r| {
            Ok(UserCode { code: r.get(0)?, max_devices: r.get(1)?, revoked: r.get::<_, i64>(2)? != 0, devices_used: r.get(3)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut devices = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT a.machine_id, a.machine_name, a.os, a.app_version, a.last_at, a.code
         FROM license_activations a JOIN license_codes c ON c.code = a.code
         WHERE c.owner_user_id = ?1 ORDER BY a.last_at DESC",
    )?;
    for d in stmt.query_map(params![user_id], |r| {
        Ok(UserDevice {
            machine_id: r.get(0)?,
            machine_name: r.get(1)?,
            os: r.get(2)?,
            app_version: r.get(3)?,
            last_at: r.get(4)?,
            kind: "lifetime".into(),
            code: Some(r.get(5)?),
        })
    })? {
        devices.push(d?);
    }
    let trial: Option<(String, String)> = conn
        .query_row(
            "SELECT t.machine_id, t.bound_at FROM trial_bindings t WHERE t.user_id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((mid, bound_at)) = trial {
        if !devices.iter().any(|d| d.machine_id == mid) {
            let info: Option<(String, String, String, String)> = conn
                .query_row(
                    "SELECT machine_name, os, app_version, last_at FROM devices WHERE user_id = ?1 AND machine_id = ?2",
                    params![user_id, mid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let (name, os, ver, last) = info.unwrap_or_else(|| ("未知电脑".into(), String::new(), String::new(), bound_at));
            devices.push(UserDevice { machine_id: mid, machine_name: name, os, app_version: ver, last_at: last, kind: "trial".into(), code: None });
        }
    }
    Ok(LicenseSummary { trial_until, trial_active, trial_max_devices: TRIAL_MAX_DEVICES, codes, devices })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDevice {
    pub machine_name: String,
    pub os: String,
    pub app_version: String,
    pub first_at: String,
    pub last_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeInfo {
    pub code: String,
    pub max_devices: i64,
    pub owner: Option<String>,
    pub owner_email: Option<String>,
    pub order_id: Option<String>,
    pub note: String,
    pub revoked: bool,
    pub created_at: String,
    pub devices: Vec<CodeDevice>,
}

pub fn list_codes(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<CodeInfo>> {
    let mut stmt = conn.prepare(
        "SELECT c.code, c.max_devices, COALESCE(u.display_name, u.email), u.contact_email, c.order_id, c.note, c.revoked, c.created_at
         FROM license_codes c LEFT JOIN users u ON u.id = c.owner_user_id ORDER BY c.created_at DESC LIMIT ?1",
    )?;
    let mut codes = stmt
        .query_map(params![limit], |r| {
            Ok(CodeInfo {
                code: r.get(0)?,
                max_devices: r.get(1)?,
                owner: r.get(2)?,
                owner_email: r.get(3)?,
                order_id: r.get(4)?,
                note: r.get(5)?,
                revoked: r.get::<_, i64>(6)? != 0,
                created_at: r.get(7)?,
                devices: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut dev = conn.prepare(
        "SELECT machine_name, os, app_version, first_at, last_at FROM license_activations WHERE code = ?1 ORDER BY first_at",
    )?;
    for c in &mut codes {
        c.devices = dev
            .query_map(params![c.code], |r| {
                Ok(CodeDevice { machine_name: r.get(0)?, os: r.get(1)?, app_version: r.get(2)?, first_at: r.get(3)?, last_at: r.get(4)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }
    Ok(codes)
}

/// 客服：清空某个激活码的已激活电脑
pub fn reset_code(conn: &Connection, code: &str) -> Result<usize, String> {
    let code = canonical_code(code).ok_or("激活码格式不正确")?;
    conn.execute("DELETE FROM license_activations WHERE code = ?1", params![code]).map_err(|e| e.to_string())
}

pub fn set_revoked(conn: &Connection, code: &str, revoked: bool) -> Result<usize, String> {
    let code = canonical_code(code).ok_or("激活码格式不正确")?;
    conn.execute("UPDATE license_codes SET revoked = ?1 WHERE code = ?2", params![revoked as i64, code]).map_err(|e| e.to_string())
}

/// 统计：账号、免费期、激活码与设备
pub fn stats(conn: &Connection) -> rusqlite::Result<serde_json::Value> {
    let now = now();
    let month_ago = (now - chrono::Duration::days(30)).to_rfc3339();
    let now_s = now.to_rfc3339();
    let one = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<i64> { conn.query_row(sql, p, |r| r.get(0)) };
    Ok(serde_json::json!({
        "users": one("SELECT COUNT(*) FROM users", &[])?,
        "appUsers": one("SELECT COUNT(*) FROM users WHERE trial_until IS NOT NULL", &[])?,
        "trialActive": one("SELECT COUNT(*) FROM users WHERE trial_until > ?1", &[&now_s])?,
        "codesTotal": one("SELECT COUNT(*) FROM license_codes", &[])?,
        "codesBound": one("SELECT COUNT(*) FROM license_codes WHERE owner_user_id IS NOT NULL", &[])?,
        "activations": one("SELECT COUNT(*) FROM license_activations", &[])?,
        "devices": one("SELECT COUNT(*) FROM devices", &[])?,
        "devicesActive30d": one("SELECT COUNT(*) FROM devices WHERE last_at > ?1", &[&month_ago])?,
    }))
}
