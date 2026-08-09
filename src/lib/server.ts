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
  // 无默认地址：首次使用由用户在登录页填写（公共构建不含内网地址）
  return "";
}

export function setBaseUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, "");
  if (clean) localStorage.setItem(BASE_URL_KEY, clean);
}

/** 清除已保存的服务器地址（全部候选探测失败时回退用，避免失败地址持久化） */
export function clearBaseUrl(): void {
  localStorage.removeItem(BASE_URL_KEY);
}

/**
 * 生成候选服务器地址（协议+端口自动探测）：
 * - 无端口 → 默认补 :9119 探测
 * - 带端口 → 使用用户指定端口
 * - 已带协议 → 单元素 [原样]（无端口同样补 9119）
 * - 无协议 → 先 https 后 http（Hermes 9119 优先 https，失败回退 http）
 * 支持路径前缀（如 host:9119/hermes）
 */
export function baseCandidates(input: string): string[] {
  let v = input.trim().replace(/\/+$/, "");
  if (!v) return [];
  const hasProto = /^https?:\/\//i.test(v);
  const host = hasProto ? v.replace(/^https?:\/\//i, "") : v;
  const pathIdx = host.indexOf("/");
  const hostOnly = pathIdx >= 0 ? host.slice(0, pathIdx) : host;
  const rest = pathIdx >= 0 ? host.slice(pathIdx) : "";
  // 裸 IPv6（多冒号、无括号）→ 包上 [ ] 规范化，避免拼出非法 URL。
  // 判定用冒号计数（>2 段即裸 IPv6）而非排除 /:\d+$/：末段纯数字的 ::1 / fe80::1 等
  // 也会被 /:\d+$/ 误判为 host:port 而不加括号，最终拼出 https://::1 非法 URL。
  const isBareIpv6 = !hostOnly.startsWith("[") && hostOnly.split(":").length > 2;
  const hostPart = isBareIpv6 ? `[${hostOnly}]` : hostOnly;
  // 裸 IPv6 的末段也可能是纯数字（::1 / fe80::1 等），不能再用 /:\d+$/ 判 host:port——
  // 否则会把刚加的括号又丢掉，拼出 https://::1 非法 URL。host:port 判定仅对非裸 IPv6 生效。
  const withPort = !isBareIpv6 && /:\d+$/.test(hostOnly) ? host : `${hostPart}:9119${rest}`;
  if (hasProto) {
    const proto = /^https/i.test(v) ? "https" : "http";
    return [`${proto}://${withPort}`];
  }
  return [`https://${withPort}`, `http://${withPort}`];
}

/** 由 base URL 构造 REST 绝对地址（原生模式；Web 模式请求走相对路径不经过这里） */
export function restUrl(path: string): string {
  // Web 部署在子路径下时（location.pathname 非 "/"），同步拼上路径前缀，与 wsUrl 保持一致
  if (!isNative() && typeof location !== "undefined" && location.pathname && location.pathname !== "/") {
    return `${location.origin}${location.pathname.replace(/\/+$/, "")}${path}`;
  }
  return `${getBaseUrl()}${path}`;
}

/** 由 base URL 构造 WS 地址（http→ws, https→wss）。
 *  Web 模式走当前页面 origin：浏览器/vite 同源架构下 /api/ws 由 proxy（dev）或同源站点
 *  （生产 server.url）转发到后端，不依赖 localStorage baseUrl——Web 登录探测经相对路径
 *  "假成功"可能把 baseUrl 存成 https://IP:9119（9119 无 TLS），直接派生会拼出 wss:// 连不上。
 *  原生模式（CapacitorHttp 真实探测过的 baseUrl）保持原逻辑。 */
export function wsUrl(path: string): string {
  if (!isNative()) {
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
    // 子路径部署（pathname 非 "/"）时拼到 ws 路径前；根路径部署行为不变
    const prefix =
      typeof location !== "undefined" && location.pathname && location.pathname !== "/"
        ? location.pathname.replace(/\/+$/, "")
        : "";
    return `${proto}://${location.host}${prefix}${path}`;
  }
  const base = getBaseUrl();
  const proto = base.startsWith("https") ? "wss" : "ws";
  return `${proto}://${base.replace(/^https?:\/\//i, "")}${path}`;
}
