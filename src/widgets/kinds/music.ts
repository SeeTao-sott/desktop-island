// 音乐：和灵动岛共用同一份数据（Rust 广播的 media / media-cover 事件），按钮也走同一个命令。
// 播放时每秒推一次进度；暂停、没在放时不推。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WidgetModule } from "../types";
import type { MusicData } from "../skins/types";

interface MediaInfo {
  active: boolean;
  title: string;
  artist: string;
  source: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  canToggle: boolean;
  canNext: boolean;
  canPrev: boolean;
}

// 没有歌手时显示来源程序，比如 "Chrome"
function sourceName(id: string) {
  const base = id.split("!").pop()!.split("\\").pop()!.replace(/\.exe$/i, "");
  return base.replace(/^electron\.app\./, "");
}

const music: WidgetModule<MusicData> = {
  kind: "music",
  name: "音乐",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",

  model() {
    let info: MediaInfo | null = null;
    let cover = "";
    let receivedAt = 0;
    let paused = false;
    let timer = 0;
    const subs: ((d: MusicData) => void)[] = [];

    const positionNow = () => {
      if (!info) return 0;
      const p = info.positionMs + (info.playing && !paused ? performance.now() - receivedAt : 0);
      return Math.min(Math.max(p, 0), info.durationMs);
    };

    function data(): MusicData {
      return {
        active: !!info?.active,
        title: info?.title ?? "",
        artist: info ? info.artist || sourceName(info.source) : "",
        playing: !!info?.playing,
        positionMs: positionNow(),
        durationMs: info?.durationMs ?? 0,
        canToggle: !!info?.canToggle,
        canNext: !!info?.canNext,
        canPrev: !!info?.canPrev,
        cover,
      };
    }

    // 对准整秒推进度；不在播放就不排下一次
    function push() {
      window.clearTimeout(timer);
      const d = data();
      subs.forEach((cb) => cb(d));
      if (info?.playing && !paused && info.durationMs > 0) timer = window.setTimeout(push, 1000 - (d.positionMs % 1000) + 10);
    }

    const unlisten = [
      listen<MediaInfo>("media", (e) => {
        info = e.payload;
        receivedAt = performance.now();
        push();
      }),
      listen<string>("media-cover", (e) => {
        cover = e.payload;
        push();
      }),
    ];
    // 监听装好后让 Rust 把当前状态再推一遍（灵动岛也会收到同样的内容，没有影响）
    Promise.all(unlisten).then(() => invoke("media_cmd", { action: "sync" }).catch(() => {}));

    return {
      subscribe(cb) {
        subs.push(cb);
        cb(data());
      },
      act(action) {
        invoke("media_cmd", { action }).catch(() => {});
        // 播放/暂停先在界面上切换，系统确认后会再推一次真实状态
        if (action === "toggle" && info) {
          info = { ...info, positionMs: positionNow(), playing: !info.playing };
          receivedAt = performance.now();
          push();
        }
      },
      setPaused(p) {
        // 先按旧状态算好当前进度，再切换
        if (info) {
          info = { ...info, positionMs: positionNow() };
          receivedAt = performance.now();
        }
        paused = p;
        if (!p) invoke("media_cmd", { action: "refresh" }).catch(() => {});
        push();
      },
      destroy() {
        window.clearTimeout(timer);
        subs.length = 0;
        unlisten.forEach((u) => u.then((f) => f()));
      },
    };
  },
};

export default music;
