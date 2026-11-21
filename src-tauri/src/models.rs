use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip archive error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Lock poisoned")]
    LockPoisoned,
    /// 磁盘文件在打开后被其他程序改过；携带文件当前的修改时间
    #[error("Conflict: {0}")]
    Conflict(String),
}

impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.to_string()
    }
}

/// Distinguishes between an omitted JSON property (`None`),
/// an explicit JSON `null` (`Some(None)`), and a value (`Some(Some(v))`).
pub fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: String,
    pub cover: Option<String>,
    pub page_type: String, // "doc" | "database"
    pub is_favorite: bool,
    pub is_trashed: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockProps {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callout_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 磁盘笔记里图片的原始引用（如 `assets/a.png`）；url 用于显示，保存时写回这里的相对路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_width: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_desc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embed_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mermaid_view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col_alignments: Option<Vec<String>>,
    /// 附件块：相对 assets/ 的路径、文件名、大小、类型
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// 待办的截止 / 提醒时间（本地时间 `YYYY-MM-DDTHH:mm`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
}

/// 「待办汇总」里的一条未完成待办
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub page_icon: String,
    pub text: String,
    pub due_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub page_id: String,
    pub block_type: String,
    pub content: String,
    pub plain_text: String,
    #[serde(default)]
    pub props: BlockProps,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub id: String,
    pub label: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub id: String,
    pub page_id: String,
    pub name: String,
    pub col_type: String,
    #[serde(default)]
    pub options: Vec<SelectOption>,
    pub width: i64,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbRow {
    pub id: String,
    pub page_id: String,
    #[serde(default)]
    pub cells: Map<String, Value>,
    pub linked_page_id: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFull {
    pub page_id: String,
    pub active_view: String,
    pub group_by_col_id: Option<String>,
    pub columns: Vec<DbColumn>,
    pub rows: Vec<DbRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkItem {
    pub source_page_id: String,
    pub source_title: String,
    pub source_icon: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BreadcrumbItem {
    pub id: String,
    pub title: String,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageDetail {
    pub page: Page,
    pub blocks: Vec<Block>,
    pub breadcrumbs: Vec<BreadcrumbItem>,
    pub backlinks: Vec<BacklinkItem>,
    pub children: Vec<Page>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub page_id: String,
    pub page_title: String,
    pub page_icon: String,
    pub page_type: String,
    pub block_id: Option<String>,
    pub snippet: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownExport {
    pub filename: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownTreeEntry {
    pub relative_path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportResult {
    pub imported_pages: usize,
    pub imported_databases: usize,
    pub imported_blocks: usize,
    pub resolved_links: usize,
    pub root_page_ids: Vec<String>,
    pub first_page_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UrlMetadata {
    pub url: String,
    pub title: String,
    pub description: String,
    pub site_name: String,
    pub favicon: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreatePageInput {
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    pub page_type: Option<String>,
    pub template_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePagePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub cover: Option<Option<String>>,
    #[serde(default)]
    pub is_favorite: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertBlockInput {
    #[serde(default)]
    pub id: Option<String>,
    pub page_id: String,
    pub block_type: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub plain_text: String,
    #[serde(default)]
    pub props: BlockProps,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBlockItem {
    #[serde(default)]
    pub id: String,
    pub block_type: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub plain_text: String,
    #[serde(default)]
    pub props: BlockProps,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertDbColumnInput {
    #[serde(default)]
    pub id: Option<String>,
    pub page_id: String,
    pub name: String,
    pub col_type: String,
    #[serde(default)]
    pub options: Vec<SelectOption>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertDbRowInput {
    #[serde(default)]
    pub id: Option<String>,
    pub page_id: String,
    #[serde(default)]
    pub cells: Map<String, Value>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub linked_page_id: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageConfigInfo {
    pub exe_dir: String,
    pub default_data_dir: String,
    pub active_data_dir: String,
    pub db_file_path: String,
    pub markdown_sync_dir: String,
    pub assets_dir: String,
    pub backups_dir: String,
    pub is_default_portable_dir: bool,
    pub exe_dir_writable: bool,
    pub auto_sync_markdown: bool,
    pub image_save_mode: String, // "assets" | "base64"
    pub auto_backup_on_launch: bool,
    pub max_backups: usize,
    pub db_size_bytes: u64,
    pub page_count: usize,
    pub block_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateStorageConfigInput {
    pub active_data_dir: Option<String>,
    pub markdown_sync_dir: Option<String>,
    pub migrate_existing_data: Option<bool>,
    pub auto_sync_markdown: Option<bool>,
    pub image_save_mode: Option<String>,
    pub auto_backup_on_launch: Option<bool>,
    pub max_backups: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub filename: String,
    pub full_path: String,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalMarkdownDocument {
    pub file_path: String,
    pub file_name: String,
    pub title: String,
    pub markdown: String,
    pub blocks: Vec<Block>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedAssetResult {
    pub file_path: String,
    pub asset_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCustomFont {
    pub stored_path: String,
    pub resolved_path: String,
    pub display_name: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_primary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_sidebar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_hover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_elevated: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_primary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_muted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_inline_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_inline_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_block_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_header_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callout_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_sans: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_serif: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_mono: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_md: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StylePluginItem {
    pub id: String,
    pub kind: String, // "theme" | "snippet"
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub base_mode: String, // "light" | "dark" | "sepia"
    pub enabled: bool,
    pub builtin: bool,
    pub file_name: String,
    pub file_path: String,
    #[serde(default)]
    pub tokens: ThemeTokens,
    #[serde(default)]
    pub custom_css: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StylePluginState {
    pub plugins_dir: String,
    pub themes_dir: String,
    pub snippets_dir: String,
    pub active_theme_id: String, // "light" | "dark" | "sepia" | "system" | "plugin:<id>"
    pub plugins: Vec<StylePluginItem>,
    pub custom_css_global: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveStylePluginInput {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub base_mode: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub tokens: Option<ThemeTokens>,
    #[serde(default)]
    pub custom_css: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_page_patch_double_option() {
        let omitted: UpdatePagePatch = serde_json::from_str(r#"{"title":"Hello"}"#).unwrap();
        assert_eq!(omitted.title.as_deref(), Some("Hello"));
        assert_eq!(omitted.cover, None);
        assert_eq!(omitted.parent_id, None);

        let cleared: UpdatePagePatch =
            serde_json::from_str(r#"{"cover":null,"parentId":null}"#).unwrap();
        assert_eq!(cleared.cover, Some(None));
        assert_eq!(cleared.parent_id, Some(None));

        let populated: UpdatePagePatch =
            serde_json::from_str(r#"{"cover":"linear-gradient(...)","parentId":"p1"}"#).unwrap();
        assert_eq!(
            populated.cover,
            Some(Some("linear-gradient(...)".to_string()))
        );
        assert_eq!(populated.parent_id, Some(Some("p1".to_string())));
    }

    #[test]
    fn test_camel_case_ipc_serialization_contract() {
        let page = Page {
            id: "p1".into(),
            parent_id: None,
            title: "Doc".into(),
            icon: "📄".into(),
            cover: None,
            page_type: "doc".into(),
            is_favorite: true,
            is_trashed: false,
            sort_order: 2,
            created_at: "2026-11-14T00:00:00Z".into(),
            updated_at: "2026-11-14T00:00:00Z".into(),
        };
        let v = serde_json::to_value(&page).unwrap();
        assert!(v.get("parentId").is_some());
        assert!(v.get("pageType").is_some());
        assert!(v.get("isFavorite").is_some());
        assert!(v.get("isTrashed").is_some());
        assert!(v.get("sortOrder").is_some());
        assert!(v.get("createdAt").is_some());
        assert!(v.get("updatedAt").is_some());

        let props = BlockProps {
            url: Some("https://tauri.app".into()),
            caption: Some("Tauri Website".into()),
            image_width: Some("medium".into()),
            bookmark_title: Some("Tauri".into()),
            bookmark_desc: Some("Build smaller, faster desktop apps".into()),
            bookmark_site: Some("tauri.app".into()),
            bookmark_icon: Some("https://tauri.app/favicon.ico".into()),
            embed_provider: Some("youtube".into()),
            ..Default::default()
        };
        let pv = serde_json::to_value(&props).unwrap();
        assert_eq!(pv["url"], "https://tauri.app");
        assert_eq!(pv["caption"], "Tauri Website");
        assert_eq!(pv["imageWidth"], "medium");
        assert_eq!(pv["bookmarkTitle"], "Tauri");
        assert_eq!(pv["bookmarkDesc"], "Build smaller, faster desktop apps");
        assert_eq!(pv["bookmarkSite"], "tauri.app");
        assert_eq!(pv["bookmarkIcon"], "https://tauri.app/favicon.ico");
        assert_eq!(pv["embedProvider"], "youtube");

        let batch = BatchImportResult {
            imported_pages: 4,
            imported_databases: 1,
            imported_blocks: 18,
            resolved_links: 3,
            root_page_ids: vec!["r1".into()],
            first_page_id: Some("r1".into()),
        };
        let bv = serde_json::to_value(&batch).unwrap();
        assert_eq!(bv["importedPages"], 4);
        assert_eq!(bv["importedDatabases"], 1);
        assert_eq!(bv["importedBlocks"], 18);
        assert_eq!(bv["resolvedLinks"], 3);
        assert_eq!(bv["rootPageIds"][0], "r1");
        assert_eq!(bv["firstPageId"], "r1");

        let meta = UrlMetadata {
            url: "https://example.com".into(),
            title: "Example".into(),
            description: "Desc".into(),
            site_name: "example.com".into(),
            favicon: "https://example.com/favicon.ico".into(),
        };
        let mv = serde_json::to_value(&meta).unwrap();
        assert_eq!(mv["siteName"], "example.com");
        assert_eq!(mv["favicon"], "https://example.com/favicon.ico");

        let info = StorageConfigInfo {
            exe_dir: "C:\\Notion".into(),
            default_data_dir: "C:\\Notion\\data".into(),
            active_data_dir: "C:\\Notion\\data".into(),
            db_file_path: "C:\\Notion\\data\\notion_desktop.db".into(),
            markdown_sync_dir: "C:\\Notion\\data\\pages".into(),
            assets_dir: "C:\\Notion\\data\\assets".into(),
            backups_dir: "C:\\Notion\\data\\backups".into(),
            is_default_portable_dir: true,
            exe_dir_writable: true,
            auto_sync_markdown: true,
            image_save_mode: "assets".into(),
            auto_backup_on_launch: true,
            max_backups: 10,
            db_size_bytes: 16384,
            page_count: 4,
            block_count: 22,
        };
        let sv = serde_json::to_value(&info).unwrap();
        assert_eq!(sv["exeDir"], "C:\\Notion");
        assert_eq!(sv["defaultDataDir"], "C:\\Notion\\data");
        assert_eq!(sv["activeDataDir"], "C:\\Notion\\data");
        assert_eq!(sv["dbFilePath"], "C:\\Notion\\data\\notion_desktop.db");
        assert_eq!(sv["markdownSyncDir"], "C:\\Notion\\data\\pages");
        assert_eq!(sv["assetsDir"], "C:\\Notion\\data\\assets");
        assert_eq!(sv["backupsDir"], "C:\\Notion\\data\\backups");
        assert_eq!(sv["isDefaultPortableDir"], true);
        assert_eq!(sv["exeDirWritable"], true);
        assert_eq!(sv["autoSyncMarkdown"], true);
        assert_eq!(sv["imageSaveMode"], "assets");
        assert_eq!(sv["autoBackupOnLaunch"], true);
        assert_eq!(sv["maxBackups"], 10);
        assert_eq!(sv["dbSizeBytes"], 16384);
        assert_eq!(sv["pageCount"], 4);
        assert_eq!(sv["blockCount"], 22);

        let bkp = BackupEntry {
            filename: "backup-20261114-120000.db".into(),
            full_path: "C:\\Notion\\data\\backups\\backup-20261114-120000.db".into(),
            size_bytes: 8192,
            created_at: "2026-11-14T12:00:00Z".into(),
        };
        let bkv = serde_json::to_value(&bkp).unwrap();
        assert_eq!(bkv["filename"], "backup-20261114-120000.db");
        assert_eq!(
            bkv["fullPath"],
            "C:\\Notion\\data\\backups\\backup-20261114-120000.db"
        );
        assert_eq!(bkv["sizeBytes"], 8192);
        assert_eq!(bkv["createdAt"], "2026-11-14T12:00:00Z");

        let asset = SavedAssetResult {
            file_path: "C:\\Notion\\data\\assets\\img.png".into(),
            asset_url: "data:image/png;base64,AAAA".into(),
        };
        let av = serde_json::to_value(&asset).unwrap();
        assert_eq!(av["filePath"], "C:\\Notion\\data\\assets\\img.png");
        assert_eq!(av["assetUrl"], "data:image/png;base64,AAAA");

        let custom_font = ImportedCustomFont {
            stored_path: "fonts/LXGWWenKai.ttf".into(),
            resolved_path: "C:\\XyNote\\XyNote-data\\fonts\\LXGWWenKai.ttf".into(),
            display_name: "LXGWWenKai".into(),
            byte_size: 123456,
        };
        let cfv = serde_json::to_value(&custom_font).unwrap();
        assert_eq!(cfv["storedPath"], "fonts/LXGWWenKai.ttf");
        assert_eq!(cfv["displayName"], "LXGWWenKai");
        assert_eq!(cfv["byteSize"], 123456);

        let v021_props = BlockProps {
            mermaid_view: Some("split".into()),
            word_wrap: Some(true),
            col_alignments: Some(vec!["left".into(), "center".into(), "right".into()]),
            ..Default::default()
        };
        let pv = serde_json::to_value(&v021_props).unwrap();
        assert_eq!(pv["mermaidView"], "split");
        assert_eq!(pv["wordWrap"], true);
        assert_eq!(
            pv["colAlignments"],
            serde_json::json!(["left", "center", "right"])
        );

        let plug_state = StylePluginState {
            plugins_dir: "C:\\Notion\\data\\plugins".into(),
            themes_dir: "C:\\Notion\\data\\plugins\\themes".into(),
            snippets_dir: "C:\\Notion\\data\\plugins\\snippets".into(),
            active_theme_id: "plugin:dracula-dark".into(),
            custom_css_global: String::new(),
            plugins: vec![StylePluginItem {
                id: "dracula-dark".into(),
                kind: "theme".into(),
                name: "Dracula 暗夜极客紫".into(),
                author: "XyNote Official".into(),
                version: "1.0.0".into(),
                description: "Dark theme".into(),
                base_mode: "dark".into(),
                enabled: true,
                builtin: true,
                file_name: "dracula-dark.notion-theme.json".into(),
                file_path: "C:\\Notion\\data\\plugins\\themes\\dracula-dark.notion-theme.json"
                    .into(),
                tokens: ThemeTokens {
                    bg_primary: Some("#282a36".into()),
                    code_inline_color: Some("#ff79c6".into()),
                    table_header_bg: Some("#313445".into()),
                    ..Default::default()
                },
                custom_css: ".nb-editor-h1 { color: #bd93f9; }".into(),
                updated_at: "2026-11-14T18:00:00Z".into(),
            }],
        };
        let psv = serde_json::to_value(&plug_state).unwrap();
        assert_eq!(psv["pluginsDir"], "C:\\Notion\\data\\plugins");
        assert_eq!(psv["themesDir"], "C:\\Notion\\data\\plugins\\themes");
        assert_eq!(psv["snippetsDir"], "C:\\Notion\\data\\plugins\\snippets");
        assert_eq!(psv["activeThemeId"], "plugin:dracula-dark");
        assert_eq!(psv["customCssGlobal"], "");
        assert_eq!(psv["plugins"][0]["baseMode"], "dark");
        assert_eq!(psv["plugins"][0]["fileName"], "dracula-dark.notion-theme.json");
        assert_eq!(psv["plugins"][0]["tokens"]["bgPrimary"], "#282a36");
        assert_eq!(psv["plugins"][0]["tokens"]["codeInlineColor"], "#ff79c6");
        assert_eq!(psv["plugins"][0]["tokens"]["tableHeaderBg"], "#313445");
        assert_eq!(
            psv["plugins"][0]["customCss"],
            ".nb-editor-h1 { color: #bd93f9; }"
        );
    }
}
