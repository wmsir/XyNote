import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { getSettings, isTauriRuntime, setSetting } from "./client";

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const KEY = "ai.config";
const EVENT = "xynote:ai-config";

export const AI_PRESETS: { id: string; name: string; baseUrl: string; model: string; keyHint: string }[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyHint: "在 platform.deepseek.com 创建" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", keyHint: "在阿里云百炼控制台创建" },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", keyHint: "在 platform.moonshot.cn 创建" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", keyHint: "在 open.bigmodel.cn 创建" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyHint: "在 platform.openai.com 创建" },
  { id: "ollama", name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5", keyHint: "本地运行，无需密钥" },
];

export const EMPTY_AI: AiConfig = { enabled: false, baseUrl: "", apiKey: "", model: "" };

export async function loadAiConfig(): Promise<AiConfig> {
  try {
    const raw = (await getSettings())[KEY];
    if (raw) return { ...EMPTY_AI, ...(JSON.parse(raw) as Partial<AiConfig>) };
  } catch {
    /* ignore */
  }
  return { ...EMPTY_AI };
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  await setSetting(KEY, JSON.stringify(cfg));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: cfg }));
}

export async function aiComplete(system: string, prompt: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("AI 写作助手只在桌面版里可用");
  return invoke<string>("ai_complete", { system, prompt });
}

/** 编辑器里是否显示 AI 按钮 */
export function useAiEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    loadAiConfig()
      .then((c) => alive && setOn(c.enabled && !!c.model))
      .catch(() => {});
    const onChange = (e: Event) => {
      const c = (e as CustomEvent<AiConfig>).detail;
      setOn(!!c?.enabled && !!c?.model);
    };
    window.addEventListener(EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);
  return on;
}

const SYSTEM =
  "你是一位中文写作助手。只输出处理后的正文，不要解释、不要加引号、不要加「好的」之类的开场白。保持原文的语言和语气，除非要求翻译。";

export interface AiAction {
  id: string;
  label: string;
  /** 结果默认是替换选中文字还是接在后面 */
  mode: "replace" | "append";
  build: (text: string, context: string) => string;
}

export const AI_ACTIONS: AiAction[] = [
  {
    id: "continue",
    label: "续写",
    mode: "append",
    build: (t, ctx) => `根据上下文，接着下面这段话往下写一到两段，风格保持一致。\n\n上下文：\n${ctx}\n\n要续写的段落：\n${t}`,
  },
  { id: "polish", label: "润色改写", mode: "replace", build: (t) => `把下面这段话改得更通顺、简洁，意思不变：\n\n${t}` },
  { id: "shorter", label: "缩短", mode: "replace", build: (t) => `把下面这段话压缩到原来一半左右的长度，保留要点：\n\n${t}` },
  { id: "summary", label: "总结要点", mode: "append", build: (t) => `用 3 到 5 条简短的要点总结下面的内容，每条一行，以「- 」开头：\n\n${t}` },
  { id: "to-en", label: "翻译成英文", mode: "replace", build: (t) => `Translate into natural English. Output only the translation:\n\n${t}` },
  { id: "to-zh", label: "翻译成中文", mode: "replace", build: (t) => `翻译成自然流畅的简体中文，只输出译文：\n\n${t}` },
  { id: "fix", label: "改错别字和语病", mode: "replace", build: (t) => `只修正下面这段话里的错别字、标点和语病，其他不要改：\n\n${t}` },
];

export function runAiAction(action: AiAction, text: string, context: string): Promise<string> {
  return aiComplete(SYSTEM, action.build(text, context.slice(-2000)));
}

export function runAiCustom(instruction: string, text: string): Promise<string> {
  return aiComplete(SYSTEM, `${instruction}\n\n${text}`);
}
