import type { Block } from "../../types/notion";

/** 所见即所得编辑器的撤销 / 重做记录：每一步保存整份块列表（块对象不可变，未改动的块共享引用，占用很小） */
export interface BlockHistory {
  past: Block[][];
  future: Block[][];
  /** 正在连续输入的块 id；同一块里停顿不超过 TYPING_GROUP_MS 的输入合并成一步 */
  groupBlockId: string | null;
  groupAt: number;
}

export const MAX_HISTORY_STEPS = 200;
export const TYPING_GROUP_MS = 1000;

export function createBlockHistory(): BlockHistory {
  return { past: [], future: [], groupBlockId: null, groupAt: 0 };
}

export function clearBlockHistory(h: BlockHistory): void {
  h.past = [];
  h.future = [];
  h.groupBlockId = null;
  h.groupAt = 0;
}

/** 两份列表只差在某一块的内容（打字），返回那块的 id；结构有变化返回 null */
export function singleContentEdit(prev: Block[], next: Block[]): string | null {
  if (prev.length !== next.length) return null;
  let changed: string | null = null;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (a.id !== b.id || a.blockType !== b.blockType) return null;
    if (a.content === b.content) {
      // 只有 sortOrder / updatedAt 之类变化，不算编辑
      if (a.props === b.props) continue;
      return null;
    }
    if (changed !== null) return null;
    changed = a.id;
  }
  return changed;
}

/** 记录一次修改：prev 是修改前的列表 */
export function recordBlockChange(
  h: BlockHistory,
  prev: Block[],
  next: Block[],
  now: number = Date.now()
): void {
  if (prev === next) return;
  const typingId = singleContentEdit(prev, next);
  if (typingId !== null && typingId === h.groupBlockId && now - h.groupAt < TYPING_GROUP_MS) {
    // 连续输入：合并进上一步，只延长分组时间
    h.groupAt = now;
    h.future = [];
    return;
  }
  h.past.push(prev);
  if (h.past.length > MAX_HISTORY_STEPS) h.past.shift();
  h.future = [];
  h.groupBlockId = typingId;
  h.groupAt = now;
}

/** 撤销 / 重做后光标该落到哪一块：目标列表里第一块和当前不同的块 */
export function firstChangedBlockId(current: Block[], target: Block[]): string | null {
  const n = Math.max(current.length, target.length);
  for (let i = 0; i < n; i += 1) {
    if (current[i] !== target[i]) {
      return (target[i] ?? target[target.length - 1])?.id ?? null;
    }
  }
  return null;
}

export function takeUndo(h: BlockHistory, current: Block[]): Block[] | null {
  const prev = h.past.pop();
  if (!prev) return null;
  h.future.push(current);
  h.groupBlockId = null;
  return prev;
}

export function takeRedo(h: BlockHistory, current: Block[]): Block[] | null {
  const next = h.future.pop();
  if (!next) return null;
  h.past.push(current);
  h.groupBlockId = null;
  return next;
}
