//! 桌面小组件窗口：铺满主屏幕工作区的透明窗口，待在"壁纸之上、所有程序窗口之下"。
//!
//! 做法（阶段 0 实测过）：把**我们自己窗口**的属主（owner）设成桌面窗口 Progman，
//! 再拦下自己窗口的所有 Z 顺序变化，一律压到最底。属主窗口总在被属窗口下面，
//! 所以最底也在桌面（壁纸）之上；按 Win+D 时系统把桌面提到前面，我们也跟着一起出现。
//! 只改我们自己的窗口：不注入任何进程，不改桌面或 Wallpaper Engine 的窗口结构。
//!
//! 组件以外的地方点击穿透（按鼠标位置判断在不在组件形状里）；编辑模式下整个窗口接收鼠标，
//! 并临时浮到程序窗口上面，方便摆放，退出编辑就沉回最底。
//! 音游模式和编辑模式一样浮上来，另外拿键盘焦点（按键靠窗口自己的焦点收到，不用全局键盘钩子），
//! 退出时把焦点还给原来的程序、沉回最底、恢复点击穿透。
//!
//! 点击穿透不用 Tauri 的 set_ignore_cursor_events 来回切：它每次都会把"分层窗口"样式加上又去掉，
//! 再强制刷新边框，透明窗口的整块画面会被系统重建一次——所有组件一起闪。
//! 这里让窗口一直是分层窗口，只翻"鼠标穿透"那一位（WS_EX_TRANSPARENT），不重绘、不动位置和层级。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetCursorPos, GetForegroundWindow, SetForegroundWindow, WA_INACTIVE, WM_ACTIVATE, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, GWLP_HWNDPARENT, GWL_EXSTYLE, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, MA_NOACTIVATE, STYLESTRUCT, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WINDOWPOS, WM_MOUSEACTIVATE, WM_STYLECHANGING,
    WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

/// 一个组件的点击区域：外框（先粗判）+ 形状轮廓（圆、六边形、切角……），CSS 像素
#[derive(Clone, Default, serde::Deserialize)]
pub struct HitShape {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub pts: Vec<[f64; 2]>,
}

impl HitShape {
    /// 点在形状里面（射线法）；没给轮廓就按外框算
    pub fn contains(&self, px: f64, py: f64) -> bool {
        if px < self.x || px > self.x + self.w || py < self.y || py > self.y + self.h {
            return false;
        }
        if self.pts.len() < 3 {
            return true;
        }
        let mut inside = false;
        let n = self.pts.len();
        let mut j = n - 1;
        for i in 0..n {
            let [xi, yi] = self.pts[i];
            let [xj, yj] = self.pts[j];
            if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    fn near(&self, px: f64, py: f64, margin: f64) -> bool {
        px >= self.x - margin && px <= self.x + self.w + margin && py >= self.y - margin && py <= self.y + self.h + margin
    }
}

const LABEL: &str = "widgets";
/// 光标在组件附近时检测得勤一点，离得远就放慢
const FAST: Duration = Duration::from_millis(16);
const SLOW: Duration = Duration::from_millis(120);
const NEAR_MARGIN: f64 = 80.0;
/// 鼠标离开组件后再等这么久才恢复穿透：贴着边缘来回晃时不反复切换（进入是马上可点的，不丢点击）
const LEAVE_DELAY: Duration = Duration::from_millis(60);

/// 编辑模式时允许窗口浮到前面；平时任何 Z 顺序变化都压到最底
static RAISED: AtomicBool = AtomicBool::new(false);
/// 最近一个不是我们自己的前台窗口：万一被激活，把焦点还给它
static LAST_FG: AtomicIsize = AtomicIsize::new(0);
/// 被激活了、等松开鼠标后要把前台还给的窗口
static PENDING_BACK: AtomicIsize = AtomicIsize::new(0);
/// 现在窗口是否接收鼠标（false = 点击穿透）。子类按它锁住扩展样式里的穿透位
static CLICKABLE: AtomicBool = AtomicBool::new(false);
/// 音游模式：窗口可以被激活、拿键盘焦点
static FOCUS: AtomicBool = AtomicBool::new(false);

pub struct Widgets {
    app: AppHandle,
    win: Mutex<Option<WebviewWindow>>,
    hwnd: AtomicIsize,
    /// 各组件在窗口里的位置（CSS 像素），鼠标在这些地方才接收点击
    hits: Mutex<Vec<HitShape>>,
    editing: AtomicBool,
    rhythm: AtomicBool,
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
        // 点组件不激活窗口：不抢焦点，前台程序不变（音游模式除外：要收键盘）
        WM_MOUSEACTIVATE if !FOCUS.load(Ordering::SeqCst) => LRESULT(MA_NOACTIVATE as isize),
        // 网页内核（WebView2）被点时会自己抢焦点；真被激活了就马上把前台还给原来的窗口。
        // 编辑模式除外：拖动途中失去焦点会把拖动取消，退出编辑时再统一还回去
        // 但不能在按下的那一刻就还：网页会因为失去焦点把这次点击丢掉。先记下来，等松开鼠标再还（见 run）
        WM_ACTIVATE if (wp.0 & 0xFFFF) as u32 != WA_INACTIVE && !RAISED.load(Ordering::SeqCst) => {
            let prev = HWND(lp.0 as *mut _);
            let back = if !prev.is_invalid() && prev != hwnd { prev } else { HWND(LAST_FG.load(Ordering::SeqCst) as *mut _) };
            PENDING_BACK.store(back.0 as isize, Ordering::SeqCst);
            DefSubclassProc(hwnd, msg, wp, lp)
        }
        // Tauri 切换置顶等状态时会整个重写扩展样式；在这里把我们要的几位锁住：
        // 工具窗口（不进 Alt+Tab）、不激活、一直是分层窗口（这一位翻转会让整块画面重建 = 闪一下），
        // 去掉"应用窗口"；鼠标穿透位按我们自己记的状态
        WM_STYLECHANGING if wp.0 as i32 == GWL_EXSTYLE.0 => {
            let ss = &mut *(lp.0 as *mut STYLESTRUCT);
            let mut ex = (ss.styleNew | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0) & !WS_EX_APPWINDOW.0;
            if FOCUS.load(Ordering::SeqCst) {
                ex &= !WS_EX_NOACTIVATE.0;
            }
            if CLICKABLE.load(Ordering::SeqCst) {
                ex &= !WS_EX_TRANSPARENT.0;
            } else {
                ex |= WS_EX_TRANSPARENT.0;
            }
            ss.styleNew = ex;
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
            rhythm: AtomicBool::new(false),
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
        // 只在创建时用一次 Tauri 的开关：窗口变成"分层 + 穿透"，Tauri 自己记的状态也一致，
        // 它以后重写样式也会带着分层位。之后的切换都走 set_clickable，只翻穿透位
        CLICKABLE.store(false, Ordering::SeqCst);
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

    pub fn set_hits(&self, rects: Vec<HitShape>) {
        *self.hits.lock().unwrap() = rects;
    }

    pub fn editing(&self) -> bool {
        self.editing.load(Ordering::SeqCst)
    }

    /// 进入 / 退出编辑模式；页面收到 widgets-edit 后切换界面，退出时保存布局
    pub fn set_editing(&self, on: bool) {
        // 音游进行中不进编辑
        if on && self.rhythm() {
            return;
        }
        if self.editing.swap(on, Ordering::SeqCst) == on {
            return;
        }
        let Some(win) = self.window() else { return };
        self.overlay(&win, on, false);
        let _ = win.emit("widgets-edit", on);
    }

    pub fn rhythm(&self) -> bool {
        self.rhythm.load(Ordering::SeqCst)
    }

    /// 进入 / 退出音游模式（选歌菜单和游戏都算）：浮上来、整窗可点、拿键盘焦点。编辑模式下不进
    pub fn set_rhythm(&self, on: bool) -> bool {
        if on && self.editing() {
            return false;
        }
        if self.rhythm.swap(on, Ordering::SeqCst) == on {
            return on;
        }
        let Some(win) = self.window() else { return false };
        self.overlay(&win, on, true);
        on
    }

    /// 浮到程序窗口上面（on）/ 沉回桌面层（off）。focus：浮上来时要不要拿键盘焦点
    fn overlay(&self, win: &WebviewWindow, on: bool, focus: bool) {
        let hwnd = HWND(self.hwnd.load(Ordering::SeqCst) as *mut _);
        RAISED.store(on, Ordering::SeqCst);
        if on && focus {
            // 先放开"不激活"，Tauri 自己记的状态也跟着改，免得它以后重写样式又加回来
            FOCUS.store(true, Ordering::SeqCst);
            PENDING_BACK.store(0, Ordering::SeqCst);
            let _ = win.set_focusable(true);
        }
        // 有属主的窗口不能单独升到别的程序上面：先暂时解开属主，退出时再挂回桌面、压回最底。
        // 前台程序会压住普通窗口，所以临时"置顶"。置顶要用 Tauri 自己的开关：
        // 它重写样式时会按自己记的状态来，自己改的置顶会被冲掉
        let _ = win.set_always_on_top(on);
        unsafe {
            // 换属主要在窗口藏着的时候做：窗口显示着时挂到桌面下面，系统会把它固定在桌面那一层，
            // 之后再也升不上来（实测：第一次编辑正常，第二次起就置顶不了）。藏一下再显示，和刚创建时的顺序一样
            let _ = ShowWindow(hwnd, SW_HIDE);
            if on {
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                if focus {
                    // 刚被用户双击过，系统允许我们拿前台
                    let _ = SetForegroundWindow(hwnd);
                    let _ = win.set_focus();
                }
            } else {
                let had_focus = FOCUS.swap(false, Ordering::SeqCst);
                if had_focus {
                    let _ = win.set_focusable(false);
                }
                // 退出时 Tauri 取消置顶会把窗口放到普通窗口最上面，子类会把它改成压到最底
                let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                attach_to_desktop(hwnd);
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                if GetForegroundWindow() == hwnd || had_focus {
                    let back = HWND(LAST_FG.load(Ordering::SeqCst) as *mut _);
                    if !back.is_invalid() {
                        let _ = SetForegroundWindow(back);
                    }
                }
            }
        }
        set_clickable(hwnd, on);
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
        let mut paused = false;
        // 鼠标最近一次在组件里的时间（离开防抖用）
        let mut last_inside: Option<Instant> = None;
        loop {
            let fullscreen = crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst);
            let win = self.window();
            let raw = self.hwnd.load(Ordering::SeqCst);
            let (Some(win), true) = (win, raw != 0) else {
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
            // 编辑模式必须置顶、平时必须不置顶。Tauri 有时会按它自己记的状态把置顶冲掉，这里发现不对就纠正
            let topmost = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST.0 != 0;
            let raised = self.editing() || self.rhythm();
            if raised != topmost {
                let after = if raised { HWND_TOPMOST } else { HWND_NOTOPMOST };
                unsafe {
                    let _ = SetWindowPos(hwnd, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
            // 点组件时被激活了：松开鼠标后把前台还回去（只看鼠标左键是否按着，不读键盘）
            let back = PENDING_BACK.load(Ordering::SeqCst);
            if back != 0 && unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 == 0 {
                PENDING_BACK.store(0, Ordering::SeqCst);
                if fg == hwnd && !self.editing() && !self.rhythm() {
                    unsafe {
                        let _ = SetForegroundWindow(HWND(back as *mut _));
                    }
                }
            }
            if unsafe { !IsWindowVisible(hwnd).as_bool() } {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
            }
            let raised = self.editing() || self.rhythm();
            if raised || paused {
                // 编辑、音游时整个窗口可点；全屏暂停时穿透（状态没变时 set_clickable 什么都不做）
                set_clickable(hwnd, raised);
                last_inside = None;
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
            if inside {
                last_inside = Some(Instant::now());
                set_clickable(hwnd, true);
            } else if last_inside.is_none_or(|t| t.elapsed() >= LEAVE_DELAY) {
                set_clickable(hwnd, false);
            }
            let near = hits.iter().any(|r| r.near(lx, ly, NEAR_MARGIN));
            thread::sleep(if near { FAST } else { SLOW });
        }
    }
}

/// 窗口接不接收鼠标：只翻扩展样式里的穿透位，不碰分层位、不调 SetWindowPos（不重绘、不改层级）。
/// 状态没变就什么都不做
fn set_clickable(hwnd: HWND, on: bool) {
    if CLICKABLE.swap(on, Ordering::SeqCst) == on {
        return;
    }
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 | WS_EX_LAYERED.0;
        let ex = if on { ex & !WS_EX_TRANSPARENT.0 } else { ex | WS_EX_TRANSPARENT.0 };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
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
