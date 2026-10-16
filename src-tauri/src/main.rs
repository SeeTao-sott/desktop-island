// 发布版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod audio;
mod autostart;
mod chart;
mod config;
mod desktop;
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
mod sysstat;
mod theme;
mod wallpaper;
mod widgets;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

use alerts::{AlertHub, Alerts};
use config::Config;
use pomodoro::{PomoState, Pomodoro};
use shelf::{Shelf, ShelfState};
use widgets::Widgets;

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
fn widgets_set_hits(w: State<'_, Arc<Widgets>>, rects: Vec<widgets::HitShape>) {
    w.set_hits(rects);
}

/// edit-on / edit-off / toggle；返回现在是不是在编辑模式
#[tauri::command]
fn widgets_cmd(w: State<'_, Arc<Widgets>>, action: String) -> bool {
    match action.as_str() {
        "edit-on" => w.set_editing(true),
        "edit-off" => w.set_editing(false),
        "toggle" => w.toggle_editing(),
        _ => {}
    }
    w.editing()
}

/// 音频可视化组件出现 / 消失时调用：有人看才录取系统声音
#[tauri::command]
fn audio_watch(a: State<'_, Arc<audio::Audio>>, on: bool, fps: u32) {
    a.watch(on, fps);
}

/// "系统状态"组件出现 / 消失时调用：有人看才去读 CPU
#[tauri::command]
fn sysstat_watch(s: State<'_, Arc<sysstat::SysStat>>, on: bool) -> sysstat::Stat {
    s.watch(on)
}

/// 页面刚打开时拿当前的一套颜色（之后的变化走 widgets-theme 事件）
#[tauri::command]
fn widgets_theme_get(hub: State<'_, Arc<theme::ThemeHub>>) -> Option<theme::Theme> {
    hub.get()
}

/// 主题预览用：当前壁纸图片（data URL），放在预览窗口当背景
#[tauri::command]
fn widgets_wallpaper_preview(hub: State<'_, Arc<theme::ThemeHub>>) -> Option<String> {
    use base64::Engine;
    let path = hub.get()?.image;
    let bytes = std::fs::read(&path).ok()?;
    // 按文件开头几个字节判断格式（系统壁纸 TranscodedWallpaper 没有扩展名）
    let mime = match bytes.get(..4)? {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G'] => "image/png",
        [b'G', b'I', b'F', _] => "image/gif",
        [b'R', b'I', b'F', b'F'] => "image/webp",
        _ => "image/jpeg",
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// 打开主题预览窗口（已经开着就拿到前面）
fn open_theme_preview(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("theme-preview") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(app, "theme-preview", tauri::WebviewUrl::App("theme-preview.html".into()))
        .title("小组件主题预览")
        .inner_size(1290.0, 820.0)
        .center()
        .build();
}

#[tauri::command]
fn widgets_layout_get(w: State<'_, Arc<Widgets>>) -> Option<serde_json::Value> {
    w.load_layout()
}

#[tauri::command]
fn widgets_layout_save(w: State<'_, Arc<Widgets>>, layout: serde_json::Value) -> Result<(), String> {
    w.save_layout(&layout).map_err(|e| format!("布局没保存成功：{e}"))
}

// ---------------- 音游 ----------------

#[derive(serde::Serialize)]
struct SongEntry {
    #[serde(flatten)]
    info: chart::SongInfo,
    /// 这首歌保存过的判定偏移（毫秒）
    offset_ms: i64,
}

fn offsets_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("rhythm-offsets.json"))
}

/// charts/ 里所有歌
#[tauri::command]
fn rhythm_songs(app: AppHandle) -> Vec<SongEntry> {
    let Some(root) = chart::charts_dir() else { return Vec::new() };
    let offsets = offsets_path(&app).map(|p| chart::load_offsets(&p)).unwrap_or_default();
    chart::list_songs(&root)
        .into_iter()
        .map(|info| {
            let offset_ms = offsets.get(&info.id).and_then(|v| v.as_i64()).unwrap_or(0);
            SongEntry { info, offset_ms }
        })
        .collect()
}

/// 某首歌某个难度的音符（时间、轨道）。只认 charts/ 里列得出来的歌，不接受任意路径
#[tauri::command]
fn rhythm_chart(id: String, characteristic: String, difficulty: String) -> Result<Vec<chart::Note>, String> {
    let root = chart::charts_dir().ok_or("找不到 charts 文件夹")?;
    let song = chart::list_songs(&root).into_iter().find(|s| s.id == id).ok_or("找不到这首歌")?;
    let diff = song
        .difficulties
        .iter()
        .find(|d| d.characteristic == characteristic && d.name == difficulty)
        .ok_or("找不到这个难度")?;
    chart::load_notes(&root.join(&song.id), &song, diff)
}

/// 这首歌的音频文件原始字节（ogg），页面自己解码播放。用二进制直接传，不转 base64
#[tauri::command]
fn rhythm_audio(id: String) -> Result<tauri::ipc::Response, String> {
    let root = chart::charts_dir().ok_or("找不到 charts 文件夹")?;
    let song = chart::list_songs(&root).into_iter().find(|s| s.id == id).ok_or("找不到这首歌")?;
    chart::load_audio(&root.join(&song.id), &song).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn rhythm_offset_set(app: AppHandle, id: String, ms: i32) -> Result<(), String> {
    let path = offsets_path(&app).ok_or("找不到配置文件夹")?;
    chart::save_offset(&path, &id, ms.clamp(-2000, 2000)).map_err(|e| format!("偏移没保存成功：{e}"))
}

/// 进入 / 退出音游模式；返回现在是不是在音游模式（编辑模式下进不去）
#[tauri::command]
fn widgets_rhythm(w: State<'_, Arc<Widgets>>, on: bool) -> bool {
    w.set_rhythm(on)
}

/// 灵动岛被双击：按设置回到桌面 / 全部最小化
#[tauri::command]
fn island_double_click(keep: State<'_, desktop::Keep>) {
    desktop::run(desktop::double_click(), keep.inner().clone());
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

fn build_tray(
    app: &App,
    cfg_path: PathBuf,
    shelf: Option<Arc<Shelf>>,
    hotkey: &str,
    widgets: Option<Arc<Widgets>>,
    widgets_hotkey: &str,
    keep: desktop::Keep,
    desktop_hotkey: &str,
) -> tauri::Result<()> {
    let shelf_label = if hotkey.is_empty() { "打开/关闭架子".to_string() } else { format!("打开/关闭架子\t{hotkey}") };
    let widgets_label = if widgets_hotkey.is_empty() {
        "编辑桌面小组件".to_string()
    } else {
        format!("编辑桌面小组件\t{widgets_hotkey}")
    };
    let widgets_item = MenuItem::with_id(app, "widgets_edit", widgets_label, widgets.is_some(), None::<&str>)?;
    let skin_item = MenuItem::with_id(app, "widgets_skin", "切换小组件主题", widgets.is_some(), None::<&str>)?;
    let preview_item = MenuItem::with_id(app, "theme_preview", "小组件主题预览", widgets.is_some(), None::<&str>)?;
    let has_shelf = shelf.is_some();
    let shelf_item = MenuItem::with_id(app, "shelf", shelf_label, has_shelf, None::<&str>)?;
    let migrate = MenuItem::with_id(app, "migrate", "从桌面搬进架子…", has_shelf, None::<&str>)?;
    let restore = MenuItem::with_id(app, "restore", "把桌面来的东西搬回桌面…", has_shelf, None::<&str>)?;
    let icons = CheckMenuItem::with_id(app, "desktop_icons", "隐藏桌面图标", true, desktop_icons::hidden(), None::<&str>)?;
    let open_cfg = MenuItem::with_id(app, "open_config", "打开配置文件", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启（应用新配置）", true, None::<&str>)?;
    let auto = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, autostart::is_enabled(), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出灵动岛", true, None::<&str>)?;
    let desktop_label = if desktop_hotkey.is_empty() { "回到桌面".to_string() } else { format!("回到桌面	{desktop_hotkey}") };
    let desktop_item = MenuItem::with_id(app, "show_desktop", desktop_label, true, None::<&str>)?;
    // 双击灵动岛做什么：三选一，打勾的是当前的
    let now = desktop::double_click();
    let dbl: Vec<CheckMenuItem<tauri::Wry>> = [
        (desktop::Action::Desktop, "回到桌面（再双击恢复）"),
        (desktop::Action::Minimize, "全部最小化（再双击恢复）"),
        (desktop::Action::Off, "不做什么"),
    ]
    .into_iter()
    .map(|(a, text)| CheckMenuItem::with_id(app, format!("dbl_{}", a.key()), text, true, a == now, None::<&str>))
    .collect::<tauri::Result<_>>()?;
    let dbl_menu = Submenu::with_items(app, "双击灵动岛", true, &[&dbl[0], &dbl[1], &dbl[2]])?;
    let menu = Menu::with_items(
        app,
        &[
            &shelf_item,
            &migrate,
            &restore,
            &icons,
            &PredefinedMenuItem::separator(app)?,
            &widgets_item,
            &skin_item,
            &preview_item,
            &PredefinedMenuItem::separator(app)?,
            &desktop_item,
            &dbl_menu,
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
            "widgets_edit" => {
                if let Some(w) = &widgets {
                    w.toggle_editing();
                }
            }
            "theme_preview" => open_theme_preview(app),
            // 所有组件一起换到下一个主题（方形 → 圆环 → 科幻 HUD → 六边形 → …）
            "widgets_skin" => {
                let _ = app.emit("widgets-skin-next", ());
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
            "show_desktop" => desktop::run(desktop::Action::Desktop, keep.clone()),
            id if id.starts_with("dbl_") => {
                let a = desktop::Action::parse(&id[4..]);
                desktop::set_double_click(a);
                for (item, key) in dbl.iter().zip(["desktop", "minimize", "off"]) {
                    let _ = item.set_checked(key == a.key());
                }
                config::set_value(&cfg_path, "island_double_click", serde_json::Value::from(a.key()));
            }
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
            island_double_click,
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
            shelf_cmds::shelf_icon,
            widgets_set_hits,
            widgets_cmd,
            widgets_rhythm,
            rhythm_songs,
            rhythm_chart,
            rhythm_audio,
            rhythm_offset_set,
            widgets_layout_get,
            widgets_layout_save,
            widgets_theme_get,
            widgets_wallpaper_preview,
            sysstat_watch,
            audio_watch
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

            // ---------- 桌面小组件：壁纸之上、程序窗口之下 ----------
            let widgets = if cfg.widgets_enabled {
                let w = Widgets::new(app.handle(), dir.clone());
                let w2 = w.clone();
                if !hotkey::spawn(&cfg.widgets_edit_hotkey, move || w2.toggle_editing()) {
                    eprintln!("小组件编辑快捷键没有生效，可以从托盘菜单进入");
                }
                app.manage(w.clone());
                // 跟着壁纸变色（或用手动指定的颜色）
                app.manage(theme::spawn(app.handle().clone(), &cfg));
                Some(w)
            } else {
                None
            };

            // 全屏时灵动岛和架子一起藏（小组件本来就在程序下面，只暂停更新）；主屏幕分辨率变了都重新摆
            let mut hide_list = vec![win.clone()];
            if shelf.is_some() {
                hide_list.push(shelf_win.clone());
            }
            let (w3, s4, wg) = (win.clone(), shelf.clone(), widgets.clone());
            fullscreen::spawn(hide_list, cfg.hide_in_fullscreen, move || {
                let _ = place_window(&w3, offset);
                if let Some(s) = &s4 {
                    let _ = s.place();
                }
                if let Some(w) = &wg {
                    w.replace();
                }
            });
            // ---------- 回到桌面 / 全部最小化：做完要保持显示的窗口（灵动岛、架子，都是置顶的） ----------
            let mut keep = desktop::Keep::default();
            if let Ok(h) = win.hwnd() {
                keep.windows.push((h.0 as isize, true));
            }
            if shelf.is_some() {
                if let Ok(h) = shelf_win.hwnd() {
                    keep.windows.push((h.0 as isize, true));
                }
            }
            desktop::set_double_click(desktop::Action::parse(&cfg.island_double_click));
            let desktop_hotkey = {
                let k = keep.clone();
                // 快捷键做的事和双击一样；双击设成"不做什么"时就是回到桌面
                let ok = hotkey::spawn(&cfg.show_desktop_hotkey, move || {
                    let a = match desktop::double_click() {
                        desktop::Action::Off => desktop::Action::Desktop,
                        a => a,
                    };
                    desktop::run(a, k.clone());
                });
                if ok { cfg.show_desktop_hotkey.clone() } else { String::new() }
            };
            app.manage(keep.clone());

            hover::spawn(win, state.clone());

            let handle = app.handle().clone();
            app.manage(media::MediaTx(media::spawn(handle.clone())));
            app.manage(Pomodoro::new(handle.clone(), cfg.pomodoro_minutes));
            let alert_hub = alerts::spawn(handle.clone(), cfg.clone());
            // 桌面"系统状态"组件：没有这个组件时线程一直睡着
            let every = std::time::Duration::from_secs(cfg.widgets_status_seconds as u64);
            app.manage(sysstat::SysStat::spawn(handle, alert_hub.clone(), every));
            app.manage(alert_hub);
            // 音频可视化：没有音频组件时线程一直睡着，不录任何声音
            app.manage(audio::Audio::spawn(app.handle().clone()));
            let hotkey_label = if shelf.is_some() { cfg.shelf_hotkey.clone() } else { String::new() };
            let widgets_hotkey = if widgets.is_some() { cfg.widgets_edit_hotkey.clone() } else { String::new() };
            app.manage(cfg);

            // 启动参数 --theme-preview：一启动就打开主题预览窗口（测试用，平时从托盘打开）
            if std::env::args().any(|a| a == "--theme-preview") {
                open_theme_preview(app.handle());
            }

            // 托盘失败不影响主体功能
            if let Err(e) = build_tray(app, cfg_path, shelf, &hotkey_label, widgets, &widgets_hotkey, keep, &desktop_hotkey) {
                eprintln!("托盘图标创建失败: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
