import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { renameSessionRest } from "../lib/api";
import type { GatewayEvent, HermesGateway } from "../lib/gateway";
import RenameModal from "../components/RenameModal";

interface Props {
  gateway: HermesGateway;
  sessionId: string;
  /** 新建会话时由 create 返回的 live id（旧会话打开时不传，走 resume） */
  sessionLiveId?: string;
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

/** streaming 期间代码围栏可能未闭合（奇数个 ```），渲染前补齐闭合标记 */
function closeUnclosedFence(text: string): string {
  const opens = (text.match(/```/g) ?? []).length;
  return opens % 2 === 1 ? `${text}\n\`\`\`` : text;
}

export default function ChatPage({ gateway, sessionId, sessionLiveId, sessionTitle, onBack }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connState, setConnState] = useState(gateway.connectionState);
  const [tool, setTool] = useState<ToolActivity | null>(null);
  const [status, setStatus] = useState("");
  const [title, setTitle] = useState(sessionTitle);
  const [renaming, setRenaming] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const msgId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** live session_id（resume/create 响应的 session_id），事件过滤/发送/interrupt 都用它 */
  const liveSessionIdRef = useRef<string | null>(null);
  const historyLoaded = useRef(false);
  /** resume 曾成功过（重连后需要 re-resume 恢复 live id） */
  const resumeSucceededRef = useRef(false);
  const resumingRef = useRef(false);
  /** 是否经历过断线（用于区分重连恢复 vs 新会话首挂载） */
  const wasDisconnectedRef = useRef(false);
  /** delta 累积缓冲 + rAF 节流批量 setState */
  const deltaBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const nextId = () => ++msgId.current;

  // 事件订阅：delta 追加到当前 streaming 消息
  useEffect(() => {
    // 事件过滤：仅处理本会话（live session_id）的事件
    const isForThisSession = (ev: GatewayEvent): boolean =>
      ev.session_id === liveSessionIdRef.current;

    const flushDelta = () => {
      rafRef.current = null;
      const text = deltaBufRef.current;
      if (!text) return;
      deltaBufRef.current = "";
      const newId = nextId();
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = { ...last, text: last.text + text };
        } else {
          copy.push({ id: newId, role: "assistant", text, streaming: true });
        }
        return copy;
      });
    };
    const queueDelta = (text: string) => {
      deltaBufRef.current += text;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushDelta);
      }
    };

    const offState = gateway.onConnectionState((s) => setConnState(s));
    const offDelta = gateway.on("message.delta", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { text?: string } | undefined;
      if (!payload?.text) return;
      queueDelta(payload.text);
    });
    const offComplete = gateway.on("message.complete", (ev) => {
      if (!isForThisSession(ev)) return;
      // 先落盘缓冲中的 delta，再收尾（避免 rAF 迟到补一条重复消息）
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      flushDelta();
      const payload = ev.payload as { text?: string; status?: string } | undefined;
      const newId = nextId();
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
        } else if (payload?.text) {
          // 无 streaming 消息（如极短回复）也补一条，不静默丢弃
          copy.push({
            id: newId,
            role: "assistant",
            text: payload.text,
            error: payload?.status === "error",
          });
        }
        return copy;
      });
      setTool(null);
      setStatus("");
      setBusy(false);
    });
    const offToolStart = gateway.on("tool.start", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { name?: string; args?: string } | undefined;
      setTool({ name: payload?.name ?? "工具", args: payload?.args });
      setStatus(`正在执行: ${payload?.name ?? "工具"}`);
    });
    const offToolComplete = gateway.on("tool.complete", (ev) => {
      if (!isForThisSession(ev)) return;
      setTool(null);
      setStatus("");
    });
    const offStatus = gateway.on("status.update", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { message?: string; status?: string } | undefined;
      if (payload?.message) setStatus(payload.message);
    });
    const offError = gateway.on("error", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { message?: string } | undefined;
      setStatus(payload?.message ?? "出错了");
      setBusy(false);
    });
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      offState();
      offDelta();
      offComplete();
      offToolStart();
      offToolComplete();
      offStatus();
      offError();
    };
  }, [gateway]);

  // 加载历史（首次打开 / 失败后重试 / 断线重连恢复）
  const doResume = useCallback(async () => {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setHistoryFailed(false);
    // 清空滞留的 delta 缓冲：重连恢复时旧缓冲可能被 rAF 推成"幽灵转圈消息"
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    deltaBufRef.current = "";
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const resumed = await gateway.resumeSession(sessionId);
      liveSessionIdRef.current = resumed.session_id;
      resumeSucceededRef.current = true;
      const history = Array.isArray(resumed.messages) ? resumed.messages : [];
      const msgs: Msg[] = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: nextId(),
          role: m.role as "user" | "assistant",
          text: String(m.text ?? m.content ?? ""),
        }));
      // 断线重连恢复：会话仍在运行则进入 busy，并用 inflight 快照初始化末条消息；
      // 否则必须复位 busy/tool/status（旧 complete 帧可能丢在断掉的 transport 上，永远等不到）
      if (resumed.running) {
        setBusy(true);
        const inflight = resumed.inflight;
        if (inflight?.assistant && inflight.streaming) {
          msgs.push({ id: nextId(), role: "assistant", text: inflight.assistant, streaming: true });
        }
      } else {
        setBusy(false);
        setTool(null);
        setStatus("");
      }
      setMessages(msgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 新会话未落库时 resume 会 4007/not found：re-resume 场景静默（防 busy 卡死），
      // 并清空失效的 live id（发送按钮自动禁用，避免发送才报 4001）
      if (resumeSucceededRef.current && /not found|4007/i.test(msg)) {
        liveSessionIdRef.current = null;
        setBusy(false);
        setTool(null);
        setStatus("");
      } else {
        resumeSucceededRef.current = false;
        historyLoaded.current = false; // 允许重试按钮重新触发加载
        setHistoryFailed(true);
        setStatus(`历史加载失败：${msg}`);
      }
    } finally {
      resumingRef.current = false;
    }
  }, [gateway, sessionId]);

  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    if (sessionLiveId) {
      // 新建会话：live id 已由 create 提供，直接使用（create 不持久化 DB 行，resume 会 404）
      liveSessionIdRef.current = sessionLiveId;
      resumeSucceededRef.current = true;
      return;
    }
    void doResume();
  }, [gateway, sessionId, sessionLiveId, reloadTick, doResume]);

  // 断线重连成功后：旧 WS 上的 live session 已销毁，重新 resume 恢复 live id 与进行中的回合。
  // 用 wasDisconnectedRef 区分"真断线"与"新会话首挂载的 open 立即回调"：
  // 后者不触发 re-resume（避免新会话未落库的假阳性 4007 和一次多余 RPC）。
  useEffect(() => {
    const off = gateway.onConnectionState((s) => {
      setConnState(s);
      if (s === "closed" || s === "error") wasDisconnectedRef.current = true;
      if (s === "open" && resumeSucceededRef.current && wasDisconnectedRef.current) {
        void doResume();
      }
    });
    return off;
  }, [gateway, doResume]);

  // 自动滚底：仅当用户位于底部附近（<100px）时跟随
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const onScroll = () => {
      setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!nearBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status, nearBottom]);

  // textarea 自动增高（max-height 120px，CSS 兜底）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const send = async () => {
    const text = input.trim();
    // resume 完成前（liveSessionIdRef 未就绪）或 re-resume 进行中禁止发送
    if (!text || busy || !liveSessionIdRef.current || resumingRef.current) return;
    setInput("");
    const newId = nextId();
    setMessages((prev) => [...prev, { id: newId, role: "user", text }]);
    setBusy(true);
    try {
      await gateway.submitPrompt(liveSessionIdRef.current, text);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
      // 发送失败：把刚 push 的用户消息标记 error
      setMessages((prev) => prev.map((m) => (m.id === newId ? { ...m, error: true } : m)));
    }
  };

  const stop = useCallback(() => {
    const liveId = liveSessionIdRef.current;
    if (!liveId) return;
    // 真正的停止：服务端 session.interrupt，不污染对话
    gateway.interrupt(liveId).catch(() => {
      // 断线/重连期间 interrupt 会失败，给用户可见反馈而不是静默
      setStatus("停止失败：连接已断开，请稍后重试");
    });
  }, [gateway]);

  const doRename = async (name: string) => {
    setRenaming(false);
    try {
      await renameSessionRest(sessionId, name);
      setTitle(name);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const connDotCls =
    connState === "open" ? "ok" : connState === "connecting" || connState === "idle" ? "pending" : "down";
  const connDotTitle =
    connState === "open"
      ? "已连接"
      : connState === "connecting" || connState === "idle"
        ? "连接中…"
        : "连接断开";

  return (
    <div className="chat-screen">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ 返回
        </button>
        <div className="topbar-title">
          <button className="title-btn" onClick={() => setRenaming(true)}>
            {title || "新对话"}
          </button>
          <span className={`conn-dot ${connDotCls}`} title={connDotTitle} />
        </div>
        <button className="btn" onClick={stop} disabled={!busy || !liveSessionIdRef.current}>
          停止
        </button>
      </header>

      <div className="chat-body" ref={chatBodyRef}>
        {messages.length === 0 && (
          <div className="empty">
            <p>开始和 Hermes 对话吧</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "user" ? (
              <div className="bubble user-bubble">
                {m.text}
                {m.error && <span className="send-failed">⚠️ 发送失败</span>}
              </div>
            ) : (
              <div className="bubble assistant-bubble">
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {m.streaming ? closeUnclosedFence(m.text) : m.text}
                  </ReactMarkdown>
                </div>
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
        {status && (
          <div className="status-line">
            <span>{status}</span>
            {historyFailed && (
              <button
                className="btn btn-sm status-retry"
                onClick={() => {
                  setStatus("");
                  setReloadTick((t) => t + 1);
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="composer">
        <textarea
          ref={textareaRef}
          value={input}
          placeholder="输入消息…"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法组词中的 Enter 不应触发发送
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary send-btn" onClick={send} disabled={busy || !input.trim() || !liveSessionIdRef.current || resumingRef.current}>
          发送
        </button>
      </footer>

      {renaming && (
        <RenameModal
          title="重命名会话"
          initialValue={title}
          placeholder="输入新名字"
          onCancel={() => setRenaming(false)}
          onConfirm={(v) => void doRename(v)}
        />
      )}
    </div>
  );
}
