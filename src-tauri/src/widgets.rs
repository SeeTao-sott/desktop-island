//! 桌面小组件窗口：铺满主屏幕工作区的透明窗口，待在"壁纸之上、所有程序窗口之下"。
//!
//! 做法（阶段 0 实测过）：把**我们自己窗口**的属主（owner）设成桌面窗口 Progman，
//! 再拦下自己窗口的所有 Z 顺序变化，一律压到最底。属主窗口总在被属窗口下面，
//! 所以最底也在桌面（壁纸）之上；按 Win+D 时系统把桌面提到前面，我们也跟着一起出现。
//! 只改我们自己的窗口：不注入任何进程，不改桌面或 Wallpaper Engine 的窗口结构。
//!
//! 组件以外的地方点击穿透（和灵动岛一样，按鼠标位置切换）；编辑模式下整个窗口接收鼠标，
//! 并临时浮到程序窗口上面，方便摆放，退出编辑就沉回最底。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetCursorPos, GetForegroundWindow, SetForegroundWindow, WA_INACTIVE, WM_ACTIVATE, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, GWLP_HWNDPARENT, GWL_EXSTYLE, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, MA_NOACTIVATE, STYLESTRUCT, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WINDOWPOS, WM_MOUSEACTIVATE, WM_STYLECHANGING,
    WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::HitRect;

const LABEL: &str = "widgets";
/// 光标在组件附近时检测得勤一点，离得远就放慢
const FAST: Duration = Duration::from_millis(16);
const SLOW: Duration = Duration::from_millis(120);
const NEAR_MARGIN: f64 = 80.0;

/// 编辑模式时允许窗口浮到前面；平时任何 Z 顺序变化都压到最底
static RAISED: AtomicBool = AtomicBool::new(false);
/// 最近一个不是我们自己的前台窗口：万一被激活，把焦点还给它
static LAST_FG: AtomicIsize = AtomicIsize::new(0);

pub struct Widgets {
    app: AppHandle,
    win: Mutex<Option<WebviewWindow>>,
    hwnd: AtomicIsize,
    /// 各组件在窗口里的位置（CSS 像素），鼠标在这些地方才接收点击
    hits: Mutex<Vec<HitRect>>,
    editing: AtomicBool,
    layout_path: PathBuf,
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // 点组件不激活窗口：不抢焦点，前台程序不变
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        // 网页内核（WebView2）被点时会自己抢焦点；真被激活了就马上把前台还给原来的窗口。
        // 编辑模式除外：拖动途中失去焦点会把拖动取消，退出编辑时再统一还回去
        WM_ACTIVATE if (wp.0 & 0xFFFF) as u32 != WA_INACTIVE && !RAISED.load(Ordering::SeqCst) => {
            let prev = HWND(lp.0 as *mut _);
            let back = if !prev.is_invalid() && prev != hwnd { prev } else { HWND(LAST_FG.load(Ordering::SeqCst) as *mut _) };
            if !back.is_invalid() {
                let _ = SetForegroundWindow(back);
            }
            DefSubclassProc(hwnd, msg, wp, lp)
        }
        // Tauri 切换点击穿透等状态时会整个重写扩展样式；在这里把我们要的几位锁住：
        // 工具窗口（不进 Alt+Tab）、不激活，去掉"应用窗口"
        WM_STYLECHANGING if wp.0 as i32 == GWL_EXSTYLE.0 => {
            let ss = &mut *(lp.0 as *mut STYLESTRUCT);
            ss.styleNew = (ss.styleNew | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
            DefSubclassProc(hwnd, msg, wp, lp)
        }
        WM_WINDOWPOSCHANGING if !RAISED.load(Ordering::SeqCst) => {
            let pos = &mut *(lp.0 as *mut WINDOWPOS);
            if !pos.flags.contains(SWP_NOZORDER) {
                pos.hwndInsertAfter = HWND_BOTTOM;
            }
            DefSubclassProc(hwnd, msg, wp, lp)
        }
        _ => DefSubclassProc(hwnd, msg, wp, lp),
    }
}

/// 主屏幕的工作区（去掉任务栏），物理像素
fn work_area() -> Option<RECT> {
    unsafe {
        let mon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(mon, &mut mi).as_bool().then_some(mi.rcWork)
    }
}

impl Widgets {
    pub fn new(app: &AppHandle, config_dir: PathBuf) -> Arc<Self> {
        let w = Arc::new(Self {
            app: app.clone(),
            win: Mutex::new(None),
            hwnd: AtomicIsize::new(0),
            hits: Mutex::new(Vec::new()),
            editing: AtomicBool::new(false),
            layout_path: config_dir.join("widgets-layout.json"),
        });
        if let Err(e) = w.create() {
            eprintln!("小组件窗口创建失败: {e}");
        }
        let worker = w.clone();
        thread::spawn(move || worker.run());
        w
    }

    /// 建窗口并挂到桌面层。必须在界面线程里调用（子类化要在窗口所属线程做）
    fn create(self: &Arc<Self>) -> tauri::Result<()> {
        let win = WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::App("widgets.html".into()))
            .title("桌面小组件")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .disable_drag_drop_handler()
            .visible(false)
            .build()?;
        let hwnd = win.hwnd()?;
        self.hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
        self.place(&win);
        // 先挂子类（只能在窗口所属的界面线程里挂），再改样式：之后任何人重写样式都会被子类补回来
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 0x5749_4447, 0);
        }
        attach_to_desktop(hwnd);
        win.set_ignore_cursor_events(true)?;
        // 显示但不激活：不抢前台程序的焦点
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // 资源管理器重启时桌面窗口会被销毁，挂在它下面的窗口也跟着没了：等新桌面出来后重建
        let me = self.clone();
        win.on_window_event(move |e| {
            if let WindowEvent::Destroyed = e {
                me.hwnd.store(0, Ordering::SeqCst);
                *me.win.lock().unwrap() = None;
                let me2 = me.clone();
                thread::spawn(move || me2.recreate_later());
            }
        });
        *self.win.lock().unwrap() = Some(win);
        Ok(())
    }

    fn recreate_later(self: Arc<Self>) {
        for _ in 0..120 {
            thread::sleep(Duration::from_millis(500));
            let progman = unsafe { FindWindowW(w!("Progman"), None) };
            if progman.is_ok_and(|h| !h.is_invalid()) {
                // 新桌面刚出现时还在初始化，再等一下
                thread::sleep(Duration::from_millis(1500));
                let me = self.clone();
                let _ = self.app.run_on_main_thread(move || {
                    if me.app.get_webview_window(LABEL).is_none() {
                        if let Err(e) = me.create() {
                            eprintln!("小组件窗口重建失败: {e}");
                        }
                    }
                });
                return;
            }
        }
    }

    fn window(&self) -> Option<WebviewWindow> {
        self.win.lock().unwrap().clone()
    }

    /// 铺满主屏幕工作区
    fn place(&self, win: &WebviewWindow) {
        if let Some(r) = work_area() {
            let _ = win.set_position(PhysicalPosition::new(r.left, r.top));
            let _ = win.set_size(PhysicalSize::new((r.right - r.left) as u32, (r.bottom - r.top) as u32));
        }
    }

    /// 主屏幕分辨率 / 任务栏变了
    pub fn replace(&self) {
        if let Some(win) = self.window() {
            self.place(&win);
        }
    }

    pub fn set_hits(&self, rects: Vec<HitRect>) {
        *self.hits.lock().unwrap() = rects;
    }

    pub fn editing(&self) -> bool {
        self.editing.load(Ordering::SeqCst)
    }

    /// 进入 / 退出编辑模式；页面收到 widgets-edit 后切换界面，退出时保存布局
    pub fn set_editing(&self, on: bool) {
        if self.editing.swap(on, Ordering::SeqCst) == on {
            return;
        }
        let Some(win) = self.window() else { return };
        let hwnd = HWND(self.hwnd.load(Ordering::SeqCst) as *mut _);
        RAISED.store(on, Ordering::SeqCst);
        unsafe {
            // 有属主的窗口不能单独升到别的程序上面：编辑时先暂时解开属主，退出时再挂回桌面、压回最底
            // 前台程序会压住普通窗口，所以编辑时临时"置顶"
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
            if on {
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
            } else {
                let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
                attach_to_desktop(hwnd);
                if GetForegroundWindow() == hwnd {
                    let back = HWND(LAST_FG.load(Ordering::SeqCst) as *mut _);
                    if !back.is_invalid() {
                        let _ = SetForegroundWindow(back);
                    }
                }
            }
        }
        let _ = win.set_ignore_cursor_events(!on);
        let _ = win.emit("widgets-edit", on);
    }

    pub fn toggle_editing(&self) {
        self.set_editing(!self.editing());
    }

    pub fn load_layout(&self) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(&self.layout_path).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// 先写临时文件再换名，写到一半断电也不会把布局弄坏
    pub fn save_layout(&self, layout: &serde_json::Value) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(layout).map_err(std::io::Error::other)?;
        let tmp = self.layout_path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &self.layout_path)
    }

    /// 鼠标在组件上才接收点击；全屏程序时通知页面暂停更新
    fn run(&self) {
        let mut interactive = false;
        let mut paused = false;
        loop {
            let fullscreen = crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst);
            let win = self.window();
            let raw = self.hwnd.load(Ordering::SeqCst);
            let (Some(win), true) = (win, raw != 0) else {
                interactive = false;
                thread::sleep(SLOW);
                continue;
            };
            if fullscreen != paused {
                paused = fullscreen;
                let _ = win.emit("widgets-paused", paused);
            }
            // 按 Win+D 时系统会把这个窗口藏起来（普通样式的窗口都会）：不激活地马上重新显示
            let hwnd = HWND(raw as *mut _);
            let fg = unsafe { GetForegroundWindow() };
            if !fg.is_invalid() && fg != hwnd {
                LAST_FG.store(fg.0 as isize, Ordering::SeqCst);
            }
            if unsafe { !IsWindowVisible(hwnd).as_bool() } {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
            }
            if self.editing() || paused {
                interactive = self.editing();
                thread::sleep(SLOW);
                continue;
            }
            let mut pt = POINT::default();
            let mut rect = RECT::default();
            let ok = unsafe {
                IsWindowVisible(hwnd).as_bool() && GetCursorPos(&mut pt).is_ok() && GetWindowRect(hwnd, &mut rect).is_ok()
            };
            if !ok {
                thread::sleep(SLOW);
                continue;
            }
            let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let (lx, ly) = ((pt.x - rect.left) as f64 / scale, (pt.y - rect.top) as f64 / scale);
            let hits = self.hits.lock().unwrap().clone();
            let inside = hits.iter().any(|r| r.contains(lx, ly));
            if inside != interactive {
                interactive = inside;
                let _ = win.set_ignore_cursor_events(!inside);
            }
            let near = hits.iter().any(|r| {
                lx >= r.x - NEAR_MARGIN && lx <= r.x + r.w + NEAR_MARGIN && ly >= r.y - NEAR_MARGIN && ly <= r.y + r.h + NEAR_MARGIN
            });
            thread::sleep(if near { FAST } else { SLOW });
        }
    }
}

/// 只改我们自己的窗口：属主设成桌面、不进任务栏和 Alt+Tab、点了不激活、压到最底
fn attach_to_desktop(hwnd: HWND) {
    unsafe {
        if let Ok(progman) = FindWindowW(w!("Progman"), None) {
            SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, progman.0 as isize);
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let ex = (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}
