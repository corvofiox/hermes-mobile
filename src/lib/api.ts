/**
 * Hermes Mobile — REST 认证层（支持自由配置服务器地址：http/https、内网/公网）
 *
 * 双路径设计：
 * - 原生环境（Capacitor）：CapacitorHttp 原生请求（绕开浏览器 CORS 限制），
 *   手动管理 cookie（从 Set-Cookie 响应头提取存储，请求带 Cookie 头）
 * - Web 环境（浏览器/vite dev）：普通 fetch + credentials:include（同源或 vite proxy）
 *
 * 协议依据（Hermes v0.19.1 源码）：
 *   - POST /auth/password-login  {provider:"basic", username, password, next}
 *     成功 → 200 {ok, next} + Set-Cookie 会话 cookie
 *   - POST /api/auth/ws-ticket  带 cookie → {ticket, ttl_seconds}（一次性票据）
 *   - WS  /api/ws?ticket=<ticket> 升级鉴权（gated 模式拒绝旧 ?token=）
 */
import { CapacitorHttp } from "@capacitor/core";
import { getBaseUrl, isNative, restUrl } from "./server";

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

// ---- Cookie 管理（原生模式；Web 模式由浏览器自动管理）----

const COOKIE_KEY = "hermes.cookies";

export function getCookieHeader(): string {
  return localStorage.getItem(COOKIE_KEY) ?? "";
}

export function clearCookies(): void {
  localStorage.removeItem(COOKIE_KEY);
}

/** 从 Set-Cookie 响应头提取 cookie（支持单值/逗号合并多值），合并进本地存储 */
function mergeCookiesFromHeader(setCookieValue: string | string[] | undefined): void {
  if (!setCookieValue) return;
  const entries = Array.isArray(setCookieValue) ? setCookieValue : [setCookieValue];
  const pairs = new Map<string, string>();
  // 已有 cookie 保留
  for (const part of getCookieHeader().split(";")) {
    const i = part.indexOf("=");
    if (i > 0) pairs.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const entry of entries) {
    // 每个 set-cookie 可能含多个（逗号分隔），按 "name=value; attrs" 片段切分
    const segments = entry.split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/);
    for (const seg of segments) {
      const kv = seg.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) pairs.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  const joined = [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (joined) localStorage.setItem(COOKIE_KEY, joined);
}

// ---- 双路径请求核心 ----

interface HttpResult {
  status: number;
  data: unknown;
}

/**
 * 统一请求：原生走 CapacitorHttp（带手动 Cookie），Web 走 fetch（浏览器 cookie）。
 * 401（会话过期，非登录接口）广播 hermes:unauthorized。
 */
async function httpRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  opts: { silent401?: boolean } = {},
): Promise<HttpResult> {
  if (isNative()) {
    const res = await CapacitorHttp.request({
      url: restUrl(path),
      method: init.method ?? "GET",
      headers: {
        ...(init.headers ?? {}),
        ...(getCookieHeader() ? { Cookie: getCookieHeader() } : {}),
      },
      data: init.body as Record<string, unknown> | undefined,
    });
    // 提取登录等接口的 Set-Cookie
    const sc = (res.headers as Record<string, string | string[]>)["set-cookie"]
      ?? (res.headers as Record<string, string | string[]>)[`Set-Cookie`];
    if (sc) mergeCookiesFromHeader(sc);
    if (res.status === 401 && !opts.silent401) {
      window.dispatchEvent(new CustomEvent("hermes:unauthorized"));
    }
    return { status: res.status, data: res.data };
  }
  // Web：相对路径（vite proxy 同源转发）；浏览器自动管理 cookie
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    credentials: "include",
    body: typeof init.body === "string" ? init.body : init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && !opts.silent401) {
    window.dispatchEvent(new CustomEvent("hermes:unauthorized"));
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** 用户名/密码登录（basic provider）。原生模式提取 cookie 存储；Web 模式浏览器自动管理 */
export async function passwordLogin(username: string, password: string): Promise<LoginResult> {
  const { status, data } = await httpRequest(
    "/auth/password-login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { provider: "basic", username, password, next: "" },
    },
    { silent401: true }, // 登录 401 = 密码错误，不是会话过期
  );
  if (status === 200) return (data ?? {}) as LoginResult;
  if (status === 401) throw new ApiError("用户名或密码错误", 401);
  if (status === 429) throw new ApiError("尝试次数过多，请稍后再试", 429);
  throw new ApiError(`登录失败 (HTTP ${status})`, status);
}

/** 登出：清 cookie 并调用服务端登出 */
export async function logout(): Promise<void> {
  try {
    await httpRequest("/auth/logout", { method: "POST" }, { silent401: true });
  } catch {
    // 忽略登出失败
  }
  clearCookies();
}

export interface WsTicket {
  ticket: string;
  ttl_seconds: number;
}

/** 获取一次性 WebSocket ticket（需已登录）。注意：官方前端用 POST */
export async function getWsTicket(): Promise<WsTicket> {
  const { status, data } = await httpRequest("/api/auth/ws-ticket", { method: "POST" });
  if (status !== 200) {
    throw new ApiError(`获取 WS ticket 失败 (HTTP ${status})`, status);
  }
  return data as WsTicket;
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
  /** 归档过滤：exclude（默认，隐藏归档）/ only（只看归档）/ include（全部） */
  archived?: "exclude" | "only" | "include";
} = {}): Promise<RestSession[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit ?? 200));
  qs.set("order", params.order ?? "recent");
  if (params.source) qs.set("source", params.source);
  if (params.sources) qs.set("sources", params.sources);
  if (params.exclude_sources) qs.set("exclude_sources", params.exclude_sources);
  qs.set("archived", params.archived ?? "exclude");
  const { status, data } = await httpRequest(`/api/sessions?${qs.toString()}`);
  if (status !== 200) throw new ApiError(`获取会话列表失败 (HTTP ${status})`, status);
  return ((data as { sessions?: RestSession[] })?.sessions) ?? [];
}

/** 搜索会话（REST FTS；结果结构为 {results: [...]}，形状与列表行一致） */
export async function searchSessionsRest(q: string, limit = 30): Promise<RestSession[]> {
  const qs = new URLSearchParams();
  qs.set("q", q);
  qs.set("limit", String(limit));
  const { status, data } = await httpRequest(`/api/sessions/search?${qs.toString()}`);
  if (status !== 200) throw new ApiError(`搜索失败 (HTTP ${status})`, status);
  return ((data as { results?: RestSession[] })?.results) ?? [];
}

/** 归档 / 取消归档会话 */
export async function setSessionArchivedRest(sessionId: string, archived: boolean): Promise<void> {
  const { status } = await httpRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: { archived },
  });
  if (status !== 200) throw new ApiError(`归档操作失败 (HTTP ${status})`, status);
}

/** 批量删除会话（单事务） */
export async function bulkDeleteSessionsRest(ids: string[]): Promise<{ deleted: number }> {
  const { status, data } = await httpRequest("/api/sessions/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { ids },
  });
  if (status !== 200) throw new ApiError(`批量删除失败 (HTTP ${status})`, status);
  return (data as { deleted: number }) ?? { deleted: 0 };
}

/** 批量归档 / 取消归档（服务端无批量接口，逐个 PATCH；容忍单条失败继续） */
export async function bulkArchiveSessionsRest(ids: string[], archived: boolean): Promise<number> {
  let done = 0;
  for (const id of ids) {
    try {
      await setSessionArchivedRest(id, archived);
      done += 1;
    } catch {
      // 单条失败不阻断其余
    }
  }
  return done;
}

/** 置顶 / 取消置顶会话 */
export async function setSessionPinnedRest(sessionId: string, pinned: boolean): Promise<void> {
  const { status } = await httpRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: { pinned },
  });
  if (status !== 200) throw new ApiError(`置顶操作失败 (HTTP ${status})`, status);
}

/** 重命名会话 */
export async function renameSessionRest(sessionId: string, title: string): Promise<void> {
  const { status } = await httpRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: { title },
  });
  if (status !== 200) throw new ApiError(`重命名失败 (HTTP ${status})`, status);
}

/** 删除会话 */
export async function deleteSessionRest(sessionId: string): Promise<void> {
  const { status } = await httpRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (status !== 200) throw new ApiError(`删除失败 (HTTP ${status})`, status);
}

/** 探测服务器连通性（设置页用；原生走 CapacitorHttp 绕 CORS，Web 直接 fetch） */
export async function checkServer(baseUrl: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/status`;
  try {
    if (isNative()) {
      const res = await CapacitorHttp.request({ url, method: "GET" });
      if (res.status === 200) {
        const d = res.data as { version?: string } | undefined;
        return { ok: true, version: d?.version };
      }
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const res = await fetch(url, { method: "GET" });
    if (res.ok) {
      const d = (await res.json()) as { version?: string };
      return { ok: true, version: d.version };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: isNative() ? base : `${base}（浏览器跨域限制，安装 App 后不受影响）`,
    };
  }
}

// ---- 模型选项（/api/model/options，与 tui_gateway model.options 同构）----

export interface ModelProvider {
  slug: string;
  name: string;
  models: string[];
  total_models?: number;
  authenticated?: boolean;
  is_current?: boolean;
  warning?: string;
  [k: string]: unknown;
}

export interface ModelOptions {
  providers: ModelProvider[];
  model?: string;
  provider?: string;
}

/** 拉取可用模型（认证过的 provider + 模型列表） */
export async function getModelOptions(): Promise<ModelOptions> {
  const { status, data } = await httpRequest("/api/model/options");
  if (status !== 200) throw new ApiError(`获取模型列表失败 (HTTP ${status})`, status);
  const d = (data ?? {}) as Partial<ModelOptions>;
  return {
    providers: Array.isArray(d.providers) ? d.providers : [],
    model: d.model ?? "",
    provider: d.provider ?? "",
  };
}

// ---- 模型偏好持久化（新会话创建时使用）----

const MODEL_PREF_KEY = "hermes.model.pref";

export interface ModelPref {
  model: string;
  provider: string;
}

export function getModelPref(): ModelPref {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ModelPref;
      if (parsed.model) return parsed;
    }
  } catch {
    // 损坏的偏好忽略，回退默认
  }
  return { model: "deepseek-v4-flash", provider: "opencode-go" };
}

export function setModelPref(pref: ModelPref): void {
  localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(pref));
}

// 兼容导出：旧代码引用的 buildWsUrl 由 gateway.ts 改用 server.ts 的 wsUrl
export { getBaseUrl };
