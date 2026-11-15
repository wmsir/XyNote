# 永久版授权码工具

小悦笔记永久版使用离线授权码：你用私钥签发，软件内置公钥校验，用户激活时不需要联网。

## 第一次：生成密钥

```bash
cargo run --release -- keygen --out xynote-license.key
```

- 私钥文件 `xynote-license.key` 自己保管并备份。丢失后无法再签发；泄露后别人可以伪造授权码。**不要提交到仓库。**
- 把输出的公钥填进 `src-tauri/license_pubkey.txt`，提交后构建发布的软件即可激活。

## 签发授权码

```bash
# 授权给某人（显示在软件「永久版」页面），可填姓名、昵称或订单号
cargo run --release -- issue --key xynote-license.key --name "订单 20261115001"
```

输出形如 `XYNOTE1.eyJ2Ijox….xxxx` 的一行，发给用户；用户在「设置 → 永久版」粘贴激活。
`--count 50` 可批量生成，导入 fwpt.cn 的发卡系统。

授权码与姓名 / 订单号绑定并显示在软件里，有一定防分享作用；离线授权无法完全防止转发。
