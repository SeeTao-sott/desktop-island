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
