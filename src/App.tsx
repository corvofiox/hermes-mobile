import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getWsTicket } from "./lib/api";
import { HermesGateway } from "./lib/gateway";
import LoginPage from "./pages/LoginPage";
import SessionsPage from "./pages/SessionsPage";
import ChatPage from "./pages/ChatPage";

type Screen = "boot" | "login" | "sessions" | "chat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("boot");
  const [bootError, setBootError] = useState<string>("");
  const [activeSession, setActiveSession] = useState<{ id: string; title: string } | null>(null);
  const gatewayRef = useRef<HermesGateway | null>(null);

  const getGateway = useCallback((): HermesGateway => {
    if (!gatewayRef.current) {
      gatewayRef.current = new HermesGateway();
    }
    return gatewayRef.current;
  }, []);

  // 启动：探测登录态（ticket 能取到 = 已登录）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getWsTicket();
        if (!cancelled) setScreen("sessions");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setScreen("login");
        } else if (err instanceof ApiError && err.status === 403) {
          setScreen("login");
        } else {
          setBootError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoginSuccess = useCallback(() => {
    setScreen("sessions");
  }, []);

  const handleLogout = useCallback(async () => {
    // 退出：清 cookie 并回登录页（服务端 /auth/logout 会清 cookie）
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // 忽略登出接口失败，本地也会跳回登录页
    }
    gatewayRef.current?.close();
    gatewayRef.current = null;
    setScreen("login");
  }, []);

  const handleOpenSession = useCallback((id: string, title: string) => {
    setActiveSession({ id, title });
    setScreen("chat");
  }, []);

  const handleBackToSessions = useCallback(() => {
    setActiveSession(null);
    setScreen("sessions");
  }, []);

  if (screen === "boot") {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p>正在连接 Hermes…</p>
        {bootError && (
          <div className="error-box">
            <p>{bootError}</p>
            <button className="btn" onClick={() => setScreen("login")}>
              前往登录
            </button>
          </div>
        )}
      </div>
    );
  }

  if (screen === "login") {
    return <LoginPage onSuccess={handleLoginSuccess} />;
  }

  if (screen === "chat" && activeSession) {
    return (
      <ChatPage
        gateway={getGateway()}
        sessionId={activeSession.id}
        sessionTitle={activeSession.title}
        onBack={handleBackToSessions}
      />
    );
  }

  return (
    <SessionsPage
      gateway={getGateway()}
      onOpenSession={handleOpenSession}
      onLogout={handleLogout}
    />
  );
}
