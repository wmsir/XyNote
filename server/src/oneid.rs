//! FWPT 统一通行证（OneID）对接：官方部署时，网站和软件都用 fwpt.cn 的账号登录。
//!
//! - 校验：`GET {base}/api/v1/user/profile`（Bearer JWT），返回 `{code:"00000", data:{id, username, email, nickname, role}}`
//! - 登录：`POST {base}/api/v1/auth/login`，返回 `{data:{token | access_token}}`
//!
//! 这里都是阻塞调用，调用方放在 `spawn_blocking` 里执行。

use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct OneIdUser {
    /// 稳定标识：`oneid:<id>`
    pub key: String,
    /// 展示用：昵称 / 用户名 / 邮箱
    pub display: String,
    pub role: String,
    /// 通行证绑定的邮箱（用于发送激活码）
    pub email: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(4)).timeout(Duration::from_secs(8)).build()
}

fn body_ok(body: &Value) -> bool {
    body.get("code").and_then(Value::as_str) == Some("00000") || body.get("success").and_then(Value::as_bool) == Some(true)
}

fn message_of(body: &Value) -> Option<String> {
    ["message", "msg", "detail"]
        .iter()
        .find_map(|k| body.get(*k).and_then(Value::as_str))
        .map(str::to_string)
        .filter(|m| !m.trim().is_empty())
}

/// 解析通行证资料；无法识别时返回 None
pub fn parse_profile(body: &Value) -> Option<OneIdUser> {
    if !body_ok(body) {
        return None;
    }
    let data = body.get("data")?;
    let text = |k: &str| data.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let key = match data.get("id") {
        Some(Value::Number(n)) => format!("oneid:{}", n),
        Some(Value::String(s)) if !s.trim().is_empty() => format!("oneid:{}", s.trim()),
        _ => format!("oneid_user:{}", text("username")?.to_lowercase()),
    };
    let display = text("nickname")
        .or_else(|| text("realName"))
        .or_else(|| text("displayName"))
        .or_else(|| text("username"))
        .or_else(|| text("email"))
        .unwrap_or_else(|| key.clone());
    Some(OneIdUser {
        key,
        display,
        role: text("role").unwrap_or_default().to_uppercase(),
        email: text("email").filter(|e| e.contains('@')),
    })
}

/// 用 JWT 换取通行证资料；Ok(None) 表示令牌无效
pub fn verify(base: &str, token: &str) -> Result<Option<OneIdUser>, String> {
    let res = agent()
        .get(&format!("{}/api/v1/user/profile", base))
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/json")
        .call();
    match res {
        Ok(resp) => {
            let body: Value = resp.into_json().map_err(|e| e.to_string())?;
            Ok(parse_profile(&body))
        }
        Err(ureq::Error::Status(401 | 403, _)) => Ok(None),
        Err(ureq::Error::Status(_, resp)) => {
            let body: Value = resp.into_json().unwrap_or(Value::Null);
            if body.is_object() { Ok(parse_profile(&body)) } else { Err("通行证服务异常".into()) }
        }
        Err(e) => Err(format!("无法连接通行证服务：{}", e)),
    }
}

/// 用通行证账号密码登录，返回 JWT
pub fn login(base: &str, account: &str, password: &str) -> Result<String, String> {
    let payload = serde_json::json!({ "account": account, "username": account, "password": password, "source": "XYNOTE" });
    let res = agent()
        .post(&format!("{}/api/v1/auth/login", base))
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string());
    let body: Value = match res {
        Ok(resp) => resp.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, resp)) => resp.into_json().unwrap_or(Value::Null),
        Err(e) => return Err(format!("无法连接通行证服务：{}", e)),
    };
    let data = body.get("data").filter(|d| d.is_object()).unwrap_or(&body);
    data.get("token")
        .or_else(|| data.get("access_token"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| message_of(&body).unwrap_or_else(|| "账号或密码不正确".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_profiles() {
        let u = parse_profile(&json!({"code":"00000","data":{"id":42,"username":"wm","nickname":"小王","role":"admin"}})).unwrap();
        assert_eq!(u, OneIdUser { key: "oneid:42".into(), display: "小王".into(), role: "ADMIN".into(), email: None });
        let u = parse_profile(&json!({"code":"00000","data":{"id":7,"username":"wm","realName":"王明","role":"ADMIN"}})).unwrap();
        assert_eq!(u, OneIdUser { key: "oneid:7".into(), display: "王明".into(), role: "ADMIN".into(), email: None });
        let u = parse_profile(&json!({"success":true,"data":{"username":"Bob","email":"b@x.cn"}})).unwrap();
        assert_eq!(u.key, "oneid_user:bob");
        assert_eq!(u.email.as_deref(), Some("b@x.cn"));
        assert!(parse_profile(&json!({"code":"A0301","message":"token expired"})).is_none());
    }
}
