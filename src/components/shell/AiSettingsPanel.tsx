import React, { useEffect, useState } from "react";
import { AI_PRESETS, aiComplete, EMPTY_AI, loadAiConfig, saveAiConfig, type AiConfig } from "../../api/ai";
import { isTauriRuntime } from "../../api/client";

interface Props {
  onNotify: (msg: string) => void;
}

/** 偏好设置 → AI 写作助手 */
export const AiSettingsPanel: React.FC<Props> = ({ onNotify }) => {
  const [cfg, setCfg] = useState<AiConfig>(EMPTY_AI);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    loadAiConfig().then(setCfg).catch(() => {});
  }, []);

  const update = (patch: Partial<AiConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setTestMsg(null);
    saveAiConfig(next).catch(() => onNotify("保存设置失败"));
  };

  const presetId = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl)?.id ?? "custom";
  const preset = AI_PRESETS.find((p) => p.id === presetId);

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await aiComplete("你是测试助手。", "只回复两个字：可以");
      setTestMsg({ ok: true, text: `连接成功，模型回复：${res.slice(0, 40)}` });
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">AI 写作助手</h3>
        <p className="nb-settings-desc">
          选中文字后点工具栏上的 ✦，可以续写、润色、总结、翻译。用的是你自己的模型服务和密钥，默认关闭；不打开就不会联网。
        </p>
      </div>

      {!isTauriRuntime() && (
        <div className="nb-settings-card-box">
          <p className="nb-settings-sub" style={{ margin: 0 }}>
            AI 写作助手只在桌面版里可用。
          </p>
        </div>
      )}

      <div className="nb-settings-card-box">
        <div className="nb-settings-toggle-row">
          <div>
            <div className="nb-settings-label">打开 AI 写作助手</div>
            <div className="nb-settings-sub">选中的文字会发给下面填写的模型服务处理</div>
          </div>
          <button
            type="button"
            className={`nb-toggle-switch${cfg.enabled ? " is-on" : ""}`}
            aria-pressed={cfg.enabled}
            aria-label="打开 AI 写作助手"
            onClick={() => update({ enabled: !cfg.enabled })}
          />
        </div>

        <div className="nb-menu-divider" />

        <div className="nb-ai-form">
          <label>
            <span>服务商</span>
            <select
              value={presetId}
              onChange={(e) => {
                const p = AI_PRESETS.find((x) => x.id === e.target.value);
                if (p) update({ baseUrl: p.baseUrl, model: p.model });
                else update({ baseUrl: "", model: "" });
              }}
            >
              {AI_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="custom">其他（兼容 OpenAI 接口）</option>
            </select>
          </label>
          <label>
            <span>接口地址</span>
            <input
              type="url"
              value={cfg.baseUrl}
              placeholder="https://…/v1"
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
              onBlur={() => update({ baseUrl: cfg.baseUrl.trim() })}
            />
          </label>
          <label>
            <span>模型</span>
            <input
              type="text"
              value={cfg.model}
              placeholder="例如 deepseek-chat"
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              onBlur={() => update({ model: cfg.model.trim() })}
            />
          </label>
          <label>
            <span>密钥</span>
            <span className="nb-ai-key">
              <input
                type={showKey ? "text" : "password"}
                value={cfg.apiKey}
                placeholder={preset?.keyHint ?? "API Key"}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                onBlur={() => update({ apiKey: cfg.apiKey.trim() })}
              />
              <button type="button" className="nb-quickset-link" onClick={() => setShowKey((v) => !v)}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </span>
          </label>
          <p className="nb-settings-sub" style={{ margin: 0 }}>
            密钥只保存在这台电脑的数据目录里，不会上传到小悦笔记的服务器。
          </p>
          <div className="nb-ai-test">
            <button type="button" className="nb-btn-secondary" disabled={testing || !cfg.enabled} onClick={() => void test()}>
              {testing ? "正在测试…" : "测试连接"}
            </button>
            {testMsg && <span className={testMsg.ok ? "nb-ai-test-ok" : "nb-ai-test-bad"}>{testMsg.text}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
