import { invoke } from "@tauri-apps/api/core";
import { readHarmonyWorkspaceJson, writeHarmonyWorkspaceJson } from "./harmony";
import { iconAsText } from "../icons/pageIcon";
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
  ImportedCustomFont,
  LocalMarkdownDocument,
  MarkdownExport,
  MarkdownTreeEntry,
  Page,
  PageDetail,
  SaveBlockItem,
  SavedAssetResult,
  SearchResult,
  SelectOption,
  StorageConfigInfo,
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

const STORAGE_KEY = "xynote_workspace_v1";
// 早期版本使用的存储键，读取时自动迁移
const LEGACY_STORAGE_KEY = "notion_desktop_workspace_v1";

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

export function nowIso(): string {
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
  // 新工作区只带一篇使用说明，其余内容由用户自己创建
  const ts = nowIso();
  const welcomeId = "page-welcome";

  const pages: Page[] = [
    {
      id: welcomeId,
      parentId: null,
      title: "欢迎使用 小悦 (XyNote)",
      icon: "🏠",
      cover: null,
      pageType: "doc",
      isFavorite: false,
      isTrashed: false,
      sortOrder: 0,
      createdAt: ts,
      updatedAt: ts,
    },
  ];

  const blocks: Block[] = [
    makeBlock(welcomeId, 0, "callout", "小悦是本地优先的桌面笔记：工作区页面保存在本机数据库里，侧栏「文件夹」可以直接打开并编辑磁盘上的 Markdown 文件。", { calloutIcon: "💡", color: "gray" }),
    makeBlock(welcomeId, 1, "heading2", "开始使用"),
    makeBlock(welcomeId, 2, "bullet", "<strong>新建页面</strong>：点侧栏「工作区页面」右侧的 +，或按 <code>Ctrl + N</code>。"),
    makeBlock(welcomeId, 3, "bullet", "<strong>打开文件夹</strong>：点侧栏「文件夹」右侧的按钮选择目录，可以同时打开多个；点击笔记即可编辑，改动直接保存回原文件。"),
    makeBlock(welcomeId, 4, "bullet", "<strong>插入内容</strong>：在空行输入 <code>/</code>，选择标题、待办、表格、代码、公式或 Mermaid 图表。"),
    makeBlock(welcomeId, 5, "bullet", "<strong>关联页面</strong>：输入 <code>[[</code> 引用其他页面，被引用的页面底部会显示反向链接。"),
    makeBlock(welcomeId, 6, "bullet", "<strong>搜索</strong>：按 <code>Ctrl + K</code> 全文搜索，并快速跳转到页面或命令。"),
    makeBlock(welcomeId, 7, "heading2", "侧栏文件夹"),
    makeBlock(welcomeId, 8, "bullet", "右键文件夹：新建笔记、新建文件夹、刷新、在文件管理器中显示、复制路径。"),
    makeBlock(welcomeId, 9, "bullet", "右键笔记：重命名（也可以按 <code>F2</code>）、在文件管理器中显示、复制路径。"),
    makeBlock(welcomeId, 10, "bullet", "只显示子文件夹和 .md / .markdown / .txt 笔记；隐藏文件、node_modules 等目录不会出现。"),
    makeBlock(welcomeId, 11, "bullet", "从侧栏移除文件夹只是不再显示，不会删除磁盘上的任何文件。"),
    makeBlock(welcomeId, 12, "toggle", "常用快捷键", { collapsed: true, childrenText: "Ctrl + K：搜索与命令面板\nCtrl + N：新建页面\nCtrl + O：打开单个 .md 文件\nCtrl + S：立即保存\nCtrl + /：切换源码模式\nCtrl + Shift + L：显示或隐藏侧栏\nCtrl + ,：偏好设置（可自定义全部快捷键）" }),
    makeBlock(welcomeId, 13, "paragraph", "这篇文档可以随意修改或删除。"),
  ];

  const store: LocalStore = {
    pages,
    blocks,
    pageLinks: [],
    dbMeta: {},
    dbColumns: [],
    dbRows: [],
    settings: {
      theme: "light",
      fontStyle: "sans",
      fullWidth: "true",
      "appearance.adaptiveWidth": "true",
    },
  };
  return store;
}

let memoryStore: LocalStore | null = null;

export function loadStore(): LocalStore {
  if (memoryStore) return memoryStore;
  if (typeof window === "undefined") {
    memoryStore = createInitialSeedStore();
    return memoryStore;
  }
  try {
    let raw = readHarmonyWorkspaceJson() || window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        window.localStorage.setItem(STORAGE_KEY, legacy);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        raw = legacy;
      }
    }
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
    const serialized = JSON.stringify(store);
    writeHarmonyWorkspaceJson(serialized);
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized);
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
  } else if (templateId === "cornell-notes") {
    page.title = page.title === "无标题" ? "康奈尔深度读书笔记" : page.title;
    page.icon = "📖";
    page.pageType = "doc";
    store.blocks.push(
      makeBlock(page.id, 0, "callout", "书名 / 文章：《填写标题》 ｜ 作者： ｜ 阅读日期： ｜ 推荐度：★★★★★", { calloutIcon: "📖", color: "blue" }),
      makeBlock(page.id, 1, "heading2", "🎯 一句话核心命题"),
      makeBlock(page.id, 2, "quote", "用自己的话写下全书最核心想解决的问题与核心论点。"),
      makeBlock(page.id, 3, "heading2", "🧭 康奈尔双栏笔记（左栏线索提问 · 右栏核心笔记）"),
      makeBlock(page.id, 4, "table", "", {
        headers: ["🔑 线索与关键追问 (Cues)", "📝 核心论据与推导笔记 (Notes)"],
        rows: [
          ["核心概念 / 为什么重要？", "记录关键定义、数据支撑、案例与推导逻辑"],
          ["与我已有认知的冲突点？", "对比既有经验，标记颠覆认知的关键转折"],
          ["适用边界与反例是什么？", "注明该方法成立的前提条件与潜在局限"],
        ],
      }),
      makeBlock(page.id, 5, "heading2", "💎 原文金句精摘"),
      makeBlock(page.id, 6, "bullet", "「摘录触动你的关键原文……」—— 第 xx 页（批注：为什么这句话重要）"),
      makeBlock(page.id, 7, "heading2", "🧠 总结内化与知识关联 (Summary)"),
      makeBlock(page.id, 8, "paragraph", "合上书用三句话复述核心脉络；可输入 [[ 链接工作区内的相关概念或项目笔记。"),
      makeBlock(page.id, 9, "heading2", "✅ 最小可落地行动 (Action Items)"),
      makeBlock(page.id, 10, "todo", "提炼 1 个可在未来 7 天内实践的具体改变并验证效果", { checked: false })
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
        return `<a href="#" data-page-id="${target.id}" class="nb-wiki-link">${iconAsText(target.icon)} ${escapeHtml(target.title)}</a>`;
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
          const imgUrl =
          b.props.localSrc && (!b.props.url || b.props.url.startsWith("data:"))
            ? b.props.localSrc
            : b.props.url || b.content || "";
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

export function loadBrowserStorageConfig(): BrowserStorageConfig {
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
    dbFilePath: joinWinPath(cfg.activeDataDir, "xynote.db"),
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
        const imgUrl =
          b.props.localSrc && (!b.props.url || b.props.url.startsWith("data:"))
            ? b.props.localSrc
            : b.props.url || b.content || "";
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

export async function pickFontFileDialog(
  defaultDir?: string
): Promise<string | null> {
  if (isTauriRuntime()) {
    return invoke<string | null>("pick_font_file_dialog", {
      defaultDir: defaultDir ?? null,
    });
  }
  return null;
}

export async function importFontToDataDir(
  path: string
): Promise<ImportedCustomFont> {
  if (isTauriRuntime()) {
    return invoke<ImportedCustomFont>("import_font_to_data_dir", { path });
  }
  const clean = path.trim();
  const stem =
    clean.replace(/\\/g, "/").split("/").pop()?.replace(/\.(ttf|otf|woff2?|ttc)$/i, "") ||
    "custom-font";
  return {
    storedPath: clean,
    resolvedPath: clean,
    displayName: stem,
    byteSize: 0,
  };
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

/** 磁盘文件在打开后被其他程序改过时，保存会抛出这个错误（不会覆盖对方的改动） */
export class LocalFileConflictError extends Error {
  constructor(public readonly diskUpdatedAt: string) {
    super("文件已被其他程序修改");
    this.name = "LocalFileConflictError";
  }
}

/**
 * 保存磁盘 Markdown 文件。传入 expectedUpdatedAt（打开或上次保存时的修改时间）会做冲突检测；
 * 不传则直接覆盖（用于「仍然覆盖」与新文件）。
 */
export async function saveLocalMarkdownFile(
  filePath: string,
  blocks?: SaveBlockItem[] | null,
  rawMarkdown?: string | null,
  expectedUpdatedAt?: string | null
): Promise<LocalMarkdownDocument> {
  if (isTauriRuntime()) {
    try {
      return await invoke<LocalMarkdownDocument>("save_local_markdown_file", {
        filePath,
        blocks: blocks ?? null,
        rawMarkdown: rawMarkdown ?? null,
        expectedUpdatedAt: expectedUpdatedAt ?? null,
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (msg.startsWith("Conflict: ")) {
        throw new LocalFileConflictError(msg.slice("Conflict: ".length));
      }
      throw err;
    }
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

// 拆分出去的模块：对外仍从 client 导入，调用方不用改
export * from "./folders";
export * from "./stylePlugins";
