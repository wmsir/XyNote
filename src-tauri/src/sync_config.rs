//! 同步设置：保存在 app_settings 表里。密码、令牌、同步密码使用 `sync.secret.` 前缀，
//! 不会通过 get_settings 返回给界面。

use crate::db::{now_iso, Database};
use crate::models::AppError;
use crate::sync::{run_sync, SyncOptions, SyncRemote, SyncReport};
use crate::sync_remote::{server_auth, AccountInfo, FolderRemote, ServerRemote, WebDavRemote};
use serde::{Deserialize, Serialize};

pub const SECRET_PREFIX: &str = "sync.secret.";

/// 官方同步服务地址与订阅页面，可在构建时用环境变量覆盖
/// 小悦笔记服务（授权、订单、反馈、用户中心），部署在 fwpt.cn 的 /xynote/ 下
pub fn official_server_url() -> &'static str {
    option_env!("XYNOTE_OFFICIAL_SYNC_URL").filter(|v| !v.trim().is_empty()).unwrap_or("https://fwpt.cn/xynote")
}
/// 用户中心（购买、电脑管理、订单）
pub fn official_pricing_url() -> &'static str {
    option_env!("XYNOTE_PRICING_URL").filter(|v| !v.trim().is_empty()).unwrap_or("https://fwpt.cn/xynote/")
}
/// FWPT 统一通行证（与 fwpt.cn 首页使用同一个登录接口）
pub fn oneid_base_url() -> &'static str {
    option_env!("XYNOTE_ONEID_URL").filter(|v| !v.trim().is_empty()).unwrap_or("https://fwpt.cn")
}

const K_MODE: &str = "sync.mode";
const K_FOLDER: &str = "sync.folder";
const K_WEBDAV_URL: &str = "sync.webdav.url";
const K_WEBDAV_USER: &str = "sync.webdav.user";
const K_SERVER_URL: &str = "sync.server.url";
const K_SERVER_EMAIL: &str = "sync.server.email";
const K_OFFICIAL_EMAIL: &str = "sync.official.email";
const K_AUTO: &str = "sync.auto";
const K_INTERVAL: &str = "sync.intervalMinutes";
const K_LAST_AT: &str = "sync.lastAt";
const K_LAST_REPORT: &str = "sync.lastReport";
const K_LAST_ERROR: &str = "sync.lastError";
const S_WEBDAV_PASSWORD: &str = "sync.secret.webdavPassword";
const S_SERVER_TOKEN: &str = "sync.secret.serverToken";
const S_OFFICIAL_TOKEN: &str = "sync.secret.officialToken";
const S_PASSPHRASE: &str = "sync.secret.passphrase";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncMode {
    /// 纯本地，不同步
    Local,
    /// 网盘客户端同步的文件夹
    Folder,
    Webdav,
    /// 自建的 XyNote 同步服务器
    Server,
    /// 官方付费云同步
    Official,
}

impl SyncMode {
    fn parse(s: &str) -> Self {
        match s {
            "folder" => Self::Folder,
            "webdav" => Self::Webdav,
            "server" => Self::Server,
            "official" => Self::Official,
            _ => Self::Local,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Folder => "folder",
            Self::Webdav => "webdav",
            Self::Server => "server",
            Self::Official => "official",
        }
    }
}

/// 返回给界面的同步配置（不含任何密码 / 令牌本身，只告诉界面「是否已设置」）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigView {
    pub mode: SyncMode,
    pub folder: String,
    pub webdav_url: String,
    pub webdav_user: String,
    pub has_webdav_password: bool,
    pub server_url: String,
    pub server_email: String,
    pub server_logged_in: bool,
    pub official_url: String,
    pub official_email: String,
    pub official_logged_in: bool,
    pub pricing_url: String,
    pub has_passphrase: bool,
    pub auto_sync: bool,
    pub interval_minutes: u32,
    pub last_at: Option<String>,
    pub last_report: Option<SyncReport>,
    pub last_error: Option<String>,
}

/// 界面提交的配置；密码类字段为 None 表示不修改，空字符串表示清除
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigInput {
    pub mode: Option<SyncMode>,
    pub folder: Option<String>,
    pub webdav_url: Option<String>,
    pub webdav_user: Option<String>,
    pub webdav_password: Option<String>,
    pub server_url: Option<String>,
    pub passphrase: Option<String>,
    pub auto_sync: Option<bool>,
    pub interval_minutes: Option<u32>,
}

fn get(db: &Database, key: &str) -> Result<String, AppError> {
    Ok(db.get_setting_raw(key)?.unwrap_or_default())
}

fn put_or_clear(db: &Database, key: &str, value: &str) -> Result<(), AppError> {
    if value.is_empty() {
        db.delete_setting(key)
    } else {
        db.set_setting(key, value)
    }
}

pub fn load_view(db: &Database) -> Result<SyncConfigView, AppError> {
    let last_report = db
        .get_setting_raw(K_LAST_REPORT)?
        .and_then(|s| serde_json::from_str::<SyncReport>(&s).ok());
    let interval = get(db, K_INTERVAL)?.parse::<u32>().ok().filter(|v| *v > 0).unwrap_or(5);
    Ok(SyncConfigView {
        mode: SyncMode::parse(&get(db, K_MODE)?),
        folder: get(db, K_FOLDER)?,
        webdav_url: get(db, K_WEBDAV_URL)?,
        webdav_user: get(db, K_WEBDAV_USER)?,
        has_webdav_password: !get(db, S_WEBDAV_PASSWORD)?.is_empty(),
        server_url: get(db, K_SERVER_URL)?,
        server_email: get(db, K_SERVER_EMAIL)?,
        server_logged_in: !get(db, S_SERVER_TOKEN)?.is_empty(),
        official_url: official_server_url().to_string(),
        official_email: get(db, K_OFFICIAL_EMAIL)?,
        official_logged_in: !get(db, S_OFFICIAL_TOKEN)?.is_empty(),
        pricing_url: official_pricing_url().to_string(),
        has_passphrase: !get(db, S_PASSPHRASE)?.is_empty(),
        auto_sync: get(db, K_AUTO)? != "false",
        interval_minutes: interval,
        last_at: db.get_setting_raw(K_LAST_AT)?,
        last_report,
        last_error: db.get_setting_raw(K_LAST_ERROR)?.filter(|s| !s.is_empty()),
    })
}

/// 当前同步位置的标识：位置变了，上次同步的基线就不再适用
fn target_signature(db: &Database) -> Result<String, AppError> {
    Ok(format!(
        "{}|{}|{}|{}",
        get(db, K_MODE)?,
        get(db, K_FOLDER)?,
        get(db, K_WEBDAV_URL)?,
        get(db, K_SERVER_URL)?
    ))
}

pub fn save_config(db: &Database, input: SyncConfigInput) -> Result<SyncConfigView, AppError> {
    let before = target_signature(db)?;
    if let Some(mode) = input.mode {
        db.set_setting(K_MODE, mode.as_str())?;
    }
    if let Some(v) = input.folder {
        db.set_setting(K_FOLDER, v.trim())?;
    }
    if let Some(v) = input.webdav_url {
        db.set_setting(K_WEBDAV_URL, v.trim())?;
    }
    if let Some(v) = input.webdav_user {
        db.set_setting(K_WEBDAV_USER, v.trim())?;
    }
    if let Some(v) = input.webdav_password {
        put_or_clear(db, S_WEBDAV_PASSWORD, &v)?;
    }
    if let Some(v) = input.server_url {
        let new_url = v.trim().trim_end_matches('/').to_string();
        if new_url != get(db, K_SERVER_URL)? {
            // 服务器换了，旧令牌作废
            db.delete_setting(S_SERVER_TOKEN)?;
        }
        db.set_setting(K_SERVER_URL, &new_url)?;
    }
    if let Some(v) = input.passphrase {
        put_or_clear(db, S_PASSPHRASE, &v)?;
    }
    if let Some(v) = input.auto_sync {
        db.set_setting(K_AUTO, if v { "true" } else { "false" })?;
    }
    if let Some(v) = input.interval_minutes {
        db.set_setting(K_INTERVAL, &v.clamp(1, 1440).to_string())?;
    }
    if target_signature(db)? != before {
        // 换了同步位置：下次同步与新位置重新逐页对比（内容相同的页面不会产生冲突副本）
        reset_baseline(db)?;
        db.delete_setting(K_LAST_ERROR)?;
    }
    load_view(db)
}

fn reset_baseline(db: &Database) -> Result<(), AppError> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM sync_state", [])?;
    Ok(())
}

/// 登录 / 注册自建服务器或官方服务，保存令牌
pub fn auth(db: &Database, official: bool, action: &str, email: &str, password: &str) -> Result<AccountInfo, AppError> {
    let url = if official { official_server_url().to_string() } else { get(db, K_SERVER_URL)? };
    if url.is_empty() {
        return Err(AppError::Validation("请先填写服务器地址".into()));
    }
    let res = server_auth(&url, action, email, password)?;
    if official {
        db.set_setting(S_OFFICIAL_TOKEN, &res.token)?;
        db.set_setting(K_OFFICIAL_EMAIL, &res.account.email)?;
    } else {
        db.set_setting(S_SERVER_TOKEN, &res.token)?;
        db.set_setting(K_SERVER_EMAIL, &res.account.email)?;
    }
    Ok(res.account)
}

pub fn logout(db: &Database, official: bool) -> Result<(), AppError> {
    if official {
        db.delete_setting(S_OFFICIAL_TOKEN)?;
        db.delete_setting(K_OFFICIAL_EMAIL)
    } else {
        db.delete_setting(S_SERVER_TOKEN)?;
        db.delete_setting(K_SERVER_EMAIL)
    }
}

pub fn account(db: &Database, official: bool) -> Result<AccountInfo, AppError> {
    let (url, token) = if official {
        (official_server_url().to_string(), get(db, S_OFFICIAL_TOKEN)?)
    } else {
        (get(db, K_SERVER_URL)?, get(db, S_SERVER_TOKEN)?)
    };
    ServerRemote::new(&url, &token)?.account()
}


pub fn redeem(db: &Database, official: bool, code: &str) -> Result<AccountInfo, AppError> {
    if code.trim().is_empty() {
        return Err(AppError::Validation("请输入激活码".into()));
    }
    let (url, token) = if official {
        (official_server_url().to_string(), get(db, S_OFFICIAL_TOKEN)?)
    } else {
        (get(db, K_SERVER_URL)?, get(db, S_SERVER_TOKEN)?)
    };
    if token.is_empty() {
        return Err(AppError::Validation("请先登录".into()));
    }
    ServerRemote::new(&url, &token)?.redeem(code)
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "本机".into())
}

/// 按当前配置建立远端连接
pub fn build_remote(db: &Database) -> Result<Option<Box<dyn SyncRemote>>, AppError> {
    let remote: Box<dyn SyncRemote> = match SyncMode::parse(&get(db, K_MODE)?) {
        SyncMode::Local => return Ok(None),
        SyncMode::Folder => {
            let folder = get(db, K_FOLDER)?;
            if folder.is_empty() {
                return Err(AppError::Validation("请先选择网盘里的同步文件夹".into()));
            }
            Box::new(FolderRemote::new(&folder)?)
        }
        SyncMode::Webdav => Box::new(WebDavRemote::new(
            &get(db, K_WEBDAV_URL)?,
            &get(db, K_WEBDAV_USER)?,
            &get(db, S_WEBDAV_PASSWORD)?,
        )?),
        SyncMode::Server => Box::new(ServerRemote::new(&get(db, K_SERVER_URL)?, &get(db, S_SERVER_TOKEN)?)?),
        SyncMode::Official => Box::new(ServerRemote::new(official_server_url(), &get(db, S_OFFICIAL_TOKEN)?)?),
    };
    Ok(Some(remote))
}

/// 立即同步一次；结果（或错误）记录在设置里，供界面显示
pub fn sync_now(db: &Database) -> Result<Option<SyncReport>, AppError> {
    let result = (|| -> Result<Option<SyncReport>, AppError> {
        let Some(remote) = build_remote(db)? else { return Ok(None) };
        let passphrase = get(db, S_PASSPHRASE)?;
        let device = device_name();
        let report = run_sync(
            db,
            remote.as_ref(),
            &SyncOptions { passphrase: if passphrase.is_empty() { None } else { Some(&passphrase) }, device: &device },
        )?;
        Ok(Some(report))
    })();
    match &result {
        Ok(Some(report)) => {
            db.set_setting(K_LAST_AT, &now_iso())?;
            db.set_setting(K_LAST_REPORT, &serde_json::to_string(report)?)?;
            db.delete_setting(K_LAST_ERROR)?;
        }
        Ok(None) => {}
        Err(e) => {
            db.set_setting(K_LAST_ERROR, &e.to_string().replace("Validation error: ", ""))?;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_hidden_and_config_roundtrips() {
        let db = Database::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("xynote-sync-cfg-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let view = save_config(
            &db,
            SyncConfigInput {
                mode: Some(SyncMode::Folder),
                folder: Some(dir.to_string_lossy().into_owned()),
                webdav_password: Some("dav-secret".into()),
                passphrase: Some("my pass".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(view.mode, SyncMode::Folder);
        assert!(view.has_webdav_password && view.has_passphrase);
        let all = db.get_settings().unwrap();
        assert!(all.keys().all(|k| !k.starts_with(SECRET_PREFIX)), "密钥类设置不能返回给界面");
        assert!(all.values().all(|v| v != "dav-secret" && v != "my pass"));

        let report = sync_now(&db).unwrap().expect("folder mode syncs");
        assert!(report.encrypted);
        assert!(load_view(&db).unwrap().last_report.is_some());

        // 清除同步密码
        let view = save_config(&db, SyncConfigInput { passphrase: Some(String::new()), ..Default::default() }).unwrap();
        assert!(!view.has_passphrase);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn local_mode_does_nothing() {
        let db = Database::open_in_memory().unwrap();
        assert!(sync_now(&db).unwrap().is_none());
    }
}
