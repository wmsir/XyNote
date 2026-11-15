import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  FolderOpen,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WholeWord,
  WrapText,
  X,
} from "lucide-react";
import {
  conflictModifiedMs,
  LINE_ENDINGS,
  openTextFile,
  saveTextFile,
  TEXT_ENCODINGS,
  textErrorText,
  type LineEnding,
  type TextEncoding,
  type TextFileDocument,
} from "../../api/textfile";
import { Highlighter, langForFileName } from "./textHighlight";
import "./textEditor.css";

export interface TextEditorProps {
  doc: TextFileDocument;
  onNotify: (msg: string, ms?: number) => void;
  onRevealInExplorer: (path: string) => void;
  /** 保存状态变化，供顶栏显示 */
  onSavingChange?: (saving: boolean) => void;
}

type SaveState = "saved" | "dirty" | "saving" | "error";

/** 超过这个大小用「大文件模式」：不高亮、不自动换行，保证打字不卡 */
const RICH_MAX_CHARS = 600_000;
const RICH_MAX_LINES = 12_000;
const AUTOSAVE_MS = 800;
const MAX_MATCHES = 10_000;

const LS_WRAP = "xynote.textEditor.wrap";
const LS_FONT = "xynote.textEditor.fontSize";
const LS_AUTOSAVE = "xynote.textEditor.autoSave";

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLs(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存储不可用时忽略 */
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 根据文件里已有的缩进决定 Tab 键插入什么 */
function detectIndent(text: string): string {
  let tabs = 0;
  let two = 0;
  let four = 0;
  const lines = text.split("\n", 2000);
  for (const l of lines) {
    if (l.startsWith("\t")) tabs++;
    else if (/^ {4}\S/.test(l)) four++;
    else if (/^ {2}\S/.test(l)) two++;
  }
  if (tabs > two + four) return "\t";
  if (two > four) return "  ";
  return "    ";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface FindState {
  open: boolean;
  replace: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

/** 在 textarea 里用 insertText 替换选区，保留撤销记录 */
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string, selectStart?: number, selectEnd?: number) {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = document.execCommand("insertText", false, text);
  if (!ok) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selectStart !== undefined) ta.setSelectionRange(selectStart, selectEnd ?? selectStart);
}

export function TextEditor({ doc: initialDoc, onNotify, onRevealInExplorer, onSavingChange }: TextEditorProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [content, setContent] = useState(initialDoc.content);
  const [encoding, setEncoding] = useState<TextEncoding>(initialDoc.encoding);
  const [lineEnding, setLineEnding] = useState<LineEnding>(initialDoc.lineEnding);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState(false);
  const [decodeWarning, setDecodeWarning] = useState(initialDoc.hadErrors);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const [fontSize, setFontSize] = useState(() => {
    const v = Number(readLs(LS_FONT));
    return v >= 10 && v <= 32 ? v : 14;
  });
  const lang = useMemo(() => langForFileName(doc.fileName), [doc.fileName]);
  const [wrap, setWrap] = useState(() => {
    const v = readLs(LS_WRAP);
    if (v === "1") return true;
    if (v === "0") return false;
    // 没设置过：文章类文本自动换行，代码不换行
    return lang.mode === "plain" || lang.mode === "log";
  });
  const [autoSave, setAutoSave] = useState(() => readLs(LS_AUTOSAVE) !== "0");
  const [find, setFind] = useState<FindState>({
    open: false,
    replace: false,
    query: "",
    replacement: "",
    caseSensitive: false,
    regex: false,
    wholeWord: false,
  });
  const [current, setCurrent] = useState<{ start: number; end: number } | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");
  const [menu, setMenu] = useState<"encoding" | "eol" | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const highlighterRef = useRef(new Highlighter(lang));
  if (highlighterRef.current.lang !== lang) highlighterRef.current = new Highlighter(lang);

  // 保存用的最新值（定时器 / 卸载时读取）
  const latest = useRef({ content, encoding, lineEnding, modifiedMs: initialDoc.modifiedMs, path: initialDoc.filePath, dirty: false });
  latest.current.content = content;
  latest.current.encoding = encoding;
  latest.current.lineEnding = lineEnding;
  latest.current.path = doc.filePath;
  const timerRef = useRef<number | null>(null);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  const lines = useMemo(() => content.split("\n"), [content]);
  const rich = content.length <= RICH_MAX_CHARS && lines.length <= RICH_MAX_LINES;
  const effectiveWrap = rich && wrap;
  const html = useMemo(() => (rich ? highlighterRef.current.run(lines) : []), [rich, lines, lang]);
  const indentUnit = useMemo(() => detectIndent(initialDoc.content), [initialDoc.content]);
  const gutterCh = Math.max(3, String(lines.length).length) + 1;

  useEffect(() => {
    onSavingChange?.(saveState === "saving");
  }, [saveState, onSavingChange]);

  /* ---------------- 保存 ---------------- */

  const doSave = useCallback(
    (force = false): Promise<void> => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const run = async () => {
        const snap = { ...latest.current };
        if (!snap.dirty && !force) return;
        setSaveState("saving");
        try {
          const res = await saveTextFile(snap.path, snap.content, snap.encoding, snap.lineEnding, force ? null : snap.modifiedMs);
          latest.current.modifiedMs = res.modifiedMs;
          // 保存期间又改了：保持「未保存」，等下一次
          const changedMeanwhile = latest.current.content !== snap.content;
          latest.current.dirty = changedMeanwhile;
          setSaveState(changedMeanwhile ? "dirty" : "saved");
          setConflict(false);
          setDoc((d) => ({ ...d, size: res.size, modifiedMs: res.modifiedMs, encoding: snap.encoding, lineEnding: snap.lineEnding }));
        } catch (err) {
          if (conflictModifiedMs(err) !== null) {
            setConflict(true);
            setSaveState("dirty");
            return;
          }
          setSaveState("error");
          onNotify(`保存失败：${textErrorText(err)}`, 4200);
        }
      };
      const p = saveChain.current.then(run, run);
      saveChain.current = p;
      return p;
    },
    [onNotify]
  );

  const markDirty = useCallback(() => {
    latest.current.dirty = true;
    setSaveState("dirty");
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (autoSave && !decodeWarning && !conflict) {
      timerRef.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    }
  }, [autoSave, decodeWarning, conflict, doSave]);

  // 切换文件 / 关闭编辑器时把没写入的内容存下来
  useEffect(() => {
    const ref = latest;
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      const snap = ref.current;
      if (snap.dirty) {
        void saveTextFile(snap.path, snap.content, snap.encoding, snap.lineEnding, snap.modifiedMs).catch(() => {});
      }
    };
  }, []);

  /* ---------------- 重新载入 / 外部修改 ---------------- */

  const reload = useCallback(
    async (enc?: TextEncoding) => {
      try {
        const fresh = await openTextFile(latest.current.path, enc);
        latest.current.modifiedMs = fresh.modifiedMs;
        latest.current.dirty = false;
        setDoc(fresh);
        setContent(fresh.content);
        setEncoding(fresh.encoding);
        setLineEnding(fresh.lineEnding);
        setDecodeWarning(fresh.hadErrors);
        setSaveState("saved");
        setConflict(false);
        return true;
      } catch (err) {
        onNotify(`无法读取文件：${textErrorText(err)}`, 4200);
        return false;
      }
    },
    [onNotify]
  );

  useEffect(() => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const onChanged = (e: Event) => {
      const paths = (e as CustomEvent<string[]>).detail ?? [];
      if (!paths.some((p) => norm(p) === norm(latest.current.path))) return;
      void saveChain.current.then(async () => {
        let disk: TextFileDocument;
        try {
          disk = await openTextFile(latest.current.path, latest.current.encoding);
        } catch {
          return;
        }
        if (disk.modifiedMs === latest.current.modifiedMs) return;
        if (latest.current.dirty) {
          setConflict(true);
          return;
        }
        await reload(latest.current.encoding);
        onNotify(`已载入「${disk.fileName}」在别处的修改`);
      });
    };
    window.addEventListener("xynote:fs-changed", onChanged);
    return () => window.removeEventListener("xynote:fs-changed", onChanged);
  }, [reload, onNotify]);

  /* ---------------- 光标与滚动 ---------------- */

  const updateCursor = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const lastNl = before.lastIndexOf("\n");
    let line = 1;
    for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++;
    setCursor({ line, col: pos - lastNl, sel: Math.abs(ta.selectionEnd - ta.selectionStart) });
  }, []);

  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  /** 把第 line 行（0 起）第 col 列滚动到可见区域 */
  const revealPosition = useCallback(
    (line: number, col: number, center = false) => {
      const ta = taRef.current;
      if (!ta) return;
      if (!rich) {
        const lh = fontSize * 1.6;
        const top = line * lh;
        if (center || top < ta.scrollTop || top + lh > ta.scrollTop + ta.clientHeight) {
          ta.scrollTop = Math.max(0, top - (center ? ta.clientHeight / 2 : ta.clientHeight - lh * 2));
        }
        return;
      }
      const sc = scrollRef.current;
      const el = linesRef.current?.children[line] as HTMLElement | undefined;
      if (!sc || !el) return;
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (center) {
        sc.scrollTop = Math.max(0, top - sc.clientHeight / 2);
      } else if (top < sc.scrollTop) {
        sc.scrollTop = top - 8;
      } else if (bottom > sc.scrollTop + sc.clientHeight) {
        sc.scrollTop = bottom - sc.clientHeight + 8;
      }
      if (!effectiveWrap) {
        const canvas = measureCanvas.current ?? (measureCanvas.current = document.createElement("canvas"));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.font = getComputedStyle(ta).font;
        const gutterPx = el.offsetLeft + parseFloat(getComputedStyle(el).paddingLeft || "0");
        const x = gutterPx + ctx.measureText((lines[line] ?? "").slice(0, Math.max(0, col)).replace(/\t/g, "    ")).width;
        if (x < sc.scrollLeft + gutterPx) sc.scrollLeft = Math.max(0, x - gutterPx - 40);
        else if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth + 80;
      }
    },
    [rich, fontSize, effectiveWrap, lines]
  );

  const revealCaret = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionEnd;
    const before = ta.value.slice(0, pos);
    let line = 0;
    for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++;
    revealPosition(line, pos - before.lastIndexOf("\n") - 1);
  }, [revealPosition]);

  // 内容渲染完成后再让光标可见（换行后新行要等渲染出来）
  const pendingReveal = useRef(false);
  useLayoutEffect(() => {
    if (pendingReveal.current) {
      pendingReveal.current = false;
      revealCaret();
    }
  });

  /* ---------------- 编辑 ---------------- */

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setCurrent(null);
    markDirty();
    pendingReveal.current = true;
    updateCursor();
  };

  /** 选中的整行范围 */
  const selectedLineRange = (ta: HTMLTextAreaElement) => {
    const v = ta.value;
    const start = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let endPos = ta.selectionEnd;
    if (endPos > ta.selectionStart && v[endPos - 1] === "\n") endPos -= 1;
    let end = v.indexOf("\n", endPos);
    if (end < 0) end = v.length;
    return { start, end };
  };

  const indentLines = (ta: HTMLTextAreaElement, outdent: boolean) => {
    const { start, end } = selectedLineRange(ta);
    const block = ta.value.slice(start, end);
    const next = block
      .split("\n")
      .map((l) => {
        if (!outdent) return indentUnit + l;
        if (l.startsWith("\t")) return l.slice(1);
        const m = l.match(/^ {1,4}/);
        return m ? l.slice(Math.min(m[0].length, indentUnit === "\t" ? 4 : indentUnit.length)) : l;
      })
      .join("\n");
    replaceRange(ta, start, end, next, start, start + next.length);
  };

  const toggleComment = (ta: HTMLTextAreaElement) => {
    const token = lang.line?.[0];
    if (!token) return;
    const { start, end } = selectedLineRange(ta);
    const block = ta.value.slice(start, end).split("\n");
    const allCommented = block.every((l) => !l.trim() || l.trimStart().startsWith(token));
    const next = block
      .map((l) => {
        if (!l.trim()) return l;
        if (allCommented) return l.replace(new RegExp(`^(\\s*)${escapeRegExp(token)} ?`), "$1");
        const indent = l.match(/^\s*/)?.[0] ?? "";
        return `${indent}${token} ${l.slice(indent.length)}`;
      })
      .join("\n");
    replaceRange(ta, start, end, next, start, start + next.length);
  };

  const zoom = (delta: number | null) => {
    setFontSize((s) => {
      const next = delta === null ? 14 : Math.min(32, Math.max(10, s + delta));
      writeLs(LS_FONT, String(next));
      return next;
    });
  };

  /* ---------------- 查找替换 ---------------- */

  const buildRegex = useCallback(
    (global = true): RegExp | null => {
      if (!find.query) return null;
      let src = find.regex ? find.query : escapeRegExp(find.query);
      if (find.wholeWord) src = `\\b${src}\\b`;
      try {
        return new RegExp(src, (global ? "g" : "") + (find.caseSensitive ? "" : "i") + "m");
      } catch {
        return null;
      }
    },
    [find.query, find.regex, find.wholeWord, find.caseSensitive]
  );

  const regexError = useMemo(() => {
    if (!find.query || !find.regex) return null;
    try {
      new RegExp(find.query);
      return null;
    } catch {
      return "正则表达式有误";
    }
  }, [find.query, find.regex]);

  const matches = useMemo(() => {
    if (!find.open) return [] as { start: number; end: number }[];
    const re = buildRegex();
    if (!re) return [];
    const out: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) && out.length < MAX_MATCHES) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }, [find.open, buildRegex, content]);

  const currentIndex = current ? matches.findIndex((m) => m.start === current.start && m.end === current.end) : -1;

  const lineOf = (pos: number) => {
    let line = 0;
    for (let i = 0; i < pos; i++) if (content.charCodeAt(i) === 10) line++;
    return line;
  };

  const goToMatch = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const ta = taRef.current;
    const from = current ? (dir === 1 ? current.end : current.start) : ta ? ta.selectionEnd : 0;
    let target = dir === 1 ? matches.find((m) => m.start >= from) : [...matches].reverse().find((m) => m.end <= from);
    if (!target) target = dir === 1 ? matches[0] : matches[matches.length - 1];
    setCurrent(target);
    if (ta) ta.setSelectionRange(target.start, target.end);
    const line = lineOf(target.start);
    revealPosition(line, target.start - content.lastIndexOf("\n", target.start - 1) - 1, true);
    if (!rich && ta) ta.focus();
  };

  const replaceOne = () => {
    const ta = taRef.current;
    if (!ta || matches.length === 0) return;
    const target = current && currentIndex >= 0 ? current : null;
    if (!target) {
      goToMatch(1);
      return;
    }
    const matched = content.slice(target.start, target.end);
    const re = buildRegex(false);
    const text = re && find.regex ? matched.replace(re, find.replacement) : find.replacement;
    replaceRange(ta, target.start, target.end, text);
    setCurrent(null);
    // 替换后跳到下一个
    window.setTimeout(() => {
      const next = { start: target.start + text.length, end: target.start + text.length };
      setCurrent(null);
      ta.setSelectionRange(next.start, next.end);
      findInputRef.current?.focus();
    }, 0);
  };

  const replaceAll = () => {
    const ta = taRef.current;
    const re = buildRegex();
    if (!ta || !re || matches.length === 0) return;
    const count = matches.length;
    const next = find.regex ? content.replace(re, find.replacement) : content.replace(re, () => find.replacement);
    replaceRange(ta, 0, content.length, next, 0, 0);
    setCurrent(null);
    onNotify(`已替换 ${count} 处`);
  };

  const openFind = (withReplace: boolean) => {
    const ta = taRef.current;
    const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
    setFind((f) => ({
      ...f,
      open: true,
      replace: withReplace || (f.open && f.replace),
      query: sel && !sel.includes("\n") ? sel : f.query,
    }));
    window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  };

  const closeFind = () => {
    setFind((f) => ({ ...f, open: false }));
    const cur = current;
    setCurrent(null);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      if (cur) ta.setSelectionRange(cur.start, cur.end);
    }
  };

  const goToLine = () => {
    const n = Math.max(1, Math.min(lines.length, parseInt(gotoValue, 10) || 1));
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    const ta = taRef.current;
    setGotoOpen(false);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pos, pos);
      updateCursor();
    }
    revealPosition(n - 1, 0, true);
  };

  /* ---------------- 键盘 ---------------- */

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && key === "s") {
      handled();
      void doSave(false);
      return;
    }
    if (mod && key === "f") {
      handled();
      openFind(false);
      return;
    }
    if (mod && key === "h") {
      handled();
      openFind(true);
      return;
    }
    if (mod && key === "g") {
      handled();
      setGotoValue(String(cursor.line));
      setGotoOpen(true);
      return;
    }
    if (e.key === "F3") {
      handled();
      if (!find.open) openFind(false);
      else goToMatch(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && (key === "=" || key === "+")) {
      handled();
      zoom(1);
      return;
    }
    if (mod && key === "-") {
      handled();
      zoom(-1);
      return;
    }
    if (mod && key === "0") {
      handled();
      zoom(null);
      return;
    }
    if (mod && key === "/") {
      handled();
      toggleComment(ta);
      return;
    }
    if (mod && key === "d") {
      // 复制当前行
      handled();
      const { start, end } = selectedLineRange(ta);
      const block = ta.value.slice(start, end);
      const caret = ta.selectionStart + block.length + 1;
      replaceRange(ta, end, end, "\n" + block, caret, caret);
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      handled();
      const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
      if (multi || e.shiftKey) indentLines(ta, e.shiftKey);
      else replaceRange(ta, ta.selectionStart, ta.selectionEnd, indentUnit);
      return;
    }
    if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing) {
      // 自动缩进：新行沿用上一行的缩进
      const v = ta.value;
      const lineStart = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const indent = v.slice(lineStart, ta.selectionStart).match(/^[ \t]*/)?.[0] ?? "";
      if (indent) {
        handled();
        replaceRange(ta, ta.selectionStart, ta.selectionEnd, "\n" + indent);
      }
      return;
    }
    if (e.key === "Escape" && (find.open || gotoOpen)) {
      handled();
      setGotoOpen(false);
      if (find.open) closeFind();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
  };

  /* ---------------- 编码 / 换行 / 选项 ---------------- */

  const reopenWithEncoding = async (enc: TextEncoding) => {
    setMenu(null);
    if (latest.current.dirty && !window.confirm(`用 ${enc} 重新打开会放弃还没保存的修改，继续吗？`)) return;
    if (await reload(enc)) onNotify(`已用 ${enc} 重新打开`);
  };

  const convertEncoding = (enc: TextEncoding) => {
    setMenu(null);
    if (enc === encoding) return;
    setEncoding(enc);
    latest.current.encoding = enc;
    setDecodeWarning(false);
    markDirty();
    onNotify(`保存时将使用 ${enc} 编码`);
  };

  const changeEol = (eol: LineEnding) => {
    setMenu(null);
    if (eol === lineEnding) return;
    setLineEnding(eol);
    latest.current.lineEnding = eol;
    markDirty();
  };

  const toggleWrap = () => {
    setWrap((w) => {
      writeLs(LS_WRAP, w ? "0" : "1");
      return !w;
    });
  };

  const toggleAutoSave = () => {
    setAutoSave((a) => {
      writeLs(LS_AUTOSAVE, a ? "0" : "1");
      if (!a && latest.current.dirty) window.setTimeout(() => void doSave(), 0);
      return !a;
    });
  };

  // 关闭弹出菜单
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".nb-texted-menu-wrap")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // 打开文件后把焦点放进编辑区
  useEffect(() => {
    taRef.current?.focus();
    taRef.current?.setSelectionRange(0, 0);
  }, []);

  /* ---------------- 当前查找结果的高亮层 ---------------- */

  const currentMark = useMemo(() => {
    if (!rich || !current || !find.open) return null;
    const line = lineOf(current.start);
    const lineStart = content.lastIndexOf("\n", current.start - 1) + 1;
    const lineText = lines[line] ?? "";
    const a = current.start - lineStart;
    const b = Math.min(lineText.length, current.end - lineStart);
    return { line, before: lineText.slice(0, a), match: lineText.slice(a, b), after: lineText.slice(b) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rich, current, find.open, content, lines]);

  const [markTop, setMarkTop] = useState(0);
  useLayoutEffect(() => {
    if (!currentMark) return;
    const el = linesRef.current?.children[currentMark.line] as HTMLElement | undefined;
    if (el) setMarkTop(el.offsetTop);
  }, [currentMark, fontSize, effectiveWrap]);

  /* ---------------- 渲染 ---------------- */

  const saveLabel =
    saveState === "saving" ? "保存中…" : saveState === "dirty" ? "未保存" : saveState === "error" ? "保存失败" : "已保存";

  const style = {
    "--te-font-size": `${fontSize}px`,
    "--te-gutter": `${gutterCh}ch`,
  } as React.CSSProperties;

  const textarea = (
    <textarea
      ref={taRef}
      className="nb-texted-input"
      value={content}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onKeyUp={updateCursor}
      onClick={updateCursor}
      onSelect={updateCursor}
      onScroll={(e) => {
        const ta = e.currentTarget;
        if (rich) {
          // 富文本模式下滚动交给外层，textarea 自己不能滚，否则和高亮层错位
          if (ta.scrollTop) ta.scrollTop = 0;
          if (ta.scrollLeft) ta.scrollLeft = 0;
        } else if (gutterRef.current) {
          gutterRef.current.scrollTop = ta.scrollTop;
        }
      }}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      wrap={effectiveWrap ? "soft" : "off"}
      aria-label={`编辑 ${doc.fileName}`}
    />
  );

  return (
    <div className="nb-texted" style={style} onWheel={onWheel}>
      {conflict && (
        <div className="nb-texted-banner is-warn" role="alert">
          <span>「{doc.fileName}」已在其他程序里修改。</span>
          <button type="button" className="nb-btn-secondary" onClick={() => void reload(encoding)}>
            载入磁盘上的版本
          </button>
          <button type="button" className="nb-btn-primary" onClick={() => void doSave(true)}>
            用我的内容覆盖
          </button>
        </div>
      )}
      {decodeWarning && !conflict && (
        <div className="nb-texted-banner" role="status">
          <span>
            文件里有按 {encoding} 无法识别的字符（显示为 �），可能是别的编码。已暂停自动保存，请在右下角「{encoding}」里选择正确的编码重新打开。
          </span>
          <button type="button" className="nb-link-btn" onClick={() => setDecodeWarning(false)}>
            我知道了
          </button>
        </div>
      )}

      {find.open && (
        <div className="nb-texted-find" role="search">
          <div className="nb-texted-find-row">
            <Search size={14} className="nb-texted-find-icon" />
            <input
              ref={findInputRef}
              className={`nb-texted-find-input${regexError ? " is-error" : ""}`}
              value={find.query}
              placeholder="查找"
              aria-label="查找"
              onChange={(e) => {
                setFind((f) => ({ ...f, query: e.target.value }));
                setCurrent(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  goToMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                } else if (e.key === "F3") {
                  e.preventDefault();
                  goToMatch(e.shiftKey ? -1 : 1);
                }
              }}
            />
            <button
              type="button"
              className={`nb-texted-opt${find.caseSensitive ? " is-on" : ""}`}
              title="区分大小写"
              aria-pressed={find.caseSensitive}
              onClick={() => setFind((f) => ({ ...f, caseSensitive: !f.caseSensitive }))}
            >
              <CaseSensitive size={15} />
            </button>
            <button
              type="button"
              className={`nb-texted-opt${find.wholeWord ? " is-on" : ""}`}
              title="全字匹配"
              aria-pressed={find.wholeWord}
              onClick={() => setFind((f) => ({ ...f, wholeWord: !f.wholeWord }))}
            >
              <WholeWord size={15} />
            </button>
            <button
              type="button"
              className={`nb-texted-opt${find.regex ? " is-on" : ""}`}
              title="正则表达式"
              aria-pressed={find.regex}
              onClick={() => setFind((f) => ({ ...f, regex: !f.regex }))}
            >
              <Regex size={15} />
            </button>
            <span className="nb-texted-find-count" aria-live="polite">
              {regexError
                ? regexError
                : !find.query
                  ? ""
                  : matches.length === 0
                    ? "没有结果"
                    : currentIndex >= 0
                      ? `${currentIndex + 1} / ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""}`
                      : `共 ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""} 处`}
            </span>
            <button type="button" className="nb-texted-opt" title="上一个 (Shift+Enter)" onClick={() => goToMatch(-1)}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="nb-texted-opt" title="下一个 (Enter)" onClick={() => goToMatch(1)}>
              <ArrowDown size={15} />
            </button>
            <button
              type="button"
              className={`nb-texted-opt${find.replace ? " is-on" : ""}`}
              title="替换 (Ctrl+H)"
              aria-pressed={find.replace}
              onClick={() => setFind((f) => ({ ...f, replace: !f.replace }))}
            >
              <Replace size={15} />
            </button>
            <button type="button" className="nb-texted-opt" title="关闭 (Esc)" onClick={closeFind}>
              <X size={15} />
            </button>
          </div>
          {find.replace && (
            <div className="nb-texted-find-row">
              <Replace size={14} className="nb-texted-find-icon" />
              <input
                className="nb-texted-find-input"
                value={find.replacement}
                placeholder={find.regex ? "替换为（可用 $1 引用分组）" : "替换为"}
                aria-label="替换为"
                onChange={(e) => setFind((f) => ({ ...f, replacement: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    replaceOne();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeFind();
                  }
                }}
              />
              <button type="button" className="nb-btn-secondary nb-texted-find-btn" disabled={matches.length === 0} onClick={replaceOne}>
                替换
              </button>
              <button type="button" className="nb-btn-secondary nb-texted-find-btn" disabled={matches.length === 0} onClick={replaceAll}>
                <ReplaceAll size={14} /> 全部替换
              </button>
            </div>
          )}
        </div>
      )}

      {gotoOpen && (
        <div className="nb-texted-find nb-texted-goto">
          <div className="nb-texted-find-row">
            <span className="nb-texted-find-label">跳到行</span>
            <input
              className="nb-texted-find-input"
              autoFocus
              inputMode="numeric"
              value={gotoValue}
              aria-label={`跳到行（1–${lines.length}）`}
              onChange={(e) => setGotoValue(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  goToLine();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setGotoOpen(false);
                  taRef.current?.focus();
                }
              }}
            />
            <span className="nb-texted-find-count">共 {lines.length} 行</span>
            <button type="button" className="nb-texted-opt" title="关闭" onClick={() => setGotoOpen(false)}>
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {rich ? (
        <div className="nb-texted-scroll" ref={scrollRef}>
          <div className={`nb-texted-body${effectiveWrap ? " is-wrap" : ""}`}>
            <div className="nb-texted-lines" ref={linesRef} aria-hidden="true">
              {html.map((h, i) => (
                <div
                  key={i}
                  className={`nb-texted-line${i === cursor.line - 1 ? " is-current" : ""}`}
                  data-n={i + 1}
                  dangerouslySetInnerHTML={{ __html: h || "​" }}
                />
              ))}
            </div>
            {currentMark && (
              <div className="nb-texted-line nb-texted-mark" style={{ top: markTop }} aria-hidden="true">
                <span className="nb-texted-ghost">{currentMark.before}</span>
                <mark>{currentMark.match}</mark>
                <span className="nb-texted-ghost">{currentMark.after}</span>
              </div>
            )}
            {textarea}
          </div>
        </div>
      ) : (
        <div className="nb-texted-plain">
          <div className="nb-texted-gutter" ref={gutterRef} aria-hidden="true">
            {lines.map((_, i) => i + 1).join("\n")}
          </div>
          {textarea}
        </div>
      )}

      <div className="nb-texted-status">
        <button type="button" className="nb-texted-status-path" title="在文件管理器中显示" onClick={() => onRevealInExplorer(doc.filePath)}>
          <FolderOpen size={12} />
          <span>{doc.filePath}</span>
        </button>
        <span className="nb-texted-status-spacer" />
        <button
          type="button"
          className="nb-texted-status-item"
          title="跳到行 (Ctrl+G)"
          onClick={() => {
            setGotoValue(String(cursor.line));
            setGotoOpen(true);
          }}
        >
          行 {cursor.line}，列 {cursor.col}
          {cursor.sel > 0 ? `（已选 ${cursor.sel}）` : ""}
        </button>
        <span className="nb-texted-status-item is-static">
          {lines.length} 行 · {formatSize(doc.size)}
        </span>
        <span className="nb-texted-status-item is-static" title={rich ? undefined : "文件较大，已关闭语法高亮和自动换行"}>
          {rich ? lang.label : `${lang.label}（大文件）`}
        </span>
        <div className="nb-texted-menu-wrap">
          <button type="button" className="nb-texted-status-item" onClick={() => setMenu(menu === "eol" ? null : "eol")} title="换行符">
            {lineEnding} <ChevronDown size={11} />
          </button>
          {menu === "eol" && (
            <div className="nb-popover nb-texted-menu" role="menu">
              <div className="nb-menu-label">保存时使用的换行符</div>
              {LINE_ENDINGS.map((o) => (
                <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === lineEnding} className="nb-menu-item" onClick={() => changeEol(o.id)}>
                  <span className="nb-menu-item-left">{o.label}</span>
                  {o.id === lineEnding && <span className="nb-texted-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="nb-texted-menu-wrap">
          <button type="button" className="nb-texted-status-item" onClick={() => setMenu(menu === "encoding" ? null : "encoding")} title="文件编码">
            {encoding} <ChevronDown size={11} />
          </button>
          {menu === "encoding" && (
            <div className="nb-popover nb-texted-menu nb-texted-menu-enc" role="menu">
              <div className="nb-menu-label">用此编码重新打开</div>
              {TEXT_ENCODINGS.map((enc) => (
                <button key={`r-${enc}`} type="button" className="nb-menu-item" onClick={() => void reopenWithEncoding(enc)}>
                  <span className="nb-menu-item-left">{enc}</span>
                  {enc === encoding && <span className="nb-texted-check">当前</span>}
                </button>
              ))}
              <div className="nb-menu-label">转换为此编码保存</div>
              {TEXT_ENCODINGS.filter((e) => e !== encoding).map((enc) => (
                <button key={`c-${enc}`} type="button" className="nb-menu-item" onClick={() => convertEncoding(enc)}>
                  <span className="nb-menu-item-left">{enc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`nb-texted-status-item${effectiveWrap ? " is-on" : ""}`}
          disabled={!rich}
          title={rich ? "自动换行" : "大文件不支持自动换行"}
          aria-pressed={effectiveWrap}
          onClick={toggleWrap}
        >
          <WrapText size={12} /> 换行
        </button>
        <button
          type="button"
          className={`nb-texted-status-item${autoSave ? " is-on" : ""}`}
          title={autoSave ? "停止输入后自动保存；点击改为只用 Ctrl+S 保存" : "只用 Ctrl+S 保存；点击开启自动保存"}
          aria-pressed={autoSave}
          onClick={toggleAutoSave}
        >
          自动保存
        </button>
        <button
          type="button"
          className={`nb-texted-status-item nb-texted-save is-${saveState}`}
          title="保存 (Ctrl+S)"
          onClick={() => void doSave(false)}
        >
          <span className="nb-texted-save-dot" />
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
