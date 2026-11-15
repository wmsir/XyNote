use crate::models::{Block, BlockProps, DatabaseFull, MarkdownExport, Page, SaveBlockItem};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ParsedBlockDraft {
    pub block_type: String,
    pub content: String,
    pub plain_text: String,
    pub props: BlockProps,
}

pub fn is_raw_text_block(block_type: &str) -> bool {
    block_type == "code" || block_type == "math" || block_type == "mermaid"
}

pub fn is_mermaid_diagram_source(body: &str) -> bool {
    for raw_line in body.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if line.starts_with("flowchart ")
            || line.starts_with("flowchart\t")
            || line == "flowchart"
            || line.starts_with("graph ")
            || line.starts_with("graph\t")
        {
            return true;
        }
        for kw in [
            "sequenceDiagram",
            "classDiagram",
            "stateDiagram-v2",
            "stateDiagram",
            "erDiagram",
            "gantt",
            "pie",
            "mindmap",
            "timeline",
            "gitGraph",
            "journey",
            "quadrantChart",
            "C4Context",
            "C4Container",
            "C4Component",
            "C4Dynamic",
            "C4Deployment",
        ] {
            if let Some(rest) = line.strip_prefix(kw) {
                if rest.is_empty()
                    || rest.starts_with(|c: char| {
                        c.is_whitespace() || matches!(c, ':' | ';' | '{' | '[')
                    })
                {
                    return true;
                }
            }
        }
        return false;
    }
    false
}

pub fn escape_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn escape_html_attr(raw: &str) -> String {
    escape_html(raw).replace('"', "&quot;")
}

pub fn unescape_html_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

pub fn strip_html(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let chars: Vec<char> = html.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            let mut tag = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '>' {
                tag.push(chars[i]);
                i += 1;
            }
            if i < chars.len() && chars[i] == '>' {
                i += 1;
            }
            let tag_lower = tag.trim().to_ascii_lowercase();
            if tag_lower == "br" || tag_lower == "br/" || tag_lower.starts_with("br ") {
                text.push('\n');
            }
        } else {
            text.push(chars[i]);
            i += 1;
        }
    }

    unescape_html_entities(&text).trim().to_string()
}

fn extract_attr_value(open_tag: &str, attr_name: &str) -> Option<String> {
    let lower = open_tag.to_ascii_lowercase();
    for quote in ['"', '\''] {
        let needle = format!("{}={}", attr_name.to_ascii_lowercase(), quote);
        if let Some(pos) = lower.find(&needle) {
            let val_start = pos + needle.len();
            if let Some(end_rel) = open_tag[val_start..].find(quote) {
                return Some(unescape_html_entities(&open_tag[val_start..val_start + end_rel]));
            }
        }
    }
    None
}

/// 一级标题「# 图标 标题」；SVG 图标（lucide:…）无法写进 Markdown，只写标题
fn heading_with_icon(icon: &str, title: &str) -> String {
    let icon = icon.trim();
    if icon.is_empty() || icon.starts_with("lucide:") {
        format!("# {}", title)
    } else {
        format!("# {} {}", icon, title)
    }
}

fn strip_leading_icon_prefix(label: &str) -> &str {
    let trimmed = label.trim();
    if let Some((first_tok, rest)) = trimmed.split_once(' ') {
        let rest_trim = rest.trim();
        if !rest_trim.is_empty()
            && !first_tok
                .chars()
                .any(|c| c.is_ascii_alphanumeric() || ('\u{4E00}'..='\u{9FFF}').contains(&c))
        {
            return rest_trim;
        }
    }
    trimmed
}

/// Find case-insensitive closing HTML tag `</tag>` starting from byte index 0 of `haystack`,
/// supporting nested tags of the same name.
fn find_matching_close_tag(haystack: &str, tag_name: &str) -> Option<(usize, usize)> {
    let lower = haystack.to_ascii_lowercase();
    let open_prefix = format!("<{}", tag_name);
    let close_pat = format!("</{}", tag_name);
    let mut depth = 1usize;
    let mut cursor = 0usize;

    while cursor < lower.len() {
        let next_open = lower[cursor..].find(&open_prefix).map(|p| cursor + p);
        let next_close = lower[cursor..].find(&close_pat).map(|p| cursor + p)?;

        if let Some(op) = next_open {
            if op < next_close {
                let after_name = op + open_prefix.len();
                let valid_boundary = lower
                    .as_bytes()
                    .get(after_name)
                    .map(|&b| matches!(b, b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/'))
                    .unwrap_or(false);
                if valid_boundary {
                    if let Some(gt_rel) = lower[after_name..].find('>') {
                        let tag_end = after_name + gt_rel;
                        if !lower[op..=tag_end].ends_with("/>") {
                            depth += 1;
                        }
                        cursor = tag_end + 1;
                        continue;
                    }
                }
                cursor = after_name;
                continue;
            }
        }

        let after_close_name = next_close + close_pat.len();
        if let Some(gt_rel) = lower[after_close_name..].find('>') {
            let close_end = after_close_name + gt_rel + 1;
            let between = lower[after_close_name..after_close_name + gt_rel].trim();
            if between.is_empty() {
                depth -= 1;
                if depth == 0 {
                    return Some((next_close, close_end));
                }
            }
            cursor = close_end;
        } else {
            break;
        }
    }

    None
}

/// Convert rich inline HTML back into clean Typora/CommonMark inline Markdown:
/// - `<b>`/`<strong>` -> `**...**`
/// - `<i>`/`<em>` -> `*...*`
/// - `<s>`/`<del>`/`<strike>` -> `~~...~~`
/// - `<mark>` -> `==...==`
/// - `<code>` -> `` `...` ``
/// - `<a data-page-id="..." class="nb-wiki-link">Title</a>` -> `[[Title]]`
/// - `<a href="url">label</a>` -> `[label](url)`
pub fn html_to_inline_markdown(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    if !html.contains('<') && !html.contains('&') {
        return html.to_string();
    }

    let mut out = String::with_capacity(html.len() + 16);
    let mut i = 0usize;

    while i < html.len() {
        let rest = &html[i..];
        if rest.starts_with('<') {
            if let Some(gt_idx) = rest.find('>') {
                let full_open_tag = &rest[..=gt_idx];
                let inner_tag = rest[1..gt_idx].trim();
                let lower_inner = inner_tag.to_ascii_lowercase();

                if lower_inner == "br" || lower_inner == "br/" || lower_inner.starts_with("br ") {
                    out.push_str("<br/>");
                    i += gt_idx + 1;
                    continue;
                }

                // Ignore stray closing tags or self-closing unknown tags
                if lower_inner.starts_with('/') || lower_inner.ends_with('/') {
                    i += gt_idx + 1;
                    continue;
                }

                let tag_name: String = lower_inner
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();

                if !tag_name.is_empty() {
                    let after_open = &rest[gt_idx + 1..];
                    if let Some((close_start, close_end)) =
                        find_matching_close_tag(after_open, &tag_name)
                    {
                        let inner_html = &after_open[..close_start];
                        match tag_name.as_str() {
                            "b" | "strong" => {
                                let inner_md = html_to_inline_markdown(inner_html);
                                if !inner_md.is_empty() {
                                    out.push_str("**");
                                    out.push_str(&inner_md);
                                    out.push_str("**");
                                }
                            }
                            "i" | "em" => {
                                let inner_md = html_to_inline_markdown(inner_html);
                                if !inner_md.is_empty() {
                                    out.push('*');
                                    out.push_str(&inner_md);
                                    out.push('*');
                                }
                            }
                            "s" | "del" | "strike" => {
                                let inner_md = html_to_inline_markdown(inner_html);
                                if !inner_md.is_empty() {
                                    out.push_str("~~");
                                    out.push_str(&inner_md);
                                    out.push_str("~~");
                                }
                            }
                            "u" => {
                                let inner_md = html_to_inline_markdown(inner_html);
                                if !inner_md.is_empty() {
                                    out.push_str("<u>");
                                    out.push_str(&inner_md);
                                    out.push_str("</u>");
                                }
                            }
                            "mark" => {
                                let inner_md = html_to_inline_markdown(inner_html);
                                if !inner_md.is_empty() {
                                    out.push_str("==");
                                    out.push_str(&inner_md);
                                    out.push_str("==");
                                }
                            }
                            "code" => {
                                let raw_code = unescape_html_entities(&strip_html(inner_html));
                                if !raw_code.is_empty() {
                                    out.push('`');
                                    out.push_str(&raw_code);
                                    out.push('`');
                                }
                            }
                            "span" => {
                                if let Some(latex) = extract_attr_value(full_open_tag, "data-latex")
                                {
                                    if !latex.is_empty() {
                                        out.push('$');
                                        out.push_str(&latex);
                                        out.push('$');
                                    }
                                } else {
                                    out.push_str(&html_to_inline_markdown(inner_html));
                                }
                            }
                            "a" => {
                                let lower_open = full_open_tag.to_ascii_lowercase();
                                let is_wiki = lower_open.contains("nb-wiki-link")
                                    || lower_open.contains("data-page-id=");
                                if is_wiki {
                                    let plain_label = strip_html(inner_html);
                                    let clean_title = strip_leading_icon_prefix(&plain_label);
                                    if !clean_title.is_empty() {
                                        out.push_str("[[");
                                        out.push_str(clean_title);
                                        out.push_str("]]");
                                    }
                                } else if let Some(href) = extract_attr_value(full_open_tag, "href")
                                {
                                    let label_md = html_to_inline_markdown(inner_html);
                                    let final_label = if label_md.trim().is_empty() {
                                        href.clone()
                                    } else {
                                        label_md
                                    };
                                    out.push('[');
                                    out.push_str(&final_label);
                                    out.push_str("](");
                                    out.push_str(&href);
                                    out.push(')');
                                } else {
                                    out.push_str(&html_to_inline_markdown(inner_html));
                                }
                            }
                            _ => {
                                out.push_str(&html_to_inline_markdown(inner_html));
                            }
                        }
                        i += gt_idx + 1 + close_end;
                        continue;
                    }
                }

                // Unmatched `<tag>` -> skip tag markup
                i += gt_idx + 1;
                continue;
            }
        }

        // Decode HTML entities on text run up to next `<`
        let next_lt = rest.find('<').unwrap_or(rest.len());
        out.push_str(&unescape_html_entities(&rest[..next_lt]));
        i += next_lt;
    }

    out
}

/// Find closing parenthesis matching the `(` at `open_paren_idx`, supporting balanced nested parens.
fn find_balanced_paren(s: &str, open_paren_idx: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if open_paren_idx >= bytes.len() || bytes[open_paren_idx] != b'(' {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open_paren_idx;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'\n' | b'\r' => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

fn parse_html_br_at(s: &str) -> Option<usize> {
    if s.len() < 4 || !s.as_bytes()[..3].eq_ignore_ascii_case(b"<br") {
        return None;
    }
    let gt_rel = s[3..].find('>')?;
    let between = s[3..3 + gt_rel].trim();
    if between.is_empty() || between == "/" {
        Some(3 + gt_rel + 1)
    } else {
        None
    }
}

/// Single-pass inline Markdown converter:
/// - `**bold**` -> `<b>bold</b>`
/// - `*italic*` -> `<i>italic</i>`
/// - `~~strike~~` -> `<s>strike</s>`
/// - `==highlight==` / `<mark>highlight</mark>` -> `<mark>highlight</mark>`
/// - `<br>` / `<br/>` -> `<br>`
/// - `` `code` `` -> `<code>code</code>` (protected from inner formatting)
/// - `[text](https://... | file:///... | vscode://... | #... | relative.md)` -> `<a ...>`
/// - `[[WikiLink]]` -> preserved untouched
pub fn inline_markdown_to_html(text: &str) -> String {
    inline_markdown_inner(text, true)
}

fn inline_markdown_inner(text: &str, allow_links: bool) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;

    while i < text.len() {
        let rest = &text[i..];

        // 0. Newline or `<br>` / `<br/>` / `<br />`
        if rest.starts_with('\n') {
            out.push_str("<br>");
            i += 1;
            continue;
        }
        if let Some(br_len) = parse_html_br_at(rest) {
            out.push_str("<br>");
            i += br_len;
            continue;
        }

        // 1. Preserve [[WikiLink]] untouched
        if rest.starts_with("[[") {
            if let Some(close_rel) = rest[2..].find("]]") {
                let inner = &rest[2..2 + close_rel];
                if !inner.is_empty() && !inner.contains('\n') {
                    out.push_str("[[");
                    out.push_str(&escape_html(inner));
                    out.push_str("]]");
                    i += 2 + close_rel + 2;
                    continue;
                }
            }
        }

        // 2. Inline code `...` (contents are escaped verbatim and never formatted)
        if rest.starts_with('`') {
            if let Some(close_tick) = rest[1..].find('`') {
                let code_inner = &rest[1..1 + close_tick];
                if !code_inner.is_empty() && !code_inner.contains('\n') {
                    out.push_str("<code>");
                    out.push_str(&escape_html(code_inner));
                    out.push_str("</code>");
                    i += 1 + close_tick + 1;
                    continue;
                }
            }
        }

        // 3. Raw `<mark>...</mark>` & `<u>...</u>` HTML tag passthrough
        if rest.len() >= 13 && rest.as_bytes()[..6].eq_ignore_ascii_case(b"<mark>") {
            if let Some((close_start, close_end)) = find_matching_close_tag(&rest[6..], "mark") {
                let inner = &rest[6..6 + close_start];
                if !inner.contains('\n') {
                    out.push_str("<mark>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</mark>");
                    i += 6 + close_end;
                    continue;
                }
            }
        }
        if rest.len() >= 7 && rest.as_bytes()[..3].eq_ignore_ascii_case(b"<u>") {
            if let Some((close_start, close_end)) = find_matching_close_tag(&rest[3..], "u") {
                let inner = &rest[3..3 + close_start];
                if !inner.contains('\n') {
                    out.push_str("<u>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</u>");
                    i += 3 + close_end;
                    continue;
                }
            }
        }

        // 4. Inline Markdown link `[label](url)` (excluding `![` images and `[[` wikilinks)
        if allow_links && rest.starts_with('[') && !rest.starts_with("[[") {
            if let Some((label_raw, href_raw, consumed)) = parse_inline_link_at(rest) {
                let formatted_label = inline_markdown_inner(label_raw, false);
                let mut clean_href = href_raw.trim();
                if let Some(stripped) =
                    clean_href.strip_prefix('<').and_then(|u| u.strip_suffix('>'))
                {
                    clean_href = stripped.trim();
                }
                let encoded_href = clean_href.replace(' ', "%20");
                let lower_href = encoded_href.to_ascii_lowercase();
                let is_dangerous = lower_href.starts_with("javascript:")
                    || lower_href.starts_with("vbscript:")
                    || lower_href.starts_with("data:text/html");
                if !encoded_href.is_empty() && !encoded_href.contains('"') && !is_dangerous {
                    let attr_href = escape_html_attr(&encoded_href);
                    if lower_href.starts_with("http://")
                        || lower_href.starts_with("https://")
                        || lower_href.starts_with("mailto:")
                    {
                        out.push_str(&format!(
                            "<a href=\"{}\" class=\"nb-inline-link\" target=\"_blank\" rel=\"noopener noreferrer\">{}</a>",
                            attr_href, formatted_label
                        ));
                    } else if lower_href.starts_with("file://")
                        || lower_href.starts_with("vscode://")
                        || lower_href.starts_with('#')
                    {
                        out.push_str(&format!(
                            "<a href=\"{}\" class=\"nb-inline-link\">{}</a>",
                            attr_href, formatted_label
                        ));
                    } else {
                        out.push_str(&format!(
                            "<a href=\"{}\" class=\"nb-inline-link\" data-md-rel-href=\"{}\">{}</a>",
                            attr_href, attr_href, formatted_label
                        ));
                    }
                    i += consumed;
                    continue;
                }
            }
        }

        // 5. Highlight `==...==`
        if rest.starts_with("==") && !rest.starts_with("===") {
            if let Some(close_mark) = rest[2..].find("==") {
                let inner = &rest[2..2 + close_mark];
                if !inner.is_empty() && !inner.contains('\n') {
                    out.push_str("<mark>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</mark>");
                    i += 2 + close_mark + 2;
                    continue;
                }
            }
        }

        // 6. Bold `**...**`
        if rest.starts_with("**") {
            if let Some(close_bold) = rest[2..].find("**") {
                let inner = &rest[2..2 + close_bold];
                if !inner.is_empty() && !inner.contains('\n') {
                    out.push_str("<b>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</b>");
                    i += 2 + close_bold + 2;
                    continue;
                }
            }
        }

        // 7. Strikethrough `~~...~~`
        if rest.starts_with("~~") {
            if let Some(close_strike) = rest[2..].find("~~") {
                let inner = &rest[2..2 + close_strike];
                if !inner.is_empty() && !inner.contains('\n') {
                    out.push_str("<s>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</s>");
                    i += 2 + close_strike + 2;
                    continue;
                }
            }
        }

        // 8. Single-asterisk italic `*...*` (not `**`)
        if rest.starts_with('*') && !rest.starts_with("**") {
            if let Some(close_star) = find_single_star_close(&rest[1..]) {
                let inner = &rest[1..1 + close_star];
                if !inner.is_empty() && !inner.contains('\n') {
                    out.push_str("<i>");
                    out.push_str(&inline_markdown_inner(inner, allow_links));
                    out.push_str("</i>");
                    i += 1 + close_star + 1;
                    continue;
                }
            }
        }

        let ch = rest.chars().next().unwrap();
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
        i += ch.len_utf8();
    }

    out
}

fn find_single_star_close(after_open: &str) -> Option<usize> {
    let bytes = after_open.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'*' {
            if idx + 1 < bytes.len() && bytes[idx + 1] == b'*' {
                idx += 2;
                continue;
            }
            return Some(idx);
        }
        if bytes[idx] == b'\n' {
            return None;
        }
        idx += 1;
    }
    None
}

fn parse_inline_link_at(s: &str) -> Option<(&str, &str, usize)> {
    if !s.starts_with('[') || s.starts_with("[[") {
        return None;
    }
    let bytes = s.as_bytes();
    let mut depth = 0usize;
    let mut close_bracket = None;
    for (idx, &b) in bytes.iter().enumerate() {
        match b {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    close_bracket = Some(idx);
                    break;
                }
            }
            b'\n' | b'\r' => return None,
            _ => {}
        }
    }
    let cb = close_bracket?;
    if cb + 1 >= bytes.len() || bytes[cb + 1] != b'(' {
        return None;
    }
    let close_paren = find_balanced_paren(s, cb + 1)?;
    let label = &s[1..cb];
    let href = &s[cb + 2..close_paren];
    Some((label, href, close_paren + 1))
}

fn parse_standalone_image(trimmed: &str) -> Option<(String, String)> {
    if !trimmed.starts_with("![") {
        return None;
    }
    let rest_link = &trimmed[1..];
    let (alt, raw_target, consumed) = parse_inline_link_at(rest_link)?;
    if 1 + consumed != trimmed.len() {
        return None;
    }
    let mut url = raw_target.trim();
    if let Some(stripped) = url.strip_prefix('<').and_then(|u| u.strip_suffix('>')) {
        url = stripped.trim();
    } else if let Some(quote_start) = url.find(" \"") {
        if url.ends_with('"') && quote_start > 0 {
            url = url[..quote_start].trim();
        }
    }
    if url.is_empty() {
        return None;
    }
    Some((alt.trim().to_string(), url.to_string()))
}

pub fn detect_embed_provider(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.contains("youtube.com/") || lower.contains("youtu.be/") {
        "youtube".to_string()
    } else if lower.contains("bilibili.com/") || lower.contains("b23.tv/") {
        "bilibili".to_string()
    } else if lower.contains("vimeo.com/") {
        "vimeo".to_string()
    } else if lower.ends_with(".mp4") || lower.ends_with(".webm") || lower.ends_with(".ogg") {
        "video".to_string()
    } else {
        "iframe".to_string()
    }
}

fn is_embed_media_url(url: &str) -> bool {
    detect_embed_provider(url) != "iframe"
}

pub fn extract_url_host(url: &str) -> Option<String> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host_port = after_scheme.split(['/', '?', '#']).next()?;
    let host = host_port.split(':').next()?.trim();
    let clean = host.strip_prefix("www.").unwrap_or(host);
    if clean.is_empty() {
        None
    } else {
        Some(clean.to_string())
    }
}

fn parse_standalone_bookmark_or_embed(trimmed: &str) -> Option<ParsedBlockDraft> {
    // 1. `@[embed](https://... "Optional Caption")` or `@[embed](https://...)`
    if let Some(after_at) = trimmed.strip_prefix('@') {
        if let Some((label, raw_target, consumed)) = parse_inline_link_at(after_at) {
            if 1 + consumed == trimmed.len() && label.trim().eq_ignore_ascii_case("embed") {
                let mut url_part = raw_target.trim();
                let mut caption_opt: Option<String> = None;
                if let Some(q_start) = url_part.find(" \"") {
                    if url_part.ends_with('"') && q_start > 0 {
                        let cap = url_part[q_start + 2..url_part.len() - 1].trim();
                        if !cap.is_empty() && !cap.eq_ignore_ascii_case("embed") {
                            caption_opt = Some(cap.to_string());
                        }
                        url_part = url_part[..q_start].trim();
                    }
                }
                let lower_u = url_part.to_ascii_lowercase();
                if (lower_u.starts_with("http://") || lower_u.starts_with("https://"))
                    && !url_part.contains(' ')
                {
                    let provider = detect_embed_provider(url_part);
                    let plain_text = match &caption_opt {
                        Some(cap) => format!("{} {}", cap, url_part),
                        None => url_part.to_string(),
                    };
                    return Some(ParsedBlockDraft {
                        block_type: "embed".to_string(),
                        content: String::new(),
                        plain_text,
                        props: BlockProps {
                            url: Some(url_part.to_string()),
                            caption: caption_opt,
                            embed_provider: Some(provider),
                            ..Default::default()
                        },
                    });
                }
            }
        }
    }

    // 2. `<iframe ... src="https://...">` on a single line
    let lower_trim = trimmed.to_ascii_lowercase();
    if lower_trim.starts_with("<iframe") && lower_trim.contains("src=") {
        for quote in ['"', '\''] {
            let pat = format!("src={}", quote);
            if let Some(pos) = lower_trim.find(&pat) {
                let after = &trimmed[pos + pat.len()..];
                if let Some(end) = after.find(quote) {
                    let src_url = after[..end].trim();
                    if src_url.starts_with("http://") || src_url.starts_with("https://") {
                        let provider = detect_embed_provider(src_url);
                        return Some(ParsedBlockDraft {
                            block_type: "embed".to_string(),
                            content: String::new(),
                            plain_text: src_url.to_string(),
                            props: BlockProps {
                                url: Some(src_url.to_string()),
                                embed_provider: Some(provider),
                                ..Default::default()
                            },
                        });
                    }
                }
            }
        }
    }

    if !trimmed.starts_with('[') || trimmed.starts_with("[[") {
        return None;
    }
    let (raw_label, raw_href, consumed) = parse_inline_link_at(trimmed)?;
    if consumed != trimmed.len() {
        return None;
    }
    let url = raw_href.trim();
    let lower_url = url.to_ascii_lowercase();
    if !(lower_url.starts_with("http://") || lower_url.starts_with("https://")) || url.contains(' ')
    {
        return None;
    }

    let label = raw_label.trim();
    let lower_label = label.to_ascii_lowercase();

    // 3. Standalone embed link `[embed: Caption](url)` / `[🎬 Caption](url)` / `[Embed](url)`
    let explicit_embed_caption = if lower_label == "embed" || label == "🎬" {
        Some(String::new())
    } else if let Some(rest) = label
        .strip_prefix("embed:")
        .or_else(|| label.strip_prefix("Embed:"))
        .or_else(|| label.strip_prefix("EMBED:"))
        .or_else(|| label.strip_prefix("embed："))
        .or_else(|| label.strip_prefix("Embed："))
        .or_else(|| label.strip_prefix("🎬 "))
        .or_else(|| label.strip_prefix("🎬"))
    {
        let cap = rest.trim();
        if cap.eq_ignore_ascii_case("embed") {
            Some(String::new())
        } else {
            Some(cap.to_string())
        }
    } else if (label == url || lower_label == "video") && is_embed_media_url(url) {
        Some(String::new())
    } else {
        None
    };

    if let Some(cap) = explicit_embed_caption {
        let provider = detect_embed_provider(url);
        let plain_text = if cap.is_empty() {
            url.to_string()
        } else {
            format!("{} {}", cap, url)
        };
        return Some(ParsedBlockDraft {
            block_type: "embed".to_string(),
            content: String::new(),
            plain_text,
            props: BlockProps {
                url: Some(url.to_string()),
                caption: if cap.is_empty() { None } else { Some(cap) },
                embed_provider: Some(provider),
                ..Default::default()
            },
        });
    }

    // 4. Standalone `[🔖 Title](https://...)` or `[Title](https://...)` -> Bookmark block
    let stripped_bm_label = label
        .strip_prefix("🔖 ")
        .or_else(|| label.strip_prefix("🔖"))
        .map(str::trim)
        .unwrap_or(label);

    let bm_title = if stripped_bm_label.is_empty() {
        extract_url_host(url).unwrap_or_else(|| url.to_string())
    } else {
        stripped_bm_label.to_string()
    };
    let site = extract_url_host(url);
    let plain_text = if bm_title == url {
        url.to_string()
    } else {
        format!("{} {}", bm_title, url)
    };

    Some(ParsedBlockDraft {
        block_type: "bookmark".to_string(),
        content: String::new(),
        plain_text,
        props: BlockProps {
            url: Some(url.to_string()),
            bookmark_title: Some(bm_title),
            bookmark_site: site,
            ..Default::default()
        },
    })
}

fn is_divider_line(trimmed: &str) -> bool {
    if trimmed.len() < 3 {
        return false;
    }
    trimmed.chars().all(|c| c == '-')
        || trimmed.chars().all(|c| c == '*')
        || trimmed.chars().all(|c| c == '_')
}

fn parse_checklist_item(trimmed: &str) -> Option<(bool, &str)> {
    for prefix in ["- [ ] ", "* [ ] ", "+ [ ] "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some((false, rest));
        }
    }
    for prefix in ["- [x] ", "- [X] ", "* [x] ", "* [X] ", "+ [x] ", "+ [X] "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some((true, rest));
        }
    }
    None
}

fn parse_bullet_item(trimmed: &str) -> Option<&str> {
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn parse_numbered_item(trimmed: &str) -> Option<&str> {
    let dot_idx = trimmed.find(". ")?;
    if dot_idx == 0 {
        return None;
    }
    if trimmed[..dot_idx].chars().all(|c| c.is_ascii_digit()) {
        Some(&trimmed[dot_idx + 2..])
    } else {
        None
    }
}

/// Parse GFM pipe-table row cells, splitting ONLY on unescaped `|` characters
/// (respecting `\|` escapes and `` `...` `` inline code spans).
pub fn parse_table_cells(row_line: &str) -> Vec<String> {
    let trimmed = row_line.trim();
    let after_open = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let inner = if after_open.ends_with('|') && !after_open.ends_with("\\|") {
        &after_open[..after_open.len() - 1]
    } else {
        after_open
    };

    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = inner.chars().peekable();
    let mut in_code = false;

    while let Some(ch) = chars.next() {
        if ch == '`' {
            in_code = !in_code;
            cur.push(ch);
        } else if ch == '\\' {
            if let Some(&next_ch) = chars.peek() {
                if next_ch == '|' || (!in_code && next_ch == '\\') {
                    cur.push(chars.next().unwrap());
                    continue;
                }
            }
            cur.push(ch);
        } else if ch == '|' && !in_code {
            cells.push(decode_table_cell(&cur));
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    cells.push(decode_table_cell(&cur));
    cells
}

fn decode_table_cell(raw: &str) -> String {
    raw.trim().to_string()
}

fn encode_table_cell(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "<br/>").replace('\n', "<br/>");
    let mut out = String::with_capacity(normalized.len() + 4);
    let mut in_code = false;
    for ch in normalized.chars() {
        match ch {
            '`' => {
                in_code = !in_code;
                out.push('`');
            }
            '\\' if !in_code => out.push_str("\\\\"),
            '|' => out.push_str("\\|"),
            c => out.push(c),
        }
    }
    out
}

fn parse_table_alignments(sep_line: &str, col_count: usize) -> Option<Vec<String>> {
    let cells = parse_table_cells(sep_line);
    let has_explicit = cells.iter().any(|c| {
        let t = c.trim();
        t.starts_with(':') || t.ends_with(':')
    });
    if !has_explicit {
        return None;
    }
    let mut aligns = Vec::with_capacity(col_count);
    for idx in 0..col_count {
        let t = cells.get(idx).map(|s| s.trim()).unwrap_or("---");
        let align = if t.starts_with(':') && t.ends_with(':') {
            "center"
        } else if t.ends_with(':') {
            "right"
        } else {
            "left"
        };
        aligns.push(align.to_string());
    }
    Some(aligns)
}

pub fn is_table_separator(row_line: &str) -> bool {
    let trimmed = row_line.trim();
    if !trimmed.contains('-') || !trimmed.contains('|') {
        return false;
    }
    let cells = parse_table_cells(trimmed);
    if cells.is_empty() {
        return false;
    }
    cells.iter().all(|c| {
        let t = c.trim();
        let core = t.strip_prefix(':').unwrap_or(t);
        let core = core.strip_suffix(':').unwrap_or(core);
        !core.is_empty() && core.chars().all(|ch| ch == '-')
    })
}

fn is_pipe_table_start(raw_lines: &[&str], idx: usize) -> bool {
    let trimmed = raw_lines[idx].trim();
    if trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() >= 2 {
        return true;
    }
    // Also accept outer-pipeless GFM tables (`Col A | Col B` followed by `--- | ---`)
    if trimmed.contains('|') && idx + 1 < raw_lines.len() && is_table_separator(raw_lines[idx + 1])
    {
        return true;
    }
    false
}

fn parse_callout_admonition(quote_body: &str) -> Option<(String, &str)> {
    if !quote_body.starts_with("[!") {
        return None;
    }
    let close_idx = quote_body.find(']')?;
    let kind = quote_body[2..close_idx].trim().to_ascii_uppercase();
    let default_icon = match kind.as_str() {
        "NOTE" | "INFO" => "💡",
        "TIP" => "✨",
        "IMPORTANT" => "📌",
        "WARNING" | "CAUTION" => "⚠️",
        _ => return None,
    };
    let rest = quote_body[close_idx + 1..].trim();
    if let Some((first_tok, after_icon)) = rest.split_once(' ') {
        if !first_tok
            .chars()
            .any(|c| c.is_ascii_alphanumeric() || ('\u{4E00}'..='\u{9FFF}').contains(&c))
        {
            return Some((first_tok.to_string(), after_icon.trim()));
        }
    }
    Some((default_icon.to_string(), rest))
}

pub fn derive_markdown_title(explicit_title: &str, markdown: &str) -> String {
    let trimmed = explicit_title.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    let clean_md = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    for line in clean_md.lines() {
        let t = line.trim();
        if let Some(h1) = t.strip_prefix("# ") {
            let clean = strip_html(&inline_markdown_to_html(h1.trim()));
            if !clean.is_empty() {
                return clean;
            }
        }
    }
    "导入的 Markdown 页面".to_string()
}

pub fn parse_markdown_to_blocks(markdown: &str) -> Vec<ParsedBlockDraft> {
    let without_bom = markdown.strip_prefix('\u{feff}').unwrap_or(markdown);
    let normalized = without_bom.replace("\r\n", "\n");
    let raw_lines: Vec<&str> = normalized.split('\n').collect();
    let mut blocks = Vec::new();
    let mut i = 0;

    while i < raw_lines.len() {
        let line = raw_lines[i];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Fenced code or Mermaid block (raw unescaped text)
        if let Some(after_fence) = trimmed.strip_prefix("```") {
            let raw_lang = after_fence.trim();
            i += 1;
            let mut code_lines = Vec::new();
            while i < raw_lines.len() && !raw_lines[i].trim().starts_with("```") {
                code_lines.push(raw_lines[i]);
                i += 1;
            }
            if i < raw_lines.len() {
                i += 1;
            }
            let code_raw = code_lines.join("\n");
            if raw_lang.eq_ignore_ascii_case("mermaid")
                || (raw_lang.is_empty() && is_mermaid_diagram_source(&code_raw))
            {
                blocks.push(ParsedBlockDraft {
                    block_type: "mermaid".to_string(),
                    content: code_raw.clone(),
                    plain_text: code_raw,
                    props: BlockProps::default(),
                });
            } else {
                let lang = if raw_lang.is_empty() {
                    "plaintext".to_string()
                } else {
                    raw_lang.to_string()
                };
                blocks.push(ParsedBlockDraft {
                    block_type: "code".to_string(),
                    content: code_raw.clone(),
                    plain_text: code_raw,
                    props: BlockProps {
                        language: Some(lang),
                        ..Default::default()
                    },
                });
            }
            continue;
        }

        // Display math block `$$ ... $$` (single-line or multi-line; RAW unescaped LaTeX!)
        if let Some(after_open) = trimmed.strip_prefix("$$") {
            if trimmed.len() >= 4 && after_open.ends_with("$$") {
                let latex_raw = after_open[..after_open.len() - 2].trim().to_string();
                blocks.push(ParsedBlockDraft {
                    block_type: "math".to_string(),
                    content: latex_raw.clone(),
                    plain_text: latex_raw,
                    props: BlockProps::default(),
                });
                i += 1;
                continue;
            }

            let mut math_lines: Vec<String> = Vec::new();
            let first_rest = after_open.trim();
            if !first_rest.is_empty() {
                math_lines.push(first_rest.to_string());
            }
            i += 1;
            while i < raw_lines.len() {
                let cur = raw_lines[i];
                let cur_trim = cur.trim();
                if let Some(before_close) = cur_trim.strip_suffix("$$") {
                    let b = before_close.trim();
                    if !b.is_empty() {
                        math_lines.push(b.to_string());
                    }
                    i += 1;
                    break;
                }
                math_lines.push(cur.to_string());
                i += 1;
            }
            let latex_raw = math_lines.join("\n").trim().to_string();
            blocks.push(ParsedBlockDraft {
                block_type: "math".to_string(),
                content: latex_raw.clone(),
                plain_text: latex_raw,
                props: BlockProps::default(),
            });
            continue;
        }

        // HTML `<details><summary>...</summary>...</details>` -> Toggle block
        if trimmed.to_ascii_lowercase().starts_with("<details") {
            let mut detail_lines = vec![raw_lines[i]];
            if !trimmed.to_ascii_lowercase().contains("</details>") {
                i += 1;
                while i < raw_lines.len() {
                    detail_lines.push(raw_lines[i]);
                    if raw_lines[i].to_ascii_lowercase().contains("</details>") {
                        break;
                    }
                    i += 1;
                }
            }
            i += 1;
            let joined = detail_lines.join("\n");
            let lower_joined = joined.to_ascii_lowercase();
            let first_gt = lower_joined.find('>').unwrap_or(0);
            let is_open = lower_joined[..first_gt].contains("open");
            let (summary_md, body_text) = if let (Some(s_open), Some(s_close)) = (
                lower_joined.find("<summary>"),
                lower_joined.find("</summary>"),
            ) {
                let sum_inner = joined[s_open + 9..s_close].trim();
                let after_sum = &joined[s_close + 10..];
                let close_det = after_sum
                    .to_ascii_lowercase()
                    .rfind("</details>")
                    .unwrap_or(after_sum.len());
                (sum_inner.to_string(), after_sum[..close_det].trim().to_string())
            } else {
                ("折叠列表".to_string(), String::new())
            };
            let content = inline_markdown_to_html(&summary_md);
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "toggle".to_string(),
                content,
                plain_text,
                props: BlockProps {
                    collapsed: Some(!is_open),
                    children_text: if body_text.is_empty() {
                        None
                    } else {
                        Some(body_text)
                    },
                    ..Default::default()
                },
            });
            continue;
        }

        // Standalone image `![caption](url)`
        if let Some((caption, url)) = parse_standalone_image(trimmed) {
            let plain_text = if !caption.is_empty() {
                caption.clone()
            } else if !url.starts_with("data:") {
                url.clone()
            } else {
                String::new()
            };
            blocks.push(ParsedBlockDraft {
                block_type: "image".to_string(),
                content: caption.clone(),
                plain_text,
                props: BlockProps {
                    url: Some(url),
                    caption: if caption.is_empty() {
                        None
                    } else {
                        Some(caption)
                    },
                    image_width: Some("full".to_string()),
                    ..Default::default()
                },
            });
            i += 1;
            continue;
        }

        // Standalone bookmark `[Title](https://...)` or embed
        if let Some(rich_draft) = parse_standalone_bookmark_or_embed(trimmed) {
            blocks.push(rich_draft);
            i += 1;
            continue;
        }

        // Horizontal divider
        if is_divider_line(trimmed) {
            blocks.push(ParsedBlockDraft {
                block_type: "divider".to_string(),
                content: String::new(),
                plain_text: String::new(),
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }

        // Headings
        if let Some(h3) = trimmed
            .strip_prefix("#### ")
            .or_else(|| trimmed.strip_prefix("### "))
        {
            let content = inline_markdown_to_html(h3.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "heading3".to_string(),
                content,
                plain_text,
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }
        if let Some(h2) = trimmed.strip_prefix("## ") {
            let content = inline_markdown_to_html(h2.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "heading2".to_string(),
                content,
                plain_text,
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }
        if let Some(h1) = trimmed.strip_prefix("# ") {
            let content = inline_markdown_to_html(h1.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "heading1".to_string(),
                content,
                plain_text,
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }

        // Todo checklist
        if let Some((checked, item_text)) = parse_checklist_item(trimmed) {
            let content = inline_markdown_to_html(item_text.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "todo".to_string(),
                content,
                plain_text,
                props: BlockProps {
                    checked: Some(checked),
                    ..Default::default()
                },
            });
            i += 1;
            continue;
        }

        // Bullet list
        if let Some(item_text) = parse_bullet_item(trimmed) {
            let content = inline_markdown_to_html(item_text.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "bullet".to_string(),
                content,
                plain_text,
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }

        // Numbered list
        if let Some(item_text) = parse_numbered_item(trimmed) {
            let content = inline_markdown_to_html(item_text.trim());
            let plain_text = strip_html(&content);
            blocks.push(ParsedBlockDraft {
                block_type: "numbered".to_string(),
                content,
                plain_text,
                props: BlockProps::default(),
            });
            i += 1;
            continue;
        }

        // Callout (`> [!NOTE] 💡 ...`) or Quote (`> ...`)
        if let Some(after_gt) = trimmed.strip_prefix('>') {
            let quote_body = after_gt.strip_prefix(' ').unwrap_or(after_gt).trim();
            if let Some((icon, callout_body)) = parse_callout_admonition(quote_body) {
                let content = inline_markdown_to_html(callout_body);
                let plain_text = strip_html(&content);
                blocks.push(ParsedBlockDraft {
                    block_type: "callout".to_string(),
                    content,
                    plain_text,
                    props: BlockProps {
                        callout_icon: Some(icon),
                        ..Default::default()
                    },
                });
            } else {
                let content = inline_markdown_to_html(quote_body);
                let plain_text = strip_html(&content);
                blocks.push(ParsedBlockDraft {
                    block_type: "quote".to_string(),
                    content,
                    plain_text,
                    props: BlockProps::default(),
                });
            }
            i += 1;
            continue;
        }

        // GFM pipe table
        if is_pipe_table_start(&raw_lines, i) {
            let mut table_lines = Vec::new();
            while i < raw_lines.len() {
                let tl = raw_lines[i].trim();
                if !tl.is_empty() && tl.contains('|') {
                    table_lines.push(tl);
                    i += 1;
                } else {
                    break;
                }
            }
            if !table_lines.is_empty() {
                let raw_headers = parse_table_cells(table_lines[0]);
                let headers: Vec<String> = raw_headers
                    .iter()
                    .map(|h| inline_markdown_to_html(h))
                    .collect();
                let col_count = headers.len().max(1);
                let (data_start, col_alignments) =
                    if table_lines.len() >= 2 && is_table_separator(table_lines[1]) {
                        (2, parse_table_alignments(table_lines[1], col_count))
                    } else {
                        (1, None)
                    };
                let rows: Vec<Vec<String>> = table_lines[data_start..]
                    .iter()
                    .map(|r| {
                        let mut cells: Vec<String> = parse_table_cells(r)
                            .into_iter()
                            .map(|c| inline_markdown_to_html(&c))
                            .collect();
                        if cells.len() < col_count {
                            cells.resize(col_count, String::new());
                        }
                        cells
                    })
                    .collect();
                let mut plain_parts: Vec<String> = headers
                    .iter()
                    .map(|h| strip_html(h))
                    .filter(|s| !s.is_empty())
                    .collect();
                for r in &rows {
                    plain_parts.extend(r.iter().map(|c| strip_html(c)).filter(|s| !s.is_empty()));
                }
                blocks.push(ParsedBlockDraft {
                    block_type: "table".to_string(),
                    content: String::new(),
                    plain_text: plain_parts.join(" "),
                    props: BlockProps {
                        headers: Some(headers),
                        rows: Some(rows),
                        col_alignments,
                        ..Default::default()
                    },
                });
                continue;
            }
        }

        // Paragraph
        let content = inline_markdown_to_html(trimmed);
        let plain_text = strip_html(&content);
        blocks.push(ParsedBlockDraft {
            block_type: "paragraph".to_string(),
            content,
            plain_text,
            props: BlockProps::default(),
        });
        i += 1;
    }

    if blocks.is_empty() {
        blocks.push(ParsedBlockDraft {
            block_type: "paragraph".to_string(),
            content: String::new(),
            plain_text: String::new(),
            props: BlockProps::default(),
        });
    }

    blocks
}

pub fn sanitize_windows_segment(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "Untitled".to_string();
    }
    let upper = trimmed.to_ascii_uppercase();
    let is_reserved = matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if is_reserved {
        format!("_{}", trimmed)
    } else {
        trimmed.to_string()
    }
}

pub fn sanitize_markdown_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "Untitled.md".to_string()
    } else {
        format!("{}.md", trimmed)
    }
}

fn format_single_block_lines(
    block_type: &str,
    content: &str,
    plain_text: &str,
    props: &BlockProps,
    num_counter: &mut usize,
    lines: &mut Vec<String>,
) {
    if block_type != "numbered" {
        *num_counter = 0;
    }

    let text = if is_raw_text_block(block_type) {
        if !content.is_empty() {
            content.to_string()
        } else {
            plain_text.to_string()
        }
    } else if !content.is_empty() {
        let md_inline = html_to_inline_markdown(content);
        if !md_inline.is_empty() {
            md_inline
        } else if !plain_text.is_empty() {
            plain_text.to_string()
        } else {
            strip_html(content)
        }
    } else {
        plain_text.to_string()
    };

    match block_type {
        "heading1" => {
            lines.push(format!("# {}", text));
            lines.push(String::new());
        }
        "heading2" => {
            lines.push(format!("## {}", text));
            lines.push(String::new());
        }
        "heading3" => {
            lines.push(format!("### {}", text));
            lines.push(String::new());
        }
        "todo" => {
            let mark = if props.checked.unwrap_or(false) {
                "x"
            } else {
                " "
            };
            lines.push(format!("- [{}] {}", mark, text));
        }
        "bullet" => {
            lines.push(format!("- {}", text));
        }
        "numbered" => {
            *num_counter += 1;
            lines.push(format!("{}. {}", *num_counter, text));
        }
        "quote" => {
            lines.push(format!("> {}", text));
            lines.push(String::new());
        }
        "callout" => {
            let icon = props.callout_icon.as_deref().unwrap_or("💡");
            lines.push(format!("> [!NOTE] {} {}", icon, text));
            lines.push(String::new());
        }
        "toggle" => {
            let open_attr = if props.collapsed.unwrap_or(false) {
                ""
            } else {
                " open"
            };
            lines.push(format!("<details{}><summary>{}</summary>", open_attr, text));
            if let Some(children) = props.children_text.as_deref().filter(|s| !s.is_empty()) {
                lines.push(children.to_string());
            }
            lines.push("</details>".to_string());
            lines.push(String::new());
        }
        "mermaid" => {
            lines.push("```mermaid".to_string());
            lines.push(text);
            lines.push("```".to_string());
            lines.push(String::new());
        }
        "code" => {
            let lang_raw = props.language.as_deref().unwrap_or("");
            let lang = if lang_raw.eq_ignore_ascii_case("mermaid") {
                "mermaid"
            } else {
                lang_raw
            };
            lines.push(format!("```{}", lang));
            lines.push(text);
            lines.push("```".to_string());
            lines.push(String::new());
        }
        "math" => {
            lines.push("$$".to_string());
            lines.push(text);
            lines.push("$$".to_string());
            lines.push(String::new());
        }
        "image" => {
            // 磁盘笔记的图片写回原来的相对路径，而不是用于显示的 data URL
            // 只有显示用的 url 仍是 data URL 时才用 local_src（用户改成网络图片后以 url 为准）
            let display = props.url.as_deref().filter(|s| !s.is_empty());
            let url = match (display, props.local_src.as_deref().filter(|s| !s.is_empty())) {
                (Some(d), Some(local)) if d.starts_with("data:") => local,
                (Some(d), _) => d,
                (None, Some(local)) => local,
                (None, None) => content.trim(),
            };
            let caption = props.caption.as_deref().unwrap_or("");
            lines.push(format!("![{}]({})", caption, url));
            lines.push(String::new());
        }
        "bookmark" => {
            let url = props
                .url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| content.trim());
            let title = props
                .bookmark_title
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if !plain_text.trim().is_empty() {
                        plain_text.trim()
                    } else {
                        url
                    }
                });
            lines.push(format!("[{}]({})", title, url));
            lines.push(String::new());
        }
        "embed" => {
            let url = props
                .url
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| content.trim());
            let label = match props.caption.as_deref().map(str::trim) {
                Some(cap) if !cap.is_empty() => format!("embed: {}", cap),
                _ => "Embed".to_string(),
            };
            lines.push(format!("[{}]({})", label, url));
            lines.push(String::new());
        }
        "divider" => {
            lines.push("---".to_string());
            lines.push(String::new());
        }
        "table" => {
            let headers = props
                .headers
                .clone()
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| vec!["列 1".to_string(), "列 2".to_string()]);
            let col_count = headers.len();
            let escaped_headers: Vec<String> = headers
                .iter()
                .map(|h| encode_table_cell(&html_to_inline_markdown(h)))
                .collect();
            lines.push(format!("| {} |", escaped_headers.join(" | ")));
            let sep: Vec<&str> = match &props.col_alignments {
                Some(aligns) if !aligns.is_empty() => (0..col_count)
                    .map(|idx| match aligns.get(idx).map(|s| s.as_str()) {
                        Some("center") => ":---:",
                        Some("right") => "---:",
                        _ => ":---",
                    })
                    .collect(),
                _ => (0..col_count).map(|_| "---").collect(),
            };
            lines.push(format!("| {} |", sep.join(" | ")));
            if let Some(rows) = &props.rows {
                for row in rows {
                    let mut padded: Vec<String> = row
                        .iter()
                        .map(|c| encode_table_cell(&html_to_inline_markdown(c)))
                        .collect();
                    if padded.len() < col_count {
                        padded.resize(col_count, String::new());
                    }
                    lines.push(format!("| {} |", padded.join(" | ")));
                }
            }
            lines.push(String::new());
        }
        _ => {
            lines.push(text);
            lines.push(String::new());
        }
    }
}

/// Losslessly serialize a slice of `Block`s to standalone Typora/GFM Markdown
/// (without prepending a synthetic `# Icon PageTitle` line).
pub fn serialize_blocks_to_markdown(blocks: &[Block]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut num_counter = 0usize;
    for b in blocks {
        format_single_block_lines(
            &b.block_type,
            &b.content,
            &b.plain_text,
            &b.props,
            &mut num_counter,
            &mut lines,
        );
    }
    let body = lines.join("\n").trim().to_string();
    if body.is_empty() {
        String::new()
    } else {
        format!("{}\n", body)
    }
}

/// Losslessly serialize a slice of `SaveBlockItem`s to standalone Typora/GFM Markdown.
pub fn serialize_save_blocks_to_markdown(items: &[SaveBlockItem]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut num_counter = 0usize;
    for item in items {
        format_single_block_lines(
            &item.block_type,
            &item.content,
            &item.plain_text,
            &item.props,
            &mut num_counter,
            &mut lines,
        );
    }
    let body = lines.join("\n").trim().to_string();
    if body.is_empty() {
        String::new()
    } else {
        format!("{}\n", body)
    }
}

pub fn export_doc_to_markdown(page: &Page, blocks: &[Block]) -> MarkdownExport {
    let mut lines: Vec<String> = vec![heading_with_icon(&page.icon, &page.title), String::new()];
    let mut num_counter = 0usize;

    for b in blocks {
        format_single_block_lines(
            &b.block_type,
            &b.content,
            &b.plain_text,
            &b.props,
            &mut num_counter,
            &mut lines,
        );
    }

    MarkdownExport {
        filename: sanitize_markdown_filename(&page.title),
        markdown: format!("{}\n", lines.join("\n").trim()),
    }
}

pub fn export_database_to_markdown(page: &Page, db: &DatabaseFull) -> MarkdownExport {
    let mut lines: Vec<String> = vec![heading_with_icon(&page.icon, &page.title), String::new()];

    if !db.columns.is_empty() {
        let col_names: Vec<String> = db
            .columns
            .iter()
            .map(|c| encode_table_cell(&c.name))
            .collect();
        lines.push(format!("| {} |", col_names.join(" | ")));
        let sep: Vec<&str> = db.columns.iter().map(|_| "---").collect();
        lines.push(format!("| {} |", sep.join(" | ")));

        for row in &db.rows {
            let vals: Vec<String> = db
                .columns
                .iter()
                .map(|col| {
                    let raw = row.cells.get(&col.id);
                    match raw {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => match col.col_type.as_str() {
                            "status" | "select" => {
                                let s = value_to_string(v);
                                let resolved = col
                                    .options
                                    .iter()
                                    .find(|o| o.id == s || o.label == s)
                                    .map(|o| o.label.clone())
                                    .unwrap_or(s);
                                encode_table_cell(&resolved)
                            }
                            "multi_select" => {
                                if let Some(arr) = v.as_array() {
                                    let joined = arr
                                        .iter()
                                        .map(|item| {
                                            let s = value_to_string(item);
                                            col.options
                                                .iter()
                                                .find(|o| o.id == s || o.label == s)
                                                .map(|o| o.label.clone())
                                                .unwrap_or(s)
                                        })
                                        .collect::<Vec<_>>()
                                        .join(", ");
                                    encode_table_cell(&joined)
                                } else {
                                    encode_table_cell(&value_to_string(v))
                                }
                            }
                            "checkbox" => {
                                if v.as_bool().unwrap_or(false) {
                                    "✅".to_string()
                                } else {
                                    "⬜".to_string()
                                }
                            }
                            _ => encode_table_cell(&value_to_string(v)),
                        },
                    }
                })
                .collect();
            lines.push(format!("| {} |", vals.join(" | ")));
        }
    }

    MarkdownExport {
        filename: sanitize_markdown_filename(&page.title),
        markdown: format!("{}\n", lines.join("\n").trim()),
    }
}

pub fn export_database_to_csv(db: &DatabaseFull) -> String {
    fn esc_csv(val: &str) -> String {
        if val.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", val.replace('"', "\"\""))
        } else {
            val.to_string()
        }
    }

    if db.columns.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::with_capacity(db.rows.len() + 1);
    lines.push(
        db.columns
            .iter()
            .map(|c| esc_csv(&c.name))
            .collect::<Vec<_>>()
            .join(","),
    );

    for row in &db.rows {
        let cells: Vec<String> = db
            .columns
            .iter()
            .map(|col| match row.cells.get(&col.id) {
                None | Some(Value::Null) => String::new(),
                Some(v) => match col.col_type.as_str() {
                    "status" | "select" => {
                        let s = value_to_string(v);
                        let lbl = col
                            .options
                            .iter()
                            .find(|o| o.id == s || o.label == s)
                            .map(|o| o.label.as_str())
                            .unwrap_or(&s);
                        esc_csv(lbl)
                    }
                    "multi_select" => {
                        if let Some(arr) = v.as_array() {
                            let joined = arr
                                .iter()
                                .map(|item| {
                                    let s = value_to_string(item);
                                    col.options
                                        .iter()
                                        .find(|o| o.id == s || o.label == s)
                                        .map(|o| o.label.clone())
                                        .unwrap_or(s)
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            esc_csv(&joined)
                        } else {
                            esc_csv(&value_to_string(v))
                        }
                    }
                    "checkbox" => {
                        if v.as_bool().unwrap_or(false) {
                            "Yes".to_string()
                        } else {
                            "No".to_string()
                        }
                    }
                    _ => esc_csv(&value_to_string(v)),
                },
            })
            .collect();
        lines.push(cells.join(","));
    }

    format!("\u{feff}{}\n", lines.join("\n"))
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_markdown_rich_blocks() {
        let md = "\
# 项目架构总览

> 保持简洁与可靠

- [x] 完成数据库建模
- [ ] 接入全文搜索
- 无序要点 **加粗** 与 `inline *not italic*` 及 *斜体* 和 ~~删除线~~ 与 ==重点高亮==
1. 第一步
2. 第二步

---

```rust
fn main() {
    println!(\"hello <notion>\");
}
```

| 模块 | 状态 |
| --- | --- |
| 存储 | 已完成 |

普通段落包含 [[Product Roadmap]] 与 [官网](https://tauri.app)
";

        let drafts = parse_markdown_to_blocks(md);
        let types: Vec<&str> = drafts.iter().map(|d| d.block_type.as_str()).collect();
        assert_eq!(
            types,
            vec![
                "heading1",
                "quote",
                "todo",
                "todo",
                "bullet",
                "numbered",
                "numbered",
                "divider",
                "code",
                "table",
                "paragraph"
            ]
        );
        assert_eq!(drafts[2].props.checked, Some(true));
        assert_eq!(drafts[3].props.checked, Some(false));
        assert!(drafts[4].content.contains("<b>加粗</b>"));
        assert!(drafts[4].content.contains("<code>inline *not italic*</code>"));
        assert!(drafts[4].content.contains("<i>斜体</i>"));
        assert!(drafts[4].content.contains("<s>删除线</s>"));
        assert!(drafts[4].content.contains("<mark>重点高亮</mark>"));
        assert_eq!(drafts[8].props.language.as_deref(), Some("rust"));
        assert!(drafts[8].plain_text.contains("println!(\"hello <notion>\")"));
        assert!(drafts[8].content.contains("println!(\"hello <notion>\")"));
        assert!(!drafts[8].content.contains("&lt;"));
        assert_eq!(
            drafts[9].props.headers.as_ref().unwrap(),
            &vec!["模块".to_string(), "状态".to_string()]
        );
        assert!(drafts[10].content.contains("[[Product Roadmap]]"));
        assert!(drafts[10].content.contains("href=\"https://tauri.app\""));
    }

    #[test]
    fn test_highlight_and_gfm_pipe_table_lossless_roundtrip() {
        let items = vec![
            SaveBlockItem {
                id: "b-hl".into(),
                block_type: "paragraph".into(),
                content:
                    "支持 <b>粗体</b>、<i>斜体</i>、<s>删除线</s>、<mark>荧光笔高亮</mark> 与 <code>let x = 1;</code> 及 <a href=\"https://tauri.app\">Tauri</a>".into(),
                plain_text: String::new(),
                props: BlockProps::default(),
                sort_order: 0,
            },
            SaveBlockItem {
                id: "b-cal".into(),
                block_type: "callout".into(),
                content: "注意 <mark>便携目录</mark> 默认保存在当前软件目录下".into(),
                plain_text: String::new(),
                props: BlockProps {
                    callout_icon: Some("🧭".into()),
                    ..Default::default()
                },
                sort_order: 1,
            },
            SaveBlockItem {
                id: "b-tog".into(),
                block_type: "toggle".into(),
                content: "展开查看细节".into(),
                plain_text: String::new(),
                props: BlockProps {
                    collapsed: Some(true),
                    children_text: Some("第一行说明\n第二行说明".into()),
                    ..Default::default()
                },
                sort_order: 2,
            },
            SaveBlockItem {
                id: "b-tbl".into(),
                block_type: "table".into(),
                content: String::new(),
                plain_text: String::new(),
                props: BlockProps {
                    headers: Some(vec![
                        "特性 | Feature".into(),
                        "模式".into(),
                        "状态".into(),
                    ]),
                    rows: Some(vec![
                        vec!["GFM 管道表格".into(), "A | B 转义".into(), "✅ 完美往返".into()],
                        vec!["Typora 直编".into(), "Ctrl+O / Ctrl+S".into(), "✅ 就绪".into()],
                    ]),
                    ..Default::default()
                },
                sort_order: 3,
            },
        ];

        let md = serialize_save_blocks_to_markdown(&items);
        assert!(md.contains("==荧光笔高亮=="));
        assert!(md.contains("**粗体**"));
        assert!(md.contains("*斜体*"));
        assert!(md.contains("~~删除线~~"));
        assert!(md.contains("`let x = 1;`"));
        assert!(md.contains("[Tauri](https://tauri.app)"));
        assert!(md.contains("> [!NOTE] 🧭 注意 ==便携目录== 默认保存在当前软件目录下"));
        assert!(md.contains("| 特性 \\| Feature | 模式 | 状态 |"));
        assert!(md.contains("| GFM 管道表格 | A \\| B 转义 | ✅ 完美往返 |"));

        let reparsed = parse_markdown_to_blocks(&md);
        assert_eq!(reparsed.len(), 4);
        assert!(reparsed[0].content.contains("<mark>荧光笔高亮</mark>"));
        assert!(reparsed[0].content.contains("<b>粗体</b>"));
        assert_eq!(reparsed[1].block_type, "callout");
        assert_eq!(reparsed[1].props.callout_icon.as_deref(), Some("🧭"));
        assert!(reparsed[1].content.contains("<mark>便携目录</mark>"));
        assert_eq!(reparsed[2].block_type, "toggle");
        assert_eq!(reparsed[2].props.collapsed, Some(true));
        assert_eq!(
            reparsed[2].props.children_text.as_deref(),
            Some("第一行说明\n第二行说明")
        );
        assert_eq!(reparsed[3].block_type, "table");
        assert_eq!(
            reparsed[3].props.headers.as_ref().unwrap(),
            &vec![
                "特性 | Feature".to_string(),
                "模式".to_string(),
                "状态".to_string()
            ]
        );
        assert_eq!(
            reparsed[3].props.rows.as_ref().unwrap()[0],
            vec![
                "GFM 管道表格".to_string(),
                "A | B 转义".to_string(),
                "✅ 完美往返".to_string()
            ]
        );
    }

    #[test]
    fn test_math_image_bookmark_embed_markdown_roundtrip() {
        let md = "\
$$ E = mc^2 \\land x < y > z $$

$$
\\begin{bmatrix}
a & b \\\\
c < d & e > f
\\end{bmatrix}
$$

![系统架构示意图](https://example.com/assets/arch.png)

[🔖 Tauri v2 官方文档](https://v2.tauri.app/start/)

@[embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ \"架构演示视频\")
";
        let drafts = parse_markdown_to_blocks(md);
        let types: Vec<&str> = drafts.iter().map(|d| d.block_type.as_str()).collect();
        assert_eq!(types, vec!["math", "math", "image", "bookmark", "embed"]);

        assert_eq!(drafts[0].content, "E = mc^2 \\land x < y > z");
        assert_eq!(drafts[0].plain_text, "E = mc^2 \\land x < y > z");
        assert!(!drafts[0].content.contains("&lt;"));

        assert!(drafts[1].content.contains("c < d & e > f"));
        assert_eq!(drafts[1].content, drafts[1].plain_text);

        assert_eq!(
            drafts[2].props.url.as_deref(),
            Some("https://example.com/assets/arch.png")
        );
        assert_eq!(drafts[2].props.caption.as_deref(), Some("系统架构示意图"));

        assert_eq!(
            drafts[3].props.url.as_deref(),
            Some("https://v2.tauri.app/start/")
        );
        assert_eq!(
            drafts[3].props.bookmark_title.as_deref(),
            Some("Tauri v2 官方文档")
        );
        assert_eq!(
            drafts[3].props.bookmark_site.as_deref(),
            Some("v2.tauri.app")
        );

        assert_eq!(
            drafts[4].props.url.as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        assert_eq!(drafts[4].props.caption.as_deref(), Some("架构演示视频"));
        assert_eq!(drafts[4].props.embed_provider.as_deref(), Some("youtube"));

        let page = Page {
            id: "p-rich".into(),
            parent_id: None,
            title: "富媒体测试".into(),
            icon: "🧪".into(),
            cover: None,
            page_type: "doc".into(),
            is_favorite: false,
            is_trashed: false,
            sort_order: 0,
            created_at: "2026-11-14T00:00:00Z".into(),
            updated_at: "2026-11-14T00:00:00Z".into(),
        };
        let blocks: Vec<Block> = drafts
            .into_iter()
            .enumerate()
            .map(|(idx, d)| Block {
                id: format!("b-{}", idx),
                page_id: "p-rich".into(),
                block_type: d.block_type,
                content: d.content,
                plain_text: d.plain_text,
                props: d.props,
                sort_order: idx as i64,
                created_at: "2026-11-14T00:00:00Z".into(),
                updated_at: "2026-11-14T00:00:00Z".into(),
            })
            .collect();

        let exported = export_doc_to_markdown(&page, &blocks);
        let reimported = parse_markdown_to_blocks(&exported.markdown);
        let re_types: Vec<&str> = reimported.iter().map(|d| d.block_type.as_str()).collect();
        assert_eq!(
            re_types,
            vec!["heading1", "math", "math", "image", "bookmark", "embed"]
        );
        assert_eq!(reimported[1].content, "E = mc^2 \\land x < y > z");
        assert!(reimported[2].content.contains("c < d & e > f"));
        assert_eq!(
            reimported[3].props.url.as_deref(),
            Some("https://example.com/assets/arch.png")
        );
        assert_eq!(
            reimported[3].props.caption.as_deref(),
            Some("系统架构示意图")
        );
        assert_eq!(
            reimported[4].props.bookmark_title.as_deref(),
            Some("Tauri v2 官方文档")
        );
        assert_eq!(
            reimported[5].props.url.as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        assert_eq!(reimported[5].props.caption.as_deref(), Some("架构演示视频"));
    }

    #[test]
    fn test_export_doc_and_filename() {
        let page = Page {
            id: "p1".into(),
            parent_id: None,
            title: "设计规范: v1/v2".into(),
            icon: "📐".into(),
            cover: None,
            page_type: "doc".into(),
            is_favorite: false,
            is_trashed: false,
            sort_order: 0,
            created_at: "2026-11-14T00:00:00Z".into(),
            updated_at: "2026-11-14T00:00:00Z".into(),
        };
        let blocks = vec![
            Block {
                id: "b1".into(),
                page_id: "p1".into(),
                block_type: "heading2".into(),
                content: "核心原则".into(),
                plain_text: "核心原则".into(),
                props: BlockProps::default(),
                sort_order: 0,
                created_at: "2026-11-14T00:00:00Z".into(),
                updated_at: "2026-11-14T00:00:00Z".into(),
            },
            Block {
                id: "b2".into(),
                page_id: "p1".into(),
                block_type: "todo".into(),
                content: "编写测试".into(),
                plain_text: "编写测试".into(),
                props: BlockProps {
                    checked: Some(true),
                    ..Default::default()
                },
                sort_order: 1,
                created_at: "2026-11-14T00:00:00Z".into(),
                updated_at: "2026-11-14T00:00:00Z".into(),
            },
            Block {
                id: "b3".into(),
                page_id: "p1".into(),
                block_type: "code".into(),
                content: "fn generic<T>(items: Vec<T>) -> Option<T> { items.into_iter().next() }"
                    .into(),
                plain_text: String::new(),
                props: BlockProps {
                    language: Some("rust".into()),
                    ..Default::default()
                },
                sort_order: 2,
                created_at: "2026-11-14T00:00:00Z".into(),
                updated_at: "2026-11-14T00:00:00Z".into(),
            },
        ];
        let exported = export_doc_to_markdown(&page, &blocks);
        assert_eq!(exported.filename, "设计规范_ v1_v2.md");
        assert!(exported.markdown.contains("# 📐 设计规范: v1/v2"));
        assert!(exported.markdown.contains("## 核心原则"));
        assert!(exported.markdown.contains("- [x] 编写测试"));
        assert!(exported
            .markdown
            .contains("fn generic<T>(items: Vec<T>) -> Option<T>"));
    }

    #[test]
    fn test_mermaid_flowchart_chinese_br_and_entities_lossless_roundtrip() {
        let mermaid_body = "\
flowchart TB
  subgraph Triggers[\"一、四大业务调用入口\"]
    UI_UW[\"① 投保单人工核保页<br/>uwDetail.js (62)\"]
    BAK[\"getNewDecisionResultBak(actualId)<br/>返回 Map&lt;String,String&gt;\"]
  end
  UI_UW --> BAK";

        let md = format!(
            "```mermaid\n{}\n```\n\n```\nsequenceDiagram\n  Alice->>Bob: Hello<br/>World\n```\n",
            mermaid_body
        );

        let drafts = parse_markdown_to_blocks(&md);
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].block_type, "mermaid");
        assert_eq!(drafts[0].content, mermaid_body);
        assert_eq!(drafts[0].plain_text, mermaid_body);
        assert!(drafts[0].content.contains("<br/>"));
        assert!(drafts[0].content.contains("Map&lt;String,String&gt;"));
        assert!(drafts[0].content.contains("UI_UW --> BAK"));

        // Untagged fence starting with sequenceDiagram auto-detects as `mermaid`
        assert_eq!(drafts[1].block_type, "mermaid");
        assert!(drafts[1].content.contains("Alice->>Bob: Hello<br/>World"));

        let items: Vec<SaveBlockItem> = drafts
            .iter()
            .enumerate()
            .map(|(idx, d)| SaveBlockItem {
                id: format!("m-{}", idx),
                block_type: d.block_type.clone(),
                content: d.content.clone(),
                plain_text: d.plain_text.clone(),
                props: d.props.clone(),
                sort_order: idx as i64,
            })
            .collect();

        let exported_md = serialize_save_blocks_to_markdown(&items);
        assert!(exported_md.contains("```mermaid\nflowchart TB"));
        assert!(exported_md.contains("UI_UW[\"① 投保单人工核保页<br/>uwDetail.js (62)\"]"));
        assert!(exported_md.contains("返回 Map&lt;String,String&gt;"));

        let reparsed = parse_markdown_to_blocks(&exported_md);
        assert_eq!(reparsed.len(), 2);
        assert_eq!(reparsed[0].block_type, "mermaid");
        assert_eq!(reparsed[0].content, mermaid_body);
    }

    #[test]
    fn test_rich_gfm_table_file_uri_alignments_and_br_roundtrip() {
        let user_row = "| **Controller** | [PlcRiskAppraisalControllerImpl](file:///d:/src/PlcRiskAppraisalControllerImpl.java#L42) | `getNewDecisionResult` | 暴露 `/service/...` 与 `/contract/...` |";
        let md = format!(
            "| 层级 | 核心实现类 | 关键方法 | 职责说明 |\n| :--- | :---: | ---: | :--- |\n{}\n\n段落第一行<br/>段落第二行 [打开源码](file:///d:/my project/Main(1).java#L10) 与 [VSCode](vscode://file/d:/src/App.tsx:12) 及 [章节](#overview)\n",
            user_row
        );

        let drafts = parse_markdown_to_blocks(&md);
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].block_type, "table");
        assert_eq!(
            drafts[0].props.col_alignments.as_ref().unwrap(),
            &vec![
                "left".to_string(),
                "center".to_string(),
                "right".to_string(),
                "left".to_string()
            ]
        );

        let rows = drafts[0].props.rows.as_ref().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], "<b>Controller</b>");
        assert!(rows[0][1].contains("<a href=\"file:///d:/src/PlcRiskAppraisalControllerImpl.java#L42\""));
        assert!(rows[0][1].contains(">PlcRiskAppraisalControllerImpl</a>"));
        assert_eq!(rows[0][2], "<code>getNewDecisionResult</code>");
        assert_eq!(
            rows[0][3],
            "暴露 <code>/service/...</code> 与 <code>/contract/...</code>"
        );
        // Plain text strips HTML tags cleanly for FTS search
        assert!(!drafts[0].plain_text.contains("<b>"));
        assert!(drafts[0].plain_text.contains("Controller"));
        assert!(drafts[0].plain_text.contains("PlcRiskAppraisalControllerImpl"));
        assert!(drafts[0].plain_text.contains("getNewDecisionResult"));

        // Paragraph preserves `<br>` and universal links (`file:///` with space -> `%20`, `vscode://`, `#anchor`)
        assert_eq!(drafts[1].block_type, "paragraph");
        assert!(drafts[1].content.contains("段落第一行<br>段落第二行"));
        assert!(drafts[1]
            .content
            .contains("href=\"file:///d:/my%20project/Main(1).java#L10\""));
        assert!(drafts[1]
            .content
            .contains("href=\"vscode://file/d:/src/App.tsx:12\""));
        assert!(drafts[1].content.contains("href=\"#overview\""));

        // Roundtrip back to identical GFM pipe table Markdown!
        let items = vec![
            SaveBlockItem {
                id: "t-1".into(),
                block_type: drafts[0].block_type.clone(),
                content: drafts[0].content.clone(),
                plain_text: drafts[0].plain_text.clone(),
                props: drafts[0].props.clone(),
                sort_order: 0,
            },
            SaveBlockItem {
                id: "p-1".into(),
                block_type: drafts[1].block_type.clone(),
                content: drafts[1].content.clone(),
                plain_text: drafts[1].plain_text.clone(),
                props: drafts[1].props.clone(),
                sort_order: 1,
            },
        ];
        let exported_md = serialize_save_blocks_to_markdown(&items);
        assert!(exported_md.contains("| 层级 | 核心实现类 | 关键方法 | 职责说明 |"));
        assert!(exported_md.contains("| :--- | :---: | ---: | :--- |"));
        assert!(exported_md.contains(user_row));
        assert!(exported_md.contains("段落第一行<br/>段落第二行"));
    }
}
