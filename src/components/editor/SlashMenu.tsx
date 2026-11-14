import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  CheckSquare,
  ChevronRight,
  Code2,
  FilePlus2,
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
  Quote,
  Sigma,
  Table2,
  Type,
} from "lucide-react";
import type { KeybindingMap } from "../../types/notion";
import {
  formatCompactShortcutBadge,
  resolveActionShortcut,
} from "./editorKeybindings";
import {
  SLASH_COMMAND_ITEMS,
  SlashActionType,
  SlashCommandItem,
} from "./editorUtils";

export interface SlashMenuProps {
  open: boolean;
  query: string;
  anchorPoint: { x: number; y: number; bottom: number };
  canCreateSubpage: boolean;
  keybindings?: KeybindingMap;
  onSelect: (actionType: SlashActionType) => void;
  onClose: () => void;
}

function renderSlashIcon(type: SlashActionType): React.ReactNode {
  switch (type) {
    case "paragraph":
      return <Type size={16} />;
    case "heading1":
      return <Heading1 size={16} />;
    case "heading2":
      return <Heading2 size={16} />;
    case "heading3":
      return <Heading3 size={16} />;
    case "todo":
      return <CheckSquare size={16} />;
    case "bullet":
      return <List size={16} />;
    case "numbered":
      return <ListOrdered size={16} />;
    case "toggle":
      return <ChevronRight size={16} />;
    case "quote":
      return <Quote size={16} />;
    case "callout":
      return <Lightbulb size={16} />;
    case "code":
      return <Code2 size={16} />;
    case "mermaid":
      return <GitBranch size={16} />;
    case "table":
      return <Table2 size={16} />;
    case "divider":
      return <Minus size={16} />;
    case "math":
      return <Sigma size={16} />;
    case "image":
      return <Image size={16} />;
    case "bookmark":
      return <Bookmark size={16} />;
    case "embed":
      return <Film size={16} />;
    case "subpage":
      return <FilePlus2 size={16} />;
  }
}

export const SlashMenu: React.FC<SlashMenuProps> = ({
  open,
  query,
  anchorPoint,
  canCreateSubpage,
  keybindings,
  onSelect,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filteredItems = useMemo<SlashCommandItem[]>(() => {
    const available = canCreateSubpage
      ? SLASH_COMMAND_ITEMS
      : SLASH_COMMAND_ITEMS.filter((item) => item.type !== "subpage");

    const q = query.trim().toLowerCase();
    if (!q) return available;

    return available.filter((item) => {
      if (item.label.toLowerCase().includes(q)) return true;
      if (item.description.toLowerCase().includes(q)) return true;
      if (item.type.toLowerCase().includes(q)) return true;
      return item.keywords.some((kw) => kw.toLowerCase().includes(q));
    });
  }, [canCreateSubpage, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const activeBtn = itemRefs.current[selectedIndex];
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (filteredItems.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(
          (prev) => (prev - 1 + filteredItems.length) % filteredItems.length
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const chosen = filteredItems[selectedIndex] ?? filteredItems[0];
        if (chosen) {
          onSelect(chosen.type);
        }
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [filteredItems, onClose, onSelect, open, selectedIndex]);

  if (!open) return null;

  const menuWidth = 340;
  const estimatedHeight = 356;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;

  const left = Math.max(12, Math.min(anchorPoint.x, viewportW - menuWidth - 16));
  const placeAbove =
    anchorPoint.bottom + estimatedHeight > viewportH - 12 &&
    anchorPoint.y > estimatedHeight + 16;
  const top = placeAbove
    ? Math.max(12, anchorPoint.y - estimatedHeight - 6)
    : Math.min(anchorPoint.bottom + 6, viewportH - 140);

  let runningIdx = 0;
  const groupedSections: Array<{
    group: string;
    entries: Array<{ item: SlashCommandItem; flatIndex: number }>;
  }> = [];

  for (const item of filteredItems) {
    let sec = groupedSections.find((g) => g.group === item.group);
    if (!sec) {
      sec = { group: item.group, entries: [] };
      groupedSections.push(sec);
    }
    sec.entries.push({ item, flatIndex: runningIdx++ });
  }

  return (
    <div
      ref={menuRef}
      className="nb-editor-floating-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="listbox"
      aria-label="斜杠块命令菜单"
    >
      <div className="nb-editor-menu-header">
        <span>{query ? `筛选命令: /${query}` : "基础块与页面命令"}</span>
        <span>↑↓ 选择 · ↵ 确认</span>
      </div>

      <div className="nb-editor-menu-scroll">
        {groupedSections.length === 0 ? (
          <div className="nb-editor-menu-empty">
            未找到匹配「{query}」的块命令，按 Esc 关闭
          </div>
        ) : (
          groupedSections.map((section) => (
            <div key={section.group}>
              <div className="nb-editor-menu-group-label">{section.group}</div>
              {section.entries.map(({ item, flatIndex }) => {
                const isActive = flatIndex === selectedIndex;
                const kbShortcut =
                  item.type !== "subpage"
                    ? formatCompactShortcutBadge(
                        resolveActionShortcut(
                          `block.turnInto.${item.type}`,
                          keybindings
                        )
                      )
                    : "";
                return (
                  <button
                    key={item.type}
                    ref={(el) => {
                      itemRefs.current[flatIndex] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`nb-editor-menu-item ${isActive ? "is-active" : ""}`}
                    onMouseEnter={() => setSelectedIndex(flatIndex)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect(item.type);
                    }}
                  >
                    <span className="nb-editor-menu-item-icon">
                      {renderSlashIcon(item.type)}
                    </span>
                    <span className="nb-editor-menu-item-body">
                      <span className="nb-editor-menu-item-title">
                        {item.label}
                      </span>
                      <span className="nb-editor-menu-item-desc">
                        {item.description}
                      </span>
                    </span>
                    {(item.shortcut || kbShortcut) && (
                      <span className="nb-editor-menu-badges">
                        {item.shortcut && (
                          <span className="nb-editor-menu-shortcut">
                            {item.shortcut}
                          </span>
                        )}
                        {kbShortcut && (
                          <kbd className="nb-editor-kbd-badge">{kbShortcut}</kbd>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
