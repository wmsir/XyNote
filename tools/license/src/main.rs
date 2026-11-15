//! 小悦笔记永久版授权码生成工具。
//!
//! ```text
//! xynote-license keygen [--out xynote-license.key]
//! xynote-license issue --key xynote-license.key --name 张三 [--count 1]
//! ```
//!
//! `keygen` 只需运行一次：私钥文件自己妥善保管（丢了就无法再发码，泄露了别人就能伪造授权码），
//! 输出的公钥填进 `src-tauri/license_pubkey.txt` 后构建发布。

#[path = "../../../src-tauri/src/license_format.rs"]
mod license_format;

use ed25519_dalek::SigningKey;
use license_format::{hex, parse_hex32, sign, LicensePayload};
use rand::RngCore;
use std::path::Path;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn usage() -> ! {
    eprintln!("用法：\n  xynote-license keygen [--out xynote-license.key]\n  xynote-license issue --key xynote-license.key --name 张三 [--count 1]");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("keygen") => keygen(&args[1..]),
        Some("issue") => issue(&args[1..]),
        Some("verify") => verify_cmd(&args[1..]),
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("错误：{}", e);
        std::process::exit(1);
    }
}

fn keygen(args: &[String]) -> Result<(), String> {
    let out = arg(args, "--out").unwrap_or_else(|| "xynote-license.key".into());
    if Path::new(&out).exists() {
        return Err(format!("{} 已存在，为防止覆盖私钥已停止", out));
    }
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    std::fs::write(&out, format!("{}\n", hex(&key.to_bytes()))).map_err(|e| e.to_string())?;
    println!("私钥已保存到 {}（请备份并妥善保管，切勿提交到代码仓库）", out);
    println!("公钥（填入 src-tauri/license_pubkey.txt）：");
    println!("{}", hex(&key.verifying_key().to_bytes()));
    Ok(())
}

/// `xynote-license verify --pubkey-file src-tauri/license_pubkey.txt --license XYNOTE1.…`
fn verify_cmd(args: &[String]) -> Result<(), String> {
    let file = arg(args, "--pubkey-file").ok_or("缺少 --pubkey-file")?;
    let license = arg(args, "--license").ok_or("缺少 --license")?;
    let raw = std::fs::read_to_string(&file).map_err(|e| format!("读取公钥失败：{}", e))?;
    let key = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .and_then(parse_hex32)
        .ok_or("公钥文件里没有公钥")?;
    let p = license_format::verify(&license, &key)?;
    println!("签名有效：{} / {} / {}", p.id, p.name, p.edition);
    Ok(())
}

fn issue(args: &[String]) -> Result<(), String> {
    let key_path = arg(args, "--key").ok_or("缺少 --key")?;
    let name = arg(args, "--name").ok_or("缺少 --name（授权给谁：姓名、昵称或订单号）")?;
    let count: u32 = arg(args, "--count").unwrap_or_else(|| "1".into()).parse().map_err(|_| "--count 需要是数字")?;
    let raw = std::fs::read_to_string(&key_path).map_err(|e| format!("读取私钥失败：{}", e))?;
    let key = SigningKey::from_bytes(&parse_hex32(&raw).ok_or("私钥文件格式不正确")?);
    for _ in 0..count.max(1) {
        let mut id = [0u8; 6];
        rand::rngs::OsRng.fill_bytes(&mut id);
        let payload = LicensePayload {
            v: 1,
            id: format!("L-{}", hex(&id).to_uppercase()),
            name: name.clone(),
            edition: "lifetime".into(),
            issued_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            machine: None,
        };
        println!("{}", sign(&payload, &key));
    }
    Ok(())
}
