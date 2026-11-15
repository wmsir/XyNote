# XyNote 同步服务器

小悦笔记的同步服务端：一个按用户隔离的文件存储，配合客户端的同步引擎使用。客户端可开启端到端加密，服务器只保存密文。

同一个程序有两种用法：

- **自建**：部署在自己的服务器 / NAS 上，客户端选择「自建服务器」并填写地址。
- **官方付费服务**：设置 `XYNOTE_REQUIRE_SUBSCRIPTION=true`，没有有效订阅的账号只能下载已有数据、不能上传；由支付系统回调管理接口开通 / 续费。

## 运行

```bash
# Docker
docker build -t xynote-sync-server .
docker run -d --name xynote-sync -p 8787:8787 -v xynote-data:/data xynote-sync-server

# 或直接运行
cargo run --release
```

对外提供服务时请放在 HTTPS 反向代理（Nginx、Caddy 等）之后。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `XYNOTE_BIND` | `0.0.0.0:8787` | 监听地址 |
| `XYNOTE_DATA_DIR` | `./data` | 数据库与文件目录（Docker 中为 `/data`） |
| `XYNOTE_ALLOW_REGISTRATION` | `true` | 是否开放注册。自建时建好自己的账号后可设为 `false` |
| `XYNOTE_REQUIRE_SUBSCRIPTION` | `false` | 官方服务设为 `true` |
| `XYNOTE_DEFAULT_QUOTA_MB` | `2048` | 新用户的空间配额（MB） |
| `XYNOTE_ADMIN_TOKEN` | 空 | 管理接口令牌（至少 16 位），为空时管理接口关闭 |

## 开通 / 续费套餐

支付成功后，由支付系统的回调（或运维脚本）调用：

```bash
curl -X POST https://你的域名/api/v1/admin/users/plan \
  -H "Authorization: Bearer $XYNOTE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","plan":"pro","expiresAt":"2027-11-15T00:00:00Z","quotaMb":10240}'
```

`plan` 为 `free` 以外的值且未过期即视为订阅有效。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/register` | `{email, password}` → `{token, account}` |
| POST | `/api/v1/auth/login` | 同上 |
| GET | `/api/v1/account` | 账号、套餐、配额与用量 |
| GET | `/api/v1/files?prefix=` | 列出文件 |
| GET / PUT / DELETE | `/api/v1/files/{key}` | 读 / 写 / 删文件 |
| POST | `/api/v1/admin/users/plan` | 管理：设置套餐 |
| GET | `/healthz` | 健康检查 |

除注册、登录、健康检查外，其余接口需要 `Authorization: Bearer <token>`。
