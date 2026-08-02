import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayEvent, HermesGateway } from "../lib/gateway";

interface Props {
  gateway: HermesGateway;
  sessionId: string;
  sessionTitle: string;
  onBack: () => void;
}

interface Msg {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  error?: boolean;
}

interface ToolActivity {
  name: string;
  args?: string;
}

export default function ChatPage({ gateway, sessionId, sessionTitle, onBack }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connState, setConnState] = useState(gateway.connectionState);
  const [tool, setTool] = useState<ToolActivity | null>(null);
  const [status, setStatus] = useState("");
  const msgId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyLoaded = useRef(false);

  const nextId = () => ++msgId.current;

  // 事件订阅：delta 追加到当前 streaming 消息
  useEffect(() => {
    const offState = gateway.onConnectionState((s) => setConnState(s));
    const offDelta = gateway.on("message.delta", (ev) => {
      const payload = ev.payload as { text?: string } | undefined;
      if (!payload?.text) return;
      const deltaText = payload.text; // 闭包内保留 narrow 后的值
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = { ...last, text: last.text + deltaText };
        } else {
          copy.push({ id: nextId(), role: "assistant", text: deltaText, streaming: true });
        }
        return copy;
      });
    });
    const offComplete = gateway.on("message.complete", (ev) => {
      const payload = ev.payload as { text?: string; status?: string } | undefined;
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = {
            ...last,
            text: payload?.text ?? last.text,
            streaming: false,
            error: payload?.status === "error",
          };
        }
        return copy;
      });
      setTool(null);
      setStatus("");
      setBusy(false);
    });
    const offToolStart = gateway.on("tool.start", (ev) => {
      const payload = ev.payload as { name?: string; args?: string } | undefined;
      setTool({ name: payload?.name ?? "工具", args: payload?.args });
      setStatus(`正在执行: ${payload?.name ?? "工具"}`);
    });
    const offToolComplete = gateway.on("tool.complete", () => {
      setTool(null);
      setStatus("");
    });
    const offStatus = gateway.on("status.update", (ev) => {
      const payload = ev.payload as { message?: string; status?: string } | undefined;
      if (payload?.message) setStatus(payload.message);
    });
    const offError = gateway.on("error", (ev) => {
      const payload = ev.payload as { message?: string } | undefined;
      setStatus(payload?.message ?? "出错了");
      setBusy(false);
    });
    return () => {
      offState();
      offDelta();
      offComplete();
      offToolStart();
      offToolComplete();
      offStatus();
      offError();
    };
  }, [gateway]);

  // 加载历史（首次打开）
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    (async () => {
      try {
        if (gateway.connectionState !== "open") {
          await gateway.connect();
        }
        const resumed = await gateway.resumeSession(sessionId);
        const history = Array.isArray(resumed.messages) ? resumed.messages : [];
        setMessages(
          history
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: nextId(),
              role: m.role as "user" | "assistant",
              text: String(m.text ?? m.content ?? ""),
            })),
        );
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [gateway, sessionId]);

  // 自动滚底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
    setBusy(true);
    try {
      await gateway.submitPrompt(sessionId, text);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const stop = useCallback(() => {
    // 无官方 stop 方法时：发送 /stop 斜杠命令给会话（TUI 语义）
    gateway
      .submitPrompt(sessionId, "/stop")
      .catch(() => undefined);
  }, [gateway, sessionId]);

  return (
    <div className="chat-screen">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ 返回
        </button>
        <div className="topbar-title">
          <span className="chat-title">{sessionTitle || "新对话"}</span>
          <span className={`conn-dot ${connState === "open" ? "ok" : "down"}`} />
        </div>
        <button className="btn" onClick={stop} disabled={!busy}>
          停止
        </button>
      </header>

      <div className="chat-body">
        {messages.length === 0 && (
          <div className="empty">
            <p>开始和 Hermes 对话吧</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "user" ? (
              <div className="bubble user-bubble">{m.text}</div>
            ) : (
              <div className="bubble assistant-bubble">
                {m.text}
                {m.streaming && <span className="cursor" />}
              </div>
            )}
          </div>
        ))}
        {busy && !tool && !status && (
          <div className="thinking">
            <span className="dot" /><span className="dot" /><span className="dot" />
          </div>
        )}
        {status && <div className="status-line">{status}</div>}
        <div ref={bottomRef} />
      </div>

      <footer className="composer">
        <textarea
          value={input}
          placeholder="输入消息…"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary send-btn" onClick={send} disabled={busy || !input.trim()}>
          发送
        </button>
      </footer>
    </div>
  );
}
