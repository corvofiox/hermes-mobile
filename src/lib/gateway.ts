/**
 * Hermes Mobile — Gateway 封装
 *
 * 基于官方 @hermes/shared 的 JsonRpcGatewayClient（MIT，vendor 拷贝），
 * 封装 tui_gateway JSON-RPC/WebSocket 协议（newline-delimited frames）。
 *
 * 请求: {"id":"m1","method":"session.create","params":{...}}
 * 响应: {"id":"m1","result":{...}}  /  {"id":"m1","error":{...}}
 * 事件: {"method":"...","params":{"type":"message.delta","payload":{...},"session_id":"..."}}
 */

import {
  JsonRpcGatewayClient,
  type GatewayEvent,
  type GatewayEventName,
  type ConnectionState,
} from "./vendor/json-rpc-gateway";
import { getWsTicket, buildWsUrl } from "./api";

export type { GatewayEvent, GatewayEventName, ConnectionState };

// ---- 会话数据结构 -------------------------------------------------------

export interface SessionInfo {
  id: string;
  title: string;
  preview?: string;
  started_at?: number;
  message_count?: number;
  source?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  text?: string;
  content?: string;
  [k: string]: unknown;
}

// ---- Gateway 客户端封装 --------------------------------------------------

export class HermesGateway {
  private client: JsonRpcGatewayClient;

  constructor() {
    this.client = new JsonRpcGatewayClient({
      requestIdPrefix: "m",
      closedErrorMessage: "连接已断开",
      connectErrorMessage: "连接失败",
      notConnectedErrorMessage: "网关未连接",
    });
  }

  /** 订阅连接状态变化，返回取消函数 */
  onConnectionState(handler: (state: ConnectionState) => void): () => void {
    return this.client.onState(handler);
  }

  get connectionState(): ConnectionState {
    return this.client.connectionState;
  }

  /** 连接：先取一次性 ticket，再建 WS */
  async connect(): Promise<void> {
    const { ticket } = await getWsTicket();
    await this.client.connect(buildWsUrl(ticket));
  }

  close(): void {
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
  } = {}): Promise<{ session_id: string; stored_session_id: string; message_count: number; messages: HistoryMessage[] }> {
    return (await this.client.request("session.create", {
      cols: params.cols ?? 50,
      title: params.title ?? "",
      messages: params.messages ?? [],
    })) as never;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = (await this.client.request("session.list", {})) as {
      sessions?: SessionInfo[];
    };
    return result.sessions ?? [];
  }

  async deleteSession(session_id: string): Promise<void> {
    await this.client.request("session.delete", { session_id });
  }

  async resumeSession(session_id: string): Promise<{ messages: HistoryMessage[]; title?: string }> {
    return (await this.client.request("session.resume", { session_id })) as never;
  }

  async submitPrompt(session_id: string, text: string): Promise<void> {
    await this.client.request("prompt.submit", { session_id, text });
  }
}
