import React, { useEffect, useState } from "react";
import { Copy, ExternalLink, Globe, Loader2, X } from "lucide-react";
import { publishedPageUrl, publishPageWeb, unpublishPageWeb } from "../../api/publish";
import { openExternalUrl } from "../../api/sync";
import { cleanError } from "../../api/attachments";

interface Props {
  open: boolean;
  pageId: string | null;
  pageTitle: string;
  onClose: () => void;
  onOpenSyncSettings: () => void;
  onNotify: (msg: string) => void;
}

/** 发布为网页：生成只读链接分享给别人；页面改了可以一键更新 */
export const PublishModal: React.FC<Props> = ({ open, pageId, pageTitle, onClose, onOpenSyncSettings, onNotify }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "publish" | "unpublish">("");
  const [error, setError] = useState("");
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  useEffect(() => {
    if (!open || !pageId) return;
    setError("");
    setConfirmUnpublish(false);
    publishedPageUrl(pageId).then(setUrl).catch(() => setUrl(null));
  }, [open, pageId]);

  if (!open || !pageId) return null;

  const needsServer = /小悦同步服务器/.test(error);

  const doPublish = async () => {
    setBusy("publish");
    setError("");
    try {
      const info = await publishPageWeb(pageId, pageTitle);
      setUrl(info.url);
      await navigator.clipboard?.writeText(info.url).catch(() => {});
      onNotify(url ? "已更新网页，链接不变" : "已发布，链接已复制");
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy("");
    }
  };

  const doUnpublish = async () => {
    if (!confirmUnpublish) {
      setConfirmUnpublish(true);
      return;
    }
    setBusy("unpublish");
    setError("");
    try {
      await unpublishPageWeb(pageId);
      setUrl(null);
      setConfirmUnpublish(false);
      onNotify("已取消发布，原链接打不开了");
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="nb-modal-card nb-publish" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Globe size={17} />
            <span>发布为网页</span>
          </div>
          <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="关闭" disabled={!!busy}>
            <X size={16} />
          </button>
        </div>
        <div className="nb-publish-body">
          <p className="nb-publish-desc">
            生成一个只读链接，别人不用安装小悦笔记也能看。页面放在你的同步服务器上，改完后点「更新」，链接保持不变。
          </p>

          {url ? (
            <div className="nb-publish-link">
              <input readOnly value={url} aria-label="网页链接" onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="nb-icon-btn"
                title="复制链接"
                aria-label="复制链接"
                onClick={() => navigator.clipboard?.writeText(url).then(() => onNotify("链接已复制"))}
              >
                <Copy size={15} />
              </button>
              <button
                type="button"
                className="nb-icon-btn"
                title="在浏览器里打开"
                aria-label="在浏览器里打开"
                onClick={() => openExternalUrl(url).catch(() => {})}
              >
                <ExternalLink size={15} />
              </button>
            </div>
          ) : (
            <div className="nb-publish-none">这个页面还没有发布。</div>
          )}

          {error && (
            <div className="nb-publish-error">
              {error}
              {needsServer && (
                <button type="button" className="nb-quickset-link" onClick={onOpenSyncSettings}>
                  去设置同步
                </button>
              )}
            </div>
          )}

          <div className="nb-publish-actions">
            {url && (
              <button type="button" className="nb-btn-secondary" disabled={!!busy} onClick={() => void doUnpublish()}>
                {busy === "unpublish" ? "正在取消…" : confirmUnpublish ? "确认取消发布？" : "取消发布"}
              </button>
            )}
            <button type="button" className="nb-btn-primary" disabled={!!busy} onClick={() => void doPublish()}>
              {busy === "publish" ? <Loader2 size={14} className="nb-spin" /> : null}
              {busy === "publish" ? "正在发布…" : url ? "更新网页" : "发布并复制链接"}
            </button>
          </div>
          <p className="nb-publish-tip">网页里只有这一页的内容，子页面和附件需要单独分享。</p>
        </div>
      </div>
    </div>
  );
};
