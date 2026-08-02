/**
 * Hermes Mobile — REST 认证层
 *
 * 与 Hermes Web Dashboard 完全同源（相对路径），开发模式由 Vite proxy 转发，
 * 生产模式页面直接由 NAS 同源提供（Capacitor server.url 模式）。
 *
 * 协议依据（Hermes v0.19.1 源码）：
 *   - POST /auth/password-login  {provider:"basic", username, password, next}
 *     成功 → 200 {ok, next} + Set-Cookie 会话 cookie
 *   - GET /api/auth/ws-ticket   带 cookie → {ticket, ttl_seconds}（一次性票据）
 *   - WS /api/ws?ticket=<ticket> 升级鉴权（gated 模式拒绝旧 ?token=）
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface LoginResult {
  ok: boolean;
  next?: string;
}

/** 用户名/密码登录（basic provider），成功后 cookie 由浏览器自动管理 */
export async function passwordLogin(username: string, password: string): Promise<LoginResult> {
  const res = await fetch("/auth/password-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ provider: "basic", username, password, next: "" }),
  });
  if (res.ok) {
    return (await res.json()) as LoginResult;
  }
  if (res.status === 401) throw new ApiError("用户名或密码错误", 401);
  if (res.status === 429) throw new ApiError("尝试次数过多，请稍后再试", 429);
  throw new ApiError(`登录失败 (HTTP ${res.status})`, res.status);
}

export interface WsTicket {
  ticket: string;
  ttl_seconds: number;
}

/** 获取一次性 WebSocket ticket（需已登录）。注意：官方前端用 POST */
export async function getWsTicket(): Promise<WsTicket> {
  const res = await fetch("/api/auth/ws-ticket", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(`获取 WS ticket 失败 (HTTP ${res.status})`, res.status);
  }
  return (await res.json()) as WsTicket;
}

/** 由当前页面 origin 构造 WS 地址（同源） */
export function buildWsUrl(ticket: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** 探测后端是否可达 / 需要登录 */
export async function apiStatus(): Promise<{
  version: string;
  auth_required?: boolean;
  auth_providers?: string[];
}> {
  const res = await fetch("/api/status", { credentials: "include" });
  if (!res.ok) throw new ApiError(`后端不可达 (HTTP ${res.status})`, res.status);
  return await res.json();
}
