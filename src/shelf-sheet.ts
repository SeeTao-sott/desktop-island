// 架子里弹出的确认页：从桌面搬家 / 把桌面来的东西搬回去。
// 先列清单，用户点按钮才真正动文件。
import { invoke } from "@tauri-apps/api/core";
import { api, type OpResult } from "./shelf-api";
import { hold, reportOp, showError } from "./shelf-toast";

interface PlanItem {
  name: string;
  path: string;
  isDir: boolean;
  category: string;
  public: boolean;
  problem: string | null;
}
interface HomeItem {
  name: string;
  now: string;
  home: string;
}
interface MigrateResult {
  result: OpResult;
  record: string | null;
}

const ORDER = ["软件", "文档", "图片", "压缩包", "其他"];
const sheet = document.getElementById("sheet")!;
let afterChange: () => void = () => {};
let holding = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function open(title: string, desc: string, body: HTMLElement, foot: HTMLElement[]) {
  sheet.replaceChildren();
  const head = el("div", "sheet-head");
  head.append(el("div", "sheet-title", title), el("div", "sheet-desc", desc));
  const footer = el("div", "sheet-foot");
  footer.append(...foot);
  sheet.append(head, body, footer);
  // 看清单时鼠标移开也别收回
  if (!holding) hold(1);
  holding = true;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("open"));
}

export function closeSheet() {
  if (holding) hold(-1);
  holding = false;
  sheet.classList.remove("open");
  window.setTimeout(() => {
    if (!sheet.classList.contains("open")) sheet.hidden = true;
  }, 260);
}

export const sheetOpen = () => !sheet.hidden;

function button(text: string, primary: boolean, onClick: () => void) {
  const b = el("button", primary ? "pill pill-primary" : "pill pill-quiet", text);
  b.addEventListener("click", onClick);
  return b;
}

function iconFor(path: string, box: HTMLElement) {
  api
    .icon(path, 0, /\.(jpe?g|png|gif|webp|bmp)$/i.test(path))
    .then((url) => {
      if (!url) return;
      const img = new Image();
      img.src = url;
      img.draggable = false;
      box.appendChild(img);
    })
    .catch(() => {});
}

function row(name: string, path: string, note: string, warn = false) {
  const r = el("label", "sheet-row");
  const cb = el("input") as HTMLInputElement;
  cb.type = "checkbox";
  const ic = el("div", "ic sheet-ic");
  iconFor(path, ic);
  const meta = el("div", "meta");
  meta.append(el("div", "nm", name), el("div", warn ? "sub warn" : "sub", note));
  r.append(cb, ic, meta);
  r.title = path;
  return { r, cb };
}

// ---------------- 从桌面搬家 ----------------
async function showMigrate() {
  let items: PlanItem[];
  try {
    items = await invoke<PlanItem[]>("shelf_migrate_plan");
  } catch (e) {
    return showError(String(e));
  }
  const body = el("div", "sheet-list");
  const checks: { cb: HTMLInputElement; item: PlanItem }[] = [];
  const cats = [...new Set(items.map((i) => i.category))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  for (const cat of cats) {
    const group = items.filter((i) => i.category === cat);
    body.append(el("div", "sheet-group", `${cat} · ${group.length}`));
    for (const it of group) {
      const note = it.problem ?? `${it.isDir ? "文件夹，整个放进来" : "放进「" + cat + "」"}${it.public ? " · 公共桌面" : ""}`;
      const { r, cb } = row(it.name.replace(/\.(lnk|url)$/i, ""), it.path, note, !!it.problem);
      cb.checked = !it.problem;
      cb.disabled = !!it.problem;
      checks.push({ cb, item: it });
      body.append(r);
    }
  }
  if (!items.length) body.append(el("div", "no-result", "桌面上已经没有东西了"));

  const go = button("", true, () => doMigrate());
  const count = () => {
    const n = checks.filter((c) => c.cb.checked).length;
    go.textContent = `搬进架子（${n} 项）`;
    go.disabled = n === 0;
  };
  checks.forEach((c) => c.cb.addEventListener("change", count));
  count();

  async function doMigrate() {
    const paths = checks.filter((c) => c.cb.checked).map((c) => c.item.path);
    go.disabled = true;
    go.textContent = "正在搬…";
    try {
      const res = await invoke<MigrateResult>("shelf_migrate", { paths });
      reportOp(res.result, (id) => api.undo(id).then((r) => (reportOp(r, () => {}), afterChange())));
      showMigrateDone(res);
      afterChange();
    } catch (e) {
      showError(String(e));
      count();
    }
  }

  open(
    "从桌面搬进架子",
    "勾选的东西会按类型放进对应分类（文件夹整个放进「其他」）。同盘直接移动，不会删除任何东西；搬完会生成搬家记录，随时可以一键搬回桌面。",
    body,
    [button("取消", false, closeSheet), go],
  );
}

function showMigrateDone(res: MigrateResult) {
  const body = el("div", "sheet-list");
  const ok = res.result.moved.length;
  body.append(el("div", "sheet-big", `已搬进架子 ${ok} 项`));
  if (res.result.failed.length) {
    body.append(el("div", "sheet-group", `没搬成 ${res.result.failed.length} 项（还在桌面上）`));
    for (const f of res.result.failed) body.append(el("div", "sheet-fail", `${f.name}：${f.reason}`));
  }
  body.append(el("div", "sheet-desc", "想全部搬回桌面：托盘图标 →「把桌面来的东西搬回桌面…」。"));
  const foot = [button("完成", true, closeSheet)];
  if (res.record) {
    const path = res.record;
    foot.unshift(button("打开搬家记录", false, () => invoke("shelf_open_record", { path }).catch((e) => showError(String(e)))));
  }
  open("搬好了", "", body, foot);
}

// ---------------- 搬回桌面 ----------------
async function showRestore() {
  let items: HomeItem[];
  try {
    items = await invoke<HomeItem[]>("shelf_restore_plan");
  } catch (e) {
    return showError(String(e));
  }
  const body = el("div", "sheet-list");
  const checks: { cb: HTMLInputElement; item: HomeItem }[] = [];
  for (const it of items) {
    const cat = it.now.split("\\").slice(-2, -1)[0];
    const where = it.home.toLowerCase().includes("\\public\\") ? "公共桌面" : "桌面";
    const { r, cb } = row(it.name.replace(/\.(lnk|url)$/i, ""), it.now, `现在在「${cat}」→ 回到${where}`);
    cb.checked = true;
    checks.push({ cb, item: it });
    body.append(r);
  }
  if (!items.length) body.append(el("div", "no-result", "架子里没有从桌面来的东西"));

  const go = button("", true, async () => {
    const homes = checks.filter((c) => c.cb.checked).map((c) => c.item.home);
    go.disabled = true;
    go.textContent = "正在搬回…";
    try {
      const r = await invoke<OpResult>("shelf_restore", { homes });
      reportOp(r, (id) => api.undo(id).then((u) => (reportOp(u, () => {}), afterChange())));
      closeSheet();
      afterChange();
    } catch (e) {
      showError(String(e));
    }
  });
  const count = () => {
    const n = checks.filter((c) => c.cb.checked).length;
    go.textContent = `搬回桌面（${n} 项）`;
    go.disabled = n === 0;
  };
  checks.forEach((c) => c.cb.addEventListener("change", count));
  count();

  open(
    "把桌面来的东西搬回桌面",
    "这些都是从桌面放进架子的（包括你之前手动拖进来的），会回到原来的位置。那里已经有同名的会自动改名，不会覆盖。",
    body,
    [button("取消", false, closeSheet), go],
  );
}

export function initSheet(changed: () => void) {
  afterChange = changed;
}

export function showSheet(kind: string) {
  if (kind === "migrate") showMigrate();
  else if (kind === "restore") showRestore();
}
