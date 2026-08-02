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
  const [bootDetail, setBootDetail] = useState<string>("");
  const [bootTick, setBootTick] = useState(0);
  const [activeSession, setActiveSession] = useState<{ id: string; title: string; liveId?: string } | null>(null);
  const gatewayRef = useRef<HermesGateway | null>(null);
  /** 供 Capacitor 返回键回调读取当前屏幕（避免在 setState updater 里做副作用） */
  const screenRef = useRef<Screen>("boot");

  const getGateway = useCallback((): HermesGateway => {
    if (!gatewayRef.current) {
      gatewayRef.current = new HermesGateway();
    }
    return gatewayRef.current;
  }, []);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  // 启动：探测登录态（ticket 能取到 = 已登录）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getWsTicket();
        if (!cancelled) setScreen("sessions");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setScreen("login");
        } else {
          setBootError("无法连接服务器，请检查网络后重试");
          setBootDetail(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootTick]);

  // 会话过期（401）：关闭 gateway 并切回登录页
  useEffect(() => {
    const onUnauthorized = () => {
      gatewayRef.current?.close();
      gatewayRef.current = null;
      setActiveSession(null);
      setScreen("login");
    };
    window.addEventListener("hermes:unauthorized", onUnauthorized);
    return () => window.removeEventListener("hermes:unauthorized", onUnauthorized);
  }, []);

  // 物理返回键：chat → sessions；sessions/login → 退出 App；boot 忽略。
  // Web 环境无原生 Capacitor 时动态 import 失败，优雅降级。
  // cancelled 标志处理 StrictMode 双执行：首次 mount 的 async import 在 cleanup 后 resolve 时
  // 立即移除刚注册的监听器，避免监听器泄漏（双触发 exitApp）。
  useEffect(() => {
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | undefined;
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        if (cancelled) return;
        handle = await App.addListener("backButton", () => {
          const cur = screenRef.current;
          if (cur === "chat") {
            setActiveSession(null);
            setScreen("sessions");
          } else if (cur === "sessions" || cur === "login") {
            void App.exitApp();
          }
          // boot 屏忽略返回键
        });
        if (cancelled) {
          void handle.remove();
        }
      } catch {
        // 非原生环境（浏览器调试等）：忽略
      }
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
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

  const handleOpenSession = useCallback((id: string, title: string, liveId?: string) => {
    setActiveSession({ id, title, liveId });
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
            {bootDetail && <p className="error-detail">{bootDetail}</p>}
            <div className="error-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setBootError("");
                  setBootDetail("");
                  setBootTick((t) => t + 1);
                }}
              >
                重试
              </button>
              <button className="btn" onClick={() => setScreen("login")}>
                前往登录
              </button>
            </div>
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
        sessionLiveId={activeSession.liveId}
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
