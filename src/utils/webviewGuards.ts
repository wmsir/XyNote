import { isTauriRuntime } from "../api/client";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "file", "color", "range"].includes(type);
  }
  return false;
}

/**
 * 桌面版里关掉内嵌浏览器自带、对笔记应用有害的行为：
 * - F5 / Ctrl+R / Ctrl+Shift+R 会把整个应用当网页刷新，打开的页面、编辑状态都会丢；
 * - 在非输入区域右键会弹出浏览器菜单（后退、刷新、另存为……）。
 *   输入框、正文和选中文字上的右键菜单保留，方便复制粘贴和拼写检查。
 *
 * 应用自己用到这些键的地方（例如文本编辑器 IDEA 方案里 Ctrl+R 是替换）在更内层先处理，不受影响。
 * 只在桌面正式版生效，开发时仍可刷新。
 */
export function installWebviewGuards(): void {
  if (!isTauriRuntime() || !import.meta.env.PROD) return;

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const isReload =
      key === "f5" ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && key === "r");
    if (isReload) e.preventDefault();
  });

  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    if (isEditableTarget(e.target)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    e.preventDefault();
  });
}
