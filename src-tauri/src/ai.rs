//! AI 写作助手：调用兼容 OpenAI 接口的大模型（DeepSeek、通义千问、Kimi、智谱、本地 Ollama 等）。
//! 默认关闭；只有用户在设置里填了地址和密钥并打开后才会联网。

use crate::db::Database;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

pub const SETTING_KEY: &str = "ai.config";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

pub fn load(db: &Database) -> AiConfig {
    db.get_settings()
        .ok()
        .and_then(|s| s.get(SETTING_KEY).cloned())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn endpoint(base: &str) -> Result<String, String> {
    let b = base.trim().trim_end_matches('/');
    let lower = b.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("接口地址需要以 http:// 或 https:// 开头".into());
    }
    if lower.ends_with("/chat/completions") {
        Ok(b.to_string())
    } else {
        Ok(format!("{}/chat/completions", b))
    }
}

/// 发一次对话请求，返回模型的回答
pub fn complete(cfg: &AiConfig, system: &str, user: &str) -> Result<String, String> {
    if !cfg.enabled {
        return Err("AI 写作助手还没有打开，请到「偏好设置 → AI 写作助手」里设置".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("还没有填写模型名称".into());
    }
    let url = endpoint(&cfg.base_url)?;
    let body = json!({
        "model": cfg.model.trim(),
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.7,
        "stream": false
    });
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build();
    let mut req = agent.post(&url).set("Content-Type", "application/json");
    if !cfg.api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", cfg.api_key.trim()));
    }
    let resp = match req.send_string(&body.to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let mut text = String::new();
            let _ = r.into_reader().take(64 * 1024).read_to_string(&mut text);
            let detail = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .or_else(|| v.pointer("/message"))
                        .and_then(|m| m.as_str().map(str::to_string))
                })
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(match code {
                401 | 403 => format!("密钥无效或没有权限（{}）：{}", code, detail),
                404 => format!("接口地址或模型名称不对（404）：{}", detail),
                429 => format!("请求太频繁或额度用完了（429）：{}", detail),
                _ => format!("模型服务返回错误 {}：{}", code, detail),
            });
        }
        Err(e) => return Err(format!("连不上模型服务：{}", e)),
    };
    let mut text = String::new();
    resp.into_reader()
        .take(4 * 1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|e| format!("读取回答失败：{}", e))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "模型返回的内容看不懂".to_string())?;
    let answer = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    // 部分推理模型会把思考过程放在 <think> 里，去掉
    let cleaned = strip_think(&answer);
    if cleaned.is_empty() {
        return Err("模型没有返回内容".into());
    }
    Ok(cleaned)
}

fn strip_think(s: &str) -> String {
    let mut out = s.to_string();
    while let (Some(a), Some(b)) = (out.find("<think>"), out.find("</think>")) {
        if b < a {
            break;
        }
        out.replace_range(a..b + "</think>".len(), "");
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_appends_chat_completions() {
        assert_eq!(endpoint("https://api.deepseek.com/v1/").unwrap(), "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(
            endpoint("http://localhost:11434/v1/chat/completions").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert!(endpoint("ftp://x").is_err());
    }

    #[test]
    fn disabled_config_refuses() {
        let cfg = AiConfig::default();
        assert!(complete(&cfg, "s", "u").unwrap_err().contains("还没有打开"));
    }

    #[test]
    fn strips_think_blocks() {
        assert_eq!(strip_think("<think>嗯……</think>\n答案"), "答案");
        assert_eq!(strip_think("没有思考"), "没有思考");
    }
}
