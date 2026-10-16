// 系统状态：CPU 占用、显卡温度、电量。Rust 只在这个组件显示着的时候才去读（几秒一次）。
// 数字没变就不碰页面；大尺寸多一条最近两三分钟的 CPU 曲线。
import "./status.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SizeKey, WidgetModule } from "../types";

interface Stat {
  cpu: number | null;
  gpuTemp: number | null;
  battery: { percent: number; charging: boolean; low: boolean } | null;
}

const R = 40;
const C = 2 * Math.PI * R;
const HISTORY = 60;

const ICON = {
  cpu: '<svg viewBox="0 0 24 24"><path d="M9 3v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9zm-2 4h10v10H7V7zm3 3v4h4v-4h-4z"/></svg>',
  gpu: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v8.3a5 5 0 1 0 6 0V5a3 3 0 0 0-3-3zm0 2a1 1 0 0 1 1 1v9.3l.4.3a3 3 0 1 1-2.8 0l.4-.3V5a1 1 0 0 1 1-1zm-1 6v5.2a2 2 0 1 0 2 0V10h-2z"/></svg>',
  bat: '<svg viewBox="0 0 24 24"><path d="M9 2h6v2h2a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2V2zM8 6v14h8V6H8z"/></svg>',
};

interface Row {
  key: "cpu" | "gpu" | "bat";
  label: string;
}
const ROWS: Row[] = [
  { key: "cpu", label: "CPU" },
  { key: "gpu", label: "显卡" },
  { key: "bat", label: "电量" },
];

function view(s: Stat) {
  const cpu = s.cpu == null ? null : Math.round(s.cpu);
  const bat = s.battery;
  return {
    cpu: { text: cpu == null ? "—" : `${cpu}%`, frac: (cpu ?? 0) / 100, warn: (cpu ?? 0) >= 90, note: "" },
    gpu: {
      text: s.gpuTemp == null ? "—" : `${s.gpuTemp}°`,
      // 30°C 到 95°C 映射到圆环
      frac: s.gpuTemp == null ? 0 : Math.min(1, Math.max(0, (s.gpuTemp - 30) / 65)),
      warn: (s.gpuTemp ?? 0) >= 85,
      note: s.gpuTemp == null ? "未读取" : "",
    },
    bat: {
      text: bat ? `${bat.percent}%` : "—",
      frac: bat ? bat.percent / 100 : 0,
      warn: !!bat?.low,
      note: bat ? (bat.charging ? "充电中" : "") : "无电池",
    },
  };
}

const status: WidgetModule = {
  kind: "status",
  name: "系统状态",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",

  create(root, opts) {
    let size: SizeKey = opts.size;
    let stat: Stat = { cpu: null, gpuTemp: null, battery: null };
    let watching = false;
    const history: number[] = [];
    let last = "";
    const cells: Record<string, { text: HTMLElement; arc?: SVGCircleElement; note: HTMLElement; box: HTMLElement }> = {};
    let line: SVGPolylineElement | null = null;
    const unlisten: Promise<UnlistenFn> = listen<Stat>("sysstat", (e) => update(e.payload));

    function build() {
      root.className = `w-status size-${size}`;
      const ring = size !== "small";
      root.innerHTML =
        `<div class="st-grid">` +
        ROWS.map(
          (r) => `
          <div class="st-cell" data-k="${r.key}">
            ${
              ring
                ? `<div class="st-ring"><svg viewBox="0 0 100 100"><circle class="st-track" cx="50" cy="50" r="${R}"/><circle class="st-arc" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg><div class="st-val"></div></div>`
                : `<span class="st-ic">${ICON[r.key]}</span><span class="st-val"></span>`
            }
            <div class="st-label">${r.label}<span class="st-note"></span></div>
          </div>`,
        ).join("") +
        `</div>` +
        (size === "large"
          ? `<div class="st-chart"><div class="st-chart-title">CPU · 最近 ${HISTORY} 次</div><svg viewBox="0 0 ${HISTORY - 1} 100" preserveAspectRatio="none"><polyline /></svg></div>`
          : "");
      for (const r of ROWS) {
        const box = root.querySelector<HTMLElement>(`[data-k="${r.key}"]`)!;
        cells[r.key] = {
          box,
          text: box.querySelector(".st-val")!,
          arc: box.querySelector<SVGCircleElement>(".st-arc") ?? undefined,
          note: box.querySelector(".st-note")!,
        };
      }
      line = root.querySelector("polyline");
      last = "";
      render();
    }

    function render() {
      const v = view(stat);
      const key = JSON.stringify(v) + history.length + (history.at(-1) ?? "");
      if (key === last) return; // 没变化就不碰页面
      last = key;
      for (const r of ROWS) {
        const c = cells[r.key];
        const d = v[r.key];
        c.text.textContent = d.text;
        c.note.textContent = d.note ? ` · ${d.note}` : "";
        c.box.classList.toggle("warn", d.warn);
        c.arc?.setAttribute("stroke-dashoffset", String(C * (1 - d.frac)));
      }
      if (line) {
        const pts = history.map((p, i) => `${i + (HISTORY - history.length)},${100 - p}`).join(" ");
        line.setAttribute("points", pts);
      }
    }

    function update(s: Stat) {
      stat = s;
      if (s.cpu != null) {
        history.push(s.cpu);
        if (history.length > HISTORY) history.shift();
      }
      render();
    }

    function watch(on: boolean) {
      if (on === watching) return;
      watching = on;
      invoke<Stat>("sysstat_watch", { on })
        .then((s) => {
          // 先用已有的显卡温度和电量把空位补上，CPU 等下一次读数
          if (on) {
            stat = { ...s, cpu: stat.cpu };
            render();
          }
        })
        .catch(() => {});
    }

    build();
    unlisten.then(() => watch(true));

    return {
      setSize(s) {
        if (s === size) return;
        size = s;
        build();
      },
      setPaused(p) {
        watch(!p);
      },
      destroy() {
        watch(false);
        unlisten.then((f) => f());
        root.replaceChildren();
      },
    };
  },
};

export default status;
