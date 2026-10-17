//! 裂缝射击模式：铺满主屏幕的透明置顶窗口，拿键盘和鼠标焦点；画面只在中间的裂缝里，外面是原本的桌面。
//! 只处理自己窗口里的输入（Pointer Lock 是网页内核自己的功能），不用全局鼠标或键盘钩子。

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};

pub const LABEL: &str = "rift";

/// 打开游戏窗口（已经开着就拿到前面）
pub fn open(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("rift.html".into()))
        .title("裂缝射击")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(true)
        .visible(false)
        .build();
    let win = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[裂缝射击] 窗口创建失败: {e}");
            return;
        }
    };
    // 铺满主屏幕，底部少 1 像素（盖满屏幕又在最前面会被动态壁纸当成全屏程序而暂停）
    unsafe {
        let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            let r = mi.rcMonitor;
            let _ = win.set_position(PhysicalPosition::new(r.left, r.top));
            let _ = win.set_size(PhysicalSize::new((r.right - r.left) as u32, (r.bottom - r.top - 1) as u32));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
pub fn rift_log(msg: String) {
    eprintln!("[裂缝射击] {msg}");
}

/// 页面播完"裂缝合上"的动画后调用
#[tauri::command]
pub fn rift_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
        eprintln!("[裂缝射击] 窗口已关闭");
    }
}
