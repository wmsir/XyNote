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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub allow_registration: bool,
    pub require_subscription: bool,
    pub default_quota_bytes: u64,
    pub admin_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
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
        }
    }
}

pub struct Inner {
    pub config: Config,
    pub conn: Mutex<Connection>,
}

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
             );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Arc::new(Inner { config, conn: Mutex::new(conn) }))
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
        .route("/api/v1/admin/users/plan", post(admin_set_plan))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
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
        "email": u.email,
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
        &format!("SELECT id, email, plan, plan_expires_at, quota_bytes, password_hash FROM users WHERE {}", where_sql),
        [arg],
        |r| {
            Ok((
                User {
                    id: r.get(0)?,
                    email: r.get(1)?,
                    plan: r.get(2)?,
                    plan_expires_at: r.get(3)?,
                    quota_bytes: r.get::<_, i64>(4)? as u64,
                },
                r.get::<_, String>(5)?,
            ))
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn authed(state: &AppState, headers: &HeaderMap) -> Result<User, Response> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "请先登录"))?;
    let conn = state.conn.lock().map_err(internal)?;
    let hash = sha256_hex(token);
    let user_id: Option<i64> = conn
        .query_row("SELECT user_id FROM tokens WHERE token_hash = ?1", params![hash], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    let user_id = user_id.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录"))?;
    let _ = conn.execute("UPDATE tokens SET last_used_at = ?1 WHERE token_hash = ?2", params![now(), hash]);
    load_user(&conn, "id = ?1", &user_id).map(|(u, _)| u).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "账号不存在"))
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
        "INSERT INTO users (email, password_hash, plan, quota_bytes, created_at) VALUES (?1, ?2, 'free', ?3, ?4)",
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

async fn account(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match authed(&state, &headers) {
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
    let user = match authed(&state, &headers) {
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
    let user = match authed(&state, &headers) {
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
    let user = match authed(&state, &headers) {
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
    let user = match authed(&state, &headers) {
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

/* ---------------- 管理（开通 / 续费套餐） ---------------- */

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
    let Some(admin) = state.config.admin_token.as_ref() else {
        return err(StatusCode::NOT_FOUND, "管理接口未启用");
    };
    let given = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if given.map(|g| sha256_hex(g) != sha256_hex(admin)).unwrap_or(true) {
        return err(StatusCode::UNAUTHORIZED, "管理令牌不正确");
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state(require_subscription: bool) -> AppState {
        let dir = std::env::temp_dir().join(format!("xynote-server-test-{}", rand::random::<u64>()));
        AppState::open(Config {
            bind: String::new(),
            data_dir: dir,
            allow_registration: true,
            require_subscription,
            default_quota_bytes: 1024,
            admin_token: Some("admin-token-0123456789".into()),
        })
        .unwrap()
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
