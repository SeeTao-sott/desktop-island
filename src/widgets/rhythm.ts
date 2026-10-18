// 音游原型：双击律动（音频可视化）组件 → 选歌 → 下落式 4 键音游。
//
// 谱文件夹里带着歌（song.egg，其实是 ogg）时，游戏自己放：按空格后先留 1.5 秒让最早的音符落下来，
// 然后开始放歌，计时直接用"声音此刻真正从扬声器出来的位置"，和歌完全对齐。
// 没带歌的谱才退回老办法：你自己在浏览器里放，按空格那一刻开始计时。符号从灵动岛下面往下掉，
// 判定线就在律动组件的位置。按键靠窗口自己的键盘焦点收到（进音游时 Rust 让窗口拿焦点），
// 不用全局键盘钩子。所有移动都只用 transform，每帧只改位置不改布局。
import "./rhythm.css";
import { invoke } from "@tauri-apps/api/core";

interface Difficulty {
  characteristic: string;
  name: string;
  file: string;
  /** 不能玩的原因（比如"mania，暂不支持"）；空 = 能玩 */
  note: string;
  /** 靶子数量（osu! 谱有；BeatSaver 是 0） */
  count: number;
}
interface Song {
  id: string;
  /** "beatsaver" 或 "osu" */
  format: string;
  title: string;
  sub_title: string;
  artist: string;
  mapper: string;
  bpm: number;
  difficulties: Difficulty[];
  song_file: string;
  offset_ms: number;
  /** 下落速度倍数：1 = 提前 1.5 秒出现；2 = 提前 0.75 秒（落得快一倍） */
  speed: number;
}
interface Note {
  t: number;
  lane: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const KEYS = ["a", "s", "k", "l"];
const KEY_LABEL = ["A", "S", "K", "L"];
/** 速度 1 时提前多久出现（秒）；实际 = LEAD / 速度 */
const LEAD = 1.5;
/** 判定窗口（秒） */
const PERFECT = 0.07;
const GREAT = 0.13;
const MISS = 0.18;
const LANE_W = 110;
/** 音符高度 */
const NOTE_H = 30;
/** 灵动岛（收起时）的下边缘再往下一点 */
const SPAWN_Y = 56;
const DIFF_LABEL: Record<string, string> = {
  Easy: "简单",
  Normal: "普通",
  Hard: "困难",
  Expert: "专家",
  ExpertPlus: "专家+",
};
/** 难度按钮上的字：BeatSaver 换成中文；osu! 直接用谱里的难度名（Version） */
const diffLabel = (song: Song, d: Difficulty) => (song.format === "osu" ? d.name : (DIFF_LABEL[d.name] ?? d.name));

let root: HTMLElement | null = null;
/** 放歌用的音频环境，整个程序只建一个 */
let actx: AudioContext | null = null;
/** 解码过的歌，按歌缓存（再来一次、换难度不用重新解码） */
const decoded = new Map<string, AudioBuffer>();
let cleanup: (() => void) | null = null;

/** 现在是不是在音游里（选歌菜单也算） */
export const rhythmOpen = () => root !== null;

/** 双击律动组件：在它上方弹出选歌菜单 */
let opening = false;

export async function openRhythm(anchor: Rect) {
  // 自己判断的双击和浏览器的 dblclick 可能前后脚都来，只开一次
  if (root || opening) return;
  opening = true;
  const on = await invoke<boolean>("widgets_rhythm", { on: true }).catch(() => false);
  opening = false;
  if (!on || root) return;
  root = document.createElement("div");
  root.className = "rh-root";
  document.body.appendChild(root);
  showMenu(anchor);
}

/** 退出：拆掉界面，窗口沉回桌面层、恢复点击穿透、焦点还给原来的程序 */
// ---------------- 玩法选择 ----------------

type PlayMode = "fall" | "rift";
const MODE_KEY = "rhythm-mode";
function playMode(): PlayMode {
  try {
    return localStorage.getItem(MODE_KEY) === "rift" ? "rift" : "fall";
  } catch {
    return "fall";
  }
}
function setPlayMode(m: PlayMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // 记不住就算了
  }
}

/** 裂缝射击：先让小组件窗口退出音游模式（沉回桌面、交还焦点），再打开裂缝窗口 */
async function openRift(song: Song, diff: Difficulty) {
  cleanup?.();
  cleanup = null;
  root?.remove();
  root = null;
  await invoke("widgets_rhythm", { on: false }).catch(() => {});
  invoke("rift_open", { id: song.id, characteristic: diff.characteristic, difficulty: diff.name }).catch(() => {});
}

export function closeRhythm() {
  cleanup?.();
  cleanup = null;
  root?.remove();
  root = null;
  invoke("widgets_rhythm", { on: false }).catch(() => {});
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** 换一个界面：先清掉上一个界面挂的键盘、循环 */
function swap(fn: () => () => void) {
  cleanup?.();
  root!.replaceChildren();
  cleanup = fn();
}

// ---------------- 选歌菜单 ----------------

function showMenu(anchor: Rect) {
  swap(() => {
    // 几乎透明的底：接住"点外面"的点击（完全透明的地方鼠标会穿过去）
    const shade = el("div", "rh-shade", root!);
    // 点外面关闭：要在外面完整地按下再松开，而且刚弹出来的一小会儿不算
    // （双击的余波、窗口被激活时补发的鼠标事件，都不该把菜单马上关掉）
    const opened = performance.now();
    let downOnShade = false;
    shade.addEventListener("pointerdown", () => (downOnShade = performance.now() - opened > 300));
    shade.addEventListener("pointerup", () => {
      if (downOnShade) closeRhythm();
      downOnShade = false;
    });
    const card = el("div", "rh-menu", root!);
    el("div", "rh-menu-title", card, "选一首歌");
    // 玩法：下落式 4 键 / 裂缝射击（记住上次选的）
    const modes = el("div", "rh-modes", card);
    for (const [id, label] of [
      ["fall", "下落 4 键"],
      ["rift", "裂缝射击"],
    ] as const) {
      const b = el("button", "rh-mode" + (playMode() === id ? " on" : ""), modes, label);
      b.addEventListener("click", () => {
        setPlayMode(id);
        modes.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      });
    }
    const list = el("div", "rh-list", card);
    el("div", "rh-empty", list, "读取中…");

    // 放在律动组件正上方，水平居中，别超出屏幕
    const place = () => {
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const x = Math.min(Math.max(12, anchor.x + anchor.w / 2 - w / 2), window.innerWidth - w - 12);
      const y = Math.max(12, anchor.y - h - 12);
      card.style.transform = `translate(${x}px, ${y}px)`;
    };
    place();

    invoke<Song[]>("rhythm_songs")
      .then((songs) => {
        list.replaceChildren();
        if (songs.length === 0) {
          el("div", "rh-empty", list, "charts 文件夹里还没有歌。把 BeatSaver 的 zip 或 osu! 的 .osz（改成 .zip）解压进去，一首歌一个文件夹。");
        }
        for (const song of songs) {
          const row = el("div", "rh-song", list);
          const meta = el("div", "rh-song-meta", row);
          el("div", "rh-song-name", meta, song.title + (song.sub_title ? ` ${song.sub_title}` : ""));
          el("div", "rh-song-artist", meta, `${song.artist}${song.mapper ? ` · 谱 ${song.mapper}` : ""} · ${Math.round(song.bpm)} BPM`);
          const diffs = el("div", "rh-diffs", row);
          if (song.format === "osu") {
            // osu!：每个 .osu 一个难度，按靶子数从少到多排（最左边就是最简单的）；mania 等暂不支持的灰着，写上原因
            const sorted = [...song.difficulties].sort((a, b) => Number(!!a.note) - Number(!!b.note) || a.count - b.count);
            for (const d of sorted) {
              const b = el("button", "rh-diff", diffs, d.note ? `${d.name}（${d.note}）` : d.name);
              b.title = `${d.name} · ${d.count} 个靶子`;
              b.disabled = !!d.note;
              b.addEventListener("click", () => (playMode() === "rift" ? openRift(song, d) : loadAndPlay(song, d, anchor)));
            }
          } else {
            // 只列标准谱（单手、无方向等玩法对 4 键没有意义）；没有标准谱就全列
            const std = song.difficulties.filter((d) => d.characteristic === "Standard");
            for (const d of std.length ? std : song.difficulties) {
              const b = el("button", "rh-diff", diffs, diffLabel(song, d));
              b.title = `${d.characteristic} / ${d.name}`;
              b.addEventListener("click", () => (playMode() === "rift" ? openRift(song, d) : loadAndPlay(song, d, anchor)));
            }
          }
        }
        place();
      })
      .catch(() => {
        list.replaceChildren();
        el("div", "rh-empty", list, "读歌单失败");
        place();
      });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRhythm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

async function loadAndPlay(song: Song, diff: Difficulty, anchor: Rect) {
  const menu = root?.querySelector<HTMLElement>(".rh-menu-title");
  if (menu) menu.textContent = "正在载入歌曲…";
  try {
    const notes = await invoke<Note[]>("rhythm_chart", { id: song.id, characteristic: diff.characteristic, difficulty: diff.name });
    let audio: AudioBuffer | null = null;
    if (song.song_file) {
      try {
        audio = decoded.get(song.id) ?? null;
        if (!audio) {
          const bytes = await invoke<ArrayBuffer>("rhythm_audio", { id: song.id });
          actx ??= new AudioContext({ latencyHint: "interactive" });
          audio = await actx.decodeAudioData(bytes);
          decoded.set(song.id, audio);
        }
      } catch (e) {
        // 歌读不了就退回"自己在浏览器里放"
        console.error(e);
        audio = null;
      }
    }
    if (!root) return; // 载入途中已经退出了
    startGame(song, diff, notes, anchor, audio);
  } catch (e) {
    console.error(e);
    if (menu) menu.textContent = "这个难度读不了";
  }
}

// ---------------- 游戏 ----------------

/** 把主题色调成两种显眼的颜色：外侧轨道用饱和的主题色，中间两条用同色系的亮色 */
function vividPair(css: string): [string, string] {
  const probe = document.createElement("i");
  probe.style.color = css.trim() || "#7aa2ff";
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/[\d.]+/g);
  probe.remove();
  let [r, g, b] = m ? m.slice(0, 3).map((v) => Number(v) / 255) : [0.48, 0.64, 1];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  // 灰色主题色没有色相可言：给个偏青的蓝
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(max + min - 1));
  if (sat < 0.15) h = 200;
  return [`hsl(${h.toFixed(0)} 95% 62%)`, `hsl(${h.toFixed(0)} 100% 76%)`];
}

type Judge = "perfect" | "great" | "miss";
const JUDGE_TEXT: Record<Judge, string> = { perfect: "Perfect", great: "Great", miss: "Miss" };

function startGame(song: Song, diff: Difficulty, notes: Note[], anchor: Rect, audio: AudioBuffer | null) {
  swap(() => {
    const W = window.innerWidth;
    const cx = Math.round(anchor.x + anchor.w / 2);
    const judgeY = Math.round(anchor.y + anchor.h / 2);
    const left = Math.round(cx - LANE_W * 2);
    const travel = judgeY - SPAWN_Y;

    const stage = el("div", "rh-stage", root!);
    // 音符颜色：跟着壁纸的主题色，但调得更鲜艳、更亮，压在画面上也显眼
    const [c1, c2] = vividPair(getComputedStyle(document.documentElement).getPropertyValue("--w-accent"));
    stage.style.setProperty("--rh-c", c1);
    stage.style.setProperty("--rh-c2", c2);
    // 轨道区域（不画框）：从灵动岛下面一直到判定线
    const road = el("div", "rh-road", stage);
    road.style.transform = `translate(${left}px, ${SPAWN_Y}px)`;
    road.style.width = `${LANE_W * 4}px`;
    road.style.height = `${travel}px`;
    // 按住时轨道亮起来
    const glow = KEYS.map((_, i) => {
      const g = el("div", "rh-lane-glow", road);
      g.style.width = `${LANE_W}px`;
      g.style.transform = `translateX(${i * LANE_W}px)`;
      return g;
    });
    // 判定线 + 每条轨道的爆光 + 键位
    const line = el("div", "rh-line", stage);
    line.style.transform = `translate(${left - 12}px, ${judgeY - 2}px)`;
    line.style.width = `${LANE_W * 4 + 24}px`;
    // 爆光：一团光 + 一圈往外扩的环
    const bursts = KEYS.map((_, i) => {
      const b = el("div", "rh-burst", stage);
      b.style.left = `${left + i * LANE_W + LANE_W / 2 - 70}px`;
      b.style.top = `${judgeY - 70}px`;
      return b;
    });
    const rings = KEYS.map((_, i) => {
      const r = el("div", "rh-ring", stage);
      r.style.left = `${left + i * LANE_W + LANE_W / 2 - 60}px`;
      r.style.top = `${judgeY - 60}px`;
      return r;
    });
    KEY_LABEL.forEach((k, i) => {
      const lab = el("div", "rh-key", stage, k);
      lab.style.transform = `translate(${left + i * LANE_W}px, ${judgeY + 16}px)`;
      lab.style.width = `${LANE_W}px`;
    });

    // 判定文字、连击
    const hud = el("div", "rh-hud", stage);
    hud.style.transform = `translate(${cx}px, ${judgeY - 150}px)`;
    const judgeEl = el("div", "rh-judge", hud);
    const comboEl = el("div", "rh-combo", hud);

    // 角落：歌名、难度、偏移、操作提示
    const corner = el("div", "rh-corner", stage);
    el("div", "rh-corner-title", corner, `${song.title} · ${diffLabel(song, diff)}`);
    const offsetEl = el("div", "rh-offset", corner);
    const speedEl = el("div", "rh-offset", corner);
    el("div", "rh-tip", corner, "← → 调延迟 · ↑ ↓ 调速度 · Esc 退出");

    // 开始前的提示
    const prompt = el("div", "rh-prompt", stage);
    prompt.style.transform = `translate(${W / 2}px, ${Math.round((SPAWN_Y + judgeY) / 2)}px)`;
    // 延迟、速度在开始前也能调
    const tune = () => el("div", "rh-prompt-small", prompt, "← → 调延迟（音符早了 / 晚了）· ↑ ↓ 调下落速度 · 每首歌分别记住");
    if (audio) {
      el("div", "rh-prompt-big", prompt, "按空格开始");
      el("div", "rh-prompt-small", prompt, "歌会自己放，先把浏览器里正在放的歌暂停");
      tune();
    } else {
      el("div", "rh-prompt-big", prompt, "播放歌曲后按空格开始");
      el("div", "rh-prompt-small", prompt, "这首谱没带歌：可以按键盘的播放键，或点下面的按钮让浏览器开始放");
      tune();
      const playBtn = el("button", "rh-play", prompt, "▶ 播放 / 暂停");
      playBtn.addEventListener("click", () => {
        invoke("media_cmd", { action: "toggle" }).catch(() => {});
      });
    }

    // 窗口失去焦点（点到了别的程序）：按键收不到了，提示点回来
    const lost = el("div", "rh-lost", stage, "点一下这里继续（键盘焦点在别的窗口）");
    lost.hidden = document.hasFocus();

    // 音符：用到时才从池子里拿一个元素，打完 / 错过就还回去
    const pool: HTMLElement[] = [];
    const take = (lane: number) => {
      const n = pool.pop() ?? el("div", "rh-note", stage);
      n.hidden = false;
      n.style.width = `${LANE_W - 14}px`;
      n.dataset.lane = String(lane);
      return n;
    };
    const give = (n: HTMLElement) => {
      n.hidden = true;
      pool.push(n);
    };

    let offsetMs = song.offset_ms;
    const showOffset = () => (offsetEl.textContent = `延迟 ${offsetMs > 0 ? "+" : ""}${offsetMs} ms`);
    showOffset();
    // 下落速度：每首歌自己记；改了以后正在落的音符马上按新速度走（位置按时间算，不会跳错拍）
    let speed = Math.min(3, Math.max(0.5, song.speed || 1));
    let lead = LEAD / speed;
    const showSpeed = () => (speedEl.textContent = `速度 ${speed.toFixed(1)}x`);
    showSpeed();

    // 游戏状态
    const done = new Uint8Array(notes.length); // 0 没判定，1 已判定
    const live = new Map<number, HTMLElement>(); // 音符序号 → 正在显示的元素
    let next = 0; // 下一个还没出现的音符
    let first = 0; // 最早一个还没判定的音符
    let t0 = 0; // 按空格的时刻（performance.now）
    let running = false;
    let starting = false; // 按了空格、歌还在准备
    let finished = false;
    let combo = 0;
    let maxCombo = 0;
    const count = { perfect: 0, great: 0, miss: 0 };
    const lastT = notes.length ? notes[notes.length - 1].t : 0;
    let judgeAnim: Animation | null = null;

    // 自己放歌时：歌在音频时钟的 startAt 秒开始
    let source: AudioBufferSourceNode | null = null;
    let startAt = 0;
    /** 音频时钟此刻"正从扬声器出来"的位置（秒）。getOutputTimestamp 已经算上输出延迟，再用 performance.now 补到这一帧 */
    const audioNow = () => {
      const ts = actx!.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      return actx!.currentTime - (actx!.outputLatency || actx!.baseLatency || 0);
    };
    /** 歌放到第几秒了（扣掉偏移：偏移为正，音符整体晚一点） */
    const songTime = () =>
      (audio ? audioNow() - startAt : (performance.now() - t0) / 1000) - offsetMs / 1000;

    const startMusic = async () => {
      if (!audio || !actx) return;
      await actx.resume();
      const gain = actx.createGain();
      gain.gain.value = 0.85;
      gain.connect(actx.destination);
      source = actx.createBufferSource();
      source.buffer = audio;
      source.connect(gain);
      // 先留一段：歌开头就有的音符也能从上面完整落下来（慢速时留得更久）
      startAt = actx.currentTime + Math.max(LEAD, lead);
      source.start(startAt);
      // 音乐组件、灵动岛显示正在放的这首（进度从"还有几秒开始"算起）
      const src = source;
      invoke("rhythm_now_playing", {
        id: song.id,
        positionMs: Math.round((actx.currentTime - startAt) * 1000),
        durationMs: Math.round(audio.duration * 1000),
      }).catch(() => {});
      src.onended = () => {
        if (source === src) {
          source = null;
          invoke("rhythm_now_playing", { id: "", positionMs: 0, durationMs: 0 }).catch(() => {});
        }
      };
    };
    const stopMusic = () => {
      if (!source) return;
      const s = source;
      source = null;
      try {
        s.stop();
      } catch {
        // 还没开始放就停，忽略
      }
      invoke("rhythm_now_playing", { id: "", positionMs: 0, durationMs: 0 }).catch(() => {});
    };

    const judge = (j: Judge, lane: number) => {
      count[j]++;
      if (j === "miss") combo = 0;
      else {
        combo++;
        maxCombo = Math.max(maxCombo, combo);
        const ease = "cubic-bezier(0.2, 0.8, 0.3, 1)";
        bursts[lane].animate(
          [
            { transform: "scale(0.35)", opacity: 1 },
            { transform: "scale(1.3)", opacity: 0 },
          ],
          { duration: j === "perfect" ? 340 : 260, easing: ease },
        );
        rings[lane].animate(
          [
            { transform: "scale(0.3)", opacity: 0.95 },
            { transform: "scale(1.5)", opacity: 0 },
          ],
          { duration: 380, easing: ease },
        );
      }
      judgeEl.textContent = JUDGE_TEXT[j];
      judgeEl.dataset.j = j;
      comboEl.textContent = combo >= 2 ? `${combo} combo` : "";
      judgeAnim?.cancel();
      judgeAnim = judgeEl.animate(
        [
          { transform: "translateX(-50%) scale(1.25)", opacity: 1 },
          { transform: "translateX(-50%) scale(1)", opacity: 1, offset: 0.25 },
          { transform: "translateX(-50%) scale(1)", opacity: 0 },
        ],
        { duration: 700, easing: "ease-out", fill: "forwards" },
      );
    };

    const finish = (n: number) => {
      done[n] = 1;
      const e = live.get(n);
      if (e) {
        give(e);
        live.delete(n);
      }
    };

    const frame = () => {
      if (!running) return;
      const now = songTime();
      // 新出现的
      while (next < notes.length && notes[next].t - now <= lead) {
        if (!done[next]) live.set(next, take(notes[next].lane));
        next++;
      }
      // 过了判定线太久还没打：Miss
      while (first < next && (done[first] || notes[first].t < now - MISS)) {
        if (!done[first]) {
          finish(first);
          judge("miss", notes[first].lane);
        }
        first++;
      }
      // 摆位置：只改 transform
      for (const [i, e] of live) {
        const n = notes[i];
        const y = judgeY - ((n.t - now) / lead) * travel;
        e.style.transform = `translate3d(${left + n.lane * LANE_W + 7}px, ${y - NOTE_H / 2}px, 0)`;
      }
      if (now > lastT + 2 && !finished) {
        finished = true;
        showResult();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    let raf = 0;

    const hit = (lane: number) => {
      const now = songTime();
      // 这条轨道上最早一个没判定、在判定窗口里的音符
      for (let i = first; i < next; i++) {
        const n = notes[i];
        if (done[i] || n.lane !== lane) continue;
        const d = Math.abs(n.t - now);
        if (n.t - now > MISS) break; // 还早，按空了不算
        if (d <= MISS) {
          finish(i);
          judge(d <= PERFECT ? "perfect" : d <= GREAT ? "great" : "miss", lane);
        }
        break;
      }
    };

    const showResult = () => {
      cancelAnimationFrame(raf);
      running = false;
      const total = notes.length || 1;
      const acc = (count.perfect + count.great * 0.6) / total;
      const score = Math.round(acc * 1_000_000);
      const card = el("div", "rh-result", stage);
      card.style.transform = `translate(${W / 2}px, ${Math.round((SPAWN_Y + judgeY) / 2)}px)`;
      el("div", "rh-result-title", card, `${song.title} · ${diffLabel(song, diff)}`);
      el("div", "rh-score", card, score.toLocaleString("en-US"));
      el("div", "rh-acc", card, `准确率 ${(acc * 100).toFixed(2)}%`);
      const rows = el("div", "rh-rows", card);
      for (const [k, label] of [
        ["perfect", "Perfect"],
        ["great", "Great"],
        ["miss", "Miss"],
      ] as const) {
        const r = el("div", `rh-row ${k}`, rows);
        el("span", "", r, label);
        el("b", "", r, String(count[k]));
      }
      const r = el("div", "rh-row", rows);
      el("span", "", r, "最大连击");
      el("b", "", r, String(maxCombo));
      el("div", "rh-tip", card, "空格再来一次 · Esc 退出");
    };

    const restart = () => {
      startGame({ ...song, offset_ms: offsetMs, speed }, diff, notes, anchor, audio);
    };

    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "escape") {
        closeRhythm();
        return;
      }
      if (k === " ") {
        e.preventDefault();
        if (e.repeat) return;
        if (finished) restart();
        else if (!running && !starting) {
          prompt.remove();
          if (audio) {
            starting = true;
            startMusic().then(() => {
              running = true;
              raf = requestAnimationFrame(frame);
            });
          } else {
            t0 = performance.now();
            running = true;
            raf = requestAnimationFrame(frame);
          }
        }
        return;
      }
      if (k === "arrowleft" || k === "arrowright") {
        e.preventDefault();
        offsetMs += k === "arrowright" ? 20 : -20;
        offsetMs = Math.max(-2000, Math.min(2000, offsetMs));
        showOffset();
        invoke("rhythm_prefs_set", { id: song.id, offsetMs, speed: null }).catch(() => {});
        return;
      }
      if (k === "arrowup" || k === "arrowdown") {
        e.preventDefault();
        speed = Math.round((speed + (k === "arrowup" ? 0.1 : -0.1)) * 10) / 10;
        speed = Math.max(0.5, Math.min(3, speed));
        lead = LEAD / speed;
        showSpeed();
        invoke("rhythm_prefs_set", { id: song.id, offsetMs: null, speed }).catch(() => {});
        return;
      }
      const lane = KEYS.indexOf(k);
      if (lane < 0) return;
      e.preventDefault();
      glow[lane].classList.add("on");
      if (!e.repeat && running) hit(lane);
    };
    const onUp = (e: KeyboardEvent) => {
      const lane = KEYS.indexOf(e.key.toLowerCase());
      if (lane >= 0) glow[lane].classList.remove("on");
    };
    const onFocus = () => (lost.hidden = true);
    const onBlur = () => {
      lost.hidden = false;
      glow.forEach((g) => g.classList.remove("on"));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      stopMusic();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  });
}
