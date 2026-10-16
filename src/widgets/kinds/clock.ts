// 时钟和日期。秒数关掉时每分钟才醒一次；只有文字真的变了才写进页面
import "./clock.css";
import type { SizeKey, Settings, WidgetModule } from "../types";

const WEEK = "日一二三四五六";
const pad = (n: number) => String(n).padStart(2, "0");

function timeParts(d: Date, hour12: boolean) {
  let h = d.getHours();
  let ampm = "";
  if (hour12) {
    ampm = h < 12 ? "上午" : "下午";
    h = h % 12 || 12;
  }
  return { hm: `${hour12 ? h : pad(h)}:${pad(d.getMinutes())}`, sec: pad(d.getSeconds()), ampm };
}

const dateText = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
const weekText = (d: Date) => `星期${WEEK[d.getDay()]}`;

/** 大尺寸下面的月历 */
function calendar(d: Date) {
  const box = document.createElement("div");
  box.className = "cal";
  for (const w of WEEK) {
    const h = document.createElement("span");
    h.className = "cal-head";
    h.textContent = w;
    box.appendChild(h);
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  for (let i = 0; i < first; i++) box.appendChild(document.createElement("span"));
  for (let n = 1; n <= days; n++) {
    const c = document.createElement("span");
    c.className = "cal-day" + (n === d.getDate() ? " today" : "");
    c.textContent = String(n);
    box.appendChild(c);
  }
  return box;
}

const clock: WidgetModule = {
  kind: "clock",
  name: "时钟和日期",
  sizes: ["small", "medium", "large"],
  defaultSize: "small",
  settings: [
    { key: "seconds", label: "显示秒", default: false },
    { key: "hour12", label: "12 小时制", default: false },
  ],

  create(root, opts) {
    let size: SizeKey = opts.size;
    let settings: Settings = opts.settings;
    let paused = false;
    let timer = 0;
    // 上次写进页面的内容，没变就不碰 DOM
    let last: Record<string, string> = {};
    let refs: Record<string, HTMLElement> = {};

    function build() {
      root.className = `w-clock size-${size}`;
      root.innerHTML = `
        <div class="clk-time"><span class="clk-ampm"></span><span class="clk-hm"></span><span class="clk-sec"></span></div>
        <div class="clk-date"><span class="clk-day"></span><span class="clk-week"></span></div>
        ${size === "large" ? '<div class="clk-cal"></div>' : ""}`;
      refs = {};
      for (const k of ["ampm", "hm", "sec", "day", "week", "cal"]) {
        const el = root.querySelector<HTMLElement>(`.clk-${k}`);
        if (el) refs[k] = el;
      }
      last = {};
      render();
    }

    function set(key: string, text: string) {
      if (last[key] === text || !refs[key]) return;
      last[key] = text;
      refs[key].textContent = text;
    }

    function render() {
      const d = new Date();
      const t = timeParts(d, settings.hour12 === true);
      set("ampm", t.ampm);
      set("hm", t.hm);
      set("sec", settings.seconds === true ? t.sec : "");
      set("day", dateText(d));
      set("week", weekText(d));
      const ymd = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (refs.cal && last.cal !== ymd) {
        last.cal = ymd;
        refs.cal.replaceChildren(calendar(d));
      }
      schedule(d);
    }

    // 对准下一秒（或下一分钟）醒来
    function schedule(d: Date) {
      window.clearTimeout(timer);
      if (paused) return;
      const ms = settings.seconds === true ? 1000 - d.getMilliseconds() : 60_000 - d.getSeconds() * 1000 - d.getMilliseconds();
      timer = window.setTimeout(render, ms + 15);
    }

    build();
    return {
      setSize(s) {
        if (s === size) return;
        size = s;
        build();
      },
      setSettings(s) {
        settings = s;
        last = {};
        render();
      },
      setPaused(p) {
        paused = p;
        if (p) window.clearTimeout(timer);
        else render();
      },
      destroy() {
        window.clearTimeout(timer);
        root.replaceChildren();
      },
    };
  },
};

export default clock;
