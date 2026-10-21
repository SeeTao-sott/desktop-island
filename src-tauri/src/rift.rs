//! 裂缝射击模式：铺满主屏幕的透明置顶窗口，拿键盘和鼠标焦点；画面只在中间的裂缝里，外面是原本的桌面。
//! 只处理自己窗口里的输入（Pointer Lock 是网页内核自己的功能），不用全局鼠标或键盘钩子。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};

pub const LABEL: &str = "rift";

/// 裂缝射击开着：灵动岛、架子不理会鼠标（鼠标锁定时看不见的系统光标照样会滑到它们上面）
pub static ACTIVE: AtomicBool = AtomicBool::new(false);

/// 选歌菜单选好的歌（文件夹名、谱类型、难度），裂缝窗口打开后来取；没有 = 托盘里的测试模式
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Pick {
    pub id: String,
    pub characteristic: String,
    pub difficulty: String,
    /// 手机模式：用手机点靶子（不锁鼠标、不瞄准）
    #[serde(default)]
    pub phone: bool,
}
static PENDING: Mutex<Option<Pick>> = Mutex::new(None);

/// 从选歌菜单进：记下这首歌，打开裂缝。
/// 必须是异步命令：Windows 上在同步命令里建窗口会卡死（窗口建了一半、一直不显示）
#[tauri::command]
pub async fn rift_open(app: AppHandle, id: String, characteristic: String, difficulty: String, phone: Option<bool>) {
    open_pick(&app, Pick { id, characteristic, difficulty, phone: phone.unwrap_or(false) });
}

/// 记下要玩的歌并打开裂缝（手机遥控也走这里）；已经开着就让页面重新载入，换成这首
pub fn open_pick(app: &AppHandle, pick: Pick) {
    *PENDING.lock().unwrap() = Some(pick);
    if let Some(w) = app.get_webview_window(LABEL) {
        // 已经开着（比如在结算画面换歌）：直接让页面重新载入，读新的歌
        let _ = w.eval("location.reload()");
        let _ = w.set_focus();
        return;
    }
    open(app);
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
    ACTIVE.store(true, Ordering::SeqCst);
    // 窗口不管怎么没的（正常关、出错），都把标记放下
    win.on_window_event(|e| {
        if let tauri::WindowEvent::Destroyed = e {
            ACTIVE.store(false, Ordering::SeqCst);
            *PHONE_STATE.lock().unwrap() = None;
        }
    });
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
        ACTIVE.store(false, Ordering::SeqCst);
        *PHONE_STATE.lock().unwrap() = None;
        let _ = app.emit("rift-active", false);
        eprintln!("[裂缝射击] 窗口已关闭");
    }
}

// ---------------- 设置、模式、最高分：存成文件 ----------------
// 以前放在网页的 localStorage 里，Windows 关机时 WebView2 来不及写盘就会丢（隔天开机设置全回到默认）。
// 现在存在 %APPDATA%\com.stanley.desktopisland\rift.json，内容的格式由页面自己管。

fn store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("rift.json"))
}

/// 读出存过的设置（没有或读不了 = null，页面用默认值）
#[tauri::command]
pub fn rift_store_get(app: AppHandle) -> serde_json::Value {
    store_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 整个覆盖写入：先写临时文件再改名，写到一半断电也不会把旧文件弄坏
#[tauri::command]
pub fn rift_store_set(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = store_path(&app).ok_or("找不到配置文件夹")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------------- 手机模式：页面把局面推上来，手机来要 ----------------
// 局面：阶段（载入中 / 可以开始 / 在打 / 暂停 / 结算）、歌曲时间 0 秒对应的系统时间（手机拿它对拍子）、结算分数。
// 靶子表：开始一局时推一次（编号递增，手机看到编号变了才重新要）。

static PHONE_STATE: Mutex<Option<serde_json::Value>> = Mutex::new(None);
static PHONE_PLAN: Mutex<(u64, serde_json::Value)> = Mutex::new((0, serde_json::Value::Null));

#[tauri::command]
pub fn rift_phone_push(state: serde_json::Value, plan: Option<serde_json::Value>) {
    let id = {
        let mut p = PHONE_PLAN.lock().unwrap();
        if let Some(plan) = plan {
            *p = (p.0 + 1, plan);
        }
        p.0
    };
    let mut state = state;
    if let Some(o) = state.as_object_mut() {
        o.insert("plan".into(), id.into());
    }
    *PHONE_STATE.lock().unwrap() = Some(state);
}

/// 手机要的局面；裂缝没开 = closed
pub fn phone_state() -> serde_json::Value {
    PHONE_STATE.lock().unwrap().clone().unwrap_or_else(|| serde_json::json!({ "phase": "closed" }))
}

pub fn phone_plan() -> serde_json::Value {
    let p = PHONE_PLAN.lock().unwrap();
    serde_json::json!({ "id": p.0, "plan": p.1 })
}
