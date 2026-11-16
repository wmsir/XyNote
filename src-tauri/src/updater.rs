//! 检查更新：读取 GitHub 上最新发布的版本，和当前版本比较，并挑出适合本机的安装包。
//!
//! 可以用环境变量 XYNOTE_UPDATE_URL 换成镜像地址（返回与 GitHub releases/latest 相同格式的 JSON）。

use crate::models::AppError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_URL: &str = "https://api.github.com/repos/wmsir/XyNote/releases/latest";
pub const RELEASES_PAGE: &str = "https://github.com/wmsir/XyNote/releases";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub notes: String,
    pub published_at: String,
    /// 发布页面
    pub release_url: String,
    /// 适合本机的安装包（找不到时为空，打开发布页面）
    pub asset_url: String,
    pub asset_name: String,
    pub asset_size: u64,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// 版本号转成可比较的数字：v1.2.3 → (1,2,3)；无法识别的部分当 0
pub fn parse_version(v: &str) -> (u64, u64, u64) {
    let core = v.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next().unwrap_or("");
    let mut it = core.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// 按系统挑安装包：Windows 安装版 → MSI → 便携版；macOS 按芯片选 dmg；Linux 优先 AppImage
pub fn pick_asset<'a>(names: &'a [String], os: &str, arch: &str) -> Option<&'a String> {
    let find = |pred: &dyn Fn(&str) -> bool| names.iter().find(|n| pred(&n.to_lowercase()));
    match os {
        "windows" => find(&|n| n.ends_with("-setup.exe"))
            .or_else(|| find(&|n| n.ends_with(".msi")))
            .or_else(|| find(&|n| n.ends_with(".exe"))),
        "macos" => {
            let want = if arch == "aarch64" { "aarch64" } else { "x64" };
            find(&|n| n.ends_with(".dmg") && n.contains(want)).or_else(|| find(&|n| n.ends_with(".dmg")))
        }
        _ => find(&|n| n.ends_with(".appimage"))
            .or_else(|| find(&|n| n.ends_with(".deb")))
            .or_else(|| find(&|n| n.ends_with(".rpm"))),
    }
}

fn build_info(rel: GhRelease, current: &str) -> UpdateInfo {
    let names: Vec<String> = rel.assets.iter().map(|a| a.name.clone()).collect();
    let picked = pick_asset(&names, std::env::consts::OS, std::env::consts::ARCH)
        .and_then(|n| rel.assets.iter().find(|a| &a.name == n));
    let latest = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    UpdateInfo {
        current_version: current.to_string(),
        has_update: is_newer(&latest, current),
        latest_version: latest,
        notes: rel.body.unwrap_or_default().trim().to_string(),
        published_at: rel.published_at.unwrap_or_default(),
        release_url: rel.html_url.unwrap_or_else(|| RELEASES_PAGE.to_string()),
        asset_url: picked.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        asset_name: picked.map(|a| a.name.clone()).unwrap_or_default(),
        asset_size: picked.map(|a| a.size).unwrap_or(0),
    }
}

pub fn check() -> Result<UpdateInfo, AppError> {
    let current = env!("CARGO_PKG_VERSION");
    let url = std::env::var("XYNOTE_UPDATE_URL").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string());
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .build();
    let resp = agent
        .get(&url)
        .set("User-Agent", &format!("XyNote/{}", current))
        .set("Accept", "application/vnd.github+json")
        .call();
    let text = match resp {
        Ok(r) => r.into_string().map_err(|e| AppError::Validation(format!("读取更新信息失败：{}", e)))?,
        Err(ureq::Error::Status(403, _)) | Err(ureq::Error::Status(429, _)) => {
            return Err(AppError::Validation("检查太频繁，请稍后再试".into()));
        }
        Err(ureq::Error::Status(code, _)) => return Err(AppError::Validation(format!("更新服务器返回错误（{}）", code))),
        Err(_) => return Err(AppError::Validation("连不上更新服务器，请检查网络后再试".into())),
    };
    let rel: GhRelease = serde_json::from_str(&text).map_err(|_| AppError::Validation("更新信息格式不对".into()))?;
    if rel.draft || rel.prerelease {
        return Ok(UpdateInfo {
            current_version: current.into(),
            latest_version: current.into(),
            has_update: false,
            notes: String::new(),
            published_at: String::new(),
            release_url: RELEASES_PAGE.into(),
            asset_url: String::new(),
            asset_name: String::new(),
            asset_size: 0,
        });
    }
    Ok(build_info(rel, current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(is_newer("v0.7.0", "0.6.1"));
        assert!(is_newer("0.6.10", "0.6.9"));
        assert!(!is_newer("v0.6.1", "0.6.1"));
        assert!(!is_newer("0.5.9", "0.6.0"));
        assert_eq!(parse_version("v1.2.3-beta.1"), (1, 2, 3));
    }

    #[test]
    fn picks_asset_per_platform() {
        let names: Vec<String> = [
            "SHA256SUMS.txt",
            "XyNote-0.6.1-1.x86_64.rpm",
            "XyNote-0.6.1-windows-x64-portable.exe",
            "XyNote_0.6.1_aarch64-macos-arm64.dmg",
            "XyNote_0.6.1_amd64.AppImage",
            "XyNote_0.6.1_amd64.deb",
            "XyNote_0.6.1_x64-macos-x64.dmg",
            "XyNote_0.6.1_x64-setup.exe",
            "XyNote_0.6.1_x64_en-US.msi",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(pick_asset(&names, "windows", "x86_64").unwrap(), "XyNote_0.6.1_x64-setup.exe");
        assert_eq!(pick_asset(&names, "macos", "aarch64").unwrap(), "XyNote_0.6.1_aarch64-macos-arm64.dmg");
        assert_eq!(pick_asset(&names, "macos", "x86_64").unwrap(), "XyNote_0.6.1_x64-macos-x64.dmg");
        assert_eq!(pick_asset(&names, "linux", "x86_64").unwrap(), "XyNote_0.6.1_amd64.AppImage");
    }

    #[test]
    fn builds_info_from_release_json() {
        let json = r#"{"tag_name":"v9.0.0","body":"新功能","html_url":"https://github.com/wmsir/XyNote/releases/tag/v9.0.0","published_at":"2026-11-16T00:00:00Z","assets":[{"name":"XyNote_9.0.0_x64-setup.exe","browser_download_url":"https://x/setup.exe","size":10},{"name":"XyNote_9.0.0_amd64.AppImage","browser_download_url":"https://x/a.AppImage","size":20},{"name":"XyNote_9.0.0_aarch64-macos-arm64.dmg","browser_download_url":"https://x/a.dmg","size":30},{"name":"XyNote_9.0.0_x64-macos-x64.dmg","browser_download_url":"https://x/b.dmg","size":30}]}"#;
        let info = build_info(serde_json::from_str(json).unwrap(), "0.6.1");
        assert!(info.has_update);
        assert_eq!(info.latest_version, "9.0.0");
        assert_eq!(info.notes, "新功能");
        assert!(!info.asset_url.is_empty(), "每个平台都应选到安装包");
    }
}
