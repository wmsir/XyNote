import katex from "katex";
import { openExternalUrl } from "../../api/sync";
import type { Block, BlockProps, BlockType } from "../../types/notion";
import { isSafeInlineHref } from "./sanitizeHtml";

export type SlashActionType = BlockType | "subpage";

export interface SlashCommandItem {
  type: SlashActionType;
  group: string;
  label: string;
  description: string;
  shortcut?: string;
  keywords: string[];
}

export const SLASH_COMMAND_ITEMS: SlashCommandItem[] = [
  {
    type: "paragraph",
    group: "基础块",
    label: "正文文本",
    description: "使用简洁纯文本记录段落内容",
    keywords: ["p", "text", "paragraph", "文本", "正文", "段落", "纯文本"],
  },
  {
    type: "heading1",
    group: "基础块",
    label: "一级标题",
    description: "大号章节主标题",
    shortcut: "#",
    keywords: ["h1", "heading1", "title", "标题", "一级标题", "大标题", "#"],
  },
  {
    type: "heading2",
    group: "基础块",
    label: "二级标题",
    description: "中号分节标题",
    shortcut: "##",
    keywords: ["h2", "heading2", "标题", "二级标题", "中标题", "##"],
  },
  {
    type: "heading3",
    group: "基础块",
    label: "三级标题",
    description: "小号子节标题",
    shortcut: "###",
    keywords: ["h3", "heading3", "标题", "三级标题", "小标题", "###"],
  },
  {
    type: "todo",
    group: "列表与折叠",
    label: "待办事项",
    description: "带复选框的任务清单项",
    shortcut: "[]",
    keywords: ["todo", "task", "checkbox", "check", "待办", "任务", "清单", "复选框"],
  },
  {
    type: "bullet",
    group: "列表与折叠",
    label: "无序列表",
    description: "创建简洁的圆点项目列表",
    shortcut: "-",
    keywords: ["bullet", "ul", "list", "列表", "无序", "无序列表", "项目符号"],
  },
  {
    type: "numbered",
    group: "列表与折叠",
    label: "有序列表",
    description: "自动连续编号的列表项",
    shortcut: "1.",
    keywords: ["number", "numbered", "ol", "有序", "有序列表", "编号", "数字列表"],
  },
  {
    type: "toggle",
    group: "列表与折叠",
    label: "折叠列表",
    description: "点击三角可展开或收起嵌套内容",
    keywords: ["toggle", "collapse", "detail", "折叠", "折叠列表", "展开", "收起"],
  },
  {
    type: "quote",
    group: "标注与结构",
    label: "引用",
    description: "高亮摘录金句或重要段落",
    shortcut: ">",
    keywords: ["quote", "blockquote", "引用", "摘录", "语录"],
  },
  {
    type: "callout",
    group: "标注与结构",
    label: "提示框 Callout",
    description: "带图标与底色的重点提示卡片",
    keywords: ["callout", "alert", "info", "tip", "提示", "提示框", "高亮框", "标注"],
  },
  {
    type: "code",
    group: "标注与结构",
    label: "代码块",
    description: "支持多语言选择、自动换行切换与一键复制的代码片段",
    shortcut: "```",
    keywords: ["code", "snippet", "pre", "代码", "代码块", "源码"],
  },
  {
    type: "mermaid",
    group: "标注与结构",
    label: "Mermaid 流程图 / 架构图",
    description: "离线渲染流程图、时序图、状态图、类图与甘特图",
    shortcut: "```mermaid",
    keywords: [
      "mermaid",
      "mmd",
      "diagram",
      "flowchart",
      "sequence",
      "graph",
      "gantt",
      "er",
      "state",
      "class",
      "流程图",
      "架构图",
      "时序图",
      "甘特图",
      "状态图",
      "类图",
      "图表",
    ],
  },
  {
    type: "table",
    group: "标注与结构",
    label: "简单表格",
    description: "支持多行自适应列宽、行内富文本与增删行列的表格",
    keywords: ["table", "grid", "表格", "简单表格", "数据表"],
  },
  {
    type: "divider",
    group: "标注与结构",
    label: "分割线",
    description: "在视觉上清晰分隔不同章节",
    shortcut: "---",
    keywords: ["divider", "hr", "line", "分割", "分割线", "横线"],
  },
  {
    type: "math",
    group: "媒体与公式",
    label: "数学公式 (KaTeX)",
    description: "基于 KaTeX 渲染居中 LaTeX 科学公式",
    shortcut: "$$",
    keywords: [
      "math",
      "latex",
      "katex",
      "formula",
      "equation",
      "公式",
      "数学",
      "数学公式",
      "$$",
    ],
  },
  {
    type: "image",
    group: "媒体与公式",
    label: "图片",
    description: "上传本地离线图片或嵌入网络图片链接",
    shortcut: "![]",
    keywords: [
      "image",
      "img",
      "picture",
      "photo",
      "图片",
      "图像",
      "插图",
      "照片",
    ],
  },
  {
    type: "bookmark",
    group: "媒体与公式",
    label: "网页书签",
    description: "自动抓取网页标题、摘要与站点图标卡片",
    keywords: [
      "bookmark",
      "link",
      "url",
      "card",
      "web",
      "书签",
      "网页书签",
      "链接",
      "网址卡片",
    ],
  },
  {
    type: "embed",
    group: "媒体与公式",
    label: "视频与网页嵌入",
    description: "嵌入 YouTube、Bilibili、MP4 视频或交互网页",
    keywords: [
      "embed",
      "video",
      "iframe",
      "youtube",
      "bilibili",
      "vimeo",
      "mp4",
      "视频",
      "嵌入",
      "内嵌",
      "b站",
    ],
  },
  {
    type: "file",
    group: "媒体与公式",
    label: "附件",
    description: "添加 PDF、Word、表格、压缩包等任意文件，点击用系统程序打开",
    keywords: ["file", "attachment", "upload", "pdf", "附件", "文件", "上传", "fujian", "wenjian"],
  },
  {
    type: "subpage",
    group: "页面联动",
    label: "新建子页面",
    description: "在当前页面下创建子文档并插入双向链接",
    keywords: ["page", "subpage", "doc", "link", "页面", "子页面", "新建页面", "嵌套页面"],
  },
];

export interface MathSymbolPreset {
  label: string;
  latex: string;
}

export const MATH_SYMBOL_PRESETS: MathSymbolPreset[] = [
  { label: "分数 a/b", latex: "\\frac{a}{b}" },
  { label: "求和 ∑", latex: "\\sum_{i=1}^{n}" },
  { label: "积分 ∫", latex: "\\int_0^\\infty" },
  { label: "根号 √", latex: "\\sqrt{x}" },
  {
    label: "矩阵 [ ]",
    latex: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}",
  },
];

export interface BlockColorOption {
  value: string;
  label: string;
  shortLabel: string;
}

export const BLOCK_COLOR_OPTIONS: BlockColorOption[] = [
  { value: "default", label: "默认背景", shortLabel: "默认" },
  { value: "gray", label: "柔和灰", shortLabel: "灰" },
  { value: "brown", label: "暖棕褐", shortLabel: "棕" },
  { value: "amber", label: "琥珀黄", shortLabel: "黄" },
  { value: "green", label: "森系绿", shortLabel: "绿" },
  { value: "blue", label: "晴空蓝", shortLabel: "蓝" },
  { value: "purple", label: "丁香紫", shortLabel: "紫" },
  { value: "red", label: "珊瑚红", shortLabel: "红" },
];

export interface CodeLanguageOption {
  value: string;
  label: string;
}

export const CODE_LANGUAGES: CodeLanguageOption[] = [
  { value: "mermaid", label: "Mermaid 图表" },
  { value: "java", label: "Java" },
  { value: "kotlin", label: "Kotlin" },
  { value: "scala", label: "Scala" },
  { value: "rust", label: "Rust" },
  { value: "typescript", label: "TypeScript" },
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
  { value: "go", label: "Go" },
  { value: "sql", label: "SQL" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "csharp", label: "C#" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "swift", label: "Swift" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "XML" },
  { value: "toml", label: "TOML" },
  { value: "ini", label: "INI" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "bash", label: "Bash / Shell" },
  { value: "powershell", label: "PowerShell" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "graphql", label: "GraphQL" },
  { value: "markdown", label: "Markdown" },
  { value: "plaintext", label: "Plain Text" },
];

export interface MermaidTemplatePreset {
  id: string;
  label: string;
  badge: string;
  code: string;
}

export const DEFAULT_MERMAID_STARTER = `flowchart TB
  subgraph Entry["一、业务调用入口"]
    UI["前端工作台<br/>Workspace UI"]
    API["网关服务<br/>Gateway API"]
  end
  subgraph Core["二、核心编排与规则决策"]
    SVC["编排服务<br/>OrchestratorService"]
    RULE{"风控规则判定"}
  end
  UI --> API --> SVC --> RULE
  RULE -->|通过| PASS["落库与异步通知<br/>SQLite WAL"]
  RULE -->|人工复核| AUDIT["转人工审核队列"]`;

export const MERMAID_TEMPLATE_PRESETS: MermaidTemplatePreset[] = [
  {
    id: "flowchart",
    label: "业务架构流程图",
    badge: "Flowchart",
    code: DEFAULT_MERMAID_STARTER,
  },
  {
    id: "sequence",
    label: "微服务时序交互图",
    badge: "Sequence",
    code: `sequenceDiagram
  autonumber
  participant C as 客户端 UI
  participant G as Controller 层
  participant S as 领域服务 Service
  participant DB as 本地存储 SQLite
  C->>G: POST /decision/evaluate
  G->>S: getNewDecisionResult(actualId)
  S->>DB: 查询历史核保与规则快照
  DB-->>S: 返回聚合结果
  S-->>G: Map<String, String>
  G-->>C: 200 OK 渲染结论卡片`,
  },
  {
    id: "state",
    label: "业务状态流转图",
    badge: "State",
    code: `stateDiagram-v2
  [*] --> 待提交
  待提交 --> 自动规则校验 : 提交申请
  自动规则校验 --> 自动通过 : 命中绿通规则
  自动规则校验 --> 人工复核 : 命中风险规则
  人工复核 --> 审批通过 : 核保师签批
  人工复核 --> 退回补充 : 材料不全
  退回补充 --> 自动规则校验 : 重新提交
  自动通过 --> [*]
  审批通过 --> [*]`,
  },
  {
    id: "er",
    label: "数据库实体关系图",
    badge: "ER Diagram",
    code: `erDiagram
  PAGES ||--o{ BLOCKS : contains
  PAGES ||--o{ PAGE_LINKS : references
  PAGES {
    string id PK
    string parent_id FK
    string title
    string page_type
  }
  BLOCKS {
    string id PK
    string page_id FK
    string block_type
    string content
    int sort_order
  }`,
  },
  {
    id: "class",
    label: "领域模型类图",
    badge: "Class",
    code: `classDiagram
  class AppraisalController {
    +getNewDecisionResult(actualId) Map~String,String~
    +refreshDecision(policyId) DecisionDTO
  }
  class DecisionEngineService {
    +evaluateRules(ctx) RuleResult
    +buildFallbackMap(id) Map~String,String~
  }
  AppraisalController --> DecisionEngineService : delegates`,
  },
  {
    id: "gantt",
    label: "项目里程碑甘特图",
    badge: "Gantt",
    code: `gantt
  title 架构升级研发排期
  dateFormat YYYY-MM-DD
  section 核心引擎
    存储与解析层改造 :done, a1, 2026-11-01, 5d
    离线图表渲染集成 :active, a2, after a1, 4d
  section 体验打磨
    全屏缩放与宽屏适配 :b1, after a2, 3d
    端到端回归验收 :b2, after b1, 2d`,
  },
];

export function stripMermaidLeadingDirectives(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(/^\uFEFF/, "").trimStart();
  // Strip optional YAML frontmatter `---\n...\n---`
  if (s.startsWith("---")) {
    const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\s*/.exec(s);
    if (fmMatch) {
      s = s.slice(fmMatch[0].length).trimStart();
    }
  }
  // Strip leading `%%{init: ...}%%` or `%% ...` comment lines
  let changed = true;
  while (changed) {
    changed = false;
    const initBlock = /^%%\{[\s\S]*?\}%%\s*/.exec(s);
    if (initBlock) {
      s = s.slice(initBlock[0].length).trimStart();
      changed = true;
      continue;
    }
    const lineComment = /^%%[^\r\n]*(?:\r?\n|$)\s*/.exec(s);
    if (lineComment) {
      s = s.slice(lineComment[0].length).trimStart();
      changed = true;
    }
  }
  return s;
}

export function looksLikeMermaidCode(raw: string): boolean {
  const stripped = stripMermaidLeadingDirectives(raw);
  if (!stripped) return false;
  return /^(?:(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|gantt\b|pie(?:\s+showData)?\b|mindmap\b|timeline\b|gitGraph\b|journey\b|quadrantChart\b|C4(?:Context|Container|Component|Dynamic|Deployment)\b)/.test(
    stripped
  );
}

export function detectMermaidDiagramLabel(raw: string): string {
  const stripped = stripMermaidLeadingDirectives(raw);
  if (/^(?:flowchart|graph)\b/.test(stripped)) return "Mermaid 流程图";
  if (/^sequenceDiagram\b/.test(stripped)) return "Mermaid 时序图";
  if (/^stateDiagram(?:-v2)?\b/.test(stripped)) return "Mermaid 状态图";
  if (/^classDiagram\b/.test(stripped)) return "Mermaid 类图";
  if (/^erDiagram\b/.test(stripped)) return "Mermaid ER 关系图";
  if (/^gantt\b/.test(stripped)) return "Mermaid 甘特图";
  if (/^mindmap\b/.test(stripped)) return "Mermaid 思维导图";
  if (/^pie\b/.test(stripped)) return "Mermaid 饼图";
  if (/^timeline\b/.test(stripped)) return "Mermaid 时间轴";
  if (/^gitGraph\b/.test(stripped)) return "Mermaid Git 分支图";
  if (/^C4/i.test(stripped)) return "Mermaid C4 架构图";
  return "Mermaid 架构图";
}

export const CALLOUT_ICONS: string[] = [
  "💡",
  "📌",
  "🚀",
  "⚠️",
  "✅",
  "🔥",
  "📝",
  "🎯",
  "💬",
  "🔍",
  "✨",
  "🧭",
  "🧠",
  "🛠️",
  "📅",
  "📎",
  "📣",
  "🌟",
];

export function generateBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u200B/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

export function isHtmlVisuallyEmpty(html: string): boolean {
  if (!html) return true;
  if (/data-page-id=/i.test(html) || /data-latex=/i.test(html)) return false;
  return stripHtmlToText(html).length === 0;
}

export function normalizeCleanHtml(html: string): string {
  const trimmed = html.trim();
  if (
    trimmed === "" ||
    trimmed === "\u200B" ||
    trimmed === "<br>" ||
    trimmed === "<br/>" ||
    trimmed === "<br />" ||
    trimmed === "<div><br></div>"
  ) {
    return "";
  }
  return html;
}

export function computeBlockPlainText(
  blockType: BlockType,
  content: string,
  props: BlockProps
): string {
  if (blockType === "divider") {
    return "";
  }
  // Raw unescaped content for `code`, `math`, and `mermaid` blocks!
  if (
    blockType === "code" ||
    blockType === "math" ||
    blockType === "mermaid"
  ) {
    return content;
  }
  if (blockType === "table") {
    const headers = props.headers ?? [];
    const rows = props.rows ?? [];
    return [...headers, ...rows.flat()]
      .map((cell) => stripHtmlToText(cell))
      .filter(Boolean)
      .join(" ");
  }
  if (blockType === "image") {
    const safeUrl =
      props.url && !props.url.startsWith("data:") ? props.url : "";
    return [props.caption, safeUrl, props.ocrText].filter(Boolean).join(" ").trim();
  }
  if (blockType === "file") {
    return (props.fileName ?? "").trim();
  }
  if (blockType === "bookmark") {
    return [
      props.bookmarkTitle,
      props.bookmarkDesc,
      props.bookmarkSite,
      props.url,
      props.caption,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (blockType === "embed") {
    return [props.embedProvider, props.caption, props.url]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  const base = stripHtmlToText(content);
  if (blockType === "toggle" && props.childrenText?.trim()) {
    return base
      ? `${base}\n${props.childrenText.trim()}`
      : props.childrenText.trim();
  }
  return base;
}

export function normalizeCodeLanguage(lang?: string): string {
  if (!lang || !lang.trim()) return "plaintext";
  const lower = lang.trim().toLowerCase();
  const aliasMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    py: "python",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    ps1: "powershell",
    pwsh: "powershell",
    yml: "yaml",
    "c++": "cpp",
    cxx: "cpp",
    cc: "cpp",
    hpp: "cpp",
    "c#": "csharp",
    cs: "csharp",
    dotnet: "csharp",
    kt: "kotlin",
    kts: "kotlin",
    rb: "ruby",
    docker: "dockerfile",
    gql: "graphql",
    mmd: "mermaid",
    md: "markdown",
    htm: "html",
    text: "plaintext",
    txt: "plaintext",
    plain: "plaintext",
    "plain text": "plaintext",
  };
  const mapped = aliasMap[lower] ?? lower;
  const cleaned = mapped.replace(/[^a-z0-9_+#.-]/g, "");
  return cleaned || "plaintext";
}

export function buildPropsForBlockType(
  targetType: BlockType,
  currentProps: BlockProps = {}
): BlockProps {
  const baseColor =
    currentProps.color && currentProps.color !== "default"
      ? currentProps.color
      : undefined;

  switch (targetType) {
    case "todo":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        checked: Boolean(currentProps.checked),
      };
    case "toggle":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        collapsed: currentProps.collapsed ?? false,
        childrenText: currentProps.childrenText ?? "",
      };
    case "callout":
      return {
        calloutIcon: currentProps.calloutIcon || "💡",
        color: currentProps.color || "amber",
      };
    case "code":
      return {
        language: normalizeCodeLanguage(currentProps.language || "typescript"),
        wordWrap: currentProps.wordWrap ?? true,
      };
    case "mermaid":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        mermaidView: currentProps.mermaidView ?? "preview",
      };
    case "table":
      return {
        headers:
          currentProps.headers && currentProps.headers.length > 0
            ? currentProps.headers
            : ["列 1", "列 2", "列 3"],
        rows:
          currentProps.rows && currentProps.rows.length > 0
            ? currentProps.rows
            : [
                ["", "", ""],
                ["", "", ""],
              ],
        ...(currentProps.colAlignments
          ? { colAlignments: currentProps.colAlignments }
          : {}),
      };
    case "math":
      return baseColor ? { color: baseColor } : {};
    case "image":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        url: currentProps.url ?? "",
        caption: currentProps.caption ?? "",
        imageWidth: currentProps.imageWidth ?? "full",
        ...(currentProps.ocrText ? { ocrText: currentProps.ocrText } : {}),
      };
    case "bookmark":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        url: currentProps.url ?? "",
        bookmarkTitle: currentProps.bookmarkTitle,
        bookmarkDesc: currentProps.bookmarkDesc,
        bookmarkSite: currentProps.bookmarkSite,
        bookmarkIcon: currentProps.bookmarkIcon,
        caption: currentProps.caption,
      };
    case "embed":
      return {
        ...(baseColor ? { color: baseColor } : {}),
        url: currentProps.url ?? "",
        embedProvider: currentProps.embedProvider,
        caption: currentProps.caption ?? "",
      };
    case "ref":
      return {
        refPageId: currentProps.refPageId ?? "",
        refBlockId: currentProps.refBlockId ?? "",
      };
    case "file":
      return {
        filePath: currentProps.filePath ?? "",
        fileName: currentProps.fileName ?? "",
        ...(currentProps.fileSize !== undefined ? { fileSize: currentProps.fileSize } : {}),
        ...(currentProps.mimeType ? { mimeType: currentProps.mimeType } : {}),
      };
    case "divider":
      return {};
    default:
      return baseColor ? { color: baseColor } : {};
  }
}

export function createNewBlock(
  pageId: string,
  blockType: BlockType = "paragraph",
  sortOrder = 0,
  content = "",
  initialProps?: BlockProps
): Block {
  const now = new Date().toISOString();
  const props = buildPropsForBlockType(blockType, initialProps);
  return {
    id: generateBlockId(),
    pageId,
    blockType,
    content,
    plainText: computeBlockPlainText(blockType, content, props),
    props,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

export function isRichTextEditableBlock(blockType: BlockType): boolean {
  return (
    blockType !== "code" &&
    blockType !== "mermaid" &&
    blockType !== "divider" &&
    blockType !== "table" &&
    blockType !== "math" &&
    blockType !== "image" &&
    blockType !== "bookmark" &&
    blockType !== "embed" &&
    blockType !== "file" &&
    blockType !== "ref"
  );
}

export function isStandaloneStructuralBlock(blockType: BlockType): boolean {
  return !isRichTextEditableBlock(blockType);
}

export function getPlaceholderForBlock(blockType: BlockType): string {
  switch (blockType) {
    case "heading1":
      return "一级标题";
    case "heading2":
      return "二级标题";
    case "heading3":
      return "三级标题";
    case "todo":
      return "待办事项";
    case "bullet":
    case "numbered":
      return "列表项";
    case "toggle":
      return "折叠标题";
    case "quote":
      return "输入引用内容…";
    case "callout":
      return "输入重点提示内容…";
    default:
      return "输入 '/' 唤起命令，输入 '[[' 关联页面…";
  }
}

/* ============================================================================
 * Embed Provider & Video URL Parser
 * ========================================================================== */

export interface ParsedEmbedSource {
  kind: "video" | "iframe";
  provider: string;
  embedUrl: string;
  originalUrl: string;
}

export function normalizeExternalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (
    compact.startsWith("javascript:") ||
    compact.startsWith("vbscript:") ||
    compact.startsWith("data:text/html") ||
    compact.startsWith("data:image/svg+xml")
  ) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:(?:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|x-icon)|video\/[a-z0-9.+-]+)[;,]/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) {
    return "";
  }
  return `https://${trimmed}`;
}

export function normalizeInlineLinkHref(rawHref: string): string {
  let trimmed = rawHref.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return "";

  // Windows local path e.g. `D:\work\App.java` or `D:/work/App.java` -> `file:///D:/work/App.java`
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const forward = trimmed.replace(/\\/g, "/").replace(/ /g, "%20");
    return `file:///${forward}`;
  }

  // Strictly block javascript:, vbscript:, data: and other unsafe schemes before normalization
  if (!isSafeInlineHref(trimmed)) {
    return "";
  }

  // Standard safe schemes (`file://`, `https://`, `http://`, `vscode://`, `mailto:`, `tel:`)
  if (/^(?:file|https?|vscode):\/\//i.test(trimmed)) {
    return trimmed.replace(/ /g, "%20");
  }
  if (/^(?:mailto|tel):/i.test(trimmed)) {
    return trimmed;
  }

  // Anchor or relative workspace path (`#section`, `./doc.md`, `../doc.md`, `/path`)
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/")
  ) {
    return trimmed.replace(/ /g, "%20");
  }

  // Domain-like bare URL (`github.com/...`, `localhost:3000/...`)
  if (
    /^(?:localhost(?::\d+)?|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)(?:[/?#]|$)/.test(
      trimmed
    )
  ) {
    return `https://${trimmed}`;
  }

  // Relative file reference (e.g. `docs/arch.md` or `uwDetail.js#L62`)
  return trimmed.replace(/ /g, "%20");
}

export function fileUrlToLocalPath(rawHref: string): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();

  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const withoutAnchor = trimmed.split("#")[0].split("?")[0];
    return withoutAnchor.replace(/\//g, "\\");
  }

  if (!/^file:\/\//i.test(trimmed)) {
    return null;
  }

  // Strip `#L62` line anchor & `?line=62` query string
  let body = trimmed.replace(/^file:\/\//i, "");
  body = body.split("#")[0].split("?")[0];

  // `file:///d:/path` -> `/d:/path` -> `d:/path` on Windows drive letters
  if (/^\/+[a-zA-Z]:[\\/]/.test(body)) {
    body = body.replace(/^\/+/, "");
  }

  try {
    body = decodeURIComponent(body);
  } catch {
    body = body.replace(/%20/g, " ");
  }

  if (/^[a-zA-Z]:\//.test(body)) {
    body = body.replace(/\//g, "\\");
  }

  return body.trim() || null;
}

export function activateInlineHref(
  rawHref: string,
  openExplorer: (localPath: string) => Promise<void>
): boolean {
  if (!rawHref) return false;
  const localPath = fileUrlToLocalPath(rawHref);
  if (localPath) {
    openExplorer(localPath).catch(() => {});
    return true;
  }

  if (/^(?:https?:\/\/|mailto:)/i.test(rawHref)) {
    openExternalUrl(rawHref).catch(() =>
      window.open(rawHref, "_blank", "noopener,noreferrer")
    );
    return true;
  }

  if (/^(?:vscode:\/\/|tel:)/i.test(rawHref)) {
    window.open(rawHref, "_blank", "noopener,noreferrer");
    return true;
  }

  if (rawHref.startsWith("#") && rawHref.length > 1) {
    const targetEl = document.getElementById(rawHref.slice(1));
    targetEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  return false;
}

export function parseEmbedSource(rawUrl: string): ParsedEmbedSource | null {
  const normalized = normalizeExternalUrl(rawUrl);
  if (!normalized) return null;

  // Direct video files (.mp4 / .webm / .ogg) over http(s) or data:video URI
  if (
    /^data:video\//i.test(normalized) ||
    (/^https?:\/\//i.test(normalized) &&
      /\.(mp4|webm|ogg)(\?.*|#.*)?$/i.test(normalized))
  ) {
    return {
      kind: "video",
      provider: "Video",
      embedUrl: normalized,
      originalUrl: normalized,
    };
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }

  // YouTube watch / youtu.be / shorts / embed
  const ytMatch =
    /(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/i.exec(
      normalized
    );
  if (ytMatch) {
    return {
      kind: "iframe",
      provider: "YouTube",
      embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}`,
      originalUrl: normalized,
    };
  }

  // Bilibili BV / av / player
  const biliBv = /bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/i.exec(normalized);
  if (biliBv) {
    return {
      kind: "iframe",
      provider: "Bilibili",
      embedUrl: `https://player.bilibili.com/player.html?bvid=${biliBv[1]}&high_quality=1&autoplay=0`,
      originalUrl: normalized,
    };
  }
  const biliAv = /bilibili\.com\/video\/av(\d+)/i.exec(normalized);
  if (biliAv) {
    return {
      kind: "iframe",
      provider: "Bilibili",
      embedUrl: `https://player.bilibili.com/player.html?aid=${biliAv[1]}&high_quality=1&autoplay=0`,
      originalUrl: normalized,
    };
  }
  if (/player\.bilibili\.com\/player\.html/i.test(normalized)) {
    return {
      kind: "iframe",
      provider: "Bilibili",
      embedUrl: normalized,
      originalUrl: normalized,
    };
  }

  // Vimeo
  const vimeoMatch =
    /(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d+)/i.exec(normalized);
  if (vimeoMatch) {
    return {
      kind: "iframe",
      provider: "Vimeo",
      embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}`,
      originalUrl: normalized,
    };
  }

  // Generic HTTPS/HTTP embeddable page
  let hostLabel = "网页嵌入";
  try {
    hostLabel = new URL(normalized).hostname.replace(/^www\./, "") || "网页嵌入";
  } catch {
    // Keep default label
  }

  return {
    kind: "iframe",
    provider: hostLabel,
    embedUrl: normalized,
    originalUrl: normalized,
  };
}

/* ============================================================================
 * Caret, Selection & DOM Range Utilities
 * ========================================================================== */

export function placeCaretAtStart(el: HTMLElement): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaretAtEnd(el: HTMLElement): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaretAtTextOffset(el: HTMLElement, targetOffset: number): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, targetOffset);
  let current = walker.nextNode() as Text | null;

  while (current) {
    const len = current.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(current, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    current = walker.nextNode() as Text | null;
  }

  placeCaretAtEnd(el);
}

export function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;

  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  const textBefore = preRange.toString().replace(/\u200B/g, "");
  if (textBefore.length > 0) return false;

  const frag = preRange.cloneContents();
  return !frag.querySelector("a, img, br");
}

export function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;

  const postRange = document.createRange();
  postRange.selectNodeContents(el);
  postRange.setStart(range.endContainer, range.endOffset);
  const textAfter = postRange.toString().replace(/\u200B/g, "");
  return textAfter.length === 0;
}

export function getCaretViewportPoint(fallbackEl: HTMLElement): {
  x: number;
  y: number;
  bottom: number;
} {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rects = range.getClientRects();
    if (rects.length > 0) {
      const r = rects[0];
      if (r.width > 0 || r.height > 0) {
        return { x: r.left, y: r.top, bottom: r.bottom };
      }
    }
    const bounding = range.getBoundingClientRect();
    if (bounding.top > 0 || bounding.left > 0) {
      return {
        x: bounding.left,
        y: bounding.top,
        bottom: bounding.bottom || bounding.top + 22,
      };
    }
  }
  const fallbackRect = fallbackEl.getBoundingClientRect();
  return {
    x: fallbackRect.left + 4,
    y: fallbackRect.top + 2,
    bottom: fallbackRect.top + 26,
  };
}

export function getTextBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return "";

  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString();
}

export function deleteCharsBeforeCaret(el: HTMLElement, charCount: number): void {
  if (charCount <= 0) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const caretRange = sel.getRangeAt(0);
  if (!el.contains(caretRange.startContainer)) return;

  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(caretRange.startContainer, caretRange.startOffset);

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    textNodes.push(node);
    node = walker.nextNode() as Text | null;
  }

  let remaining = charCount;
  const deleteRange = document.createRange();
  deleteRange.setEnd(caretRange.startContainer, caretRange.startOffset);

  if (caretRange.startContainer.nodeType === Node.TEXT_NODE) {
    const startText = caretRange.startContainer as Text;
    const idx = textNodes.indexOf(startText);
    let offsetInCurrent = caretRange.startOffset;

    for (let i = idx; i >= 0; i--) {
      const tNode = textNodes[i];
      const available =
        i === idx ? offsetInCurrent : (tNode.textContent?.length ?? 0);
      if (available >= remaining) {
        deleteRange.setStart(tNode, available - remaining);
        deleteRange.deleteContents();
        const collapsed = document.createRange();
        collapsed.setStart(deleteRange.startContainer, deleteRange.startOffset);
        collapsed.collapse(true);
        sel.removeAllRanges();
        sel.addRange(collapsed);
        return;
      }
      remaining -= available;
      offsetInCurrent = 0;
    }
  }

  preRange.deleteContents();
}

export function insertHtmlAtCaret(el: HTMLElement, htmlSnippet: string): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) {
    placeCaretAtEnd(el);
  }
  const activeRange = sel.getRangeAt(0);
  activeRange.deleteContents();

  const temp = document.createElement("div");
  temp.innerHTML = htmlSnippet;
  const frag = document.createDocumentFragment();
  let lastInserted: Node | null = null;
  while (temp.firstChild) {
    lastInserted = frag.appendChild(temp.firstChild);
  }
  activeRange.insertNode(frag);

  if (lastInserted) {
    const afterRange = document.createRange();
    afterRange.setStartAfter(lastInserted);
    afterRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(afterRange);
  }
}

export function splitElementAtCaret(el: HTMLElement): {
  beforeHtml: string;
  afterHtml: string;
} {
  const sel = window.getSelection();
  if (
    !sel ||
    sel.rangeCount === 0 ||
    !el.contains(sel.getRangeAt(0).startContainer)
  ) {
    return {
      beforeHtml: normalizeCleanHtml(el.innerHTML),
      afterHtml: "",
    };
  }

  const caretRange = sel.getRangeAt(0);
  if (!caretRange.collapsed) {
    caretRange.deleteContents();
  }

  const afterRange = document.createRange();
  afterRange.selectNodeContents(el);
  afterRange.setStart(caretRange.endContainer, caretRange.endOffset);

  const afterFrag = afterRange.extractContents();
  const afterContainer = document.createElement("div");
  afterContainer.appendChild(afterFrag);

  const beforeHtml = normalizeCleanHtml(el.innerHTML);
  const afterHtml = normalizeCleanHtml(afterContainer.innerHTML);

  return { beforeHtml, afterHtml };
}

/* ============================================================================
 * Trigger, Block Markdown & True WYSIWYG Inline Markdown Detection
 * ========================================================================== */

export interface DetectedTrigger {
  mode: "slash" | "wikilink";
  query: string;
  removeChars: number;
}

export function detectMenuTrigger(
  textBeforeCaret: string
): DetectedTrigger | null {
  if (!textBeforeCaret) return null;

  // 1. Check `[[` bidirectional page link trigger first
  const lastDoubleBracket = textBeforeCaret.lastIndexOf("[[");
  if (lastDoubleBracket !== -1) {
    const afterBrackets = textBeforeCaret.slice(lastDoubleBracket + 2);
    if (
      !afterBrackets.includes("]]") &&
      !afterBrackets.includes("\n") &&
      afterBrackets.length <= 40
    ) {
      return {
        mode: "wikilink",
        query: afterBrackets,
        removeChars: afterBrackets.length + 2,
      };
    }
  }

  // 2. Check `/` slash command trigger at start of block or right after space
  const slashMatch = /(?:^|[\s\u00A0])\/([^\s\u00A0/]{0,24})$/.exec(
    textBeforeCaret
  );
  if (slashMatch) {
    const query = slashMatch[1];
    return {
      mode: "slash",
      query,
      removeChars: query.length + 1,
    };
  }

  return null;
}

export interface MarkdownShortcutMatch {
  blockType: BlockType;
  props?: BlockProps;
  initialContent?: string;
  removeChars: number;
}

export function matchMarkdownShortcut(
  textBeforeCaret: string
): MarkdownShortcutMatch | null {
  const clean = textBeforeCaret.replace(/^\u200B+/, "");
  const offsetDelta = textBeforeCaret.length - clean.length;

  // Divider: `---` or `--- `
  if (clean === "---" || /^---[\s\u00A0]$/.test(clean)) {
    return { blockType: "divider", removeChars: textBeforeCaret.length };
  }

  // Code or Mermaid block fence: ``` or ```lang + space
  const fenceMatch = /^```([a-zA-Z0-9_+#.-]*)[\s\u00A0]?$/.exec(clean);
  if (fenceMatch && (clean === "```" || /[\s\u00A0]$/.test(clean))) {
    const rawLang = fenceMatch[1].trim();
    const normalizedLang = normalizeCodeLanguage(rawLang || "typescript");
    if (normalizedLang === "mermaid") {
      return {
        blockType: "mermaid",
        props: { mermaidView: "split" },
        initialContent: "",
        removeChars: textBeforeCaret.length,
      };
    }
    return {
      blockType: "code",
      props: { language: normalizedLang, wordWrap: true },
      removeChars: textBeforeCaret.length,
    };
  }

  // Math block: `$$ ` (opens empty KaTeX editor) OR `$$formula$$ `
  if (/^\$\$[\s\u00A0]$/.test(clean)) {
    return {
      blockType: "math",
      initialContent: "",
      removeChars: textBeforeCaret.length,
    };
  }
  const inlineDisplayMath = /^\$\$([^$\n]+)\$\$[\s\u00A0]$/.exec(clean);
  if (inlineDisplayMath) {
    return {
      blockType: "math",
      initialContent: inlineDisplayMath[1].trim(),
      removeChars: textBeforeCaret.length,
    };
  }

  // Image block: `![caption](https://...) `
  const imgShortcut =
    /^!\[([^\]\n]*)\]\(((?:https?:\/\/|data:image\/)[^\s)\n]+)\)[\s\u00A0]$/.exec(
      clean
    );
  if (imgShortcut) {
    return {
      blockType: "image",
      props: {
        caption: imgShortcut[1],
        url: imgShortcut[2],
        imageWidth: "full",
      },
      removeChars: textBeforeCaret.length,
    };
  }

  // Standard prefix + Space (` ` or `\u00A0`) triggers at block start
  if (/^#[\s\u00A0]$/.test(clean)) {
    return { blockType: "heading1", removeChars: 2 + offsetDelta };
  }
  if (/^##[\s\u00A0]$/.test(clean)) {
    return { blockType: "heading2", removeChars: 3 + offsetDelta };
  }
  if (/^###[\s\u00A0]$/.test(clean)) {
    return { blockType: "heading3", removeChars: 4 + offsetDelta };
  }
  if (/^[-*+][\s\u00A0]$/.test(clean)) {
    return { blockType: "bullet", removeChars: 2 + offsetDelta };
  }
  if (/^1\.[\s\u00A0]$/.test(clean)) {
    return { blockType: "numbered", removeChars: 3 + offsetDelta };
  }
  if (/^\[\][\s\u00A0]$/.test(clean)) {
    return {
      blockType: "todo",
      props: { checked: false },
      removeChars: 3 + offsetDelta,
    };
  }
  if (/^\[[\s\u00A0]\][\s\u00A0]$/.test(clean)) {
    return {
      blockType: "todo",
      props: { checked: false },
      removeChars: 4 + offsetDelta,
    };
  }
  if (/^\[[xX]\][\s\u00A0]$/.test(clean)) {
    return {
      blockType: "todo",
      props: { checked: true },
      removeChars: 4 + offsetDelta,
    };
  }
  if (/^>[\s\u00A0]$/.test(clean)) {
    return { blockType: "quote", removeChars: 2 + offsetDelta };
  }

  return null;
}

/**
 * Matches whole-line block shortcuts triggered upon pressing `Enter`
 * (e.g. `$$` + Enter, `$$E=mc^2$$` + Enter, `![alt](https://...)` + Enter, ```` ```lang ```` + Enter).
 */
export function matchEnterLineShortcut(
  rawLineText: string
): Omit<MarkdownShortcutMatch, "removeChars"> | null {
  const trimmed = rawLineText.replace(/\u200B/g, "").trim();
  if (!trimmed) return null;

  if (trimmed === "$$") {
    return { blockType: "math", initialContent: "" };
  }

  const mathLine = /^\$\$(.+)\$\$$/.exec(trimmed);
  if (mathLine) {
    return { blockType: "math", initialContent: mathLine[1].trim() };
  }

  const imgLine =
    /^!\[([^\]\n]*)\]\(((?:https?:\/\/|data:image\/)[^\s)\n]+)\)$/.exec(
      trimmed
    );
  if (imgLine) {
    return {
      blockType: "image",
      props: {
        caption: imgLine[1],
        url: imgLine[2],
        imageWidth: "full",
      },
    };
  }

  const codeLine = /^```([a-zA-Z0-9_+#.-]*)$/.exec(trimmed);
  if (codeLine) {
    const normalizedLang = normalizeCodeLanguage(
      codeLine[1] || "typescript"
    );
    if (normalizedLang === "mermaid") {
      return {
        blockType: "mermaid",
        props: { mermaidView: "split" },
        initialContent: "",
      };
    }
    return {
      blockType: "code",
      props: { language: normalizedLang, wordWrap: true },
    };
  }

  // Typora GFM Pipe-Table Shortcut: `| 列1 | 列2 | 列3 |` + Enter -> interactive table block!
  if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
    const inner = trimmed.slice(1, -1);
    const cells = inner.split("|").map((c) => c.trim());
    const isJustHyphens = cells.every((c) => /^:?-{2,}:?$/.test(c));
    if (cells.length >= 1 && !isJustHyphens && cells.some((c) => c.length > 0)) {
      const headers = cells.map((c, idx) => c || `列 ${idx + 1}`);
      return {
        blockType: "table",
        props: {
          headers,
          rows: [
            Array<string>(headers.length).fill(""),
            Array<string>(headers.length).fill(""),
          ],
        },
      };
    }
  }

  return null;
}

function matchTrailingBalancedMarkdownLink(text: string): {
  fullMatchLen: number;
  label: string;
  href: string;
} | null {
  if (!text.endsWith(")")) return null;

  // Walk backward from final `)` to find matching `(` that is immediately preceded by `]`
  let parenDepth = 0;
  let openParenIdx = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") return null;
    if (ch === ")") {
      parenDepth += 1;
    } else if (ch === "(") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        if (i > 0 && text[i - 1] === "]") {
          openParenIdx = i;
          break;
        }
        return null;
      }
    }
  }
  if (openParenIdx < 2) return null;

  const closeBracketIdx = openParenIdx - 1;
  let bracketDepth = 0;
  let openBracketIdx = -1;
  for (let j = closeBracketIdx; j >= 0; j--) {
    const ch = text[j];
    if (ch === "\n" || ch === "\r") return null;
    if (ch === "]") {
      bracketDepth += 1;
    } else if (ch === "[") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        openBracketIdx = j;
        break;
      }
    }
  }
  if (openBracketIdx === -1) return null;

  // Preserve `![caption](url)` for image shortcut and `[[Page]]` for wiki-links
  if (openBracketIdx > 0 && text[openBracketIdx - 1] === "!") return null;
  if (openBracketIdx > 0 && text[openBracketIdx - 1] === "[") return null;

  const label = text.slice(openBracketIdx + 1, closeBracketIdx);
  const rawHref = text.slice(openParenIdx + 1, text.length - 1).trim();
  if (!label || !rawHref) return null;

  return {
    fullMatchLen: text.length - openBracketIdx,
    label,
    href: normalizeInlineLinkHref(rawHref),
  };
}

/**
 * True WYSIWYG Inline Markdown Live Auto-Conversion:
 * Detects completed `**bold**`, `*italic*`, `~~strike~~`, `==highlight==`, `` `code` ``,
 * `$formula$`, or universal `[label](url)` (`https://`, `file:///`, `vscode://`, `./`, `#`)
 * immediately before the caret (outside existing `<code>` / `<a>` tags), replaces the raw syntax
 * with semantic HTML, and places the caret in a trailing zero-width text node!
 */
export function tryApplyInlineMarkdownAtCaret(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const caretRange = sel.getRangeAt(0);
  if (!el.contains(caretRange.startContainer)) return false;

  // Never auto-convert inside an existing `<code>`, `<a>`, or `.nb-inline-math` element
  let parentNode: Node | null = caretRange.startContainer;
  while (parentNode && parentNode !== el) {
    if (
      parentNode instanceof HTMLElement &&
      (parentNode.tagName === "CODE" ||
        parentNode.tagName === "A" ||
        parentNode.classList.contains("nb-inline-math"))
    ) {
      return false;
    }
    parentNode = parentNode.parentNode;
  }

  // Inspect plain text within the current text node up to caret so we never accidentally
  // swallow already-formatted sibling HTML nodes!
  if (caretRange.startContainer.nodeType !== Node.TEXT_NODE) {
    return false;
  }
  const textNode = caretRange.startContainer as Text;
  const textBeforeInNode = (textNode.textContent ?? "").slice(
    0,
    caretRange.startOffset
  );
  if (textBeforeInNode.length < 3) return false;

  interface InlineMatchResult {
    fullMatchLen: number;
    replacementNode: HTMLElement;
  }

  let matched: InlineMatchResult | null = null;

  // Avoid ES2018 RegExp lookbehind `(?<!...)`: unsupported in WebKit < 16.4 (macOS 12 Monterey & older)
  const execTrailingUnprefixed = (
    input: string,
    prefixChar: string,
    trailingPattern: RegExp
  ): { fullMatchLen: number; inner: string } | null => {
    const m = trailingPattern.exec(input);
    if (!m) return null;
    const matchStart = input.length - m[0].length;
    if (matchStart > 0 && input[matchStart - 1] === prefixChar) {
      return null;
    }
    return { fullMatchLen: m[0].length, inner: m[1] };
  };

  // 1. Inline code: `code` (exclude ```` ``` ```` at start of block)
  const codeMatch = execTrailingUnprefixed(
    textBeforeInNode,
    "\x60",
    /\x60([^\x60\n]+)\x60$/
  );
  if (codeMatch) {
    const codeEl = document.createElement("code");
    codeEl.textContent = codeMatch.inner;
    matched = { fullMatchLen: codeMatch.fullMatchLen, replacementNode: codeEl };
  }

  // 2. Bold: **text**
  if (!matched) {
    const boldMatch = execTrailingUnprefixed(
      textBeforeInNode,
      "*",
      /\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*$/
    );
    if (boldMatch) {
      const bEl = document.createElement("b");
      bEl.textContent = boldMatch.inner;
      matched = { fullMatchLen: boldMatch.fullMatchLen, replacementNode: bEl };
    }
  }

  // 3. Italic: *text* (unprefixed `*` ensures `**bold*` never prematurely matches!)
  if (!matched) {
    const italicMatch = execTrailingUnprefixed(
      textBeforeInNode,
      "*",
      /\*([^\s*](?:[^*\n]*[^\s*])?)\*$/
    );
    if (italicMatch) {
      const iEl = document.createElement("i");
      iEl.textContent = italicMatch.inner;
      matched = {
        fullMatchLen: italicMatch.fullMatchLen,
        replacementNode: iEl,
      };
    }
  }

  // 4. Strikethrough: ~~text~~
  if (!matched) {
    const strikeMatch = execTrailingUnprefixed(
      textBeforeInNode,
      "~",
      /~~([^\s~](?:[^~\n]*[^\s~])?)~~$/
    );
    if (strikeMatch) {
      const sEl = document.createElement("s");
      sEl.textContent = strikeMatch.inner;
      matched = {
        fullMatchLen: strikeMatch.fullMatchLen,
        replacementNode: sEl,
      };
    }
  }

  // 5. Typora Highlight: ==text== -> <mark>text</mark>
  if (!matched) {
    const highlightMatch = execTrailingUnprefixed(
      textBeforeInNode,
      "=",
      /==([^\s=](?:[^=\n]*[^\s=])?)==$/
    );
    if (highlightMatch) {
      const markEl = document.createElement("mark");
      markEl.className = "nb-inline-highlight";
      markEl.textContent = highlightMatch.inner;
      matched = {
        fullMatchLen: highlightMatch.fullMatchLen,
        replacementNode: markEl,
      };
    }
  }

  // 6. Universal Link: [label](https://... | file:///... | vscode://... | ./path | #anchor)
  if (!matched) {
    const linkMatch = matchTrailingBalancedMarkdownLink(textBeforeInNode);
    if (linkMatch && linkMatch.href) {
      const aEl = document.createElement("a");
      aEl.setAttribute("href", linkMatch.href);
      if (/^https?:\/\//i.test(linkMatch.href)) {
        aEl.setAttribute("target", "_blank");
        aEl.setAttribute("rel", "noopener noreferrer");
      } else if (/^file:\/\//i.test(linkMatch.href)) {
        aEl.setAttribute("data-local-file", "true");
        aEl.setAttribute("title", "点击在资源管理器中显示本地文件");
      }
      aEl.className = "nb-inline-link";
      const cleanLabel = linkMatch.label.replace(/^`([^`]+)`$/, "$1");
      if (cleanLabel !== linkMatch.label) {
        const innerCode = document.createElement("code");
        innerCode.textContent = cleanLabel;
        aEl.appendChild(innerCode);
      } else {
        aEl.textContent = linkMatch.label;
      }
      matched = {
        fullMatchLen: linkMatch.fullMatchLen,
        replacementNode: aEl,
      };
    }
  }

  // 7. Inline KaTeX Math: $formula$ (single `$`, preserving `$$` display math!)
  if (!matched) {
    const inlineMathMatch = execTrailingUnprefixed(
      textBeforeInNode,
      "$",
      /\$([^\s$](?:[^$\n]*[^\s$])?)\$$/
    );
    if (inlineMathMatch) {
      const latex = inlineMathMatch.inner.trim();
      const spanEl = document.createElement("span");
      spanEl.className = "nb-inline-math";
      spanEl.setAttribute("contenteditable", "false");
      spanEl.setAttribute("data-latex", latex);
      try {
        spanEl.innerHTML = katex.renderToString(latex, {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        spanEl.textContent = latex;
      }
      matched = {
        fullMatchLen: inlineMathMatch.fullMatchLen,
        replacementNode: spanEl,
      };
    }
  }

  if (!matched) return false;

  const replaceStart = caretRange.startOffset - matched.fullMatchLen;
  if (replaceStart < 0) return false;

  const targetRange = document.createRange();
  targetRange.setStart(textNode, replaceStart);
  targetRange.setEnd(textNode, caretRange.startOffset);
  targetRange.deleteContents();

  // Insert semantic inline element followed by zero-width space to break caret out of inline tag
  const breakoutText = document.createTextNode("\u200B");
  const frag = document.createDocumentFragment();
  frag.appendChild(matched.replacementNode);
  frag.appendChild(breakoutText);
  targetRange.insertNode(frag);

  const nextCaret = document.createRange();
  nextCaret.setStart(breakoutText, 1);
  nextCaret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nextCaret);

  return true;
}


export function toggleSelectionInlineTag(
  editable: HTMLElement,
  tagName: "code" | "mark",
  className: string
): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return false;

  const targetUpper = tagName.toUpperCase();
  let curr: Node | null = range.commonAncestorContainer;
  let enclosing: HTMLElement | null = null;
  while (curr && curr !== editable) {
    if (curr instanceof HTMLElement && curr.tagName === targetUpper) {
      enclosing = curr;
      break;
    }
    curr = curr.parentNode;
  }

  if (enclosing && enclosing.parentNode) {
    const parent = enclosing.parentNode;
    const first = enclosing.firstChild;
    const last = enclosing.lastChild;
    while (enclosing.firstChild) {
      parent.insertBefore(enclosing.firstChild, enclosing);
    }
    parent.removeChild(enclosing);
    if (first && last) {
      const next = document.createRange();
      next.setStartBefore(first);
      next.setEndAfter(last);
      sel.removeAllRanges();
      sel.addRange(next);
    }
    return true;
  }

  const wrapper = document.createElement(tagName);
  wrapper.className = className;
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  const next = document.createRange();
  next.selectNodeContents(wrapper);
  sel.removeAllRanges();
  sel.addRange(next);
  return true;
}
