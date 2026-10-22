//! 鼠标悬停检测 + 点击穿透切换 + 长按检测。
//! 只读取光标坐标（GetCursorPos）和鼠标左键是否按着（GetAsyncKeyState），
//! 不挂任何鼠标/键盘钩子，不读键盘，也不碰其他进程。
//!
//! 长按在这里判断而不是在网页里：网页内核偶尔会把没激活窗口上的第一下按下吃掉，长按就不灵了。
//! 在胶囊上按住左键不动：0.35 秒发 "start"（胶囊轻轻缩一下），满 1 秒发 "fire"（变小球），
//! 中途松开或拖动了发 "cancel"。

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible};

use crate::IslandState;

/// 光标靠近窗口时高频检测，离得远就放慢，空闲几乎不占 CPU
const FAST: Duration = Duration::from_millis(16);
const SLOW: Duration = Duration::from_millis(120);
/// "靠近"的范围（物理像素）
const NEAR_MARGIN: i32 = 160;
/// 长按：多久开始有反馈、多久算数、按着移动多远就不算（物理像素）
const HOLD_HINT: Duration = Duration::from_millis(350);
const HOLD_FIRE: Duration = Duration::from_millis(1000);
const HOLD_SLOP: i32 = 10;

pub fn spawn(win: WebviewWindow, state: Arc<IslandState>) {
    // HWND 不能跨线程传，先转成整数
    let raw = match win.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };

    thread::spawn(move || {
        let hwnd = HWND(raw as *mut _);
        let mut inside = false;
        let mut was_down = false;
        // 正在长按：(按下的时刻, 按下的位置, 已发 start, 已发 fire 或已作废)
        let mut hold: Option<(Instant, POINT, bool, bool)> = None;

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
            // 玩裂缝射击时不理会鼠标：保持点击穿透、不展开（锁定鼠标时看不见的光标也会滑上来）
            let now_inside = !crate::rift::ACTIVE.load(std::sync::atomic::Ordering::SeqCst)
                && state.hit.lock().unwrap().contains(lx, ly);

            if now_inside != inside {
                inside = now_inside;
                let _ = win.set_ignore_cursor_events(!inside);
                let _ = win.emit("island-hover", inside);
            }

            // 长按：只认"在胶囊上按下"的那一下；在别处按下再拖进来不算
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            if down && !was_down && now_inside {
                hold = Some((Instant::now(), pt, false, false));
            }
            if let Some((t0, p0, hinted, done)) = hold.as_mut() {
                let moved = (pt.x - p0.x).abs() > HOLD_SLOP || (pt.y - p0.y).abs() > HOLD_SLOP;
                if !down || moved {
                    if *hinted && !*done {
                        let _ = win.emit("island-hold", "cancel");
                    }
                    hold = None;
                } else if !*done {
                    let held = t0.elapsed();
                    if held >= HOLD_FIRE {
                        *done = true;
                        let _ = win.emit("island-hold", "fire");
                    } else if held >= HOLD_HINT && !*hinted {
                        *hinted = true;
                        let _ = win.emit("island-hold", "start");
                    }
                }
            }
            was_down = down;

            let near = pt.x >= rect.left - NEAR_MARGIN
                && pt.x <= rect.right + NEAR_MARGIN
                && pt.y >= rect.top - NEAR_MARGIN
                && pt.y <= rect.bottom + NEAR_MARGIN;
            thread::sleep(if inside || near || hold.is_some() { FAST } else { SLOW });
        }
    });
}
