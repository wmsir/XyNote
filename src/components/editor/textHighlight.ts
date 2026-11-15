/**
 * 文本编辑器的轻量语法高亮：逐行扫描，跨行只记住「块注释 / 多行字符串」状态。
 * 不追求完整语法分析，目标是常见配置文件和代码看起来清楚、打字不卡。
 */

export interface LineState {
  /** 正在块注释里：结束符 */
  blockEnd: string | null;
  /** 正在多行字符串里：结束符 */
  strEnd: string | null;
}

export const INITIAL_STATE: LineState = { blockEnd: null, strEnd: null };

type Mode = "code" | "markup" | "ini" | "log" | "plain";

export interface LangDef {
  id: string;
  label: string;
  mode: Mode;
  line?: string[];
  block?: [string, string][];
  /** 单行字符串引号 */
  quotes?: string[];
  /** 可以跨行的字符串：[开始, 结束] */
  multiStr?: [string, string][];
  keywords?: Set<string>;
  /** 关键字不区分大小写（SQL、批处理） */
  ci?: boolean;
  /** `key:` / `"key":` 形式的键 */
  keys?: "yaml" | "json";
}

const kw = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = kw(`abstract as async await break case catch class const continue debugger default delete do else enum export extends
  false finally for from function get if implements import in instanceof interface let new null of package private protected public
  readonly return set static super switch this throw true try type typeof undefined var void while with yield keyof declare namespace`);
const C_KW = kw(`auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false
  float for friend goto if inline int long namespace new nullptr operator private protected public register return short signed sizeof
  static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while include define
  ifdef ifndef endif pragma`);
const JAVA_KW = kw(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final
  finally float for if implements import instanceof int interface long native new null package private protected public return short
  static super switch synchronized this throw throws transient true false try void volatile while var record val fun object when is
  override open data sealed internal lateinit companion suspend`);
const CS_KW = kw(`abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else
  enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new
  null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static
  string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await`);
const GO_KW = kw(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range
  return select struct switch type var true false nil string int int64 float64 bool error byte rune`);
const RS_KW = kw(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub
  ref return self Self static struct super trait true type unsafe use where while Some None Ok Err String Vec Option Result`);
const PY_KW = kw(`and as assert async await break class continue def del elif else except False finally for from global if import in
  is lambda None nonlocal not or pass raise return True try while with yield self print`);
const RB_KW = kw(`alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo
  rescue retry return self super then true undef unless until when while yield require puts`);
const PHP_KW = kw(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif
  empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements
  include instanceof interface isset list match namespace new or print private protected public require return static switch throw
  trait try unset use var while yield true false null`);
const SH_KW = kw(`if then else elif fi case esac for while until do done in function return local export echo exit set unset source
  alias cd read shift trap`);
const PS_KW = kw(`begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function
  if in param process return switch throw trap try until using var while`);
const SQL_KW = kw(`select from where and or not insert into values update set delete create table alter drop index view primary key
  foreign references join left right inner outer full on group by order having limit offset as distinct union all case when then else
  end null is in like between exists default unique check constraint database schema grant revoke commit rollback begin transaction
  int integer bigint varchar char text date datetime timestamp decimal numeric float double boolean auto_increment if replace with`);
const BAT_KW = kw(`echo set if else goto call exit for in do not exist defined errorlevel setlocal endlocal pause rem shift cd pushd
  popd start title cls copy move del mkdir rmdir`);
const LUA_KW = kw(`and break do else elseif end false for function goto if in local nil not or repeat return then true until while`);
const CSS_KW = kw(`important media import charset font-face keyframes supports from to`);
const JSON_KW = kw(`true false null`);
const YAML_KW = kw(`true false null yes no on off`);
const SWIFT_KW = kw(`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private
  protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in
  repeat return switch where while as catch false is nil super self Self throw throws true try async await`);
const DART_KW = kw(`abstract as assert async await break case catch class const continue covariant default deferred do dynamic else
  enum export extends extension external factory false final finally for get if implements import in interface is late library mixin
  new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with
  yield`);

const C_LIKE = { mode: "code" as const, line: ["//"], block: [["/*", "*/"]] as [string, string][], quotes: ['"', "'"] };
const HASH = { mode: "code" as const, line: ["#"], quotes: ['"', "'"] };

export const LANGS: Record<string, LangDef> = {
  plain: { id: "plain", label: "纯文本", mode: "plain" },
  log: { id: "log", label: "日志", mode: "log" },
  js: { id: "js", label: "JavaScript", ...C_LIKE, quotes: ['"', "'"], multiStr: [["`", "`"]], keywords: JS_KW },
  ts: { id: "ts", label: "TypeScript", ...C_LIKE, quotes: ['"', "'"], multiStr: [["`", "`"]], keywords: JS_KW },
  json: { id: "json", label: "JSON", ...C_LIKE, quotes: ['"'], keywords: JSON_KW, keys: "json" },
  c: { id: "c", label: "C / C++", ...C_LIKE, keywords: C_KW },
  java: { id: "java", label: "Java / Kotlin", ...C_LIKE, multiStr: [['"""', '"""']], keywords: JAVA_KW },
  cs: { id: "cs", label: "C#", ...C_LIKE, keywords: CS_KW },
  go: { id: "go", label: "Go", ...C_LIKE, multiStr: [["`", "`"]], keywords: GO_KW },
  rs: { id: "rs", label: "Rust", ...C_LIKE, quotes: ['"'], keywords: RS_KW },
  swift: { id: "swift", label: "Swift", ...C_LIKE, multiStr: [['"""', '"""']], keywords: SWIFT_KW },
  dart: { id: "dart", label: "Dart", ...C_LIKE, multiStr: [["'''", "'''"], ['"""', '"""']], keywords: DART_KW },
  php: { id: "php", label: "PHP", ...C_LIKE, line: ["//", "#"], keywords: PHP_KW },
  css: { id: "css", label: "CSS", mode: "code", line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], keywords: CSS_KW },
  py: { id: "py", label: "Python", ...HASH, multiStr: [['"""', '"""'], ["'''", "'''"]], keywords: PY_KW },
  rb: { id: "rb", label: "Ruby", ...HASH, keywords: RB_KW },
  sh: { id: "sh", label: "Shell", ...HASH, keywords: SH_KW },
  ps1: { id: "ps1", label: "PowerShell", ...HASH, block: [["<#", "#>"]], keywords: PS_KW, ci: true },
  yaml: { id: "yaml", label: "YAML", ...HASH, keywords: YAML_KW, keys: "yaml" },
  toml: { id: "toml", label: "TOML", mode: "ini", line: ["#"], quotes: ['"', "'"], multiStr: [['"""', '"""']], keywords: JSON_KW },
  ini: { id: "ini", label: "INI / 配置", mode: "ini", line: [";", "#"], quotes: ['"'] },
  sql: { id: "sql", label: "SQL", mode: "code", line: ["--", "#"], block: [["/*", "*/"]], quotes: ["'", '"', "`"], keywords: SQL_KW, ci: true },
  bat: { id: "bat", label: "批处理", mode: "code", line: ["::", "rem ", "REM ", "@rem ", "@REM "], quotes: ['"'], keywords: BAT_KW, ci: true },
  lua: { id: "lua", label: "Lua", mode: "code", line: ["--"], block: [["--[[", "]]"]], quotes: ['"', "'"], keywords: LUA_KW },
  r: { id: "r", label: "R", ...HASH, keywords: kw("if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library") },
  markup: { id: "markup", label: "HTML / XML", mode: "markup" },
};

const EXT_LANG: Record<string, string> = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", vue: "markup", svelte: "markup",
  json: "json", jsonc: "json", json5: "json",
  c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", m: "c",
  java: "java", kt: "java", kts: "java", scala: "java", groovy: "java", gradle: "java",
  cs: "cs", go: "go", rs: "rs", swift: "swift", dart: "dart", php: "php",
  css: "css", scss: "css", sass: "css", less: "css",
  py: "py", pyw: "py", rb: "rb", pl: "sh", sh: "sh", bash: "sh", zsh: "sh", env: "sh", dockerfile: "sh", makefile: "sh",
  cmake: "sh", gitignore: "sh", editorconfig: "ini",
  ps1: "ps1", psm1: "ps1", yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini", config: "markup", properties: "ini",
  sql: "sql", bat: "bat", cmd: "bat", lua: "lua", r: "r",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", xaml: "markup", csproj: "markup", plist: "markup",
  log: "log",
};

export function langForFileName(fileName: string): LangDef {
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower.endsWith(".env")) return LANGS.sh;
  const ext = lower.includes(".") ? lower.split(".").pop() ?? "" : "";
  return LANGS[EXT_LANG[ext] ?? "plain"] ?? LANGS.plain;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(cls: string, text: string): string {
  return text ? `<span class="tk-${cls}">${esc(text)}</span>` : "";
}

const NUM_RE = /^(0x[0-9a-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)[a-z]*/i;
const IDENT_RE = /^[A-Za-z_$@][\w$]*/;
const IDENT_DASH_RE = /^[A-Za-z_$@][\w$-]*/;

function startsAt(line: string, i: number, token: string, ci = false): boolean {
  if (!ci) return line.startsWith(token, i);
  return line.slice(i, i + token.length).toLowerCase() === token.toLowerCase();
}

/** 普通代码 / 配置：返回这一行的 HTML 与下一行的状态 */
function highlightCode(line: string, state: LineState, lang: LangDef): [string, LineState] {
  let out = "";
  let i = 0;
  let { blockEnd, strEnd } = state;
  const lineStartTrim = line.length - line.trimStart().length;

  while (i < line.length) {
    if (blockEnd) {
      const j = line.indexOf(blockEnd, i);
      if (j < 0) {
        out += span("c", line.slice(i));
        return [out, { blockEnd, strEnd: null }];
      }
      out += span("c", line.slice(i, j + blockEnd.length));
      i = j + blockEnd.length;
      blockEnd = null;
      continue;
    }
    if (strEnd) {
      const j = line.indexOf(strEnd, i);
      if (j < 0) {
        out += span("s", line.slice(i));
        return [out, { blockEnd: null, strEnd }];
      }
      out += span("s", line.slice(i, j + strEnd.length));
      i = j + strEnd.length;
      strEnd = null;
      continue;
    }
    const ch = line[i];

    // 行注释（批处理的 rem 只在行首算）
    const lc = lang.line?.find((t) => startsAt(line, i, t, lang.ci) && (lang.id !== "bat" || i === lineStartTrim));
    if (lc && !(lc === "#" && lang.id === "css")) {
      out += span("c", line.slice(i));
      return [out, { blockEnd: null, strEnd: null }];
    }
    const bc = lang.block?.find(([open]) => line.startsWith(open, i));
    if (bc) {
      out += span("c", bc[0]);
      i += bc[0].length;
      blockEnd = bc[1];
      continue;
    }
    const ms = lang.multiStr?.find(([open]) => line.startsWith(open, i));
    if (ms) {
      out += span("s", ms[0]);
      i += ms[0].length;
      strEnd = ms[1];
      continue;
    }
    if (lang.quotes?.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const text = line.slice(i, Math.min(j + 1, line.length));
      const rest = line.slice(i + text.length);
      out += span(lang.keys === "json" && /^\s*:/.test(rest) ? "a" : "s", text);
      i += text.length;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[\w$]/.test(line[i - 1] ?? "")) {
      const m = line.slice(i).match(NUM_RE);
      if (m) {
        out += span("n", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = line.slice(i).match(lang.id === "css" || lang.keys === "yaml" || lang.mode === "ini" ? IDENT_DASH_RE : IDENT_RE);
      const word = m ? m[0] : ch;
      const rest = line.slice(i + word.length);
      const bare = word.replace(/^@/, "");
      const isKw = lang.keywords?.has(lang.ci ? bare.toLowerCase() : bare);
      if (lang.keys === "yaml" && i === lineStartTrim && /^\s*:(\s|$)/.test(rest)) {
        out += span("a", word);
      } else if (isKw) {
        out += span("k", word);
      } else if (/^\s*\(/.test(rest) && lang.mode === "code") {
        out += span("f", word);
      } else {
        out += esc(word);
      }
      i += word.length;
      continue;
    }
    if (lang.keys === "yaml" && ch === "-" && i === lineStartTrim) {
      out += span("p", ch);
      i += 1;
      continue;
    }
    out += esc(ch);
    i += 1;
  }
  return [out, { blockEnd, strEnd }];
}

function highlightIni(line: string, state: LineState, lang: LangDef): [string, LineState] {
  if (state.strEnd) return highlightCode(line, state, lang);
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  if (lang.line?.some((t) => trimmed.startsWith(t))) return [indent + span("c", trimmed), INITIAL_STATE];
  if (/^\[.*\]\s*$/.test(trimmed)) return [indent + span("k", trimmed), INITIAL_STATE];
  const m = trimmed.match(/^([^=:\s][^=:]*?)(\s*[=:])(.*)$/);
  if (m) {
    const [html, next] = highlightCode(m[3], INITIAL_STATE, { ...lang, mode: "code" });
    return [indent + span("a", m[1]) + esc(m[2]) + html, next];
  }
  return highlightCode(line, state, { ...lang, mode: "code" });
}

function highlightMarkup(line: string, state: LineState): [string, LineState] {
  let out = "";
  let i = 0;
  let { blockEnd } = state;
  // strEnd 在这里表示「在标签里」，值为 ">"
  let inTag = state.strEnd === ">";
  while (i < line.length) {
    if (blockEnd) {
      const j = line.indexOf(blockEnd, i);
      if (j < 0) return [out + span("c", line.slice(i)), { blockEnd, strEnd: null }];
      out += span("c", line.slice(i, j + blockEnd.length));
      i = j + blockEnd.length;
      blockEnd = null;
      continue;
    }
    if (inTag) {
      const ch = line[i];
      if (ch === ">" || line.startsWith("/>", i)) {
        const t = ch === ">" ? ">" : "/>";
        out += span("t", t);
        i += t.length;
        inTag = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const j = line.indexOf(ch, i + 1);
        const text = j < 0 ? line.slice(i) : line.slice(i, j + 1);
        out += span("s", text);
        i += text.length;
        continue;
      }
      const m = line.slice(i).match(/^[\w:@.#-]+/);
      if (m) {
        out += span("a", m[0]);
        i += m[0].length;
        continue;
      }
      out += esc(ch);
      i += 1;
      continue;
    }
    if (line.startsWith("<!--", i)) {
      out += span("c", "<!--");
      i += 4;
      blockEnd = "-->";
      continue;
    }
    if (line.startsWith("<![CDATA[", i)) {
      const j = line.indexOf("]]>", i);
      const text = j < 0 ? line.slice(i) : line.slice(i, j + 3);
      out += span("s", text);
      i += text.length;
      continue;
    }
    const tag = line.slice(i).match(/^<\/?[\w:?!.-]+/);
    if (tag) {
      out += span("t", tag[0]);
      i += tag[0].length;
      inTag = true;
      continue;
    }
    const ent = line.slice(i).match(/^&[#\w]+;/);
    if (ent) {
      out += span("n", ent[0]);
      i += ent[0].length;
      continue;
    }
    out += esc(line[i]);
    i += 1;
  }
  return [out, { blockEnd, strEnd: inTag ? ">" : null }];
}

const LOG_LEVEL = /\b(FATAL|ERROR|ERR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/;
const LOG_TIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/;

function highlightLog(line: string): string {
  let html = esc(line);
  const t = line.match(LOG_TIME);
  if (t) html = html.replace(esc(t[0]), span("n", t[0]));
  const lv = line.match(LOG_LEVEL);
  if (lv) {
    const level = lv[1];
    const cls = /FATAL|ERROR|ERR|SEVERE/.test(level) ? "err" : /WARN/.test(level) ? "warn" : /INFO/.test(level) ? "k" : "c";
    html = html.replace(new RegExp(`\\b${level}\\b`), span(cls, level));
  }
  return html;
}

/** 高亮一行；纯文本直接转义 */
export function highlightLine(line: string, state: LineState, lang: LangDef): [string, LineState] {
  switch (lang.mode) {
    case "plain":
      return [esc(line), INITIAL_STATE];
    case "log":
      return [highlightLog(line), INITIAL_STATE];
    case "markup":
      return highlightMarkup(line, state);
    case "ini":
      return highlightIni(line, state, lang);
    default:
      return highlightCode(line, state, lang);
  }
}

/**
 * 带缓存的整篇高亮：同样的「状态 + 行内容」直接复用，打字时只重算改动的行。
 * 返回每行的 HTML。
 */
export class Highlighter {
  private cache = new Map<string, [string, LineState]>();
  lang: LangDef;
  constructor(lang: LangDef) {
    this.lang = lang;
  }

  run(lines: string[]): string[] {
    if (this.cache.size > 40000) this.cache.clear();
    const out: string[] = new Array(lines.length);
    let state = INITIAL_STATE;
    for (let i = 0; i < lines.length; i++) {
      const key = `${state.blockEnd ?? ""}\u0001${state.strEnd ?? ""}\u0001${lines[i]}`;
      let hit = this.cache.get(key);
      if (!hit) {
        hit = highlightLine(lines[i], state, this.lang);
        this.cache.set(key, hit);
      }
      out[i] = hit[0];
      state = hit[1];
    }
    return out;
  }
}
