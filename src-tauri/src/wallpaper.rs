//! 找到"现在的壁纸是哪张图"，给小组件取色用。
//!
//! - Wallpaper Engine 在运行：用它自己的命令行 `-control getWallpaper` 问当前壁纸，
//!   再读壁纸文件夹里的预览图（project.json 的 preview）。
//!   它把结果写进"调用者的控制台"，普通管道读不到，所以在看不见的伪控制台（ConPTY）里调用。
//! - 否则：读 Windows 系统壁纸（TranscodedWallpaper 是系统实际在用的那张，幻灯片、聚焦也对）。
//!
//! 只是启动 Wallpaper Engine 官方的命令行和读文件：不注入、不碰它的窗口。

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::ReadFile;
use windows::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

/// 一次识别的结果
#[derive(Clone, Debug, PartialEq)]
pub struct Wallpaper {
    /// "wallpaper-engine" 或 "windows"
    pub source: &'static str,
    /// 用来取色的图片
    pub image: PathBuf,
    /// 图片的修改时间：同一路径换了内容也认得出来
    pub modified: Option<SystemTime>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn reg_string(key: &str, name: &str) -> Option<String> {
    let (k, n) = (wide(key), wide(name));
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(k.as_ptr()),
            PCWSTR(n.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let s = String::from_utf16_lossy(&buf[..len]);
    (!s.is_empty()).then_some(s)
}

/// Wallpaper Engine 现在有没有在运行（只看进程列表）
pub fn engine_running() -> bool {
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut e = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_ascii_lowercase();
                if name == "wallpaper64.exe" || name == "wallpaper32.exe" {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// Wallpaper Engine 的程序位置：安装时写在注册表里
fn engine_exe() -> Option<PathBuf> {
    let p = PathBuf::from(reg_string(r"Software\WallpaperEngine", "installPath")?);
    p.exists().then_some(p)
}

/// Wallpaper Engine 自己的配置文件（换壁纸时会被改写）：用它的修改时间当"可能换了"的信号
pub fn engine_config_modified() -> Option<SystemTime> {
    let dir = engine_exe()?.parent()?.to_path_buf();
    std::fs::metadata(dir.join("config.json")).ok()?.modified().ok()
}

/// 去掉终端控制序列（颜色、光标移动等），只留文字
fn strip_vt(text: &str) -> String {
    let mut out = String::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                while let Some(d) = it.next() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(d) = it.next() {
                    if d == '\x07' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// 在看不见的伪控制台里运行一行命令，收集它（和它的子进程）写到控制台的文字
fn run_in_pseudo_console(cmdline: &str, wait: Duration) -> Option<String> {
    unsafe {
        let (mut in_r, mut in_w, mut out_r, mut out_w) =
            (HANDLE::default(), HANDLE::default(), HANDLE::default(), HANDLE::default());
        CreatePipe(&mut in_r, &mut in_w, None, 0).ok()?;
        CreatePipe(&mut out_r, &mut out_w, None, 0).ok()?;
        let hpc: HPCON = CreatePseudoConsole(COORD { X: 400, Y: 20 }, in_r, out_w, 0).ok()?;

        let mut size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
        let mut buf = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr() as *mut c_void);
        let ok = InitializeProcThreadAttributeList(Some(list), 1, None, &mut size).is_ok()
            && UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(hpc.0 as *const c_void),
                size_of::<HPCON>(),
                None,
                None,
            )
            .is_ok();
        let mut text = None;
        if ok {
            let mut si = STARTUPINFOEXW::default();
            si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            si.lpAttributeList = list;
            // 不继承我们自己的标准输入输出，强制用伪控制台
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            let mut cmd = wide(cmdline);
            let mut pi = PROCESS_INFORMATION::default();
            if CreateProcessW(
                None,
                Some(PWSTR(cmd.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                None,
                None,
                &si.StartupInfo,
                &mut pi,
            )
            .is_ok()
            {
                // 读输出放在另一个线程；关掉伪控制台后读取端才会结束
                let raw = out_r.0 as isize;
                let reader = std::thread::spawn(move || {
                    let mut all = Vec::new();
                    let mut b = [0u8; 4096];
                    loop {
                        let mut n = 0u32;
                        if ReadFile(HANDLE(raw as *mut c_void), Some(&mut b), Some(&mut n), None).is_err() || n == 0 {
                            break;
                        }
                        all.extend_from_slice(&b[..n as usize]);
                    }
                    all
                });
                if WaitForSingleObject(pi.hProcess, wait.as_millis() as u32).0 != 0 {
                    let _ = TerminateProcess(pi.hProcess, 1);
                }
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
                ClosePseudoConsole(hpc);
                let _ = CloseHandle(out_w);
                let _ = CloseHandle(in_r);
                if let Ok(raw) = reader.join() {
                    text = Some(strip_vt(&String::from_utf8_lossy(&raw)));
                }
                let _ = CloseHandle(out_r);
                let _ = CloseHandle(in_w);
                DeleteProcThreadAttributeList(list);
                return text;
            }
        }
        ClosePseudoConsole(hpc);
        for h in [in_r, in_w, out_r, out_w] {
            let _ = CloseHandle(h);
        }
        DeleteProcThreadAttributeList(list);
        text
    }
}

/// 问 Wallpaper Engine 当前壁纸的文件（scene.pkg、xxx.mp4、index.html……）
pub fn engine_current() -> Option<PathBuf> {
    let exe = engine_exe()?;
    // 它是先交给已在运行的主程序、再把结果写回控制台，所以控制台要多留一会儿（ping 约等 1 秒）
    let cmd = format!("cmd.exe /d /c \"\"{}\" -control getWallpaper & ping -n 2 127.0.0.1 > nul\"", exe.display());
    let out = run_in_pseudo_console(&cmd, Duration::from_secs(4))?;
    out.lines()
        .map(str::trim)
        .find(|l| l.len() > 3 && (l.contains(":/") || l.contains(":\\")))
        .map(|l| PathBuf::from(l.replace('/', "\\")))
}

/// 壁纸文件夹里的预览图：project.json 里写的 preview，没有就找 preview.*
fn engine_preview(wallpaper_file: &Path) -> Option<PathBuf> {
    let dir = wallpaper_file.parent()?;
    if let Ok(text) = std::fs::read_to_string(dir.join("project.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(p) = v["preview"].as_str() {
                let p = dir.join(p);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    ["preview.jpg", "preview.png", "preview.gif", "preview.webp"].iter().map(|n| dir.join(n)).find(|p| p.exists())
}

/// Windows 系统壁纸：优先用系统实际在用的 TranscodedWallpaper
pub fn windows_image() -> Option<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let t = PathBuf::from(appdata).join(r"Microsoft\Windows\Themes\TranscodedWallpaper");
        if t.exists() {
            return Some(t);
        }
    }
    let p = PathBuf::from(reg_string(r"Control Panel\Desktop", "WallPaper")?);
    p.exists().then_some(p)
}

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

/// 现在的壁纸（比较慢：Wallpaper Engine 在运行时要等它回答，约 1 秒）
pub fn detect() -> Option<Wallpaper> {
    if engine_running() {
        if let Some(img) = engine_current().and_then(|f| engine_preview(&f)) {
            return Some(Wallpaper { source: "wallpaper-engine", modified: modified(&img), image: img });
        }
    }
    let img = windows_image()?;
    Some(Wallpaper { source: "windows", modified: modified(&img), image: img })
}

/// 很便宜的"可能换壁纸了"信号：几次系统查询，不启动任何程序
pub fn quick_signature() -> (bool, Option<SystemTime>, Option<SystemTime>) {
    let running = engine_running();
    let cfg = if running { engine_config_modified() } else { None };
    let win = windows_image().and_then(|p| modified(&p));
    (running, cfg, win)
}
