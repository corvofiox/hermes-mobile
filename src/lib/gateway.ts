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
   * 切换本会话模型（WS RPC `config.set` key=model，与桌面端 TUI /model 完全同一通道）。
   *
   * 为什么弃用 slash.exec：slash.exec 的回执是渲染后的多语言文案，成功/失败只能靠
   * 正则嗅探（1.0.33 的 `/✓\s*Model switched/` 与 1.0.34 的 `/已切换模型为/` 都因
   * 文案 key 对不上而恒判失败，服务端明明切换成功、客户端却回滚显示），且走
   * _SlashWorker 子进程 + _mirror_slash_side_effects 二次镜像，链路长、竞态多。
   * config.set 直达 methods_config_set._set_model → _apply_model_switch，
   * 返回结构化 JSON：
   *   成功 { key, value: <模型名>, warning, confirm_required: false, scope: "session" }
   *   待确认 { confirm_required: true, confirm_message }（昂贵模型二段确认）
   *   失败 JSON-RPC error（code 5001，message 即原因）
   * 桌面端 TUI 正是用这个通道（tui_dist entry.js：value 非空即成功）。
   *
   * value 语法与 /model 参数一致：`<model> --provider <slug>`。必须带 --provider：
   * 同名模型被 custom 端点与原生 provider 双声明时，服务端会报歧义拒绝切换。
   * 已实测：跨 provider（dsh-free-model → openrouter）成功且 /model 回查确认。
   */
  async setSessionModel(
    session_id: string,
    provider: string,
    model: string
  ): Promise<void> {
    const res = await this.client.request<{
      key?: string;
      value?: string;
      warning?: string;
      confirm_required?: boolean;
      confirm_message?: string;
      deferred?: boolean;
      scope?: string;
    }>("config.set", {
      key: "model",
      session_id,
      value: `${model} --provider ${provider}`,
    });
    // 成功判定与桌面端一致：value 非空即已切换（会话范围）
    if (!res || typeof res.value !== "string" || !res.value) {
      throw new Error("模型切换未生效");
    }
    if (res.confirm_required) {
      // 昂贵模型需要二次确认：不自动确认，提示用户改选或重试确认
      throw new Error(
        (res.confirm_message || res.warning || "该模型需要确认后才能切换").trim(),
      );
    }
  }

  /**
   * 设置本会话思考强度（WS RPC `config.set` key=reasoning，与 setSessionModel 同通道）。
   * 弃用 slash.exec /reasoning 的理由同 setSessionModel：文案嗅探不可靠，
   * config.set 返回结构化 { value, warning, confirm_required, scope }。
   * `none` = 显式关闭思考。传 "reset" 可清除会话覆盖、回退全局默认。
   * 实测失败路径（未知参数等）返回 JSON-RPC error，无需文案判定。
   */
  async setSessionReasoning(session_id: string, effort: string): Promise<void> {
    const value = effort.trim();
    if (!value) return;
    const res = await this.client.request<{ value?: string; warning?: string }>(
      "config.set",
      {
        key: "reasoning",
        session_id,
        value,
      },
    );
    if (!res || typeof res.value !== "string" || !res.value) {
      throw new Error((res as { warning?: string })?.warning || "思考强度设置未生效");
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
