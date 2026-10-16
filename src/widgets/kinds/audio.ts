// 音频可视化：Rust 录取系统正在播放的声音（不是麦克风），每帧推 64 个频段，画成频谱柱。
// 只有这个组件显示着、不在全屏时才录；没声音一阵后 Rust 停止发送，界面淡出、停止绘制。
//
// 颜色：默认用壁纸的强调色；可以改成跟着当前歌曲的封面颜色，或者手动选一个颜色。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings, WidgetModule } from "../types";
import type { AudioData } from "../skins/types";

interface Frame {
  bands: number[];
  level: number;
  silent: boolean;
}

type Rgb = [number, number, number];

const SWATCHES = [
  ["#5b8cff", "蓝"],
  ["#9b6bff", "紫"],
  ["#ff6bc8", "粉"],
  ["#ff5a5f", "红"],
  ["#ff9f43", "橙"],
  ["#ffd84d", "黄"],
  ["#4ee38a", "绿"],
  ["#3fd7e8", "青"],
] as const;

const fpsOf = (s: Settings) => (s.fps30 === true ? 30 : 60);
const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 封面的颜色：缩成 24×24，挑"又鲜艳、面积又不太小"的颜色；太暗就提亮，保证在深色玻璃上看得见 */
function coverColor(url: string): Promise<Rgb | null> {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      // 按色相分 12 桶，每桶按"鲜艳程度"加权累计
      const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < px.length; i += 4) {
        const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
        const max = Math.max(r, gg, b);
        const min = Math.min(r, gg, b);
        const sat = max ? (max - min) / max : 0;
        if (max < 40 || sat < 0.2) continue;
        let h = 0;
        const d = max - min || 1;
        if (max === r) h = ((gg - b) / d + 6) % 6;
        else if (max === gg) h = (b - r) / d + 2;
        else h = (r - gg) / d + 4;
        const k = Math.floor(h * 2) % 12;
        const w = sat * (max / 255);
        buckets[k].w += w;
        buckets[k].r += r * w;
        buckets[k].g += gg * w;
        buckets[k].b += b * w;
      }
      const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
      if (best.w < 2) return resolve(null); // 封面基本是灰的：还是用壁纸色
      let rgb: Rgb = [best.r / best.w, best.g / best.w, best.b / best.w];
      // 提亮到最亮的通道至少 210
      const m = Math.max(...rgb);
      if (m < 210) rgb = rgb.map((v) => Math.min(255, (v * 210) / m)) as Rgb;
      resolve(rgb);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const audio: WidgetModule<AudioData> = {
  kind: "audio",
  name: "音频可视化",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",
  settings: [
    {
      key: "color",
      label: "颜色",
      default: "wallpaper",
      options: [
        { value: "wallpaper", label: "壁纸" },
        { value: "cover", label: "封面" },
        { value: "manual", label: "手动" },
      ],
    },
    {
      key: "manual",
      label: "手动颜色",
      default: SWATCHES[0][0],
      options: SWATCHES.map(([value, label]) => ({ value, label, swatch: true })),
    },
    { key: "fps30", label: "降到 30 帧（更省电）", default: false },
  ],

  model(settings) {
    let fps = fpsOf(settings);
    let s = settings;
    let cover: Rgb | null = null;
    let watching = false;
    const color = (): Rgb | null =>
      s.color === "manual" ? hexRgb(String(s.manual ?? SWATCHES[0][0])) : s.color === "cover" ? cover : null;
    let last: AudioData = { bands: [], level: 0, silent: true, fps, color: color(), at: 0 };
    const subs: ((d: AudioData) => void)[] = [];
    const push = () => subs.forEach((cb) => cb(last));

    const unlisten = [
      listen<Frame>("audio-frame", (e) => {
        last = { ...e.payload, fps, color: color(), at: performance.now() };
        push();
      }),
      // 封面换了就重新取色（只在"封面"模式下用得上，取色本身很便宜）
      listen<string>("media-cover", (e) => {
        coverColor(e.payload).then((c) => {
          cover = c;
          last = { ...last, color: color() };
          push();
        });
      }),
    ];

    // 告诉 Rust：要不要录、帧率多少
    function watch(on: boolean) {
      if (on === watching) return;
      watching = on;
      invoke("audio_watch", { on, fps }).catch(() => {});
    }
    Promise.all(unlisten).then(() => {
      watch(true);
      // 让 Rust 把当前封面再推一遍
      invoke("media_cmd", { action: "sync" }).catch(() => {});
    });

    return {
      subscribe(cb) {
        subs.push(cb);
        cb(last);
      },
      setSettings(next) {
        s = next;
        fps = fpsOf(next);
        if (watching) {
          watch(false);
          watch(true);
        }
        last = { ...last, fps, color: color() };
        push();
      },
      setPaused(p) {
        watch(!p);
        if (p) {
          last = { ...last, silent: true };
          push();
        }
      },
      destroy() {
        watch(false);
        subs.length = 0;
        unlisten.forEach((u) => u.then((f) => f()));
      },
    };
  },
};

export default audio;
