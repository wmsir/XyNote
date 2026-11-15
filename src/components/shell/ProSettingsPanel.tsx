import React, { useEffect, useState } from "react";
import { BadgeCheck, Clock, ExternalLink, LogOut, MonitorSmartphone, Plus } from "lucide-react";
import { openExternalUrl, syncErrorText } from "../../api/sync";
import {
  activateLicense,
  deactivateLicense,
  FWPT_REGISTER_URL,
  getLicenseStatus,
  licenseLogin,
  licenseLogout,
  PRO_FEATURES,
  PRO_PRICE,
  type LicenseStatus,
  type ProProduct,
} from "../../api/pro";
import { PurchaseDialog } from "./PurchaseDialog";

export interface ProSettingsPanelProps {
  onLicenseChanged: (status: LicenseStatus) => void;
  onNotify: (msg: string) => void;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

export function ProSettingsPanel({ onLicenseChanged, onNotify }: ProSettingsPanelProps) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [buying, setBuying] = useState<ProProduct | null>(null);

  useEffect(() => {
    getLicenseStatus().then(setStatus).catch(() => {});
  }, []);

  const apply = (s: LicenseStatus) => {
    setStatus(s);
    onLicenseChanged(s);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(syncErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const login = () =>
    run("login", async () => {
      const s = await licenseLogin(account.trim(), password);
      setPassword("");
      apply(s);
      if (s.active && s.edition === "trial") onNotify(`登录成功，永久版功能可免费使用到 ${day(s.expiresAt)}`);
      else if (s.active) onNotify("登录成功，永久版已激活");
      else onNotify("登录成功");
    });

  const activate = () =>
    run("activate", async () => {
      const s = await activateLicense(code);
      setCode("");
      apply(s);
      onNotify("永久版已激活，感谢支持");
    });

  const deactivate = () => {
    if (!confirmDeactivate) {
      setConfirmDeactivate(true);
      return;
    }
    run("deactivate", async () => {
      apply(await deactivateLicense());
      setConfirmDeactivate(false);
      onNotify("已停用本机授权，激活码空出一个位置");
    });
  };

  const logout = () =>
    run("logout", async () => {
      apply(await licenseLogout());
    });

  const s = status;
  const lifetime = !!s?.active && s.edition === "lifetime";
  const trial = !!s?.active && s.edition === "trial";

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">永久版</h3>
        <p className="nb-settings-desc">
          小悦笔记的编辑、多维表格和各种同步方式都免费使用。登录 FWPT 通行证即可免费体验一年（1 台电脑）；永久版 {PRO_PRICE} 一次购买，可在 3 台电脑使用，不够还能单独增加。
        </p>
      </div>

      {s && !s.configured && (
        <div className="nb-sync-error" role="note">
          当前是开发版本，无法登录或激活永久版，请从官网下载正式版。
        </div>
      )}

      {/* 授权状态 */}
      {s?.loggedIn || s?.active || s?.expired ? (
        <div className={`nb-settings-card-box${lifetime ? " nb-pro-active" : ""}`}>
          <div className="nb-pro-badge-row">
            {lifetime ? <BadgeCheck size={22} className="nb-pro-badge-icon" /> : <Clock size={22} className="nb-pro-badge-icon" />}
            <div>
              <div className="nb-settings-label">
                {lifetime
                  ? "永久版已激活"
                  : trial
                  ? `免费使用中，到 ${day(s?.expiresAt)}`
                  : s?.expired
                  ? "一年免费期已结束"
                  : "还没有永久版授权"}
              </div>
              <div className="nb-settings-sub">
                {s?.account ? `通行证 ${s.account}` : s?.name ? `授权给 ${s.name}` : ""}
                {lifetime && s?.code ? ` · 激活码 ${s.code}` : ""}
                {lifetime && s?.maxDevices ? `（已用 ${s.devicesUsed ?? 1} / ${s.maxDevices} 台）` : ""}
              </div>
              {trial && <div className="nb-settings-sub">注册登录赠送一年，免费账号可在 1 台电脑使用。购买永久版可用 3 台。</div>}
            </div>
          </div>
          <div className="nb-settings-actions-bar">
            {!lifetime && (
              <button type="button" className="nb-btn-primary" disabled={!s?.configured} onClick={() => setBuying("lifetime")}>
                购买永久版 {PRO_PRICE}
              </button>
            )}
            {lifetime && s?.loggedIn && (
              <button type="button" className="nb-btn-secondary" onClick={() => setBuying("device_slot")}>
                <Plus size={14} /> 增加 1 台电脑
              </button>
            )}
            {s?.loggedIn && (
              <button type="button" className="nb-btn-secondary" onClick={() => openExternalUrl(s.userCenterUrl)}>
                <ExternalLink size={14} /> 管理电脑与订单
              </button>
            )}
            {lifetime && (
              <button type="button" className="nb-btn-secondary" disabled={busy !== null} onClick={deactivate}>
                <MonitorSmartphone size={14} />
                {confirmDeactivate ? "再点一次确认停用" : "停用本机授权"}
              </button>
            )}
            {s?.loggedIn && (
              <button type="button" className="nb-btn-secondary" disabled={busy !== null} onClick={logout}>
                <LogOut size={14} /> 退出通行证
              </button>
            )}
            <span className="nb-settings-sub">本机：{s?.machineName}</span>
          </div>
          {s?.notice && !s.active && <div className="nb-sync-error">{s.notice}</div>}
          {confirmDeactivate && (
            <div className="nb-settings-sub">停用后本机不能再使用永久版功能，激活码空出一个位置，可以在其他电脑上激活。</div>
          )}
        </div>
      ) : null}

      {/* 登录 */}
      {s && !s.loggedIn && (
        <div className="nb-settings-card-box">
          <div>
            <div className="nb-settings-label">登录 FWPT 通行证</div>
            <div className="nb-settings-sub">第一次登录赠送一年永久版权限；购买的激活码也会绑定到这个账号。</div>
          </div>
          <div className="nb-sync-field-row">
            <div className="nb-sync-field">
              <label className="nb-settings-label" htmlFor="pro-account">
                通行证账号
              </label>
              <input
                id="pro-account"
                className="nb-input"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="手机号 / 邮箱 / 用户名"
                autoComplete="username"
              />
            </div>
            <div className="nb-sync-field">
              <label className="nb-settings-label" htmlFor="pro-password">
                密码
              </label>
              <input
                id="pro-password"
                type="password"
                className="nb-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === "Enter" && account.trim() && password && login()}
              />
            </div>
          </div>
          <div className="nb-settings-actions-bar">
            <button
              type="button"
              className="nb-btn-primary"
              disabled={busy !== null || !account.trim() || !password || !s.configured}
              onClick={login}
            >
              {busy === "login" ? "正在登录…" : "登录"}
            </button>
            <button type="button" className="nb-btn-secondary" onClick={() => openExternalUrl(FWPT_REGISTER_URL)}>
              注册通行证
            </button>
            <span className="nb-settings-sub">登录时会记录本机名称和系统版本，用于核对授权。</span>
          </div>
        </div>
      )}

      {/* 激活码 */}
      {!lifetime && (
        <div className="nb-settings-card-box">
          <div className="nb-sync-field">
            <label className="nb-settings-label" htmlFor="pro-code">
              激活码
            </label>
            <div className="nb-path-input-group">
              <input
                id="pro-code"
                className="nb-input nb-mono-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XYP-XXXX-XXXX-XXXX-XXXX"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && code.trim() && activate()}
              />
              <button
                type="button"
                className="nb-btn-primary"
                disabled={busy !== null || !code.trim() || !s?.configured}
                onClick={activate}
              >
                {busy === "activate" ? "正在激活…" : "激活"}
              </button>
            </div>
            <div className="nb-settings-sub">
              购买后我们会把激活码发到你的邮箱。一个激活码可在 3 台电脑上使用，激活前请先登录通行证。
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="nb-sync-error" role="alert">
          {error}
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

      {buying && s && <PurchaseDialog status={s} product={buying} onClose={() => setBuying(null)} onNotify={onNotify} />}
    </div>
  );
}
