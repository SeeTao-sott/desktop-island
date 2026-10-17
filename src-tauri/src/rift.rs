//! 裂缝射击模式：铺满主屏幕的透明置顶窗口，拿键盘和鼠标焦点；画面只在中间的裂缝里，外面是原本的桌面。
//! 只处理自己窗口里的输入（Pointer Lock 是网页内核自己的功能），不用全局鼠标或键盘钩子。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};

pub const LABEL: &str = "rift";

/// 选歌菜单选好的歌（文件夹名、谱类型、难度），裂缝窗口打开后来取；没有 = 托盘里的测试模式
#[derive(Clone, serde::Serialize)]
pub struct Pick {
    pub id: String,
    pub characteristic: String,
    pub difficulty: String,
}
static PENDING: Mutex<Option<Pick>> = Mutex::new(None);

/// 从选歌菜单进：记下这首歌，打开裂缝。
/// 必须是异步命令：Windows 上在同步命令里建窗口会卡死（窗口建了一半、一直不显示）
#[tauri::command]
pub async fn rift_open(app: AppHandle, id: String, characteristic: String, difficulty: String) {
    *PENDING.lock().unwrap() = Some(Pick { id, characteristic, difficulty });
    open(&app);
}

/// 裂缝页面加载好后来取要玩的歌（取一次就清掉）
#[tauri::command]
pub fn rift_pending() -> Option<Pick> {
    PENDING.lock().unwrap().take()
}

/// 打中靶子：让桌面上的律动组件闪一下
#[tauri::command]
pub fn rift_hit(app: AppHandle) {
    let _ = app.emit_to("widgets", "rift-hit", ());
}

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
    // 告诉小组件、边缘律动：游戏开始了，先停掉重的动画
    let _ = app.emit("rift-active", true);
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
        let _ = app.emit("rift-active", false);
        eprintln!("[裂缝射击] 窗口已关闭");
    }
}
