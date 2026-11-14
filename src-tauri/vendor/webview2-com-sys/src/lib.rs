#[cfg(not(target_env = "msvc"))]
pub(crate) mod embedded_loader {
    use core::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    #[cfg(target_arch = "x86_64")]
    static LOADER_DLL: &[u8] = include_bytes!("../x64/WebView2Loader.dll");
    #[cfg(target_arch = "x86")]
    static LOADER_DLL: &[u8] = include_bytes!("../x86/WebView2Loader.dll");
    #[cfg(target_arch = "aarch64")]
    static LOADER_DLL: &[u8] = include_bytes!("../arm64/WebView2Loader.dll");

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *const c_void;
    }

    fn load_library_path(path: &Path) -> *mut c_void {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(core::iter::once(0))
            .collect();
        unsafe { LoadLibraryW(wide.as_ptr()) }
    }

    fn ensure_extracted_dll(dir: &Path) -> Option<PathBuf> {
        std::fs::create_dir_all(dir).ok()?;
        let target = dir.join("WebView2Loader-0.39.1.dll");
        if let Ok(meta) = std::fs::metadata(&target) {
            if meta.len() == LOADER_DLL.len() as u64 {
                return Some(target);
            }
        }
        let tmp = dir.join(format!("WebView2Loader-0.39.1.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, LOADER_DLL).is_ok() {
            if std::fs::rename(&tmp, &target).is_err() {
                let _ = std::fs::remove_file(&tmp);
                if !target.exists() {
                    std::fs::write(&target, LOADER_DLL).ok()?;
                }
            }
            return Some(target);
        }
        std::fs::write(&target, LOADER_DLL).ok()?;
        Some(target)
    }

    fn get_module() -> usize {
        static MODULE: OnceLock<usize> = OnceLock::new();
        *MODULE.get_or_init(|| {
            // 1. Check beside the executable first if present
            if let Ok(exe) = std::env::current_exe() {
                if let Some(parent) = exe.parent() {
                    let side_by_side = parent.join("WebView2Loader.dll");
                    if side_by_side.is_file() {
                        let h = load_library_path(&side_by_side);
                        if !h.is_null() {
                            return h as usize;
                        }
                    }
                }
            }

            // 2. Extract embedded signed WebView2Loader.dll to LOCALAPPDATA (or TEMP fallback)
            let mut candidate_dirs: Vec<PathBuf> = Vec::new();
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                candidate_dirs.push(
                    PathBuf::from(local_app_data)
                        .join("com.meng.notiondesktop")
                        .join("bin"),
                );
            }
            candidate_dirs.push(std::env::temp_dir().join("com.meng.notiondesktop-wv2"));

            for dir in candidate_dirs {
                if let Some(dll_path) = ensure_extracted_dll(&dir) {
                    let h = load_library_path(&dll_path);
                    if !h.is_null() {
                        return h as usize;
                    }
                }
            }

            0
        })
    }

    pub unsafe fn resolve_proc(null_terminated_name: &[u8]) -> Option<*const c_void> {
        let h = get_module();
        if h == 0 {
            return None;
        }
        let proc_ptr = unsafe { GetProcAddress(h as *mut c_void, null_terminated_name.as_ptr()) };
        if proc_ptr.is_null() {
            None
        } else {
            Some(proc_ptr)
        }
    }
}

#[allow(
    non_snake_case,
    non_upper_case_globals,
    non_camel_case_types,
    dead_code,
    clippy::all
)]
pub mod Microsoft {
    pub mod Web {
        pub mod WebView2 {
            pub mod Win32 {
                mod windows_core {
                    #[cfg(target_env = "msvc")]
                    macro_rules! link_webview2 {
                        ($library:literal $abi:literal fn $($function:tt)*) => (
                            #[link(name = "WebView2LoaderStatic", kind = "static")]
                            extern $abi {
                                pub fn $($function)*;
                            }
                        )
                    }

                    #[cfg(not(target_env = "msvc"))]
                    macro_rules! link_webview2 {
                        ($library:literal $abi:literal fn $name:ident ( $($arg:ident : $arg_ty:ty),* $(,)? ) -> $ret:ty) => (
                            unsafe fn $name( $($arg : $arg_ty),* ) -> $ret {
                                type FnPtr = unsafe extern "system" fn( $($arg_ty),* ) -> $ret;
                                static FN_PTR: ::std::sync::OnceLock<Option<FnPtr>> = ::std::sync::OnceLock::new();
                                let ptr_opt = FN_PTR.get_or_init(|| unsafe {
                                    crate::embedded_loader::resolve_proc(concat!(stringify!($name), "\0").as_bytes())
                                        .map(|p| ::core::mem::transmute::<*const ::core::ffi::c_void, FnPtr>(p))
                                });
                                match ptr_opt {
                                    Some(f) => unsafe { f( $($arg),* ) },
                                    None => ::windows_core::HRESULT::from_win32(127),
                                }
                            }
                        )
                    }

                    pub(crate) use ::windows_core::*;
                    pub(crate) use link_webview2 as link;
                }

                include!("bindings.rs");
            }
        }
    }
}

pub mod declared_interfaces;

#[cfg(test)]
mod test {
    use windows_core::w;

    use crate::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn compare_eq() {
        let mut result = 1;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.0"), &mut result) }.unwrap();
        assert_eq!(0, result);
    }

    #[test]
    fn compare_lt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(-1, result);
    }

    #[test]
    fn compare_gt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("2.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(1, result);
    }
}
