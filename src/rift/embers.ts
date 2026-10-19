// 裂缝射击：粒子。
//   Embers：从裂缝上下两条边飘出去的火星（画在裂缝那一层的画布像素坐标里，y 向下）。
//     大部分是慢慢往外飘、左右轻轻摆的余烬；少部分是飞得快、一闪就灭的火花。
//     裂缝开着时一直往外冒；撕开、变大时 burst() 喷一阵。
//   Dust：裂缝里 3D 场景中飘着的细小光点，转视角时有远近视差。
// 都是一次性分配好的数组，每帧只改数字，不新建对象。
import * as THREE from "three";

const embersVert = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aMix;
  uniform float uScale;
  varying float vA;
  varying float vMix;
  void main() {
    vA = aAlpha;
    vMix = aMix;
    gl_PointSize = aSize * uScale;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const embersFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uColor2;
  varying float vA;
  varying float vMix;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);
    if (d > 1.0 || vA <= 0.0) discard;
    // 白芯 + 主题色光晕
    float core = exp(-d * 7.0);
    float halo = (1.0 - d) * (1.0 - d) * 0.6;
    float a = clamp((core + halo) * vA, 0.0, 1.0);
    vec3 c = mix(mix(uColor, uColor2, vMix), vec3(1.0), core * 0.75);
    gl_FragColor = vec4(c * a, a);
  }`;

export class Embers {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  /** 0 用主色、1 用副色（经典撞色时一部分火星是搭档色） */
  private readonly mixc: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly base: Float32Array;
  private readonly phase: Float32Array;
  /** 0 余烬、1 火花 */
  private readonly kind: Uint8Array;
  /** 还没放出去的份额（每秒 rate 个，按帧累积） */
  private owed = 0;
  private queued = 0;

  constructor(max = 360, pixelRatio = 1) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.mixc = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 = 空位
    this.base = new Float32Array(max);
    this.phase = new Float32Array(max);
    this.kind = new Uint8Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aMix", new THREE.BufferAttribute(this.mixc, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x8caaff) }, uColor2: { value: new THREE.Color(0x8caaff) }, uScale: { value: pixelRatio } },
      vertexShader: embersVert,
      fragmentShader: embersFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // 叠加发光（预乘透明度）：裂缝外面是透明的桌面，也照样看得到
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** 喷一阵（下一帧放出去） */
  burst(n: number) {
    this.queued = Math.min(this.max, this.queued + n);
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.owed = 0;
    this.queued = 0;
  }

  private spawn(width: number, edgeY: (x: number, top: boolean) => number) {
    const i = this.life.indexOf(0);
    if (i < 0) return;
    const top = Math.random() < 0.5;
    const x = Math.random() * width;
    const out = top ? -1 : 1; // 往裂缝外面：上边往上、下边往下
    const spark = Math.random() < 0.16;
    this.kind[i] = spark ? 1 : 0;
    this.mixc[i] = Math.random() < 0.4 ? 1 : 0;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = edgeY(x, top) + out * (Math.random() * 6 - 2);
    this.pos[i * 3 + 2] = 0;
    if (spark) {
      this.vx[i] = (Math.random() - 0.5) * 120;
      this.vy[i] = out * (90 + Math.random() * 140);
      this.life[i] = 0.35 + Math.random() * 0.5;
      this.base[i] = 3 + Math.random() * 3;
    } else {
      this.vx[i] = (Math.random() - 0.5) * 22;
      this.vy[i] = out * (10 + Math.random() * 34);
      this.life[i] = 1.6 + Math.random() * 2.6;
      this.base[i] = 4 + Math.random() * 6;
    }
    this.age[i] = 0;
    this.phase[i] = Math.random() * Math.PI * 2;
  }

  /**
   * dt：秒；open：裂缝开合 0~1；rate：每秒冒多少个；width：画布宽；
   * edgeY(x, top)：这一刻裂缝上边 / 下边在 x 处的 y（画布像素）
   */
  update(dt: number, open: number, rate: number, width: number, edgeY: (x: number, top: boolean) => number) {
    if (open > 0.15) {
      this.owed += rate * open * dt;
      let n = Math.floor(this.owed) + this.queued;
      this.owed -= Math.floor(this.owed);
      this.queued = 0;
      while (n-- > 0) this.spawn(width, edgeY);
    }
    const t = performance.now() / 1000;
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i];
      if (life === 0) continue;
      const age = (this.age[i] += dt);
      if (age >= life) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        continue;
      }
      const k = age / life;
      const p = i * 3;
      if (this.kind[i] === 1) {
        // 火花：飞快、越飞越慢
        const drag = Math.exp(-dt * 3.2);
        this.vx[i] *= drag;
        this.vy[i] *= drag;
        this.alpha[i] = (1 - k) * (0.75 + 0.25 * Math.sin(age * 40 + this.phase[i]));
        this.size[i] = this.base[i] * (1 - k * 0.5);
      } else {
        // 余烬：往外飘得越来越快一点（像热气往外推），左右轻轻摆，闪烁
        this.vy[i] *= 1 + dt * 0.35;
        this.pos[p] += Math.sin(t * 1.7 + this.phase[i]) * 9 * dt;
        const fadeIn = Math.min(1, k / 0.12);
        const fadeOut = k > 0.55 ? 1 - (k - 0.55) / 0.45 : 1;
        this.alpha[i] = fadeIn * fadeOut * (0.7 + 0.3 * Math.sin(age * 6 + this.phase[i]));
        this.size[i] = this.base[i] * (1 - k * 0.35);
      }
      this.pos[p] += this.vx[i] * dt;
      this.pos[p + 1] += this.vy[i] * dt;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aMix.needsUpdate = true;
  }
}

/** 一张圆形软边的小贴图（浮尘用） */
function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 裂缝里飘着的浮尘：一个盒子范围里慢慢往上飘、左右轻摆，飘出顶就回到底 */
export class Dust {
  readonly points: THREE.Points;
  readonly material: THREE.PointsMaterial;
  private readonly pos: Float32Array;
  private readonly seed: Float32Array;
  private readonly box: THREE.Box3;

  constructor(count: number, box: THREE.Box3, size: number) {
    this.box = box;
    this.pos = new Float32Array(count * 3);
    this.seed = new Float32Array(count);
    const s = new THREE.Vector3();
    box.getSize(s);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = box.min.x + Math.random() * s.x;
      this.pos[i * 3 + 1] = box.min.y + Math.random() * s.y;
      this.pos[i * 3 + 2] = box.min.z + Math.random() * s.z;
      this.seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.PointsMaterial({
      size,
      map: dotTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
  }

  update(dt: number) {
    const t = performance.now() / 1000;
    const { min, max } = this.box;
    const h = max.y - min.y;
    for (let i = 0; i < this.seed.length; i++) {
      const p = i * 3;
      const sd = this.seed[i];
      this.pos[p] += Math.sin(t * 0.4 + sd) * 0.12 * dt;
      this.pos[p + 1] += (0.08 + (sd % 1) * 0.12) * dt;
      this.pos[p + 2] += Math.cos(t * 0.3 + sd * 1.3) * 0.08 * dt;
      if (this.pos[p + 1] > max.y) this.pos[p + 1] -= h;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
