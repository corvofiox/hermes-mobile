import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Hermes Mobile — Vite config
// 开发模式：所有 /auth 与 /api 请求（含 /api/ws WebSocket）代理到 Hermes 后端，
// 使浏览器看到的是同源页面 —— 与服务端 CORS 白名单（仅 localhost）兼容。
// 生产模式：前端静态文件由 NAS 同源提供（Capacitor server.url 模式），无需代理。

const HERMES_BACKEND = process.env.HERMES_BACKEND ?? "http://localhost:9119";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/auth": {
        target: HERMES_BACKEND,
        changeOrigin: true,
      },
      "/api": {
        target: HERMES_BACKEND,
        changeOrigin: true,
        ws: true, // /api/ws WebSocket 升级转发
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
