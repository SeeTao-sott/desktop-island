//! 架子自己的"拖放接收"。
//! Tauri/WebView2 默认的接收在架子这种"先隐藏再显示"的窗口上不可靠（浏览器内核后创建的子窗口
//! 会注册一个不收外部文件的目标，拖进来显示"禁止"）。所以这里直接在架子窗口的子窗口上
//! 注册我们自己的接收：读出拖进来的文件路径和位置，转发给页面。只作用于架子自己的窗口。

use std::cell::{Cell, RefCell};

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use windows::core::{implement, Ref, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

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
        unsafe { *effect = self.effect() };
        if self.valid.get() {
            self.send("enter", paths, pt);
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> windows::core::Result<()> {
        unsafe { *effect = self.effect() };
        if self.valid.get() {
            self.send("over", Vec::new(), pt);
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
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
        unsafe { *effect = self.effect() };
        if self.valid.replace(false) {
            let paths = data.as_ref().map(read_paths).unwrap_or_default();
            self.send("drop", paths, pt);
        }
        Ok(())
    }
}

thread_local! {
    /// 接收对象只建一个，反复注册时复用（只在界面线程里用）
    static TARGET: RefCell<Option<IDropTarget>> = const { RefCell::new(None) };
}

unsafe extern "system" fn register_child(h: HWND, lparam: LPARAM) -> BOOL {
    let target = &*(lparam.0 as *const IDropTarget);
    // 先撤掉原来的（浏览器内核的、或者上一次我们自己的），再换成我们的
    let _ = RevokeDragDrop(h);
    let _ = RegisterDragDrop(h, target);
    BOOL(1)
}

/// 在架子窗口的所有子窗口上装好我们的拖放接收。必须在界面线程里调用。
/// 浏览器内核可能之后又换回去，所以每次架子滑出、鼠标进入面板时都再装一次（很便宜）。
pub fn install(win: &WebviewWindow) {
    let Ok(h) = win.hwnd() else { return };
    let root = HWND(h.0);
    let target = TARGET.with(|t| {
        t.borrow_mut()
            .get_or_insert_with(|| ShelfDropTarget { win: win.clone(), root, valid: Cell::new(false) }.into())
            .clone()
    });
    unsafe {
        let _ = EnumChildWindows(Some(root), Some(register_child), LPARAM(&target as *const IDropTarget as isize));
    }
}
