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

/**
 * 生成候选服务器地址（协议+端口自动探测）：
 * - 无端口 → 默认补 :9119 探测
 * - 带端口 → 使用用户指定端口
 * - 已带协议 → 单元素 [原样]（无端口同样补 9119）
 * - 无协议 → 先 https 后 http（Hermes 9119 优先 https，失败回退 http）
 * 支持路径前缀（如 192.168.10.10:9119/hermes）
 */
export function baseCandidates(input: string): string[] {
  let v = input.trim().replace(/\/+$/, "");
  if (!v) return [];
  const hasProto = /^https?:\/\//i.test(v);
  const host = hasProto ? v.replace(/^https?:\/\//i, "") : v;
  const pathIdx = host.indexOf("/");
  const hostOnly = pathIdx >= 0 ? host.slice(0, pathIdx) : host;
  const rest = pathIdx >= 0 ? host.slice(pathIdx) : "";
  const withPort = /:\d+$/.test(hostOnly) ? host : `${hostOnly}:9119${rest}`;
  if (hasProto) {
    const proto = /^https/i.test(v) ? "https" : "http";
    return [`${proto}://${withPort}`];
  }
  return [`https://${withPort}`, `http://${withPort}`];
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
