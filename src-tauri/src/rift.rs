//! 裂缝射击模式。阶段 0：可行性测试窗口（铺满主屏幕的透明置顶窗口，拿键盘和鼠标焦点）。
//! 只处理自己窗口里的输入（Pointer Lock 是网页内核自己的功能），不用全局鼠标或键盘钩子。

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};

pub const TEST_LABEL: &str = "rift";

/// 打开测试窗口（已经开着就拿到前面）
pub fn open_test(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TEST_LABEL) {
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, TEST_LABEL, WebviewUrl::App("rift-test.html".into()))
        .title("裂缝射击测试")
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
            eprintln!("[裂缝测试] 窗口创建失败: {e}");
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
    eprintln!("[裂缝测试] {msg}");
}

#[tauri::command]
pub fn rift_test_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(TEST_LABEL) {
        let _ = w.close();
        eprintln!("[裂缝测试] 窗口已关闭");
    }
}
