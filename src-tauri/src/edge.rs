//! 屏幕边缘律动：一个铺满主屏幕的透明置顶窗口，只在四条边上画跟着音乐动的光带。
//!
//! 永远点击穿透（创建时设一次，之后不再切换）、不进任务栏和 Alt+Tab、不抢焦点。
//! 只有"打开了这个功能 + 正在出声 + 没有全屏程序"时才显示；其余时候藏起来，
//! 不留一个看不见的置顶窗口盖在游戏、全屏视频上面。
//! 窗口底部少 1 像素：盖满屏幕的置顶窗口可能被动态壁纸当成全屏程序而暂停。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

pub const LABEL: &str = "edge";

pub struct Edge {
    win: WebviewWindow,
    hwnd: isize,
    /// 托盘里打开了这个功能
    enabled: AtomicBool,
    /// 页面说现在有声音、光带在亮
    active: AtomicBool,
}

impl Edge {
    pub fn spawn(app: &AppHandle, enabled: bool) -> tauri::Result<Arc<Edge>> {
        let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("edge.html".into()))
            .title("屏幕边缘律动")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(false)
            .focusable(false)
            .disable_drag_drop_handler()
            .visible(false)
            .build()?;
        let hwnd = win.hwnd()?.0 as isize;
        // 永远点击穿透：只在这里设一次（来回切换会让透明窗口整块重绘）
        win.set_ignore_cursor_events(true)?;
        unsafe {
            let h = HWND(hwnd as *mut _);
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            let ex = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize);
        }
        let edge = Arc::new(Edge { win, hwnd, enabled: AtomicBool::new(enabled), active: AtomicBool::new(false) });
        edge.place();
        let me = edge.clone();
        thread::spawn(move || me.run());
        Ok(edge)
    }

    /// 铺满主屏幕（不是工作区：任务栏那条边也要亮），底部少 1 像素
    pub fn place(&self) {
        unsafe {
            let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(mon, &mut mi).as_bool() {
                let r = mi.rcMonitor;
                let _ = self.win.set_position(PhysicalPosition::new(r.left, r.top));
                let _ = self.win.set_size(PhysicalSize::new((r.right - r.left) as u32, (r.bottom - r.top - 1) as u32));
            }
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
        let _ = self.win.emit("edge-enabled", on);
    }

    pub fn set_active(&self, on: bool) {
        self.active.store(on, Ordering::SeqCst);
    }

    /// 该显示时不激活地显示、保持置顶；不该显示时藏起来
    fn run(&self) {
        let hwnd = HWND(self.hwnd as *mut _);
        let mut shown = false;
        loop {
            let want = self.enabled() && self.active.load(Ordering::SeqCst) && !crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst);
            unsafe {
                if want && !shown {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                } else if !want && shown {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
            shown = want;
            thread::sleep(Duration::from_millis(150));
        }
    }
}
