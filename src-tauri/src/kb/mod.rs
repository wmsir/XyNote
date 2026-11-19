//! 可插拔 SAG2 本地知识库引擎（独立 `kb_index.db`，默认关闭，零主库侵入）。

pub mod index;
pub mod query;
pub mod tokenizer;

use crate::db::{now_iso, Database};
use crate::models::AppError;
use crate::storage::clean_display_path;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, TryLockError};

pub use index::{kb_index_disk_stats, KB_DB_FILENAME};
pub use query::{KbEntitySummary, KbRelatedResponse, KbSearchHit, KbSearchResponse};

pub const SETTING_KB_ENABLED: &str = "kb_enabled";
pub const SETTING_KB_INCLUDE_FOLDERS: &str = "kb_include_folders";
pub const SETTING_KB_SHOW_RELATED: &str = "kb_show_related_panel";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KbStatus {
    pub enabled: bool,
    pub include_folders: bool,
    pub show_related_panel: bool,
    pub db_path: String,
    pub db_exists: bool,
    pub db_size_bytes: u64,
    pub source_count: usize,
    pub event_count: usize,
    pub entity_count: usize,
    pub indexing: bool,
    pub last_indexed_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct KbRuntime {
    conn: Option<Connection>,
    db_path: Option<PathBuf>,
    include_folders: bool,
    show_related_panel: bool,
    last_indexed_at: Option<String>,
    last_error: Option<String>,
}

pub struct KbEngine {
    enabled_flag: Arc<AtomicBool>,
    indexing_flag: Arc<AtomicBool>,
    cached_sources: AtomicUsize,
    cached_events: AtomicUsize,
    cached_entities: AtomicUsize,
    runtime: Mutex<KbRuntime>,
}

impl Default for KbEngine {
    fn default() -> Self {
        Self::new()
    }
}

struct IndexingGuard(Arc<AtomicBool>);
impl Drop for IndexingGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn parse_bool_setting(val: Option<&String>, default_val: bool) -> bool {
    match val.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("true") | Some("1") | Some("yes") | Some("on") => true,
        Some("false") | Some("0") | Some("no") | Some("off") => false,
        _ => default_val,
    }
}

impl KbEngine {
    /// 构造函数不做任何磁盘 I/O 与建表，确保未启用时零开销
    pub fn new() -> Self {
        Self {
            enabled_flag: Arc::new(AtomicBool::new(false)),
            indexing_flag: Arc::new(AtomicBool::new(false)),
            cached_sources: AtomicUsize::new(0),
            cached_events: AtomicUsize::new(0),
            cached_entities: AtomicUsize::new(0),
            runtime: Mutex::new(KbRuntime {
                conn: None,
                db_path: None,
                include_folders: true,
                show_related_panel: true,
                last_indexed_at: None,
                last_error: None,
            }),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled_flag.load(Ordering::Acquire)
    }

    fn store_cached_counts(&self, sources: usize, events: usize, entities: usize) {
        self.cached_sources.store(sources, Ordering::Relaxed);
        self.cached_events.store(events, Ordering::Relaxed);
        self.cached_entities.store(entities, Ordering::Relaxed);
    }

    fn resolve_kb_db_path(db: &Database) -> PathBuf {
        match db.active_data_dir_path() {
            Some(dir) => dir.join(KB_DB_FILENAME),
            None => std::env::temp_dir().join("xynote-ephemeral").join(KB_DB_FILENAME),
        }
    }

    /// 仅从 `app_settings` 读取开关配置（绝不打开或创建 `kb_index.db`）
    fn sync_prefs_from_db(&self, db: &Database) -> Result<(bool, bool, bool, PathBuf), AppError> {
        let settings = db.get_settings()?;
        let enabled = parse_bool_setting(settings.get(SETTING_KB_ENABLED), false);
        let include_folders = parse_bool_setting(settings.get(SETTING_KB_INCLUDE_FOLDERS), true);
        let show_related = parse_bool_setting(settings.get(SETTING_KB_SHOW_RELATED), true);
        let kb_path = Self::resolve_kb_db_path(db);

        self.enabled_flag.store(enabled, Ordering::Release);
        match self.runtime.try_lock() {
            Ok(mut rt) => {
                rt.include_folders = include_folders;
                rt.show_related_panel = show_related;
                rt.db_path = Some(kb_path.clone());
            }
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Poisoned(_)) => return Err(AppError::LockPoisoned),
        }
        Ok((enabled, include_folders, show_related, kb_path))
    }

    /// 应用启动时由后台调用：只有在明确开启 `kb_enabled == "true"` 时才打开并同步 `kb_index.db`
    pub fn init_from_settings(&self, db: &Database) {
        let Ok((enabled, _, _, _)) = self.sync_prefs_from_db(db) else {
            return;
        };
        if !enabled {
            return;
        }
        let _ = self.rebuild_index(db, false);
    }

    pub fn get_status(&self, db: &Database) -> Result<KbStatus, AppError> {
        let (enabled, include_folders, show_related_panel, kb_path) =
            self.sync_prefs_from_db(db)?;

        let (db_exists, db_size_bytes) = kb_index_disk_stats(&kb_path);
        let db_path_display = clean_display_path(&kb_path);

        if !enabled {
            let (last_at, last_err) = match self.runtime.try_lock() {
                Ok(rt) => (rt.last_indexed_at.clone(), rt.last_error.clone()),
                Err(_) => (None, None),
            };
            return Ok(KbStatus {
                enabled: false,
                include_folders,
                show_related_panel,
                db_path: db_path_display,
                db_exists,
                db_size_bytes,
                source_count: 0,
                event_count: 0,
                entity_count: 0,
                indexing: false,
                last_indexed_at: last_at,
                last_error: last_err,
            });
        }

        let mut rt = match self.runtime.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Ok(KbStatus {
                    enabled: true,
                    include_folders,
                    show_related_panel,
                    db_path: db_path_display,
                    db_exists,
                    db_size_bytes,
                    source_count: self.cached_sources.load(Ordering::Relaxed),
                    event_count: self.cached_events.load(Ordering::Relaxed),
                    entity_count: self.cached_entities.load(Ordering::Relaxed),
                    indexing: true,
                    last_indexed_at: None,
                    last_error: None,
                });
            }
            Err(TryLockError::Poisoned(_)) => return Err(AppError::LockPoisoned),
        };

        rt.include_folders = include_folders;
        rt.show_related_panel = show_related_panel;
        if rt.conn.is_none() && self.is_enabled() {
            if let Ok(conn) = index::open_kb_conn(&kb_path) {
                rt.conn = Some(conn);
                rt.db_path = Some(kb_path.clone());
            }
        }

        let (source_count, event_count, entity_count, meta_last) = if let Some(ref conn) = rt.conn {
            index::read_kb_counts(conn).unwrap_or((0, 0, 0, None))
        } else {
            (0, 0, 0, None)
        };
        self.store_cached_counts(source_count, event_count, entity_count);
        let (db_exists, db_size_bytes) = kb_index_disk_stats(&kb_path);

        Ok(KbStatus {
            enabled: true,
            include_folders,
            show_related_panel,
            db_path: db_path_display,
            db_exists,
            db_size_bytes,
            source_count,
            event_count,
            entity_count,
            indexing: self.indexing_flag.load(Ordering::Acquire),
            last_indexed_at: meta_last.or_else(|| rt.last_indexed_at.clone()),
            last_error: rt.last_error.clone(),
        })
    }

    pub fn set_enabled(
        &self,
        db: &Database,
        enabled: bool,
        purge_index: bool,
    ) -> Result<KbStatus, AppError> {
        db.set_setting(SETTING_KB_ENABLED, if enabled { "true" } else { "false" })?;
        self.enabled_flag.store(enabled, Ordering::Release);

        let kb_path = Self::resolve_kb_db_path(db);
        if !enabled {
            {
                let mut rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
                // 必须先释放 SQLite 连接再删除文件，否则 Windows 下会报错 os error 32
                rt.conn = None;
                rt.db_path = Some(kb_path.clone());
                rt.last_error = None;
            }
            if purge_index {
                index::delete_kb_index_files(&kb_path);
                self.store_cached_counts(0, 0, 0);
                if let Ok(mut rt) = self.runtime.lock() {
                    rt.last_indexed_at = None;
                }
            }
            return self.get_status(db);
        }

        // 开启模块：同步最新配置并建库索引
        self.rebuild_index(db, false)
    }

    pub fn set_config(
        &self,
        db: &Database,
        include_folders: Option<bool>,
        show_related_panel: Option<bool>,
    ) -> Result<KbStatus, AppError> {
        let mut folders_changed = false;
        if let Some(inc) = include_folders {
            let prev = {
                let rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
                rt.include_folders
            };
            db.set_setting(SETTING_KB_INCLUDE_FOLDERS, if inc { "true" } else { "false" })?;
            let mut rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
            rt.include_folders = inc;
            folders_changed = prev != inc;
        }
        if let Some(show) = show_related_panel {
            db.set_setting(SETTING_KB_SHOW_RELATED, if show { "true" } else { "false" })?;
            let mut rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
            rt.show_related_panel = show;
        }
        if folders_changed && self.is_enabled() {
            return self.rebuild_index(db, false);
        }
        self.get_status(db)
    }

    pub fn rebuild_index(&self, db: &Database, force_full: bool) -> Result<KbStatus, AppError> {
        let (enabled, include_folders, _, kb_path) = self.sync_prefs_from_db(db)?;
        if !enabled {
            return self.get_status(db);
        }

        self.indexing_flag.store(true, Ordering::Release);
        let _guard = IndexingGuard(Arc::clone(&self.indexing_flag));

        // 先快照 xynote.db 与扫描磁盘列表再锁 runtime，避免锁竞争堵住前端状态轮询
        let snapshot = index::snapshot_workspace(db)?;
        let precollected_disk = if include_folders && !snapshot.mounted_folders.is_empty() {
            Some(index::collect_mounted_files(&snapshot.mounted_folders))
        } else {
            None
        };

        {
            let mut rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
            rt.include_folders = include_folders;
            if !self.is_enabled() {
                rt.conn = None;
                return Ok(KbStatus {
                    enabled: false,
                    include_folders: rt.include_folders,
                    show_related_panel: rt.show_related_panel,
                    db_path: clean_display_path(&kb_path),
                    db_exists: false,
                    db_size_bytes: 0,
                    source_count: 0,
                    event_count: 0,
                    entity_count: 0,
                    indexing: false,
                    last_indexed_at: None,
                    last_error: None,
                });
            }

            let need_reopen = rt.conn.is_none() || rt.db_path.as_ref() != Some(&kb_path);
            if need_reopen {
                rt.conn = None;
                rt.conn = Some(index::open_kb_conn(&kb_path)?);
                rt.db_path = Some(kb_path.clone());
            }

            let sync_res = if let Some(ref mut conn) = rt.conn {
                index::sync_workspace_into_kb(
                    conn,
                    &snapshot,
                    include_folders,
                    force_full,
                    precollected_disk.as_deref(),
                )
            } else {
                Ok(())
            };

            match sync_res {
                Ok(()) => {
                    rt.last_indexed_at = Some(now_iso());
                    rt.last_error = None;
                    if let Some(ref conn) = rt.conn {
                        if let Ok((s, e, ent, _)) = index::read_kb_counts(conn) {
                            self.store_cached_counts(s, e, ent);
                        }
                    }
                }
                Err(err) => {
                    rt.last_error = Some(err.to_string());
                    return Err(err);
                }
            }
        }

        drop(_guard);
        self.get_status(db)
    }

    pub fn purge_index(&self, db: &Database) -> Result<KbStatus, AppError> {
        self.set_enabled(db, false, true)
    }

    /// 立即释放当前 `kb_index.db` SQLite 句柄，避免目录迁移或备份还原触发 Windows 文件锁
    pub fn close_connection(&self) {
        if let Ok(mut rt) = self.runtime.lock() {
            rt.conn = None;
        }
    }

    /// 切换数据目录或恢复备份后重绑定 `kb_index.db` 路径（未开启时仅关闭旧句柄）
    pub fn rebind_storage(&self, db: &Database) {
        if let Ok(mut rt) = self.runtime.lock() {
            rt.conn = None;
            rt.db_path = Some(Self::resolve_kb_db_path(db));
            rt.last_error = None;
        }
        let Ok((enabled, _, _, _)) = self.sync_prefs_from_db(db) else {
            return;
        };
        if enabled {
            let _ = self.rebuild_index(db, false);
        }
    }

    pub fn sync_single_page(&self, db: &Database, page_id: &str) {
        if !self.is_enabled() {
            return;
        }
        let Ok((page, links)) = index::snapshot_single_page(db, page_id) else {
            return;
        };
        let kb_path = Self::resolve_kb_db_path(db);
        let Ok(mut rt) = self.runtime.lock() else {
            return;
        };
        if !self.is_enabled() {
            return;
        }
        if rt.conn.is_none() || rt.db_path.as_ref() != Some(&kb_path) {
            rt.conn = index::open_kb_conn(&kb_path).ok();
            rt.db_path = Some(kb_path);
        }
        if let Some(ref mut conn) = rt.conn {
            match index::sync_single_page_into_kb(conn, page.as_ref(), page_id, &links) {
                Ok(()) => {
                    rt.last_indexed_at = Some(now_iso());
                    rt.last_error = None;
                }
                Err(e) => {
                    rt.last_error = Some(e.to_string());
                }
            }
        }
    }

    pub fn remove_page(&self, db: &Database, page_id: &str) {
        self.sync_single_page(db, page_id);
    }

    pub fn sync_all(&self, db: &Database) {
        if !self.is_enabled() {
            return;
        }
        let _ = self.rebuild_index(db, false);
    }

    pub fn sync_disk_paths(&self, db: &Database, paths: &[String]) {
        if !self.is_enabled() || paths.is_empty() {
            return;
        }
        let Ok(snapshot) = index::snapshot_workspace(db) else {
            return;
        };
        let kb_path = Self::resolve_kb_db_path(db);
        let Ok(mut rt) = self.runtime.lock() else {
            return;
        };
        if !self.is_enabled() || !rt.include_folders {
            return;
        }
        let mounted = snapshot.mounted_folders;
        if rt.conn.is_none() || rt.db_path.as_ref() != Some(&kb_path) {
            rt.conn = index::open_kb_conn(&kb_path).ok();
            rt.db_path = Some(kb_path);
        }
        if let Some(ref mut conn) = rt.conn {
            if let Err(e) = index::sync_disk_paths_into_kb(conn, &mounted, paths) {
                rt.last_error = Some(e.to_string());
            } else {
                rt.last_indexed_at = Some(now_iso());
                rt.last_error = None;
            }
        }
    }

    pub fn search(&self, query: &str, limit: usize, hops: u8) -> Result<KbSearchResponse, AppError> {
        if !self.is_enabled() {
            return Ok(KbSearchResponse {
                query: query.trim().to_string(),
                total_sources: 0,
                total_events: 0,
                elapsed_ms: 0,
                hits: Vec::new(),
                top_entities: Vec::new(),
            });
        }
        let rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
        let Some(ref conn) = rt.conn else {
            return Ok(KbSearchResponse {
                query: query.trim().to_string(),
                total_sources: 0,
                total_events: 0,
                elapsed_ms: 0,
                hits: Vec::new(),
                top_entities: Vec::new(),
            });
        };
        query::search(conn, query, limit, hops)
    }

    pub fn related_for_context(
        &self,
        source_kind: &str,
        ref_id: &str,
        title: &str,
        content_text: &str,
        limit: usize,
    ) -> Result<KbRelatedResponse, AppError> {
        if !self.is_enabled() {
            return Ok(KbRelatedResponse {
                context_entities: Vec::new(),
                hits: Vec::new(),
                elapsed_ms: 0,
            });
        }
        let rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
        let Some(ref conn) = rt.conn else {
            return Ok(KbRelatedResponse {
                context_entities: Vec::new(),
                hits: Vec::new(),
                elapsed_ms: 0,
            });
        };
        query::related_for_context(conn, source_kind, ref_id, title, content_text, limit)
    }

    pub fn entity_events(&self, entity_name: &str, limit: usize) -> Result<Vec<KbSearchHit>, AppError> {
        if !self.is_enabled() {
            return Ok(Vec::new());
        }
        let rt = self.runtime.lock().map_err(|_| AppError::LockPoisoned)?;
        let Some(ref conn) = rt.conn else {
            return Ok(Vec::new());
        };
        query::entity_events(conn, entity_name, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CreatePageInput, SaveBlockItem};
    use std::time::UNIX_EPOCH;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xynote-kb-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn save_doc(db: &Database, title: &str, blocks: Vec<(&str, &str)>) -> String {
        let page = db
            .create_page(CreatePageInput {
                title: Some(title.to_string()),
                page_type: Some("doc".to_string()),
                ..Default::default()
            })
            .unwrap();
        let items: Vec<SaveBlockItem> = blocks
            .into_iter()
            .enumerate()
            .map(|(idx, (btype, text))| SaveBlockItem {
                id: format!("blk-{}-{}", page.id, idx),
                block_type: btype.to_string(),
                content: text.to_string(),
                plain_text: text.to_string(),
                props: Default::default(),
                sort_order: idx as i64,
            })
            .collect();
        db.save_page_blocks(&page.id, items).unwrap();
        page.id
    }

    #[test]
    fn default_disabled_creates_no_index_file() {
        let dir = temp_dir("default-off");
        let db = Database::open(dir.join("xynote.db")).unwrap();
        let kb = KbEngine::new();
        kb.init_from_settings(&db);

        let status = kb.get_status(&db).unwrap();
        assert!(!status.enabled);
        assert!(!status.db_exists);
        assert!(!dir.join(KB_DB_FILENAME).exists());
        assert!(kb.search("欢迎", 10, 1).unwrap().hits.is_empty());

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn enable_index_disable_and_purge_zero_trace() {
        let dir = temp_dir("purge");
        let db_path = dir.join("xynote.db");
        let db = Database::open(&db_path).unwrap();
        let _p1 = save_doc(&db, "架构设计", vec![("paragraph", "采用 SQLite WAL 存储。")]);

        let kb = KbEngine::new();
        let on_status = kb.set_enabled(&db, true, false).unwrap();
        assert!(on_status.enabled);
        assert!(on_status.db_exists);
        assert!(on_status.source_count >= 1);
        assert!(dir.join(KB_DB_FILENAME).exists());

        // 验证主库 xynote.db 绝无任何 kb_* 表或触发器
        {
            let conn = db.lock().unwrap();
            let kb_table_cnt: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'kb_%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(kb_table_cnt, 0);
        }

        let off_purged = kb.purge_index(&db).unwrap();
        assert!(!off_purged.enabled);
        assert!(!off_purged.db_exists);
        assert!(!dir.join(KB_DB_FILENAME).exists());
        assert!(!dir.join(format!("{}-wal", KB_DB_FILENAME)).exists());
        assert!(!dir.join(format!("{}-shm", KB_DB_FILENAME)).exists());

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cjk_and_mixed_bm25_and_punctuation_safe() {
        let dir = temp_dir("cjk");
        let db = Database::open(dir.join("xynote.db")).unwrap();
        let p_rust = save_doc(
            &db,
            "SQLite 中文检索调优",
            vec![
                ("heading1", "分词方案"),
                ("paragraph", "在 C++ 与 Rust 混合项目中，使用 QueryHyperedge 实现毫秒级知识检索。"),
            ],
        );

        let kb = KbEngine::new();
        kb.set_enabled(&db, true, false).unwrap();

        let res1 = kb.search("知识检索", 10, 1).unwrap();
        assert!(res1.hits.iter().any(|h| h.ref_id == p_rust));

        // 含特殊符号与 CamelCase 子词不得报 FTS5 语法错误
        let res2 = kb.search("C++ foo:bar* \"hyperedge\"", 10, 1).unwrap();
        assert!(res2.hits.iter().any(|h| h.ref_id == p_rust));

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sag2_dynamic_hyperedge_bridges_unlinked_documents() {
        let dir = temp_dir("hyperedge");
        let db = Database::open(dir.join("xynote.db")).unwrap();
        // Doc A 与 Doc B 无任何 [[WikiLink]]，但共享概念 "Redis" / "连接池"
        let doc_a = save_doc(
            &db,
            "Node1 网关故障复盘",
            vec![("paragraph", "线上网关持续返回 502 错误，排查发现 Redis 连接池已耗尽。")],
        );
        let doc_b = save_doc(
            &db,
            "周四性能压测报告",
            vec![("paragraph", "高并发压测期间，Redis 连接池连接数上限被瞬间打满。")],
        );
        let _doc_c = save_doc(
            &db,
            "食堂菜谱",
            vec![("paragraph", "今日午餐推荐红烧排骨与番茄炒蛋。")],
        );

        let kb = KbEngine::new();
        kb.set_enabled(&db, true, false).unwrap();

        // 1) 搜索只在 Doc A 出现的 "502"，通过查询时动态超边自动发现 Doc B
        let single_hop = kb.search("502", 10, 1).unwrap();
        let hit_a = single_hop.hits.iter().find(|h| h.ref_id == doc_a).expect("Doc A should hit directly");
        assert_eq!(hit_a.match_kind, "direct");
        let hit_b = single_hop.hits.iter().find(|h| h.ref_id == doc_b).expect("Doc B should be discovered via hyperedge");
        assert_eq!(hit_b.match_kind, "hyperedge");
        assert!(!hit_b.shared_entities.is_empty());

        // 2) 搜索跨两篇文档的问题 "压测 502"：两篇都命中并通过共享实体串联
        let multi_hop = kb.search("压测 502", 10, 1).unwrap();
        assert!(multi_hop.hits.iter().any(|h| h.ref_id == doc_a));
        assert!(multi_hop.hits.iter().any(|h| h.ref_id == doc_b));

        // 3) 右侧关联推荐面板：打开 Doc A 时实时推荐 Doc B 且不推荐自身
        let related = kb
            .related_for_context(
                "workspace_page",
                &doc_a,
                "Node1 网关故障复盘",
                "线上网关持续返回 502 错误，排查发现 Redis 连接池已耗尽。",
                6,
            )
            .unwrap();
        assert!(!related.hits.iter().any(|h| h.ref_id == doc_a));
        let rel_b = related.hits.iter().find(|h| h.ref_id == doc_b).expect("related_for_context should link Doc B");
        assert!(!rel_b.shared_entities.is_empty());

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mounted_folder_index_update_and_prune() {
        let dir = temp_dir("folder-sync");
        let notes_dir = dir.join("local-notes");
        std::fs::create_dir_all(&notes_dir).unwrap();
        let note_file = notes_dir.join("deploy-guide.md");
        std::fs::write(&note_file, "# 部署指南\n\n使用 Nginx 反代 XyNote 同步服务。\n").unwrap();

        let db = Database::open(dir.join("xynote.db")).unwrap();
        let folders_json = serde_json::json!([{
            "path": clean_display_path(&notes_dir),
            "name": "运维目录"
        }])
        .to_string();
        db.set_setting("workspaceFolders", &folders_json).unwrap();

        let kb = KbEngine::new();
        let st = kb.set_enabled(&db, true, false).unwrap();
        assert!(st.include_folders);

        let res = kb.search("Nginx 反代", 10, 1).unwrap();
        assert!(res
            .hits
            .iter()
            .any(|h| h.source_kind == "mounted_file" && h.root_name == "运维目录"));

        // 删除磁盘文件后触发增量路径同步，索引应同步清理
        std::fs::remove_file(&note_file).unwrap();
        kb.sync_disk_paths(&db, &[clean_display_path(&note_file)]);
        let res_after = kb.search("Nginx 反代", 10, 1).unwrap();
        assert!(!res_after
            .hits
            .iter()
            .any(|h| h.source_kind == "mounted_file"));

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn entity_timeline_returns_workspace_and_folder_hits() {
        let dir = temp_dir("timeline");
        let notes_dir = dir.join("notes");
        std::fs::create_dir_all(&notes_dir).unwrap();
        std::fs::write(notes_dir.join("incident.md"), "# 事故记录\n\nKafka 消费延迟升高。\n").unwrap();

        let db = Database::open(dir.join("xynote.db")).unwrap();
        let folders_json = serde_json::json!([{
            "path": clean_display_path(&notes_dir),
            "name": "笔记"
        }])
        .to_string();
        db.set_setting("workspaceFolders", &folders_json).unwrap();
        let p_ws = save_doc(&db, "消息队列方案", vec![("paragraph", "核心链路基于 Kafka 分区顺序消费。")]);

        let kb = KbEngine::new();
        kb.set_enabled(&db, true, false).unwrap();

        let timeline = kb.entity_events("Kafka", 20).unwrap();
        assert!(timeline.iter().any(|h| h.source_kind == "workspace_page" && h.ref_id == p_ws));
        assert!(timeline.iter().any(|h| h.source_kind == "mounted_file"));

        drop(kb);
        drop(db);
        std::fs::remove_dir_all(dir).ok();
    }
}
