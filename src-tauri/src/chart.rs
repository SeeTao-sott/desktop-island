//! 音游：读 BeatSaver 下载的谱（zip 解压后的文件夹）。
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
    /// Easy / Normal / Hard / Expert / ExpertPlus
    pub name: String,
    pub file: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SongInfo {
    /// 文件夹名，用来指认这首歌
    pub id: String,
    pub title: String,
    pub sub_title: String,
    pub artist: String,
    pub mapper: String,
    pub bpm: f64,
    /// 老格式的整体偏移（秒），一般是 0
    pub offset: f64,
    pub difficulties: Vec<Difficulty>,
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
        title: String::new(),
        sub_title: String::new(),
        artist: String::new(),
        mapper: String::new(),
        bpm: 120.0,
        offset: 0.0,
        difficulties: Vec::new(),
    };
    if let Some(song) = v.get("song") {
        // v4
        info.title = s(song, "title");
        info.sub_title = s(song, "subTitle");
        info.artist = s(song, "author");
        if let Some(audio) = v.get("audio") {
            info.bpm = f(audio, "bpm").unwrap_or(120.0);
        }
        for d in arr(v, "difficultyBeatmaps") {
            info.difficulties.push(Difficulty {
                characteristic: s(d, "characteristic"),
                name: s(d, "difficulty"),
                file: s(d, "beatmapDataFilename"),
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
        for set in arr(v, "_difficultyBeatmapSets") {
            let ch = s(set, "_beatmapCharacteristicName");
            for d in arr(set, "_difficultyBeatmaps") {
                info.difficulties.push(Difficulty {
                    characteristic: ch.clone(),
                    name: s(d, "_difficulty"),
                    file: s(d, "_beatmapFilename"),
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

/// 读一首歌的 Info.dat
pub fn load_info(dir: &Path) -> Result<SongInfo, String> {
    let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let path = find_file(dir, "Info.dat").ok_or_else(|| format!("{} 里没有 Info.dat", dir.display()))?;
    Ok(parse_info(&id, &read_json(&path)?))
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

/// 解析一个难度的谱文件，返回按时间排好的音符
pub fn parse_notes(v: &Value, bpm: f64, offset: f64) -> Vec<Note> {
    let mut beats: Vec<(f64, u8)> = Vec::new();
    let mut changes: Vec<(f64, f64)> = Vec::new();

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
        // 变速：老工具写在 _customData._BPMChanges；新一点的写成 100 号事件
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
        for e in arr(v, "bpmEvents") {
            if let (Some(b), Some(m)) = (f(e, "b"), f(e, "m")) {
                changes.push((b, m));
            }
        }
    }

    let tempo = Tempo::new(bpm, changes);
    let mut notes: Vec<Note> = beats.into_iter().map(|(b, lane)| Note { t: tempo.seconds(b) + offset, lane }).collect();
    notes.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.lane.cmp(&b.lane)));
    // 同一条轨道、同一时刻叠着两个方块（上下两层）只算一个：按一次键就够
    notes.dedup_by(|b, a| a.lane == b.lane && (b.t - a.t).abs() < 0.001);
    notes
}

/// 读某首歌某个难度的音符
pub fn load_notes(dir: &Path, info: &SongInfo, diff: &Difficulty) -> Result<Vec<Note>, String> {
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
        let songs = list_songs(&root);
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
