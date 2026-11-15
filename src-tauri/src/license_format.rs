//! 永久版授权码格式（客户端与发码工具共用此文件）。
//!
//! `XYNOTE1.<载荷 base64url>.<Ed25519 签名 base64url>`
//! 载荷是 JSON：`{"v":1,"id":"…","name":"…","edition":"lifetime","issuedAt":"…"}`。
//! 私钥只在发码工具那边，软件内置公钥离线校验，不需要联网。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const PREFIX: &str = "XYNOTE1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePayload {
    pub v: u32,
    /// 授权编号，便于售后查询
    pub id: String,
    /// 授权给（姓名、昵称或订单号）
    pub name: String,
    /// lifetime 永久版 / trial 注册赠送的一年
    pub edition: String,
    pub issued_at: String,
    /// 到期时间；永久版为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// 绑定的机器指纹；为空表示不绑定（发码工具签发的离线授权）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

pub fn sign(payload: &LicensePayload, key: &SigningKey) -> String {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).expect("payload json"));
    let sig = key.sign(format!("{}.{}", PREFIX, body).as_bytes());
    format!("{}.{}.{}", PREFIX, body, URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

/// 校验授权码；粘贴时混入的空白、换行会被忽略
pub fn verify(license: &str, public_key: &[u8; 32]) -> Result<LicensePayload, String> {
    let compact: String = license.chars().filter(|c| !c.is_whitespace()).collect();
    let mut parts = compact.split('.');
    let (Some(prefix), Some(body), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("授权码格式不正确，请完整复制".into());
    };
    if prefix != PREFIX {
        return Err("这不是小悦笔记的永久版授权码".into());
    }
    let sig: [u8; 64] = URL_SAFE_NO_PAD
        .decode(sig)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("授权码格式不正确，请完整复制")?;
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| "软件内置的授权公钥无效".to_string())?;
    key.verify(format!("{}.{}", prefix, body).as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| "授权码无效".to_string())?;
    let payload: LicensePayload = URL_SAFE_NO_PAD
        .decode(body)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("授权码内容无法识别")?;
    if payload.v != 1 {
        return Err("授权码版本过新，请升级软件".into());
    }
    Ok(payload)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> LicensePayload {
        LicensePayload {
            v: 1,
            id: "L-0001".into(),
            name: "张三".into(),
            edition: "lifetime".into(),
            issued_at: "2026-11-15T00:00:00Z".into(),
            expires_at: None,
            machine: None,
        }
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let pubkey = key.verifying_key().to_bytes();
        let lic = sign(&payload(), &key);
        assert!(lic.starts_with("XYNOTE1."));
        assert_eq!(verify(&lic, &pubkey).unwrap(), payload());
        // 粘贴时被折行也能识别
        let wrapped = format!("  {}\n{} ", &lic[..30], &lic[30..]);
        assert_eq!(verify(&wrapped, &pubkey).unwrap().name, "张三");
    }

    #[test]
    fn tampered_or_foreign_licenses_are_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = key.verifying_key().to_bytes();
        assert!(verify(&sign(&payload(), &other), &pubkey).is_err(), "别人的私钥签的");
        let lic = sign(&payload(), &key);
        let mut forged = payload();
        forged.name = "李四".into();
        let forged_body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        let sig = lic.rsplit('.').next().unwrap();
        assert!(verify(&format!("XYNOTE1.{}.{}", forged_body, sig), &pubkey).is_err(), "改了名字");
        assert!(verify("hello", &pubkey).is_err());
        assert_eq!(parse_hex32(&hex(&pubkey)), Some(pubkey));
    }
}
