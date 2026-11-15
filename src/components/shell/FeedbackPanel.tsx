import React, { useState } from "react";
import { Mail, Send } from "lucide-react";
import { openExternalUrl, syncErrorText } from "../../api/sync";
import { PRO_SUPPORT_EMAIL, submitFeedback, type FeedbackCategory } from "../../api/pro";

export interface FeedbackPanelProps {
  onNotify: (msg: string) => void;
}

const CATEGORIES: { id: FeedbackCategory; label: string; hint: string }[] = [
  { id: "idea", label: "建议", hint: "想要的功能、可以做得更好的地方" },
  { id: "bug", label: "问题", hint: "哪里出错了、怎么操作会出现" },
  { id: "other", label: "其他", hint: "其他想说的" },
];

export function FeedbackPanel({ onNotify }: FeedbackPanelProps) {
  const [category, setCategory] = useState<FeedbackCategory>("idea");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await submitFeedback(category, content, contact);
      setContent("");
      setSent(true);
      onNotify("感谢反馈，我们会尽快处理");
    } catch (e) {
      setError(syncErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const mail = () => {
    const subject = `小悦笔记${CATEGORIES.find((c) => c.id === category)?.label ?? ""}反馈`;
    const body = `${content}\n\n——\n版本：${__APP_VERSION__}${contact ? `\n联系方式：${contact}` : ""}`;
    openExternalUrl(`mailto:${PRO_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch(() =>
      onNotify(`请发邮件到 ${PRO_SUPPORT_EMAIL}`)
    );
  };

  const hint = CATEGORIES.find((c) => c.id === category)?.hint ?? "";
  const tooShort = content.trim().length < 4;

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">意见反馈</h3>
        <p className="nb-settings-desc">
          遇到问题或有想法，都可以直接告诉我们。会附带软件版本和系统，方便排查；不会上传你的笔记内容。
        </p>
      </div>

      <div className="nb-settings-card-box">
        <div className="nb-feedback-cats" role="radiogroup" aria-label="反馈类型">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={category === c.id}
              className={`nb-feedback-cat${category === c.id ? " is-active" : ""}`}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="nb-sync-field">
          <label className="nb-settings-label" htmlFor="fb-content">
            内容
          </label>
          <textarea
            id="fb-content"
            className="nb-input nb-feedback-text"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setSent(false);
            }}
            placeholder={hint}
            maxLength={5000}
            rows={6}
          />
        </div>

        <div className="nb-sync-field">
          <label className="nb-settings-label" htmlFor="fb-contact">
            联系方式（选填）
          </label>
          <input
            id="fb-contact"
            className="nb-input"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="邮箱或微信，方便我们回复你"
          />
          <div className="nb-settings-sub">
            选填。留下联系方式，处理后我们会回复你。
          </div>
        </div>

        {error && (
          <div className="nb-sync-error" role="alert">
            {error}
            <div style={{ marginTop: 6 }}>也可以改用邮件发送。</div>
          </div>
        )}

        <div className="nb-settings-actions-bar">
          <button type="button" className="nb-btn-primary" disabled={busy || tooShort} onClick={submit}>
            <Send size={14} /> {busy ? "正在提交…" : "提交反馈"}
          </button>
          <button type="button" className="nb-btn-secondary" disabled={tooShort} onClick={mail}>
            <Mail size={14} /> 用邮件发送
          </button>
          {sent && <span className="nb-settings-sub">已收到，谢谢！</span>}
        </div>
      </div>
    </div>
  );
}
