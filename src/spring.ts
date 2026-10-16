// 弹簧物理：半隐式欧拉 + 固定子步长，帧率波动时结果依然稳定
export interface SpringConfig {
  stiffness: number; // 刚度：越大越快
  damping: number; // 阻尼：越小回弹越明显
  mass?: number;
  precision?: number; // 静止判定阈值
}

const SUBSTEP = 1 / 240;

export class Spring {
  value: number;
  target: number;
  velocity = 0;

  constructor(value: number, public cfg: SpringConfig) {
    this.value = value;
    this.target = value;
  }

  step(dt: number) {
    const { stiffness: k, damping: c, mass = 1 } = this.cfg;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const force = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += (force / mass) * h;
      this.value += this.velocity * h;
    }
    if (this.resting) {
      this.value = this.target;
      this.velocity = 0;
    }
  }

  get resting() {
    const p = this.cfg.precision ?? 0.01;
    return Math.abs(this.velocity) < p * 10 && Math.abs(this.value - this.target) < p;
  }
}

// 统一的动画循环：只有弹簧在动时才跑 requestAnimationFrame，静止后立刻停，空闲零重绘
export class Animator {
  private springs: Spring[] = [];
  private running = false;
  private last = 0;
  private frameTimes: number[] = [];

  constructor(
    private onFrame: () => void,
    private onSettle?: (frameTimes: number[]) => void,
  ) {}

  add(s: Spring) {
    this.springs.push(s);
    return s;
  }

  /** 不再需要的弹簧（比如组件被移除了）从循环里拿掉 */
  remove(...list: Spring[]) {
    this.springs = this.springs.filter((s) => !list.includes(s));
  }

  kick() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frameTimes = [];
    requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    // 限制 dt，避免窗口被挂起后一帧跳太远
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.frameTimes.push(now - this.last);
    this.last = now;
    for (const s of this.springs) s.step(dt);
    this.onFrame();
    if (this.springs.every((s) => s.resting)) {
      this.running = false;
      this.onSettle?.(this.frameTimes.slice(1));
      return;
    }
    requestAnimationFrame(this.tick);
  };
}
