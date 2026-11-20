//! 页面附件：文件复制到 数据目录/assets/attachments/，块里只记相对路径；
//! 以及把网页里的远程图片下载成本地图片。

use crate::db::Database;
use crate::models::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 单个附件上限 200 MB
pub const MAX_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024;
/// 远程图片上限 20 MB
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// 相对 assets/ 的路径，如 `attachments/合同-20261121-ab12cd.pdf`
    pub rel_path: String,
    pub file_name: String,
    pub size: u64,
    pub mime: String,
    /// 是图片时给出 data URL，前端直接插入图片块
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data_url: Option<String>,
}

fn attachments_dir(db: &Database) -> Result<PathBuf, AppError> {
    let assets = db
        .assets_dir()?
        .ok_or_else(|| AppError::Validation("还没有设置数据目录，无法保存附件".into()))?;
    let dir = assets.join("attachments");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 去掉 Windows 不允许的字符，避免路径穿越
fn safe_file_name(name: &str) -> String {
    // 不用 Path 取文件名：Linux / macOS 不认 `\` 是分隔符，Windows 又会把 `a:` 当成盘符，
    // 结果各平台不一致。这里两种分隔符都切，取最后一段。
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "附件".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// 同名文件存在时加时间戳，保证不覆盖
fn unique_target(dir: &Path, file_name: &str) -> PathBuf {
    let direct = dir.join(file_name);
    if !direct.exists() {
        return direct;
    }
    let p = Path::new(file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("附件");
    let ext = p.extension().and_then(|s| s.to_str());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let short = &uuid::Uuid::new_v4().simple().to_string()[..6];
    match ext {
        Some(e) => dir.join(format!("{}-{}-{}.{}", stem, stamp, short, e)),
        None => dir.join(format!("{}-{}-{}", stem, stamp, short)),
    }
}

pub fn guess_mime(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn is_inline_image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/svg+xml")
}

fn finish(db: &Database, dir: &Path, target: &Path, file_name: String, bytes: Option<&[u8]>) -> Result<AttachmentInfo, AppError> {
    let size = std::fs::metadata(target)?.len();
    let mime = guess_mime(&file_name).to_string();
    let rel = target
        .strip_prefix(dir.parent().unwrap_or(dir))
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/");
    // 图片直接走现有的图片资源逻辑，返回 data URL
    let image_data_url = if is_inline_image(&mime) && size <= MAX_REMOTE_IMAGE_BYTES {
        let data = match bytes {
            Some(b) => b.to_vec(),
            None => std::fs::read(target)?,
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let saved = db.save_asset_image(&file_name, &b64, &mime)?;
        // 图片已另存到 assets/，附件目录里的副本删掉
        let _ = std::fs::remove_file(target);
        Some(saved.asset_url)
    } else {
        None
    };
    Ok(AttachmentInfo {
        rel_path: rel,
        file_name,
        size,
        mime,
        image_data_url,
    })
}

/// 从磁盘路径复制一个文件作为附件（拖入文件时用）
pub fn attach_from_path(db: &Database, src: &str) -> Result<AttachmentInfo, AppError> {
    let src = Path::new(src);
    let meta = std::fs::metadata(src)?;
    if !meta.is_file() {
        return Err(AppError::Validation("只能添加文件作为附件".into()));
    }
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation("附件不能超过 200 MB".into()));
    }
    let name = safe_file_name(&src.to_string_lossy());
    let dir = attachments_dir(db)?;
    let target = unique_target(&dir, &name);
    std::fs::copy(src, &target)?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&name)
        .to_string();
    finish(db, &dir, &target, file_name, None)
}

/// 保存前端传来的文件内容作为附件（粘贴文件、选择文件时用）
pub fn attach_from_bytes(db: &Database, file_name: &str, data_base64: &str) -> Result<AttachmentInfo, AppError> {
    let payload = data_base64.split_once(',').map(|(_, b)| b).unwrap_or(data_base64);
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload.trim())?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation("附件不能超过 200 MB".into()));
    }
    let name = safe_file_name(file_name);
    let dir = attachments_dir(db)?;
    let target = unique_target(&dir, &name);
    std::fs::write(&target, &bytes)?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&name)
        .to_string();
    finish(db, &dir, &target, file_name, Some(&bytes))
}

/// 附件相对路径 → 绝对路径；拒绝跳出 assets/ 的路径
pub fn resolve(db: &Database, rel_path: &str) -> Result<PathBuf, AppError> {
    let assets = db
        .assets_dir()?
        .ok_or_else(|| AppError::Validation("还没有设置数据目录".into()))?;
    let rel = rel_path.replace('\\', "/");
    if rel.split('/').any(|seg| seg == "..") || Path::new(&rel).is_absolute() {
        return Err(AppError::Validation("附件路径无效".into()));
    }
    let full = assets.join(&rel);
    if !full.exists() {
        return Err(AppError::Validation("附件文件不存在，可能已被移动或删除".into()));
    }
    Ok(full)
}

/// 用系统默认程序打开附件
pub fn open_with_default_app(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(path).spawn();
    res.map(|_| ()).map_err(|e| AppError::Validation(format!("无法打开文件：{}", e)))
}

/// 下载网页上的图片，存成本地图片资源，返回 data URL
pub fn download_remote_image(db: &Database, url: &str) -> Result<String, AppError> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(AppError::Validation("只能下载 http / https 图片".into()));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        )
        .build();
    let resp = agent
        .get(url.trim())
        .set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .call()
        .map_err(|e| AppError::Validation(format!("下载图片失败：{}", e)))?;
    let mime = resp
        .header("Content-Type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(MAX_REMOTE_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::Validation(format!("下载图片失败：{}", e)))?;
    if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
        return Err(AppError::Validation("图片超过 20 MB，保留原链接".into()));
    }
    let mime = if mime.starts_with("image/") { mime } else { sniff_image_mime(&bytes).to_string() };
    if !mime.starts_with("image/") {
        return Err(AppError::Validation("链接不是图片".into()));
    }
    let name = url
        .split(['?', '#'])
        .next()
        .and_then(|u| u.rsplit('/').next())
        .filter(|s| !s.is_empty())
        .unwrap_or("web-image");
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(db.save_asset_image(name, &b64, &mime)?.asset_url)
}

fn sniff_image_mime(b: &[u8]) -> &'static str {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(b"BM") {
        "image/bmp"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names_strip_paths_and_reserved_chars() {
        assert_eq!(safe_file_name("C:\\Users\\a\\合同 v2.pdf"), "合同 v2.pdf");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_file_name("..."), "附件");
    }

    #[test]
    fn mime_guess_and_sniff() {
        assert_eq!(guess_mime("报告.PDF"), "application/pdf");
        assert_eq!(guess_mime("x.unknown"), "application/octet-stream");
        assert_eq!(sniff_image_mime(&[0x89, b'P', b'N', b'G', 0, 0]), "image/png");
        assert_eq!(sniff_image_mime(b"hello"), "application/octet-stream");
    }

    #[test]
    fn unique_target_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("xy-att-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_target(&dir, "a.pdf");
        assert_eq!(first, dir.join("a.pdf"));
        std::fs::write(&first, b"x").unwrap();
        let second = unique_target(&dir, "a.pdf");
        assert_ne!(second, first);
        assert!(second.to_string_lossy().ends_with(".pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 网页剪藏：抓取网页 HTML（按页面声明的编码解码），正文提取在前端完成
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    pub url: String,
    pub html: String,
}

pub fn fetch_web_page(url: &str) -> Result<WebPage, AppError> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(AppError::Validation("请输入以 http:// 或 https:// 开头的网址".into()));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(25))
        .redirects(8)
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        )
        .build();
    let resp = agent
        .get(u)
        .set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .call()
        .map_err(|e| AppError::Validation(format!("打不开这个网页：{}", e)))?;
    let final_url = resp.get_url().to_string();
    let ctype = resp.header("Content-Type").unwrap_or("").to_ascii_lowercase();
    if !ctype.is_empty() && !ctype.contains("html") && !ctype.contains("xml") && !ctype.contains("text/plain") {
        return Err(AppError::Validation("这个链接不是网页".into()));
    }
    let header_charset = ctype
        .split(';')
        .find_map(|p| p.trim().strip_prefix("charset="))
        .map(|s| s.trim_matches('"').to_string());
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(6 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::Validation(format!("读取网页失败：{}", e)))?;
    Ok(WebPage {
        url: final_url,
        html: decode_html(&bytes, header_charset.as_deref()),
    })
}

/// 按 HTTP 头或 <meta charset> 解码，默认 UTF-8
fn decode_html(bytes: &[u8], header_charset: Option<&str>) -> String {
    let sniff = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let meta_charset = sniff.find("charset=").map(|i| {
        sniff[i + 8..]
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect::<String>()
    });
    let label = header_charset
        .map(str::to_string)
        .or(meta_charset)
        .unwrap_or_else(|| "utf-8".into());
    let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = enc.decode(bytes);
    text.into_owned()
}

#[cfg(test)]
mod web_tests {
    use super::*;

    #[test]
    fn decodes_gbk_by_meta_charset() {
        let (gbk, _, _) = encoding_rs::GBK.encode("<meta charset=\"gbk\"><p>中文网页</p>");
        let s = decode_html(&gbk, None);
        assert!(s.contains("中文网页"));
    }

    #[test]
    fn header_charset_wins() {
        let s = decode_html("<p>héllo</p>".as_bytes(), Some("utf-8"));
        assert!(s.contains("héllo"));
    }

    #[test]
    fn rejects_non_http() {
        assert!(fetch_web_page("file:///etc/passwd").is_err());
    }
}
