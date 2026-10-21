//! 配置文件：%APPDATA%\com.stanley.desktopisland\config.json
//! 没有就用默认值创建；缺少的键会自动补上；格式写错时用默认值，但不覆盖用户的文件。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 位置：相对"屏幕顶部正中"的偏移（逻辑像素，右/下为正）
    pub offset_x: i32,
    pub offset_y: i32,
    /// 颜色：任何 CSS 颜色写法都行，比如 "#ffb340"、"rgba(14, 14, 18, 0.86)"
    pub color_background: String,
    pub color_text: String,
    pub color_glow: String,
    pub color_battery: String,
    pub color_gpu: String,
    pub color_done: String,
    /// 有全屏程序（游戏、全屏视频）时自动隐藏
    pub hide_in_fullscreen: bool,
    /// 番茄钟时长（分钟）
    pub pomodoro_minutes: u32,
    /// 电量低于这个百分比、并且没在充电时提醒
    pub battery_low_percent: u32,
    /// 显卡温度达到这个值（°C）时提醒
    pub gpu_temp_limit_c: u32,
    /// 多少秒读一次显卡温度
    pub gpu_poll_seconds: u32,
    /// 用电池时也读显卡温度（双显卡笔记本上可能会唤醒独显、多耗电）
    pub gpu_poll_on_battery: bool,

    // ---------- 侧边架子 ----------
    /// 是否启用架子
    pub shelf_enabled: bool,
    /// 右边缘触发区域：从屏幕高度的这个比例到那个比例（0 = 顶，1 = 底）。避开右上角关闭按钮和右下角
    pub shelf_zone_top: f64,
    pub shelf_zone_bottom: f64,
    /// 鼠标在边缘停留多久才滑出（毫秒）
    pub shelf_dwell_ms: u64,
    /// 鼠标离开后多久收回（毫秒）
    pub shelf_leave_delay_ms: u64,
    /// 打开/关闭架子的快捷键，比如 "Ctrl+Alt+D"；留空表示不用快捷键
    pub shelf_hotkey: String,
    /// 架子面板宽度（逻辑像素）
    pub shelf_width: u32,
    /// 架子用来存放东西的真实文件夹，每个分类是里面的一个子文件夹
    pub shelf_dir: String,

    // ---------- 桌面小组件 ----------
    /// 是否启用桌面小组件
    pub widgets_enabled: bool,
    /// 进入 / 退出编辑模式的快捷键；留空表示不用快捷键（托盘里也能进）
    pub widgets_edit_hotkey: String,
    /// 组件颜色："auto" 跟着壁纸变；"manual" 用下面指定的颜色
    pub widgets_color_mode: String,
    /// 手动颜色，比如 "#5b7bd5"（只在 widgets_color_mode 为 "manual" 时用）
    pub widgets_manual_color: String,
    /// Wallpaper Engine 在运行时，每隔多少秒向它确认一次当前壁纸（播放列表自动换图时靠这个发现）
    pub widgets_wallpaper_check_seconds: u32,
    /// "系统状态"组件多少秒更新一次
    pub widgets_status_seconds: u32,

    // ---------- 回到桌面 ----------
    /// 双击灵动岛做什么："desktop" 回到桌面（再双击恢复）、"minimize" 全部最小化（再双击恢复）、"off" 不做什么
    pub island_double_click: String,
    /// 回到桌面的快捷键，比如 "Ctrl+Alt+Q"；留空表示不用。做的事和双击灵动岛一样（双击设成"不做什么"时是回到桌面）。
    /// 不能用 Win+D（那是系统自己的）
    pub show_desktop_hotkey: String,

    // ---------- 屏幕边缘律动 ----------
    /// 放歌时屏幕四条边跟着音乐发光（托盘里可以开关）
    pub edge_glow: bool,

    // ---------- 手机遥控 ----------
    /// 在家里局域网开一个小网页，手机扫码遥控（托盘里可以开关）
    pub phone_enabled: bool,
    /// 小网页用的端口
    pub phone_port: u16,
    /// 二维码里的随机密钥；第一次用时自动生成，想让旧手机失效就删掉这一项再重启
    pub phone_token: String,
}

/// 默认放在 OneDrive 里（和桌面同一个盘、继续云端备份）；没有 OneDrive 就放在用户文件夹里
fn default_shelf_dir() -> String {
    let base = std::env::var("OneDrive").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "C:\\".into());
    std::path::Path::new(&base).join("架子").to_string_lossy().to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            offset_x: 0,
            offset_y: 0,
            color_background: "rgba(14, 14, 18, 0.86)".into(),
            color_text: "#f2f2f5".into(),
            color_glow: "rgba(140, 170, 255, 0.16)".into(),
            color_battery: "#ffb340".into(),
            color_gpu: "#ff5a4f".into(),
            color_done: "#5ee08a".into(),
            hide_in_fullscreen: true,
            pomodoro_minutes: 25,
            battery_low_percent: 20,
            gpu_temp_limit_c: 85,
            gpu_poll_seconds: 5,
            gpu_poll_on_battery: false,
            shelf_enabled: true,
            shelf_zone_top: 0.25,
            shelf_zone_bottom: 0.75,
            shelf_dwell_ms: 300,
            shelf_leave_delay_ms: 500,
            shelf_hotkey: "Ctrl+Alt+D".into(),
            shelf_width: 320,
            shelf_dir: default_shelf_dir(),
            widgets_enabled: true,
            widgets_edit_hotkey: "Ctrl+Alt+W".into(),
            widgets_color_mode: "auto".into(),
            widgets_manual_color: "#5b7bd5".into(),
            widgets_wallpaper_check_seconds: 30,
            widgets_status_seconds: 3,
            island_double_click: "desktop".into(),
            show_desktop_hotkey: String::new(),
            edge_glow: false,
            phone_enabled: false,
            phone_port: 8787,
            phone_token: String::new(),
        }
    }
}

impl Config {
    /// 把明显不合理的值拉回合理范围
    fn sanitize(mut self) -> Self {
        self.pomodoro_minutes = self.pomodoro_minutes.clamp(1, 180);
        self.battery_low_percent = self.battery_low_percent.clamp(1, 99);
        self.gpu_temp_limit_c = self.gpu_temp_limit_c.clamp(40, 110);
        self.gpu_poll_seconds = self.gpu_poll_seconds.clamp(1, 60);
        self.offset_x = self.offset_x.clamp(-2000, 2000);
        self.offset_y = self.offset_y.clamp(0, 400);
        self.shelf_zone_top = self.shelf_zone_top.clamp(0.0, 0.95);
        self.shelf_zone_bottom = self.shelf_zone_bottom.clamp(self.shelf_zone_top + 0.05, 1.0);
        self.shelf_dwell_ms = self.shelf_dwell_ms.clamp(50, 3000);
        self.shelf_leave_delay_ms = self.shelf_leave_delay_ms.clamp(0, 5000);
        self.shelf_width = self.shelf_width.clamp(240, 600);
        self.widgets_wallpaper_check_seconds = self.widgets_wallpaper_check_seconds.clamp(10, 3600);
        self.widgets_status_seconds = self.widgets_status_seconds.clamp(1, 60);
        if self.widgets_color_mode != "manual" {
            self.widgets_color_mode = "auto".into();
        }
        if !matches!(self.island_double_click.as_str(), "desktop" | "minimize" | "off") {
            self.island_double_click = "desktop".into();
        }
        if self.shelf_dir.trim().is_empty() {
            self.shelf_dir = default_shelf_dir();
        }
        self
    }
}

pub fn load(dir: &Path) -> (Config, PathBuf) {
    let path = dir.join("config.json");
    let cfg = match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => {
                let cfg: Config = serde_json::from_value(value.clone()).unwrap_or_else(|e| {
                    eprintln!("配置文件里有值的类型不对，先用默认值: {e}");
                    Config::default()
                });
                fill_missing_keys(&path, &value, &cfg);
                cfg
            }
            Err(e) => {
                eprintln!("配置文件格式有误，先用默认值: {e}");
                Config::default()
            }
        },
        Err(_) => {
            let cfg = Config::default();
            let _ = fs::create_dir_all(dir);
            if let Ok(text) = serde_json::to_string_pretty(&cfg) {
                let _ = fs::write(&path, text);
            }
            cfg
        }
    };
    (cfg.sanitize(), path)
}

/// 托盘里改了某一项：只改这一个键，文件里其他内容原样保留
pub fn set_value(path: &Path, key: &str, value: serde_json::Value) {
    let mut obj = fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned());
    // 文件读不了或格式有误时不动它，免得把用户写的内容冲掉
    let Some(map) = obj.as_mut() else { return };
    map.insert(key.to_string(), value);
    if let Ok(text) = serde_json::to_string_pretty(map) {
        let _ = fs::write(path, text);
    }
}

/// 以后加了新配置项，老文件里没有的键自动补上默认值，已有的值不动
fn fill_missing_keys(path: &Path, value: &serde_json::Value, cfg: &Config) {
    let (Some(existing), Ok(serde_json::Value::Object(full))) =
        (value.as_object(), serde_json::to_value(cfg))
    else {
        return;
    };
    if full.keys().all(|k| existing.contains_key(k)) {
        return;
    }
    let mut merged = existing.clone();
    for (k, v) in full {
        merged.entry(k).or_insert(v);
    }
    if let Ok(text) = serde_json::to_string_pretty(&merged) {
        let _ = fs::write(path, text);
    }
}
