import type React from "react";
import type { KeybindingMap } from "../../types/notion";

export type KeybindingCategory =
  | "turnInto"
  | "blockAction"
  | "inlineFormat"
  | "workspace"
  | "textEditor";

export interface KeybindingDefinition {
  id: string;
  category: KeybindingCategory;
  categoryLabel: string;
  label: string;
  description: string;
  defaultShortcut: string;
}

export const KEYBINDING_CATEGORY_TABS: Array<{
  id: "all" | KeybindingCategory;
  label: string;
}> = [
  { id: "all", label: "全部" },
  { id: "turnInto", label: "块转换 Turn-into" },
  { id: "blockAction", label: "块操作与颜色" },
  { id: "inlineFormat", label: "行内格式" },
  { id: "workspace", label: "全局与视图" },
  { id: "textEditor", label: "文本 / 代码编辑器" },
];

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  // ── 1. Turn Into (18 block types) ─────────────────────────────────────────
  {
    id: "block.turnInto.paragraph",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为正文段落",
    description: "将当前聚焦块无损转换为普通富文本段落 (Paragraph)",
    defaultShortcut: "Ctrl+0",
  },
  {
    id: "block.turnInto.heading1",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为一级标题 (H1)",
    description: "将当前聚焦块转换为一级章节大标题",
    defaultShortcut: "Ctrl+1",
  },
  {
    id: "block.turnInto.heading2",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为二级标题 (H2)",
    description: "将当前聚焦块转换为二级小节标题",
    defaultShortcut: "Ctrl+2",
  },
  {
    id: "block.turnInto.heading3",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为三级标题 (H3)",
    description: "将当前聚焦块转换为三级子标题",
    defaultShortcut: "Ctrl+3",
  },
  {
    id: "block.turnInto.todo",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为待办事项 (To-do)",
    description: "将当前聚焦块转换为带复选框的任务列表项",
    defaultShortcut: "Ctrl+Alt+4",
  },
  {
    id: "block.turnInto.bullet",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为无序列表 (Bullet)",
    description: "将当前聚焦块转换为项目符号列表项",
    defaultShortcut: "Ctrl+Shift+]",
  },
  {
    id: "block.turnInto.numbered",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为有序列表 (Numbered)",
    description: "将当前聚焦块转换为自动递增数字列表项",
    defaultShortcut: "Ctrl+Shift+[",
  },
  {
    id: "block.turnInto.toggle",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为折叠列表 (Toggle)",
    description: "将当前聚焦块转换为可展开/收起的折叠容器块",
    defaultShortcut: "Ctrl+Alt+7",
  },
  {
    id: "block.turnInto.code",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为代码块 (Code)",
    description: "将当前聚焦块转换为带行号与多语言选择的代码块",
    defaultShortcut: "Ctrl+Shift+K",
  },
  {
    id: "block.turnInto.quote",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为引用块 (Quote)",
    description: "将当前聚焦块转换为竖线引言样式",
    defaultShortcut: "Ctrl+Shift+Q",
  },
  {
    id: "block.turnInto.callout",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为高亮提示块 (Callout)",
    description: "将当前聚焦块转换为带 Emoji 图标的醒目提示框",
    defaultShortcut: "Ctrl+Alt+C",
  },
  {
    id: "block.turnInto.mermaid",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为 Mermaid 图表",
    description: "将当前聚焦块转换为实时渲染流程图 / 时序图 / 架构图画布",
    defaultShortcut: "Ctrl+Alt+M",
  },
  {
    id: "block.turnInto.math",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为数学公式 (KaTeX)",
    description: "将当前聚焦块转换为块级 LaTeX 数学公式编辑器",
    defaultShortcut: "Ctrl+Shift+M",
  },
  {
    id: "block.turnInto.table",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为数据表格 (Table)",
    description: "将当前聚焦块转换为支持多行富文本与对齐的 GFM 表格",
    defaultShortcut: "Ctrl+T",
  },
  {
    id: "block.turnInto.divider",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为分割线 (Divider)",
    description: "将当前块转换为水平章节分隔线",
    defaultShortcut: "Ctrl+Alt+D",
  },
  {
    id: "block.turnInto.image",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为图片块 (Image)",
    description: "将当前聚焦块转换为支持缩放与图注的图片块",
    defaultShortcut: "",
  },
  {
    id: "block.turnInto.bookmark",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为网页书签 (Bookmark)",
    description: "将当前聚焦块转换为自动抓取标题摘要的网页卡片",
    defaultShortcut: "",
  },
  {
    id: "block.turnInto.embed",
    category: "turnInto",
    categoryLabel: "块转换 Turn-into",
    label: "转换为视频 / 网页内嵌 (Embed)",
    description: "将当前聚焦块转换为多媒体或网页内嵌容器",
    defaultShortcut: "",
  },

  // ── 2. Block Actions & Colors ─────────────────────────────────────────────
  {
    id: "block.openMenu",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "打开当前块操作与转换菜单",
    description: "在当前光标所在块旁直接弹出「转换为 / 颜色 / 复制 / 删除」菜单",
    defaultShortcut: "Ctrl+.",
  },
  {
    id: "block.duplicate",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "复制当前块到下方 (Duplicate)",
    description: "克隆当前聚焦块及其属性并自动聚焦到新块",
    defaultShortcut: "Ctrl+D",
  },
  {
    id: "block.moveUp",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "将当前块上移一行",
    description: "与上方相邻内容块交换顺序并保持编辑焦点",
    defaultShortcut: "Alt+ArrowUp",
  },
  {
    id: "block.moveDown",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "将当前块下移一行",
    description: "与下方相邻内容块交换顺序并保持编辑焦点",
    defaultShortcut: "Alt+ArrowDown",
  },
  {
    id: "block.delete",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "删除当前聚焦块",
    description: "立即移除当前聚焦的内容块并将光标移至相邻块",
    defaultShortcut: "Ctrl+Shift+Backspace",
  },
  {
    id: "block.insertBelow",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "在下方插入新正文块",
    description: "跳出代码块、公式或当前段落并在正下方创建新段落",
    defaultShortcut: "Ctrl+Enter",
  },
  {
    id: "block.color.default",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：恢复默认无底色",
    description: "清除当前聚焦块的彩色背景高亮",
    defaultShortcut: "",
  },
  {
    id: "block.color.gray",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：柔和灰 (Gray)",
    description: "为当前聚焦块应用 Notion 经典浅灰背景色",
    defaultShortcut: "",
  },
  {
    id: "block.color.brown",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：暖棕褐 (Brown)",
    description: "为当前聚焦块应用温润大地棕背景色",
    defaultShortcut: "",
  },
  {
    id: "block.color.yellow",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：琥珀黄 (Yellow)",
    description: "为当前聚焦块应用醒目暖黄重点底色",
    defaultShortcut: "",
  },
  {
    id: "block.color.green",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：森系绿 (Green)",
    description: "为当前聚焦块应用清新通过态绿色底色",
    defaultShortcut: "",
  },
  {
    id: "block.color.blue",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：晴空蓝 (Blue)",
    description: "为当前聚焦块应用信息提示浅蓝底色",
    defaultShortcut: "",
  },
  {
    id: "block.color.purple",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：丁香紫 (Purple)",
    description: "为当前聚焦块应用优雅紫罗兰底色",
    defaultShortcut: "",
  },
  {
    id: "block.color.red",
    category: "blockAction",
    categoryLabel: "块操作与颜色",
    label: "块背景色：珊瑚红 (Red)",
    description: "为当前聚焦块应用警示珊瑚红底色",
    defaultShortcut: "",
  },

  // ── 3. Inline Formatting ──────────────────────────────────────────────────
  {
    id: "format.bold",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "文本加粗 (Bold)",
    description: "对选中文本切换粗体格式（源码模式下自动包裹 **文字**）",
    defaultShortcut: "Ctrl+B",
  },
  {
    id: "format.italic",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "文本斜体 (Italic)",
    description: "对选中文本切换斜体格式（源码模式下自动包裹 *文字*）",
    defaultShortcut: "Ctrl+I",
  },
  {
    id: "format.underline",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "文本下划线 (Underline)",
    description: "对选中文本添加或移除下划线装饰",
    defaultShortcut: "Ctrl+U",
  },
  {
    id: "format.strike",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "文本删除线 (Strikethrough)",
    description: "对选中文本切换删除线（与另存为 Ctrl+Shift+S 零冲突）",
    defaultShortcut: "Alt+Shift+5",
  },
  {
    id: "format.code",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "行内代码胶囊 (Inline Code)",
    description: "将选中文本包裹为等宽行内代码（源码包裹 `code`）",
    defaultShortcut: "Ctrl+Shift+`",
  },
  {
    id: "format.highlight",
    category: "inlineFormat",
    categoryLabel: "行内格式",
    label: "荧光笔高亮标记 (Highlight)",
    description: "将选中文本标记为黄色荧光高亮（对应 ==文字== 语法）",
    defaultShortcut: "Ctrl+Shift+H",
  },

  // ── 4. Workspace & Views ──────────────────────────────────────────────────
  {
    id: "app.search",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "全局搜索与快捷命令面板",
    description: "打开全文搜索与页面快捷跳转面板",
    defaultShortcut: "Ctrl+K",
  },
  {
    id: "app.settings",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "打开偏好设置中心",
    description: "管理便携路径、主题与样式插件、快捷键录制及快照备份",
    defaultShortcut: "Ctrl+,",
  },
  {
    id: "app.newPage",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "快速新建空白页面",
    description: "在本地知识库立即创建一篇新的空白文档",
    defaultShortcut: "Ctrl+N",
  },
  {
    id: "app.newWindow",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "新建窗口",
    description: "再打开一个小悦笔记窗口，可以同时看、写不同的页面",
    defaultShortcut: "Ctrl+Shift+N",
  },
  {
    id: "app.openMd",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "打开本地 .md 文件直编",
    description: "直接打开并编辑磁盘上的独立 Markdown 文件",
    defaultShortcut: "Ctrl+O",
  },
  {
    id: "app.saveMd",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "立即保存文档 / 本地 .md",
    description: "立即保存当前笔记或本地 .md 文件",
    defaultShortcut: "Ctrl+S",
  },
  {
    id: "app.saveAsMd",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "另存为本地 Markdown 文件",
    description: "将当前页面无损导出并另存至指定系统路径",
    defaultShortcut: "Ctrl+Shift+S",
  },
  {
    id: "app.toggleSidebar",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "折叠 / 展开左侧导航栏",
    description: "一键收起或展开工作区页面目录树",
    defaultShortcut: "Ctrl+Shift+L",
  },
  {
    id: "app.renamePage",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "重命名页面或文件",
    description: "重命名侧栏里选中的页面，没有选中时重命名当前打开的页面或文件（正在输入文字时不生效）",
    defaultShortcut: "F2",
  },
  {
    id: "editor.toggleSource",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "切换「所见即所得 / 源码模式」",
    description: "在富文本块画布与纯 Markdown 源码视图间即时切换",
    defaultShortcut: "Ctrl+/",
  },
  {
    id: "editor.toggleSplit",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "切换「左右分屏实时预览」",
    description: "左侧编写 Markdown 源码，右侧同步渲染 Mermaid 图表与公式",
    defaultShortcut: "Ctrl+Shift+/",
  },
  {
    id: "editor.toggleOutline",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "显示 / 隐藏右侧文档大纲 (TOC)",
    description: "自动提取 H1 / H2 / H3 标题结构，支持一键点击定位",
    defaultShortcut: "Ctrl+Shift+1",
  },
  {
    id: "editor.focusMode",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "切换专注模式 (Focus Mode)",
    description: "高亮当前正在编辑的块，柔和淡化上下文其余段落",
    defaultShortcut: "F8",
  },
  {
    id: "editor.typewriterMode",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "切换打字机居中滚动 (Typewriter)",
    description: "输入时自动将光标所在行平稳保持在屏幕垂直中央",
    defaultShortcut: "F9",
  },
  {
    id: "editor.zenMode",
    category: "workspace",
    categoryLabel: "全局与视图",
    label: "切换沉浸禅模式 (Zen Mode)",
    description: "收起边栏并进入纯净无干扰全屏写作环境",
    defaultShortcut: "F11",
  },
];

/* ───────────── 文本 / 代码编辑器（TextEditor）───────────── */

export type TextKeymapPreset = "idea" | "vscode";
/** 记录当前用的是哪套预设（不是动作，合并时作为普通键保留） */
export const TEXT_PRESET_KEY = "text.preset";

interface TextActionSpec {
  id: string;
  label: string;
  description: string;
  idea: string;
  vscode: string;
}

const TEXT_ACTIONS: TextActionSpec[] = [
  { id: "text.save", label: "保存", description: "立即把文件写入磁盘", idea: "Ctrl+S", vscode: "Ctrl+S" },
  { id: "text.find", label: "查找", description: "打开查找栏，选中的文字会自动填入", idea: "Ctrl+F", vscode: "Ctrl+F" },
  { id: "text.replace", label: "替换", description: "打开查找替换栏", idea: "Ctrl+R", vscode: "Ctrl+H" },
  { id: "text.findNext", label: "查找下一个", description: "跳到下一个匹配", idea: "F3", vscode: "F3" },
  { id: "text.findPrev", label: "查找上一个", description: "跳到上一个匹配", idea: "Shift+F3", vscode: "Shift+F3" },
  { id: "text.gotoLine", label: "跳到行", description: "输入行号跳转", idea: "Ctrl+G", vscode: "Ctrl+G" },
  { id: "text.duplicateLine", label: "复制行", description: "把当前行或选中的行复制一份到下方", idea: "Ctrl+D", vscode: "Alt+Shift+ArrowDown" },
  { id: "text.deleteLine", label: "删除行", description: "删除当前行或选中的行", idea: "Ctrl+Y", vscode: "Ctrl+Shift+K" },
  { id: "text.moveLineUp", label: "上移行", description: "把当前行或选中的行向上移动一行", idea: "Alt+Shift+ArrowUp", vscode: "Alt+ArrowUp" },
  { id: "text.moveLineDown", label: "下移行", description: "把当前行或选中的行向下移动一行", idea: "Alt+Shift+ArrowDown", vscode: "Alt+ArrowDown" },
  { id: "text.toggleComment", label: "行注释", description: "按当前语言添加或取消行注释", idea: "Ctrl+/", vscode: "Ctrl+/" },
  { id: "text.blockComment", label: "块注释", description: "用块注释包住选中内容，再按一次取消", idea: "Ctrl+Shift+/", vscode: "Alt+Shift+A" },
  { id: "text.expandSelection", label: "扩大选区", description: "依次选中单词、整行、全文", idea: "Ctrl+W", vscode: "Alt+Shift+ArrowRight" },
  { id: "text.selectNextOccurrence", label: "选中下一个相同内容", description: "选中光标处的单词，再按跳到下一个相同内容", idea: "Alt+J", vscode: "Ctrl+D" },
  { id: "text.insertLineBelow", label: "在下方插入新行", description: "不打断当前行，直接在下面开始新的一行", idea: "Shift+Enter", vscode: "Ctrl+Enter" },
  { id: "text.insertLineAbove", label: "在上方插入新行", description: "在当前行上面开始新的一行", idea: "Ctrl+Alt+Enter", vscode: "Ctrl+Shift+Enter" },
  { id: "text.joinLines", label: "合并行", description: "把下一行接到当前行末尾", idea: "Ctrl+Shift+J", vscode: "" },
  { id: "text.toggleCase", label: "切换大小写", description: "把选中的文字在大写和小写之间切换", idea: "Ctrl+Shift+U", vscode: "" },
  { id: "text.format", label: "格式化", description: "JSON 重新缩进排版；其他文件去掉行尾空格", idea: "Ctrl+Alt+L", vscode: "Alt+Shift+F" },
  { id: "text.toggleWrap", label: "切换自动换行", description: "长行在窗口内折行显示", idea: "", vscode: "Alt+Z" },
  { id: "text.zoomIn", label: "放大字号", description: "也可以按住 Ctrl 滚动鼠标滚轮", idea: "Ctrl+=", vscode: "Ctrl+=" },
  { id: "text.zoomOut", label: "缩小字号", description: "也可以按住 Ctrl 滚动鼠标滚轮", idea: "Ctrl+-", vscode: "Ctrl+-" },
  { id: "text.zoomReset", label: "恢复默认字号", description: "字号恢复为 14", idea: "Ctrl+0", vscode: "Ctrl+0" },
];

export const TEXT_KEYMAP_PRESETS: Record<TextKeymapPreset, { label: string; map: KeybindingMap }> = {
  idea: {
    label: "IntelliJ IDEA",
    map: Object.fromEntries(TEXT_ACTIONS.map((a) => [a.id, a.idea])),
  },
  vscode: {
    label: "VS Code",
    map: Object.fromEntries(TEXT_ACTIONS.map((a) => [a.id, a.vscode])),
  },
};

KEYBINDING_DEFINITIONS.push(
  ...TEXT_ACTIONS.map<KeybindingDefinition>((a) => ({
    id: a.id,
    category: "textEditor",
    categoryLabel: "文本 / 代码编辑器",
    label: a.label,
    description: a.description,
    defaultShortcut: a.idea,
  }))
);

export function textPresetOf(map: KeybindingMap | null | undefined): TextKeymapPreset {
  return map?.[TEXT_PRESET_KEY] === "vscode" ? "vscode" : "idea";
}

/** 某个动作在当前预设下的默认快捷键（文本编辑器跟随所选预设） */
export function defaultShortcutFor(def: KeybindingDefinition, map: KeybindingMap | null | undefined): string {
  if (def.category !== "textEditor") return def.defaultShortcut;
  return TEXT_KEYMAP_PRESETS[textPresetOf(map)].map[def.id] ?? def.defaultShortcut;
}

/** 切换文本编辑器预设：所有 text.* 快捷键换成预设值 */
export function applyTextPreset(map: KeybindingMap, preset: TextKeymapPreset): KeybindingMap {
  return { ...map, ...TEXT_KEYMAP_PRESETS[preset].map, [TEXT_PRESET_KEY]: preset };
}

/** 文本编辑器录制与匹配用：在通用规则之外，允许 Shift+Enter 这类只带 Shift 的组合 */
export function normalizeTextEditorShortcut(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const base = normalizeKeyboardEventToShortcut(e);
  if (base) return base;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Enter") return "Shift+Enter";
  return null;
}

/** 文本编辑器：快捷键（小写）→ 动作 id */
export function buildTextShortcutLookup(map: KeybindingMap | null | undefined): Map<string, string> {
  const merged = mergeKeybindings(map);
  const out = new Map<string, string>();
  for (const a of TEXT_ACTIONS) {
    const combo = (merged[a.id] ?? "").trim().toLowerCase();
    if (combo && !out.has(combo)) out.set(combo, a.id);
  }
  return out;
}

export const DEFAULT_KEYBINDINGS: KeybindingMap = KEYBINDING_DEFINITIONS.reduce<KeybindingMap>(
  (acc, def) => {
    acc[def.id] = def.defaultShortcut;
    return acc;
  },
  {}
);

export function mergeKeybindings(
  overrides?: KeybindingMap | null
): KeybindingMap {
  const merged: KeybindingMap = { ...DEFAULT_KEYBINDINGS };
  if (overrides && typeof overrides === "object") {
    for (const [key, val] of Object.entries(overrides)) {
      if (typeof val === "string") {
        merged[key] = val.trim();
      }
    }
  }
  return merged;
}

export function extractKeybindingOverrides(
  merged: KeybindingMap
): KeybindingMap {
  const overrides: KeybindingMap = {};
  for (const def of KEYBINDING_DEFINITIONS) {
    const current = (merged[def.id] ?? def.defaultShortcut).trim();
    if (current !== def.defaultShortcut) {
      overrides[def.id] = current;
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (!(k in DEFAULT_KEYBINDINGS) && typeof v === "string") {
      overrides[k] = v.trim();
    }
  }
  return overrides;
}

/**
 * Canonical keyboard event normalizer shared 100% identically between App.tsx
 * and BlockEditor (`Ctrl+Alt+Shift+<Key>`).
 */
export function normalizeKeyboardEventToShortcut(
  e: KeyboardEvent | React.KeyboardEvent
): string | null {
  if (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta"
  ) {
    return null;
  }

  const code = e.code || "";
  let keyToken = "";

  const digitMatch = code.match(/^Digit([0-9])$/);
  const alphaMatch = code.match(/^Key([A-Z])$/);

  if (digitMatch) {
    keyToken = digitMatch[1];
  } else if (alphaMatch) {
    keyToken = alphaMatch[1];
  } else if (code === "Slash") {
    keyToken = "/";
  } else if (code === "Backslash") {
    keyToken = "\\";
  } else if (code === "Comma") {
    keyToken = ",";
  } else if (code === "Period") {
    keyToken = ".";
  } else if (code === "Minus") {
    keyToken = "-";
  } else if (code === "Equal") {
    keyToken = "=";
  } else if (code === "BracketLeft") {
    keyToken = "[";
  } else if (code === "BracketRight") {
    keyToken = "]";
  } else if (code === "Semicolon") {
    keyToken = ";";
  } else if (code === "Quote") {
    keyToken = "'";
  } else if (code === "Backquote") {
    keyToken = "`";
  } else if (code === "Space" || e.key === " ") {
    keyToken = "Space";
  } else if (/^F([1-9]|1[0-2])$/i.test(e.key)) {
    keyToken = e.key.toUpperCase();
  } else if (
    e.key === "Enter" ||
    e.key === "Backspace" ||
    e.key === "Delete" ||
    e.key === "Tab" ||
    e.key === "Escape" ||
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    e.key === "Home" ||
    e.key === "End" ||
    e.key === "PageUp" ||
    e.key === "PageDown"
  ) {
    keyToken = e.key;
  } else if (e.key && e.key.length === 1) {
    keyToken = e.key.toUpperCase();
  }

  if (!keyToken) {
    return null;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  const alt = e.altKey;
  const shift = e.shiftKey;

  // Disallow plain single-character typing keys without Ctrl/Alt (unless F1-F12)
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(keyToken);
  if (!ctrl && !alt && !isFunctionKey) {
    return null;
  }

  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  parts.push(keyToken);
  return parts.join("+");
}

export function formatShortcutBadge(combo: string | undefined | null): string {
  if (!combo || !combo.trim()) return "未绑定";
  return combo
    .trim()
    .replace(/ArrowUp/g, "↑")
    .replace(/ArrowDown/g, "↓")
    .replace(/ArrowLeft/g, "←")
    .replace(/ArrowRight/g, "→")
    .split("+")
    .join(" + ");
}

export function findConflictingActions(
  merged: KeybindingMap,
  targetActionId: string,
  candidateCombo: string
): KeybindingDefinition[] {
  const normalized = candidateCombo.trim().toLowerCase();
  if (!normalized) return [];
  // 文本编辑器的快捷键只在编辑文本文件时生效，只和同一组比较
  const targetIsText = targetActionId.startsWith("text.");
  return KEYBINDING_DEFINITIONS.filter((def) => {
    if (def.id === targetActionId) return false;
    if ((def.category === "textEditor") !== targetIsText) return false;
    const bound = (merged[def.id] ?? "").trim().toLowerCase();
    return bound === normalized;
  });
}
