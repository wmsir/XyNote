import type { Block } from "../../types/notion";

function sameBody(a: Block, b: Block): boolean {
  if (a.blockType !== b.blockType || a.content !== b.content) return false;
  if (a.props === b.props) return true;
  try {
    return JSON.stringify(a.props) === JSON.stringify(b.props);
  } catch {
    return false;
  }
}

/**
 * 源码模式每次输入都会把整篇 Markdown 重新解析成一组新块（每块都是新的随机 id）。
 * 这里把新块和上一次的块对齐：
 *
 * - 开头、结尾连续相同的块直接复用旧对象（id、创建时间、对象引用都不变）；
 * - 中间改动区域里，位置相同且类型相同的块沿用旧 id 和创建时间，只更新内容。
 *
 * 好处：预览只重绘真正变化的块；保存时块 id 稳定，不会每按一个键就把整页块删掉重建；
 * 历史和反向链接也不会因为 id 变化被反复重算。
 * sortOrder 由调用方随后统一重排。
 */
export function reconcileBlockIds(prev: Block[], next: Block[]): Block[] {
  if (prev.length === 0 || next.length === 0) return next;
  const out = next.slice();
  const minLen = Math.min(prev.length, next.length);

  // 开头完全相同的块
  let head = 0;
  while (head < minLen && sameBody(prev[head], next[head])) {
    out[head] = prev[head];
    head += 1;
  }

  // 结尾完全相同的块（不能和开头重叠）
  let tail = 0;
  while (
    tail < minLen - head &&
    sameBody(prev[prev.length - 1 - tail], next[next.length - 1 - tail])
  ) {
    out[next.length - 1 - tail] = prev[prev.length - 1 - tail];
    tail += 1;
  }

  // 中间改动区：同位置、同类型的块沿用 id
  const prevMidEnd = prev.length - tail;
  const nextMidEnd = next.length - tail;
  for (let i = head; i < nextMidEnd && i < prevMidEnd; i += 1) {
    const old = prev[i];
    const fresh = next[i];
    if (old.blockType !== fresh.blockType) continue;
    out[i] = sameBody(old, fresh)
      ? old
      : { ...fresh, id: old.id, createdAt: old.createdAt };
  }
  return out;
}
