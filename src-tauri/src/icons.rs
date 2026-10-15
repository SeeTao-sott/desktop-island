//! 系统图标和图片缩略图：用资源管理器同一套接口（IShellItemImageFactory）取图，转成 PNG 给页面显示。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::Engine;
use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE};

/// 缓存：同一个文件没改过就不重复取图
static CACHE: Mutex<Option<HashMap<(String, u64, bool), String>>> = Mutex::new(None);
const CACHE_MAX: usize = 800;

struct Req {
    path: PathBuf,
    thumbnail: bool,
    reply: Sender<Option<Vec<u8>>>,
}

/// 所有取图都交给同一个专用线程：有些程序的图标处理器（比如 PDF 阅读器的）
/// 只在"单线程 COM + 有消息循环"的线程里才正常工作
static WORKER: OnceLock<Mutex<Sender<Req>>> = OnceLock::new();

fn worker() -> Sender<Req> {
    WORKER
        .get_or_init(|| {
            let (tx, rx) = channel::<Req>();
            thread::spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                loop {
                    match rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(req) => {
                            let size = if req.thumbnail { 96 } else { 64 };
                            let _ = req.reply.send(shell_image(&req.path, size, req.thumbnail));
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    // 空闲时把这个线程收到的窗口消息处理掉，图标处理器需要
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            });
            Mutex::new(tx)
        })
        .lock()
        .unwrap()
        .clone()
}

/// thumbnail = true 时取缩略图（图片），否则只取图标
pub fn data_url(path: &Path, modified: u64, thumbnail: bool) -> Option<String> {
    let key = (path.to_string_lossy().to_string(), modified, thumbnail);
    if let Some(hit) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(&key)) {
        return Some(hit.clone());
    }
    let (tx, rx) = channel();
    worker().send(Req { path: path.to_path_buf(), thumbnail, reply: tx }).ok()?;
    // 某个文件的图标处理器卡住时不要一直等
    let png = rx.recv_timeout(Duration::from_secs(5)).ok()??;
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    if cache.len() >= CACHE_MAX {
        cache.clear();
    }
    cache.insert(key, url.clone());
    Some(url)
}

unsafe fn shell_image(path: &Path, size: i32, thumbnail: bool) -> Option<Vec<u8>> {
    // 外壳对象要在 STA 线程里用；同一线程重复初始化没关系
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).ok()?;
    let size = SIZE { cx: size, cy: size };
    // 图片：明确要缩略图（默认模式常常直接给个"照片"图标），拿不到再退回图标
    let bmp = if thumbnail {
        factory
            .GetImage(size, SIIGBF_THUMBNAILONLY | SIIGBF_RESIZETOFIT)
            .or_else(|_| factory.GetImage(size, SIIGBF_ICONONLY))
    } else {
        factory.GetImage(size, SIIGBF_ICONONLY)
    }
    .ok()?;
    let png = to_png(bmp);
    let _ = DeleteObject(HGDIOBJ(bmp.0));
    png
}

unsafe fn to_png(bmp: HBITMAP) -> Option<Vec<u8>> {
    let mut info = BITMAP::default();
    if GetObjectW(HGDIOBJ(bmp.0), size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut _)) == 0 {
        return None;
    }
    let (w, h) = (info.bmWidth, info.bmHeight.abs());
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // 负数 = 从上往下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let dc = CreateCompatibleDC(None);
    let lines = GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    if lines == 0 {
        return None;
    }

    // 没有透明通道的缩略图（比如 JPG）alpha 全是 0，当成完全不透明
    let no_alpha = px.chunks_exact(4).all(|p| p[3] == 0);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2); // BGRA → RGBA
        if no_alpha {
            p[3] = 255;
        } else if p[3] > 0 && p[3] < 255 {
            // 系统给的是预乘过透明度的颜色，还原回来，边缘才不会发黑
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }

    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&px).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手动检查用：cargo test icon_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn icon_probe() {
        let dir = std::path::PathBuf::from(std::env::var("ICON_PROBE_DIR").unwrap());
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            let thumb = std::env::var("ICON_PROBE_THUMB").is_ok();
            let png = unsafe { shell_image(&p, if thumb { 96 } else { 64 }, thumb) };
            let summary = png.as_ref().map(|b| {
                // 看看是不是整张透明
                let dec = png::Decoder::new(std::io::Cursor::new(b.clone()));
                let mut r = dec.read_info().unwrap();
                let mut buf = vec![0; r.output_buffer_size().unwrap()];
                r.next_frame(&mut buf).unwrap();
                let opaque = buf.chunks(4).filter(|p| p[3] > 0).count();
                format!("{} 字节, 不透明像素 {}", b.len(), opaque)
            });
            println!("{:?} -> {:?}", p.file_name().unwrap(), summary);
        }
    }
}
