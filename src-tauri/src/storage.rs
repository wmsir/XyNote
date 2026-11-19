use crate::db::{effective_plain_text, new_id, now_iso, Database, DbInner};
use crate::markdown::{
    derive_markdown_title, export_database_to_csv, export_database_to_markdown,
    export_doc_to_markdown, parse_markdown_to_blocks, sanitize_markdown_filename,
    sanitize_windows_segment, serialize_save_blocks_to_markdown, ParsedBlockDraft,
};
use crate::models::{
    AppError, BackupEntry, Block, ImportedCustomFont, LocalMarkdownDocument, Page, SaveBlockItem,
    SavedAssetResult, StorageConfigInfo, UpdateStorageConfigInput,
};
use crate::win_dialogs::normalize_win32_path_str;
use base64::Engine;
use chrono::{DateTime, Local, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const CONFIG_FILENAME: &str = "xynote-config.json";
const DB_FILENAME: &str = "xynote.db";
const SYNC_MANIFEST_FILENAME: &str = ".xynote-sync-manifest.json";
const DEFAULT_DATA_DIR_NAME: &str = "XyNote-data";
// 早期版本沿用的文件名与目录名：启动时自动改成新名字，老用户无感升级
const LEGACY_CONFIG_FILENAME: &str = "notion-config.json";
const LEGACY_DB_FILENAME: &str = "notion_desktop.db";
const LEGACY_SYNC_MANIFEST_FILENAME: &str = ".notion-sync-manifest.json";
const LEGACY_DATA_DIR_NAME: &str = "data";

/// 新文件不存在而旧文件存在时，把旧文件改成新名字（失败时保持原样，下次再试）
fn migrate_legacy_file(dir: &Path, legacy: &str, current: &str) {
    let old = dir.join(legacy);
    let new = dir.join(current);
    if !new.exists() && old.is_file() {
        let _ = std::fs::rename(&old, &new);
    }
}

/// SQLite 数据库连同 WAL / SHM 旁路文件一起改名
fn migrate_legacy_db(data_dir: &Path) {
    let new = data_dir.join(DB_FILENAME);
    if new.exists() || !data_dir.join(LEGACY_DB_FILENAME).is_file() {
        return;
    }
    for suffix in ["-wal", "-shm"] {
        migrate_legacy_file(
            data_dir,
            &format!("{}{}", LEGACY_DB_FILENAME, suffix),
            &format!("{}{}", DB_FILENAME, suffix),
        );
    }
    migrate_legacy_file(data_dir, LEGACY_DB_FILENAME, DB_FILENAME);
}

/// 旧版默认 `data` 目录升级为见名知意的 `XyNote-data`
fn migrate_legacy_data_dir(base_dir: &Path) {
    let legacy = base_dir.join(LEGACY_DATA_DIR_NAME);
    let current = base_dir.join(DEFAULT_DATA_DIR_NAME);
    if current.exists() || !legacy.is_dir() {
        return;
    }
    let looks_like_xynote_data = legacy.join(DB_FILENAME).is_file()
        || legacy.join(LEGACY_DB_FILENAME).is_file()
        || base_dir.join(CONFIG_FILENAME).is_file();
    if looks_like_xynote_data {
        let _ = std::fs::rename(&legacy, &current);
    }
}
const LAUNCH_BACKUP_MIN_INTERVAL_SECS: u64 = 600; // 10 minutes

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorageConfig {
    pub active_data_dir: String,
    pub markdown_sync_dir: String,
    pub auto_sync_markdown: bool,
    pub image_save_mode: String, // "assets" | "base64"
    pub auto_backup_on_launch: bool,
    pub max_backups: usize,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            active_data_dir: String::new(),
            markdown_sync_dir: String::new(),
            auto_sync_markdown: true,
            image_save_mode: "assets".to_string(),
            auto_backup_on_launch: true,
            max_backups: 10,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ManagedStorage {
    pub config: StorageConfig,
    pub config_file_path: PathBuf,
    pub exe_dir: PathBuf,
    pub default_data_dir: PathBuf,
    pub exe_dir_writable: bool,
}

impl ManagedStorage {
    pub fn active_data_path(&self) -> PathBuf {
        PathBuf::from(&self.config.active_data_dir)
    }

    pub fn db_file_path(&self) -> PathBuf {
        self.active_data_path().join(DB_FILENAME)
    }

    pub fn markdown_sync_path(&self) -> PathBuf {
        PathBuf::from(&self.config.markdown_sync_dir)
    }

    pub fn assets_path(&self) -> PathBuf {
        self.active_data_path().join("assets")
    }

    pub fn backups_path(&self) -> PathBuf {
        self.active_data_path().join("backups")
    }
}

pub fn normalize_path_key(p: &Path) -> String {
    normalize_win32_path_str(&p.to_string_lossy()).to_lowercase()
}

pub(crate) fn clean_display_path(p: &Path) -> String {
    normalize_win32_path_str(&p.to_string_lossy())
}

pub fn probe_dir_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".notion-write-probe-{}", Uuid::new_v4().simple()));
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn ensure_data_subdirs(active_data_dir: &Path, markdown_sync_dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(active_data_dir)?;
    std::fs::create_dir_all(active_data_dir.join("assets"))?;
    std::fs::create_dir_all(active_data_dir.join("backups"))?;
    std::fs::create_dir_all(markdown_sync_dir)?;
    Ok(())
}

fn save_storage_config_file(config_file_path: &Path, cfg: &StorageConfig) -> Result<(), AppError> {
    if let Some(parent) = config_file_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let pretty = serde_json::to_string_pretty(cfg)?;
    std::fs::write(config_file_path, pretty.as_bytes())?;
    Ok(())
}

fn load_or_init_storage_config(
    config_file_path: &Path,
    default_data_dir: &Path,
) -> StorageConfig {
    let default_active = clean_display_path(default_data_dir);
    let default_pages = clean_display_path(&default_data_dir.join("pages"));

    if let Ok(raw) = std::fs::read_to_string(config_file_path) {
        if let Ok(mut parsed) = serde_json::from_str::<StorageConfig>(&raw) {
            if parsed.active_data_dir.trim().is_empty() {
                parsed.active_data_dir = default_active;
            } else {
                parsed.active_data_dir = normalize_win32_path_str(&parsed.active_data_dir);
            }
            if parsed.markdown_sync_dir.trim().is_empty() {
                parsed.markdown_sync_dir =
                    clean_display_path(&PathBuf::from(&parsed.active_data_dir).join("pages"));
            } else {
                parsed.markdown_sync_dir = normalize_win32_path_str(&parsed.markdown_sync_dir);
            }
            if parsed.image_save_mode != "base64" {
                parsed.image_save_mode = "assets".to_string();
            }
            if parsed.max_backups == 0 {
                parsed.max_backups = 10;
            }
            return parsed;
        }
    }

    StorageConfig {
        active_data_dir: default_active,
        markdown_sync_dir: default_pages,
        auto_sync_markdown: true,
        image_save_mode: "assets".to_string(),
        auto_backup_on_launch: true,
        max_backups: 10,
    }
}

/// Snapshot an open SQLite connection cleanly to `dest_db_path` (merging all WAL frames).
fn snapshot_conn_to_file(
    conn: &Connection,
    src_db_fallback: Option<&Path>,
    dest_db_path: &Path,
) -> Result<(), AppError> {
    if let Some(parent) = dest_db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if dest_db_path.exists() {
        let _ = std::fs::remove_file(dest_db_path);
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
    let dest_str = clean_display_path(dest_db_path);
    match conn.execute("VACUUM INTO ?1", params![dest_str]) {
        Ok(_) => Ok(()),
        Err(vac_err) => {
            if let Some(src) = src_db_fallback.filter(|p| p.is_file()) {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                std::fs::copy(src, dest_db_path)?;
                Ok(())
            } else {
                Err(AppError::Sqlite(vac_err))
            }
        }
    }
}

fn snapshot_sqlite_file_on_disk(src_db_path: &Path, dest_db_path: &Path) -> Result<(), AppError> {
    if let Ok(src_conn) = Connection::open(src_db_path) {
        if snapshot_conn_to_file(&src_conn, Some(src_db_path), dest_db_path).is_ok() {
            return Ok(());
        }
    }
    if let Some(parent) = dest_db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src_db_path, dest_db_path)?;
    Ok(())
}

fn remove_wal_sidecars(db_path: &Path) {
    let base = db_path.to_string_lossy();
    let wal = PathBuf::from(format!("{}-wal", base));
    let shm = PathBuf::from(format!("{}-shm", base));
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);
}

fn copy_dir_merge_non_destructive(src_dir: &Path, dst_dir: &Path) -> Result<(), AppError> {
    if !src_dir.is_dir() || normalize_path_key(src_dir) == normalize_path_key(dst_dir) {
        return Ok(());
    }
    std::fs::create_dir_all(dst_dir)?;
    for entry in std::fs::read_dir(src_dir)?.flatten() {
        let src_path = entry.path();
        let Some(name) = src_path.file_name() else {
            continue;
        };
        let dst_path = dst_dir.join(name);
        if src_path.is_dir() {
            copy_dir_merge_non_destructive(&src_path, &dst_path)?;
        } else if src_path.is_file() && !dst_path.exists() {
            let _ = std::fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

fn system_time_to_iso(st: SystemTime) -> String {
    let dt: DateTime<Utc> = st.into();
    dt.to_rfc3339()
}

fn collect_backup_files(backups_dir: &Path) -> Vec<(PathBuf, String, u64, SystemTime)> {
    let mut entries = Vec::new();
    let Ok(rd) = std::fs::read_dir(backups_dir) else {
        return entries;
    };
    for item in rd.flatten() {
        let p = item.path();
        if !p.is_file() {
            continue;
        }
        let Some(fname_os) = p.file_name() else {
            continue;
        };
        let fname = fname_os.to_string_lossy().into_owned();
        if !fname.to_ascii_lowercase().ends_with(".db") {
            continue;
        }
        if let Ok(meta) = p.metadata() {
            let mtime = meta
                .modified()
                .or_else(|_| meta.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((p, fname, meta.len(), mtime));
        }
    }
    // Sort newest first
    entries.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.1.cmp(&a.1)));
    entries
}

fn prune_backups_dir(backups_dir: &Path, max_backups: usize) {
    let keep = max_backups.max(1);
    let all = collect_backup_files(backups_dir);
    if all.len() > keep {
        for (old_path, _, _, _) in &all[keep..] {
            let _ = std::fs::remove_file(old_path);
        }
    }
}

fn create_backup_snapshot_internal(
    conn: &Connection,
    src_db_path: &Path,
    backups_dir: &Path,
    max_backups: usize,
    prefix_tag: Option<&str>,
) -> Result<BackupEntry, AppError> {
    std::fs::create_dir_all(backups_dir)?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let base_stem = match prefix_tag {
        Some(tag) if !tag.is_empty() => format!("backup-{}-{}", tag, stamp),
        _ => format!("backup-{}", stamp),
    };

    let mut filename = format!("{}.db", base_stem);
    let mut full_path = backups_dir.join(&filename);
    let mut seq = 2usize;
    while full_path.exists() {
        filename = format!("{}-{}.db", base_stem, seq);
        full_path = backups_dir.join(&filename);
        seq += 1;
    }

    snapshot_conn_to_file(conn, Some(src_db_path), &full_path)?;
    prune_backups_dir(backups_dir, max_backups);

    let meta = std::fs::metadata(&full_path)?;
    let mtime = meta.modified().unwrap_or_else(|_| SystemTime::now());
    Ok(BackupEntry {
        filename,
        full_path: clean_display_path(&full_path),
        size_bytes: meta.len(),
        created_at: system_time_to_iso(mtime),
    })
}

/* ============================================================================
 * Live `.md` Mirror Sync (`pages/` directory + `.xynote-sync-manifest.json`)
 * ========================================================================== */

fn load_sync_manifest(sync_dir: &Path) -> HashMap<String, String> {
    migrate_legacy_file(sync_dir, LEGACY_SYNC_MANIFEST_FILENAME, SYNC_MANIFEST_FILENAME);
    let manifest_path = sync_dir.join(SYNC_MANIFEST_FILENAME);
    if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&raw) {
            return map;
        }
    }
    HashMap::new()
}

fn save_sync_manifest(sync_dir: &Path, map: &HashMap<String, String>) {
    let manifest_path = sync_dir.join(SYNC_MANIFEST_FILENAME);
    if let Ok(raw) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(manifest_path, raw.as_bytes());
    }
}

fn remove_synced_rel_file_and_empty_parents(sync_dir: &Path, rel_posix: &str) {
    let target = sync_dir.join(rel_posix.replace('/', std::path::MAIN_SEPARATOR_STR));
    if target.is_file() {
        let _ = std::fs::remove_file(&target);
    }
    let mut parent_opt = target.parent();
    let sync_key = normalize_path_key(sync_dir);
    while let Some(parent) = parent_opt {
        if normalize_path_key(parent) == sync_key || !parent.starts_with(sync_dir) {
            break;
        }
        match std::fs::read_dir(parent) {
            Ok(mut rd) => {
                if rd.next().is_none() {
                    let _ = std::fs::remove_dir(parent);
                } else {
                    break;
                }
            }
            Err(_) => break,
        }
        parent_opt = parent.parent();
    }
}

fn query_active_pages_conn(conn: &Connection) -> Result<Vec<Page>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
         FROM pages
         WHERE is_trashed = 0
         ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([], Database::row_to_page)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn compute_page_rel_md_paths(active_pages: &[Page]) -> HashMap<String, String> {
    let page_map: HashMap<&str, &Page> = active_pages.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut used_lower: HashSet<String> = HashSet::new();
    let mut result: HashMap<String, String> = HashMap::with_capacity(active_pages.len());

    for page in active_pages {
        let mut ancestor_segs: Vec<String> = Vec::new();
        let mut visited: HashSet<&str> = HashSet::new();
        visited.insert(page.id.as_str());

        let mut cur_parent = page.parent_id.as_deref().and_then(|pid| page_map.get(pid));
        while let Some(anc) = cur_parent {
            if !visited.insert(anc.id.as_str()) {
                break;
            }
            ancestor_segs.push(sanitize_windows_segment(&anc.title));
            cur_parent = anc.parent_id.as_deref().and_then(|pid| page_map.get(pid));
        }
        ancestor_segs.reverse();

        let dir_prefix = ancestor_segs.join("/");
        let stem = sanitize_windows_segment(&page.title);

        let mut candidate = if dir_prefix.is_empty() {
            format!("{}.md", stem)
        } else {
            format!("{}/{}.md", dir_prefix, stem)
        };
        let mut dup = 2usize;
        while used_lower.contains(&candidate.to_lowercase()) {
            candidate = if dir_prefix.is_empty() {
                format!("{} ({}).md", stem, dup)
            } else {
                format!("{}/{} ({}).md", dir_prefix, stem, dup)
            };
            dup += 1;
        }
        used_lower.insert(candidate.to_lowercase());
        result.insert(page.id.clone(), candidate);
    }

    result
}

fn export_single_page_markdown_conn(conn: &Connection, page: &Page) -> Result<String, AppError> {
    if page.page_type == "database" {
        let db_full = Database::ensure_database_initialized_conn(conn, &page.id)?;
        Ok(export_database_to_markdown(page, &db_full).markdown)
    } else {
        let blocks = Database::get_blocks_for_page_conn(conn, &page.id)?;
        Ok(export_doc_to_markdown(page, &blocks).markdown)
    }
}

pub(crate) fn sync_all_pages_conn(conn: &Connection, sync_dir: &Path) -> Result<usize, AppError> {
    std::fs::create_dir_all(sync_dir)?;
    let prev_manifest = load_sync_manifest(sync_dir);
    let active_pages = query_active_pages_conn(conn)?;
    let rel_map = compute_page_rel_md_paths(&active_pages);

    let mut new_manifest: HashMap<String, String> = HashMap::with_capacity(active_pages.len());
    let mut new_rel_lower_set: HashSet<String> = HashSet::with_capacity(active_pages.len());

    for page in &active_pages {
        if let Some(rel_posix) = rel_map.get(&page.id) {
            let markdown = export_single_page_markdown_conn(conn, page)?;
            let disk_path = sync_dir.join(rel_posix.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = disk_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&disk_path, markdown.as_bytes())?;
            new_rel_lower_set.insert(rel_posix.to_lowercase());
            new_manifest.insert(page.id.clone(), rel_posix.clone());
        }
    }

    // Remove stale `.md` files from renamed, trashed, or deleted pages
    for old_rel in prev_manifest.values() {
        if !new_rel_lower_set.contains(&old_rel.to_lowercase()) {
            remove_synced_rel_file_and_empty_parents(sync_dir, old_rel);
        }
    }

    save_sync_manifest(sync_dir, &new_manifest);
    Ok(active_pages.len())
}

pub(crate) fn sync_single_page_conn(
    conn: &Connection,
    sync_dir: &Path,
    page_id: &str,
) -> Result<(), AppError> {
    std::fs::create_dir_all(sync_dir)?;
    let active_pages = query_active_pages_conn(conn)?;
    let Some(target_page) = active_pages.iter().find(|p| p.id == page_id) else {
        // Page is trashed or deleted -> full manifest sync cleans it up
        let _ = sync_all_pages_conn(conn, sync_dir)?;
        return Ok(());
    };

    let rel_map = compute_page_rel_md_paths(&active_pages);
    let Some(new_rel) = rel_map.get(page_id) else {
        return Ok(());
    };

    let mut manifest = load_sync_manifest(sync_dir);
    if let Some(old_rel) = manifest.get(page_id) {
        if !old_rel.eq_ignore_ascii_case(new_rel) {
            remove_synced_rel_file_and_empty_parents(sync_dir, old_rel);
        }
    }

    let markdown = export_single_page_markdown_conn(conn, target_page)?;
    let disk_path = sync_dir.join(new_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = disk_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&disk_path, markdown.as_bytes())?;

    manifest.insert(page_id.to_string(), new_rel.clone());
    save_sync_manifest(sync_dir, &manifest);
    Ok(())
}

pub(crate) fn after_page_mutated(inner: &DbInner, page_id: &str) {
    if let Some(ref st) = inner.storage {
        if st.config.auto_sync_markdown {
            let _ = sync_single_page_conn(&inner.conn, &st.markdown_sync_path(), page_id);
        }
    }
}

pub(crate) fn after_tree_mutated(inner: &DbInner) {
    if let Some(ref st) = inner.storage {
        if st.config.auto_sync_markdown {
            let _ = sync_all_pages_conn(&inner.conn, &st.markdown_sync_path());
        }
    }
}

/* ============================================================================
 * Standalone Typora Local `.md` File Open / Save / Bidirectional Convert
 * ========================================================================== */

fn drafts_to_blocks(page_id: &str, drafts: Vec<ParsedBlockDraft>, ts: &str) -> Vec<Block> {
    drafts
        .into_iter()
        .enumerate()
        .map(|(idx, d)| Block {
            id: new_id(),
            page_id: page_id.to_string(),
            block_type: d.block_type,
            content: d.content,
            plain_text: d.plain_text,
            props: d.props,
            sort_order: idx as i64,
            created_at: ts.to_string(),
            updated_at: ts.to_string(),
        })
        .collect()
}

fn save_items_to_blocks(page_id: &str, items: Vec<SaveBlockItem>, ts: &str) -> Vec<Block> {
    if items.is_empty() {
        return vec![Block {
            id: new_id(),
            page_id: page_id.to_string(),
            block_type: "paragraph".to_string(),
            content: String::new(),
            plain_text: String::new(),
            props: Default::default(),
            sort_order: 0,
            created_at: ts.to_string(),
            updated_at: ts.to_string(),
        }];
    }
    items
        .into_iter()
        .enumerate()
        .map(|(idx, item)| {
            let id = if item.id.trim().is_empty() {
                new_id()
            } else {
                item.id
            };
            let plain = effective_plain_text(
                &item.block_type,
                &item.content,
                &item.plain_text,
                &item.props,
            );
            let sort_order = if item.sort_order == 0 && idx > 0 {
                idx as i64
            } else {
                item.sort_order
            };
            Block {
                id,
                page_id: page_id.to_string(),
                block_type: item.block_type,
                content: item.content,
                plain_text: plain,
                props: item.props,
                sort_order,
                created_at: ts.to_string(),
                updated_at: ts.to_string(),
            }
        })
        .collect()
}

fn extract_local_file_meta(file_path: &str, markdown: &str) -> (String, String) {
    let norm = normalize_win32_path_str(file_path);
    let p = Path::new(&norm);
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "untitled.md".to_string());
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "无标题".to_string());

    // Prefer leading `# H1` inside markdown if present, else fallback to filename stem
    let derived = derive_markdown_title("", markdown);
    let title = if derived != "导入的 Markdown 页面" {
        derived
    } else {
        stem
    };
    (file_name, title)
}

pub fn open_local_markdown_file_disk(file_path: &str) -> Result<LocalMarkdownDocument, AppError> {
    let clean_path = normalize_win32_path_str(file_path);
    if clean_path.is_empty() {
        return Err(AppError::Validation("File path is empty".into()));
    }
    let path = Path::new(&clean_path);
    if !path.is_file() {
        return Err(AppError::NotFound(format!(
            "Markdown file not found: {}",
            clean_path
        )));
    }

    let raw_bytes = std::fs::read(path)?;
    let decoded = String::from_utf8(raw_bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    let markdown = decoded
        .strip_prefix('\u{feff}')
        .unwrap_or(&decoded)
        .to_string();

    let updated_at = path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_iso)
        .unwrap_or_else(now_iso);

    let page_key = format!("local:{}", clean_path);
    let mut blocks = drafts_to_blocks(&page_key, parse_markdown_to_blocks(&markdown), &updated_at);
    inline_local_images(&mut blocks, &clean_path);
    let (file_name, title) = extract_local_file_meta(&clean_path, &markdown);

    Ok(LocalMarkdownDocument {
        file_path: clean_path,
        file_name,
        title,
        markdown,
        blocks,
        updated_at,
    })
}

pub fn save_local_markdown_file_disk(
    file_path: &str,
    blocks: Option<Vec<SaveBlockItem>>,
    raw_markdown: Option<String>,
) -> Result<LocalMarkdownDocument, AppError> {
    let clean_path = normalize_win32_path_str(file_path);
    if clean_path.is_empty() {
        return Err(AppError::Validation("File path is empty".into()));
    }
    let path = Path::new(&clean_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let ts = now_iso();
    let page_key = format!("local:{}", clean_path);

    let (final_markdown, mut final_blocks) = if let Some(raw_md) = raw_markdown {
        let parsed = drafts_to_blocks(&page_key, parse_markdown_to_blocks(&raw_md), &ts);
        (raw_md, parsed)
    } else if let Some(items) = blocks {
        let serialized = serialize_save_blocks_to_markdown(&items);
        let mapped = save_items_to_blocks(&page_key, items, &ts);
        (serialized, mapped)
    } else {
        (String::new(), save_items_to_blocks(&page_key, Vec::new(), &ts))
    };

    std::fs::write(path, final_markdown.as_bytes())?;
    inline_local_images(&mut final_blocks, &clean_path);
    let updated_at = path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_iso)
        .unwrap_or(ts);

    let (file_name, title) = extract_local_file_meta(&clean_path, &final_markdown);
    Ok(LocalMarkdownDocument {
        file_path: clean_path,
        file_name,
        title,
        markdown: final_markdown,
        blocks: final_blocks,
        updated_at,
    })
}

/// 磁盘笔记里引用的本地图片（相对路径或绝对路径）读成 data URL 用于显示，
/// 原始引用记在 props.local_src，保存时写回，Markdown 文件保持干净可移植。
pub fn inline_local_images(blocks: &mut [Block], note_path: &str) {
    let clean = normalize_win32_path_str(note_path);
    let Some(note_dir) = Path::new(&clean).parent().map(|p| p.to_path_buf()) else {
        return;
    };
    for block in blocks.iter_mut() {
        if block.block_type != "image" {
            continue;
        }
        let raw = block
            .props
            .url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| block.content.trim().to_string());
        let lower = raw.to_ascii_lowercase();
        if raw.is_empty()
            || lower.starts_with("data:")
            || lower.starts_with("http://")
            || lower.starts_with("https://")
        {
            continue;
        }
        let mut rel = raw.trim().trim_start_matches('<').trim_end_matches('>').to_string();
        if let Some(rest) = rel.strip_prefix("file:///") {
            rel = rest.to_string();
        }
        let decoded = percent_decode_simple(&rel);
        let candidate = {
            let p = Path::new(&decoded);
            if p.is_absolute() { p.to_path_buf() } else { note_dir.join(p) }
        };
        let Ok(meta) = candidate.metadata() else { continue };
        if !meta.is_file() || meta.len() > 15 * 1024 * 1024 {
            continue;
        }
        let ext = candidate
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => continue,
        };
        let Ok(bytes) = std::fs::read(&candidate) else { continue };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        block.props.local_src = Some(raw.clone());
        block.props.url = Some(format!("data:{};base64,{}", mime, b64));
    }
}

/// 只处理 Markdown 链接里常见的 %XX 转义（如空格 %20、中文 UTF-8 字节）
fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// 把粘贴到磁盘笔记里的图片保存到「笔记所在目录/assets/」，返回相对路径与用于显示的 data URL
pub fn save_local_note_image_disk(
    note_path: &str,
    filename: &str,
    data_base64: &str,
    mime_type: &str,
) -> Result<LocalNoteImage, AppError> {
    let clean = normalize_win32_path_str(note_path);
    let note_dir = Path::new(&clean)
        .parent()
        .ok_or_else(|| AppError::Validation("无法确定笔记所在目录".into()))?
        .to_path_buf();
    let payload = match data_base64.split_once(',') {
        Some((prefix, rest)) if prefix.contains("base64") => rest,
        _ => data_base64,
    };
    let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&compact))?;
    if bytes.is_empty() {
        return Err(AppError::Validation("图片内容为空".into()));
    }
    let mime = if mime_type.trim().starts_with("image/") { mime_type.trim() } else { "image/png" };
    let ext = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => "png",
    };
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(sanitize_windows_segment)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image".to_string());
    let assets = note_dir.join("assets");
    std::fs::create_dir_all(&assets)?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let mut name = format!("{}-{}.{}", stem, stamp, ext);
    let mut n = 1;
    while assets.join(&name).exists() {
        n += 1;
        name = format!("{}-{}-{}.{}", stem, stamp, n, ext);
    }
    std::fs::write(assets.join(&name), &bytes)?;
    // Markdown 里空格需要转义，否则多数编辑器识别不了链接
    let relative = format!("assets/{}", name.replace(' ', "%20"));
    Ok(LocalNoteImage {
        relative_path: relative,
        file_path: clean_display_path(&assets.join(&name)),
        display_url: format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(&bytes)),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteImage {
    pub relative_path: String,
    pub file_path: String,
    pub display_url: String,
}

/// 读取磁盘文件当前的修改时间（与 LocalMarkdownDocument.updated_at 同一格式）
pub fn local_file_updated_at(file_path: &str) -> Option<String> {
    let clean_path = normalize_win32_path_str(file_path);
    Path::new(&clean_path)
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_iso)
}

/// 带冲突检测的保存：传入打开 / 上次保存时的修改时间，若磁盘上的文件之后被其他程序改过，
/// 返回 AppError::Conflict（携带文件当前的修改时间），不覆盖对方的改动。
/// expected_updated_at 为 None 时直接写入（用户选择「仍然覆盖」或新文件）。
pub fn save_local_markdown_file_checked(
    file_path: &str,
    blocks: Option<Vec<SaveBlockItem>>,
    raw_markdown: Option<String>,
    expected_updated_at: Option<&str>,
) -> Result<LocalMarkdownDocument, AppError> {
    if let Some(expected) = expected_updated_at.filter(|s| !s.is_empty()) {
        if let Some(current) = local_file_updated_at(file_path) {
            if current != expected {
                return Err(AppError::Conflict(current));
            }
        }
    }
    save_local_markdown_file_disk(file_path, blocks, raw_markdown)
}

pub fn convert_markdown_blocks_pure(
    markdown: Option<String>,
    blocks: Option<Vec<SaveBlockItem>>,
    page_id: Option<String>,
) -> Result<LocalMarkdownDocument, AppError> {
    let pid = page_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "preview".to_string());
    let ts = now_iso();

    if let Some(md) = markdown {
        let mut parsed_blocks = drafts_to_blocks(&pid, parse_markdown_to_blocks(&md), &ts);
        // 源码模式切回所见即所得时，磁盘笔记里的相对路径图片同样要能显示
        if let Some(note_path) = pid.strip_prefix("local:") {
            inline_local_images(&mut parsed_blocks, note_path);
        }
        let (file_name, title) = extract_local_file_meta("document.md", &md);
        Ok(LocalMarkdownDocument {
            file_path: String::new(),
            file_name,
            title,
            markdown: md,
            blocks: parsed_blocks,
            updated_at: ts,
        })
    } else {
        let items = blocks.unwrap_or_default();
        let serialized = serialize_save_blocks_to_markdown(&items);
        let (file_name, title) = extract_local_file_meta("document.md", &serialized);
        let mapped = save_items_to_blocks(&pid, items, &ts);
        Ok(LocalMarkdownDocument {
            file_path: String::new(),
            file_name,
            title,
            markdown: serialized,
            blocks: mapped,
            updated_at: ts,
        })
    }
}

/* ============================================================================
 * Portable Storage, Hot-Swap Migration, Backups, Assets & ZIP Export on Database
 * ========================================================================== */

impl Database {
    /// Open portable storage anchored at `exe_dir` (`<exe_dir>\xynote-config.json` and
    /// `<exe_dir>\XyNote-data\`), falling back to `fallback_app_data_dir` only if `exe_dir` is read-only.
    pub fn open_portable(
        exe_dir: &Path,
        fallback_app_data_dir: &Path,
        allow_legacy_appdata_migration: bool,
    ) -> Result<Self, AppError> {
        let exe_dir_writable = probe_dir_writable(exe_dir);
        migrate_legacy_file(exe_dir, LEGACY_CONFIG_FILENAME, CONFIG_FILENAME);
        migrate_legacy_file(fallback_app_data_dir, LEGACY_CONFIG_FILENAME, CONFIG_FILENAME);
        let base_dir = if exe_dir_writable {
            exe_dir
        } else {
            std::fs::create_dir_all(fallback_app_data_dir)?;
            fallback_app_data_dir
        };
        migrate_legacy_data_dir(base_dir);
        let config_file_path = base_dir.join(CONFIG_FILENAME);
        let default_data_dir = base_dir.join(DEFAULT_DATA_DIR_NAME);
        let legacy_data_dir = base_dir.join(LEGACY_DATA_DIR_NAME);

        let mut config = load_or_init_storage_config(&config_file_path, &default_data_dir);
        if default_data_dir.is_dir() && !legacy_data_dir.exists() {
            if normalize_path_key(Path::new(&config.active_data_dir))
                == normalize_path_key(&legacy_data_dir)
            {
                config.active_data_dir = clean_display_path(&default_data_dir);
            }
            if normalize_path_key(Path::new(&config.markdown_sync_dir))
                == normalize_path_key(&legacy_data_dir.join("pages"))
            {
                config.markdown_sync_dir = clean_display_path(&default_data_dir.join("pages"));
            }
        }

        // Ensure configured activeDataDir & markdownSyncDir exist; fall back safely if custom drive unavailable
        if ensure_data_subdirs(
            Path::new(&config.active_data_dir),
            Path::new(&config.markdown_sync_dir),
        )
        .is_err()
        {
            config.active_data_dir = clean_display_path(&default_data_dir);
            config.markdown_sync_dir = clean_display_path(&default_data_dir.join("pages"));
            ensure_data_subdirs(
                Path::new(&config.active_data_dir),
                Path::new(&config.markdown_sync_dir),
            )?;
        }

        // Always persist `xynote-config.json` so portable config is visible in software folder on first launch
        save_storage_config_file(&config_file_path, &config)?;

        // Auto-seed portable `plugins/themes/` (5 themes) & `plugins/snippets/` (5 CSS snippets) on cold-start
        let _ = crate::plugins::ensure_plugins_initialized_on_disk(Path::new(&config.active_data_dir));

        migrate_legacy_db(Path::new(&config.active_data_dir));
        let db_file_path = Path::new(&config.active_data_dir).join(DB_FILENAME);

        // Seamless v0.1.0 upgrade migration from `%APPDATA%\com.meng.notiondesktop\notion_desktop.db`
        if !db_file_path.exists() && allow_legacy_appdata_migration {
            let legacy_db = fallback_app_data_dir.join(LEGACY_DB_FILENAME);
            if legacy_db.is_file()
                && normalize_path_key(&legacy_db) != normalize_path_key(&db_file_path)
            {
                let _ = snapshot_sqlite_file_on_disk(&legacy_db, &db_file_path);
            }
        }

        let conn = Connection::open(&db_file_path)?;
        Self::initialize_conn(&conn, true)?;

        // Auto-backup on launch (if enabled and no backup exists within the last 10 minutes)
        if config.auto_backup_on_launch {
            let backups_dir = Path::new(&config.active_data_dir).join("backups");
            let existing_backups = collect_backup_files(&backups_dir);
            let recent_exists = existing_backups.first().is_some_and(|(_, _, _, mtime)| {
                SystemTime::now()
                    .duration_since(*mtime)
                    .map(|elapsed| elapsed < Duration::from_secs(LAUNCH_BACKUP_MIN_INTERVAL_SECS))
                    .unwrap_or(true)
            });
            if !recent_exists {
                let _ = create_backup_snapshot_internal(
                    &conn,
                    &db_file_path,
                    &backups_dir,
                    config.max_backups,
                    None,
                );
            } else {
                prune_backups_dir(&backups_dir, config.max_backups);
            }
        }

        // Initial `.md` mirror sync if enabled
        if config.auto_sync_markdown {
            let _ = sync_all_pages_conn(&conn, Path::new(&config.markdown_sync_dir));
        }

        let managed = ManagedStorage {
            config,
            config_file_path,
            exe_dir: exe_dir.to_path_buf(),
            default_data_dir,
            exe_dir_writable,
        };

        Ok(Self {
            inner: std::sync::Mutex::new(DbInner {
                conn,
                storage: Some(managed),
                ephemeral_plugins_dir: None,
            }),
        })
    }

    pub fn active_plugins_dir_opt(&self) -> Option<String> {
        let inner = self.lock().ok()?;
        inner
            .storage
            .as_ref()
            .map(|st| clean_display_path(&st.active_data_path().join("plugins")))
    }

    pub fn active_data_dir_path(&self) -> Option<PathBuf> {
        let inner = self.lock().ok()?;
        inner
            .storage
            .as_ref()
            .map(|st| st.active_data_path())
    }

    fn compute_storage_info_inner(inner: &DbInner) -> Result<StorageConfigInfo, AppError> {
        let page_count: i64 = inner.conn.query_row(
            "SELECT COUNT(*) FROM pages WHERE is_trashed = 0",
            [],
            |r| r.get(0),
        )?;
        let block_count: i64 = inner.conn.query_row(
            "SELECT COUNT(*) FROM blocks b JOIN pages p ON p.id = b.page_id WHERE p.is_trashed = 0",
            [],
            |r| r.get(0),
        )?;

        if let Some(ref st) = inner.storage {
            let db_path = st.db_file_path();
            let wal_path = PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
            let main_sz = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
            let wal_sz = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

            let is_default = normalize_path_key(&st.active_data_path())
                == normalize_path_key(&st.default_data_dir);

            Ok(StorageConfigInfo {
                exe_dir: clean_display_path(&st.exe_dir),
                default_data_dir: clean_display_path(&st.default_data_dir),
                active_data_dir: clean_display_path(&st.active_data_path()),
                db_file_path: clean_display_path(&db_path),
                markdown_sync_dir: clean_display_path(&st.markdown_sync_path()),
                assets_dir: clean_display_path(&st.assets_path()),
                backups_dir: clean_display_path(&st.backups_path()),
                is_default_portable_dir: is_default,
                exe_dir_writable: st.exe_dir_writable,
                auto_sync_markdown: st.config.auto_sync_markdown,
                image_save_mode: st.config.image_save_mode.clone(),
                auto_backup_on_launch: st.config.auto_backup_on_launch,
                max_backups: st.config.max_backups,
                db_size_bytes: main_sz + wal_sz,
                page_count: page_count.max(0) as usize,
                block_count: block_count.max(0) as usize,
            })
        } else {
            Ok(StorageConfigInfo {
                exe_dir: String::new(),
                default_data_dir: ":memory:".into(),
                active_data_dir: ":memory:".into(),
                db_file_path: ":memory:".into(),
                markdown_sync_dir: String::new(),
                assets_dir: String::new(),
                backups_dir: String::new(),
                is_default_portable_dir: true,
                exe_dir_writable: true,
                auto_sync_markdown: false,
                image_save_mode: "base64".into(),
                auto_backup_on_launch: false,
                max_backups: 10,
                db_size_bytes: 0,
                page_count: page_count.max(0) as usize,
                block_count: block_count.max(0) as usize,
            })
        }
    }

    pub fn get_storage_info(&self) -> Result<StorageConfigInfo, AppError> {
        let inner = self.lock()?;
        Self::compute_storage_info_inner(&inner)
    }

    pub fn update_storage_config(
        &self,
        input: UpdateStorageConfigInput,
    ) -> Result<StorageConfigInfo, AppError> {
        let mut inner = self.lock()?;
        let Some(current_st) = inner.storage.clone() else {
            return Err(AppError::Validation(
                "In-memory database does not support disk path updates".into(),
            ));
        };

        let old_active_path = current_st.active_data_path();
        let old_sync_path = current_st.markdown_sync_path();
        let old_default_pages = old_active_path.join("pages");
        let was_using_default_pages_sub =
            normalize_path_key(&old_sync_path) == normalize_path_key(&old_default_pages);

        let next_active_str = match input
            .active_data_dir
            .as_deref()
            .map(normalize_win32_path_str)
            .filter(|s| !s.is_empty())
        {
            Some(custom) => custom,
            None => current_st.config.active_data_dir.clone(),
        };
        let next_active_path = PathBuf::from(&next_active_str);
        let active_dir_changed =
            normalize_path_key(&next_active_path) != normalize_path_key(&old_active_path);

        let next_sync_str = if let Some(explicit_sync) = input
            .markdown_sync_dir
            .as_deref()
            .map(normalize_win32_path_str)
            .filter(|s| !s.is_empty())
        {
            explicit_sync
        } else if active_dir_changed && was_using_default_pages_sub {
            clean_display_path(&next_active_path.join("pages"))
        } else {
            current_st.config.markdown_sync_dir.clone()
        };
        let next_sync_path = PathBuf::from(&next_sync_str);
        let sync_dir_changed =
            normalize_path_key(&next_sync_path) != normalize_path_key(&old_sync_path);

        // Validate target folders are creatable/writable before mutating active DB state
        ensure_data_subdirs(&next_active_path, &next_sync_path)?;

        let next_auto_sync = input
            .auto_sync_markdown
            .unwrap_or(current_st.config.auto_sync_markdown);
        let next_img_mode = match input.image_save_mode.as_deref() {
            Some("base64") => "base64".to_string(),
            Some("assets") => "assets".to_string(),
            _ => current_st.config.image_save_mode.clone(),
        };
        let next_auto_backup = input
            .auto_backup_on_launch
            .unwrap_or(current_st.config.auto_backup_on_launch);
        let next_max_backups = input
            .max_backups
            .filter(|&n| n > 0)
            .unwrap_or(current_st.config.max_backups);
        let migrate = input.migrate_existing_data.unwrap_or(true);

        if active_dir_changed {
            let old_db_path = current_st.db_file_path();
            let new_db_path = next_active_path.join(DB_FILENAME);
            let new_backups_dir = next_active_path.join("backups");

            let _ = inner.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

            if migrate {
                // Stage clean snapshot of current live DB into a temporary file first
                let staged_db = next_active_path.join(format!(
                    ".notion-migrate-{}.db",
                    Uuid::new_v4().simple()
                ));
                snapshot_conn_to_file(&inner.conn, Some(&old_db_path), &staged_db)?;

                // Release Windows file locks on old connection before swapping
                let prev_conn = std::mem::replace(&mut inner.conn, Connection::open_in_memory()?);
                drop(prev_conn);

                // If destination already had a DB, preserve a safety snapshot in backups/
                if new_db_path.is_file() {
                    let _ = create_pre_overwrite_backup(&new_db_path, &new_backups_dir);
                }
                remove_wal_sidecars(&new_db_path);
                if new_db_path.exists() {
                    let _ = std::fs::remove_file(&new_db_path);
                }
                std::fs::rename(&staged_db, &new_db_path).or_else(|_| {
                    let res = std::fs::copy(&staged_db, &new_db_path).map(|_| ());
                    let _ = std::fs::remove_file(&staged_db);
                    res
                })?;

                // Merge-copy assets/, backups/, plugins/, and pages/ into new storage location
                let _ = copy_dir_merge_non_destructive(
                    &current_st.assets_path(),
                    &next_active_path.join("assets"),
                );
                let _ = copy_dir_merge_non_destructive(&current_st.backups_path(), &new_backups_dir);
                let _ = copy_dir_merge_non_destructive(
                    &current_st.active_data_path().join("plugins"),
                    &next_active_path.join("plugins"),
                );
                let _ = crate::plugins::ensure_plugins_initialized_on_disk(&next_active_path);
                if sync_dir_changed {
                    let _ = copy_dir_merge_non_destructive(&old_sync_path, &next_sync_path);
                }

                let new_conn = Connection::open(&new_db_path)?;
                Self::initialize_conn(&new_conn, false)?;
                inner.conn = new_conn;
            } else {
                // Switch directly to existing DB in target folder (or initialize fresh workspace if empty)
                let prev_conn = std::mem::replace(&mut inner.conn, Connection::open_in_memory()?);
                drop(prev_conn);

                let _ = crate::plugins::ensure_plugins_initialized_on_disk(&next_active_path);

                let new_conn = Connection::open(&new_db_path)?;
                Self::initialize_conn(&new_conn, true)?;
                inner.conn = new_conn;
            }
        }

        let updated_cfg = StorageConfig {
            active_data_dir: next_active_str,
            markdown_sync_dir: next_sync_str,
            auto_sync_markdown: next_auto_sync,
            image_save_mode: next_img_mode,
            auto_backup_on_launch: next_auto_backup,
            max_backups: next_max_backups,
        };

        save_storage_config_file(&current_st.config_file_path, &updated_cfg)?;
        prune_backups_dir(&next_active_path.join("backups"), next_max_backups);

        if let Some(ref mut st) = inner.storage {
            st.config = updated_cfg;
        }

        if next_auto_sync
            && (active_dir_changed
                || sync_dir_changed
                || !current_st.config.auto_sync_markdown)
        {
            let _ = sync_all_pages_conn(&inner.conn, &next_sync_path);
        }

        Self::compute_storage_info_inner(&inner)
    }

    pub fn reset_storage_to_default(
        &self,
        migrate_existing_data: bool,
    ) -> Result<StorageConfigInfo, AppError> {
        let default_dir_str = {
            let inner = self.lock()?;
            let Some(ref st) = inner.storage else {
                return Err(AppError::Validation(
                    "In-memory database does not support disk path reset".into(),
                ));
            };
            clean_display_path(&st.default_data_dir)
        };
        let default_pages_str =
            clean_display_path(&PathBuf::from(&default_dir_str).join("pages"));

        self.update_storage_config(UpdateStorageConfigInput {
            active_data_dir: Some(default_dir_str),
            markdown_sync_dir: Some(default_pages_str),
            migrate_existing_data: Some(migrate_existing_data),
            ..Default::default()
        })
    }

    pub fn sync_all_pages_to_markdown(&self) -> Result<usize, AppError> {
        let inner = self.lock()?;
        let Some(ref st) = inner.storage else {
            return Ok(0);
        };
        sync_all_pages_conn(&inner.conn, &st.markdown_sync_path())
    }

    pub fn list_backups(&self) -> Result<Vec<BackupEntry>, AppError> {
        let inner = self.lock()?;
        let Some(ref st) = inner.storage else {
            return Ok(Vec::new());
        };
        let raw_list = collect_backup_files(&st.backups_path());
        Ok(raw_list
            .into_iter()
            .map(|(full, fname, sz, mtime)| BackupEntry {
                filename: fname,
                full_path: clean_display_path(&full),
                size_bytes: sz,
                created_at: system_time_to_iso(mtime),
            })
            .collect())
    }

    pub fn create_backup_now(&self) -> Result<BackupEntry, AppError> {
        let inner = self.lock()?;
        let Some(ref st) = inner.storage else {
            return Err(AppError::Validation(
                "In-memory database does not support disk backups".into(),
            ));
        };
        create_backup_snapshot_internal(
            &inner.conn,
            &st.db_file_path(),
            &st.backups_path(),
            st.config.max_backups,
            None,
        )
    }

    pub fn restore_backup(&self, backup_path: &str) -> Result<StorageConfigInfo, AppError> {
        let mut inner = self.lock()?;
        let Some(st) = inner.storage.clone() else {
            return Err(AppError::Validation(
                "In-memory database does not support backup restore".into(),
            ));
        };

        let norm_input = normalize_win32_path_str(backup_path);
        let candidate = PathBuf::from(&norm_input);
        let resolved_backup = if candidate.is_file() {
            candidate
        } else {
            let in_backups = st.backups_path().join(&norm_input);
            if in_backups.is_file() {
                in_backups
            } else {
                return Err(AppError::NotFound(format!(
                    "Backup snapshot not found: {}",
                    backup_path
                )));
            }
        };

        // Verify candidate is a readable SQLite database containing `pages`
        {
            let check_conn = Connection::open(&resolved_backup)?;
            let _: i64 = check_conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
        }

        let db_path = st.db_file_path();
        if normalize_path_key(&resolved_backup) == normalize_path_key(&db_path) {
            return Self::compute_storage_info_inner(&inner);
        }

        // Release open file locks on current DB before overwriting on Windows
        let _ = inner.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let prev_conn = std::mem::replace(&mut inner.conn, Connection::open_in_memory()?);
        drop(prev_conn);

        remove_wal_sidecars(&db_path);
        std::fs::copy(&resolved_backup, &db_path)?;

        let restored_conn = Connection::open(&db_path)?;
        Self::initialize_conn(&restored_conn, false)?;
        inner.conn = restored_conn;

        if st.config.auto_sync_markdown {
            let _ = sync_all_pages_conn(&inner.conn, &st.markdown_sync_path());
        }

        Self::compute_storage_info_inner(&inner)
    }

    pub fn save_asset_image(
        &self,
        filename: &str,
        data_base64: &str,
        mime_type: &str,
    ) -> Result<SavedAssetResult, AppError> {
        let payload = match data_base64.split_once(',') {
            Some((prefix, rest)) if prefix.contains("base64") => rest,
            _ => data_base64,
        };
        let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        if compact.is_empty() {
            return Err(AppError::Validation("Empty image base64 payload".into()));
        }

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&compact)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&compact))?;

        let safe_mime = {
            let m = mime_type.trim();
            if m.starts_with("image/") {
                m.to_string()
            } else {
                "image/png".to_string()
            }
        };

        let ext_from_name = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| {
                matches!(
                    e.as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico"
                )
            });
        let ext = ext_from_name.unwrap_or_else(|| match safe_mime.as_str() {
            "image/jpeg" | "image/jpg" => "jpg".to_string(),
            "image/gif" => "gif".to_string(),
            "image/webp" => "webp".to_string(),
            "image/svg+xml" => "svg".to_string(),
            "image/bmp" => "bmp".to_string(),
            _ => "png".to_string(),
        });

        let raw_stem = Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("pasted-image");
        let safe_stem = sanitize_windows_segment(raw_stem);
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let short_id = &Uuid::new_v4().simple().to_string()[..6];
        let unique_name = format!("{}-{}-{}.{}", safe_stem, stamp, short_id, ext);

        let canonical_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let asset_url = format!("data:{};base64,{}", safe_mime, canonical_b64);

        let assets_dir_opt = {
            let inner = self.lock()?;
            inner.storage.as_ref().map(|st| st.assets_path())
        };

        if let Some(assets_dir) = assets_dir_opt {
            std::fs::create_dir_all(&assets_dir)?;
            let full_path = assets_dir.join(&unique_name);
            std::fs::write(&full_path, &bytes)?;
            Ok(SavedAssetResult {
                file_path: clean_display_path(&full_path),
                asset_url,
            })
        } else {
            Ok(SavedAssetResult {
                file_path: unique_name,
                asset_url,
            })
        }
    }

    /// Build a complete Workspace Markdown + Database CSV + `assets/` `.zip` archive in memory.
    pub fn build_workspace_zip_bytes(&self) -> Result<Vec<u8>, AppError> {
        let inner = self.lock()?;
        let active_pages = query_active_pages_conn(&inner.conn)?;
        let rel_map = compute_page_rel_md_paths(&active_pages);
        let assets_dir_opt = inner.storage.as_ref().map(|st| st.assets_path());

        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip_writer = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            for page in &active_pages {
                if let Some(rel_md) = rel_map.get(&page.id) {
                    let md_content = export_single_page_markdown_conn(&inner.conn, page)?;
                    zip_writer.start_file(rel_md, opts)?;
                    zip_writer.write_all(md_content.as_bytes())?;

                    if page.page_type == "database" {
                        let db_full =
                            Self::ensure_database_initialized_conn(&inner.conn, &page.id)?;
                        let csv_content = export_database_to_csv(&db_full);
                        if !csv_content.is_empty() {
                            let rel_csv = format!(
                                "{}.csv",
                                rel_md.strip_suffix(".md").unwrap_or(rel_md)
                            );
                            zip_writer.start_file(rel_csv, opts)?;
                            zip_writer.write_all(csv_content.as_bytes())?;
                        }
                    }
                }
            }

            if let Some(assets_dir) = assets_dir_opt.filter(|d| d.is_dir()) {
                if let Ok(rd) = std::fs::read_dir(&assets_dir) {
                    for item in rd.flatten() {
                        let p = item.path();
                        if p.is_file() {
                            if let Some(fname) = p.file_name().map(|n| n.to_string_lossy()) {
                                if let Ok(bytes) = std::fs::read(&p) {
                                    let zip_entry =
                                        format!("assets/{}", sanitize_markdown_filename(&fname).trim_end_matches(".md"));
                                    let clean_entry = format!("assets/{}", fname.replace('\\', "_").replace('/', "_"));
                                    let _ = zip_entry;
                                    zip_writer.start_file(clean_entry, opts)?;
                                    zip_writer.write_all(&bytes)?;
                                }
                            }
                        }
                    }
                }
            }

            zip_writer.finish()?;
        }

        Ok(cursor.into_inner())
    }

    pub fn resolve_and_read_custom_font(&self, raw_path: &str) -> Result<Vec<u8>, AppError> {
        let (active_dir, exe_dir) = {
            let inner = self.lock()?;
            (
                inner.storage.as_ref().map(|st| st.active_data_path()),
                inner.storage.as_ref().map(|st| st.exe_dir.clone()),
            )
        };
        let resolved =
            resolve_custom_font_file_path(raw_path, active_dir.as_deref(), exe_dir.as_deref())?;
        Ok(std::fs::read(&resolved)?)
    }

    pub fn import_custom_font_to_data_dir(
        &self,
        raw_path: &str,
    ) -> Result<ImportedCustomFont, AppError> {
        let (active_dir_opt, exe_dir_opt) = {
            let inner = self.lock()?;
            (
                inner.storage.as_ref().map(|st| st.active_data_path()),
                inner.storage.as_ref().map(|st| st.exe_dir.clone()),
            )
        };
        let active_dir = active_dir_opt.ok_or_else(|| {
            AppError::Validation("当前为内存工作区，无法拷入本地 fonts/ 目录".into())
        })?;
        let source = resolve_custom_font_file_path(
            raw_path,
            Some(&active_dir),
            exe_dir_opt.as_deref(),
        )?;
        let meta = std::fs::metadata(&source)?;
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "ttf".to_string());
        let stem_raw = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("custom-font");
        let safe_stem = sanitize_windows_segment(stem_raw);
        let file_name = format!("{}.{}", safe_stem, ext);
        let fonts_dir = active_dir.join("fonts");
        std::fs::create_dir_all(&fonts_dir)?;
        let dest = fonts_dir.join(&file_name);

        let same_target = normalize_path_key(&source) == normalize_path_key(&dest)
            || (dest.exists()
                && std::fs::canonicalize(&source).ok() == std::fs::canonicalize(&dest).ok());
        if !same_target {
            std::fs::copy(&source, &dest)?;
        }

        Ok(ImportedCustomFont {
            stored_path: format!("fonts/{}", file_name),
            resolved_path: clean_display_path(&dest),
            display_name: safe_stem,
            byte_size: meta.len(),
        })
    }
}

const MAX_CUSTOM_FONT_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) fn normalize_custom_font_path_input(raw_path: &str) -> String {
    let mut cleaned = raw_path.trim();
    loop {
        if cleaned.len() >= 2
            && ((cleaned.starts_with('"') && cleaned.ends_with('"'))
                || (cleaned.starts_with('\'') && cleaned.ends_with('\'')))
        {
            cleaned = cleaned[1..cleaned.len() - 1].trim();
        } else {
            break;
        }
    }
    let cleaned = cleaned.trim_matches('"').trim_matches('\'').trim();
    if let Some(rest) = cleaned.strip_prefix("file:///") {
        let rest_norm = normalize_win32_path_str(rest);
        if cfg!(not(target_os = "windows")) && !rest_norm.starts_with('/') {
            return format!("/{}", rest_norm);
        }
        return rest_norm;
    }
    if let Some(sub) = cleaned.strip_prefix("~/").or_else(|| cleaned.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return normalize_win32_path_str(&PathBuf::from(home).join(sub).to_string_lossy());
        }
    }
    normalize_win32_path_str(cleaned)
}

fn validate_custom_font_file(path: &Path) -> Result<u64, AppError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "ttf" | "otf" | "woff" | "woff2" | "ttc") {
        return Err(AppError::Validation(format!(
            "不支持的字体格式（仅支持 .ttf / .otf / .woff2 / .woff / .ttc）：{}",
            path.display()
        )));
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return Err(AppError::Validation(format!(
            "找不到字体文件：{}，请检查路径是否正确",
            path.display()
        )));
    };
    if !meta.is_file() {
        return Err(AppError::Validation(format!(
            "字体路径不是有效文件：{}",
            path.display()
        )));
    }
    let len = meta.len();
    if len == 0 || len > MAX_CUSTOM_FONT_BYTES {
        return Err(AppError::Validation(format!(
            "字体文件大小超出限制（需在 1B ~ 64MB 之间）：{}",
            path.display()
        )));
    }
    Ok(len)
}

fn resolve_custom_font_file_path(
    raw_path: &str,
    active_data_dir: Option<&Path>,
    exe_dir: Option<&Path>,
) -> Result<PathBuf, AppError> {
    let clean = normalize_custom_font_path_input(raw_path);
    if clean.is_empty() {
        return Err(AppError::Validation("请输入字体文件路径".into()));
    }
    let input_path = PathBuf::from(&clean);
    let candidate = if input_path.is_absolute() {
        input_path
    } else if let Some(in_data) = active_data_dir.map(|d| d.join(&input_path)).filter(|p| p.is_file()) {
        in_data
    } else if let Some(in_exe) = exe_dir.map(|d| d.join(&input_path)).filter(|p| p.is_file()) {
        in_exe
    } else if let Some(d) = active_data_dir {
        d.join(&input_path)
    } else {
        input_path
    };
    validate_custom_font_file(&candidate)?;
    Ok(candidate)
}

fn create_pre_overwrite_backup(existing_db: &Path, backups_dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(backups_dir)?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let dest = backups_dir.join(format!("backup-pre-migrate-{}.db", stamp));
    snapshot_sqlite_file_on_disk(existing_db, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BlockProps, CreatePageInput};

    struct TempTestDir(PathBuf);

    impl TempTestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "notion-v020-test-{}-{}",
                label,
                Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_portable_storage_hot_swap_migration_and_reset() {
        let exe_root = TempTestDir::new("exe");
        let appdata_fallback = TempTestDir::new("appdata");
        let custom_vault = TempTestDir::new("custom-vault");

        let db = Database::open_portable(exe_root.path(), appdata_fallback.path(), false)
            .expect("open portable db in exe_dir");

        // 1. Default portable storage lives in `<exe_dir>\xynote-config.json` & `<exe_dir>\XyNote-data\`
        assert!(exe_root.path().join("xynote-config.json").is_file());
        assert!(exe_root.path().join("XyNote-data").join("xynote.db").is_file());
        assert!(exe_root.path().join("XyNote-data").join("pages").is_dir());
        assert!(exe_root.path().join("XyNote-data").join("assets").is_dir());
        assert!(exe_root.path().join("XyNote-data").join("backups").is_dir());

        let info0 = db.get_storage_info().unwrap();
        assert!(info0.is_default_portable_dir);
        assert!(info0.exe_dir_writable);
        assert!(info0.page_count >= 1); // 新工作区只带一篇使用说明
        assert!(info0.db_size_bytes > 0);
        assert_eq!(db.list_backups().unwrap().len(), 1); // Launch auto-backup created!

        // 2. Create a page before migrating to custom directory
        let p_before = db
            .create_page(CreatePageInput {
                title: Some("便携迁移前笔记".into()),
                icon: Some("🚀".into()),
                ..Default::default()
            })
            .unwrap();

        // 3. Hot-swap to custom storage folder with `migrate_existing_data: true` (ZERO restart!)
        let custom_dir_str = clean_display_path(custom_vault.path());
        let info_custom = db
            .update_storage_config(UpdateStorageConfigInput {
                active_data_dir: Some(custom_dir_str.clone()),
                migrate_existing_data: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert!(!info_custom.is_default_portable_dir);
        assert_eq!(
            normalize_path_key(Path::new(&info_custom.active_data_dir)),
            normalize_path_key(custom_vault.path())
        );
        assert!(custom_vault.path().join("xynote.db").is_file());
        assert!(db
            .list_pages()
            .unwrap()
            .iter()
            .any(|p| p.id == p_before.id));

        // 4. Create another page while running in `custom_vault`, then reset back to `<exe_dir>\data`
        let p_in_custom = db
            .create_page(CreatePageInput {
                title: Some("自定义目录新增页面".into()),
                icon: Some("📦".into()),
                ..Default::default()
            })
            .unwrap();

        let info_reset = db.reset_storage_to_default(true).unwrap();
        assert!(info_reset.is_default_portable_dir);
        let pages_after_reset = db.list_pages().unwrap();
        assert!(pages_after_reset.iter().any(|p| p.id == p_before.id));
        assert!(pages_after_reset.iter().any(|p| p.id == p_in_custom.id));

        drop(db);
    }

    #[test]
    fn test_local_note_images_saved_beside_note_and_written_relative() {
        let dir = TempTestDir::new("note-img");
        let note = dir.path().join("游记.md");
        let note_str = note.to_string_lossy().into_owned();
        // 1x1 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let img = save_local_note_image_disk(&note_str, "截图 1.png", png, "image/png").unwrap();
        assert!(img.relative_path.starts_with("assets/"));
        assert!(img.relative_path.contains("%20"), "空格应转义");
        assert!(Path::new(&img.file_path).is_file());

        let md = format!("# 游记\n\n![海边]({})\n", img.relative_path);
        std::fs::write(&note, &md).unwrap();
        let doc = open_local_markdown_file_disk(&note_str).unwrap();
        let image = doc.blocks.iter().find(|b| b.block_type == "image").unwrap();
        assert!(image.props.url.as_deref().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(image.props.local_src.as_deref(), Some(img.relative_path.as_str()));

        // 所见即所得保存：写回相对路径，而不是 data URL
        let items: Vec<SaveBlockItem> = doc
            .blocks
            .iter()
            .map(|b| SaveBlockItem {
                id: b.id.clone(),
                block_type: b.block_type.clone(),
                content: b.content.clone(),
                plain_text: b.plain_text.clone(),
                props: b.props.clone(),
                sort_order: b.sort_order,
            })
            .collect();
        save_local_markdown_file_disk(&note_str, Some(items), None).unwrap();
        let written = std::fs::read_to_string(&note).unwrap();
        assert!(written.contains(&format!("]({})", img.relative_path)));
        assert!(!written.contains("data:image"));
    }

    #[test]
    fn test_legacy_notion_named_files_are_migrated() {
        let exe_root = TempTestDir::new("legacy-names");
        let appdata = TempTestDir::new("legacy-appdata");
        // 先用新代码建一个工作区，再把文件改回旧名字，模拟老版本留下的数据
        {
            let db = Database::open_portable(exe_root.path(), appdata.path(), false).unwrap();
            db.create_page(CreatePageInput { title: Some("老数据".into()), ..Default::default() }).unwrap();
        }
        let data = exe_root.path().join("XyNote-data");
        std::fs::rename(exe_root.path().join("xynote-config.json"), exe_root.path().join("notion-config.json")).unwrap();
        std::fs::rename(data.join("xynote.db"), data.join("notion_desktop.db")).unwrap();
        for s in ["-wal", "-shm"] {
            let _ = std::fs::rename(data.join(format!("xynote.db{}", s)), data.join(format!("notion_desktop.db{}", s)));
        }
        std::fs::rename(&data, exe_root.path().join("data")).unwrap();

        let db = Database::open_portable(exe_root.path(), appdata.path(), false).unwrap();
        assert!(exe_root.path().join("xynote-config.json").is_file());
        assert!(!exe_root.path().join("notion-config.json").exists());
        assert!(!exe_root.path().join("data").exists());
        assert!(data.join("xynote.db").is_file());
        assert!(db.list_pages().unwrap().iter().any(|p| p.title == "老数据"), "数据应随文件一起迁移");
    }

    #[test]
    fn test_local_save_detects_external_modification() {
        let dir = TempTestDir::new("conflict");
        let path = dir.path().join("note.md");
        let path_str = path.to_string_lossy().into_owned();
        let first = save_local_markdown_file_checked(&path_str, None, Some("# A\n".into()), None).unwrap();

        // 用打开时的时间保存：没有外部改动，正常写入
        let second =
            save_local_markdown_file_checked(&path_str, None, Some("# B\n".into()), Some(&first.updated_at)).unwrap();

        // 其他程序改了文件（修改时间变化）
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, "# 外部改动\n").unwrap();
        let err = save_local_markdown_file_checked(&path_str, None, Some("# C\n".into()), Some(&second.updated_at))
            .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# 外部改动\n", "冲突时不能覆盖");

        // 用户选择「仍然覆盖」
        save_local_markdown_file_checked(&path_str, None, Some("# C\n".into()), None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# C\n");
    }

    #[test]
    fn test_live_markdown_mirror_sync_nested_rename_and_trash() {
        let exe_root = TempTestDir::new("md-sync");
        let appdata_fallback = TempTestDir::new("md-appdata");

        let db = Database::open_portable(exe_root.path(), appdata_fallback.path(), false).unwrap();
        let pages_dir = exe_root.path().join("XyNote-data").join("pages");

        // 新工作区只有一篇使用说明，它的 .md 镜像应已写到磁盘
        let seeded_welcome = pages_dir.join("欢迎使用 小悦 (XyNote).md");
        assert!(
            seeded_welcome.is_file() || pages_dir.join("欢迎使用 小悦 (XyNote)").is_dir(),
            "seeded welcome page should be mirrored to disk"
        );

        // Create parent + child page and verify live `.md` creation
        let parent = db
            .create_page(CreatePageInput {
                title: Some("研发知识库".into()),
                ..Default::default()
            })
            .unwrap();
        let child = db
            .create_page(CreatePageInput {
                parent_id: Some(parent.id.clone()),
                title: Some("Rust 存储设计: v0.2".into()),
                ..Default::default()
            })
            .unwrap();
        db.save_page_blocks(
            &child.id,
            vec![SaveBlockItem {
                id: "b1".into(),
                block_type: "paragraph".into(),
                content: "实时镜像同步 <mark>关键段落</mark>".into(),
                plain_text: String::new(),
                props: BlockProps::default(),
                sort_order: 0,
            }],
        )
        .unwrap();

        let expected_child_md = pages_dir
            .join("研发知识库")
            .join("Rust 存储设计_ v0.2.md");
        assert!(expected_child_md.is_file());
        let disk_md = std::fs::read_to_string(&expected_child_md).unwrap();
        assert!(disk_md.contains("==关键段落=="));

        // Trash parent -> both parent and child `.md` files must be cleaned from `pages/`!
        db.trash_page(&parent.id).unwrap();
        assert!(!expected_child_md.exists());
        assert!(!pages_dir.join("研发知识库.md").exists());

        // Restore parent -> `.md` files reappear cleanly!
        db.restore_page(&parent.id).unwrap();
        assert!(expected_child_md.is_file());

        // Explicit full sync returns active page count
        let synced_count = db.sync_all_pages_to_markdown().unwrap();
        assert!(synced_count >= 3); // 使用说明 + 新建的父子两页

        drop(db);
    }

    #[test]
    fn test_backup_creation_pruning_hot_restore_and_workspace_zip() {
        let exe_root = TempTestDir::new("backups");
        let appdata_fallback = TempTestDir::new("bkp-appdata");

        let db = Database::open_portable(exe_root.path(), appdata_fallback.path(), false).unwrap();

        let p_keep = db
            .create_page(CreatePageInput {
                title: Some("快照保存页面 Snapshot Keep".into()),
                ..Default::default()
            })
            .unwrap();
        // 新工作区不再自带数据库页面，这里建一个，用于校验导出包里的 .csv
        db.create_page(CreatePageInput {
            template_id: Some("task-hub".into()),
            ..Default::default()
        })
        .unwrap();

        let snap = db.create_backup_now().unwrap();
        assert!(Path::new(&snap.full_path).is_file());
        assert!(snap.size_bytes > 0);

        // Mutate workspace after snapshot (add temporary page + delete `p_keep`)
        let p_temp = db
            .create_page(CreatePageInput {
                title: Some("快照后误操作页面".into()),
                ..Default::default()
            })
            .unwrap();
        db.delete_page_permanently(&p_keep.id).unwrap();
        assert!(!db.list_pages().unwrap().iter().any(|p| p.id == p_keep.id));

        // Hot-restore snapshot with zero restart!
        let restored_info = db.restore_backup(&snap.full_path).unwrap();
        assert!(restored_info.page_count >= 3); // 使用说明 + p_keep + 任务库
        let pages_now = db.list_pages().unwrap();
        assert!(pages_now.iter().any(|p| p.id == p_keep.id));
        assert!(!pages_now.iter().any(|p| p.id == p_temp.id));

        // Verify workspace `.zip` export contains `.md` and `.csv` entries
        let zip_bytes = db.build_workspace_zip_bytes().unwrap();
        assert!(zip_bytes.len() > 200);
        let archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.name_for_index(i).unwrap().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with(".md")));
        assert!(names.iter().any(|n| n.ends_with(".csv")));

        drop(db);
    }

    #[test]
    fn test_local_markdown_open_save_roundtrip_and_asset_image_save() {
        let exe_root = TempTestDir::new("typora-local");
        let appdata_fallback = TempTestDir::new("typora-appdata");
        let notes_dir = TempTestDir::new("standalone-notes");

        let db = Database::open_portable(exe_root.path(), appdata_fallback.path(), false).unwrap();

        // 1. `save_asset_image` writes binary PNG to `<exe_dir>\data\assets\` AND returns `data:image/png;base64,...`
        let tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let saved_asset = db
            .save_asset_image("截图: 架构图.png", tiny_png_b64, "image/png")
            .unwrap();
        assert!(Path::new(&saved_asset.file_path).is_file());
        assert!(saved_asset.file_path.contains("assets"));
        assert!(saved_asset.asset_url.starts_with("data:image/png;base64,"));

        // 2. Write standalone `.md` via `save_local_markdown_file_disk` with GFM table & highlight, then re-open!
        let md_path = notes_dir.path().join("typora-spec.md");
        let md_path_str = clean_display_path(&md_path);

        let saved_doc = save_local_markdown_file_disk(
            &md_path_str,
            Some(vec![
                SaveBlockItem {
                    id: "h1".into(),
                    block_type: "heading1".into(),
                    content: "Typora 本地直编规范".into(),
                    plain_text: "Typora 本地直编规范".into(),
                    props: BlockProps::default(),
                    sort_order: 0,
                },
                SaveBlockItem {
                    id: "p1".into(),
                    block_type: "paragraph".into(),
                    content: "这里包含 <mark>双等号高亮</mark> 与 <b>粗体</b>。".into(),
                    plain_text: String::new(),
                    props: BlockProps::default(),
                    sort_order: 1,
                },
                SaveBlockItem {
                    id: "t1".into(),
                    block_type: "table".into(),
                    content: String::new(),
                    plain_text: String::new(),
                    props: BlockProps {
                        headers: Some(vec!["快捷键".into(), "功能 | Action".into()]),
                        rows: Some(vec![
                            vec!["Ctrl + /".into(), "切换源码 / 所见即所得".into()],
                            vec!["Ctrl + S".into(), "直接保存本地 .md".into()],
                        ]),
                        ..Default::default()
                    },
                    sort_order: 2,
                },
            ]),
            None,
        )
        .unwrap();

        assert_eq!(saved_doc.title, "Typora 本地直编规范");
        assert!(saved_doc.markdown.contains("==双等号高亮=="));
        assert!(saved_doc.markdown.contains("| 快捷键 | 功能 \\| Action |"));

        let reopened = open_local_markdown_file_disk(&md_path_str).unwrap();
        assert_eq!(reopened.file_name, "typora-spec.md");
        assert_eq!(reopened.title, "Typora 本地直编规范");
        assert_eq!(reopened.blocks.len(), 3);
        assert!(reopened.blocks[1].content.contains("<mark>双等号高亮</mark>"));
        assert_eq!(reopened.blocks[2].block_type, "table");
        assert_eq!(
            reopened.blocks[2].props.headers.as_ref().unwrap(),
            &vec!["快捷键".to_string(), "功能 | Action".to_string()]
        );

        // 3. Bidirectional `convert_markdown_blocks_pure`
        let converted =
            convert_markdown_blocks_pure(Some(reopened.markdown.clone()), None, Some("p1".into()))
                .unwrap();
        assert_eq!(converted.blocks.len(), 3);
        assert_eq!(converted.blocks[0].page_id, "p1");

        drop(db);
    }

    #[test]
    fn test_custom_font_path_resolution_and_portable_import() {
        let exe_root = TempTestDir::new("custom-font-exe");
        let appdata_fallback = TempTestDir::new("custom-font-appdata");
        let external_fonts = TempTestDir::new("external-fonts");

        let db = Database::open_portable(exe_root.path(), appdata_fallback.path(), false).unwrap();

        let fake_ttf = b"\x00\x01\x00\x00FAKE_TTF_DATA_FOR_TEST";
        let font_src = external_fonts.path().join("MyKaiTi.ttf");
        std::fs::write(&font_src, fake_ttf).unwrap();

        // 1. Reads quoted path (as copied by Windows "Copy as path")
        let quoted = format!("  \"{}\"  ", font_src.to_string_lossy());
        let read_bytes = db.resolve_and_read_custom_font(&quoted).unwrap();
        assert_eq!(read_bytes, fake_ttf);

        // 2. Copies into `XyNote-data/fonts/` and returns relative `fonts/MyKaiTi.ttf`
        let imported = db.import_custom_font_to_data_dir(&quoted).unwrap();
        assert_eq!(imported.stored_path, "fonts/MyKaiTi.ttf");
        assert_eq!(imported.display_name, "MyKaiTi");
        assert_eq!(imported.byte_size, fake_ttf.len() as u64);
        assert!(Path::new(&imported.resolved_path).is_file());

        // 3. Resolves relative `fonts/MyKaiTi.ttf` against `active_data_dir`
        let read_rel = db.resolve_and_read_custom_font(&imported.stored_path).unwrap();
        assert_eq!(read_rel, fake_ttf);

        // 4. Rejects unsupported extensions & missing files cleanly
        let bad_ext = external_fonts.path().join("note.txt");
        std::fs::write(&bad_ext, b"not-a-font").unwrap();
        assert!(db
            .resolve_and_read_custom_font(&bad_ext.to_string_lossy())
            .is_err());
        assert!(db
            .resolve_and_read_custom_font(&external_fonts.path().join("missing.ttf").to_string_lossy())
            .is_err());

        drop(db);
    }
}
