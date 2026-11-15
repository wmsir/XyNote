import React, { useEffect, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { openExternalUrl, syncErrorText } from "../../api/sync";
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  PRO_FEATURES,
  type LicenseStatus,
} from "../../api/pro";

export interface ProSettingsPanelProps {
  onLicenseChanged: (status: LicenseStatus) => void;
  onNotify: (msg: string) => void;
}

export function ProSettingsPanel({ onLicenseChanged, onNotify }: ProSettingsPanelProps) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [license, setLicense] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    getLicenseStatus().then(setStatus).catch(() => {});
  }, []);

  const apply = (s: LicenseStatus) => {
    setStatus(s);
    onLicenseChanged(s);
  };

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await activateLicense(license);
      apply(s);
      setLicense("");
      onNotify("永久版已激活，感谢支持");
    } catch (e) {
      setError(syncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    apply(await deactivateLicense());
    setConfirmRemove(false);
    onNotify("已移除本机的永久版授权");
  };

  const purchaseUrl = status?.purchaseUrl || "https://fwpt.cn/xynote.html";

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">永久版</h3>
        <p className="nb-settings-desc">
          小悦笔记的全部基础功能免费使用，包括本地使用和各种同步方式。永久版一次购买、长期使用，解锁额外的高级功能。
        </p>
      </div>

      {status?.active ? (
        <div className="nb-settings-card-box nb-pro-active">
          <div className="nb-pro-badge-row">
            <BadgeCheck size={22} className="nb-pro-badge-icon" />
            <div>
              <div className="nb-settings-label">永久版已激活</div>
              <div className="nb-settings-sub">
                授权给 {status.name}
                {status.id ? `（授权编号 ${status.id}）` : ""}
              </div>
            </div>
          </div>
          <div className="nb-settings-actions-bar">
            <button type="button" className="nb-btn-secondary" onClick={remove}>
              {confirmRemove ? "再点一次确认移除" : "从本机移除授权"}
            </button>
            {confirmRemove && <span className="nb-settings-sub">移除后可随时用同一授权码重新激活。</span>}
          </div>
        </div>
      ) : (
        <div className="nb-settings-card-box">
          <div className="nb-sync-field">
            <label className="nb-settings-label" htmlFor="pro-license">
              授权码
            </label>
            <textarea
              id="pro-license"
              className="nb-input nb-mono-input nb-pro-license-input"
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              placeholder="粘贴以 XYNOTE1. 开头的授权码"
              spellCheck={false}
              rows={3}
            />
          </div>
          <div className="nb-settings-actions-bar">
            <button
              type="button"
              className="nb-btn-primary"
              disabled={busy || !license.trim() || status?.configured === false}
              onClick={activate}
            >
              {busy ? "正在激活…" : "激活永久版"}
            </button>
            <button type="button" className="nb-btn-secondary" onClick={() => openExternalUrl(purchaseUrl)}>
              去官网购买
            </button>
            <span className="nb-settings-sub">¥99 终生。激活不需要联网，换电脑后用同一授权码再次激活即可。</span>
          </div>
          <div className="nb-settings-sub">
            在官网用 FWPT 通行证购买后，到「同步 → 官方云同步」登录同一账号会自动激活，也可以在官网「我的订单」复制授权码粘贴到这里。
          </div>
          {status && !status.configured && (
            <div className="nb-settings-sub">当前是开发版本，无法激活永久版，请从官网下载正式版。</div>
          )}
          {error && (
            <div className="nb-sync-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}

      <div className="nb-settings-card-box">
        <div className="nb-settings-label">永久版包含</div>
        <ul className="nb-pro-features">
          {PRO_FEATURES.map((f) => (
            <li key={f.title}>
              <span className="nb-settings-label">{f.title}</span>
              <span className="nb-settings-sub">{f.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
