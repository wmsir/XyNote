use crate::db::Database;
use crate::kb::KbEngine;
use crate::models::{
    AppError, BackupEntry, BatchImportResult, Block, CreatePageInput, DatabaseFull, DbColumn,
    DbRow, ImportedCustomFont, LocalMarkdownDocument, MarkdownExport, MarkdownTreeEntry, Page,
    PageDetail, SaveBlockItem, SaveStylePluginInput, SavedAssetResult, SearchResult,
    StorageConfigInfo, StylePluginItem, StylePluginState, TodoItem, UpdatePagePatch,
    UpdateStorageConfigInput, UpsertBlockInput, UpsertDbColumnInput, UpsertDbRowInput,
    UrlMetadata,
};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, State};

#[cfg(target_os = "windows")]
async fn run_dialog<F, T>(_app: &AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Dialog worker join error: {}", e))?
        .map_err(Into::into)
}

#[cfg(not(target_os = "windows"))]
async fn run_dialog<F, T>(app: &AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("Failed to dispatch dialog to main thread: {}", e))?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|e| format!("Dialog main-thread channel error: {}", e))
    })
    .await
    .map_err(|e| format!("Dialog worker join error: {}", e))??
    .map_err(Into::into)
}

fn spawn_kb_reindex_page(app: &AppHandle, page_id: String) {
    use tauri::Manager;
    if !app.state::<KbEngine>().is_enabled() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Database>();
        let kb = handle.state::<KbEngine>();
        kb.sync_single_page(&db, &page_id);
    });
}

fn spawn_kb_remove_page(app: &AppHandle, page_id: String) {
    use tauri::Manager;
    if !app.state::<KbEngine>().is_enabled() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Database>();
        let kb = handle.state::<KbEngine>();
        kb.remove_page(&db, &page_id);
    });
}

fn spawn_kb_sync_all(app: &AppHandle) {
    use tauri::Manager;
    if !app.state::<KbEngine>().is_enabled() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Database>();
        let kb = handle.state::<KbEngine>();
        kb.sync_all(&db);
    });
}

fn spawn_kb_sync_paths(app: &AppHandle, paths: Vec<String>) {
    use tauri::Manager;
    if paths.is_empty() || !app.state::<KbEngine>().is_enabled() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Database>();
        let kb = handle.state::<KbEngine>();
        kb.sync_disk_paths(&db, &paths);
    });
}

fn trigger_kb_rebind(app: &AppHandle, _db: &Database, kb: &KbEngine) {
    use tauri::Manager;
    kb.close_connection();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Database>();
        let kb = handle.state::<KbEngine>();
        kb.rebind_storage(&db);
    });
}

#[tauri::command]
pub fn list_pages(db: State<'_, Database>) -> Result<Vec<Page>, String> {
    db.list_pages().map_err(Into::into)
}

#[tauri::command]
pub fn list_trashed_pages(db: State<'_, Database>) -> Result<Vec<Page>, String> {
    db.list_trashed_pages().map_err(Into::into)
}

#[tauri::command]
pub fn get_page_detail(db: State<'_, Database>, id: String) -> Result<PageDetail, String> {
    db.get_page_detail(&id).map_err(Into::into)
}

#[tauri::command]
pub fn create_page(
    app: AppHandle,
    db: State<'_, Database>,
    input: CreatePageInput,
) -> Result<Page, String> {
    let page = db.create_page(input).map_err(String::from)?;
    spawn_kb_reindex_page(&app, page.id.clone());
    Ok(page)
}

#[tauri::command]
pub fn update_page(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
    patch: UpdatePagePatch,
) -> Result<Page, String> {
    let page = db.update_page(&id, patch).map_err(String::from)?;
    spawn_kb_reindex_page(&app, page.id.clone());
    Ok(page)
}

#[tauri::command]
pub fn trash_page(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    db.trash_page(&id).map_err(String::from)?;
    spawn_kb_remove_page(&app, id);
    Ok(())
}

#[tauri::command]
pub fn restore_page(app: AppHandle, db: State<'_, Database>, id: String) -> Result<Page, String> {
    let page = db.restore_page(&id).map_err(String::from)?;
    spawn_kb_reindex_page(&app, page.id.clone());
    Ok(page)
}

#[tauri::command]
pub fn delete_page_permanently(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    db.delete_page_permanently(&id).map_err(String::from)?;
    spawn_kb_remove_page(&app, id);
    Ok(())
}

#[tauri::command]
pub fn empty_trash(app: AppHandle, db: State<'_, Database>) -> Result<(), String> {
    db.empty_trash().map_err(String::from)?;
    spawn_kb_sync_all(&app);
    Ok(())
}

/* 我的模板 */
#[tauri::command]
pub fn list_custom_templates(db: State<'_, Database>) -> Result<Vec<crate::db::CustomTemplate>, String> {
    db.list_custom_templates().map_err(Into::into)
}

#[tauri::command]
pub fn save_page_as_template(
    db: State<'_, Database>,
    page_id: String,
    meta: Option<crate::db::TemplateMetaInput>,
    replace_id: Option<String>,
) -> Result<crate::db::CustomTemplate, String> {
    db.save_page_as_template(&page_id, meta.unwrap_or_default(), replace_id.as_deref()).map_err(Into::into)
}

#[tauri::command]
pub fn update_custom_template(
    db: State<'_, Database>,
    id: String,
    meta: crate::db::TemplateMetaInput,
) -> Result<crate::db::CustomTemplate, String> {
    db.update_custom_template_meta(&id, meta).map_err(Into::into)
}

#[tauri::command]
pub fn delete_custom_template(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_custom_template(&id).map_err(Into::into)
}

#[tauri::command]
pub fn import_custom_templates(db: State<'_, Database>, items: Vec<crate::db::CustomTemplate>) -> Result<usize, String> {
    db.import_custom_templates(items).map_err(Into::into)
}

#[tauri::command]
pub fn duplicate_page(app: AppHandle, db: State<'_, Database>, id: String) -> Result<Page, String> {
    let page = db.duplicate_page(&id).map_err(String::from)?;
    spawn_kb_reindex_page(&app, page.id.clone());
    Ok(page)
}

#[tauri::command]
pub fn list_open_todos(db: State<'_, Database>) -> Result<Vec<TodoItem>, String> {
    db.list_open_todos().map_err(String::from)
}

#[tauri::command]
pub fn upsert_block(
    app: AppHandle,
    db: State<'_, Database>,
    block: UpsertBlockInput,
) -> Result<Block, String> {
    let out = db.upsert_block(block).map_err(String::from)?;
    spawn_kb_reindex_page(&app, out.page_id.clone());
    Ok(out)
}

#[tauri::command]
pub fn save_page_blocks(
    app: AppHandle,
    db: State<'_, Database>,
    page_id: String,
    blocks: Vec<SaveBlockItem>,
) -> Result<Vec<Block>, String> {
    checkpoint_before_edit(&db, &page_id);
    let pid = page_id.clone();
    let out = db.save_page_blocks(&page_id, blocks).map_err(String::from)?;
    spawn_kb_reindex_page(&app, pid);
    Ok(out)
}

/// 编辑前按间隔自动保存一份历史版本（失败不影响保存）
fn checkpoint_before_edit(db: &Database, page_id: &str) {
    if let Ok(conn) = db.lock() {
        let _ = crate::versions::checkpoint(&conn, page_id, "edit", crate::versions::AUTO_GAP_MINUTES);
    }
}

#[tauri::command]
pub fn delete_block(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_block(&id).map_err(String::from)?;
    spawn_kb_sync_all(&app);
    Ok(())
}

#[tauri::command]
pub fn get_database(db: State<'_, Database>, page_id: String) -> Result<DatabaseFull, String> {
    db.get_database(&page_id).map_err(Into::into)
}

#[tauri::command]
pub fn update_database_view(
    db: State<'_, Database>,
    page_id: String,
    active_view: String,
    group_by_col_id: Option<String>,
) -> Result<DatabaseFull, String> {
    db.update_database_view(&page_id, &active_view, group_by_col_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn upsert_db_column(
    db: State<'_, Database>,
    column: UpsertDbColumnInput,
) -> Result<DbColumn, String> {
    db.upsert_db_column(column).map_err(Into::into)
}

#[tauri::command]
pub fn delete_db_column(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_db_column(&id).map_err(Into::into)
}

#[tauri::command]
pub fn upsert_db_row(
    app: AppHandle,
    db: State<'_, Database>,
    row: UpsertDbRowInput,
) -> Result<DbRow, String> {
    checkpoint_before_edit(&db, &row.page_id);
    let out = db.upsert_db_row(row).map_err(String::from)?;
    spawn_kb_reindex_page(&app, out.page_id.clone());
    Ok(out)
}

#[tauri::command]
pub fn delete_db_row(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_db_row(&id).map_err(String::from)?;
    spawn_kb_sync_all(&app);
    Ok(())
}

#[tauri::command]
pub fn search_workspace(
    db: State<'_, Database>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    db.search_workspace(&query).map_err(Into::into)
}

#[tauri::command]
pub fn export_page_markdown(
    db: State<'_, Database>,
    id: String,
) -> Result<MarkdownExport, String> {
    db.export_page_markdown(&id).map_err(Into::into)
}

#[tauri::command]
pub fn import_markdown_page(
    app: AppHandle,
    db: State<'_, Database>,
    title: String,
    markdown: String,
    parent_id: Option<String>,
) -> Result<Page, String> {
    let page = db
        .import_markdown_page(&title, &markdown, parent_id)
        .map_err(String::from)?;
    spawn_kb_reindex_page(&app, page.id.clone());
    Ok(page)
}

#[tauri::command]
pub async fn import_local_paths(
    app: AppHandle,
    paths: Vec<String>,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    use tauri::Manager;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let out = db.import_local_paths(paths, parent_id).map_err(String::from)?;
        Ok::<_, String>((out, app))
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_kb_sync_all(&res.1);
    Ok(res.0)
}

#[tauri::command]
pub async fn import_markdown_tree(
    app: AppHandle,
    entries: Vec<MarkdownTreeEntry>,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    use tauri::Manager;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let out = db.import_markdown_tree(entries, parent_id).map_err(String::from)?;
        Ok::<_, String>((out, app))
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_kb_sync_all(&res.1);
    Ok(res.0)
}

#[tauri::command]
pub async fn import_notion_zip_bytes(
    app: AppHandle,
    zip_base64: String,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    use tauri::Manager;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let out = db
            .import_notion_zip_bytes(&zip_base64, parent_id)
            .map_err(String::from)?;
        Ok::<_, String>((out, app))
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_kb_sync_all(&res.1);
    Ok(res.0)
}

#[tauri::command]
pub async fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || crate::url_meta::fetch_url_metadata_sync(&url))
        .await
        .map_err(|e| format!("Metadata worker join error: {}", e))?
        .map_err(Into::into)
}

#[tauri::command]
pub fn get_settings(db: State<'_, Database>) -> Result<HashMap<String, String>, String> {
    db.get_settings().map_err(Into::into)
}

#[tauri::command]
pub fn set_setting(
    app: AppHandle,
    db: State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(String::from)?;
    if key == "workspaceFolders" {
        spawn_kb_sync_all(&app);
    }
    Ok(())
}

/* ============================================================================
 * Commercial v0.2.0 Portable Storage, Win32 Dialogs, Typora Local .md & Backups
 * ========================================================================== */

#[tauri::command]
pub fn get_storage_info(db: State<'_, Database>) -> Result<StorageConfigInfo, String> {
    db.get_storage_info().map_err(Into::into)
}

#[tauri::command]
pub fn update_storage_config(
    app: AppHandle,
    db: State<'_, Database>,
    kb: State<'_, KbEngine>,
    input: UpdateStorageConfigInput,
) -> Result<StorageConfigInfo, String> {
    kb.close_connection();
    let info = db.update_storage_config(input).map_err(String::from)?;
    trigger_kb_rebind(&app, &db, &kb);
    Ok(info)
}

#[tauri::command]
pub fn reset_storage_to_default(
    app: AppHandle,
    db: State<'_, Database>,
    kb: State<'_, KbEngine>,
    migrate_existing_data: Option<bool>,
) -> Result<StorageConfigInfo, String> {
    kb.close_connection();
    let info = db
        .reset_storage_to_default(migrate_existing_data.unwrap_or(true))
        .map_err(String::from)?;
    trigger_kb_rebind(&app, &db, &kb);
    Ok(info)
}

#[tauri::command]
pub fn sync_all_pages_to_markdown(db: State<'_, Database>) -> Result<usize, String> {
    db.sync_all_pages_to_markdown().map_err(Into::into)
}

#[tauri::command]
pub async fn pick_folder_dialog(
    app: AppHandle,
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    run_dialog(&app, move || {
        crate::win_dialogs::pick_folder_dialog_sync(default_path, title)
    })
    .await
}

#[tauri::command]
pub async fn pick_markdown_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    run_dialog(&app, crate::win_dialogs::pick_markdown_file_dialog_sync).await
}

#[tauri::command]
pub async fn save_markdown_file_dialog(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    run_dialog(&app, move || {
        crate::win_dialogs::save_markdown_file_dialog_sync(default_name, content)
    })
    .await
}

#[tauri::command]
pub async fn save_svg_file_dialog(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    run_dialog(&app, move || {
        crate::win_dialogs::save_svg_file_dialog_sync(default_name, content)
    })
    .await
}

#[tauri::command]
pub async fn pick_font_file_dialog(
    app: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    run_dialog(&app, move || {
        crate::win_dialogs::pick_font_file_dialog_sync(default_dir)
    })
    .await
}

#[tauri::command]
pub async fn load_custom_font_file(
    app: AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        db.resolve_and_read_custom_font(&path).map_err(String::from)
    })
    .await
    .map_err(|e| format!("字体加载线程错误：{}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn import_font_to_data_dir(
    db: State<'_, Database>,
    path: String,
) -> Result<ImportedCustomFont, String> {
    db.import_custom_font_to_data_dir(&path).map_err(Into::into)
}

#[tauri::command]
pub async fn open_local_markdown_file(file_path: String) -> Result<LocalMarkdownDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::open_local_markdown_file_disk(&file_path).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_local_markdown_file(
    app: AppHandle,
    file_path: String,
    blocks: Option<Vec<SaveBlockItem>>,
    raw_markdown: Option<String>,
    expected_updated_at: Option<String>,
) -> Result<LocalMarkdownDocument, String> {
    let doc = tauri::async_runtime::spawn_blocking(move || {
        crate::storage::save_local_markdown_file_checked(
            &file_path,
            blocks,
            raw_markdown,
            expected_updated_at.as_deref(),
        )
        .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_kb_sync_paths(&app, vec![doc.file_path.clone()]);
    Ok(doc)
}

#[tauri::command]
pub fn convert_markdown_blocks(
    markdown: Option<String>,
    blocks: Option<Vec<SaveBlockItem>>,
    page_id: Option<String>,
) -> Result<LocalMarkdownDocument, String> {
    crate::storage::convert_markdown_blocks_pure(markdown, blocks, page_id).map_err(Into::into)
}

#[tauri::command]
pub fn save_asset_image(
    db: State<'_, Database>,
    filename: String,
    data_base64: String,
    mime_type: String,
) -> Result<SavedAssetResult, String> {
    db.save_asset_image(&filename, &data_base64, &mime_type)
        .map_err(Into::into)
}

/// 粘贴到磁盘笔记的图片：存到笔记所在目录的 assets/ 下，返回相对路径
#[tauri::command]
pub fn save_local_note_image(
    note_path: String,
    filename: String,
    data_base64: String,
    mime_type: String,
) -> Result<crate::storage::LocalNoteImage, String> {
    crate::storage::save_local_note_image_disk(&note_path, &filename, &data_base64, &mime_type)
        .map_err(Into::into)
}

#[tauri::command]
pub fn open_path_in_explorer(path: String) -> Result<(), String> {
    crate::win_dialogs::open_path_in_explorer_sync(&path).map_err(Into::into)
}

/// 用文本编辑器打开文件；encoding 为空时自动识别
#[tauri::command]
pub async fn open_text_file(
    path: String,
    encoding: Option<String>,
) -> Result<crate::textfile::TextFileDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::textfile::open_text_file(&path, encoding.as_deref().filter(|e| !e.is_empty()))
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存文本文件，保留编码与换行符；expected_modified_ms 用于检测外部修改
#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    path: String,
    content: String,
    encoding: String,
    line_ending: String,
    expected_modified_ms: Option<u64>,
) -> Result<crate::textfile::TextSaveResult, String> {
    let kb_path = path.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        crate::textfile::save_text_file(&path, &content, &encoding, &line_ending, expected_modified_ms)
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())??;
    spawn_kb_sync_paths(&app, vec![kb_path]);
    Ok(res)
}

/// 用系统默认程序打开文件（图片、PDF、Office 文档等）
#[tauri::command]
pub fn open_with_system_app(path: String) -> Result<(), String> {
    let norm = crate::win_dialogs::normalize_win32_path_str(&path);
    if !std::path::Path::new(&norm).exists() {
        return Err(format!("文件不存在：{}", norm));
    }
    #[cfg(target_os = "windows")]
    // 不经过 cmd：文件名里的 & 等字符不会被当成命令
    let res = std::process::Command::new("explorer.exe").arg(&norm).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&norm).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(&norm).spawn();
    res.map(|_| ()).map_err(|e| format!("无法打开：{}", e))
}

/// 侧栏「文件夹」：列出一层子文件夹与笔记文件（在后台线程池读取，绝不阻塞 GUI 主线程）
#[tauri::command]
pub async fn list_folder_entries(path: String) -> Result<crate::folders::FolderListing, String> {
    tauri::async_runtime::spawn_blocking(move || crate::folders::list_folder(&path).map_err(String::from))
        .await
        .map_err(|e| e.to_string())?
}

/// 在文件夹里新建笔记（is_dir = false）或子文件夹
#[tauri::command]
pub fn create_folder_entry(
    parent: String,
    name: String,
    is_dir: bool,
) -> Result<crate::folders::FolderEntry, String> {
    crate::folders::create_entry(&parent, &name, is_dir).map_err(Into::into)
}

/// 在原目录内重命名文件或文件夹
#[tauri::command]
pub fn rename_folder_entry(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<crate::folders::FolderEntry, String> {
    let entry = crate::folders::rename_entry(&path, &new_name).map_err(String::from)?;
    spawn_kb_sync_all(&app);
    Ok(entry)
}

/// 拖拽：把文件或文件夹移动到另一个文件夹
#[tauri::command]
pub fn move_folder_entry(
    app: AppHandle,
    path: String,
    target_dir: String,
) -> Result<crate::folders::FolderEntry, String> {
    let entry = crate::folders::move_entry(&path, &target_dir).map_err(String::from)?;
    spawn_kb_sync_all(&app);
    Ok(entry)
}

/// 移到系统回收站
#[tauri::command]
pub async fn trash_folder_entry(app: AppHandle, path: String) -> Result<(), String> {
    let kb_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || crate::folders::trash_entry(&path).map_err(String::from))
        .await
        .map_err(|e| e.to_string())??;
    spawn_kb_sync_paths(&app, vec![kb_path]);
    Ok(())
}

/// 在挂载的文件夹里全文搜索笔记；roots 为 [路径, 显示名]
#[tauri::command]
pub async fn search_folder_notes(
    roots: Vec<(String, String)>,
    query: String,
) -> Result<Vec<crate::folders::FolderSearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::folders::search_notes(&roots, &query))
        .await
        .map_err(|e| e.to_string())
}

/// 设置要监听的文件夹（递归）与文件；有变化时发出 "xynote://fs-changed" 事件，携带变化的路径
#[tauri::command]
pub async fn set_watched_paths(
    app: AppHandle,
    dirs: Vec<String>,
    files: Vec<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let watcher = app.state::<crate::watch::FsWatcher>();
        let app_emit = app.clone();
        watcher.set_targets(dirs, files, move |paths| {
            let kb_paths = paths.clone();
            let _ = app_emit.emit("xynote://fs-changed", paths);
            spawn_kb_sync_paths(&app_emit, kb_paths);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用系统默认浏览器打开网址（只允许 http / https / mailto）
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        || u.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"')
    {
        return Err("只能打开 http / https / mailto 链接".into());
    }
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", u]).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(u).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(u).spawn();
    res.map(|_| ()).map_err(|e| e.to_string())
}

/* ---------------- 同步 ---------------- */

#[tauri::command]
pub fn x_c0(db: State<'_, Database>) -> Result<crate::sync_config::SyncConfigView, String> {
    crate::sync_config::load_view(&db).map_err(Into::into)
}

#[tauri::command]
pub fn x_c1(
    db: State<'_, Database>,
    input: crate::sync_config::SyncConfigInput,
) -> Result<crate::sync_config::SyncConfigView, String> {
    crate::sync_config::save_config(&db, input).map_err(Into::into)
}

/// 立即同步（在后台线程执行，不阻塞界面）；本地模式返回 null
#[tauri::command]
pub async fn x_c2(app: AppHandle) -> Result<Option<crate::sync::SyncReport>, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let report = crate::sync_config::sync_now(&db).map_err(|e| e.to_string())?;
        if report.is_some() {
            let kb = app.state::<KbEngine>();
            kb.sync_all(&db);
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 登录或注册同步服务器（official = true 时为官方服务；action = "login" | "register"）
#[tauri::command]
pub async fn x_c3(
    app: AppHandle,
    official: bool,
    action: String,
    email: String,
    password: String,
) -> Result<crate::sync_remote::AccountInfo, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        crate::sync_config::auth(&db, official, &action, &email, &password).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn x_c4(app: AppHandle, official: bool) -> Result<crate::sync_remote::AccountInfo, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        crate::sync_config::account(&db, official).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn x_c5(app: AppHandle, official: bool, code: String) -> Result<crate::sync_remote::AccountInfo, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        crate::sync_config::redeem(&db, official, &code).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn x_c6(db: State<'_, Database>, official: bool) -> Result<(), String> {
    crate::sync_config::logout(&db, official).map_err(Into::into)
}

#[tauri::command]
pub fn list_backups(db: State<'_, Database>) -> Result<Vec<BackupEntry>, String> {
    db.list_backups().map_err(Into::into)
}

#[tauri::command]
pub fn create_backup_now(db: State<'_, Database>) -> Result<BackupEntry, String> {
    db.create_backup_now().map_err(Into::into)
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    db: State<'_, Database>,
    kb: State<'_, KbEngine>,
    backup_path: String,
) -> Result<StorageConfigInfo, String> {
    kb.close_connection();
    let info = db.restore_backup(&backup_path).map_err(String::from)?;
    trigger_kb_rebind(&app, &db, &kb);
    Ok(info)
}

#[tauri::command]
pub async fn export_workspace_zip_dialog(
    app: AppHandle,
    db: State<'_, Database>,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let target_name = default_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "notion-workspace-backup.zip".to_string());

    let picked_path = run_dialog(&app, move || {
        crate::win_dialogs::pick_save_zip_path_dialog_sync(target_name)
    })
    .await?;

    let Some(save_path) = picked_path else {
        return Ok(None);
    };

    let zip_bytes = db.build_workspace_zip_bytes().map_err(String::from)?;
    if let Some(parent) = Path::new(&save_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&save_path, &zip_bytes).map_err(|e| e.to_string())?;
    Ok(Some(save_path))
}

/* ============================================================================
 * Commercial v0.3.0 Theme & Style Plugin Engine (5 Themes + 5 Snippets + CSS/JSON Import/Export)
 * ========================================================================== */

#[tauri::command]
pub fn list_style_plugins(db: State<'_, Database>) -> Result<StylePluginState, String> {
    db.list_style_plugins().map_err(Into::into)
}

#[tauri::command]
pub fn save_style_plugin(
    db: State<'_, Database>,
    input: SaveStylePluginInput,
) -> Result<StylePluginItem, String> {
    db.save_style_plugin(input).map_err(Into::into)
}

#[tauri::command]
pub fn toggle_style_plugin(
    db: State<'_, Database>,
    id: String,
    enabled: bool,
) -> Result<StylePluginState, String> {
    db.toggle_style_plugin(&id, enabled).map_err(Into::into)
}

#[tauri::command]
pub fn delete_style_plugin(db: State<'_, Database>, id: String) -> Result<StylePluginState, String> {
    db.delete_style_plugin(&id).map_err(Into::into)
}

#[tauri::command]
pub async fn import_style_plugin_dialog(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<Option<StylePluginItem>, String> {
    let default_dir = db.active_plugins_dir_opt();
    let picked = run_dialog(&app, move || {
        crate::win_dialogs::pick_style_plugin_file_dialog_sync(default_dir)
    })
    .await?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let p = Path::new(&file_path);
    let fname = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported-style.css".to_string());
    let raw_bytes = std::fs::read(p).map_err(|e| format!("无法读取插件文件: {}", e))?;
    let content = String::from_utf8(raw_bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());

    let item = db
        .import_style_plugin_content(&fname, &content)
        .map_err(String::from)?;
    Ok(Some(item))
}

#[tauri::command]
pub fn import_style_plugin_content(
    db: State<'_, Database>,
    filename: String,
    content: String,
) -> Result<StylePluginItem, String> {
    db.import_style_plugin_content(&filename, &content)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn export_style_plugin_dialog(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
) -> Result<Option<String>, String> {
    let (item, default_fname, content) = db
        .serialize_style_plugin_for_export(&id)
        .map_err(String::from)?;
    let default_dir = db.active_plugins_dir_opt();
    let is_theme = item.kind == "theme";

    run_dialog(&app, move || {
        crate::win_dialogs::save_style_plugin_file_dialog_sync(
            default_dir,
            default_fname,
            is_theme,
            content,
        )
    })
    .await
}

/* ---------------- 永久版 ---------------- */

#[tauri::command]
pub fn x_s0(db: State<'_, Database>) -> Result<crate::license::LicenseStatus, String> {
    crate::license::status(&db).map_err(Into::into)
}

/// 授权相关的网络操作放在后台线程，避免卡住界面
async fn license_blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&Database) -> Result<T, crate::models::AppError> + Send + 'static,
) -> Result<T, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        f(&db).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn x_s1(app: AppHandle, account: String, password: String) -> Result<crate::license::LicenseStatus, String> {
    license_blocking(app, move |db| crate::license::login(db, &account, &password)).await
}

#[tauri::command]
pub async fn x_s2(app: AppHandle) -> Result<crate::license::LicenseStatus, String> {
    license_blocking(app, crate::license::refresh).await
}

#[tauri::command]
pub async fn x_s3(app: AppHandle, license: String) -> Result<crate::license::LicenseStatus, String> {
    license_blocking(app, move |db| crate::license::activate(db, &license)).await
}

#[tauri::command]
pub async fn x_s4(app: AppHandle) -> Result<crate::license::LicenseStatus, String> {
    license_blocking(app, crate::license::deactivate).await
}

#[tauri::command]
pub fn x_s5(db: State<'_, Database>) -> Result<crate::license::LicenseStatus, String> {
    crate::license::logout(&db).map_err(Into::into)
}

#[tauri::command]
pub async fn x_s6(app: AppHandle, product: Option<String>) -> Result<serde_json::Value, String> {
    let product = product.unwrap_or_else(|| "lifetime".into());
    license_blocking(app, move |db| crate::license::create_order(db, &product)).await
}

#[tauri::command]
pub async fn x_s7(app: AppHandle, category: String, content: String, contact: String) -> Result<(), String> {
    license_blocking(app, move |db| crate::license::submit_feedback(db, &category, &content, &contact)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExport {
    pub filename: String,
    pub html: String,
}

/// 页面导出为 HTML（也用于打印成 PDF）
#[tauri::command]
pub fn export_page_html(db: State<'_, Database>, page_id: String) -> Result<HtmlExport, String> {
    let md = db.export_page_markdown(&page_id).map_err(String::from)?;
    let base = crate::export_formats::base_filename(&md.filename);
    Ok(HtmlExport { html: crate::export_formats::markdown_to_html_document(&base, &md.markdown), filename: base })
}

/// 磁盘 Markdown 文档导出为 HTML（用于 PDF 打印与长图导出）
#[tauri::command]
pub fn export_markdown_html(filename: String, markdown: String) -> Result<HtmlExport, String> {
    let base = crate::export_formats::base_filename(&filename);
    Ok(HtmlExport {
        html: crate::export_formats::markdown_to_html_document(&base, &markdown),
        filename: base,
    })
}

async fn export_markdown_and_save(
    app: AppHandle,
    raw_filename: String,
    markdown: String,
    format: String,
) -> Result<Option<String>, String> {
    let base = crate::export_formats::base_filename(&raw_filename);
    let (bytes, ext, label, title) = match format.as_str() {
        "md" | "markdown" => (markdown.into_bytes(), "md", "Markdown 文件", "导出为 Markdown"),
        "docx" => {
            let bytes = crate::export_formats::markdown_to_docx(&base, &markdown).map_err(String::from)?;
            (bytes, "docx", "Word 文档", "导出为 Word 文档")
        }
        "html" => {
            let html = crate::export_formats::markdown_to_html_document(&base, &markdown);
            (html.into_bytes(), "html", "网页文件", "导出为 HTML")
        }
        "epub" => {
            let bytes = crate::export_more::markdown_to_epub(&base, &markdown).map_err(String::from)?;
            (bytes, "epub", "EPUB 电子书", "导出为 EPUB 电子书")
        }
        "opml" => {
            let opml = crate::export_more::markdown_to_opml(&base, &markdown);
            (opml.into_bytes(), "opml", "OPML 思维导图 / 大纲", "导出为思维导图 (OPML)")
        }
        // LaTeX 的图片文件夹要跟随保存的文件名，选好路径后再生成
        "latex" => (markdown.into_bytes(), "tex", "LaTeX 文件", "导出为 LaTeX"),
        other => return Err(format!("不支持的导出格式：{}", other)),
    };
    let is_latex = format == "latex";
    let base_for_latex = base.clone();
    let picked = run_dialog(&app, move || {
        crate::win_dialogs::pick_save_path_dialog_sync(title.to_string(), base, ext.to_string(), label.to_string())
    })
    .await?;
    let Some(path) = picked else { return Ok(None) };
    if is_latex {
        let md_text = String::from_utf8(bytes).unwrap_or_default();
        let target = std::path::Path::new(&path);
        let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
        let image_dir = format!("{}_images", stem);
        let bundle = crate::export_more::markdown_to_latex(&base_for_latex, &md_text, &image_dir);
        std::fs::write(&path, &bundle.bytes).map_err(|e| format!("保存失败：{}", e))?;
        let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for (rel, data) in bundle.extra_files {
            let file = parent.join(&rel);
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("保存图片失败：{}", e))?;
            }
            std::fs::write(&file, data).map_err(|e| format!("保存图片失败：{}", e))?;
        }
        return Ok(Some(path));
    }
    std::fs::write(&path, bytes).map_err(|e| format!("保存失败：{}", e))?;
    Ok(Some(path))
}

/// 页面导出为 HTML / Word / EPUB / LaTeX / OPML / Markdown 文件：弹出另存为对话框，返回保存路径（取消时为 null）
#[tauri::command]
pub async fn export_page_file(app: AppHandle, page_id: String, format: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    let (filename, markdown) = {
        let db = app.state::<Database>();
        let md = db.export_page_markdown(&page_id).map_err(String::from)?;
        (md.filename, md.markdown)
    };
    export_markdown_and_save(app, filename, markdown, format).await
}

/// 磁盘 Markdown 文件导出为多种格式（与工作区页面共享全套 8 种导出能力）
#[tauri::command]
pub async fn export_markdown_file(
    app: AppHandle,
    filename: String,
    markdown: String,
    format: String,
) -> Result<Option<String>, String> {
    export_markdown_and_save(app, filename, markdown, format).await
}

/// 保存前端生成的图片（PNG）。页面很长时分成多张：第一张用选择的文件名，其余加 -2、-3…
#[tauri::command]
pub async fn save_export_images(app: AppHandle, filename: String, parts: Vec<String>) -> Result<Option<String>, String> {
    let images = crate::export_more::decode_parts(&parts).map_err(String::from)?;
    if images.is_empty() {
        return Err("没有可保存的图片".into());
    }
    let picked = run_dialog(&app, move || {
        crate::win_dialogs::pick_save_path_dialog_sync("导出为图片".to_string(), filename, "png".to_string(), "PNG 图片".to_string())
    })
    .await?;
    let Some(path) = picked else { return Ok(None) };
    let target = std::path::PathBuf::from(&path);
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    for (i, bytes) in images.iter().enumerate() {
        let file = if i == 0 { target.clone() } else { target.with_file_name(format!("{}-{}.png", stem, i + 1)) };
        std::fs::write(&file, bytes).map_err(|e| format!("保存失败：{}", e))?;
    }
    Ok(Some(path))
}

/// 新建一个窗口（可以同时开多个）；page_id 有值时新窗口直接打开这个页面
#[tauri::command]
pub async fn open_new_window(app: AppHandle, page_id: Option<String>) -> Result<String, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!("win-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let mut url = "index.html".to_string();
    if let Some(id) = page_id.filter(|v| !v.trim().is_empty()) {
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        url.push_str(&format!("?page={}", safe));
    } else {
        // 全新窗口：不恢复上次的页面和侧栏状态
        url.push_str("?fresh=1");
    }
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("小悦 (XyNote)")
        .inner_size(1180.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true);
    // 与主窗口一致：标题栏由界面自己绘制，跟随主题配色
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);
    builder.build().map_err(|e| format!("无法打开新窗口：{}", e))?;
    Ok(label)
}

/// 拖入的文件复制成附件；返回成功的和失败原因
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachPathsResult {
    pub items: Vec<crate::attachments::AttachmentInfo>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn attach_paths(app: AppHandle, paths: Vec<String>) -> Result<AttachPathsResult, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let mut out = AttachPathsResult { items: Vec::new(), errors: Vec::new() };
        for p in paths {
            match crate::attachments::attach_from_path(&db, &p) {
                Ok(info) => out.items.push(info),
                Err(e) => {
                    let name = Path::new(&p).file_name().and_then(|s| s.to_str()).unwrap_or(&p).to_string();
                    out.errors.push(format!("{}：{}", name, String::from(e)));
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn attach_file_bytes(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<crate::attachments::AttachmentInfo, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        crate::attachments::attach_from_bytes(&db, &file_name, &data_base64).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_attachment(db: State<'_, Database>, rel_path: String) -> Result<(), String> {
    let full = crate::attachments::resolve(&db, &rel_path).map_err(String::from)?;
    crate::attachments::open_with_default_app(&full).map_err(String::from)
}

#[tauri::command]
pub fn reveal_attachment(db: State<'_, Database>, rel_path: String) -> Result<(), String> {
    let full = crate::attachments::resolve(&db, &rel_path).map_err(String::from)?;
    crate::win_dialogs::open_path_in_explorer_sync(&full.to_string_lossy()).map_err(Into::into)
}

/// 把网页图片下载成本地图片，返回 data URL
#[tauri::command]
pub async fn download_image_asset(app: AppHandle, url: String) -> Result<String, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        crate::attachments::download_remote_image(&db, &url).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 快速记录与托盘的当前设置
#[tauri::command]
pub fn quick_capture_get_config(app: AppHandle, db: State<'_, Database>) -> crate::quick::QuickCaptureConfig {
    crate::quick::current_config(&app, &db)
}

/// 修改快速记录快捷键、托盘与「关闭到托盘」。快捷键注册失败时恢复原来的并返回错误。
#[tauri::command]
pub fn quick_capture_set_config(
    app: AppHandle,
    db: State<'_, Database>,
    shortcut: String,
    tray: bool,
    close_to_tray: bool,
) -> Result<crate::quick::QuickCaptureConfig, String> {
    use crate::quick::*;
    let (old_shortcut, _, _) = read_config(&db);
    let shortcut = shortcut.trim().to_string();
    if shortcut != old_shortcut {
        if let Err(e) = apply_shortcut(&app, &shortcut) {
            let _ = apply_shortcut(&app, &old_shortcut);
            return Err(e);
        }
        db.set_setting(SETTING_SHORTCUT, &shortcut).map_err(String::from)?;
    }
    db.set_setting(SETTING_TRAY, if tray { "true" } else { "false" })
        .map_err(String::from)?;
    db.set_setting(SETTING_CLOSE_TO_TRAY, if close_to_tray { "true" } else { "false" })
        .map_err(String::from)?;
    if tray {
        if let Err(e) = setup_tray(&app) {
            return Err(e);
        }
    } else {
        remove_tray(&app);
    }
    Ok(current_config(&app, &db))
}

/// 隐藏快速记录小窗
#[tauri::command]
pub fn quick_capture_hide(app: AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(crate::quick::QUICK_LABEL) {
        let _ = w.hide();
    }
}

/// 检查更新：读取 GitHub 上最新发布的版本
#[tauri::command]
pub async fn check_for_update() -> Result<crate::updater::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(crate::updater::check)
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into)
}

#[tauri::command]
pub fn page_versions_list(db: State<'_, Database>, page_id: String) -> Result<Vec<crate::versions::PageVersionMeta>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    crate::versions::list(&conn, &page_id).map_err(Into::into)
}

#[tauri::command]
pub fn page_version_get(db: State<'_, Database>, version_id: String) -> Result<crate::versions::PageVersionView, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    crate::versions::get(&conn, &version_id).map_err(Into::into)
}

#[tauri::command]
pub fn page_version_restore(
    app: AppHandle,
    db: State<'_, Database>,
    version_id: String,
) -> Result<String, String> {
    let page_id = {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let page_id = crate::versions::restore(&tx, &version_id).map_err(String::from)?;
        tx.commit().map_err(|e| e.to_string())?;
        crate::storage::after_tree_mutated(&conn);
        page_id
    };
    spawn_kb_reindex_page(&app, page_id.clone());
    Ok(page_id)
}

#[tauri::command]
pub fn take_pending_open_files(
    launch: State<'_, crate::file_assoc::LaunchFilesState>,
) -> Vec<String> {
    launch.take_pending()
}

#[tauri::command]
pub fn get_shell_integration_status() -> crate::file_assoc::ShellIntegrationStatus {
    crate::file_assoc::get_shell_integration_status()
}

#[tauri::command]
pub async fn register_shell_integration(
    app: AppHandle,
) -> Result<crate::file_assoc::ShellIntegrationStatus, String> {
    use tauri::Manager;
    let status = tauri::async_runtime::spawn_blocking(crate::file_assoc::register_windows_shell_integration)
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)?;
    let _ = app.state::<Database>().set_setting("winShellIntegration", "enabled");
    Ok(status)
}

#[tauri::command]
pub async fn unregister_shell_integration(
    app: AppHandle,
) -> Result<crate::file_assoc::ShellIntegrationStatus, String> {
    use tauri::Manager;
    let status = tauri::async_runtime::spawn_blocking(crate::file_assoc::unregister_windows_shell_integration)
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)?;
    let _ = app.state::<Database>().set_setting("winShellIntegration", "disabled");
    Ok(status)
}

#[tauri::command]
pub async fn prompt_default_md_association(
    app: AppHandle,
) -> Result<crate::file_assoc::ShellIntegrationStatus, String> {
    use tauri::Manager;
    let status = tauri::async_runtime::spawn_blocking(crate::file_assoc::prompt_windows_default_md_dialog)
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)?;
    let _ = app.state::<Database>().set_setting("winShellIntegration", "enabled");
    Ok(status)
}

/* ============================================================================
 * Hot-Pluggable SAG2 Local Knowledge Base Engine (kb_index.db, Default OFF)
 * ========================================================================== */

#[tauri::command]
pub async fn kb_get_status(app: AppHandle) -> Result<crate::kb::KbStatus, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let kb = app.state::<KbEngine>();
        kb.get_status(&db).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_set_enabled(
    app: AppHandle,
    enabled: bool,
    purge_index: Option<bool>,
) -> Result<crate::kb::KbStatus, String> {
    use tauri::Manager;
    let purge = purge_index.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let kb = app.state::<KbEngine>();
        kb.set_enabled(&db, enabled, purge).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_set_config(
    app: AppHandle,
    include_folders: Option<bool>,
    show_related_panel: Option<bool>,
) -> Result<crate::kb::KbStatus, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let kb = app.state::<KbEngine>();
        kb.set_config(&db, include_folders, show_related_panel)
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_rebuild_index(
    app: AppHandle,
    force_full: Option<bool>,
) -> Result<crate::kb::KbStatus, String> {
    use tauri::Manager;
    let full = force_full.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let kb = app.state::<KbEngine>();
        kb.rebuild_index(&db, full).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_purge_index(app: AppHandle) -> Result<crate::kb::KbStatus, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        let kb = app.state::<KbEngine>();
        kb.purge_index(&db).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_search(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
    hops: Option<u8>,
) -> Result<crate::kb::KbSearchResponse, String> {
    use tauri::Manager;
    let lim = limit.unwrap_or(24);
    let hp = hops.unwrap_or(1);
    tauri::async_runtime::spawn_blocking(move || {
        let kb = app.state::<KbEngine>();
        kb.search(&query, lim, hp).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_related_for_context(
    app: AppHandle,
    source_kind: String,
    ref_id: String,
    title: String,
    content_text: String,
    limit: Option<usize>,
) -> Result<crate::kb::KbRelatedResponse, String> {
    use tauri::Manager;
    let lim = limit.unwrap_or(8);
    tauri::async_runtime::spawn_blocking(move || {
        let kb = app.state::<KbEngine>();
        kb.related_for_context(&source_kind, &ref_id, &title, &content_text, lim)
            .map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_entity_events(
    app: AppHandle,
    entity_name: String,
    limit: Option<usize>,
) -> Result<Vec<crate::kb::KbSearchHit>, String> {
    use tauri::Manager;
    let lim = limit.unwrap_or(30);
    tauri::async_runtime::spawn_blocking(move || {
        let kb = app.state::<KbEngine>();
        kb.entity_events(&entity_name, lim).map_err(String::from)
    })
    .await
    .map_err(|e| e.to_string())?
}
