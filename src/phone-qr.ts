// 手机遥控二维码窗口：二维码和网址都由 Rust 生成（网址里带密钥）
import { invoke } from "@tauri-apps/api/core";

interface Info {
  running: boolean;
  url: string;
  svg: string;
}

async function show() {
  const info = await invoke<Info>("phone_info").catch(() => null);
  const state = document.getElementById("state")!;
  if (!info) {
    state.textContent = "读不到手机遥控的信息";
    return;
  }
  state.textContent = info.running ? "手机遥控已开启" : "手机遥控现在是关着的：托盘 → 勾上「手机遥控」";
  state.className = info.running ? "sub" : "sub off";
  // SVG 是自己程序生成的二维码
  document.getElementById("qr")!.innerHTML = info.svg;
  document.getElementById("url")!.textContent = info.url;
}

show();
// 换了 Wi-Fi（电脑地址变了）或刚在托盘里打开：过一会儿刷新一下
setInterval(show, 5000);
