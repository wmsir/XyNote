use crate::models::AppError;
use crate::win_dialogs::normalize_win32_path_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
const MARKDOWN_EXTENSIONS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd"];
#[cfg(target_os = "windows")]
const SUPPORTED_EXTENSIONS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd", ".txt"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationStatus {
    pub supported: bool,
    pub context_menu_registered: bool,
    pub open_with_registered: bool,
    pub is_default_md_handler: bool,
    pub current_exe_path: String,
    pub registered_exe_path: Option<String>,
    pub path_matches_current_exe: bool,
    pub current_user_choice_prog_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IpcOpenRequest {
    files: Vec<String>,
}

#[derive(Default)]
struct LaunchFilesInner {
    frontend_ready: bool,
    pending_files: Vec<String>,
}

/// Manages files passed at startup via CLI or forwarded later via single-instance IPC / macOS Open events.
pub struct LaunchFilesState {
    inner: Mutex<LaunchFilesInner>,
}

impl LaunchFilesState {
    pub fn new(initial_files: Vec<String>) -> Self {
        Self {
            inner: Mutex::new(LaunchFilesInner {
                frontend_ready: false,
                pending_files: initial_files,
            }),
        }
    }

    pub fn take_pending(&self) -> Vec<String> {
        let Ok(mut guard) = self.inner.lock() else {
            return Vec::new();
        };
        guard.frontend_ready = true;
        std::mem::take(&mut guard.pending_files)
    }

    /// Returns `Some(files)` if frontend is already listening (so caller should emit directly),
    /// or `None` if queued for `take_pending`.
    pub fn push_or_ready_to_emit(&self, files: Vec<String>) -> Option<Vec<String>> {
        if files.is_empty() {
            return None;
        }
        let Ok(mut guard) = self.inner.lock() else {
            return Some(files);
        };
        if guard.frontend_ready {
            Some(files)
        } else {
            for f in files {
                if !guard.pending_files.iter().any(|existing| same_path_key(existing, &f)) {
                    guard.pending_files.push(f);
                }
            }
            None
        }
    }
}

fn same_path_key(a: &str, b: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        normalize_win32_path_str(a).eq_ignore_ascii_case(&normalize_win32_path_str(b))
    }
    #[cfg(not(target_os = "windows"))]
    {
        normalize_win32_path_str(a) == normalize_win32_path_str(b)
    }
}

fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                char::from(bytes[i + 1]).to_digit(16),
                char::from(bytes[i + 2]).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_matching_quotes(raw: &str) -> String {
    let mut s = raw.trim();
    while s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"'))
            || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s = s[1..s.len() - 1].trim();
    }
    s.trim_matches('"').trim_matches('\'').trim().to_string()
}

pub(crate) fn file_uri_to_local_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.to_ascii_lowercase().starts_with("file://") {
        return None;
    }
    let after_scheme = &trimmed["file://".len()..];
    let decoded = percent_decode_utf8(after_scheme);
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = decoded.strip_prefix("localhost/") {
            return Some(normalize_win32_path_str(rest));
        }
        if decoded.starts_with('/') {
            let trimmed_slash = decoded.trim_start_matches('/');
            return Some(normalize_win32_path_str(trimmed_slash));
        }
        Some(normalize_win32_path_str(&format!(r"\\{}", decoded)))
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(rest) = decoded.strip_prefix("localhost/") {
            return Some(normalize_win32_path_str(&format!("/{}", rest)));
        }
        if decoded.starts_with('/') {
            Some(normalize_win32_path_str(&decoded))
        } else {
            Some(normalize_win32_path_str(&format!("/{}", decoded)))
        }
    }
}

pub fn collect_cli_open_files_from_iter<I, S>(args: I, cwd: Option<&Path>) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<String> = Vec::new();
    for raw_arg in args.into_iter().skip(1) {
        let cleaned = strip_matching_quotes(raw_arg.as_ref());
        if cleaned.is_empty() || cleaned.starts_with('-') {
            continue;
        }
        let path_str = file_uri_to_local_path(&cleaned).unwrap_or_else(|| normalize_win32_path_str(&cleaned));
        if path_str.is_empty() {
            continue;
        }
        let candidate = {
            let p = PathBuf::from(&path_str);
            if p.is_absolute() {
                p
            } else if let Some(base) = cwd {
                base.join(p)
            } else {
                p
            }
        };
        let resolved = match std::fs::canonicalize(&candidate) {
            Ok(c) if c.is_file() => normalize_win32_path_str(&c.to_string_lossy()),
            _ if candidate.is_file() => normalize_win32_path_str(&candidate.to_string_lossy()),
            _ => continue,
        };
        if !out.iter().any(|existing| same_path_key(existing, &resolved)) {
            out.push(resolved);
        }
    }
    out
}

pub fn collect_cli_open_files() -> Vec<String> {
    let cwd = std::env::current_dir().ok();
    let args: Vec<String> = std::env::args_os()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    collect_cli_open_files_from_iter(args, cwd.as_deref())
}

fn user_ipc_id() -> String {
    let user_seed = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .or_else(|_| std::env::var("HOME"))
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "default".to_string());
    let mut hasher = Sha256::new();
    hasher.update(user_seed.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

#[cfg(not(test))]
pub fn enqueue_or_emit_open_files(app: &tauri::AppHandle, files: Vec<String>) {
    use tauri::{Emitter, Manager};

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }

    if files.is_empty() {
        return;
    }

    if let Some(state) = app.try_state::<LaunchFilesState>() {
        if let Some(to_emit) = state.push_or_ready_to_emit(files) {
            let _ = app.emit("xynote://open-files", to_emit);
        }
    }
}

/* ============================================================================
 * Single-Instance Named Pipe (Windows) / Unix Domain Socket
 * ========================================================================== */

#[cfg(target_os = "windows")]
mod ipc_imp {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Handle = isize;
    const INVALID_HANDLE_VALUE: Handle = -1;

    const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
    const PIPE_WAIT: u32 = 0x0000_0000;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;

    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_BROKEN_PIPE: u32 = 109;
    const ERROR_PIPE_BUSY: u32 = 231;
    const ERROR_PIPE_CONNECTED: u32 = 535;

    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const ASFW_ANY: u32 = 0xFFFF_FFFF;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            lp_name: *const u16,
            dw_open_mode: u32,
            dw_pipe_mode: u32,
            n_max_instances: u32,
            n_out_buffer_size: u32,
            n_in_buffer_size: u32,
            n_default_time_out: u32,
            lp_security_attributes: *mut c_void,
        ) -> Handle;
        fn ConnectNamedPipe(h_named_pipe: Handle, lp_overlapped: *mut c_void) -> i32;
        fn DisconnectNamedPipe(h_named_pipe: Handle) -> i32;
        fn WaitNamedPipeW(lp_named_pipe_name: *const u16, n_time_out: u32) -> i32;
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: Handle,
        ) -> Handle;
        fn ReadFile(
            h_file: Handle,
            lp_buffer: *mut u8,
            n_number_of_bytes_to_read: u32,
            lp_number_of_bytes_read: *mut u32,
            lp_overlapped: *mut c_void,
        ) -> i32;
        fn WriteFile(
            h_file: Handle,
            lp_buffer: *const u8,
            n_number_of_bytes_to_write: u32,
            lp_number_of_bytes_written: *mut u32,
            lp_overlapped: *mut c_void,
        ) -> i32;
        fn FlushFileBuffers(h_file: Handle) -> i32;
        fn CloseHandle(h_object: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn AllowSetForegroundWindow(dw_process_id: u32) -> i32;
    }

    fn to_wide_nul(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub struct PipeServerHandle(Handle);
    unsafe impl Send for PipeServerHandle {}

    impl PipeServerHandle {
        pub fn raw(&self) -> Handle {
            self.0
        }
    }

    impl Drop for PipeServerHandle {
        fn drop(&mut self) {
            if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
                self.0 = INVALID_HANDLE_VALUE;
            }
        }
    }

    pub fn try_create_server_pipe(pipe_name: &str) -> Result<PipeServerHandle, u32> {
        let wname = to_wide_nul(pipe_name);
        let h = unsafe {
            CreateNamedPipeW(
                wname.as_ptr(),
                PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE || h == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(PipeServerHandle(h))
        }
    }

    pub fn send_to_existing_pipe_checked(pipe_name: &str, payload: &[u8]) -> Result<(), String> {
        let wname = to_wide_nul(pipe_name);
        unsafe {
            let _ = AllowSetForegroundWindow(ASFW_ANY);
        }
        let mut last_err = String::new();
        for _ in 0..16 {
            let h = unsafe {
                CreateFileW(
                    wname.as_ptr(),
                    GENERIC_WRITE,
                    0,
                    ptr::null_mut(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    0,
                )
            };
            if h != INVALID_HANDLE_VALUE && h != 0 {
                let mut written: u32 = 0;
                let ok = unsafe {
                    WriteFile(
                        h,
                        payload.as_ptr(),
                        payload.len() as u32,
                        &mut written,
                        ptr::null_mut(),
                    ) != 0
                };
                let werr = if !ok { unsafe { GetLastError() } } else { 0 };
                unsafe {
                    let _ = FlushFileBuffers(h);
                    CloseHandle(h);
                }
                if ok && written as usize == payload.len() {
                    return Ok(());
                }
                last_err = format!("WriteFile ok={} written={}/{} err={}", ok, written, payload.len(), werr);
            } else {
                let err = unsafe { GetLastError() };
                last_err = format!("CreateFileW err={}", err);
                if err == ERROR_PIPE_BUSY {
                    let waited = unsafe { WaitNamedPipeW(wname.as_ptr(), 250) };
                    if waited != 0 {
                        continue;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        Err(last_err)
    }

    pub fn send_to_existing_pipe(pipe_name: &str, payload: &[u8]) -> bool {
        send_to_existing_pipe_checked(pipe_name, payload).is_ok()
    }

    pub fn serve_pipe_loop<F>(handle: PipeServerHandle, on_message: F)
    where
        F: Fn(&[u8]) -> bool + Send + 'static,
    {
        std::thread::spawn(move || {
            // Move whole `PipeServerHandle` into thread so `Drop` doesn't close pipe on caller return
            let guard = handle;
            let h = guard.raw();
            loop {
                let connected = unsafe { ConnectNamedPipe(h, ptr::null_mut()) };
                let err = if connected == 0 {
                    unsafe { GetLastError() }
                } else {
                    0
                };
                if connected == 0 && err != ERROR_PIPE_CONNECTED {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    continue;
                }

                let mut buf = Vec::with_capacity(4096);
                let mut chunk = [0u8; 4096];
                loop {
                    let mut read: u32 = 0;
                    let ok = unsafe {
                        ReadFile(
                            h,
                            chunk.as_mut_ptr(),
                            chunk.len() as u32,
                            &mut read,
                            ptr::null_mut(),
                        )
                    };
                    if ok == 0 {
                        let rerr = unsafe { GetLastError() };
                        if rerr == ERROR_BROKEN_PIPE || read == 0 {
                            break;
                        }
                        break;
                    }
                    if read == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..read as usize]);
                    if buf.len() >= 1024 * 1024 {
                        break;
                    }
                }

                unsafe {
                    DisconnectNamedPipe(h);
                }

                if !buf.is_empty() && !on_message(&buf) {
                    break;
                }
            }
            drop(guard);
        });
    }

    pub fn is_already_owned_error(err: u32) -> bool {
        err == ERROR_ACCESS_DENIED || err == ERROR_PIPE_BUSY
    }
}

#[cfg(target_os = "windows")]
pub type PrimaryIpcServer = ipc_imp::PipeServerHandle;

#[cfg(unix)]
pub struct PrimaryIpcServer {
    listener: std::os::unix::net::UnixListener,
    sock_path: PathBuf,
}

#[cfg(unix)]
impl Drop for PrimaryIpcServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.sock_path);
    }
}

#[cfg(all(not(target_os = "windows"), not(unix)))]
pub struct PrimaryIpcServer;

pub enum SingleInstanceOutcome {
    Primary(Option<PrimaryIpcServer>),
    Forwarded,
}

pub fn acquire_or_forward_single_instance(files: &[String]) -> SingleInstanceOutcome {
    #[cfg(target_os = "windows")]
    {
        let pipe_name = format!(r"\\.\pipe\XyNote_SingleInstance_{}", user_ipc_id());
        match ipc_imp::try_create_server_pipe(&pipe_name) {
            Ok(server) => SingleInstanceOutcome::Primary(Some(server)),
            Err(err) if ipc_imp::is_already_owned_error(err) => {
                let req = IpcOpenRequest {
                    files: files.to_vec(),
                };
                if let Ok(bytes) = serde_json::to_vec(&req) {
                    if ipc_imp::send_to_existing_pipe(&pipe_name, &bytes) {
                        return SingleInstanceOutcome::Forwarded;
                    }
                }
                SingleInstanceOutcome::Primary(None)
            }
            Err(_) => SingleInstanceOutcome::Primary(None),
        }
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::net::{UnixListener, UnixStream};

        let sock_path =
            std::env::temp_dir().join(format!("xynote-ipc-{}.sock", user_ipc_id()));
        if let Ok(mut stream) = UnixStream::connect(&sock_path) {
            let req = IpcOpenRequest {
                files: files.to_vec(),
            };
            if let Ok(bytes) = serde_json::to_vec(&req) {
                let _ = stream.write_all(&bytes);
                let _ = stream.flush();
                return SingleInstanceOutcome::Forwarded;
            }
        }
        let _ = std::fs::remove_file(&sock_path);
        match UnixListener::bind(&sock_path) {
            Ok(listener) => SingleInstanceOutcome::Primary(Some(PrimaryIpcServer {
                listener,
                sock_path,
            })),
            Err(_) => SingleInstanceOutcome::Primary(None),
        }
    }

    #[cfg(all(not(target_os = "windows"), not(unix)))]
    {
        let _ = files;
        SingleInstanceOutcome::Primary(None)
    }
}

#[cfg(not(test))]
pub fn spawn_ipc_listener(server: Option<PrimaryIpcServer>, app: tauri::AppHandle) {
    let Some(srv) = server else {
        return;
    };

    #[cfg(target_os = "windows")]
    {
        ipc_imp::serve_pipe_loop(srv, move |bytes| {
            if let Ok(req) = serde_json::from_slice::<IpcOpenRequest>(bytes) {
                enqueue_or_emit_open_files(&app, req.files);
            }
            true
        });
    }

    #[cfg(unix)]
    {
        use std::io::Read;
        std::thread::spawn(move || {
            let _keep_alive = &srv;
            for conn in srv.listener.incoming().flatten() {
                let mut stream = conn;
                let mut buf = Vec::new();
                if stream.read_to_end(&mut buf).is_ok() && !buf.is_empty() {
                    if let Ok(req) = serde_json::from_slice::<IpcOpenRequest>(&buf) {
                        enqueue_or_emit_open_files(&app, req.files);
                    }
                }
            }
        });
    }
}

/* ============================================================================
 * Windows Per-User (HKCU) Context Menu & .md Default Handler Registration
 * ========================================================================== */

#[cfg(target_os = "windows")]
mod win_reg {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::process::CommandExt;
    use std::ptr;

    type Hkey = isize;
    type HResult = i32;
    type Hwnd = *mut c_void;

    const HKEY_CURRENT_USER: Hkey = 0x8000_0001u32 as i32 as isize;
    const KEY_READ: u32 = 0x20019;
    const KEY_WRITE: u32 = 0x20006;
    const REG_SZ: u32 = 1;
    const REG_OPTION_NON_VOLATILE: u32 = 0;
    const ERROR_SUCCESS: i32 = 0;

    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    const SHCNF_IDLIST: u32 = 0x0000;

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    const HRESULT_ERROR_CANCELLED: HResult = 0x8007_04C7u32 as i32;

    const OAIF_ALLOW_REGISTRATION: i32 = 0x0000_0001;
    const OAIF_REGISTER_EXT: i32 = 0x0000_0002;
    const OAIF_FORCE_REGISTRATION: i32 = 0x0000_0040;

    #[repr(C)]
    struct OpenAsInfo {
        pcsz_file: *const u16,
        pcsz_class: *const u16,
        oaif_in_flags: i32,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn RegCreateKeyExW(
            h_key: Hkey,
            lp_sub_key: *const u16,
            reserved: u32,
            lp_class: *mut u16,
            dw_options: u32,
            sam_desired: u32,
            lp_security_attributes: *mut c_void,
            phk_result: *mut Hkey,
            lpdw_disposition: *mut u32,
        ) -> i32;
        fn RegOpenKeyExW(
            h_key: Hkey,
            lp_sub_key: *const u16,
            ul_options: u32,
            sam_desired: u32,
            phk_result: *mut Hkey,
        ) -> i32;
        fn RegSetValueExW(
            h_key: Hkey,
            lp_value_name: *const u16,
            reserved: u32,
            dw_type: u32,
            lp_data: *const u8,
            cb_data: u32,
        ) -> i32;
        fn RegQueryValueExW(
            h_key: Hkey,
            lp_value_name: *const u16,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> i32;
        fn RegDeleteValueW(h_key: Hkey, lp_value_name: *const u16) -> i32;
        fn RegDeleteTreeW(h_key: Hkey, lp_sub_key: *const u16) -> i32;
        fn RegCloseKey(h_key: Hkey) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(
            w_event_id: i32,
            u_flags: u32,
            dw_item1: *const c_void,
            dw_item2: *const c_void,
        );
        fn SHOpenWithDialog(hwnd_parent: Hwnd, poainfo: *const OpenAsInfo) -> HResult;
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *mut c_void, dw_co_init: u32) -> HResult;
        fn CoUninitialize();
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Hwnd;
    }

    struct RegKeyGuard(Hkey);
    impl Drop for RegKeyGuard {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    RegCloseKey(self.0);
                }
            }
        }
    }

    fn wide_nul(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub(crate) fn set_hkcu_sz(subkey: &str, value_name: &str, value_data: &str) -> Result<(), AppError> {
        let wsub = wide_nul(subkey);
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wsub.as_ptr(),
                0,
                ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                ptr::null_mut(),
                &mut hkey,
                ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(AppError::Io(std::io::Error::from_raw_os_error(rc)));
        }
        let _guard = RegKeyGuard(hkey);
        let wname = wide_nul(value_name);
        let wval = wide_nul(value_data);
        let rc2 = unsafe {
            RegSetValueExW(
                hkey,
                wname.as_ptr(),
                0,
                REG_SZ,
                wval.as_ptr() as *const u8,
                (wval.len() * 2) as u32,
            )
        };
        if rc2 != ERROR_SUCCESS {
            return Err(AppError::Io(std::io::Error::from_raw_os_error(rc2)));
        }
        Ok(())
    }

    pub(crate) fn read_hkcu_sz(subkey: &str, value_name: &str) -> Option<String> {
        let wsub = wide_nul(subkey);
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wsub.as_ptr(),
                0,
                KEY_READ,
                &mut hkey,
            )
        };
        if rc != ERROR_SUCCESS || hkey == 0 {
            return None;
        }
        let _guard = RegKeyGuard(hkey);
        let wname = wide_nul(value_name);
        let mut val_type: u32 = 0;
        let mut byte_len: u32 = 0;
        let rc_size = unsafe {
            RegQueryValueExW(
                hkey,
                wname.as_ptr(),
                ptr::null_mut(),
                &mut val_type,
                ptr::null_mut(),
                &mut byte_len,
            )
        };
        if rc_size != ERROR_SUCCESS || val_type != REG_SZ || byte_len < 2 {
            if rc_size == ERROR_SUCCESS && val_type == REG_SZ {
                return Some(String::new());
            }
            return None;
        }
        let mut buf: Vec<u16> = vec![0u16; (byte_len as usize + 1) / 2];
        let mut actual_bytes = (buf.len() * 2) as u32;
        let rc_read = unsafe {
            RegQueryValueExW(
                hkey,
                wname.as_ptr(),
                ptr::null_mut(),
                &mut val_type,
                buf.as_mut_ptr() as *mut u8,
                &mut actual_bytes,
            )
        };
        if rc_read != ERROR_SUCCESS {
            return None;
        }
        let u16_len = (actual_bytes as usize / 2).min(buf.len());
        let trimmed_len = buf[..u16_len]
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(u16_len);
        Some(
            std::ffi::OsString::from_wide(&buf[..trimmed_len])
                .to_string_lossy()
                .into_owned(),
        )
    }

    pub(crate) fn hkcu_value_exists(subkey: &str, value_name: &str) -> bool {
        let wsub = wide_nul(subkey);
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wsub.as_ptr(),
                0,
                KEY_READ,
                &mut hkey,
            )
        };
        if rc != ERROR_SUCCESS || hkey == 0 {
            return false;
        }
        let _guard = RegKeyGuard(hkey);
        let wname = wide_nul(value_name);
        let rc_q = unsafe {
            RegQueryValueExW(
                hkey,
                wname.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        rc_q == ERROR_SUCCESS
    }

    pub(crate) fn delete_hkcu_value(subkey: &str, value_name: &str) {
        let wsub = wide_nul(subkey);
        let mut hkey: Hkey = 0;
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wsub.as_ptr(),
                0,
                KEY_WRITE,
                &mut hkey,
            )
        };
        if rc == ERROR_SUCCESS && hkey != 0 {
            let _guard = RegKeyGuard(hkey);
            let wname = wide_nul(value_name);
            unsafe {
                RegDeleteValueW(hkey, wname.as_ptr());
            }
        }
    }

    pub(crate) fn delete_hkcu_tree(subkey: &str) {
        let wsub = wide_nul(subkey);
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, wsub.as_ptr());
        }
    }

    pub(crate) fn notify_assoc_changed() {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, ptr::null(), ptr::null());
        }
    }

    pub(crate) fn extract_exe_from_command(cmd: &str) -> Option<String> {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return None;
        }
        let raw = if let Some(rest) = trimmed.strip_prefix('"') {
            rest.split('"').next().unwrap_or("")
        } else {
            trimmed.split_whitespace().next().unwrap_or("")
        };
        let norm = normalize_win32_path_str(raw);
        if norm.is_empty() {
            None
        } else {
            Some(norm)
        }
    }

    pub(crate) fn show_open_with_md_dialog() -> Result<(), AppError> {
        let sample_path = std::env::temp_dir().join("XyNote-Markdown-Default.md");
        if !sample_path.exists() {
            let _ = std::fs::write(&sample_path, "# XyNote Markdown File Association\n");
        }
        let sample_str = normalize_win32_path_str(&sample_path.to_string_lossy());

        let hr = std::thread::spawn(move || -> HResult {
            let init_hr = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            let should_uninit = init_hr == 0 || init_hr == 1;
            let wfile = wide_nul(&sample_str);
            let oai = OpenAsInfo {
                pcsz_file: wfile.as_ptr(),
                pcsz_class: ptr::null(),
                oaif_in_flags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_FORCE_REGISTRATION,
            };
            let res = unsafe { SHOpenWithDialog(GetForegroundWindow(), &oai) };
            if should_uninit {
                unsafe {
                    CoUninitialize();
                }
            }
            res
        })
        .join()
        .unwrap_or(-1);

        let _ = std::fs::remove_file(&sample_path);

        if hr == 0 || hr == HRESULT_ERROR_CANCELLED {
            return Ok(());
        }

        // Fallback: open Windows Default Apps settings page directly
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn current_exe_info() -> Result<(String, String), AppError> {
    let exe_buf = std::env::current_exe()?;
    let exe_path = normalize_win32_path_str(&exe_buf.to_string_lossy());
    let exe_name = exe_buf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "XyNote.exe".to_string());
    Ok((exe_path, exe_name))
}

pub fn get_shell_integration_status() -> ShellIntegrationStatus {
    #[cfg(target_os = "windows")]
    {
        let Ok((exe_path, exe_name)) = current_exe_info() else {
            return ShellIntegrationStatus {
                supported: true,
                context_menu_registered: false,
                open_with_registered: false,
                is_default_md_handler: false,
                current_exe_path: String::new(),
                registered_exe_path: None,
                path_matches_current_exe: false,
                current_user_choice_prog_id: None,
            };
        };

        let ctx_cmd = win_reg::read_hkcu_sz(
            r"Software\Classes\SystemFileAssociations\.md\shell\XyNote\command",
            "",
        );
        let progid_cmd = win_reg::read_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\shell\open\command",
            "",
        );
        let app_key = format!(r"Software\Classes\Applications\{}\shell\open\command", exe_name);
        let app_cmd = win_reg::read_hkcu_sz(&app_key, "");
        let registered_exe_path = ctx_cmd
            .as_deref()
            .and_then(win_reg::extract_exe_from_command)
            .or_else(|| progid_cmd.as_deref().and_then(win_reg::extract_exe_from_command));

        let path_matches_current_exe = registered_exe_path
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case(&exe_path));

        let context_menu_registered = ctx_cmd
            .as_deref()
            .and_then(win_reg::extract_exe_from_command)
            .is_some_and(|p| p.eq_ignore_ascii_case(&exe_path));

        let open_with_registered = app_cmd
            .as_deref()
            .and_then(win_reg::extract_exe_from_command)
            .is_some_and(|p| p.eq_ignore_ascii_case(&exe_path))
            && win_reg::hkcu_value_exists(
                r"Software\Classes\.md\OpenWithProgids",
                "XyNote.Markdown",
            );

        let user_choice = win_reg::read_hkcu_sz(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
            "ProgId",
        )
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            win_reg::read_hkcu_sz(r"Software\Classes\.md", "")
                .filter(|s| !s.trim().is_empty())
        });

        let is_default_md_handler = match user_choice.as_deref() {
            Some(pid) if pid.eq_ignore_ascii_case("XyNote.Markdown") => path_matches_current_exe,
            Some(pid) => {
                let handler_cmd = win_reg::read_hkcu_sz(
                    &format!(r"Software\Classes\{}\shell\open\command", pid),
                    "",
                );
                handler_cmd
                    .as_deref()
                    .and_then(win_reg::extract_exe_from_command)
                    .is_some_and(|p| p.eq_ignore_ascii_case(&exe_path))
                    || pid.eq_ignore_ascii_case(&format!(r"Applications\{}", exe_name))
            }
            None => false,
        };

        ShellIntegrationStatus {
            supported: true,
            context_menu_registered,
            open_with_registered,
            is_default_md_handler,
            current_exe_path: exe_path,
            registered_exe_path,
            path_matches_current_exe,
            current_user_choice_prog_id: user_choice,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        ShellIntegrationStatus {
            supported: false,
            context_menu_registered: false,
            open_with_registered: false,
            is_default_md_handler: false,
            current_exe_path: std::env::current_exe()
                .map(|p| normalize_win32_path_str(&p.to_string_lossy()))
                .unwrap_or_default(),
            registered_exe_path: None,
            path_matches_current_exe: false,
            current_user_choice_prog_id: None,
        }
    }
}

pub fn register_windows_shell_integration() -> Result<ShellIntegrationStatus, AppError> {
    #[cfg(target_os = "windows")]
    {
        let (exe_path, exe_name) = current_exe_info()?;
        let icon_val = format!("\"{}\",0", exe_path);
        let open_cmd = format!("\"{}\" \"%1\"", exe_path);

        // Clean stale previous portable executable name if it no longer exists on disk
        if let Some(prev_name) =
            win_reg::read_hkcu_sz(r"Software\XyNote\Capabilities", "LastExeName")
        {
            if !prev_name.is_empty() && !prev_name.eq_ignore_ascii_case(&exe_name) {
                let prev_missing =
                    win_reg::read_hkcu_sz(r"Software\XyNote\Capabilities", "LastExePath")
                        .map(|p| !Path::new(&p).is_file())
                        .unwrap_or(true);
                if prev_missing {
                    win_reg::delete_hkcu_tree(&format!(r"Software\Classes\Applications\{}", prev_name));
                }
            }
        }

        // 1. Register ProgID `XyNote.Markdown`
        win_reg::set_hkcu_sz(r"Software\Classes\XyNote.Markdown", "", "Markdown 文档")?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown",
            "FriendlyTypeName",
            "Markdown 文档",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\DefaultIcon",
            "",
            &icon_val,
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\Application",
            "ApplicationName",
            "小悦笔记 (XyNote)",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\Application",
            "ApplicationDescription",
            "本地优先的块级 Markdown 知识库与直编工具",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\Application",
            "ApplicationCompany",
            "FWPT.CN",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\Application",
            "ApplicationIcon",
            &icon_val,
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\shell\open",
            "",
            "用小悦笔记 (XyNote) 打开",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\shell\open",
            "FriendlyAppName",
            "小悦笔记 (XyNote)",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\shell\open",
            "Icon",
            &icon_val,
        )?;
        win_reg::set_hkcu_sz(
            r"Software\Classes\XyNote.Markdown\shell\open\command",
            "",
            &open_cmd,
        )?;

        // 2. Register Applications\<exe_name> for Windows "Open with" & manual browse association
        let app_root = format!(r"Software\Classes\Applications\{}", exe_name);
        win_reg::set_hkcu_sz(&app_root, "FriendlyAppName", "小悦笔记 (XyNote)")?;
        win_reg::set_hkcu_sz(&format!(r"{}\DefaultIcon", app_root), "", &icon_val)?;
        for ext in SUPPORTED_EXTENSIONS {
            win_reg::set_hkcu_sz(&format!(r"{}\SupportedTypes", app_root), ext, "")?;
        }
        win_reg::set_hkcu_sz(
            &format!(r"{}\shell\open", app_root),
            "FriendlyAppName",
            "小悦笔记 (XyNote)",
        )?;
        win_reg::set_hkcu_sz(&format!(r"{}\shell\open", app_root), "Icon", &icon_val)?;
        win_reg::set_hkcu_sz(
            &format!(r"{}\shell\open\command", app_root),
            "",
            &open_cmd,
        )?;

        // 3. Direct right-click context menu & OpenWithProgids for Markdown extensions
        for ext in MARKDOWN_EXTENSIONS {
            let sfa_shell = format!(r"Software\Classes\SystemFileAssociations\{}\shell\XyNote", ext);
            win_reg::set_hkcu_sz(&sfa_shell, "", "用小悦笔记 (XyNote) 打开")?;
            win_reg::set_hkcu_sz(&sfa_shell, "Icon", &icon_val)?;
            win_reg::set_hkcu_sz(&format!(r"{}\command", sfa_shell), "", &open_cmd)?;

            let ext_key = format!(r"Software\Classes\{}", ext);
            let existing_default = win_reg::read_hkcu_sz(&ext_key, "").unwrap_or_default();
            if existing_default.trim().is_empty()
                || existing_default.eq_ignore_ascii_case("XyNote.Markdown")
            {
                win_reg::set_hkcu_sz(&ext_key, "", "XyNote.Markdown")?;
            }
            if win_reg::read_hkcu_sz(&ext_key, "PerceivedType")
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                win_reg::set_hkcu_sz(&ext_key, "PerceivedType", "text")?;
            }
            if win_reg::read_hkcu_sz(&ext_key, "Content Type")
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
            {
                win_reg::set_hkcu_sz(&ext_key, "Content Type", "text/markdown")?;
            }
            win_reg::set_hkcu_sz(
                &format!(r"{}\OpenWithProgids", ext_key),
                "XyNote.Markdown",
                "",
            )?;
        }

        // 4. Register Capabilities & RegisteredApplications (Windows Settings Default Apps)
        win_reg::set_hkcu_sz(
            r"Software\XyNote\Capabilities",
            "ApplicationName",
            "小悦笔记 (XyNote)",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\XyNote\Capabilities",
            "ApplicationDescription",
            "本地优先的块级 Markdown 知识库与直编工具",
        )?;
        win_reg::set_hkcu_sz(
            r"Software\XyNote\Capabilities",
            "ApplicationIcon",
            &icon_val,
        )?;
        win_reg::set_hkcu_sz(r"Software\XyNote\Capabilities", "LastExeName", &exe_name)?;
        win_reg::set_hkcu_sz(r"Software\XyNote\Capabilities", "LastExePath", &exe_path)?;
        for ext in MARKDOWN_EXTENSIONS {
            win_reg::set_hkcu_sz(
                r"Software\XyNote\Capabilities\FileAssociations",
                ext,
                "XyNote.Markdown",
            )?;
        }
        win_reg::set_hkcu_sz(
            r"Software\RegisteredApplications",
            "XyNote",
            r"Software\XyNote\Capabilities",
        )?;

        win_reg::notify_assoc_changed();
    }
    Ok(get_shell_integration_status())
}

pub fn ensure_windows_shell_registered_silent() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        let status = get_shell_integration_status();
        if status.context_menu_registered
            && status.open_with_registered
            && status.path_matches_current_exe
        {
            return Ok(());
        }
        let _ = register_windows_shell_integration()?;
    }
    Ok(())
}

pub fn unregister_windows_shell_integration() -> Result<ShellIntegrationStatus, AppError> {
    #[cfg(target_os = "windows")]
    {
        for ext in MARKDOWN_EXTENSIONS {
            win_reg::delete_hkcu_tree(&format!(
                r"Software\Classes\SystemFileAssociations\{}\shell\XyNote",
                ext
            ));
            let ext_key = format!(r"Software\Classes\{}", ext);
            win_reg::delete_hkcu_value(&format!(r"{}\OpenWithProgids", ext_key), "XyNote.Markdown");
            if win_reg::read_hkcu_sz(&ext_key, "")
                .as_deref()
                .is_some_and(|v| v.eq_ignore_ascii_case("XyNote.Markdown"))
            {
                win_reg::delete_hkcu_value(&ext_key, "");
            }
        }

        if let Some(prev_name) =
            win_reg::read_hkcu_sz(r"Software\XyNote\Capabilities", "LastExeName")
        {
            if !prev_name.trim().is_empty() {
                win_reg::delete_hkcu_tree(&format!(r"Software\Classes\Applications\{}", prev_name));
            }
        }
        if let Ok((_, exe_name)) = current_exe_info() {
            win_reg::delete_hkcu_tree(&format!(r"Software\Classes\Applications\{}", exe_name));
        }

        win_reg::delete_hkcu_tree(r"Software\Classes\XyNote.Markdown");
        win_reg::delete_hkcu_tree(r"Software\XyNote");
        win_reg::delete_hkcu_value(r"Software\RegisteredApplications", "XyNote");
        win_reg::notify_assoc_changed();
    }
    Ok(get_shell_integration_status())
}

pub fn prompt_windows_default_md_dialog() -> Result<ShellIntegrationStatus, AppError> {
    #[cfg(target_os = "windows")]
    {
        let _ = register_windows_shell_integration()?;
        win_reg::show_open_with_md_dialog()?;
    }
    Ok(get_shell_integration_status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn test_collect_cli_open_files_from_iter_filters_flags_and_normalizes_paths() {
        let dir = std::env::temp_dir().join(format!("xynote-cli-test-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let rel_md = dir.join("sample.md");
        std::fs::write(&rel_md, "# Hello\n").unwrap();
        let abs_md = dir.join("quoted space.markdown");
        std::fs::write(&abs_md, "# Space\n").unwrap();

        let args = vec![
            r"C:\Tools\XyNote-windows-x64-portable.exe".to_string(),
            "--devtools".to_string(),
            "-psn_0_12345".to_string(),
            "\"sample.md\"".to_string(),
            format!("'{}'", abs_md.to_string_lossy()),
            "sample.md".to_string(),
            "nonexistent.md".to_string(),
        ];

        let found = collect_cli_open_files_from_iter(args, Some(&dir));
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("sample.md"));
        assert!(found[1].ends_with("quoted space.markdown"));

        let uri_arg = if cfg!(target_os = "windows") {
            format!("file:///{}", rel_md.to_string_lossy().replace('\\', "/"))
        } else {
            format!("file://{}", rel_md.to_string_lossy())
        };
        let uri_found = collect_cli_open_files_from_iter(
            vec!["XyNote".to_string(), uri_arg],
            None,
        );
        assert_eq!(uri_found.len(), 1);
        assert!(uri_found[0].ends_with("sample.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_launch_files_state_queue_and_drain() {
        let state = LaunchFilesState::new(vec!["a.md".into()]);
        assert!(state.push_or_ready_to_emit(vec!["b.md".into(), "a.md".into()]).is_none());
        let drained = state.take_pending();
        assert_eq!(drained, vec!["a.md".to_string(), "b.md".to_string()]);
        assert!(state.take_pending().is_empty());
        let direct = state.push_or_ready_to_emit(vec!["c.md".into()]);
        assert_eq!(direct, Some(vec!["c.md".to_string()]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_win32_hkcu_registry_helpers_roundtrip() {
        let subkey = format!(r"Software\XyNote_Test_{}", Uuid::new_v4().simple());
        win_reg::set_hkcu_sz(&subkey, "", "Markdown 文档").unwrap();
        win_reg::set_hkcu_sz(&subkey, "Command", r#""C:\Tools\XyNote.exe" "%1""#).unwrap();

        assert_eq!(
            win_reg::read_hkcu_sz(&subkey, "").as_deref(),
            Some("Markdown 文档")
        );
        let cmd = win_reg::read_hkcu_sz(&subkey, "Command").unwrap();
        assert_eq!(
            win_reg::extract_exe_from_command(&cmd).as_deref(),
            Some(r"C:\Tools\XyNote.exe")
        );
        assert!(win_reg::hkcu_value_exists(&subkey, "Command"));

        win_reg::delete_hkcu_value(&subkey, "Command");
        assert!(!win_reg::hkcu_value_exists(&subkey, "Command"));

        win_reg::delete_hkcu_tree(&subkey);
        assert!(win_reg::read_hkcu_sz(&subkey, "").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_win32_named_pipe_single_instance_forwarding() {
        let pipe = format!(r"\\.\pipe\XyNote_TestPipe_{}", Uuid::new_v4().simple());
        let server = ipc_imp::try_create_server_pipe(&pipe).expect("server pipe creation");
        assert!(ipc_imp::try_create_server_pipe(&pipe).is_err());

        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
        ipc_imp::serve_pipe_loop(server, move |bytes| {
            let _ = tx.send(bytes.to_vec());
            false
        });

        let payload = serde_json::to_vec(&IpcOpenRequest {
            files: vec![r"D:\notes\demo.md".into()],
        })
        .unwrap();
        ipc_imp::send_to_existing_pipe_checked(&pipe, &payload)
            .expect("pipe client must send payload to existing server");

        let received = rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("pipe server must receive forwarded payload");
        let parsed: IpcOpenRequest = serde_json::from_slice(&received).unwrap();
        assert_eq!(parsed.files, vec![r"D:\notes\demo.md".to_string()]);
    }
}
