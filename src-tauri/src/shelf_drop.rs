//! 架子自己的"拖放接收"。
//!
//! 为什么不直接用网页（WebView2）的子窗口接：那些子窗口属于浏览器内核的另一个进程，
//! 内核会不定时把它自己的拖放目标注册回去，和我们的互相覆盖，表现为拖进来时有时"复制"、
//! 有时"禁止"。内核自带的拖放又会把快捷方式解析成它指向的程序，不能用来搬文件。
//!
//! 所以：拖文件经过架子时，在面板上方盖一块我们自己创建的"隐形玻璃"窗口
//! （几乎全透明，但能接住拖放），拖放目标注册在它上面，不会被任何人覆盖；拖完立刻拿掉，
//! 不影响平时点击和滚动。用系统的"拖拽图像助手"画拖拽预览，预览显示在架子上方。

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicIsize, Ordering};

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use windows::core::{implement, w, Ref};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, POINTL, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    CoCreateInstance, IDataObject, CLSCTX_INPROC_SERVER, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{CLSID_DragDropHelper, DragQueryFileW, IDropTargetHelper, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassExW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow,
    HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

#[derive(Clone, Serialize)]
struct DragPayload {
    /// enter / over / leave / drop
    kind: &'static str,
    paths: Vec<String>,
    /// 相对架子窗口左上角的物理像素
    x: i32,
    y: i32,
}

#[implement(IDropTarget)]
struct ShelfDropTarget {
    win: WebviewWindow,
    root: HWND,
    /// 这次拖进来的是不是文件
    valid: Cell<bool>,
    /// 系统的拖拽图像助手：负责在架子上方画拖拽预览
    helper: Option<IDropTargetHelper>,
}

/// 从拖放数据里读出文件路径（系统标准的文件列表格式 CF_HDROP）
fn read_paths(data: &IDataObject) -> Vec<String> {
    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(mut medium) = data.GetData(&fmt) else { return out };
        let hdrop = HDROP(medium.u.hGlobal.0);
        let n = DragQueryFileW(hdrop, u32::MAX, None);
        for i in 0..n {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            out.push(String::from_utf16_lossy(&buf[..len]));
        }
        ReleaseStgMedium(&mut medium);
    }
    out
}

impl ShelfDropTarget {
    fn send(&self, kind: &'static str, paths: Vec<String>, pt: &POINTL) {
        let mut p = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(self.root, &mut p);
        }
        // 跨进程拖放的回调是系统的"同步输入调用"，期间不允许再调用别的 COM 组件
        // （给网页发消息就是），会被系统悄悄拒绝。所以这里只排队，等回调返回后在界面线程里发；
        // 队列保证 enter → over → drop 的顺序不乱
        let payload = DragPayload { kind, paths, x: p.x, y: p.y };
        let win = self.win.clone();
        let _ = self.win.run_on_main_thread(move || {
            let _ = win.emit("shelf-drag", payload);
        });
    }

    fn effect(&self) -> DROPEFFECT {
        // 只说"复制"：拖放来源（比如资源管理器）就不会自己去删原文件，移动由架子按安全流程来做
        if self.valid.get() {
            DROPEFFECT_COPY
        } else {
            DROPEFFECT_NONE
        }
    }
}

fn screen_point(pt: &POINTL) -> POINT {
    POINT { x: pt.x, y: pt.y }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for ShelfDropTarget_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let paths = data.as_ref().map(read_paths).unwrap_or_default();
        self.valid.set(!paths.is_empty());
        let e = self.effect();
        unsafe {
            *effect = e;
            if let (Some(h), Some(d)) = (&self.helper, data.as_ref()) {
                let _ = h.DragEnter(self.root, d, &screen_point(pt), e);
            }
        }
        if self.valid.get() {
            self.send("enter", paths, pt);
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let e = self.effect();
        unsafe {
            *effect = e;
            if let Some(h) = &self.helper {
                let _ = h.DragOver(&screen_point(pt), e);
            }
        }
        if self.valid.get() {
            self.send("over", Vec::new(), pt);
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if let Some(h) = &self.helper {
            unsafe {
                let _ = h.DragLeave();
            }
        }
        if self.valid.replace(false) {
            self.send("leave", Vec::new(), &POINTL::default());
        }
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let e = self.effect();
        unsafe {
            *effect = e;
            if let (Some(h), Some(d)) = (&self.helper, data.as_ref()) {
                let _ = h.Drop(d, &screen_point(pt), e);
            }
        }
        if self.valid.replace(false) {
            let paths = data.as_ref().map(read_paths).unwrap_or_default();
            self.send("drop", paths, pt);
        }
        Ok(())
    }
}

thread_local! {
    /// 接收对象（只在界面线程里用；拖放目标注册期间要一直活着）
    static TARGET: RefCell<Option<IDropTarget>> = const { RefCell::new(None) };
}

/// 隐形玻璃窗口的句柄（0 = 还没建好）
static OVERLAY: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn overlay_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, msg, w, l)
}

/// 建好隐形玻璃窗口并注册拖放接收。架子窗口建好后调用一次，必须在界面线程里。
pub fn init(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let root = HWND(h.0);
    unsafe {
        let class = w!("DesktopIslandShelfDropOverlay");
        let instance = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).ok();
        let wc = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance.unwrap_or_default(),
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassExW(&wc);
        // 不在任务栏、不抢焦点、置顶；归架子窗口所有，跟着它一起
        let Ok(overlay) = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            class,
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            Some(root),
            None,
            instance,
            None,
        ) else {
            eprintln!("拖放玻璃窗口创建失败");
            return;
        };
        // 透明度 1/255：眼睛看不见，但鼠标和拖放能落在它上面
        let _ = SetLayeredWindowAttributes(overlay, COLORREF(0), 1, LWA_ALPHA);

        let helper = CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER).ok();
        let target: IDropTarget = ShelfDropTarget { win: win.clone(), root, valid: Cell::new(false), helper }.into();
        if RegisterDragDrop(overlay, &target).is_err() {
            eprintln!("拖放接收注册失败");
        }
        TARGET.with(|t| *t.borrow_mut() = Some(target));
        OVERLAY.store(overlay.0 as isize, Ordering::SeqCst);
    }
}

/// 盖上（Some = 面板在屏幕上的位置，物理像素）或拿掉隐形玻璃。任何线程都能调。
pub fn set_overlay(win: &WebviewWindow, rect: Option<RECT>) {
    let h = OVERLAY.load(Ordering::SeqCst);
    if h == 0 {
        return;
    }
    let _ = win.run_on_main_thread(move || unsafe {
        let overlay = HWND(h as *mut _);
        match rect {
            Some(r) => {
                let _ = SetWindowPos(
                    overlay,
                    Some(HWND_TOPMOST),
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            None => {
                let _ = ShowWindow(overlay, SW_HIDE);
            }
        }
    });
}
