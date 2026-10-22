//! 手机遥控里的「触控板」和「切换窗口」：手机上划一划，电脑的鼠标跟着动。
//!
//! 做法：用系统的 SendInput 模拟鼠标（和插一个 USB 鼠标一样走系统输入队列），
//! 不注入、不修改任何其他程序，也不监听、不记录键盘。
//! 注意：
//! - 管理员权限运行的窗口（比如任务管理器）系统不让普通程序模拟输入，那些窗口上点不动
//! - 有反作弊的游戏可能会把模拟输入当成外挂 —— 玩那种游戏时别用手机控鼠标

use std::mem::size_of;

use serde_json::{json, Value};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_MENU, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GWL_EXSTYLE, GW_OWNER,
    SW_RESTORE, WS_EX_TOOLWINDOW,
};

/// 一次请求最多处理多少个动作（防止乱发一大串）
const MAX_EVENTS: usize = 400;
/// 单次移动 / 滚动的上限（手机那边正常不会超过）
const MAX_STEP: i64 = 4000;

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) {
    if !inputs.is_empty() {
        unsafe {
            SendInput(inputs, size_of::<INPUT>() as i32);
        }
    }
}

/// 按钮的按下 / 松开（返回、前进是鼠标侧面的两个键）
fn button(name: &str, up: bool) -> Option<INPUT> {
    let (flags, data) = match (name, up) {
        ("left", false) => (MOUSEEVENTF_LEFTDOWN, 0),
        ("left", true) => (MOUSEEVENTF_LEFTUP, 0),
        ("right", false) => (MOUSEEVENTF_RIGHTDOWN, 0),
        ("right", true) => (MOUSEEVENTF_RIGHTUP, 0),
        ("middle", false) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        ("middle", true) => (MOUSEEVENTF_MIDDLEUP, 0),
        ("back", false) => (MOUSEEVENTF_XDOWN, 1),
        ("back", true) => (MOUSEEVENTF_XUP, 1),
        ("forward", false) => (MOUSEEVENTF_XDOWN, 2),
        ("forward", true) => (MOUSEEVENTF_XUP, 2),
        _ => return None,
    };
    Some(mouse(0, 0, data, flags))
}

fn clamp(v: Option<&Value>) -> i32 {
    v.and_then(Value::as_i64).unwrap_or(0).clamp(-MAX_STEP, MAX_STEP) as i32
}

/// 手机发来的一串鼠标动作，按顺序做：
/// `{"t":"m","x":dx,"y":dy}` 移动；`{"t":"a","x":0~1,"y":0~1}` 移到主屏幕上的某个位置（体感鼠标"指哪打哪"）；`{"t":"w","y":dy,"x":dx}` 滚轮（120 = 一格）；
/// `{"t":"b","b":"left|right|middle|back|forward","a":"click|down|up"}` 按键
pub fn mouse_events(list: &[Value]) -> Result<usize, String> {
    if list.len() > MAX_EVENTS {
        return Err("动作太多".into());
    }
    let mut out = Vec::with_capacity(list.len() * 2);
    for e in list {
        match e.get("t").and_then(Value::as_str) {
            Some("m") => {
                let (x, y) = (clamp(e.get("x")), clamp(e.get("y")));
                if x != 0 || y != 0 {
                    out.push(mouse(x, y, 0, MOUSEEVENTF_MOVE));
                }
            }
            Some("a") => {
                // 绝对位置：主屏幕左上角 0、右下角 65535
                let f = |k: &str| (e.get(k).and_then(Value::as_f64).unwrap_or(0.5).clamp(0.0, 1.0) * 65535.0).round() as i32;
                out.push(mouse(f("x"), f("y"), 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE));
            }
            Some("w") => {
                let (x, y) = (clamp(e.get("x")), clamp(e.get("y")));
                if y != 0 {
                    out.push(mouse(0, 0, y, MOUSEEVENTF_WHEEL));
                }
                if x != 0 {
                    out.push(mouse(0, 0, x, MOUSEEVENTF_HWHEEL));
                }
            }
            Some("b") => {
                let b = e.get("b").and_then(Value::as_str).unwrap_or("");
                let a = e.get("a").and_then(Value::as_str).unwrap_or("click");
                let (down, up) = (button(b, false).ok_or("不认识的按键")?, button(b, true).unwrap());
                match a {
                    "click" => out.extend([down, up]),
                    "down" => out.push(down),
                    "up" => out.push(up),
                    _ => return Err("不认识的按法".into()),
                }
            }
            _ => return Err("不认识的动作".into()),
        }
    }
    send(&out);
    Ok(out.len())
}

/// 模拟一下不动的鼠标：系统只让"刚收到输入的程序"把自己的窗口拿到前台，这样之后弹出的窗口能拿到焦点
pub fn nudge() {
    send(&[mouse(0, 0, 0, MOUSEEVENTF_MOVE)]);
}

/// 前台现在是不是桌面
pub fn at_desktop() -> bool {
    unsafe {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(GetForegroundWindow(), &mut buf);
        let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        class == "Progman" || class == "WorkerW"
    }
}

/// 像在键盘上按一下 Alt+Tab：切回上一个窗口
pub fn alt_tab() {
    send(&[key(VK_MENU, false), key(VK_TAB, false), key(VK_TAB, true), key(VK_MENU, true)]);
}

// ---------------- 窗口列表 ----------------

fn exe_name(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(h);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
    }
}

fn title(hwnd: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(hwnd);
        if n <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

/// 任务栏上能看到的那种窗口：看得见、有标题、不是工具小窗、没有属主、没被系统藏起来（别的虚拟桌面 / 挂起的应用）、不是我们自己的
fn switchable(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) <= 0 {
            return false;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok() {
            return false;
        }
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return false;
        }
        // 没最小化却是 0 大小的，一般是看不见的后台窗口
        if !IsIconic(hwnd).as_bool() {
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() && (r.right - r.left <= 1 || r.bottom - r.top <= 1) {
                return false;
            }
        }
        true
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> windows::core::BOOL {
    let list = unsafe { &mut *(lp.0 as *mut Vec<HWND>) };
    if switchable(hwnd) {
        list.push(hwnd);
    }
    true.into()
}

fn windows_now() -> Vec<HWND> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize));
    }
    list
}

/// 现在开着的窗口（系统给的顺序就是最近用过的在前）
pub fn list_windows() -> Value {
    let fg = unsafe { GetForegroundWindow() };
    let items: Vec<Value> = windows_now()
        .into_iter()
        .map(|h| {
            json!({
                "id": h.0 as isize,
                "title": title(h),
                "app": exe_name(h),
                "min": unsafe { IsIconic(h).as_bool() },
                "active": h == fg,
            })
        })
        .collect();
    Value::Array(items)
}

/// 把某个窗口拿到最前面；只接受现在窗口列表里有的
pub fn switch_to(id: isize) -> Result<(), String> {
    let hwnd = windows_now().into_iter().find(|h| h.0 as isize == id).ok_or("这个窗口已经关了")?;
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        // 系统只让"刚收到输入的程序"换前台窗口：先模拟一下不动的鼠标，算我们收到了输入
        nudge();
        if !SetForegroundWindow(hwnd).as_bool() {
            // 还不行就按一下 Alt（系统认这个），再试一次
            send(&[key(VK_MENU, false), key(VK_MENU, true)]);
            if !SetForegroundWindow(hwnd).as_bool() {
                return Err("系统不让切过去".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_events() {
        assert!(mouse_events(&[json!({"t": "x"})]).is_err());
        assert!(mouse_events(&[json!({"t": "b", "b": "nose"})]).is_err());
        assert!(mouse_events(&vec![json!({"t": "m", "x": 0, "y": 0}); MAX_EVENTS + 1]).is_err());
        // 全是 0 的移动不会真的发输入
        assert_eq!(mouse_events(&[json!({"t": "m", "x": 0, "y": 0})]).unwrap(), 0);
    }

    #[test]
    #[ignore]
    fn print_windows() {
        println!("{:#}", list_windows());
    }
}
