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

/**
 * 统一 fetch 封装：带 credentials，遇 401（会话过期）广播
 * `hermes:unauthorized` 事件，App 监听后切回登录页并关闭 gateway。
 * 登录接口本身不用它（401 = 密码错误，不是会话过期）。
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("hermes:unauthorized"));
  }
  return res;
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
  const res = await apiFetch("/api/auth/ws-ticket", {
    method: "POST",
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

// ---- 会话 REST API（比 tui_gateway session.list 多了 pinned/source 支持）----

export interface RestSession {
  id: string;
  source?: string;
  title?: string;
  preview?: string;
  started_at?: number;
  last_active?: number;
  message_count?: number;
  archived?: boolean;
  pinned?: boolean;
  [k: string]: unknown;
}

/** 拉取会话列表（REST，含 pinned 标记；source 可过滤） */
export async function listSessionsRest(params: {
  limit?: number;
  order?: "created" | "recent";
  source?: string;
  sources?: string;
  exclude_sources?: string;
} = {}): Promise<RestSession[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit ?? 200));
  qs.set("order", params.order ?? "recent");
  if (params.source) qs.set("source", params.source);
  if (params.sources) qs.set("sources", params.sources);
  if (params.exclude_sources) qs.set("exclude_sources", params.exclude_sources);
  const res = await apiFetch(`/api/sessions?${qs.toString()}`);
  if (!res.ok) throw new ApiError(`获取会话列表失败 (HTTP ${res.status})`, res.status);
  const data = (await res.json()) as { sessions?: RestSession[] };
  return data.sessions ?? [];
}

/** 置顶 / 取消置顶会话 */
export async function setSessionPinnedRest(sessionId: string, pinned: boolean): Promise<void> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new ApiError(`置顶操作失败 (HTTP ${res.status})`, res.status);
}

/** 重命名会话 */
export async function renameSessionRest(sessionId: string, title: string): Promise<void> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new ApiError(`重命名失败 (HTTP ${res.status})`, res.status);
}

/** 删除会话 */
export async function deleteSessionRest(sessionId: string): Promise<void> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new ApiError(`删除失败 (HTTP ${res.status})`, res.status);
}
