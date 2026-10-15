// 发布版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hover;
mod media;

use std::sync::{Arc, Mutex};
use tauri::{Manager, PhysicalPosition, WebviewWindow, WindowEvent};

/// 胶囊在窗口内的可交互区域（CSS 像素，相对窗口左上角）
#[derive(Clone, Copy, Default, serde::Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl HitRect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
}

#[derive(Default)]
pub struct IslandState {
    pub hit: Mutex<HitRect>,
}

#[tauri::command]
fn media_cmd(tx: tauri::State<'_, media::MediaTx>, action: String) {
    let msg = match action.as_str() {
        "toggle" => media::Msg::Toggle,
        "next" => media::Msg::Next,
        "prev" => media::Msg::Prev,
        "sync" => media::Msg::Resync,
        _ => media::Msg::Refresh,
    };
    let _ = tx.0.send(msg);
}

#[tauri::command]
fn set_hit_rect(state: tauri::State<'_, Arc<IslandState>>, rect: HitRect) {
    *state.hit.lock().unwrap() = rect;
}

/// 放到主屏幕顶部正中。用物理像素计算，DPI 缩放下也对得齐
fn place_top_center(win: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = win.primary_monitor()? else {
        return Ok(());
    };
    let size = win.outer_size()?;
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let x = m_pos.x + (m_size.width as i32 - size.width as i32) / 2;
    win.set_position(PhysicalPosition::new(x, m_pos.y))
}

fn main() {
    let state = Arc::new(IslandState::default());

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![set_hit_rect, media_cmd])
        .setup(move |app| {
            let win = app.get_webview_window("main").expect("找不到主窗口");
            // 默认整个窗口点击穿透，鼠标进入胶囊时再由 hover 线程打开
            win.set_ignore_cursor_events(true)?;
            place_top_center(&win)?;
            win.show()?;
            hover::spawn(win, state.clone());
            let tx = media::spawn(app.handle().clone());
            app.manage(media::MediaTx(tx));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::ScaleFactorChanged { .. } = event {
                if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                    let _ = place_top_center(&win);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
