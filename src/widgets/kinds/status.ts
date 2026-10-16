// 系统状态：CPU 占用、显卡温度、电量。Rust 只在这个组件显示着的时候才去读（几秒一次）。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WidgetModule } from "../types";
import type { StatusData } from "../skins/types";

interface Stat {
  cpu: number | null;
  gpuTemp: number | null;
  battery: StatusData["battery"];
}

const HISTORY = 60;

const status: WidgetModule<StatusData> = {
  kind: "status",
  name: "系统状态",
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",

  model() {
    let stat: Stat = { cpu: null, gpuTemp: null, battery: null };
    const history: number[] = [];
    let watching = false;
    const subs: ((d: StatusData) => void)[] = [];

    const data = (): StatusData => ({ ...stat, history: [...history] });
    const push = () => {
      const d = data();
      subs.forEach((cb) => cb(d));
    };

    const unlisten = listen<Stat>("sysstat", (e) => {
      stat = e.payload;
      if (stat.cpu != null) {
        history.push(stat.cpu);
        if (history.length > HISTORY) history.shift();
      }
      push();
    });

    function watch(on: boolean) {
      if (on === watching) return;
      watching = on;
      invoke<Stat>("sysstat_watch", { on })
        .then((s) => {
          // 先用已有的显卡温度和电量把空位补上，CPU 等下一次读数
          if (on) {
            stat = { ...s, cpu: stat.cpu };
            push();
          }
        })
        .catch(() => {});
    }
    unlisten.then(() => watch(true));

    return {
      subscribe(cb) {
        subs.push(cb);
        cb(data());
      },
      setPaused(p) {
        watch(!p);
      },
      destroy() {
        watch(false);
        subs.length = 0;
        unlisten.then((f) => f());
      },
    };
  },
};

export default status;
