import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Alerts {
  battery: { percent: number; charging: boolean; low: boolean } | null;
  gpuHot: { temp: number } | null;
}

export type Level = "none" | "battery" | "gpu";

const shortEl = document.querySelector<HTMLElement>(".js-alert-short")!;
const longEl = document.querySelector<HTMLElement>(".js-alert-long")!;
const icons = document.querySelectorAll<SVGUseElement>(".js-alert-icon");

let level: Level = "none";
let hooks = { changed: () => {}, raised: (_l: Level) => {} };

export const alertLevel = () => level;

// 显卡过热比低电量更急，同时出现时用红色
function computeLevel(a: Alerts): Level {
  if (a.gpuHot) return "gpu";
  if (a.battery?.low) return "battery";
  return "none";
}

function apply(next: Alerts) {
  const prev = level;
  level = computeLevel(next);

  const parts: string[] = [];
  if (next.gpuHot) parts.push(`显卡 ${next.gpuHot.temp}°C，温度偏高`);
  if (next.battery?.low) parts.push(`电量 ${next.battery.percent}%，请插上电源`);
  longEl.textContent = parts.join(" · ");
  shortEl.textContent =
    level === "gpu" ? `显卡 ${next.gpuHot!.temp}°C` : level === "battery" ? `电量 ${next.battery!.percent}%` : "";
  icons.forEach((u) => u.setAttribute("href", level === "gpu" ? "#i-thermo" : "#i-battery"));
  document.body.dataset.alert = level === "none" ? "" : level;

  if (prev !== level) {
    hooks.changed();
    // 新出现、或者从低电量升级成过热，才主动提醒一次
    if (level === "gpu" || (level === "battery" && prev === "none")) hooks.raised(level);
  }
}

export function initAlerts(changed: () => void, raised: (l: Level) => void) {
  hooks = { changed, raised };
  listen<Alerts>("alerts", (e) => apply(e.payload)).then(() =>
    invoke<Alerts>("alerts_get").then(apply).catch(() => {}),
  );
}
