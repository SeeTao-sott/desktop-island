//! 音游：读谱：BeatSaver 下载的谱（zip 解压后的文件夹，有 Info.dat），
//! 也认 osu! 谱（.osz 改成 .zip 解压，文件夹里有 .osu；解析在 osu.rs）。
//!
//! 一首歌一个文件夹，里面有 Info.dat（歌名、歌手、BPM、难度列表）和每个难度一个谱文件。
//! 谱文件有三种写法，这里都认：
//!   v2：_notes 里每个音符 {_time 拍数, _lineIndex 列, _type 0红/1蓝/3炸弹}
//!   v3：colorNotes 里每个音符 {b 拍数, x 列}，炸弹单独放在 bombNotes
//!   v4：colorNotes 里只有 {b 拍数, i 序号}，列写在 colorNotesData[i].x
//! 我们只要两样：什么时候（秒）、哪条轨道（0~3，按列 lineIndex 一一对应）。炸弹不要。
//!
//! 拍数换成秒要看 BPM：中途变速的谱会带 BPM 变化（v3 的 bpmEvents、v2 的 _BPMChanges 或 100 号事件），
//! 每一段按自己的 BPM 算再加起来。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Difficulty {
    /// 谱的类型，一般是 "Standard"（还有 OneSaber、NoArrows 等）
    pub characteristic: String,
    /// Easy / Normal / Hard / Expert / ExpertPlus；osu! 是难度名（Version）
    pub name: String,
    pub file: String,
    /// 不能玩的原因（比如"mania，暂不支持"）；空 = 能玩
    pub note: String,
    /// 靶子数量（osu! 谱读的时候就数好；BeatSaver 是 0 = 没数）
    pub count: usize,
    /// 在难度按钮上额外标出的玩法（"太鼓"、"接水果"、"mania 4K"）；空 = 不用标
    pub tag: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SongInfo {
    /// 文件夹名，用来指认这首歌
    pub id: String,
    /// "beatsaver" 或 "osu"
    pub format: String,
    pub title: String,
    pub sub_title: String,
    pub artist: String,
    pub mapper: String,
    pub bpm: f64,
    /// 老格式的整体偏移（秒），一般是 0
    pub offset: f64,
    pub difficulties: Vec<Difficulty>,
    /// 歌曲音频文件名（一般是 song.egg，其实就是 ogg）；空 = 没有
    pub song_file: String,
    /// 封面图片文件名（一般是 cover.png / cover.jpg）；空 = 没有
    pub cover_file: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Note {
    /// 从歌开头算起的秒数
    pub t: f64,
    /// 轨道 0~3（从左到右）
    pub lane: u8,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// 找文件时不区分大小写（有的谱写 info.dat）
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(name))
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    // 有的文件开头带 BOM
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{} 格式不对：{e}", path.display()))
}

/// 解析 Info.dat（v2 的 _songName… 和 v4 的 song.title… 两种写法）
pub fn parse_info(id: &str, v: &Value) -> SongInfo {
    let mut info = SongInfo {
        id: id.to_string(),
        format: "beatsaver".into(),
        title: String::new(),
        sub_title: String::new(),
        artist: String::new(),
        mapper: String::new(),
        bpm: 120.0,
        offset: 0.0,
        difficulties: Vec::new(),
        song_file: String::new(),
        cover_file: String::new(),
    };
    if let Some(song) = v.get("song") {
        // v4
        info.title = s(song, "title");
        info.sub_title = s(song, "subTitle");
        info.artist = s(song, "author");
        if let Some(audio) = v.get("audio") {
            info.bpm = f(audio, "bpm").unwrap_or(120.0);
            info.song_file = s(audio, "songFilename");
            info.cover_file = s(v, "coverImageFilename");
        }
        for d in arr(v, "difficultyBeatmaps") {
            info.difficulties.push(Difficulty {
                characteristic: s(d, "characteristic"),
                name: s(d, "difficulty"),
                file: s(d, "beatmapDataFilename"),
                note: String::new(),
                count: 0,
                tag: String::new(),
            });
            if info.mapper.is_empty() {
                let authors = d.get("beatmapAuthors").map(|a| arr(a, "mappers")).unwrap_or(&[]);
                info.mapper = authors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
            }
        }
    } else {
        // v2（v3 的 Info.dat 和 v2 一样）
        info.title = s(v, "_songName");
        info.sub_title = s(v, "_songSubName");
        info.artist = s(v, "_songAuthorName");
        info.mapper = s(v, "_levelAuthorName");
        info.bpm = f(v, "_beatsPerMinute").unwrap_or(120.0);
        info.offset = f(v, "_songTimeOffset").unwrap_or(0.0);
        info.song_file = s(v, "_songFilename");
        info.cover_file = s(v, "_coverImageFilename");
        for set in arr(v, "_difficultyBeatmapSets") {
            let ch = s(set, "_beatmapCharacteristicName");
            for d in arr(set, "_difficultyBeatmaps") {
                info.difficulties.push(Difficulty {
                    characteristic: ch.clone(),
                    name: s(d, "_difficulty"),
                    file: s(d, "_beatmapFilename"),
                    note: String::new(),
                    count: 0,
                    tag: String::new(),
                });
            }
        }
    }
    if !(info.bpm.is_finite() && info.bpm > 0.0) {
        info.bpm = 120.0;
    }
    if info.title.is_empty() {
        info.title = id.to_string();
    }
    info
}

/// 读一首歌：有 Info.dat 是 BeatSaver，有 .osu 是 osu!
pub fn load_info(dir: &Path) -> Result<SongInfo, String> {
    let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if let Some(path) = find_file(dir, "Info.dat") {
        return Ok(parse_info(&id, &read_json(&path)?));
    }
    let files = crate::osu::files_in(dir);
    if !files.is_empty() {
        return Ok(osu_info(&id, &files));
    }
    Err(format!("{} 里既没有 Info.dat 也没有 .osu", dir.display()))
}

/// osu! 谱：每个 .osu 是一个难度。歌名、歌手、音频、BPM、背景取第一个 standard 难度的
fn osu_info(id: &str, files: &[PathBuf]) -> SongInfo {
    let charts: Vec<(String, crate::osu::OsuChart)> = files
        .iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?.to_string();
            crate::osu::load(p).map_err(|e| eprintln!("跳过这个难度：{e}")).ok().map(|c| (name, c))
        })
        .collect();
    let main = charts.iter().find(|(_, c)| c.mode == 0).or(charts.first()).map(|(_, c)| c.clone()).unwrap_or_default();
    let mut info = SongInfo {
        id: id.to_string(),
        format: "osu".into(),
        title: if main.title.is_empty() { id.to_string() } else { main.title.clone() },
        sub_title: String::new(),
        artist: main.artist.clone(),
        mapper: main.creator.clone(),
        bpm: if main.bpm > 0.0 { main.bpm } else { 120.0 },
        offset: 0.0,
        difficulties: Vec::new(),
        song_file: main.audio.clone(),
        cover_file: main.background.clone(),
    };
    for (file, c) in &charts {
        let (characteristic, note, tag) = match c.mode {
            0 => ("osu", String::new(), String::new()),
            1 => ("osu-taiko", String::new(), "太鼓".to_string()),
            2 => ("osu-catch", String::new(), "接水果".to_string()),
            3 => ("osu-mania", String::new(), format!("mania {}K", mania_keys(c))),
            m => ("osu-other", format!("模式 {m}，不认识"), String::new()),
        };
        info.difficulties.push(Difficulty {
            characteristic: characteristic.into(),
            name: if c.version.is_empty() { file.clone() } else { c.version.clone() },
            file: file.clone(),
            note,
            count: c.hits.len(),
            tag,
        });
    }
    info
}

/// 读这首歌的音频文件。文件名来自 Info.dat，只认这首歌文件夹里直接放着的文件（不跟着 ..、子路径跑出去）
pub fn load_audio(dir: &Path, info: &SongInfo) -> Result<Vec<u8>, String> {
    load_named(dir, &info.song_file)
}

/// 读这首歌的封面，返回 (字节, MIME 类型)
pub fn load_cover(dir: &Path, info: &SongInfo) -> Result<(Vec<u8>, &'static str), String> {
    let bytes = load_named(dir, &info.cover_file)?;
    let lower = info.cover_file.to_ascii_lowercase();
    let mime = if lower.ends_with(".png") { "image/png" } else if lower.ends_with(".webp") { "image/webp" } else { "image/jpeg" };
    Ok((bytes, mime))
}

/// 读歌曲文件夹里直接放着的某个文件（名字来自 Info.dat；不跟着 ..、子路径跑出去）
fn load_named(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') {
        return Err("Info.dat 里没有写这个文件，或者文件名不对".into());
    }
    let path = find_file(dir, name).ok_or_else(|| format!("找不到文件 {name}"))?;
    fs::read(&path).map_err(|e| format!("读不了 {}：{e}", path.display()))
}

/// 列出 charts/ 里所有能读的歌（读不了的跳过并说明原因）
pub fn list_songs(root: &Path) -> Vec<SongInfo> {
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.iter()
        .filter_map(|d| load_info(d).map_err(|e| eprintln!("跳过这首歌：{e}")).ok())
        .collect()
}

/// 拍数 → 秒的换算表：每段 (起始拍, 起始秒, BPM)
struct Tempo(Vec<(f64, f64, f64)>);

impl Tempo {
    /// changes：(在第几拍, 变成多少 BPM)，拍数按变速前的节奏数
    fn new(bpm: f64, mut changes: Vec<(f64, f64)>) -> Tempo {
        changes.retain(|(b, m)| b.is_finite() && *b >= 0.0 && m.is_finite() && *m > 0.0);
        changes.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut segs = vec![(0.0, 0.0, bpm)];
        for (b, m) in changes {
            let &(b0, t0, m0) = segs.last().unwrap();
            if b <= b0 {
                // 同一拍上的变速：直接改这一段
                segs.last_mut().unwrap().2 = m;
            } else {
                segs.push((b, t0 + (b - b0) * 60.0 / m0, m));
            }
        }
        Tempo(segs)
    }

    fn seconds(&self, beat: f64) -> f64 {
        let i = self.0.partition_point(|s| s.0 <= beat).max(1) - 1;
        let (b0, t0, m) = self.0[i];
        t0 + (beat - b0) * 60.0 / m
    }
}

/// 列号 → 轨道。Mapping Extensions 的精确位置写成 ≥1000 或 ≤-1000，换回普通列号
fn lane_of(x: f64) -> u8 {
    let x = if x >= 1000.0 {
        (x - 1000.0) / 1000.0
    } else if x <= -1000.0 {
        (x + 1000.0) / 1000.0
    } else {
        x
    };
    x.round().clamp(0.0, 3.0) as u8
}

/// 谱里的变速：v2 老工具写在 _customData._BPMChanges、新一点的写成 100 号事件；v3 是 bpmEvents
fn bpm_changes(v: &Value) -> Vec<(f64, f64)> {
    let mut changes = Vec::new();
    if let Some(cd) = v.get("_customData") {
        for c in arr(cd, "_BPMChanges").iter().chain(arr(cd, "_bpmChanges")) {
            if let (Some(b), Some(m)) = (f(c, "_time"), f(c, "_BPM").or_else(|| f(c, "_bpm"))) {
                changes.push((b, m));
            }
        }
    }
    for e in arr(v, "_events") {
        if f(e, "_type") == Some(100.0) {
            if let (Some(b), Some(m)) = (f(e, "_time"), f(e, "_floatValue")) {
                changes.push((b, m));
            }
        }
    }
    for e in arr(v, "bpmEvents") {
        if let (Some(b), Some(m)) = (f(e, "b"), f(e, "m")) {
            changes.push((b, m));
        }
    }
    changes
}

/// 裂缝射击用的音符：时间、列（lineIndex 0~3）、层（lineLayer 0~2，下到上）、颜色（0 红 1 蓝）
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Shot {
    pub t: f64,
    pub x: u8,
    pub y: u8,
    pub c: u8,
}

/// 解析裂缝射击要的音符：只要红蓝方块（v3 的 arc 两头本来就是方块，照样算）；
/// 炸弹、墙、arc 本身、链条（burstSliders）全部忽略
pub fn parse_shots(v: &Value, bpm: f64, offset: f64) -> Vec<Shot> {
    let mut raw: Vec<(f64, u8, u8, u8)> = Vec::new();
    let layer = |y: f64| y.round().clamp(0.0, 2.0) as u8;
    if v.get("_notes").is_some() {
        for n in arr(v, "_notes") {
            let ty = f(n, "_type").unwrap_or(-1.0) as i64;
            if ty == 0 || ty == 1 {
                if let (Some(b), Some(x)) = (f(n, "_time"), f(n, "_lineIndex")) {
                    raw.push((b, lane_of(x), layer(f(n, "_lineLayer").unwrap_or(0.0)), ty as u8));
                }
            }
        }
    } else {
        let data = arr(v, "colorNotesData");
        for n in arr(v, "colorNotes") {
            let d = match f(n, "i") {
                Some(i) => data.get(i as usize),
                None => Some(n),
            };
            let Some(d) = d else { continue };
            if let (Some(b), Some(x)) = (f(n, "b"), f(d, "x")) {
                let c = f(d, "c").unwrap_or(0.0).clamp(0.0, 1.0) as u8;
                raw.push((b.max(0.0), lane_of(x), layer(f(d, "y").unwrap_or(0.0)), c));
            }
        }
    }
    let tempo = Tempo::new(bpm, bpm_changes(v));
    let mut out: Vec<Shot> = raw.into_iter().map(|(b, x, y, c)| Shot { t: tempo.seconds(b) + offset, x, y, c }).collect();
    out.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.c.cmp(&b.c)).then(a.x.cmp(&b.x)));
    out
}

/// osu! 的靶子换成和 BeatSaver 一样的音符，后面排靶子、高潮检测、判定全部照旧。
/// 颜色（红 0 / 蓝 1）、半边里的列（lineIndex 0~3）、层（lineLayer 下 0 ~ 上 2）按模式来：
///   standard：x 左半边红、右半边蓝，各自那半边再分 4 列；y 分 3 层（上方 = 上层）
///   taiko：红蓝就是鼓面 / 鼓边；谱里没有位置，列和层按固定随机慢慢走（每次玩都一样）；大音符变成同色的一对
///   catch：x 和 standard 一样；没有上下，层按固定随机慢慢走
///   mania：左半边的轨是红、右半边是蓝，再按轨细分列；层按固定随机慢慢走
/// 时间已经是从歌开头算的秒数，直接用。
/// 除了 mania，osu! 没有真正同时的两个音符，但常有挨得很近的：前后两个相差不到 OSU_PAIR 秒就配成一对，
/// 后一个的时间对齐到前一个 → 变成"同时出现的一组"（金色、连线、右键一起打）。每次只两两配对。
/// mania 本来就有真正的和弦，不另外配对
pub const OSU_PAIR: f64 = 0.2;

/// mania 的键数（CircleSize），1~18
pub fn mania_keys(chart: &crate::osu::OsuChart) -> u32 {
    (chart.cs.round() as u32).clamp(1, 18)
}

/// mania：x → 第几轨（0 ~ 键数-1）
fn mania_col(x: f64, keys: u32) -> u32 {
    ((x.clamp(0.0, 511.0) * keys as f64 / 512.0).floor() as u32).min(keys - 1)
}

/// 太鼓：鼓边（whistle 或 clap）是蓝，其余是红；finish 是大音符
fn taiko_kind(sound: u8) -> (u8, bool) {
    (if sound & (2 | 8) != 0 { 1 } else { 0 }, sound & 4 != 0)
}

/// 固定随机（splitmix64）：谱一样，每次出来的位置就一样
struct Walk(u64);

impl Walk {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// 从 v 往旁边走一步或不动（各 2/5 往左右、1/5 不动），夹在 0..=max
    fn step(&mut self, v: u8, max: u8) -> u8 {
        let d = ((self.next() % 5) as i32 - 2).signum();
        (v as i32 + d).clamp(0, max as i32) as u8
    }
}

/// 按 x 的比例（0~1）分红蓝、在那半边里细分列
fn by_x(u: f64) -> (u8, u8) {
    let c = if u < 0.5 { 0 } else { 1 };
    let v = if c == 0 { u / 0.5 } else { (u - 0.5) / 0.5 };
    (c, (v * 4.0).floor().clamp(0.0, 3.0) as u8)
}

pub fn osu_shots(chart: &crate::osu::OsuChart) -> Vec<Shot> {
    let mut walk = Walk(chart.hits.len() as u64 ^ (chart.hits.first().map_or(0, |h| (h.t * 1000.0) as u64) << 16));
    // 没有位置信息的模式：每种颜色各自记着上一个的列和层，慢慢走，免得满屏乱跳
    let mut pos = [(1u8, 1u8), (2u8, 1u8)];
    let keys = mania_keys(chart);
    let mut out: Vec<Shot> = Vec::with_capacity(chart.hits.len());
    for h in &chart.hits {
        match chart.mode {
            1 => {
                let (c, big) = taiko_kind(h.sound);
                let p = &mut pos[c as usize];
                p.0 = walk.step(p.0, 3);
                p.1 = walk.step(p.1, 2);
                out.push(Shot { t: h.t, x: p.0, y: p.1, c });
                if big {
                    // 大音符：同一时刻再来一个同色的，变成金色的一对
                    out.push(Shot { t: h.t, x: p.0, y: p.1, c });
                }
            }
            2 | 3 => {
                let u = if chart.mode == 3 { (mania_col(h.x, keys) as f64 + 0.5) / keys as f64 } else { h.x.clamp(0.0, 512.0) / 512.0 };
                // 单数键的中间那一轨正好在中线上：红蓝随机
                let (c, lane) = if (u - 0.5).abs() < 1e-9 { ((walk.next() % 2) as u8, 0) } else { by_x(u) };
                let p = &mut pos[c as usize];
                p.1 = walk.step(p.1, 2);
                out.push(Shot { t: h.t, x: lane, y: p.1, c });
            }
            _ => {
                let (c, lane) = by_x(h.x.clamp(0.0, 512.0) / 512.0);
                let row = (h.y.clamp(0.0, 384.0) / 384.0 * 3.0).floor().clamp(0.0, 2.0) as u8;
                out.push(Shot { t: h.t, x: lane, y: 2 - row, c });
            }
        }
    }
    out.sort_by(|a, b| a.t.total_cmp(&b.t));
    if chart.mode != 3 {
        let mut i = 0;
        while i + 1 < out.len() {
            if out[i + 1].t - out[i].t <= OSU_PAIR {
                out[i + 1].t = out[i].t;
                i += 2;
            } else {
                i += 1;
            }
        }
    }
    out.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.c.cmp(&b.c)).then(a.x.cmp(&b.x)));
    out
}

/// osu! 换成下落 4 键的音符：
///   mania：4 键一轨对一轨；其他键数按比例并成 4 轨
///   taiko：红（鼓面）在中间两轨、蓝（鼓边）在两边，左右轮流（像街机 D F J K）；大音符两只手一起
///   standard、catch：x 平均分 4 轨
pub fn osu_notes(chart: &crate::osu::OsuChart) -> Vec<Note> {
    let keys = mania_keys(chart);
    let mut flip = [false, false];
    let mut notes: Vec<Note> = Vec::with_capacity(chart.hits.len());
    for h in &chart.hits {
        match chart.mode {
            1 => {
                let (c, big) = taiko_kind(h.sound);
                let pair = if c == 0 { [1, 2] } else { [0, 3] };
                if big {
                    notes.extend(pair.map(|lane| Note { t: h.t, lane }));
                } else {
                    let f = &mut flip[c as usize];
                    notes.push(Note { t: h.t, lane: pair[*f as usize] });
                    *f = !*f;
                }
            }
            3 => notes.push(Note { t: h.t, lane: (mania_col(h.x, keys) * 4 / keys).min(3) as u8 }),
            _ => notes.push(Note { t: h.t, lane: (h.x / 128.0).floor().clamp(0.0, 3.0) as u8 }),
        }
    }
    notes.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.lane.cmp(&b.lane)));
    notes.dedup_by(|b, a| a.lane == b.lane && (b.t - a.t).abs() < 0.001);
    notes
}

/// 读 osu! 的某个难度（不认识的模式直接说不支持）
fn load_osu(dir: &Path, diff: &Difficulty) -> Result<crate::osu::OsuChart, String> {
    if !diff.note.is_empty() {
        return Err(diff.note.clone());
    }
    let path = find_file(dir, &diff.file).ok_or_else(|| format!("找不到谱文件 {}", diff.file))?;
    crate::osu::load(&path)
}

/// 读某首歌某个难度的裂缝射击音符
pub fn load_shots(dir: &Path, info: &SongInfo, diff: &Difficulty) -> Result<Vec<Shot>, String> {
    if info.format == "osu" {
        return Ok(osu_shots(&load_osu(dir, diff)?));
    }
    let path = find_file(dir, &diff.file).ok_or_else(|| format!("找不到谱文件 {}", diff.file))?;
    let v = read_json(&path)?;
    Ok(parse_shots(&v, info.bpm, info.offset))
}

/// 解析一个难度的谱文件，返回按时间排好的音符
pub fn parse_notes(v: &Value, bpm: f64, offset: f64) -> Vec<Note> {
    let mut beats: Vec<(f64, u8)> = Vec::new();

    if v.get("_notes").is_some() {
        // v2：_type 3 是炸弹，不要；0、1 是红蓝方块
        for n in arr(v, "_notes") {
            let ty = f(n, "_type").unwrap_or(0.0) as i64;
            if ty == 0 || ty == 1 {
                if let (Some(b), Some(x)) = (f(n, "_time"), f(n, "_lineIndex")) {
                    beats.push((b, lane_of(x)));
                }
            }
        }
    } else {
        // v3 / v4。v4 的列在 colorNotesData[i] 里
        let data = arr(v, "colorNotesData");
        for n in arr(v, "colorNotes") {
            let x = match f(n, "i") {
                Some(i) => data.get(i as usize).and_then(|d| f(d, "x")),
                None => f(n, "x"),
            };
            if let (Some(b), Some(x)) = (f(n, "b"), x) {
                beats.push((b.max(0.0), lane_of(x)));
            }
        }
        // 链条（burstSliders）的头也要打；v3 里链条头不在 colorNotes 里
        for n in arr(v, "burstSliders") {
            if let (Some(b), Some(x)) = (f(n, "b"), f(n, "x")) {
                beats.push((b, lane_of(x)));
            }
        }
    }

    let tempo = Tempo::new(bpm, bpm_changes(v));
    let mut notes: Vec<Note> = beats.into_iter().map(|(b, lane)| Note { t: tempo.seconds(b) + offset, lane }).collect();
    notes.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.lane.cmp(&b.lane)));
    // 同一条轨道、同一时刻叠着两个方块（上下两层）只算一个：按一次键就够
    notes.dedup_by(|b, a| a.lane == b.lane && (b.t - a.t).abs() < 0.001);
    notes
}

/// 读某首歌某个难度的音符
pub fn load_notes(dir: &Path, info: &SongInfo, diff: &Difficulty) -> Result<Vec<Note>, String> {
    if info.format == "osu" {
        return Ok(osu_notes(&load_osu(dir, diff)?));
    }
    let path = find_file(dir, &diff.file).ok_or_else(|| format!("找不到谱文件 {}", diff.file))?;
    let v = read_json(&path)?;
    // v4 的变速写在单独的音频数据文件里（audio.audioDataFilename），这里只用 Info 里的 BPM
    Ok(parse_notes(&v, info.bpm, info.offset))
}

/// charts/ 文件夹：从程序所在位置往上找（开发时程序在 src-tauri/target/release 里）
pub fn charts_dir() -> Option<PathBuf> {
    let starts = [std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)), std::env::current_dir().ok()];
    for start in starts.into_iter().flatten() {
        for dir in start.ancestors() {
            let c = dir.join("charts");
            if c.is_dir() {
                return Some(c);
            }
        }
    }
    None
}

/// 每首歌各自的设置，存在配置文件夹的 rhythm-offsets.json：
/// { "文件夹名": { "offset_ms": 偏移毫秒, "speed": 下落速度倍数 } }。老文件里直接是数字（只有偏移），照样认
pub fn load_offsets(path: &Path) -> serde_json::Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 某首歌的 (偏移毫秒, 速度倍数)；没设过是 (0, 1.0)
pub fn song_prefs(map: &serde_json::Map<String, Value>, id: &str) -> (i64, f64) {
    match map.get(id) {
        Some(Value::Number(n)) => (n.as_i64().unwrap_or(0), 1.0),
        Some(v @ Value::Object(_)) => (
            v.get("offset_ms").and_then(Value::as_i64).unwrap_or(0),
            v.get("speed").and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(1.0),
        ),
        _ => (0, 1.0),
    }
}

/// 改某首歌的偏移和 / 或速度（没给的保持原样）
pub fn save_prefs(path: &Path, id: &str, offset_ms: Option<i32>, speed: Option<f64>) -> std::io::Result<()> {
    let mut map = load_offsets(path);
    let (mut o, mut sp) = song_prefs(&map, id);
    if let Some(x) = offset_ms {
        o = x as i64;
    }
    if let Some(x) = speed {
        sp = x;
    }
    map.insert(id.to_string(), serde_json::json!({ "offset_ms": o, "speed": (sp * 10.0).round() / 10.0 }));
    let text = serde_json::to_string_pretty(&map).map_err(std::io::Error::other)?;
    // 先写临时文件再换名，写到一半断电也不会坏
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn v2_info_and_notes() {
        let info = parse_info(
            "x",
            &json!({
                "_songName": "Song", "_songAuthorName": "Artist", "_levelAuthorName": "Mapper",
                "_beatsPerMinute": 120.0, "_songTimeOffset": 0,
                "_difficultyBeatmapSets": [{ "_beatmapCharacteristicName": "Standard",
                    "_difficultyBeatmaps": [{ "_difficulty": "Expert", "_beatmapFilename": "ExpertStandard.dat" }] }]
            }),
        );
        assert_eq!((info.title.as_str(), info.artist.as_str(), info.bpm), ("Song", "Artist", 120.0));
        assert_eq!(info.difficulties[0].name, "Expert");
        let notes = parse_notes(
            &json!({ "_version": "2.2.0", "_notes": [
                { "_time": 2, "_lineIndex": 3, "_lineLayer": 0, "_type": 1 },
                { "_time": 1, "_lineIndex": 0, "_lineLayer": 0, "_type": 0 },
                { "_time": 1, "_lineIndex": 0, "_lineLayer": 2, "_type": 1 },
                { "_time": 1.5, "_lineIndex": 2, "_lineLayer": 0, "_type": 3 }
            ]}),
            info.bpm,
            0.0,
        );
        // 120 BPM：1 拍 = 0.5 秒；炸弹去掉；同轨同时的两个合成一个
        assert_eq!(notes, vec![Note { t: 0.5, lane: 0 }, Note { t: 1.0, lane: 3 }]);
    }

    #[test]
    fn v3_notes_with_bpm_change() {
        let notes = parse_notes(
            &json!({ "version": "3.3.0",
                "bpmEvents": [{ "b": 4, "m": 60 }],
                "colorNotes": [{ "b": 2, "x": 1, "y": 0, "c": 0, "d": 1 }, { "b": 6, "x": 2, "y": 0, "c": 1, "d": 1 }],
                "bombNotes": [{ "b": 3, "x": 0, "y": 0 }],
                "burstSliders": [{ "b": 5, "x": 3, "y": 0 }]
            }),
            120.0,
            0.0,
        );
        // 前 4 拍 120 BPM（2 秒），之后 60 BPM：第 5 拍 3 秒，第 6 拍 4 秒
        assert_eq!(notes.len(), 3);
        assert!(approx(notes[0].t, 1.0) && notes[0].lane == 1);
        assert!(approx(notes[1].t, 3.0) && notes[1].lane == 3);
        assert!(approx(notes[2].t, 4.0) && notes[2].lane == 2);
    }

    #[test]
    fn v4_info_and_notes() {
        let info = parse_info(
            "x",
            &json!({ "version": "4.0.0",
                "song": { "title": "T", "subTitle": "", "author": "A" },
                "audio": { "songFilename": "song.ogg", "bpm": 100 },
                "difficultyBeatmaps": [{ "characteristic": "Standard", "difficulty": "Hard",
                    "beatmapAuthors": { "mappers": ["M"] }, "beatmapDataFilename": "Hard.dat" }]
            }),
        );
        assert_eq!((info.title.as_str(), info.artist.as_str(), info.mapper.as_str(), info.bpm), ("T", "A", "M", 100.0));
        assert_eq!(info.difficulties[0].file, "Hard.dat");
        let notes = parse_notes(
            &json!({ "version": "4.0.0",
                "colorNotes": [{ "b": 10, "i": 1 }, { "b": 5, "i": 0 }],
                "colorNotesData": [{ "x": 0, "y": 0, "c": 0, "d": 1 }, { "x": 3, "y": 1, "c": 1, "d": 0 }]
            }),
            info.bpm,
            0.0,
        );
        assert_eq!(notes, vec![Note { t: 3.0, lane: 0 }, Note { t: 6.0, lane: 3 }]);
    }

    #[test]
    fn shots_keep_color_and_layer_skip_bombs_and_chains() {
        let v2 = parse_shots(
            &json!({ "_version": "2.2.0", "_notes": [
                { "_time": 2, "_lineIndex": 3, "_lineLayer": 2, "_type": 1 },
                { "_time": 1, "_lineIndex": 0, "_lineLayer": 0, "_type": 0 },
                { "_time": 1.5, "_lineIndex": 2, "_lineLayer": 1, "_type": 3 }
            ], "_obstacles": [{ "_time": 1, "_lineIndex": 0, "_duration": 2 }] }),
            120.0,
            0.0,
        );
        assert_eq!(v2, vec![Shot { t: 0.5, x: 0, y: 0, c: 0 }, Shot { t: 1.0, x: 3, y: 2, c: 1 }]);
        let v3 = parse_shots(
            &json!({ "version": "3.3.0",
                "colorNotes": [{ "b": 2, "x": 1, "y": 1, "c": 1, "d": 1 }],
                "bombNotes": [{ "b": 3, "x": 0, "y": 0 }],
                "burstSliders": [{ "b": 4, "x": 3, "y": 0, "c": 0 }],
                "sliders": [{ "b": 5, "x": 2, "y": 0, "c": 0, "tb": 6 }]
            }),
            120.0,
            0.0,
        );
        assert_eq!(v3, vec![Shot { t: 1.0, x: 1, y: 1, c: 1 }]);
        let v4 = parse_shots(
            &json!({ "version": "4.0.0",
                "colorNotes": [{ "b": 4, "i": 0 }],
                "colorNotesData": [{ "x": 2, "y": 2, "c": 0, "d": 1 }]
            }),
            60.0,
            0.0,
        );
        assert_eq!(v4, vec![Shot { t: 4.0, x: 2, y: 2, c: 0 }]);
    }

    #[test]
    fn osu_hits_become_shots() {
        use crate::osu::{OsuChart, OsuHit};
        let hit = |x: f64, y: f64, t: f64| OsuHit { x, y, t, ..Default::default() };
        let chart = OsuChart {
            hits: vec![hit(0.0, 0.0, 1.0), hit(255.0, 383.0, 2.0), hit(256.0, 192.0, 3.0), hit(512.0, 384.0, 4.0), hit(130.0, 200.0, 5.0)],
            ..Default::default()
        };
        assert_eq!(
            osu_shots(&chart),
            vec![
                // 左上角：红、半边里第 0 列、上层
                Shot { t: 1.0, x: 0, y: 2, c: 0 },
                // 左半边最右、最下：红、第 3 列、下层
                Shot { t: 2.0, x: 3, y: 0, c: 0 },
                // 正中间：蓝、第 0 列、中层
                Shot { t: 3.0, x: 0, y: 1, c: 1 },
                // 右下角（坐标在边上）：蓝、第 3 列、下层
                Shot { t: 4.0, x: 3, y: 0, c: 1 },
                Shot { t: 5.0, x: 2, y: 1, c: 0 },
            ]
        );
    }

    #[test]
    fn close_osu_hits_pair_up() {
        use crate::osu::{OsuChart, OsuHit};
        let hit = |x: f64, t: f64| OsuHit { x, y: 192.0, t, ..Default::default() };
        // 1.0 和 1.125 配成一对；1.25 和 1.375 再配一对；1.5 落单（不跟已经配好的连起来）；3.0 离得远
        let chart = OsuChart {
            hits: vec![hit(100.0, 1.0), hit(400.0, 1.125), hit(100.0, 1.25), hit(400.0, 1.375), hit(100.0, 1.5), hit(400.0, 3.0)],
            ..Default::default()
        };
        let times: Vec<f64> = osu_shots(&chart).iter().map(|s| s.t).collect();
        assert_eq!(times, vec![1.0, 1.0, 1.25, 1.25, 1.5, 3.0]);
    }

    #[test]
    fn mania_columns_and_lanes() {
        use crate::osu::{OsuChart, OsuHit};
        // 4K：x 64 / 192 / 320 / 448 是第 0~3 轨；同一时刻两轨是和弦（mania 不另外配对）
        let hit = |x: f64, t: f64| OsuHit { x, y: 192.0, t, ..Default::default() };
        let chart = OsuChart {
            mode: 3,
            cs: 4.0,
            hits: vec![hit(64.0, 1.0), hit(448.0, 1.0), hit(192.0, 1.1), hit(320.0, 1.2)],
            ..Default::default()
        };
        let lanes: Vec<u8> = osu_notes(&chart).iter().map(|n| n.lane).collect();
        assert_eq!(lanes, vec![0, 3, 1, 2]);
        // 左两轨红、右两轨蓝；时间不变（相差 0.1 秒的也不配对）
        let shots = osu_shots(&chart);
        assert_eq!(shots.iter().map(|s| (s.t, s.c)).collect::<Vec<_>>(), vec![(1.0, 0), (1.0, 1), (1.1, 0), (1.2, 1)]);
        assert!(shots.iter().all(|s| s.x <= 3 && s.y <= 2));
        // 7K 下落：并成 4 轨
        let seven = OsuChart {
            mode: 3,
            cs: 7.0,
            hits: (0..7).map(|k| hit(k as f64 * 512.0 / 7.0 + 10.0, k as f64)).collect(),
            ..Default::default()
        };
        assert_eq!(osu_notes(&seven).iter().map(|n| n.lane).collect::<Vec<_>>(), vec![0, 0, 1, 1, 2, 2, 3]);
        // 7K 射击：中间那轨红蓝随机，其余左红右蓝
        let c7: Vec<u8> = osu_shots(&seven).iter().map(|s| s.c).collect();
        assert_eq!((&c7[..3], &c7[4..]), (&[0, 0, 0][..], &[1, 1, 1][..]));
    }

    #[test]
    fn taiko_colors_and_big_notes() {
        use crate::osu::{OsuChart, OsuHit};
        let hit = |sound: u8, t: f64| OsuHit { x: 256.0, y: 192.0, t, sound, ..Default::default() };
        // don、ka（clap）、ka（whistle）、大 don（finish）
        let chart = OsuChart { mode: 1, hits: vec![hit(0, 1.0), hit(8, 2.0), hit(2, 3.0), hit(4, 4.0)], ..Default::default() };
        let shots = osu_shots(&chart);
        assert_eq!(shots.iter().map(|s| (s.t, s.c)).collect::<Vec<_>>(), vec![(1.0, 0), (2.0, 1), (3.0, 1), (4.0, 0), (4.0, 0)]);
        assert!(shots.iter().all(|s| s.x <= 3 && s.y <= 2));
        // 同一张谱每次排出来一样
        assert_eq!(osu_shots(&chart), shots);
        // 下落：红在中间两轨（1、2 轮流），蓝在两边（0、3 轮流），大音符两轨一起
        let lanes: Vec<(f64, u8)> = osu_notes(&chart).iter().map(|n| (n.t, n.lane)).collect();
        assert_eq!(lanes, vec![(1.0, 1), (2.0, 0), (3.0, 3), (4.0, 1), (4.0, 2)]);
    }

    #[test]
    fn catch_uses_x_only() {
        use crate::osu::{OsuChart, OsuHit};
        let hit = |x: f64, t: f64| OsuHit { x, y: 0.0, t, ..Default::default() };
        let chart = OsuChart { mode: 2, hits: vec![hit(10.0, 1.0), hit(500.0, 2.0)], ..Default::default() };
        let shots = osu_shots(&chart);
        assert_eq!(shots.iter().map(|s| (s.c, s.x)).collect::<Vec<_>>(), vec![(0, 0), (1, 3)]);
    }

    #[test]
    fn mapping_extensions_lanes() {
        assert_eq!(lane_of(1000.0), 0);
        assert_eq!(lane_of(4000.0), 3);
        assert_eq!(lane_of(9000.0), 3);
        assert_eq!(lane_of(2.0), 2);
    }

    /// 读 charts/ 里真实的谱，打印每首歌的信息和前 20 个音符：
    /// cargo test --release print_charts -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_charts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../charts");
        let songs: Vec<SongInfo> = list_songs(&root).into_iter().filter(|s| s.format == "beatsaver").collect();
        assert!(!songs.is_empty(), "charts/ 里没有歌");
        for song in songs {
            println!("\n《{}》{} — {}（谱师 {}）", song.title, song.sub_title, song.artist, song.mapper);
            println!("BPM {}，偏移 {} 秒", song.bpm, song.offset);
            let dir = root.join(&song.id);
            for d in &song.difficulties {
                match load_notes(&dir, &song, d) {
                    Ok(n) => println!(
                        "  难度 {} / {}：{} 个音符，最后一个在 {:.2} 秒",
                        d.characteristic,
                        d.name,
                        n.len(),
                        n.last().map_or(0.0, |n| n.t)
                    ),
                    Err(e) => println!("  难度 {} / {}：{e}", d.characteristic, d.name),
                }
            }
            let d = song.difficulties.iter().find(|d| d.characteristic == "Standard").or(song.difficulties.first());
            if let Some(d) = d {
                let notes = load_notes(&dir, &song, d).unwrap();
                println!("\n  前 20 个音符（{} / {}）：", d.characteristic, d.name);
                println!("  序号    时间(秒)   轨道");
                for (i, n) in notes.iter().take(20).enumerate() {
                    println!("  {:>3}   {:>9.3}    {}  {}", i + 1, n.t, n.lane, ["■ . . .", ". ■ . .", ". . ■ .", ". . . ■"][n.lane as usize]);
                }
            }
        }
    }
}
