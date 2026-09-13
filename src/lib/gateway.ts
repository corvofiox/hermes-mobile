/**
 * Hermes Mobile — Gateway 封装
 *
 * 基于官方 @hermes/shared 的 JsonRpcGatewayClient（MIT，vendor 拷贝），
 * 封装 tui_gateway JSON-RPC/WebSocket 协议（newline-delimited frames）。
 *
 * 请求: {"jsonrpc":"2.0","id":"m1","method":"session.create","params":{...}}
 * 响应: {"id":"m1","result":{...}}  /  {"id":"m1","error":{...}}
 * 事件: {"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","payload":{...},"session_id":"..."}}
 *
 * 注意：服务端事件与 prompt.submit/session.interrupt 使用「live session_id」
 * （session.resume / session.create 响应里的 session_id），而 REST 列表里的是
 * 持久化 stored id。见 ChatPage 的 liveSessionIdRef 处理。
 */

import {
  JsonRpcGatewayClient,
  type GatewayEvent,
  type GatewayEventName,
  type ConnectionState,
} from "./vendor/json-rpc-gateway";
import { getWsTicket } from "./api";
import { wsUrl } from "./server";

export type { GatewayEvent, GatewayEventName, ConnectionState };

// ---- 会话数据结构 -------------------------------------------------------

export interface HistoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  content?: string;
  /** 服务端显示分类（hidden/async_delegation_complete/auto_continue 等系统类需过滤） */
  display_kind?: string;
  [k: string]: unknown;
}

/** 系统类 display_kind：模型运行时元数据，任何客户端都不应渲染为用户气泡 */
export const SYSTEM_DISPLAY_KINDS = new Set([
  "hidden",
  "model_switch",
  "async_delegation_complete",
  "auto_continue",
  "delegate_start",
  "system_note",
]);

/**
 * 服务端合成 user 消息前缀（agent/conversation_compression.py _SYNTHETIC_USER_PREFIXES）：
 * 后台进程通知/压缩提示等无 display_kind，按内容前缀兜底过滤。
 */
export const SYNTHETIC_USER_PREFIXES = [
  "[System: Your previous response was truncated",
  "[System: The previous response was cut off",
  "[System: Your previous tool call",
  "[Your active task list was preserved across context compression]",
  "[IMPORTANT: Background process ",
];

/** 判断是否为系统/合成消息（display_kind 命中或合成前缀命中） */
export function isSystemMessage(m: HistoryMessage): boolean {
  if (m.display_kind && SYSTEM_DISPLAY_KINDS.has(m.display_kind)) return true;
  if (m.role === "user") {
    const text = String(m.text ?? m.content ?? "");
    return SYNTHETIC_USER_PREFIXES.some((p) => text.startsWith(p));
  }
  return false;
}

/** 服务端 session.resume 返回（methods_session.py 实际结构，无顶层 title） */
export interface ResumeSessionResult {
  /** live session id —— prompt.submit / 事件过滤都用它 */
  session_id: string;
  /** 被 resume 的持久化 id */
  resumed?: string;
  message_count: number;
  messages: HistoryMessage[];
  info?: Record<string, unknown>;
  /** 运行中回合的快照（断线重连恢复流式用） */
  inflight?: {
    assistant?: string;
    streaming?: boolean;
    user?: string;
    error?: string;
    status?: string;
    recoverable?: boolean;
  } | null;
  running: boolean;
  session_key?: string;
  started_at?: number;
  status?: string;
  auto_continue?: unknown;
}

/** 服务端 session.create 返回 */
export interface CreateSessionResult {
  /** live session id */
  session_id: string;
  /** 持久化 stored id（REST 列表里的 id） */
  stored_session_id: string;
  message_count: number;
  messages: HistoryMessage[];
  info?: Record<string, unknown>;
}

/** 服务端 model.options 返回（方法与 REST /api/model/options 同构） */
export interface ModelOptionsResult {
  providers: Array<Record<string, unknown>>;
  /** 当前默认模型（裸名，不含 provider 前缀） */
  model?: string;
  /** 当前默认 provider slug */
  provider?: string;
}

/**
 * 思考强度档位（与后端 command_manifest.py:_REASONING_CHOICES 严格一致）。
 * `none` = 显式关闭思考（后端 parse_reasoning_effort 转 {"enabled": False}）。
 * 顺序即 UI 展示顺序（由弱到强）。
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 档位中文标签（UI 展示用；语义对齐后端 zh.yaml 的 level_default/level_disabled） */
export const REASONING_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "极限",
};

// ---- Gateway 客户端封装 --------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export class HermesGateway {
  private client: JsonRpcGatewayClient;
  /** in-flight connect Promise（并发 connect 共享，防竞态） */
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private autoReconnect = true;
  /** 连接代次：close() 递增，使 in-flight connect 失效（防登出后旧 connect 完成 → 空闲 WS 泄漏） */
  private generation = 0;

  constructor() {
    this.client = new JsonRpcGatewayClient({
      requestIdPrefix: "m",
      closedErrorMessage: "连接已断开",
      connectErrorMessage: "连接失败",
      notConnectedErrorMessage: "网关未连接",
      // 大文件 attach（最高 256MB → base64 ~341MB 帧）传输可能超默认 120s；
      // 600s 覆盖 5Mbps 上行传输 256MB（约 9 分钟）；普通请求响应秒级不受影响
      requestTimeoutMs: 600_000,
    });
    // 断线自动重连（closed/error → 指数退避重试，重取 ticket）
    this.client.onState((state) => {
      if ((state === "closed" || state === "error") && this.autoReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  /** 订阅连接状态变化，返回取消函数 */
  onConnectionState(handler: (state: ConnectionState) => void): () => void {
    return this.client.onState(handler);
  }

  get connectionState(): ConnectionState {
    return this.client.connectionState;
  }

  /**
   * 连接：先取一次性 ticket，再建 WS。
   * 并发调用共享同一个 in-flight Promise（vendor 在 connecting 态会直接 resolve，
   * 若不缓存会让第二个调用者拿到未就绪的连接）。
   */
  async connect(): Promise<void> {
    if (this.client.connectionState === "open") return;
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const gen = ++this.generation;
    try {
      const { ticket } = await getWsTicket();
      // close() 已在等待 ticket 期间发生：放弃建连（不建立 WS）
      if (gen !== this.generation) return;
      await this.client.connect(`${wsUrl("/api/ws")}?ticket=${encodeURIComponent(ticket)}`);
      // 竞态窗口（client.connect 挂起期间被 close）：关闭刚建立的 WS
      if (gen !== this.generation) {
        this.client.close();
        return;
      }
      this.reconnectAttempts = 0;
    } catch (err) {
      // 401/403 = 会话过期：getWsTicket 经 apiFetch 已广播 hermes:unauthorized，
      // 这里不再重复广播（App 处理器幂等，但避免重连循环里每次退避都广播两次）
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // 失败继续退避重试（onState 的 error 回调也会触发，这里有 timer 防重）
        this.scheduleReconnect();
      });
    }, delay);
  }

  close(): void {
    this.generation += 1; // 使 in-flight connect 失效
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client.close();
  }

  on(event: GatewayEventName, handler: (ev: GatewayEvent) => void): () => void {
    return this.client.on(event, handler);
  }

  // ---- RPC 方法 ---------------------------------------------------------

  async createSession(params: {
    title?: string;
    messages?: HistoryMessage[];
    cols?: number;
    /** 显式模型覆盖（桌面端行为：不传会继承 serve 默认，可能撞免费档限流） */
    model?: string;
    provider?: string;
    /** 显式思考强度覆盖（PER-SESSION，不写全局 config；不传则继承服务端 agent.reasoning_effort） */
    reasoning_effort?: string;
  } = {}): Promise<CreateSessionResult> {
    return this.client.request<CreateSessionResult>("session.create", {
      cols: params.cols ?? 50,
      title: params.title ?? "",
      messages: params.messages ?? [],
      ...(params.model ? { model: params.model } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.reasoning_effort ? { reasoning_effort: params.reasoning_effort } : {}),
    });
  }

  async resumeSession(session_id: string): Promise<ResumeSessionResult> {
    return this.client.request<ResumeSessionResult>("session.resume", { session_id });
  }

  async submitPrompt(session_id: string, text: string): Promise<void> {
    await this.client.request("prompt.submit", { session_id, text });
  }

  /** 中断当前回合（服务端 session.interrupt，不污染对话记录） */
  async interrupt(session_id: string): Promise<void> {
    await this.client.request("session.interrupt", { session_id });
  }

  /**
   * 切换本会话模型（服务端 slash.exec /model，本会话生效，不写全局 config）。
   * 与桌面端 ModelPicker 同一通道；必须带 --provider <slug>，否则同名模型被
   * custom 端点与原生 provider 双声明时服务端报歧义、切换不落地。
   *
   * 回执校验：服务端**成功与失败文案均随语言变化**，逐条核对 locales 后确认——
   *   成功 zh「已切换模型为 `x`」/ en「Model switched to `x`」（均无 ✓ 前缀）
   *   失败「错误：…」/「Error: …」（error_prefix，**不含任何符号标记**）
   *   另有 parser 错误硬编码 `❌ …`、告警 `⚠️ …`
   * 因此既不能按 ✓ 判成功，也不能只按符号判失败（error_prefix 无符号）。
   * 采用「命中成功文案即成功，否则失败」——对新增失败分支天然安全（一律视为失败）。
   */
  async setSessionModel(
    session_id: string,
    provider: string,
    model: string
  ): Promise<void> {
    const { output } = await this.client.request<{ output?: string }>("slash.exec", {
      session_id,
      command: `/model ${model} --provider ${provider}`,
    });
    const text = String(output ?? "");
    const ok = /已切换模型为|Model switched to/.test(text);
    if (!ok) {
      throw new Error(text.trim().split("\n")[0] || "模型切换未生效");
    }
  }

  /**
   * 设置本会话思考强度（服务端 slash.exec /reasoning <effort>，本会话生效）。
   * `none` = 显式关闭思考。传 "reset" 可清除会话覆盖、回退全局默认。
   *
   * 回执校验（逐条核对 locales/zh.yaml + en.yaml 后确认）：
   *   成功「🧠 ✓ 推理强度已设置为 `x`（仅本会话…）」——含 ✓，故不能按 ✓ 判成功
   *   失败「⚠️ 未知参数：`x`」/「⚠️ 不支持 /reasoning reset --global」/「⚠️ 会话内不支持…」
   * 采用「命中成功文案即成功，否则失败」，与 setSessionModel 同策略。
   * 锚点 `推理强度已设置` 同时覆盖 set_session / set_global / set_global_save_failed 三种成功文案。
   */
  async setSessionReasoning(session_id: string, effort: string): Promise<void> {
    const value = effort.trim();
    if (!value) return;
    const { output } = await this.client.request<{ output?: string }>("slash.exec", {
      session_id,
      command: `/reasoning ${value}`,
    });
    const text = String(output ?? "");
    const ok =
      /推理强度已设置|已清除本会话的推理覆盖|Reasoning effort set to|Session reasoning override cleared/.test(
        text,
      );
    if (!ok) {
      throw new Error(text.trim().split("\n")[0] || "思考强度设置未生效");
    }
  }

  /**
   * 拉取模型清单（WS RPC `model.options`，与 REST /api/model/options 同构）。
   *
   * 走 WS 而非 REST：REST 版只注册在 gateway 的 api_server 平台（:8642），
   * 而 App 连的是 dashboard（:9119）—— 无此路由。WS 方法在同一连接上恒可用。
   * 返回顶层 model/provider 即服务端默认（裸名 + slug），与 ModelPref 形状一致。
   */
  async getModelOptions(params: { session_id?: string; refresh?: boolean } = {}): Promise<ModelOptionsResult> {
    const res = await this.client.request<ModelOptionsResult>("model.options", {
      ...(params.session_id ? { session_id: params.session_id } : {}),
      ...(params.refresh ? { refresh: true } : {}),
    });
    return {
      providers: Array.isArray(res?.providers) ? res.providers : [],
      model: typeof res?.model === "string" ? res.model : "",
      provider: typeof res?.provider === "string" ? res.provider : "",
    };
  }

  /**
   * 读服务端配置项（WS RPC `config.get`）。常用 key：
   *   reasoning → { value: "<effort>", display: "show"|"hide" }
   *   provider  → { model, provider, providers }（注意 model 是 `provider/model` 全名，
   *               且无 `/` 时 provider 退化为 "unknown" —— 取默认模型别用这个 key）
   * 未知 key 会以 JSON-RPC error 返回（4002）。
   */
  async getConfigValue<T = Record<string, unknown>>(
    key: string,
    session_id?: string
  ): Promise<T> {
    return this.client.request<T>("config.get", {
      key,
      ...(session_id ? { session_id } : {}),
    });
  }

  /** 附加图片（base64 直传，服务端写入图片目录并挂载到会话；移动端专用路径） */
  async attachImage(
    session_id: string,
    contentBase64: string,
    filename?: string,
  ): Promise<{
    attached: boolean;
    path?: string;
    count?: number;
    text?: string;
    error?: unknown;
  }> {
    return this.client.request("image.attach_bytes", {
      session_id,
      content_base64: contentBase64,
      ...(filename ? { filename } : {}),
    });
  }

  /** 附加文件（data_url 上传，服务端写入 workspace；返回 @file: 引用文本） */
  async attachFile(
    session_id: string,
    dataUrl: string,
    name?: string,
  ): Promise<{
    attached: boolean;
    name?: string;
    path?: string;
    ref_path?: string;
    ref_text?: string;
    uploaded?: boolean;
    error?: unknown;
  }> {
    return this.client.request("file.attach", {
      session_id,
      data_url: dataUrl,
      ...(name ? { name } : {}),
    });
  }
}
