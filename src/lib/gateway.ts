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
  [k: string]: unknown;
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

  constructor() {
    this.client = new JsonRpcGatewayClient({
      requestIdPrefix: "m",
      closedErrorMessage: "连接已断开",
      connectErrorMessage: "连接失败",
      notConnectedErrorMessage: "网关未连接",
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
    try {
      const { ticket } = await getWsTicket();
      await this.client.connect(`${wsUrl("/api/ws")}?ticket=${encodeURIComponent(ticket)}`);
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
  } = {}): Promise<CreateSessionResult> {
    return this.client.request<CreateSessionResult>("session.create", {
      cols: params.cols ?? 50,
      title: params.title ?? "",
      messages: params.messages ?? [],
      ...(params.model ? { model: params.model } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
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
}
