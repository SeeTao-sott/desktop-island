// 音频可视化：Rust 录取系统正在播放的声音（不是麦克风），每帧推 64 个频段（波形样式时再加波形）。
// 只有这个组件显示着、不在全屏时才录；没声音一阵后 Rust 停止发送，界面淡出、停止绘制。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings, WidgetModule } from "../types";
import type { AudioData } from "../skins/types";

interface Frame {
  bands: number[];
  wave: number[];
  level: number;
  silent: boolean;
}

const styleOf = (s: Settings): AudioData["style"] => (s.style === "wave" ? "wave" : "bars");
const fpsOf = (s: Settings) => (s.fps30 === true ? 30 : 60);

const audio: WidgetModule<AudioData> = {
  kind: "audio",
  name: "音频可视化",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",
  settings: [
    {
      key: "style",
      label: "样式",
      default: "bars",
      options: [
        { value: "bars", label: "频谱柱" },
        { value: "wave", label: "波形" },
      ],
    },
    { key: "fps30", label: "降到 30 帧（更省电）", default: false },
  ],

  model(settings) {
    let fps = fpsOf(settings);
    let style = styleOf(settings);
    let watching = false;
    let last: AudioData = { bands: [], wave: [], level: 0, silent: true, fps, style, at: 0 };
    const subs: ((d: AudioData) => void)[] = [];
    const push = () => subs.forEach((cb) => cb(last));

    const unlisten = listen<Frame>("audio-frame", (e) => {
      last = { ...e.payload, fps, style, at: performance.now() };
      push();
    });

    // 告诉 Rust：要不要录、帧率多少、要不要波形
    function watch(on: boolean) {
      if (on === watching) return;
      watching = on;
      invoke("audio_watch", { on, fps, wave: style === "wave" }).catch(() => {});
    }
    unlisten.then(() => watch(true));

    return {
      subscribe(cb) {
        subs.push(cb);
        cb(last);
      },
      setSettings(s) {
        fps = fpsOf(s);
        style = styleOf(s);
        if (watching) {
          watch(false);
          watch(true);
        }
        last = { ...last, fps, style };
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
        unlisten.then((f) => f());
      },
    };
  },
};

export default audio;
