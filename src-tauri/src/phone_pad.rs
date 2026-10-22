//! 手机当手柄：手机网页上画一个手柄（摇杆、ABXY、肩键、扳机），按的状态发过来，电脑这边变成手柄输入给游戏。
//!
//! 两种做法，自动选：
//! - 装了 ViGEmBus 驱动：插一个虚拟的 Xbox 360 手柄，游戏以为真插了个手柄（摇杆、扳机都有轻重）。
//!   走驱动，管理员身份运行的游戏也收得到。手机不用了（断开 / 退出手柄页）就拔掉。
//! - 没装：改成模拟键盘鼠标（SendInput + 扫描码，游戏读得到）：左摇杆 = WASD、右摇杆 = 鼠标转视角，
//!   按键按下面的 KEYS 对应。管理员身份运行的游戏系统不让普通程序模拟输入（见 elevated_foreground）。
//!
//! 手机每次状态变了就发一次，没变也每 250ms 发一次心跳；超过 STALE 没收到就当手机断了，所有键松开，免得卡键。

use std::mem::size_of;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// 多久没收到手机的状态就当断了（松开所有键）
const STALE: Duration = Duration::from_millis(800);
/// 断了多久把虚拟手柄拔掉
const UNPLUG_AFTER: Duration = Duration::from_secs(8);
/// 键盘模式：摇杆推过多少算按下 WASD
const STICK_KEY: f64 = 0.45;
/// 键盘模式：右摇杆推到底时鼠标每秒走多少（乘灵敏度）
const MOUSE_SPEED: f64 = 1500.0;

// XInput 的按键位（和 Xbox 360 手柄一样）
const UP: u16 = 0x0001;
const DOWN: u16 = 0x0002;
const LEFT: u16 = 0x0004;
const RIGHT: u16 = 0x0008;
const START: u16 = 0x0010;
const BACK: u16 = 0x0020;
const LTHUMB: u16 = 0x0040;
const RTHUMB: u16 = 0x0080;
const LB: u16 = 0x0100;
const RB: u16 = 0x0200;
const A: u16 = 0x1000;
const B: u16 = 0x2000;
const X: u16 = 0x4000;
const Y: u16 = 0x8000;

/// 键盘模式下按键对应的键（扫描码，第二个是不是扩展键）。手机页面上的说明和这里一致
const KEYS: [(u16, u16, bool); 13] = [
    (A, 0x39, false),      // 空格（跳）
    (B, 0x2A, false),      // 左 Shift（冲刺 / 闪避）
    (X, 0x12, false),      // E
    (Y, 0x10, false),      // Q
    (LB, 0x13, false),     // R
    (RB, 0x21, false),     // F（互动）
    (LTHUMB, 0x1D, false), // 左 Ctrl
    (START, 0x01, false),  // Esc
    (BACK, 0x0F, false),   // Tab
    (UP, 0x02, false),     // 1
    (RIGHT, 0x03, false),  // 2
    (DOWN, 0x04, false),   // 3
    (LEFT, 0x05, false),   // 4
];
// WASD
const KEY_W: u16 = 0x11;
const KEY_A: u16 = 0x1E;
const KEY_S: u16 = 0x1F;
const KEY_D: u16 = 0x20;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct PadState {
    pub buttons: u16,
    pub lt: u8,
    pub rt: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

impl PadState {
    /// 手机发来的 JSON：{"b":按键位,"lt":0~255,"rt":0~255,"lx","ly","rx","ry":-32767~32767}
    pub fn from_json(v: &Value) -> PadState {
        let i = |k: &str, lo: i64, hi: i64| v.get(k).and_then(Value::as_i64).unwrap_or(0).clamp(lo, hi);
        PadState {
            buttons: i("b", 0, 0xffff) as u16 & !0x0400, // 不让手机按 Guide 键（会弹出 Xbox Game Bar）
            lt: i("lt", 0, 255) as u8,
            rt: i("rt", 0, 255) as u8,
            lx: i("lx", -32767, 32767) as i16,
            ly: i("ly", -32767, 32767) as i16,
            rx: i("rx", -32767, 32767) as i16,
            ry: i("ry", -32767, 32767) as i16,
        }
    }
}

/// 键盘模式下"按着的"：扫描码集合 + 鼠标三个键
#[derive(Default, PartialEq, Clone)]
struct Held {
    keys: Vec<(u16, bool)>,
    left: bool,
    right: bool,
    middle: bool,
}

/// 键盘模式下这个手柄状态应该按着哪些键
fn held_for(s: &PadState) -> Held {
    let mut keys: Vec<(u16, bool)> = KEYS.iter().filter(|(bit, _, _)| s.buttons & bit != 0).map(|(_, sc, ext)| (*sc, *ext)).collect();
    let (x, y) = (s.lx as f64 / 32767.0, s.ly as f64 / 32767.0);
    if y > STICK_KEY {
        keys.push((KEY_W, false));
    }
    if y < -STICK_KEY {
        keys.push((KEY_S, false));
    }
    if x < -STICK_KEY {
        keys.push((KEY_A, false));
    }
    if x > STICK_KEY {
        keys.push((KEY_D, false));
    }
    Held { keys, left: s.rt > 100, right: s.lt > 100, middle: s.buttons & RTHUMB != 0 }
}

fn key(sc: u16, ext: bool, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if ext {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: sc, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn mouse(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn send(inputs: &[INPUT]) {
    if !inputs.is_empty() {
        unsafe {
            SendInput(inputs, size_of::<INPUT>() as i32);
        }
    }
}

/// 从 old 换到 new：先松开不要的，再按下新的
fn apply_held(old: &Held, new: &Held) {
    let mut out = Vec::new();
    for k in &old.keys {
        if !new.keys.contains(k) {
            out.push(key(k.0, k.1, true));
        }
    }
    for k in &new.keys {
        if !old.keys.contains(k) {
            out.push(key(k.0, k.1, false));
        }
    }
    for (was, now, down, up) in [
        (old.left, new.left, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        (old.right, new.right, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        (old.middle, new.middle, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    ] {
        if was != now {
            out.push(mouse(0, 0, if now { down } else { up }));
        }
    }
    send(&out);
}

enum Backend {
    /// 还没开始 / 已经拔掉
    Off,
    Xbox(Xbox360Wired<Client>),
    Keys,
}

struct Inner {
    backend: Backend,
    state: PadState,
    held: Held,
    last: Instant,
    /// 断了（松开了所有键）
    idle: bool,
    /// 鼠标移动攒着的小数
    rest: (f64, f64),
    /// 键盘模式右摇杆的灵敏度
    sens: f64,
    /// 游戏触控板直接按着的键（WASD 摇杆、Alt），和手柄分开
    kb: Vec<(u16, bool)>,
    kb_last: Instant,
}

pub struct PhonePad {
    inner: Mutex<Inner>,
}

impl PhonePad {
    pub fn new() -> Arc<PhonePad> {
        let pad = Arc::new(PhonePad {
            inner: Mutex::new(Inner {
                backend: Backend::Off,
                state: PadState::default(),
                held: Held::default(),
                last: Instant::now(),
                idle: true,
                rest: (0.0, 0.0),
                sens: 1.0,
                kb: Vec::new(),
                kb_last: Instant::now(),
            }),
        });
        let me = pad.clone();
        thread::spawn(move || me.run());
        pad
    }

    /// 插虚拟手柄；驱动没装（或插不上）就用键盘鼠标
    fn connect() -> Backend {
        match Client::connect() {
            Ok(client) => {
                let mut t = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
                match t.plugin().and_then(|_| t.wait_ready()) {
                    Ok(()) => {
                        eprintln!("手机手柄：已插上虚拟 Xbox 手柄");
                        Backend::Xbox(t)
                    }
                    Err(e) => {
                        eprintln!("手机手柄：虚拟手柄插不上（{e:?}），改用键盘鼠标");
                        Backend::Keys
                    }
                }
            }
            Err(_) => {
                eprintln!("手机手柄：没装 ViGEmBus 驱动，用键盘鼠标");
                Backend::Keys
            }
        }
    }

    /// 手机发来一帧；end = 手机退出了手柄页。返回现在用的是哪种（"xbox" / "keys"）
    pub fn update(&self, s: PadState, sens: f64, end: bool) -> &'static str {
        let mut g = self.inner.lock().unwrap();
        g.sens = sens.clamp(0.1, 5.0);
        if end {
            Self::release(&mut g);
            Self::unplug(&mut g);
            return "off";
        }
        if matches!(g.backend, Backend::Off) {
            g.backend = Self::connect();
        }
        g.last = Instant::now();
        g.idle = false;
        g.state = s;
        Self::push(&mut g);
        match g.backend {
            Backend::Xbox(_) => "xbox",
            _ => "keys",
        }
    }

    /// 把当前状态交给虚拟手柄 / 按下松开对应的键
    fn push(g: &mut Inner) {
        let s = g.state;
        match &mut g.backend {
            Backend::Xbox(t) => {
                let pad = XGamepad {
                    buttons: XButtons { raw: s.buttons },
                    left_trigger: s.lt,
                    right_trigger: s.rt,
                    thumb_lx: s.lx,
                    thumb_ly: s.ly,
                    thumb_rx: s.rx,
                    thumb_ry: s.ry,
                };
                if let Err(e) = t.update(&pad) {
                    eprintln!("手机手柄：虚拟手柄更新失败（{e:?}），改用键盘鼠标");
                    g.backend = Backend::Keys;
                }
            }
            Backend::Keys => {
                let new = held_for(&s);
                if new != g.held {
                    apply_held(&g.held, &new);
                    g.held = new;
                }
            }
            Backend::Off => {}
        }
    }

    /// 全部松开（摇杆回中）
    fn release(g: &mut Inner) {
        g.state = PadState::default();
        Self::push(g);
        if !g.held.keys.is_empty() || g.held.left || g.held.right || g.held.middle {
            apply_held(&g.held, &Held::default());
            g.held = Held::default();
        }
        g.idle = true;
        g.rest = (0.0, 0.0);
    }

    fn unplug(g: &mut Inner) {
        if let Backend::Xbox(t) = &mut g.backend {
            let _ = t.unplug();
            eprintln!("手机手柄：已拔掉虚拟手柄");
        }
        g.backend = Backend::Off;
    }

    /// 每 8ms：键盘模式下按右摇杆移动鼠标；太久没收到就松开、再久一点就拔掉
    fn run(&self) {
        let mut last_tick = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(8));
            let dt = last_tick.elapsed().as_secs_f64().min(0.05);
            last_tick = Instant::now();
            let mut g = self.inner.lock().unwrap();
            if !g.kb.is_empty() && g.kb_last.elapsed() > STALE {
                eprintln!("游戏触控板：太久没收到手机，按着的键全部松开");
                let old = std::mem::take(&mut g.kb);
                send(&old.iter().map(|k| key(k.0, k.1, true)).collect::<Vec<_>>());
            }
            if matches!(g.backend, Backend::Off) {
                continue;
            }
            let quiet = g.last.elapsed();
            if !g.idle && quiet > STALE {
                eprintln!("手机手柄：{}ms 没收到手机，全部松开", quiet.as_millis());
                Self::release(&mut g);
            }
            if g.idle && quiet > UNPLUG_AFTER {
                Self::unplug(&mut g);
                continue;
            }
            if g.idle || !matches!(g.backend, Backend::Keys) {
                continue;
            }
            // 右摇杆 → 鼠标：圆形死区，平方曲线（推得轻走得慢、好瞄）
            let (x, y) = (g.state.rx as f64 / 32767.0, g.state.ry as f64 / 32767.0);
            let m = x.hypot(y);
            if m < 0.12 {
                g.rest = (0.0, 0.0);
                continue;
            }
            let k = ((m - 0.12) / 0.88).min(1.0);
            let v = MOUSE_SPEED * g.sens * k * k * dt / m;
            // 摇杆往上是 +y，鼠标往上是 -y
            let (rx, ry) = (g.rest.0 + x * v, g.rest.1 - y * v);
            let (dx, dy) = (rx.trunc(), ry.trunc());
            g.rest = (rx - dx, ry - dy);
            if dx != 0.0 || dy != 0.0 {
                send(&[mouse(dx as i32, dy as i32, MOUSEEVENTF_MOVE)]);
            }
        }
    }
}

/// 游戏触控板能按的键（名字 → 扫描码、是不是扩展键）
fn kb_code(name: &str) -> Option<(u16, bool)> {
    Some(match name {
        "w" => (KEY_W, false),
        "a" => (KEY_A, false),
        "s" => (KEY_S, false),
        "d" => (KEY_D, false),
        "alt" => (0x38, false), // 左 Alt（原神之类的游戏按住它叫出鼠标）
        "space" => (0x39, false),
        "shift" => (0x2A, false),
        _ => return None,
    })
}

impl PhonePad {
    /// 游戏触控板：现在应该按着哪些键（每次发全部；没变也 250ms 发一次心跳，超过 STALE 没收到就全松开）
    pub fn keys(&self, names: &[&str]) -> Result<(), String> {
        let mut want: Vec<(u16, bool)> = Vec::new();
        for n in names {
            let k = kb_code(n).ok_or_else(|| format!("不认识的键：{n}"))?;
            if !want.contains(&k) {
                want.push(k);
            }
        }
        let mut g = self.inner.lock().unwrap();
        g.kb_last = Instant::now();
        let mut out = Vec::new();
        for k in &g.kb {
            if !want.contains(k) {
                out.push(key(k.0, k.1, true));
            }
        }
        for k in &want {
            if !g.kb.contains(k) {
                out.push(key(k.0, k.1, false));
            }
        }
        send(&out);
        g.kb = want;
        Ok(())
    }
}

fn token_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut e = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(token, TokenElevation, Some(&mut e as *mut _ as *mut _), size_of::<TOKEN_ELEVATION>() as u32, &mut len).is_ok();
        let _ = CloseHandle(token);
        ok.then_some(e.TokenIsElevated != 0)
    }
}

/// 灵动岛自己是不是以管理员身份运行
pub fn self_elevated() -> bool {
    token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false)
}

/// 前台窗口的程序以管理员身份运行、我们却不是：这时系统不让我们给它模拟键盘鼠标（触控板、键盘模式的手柄都没用）
pub fn elevated_foreground() -> bool {
    if self_elevated() {
        return false;
    }
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return false;
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        // 管理员身份的程序，普通程序连它的令牌都打不开：打不开也当成是
        let elevated = token_elevated(h).unwrap_or(true);
        let _ = CloseHandle(h);
        elevated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_and_keys() {
        let s = PadState::from_json(&json!({"b": A | 0x0400 | UP, "lt": 300, "rt": 200, "lx": 32767, "ly": -40000}));
        assert_eq!(s.buttons, A | UP); // Guide 被去掉
        assert_eq!((s.lt, s.rt, s.lx, s.ly), (255, 200, 32767, -32767));
        let h = held_for(&s);
        assert!(h.keys.contains(&(0x39, false)) && h.keys.contains(&(0x02, false)));
        assert!(h.keys.contains(&(KEY_D, false)) && h.keys.contains(&(KEY_S, false)));
        assert!(h.left && h.right && !h.middle);
        assert_eq!(held_for(&PadState::default()), Held::default());
    }
}
