//! SAG2 查询时动态超边（Query-Time Dynamic Hyperedges）多跳检索引擎。
//!
//! 流程：
//! 1. Hop 0：SQLite FTS5 BM25（严格 AND 优先 + 宽松 OR 兜底）+ 实体词典匹配，召回种子事件 `E0`；
//! 2. Hop 1：从 `E0` 与查询实体的非高频噪声概念出发，在 `kb_event_entities` 上执行 SQL JOIN，
//!    按 IDF 权重 + 共现超边度 + `kb_page_links` 双链实时拼出跨文档关联事件 `E1`；
//! 3. 附带可解释的关联概念（`shared_entities`）与精准块/行溯源坐标（`block_id` / `line_start`）。

use crate::kb::index::escape_sql_like;
use crate::kb::tokenizer::{build_fts_match_expr, extract_entities, extract_query_terms};
use crate::models::AppError;
use crate::storage::normalize_path_key;
use crate::win_dialogs::normalize_win32_path_str;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KbSearchHit {
    pub event_id: String,
    pub source_id: String,
    pub source_kind: String, // "workspace_page" | "mounted_file"
    pub ref_id: String,
    pub title: String,
    pub icon: String,
    pub root_name: String,
    pub block_id: Option<String>,
    pub line_start: Option<i64>,
    pub heading_path: String,
    pub snippet: String,
    pub match_kind: String, // "direct" | "hyperedge"
    pub shared_entities: Vec<String>,
    pub score: f64,
    pub event_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KbEntitySummary {
    pub name: String,
    pub entity_type: String,
    pub doc_freq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KbSearchResponse {
    pub query: String,
    pub total_sources: usize,
    pub total_events: usize,
    pub elapsed_ms: u64,
    pub hits: Vec<KbSearchHit>,
    pub top_entities: Vec<KbEntitySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KbRelatedResponse {
    pub context_entities: Vec<KbEntitySummary>,
    pub hits: Vec<KbSearchHit>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
struct EventRow {
    event_id: String,
    source_id: String,
    source_kind: String,
    ref_id: String,
    title: String,
    icon: String,
    root_name: String,
    block_id: Option<String>,
    line_start: Option<i64>,
    heading_path: String,
    body: String,
    event_time: String,
}

fn idf(doc_freq: i64, total_sources: usize) -> f64 {
    let n = (total_sources as f64).max(2.0);
    let df = (doc_freq.max(1) as f64).min(n);
    (((n - df + 0.5) / (df + 0.5)) + 1.0).ln().max(0.25)
}

fn noise_df_limit(total_sources: usize) -> i64 {
    if total_sources <= 3 {
        (total_sources as i64).max(1)
    } else {
        ((total_sources as f64 * 0.65).ceil() as i64).max(3)
    }
}

fn make_snippet(body: &str, needles: &[String], max_chars: usize) -> String {
    let clean = body.replace('\n', " ").trim().to_string();
    if clean.is_empty() {
        return String::new();
    }
    let clean_chars: Vec<char> = clean.chars().collect();
    if clean_chars.len() <= max_chars {
        return clean;
    }

    let lower_chars: Vec<char> = clean.to_lowercase().chars().collect();
    for needle in needles {
        let n_chars: Vec<char> = needle.trim().to_lowercase().chars().collect();
        if n_chars.is_empty() || lower_chars.len() < n_chars.len() {
            continue;
        }
        if let Some(pos) = lower_chars.windows(n_chars.len()).position(|w| w == n_chars.as_slice())
        {
            let start = pos.saturating_sub(28);
            let end = (start + max_chars).min(clean_chars.len());
            let slice: String = clean_chars[start..end].iter().collect();
            let prefix = if start > 0 { "…" } else { "" };
            let suffix = if end < clean_chars.len() { "…" } else { "" };
            return format!("{}{}{}", prefix, slice, suffix);
        }
    }

    let slice: String = clean_chars.into_iter().take(max_chars).collect();
    format!("{}…", slice)
}

fn read_kb_totals(conn: &Connection) -> Result<(usize, usize), AppError> {
    let total_sources: i64 = conn.query_row("SELECT COUNT(*) FROM kb_sources", [], |r| r.get(0))?;
    let total_events: i64 = conn.query_row("SELECT COUNT(*) FROM kb_events", [], |r| r.get(0))?;
    Ok((total_sources.max(0) as usize, total_events.max(0) as usize))
}

fn query_fts_seeds(
    conn: &Connection,
    expr: &str,
    limit: usize,
) -> Result<Vec<(EventRow, f64)>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                bm25(kb_events_fts, 3.0, 2.0, 1.0) AS rank_score
         FROM kb_events_fts
         JOIN kb_events e ON e.event_id = kb_events_fts.event_id
         JOIN kb_sources s ON s.source_id = e.source_id
         WHERE kb_events_fts MATCH ?1
         ORDER BY rank_score ASC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![expr, limit as i64], |r| {
            let rank: f64 = r.get(12)?;
            Ok((
                EventRow {
                    event_id: r.get(0)?,
                    source_id: r.get(1)?,
                    source_kind: r.get(2)?,
                    ref_id: r.get(3)?,
                    title: r.get(4)?,
                    icon: r.get(5)?,
                    root_name: r.get(6)?,
                    block_id: r.get(7)?,
                    line_start: r.get(8)?,
                    heading_path: r.get(9)?,
                    body: r.get(10)?,
                    event_time: r.get(11)?,
                },
                (-rank).max(0.1),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn find_linked_source_ids(conn: &Connection, seed_sources: &HashSet<String>) -> HashSet<String> {
    let mut page_ids: Vec<String> = seed_sources
        .iter()
        .filter_map(|sid| sid.strip_prefix("page:").map(|s| s.to_string()))
        .collect();
    page_ids.sort();
    page_ids.dedup();
    if page_ids.is_empty() {
        return HashSet::new();
    }
    let Ok(json_ids) = serde_json::to_string(&page_ids) else {
        return HashSet::new();
    };
    let mut out = HashSet::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT target_page_id FROM kb_page_links WHERE source_page_id IN (SELECT value FROM json_each(?1))
         UNION
         SELECT source_page_id FROM kb_page_links WHERE target_page_id IN (SELECT value FROM json_each(?1))",
    ) {
        if let Ok(rows) = stmt.query_map(params![json_ids], |r| r.get::<_, String>(0)) {
            for pid in rows.flatten() {
                out.insert(format!("page:{}", pid));
            }
        }
    }
    out
}

/// SAG2 核心检索：FTS5 BM25 种子召回 + SQL 查询时动态超边多跳发现
pub fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
    hops: u8,
) -> Result<KbSearchResponse, AppError> {
    let t0 = Instant::now();
    let trimmed = query.trim();
    let (total_sources, total_events) = read_kb_totals(conn)?;

    if trimmed.is_empty() || total_events == 0 {
        return Ok(KbSearchResponse {
            query: trimmed.to_string(),
            total_sources,
            total_events,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            hits: Vec::new(),
            top_entities: Vec::new(),
        });
    }

    let limit = limit.clamp(1, 50);
    let query_terms = extract_query_terms(trimmed);
    let max_df = noise_df_limit(total_sources);

    // 1. Hop 0: FTS5 BM25 检索（先严格 AND，命中不足再 OR 召回子主题锚点）
    let mut direct_map: HashMap<String, (EventRow, f64)> = HashMap::new();
    if let Some(and_expr) = build_fts_match_expr(trimmed, true) {
        for (row, score) in query_fts_seeds(conn, &and_expr, 24).unwrap_or_default() {
            direct_map.insert(row.event_id.clone(), (row, score + 3.0));
        }
    }
    if direct_map.len() < 8 {
        if let Some(or_expr) = build_fts_match_expr(trimmed, false) {
            for (row, score) in query_fts_seeds(conn, &or_expr, 24).unwrap_or_default() {
                direct_map
                    .entry(row.event_id.clone())
                    .and_modify(|e| {
                        if score > e.1 {
                            e.1 = score;
                        }
                    })
                    .or_insert((row, score));
            }
        }
    }

    // 2. 实体词典精准/前缀匹配（支持搜 #tag / [[WikiLink]] / 专有名词）
    let mut query_entity_weights: HashMap<i64, (String, f64, i64, String)> = HashMap::new();
    for term in &query_terms {
        let like_pat = format!("{}%", escape_sql_like(term));
        let mut stmt = conn.prepare(
            "SELECT entity_id, display_name, entity_type, doc_freq
             FROM kb_entities
             WHERE norm_name = ?1
                OR (length(?1) >= 2 AND norm_name LIKE ?2 ESCAPE '!')
             ORDER BY CASE WHEN norm_name = ?1 THEN 0 ELSE 1 END, doc_freq ASC
             LIMIT 6",
        )?;
        let rows = stmt
            .query_map(params![term, &like_pat], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (eid, dname, etype, df) in rows {
            let exact = dname.to_ascii_lowercase() == *term;
            let boost = if exact { 2.4 } else { 1.4 };
            query_entity_weights
                .entry(eid)
                .and_modify(|cur| {
                    if boost > cur.1 {
                        cur.1 = boost;
                    }
                })
                .or_insert((dname, boost, df, etype));
        }
    }

    if !query_entity_weights.is_empty() {
        let eids: Vec<i64> = query_entity_weights.keys().copied().collect();
        if let Ok(json_eids) = serde_json::to_string(&eids) {
            let mut stmt = conn.prepare(
                "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                        e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                        SUM(ee.weight) AS w
                 FROM kb_event_entities ee
                 JOIN kb_events e ON e.event_id = ee.event_id
                 JOIN kb_sources s ON s.source_id = e.source_id
                 WHERE ee.entity_id IN (SELECT value FROM json_each(?1))
                 GROUP BY e.event_id
                 ORDER BY w DESC
                 LIMIT 16",
            )?;
            let rows = stmt
                .query_map(params![json_eids], |r| {
                    Ok((
                        EventRow {
                            event_id: r.get(0)?,
                            source_id: r.get(1)?,
                            source_kind: r.get(2)?,
                            ref_id: r.get(3)?,
                            title: r.get(4)?,
                            icon: r.get(5)?,
                            root_name: r.get(6)?,
                            block_id: r.get(7)?,
                            line_start: r.get(8)?,
                            heading_path: r.get(9)?,
                            body: r.get(10)?,
                            event_time: r.get(11)?,
                        },
                        r.get::<_, f64>(12)? * 0.8,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (row, escore) in rows {
                direct_map
                    .entry(row.event_id.clone())
                    .and_modify(|cur| cur.1 += escore * 0.4)
                    .or_insert((row, escore));
            }
        }
    }

    let mut direct_vec: Vec<(EventRow, f64)> = direct_map.into_values().collect();
    direct_vec.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.event_time.cmp(&a.0.event_time))
    });

    // 3. Hop 1: Query-Time Dynamic Hyperedges（SQL JOIN 在共享非噪声实体上跨文档搭桥）
    let mut seed_entities: HashMap<i64, (String, f64, i64, String)> = query_entity_weights.clone();
    let seed_events: Vec<&(EventRow, f64)> = direct_vec.iter().take(16).collect();
    let seed_event_ids: HashSet<String> = seed_events.iter().map(|(r, _)| r.event_id.clone()).collect();
    let seed_source_ids: HashSet<String> = seed_events.iter().map(|(r, _)| r.source_id.clone()).collect();

    // 记录每个种子实体出现在哪些种子 source 中，用来识别“跨文档桥梁实体”
    let mut entity_seed_sources: HashMap<i64, HashSet<String>> = HashMap::new();
    if !seed_event_ids.is_empty() {
        let seed_ids_vec: Vec<String> = seed_event_ids.iter().cloned().collect();
        if let Ok(json_ev) = serde_json::to_string(&seed_ids_vec) {
            let mut stmt = conn.prepare(
                "SELECT e.source_id, ent.entity_id, ent.display_name, ent.entity_type, ent.doc_freq, ee.weight
                 FROM kb_event_entities ee
                 JOIN kb_entities ent ON ent.entity_id = ee.entity_id
                 JOIN kb_events e ON e.event_id = ee.event_id
                 WHERE ee.event_id IN (SELECT value FROM json_each(?1))
                   AND ent.doc_freq <= ?2",
            )?;
            let rows = stmt
                .query_map(params![json_ev, max_df], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, f64>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (src_id, eid, dname, etype, df, w) in rows {
                entity_seed_sources.entry(eid).or_default().insert(src_id);
                let ent_score = w * idf(df, total_sources);
                seed_entities
                    .entry(eid)
                    .and_modify(|cur| {
                        if ent_score > cur.1 {
                            cur.1 = ent_score;
                        }
                    })
                    .or_insert((dname, ent_score, df, etype));
            }
        }
    }

    // 整理 top_entities 供顶部概念条展示
    let mut entity_list: Vec<(i64, String, String, i64, f64)> = seed_entities
        .iter()
        .map(|(eid, (name, score, df, etype))| (*eid, name.clone(), etype.clone(), *df, *score))
        .collect();
    entity_list.sort_by(|a, b| {
        b.4.partial_cmp(&a.4)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.3.cmp(&b.3))
    });
    let top_entities: Vec<KbEntitySummary> = entity_list
        .iter()
        .take(10)
        .map(|(_, name, etype, df, _)| KbEntitySummary {
            name: name.clone(),
            entity_type: etype.clone(),
            doc_freq: *df,
        })
        .collect();

    let mut direct_shared_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut hyper_candidates: HashMap<String, (EventRow, f64, Vec<(String, f64)>)> = HashMap::new();

    if hops >= 1 && !seed_entities.is_empty() {
        let linked_sources = find_linked_source_ids(conn, &seed_source_ids);
        let top_seed_eids: Vec<i64> = entity_list.iter().take(36).map(|e| e.0).collect();
        if let Ok(json_eids) = serde_json::to_string(&top_seed_eids) {
            let mut stmt = conn.prepare(
                "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                        e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                        ent.entity_id, ent.display_name, ent.doc_freq, ee.weight
                 FROM kb_event_entities ee
                 JOIN kb_entities ent ON ent.entity_id = ee.entity_id
                 JOIN kb_events e ON e.event_id = ee.event_id
                 JOIN kb_sources s ON s.source_id = e.source_id
                 WHERE ee.entity_id IN (SELECT value FROM json_each(?1))
                   AND ent.doc_freq <= ?2",
            )?;
            let rows = stmt
                .query_map(params![json_eids, max_df], |r| {
                    Ok((
                        EventRow {
                            event_id: r.get(0)?,
                            source_id: r.get(1)?,
                            source_kind: r.get(2)?,
                            ref_id: r.get(3)?,
                            title: r.get(4)?,
                            icon: r.get(5)?,
                            root_name: r.get(6)?,
                            block_id: r.get(7)?,
                            line_start: r.get(8)?,
                            heading_path: r.get(9)?,
                            body: r.get(10)?,
                            event_time: r.get(11)?,
                        },
                        r.get::<_, i64>(12)?,
                        r.get::<_, String>(13)?,
                        r.get::<_, i64>(14)?,
                        r.get::<_, f64>(15)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            // 统计直接命中的事件中，哪些实体同时把“不同文档”桥接在了一起
            let mut direct_bridges: HashMap<String, Vec<(String, f64)>> = HashMap::new();

            for (row, eid, dname, df, cand_w) in rows {
                let seed_w = seed_entities.get(&eid).map(|v| v.1).unwrap_or(1.0);
                let contribution = seed_w * cand_w * idf(df, total_sources);

                if direct_map_contains(&direct_vec, &row.event_id) {
                    // 如果该实体同时也出现在其它种子文档中（跨源桥接），记录到直接命中卡片上方便可解释展示
                    if let Some(srcs) = entity_seed_sources.get(&eid) {
                        if srcs.iter().any(|sid| sid != &row.source_id) {
                            direct_bridges
                                .entry(row.event_id.clone())
                                .or_default()
                                .push((dname, contribution));
                        }
                    }
                    continue;
                }

                let entry = hyper_candidates
                    .entry(row.event_id.clone())
                    .or_insert_with(|| (row, 0.0, Vec::new()));
                entry.1 += contribution;
                if !entry.2.iter().any(|(n, _)| n == &dname) {
                    entry.2.push((dname, contribution));
                }
            }

            for (ev_id, mut list) in direct_bridges {
                list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                let mut names: Vec<String> = Vec::new();
                for (n, _) in list {
                    if !names.contains(&n) {
                        names.push(n);
                        if names.len() >= 3 {
                            break;
                        }
                    }
                }
                direct_shared_map.insert(ev_id, names);
            }

            for (_, (row, score, _)) in &mut hyper_candidates {
                if linked_sources.contains(&row.source_id) {
                    *score += 1.5;
                }
                if !seed_source_ids.contains(&row.source_id) {
                    // 优先把尚未直接命中的新文档通过超边推出来
                    *score += 0.6;
                }
            }
        }
    }

    // 4. 组装最终输出：先直接命中，再动态超边发现，单源去重防止刷屏
    let direct_cap = if hyper_candidates.is_empty() {
        limit
    } else {
        (limit * 2 / 3).max(4)
    };
    let mut hits: Vec<KbSearchHit> = Vec::new();
    let mut direct_per_source: HashMap<String, usize> = HashMap::new();
    let mut direct_used_ids: HashSet<String> = HashSet::new();

    let mut base_needles: Vec<String> = trimmed.split_whitespace().map(|s| s.to_string()).collect();
    for qt in &query_terms {
        if !base_needles.contains(qt) {
            base_needles.push(qt.clone());
        }
    }

    for (row, score) in direct_vec {
        if hits.len() >= direct_cap {
            break;
        }
        let cnt = direct_per_source.entry(row.source_id.clone()).or_insert(0);
        if *cnt >= 2 {
            continue;
        }
        *cnt += 1;
        direct_used_ids.insert(row.event_id.clone());
        let shared = direct_shared_map.remove(&row.event_id).unwrap_or_default();
        let mut needles = base_needles.clone();
        needles.extend(shared.iter().cloned());
        let snippet = make_snippet(&row.body, &needles, 160);
        hits.push(KbSearchHit {
            event_id: row.event_id,
            source_id: row.source_id,
            source_kind: row.source_kind,
            ref_id: row.ref_id,
            title: row.title,
            icon: row.icon,
            root_name: row.root_name,
            block_id: row.block_id,
            line_start: row.line_start,
            heading_path: row.heading_path,
            snippet,
            match_kind: "direct".to_string(),
            shared_entities: shared,
            score,
            event_time: row.event_time,
        });
    }

    let mut hyper_vec: Vec<(EventRow, f64, Vec<(String, f64)>)> = hyper_candidates
        .into_values()
        .filter(|(r, _, _)| !direct_used_ids.contains(&r.event_id))
        .map(|(r, base_s, mut ents)| {
            let shared_bonus = 1.0 + 0.35 * (ents.len().saturating_sub(1).min(4) as f64);
            ents.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            (r, base_s * shared_bonus, ents)
        })
        .collect();
    hyper_vec.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.event_time.cmp(&a.0.event_time))
    });

    let mut hyper_seen_sources: HashSet<String> = HashSet::new();
    for (row, score, ents) in hyper_vec {
        if hits.len() >= limit {
            break;
        }
        if !hyper_seen_sources.insert(row.source_id.clone()) {
            continue;
        }
        let shared_names: Vec<String> = ents.into_iter().take(3).map(|(n, _)| n).collect();
        let mut needles = shared_names.clone();
        needles.extend(base_needles.iter().cloned());
        let snippet = make_snippet(&row.body, &needles, 160);
        hits.push(KbSearchHit {
            event_id: row.event_id,
            source_id: row.source_id,
            source_kind: row.source_kind,
            ref_id: row.ref_id,
            title: row.title,
            icon: row.icon,
            root_name: row.root_name,
            block_id: row.block_id,
            line_start: row.line_start,
            heading_path: row.heading_path,
            snippet,
            match_kind: "hyperedge".to_string(),
            shared_entities: shared_names,
            score,
            event_time: row.event_time,
        });
    }

    Ok(KbSearchResponse {
        query: trimmed.to_string(),
        total_sources,
        total_events,
        elapsed_ms: t0.elapsed().as_millis() as u64,
        hits,
        top_entities,
    })
}

fn direct_map_contains(list: &[(EventRow, f64)], event_id: &str) -> bool {
    list.iter().any(|(r, _)| r.event_id == event_id)
}

/// 写作侧栏「关联知识推荐」：根据当前笔记标题与正文即时构造动态超边，推荐跨文档相关片段
pub fn related_for_context(
    conn: &Connection,
    source_kind: &str,
    ref_id: &str,
    title: &str,
    content_text: &str,
    limit: usize,
) -> Result<KbRelatedResponse, AppError> {
    let t0 = Instant::now();
    let (total_sources, total_events) = read_kb_totals(conn)?;
    if total_events == 0 {
        return Ok(KbRelatedResponse {
            context_entities: Vec::new(),
            hits: Vec::new(),
            elapsed_ms: t0.elapsed().as_millis() as u64,
        });
    }

    let current_source_id = if source_kind == "workspace_page" {
        format!("page:{}", ref_id)
    } else {
        format!("file:{}", normalize_path_key(Path::new(&normalize_win32_path_str(ref_id))))
    };

    let extracted = extract_entities(title, "", content_text, content_text, &[]);
    let max_df = noise_df_limit(total_sources);

    let mut matched_entities: Vec<(i64, String, String, i64, f64)> = Vec::new();
    let mut context_entities: Vec<KbEntitySummary> = Vec::new();

    for ent in &extracted {
        let found: Option<(i64, String, String, i64)> = conn
            .query_row(
                "SELECT entity_id, display_name, entity_type, doc_freq
                 FROM kb_entities
                 WHERE norm_name = ?1",
                params![&ent.norm_name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((eid, dname, etype, df)) = found {
            if df > 0 {
                let rank_w = ent.weight * idf(df, total_sources);
                matched_entities.push((eid, dname.clone(), etype.clone(), df, rank_w));
                context_entities.push(KbEntitySummary {
                    name: dname,
                    entity_type: etype,
                    doc_freq: df,
                });
            }
        }
    }

    context_entities.truncate(10);

    let mut candidates: HashMap<String, (EventRow, f64, Vec<(String, f64)>)> = HashMap::new();
    let mut seed_sources = HashSet::new();
    seed_sources.insert(current_source_id.clone());
    let linked_sources = find_linked_source_ids(conn, &seed_sources);

    let usable_eids: Vec<i64> = matched_entities
        .iter()
        .filter(|(_, _, _, df, _)| *df <= max_df)
        .take(30)
        .map(|(eid, _, _, _, _)| *eid)
        .collect();

    let weight_map: HashMap<i64, (String, f64)> = matched_entities
        .iter()
        .map(|(eid, dname, _, _, w)| (*eid, (dname.clone(), *w)))
        .collect();

    if !usable_eids.is_empty() {
        if let Ok(json_eids) = serde_json::to_string(&usable_eids) {
            let mut stmt = conn.prepare(
                "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                        e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                        ent.entity_id, ee.weight
                 FROM kb_event_entities ee
                 JOIN kb_entities ent ON ent.entity_id = ee.entity_id
                 JOIN kb_events e ON e.event_id = ee.event_id
                 JOIN kb_sources s ON s.source_id = e.source_id
                 WHERE ee.entity_id IN (SELECT value FROM json_each(?1))
                   AND e.source_id != ?2",
            )?;
            let rows = stmt
                .query_map(params![json_eids, &current_source_id], |r| {
                    Ok((
                        EventRow {
                            event_id: r.get(0)?,
                            source_id: r.get(1)?,
                            source_kind: r.get(2)?,
                            ref_id: r.get(3)?,
                            title: r.get(4)?,
                            icon: r.get(5)?,
                            root_name: r.get(6)?,
                            block_id: r.get(7)?,
                            line_start: r.get(8)?,
                            heading_path: r.get(9)?,
                            body: r.get(10)?,
                            event_time: r.get(11)?,
                        },
                        r.get::<_, i64>(12)?,
                        r.get::<_, f64>(13)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            for (row, eid, cand_w) in rows {
                let Some((dname, seed_w)) = weight_map.get(&eid) else {
                    continue;
                };
                let contrib = seed_w * cand_w;
                let entry = candidates
                    .entry(row.event_id.clone())
                    .or_insert_with(|| (row, 0.0, Vec::new()));
                entry.1 += contrib;
                if !entry.2.iter().any(|(n, _)| n == dname) {
                    entry.2.push((dname.clone(), contrib));
                }
            }
        }
    }

    let mut ranked: Vec<(EventRow, f64, Vec<(String, f64)>)> = candidates
        .into_values()
        .map(|(row, base_s, mut ents)| {
            let mut s = base_s * (1.0 + 0.35 * (ents.len().saturating_sub(1).min(4) as f64));
            if linked_sources.contains(&row.source_id) {
                s += 1.5;
            }
            ents.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            (row, s, ents)
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.event_time.cmp(&a.0.event_time))
    });

    let mut hits = Vec::new();
    let mut seen_sources = HashSet::new();
    for (row, score, ents) in ranked {
        if hits.len() >= limit.clamp(1, 24) {
            break;
        }
        if !seen_sources.insert(row.source_id.clone()) {
            continue;
        }
        let shared_names: Vec<String> = ents.into_iter().take(3).map(|(n, _)| n).collect();
        let snippet = make_snippet(&row.body, &shared_names, 140);
        hits.push(KbSearchHit {
            event_id: row.event_id,
            source_id: row.source_id,
            source_kind: row.source_kind,
            ref_id: row.ref_id,
            title: row.title,
            icon: row.icon,
            root_name: row.root_name,
            block_id: row.block_id,
            line_start: row.line_start,
            heading_path: row.heading_path,
            snippet,
            match_kind: "hyperedge".to_string(),
            shared_entities: shared_names,
            score,
            event_time: row.event_time,
        });
    }

    Ok(KbRelatedResponse {
        context_entities,
        hits,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

/// 按时间线追踪某个概念/实体在工作区页面与挂载文件夹中的全部提及记录
pub fn entity_events(
    conn: &Connection,
    entity_name: &str,
    limit: usize,
) -> Result<Vec<KbSearchHit>, AppError> {
    let norm = entity_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if norm.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                ent.display_name, ee.weight
         FROM kb_entities ent
         JOIN kb_event_entities ee ON ee.entity_id = ent.entity_id
         JOIN kb_events e ON e.event_id = ee.event_id
         JOIN kb_sources s ON s.source_id = e.source_id
         WHERE ent.norm_name = ?1
         ORDER BY e.event_time DESC, ee.weight DESC
         LIMIT ?2",
    )?;
    let mut rows = stmt
        .query_map(params![&norm, limit.clamp(1, 50) as i64], |r| {
            let body: String = r.get(10)?;
            let dname: String = r.get(12)?;
            let weight: f64 = r.get(13)?;
            Ok(KbSearchHit {
                event_id: r.get(0)?,
                source_id: r.get(1)?,
                source_kind: r.get(2)?,
                ref_id: r.get(3)?,
                title: r.get(4)?,
                icon: r.get(5)?,
                root_name: r.get(6)?,
                block_id: r.get(7)?,
                line_start: r.get(8)?,
                heading_path: r.get(9)?,
                snippet: make_snippet(&body, std::slice::from_ref(&dname), 160),
                match_kind: "hyperedge".to_string(),
                shared_entities: vec![dname],
                score: weight,
                event_time: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if rows.is_empty() && norm.chars().count() >= 2 {
        let mut p_stmt = conn.prepare(
            "SELECT e.event_id, e.source_id, s.kind, s.ref_id, s.title, s.icon, s.root_name,
                    e.block_id, e.line_start, e.heading_path, e.body, e.event_time,
                    ent.display_name, ee.weight
             FROM kb_entities ent
             JOIN kb_event_entities ee ON ee.entity_id = ent.entity_id
             JOIN kb_events e ON e.event_id = ee.event_id
             JOIN kb_sources s ON s.source_id = e.source_id
             WHERE ent.norm_name LIKE ?1 || '%'
             ORDER BY e.event_time DESC, ee.weight DESC
             LIMIT ?2",
        )?;
        rows = p_stmt
            .query_map(params![&norm, limit.clamp(1, 50) as i64], |r| {
                let body: String = r.get(10)?;
                let dname: String = r.get(12)?;
                let weight: f64 = r.get(13)?;
                Ok(KbSearchHit {
                    event_id: r.get(0)?,
                    source_id: r.get(1)?,
                    source_kind: r.get(2)?,
                    ref_id: r.get(3)?,
                    title: r.get(4)?,
                    icon: r.get(5)?,
                    root_name: r.get(6)?,
                    block_id: r.get(7)?,
                    line_start: r.get(8)?,
                    heading_path: r.get(9)?,
                    snippet: make_snippet(&body, std::slice::from_ref(&dname), 160),
                    match_kind: "hyperedge".to_string(),
                    shared_entities: vec![dname],
                    score: weight,
                    event_time: r.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    Ok(rows)
}
