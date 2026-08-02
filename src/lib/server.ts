/**
 * 服务器地址管理：用户可自由填写（http/https、内网/公网、IP/域名、端口/路径前缀）
 */
import { Capacitor } from "@capacitor/core";

const BASE_URL_KEY = "hermes.server.url";

/** 是否为原生环境（Capacitor）——原生用 CapacitorHttp 绕 CORS，Web 用浏览器 fetch */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function getBaseUrl(): string {
  const stored = localStorage.getItem(BASE_URL_KEY);
  if (stored) return stored.replace(/\/+$/, "");
  // 默认值：内网 Hermes 后端
  return "http://192.168.10.10:9119";
}

export function setBaseUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, "");
  if (clean) localStorage.setItem(BASE_URL_KEY, clean);
}

/** 规范化用户输入：补全协议前缀（无协议时默认 http://） */
export function normalizeBaseUrl(input: string): string {
  let v = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v;
}

/** 由 base URL 构造 REST 绝对地址 */
export function restUrl(path: string): string {
  return `${getBaseUrl()}${path}`;
}

/** 由 base URL 构造 WS 地址（http→ws, https→wss） */
export function wsUrl(path: string): string {
  const base = getBaseUrl();
  const proto = base.startsWith("https") ? "wss" : "ws";
  return `${proto}://${base.replace(/^https?:\/\//i, "")}${path}`;
}
