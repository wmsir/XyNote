/**
 * 运行平台：决定标题栏怎么画。
 * - Windows / Linux 桌面端：系统标题栏关闭，由界面画出拖动区与最小化、最大化、关闭按钮，颜色跟随主题；
 * - macOS 桌面端：保留系统的红黄绿按钮，叠在界面左上角；
 * - 浏览器预览：普通网页，没有窗口按钮。
 */
import { isTauriRuntime } from "../api/client";

export const IS_TAURI = isTauriRuntime();
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** 界面需要自己画窗口按钮 */
export const DRAWS_WINDOW_CONTROLS = IS_TAURI && !IS_MAC;
/** macOS 红黄绿按钮叠在左上角，需要留出位置 */
export const HAS_MAC_TRAFFIC_LIGHTS = IS_TAURI && IS_MAC;

/** 在 <body> 上标记平台，样式据此调整标题栏留白 */
export function markPlatformOnBody() {
  const cls = document.body.classList;
  if (IS_TAURI) cls.add("is-desktop");
  if (DRAWS_WINDOW_CONTROLS) cls.add("has-window-controls");
  if (HAS_MAC_TRAFFIC_LIGHTS) cls.add("has-traffic-lights");
}
