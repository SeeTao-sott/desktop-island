//! 音频可视化的数据：录取"系统正在播放的声音"（WASAPI 环回，不是麦克风），分成 64 个频段发给小组件页面。
//!
//! - 只是读系统混音的副本做分析，不保存、不上传，也不碰任何别的程序。
//! - 只有桌面上有音频组件、而且没在全屏时才录；没人看就把录音关掉，线程睡着。
//! - 安静超过 2.5 秒就停止发送（页面会淡出、停止绘制），有声音再接着发。
//! - 默认输出设备换了（比如插上耳机），录取出错后 1 秒自动重新连接。

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
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

/// FFT 窗口（2048 点 ≈ 43 毫秒，低音也分得开）
const N: usize = 2048;
/// 发给页面的频段数
pub const BANDS: usize = 64;
/// 波形点数（阶段 2 用）
const WAVE: usize = 128;
/// 安静多久算"没声音"
const SILENT_AFTER: Duration = Duration::from_millis(2500);
/// 低于这个电平算安静（约 -70 dB）
const SILENT_LEVEL: f32 = 3e-4;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    /// 每个频段 0..255（低音在前）
    pub bands: Vec<u8>,
    /// 最近一段的波形 -127..127（左右声道平均）
    pub wave: Vec<i8>,
    /// 整体响度 0..1
    pub level: f32,
    /// 已经安静了一阵：页面淡出、停止绘制
    pub silent: bool,
}

pub struct Audio {
    demand: AtomicUsize,
    fps: AtomicU32,
    /// 有组件用波形样式时才算、才发波形（省掉没人用的数据）
    want_wave: AtomicBool,
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
            want_wave: AtomicBool::new(false),
            worker: handle.thread().clone(),
        });
        let _ = AUDIO.set(a.clone());
        a
    }

    /// 音频组件出现 / 消失（或暂停）时调用；fps 是组件设置的帧率，wave 表示要不要波形
    pub fn watch(&self, on: bool, fps: u32, wave: bool) {
        self.fps.store(fps.clamp(15, 60), Ordering::SeqCst);
        self.want_wave.store(wave, Ordering::SeqCst);
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
        // 20 毫秒的缓冲；环回模式下系统把正在播放的混音复制一份给我们
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200_000, 0, fmt_ptr, None);
        CoTaskMemFree(Some(fmt_ptr as *const _));
        r?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let channels = fmt.nChannels.max(1) as usize;
        let bits = fmt.wBitsPerSample;
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
                                32 => *(data as *const f32).add(i),
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
                            let _ = app.emit_to("widgets", "audio-frame", Frame { bands: vec![0; BANDS], wave: vec![0; WAVE], level: 0.0, silent: true });
                        }
                        // 没声音：慢一点检查，不发数据
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                } else {
                    quiet_since = None;
                    sent_silent = false;
                }
                let want_wave = AUDIO.get().is_some_and(|a| a.want_wave.load(Ordering::SeqCst));
                let frame = Frame {
                    bands: an.bands(&samples),
                    wave: if want_wave { wave(&samples) } else { Vec::new() },
                    level: (level * 4.0).min(1.0),
                    silent: false,
                };
                let _ = app.emit_to("widgets", "audio-frame", frame);
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

/// 最近 WAVE 个点的波形（取最后约 10 毫秒，平均降采样）
fn wave(s: &[f32]) -> Vec<i8> {
    let span = 512;
    let tail = &s[s.len() - span..];
    let step = span / WAVE;
    (0..WAVE)
        .map(|i| {
            let v: f32 = tail[i * step..(i + 1) * step].iter().sum::<f32>() / step as f32;
            (v * 2.5).clamp(-1.0, 1.0).mul_add(127.0, 0.0) as i8
        })
        .collect()
}

// ---------------- 频谱 ----------------

struct Analyzer {
    window: Vec<f32>,
    /// 每个频段对应的 FFT 下标范围
    edges: Vec<(usize, usize)>,
    /// 每个频段的加权（高频补一点，音乐的高频天生弱）
    tilt: Vec<f32>,
}

impl Analyzer {
    fn new(rate: f32) -> Self {
        let window = (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (N - 1) as f32).cos()).collect();
        // 30 Hz ~ 16 kHz 按对数分成 BANDS 段
        let (lo, hi) = (30f32, 16_000f32.min(rate / 2.0 - 1.0));
        let bin = |f: f32| ((f / rate) * N as f32).round() as usize;
        let mut edges = Vec::with_capacity(BANDS);
        let mut tilt = Vec::with_capacity(BANDS);
        for b in 0..BANDS {
            let f0 = lo * (hi / lo).powf(b as f32 / BANDS as f32);
            let f1 = lo * (hi / lo).powf((b + 1) as f32 / BANDS as f32);
            let (a, mut z) = (bin(f0).max(1), bin(f1));
            if z <= a {
                z = a + 1;
            }
            edges.push((a, z.min(N / 2)));
            // 每倍频程 +3 dB
            tilt.push(((f0 * f1).sqrt() / 1000.0).log2() * 3.0);
        }
        Self { window, edges, tilt }
    }

    fn bands(&mut self, samples: &[f32]) -> Vec<u8> {
        let mut re: Vec<f32> = samples.iter().zip(&self.window).map(|(s, w)| s * w).collect();
        let mut im = vec![0f32; N];
        fft(&mut re, &mut im);
        self.edges
            .iter()
            .zip(&self.tilt)
            .map(|(&(a, z), &t)| {
                // 段内取最大值：窄的高音峰也看得见
                let m = (a..z).map(|k| re[k] * re[k] + im[k] * im[k]).fold(0f32, f32::max).sqrt() / (N as f32 / 4.0);
                let db = 20.0 * m.max(1e-9).log10() + t;
                // -62 dB ~ -8 dB 映射到 0..255
                (((db + 62.0) / 54.0).clamp(0.0, 1.0) * 255.0) as u8
            })
            .collect()
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

    /// 1 kHz 的正弦波：能量应该集中在 1 kHz 附近的频段
    #[test]
    fn sine_lands_in_right_band() {
        let rate = 48_000.0;
        let mut an = Analyzer::new(rate);
        let s: Vec<f32> = (0..N).map(|i| (2.0 * PI * 1000.0 * i as f32 / rate).sin() * 0.5).collect();
        let b = an.bands(&s);
        let peak = b.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        let (a, z) = an.edges[peak];
        let (f0, f1) = (a as f32 * rate / N as f32, z as f32 * rate / N as f32);
        assert!(f0 <= 1030.0 && f1 >= 970.0, "峰值落在 {f0}~{f1} Hz");
    }
}
