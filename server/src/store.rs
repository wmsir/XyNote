//! 官网购买：下单 → 用户扫收款码付款并备注付款码 → 管理员核对到账后确认 → 自动交付。
//!
//! | 商品 | 价格 | 交付 |
//! |---|---|---|
//! | `sync_year` 官方云同步 · 一年 | ¥9.9 | 账号云同步有效期顺延 365 天 |
//! | `lifetime` 永久版 · 终生 | ¥99 | 签发永久版授权码（软件登录同一账号后自动激活） |

use crate::license_format::{sign, LicensePayload};
use ed25519_dalek::SigningKey;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        product TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        pay_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        license TEXT NULL,
        sync_until TEXT NULL,
        admin_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub amount_cents: i64,
}

pub fn products(sync_year_cents: i64, lifetime_cents: i64) -> Vec<Product> {
    vec![
        Product {
            id: "sync_year",
            name: "官方云同步 · 一年",
            desc: "多台设备自动同步，可开启端到端加密；到期后仍可下载已有数据",
            amount_cents: sync_year_cents,
        },
        Product {
            id: "lifetime",
            name: "永久版 · 终生",
            desc: "一次购买终身使用：页面历史版本，以及之后新增的高级功能",
            amount_cents: lifetime_cents,
        },
    ]
}

/// 同一账号最多同时保留的待付款订单
pub const MAX_PENDING: i64 = 3;
pub const SYNC_YEAR_DAYS: i64 = 365;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub product: String,
    pub product_name: String,
    pub amount_cents: i64,
    /// 付款时填写在备注里的 4 位码，用于核对
    pub pay_ref: String,
    /// pending 待确认 / paid 已交付 / cancelled 已取消 / rejected 未收到款
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub license: Option<String>,
    pub sync_until: Option<String>,
    pub admin_note: String,
    /// 仅管理接口返回：下单账号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

const REF_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

fn random_ref(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len).map(|_| REF_ALPHABET[(rng.next_u32() as usize) % REF_ALPHABET.len()] as char).collect()
}

fn product_name(id: &str) -> String {
    match id {
        "sync_year" => "官方云同步 · 一年".into(),
        "lifetime" => "永久版 · 终生".into(),
        other => other.into(),
    }
}

const ORDER_COLS: &str = "o.id, o.product, o.amount_cents, o.pay_ref, o.status, o.created_at, o.updated_at, o.license, o.sync_until, o.admin_note, COALESCE(u.display_name, u.email)";

fn order_from_row(r: &rusqlite::Row<'_>, with_account: bool) -> rusqlite::Result<Order> {
    let product: String = r.get(1)?;
    Ok(Order {
        id: r.get(0)?,
        product_name: product_name(&product),
        product,
        amount_cents: r.get(2)?,
        pay_ref: r.get(3)?,
        status: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        license: r.get(7)?,
        sync_until: r.get(8)?,
        admin_note: r.get(9)?,
        account: if with_account { r.get(10)? } else { None },
    })
}

pub fn create_order(conn: &Connection, user_id: i64, product: &str, catalog: &[Product]) -> Result<Order, String> {
    let item = catalog.iter().find(|p| p.id == product).ok_or("没有这个商品")?;
    let pending: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE user_id = ?1 AND status = 'pending'", params![user_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if pending >= MAX_PENDING {
        return Err("你有多个待确认的订单，请等待确认或取消后再下单".into());
    }
    let id = format!("XY{}{}", chrono::Utc::now().format("%y%m%d"), random_ref(6));
    let at = now();
    conn.execute(
        "INSERT INTO orders (id, user_id, product, amount_cents, pay_ref, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        params![id, user_id, item.id, item.amount_cents, random_ref(4), at],
    )
    .map_err(|e| e.to_string())?;
    get_order(conn, &id, Some(user_id)).map_err(|e| e.to_string())?.ok_or_else(|| "订单创建失败".into())
}

pub fn get_order(conn: &Connection, id: &str, user_id: Option<i64>) -> rusqlite::Result<Option<Order>> {
    conn.query_row(
        &format!("SELECT {} FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?1 AND (?2 IS NULL OR o.user_id = ?2)", ORDER_COLS),
        params![id, user_id],
        |r| order_from_row(r, user_id.is_none()),
    )
    .optional()
}

pub fn list_user_orders(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<Order>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM orders o JOIN users u ON u.id = o.user_id WHERE o.user_id = ?1 ORDER BY o.created_at DESC LIMIT 100",
        ORDER_COLS
    ))?;
    let rows = stmt.query_map(params![user_id], |r| order_from_row(r, false))?.collect();
    rows
}

pub fn list_orders_admin(conn: &Connection, status: Option<&str>) -> rusqlite::Result<Vec<Order>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM orders o JOIN users u ON u.id = o.user_id WHERE (?1 IS NULL OR o.status = ?1) ORDER BY o.created_at DESC LIMIT 300",
        ORDER_COLS
    ))?;
    let rows = stmt.query_map(params![status], |r| order_from_row(r, true))?.collect();
    rows
}

pub fn cancel_order(conn: &Connection, id: &str, user_id: i64) -> Result<Order, String> {
    let changed = conn
        .execute(
            "UPDATE orders SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND user_id = ?3 AND status = 'pending'",
            params![now(), id, user_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("只有待确认的订单可以取消".into());
    }
    get_order(conn, id, Some(user_id)).map_err(|e| e.to_string())?.ok_or_else(|| "订单不存在".into())
}

pub fn reject_order(conn: &Connection, id: &str, note: &str) -> Result<Order, String> {
    let changed = conn
        .execute(
            "UPDATE orders SET status = 'rejected', admin_note = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'pending'",
            params![note, now(), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("只有待确认的订单可以标记为未到账".into());
    }
    get_order(conn, id, None).map_err(|e| e.to_string())?.ok_or_else(|| "订单不存在".into())
}

/// 确认到账并交付。在一个事务里完成，重复确认不会重复交付。
pub fn confirm_order(conn: &mut Connection, id: &str, signing_key: Option<&SigningKey>, sync_quota_bytes: u64) -> Result<Order, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let row: Option<(i64, String, String, Option<String>, Option<String>, i64, String, Option<String>)> = tx
        .query_row(
            "SELECT o.user_id, o.product, o.status, u.plan_expires_at, u.plan, u.quota_bytes, COALESCE(u.display_name, u.email), u.oneid_key
             FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, Some(r.get::<_, String>(4)?), r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((user_id, product, status, expires, plan, quota, display, _oneid)) = row else {
        return Err("订单不存在".into());
    };
    if status != "pending" {
        return Err(format!("订单当前状态是「{}」，不能再确认", status_label(&status)));
    }
    let at = now();
    match product.as_str() {
        "sync_year" => {
            let active_until = expires
                .as_deref()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&chrono::Utc))
                .filter(|t| *t > chrono::Utc::now() && plan.as_deref() != Some("free"));
            let until = (active_until.unwrap_or_else(chrono::Utc::now) + chrono::Duration::days(SYNC_YEAR_DAYS)).to_rfc3339();
            let new_quota = (quota as u64).max(sync_quota_bytes) as i64;
            tx.execute(
                "UPDATE users SET plan = 'sync', plan_expires_at = ?1, quota_bytes = ?2 WHERE id = ?3",
                params![until, new_quota, user_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE orders SET status = 'paid', sync_until = ?1, updated_at = ?2 WHERE id = ?3",
                params![until, at, id],
            )
            .map_err(|e| e.to_string())?;
        }
        "lifetime" => {
            let key = signing_key.ok_or("服务器未配置永久版签名私钥（XYNOTE_LICENSE_KEY_FILE），无法签发授权码")?;
            let license = sign(
                &LicensePayload { v: 1, id: id.to_string(), name: display, edition: "lifetime".into(), issued_at: at.clone() },
                key,
            );
            tx.execute(
                "UPDATE orders SET status = 'paid', license = ?1, updated_at = ?2 WHERE id = ?3",
                params![license, at, id],
            )
            .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("未知商品 {}", other)),
    }
    tx.commit().map_err(|e| e.to_string())?;
    get_order(conn, id, None).map_err(|e| e.to_string())?.ok_or_else(|| "订单不存在".into())
}

pub fn status_label(s: &str) -> &'static str {
    match s {
        "pending" => "待确认",
        "paid" => "已交付",
        "cancelled" => "已取消",
        "rejected" => "未到账",
        _ => "未知",
    }
}

/// 账号已购买的永久版授权码（软件登录后自动激活）
pub fn user_licenses(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT license FROM orders WHERE user_id = ?1 AND status = 'paid' AND license IS NOT NULL ORDER BY updated_at",
    )?;
    let rows = stmt.query_map(params![user_id], |r| r.get(0))?.collect();
    rows
}
