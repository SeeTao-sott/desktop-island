//! 配置文件：%APPDATA%\com.stanley.desktopisland\config.json
//! 没有就用默认值创建；缺少的键会自动补上；格式写错时用默认值，但不覆盖用户的文件。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
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
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pomodoro_minutes: 25,
            battery_low_percent: 20,
            gpu_temp_limit_c: 85,
            gpu_poll_seconds: 5,
            gpu_poll_on_battery: false,
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
