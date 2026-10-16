import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    // 每个窗口一个页面：灵动岛 index.html、侧边架子 shelf.html、桌面小组件 widgets.html
    rollupOptions: { input: { island: "index.html", shelf: "shelf.html", widgets: "widgets.html" } },
  },
});
