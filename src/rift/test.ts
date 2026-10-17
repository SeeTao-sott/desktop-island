// 裂缝射击 · 阶段 0 可行性测试（不是游戏）：
// 1. 全屏透明窗口里，只在屏幕中间一条横带用 Three.js 画 3D 靶场，横带外面完全透明，测帧率
// 2. 试 requestPointerLock({ unadjustedMovement: true })（原始输入，不受 Windows 鼠标加速影响）
// 3. Esc：释放鼠标、关窗口
// 结果都写到 Rust 的日志里（rift_log）。
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";

const log = (msg: string) => invoke("rift_log", { msg }).catch(() => {});
const hud = document.getElementById("hud")!;
const band = document.getElementById("band")!;

// ---------- 横带：屏幕高度的 40%，居中 ----------
const W = window.innerWidth;
const H = window.innerHeight;
const BH = Math.round(H * 0.4);
const BY = Math.round((H - BH) / 2);
band.style.top = `${BY}px`;
band.style.height = `${BH}px`;
hud.style.top = `${BY + 12}px`;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, BH);
renderer.setClearColor(0x000000, 1); // 横带里是不透明的靶场
band.appendChild(renderer.domElement);
const gl = renderer.getContext();
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "未知";
log(`WebGL 渲染器: ${gpu}；画布 ${W}x${BH} css，像素比 ${window.devicePixelRatio}`);

// ---------- 场景：地面、侧墙、9×4 靶墙、灯光 ----------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b0b12, 18, 60);
const camera = new THREE.PerspectiveCamera(70, W / BH, 0.1, 200);
camera.position.set(0, 1.6, 0);
const accent = new THREE.Color(0xff5a6a);

scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.position.z = -20;
scene.add(floor);
for (const x of [-9, 9]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 60), new THREE.MeshStandardMaterial({ color: 0x23233a }));
  wall.position.set(x, 4, -20);
  scene.add(wall);
}
const back = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 0.4), new THREE.MeshStandardMaterial({ color: 0x15151f }));
back.position.set(0, 4, -20);
scene.add(back);
const targets: THREE.Mesh[] = [];
const tgeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 40);
for (let r = 0; r < 4; r++)
  for (let c = 0; c < 9; c++) {
    const m = new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35 }));
    m.rotation.x = Math.PI / 2;
    m.position.set((c - 4) * 1.7, 1 + r * 1.6, -19.6);
    scene.add(m);
    targets.push(m);
  }
// 灯带
for (let i = 0; i < 12; i++) {
  const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3), new THREE.MeshBasicMaterial({ color: accent }));
  l.position.set(i % 2 ? 8.7 : -8.7, 6, -i * 5);
  scene.add(l);
}

// ---------- 视角（鼠标锁定后转动） ----------
let yaw = 0;
let pitch = 0;
let moveSum = { x: 0, y: 0, events: 0 };
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== document.body) return;
  moveSum.x += e.movementX;
  moveSum.y += e.movementY;
  moveSum.events++;
  yaw -= e.movementX * 0.0015;
  pitch = Math.max(-0.4, Math.min(0.4, pitch - e.movementY * 0.0015));
});

// ---------- Pointer Lock ----------
let lockMode = "未锁定";
let wantClose = false;
async function lock() {
  try {
    // Chromium 里返回 Promise；不支持原始输入时会以 NotSupportedError 拒绝
    await (document.body.requestPointerLock as (o?: object) => Promise<void>)({ unadjustedMovement: true });
    lockMode = "原始输入（unadjustedMovement）";
    log("Pointer Lock：unadjustedMovement 成功");
  } catch (err) {
    log(`Pointer Lock：unadjustedMovement 失败 ${(err as Error)?.name}: ${(err as Error)?.message}，退回普通锁定`);
    try {
      await (document.body.requestPointerLock as () => Promise<void> | void)();
      lockMode = "普通锁定（有鼠标加速）";
      log("Pointer Lock：普通锁定成功");
    } catch (e2) {
      lockMode = "锁定失败";
      log(`Pointer Lock：普通锁定也失败 ${(e2 as Error)?.name}: ${(e2 as Error)?.message}`);
    }
  }
}
document.addEventListener("mousedown", () => {
  if (!document.pointerLockElement) lock();
});
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === document.body;
  log(`pointerlockchange：${locked ? "已锁定" : "已释放"}`);
  if (!locked && lockMode !== "未锁定") {
    // 锁定中按 Esc：浏览器先自己释放锁定（这一下 keydown 可能收不到），当作退出
    log("锁定被释放（多半是按了 Esc）→ 退出");
    close("释放锁定");
  }
});
document.addEventListener("pointerlockerror", () => log("pointerlockerror"));
window.addEventListener("keydown", (e) => {
  log(`keydown ${e.key}`);
  if (e.key === "Escape") close("keydown Esc");
});
function close(why: string) {
  if (wantClose) return;
  wantClose = true;
  log(`关闭（${why}）`);
  invoke("rift_test_close").catch(() => {});
}

// ---------- 帧率统计：每 2 秒报一次 ----------
let frames: number[] = [];
let last = performance.now();
let lastReport = last;
const t0 = last;
function frame(now: number) {
  frames.push(now - last);
  last = now;
  const t = (now - t0) / 1000;
  targets.forEach((m, i) => (m.scale.setScalar(0.8 + 0.2 * Math.sin(t * 3 + i))));
  camera.rotation.set(pitch, yaw, 0, "YXZ");
  renderer.render(scene, camera);
  if (now - lastReport > 2000) {
    const sorted = [...frames].sort((a, b) => a - b);
    const avg = 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const worst = sorted[sorted.length - 1];
    const msg = `FPS 平均 ${avg.toFixed(1)}，99% 帧耗时 ≤ ${p99.toFixed(1)}ms，最慢一帧 ${worst.toFixed(1)}ms（${frames.length} 帧）`;
    log(msg);
    hud.textContent = `${msg}\n鼠标：${lockMode}；累计移动 x=${moveSum.x} y=${moveSum.y}（${moveSum.events} 次）\n点击锁定鼠标 · 移动看看 · Esc 退出`;
    frames = [];
    lastReport = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
log(`测试窗口已打开：${W}x${H} css`);
