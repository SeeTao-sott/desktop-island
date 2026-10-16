// 音乐：和灵动岛共用同一份数据（Rust 广播的 media / media-cover 事件），按钮也走同一个命令。
// 进度条一秒走一格，暂停或没在播放时完全不动。
import "./music.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SizeKey, WidgetModule } from "../types";

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

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 6l8.5 6L6 18zM16 6h2.2v12H16z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 6l-8.5 6L18 18zM5.8 6H8v12H5.8z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .69.07 1 .2V6l10-2v11.5a2.5 2.5 0 1 1-2.5-2.5c.35 0 .69.07 1 .2V7.2l-7 1.4z"/></svg>',
};

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// 没有歌手时显示来源程序，比如 "Chrome"
function sourceName(id: string) {
  const base = id.split("!").pop()!.split("\\").pop()!.replace(/\.exe$/i, "");
  return base.replace(/^electron\.app\./, "");
}

const music: WidgetModule = {
  kind: "music",
  name: "音乐",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",

  create(root, opts) {
    let size: SizeKey = opts.size;
    let info: MediaInfo | null = null;
    let cover = "";
    let receivedAt = 0;
    let paused = false;
    let timer = 0;
    const unlisten: Promise<UnlistenFn>[] = [];
    let el: Record<string, HTMLElement> = {};

    function build() {
      root.className = `w-music size-${size}`;
      root.innerHTML = `
        <div class="mu-cover"><img alt="" hidden /><span class="mu-ph">${ICON.note}</span></div>
        <div class="mu-meta">
          <div class="mu-title"></div>
          <div class="mu-artist"></div>
        </div>
        <div class="mu-progress"><div class="mu-bar"><i></i></div><span class="mu-el"></span><span class="mu-tot"></span></div>
        <div class="mu-ctrl">
          <button class="mu-btn js-prev" title="上一首">${ICON.prev}</button>
          <button class="mu-btn mu-main js-toggle" title="播放/暂停"></button>
          <button class="mu-btn js-next" title="下一首">${ICON.next}</button>
        </div>
        <div class="mu-idle">没有在播放</div>`;
      el = {
        img: root.querySelector("img")!,
        title: root.querySelector(".mu-title")!,
        artist: root.querySelector(".mu-artist")!,
        bar: root.querySelector(".mu-bar i")!,
        progress: root.querySelector(".mu-progress")!,
        elapsed: root.querySelector(".mu-el")!,
        total: root.querySelector(".mu-tot")!,
        toggle: root.querySelector(".js-toggle")!,
        prev: root.querySelector(".js-prev")!,
        next: root.querySelector(".js-next")!,
      };
      el.toggle.addEventListener("click", () => press("toggle"));
      el.prev.addEventListener("click", () => press("prev"));
      el.next.addEventListener("click", () => press("next"));
      render();
      setCover(cover);
    }

    function positionNow() {
      if (!info) return 0;
      const p = info.positionMs + (info.playing && !paused ? performance.now() - receivedAt : 0);
      return Math.min(Math.max(p, 0), info.durationMs);
    }

    function render() {
      const active = !!info?.active;
      root.classList.toggle("active", active);
      root.classList.toggle("playing", !!info?.playing);
      if (!info || !active) {
        tick();
        return;
      }
      el.title.textContent = info.title;
      el.artist.textContent = info.artist || sourceName(info.source);
      el.toggle.innerHTML = info.playing ? ICON.pause : ICON.play;
      (el.toggle as HTMLButtonElement).disabled = !info.canToggle;
      (el.prev as HTMLButtonElement).disabled = !info.canPrev;
      (el.next as HTMLButtonElement).disabled = !info.canNext;
      tick();
    }

    // 进度：一秒更新一次，对准整秒；不在播放就不排下一次
    function tick() {
      window.clearTimeout(timer);
      const has = !!info?.active && info.durationMs > 0;
      el.progress.style.visibility = has ? "visible" : "hidden";
      if (!has) return;
      const pos = positionNow();
      el.bar.style.transform = `scaleX(${pos / info!.durationMs})`;
      el.elapsed.textContent = fmt(pos);
      el.total.textContent = fmt(info!.durationMs);
      if (info!.playing && !paused) timer = window.setTimeout(tick, 1000 - (pos % 1000) + 10);
    }

    function setCover(url: string) {
      cover = url;
      const img = el.img as HTMLImageElement;
      if (url) img.src = url;
      else img.removeAttribute("src");
      img.hidden = !url;
    }

    function press(action: "toggle" | "next" | "prev") {
      invoke("media_cmd", { action }).catch(() => {});
      // 播放/暂停先在界面上切换，系统确认后会再推一次真实状态
      if (action === "toggle" && info) {
        info = { ...info, positionMs: positionNow(), playing: !info.playing };
        receivedAt = performance.now();
        render();
      }
    }

    build();
    unlisten.push(
      listen<MediaInfo>("media", (e) => {
        info = e.payload;
        receivedAt = performance.now();
        render();
      }),
      listen<string>("media-cover", (e) => setCover(e.payload)),
    );
    // 监听装好后让 Rust 把当前状态再推一遍（灵动岛也会收到同样的内容，没有影响）
    Promise.all(unlisten).then(() => invoke("media_cmd", { action: "sync" }).catch(() => {}));

    return {
      setSize(s) {
        if (s === size) return;
        size = s;
        build();
      },
      setPaused(p) {
        // 先按旧状态算好当前进度，再切换
        if (info) {
          info = { ...info, positionMs: positionNow() };
          receivedAt = performance.now();
        }
        paused = p;
        if (p) window.clearTimeout(timer);
        else invoke("media_cmd", { action: "refresh" }).catch(() => {});
        tick();
      },
      destroy() {
        window.clearTimeout(timer);
        unlisten.forEach((u) => u.then((f) => f()));
        root.replaceChildren();
      },
    };
  },
};

export default music;
