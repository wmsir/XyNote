//! 永久版导出：HTML（单文件，图片内嵌）、Word（.docx）以及打印成 PDF 用的 HTML。
//!
//! 以页面的 Markdown 导出为基础（文档页与表格页都覆盖），再转换成目标格式。

use crate::models::AppError;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::io::Write;

fn md_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/* ---------------- 图片 ---------------- */

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn mime_of(bytes: &[u8], hint: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(b"\xFF\xD8") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if hint.to_lowercase().ends_with(".svg") || bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") {
        Some("image/svg+xml")
    } else {
        None
    }
}

/// 读取图片：data URL 或本机文件；网络图片返回 None
pub fn load_image(src: &str) -> Option<(&'static str, Vec<u8>)> {
    let src = src.trim();
    if let Some(rest) = src.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let bytes = if meta.ends_with(";base64") {
            B64.decode(data.trim()).ok()?
        } else {
            data.as_bytes().to_vec()
        };
        let mime = mime_of(&bytes, meta)?;
        return Some((mime, bytes));
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        return None;
    }
    let path = src.strip_prefix("file:///").or_else(|| src.strip_prefix("file://")).unwrap_or(src);
    let path = path.replace("%20", " ");
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() as usize > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mime = mime_of(&bytes, &path)?;
    Some((mime, bytes))
}

/// 把 Markdown 里 `![说明](地址)` 的本机图片换成 data URL，导出的 HTML 单文件即可显示
fn inline_markdown_images(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(start) = rest.find("![") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let replaced = (|| {
            let close = tail.find("](")?;
            let url_start = close + 2;
            let url_end = url_start + tail[url_start..].find(')')?;
            let url = &tail[url_start..url_end];
            if url.starts_with("data:") || url.starts_with("http") || url.contains('\n') {
                return None;
            }
            let (mime, bytes) = load_image(url)?;
            Some((format!("{}](data:{};base64,{})", &tail[..close], mime, B64.encode(bytes)), url_end + 1))
        })();
        match replaced {
            Some((text, consumed)) => {
                out.push_str(&text);
                rest = &tail[consumed..];
            }
            None => {
                out.push_str("![");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/* ---------------- HTML ---------------- */

const HTML_STYLE: &str = r#"
  :root { color-scheme: light; }
  body { margin: 0; background: #fff; color: #1f2328; font: 16px/1.75 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 28px 80px; }
  h1 { font-size: 2em; line-height: 1.25; margin: 0 0 .6em; }
  h2 { font-size: 1.5em; margin: 1.6em 0 .5em; }
  h3 { font-size: 1.2em; margin: 1.4em 0 .4em; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #2383e2; }
  img { max-width: 100%; border-radius: 6px; }
  blockquote { margin-left: 0; padding: 2px 16px; border-left: 3px solid #d0d7de; color: #57606a; }
  code { font-family: "JetBrains Mono", Consolas, Menlo, monospace; font-size: .88em; background: #f3f4f6; padding: 2px 5px; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
  li > input[type=checkbox] { margin-right: 6px; }
  footer { margin-top: 48px; color: #8c959f; font-size: 12px; }
  @media print { main { padding: 0; } a { color: inherit; } footer { display: none; } }
"#;

/// 完整的 HTML 文档
pub fn markdown_to_html_document(title: &str, markdown: &str) -> String {
    let md = inline_markdown_images(markdown);
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, Parser::new_ext(&md, md_options()));
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{}</title>\n<style>{}</style>\n</head>\n<body>\n<main>\n{}</main>\n<footer>由小悦笔记导出 · fwpt.cn</footer>\n</body>\n</html>\n",
        html_escape(title),
        HTML_STYLE,
        body
    )
}

/* ---------------- Word（.docx） ---------------- */

fn xml_escape(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(c, '\t' | '\n'))
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 图片像素尺寸（PNG / JPEG / GIF）
fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG") && bytes.len() > 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if bytes.starts_with(b"GIF8") && bytes.len() > 10 {
        return Some((u16::from_le_bytes([bytes[6], bytes[7]]) as u32, u16::from_le_bytes([bytes[8], bytes[9]]) as u32));
    }
    if bytes.starts_with(b"\xFF\xD8") {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    }
    None
}

#[derive(Default, Clone)]
struct RunStyle {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: bool,
}

struct ListCtx {
    ordered: bool,
    next: u64,
}

#[derive(Default)]
struct DocxBuilder {
    body: String,
    runs: String,
    style: RunStyle,
    para_style: Option<&'static str>,
    lists: Vec<ListCtx>,
    item_prefix: Option<String>,
    quote: usize,
    code_block: Option<String>,
    in_table: bool,
    table_rows: Vec<(bool, Vec<String>)>,
    cell_runs: Option<String>,
    in_head: bool,
    rels: Vec<(String, String, bool)>, // (id, target, external)
    media: Vec<(String, Vec<u8>)>,     // (word/media/name, bytes)
    link_rel: Option<String>,
    image_alt: Option<String>,
    image_url: Option<String>,
    image_count: usize,
}

impl DocxBuilder {
    fn run_xml(&self, text: &str) -> String {
        let s = &self.style;
        let mut props = String::new();
        if s.bold {
            props.push_str("<w:b/>");
        }
        if s.italic {
            props.push_str("<w:i/>");
        }
        if s.strike {
            props.push_str("<w:strike/>");
        }
        if s.code {
            props.push_str(r#"<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>"#);
        }
        if s.link {
            props.push_str(r#"<w:color w:val="2383E2"/><w:u w:val="single"/>"#);
        }
        let rpr = if props.is_empty() { String::new() } else { format!("<w:rPr>{}</w:rPr>", props) };
        format!(r#"<w:r>{}<w:t xml:space="preserve">{}</w:t></w:r>"#, rpr, xml_escape(text))
    }

    fn target(&mut self) -> &mut String {
        if let Some(c) = self.cell_runs.as_mut() {
            c
        } else {
            &mut self.runs
        }
    }

    fn text(&mut self, t: &str) {
        if let Some(cb) = self.code_block.as_mut() {
            cb.push_str(t);
            return;
        }
        if self.image_alt.is_some() {
            self.image_alt.as_mut().unwrap().push_str(t);
            return;
        }
        let mut xml = self.run_xml(t);
        if let Some(rel) = &self.link_rel {
            xml = format!(r#"<w:hyperlink r:id="{}">{}</w:hyperlink>"#, rel, xml);
        }
        self.target().push_str(&xml);
    }

    fn raw_run(&mut self, xml: &str) {
        self.target().push_str(xml);
    }

    fn flush_para(&mut self) {
        let mut runs = std::mem::take(&mut self.runs);
        if let Some(prefix) = self.item_prefix.take() {
            runs = format!(r#"<w:r><w:t xml:space="preserve">{}</w:t></w:r>{}"#, xml_escape(&prefix), runs);
        }
        if runs.is_empty() && self.para_style.is_none() {
            return;
        }
        let mut ppr = String::new();
        let style = if self.quote > 0 && self.para_style.is_none() { Some("Quote") } else { self.para_style };
        if let Some(st) = style {
            ppr.push_str(&format!(r#"<w:pStyle w:val="{}"/>"#, st));
        }
        if !self.lists.is_empty() {
            ppr.push_str(&format!(r#"<w:ind w:left="{}" w:hanging="300"/>"#, 360 * self.lists.len() + 60));
        }
        let ppr = if ppr.is_empty() { String::new() } else { format!("<w:pPr>{}</w:pPr>", ppr) };
        self.body.push_str(&format!("<w:p>{}{}</w:p>", ppr, runs));
        self.para_style = None;
    }

    fn add_rel(&mut self, target: String, external: bool) -> String {
        let id = format!("rId{}", 10 + self.rels.len());
        self.rels.push((id.clone(), target, external));
        id
    }

    fn image(&mut self, url: &str, alt: &str) {
        let loaded = load_image(url).filter(|(m, _)| matches!(*m, "image/png" | "image/jpeg" | "image/gif"));
        let Some((mime, bytes)) = loaded else {
            let label = if alt.trim().is_empty() { "图片".to_string() } else { alt.trim().to_string() };
            let saved = std::mem::replace(&mut self.style, RunStyle { link: true, ..Default::default() });
            let xml = self.run_xml(&format!("[{}] {}", label, if url.starts_with("data:") { "" } else { url }));
            self.style = saved;
            self.raw_run(&xml);
            return;
        };
        let (w, h) = image_size(&bytes).unwrap_or((600, 400));
        // 最宽 6 英寸
        let max_emu: u64 = 5_486_400;
        let mut cx = w as u64 * 9525;
        let mut cy = h as u64 * 9525;
        if cx > max_emu {
            cy = cy * max_emu / cx.max(1);
            cx = max_emu;
        }
        self.image_count += 1;
        let n = self.image_count;
        let ext = match mime {
            "image/png" => "png",
            "image/gif" => "gif",
            _ => "jpeg",
        };
        let name = format!("image{}.{}", n, ext);
        self.media.push((format!("word/media/{}", name), bytes));
        let rid = self.add_rel(format!("media/{}", name), false);
        let xml = format!(
            r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{n}" name="图片 {n}" descr="{alt}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{n}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
            cx = cx,
            cy = cy,
            n = n,
            alt = xml_escape(alt),
            name = name,
            rid = rid
        );
        self.raw_run(&xml);
    }

    fn flush_table(&mut self) {
        let rows = std::mem::take(&mut self.table_rows);
        let cols = rows.iter().map(|(_, c)| c.len()).max().unwrap_or(1).max(1);
        let width = 9000 / cols;
        let mut xml = String::from(
            r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders></w:tblPr><w:tblGrid>"#,
        );
        for _ in 0..cols {
            xml.push_str(&format!(r#"<w:gridCol w:w="{}"/>"#, width));
        }
        xml.push_str("</w:tblGrid>");
        for (head, cells) in rows {
            xml.push_str("<w:tr>");
            for i in 0..cols {
                let runs = cells.get(i).cloned().unwrap_or_default();
                let shade = if head { r#"<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>"# } else { "" };
                xml.push_str(&format!(
                    r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/>{}</w:tcPr><w:p>{}</w:p></w:tc>"#,
                    width, shade, runs
                ));
            }
            xml.push_str("</w:tr>");
        }
        xml.push_str("</w:tbl><w:p/>");
        self.body.push_str(&xml);
    }

    fn feed(&mut self, ev: Event<'_>) {
        match ev {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => self.flush_para(),
            Event::Start(Tag::Heading { level, .. }) => {
                self.flush_para();
                self.para_style = Some(match level {
                    HeadingLevel::H1 => "Heading1",
                    HeadingLevel::H2 => "Heading2",
                    _ => "Heading3",
                });
            }
            Event::End(TagEnd::Heading { .. }) => self.flush_para(),
            Event::Start(Tag::BlockQuote { .. }) => {
                self.flush_para();
                self.quote += 1;
            }
            Event::End(TagEnd::BlockQuote { .. }) => {
                self.flush_para();
                self.quote = self.quote.saturating_sub(1);
            }
            Event::Start(Tag::CodeBlock { .. }) => {
                self.flush_para();
                self.code_block = Some(String::new());
            }
            Event::End(TagEnd::CodeBlock) => {
                let code = self.code_block.take().unwrap_or_default();
                for line in code.trim_end_matches('\n').split('\n') {
                    self.body.push_str(&format!(
                        r#"<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                        xml_escape(line)
                    ));
                }
                // 代码块后留一行间距
                self.body.push_str(r#"<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>"#);
            }
            Event::Start(Tag::List(start)) => {
                self.flush_para();
                self.lists.push(ListCtx { ordered: start.is_some(), next: start.unwrap_or(1) });
            }
            Event::End(TagEnd::List { .. }) => {
                self.flush_para();
                self.lists.pop();
            }
            Event::Start(Tag::Item) => {
                self.flush_para();
                if let Some(l) = self.lists.last_mut() {
                    self.item_prefix = Some(if l.ordered {
                        let p = format!("{}. ", l.next);
                        l.next += 1;
                        p
                    } else {
                        "• ".to_string()
                    });
                }
            }
            Event::End(TagEnd::Item) => self.flush_para(),
            Event::TaskListMarker(done) => {
                self.item_prefix = Some(if done { "☑ ".into() } else { "☐ ".into() });
            }
            Event::Start(Tag::Table { .. }) => {
                self.flush_para();
                self.in_table = true;
            }
            Event::End(TagEnd::Table) => {
                self.in_table = false;
                self.flush_table();
            }
            Event::Start(Tag::TableHead) => {
                self.in_head = true;
                self.table_rows.push((true, Vec::new()));
            }
            Event::End(TagEnd::TableHead) => self.in_head = false,
            Event::Start(Tag::TableRow) => self.table_rows.push((false, Vec::new())),
            Event::Start(Tag::TableCell) => {
                self.cell_runs = Some(String::new());
                if self.in_head {
                    self.style.bold = true;
                }
            }
            Event::End(TagEnd::TableCell) => {
                let runs = self.cell_runs.take().unwrap_or_default();
                if self.in_head {
                    self.style.bold = false;
                }
                if let Some((_, cells)) = self.table_rows.last_mut() {
                    cells.push(runs);
                }
            }
            Event::Start(Tag::Emphasis) => self.style.italic = true,
            Event::End(TagEnd::Emphasis) => self.style.italic = false,
            Event::Start(Tag::Strong) => self.style.bold = true,
            Event::End(TagEnd::Strong) => self.style.bold = false,
            Event::Start(Tag::Strikethrough) => self.style.strike = true,
            Event::End(TagEnd::Strikethrough) => self.style.strike = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                let url = dest_url.to_string();
                if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
                    self.link_rel = Some(self.add_rel(xml_escape(&url), true));
                }
                self.style.link = true;
            }
            Event::End(TagEnd::Link) => {
                self.link_rel = None;
                self.style.link = false;
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                self.image_alt = Some(String::new());
                self.image_url = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Image) => {
                let alt = self.image_alt.take().unwrap_or_default();
                let url = self.image_url.take().unwrap_or_default();
                self.image(&url, &alt);
            }
            Event::Text(t) => self.text(&t),
            Event::Code(t) => {
                let saved = self.style.code;
                self.style.code = true;
                self.text(&t);
                self.style.code = saved;
            }
            Event::Html(t) | Event::InlineHtml(t) => {
                let plain = strip_tags(&t);
                if !plain.trim().is_empty() {
                    self.text(plain.trim());
                    if t.contains("</summary>") || t.contains("</details>") {
                        self.flush_para();
                    }
                }
            }
            Event::SoftBreak => self.text(" "),
            Event::HardBreak => self.raw_run("<w:r><w:br/></w:r>"),
            Event::Rule => {
                self.flush_para();
                self.body.push_str(r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D7DE"/></w:pBdr></w:pPr></w:p>"#);
            }
            _ => {}
        }
    }
}

const DOCX_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="57606A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>"#;

/// Markdown 转 Word 文档字节
pub fn markdown_to_docx(title: &str, markdown: &str) -> Result<Vec<u8>, AppError> {
    let mut b = DocxBuilder::default();
    // 跳过导出 Markdown 的第一行标题，改用 Word 标题样式
    let mut lines = markdown.lines();
    let first = lines.next().unwrap_or_default();
    let body_md: String = if first.starts_with("# ") { lines.collect::<Vec<_>>().join("\n") } else { markdown.to_string() };
    b.body.push_str(&format!(
        r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        xml_escape(if first.starts_with("# ") { first.trim_start_matches("# ").trim() } else { title })
    ));
    for ev in Parser::new_ext(&body_md, md_options()) {
        b.feed(ev);
    }
    b.flush_para();

    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>{}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        b.body
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
    );
    for (id, target, external) in &b.rels {
        if *external {
            rels.push_str(&format!(
                r#"<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{}" TargetMode="External"/>"#,
                id, target
            ));
        } else {
            rels.push_str(&format!(
                r#"<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{}"/>"#,
                id, target
            ));
        }
    }
    rels.push_str("</Relationships>");
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let core = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{}</dc:title><dc:creator>小悦笔记</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{}</dcterms:modified></cp:coreProperties>"#,
        xml_escape(title),
        now,
        now
    );

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, data: &[u8]| -> Result<(), AppError> {
            zip.start_file(name, opts).map_err(|e| AppError::Validation(e.to_string()))?;
            zip.write_all(data)?;
            Ok(())
        };
        put("[Content_Types].xml", content_types.as_bytes())?;
        put("_rels/.rels", root_rels.as_bytes())?;
        put("docProps/core.xml", core.as_bytes())?;
        put("word/document.xml", document.as_bytes())?;
        put("word/styles.xml", DOCX_STYLES.as_bytes())?;
        put("word/_rels/document.xml.rels", rels.as_bytes())?;
        for (name, bytes) in &b.media {
            put(name, bytes)?;
        }
        zip.finish().map_err(|e| AppError::Validation(e.to_string()))?;
    }
    Ok(buf.into_inner())
}

/// 导出用的文件名（不含扩展名）
pub fn base_filename(md_filename: &str) -> String {
    md_filename.trim_end_matches(".md").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const SAMPLE: &str = "# 📝 周报 & 计划\n\n## 本周\n\n- [x] 完成 **发布**\n- [ ] 写 *文档*\n\n1. 第一\n2. 第二\n\n> 引用一段\n\n```rust\nfn main() {}\n```\n\n| 事项 | 状态 |\n| --- | --- |\n| 官网 | 进行中 |\n\n[官网](https://fwpt.cn) 与 `code`\n\n![示意图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)\n\n---\n";

    #[test]
    fn html_document_is_complete() {
        let html = markdown_to_html_document("周报 <测试>", SAMPLE);
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<title>周报 &lt;测试&gt;</title>"));
        assert!(html.contains("<h2>本周</h2>"));
        assert!(html.contains("<table>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("data:image/png;base64"));
    }

    #[test]
    fn local_images_are_inlined() {
        let dir = std::env::temp_dir().join(format!("xynote-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = B64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").unwrap();
        let path = dir.join("a.png");
        std::fs::write(&path, &png).unwrap();
        let md = format!("前 ![图]({}) 后 ![网络](https://x.cn/a.png)", path.display());
        let out = inline_markdown_images(&md);
        assert!(out.contains("](data:image/png;base64,"));
        assert!(out.contains("](https://x.cn/a.png)"));
        assert!(out.starts_with("前 ") && out.contains(" 后 "));
    }

    #[test]
    fn docx_is_a_valid_package() {
        let bytes = markdown_to_docx("周报", SAMPLE).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        for name in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels", "word/media/image1.png"] {
            assert!(zip.by_name(name).is_ok(), "缺少 {}", name);
        }
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("📝 周报 &amp; 计划"));
        assert!(doc.contains(r#"w:val="Heading2""#));
        assert!(doc.contains("☑ ") && doc.contains("☐ "));
        assert!(doc.contains("1. ") && doc.contains("2. "));
        assert!(doc.contains(r#"w:val="Quote""#) && doc.contains(r#"w:val="Code""#));
        assert!(doc.contains("<w:tbl>") && doc.contains("进行中"));
        assert!(doc.contains("<w:hyperlink"));
        assert!(doc.contains("<w:drawing>"));
        let mut rels = String::new();
        zip.by_name("word/_rels/document.xml.rels").unwrap().read_to_string(&mut rels).unwrap();
        assert!(rels.contains("https://fwpt.cn") && rels.contains("media/image1.png"));
        // 每个 w:p 都闭合（粗略检查 XML 结构）
        assert_eq!(doc.matches("<w:p>").count() + doc.matches("<w:p/>").count(), doc.matches("</w:p>").count() + doc.matches("<w:p/>").count());
    }

    /// 设置 XYNOTE_EXPORT_SAMPLE_DIR 时把示例导出写到磁盘，便于用 Word / 浏览器实际打开检查
    #[test]
    fn writes_samples_when_requested() {
        let Ok(dir) = std::env::var("XYNOTE_EXPORT_SAMPLE_DIR") else { return };
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{}/sample.docx", dir), markdown_to_docx("周报", SAMPLE).unwrap()).unwrap();
        std::fs::write(format!("{}/sample.html", dir), markdown_to_html_document("周报", SAMPLE)).unwrap();
    }

    #[test]
    fn image_sizes() {
        let png = B64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").unwrap();
        assert_eq!(image_size(&png), Some((1, 1)));
        assert_eq!(image_size(b"GIF89a\x10\x00\x20\x00\x00"), Some((16, 32)));
    }
}
