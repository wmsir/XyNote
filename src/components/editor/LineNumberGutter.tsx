import React, { useCallback, useLayoutEffect, useRef, type Ref, type RefObject } from "react";
import { useWrappedLineHeights } from "../../utils/useWrappedLineHeights";

interface LineNumberGutterProps {
  /** 对应的 textarea；本组件要放在 textarea 之后渲染，靠 CSS order 显示在左侧 */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  wrap: boolean;
  className: string;
  lineClassName: string;
  gutterRef?: Ref<HTMLDivElement>;
}

/** 单个行号；只有行号或高度变化时才更新，长文档输入时几千个行号不必逐个比对样式 */
const GutterLine = React.memo(function GutterLine({
  n,
  height,
  className,
}: {
  n: number;
  height: number | undefined;
  className: string;
}) {
  return (
    <div className={className} style={height === undefined ? undefined : { height }}>
      {n}
    </div>
  );
});

/** 行号栏：自动换行时，每个行号的高度跟随它那一行实际占用的高度 */
export const LineNumberGutter: React.FC<LineNumberGutterProps> = ({
  textareaRef,
  text,
  wrap,
  className,
  lineClassName,
  gutterRef,
}) => {
  const heights = useWrappedLineHeights(textareaRef, text, true, wrap);
  const count = heights?.length ?? Math.max(1, text.split("\n").length);
  const localRef = useRef<HTMLDivElement | null>(null);
  // 行高重新测量后（比如输入导致折行变化），把行号栏的滚动位置对齐到源码框
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta && localRef.current && localRef.current.scrollTop !== ta.scrollTop) {
      localRef.current.scrollTop = ta.scrollTop;
    }
  });
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el;
      if (typeof gutterRef === "function") gutterRef(el);
      else if (gutterRef) (gutterRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [gutterRef]
  );
  return (
    <div ref={setRefs} className={className} aria-hidden="true" style={{ order: -1 }}>
      {Array.from({ length: count }, (_, idx) => (
        <GutterLine key={idx} n={idx + 1} height={heights ? heights[idx] : undefined} className={lineClassName} />
      ))}
    </div>
  );
};
