import React, { useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CheckSquare,
  ChevronRight,
  Code2,
  Copy,
  Film,
  GitBranch,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Lightbulb,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Sigma,
  Table2,
  Trash2,
  Type,
} from "lucide-react";
import type { Block, BlockType, KeybindingMap } from "../../types/notion";
import {
  formatCompactShortcutBadge,
  resolveActionShortcut,
  resolveColorSwatchShortcut,
} from "./editorKeybindings";
import { BLOCK_COLOR_OPTIONS } from "./editorUtils";

export interface BlockActionMenuProps {
  open: boolean;
  block: Block | null;
  blockIndex: number;
  totalBlocks: number;
  anchorRect: { left: number; top: number };
  keybindings?: KeybindingMap;
  onTurnInto: (blockId: string, nextType: BlockType) => void;
  onChangeColor: (blockId: string, color: string) => void;
  onInsertBelow?: (blockId: string) => void;
  onDuplicate: (blockId: string) => void;
  onMoveUp: (blockId: string) => void;
  onMoveDown: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onClose: () => void;
}

interface TurnIntoOption {
  type: BlockType;
  label: string;
  icon: React.ReactNode;
}

const TURN_INTO_OPTIONS: TurnIntoOption[] = [
  { type: "paragraph", label: "正文", icon: <Type size={13} /> },
  { type: "heading1", label: "标题 1", icon: <Heading1 size={13} /> },
  { type: "heading2", label: "标题 2", icon: <Heading2 size={13} /> },
  { type: "heading3", label: "标题 3", icon: <Heading3 size={13} /> },
  { type: "todo", label: "待办", icon: <CheckSquare size={13} /> },
  { type: "bullet", label: "无序列表", icon: <List size={13} /> },
  { type: "numbered", label: "有序列表", icon: <ListOrdered size={13} /> },
  { type: "toggle", label: "折叠块", icon: <ChevronRight size={13} /> },
  { type: "quote", label: "引用", icon: <Quote size={13} /> },
  { type: "callout", label: "提示框", icon: <Lightbulb size={13} /> },
  { type: "code", label: "代码块", icon: <Code2 size={13} /> },
  { type: "mermaid", label: "Mermaid 图表", icon: <GitBranch size={13} /> },
  { type: "math", label: "数学公式", icon: <Sigma size={13} /> },
  { type: "image", label: "图片", icon: <Image size={13} /> },
  { type: "bookmark", label: "网页书签", icon: <Bookmark size={13} /> },
  { type: "embed", label: "视频嵌入", icon: <Film size={13} /> },
  { type: "table", label: "表格", icon: <Table2 size={13} /> },
  { type: "divider", label: "分割线", icon: <Minus size={13} /> },
];

export const BlockActionMenu: React.FC<BlockActionMenuProps> = ({
  open,
  block,
  blockIndex,
  totalBlocks,
  anchorRect,
  keybindings,
  onTurnInto,
  onChangeColor,
  onInsertBelow,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onDelete,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onClose, open]);

  if (!open || !block) return null;

  const menuWidth = 388;
  const estimatedHeight = 486;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;

  const left = Math.max(
    12,
    Math.min(anchorRect.left, viewportW - menuWidth - 14)
  );
  const top =
    anchorRect.top + estimatedHeight > viewportH - 12
      ? Math.max(12, viewportH - estimatedHeight - 14)
      : Math.max(12, anchorRect.top);

  const currentColor = block.props.color || "default";
  const openMenuShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.openMenu", keybindings)
  );
  const insertBelowShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.insertBelow", keybindings)
  );
  const duplicateShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.duplicate", keybindings)
  );
  const moveUpShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.moveUp", keybindings)
  );
  const moveDownShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.moveDown", keybindings)
  );
  const deleteShortcut = formatCompactShortcutBadge(
    resolveActionShortcut("block.delete", keybindings)
  );

  return (
    <div
      ref={menuRef}
      className="nb-editor-action-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="menu"
      aria-label="块操作菜单"
    >
      <div className="nb-editor-action-section-title is-flex">
        <span>转换为 (Turn into)</span>
        {openMenuShortcut && (
          <kbd className="nb-editor-kbd-badge is-subtle">{openMenuShortcut}</kbd>
        )}
      </div>

      <div className="nb-editor-type-chips">
        {TURN_INTO_OPTIONS.map((opt) => {
          const isCurrent = block.blockType === opt.type;
          const turnShortcut = formatCompactShortcutBadge(
            resolveActionShortcut(`block.turnInto.${opt.type}`, keybindings)
          );
          return (
            <button
              key={opt.type}
              type="button"
              data-turn-into={opt.type}
              title={
                turnShortcut ? `${opt.label} (${turnShortcut})` : opt.label
              }
              className={`nb-editor-type-chip ${isCurrent ? "is-current" : ""}`}
              onClick={() => {
                onTurnInto(block.id, opt.type);
                onClose();
              }}
            >
              <span className="nb-editor-type-chip-main">
                {opt.icon}
                <span className="nb-editor-type-chip-label">{opt.label}</span>
              </span>
              {turnShortcut && (
                <kbd className="nb-editor-kbd-badge">{turnShortcut}</kbd>
              )}
            </button>
          );
        })}
      </div>

      <div className="nb-editor-action-divider" />

      <div className="nb-editor-action-section-title">颜色与背景</div>
      <div className="nb-editor-color-swatches">
        {BLOCK_COLOR_OPTIONS.map((swatch) => {
          const isSelected =
            currentColor === swatch.value ||
            (swatch.value === "amber" &&
              (currentColor === "yellow" || currentColor === "orange"));
          const colorShortcut = formatCompactShortcutBadge(
            resolveColorSwatchShortcut(swatch.value, keybindings)
          );
          return (
            <button
              key={swatch.value}
              type="button"
              data-swatch={swatch.value}
              title={
                colorShortcut
                  ? `${swatch.label} (${colorShortcut})`
                  : swatch.label
              }
              className={`nb-editor-color-swatch ${
                isSelected ? "is-selected" : ""
              } ${colorShortcut ? "has-shortcut" : ""}`}
              onClick={() => {
                onChangeColor(block.id, swatch.value);
                onClose();
              }}
            >
              <span>{swatch.shortLabel}</span>
              {colorShortcut && (
                <kbd className="nb-editor-swatch-kbd">{colorShortcut}</kbd>
              )}
            </button>
          );
        })}
      </div>

      <div className="nb-editor-action-divider" />

      {onInsertBelow && (
        <button
          type="button"
          className="nb-editor-action-row"
          onClick={() => {
            onInsertBelow(block.id);
            onClose();
          }}
        >
          <span className="nb-editor-action-row-left">
            <Plus size={14} />
            <span>在下方插入新块</span>
          </span>
          {insertBelowShortcut && (
            <kbd className="nb-editor-kbd-badge">{insertBelowShortcut}</kbd>
          )}
        </button>
      )}

      <button
        type="button"
        className="nb-editor-action-row"
        onClick={() => {
          onDuplicate(block.id);
          onClose();
        }}
      >
        <span className="nb-editor-action-row-left">
          <Copy size={14} />
          <span>创建副本</span>
        </span>
        {duplicateShortcut && (
          <kbd className="nb-editor-kbd-badge">{duplicateShortcut}</kbd>
        )}
      </button>

      <button
        type="button"
        className="nb-editor-action-row"
        disabled={blockIndex <= 0}
        onClick={() => {
          onMoveUp(block.id);
          onClose();
        }}
      >
        <span className="nb-editor-action-row-left">
          <ArrowUp size={14} />
          <span>上移一块</span>
        </span>
        {moveUpShortcut && (
          <kbd className="nb-editor-kbd-badge">{moveUpShortcut}</kbd>
        )}
      </button>

      <button
        type="button"
        className="nb-editor-action-row"
        disabled={blockIndex >= totalBlocks - 1}
        onClick={() => {
          onMoveDown(block.id);
          onClose();
        }}
      >
        <span className="nb-editor-action-row-left">
          <ArrowDown size={14} />
          <span>下移一块</span>
        </span>
        {moveDownShortcut && (
          <kbd className="nb-editor-kbd-badge">{moveDownShortcut}</kbd>
        )}
      </button>

      <div className="nb-editor-action-divider" />

      <button
        type="button"
        className="nb-editor-action-row is-danger"
        onClick={() => {
          onDelete(block.id);
          onClose();
        }}
      >
        <span className="nb-editor-action-row-left">
          <Trash2 size={14} />
          <span>删除此块</span>
        </span>
        {deleteShortcut && (
          <kbd className="nb-editor-kbd-badge">{deleteShortcut}</kbd>
        )}
      </button>
    </div>
  );
};
