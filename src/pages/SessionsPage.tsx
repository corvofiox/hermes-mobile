import { useCallback, useEffect, useState } from "react";
import type { HermesGateway, SessionInfo } from "../lib/gateway";

interface Props {
  gateway: HermesGateway;
  onOpenSession: (id: string, title: string) => void;
  onLogout: () => void;
}

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export default function SessionsPage({ gateway, onOpenSession, onLogout }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connState, setConnState] = useState(gateway.connectionState);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const list = await gateway.listSessions();
      setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    const off = gateway.onConnectionState((s) => setConnState(s));
    void refresh();
    return off;
  }, [gateway, refresh]);

  const newChat = async () => {
    setError("");
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const created = await gateway.createSession();
      onOpenSession(created.session_id, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await gateway.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="sessions-screen">
      <header className="topbar">
        <h1>会话</h1>
        <button className="btn btn-primary" onClick={newChat}>
          ＋ 新对话
        </button>
      </header>

      <div className={`conn-pill ${connState === "open" ? "ok" : "down"}`}>
        {connState === "open" ? "● 已连接" : "● 连接中…"}
      </div>

      {error && <div className="error-text">{error}</div>}

      {loading ? (
        <div className="center-screen"><div className="spinner" /></div>
      ) : sessions.length === 0 ? (
        <div className="empty">
          <p>暂无会话</p>
          <p className="muted">点「新对话」开始和 Hermes 聊天</p>
        </div>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="session-item" onClick={() => onOpenSession(s.id, s.title)}>
              <div className="session-main">
                <div className="session-title">{s.title || "（无标题）"}</div>
                <div className="session-preview">{s.preview || "—"}</div>
              </div>
              <div className="session-side">
                <span className="session-time">{formatTime(s.started_at)}</span>
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("删除这个会话？")) void remove(s.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <footer className="bottom-bar">
        <button className="btn" onClick={onLogout}>
          退出登录
        </button>
      </footer>
    </div>
  );
}
