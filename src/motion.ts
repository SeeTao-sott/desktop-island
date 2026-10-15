// 灵动岛和架子共用的弹簧参数，保证两边动起来是同一种手感
export const SPRING = {
  // 形变：带一点回弹
  shape: { stiffness: 420, damping: 28, precision: 0.05 },
  // 淡入淡出：阻尼更大，文字不晃
  fade: { stiffness: 520, damping: 40, precision: 0.002 },
  // 滑动：介于两者之间，滑到位轻轻停住
  slide: { stiffness: 420, damping: 34, precision: 0.05 },
};

// 开发模式下统计一次动画的帧率，只在动画期间计数
export function fpsReporter(el: HTMLElement) {
  return (frames: number[]) => {
    if (!import.meta.env.DEV || frames.length < 3) return;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const worst = Math.max(...frames);
    el.hidden = false;
    el.textContent = `动画 ${Math.round(1000 / avg)} fps · 最慢一帧 ${worst.toFixed(1)}ms · ${frames.length} 帧`;
  };
}
