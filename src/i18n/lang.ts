/**
 * 界面语言：中文（默认）/ English / 跟随系统。
 * 选择保存在本机（localStorage），切换后立即生效。
 */
export type UiLang = "zh" | "en";
export type UiLangPref = UiLang | "system";

const KEY = "xynote.uiLang";
export const UI_LANG_EVENT = "xynote:ui-lang-changed";

export function getUiLangPref(): UiLangPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en" || v === "system") return v;
  } catch {
    /* 存储不可用 */
  }
  return "system";
}

export function resolveUiLang(pref: UiLangPref = getUiLangPref()): UiLang {
  if (pref !== "system") return pref;
  const sys = (typeof navigator !== "undefined" ? navigator.language : "zh") || "zh";
  return sys.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setUiLangPref(pref: UiLangPref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 存储不可用 */
  }
  window.dispatchEvent(new CustomEvent(UI_LANG_EVENT, { detail: resolveUiLang(pref) }));
}
