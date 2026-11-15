//! 官网购买：下单 → 用户扫码付款，把付款截图和订单信息（订单号、通行证账号）发到 admin@fwpt.cn
//! → 管理员核对无误后确认 → 生成激活码（绑定购买账号，最多 3 台电脑），显示在用户「我的订单」并由管理员邮件发送。
//!
//! | 商品 | 价格 |
//! |---|---|
//! | `lifetime` 永久版 | ¥9.9（一次购买） |

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

pub fn products(lifetime_cents: i64) -> Vec<Product> {
    vec![Product {
        id: "lifetime",
        name: "小悦笔记永久版",
        desc: "一次购买永久使用：自定义主题样式、导出 HTML / PDF / Word、页面历史版本；一个激活码可在 3 台电脑使用",
        amount_cents: lifetime_cents,
    }]
}

/// 同一账号最多同时保留的待付款订单
pub const MAX_PENDING: i64 = 3;

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
    /// 已交付的永久版订单在 license 中保存激活码
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub license: Option<String>,
    pub sync_until: Option<String>,
    pub admin_note: String,
    /// 仅管理接口返回：下单账号与邮箱（用于发送激活码）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_email: Option<String>,
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
        "lifetime" => "小悦笔记永久版".into(),
        other => other.into(),
    }
}

const ORDER_COLS: &str = "o.id, o.product, o.amount_cents, o.pay_ref, o.status, o.created_at, o.updated_at, o.license, o.sync_until, o.admin_note, COALESCE(u.display_name, u.email), u.contact_email";

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
        account_email: if with_account { r.get(11)? } else { None },
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

/// 确认到账：生成绑定购买账号的激活码（最多 3 台电脑）。在一个事务里完成，重复确认不会重复发码。
pub fn confirm_order(conn: &mut Connection, id: &str) -> Result<Order, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let row: Option<(i64, String, String)> = tx
        .query_row("SELECT user_id, product, status FROM orders WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((user_id, product, status)) = row else {
        return Err("订单不存在".into());
    };
    if status != "pending" {
        return Err(format!("订单当前状态是「{}」，不能再确认", status_label(&status)));
    }
    if product != "lifetime" {
        return Err(format!("该商品（{}）已停售，请标记为未到账并联系用户", product_name(&product)));
    }
    let codes = crate::licensing::create_codes(&tx, 1, crate::licensing::DEFAULT_MAX_DEVICES, "官网订单", Some(id), Some(user_id))?;
    tx.execute(
        "UPDATE orders SET status = 'paid', license = ?1, updated_at = ?2 WHERE id = ?3",
        params![codes[0], now(), id],
    )
    .map_err(|e| e.to_string())?;
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
