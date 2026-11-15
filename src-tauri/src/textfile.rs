//! 文本文件直接编辑（类似 Notepad++）：保留文件原来的编码、BOM 和换行符。
//!
//! - 打开：按 BOM 判断 UTF-8 / UTF-16；没有 BOM 时是合法 UTF-8 就按 UTF-8，否则按 GBK（GB18030）读；
//!   也可以指定编码重新打开；
//! - 编辑器里统一用 \n，保存时换回文件原来（或用户选择）的换行符；
//! - 含 NUL 字节的文件视为二进制，不在编辑器里打开，避免保存时把文件写坏；
//! - 保存带修改时间检查：打开后被其他程序改过时返回 Conflict，不覆盖对方的改动。

use crate::models::AppError;
use crate::win_dialogs::normalize_win32_path_str;
use encoding_rs::{Encoding, GB18030, GBK, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 编辑器能打开的最大文件（字节）
pub const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;

/// 支持的编码，名称同时用于界面显示
pub const ENCODINGS: [&str; 6] = ["UTF-8", "UTF-8 BOM", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextFileDocument {
    pub file_path: String,
    pub file_name: String,
    /// 统一为 \n 的文本内容
    pub content: String,
    /// ENCODINGS 中的一个
    pub encoding: String,
    /// "CRLF" | "LF" | "CR"
    pub line_ending: String,
    pub size: u64,
    pub modified_ms: u64,
    /// 解码时遇到无法识别的字节（已用替换字符代替），保存前需要提醒
    pub had_errors: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextSaveResult {
    pub size: u64,
    pub modified_ms: u64,
}

fn clean_file(raw: &str) -> Result<PathBuf, AppError> {
    let clean = normalize_win32_path_str(raw);
    if clean.is_empty() {
        return Err(AppError::Validation("文件路径为空".into()));
    }
    Ok(PathBuf::from(clean))
}

fn modified_ms(path: &Path) -> u64 {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 前 8KB 里有 NUL 字节且不是 UTF-16 文本时视为二进制
pub fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn detect_line_ending(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let cr = text.matches('\r').count().saturating_sub(crlf);
    let lf = text.matches('\n').count().saturating_sub(crlf);
    if crlf == 0 && lf == 0 && cr == 0 {
        // 没有换行时按系统习惯
        return if cfg!(windows) { "CRLF" } else { "LF" };
    }
    if crlf >= lf && crlf >= cr {
        "CRLF"
    } else if cr > lf {
        "CR"
    } else {
        "LF"
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn encoding_by_name(name: &str) -> Option<&'static Encoding> {
    match name {
        "GBK" => Some(GBK),
        "GB18030" => Some(GB18030),
        "UTF-16 LE" => Some(UTF_16LE),
        "UTF-16 BE" => Some(UTF_16BE),
        _ => None,
    }
}

/// 按编码解码；返回（文本，实际编码名，是否有无法识别的字节）
pub fn decode(bytes: &[u8], forced: Option<&str>) -> (String, String, bool) {
    let forced = forced.filter(|f| ENCODINGS.contains(f));
    match forced {
        Some("UTF-8") | Some("UTF-8 BOM") => {
            let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
            let (text, errors) = match std::str::from_utf8(body) {
                Ok(s) => (s.to_string(), false),
                Err(_) => (String::from_utf8_lossy(body).into_owned(), true),
            };
            let name = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) || forced == Some("UTF-8 BOM") { "UTF-8 BOM" } else { "UTF-8" };
            (text, name.to_string(), errors)
        }
        Some(name) => {
            let enc = encoding_by_name(name).unwrap_or(GB18030);
            let (text, _, errors) = enc.decode(bytes);
            (text.into_owned(), name.to_string(), errors)
        }
        None => {
            if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                return decode(bytes, Some("UTF-8 BOM"));
            }
            if bytes.starts_with(&[0xFF, 0xFE]) {
                return decode(bytes, Some("UTF-16 LE"));
            }
            if bytes.starts_with(&[0xFE, 0xFF]) {
                return decode(bytes, Some("UTF-16 BE"));
            }
            if std::str::from_utf8(bytes).is_ok() {
                return decode(bytes, Some("UTF-8"));
            }
            // 中文 Windows 上常见的 ANSI 文本
            let (text, _, errors) = GBK.decode(bytes);
            if !errors {
                return (text.into_owned(), "GBK".into(), false);
            }
            let (text, _, errors) = GB18030.decode(bytes);
            if !errors {
                return (text.into_owned(), "GB18030".into(), false);
            }
            (String::from_utf8_lossy(bytes).into_owned(), "UTF-8".into(), true)
        }
    }
}

/// 按编码编码；GBK 中无法表示的字符会报错而不是悄悄写成「?」
pub fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, AppError> {
    match encoding {
        "UTF-8" => Ok(text.as_bytes().to_vec()),
        "UTF-8 BOM" => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        "UTF-16 LE" | "UTF-16 BE" => {
            let le = encoding == "UTF-16 LE";
            let mut out = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
            for unit in text.encode_utf16() {
                let b = if le { unit.to_le_bytes() } else { unit.to_be_bytes() };
                out.extend_from_slice(&b);
            }
            Ok(out)
        }
        "GBK" | "GB18030" => {
            let enc = encoding_by_name(encoding).unwrap_or(GB18030);
            let (bytes, _, unmappable) = enc.encode(text);
            if unmappable {
                return Err(AppError::Validation(format!(
                    "文件里有 {} 编码无法保存的字符（例如表情符号），请把编码改为 UTF-8 后再保存",
                    encoding
                )));
            }
            Ok(bytes.into_owned())
        }
        other => Err(AppError::Validation(format!("不支持的编码：{}", other))),
    }
}

fn apply_line_ending(text: &str, line_ending: &str) -> String {
    match line_ending {
        "CRLF" => text.replace('\n', "\r\n"),
        "CR" => text.replace('\n', "\r"),
        _ => text.to_string(),
    }
}

pub fn open_text_file(raw: &str, encoding: Option<&str>) -> Result<TextFileDocument, AppError> {
    let path = clean_file(raw)?;
    let meta = std::fs::metadata(&path).map_err(|_| AppError::NotFound(format!("文件不存在或已被移动：{}", path.display())))?;
    if !meta.is_file() {
        return Err(AppError::Validation("这不是一个文件".into()));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(AppError::Validation(format!(
            "文件太大（{:.1} MB），编辑器最多打开 {} MB 的文件",
            meta.len() as f64 / 1024.0 / 1024.0,
            MAX_TEXT_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(&path)?;
    if encoding.is_none() && looks_binary(&bytes) {
        return Err(AppError::Validation("BINARY: 这是二进制文件，不能用文本方式打开".into()));
    }
    let (text, enc, had_errors) = decode(&bytes, encoding);
    let line_ending = detect_line_ending(&text).to_string();
    Ok(TextFileDocument {
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        file_path: path.to_string_lossy().into_owned(),
        content: normalize_newlines(&text),
        encoding: enc,
        line_ending,
        size: meta.len(),
        modified_ms: modified_ms(&path),
        had_errors,
    })
}

/// 保存；expected_modified_ms 为 Some 且与磁盘上的不同时返回 Conflict（携带当前修改时间）
pub fn save_text_file(
    raw: &str,
    content: &str,
    encoding: &str,
    line_ending: &str,
    expected_modified_ms: Option<u64>,
) -> Result<TextSaveResult, AppError> {
    let path = clean_file(raw)?;
    if let Some(expected) = expected_modified_ms.filter(|v| *v > 0) {
        if path.exists() {
            let current = modified_ms(&path);
            if current != expected {
                return Err(AppError::Conflict(current.to_string()));
            }
        }
    }
    let bytes = encode(&apply_line_ending(&normalize_newlines(content), line_ending), encoding)?;
    // 先写临时文件再替换，避免写到一半断电把文件写坏
    let tmp = path.with_file_name(format!(
        ".{}.xynote-tmp",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
    ));
    std::fs::write(&tmp, &bytes)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // 某些网络盘不支持替换：退回直接写入
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&path, &bytes).map_err(|_| e)?;
    }
    Ok(TextSaveResult { size: bytes.len() as u64, modified_ms: modified_ms(&path) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("xynote-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn utf8_crlf_roundtrip_keeps_line_endings() {
        let d = tmpdir();
        let p = d.join("a.txt");
        std::fs::write(&p, b"one\r\ntwo\r\n").unwrap();
        let doc = open_text_file(p.to_str().unwrap(), None).unwrap();
        assert_eq!(doc.content, "one\ntwo\n");
        assert_eq!(doc.encoding, "UTF-8");
        assert_eq!(doc.line_ending, "CRLF");
        save_text_file(p.to_str().unwrap(), "one\ntwo\nthree\n", &doc.encoding, &doc.line_ending, Some(doc.modified_ms)).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"one\r\ntwo\r\nthree\r\n");
    }

    #[test]
    fn gbk_file_is_detected_and_saved_back_as_gbk() {
        let d = tmpdir();
        let p = d.join("gbk.txt");
        let (bytes, _, _) = GBK.encode("中文记事本\n");
        std::fs::write(&p, &bytes).unwrap();
        let doc = open_text_file(p.to_str().unwrap(), None).unwrap();
        assert_eq!(doc.encoding, "GBK");
        assert_eq!(doc.content, "中文记事本\n");
        save_text_file(p.to_str().unwrap(), "中文记事本，改过\n", "GBK", "LF", None).unwrap();
        let saved = std::fs::read(&p).unwrap();
        let (text, _, _) = GBK.decode(&saved);
        assert_eq!(text, "中文记事本，改过\n");
        assert!(save_text_file(p.to_str().unwrap(), "😀", "GBK", "LF", None).is_err());
    }

    #[test]
    fn bom_and_utf16_and_binary() {
        let d = tmpdir();
        let p = d.join("bom.txt");
        std::fs::write(&p, b"\xEF\xBB\xBFhi").unwrap();
        let doc = open_text_file(p.to_str().unwrap(), None).unwrap();
        assert_eq!((doc.encoding.as_str(), doc.content.as_str()), ("UTF-8 BOM", "hi"));
        save_text_file(p.to_str().unwrap(), "hey", "UTF-8 BOM", "LF", None).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"\xEF\xBB\xBFhey");

        let p16 = d.join("u16.txt");
        std::fs::write(&p16, encode("你好\n", "UTF-16 LE").unwrap()).unwrap();
        let doc = open_text_file(p16.to_str().unwrap(), None).unwrap();
        assert_eq!((doc.encoding.as_str(), doc.content.as_str()), ("UTF-16 LE", "你好\n"));

        let bin = d.join("x.bin");
        std::fs::write(&bin, [0x50u8, 0x4B, 0x03, 0x04, 0x00, 0x00]).unwrap();
        let err = open_text_file(bin.to_str().unwrap(), None).unwrap_err().to_string();
        assert!(err.contains("BINARY"), "{}", err);
    }

    #[test]
    fn save_detects_external_change() {
        let d = tmpdir();
        let p = d.join("c.txt");
        std::fs::write(&p, b"a").unwrap();
        let doc = open_text_file(p.to_str().unwrap(), None).unwrap();
        let err = save_text_file(p.to_str().unwrap(), "b", "UTF-8", "LF", Some(doc.modified_ms + 5)).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        assert_eq!(std::fs::read(&p).unwrap(), b"a");
    }
}
