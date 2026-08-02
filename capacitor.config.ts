import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Hermes Mobile — Capacitor 配置
 *
 * server.url 模式：WebView 直接加载 NAS 上的前端静态页面（同源）。
 * 理由：Hermes 后端的 CORS 白名单硬编码只允许 localhost 源，跨域会被拦；
 * 页面同源后 cookie 由 WebView 原生管理，登录/WS ticket/WS 全链路零额外代码。
 * 附带好处：前端更新只需更新 NAS 上的静态文件，APK 无需重装。
 *
 * 部署：前端 dist/ 由 NAS nginx 容器托管（端口 9120），此处 URL 与之对应。
 */
const config: CapacitorConfig = {
  appId: "com.yangyu.hermesmobile",
  appName: "Hermes Mobile",
  webDir: "dist",
  server: {
    // 生产 APK 加载的前端地址（构建时固定）
    url: process.env.HERMES_MOBILE_SERVER_URL ?? "http://192.168.10.10:9120",
    cleartext: true, // 内网 http 明文（Android 9+ 默认禁明文）
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
