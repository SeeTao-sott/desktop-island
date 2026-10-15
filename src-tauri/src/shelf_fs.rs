//! 架子的文件部分：一个真实的文件夹，每个分类是一个子文件夹。
//! 放进架子 = 把文件移进去；"从架子移除" = 移进「已移除」文件夹，从不删除。
//! 每次移动都写日志、可在短时间内撤销；文件夹变化靠系统通知（ReadDirectoryChangesW），不轮询。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, MoveFileExW, MOVE_FILE_FLAGS, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::UI::Shell::{
    ILCreateFromPathW, ILFindLastID, ILFree, SHGetKnownFolderPath, SHOpenFolderAndSelectItems, ShellExecuteW, FOLDERID_Desktop,
    FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_LocalAppData, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_Profile, FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Public,
    FOLDERID_PublicDesktop, FOLDERID_RoamingAppData, FOLDERID_Videos, FOLDERID_Windows, KNOWN_FOLDER_FLAG,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::fileops;

/// 默认分类，按这个顺序排在最前面
pub const DEFAULT_CATEGORIES: [&str; 5] = ["软件", "文档", "图片", "压缩包", "其他"];
/// 从架子移除的东西放这里，由用户自己决定删不删
pub const REMOVED: &str = "已移除";
/// 撤销按钮显示 10 秒，后台多留一点余量
const UNDO_WINDOW: Duration = Duration::from_secs(20);

/// 按扩展名自动分类
fn auto_category(path: &Path) -> &'static str {
    if path.is_dir() {
        return "其他";
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "lnk" | "url" | "exe" | "appref-ms" => "软件",
        "pdf" | "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "txt" | "md" | "csv" | "rtf" | "odt" | "ods"
        | "odp" => "文档",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "heic" | "svg" | "tif" | "tiff" | "ico" | "avif" => "图片",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "iso" => "压缩包",
        _ => "其他",
    }
}

fn kind_of(path: &Path, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    match auto_category(path) {
        "软件" => "shortcut",
        "图片" => "image",
        _ => "file",
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    /// folder / shortcut / image / file
    pub kind: &'static str,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub name: String,
    pub builtin: bool,
    pub items: Vec<Item>,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfData {
    pub root: String,
    pub categories: Vec<Category>,
    pub removed_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub from: String,
    pub to: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub name: String,
    pub reason: String,
}

/// 一次操作的结果，页面据此显示提示和"撤销"按钮
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub op_id: Option<u64>,
    pub kind: String,
    pub category: Option<String>,
    pub moved: Vec<Moved>,
    pub failed: Vec<Failed>,
}

struct Op {
    /// (原位置, 新位置)
    pairs: Vec<(PathBuf, PathBuf)>,
    at: Instant,
}

pub struct ShelfFs {
    root: PathBuf,
    log_path: PathBuf,
    app: AppHandle,
    ops: Mutex<HashMap<u64, Op>>,
    next_id: AtomicU64,
    /// 同一时间只做一个文件操作，避免互相打架
    busy: Mutex<()>,
    last: Mutex<Option<ShelfData>>,
    /// 不允许搬动的重要文件夹
    protected: Vec<PathBuf>,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string_lossy().to_string())
}

fn lower(p: &Path) -> String {
    p.to_string_lossy().trim_end_matches('\\').to_lowercase()
}

/// a 是不是 b 本身或 b 的上级
fn is_ancestor_or_same(a: &Path, b: &Path) -> bool {
    let (a, b) = (lower(a), lower(b));
    b == a || b.starts_with(&format!("{a}\\"))
}

fn known_folders() -> Vec<PathBuf> {
    let ids = [
        FOLDERID_Desktop,
        FOLDERID_Documents,
        FOLDERID_Downloads,
        FOLDERID_Pictures,
        FOLDERID_Music,
        FOLDERID_Videos,
        FOLDERID_Profile,
        FOLDERID_Windows,
        FOLDERID_ProgramFiles,
        FOLDERID_ProgramFilesX86,
        FOLDERID_ProgramData,
        FOLDERID_RoamingAppData,
        FOLDERID_LocalAppData,
        FOLDERID_Public,
        FOLDERID_PublicDesktop,
    ];
    let mut out: Vec<PathBuf> = ids
        .iter()
        .filter_map(|id| unsafe {
            let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            s.map(PathBuf::from)
        })
        .collect();
    if let Ok(od) = std::env::var("OneDrive") {
        out.push(PathBuf::from(od));
    }
    out
}

impl ShelfFs {
    pub fn new(app: AppHandle, root: PathBuf, log_path: PathBuf) -> Arc<Self> {
        let fs = Arc::new(Self {
            root,
            log_path,
            app,
            ops: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            busy: Mutex::new(()),
            last: Mutex::new(None),
            protected: known_folders(),
        });
        fs.ensure_folders();
        let watcher = fs.clone();
        thread::spawn(move || watcher.watch());
        fs
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 建好架子文件夹和默认分类（只新建，不动已有的东西）
    fn ensure_folders(&self) {
        for c in DEFAULT_CATEGORIES.iter().chain([REMOVED].iter()) {
            let _ = fs::create_dir_all(self.root.join(c));
        }
    }

    // ---------------- 读取 ----------------

    pub fn scan(&self) -> ShelfData {
        self.ensure_folders();
        let mut names: Vec<String> = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.root) {
            for e in rd.flatten() {
                let Ok(meta) = e.metadata() else { continue };
                let name = e.file_name().to_string_lossy().to_string();
                if meta.is_dir() && name != REMOVED && !hidden(&meta) && !DEFAULT_CATEGORIES.contains(&name.as_str()) {
                    names.push(name);
                }
            }
        }
        names.sort_by_key(|n| n.to_lowercase());
        let mut categories: Vec<Category> = DEFAULT_CATEGORIES
            .iter()
            .map(|n| Category { name: n.to_string(), builtin: true, items: list_items(&self.root.join(n)) })
            .collect();
        categories.extend(names.into_iter().map(|n| {
            let items = list_items(&self.root.join(&n));
            Category { name: n, builtin: false, items }
        }));
        ShelfData {
            root: self.root.to_string_lossy().to_string(),
            categories,
            removed_count: list_items(&self.root.join(REMOVED)).len(),
        }
    }

    /// 重新扫描，有变化才推给页面
    pub fn refresh(&self) {
        let data = self.scan();
        let mut last = self.last.lock().unwrap();
        if last.as_ref() != Some(&data) {
            let _ = self.app.emit("shelf-items", &data);
            *last = Some(data);
        }
    }

    /// 文件夹有变化时系统会叫醒这个线程；没变化时它一直睡着，不占 CPU
    fn watch(&self) {
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_SIZE
            | FILE_NOTIFY_CHANGE_LAST_WRITE;
        loop {
            let h = unsafe {
                CreateFileW(
                    &HSTRING::from(self.root.as_os_str()),
                    0x0001, // FILE_LIST_DIRECTORY
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    None,
                )
            };
            let Ok(handle) = h else {
                thread::sleep(Duration::from_secs(3));
                self.ensure_folders();
                continue;
            };
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut got = 0u32;
                let ok = unsafe {
                    ReadDirectoryChangesW(handle, buf.as_mut_ptr().cast(), buf.len() as u32, true, filter, Some(&mut got), None, None)
                };
                if ok.is_err() {
                    break;
                }
                // 一次操作常常连着好几个通知，稍等一下再统一刷新
                thread::sleep(Duration::from_millis(150));
                self.refresh();
            }
            unsafe {
                let _ = CloseHandle(handle);
            }
            thread::sleep(Duration::from_secs(1));
        }
    }

    // ---------------- 安全检查 ----------------

    pub fn inside_shelf(&self, p: &Path) -> bool {
        let (r, s) = (lower(&self.root), lower(p));
        s.starts_with(&format!("{r}\\"))
    }

    fn guard(&self, p: &Path) -> Result<(), String> {
        guard_path(p, &self.root, &self.protected)
    }

    fn category_dir(&self, category: &str) -> Result<PathBuf, String> {
        let bad = category.is_empty() || category == REMOVED || category.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
        if bad {
            return Err(format!("分类名「{category}」不能用"));
        }
        Ok(self.root.join(category))
    }

    // ---------------- 操作 ----------------

    /// 把拖进来的东西放进架子。category 为空时按类型自动分类。
    /// 拖进来的本来就是架子里的东西（在分类之间拖动）：松在某个分类上就移过去，否则当作取消
    pub fn put(&self, paths: Vec<String>, category: Option<String>) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let mut pairs = Vec::new();
        let mut moved = Vec::new();
        let mut failed = Vec::new();
        let mut any_outside = false;
        for p in paths.iter().map(PathBuf::from) {
            let name = file_name(&p);
            if self.inside_shelf(&p) {
                let Some(cat) = &category else { continue };
                let dir = match self.category_dir(cat) {
                    Ok(d) => d,
                    Err(reason) => {
                        failed.push(Failed { name, reason });
                        continue;
                    }
                };
                if p.parent().map(lower) != Some(lower(&dir)) {
                    let res = fileops::move_into(&p, &dir, &name);
                    self.record(&mut pairs, &mut moved, &mut failed, &p, res);
                }
                continue;
            }
            any_outside = true;
            if let Err(reason) = self.guard(&p) {
                self.log("put", &p, None, Some(&reason), 0);
                failed.push(Failed { name, reason });
                continue;
            }
            let cat = category.clone().unwrap_or_else(|| auto_category(&p).to_string());
            let res = self.category_dir(&cat).and_then(|dir| fileops::move_into(&p, &dir, &name));
            self.record(&mut pairs, &mut moved, &mut failed, &p, res);
        }
        let kind = if any_outside { "put" } else { "move" };
        self.finish(kind, category, pairs, moved, failed)
    }

    // ---------------- 分类 ----------------

    /// 新分类名能不能用：不能为空、不能有特殊符号、不能和已有分类（不分大小写）或「已移除」重名
    fn check_category_name(&self, name: &str) -> Result<String, String> {
        let name = name.trim().trim_end_matches(['.', ' ']).to_string();
        if name.is_empty() {
            return Err("分类名不能为空".into());
        }
        if name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || name == "." || name == ".." {
            return Err("分类名里不能有 \\ / : * ? \" < > | 这些符号".into());
        }
        if name == REMOVED {
            return Err(format!("「{REMOVED}」是保留的名字"));
        }
        let exists = fs::read_dir(&self.root)
            .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase() == name.to_lowercase()))
            .unwrap_or(false);
        if exists {
            return Err(format!("已经有叫「{name}」的分类了"));
        }
        Ok(name)
    }

    fn custom_category(&self, name: &str) -> Result<PathBuf, String> {
        if DEFAULT_CATEGORIES.contains(&name) {
            return Err(format!("「{name}」是默认分类，自动分类要用到它，不能改名或移除"));
        }
        let dir = self.category_dir(name)?;
        if !dir.is_dir() {
            return Err(format!("找不到分类「{name}」"));
        }
        Ok(dir)
    }

    /// 新建分类 = 在架子文件夹里新建一个子文件夹
    pub fn create_category(&self, name: String) -> Result<String, String> {
        let _lock = self.busy.lock().unwrap();
        let name = self.check_category_name(&name)?;
        let dir = self.root.join(&name);
        fs::create_dir(&dir).map_err(|e| fileops::describe_io(&e, &dir))?;
        self.log("new-category", &dir, None, None, 0);
        self.refresh();
        Ok(name)
    }

    /// 分类改名 = 子文件夹改名（新名字已存在就拒绝，不合并、不覆盖）
    pub fn rename_category(&self, old: String, new: String) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        let res = self.custom_category(&old).and_then(|dir| {
            let new = new.trim().to_string();
            // 只改大小写时跳过重名检查
            let new = if new.to_lowercase() == old.to_lowercase() { new } else { self.check_category_name(&new)? };
            let target = self.root.join(&new);
            let h = (HSTRING::from(dir.as_os_str()), HSTRING::from(target.as_os_str()));
            unsafe { MoveFileExW(&h.0, &h.1, MOVE_FILE_FLAGS(0)) }
                .map(|_| target)
                .map_err(|e| fileops::describe(e.code().0 as u32 & 0xFFFF, &dir))
        });
        self.record(&mut pairs, &mut moved, &mut failed, &self.root.join(&old), res);
        self.finish("rename-category", None, pairs, moved, failed)
    }

    /// 移除分类：只允许空的自定义分类，整个文件夹移进「已移除」（不删除）
    pub fn remove_category(&self, name: String) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        let res = self.custom_category(&name).and_then(|dir| {
            if !list_items(&dir).is_empty() {
                return Err(format!("「{name}」里还有东西，先把它们移到别的分类"));
            }
            fileops::move_into(&dir, &self.root.join(REMOVED), &name)
        });
        self.record(&mut pairs, &mut moved, &mut failed, &self.root.join(&name), res);
        self.finish("remove-category", None, pairs, moved, failed)
    }

    /// 架子里的东西换到另一个分类
    pub fn move_to(&self, paths: Vec<String>, category: String) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        let dir = match self.category_dir(&category) {
            Ok(d) => d,
            Err(reason) => {
                return self.finish("move", Some(category), pairs, moved, vec![Failed { name: String::new(), reason }])
            }
        };
        for p in paths.iter().map(PathBuf::from) {
            let name = file_name(&p);
            if !self.inside_shelf(&p) {
                failed.push(Failed { name, reason: "不是架子里的东西".into() });
                continue;
            }
            if p.parent().map(lower) == Some(lower(&dir)) {
                continue;
            }
            let res = fileops::move_into(&p, &dir, &name);
            self.record(&mut pairs, &mut moved, &mut failed, &p, res);
        }
        self.finish("move", Some(category), pairs, moved, failed)
    }

    /// 改名（新名字重了也自动加编号，不覆盖）
    pub fn rename(&self, path: String, new_name: String) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let p = PathBuf::from(&path);
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        let new_name = new_name.trim().trim_end_matches(['.', ' ']).to_string();
        let invalid = new_name.is_empty()
            || new_name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
            || new_name == "."
            || new_name == "..";
        if !self.inside_shelf(&p) {
            failed.push(Failed { name: file_name(&p), reason: "不是架子里的东西".into() });
        } else if invalid {
            failed.push(Failed { name: file_name(&p), reason: "名字里不能有 \\ / : * ? \" < > | 这些符号".into() });
        } else if new_name != file_name(&p) {
            let dir = p.parent().unwrap_or(&self.root).to_path_buf();
            let res = if new_name.to_lowercase() == file_name(&p).to_lowercase() {
                // 只改大小写：系统认为是同一个文件，直接改（仍然不带覆盖选项）
                let target = dir.join(&new_name);
                let h = (HSTRING::from(p.as_os_str()), HSTRING::from(target.as_os_str()));
                unsafe { MoveFileExW(&h.0, &h.1, MOVE_FILE_FLAGS(0)) }.map(|_| target).map_err(|e| e.message())
            } else {
                fileops::move_into(&p, &dir, &new_name)
            };
            self.record(&mut pairs, &mut moved, &mut failed, &p, res);
        }
        self.finish("rename", None, pairs, moved, failed)
    }

    /// 从架子移除 = 移进「已移除」文件夹，不删除
    pub fn remove(&self, paths: Vec<String>) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        let dir = self.root.join(REMOVED);
        for p in paths.iter().map(PathBuf::from) {
            let name = file_name(&p);
            if !self.inside_shelf(&p) {
                failed.push(Failed { name, reason: "不是架子里的东西".into() });
                continue;
            }
            let res = fileops::move_into(&p, &dir, &name);
            self.record(&mut pairs, &mut moved, &mut failed, &p, res);
        }
        self.finish("remove", None, pairs, moved, failed)
    }

    /// 撤销：按相反方向原样搬回去（原位置被别的文件占了也不覆盖，会自动改名）
    pub fn undo(&self, op_id: u64) -> OpResult {
        let _lock = self.busy.lock().unwrap();
        let op = self.ops.lock().unwrap().remove(&op_id);
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        match op {
            None => failed.push(Failed { name: String::new(), reason: "这次操作已经不能撤销了".into() }),
            Some(op) if op.at.elapsed() > UNDO_WINDOW => {
                failed.push(Failed { name: String::new(), reason: "撤销时间已过".into() })
            }
            Some(op) => {
                for (from, to) in op.pairs.iter().rev() {
                    let dir = from.parent().unwrap_or(Path::new("")).to_path_buf();
                    let res = fileops::move_into(to, &dir, &file_name(from));
                    self.record(&mut pairs, &mut moved, &mut failed, to, res);
                }
            }
        }
        // 撤销本身不再提供撤销
        let mut r = self.finish("undo", None, pairs, moved, failed);
        r.op_id = None;
        r
    }

    fn record(
        &self,
        pairs: &mut Vec<(PathBuf, PathBuf)>,
        moved: &mut Vec<Moved>,
        failed: &mut Vec<Failed>,
        from: &Path,
        res: Result<PathBuf, String>,
    ) {
        match res {
            Ok(to) => {
                moved.push(Moved {
                    from: from.to_string_lossy().to_string(),
                    to: to.to_string_lossy().to_string(),
                    name: file_name(&to),
                });
                pairs.push((from.to_path_buf(), to));
            }
            Err(reason) => failed.push(Failed { name: file_name(from), reason }),
        }
    }

    fn finish(
        &self,
        kind: &str,
        category: Option<String>,
        pairs: Vec<(PathBuf, PathBuf)>,
        moved: Vec<Moved>,
        failed: Vec<Failed>,
    ) -> OpResult {
        let op_id = (!pairs.is_empty()).then(|| self.next_id.fetch_add(1, Ordering::SeqCst));
        let id = op_id.unwrap_or(0);
        for (from, to) in &pairs {
            self.log(kind, from, Some(to), None, id);
        }
        for f in &failed {
            if !f.name.is_empty() {
                self.log(kind, Path::new(&f.name), None, Some(&f.reason), id);
            }
        }
        if let Some(id) = op_id {
            let mut ops = self.ops.lock().unwrap();
            ops.retain(|_, op| op.at.elapsed() < UNDO_WINDOW);
            ops.insert(id, Op { pairs, at: Instant::now() });
        }
        self.refresh();
        OpResult { op_id, kind: kind.to_string(), category, moved, failed }
    }

    /// 每次移动都追加一行 JSON 到日志
    fn log(&self, op: &str, from: &Path, to: Option<&Path>, error: Option<&str>, op_id: u64) {
        let t = unsafe { GetLocalTime() };
        let line = serde_json::json!({
            "time": format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond),
            "op": op,
            "op_id": op_id,
            "from": from.to_string_lossy(),
            "to": to.map(|p| p.to_string_lossy().to_string()),
            "ok": error.is_none(),
            "error": error,
        });
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.log_path) {
            let _ = writeln!(f, "{line}");
        }
    }

    // ---------------- 打开 ----------------

    pub fn open(&self, path: &str) -> Result<(), String> {
        let p = PathBuf::from(path);
        if !self.inside_shelf(&p) && lower(&p) != lower(&self.root.join(REMOVED)) {
            return Err("不是架子里的东西".into());
        }
        let dir = p.parent().map(|d| HSTRING::from(d.as_os_str())).unwrap_or_default();
        let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(p.as_os_str()), None, &dir, SW_SHOWNORMAL) };
        // 返回值大于 32 表示成功
        if r.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("打不开「{}」", file_name(&p)))
        }
    }

    /// 在资源管理器里显示并选中它
    pub fn reveal(&self, path: &str) -> Result<(), String> {
        let p = PathBuf::from(path);
        if !self.inside_shelf(&p) {
            return Err("不是架子里的东西".into());
        }
        let parent = p.parent().unwrap_or(&self.root).to_path_buf();
        unsafe {
            // 打开上一级文件夹，并选中这一项（传"文件夹 + 里面的那一项"最稳）
            let folder = ILCreateFromPathW(&HSTRING::from(parent.as_os_str()));
            let item = ILCreateFromPathW(&HSTRING::from(p.as_os_str()));
            if folder.is_null() || item.is_null() {
                ILFree(Some(folder));
                ILFree(Some(item));
                return Err(format!("找不到「{}」", file_name(&p)));
            }
            let child = ILFindLastID(item);
            let r = SHOpenFolderAndSelectItems(folder, Some(&[child as *const _]), 0);
            ILFree(Some(item));
            ILFree(Some(folder));
            r.map_err(|e| e.message())
        }
    }

    pub fn removed_dir(&self) -> PathBuf {
        self.root.join(REMOVED)
    }
}

fn hidden(meta: &fs::Metadata) -> bool {
    // 隐藏 或 系统
    meta.file_attributes() & (0x2 | 0x4) != 0
}

fn list_items(dir: &Path) -> Vec<Item> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut items: Vec<Item> = rd
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().to_string();
            let lname = name.to_lowercase();
            if hidden(&meta) || lname == "desktop.ini" || lname == "thumbs.db" {
                return None;
            }
            let path = e.path();
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(Item {
                kind: kind_of(&path, meta.is_dir()),
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified,
            })
        })
        .collect();
    items.sort_by_key(|i| i.name.to_lowercase());
    items
}

/// 不能搬的东西：磁盘根目录、架子自己和它的上级、系统和用户的重要文件夹
fn guard_path(p: &Path, root: &Path, protected: &[PathBuf]) -> Result<(), String> {
    let name = file_name(p);
    if p.parent().is_none() {
        return Err(format!("「{name}」是整个磁盘，不能放进架子"));
    }
    if is_ancestor_or_same(p, root) {
        return Err(format!("「{name}」里面包含架子本身，不能放进去"));
    }
    if protected.iter().any(|k| is_ancestor_or_same(p, k)) {
        return Err(format!("「{name}」是系统或个人的重要文件夹，为了安全不移动它"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_category_by_extension() {
        assert_eq!(auto_category(Path::new(r"C:\x\Genshin Impact.lnk")), "软件");
        assert_eq!(auto_category(Path::new(r"C:\x\游戏.URL")), "软件");
        assert_eq!(auto_category(Path::new(r"C:\x\报告.PDF")), "文档");
        assert_eq!(auto_category(Path::new(r"C:\x\a.pptx")), "文档");
        assert_eq!(auto_category(Path::new(r"C:\x\照片.jpeg")), "图片");
        assert_eq!(auto_category(Path::new(r"C:\x\b.7z")), "压缩包");
        assert_eq!(auto_category(Path::new(r"C:\x\script.py")), "其他");
        assert_eq!(auto_category(Path::new(r"C:\x\没有扩展名")), "其他");
    }

    #[test]
    fn guard_refuses_dangerous_paths() {
        let root = PathBuf::from(r"C:\Users\User\OneDrive\架子");
        let protected = vec![PathBuf::from(r"C:\Users\User\Documents"), PathBuf::from(r"C:\Windows")];
        // 磁盘根目录
        assert!(guard_path(Path::new(r"C:\"), &root, &protected).is_err());
        // 架子本身、架子的上级
        assert!(guard_path(Path::new(r"C:\Users\User\OneDrive\架子"), &root, &protected).is_err());
        assert!(guard_path(Path::new(r"C:\Users\User\OneDrive"), &root, &protected).is_err());
        assert!(guard_path(Path::new(r"C:\Users"), &root, &protected).is_err());
        // 重要文件夹本身和它的上级（大小写不同也算）
        assert!(guard_path(Path::new(r"C:\Users\User\documents"), &root, &protected).is_err());
        assert!(guard_path(Path::new(r"C:\WINDOWS"), &root, &protected).is_err());
        // 重要文件夹"里面"的普通文件可以搬
        assert!(guard_path(Path::new(r"C:\Users\User\Documents\作业.docx"), &root, &protected).is_ok());
        // 名字只是前缀相同的文件夹不受影响
        assert!(guard_path(Path::new(r"C:\Users\User\Documents2"), &root, &protected).is_ok());
        assert!(guard_path(Path::new(r"C:\Users\User\OneDrive\桌面\笔记.txt"), &root, &protected).is_ok());
    }
}
