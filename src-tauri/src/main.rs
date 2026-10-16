// 发布版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod autostart;
mod config;
mod desktop_icons;
mod fileops;
mod fullscreen;
mod hotkey;
mod hover;
mod icons;
mod media;
mod pomodoro;
mod shelf;
mod shelf_cmds;
mod shelf_drop;
mod shelf_fs;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

use alerts::{AlertHub, Alerts};
use config::Config;
use pomodoro::{PomoState, Pomodoro};
use shelf::{Shelf, ShelfState};

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
fn set_hit_rect(state: State<'_, Arc<IslandState>>, rect: HitRect) {
    *state.hit.lock().unwrap() = rect;
}

#[tauri::command]
fn media_cmd(tx: State<'_, media::MediaTx>, action: String) {
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
fn pomodoro_cmd(p: State<'_, Arc<Pomodoro>>, action: String) -> PomoState {
    if action == "get" {
        p.get()
    } else {
        p.act(&action)
    }
}

#[tauri::command]
fn alerts_get(hub: State<'_, Arc<AlertHub>>) -> Alerts {
    hub.get()
}

#[tauri::command]
fn shelf_set_hit_rect(shelf: State<'_, Arc<Shelf>>, rect: HitRect) {
    shelf.set_hit(rect);
}

#[tauri::command]
fn shelf_cmd(shelf: State<'_, Arc<Shelf>>, action: String) -> ShelfState {
    match action.as_str() {
        "toggle" => shelf.toggle(),
        "hide" => shelf.hide(),
        "hold" => shelf.set_hold(true),
        "release" => shelf.set_hold(false),
        "activity" => shelf.touch(),
        _ => {}
    }
    shelf.state()
}

#[tauri::command]
fn config_get(cfg: State<'_, Config>) -> Config {
    cfg.inner().clone()
}

// ---------------- 只允许运行一个 ----------------

static INSTANCE_MUTEX: AtomicIsize = AtomicIsize::new(0);

/// 已经有一个在运行就返回 false
fn claim_single_instance() -> bool {
    unsafe {
        match CreateMutexW(None, true, w!("Local\\DesktopIsland.SingleInstance")) {
            Ok(h) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = CloseHandle(h);
                    return false;
                }
                INSTANCE_MUTEX.store(h.0 as isize, Ordering::SeqCst);
                true
            }
            // 拿不到互斥量也照常运行，不因为这个打不开
            Err(_) => true,
        }
    }
}

/// 重启前先放开，新进程才能启动
fn release_single_instance() {
    let h = INSTANCE_MUTEX.swap(0, Ordering::SeqCst);
    if h != 0 {
        unsafe {
            let _ = CloseHandle(HANDLE(h as *mut _));
        }
    }
}

// ---------------- 窗口位置 ----------------

/// 放到主屏幕顶部正中，再加上配置里的偏移。用物理像素计算，DPI 缩放下也对得齐
fn place_window(win: &WebviewWindow, offset: (i32, i32)) -> tauri::Result<()> {
    let Some(monitor) = win.primary_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let size = win.outer_size()?;
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let x = m_pos.x + (m_size.width as i32 - size.width as i32) / 2 + (offset.0 as f64 * scale) as i32;
    let y = m_pos.y + (offset.1 as f64 * scale) as i32;
    win.set_position(PhysicalPosition::new(x, y))
}

// ---------------- 托盘 ----------------

fn build_tray(app: &App, cfg_path: PathBuf, shelf: Option<Arc<Shelf>>, hotkey: &str) -> tauri::Result<()> {
    let shelf_label = if hotkey.is_empty() { "打开/关闭架子".to_string() } else { format!("打开/关闭架子\t{hotkey}") };
    let has_shelf = shelf.is_some();
    let shelf_item = MenuItem::with_id(app, "shelf", shelf_label, has_shelf, None::<&str>)?;
    let migrate = MenuItem::with_id(app, "migrate", "从桌面搬进架子…", has_shelf, None::<&str>)?;
    let restore = MenuItem::with_id(app, "restore", "把桌面来的东西搬回桌面…", has_shelf, None::<&str>)?;
    let icons = CheckMenuItem::with_id(app, "desktop_icons", "隐藏桌面图标", true, desktop_icons::hidden(), None::<&str>)?;
    let open_cfg = MenuItem::with_id(app, "open_config", "打开配置文件", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启（应用新配置）", true, None::<&str>)?;
    let auto = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, autostart::is_enabled(), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出灵动岛", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &shelf_item,
            &migrate,
            &restore,
            &icons,
            &PredefinedMenuItem::separator(app)?,
            &open_cfg,
            &restart,
            &PredefinedMenuItem::separator(app)?,
            &auto,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let auto_item = auto.clone();
    let icons_item = icons.clone();
    TrayIconBuilder::with_id("island")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .tooltip("灵动岛")
        .menu(&menu)
        // 左键、右键都能打开菜单
        .show_menu_on_left_click(true)
        .on_menu_event(move |app: &AppHandle, event| match event.id().as_ref() {
            "shelf" => {
                if let Some(s) = &shelf {
                    s.toggle();
                }
            }
            // 打开架子，并在架子里弹出"搬家"/"搬回"的确认页
            "migrate" | "restore" => {
                if let Some(s) = &shelf {
                    s.show(true);
                    let _ = app.emit("shelf-sheet", event.id().as_ref());
                }
            }
            "desktop_icons" => {
                let want = icons_item.is_checked().unwrap_or(false);
                let item = icons_item.clone();
                // 资源管理器改完要一点时间，放到后台线程里等
                std::thread::spawn(move || {
                    let _ = item.set_checked(desktop_icons::set_hidden(want));
                });
            }
            "open_config" => {
                let _ = Command::new("notepad.exe").arg(&cfg_path).spawn();
            }
            "restart" => {
                release_single_instance();
                app.restart();
            }
            "autostart" => {
                // 菜单项被点后勾选状态已经翻转，以注册表实际结果为准
                let want = auto_item.is_checked().unwrap_or(false);
                let _ = autostart::set(want);
                let _ = auto_item.set_checked(autostart::is_enabled());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    if !claim_single_instance() {
        return;
    }
    let state = Arc::new(IslandState::default());

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            set_hit_rect,
            media_cmd,
            pomodoro_cmd,
            alerts_get,
            config_get,
            shelf_set_hit_rect,
            shelf_cmd,
            shelf_cmds::shelf_list,
            shelf_cmds::shelf_put,
            shelf_cmds::shelf_move,
            shelf_cmds::shelf_rename,
            shelf_cmds::shelf_remove,
            shelf_cmds::shelf_undo,
            shelf_cmds::shelf_open,
            shelf_cmds::shelf_reveal,
            shelf_cmds::shelf_open_removed,
            shelf_cmds::shelf_create_category,
            shelf_cmds::shelf_rename_category,
            shelf_cmds::shelf_remove_category,
            shelf_cmds::shelf_drag_out,
            shelf_cmds::shelf_migrate_plan,
            shelf_cmds::shelf_migrate,
            shelf_cmds::shelf_restore_plan,
            shelf_cmds::shelf_restore,
            shelf_cmds::shelf_open_record,
            shelf_cmds::shelf_icon
        ])
        .setup(move |app| {
            let dir = app.path().app_config_dir()?;
            let (cfg, cfg_path) = config::load(&dir);
            eprintln!("配置文件: {}", cfg_path.display());
            let offset = (cfg.offset_x, cfg.offset_y);

            let win = app.get_webview_window("main").expect("找不到主窗口");
            // 默认整个窗口点击穿透，鼠标进入胶囊时再由 hover 线程打开
            win.set_ignore_cursor_events(true)?;
            place_window(&win, offset)?;
            win.show()?;

            // 缩放比例变了，重新摆位置
            let w2 = win.clone();
            win.on_window_event(move |e| {
                if let WindowEvent::ScaleFactorChanged { .. } = e {
                    let _ = place_window(&w2, offset);
                }
            });

            // ---------- 侧边架子：同一个程序里的第二个窗口 ----------
            let shelf_win = app.get_webview_window("shelf").expect("找不到架子窗口");
            let shelf = if cfg.shelf_enabled {
                let s = Shelf::new(shelf_win.clone(), &cfg);
                let s2 = s.clone();
                shelf_win.on_window_event(move |e| match e {
                    WindowEvent::Focused(f) => s2.set_focused(*f),
                    WindowEvent::ScaleFactorChanged { .. } => {
                        let _ = s2.place();
                    }
                    _ => {}
                });
                let s3 = s.clone();
                if !hotkey::spawn(&cfg.shelf_hotkey, move || s3.toggle()) {
                    eprintln!("架子快捷键没有生效，可以从托盘菜单打开");
                }
                app.manage(s.clone());
                // 架子的真实文件夹：建好默认分类，开始监听变化，移动日志写在配置文件旁边
                let shelf_fs = shelf_fs::ShelfFs::new(
                    app.handle().clone(),
                    PathBuf::from(&cfg.shelf_dir),
                    dir.join("shelf-log.jsonl"),
                );
                eprintln!("架子文件夹: {}", shelf_fs.root().display());
                app.manage(shelf_fs);
                Some(s)
            } else {
                let _ = shelf_win.destroy();
                None
            };

            // 全屏时灵动岛和架子一起藏；主屏幕分辨率变了两个都重新摆
            let mut hide_list = vec![win.clone()];
            if shelf.is_some() {
                hide_list.push(shelf_win.clone());
            }
            let (w3, s4) = (win.clone(), shelf.clone());
            fullscreen::spawn(hide_list, cfg.hide_in_fullscreen, move || {
                let _ = place_window(&w3, offset);
                if let Some(s) = &s4 {
                    let _ = s.place();
                }
            });
            hover::spawn(win, state.clone());

            let handle = app.handle().clone();
            app.manage(media::MediaTx(media::spawn(handle.clone())));
            app.manage(Pomodoro::new(handle.clone(), cfg.pomodoro_minutes));
            app.manage(alerts::spawn(handle, cfg.clone()));
            let hotkey_label = if shelf.is_some() { cfg.shelf_hotkey.clone() } else { String::new() };
            app.manage(cfg);

            // 托盘失败不影响主体功能
            if let Err(e) = build_tray(app, cfg_path, shelf, &hotkey_label) {
                eprintln!("托盘图标创建失败: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
