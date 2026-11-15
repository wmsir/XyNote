import React from "react";
import { AlertTriangle } from "lucide-react";

/**
 * 磁盘文件冲突：正在编辑的文件被其他程序（编辑器、同步盘）改过。
 * 不自动覆盖，让用户选择保留哪一份。
 */
export interface FileConflictDialogProps {
  fileName: string;
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onSaveCopy: () => void;
}

export const FileConflictDialog: React.FC<FileConflictDialogProps> = ({
  fileName,
  busy,
  onReload,
  onOverwrite,
  onSaveCopy,
}) => (
  <div className="nb-modal-backdrop" role="presentation">
    <div
      className="nb-modal-card nb-conflict-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="nb-conflict-title"
      aria-describedby="nb-conflict-desc"
    >
      <div className="nb-modal-header">
        <div className="nb-modal-title" id="nb-conflict-title">
          <AlertTriangle size={17} />
          <span>文件已在别处被修改</span>
        </div>
      </div>
      <div className="nb-conflict-body">
        <p id="nb-conflict-desc">
          「{fileName}」在你编辑期间被其他程序改过（例如另一个编辑器或同步盘）。为避免互相覆盖，你的改动还没有写入。
        </p>
        <div className="nb-conflict-actions">
          <button type="button" className="nb-btn-secondary" disabled={busy} onClick={onSaveCopy}>
            把我的版本另存为…
          </button>
          <button type="button" className="nb-btn-secondary" disabled={busy} onClick={onReload}>
            载入磁盘上的版本
          </button>
          <button type="button" className="nb-btn-danger" disabled={busy} onClick={onOverwrite}>
            用我的版本覆盖
          </button>
        </div>
        <p className="nb-conflict-hint">「载入磁盘上的版本」会丢弃你尚未写入的改动。</p>
      </div>
    </div>
  </div>
);
