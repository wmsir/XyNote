import React, { useEffect, useRef, useState } from "react";
import {
  Database,
  FileText,
  FolderOpen,
  LayoutTemplate,
  PanelLeftOpen,
  Search,
} from "lucide-react";

export interface FreshStartProps {
  /** 用输入的标题新建页面（空标题 = 无标题） */
  onCreateDoc: (title: string) => void;
  onCreateDatabase: () => void;
  onOpenTemplates: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onShowWorkspace: () => void;
  onOpenSearch: () => void;
}

/**
 * 全新窗口的起始页：像一张还没落笔的空白页。
 * 只有输入标题并回车（或选一个动作）才会真正创建记录，不会留下空页面。
 */
export const FreshStart: React.FC<FreshStartProps> = ({
  onCreateDoc,
  onCreateDatabase,
  onOpenTemplates,
  onOpenFile,
  onOpenFolder,
  onShowWorkspace,
  onOpenSearch,
}) => {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  const start = () => {
    if (busy) return;
    setBusy(true);
    onCreateDoc(title.trim());
  };

  const actions: { icon: React.ReactNode; label: string; hint?: string; run: () => void }[] = [
    { icon: <FileText size={15} />, label: "空白页面", hint: "Enter", run: start },
    { icon: <Database size={15} />, label: "数据库", run: onCreateDatabase },
    { icon: <LayoutTemplate size={15} />, label: "从模板开始", run: onOpenTemplates },
    { icon: <FolderOpen size={15} />, label: "打开文件…", hint: "Ctrl+O", run: onOpenFile },
    { icon: <FolderOpen size={15} />, label: "打开文件夹…", run: onOpenFolder },
    { icon: <Search size={15} />, label: "搜索已有页面", hint: "Ctrl+K", run: onOpenSearch },
    { icon: <PanelLeftOpen size={15} />, label: "显示工作区", run: onShowWorkspace },
  ];

  return (
    <div className="nb-fresh">
      <div className="nb-fresh-sheet">
        <input
          ref={inputRef}
          className="nb-fresh-title"
          placeholder="无标题"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start();
            }
          }}
          aria-label="新页面标题"
        />
        <p className="nb-fresh-lead">
          {title.trim()
            ? "按回车创建这个页面，开始写正文。"
            : "这是一个新窗口。写下标题按回车就开始，或者从下面选一种方式。"}
        </p>
        <ul className="nb-fresh-actions">
          {actions.map((a) => (
            <li key={a.label}>
              <button type="button" className="nb-fresh-action" onClick={a.run} disabled={busy && a.run === start}>
                <span className="nb-fresh-action-icon">{a.icon}</span>
                <span className="nb-fresh-action-label">{a.label}</span>
                {a.hint && <kbd className="nb-fresh-action-kbd" data-i18n-skip="">{a.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
