// 裂缝射击：「天空之岛」场景。
// 靶墙变成悬浮在空中的深色石板（靶子在明亮背景里也看得清），玩家站在一条伸向石板的石砖路上，
// 两边一排排白色石柱往远处排过去（透视感）；外面是天空渐变、太阳光晕、云海、云朵和慢慢浮动的小岛。
// 只用程序生成的几何体和画布贴图，不需要任何图片文件。
import * as THREE from "three";

export interface SkyOpts {
  /** 一格的边长（米） */
  cell: number;
  /** 靶墙离眼睛多远（米） */
  wallZ: number;
  /** 地面高度 */
  floorY: number;
  /** 靶墙石板的宽高 */
  boardW: number;
  boardH: number;
}

export interface Sky {
  /** 雾的颜色（地平线附近的天色） */
  fog: THREE.Color;
  /** 每帧：云飘、岛浮 */
  update(t: number): void;
}

/** 固定随机：每次打开一样 */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const ZENITH = new THREE.Color(0x2f62d6);
const MID = new THREE.Color(0x86bdff);
const HORIZON = new THREE.Color(0xffe1bd);

/** 天空球：上深蓝 → 中间亮蓝 → 地平线暖色，太阳那边多一圈光晕 */
function skyDome(sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: ZENITH },
      mid: { value: MID },
      horizon: { value: HORIZON },
      sun: { value: sunDir },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith;
      uniform vec3 mid;
      uniform vec3 horizon;
      uniform vec3 sun;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(mid, zenith, smoothstep(0.0, 0.55, h)) : mix(mid, horizon * 0.95, smoothstep(0.0, -0.25, h));
        c = mix(c, horizon, exp(-abs(h) * 9.0) * 0.85);
        float s = max(dot(normalize(vDir), sun), 0.0);
        c += vec3(1.0, 0.86, 0.62) * (pow(s, 600.0) * 1.6 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mat);
}

/** 一团软软的云（画布画几个叠在一起的圆） */
function cloudTexture(seed: number) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const rnd = rng(seed);
  for (let i = 0; i < 14; i++) {
    const x = 50 + rnd() * 156;
    const y = 58 + (rnd() - 0.5) * 34;
    const r = 22 + rnd() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.55, "rgba(255,252,246,0.55)");
    grad.addColorStop(1, "rgba(255,248,240,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 石砖地面的贴图：浅色石板 + 缝，铺开后透视线很明显 */
function tileTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const rnd = rng(77);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const l = 74 + rnd() * 10;
      g.fillStyle = `hsl(36, 18%, ${l}%)`;
      g.fillRect(x * 64, y * 64, 64, 64);
    }
  g.strokeStyle = "rgba(90, 80, 66, 0.55)";
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo(i * 64, 0);
    g.lineTo(i * 64, 256);
    g.moveTo(0, i * 64);
    g.lineTo(256, i * 64);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** 一座漂浮小岛：倒过来的岩石锥 + 草地顶 + 几棵小树 */
function island(radius: number, seed: number, mats: { rock: THREE.Material; grass: THREE.Material; leaf: THREE.Material; trunk: THREE.Material }) {
  const rnd = rng(seed);
  const g = new THREE.Group();
  const rockGeo = new THREE.ConeGeometry(radius, radius * 1.7, 8, 3);
  const p = rockGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // 底尖不动，其余点随机推一推，像天然的岩石
    if (p.getY(i) < radius * 0.84) {
      p.setX(i, p.getX(i) * (0.8 + rnd() * 0.4));
      p.setZ(i, p.getZ(i) * (0.8 + rnd() * 0.4));
      p.setY(i, p.getY(i) + (rnd() - 0.5) * radius * 0.2);
    }
  }
  rockGeo.computeVertexNormals();
  const rock = new THREE.Mesh(rockGeo, mats.rock);
  rock.rotation.x = Math.PI;
  rock.position.y = -radius * 0.85;
  g.add(rock);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.04, radius * 0.98, radius * 0.22, 8), mats.grass);
  g.add(top);
  const trees = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < trees; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * radius * 0.6;
    const h = radius * (0.5 + rnd() * 0.4);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.05, h * 0.07, h * 0.4, 5), mats.trunk);
    trunk.position.set(Math.cos(a) * d, radius * 0.11 + h * 0.2, Math.sin(a) * d);
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(h * 0.32, h * 0.8, 7), mats.leaf);
    leaf.position.copy(trunk.position).setY(trunk.position.y + h * 0.5);
    g.add(trunk, leaf);
  }
  return g;
}

export function buildSky(scene: THREE.Scene, o: SkyOpts): Sky {
  const sunDir = new THREE.Vector3(-0.45, 0.32, -0.83).normalize();
  scene.add(skyDome(sunDir));

  // 光：暖色的阳光从左前上方照过来（看得到石柱、岛的亮面）；天上的太阳光晕留在远处，天光偏蓝
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
  sun.position.set(-30, 45, 25);
  scene.add(sun);
  const fill = new THREE.HemisphereLight(0xcfe4ff, 0x8a7458, 0.9);
  scene.add(fill);

  const mats = {
    stone: new THREE.MeshStandardMaterial({ color: 0xf1ebe0, roughness: 0.75 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xe0d4bf, roughness: 0.6 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x8c7b6a, roughness: 0.95, flatShading: true }),
    grass: new THREE.MeshStandardMaterial({ color: 0x7cc46a, roughness: 0.9, flatShading: true }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x3f9a5a, roughness: 0.85, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 0.9 }),
  };

  // ---- 石砖路：从镜头身后穿过靶墙，一直铺到很远的地方（远处慢慢没进雾里） ----
  const pathW = o.boardW + o.cell * 1.6;
  const pathFar = -o.wallZ * 9;
  const pathNear = o.wallZ * 1.8;
  const len = pathNear - pathFar;
  const tiles = tileTexture();
  tiles.repeat.set(pathW / (o.cell * 1.6), len / (o.cell * 1.6));
  const path = new THREE.Mesh(new THREE.PlaneGeometry(pathW, len), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.8 }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, o.floorY, (pathNear + pathFar) / 2);
  scene.add(path);
  // 路两边的石沿
  for (const sx of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(o.cell * 0.3, o.cell * 0.25, len), mats.trim);
    curb.position.set(sx * (pathW / 2 + o.cell * 0.15), o.floorY + o.cell * 0.1, path.position.z);
    scene.add(curb);
  }

  // ---- 两排石柱：在路两边稍远处，从靶墙附近一路排到远方（越远越小，往地平线收拢，透视感）。
  //      近处的柱子在画面外，看到的是整根柱子连着柱头、横梁往远处排过去 ----
  const colX = pathW / 2 + o.cell * 2.6;
  const colH = o.cell * 4.6;
  const colR = o.cell * 0.22;
  const step = o.cell * 2.4;
  const shaft = new THREE.CylinderGeometry(colR * 0.9, colR, colH, 14);
  const capGeo = new THREE.BoxGeometry(colR * 2.8, colR * 0.8, colR * 2.8);
  for (const sx of [-1, 1]) {
    for (let z = -o.cell; z > pathFar; z -= step) {
      const c = new THREE.Mesh(shaft, mats.stone);
      c.position.set(sx * colX, o.floorY + colH / 2, z);
      const base = new THREE.Mesh(capGeo, mats.trim);
      base.position.set(sx * colX, o.floorY + colR * 0.4, z);
      const cap = base.clone();
      cap.position.y = o.floorY + colH;
      scene.add(c, base, cap);
    }
    const beamLen = -o.cell - pathFar;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(colR * 2.4, colR * 1.4, beamLen), mats.trim);
    beam.position.set(sx * colX, o.floorY + colH + colR * 1.1, -o.cell - beamLen / 2);
    scene.add(beam);
  }

  // 柱廊外侧也铺上地面（和路连成一片宽平台）
  const terrace = new THREE.Mesh(new THREE.PlaneGeometry(colX * 2 + o.cell * 3, len), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.85 }));
  terrace.rotation.x = -Math.PI / 2;
  terrace.position.set(0, o.floorY - 0.02, path.position.z);
  scene.add(terrace);
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(colX * 2 + o.cell * 3, o.cell * 1.6, len), mats.rock);
  ledge.position.set(0, o.floorY - o.cell * 0.85, path.position.z);
  scene.add(ledge);

  // ---- 靶墙后面的拱门：两根细高的柱 + 石板上方一道横楣，把石板框在中间（不挡格子） ----
  const archX = o.boardW / 2 + o.cell * 0.9;
  const archTop = o.boardH / 2 + o.cell * 1.1;
  const archH = archTop - o.floorY;
  for (const sx of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(o.cell * 0.2, o.cell * 0.24, archH, 14), mats.stone);
    pillar.position.set(sx * archX, o.floorY + archH / 2, -o.wallZ - o.cell * 0.4);
    scene.add(pillar);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(archX * 2 + o.cell * 0.9, o.cell * 0.45, o.cell * 0.6), mats.trim);
  lintel.position.set(0, archTop + o.cell * 0.2, -o.wallZ - o.cell * 0.4);
  scene.add(lintel);

  // ---- 云海：下方远远一大片，慢慢流动 ----
  const seaTex = cloudTexture(5);
  seaTex.wrapS = seaTex.wrapT = THREE.RepeatWrapping;
  seaTex.repeat.set(10, 6);
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 600),
    new THREE.MeshBasicMaterial({ map: seaTex, color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, o.floorY - 14, -200);
  scene.add(sea);

  // ---- 云朵：远近不同的几层，横向慢慢飘（远的飘得慢） ----
  const rnd = rng(2024);
  const clouds: { s: THREE.Sprite; speed: number; span: number }[] = [];
  const cloudTex = [cloudTexture(11), cloudTexture(23), cloudTexture(37)];
  for (let i = 0; i < 34; i++) {
    const dist = 40 + rnd() * 260;
    const m = new THREE.SpriteMaterial({ map: cloudTex[i % 3], transparent: true, depthWrite: false, opacity: 0.75 + rnd() * 0.25 });
    const s = new THREE.Sprite(m);
    const w = 18 + rnd() * 46 + dist * 0.12;
    s.scale.set(w, w * 0.45, 1);
    const span = dist * 1.6;
    s.position.set((rnd() - 0.5) * span * 2, o.floorY - 6 + rnd() * (14 + dist * 0.12), -dist);
    scene.add(s);
    clouds.push({ s, speed: (0.6 + rnd()) * (60 / dist), span });
  }

  // ---- 漂浮小岛：靶墙两边近一点的大，远的小；各自慢慢上下浮 ----
  const isles: { g: THREE.Group; y: number; phase: number; amp: number }[] = [];
  const spots: [number, number, number, number][] = [
    // x, y, z, 半径（都按格子大小算，屏幕大小变了比例不变）
    [-1, 0.3, 1.0, 1.6],
    [1, -0.4, 1.25, 2.0],
    [-1.6, 1.4, 2.6, 2.6],
    [1.7, 1.0, 3.2, 3.2],
    [-0.6, 2.4, 5.5, 3.6],
    [0.9, 1.8, 7.5, 5.0],
    [-2.6, -0.6, 6.5, 4.2],
    [2.9, 0.4, 9.0, 6.0],
  ];
  spots.forEach(([x, y, z, r], i) => {
    const g = island(r * o.cell, 100 + i * 17, mats);
    const zz = -o.wallZ * z - o.cell * 4;
    g.position.set(x * (o.boardW * 0.75 + Math.abs(zz) * 0.35), o.floorY + y * o.cell * 3 + o.cell, zz);
    g.rotation.y = rnd() * Math.PI * 2;
    scene.add(g);
    isles.push({ g, y: g.position.y, phase: rnd() * 6, amp: o.cell * (0.15 + rnd() * 0.25) });
  });

  // ---- 太阳方向的两道光柱（叠加、很淡），增加一点空气感 ----
  const rayMat = new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  for (let i = 0; i < 2; i++) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(o.cell * (3 + i * 2), 120), rayMat);
    ray.position.set(-30 - i * 25, 20, -90 - i * 30);
    ray.rotation.set(0, 0.3, 0.55 + i * 0.12);
    scene.add(ray);
  }

  let lastT = -1;
  return {
    fog: HORIZON.clone().lerp(MID, 0.35),
    update(t: number) {
      const dt = lastT < 0 ? 0 : Math.min(0.1, t - lastT);
      lastT = t;
      for (const c of clouds) {
        c.s.position.x += c.speed * dt;
        if (c.s.position.x > c.span) c.s.position.x -= c.span * 2;
      }
      seaTex.offset.x = t * 0.004;
      seaTex.offset.y = t * 0.002;
      for (const i of isles) i.g.position.y = i.y + Math.sin(t * 0.45 + i.phase) * i.amp;
    },
  };
}
