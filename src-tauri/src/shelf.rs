//! 侧边架子的窗口控制：平时完全藏在屏幕右侧并点击穿透；
//! 鼠标在右边缘中段停留一下、或拖着文件靠近时滑出；鼠标离开稍等再收回；快捷键开关。
//! 判断全靠只读查询（光标位置、前台线程当前由谁捕获鼠标），不挂钩子、不碰其他进程。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetWindowRect, SetForegroundWindow,
    GUITHREADINFO,
};

use crate::config::Config;
use crate::HitRect;

/// 面板右侧留的空隙 + 左侧阴影的余量（逻辑像素），窗口宽度 = 面板宽度 + 这个
pub const WINDOW_EXTRA: u32 = 40;
/// 光标 x 落在屏幕最右这几个物理像素内，才算"推到边缘"
const EDGE_PX: i32 = 2;
/// 停留期间光标上下移动超过这个距离（物理像素）就重新计时：沿着边缘滑过去不算停留
const DWELL_JITTER: i32 = 40;
/// 拖着文件时停留时间更短，方便直接放进去
const DRAG_DWELL: Duration = Duration::from_millis(150);

const FAST: Duration = Duration::from_millis(16);
const NEAR: Duration = Duration::from_millis(30);
const SLOW: Duration = Duration::from_millis(150);
/// 光标离右边缘多近算"靠近"（物理像素），靠近时检测得更勤
const NEAR_PX: i32 = 300;
/// 报"失去焦点"后等多久再确认前台是不是真的换了
const BLUR_CHECK: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Serialize)]
pub struct ShelfState {
    pub open: bool,
    /// 快捷键打开的：不跟着鼠标离开收回
    pub pinned: bool,
}

pub struct Shelf {
    win: WebviewWindow,
    hwnd: isize,
    open: AtomicBool,
    pinned: AtomicBool,
    focused: AtomicBool,
    /// 页面上有"撤销"提示时先别自动收回，免得按钮还没点就跟着藏起来
    hold: AtomicBool,
    /// 滑出前的前台窗口，用快捷键收回时把焦点还给它
    prev_fg: AtomicIsize,
    hit: Mutex<HitRect>,
    zone: (f64, f64),
    dwell: Duration,
    leave_delay: Duration,
    width: u32,
}

enum Capture {
    /// 没有按着鼠标做什么
    None,
    /// 正在用系统拖放拖东西（文件、图片……）
    FileDrag,
    /// 按着鼠标在做别的事：拖滚动条、选文字、拉窗口……这时绝不弹出
    Busy,
}

/// 前台线程现在是谁捕获着鼠标。系统拖放期间捕获窗口是 OLE 专用的 CLIPBRDWNDCLASS
fn capture_kind() -> Capture {
    unsafe {
        let mut gti = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if GetGUIThreadInfo(0, &mut gti).is_err() || gti.hwndCapture.is_invalid() {
            return Capture::None;
        }
        let mut buf = [0u16; 32];
        let n = GetClassNameW(gti.hwndCapture, &mut buf).max(0) as usize;
        if String::from_utf16_lossy(&buf[..n]) == "CLIPBRDWNDCLASS" {
            Capture::FileDrag
        } else {
            Capture::Busy
        }
    }
}

/// 主屏幕的整块区域和可用区域（去掉任务栏）
fn primary_monitor() -> Option<(RECT, RECT)> {
    unsafe {
        let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(mon, &mut mi).as_bool().then_some((mi.rcMonitor, mi.rcWork))
    }
}

impl Shelf {
    pub fn new(win: WebviewWindow, cfg: &Config) -> Arc<Self> {
        let hwnd = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let shelf = Arc::new(Self {
            win,
            hwnd,
            open: AtomicBool::new(false),
            pinned: AtomicBool::new(false),
            focused: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            prev_fg: AtomicIsize::new(0),
            hit: Mutex::new(HitRect::default()),
            zone: (cfg.shelf_zone_top, cfg.shelf_zone_bottom),
            dwell: Duration::from_millis(cfg.shelf_dwell_ms),
            leave_delay: Duration::from_millis(cfg.shelf_leave_delay_ms),
            width: cfg.shelf_width,
        });
        let _ = shelf.place();
        let _ = shelf.win.set_ignore_cursor_events(true);
        let _ = shelf.win.show();
        // 拖文件进来用的隐形玻璃窗口（见 shelf_drop.rs）。这里在界面线程里（setup 中调用）
        crate::shelf_drop::init(&shelf.win);
        let worker = shelf.clone();
        thread::spawn(move || worker.run());
        shelf
    }

    /// 贴在主屏幕可用区域的最右侧，高度占满。窗口大小固定，滑动只在页面里做
    pub fn place(&self) -> tauri::Result<()> {
        let Some((_, work)) = primary_monitor() else { return Ok(()) };
        let scale = unsafe { GetDpiForWindow(HWND(self.hwnd as *mut _)) } as f64 / 96.0;
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let w = ((self.width + WINDOW_EXTRA) as f64 * scale).round() as u32;
        let h = (work.bottom - work.top) as u32;
        self.win.set_size(PhysicalSize::new(w, h))?;
        self.win.set_position(PhysicalPosition::new(work.right - w as i32, work.top))
    }

    /// 面板（含右边空隙）在屏幕上的位置，物理像素
    fn panel_screen_rect(&self) -> Option<RECT> {
        let hwnd = HWND(self.hwnd as *mut _);
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut r) }.ok()?;
        let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let hit = *self.hit.lock().unwrap();
        Some(RECT {
            left: r.left + (hit.x * scale) as i32,
            top: r.top + (hit.y * scale) as i32,
            right: r.left + ((hit.x + hit.w) * scale) as i32,
            bottom: r.top + ((hit.y + hit.h) * scale) as i32,
        })
    }

    pub fn set_hold(&self, on: bool) {
        self.hold.store(on, Ordering::SeqCst);
    }

    pub fn set_hit(&self, r: HitRect) {
        *self.hit.lock().unwrap() = r;
    }

    pub fn state(&self) -> ShelfState {
        ShelfState { open: self.open.load(Ordering::SeqCst), pinned: self.pinned.load(Ordering::SeqCst) }
    }

    fn emit(&self) {
        let _ = self.win.emit("shelf-state", self.state());
    }

    /// 窗口和里面的网页都要拿到焦点，键盘输入才能直接进搜索框
    fn take_focus(&self) {
        let _ = self.win.set_focus();
        let webview: &tauri::Webview = self.win.as_ref();
        let _ = webview.set_focus();
    }

    /// pinned = 快捷键打开：顺便把键盘焦点给架子，可以直接打字搜索
    pub fn show(&self, pinned: bool) {
        if self.open.swap(true, Ordering::SeqCst) {
            if pinned && !self.pinned.swap(true, Ordering::SeqCst) {
                self.take_focus();
                self.emit();
            }
            return;
        }
        self.pinned.store(pinned, Ordering::SeqCst);
        // 平时窗口不可聚焦（显示时不会抢走别的程序的焦点）；滑出后才允许点进来打字
        let _ = self.win.set_focusable(true);
        let fg = unsafe { GetForegroundWindow() }.0 as isize;
        if fg != self.hwnd {
            self.prev_fg.store(fg, Ordering::SeqCst);
        }
        if pinned {
            self.take_focus();
        }
        self.emit();
    }

    pub fn hide(&self) {
        if !self.open.swap(false, Ordering::SeqCst) {
            return;
        }
        self.pinned.store(false, Ordering::SeqCst);
        let _ = self.win.set_ignore_cursor_events(true);
        crate::shelf_drop::set_overlay(&self.win, None);
        self.emit();
        // 收起后键盘焦点不能留在看不见的架子上，还给原来的窗口
        if self.focused.load(Ordering::SeqCst) {
            let prev = self.prev_fg.load(Ordering::SeqCst);
            if prev != 0 {
                unsafe {
                    let _ = SetForegroundWindow(HWND(prev as *mut _));
                }
            }
        }
        let _ = self.win.set_focusable(false);
    }

    pub fn toggle(&self) {
        if self.open.load(Ordering::SeqCst) {
            self.hide();
        } else {
            self.show(true);
        }
    }

    /// 架子失去焦点（点了别的窗口）就收回
    pub fn set_focused(self: &Arc<Self>, focused: bool) {
        // 收着的时候不该有焦点；万一有（比如系统误给），不当回事
        let focused = focused && self.open.load(Ordering::SeqCst);
        self.focused.store(focused, Ordering::SeqCst);
        if focused {
            return;
        }
        // 焦点从窗口移进里面的网页时，也会先报一次"失去焦点"。
        // 稍等一下再看前台是不是真的换成了别的窗口，是才收回
        let me = self.clone();
        thread::spawn(move || {
            thread::sleep(BLUR_CHECK);
            let fg = unsafe { GetForegroundWindow() }.0 as isize;
            if fg != me.hwnd {
                me.focused.store(false, Ordering::SeqCst);
                me.hide();
            } else if me.open.load(Ordering::SeqCst) {
                me.focused.store(true, Ordering::SeqCst);
            }
        });
    }

    fn run(&self) {
        let hwnd = HWND(self.hwnd as *mut _);
        let mut dwell: Option<(Instant, i32)> = None;
        let mut outside_since: Option<Instant> = None;
        let mut interactive = false;
        // 隐形玻璃现在有没有盖在面板上
        let mut overlay_on = false;

        loop {
            let mut pt = POINT::default();
            let monitor = primary_monitor();
            if unsafe { GetCursorPos(&mut pt) }.is_err() || monitor.is_none() {
                thread::sleep(SLOW);
                continue;
            }
            let (mon, _) = monitor.unwrap();
            let fullscreen = crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst);

            if !self.open.load(Ordering::SeqCst) {
                // ---------- 藏着：看要不要滑出来 ----------
                interactive = false;
                outside_since = None;
                overlay_on = false;
                let h = (mon.bottom - mon.top) as f64;
                let at_edge = pt.x >= mon.right - EDGE_PX && pt.x < mon.right;
                let in_zone = at_edge
                    && pt.y >= mon.top + (h * self.zone.0) as i32
                    && pt.y <= mon.top + (h * self.zone.1) as i32;

                let need = match (in_zone && !fullscreen, capture_kind()) {
                    (true, Capture::None) => Some(self.dwell),
                    (true, Capture::FileDrag) => Some(self.dwell.min(DRAG_DWELL)),
                    // 拖滚动条、选文字等：绝不弹出
                    _ => None,
                };
                match (need, dwell) {
                    (Some(need), Some((since, y0))) => {
                        if (pt.y - y0).abs() > DWELL_JITTER {
                            dwell = Some((Instant::now(), pt.y));
                        } else if since.elapsed() >= need {
                            dwell = None;
                            self.show(false);
                            continue;
                        }
                    }
                    (Some(_), None) => dwell = Some((Instant::now(), pt.y)),
                    (None, _) => dwell = None,
                }
                let near = pt.x >= mon.right - NEAR_PX && pt.y >= mon.top && pt.y < mon.bottom;
                thread::sleep(if near { NEAR } else { SLOW });
                continue;
            }

            // ---------- 滑出来了：鼠标在面板上才接收点击，离开稍等就收回 ----------
            dwell = None;
            if fullscreen {
                self.hide();
                continue;
            }
            let mut rect = RECT::default();
            let inside = unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() && {
                let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
                let scale = if scale > 0.0 { scale } else { 1.0 };
                let lx = (pt.x - rect.left) as f64 / scale;
                let ly = (pt.y - rect.top) as f64 / scale;
                self.hit.lock().unwrap().contains(lx, ly)
            };
            if inside != interactive {
                interactive = inside;
                let _ = self.win.set_ignore_cursor_events(!inside);
            }
            // 有文件正拖着：在面板上盖隐形玻璃接住它；拖完马上拿掉
            let file_drag = matches!(capture_kind(), Capture::FileDrag);
            if file_drag != overlay_on {
                overlay_on = file_drag;
                let rect = if file_drag { self.panel_screen_rect() } else { None };
                crate::shelf_drop::set_overlay(&self.win, rect);
            }

            // 拖着文件离开了面板（比如从架子拖去别的程序）：不管有没有焦点都照常收回，
            // 免得架子挡住后面的目标；拖回边缘会再滑出来
            let dragging_away = file_drag && !inside;
            let stay = inside
                || (!dragging_away
                    && (self.pinned.load(Ordering::SeqCst)
                        || self.focused.load(Ordering::SeqCst)
                        || self.hold.load(Ordering::SeqCst)));
            if stay {
                outside_since = None;
            } else {
                let since = *outside_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= self.leave_delay {
                    outside_since = None;
                    self.hide();
                    continue;
                }
            }
            thread::sleep(FAST);
        }
    }
}
