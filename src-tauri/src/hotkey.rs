//! 全局快捷键：用系统的 RegisterHotKey 注册一个组合键。
//! 系统只在按下这一个组合时通知我们；不挂键盘钩子，也不会收到、记录其他任何按键。

use std::thread;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, VK_F1,
    VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

/// 把 "Ctrl+Alt+D" 这样的写法解析成修饰键 + 虚拟键码
fn parse(spec: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let mut mods = MOD_NOREPEAT;
    let mut key = None;
    for part in spec.split('+').map(|p| p.trim().to_ascii_lowercase()) {
        match part.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" => mods |= MOD_WIN,
            "space" => key = Some(VK_SPACE.0 as u32),
            p if p.len() == 1 && p.chars().all(|c| c.is_ascii_alphanumeric()) => {
                key = Some(p.to_ascii_uppercase().as_bytes()[0] as u32)
            }
            p if p.starts_with('f') => {
                let n: u32 = p[1..].parse().ok().filter(|n| (1..=24).contains(n))?;
                key = Some(VK_F1.0 as u32 + n - 1);
            }
            _ => return None,
        }
    }
    // 至少要带一个修饰键，避免单个字母抢走正常输入
    if mods == MOD_NOREPEAT {
        return None;
    }
    // Win+D 是系统自己的"显示桌面"，不去抢
    if mods == MOD_NOREPEAT | MOD_WIN && key == Some(b'D' as u32) {
        eprintln!("Win+D 是系统的快捷键，不能用");
        return None;
    }
    key.map(|k| (mods, k))
}

/// 注册成功返回 true；格式不对或被别的程序占用时返回 false（静默，不弹窗）
pub fn spawn(spec: &str, on_press: impl Fn() + Send + 'static) -> bool {
    let Some((mods, vk)) = parse(spec) else {
        if !spec.trim().is_empty() {
            eprintln!("快捷键写法看不懂: {spec}");
        }
        return false;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    let spec = spec.to_string();
    thread::spawn(move || unsafe {
        // 热键消息会发到注册它的线程，所以注册和收消息在同一个线程里
        let ok = RegisterHotKey(None, 1, mods, vk).is_ok();
        let _ = tx.send(ok);
        if !ok {
            eprintln!("快捷键 {spec} 注册失败（可能被别的程序占用了）");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                on_press();
            }
        }
    });
    rx.recv().unwrap_or(false)
}
