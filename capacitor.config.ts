import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Hermes Mobile — Capacitor 配置
 *
 * 本地打包模式：前端资源打进 APK（页面运行于 server.androidScheme 定义的主机，详见下），
 * 服务器地址由 App 内设置页自由填写（http/https、内网/公网）。
 * - REST 层：原生环境走 CapacitorHttp（绕开浏览器 CORS），手动管理 cookie
 * - WS 层：WebSocket 本身不受 CORS 限制（服务端只校验 ticket）
 * - 明文 HTTP（内网场景）：usesCleartextTraffic=true 已在 AndroidManifest 配置
 *
 * ⚠️ androidScheme 必须为 "http"（1.0.27 修复）：
 * Capacitor 8 默认 https://localhost 页面 → App 内 JS 发起的 ws:// 明文连接会被
 * WebView 当作 Mixed Content 拦截（连接请求根本到不了服务器，表现为"能登录但无限转圈"）。
 * 页面改用 http://localhost 后，ws:// 与页面同为明文，不再触发混合内容拦截。
 * 明文允许由 android.allowMixedContent + Manifest usesCleartextTraffic=true 保证。
 */
const config: CapacitorConfig = {
  appId: "com.hermesmobile.app",
  appName: "Hermes Mobile",
  webDir: "dist",
  server: {
    androidScheme: "http",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
