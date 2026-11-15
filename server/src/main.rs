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
//! | `XYNOTE_ADMIN_TOKEN`        | 空（关闭）      | 管理接口令牌，用于开通 / 续费套餐（支付回调调用） |

mod app;

use app::OpenState;

#[tokio::main]
async fn main() {
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
