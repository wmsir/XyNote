//! 侧栏「文件夹」：把磁盘上的文件夹以树形结构挂到侧栏，按需逐层读取。
//!
//! - 只列出子文件夹与笔记文件（.md / .markdown / .mdown / .mkd / .txt），隐藏以「.」开头的条目和常见的依赖 / 构建目录；
//! - 新建、重命名都限定在同一个父目录里，名称不允许带路径分隔符，避免越界写入；
//! - 删除交给系统文件管理器完成（可进回收站），这里不做不可恢复的删除。

use crate::models::AppError;
use crate::win_dialogs::normalize_win32_path_str;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 侧栏里会显示、点击后可直接编辑的文件扩展名
pub const NOTE_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

/// 不展示的目录：依赖、构建产物、版本库等，打开代码仓库时不会被它们淹没
const SKIPPED_DIRS: [&str; 8] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
    "venv",
];

/// 单层目录最多返回的条目数，防止误开超大目录卡住界面
const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 文件扩展名（小写，不含点）；文件夹为空字符串
    pub ext: String,
    pub size: u64,
    /// 最后修改时间（毫秒时间戳）
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub entries: Vec<FolderEntry>,
    /// 条目过多被截断时为 true
    pub truncated: bool,
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_note_file(path: &Path) -> bool {
    NOTE_EXTENSIONS.contains(&ext_of(path).as_str())
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('~') || name.eq_ignore_ascii_case("desktop.ini")
}

fn to_entry(path: &Path) -> Option<FolderEntry> {
    let meta = std::fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(FolderEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.is_dir(),
        ext: if meta.is_dir() { String::new() } else { ext_of(path) },
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms,
    })
}

/// 自然排序用的切分：把「第2章」「第10章」里的数字按数值比较
fn natural_key(name: &str) -> Vec<(u8, u128, String)> {
    let mut out = Vec::new();
    let mut digits = String::new();
    let mut text = String::new();
    for ch in name.chars() {
        if ch.is_ascii_digit() {
            if !text.is_empty() {
                out.push((1, 0, std::mem::take(&mut text)));
            }
            digits.push(ch);
        } else {
            if !digits.is_empty() {
                let n = digits.parse::<u128>().unwrap_or(u128::MAX);
                out.push((0, n, std::mem::take(&mut digits)));
            }
            text.extend(ch.to_lowercase());
        }
    }
    if !digits.is_empty() {
        let n = digits.parse::<u128>().unwrap_or(u128::MAX);
        out.push((0, n, digits));
    }
    if !text.is_empty() {
        out.push((1, 0, text));
    }
    out
}

fn clean_dir(raw: &str) -> Result<PathBuf, AppError> {
    let clean = normalize_win32_path_str(raw);
    if clean.is_empty() {
        return Err(AppError::Validation("文件夹路径为空".into()));
    }
    let path = PathBuf::from(&clean);
    if !path.is_dir() {
        return Err(AppError::NotFound(format!("文件夹不存在或已被移动：{}", clean)));
    }
    Ok(path)
}

/// 列出一个文件夹下的一层内容：子文件夹在前，笔记文件在后，各自按名称自然排序
pub fn list_folder(raw: &str) -> Result<FolderListing, AppError> {
    let dir = clean_dir(raw)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in std::fs::read_dir(&dir)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden_name(&name) {
            continue;
        }
        let path = item.path();
        let Ok(file_type) = item.file_type() else { continue };
        // 符号链接按它指向的目标判断；指向不存在的目标时跳过
        let is_dir = if file_type.is_symlink() { path.is_dir() } else { file_type.is_dir() };
        if is_dir {
            if SKIPPED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                continue;
            }
        } else if !is_note_file(&path) {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(entry) = to_entry(&path) {
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_key(&a.name).cmp(&natural_key(&b.name)))
    });
    Ok(FolderListing {
        path: dir.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// 校验新名称：不能为空、不能含路径分隔符或 Windows 不允许的字符，也不能是「.」「..」
fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim().trim_end_matches('.').trim().to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(AppError::Validation("名称不能为空".into()));
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
    {
        return Err(AppError::Validation(
            "名称不能包含 / \\ : * ? \" < > | 这些字符".into(),
        ));
    }
    if trimmed.chars().count() > 200 {
        return Err(AppError::Validation("名称太长".into()));
    }
    Ok(trimmed)
}

/// 在指定文件夹里新建笔记或子文件夹；重名时自动加序号，返回新条目
pub fn create_entry(parent: &str, name: &str, is_dir: bool) -> Result<FolderEntry, AppError> {
    let parent_dir = clean_dir(parent)?;
    let base = validate_name(name)?;
    let (stem, ext) = if is_dir {
        (base.clone(), String::new())
    } else {
        let p = Path::new(&base);
        if is_note_file(p) {
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(base.clone());
            (stem, ext_of(p))
        } else {
            (base.clone(), "md".to_string())
        }
    };
    let make = |n: usize| -> String {
        let suffix = if n == 0 { String::new() } else { format!(" {}", n + 1) };
        if ext.is_empty() {
            format!("{}{}", stem, suffix)
        } else {
            format!("{}{}.{}", stem, suffix, ext)
        }
    };
    let mut target = parent_dir.join(make(0));
    let mut n = 0;
    while target.exists() {
        n += 1;
        if n > 999 {
            return Err(AppError::Validation("同名条目太多".into()));
        }
        target = parent_dir.join(make(n));
    }
    if is_dir {
        std::fs::create_dir(&target)?;
    } else {
        let title = if n == 0 { stem.clone() } else { format!("{} {}", stem, n + 1) };
        let body = if ext == "txt" { String::new() } else { format!("# {}\n\n", title) };
        std::fs::write(&target, body)?;
    }
    to_entry(&target).ok_or_else(|| AppError::NotFound("新建后无法读取".into()))
}

/// 在原目录内重命名文件或文件夹；笔记文件没写扩展名时保留原扩展名
pub fn rename_entry(path: &str, new_name: &str) -> Result<FolderEntry, AppError> {
    let clean = normalize_win32_path_str(path);
    let src = PathBuf::from(&clean);
    if !src.exists() {
        return Err(AppError::NotFound(format!("条目不存在：{}", clean)));
    }
    let parent = src
        .parent()
        .ok_or_else(|| AppError::Validation("不能重命名磁盘根目录".into()))?
        .to_path_buf();
    let mut name = validate_name(new_name)?;
    if src.is_file() && !is_note_file(Path::new(&name)) {
        let old_ext = ext_of(&src);
        if !old_ext.is_empty() {
            name = format!("{}.{}", name, old_ext);
        }
    }
    let dst = parent.join(&name);
    if dst == src {
        return to_entry(&src).ok_or_else(|| AppError::NotFound("无法读取条目".into()));
    }
    // 只改大小写（Windows / macOS 不区分大小写）时目标「已存在」其实就是自己
    let same_ignoring_case = dst
        .to_string_lossy()
        .eq_ignore_ascii_case(&src.to_string_lossy());
    if dst.exists() && !same_ignoring_case {
        return Err(AppError::Validation(format!("「{}」已存在", name)));
    }
    std::fs::rename(&src, &dst)?;
    to_entry(&dst).ok_or_else(|| AppError::NotFound("重命名后无法读取".into()))
}

/// 把文件或文件夹移动到另一个文件夹（拖拽）；目标已有同名条目时拒绝，不能把文件夹移进它自己里面
pub fn move_entry(path: &str, target_dir: &str) -> Result<FolderEntry, AppError> {
    let src = PathBuf::from(normalize_win32_path_str(path));
    if !src.exists() {
        return Err(AppError::NotFound(format!("条目不存在：{}", src.display())));
    }
    let dest_dir = clean_dir(target_dir)?;
    let name = src
        .file_name()
        .ok_or_else(|| AppError::Validation("不能移动磁盘根目录".into()))?
        .to_owned();
    if src.parent().map(|p| p == dest_dir).unwrap_or(false) {
        return to_entry(&src).ok_or_else(|| AppError::NotFound("无法读取条目".into()));
    }
    if src.is_dir() {
        let src_abs = src.canonicalize()?;
        let dest_abs = dest_dir.canonicalize()?;
        if dest_abs.starts_with(&src_abs) {
            return Err(AppError::Validation("不能把文件夹移动到它自己里面".into()));
        }
    }
    let dst = dest_dir.join(&name);
    if dst.exists() {
        return Err(AppError::Validation(format!(
            "目标文件夹里已有「{}」",
            name.to_string_lossy()
        )));
    }
    if std::fs::rename(&src, &dst).is_err() {
        // 跨磁盘移动时 rename 会失败：文件用复制 + 删除代替
        if src.is_file() {
            std::fs::copy(&src, &dst)?;
            std::fs::remove_file(&src)?;
        } else {
            return Err(AppError::Validation("暂不支持跨磁盘移动文件夹".into()));
        }
    }
    to_entry(&dst).ok_or_else(|| AppError::NotFound("移动后无法读取".into()))
}

/// 移到系统回收站（可恢复），不做永久删除
pub fn trash_entry(path: &str) -> Result<(), AppError> {
    let target = PathBuf::from(normalize_win32_path_str(path));
    if !target.exists() {
        return Err(AppError::NotFound(format!("条目不存在：{}", target.display())));
    }
    trash::delete(&target).map_err(|e| AppError::Validation(format!("无法移到回收站：{}", e)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderSearchHit {
    pub path: String,
    pub name: String,
    /// 所属根文件夹的显示名
    pub root_name: String,
    /// 匹配所在行号（从 1 开始）；只匹配到文件名时为 0
    pub line: usize,
    pub snippet: String,
}

fn snippet_around(line: &str, byte_idx: usize, needle_len: usize) -> String {
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let pos = chars.iter().position(|(i, _)| *i >= byte_idx).unwrap_or(0);
    let start = pos.saturating_sub(24);
    let end = (pos + needle_len + 40).min(chars.len());
    let mut out: String = chars[start..end].iter().map(|(_, c)| *c).collect();
    out = out.trim().to_string();
    if start > 0 {
        out = format!("…{}", out);
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// 在挂载的文件夹里全文搜索笔记（文件名 + 内容，不区分大小写）。
/// 有上限：最多扫描 5000 个文件、单个文件 2MB、总耗时约 1.5 秒、返回 60 条。
pub fn search_notes(roots: &[(String, String)], query: &str) -> Vec<FolderSearchHit> {
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if needle.is_empty() {
        return hits;
    }
    let started = std::time::Instant::now();
    let mut scanned = 0usize;
    for (root_path, root_name) in roots {
        let mut stack = vec![PathBuf::from(normalize_win32_path_str(root_path))];
        while let Some(dir) = stack.pop() {
            if hits.len() >= 60 || scanned >= 5000 || started.elapsed().as_millis() > 1500 {
                return hits;
            }
            let Ok(read) = std::fs::read_dir(&dir) else { continue };
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if is_hidden_name(&name) {
                    continue;
                }
                let path = item.path();
                if path.is_dir() {
                    if !SKIPPED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) {
                        stack.push(path);
                    }
                    continue;
                }
                if !is_note_file(&path) {
                    continue;
                }
                scanned += 1;
                let path_str = path.to_string_lossy().into_owned();
                if name.to_lowercase().contains(&needle) {
                    hits.push(FolderSearchHit {
                        path: path_str.clone(),
                        name: name.clone(),
                        root_name: root_name.clone(),
                        line: 0,
                        snippet: String::new(),
                    });
                }
                let Ok(meta) = item.metadata() else { continue };
                if meta.len() > 2 * 1024 * 1024 {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let text = String::from_utf8_lossy(&bytes);
                for (idx, line) in text.lines().enumerate() {
                    let lower = line.to_lowercase();
                    if let Some(pos) = lower.find(&needle) {
                        // 小写化可能改变字节长度：按比例换回原行位置，只用于截取片段
                        let approx = pos.min(line.len());
                        let approx = (0..=approx).rev().find(|i| line.is_char_boundary(*i)).unwrap_or(0);
                        hits.push(FolderSearchHit {
                            path: path_str.clone(),
                            name: name.clone(),
                            root_name: root_name.clone(),
                            line: idx + 1,
                            snippet: snippet_around(line, approx, needle.chars().count()),
                        });
                        break;
                    }
                }
                if hits.len() >= 60 {
                    return hits;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xynote-folders-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_notes_only_natural_order() {
        let dir = temp_dir("list");
        for f in ["第10章.md", "第2章.md", "readme.MD", "image.png", ".secret.md", "notes.txt"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        for d in ["b-dir", "A-dir", ".git", "node_modules"] {
            std::fs::create_dir(dir.join(d)).unwrap();
        }
        let listing = list_folder(dir.to_str().unwrap()).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["A-dir", "b-dir", "notes.txt", "readme.MD", "第2章.md", "第10章.md"]);
        assert_eq!(listing.entries[3].ext, "md");
        assert!(!listing.truncated);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn create_and_rename_stay_inside_parent() {
        let dir = temp_dir("create");
        let a = create_entry(dir.to_str().unwrap(), "会议纪要", false).unwrap();
        assert_eq!(a.name, "会议纪要.md");
        assert_eq!(std::fs::read_to_string(&a.path).unwrap(), "# 会议纪要\n\n");
        let b = create_entry(dir.to_str().unwrap(), "会议纪要", false).unwrap();
        assert_eq!(b.name, "会议纪要 2.md");
        let sub = create_entry(dir.to_str().unwrap(), "项目", true).unwrap();
        assert!(sub.is_dir);

        assert!(create_entry(dir.to_str().unwrap(), "../逃逸", false).is_err());
        assert!(create_entry(dir.to_str().unwrap(), "  ", true).is_err());

        let renamed = rename_entry(&a.path, "周会").unwrap();
        assert_eq!(renamed.name, "周会.md", "没写扩展名时保留 .md");
        assert!(rename_entry(&renamed.path, "会议纪要 2.md").is_err(), "不能覆盖已有文件");
        assert!(rename_entry(&renamed.path, "sub/x.md").is_err());
        let moved_dir = rename_entry(&sub.path, "项目归档").unwrap();
        assert!(Path::new(&moved_dir.path).is_dir());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn move_and_search_notes() {
        let dir = temp_dir("move");
        let sub = create_entry(dir.to_str().unwrap(), "归档", true).unwrap();
        let note = create_entry(dir.to_str().unwrap(), "周报", false).unwrap();
        std::fs::write(&note.path, "# 周报\n\n本周完成 Rust 文件监听与冲突检测。\n").unwrap();

        let moved = move_entry(&note.path, &sub.path).unwrap();
        assert!(Path::new(&moved.path).is_file());
        assert!(!Path::new(&note.path).exists());
        assert!(move_entry(&sub.path, &sub.path).is_err(), "不能移进自己");

        let roots = vec![(dir.to_string_lossy().into_owned(), "测试".to_string())];
        let hits = search_notes(&roots, "冲突检测");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 3);
        assert!(hits[0].snippet.contains("冲突检测"));
        assert_eq!(hits[0].root_name, "测试");
        let by_name = search_notes(&roots, "周报");
        assert!(by_name.iter().any(|h| h.line == 0));
        assert!(search_notes(&roots, "   ").is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_folder_reports_not_found() {
        let err = list_folder("/definitely/not/here/xynote").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
