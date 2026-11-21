//! 同步远端的三种实现：
//! - `FolderRemote`：网盘客户端同步的本地文件夹（坚果云、OneDrive、iCloud Drive、Dropbox、百度网盘同步盘等）；
//! - `WebDavRemote`：WebDAV（坚果云、Nextcloud、群晖、alist 等），也可用于自建；
//! - `ServerRemote`：XyNote 同步服务器（自建部署或官方付费服务，协议相同）。
//!
//! 三者都只提供「列出 / 读 / 写 / 删」，具体的合并逻辑在 sync.rs。

use crate::models::AppError;
use crate::sync::SyncRemote;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

/// 所有远端统一放在这个子目录 / 集合里，避免和用户自己的文件混在一起
pub const REMOTE_ROOT_DIR: &str = "XyNoteSync";

fn net_err(e: impl std::fmt::Display) -> AppError {
    AppError::Validation(format!("网络请求失败：{}", e))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
}

/// 只编码 URL 路径中需要编码的字符（保留 / 分隔符）
pub fn encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn decode_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_body(resp: ureq::Response) -> Result<Vec<u8>, AppError> {
    let mut buf = Vec::new();
    resp.into_reader()
        .take(200 * 1024 * 1024)
        .read_to_end(&mut buf)
        .map_err(net_err)?;
    Ok(buf)
}

/* ------------------------------------------------------------------ */
/* 网盘文件夹                                                          */
/* ------------------------------------------------------------------ */

pub struct FolderRemote {
    root: PathBuf,
}

impl FolderRemote {
    pub fn new(folder: &str) -> Result<Self, AppError> {
        let base = PathBuf::from(crate::win_dialogs::normalize_win32_path_str(folder));
        if !base.is_dir() {
            return Err(AppError::NotFound(format!("同步文件夹不存在：{}", base.display())));
        }
        let root = base.join(REMOTE_ROOT_DIR);
        std::fs::create_dir_all(root.join("pages"))?;
        Ok(Self { root })
    }

    fn path_of(&self, key: &str) -> Result<PathBuf, AppError> {
        if key.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
            return Err(AppError::Validation("非法的同步文件名".into()));
        }
        Ok(key.split('/').fold(self.root.clone(), |p, seg| p.join(seg)))
    }
}

impl SyncRemote for FolderRemote {
    fn list(&self, prefix: &str) -> Result<Vec<String>, AppError> {
        let dir = self.path_of(prefix.trim_end_matches('/'))?;
        let mut out = Vec::new();
        let Ok(read) = std::fs::read_dir(&dir) else { return Ok(out) };
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            // 跳过写到一半的临时文件和网盘客户端的占位文件
            if name.starts_with('.') || name.contains(".tmp-") || !name.ends_with(".json") {
                continue;
            }
            if item.path().is_file() {
                out.push(format!("{}{}", prefix, name));
            }
        }
        Ok(out)
    }

    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        let path = self.path_of(key)?;
        match std::fs::read(&path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        let path = self.path_of(key)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 先写临时文件再改名：网盘客户端不会同步到写了一半的文件
        let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AppError::from(e)
        })
    }

    fn remove(&self, key: &str) -> Result<(), AppError> {
        let path = self.path_of(key)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/* ------------------------------------------------------------------ */
/* WebDAV                                                              */
/* ------------------------------------------------------------------ */

pub struct WebDavRemote {
    /// 以 / 结尾的根集合地址：<用户填写的地址>/XyNoteSync/
    root: String,
    auth: String,
    agent: ureq::Agent,
}

impl WebDavRemote {
    pub fn new(url: &str, username: &str, password: &str) -> Result<Self, AppError> {
        let base = url.trim();
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            return Err(AppError::Validation("WebDAV 地址需要以 https:// 开头".into()));
        }
        let base = if base.ends_with('/') { base.to_string() } else { format!("{}/", base) };
        let auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", username, password))
        );
        let remote = Self { root: format!("{}{}/", base, REMOTE_ROOT_DIR), auth, agent: agent() };
        remote.ensure_collection(&remote.root)?;
        remote.ensure_collection(&format!("{}pages/", remote.root))?;
        Ok(remote)
    }

    fn url_of(&self, key: &str) -> String {
        format!("{}{}", self.root, encode_path(key))
    }

    fn check(&self, res: Result<ureq::Response, ureq::Error>, ok_404: bool) -> Result<Option<ureq::Response>, AppError> {
        match res {
            Ok(r) => Ok(Some(r)),
            Err(ureq::Error::Status(404, _)) if ok_404 => Ok(None),
            Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
                Err(AppError::Validation("WebDAV 用户名或密码不正确（坚果云请使用「应用密码」）".into()))
            }
            Err(ureq::Error::Status(507, _)) => Err(AppError::Validation("网盘空间不足".into())),
            Err(ureq::Error::Status(code, _)) => Err(AppError::Validation(format!("WebDAV 返回错误 {}", code))),
            Err(e) => Err(net_err(e)),
        }
    }

    fn ensure_collection(&self, url: &str) -> Result<(), AppError> {
        let res = self.agent.request("MKCOL", url).set("Authorization", &self.auth).call();
        match res {
            Ok(_) => Ok(()),
            // 405 / 409：已存在（不同服务器返回不同状态码）
            Err(ureq::Error::Status(405, _)) | Err(ureq::Error::Status(409, _)) | Err(ureq::Error::Status(301, _)) => Ok(()),
            other => self.check(other, false).map(|_| ()),
        }
    }
}

/// 从 PROPFIND 的响应里取出所有 href（不依赖命名空间前缀）
pub fn parse_propfind_hrefs(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = xml.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(start) = lower[pos..].find("href>") {
        let open_end = pos + start + "href>".len();
        // 必须是开始标签 <xxx:href> 或 <href>
        let before = &lower[..pos + start];
        let is_open = before.ends_with('<') || before.rfind('<').map(|i| !before[i..].contains('/') && !before[i..].contains('>')).unwrap_or(false);
        if let Some(end) = lower[open_end..].find("</") {
            if is_open {
                out.push(xml[open_end..open_end + end].trim().to_string());
            }
            pos = open_end + end;
        } else {
            break;
        }
    }
    out
}

impl SyncRemote for WebDavRemote {
    fn list(&self, prefix: &str) -> Result<Vec<String>, AppError> {
        let url = self.url_of(prefix);
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#;
        let res = self
            .agent
            .request("PROPFIND", &url)
            .set("Authorization", &self.auth)
            .set("Depth", "1")
            .set("Content-Type", "application/xml; charset=utf-8")
            .send_string(body);
        let Some(resp) = self.check(res, true)? else { return Ok(Vec::new()) };
        let xml = String::from_utf8_lossy(&read_body(resp)?).into_owned();
        let mut out = Vec::new();
        for href in parse_propfind_hrefs(&xml) {
            let decoded = decode_path(&href);
            let name = decoded.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            if decoded.ends_with('/') || !name.ends_with(".json") {
                continue;
            }
            out.push(format!("{}{}", prefix, name));
        }
        Ok(out)
    }

    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        let res = self.agent.get(&self.url_of(key)).set("Authorization", &self.auth).call();
        match self.check(res, true)? {
            Some(r) => Ok(Some(read_body(r)?)),
            None => Ok(None),
        }
    }

    fn write(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        let res = self
            .agent
            .put(&self.url_of(key))
            .set("Authorization", &self.auth)
            .set("Content-Type", "application/octet-stream")
            .send_bytes(data);
        self.check(res, false).map(|_| ())
    }

    fn remove(&self, key: &str) -> Result<(), AppError> {
        let res = self.agent.delete(&self.url_of(key)).set("Authorization", &self.auth).call();
        self.check(res, true).map(|_| ())
    }
}

/* ------------------------------------------------------------------ */
/* XyNote 同步服务器（自建 / 官方）                                      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub email: String,
    /// free / pro 等，由服务器决定
    pub plan: String,
    pub plan_expires_at: Option<String>,
    pub quota_bytes: u64,
    pub used_bytes: u64,
    /// 该服务器是否要求有效订阅才能同步（官方服务为 true，自建默认 false）
    pub requires_subscription: bool,
    pub subscription_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub token: String,
    pub account: AccountInfo,
}

#[derive(Debug, Deserialize)]
struct FileListResponse {
    files: Vec<FileItem>,
}

#[derive(Debug, Deserialize)]
struct FileItem {
    key: String,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    message: String,
}

pub struct ServerRemote {
    base: String,
    token: String,
    agent: ureq::Agent,
}

fn server_base(url: &str) -> Result<String, AppError> {
    let base = url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(AppError::Validation("服务器地址需要以 https:// 开头".into()));
    }
    Ok(base.to_string())
}

fn server_error(res: Result<ureq::Response, ureq::Error>, ok_404: bool) -> Result<Option<ureq::Response>, AppError> {
    match res {
        Ok(r) => Ok(Some(r)),
        Err(ureq::Error::Status(404, _)) if ok_404 => Ok(None),
        Err(ureq::Error::Status(code, resp)) => {
            let msg = resp
                .into_string()
                .ok()
                .and_then(|t| serde_json::from_str::<ErrorBody>(&t).ok())
                .map(|b| b.message)
                .filter(|m| !m.is_empty());
            Err(AppError::Validation(match code {
                401 => "登录已失效，请重新登录".to_string(),
                402 => msg.unwrap_or_else(|| "云同步需要有效的订阅".to_string()),
                413 => msg.unwrap_or_else(|| "云端空间已用完".to_string()),
                _ => msg.unwrap_or_else(|| format!("服务器返回错误 {}", code)),
            }))
        }
        Err(e) => Err(net_err(e)),
    }
}

impl ServerRemote {
    pub fn new(url: &str, token: &str) -> Result<Self, AppError> {
        if token.trim().is_empty() {
            return Err(AppError::Validation("请先登录同步服务器".into()));
        }
        Ok(Self { base: server_base(url)?, token: token.trim().to_string(), agent: agent() })
    }

    fn file_url(&self, key: &str) -> String {
        format!("{}/api/v1/files/{}", self.base, encode_path(key))
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub fn account(&self) -> Result<AccountInfo, AppError> {
        let url = format!("{}{}", self.base, crate::obf!("/api/v1/account"));
        let res = crate::security::send_signed_ureq(&self.agent, "GET", &url, Some(&self.bearer()), None, None);
        let resp = server_error(res, false)?.expect("non-404");
        serde_json::from_slice(&read_body(resp)?).map_err(|_| AppError::Validation("服务器返回的数据无法识别".into()))
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn json_call(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, AppError> {
        let url = format!("{}{}", self.base, path);
        let payload = body.map(|b| b.to_string());
        let res = crate::security::send_signed_ureq(
            &self.agent,
            method,
            &url,
            Some(&self.bearer()),
            payload.as_ref().map(|_| "application/json"),
            payload.as_ref().map(|p| p.as_bytes()),
        );
        let resp = server_error(res, false)?.expect("non-404");
        serde_json::from_slice(&read_body(resp)?).map_err(|_| AppError::Validation("服务器返回的数据无法识别".into()))
    }

    /// 发布或更新网页，返回 (slug, 完整网址)
    pub fn publish(&self, slug: Option<&str>, title: &str, html: &str) -> Result<(String, String), AppError> {
        let v = self.json_call(
            "POST",
            "/api/v1/publish",
            Some(serde_json::json!({ "slug": slug, "title": title, "html": html })),
        )
        .map_err(|e| match e {
            AppError::Validation(m) if m.contains("404") => {
                AppError::Validation("同步服务器版本太旧，不支持发布网页，请先升级服务器".into())
            }
            other => other,
        })?;
        let slug = v["slug"].as_str().unwrap_or_default().to_string();
        let path = v["path"].as_str().unwrap_or_default().to_string();
        Ok((slug, format!("{}{}", self.base, path)))
    }

    pub fn unpublish(&self, slug: &str) -> Result<(), AppError> {
        self.json_call("DELETE", &format!("/api/v1/publish/{}", encode_path(slug)), None).map(|_| ())
    }

    /// 手机随手记里还没同步到电脑的内容
    pub fn inbox_list(&self) -> Result<Vec<(i64, String)>, AppError> {
        let v = self.json_call("GET", "/api/v1/inbox", None)?;
        Ok(v["items"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|it| Some((it["id"].as_i64()?, it["text"].as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn inbox_delete(&self, id: i64) -> Result<(), AppError> {
        self.json_call("DELETE", &format!("/api/v1/inbox/{}", id), None).map(|_| ())
    }

    /// 兑换激活码（在官网购买），返回兑换后的账号信息
    pub fn redeem(&self, code: &str) -> Result<AccountInfo, AppError> {
        let url = format!("{}{}", self.base, crate::obf!("/api/v1/redeem"));
        let body = serde_json::json!({ "code": code.trim() }).to_string();
        let res = crate::security::send_signed_ureq(
            &self.agent,
            "POST",
            &url,
            Some(&self.bearer()),
            Some("application/json"),
            Some(body.as_bytes()),
        );
        let resp = server_error(res, false)?.expect("non-404");
        serde_json::from_slice(&read_body(resp)?).map_err(|_| AppError::Validation("服务器返回的数据无法识别".into()))
    }
}

/// 注册或登录（action = "register" | "login"）
pub fn server_auth(url: &str, action: &str, email: &str, password: &str) -> Result<AuthResponse, AppError> {
    let base = server_base(url)?;
    let endpoint = if action == "register" {
        crate::obf!("/api/v1/auth/register")
    } else {
        crate::obf!("/api/v1/auth/login")
    };
    let full_url = format!("{}{}", base, endpoint);
    let body = serde_json::json!({ "email": email.trim(), "password": password }).to_string();
    let res = crate::security::send_signed_ureq(
        &agent(),
        "POST",
        &full_url,
        None,
        Some("application/json"),
        Some(body.as_bytes()),
    );
    let resp = server_error(res, false)?.expect("non-404");
    serde_json::from_slice(&read_body(resp)?).map_err(|_| AppError::Validation("服务器返回的数据无法识别".into()))
}

impl SyncRemote for ServerRemote {
    fn list(&self, prefix: &str) -> Result<Vec<String>, AppError> {
        let url = format!(
            "{}{}?prefix={}",
            self.base,
            crate::obf!("/api/v1/files"),
            crate::security::encode_uri_component(prefix)
        );
        let res = crate::security::send_signed_ureq(&self.agent, "GET", &url, Some(&self.bearer()), None, None);
        let resp = server_error(res, false)?.expect("non-404");
        let list: FileListResponse = serde_json::from_slice(&read_body(resp)?)
            .map_err(|_| AppError::Validation("服务器返回的数据无法识别".into()))?;
        Ok(list.files.into_iter().map(|f| f.key).collect())
    }

    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
        let res = crate::security::send_signed_ureq(&self.agent, "GET", &self.file_url(key), Some(&self.bearer()), None, None);
        match server_error(res, true)? {
            Some(r) => Ok(Some(read_body(r)?)),
            None => Ok(None),
        }
    }

    fn write(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
        let res = crate::security::send_signed_ureq(
            &self.agent,
            "PUT",
            &self.file_url(key),
            Some(&self.bearer()),
            Some("application/octet-stream"),
            Some(data),
        );
        server_error(res, false).map(|_| ())
    }

    fn remove(&self, key: &str) -> Result<(), AppError> {
        let res = crate::security::send_signed_ureq(&self.agent, "DELETE", &self.file_url(key), Some(&self.bearer()), None, None);
        server_error(res, true).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::CreatePageInput;
    use crate::sync::{run_sync, SyncOptions};

    /// 端到端：两台设备通过真实的同步服务器同步（CI 中启动服务器并设置 XYNOTE_TEST_SERVER_URL）
    #[test]
    fn server_remote_end_to_end() {
        let Ok(url) = std::env::var("XYNOTE_TEST_SERVER_URL") else { return };
        let email = format!("e2e-{}@example.com", uuid::Uuid::new_v4().simple());
        let reg = server_auth(&url, "register", &email, "password123").unwrap();
        let login = server_auth(&url, "login", &email, "password123").unwrap();
        assert_eq!(reg.account.email, login.account.email);
        let ra = ServerRemote::new(&url, &reg.token).unwrap();
        let rb = ServerRemote::new(&url, &login.token).unwrap();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();
        let p = a.create_page(CreatePageInput { title: Some("服务器同步".into()), ..Default::default() }).unwrap();
        run_sync(&a, &ra, &SyncOptions { passphrase: Some("e2e pass"), device: "A" }).unwrap();
        run_sync(&b, &rb, &SyncOptions { passphrase: Some("e2e pass"), device: "B" }).unwrap();
        assert_eq!(b.get_page_detail(&p.id).unwrap().page.title, "服务器同步");
        let acct = ra.account().unwrap();
        assert!(acct.used_bytes > 0);
        assert!(server_auth(&url, "login", &email, "wrong-password").is_err());
    }

    #[test]
    fn path_encoding_roundtrip() {
        let k = "pages/会议 纪要~ab12.json";
        let enc = encode_path(k);
        assert!(!enc.contains(' '));
        assert_eq!(decode_path(&enc), k);
    }

    #[test]
    fn propfind_hrefs_with_any_prefix() {
        let xml = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
          <D:response><D:href>/dav/XyNoteSync/pages/</D:href></D:response>
          <D:response><D:href>/dav/XyNoteSync/pages/a~1.json</D:href></D:response>
          <response><href>/dav/XyNoteSync/pages/b%20c~2.json</href></response>
        </D:multistatus>"#;
        let hrefs = parse_propfind_hrefs(xml);
        assert_eq!(hrefs.len(), 3);
        assert_eq!(hrefs[1], "/dav/XyNoteSync/pages/a~1.json");
    }

    #[test]
    fn folder_remote_syncs_two_workspaces() {
        let dir = std::env::temp_dir().join(format!("xynote-folder-remote-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let remote = FolderRemote::new(dir.to_str().unwrap()).unwrap();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();
        let p = a.create_page(CreatePageInput { title: Some("网盘里的页面".into()), ..Default::default() }).unwrap();
        run_sync(&a, &remote, &SyncOptions { passphrase: None, device: "A" }).unwrap();
        run_sync(&b, &remote, &SyncOptions { passphrase: None, device: "B" }).unwrap();
        assert!(b.get_page_detail(&p.id).is_ok());
        assert!(dir.join(REMOTE_ROOT_DIR).join("xynote-sync.json").is_file());
        // 网盘客户端产生的冲突副本文件（例如「(1)」后缀）也能被识别并合并
        let pages_dir = dir.join(REMOTE_ROOT_DIR).join("pages");
        let page_prefix = format!("{}~", p.id);
        let original = std::fs::read_dir(&pages_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|f| f.file_name().unwrap().to_string_lossy().starts_with(&page_prefix))
            .unwrap();
        let dup = original.with_file_name(format!("{} (1).json", original.file_stem().unwrap().to_string_lossy()));
        std::fs::copy(&original, &dup).unwrap();
        let r = run_sync(&a, &remote, &SyncOptions { passphrase: None, device: "A" }).unwrap();
        assert_eq!(r.conflicts, 0, "内容相同的重复文件不算冲突");
        let remaining = std::fs::read_dir(&pages_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&page_prefix))
            .count();
        assert_eq!(remaining, 1, "多余的重复文件会被清理");
        std::fs::remove_dir_all(dir).ok();
    }
}
