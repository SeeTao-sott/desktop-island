//! 开机自动启动：写在当前用户的 Run 注册表项里（不需要管理员权限）。
//! 只在用户从托盘菜单里勾选时才会改动。

use windows::core::{w, PCWSTR};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
};

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const VALUE_NAME: PCWSTR = w!("DesktopIsland");

pub fn is_enabled() -> bool {
    unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME, RRF_RT_REG_SZ, None, None, None).is_ok() }
}

pub fn set(enabled: bool) -> windows::core::Result<()> {
    unsafe {
        if enabled {
            let exe = std::env::current_exe().map_err(|_| windows::core::Error::empty())?;
            let cmd: Vec<u16> = format!("\"{}\"", exe.display()).encode_utf16().chain([0]).collect();
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                RUN_KEY,
                VALUE_NAME,
                REG_SZ.0,
                Some(cmd.as_ptr().cast()),
                (cmd.len() * 2) as u32,
            )
            .ok()
        } else {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME).ok()
        }
    }
}
