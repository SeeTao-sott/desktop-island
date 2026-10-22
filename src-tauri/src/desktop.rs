//! 一键回到桌面 / 全部最小化。
//!
//! 用 Windows 外壳自己的接口 Shell.Application（就是任务栏右下角"显示桌面"背后那一套）：
//!   回到桌面：ToggleDesktop，再来一次就把窗口恢复
//!   全部最小化：MinimizeAll，再来一次 UndoMinimizeALL 恢复
//! 不模拟按键、不挂钩子、不碰其他进程。
//!
//! 系统做这些的时候可能把我们自己的窗口也一起藏掉：动作之前记下灵动岛、架子哪些是显示着的，
//! 做完之后把它们不激活地重新显示、灵动岛重新置顶（小组件窗口自己会重新显示，见 widgets.rs）。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{IShellDispatch4, Shell};
use windows::Win32::UI::WindowsAndMessaging::{
    IsWindowVisible, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    /// 回到桌面 / 恢复
    Desktop,
    /// 全部最小化 / 恢复
    Minimize,
    /// 什么都不做
    Off,
}

impl Action {
    pub fn parse(s: &str) -> Action {
        match s {
            "minimize" => Action::Minimize,
            "off" => Action::Off,
            _ => Action::Desktop,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Action::Desktop => "desktop",
            Action::Minimize => "minimize",
            Action::Off => "off",
        }
    }
    fn code(self) -> u8 {
        self as u8
    }
    fn from_code(c: u8) -> Action {
        match c {
            1 => Action::Minimize,
            2 => Action::Off,
            _ => Action::Desktop,
        }
    }
}

/// 双击灵动岛做什么（托盘里可以改）
static DOUBLE_CLICK: AtomicU8 = AtomicU8::new(0);
/// 上一次"全部最小化"之后还没恢复
static MINIMIZED: AtomicBool = AtomicBool::new(false);
/// 正在执行：连点几下只算一次
static BUSY: AtomicBool = AtomicBool::new(false);

pub fn set_double_click(a: Action) {
    DOUBLE_CLICK.store(a.code(), Ordering::SeqCst);
}

pub fn double_click() -> Action {
    Action::from_code(DOUBLE_CLICK.load(Ordering::SeqCst))
}

/// 我们自己要保持显示的窗口（灵动岛、架子），HWND 存成整数
#[derive(Clone, Default)]
pub struct Keep {
    /// (窗口, 是否置顶)
    pub windows: Vec<(isize, bool)>,
}

/// 在后台线程里执行（COM 要在自己的线程里初始化），不卡界面
pub fn run(action: Action, keep: Keep) {
    if action == Action::Off || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        // 只记下现在显示着的：本来就藏着的（比如全屏时藏起来的灵动岛）不要被我们弄出来
        let visible: Vec<(isize, bool)> =
            keep.windows.into_iter().filter(|(h, _)| unsafe { IsWindowVisible(HWND(*h as *mut _)).as_bool() }).collect();
        if let Err(e) = shell_call(action) {
            eprintln!("回到桌面 / 全部最小化失败：{e}");
        }
        // 系统切换需要一点时间：分几次检查，被藏掉了就不激活地重新显示
        for wait in [60, 200, 500] {
            thread::sleep(Duration::from_millis(wait));
            for &(raw, topmost) in &visible {
                let hwnd = HWND(raw as *mut _);
                unsafe {
                    if !IsWindowVisible(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    }
                    if topmost {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    }
                }
            }
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

fn shell_call(action: Action) -> windows::core::Result<()> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let r = (|| {
            let sh: IShellDispatch4 = CoCreateInstance(&Shell, None, CLSCTX_INPROC_SERVER)?;
            match action {
                Action::Desktop => sh.ToggleDesktop(),
                Action::Minimize => {
                    if MINIMIZED.swap(false, Ordering::SeqCst) {
                        sh.UndoMinimizeALL()
                    } else {
                        MINIMIZED.store(true, Ordering::SeqCst);
                        sh.MinimizeAll()
                    }
                }
                Action::Off => Ok(()),
            }
        })();
        if init {
            CoUninitialize();
        }
        r
    }
}
