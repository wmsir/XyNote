//! 监听侧栏挂载的文件夹与正在编辑的文件：磁盘上有变化时（新建、删除、改名、保存）
//! 合并 300ms 内的事件后通知前端，刷新文件夹树并检查当前文件是否被其他程序改过。

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

/// 不需要通知的目录（与 folders.rs 的隐藏规则一致）
const NOISY_PARTS: [&str; 6] = ["node_modules", "target", ".git", "dist", "build", "__pycache__"];

#[derive(Default)]
pub struct FsWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
    generation: AtomicU64,
}

/// 这条路径是否值得通知前端：跳过版本库、依赖目录和编辑器临时文件
pub fn is_relevant_path(path: &Path) -> bool {
    for comp in path.components() {
        let s = comp.as_os_str().to_string_lossy();
        if NOISY_PARTS.iter().any(|n| s.eq_ignore_ascii_case(n)) {
            return false;
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    !(name.starts_with('~') || name.ends_with(".tmp") || name.ends_with(".swp") || name.starts_with(".#"))
}

impl FsWatcher {
    /// 替换监听目标：文件夹递归监听，单个文件只监听自身。emit 收到去重后的变化路径列表。
    /// 耗时的递归注册全部在锁外完成，并带代际序号防止快速切换时覆盖最新目标。
    pub fn set_targets<F>(&self, dirs: Vec<String>, files: Vec<String>, emit: F) -> Result<(), String>
    where
        F: Fn(Vec<String>) + Send + 'static,
    {
        let gen = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let old_watcher = {
            let mut guard = self.inner.lock().map_err(|_| "watcher lock poisoned".to_string())?;
            guard.take()
        };
        drop(old_watcher);

        if dirs.is_empty() && files.is_empty() {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            match event.kind {
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {}
                _ => return,
            }
            for p in event.paths {
                if is_relevant_path(&p) {
                    let _ = tx.send(p);
                }
            }
        })
        .map_err(|e| e.to_string())?;

        for d in &dirs {
            if self.generation.load(Ordering::Acquire) != gen {
                return Ok(());
            }
            let p = PathBuf::from(crate::win_dialogs::normalize_win32_path_str(d));
            if p.is_dir() {
                // 单个目录监听失败（权限、已删除）不影响其他目录
                let _ = watcher.watch(&p, RecursiveMode::Recursive);
            }
        }
        for f in &files {
            if self.generation.load(Ordering::Acquire) != gen {
                return Ok(());
            }
            let p = PathBuf::from(crate::win_dialogs::normalize_win32_path_str(f));
            if p.is_file() {
                let _ = watcher.watch(&p, RecursiveMode::NonRecursive);
            }
        }

        if self.generation.load(Ordering::Acquire) != gen {
            return Ok(());
        }

        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = BTreeSet::new();
                batch.insert(first.to_string_lossy().into_owned());
                while let Ok(more) = rx.recv_timeout(Duration::from_millis(300)) {
                    batch.insert(more.to_string_lossy().into_owned());
                    if batch.len() > 500 {
                        break;
                    }
                }
                emit(batch.into_iter().collect());
            }
        });

        let mut guard = self.inner.lock().map_err(|_| "watcher lock poisoned".to_string())?;
        if self.generation.load(Ordering::Acquire) == gen {
            *guard = Some(watcher);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_noise_paths() {
        assert!(is_relevant_path(Path::new("/notes/项目/a.md")));
        assert!(!is_relevant_path(Path::new("/notes/node_modules/x/readme.md")));
        assert!(!is_relevant_path(Path::new("/notes/.git/index")));
        assert!(!is_relevant_path(Path::new("/notes/~$draft.md")));
        assert!(!is_relevant_path(Path::new("/notes/a.md.swp")));
    }

    #[test]
    fn reports_changes_in_watched_folder() {
        let dir = std::env::temp_dir().join(format!(
            "xynote-watch-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let w = FsWatcher::default();
        let (tx, rx) = mpsc::channel();
        w.set_targets(vec![dir.to_string_lossy().into_owned()], vec![], move |paths| {
            let _ = tx.send(paths);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.join("新笔记.md"), "# hi").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("change event");
        assert!(got.iter().any(|p| p.ends_with("新笔记.md")));
        w.set_targets(vec![], vec![], |_| {}).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }
}
