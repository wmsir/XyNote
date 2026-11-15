#!/usr/bin/env python3
"""列出界面上还没有英文翻译的中文文字（对照 src/i18n/en.ts）。用法：python3 scripts/i18n-missing.py"""
import re, json, sys, os, glob
CJK = re.compile(r'[\u3400-\u9fff\uff01-\uff5e\u3000-\u303f]')
HAS_HAN = re.compile(r'[\u3400-\u9fff]')
def unesc(s):
    return s.replace('\\n','\n').replace('\\"','"').replace("\\'","'").replace('\\\\','\\').replace('\\t','\t')
def jsx_norm(t):
    lines=[l.strip() for l in t.split('\n')]
    lines=[l for l in lines if l]
    return ' '.join(lines)
def scan(src):
    out=[]  # (kind, text)
    i=0; n=len(src)
    stack=[]  # template nesting
    def read_string(q,i):
        j=i+1; buf=[]
        while j<n and src[j]!=q:
            if src[j]=='\\': buf.append(src[j:j+2]); j+=2; continue
            if src[j]=='\n' and q!='`': break
            buf.append(src[j]); j+=1
        return ''.join(buf), j+1
    def read_template(i):
        # returns parts (list of strings and None for placeholders), end index
        j=i+1; parts=['']; 
        while j<n:
            c=src[j]
            if c=='\\': parts[-1]+=src[j:j+2]; j+=2; continue
            if c=='`': return parts, j+1
            if c=='$' and j+1<n and src[j+1]=='{':
                # skip balanced braces
                depth=1; k=j+2
                while k<n and depth:
                    ch=src[k]
                    if ch in '"\'':
                        _,k=read_string(ch,k); continue
                    if ch=='`':
                        sub,k=read_template(k); 
                        for p in sub:
                            if p and HAS_HAN.search(p): out.append(('str',unesc(p)))
                        continue
                    if ch=='{': depth+=1
                    elif ch=='}': depth-=1
                    k+=1
                parts.append(None); parts.append(''); j=k; continue
            parts[-1]+=c; j+=1
        return parts, j
    jsx_start=None
    while i<n:
        c=src[i]
        if src.startswith('//',i):
            e=src.find('\n',i); i = n if e<0 else e; continue
        if src.startswith('/*',i):
            e=src.find('*/',i+2); i = n if e<0 else e+2; continue
        if c in '"\'':
            s,i=read_string(c,i)
            if HAS_HAN.search(s): out.append(('str',unesc(s)))
            continue
        if c=='`':
            parts,i=read_template(i)
            if any(p and HAS_HAN.search(p) for p in parts):
                out.append(('tpl',[None if p is None else unesc(p) for p in parts]))
            continue
        if HAS_HAN.search(c):
            # JSX text: expand to boundaries
            a=i
            while a>0 and src[a-1] not in '<>{}': a-=1
            b=i
            while b<n and src[b] not in '<>{}': b+=1
            t=jsx_norm(src[a:b])
            if t: out.append(('jsx',t))
            i=b; continue
        i+=1
    return out

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
SKIP_FILES = {"textHighlight.ts", "iconKeywords.ts", "emojiList.ts", "client.ts"}
# 不是界面文字的内容（示例代码、CSS 插件源码等）
SKIP_PREFIX = ("/*", "//", "flowchart", "gantt", "sequenceDiagram", "stateDiagram", "true checked", "false unchecked", " data-", ")\n", "\n  const")


def keys_in_source():
    out = set()
    for f in glob.glob(os.path.join(ROOT, "**", "*.ts*"), recursive=True):
        if os.sep + "i18n" + os.sep in f or os.path.basename(f) in SKIP_FILES:
            continue
        for kind, t in scan(open(f, encoding="utf-8").read()):
            if kind == "tpl":
                k, idx = "", 0
                for p in t:
                    if p is None:
                        k += "{%d}" % idx
                        idx += 1
                    else:
                        k += p
                t = k
            if t.startswith(SKIP_PREFIX):
                continue
            out.add(t)
    return out


def dict_keys():
    text = open(os.path.join(ROOT, "i18n", "en.ts"), encoding="utf-8").read()
    body = text[text.index("= {") + 2 : text.rindex("};") + 1]
    return json.loads(body)


if __name__ == "__main__":
    have = dict_keys()
    missing = sorted(k for k in keys_in_source() if k not in have)
    for k in missing:
        print(json.dumps(k, ensure_ascii=False))
    print(f"# 缺少英文：{len(missing)} 条", file=sys.stderr)
