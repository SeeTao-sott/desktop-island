//! 桌面"系统状态"组件的数据：CPU 占用、显卡温度、电量。
//! 只有桌面上有这个组件、而且没在玩全屏游戏时才每隔几秒读一次；没人看就一直睡着。
//! 显卡温度和电量直接用灵动岛提醒模块已经读到的值，不重复读取。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Threading::GetSystemTimes;

use crate::alerts::{AlertHub, Battery};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    /// CPU 占用 0..100；刚开始还没有两次读数时为空
    pub cpu: Option<f64>,
    pub gpu_temp: Option<u32>,
    pub battery: Option<Battery>,
}

pub struct SysStat {
    /// 正在显示的"系统状态"组件个数
    demand: AtomicUsize,
    alerts: Arc<AlertHub>,
    worker: thread::Thread,
}

fn ft(f: FILETIME) -> u64 {
    (f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64
}

/// (空闲, 总共) 时间，100 纳秒为单位
fn cpu_times() -> Option<(u64, u64)> {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
    // 内核时间里已经包含了空闲时间
    Some((ft(idle), ft(kernel) + ft(user)))
}

impl SysStat {
    pub fn spawn(app: AppHandle, alerts: Arc<AlertHub>, every: Duration) -> Arc<Self> {
        let alerts2 = alerts.clone();
        let handle = thread::spawn(move || {
            let mut prev = cpu_times();
            loop {
                // 没人看或者在全屏时一直睡，等 watch() 叫醒
                let me = STAT.get();
                let wanted = me.is_some_and(|s| s.demand.load(Ordering::SeqCst) > 0);
                if !wanted || crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst) {
                    prev = None;
                    thread::park_timeout(Duration::from_secs(2));
                    continue;
                }
                let now = cpu_times();
                let cpu = match (prev, now) {
                    (Some((i0, t0)), Some((i1, t1))) if t1 > t0 => {
                        Some(((1.0 - (i1 - i0) as f64 / (t1 - t0) as f64) * 100.0).clamp(0.0, 100.0))
                    }
                    _ => None,
                };
                prev = now;
                let stat = Stat { cpu, gpu_temp: alerts2.gpu_temp(), battery: alerts2.battery() };
                let _ = app.emit("sysstat", stat);
                // 第一次只是拿个起点，稍等一下就补上第一个读数
                thread::park_timeout(if cpu.is_none() { Duration::from_millis(800) } else { every });
            }
        });
        let s = Arc::new(Self { demand: AtomicUsize::new(0), alerts, worker: handle.thread().clone() });
        let _ = STAT.set(s.clone());
        s
    }

    /// 组件出现 / 消失（或暂停）时调用
    pub fn watch(&self, on: bool) -> Stat {
        if on {
            self.demand.fetch_add(1, Ordering::SeqCst);
            self.worker.unpark();
        } else {
            let _ = self.demand.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        }
        Stat { cpu: None, gpu_temp: self.alerts.gpu_temp(), battery: self.alerts.battery() }
    }
}

static STAT: std::sync::OnceLock<Arc<SysStat>> = std::sync::OnceLock::new();
