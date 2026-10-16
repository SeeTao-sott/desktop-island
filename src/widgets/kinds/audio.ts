// 音频可视化：Rust 录取系统正在播放的声音（不是麦克风），每帧推 64 个频段和波形。
// 只有这个组件显示着、不在全屏时才录；没声音一阵后 Rust 停止发送，界面淡出、停止绘制。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WidgetModule } from "../types";
import type { AudioData } from "../skins/types";

interface Frame {
  bands: number[];
  wave: number[];
  level: number;
  silent: boolean;
}

const audio: WidgetModule<AudioData> = {
  kind: "audio",
  name: "音频可视化",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",
  settings: [{ key: "fps30", label: "降到 30 帧（更省电）", default: false }],

  model(settings) {
    let fps = settings.fps30 === true ? 30 : 60;
    let watching = false;
    let last: AudioData = { bands: [], wave: [], level: 0, silent: true, fps, at: 0 };
    const subs: ((d: AudioData) => void)[] = [];

    const unlisten = listen<Frame>("audio-frame", (e) => {
      last = { ...e.payload, fps, at: performance.now() };
      subs.forEach((cb) => cb(last));
    });

    function watch(on: boolean) {
      if (on === watching) return;
      watching = on;
      invoke("audio_watch", { on, fps }).catch(() => {});
    }
    unlisten.then(() => watch(true));

    return {
      subscribe(cb) {
        subs.push(cb);
        cb(last);
      },
      setSettings(s) {
        fps = s.fps30 === true ? 30 : 60;
        // 重新告诉 Rust 帧率
        if (watching) {
          watch(false);
          watch(true);
        }
        last = { ...last, fps };
        subs.forEach((cb) => cb(last));
      },
      setPaused(p) {
        watch(!p);
        if (p) {
          last = { ...last, silent: true };
          subs.forEach((cb) => cb(last));
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
