import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Hermes Mobile — Capacitor 配置
 *
 * 本地打包模式：前端资源打进 APK（页面运行于 server.androidScheme + server.hostname
 * 定义的主机，详见下），服务器地址由 App 内设置页自由填写（http/https、内网/公网）。
 * - REST 层：原生环境走 CapacitorHttp（绕开浏览器 CORS），手动管理 cookie
 * - WS 层：WebSocket 本身不受 CORS 限制（服务端只校验 ticket）
 * - 明文 HTTP（内网场景）：usesCleartextTraffic=true 已在 AndroidManifest 配置
 *
 * ⚠️ androidScheme + hostname 的组合是 WS 连不上的根因（1.0.27 仅修了一半）：
 * - Capacitor 8 默认 https://localhost 页面 → ws:// 明文连接被 WebView 按混合内容拦截
 * - 1.0.27 把 androidScheme 改成 "http" 后，页面是 http://localhost——但 localhost 在
 *   Chromium 中仍属"安全上下文"（potentially trustworthy），http://localhost 连明文
 *   ws:// 照样被混合内容规则拦截（REST 走 CapacitorHttp 原生通道不受影响，所以表现为
 *   "能登录/能拿 ticket 但 WS 无限转圈"）。
 * - 关键修复：hostname 必须改为非 localhost 的域名（hermes.local）。页面 origin 变成
 *   http://hermes.local（非安全上下文），明文 ws:// 不再被拦。Capacitor 的本地资源
 *   拦截（shouldInterceptRequest）跟随此项注册，assets 加载不受影响。
 * - 注意：hostname 变更会再次清空 localStorage（origin 变化），用户需重新登录一次，
 *   之后 origin 稳定不再丢。
 */
const config: CapacitorConfig = {
  appId: "com.hermesmobile.app",
  appName: "Hermes Mobile",
  webDir: "dist",
  server: {
    androidScheme: "http",
    hostname: "hermes.local",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;