// 时钟和日期：开了秒就每秒推一次，否则每分钟推一次（对准整秒 / 整分钟）
import type { WidgetModule } from "../types";
import type { ClockData } from "../skins/types";

const clock: WidgetModule<ClockData> = {
  kind: "clock",
  name: "时钟和日期",
  sizes: ["small", "medium", "large"],
  defaultSize: "small",
  settings: [
    { key: "seconds", label: "显示秒", default: false },
    { key: "hour12", label: "12 小时制", default: false },
  ],

  model(settings) {
    let seconds = settings.seconds === true;
    let hour12 = settings.hour12 === true;
    let paused = false;
    let timer = 0;
    const subs: ((d: ClockData) => void)[] = [];

    function tick() {
      window.clearTimeout(timer);
      const now = new Date();
      subs.forEach((cb) => cb({ now, seconds, hour12 }));
      if (paused) return;
      const ms = seconds ? 1000 - now.getMilliseconds() : 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
      timer = window.setTimeout(tick, ms + 15);
    }

    return {
      subscribe(cb) {
        subs.push(cb);
        cb({ now: new Date(), seconds, hour12 });
        if (subs.length === 1) tick();
      },
      setSettings(s) {
        seconds = s.seconds === true;
        hour12 = s.hour12 === true;
        tick();
      },
      setPaused(p) {
        paused = p;
        if (p) window.clearTimeout(timer);
        else tick();
      },
      destroy() {
        window.clearTimeout(timer);
        subs.length = 0;
      },
    };
  },
};

export default clock;
