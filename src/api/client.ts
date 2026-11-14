import { invoke } from "@tauri-apps/api/core";
import { strToU8, unzipSync, zipSync } from "fflate";
import type {
  BacklinkItem,
  BackupEntry,
  BatchImportResult,
  Block,
  BlockProps,
  BlockType,
  BreadcrumbItem,
  ColumnType,
  CreatePageInput,
  DatabaseFull,
  DbColumn,
  DbRow,
  LocalMarkdownDocument,
  MarkdownExport,
  MarkdownTreeEntry,
  Page,
  PageDetail,
  SaveBlockItem,
  SavedAssetResult,
  SaveStylePluginInput,
  SearchResult,
  SelectOption,
  StorageConfigInfo,
  StylePluginItem,
  StylePluginState,
  ThemeTokens,
  UpdatePagePatch,
  UpdateStorageConfigInput,
  UpsertBlockInput,
  UpsertDbColumnInput,
  UpsertDbRowInput,
  UrlMetadata,
} from "../types/notion";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ============================================================================
 * Browser Fallback Store (localStorage-persisted, 100% Tauri IPC parity)
 * ========================================================================== */

const STORAGE_KEY = "notion_desktop_workspace_v1";

interface PageLinkRecord {
  sourcePageId: string;
  targetPageId: string;
  excerpt: string;
}

interface DbMetaRecord {
  activeView: "table" | "board" | "gallery";
  groupByColId: string | null;
}

interface LocalStore {
  pages: Page[];
  blocks: Block[];
  pageLinks: PageLinkRecord[];
  dbMeta: Record<string, DbMetaRecord>;
  dbColumns: DbColumn[];
  dbRows: DbRow[];
  settings: Record<string, string>;
}

function makeId(prefix = "id"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRawTextBlockType(blockType: BlockType): boolean {
  return (
    blockType === "code" ||
    blockType === "math" ||
    blockType === "mermaid"
  );
}

const MERMAID_DIAGRAM_HEADER_RE =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|quadrantChart|C4Context)\b/i;

function isMermaidDiagramSource(raw: string): boolean {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  if (lines.length === 0) return false;
  return MERMAID_DIAGRAM_HEADER_RE.test(lines[0]);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function replaceUniversalMarkdownLinks(input: string): string {
  let result = "";
  let i = 0;

  while (i < input.length) {
    const openBracket = input.indexOf("[", i);
    if (openBracket === -1) {
      result += input.slice(i);
      break;
    }

    // Skip image syntax ![alt](url) or wiki links [[Page]]
    if (
      (openBracket > 0 && input[openBracket - 1] === "!") ||
      input[openBracket + 1] === "["
    ) {
      result += input.slice(i, openBracket + 1);
      i = openBracket + 1;
      continue;
    }

    result += input.slice(i, openBracket);

    // Find matching closing bracket ']'
    let closeBracket = -1;
    let bracketDepth = 1;
    for (let j = openBracket + 1; j < input.length; j += 1) {
      if (input[j] === "[") bracketDepth += 1;
      else if (input[j] === "]") {
        bracketDepth -= 1;
        if (bracketDepth === 0) {
          closeBracket = j;
          break;
        }
      }
    }

    if (closeBracket === -1 || input[closeBracket + 1] !== "(") {
      result += "[";
      i = openBracket + 1;
      continue;
    }

    // Parse URL inside (...) supporting balanced nested parentheses like MyFile(1).java
    let closeParen = -1;
    let parenDepth = 1;
    for (let k = closeBracket + 2; k < input.length; k += 1) {
      const ch = input[k];
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          closeParen = k;
          break;
        }
      }
    }

    if (closeParen === -1) {
      result += "[";
      i = openBracket + 1;
      continue;
    }

    const label = input.slice(openBracket + 1, closeBracket);
    const rawTarget = input
      .slice(closeBracket + 2, closeParen)
      .trim()
      .replace(/&amp;/g, "&");
    const safeHref = rawTarget.replace(/\s+/g, "%20");

    if (/^(?:https?:\/\/|file:\/\/|vscode:\/\/|mailto:)/i.test(safeHref)) {
      result += `<a href="${safeHref}" class="nb-inline-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else {
      result += `<a href="${safeHref}" data-md-rel-href="${rawTarget}" class="nb-inline-link">${label}</a>`;
    }

    i = closeParen + 1;
  }

  return result;
}

function inlineMarkdownToHtml(text: string): string {
  if (!text) return "";
  const codeTokens: string[] = [];
  const withCodePlaceholders = text.replace(/`([^`]+)`/g, (_m, inner: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(inner)}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  let out = escapeHtml(withCodePlaceholders);
  // Preserve explicit <br> / <br/> line breaks in Markdown prose and GFM table cells
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  out = replaceUniversalMarkdownLinks(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");

  out = out.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idxStr: string) => {
    return codeTokens[Number(idxStr)] ?? "";
  });
  return out;
}

function htmlToInlineMarkdown(html: string, preserveBrAsTag = false): string {
  if (!html) return "";
  let out = html;
  if (preserveBrAsTag) {
    out = out.replace(/<br\s*\/?>/gi, "\u0000BR_TAG\u0000");
  }
  out = out.replace(
    /<a\b[^>]*class=["'][^"']*nb-wiki-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, inner: string) => {
      const clean = stripHtml(inner)
        .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "")
        .trim();
      return `[[${clean || stripHtml(inner)}]]`;
    }
  );
  out = out.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `[${stripHtml(inner)}](${href})`
  );
  out = out.replace(/<(?:mark)\b[^>]*>([\s\S]*?)<\/mark>/gi, "==$1==");
  out = out.replace(/<(?:code)\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  out = out.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
  out = out.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*");
  out = out.replace(/<(?:s|del|strike)\b[^>]*>([\s\S]*?)<\/(?:s|del|strike)>/gi, "~~$1~~");
  let plain = stripHtml(out);
  if (preserveBrAsTag) {
    plain = plain
      .replace(/\r?\n/g, "<br/>")
      .replace(/\u0000BR_TAG\u0000/g, "<br/>");
  }
  return plain;
}

function splitGfmTableRowCells(rowStr: string): string[] {
  let inner = rowStr.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  let inCode = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length && inner[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function formatGfmTableExportLines(props: BlockProps): string[] {
  const rawHeaders = props.headers ?? ["列 1", "列 2"];
  const rawRows = props.rows ?? [];
  const aligns = props.colAlignments ?? [];
  const colCount = Math.max(
    rawHeaders.length,
    ...rawRows.map((r) => r.length),
    1
  );

  const formatCell = (cellHtml: string | undefined): string => {
    const md = htmlToInlineMarkdown(cellHtml ?? "", true);
    return md.replace(/\|/g, "\\|");
  };

  const headerCells = Array.from({ length: colCount }, (_, idx) =>
    formatCell(rawHeaders[idx] ?? `列 ${idx + 1}`)
  );
  const sepCells = Array.from({ length: colCount }, (_, idx) => {
    const a = aligns[idx];
    if (a === "center") return ":---:";
    if (a === "right") return "---:";
    if (a === "left") return ":---";
    return "---";
  });

  const out: string[] = [
    `| ${headerCells.join(" | ")} |`,
    `| ${sepCells.join(" | ")} |`,
  ];
  for (const r of rawRows) {
    const rowCells = Array.from({ length: colCount }, (_, idx) =>
      formatCell(r[idx] ?? "")
    );
    out.push(`| ${rowCells.join(" | ")} |`);
  }
  return out;
}

function getEffectiveBlockPlainText(blk: Pick<Block, "blockType" | "content" | "plainText" | "props">): string {
  if (isRawTextBlockType(blk.blockType)) {
    return blk.content || blk.plainText;
  }
  if (blk.blockType === "table") {
    return (
      blk.plainText ||
      [...(blk.props.headers ?? []), ...((blk.props.rows ?? []).flat())]
        .map((c) => stripHtml(c ?? ""))
        .join(" ")
    );
  }
  if (blk.blockType === "image") {
    return blk.props.caption || blk.plainText || blk.props.url || "";
  }
  if (blk.blockType === "bookmark") {
    return (
      [blk.props.bookmarkTitle, blk.props.bookmarkDesc, blk.props.url]
        .filter(Boolean)
        .join(" ") || blk.plainText
    );
  }
  if (blk.blockType === "embed") {
    return [blk.props.caption, blk.props.url].filter(Boolean).join(" ") || blk.plainText;
  }
  return blk.plainText || stripHtml(blk.content);
}

function makeBlock(
  pageId: string,
  sortOrder: number,
  blockType: BlockType,
  content: string,
  props: BlockProps = {},
  id?: string
): Block {
  const ts = nowIso();
  const plain =
    blockType === "table"
      ? [...(props.headers ?? []), ...((props.rows ?? []).flat())]
          .map((c) => stripHtml(c ?? ""))
          .join(" ")
      : isRawTextBlockType(blockType)
      ? content
      : blockType === "image"
      ? props.caption || stripHtml(content) || props.url || ""
      : blockType === "bookmark"
      ? [props.bookmarkTitle, props.bookmarkDesc, props.url].filter(Boolean).join(" ")
      : blockType === "embed"
      ? [props.caption, props.url].filter(Boolean).join(" ")
      : stripHtml(content);
  return {
    id: id ?? makeId("blk"),
    pageId,
    blockType,
    content,
    plainText: plain,
    props,
    sortOrder,
    createdAt: ts,
    updatedAt: ts,
  };
}

function rebuildAllLinksForSource(store: LocalStore, sourcePageId: string): void {
  store.pageLinks = store.pageLinks.filter((l) => l.sourcePageId !== sourcePageId);
  const sourceBlocks = store.blocks
    .filter((b) => b.pageId === sourcePageId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const activePages = store.pages.filter((p) => !p.isTrashed);
  const recordedTargets = new Set<string>();

  for (const blk of sourceBlocks) {
    if (isRawTextBlockType(blk.blockType)) {
      continue;
    }

    const excerptText = getEffectiveBlockPlainText(blk).slice(0, 140);
    const htmlScanSource =
      blk.blockType === "table"
        ? [...(blk.props.headers ?? []), ...((blk.props.rows ?? []).flat())].join(" ")
        : blk.content;
    const idRegex = /data-page-id=["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(htmlScanSource)) !== null) {
      const targetId = match[1];
      if (
        targetId &&
        targetId !== sourcePageId &&
        !recordedTargets.has(targetId) &&
        activePages.some((p) => p.id === targetId)
      ) {
        recordedTargets.add(targetId);
        store.pageLinks.push({
          sourcePageId,
          targetPageId: targetId,
          excerpt: excerptText,
        });
      }
    }

    const textSource = getEffectiveBlockPlainText(blk);
    const wikiRegex = /\[\[([^\]]+)\]\]/g;
    while ((match = wikiRegex.exec(textSource)) !== null) {
      const titleRef = match[1].trim().toLowerCase();
      const targetPage = activePages.find(
        (p) => p.id !== sourcePageId && p.title.trim().toLowerCase() === titleRef
      );
      if (targetPage && !recordedTargets.has(targetPage.id)) {
        recordedTargets.add(targetPage.id);
        store.pageLinks.push({
          sourcePageId,
          targetPageId: targetPage.id,
          excerpt: excerptText,
        });
      }
    }
  }
}

function createInitialSeedStore(): LocalStore {
  const ts = nowIso();
  const welcomeId = "page-welcome";
  const roadmapId = "page-roadmap";
  const archId = "page-arch";
  const journalId = "page-journal";

  const pages: Page[] = [
    {
      id: welcomeId,
      parentId: null,
      title: "欢迎使用 小悦 (XyNote)",
      icon: "🏠",
      cover: "linear-gradient(120deg, #f6efe2 0%, #e9dfd0 52%, #dce5ea 100%)",
      pageType: "doc",
      isFavorite: true,
      isTrashed: false,
      sortOrder: 0,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: roadmapId,
      parentId: null,
      title: "产品路线图 Product Roadmap",
      icon: "🗺️",
      cover: null,
      pageType: "database",
      isFavorite: true,
      isTrashed: false,
      sortOrder: 1,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: archId,
      parentId: welcomeId,
      title: "工程架构设计 Engineering Architecture",
      icon: "🏗️",
      cover: null,
      pageType: "doc",
      isFavorite: false,
      isTrashed: false,
      sortOrder: 0,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: journalId,
      parentId: null,
      title: "每周工作复盘与思考",
      icon: "📓",
      cover: null,
      pageType: "doc",
      isFavorite: false,
      isTrashed: false,
      sortOrder: 2,
      createdAt: ts,
      updatedAt: ts,
    },
  ];

  const blocks: Block[] = [
    makeBlock(
      welcomeId,
      0,
      "callout",
      "欢迎来到本地优先的桌面端 <b>小悦 (XyNote)</b> 工作区！所有笔记、块结构、公式图片、双向链接与多维数据库均实时保存在本地 SQLite 数据库中。",
      { calloutIcon: "💡", color: "amber" }
    ),
    makeBlock(welcomeId, 1, "heading2", "快速上手指南"),
    makeBlock(
      welcomeId,
      2,
      "todo",
      "输入 <code>/</code> 唤出斜杠命令菜单，插入标题、代码块、KaTeX 公式、图片、书签卡片或内嵌视频",
      { checked: true }
    ),
    makeBlock(
      welcomeId,
      3,
      "todo",
      "直接将本地 <code>.md</code> 文件、整个文件夹或 Notion 官方导出的 <code>.zip</code> 拖入窗口完成批量迁移",
      { checked: false }
    ),
    makeBlock(
      welcomeId,
      4,
      "todo",
      "输入 <code>[[</code> 建立双向页面引用，例如前往 <a href=\"#\" data-page-id=\"page-roadmap\" class=\"nb-wiki-link\">🗺️ 产品路线图 Product Roadmap</a>",
      { checked: false }
    ),
    makeBlock(
      welcomeId,
      5,
      "math",
      "\\mathcal{L}(\\theta) = \\frac{1}{N}\\sum_{i=1}^{N} \\left\\| f_\\theta(x_i) - y_i \\right\\|_2^2"
    ),
    makeBlock(
      welcomeId,
      6,
      "toggle",
      "常用键盘快捷键速查",
      {
        collapsed: false,
        childrenText:
          "• Ctrl + K：全局搜索与快速跳转\n• Ctrl + N：快速新建文档页面\n• Ctrl + \\：折叠或展开左侧边栏\n• 行内 Markdown：输入 **加粗**、*斜体*、`代码`、$$ 公式实时转换",
      }
    ),
    makeBlock(
      welcomeId,
      7,
      "table",
      "",
      {
        headers: ["核心模块", "技术实现", "当前状态"],
        rows: [
          ["块级富文本编辑器", "17 种块类型 + KaTeX 公式 + 行内 Markdown", "✅ 已就绪"],
          ["批量导入与迁移", "拖拽 .md 文件夹 + Notion .zip 全量解析", "✅ 已就绪"],
          ["本地存储引擎", "Rust + Tauri v2 + SQLite WAL / FTS5", "✅ 已就绪"],
        ],
      }
    ),
    makeBlock(
      welcomeId,
      8,
      "quote",
      "保持工具安静、克制与迅捷，让注意力回到思考与创作本身。"
    ),
    makeBlock(
      welcomeId,
      9,
      "paragraph",
      "深入了解底层实现请参阅子页面：<a href=\"#\" data-page-id=\"page-arch\" class=\"nb-wiki-link\">🏗️ 工程架构设计 Engineering Architecture</a>。"
    ),

    // Engineering Architecture child page blocks
    makeBlock(
      archId,
      0,
      "callout",
      "本文档梳理小悦 (XyNote) 的前后端分层架构，并与 <a href=\"#\" data-page-id=\"page-welcome\" class=\"nb-wiki-link\">🏠 欢迎使用 小悦 (XyNote)</a> 及 <a href=\"#\" data-page-id=\"page-roadmap\" class=\"nb-wiki-link\">🗺️ 产品路线图 Product Roadmap</a> 自动建立反向链接。",
      { calloutIcon: "🧭", color: "blue" }
    ),
    makeBlock(archId, 1, "heading2", "存储层与全文检索设计"),
    makeBlock(
      archId,
      2,
      "bullet",
      "启用 <code>PRAGMA journal_mode = WAL</code> 与外键级联删除，保障高并发读写安全。"
    ),
    makeBlock(
      archId,
      3,
      "bullet",
      "结合 SQLite FTS5 倒排索引与中文子串匹配，实现毫秒级中英双语搜索。"
    ),
    makeBlock(
      archId,
      4,
      "code",
      "SELECT p.id, p.title, snippet(blocks_fts, 0, '[', ']', '...', 16)\nFROM blocks_fts\nJOIN pages p ON p.id = blocks_fts.page_id\nWHERE blocks_fts MATCH ?1 AND p.is_trashed = 0;",
      { language: "sql" }
    ),

    // Weekly Journal starter blocks
    makeBlock(journalId, 0, "heading2", "本周核心目标 Focus"),
    makeBlock(journalId, 1, "numbered", "完成桌面端 17 种块类型与数据库三视图打磨"),
    makeBlock(journalId, 2, "numbered", "验证 Notion .zip 导出包与多级 Markdown 目录树一键迁移"),
    makeBlock(journalId, 3, "divider", ""),
    makeBlock(journalId, 4, "paragraph", "随时记录灵感与会议要点，使用 <code>[[</code> 关联项目页面。"),
  ];

  // Product Roadmap Database columns & rows
  const colTitleId = "col-roadmap-title";
  const colStatusId = "col-roadmap-status";
  const colPriorityId = "col-roadmap-priority";
  const colTagsId = "col-roadmap-tags";
  const colDateId = "col-roadmap-date";
  const colShippedId = "col-roadmap-shipped";

  const statusOptions: SelectOption[] = [
    { id: "opt-todo", label: "待规划 Todo", color: "gray" },
    { id: "opt-doing", label: "进行中 In Progress", color: "blue" },
    { id: "opt-done", label: "已完成 Done", color: "green" },
  ];

  const priorityOptions: SelectOption[] = [
    { id: "opt-p0", label: "P0 核心", color: "red" },
    { id: "opt-p1", label: "P1 重要", color: "amber" },
    { id: "opt-p2", label: "P2 常规", color: "blue" },
  ];

  const tagOptions: SelectOption[] = [
    { id: "tag-rust", label: "Rust", color: "amber" },
    { id: "tag-sqlite", label: "SQLite", color: "green" },
    { id: "tag-editor", label: "Editor", color: "purple" },
    { id: "tag-ui", label: "Design", color: "blue" },
  ];

  const dbColumns: DbColumn[] = [
    {
      id: colTitleId,
      pageId: roadmapId,
      name: "功能事项",
      colType: "title",
      options: [],
      width: 260,
      sortOrder: 0,
    },
    {
      id: colStatusId,
      pageId: roadmapId,
      name: "状态",
      colType: "status",
      options: statusOptions,
      width: 160,
      sortOrder: 1,
    },
    {
      id: colPriorityId,
      pageId: roadmapId,
      name: "优先级",
      colType: "select",
      options: priorityOptions,
      width: 130,
      sortOrder: 2,
    },
    {
      id: colTagsId,
      pageId: roadmapId,
      name: "模块标签",
      colType: "multi_select",
      options: tagOptions,
      width: 200,
      sortOrder: 3,
    },
    {
      id: colDateId,
      pageId: roadmapId,
      name: "目标日期",
      colType: "date",
      options: [],
      width: 145,
      sortOrder: 4,
    },
    {
      id: colShippedId,
      pageId: roadmapId,
      name: "已上线",
      colType: "checkbox",
      options: [],
      width: 100,
      sortOrder: 5,
    },
  ];

  const dbRows: DbRow[] = [
    {
      id: "row-rm-1",
      pageId: roadmapId,
      cells: {
        [colTitleId]: "SQLite WAL 存储引擎与 FTS5 全文检索",
        [colStatusId]: "opt-done",
        [colPriorityId]: "opt-p0",
        [colTagsId]: ["tag-rust", "tag-sqlite"],
        [colDateId]: "2026-11-10",
        [colShippedId]: true,
      },
      linkedPageId: archId,
      sortOrder: 0,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "row-rm-2",
      pageId: roadmapId,
      cells: {
        [colTitleId]: "块级富文本编辑器（KaTeX 公式 + 行内 Markdown）",
        [colStatusId]: "opt-done",
        [colPriorityId]: "opt-p0",
        [colTagsId]: ["tag-editor", "tag-ui"],
        [colDateId]: "2026-11-12",
        [colShippedId]: true,
      },
      linkedPageId: null,
      sortOrder: 1,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "row-rm-3",
      pageId: roadmapId,
      cells: {
        [colTitleId]: "多维数据库（表格 / 看板拖拽 / 画廊卡片）",
        [colStatusId]: "opt-doing",
        [colPriorityId]: "opt-p0",
        [colTagsId]: ["tag-ui", "tag-sqlite"],
        [colDateId]: "2026-11-16",
        [colShippedId]: false,
      },
      linkedPageId: null,
      sortOrder: 2,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "row-rm-4",
      pageId: roadmapId,
      cells: {
        [colTitleId]: "双向页面链接 [[WikiLink]] 与反向链接面板",
        [colStatusId]: "opt-doing",
        [colPriorityId]: "opt-p1",
        [colTagsId]: ["tag-editor"],
        [colDateId]: "2026-11-18",
        [colShippedId]: false,
      },
      linkedPageId: null,
      sortOrder: 3,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: "row-rm-5",
      pageId: roadmapId,
      cells: {
        [colTitleId]: "Notion .zip 导出包与 Markdown 文件夹批量迁移",
        [colStatusId]: "opt-done",
        [colPriorityId]: "opt-p0",
        [colTagsId]: ["tag-rust", "tag-ui"],
        [colDateId]: "2026-11-24",
        [colShippedId]: true,
      },
      linkedPageId: null,
      sortOrder: 4,
      createdAt: ts,
      updatedAt: ts,
    },
  ];

  const store: LocalStore = {
    pages,
    blocks,
    pageLinks: [],
    dbMeta: {
      [roadmapId]: {
        activeView: "table",
        groupByColId: colStatusId,
      },
    },
    dbColumns,
    dbRows,
    settings: {
      theme: "light",
      fontStyle: "sans",
      fullWidth: "true",
      "appearance.adaptiveWidth": "true",
    },
  };

  for (const p of pages) {
    if (p.pageType === "doc") {
      rebuildAllLinksForSource(store, p.id);
    }
  }
  return store;
}

let memoryStore: LocalStore | null = null;

function loadStore(): LocalStore {
  if (memoryStore) return memoryStore;
  if (typeof window === "undefined") {
    memoryStore = createInitialSeedStore();
    return memoryStore;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalStore;
      if (parsed && Array.isArray(parsed.pages)) {
        let migrated = false;
        for (const p of parsed.pages) {
          if (p.id === "page-welcome" && p.title === "欢迎使用 Notion Desktop") {
            p.title = "欢迎使用 小悦 (XyNote)";
            migrated = true;
          }
        }
        memoryStore = parsed;
        if (migrated) {
          saveStore(memoryStore);
        }
        return memoryStore;
      }
    }
  } catch {
    // Fallback to seed store
  }
  memoryStore = createInitialSeedStore();
  saveStore(memoryStore);
  return memoryStore;
}

function saveStore(store: LocalStore): void {
  memoryStore = store;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Ignore storage quota errors
    }
  }
}

function ensureDatabaseInitialized(store: LocalStore, pageId: string): DatabaseFull {
  let cols = store.dbColumns
    .filter((c) => c.pageId === pageId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (cols.length === 0) {
    const titleColId = makeId("col");
    const statusColId = makeId("col");
    const tagColId = makeId("col");
    const dateColId = makeId("col");

    const defaultStatusOpts: SelectOption[] = [
      { id: makeId("opt"), label: "未开始", color: "gray" },
      { id: makeId("opt"), label: "进行中", color: "blue" },
      { id: makeId("opt"), label: "已完成", color: "green" },
    ];
    const defaultTagOpts: SelectOption[] = [
      { id: makeId("opt"), label: "重要", color: "red" },
      { id: makeId("opt"), label: "设计", color: "purple" },
      { id: makeId("opt"), label: "研发", color: "blue" },
    ];

    const createdCols: DbColumn[] = [
      {
        id: titleColId,
        pageId,
        name: "名称",
        colType: "title",
        options: [],
        width: 240,
        sortOrder: 0,
      },
      {
        id: statusColId,
        pageId,
        name: "状态",
        colType: "status",
        options: defaultStatusOpts,
        width: 150,
        sortOrder: 1,
      },
      {
        id: tagColId,
        pageId,
        name: "标签",
        colType: "multi_select",
        options: defaultTagOpts,
        width: 180,
        sortOrder: 2,
      },
      {
        id: dateColId,
        pageId,
        name: "日期",
        colType: "date",
        options: [],
        width: 140,
        sortOrder: 3,
      },
    ];
    store.dbColumns.push(...createdCols);
    cols = createdCols;

    if (!store.dbMeta[pageId]) {
      store.dbMeta[pageId] = {
        activeView: "table",
        groupByColId: statusColId,
      };
    }

    const existingRows = store.dbRows.filter((r) => r.pageId === pageId);
    if (existingRows.length === 0) {
      const ts = nowIso();
      store.dbRows.push(
        {
          id: makeId("row"),
          pageId,
          cells: {
            [titleColId]: "示例条目 1",
            [statusColId]: defaultStatusOpts[1].id,
            [tagColId]: [defaultTagOpts[0].id],
            [dateColId]: ts.slice(0, 10),
          },
          linkedPageId: null,
          sortOrder: 0,
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: makeId("row"),
          pageId,
          cells: {
            [titleColId]: "示例条目 2",
            [statusColId]: defaultStatusOpts[0].id,
            [tagColId]: [defaultTagOpts[2].id],
            [dateColId]: ts.slice(0, 10),
          },
          linkedPageId: null,
          sortOrder: 1,
          createdAt: ts,
          updatedAt: ts,
        }
      );
    }
    saveStore(store);
  }

  const meta = store.dbMeta[pageId] ?? {
    activeView: "table",
    groupByColId:
      cols.find((c) => c.colType === "status" || c.colType === "select")?.id ?? null,
  };
  store.dbMeta[pageId] = meta;

  const rows = store.dbRows
    .filter((r) => r.pageId === pageId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    pageId,
    activeView: meta.activeView,
    groupByColId: meta.groupByColId,
    columns: cols.map((c) => ({ ...c, options: [...c.options] })),
    rows: rows.map((r) => ({ ...r, cells: { ...r.cells } })),
  };
}

function applyTemplateToPage(store: LocalStore, page: Page, templateId: string): void {
  const ts = nowIso();
  if (templateId === "meeting-notes") {
    page.title = page.title === "无标题" ? "团队周会纪要" : page.title;
    page.icon = "📝";
    page.pageType = "doc";
    store.blocks.push(
      makeBlock(page.id, 0, "callout", "日期：" + ts.slice(0, 10) + " ｜ 参会人：产品、研发、设计", {
        calloutIcon: "📅",
        color: "gray",
      }),
      makeBlock(page.id, 1, "heading2", "会议议程 Agenda"),
      makeBlock(page.id, 2, "bullet", "上周里程碑交付回顾与核心指标同步"),
      makeBlock(page.id, 3, "bullet", "本周关键阻塞项讨论与方案决策"),
      makeBlock(page.id, 4, "heading2", "行动项 Action Items"),
      makeBlock(page.id, 5, "todo", "整理需求评审结论并同步至产品路线图", { checked: false }),
      makeBlock(page.id, 6, "todo", "跟进客户端性能优化压测报告", { checked: false })
    );
  } else if (templateId === "eng-spec") {
    page.title = page.title === "无标题" ? "技术方案设计 RFC" : page.title;
    page.icon = "⚙️";
    page.pageType = "doc";
    store.blocks.push(
      makeBlock(page.id, 0, "callout", "状态：草案评审中 ｜ 作者：Engineering Team", {
        calloutIcon: "🛠️",
        color: "blue",
      }),
      makeBlock(page.id, 1, "heading2", "1. 背景与目标 Motivation"),
      makeBlock(page.id, 2, "paragraph", "阐述当前系统痛点、核心业务诉求以及本次架构演进预期达成的量化指标。"),
      makeBlock(page.id, 3, "heading2", "2. 核心架构与数据模型 Design"),
      makeBlock(
        page.id,
        4,
        "code",
        "pub struct DocumentEngine<T> {\n    pub wal_enabled: bool,\n    pub fts_indexed: bool,\n    pub marker: std::marker::PhantomData<T>,\n}",
        { language: "rust" }
      ),
      makeBlock(page.id, 5, "heading2", "3. 风险评估与回滚预案"),
      makeBlock(page.id, 6, "table", "", {
        headers: ["潜在风险", "影响等级", "缓解措施"],
        rows: [
          ["历史数据迁移耗时", "中", "采用增量事务批处理与断点续传"],
          ["全文索引体积增长", "低", "定期执行 FTS5 optimize 压缩"],
        ],
      })
    );
  } else if (templateId === "weekly-journal") {
    page.title = page.title === "无标题" ? "每周复盘与计划" : page.title;
    page.icon = "🗓️";
    page.pageType = "doc";
    store.blocks.push(
      makeBlock(page.id, 0, "heading2", "✨ 本周高光收获 Wins"),
      makeBlock(page.id, 1, "bullet", "完成了关键模块的端到端联调"),
      makeBlock(page.id, 2, "heading2", "🧩 遇到的挑战与反思"),
      makeBlock(page.id, 3, "quote", "把复杂问题拆解为可验证的小步迭代。"),
      makeBlock(page.id, 4, "heading2", "🎯 下周三件事 Top 3"),
      makeBlock(page.id, 5, "todo", "推进核心特性体验走查", { checked: false }),
      makeBlock(page.id, 6, "todo", "阅读并沉淀一篇技术笔记", { checked: false })
    );
  } else if (
    templateId === "product-roadmap" ||
    templateId === "task-hub" ||
    templateId === "reading-list"
  ) {
    page.pageType = "database";
    if (templateId === "product-roadmap") {
      page.title = page.title === "无标题" ? "产品路线图" : page.title;
      page.icon = "🗺️";
    } else if (templateId === "task-hub") {
      page.title = page.title === "无标题" ? "任务管理看板" : page.title;
      page.icon = "✅";
    } else {
      page.title = page.title === "无标题" ? "阅读书单与笔记" : page.title;
      page.icon = "📚";
    }

    const cTitle = makeId("col");
    const cStatus = makeId("col");
    const cSelect = makeId("col");
    const cCheck = makeId("col");

    const s1 = { id: makeId("opt"), label: templateId === "reading-list" ? "想读" : "待处理", color: "gray" };
    const s2 = { id: makeId("opt"), label: templateId === "reading-list" ? "在读" : "进行中", color: "blue" };
    const s3 = { id: makeId("opt"), label: templateId === "reading-list" ? "已读完" : "已完成", color: "green" };

    const p1 = { id: makeId("opt"), label: templateId === "reading-list" ? "★★★★★ 必读" : "高优 P0", color: "red" };
    const p2 = { id: makeId("opt"), label: templateId === "reading-list" ? "★★★★ 推荐" : "中优 P1", color: "amber" };

    store.dbColumns.push(
      {
        id: cTitle,
        pageId: page.id,
        name: templateId === "reading-list" ? "书名 / 文章" : "事项名称",
        colType: "title",
        options: [],
        width: 250,
        sortOrder: 0,
      },
      {
        id: cStatus,
        pageId: page.id,
        name: "状态",
        colType: "status",
        options: [s1, s2, s3],
        width: 150,
        sortOrder: 1,
      },
      {
        id: cSelect,
        pageId: page.id,
        name: templateId === "reading-list" ? "推荐度" : "优先级",
        colType: "select",
        options: [p1, p2],
        width: 150,
        sortOrder: 2,
      },
      {
        id: cCheck,
        pageId: page.id,
        name: "归档",
        colType: "checkbox",
        options: [],
        width: 100,
        sortOrder: 3,
      }
    );

    store.dbMeta[page.id] = {
      activeView: templateId === "task-hub" ? "board" : templateId === "reading-list" ? "gallery" : "table",
      groupByColId: cStatus,
    };

    store.dbRows.push(
      {
        id: makeId("row"),
        pageId: page.id,
        cells: {
          [cTitle]: templateId === "reading-list" ? "《设计数据密集型应用》DDIA" : "完成核心交互原型评审",
          [cStatus]: s2.id,
          [cSelect]: p1.id,
          [cCheck]: false,
        },
        linkedPageId: null,
        sortOrder: 0,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: makeId("row"),
        pageId: page.id,
        cells: {
          [cTitle]: templateId === "reading-list" ? "《Rust 原子操作与锁》" : "整理发布前回归测试清单",
          [cStatus]: s1.id,
          [cSelect]: p2.id,
          [cCheck]: false,
        },
        linkedPageId: null,
        sortOrder: 1,
        createdAt: ts,
        updatedAt: ts,
      }
    );
  }
}

/* ============================================================================
 * Shared Markdown Parser, CSV Database Inferencer & Notion .zip Migration Engine
 * ========================================================================== */

const NOTION_UUID_TAIL_RE =
  /\s+(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})(?:_all)?$/i;
const NOTION_BARE_UUID_RE =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})(?:_all)?$/i;

function stripNotionUuid(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || NOTION_BARE_UUID_RE.test(trimmed)) {
    return "无标题";
  }
  const cleaned = trimmed.replace(NOTION_UUID_TAIL_RE, "").trim();
  return cleaned || "无标题";
}

function normalizePosixPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  const stack: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

function resolveRelativeAssetPath(baseDir: string, relHref: string): string {
  let decoded = relHref;
  try {
    decoded = decodeURIComponent(relHref);
  } catch {
    // Keep raw if malformed URI
  }
  decoded = decoded.split("#")[0].split("?")[0];
  return normalizePosixPath(baseDir ? `${baseDir}/${decoded}` : decoded);
}

function parseMarkdownStringToBlocks(
  pageId: string,
  markdown: string,
  assetDataUris?: Map<string, string>,
  currentFileDir = "",
  cleanAssetLookup?: Map<string, string>
): Block[] {
  const ts = nowIso();
  const rawLines = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const parsedBlocks: Block[] = [];
  let sort = 0;
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code / mermaid block ```lang
    if (trimmed.startsWith("```")) {
      const rawLang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < rawLines.length && !rawLines[i].trim().startsWith("```")) {
        codeLines.push(rawLines[i]);
        i += 1;
      }
      if (i < rawLines.length) i += 1;
      const codeContent = codeLines.join("\n");
      const isMermaid =
        rawLang.toLowerCase() === "mermaid" ||
        (!rawLang && isMermaidDiagramSource(codeContent));
      if (isMermaid) {
        parsedBlocks.push({
          id: makeId("blk"),
          pageId,
          blockType: "mermaid",
          content: codeContent,
          plainText: codeContent,
          props: { mermaidView: "preview" },
          sortOrder: sort++,
          createdAt: ts,
          updatedAt: ts,
        });
      } else {
        parsedBlocks.push({
          id: makeId("blk"),
          pageId,
          blockType: "code",
          content: codeContent,
          plainText: codeContent,
          props: { language: rawLang || "plaintext", wordWrap: true },
          sortOrder: sort++,
          createdAt: ts,
          updatedAt: ts,
        });
      }
      continue;
    }

    // Display Math $$ ... $$ (single-line or multi-line)
    if (trimmed.startsWith("$$")) {
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        const expr = trimmed.slice(2, -2).trim();
        parsedBlocks.push({
          id: makeId("blk"),
          pageId,
          blockType: "math",
          content: expr,
          plainText: expr,
          props: {},
          sortOrder: sort++,
          createdAt: ts,
          updatedAt: ts,
        });
        i += 1;
        continue;
      }

      const mathLines: string[] = [];
      const firstRest = trimmed.slice(2).trim();
      if (firstRest) mathLines.push(firstRest);
      i += 1;
      while (i < rawLines.length) {
        const curTrim = rawLines[i].trim();
        if (curTrim.endsWith("$$")) {
          const beforeEnd = curTrim.slice(0, -2).trim();
          if (beforeEnd) mathLines.push(beforeEnd);
          i += 1;
          break;
        }
        mathLines.push(rawLines[i]);
        i += 1;
      }
      const mathContent = mathLines.join("\n").trim();
      parsedBlocks.push({
        id: makeId("blk"),
        pageId,
        blockType: "math",
        content: mathContent,
        plainText: mathContent,
        props: {},
        sortOrder: sort++,
        createdAt: ts,
        updatedAt: ts,
      });
      continue;
    }

    // Standalone image ![caption](url)
    const imgMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed);
    if (imgMatch) {
      const caption = imgMatch[1].trim();
      let imgUrl = imgMatch[2].trim();
      if (
        assetDataUris &&
        !/^(https?:|data:|blob:)/i.test(imgUrl)
      ) {
        const resolved = resolveRelativeAssetPath(currentFileDir, imgUrl).toLowerCase();
        let embedded = assetDataUris.get(resolved);
        if (!embedded && cleanAssetLookup) {
          const cleanResolved = resolved
            .split("/")
            .map(stripNotionUuid)
            .join("/")
            .toLowerCase();
          embedded = cleanAssetLookup.get(cleanResolved);
        }
        if (embedded) {
          imgUrl = embedded;
        }
      }
      parsedBlocks.push(
        makeBlock(pageId, sort++, "image", caption, {
          url: imgUrl,
          caption,
          imageWidth: "full",
        })
      );
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      parsedBlocks.push(makeBlock(pageId, sort++, "divider", ""));
      i += 1;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      parsedBlocks.push(
        makeBlock(pageId, sort++, "heading3", inlineMarkdownToHtml(trimmed.slice(4)))
      );
      i += 1;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      parsedBlocks.push(
        makeBlock(pageId, sort++, "heading2", inlineMarkdownToHtml(trimmed.slice(3)))
      );
      i += 1;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      parsedBlocks.push(
        makeBlock(pageId, sort++, "heading1", inlineMarkdownToHtml(trimmed.slice(2)))
      );
      i += 1;
      continue;
    }

    const todoMatch = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (todoMatch) {
      parsedBlocks.push(
        makeBlock(pageId, sort++, "todo", inlineMarkdownToHtml(todoMatch[2]), {
          checked: todoMatch[1].toLowerCase() === "x",
        })
      );
      i += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      parsedBlocks.push(
        makeBlock(
          pageId,
          sort++,
          "bullet",
          inlineMarkdownToHtml(trimmed.replace(/^[-*+]\s+/, ""))
        )
      );
      i += 1;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      parsedBlocks.push(
        makeBlock(
          pageId,
          sort++,
          "numbered",
          inlineMarkdownToHtml(trimmed.replace(/^\d+\.\s+/, ""))
        )
      );
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      parsedBlocks.push(
        makeBlock(
          pageId,
          sort++,
          "quote",
          inlineMarkdownToHtml(trimmed.replace(/^>\s?/, ""))
        )
      );
      i += 1;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (
        i < rawLines.length &&
        rawLines[i].trim().startsWith("|") &&
        rawLines[i].trim().endsWith("|")
      ) {
        tableLines.push(rawLines[i].trim());
        i += 1;
      }

      if (tableLines.length >= 1) {
        const rawHeaderCells = splitGfmTableRowCells(tableLines[0]);
        const headers = rawHeaderCells.map((c) => inlineMarkdownToHtml(c));
        const hasSepRow =
          tableLines.length >= 2 && /^[\s|:-]+$/.test(tableLines[1]);
        const colAlignments: Array<"left" | "center" | "right"> | undefined =
          hasSepRow
            ? splitGfmTableRowCells(tableLines[1]).map((sep) => {
                const s = sep.trim();
                if (s.startsWith(":") && s.endsWith(":")) return "center";
                if (s.endsWith(":")) return "right";
                return "left";
              })
            : undefined;
        const dataStart = hasSepRow ? 2 : 1;
        const rows = tableLines
          .slice(dataStart)
          .map((rStr) =>
            splitGfmTableRowCells(rStr).map((c) => inlineMarkdownToHtml(c))
          );
        parsedBlocks.push(
          makeBlock(pageId, sort++, "table", "", {
            headers,
            rows,
            ...(colAlignments ? { colAlignments } : {}),
          })
        );
      }
      continue;
    }

    parsedBlocks.push(makeBlock(pageId, sort++, "paragraph", inlineMarkdownToHtml(trimmed)));
    i += 1;
  }

  if (parsedBlocks.length === 0) {
    parsedBlocks.push(makeBlock(pageId, 0, "paragraph", ""));
  }

  return parsedBlocks;
}

function parseRfc4180Csv(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      currentRow.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      currentRow.push(field.trim());
      field = "";
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || currentRow.length > 0) {
    currentRow.push(field.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      rows.push(currentRow);
    }
  }
  return rows;
}

const NOTION_SELECT_COLORS = ["blue", "green", "amber", "purple", "red", "gray"];

function populateCsvDatabaseIntoStore(
  store: LocalStore,
  pageId: string,
  csvContent: string
): { rowTitleToRowId: Map<string, DbRow> } {
  const matrix = parseRfc4180Csv(csvContent);
  const rowTitleToRowId = new Map<string, DbRow>();
  if (matrix.length === 0) {
    ensureDatabaseInitialized(store, pageId);
    return { rowTitleToRowId };
  }

  const headers = matrix[0].map((h, idx) => h || `列 ${idx + 1}`);
  const dataRows = matrix.slice(1);
  const ts = nowIso();
  const createdCols: DbColumn[] = [];
  let groupColId: string | null = null;

  headers.forEach((colName, colIdx) => {
    const colId = makeId("col");
    if (colIdx === 0) {
      createdCols.push({
        id: colId,
        pageId,
        name: colName,
        colType: "title",
        options: [],
        width: 240,
        sortOrder: 0,
      });
      return;
    }

    const nonEmpty = dataRows
      .map((r) => (r[colIdx] ?? "").trim())
      .filter((v) => v.length > 0);
    const lowerName = colName.toLowerCase();

    let colType: ColumnType = "text";
    let options: SelectOption[] = [];

    const isBoolVal = (v: string) =>
      /^(yes|no|true|false|checked|unchecked|1|0|是|否)$/i.test(v);
    const isNumVal = (v: string) => /^-?\d+(\.\d+)?$/.test(v);
    const isDateVal = (v: string) =>
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) ||
      /^[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}$/.test(v);
    const isUrlVal = (v: string) => /^https?:\/\//i.test(v);

    if (lowerName === "status" || colName === "状态") {
      colType = "status";
      const distinct = Array.from(new Set(nonEmpty));
      const labels = distinct.length > 0 ? distinct : ["待处理", "进行中", "已完成"];
      options = labels.slice(0, 15).map((lbl, idx) => ({
        id: makeId("opt"),
        label: lbl,
        color: NOTION_SELECT_COLORS[idx % NOTION_SELECT_COLORS.length],
      }));
      if (!groupColId) groupColId = colId;
    } else if (nonEmpty.length > 0 && nonEmpty.every(isBoolVal)) {
      colType = "checkbox";
    } else if (nonEmpty.length > 0 && nonEmpty.every(isNumVal)) {
      colType = "number";
    } else if (nonEmpty.length > 0 && nonEmpty.every(isDateVal)) {
      colType = "date";
    } else if (nonEmpty.length > 0 && nonEmpty.every(isUrlVal)) {
      colType = "url";
    } else if (nonEmpty.length > 0) {
      const distinct = Array.from(new Set(nonEmpty));
      if (distinct.length <= 12 && distinct.every((v) => v.length <= 28)) {
        colType = "select";
        options = distinct.map((lbl, idx) => ({
          id: makeId("opt"),
          label: lbl,
          color: NOTION_SELECT_COLORS[idx % NOTION_SELECT_COLORS.length],
        }));
        if (!groupColId) groupColId = colId;
      }
    }

    createdCols.push({
      id: colId,
      pageId,
      name: colName,
      colType,
      options,
      width: 170,
      sortOrder: colIdx,
    });
  });

  store.dbColumns.push(...createdCols);
  store.dbMeta[pageId] = {
    activeView: "table",
    groupByColId: groupColId,
  };

  dataRows.forEach((rawRow, rIdx) => {
    const cells: Record<string, unknown> = {};
    let rowTitle = "";

    createdCols.forEach((col, cIdx) => {
      const rawVal = (rawRow[cIdx] ?? "").trim();
      if (col.colType === "title") {
        rowTitle = stripNotionUuid(rawVal);
        cells[col.id] = rowTitle;
      } else if (!rawVal) {
        cells[col.id] = col.colType === "checkbox" ? false : "";
      } else if (col.colType === "checkbox") {
        cells[col.id] = /^(yes|true|checked|1|是)$/i.test(rawVal);
      } else if (col.colType === "number") {
        cells[col.id] = Number(rawVal);
      } else if (col.colType === "status" || col.colType === "select") {
        const matched = col.options.find((o) => o.label === rawVal);
        cells[col.id] = matched ? matched.id : rawVal;
      } else {
        cells[col.id] = rawVal;
      }
    });

    const dbRow: DbRow = {
      id: makeId("row"),
      pageId,
      cells,
      linkedPageId: null,
      sortOrder: rIdx,
      createdAt: ts,
      updatedAt: ts,
    };
    store.dbRows.push(dbRow);
    if (rowTitle) {
      rowTitleToRowId.set(rowTitle.toLowerCase(), dbRow);
    }
  });

  return { rowTitleToRowId };
}

function runTreeBatchMigration(
  store: LocalStore,
  entries: MarkdownTreeEntry[],
  parentId: string | null,
  assetDataUris?: Map<string, string>
): BatchImportResult {
  const ts = nowIso();
  const normalizedItems = entries
    .map((e) => {
      const normPath = normalizePosixPath(e.relativePath);
      const extMatch = /\.(md|markdown|txt|csv)$/i.exec(normPath);
      if (!extMatch || normPath.startsWith("__MACOSX/")) return null;
      const ext = extMatch[1].toLowerCase();
      const parts = normPath.split("/");
      const fileName = parts[parts.length - 1];
      const dirParts = parts.slice(0, -1);
      const rawStem = fileName.slice(0, fileName.length - extMatch[0].length);
      const cleanTitle = stripNotionUuid(rawStem);
      const cleanDirParts = dirParts.map(stripNotionUuid);
      const cleanKey = [...cleanDirParts, cleanTitle].join("/").toLowerCase();
      return {
        normPath,
        dirPath: dirParts.join("/"),
        ext,
        cleanTitle,
        cleanDirParts,
        cleanKey,
        depth: parts.length,
        content: e.content,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.ext === "csv" && b.ext !== "csv") return -1;
      if (a.ext !== "csv" && b.ext === "csv") return 1;
      if (a.ext === "csv" && b.ext === "csv") {
        const aIsAll = /_all\.csv$/i.test(a.normPath);
        const bIsAll = /_all\.csv$/i.test(b.normPath);
        if (aIsAll && !bIsAll) return -1;
        if (!aIsAll && bIsAll) return 1;
      }
      return a.normPath.localeCompare(b.normPath);
    });

  // Deduplicate Notion's `<Database>_all.csv` + `<Database>.csv` pair
  const seenDbCleanKeys = new Set<string>();
  const dedupedItems = normalizedItems.filter((item) => {
    if (item.ext !== "csv") return true;
    if (seenDbCleanKeys.has(item.cleanKey)) return false;
    seenDbCleanKeys.add(item.cleanKey);
    return true;
  });

  const cleanAssetLookup = new Map<string, string>();
  if (assetDataUris) {
    for (const [k, v] of assetDataUris.entries()) {
      const cleanK = k
        .split("/")
        .map(stripNotionUuid)
        .join("/")
        .toLowerCase();
      cleanAssetLookup.set(cleanK, v);
    }
  }

  const cleanKeyToPage = new Map<string, Page>();
  const rawNoExtPathToPage = new Map<string, Page>();
  const dbCleanKeyToRowMap = new Map<string, Map<string, DbRow>>();
  const createdDocEntries: Array<{ page: Page; dirPath: string }> = [];

  let importedPages = 0;
  let importedDatabases = 0;
  let importedBlocks = 0;
  const rootPageIds: string[] = [];

  const ensureFolderChain = (cleanFolders: string[]): string | null => {
    let curParent = parentId;
    const prefix: string[] = [];
    for (const folderName of cleanFolders) {
      prefix.push(folderName);
      const folderKey = prefix.join("/").toLowerCase();
      const existing = cleanKeyToPage.get(folderKey);
      if (existing) {
        curParent = existing.id;
        continue;
      }

      const siblings = store.pages.filter((p) => p.parentId === curParent && !p.isTrashed);
      const nextSort =
        siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
      const folderPage: Page = {
        id: makeId("page"),
        parentId: curParent,
        title: folderName,
        icon: "📁",
        cover: null,
        pageType: "doc",
        isFavorite: false,
        isTrashed: false,
        sortOrder: nextSort,
        createdAt: ts,
        updatedAt: ts,
      };
      store.pages.push(folderPage);
      store.blocks.push(makeBlock(folderPage.id, 0, "paragraph", ""));
      importedPages += 1;
      importedBlocks += 1;
      if (curParent === parentId) {
        rootPageIds.push(folderPage.id);
      }
      cleanKeyToPage.set(folderKey, folderPage);
      curParent = folderPage.id;
    }
    return curParent;
  };

  for (const item of dedupedItems) {
    const resolvedParentId = ensureFolderChain(item.cleanDirParts);
    const isDb = item.ext === "csv";

    // Extract H1 title & stripped body consistently for both fresh and coalesced doc pages
    let finalTitle = item.cleanTitle;
    let bodyMarkdown = item.content;
    if (!isDb) {
      const trimmedLines = item.content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .split("\n");
      if (trimmedLines.length > 0 && /^#\s+/.test(trimmedLines[0].trim())) {
        const h1Title = trimmedLines[0].trim().replace(/^#\s+/, "").trim();
        if (h1Title) finalTitle = h1Title;
        bodyMarkdown = trimmedLines.slice(1).join("\n");
      }
    }

    // Coalesce if a container page was already created for this exact cleanKey
    let targetPage = cleanKeyToPage.get(item.cleanKey);
    if (targetPage && !isDb && targetPage.icon === "📁") {
      targetPage.icon = "📄";
      targetPage.title = finalTitle || "无标题";
      store.blocks = store.blocks.filter((b) => b.pageId !== targetPage!.id);
      importedBlocks = Math.max(0, importedBlocks - 1);

      const blocks = parseMarkdownStringToBlocks(
        targetPage.id,
        bodyMarkdown,
        assetDataUris,
        item.dirPath,
        cleanAssetLookup
      );
      store.blocks.push(...blocks);
      importedBlocks += blocks.length;
      createdDocEntries.push({ page: targetPage, dirPath: item.dirPath });
    } else {
      const siblings = store.pages.filter(
        (p) => p.parentId === resolvedParentId && !p.isTrashed
      );
      const nextSort =
        siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;

      targetPage = {
        id: makeId("page"),
        parentId: resolvedParentId,
        title: finalTitle || "无标题",
        icon: isDb ? "🗃️" : "📄",
        cover: null,
        pageType: isDb ? "database" : "doc",
        isFavorite: false,
        isTrashed: false,
        sortOrder: nextSort,
        createdAt: ts,
        updatedAt: ts,
      };
      store.pages.push(targetPage);
      if (isDb) {
        importedDatabases += 1;
      } else {
        importedPages += 1;
      }
      if (resolvedParentId === parentId) {
        rootPageIds.push(targetPage.id);
      }

      if (!isDb) {
        const blocks = parseMarkdownStringToBlocks(
          targetPage.id,
          bodyMarkdown,
          assetDataUris,
          item.dirPath,
          cleanAssetLookup
        );
        store.blocks.push(...blocks);
        importedBlocks += blocks.length;
        createdDocEntries.push({ page: targetPage, dirPath: item.dirPath });
      } else {
        const { rowTitleToRowId } = populateCsvDatabaseIntoStore(
          store,
          targetPage.id,
          item.content
        );
        dbCleanKeyToRowMap.set(item.cleanKey, rowTitleToRowId);
      }
    }

    cleanKeyToPage.set(item.cleanKey, targetPage);
    const noExtRaw = item.normPath.replace(/\.(md|markdown|txt|csv)$/i, "").toLowerCase();
    rawNoExtPathToPage.set(noExtRaw, targetPage);

    // Link CSV row -> child row .md page if parent folder matches a CSV database
    if (!isDb && item.cleanDirParts.length > 0) {
      const parentCleanKey = item.cleanDirParts.join("/").toLowerCase();
      const rowMap = dbCleanKeyToRowMap.get(parentCleanKey);
      const matchedRow = rowMap?.get(targetPage.title.toLowerCase()) ?? rowMap?.get(item.cleanTitle.toLowerCase());
      if (matchedRow && !matchedRow.linkedPageId) {
        matchedRow.linkedPageId = targetPage.id;
      }
    }
  }

  // Second pass: rewrite relative .md links -> internal nb-wiki-link + rebuild backlinks
  let resolvedLinks = 0;
  const rewriteRelLinksInHtml = (
    html: string,
    dirPath: string,
    ownerPageId: string
  ): string => {
    if (!html || !html.includes("data-md-rel-href=")) return html;
    return html.replace(
      /<a\s+href="([^"]+)"\s+data-md-rel-href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      (full, _href: string, rawRel: string, innerLabel: string) => {
        const resolvedRel = resolveRelativeAssetPath(dirPath, rawRel);
        if (!/\.(md|markdown|csv)$/i.test(resolvedRel)) {
          return full;
        }
        const noExt = resolvedRel.replace(/\.(md|markdown|csv)$/i, "");
        const directTarget = rawNoExtPathToPage.get(noExt.toLowerCase());
        const cleanTargetKey = noExt
          .split("/")
          .map(stripNotionUuid)
          .join("/")
          .toLowerCase();
        const target =
          directTarget ??
          cleanKeyToPage.get(cleanTargetKey) ??
          Array.from(cleanKeyToPage.values()).find(
            (p) =>
              p.title.toLowerCase() ===
              stripNotionUuid(noExt.split("/").pop() || "").toLowerCase()
          );

        if (!target || target.id === ownerPageId) {
          return innerLabel;
        }
        resolvedLinks += 1;
        return `<a href="#" data-page-id="${target.id}" class="nb-wiki-link">${target.icon || "📄"} ${escapeHtml(target.title)}</a>`;
      }
    );
  };

  for (const { page, dirPath } of createdDocEntries) {
    const pageBlocks = store.blocks.filter((b) => b.pageId === page.id);
    for (const blk of pageBlocks) {
      if (isRawTextBlockType(blk.blockType)) {
        continue;
      }
      if (blk.blockType === "table") {
        if (blk.props.headers) {
          blk.props.headers = blk.props.headers.map((h) =>
            rewriteRelLinksInHtml(h, dirPath, page.id)
          );
        }
        if (blk.props.rows) {
          blk.props.rows = blk.props.rows.map((row) =>
            row.map((c) => rewriteRelLinksInHtml(c, dirPath, page.id))
          );
        }
        blk.plainText = getEffectiveBlockPlainText({ ...blk, plainText: "" });
        continue;
      }
      if (!blk.content.includes("data-md-rel-href=")) {
        continue;
      }
      blk.content = rewriteRelLinksInHtml(blk.content, dirPath, page.id);
      blk.plainText = getEffectiveBlockPlainText({ ...blk, plainText: "" });
    }
    rebuildAllLinksForSource(store, page.id);
  }

  saveStore(store);

  return {
    importedPages,
    importedDatabases,
    importedBlocks,
    resolvedLinks,
    rootPageIds,
    firstPageId: rootPageIds[0] ?? createdDocEntries[0]?.page.id ?? null,
  };
}

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.split(",")[1] : b64;
  const bin = atob(clean.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/* ============================================================================
 * Public Typed API Client (Tauri v2 IPC + Browser Fallback)
 * ========================================================================== */

export async function listPages(): Promise<Page[]> {
  if (isTauriRuntime()) {
    return invoke<Page[]>("list_pages");
  }
  const store = loadStore();
  return store.pages
    .filter((p) => !p.isTrashed)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
    .map((p) => ({ ...p }));
}

export async function listTrashedPages(): Promise<Page[]> {
  if (isTauriRuntime()) {
    return invoke<Page[]>("list_trashed_pages");
  }
  const store = loadStore();
  return store.pages
    .filter((p) => p.isTrashed)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((p) => ({ ...p }));
}

export async function getPageDetail(id: string): Promise<PageDetail> {
  if (isTauriRuntime()) {
    return invoke<PageDetail>("get_page_detail", { id });
  }
  const store = loadStore();
  const page = store.pages.find((p) => p.id === id);
  if (!page) {
    throw new Error(`未找到页面 (${id})`);
  }

  const blocks = store.blocks
    .filter((b) => b.pageId === id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => ({ ...b, props: { ...b.props } }));

  const breadcrumbs: BreadcrumbItem[] = [];
  const visited = new Set<string>();
  let cursor: Page | undefined = page;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    breadcrumbs.unshift({
      id: cursor.id,
      title: cursor.title,
      icon: cursor.icon,
    });
    cursor = cursor.parentId
      ? store.pages.find((p) => p.id === cursor!.parentId && !p.isTrashed)
      : undefined;
  }

  const backlinks: BacklinkItem[] = store.pageLinks
    .filter((l) => l.targetPageId === id)
    .map((l) => {
      const src = store.pages.find((p) => p.id === l.sourcePageId && !p.isTrashed);
      if (!src) return null;
      return {
        sourcePageId: src.id,
        sourceTitle: src.title,
        sourceIcon: src.icon,
        excerpt: l.excerpt,
      };
    })
    .filter((item): item is BacklinkItem => item !== null);

  const children = store.pages
    .filter((p) => p.parentId === id && !p.isTrashed)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((p) => ({ ...p }));

  return {
    page: { ...page },
    blocks,
    breadcrumbs,
    backlinks,
    children,
  };
}

export async function createPage(input: CreatePageInput): Promise<Page> {
  if (isTauriRuntime()) {
    return invoke<Page>("create_page", { input });
  }
  const store = loadStore();
  const ts = nowIso();
  const parentId = input.parentId ?? null;
  const siblings = store.pages.filter((p) => p.parentId === parentId && !p.isTrashed);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
  const pageType = input.pageType ?? "doc";

  const newPage: Page = {
    id: makeId("page"),
    parentId,
    title: input.title?.trim() || "无标题",
    icon: input.icon || (pageType === "database" ? "🗃️" : "📄"),
    cover: input.cover ?? null,
    pageType,
    isFavorite: false,
    isTrashed: false,
    sortOrder: nextSort,
    createdAt: ts,
    updatedAt: ts,
  };

  store.pages.push(newPage);

  if (input.templateId) {
    applyTemplateToPage(store, newPage, input.templateId);
  } else if (newPage.pageType === "doc") {
    store.blocks.push(makeBlock(newPage.id, 0, "paragraph", ""));
  } else {
    ensureDatabaseInitialized(store, newPage.id);
  }

  saveStore(store);
  return { ...newPage };
}

export async function updatePage(id: string, patch: UpdatePagePatch): Promise<Page> {
  if (isTauriRuntime()) {
    return invoke<Page>("update_page", { id, patch });
  }
  const store = loadStore();
  const page = store.pages.find((p) => p.id === id);
  if (!page) throw new Error(`未找到页面 (${id})`);

  if (patch.title !== undefined) page.title = patch.title;
  if (patch.icon !== undefined) page.icon = patch.icon;
  if (patch.cover !== undefined) page.cover = patch.cover;
  if (patch.isFavorite !== undefined) page.isFavorite = patch.isFavorite;
  if (patch.parentId !== undefined && patch.parentId !== id) page.parentId = patch.parentId;
  if (patch.sortOrder !== undefined) page.sortOrder = patch.sortOrder;
  page.updatedAt = nowIso();

  saveStore(store);
  return { ...page };
}

export async function trashPage(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("trash_page", { id });
  }
  const store = loadStore();
  const ts = nowIso();
  const collectDescendants = (targetId: string, acc: Set<string>) => {
    acc.add(targetId);
    for (const child of store.pages) {
      if (child.parentId === targetId && !acc.has(child.id)) {
        collectDescendants(child.id, acc);
      }
    }
  };
  const toTrash = new Set<string>();
  collectDescendants(id, toTrash);
  for (const p of store.pages) {
    if (toTrash.has(p.id)) {
      p.isTrashed = true;
      p.updatedAt = ts;
    }
  }
  saveStore(store);
}

export async function restorePage(id: string): Promise<Page> {
  if (isTauriRuntime()) {
    return invoke<Page>("restore_page", { id });
  }
  const store = loadStore();
  const target = store.pages.find((p) => p.id === id);
  if (!target) throw new Error(`未找到页面 (${id})`);

  const ts = nowIso();
  if (target.parentId) {
    const parent = store.pages.find((p) => p.id === target.parentId);
    if (!parent || parent.isTrashed) {
      target.parentId = null;
    }
  }

  const restoreTree = (nodeId: string) => {
    const node = store.pages.find((p) => p.id === nodeId);
    if (!node) return;
    node.isTrashed = false;
    node.updatedAt = ts;
    for (const child of store.pages) {
      if (child.parentId === nodeId && child.isTrashed) {
        restoreTree(child.id);
      }
    }
  };
  restoreTree(id);
  saveStore(store);
  return { ...target };
}

export async function deletePagePermanently(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("delete_page_permanently", { id });
  }
  const store = loadStore();
  const toDelete = new Set<string>();
  const collect = (nodeId: string) => {
    toDelete.add(nodeId);
    for (const p of store.pages) {
      if (p.parentId === nodeId && !toDelete.has(p.id)) collect(p.id);
    }
  };
  collect(id);

  store.pages = store.pages.filter((p) => !toDelete.has(p.id));
  store.blocks = store.blocks.filter((b) => !toDelete.has(b.pageId));
  store.pageLinks = store.pageLinks.filter(
    (l) => !toDelete.has(l.sourcePageId) && !toDelete.has(l.targetPageId)
  );
  store.dbColumns = store.dbColumns.filter((c) => !toDelete.has(c.pageId));
  store.dbRows = store.dbRows
    .filter((r) => !toDelete.has(r.pageId))
    .map((r) =>
      r.linkedPageId && toDelete.has(r.linkedPageId)
        ? { ...r, linkedPageId: null }
        : r
    );
  for (const delId of toDelete) {
    delete store.dbMeta[delId];
  }
  saveStore(store);
}

export async function emptyTrash(): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("empty_trash");
  }
  const store = loadStore();
  const trashedIds = new Set(store.pages.filter((p) => p.isTrashed).map((p) => p.id));
  store.pages = store.pages.filter((p) => !trashedIds.has(p.id));
  store.blocks = store.blocks.filter((b) => !trashedIds.has(b.pageId));
  store.pageLinks = store.pageLinks.filter(
    (l) => !trashedIds.has(l.sourcePageId) && !trashedIds.has(l.targetPageId)
  );
  store.dbColumns = store.dbColumns.filter((c) => !trashedIds.has(c.pageId));
  store.dbRows = store.dbRows
    .filter((r) => !trashedIds.has(r.pageId))
    .map((r) =>
      r.linkedPageId && trashedIds.has(r.linkedPageId)
        ? { ...r, linkedPageId: null }
        : r
    );
  for (const delId of trashedIds) {
    delete store.dbMeta[delId];
  }
  saveStore(store);
}

export async function duplicatePage(id: string): Promise<Page> {
  if (isTauriRuntime()) {
    return invoke<Page>("duplicate_page", { id });
  }
  const store = loadStore();
  const orig = store.pages.find((p) => p.id === id);
  if (!orig) throw new Error(`未找到页面 (${id})`);

  const ts = nowIso();
  const copyId = makeId("page");
  const siblings = store.pages.filter((p) => p.parentId === orig.parentId && !p.isTrashed);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;

  const copyPage: Page = {
    ...orig,
    id: copyId,
    title: `${orig.title} (副本)`,
    isFavorite: false,
    isTrashed: false,
    sortOrder: nextSort,
    createdAt: ts,
    updatedAt: ts,
  };
  store.pages.push(copyPage);

  if (orig.pageType === "doc") {
    const origBlocks = store.blocks
      .filter((b) => b.pageId === orig.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const b of origBlocks) {
      store.blocks.push({
        ...b,
        id: makeId("blk"),
        pageId: copyId,
        props: JSON.parse(JSON.stringify(b.props)) as BlockProps,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    rebuildAllLinksForSource(store, copyId);
  } else {
    const colIdMap = new Map<string, string>();
    const origCols = store.dbColumns
      .filter((c) => c.pageId === orig.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const c of origCols) {
      const newColId = makeId("col");
      colIdMap.set(c.id, newColId);
      store.dbColumns.push({
        ...c,
        id: newColId,
        pageId: copyId,
        options: c.options.map((o) => ({ ...o })),
      });
    }
    const origMeta = store.dbMeta[orig.id];
    if (origMeta) {
      store.dbMeta[copyId] = {
        activeView: origMeta.activeView,
        groupByColId: origMeta.groupByColId
          ? colIdMap.get(origMeta.groupByColId) ?? null
          : null,
      };
    }
    const origRows = store.dbRows
      .filter((r) => r.pageId === orig.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const r of origRows) {
      const mappedCells: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.cells)) {
        const mappedKey = colIdMap.get(k) ?? k;
        mappedCells[mappedKey] = JSON.parse(JSON.stringify(v));
      }
      store.dbRows.push({
        ...r,
        id: makeId("row"),
        pageId: copyId,
        cells: mappedCells,
        linkedPageId: null,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  saveStore(store);
  return { ...copyPage };
}

export async function upsertBlock(block: UpsertBlockInput): Promise<Block> {
  if (isTauriRuntime()) {
    return invoke<Block>("upsert_block", { block });
  }
  const store = loadStore();
  const ts = nowIso();
  const existing = block.id ? store.blocks.find((b) => b.id === block.id) : undefined;
  let saved: Block;

  if (existing) {
    existing.blockType = block.blockType;
    existing.content = block.content;
    existing.plainText = isRawTextBlockType(block.blockType)
      ? block.content
      : block.plainText;
    existing.props = { ...block.props };
    existing.sortOrder = block.sortOrder;
    existing.updatedAt = ts;
    saved = { ...existing, props: { ...existing.props } };
  } else {
    saved = {
      id: block.id || makeId("blk"),
      pageId: block.pageId,
      blockType: block.blockType,
      content: block.content,
      plainText: isRawTextBlockType(block.blockType)
        ? block.content
        : block.plainText,
      props: { ...block.props },
      sortOrder: block.sortOrder,
      createdAt: ts,
      updatedAt: ts,
    };
    store.blocks.push(saved);
  }

  const page = store.pages.find((p) => p.id === block.pageId);
  if (page) page.updatedAt = ts;

  rebuildAllLinksForSource(store, block.pageId);
  saveStore(store);
  return saved;
}

export async function savePageBlocks(
  pageId: string,
  blocks: SaveBlockItem[]
): Promise<Block[]> {
  if (isTauriRuntime()) {
    return invoke<Block[]>("save_page_blocks", { pageId, blocks });
  }
  const store = loadStore();
  const ts = nowIso();
  const existingMap = new Map(
    store.blocks.filter((b) => b.pageId === pageId).map((b) => [b.id, b])
  );

  store.blocks = store.blocks.filter((b) => b.pageId !== pageId);

  const nextBlocks: Block[] = blocks.map((item, idx) => {
    const prev = existingMap.get(item.id);
    return {
      id: item.id || makeId("blk"),
      pageId,
      blockType: item.blockType,
      content: item.content,
      plainText: isRawTextBlockType(item.blockType)
        ? item.content
        : item.plainText,
      props: { ...item.props },
      sortOrder: item.sortOrder ?? idx,
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
  });

  store.blocks.push(...nextBlocks);
  const page = store.pages.find((p) => p.id === pageId);
  if (page) page.updatedAt = ts;

  rebuildAllLinksForSource(store, pageId);
  saveStore(store);
  return nextBlocks.map((b) => ({ ...b, props: { ...b.props } }));
}

export async function deleteBlock(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("delete_block", { id });
  }
  const store = loadStore();
  const target = store.blocks.find((b) => b.id === id);
  store.blocks = store.blocks.filter((b) => b.id !== id);
  if (target) {
    rebuildAllLinksForSource(store, target.pageId);
  }
  saveStore(store);
}

export async function getDatabase(pageId: string): Promise<DatabaseFull> {
  if (isTauriRuntime()) {
    return invoke<DatabaseFull>("get_database", { pageId });
  }
  const store = loadStore();
  return ensureDatabaseInitialized(store, pageId);
}

export async function updateDatabaseView(
  pageId: string,
  activeView: "table" | "board" | "gallery",
  groupByColId?: string | null
): Promise<DatabaseFull> {
  if (isTauriRuntime()) {
    return invoke<DatabaseFull>("update_database_view", {
      pageId,
      activeView,
      groupByColId: groupByColId ?? null,
    });
  }
  const store = loadStore();
  store.dbMeta[pageId] = {
    activeView,
    groupByColId: groupByColId ?? null,
  };
  saveStore(store);
  return ensureDatabaseInitialized(store, pageId);
}

export async function upsertDbColumn(column: UpsertDbColumnInput): Promise<DbColumn> {
  if (isTauriRuntime()) {
    return invoke<DbColumn>("upsert_db_column", { column });
  }
  const store = loadStore();
  const existing = column.id ? store.dbColumns.find((c) => c.id === column.id) : undefined;
  if (existing) {
    existing.name = column.name;
    existing.colType = column.colType;
    existing.options = column.options.map((o) => ({ ...o }));
    if (column.width !== undefined) existing.width = column.width;
    if (column.sortOrder !== undefined) existing.sortOrder = column.sortOrder;
    saveStore(store);
    return { ...existing, options: existing.options.map((o) => ({ ...o })) };
  }

  const pageCols = store.dbColumns.filter((c) => c.pageId === column.pageId);
  const nextSort =
    column.sortOrder ??
    (pageCols.length > 0 ? Math.max(...pageCols.map((c) => c.sortOrder)) + 1 : 0);

  const created: DbColumn = {
    id: column.id || makeId("col"),
    pageId: column.pageId,
    name: column.name,
    colType: column.colType,
    options: column.options.map((o) => ({ ...o })),
    width: column.width ?? 180,
    sortOrder: nextSort,
  };
  store.dbColumns.push(created);
  saveStore(store);
  return { ...created, options: created.options.map((o) => ({ ...o })) };
}

export async function deleteDbColumn(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("delete_db_column", { id });
  }
  const store = loadStore();
  const target = store.dbColumns.find((c) => c.id === id);
  store.dbColumns = store.dbColumns.filter((c) => c.id !== id);
  if (target) {
    for (const row of store.dbRows) {
      if (row.pageId === target.pageId && id in row.cells) {
        delete row.cells[id];
      }
    }
    const meta = store.dbMeta[target.pageId];
    if (meta && meta.groupByColId === id) {
      meta.groupByColId =
        store.dbColumns.find(
          (c) =>
            c.pageId === target.pageId &&
            (c.colType === "status" || c.colType === "select")
        )?.id ?? null;
    }
  }
  saveStore(store);
}

export async function upsertDbRow(row: UpsertDbRowInput): Promise<DbRow> {
  if (isTauriRuntime()) {
    return invoke<DbRow>("upsert_db_row", { row });
  }
  const store = loadStore();
  const ts = nowIso();
  const existing = row.id ? store.dbRows.find((r) => r.id === row.id) : undefined;
  if (existing) {
    existing.cells = { ...row.cells };
    if (row.linkedPageId !== undefined) existing.linkedPageId = row.linkedPageId;
    if (row.sortOrder !== undefined) existing.sortOrder = row.sortOrder;
    existing.updatedAt = ts;
    saveStore(store);
    return { ...existing, cells: { ...existing.cells } };
  }

  const pageRows = store.dbRows.filter((r) => r.pageId === row.pageId);
  const nextSort =
    row.sortOrder ??
    (pageRows.length > 0 ? Math.max(...pageRows.map((r) => r.sortOrder)) + 1 : 0);

  const created: DbRow = {
    id: row.id || makeId("row"),
    pageId: row.pageId,
    cells: { ...row.cells },
    linkedPageId: row.linkedPageId ?? null,
    sortOrder: nextSort,
    createdAt: ts,
    updatedAt: ts,
  };
  store.dbRows.push(created);
  saveStore(store);
  return { ...created, cells: { ...created.cells } };
}

export async function deleteDbRow(id: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("delete_db_row", { id });
  }
  const store = loadStore();
  store.dbRows = store.dbRows.filter((r) => r.id !== id);
  saveStore(store);
}

export async function searchWorkspace(query: string): Promise<SearchResult[]> {
  if (isTauriRuntime()) {
    return invoke<SearchResult[]>("search_workspace", { query });
  }
  const store = loadStore();
  const q = query.trim().toLowerCase();
  const activePages = store.pages.filter((p) => !p.isTrashed);

  if (!q) {
    return activePages
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 15)
      .map((p) => ({
        pageId: p.id,
        pageTitle: p.title,
        pageIcon: p.icon,
        pageType: p.pageType,
        blockId: null,
        snippet: p.pageType === "database" ? "多维数据库页面" : "最近访问的文档页面",
        updatedAt: p.updatedAt,
      }));
  }

  const tokens = q.split(/\s+/).filter(Boolean);
  const matchesAll = (text: string) => {
    const lower = text.toLowerCase();
    return tokens.every((t) => lower.includes(t));
  };

  const results: SearchResult[] = [];
  const seenPages = new Set<string>();

  for (const p of activePages) {
    if (matchesAll(p.title)) {
      seenPages.add(p.id);
      results.push({
        pageId: p.id,
        pageTitle: p.title,
        pageIcon: p.icon,
        pageType: p.pageType,
        blockId: null,
        snippet: p.title,
        updatedAt: p.updatedAt,
      });
    }
  }

  for (const b of store.blocks) {
    const p = activePages.find((pg) => pg.id === b.pageId);
    if (!p) continue;
    const text = getEffectiveBlockPlainText(b);
    if (text && matchesAll(text)) {
      results.push({
        pageId: p.id,
        pageTitle: p.title,
        pageIcon: p.icon,
        pageType: p.pageType,
        blockId: b.id,
        snippet: text.slice(0, 120),
        updatedAt: b.updatedAt,
      });
    }
  }

  for (const r of store.dbRows) {
    const p = activePages.find((pg) => pg.id === r.pageId);
    if (!p || seenPages.has(`${p.id}:${r.id}`)) continue;
    const cellText = Object.values(r.cells)
      .filter((v) => typeof v === "string" || typeof v === "number")
      .join(" ");
    if (cellText && matchesAll(cellText)) {
      seenPages.add(`${p.id}:${r.id}`);
      results.push({
        pageId: p.id,
        pageTitle: p.title,
        pageIcon: p.icon,
        pageType: p.pageType,
        blockId: null,
        snippet: cellText.slice(0, 120),
        updatedAt: r.updatedAt,
      });
    }
  }

  return results.slice(0, 30);
}

export async function exportPageMarkdown(id: string): Promise<MarkdownExport> {
  if (isTauriRuntime()) {
    return invoke<MarkdownExport>("export_page_markdown", { id });
  }
  const store = loadStore();
  const page = store.pages.find((p) => p.id === id);
  if (!page) throw new Error(`未找到页面 (${id})`);

  const lines: string[] = [`# ${page.icon} ${page.title}`, ""];

  if (page.pageType === "database") {
    const db = ensureDatabaseInitialized(store, page.id);
    if (db.columns.length > 0) {
      lines.push(`| ${db.columns.map((c) => c.name).join(" | ")} |`);
      lines.push(`| ${db.columns.map(() => "---").join(" | ")} |`);
      for (const r of db.rows) {
        const vals = db.columns.map((col) => {
          const raw = r.cells[col.id];
          if (raw === null || raw === undefined) return "";
          if (col.colType === "status" || col.colType === "select") {
            const opt = col.options.find((o) => o.id === raw || o.label === raw);
            return opt ? opt.label : String(raw);
          }
          if (col.colType === "multi_select" && Array.isArray(raw)) {
            return raw
              .map((item) => col.options.find((o) => o.id === item)?.label ?? String(item))
              .join(", ");
          }
          if (col.colType === "checkbox") {
            return raw ? "✅" : "⬜";
          }
          return String(raw).replace(/\|/g, "\\|");
        });
        lines.push(`| ${vals.join(" | ")} |`);
      }
    }
  } else {
    const blocks = store.blocks
      .filter((b) => b.pageId === page.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    let numCounter = 0;
    for (const b of blocks) {
      if (b.blockType !== "numbered") numCounter = 0;
      const text = isRawTextBlockType(b.blockType)
        ? b.content || b.plainText
        : htmlToInlineMarkdown(b.content) || b.plainText || stripHtml(b.content);

      switch (b.blockType) {
        case "heading1":
          lines.push(`# ${text}`, "");
          break;
        case "heading2":
          lines.push(`## ${text}`, "");
          break;
        case "heading3":
          lines.push(`### ${text}`, "");
          break;
        case "todo":
          lines.push(`- [${b.props.checked ? "x" : " "}] ${text}`);
          break;
        case "bullet":
          lines.push(`- ${text}`);
          break;
        case "numbered":
          numCounter += 1;
          lines.push(`${numCounter}. ${text}`);
          break;
        case "quote":
          lines.push(`> ${text}`, "");
          break;
        case "callout":
          lines.push(`> ${b.props.calloutIcon || "💡"} ${text}`, "");
          break;
        case "toggle":
          lines.push(`- **${text}**`);
          if (b.props.childrenText) {
            for (const sub of b.props.childrenText.split("\n")) {
              lines.push(`  ${sub}`);
            }
          }
          break;
        case "code":
          lines.push(`\`\`\`${b.props.language || ""}`, b.content || b.plainText, "```", "");
          break;
        case "mermaid":
          lines.push("```mermaid", b.content || b.plainText, "```", "");
          break;
        case "math":
          lines.push("$$", b.content || b.plainText, "$$", "");
          break;
        case "image": {
          const imgUrl = b.props.url || b.content || "";
          const cap = b.props.caption || "";
          lines.push(`![${cap}](${imgUrl})`, "");
          break;
        }
        case "bookmark": {
          const bmUrl = b.props.url || b.content || "";
          const bmTitle = b.props.bookmarkTitle || b.plainText || bmUrl;
          lines.push(`[${bmTitle}](${bmUrl})`, "");
          break;
        }
        case "embed": {
          const emUrl = b.props.url || b.content || "";
          const emTitle = b.props.caption || b.props.embedProvider || "Embed";
          lines.push(`[${emTitle}](${emUrl})`, "");
          break;
        }
        case "divider":
          lines.push("---", "");
          break;
        case "table": {
          lines.push(...formatGfmTableExportLines(b.props), "");
          break;
        }
        default:
          lines.push(text, "");
          break;
      }
    }
  }

  const safeName =
    page.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "Untitled";
  return {
    filename: `${safeName}.md`,
    markdown: lines.join("\n").trim() + "\n",
  };
}

export async function importMarkdownPage(
  title: string,
  markdown: string,
  parentId?: string | null
): Promise<Page> {
  if (isTauriRuntime()) {
    return invoke<Page>("import_markdown_page", {
      title,
      markdown,
      parentId: parentId ?? null,
    });
  }
  const store = loadStore();
  const ts = nowIso();
  const normalizedParent = parentId ?? null;
  const siblings = store.pages.filter((p) => p.parentId === normalizedParent && !p.isTrashed);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;

  let derivedTitle = title.trim();
  const rawLines = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");

  if (!derivedTitle) {
    const firstH1 = rawLines.find((l) => /^#\s+/.test(l.trim()));
    derivedTitle = firstH1 ? firstH1.replace(/^#\s+/, "").trim() : "导入的 Markdown 页面";
  }

  const page: Page = {
    id: makeId("page"),
    parentId: normalizedParent,
    title: derivedTitle,
    icon: "📄",
    cover: null,
    pageType: "doc",
    isFavorite: false,
    isTrashed: false,
    sortOrder: nextSort,
    createdAt: ts,
    updatedAt: ts,
  };
  store.pages.push(page);

  const parsedBlocks = parseMarkdownStringToBlocks(page.id, markdown);
  store.blocks.push(...parsedBlocks);
  rebuildAllLinksForSource(store, page.id);
  saveStore(store);
  return { ...page };
}

export async function importLocalPaths(
  paths: string[],
  parentId?: string | null
): Promise<BatchImportResult> {
  if (isTauriRuntime()) {
    return invoke<BatchImportResult>("import_local_paths", {
      paths,
      parentId: parentId ?? null,
    });
  }
  return {
    importedPages: 0,
    importedDatabases: 0,
    importedBlocks: 0,
    resolvedLinks: 0,
    rootPageIds: [],
    firstPageId: null,
  };
}

export async function importMarkdownTree(
  entries: MarkdownTreeEntry[],
  parentId?: string | null
): Promise<BatchImportResult> {
  if (isTauriRuntime()) {
    return invoke<BatchImportResult>("import_markdown_tree", {
      entries,
      parentId: parentId ?? null,
    });
  }
  const store = loadStore();
  return runTreeBatchMigration(store, entries, parentId ?? null);
}

export async function importNotionZipBytes(
  zipBase64: string,
  parentId?: string | null
): Promise<BatchImportResult> {
  if (isTauriRuntime()) {
    return invoke<BatchImportResult>("import_notion_zip_bytes", {
      zipBase64,
      parentId: parentId ?? null,
    });
  }

  const outerBytes = base64ToUint8Array(zipBase64);
  const decoder = new TextDecoder("utf-8");
  const textEntries: MarkdownTreeEntry[] = [];
  const assetDataUris = new Map<string, string>();

  const extractArchive = (archiveBytes: Uint8Array, prefix = "", depth = 0) => {
    if (depth > 3) return;
    const files = unzipSync(archiveBytes);
    for (const [entryPath, fileBytes] of Object.entries(files)) {
      if (!fileBytes || entryPath.endsWith("/") || entryPath.includes("__MACOSX")) {
        continue;
      }
      const norm = normalizePosixPath(prefix ? `${prefix}/${entryPath}` : entryPath);
      const lower = norm.toLowerCase();

      if (lower.endsWith(".zip")) {
        extractArchive(fileBytes, "", depth + 1);
        continue;
      }

      if (/\.(md|markdown|txt|csv)$/i.test(lower)) {
        textEntries.push({
          relativePath: norm,
          content: decoder.decode(fileBytes),
        });
        continue;
      }

      const imgExtMatch = /\.(png|jpe?g|gif|webp|svg)$/i.exec(lower);
      if (imgExtMatch && fileBytes.byteLength <= 2 * 1024 * 1024) {
        const ext = imgExtMatch[1].toLowerCase();
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : `image/${ext}`;
        assetDataUris.set(lower, `data:${mime};base64,${uint8ArrayToBase64(fileBytes)}`);
      }
    }
  };

  extractArchive(outerBytes);
  unwrapSyntheticExportRoot(textEntries, assetDataUris);

  const store = loadStore();
  return runTreeBatchMigration(store, textEntries, parentId ?? null, assetDataUris);
}

function unwrapSyntheticExportRoot(
  textEntries: MarkdownTreeEntry[],
  assetDataUris: Map<string, string>
): void {
  if (textEntries.length === 0) return;
  let wrapperCandidate: string | null = null;
  for (const entry of textEntries) {
    const slashIdx = entry.relativePath.indexOf("/");
    if (slashIdx <= 0) return;
    const first = entry.relativePath.slice(0, slashIdx);
    if (!first.startsWith("Export-")) return;
    if (wrapperCandidate === null) {
      wrapperCandidate = first;
    } else if (wrapperCandidate !== first) {
      return;
    }
  }
  if (!wrapperCandidate) return;
  const prefix = `${wrapperCandidate}/`;
  const prefixLower = prefix.toLowerCase();

  for (const entry of textEntries) {
    if (entry.relativePath.startsWith(prefix)) {
      entry.relativePath = entry.relativePath.slice(prefix.length);
    }
  }

  const oldAssets = Array.from(assetDataUris.entries());
  assetDataUris.clear();
  for (const [k, v] of oldAssets) {
    if (k.startsWith(prefixLower)) {
      assetDataUris.set(k.slice(prefixLower.length), v);
    } else {
      assetDataUris.set(k, v);
    }
  }
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  if (isTauriRuntime()) {
    return invoke<UrlMetadata>("fetch_url_metadata", { url });
  }
  const raw = url.trim();
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProto);
    const cleanHost = parsed.hostname.replace(/^www\./i, "");
    const pathSlug = parsed.pathname
      .split("/")
      .filter(Boolean)
      .pop();
    const readableSlug = pathSlug
      ? decodeURIComponent(pathSlug).replace(/[-_]+/g, " ")
      : "";
    const title = readableSlug ? `${readableSlug} — ${cleanHost}` : cleanHost;
    return {
      url: parsed.href,
      title,
      description: parsed.href,
      siteName: cleanHost,
      favicon: `${parsed.origin}/favicon.ico`,
    };
  } catch {
    return {
      url: withProto,
      title: raw || "外部链接",
      description: withProto,
      siteName: "Web",
      favicon: "",
    };
  }
}

export async function getSettings(): Promise<Record<string, string>> {
  if (isTauriRuntime()) {
    return invoke<Record<string, string>>("get_settings");
  }
  const store = loadStore();
  return { ...store.settings };
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("set_setting", { key, value });
  }
  const store = loadStore();
  store.settings[key] = value;
  saveStore(store);
}

/* ============================================================================
 * Commercial v0.2.0: Portable Storage, Backups, Assets & Direct .md Workflow
 * ========================================================================== */

const BROWSER_STORAGE_CFG_KEY = "notion_desktop_storage_cfg_v1";
const BROWSER_BACKUPS_KEY = "notion_desktop_backups_v1";
const BROWSER_LOCAL_MD_MAP_KEY = "notion_desktop_local_mds_v1";
const SIMULATED_EXE_DIR = "C:\\XyNote";
const SIMULATED_DEFAULT_DATA_DIR = `${SIMULATED_EXE_DIR}\\data`;

interface BrowserStorageConfig {
  activeDataDir: string;
  markdownSyncDir: string;
  autoSyncMarkdown: boolean;
  imageSaveMode: "assets" | "base64";
  autoBackupOnLaunch: boolean;
  maxBackups: number;
}

interface BrowserBackupSnapshot {
  entry: BackupEntry;
  serializedStore: string;
}

function normalizeWinPathKey(p: string): string {
  return p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function joinWinPath(base: string, sub: string): string {
  const cleanBase = base.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  const cleanSub = sub.trim().replace(/\//g, "\\").replace(/^\\+/, "");
  return `${cleanBase}\\${cleanSub}`;
}

function loadBrowserStorageConfig(): BrowserStorageConfig {
  const fallback: BrowserStorageConfig = {
    activeDataDir: SIMULATED_DEFAULT_DATA_DIR,
    markdownSyncDir: joinWinPath(SIMULATED_DEFAULT_DATA_DIR, "pages"),
    autoSyncMarkdown: true,
    imageSaveMode: "assets",
    autoBackupOnLaunch: true,
    maxBackups: 10,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(BROWSER_STORAGE_CFG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BrowserStorageConfig>;
      const activeDataDir = parsed.activeDataDir?.trim() || SIMULATED_DEFAULT_DATA_DIR;
      return {
        activeDataDir,
        markdownSyncDir:
          parsed.markdownSyncDir?.trim() || joinWinPath(activeDataDir, "pages"),
        autoSyncMarkdown: parsed.autoSyncMarkdown ?? true,
        imageSaveMode: parsed.imageSaveMode === "base64" ? "base64" : "assets",
        autoBackupOnLaunch: parsed.autoBackupOnLaunch ?? true,
        maxBackups:
          typeof parsed.maxBackups === "number" && parsed.maxBackups > 0
            ? parsed.maxBackups
            : 10,
      };
    }
  } catch {
    // Ignore parse error
  }
  return fallback;
}

function saveBrowserStorageConfig(cfg: BrowserStorageConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_STORAGE_CFG_KEY, JSON.stringify(cfg));
  } catch {
    // Ignore storage quota error
  }
}

function buildBrowserStorageInfo(): StorageConfigInfo {
  const cfg = loadBrowserStorageConfig();
  const store = loadStore();
  const serialized = JSON.stringify(store);
  const byteSize =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(serialized).byteLength
      : serialized.length;

  const activePages = store.pages.filter((p) => !p.isTrashed);
  const activePageIds = new Set(activePages.map((p) => p.id));
  const activeBlockCount = store.blocks.filter((b) =>
    activePageIds.has(b.pageId)
  ).length;

  return {
    exeDir: SIMULATED_EXE_DIR,
    defaultDataDir: SIMULATED_DEFAULT_DATA_DIR,
    activeDataDir: cfg.activeDataDir,
    dbFilePath: joinWinPath(cfg.activeDataDir, "notion_desktop.db"),
    markdownSyncDir: cfg.markdownSyncDir,
    assetsDir: joinWinPath(cfg.activeDataDir, "assets"),
    backupsDir: joinWinPath(cfg.activeDataDir, "backups"),
    isDefaultPortableDir:
      normalizeWinPathKey(cfg.activeDataDir) ===
      normalizeWinPathKey(SIMULATED_DEFAULT_DATA_DIR),
    exeDirWritable: true,
    autoSyncMarkdown: cfg.autoSyncMarkdown,
    imageSaveMode: cfg.imageSaveMode,
    autoBackupOnLaunch: cfg.autoBackupOnLaunch,
    maxBackups: cfg.maxBackups,
    dbSizeBytes: byteSize,
    pageCount: activePages.length,
    blockCount: activeBlockCount,
  };
}

function loadBrowserBackups(): BrowserBackupSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BROWSER_BACKUPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BrowserBackupSnapshot[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Ignore
  }
  return [];
}

function saveBrowserBackups(list: BrowserBackupSnapshot[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_BACKUPS_KEY, JSON.stringify(list));
  } catch {
    // Ignore quota errors
  }
}

function formatBackupStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function loadBrowserLocalMdMap(): Record<string, { markdown: string; updatedAt: string }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BROWSER_LOCAL_MD_MAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<
        string,
        { markdown: string; updatedAt: string }
      >;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // Ignore
  }
  return {};
}

function saveBrowserLocalMdMap(
  map: Record<string, { markdown: string; updatedAt: string }>
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BROWSER_LOCAL_MD_MAP_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota errors
  }
}

function serializeBlocksToLosslessMarkdown(
  blocks: Array<Pick<SaveBlockItem, "blockType" | "content" | "plainText" | "props">>
): string {
  const lines: string[] = [];
  let numCounter = 0;

  for (const b of blocks) {
    if (b.blockType !== "numbered") numCounter = 0;
    const text = isRawTextBlockType(b.blockType)
      ? b.content || b.plainText
      : htmlToInlineMarkdown(b.content) || b.plainText || stripHtml(b.content);

    switch (b.blockType) {
      case "heading1":
        lines.push(`# ${text}`, "");
        break;
      case "heading2":
        lines.push(`## ${text}`, "");
        break;
      case "heading3":
        lines.push(`### ${text}`, "");
        break;
      case "todo":
        lines.push(`- [${b.props.checked ? "x" : " "}] ${text}`);
        break;
      case "bullet":
        lines.push(`- ${text}`);
        break;
      case "numbered":
        numCounter += 1;
        lines.push(`${numCounter}. ${text}`);
        break;
      case "quote":
        lines.push(`> ${text}`, "");
        break;
      case "callout":
        lines.push(`> [!NOTE] ${b.props.calloutIcon || "💡"} ${text}`, "");
        break;
      case "toggle":
        lines.push(
          `<details${b.props.collapsed ? "" : " open"}><summary>${text}</summary>`,
          b.props.childrenText || "",
          "</details>",
          ""
        );
        break;
      case "code":
        lines.push(`\`\`\`${b.props.language || ""}`, b.content || b.plainText, "```", "");
        break;
      case "mermaid":
        lines.push("```mermaid", b.content || b.plainText, "```", "");
        break;
      case "math":
        lines.push("$$", b.content || b.plainText, "$$", "");
        break;
      case "image": {
        const imgUrl = b.props.url || b.content || "";
        const cap = b.props.caption || "";
        lines.push(`![${cap}](${imgUrl})`, "");
        break;
      }
      case "bookmark": {
        const bmUrl = b.props.url || b.content || "";
        const bmTitle = b.props.bookmarkTitle || b.plainText || bmUrl;
        lines.push(`[🔖 ${bmTitle}](${bmUrl})`, "");
        break;
      }
      case "embed": {
        const emUrl = b.props.url || b.content || "";
        const emTitle = b.props.caption || b.props.embedProvider || "Embed";
        lines.push(`@[embed](${emUrl} "${emTitle}")`, "");
        break;
      }
      case "divider":
        lines.push("---", "");
        break;
      case "table": {
        lines.push(...formatGfmTableExportLines(b.props), "");
        break;
      }
      default:
        lines.push(text, "");
        break;
    }
  }

  return lines.join("\n").trim() + "\n";
}

function extractFileNameAndTitle(
  filePath: string,
  markdown: string
): { fileName: string; title: string } {
  const normalized = filePath.replace(/\//g, "\\");
  const fileName = normalized.split("\\").pop() || "untitled.md";
  const baseTitle = fileName.replace(/\.(md|markdown|txt)$/i, "") || "无标题";
  const h1Match = /^#\s+(.+)$/m.exec(markdown.replace(/^\uFEFF/, ""));
  const title = h1Match ? stripHtml(inlineMarkdownToHtml(h1Match[1].trim())) : baseTitle;
  return { fileName, title: title || baseTitle };
}

export function registerBrowserLocalMarkdownFile(
  fileName: string,
  markdown: string,
  virtualPath?: string
): LocalMarkdownDocument {
  const safeName = fileName.trim() || "untitled.md";
  const filePath =
    virtualPath || joinWinPath(joinWinPath(SIMULATED_EXE_DIR, "notes"), safeName);
  const ts = nowIso();
  const map = loadBrowserLocalMdMap();
  map[filePath] = { markdown, updatedAt: ts };
  saveBrowserLocalMdMap(map);

  const meta = extractFileNameAndTitle(filePath, markdown);
  const blocks = parseMarkdownStringToBlocks(`local:${filePath}`, markdown);
  return {
    filePath,
    fileName: meta.fileName,
    title: meta.title,
    markdown,
    blocks,
    updatedAt: ts,
  };
}

export async function getStorageInfo(): Promise<StorageConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<StorageConfigInfo>("get_storage_info");
  }
  return buildBrowserStorageInfo();
}

export async function updateStorageConfig(
  input: UpdateStorageConfigInput
): Promise<StorageConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<StorageConfigInfo>("update_storage_config", { input });
  }
  const cfg = loadBrowserStorageConfig();
  const prevDefaultSync = joinWinPath(cfg.activeDataDir, "pages");

  if (input.activeDataDir !== undefined && input.activeDataDir.trim()) {
    const nextActive = input.activeDataDir.trim();
    const wasUsingDefaultSubPages =
      normalizeWinPathKey(cfg.markdownSyncDir) === normalizeWinPathKey(prevDefaultSync);
    cfg.activeDataDir = nextActive;
    if (input.markdownSyncDir === undefined && wasUsingDefaultSubPages) {
      cfg.markdownSyncDir = joinWinPath(nextActive, "pages");
    }
  }
  if (input.markdownSyncDir !== undefined && input.markdownSyncDir.trim()) {
    cfg.markdownSyncDir = input.markdownSyncDir.trim();
  }
  if (input.autoSyncMarkdown !== undefined) {
    cfg.autoSyncMarkdown = input.autoSyncMarkdown;
  }
  if (input.imageSaveMode !== undefined) {
    cfg.imageSaveMode = input.imageSaveMode;
  }
  if (input.autoBackupOnLaunch !== undefined) {
    cfg.autoBackupOnLaunch = input.autoBackupOnLaunch;
  }
  if (input.maxBackups !== undefined && input.maxBackups > 0) {
    cfg.maxBackups = input.maxBackups;
  }
  saveBrowserStorageConfig(cfg);
  return buildBrowserStorageInfo();
}

export async function resetStorageToDefault(
  migrateExistingData = true
): Promise<StorageConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<StorageConfigInfo>("reset_storage_to_default", {
      migrateExistingData,
    });
  }
  const cfg = loadBrowserStorageConfig();
  cfg.activeDataDir = SIMULATED_DEFAULT_DATA_DIR;
  cfg.markdownSyncDir = joinWinPath(SIMULATED_DEFAULT_DATA_DIR, "pages");
  saveBrowserStorageConfig(cfg);
  return buildBrowserStorageInfo();
}

export async function syncAllPagesToMarkdown(): Promise<number> {
  if (isTauriRuntime()) {
    return invoke<number>("sync_all_pages_to_markdown");
  }
  const store = loadStore();
  const cfg = loadBrowserStorageConfig();
  const activePages = store.pages.filter((p) => !p.isTrashed);
  const mdMap = loadBrowserLocalMdMap();
  const ts = nowIso();

  for (const p of activePages) {
    const exported = await exportPageMarkdown(p.id);
    const vPath = joinWinPath(cfg.markdownSyncDir, exported.filename);
    mdMap[vPath] = { markdown: exported.markdown, updatedAt: ts };
  }
  saveBrowserLocalMdMap(mdMap);
  return activePages.length;
}

export async function pickFolderDialog(
  defaultPath?: string,
  title?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("pick_folder_dialog", {
      defaultPath: defaultPath ?? null,
      title: title ?? null,
    });
  }
  return null;
}

export async function pickMarkdownFileDialog(): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("pick_markdown_file_dialog");
  }
  return null;
}

export async function saveMarkdownFileDialog(
  defaultName: string,
  content: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("save_markdown_file_dialog", {
      defaultName,
      content,
    });
  }
  const cleanName = defaultName.trim() || "Untitled.md";
  const finalName = /\.(md|markdown|txt)$/i.test(cleanName)
    ? cleanName
    : `${cleanName}.md`;

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ignore headless download restrictions
    }
  }

  const doc = registerBrowserLocalMarkdownFile(finalName, content);
  return doc.filePath;
}

export async function openLocalMarkdownFile(
  filePath: string
): Promise<LocalMarkdownDocument> {
  if (isTauriRuntime()) {
    return invoke<LocalMarkdownDocument>("open_local_markdown_file", { filePath });
  }
  const map = loadBrowserLocalMdMap();
  const entry = map[filePath];
  const ts = entry?.updatedAt ?? nowIso();
  const markdown =
    entry?.markdown ??
    `# ${filePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "本地笔记"}\n\n`;
  if (!entry) {
    map[filePath] = { markdown, updatedAt: ts };
    saveBrowserLocalMdMap(map);
  }
  const meta = extractFileNameAndTitle(filePath, markdown);
  const blocks = parseMarkdownStringToBlocks(`local:${filePath}`, markdown);
  return {
    filePath,
    fileName: meta.fileName,
    title: meta.title,
    markdown,
    blocks,
    updatedAt: ts,
  };
}

export async function saveLocalMarkdownFile(
  filePath: string,
  blocks?: SaveBlockItem[] | null,
  rawMarkdown?: string | null
): Promise<LocalMarkdownDocument> {
  if (isTauriRuntime()) {
    return invoke<LocalMarkdownDocument>("save_local_markdown_file", {
      filePath,
      blocks: blocks ?? null,
      rawMarkdown: rawMarkdown ?? null,
    });
  }
  const ts = nowIso();
  const pageKey = `local:${filePath}`;
  let finalMarkdown: string;
  let finalBlocks: Block[];

  if (typeof rawMarkdown === "string") {
    finalMarkdown = rawMarkdown;
    finalBlocks = parseMarkdownStringToBlocks(pageKey, rawMarkdown);
  } else if (blocks && blocks.length > 0) {
    finalMarkdown = serializeBlocksToLosslessMarkdown(blocks);
    finalBlocks = blocks.map((item, idx) => ({
      id: item.id || makeId("blk"),
      pageId: pageKey,
      blockType: item.blockType,
      content: item.content,
      plainText: isRawTextBlockType(item.blockType)
        ? item.content
        : item.plainText,
      props: { ...item.props },
      sortOrder: item.sortOrder ?? idx,
      createdAt: ts,
      updatedAt: ts,
    }));
  } else {
    finalMarkdown = "";
    finalBlocks = [makeBlock(pageKey, 0, "paragraph", "")];
  }

  const map = loadBrowserLocalMdMap();
  map[filePath] = { markdown: finalMarkdown, updatedAt: ts };
  saveBrowserLocalMdMap(map);

  const meta = extractFileNameAndTitle(filePath, finalMarkdown);
  return {
    filePath,
    fileName: meta.fileName,
    title: meta.title,
    markdown: finalMarkdown,
    blocks: finalBlocks,
    updatedAt: ts,
  };
}

export async function convertMarkdownBlocks(params: {
  markdown?: string | null;
  blocks?: SaveBlockItem[] | null;
  pageId?: string | null;
}): Promise<LocalMarkdownDocument> {
  if (isTauriRuntime()) {
    return invoke<LocalMarkdownDocument>("convert_markdown_blocks", {
      markdown: params.markdown ?? null,
      blocks: params.blocks ?? null,
      pageId: params.pageId ?? null,
    });
  }
  const pid = params.pageId || "preview";
  const ts = nowIso();
  if (typeof params.markdown === "string") {
    const parsed = parseMarkdownStringToBlocks(pid, params.markdown);
    const meta = extractFileNameAndTitle("document.md", params.markdown);
    return {
      filePath: "",
      fileName: meta.fileName,
      title: meta.title,
      markdown: params.markdown,
      blocks: parsed,
      updatedAt: ts,
    };
  }
  const srcBlocks = params.blocks ?? [];
  const markdown = serializeBlocksToLosslessMarkdown(srcBlocks);
  const meta = extractFileNameAndTitle("document.md", markdown);
  return {
    filePath: "",
    fileName: meta.fileName,
    title: meta.title,
    markdown,
    blocks: srcBlocks.map((b, idx) => ({
      id: b.id || makeId("blk"),
      pageId: pid,
      blockType: b.blockType,
      content: b.content,
      plainText: isRawTextBlockType(b.blockType) ? b.content : b.plainText,
      props: { ...b.props },
      sortOrder: b.sortOrder ?? idx,
      createdAt: ts,
      updatedAt: ts,
    })),
    updatedAt: ts,
  };
}

export async function saveAssetImage(
  filename: string,
  dataBase64: string,
  mimeType: string
): Promise<SavedAssetResult> {
  if (isTauriRuntime()) {
    return invoke<SavedAssetResult>("save_asset_image", {
      filename,
      dataBase64,
      mimeType,
    });
  }
  const cfg = loadBrowserStorageConfig();
  const cleanB64 = dataBase64.includes(",")
    ? dataBase64.split(",")[1]
    : dataBase64.trim();
  const safeMime = mimeType || "image/png";
  const extFromMime = safeMime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const cleanBase =
    filename
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\.[^.]+$/, "")
      .trim() || "pasted-image";
  const uniqueName = `${cleanBase}-${Date.now().toString(36)}.${extFromMime}`;
  return {
    filePath: joinWinPath(joinWinPath(cfg.activeDataDir, "assets"), uniqueName),
    assetUrl: `data:${safeMime};base64,${cleanB64}`,
  };
}

export async function openPathInExplorer(path: string): Promise<void> {
  if (isTauriRuntime()) {
    return invoke<void>("open_path_in_explorer", { path });
  }
}

export async function listBackups(): Promise<BackupEntry[]> {
  if (isTauriRuntime()) {
    return invoke<BackupEntry[]>("list_backups");
  }
  let list = loadBrowserBackups();
  const cfg = loadBrowserStorageConfig();
  if (list.length === 0 && cfg.autoBackupOnLaunch) {
    const store = loadStore();
    const serializedStore = JSON.stringify(store);
    const filename = `backup-${formatBackupStamp()}-launch.db`;
    const entry: BackupEntry = {
      filename,
      fullPath: joinWinPath(joinWinPath(cfg.activeDataDir, "backups"), filename),
      sizeBytes:
        typeof TextEncoder !== "undefined"
          ? new TextEncoder().encode(serializedStore).byteLength
          : serializedStore.length,
      createdAt: nowIso(),
    };
    list = [{ entry, serializedStore }];
    saveBrowserBackups(list);
  }
  return list
    .map((b) => ({ ...b.entry }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackupNow(): Promise<BackupEntry> {
  if (isTauriRuntime()) {
    return invoke<BackupEntry>("create_backup_now");
  }
  const store = loadStore();
  const cfg = loadBrowserStorageConfig();
  const serializedStore = JSON.stringify(store);
  const stamp = formatBackupStamp();
  const suffix = Math.random().toString(36).slice(2, 5);
  const filename = `backup-${stamp}-${suffix}.db`;
  const entry: BackupEntry = {
    filename,
    fullPath: joinWinPath(joinWinPath(cfg.activeDataDir, "backups"), filename),
    sizeBytes:
      typeof TextEncoder !== "undefined"
        ? new TextEncoder().encode(serializedStore).byteLength
        : serializedStore.length,
    createdAt: nowIso(),
  };

  const list = loadBrowserBackups();
  list.unshift({ entry, serializedStore });
  const trimmed = list.slice(0, Math.max(1, cfg.maxBackups));
  saveBrowserBackups(trimmed);
  return { ...entry };
}

export async function restoreBackup(
  backupPath: string
): Promise<StorageConfigInfo> {
  if (isTauriRuntime()) {
    return invoke<StorageConfigInfo>("restore_backup", { backupPath });
  }
  const list = loadBrowserBackups();
  const found = list.find(
    (item) =>
      item.entry.fullPath === backupPath || item.entry.filename === backupPath
  );
  if (!found) {
    throw new Error(`未找到备份快照：${backupPath}`);
  }
  const restoredStore = JSON.parse(found.serializedStore) as LocalStore;
  saveStore(restoredStore);
  return buildBrowserStorageInfo();
}

export async function exportWorkspaceZip(
  defaultName?: string
): Promise<{ savedPath: string | null; base64?: string }> {
  const targetName = defaultName?.trim() || "notion-workspace-backup.zip";
  if (isTauriRuntime()) {
    const raw = await invoke<string | null | { savedPath: string | null }>(
      "export_workspace_zip_dialog",
      { defaultName: targetName }
    );
    if (raw === null || typeof raw === "string") {
      return { savedPath: raw };
    }
    return raw;
  }

  const store = loadStore();
  const activePages = store.pages.filter((p) => !p.isTrashed);
  const pageMap = new Map(activePages.map((p) => [p.id, p]));

  const buildRelFolder = (page: Page): string => {
    const segments: string[] = [];
    const seen = new Set<string>();
    let cur: Page | undefined = page.parentId
      ? pageMap.get(page.parentId)
      : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const safeSeg =
        cur.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "Untitled";
      segments.unshift(safeSeg);
      cur = cur.parentId ? pageMap.get(cur.parentId) : undefined;
    }
    return segments.join("/");
  };

  const zipFiles: Record<string, Uint8Array> = {};
  const usedPaths = new Set<string>();

  for (const p of activePages) {
    const exported = await exportPageMarkdown(p.id);
    const dir = buildRelFolder(p);
    let relPath = dir ? `${dir}/${exported.filename}` : exported.filename;
    let dup = 2;
    while (usedPaths.has(relPath.toLowerCase())) {
      const stem = exported.filename.replace(/\.md$/i, "");
      relPath = dir ? `${dir}/${stem} (${dup}).md` : `${stem} (${dup}).md`;
      dup += 1;
    }
    usedPaths.add(relPath.toLowerCase());
    zipFiles[relPath] = strToU8(exported.markdown);

    if (p.pageType === "database") {
      const db = ensureDatabaseInitialized(store, p.id);
      const csvLines: string[] = [];
      const escCsv = (val: string) =>
        /[",\n\r]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
      if (db.columns.length > 0) {
        csvLines.push(db.columns.map((c) => escCsv(c.name)).join(","));
        for (const r of db.rows) {
          const vals = db.columns.map((col) => {
            const cell = r.cells[col.id];
            if (cell === null || cell === undefined) return "";
            if (col.colType === "status" || col.colType === "select") {
              const opt = col.options.find((o) => o.id === cell || o.label === cell);
              return escCsv(opt ? opt.label : String(cell));
            }
            if (col.colType === "multi_select" && Array.isArray(cell)) {
              const joined = cell
                .map((id) => col.options.find((o) => o.id === id)?.label ?? String(id))
                .join(", ");
              return escCsv(joined);
            }
            if (col.colType === "checkbox") {
              return cell ? "Yes" : "No";
            }
            return escCsv(String(cell));
          });
          csvLines.push(vals.join(","));
        }
      }
      const csvPath = relPath.replace(/\.md$/i, ".csv");
      zipFiles[csvPath] = strToU8("\uFEFF" + csvLines.join("\n"));
    }
  }

  const zippedBytes = zipSync(zipFiles, { level: 6 });
  const base64 = uint8ArrayToBase64(zippedBytes);

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const blob = new Blob([zippedBytes.buffer as ArrayBuffer], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = targetName.endsWith(".zip") ? targetName : `${targetName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ignore headless download restrictions
    }
  }

  return {
    savedPath: targetName.endsWith(".zip") ? targetName : `${targetName}.zip`,
    base64,
  };
}

/* ============================================================================
 * Commercial v0.3.0 — Portable Theme & Shareable Style Plugins API + Fallback
 * ========================================================================== */

const BROWSER_STYLE_PLUGINS_KEY = "notion_desktop_style_plugins_v030";

interface BrowserStylePluginStore {
  activeThemeId: string;
  customCssGlobal: string;
  plugins: StylePluginItem[];
}

function buildSeededBrowserStylePlugins(
  themesDir: string,
  snippetsDir: string
): StylePluginItem[] {
  const ts = "2026-11-14T18:00:00.000Z";
  return [
    {
      id: "github-tech",
      kind: "theme",
      name: "GitHub 经典技术白",
      author: "XyNote Official",
      version: "1.0.0",
      description: "清爽严谨的 GitHub 文档视觉体系，带 H1/H2 章节底部分隔线与柔和代码块底色",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "github-tech.notion-theme.json",
      filePath: `${themesDir}\\github-tech.notion-theme.json`,
      tokens: {
        bgPrimary: "#ffffff",
        bgSecondary: "#f6f8fa",
        bgSidebar: "#f6f8fa",
        bgHover: "rgba(31, 35, 40, 0.06)",
        bgElevated: "#ffffff",
        textPrimary: "#24292f",
        textSecondary: "#57606a",
        textMuted: "#6e7781",
        borderColor: "#d0d7de",
        accentColor: "#0969da",
        codeInlineColor: "#cf222e",
        codeInlineBg: "rgba(175, 184, 193, 0.2)",
        codeBlockBg: "#f6f8fa",
        tableHeaderBg: "#f6f8fa",
        calloutBg: "#ddf4ff",
        selectionBg: "rgba(9, 105, 218, 0.18)",
        radiusMd: "6px",
      },
      customCss:
        ".nb-editor-h1, .nb-editor-h2 { padding-bottom: 0.28em; border-bottom: 1px solid var(--border-color); }",
      updatedAt: ts,
    },
    {
      id: "dracula-dark",
      kind: "theme",
      name: "Dracula 暗夜极客紫",
      author: "XyNote Official",
      version: "1.0.0",
      description: "经典 Dracula 极客暗色配色，高对比紫粉语法点缀，夜间编码与架构设计首选",
      baseMode: "dark",
      enabled: false,
      builtin: true,
      fileName: "dracula-dark.notion-theme.json",
      filePath: `${themesDir}\\dracula-dark.notion-theme.json`,
      tokens: {
        bgPrimary: "#282a36",
        bgSecondary: "#21222c",
        bgSidebar: "#21222c",
        bgHover: "rgba(248, 248, 242, 0.07)",
        bgElevated: "#313442",
        textPrimary: "#f8f8f2",
        textSecondary: "#c5c8d9",
        textMuted: "#8be9fd",
        borderColor: "#44475a",
        accentColor: "#bd93f9",
        codeInlineColor: "#ff79c6",
        codeInlineBg: "rgba(255, 121, 198, 0.14)",
        codeBlockBg: "#1e1f29",
        tableHeaderBg: "#21222c",
        calloutBg: "rgba(189, 147, 249, 0.12)",
        selectionBg: "rgba(189, 147, 249, 0.28)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "nord-dark",
      kind: "theme",
      name: "Nord 极地冰川蓝",
      author: "XyNote Official",
      version: "1.0.0",
      description: "北欧极地冷峻蓝灰调，柔和低眩光对比度，长时间沉浸阅读不刺眼",
      baseMode: "dark",
      enabled: false,
      builtin: true,
      fileName: "nord-dark.notion-theme.json",
      filePath: `${themesDir}\\nord-dark.notion-theme.json`,
      tokens: {
        bgPrimary: "#2e3440",
        bgSecondary: "#272c36",
        bgSidebar: "#272c36",
        bgHover: "rgba(236, 239, 244, 0.06)",
        bgElevated: "#3b4252",
        textPrimary: "#eceff4",
        textSecondary: "#d8dee9",
        textMuted: "#81a1c1",
        borderColor: "#434c5e",
        accentColor: "#88c0d0",
        codeInlineColor: "#a3be8c",
        codeInlineBg: "rgba(136, 192, 208, 0.14)",
        codeBlockBg: "#242933",
        tableHeaderBg: "#3b4252",
        calloutBg: "rgba(136, 192, 208, 0.12)",
        selectionBg: "rgba(136, 192, 208, 0.26)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "ink-editorial",
      kind: "theme",
      name: "墨韵书卷 (东方人文)",
      author: "XyNote Official",
      version: "1.0.0",
      description: "温润宣纸底色配朱砂印泥点缀与人文衬线标题，适合深度长文、读书笔记与随笔创作",
      baseMode: "sepia",
      enabled: false,
      builtin: true,
      fileName: "ink-editorial.notion-theme.json",
      filePath: `${themesDir}\\ink-editorial.notion-theme.json`,
      tokens: {
        bgPrimary: "#faf6ee",
        bgSecondary: "#f2ecdf",
        bgSidebar: "#f2ecdf",
        bgHover: "rgba(43, 38, 35, 0.05)",
        bgElevated: "#fffcf6",
        textPrimary: "#2b2623",
        textSecondary: "#5e554d",
        textMuted: "#8c8177",
        borderColor: "rgba(43, 38, 35, 0.12)",
        accentColor: "#b83b2a",
        codeInlineColor: "#b83b2a",
        codeInlineBg: "rgba(184, 59, 42, 0.09)",
        codeBlockBg: "#f3ede2",
        tableHeaderBg: "#f2ecdf",
        calloutBg: "#f5efe2",
        selectionBg: "rgba(184, 59, 42, 0.18)",
        radiusMd: "6px",
      },
      customCss:
        ".nb-editor-h1, .nb-editor-h2, .nb-editor-h3, .nb-page-title-input { font-family: var(--font-serif); letter-spacing: 0.01em; }",
      updatedAt: ts,
    },
    {
      id: "meadow-green",
      kind: "theme",
      name: "清风豆沙护眼绿",
      author: "XyNote Official",
      version: "1.0.0",
      description: "柔和鼠尾草豆沙绿纸面，缓解屏幕蓝光疲劳，适合全天候知识整理",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "meadow-green.notion-theme.json",
      filePath: `${themesDir}\\meadow-green.notion-theme.json`,
      tokens: {
        bgPrimary: "#edf5ee",
        bgSecondary: "#e3eee5",
        bgSidebar: "#e3eee5",
        bgHover: "rgba(36, 51, 40, 0.06)",
        bgElevated: "#f5faf6",
        textPrimary: "#243328",
        textSecondary: "#4b6352",
        textMuted: "#748c7b",
        borderColor: "rgba(36, 51, 40, 0.12)",
        accentColor: "#2e7d5b",
        codeInlineColor: "#1f6848",
        codeInlineBg: "rgba(46, 125, 91, 0.12)",
        codeBlockBg: "#e4efe6",
        tableHeaderBg: "#e3eee5",
        calloutBg: "#e1efe4",
        selectionBg: "rgba(46, 125, 91, 0.2)",
        radiusMd: "8px",
      },
      customCss: "",
      updatedAt: ts,
    },
    {
      id: "colorful-headings",
      kind: "snippet",
      name: "多彩分级标题侧边条",
      author: "XyNote Official",
      version: "1.0.0",
      description: "为 H1 / H2 / H3 标题添加鲜明的左侧彩色竖条与微底色，一眼区分文档层级结构",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "colorful-headings.css",
      filePath: `${snippetsDir}\\colorful-headings.css`,
      tokens: {},
      customCss: [
        "/* @name: 多彩分级标题侧边条 */",
        ".nb-editor-h1 {",
        "  border-left: 4px solid var(--accent-color, #2383e2);",
        "  padding-left: 12px;",
        "  background: linear-gradient(90deg, rgba(35, 131, 226, 0.08), transparent 72%);",
        "  border-radius: 0 6px 6px 0;",
        "}",
        ".nb-editor-h2 {",
        "  border-left: 3.5px solid #0f9d58;",
        "  padding-left: 10px;",
        "  background: linear-gradient(90deg, rgba(15, 157, 88, 0.07), transparent 65%);",
        "  border-radius: 0 6px 6px 0;",
        "}",
        ".nb-editor-h3 {",
        "  border-left: 3px solid #e67c23;",
        "  padding-left: 9px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "academic-numbering",
      kind: "snippet",
      name: "学术文档标题自动编号 (1. / 1.1 / 1.1.1)",
      author: "XyNote Official",
      version: "1.0.0",
      description: "基于纯 CSS 计数器自动为 H1 / H2 / H3 生成严谨的多级章节序号，无需手写维护",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "academic-numbering.css",
      filePath: `${snippetsDir}\\academic-numbering.css`,
      tokens: {},
      customCss: [
        "/* @name: 学术文档标题自动编号 (1. / 1.1 / 1.1.1) */",
        ".nb-editor-root, .nb-editor-canvas {",
        "  counter-reset: nb-sec-h1;",
        "}",
        ".nb-editor-h1 {",
        "  counter-increment: nb-sec-h1;",
        "  counter-reset: nb-sec-h2;",
        "}",
        ".nb-editor-h1::before {",
        "  content: counter(nb-sec-h1) \". \";",
        "  color: var(--accent-color, #2383e2);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 4px;",
        "}",
        ".nb-editor-h2 {",
        "  counter-increment: nb-sec-h2;",
        "  counter-reset: nb-sec-h3;",
        "}",
        ".nb-editor-h2::before {",
        "  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \" \";",
        "  color: var(--accent-color, #2383e2);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 6px;",
        "}",
        ".nb-editor-h3 {",
        "  counter-increment: nb-sec-h3;",
        "}",
        ".nb-editor-h3::before {",
        "  content: counter(nb-sec-h1) \".\" counter(nb-sec-h2) \".\" counter(nb-sec-h3) \" \";",
        "  color: var(--text-secondary);",
        "  font-variant-numeric: tabular-nums;",
        "  margin-right: 6px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "dot-grid-canvas",
      kind: "snippet",
      name: "工程师点阵网格信纸背景",
      author: "XyNote Official",
      version: "1.0.0",
      description: "在编辑画布铺设细腻低对比度手帐点阵网格，提升架构草图与技术笔记质感",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "dot-grid-canvas.css",
      filePath: `${snippetsDir}\\dot-grid-canvas.css`,
      tokens: {},
      customCss: [
        "/* @name: 工程师点阵网格信纸背景 */",
        ".nb-page-scroll, .page-scroll-container {",
        "  background-image: radial-gradient(var(--border-strong, rgba(55, 53, 47, 0.16)) 1px, transparent 1px);",
        "  background-size: 20px 20px;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "mac-code-window",
      kind: "snippet",
      name: "Mac 窗口三色圆点代码块",
      author: "XyNote Official",
      version: "1.0.0",
      description: "为代码块顶部工具栏注入 macOS 红黄绿窗口圆点装饰与精致立体阴影",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "mac-code-window.css",
      filePath: `${snippetsDir}\\mac-code-window.css`,
      tokens: {},
      customCss: [
        "/* @name: Mac 窗口三色圆点代码块 */",
        ".nb-editor-code-wrap {",
        "  border-radius: 10px !important;",
        "  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);",
        "}",
        ".nb-editor-code-topbar::before {",
        "  content: \"\";",
        "  display: inline-block;",
        "  width: 11px;",
        "  height: 11px;",
        "  border-radius: 50%;",
        "  background: #ff5f56;",
        "  box-shadow: 18px 0 0 #ffbd2e, 36px 0 0 #27c93f;",
        "  margin-right: 44px;",
        "  flex-shrink: 0;",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
    {
      id: "compact-dense-table",
      kind: "snippet",
      name: "高密度斑马纹技术表格",
      author: "XyNote Official",
      version: "1.0.0",
      description: "紧凑化数据表格内边距并启用奇偶行交替斑马纹底色，适合大型接口字典与配置表",
      baseMode: "light",
      enabled: false,
      builtin: true,
      fileName: "compact-dense-table.css",
      filePath: `${snippetsDir}\\compact-dense-table.css`,
      tokens: {},
      customCss: [
        "/* @name: 高密度斑马纹技术表格 */",
        ".nb-editor-table th, .nb-editor-table td {",
        "  padding: 5px 10px !important;",
        "  font-size: 13px !important;",
        "}",
        ".nb-editor-table tbody tr:nth-child(even) td {",
        "  background: var(--bg-hover, rgba(55, 53, 47, 0.03));",
        "}",
      ].join("\n"),
      updatedAt: ts,
    },
  ];
}

function getBrowserPluginDirs(): {
  pluginsDir: string;
  themesDir: string;
  snippetsDir: string;
} {
  const cfg = loadBrowserStorageConfig();
  const base = cfg.activeDataDir.replace(/[\\/]+$/, "");
  const pluginsDir = `${base}\\plugins`;
  return {
    pluginsDir,
    themesDir: `${pluginsDir}\\themes`,
    snippetsDir: `${pluginsDir}\\snippets`,
  };
}

function loadBrowserStylePluginStore(): BrowserStylePluginStore {
  const dirs = getBrowserPluginDirs();
  try {
    const raw = localStorage.getItem(BROWSER_STYLE_PLUGINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BrowserStylePluginStore;
      if (parsed && Array.isArray(parsed.plugins) && parsed.plugins.length > 0) {
        return {
          activeThemeId: parsed.activeThemeId || "light",
          customCssGlobal: parsed.customCssGlobal || "",
          plugins: parsed.plugins,
        };
      }
    }
  } catch {
    // Re-seed on parse failure
  }
  const store = loadStore();
  const initialTheme =
    store.settings.theme === "dark" ||
    store.settings.theme === "sepia" ||
    store.settings.theme === "system"
      ? store.settings.theme
      : "light";
  const seeded: BrowserStylePluginStore = {
    activeThemeId: initialTheme,
    customCssGlobal: "",
    plugins: buildSeededBrowserStylePlugins(dirs.themesDir, dirs.snippetsDir),
  };
  saveBrowserStylePluginStore(seeded);
  return seeded;
}

function saveBrowserStylePluginStore(data: BrowserStylePluginStore): void {
  try {
    localStorage.setItem(BROWSER_STYLE_PLUGINS_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage quota issues
  }
}

function toStylePluginState(data: BrowserStylePluginStore): StylePluginState {
  const dirs = getBrowserPluginDirs();
  return {
    pluginsDir: dirs.pluginsDir,
    themesDir: dirs.themesDir,
    snippetsDir: dirs.snippetsDir,
    activeThemeId: data.activeThemeId,
    plugins: data.plugins.map((p) => ({
      ...p,
      tokens: { ...(p.tokens || {}) },
    })),
    customCssGlobal: data.customCssGlobal || "",
  };
}

function slugifyPluginId(rawName: string, fallbackPrefix = "plugin"): string {
  const ascii = rawName
    .trim()
    .toLowerCase()
    .replace(/\.(notion-theme\.json|json|css)$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `${fallbackPrefix}-${Date.now().toString(36)}`;
}

function parseCssPluginMetadata(
  filename: string,
  cssText: string
): SaveStylePluginInput {
  const stem = filename
    .replace(/^.*[\\/]/, "")
    .replace(/\.(notion-theme\.json|theme\.css|css|json)$/i, "")
    .trim();
  const meta: Record<string, string> = {};
  const headerMatch = cssText.match(/\/\*([\s\S]*?)\*\//);
  if (headerMatch) {
    const lines = headerMatch[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/@([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
      if (m) {
        meta[m[1].toLowerCase()] = m[2].trim();
      }
    }
  }
  const kindRaw = (meta.kind || "").toLowerCase();
  const isTheme =
    kindRaw === "theme" || /\.theme\.css$/i.test(filename);
  const modeRaw = (meta.mode || meta.basemode || "light").toLowerCase();
  const baseMode: "light" | "dark" | "sepia" =
    modeRaw === "dark" ? "dark" : modeRaw === "sepia" ? "sepia" : "light";

  return {
    id: meta.id ? slugifyPluginId(meta.id) : slugifyPluginId(stem || "custom-style"),
    kind: isTheme ? "theme" : "snippet",
    name: meta.name || stem || "外部样式插件",
    author: meta.author || "Community",
    version: meta.version || "1.0.0",
    description: meta.description || `从 ${filename} 导入的样式插件`,
    baseMode,
    enabled: true,
    tokens: {},
    customCss: cssText,
  };
}

function notifyStylePluginsChanged(): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent("notion-style-plugins-changed"));
  }
}

export async function listStylePlugins(): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    return invoke<StylePluginState>("list_style_plugins");
  }
  return toStylePluginState(loadBrowserStylePluginStore());
}

export async function saveStylePlugin(
  input: SaveStylePluginInput
): Promise<StylePluginItem> {
  if (isTauriRuntime()) {
    const saved = await invoke<StylePluginItem>("save_style_plugin", { input });
    notifyStylePluginsChanged();
    return saved;
  }
  const data = loadBrowserStylePluginStore();
  const dirs = getBrowserPluginDirs();
  const ts = nowIso();
  const targetId = input.id?.trim()
    ? slugifyPluginId(input.id)
    : slugifyPluginId(input.name, input.kind);

  const existingIdx = data.plugins.findIndex((p) => p.id === targetId);
  const existing = existingIdx >= 0 ? data.plugins[existingIdx] : null;
  const kind = input.kind ?? existing?.kind ?? "snippet";
  const baseMode = input.baseMode ?? existing?.baseMode ?? "light";
  const ext = kind === "theme" ? ".notion-theme.json" : ".css";
  const fileName = existing?.fileName ?? `${targetId}${ext}`;
  const filePath =
    existing?.filePath ??
    `${kind === "theme" ? dirs.themesDir : dirs.snippetsDir}\\${fileName}`;

  const enabled =
    input.enabled !== undefined
      ? input.enabled
      : existing
      ? existing.enabled
      : true;

  const item: StylePluginItem = {
    id: targetId,
    kind,
    name: input.name?.trim() || existing?.name || "未命名样式插件",
    author: input.author?.trim() || existing?.author || "Custom User",
    version: input.version?.trim() || existing?.version || "1.0.0",
    description: input.description?.trim() ?? existing?.description ?? "",
    baseMode,
    enabled,
    builtin: existing?.builtin ?? false,
    fileName,
    filePath,
    tokens: input.tokens ? { ...input.tokens } : { ...(existing?.tokens || {}) },
    customCss: input.customCss ?? existing?.customCss ?? "",
    updatedAt: ts,
  };

  if (existingIdx >= 0) {
    data.plugins[existingIdx] = item;
  } else {
    data.plugins.push(item);
  }

  if (item.kind === "theme" && item.enabled) {
    for (const p of data.plugins) {
      if (p.kind === "theme" && p.id !== item.id) {
        p.enabled = false;
      }
    }
    data.activeThemeId = `plugin:${item.id}`;
  }

  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return { ...item, tokens: { ...item.tokens } };
}

export async function toggleStylePlugin(
  id: string,
  enabled: boolean
): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    const updated = await invoke<StylePluginState>("toggle_style_plugin", {
      id,
      enabled,
    });
    notifyStylePluginsChanged();
    return updated;
  }
  const data = loadBrowserStylePluginStore();

  if (id === "light" || id === "dark" || id === "sepia" || id === "system") {
    if (enabled) {
      data.activeThemeId = id;
      for (const p of data.plugins) {
        if (p.kind === "theme") {
          p.enabled = false;
        }
      }
    }
    saveBrowserStylePluginStore(data);
    notifyStylePluginsChanged();
    return toStylePluginState(data);
  }

  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const target = data.plugins.find((p) => p.id === cleanId);
  if (!target) {
    throw new Error(`未找到样式插件 (${cleanId})`);
  }

  if (target.kind === "theme") {
    if (enabled) {
      for (const p of data.plugins) {
        if (p.kind === "theme") {
          p.enabled = p.id === cleanId;
        }
      }
      data.activeThemeId = `plugin:${cleanId}`;
    } else {
      target.enabled = false;
      if (data.activeThemeId === `plugin:${cleanId}`) {
        data.activeThemeId = "light";
      }
    }
  } else {
    target.enabled = enabled;
  }

  target.updatedAt = nowIso();
  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return toStylePluginState(data);
}

export async function deleteStylePlugin(id: string): Promise<StylePluginState> {
  if (isTauriRuntime()) {
    const updated = await invoke<StylePluginState>("delete_style_plugin", { id });
    notifyStylePluginsChanged();
    return updated;
  }
  const data = loadBrowserStylePluginStore();
  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const target = data.plugins.find((p) => p.id === cleanId);
  if (!target) {
    throw new Error(`未找到要删除的插件 (${cleanId})`);
  }
  if (target.builtin) {
    throw new Error("内置预设主题与官方样式插件不可删除，可直接关闭启用开关");
  }
  data.plugins = data.plugins.filter((p) => p.id !== cleanId);
  if (data.activeThemeId === `plugin:${cleanId}`) {
    data.activeThemeId = "light";
  }
  saveBrowserStylePluginStore(data);
  notifyStylePluginsChanged();
  return toStylePluginState(data);
}

export async function importStylePluginContent(
  filename: string,
  content: string
): Promise<StylePluginItem> {
  if (isTauriRuntime()) {
    const imported = await invoke<StylePluginItem>(
      "import_style_plugin_content",
      {
        filename,
        content,
      }
    );
    notifyStylePluginsChanged();
    return imported;
  }
  const trimmed = content.trim();
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".json") || trimmed.startsWith("{")) {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const kind: "theme" | "snippet" =
      raw.kind === "snippet" ? "snippet" : "theme";
    const rawMode = String(raw.baseMode ?? raw.base_mode ?? "light").toLowerCase();
    const baseMode: "light" | "dark" | "sepia" =
      rawMode === "dark" ? "dark" : rawMode === "sepia" ? "sepia" : "light";
    const tokens =
      raw.tokens && typeof raw.tokens === "object"
        ? (raw.tokens as ThemeTokens)
        : {};
    const stem = filename
      .replace(/^.*[\\/]/, "")
      .replace(/\.(notion-theme\.json|json)$/i, "");
    return saveStylePlugin({
      id: typeof raw.id === "string" ? raw.id : slugifyPluginId(stem || "imported-theme"),
      kind,
      name:
        typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : stem || "导入主题插件",
      author: typeof raw.author === "string" ? raw.author : "Community",
      version: typeof raw.version === "string" ? raw.version : "1.0.0",
      description:
        typeof raw.description === "string"
          ? raw.description
          : `从 ${filename} 导入的主题插件`,
      baseMode,
      enabled: raw.enabled !== false,
      tokens,
      customCss:
        typeof raw.customCss === "string"
          ? raw.customCss
          : typeof raw.custom_css === "string"
          ? raw.custom_css
          : "",
    });
  }

  const parsedCssInput = parseCssPluginMetadata(filename, content);
  return saveStylePlugin(parsedCssInput);
}

export async function importStylePluginDialog(): Promise<StylePluginItem | null> {
  if (isTauriRuntime()) {
    const imported = await invoke<StylePluginItem | null>(
      "import_style_plugin_dialog"
    );
    if (imported) {
      notifyStylePluginsChanged();
    }
    return imported;
  }
  if (typeof document === "undefined") return null;
  return new Promise<StylePluginItem | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".css,.json,.notion-theme.json";
    input.style.display = "none";
    let settled = false;
    const cleanup = () => {
      input.remove();
    };
    input.addEventListener("change", async () => {
      if (settled) return;
      settled = true;
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const imported = await importStylePluginContent(file.name, text);
        resolve(imported);
      } catch {
        resolve(null);
      }
    });
    input.addEventListener("cancel", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function exportStylePluginDialog(
  id: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("export_style_plugin_dialog", { id });
  }
  const data = loadBrowserStylePluginStore();
  const cleanId = id.startsWith("plugin:") ? id.slice("plugin:".length) : id;
  const plugin = data.plugins.find((p) => p.id === cleanId);
  if (!plugin) {
    throw new Error(`未找到样式插件 (${cleanId})`);
  }

  let exportFilename = plugin.fileName;
  let payloadText = "";
  let mime = "text/plain;charset=utf-8";

  if (plugin.kind === "theme") {
    if (!exportFilename.endsWith(".json")) {
      exportFilename = `${plugin.id}.notion-theme.json`;
    }
    mime = "application/json;charset=utf-8";
    payloadText = JSON.stringify(
      {
        id: plugin.id,
        kind: "theme",
        name: plugin.name,
        author: plugin.author,
        version: plugin.version,
        description: plugin.description,
        baseMode: plugin.baseMode,
        tokens: plugin.tokens,
        customCss: plugin.customCss,
      },
      null,
      2
    );
  } else {
    if (!exportFilename.endsWith(".css")) {
      exportFilename = `${plugin.id}.css`;
    }
    mime = "text/css;charset=utf-8";
    const hasHeader = /\/\*[\s\S]*?@name\s*:/.test(plugin.customCss);
    const header = hasHeader
      ? ""
      : [
          "/*",
          ` * @name: ${plugin.name}`,
          ` * @author: ${plugin.author}`,
          ` * @version: ${plugin.version}`,
          ` * @description: ${plugin.description}`,
          ` * @kind: snippet`,
          ` * @mode: ${plugin.baseMode}`,
          " */",
          "",
        ].join("\n");
    payloadText = `${header}${plugin.customCss}`;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const blob = new Blob([payloadText], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ignore headless download restrictions
    }
  }

  return exportFilename;
}

export async function saveSvgFileDialog(
  defaultName: string,
  content: string
): Promise<string | null> {
  const cleanName = defaultName.trim().toLowerCase().endsWith(".svg")
    ? defaultName.trim()
    : `${defaultName.trim() || "mermaid-diagram"}.svg`;

  if (isTauriRuntime()) {
    return invoke<string | null>("save_svg_file_dialog", {
      defaultName: cleanName,
      content,
    });
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const blob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cleanName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return cleanName;
  }

  return null;
}
