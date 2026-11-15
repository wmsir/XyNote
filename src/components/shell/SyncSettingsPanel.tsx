import React, { useCallback, useEffect, useState } from "react";
import { Cloud, FolderOpen, HardDrive, KeyRound, LogOut, RefreshCw, Server, Globe } from "lucide-react";
import { pickFolderDialog } from "../../api/client";
import {
  formatBytes,
  getSyncAccount,
  getSyncConfig,
  openExternalUrl,
  relativeTime,
  saveSyncConfig,
  syncAuth,
  syncErrorText,
  syncLogout,
  type SyncAccount,
  type SyncConfig,
  type SyncMode,
} from "../../api/sync";

export interface SyncSettingsPanelProps {
  /** 由 App 执行同步（会刷新页面列表和状态指示） */
  onRunSync: () => Promise<void>;
  syncing: boolean;
  onConfigChanged: (cfg: SyncConfig) => void;
  onNotify: (msg: string) => void;
}

const MODES: { id: SyncMode; label: string; desc: string; icon: React.ReactNode }[] = [
  { id: "local", label: "仅本地", desc: "笔记只保存在这台电脑", icon: <HardDrive size={16} /> },
  { id: "folder", label: "网盘文件夹", desc: "坚果云、OneDrive、iCloud 等同步盘里的文件夹", icon: <FolderOpen size={16} /> },
  { id: "webdav", label: "WebDAV", desc: "坚果云、Nextcloud、群晖等 WebDAV 服务", icon: <Globe size={16} /> },
  { id: "server", label: "自建服务器", desc: "部署 XyNote 同步服务器，数据完全自己掌握", icon: <Server size={16} /> },
  { id: "official", label: "官方云同步", desc: "开箱即用，订阅后可用", icon: <Cloud size={16} /> },
];

export function SyncSettingsPanel({ onRunSync, syncing, onConfigChanged, onNotify }: SyncSettingsPanelProps) {
  const [cfg, setCfg] = useState<SyncConfig | null>(null);
  const [mode, setMode] = useState<SyncMode>("local");
  const [folder, setFolder] = useState("");
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [account, setAccount] = useState<SyncAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    (c: SyncConfig) => {
      setCfg(c);
      setMode(c.mode);
      setFolder(c.folder);
      setWebdavUrl(c.webdavUrl);
      setWebdavUser(c.webdavUser);
      setServerUrl(c.serverUrl);
      onConfigChanged(c);
    },
    [onConfigChanged]
  );

  useEffect(() => {
    getSyncConfig().then(apply).catch((e) => setError(syncErrorText(e)));
  }, [apply]);

  const official = mode === "official";
  const loggedIn = cfg ? (official ? cfg.officialLoggedIn : cfg.serverLoggedIn) : false;

  // 账号信息（套餐、用量）
  useEffect(() => {
    setAccount(null);
    if (!cfg || !(mode === "server" || mode === "official") || !loggedIn || cfg.mode !== mode) return;
    let alive = true;
    getSyncAccount(official)
      .then((a) => alive && setAccount(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cfg, mode, loggedIn, official]);

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

  const save = () =>
    run("save", async () => {
      if (mode === "folder" && !folder.trim()) throw new Error("请选择用于同步的文件夹");
      if (mode === "webdav" && !webdavUrl.trim()) throw new Error("请填写 WebDAV 地址");
      if (mode === "server" && !serverUrl.trim()) throw new Error("请填写服务器地址");
      const next = await saveSyncConfig({
        mode,
        folder: folder.trim(),
        webdavUrl: webdavUrl.trim(),
        webdavUser: webdavUser.trim(),
        webdavPassword: webdavPassword ? webdavPassword : undefined,
        serverUrl: serverUrl.trim(),
      });
      setWebdavPassword("");
      apply(next);
      onNotify(mode === "local" ? "已切换为仅本地使用" : "同步设置已保存");
    });

  const auth = (action: "login" | "register") =>
    run(action, async () => {
      if (mode === "server") {
        // 先保存地址，登录用的就是它
        apply(await saveSyncConfig({ mode, serverUrl: serverUrl.trim() }));
      }
      const acct = await syncAuth(official, action, email.trim(), password);
      setPassword("");
      setAccount(acct);
      apply(await saveSyncConfig({ mode }));
      onNotify(action === "register" ? "注册成功，已登录" : "已登录");
    });

  const logout = () =>
    run("logout", async () => {
      await syncLogout(official);
      apply(await getSyncConfig());
      setAccount(null);
    });

  const savePassphrase = (clear: boolean) =>
    run("passphrase", async () => {
      if (!clear && passphrase.length < 6) throw new Error("加密密码至少 6 位");
      apply(await saveSyncConfig({ passphrase: clear ? "" : passphrase }));
      setPassphrase("");
      onNotify(clear ? "已关闭端到端加密（已加密的云端数据仍需原密码）" : "已保存加密密码");
    });

  const syncNow = () =>
    run("sync", async () => {
      await onRunSync();
      apply(await getSyncConfig());
    });

  const dirty =
    cfg !== null &&
    (mode !== cfg.mode ||
      folder !== cfg.folder ||
      webdavUrl !== cfg.webdavUrl ||
      webdavUser !== cfg.webdavUser ||
      webdavPassword !== "" ||
      serverUrl !== cfg.serverUrl);
  const active = cfg !== null && cfg.mode !== "local" && cfg.mode === mode && !dirty;
  const needsLogin = (mode === "server" || mode === "official") && !loggedIn;
  const report = cfg?.lastReport;

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">同步</h3>
        <p className="nb-settings-desc">
          默认只保存在本机。需要多台设备使用时，选一种同步方式；同时修改同一篇笔记不会丢内容，另一份会保存为「冲突副本」。
        </p>
      </div>

      <div className="nb-sync-modes" role="radiogroup" aria-label="同步方式">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`nb-sync-mode${mode === m.id ? " is-active" : ""}`}
            onClick={() => {
              setMode(m.id);
              setError(null);
            }}
          >
            <span className="nb-sync-mode-icon">{m.icon}</span>
            <span className="nb-sync-mode-text">
              <span className="nb-settings-label">{m.label}</span>
              <span className="nb-settings-sub">{m.desc}</span>
            </span>
          </button>
        ))}
      </div>

      {mode !== "local" && (
        <div className="nb-settings-card-box">
          {mode === "folder" && (
            <>
              <div>
                <div className="nb-settings-label">同步文件夹</div>
                <div className="nb-settings-sub">
                  选网盘客户端里的一个文件夹，笔记会写入其中的 <code>XyNoteSync</code>，由网盘负责传到其他设备。
                </div>
              </div>
              <div className="nb-path-input-group">
                <input
                  className="nb-input nb-mono-input"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="例如 D:\Nutstore\笔记"
                />
                <button
                  type="button"
                  className="nb-btn-secondary"
                  onClick={async () => {
                    const picked = await pickFolderDialog(folder || undefined, "选择同步文件夹").catch(() => null);
                    if (picked) setFolder(picked);
                  }}
                >
                  选择文件夹
                </button>
              </div>
            </>
          )}

          {mode === "webdav" && (
            <>
              <div className="nb-sync-field">
                <label className="nb-settings-label" htmlFor="sync-webdav-url">WebDAV 地址</label>
                <input
                  id="sync-webdav-url"
                  className="nb-input nb-mono-input"
                  value={webdavUrl}
                  onChange={(e) => setWebdavUrl(e.target.value)}
                  placeholder="https://dav.jianguoyun.com/dav/"
                />
              </div>
              <div className="nb-sync-field-row">
                <div className="nb-sync-field">
                  <label className="nb-settings-label" htmlFor="sync-webdav-user">账号</label>
                  <input id="sync-webdav-user" className="nb-input" value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} />
                </div>
                <div className="nb-sync-field">
                  <label className="nb-settings-label" htmlFor="sync-webdav-pass">
                    密码{cfg?.hasWebdavPassword ? "（已保存，留空不修改）" : ""}
                  </label>
                  <input
                    id="sync-webdav-pass"
                    type="password"
                    className="nb-input"
                    value={webdavPassword}
                    onChange={(e) => setWebdavPassword(e.target.value)}
                    placeholder="坚果云请填写「应用密码」"
                  />
                </div>
              </div>
            </>
          )}

          {mode === "server" && (
            <div className="nb-sync-field">
              <label className="nb-settings-label" htmlFor="sync-server-url">服务器地址</label>
              <input
                id="sync-server-url"
                className="nb-input nb-mono-input"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://notes.example.com"
              />
              <div className="nb-settings-sub">部署方法见项目 server/README.md（支持 Docker 一键部署）。</div>
            </div>
          )}

          {official && (
            <div className="nb-sync-official">
              <div>
                <div className="nb-settings-label">小悦笔记云同步</div>
                <div className="nb-settings-sub">无需自己准备网盘或服务器，登录即可在多台设备间同步。订阅期满后仍可下载已有数据。</div>
              </div>
              {cfg?.pricingUrl && (
                <button type="button" className="nb-btn-secondary" onClick={() => openExternalUrl(cfg.pricingUrl)}>
                  查看套餐与价格
                </button>
              )}
            </div>
          )}

          {(mode === "server" || official) &&
            (loggedIn ? (
              <div className="nb-sync-account">
                <div>
                  <div className="nb-settings-label">{official ? cfg?.officialEmail : cfg?.serverEmail}</div>
                  {account ? (
                    <div className="nb-settings-sub">
                      {account.requiresSubscription
                        ? account.subscriptionActive
                          ? `订阅有效${account.planExpiresAt ? `，${new Date(account.planExpiresAt).toLocaleDateString("zh-CN")} 到期` : ""}`
                          : "未订阅：可以下载已有数据，开通后才能上传"
                        : "已登录"}
                      {` · 已用 ${formatBytes(account.usedBytes)} / ${formatBytes(account.quotaBytes)}`}
                    </div>
                  ) : (
                    <div className="nb-settings-sub">已登录</div>
                  )}
                  {account && account.quotaBytes > 0 && (
                    <div className="nb-sync-quota" aria-hidden>
                      <span style={{ width: `${Math.min(100, (account.usedBytes / account.quotaBytes) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="nb-settings-actions-bar">
                  {official && account?.requiresSubscription && !account.subscriptionActive && cfg?.pricingUrl && (
                    <button type="button" className="nb-btn-primary" onClick={() => openExternalUrl(cfg.pricingUrl)}>
                      开通订阅
                    </button>
                  )}
                  <button type="button" className="nb-btn-secondary" disabled={busy !== null} onClick={logout}>
                    <LogOut size={14} /> 退出登录
                  </button>
                </div>
              </div>
            ) : (
              <div className="nb-sync-login">
                <div className="nb-sync-field-row">
                  <div className="nb-sync-field">
                    <label className="nb-settings-label" htmlFor="sync-email">邮箱</label>
                    <input id="sync-email" type="email" className="nb-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                  </div>
                  <div className="nb-sync-field">
                    <label className="nb-settings-label" htmlFor="sync-password">密码</label>
                    <input
                      id="sync-password"
                      type="password"
                      className="nb-input"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      onKeyDown={(e) => e.key === "Enter" && email && password && auth("login")}
                    />
                  </div>
                </div>
                <div className="nb-settings-actions-bar">
                  <button type="button" className="nb-btn-primary" disabled={busy !== null || !email || !password} onClick={() => auth("login")}>
                    {busy === "login" ? "正在登录…" : "登录"}
                  </button>
                  <button type="button" className="nb-btn-secondary" disabled={busy !== null || !email || password.length < 8} onClick={() => auth("register")}>
                    {busy === "register" ? "正在注册…" : "注册新账号"}
                  </button>
                </div>
              </div>
            ))}

          {dirty && !needsLogin && (
            <div className="nb-settings-actions-bar">
              <button type="button" className="nb-btn-primary" disabled={busy !== null} onClick={save}>
                {busy === "save" ? "正在保存…" : "保存并启用"}
              </button>
              <span className="nb-settings-sub">切换同步位置后，第一次同步会把两边的笔记合并。</span>
            </div>
          )}
        </div>
      )}

      {mode === "local" && cfg && cfg.mode !== "local" && (
        <div className="nb-settings-actions-bar">
          <button type="button" className="nb-btn-primary" disabled={busy !== null} onClick={save}>
            改为仅本地使用
          </button>
          <span className="nb-settings-sub">本机笔记保留不变，只是不再同步。</span>
        </div>
      )}

      {mode !== "local" && (
        <div className="nb-settings-card-box">
          <div className="nb-settings-row-head">
            <div>
              <div className="nb-settings-label">
                <KeyRound size={14} className="nb-sync-inline-icon" /> 端到端加密
              </div>
              <div className="nb-settings-sub">
                {cfg?.hasPassphrase
                  ? "已开启：上传前在本机加密，网盘或服务器只能看到密文。其他设备需填写相同的加密密码。"
                  : "可选：设置加密密码后，上传的内容只有知道密码的设备能解开。密码忘记将无法找回。"}
              </div>
            </div>
          </div>
          <div className="nb-path-input-group">
            <input
              type="password"
              className="nb-input"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={cfg?.hasPassphrase ? "输入新密码以更换" : "设置加密密码（至少 6 位）"}
              autoComplete="new-password"
            />
            <button type="button" className="nb-btn-secondary" disabled={busy !== null || !passphrase} onClick={() => savePassphrase(false)}>
              保存密码
            </button>
            {cfg?.hasPassphrase && (
              <button type="button" className="nb-btn-secondary" disabled={busy !== null} onClick={() => savePassphrase(true)}>
                清除
              </button>
            )}
          </div>
        </div>
      )}

      {active && cfg && (
        <div className="nb-settings-card-box">
          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">自动同步</div>
              <div className="nb-settings-sub">启动时、编辑后约半分钟，以及每隔一段时间自动同步</div>
            </div>
            <button
              type="button"
              aria-label="自动同步"
              className={`nb-toggle-switch${cfg.autoSync ? " is-on" : ""}`}
              onClick={() => run("auto", async () => apply(await saveSyncConfig({ autoSync: !cfg.autoSync })))}
            />
          </div>
          {cfg.autoSync && (
            <label className="nb-checkbox-row">
              <span>定时间隔</span>
              <select
                className="nb-input nb-sync-select"
                value={cfg.intervalMinutes}
                onChange={(e) => run("interval", async () => apply(await saveSyncConfig({ intervalMinutes: Number(e.target.value) })))}
              >
                {[1, 5, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} 分钟
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="nb-sync-status">
            <div>
              <div className="nb-settings-label">上次同步：{relativeTime(cfg.lastAt)}</div>
              {cfg.lastError ? (
                <div className="nb-settings-sub nb-sync-error-text">{cfg.lastError}</div>
              ) : report ? (
                <div className="nb-settings-sub">
                  上传 {report.uploaded} · 下载 {report.downloaded}
                  {report.deletedLocal + report.deletedRemote > 0 && ` · 删除 ${report.deletedLocal + report.deletedRemote}`}
                  {report.encrypted && " · 已加密"}
                </div>
              ) : null}
              {report && report.conflicts > 0 && (
                <div className="nb-settings-sub">
                  {report.conflicts} 处冲突，另一份已保存为：{report.conflictTitles.slice(0, 3).join("、")}
                  {report.conflictTitles.length > 3 ? " 等" : ""}
                </div>
              )}
            </div>
            <button type="button" className="nb-btn-primary" disabled={busy !== null || syncing} onClick={syncNow}>
              <RefreshCw size={14} className={syncing ? "nb-spin" : undefined} />
              {syncing ? "正在同步…" : "立即同步"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="nb-sync-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
