import React, { useEffect, useState } from "react";
import {
  DEFAULT_QUICK_SHORTCUT,
  displayAccelerator,
  eventToAccelerator,
  getQuickCaptureConfig,
  setQuickCaptureConfig,
  type QuickCaptureConfig,
} from "../../api/quick";
import { IS_MAC } from "../../utils/platform";

interface Props {
  onNotify: (msg: string) => void;
}

/** 偏好设置 → 快速记录与托盘 */
export const QuickCaptureSettingsPanel: React.FC<Props> = ({ onNotify }) => {
  const [cfg, setCfg] = useState<QuickCaptureConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getQuickCaptureConfig()
      .then(setCfg)
      .catch(() => setCfg(null))
      .finally(() => setLoaded(true));
  }, []);

  const save = async (patch: Partial<Pick<QuickCaptureConfig, "shortcut" | "tray" | "closeToTray">>) => {
    if (!cfg) return;
    setBusy(true);
    try {
      const next = await setQuickCaptureConfig({
        shortcut: patch.shortcut ?? cfg.shortcut,
        tray: patch.tray ?? cfg.tray,
        closeToTray: patch.closeToTray ?? cfg.closeToTray,
      });
      setCfg(next);
      if (patch.shortcut !== undefined) {
        onNotify(next.shortcut ? `快速记录快捷键已改为 ${displayAccelerator(next.shortcut, IS_MAC)}` : "已关闭快速记录快捷键");
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err));
      getQuickCaptureConfig().then(setCfg).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">快速记录与托盘</h3>
        <p className="nb-settings-desc">
          在任何程序里按下快捷键，弹出一个小输入框，写一句话回车就存进「收件箱」页面，不用切回小悦笔记。
        </p>
      </div>

      {loaded && !cfg ? (
        <div className="nb-settings-card-box">
          <p className="nb-settings-sub" style={{ margin: 0 }}>
            快速记录和托盘只在桌面版里可用。
          </p>
        </div>
      ) : cfg ? (
        <div className="nb-settings-card-box">
          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">全局快捷键</div>
              <div className="nb-settings-sub">
                {cfg.shortcut
                  ? cfg.shortcutActive
                    ? "随时按下即可弹出快速记录"
                    : "这个组合键没有注册成功，可能被其他程序占用了，换一个试试"
                  : "已关闭"}
              </div>
            </div>
            <div className="nb-quickset-keys">
              <button
                type="button"
                className={`nb-quickset-recorder${recording ? " is-recording" : ""}${
                  cfg.shortcut && !cfg.shortcutActive ? " is-bad" : ""
                }`}
                disabled={busy}
                onClick={() => setRecording(true)}
                onBlur={() => setRecording(false)}
                onKeyDown={(e) => {
                  if (!recording) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") {
                    setRecording(false);
                    return;
                  }
                  const accel = eventToAccelerator(e, IS_MAC);
                  if (!accel) return;
                  setRecording(false);
                  void save({ shortcut: accel });
                }}
                aria-label="录制快捷键"
              >
                <span data-i18n-skip="">
                  {recording ? "请按下组合键…" : cfg.shortcut ? displayAccelerator(cfg.shortcut, IS_MAC) : "未设置"}
                </span>
              </button>
              {cfg.shortcut !== DEFAULT_QUICK_SHORTCUT && (
                <button
                  type="button"
                  className="nb-quickset-link"
                  disabled={busy}
                  onClick={() => void save({ shortcut: DEFAULT_QUICK_SHORTCUT })}
                >
                  恢复默认
                </button>
              )}
              {cfg.shortcut && (
                <button
                  type="button"
                  className="nb-quickset-link"
                  disabled={busy}
                  onClick={() => void save({ shortcut: "" })}
                >
                  关闭
                </button>
              )}
            </div>
          </div>

          <div className="nb-menu-divider" />

          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">在系统托盘显示图标</div>
              <div className="nb-settings-sub">
                {cfg.tray && !cfg.trayAvailable
                  ? "当前桌面环境没有托盘，图标无法显示"
                  : "托盘菜单里可以快速记录、打开今天的每日笔记"}
              </div>
            </div>
            <button
              type="button"
              className={`nb-toggle-switch${cfg.tray ? " is-on" : ""}`}
              aria-pressed={cfg.tray}
              aria-label="在系统托盘显示图标"
              disabled={busy}
              onClick={() => void save({ tray: !cfg.tray, closeToTray: !cfg.tray ? cfg.closeToTray : false })}
            />
          </div>

          <div className="nb-menu-divider" />

          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">关闭主窗口时留在托盘</div>
              <div className="nb-settings-sub">
                点关闭只是隐藏窗口，快捷键继续可用；要彻底退出请用托盘菜单里的「退出小悦笔记」
              </div>
            </div>
            <button
              type="button"
              className={`nb-toggle-switch${cfg.closeToTray ? " is-on" : ""}`}
              aria-pressed={cfg.closeToTray}
              aria-label="关闭主窗口时留在托盘"
              disabled={busy || !cfg.tray || !cfg.trayAvailable}
              onClick={() => void save({ closeToTray: !cfg.closeToTray })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
