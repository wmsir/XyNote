import React, { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import {
  autoCheckDue,
  checkForUpdate,
  getAutoUpdateCheck,
  getSkippedVersion,
  markAutoChecked,
  setAutoUpdateCheck,
  skipVersion,
  type UpdateInfo,
} from "../../api/desktop";
import { isTauriRuntime } from "../../api/client";
import { openExternalUrl } from "../../api/sync";

function formatSize(bytes: number): string {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Validation error: /, "");

function open(url: string) {
  openExternalUrl(url).catch(() => window.open(url, "_blank"));
}

/** 设置 → 关于软件：检查更新 */
export function UpdateCard() {
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(getAutoUpdateCheck());
  const [showNotes, setShowNotes] = useState(false);

  const run = async () => {
    setChecking(true);
    setError(null);
    try {
      setInfo(await checkForUpdate());
      markAutoChecked();
    } catch (e) {
      setError(errText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="nb-settings-card-box nb-update-card">
      <div className="nb-update-head">
        <div>
          <div className="nb-settings-label">检查更新</div>
          <div className="nb-settings-sub">{`当前版本 v${__APP_VERSION__}`}</div>
        </div>
        <button type="button" className="nb-btn-secondary nb-update-btn" disabled={checking || !isTauriRuntime()} onClick={() => void run()}>
          <RefreshCw size={14} className={checking ? "is-spinning" : ""} />
          {checking ? "正在检查…" : "检查更新"}
        </button>
      </div>

      {error && <div className="nb-update-msg is-error">{error}</div>}
      {info && !info.hasUpdate && <div className="nb-update-msg">{`已经是最新版本 v${info.currentVersion}`}</div>}
      {info && info.hasUpdate && (
        <div className="nb-update-new">
          <div className="nb-update-new-title">{`发现新版本 v${info.latestVersion}`}</div>
          {info.publishedAt && <div className="nb-settings-sub">{`发布于 ${info.publishedAt.slice(0, 10)}`}</div>}
          <div className="nb-update-actions">
            {info.assetUrl ? (
              <button type="button" className="nb-btn-primary nb-update-btn" onClick={() => open(info.assetUrl)}>
                <Download size={14} /> 下载安装包{info.assetSize ? `（${formatSize(info.assetSize)}）` : ""}
              </button>
            ) : null}
            <button type="button" className="nb-btn-secondary nb-update-btn" onClick={() => open(info.releaseUrl)}>
              <ExternalLink size={14} /> 打开发布页面
            </button>
            {info.notes && (
              <button type="button" className="nb-link-btn" onClick={() => setShowNotes((v) => !v)}>
                {showNotes ? "收起更新说明" : "查看更新说明"}
              </button>
            )}
          </div>
          {showNotes && info.notes && <pre className="nb-update-notes">{info.notes}</pre>}
          <div className="nb-settings-sub">下载后关闭小悦笔记，运行安装包即可升级，笔记数据不受影响。</div>
        </div>
      )}

      <label className="nb-update-auto">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            setAutoUpdateCheck(e.target.checked);
          }}
        />
        启动时自动检查更新（每天最多一次）
      </label>
    </div>
  );
}

/** 启动后自动检查；有新版本时在右下角提示一次 */
export function UpdateNotice({ onOpenAbout }: { onOpenAbout: () => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    // 只在主窗口自动检查，避免每开一个窗口都提示
    if (!isTauriRuntime() || new URLSearchParams(window.location.search).has("page")) return;
    if (!getAutoUpdateCheck() || !autoCheckDue()) return;
    const timer = window.setTimeout(() => {
      checkForUpdate()
        .then((res) => {
          markAutoChecked();
          if (res.hasUpdate && res.latestVersion !== getSkippedVersion()) setInfo(res);
        })
        .catch(() => {});
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!info) return null;
  return (
    <div className="nb-update-toast" role="status">
      <div className="nb-update-toast-text">
        <b>{`小悦笔记 v${info.latestVersion} 已发布`}</b>
        <span>{`当前版本 v${info.currentVersion}`}</span>
      </div>
      <div className="nb-update-toast-actions">
        <button
          type="button"
          className="nb-btn-primary nb-update-btn"
          onClick={() => {
            open(info.assetUrl || info.releaseUrl);
            setInfo(null);
          }}
        >
          <Download size={14} /> 下载
        </button>
        <button
          type="button"
          className="nb-btn-secondary nb-update-btn"
          onClick={() => {
            onOpenAbout();
            setInfo(null);
          }}
        >
          详情
        </button>
        <button
          type="button"
          className="nb-link-btn"
          onClick={() => {
            skipVersion(info.latestVersion);
            setInfo(null);
          }}
        >
          跳过此版本
        </button>
      </div>
      <button type="button" className="nb-icon-btn nb-update-toast-close" aria-label="关闭" onClick={() => setInfo(null)}>
        <X size={14} />
      </button>
    </div>
  );
}
