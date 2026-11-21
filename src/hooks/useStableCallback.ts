import { useCallback, useRef } from "react";

/**
 * 返回一个引用永远不变的函数，调用时总是执行最新一次渲染传入的 fn。
 *
 * 用在「传给大量子组件的事件回调」上：回调内部依赖的状态（例如整份块列表）
 * 每次输入都会变，直接传 useCallback 的结果会让所有子组件跟着重新渲染；
 * 包一层之后子组件拿到的引用不变，配合 React.memo 只重渲染真正变化的那一行。
 *
 * 只能在事件处理和副作用里调用，不要在渲染过程中调用。
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  // 渲染时就更新：子组件的副作用先于父组件执行，放进 effect 里会让子组件拿到上一次的函数
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
