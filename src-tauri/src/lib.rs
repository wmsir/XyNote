pub mod folders;
pub mod textfile;
pub mod watch;
pub mod sync;
pub mod sync_remote;
pub mod sync_config;
pub mod license_format;
pub mod license;
pub mod versions;
pub mod export_formats;
#[cfg(not(test))]
pub mod commands;
pub mod db;
pub mod importer;
pub mod markdown;
pub mod models;
pub mod plugins;
pub mod storage;
pub mod url_meta;
pub mod win_dialogs;

#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use db::Database;
    use tauri::Manager;

    tauri::Builder::default()
        .setup(|app| {
            let fallback_app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app_data_dir: {}", e))?;
            let raw_exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()));
            let exe_dir = match raw_exe_dir {
                #[cfg(target_os = "macos")]
                Some(dir) if dir.to_string_lossy().contains(".app/Contents/MacOS") => {
                    fallback_app_data_dir.clone()
                }
                Some(dir) => dir,
                None => fallback_app_data_dir.clone(),
            };
            let database = Database::open_portable(&exe_dir, &fallback_app_data_dir, true)
                .map_err(|e| format!("Failed to initialize portable SQLite database: {}", e))?;
            app.manage(database);
            app.manage(watch::FsWatcher::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
            commands::list_trashed_pages,
            commands::get_page_detail,
            commands::create_page,
            commands::update_page,
            commands::trash_page,
            commands::restore_page,
            commands::delete_page_permanently,
            commands::empty_trash,
            commands::duplicate_page,
            commands::upsert_block,
            commands::save_page_blocks,
            commands::delete_block,
            commands::get_database,
            commands::update_database_view,
            commands::upsert_db_column,
            commands::delete_db_column,
            commands::upsert_db_row,
            commands::delete_db_row,
            commands::search_workspace,
            commands::export_page_markdown,
            commands::import_markdown_page,
            commands::import_local_paths,
            commands::import_markdown_tree,
            commands::import_notion_zip_bytes,
            commands::fetch_url_metadata,
            commands::get_settings,
            commands::set_setting,
            commands::get_storage_info,
            commands::update_storage_config,
            commands::reset_storage_to_default,
            commands::sync_all_pages_to_markdown,
            commands::pick_folder_dialog,
            commands::pick_markdown_file_dialog,
            commands::save_markdown_file_dialog,
            commands::save_svg_file_dialog,
            commands::open_local_markdown_file,
            commands::save_local_markdown_file,
            commands::convert_markdown_blocks,
            commands::save_asset_image,
            commands::open_path_in_explorer,
            commands::list_folder_entries,
            commands::open_text_file,
            commands::save_text_file,
            commands::open_with_system_app,
            commands::create_folder_entry,
            commands::rename_folder_entry,
            commands::move_folder_entry,
            commands::trash_folder_entry,
            commands::search_folder_notes,
            commands::set_watched_paths,
            commands::save_local_note_image,
            commands::sync_get_config,
            commands::sync_save_config,
            commands::sync_run,
            commands::sync_auth,
            commands::sync_account,
            commands::sync_logout,
            commands::sync_redeem,
            commands::license_status,
            commands::license_activate,
            commands::license_deactivate,
            commands::license_login,
            commands::license_refresh,
            commands::license_logout,
            commands::license_create_order,
            commands::feedback_submit,
            commands::export_page_html,
            commands::export_page_file,
            commands::page_versions_list,
            commands::page_version_get,
            commands::page_version_restore,
            commands::open_external_url,
            commands::list_backups,
            commands::create_backup_now,
            commands::restore_backup,
            commands::export_workspace_zip_dialog,
            commands::list_style_plugins,
            commands::save_style_plugin,
            commands::toggle_style_plugin,
            commands::delete_style_plugin,
            commands::import_style_plugin_dialog,
            commands::import_style_plugin_content,
            commands::export_style_plugin_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Notion Desktop Tauri application");
}
