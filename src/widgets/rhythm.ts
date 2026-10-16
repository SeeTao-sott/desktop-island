// 音游原型：双击律动（音频可视化）组件 → 选歌 → 下落式 4 键音游。
//
// 歌由你自己在浏览器里放，按空格那一刻开始计时；符号从灵动岛下面往下掉，
// 判定线就在律动组件的位置。按键靠窗口自己的键盘焦点收到（进音游时 Rust 让窗口拿焦点），
// 不用全局键盘钩子。所有移动都只用 transform，每帧只改位置不改布局。
import "./rhythm.css";
import { invoke } from "@tauri-apps/api/core";

interface Difficulty {
  characteristic: string;
  name: string;
  file: string;
}
interface Song {
  id: string;
  title: string;
  sub_title: string;
  artist: string;
  mapper: string;
  bpm: number;
  difficulties: Difficulty[];
  offset_ms: number;
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

const KEYS = ["d", "f", "j", "k"];
const KEY_LABEL = ["D", "F", "J", "K"];
/** 提前多久出现（秒） */
const LEAD = 1.5;
/** 判定窗口（秒） */
const PERFECT = 0.05;
const GREAT = 0.1;
const MISS = 0.15;
const LANE_W = 76;
/** 灵动岛（收起时）的下边缘再往下一点 */
const SPAWN_Y = 56;
const DIFF_LABEL: Record<string, string> = {
  Easy: "简单",
  Normal: "普通",
  Hard: "困难",
  Expert: "专家",
  ExpertPlus: "专家+",
};

let root: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

/** 现在是不是在音游里（选歌菜单也算） */
export const rhythmOpen = () => root !== null;

/** 双击律动组件：在它上方弹出选歌菜单 */
export async function openRhythm(anchor: Rect) {
  if (root) return;
  const on = await invoke<boolean>("widgets_rhythm", { on: true }).catch(() => false);
  if (!on) return;
  root = document.createElement("div");
  root.className = "rh-root";
  document.body.appendChild(root);
  showMenu(anchor);
}

/** 退出：拆掉界面，窗口沉回桌面层、恢复点击穿透、焦点还给原来的程序 */
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
    shade.addEventListener("pointerdown", () => closeRhythm());
    const card = el("div", "rh-menu", root!);
    el("div", "rh-menu-title", card, "选一首歌");
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
          el("div", "rh-empty", list, "charts 文件夹里还没有歌。把 BeatSaver 的 zip 解压进去，一首歌一个文件夹。");
        }
        for (const song of songs) {
          const row = el("div", "rh-song", list);
          const meta = el("div", "rh-song-meta", row);
          el("div", "rh-song-name", meta, song.title + (song.sub_title ? ` ${song.sub_title}` : ""));
          el("div", "rh-song-artist", meta, `${song.artist}${song.mapper ? ` · 谱 ${song.mapper}` : ""} · ${Math.round(song.bpm)} BPM`);
          const diffs = el("div", "rh-diffs", row);
          // 只列标准谱（单手、无方向等玩法对 4 键没有意义）；没有标准谱就全列
          const std = song.difficulties.filter((d) => d.characteristic === "Standard");
          for (const d of std.length ? std : song.difficulties) {
            const b = el("button", "rh-diff", diffs, DIFF_LABEL[d.name] ?? d.name);
            b.title = `${d.characteristic} / ${d.name}`;
            b.addEventListener("click", () => loadAndPlay(song, d, anchor));
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
  try {
    const notes = await invoke<Note[]>("rhythm_chart", { id: song.id, characteristic: diff.characteristic, difficulty: diff.name });
    startGame(song, diff, notes, anchor);
  } catch (e) {
    console.error(e);
  }
}

// ---------------- 游戏 ----------------

type Judge = "perfect" | "great" | "miss";
const JUDGE_TEXT: Record<Judge, string> = { perfect: "Perfect", great: "Great", miss: "Miss" };

function startGame(song: Song, diff: Difficulty, notes: Note[], anchor: Rect) {
  swap(() => {
    const W = window.innerWidth;
    const cx = Math.round(anchor.x + anchor.w / 2);
    const judgeY = Math.round(anchor.y + anchor.h / 2);
    const left = Math.round(cx - LANE_W * 2);
    const travel = judgeY - SPAWN_Y;

    const stage = el("div", "rh-stage", root!);
    // 轨道背景：从灵动岛下面一直到判定线
    const road = el("div", "rh-road", stage);
    road.style.transform = `translate(${left}px, ${SPAWN_Y}px)`;
    road.style.width = `${LANE_W * 4}px`;
    road.style.height = `${travel}px`;
    for (let i = 1; i < 4; i++) {
      const sep = el("div", "rh-sep", road);
      sep.style.transform = `translateX(${i * LANE_W}px)`;
    }
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
    const bursts = KEYS.map((_, i) => {
      const b = el("div", "rh-burst", stage);
      b.style.left = `${left + i * LANE_W + LANE_W / 2 - 40}px`;
      b.style.top = `${judgeY - 40}px`;
      return b;
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
    el("div", "rh-corner-title", corner, `${song.title} · ${DIFF_LABEL[diff.name] ?? diff.name}`);
    const offsetEl = el("div", "rh-offset", corner);
    el("div", "rh-tip", corner, "← → 调偏移 · Esc 退出");

    // 开始前的提示
    const prompt = el("div", "rh-prompt", stage);
    prompt.style.transform = `translate(${W / 2}px, ${Math.round((SPAWN_Y + judgeY) / 2)}px)`;
    el("div", "rh-prompt-big", prompt, "播放歌曲后按空格开始");
    el("div", "rh-prompt-small", prompt, "可以按键盘的播放键，或点下面的按钮让浏览器开始放");
    const playBtn = el("button", "rh-play", prompt, "▶ 播放 / 暂停");
    playBtn.addEventListener("click", () => {
      invoke("media_cmd", { action: "toggle" }).catch(() => {});
    });

    // 窗口失去焦点（点到了别的程序）：按键收不到了，提示点回来
    const lost = el("div", "rh-lost", stage, "点一下这里继续（键盘焦点在别的窗口）");
    lost.hidden = document.hasFocus();

    // 音符：用到时才从池子里拿一个元素，打完 / 错过就还回去
    const pool: HTMLElement[] = [];
    const take = (lane: number) => {
      const n = pool.pop() ?? el("div", "rh-note", stage);
      n.hidden = false;
      n.style.width = `${LANE_W - 12}px`;
      n.dataset.lane = String(lane);
      return n;
    };
    const give = (n: HTMLElement) => {
      n.hidden = true;
      pool.push(n);
    };

    let offsetMs = song.offset_ms;
    const showOffset = () => (offsetEl.textContent = `偏移 ${offsetMs > 0 ? "+" : ""}${offsetMs} ms`);
    showOffset();

    // 游戏状态
    const done = new Uint8Array(notes.length); // 0 没判定，1 已判定
    const live = new Map<number, HTMLElement>(); // 音符序号 → 正在显示的元素
    let next = 0; // 下一个还没出现的音符
    let first = 0; // 最早一个还没判定的音符
    let t0 = 0; // 按空格的时刻（performance.now）
    let running = false;
    let finished = false;
    let combo = 0;
    let maxCombo = 0;
    const count = { perfect: 0, great: 0, miss: 0 };
    const lastT = notes.length ? notes[notes.length - 1].t : 0;
    let judgeAnim: Animation | null = null;

    /** 歌放到第几秒了（扣掉偏移：偏移为正，音符整体晚一点） */
    const songTime = () => (performance.now() - t0) / 1000 - offsetMs / 1000;

    const judge = (j: Judge, lane: number) => {
      count[j]++;
      if (j === "miss") combo = 0;
      else {
        combo++;
        maxCombo = Math.max(maxCombo, combo);
        bursts[lane].animate(
          [
            { transform: "scale(0.4)", opacity: 1 },
            { transform: "scale(1.4)", opacity: 0 },
          ],
          { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
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
      while (next < notes.length && notes[next].t - now <= LEAD) {
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
        const y = judgeY - ((n.t - now) / LEAD) * travel;
        e.style.transform = `translate3d(${left + n.lane * LANE_W + 6}px, ${y - 9}px, 0)`;
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
      el("div", "rh-result-title", card, `${song.title} · ${DIFF_LABEL[diff.name] ?? diff.name}`);
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
      startGame({ ...song, offset_ms: offsetMs }, diff, notes, anchor);
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
        else if (!running) {
          t0 = performance.now();
          running = true;
          prompt.remove();
          raf = requestAnimationFrame(frame);
        }
        return;
      }
      if (k === "arrowleft" || k === "arrowright") {
        e.preventDefault();
        offsetMs += k === "arrowright" ? 20 : -20;
        offsetMs = Math.max(-2000, Math.min(2000, offsetMs));
        showOffset();
        invoke("rhythm_offset_set", { id: song.id, ms: offsetMs }).catch(() => {});
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
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  });
}
