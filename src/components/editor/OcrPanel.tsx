import React, { useState } from "react";
import { Copy, ScanText, TextCursorInput, X } from "lucide-react";

interface Props {
  text: string;
  onInsertAsText: (text: string) => void;
  onClear: () => void;
}

/** 图片下方显示识别出的文字：可复制、插入为正文，或清除 */
export const OcrPanel: React.FC<Props> = ({ text, onInsertAsText, onClear }) => {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  return (
    <div className="nb-ocr" contentEditable={false}>
      <div className="nb-ocr-head">
        <button type="button" className="nb-ocr-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ScanText size={13} />
          <span>图片中的文字</span>
        </button>
        <span className="nb-ocr-actions">
          <button
            type="button"
            title="复制文字"
            aria-label="复制文字"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            <Copy size={13} />
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          <button type="button" title="把文字插入到图片下方" onClick={() => onInsertAsText(text)}>
            <TextCursorInput size={13} />
            <span>插入为正文</span>
          </button>
          <button type="button" title="清除识别结果" aria-label="清除识别结果" onClick={onClear}>
            <X size={13} />
          </button>
        </span>
      </div>
      {open && (
        <pre className="nb-ocr-text" data-i18n-skip="">
          {text}
        </pre>
      )}
    </div>
  );
};
