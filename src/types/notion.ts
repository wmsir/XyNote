export type PageType = "doc" | "database";

export interface Page {
  id: string;
  parentId: string | null;
  title: string;
  icon: string;
  cover: string | null;
  pageType: PageType;
  isFavorite: boolean;
  isTrashed: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "todo"
  | "bullet"
  | "numbered"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "table"
  | "math"
  | "image"
  | "bookmark"
  | "embed"
  | "mermaid"
  | "file";

export interface BlockProps {
  checked?: boolean;
  language?: string;
  calloutIcon?: string;
  /** 磁盘笔记里图片的原始相对路径；url 为显示用的 data URL */
  localSrc?: string;
  color?: string;
  collapsed?: boolean;
  childrenText?: string;
  headers?: string[];
  rows?: string[][];
  url?: string;
  caption?: string;
  imageWidth?: "small" | "medium" | "full";
  bookmarkTitle?: string;
  bookmarkDesc?: string;
  bookmarkSite?: string;
  bookmarkIcon?: string;
  embedProvider?: string;
  mermaidView?: "preview" | "split" | "code";
  wordWrap?: boolean;
  colAlignments?: Array<"left" | "center" | "right">;
  /** 附件块：相对 assets/ 的路径、文件名、大小（字节）、类型 */
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  /** 待办的截止 / 提醒时间，本地时间 YYYY-MM-DDTHH:mm */
  dueAt?: string;
}

/** 「待办汇总」里的一条未完成待办 */
export interface TodoItem {
  blockId: string;
  pageId: string;
  pageTitle: string;
  pageIcon: string;
  text: string;
  dueAt: string | null;
}

export interface Block {
  id: string;
  pageId: string;
  blockType: BlockType;
  content: string;
  plainText: string;
  props: BlockProps;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type ColumnType =
  | "title"
  | "status"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "number"
  | "url"
  | "text";

export interface SelectOption {
  id: string;
  label: string;
  color: string;
}

export interface DbColumn {
  id: string;
  pageId: string;
  name: string;
  colType: ColumnType;
  options: SelectOption[];
  width: number;
  sortOrder: number;
}

export interface DbRow {
  id: string;
  pageId: string;
  cells: Record<string, unknown>;
  linkedPageId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseFull {
  pageId: string;
  activeView: "table" | "board" | "gallery" | "calendar" | "timeline";
  groupByColId: string | null;
  columns: DbColumn[];
  rows: DbRow[];
}

export interface BacklinkItem {
  sourcePageId: string;
  sourceTitle: string;
  sourceIcon: string;
  excerpt: string;
}

export interface BreadcrumbItem {
  id: string;
  title: string;
  icon: string;
}

export interface PageDetail {
  page: Page;
  blocks: Block[];
  breadcrumbs: BreadcrumbItem[];
  backlinks: BacklinkItem[];
  children: Page[];
}

export interface SearchResult {
  pageId: string;
  pageTitle: string;
  pageIcon: string;
  pageType: PageType;
  blockId: string | null;
  snippet: string;
  updatedAt: string;
}

export interface MarkdownExport {
  filename: string;
  markdown: string;
}

export interface MarkdownTreeEntry {
  relativePath: string;
  content: string;
}

export interface BatchImportResult {
  importedPages: number;
  importedDatabases: number;
  importedBlocks: number;
  resolvedLinks: number;
  rootPageIds: string[];
  firstPageId: string | null;
}

export interface UrlMetadata {
  url: string;
  title: string;
  description: string;
  siteName: string;
  favicon: string;
}

export interface CreatePageInput {
  parentId?: string | null;
  title?: string;
  icon?: string;
  cover?: string | null;
  pageType?: PageType;
  templateId?: string | null;
}

export interface UpdatePagePatch {
  title?: string;
  icon?: string;
  cover?: string | null;
  isFavorite?: boolean;
  parentId?: string | null;
  sortOrder?: number;
}

export interface UpsertBlockInput {
  id?: string;
  pageId: string;
  blockType: BlockType;
  content: string;
  plainText: string;
  props: BlockProps;
  sortOrder: number;
}

export interface SaveBlockItem {
  id: string;
  blockType: BlockType;
  content: string;
  plainText: string;
  props: BlockProps;
  sortOrder: number;
}

export interface UpsertDbColumnInput {
  id?: string;
  pageId: string;
  name: string;
  colType: ColumnType;
  options: SelectOption[];
  width?: number;
  sortOrder?: number;
}

export interface UpsertDbRowInput {
  id?: string;
  pageId: string;
  cells: Record<string, unknown>;
  linkedPageId?: string | null;
  sortOrder?: number;
}

export type EditorViewMode = "wysiwyg" | "source" | "split";

export type KeybindingMap = Record<string, string>;

export interface EditorPreferences {
  viewMode?: EditorViewMode;
  focusMode?: boolean;
  typewriterMode?: boolean;
  showOutline?: boolean;
  smartMarkdownPaste?: boolean;
  inlineMarkdownShortcuts?: boolean;
  codeLineNumbers?: boolean;
  codeWordWrap?: boolean;
  tabSize?: number;
  spellcheck?: boolean;
  imageSaveMode?: "assets" | "base64";
  keybindings?: KeybindingMap;
}

export interface ThemeTokens {
  bgPrimary?: string;
  bgSecondary?: string;
  bgSidebar?: string;
  bgHover?: string;
  bgElevated?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  borderColor?: string;
  accentColor?: string;
  codeInlineColor?: string;
  codeInlineBg?: string;
  codeBlockBg?: string;
  tableHeaderBg?: string;
  calloutBg?: string;
  selectionBg?: string;
  fontSans?: string;
  fontSerif?: string;
  fontMono?: string;
  radiusMd?: string;
}

export interface StylePluginItem {
  id: string;
  kind: "theme" | "snippet";
  name: string;
  author: string;
  version: string;
  description: string;
  baseMode: "light" | "dark" | "sepia";
  enabled: boolean;
  builtin: boolean;
  fileName: string;
  filePath: string;
  tokens: ThemeTokens;
  customCss: string;
  updatedAt: string;
}

export interface StylePluginState {
  pluginsDir: string;
  themesDir: string;
  snippetsDir: string;
  activeThemeId: string;
  plugins: StylePluginItem[];
  customCssGlobal: string;
}

export interface SaveStylePluginInput {
  id?: string;
  kind: "theme" | "snippet";
  name: string;
  author?: string;
  version?: string;
  description?: string;
  baseMode?: "light" | "dark" | "sepia";
  enabled?: boolean;
  tokens?: ThemeTokens;
  customCss?: string;
}

export interface DocumentStats {
  words: number;
  chars: number;
  lines: number;
  readingMinutes: number;
  blockCount: number;
}

export interface StorageConfigInfo {
  exeDir: string;
  defaultDataDir: string;
  activeDataDir: string;
  dbFilePath: string;
  markdownSyncDir: string;
  assetsDir: string;
  backupsDir: string;
  isDefaultPortableDir: boolean;
  exeDirWritable: boolean;
  autoSyncMarkdown: boolean;
  imageSaveMode: "assets" | "base64";
  autoBackupOnLaunch: boolean;
  maxBackups: number;
  dbSizeBytes: number;
  pageCount: number;
  blockCount: number;
}

export interface UpdateStorageConfigInput {
  activeDataDir?: string;
  markdownSyncDir?: string;
  migrateExistingData?: boolean;
  autoSyncMarkdown?: boolean;
  imageSaveMode?: "assets" | "base64";
  autoBackupOnLaunch?: boolean;
  maxBackups?: number;
}

export interface BackupEntry {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface LocalMarkdownDocument {
  filePath: string;
  fileName: string;
  title: string;
  markdown: string;
  blocks: Block[];
  updatedAt: string;
}

export interface SavedAssetResult {
  filePath: string;
  assetUrl: string;
}

export interface ImportedCustomFont {
  storedPath: string;
  resolvedPath: string;
  displayName: string;
  byteSize: number;
}

/* ============================================================================
 * 侧栏「文件夹」：磁盘文件夹树
 * ========================================================================== */

export interface FolderEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 小写扩展名，不含点；文件夹为空字符串 */
  ext: string;
  size: number;
  modifiedMs: number;
  /** dir | note（Markdown，块编辑器）| text（文本编辑器）| other（系统程序打开） */
  kind: "dir" | "note" | "text" | "other";
}

export interface FolderListing {
  path: string;
  entries: FolderEntry[];
  /** 条目太多被截断 */
  truncated: boolean;
}

/** 侧栏里挂载的一个根文件夹 */
export interface WorkspaceFolder {
  path: string;
  name: string;
}

/** 文件夹全文搜索结果 */
export interface FolderSearchHit {
  path: string;
  name: string;
  rootName: string;
  /** 匹配行号；只匹配到文件名时为 0 */
  line: number;
  snippet: string;
}

/* ============================================================================
 * 可插拔 SAG2 本地知识库引擎（独立 kb_index.db，默认关闭）
 * ========================================================================== */

export interface KbStatus {
  enabled: boolean;
  includeFolders: boolean;
  showRelatedPanel: boolean;
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes: number;
  sourceCount: number;
  eventCount: number;
  entityCount: number;
  indexing: boolean;
  lastIndexedAt: string | null;
  lastError: string | null;
}

export interface KbSearchHit {
  eventId: string;
  sourceId: string;
  sourceKind: "workspace_page" | "mounted_file" | string;
  refId: string;
  title: string;
  icon: string;
  rootName: string;
  blockId: string | null;
  lineStart: number | null;
  headingPath: string;
  snippet: string;
  matchKind: "direct" | "hyperedge" | string;
  sharedEntities: string[];
  score: number;
  eventTime: string;
}

export interface KbEntitySummary {
  name: string;
  entityType: string;
  docFreq: number;
}

export interface KbSearchResponse {
  query: string;
  totalSources: number;
  totalEvents: number;
  elapsedMs: number;
  hits: KbSearchHit[];
  topEntities: KbEntitySummary[];
}

export interface KbRelatedResponse {
  contextEntities: KbEntitySummary[];
  hits: KbSearchHit[];
  elapsedMs: number;
}
