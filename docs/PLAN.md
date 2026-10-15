# 灵动岛 · 阶段 0 计划

## 本机现状（2026-10-15 检查）
- Windows 11 Home 26200；主屏 1920x1080 @125% 缩放（逻辑 1536x864）
- 已有：Node v24.14.0 / npm 11.9.0、Git 2.53、WebView2 155、nvidia-smi（驱动 596.49，GTX 1650 可读温度）、winget
- 没有：Rust、VS C++ 生成工具（MSVC + Windows SDK）、.NET SDK
- 磁盘：C 盘剩 35.2 GB，D 盘剩 34.2 GB
- 媒体会话最小测试：已通过（PowerShell 直接调 GlobalSystemMediaTransportControlsSessionManager，读到 Chrome/YouTube 的歌名、歌手和播放状态）

## 技术选型
| | Tauri 2 | Electron | C# WPF |
|---|---|---|---|
| 动画丝滑 | WebView2(Chromium) GPU 合成，CSS transform/opacity 稳 60fps | 同为 Chromium，一样顺 | 透明窗口(AllowsTransparency)走软件渲染，大窗口动画易掉帧 |
| 透明 + 点击穿透 | transparent 窗口 + set_ignore_cursor_events，配合 Rust 侧光标位置判断 | 支持，setIgnoreMouseEvents(forward) | 支持，需 Win32 互操作 |
| 系统接口 | Rust `windows` crate 直接调 WinRT/Win32 | 需要原生模块(node-addon)，麻烦 | 原生最方便 |
| 资源占用 | 空闲约 60–120MB，安装包几 MB | 150–300MB，包 80MB+ | 50–100MB |
| 结论 | **推荐** | 太重 | 动画是短板 |

## 关键设计
- 窗口固定为展开后的最大尺寸、全透明、置顶、无边框、不进任务栏；胶囊变形只在网页里做
- 弹簧动画：自写弹簧物理（rAF），动画结束后立刻停止循环，空闲零重绘
- 点击穿透：窗口默认穿透；Rust 侧低频读光标位置(GetCursorPos，不是钩子)，光标进入胶囊范围才接收鼠标
- 全屏检测：SHQueryUserNotificationState + 前台窗口尺寸比对，只读查询，不注入任何进程
- 不监听键盘，不挂全局钩子

## 阶段 1 实测（2026-10-15，发布版）
- 动画：显示器 144Hz，展开/收回跑满 144 fps，最慢一帧 7.1ms
- 空闲 CPU：30 秒内整个进程树只用了 94ms CPU，约 0.03%
- 内存（任务管理器"专用工作集"口径）：110 MB（主程序 4MB + WebView2 子进程）
- 点击穿透：胶囊外透明区的点击落到桌面；鼠标在胶囊上时由胶囊接收
- 安装备注：VS Build Tools 用的是 2026 版(18.x)，2022 版安装器已被微软拒绝

## 阶段 2 实测（2026-10-15）
- 用 YouTube 测试：封面、标题、歌手、进度条、总时长显示正确；播放/暂停按钮能控制 YouTube
- 媒体读取完全事件驱动（系统通知变化才读），没有轮询；进度条用 CSS 线性过渡，只在展开且播放时才动
- 放歌时空闲 CPU 约 0.1%，内存约 114 MB
- 内置浏览器测试时系统报告"不支持上一首/下一首"，按钮正确变灰；Chrome 里的"下一首"需要在 Chrome 实测
