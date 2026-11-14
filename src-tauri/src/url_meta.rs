use crate::models::{AppError, UrlMetadata};
use std::io::Read;
use std::time::Duration;

#[derive(Debug, Clone)]
struct ParsedUrlParts {
    normalized: String,
    scheme: String,
    origin: String,
    host_clean: String,
    base_dir: String,
    slug_guess: String,
}

fn parse_url_parts(raw_url: &str) -> Result<ParsedUrlParts, AppError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("URL cannot be empty".into()));
    }
    let normalized = if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("HTTP://")
        || trimmed.starts_with("HTTPS://")
    {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let (scheme, after_scheme) = if let Some(rest) = normalized.strip_prefix("https://") {
        ("https".to_string(), rest)
    } else if let Some(rest) = normalized.strip_prefix("HTTPS://") {
        ("https".to_string(), rest)
    } else if let Some(rest) = normalized.strip_prefix("http://") {
        ("http".to_string(), rest)
    } else if let Some(rest) = normalized.strip_prefix("HTTP://") {
        ("http".to_string(), rest)
    } else {
        ("https".to_string(), normalized.as_str())
    };

    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = after_scheme[..authority_end].trim();
    if authority.is_empty() {
        return Err(AppError::Validation(format!("Invalid URL: {}", raw_url)));
    }
    let host_only = authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or(authority)
        .trim();
    let host_clean = host_only
        .strip_prefix("www.")
        .or_else(|| host_only.strip_prefix("WWW."))
        .unwrap_or(host_only)
        .to_string();

    let origin = format!("{}://{}", scheme, authority);
    let path_and_more = &after_scheme[authority_end..];
    let path_only = path_and_more.split(['?', '#']).next().unwrap_or("");
    let base_dir = if let Some(slash_pos) = path_only.rfind('/') {
        format!("{}{}", origin, &path_only[..=slash_pos])
    } else {
        format!("{}/", origin)
    };

    let slug_guess = path_only
        .split('/')
        .rev()
        .find(|seg| !seg.trim().is_empty())
        .map(|seg| percent_decode_lossy(seg).replace(['-', '_'], " "))
        .unwrap_or_default();

    Ok(ParsedUrlParts {
        normalized,
        scheme,
        origin,
        host_clean,
        base_dir,
        slug_guess,
    })
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn fallback_metadata(parts: &ParsedUrlParts) -> UrlMetadata {
    let title = if !parts.slug_guess.trim().is_empty() {
        format!("{} — {}", parts.slug_guess.trim(), parts.host_clean)
    } else if !parts.host_clean.is_empty() {
        parts.host_clean.clone()
    } else {
        parts.normalized.clone()
    };
    UrlMetadata {
        url: parts.normalized.clone(),
        title,
        description: parts.normalized.clone(),
        site_name: parts.host_clean.clone(),
        favicon: format!("{}/favicon.ico", parts.origin),
    }
}

fn resolve_href(parts: &ParsedUrlParts, href: &str) -> String {
    let trimmed = decode_html_entities(href).trim().to_string();
    if trimmed.is_empty() {
        return format!("{}/favicon.ico", parts.origin);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:") {
        trimmed
    } else if trimmed.starts_with("//") {
        format!("{}:{}", parts.scheme, trimmed)
    } else if trimmed.starts_with('/') {
        format!("{}{}", parts.origin, trimmed)
    } else {
        format!("{}{}", parts.base_dir, trimmed.trim_start_matches("./"))
    }
}

pub fn decode_html_entities(input: &str) -> String {
    let mut s = input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&bull;", "•");

    // Decode numeric entities like `&#x27;` or `&#8212;`
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(pos) = rest.find("&#") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];
        if let Some(semi) = after.find(';') {
            let code_str = &after[..semi];
            let parsed_cp = if let Some(hex) = code_str
                .strip_prefix('x')
                .or_else(|| code_str.strip_prefix('X'))
            {
                u32::from_str_radix(hex, 16).ok()
            } else {
                code_str.parse::<u32>().ok()
            };
            if let Some(ch) = parsed_cp.and_then(char::from_u32) {
                out.push(ch);
                rest = &after[semi + 1..];
                continue;
            }
        }
        out.push_str("&#");
        rest = after;
    }
    out.push_str(rest);
    s = out;
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract attributes from an HTML opening tag like `<meta property="og:title" content="Hello">`.
fn parse_tag_attributes(tag_body: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let bytes = tag_body.as_bytes();
    let mut i = 0;

    // Skip tag name
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'/' && bytes[i] != b'>'
    {
        i += 1;
    }

    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' {
            break;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
        {
            i += 1;
        }
        let attr_name = tag_body[name_start..i].trim().to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let val_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                let val = &tag_body[val_start..i];
                if i < bytes.len() && bytes[i] == quote {
                    i += 1;
                }
                if !attr_name.is_empty() {
                    attrs.push((attr_name, val.to_string()));
                }
            } else {
                let val_start = i;
                while i < bytes.len()
                    && !bytes[i].is_ascii_whitespace()
                    && bytes[i] != b'>'
                    && bytes[i] != b'/'
                {
                    i += 1;
                }
                let val = &tag_body[val_start..i];
                if !attr_name.is_empty() {
                    attrs.push((attr_name, val.to_string()));
                }
            }
        } else if !attr_name.is_empty() {
            attrs.push((attr_name, String::new()));
        }
    }

    attrs
}

pub fn parse_html_metadata(final_url: &str, html: &str) -> Result<UrlMetadata, AppError> {
    let parts = parse_url_parts(final_url)?;
    let fallback = fallback_metadata(&parts);

    let mut og_title: Option<String> = None;
    let mut twitter_title: Option<String> = None;
    let mut doc_title: Option<String> = None;
    let mut og_desc: Option<String> = None;
    let mut meta_desc: Option<String> = None;
    let mut og_site: Option<String> = None;
    let mut icon_href: Option<String> = None;
    let mut apple_icon_href: Option<String> = None;

    // Limit scan to head / first 160 KB of HTML for fast parsing
    let scan_slice = if html.len() > 163_840 {
        let mut end = 163_840;
        while !html.is_char_boundary(end) {
            end -= 1;
        }
        &html[..end]
    } else {
        html
    };

    // Extract `<title>...</title>`
    let lower_html = scan_slice.to_ascii_lowercase();
    if let Some(t_open) = lower_html.find("<title") {
        if let Some(gt_rel) = lower_html[t_open..].find('>') {
            let content_start = t_open + gt_rel + 1;
            if let Some(t_close_rel) = lower_html[content_start..].find("</title>") {
                let raw_t = &scan_slice[content_start..content_start + t_close_rel];
                let decoded = decode_html_entities(raw_t);
                if !decoded.is_empty() {
                    doc_title = Some(decoded);
                }
            }
        }
    }

    // Scan `<meta ...>` and `<link ...>` tags
    let mut cursor = 0usize;
    while let Some(lt_rel) = scan_slice[cursor..].find('<') {
        let tag_start = cursor + lt_rel;
        let after_lt = &scan_slice[tag_start + 1..];
        let Some(gt_rel) = after_lt.find('>') else {
            break;
        };
        let tag_body = &after_lt[..gt_rel];
        cursor = tag_start + 1 + gt_rel + 1;

        let tag_lower_prefix: String = tag_body
            .chars()
            .take(8)
            .collect::<String>()
            .to_ascii_lowercase();

        if tag_lower_prefix.starts_with("meta")
            && tag_lower_prefix
                .chars()
                .nth(4)
                .map(|c| c.is_ascii_whitespace())
                .unwrap_or(false)
        {
            let attrs = parse_tag_attributes(tag_body);
            let mut key = String::new();
            let mut content = String::new();
            for (k, v) in attrs {
                if (k == "property" || k == "name") && key.is_empty() {
                    key = v.trim().to_ascii_lowercase();
                } else if k == "content" {
                    content = decode_html_entities(&v);
                }
            }
            if !content.is_empty() {
                match key.as_str() {
                    "og:title" if og_title.is_none() => og_title = Some(content),
                    "twitter:title" if twitter_title.is_none() => twitter_title = Some(content),
                    "og:description" if og_desc.is_none() => og_desc = Some(content),
                    "description" | "twitter:description" if meta_desc.is_none() => {
                        meta_desc = Some(content)
                    }
                    "og:site_name" if og_site.is_none() => og_site = Some(content),
                    _ => {}
                }
            }
        } else if tag_lower_prefix.starts_with("link")
            && tag_lower_prefix
                .chars()
                .nth(4)
                .map(|c| c.is_ascii_whitespace())
                .unwrap_or(false)
        {
            let attrs = parse_tag_attributes(tag_body);
            let mut rel = String::new();
            let mut href = String::new();
            for (k, v) in attrs {
                if k == "rel" {
                    rel = v.trim().to_ascii_lowercase();
                } else if k == "href" {
                    href = v.trim().to_string();
                }
            }
            if !href.is_empty() {
                let rel_tokens: Vec<&str> = rel.split_whitespace().collect();
                if rel_tokens.contains(&"icon") && icon_href.is_none() {
                    icon_href = Some(href);
                } else if rel.contains("apple-touch-icon") && apple_icon_href.is_none() {
                    apple_icon_href = Some(href);
                }
            }
        } else if tag_lower_prefix.starts_with("/head") {
            break;
        }
    }

    let title = og_title
        .or(twitter_title)
        .or(doc_title)
        .unwrap_or(fallback.title);
    let description = og_desc.or(meta_desc).unwrap_or_default();
    let site_name = og_site.unwrap_or(fallback.site_name);
    let favicon = icon_href
        .or(apple_icon_href)
        .map(|h| resolve_href(&parts, &h))
        .unwrap_or(fallback.favicon);

    Ok(UrlMetadata {
        url: parts.normalized,
        title,
        description,
        site_name,
        favicon,
    })
}

pub fn fetch_url_metadata_sync(raw_url: &str) -> Result<UrlMetadata, AppError> {
    let parts = parse_url_parts(raw_url)?;
    let fallback = fallback_metadata(&parts);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(4))
        .timeout(Duration::from_secs(4))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        )
        .build();

    let response = match agent
        .get(&parts.normalized)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .call()
    {
        Ok(resp) => resp,
        Err(_) => return Ok(fallback),
    };

    if response.status() < 200 || response.status() >= 300 {
        return Ok(fallback);
    }

    let final_url = response.get_url().to_string();
    let mut body_bytes = Vec::with_capacity(32_768);
    if response
        .into_reader()
        .take(262_144)
        .read_to_end(&mut body_bytes)
        .is_err()
        || body_bytes.is_empty()
    {
        return Ok(fallback);
    }

    let html = String::from_utf8_lossy(&body_bytes);
    parse_html_metadata(&final_url, &html).or(Ok(fallback))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_html_metadata_opengraph_and_relative_icon() {
        let html = r#"
        <!doctype html>
        <html>
          <head>
            <title>Fallback Title</title>
            <meta content="Tauri 2.0 &amp; Rust Desktop Apps" property="og:title" />
            <meta name="description" content="Build smaller, faster, and more secure desktop applications." />
            <meta property="og:site_name" content="Tauri" />
            <link rel="shortcut icon" href="/meta/favicon-32x32.png" />
          </head>
          <body></body>
        </html>
        "#;

        let meta = parse_html_metadata("https://v2.tauri.app/start/", html).unwrap();
        assert_eq!(meta.url, "https://v2.tauri.app/start/");
        assert_eq!(meta.title, "Tauri 2.0 & Rust Desktop Apps");
        assert_eq!(
            meta.description,
            "Build smaller, faster, and more secure desktop applications."
        );
        assert_eq!(meta.site_name, "Tauri");
        assert_eq!(meta.favicon, "https://v2.tauri.app/meta/favicon-32x32.png");
    }

    #[test]
    fn test_offline_unreachable_url_graceful_fallback() {
        // Port 9 (discard / closed localhost) immediately fails connect and triggers clean fallback
        let meta = fetch_url_metadata_sync("http://127.0.0.1:9/docs/getting-started").unwrap();
        assert_eq!(meta.url, "http://127.0.0.1:9/docs/getting-started");
        assert!(meta.title.contains("getting started"));
        assert_eq!(meta.site_name, "127.0.0.1");
        assert_eq!(meta.favicon, "http://127.0.0.1:9/favicon.ico");
    }
}
