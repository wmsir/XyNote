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
| `XYNOTE_LICENSE_KEY_FILE` | 空 | 永久版签名私钥文件（`tools/license keygen` 生成）；未设置时无法登录激活永久版 |
| `XYNOTE_PRICE_LIFETIME_CENTS` | `990` | 永久版价格（分） |
| `XYNOTE_PRICE_DEVICE_SLOT_CENTS` | `300` | 增加 1 台电脑的价格（分） |
| `XYNOTE_ADMIN_TOKEN` | 空 | 管理接口令牌（至少 16 位），为空时管理接口关闭；命令行 `gen-codes` 不需要 |

## 官方部署：小悦笔记服务（fwpt.cn/xynote/）

官方部署时，本服务就是小悦笔记的后台：授权、订单、意见反馈，并自带两个网页：

| 地址 | 内容 |
|---|---|
| `https://fwpt.cn/xynote/` | **用户中心**：授权状态、已绑定的电脑（可解绑）、购买、订单与激活码、意见反馈与回复 |
| `https://fwpt.cn/xynote/admin/` | **管理后台**：概览统计、订单确认、激活码、用户、意见反馈（通行证角色为 ADMIN，或输入 `XYNOTE_ADMIN_TOKEN`） |

fwpt.cn 首页（index 项目）只负责介绍和跳转。用户在 fwpt.cn 已登录时，用户中心会直接沿用通行证登录状态。

### 授权规则

- **免费一年，1 台电脑**：通行证账号第一次在软件里登录，自动获得一年永久版权限，只能绑定 1 台电脑；换电脑时在旧电脑「停用本机授权」或在用户中心解绑。
- **永久版 ¥9.9，3 台电脑**：激活码 `XYP-…` 第一次激活时绑定通行证账号。
- **增加电脑 ¥3 / 台**：3 台不够用时在用户中心或软件里单独购买，确认后给账号名下的激活码 +1 台。
- 每次登录 / 激活都会记录机器指纹、名称、系统、版本，管理后台可以看到。
- 授权令牌用 `XYNOTE_LICENSE_KEY_FILE` 的私钥签名（绑定机器，免费期带到期时间），软件内置对应公钥离线校验。

### 购买流程

用户在用户中心或软件里下单 → 扫码付款并备注付款码 → 把付款截图和订单信息发到 admin@fwpt.cn → 管理员在管理后台核对后点「确认到账」：永久版生成激活码并「发送邮件」给用户；增加电脑直接给激活码 +1 台。

### 部署

```bash
docker run -d --name xynote -p 127.0.0.1:8787:8787 \
  -v xynote-data:/data -v /etc/xynote/license.key:/keys/license.key:ro \
  -e XYNOTE_ONEID_BASE=http://host.docker.internal:8088 --add-host=host.docker.internal:host-gateway \
  -e XYNOTE_LICENSE_KEY_FILE=/keys/license.key \
  xynote-sync-server
```

Nginx（fwpt.cn 的 server 块里加一段，`/xynote/` 末尾的斜杠不能少）：

```nginx
location = /xynote { return 301 /xynote/; }
location /xynote/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 64m;
}
```

客户端默认连接 `https://fwpt.cn/xynote`（授权、订单、反馈），登录直接使用 fwpt.cn 首页同一个通行证接口 `https://fwpt.cn/api/v1/auth/login`。构建时可用 `XYNOTE_OFFICIAL_SYNC_URL`、`XYNOTE_ONEID_URL` 覆盖。

手动生成激活码（赠送、活动）：

```bash
docker exec xynote xynote-sync-server gen-license-codes --count 10 --note "活动赠送"
```

主要接口：`POST /api/v1/license/activate`、`POST /api/v1/license/deactivate`、`GET /api/v1/me`、`POST /api/v1/me/devices/{machineId}/unbind`、`GET|POST /api/v1/store/orders`、`POST /api/v1/feedback`、`GET /api/v1/feedback/mine`；管理：`GET /api/v1/admin/stats`、`/api/v1/admin/orders`、`/api/v1/admin/license-codes`、`/api/v1/admin/users`、`/api/v1/admin/feedback`。

## 同步订阅激活码（自建服务器）

自建服务器开启 `XYNOTE_REQUIRE_SUBSCRIPTION=true` 时，可以用同步订阅激活码给用户开通云同步：用户在客户端「设置 → 同步 → 自建服务器」登录后输入激活码，续期时天数接在当前有效期之后。激活码形如 `XYN-7K2M-Q9TP-4HXW-RC3D`，每个只能使用一次，数据库只保存其哈希。（与永久版激活码 `XYP-…` 不同。）

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
