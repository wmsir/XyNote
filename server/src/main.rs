//! XyNote 同步服务器。
//!
//! 一个按用户隔离的「键 → 文件」存储，配合客户端的同步引擎使用。笔记内容在客户端可选端到端加密，
//! 服务器只保存密文。同一套程序既可以自建部署，也可以作为官方付费云同步服务运行：
//!
//! | 环境变量                     | 默认值          | 说明 |
//! |-----------------------------|----------------|------|
//! | `XYNOTE_BIND`               | `0.0.0.0:8787` | 监听地址 |
//! | `XYNOTE_DATA_DIR`           | `./data`       | 数据库与文件存放目录 |
//! | `XYNOTE_ALLOW_REGISTRATION` | `true`         | 是否开放注册（自建可在建好账号后关闭） |
//! | `XYNOTE_REQUIRE_SUBSCRIPTION` | `false`      | 官方服务设为 `true`：无有效订阅时只能下载、不能上传 |
//! | `XYNOTE_DEFAULT_QUOTA_MB`   | `2048`         | 新用户的空间配额 |
//! | `XYNOTE_ADMIN_TOKEN`        | 空（关闭）      | 管理接口令牌：批量生成激活码、手动设置套餐 |

mod app;
mod oneid;
mod store;
mod licensing;
mod feedback;
mod marketplace;
#[path = "../../src-tauri/src/license_format.rs"]
#[allow(dead_code)]
mod license_format;

use app::OpenState;

/// 命令行：`xynote-sync-server gen-codes --plan pro --days 365 [--quota-mb 10240] [--count 100] [--note 备注]`
/// 生成一批激活码，每行一个输出到标准输出，可直接导入官网的发卡系统。
fn gen_codes(args: &[String]) -> Result<(), String> {
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let plan = get("--plan").unwrap_or_else(|| "pro".into());
    let days: u32 = get("--days").ok_or("缺少 --days")?.parse().map_err(|_| "--days 需要是数字")?;
    let count: u32 = get("--count").unwrap_or_else(|| "1".into()).parse().map_err(|_| "--count 需要是数字")?;
    let quota = match get("--quota-mb") {
        Some(q) => Some(q.parse::<u64>().map_err(|_| "--quota-mb 需要是数字")?),
        None => None,
    };
    let state = app::AppState::open(app::Config::from_env())?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    for code in app::create_codes(&conn, &plan, days, quota, count, &get("--note").unwrap_or_default())? {
        println!("{}", code);
    }
    Ok(())
}

/// 命令行：`xynote-sync-server gen-license-codes [--count 10] [--max-devices 3] [--note 备注]`
/// 生成永久版激活码（XYP-…），每行一个，用于赠送或手动发放。
fn gen_license_codes(args: &[String]) -> Result<(), String> {
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let count: u32 = get("--count").unwrap_or_else(|| "1".into()).parse().map_err(|_| "--count 需要是数字")?;
    let max: i64 = get("--max-devices").unwrap_or_else(|| "3".into()).parse().map_err(|_| "--max-devices 需要是数字")?;
    let state = app::AppState::open(app::Config::from_env())?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    for code in licensing::create_codes(&conn, count, max, &get("--note").unwrap_or_default(), None, None)? {
        println!("{}", code);
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("gen-license-codes") {
        if let Err(e) = gen_license_codes(&args[2..]) {
            eprintln!("生成失败：{}", e);
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("gen-codes") {
        if let Err(e) = gen_codes(&args[2..]) {
            eprintln!("生成失败：{}", e);
            std::process::exit(1);
        }
        return;
    }
    let config = app::Config::from_env();
    let bind = config.bind.clone();
    let state = app::AppState::open(config).expect("无法打开数据目录");
    let router = app::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await.expect("无法监听端口");
    println!("XyNote 同步服务器已启动：http://{}", bind);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("服务器异常退出");
}
