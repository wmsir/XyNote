import type { BatchImportResult, MarkdownTreeEntry } from "../../types/notion";

const NON_IMPORT_SINGLE_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|ogg|mov|mp3|wav|pdf|exe|dll|msi|dmg|7z|rar)$/i;

export function isStylePluginFilePath(path: string): boolean {
  const trimmed = path.trim();
  return /\.(css|(xynote|notion)-theme\.json)$/i.test(trimmed);
}

export function filterImportableOsPaths(paths: string[]): string[] {
  return paths.filter((p) => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    if (/\.(md|markdown|txt|csv|zip|css|(xynote|notion)-theme\.json)$/i.test(trimmed)) {
      return true;
    }
    if (NON_IMPORT_SINGLE_EXT_RE.test(trimmed)) return false;
    // Allow directories (including folders whose names may contain dots like `v1.0-notes`)
    return true;
  });
}

export function formatBatchImportSummary(res: BatchImportResult): string {
  return `已成功导入 ${res.importedPages} 个页面、${res.importedDatabases} 个数据库、解析 ${res.resolvedLinks} 处双链`;
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取文本文件失败"));
    reader.readAsText(file, "utf-8");
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const commaIdx = dataUrl.indexOf(",");
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
}

function normalizeRelPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  const stack: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

function inlineFolderImagesIntoMarkdown(
  entries: MarkdownTreeEntry[],
  imageMap: Map<string, string>
): MarkdownTreeEntry[] {
  if (imageMap.size === 0) return entries;

  return entries.map((entry) => {
    if (!/\.(md|markdown)$/i.test(entry.relativePath)) {
      return entry;
    }
    const normEntry = normalizeRelPath(entry.relativePath);
    const slashIdx = normEntry.lastIndexOf("/");
    const baseDir = slashIdx >= 0 ? normEntry.slice(0, slashIdx) : "";

    const updatedContent = entry.content.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (full, cap: string, rawUrl: string) => {
        const trimmedUrl = rawUrl.trim();
        if (/^(https?:|data:|blob:)/i.test(trimmedUrl)) return full;
        let decoded = trimmedUrl;
        try {
          decoded = decodeURIComponent(trimmedUrl);
        } catch {
          // Ignore malformed URI component
        }
        decoded = decoded.split("#")[0].split("?")[0];
        const resolved = normalizeRelPath(
          baseDir ? `${baseDir}/${decoded}` : decoded
        ).toLowerCase();
        const dataUri = imageMap.get(resolved);
        return dataUri ? `![${cap}](${dataUri})` : full;
      }
    );

    return {
      relativePath: normEntry,
      content: updatedContent,
    };
  });
}

export interface CollectedDropFiles {
  zipFiles: File[];
  treeEntries: MarkdownTreeEntry[];
  stylePluginFiles: Array<{ filename: string; content: string }>;
}

async function processNamedFiles(
  namedFiles: Array<{ relativePath: string; file: File }>
): Promise<CollectedDropFiles> {
  const zipFiles: File[] = [];
  const rawTreeEntries: MarkdownTreeEntry[] = [];
  const stylePluginFiles: Array<{ filename: string; content: string }> = [];
  const imageMap = new Map<string, string>();

  for (const { relativePath, file } of namedFiles) {
    const norm = normalizeRelPath(relativePath || file.name);
    if (!norm || norm.includes("__MACOSX")) continue;
    const lower = norm.toLowerCase();

    if (lower.endsWith(".zip")) {
      zipFiles.push(file);
      continue;
    }

    if (lower.endsWith(".css") || lower.endsWith(".xynote-theme.json") || lower.endsWith(".notion-theme.json")) {
      const content = await readFileAsText(file);
      stylePluginFiles.push({
        filename: file.name || norm.split("/").pop() || "plugin.css",
        content,
      });
      continue;
    }

    if (/\.(md|markdown|txt|csv)$/i.test(lower)) {
      const content = await readFileAsText(file);
      rawTreeEntries.push({ relativePath: norm, content });
      continue;
    }

    if (
      /\.(png|jpe?g|gif|webp|svg)$/i.test(lower) &&
      file.size <= 2 * 1024 * 1024
    ) {
      const dataUrl = await readFileAsDataUrl(file);
      if (dataUrl) {
        imageMap.set(lower, dataUrl);
      }
    }
  }

  return {
    zipFiles,
    treeEntries: inlineFolderImagesIntoMarkdown(rawTreeEntries, imageMap),
    stylePluginFiles,
  };
}

export async function collectFilesFromFileList(
  files: FileList | File[]
): Promise<CollectedDropFiles> {
  const list = Array.from(files);
  const named = list.map((file) => {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    return { relativePath: rel, file };
  });
  return processNamedFiles(named);
}

// Minimal WebKit FileSystem Entry interfaces for directory drag-and-drop
interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}

interface WebkitFileEntry extends WebkitEntry {
  isFile: true;
  file: (
    success: (f: File) => void,
    error?: (err: DOMException) => void
  ) => void;
}

interface WebkitDirReader {
  readEntries: (
    success: (entries: WebkitEntry[]) => void,
    error?: (err: DOMException) => void
  ) => void;
}

interface WebkitDirectoryEntry extends WebkitEntry {
  isDirectory: true;
  createReader: () => WebkitDirReader;
}

function readEntryFile(entry: WebkitFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, (err) => reject(err));
  });
}

async function readAllDirectoryEntries(
  dirEntry: WebkitDirectoryEntry
): Promise<WebkitEntry[]> {
  const reader = dirEntry.createReader();
  const all: WebkitEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, (err) => reject(err));
    });
    if (!batch || batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function walkWebkitEntry(
  entry: WebkitEntry,
  prefix: string,
  acc: Array<{ relativePath: string; file: File }>
): Promise<void> {
  const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readEntryFile(entry as WebkitFileEntry);
    acc.push({ relativePath: currentPath, file });
  } else if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(
      entry as WebkitDirectoryEntry
    );
    for (const child of children) {
      await walkWebkitEntry(child, currentPath, acc);
    }
  }
}

export async function collectFilesFromDataTransfer(
  dt: DataTransfer
): Promise<CollectedDropFiles> {
  const named: Array<{ relativePath: string; file: File }> = [];
  const items = dt.items ? Array.from(dt.items) : [];

  const entries: WebkitEntry[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const getter = (
      item as DataTransferItem & { webkitGetAsEntry?: () => WebkitEntry | null }
    ).webkitGetAsEntry;
    const entry = typeof getter === "function" ? getter.call(item) : null;
    if (entry) {
      entries.push(entry);
    }
  }

  if (entries.length > 0) {
    for (const entry of entries) {
      await walkWebkitEntry(entry, "", named);
    }
    return processNamedFiles(named);
  }

  return collectFilesFromFileList(dt.files);
}
