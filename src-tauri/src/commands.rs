use crate::db::Database;
use crate::models::{
    AppError, BackupEntry, BatchImportResult, Block, CreatePageInput, DatabaseFull, DbColumn,
    DbRow, LocalMarkdownDocument, MarkdownExport, MarkdownTreeEntry, Page, PageDetail,
    SaveBlockItem, SaveStylePluginInput, SavedAssetResult, SearchResult, StorageConfigInfo,
    StylePluginItem, StylePluginState, UpdatePagePatch, UpdateStorageConfigInput,
    UpsertBlockInput, UpsertDbColumnInput, UpsertDbRowInput, UrlMetadata,
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
pub fn create_page(db: State<'_, Database>, input: CreatePageInput) -> Result<Page, String> {
    db.create_page(input).map_err(Into::into)
}

#[tauri::command]
pub fn update_page(
    db: State<'_, Database>,
    id: String,
    patch: UpdatePagePatch,
) -> Result<Page, String> {
    db.update_page(&id, patch).map_err(Into::into)
}

#[tauri::command]
pub fn trash_page(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.trash_page(&id).map_err(Into::into)
}

#[tauri::command]
pub fn restore_page(db: State<'_, Database>, id: String) -> Result<Page, String> {
    db.restore_page(&id).map_err(Into::into)
}

#[tauri::command]
pub fn delete_page_permanently(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_page_permanently(&id).map_err(Into::into)
}

#[tauri::command]
pub fn empty_trash(db: State<'_, Database>) -> Result<(), String> {
    db.empty_trash().map_err(Into::into)
}

#[tauri::command]
pub fn duplicate_page(db: State<'_, Database>, id: String) -> Result<Page, String> {
    db.duplicate_page(&id).map_err(Into::into)
}

#[tauri::command]
pub fn upsert_block(db: State<'_, Database>, block: UpsertBlockInput) -> Result<Block, String> {
    db.upsert_block(block).map_err(Into::into)
}

#[tauri::command]
pub fn save_page_blocks(
    db: State<'_, Database>,
    page_id: String,
    blocks: Vec<SaveBlockItem>,
) -> Result<Vec<Block>, String> {
    db.save_page_blocks(&page_id, blocks).map_err(Into::into)
}

#[tauri::command]
pub fn delete_block(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_block(&id).map_err(Into::into)
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
pub fn upsert_db_row(db: State<'_, Database>, row: UpsertDbRowInput) -> Result<DbRow, String> {
    db.upsert_db_row(row).map_err(Into::into)
}

#[tauri::command]
pub fn delete_db_row(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_db_row(&id).map_err(Into::into)
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
    db: State<'_, Database>,
    title: String,
    markdown: String,
    parent_id: Option<String>,
) -> Result<Page, String> {
    db.import_markdown_page(&title, &markdown, parent_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn import_local_paths(
    db: State<'_, Database>,
    paths: Vec<String>,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    db.import_local_paths(paths, parent_id).map_err(Into::into)
}

#[tauri::command]
pub fn import_markdown_tree(
    db: State<'_, Database>,
    entries: Vec<MarkdownTreeEntry>,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    db.import_markdown_tree(entries, parent_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn import_notion_zip_bytes(
    db: State<'_, Database>,
    zip_base64: String,
    parent_id: Option<String>,
) -> Result<BatchImportResult, String> {
    db.import_notion_zip_bytes(&zip_base64, parent_id)
        .map_err(Into::into)
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
pub fn set_setting(db: State<'_, Database>, key: String, value: String) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(Into::into)
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
    db: State<'_, Database>,
    input: UpdateStorageConfigInput,
) -> Result<StorageConfigInfo, String> {
    db.update_storage_config(input).map_err(Into::into)
}

#[tauri::command]
pub fn reset_storage_to_default(
    db: State<'_, Database>,
    migrate_existing_data: Option<bool>,
) -> Result<StorageConfigInfo, String> {
    db.reset_storage_to_default(migrate_existing_data.unwrap_or(true))
        .map_err(Into::into)
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
pub fn open_local_markdown_file(file_path: String) -> Result<LocalMarkdownDocument, String> {
    crate::storage::open_local_markdown_file_disk(&file_path).map_err(Into::into)
}

#[tauri::command]
pub fn save_local_markdown_file(
    file_path: String,
    blocks: Option<Vec<SaveBlockItem>>,
    raw_markdown: Option<String>,
) -> Result<LocalMarkdownDocument, String> {
    crate::storage::save_local_markdown_file_disk(&file_path, blocks, raw_markdown)
        .map_err(Into::into)
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

#[tauri::command]
pub fn open_path_in_explorer(path: String) -> Result<(), String> {
    crate::win_dialogs::open_path_in_explorer_sync(&path).map_err(Into::into)
}

/// 侧栏「文件夹」：列出一层子文件夹与笔记文件
#[tauri::command]
pub fn list_folder_entries(path: String) -> Result<crate::folders::FolderListing, String> {
    crate::folders::list_folder(&path).map_err(Into::into)
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
    path: String,
    new_name: String,
) -> Result<crate::folders::FolderEntry, String> {
    crate::folders::rename_entry(&path, &new_name).map_err(Into::into)
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
    db: State<'_, Database>,
    backup_path: String,
) -> Result<StorageConfigInfo, String> {
    db.restore_backup(&backup_path).map_err(Into::into)
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
