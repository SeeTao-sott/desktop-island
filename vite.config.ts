import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    // 两个窗口两个页面：灵动岛 index.html、侧边架子 shelf.html
    rollupOptions: { input: { island: "index.html", shelf: "shelf.html" } },
  },
});
