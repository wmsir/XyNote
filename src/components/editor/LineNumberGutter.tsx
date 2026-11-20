import React, { type RefObject } from "react";
import { useWrappedLineHeights } from "../../utils/useWrappedLineHeights";

interface LineNumberGutterProps {
  /** 对应的 textarea；本组件要放在 textarea 之后渲染，靠 CSS order 显示在左侧 */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  wrap: boolean;
  className: string;
  lineClassName: string;
  gutterRef?: RefObject<HTMLDivElement | null>;
}

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
  return (
    <div ref={gutterRef} className={className} aria-hidden="true" style={{ order: -1 }}>
      {Array.from({ length: count }, (_, idx) => (
        <div
          key={idx}
          className={lineClassName}
          style={heights ? { height: heights[idx] } : undefined}
        >
          {idx + 1}
        </div>
      ))}
    </div>
  );
};
