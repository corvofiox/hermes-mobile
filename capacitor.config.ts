import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Hermes Mobile — Capacitor 配置
 *
 * 本地打包模式：前端资源打进 APK（capacitor://localhost），
 * 服务器地址由 App 内设置页自由填写（http/https、内网/公网）。
 * - REST 层：原生环境走 CapacitorHttp（绕开浏览器 CORS），手动管理 cookie
 * - WS 层：WebSocket 本身不受 CORS 限制（服务端只校验 ticket）
 * - 明文 HTTP（内网场景）：usesCleartextTraffic=true 已在 AndroidManifest 配置
 */
const config: CapacitorConfig = {
  appId: "com.yangyu.hermesmobile",
  appName: "Hermes Mobile",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
};

export default config;
