import React, { useEffect, useRef, useState } from "react";
import { useDialog } from "../../hooks/useDialog";
import { Globe, Loader2, X } from "lucide-react";

interface Props {
  open: boolean;
  initialUrl?: string;
  onClose: () => void;
  /** 抓取并建页；返回错误信息或 null */
  onClip: (url: string) => Promise<string | null>;
}

/** 剪藏网页：输入网址，提取正文存成新页面 */
export const ClipperModal: React.FC<Props> = ({ open, initialUrl = "", onClose, onClip }) => {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setError("");
    setBusy(false);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open, initialUrl]);

  // 正在处理时按 Esc 不关闭
  const dialogRef = useDialog(open, onClose, { closeOnEscape: !busy });

  if (!open) return null;

  const submit = async () => {
    const u = url.trim();
    if (!u || busy) return;
    const normalized = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    setBusy(true);
    setError("");
    const err = await onClip(normalized);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="剪藏网页"
        tabIndex={-1}
        className="nb-modal-card nb-clipper" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Globe size={17} />
            <span>剪藏网页</span>
          </div>
          <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <div className="nb-clipper-body">
          <p className="nb-clipper-desc">
            粘贴文章网址，自动去掉广告和导航，只保留正文、图片和原文链接，存成一个新页面。图片会下载到本地。
          </p>
          <form
            className="nb-clipper-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              ref={inputRef}
              type="url"
              className="nb-input"
              placeholder="https://"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="网页地址"
            />
            <button type="submit" className="nb-btn-primary" disabled={busy || !url.trim()}>
              {busy ? <Loader2 size={14} className="nb-spin" /> : null}
              {busy ? "正在剪藏…" : "剪藏"}
            </button>
          </form>
          {error && <div className="nb-clipper-error">{error}</div>}
          <p className="nb-clipper-tip">需要登录才能看的网页抓不到正文，可以在浏览器里全选复制，再粘贴到页面里。</p>
        </div>
      </div>
    </div>
  );
};
