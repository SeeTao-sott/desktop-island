//! 小组件跟着壁纸变色：从壁纸预览图里取主色、强调色和整体亮度，算出一套玻璃底色和文字颜色。
//!
//! 文字可读性是按"最坏情况"算的：半透明玻璃后面可能是纯白、也可能是纯黑，
//! 两种情况下正文和底色的对比度都要 ≥ 4.5（WCAG AA），次要文字 ≥ 3，不够就加深玻璃、提高不透明度。
//! 所以不管组件背后是壁纸的哪一块，字都看得清。

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::Config;
use crate::wallpaper::{self, Wallpaper};

// ---------------- 颜色计算 ----------------

/// sRGB，0..1
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

const WHITE: Rgb = Rgb { r: 1.0, g: 1.0, b: 1.0 };
const BLACK: Rgb = Rgb { r: 0.0, g: 0.0, b: 0.0 };

impl Rgb {
    fn new(r: f64, g: f64, b: f64) -> Self {
        Self { r: r.clamp(0.0, 1.0), g: g.clamp(0.0, 1.0), b: b.clamp(0.0, 1.0) }
    }

    /// 相对亮度（WCAG）
    fn luminance(self) -> f64 {
        let lin = |c: f64| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
        0.2126 * lin(self.r) + 0.7152 * lin(self.g) + 0.0722 * lin(self.b)
    }

    /// self 盖在 under 上、不透明度 alpha 时看到的颜色
    fn over(self, under: Rgb, alpha: f64) -> Rgb {
        Rgb::new(
            self.r * alpha + under.r * (1.0 - alpha),
            self.g * alpha + under.g * (1.0 - alpha),
            self.b * alpha + under.b * (1.0 - alpha),
        )
    }

    fn hsl(self) -> (f64, f64, f64) {
        let max = self.r.max(self.g).max(self.b);
        let min = self.r.min(self.g).min(self.b);
        let l = (max + min) / 2.0;
        let d = max - min;
        if d < 1e-9 {
            return (0.0, 0.0, l);
        }
        let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
        let h = if max == self.r {
            ((self.g - self.b) / d).rem_euclid(6.0)
        } else if max == self.g {
            (self.b - self.r) / d + 2.0
        } else {
            (self.r - self.g) / d + 4.0
        };
        (h * 60.0, s, l)
    }

    fn from_hsl(h: f64, s: f64, l: f64) -> Rgb {
        let s = s.clamp(0.0, 1.0);
        let l = l.clamp(0.0, 1.0);
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let hp = h.rem_euclid(360.0) / 60.0;
        let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
        let (r, g, b) = match hp as i32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = l - c / 2.0;
        Rgb::new(r + m, g + m, b + m)
    }

    fn to255(self, a: f64) -> [f64; 4] {
        [(self.r * 255.0).round(), (self.g * 255.0).round(), (self.b * 255.0).round(), (a * 1000.0).round() / 1000.0]
    }
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (a.luminance(), b.luminance());
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// 把 "#5b7bd5"、"#abc"、"rgb(91,123,213)" 解析成颜色
pub fn parse_color(s: &str) -> Option<Rgb> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        let v: Vec<u8> = match hex.len() {
            3 => hex.chars().map(|c| u8::from_str_radix(&c.to_string().repeat(2), 16).ok()).collect::<Option<_>>()?,
            6 => (0..3).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect::<Option<_>>()?,
            _ => return None,
        };
        return Some(Rgb::new(v[0] as f64 / 255.0, v[1] as f64 / 255.0, v[2] as f64 / 255.0));
    }
    let inner = s.strip_prefix("rgb(").or_else(|| s.strip_prefix("rgba("))?.strip_suffix(')')?;
    let n: Vec<f64> = inner.split(',').take(3).map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    (n.len() == 3).then(|| Rgb::new(n[0] / 255.0, n[1] / 255.0, n[2] / 255.0))
}

// ---------------- 从图片取色 ----------------

#[derive(Clone, Copy, Debug)]
pub struct Extracted {
    /// 面积最大的颜色
    pub dominant: Rgb,
    /// 有一定面积、又最鲜艳的颜色
    pub accent: Rgb,
    /// 整张图的平均色（判断壁纸整体偏亮还是偏暗）
    pub average: Rgb,
}

pub fn extract(path: &Path) -> Option<Extracted> {
    // TranscodedWallpaper 没有扩展名，要按内容判断格式；GIF 只取第一帧
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let small = img.thumbnail(64, 64).to_rgb8();
    let total = (small.width() * small.height()) as f64;
    if total < 1.0 {
        return None;
    }
    // 每个通道分 8 档，共 512 个桶；桶里的平均色才是真正的颜色
    let mut sum = vec![[0f64; 4]; 512];
    let mut avg = [0f64; 3];
    for p in small.pixels() {
        let [r, g, b] = p.0;
        let i = ((r >> 5) as usize) << 6 | ((g >> 5) as usize) << 3 | (b >> 5) as usize;
        sum[i][0] += r as f64;
        sum[i][1] += g as f64;
        sum[i][2] += b as f64;
        sum[i][3] += 1.0;
        avg[0] += r as f64;
        avg[1] += g as f64;
        avg[2] += b as f64;
    }
    let color = |s: &[f64; 4]| Rgb::new(s[0] / s[3] / 255.0, s[1] / s[3] / 255.0, s[2] / s[3] / 255.0);
    let top = sum.iter().filter(|s| s[3] > 0.0).max_by(|a, b| a[3].total_cmp(&b[3]))?;
    let dominant = color(top);
    let accent = sum
        .iter()
        .filter(|s| s[3] >= total * 0.005)
        .map(|s| {
            let c = color(s);
            let max = c.r.max(c.g).max(c.b);
            let min = c.r.min(c.g).min(c.b);
            let sat = if max > 0.0 { (max - min) / max } else { 0.0 };
            // 太暗的不算强调色；鲜艳度为主，面积开四次方根稍微照顾一下
            let score = if max < 0.25 { 0.0 } else { sat * max.powf(0.8) * (s[3] / total).powf(0.25) };
            (score, c)
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .filter(|(score, _)| *score > 0.05)
        .map(|(_, c)| c)
        .unwrap_or(dominant);
    let average = Rgb::new(avg[0] / total / 255.0, avg[1] / total / 255.0, avg[2] / total / 255.0);
    Some(Extracted { dominant, accent, average })
}

// ---------------- 配色 ----------------

/// 发给页面的一套颜色。数值都是 [r, g, b, a]，r/g/b 是 0..255，a 是 0..1，方便页面做平滑过渡
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub bg: [f64; 4],
    pub text: [f64; 4],
    pub sub: [f64; 4],
    pub stroke: [f64; 4],
    pub accent: [f64; 4],
    pub on_accent: [f64; 4],
    /// 深色玻璃（浅色字）还是浅色玻璃（深色字）
    pub dark: bool,
    /// "wallpaper-engine" / "windows" / "manual"
    pub source: String,
    pub image: String,
    /// 实测的最坏情况对比度（正文、次要文字），方便核对
    pub contrast_text: f64,
    pub contrast_sub: f64,
}

/// 字在玻璃上的最坏对比度：玻璃后面是纯白或纯黑两种极端
fn worst(fg: Rgb, fg_alpha: f64, bg: Rgb, bg_alpha: f64) -> f64 {
    [WHITE, BLACK]
        .iter()
        .map(|&behind| {
            let glass = bg.over(behind, bg_alpha);
            contrast(fg.over(glass, fg_alpha), glass)
        })
        .fold(f64::INFINITY, f64::min)
}

pub fn build(e: &Extracted, source: &str, image: &str) -> Theme {
    let (h, s, _) = e.dominant.hsl();
    // 壁纸整体偏暗就用深色玻璃 + 浅色字，偏亮就用浅色玻璃 + 深色字
    let dark = e.average.luminance() < 0.4;
    let s_bg = s.clamp(0.12, 0.45);
    let mut l_bg: f64 = if dark { 0.17 } else { 0.9 };
    let mut alpha: f64 = 0.66;
    let text_c = if dark { Rgb::from_hsl(h, 0.25, 0.97) } else { Rgb::from_hsl(h, 0.35, 0.1) };

    // 正文对比度不到 4.5：玻璃更深（或更浅）、更不透明，直到够为止
    let mut bg = Rgb::from_hsl(h, s_bg, l_bg);
    for _ in 0..30 {
        bg = Rgb::from_hsl(h, s_bg, l_bg);
        if worst(text_c, 1.0, bg, alpha) >= 4.5 {
            break;
        }
        alpha = (alpha + 0.02).min(0.92);
        l_bg = if dark { (l_bg - 0.01).max(0.06) } else { (l_bg + 0.006).min(0.97) };
    }
    let mut text = text_c;
    if worst(text, 1.0, bg, alpha) < 4.5 {
        text = if worst(WHITE, 1.0, bg, alpha) > worst(BLACK, 1.0, bg, alpha) { WHITE } else { BLACK };
    }

    // 次要文字：正文颜色加透明度，最坏对比度 ≥ 3
    let mut sub_a: f64 = 0.62;
    while worst(text, sub_a, bg, alpha) < 3.0 && sub_a < 1.0 {
        sub_a = (sub_a + 0.04).min(1.0);
    }

    // 强调色：保留色相，调亮度到和玻璃（盖在壁纸平均色上）对比度 ≥ 3
    let (ha, sa, _) = e.accent.hsl();
    let sa = sa.clamp(0.45, 0.9);
    let glass_mid = bg.over(e.average, alpha);
    let mut la: f64 = if dark { 0.62 } else { 0.42 };
    let mut accent = Rgb::from_hsl(ha, sa, la);
    for _ in 0..20 {
        accent = Rgb::from_hsl(ha, sa, la);
        if contrast(accent, glass_mid) >= 3.0 {
            break;
        }
        la = if dark { (la + 0.03).min(0.9) } else { (la - 0.03).max(0.15) };
    }
    let on_accent = if contrast(WHITE, accent) >= contrast(BLACK, accent) { WHITE } else { Rgb::from_hsl(ha, 0.4, 0.08) };

    let stroke = if dark { WHITE.to255(0.1) } else { BLACK.to255(0.08) };
    Theme {
        bg: bg.to255(alpha),
        text: text.to255(1.0),
        sub: text.to255(sub_a),
        stroke,
        accent: accent.to255(1.0),
        on_accent: on_accent.to255(1.0),
        dark,
        source: source.into(),
        image: image.into(),
        contrast_text: (worst(text, 1.0, bg, alpha) * 100.0).round() / 100.0,
        contrast_sub: (worst(text, sub_a, bg, alpha) * 100.0).round() / 100.0,
    }
}

/// 手动指定颜色：把它当作壁纸的主色和强调色，按它的明暗决定深浅玻璃
pub fn build_manual(c: Rgb) -> Theme {
    build(&Extracted { dominant: c, accent: c, average: c }, "manual", "")
}

// ---------------- 盯着壁纸 ----------------

pub struct ThemeHub {
    current: Mutex<Option<Theme>>,
}

impl ThemeHub {
    pub fn get(&self) -> Option<Theme> {
        self.current.lock().unwrap().clone()
    }
}

/// 快速检查的间隔：只是几次系统查询
const QUICK: Duration = Duration::from_secs(5);

pub fn spawn(app: AppHandle, cfg: &Config) -> Arc<ThemeHub> {
    let hub = Arc::new(ThemeHub { current: Mutex::new(None) });
    let manual = (cfg.widgets_color_mode == "manual").then(|| parse_color(&cfg.widgets_manual_color)).flatten();
    if cfg.widgets_color_mode == "manual" && manual.is_none() {
        eprintln!("手动颜色写法看不懂：{}，先跟随壁纸", cfg.widgets_manual_color);
    }
    let full_every = Duration::from_secs(cfg.widgets_wallpaper_check_seconds as u64);
    let h = hub.clone();
    thread::spawn(move || {
        let publish = |t: Theme| {
            *h.current.lock().unwrap() = Some(t.clone());
            let _ = app.emit("widgets-theme", t);
        };
        if let Some(c) = manual {
            publish(build_manual(c));
            return;
        }
        let mut last_sig = None;
        let mut last_full: Option<Instant> = None;
        let mut last_wp: Option<Wallpaper> = None;
        loop {
            // 全屏游戏 / 视频时什么都不做
            if !crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst) {
                let sig = wallpaper::quick_signature();
                // 信号变了马上查；Wallpaper Engine 播放列表自己换图时不一定改配置，所以它在运行时再定时查一次
                let due = Some(sig) != last_sig || (sig.0 && last_full.is_none_or(|t| t.elapsed() >= full_every));
                if due {
                    last_sig = Some(sig);
                    last_full = Some(Instant::now());
                    if let Some(wp) = wallpaper::detect() {
                        if Some(&wp) != last_wp.as_ref() {
                            match extract(&wp.image) {
                                Some(e) => {
                                    let t = build(&e, wp.source, &wp.image.to_string_lossy());
                                    eprintln!(
                                        "壁纸换了：{}（{}），正文对比度 {}，次要文字 {}",
                                        wp.image.display(),
                                        wp.source,
                                        t.contrast_text,
                                        t.contrast_sub
                                    );
                                    publish(t);
                                }
                                None => eprintln!("壁纸预览图读不了：{}", wp.image.display()),
                            }
                            last_wp = Some(wp);
                        }
                    }
                }
            }
            thread::sleep(QUICK);
        }
    });
    hub
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各种极端颜色下，最坏情况的对比度都要达标
    #[test]
    fn contrast_always_readable() {
        let samples = [
            "#000000", "#ffffff", "#ff0000", "#ffff00", "#00ff00", "#0000ff", "#808080", "#f5e6c8", "#1a2b4c", "#ff77aa",
        ];
        for s in samples {
            for avg in samples {
                let c = parse_color(s).unwrap();
                let e = Extracted { dominant: c, accent: c, average: parse_color(avg).unwrap() };
                let t = build(&e, "test", "");
                assert!(t.contrast_text >= 4.5, "{s} 在 {avg} 上正文对比度 {}", t.contrast_text);
                assert!(t.contrast_sub >= 3.0, "{s} 在 {avg} 上次要文字对比度 {}", t.contrast_sub);
            }
        }
    }

    #[test]
    fn parses_colors() {
        assert_eq!(parse_color("#fff"), Some(WHITE));
        assert_eq!(parse_color("#000000"), Some(BLACK));
        assert!(parse_color("rgb(91, 123, 213)").is_some());
        assert!(parse_color("blue").is_none());
    }

    /// 手动跑：看看取色结果（cargo test wallpaper_probe -- --ignored --nocapture）。
    /// 默认用系统壁纸；环境变量 WALLPAPER_PROBE="图1|图2" 可以指定别的图
    #[test]
    #[ignore]
    fn wallpaper_probe() {
        let paths: Vec<std::path::PathBuf> = match std::env::var("WALLPAPER_PROBE") {
            Ok(v) => v.split('|').map(Into::into).collect(),
            Err(_) => wallpaper::windows_image().into_iter().collect(),
        };
        let hex = |c: [f64; 4]| format!("#{:02x}{:02x}{:02x} a={}", c[0] as u8, c[1] as u8, c[2] as u8, c[3]);
        for p in paths {
            let e = extract(&p).expect("读不了图");
            let t = build(&e, "probe", "");
            println!(
                "{}\n  底色 {}  文字 {}  次要 {}  强调 {}  深色={}  对比度 正文 {} / 次要 {}",
                p.display(),
                hex(t.bg),
                hex(t.text),
                hex(t.sub),
                hex(t.accent),
                t.dark,
                t.contrast_text,
                t.contrast_sub
            );
        }
    }
}
