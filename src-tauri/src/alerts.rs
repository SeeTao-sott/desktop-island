//! 警告：低电量（系统电源事件，不轮询）和显卡高温（nvidia-smi，按配置间隔读一次）。
//! 读不到就安静跳过，不弹任何错误窗口。

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::IInspectable;
use windows::Foundation::EventHandler;
use windows::System::Power::{BatteryStatus, PowerManager};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::config::Config;

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: i32,
    pub charging: bool,
    pub low: bool,
}

/// 只有过热时才带上温度值，这样平时温度上下浮动不会反复推送
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuHot {
    pub temp: u32,
}

#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alerts {
    pub battery: Option<Battery>,
    pub gpu_hot: Option<GpuHot>,
}

pub struct AlertHub {
    state: Mutex<Alerts>,
    app: AppHandle,
}

impl AlertHub {
    pub fn get(&self) -> Alerts {
        self.state.lock().unwrap().clone()
    }

    /// 有变化才推给页面
    fn update(&self, f: impl FnOnce(&mut Alerts)) {
        let mut st = self.state.lock().unwrap();
        let before = st.clone();
        f(&mut st);
        if *st != before {
            let _ = self.app.emit("alerts", &*st);
        }
    }
}

/// 不弹出控制台窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 退热回差：超过阈值报警后，要降到阈值 - 3°C 才解除，避免在临界点来回闪
const GPU_HYSTERESIS: u32 = 3;
const NVSMI_TIMEOUT: Duration = Duration::from_secs(5);

pub fn spawn(app: AppHandle, cfg: Config) -> Arc<AlertHub> {
    let hub = Arc::new(AlertHub { state: Mutex::new(Alerts::default()), app });
    let worker = hub.clone();
    thread::spawn(move || {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        if let Err(e) = watch_battery(&worker, cfg.battery_low_percent) {
            eprintln!("电量监听不可用: {e:?}");
        }
        gpu_loop(&worker, &cfg);
        // 没有 N 卡时温度循环会退出；线程留着，保证电量事件所在的 COM 环境不被拆掉
        loop {
            thread::park();
        }
    });
    hub
}

// ---------------- 电量 ----------------

fn read_battery(threshold: u32) -> Option<Battery> {
    // 调试用：ISLAND_FAKE_BATTERY=15 模拟一块没在充电、剩 15% 的电池（只在开发版生效）
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var("ISLAND_FAKE_BATTERY").ok().and_then(|v| v.parse::<i32>().ok()) {
        return Some(Battery { percent: p, charging: false, low: p < threshold as i32 });
    }

    let status = PowerManager::BatteryStatus().ok()?;
    if status == BatteryStatus::NotPresent {
        return None;
    }
    let percent = PowerManager::RemainingChargePercent().ok()?;
    // 插着电但已充满时状态是 Idle，也不算"在耗电"
    let charging = status != BatteryStatus::Discharging;
    Some(Battery { percent, charging, low: !charging && percent < threshold as i32 })
}

fn watch_battery(hub: &Arc<AlertHub>, threshold: u32) -> windows::core::Result<()> {
    hub.update(|a| a.battery = read_battery(threshold));
    let make = || {
        let hub = hub.clone();
        EventHandler::<IInspectable>::new(move |_, _| {
            hub.update(|a| a.battery = read_battery(threshold));
            Ok(())
        })
    };
    PowerManager::RemainingChargePercentChanged(&make())?;
    PowerManager::BatteryStatusChanged(&make())?;
    PowerManager::PowerSupplyStatusChanged(&make())?;
    Ok(())
}

// ---------------- 显卡温度 ----------------

fn on_ac_power() -> bool {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return true;
    }
    // 1 = 插着电；BatteryFlag 128 = 没有电池（台式机）
    s.ACLineStatus == 1 || s.BatteryFlag & 128 != 0
}

enum GpuRead {
    Temp(u32),
    Failed,
    NoTool,
}

fn read_gpu_temp() -> GpuRead {
    let child = Command::new("nvidia-smi")
        .args(["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return GpuRead::NoTool,
        Err(_) => return GpuRead::Failed,
    };

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < NVSMI_TIMEOUT => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return GpuRead::Failed;
            }
        }
    }

    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    // 多块 N 卡时取最高温度
    out.lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .max()
        .map_or(GpuRead::Failed, GpuRead::Temp)
}

fn gpu_loop(hub: &Arc<AlertHub>, cfg: &Config) {
    let limit = cfg.gpu_temp_limit_c;
    let interval = Duration::from_secs(cfg.gpu_poll_seconds as u64);
    loop {
        if cfg.gpu_poll_on_battery || on_ac_power() {
            match read_gpu_temp() {
                GpuRead::Temp(t) => hub.update(|a| {
                    let was_hot = a.gpu_hot.is_some();
                    let hot = if was_hot { t + GPU_HYSTERESIS > limit } else { t >= limit };
                    a.gpu_hot = hot.then_some(GpuHot { temp: t });
                }),
                GpuRead::Failed => {}
                GpuRead::NoTool => {
                    // 没装 N 卡驱动：以后都不再尝试
                    hub.update(|a| a.gpu_hot = None);
                    return;
                }
            }
        } else {
            hub.update(|a| a.gpu_hot = None);
        }
        thread::sleep(interval);
    }
}
