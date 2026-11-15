//! 工作区同步引擎。
//!
//! 同步单位是「页面」：一个页面连同它的块、数据库元信息 / 列 / 行打成一份快照。
//! 远端只需要是一个「键 → 字节」的存储（网盘文件夹、WebDAV、XyNote 服务器），文件名形如
//! `pages/<页面id>~<内容哈希>.json`，列一次目录就知道每个页面的最新状态，不必逐个下载。
//!
//! 合并规则（三方合并，基线是上次同步时双方一致的内容哈希）：
//! - 只有一边改了：把改动同步到另一边；
//! - 两边都改了且内容不同：保留较新的一份在原页面，另一份另存为「冲突副本」页面，不丢任何内容；
//! - 一边删除、另一边修改：保留修改（删除不会吞掉别人的新内容）；
//! - 删除用墓碑记录（pages 表上的删除触发器），防止被旧设备「复活」。
//!
//! 可选端到端加密：AES-256-GCM，密钥由同步密码经 Argon2id 派生；远端只看到密文。

use crate::db::{new_id, now_iso, Database};
use crate::models::AppError;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SYNC_FORMAT: u32 = 1;
pub const META_KEY: &str = "xynote-sync.json";
pub const PAGES_PREFIX: &str = "pages/";
/// 新工作区自带的使用说明：首次同步时两边各有一份不算冲突
const SEED_PAGE_ID: &str = "page-welcome";

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: String,
    pub cover: Option<String>,
    pub page_type: String,
    pub is_favorite: i64,
    pub is_trashed: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockRow {
    pub id: String,
    pub block_type: String,
    pub content: String,
    pub plain_text: String,
    pub props_json: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DbMetaRow {
    pub active_view: String,
    pub group_by_col_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DbColumnRow {
    pub id: String,
    pub name: String,
    pub col_type: String,
    pub options_json: String,
    pub width: i64,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DbRowRow {
    pub id: String,
    pub cells_json: String,
    pub linked_page_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 一个页面的完整快照（字段顺序固定，序列化结果可直接用于计算内容哈希）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageSnapshot {
    pub page: PageRow,
    pub blocks: Vec<BlockRow>,
    pub db_meta: Option<DbMetaRow>,
    pub db_columns: Vec<DbColumnRow>,
    pub db_rows: Vec<DbRowRow>,
}

/// 远端每个文件的内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemotePageFile {
    pub format: u32,
    pub id: String,
    pub hash: String,
    pub deleted: bool,
    /// 写入时间（用于两边都改了时判断哪份较新）
    pub written_at: String,
    pub device: String,
    pub snapshot: Option<PageSnapshot>,
}

pub fn export_snapshot(conn: &Connection, page_id: &str) -> Result<Option<PageSnapshot>, AppError> {
    let page = conn
        .query_row(
            "SELECT id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at
             FROM pages WHERE id = ?1",
            params![page_id],
            |r| {
                Ok(PageRow {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    title: r.get(2)?,
                    icon: r.get(3)?,
                    cover: r.get(4)?,
                    page_type: r.get(5)?,
                    is_favorite: r.get(6)?,
                    is_trashed: r.get(7)?,
                    sort_order: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            },
        )
        .optional()?;
    let Some(page) = page else { return Ok(None) };

    let mut stmt = conn.prepare(
        "SELECT id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at
         FROM blocks WHERE page_id = ?1 ORDER BY sort_order, id",
    )?;
    let blocks = stmt
        .query_map(params![page_id], |r| {
            Ok(BlockRow {
                id: r.get(0)?,
                block_type: r.get(1)?,
                content: r.get(2)?,
                plain_text: r.get(3)?,
                props_json: r.get(4)?,
                sort_order: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let db_meta = conn
        .query_row(
            "SELECT active_view, group_by_col_id FROM db_meta WHERE page_id = ?1",
            params![page_id],
            |r| Ok(DbMetaRow { active_view: r.get(0)?, group_by_col_id: r.get(1)? }),
        )
        .optional()?;

    let mut stmt = conn.prepare(
        "SELECT id, name, col_type, options_json, width, sort_order FROM db_columns WHERE page_id = ?1 ORDER BY sort_order, id",
    )?;
    let db_columns = stmt
        .query_map(params![page_id], |r| {
            Ok(DbColumnRow {
                id: r.get(0)?,
                name: r.get(1)?,
                col_type: r.get(2)?,
                options_json: r.get(3)?,
                width: r.get(4)?,
                sort_order: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, cells_json, linked_page_id, sort_order, created_at, updated_at FROM db_rows WHERE page_id = ?1 ORDER BY sort_order, id",
    )?;
    let db_rows = stmt
        .query_map(params![page_id], |r| {
            Ok(DbRowRow {
                id: r.get(0)?,
                cells_json: r.get(1)?,
                linked_page_id: r.get(2)?,
                sort_order: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some(PageSnapshot { page, blocks, db_meta, db_columns, db_rows }))
}

/// 页面最后一次被编辑的时间：页面本身、块、数据库行里最晚的那个
pub fn edited_at(snap: &PageSnapshot) -> String {
    let mut t = snap.page.updated_at.clone();
    for b in &snap.blocks {
        if b.updated_at > t {
            t = b.updated_at.clone();
        }
    }
    for r in &snap.db_rows {
        if r.updated_at > t {
            t = r.updated_at.clone();
        }
    }
    t
}

/// 用快照整体替换本地页面（块、数据库内容一并替换）；不触碰其他页面
pub fn apply_snapshot(conn: &Connection, snap: &PageSnapshot) -> Result<(), AppError> {
    let p = &snap.page;
    conn.execute(
        "INSERT INTO pages (id, parent_id, title, icon, cover, page_type, is_favorite, is_trashed, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, title = excluded.title, icon = excluded.icon,
           cover = excluded.cover, page_type = excluded.page_type, is_favorite = excluded.is_favorite,
           is_trashed = excluded.is_trashed, sort_order = excluded.sort_order, created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![p.id, p.parent_id, p.title, p.icon, p.cover, p.page_type, p.is_favorite, p.is_trashed, p.sort_order, p.created_at, p.updated_at],
    )?;
    conn.execute("DELETE FROM blocks WHERE page_id = ?1", params![p.id])?;
    for b in &snap.blocks {
        conn.execute(
            "INSERT OR REPLACE INTO blocks (id, page_id, block_type, content, plain_text, props_json, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![b.id, p.id, b.block_type, b.content, b.plain_text, b.props_json, b.sort_order, b.created_at, b.updated_at],
        )?;
    }
    conn.execute("DELETE FROM db_meta WHERE page_id = ?1", params![p.id])?;
    if let Some(m) = &snap.db_meta {
        conn.execute(
            "INSERT INTO db_meta (page_id, active_view, group_by_col_id) VALUES (?1, ?2, ?3)",
            params![p.id, m.active_view, m.group_by_col_id],
        )?;
    }
    conn.execute("DELETE FROM db_columns WHERE page_id = ?1", params![p.id])?;
    for c in &snap.db_columns {
        conn.execute(
            "INSERT OR REPLACE INTO db_columns (id, page_id, name, col_type, options_json, width, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![c.id, p.id, c.name, c.col_type, c.options_json, c.width, c.sort_order],
        )?;
    }
    conn.execute("DELETE FROM db_rows WHERE page_id = ?1", params![p.id])?;
    for r in &snap.db_rows {
        conn.execute(
            "INSERT OR REPLACE INTO db_rows (id, page_id, cells_json, linked_page_id, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![r.id, p.id, r.cells_json, r.linked_page_id, r.sort_order, r.created_at, r.updated_at],
        )?;
    }
    // 远端带来的页面不应再被视为「本地已删除」
    conn.execute("DELETE FROM sync_tombstones WHERE page_id = ?1", params![p.id])?;
    Ok(())
}

/// 把快照另存为一个新页面（冲突副本）：页面、块、列、行都换成新 id，标题加上说明
pub fn clone_as_conflict_copy(snap: &PageSnapshot, label: &str) -> PageSnapshot {
    let mut copy = snap.clone();
    let new_page_id = new_id();
    copy.page.id = new_page_id;
    copy.page.title = format!("{}（冲突副本 · {}）", snap.page.title, label);
    copy.page.is_favorite = 0;
    let mut col_map = HashMap::new();
    for c in copy.db_columns.iter_mut() {
        let nid = new_id();
        col_map.insert(c.id.clone(), nid.clone());
        c.id = nid;
    }
    // 单元格以列 id 为键：同步改写
    for r in copy.db_rows.iter_mut() {
        r.id = new_id();
        if let Ok(serde_json::Value::Object(cells)) = serde_json::from_str::<serde_json::Value>(&r.cells_json) {
            let mut remapped = serde_json::Map::new();
            for (k, v) in cells {
                remapped.insert(col_map.get(&k).cloned().unwrap_or(k), v);
            }
            r.cells_json = serde_json::Value::Object(remapped).to_string();
        }
    }
    if let Some(meta) = copy.db_meta.as_mut() {
        if let Some(g) = meta.group_by_col_id.as_ref() {
            meta.group_by_col_id = col_map.get(g).cloned().or(Some(g.clone()));
        }
    }
    for b in copy.blocks.iter_mut() {
        b.id = new_id();
    }
    copy
}

/* ------------------------------------------------------------------ */
/* 加密与哈希                                                          */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMeta {
    pub format: u32,
    pub created_at: String,
    /// None 表示未加密
    pub encryption: Option<EncryptionMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptionMeta {
    pub kdf: String,
    pub salt: String,
    /// 用派生密钥加密的固定字符串，用来校验同步密码是否正确
    pub check: String,
}

const CHECK_PLAINTEXT: &[u8] = b"xynote-sync-key-check-v1";

/// 用同步密码和盐派生 32 字节密钥（Argon2id，默认参数）
pub fn derive_key(passphrase: &str, salt_b64: &str) -> Result<[u8; 32], AppError> {
    let salt = b64().decode(salt_b64).map_err(|_| AppError::Validation("同步配置损坏（盐）".into()))?;
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|e| AppError::Validation(format!("无法派生密钥：{}", e)))?;
    Ok(key)
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

pub fn encrypt(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Validation("密钥无效".into()))?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| AppError::Validation("加密失败".into()))?;
    let mut out = b"XYENC1".to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, AppError> {
    if data.len() < 6 + 12 + 16 || &data[..6] != b"XYENC1" {
        return Err(AppError::Validation("远端数据不是加密格式".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Validation("密钥无效".into()))?;
    cipher
        .decrypt(Nonce::from_slice(&data[6..18]), &data[18..])
        .map_err(|_| AppError::Validation("解密失败：同步密码不正确或数据损坏".into()))
}

pub fn new_encryption_meta(passphrase: &str) -> Result<(EncryptionMeta, [u8; 32]), AppError> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt_b64 = b64().encode(salt);
    let key = derive_key(passphrase, &salt_b64)?;
    let check = b64().encode(encrypt(&key, CHECK_PLAINTEXT)?);
    Ok((EncryptionMeta { kdf: "argon2id".into(), salt: salt_b64, check }, key))
}

pub fn verify_key(meta: &EncryptionMeta, key: &[u8; 32]) -> bool {
    b64()
        .decode(&meta.check)
        .ok()
        .and_then(|c| decrypt(key, &c).ok())
        .map(|p| p == CHECK_PLAINTEXT)
        .unwrap_or(false)
}

/// 内容哈希：未加密用 SHA-256；加密时用 HMAC，避免远端凭哈希猜测内容
pub fn content_hash(snap: &PageSnapshot, key: Option<&[u8; 32]>) -> String {
    let bytes = serde_json::to_vec(snap).unwrap_or_default();
    let digest: Vec<u8> = match key {
        Some(k) => {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(k).expect("hmac key");
            mac.update(&bytes);
            mac.finalize().into_bytes().to_vec()
        }
        None => Sha256::digest(&bytes).to_vec(),
    };
    digest.iter().take(10).map(|b| format!("{:02x}", b)).collect()
}

/* ------------------------------------------------------------------ */
/* 远端                                                                */
/* ------------------------------------------------------------------ */

/// 远端存储：只需要「列出 / 读 / 写 / 删」四个操作
pub trait SyncRemote {
    /// 列出 `prefix` 下所有文件的键（相对根目录，用 / 分隔）
    fn list(&self, prefix: &str) -> Result<Vec<String>, AppError>;
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, AppError>;
    fn write(&self, key: &str, data: &[u8]) -> Result<(), AppError>;
    fn remove(&self, key: &str) -> Result<(), AppError>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteKey {
    pub key: String,
    pub id: String,
    pub hash: String,
}

/// 解析 `pages/<id>~<hash>.json`
pub fn parse_page_key(key: &str) -> Option<RemoteKey> {
    let name = key.strip_prefix(PAGES_PREFIX)?.strip_suffix(".json")?;
    let (id, hash) = name.rsplit_once('~')?;
    if id.is_empty() || hash.is_empty() || id.contains('/') {
        return None;
    }
    Some(RemoteKey { key: key.to_string(), id: id.to_string(), hash: hash.to_string() })
}

pub fn page_key(id: &str, hash: &str) -> String {
    format!("{}{}~{}.json", PAGES_PREFIX, id, hash)
}

/* ------------------------------------------------------------------ */
/* 同步过程                                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub conflicts: usize,
    pub conflict_titles: Vec<String>,
    pub finished_at: String,
    pub encrypted: bool,
}

pub struct SyncOptions<'a> {
    /// 同步密码；远端已加密时必须提供，远端还没初始化时提供则启用加密
    pub passphrase: Option<&'a str>,
    /// 本机名称，写入远端文件便于排查
    pub device: &'a str,
}

const DELETED_HASH: &str = "deleted";

fn local_state(conn: &Connection) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let mut base = HashMap::new();
    let mut stmt = conn.prepare("SELECT page_id, base_hash FROM sync_state")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, v) = row?;
        base.insert(k, v);
    }
    let mut tombs = HashMap::new();
    let mut stmt = conn.prepare("SELECT page_id, deleted_at FROM sync_tombstones")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, v) = row?;
        tombs.insert(k, v);
    }
    Ok((base, tombs))
}

fn set_base(conn: &Connection, id: &str, hash: Option<&str>) -> Result<(), AppError> {
    match hash {
        Some(h) => conn.execute(
            "INSERT INTO sync_state (page_id, base_hash) VALUES (?1, ?2)
             ON CONFLICT(page_id) DO UPDATE SET base_hash = excluded.base_hash",
            params![id, h],
        )?,
        None => conn.execute("DELETE FROM sync_state WHERE page_id = ?1", params![id])?,
    };
    Ok(())
}

/// 远端 vault：读取或初始化元信息，返回加密密钥（未加密时为 None）
fn open_vault(remote: &dyn SyncRemote, passphrase: Option<&str>) -> Result<Option<[u8; 32]>, AppError> {
    match remote.read(META_KEY)? {
        Some(bytes) => {
            let meta: VaultMeta = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::Validation("远端的同步配置文件损坏".into()))?;
            if meta.format > SYNC_FORMAT {
                return Err(AppError::Validation("远端数据来自更新版本的小悦，请先升级".into()));
            }
            match meta.encryption {
                None => Ok(None),
                Some(enc) => {
                    let pass = passphrase
                        .filter(|p| !p.is_empty())
                        .ok_or_else(|| AppError::Validation("远端数据已加密，请填写同步密码".into()))?;
                    let key = derive_key(pass, &enc.salt)?;
                    if !verify_key(&enc, &key) {
                        return Err(AppError::Validation("同步密码不正确".into()));
                    }
                    Ok(Some(key))
                }
            }
        }
        None => {
            let (encryption, key) = match passphrase.filter(|p| !p.is_empty()) {
                Some(p) => {
                    let (m, k) = new_encryption_meta(p)?;
                    (Some(m), Some(k))
                }
                None => (None, None),
            };
            let meta = VaultMeta { format: SYNC_FORMAT, created_at: now_iso(), encryption };
            remote.write(META_KEY, &serde_json::to_vec_pretty(&meta)?)?;
            Ok(key)
        }
    }
}

fn encode_file(file: &RemotePageFile, key: Option<&[u8; 32]>) -> Result<Vec<u8>, AppError> {
    let plain = serde_json::to_vec(file)?;
    match key {
        Some(k) => encrypt(k, &plain),
        None => Ok(plain),
    }
}

fn decode_file(bytes: &[u8], key: Option<&[u8; 32]>) -> Result<RemotePageFile, AppError> {
    let plain = match key {
        Some(k) => decrypt(k, bytes)?,
        None => bytes.to_vec(),
    };
    serde_json::from_slice(&plain).map_err(|_| AppError::Validation("远端页面文件损坏".into()))
}

fn short_device_label(device: &str, at: &str) -> String {
    let day = at.get(..16).unwrap_or(at).replace('T', " ");
    if device.is_empty() {
        day
    } else {
        format!("{} {}", device, day)
    }
}

/// 上传一个本地新建的页面（冲突副本），返回它的内容哈希
fn upload_new_page(
    remote: &dyn SyncRemote,
    snap: &PageSnapshot,
    key: Option<&[u8; 32]>,
    device: &str,
) -> Result<String, AppError> {
    let hash = content_hash(snap, key);
    let file = RemotePageFile {
        format: SYNC_FORMAT,
        id: snap.page.id.clone(),
        hash: hash.clone(),
        deleted: false,
        written_at: now_iso(),
        device: device.to_string(),
        snapshot: Some(snap.clone()),
    };
    remote.write(&page_key(&snap.page.id, &hash), &encode_file(&file, key)?)?;
    Ok(hash)
}

/// 执行一次完整同步。网络操作期间不持有数据库锁；写入本地前会再次确认页面没在这期间被改过。
pub fn run_sync(db: &Database, remote: &dyn SyncRemote, opts: &SyncOptions) -> Result<SyncReport, AppError> {
    let key = open_vault(remote, opts.passphrase)?;
    let key_ref = key.as_ref();
    let mut report = SyncReport { encrypted: key.is_some(), ..Default::default() };

    // 1. 远端：按页面分组（网盘可能同时出现同一页面的多个版本）
    let mut remote_by_id: BTreeMap<String, Vec<RemoteKey>> = BTreeMap::new();
    for k in remote.list(PAGES_PREFIX)? {
        if let Some(rk) = parse_page_key(&k) {
            remote_by_id.entry(rk.id.clone()).or_default().push(rk);
        }
    }

    // 2. 本地：所有页面的快照与哈希、基线、墓碑
    let (local_snaps, base, tombs) = {
        let conn = db.lock()?;
        let (base, tombs) = local_state(&conn)?;
        let ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM pages")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut snaps = HashMap::new();
        for id in ids {
            if let Some(s) = export_snapshot(&conn, &id)? {
                let h = content_hash(&s, key_ref);
                snaps.insert(id, (s, h));
            }
        }
        (snaps, base, tombs)
    };

    let mut all_ids: HashSet<String> = HashSet::new();
    all_ids.extend(local_snaps.keys().cloned());
    all_ids.extend(remote_by_id.keys().cloned());
    all_ids.extend(tombs.keys().cloned());
    all_ids.extend(base.keys().cloned());

    // 收集要在本地落地的操作，最后一次性在事务里执行
    enum LocalOp {
        Apply(PageSnapshot, String),
        Delete(String),
        SetBase(String, Option<String>),
    }
    let mut ops: Vec<LocalOp> = Vec::new();
    let mut expected_local: HashMap<String, Option<String>> = HashMap::new();
    let mut touched_pages: Vec<String> = Vec::new();

    let mut sorted_ids: Vec<String> = all_ids.into_iter().collect();
    sorted_ids.sort();

    for id in sorted_ids {
        let local = local_snaps.get(&id);
        let local_hash = local.map(|(_, h)| h.clone());
        let base_hash = base.get(&id).cloned();
        let locally_deleted = local.is_none() && tombs.contains_key(&id);
        expected_local.insert(id.clone(), local_hash.clone());

        // 远端多个版本时：读取全部，取写入时间最新的作为远端状态，其他与之不同的版本另存为冲突副本
        let mut remote_file: Option<RemotePageFile> = None;
        let mut stale_keys: Vec<String> = Vec::new();
        if let Some(keys) = remote_by_id.get(&id) {
            if keys.len() == 1 && Some(&keys[0].hash) == base_hash.as_ref() && local_hash.as_ref() == base_hash.as_ref() {
                // 两边都没变：不必下载
                continue;
            }
            let mut files: Vec<(RemoteKey, RemotePageFile)> = Vec::new();
            for k in keys {
                if let Some(bytes) = remote.read(&k.key)? {
                    files.push((k.clone(), decode_file(&bytes, key_ref)?));
                }
            }
            // 按内容的编辑时间排序（删除没有内容，用写入时间）
            let order_key = |f: &RemotePageFile| f.snapshot.as_ref().map(edited_at).unwrap_or_else(|| f.written_at.clone());
            files.sort_by(|a, b| order_key(&a.1).cmp(&order_key(&b.1)));
            if let Some((newest_key, newest)) = files.pop() {
                for (k, f) in files {
                    stale_keys.push(k.key.clone());
                    if f.hash != newest.hash && Some(&f.hash) != base_hash.as_ref() {
                        if let Some(s) = f.snapshot.as_ref() {
                            let copy = clone_as_conflict_copy(s, &short_device_label(&f.device, &f.written_at));
                            report.conflicts += 1;
                            report.conflict_titles.push(s.page.title.clone());
                            let h = upload_new_page(remote, &copy, key_ref, opts.device)?;
                            ops.push(LocalOp::Apply(copy, h));
                        }
                    }
                }
                let _ = newest_key;
                remote_file = Some(newest);
            }
        }

        let remote_hash = remote_file.as_ref().map(|f| if f.deleted { DELETED_HASH.to_string() } else { f.hash.clone() });
        let local_state_hash = if locally_deleted { Some(DELETED_HASH.to_string()) } else { local_hash.clone() };

        let local_changed = local_state_hash != base_hash && local_state_hash.is_some();
        let remote_changed = remote_hash != base_hash && remote_hash.is_some();

        let push = |snap: Option<&PageSnapshot>, hash: &str, ops: &mut Vec<LocalOp>, report: &mut SyncReport| -> Result<(), AppError> {
            let file = RemotePageFile {
                format: SYNC_FORMAT,
                id: id.clone(),
                hash: hash.to_string(),
                deleted: snap.is_none(),
                written_at: now_iso(),
                device: opts.device.to_string(),
                snapshot: snap.cloned(),
            };
            let new_key = page_key(&id, hash);
            remote.write(&new_key, &encode_file(&file, key_ref)?)?;
            // 新文件写好之后再删除旧版本，中途失败也不会丢数据
            if let Some(keys) = remote_by_id.get(&id) {
                for k in keys {
                    if k.key != new_key {
                        remote.remove(&k.key)?;
                    }
                }
            }
            if snap.is_some() {
                report.uploaded += 1;
            } else {
                report.deleted_remote += 1;
            }
            ops.push(LocalOp::SetBase(id.clone(), Some(hash.to_string())));
            Ok(())
        };

        match (local_changed, remote_changed) {
            (false, false) => {
                // 一致或都不存在：整理基线
                if local_state_hash.is_none() && remote_hash.is_none() {
                    ops.push(LocalOp::SetBase(id.clone(), None));
                }
            }
            (true, false) => match local {
                Some((s, h)) => push(Some(s), h, &mut ops, &mut report)?,
                None => {
                    if remote_hash.is_some() {
                        push(None, DELETED_HASH, &mut ops, &mut report)?;
                    } else {
                        ops.push(LocalOp::SetBase(id.clone(), None));
                    }
                }
            },
            (false, true) => {
                let f = remote_file.as_ref().expect("remote changed implies file");
                if f.deleted {
                    if local.is_some() {
                        ops.push(LocalOp::Delete(id.clone()));
                        report.deleted_local += 1;
                    }
                    ops.push(LocalOp::SetBase(id.clone(), Some(DELETED_HASH.to_string())));
                } else if let Some(s) = f.snapshot.clone() {
                    ops.push(LocalOp::Apply(s, f.hash.clone()));
                    report.downloaded += 1;
                    touched_pages.push(id.clone());
                }
            }
            (true, true) => {
                let f = remote_file.as_ref().expect("remote changed implies file");
                if local_state_hash == remote_hash {
                    ops.push(LocalOp::SetBase(id.clone(), local_state_hash.clone()));
                } else if f.deleted {
                    // 远端删除、本地修改：保留本地修改
                    if let Some((s, h)) = local {
                        push(Some(s), h, &mut ops, &mut report)?;
                    }
                } else if locally_deleted {
                    // 本地删除、远端修改：恢复远端版本
                    if let Some(s) = f.snapshot.clone() {
                        ops.push(LocalOp::Apply(s, f.hash.clone()));
                        report.downloaded += 1;
                        touched_pages.push(id.clone());
                    }
                } else if let (Some((ls, lh)), Some(rs)) = (local, f.snapshot.clone()) {
                    // 两边都改了：较新的留在原页面，另一份存为冲突副本（新工作区自带的使用说明除外）
                    let local_newer = edited_at(ls) > edited_at(&rs);
                    let (keep, keep_hash, other, other_label) = if local_newer {
                        (ls.clone(), lh.clone(), rs.clone(), short_device_label(&f.device, &f.written_at))
                    } else {
                        (rs.clone(), f.hash.clone(), ls.clone(), short_device_label(opts.device, &ls.page.updated_at))
                    };
                    let skip_copy = id == SEED_PAGE_ID && base_hash.is_none();
                    if !skip_copy {
                        let copy = clone_as_conflict_copy(&other, &other_label);
                        // 冲突副本当场上传，其他设备下次同步就能看到
                        let ch = upload_new_page(remote, &copy, key_ref, opts.device)?;
                        report.conflicts += 1;
                        report.conflict_titles.push(other.page.title.clone());
                        ops.push(LocalOp::Apply(copy, ch));
                    }
                    if local_newer {
                        push(Some(&keep), &keep_hash, &mut ops, &mut report)?;
                    } else {
                        ops.push(LocalOp::Apply(keep, keep_hash));
                        report.downloaded += 1;
                        touched_pages.push(id.clone());
                    }
                }
            }
        }

        // 已被新版本取代的远端旧文件（只在没有 push 的情况下需要单独清理）
        if !stale_keys.is_empty() {
            for k in stale_keys {
                let _ = remote.remove(&k);
            }
        }
    }

    // 3. 落地到本地：一次事务；期间被用户改过的页面跳过，下次同步再处理
    {
        let mut conn = db.lock()?;
        let pro = crate::license::is_pro_conn(&conn);
        let tx = conn.transaction()?;
        let mut applied_ids = Vec::new();
        for op in ops {
            match op {
                LocalOp::Apply(snap, hash) => {
                    let id = snap.page.id.clone();
                    if let Some(expected) = expected_local.get(&id) {
                        let now_hash = export_snapshot(&tx, &id)?.map(|s| content_hash(&s, key_ref));
                        if &now_hash != expected {
                            continue;
                        }
                    }
                    // 永久版：被其他设备的版本覆盖前，先保存一份本地历史
                    if pro {
                        crate::versions::checkpoint(&tx, &id, "sync", 0)?;
                    }
                    apply_snapshot(&tx, &snap)?;
                    set_base(&tx, &id, Some(&hash))?;
                    applied_ids.push(id);
                }
                LocalOp::Delete(id) => {
                    tx.execute("UPDATE db_rows SET linked_page_id = NULL WHERE linked_page_id = ?1", params![id])?;
                    tx.execute("DELETE FROM pages WHERE id = ?1", params![id])?;
                    tx.execute("DELETE FROM sync_tombstones WHERE page_id = ?1", params![id])?;
                }
                LocalOp::SetBase(id, hash) => {
                    set_base(&tx, &id, hash.as_deref())?;
                    if hash.is_none() || hash.as_deref() == Some(DELETED_HASH) {
                        tx.execute("DELETE FROM sync_tombstones WHERE page_id = ?1", params![id])?;
                    }
                }
            }
        }
        for id in &applied_ids {
            Database::rebuild_page_links_internal(&tx, id)?;
        }
        tx.commit()?;
        if !applied_ids.is_empty() || report.deleted_local > 0 {
            crate::storage::after_tree_mutated(&conn);
        }
    }

    report.finished_at = now_iso();
    let _ = touched_pages;
    Ok(report)
}

/// 建表语句：同步基线与删除墓碑（由 db.rs 在初始化时执行）
pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS sync_state (
        page_id TEXT PRIMARY KEY,
        base_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_tombstones (
        page_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_pages_sync_tombstone AFTER DELETE ON pages BEGIN
        INSERT OR REPLACE INTO sync_tombstones(page_id, deleted_at)
        VALUES (old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BlockProps, CreatePageInput, SaveBlockItem, UpdatePagePatch};
    use std::cell::RefCell;

    /// 内存里的远端，用于模拟两台设备通过同一个网盘同步
    #[derive(Default)]
    struct MemRemote {
        files: RefCell<BTreeMap<String, Vec<u8>>>,
    }
    impl SyncRemote for MemRemote {
        fn list(&self, prefix: &str) -> Result<Vec<String>, AppError> {
            Ok(self.files.borrow().keys().filter(|k| k.starts_with(prefix)).cloned().collect())
        }
        fn read(&self, key: &str) -> Result<Option<Vec<u8>>, AppError> {
            Ok(self.files.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, data: &[u8]) -> Result<(), AppError> {
            self.files.borrow_mut().insert(key.to_string(), data.to_vec());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), AppError> {
            self.files.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn opts<'a>(device: &'a str, pass: Option<&'a str>) -> SyncOptions<'a> {
        SyncOptions { passphrase: pass, device }
    }

    fn write_text(db: &Database, page_id: &str, text: &str) {
        db.save_page_blocks(
            page_id,
            vec![SaveBlockItem {
                id: format!("{}-b1", page_id),
                block_type: "paragraph".into(),
                content: text.into(),
                plain_text: String::new(),
                props: BlockProps::default(),
                sort_order: 0,
            }],
        )
        .unwrap();
    }

    fn text_of(db: &Database, page_id: &str) -> String {
        db.get_page_detail(page_id).unwrap().blocks.iter().map(|b| b.content.clone()).collect::<Vec<_>>().join("|")
    }

    fn titles(db: &Database) -> Vec<String> {
        let mut t: Vec<String> = db.list_pages().unwrap().into_iter().map(|p| p.title).collect();
        t.sort();
        t
    }

    #[test]
    fn two_devices_converge_and_deletions_propagate() {
        let remote = MemRemote::default();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();

        let p = a.create_page(CreatePageInput { title: Some("会议纪要".into()), ..Default::default() }).unwrap();
        write_text(&a, &p.id, "第一版");
        let r1 = run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert!(r1.uploaded >= 2);

        let r2 = run_sync(&b, &remote, &opts("B", None)).unwrap();
        assert!(r2.downloaded >= 1);
        assert_eq!(text_of(&b, &p.id), "第一版");
        assert_eq!(r2.conflicts, 0, "两边各自的使用说明不应算冲突");

        // B 修改，A 收到
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_text(&b, &p.id, "B 改过");
        run_sync(&b, &remote, &opts("B", None)).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert_eq!(text_of(&a, &p.id), "B 改过");

        // 再同步一次：没有任何上传下载
        let idle = run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert_eq!((idle.uploaded, idle.downloaded), (0, 0));

        // A 永久删除，B 跟着删除，且不会被 B 重新上传
        a.delete_page_permanently(&p.id).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        let rb = run_sync(&b, &remote, &opts("B", None)).unwrap();
        assert_eq!(rb.deleted_local, 1);
        assert!(b.get_page_detail(&p.id).is_err());
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert!(a.get_page_detail(&p.id).is_err(), "删除不应被复活");
    }

    #[test]
    fn concurrent_edits_keep_both_versions() {
        let remote = MemRemote::default();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();
        let p = a.create_page(CreatePageInput { title: Some("周报".into()), ..Default::default() }).unwrap();
        write_text(&a, &p.id, "原稿");
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        run_sync(&b, &remote, &opts("B", None)).unwrap();

        write_text(&a, &p.id, "A 的修改");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_text(&b, &p.id, "B 的修改");
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        let rb = run_sync(&b, &remote, &opts("B", None)).unwrap();
        assert_eq!(rb.conflicts, 1);
        run_sync(&a, &remote, &opts("A", None)).unwrap();

        // 两台设备最终一致：原页面是较新的 B，另有一份 A 的冲突副本
        assert_eq!(text_of(&a, &p.id), "B 的修改");
        assert_eq!(text_of(&b, &p.id), "B 的修改");
        for db in [&a, &b] {
            let pages = db.list_pages().unwrap();
            let copy = pages.iter().find(|x| x.title.starts_with("周报（冲突副本")).expect("conflict copy");
            assert_eq!(text_of(db, &copy.id), "A 的修改");
        }
        assert_eq!(titles(&a), titles(&b));
    }

    #[test]
    fn edit_wins_over_remote_delete_and_trash_state_syncs() {
        let remote = MemRemote::default();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();
        let p = a.create_page(CreatePageInput { title: Some("草稿".into()), ..Default::default() }).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        run_sync(&b, &remote, &opts("B", None)).unwrap();

        a.delete_page_permanently(&p.id).unwrap();
        write_text(&b, &p.id, "B 还在写");
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        run_sync(&b, &remote, &opts("B", None)).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert_eq!(text_of(&a, &p.id), "B 还在写", "修改优先于删除");

        b.update_page(&p.id, UpdatePagePatch { title: Some("草稿 v2".into()), ..Default::default() }).unwrap();
        b.trash_page(&p.id).unwrap();
        run_sync(&b, &remote, &opts("B", None)).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        assert!(a.list_trashed_pages().unwrap().iter().any(|x| x.title == "草稿 v2"));
    }

    #[test]
    fn encrypted_vault_requires_correct_passphrase() {
        let remote = MemRemote::default();
        let a = Database::open_in_memory().unwrap();
        let p = a.create_page(CreatePageInput { title: Some("机密".into()), ..Default::default() }).unwrap();
        write_text(&a, &p.id, "只有我能看到");
        let r = run_sync(&a, &remote, &opts("A", Some("correct horse"))).unwrap();
        assert!(r.encrypted);
        for (k, v) in remote.files.borrow().iter() {
            if k.starts_with(PAGES_PREFIX) {
                assert!(!String::from_utf8_lossy(v).contains("只有我能看到"), "远端只能看到密文");
            }
        }
        let b = Database::open_in_memory().unwrap();
        assert!(run_sync(&b, &remote, &opts("B", None)).is_err());
        assert!(run_sync(&b, &remote, &opts("B", Some("wrong"))).is_err());
        run_sync(&b, &remote, &opts("B", Some("correct horse"))).unwrap();
        assert_eq!(text_of(&b, &p.id), "只有我能看到");
    }

    #[test]
    fn database_pages_sync_columns_and_rows() {
        let remote = MemRemote::default();
        let a = Database::open_in_memory().unwrap();
        let b = Database::open_in_memory().unwrap();
        let tasks = a.create_page(CreatePageInput { template_id: Some("task-hub".into()), ..Default::default() }).unwrap();
        run_sync(&a, &remote, &opts("A", None)).unwrap();
        run_sync(&b, &remote, &opts("B", None)).unwrap();
        let fa = a.get_database(&tasks.id).unwrap();
        let fb = b.get_database(&tasks.id).unwrap();
        assert_eq!(fa.columns.len(), fb.columns.len());
        assert_eq!(fa.rows.len(), fb.rows.len());
        assert_eq!(serde_json::to_string(&fa.rows).unwrap(), serde_json::to_string(&fb.rows).unwrap());
    }

    #[test]
    fn page_keys_roundtrip() {
        let k = page_key("abc-123", "ff00");
        assert_eq!(parse_page_key(&k).unwrap().id, "abc-123");
        assert!(parse_page_key("pages/readme.txt").is_none());
        assert!(parse_page_key("other/a~b.json").is_none());
    }
}
