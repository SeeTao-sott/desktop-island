//! 全屏程序（游戏、全屏视频）时自动隐藏，退出全屏后再出现；顺便盯着主屏幕分辨率变化。
//! 只用系统的只读查询（SHQueryUserNotificationState、前台窗口位置），不挂钩子、不碰其他进程。

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
    MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, IsZoomed, GWL_STYLE, WS_CAPTION,
};

/// 每次检查只是几个系统查询，耗时微秒级
const INTERVAL: Duration = Duration::from_millis(500);

/// 现在是不是有全屏程序在前台；架子据此决定能不能弹出
pub static FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// windows：全屏时要一起藏起来的窗口（灵动岛、架子）
pub fn spawn(windows: Vec<WebviewWindow>, hide_in_fullscreen: bool, on_monitor_change: impl Fn() + Send + 'static) {
    let own: Vec<isize> = windows.iter().filter_map(|w| w.hwnd().ok()).map(|h| h.0 as isize).collect();
    thread::spawn(move || {
        let own: Vec<HWND> = own.into_iter().map(|h| HWND(h as *mut _)).collect();
        let mut hidden = false;
        let mut last_monitor = primary_monitor_rect();
        loop {
            // 就算关了"全屏隐藏"，也要记下全屏状态：玩游戏时架子绝不能弹出来
            let fullscreen = unsafe { fullscreen_active(&own) };
            FULLSCREEN.store(fullscreen, Ordering::SeqCst);
            if hide_in_fullscreen {
                if fullscreen != hidden {
                    hidden = fullscreen;
                    for win in &windows {
                        if fullscreen {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            // 独占全屏的游戏退出后，置顶状态可能被打乱，重新设一次
                            let _ = win.set_always_on_top(true);
                        }
                    }
                    if !fullscreen {
                        if let Some(w) = windows.first() {
                            let _ = w.emit("island-visible", true);
                        }
                    }
                }
            }

            let monitor = primary_monitor_rect();
            if monitor != last_monitor {
                last_monitor = monitor;
                on_monitor_change();
            }
            thread::sleep(INTERVAL);
        }
    });
}

fn primary_monitor_rect() -> (i32, i32, i32, i32) {
    unsafe {
        let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return (0, 0, 0, 0);
        }
        let r = mi.rcMonitor;
        (r.left, r.top, r.right, r.bottom)
    }
}

unsafe fn fullscreen_active(own: &[HWND]) -> bool {
    // 1) 系统明确报告的 D3D 独占全屏 / 演示模式。
    //    不单独相信 QUNS_BUSY：任何盖满屏幕的透明置顶浮层（录屏、显卡浮层等）都会触发它，造成误隐藏
    if let Ok(state) = SHQueryUserNotificationState() {
        if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
            return true;
        }
    }

    // 2) 前台窗口盖满主屏幕：无边框全屏游戏、浏览器全屏视频
    let fg = GetForegroundWindow();
    if fg.is_invalid() || own.contains(&fg) {
        return false;
    }
    // 桌面本身也是盖满屏幕的窗口，要排除
    let mut buf = [0u16; 64];
    let n = GetClassNameW(fg, &mut buf).max(0) as usize;
    let class = String::from_utf16_lossy(&buf[..n]);
    if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
        return false;
    }
    // 只管主屏幕：在副屏全屏不影响主屏顶部的灵动岛
    let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
    if mon.is_invalid() || mon != MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) {
        return false;
    }
    let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let mut r = RECT::default();
    if !GetMonitorInfoW(mon, &mut mi).as_bool() || GetWindowRect(fg, &mut r).is_err() {
        return false;
    }
    let m = mi.rcMonitor;
    let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
    if !covers {
        return false;
    }
    // 任务栏自动隐藏时，普通最大化窗口（带标题栏）也会盖满屏幕，不算全屏
    let style = GetWindowLongW(fg, GWL_STYLE) as u32;
    !(IsZoomed(fg).as_bool() && style & WS_CAPTION.0 == WS_CAPTION.0)
}
