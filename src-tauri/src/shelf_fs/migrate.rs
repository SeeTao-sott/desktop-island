//! 桌面搬家：把桌面（个人 + 公共桌面）上的东西按类型搬进架子，并能一键全部搬回去。
//!
//! "从哪来、现在在哪"全靠移动日志推出来：日志里每一次移动（放进、换分类、改名、移除、撤销、
//! 分类改名……）都记着 原位置 → 新位置，按顺序重放一遍，就知道每个桌面来的东西现在在哪。
//! 所以你之前手动拖进架子的桌面文件，后来又换了分类或改了名，也一样能搬回桌面。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Desktop, FOLDERID_PublicDesktop, KNOWN_FOLDER_FLAG};

use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 会放进哪个分类
    pub category: String,
    /// 在"公共桌面"（所有用户共用）上
    pub public: bool,
    /// 搬不了时的原因（被占用、没权限……）
    pub problem: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeItem {
    pub name: String,
    /// 现在在架子里的位置
    pub now: String,
    /// 要回去的桌面位置
    pub home: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateResult {
    pub result: OpResult,
    /// 搬家记录（文本文件）的位置
    pub record: Option<String>,
}

fn known(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s.map(PathBuf::from)
    }
}

/// 两个桌面：(个人桌面, 公共桌面)。开发版可以用环境变量 ISLAND_TEST_DESKTOP="假桌面|假公共桌面" 换成测试文件夹
pub fn desktops() -> Vec<(PathBuf, bool)> {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("ISLAND_TEST_DESKTOP") {
        return v.split('|').enumerate().map(|(i, p)| (PathBuf::from(p), i == 1)).collect();
    }
    let mut out = Vec::new();
    if let Some(d) = known(&FOLDERID_Desktop) {
        out.push((d, false));
    }
    if let Some(d) = known(&FOLDERID_PublicDesktop) {
        out.push((d, true));
    }
    out
}

fn on_desktop(p: &Path) -> bool {
    let parent = p.parent().map(lower);
    desktops().iter().any(|(d, _)| Some(lower(d)) == parent)
}

/// 路径的上一级文件夹名（…\架子\软件\a.lnk → 软件）
fn parent_name(p: &str) -> String {
    Path::new(p).parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn now_stamp() -> (String, String) {
    let t = unsafe { GetLocalTime() };
    (
        format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond),
        format!("{:04}-{:02}-{:02} {:02}:{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute),
    )
}

impl ShelfFs {
    /// 搬家清单：两个桌面上现在的东西、各自会进哪个分类、能不能搬
    pub fn migrate_plan(&self) -> Vec<PlanItem> {
        let mut items = Vec::new();
        for (dir, public) in desktops() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let Ok(meta) = e.metadata() else { continue };
                let name = e.file_name().to_string_lossy().to_string();
                if hidden(&meta) || name.eq_ignore_ascii_case("desktop.ini") {
                    continue;
                }
                let path = e.path();
                let problem = self.guard(&path).err().or_else(|| fileops::check_removable(&path).err());
                items.push(PlanItem {
                    category: auto_category(&path).to_string(),
                    is_dir: meta.is_dir(),
                    name,
                    path: path.to_string_lossy().to_string(),
                    public,
                    problem,
                });
            }
        }
        items.sort_by(|a, b| (&a.category, a.name.to_lowercase()).cmp(&(&b.category, b.name.to_lowercase())));
        items
    }

    /// 按清单搬进架子（只接受桌面上的东西），写搬家记录
    pub fn migrate(&self, paths: Vec<String>) -> MigrateResult {
        let result = {
            let _lock = self.busy.lock().unwrap();
            let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
            for p in paths.iter().map(PathBuf::from) {
                let name = file_name(&p);
                if !on_desktop(&p) {
                    failed.push(Failed { name, reason: "不是桌面上的东西".into() });
                    continue;
                }
                let res = self
                    .guard(&p)
                    .and_then(|_| self.category_dir(auto_category(&p)))
                    .and_then(|dir| fileops::move_into(&p, &dir, &name));
                self.record(&mut pairs, &mut moved, &mut failed, &p, res);
            }
            self.finish("migrate", None, pairs, moved, failed)
        };
        let record = self.write_record(&result).ok();
        MigrateResult { result, record }
    }

    /// 写一份人能看懂的搬家记录（文本），放在配置文件旁边
    fn write_record(&self, r: &OpResult) -> std::io::Result<String> {
        let (stamp, human) = now_stamp();
        let dir = self.log_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let path = dir.join(format!("搬家记录-{stamp}.txt"));
        let mut text = format!("桌面搬家记录  {human}\r\n\r\n搬进架子的（{} 项）：\r\n", r.moved.len());
        for m in &r.moved {
            text += &format!("  [{}] {}\r\n     原来：{}\r\n     现在：{}\r\n", parent_name(&m.to), m.name, m.from, m.to);
        }
        if !r.failed.is_empty() {
            text += &format!("\r\n没搬成的（{} 项，还在桌面上）：\r\n", r.failed.len());
            for f in &r.failed {
                text += &format!("  {}：{}\r\n", f.name, f.reason);
            }
        }
        text += "\r\n想全部搬回桌面：右键（或左键）点托盘里的灵动岛图标 →「把桌面来的东西搬回桌面…」。\r\n";
        text += "每一次移动的细节在同一个文件夹的 shelf-log.jsonl 里。\r\n";
        // 带 BOM，记事本一定按 UTF-8 打开
        fs::write(&path, [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat())?;
        Ok(path.to_string_lossy().to_string())
    }

    /// 重放移动日志：桌面来的每一样东西 → 它现在在哪
    fn desktop_origins(&self) -> HashMap<String, PathBuf> {
        let mut now: HashMap<String, PathBuf> = HashMap::new(); // 桌面原位置 → 现在位置
        let Ok(text) = fs::read_to_string(&self.log_path) else { return now };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v["ok"] != serde_json::Value::Bool(true) {
                continue;
            }
            let (Some(from), Some(to)) = (v["from"].as_str(), v["to"].as_str()) else { continue };
            let (from, to) = (PathBuf::from(from), PathBuf::from(to));
            let (lf, prefix) = (lower(&from), format!("{}\\", lower(&from)));
            // 已经在追踪的东西被移动了（本身被移动，或它所在的文件夹被改名/移走）
            for cur in now.values_mut() {
                let lc = lower(cur);
                if lc == lf {
                    *cur = to.clone();
                } else if lc.starts_with(&prefix) {
                    *cur = to.join(&cur.to_string_lossy()[prefix.len()..]);
                }
            }
            // 从桌面进入架子：开始追踪
            if on_desktop(&from) && self.inside_shelf(&to) {
                now.insert(from.to_string_lossy().to_string(), to);
            }
        }
        now
    }

    /// 在架子里按名字找（分类文件夹和「已移除」的第一层）；正好找到一个才算数
    fn find_by_name(&self, name: &str) -> Option<PathBuf> {
        let mut hits = Vec::new();
        for cat in fs::read_dir(&self.root).ok()?.flatten() {
            if !cat.path().is_dir() {
                continue;
            }
            for e in fs::read_dir(cat.path()).into_iter().flatten().flatten() {
                if e.file_name().to_string_lossy().to_lowercase() == name.to_lowercase() {
                    hits.push(e.path());
                }
            }
        }
        (hits.len() == 1).then(|| hits.remove(0))
    }

    /// 一键搬回的清单：桌面来的、现在还在架子里的东西
    pub fn restore_plan(&self) -> Vec<HomeItem> {
        let mut items: Vec<HomeItem> = self
            .desktop_origins()
            .into_iter()
            .filter(|(_, now)| self.inside_shelf(now))
            .filter_map(|(home, now)| {
                // 日志里记的位置找不到（比如在资源管理器里直接挪过）：按名字在架子里找一找
                let now = if fs::symlink_metadata(&now).is_ok() {
                    now
                } else {
                    self.find_by_name(&file_name(&now))?
                };
                Some(HomeItem { name: file_name(Path::new(&home)), now: now.to_string_lossy().to_string(), home })
            })
            .collect();
        items.sort_by_key(|i| i.name.to_lowercase());
        items
    }

    /// 全部搬回原来的桌面位置（那里已经有同名的就自动改名，不覆盖）
    pub fn restore(&self, homes: Vec<String>) -> OpResult {
        let plan = self.restore_plan();
        let _lock = self.busy.lock().unwrap();
        let (mut pairs, mut moved, mut failed) = (Vec::new(), Vec::new(), Vec::new());
        for item in plan.iter().filter(|i| homes.contains(&i.home)) {
            let (now, home) = (PathBuf::from(&item.now), PathBuf::from(&item.home));
            let dir = home.parent().unwrap_or(Path::new("")).to_path_buf();
            let res = fileops::move_into(&now, &dir, &file_name(&home));
            self.record(&mut pairs, &mut moved, &mut failed, &now, res);
        }
        self.finish("restore", None, pairs, moved, failed)
    }
}
