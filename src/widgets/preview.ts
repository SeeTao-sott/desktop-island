// 主题预览窗口：每种主题一行，时钟和番茄钟各一个小尺寸、一个中尺寸，背景是现在的壁纸。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initTheme } from "./theme";
import type { SizeKey } from "./types";
import { gridOf } from "./grid";
import { SKINS } from "./skins/registry";
import { clockTicker, fakePomodoro } from "./skins/models";
import type { ClockData, PomoData, View } from "./skins/types";

const grid = document.getElementById("grid")!;
const clockViews: View<ClockData>[] = [];
const pomoViews: View<PomoData>[] = [];
let lastClock: ClockData | null = null;
let lastPomo: PomoData | null = null;

const pomo = fakePomodoro((d) => {
  lastPomo = d;
  pomoViews.forEach((v) => v.update(d));
});

for (const skin of SKINS) {
  const row = document.createElement("section");
  row.className = "pv-row";
  const name = document.createElement("div");
  name.className = "pv-name";
  name.textContent = skin.name;
  row.appendChild(name);
  const items = document.createElement("div");
  items.className = "pv-items";
  row.appendChild(items);
  for (const [kind, size] of [
    ["clock", "small"],
    ["pomodoro", "small"],
    ["clock", "medium"],
    ["pomodoro", "medium"],
  ] as [string, SizeKey][]) {
    const { w, h } = gridOf(skin.grid).box(size);
    const host = document.createElement("div");
    host.className = "pv-widget";
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    items.appendChild(host);
    const { content } = skin.frame(host, size, w, h);
    const ctx = { size, w, h, act: (a: string) => pomo.act(a) };
    if (kind === "clock") {
      const v = skin.views.clock(content, ctx);
      clockViews.push(v);
      if (lastClock) v.update(lastClock);
    } else {
      const v = skin.views.pomodoro(content, ctx);
      pomoViews.push(v);
      if (lastPomo) v.update(lastPomo);
    }
  }
  grid.appendChild(row);
}

clockTicker({ seconds: true, hour12: false }, (d) => {
  lastClock = d;
  clockViews.forEach((v) => v.update(d));
});

initTheme();

// 背景换成现在的壁纸；刚启动时颜色可能还没算好，等算好（或换了壁纸）再取一次
let wallShown = "";
function loadWall() {
  invoke<string | null>("widgets_wallpaper_preview")
    .then((url) => {
      if (url && url !== wallShown) {
        wallShown = url;
        document.getElementById("wall")!.style.backgroundImage = `url("${url}")`;
      }
    })
    .catch(() => {});
}
loadWall();
listen("widgets-theme", loadWall);
window.setTimeout(loadWall, 2000);
