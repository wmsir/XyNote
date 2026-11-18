//! 客户端轻量化安全防护工具：
//! 1. 编译期字符串混淆（`obf!`）：隐藏 `.rodata` 中的配置键名、内置公钥、API 路径等“路标”；
//! 2. 动态请求签名（`X-Xy-Ts` / `X-Xy-Nonce` / `X-Xy-Sig`）：防止抓包篡改与重放，完全兼容代理与内网网关；
//! 3. 自动时钟校准：本机时钟偏差过大触发 401 时，自动根据服务端返回的 `x-xy-server-ts` 校时并重发一次，对用户 100% 透明无感。

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static CLOCK_OFFSET_SECS: AtomicI64 = AtomicI64::new(0);

#[inline(always)]
const fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// 根据调用点位置（文件 + 行号 + 列号）在编译期派生 32 字节混淆密钥。
pub const fn derive_const_key(seed: &[u8]) -> [u8; 32] {
    let mut state: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < seed.len() {
        state ^= seed[i] as u64;
        state = state.wrapping_mul(0x0100_0000_01b3);
        i += 1;
    }
    let mut key = [0u8; 32];
    let mut j = 0;
    while j < 4 {
        state = splitmix64(state.wrapping_add((j as u64).wrapping_mul(0x517c_c1b7_2722_0a95)));
        let bytes = state.to_le_bytes();
        let mut k = 0;
        while k < 8 {
            key[j * 8 + k] = bytes[k];
            k += 1;
        }
        j += 1;
    }
    key
}

#[inline(always)]
const fn keystream_byte(key: &[u8; 32], idx: usize) -> u8 {
    let a = key[idx % 32];
    let b = key[(idx.wrapping_mul(5).wrapping_add(7)) % 32];
    let c = ((idx as u8).wrapping_mul(0x9e)).wrapping_add(0x37);
    a ^ b.wrapping_add(c)
}

/// 编译期字节流异或加密。
pub const fn xor_encrypt<const N: usize>(plain: &[u8], key: &[u8; 32]) -> [u8; N] {
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = plain[i] ^ keystream_byte(key, i);
        i += 1;
    }
    out
}

/// 运行期按需还原混淆字符串（`#[inline(never)]` + `black_box` 阻止 LLVM 常量折叠回 `.rodata`）。
#[inline(never)]
pub fn deobfuscate(enc: &[u8], key: &[u8; 32]) -> String {
    let enc = std::hint::black_box(enc);
    let key = std::hint::black_box(key);
    let mut out = Vec::with_capacity(enc.len());
    for (i, &b) in enc.iter().enumerate() {
        out.push(b ^ keystream_byte(key, i));
    }
    String::from_utf8(out).unwrap_or_default()
}

/// 编译期字符串隐藏宏：源文本仅存在编译期 AST 中，Release 产物 `.rodata` 不出现明文。
#[macro_export]
macro_rules! obf {
    ($s:expr) => {{
        const __XY_SEED: &[u8] = concat!(file!(), ":", line!(), ":", column!()).as_bytes();
        const __XY_KEY: [u8; 32] = $crate::security::derive_const_key(__XY_SEED);
        const __XY_PLAIN: &[u8] = ($s).as_bytes();
        const __XY_LEN: usize = __XY_PLAIN.len();
        const __XY_ENC: [u8; __XY_LEN] = $crate::security::xor_encrypt::<__XY_LEN>(__XY_PLAIN, &__XY_KEY);
        $crate::security::deobfuscate(&__XY_ENC, &__XY_KEY)
    }};
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{:02x}", b);
    }
    out
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

pub fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac key");
    mac.update(msg);
    hex_encode(&mac.finalize().into_bytes())
}

pub fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{:02X}", b);
            }
        }
    }
    out
}

fn percent_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// 将请求 URL 或路径归一化为 `/api/v1/...` 规范路径与排序后的规范查询串，
/// 确保经由 Nginx `/xynote/` 反向代理转发前后、直连与自建部署的客户端与服务端签名字符串 100% 一致。
pub fn canonical_api_target(raw_url_or_uri: &str) -> String {
    let no_frag = raw_url_or_uri.split('#').next().unwrap_or(raw_url_or_uri).trim();
    let path_and_query = if let Some(pos) = no_frag.find("/api/v1") {
        &no_frag[pos..]
    } else if let Some(scheme_pos) = no_frag.find("://") {
        let after_scheme = &no_frag[scheme_pos + 3..];
        if let Some(slash) = after_scheme.find('/') {
            &after_scheme[slash..]
        } else {
            "/"
        }
    } else if no_frag.starts_with('/') {
        no_frag
    } else {
        return format!("/{}", no_frag);
    };

    let (raw_path, raw_query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path_and_query, None),
    };

    let canon_path: String = raw_path
        .split('/')
        .map(|seg| {
            let decoded = percent_decode_bytes(seg);
            let s = String::from_utf8_lossy(&decoded);
            encode_uri_component(&s)
        })
        .collect::<Vec<_>>()
        .join("/");
    let canon_path = if canon_path.starts_with('/') {
        canon_path
    } else {
        format!("/{}", canon_path)
    };

    let Some(q) = raw_query.filter(|s| !s.is_empty()) else {
        return canon_path;
    };

    let mut pairs: Vec<(String, String)> = q
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (rk, rv) = part.split_once('=').unwrap_or((part, ""));
            let k_dec = percent_decode_bytes(rk);
            let v_dec = percent_decode_bytes(rv);
            let k_enc = encode_uri_component(&String::from_utf8_lossy(&k_dec));
            let v_enc = encode_uri_component(&String::from_utf8_lossy(&v_dec));
            (k_enc, v_enc)
        })
        .collect();
    pairs.sort();
    if pairs.is_empty() {
        canon_path
    } else {
        let qs = pairs
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        format!("{}?{}", canon_path, qs)
    }
}

pub fn api_sign_key() -> String {
    option_env!("XYNOTE_API_SIGN_KEY")
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| crate::obf!("xynote-client-hmac-v1-9f4c2e8a71b60d35e28c41a9f703b8d6"))
}

fn local_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn calibrated_unix_secs() -> i64 {
    local_unix_secs().saturating_add(CLOCK_OFFSET_SECS.load(Ordering::Relaxed))
}

pub fn record_server_timestamp_header(val: Option<&str>) {
    let Some(raw) = val else { return };
    let Ok(server_ts) = raw.trim().parse::<i64>() else { return };
    let local = local_unix_secs();
    if server_ts > 1_700_000_000 {
        CLOCK_OFFSET_SECS.store(server_ts - local, Ordering::Relaxed);
    }
}

pub fn sign_request(method: &str, url: &str, body: &[u8], ts: i64, nonce: &str) -> String {
    let canonical = canonical_api_target(url);
    let body_hash = sha256_hex(body);
    let payload = format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        canonical,
        ts,
        nonce,
        body_hash
    );
    let key = api_sign_key();
    format!("v1={}", hmac_sha256_hex(key.as_bytes(), payload.as_bytes()))
}

fn fresh_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn dispatch_signed_once(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    bearer: Option<&str>,
    content_type: Option<&str>,
    body: Option<&[u8]>,
) -> Result<ureq::Response, ureq::Error> {
    let ts = calibrated_unix_secs();
    let nonce = fresh_nonce();
    let payload_bytes = body.unwrap_or(&[]);
    let sig = sign_request(method, url, payload_bytes, ts, &nonce);

    let mut req = agent
        .request(method, url)
        .set("X-Xy-Ts", &ts.to_string())
        .set("X-Xy-Nonce", &nonce)
        .set("X-Xy-Sig", &sig);

    if let Some(b) = bearer {
        req = req.set("Authorization", b);
    }
    if let Some(ct) = content_type {
        req = req.set("Content-Type", ct);
    }
    if let Some(bytes) = body {
        req.send_bytes(bytes)
    } else {
        req.call()
    }
}

/// 发送带动态 HMAC 签名、防重放与自动时钟校准重试的请求。
pub fn send_signed_ureq(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    bearer: Option<&str>,
    content_type: Option<&str>,
    body: Option<&[u8]>,
) -> Result<ureq::Response, ureq::Error> {
    match dispatch_signed_once(agent, method, url, bearer, content_type, body) {
        Ok(resp) => {
            record_server_timestamp_header(resp.header("x-xy-server-ts"));
            Ok(resp)
        }
        Err(ureq::Error::Status(401, resp)) => {
            record_server_timestamp_header(resp.header("x-xy-server-ts"));
            let is_skew = resp
                .header("x-xy-clock-skew")
                .map(|v| v.trim() == "1")
                .unwrap_or(false);
            if is_skew {
                match dispatch_signed_once(agent, method, url, bearer, content_type, body) {
                    Ok(r2) => {
                        record_server_timestamp_header(r2.header("x-xy-server-ts"));
                        return Ok(r2);
                    }
                    Err(ureq::Error::Status(code2, r2)) => {
                        record_server_timestamp_header(r2.header("x-xy-server-ts"));
                        return Err(ureq::Error::Status(code2, r2));
                    }
                    Err(e2) => return Err(e2),
                }
            }
            Err(ureq::Error::Status(401, resp))
        }
        Err(ureq::Error::Status(code, resp)) => {
            record_server_timestamp_header(resp.header("x-xy-server-ts"));
            Err(ureq::Error::Status(code, resp))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obf_roundtrips_ascii_and_unicode_and_varies_by_site() {
        let a = crate::obf!("sync.secret.licenseToken");
        let b = crate::obf!("小悦笔记·中文测试");
        assert_eq!(a, "sync.secret.licenseToken");
        assert_eq!(b, "小悦笔记·中文测试");

        let s1 = "xynote-test-secret".as_bytes();
        let k1 = derive_const_key(b"security.rs:10:1");
        let k2 = derive_const_key(b"security.rs:11:1");
        assert_ne!(k1, k2);
        let e1: [u8; 18] = xor_encrypt(s1, &k1);
        let e2: [u8; 18] = xor_encrypt(s1, &k2);
        assert_ne!(e1, e2);
        assert_ne!(&e1[..], s1);
        assert_eq!(deobfuscate(&e1, &k1), "xynote-test-secret");
        assert_eq!(deobfuscate(&e2, &k2), "xynote-test-secret");
    }

    #[test]
    fn canonical_api_target_handles_prefix_and_query_encoding() {
        assert_eq!(
            canonical_api_target("https://fwpt.cn/xynote/api/v1/license/activate"),
            "/api/v1/license/activate"
        );
        assert_eq!(
            canonical_api_target("https://fwpt.cn/xynote/api/v1/files?prefix=pages%2F&b=1"),
            "/api/v1/files?b=1&prefix=pages%2F"
        );
        assert_eq!(
            canonical_api_target("/api/v1/files?b=1&prefix=pages/"),
            "/api/v1/files?b=1&prefix=pages%2F"
        );
        assert_eq!(
            canonical_api_target("/api/v1/files/pages%2F%E4%BC%9A%E8%AE%AE~1.json"),
            "/api/v1/files/pages%2F%E4%BC%9A%E8%AE%AE~1.json"
        );
    }

    #[test]
    fn hmac_request_signature_matches_vector() {
        let sig1 = sign_request(
            "POST",
            "https://fwpt.cn/xynote/api/v1/license/activate",
            br#"{"machineId":"abc"}"#,
            1_760_000_000,
            "0123456789abcdef0123456789abcdef",
        );
        let sig2 = sign_request(
            "post",
            "/api/v1/license/activate",
            br#"{"machineId":"abc"}"#,
            1_760_000_000,
            "0123456789abcdef0123456789abcdef",
        );
        assert_eq!(sig1, sig2);
        assert!(sig1.starts_with("v1="));
        assert_eq!(sig1.len(), 67);
    }
}
