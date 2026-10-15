//! 番茄钟：计时放在 Rust 里，页面被隐藏或节流时也能准时结束。
//! 用"结束时刻"（墙上时间）记录，电脑睡眠唤醒后也不会算错。

use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Running,
    Paused,
    Done,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomoState {
    pub phase: Phase,
    pub total_ms: u64,
    /// 运行中：结束时刻（Unix 毫秒）
    pub end_at: u64,
    /// 暂停中：还剩多少毫秒
    pub remaining_ms: u64,
}

pub struct Pomodoro {
    state: Mutex<PomoState>,
    cv: Condvar,
    app: AppHandle,
    total_ms: u64,
}

/// 等待上限：Windows 睡眠期间计时器不走，醒来后最多晚这么久发现已到点
const MAX_WAIT: Duration = Duration::from_secs(15);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Pomodoro {
    pub fn new(app: AppHandle, minutes: u32) -> Arc<Self> {
        let total_ms = minutes as u64 * 60_000;
        let p = Arc::new(Self {
            state: Mutex::new(Self::idle(total_ms)),
            cv: Condvar::new(),
            app,
            total_ms,
        });
        let worker = p.clone();
        thread::spawn(move || worker.run());
        p
    }

    fn idle(total_ms: u64) -> PomoState {
        PomoState { phase: Phase::Idle, total_ms, end_at: 0, remaining_ms: total_ms }
    }

    /// 只在运行中才会定时醒来；空闲和暂停时一直睡到有操作
    fn run(&self) {
        let mut st = self.state.lock().unwrap();
        loop {
            if st.phase == Phase::Running {
                let now = now_ms();
                if now >= st.end_at {
                    st.phase = Phase::Done;
                    st.remaining_ms = 0;
                    let _ = self.app.emit("pomodoro", &*st);
                    continue;
                }
                let wait = Duration::from_millis(st.end_at - now).min(MAX_WAIT);
                st = self.cv.wait_timeout(st, wait).unwrap().0;
            } else {
                st = self.cv.wait(st).unwrap();
            }
        }
    }

    pub fn get(&self) -> PomoState {
        self.state.lock().unwrap().clone()
    }

    pub fn act(&self, action: &str) -> PomoState {
        let mut st = self.state.lock().unwrap();
        let now = now_ms();
        match (action, st.phase) {
            ("start", _) => {
                *st = PomoState {
                    phase: Phase::Running,
                    total_ms: self.total_ms,
                    end_at: now + self.total_ms,
                    remaining_ms: self.total_ms,
                };
            }
            ("pause", Phase::Running) => {
                st.remaining_ms = st.end_at.saturating_sub(now);
                st.phase = Phase::Paused;
            }
            ("resume", Phase::Paused) => {
                st.end_at = now + st.remaining_ms;
                st.phase = Phase::Running;
            }
            ("cancel", _) | ("dismiss", Phase::Done) => *st = Self::idle(self.total_ms),
            _ => {}
        }
        let _ = self.app.emit("pomodoro", &*st);
        self.cv.notify_all();
        st.clone()
    }
}
