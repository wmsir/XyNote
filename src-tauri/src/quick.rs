//! 快速记录小窗、全局快捷键与系统托盘

use crate::db::Database;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const QUICK_LABEL: &str = "quick";
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Alt+N";

pub const SETTING_SHORTCUT: &str = "quickCapture.shortcut";
pub const SETTING_TRAY: &str = "quickCapture.tray";
pub const SETTING_CLOSE_TO_TRAY: &str = "quickCapture.closeToTray";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCaptureConfig {
    /// 全局快捷键，空字符串表示关闭
    pub shortcut: String,
    /// 是否显示托盘图标
    pub tray: bool,
    /// 关闭主窗口时隐藏到托盘，而不是退出
    pub close_to_tray: bool,
    /// 快捷键当前是否注册成功
    pub shortcut_active: bool,
    /// 托盘是否真的创建出来了（部分 Linux 桌面没有托盘）
    pub tray_available: bool,
}

/// 从设置读取；没设置过时用默认值
pub fn read_config(db: &Database) -> (String, bool, bool) {
    let s = db.get_settings().unwrap_or_default();
    let shortcut = s
        .get(SETTING_SHORTCUT)
        .cloned()
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    let tray = s.get(SETTING_TRAY).map(|v| v != "false").unwrap_or(true);
    let close_to_tray = s.get(SETTING_CLOSE_TO_TRAY).map(|v| v == "true").unwrap_or(false);
    (shortcut, tray, close_to_tray)
}

/// 运行时状态：快捷键是否注册成功、托盘是否存在
#[derive(Default)]
pub struct QuickState {
    pub shortcut_active: std::sync::atomic::AtomicBool,
    pub tray_available: std::sync::atomic::AtomicBool,
}

/// 显示主窗口（从托盘或其他实例唤起）
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 打开 / 关闭快速记录小窗
pub fn toggle_quick_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK_LABEL) {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
            return;
        }
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("quick-capture:show", ());
        return;
    }
    let app2 = app.clone();
    // 在异步任务里建窗口，避免在快捷键回调里阻塞事件循环
    tauri::async_runtime::spawn(async move {
        let builder = WebviewWindowBuilder::new(&app2, QUICK_LABEL, WebviewUrl::App("index.html?quick=1".into()))
            .title("快速记录 - 小悦笔记")
            .inner_size(560.0, 188.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center()
            .focused(true);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.shadow(true);
        if let Ok(w) = builder.build() {
            let _ = w.set_focus();
        }
    });
}

/// 按设置注册全局快捷键；返回是否成功
pub fn apply_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state = app.state::<QuickState>();
    state.shortcut_active.store(false, std::sync::atomic::Ordering::SeqCst);
    let accel = accel.trim();
    if accel.is_empty() {
        return Ok(());
    }
    let sc: Shortcut = accel
        .parse()
        .map_err(|e| format!("快捷键「{}」无法识别：{}", accel, e))?;
    gs.on_shortcut(sc, |app, _sc, ev| {
        if ev.state() == ShortcutState::Pressed {
            toggle_quick_window(app);
        }
    })
    .map_err(|e| format!("快捷键「{}」注册失败，可能已被其他程序占用：{}", accel, e))?;
    state.shortcut_active.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// 创建托盘图标与菜单。部分 Linux 桌面缺少托盘库时会失败，失败不影响程序其余部分。
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    if app.tray_by_id("main-tray").is_some() {
        return Ok(());
    }
    let build = || -> tauri::Result<()> {
        let quick = MenuItem::with_id(app, "quick", "快速记录", true, None::<&str>)?;
        let open = MenuItem::with_id(app, "open", "打开小悦笔记", true, None::<&str>)?;
        let daily = MenuItem::with_id(app, "daily", "今天的每日笔记", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "退出小悦笔记", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&quick, &open, &daily, &sep, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main-tray")
            .tooltip("小悦笔记")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, ev| match ev.id().as_ref() {
                "quick" => toggle_quick_window(app),
                "open" => show_main(app),
                "daily" => {
                    show_main(app);
                    let _ = app.emit_to("main", "tray:daily-note", ());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, ev| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = ev
                {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    };
    // Linux 上缺少 appindicator 库时底层可能直接 panic，这里兜住
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(build));
    let ok = matches!(res, Ok(Ok(())));
    app.state::<QuickState>()
        .tray_available
        .store(ok, std::sync::atomic::Ordering::SeqCst);
    match res {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("托盘创建失败：{}", e)),
        Err(_) => Err("当前桌面环境不支持托盘图标".into()),
    }
}

pub fn remove_tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id("main-tray");
    app.state::<QuickState>()
        .tray_available
        .store(false, std::sync::atomic::Ordering::SeqCst);
}

/// 启动时调用：按设置注册快捷键、创建托盘
pub fn init(app: &AppHandle) {
    let Some(db) = app.try_state::<Database>() else {
        return;
    };
    let (shortcut, tray, _) = read_config(&db);
    if let Err(e) = apply_shortcut(app, &shortcut) {
        eprintln!("[XyNote] {}", e);
    }
    if tray {
        if let Err(e) = setup_tray(app) {
            eprintln!("[XyNote] {}", e);
        }
    }
}

pub fn current_config(app: &AppHandle, db: &Database) -> QuickCaptureConfig {
    let (shortcut, tray, close_to_tray) = read_config(db);
    let st = app.state::<QuickState>();
    QuickCaptureConfig {
        shortcut,
        tray,
        close_to_tray,
        shortcut_active: st.shortcut_active.load(std::sync::atomic::Ordering::SeqCst),
        tray_available: st.tray_available.load(std::sync::atomic::Ordering::SeqCst),
    }
}

/// 主窗口关闭时：开了「关闭到托盘」且托盘存在就隐藏；否则把隐藏的快速记录窗一起关掉，让程序正常退出
pub fn on_main_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle();
    let to_tray = app
        .try_state::<Database>()
        .map(|db| read_config(&db).2)
        .unwrap_or(false)
        && app
            .try_state::<QuickState>()
            .map(|s| s.tray_available.load(std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(false);
    if to_tray {
        api.prevent_close();
        let _ = window.hide();
    } else if let Some(q) = app.get_webview_window(QUICK_LABEL) {
        let _ = q.destroy();
    }
}
