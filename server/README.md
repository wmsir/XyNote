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
| `XYNOTE_ONEID_BASE` | 空 | FWPT 通行证后端（官方部署，如 `http://127.0.0.1:8088`）。设置后网站和软件都用通行证登录，本服务不再开放注册 |
| `XYNOTE_CORS_ORIGINS` | 空 | 允许调用接口的网站，逗号分隔，官方填 `https://fwpt.cn` |
| `XYNOTE_LICENSE_KEY_FILE` | 空 | 永久版签名私钥文件（`tools/license keygen` 生成）；未设置时永久版不开放购买 |
| `XYNOTE_PRICE_SYNC_YEAR_CENTS` | `990` | 官方云同步一年的价格（分） |
| `XYNOTE_PRICE_LIFETIME_CENTS` | `9900` | 永久版价格（分） |
| `XYNOTE_SYNC_QUOTA_MB` | `10240` | 购买云同步后的空间 |
| `XYNOTE_ADMIN_TOKEN` | 空 | 管理接口令牌（至少 16 位），为空时管理接口关闭；命令行 `gen-codes` 不需要 |

## 官网购买（fwpt.cn）

官方部署时，购买在网站完成，软件内不做支付：

1. 用户在 `fwpt.cn/xynote.html` 登录 FWPT 通行证，选择「官方云同步 · 一年 ¥9.9」或「永久版 · 终生 ¥99」下单。
2. 页面显示金额、收款码和 4 位**付款码**，用户付款时把付款码写在备注里。
3. 管理员打开 `fwpt.cn/xynote-admin.html`（通行证角色为 ADMIN，或输入 `XYNOTE_ADMIN_TOKEN`），核对到账后点「确认到账」：
   - 云同步：该账号有效期顺延 365 天（未过期时接在原有效期之后），空间提升到 `XYNOTE_SYNC_QUOTA_MB`；
   - 永久版：用 `XYNOTE_LICENSE_KEY_FILE` 签发授权码，显示在用户的「我的订单」里。
4. 用户在软件「设置 → 同步 → 官方云同步」用同一个通行证登录，云同步生效，永久版自动激活。

官方部署示例（同步服务放在 `sync.fwpt.cn`，通行证后端在本机 8088）：

```bash
docker run -d --name xynote-sync -p 127.0.0.1:8787:8787 \
  -v xynote-data:/data -v /etc/xynote/license.key:/keys/license.key:ro \
  -e XYNOTE_REQUIRE_SUBSCRIPTION=true \
  -e XYNOTE_ONEID_BASE=http://host.docker.internal:8088 --add-host=host.docker.internal:host-gateway \
  -e XYNOTE_CORS_ORIGINS=https://fwpt.cn \
  -e XYNOTE_LICENSE_KEY_FILE=/keys/license.key \
  xynote-sync-server
```

接口：`GET /api/v1/store/products`、`GET|POST /api/v1/store/orders`、`POST /api/v1/store/orders/{id}/cancel`、`GET /api/v1/licenses`；管理：`GET /api/v1/admin/orders?status=pending`、`POST /api/v1/admin/orders/{id}/confirm|reject`。

## 激活码（批量发放、活动赠送）

除了官网下单，也可以生成激活码用于赠送或批量发放：用户在客户端「设置 → 同步 → 官方云同步」登录后输入激活码即可开通；续期时天数接在当前有效期之后。激活码形如 `XYN-7K2M-Q9TP-4HXW-RC3D`，每个只能使用一次，数据库只保存其哈希。

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
