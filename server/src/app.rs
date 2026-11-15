use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub allow_registration: bool,
    pub require_subscription: bool,
    pub default_quota_bytes: u64,
    pub admin_token: Option<String>,
    /// FWPT 通行证后端（官方部署），例如 http://127.0.0.1:8088；为空时使用本服务自己的账号
    pub oneid_base: Option<String>,
    /// 允许跨域调用的网站，例如 https://fwpt.cn
    pub cors_origins: Vec<String>,
    /// 永久版签名私钥文件（tools/license keygen 生成）
    pub license_key_file: Option<PathBuf>,
    /// 永久版价格（分）
    pub price_lifetime_cents: i64,
}

impl Config {
    pub fn from_env() -> Self {
        let num = |k: &str, d: i64| std::env::var(k).ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(d);
        let flag = |k: &str, d: bool| std::env::var(k).map(|v| matches!(v.as_str(), "1" | "true" | "yes")).unwrap_or(d);
        Self {
            bind: std::env::var("XYNOTE_BIND").unwrap_or_else(|_| "0.0.0.0:8787".into()),
            data_dir: PathBuf::from(std::env::var("XYNOTE_DATA_DIR").unwrap_or_else(|_| "./data".into())),
            allow_registration: flag("XYNOTE_ALLOW_REGISTRATION", true),
            require_subscription: flag("XYNOTE_REQUIRE_SUBSCRIPTION", false),
            default_quota_bytes: std::env::var("XYNOTE_DEFAULT_QUOTA_MB")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(2048)
                * 1024
                * 1024,
            admin_token: std::env::var("XYNOTE_ADMIN_TOKEN").ok().filter(|t| t.len() >= 16),
            oneid_base: std::env::var("XYNOTE_ONEID_BASE").ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty()),
            cors_origins: std::env::var("XYNOTE_CORS_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            license_key_file: std::env::var("XYNOTE_LICENSE_KEY_FILE").ok().filter(|v| !v.trim().is_empty()).map(PathBuf::from),
            price_lifetime_cents: num("XYNOTE_PRICE_LIFETIME_CENTS", 990),
        }
    }
}

pub struct Inner {
    pub config: Config,
    pub conn: Mutex<Connection>,
    /// 通行证令牌校验结果缓存（令牌哈希 → 过期时间与资料）
    pub oneid_cache: Mutex<HashMap<String, (Instant, crate::oneid::OneIdUser)>>,
    pub signing_key: Option<ed25519_dalek::SigningKey>,
}

const ONEID_CACHE_TTL: Duration = Duration::from_secs(300);

pub type AppState = Arc<Inner>;

pub trait OpenState {
    fn open(config: Config) -> Result<AppState, String>;
}

impl OpenState for AppState {
    fn open(config: Config) -> Result<AppState, String> {
        std::fs::create_dir_all(config.data_dir.join("files")).map_err(|e| e.to_string())?;
        let conn = Connection::open(config.data_dir.join("server.db")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS users (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 email TEXT NOT NULL UNIQUE,
                 password_hash TEXT NOT NULL,
                 plan TEXT NOT NULL DEFAULT 'free',
                 plan_expires_at TEXT NULL,
                 quota_bytes INTEGER NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tokens (
                 token_hash TEXT PRIMARY KEY,
                 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 created_at TEXT NOT NULL,
                 last_used_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS files (
                 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 key TEXT NOT NULL,
                 size INTEGER NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY (user_id, key)
             );
             CREATE TABLE IF NOT EXISTS activation_codes (
                 code_hash TEXT PRIMARY KEY,
                 plan TEXT NOT NULL,
                 days INTEGER NOT NULL,
                 quota_mb INTEGER NULL,
                 note TEXT NOT NULL DEFAULT '',
                 created_at TEXT NOT NULL,
                 redeemed_by INTEGER NULL REFERENCES users(id),
                 redeemed_at TEXT NULL
             );",
        )
        .map_err(|e| e.to_string())?;
        // 旧库升级：通行证账号字段
        let has_col = |name: &str| -> bool {
            conn.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?1")
                .and_then(|mut s| s.exists(params![name]))
                .unwrap_or(false)
        };
        for (col, ddl) in [
            ("oneid_key", "ALTER TABLE users ADD COLUMN oneid_key TEXT NULL"),
            ("display_name", "ALTER TABLE users ADD COLUMN display_name TEXT NULL"),
            ("role", "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT ''"),
            ("contact_email", "ALTER TABLE users ADD COLUMN contact_email TEXT NULL"),
            ("trial_until", "ALTER TABLE users ADD COLUMN trial_until TEXT NULL"),
        ] {
            if !has_col(col) {
                conn.execute_batch(ddl).map_err(|e| e.to_string())?;
            }
        }
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oneid ON users(oneid_key) WHERE oneid_key IS NOT NULL;")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(crate::store::SCHEMA_SQL).map_err(|e| e.to_string())?;
        conn.execute_batch(crate::licensing::SCHEMA_SQL).map_err(|e| e.to_string())?;
        let signing_key = match &config.license_key_file {
            Some(path) => {
                let raw = std::fs::read_to_string(path).map_err(|e| format!("读取永久版签名私钥失败：{}", e))?;
                let bytes = crate::license_format::parse_hex32(&raw).ok_or("永久版签名私钥格式不正确")?;
                Some(ed25519_dalek::SigningKey::from_bytes(&bytes))
            }
            None => None,
        };
        Ok(Arc::new(Inner { config, conn: Mutex::new(conn), oneid_cache: Mutex::new(HashMap::new()), signing_key }))
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/v1/auth/register", post(register))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/account", get(account))
        .route("/api/v1/files", get(list_files))
        .route("/api/v1/files/*key", get(read_file).put(write_file).delete(delete_file))
        .route("/api/v1/redeem", post(redeem))
        .route("/api/v1/license/activate", post(license_activate))
        .route("/api/v1/license/deactivate", post(license_deactivate))
        .route("/api/v1/store/products", get(store_products))
        .route("/api/v1/store/orders", get(my_orders).post(create_order))
        .route("/api/v1/store/orders/:id/cancel", post(cancel_order))
        .route("/api/v1/admin/orders", get(admin_list_orders))
        .route("/api/v1/admin/orders/:id/confirm", post(admin_confirm_order))
        .route("/api/v1/admin/orders/:id/reject", post(admin_reject_order))
        .route("/api/v1/admin/stats", get(admin_stats))
        .route("/api/v1/admin/license-codes", get(admin_list_codes).post(admin_create_codes_v2))
        .route("/api/v1/admin/license-codes/:code/reset", post(admin_reset_code))
        .route("/api/v1/admin/license-codes/:code/revoke", post(admin_revoke_code))
        .route("/api/v1/admin/users/plan", post(admin_set_plan))
        .route("/api/v1/admin/codes", post(admin_create_codes))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(cors_layer(&state.config.cors_origins))
        .with_state(state)
}

fn cors_layer(origins: &[String]) -> tower_http::cors::CorsLayer {
    use axum::http::{header, HeaderValue, Method};
    use tower_http::cors::{AllowOrigin, CorsLayer};
    let list: Vec<HeaderValue> = origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()).collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(list))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(Duration::from_secs(3600))
}

/* ---------------- 工具 ---------------- */

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn err(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "message": message }))).into_response()
}

fn internal(e: impl std::fmt::Display) -> Response {
    eprintln!("内部错误：{}", e);
    err(StatusCode::INTERNAL_SERVER_ERROR, "服务器内部错误")
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

/// 键只允许相对路径，禁止 .. 与反斜杠
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 300
        && !key.starts_with('/')
        && !key.contains('\\')
        && !key.chars().any(|c| c.is_control())
        && key.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn file_path(state: &AppState, user_id: i64, key: &str) -> PathBuf {
    // 磁盘上用键的哈希命名，避免任何路径相关的问题
    state.config.data_dir.join("files").join(user_id.to_string()).join(sha256_hex(key))
}

#[derive(Debug, Clone)]
struct User {
    id: i64,
    email: String,
    plan: String,
    plan_expires_at: Option<String>,
    quota_bytes: u64,
    display_name: Option<String>,
    role: String,
}

impl User {
    fn display(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.email)
    }
}

fn subscription_active(u: &User) -> bool {
    if u.plan == "free" {
        return false;
    }
    match &u.plan_expires_at {
        None => true,
        Some(t) => chrono::DateTime::parse_from_rfc3339(t).map(|t| t > chrono::Utc::now()).unwrap_or(false),
    }
}

fn used_bytes(conn: &Connection, user_id: i64) -> u64 {
    conn.query_row("SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = ?1", params![user_id], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u64
}

fn account_json(state: &AppState, conn: &Connection, u: &User) -> serde_json::Value {
    json!({
        "email": u.display(),
        "plan": u.plan,
        "planExpiresAt": u.plan_expires_at,
        "quotaBytes": u.quota_bytes,
        "usedBytes": used_bytes(conn, u.id),
        "requiresSubscription": state.config.require_subscription,
        "subscriptionActive": subscription_active(u),
    })
}

fn load_user(conn: &Connection, where_sql: &str, arg: &dyn rusqlite::ToSql) -> Option<(User, String)> {
    conn.query_row(
        &format!(
            "SELECT id, email, plan, plan_expires_at, quota_bytes, password_hash, display_name, role FROM users WHERE {}",
            where_sql
        ),
        [arg],
        |r| {
            Ok((
                User {
                    id: r.get(0)?,
                    email: r.get(1)?,
                    plan: r.get(2)?,
                    plan_expires_at: r.get(3)?,
                    quota_bytes: r.get::<_, i64>(4)? as u64,
                    display_name: r.get(6)?,
                    role: r.get(7)?,
                },
                r.get::<_, String>(5)?,
            ))
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// 本服务签发的令牌
fn local_user(state: &AppState, token: &str) -> Result<Option<User>, Response> {
    let conn = state.conn.lock().map_err(internal)?;
    let hash = sha256_hex(token);
    let user_id: Option<i64> = conn
        .query_row("SELECT user_id FROM tokens WHERE token_hash = ?1", params![hash], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    let Some(user_id) = user_id else { return Ok(None) };
    let _ = conn.execute("UPDATE tokens SET last_used_at = ?1 WHERE token_hash = ?2", params![now(), hash]);
    Ok(load_user(&conn, "id = ?1", &user_id).map(|(u, _)| u))
}

/// 通行证用户第一次出现时建档，之后同步昵称和角色
fn upsert_oneid_user(state: &AppState, o: &crate::oneid::OneIdUser) -> Result<User, Response> {
    let conn = state.conn.lock().map_err(internal)?;
    if let Some((u, _)) = load_user(&conn, "oneid_key = ?1", &o.key) {
        if u.display_name.as_deref() != Some(o.display.as_str()) || u.role != o.role || o.email.is_some() {
            let _ = conn.execute(
                "UPDATE users SET display_name = ?1, role = ?2, contact_email = COALESCE(?3, contact_email) WHERE id = ?4",
                params![o.display, o.role, o.email, u.id],
            );
        }
        return Ok(User { display_name: Some(o.display.clone()), role: o.role.clone(), ..u });
    }
    conn.execute(
        "INSERT INTO users (email, password_hash, plan, quota_bytes, created_at, oneid_key, display_name, role, contact_email)
         VALUES (?1, '!', 'free', ?2, ?3, ?1, ?4, ?5, ?6)",
        params![o.key, state.config.default_quota_bytes as i64, now(), o.display, o.role, o.email],
    )
    .map_err(internal)?;
    load_user(&conn, "oneid_key = ?1", &o.key).map(|(u, _)| u).ok_or_else(|| internal("user missing"))
}

async fn oneid_user(state: &AppState, token: &str) -> Result<Option<crate::oneid::OneIdUser>, Response> {
    let Some(base) = state.config.oneid_base.clone() else { return Ok(None) };
    let hash = sha256_hex(token);
    if let Ok(cache) = state.oneid_cache.lock() {
        if let Some((exp, u)) = cache.get(&hash) {
            if *exp > Instant::now() {
                return Ok(Some(u.clone()));
            }
        }
    }
    let token = token.to_string();
    let verified = tokio::task::spawn_blocking(move || crate::oneid::verify(&base, &token))
        .await
        .map_err(internal)?
        .map_err(|m| err(StatusCode::BAD_GATEWAY, &m))?;
    if let (Some(u), Ok(mut cache)) = (&verified, state.oneid_cache.lock()) {
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(hash, (Instant::now() + ONEID_CACHE_TTL, u.clone()));
    }
    Ok(verified)
}

async fn authed(state: &AppState, headers: &HeaderMap) -> Result<User, Response> {
    let token = bearer(headers).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "请先登录"))?;
    if let Some(u) = local_user(state, &token)? {
        return Ok(u);
    }
    match oneid_user(state, &token).await? {
        Some(o) => upsert_oneid_user(state, &o),
        None => Err(err(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录")),
    }
}

fn issue_token(conn: &Connection, user_id: i64) -> Result<String, Response> {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token: String = raw.iter().map(|b| format!("{:02x}", b)).collect();
    conn.execute(
        "INSERT INTO tokens (token_hash, user_id, created_at, last_used_at) VALUES (?1, ?2, ?3, ?3)",
        params![sha256_hex(&token), user_id, now()],
    )
    .map_err(internal)?;
    Ok(token)
}

/* ---------------- 账号 ---------------- */

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

async fn register(State(state): State<AppState>, Json(c): Json<Credentials>) -> Response {
    if state.config.oneid_base.is_some() {
        return err(StatusCode::FORBIDDEN, "请到 fwpt.cn 注册 FWPT 通行证，然后用通行证账号登录");
    }
    if !state.config.allow_registration {
        return err(StatusCode::FORBIDDEN, "该服务器未开放注册");
    }
    let email = c.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 200 {
        return err(StatusCode::BAD_REQUEST, "邮箱格式不正确");
    }
    if c.password.chars().count() < 8 {
        return err(StatusCode::BAD_REQUEST, "密码至少 8 位");
    }
    let hash = match Argon2::default().hash_password(c.password.as_bytes(), &SaltString::generate(&mut OsRng)) {
        Ok(h) => h.to_string(),
        Err(e) => return internal(e),
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let inserted = conn.execute(
        "INSERT INTO users (email, password_hash, plan, quota_bytes, created_at, contact_email) VALUES (?1, ?2, 'free', ?3, ?4, ?1)",
        params![email, hash, state.config.default_quota_bytes as i64, now()],
    );
    if inserted.is_err() {
        return err(StatusCode::CONFLICT, "该邮箱已注册，请直接登录");
    }
    let Some((user, _)) = load_user(&conn, "email = ?1", &email) else { return internal("user missing") };
    match issue_token(&conn, user.id) {
        Ok(token) => Json(json!({ "token": token, "account": account_json(&state, &conn, &user) })).into_response(),
        Err(r) => r,
    }
}

async fn login(State(state): State<AppState>, Json(c): Json<Credentials>) -> Response {
    if let Some(base) = state.config.oneid_base.clone() {
        return login_oneid(state, base, c).await;
    }
    let email = c.email.trim().to_lowercase();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let Some((user, stored)) = load_user(&conn, "email = ?1", &email) else {
        return err(StatusCode::UNAUTHORIZED, "邮箱或密码不正确");
    };
    let ok = PasswordHash::new(&stored)
        .map(|h| Argon2::default().verify_password(c.password.as_bytes(), &h).is_ok())
        .unwrap_or(false);
    if !ok {
        return err(StatusCode::UNAUTHORIZED, "邮箱或密码不正确");
    }
    match issue_token(&conn, user.id) {
        Ok(token) => Json(json!({ "token": token, "account": account_json(&state, &conn, &user) })).into_response(),
        Err(r) => r,
    }
}

/// 官方部署：用 FWPT 通行证账号密码登录，返回通行证令牌（软件之后直接用它访问）
async fn login_oneid(state: AppState, base: String, c: Credentials) -> Response {
    let account = c.email.trim().to_string();
    let token = match tokio::task::spawn_blocking(move || crate::oneid::login(&base, &account, &c.password)).await {
        Ok(Ok(t)) => t,
        Ok(Err(m)) => return err(StatusCode::UNAUTHORIZED, &m),
        Err(e) => return internal(e),
    };
    let user = match oneid_user(&state, &token).await {
        Ok(Some(o)) => match upsert_oneid_user(&state, &o) {
            Ok(u) => u,
            Err(r) => return r,
        },
        Ok(None) => return err(StatusCode::UNAUTHORIZED, "通行证登录失败，请稍后重试"),
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    Json(json!({ "token": token, "account": account_json(&state, &conn, &user) })).into_response()
}

async fn account(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    Json(account_json(&state, &conn, &user)).into_response()
}

/* ---------------- 文件 ---------------- */

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    prefix: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileItem {
    key: String,
    size: i64,
    updated_at: String,
}

async fn list_files(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<ListQuery>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let like = format!("{}%", q.prefix.replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = match conn.prepare("SELECT key, size, updated_at FROM files WHERE user_id = ?1 AND key LIKE ?2 ESCAPE '\\' ORDER BY key") {
        Ok(s) => s,
        Err(e) => return internal(e),
    };
    let files: Vec<FileItem> = match stmt.query_map(params![user.id, like], |r| {
        Ok(FileItem { key: r.get(0)?, size: r.get(1)?, updated_at: r.get(2)? })
    }) {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(e) => return internal(e),
    };
    Json(json!({ "files": files })).into_response()
}

async fn read_file(State(state): State<AppState>, headers: HeaderMap, Path(key): Path<String>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if !valid_key(&key) {
        return err(StatusCode::BAD_REQUEST, "非法的文件名");
    }
    match std::fs::read(file_path(&state, user.id, &key)) {
        Ok(bytes) => ([("content-type", "application/octet-stream")], bytes).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "文件不存在"),
    }
}

async fn write_file(State(state): State<AppState>, headers: HeaderMap, Path(key): Path<String>, body: Bytes) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if !valid_key(&key) {
        return err(StatusCode::BAD_REQUEST, "非法的文件名");
    }
    if state.config.require_subscription && !subscription_active(&user) {
        return err(StatusCode::PAYMENT_REQUIRED, "云同步需要有效的订阅，开通后即可继续上传；已有数据仍可下载");
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let old: i64 = conn
        .query_row("SELECT size FROM files WHERE user_id = ?1 AND key = ?2", params![user.id, key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0);
    let used = used_bytes(&conn, user.id);
    if used.saturating_sub(old as u64) + body.len() as u64 > user.quota_bytes {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "云端空间已用完，请清理或升级套餐");
    }
    let path = file_path(&state, user.id, &key);
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return internal(e);
        }
    }
    let tmp = path.with_extension("tmp");
    if let Err(e) = std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &path)) {
        return internal(e);
    }
    if let Err(e) = conn.execute(
        "INSERT INTO files (user_id, key, size, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, key) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at",
        params![user.id, key, body.len() as i64, now()],
    ) {
        return internal(e);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_file(State(state): State<AppState>, headers: HeaderMap, Path(key): Path<String>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if !valid_key(&key) {
        return err(StatusCode::BAD_REQUEST, "非法的文件名");
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let _ = std::fs::remove_file(file_path(&state, user.id, &key));
    if let Err(e) = conn.execute("DELETE FROM files WHERE user_id = ?1 AND key = ?2", params![user.id, key]) {
        return internal(e);
    }
    StatusCode::NO_CONTENT.into_response()
}

/* ---------------- 激活码 ---------------- */

/// 去掉易混淆字符（0/O、1/I/L）后的 31 个字符
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 生成形如 XYN-7K2M-Q9TP-4HXW-RC3D 的激活码（约 78 位随机）
pub fn new_code() -> String {
    let mut rng = rand::thread_rng();
    let groups: Vec<String> = (0..4)
        .map(|_| (0..4).map(|_| CODE_ALPHABET[(rng.next_u32() as usize) % CODE_ALPHABET.len()] as char).collect())
        .collect();
    format!("XYN-{}", groups.join("-"))
}

/// 兑换时忽略大小写、空格和横线
fn code_hash(code: &str) -> String {
    let norm: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    let norm = norm.strip_prefix("XYN").unwrap_or(&norm).to_string();
    sha256_hex(&norm)
}

/// 生成一批激活码并写入数据库，返回明文（只在此时可见）
pub fn create_codes(conn: &Connection, plan: &str, days: u32, quota_mb: Option<u64>, count: u32, note: &str) -> Result<Vec<String>, String> {
    if plan.trim().is_empty() || plan == "free" {
        return Err("plan 不能为空或 free".into());
    }
    if days == 0 || count == 0 || count > 10_000 {
        return Err("days 需大于 0，count 需在 1~10000 之间".into());
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let code = new_code();
        conn.execute(
            "INSERT INTO activation_codes (code_hash, plan, days, quota_mb, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![code_hash(&code), plan, days, quota_mb.map(|m| m as i64), note, now()],
        )
        .map_err(|e| e.to_string())?;
        out.push(code);
    }
    Ok(out)
}

#[derive(Deserialize)]
struct RedeemInput {
    code: String,
}

/// 兑换激活码：在当前有效期（未过期时）之后顺延天数；空间取两者较大值
async fn redeem(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<RedeemInput>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let row: Option<(String, i64, Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT plan, days, quota_mb, redeemed_by FROM activation_codes WHERE code_hash = ?1",
            params![code_hash(&input.code)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .unwrap_or(None);
    let Some((plan, days, quota_mb, redeemed_by)) = row else {
        return err(StatusCode::NOT_FOUND, "激活码不存在，请检查是否输入正确");
    };
    if redeemed_by.is_some() {
        return err(StatusCode::CONFLICT, "该激活码已被使用");
    }
    let base = if subscription_active(&user) {
        user.plan_expires_at
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now)
    } else {
        chrono::Utc::now()
    };
    let expires = (base + chrono::Duration::days(days)).to_rfc3339();
    let quota = quota_mb.map(|m| (m as u64 * 1024 * 1024).max(user.quota_bytes)).unwrap_or(user.quota_bytes);
    let ok = tx
        .execute(
            "UPDATE activation_codes SET redeemed_by = ?1, redeemed_at = ?2 WHERE code_hash = ?3 AND redeemed_by IS NULL",
            params![user.id, now(), code_hash(&input.code)],
        )
        .and_then(|_| {
            tx.execute(
                "UPDATE users SET plan = ?1, plan_expires_at = ?2, quota_bytes = ?3 WHERE id = ?4",
                params![plan, expires, quota as i64, user.id],
            )
        })
        .and_then(|_| tx.commit());
    if let Err(e) = ok {
        return internal(e);
    }
    let Some((user, _)) = load_user(&conn, "id = ?1", &user.id) else { return internal("user missing") };
    Json(account_json(&state, &conn, &user)).into_response()
}

/* ---------------- 管理（开通 / 续费套餐） ---------------- */

/// 管理权限：管理令牌，或角色为 ADMIN 的通行证账号（网站管理页使用）
async fn admin_ok(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let Some(given) = bearer(headers) else {
        return Err(err(StatusCode::UNAUTHORIZED, "请先登录管理员账号"));
    };
    if let Some(admin) = state.config.admin_token.as_ref() {
        if sha256_hex(&given) == sha256_hex(admin) {
            return Ok(());
        }
    }
    if let Some(o) = oneid_user(state, &given).await? {
        if o.role == "ADMIN" || o.role == "SUPER_ADMIN" {
            return Ok(());
        }
        return Err(err(StatusCode::FORBIDDEN, "需要管理员权限"));
    }
    if state.config.admin_token.is_none() && state.config.oneid_base.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "管理接口未启用"));
    }
    Err(err(StatusCode::UNAUTHORIZED, "管理令牌不正确"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodesInput {
    plan: String,
    days: u32,
    quota_mb: Option<u64>,
    count: u32,
    #[serde(default)]
    note: String,
}

/// 批量生成激活码（官网发货 / 卡密平台导入用）
async fn admin_create_codes(State(state): State<AppState>, headers: HeaderMap, Json(c): Json<CodesInput>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match create_codes(&conn, &c.plan, c.days, c.quota_mb, c.count, &c.note) {
        Ok(codes) => Json(json!({ "codes": codes })).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInput {
    email: String,
    plan: String,
    expires_at: Option<String>,
    quota_mb: Option<u64>,
}

/// 由支付系统的回调（或运维脚本）调用：`Authorization: Bearer <XYNOTE_ADMIN_TOKEN>`
async fn admin_set_plan(State(state): State<AppState>, headers: HeaderMap, Json(p): Json<PlanInput>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    if let Some(t) = &p.expires_at {
        if chrono::DateTime::parse_from_rfc3339(t).is_err() {
            return err(StatusCode::BAD_REQUEST, "expiresAt 需要是 RFC 3339 时间");
        }
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let email = p.email.trim().to_lowercase();
    let changed = conn.execute(
        "UPDATE users SET plan = ?1, plan_expires_at = ?2, quota_bytes = COALESCE(?3, quota_bytes) WHERE email = ?4",
        params![p.plan, p.expires_at, p.quota_mb.map(|m| (m * 1024 * 1024) as i64), email],
    );
    match changed {
        Ok(0) => err(StatusCode::NOT_FOUND, "用户不存在"),
        Ok(_) => {
            let Some((user, _)) = load_user(&conn, "email = ?1", &email) else { return internal("user missing") };
            Json(account_json(&state, &conn, &user)).into_response()
        }
        Err(e) => internal(e),
    }
}

/* ---------------- 官网购买 ---------------- */

async fn store_products(State(state): State<AppState>) -> Response {
    let c = &state.config;
    Json(json!({
        "products": crate::store::products(c.price_lifetime_cents),
        "lifetimeAvailable": state.signing_key.is_some(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct CreateOrderInput {
    product: String,
}

async fn create_order(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<CreateOrderInput>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    if input.product == "lifetime" && state.signing_key.is_none() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "永久版暂未开放购买");
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let catalog = crate::store::products(state.config.price_lifetime_cents);
    match crate::store::create_order(&conn, user.id, &input.product, &catalog) {
        Ok(o) => Json(o).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

async fn my_orders(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::store::list_user_orders(&conn, user.id) {
        Ok(orders) => Json(json!({ "orders": orders, "account": account_json(&state, &conn, &user) })).into_response(),
        Err(e) => internal(e),
    }
}

async fn cancel_order(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::store::cancel_order(&conn, &id, user.id) {
        Ok(o) => Json(o).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateInput {
    #[serde(flatten)]
    device: crate::licensing::DeviceInfo,
    #[serde(default)]
    code: Option<String>,
}

fn license_error(e: crate::licensing::LicenseError) -> Response {
    use crate::licensing::LicenseError as E;
    match e {
        E::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        E::NotFound(m) => err(StatusCode::NOT_FOUND, &m),
        E::Forbidden(m) => err(StatusCode::FORBIDDEN, &m),
        E::Conflict(m) => err(StatusCode::CONFLICT, &m),
        E::PaymentRequired(m) => err(StatusCode::PAYMENT_REQUIRED, &m),
        E::Internal(m) => internal(m),
    }
}

/// 软件登录或输入激活码时调用：记录机器信息，返回绑定本机的签名授权
async fn license_activate(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<ActivateInput>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let Some(key) = state.signing_key.as_ref() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "授权服务暂未开放");
    };
    let mut conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let ent = match crate::licensing::activate(&tx, user.id, &input.device, input.code.as_deref()) {
        Ok(e) => e,
        Err(e) => {
            // 失败也保留设备记录用于统计
            let _ = crate::licensing::record_device(&tx, user.id, &input.device);
            let _ = tx.commit();
            return license_error(e);
        }
    };
    if let Err(e) = tx.commit() {
        return internal(e);
    }
    let token = crate::license_format::sign(
        &crate::license_format::LicensePayload {
            v: 1,
            id: ent.code.clone().unwrap_or_else(|| format!("trial-{}", user.id)),
            name: user.display().to_string(),
            edition: ent.edition.clone(),
            issued_at: now(),
            expires_at: ent.expires_at.clone(),
            machine: Some(input.device.machine_id.trim().to_string()),
        },
        key,
    );
    Json(json!({ "token": token, "entitlement": ent, "account": user.display() })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeactivateInput {
    machine_id: String,
}

/// 在本机停用授权，空出激活码的一个位置
async fn license_deactivate(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<DeactivateInput>) -> Response {
    let user = match authed(&state, &headers).await {
        Ok(u) => u,
        Err(r) => return r,
    };
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::licensing::deactivate(&conn, user.id, &input.machine_id) {
        Ok(n) => Json(json!({ "released": n })).into_response(),
        Err(e) => internal(e),
    }
}

async fn admin_stats(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM orders WHERE status = 'pending'", [], |r| r.get(0)).unwrap_or(0);
    match crate::licensing::stats(&conn) {
        Ok(mut v) => {
            v["pendingOrders"] = json!(pending);
            Json(v).into_response()
        }
        Err(e) => internal(e),
    }
}

async fn admin_list_codes(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::licensing::list_codes(&conn, 500) {
        Ok(codes) => Json(json!({ "codes": codes })).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicenseCodesInput {
    count: u32,
    #[serde(default)]
    max_devices: Option<i64>,
    #[serde(default)]
    note: String,
}

/// 手动生成激活码（赠送、活动等）
async fn admin_create_codes_v2(State(state): State<AppState>, headers: HeaderMap, Json(c): Json<LicenseCodesInput>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let max = c.max_devices.unwrap_or(crate::licensing::DEFAULT_MAX_DEVICES);
    match crate::licensing::create_codes(&conn, c.count, max, c.note.trim(), None, None) {
        Ok(codes) => Json(json!({ "codes": codes })).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

async fn admin_reset_code(State(state): State<AppState>, headers: HeaderMap, Path(code): Path<String>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::licensing::reset_code(&conn, &code) {
        Ok(n) => Json(json!({ "released": n })).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

#[derive(Deserialize)]
struct RevokeInput {
    revoked: bool,
}

async fn admin_revoke_code(State(state): State<AppState>, headers: HeaderMap, Path(code): Path<String>, Json(r): Json<RevokeInput>) -> Response {
    if let Err(resp) = admin_ok(&state, &headers).await {
        return resp;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::licensing::set_revoked(&conn, &code, r.revoked) {
        Ok(0) => err(StatusCode::NOT_FOUND, "激活码不存在"),
        Ok(_) => Json(json!({ "revoked": r.revoked })).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

#[derive(Deserialize)]
struct AdminOrdersQuery {
    status: Option<String>,
}

async fn admin_list_orders(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<AdminOrdersQuery>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let status = q.status.filter(|s| !s.is_empty() && s != "all");
    match crate::store::list_orders_admin(&conn, status.as_deref()) {
        Ok(orders) => Json(json!({ "orders": orders })).into_response(),
        Err(e) => internal(e),
    }
}

async fn admin_confirm_order(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let mut conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::store::confirm_order(&mut conn, &id) {
        Ok(o) => Json(o).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

#[derive(Deserialize, Default)]
struct RejectInput {
    #[serde(default)]
    note: String,
}

async fn admin_reject_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<RejectInput>>,
) -> Response {
    if let Err(r) = admin_ok(&state, &headers).await {
        return r;
    }
    let note = body.map(|Json(b)| b.note).unwrap_or_default();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    match crate::store::reject_order(&conn, &id, note.trim()) {
        Ok(o) => Json(o).into_response(),
        Err(m) => err(StatusCode::BAD_REQUEST, &m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_config(require_subscription: bool) -> Config {
        Config {
            bind: String::new(),
            data_dir: std::env::temp_dir().join(format!("xynote-server-test-{}", rand::random::<u64>())),
            allow_registration: true,
            require_subscription,
            default_quota_bytes: 1024,
            admin_token: Some("admin-token-0123456789".into()),
            oneid_base: None,
            cors_origins: vec!["https://fwpt.cn".into()],
            license_key_file: None,
            price_lifetime_cents: 990,
        }
    }

    fn test_state(require_subscription: bool) -> AppState {
        AppState::open(test_config(require_subscription)).unwrap()
    }

    /// 带永久版签名私钥的状态，返回对应公钥
    fn test_state_with_license(require_subscription: bool) -> (AppState, [u8; 32]) {
        let mut cfg = test_config(require_subscription);
        std::fs::create_dir_all(&cfg.data_dir).unwrap();
        let key_path = cfg.data_dir.join("license.key");
        let key = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]);
        std::fs::write(&key_path, crate::license_format::hex(&key.to_bytes())).unwrap();
        cfg.license_key_file = Some(key_path);
        (AppState::open(cfg).unwrap(), key.verifying_key().to_bytes())
    }

    fn val(b: &[u8]) -> serde_json::Value {
        serde_json::from_slice(b).unwrap_or(serde_json::Value::Null)
    }

    const ADMIN: &str = "admin-token-0123456789";

    fn device(id: &str) -> serde_json::Value {
        json!({ "machineId": id, "machineName": format!("PC-{}", id), "os": "windows", "appVersion": "0.4.0" })
    }

    async fn activate(app: &Router, token: &str, machine: &str, code: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut body = device(machine);
        if let Some(c) = code {
            body["code"] = json!(c);
        }
        let (s, b) = call(app, "POST", "/api/v1/license/activate", Some(token), body.to_string().into_bytes(), true).await;
        (s, val(&b))
    }

    #[tokio::test]
    async fn store_order_confirm_issues_activation_code() {
        let (state, _) = test_state_with_license(false);
        let app = router(state);
        let t = register_user(&app, "buyer@example.com").await;
        let other = register_user(&app, "other@example.com").await;

        let (_, b) = call(&app, "GET", "/api/v1/store/products", None, vec![], false).await;
        let v = val(&b);
        assert_eq!(v["products"].as_array().unwrap().len(), 1, "只卖永久版");
        assert_eq!(v["products"][0]["amountCents"], 990);

        let (s, b) = call(&app, "POST", "/api/v1/store/orders", Some(&t), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let order = val(&b);
        let oid = order["id"].as_str().unwrap().to_string();
        let (s, _) = call(&app, "POST", "/api/v1/store/orders", Some(&t), json!({"product": "sync_year"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "云同步已停售");

        // 普通用户不能确认、也看不到别人的订单
        let (s, _) = call(&app, "POST", &format!("/api/v1/admin/orders/{}/confirm", oid), Some(&t), vec![], false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (_, b) = call(&app, "GET", "/api/v1/store/orders", Some(&other), vec![], false).await;
        assert_eq!(val(&b)["orders"].as_array().unwrap().len(), 0);

        // 管理员看到账号和邮箱，确认后生成激活码
        let (_, b) = call(&app, "GET", "/api/v1/admin/orders?status=pending", Some(ADMIN), vec![], false).await;
        assert_eq!(val(&b)["orders"][0]["accountEmail"], "buyer@example.com");
        let (s, b) = call(&app, "POST", &format!("/api/v1/admin/orders/{}/confirm", oid), Some(ADMIN), vec![], false).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let code = val(&b)["license"].as_str().unwrap().to_string();
        assert!(code.starts_with("XYP-") && code.len() == 23, "{}", code);
        let (s, _) = call(&app, "POST", &format!("/api/v1/admin/orders/{}/confirm", oid), Some(ADMIN), vec![], false).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "不会重复发码");
        let (_, b) = call(&app, "GET", "/api/v1/store/orders", Some(&t), vec![], false).await;
        assert_eq!(val(&b)["orders"][0]["license"], code.as_str());

        // 购买账号登录后自动用上这个激活码；别的账号不能用
        let (s, v) = activate(&app, &t, "machine-aaaa-0001", None).await;
        assert_eq!((s, v["entitlement"]["edition"].clone()), (StatusCode::OK, json!("lifetime")));
        let (s, _) = activate(&app, &other, "machine-bbbb-0001", Some(&code)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);

        // 取消与未到账
        let (_, b) = call(&app, "POST", "/api/v1/store/orders", Some(&other), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        let o2 = val(&b)["id"].as_str().unwrap().to_string();
        let (s, b) = call(&app, "POST", &format!("/api/v1/store/orders/{}/cancel", o2), Some(&other), vec![], false).await;
        assert_eq!((s, val(&b)["status"].clone()), (StatusCode::OK, json!("cancelled")));
        let (_, b) = call(&app, "POST", "/api/v1/store/orders", Some(&other), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        let o3 = val(&b)["id"].as_str().unwrap().to_string();
        let (_, b) = call(&app, "POST", &format!("/api/v1/admin/orders/{}/reject", o3), Some(ADMIN), json!({"note": "未查到付款"}).to_string().into_bytes(), true).await;
        assert_eq!(val(&b)["adminNote"], "未查到付款");
        for _ in 0..crate::store::MAX_PENDING {
            call(&app, "POST", "/api/v1/store/orders", Some(&other), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        }
        let (s, _) = call(&app, "POST", "/api/v1/store/orders", Some(&other), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "待确认订单数量上限");
    }

    #[tokio::test]
    async fn trial_year_and_three_device_limit() {
        let (state, pubkey) = test_state_with_license(false);
        let codes = crate::licensing::create_codes(&state.conn.lock().unwrap(), 1, 3, "测试", None, None).unwrap();
        let code = codes[0].clone();
        let app = router(state);
        let t = register_user(&app, "user@example.com").await;

        // 第一次登录：赠送一年，令牌绑定本机并带到期时间
        let (s, v) = activate(&app, &t, "machine-0000-0001", None).await;
        assert_eq!(s, StatusCode::OK, "{}", v);
        assert_eq!(v["entitlement"]["edition"], "trial");
        let token = v["token"].as_str().unwrap();
        let payload = crate::license_format::verify(token, &pubkey).unwrap();
        assert_eq!(payload.machine.as_deref(), Some("machine-0000-0001"));
        let until = chrono::DateTime::parse_from_rfc3339(payload.expires_at.as_deref().unwrap()).unwrap();
        assert_eq!((until.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days(), 364);
        // 再登录不会重新计算一年
        let (_, v2) = activate(&app, &t, "machine-0000-0002", None).await;
        assert_eq!(v2["entitlement"]["trialUntil"], v["entitlement"]["trialUntil"]);

        // 激活码：大小写、空格不敏感，最多 3 台
        let messy = code.to_lowercase().replace('-', " ");
        for m in ["machine-0000-0001", "machine-0000-0002", "machine-0000-0003"] {
            let (s, v) = activate(&app, &t, m, Some(&messy)).await;
            assert_eq!(s, StatusCode::OK, "{}", v);
            assert_eq!(v["entitlement"]["edition"], "lifetime");
        }
        let (s, v) = activate(&app, &t, "machine-0000-0001", Some(&code)).await;
        assert_eq!((s, v["entitlement"]["devicesUsed"].clone()), (StatusCode::OK, json!(3)), "已激活的电脑重复激活不占位置");
        let (s, v) = activate(&app, &t, "machine-0000-0004", Some(&code)).await;
        assert_eq!(s, StatusCode::CONFLICT, "{}", v);
        // 第 4 台电脑登录时激活码已满，仍在免费期内则返回免费期
        let (_, v) = activate(&app, &t, "machine-0000-0004", None).await;
        assert_eq!(v["entitlement"]["edition"], "trial");

        // 在一台电脑上停用后，第 4 台可以激活；不带激活码登录也会自动用上空位
        let (s, b) = call(&app, "POST", "/api/v1/license/deactivate", Some(&t), json!({"machineId": "machine-0000-0003"}).to_string().into_bytes(), true).await;
        assert_eq!((s, val(&b)["released"].clone()), (StatusCode::OK, json!(1)));
        let (s, v) = activate(&app, &t, "machine-0000-0004", None).await;
        assert_eq!((s, v["entitlement"]["edition"].clone()), (StatusCode::OK, json!("lifetime")));

        // 另一个账号首次登录同样有一年
        let t2 = register_user(&app, "late@example.com").await;
        let (_, v) = activate(&app, &t2, "machine-late-0001", None).await;
        assert_eq!(v["entitlement"]["edition"], "trial");
        let (s, _) = call(&app, "GET", "/api/v1/admin/stats", Some(ADMIN), vec![], false).await;
        assert_eq!(s, StatusCode::OK);

        let (s, v) = activate(&app, &t, "bad id!", None).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{}", v);
        let (s, _) = activate(&app, &t, "machine-0000-0009", Some("XYP-0000-0000-0000-0000")).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "含 0 的码格式不对");
        let (s, _) = activate(&app, &t, "machine-0000-0009", Some("XYP-2222-2222-2222-2222")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn expired_trial_requires_purchase_and_admin_tools_work() {
        let (state, _) = test_state_with_license(false);
        let app = router(state.clone());
        let t = register_user(&app, "old@example.com").await;
        let past = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        state.conn.lock().unwrap().execute("UPDATE users SET trial_until = ?1", params![past]).unwrap();
        let (s, v) = activate(&app, &t, "machine-old-0001", None).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED, "{}", v);

        // 管理员手动生成、查看、清空设备、停用
        let (_, b) = call(&app, "POST", "/api/v1/admin/license-codes", Some(ADMIN), json!({"count": 2, "note": "赠送"}).to_string().into_bytes(), true).await;
        let codes: Vec<String> = serde_json::from_value(val(&b)["codes"].clone()).unwrap();
        assert_eq!(codes.len(), 2);
        let (s, _) = activate(&app, &t, "machine-old-0001", Some(&codes[0])).await;
        assert_eq!(s, StatusCode::OK);
        let (_, b) = call(&app, "GET", "/api/v1/admin/license-codes", Some(ADMIN), vec![], false).await;
        let list = val(&b);
        let bound = list["codes"].as_array().unwrap().iter().find(|c| c["code"] == codes[0].as_str()).unwrap().clone();
        assert_eq!(bound["owner"], "old@example.com");
        assert_eq!(bound["devices"][0]["machineName"], "PC-machine-old-0001");
        let (_, b) = call(&app, "POST", &format!("/api/v1/admin/license-codes/{}/reset", codes[0]), Some(ADMIN), vec![], false).await;
        assert_eq!(val(&b)["released"], 1);
        call(&app, "POST", &format!("/api/v1/admin/license-codes/{}/revoke", codes[0]), Some(ADMIN), json!({"revoked": true}).to_string().into_bytes(), true).await;
        let (s, _) = activate(&app, &t, "machine-old-0001", Some(&codes[0])).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (_, b) = call(&app, "GET", "/api/v1/admin/stats", Some(ADMIN), vec![], false).await;
        let st = val(&b);
        assert_eq!((st["codesTotal"].clone(), st["devices"].clone()), (json!(2), json!(1)));
    }

    #[tokio::test]
    async fn activation_needs_signing_key() {
        let app = router(test_state(false));
        let t = register_user(&app, "x@example.com").await;
        let (s, _) = activate(&app, &t, "machine-xxxx-0001", None).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    }

    /// 模拟 FWPT 通行证服务：账号 wm / pass1234，令牌 jwt-wm（ADMIN）与 jwt-amy（普通用户）
    async fn mock_oneid() -> String {
        async fn profile(headers: HeaderMap) -> Response {
            match bearer(&headers).as_deref() {
                Some("jwt-wm") => Json(json!({"code": "00000", "data": {"id": 7, "username": "wm", "nickname": "王先生", "role": "ADMIN"}})).into_response(),
                Some("jwt-amy") => Json(json!({"code": "00000", "data": {"id": 8, "username": "amy", "email": "amy@fwpt.cn", "role": "USER"}})).into_response(),
                _ => (StatusCode::UNAUTHORIZED, Json(json!({"code": "A0301", "message": "token invalid"}))).into_response(),
            }
        }
        async fn login(Json(b): Json<serde_json::Value>) -> Response {
            if b["account"] == "wm" && b["password"] == "pass1234" {
                Json(json!({"code": "00000", "data": {"token": "jwt-wm"}})).into_response()
            } else {
                Json(json!({"code": "A0210", "message": "账号或密码错误"})).into_response()
            }
        }
        let app = Router::new().route("/api/v1/user/profile", get(profile)).route("/api/v1/auth/login", post(login));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{}", addr)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fwpt_accounts_login_buy_and_administer() {
        let mut cfg = test_config(true);
        std::fs::create_dir_all(&cfg.data_dir).unwrap();
        let key_path = cfg.data_dir.join("license.key");
        std::fs::write(&key_path, crate::license_format::hex(&[5u8; 32])).unwrap();
        cfg.license_key_file = Some(key_path);
        cfg.oneid_base = Some(mock_oneid().await);
        cfg.admin_token = None;
        let app = router(AppState::open(cfg).unwrap());

        // 软件里用通行证账号密码登录
        let (s, b) = call(&app, "POST", "/api/v1/auth/login", None, json!({"email": "wm", "password": "pass1234"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        assert_eq!(val(&b)["token"], "jwt-wm");
        assert_eq!(val(&b)["account"]["email"], "王先生");
        let (s, b) = call(&app, "POST", "/api/v1/auth/login", None, json!({"email": "wm", "password": "bad"}).to_string().into_bytes(), true).await;
        assert_eq!((s, val(&b)["message"].clone()), (StatusCode::UNAUTHORIZED, json!("账号或密码错误")));
        let (s, _) = call(&app, "POST", "/api/v1/auth/register", None, json!({"email": "a@b.cn", "password": "password123"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "官方部署在 fwpt.cn 注册");

        // 网站直接用通行证令牌下单；同一通行证始终是同一个账号
        let (s, b) = call(&app, "POST", "/api/v1/store/orders", Some("jwt-amy"), json!({"product": "lifetime"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let oid = val(&b)["id"].as_str().unwrap().to_string();
        let (s, _) = call(&app, "GET", "/api/v1/admin/orders", Some("jwt-amy"), vec![], false).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "普通通行证不是管理员");
        let (s, _) = call(&app, "GET", "/api/v1/account", Some("jwt-bad"), vec![], false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);

        // 通行证管理员在网站后台确认
        let (_, b) = call(&app, "GET", "/api/v1/admin/orders", Some("jwt-wm"), vec![], false).await;
        assert_eq!(val(&b)["orders"][0]["account"], "amy");
        let (s, b) = call(&app, "POST", &format!("/api/v1/admin/orders/{}/confirm", oid), Some("jwt-wm"), vec![], false).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        assert_eq!(val(&b)["accountEmail"], "amy@fwpt.cn");
        // 通行证账号在软件里登录：先拿到一年免费期，购买的激活码自动生效
        let (s, v) = activate(&app, "jwt-amy", "machine-amy-0001", None).await;
        assert_eq!((s, v["entitlement"]["edition"].clone()), (StatusCode::OK, json!("lifetime")));
    }

    #[tokio::test]
    async fn cors_allows_the_official_site_only() {
        let app = router(test_state(false));
        let req = |origin: &str| {
            Request::builder()
                .method("OPTIONS")
                .uri("/api/v1/store/orders")
                .header("origin", origin)
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "authorization,content-type")
                .body(Body::empty())
                .unwrap()
        };
        let ok = app.clone().oneshot(req("https://fwpt.cn")).await.unwrap();
        assert_eq!(ok.headers().get("access-control-allow-origin").unwrap(), "https://fwpt.cn");
        let bad = app.clone().oneshot(req("https://evil.example")).await.unwrap();
        assert!(bad.headers().get("access-control-allow-origin").is_none());
    }

    async fn call(app: &Router, method: &str, uri: &str, token: Option<&str>, body: Vec<u8>, json_body: bool) -> (StatusCode, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {}", t));
        }
        if json_body {
            req = req.header("content-type", "application/json");
        }
        let resp = app.clone().oneshot(req.body(Body::from(body)).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, bytes)
    }

    async fn register_user(app: &Router, email: &str) -> String {
        let (s, b) = call(app, "POST", "/api/v1/auth/register", None, json!({"email": email, "password": "password123"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        serde_json::from_slice::<serde_json::Value>(&b).unwrap()["token"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn self_hosted_flow_files_are_per_user() {
        let app = router(test_state(false));
        let t1 = register_user(&app, "a@example.com").await;
        let t2 = register_user(&app, "b@example.com").await;

        let (s, _) = call(&app, "PUT", "/api/v1/files/pages/p1~abc.json", Some(&t1), b"hello".to_vec(), false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let (s, b) = call(&app, "GET", "/api/v1/files/pages/p1~abc.json", Some(&t1), vec![], false).await;
        assert_eq!((s, b.as_slice()), (StatusCode::OK, b"hello".as_slice()));
        let (s, _) = call(&app, "GET", "/api/v1/files/pages/p1~abc.json", Some(&t2), vec![], false).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "其他用户看不到");

        let (_, b) = call(&app, "GET", "/api/v1/files?prefix=pages/", Some(&t1), vec![], false).await;
        let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["files"][0]["key"], "pages/p1~abc.json");

        let (s, _) = call(&app, "PUT", "/api/v1/files/../escape", Some(&t1), b"x".to_vec(), false).await;
        assert_ne!(s, StatusCode::NO_CONTENT);
        let (s, _) = call(&app, "GET", "/api/v1/account", Some("bad"), vec![], false).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);

        // 配额 1024 字节
        let (s, _) = call(&app, "PUT", "/api/v1/files/big.json", Some(&t1), vec![0u8; 2000], false).await;
        assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);

        let (s, _) = call(&app, "DELETE", "/api/v1/files/pages/p1~abc.json", Some(&t1), vec![], false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        let (_, b) = call(&app, "GET", "/api/v1/account", Some(&t1), vec![], false).await;
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&b).unwrap()["usedBytes"], 0);

        // 登录
        let (s, _) = call(&app, "POST", "/api/v1/auth/login", None, json!({"email": "A@example.com", "password": "password123"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call(&app, "POST", "/api/v1/auth/login", None, json!({"email": "a@example.com", "password": "wrong-pass"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn activation_codes_extend_subscription_once() {
        let state = test_state(true);
        let codes = create_codes(&state.conn.lock().unwrap(), "pro", 30, Some(10), 2, "测试").unwrap();
        assert!(codes[0].starts_with("XYN-") && codes[0].len() == 23);
        let app = router(state);
        let t = register_user(&app, "code@example.com").await;
        let (s, _) = call(&app, "POST", "/api/v1/redeem", Some(&t), json!({"code": "XYN-0000-0000-0000-0000"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        // 大小写、空格不敏感
        let messy = codes[0].to_lowercase().replace('-', " ");
        let (s, b) = call(&app, "POST", "/api/v1/redeem", Some(&t), json!({"code": messy}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["subscriptionActive"], true);
        assert_eq!(v["quotaBytes"], 10 * 1024 * 1024);
        let first = chrono::DateTime::parse_from_rfc3339(v["planExpiresAt"].as_str().unwrap()).unwrap();

        let (s, _) = call(&app, "POST", "/api/v1/redeem", Some(&t), json!({"code": codes[0]}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::CONFLICT, "同一激活码只能用一次");

        // 第二张顺延 30 天
        let (_, b) = call(&app, "POST", "/api/v1/redeem", Some(&t), json!({"code": codes[1]}).to_string().into_bytes(), true).await;
        let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
        let second = chrono::DateTime::parse_from_rfc3339(v["planExpiresAt"].as_str().unwrap()).unwrap();
        assert_eq!((second - first).num_days(), 30);

        let (s, _) = call(&app, "PUT", "/api/v1/files/a.json", Some(&t), b"x".to_vec(), false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);

        // 管理接口批量生成
        let (s, b) = call(&app, "POST", "/api/v1/admin/codes", Some("admin-token-0123456789"), json!({"plan": "pro", "days": 365, "count": 3}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&b).unwrap()["codes"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn official_mode_requires_subscription_for_uploads() {
        let app = router(test_state(true));
        let t = register_user(&app, "pay@example.com").await;
        let (s, _) = call(&app, "PUT", "/api/v1/files/a.json", Some(&t), b"x".to_vec(), false).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED);

        // 支付回调开通一年
        let expires = (chrono::Utc::now() + chrono::Duration::days(365)).to_rfc3339();
        let (s, _) = call(&app, "POST", "/api/v1/admin/users/plan", Some("wrong"), json!({"email": "pay@example.com", "plan": "pro"}).to_string().into_bytes(), true).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (s, b) = call(
            &app,
            "POST",
            "/api/v1/admin/users/plan",
            Some("admin-token-0123456789"),
            json!({"email": "pay@example.com", "plan": "pro", "expiresAt": expires, "quotaMb": 10}).to_string().into_bytes(),
            true,
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&b).unwrap()["subscriptionActive"], true);
        let (s, _) = call(&app, "PUT", "/api/v1/files/a.json", Some(&t), b"x".to_vec(), false).await;
        assert_eq!(s, StatusCode::NO_CONTENT);

        // 到期后只能下载
        let past = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        call(&app, "POST", "/api/v1/admin/users/plan", Some("admin-token-0123456789"), json!({"email": "pay@example.com", "plan": "pro", "expiresAt": past}).to_string().into_bytes(), true).await;
        let (s, _) = call(&app, "PUT", "/api/v1/files/b.json", Some(&t), b"x".to_vec(), false).await;
        assert_eq!(s, StatusCode::PAYMENT_REQUIRED);
        let (s, _) = call(&app, "GET", "/api/v1/files/a.json", Some(&t), vec![], false).await;
        assert_eq!(s, StatusCode::OK);
    }
}
