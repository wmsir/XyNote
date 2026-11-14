import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Download,
  FileText,
  FileUp,
  FolderOpen,
  Upload,
  X,
} from "lucide-react";
import {
  importMarkdownTree,
  importNotionZipBytes,
} from "../../api/client";
import type {
  BatchImportResult,
  MarkdownExport,
  MarkdownTreeEntry,
  Page,
} from "../../types/notion";
import {
  collectFilesFromDataTransfer,
  collectFilesFromFileList,
  readFileAsBase64,
  readFileAsText,
} from "./fileDropUtils";

export type ImportModalTab = "paste" | "files" | "zip" | "export";

export interface MarkdownModalProps {
  mode: "import" | "notion-zip" | "export" | null;
  exportData: MarkdownExport | null;
  pages: Page[];
  defaultParentId: string | null;
  onClose: () => void;
  onImportSubmit: (
    title: string,
    markdown: string,
    parentId: string | null
  ) => Promise<void>;
  onBatchImported?: (result: BatchImportResult) => Promise<void> | void;
  onRequestExportCurrent?: () => Promise<void> | void;
}

export const MarkdownModal: React.FC<MarkdownModalProps> = ({
  mode,
  exportData,
  pages,
  defaultParentId,
  onClose,
  onImportSubmit,
  onBatchImported,
  onRequestExportCurrent,
}) => {
  const [activeTab, setActiveTab] = useState<ImportModalTab>("files");
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [parentId, setParentId] = useState<string>(defaultParentId ?? "");
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Tab B: Batch .md / folder state
  const [pendingEntries, setPendingEntries] = useState<MarkdownTreeEntry[]>([]);
  const [filesDragOver, setFilesDragOver] = useState(false);

  // Tab C: Notion .zip state
  const [selectedZipFile, setSelectedZipFile] = useState<File | null>(null);
  const [zipDragOver, setZipDragOver] = useState(false);

  // Shared migration result banner inside modal
  const [lastBatchResult, setLastBatchResult] =
    useState<BatchImportResult | null>(null);

  const singleFileInputRef = useRef<HTMLInputElement | null>(null);
  const multiFilesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const prevModeRef = useRef<"import" | "notion-zip" | "export" | null>(null);

  useEffect(() => {
    if (!mode) {
      prevModeRef.current = null;
      return;
    }
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      setErrorText(null);
      setLastBatchResult(null);
      if (mode === "export") {
        setActiveTab("export");
      } else if (mode === "notion-zip") {
        setParentId(defaultParentId ?? "");
        setActiveTab("zip");
      } else {
        setParentId(defaultParentId ?? "");
        setActiveTab("files");
      }
    }
  }, [mode, defaultParentId]);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, [mode, activeTab]);

  if (!mode) return null;

  const handleSingleFileSelect = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const baseName = file.name.replace(/\.(md|markdown|txt)$/i, "");
    if (!title) setTitle(baseName);
    const content = await readFileAsText(file);
    setMarkdown(content);
    e.target.value = "";
  };

  const handleMultiFilesPicked = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setErrorText(null);
    setLastBatchResult(null);
    const { treeEntries } = await collectFilesFromFileList(files);
    if (treeEntries.length === 0) {
      setErrorText("未在所选内容中找到可导入的 .md / .markdown / .txt / .csv 文件");
    } else {
      setPendingEntries(treeEntries);
    }
    e.target.value = "";
  };

  const handleFilesDropZoneDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFilesDragOver(false);
    setErrorText(null);
    setLastBatchResult(null);

    const { zipFiles, treeEntries } = await collectFilesFromDataTransfer(
      e.dataTransfer
    );
    if (treeEntries.length > 0) {
      setPendingEntries(treeEntries);
    } else if (zipFiles.length > 0) {
      setSelectedZipFile(zipFiles[0]);
      setActiveTab("zip");
    } else {
      setErrorText("请拖入 .md、.csv 文件或包含 Markdown 的文件夹");
    }
  };

  const handleZipDropZoneDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZipDragOver(false);
    setErrorText(null);
    setLastBatchResult(null);

    const files = Array.from(e.dataTransfer.files);
    const zip = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
    if (zip) {
      setSelectedZipFile(zip);
    } else {
      setErrorText("请拖入 Notion 官方导出的 .zip 压缩包文件");
    }
  };

  const handleRunTreeImport = async () => {
    if (pendingEntries.length === 0) return;
    setSubmitting(true);
    setErrorText(null);
    try {
      const res = await importMarkdownTree(pendingEntries, parentId || null);
      setLastBatchResult(res);
      setPendingEntries([]);
      if (onBatchImported) {
        await onBatchImported(res);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunNotionZipImport = async () => {
    if (!selectedZipFile) return;
    setSubmitting(true);
    setErrorText(null);
    try {
      const b64 = await readFileAsBase64(selectedZipFile);
      const res = await importNotionZipBytes(b64, parentId || null);
      setLastBatchResult(res);
      setSelectedZipFile(null);
      if (onBatchImported) {
        await onBatchImported(res);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyExport = async () => {
    if (!exportData) return;
    try {
      await navigator.clipboard.writeText(exportData.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleDownloadExport = () => {
    if (!exportData) return;
    const blob = new Blob([exportData.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportData.filename || "notion-page.md";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handlePasteImport = async () => {
    if (!markdown.trim() && !title.trim()) return;
    setSubmitting(true);
    setErrorText(null);
    try {
      await onImportSubmit(
        title.trim() || "导入的 Markdown 页面",
        markdown,
        parentId || null
      );
      setTitle("");
      setMarkdown("");
      onClose();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const renderParentSelector = () => (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span
        style={{
          fontSize: "12.5px",
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        导入目标位置：
      </span>
      <select
        className="nb-input"
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
      >
        <option value="">工作区顶层目录</option>
        {pages
          .filter((p) => p.pageType === "doc")
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.icon} {p.title || "无标题"}
            </option>
          ))}
      </select>
    </div>
  );

  const renderMigrationSummary = () => {
    if (!lastBatchResult) return null;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          borderRadius: "8px",
          border: "1px solid var(--border-strong)",
          background: "var(--bg-secondary)",
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--success-color)",
          }}
        >
          ✓ 迁移完成！所有层级目录、多维数据库与页面双链已写入本地存储
        </div>
        <div className="nb-import-summary-grid">
          <div className="nb-import-stat-card">
            <div className="nb-import-stat-value">
              {lastBatchResult.importedPages}
            </div>
            <div className="nb-import-stat-label">导入页面数</div>
          </div>
          <div className="nb-import-stat-card">
            <div className="nb-import-stat-value">
              {lastBatchResult.importedDatabases}
            </div>
            <div className="nb-import-stat-label">多维数据库</div>
          </div>
          <div className="nb-import-stat-card">
            <div className="nb-import-stat-value">
              {lastBatchResult.importedBlocks}
            </div>
            <div className="nb-import-stat-label">解析内容块</div>
          </div>
          <div className="nb-import-stat-card">
            <div className="nb-import-stat-value">
              {lastBatchResult.resolvedLinks}
            </div>
            <div className="nb-import-stat-label">自动还原双链</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nb-modal-card is-wide"
        style={{ maxWidth: "700px" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Upload size={17} />
            <span>导入、导出与 Notion 迁移中心</span>
          </div>
          <button type="button" className="nb-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Multi-Tab Navigation */}
        <div className="nb-modal-tabs">
          <button
            type="button"
            className={`nb-modal-tab${activeTab === "files" ? " is-active" : ""}`}
            onClick={() => {
              setErrorText(null);
              setLastBatchResult(null);
              setActiveTab("files");
            }}
          >
            <FolderOpen size={14} /> 文件 / 文件夹批量导入
          </button>

          <button
            type="button"
            className={`nb-modal-tab${activeTab === "zip" ? " is-active" : ""}`}
            onClick={() => {
              setErrorText(null);
              setLastBatchResult(null);
              setActiveTab("zip");
            }}
          >
            <Archive size={14} /> Notion .zip 导出包迁移
          </button>

          <button
            type="button"
            className={`nb-modal-tab${activeTab === "paste" ? " is-active" : ""}`}
            onClick={() => {
              setErrorText(null);
              setLastBatchResult(null);
              setActiveTab("paste");
            }}
          >
            <FileText size={14} /> 粘贴 Markdown
          </button>

          <button
            type="button"
            className={`nb-modal-tab${activeTab === "export" ? " is-active" : ""}`}
            onClick={() => {
              setErrorText(null);
              setLastBatchResult(null);
              setActiveTab("export");
              if (!exportData && onRequestExportCurrent) {
                onRequestExportCurrent();
              }
            }}
          >
            <Download size={14} /> 导出当前页 Markdown
          </button>
        </div>

        <div
          style={{
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            overflowY: "auto",
          }}
        >
          {errorText && (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                background: "var(--danger-bg)",
                color: "var(--danger-color)",
                fontSize: "12.5px",
              }}
            >
              {errorText}
            </div>
          )}

          {/* TAB 1: Batch Files & Folder Tree Import */}
          {activeTab === "files" && (
            <>
              {renderParentSelector()}

              <div
                className={`nb-dropzone${filesDragOver ? " is-dragover" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFilesDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setFilesDragOver(false);
                }}
                onDrop={handleFilesDropZoneDrop}
              >
                <FolderOpen
                  size={28}
                  style={{ color: "var(--accent-color)" }}
                />
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  将 .md / .csv 文件或整个文件夹直接拖放到此处
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    maxWidth: "480px",
                  }}
                >
                  自动保留多级子目录层级、内嵌相对路径图片、将 CSV 转换为多维数据库，并还原文档间的双向链接
                </div>

                <input
                  ref={multiFilesInputRef}
                  type="file"
                  multiple
                  accept=".md,.markdown,.txt,.csv"
                  style={{ display: "none" }}
                  onChange={handleMultiFilesPicked}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleMultiFilesPicked}
                />

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "center",
                    gap: "8px",
                    marginTop: "4px",
                  }}
                >
                  <button
                    type="button"
                    className="nb-btn-secondary"
                    onClick={() => multiFilesInputRef.current?.click()}
                  >
                    <FileUp size={14} /> 选择 .md/.csv 文件 (支持多选)
                  </button>
                  <button
                    type="button"
                    className="nb-btn-primary"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderOpen size={14} /> 选择整个 Markdown 文件夹 (保留目录树)
                  </button>
                </div>
              </div>

              {pendingEntries.length > 0 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      marginBottom: "6px",
                    }}
                  >
                    <span>已就绪文件：{pendingEntries.length} 个</span>
                    <button
                      type="button"
                      style={{
                        fontSize: "12px",
                        color: "var(--text-tertiary)",
                      }}
                      onClick={() => setPendingEntries([])}
                    >
                      清空已选
                    </button>
                  </div>
                  <div className="nb-selected-files-box">
                    {pendingEntries.slice(0, 30).map((e) => (
                      <div key={e.relativePath}>📄 {e.relativePath}</div>
                    ))}
                    {pendingEntries.length > 30 && (
                      <div>... 以及另外 {pendingEntries.length - 30} 个文件</div>
                    )}
                  </div>
                </div>
              )}

              {renderMigrationSummary()}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "8px",
                }}
              >
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={onClose}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="nb-btn-primary"
                  disabled={submitting || pendingEntries.length === 0}
                  onClick={handleRunTreeImport}
                >
                  {submitting
                    ? "正在批量构建目录树..."
                    : `立即导入 (${pendingEntries.length})`}
                </button>
              </div>
            </>
          )}

          {/* TAB 2: Official Notion .zip Migration */}
          {activeTab === "zip" && (
            <>
              {renderParentSelector()}

              <div
                className={`nb-dropzone${zipDragOver ? " is-dragover" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setZipDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setZipDragOver(false);
                }}
                onDrop={handleZipDropZoneDrop}
              >
                <Archive size={28} style={{ color: "var(--accent-color)" }} />
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  一键迁移 Notion 官方导出的 Markdown & CSV (.zip) 压缩包
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    maxWidth: "500px",
                  }}
                >
                  支持 Notion「Export all workspace content」双层嵌套 .zip、自动剥离 32 位哈希后缀、合并同名父子目录、还原 CSV 数据库与相对路径双链
                </div>

                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setErrorText(null);
                      setLastBatchResult(null);
                      setSelectedZipFile(f);
                    }
                    e.target.value = "";
                  }}
                />

                <button
                  type="button"
                  className="nb-btn-primary"
                  style={{ marginTop: "4px" }}
                  onClick={() => zipInputRef.current?.click()}
                >
                  <Archive size={14} /> 选择 Notion 官方导出 .zip 包
                </button>
              </div>

              {selectedZipFile && (
                <div
                  className="nb-selected-files-box"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>
                    📦 <b>{selectedZipFile.name}</b> (
                    {(selectedZipFile.size / 1024).toFixed(1)} KB)
                  </span>
                  <button
                    type="button"
                    style={{ fontSize: "12px", color: "var(--text-tertiary)" }}
                    onClick={() => setSelectedZipFile(null)}
                  >
                    移除
                  </button>
                </div>
              )}

              {renderMigrationSummary()}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "8px",
                }}
              >
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={onClose}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="nb-btn-primary"
                  disabled={submitting || !selectedZipFile}
                  onClick={handleRunNotionZipImport}
                >
                  {submitting ? "正在解压并迁移知识库..." : "开始迁移 Notion 导出包"}
                </button>
              </div>
            </>
          )}

          {/* TAB 3: Single-Page Paste Markdown */}
          {activeTab === "paste" && (
            <>
              <div
                style={{ display: "flex", gap: "10px", alignItems: "center" }}
              >
                <input
                  type="text"
                  className="nb-input"
                  placeholder="页面标题（留空将自动提取首个 # 标题）"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />

                <input
                  ref={singleFileInputRef}
                  type="file"
                  accept=".md,.markdown,.txt"
                  style={{ display: "none" }}
                  onChange={handleSingleFileSelect}
                />
                <button
                  type="button"
                  className="nb-btn-secondary"
                  style={{ whiteSpace: "nowrap" }}
                  onClick={() => singleFileInputRef.current?.click()}
                >
                  <FileUp size={14} /> 读取单个 .md
                </button>
              </div>

              {renderParentSelector()}

              <textarea
                className="nb-textarea"
                style={{
                  minHeight: "200px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12.5px",
                }}
                placeholder={
                  "# 示例标题\n\n支持解析标题、待办 `- [ ]`、列表、引用 `>`、代码块 ```、公式 $$...$$、图片 `![说明](url)` 与表格..."
                }
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
              />

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "8px",
                }}
              >
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="nb-btn-primary"
                  disabled={submitting || (!markdown.trim() && !title.trim())}
                  onClick={handlePasteImport}
                >
                  {submitting ? "正在解析导入..." : "创建页面"}
                </button>
              </div>
            </>
          )}

          {/* TAB 4: Export Current Page Markdown */}
          {activeTab === "export" && (
            <>
              <textarea
                readOnly
                className="nb-textarea"
                style={{
                  minHeight: "240px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12.5px",
                }}
                value={
                  exportData?.markdown ??
                  "当前尚未选中可导出的页面，请先在左侧选择一篇文档或数据库。"
                }
              />

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "8px",
                }}
              >
                <button
                  type="button"
                  className="nb-btn-secondary"
                  disabled={!exportData}
                  onClick={handleCopyExport}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "已复制到剪贴板" : "复制 Markdown"}
                </button>
                <button
                  type="button"
                  className="nb-btn-primary"
                  disabled={!exportData}
                  onClick={handleDownloadExport}
                >
                  <Download size={14} /> 下载 .md 文件
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
