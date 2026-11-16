//! 更多导出格式：EPUB 电子书、LaTeX、OPML 大纲。
//!
//! 和 HTML / Word 一样以页面的 Markdown 为基础转换。图片导出（PNG）在前端渲染，
//! 这里只负责保存文件。

use crate::export_formats::load_image;
use crate::models::AppError;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::io::Write;

/// 导出结果：主文件 + 附带的文件（相对主文件所在目录的路径）
pub struct ExportBundle {
    pub bytes: Vec<u8>,
    pub extra_files: Vec<(String, Vec<u8>)>,
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_MATH
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 不允许的控制字符
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn ext_of_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

/// 表情、装饰符号在 LaTeX / 部分阅读器里无法显示，去掉
fn strip_emoji(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let u = *c as u32;
            !((0x1F000..=0x1FAFF).contains(&u) || (0x2600..=0x27BF).contains(&u) || (0xFE00..=0xFE0F).contains(&u) || u == 0x200D)
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 页面导出的 Markdown 通常以「# 图标 标题」开头；去掉这一行，标题另外处理
fn split_title(markdown: &str) -> &str {
    let trimmed = markdown.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        return rest.split_once('\n').map(|(_, body)| body).unwrap_or("");
    }
    markdown
}

/// 收集正文里的图片：返回（原地址 → 导出后的相对路径）以及图片文件
fn collect_images(markdown: &str, dir: &str) -> (Vec<(String, String)>, Vec<(String, Vec<u8>, &'static str)>) {
    let mut map = Vec::new();
    let mut files = Vec::new();
    for ev in Parser::new_ext(markdown, options()) {
        if let Event::Start(Tag::Image { dest_url, .. }) = ev {
            let url = dest_url.to_string();
            if map.iter().any(|(u, _): &(String, String)| u == &url) {
                continue;
            }
            if let Some((mime, bytes)) = load_image(&url) {
                let name = format!("{}/image{}.{}", dir, files.len() + 1, ext_of_mime(mime));
                map.push((url, name.clone()));
                files.push((name, bytes, mime));
            }
        }
    }
    (map, files)
}

/* ───────────────────────── EPUB ───────────────────────── */

const EPUB_CSS: &str = "body{font-family:serif;line-height:1.7;margin:0 5%;}h1,h2,h3{font-family:sans-serif;line-height:1.3;}\
h1{font-size:1.6em;}h2{font-size:1.3em;}h3{font-size:1.1em;}img{max-width:100%;}\
pre{white-space:pre-wrap;background:#f4f4f4;padding:.6em;font-size:.85em;}code{font-family:monospace;}\
blockquote{margin-left:0;padding-left:1em;border-left:3px solid #ccc;color:#555;}\
table{border-collapse:collapse;}th,td{border:1px solid #bbb;padding:.2em .5em;}";

pub fn markdown_to_epub(title: &str, markdown: &str) -> Result<Vec<u8>, AppError> {
    let title = { let t = strip_emoji(title); if t.is_empty() { "小悦笔记".to_string() } else { t } };
    let body_md = split_title(markdown);
    let (img_map, images) = collect_images(body_md, "images");

    // 正文：标题加 id 供目录跳转；HTML 片段只保留文字，保证 XHTML 合法
    let mut toc: Vec<(u8, String, String)> = Vec::new();
    let mut heading_text: Option<String> = None;
    let mut heading_idx = 0usize;
    let mut events: Vec<Event> = Vec::new();
    // 每张图片是否换成了说明文字（网络图片）
    let mut img_stack: Vec<bool> = Vec::new();
    for ev in Parser::new_ext(body_md, options()) {
        match ev {
            Event::Start(Tag::Heading { level, classes, attrs, .. }) => {
                heading_idx += 1;
                heading_text = Some(String::new());
                events.push(Event::Start(Tag::Heading { level, id: Some(CowStr::from(format!("h{}", heading_idx))), classes, attrs }));
            }
            Event::End(TagEnd::Heading(level)) => {
                let text = heading_text.take().unwrap_or_default();
                let lv = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    _ => 3,
                };
                if !text.trim().is_empty() {
                    toc.push((lv, format!("h{}", heading_idx), text.trim().to_string()));
                }
                events.push(Event::End(TagEnd::Heading(level)));
            }
            Event::Start(Tag::Image { link_type, dest_url, title: t, id }) => {
                let url = img_map.iter().find(|(u, _)| u == dest_url.as_ref()).map(|(_, p)| p.clone());
                match url {
                    Some(p) => {
                        img_stack.push(false);
                        events.push(Event::Start(Tag::Image { link_type, dest_url: CowStr::from(p), title: t, id }))
                    }
                    // 网络图片：电子书里不引用外部资源，只留下说明文字
                    None => {
                        img_stack.push(true);
                        events.push(Event::Start(Tag::Emphasis))
                    }
                }
            }
            Event::End(TagEnd::Image) => {
                // 和上面的 Start 对应：有本地文件时是 Image，否则是 Emphasis
                if img_stack.pop().unwrap_or(false) {
                    events.push(Event::End(TagEnd::Emphasis));
                } else {
                    events.push(Event::End(TagEnd::Image));
                }
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                let text = strip_tags(&h);
                if !text.trim().is_empty() {
                    events.push(Event::Text(CowStr::from(text)));
                }
            }
            Event::InlineMath(m) => events.push(Event::Code(m)),
            Event::DisplayMath(m) => events.push(Event::Code(m)),
            Event::Text(t) => {
                if let Some(h) = heading_text.as_mut() {
                    h.push_str(&t);
                }
                events.push(Event::Text(t));
            }
            other => events.push(other),
        }
    }
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, events.into_iter());

    let uid = format!("urn:uuid:{}", uuid::Uuid::new_v4());
    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let esc_title = xml_escape(&title);

    let chapter = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"zh-CN\" xml:lang=\"zh-CN\">\n<head><meta charset=\"utf-8\"/><title>{t}</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head>\n<body>\n<h1>{t}</h1>\n{b}</body>\n</html>\n",
        t = esc_title,
        b = body
    );
    let mut nav_items = String::new();
    for (lv, id, text) in &toc {
        nav_items.push_str(&format!(
            "<li class=\"l{}\"><a href=\"chapter.xhtml#{}\">{}</a></li>\n",
            lv,
            id,
            xml_escape(&strip_emoji(text))
        ));
    }
    if nav_items.is_empty() {
        nav_items = format!("<li><a href=\"chapter.xhtml\">{}</a></li>\n", esc_title);
    }
    let nav = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"zh-CN\" xml:lang=\"zh-CN\">\n<head><meta charset=\"utf-8\"/><title>目录</title></head>\n<body>\n<nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1>\n<ol>\n{}</ol></nav>\n</body>\n</html>\n",
        nav_items
    );
    let mut manifest_imgs = String::new();
    for (i, (name, _, mime)) in images.iter().enumerate() {
        manifest_imgs.push_str(&format!("<item id=\"img{}\" href=\"{}\" media-type=\"{}\"/>\n", i + 1, name, mime));
    }
    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\" xml:lang=\"zh-CN\">\n<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n<dc:identifier id=\"bookid\">{uid}</dc:identifier>\n<dc:title>{t}</dc:title>\n<dc:language>zh-CN</dc:language>\n<dc:creator>小悦笔记</dc:creator>\n<meta property=\"dcterms:modified\">{m}</meta>\n</metadata>\n<manifest>\n<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"chapter\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n{imgs}</manifest>\n<spine>\n<itemref idref=\"chapter\"/>\n</spine>\n</package>\n",
        uid = uid,
        t = esc_title,
        m = modified,
        imgs = manifest_imgs
    );
    let container = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles>\n</container>\n";

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let err = |e: zip::result::ZipError| AppError::Validation(e.to_string());
        // EPUB 要求 mimetype 是第一个文件且不压缩
        zip.start_file("mimetype", stored).map_err(err)?;
        zip.write_all(b"application/epub+zip")?;
        zip.start_file("META-INF/container.xml", deflated).map_err(err)?;
        zip.write_all(container.as_bytes())?;
        zip.start_file("OEBPS/content.opf", deflated).map_err(err)?;
        zip.write_all(opf.as_bytes())?;
        zip.start_file("OEBPS/nav.xhtml", deflated).map_err(err)?;
        zip.write_all(nav.as_bytes())?;
        zip.start_file("OEBPS/chapter.xhtml", deflated).map_err(err)?;
        zip.write_all(chapter.as_bytes())?;
        zip.start_file("OEBPS/style.css", deflated).map_err(err)?;
        zip.write_all(EPUB_CSS.as_bytes())?;
        for (name, bytes, _) in &images {
            zip.start_file(format!("OEBPS/{}", name), stored).map_err(err)?;
            zip.write_all(bytes)?;
        }
        zip.finish().map_err(err)?;
    }
    Ok(buf.into_inner())
}

/* ───────────────────────── LaTeX ───────────────────────── */

fn tex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in strip_emoji_keep_spaces(s).chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            c => out.push(c),
        }
    }
    out
}

fn strip_emoji_keep_spaces(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let u = *c as u32;
            !((0x1F000..=0x1FAFF).contains(&u) || (0x2600..=0x27BF).contains(&u) || (0xFE00..=0xFE0F).contains(&u) || u == 0x200D)
        })
        .collect()
}

/// 生成 LaTeX 源文件（ctexart，用 XeLaTeX 编译）；本机图片另存到「<文件名>_images」文件夹
pub fn markdown_to_latex(title: &str, markdown: &str, image_dir: &str) -> ExportBundle {
    let body_md = split_title(markdown);
    let (img_map, images) = collect_images(body_md, image_dir);

    let mut out = String::new();
    let mut list_stack: Vec<bool> = Vec::new(); // true = 有序
    let mut table_cells: Vec<String> = Vec::new();
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut table_cols = 0usize;
    let mut in_table = false;
    let mut cell = String::new();
    let mut in_code = false;
    let mut link_stack: Vec<String> = Vec::new();
    let mut image_alt: Option<(Option<String>, String, String)> = None; // (本地路径, 原地址, 说明)

    let emit = |s: &str, out: &mut String, cell: &mut String, in_table: bool| {
        if in_table {
            cell.push_str(s);
        } else {
            out.push_str(s);
        }
    };

    for ev in Parser::new_ext(body_md, options()) {
        if let Some((_, _, alt)) = image_alt.as_mut() {
            match &ev {
                Event::Text(t) | Event::Code(t) => {
                    alt.push_str(t);
                    continue;
                }
                Event::End(TagEnd::Image) => {}
                _ => continue,
            }
        }
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                let cmd = match level {
                    HeadingLevel::H1 => "\\section*{",
                    HeadingLevel::H2 => "\\subsection*{",
                    HeadingLevel::H3 => "\\subsubsection*{",
                    _ => "\\paragraph*{",
                };
                out.push_str("\n");
                out.push_str(cmd);
            }
            Event::End(TagEnd::Heading(_)) => out.push_str("}\n\n"),
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                if !in_table {
                    out.push_str(if list_stack.is_empty() { "\n\n" } else { "\n" });
                }
            }
            Event::Start(Tag::Emphasis) => emit("\\emph{", &mut out, &mut cell, in_table),
            Event::End(TagEnd::Emphasis) => emit("}", &mut out, &mut cell, in_table),
            Event::Start(Tag::Strong) => emit("\\textbf{", &mut out, &mut cell, in_table),
            Event::End(TagEnd::Strong) => emit("}", &mut out, &mut cell, in_table),
            Event::Start(Tag::Strikethrough) => emit("\\sout{", &mut out, &mut cell, in_table),
            Event::End(TagEnd::Strikethrough) => emit("}", &mut out, &mut cell, in_table),
            Event::Start(Tag::BlockQuote { .. }) => out.push_str("\\begin{quote}\n"),
            Event::End(TagEnd::BlockQuote { .. }) => out.push_str("\\end{quote}\n\n"),
            Event::Start(Tag::List(start)) => {
                list_stack.push(start.is_some());
                out.push_str(if start.is_some() { "\\begin{enumerate}\n" } else { "\\begin{itemize}\n" });
            }
            Event::End(TagEnd::List(ordered)) => {
                list_stack.pop();
                out.push_str(if ordered { "\\end{enumerate}\n" } else { "\\end{itemize}\n" });
                if list_stack.is_empty() {
                    out.push('\n');
                }
            }
            Event::Start(Tag::Item) => out.push_str("  \\item "),
            Event::End(TagEnd::Item) => {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Event::TaskListMarker(done) => out.push_str(if done { "$\\boxtimes$ " } else { "$\\square$ " }),
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code = true;
                if let CodeBlockKind::Fenced(lang) = &kind {
                    if lang.as_ref() == "mermaid" {
                        out.push_str("% Mermaid 图表源码（LaTeX 无法直接绘制）\n");
                    }
                }
                out.push_str("\\begin{lstlisting}\n");
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("\\end{lstlisting}\n\n");
            }
            Event::Start(Tag::Table(aligns)) => {
                in_table = true;
                table_cols = aligns.len().max(1);
                table_rows.clear();
            }
            Event::End(TagEnd::Table) => {
                in_table = false;
                let spec = vec!["p{\\dimexpr\\linewidth/COLS-2\\tabcolsep\\relax}"; table_cols].join("|").replace("COLS", &table_cols.to_string());
                out.push_str(&format!("\\begin{{longtable}}{{|{}|}}\n\\hline\n", spec));
                for (i, row) in table_rows.iter().enumerate() {
                    let mut cells = row.clone();
                    cells.resize(table_cols, String::new());
                    let line = if i == 0 {
                        cells.iter().map(|c| format!("\\textbf{{{}}}", c)).collect::<Vec<_>>().join(" & ")
                    } else {
                        cells.join(" & ")
                    };
                    out.push_str(&line);
                    out.push_str(" \\\\\n\\hline\n");
                    if i == 0 {
                        out.push_str("\\endhead\n");
                    }
                }
                out.push_str("\\end{longtable}\n\n");
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => table_cells.clear(),
            Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => table_rows.push(std::mem::take(&mut table_cells)),
            Event::Start(Tag::TableCell) => cell.clear(),
            Event::End(TagEnd::TableCell) => table_cells.push(std::mem::take(&mut cell)),
            Event::Start(Tag::Link { dest_url, .. }) => {
                link_stack.push(dest_url.to_string());
                let url = dest_url.replace('%', "\\%").replace('#', "\\#");
                emit(&format!("\\href{{{}}}{{", url), &mut out, &mut cell, in_table);
            }
            Event::End(TagEnd::Link) => {
                link_stack.pop();
                emit("}", &mut out, &mut cell, in_table);
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                let local = img_map.iter().find(|(u, _)| u == dest_url.as_ref()).map(|(_, p)| p.clone());
                image_alt = Some((local, dest_url.to_string(), String::new()));
            }
            Event::End(TagEnd::Image) => {
                if let Some((local, url, alt)) = image_alt.take() {
                    let s = match local {
                        Some(p) if !p.ends_with(".svg") && !p.ends_with(".webp") => format!(
                            "\n\\begin{{figure}}[h]\n\\centering\n\\includegraphics[width=0.85\\linewidth]{{{}}}\n{}\\end{{figure}}\n",
                            p,
                            if alt.trim().is_empty() { String::new() } else { format!("\\caption*{{{}}}\n", tex_escape(&alt)) }
                        ),
                        Some(p) => format!("[图片：{}]", tex_escape(&p)),
                        None => format!("[图片：\\url{{{}}}]", url.replace('%', "\\%").replace('#', "\\#")),
                    };
                    emit(&s, &mut out, &mut cell, in_table);
                }
            }
            Event::Text(t) => {
                if in_code {
                    out.push_str(&t);
                } else {
                    let s = tex_escape(&t);
                    emit(&s, &mut out, &mut cell, in_table);
                }
            }
            Event::Code(t) => {
                let s = format!("\\texttt{{{}}}", tex_escape(&t));
                emit(&s, &mut out, &mut cell, in_table);
            }
            Event::InlineMath(m) => emit(&format!("${}$", m), &mut out, &mut cell, in_table),
            Event::DisplayMath(m) => out.push_str(&format!("\n\\[\n{}\n\\]\n", m.trim())),
            Event::Html(h) | Event::InlineHtml(h) => {
                let s = tex_escape(&strip_tags(&h));
                emit(&s, &mut out, &mut cell, in_table);
            }
            Event::SoftBreak => emit(if in_code { "\n" } else { " " }, &mut out, &mut cell, in_table),
            Event::HardBreak => emit(if in_table { " " } else { "\\\\\n" }, &mut out, &mut cell, in_table),
            Event::Rule => out.push_str("\n\\noindent\\rule{\\linewidth}{0.4pt}\n\n"),
            _ => {}
        }
    }

    let tex = format!(
        "% 由小悦笔记导出。请用 XeLaTeX 编译（支持中文）：xelatex \"文件名.tex\"\n\
\\documentclass[UTF8,11pt]{{ctexart}}\n\
\\usepackage[a4paper,margin=2.5cm]{{geometry}}\n\
\\usepackage{{amsmath,amssymb,graphicx,longtable,array,xcolor}}\n\
\\usepackage[normalem]{{ulem}}\n\
\\usepackage{{caption}}\n\
\\usepackage{{listings}}\n\
\\usepackage[hidelinks]{{hyperref}}\n\
\\lstset{{basicstyle=\\ttfamily\\small,breaklines=true,frame=single,columns=fullflexible,backgroundcolor=\\color[gray]{{0.96}}}}\n\
\\title{{{}}}\n\\author{{}}\n\\date{{}}\n\n\
\\begin{{document}}\n\\maketitle\n\n{}\n\\end{{document}}\n",
        tex_escape(&strip_emoji(title)),
        out.trim()
    );
    ExportBundle {
        bytes: tex.into_bytes(),
        extra_files: images.into_iter().map(|(n, b, _)| (n, b)).collect(),
    }
}

/* ───────────────────────── OPML ───────────────────────── */

struct OutlineNode {
    text: String,
    note: String,
    children: Vec<usize>,
}

/// 生成 OPML 2.0 大纲：标题按级别成为层级，段落、列表项、代码和表格行成为子节点
pub fn markdown_to_opml(title: &str, markdown: &str) -> String {
    let body_md = split_title(markdown);
    let mut nodes: Vec<OutlineNode> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut heading_stack: Vec<(u8, usize)> = Vec::new();
    let mut item_stack: Vec<usize> = Vec::new();
    let mut buf: Option<String> = None;
    let mut in_heading: Option<u8> = None;
    let mut in_code: Option<String> = None;
    let mut row: Vec<String> = Vec::new();
    let mut cell: Option<String> = None;
    let mut in_item_text = false;

    fn attach(nodes: &mut Vec<OutlineNode>, roots: &mut Vec<usize>, parent: Option<usize>, text: String, note: String) -> usize {
        let idx = nodes.len();
        nodes.push(OutlineNode { text, note, children: Vec::new() });
        match parent {
            Some(p) => nodes[p].children.push(idx),
            None => roots.push(idx),
        }
        idx
    }

    for ev in Parser::new_ext(body_md, options()) {
        let parent = item_stack.last().copied().or_else(|| heading_stack.last().map(|(_, i)| *i));
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = Some(level as u8);
                buf = Some(String::new());
            }
            Event::End(TagEnd::Heading(_)) => {
                let lv = in_heading.take().unwrap_or(1);
                let text = buf.take().unwrap_or_default();
                while heading_stack.last().map(|(l, _)| *l >= lv).unwrap_or(false) {
                    heading_stack.pop();
                }
                let p = heading_stack.last().map(|(_, i)| *i);
                let idx = attach(&mut nodes, &mut roots, p, text.trim().to_string(), String::new());
                heading_stack.push((lv, idx));
                item_stack.clear();
            }
            Event::Start(Tag::Paragraph) => {
                if !in_item_text {
                    buf = Some(String::new());
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if !in_item_text {
                    if let Some(text) = buf.take() {
                        if !text.trim().is_empty() {
                            attach(&mut nodes, &mut roots, parent, text.trim().to_string(), String::new());
                        }
                    }
                }
            }
            Event::Start(Tag::Item) => {
                let idx = attach(&mut nodes, &mut roots, parent, String::new(), String::new());
                item_stack.push(idx);
                in_item_text = true;
                buf = Some(String::new());
            }
            Event::Start(Tag::List(_)) => {
                // 嵌套列表开始前，把上级列表项的文字写进去
                if let (Some(&idx), Some(text)) = (item_stack.last(), buf.take()) {
                    nodes[idx].text.push_str(text.trim());
                }
                in_item_text = false;
            }
            Event::End(TagEnd::List(_)) => {
                in_item_text = !item_stack.is_empty();
                if in_item_text {
                    buf = Some(String::new());
                }
            }
            Event::End(TagEnd::Item) => {
                if let Some(idx) = item_stack.pop() {
                    if let Some(text) = buf.take() {
                        nodes[idx].text.push_str(text.trim());
                    }
                }
                in_item_text = !item_stack.is_empty();
                if in_item_text {
                    buf = Some(String::new());
                }
            }
            Event::TaskListMarker(done) => {
                if let Some(b) = buf.as_mut() {
                    b.push_str(if done { "☑ " } else { "☐ " });
                }
            }
            Event::Start(Tag::CodeBlock(_)) => in_code = Some(String::new()),
            Event::End(TagEnd::CodeBlock) => {
                let code = in_code.take().unwrap_or_default();
                let first = code.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                attach(&mut nodes, &mut roots, parent, if first.is_empty() { "代码".into() } else { first }, code.trim_end().to_string());
            }
            Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => row.clear(),
            Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
                let text = row.iter().map(|c| c.trim()).collect::<Vec<_>>().join(" | ");
                if !text.replace('|', "").trim().is_empty() {
                    attach(&mut nodes, &mut roots, parent, text, String::new());
                }
            }
            Event::Start(Tag::TableCell) => cell = Some(String::new()),
            Event::End(TagEnd::TableCell) => row.push(cell.take().unwrap_or_default()),
            Event::Start(Tag::Image { dest_url, .. }) => {
                let target = if let Some(c) = cell.as_mut() { Some(c) } else { buf.as_mut() };
                if let Some(b) = target {
                    let url = dest_url.to_string();
                    if url.starts_with("http") {
                        b.push_str(&format!("[图片 {}] ", url));
                    } else {
                        b.push_str("[图片] ");
                    }
                }
            }
            Event::Text(t) | Event::Code(t) | Event::InlineMath(t) | Event::DisplayMath(t) => {
                if let Some(c) = in_code.as_mut() {
                    c.push_str(&t);
                } else if let Some(c) = cell.as_mut() {
                    c.push_str(&t);
                } else if let Some(b) = buf.as_mut() {
                    b.push_str(&t);
                }
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                if let Some(b) = buf.as_mut() {
                    b.push_str(&strip_tags(&h));
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(b) = buf.as_mut() {
                    b.push(' ');
                }
            }
            _ => {}
        }
    }

    fn write(nodes: &[OutlineNode], idx: usize, depth: usize, out: &mut String) {
        let n = &nodes[idx];
        let indent = "  ".repeat(depth + 2);
        let note = if n.note.is_empty() { String::new() } else { format!(" _note=\"{}\"", xml_escape(&n.note).replace('\n', "&#10;")) };
        if n.children.is_empty() {
            out.push_str(&format!("{}<outline text=\"{}\"{}/>\n", indent, xml_escape(&n.text), note));
        } else {
            out.push_str(&format!("{}<outline text=\"{}\"{}>\n", indent, xml_escape(&n.text), note));
            for &c in &n.children {
                write(nodes, c, depth + 1, out);
            }
            out.push_str(&format!("{}</outline>\n", indent));
        }
    }
    let mut body = String::new();
    for &r in &roots {
        write(&nodes, r, 0, &mut body);
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head>\n    <title>{}</title>\n    <dateCreated>{}</dateCreated>\n  </head>\n  <body>\n{}  </body>\n</opml>\n",
        xml_escape(title),
        chrono::Utc::now().to_rfc2822(),
        body
    )
}

/// PNG 等前端生成的文件：base64 → 字节
pub fn decode_parts(parts: &[String]) -> Result<Vec<Vec<u8>>, AppError> {
    parts
        .iter()
        .map(|p| {
            let data = p.split_once(',').map(|(_, d)| d).unwrap_or(p);
            B64.decode(data.trim()).map_err(|e| AppError::Validation(format!("图片数据无效：{}", e)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const SAMPLE: &str = "# 📝 周报 & 计划\n\n## 本周\n\n- [x] 完成 **发布**\n- [ ] 写 *文档*\n  - 子项\n\n1. 第一\n2. 第二\n\n> 引用 50%\n\n```rust\nfn main() {}\n```\n\n| 事项 | 状态 |\n| --- | --- |\n| 官网 | 进行中 |\n\n公式 $E=mc^2$ 与 `a_b`\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n![示意图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)\n\n![远程](https://example.com/a.png)\n\n### 小节\n\n结尾 <u>下划线</u>\n";

    /// CI 里把样例文件写出来，便于人工检查
    fn save_sample(name: &str, bytes: &[u8]) {
        if let Ok(dir) = std::env::var("XYNOTE_EXPORT_SAMPLE_DIR") {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(std::path::Path::new(&dir).join(name), bytes);
        }
    }

    #[test]
    fn epub_is_valid_package() {
        let bytes = markdown_to_epub("📝 周报 & 计划", SAMPLE).unwrap();
        save_sample("sample.epub", &bytes);
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(zip.by_index(0).unwrap().name(), "mimetype");
        let mut mt = String::new();
        zip.by_name("mimetype").unwrap().read_to_string(&mut mt).unwrap();
        assert_eq!(mt, "application/epub+zip");
        let mut chapter = String::new();
        zip.by_name("OEBPS/chapter.xhtml").unwrap().read_to_string(&mut chapter).unwrap();
        assert!(chapter.contains("<h1>周报 &amp; 计划</h1>"));
        assert!(chapter.contains("id=\"h1\""));
        assert!(chapter.contains("src=\"images/image1.png\""));
        assert!(!chapter.contains("example.com"), "外部图片不引用");
        assert!(!chapter.contains("<u>"));
        let mut opf = String::new();
        zip.by_name("OEBPS/content.opf").unwrap().read_to_string(&mut opf).unwrap();
        assert!(opf.contains("images/image1.png"));
        let mut nav = String::new();
        zip.by_name("OEBPS/nav.xhtml").unwrap().read_to_string(&mut nav).unwrap();
        assert!(nav.contains("chapter.xhtml#h1") && nav.contains("本周") && nav.contains("小节"));
        assert!(zip.by_name("OEBPS/images/image1.png").is_ok());
    }

    #[test]
    fn latex_escapes_and_structures() {
        let b = markdown_to_latex("📝 周报 & 计划", SAMPLE, "周报_images");
        save_sample("sample.tex", &b.bytes);
        let tex = String::from_utf8(b.bytes).unwrap();
        assert!(tex.contains("\\documentclass[UTF8,11pt]{ctexart}"));
        assert!(tex.contains("\\title{周报 \\& 计划}"));
        assert!(tex.contains("\\subsection*{本周}"));
        assert!(tex.contains("$\\boxtimes$ 完成 \\textbf{发布}"));
        assert!(tex.contains("\\begin{enumerate}"));
        assert!(tex.contains("引用 50\\%"));
        assert!(tex.contains("\\begin{lstlisting}\nfn main() {}\n\\end{lstlisting}"));
        assert!(tex.contains("\\begin{longtable}"));
        assert!(tex.contains("\\textbf{事项} & \\textbf{状态}"));
        assert!(tex.contains("$E=mc^2$"));
        assert!(tex.contains("\\texttt{a\\_b}"));
        assert!(tex.contains("\\int_0^1 x\\,dx"));
        assert!(tex.contains("\\includegraphics[width=0.85\\linewidth]{周报_images/image1.png}"));
        assert!(tex.contains("\\url{https://example.com/a.png}"));
        assert_eq!(b.extra_files.len(), 1);
        assert_eq!(b.extra_files[0].0, "周报_images/image1.png");
        // 花括号成对
        let opens = tex.matches('{').count() - tex.matches("\\{").count();
        let closes = tex.matches('}').count() - tex.matches("\\}").count();
        assert_eq!(opens, closes);
    }

    #[test]
    fn opml_outline_follows_headings() {
        let opml = markdown_to_opml("周报 & 计划", SAMPLE);
        save_sample("sample.opml", opml.as_bytes());
        assert!(opml.starts_with("<?xml"));
        assert!(opml.contains("<title>周报 &amp; 计划</title>"));
        let week = opml.find("text=\"本周\"").unwrap();
        let done = opml.find("☑ 完成 发布").unwrap();
        let sub = opml.find("text=\"子项\"").unwrap();
        assert!(week < done && done < sub);
        assert!(opml.contains("text=\"事项 | 状态\""));
        assert!(opml.contains("_note=\"fn main() {}\""));
        assert!(opml.contains("text=\"小节\""));
        // 小节（三级标题）是「本周」（二级标题）的子节点：缩进多一级
        assert!(opml.contains("\n    <outline text=\"本周\">"));
        assert!(opml.contains("\n      <outline text=\"小节\">"));
    }
}
