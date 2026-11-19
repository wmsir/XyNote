//! CJK + 技术标识符分词与零 LLM 成本实体抽取（SAG2 本地冷索引核心）。

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedEntity {
    pub norm_name: String,
    pub display_name: String,
    pub entity_type: &'static str,
    pub weight: f64,
}

#[inline]
pub fn is_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}'
    )
}

#[inline]
fn is_ascii_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// 将 ASCII 标识符按 `_` / `-` / `.` 以及 CamelCase 拆分出有意义的子词，同时保留原词
fn push_ascii_ident_tokens(raw: &str, out: &mut Vec<String>) {
    let trimmed = raw.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.len() < 2 {
        return;
    }
    let lower_full = trimmed.to_ascii_lowercase();
    out.push(lower_full.clone());

    // 拆分下划线、连字符、点号
    for part in trimmed.split(|c: char| matches!(c, '_' | '-' | '.')) {
        if part.len() >= 2 {
            let lp = part.to_ascii_lowercase();
            if lp != lower_full {
                out.push(lp);
            }
        }
        // 拆分 CamelCase，例如 HyperEdge -> hyper, edge
        let chars: Vec<char> = part.chars().collect();
        let mut start = 0;
        for i in 1..chars.len() {
            let prev = chars[i - 1];
            let cur = chars[i];
            let next_is_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            let boundary = (prev.is_ascii_lowercase() && cur.is_ascii_uppercase())
                || (prev.is_ascii_uppercase() && cur.is_ascii_uppercase() && next_is_lower)
                || (prev.is_ascii_alphabetic() != cur.is_ascii_alphabetic());
            if boundary {
                if i - start >= 2 {
                    let sub: String = chars[start..i].iter().collect();
                    let ls = sub.to_ascii_lowercase();
                    if ls != lower_full {
                        out.push(ls);
                    }
                }
                start = i;
            }
        }
        if start > 0 && chars.len() - start >= 2 {
            let sub: String = chars[start..].iter().collect();
            let ls = sub.to_ascii_lowercase();
            if ls != lower_full {
                out.push(ls);
            }
        }
    }
}

/// 生成供 SQLite FTS5 `unicode61` 索引与查询的空格分隔分词序列：
/// - 连续中文输出 2-gram 重叠切片（3~4 字短词额外保留整词）
/// - 英文/数字保留整词与 CamelCase/snake_case 子词
pub fn tokenize_for_fts(text: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() && tokens.len() < 640 {
        let ch = chars[i];
        if is_cjk(ch) {
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) {
                i += 1;
            }
            let run = &chars[start..i];
            if run.len() == 1 {
                tokens.push(run[0].to_string());
            } else {
                for w in run.windows(2) {
                    let mut bg = String::with_capacity(6);
                    bg.push(w[0]);
                    bg.push(w[1]);
                    tokens.push(bg);
                }
                if (3..=4).contains(&run.len()) {
                    tokens.push(run.iter().collect());
                }
            }
        } else if ch.is_ascii_alphanumeric() {
            let start = i;
            while i < chars.len() && is_ascii_ident_char(chars[i]) {
                i += 1;
            }
            let raw: String = chars[start..i].iter().collect();
            push_ascii_ident_tokens(&raw, &mut tokens);
        } else {
            i += 1;
        }
    }

    // 折叠连续重复词，控制索引体积
    let mut deduped: Vec<String> = Vec::with_capacity(tokens.len());
    for tok in tokens {
        if deduped.last().is_some_and(|prev| prev == &tok) {
            continue;
        }
        deduped.push(tok);
        if deduped.len() >= 600 {
            break;
        }
    }
    deduped.join(" ")
}

/// 为 FTS5 `MATCH` 构造绝对安全的查询表达式（引号转义 + AND/OR 组合），避免标点符号引发 syntax error
pub fn build_fts_match_expr(query: &str, require_all: bool) -> Option<String> {
    let tokenized = tokenize_for_fts(query);
    let mut seen = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    for tok in tokenized.split_whitespace() {
        let safe: String = tok.chars().filter(|c| *c != '"').collect();
        if safe.is_empty() {
            continue;
        }
        if seen.insert(safe.clone()) {
            terms.push(format!("\"{}\"", safe));
            if terms.len() >= 16 {
                break;
            }
        }
    }
    if terms.is_empty() {
        None
    } else if terms.len() == 1 {
        Some(terms.into_iter().next().unwrap())
    } else {
        let op = if require_all { " AND " } else { " OR " };
        Some(terms.join(op))
    }
}

fn is_en_stopword(lower: &str) -> bool {
    matches!(
        lower,
        "the"
            | "and"
            | "for"
            | "are"
            | "but"
            | "not"
            | "you"
            | "all"
            | "can"
            | "had"
            | "her"
            | "was"
            | "one"
            | "our"
            | "out"
            | "has"
            | "his"
            | "how"
            | "its"
            | "may"
            | "new"
            | "now"
            | "old"
            | "see"
            | "two"
            | "way"
            | "who"
            | "did"
            | "get"
            | "let"
            | "put"
            | "say"
            | "she"
            | "too"
            | "use"
            | "with"
            | "this"
            | "that"
            | "from"
            | "they"
            | "have"
            | "will"
            | "what"
            | "when"
            | "make"
            | "like"
            | "time"
            | "just"
            | "know"
            | "take"
            | "into"
            | "year"
            | "your"
            | "some"
            | "them"
            | "than"
            | "then"
            | "look"
            | "only"
            | "come"
            | "over"
            | "such"
            | "also"
            | "back"
            | "work"
            | "well"
            | "even"
            | "want"
            | "give"
            | "most"
            | "true"
            | "false"
            | "null"
            | "none"
            | "http"
            | "https"
            | "www"
            | "com"
            | "org"
            | "net"
            | "html"
            | "untitled"
            | "page"
            | "note"
            | "notes"
            | "file"
            | "todo"
    )
}

#[inline]
fn is_cjk_split_particle(c: char) -> bool {
    matches!(
        c,
        '的' | '了'
            | '着'
            | '过'
            | '吗'
            | '呢'
            | '啊'
            | '吧'
            | '呀'
            | '啦'
            | '嘛'
            | '之'
            | '其'
            | '与'
            | '和'
            | '及'
            | '并'
            | '或'
            | '把'
            | '被'
            | '将'
            | '向'
            | '从'
            | '在'
            | '是'
            | '有'
            | '也'
            | '都'
            | '就'
            | '还'
            | '很'
            | '更'
            | '最'
            | '这'
            | '那'
            | '该'
            | '每'
            | '某'
    )
}

const CJK_CONNECTOR_PHRASES: [&str; 29] = [
    "导致", "引起", "造成", "出现", "发生", "需要", "可以", "已经", "因为", "所以", "如果", "通过",
    "进行", "实现", "支持", "相关", "有关", "由于", "关于", "以及", "但是", "并且", "或者", "虽然",
    "而且", "然后", "因此", "从而", "无法",
];

const CJK_NOISY_TERMS: [&str; 24] = [
    "无标题", "欢迎", "我们", "你们", "他们", "自己", "怎么", "什么", "为什么", "如何", "哪些",
    "这个", "那个", "时候", "问题", "情况", "方式", "方法", "内容", "今天", "昨天", "上周", "本周",
    "最近",
];

fn normalize_entity_key(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn upsert_entity(
    map: &mut HashMap<String, ExtractedEntity>,
    display: &str,
    entity_type: &'static str,
    weight: f64,
) {
    let trimmed = display
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '[' | ']' | '(' | ')' | ','));
    let char_len = trimmed.chars().count();
    if !(2..=32).contains(&char_len) {
        return;
    }
    let norm = normalize_entity_key(trimmed);
    if norm.chars().count() < 2 || is_en_stopword(&norm) || CJK_NOISY_TERMS.contains(&norm.as_str())
    {
        return;
    }
    // 跳过纯数字（3 位 HTTP 状态码如 502/404 例外，1/2 位纯数字太噪）
    if norm.chars().all(|c| c.is_ascii_digit()) && (norm.len() < 3 || norm.len() > 5) {
        return;
    }

    map.entry(norm.clone())
        .and_modify(|existing| {
            if weight > existing.weight {
                existing.weight = weight;
                existing.entity_type = entity_type;
                existing.display_name = trimmed.to_string();
            }
        })
        .or_insert_with(|| ExtractedEntity {
            norm_name: norm,
            display_name: trimmed.to_string(),
            entity_type,
            weight,
        });
}

fn extract_wiki_links_and_code(raw_content: &str, map: &mut HashMap<String, ExtractedEntity>) {
    // 1. [[Target]] / [[Target|Alias]]
    let mut rest = raw_content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        if let Some(end) = after.find("]]") {
            let inner = after[..end].trim();
            let target = inner.split('|').next().unwrap_or(inner).trim();
            upsert_entity(map, target, "wiki_link", 3.2);
            rest = &after[end + 2..];
        } else {
            break;
        }
    }

    // 2. HTML <a data-wiki-target="...">
    let mut html_rest = raw_content;
    while let Some(pos) = html_rest.find("data-wiki-target=\"") {
        let after = &html_rest[pos + "data-wiki-target=\"".len()..];
        if let Some(end) = after.find('"') {
            let target = after[..end]
                .replace("&quot;", "\"")
                .replace("&amp;", "&")
                .trim()
                .to_string();
            upsert_entity(map, &target, "wiki_link", 3.2);
            html_rest = &after[end + 1..];
        } else {
            break;
        }
    }

    // 3. Markdown inline `code`
    let mut code_rest = raw_content;
    while let Some(start) = code_rest.find('`') {
        let after = &code_rest[start + 1..];
        if let Some(end) = after.find('`') {
            let inner = after[..end].trim();
            if !inner.contains('\n') && inner.chars().count() <= 32 {
                upsert_entity(map, inner, "code", 2.2);
            }
            code_rest = &after[end + 1..];
        } else {
            break;
        }
    }

    // 4. HTML <code>...</code>
    let mut tag_rest = raw_content;
    while let Some(start) = tag_rest.find("<code>") {
        let after = &tag_rest[start + 6..];
        if let Some(end) = after.find("</code>") {
            let inner = after[..end].trim();
            if !inner.contains('<') && inner.chars().count() <= 32 {
                upsert_entity(map, inner, "code", 2.2);
            }
            tag_rest = &after[end + 7..];
        } else {
            break;
        }
    }
}

fn extract_hashtags(text: &str, map: &mut HashMap<String, ExtractedEntity>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' {
            let valid_before = i == 0
                || chars[i - 1].is_whitespace()
                || matches!(chars[i - 1], '，' | '。' | '（' | '(' | '[' | '【' | '/');
            if valid_before && i + 1 < chars.len() && !chars[i + 1].is_whitespace() && chars[i + 1] != '#'
            {
                let start = i + 1;
                let mut end = start;
                while end < chars.len()
                    && !chars[end].is_whitespace()
                    && !matches!(
                        chars[end],
                        '#' | ','
                            | '.'
                            | '!'
                            | '?'
                            | ':'
                            | ';'
                            | ')'
                            | ']'
                            | '}'
                            | '"'
                            | '\''
                            | '，'
                            | '。'
                            | '、'
                            | '；'
                            | '：'
                            | '）'
                            | '】'
                            | '《'
                            | '》'
                            | '<'
                            | '>'
                    )
                {
                    end += 1;
                }
                let tag: String = chars[start..end].iter().collect();
                let is_hex = matches!(tag.len(), 3 | 4 | 6 | 8)
                    && tag.chars().all(|c| c.is_ascii_hexdigit());
                let is_digits = tag.chars().all(|c| c.is_ascii_digit());
                if !is_hex && !is_digits {
                    upsert_entity(map, &tag, "tag", 2.8);
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
}

fn strip_connector_phrases(cjk_run: &str) -> Vec<String> {
    let mut working = cjk_run.to_string();
    for conn in CJK_CONNECTOR_PHRASES {
        if working.contains(conn) {
            working = working.replace(conn, " ");
        }
    }
    working
        .split_whitespace()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_terms_from_text(text: &str, base_weight: f64, map: &mut HashMap<String, ExtractedEntity>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if is_cjk(ch) {
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) && !is_cjk_split_particle(chars[i]) {
                i += 1;
            }
            let raw_run: String = chars[start..i].iter().collect();
            for chunk in strip_connector_phrases(&raw_run) {
                let clen = chunk.chars().count();
                if (2..=8).contains(&clen) {
                    let w = if clen <= 4 { base_weight * 1.1 } else { base_weight };
                    upsert_entity(map, &chunk, "term", w);
                } else if clen > 8 {
                    // 超长中文名词串：截取头尾 4 字核心短语，既能跨文档衔接又不至于碎片化
                    let cchars: Vec<char> = chunk.chars().collect();
                    let head: String = cchars[..4].iter().collect();
                    let tail: String = cchars[clen - 4..].iter().collect();
                    upsert_entity(map, &head, "term", base_weight * 0.85);
                    upsert_entity(map, &tail, "term", base_weight * 0.85);
                }
            }
            if i < chars.len() && is_cjk_split_particle(chars[i]) {
                i += 1;
            }
        } else if ch.is_ascii_alphanumeric() {
            let start = i;
            while i < chars.len() && is_ascii_ident_char(chars[i]) {
                i += 1;
            }
            let raw: String = chars[start..i].iter().collect();
            let trimmed = raw.trim_matches(|c: char| !c.is_ascii_alphanumeric());
            if trimmed.len() >= 3 || (trimmed.len() == 2 && trimmed.chars().any(|c| c.is_ascii_digit() || c.is_ascii_uppercase()))
            {
                let lower = trimmed.to_ascii_lowercase();
                if !is_en_stopword(&lower) {
                    upsert_entity(map, trimmed, "code", base_weight.max(1.6));
                }
            }
            // 若紧接着就是中文（如 "Redis连接池"），顺便补一条组合短词作为强实体
            if i < chars.len() && is_cjk(chars[i]) && trimmed.len() >= 2 && trimmed.len() <= 16 {
                let cjk_start = i;
                let mut cjk_end = i;
                while cjk_end < chars.len()
                    && is_cjk(chars[cjk_end])
                    && !is_cjk_split_particle(chars[cjk_end])
                    && (cjk_end - cjk_start) < 6
                {
                    cjk_end += 1;
                }
                if cjk_end - cjk_start >= 2 {
                    let cjk_tail: String = chars[cjk_start..cjk_end].iter().collect();
                    if let Some(first_chunk) = strip_connector_phrases(&cjk_tail).into_iter().next() {
                        if first_chunk.chars().count() >= 2 {
                            let combined = format!("{}{}", trimmed, first_chunk);
                            upsert_entity(map, &combined, "term", base_weight * 1.15);
                        }
                    }
                }
            }
        } else {
            i += 1;
        }
    }
}

/// 零 LLM 成本提取一个知识块中的结构化实体（WikiLink / Tag / 标题 / 代码符号 / 数据库字段 / 中文概念短语）
pub fn extract_entities(
    title: &str,
    heading_path: &str,
    body: &str,
    raw_content: &str,
    extra_db_vals: &[String],
) -> Vec<ExtractedEntity> {
    let mut map: HashMap<String, ExtractedEntity> = HashMap::new();

    extract_wiki_links_and_code(raw_content, &mut map);
    extract_hashtags(body, &mut map);
    extract_hashtags(raw_content, &mut map);

    let clean_title = title.trim();
    if !clean_title.is_empty()
        && clean_title != "无标题"
        && !clean_title.eq_ignore_ascii_case("untitled")
    {
        if clean_title.chars().count() <= 24 {
            upsert_entity(&mut map, clean_title, "heading", 2.6);
        }
        extract_terms_from_text(clean_title, 1.8, &mut map);
    }

    if !heading_path.trim().is_empty() {
        for seg in heading_path.split(" / ") {
            let s = seg.trim();
            if s.is_empty() || s == "无标题章节" {
                continue;
            }
            if s.chars().count() <= 24 {
                upsert_entity(&mut map, s, "heading", 2.2);
            }
            extract_terms_from_text(s, 1.5, &mut map);
        }
    }

    for val in extra_db_vals {
        let v = val.trim();
        if !v.is_empty() {
            upsert_entity(&mut map, v, "db_val", 2.2);
            extract_terms_from_text(v, 1.4, &mut map);
        }
    }

    extract_terms_from_text(body, 1.0, &mut map);

    let mut out: Vec<ExtractedEntity> = map.into_values().collect();
    out.sort_by(|a, b| {
        b.weight
            .partial_cmp(&a.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.norm_name.cmp(&b.norm_name))
    });
    out.truncate(24);
    out
}

/// 从用户查询中提取用于匹配 `kb_entities` 的归一化关键词
pub fn extract_query_terms(query: &str) -> Vec<String> {
    let mut map: HashMap<String, ExtractedEntity> = HashMap::new();
    extract_hashtags(query, &mut map);
    extract_terms_from_text(query, 1.5, &mut map);
    // 也保留整个短查询本身作为一个候选实体
    let clean = query.trim();
    if (2..=24).contains(&clean.chars().count()) {
        upsert_entity(&mut map, clean, "term", 2.0);
    }
    let mut items: Vec<ExtractedEntity> = map.into_values().collect();
    items.sort_by(|a, b| {
        b.weight
            .partial_cmp(&a.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items.into_iter().take(12).map(|e| e.norm_name).collect()
}
