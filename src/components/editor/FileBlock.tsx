import React, { useRef, useState } from "react";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  Paperclip,
  Presentation,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { Block, BlockProps } from "../../types/notion";
import { attachFileBytes, cleanError, formatFileSize, openAttachment, revealAttachment } from "../../api/attachments";
import { readFileAsBase64 } from "../shell/fileDropUtils";
import { isTauriRuntime } from "../../api/client";

interface FileBlockProps {
  block: Block;
  onPropsChange: (blockId: string, next: BlockProps) => void;
}

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf", "doc", "docx", "txt", "md", "rtf", "pages"].includes(ext)) return <FileText size={22} />;
  if (["xls", "xlsx", "csv", "numbers"].includes(ext)) return <FileSpreadsheet size={22} />;
  if (["ppt", "pptx", "key"].includes(ext)) return <Presentation size={22} />;
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return <FileArchive size={22} />;
  if (["mp3", "wav", "m4a", "flac", "aac"].includes(ext)) return <FileAudio size={22} />;
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return <FileVideo size={22} />;
  return <FileIcon size={22} />;
}

/** 附件块：文件存在数据目录的 assets/attachments 里，点击用系统程序打开 */
export const FileBlock: React.FC<FileBlockProps> = ({ block, onPropsChange }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { filePath, fileName, fileSize } = block.props;
  const desktop = isTauriRuntime();

  const pick = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const b64 = await readFileAsBase64(file);
      const info = await attachFileBytes(file.name, b64);
      onPropsChange(block.id, {
        ...block.props,
        filePath: info.relPath,
        fileName: info.fileName || file.name,
        fileSize: info.size || file.size,
        mimeType: info.mime || file.type,
      });
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const run = (fn: () => Promise<void>) => {
    setError("");
    fn().catch((err) => setError(cleanError(err)));
  };

  if (!fileName) {
    return (
      <div className="nb-editor-media-empty nb-fileblock-empty" contentEditable={false}>
        <div className="nb-editor-media-empty-top">
          <div className="nb-editor-media-empty-label">
            <Paperclip size={16} />
            <span>添加附件：PDF、Word、表格、压缩包等任意文件，也可以直接把文件拖进窗口</span>
          </div>
        </div>
        <button
          type="button"
          className="nb-btn-secondary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "正在保存…" : "选择文件…"}
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
        {error && <div className="nb-fileblock-error">{error}</div>}
      </div>
    );
  }

  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toUpperCase() : "";
  const canOpen = desktop && !!filePath;

  return (
    <div className="nb-fileblock" contentEditable={false}>
      <div
        className="nb-fileblock-card"
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        title={canOpen ? "双击用系统程序打开" : undefined}
        onDoubleClick={() => canOpen && run(() => openAttachment(filePath!))}
        onKeyDown={(e) => {
          if (canOpen && e.key === "Enter") run(() => openAttachment(filePath!));
        }}
      >
        <span className="nb-fileblock-icon">{iconFor(fileName)}</span>
        <span className="nb-fileblock-meta">
          <span className="nb-fileblock-name" data-i18n-skip="">
            {fileName}
          </span>
          <span className="nb-fileblock-sub" data-i18n-skip="">
            {[ext, formatFileSize(fileSize)].filter(Boolean).join("  ")}
          </span>
        </span>
        {canOpen && (
          <span className="nb-fileblock-actions">
            <button
              type="button"
              className="nb-icon-btn"
              title="用系统程序打开"
              aria-label="用系统程序打开"
              onClick={() => run(() => openAttachment(filePath!))}
            >
              <SquareArrowOutUpRight size={15} />
            </button>
            <button
              type="button"
              className="nb-icon-btn"
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              onClick={() => run(() => revealAttachment(filePath!))}
            >
              <FolderOpen size={15} />
            </button>
          </span>
        )}
      </div>
      {error && <div className="nb-fileblock-error">{error}</div>}
    </div>
  );
};
