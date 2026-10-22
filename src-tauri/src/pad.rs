//! 手柄按键显示：屏幕角落一个小小的置顶透明窗口，画一个手柄，实时显示按了哪些键、摇杆推到哪、扳机按多深。
//! 玩别的游戏时浮在上面（直播、录视频、教人按键时用）。
//!
//! 用 XInput 读手柄：游戏在前台、这个窗口没有焦点时也读得到（浏览器的 Gamepad API 只在窗口有焦点时才有数据）。
//! 只认 XInput 手柄：Xbox 手柄和大多数 PC 手柄；PS 手柄要开 Steam 输入或 DS4Windows 之类转成 XInput。
//! 永远点击穿透、不抢焦点；托盘里打开了、并且连着手柄时才显示。
//! 不跟着"全屏时隐藏"：本来就是要盖在游戏上（游戏要用"无边框窗口"，独占全屏时任何窗口都盖不上去）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::Input::XboxController::{
    XInputGetBatteryInformation, XInputGetState, BATTERY_DEVTYPE_GAMEPAD, BATTERY_TYPE_DISCONNECTED, BATTERY_TYPE_UNKNOWN,
    BATTERY_TYPE_WIRED, XINPUT_BATTERY_INFORMATION, XINPUT_STATE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

pub const LABEL: &str = "pad";

/// 窗口的逻辑大小（"中"），页面里的手柄也按这个尺寸画
const BASE_W: f64 = 300.0;
const BASE_H: f64 = 190.0;
/// 离屏幕边（工作区，不压任务栏）多远
const MARGIN: f64 = 24.0;

pub const CORNERS: [(&str, &str); 4] =
    [("bottom-left", "左下角"), ("bottom-right", "右下角"), ("top-left", "左上角"), ("top-right", "右上角")];
pub const SIZES: [(&str, &str); 3] = [("small", "小"), ("medium", "中"), ("large", "大")];

fn size_scale(size: &str) -> f64 {
    match size {
        "small" => 0.7,
        "large" => 1.4,
        _ => 1.0,
    }
}

/// 发给页面的一帧
#[derive(Clone, Serialize, PartialEq)]
struct PadState {
    /// 第几个手柄（0~3）
    slot: u32,
    /// XInput 的按键位
    buttons: u16,
    lt: u8,
    rt: u8,
    lx: i16,
    ly: i16,
    rx: i16,
    ry: i16,
    /// 电量 0~3（空 / 低 / 中 / 满）；有线或读不到时没有
    battery: Option<u8>,
}

pub struct Pad {
    win: WebviewWindow,
    hwnd: isize,
    enabled: AtomicBool,
    corner: Mutex<String>,
    size: Mutex<String>,
}

impl Pad {
    pub fn spawn(app: &AppHandle, enabled: bool, corner: &str, size: &str) -> tauri::Result<Arc<Pad>> {
        let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pad.html".into()))
            .title("手柄按键显示")
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
        win.set_ignore_cursor_events(true)?;
        unsafe {
            let h = HWND(hwnd as *mut _);
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            let ex = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize);
        }
        let pad = Arc::new(Pad {
            win,
            hwnd,
            enabled: AtomicBool::new(enabled),
            corner: Mutex::new(corner.to_string()),
            size: Mutex::new(size.to_string()),
        });
        pad.place();
        let me = pad.clone();
        thread::spawn(move || me.run());
        Ok(pad)
    }

    /// 摆到主屏幕工作区的某个角上
    pub fn place(&self) {
        let corner = self.corner.lock().map(|c| c.clone()).unwrap_or_default();
        let k = size_scale(&self.size.lock().map(|s| s.clone()).unwrap_or_default());
        let dpi = self.win.scale_factor().unwrap_or(1.0);
        let w = (BASE_W * k * dpi).round() as i32;
        let h = (BASE_H * k * dpi).round() as i32;
        let m = (MARGIN * dpi).round() as i32;
        unsafe {
            let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(mon, &mut mi).as_bool() {
                let r = mi.rcWork;
                let x = if corner.ends_with("right") { r.right - m - w } else { r.left + m };
                let y = if corner.starts_with("top") { r.top + m } else { r.bottom - m - h };
                let _ = self.win.set_size(PhysicalSize::new(w as u32, h as u32));
                let _ = self.win.set_position(PhysicalPosition::new(x, y));
            }
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn corner(&self) -> String {
        self.corner.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn size(&self) -> String {
        self.size.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn set_corner(&self, corner: &str) {
        if let Ok(mut c) = self.corner.lock() {
            *c = corner.to_string();
        }
        self.place();
    }

    pub fn set_size(&self, size: &str) {
        if let Ok(mut s) = self.size.lock() {
            *s = size.to_string();
        }
        self.place();
    }

    fn read(slot: u32) -> Option<XINPUT_STATE> {
        let mut st = XINPUT_STATE::default();
        // 0 = ERROR_SUCCESS；没连的位置返回 ERROR_DEVICE_NOT_CONNECTED
        (unsafe { XInputGetState(slot, &mut st) } == 0).then_some(st)
    }

    fn battery(slot: u32) -> Option<u8> {
        let mut b = XINPUT_BATTERY_INFORMATION::default();
        if unsafe { XInputGetBatteryInformation(slot, BATTERY_DEVTYPE_GAMEPAD, &mut b) } != 0 {
            return None;
        }
        if b.BatteryType == BATTERY_TYPE_WIRED || b.BatteryType == BATTERY_TYPE_DISCONNECTED || b.BatteryType == BATTERY_TYPE_UNKNOWN {
            return None;
        }
        Some(b.BatteryLevel.0.min(3))
    }

    /// 连着手柄时每秒约 120 次读状态，变了才发给页面；没连时每秒找一次
    fn run(&self) {
        let hwnd = HWND(self.hwnd as *mut _);
        let mut shown = false;
        let mut slot: Option<u32> = None;
        let mut last: Option<PadState> = None;
        let mut battery: Option<u8> = None;
        let mut battery_at = Instant::now() - Duration::from_secs(60);
        let mut top_at = Instant::now();
        loop {
            if !self.enabled() {
                if shown {
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    shown = false;
                }
                slot = None;
                last = None;
                thread::sleep(Duration::from_millis(300));
                continue;
            }
            // 读没连上的位置很慢：只在没找到手柄时一个个找
            let st = match slot.and_then(|s| Self::read(s).map(|st| (s, st))) {
                Some(v) => Some(v),
                None => (0..4).find_map(|s| Self::read(s).map(|st| (s, st))),
            };
            let Some((s, st)) = st else {
                if shown {
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    shown = false;
                }
                slot = None;
                last = None;
                thread::sleep(Duration::from_millis(1000));
                continue;
            };
            slot = Some(s);
            if battery_at.elapsed() > Duration::from_secs(10) {
                battery = Self::battery(s);
                battery_at = Instant::now();
            }
            let g = st.Gamepad;
            let now = PadState {
                slot: s,
                buttons: g.wButtons.0,
                lt: g.bLeftTrigger,
                rt: g.bRightTrigger,
                lx: g.sThumbLX,
                ly: g.sThumbLY,
                rx: g.sThumbRX,
                ry: g.sThumbRY,
                battery,
            };
            if last.as_ref() != Some(&now) {
                let _ = self.win.emit_to(LABEL, "pad-state", &now);
                last = Some(now);
            }
            unsafe {
                if !shown {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    shown = true;
                }
                // 游戏自己也可能是置顶的：每隔一会儿再顶一下
                if top_at.elapsed() > Duration::from_secs(2) {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    top_at = Instant::now();
                }
            }
            thread::sleep(Duration::from_millis(8));
        }
    }
}
