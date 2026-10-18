//! 音游：读 osu! 谱（.osz 改成 .zip 解压后的文件夹，每个 .osu 是一个难度）。
//!
//! .osu 是分段的纯文本：
//!   [General]    AudioFilename、Mode（0 standard、1 taiko、2 catch、3 mania）
//!   [Metadata]   Title、Artist、Creator、Version（难度名）
//!   [Difficulty] CircleSize、ApproachRate、OverallDifficulty
//!   [Events]     背景图 `0,0,"bg.jpg",0,0`
//!   [TimingPoints] 第一个"非继承"时间点的 beatLength（毫秒 / 拍）→ BPM
//!   [HitObjects] 每行 x,y,time,type,hitSound,...：type 的 bit0 圈、bit1 滑条、bit3 转盘、bit7 mania 长按
//! 我们要：圈（x, y, 毫秒）、滑条和长按只要起点、转盘不要。坐标范围 x 0–512、y 0–384。
//! 四种模式用的是同一种格式，只是意思不同：
//!   standard：x、y 是屏幕位置
//!   taiko：x、y 没用；hitSound 里有 whistle(2) 或 clap(8) 是蓝（鼓边 ka），否则红（鼓面 don）；finish(4) 是大音符
//!   catch：x 是左右位置，y 没用
//!   mania：x 是第几轨（轨道 = x × 键数 ÷ 512），CircleSize 就是键数

use std::fs;
use std::path::Path;

use serde::Serialize;

/// 一个要打的点
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq)]
pub struct OsuHit {
    /// osu 坐标（x 0–512，y 0–384，y 向下）
    pub x: f64,
    pub y: f64,
    /// 应该被打中的时刻（秒）
    pub t: f64,
    /// 是滑条的起点（不是普通圈）
    pub slider: bool,
    /// hitSound：bit1 whistle、bit2 finish、bit3 clap（太鼓用来分红蓝、大小）
    pub sound: u8,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct OsuChart {
    pub title: String,
    pub artist: String,
    pub creator: String,
    pub version: String,
    pub audio: String,
    pub background: String,
    pub mode: u8,
    pub cs: f64,
    pub ar: f64,
    pub od: f64,
    pub bpm: f64,
    pub hits: Vec<OsuHit>,
}

impl OsuChart {
    /// ApproachRate → 靶子提前多少秒出现（osu! 的换算：AR5 = 1.2 秒，AR 越高越晚出现）
    pub fn preempt(&self) -> f64 {
        let ar = self.ar;
        let ms = if ar < 5.0 { 1200.0 + 600.0 * (5.0 - ar) / 5.0 } else { 1200.0 - 750.0 * (ar - 5.0) / 5.0 };
        ms / 1000.0
    }

    /// CircleSize → 圈的半径（osu 坐标像素）
    pub fn radius(&self) -> f64 {
        54.4 - 4.48 * self.cs
    }
}

/// 解析一个 .osu 文件的内容
pub fn parse(text: &str) -> OsuChart {
    let mut c = OsuChart { cs: 5.0, od: 5.0, ar: f64::NAN, ..Default::default() };
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_string();
            continue;
        }
        match section.as_str() {
            "General" | "Metadata" | "Difficulty" => {
                let Some((k, v)) = line.split_once(':') else { continue };
                let (k, v) = (k.trim(), v.trim());
                let num = || v.parse::<f64>().ok();
                match k {
                    "AudioFilename" => c.audio = v.to_string(),
                    "Mode" => c.mode = v.parse().unwrap_or(0),
                    "Title" => c.title = v.to_string(),
                    "Artist" => c.artist = v.to_string(),
                    "Creator" => c.creator = v.to_string(),
                    "Version" => c.version = v.to_string(),
                    "CircleSize" => c.cs = num().unwrap_or(c.cs),
                    "ApproachRate" => c.ar = num().unwrap_or(c.ar),
                    "OverallDifficulty" => c.od = num().unwrap_or(c.od),
                    _ => {}
                }
            }
            "Events" => {
                // 背景图：0,0,"文件名",x,y
                if c.background.is_empty() && line.starts_with("0,0,") {
                    if let Some(name) = line.split(',').nth(2) {
                        c.background = name.trim().trim_matches('"').to_string();
                    }
                }
            }
            "TimingPoints" => {
                // time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
                // 老格式没有 uninherited 这一列，beatLength 为正就是非继承的
                if c.bpm == 0.0 {
                    let f: Vec<&str> = line.split(',').collect();
                    let beat = f.get(1).and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(-1.0);
                    let uninherited = f.get(6).map(|s| s.trim() == "1").unwrap_or(true);
                    if beat > 0.0 && uninherited {
                        c.bpm = 60000.0 / beat;
                    }
                }
            }
            "HitObjects" => {
                let f: Vec<&str> = line.split(',').collect();
                let (Some(x), Some(y), Some(t), Some(ty)) = (
                    f.first().and_then(|s| s.trim().parse::<f64>().ok()),
                    f.get(1).and_then(|s| s.trim().parse::<f64>().ok()),
                    f.get(2).and_then(|s| s.trim().parse::<f64>().ok()),
                    f.get(3).and_then(|s| s.trim().parse::<u32>().ok()),
                ) else {
                    continue;
                };
                if ty & 8 != 0 {
                    continue; // 转盘：不要
                }
                let sound = f.get(4).and_then(|s| s.trim().parse::<u8>().ok()).unwrap_or(0);
                if ty & (1 | 2 | 128) != 0 {
                    c.hits.push(OsuHit { x, y, t: t / 1000.0, slider: ty & 2 != 0, sound });
                }
            }
            _ => {}
        }
    }
    // 老谱没写 ApproachRate：和 OverallDifficulty 一样
    if c.ar.is_nan() {
        c.ar = c.od;
    }
    c.hits.sort_by(|a, b| a.t.total_cmp(&b.t));
    c
}

pub fn load(path: &Path) -> Result<OsuChart, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    Ok(parse(&text))
}

/// 文件夹里所有 .osu 文件（按文件名排）
pub fn files_in(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("osu"))).collect())
        .unwrap_or_default();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title:WHITE NIGHT
Artist:HOYO-MiX
Creator:Someone
Version:Easy

[Difficulty]
CircleSize:4
OverallDifficulty:5
ApproachRate:9

[Events]
//Background and Video events
Video,-70,\"video.mp4\"
0,0,\"bg.jpg\",0,0

[TimingPoints]
1591,500,4,2,1,40,1,0
2000,-100,4,2,1,40,0,0

[HitObjects]
256,192,3000,5,0,0:0:0:0:
100,50,1000,6,0,P|120:60|140:70,1,140,2|2,0:0|0:0,0:0:0:0:
256,192,4000,12,0,5000,0:0:0:0:
";

    #[test]
    fn parses_osu_standard() {
        let c = parse(SAMPLE);
        assert_eq!((c.title.as_str(), c.artist.as_str(), c.version.as_str(), c.audio.as_str()), ("WHITE NIGHT", "HOYO-MiX", "Easy", "audio.mp3"));
        assert_eq!(c.mode, 0);
        assert_eq!((c.cs, c.od, c.ar), (4.0, 5.0, 9.0));
        assert_eq!(c.background, "bg.jpg");
        assert!((c.bpm - 120.0).abs() < 1e-9);
        // 滑条只取起点；转盘不要；按时间排好
        assert_eq!(
            c.hits,
            vec![
                OsuHit { x: 100.0, y: 50.0, t: 1.0, slider: true, sound: 0 },
                OsuHit { x: 256.0, y: 192.0, t: 3.0, slider: false, sound: 0 }
            ]
        );
        // AR9 → 提前 0.6 秒；AR5 → 1.2 秒；AR0 → 1.8 秒
        assert!((c.preempt() - 0.6).abs() < 1e-9);
        assert!((OsuChart { ar: 5.0, ..Default::default() }.preempt() - 1.2).abs() < 1e-9);
        assert!((OsuChart { ar: 0.0, ..Default::default() }.preempt() - 1.8).abs() < 1e-9);
    }

    #[test]
    fn reads_hitsound_and_mania_holds() {
        // 太鼓：第 5 列是 hitSound；mania：type 128 是长按，也要（只取起点）
        let c = parse("[HitObjects]\n256,192,1000,1,8,0:0:0:0:\n64,192,2000,128,0,2500:0:0:0:0:\n");
        assert_eq!(c.hits.len(), 2);
        assert_eq!(c.hits[0].sound, 8);
        assert_eq!((c.hits[1].x, c.hits[1].t), (64.0, 2.0));
    }

    #[test]
    fn missing_ar_uses_od_and_reads_mania_mode() {
        let c = parse("[General]\nMode: 3\n[Difficulty]\nOverallDifficulty:7\n");
        assert_eq!(c.mode, 3);
        assert_eq!(c.ar, 7.0);
    }
}
