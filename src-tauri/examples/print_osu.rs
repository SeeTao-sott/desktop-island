//! 读 charts/ 里的 osu! 谱，打印每个难度的名称、靶子数量，再打印靶子最少那个难度的前 20 个靶子：
//!   cd src-tauri
//!   cargo run --example print_osu
//! 不走 cargo test：Windows 上 Tauri 程序的测试可执行文件缺应用清单，一启动就退出、什么都不打印。
//! 这里只借用 osu.rs、chart.rs 两个纯解析文件，不碰窗口相关的代码。
#![allow(dead_code)]

#[path = "../src/chart.rs"]
mod chart;
#[path = "../src/osu.rs"]
mod osu;

use std::path::Path;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../charts");
    let songs: Vec<chart::SongInfo> = chart::list_songs(&root).into_iter().filter(|s| s.format == "osu").collect();
    if songs.is_empty() {
        eprintln!("{} 里没有 osu! 谱（每首歌一个文件夹，.osu 文件直接放在文件夹里）", root.display());
        std::process::exit(1);
    }
    for song in songs {
        println!("\n《{}》— {}（谱师 {}）BPM {:.0}，音频 {}，背景 {}", song.title, song.artist, song.mapper, song.bpm, song.song_file, song.cover_file);
        let dir = root.join(&song.id);
        let mut fewest: Option<(usize, osu::OsuChart)> = None;
        for d in &song.difficulties {
            let c = match osu::load(&dir.join(&d.file)) {
                Ok(c) => c,
                Err(e) => {
                    println!("  {:<18} 读不了：{e}", d.name);
                    continue;
                }
            };
            let slider = c.hits.iter().filter(|h| h.slider).count();
            println!(
                "  {:<18} 模式 {}  靶子 {:>4} 个（圈 {}、滑条起点 {}）  CS {}  AR {}（提前 {:.2} 秒）  OD {}{}",
                d.name,
                c.mode,
                d.count,
                d.count - slider,
                slider,
                c.cs,
                c.ar,
                c.preempt(),
                c.od,
                if d.note.is_empty() { String::new() } else { format!("  [{}]", d.note) }
            );
            if d.note.is_empty() && fewest.as_ref().is_none_or(|(n, _)| d.count < *n) {
                fewest = Some((d.count, c));
            }
        }
        if let Some((_, c)) = fewest {
            println!("\n  前 20 个靶子（{}，靶子最少的难度）：", c.version);
            println!("  序号   时间(毫秒)     x      y    类型");
            for (i, h) in c.hits.iter().take(20).enumerate() {
                println!("  {:>3}   {:>9.0}   {:>4.0}   {:>4.0}   {}", i + 1, h.t * 1000.0, h.x, h.y, if h.slider { "滑条起点" } else { "圈" });
            }
            // 换成裂缝射击的靶子：同一时刻的两个是金色一对（mania 的和弦、太鼓大音符、相差不到 0.2 秒配成的一对）
            let shots = chart::osu_shots(&c);
            let gold = |i: usize| {
                let t = shots[i].t;
                (i > 0 && shots[i - 1].t == t) || shots.get(i + 1).is_some_and(|s| s.t == t)
            };
            let pairs = (0..shots.len()).filter(|&i| gold(i)).count() / 2;
            println!("\n  裂缝射击：{} 个靶子，其中同时出现（金色）{} 对；前 20 个：", shots.len(), pairs);
            println!("  序号   时间(毫秒)   颜色  列  层");
            for (i, s) in shots.iter().enumerate().take(20) {
                println!(
                    "  {:>3}   {:>9.0}    {}   {}   {}{}",
                    i + 1,
                    s.t * 1000.0,
                    if s.c == 0 { "红" } else { "蓝" },
                    s.x + 1,
                    ["下层", "中层", "上层"][s.y as usize],
                    if gold(i) { "  ★金色" } else { "" }
                );
            }
        }
    }
}
