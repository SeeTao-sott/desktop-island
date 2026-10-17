// 裂缝射击（阶段 1：裂缝和靶场）
//
// 整个窗口透明。一张 WebGL 画布盖住"裂缝最大时"的那一条横带：
//   1. 先按"全屏视角"画 3D 靶场（setViewOffset 只画横带这一段，透视和全屏时一样）
//   2. 再用上下两块参差不齐的形状把裂缝以外擦成完全透明 → 外面看到的还是原来的桌面
//   3. 最后沿裂缝上下边画两条发光的光带（自己算的三角形带子，不用模糊滤镜）
// 靶墙是 9 列 × N 行（N = 1~4）。每行在屏幕上的高度固定，裂缝高度 = N 行 + 上下留白；
// N 变化时裂缝高度、各行位置、行的淡入淡出都跟着一个弹簧走，约 0.5 秒平滑过渡。
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Spring } from "../spring";
import { buildSettings, drawCrosshair, loadSettings, saveSettings } from "./hud";
import { capSteps, densitySchedule, nAt, planTargets, type NStep, type Shot, type Target } from "./plan";

// ---------------- 可调的参数 ----------------
/** N = 4 时裂缝占屏幕高度的比例（以后放进设置） */
const MAX_FRAC = loadSettings().maxFrac;
/** 裂缝上下各留多少像素（格子到裂缝边） */
const MARGIN = 26;
/** 裂缝边缘参差的幅度（像素） */
const JAG = 16;
/** 发光带的宽度（像素） */
const GLOW = 30;
/** 水平视野（度），和 Valorant 默认一样 */
const HFOV = loadSettings().fov;
/** 靶墙离眼睛多远（米） */
const WALL_Z = 14;
/** 房间按最多 9 列的宽度建；实际列数在设置里（默认 6） */
const MAX_COLS = 9;
const settings = loadSettings();
let COLS = settings.cols;
/** 镜头距离倍数：镜头往后拉，靶墙在屏幕上变小（裂缝、视角范围都跟着缩） */
let ZOOM = settings.zoom;

const W = window.innerWidth;
const H = window.innerHeight;
const CY = H / 2;
/** 一行格子在屏幕上的高度：N=4 时正好占满 MAX_FRAC */
const CELL_PX = (H * MAX_FRAC - MARGIN * 2) / 4;
/** 画布：裂缝最大时的高度 + 参差 + 发光的余量 */
const CANVAS_H = Math.ceil(H * MAX_FRAC + (JAG + GLOW) * 2 + 8);
const CANVAS_TOP = Math.round(CY - CANVAS_H / 2);

const log = (msg: string) => invoke("rift_log", { msg }).catch(() => {});

// ---------------- 颜色：跟壁纸 ----------------
type Rgba = [number, number, number, number];
interface Theme {
  accent: Rgba;
  bg: Rgba;
}
const accent = new THREE.Color(0x8caaff);
function applyTheme(t: Theme | null) {
  if (t) accent.setRGB(t.accent[0] / 255, t.accent[1] / 255, t.accent[2] / 255, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  accent.getHSL(hsl);
  // 主题色调亮调艳一点，压在深色靶场里才显眼
  accent.setHSL(hsl.h, Math.max(0.7, hsl.s), Math.min(0.62, Math.max(0.5, hsl.l)));
  const tint = (s: number, l: number) => new THREE.Color().setHSL(hsl.h, s, l);
  mats.floor.color = tint(0.22, 0.06);
  mats.side.color = tint(0.28, 0.09);
  mats.wall.color = tint(0.3, 0.07);
  for (const r of rows) {
    r.cell.color = tint(0.32, 0.14);
    r.cell.emissive = accent.clone().multiplyScalar(0.06);
    r.edge.color = accent.clone();
  }
  mats.strip.color = accent.clone();
  hemi.color = tint(0.4, 0.75);
  hemi.groundColor = tint(0.4, 0.05);
  key.color = accent.clone().lerp(new THREE.Color(0xffffff), 0.6);
  glowMat.uniforms.color.value = accent.clone();
  document.documentElement.style.setProperty("--w-accent", `#${accent.getHexString()}`);
  scene.fog = new THREE.Fog(tint(0.3, 0.03), WALL_Z * ZOOM * 0.9, WALL_Z * (ZOOM + 1.6));
}

// ---------------- 渲染器、相机 ----------------
const canvas = document.getElementById("view") as HTMLCanvasElement;
canvas.style.top = `${CANVAS_TOP}px`;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, CANVAS_H);
renderer.autoClear = false;
renderer.setClearColor(0x000000, 0);

const aspect = W / H;
const vfov = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / aspect) * 180) / Math.PI;
const camera = new THREE.PerspectiveCamera(vfov, aspect, 0.1, 200);
// 只画全屏画面里横带那一段：透视和全屏时完全一样
camera.setViewOffset(W, H, 0, CANVAS_TOP, W, CANVAS_H);
camera.position.set(0, 0, WALL_Z * (ZOOM - 1));
/** 屏幕上 1 像素 = 靶墙上多少米 */
const focalPx = H / 2 / Math.tan((vfov * Math.PI) / 360);
const CELL = (CELL_PX * WALL_Z) / focalPx;

// ---------------- 靶场 ----------------
const scene = new THREE.Scene();
const mats = {
  floor: new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1 }),
  side: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
  wall: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
  cell: new THREE.MeshStandardMaterial({ roughness: 0.5, transparent: true }),
  cellEdge: new THREE.MeshBasicMaterial({ transparent: true }),
  strip: new THREE.MeshBasicMaterial(),
};
const hemi = new THREE.HemisphereLight(0xffffff, 0x101018, 0.9);
scene.add(hemi);
const key = new THREE.PointLight(0xffffff, 60, 0, 1.6);
key.position.set(0, 1, -WALL_Z * 0.45);
scene.add(key);

const ROOM_W = CELL * MAX_COLS + CELL * 3;
const ROOM_H = CELL * 4 + CELL * 2.2;
const floorY = -ROOM_H / 2;
// 地面、侧墙往后多铺一段：镜头往后拉时也还在房间里
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, WALL_Z * 5), mats.floor);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, floorY, WALL_Z * 1.5);
scene.add(floor);
const ceil = floor.clone();
ceil.rotation.x = Math.PI / 2;
ceil.position.y = -floorY;
scene.add(ceil);
for (const sx of [-1, 1]) {
  const side = new THREE.Mesh(new THREE.PlaneGeometry(WALL_Z * 5, ROOM_H), mats.side);
  side.rotation.y = (-sx * Math.PI) / 2;
  side.position.set((sx * ROOM_W) / 2, 0, WALL_Z * 1.5);
  scene.add(side);
  // 侧墙上两条灯带，往靶墙方向延伸
  for (const sy of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, WALL_Z * 1.4), mats.strip);
    strip.position.set(sx * (ROOM_W / 2 - 0.03), sy * CELL * 2.6, -WALL_Z * 0.7);
    scene.add(strip);
  }
}
const wall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), mats.wall);
wall.position.z = -WALL_Z;
scene.add(wall);

// 列数 × 4 行格子：每行一组，行的位置和透明度跟着 N 的弹簧走
// 绘制顺序固定：格子 → 靶子 → 特效。半透明物体默认按"离相机多远"排顺序，
// 靠边的靶子会被排到格子前面先画、再被格子盖住（看不见但打得到），所以写死顺序，格子也不写深度
const rows: { group: THREE.Group; cell: THREE.MeshStandardMaterial; edge: THREE.MeshBasicMaterial }[] = [];
const cellGeo = new THREE.PlaneGeometry(CELL * 0.86, CELL * 0.86);
const edgeGeo = new THREE.EdgesGeometry(cellGeo);
for (let r = 0; r < 4; r++) {
  const group = new THREE.Group();
  const cell = mats.cell.clone();
  cell.depthWrite = false;
  const edge = mats.cellEdge.clone();
  group.position.z = -WALL_Z;
  scene.add(group);
  rows.push({ group, cell, edge });
}
/** 按现在的列数摆格子（设置里改了列数会重新摆） */
function buildCells() {
  for (const r of rows) {
    r.group.clear();
    for (let c = 0; c < COLS; c++) {
      const m = new THREE.Mesh(cellGeo, r.cell);
      m.position.set((c - (COLS - 1) / 2) * CELL, 0, 0.01);
      m.renderOrder = 0;
      r.group.add(m);
      const e = new THREE.LineSegments(edgeGeo, r.edge);
      e.position.copy(m.position).setZ(0.02);
      e.renderOrder = 1;
      r.group.add(e);
    }
  }
}
buildCells();

// ---------------- 射击特效：命中光圈、弹孔、枪口照亮 ----------------
const fxGroup = new THREE.Group();
scene.add(fxGroup);
interface Fx {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  born: number;
  life: number;
  grow: number;
}
const fxPool: Fx[] = [];
const ringGeo = new THREE.RingGeometry(CELL * 0.1, CELL * 0.16, 40);
const holeGeo = new THREE.CircleGeometry(CELL * 0.05, 20);
function spawnFx(geo: THREE.BufferGeometry, color: THREE.Color, at: THREE.Vector3, life: number, grow: number, additive: boolean) {
  let fx = fxPool.find((f) => !f.mesh.visible && f.mesh.geometry === geo);
  if (!fx) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    fx = { mesh: new THREE.Mesh(geo, mat), mat, born: 0, life, grow };
    fx.mesh.renderOrder = 20;
    fxGroup.add(fx.mesh);
    fxPool.push(fx);
  }
  fx.mat.color.copy(color);
  fx.mesh.position.copy(at);
  fx.mesh.visible = true;
  fx.born = performance.now();
  fx.life = life;
  fx.grow = grow;
  return fx;
}
function updateFx(now: number) {
  for (const f of fxPool) {
    if (!f.mesh.visible) continue;
    const k = (now - f.born) / f.life;
    if (k >= 1) {
      f.mesh.visible = false;
      continue;
    }
    f.mesh.scale.setScalar(1 + f.grow * k);
    f.mat.opacity = 1 - k * k;
  }
}
// 开枪时把靶场照亮一下
const muzzleLight = new THREE.PointLight(0xffd08a, 0, 0, 1.4);
muzzleLight.position.set(0.4, -0.3, -1);
scene.add(muzzleLight);

// ---------------- 靶子 ----------------
// 一个靶子 = 圆盘 + 中心亮点 + 往里收的外圈；外圈收到贴住圆盘边的那一刻就是拍点
const TARGET_R = CELL * 0.3;
const discGeo = new THREE.CircleGeometry(TARGET_R, 48);
const coreGeo = new THREE.CircleGeometry(TARGET_R * 0.26, 32);
const approachGeo = new THREE.RingGeometry(TARGET_R * 0.96, TARGET_R * 1.1, 64);
// 颜色：平时统一用壁纸主色；到了能打的时候（判定窗口以内，一对靶子含宽限）变成绿色
const GREEN = new THREE.Color(0x35ff7a);
/** 同一时刻要一起打的一组：金色，中间连一条金线；右键打中其中一个，整组都算 */
const GOLD = new THREE.Color(0xffc53d);
const DIM = new THREE.Color();
interface LiveTarget {
  tg: Target;
  group: THREE.Group;
  disc: THREE.Mesh;
  discMat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  /** 打中或错过之后淡出的起点（ms），0 = 还活着 */
  gone: number;
  /** 出现的时刻、准星第一次落到它上面的时刻（歌曲秒） */
  spawnAt: number;
  seenAt: number | null;
}
const targetLayer = new THREE.Group();
scene.add(targetLayer);
const targetPool: LiveTarget[] = [];
function takeTarget(tg: Target): LiveTarget {
  let lt = targetPool.pop();
  if (!lt) {
    const group = new THREE.Group();
    const discMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const disc = new THREE.Mesh(discGeo, discMat);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.z = 0.01;
    const ring = new THREE.Mesh(approachGeo, ringMat);
    ring.position.z = 0.02;
    disc.renderOrder = 10;
    core.renderOrder = 11;
    ring.renderOrder = 12;
    group.add(disc, core, ring);
    lt = { tg, group, disc, discMat, coreMat, ring, ringMat, gone: 0, spawnAt: 0, seenAt: null };
  }
  lt.tg = tg;
  lt.gone = 0;
  lt.seenAt = null;
  // 颜色每帧在 updateSong 里定（一组里两个都还在才是金色）
  lt.discMat.color.copy(accent);
  lt.ringMat.color.copy(accent);
  lt.group.scale.setScalar(1);
  targetLayer.add(lt.group);
  return lt;
}
function dropTarget(lt: LiveTarget) {
  targetLayer.remove(lt.group);
  targetPool.push(lt);
}

// ---------------- 裂缝：擦掉外面 + 发光边 ----------------
// 在画布像素坐标里画（y 向下），用正交相机
const overlay = new THREE.Scene();
const ortho = new THREE.OrthographicCamera(0, W, 0, CANVAS_H, -1, 1);

const P = 120; // 沿水平方向的点数
/** 固定的参差形状（同一次运行里不变），上下两条不一样 */
function jagProfile(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const raw = Array.from({ length: P }, rnd);
  // 平滑两遍，再叠一点尖刺，像撕开的边
  const out = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] * 2 + raw[Math.min(P - 1, i + 1)]) / 4);
  return out.map((v, i) => v * 0.75 + (i % 7 === 3 ? rnd() * 0.5 : 0));
}
const jagTop = jagProfile(9137);
const jagBot = jagProfile(4211);

// 擦除：上下两块（画布顶到上边缘、下边缘到画布底），写入完全透明
const eraseGeo = new THREE.BufferGeometry();
const erasePos = new Float32Array((P - 1) * 2 * 6 * 3);
eraseGeo.setAttribute("position", new THREE.BufferAttribute(erasePos, 3));
// 画布坐标 y 向下，三角形会被当成背面剔掉：两面都画
const eraseMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.NoBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
overlay.add(new THREE.Mesh(eraseGeo, eraseMat));

// 发光带：每条边一条三角形带子，side 从 -1（外）到 1（里）
const glowGeo = new THREE.BufferGeometry();
const glowPos = new Float32Array(2 * P * 2 * 3);
const glowSide = new Float32Array(2 * P * 2);
const glowIdx: number[] = [];
for (let e = 0; e < 2; e++)
  for (let i = 0; i < P - 1; i++) {
    const a = e * P * 2 + i * 2;
    glowIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
for (let e = 0; e < 2; e++) for (let i = 0; i < P; i++) glowSide.set([-1, 1], e * P * 2 + i * 2);
glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3));
glowGeo.setAttribute("side", new THREE.BufferAttribute(glowSide, 1));
glowGeo.setIndex(glowIdx);
const glowMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color() }, strength: { value: 1 } },
  vertexShader: /* glsl */ `
    attribute float side;
    varying float vSide;
    void main() { vSide = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform float strength;
    varying float vSide;
    void main() {
      // 贴边那一线最亮（白芯），往外很快暗下去，往里（裂缝内）稍微多留一点光
      float d = vSide < 0.0 ? -vSide * 1.6 : vSide;
      float core = exp(-d * d * 60.0);
      float halo = exp(-d * 3.2) * 0.75;
      float a = clamp((core + halo) * strength, 0.0, 1.0);
      vec3 c = mix(color, vec3(1.0), core * 0.8);
      gl_FragColor = vec4(c * a, a); // 预乘透明度：裂缝外面（透明处）也能看到光
    }`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
});
overlay.add(new THREE.Mesh(glowGeo, glowMat));

/** 按当前裂缝的半高更新擦除区域和发光带（open：0 合上 ~ 1 全开） */
function updateRift(half: number, open: number) {
  const cy = CY - CANVAS_TOP;
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i < P; i++) {
    const u = i / (P - 1);
    // 两头稍微收窄一点，像从中间撕开
    const taper = 0.72 + 0.28 * Math.sin(Math.PI * u);
    const h = half * taper;
    const jag = JAG * Math.min(1, open * 1.5);
    top.push(cy - h + jagTop[i] * jag);
    bot.push(cy + h + jagBot[i] * jag);
  }
  // 合上时上下边重合成一条线，不能交叉
  for (let i = 0; i < P; i++) if (top[i] > bot[i]) top[i] = bot[i] = (top[i] + bot[i]) / 2;
  let k = 0;
  const quad = (x0: number, y0a: number, y0b: number, x1: number, y1a: number, y1b: number) => {
    erasePos.set([x0, y0a, 0, x1, y1a, 0, x1, y1b, 0, x0, y0a, 0, x1, y1b, 0, x0, y0b, 0], k);
    k += 18;
  };
  for (let i = 0; i < P - 1; i++) {
    const x0 = (i / (P - 1)) * W;
    const x1 = ((i + 1) / (P - 1)) * W;
    quad(x0, 0, top[i], x1, 0, top[i + 1]);
    quad(x0, bot[i], CANVAS_H, x1, bot[i + 1], CANVAS_H);
  }
  eraseGeo.attributes.position.needsUpdate = true;
  for (let i = 0; i < P; i++) {
    const x = (i / (P - 1)) * W;
    const t = e0(0, i);
    glowPos.set([x, top[i] - GLOW, 0, x, top[i] + GLOW * 0.6, 0], t);
    const b = e0(1, i);
    glowPos.set([x, bot[i] + GLOW, 0, x, bot[i] - GLOW * 0.6, 0], b);
  }
  glowGeo.attributes.position.needsUpdate = true;
}
const e0 = (edge: number, i: number) => (edge * P * 2 + i * 2) * 3;

// ---------------- N 和开合 ----------------
/** N 的连续值：裂缝高度、各行位置都跟着它（临界阻尼，约 0.5 秒到位） */
const nSpring = new Spring(1, { stiffness: 70, damping: 16.7, precision: 0.001 });
/** 撕开 / 合上：撕开时稍微回弹一下 */
const openSpring = new Spring(0, { stiffness: 90, damping: 13, precision: 0.001 });
let closing = false;

function setN(n: number) {
  nSpring.target = Math.min(4, Math.max(1, n));
  document.querySelectorAll<HTMLButtonElement>("#test button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === n));
}

function layoutRows(n: number) {
  for (let r = 0; r < 4; r++) {
    // 第 r 行（从上往下），所有行整体居中在视线高度
    const y = ((n - 1) / 2 - r) * CELL;
    const vis = Math.min(1, Math.max(0, n - r));
    const row = rows[r];
    row.group.position.y = y;
    row.group.visible = vis > 0.01;
    row.group.scale.setScalar(0.85 + 0.15 * vis);
    row.cell.opacity = vis;
    row.edge.opacity = vis * 0.9;
  }
}

// ---------------- 瞄准：鼠标锁定、视角、射击 ----------------
const crossEl = document.getElementById("cross")!;
const flashEl = document.getElementById("flash")!;
const startEl = document.getElementById("start")!;
const infoEl = document.getElementById("info")!;
drawCrosshair(crossEl, settings);
buildSettings(document.getElementById("settings")!, settings, (st) => {
  drawCrosshair(crossEl, st);
  if (st.cols !== COLS) {
    COLS = st.cols;
    buildCells();
  }
  if (st.zoom !== ZOOM) {
    ZOOM = st.zoom;
    applyZoom();
  }
  LEAD = st.lead;
  if (st.maxFrac !== MAX_FRAC || st.fov !== HFOV) {
    // 裂缝最大高度、视野决定了整个画面的尺寸：停一下手再重新载入（这首歌记在 sessionStorage 里）
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      try {
        if (song.pick) sessionStorage.setItem("rift-pick", JSON.stringify(song.pick));
      } catch {
        // 记不住就回到测试模式
      }
      location.reload();
    }, 900);
  }
  // 最多行数改了：按新上限重排时间表（还没开始时裂缝马上跟着变）
  if (song.on && !song.running) {
    song.steps = capSteps(song.rawSteps, st.rows);
    setN(nAt(song.steps, -1));
  }
  saveSettings(st);
  showInfo();
});

let reloadTimer = 0;
/** 准星指向（弧度）：yaw 左右、pitch 上下（往上为正） */
let aimYaw = 0;
let aimPitch = 0;
/** 后坐只是画面往上踢一下再回来，不改准星指向 */
let recoil = 0;
let lockMode = "";
let playing = false;
/** 左右能转到靶墙两边的格子，上下只能到当前 N 行的上下边（N=1 时几乎不能动） */
const yawMax = () => Math.atan(((COLS / 2) * CELL) / (WALL_Z * ZOOM));
const pitchMax = (n: number) => Math.atan(((n / 2) * CELL * 0.92) / (WALL_Z * ZOOM));

/** 改了镜头距离：挪镜头、调雾 */
function applyZoom() {
  camera.position.z = WALL_Z * (ZOOM - 1);
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.near = WALL_Z * ZOOM * 0.9;
    scene.fog.far = WALL_Z * (ZOOM + 1.6);
  }
}

function showInfo() {
  const delay = song.on ? ` · 延迟 ${song.offsetMs > 0 ? "+" : ""}${song.offsetMs}ms（← →）` : "";
  infoEl.textContent = `灵敏度 ${settings.sens}（Valorant）· ${lockMode || "鼠标未锁定"}${delay}\nEsc 退出`;
}

async function lock() {
  try {
    // 原始输入：不受 Windows 鼠标加速影响，和游戏里一样
    await (document.body.requestPointerLock as (o?: object) => Promise<void>)({ unadjustedMovement: true });
    lockMode = "原始输入";
  } catch {
    try {
      await (document.body.requestPointerLock as () => Promise<void> | void)();
      lockMode = "普通锁定（有鼠标加速）";
    } catch (e) {
      log(`鼠标锁定失败：${(e as Error)?.message}`);
      return;
    }
  }
  log(`鼠标锁定：${lockMode}`);
}
startEl.querySelector(".start-go")!.addEventListener("click", () => lock());

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === document.body;
  if (locked) {
    playing = true;
    startEl.hidden = true;
    crossEl.hidden = false;
    if (song.on && !song.running && !song.finished) showPrompt(song.audio ? "按空格开始" : "正在载入歌曲…");
  } else if (playing) {
    // 锁定中按 Esc：浏览器自己先释放锁定（这一下 Esc 页面收不到），当作退出
    playing = false;
    close();
  }
  showInfo();
});

document.addEventListener("mousemove", (e) => {
  if (!playing) return;
  // Valorant：每个移动单位转 0.07 × 灵敏度 度
  const k = ((0.07 * settings.sens) * Math.PI) / 180;
  aimYaw = Math.min(yawMax(), Math.max(-yawMax(), aimYaw - e.movementX * k));
  aimPitch -= e.movementY * k;
});

const ray = new THREE.Raycaster();
const aimDir = new THREE.Vector3();
const aimEuler = new THREE.Euler();
const shotColor = new THREE.Color(0xffffff);
// 左键：打一个；右键：打中一组（金色）里的一个，整组都算
document.addEventListener("mousedown", (e) => {
  if (!playing || (e.button !== 0 && e.button !== 2)) return;
  shoot(e.button === 2);
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

function shoot(whole = false) {
  // 射线从眼睛沿准星方向（不含后坐）
  aimEuler.set(aimPitch, aimYaw, 0, "YXZ");
  aimDir.set(0, 0, -1).applyEuler(aimEuler);
  ray.set(camera.position, aimDir);
  // 右键只对金色（还成对的一组）有效：没瞄着金色靶子就什么都不做（不开枪、不算 Miss）
  if (whole && !aimingAtGold()) return;
  const hitTarget = shootTargets(whole);
  const targets: THREE.Object3D[] = [];
  for (const r of rows) if (r.group.visible && r.cell.opacity > 0.5) for (const c of r.group.children) if ((c as THREE.Mesh).isMesh) targets.push(c);
  const hit = hitTarget ? undefined : ray.intersectObjects(targets, false)[0];
  const wallHit = hitTarget ? undefined : (hit ?? ray.intersectObject(wall, false)[0]);
  if (wallHit) {
    const p = wallHit.point.clone().setZ(-WALL_Z + 0.05);
    // 弹孔：深色小圆点，慢慢淡掉
    spawnFx(holeGeo, new THREE.Color(0x050505), p, 2500, 0, false);
    if (hit) {
      // 打中格子：一圈亮环往外扩 + 一团光
      spawnFx(ringGeo, accent.clone().lerp(shotColor, 0.35), p.clone().setZ(p.z + 0.02), 380, 2.4, true);
      spawnFx(ringGeo, shotColor, p.clone().setZ(p.z + 0.03), 180, 1.0, true);
    }
  }
  // 后坐：画面往上踢一下（准星不动）
  recoil = Math.min(0.03, recoil + 0.012);
  // 枪口闪光：在裂缝里、准星右下方
  const half = currentHalf();
  const fx = W / 2 + Math.min(W * 0.3, 380);
  const fy = CY + Math.max(10, Math.min(half - 30, 140));
  flashEl.style.left = `${fx}px`;
  flashEl.style.top = `${fy}px`;
  flashEl.animate(
    [
      { transform: "scale(0.5) rotate(0deg)", opacity: 1 },
      { transform: "scale(1.15) rotate(25deg)", opacity: 0 },
    ],
    { duration: 70, easing: "ease-out" },
  );
  muzzleLight.intensity = 30;
}

let halfNow = 0;
const currentHalf = () => halfNow;

// ---------------- 一首歌：谱、放歌、判定 ----------------
interface SongEntry {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  offset_ms: number;
}
interface Pick {
  id: string;
  characteristic: string;
  difficulty: string;
}
/** 靶子提前多久出现（秒），设置里可调 */
let LEAD = settings.lead;
/** 判定窗口（秒）：Great 前后 greatW，Perfect 是一半；一对靶子晚的那一侧再加宽限（都在设置里） */
const greatW = () => settings.window / 1000;
const perfectW = () => settings.window / 2000;
const lateW = (tg: Target) => greatW() + (tg.pair ? settings.pairGrace / 1000 : 0);
const song = {
  on: false, // 是选歌进来的（不是托盘里的测试）
  meta: null as SongEntry | null,
  pick: null as Pick | null,
  shots: [] as Shot[],
  rawSteps: [] as NStep[], // 按密度分的 1~4 档（没压过）
  targets: [] as Target[],
  steps: [] as NStep[],
  audio: null as AudioBuffer | null,
  next: 0, // 下一个还没出现的靶子
  live: [] as LiveTarget[],
  running: false,
  starting: false,
  finished: false,
  startAt: 0,
  offsetMs: 0,
  count: { perfect: 0, great: 0, miss: 0 },
  combo: 0,
  maxCombo: 0,
  /** 打中时的时间偏差（秒，负 = 偏早）、甩枪时间（秒） */
  devs: [] as number[],
  flicks: [] as number[],
  /** 上一枪的时刻（歌曲秒），算"从上一枪到准星落上下一个靶子"用 */
  lastShot: -Infinity,
};
let actx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
const promptEl = document.createElement("div");
promptEl.className = "prompt";
promptEl.hidden = true;
document.body.appendChild(promptEl);
const judgeEl = document.createElement("div");
judgeEl.className = "judge";
document.body.appendChild(judgeEl);
const comboEl = document.createElement("div");
comboEl.className = "combo";
document.body.appendChild(comboEl);

function showPrompt(text: string) {
  promptEl.textContent = text;
  promptEl.hidden = !text;
}

/** 音频时钟此刻"正从扬声器出来"的位置（秒），getOutputTimestamp 已含输出延迟 */
function audioNow() {
  const ts = actx!.getOutputTimestamp();
  if (ts.contextTime !== undefined && ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  return actx!.currentTime - (actx!.outputLatency || actx!.baseLatency || 0);
}
/** 歌放到第几秒（扣掉偏移：偏移为正，靶子整体晚一点） */
const songTime = () => audioNow() - song.startAt - song.offsetMs / 1000;

async function loadSong(pick: Pick) {
  song.on = true;
  song.pick = pick;
  document.getElementById("test")!.hidden = true;
  showPrompt("正在载入歌曲…");
  const list = await invoke<SongEntry[]>("rhythm_songs").catch(() => [] as SongEntry[]);
  song.meta = list.find((x) => x.id === pick.id) ?? null;
  song.offsetMs = song.meta?.offset_ms ?? 0;
  let shots: Shot[] = [];
  try {
    shots = await invoke<Shot[]>("rhythm_shots", { id: pick.id, characteristic: pick.characteristic, difficulty: pick.difficulty });
  } catch (e) {
    log(`读谱失败：${e}`);
  }
  const bpm = song.meta?.bpm ?? 120;
  song.rawSteps = densitySchedule(shots, bpm);
  song.steps = capSteps(song.rawSteps, settings.rows);
  song.shots = shots;
  song.targets = planTargets(shots, song.steps, song.meta?.title ?? pick.id, LEAD, COLS);
  const tiers = [1, 2, 3, 4].map((n) => song.steps.filter((x) => x.n === n).length);
  log(`《${song.meta?.title}》${pick.difficulty}：音符 ${shots.length} 个 → 靶子 ${song.targets.length} 个；N 变化 ${song.steps.length - 1} 次（各档出现 ${tiers.join("/")} 次）`);
  log(`N 时间表：${song.steps.slice(1, 16).map((x) => `${x.t.toFixed(1)}s→${x.n}`).join("  ")}`);
  {
    // 核对：同一格同时在屏幕上的靶子有几对；同一时刻的两个靶子有几对是挨着的
    const tg = song.targets;
    let overlap = 0;
    let pairs = 0;
    let adjacent = 0;
    for (let i = 0; i < tg.length; i++)
      for (let k = i + 1; k < tg.length && tg[k].t - tg[i].t < LEAD + 0.25; k++) {
        if (tg[k].col === tg[i].col && tg[k].rb === tg[i].rb) overlap++;
        if (tg[k].t - tg[i].t < 0.002) {
          pairs++;
          if (Math.abs(tg[k].col - tg[i].col) + Math.abs(tg[k].rb - tg[i].rb) === 1) adjacent++;
        }
      }
    log(`排靶核对（${COLS} 列）：同格重叠 ${overlap} 对；同时出现 ${pairs} 对，其中左右/上下相邻 ${adjacent} 对`);
    // 金色组核对：同一组的靶子拍点时间必须一样（出现时间也就一样）
    const groups = new Map<number, number[]>();
    for (const x of tg) if (x.group >= 0) groups.set(x.group, [...(groups.get(x.group) ?? []), x.t]);
    let worst = 0;
    let sizes = new Set<number>();
    for (const ts of groups.values()) {
      worst = Math.max(worst, Math.max(...ts) - Math.min(...ts));
      sizes.add(ts.length);
    }
    log(`金色组核对：${groups.size} 组，每组 ${[...sizes].join("/")} 个，组内拍点最大相差 ${(worst * 1000).toFixed(1)}ms`);
  }
  log(`前 8 个靶子：${song.targets.slice(0, 8).map((x) => `${x.t.toFixed(2)}s ${x.color ? "蓝" : "红"} 第${x.col + 1}列 下数第${x.rb + 1}行`).join("；")}`);
  try {
    const bytes = await invoke<ArrayBuffer>("rhythm_audio", { id: pick.id });
    actx = new AudioContext({ latencyHint: "interactive" });
    song.audio = await actx.decodeAudioData(bytes);
  } catch (e) {
    log(`歌读不了：${e}`);
  }
  setN(nAt(song.steps, -1));
  showInfo();
  showPrompt(document.pointerLockElement ? "按空格开始" : "");
}

async function startSong() {
  if (!song.audio || !actx || song.running || song.starting) return;
  song.starting = true;
  // 列数、最多行数可能在开始前改过：按现在的设置重新排靶子
  song.steps = capSteps(song.rawSteps, settings.rows);
  song.targets = planTargets(song.shots, song.steps, song.meta?.title ?? song.pick!.id, LEAD, COLS);
  await actx.resume();
  const gain = actx.createGain();
  gain.gain.value = 0.85;
  gain.connect(actx.destination);
  source = actx.createBufferSource();
  source.buffer = song.audio;
  source.connect(gain);
  // 先留一点时间：开头就有的靶子也能完整地收圈
  song.startAt = actx.currentTime + Math.max(1.5, LEAD + 0.5);
  source.start(song.startAt);
  invoke("rhythm_now_playing", {
    id: song.pick!.id,
    positionMs: Math.round((actx.currentTime - song.startAt) * 1000),
    durationMs: Math.round(song.audio.duration * 1000),
  }).catch(() => {});
  Object.assign(song, {
    running: true,
    starting: false,
    finished: false,
    next: 0,
    combo: 0,
    maxCombo: 0,
    count: { perfect: 0, great: 0, miss: 0 },
    devs: [],
    flicks: [],
    lastShot: -Infinity,
  });
  showPrompt("");
  resultEl.hidden = true;
  showLive();
}

function stopSong() {
  if (source) {
    try {
      source.stop();
    } catch {
      // 还没开始放
    }
    source = null;
    invoke("rhythm_now_playing", { id: "", positionMs: 0, durationMs: 0 }).catch(() => {});
  }
  song.running = false;
}

type Judge = "perfect" | "great" | "miss";
const JUDGE_TEXT: Record<Judge, string> = { perfect: "Perfect", great: "Great", miss: "Miss" };
function judge(j: Judge) {
  song.count[j]++;
  if (j === "miss") song.combo = 0;
  else {
    song.combo++;
    song.maxCombo = Math.max(song.maxCombo, song.combo);
    invoke("rift_hit").catch(() => {});
  }
  judgeEl.textContent = JUDGE_TEXT[j];
  judgeEl.dataset.j = j;
  judgeEl.animate(
    [
      { transform: "translate(-50%, 0) scale(1.25)", opacity: 1 },
      { transform: "translate(-50%, 0) scale(1)", opacity: 1, offset: 0.25 },
      { transform: "translate(-50%, 0) scale(1)", opacity: 0 },
    ],
    { duration: 600, easing: "ease-out", fill: "forwards" },
  );
  comboEl.textContent = song.combo >= 2 ? `${song.combo} combo` : "";
  showLive();
}

// ---------------- 实时数据、结算、最高分 ----------------
const liveEl = document.createElement("div");
liveEl.className = "live";
liveEl.hidden = true;
document.body.appendChild(liveEl);
const resultEl = document.createElement("div");
resultEl.className = "result";
resultEl.hidden = true;
document.body.appendChild(resultEl);

/** 准确率：Perfect 算 100%、Great 算 60%、Miss 算 0，按已经判定过的靶子算 */
function accuracy() {
  const c = song.count;
  const done = c.perfect + c.great + c.miss;
  return done ? (c.perfect + c.great * 0.6) / done : 1;
}
function showLive() {
  const c = song.count;
  liveEl.hidden = !song.running;
  liveEl.textContent = `准确率 ${(accuracy() * 100).toFixed(1)}%　连击 ${song.combo}　(${c.perfect}/${c.great}/${c.miss})`;
}

const BEST_KEY = "rift-best";
function bestScores(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function showResult() {
  const c = song.count;
  const total = song.targets.length || 1;
  const score = Math.round(((c.perfect + c.great * 0.6) / total) * 1_000_000);
  const hitRate = (c.perfect + c.great) / total;
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const dev = mean(song.devs) * 1000;
  const flick = mean(song.flicks) * 1000;
  // 最高分：按"歌 + 难度"记
  const key = `${song.pick?.id}|${song.pick?.difficulty}`;
  const best = bestScores();
  const prev = best[key] ?? 0;
  const record = score > prev;
  if (record) {
    best[key] = score;
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(best));
    } catch {
      // 存不了就算了
    }
  }
  const devText = Number.isNaN(dev) ? "—" : Math.abs(dev) < 3 ? "很准（±3ms 内）" : `平均偏${dev < 0 ? "早" : "晚"} ${Math.abs(dev).toFixed(0)}ms`;
  const flickText = Number.isNaN(flick) ? "—" : `${flick.toFixed(0)}ms`;
  resultEl.replaceChildren();
  const add = (cls: string, text: string) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    resultEl.appendChild(d);
    return d;
  };
  add("r-title", `${song.meta?.title ?? ""} · ${song.pick?.difficulty ?? ""}`);
  add("r-score", score.toLocaleString("en-US"));
  if (record) add("r-record", prev ? `新纪录！（之前 ${prev.toLocaleString("en-US")}）` : "新纪录！");
  else add("r-best", `最高分 ${prev.toLocaleString("en-US")}`);
  const rows = document.createElement("div");
  rows.className = "r-rows";
  for (const [k, v] of [
    ["命中率", `${(hitRate * 100).toFixed(1)}%`],
    ["准确率", `${(accuracy() * 100).toFixed(1)}%`],
    ["Perfect / Great / Miss", `${c.perfect} / ${c.great} / ${c.miss}`],
    ["最大连击", String(song.maxCombo)],
    ["时间偏差", devText],
    ["平均甩枪时间", flickText],
  ]) {
    const a = document.createElement("span");
    a.textContent = k;
    const b = document.createElement("b");
    b.textContent = v;
    rows.append(a, b);
  }
  resultEl.appendChild(rows);
  add("r-tip", "甩枪时间：从上一枪（或靶子出现）到准星落到这个靶子上 · 空格再来一次 · Esc 退出");
  resultEl.hidden = false;
  liveEl.hidden = true;
  log(`结算：${score} 分，命中 ${(hitRate * 100).toFixed(1)}%，偏差 ${devText}，甩枪 ${flickText}${record ? "，新纪录" : ""}`);
}

/** 每帧：出靶子、收圈、过期算 Miss、按高潮调 N */
function updateSong(n: number, nowMs: number) {
  if (!song.running) return;
  const now = songTime();
  while (song.next < song.targets.length && song.targets[song.next].t - LEAD <= now) {
    const lt = takeTarget(song.targets[song.next]);
    lt.spawnAt = now;
    song.live.push(lt);
    song.next++;
  }
  // 准星落到哪个靶子上（算甩枪时间）：沿准星方向的射线，不含后坐
  if (song.live.length) {
    aimEuler.set(aimPitch, aimYaw, 0, "YXZ");
    aimDir.set(0, 0, -1).applyEuler(aimEuler);
    ray.set(camera.position, aimDir);
    const over = ray.intersectObjects(song.live.filter((l) => !l.gone && l.seenAt === null).map((l) => l.disc), false)[0];
    if (over) {
      const lt = song.live.find((l) => l.disc === over.object);
      if (lt) lt.seenAt = now;
    }
  }
  let needRows = 1;
  // 每组还剩几个没打：至少两个都还在，才算"要同时打"的一组（金色）
  const aliveInGroup = new Map<number, number>();
  for (const l of song.live) if (!l.gone && l.tg.group >= 0) aliveInGroup.set(l.tg.group, (aliveInGroup.get(l.tg.group) ?? 0) + 1);
  for (let i = song.live.length - 1; i >= 0; i--) {
    const lt = song.live[i];
    const tg = lt.tg;
    // 跟着自己那一行走（行的位置随 N 变）
    lt.group.position.set((tg.col - (COLS - 1) / 2 + tg.dx) * CELL, (tg.rb - (n - 1) / 2 + tg.dy) * CELL, -WALL_Z + 0.06);
    if (lt.gone) {
      const k = (nowMs - lt.gone) / 220;
      if (k >= 1) {
        dropTarget(lt);
        song.live.splice(i, 1);
        continue;
      }
      lt.group.scale.setScalar(settings.size * (1 + k * 0.6));
      lt.discMat.opacity = lt.coreMat.opacity = 1 - k;
      lt.ringMat.opacity = 0;
      continue;
    }
    needRows = Math.max(needRows, tg.rb + 1);
    const left = tg.t - now; // 离拍点还有几秒
    if (left < -lateW(tg)) {
      // 没打：Miss，变暗淡出
      lt.gone = nowMs;
      lt.discMat.color.copy(DIM.copy(accent).multiplyScalar(0.35));
      judge("miss");
      continue;
    }
    lt.group.scale.setScalar(settings.size);
    const appear = Math.min(1, (LEAD - left) / 0.15); // 出现时淡入
    // 能打的那一段变绿（外圈也一起）
    const ready = left <= greatW() && left >= -lateW(tg);
    // 一组的靶子：平时金色，能打时圆盘变绿、外圈保持金色（看得出是一组）
    const linked = tg.group >= 0 && (aliveInGroup.get(tg.group) ?? 0) >= 2;
    const base = linked ? GOLD : accent;
    lt.discMat.color.copy(ready ? GREEN : base);
    lt.ringMat.color.copy(linked ? GOLD : ready ? GREEN : accent);
    lt.discMat.opacity = 0.92 * appear;
    lt.coreMat.opacity = appear;
    lt.ring.scale.setScalar(1 + 1.8 * Math.max(0, left / LEAD));
    lt.ringMat.opacity = appear * (left > 0 ? 0.9 : 0.5);
  }
  updateBeams();
  // 高潮：N 跟着时间表走（已经提前 1 拍），但不能比还没打完的靶子要的行数少
  const want = Math.max(nAt(song.steps, now), needRows);
  if (want !== nSpring.target) setN(want);
  const lastT = song.targets.length ? song.targets[song.targets.length - 1].t : 0;
  if (!song.finished && song.next >= song.targets.length && song.live.length === 0 && now > lastT + 1.5) {
    song.finished = true;
    showResult();
  }
}

// 一组靶子之间的金线：每对活着的靶子之间摆一根细长的发光条
const beamGeo = new THREE.PlaneGeometry(1, CELL * 0.07);
const beamPool: THREE.Mesh[] = [];
function updateBeams() {
  const groups = new Map<number, LiveTarget[]>();
  for (const lt of song.live) {
    if (lt.gone || lt.tg.group < 0) continue;
    const g = groups.get(lt.tg.group) ?? [];
    g.push(lt);
    groups.set(lt.tg.group, g);
  }
  let k = 0;
  for (const g of groups.values()) {
    for (let i = 0; i + 1 < g.length; i++) {
      let beam = beamPool[k];
      if (!beam) {
        beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
        beam.renderOrder = 9; // 在靶子底下
        targetLayer.add(beam);
        beamPool.push(beam);
      }
      const a = g[i].group.position;
      const b = g[i + 1].group.position;
      beam.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, a.z - 0.01);
      beam.scale.x = Math.hypot(b.x - a.x, b.y - a.y);
      beam.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(g[i].discMat.opacity, g[i + 1].discMat.opacity);
      beam.visible = true;
      k++;
    }
  }
  for (; k < beamPool.length; k++) beamPool[k].visible = false;
}

/** 打中一个靶子：按时间判定、记统计、放特效 */
function hitOne(lt: LiveTarget, at: THREE.Vector3 | null, now: number, aimed = true): Judge {
  const signed = now - lt.tg.t;
  const d = Math.abs(signed);
  // 太早（超出前窗口）或太晚（超出后窗口，一对靶子含宽限）算 Miss
  const j: Judge = d <= perfectW() ? "perfect" : signed >= -greatW() && signed <= lateW(lt.tg) ? "great" : "miss";
  if (j !== "miss") {
    song.devs.push(signed);
    // 甩枪：从上一枪（或靶子出现，取较晚的）到准星第一次落上这个靶子
    const from = Math.max(lt.spawnAt, song.lastShot);
    const seen = lt.seenAt ?? now;
    // 右键顺带打中的同组靶子准星没瞄过，不算甩枪
    if (aimed && seen > from) song.flicks.push(seen - from);
  }
  lt.gone = performance.now();
  if (j !== "miss") {
    const p = (at ?? lt.group.position).clone().setZ(-WALL_Z + 0.12);
    spawnFx(ringGeo, GREEN.clone().lerp(shotColor, 0.3), p, 420, 3.2, true);
    spawnFx(ringGeo, shotColor, p.clone().setZ(p.z + 0.01), 200, 1.6, true);
  } else lt.discMat.color.copy(DIM.copy(accent).multiplyScalar(0.35));
  judge(j);
  return j;
}

/** 准星现在是不是瞄着金色靶子（一组里至少两个都还在） */
function aimingAtGold(): boolean {
  if (!song.running) return false;
  const alive = song.live.filter((l) => !l.gone);
  const hit = ray.intersectObjects(alive.map((l) => l.disc), false)[0];
  if (!hit) return false;
  const lt = alive.find((l) => l.disc === hit.object);
  if (!lt || lt.tg.group < 0) return false;
  return alive.filter((l) => l.tg.group === lt.tg.group).length >= 2;
}

/** 射线打靶子：打中返回 true。whole：右键——打中一组里的一个，这一组全部算打中（按这一刻判定） */
function shootTargets(whole = false): boolean {
  if (!song.running || song.live.length === 0) return false;
  const discs = song.live.filter((l) => !l.gone).map((l) => l.disc);
  const hit = ray.intersectObjects(discs, false)[0];
  if (!hit) return false;
  const lt = song.live.find((l) => l.disc === hit.object)!;
  const now = songTime();
  hitOne(lt, hit.point, now);
  if (whole && lt.tg.group >= 0) {
    for (const other of song.live.filter((l) => !l.gone && l !== lt && l.tg.group === lt.tg.group)) hitOne(other, null, now, false);
  }
  song.lastShot = now;
  return true;
}

// ---------------- 主循环 ----------------
let last = performance.now();
let frames = 0;
let fpsT = last;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  nSpring.step(dt);
  openSpring.step(dt);
  const n = nSpring.value;
  const open = Math.max(0, openSpring.value);
  const half = ((n * CELL_PX) / ZOOM / 2 + MARGIN) * open;
  halfNow = half;
  layoutRows(n);
  // 视角：上下范围跟着 N 变（N 变小时慢慢把准星收回范围内），再叠上后坐
  const pm = pitchMax(n);
  aimPitch = Math.min(pm, Math.max(-pm, aimPitch));
  recoil *= Math.exp(-dt / 0.07);
  camera.rotation.set(aimPitch + recoil, aimYaw, 0, "YXZ");
  muzzleLight.intensity *= Math.exp(-dt / 0.03);
  updateFx(now);
  updateSong(n, now);
  updateRift(half, open);
  glowMat.uniforms.strength.value = Math.min(1, open * 1.4) * (0.9 + 0.1 * Math.sin(now / 160));

  renderer.clear();
  // 3D 靶场只画裂缝实际占的那一段（上下再多几像素给参差），外面的像素不画，省显卡
  const cy = CY - CANVAS_TOP;
  const y0 = Math.max(0, Math.floor(cy - half - JAG - 2));
  const y1 = Math.min(CANVAS_H, Math.ceil(cy + half + JAG + 2));
  if (y1 > y0) {
    renderer.setScissorTest(true);
    renderer.setScissor(0, CANVAS_H - y1, W, y1 - y0); // WebGL 的 y 从下往上数
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  }
  renderer.render(overlay, ortho);

  frames++;
  if (now - fpsT > 3000) {
    log(`帧率 ${((frames * 1000) / (now - fpsT)).toFixed(1)}，N=${n.toFixed(2)}`);
    frames = 0;
    fpsT = now;
  }
  if (closing && open < 0.01) {
    invoke("rift_close").catch(() => {});
    return;
  }
  requestAnimationFrame(frame);
}

function close() {
  if (closing) return;
  closing = true;
  playing = false;
  crossEl.hidden = true;
  startEl.hidden = true;
  infoEl.hidden = true;
  if (document.pointerLockElement) document.exitPointerLock();
  stopSong();
  showPrompt("");
  comboEl.textContent = "";
  liveEl.hidden = true;
  resultEl.hidden = true;
  openSpring.cfg = { stiffness: 160, damping: 26, precision: 0.001 };
  openSpring.target = 0;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
  // 在设置框里打字时不当快捷键
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
  if (song.on) {
    // 空格：开始放歌（先锁定鼠标）；结束后空格再来一次
    if (e.key === " " && playing && !e.repeat) {
      e.preventDefault();
      if (song.finished) {
        stopSong();
        for (const lt of song.live) dropTarget(lt);
        song.live = [];
        resultEl.hidden = true;
      }
      startSong();
    }
    // ← → 调延迟（靶子早了 / 晚了），每首歌分别记住；和下落模式共用同一个设置
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      song.offsetMs = Math.max(-2000, Math.min(2000, song.offsetMs + (e.key === "ArrowRight" ? 20 : -20)));
      invoke("rhythm_prefs_set", { id: song.pick!.id, offsetMs: song.offsetMs, speed: null }).catch(() => {});
      showInfo();
    }
    return;
  }
  // 测试模式：数字键 1~4 切 N
  if (e.key >= "1" && e.key <= "4") setN(Number(e.key));
});
document.querySelectorAll<HTMLButtonElement>("#test button").forEach((b) => b.addEventListener("click", () => setN(Number(b.dataset.n))));
document.getElementById("test")!.hidden = false;

async function start() {
  const theme = await invoke<Theme | null>("widgets_theme_get").catch(() => null);
  applyTheme(theme);
  // 刚开机时壁纸颜色可能还没算好：算好（或换壁纸）时再上色
  listen<Theme>("widgets-theme", (e) => applyTheme(e.payload));
  setN(1);
  layoutRows(1);
  openSpring.target = 1;
  // 从选歌菜单进来的：载入那首歌；托盘里打开的：测试模式（数字键切 N）
  let pick = await invoke<Pick | null>("rift_pending").catch(() => null);
  try {
    if (!pick) pick = JSON.parse(sessionStorage.getItem("rift-pick") ?? "null");
    sessionStorage.removeItem("rift-pick");
  } catch {
    // 没有就是测试模式
  }
  if (pick) loadSong(pick);
  startEl.hidden = false;
  infoEl.hidden = false;
  showInfo();
  log(`裂缝射击开始：屏幕 ${W}x${H}，格子 ${CELL_PX.toFixed(0)}px，画布高 ${CANVAS_H}`);
  requestAnimationFrame(frame);
}
start();
