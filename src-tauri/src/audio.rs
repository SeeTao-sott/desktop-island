//! 音频可视化的数据：录取"系统正在播放的声音"（WASAPI 环回，不是麦克风），分成 128 个频段发给小组件页面。
//!
//! - 只是读系统混音的副本做分析，不保存、不上传，也不碰任何别的程序。
//! - 只有桌面上有音频组件、而且没在全屏时才录；没人看就把录音关掉，线程睡着。
//! - 安静超过 2.5 秒就停止发送（页面会淡出、停止绘制），有声音再接着发。
//! - 默认输出设备换了（比如插上耳机），录取出错后 1 秒自动重新连接。

use std::f32::consts::PI;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

/// 环形缓冲和低音 FFT 的长度（4096 点 ≈ 85 毫秒，低音分得细）
const N: usize = 4096;
/// 中高音 FFT 的长度（2048 点 ≈ 43 毫秒，反应快）
const N_SHORT: usize = 2048;
/// 发给页面的频段数
pub const BANDS: usize = 128;
/// 安静多久算"没声音"
const SILENT_AFTER: Duration = Duration::from_millis(2500);
/// 低于这个电平算安静（约 -70 dB）
const SILENT_LEVEL: f32 = 3e-4;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// 每个频段 0..255（低音在前）
    pub bands: Vec<u8>,
    /// 整体响度 0..1
    pub level: f32,
    /// 已经安静了一阵：页面淡出、停止绘制
    pub silent: bool,
}

pub struct Audio {
    demand: AtomicUsize,
    fps: AtomicU32,
    worker: thread::Thread,
}

impl Audio {
    pub fn spawn(app: AppHandle) -> Arc<Self> {
        let handle = thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            loop {
                let wanted = AUDIO.get().is_some_and(|a| a.demand.load(Ordering::SeqCst) > 0);
                if !wanted || crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst) {
                    thread::park_timeout(Duration::from_secs(2));
                    continue;
                }
                if let Err(e) = capture(&app) {
                    eprintln!("录取系统声音出错，1 秒后重连: {e:?}");
                    thread::sleep(Duration::from_secs(1));
                }
            }
        });
        let a = Arc::new(Self {
            demand: AtomicUsize::new(0),
            fps: AtomicU32::new(60),
            worker: handle.thread().clone(),
        });
        let _ = AUDIO.set(a.clone());
        a
    }

    /// 音频组件出现 / 消失（或暂停）时调用；fps 是组件设置的帧率
    pub fn watch(&self, on: bool, fps: u32) {
        self.fps.store(fps.clamp(15, 60), Ordering::SeqCst);
        if on {
            self.demand.fetch_add(1, Ordering::SeqCst);
            self.worker.unpark();
        } else {
            let _ = self.demand.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        }
    }
}

static AUDIO: std::sync::OnceLock<Arc<Audio>> = std::sync::OnceLock::new();

fn still_wanted() -> bool {
    AUDIO.get().is_some_and(|a| a.demand.load(Ordering::SeqCst) > 0) && !crate::fullscreen::FULLSCREEN.load(Ordering::SeqCst)
}

/// 连上默认输出设备的环回，一直读到没人要（或出错）为止
fn capture(app: &AppHandle) -> windows::core::Result<()> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let fmt_ptr = client.GetMixFormat()?;
        let fmt: WAVEFORMATEX = *fmt_ptr;
        // 采样是浮点还是整数：格式标记 3 = 浮点；0xFFFE（扩展格式）时看 SubFormat 的第一段（3 = 浮点，1 = 整数）
        let tag = fmt.wFormatTag;
        let is_float = tag == 3 || (tag == 0xFFFE && fmt.cbSize >= 22 && *((fmt_ptr as *const u8).add(24) as *const u32) == 3);
        // 20 毫秒的缓冲；环回模式下系统把正在播放的混音复制一份给我们
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200_000, 0, fmt_ptr, None);
        CoTaskMemFree(Some(fmt_ptr as *const _));
        r?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let channels = fmt.nChannels.max(1) as usize;
        let bits = fmt.wBitsPerSample;
        eprintln!("系统声音格式：{} 声道，{} Hz，{} 位，{}", channels, { fmt.nSamplesPerSec }, bits, if is_float { "浮点" } else { "整数" });
        let rate = fmt.nSamplesPerSec as f32;
        let mut an = Analyzer::new(rate);
        let mut ring = vec![0f32; N];
        let mut pos = 0usize;
        let mut quiet_since: Option<Instant> = None;
        let mut sent_silent = false;
        let mut next = Instant::now();

        let result = loop {
            if !still_wanted() {
                break Ok(());
            }
            // 把系统给的数据都读出来，混成单声道放进环形缓冲
            loop {
                let n = cap.GetNextPacketSize()?;
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent_flag = flags & 0x2 != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                for f in 0..frames as usize {
                    let mut s = 0f32;
                    if !silent_flag && !data.is_null() {
                        for c in 0..channels {
                            let i = f * channels + c;
                            s += match bits {
                                32 if is_float => *(data as *const f32).add(i),
                                32 => *(data as *const i32).add(i) as f32 / 2_147_483_648.0,
                                16 => *(data as *const i16).add(i) as f32 / 32768.0,
                                24 => {
                                    let p = data.add(i * 3);
                                    (((*p.add(2) as i32) << 24 | (*p.add(1) as i32) << 16 | (*p as i32) << 8) >> 8) as f32 / 8_388_608.0
                                }
                                _ => 0.0,
                            };
                        }
                        s /= channels as f32;
                    }
                    ring[pos] = s;
                    pos = (pos + 1) % N;
                }
                cap.ReleaseBuffer(frames)?;
            }

            let now = Instant::now();
            if now >= next {
                let fps = AUDIO.get().map(|a| a.fps.load(Ordering::SeqCst)).unwrap_or(60).max(15);
                next = now + Duration::from_secs_f32(1.0 / fps as f32);
                // 按时间顺序排好最近 N 个采样
                let samples: Vec<f32> = (0..N).map(|i| ring[(pos + i) % N]).collect();
                let level = rms(&samples[N - 1024..]);
                if level < SILENT_LEVEL {
                    let since = *quiet_since.get_or_insert(now);
                    if now - since >= SILENT_AFTER {
                        if !sent_silent {
                            sent_silent = true;
                            let silent = Frame { bands: vec![0; BANDS], level: 0.0, silent: true };
                            let _ = app.emit_to("widgets", "audio-frame", &silent);
                            let _ = app.emit_to(crate::edge::LABEL, "audio-frame", &silent);
                        }
                        // 没声音：慢一点检查，不发数据
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                } else {
                    quiet_since = None;
                    sent_silent = false;
                }
                let frame = Frame { bands: an.bands(&samples), level: (level * 4.0).min(1.0), silent: false };
                let _ = app.emit_to("widgets", "audio-frame", &frame);
                let _ = app.emit_to(crate::edge::LABEL, "audio-frame", &frame);
            }
            // 睡到下一帧（最多 10 毫秒，系统大约每 10 毫秒给一包数据）
            let wait = next.saturating_duration_since(Instant::now()).min(Duration::from_millis(10));
            thread::sleep(wait.max(Duration::from_millis(2)));
        };
        let _ = client.Stop();
        result
    }
}

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

// ---------------- 频谱 ----------------
//
// 两个窗口一起用：
//   - 低音（500 Hz 以下）用长窗口 4096 点（≈85 毫秒）：每格 ≈11.7 Hz，低音分得开，不会一个低音带动一大片柱子
//   - 中高音用短窗口 2048 点（≈43 毫秒）：反应快，鼓点、镲片跟得紧
// 每个频段：覆盖两格以上就取平均能量；比一格还窄（很低的低音）就按它的中心频率在相邻两格之间插值，
// 这样左边那些很窄的频段各有各的值，不会好几根柱子看同一格数据、一阶一阶地跳。

/// 低于这个频率的频段用长窗口
const SPLIT_HZ: f32 = 500.0;

struct Band {
    /// 用长窗口（低音）还是短窗口
    long: bool,
    /// 覆盖的 FFT 格（[a, z)）；不到两格时用 center 插值
    a: usize,
    z: usize,
    center: f32,
    /// 高频补偿（dB）
    tilt: f32,
    #[cfg(test)]
    range: (f32, f32),
}

struct Analyzer {
    win_long: Vec<f32>,
    win_short: Vec<f32>,
    bands: Vec<Band>,
    /// 自动增益：最近一两秒里最响那段的 dB（慢慢回落），当作柱子的顶
    peak_db: f32,
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (n - 1) as f32).cos()).collect()
}

impl Analyzer {
    fn new(rate: f32) -> Self {
        // 40 Hz ~ 16 kHz 按对数分成 BANDS 段
        let (lo, hi) = (40f32, 16_000f32.min(rate / 2.0 - 1.0));
        let bands = (0..BANDS)
            .map(|b| {
                let f0 = lo * (hi / lo).powf(b as f32 / BANDS as f32);
                let f1 = lo * (hi / lo).powf((b + 1) as f32 / BANDS as f32);
                let fc = (f0 * f1).sqrt();
                let long = fc < SPLIT_HZ;
                let n = if long { N } else { N_SHORT };
                let bin = |f: f32| f / rate * n as f32;
                // 中心频率落在 [f0, f1) 里的那些格
                let a = (bin(f0).ceil() as usize).max(1);
                let z = (bin(f1).ceil() as usize).clamp(a, n / 2);
                Band {
                    long,
                    a,
                    z,
                    center: bin(fc),
                    // 每倍频程 +2 dB（补偿音乐高频天生弱；补太多高音会翘起来，变成两边高中间低）
                    tilt: (fc / 1000.0).log2() * 2.0,
                    #[cfg(test)]
                    range: (f0, f1),
                }
            })
            .collect();
        Self { win_long: hann(N), win_short: hann(N_SHORT), bands, peak_db: -20.0 }
    }

    /// samples：按时间顺序的最近 N 个采样
    fn bands(&mut self, samples: &[f32]) -> Vec<u8> {
        let spectrum = |s: &[f32], w: &[f32]| {
            let mut re: Vec<f32> = s.iter().zip(w).map(|(x, w)| x * w).collect();
            let mut im = vec![0f32; s.len()];
            fft(&mut re, &mut im);
            // 只要前一半；顺手换成"相对振幅"（正弦波振幅 A 的峰值是 A·n/4）
            let norm = s.len() as f32 / 4.0;
            (0..s.len() / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt() / norm).collect::<Vec<f32>>()
        };
        let long = spectrum(samples, &self.win_long);
        let short = spectrum(&samples[N - N_SHORT..], &self.win_short);
        let dbs: Vec<f32> = self
            .bands
            .iter()
            .map(|b| {
                let mag = if b.long { &long } else { &short };
                let m = if b.z >= b.a + 2 {
                    // 段内平均能量
                    ((b.a..b.z).map(|k| mag[k] * mag[k]).sum::<f32>() / (b.z - b.a) as f32).sqrt()
                } else {
                    // 比一格还窄：在相邻两格之间按中心频率插值
                    let k0 = (b.center.floor() as usize).min(mag.len() - 2);
                    let t = (b.center - k0 as f32).clamp(0.0, 1.0);
                    mag[k0] * (1.0 - t) + mag[k0 + 1] * t
                };
                20.0 * m.max(1e-9).log10() + b.tilt
            })
            .collect();
        // 自动增益：以最近最响的一段为顶、往下 48 dB 为底。各段之间的高低关系不变，
        // 只是整体挪到合适的高度——系统音量小、歌本身小声，柱子也能占满组件。
        // 顶每帧最多回落 0.15 dB（每秒约 9 dB），最低不低于 -40 dB，免得安静时把底噪放大
        let frame_max = dbs.iter().copied().fold(f32::MIN, f32::max);
        self.peak_db = frame_max.max(self.peak_db - 0.15);
        let top = self.peak_db.max(-40.0);
        const RANGE: f32 = 48.0;
        dbs.iter().map(|db| (((db - (top - RANGE)) / RANGE).clamp(0.0, 1.0) * 255.0) as u8).collect()
    }
}

/// 原地基 2 FFT（N 是 2 的幂）
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1f32, 0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f32, rate: f32) -> Vec<f32> {
        (0..N).map(|i| (2.0 * PI * freq * i as f32 / rate).sin() * 0.5).collect()
    }

    fn bar(b: &[u8]) -> String {
        b.iter().map(|v| if *v > 200 { '█' } else if *v > 120 { '▆' } else if *v > 40 { '▂' } else { '·' }).collect()
    }

    /// 单音测试（和在线测试音一样）：100 Hz 时只有左边（低音）那几根动；5000 Hz 时只有右边（高音）那几根动。
    /// 打印出每个频段的值，方便肉眼核对
    #[test]
    fn single_tones_only_move_their_side() {
        let rate = 48_000.0;
        for (freq, low_side) in [(100.0f32, true), (5000.0, false)] {
            let mut an = Analyzer::new(rate);
            let b = an.bands(&tone(freq, rate));
            let lit = b.iter().filter(|v| **v > 120).count();
            println!("{freq:>6} Hz  {}  （明显亮起 {lit} 段）", bar(&b));
            let peak = b.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
            let half = BANDS / 2;
            if low_side {
                assert!(peak < half / 2, "100 Hz 的峰在第 {peak} 段，应该在左边");
                assert!(b[half..].iter().all(|v| *v < 40), "100 Hz 时右半边也有柱子动了：{:?}", &b[half..]);
            } else {
                assert!(peak > half + half / 2, "5000 Hz 的峰在第 {peak} 段，应该在右边");
                assert!(b[..half].iter().all(|v| *v < 40), "5000 Hz 时左半边也有柱子动了：{:?}", &b[..half]);
            }
            // 一个单音只该点亮很窄的一片（不到十分之一的柱子）
            assert!(lit <= BANDS / 10, "{freq} Hz 一下亮了 {lit} 段，太散");
        }
    }

    /// 几个频率的峰都要落在包含这个频率的频段（或紧挨着的一段）
    #[test]
    fn peaks_land_in_right_band() {
        let rate = 48_000.0;
        for freq in [60.0f32, 100.0, 250.0, 1000.0, 5000.0, 12_000.0] {
            let mut an = Analyzer::new(rate);
            let b = an.bands(&tone(freq, rate));
            let peak = b.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
            let want = an.bands.iter().position(|band| band.range.0 <= freq && freq < band.range.1).unwrap();
            assert!(peak.abs_diff(want) <= 1, "{freq} Hz 的峰在第 {peak} 段，应该在第 {want} 段附近");
        }
    }
}
