//! 显示 / 隐藏桌面图标：和在桌面上右键 → 查看 →「显示桌面图标」是同一个命令。
//! 只有用户在托盘菜单里自己点了才会调用。

use std::thread;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, SendMessageW, WM_COMMAND};

/// 资源管理器里"显示桌面图标"这个菜单命令的编号
const TOGGLE_DESKTOP_ICONS: usize = 0x7402;

/// 现在桌面图标是不是隐藏着（资源管理器自己记在注册表里）
pub fn hidden() -> bool {
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
            w!("HideIcons"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
        .is_ok()
            && value == 1
    }
}

/// 桌面图标所在的那个窗口：平时挂在 Progman 下；换过壁纸动画等情况会挂在某个 WorkerW 下
fn desktop_view() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), None).ok()?;
        if let Ok(v) = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None) {
            return Some(v);
        }
        let mut worker = FindWindowExW(None, None, w!("WorkerW"), None).ok();
        while let Some(wk) = worker {
            if let Ok(v) = FindWindowExW(Some(wk), None, w!("SHELLDLL_DefView"), None) {
                return Some(v);
            }
            worker = FindWindowExW(None, Some(wk), w!("WorkerW"), None).ok();
        }
        None
    }
}

/// 设成想要的状态；返回最后的实际状态
pub fn set_hidden(hide: bool) -> bool {
    if hidden() != hide {
        if let Some(view) = desktop_view() {
            unsafe {
                SendMessageW(view, WM_COMMAND, Some(WPARAM(TOGGLE_DESKTOP_ICONS)), Some(LPARAM(0)));
            }
            // 资源管理器写注册表要一点时间
            thread::sleep(Duration::from_millis(300));
        }
    }
    hidden()
}
