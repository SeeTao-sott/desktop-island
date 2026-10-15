//! 鼠标悬停检测 + 点击穿透切换。
//! 只读取光标坐标（GetCursorPos），不挂任何鼠标/键盘钩子，也不碰其他进程。

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible};

use crate::IslandState;

/// 光标靠近窗口时高频检测，离得远就放慢，空闲几乎不占 CPU
const FAST: Duration = Duration::from_millis(16);
const SLOW: Duration = Duration::from_millis(120);
/// "靠近"的范围（物理像素）
const NEAR_MARGIN: i32 = 160;

pub fn spawn(win: WebviewWindow, state: Arc<IslandState>) {
    // HWND 不能跨线程传，先转成整数
    let raw = match win.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };

    thread::spawn(move || {
        let hwnd = HWND(raw as *mut _);
        let mut inside = false;

        loop {
            let mut pt = POINT::default();
            let mut rect = RECT::default();
            let ok = unsafe {
                IsWindowVisible(hwnd).as_bool()
                    && GetCursorPos(&mut pt).is_ok()
                    && GetWindowRect(hwnd, &mut rect).is_ok()
            };
            if !ok {
                thread::sleep(SLOW);
                continue;
            }

            let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let lx = (pt.x - rect.left) as f64 / scale;
            let ly = (pt.y - rect.top) as f64 / scale;
            let now_inside = state.hit.lock().unwrap().contains(lx, ly);

            if now_inside != inside {
                inside = now_inside;
                let _ = win.set_ignore_cursor_events(!inside);
                let _ = win.emit("island-hover", inside);
            }

            let near = pt.x >= rect.left - NEAR_MARGIN
                && pt.x <= rect.right + NEAR_MARGIN
                && pt.y >= rect.top - NEAR_MARGIN
                && pt.y <= rect.bottom + NEAR_MARGIN;
            thread::sleep(if inside || near { FAST } else { SLOW });
        }
    });
}
