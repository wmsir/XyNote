use crate::models::AppError;
use std::path::Path;

/// Normalize a path string into canonical OS display syntax:
/// - On Windows: `C:\foo\bar` (backslashes only, no `\\?\` prefix).
/// - On macOS / Unix: preserves forward slashes `/Users/.../data` and trims trailing `/`.
pub fn normalize_win32_path_str(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    #[cfg(target_os = "windows")]
    {
        let replaced = trimmed.replace('/', "\\");
        let stripped = replaced.strip_prefix(r"\\?\").unwrap_or(&replaced);
        if stripped.len() > 3 {
            stripped.trim_end_matches('\\').to_string()
        } else {
            stripped.to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if trimmed.len() > 1 {
            trimmed.trim_end_matches('/').to_string()
        } else {
            trimmed.to_string()
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_default_dir(dialog: rfd::FileDialog, dir_opt: Option<&str>) -> rfd::FileDialog {
    if let Some(raw) = dir_opt {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            if p.is_dir() {
                return dialog.set_directory(p);
            }
            if let Some(parent) = p.parent().filter(|pp| pp.is_dir()) {
                return dialog.set_directory(parent);
            }
        }
    }
    dialog
}

pub fn ensure_default_extension(path_str: &str, allowed_exts: &[&str], default_ext: &str) -> String {
    let p = Path::new(path_str);
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        if allowed_exts.iter().any(|a| a.eq_ignore_ascii_case(ext)) {
            return path_str.to_string();
        }
    }
    format!("{}.{}", path_str.trim_end_matches('.'), default_ext)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::ptr;

    type HResult = i32;
    type Hwnd = *mut c_void;

    const S_OK: HResult = 0;
    const S_FALSE: HResult = 1;
    const RPC_E_CHANGED_MODE: HResult = 0x80010106u32 as i32;
    const HRESULT_ERROR_CANCELLED: HResult = 0x800704C7u32 as i32;

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const SIGDN_FILESYSPATH: u32 = 0x80058000;

    pub const FOS_OVERWRITEPROMPT: u32 = 0x2;
    pub const FOS_NOCHANGEDIR: u32 = 0x8;
    pub const FOS_PICKFOLDERS: u32 = 0x20;
    pub const FOS_FORCEFILESYSTEM: u32 = 0x40;
    pub const FOS_PATHMUSTEXIST: u32 = 0x800;
    pub const FOS_FILEMUSTEXIST: u32 = 0x1000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Guid {
        pub data1: u32,
        pub data2: u16,
        pub data3: u16,
        pub data4: [u8; 8],
    }

    pub const CLSID_FILE_OPEN_DIALOG: Guid = Guid {
        data1: 0xdc1c5a9c,
        data2: 0xe88a,
        data3: 0x4dde,
        data4: [0xa5, 0xa1, 0x60, 0xf8, 0x2a, 0x20, 0xae, 0xf7],
    };

    pub const CLSID_FILE_SAVE_DIALOG: Guid = Guid {
        data1: 0xc0b4e2f3,
        data2: 0xba21,
        data3: 0x4773,
        data4: [0x8d, 0xba, 0x33, 0x5e, 0xc9, 0x46, 0xeb, 0x8b],
    };

    pub const IID_IFILE_DIALOG: Guid = Guid {
        data1: 0x42f85136,
        data2: 0xdb7e,
        data3: 0x439c,
        data4: [0x85, 0xf1, 0xe4, 0x07, 0x5d, 0x13, 0x5f, 0xc8],
    };

    pub const IID_ISHELL_ITEM: Guid = Guid {
        data1: 0x43826d1e,
        data2: 0xe718,
        data3: 0x42ee,
        data4: [0xbc, 0x55, 0xa1, 0xe2, 0x61, 0xc3, 0x7b, 0xfe],
    };

    #[repr(C)]
    pub struct ComDlgFilterSpec {
        pub psz_name: *const u16,
        pub psz_spec: *const u16,
    }

    #[repr(C)]
    pub struct IShellItem {
        pub lp_vtbl: *const IShellItemVtbl,
    }

    #[repr(C)]
    pub struct IShellItemVtbl {
        pub query_interface:
            unsafe extern "system" fn(*mut IShellItem, *const Guid, *mut *mut c_void) -> HResult,
        pub add_ref: unsafe extern "system" fn(*mut IShellItem) -> u32,
        pub release: unsafe extern "system" fn(*mut IShellItem) -> u32,
        pub bind_to_handler: unsafe extern "system" fn(
            *mut IShellItem,
            *mut c_void,
            *const Guid,
            *const Guid,
            *mut *mut c_void,
        ) -> HResult,
        pub get_parent:
            unsafe extern "system" fn(*mut IShellItem, *mut *mut IShellItem) -> HResult,
        pub get_display_name:
            unsafe extern "system" fn(*mut IShellItem, u32, *mut *mut u16) -> HResult,
        pub get_attributes: unsafe extern "system" fn(*mut IShellItem, u32, *mut u32) -> HResult,
        pub compare:
            unsafe extern "system" fn(*mut IShellItem, *mut IShellItem, u32, *mut i32) -> HResult,
    }

    #[repr(C)]
    pub struct IFileDialog {
        pub lp_vtbl: *const IFileDialogVtbl,
    }

    #[repr(C)]
    pub struct IFileDialogVtbl {
        // IUnknown
        pub query_interface:
            unsafe extern "system" fn(*mut IFileDialog, *const Guid, *mut *mut c_void) -> HResult,
        pub add_ref: unsafe extern "system" fn(*mut IFileDialog) -> u32,
        pub release: unsafe extern "system" fn(*mut IFileDialog) -> u32,
        // IModalWindow
        pub show: unsafe extern "system" fn(*mut IFileDialog, Hwnd) -> HResult,
        // IFileDialog
        pub set_file_types:
            unsafe extern "system" fn(*mut IFileDialog, u32, *const ComDlgFilterSpec) -> HResult,
        pub set_file_type_index: unsafe extern "system" fn(*mut IFileDialog, u32) -> HResult,
        pub get_file_type_index: unsafe extern "system" fn(*mut IFileDialog, *mut u32) -> HResult,
        pub advise:
            unsafe extern "system" fn(*mut IFileDialog, *mut c_void, *mut u32) -> HResult,
        pub unadvise: unsafe extern "system" fn(*mut IFileDialog, u32) -> HResult,
        pub set_options: unsafe extern "system" fn(*mut IFileDialog, u32) -> HResult,
        pub get_options: unsafe extern "system" fn(*mut IFileDialog, *mut u32) -> HResult,
        pub set_default_folder:
            unsafe extern "system" fn(*mut IFileDialog, *mut IShellItem) -> HResult,
        pub set_folder: unsafe extern "system" fn(*mut IFileDialog, *mut IShellItem) -> HResult,
        pub get_folder:
            unsafe extern "system" fn(*mut IFileDialog, *mut *mut IShellItem) -> HResult,
        pub get_current_selection:
            unsafe extern "system" fn(*mut IFileDialog, *mut *mut IShellItem) -> HResult,
        pub set_file_name: unsafe extern "system" fn(*mut IFileDialog, *const u16) -> HResult,
        pub get_file_name:
            unsafe extern "system" fn(*mut IFileDialog, *mut *mut u16) -> HResult,
        pub set_title: unsafe extern "system" fn(*mut IFileDialog, *const u16) -> HResult,
        pub set_ok_button_label:
            unsafe extern "system" fn(*mut IFileDialog, *const u16) -> HResult,
        pub set_file_name_label:
            unsafe extern "system" fn(*mut IFileDialog, *const u16) -> HResult,
        pub get_result:
            unsafe extern "system" fn(*mut IFileDialog, *mut *mut IShellItem) -> HResult,
        pub add_place:
            unsafe extern "system" fn(*mut IFileDialog, *mut IShellItem, i32) -> HResult,
        pub set_default_extension:
            unsafe extern "system" fn(*mut IFileDialog, *const u16) -> HResult,
        pub close: unsafe extern "system" fn(*mut IFileDialog, HResult) -> HResult,
        pub set_client_guid: unsafe extern "system" fn(*mut IFileDialog, *const Guid) -> HResult,
        pub clear_client_data: unsafe extern "system" fn(*mut IFileDialog) -> HResult,
        pub set_filter: unsafe extern "system" fn(*mut IFileDialog, *mut c_void) -> HResult,
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *mut c_void, dw_co_init: u32) -> HResult;
        fn CoUninitialize();
        fn CoCreateInstance(
            rclsid: *const Guid,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> HResult;
        fn CoTaskMemFree(pv: *mut c_void);
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHCreateItemFromParsingName(
            psz_path: *const u16,
            pbc: *mut c_void,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> HResult;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Hwnd;
    }

    struct ComApartmentGuard {
        should_uninit: bool,
    }

    impl ComApartmentGuard {
        fn init_sta() -> Result<Self, AppError> {
            let hr = unsafe {
                CoInitializeEx(
                    ptr::null_mut(),
                    COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
                )
            };
            if hr == S_OK || hr == S_FALSE {
                Ok(Self {
                    should_uninit: true,
                })
            } else if hr == RPC_E_CHANGED_MODE {
                Ok(Self {
                    should_uninit: false,
                })
            } else {
                Err(AppError::Validation(format!(
                    "CoInitializeEx failed: 0x{:08X}",
                    hr as u32
                )))
            }
        }
    }

    impl Drop for ComApartmentGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { CoUninitialize() };
            }
        }
    }

    struct FileDialogGuard(*mut IFileDialog);
    impl Drop for FileDialogGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    ((*(*self.0).lp_vtbl).release)(self.0);
                }
            }
        }
    }

    struct ShellItemGuard(*mut IShellItem);
    impl Drop for ShellItemGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    ((*(*self.0).lp_vtbl).release)(self.0);
                }
            }
        }
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn wide_ptr_to_string(ptr_wide: *mut u16) -> String {
        if ptr_wide.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *ptr_wide.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr_wide, len);
        OsString::from_wide(slice).to_string_lossy().into_owned()
    }

    fn create_shell_item_for_dir(dir_str: &str) -> Option<ShellItemGuard> {
        let norm = normalize_win32_path_str(dir_str);
        if norm.is_empty() {
            return None;
        }
        let candidate = Path::new(&norm);
        let existing_dir: PathBuf = if candidate.is_dir() {
            candidate.to_path_buf()
        } else if let Some(parent) = candidate.parent() {
            if parent.is_dir() {
                parent.to_path_buf()
            } else {
                return None;
            }
        } else {
            return None;
        };

        let clean_str = normalize_win32_path_str(&existing_dir.to_string_lossy());
        let wide = to_wide_null(&clean_str);
        let mut raw_item: *mut c_void = ptr::null_mut();
        let hr = unsafe {
            SHCreateItemFromParsingName(
                wide.as_ptr(),
                ptr::null_mut(),
                &IID_ISHELL_ITEM,
                &mut raw_item,
            )
        };
        if hr >= 0 && !raw_item.is_null() {
            Some(ShellItemGuard(raw_item as *mut IShellItem))
        } else {
            None
        }
    }

    pub struct DialogSpec {
        pub is_save: bool,
        pub pick_folders: bool,
        pub title: Option<String>,
        pub default_dir: Option<String>,
        pub default_filename: Option<String>,
        pub default_ext: Option<String>,
        pub filters: Vec<(String, String)>,
    }

    /// Instantiate and configure an `IFileDialog` COM object. When `show_modal` is false
    /// (used in headless unit tests), validates COM creation & option configuration and returns `Ok(None)`.
    pub fn execute_file_dialog_sta(
        spec: DialogSpec,
        show_modal: bool,
    ) -> Result<Option<String>, AppError> {
        std::thread::spawn(move || {
            let _apt = ComApartmentGuard::init_sta()?;

            let clsid = if spec.is_save {
                &CLSID_FILE_SAVE_DIALOG
            } else {
                &CLSID_FILE_OPEN_DIALOG
            };

            let mut raw_dlg: *mut c_void = ptr::null_mut();
            let hr = unsafe {
                CoCreateInstance(
                    clsid,
                    ptr::null_mut(),
                    CLSCTX_INPROC_SERVER,
                    &IID_IFILE_DIALOG,
                    &mut raw_dlg,
                )
            };
            if hr < 0 || raw_dlg.is_null() {
                return Err(AppError::Validation(format!(
                    "CoCreateInstance(IFileDialog) failed: 0x{:08X}",
                    hr as u32
                )));
            }
            let dlg = FileDialogGuard(raw_dlg as *mut IFileDialog);
            let vtbl = unsafe { &*(*dlg.0).lp_vtbl };

            let mut opts: u32 = 0;
            let _ = unsafe { (vtbl.get_options)(dlg.0, &mut opts) };
            opts |= FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR;
            if spec.pick_folders {
                opts |= FOS_PICKFOLDERS | FOS_PATHMUSTEXIST;
            } else if spec.is_save {
                opts |= FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST;
            } else {
                opts |= FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST;
            }
            let hr_opt = unsafe { (vtbl.set_options)(dlg.0, opts) };
            if hr_opt < 0 {
                return Err(AppError::Validation(format!(
                    "IFileDialog::SetOptions failed: 0x{:08X}",
                    hr_opt as u32
                )));
            }

            if let Some(ref title) = spec.title {
                if !title.trim().is_empty() {
                    let w_title = to_wide_null(title.trim());
                    let _ = unsafe { (vtbl.set_title)(dlg.0, w_title.as_ptr()) };
                }
            }

            if let Some(ref dir) = spec.default_dir {
                if let Some(folder_item) = create_shell_item_for_dir(dir) {
                    let _ = unsafe { (vtbl.set_folder)(dlg.0, folder_item.0) };
                }
            }

            if let Some(ref fname) = spec.default_filename {
                if !fname.trim().is_empty() {
                    let w_fname = to_wide_null(fname.trim());
                    let _ = unsafe { (vtbl.set_file_name)(dlg.0, w_fname.as_ptr()) };
                }
            }

            if let Some(ref ext) = spec.default_ext {
                if !ext.trim().is_empty() {
                    let w_ext = to_wide_null(ext.trim().trim_start_matches('.'));
                    let _ = unsafe { (vtbl.set_default_extension)(dlg.0, w_ext.as_ptr()) };
                }
            }

            // Keep wide filter buffers alive across `SetFileTypes`
            let wide_filters: Vec<(Vec<u16>, Vec<u16>)> = spec
                .filters
                .iter()
                .map(|(n, pat)| (to_wide_null(n), to_wide_null(pat)))
                .collect();
            if !wide_filters.is_empty() && !spec.pick_folders {
                let raw_specs: Vec<ComDlgFilterSpec> = wide_filters
                    .iter()
                    .map(|(wn, wp)| ComDlgFilterSpec {
                        psz_name: wn.as_ptr(),
                        psz_spec: wp.as_ptr(),
                    })
                    .collect();
                let _ = unsafe {
                    (vtbl.set_file_types)(dlg.0, raw_specs.len() as u32, raw_specs.as_ptr())
                };
                let _ = unsafe { (vtbl.set_file_type_index)(dlg.0, 1) };
            }

            if !show_modal {
                return Ok(None);
            }

            let owner = unsafe { GetForegroundWindow() };
            let show_hr = unsafe { (vtbl.show)(dlg.0, owner) };
            if show_hr == HRESULT_ERROR_CANCELLED || show_hr < 0 {
                return Ok(None);
            }

            let mut raw_res_item: *mut IShellItem = ptr::null_mut();
            let res_hr = unsafe { (vtbl.get_result)(dlg.0, &mut raw_res_item) };
            if res_hr < 0 || raw_res_item.is_null() {
                return Ok(None);
            }
            let res_item = ShellItemGuard(raw_res_item);

            let mut psz_path: *mut u16 = ptr::null_mut();
            let name_hr = unsafe {
                ((*(*res_item.0).lp_vtbl).get_display_name)(
                    res_item.0,
                    SIGDN_FILESYSPATH,
                    &mut psz_path,
                )
            };
            if name_hr < 0 || psz_path.is_null() {
                return Ok(None);
            }

            let selected_path = unsafe {
                let s = wide_ptr_to_string(psz_path);
                CoTaskMemFree(psz_path as *mut c_void);
                s
            };

            if selected_path.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(selected_path))
            }
        })
        .join()
        .map_err(|_| AppError::Validation("Win32 COM STA dialog thread panicked".into()))?
    }

    pub fn open_in_explorer(path: &str) -> Result<(), AppError> {
        let norm = normalize_win32_path_str(path);
        if norm.is_empty() {
            return Err(AppError::Validation("Empty path".into()));
        }
        let target = Path::new(&norm);

        let mut cmd = std::process::Command::new("explorer.exe");
        if target.is_file() {
            cmd.raw_arg(format!("/select,\"{}\"", norm));
        } else if target.is_dir() {
            cmd.raw_arg(format!("\"{}\"", norm));
        } else if target.extension().is_none() {
            std::fs::create_dir_all(target)?;
            cmd.raw_arg(format!("\"{}\"", norm));
        } else if let Some(parent) = target.parent().filter(|p| p.exists()) {
            let parent_norm = normalize_win32_path_str(&parent.to_string_lossy());
            cmd.raw_arg(format!("\"{}\"", parent_norm));
        } else {
            return Err(AppError::NotFound(format!("Path does not exist: {}", norm)));
        }

        cmd.spawn()?;
        Ok(())
    }
}

pub fn pick_folder_dialog_sync(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, AppError> {
    #[cfg(target_os = "windows")]
    {
        imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: false,
                pick_folders: true,
                title: Some(
                    title
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| "选择数据存储文件夹".to_string()),
                ),
                default_dir: default_path,
                default_filename: None,
                default_ext: None,
                filters: Vec::new(),
            },
            true,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let title_str = title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "选择数据存储文件夹".to_string());
        let dialog = apply_default_dir(
            rfd::FileDialog::new().set_title(&title_str),
            default_path.as_deref(),
        );
        Ok(dialog
            .pick_folder()
            .map(|p| normalize_win32_path_str(&p.to_string_lossy())))
    }
}

pub fn pick_markdown_file_dialog_sync() -> Result<Option<String>, AppError> {
    #[cfg(target_os = "windows")]
    {
        imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: false,
                pick_folders: false,
                title: Some("打开本地 Markdown 文档".to_string()),
                default_dir: None,
                default_filename: None,
                default_ext: Some("md".to_string()),
                filters: vec![
                    (
                        "Markdown 文档 (*.md;*.markdown;*.txt)".to_string(),
                        "*.md;*.markdown;*.txt".to_string(),
                    ),
                    ("所有文件 (*.*)".to_string(), "*.*".to_string()),
                ],
            },
            true,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let picked = rfd::FileDialog::new()
            .set_title("打开本地 Markdown 文档")
            .add_filter("Markdown 文档", &["md", "markdown", "txt"])
            .pick_file();
        Ok(picked.map(|p| normalize_win32_path_str(&p.to_string_lossy())))
    }
}

pub fn save_markdown_file_dialog_sync(
    default_name: String,
    content: String,
) -> Result<Option<String>, AppError> {
    let clean_name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() {
            "Untitled.md".to_string()
        } else {
            ensure_default_extension(trimmed, &["md", "markdown", "txt"], "md")
        }
    };

    #[cfg(target_os = "windows")]
    {
        let picked = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some("另存为 Markdown 文件".to_string()),
                default_dir: None,
                default_filename: Some(clean_name),
                default_ext: Some("md".to_string()),
                filters: vec![
                    ("Markdown 文档 (*.md)".to_string(), "*.md".to_string()),
                    ("文本文件 (*.txt)".to_string(), "*.txt".to_string()),
                    ("所有文件 (*.*)".to_string(), "*.*".to_string()),
                ],
            },
            true,
        )?;

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let final_path = ensure_default_extension(&raw_path, &["md", "markdown", "txt"], "md");
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let picked = rfd::FileDialog::new()
            .set_title("另存为 Markdown 文件")
            .set_file_name(&clean_name)
            .add_filter("Markdown 文档", &["md", "markdown", "txt"])
            .save_file();

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let raw_str = normalize_win32_path_str(&raw_path.to_string_lossy());
        let final_path = ensure_default_extension(&raw_str, &["md", "markdown", "txt"], "md");
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
}

/// 通用「另存为」：只选路径，不写文件
pub fn pick_save_path_dialog_sync(title: String, default_name: String, ext: String, label: String) -> Result<Option<String>, AppError> {
    let exts = [ext.as_str()];
    let clean_name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() {
            format!("Untitled.{}", ext)
        } else {
            ensure_default_extension(trimmed, &exts, &ext)
        }
    };
    #[cfg(target_os = "windows")]
    {
        let picked = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some(title),
                default_dir: None,
                default_filename: Some(clean_name),
                default_ext: Some(ext.clone()),
                filters: vec![(format!("{} (*.{})", label, ext), format!("*.{}", ext))],
            },
            true,
        )?;
        Ok(picked.map(|p| ensure_default_extension(&p, &exts, &ext)))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let picked = rfd::FileDialog::new().set_title(&title).set_file_name(&clean_name).add_filter(&label, &exts).save_file();
        Ok(picked.map(|p| ensure_default_extension(&normalize_win32_path_str(&p.to_string_lossy()), &exts, &ext)))
    }
}

pub fn pick_save_zip_path_dialog_sync(default_name: String) -> Result<Option<String>, AppError> {
    let clean_name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() {
            "notion-workspace-backup.zip".to_string()
        } else {
            ensure_default_extension(trimmed, &["zip"], "zip")
        }
    };

    #[cfg(target_os = "windows")]
    {
        let picked = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some("整库导出为 Markdown ZIP 备份包".to_string()),
                default_dir: None,
                default_filename: Some(clean_name),
                default_ext: Some("zip".to_string()),
                filters: vec![("ZIP 压缩归档 (*.zip)".to_string(), "*.zip".to_string())],
            },
            true,
        )?;
        Ok(picked.map(|p| ensure_default_extension(&p, &["zip"], "zip")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let picked = rfd::FileDialog::new()
            .set_title("整库导出为 Markdown ZIP 备份包")
            .set_file_name(&clean_name)
            .add_filter("ZIP 压缩归档", &["zip"])
            .save_file();
        Ok(picked.map(|p| {
            let s = normalize_win32_path_str(&p.to_string_lossy());
            ensure_default_extension(&s, &["zip"], "zip")
        }))
    }
}

pub fn open_path_in_explorer_sync(path: &str) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        imp::open_in_explorer(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let norm = normalize_win32_path_str(path);
        if norm.is_empty() {
            return Err(AppError::Validation("Empty path".into()));
        }
        let target = Path::new(&norm);
        if !target.exists() && target.extension().is_none() {
            std::fs::create_dir_all(target)?;
        }

        #[cfg(target_os = "macos")]
        {
            let mut cmd = std::process::Command::new("open");
            if target.is_file() {
                cmd.args(["-R", &norm]);
            } else if target.is_dir() {
                cmd.arg(&norm);
            } else if let Some(parent) = target.parent().filter(|p| p.exists()) {
                cmd.arg(parent);
            } else {
                return Err(AppError::NotFound(format!("Path does not exist: {}", norm)));
            }
            cmd.spawn()?;
            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        {
            let open_target: std::path::PathBuf = if target.is_dir() {
                target.to_path_buf()
            } else if let Some(parent) = target.parent().filter(|p| p.exists()) {
                parent.to_path_buf()
            } else {
                return Err(AppError::NotFound(format!("Path does not exist: {}", norm)));
            };
            std::process::Command::new("xdg-open")
                .arg(open_target)
                .spawn()?;
            Ok(())
        }
    }
}

pub fn pick_style_plugin_file_dialog_sync(
    default_dir: Option<String>,
) -> Result<Option<String>, AppError> {
    #[cfg(target_os = "windows")]
    {
        imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: false,
                pick_folders: false,
                title: Some("导入主题或样式插件 (.css / .json)".to_string()),
                default_dir,
                default_filename: None,
                default_ext: Some("css".to_string()),
                filters: vec![
                    (
                        "Style Plugins (*.css;*.json)".to_string(),
                        "*.css;*.json;*.xynote-theme.json;*.notion-theme.json".to_string(),
                    ),
                    ("CSS 样式片段 (*.css)".to_string(), "*.css".to_string()),
                    (
                        "XyNote 主题包 (*.xynote-theme.json;*.json)".to_string(),
                        "*.xynote-theme.json;*.notion-theme.json;*.json".to_string(),
                    ),
                    ("所有文件 (*.*)".to_string(), "*.*".to_string()),
                ],
            },
            true,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let dialog = apply_default_dir(
            rfd::FileDialog::new()
                .set_title("导入主题或样式插件 (.css / .json)")
                .add_filter("主题或样式插件", &["css", "json"]),
            default_dir.as_deref(),
        );
        Ok(dialog
            .pick_file()
            .map(|p| normalize_win32_path_str(&p.to_string_lossy())))
    }
}

pub fn save_style_plugin_file_dialog_sync(
    default_dir: Option<String>,
    default_name: String,
    is_theme: bool,
    content: String,
) -> Result<Option<String>, AppError> {
    let clean_name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() {
            if is_theme {
                "custom-theme.notion-theme.json".to_string()
            } else {
                "custom-snippet.css".to_string()
            }
        } else if is_theme {
            if trimmed.to_ascii_lowercase().ends_with(".json") {
                trimmed.to_string()
            } else {
                format!("{}.notion-theme.json", trimmed)
            }
        } else {
            ensure_default_extension(trimmed, &["css"], "css")
        }
    };

    #[cfg(target_os = "windows")]
    {
        let filters = if is_theme {
            vec![
                (
                    "XyNote 主题包 (*.xynote-theme.json;*.json)".to_string(),
                    "*.xynote-theme.json;*.notion-theme.json;*.json".to_string(),
                ),
                ("所有文件 (*.*)".to_string(), "*.*".to_string()),
            ]
        } else {
            vec![
                ("CSS 样式插件 (*.css)".to_string(), "*.css".to_string()),
                ("所有文件 (*.*)".to_string(), "*.*".to_string()),
            ]
        };

        let picked = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some("导出分享主题 / 样式插件".to_string()),
                default_dir,
                default_filename: Some(clean_name),
                default_ext: Some(if is_theme { "json" } else { "css" }.to_string()),
                filters,
            },
            true,
        )?;

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let final_path = if is_theme {
            ensure_default_extension(&raw_path, &["json"], "json")
        } else {
            ensure_default_extension(&raw_path, &["css"], "css")
        };
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let dialog = apply_default_dir(
            rfd::FileDialog::new()
                .set_title("导出分享主题 / 样式插件")
                .set_file_name(&clean_name)
                .add_filter(
                    if is_theme {
                        "主题包 (*.json)"
                    } else {
                        "CSS 样式插件 (*.css)"
                    },
                    if is_theme { &["json"] } else { &["css"] },
                ),
            default_dir.as_deref(),
        );
        let Some(raw_path) = dialog.save_file() else {
            return Ok(None);
        };
        let raw_str = normalize_win32_path_str(&raw_path.to_string_lossy());
        let final_path = if is_theme {
            ensure_default_extension(&raw_str, &["json"], "json")
        } else {
            ensure_default_extension(&raw_str, &["css"], "css")
        };
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
}

pub fn save_svg_file_dialog_sync(
    default_name: String,
    content: String,
) -> Result<Option<String>, AppError> {
    let clean_name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() {
            "mermaid-diagram.svg".to_string()
        } else {
            ensure_default_extension(trimmed, &["svg"], "svg")
        }
    };

    #[cfg(target_os = "windows")]
    {
        let picked = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some("导出 SVG 矢量图形".to_string()),
                default_dir: None,
                default_filename: Some(clean_name),
                default_ext: Some("svg".to_string()),
                filters: vec![
                    ("SVG 矢量图形 (*.svg)".to_string(), "*.svg".to_string()),
                    ("所有文件 (*.*)".to_string(), "*.*".to_string()),
                ],
            },
            true,
        )?;

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let final_path = ensure_default_extension(&raw_path, &["svg"], "svg");
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let picked = rfd::FileDialog::new()
            .set_title("导出 SVG 矢量图形")
            .set_file_name(&clean_name)
            .add_filter("SVG 矢量图形", &["svg"])
            .save_file();

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let raw_str = normalize_win32_path_str(&raw_path.to_string_lossy());
        let final_path = ensure_default_extension(&raw_str, &["svg"], "svg");
        if let Some(parent) = Path::new(&final_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&final_path, content.as_bytes())?;
        Ok(Some(final_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_win32_path_and_extension_helpers() {
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                normalize_win32_path_str(r"\\?\C:/meng/notion/data/"),
                r"C:\meng\notion\data"
            );
            assert_eq!(normalize_win32_path_str("C:/"), r"C:\");
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(
                normalize_win32_path_str("/Users/alice/Documents/data/"),
                "/Users/alice/Documents/data"
            );
            assert_eq!(normalize_win32_path_str("/"), "/");
        }
        assert_eq!(
            ensure_default_extension("notes", &["md", "markdown"], "md"),
            "notes.md"
        );
        assert_eq!(
            ensure_default_extension("readme.MD", &["md", "markdown"], "md"),
            "readme.MD"
        );
        assert_eq!(
            ensure_default_extension("backup", &["zip"], "zip"),
            "backup.zip"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_com_ifile_open_and_save_dialog_vtables_non_modal() {
        // Exercises real Win32 CoInitializeEx + CoCreateInstance + IFileDialog vtable slots
        // (GetOptions, SetOptions, SetTitle, SetFolder, SetFileName, SetDefaultExtension, SetFileTypes, Release)
        // on dedicated STA threads without opening a blocking modal UI!
        let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();

        let folder_res = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: false,
                pick_folders: true,
                title: Some("测试文件夹选择".into()),
                default_dir: Some(temp_dir.clone()),
                default_filename: None,
                default_ext: None,
                filters: Vec::new(),
            },
            false,
        )
        .expect("COM FileOpenDialog folder picker initialization must succeed");
        assert_eq!(folder_res, None);

        let save_res = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: true,
                pick_folders: false,
                title: Some("测试保存 Markdown".into()),
                default_dir: Some(temp_dir.clone()),
                default_filename: Some("demo.md".into()),
                default_ext: Some("md".into()),
                filters: vec![("Markdown (*.md)".into(), "*.md".into())],
            },
            false,
        )
        .expect("COM FileSaveDialog initialization must succeed");
        assert_eq!(save_res, None);

        let plugin_open_res = imp::execute_file_dialog_sta(
            imp::DialogSpec {
                is_save: false,
                pick_folders: false,
                title: Some("导入主题或样式插件".into()),
                default_dir: Some(temp_dir),
                default_filename: None,
                default_ext: Some("css".into()),
                filters: vec![(
                    "Style Plugins (*.css;*.json)".into(),
                    "*.css;*.json;*.notion-theme.json".into(),
                )],
            },
            false,
        )
        .expect("COM StylePlugin OpenDialog initialization must succeed");
        assert_eq!(plugin_open_res, None);
    }
}
