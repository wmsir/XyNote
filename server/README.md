# XyNote 同步服务器

小悦笔记的同步服务端：一个按用户隔离的文件存储，配合客户端的同步引擎使用。客户端可开启端到端加密，服务器只保存密文。

同一个程序有两种用法：

- **自建**：部署在自己的服务器 / NAS 上，客户端选择「自建服务器」并填写地址。
- **官方付费服务**：设置 `XYNOTE_REQUIRE_SUBSCRIPTION=true`，没有有效订阅的账号只能下载已有数据、不能上传；用户在官网购买激活码、在客户端输入后开通。

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
| `XYNOTE_ADMIN_TOKEN` | 空 | 管理接口令牌（至少 16 位），为空时管理接口关闭；命令行 `gen-codes` 不需要 |

## 激活码（官方服务的收费方式）

软件内不做支付。用户在官网 [fwpt.cn](https://fwpt.cn) 购买激活码，在客户端「设置 → 同步 → 官方云同步」登录后输入激活码即可开通；续期时天数接在当前有效期之后。激活码形如 `XYN-7K2M-Q9TP-4HXW-RC3D`，每个只能使用一次，数据库只保存其哈希。

批量生成（每行一个，可直接导入官网的发卡系统）：

```bash
# 年付 10 GB，生成 100 个
docker exec xynote-sync xynote-sync-server gen-codes --plan pro --days 365 --quota-mb 10240 --count 100 --note "2026-11 年付" > codes.txt
```

也可以通过接口生成（需 `XYNOTE_ADMIN_TOKEN`），方便官网下单后自动发码：

```bash
curl -X POST https://你的域名/api/v1/admin/codes \
  -H "Authorization: Bearer $XYNOTE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro","days":365,"quotaMb":10240,"count":1,"note":"订单 123"}'
```

需要人工处理（退款、补偿）时，可直接设置某个账号的套餐：

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
| POST | `/api/v1/redeem` | `{code}` 兑换激活码 |
| POST | `/api/v1/admin/codes` | 管理：批量生成激活码 |
| POST | `/api/v1/admin/users/plan` | 管理：设置套餐 |
| GET | `/healthz` | 健康检查 |

除注册、登录、健康检查外，其余接口需要 `Authorization: Bearer <token>`。
