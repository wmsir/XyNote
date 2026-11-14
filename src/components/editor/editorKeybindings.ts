import type React from "react";
import type { BlockType, KeybindingMap } from "../../types/notion";

/**
 * Canonical default editor keybindings (100% aligned with `frontend-shell` `keybindingRegistry.ts`).
 */
export const DEFAULT_EDITOR_KEYBINDINGS: Readonly<Record<string, string>> = {
  // Turn Into (all 18 block types)
  "block.turnInto.paragraph": "Ctrl+0",
  "block.turnInto.heading1": "Ctrl+1",
  "block.turnInto.heading2": "Ctrl+2",
  "block.turnInto.heading3": "Ctrl+3",
  "block.turnInto.todo": "Ctrl+Alt+4",
  "block.turnInto.bullet": "Ctrl+Shift+]",
  "block.turnInto.numbered": "Ctrl+Shift+[",
  "block.turnInto.toggle": "Ctrl+Alt+7",
  "block.turnInto.code": "Ctrl+Shift+K",
  "block.turnInto.quote": "Ctrl+Shift+Q",
  "block.turnInto.callout": "Ctrl+Alt+C",
  "block.turnInto.mermaid": "Ctrl+Alt+M",
  "block.turnInto.math": "Ctrl+Shift+M",
  "block.turnInto.table": "Ctrl+T",
  "block.turnInto.divider": "Ctrl+Alt+D",
  "block.turnInto.image": "",
  "block.turnInto.bookmark": "",
  "block.turnInto.embed": "",

  // Block Actions & Colors
  "block.openMenu": "Ctrl+.",
  "block.duplicate": "Ctrl+D",
  "block.moveUp": "Alt+ArrowUp",
  "block.moveDown": "Alt+ArrowDown",
  "block.delete": "Ctrl+Shift+Backspace",
  "block.insertBelow": "Ctrl+Enter",
  "block.color.default": "",
  "block.color.gray": "",
  "block.color.brown": "",
  "block.color.yellow": "",
  "block.color.green": "",
  "block.color.blue": "",
  "block.color.purple": "",
  "block.color.red": "",

  // Inline Formatting
  "format.bold": "Ctrl+B",
  "format.italic": "Ctrl+I",
  "format.underline": "Ctrl+U",
  "format.strike": "Alt+Shift+5",
  "format.code": "Ctrl+Shift+`",
  "format.highlight": "Ctrl+Shift+H",

  // Editor View Toggle
  "editor.toggleSource": "Ctrl+/",
};

export const TURN_INTO_ACTION_BLOCK_TYPES: readonly BlockType[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "todo",
  "bullet",
  "numbered",
  "toggle",
  "quote",
  "callout",
  "code",
  "mermaid",
  "math",
  "image",
  "bookmark",
  "embed",
  "table",
  "divider",
];

export const BLOCK_COLOR_ACTION_ENTRIES: ReadonlyArray<{
  actionId: string;
  colorValue: string;
}> = [
  { actionId: "block.color.default", colorValue: "default" },
  { actionId: "block.color.gray", colorValue: "gray" },
  { actionId: "block.color.brown", colorValue: "brown" },
  { actionId: "block.color.yellow", colorValue: "yellow" },
  { actionId: "block.color.amber", colorValue: "amber" },
  { actionId: "block.color.green", colorValue: "green" },
  { actionId: "block.color.blue", colorValue: "blue" },
  { actionId: "block.color.purple", colorValue: "purple" },
  { actionId: "block.color.red", colorValue: "red" },
];

const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "OS",
  "CapsLock",
]);

/**
 * Convert a DOM or React KeyboardEvent into a canonical shortcut string:
 * Modifiers ordered `Ctrl+Alt+Shift+<Key>`, using `e.code` for `Digit0..9`, `KeyA..Z`,
 * `Slash`, `Backslash`, `Comma`, `Period` so shifted combos like `Alt+Shift+5` always produce `Alt+Shift+5`.
 */
export function eventToCanonicalShortcut(
  e: KeyboardEvent | React.KeyboardEvent
): string | null {
  if (MODIFIER_KEYS.has(e.key)) {
    return null;
  }

  const code = e.code || "";
  const rawKey = e.key || "";
  let baseKey = "";

  if (/^Digit[0-9]$/.test(code)) {
    baseKey = code.slice(5);
  } else if (/^Numpad[0-9]$/.test(code)) {
    baseKey = code.slice(6);
  } else if (/^Key[A-Z]$/.test(code)) {
    baseKey = code.slice(3);
  } else if (code === "Slash") {
    baseKey = "/";
  } else if (code === "Backslash") {
    baseKey = "\\";
  } else if (code === "Comma") {
    baseKey = ",";
  } else if (code === "Period") {
    baseKey = ".";
  } else if (code === "Minus") {
    baseKey = "-";
  } else if (code === "Equal") {
    baseKey = "=";
  } else if (code === "BracketLeft") {
    baseKey = "[";
  } else if (code === "BracketRight") {
    baseKey = "]";
  } else if (code === "Semicolon") {
    baseKey = ";";
  } else if (code === "Quote") {
    baseKey = "'";
  } else if (code === "Backquote") {
    baseKey = "`";
  } else if (code === "Space" || rawKey === " ") {
    baseKey = "Space";
  } else if (/^F([1-9]|1[0-2])$/i.test(rawKey)) {
    baseKey = rawKey.toUpperCase();
  } else if (
    rawKey === "ArrowUp" ||
    rawKey === "ArrowDown" ||
    rawKey === "ArrowLeft" ||
    rawKey === "ArrowRight" ||
    rawKey === "Enter" ||
    rawKey === "Backspace" ||
    rawKey === "Delete" ||
    rawKey === "Tab" ||
    rawKey === "Escape" ||
    rawKey === "Home" ||
    rawKey === "End" ||
    rawKey === "PageUp" ||
    rawKey === "PageDown"
  ) {
    baseKey = rawKey;
  } else if (rawKey.length === 1) {
    baseKey = rawKey.toUpperCase();
  } else {
    return null;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  const alt = e.altKey;
  const shift = e.shiftKey;
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(baseKey);
  if (!ctrl && !alt && !isFunctionKey) {
    return null;
  }

  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  parts.push(baseKey);

  return parts.join("+");
}

/**
 * Normalize a configured shortcut string into canonical `Ctrl+Alt+Shift+<Key>` form.
 */
export function normalizeShortcutString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const tokens = trimmed
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";

  let ctrl = false;
  let alt = false;
  let shift = false;
  let mainKey = "";

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (
      lower === "ctrl" ||
      lower === "control" ||
      lower === "cmd" ||
      lower === "meta" ||
      lower === "command"
    ) {
      ctrl = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else if (lower === "shift") {
      shift = true;
    } else if (lower === "up" || lower === "arrowup") {
      mainKey = "ArrowUp";
    } else if (lower === "down" || lower === "arrowdown") {
      mainKey = "ArrowDown";
    } else if (lower === "left" || lower === "arrowleft") {
      mainKey = "ArrowLeft";
    } else if (lower === "right" || lower === "arrowright") {
      mainKey = "ArrowRight";
    } else if (lower === "esc" || lower === "escape") {
      mainKey = "Escape";
    } else if (lower === "backspace") {
      mainKey = "Backspace";
    } else if (lower === "delete" || lower === "del") {
      mainKey = "Delete";
    } else if (lower === "enter" || lower === "return") {
      mainKey = "Enter";
    } else if (lower === "space") {
      mainKey = "Space";
    } else if (lower === "tab") {
      mainKey = "Tab";
    } else if (/^f([1-9]|1[0-2])$/i.test(tok)) {
      mainKey = tok.toUpperCase();
    } else if (tok.length === 1) {
      mainKey = tok.toUpperCase();
    } else {
      mainKey = tok;
    }
  }

  if (!mainKey) return "";
  const out: string[] = [];
  if (ctrl) out.push("Ctrl");
  if (alt) out.push("Alt");
  if (shift) out.push("Shift");
  out.push(mainKey);
  return out.join("+");
}

/**
 * Resolve the effective shortcut string for a given `actionId`, respecting explicit empty string `""` unbinds.
 */
export function resolveActionShortcut(
  actionId: string,
  keybindings?: KeybindingMap
): string {
  if (
    keybindings &&
    Object.prototype.hasOwnProperty.call(keybindings, actionId)
  ) {
    return keybindings[actionId] ?? "";
  }
  return DEFAULT_EDITOR_KEYBINDINGS[actionId] ?? "";
}

/**
 * Resolve the effective shortcut for a block color swatch (`"amber"` maps canonically to `"block.color.yellow"`).
 */
export function resolveColorSwatchShortcut(
  swatchValue: string,
  keybindings?: KeybindingMap
): string {
  if (swatchValue === "amber" || swatchValue === "yellow") {
    const yellow = resolveActionShortcut("block.color.yellow", keybindings);
    if (yellow) return yellow;
    return resolveActionShortcut("block.color.amber", keybindings);
  }
  return resolveActionShortcut(`block.color.${swatchValue}`, keybindings);
}

/**
 * Check whether an already-computed canonical combo matches the configured shortcut for `actionId`.
 */
export function matchesShortcutCombo(
  combo: string | null,
  actionId: string,
  keybindings?: KeybindingMap
): boolean {
  if (!combo) return false;
  const configured = resolveActionShortcut(actionId, keybindings);
  if (!configured) return false;
  return combo === normalizeShortcutString(configured);
}

/**
 * Check whether a KeyboardEvent matches the configured shortcut for `actionId`.
 */
export function matchesActionShortcut(
  e: KeyboardEvent | React.KeyboardEvent,
  actionId: string,
  keybindings?: KeybindingMap
): boolean {
  const configured = resolveActionShortcut(actionId, keybindings);
  if (!configured) return false;
  const combo = eventToCanonicalShortcut(e);
  if (!combo) return false;
  return combo === normalizeShortcutString(configured);
}

/**
 * Format a canonical shortcut into a compact `<kbd>` badge label (`ArrowUp` -> `↑`, `Enter` -> `↵`, `Backspace` -> `⌫`).
 */
export function formatCompactShortcutBadge(shortcut: string): string {
  if (!shortcut) return "";
  return shortcut
    .trim()
    .replace(/ArrowUp/g, "↑")
    .replace(/ArrowDown/g, "↓")
    .replace(/ArrowLeft/g, "←")
    .replace(/ArrowRight/g, "→")
    .replace(/Backspace/g, "⌫")
    .replace(/Enter/g, "↵");
}

/**
 * Format a tooltip label with its active shortcut in parentheses when bound.
 */
export function formatTooltipWithShortcut(
  label: string,
  actionId: string,
  keybindings?: KeybindingMap
): string {
  const shortcut = resolveActionShortcut(actionId, keybindings);
  return shortcut
    ? `${label} (${formatCompactShortcutBadge(shortcut)})`
    : label;
}
