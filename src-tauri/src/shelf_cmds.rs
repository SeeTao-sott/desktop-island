//! 页面调用的架子文件命令。全部放到后台线程执行：搬大文件、取图标时界面不会卡。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::icons;
use crate::shelf_fs::{HomeItem, MigrateResult, OpResult, PlanItem, ShelfData, ShelfFs};

type Fs<'a> = State<'a, Arc<ShelfFs>>;

/// 在后台线程跑一个闭包，等它做完
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shelf_list(fs: Fs<'_>) -> Result<ShelfData, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.scan()).await
}

#[tauri::command]
pub async fn shelf_put(fs: Fs<'_>, paths: Vec<String>, category: Option<String>) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.put(paths, category)).await
}

#[tauri::command]
pub async fn shelf_move(fs: Fs<'_>, paths: Vec<String>, category: String) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.move_to(paths, category)).await
}

#[tauri::command]
pub async fn shelf_rename(fs: Fs<'_>, path: String, new_name: String) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.rename(path, new_name)).await
}

#[tauri::command]
pub async fn shelf_remove(fs: Fs<'_>, paths: Vec<String>) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.remove(paths)).await
}

#[tauri::command]
pub async fn shelf_undo(fs: Fs<'_>, op_id: u64) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.undo(op_id)).await
}

#[tauri::command]
pub async fn shelf_open(fs: Fs<'_>, path: String) -> Result<(), String> {
    let fs = fs.inner().clone();
    blocking(move || fs.open(&path)).await?
}

#[tauri::command]
pub async fn shelf_reveal(fs: Fs<'_>, path: String) -> Result<(), String> {
    let fs = fs.inner().clone();
    blocking(move || fs.reveal(&path)).await?
}

/// 打开「已移除」文件夹，让用户自己决定删不删
#[tauri::command]
pub async fn shelf_open_removed(fs: Fs<'_>) -> Result<(), String> {
    let fs = fs.inner().clone();
    blocking(move || fs.open(&fs.removed_dir().to_string_lossy())).await?
}

#[tauri::command]
pub async fn shelf_create_category(fs: Fs<'_>, name: String) -> Result<String, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.create_category(name)).await?
}

#[tauri::command]
pub async fn shelf_rename_category(fs: Fs<'_>, old: String, new: String) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.rename_category(old, new)).await
}

#[tauri::command]
pub async fn shelf_remove_category(fs: Fs<'_>, name: String) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.remove_category(name)).await
}

// ---------------- 桌面搬家 ----------------

#[tauri::command]
pub async fn shelf_migrate_plan(fs: Fs<'_>) -> Result<Vec<PlanItem>, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.migrate_plan()).await
}

#[tauri::command]
pub async fn shelf_migrate(fs: Fs<'_>, paths: Vec<String>) -> Result<MigrateResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.migrate(paths)).await
}

#[tauri::command]
pub async fn shelf_restore_plan(fs: Fs<'_>) -> Result<Vec<HomeItem>, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.restore_plan()).await
}

#[tauri::command]
pub async fn shelf_restore(fs: Fs<'_>, homes: Vec<String>) -> Result<OpResult, String> {
    let fs = fs.inner().clone();
    blocking(move || fs.restore(homes)).await
}

/// 用记事本打开搬家记录（只允许打开配置文件夹里的"搬家记录-*.txt"）
#[tauri::command]
pub fn shelf_open_record(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let p = PathBuf::from(&path);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if p.parent() != Some(dir.as_path()) || !name.starts_with("搬家记录-") || !name.ends_with(".txt") {
        return Err("只能打开搬家记录".into());
    }
    std::process::Command::new("notepad.exe").arg(&p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 开始把架子里的东西拖出去（拖完页面会收到 shelf-dragout-done）
#[tauri::command]
pub fn shelf_drag_out(window: tauri::WebviewWindow, fs: Fs<'_>, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() || !paths.iter().all(|p| fs.inside_shelf(&PathBuf::from(p))) {
        return Err("只能拖架子里的东西".into());
    }
    crate::shelf_drop::drag_out(&window, paths);
    Ok(())
}

#[tauri::command]
pub async fn shelf_icon(path: String, modified: u64, thumb: bool) -> Result<Option<String>, String> {
    blocking(move || icons::data_url(&PathBuf::from(path), modified, thumb)).await
}
