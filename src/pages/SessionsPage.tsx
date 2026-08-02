import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  deleteSessionRest,
  listSessionsRest,
  renameSessionRest,
  setSessionPinnedRest,
  type RestSession,
} from "../lib/api";
import type { HermesGateway } from "../lib/gateway";
import RenameModal from "../components/RenameModal";
import ConfirmModal from "../components/ConfirmModal";

interface Props {
  gateway: HermesGateway;
  onOpenSession: (id: string, title: string, liveId?: string) => void;
  onLogout: () => void;
}

// ---- source 分类与展示 ---------------------------------------------------

/** 消息平台 source 集合（gateway 平台名） */
const PLATFORM_SOURCES = new Set([
  "telegram",
  "weixin",
  "wechat",
  "discord",
  "qqbot",
  "yuanbao",
  "signal",
  "whatsapp",
  "whatsapp_cloud",
  "bluebubbles",
  "slack",
  "teams",
  "google_chat",
  "matrix",
  "mattermost",
  "email",
  "sms",
]);

const SOURCE_LABELS: Record<string, { label: string; cls: string }> = {
  telegram: { label: "TG", cls: "tg" },
  weixin: { label: "微信", cls: "wx" },
  wechat: { label: "微信", cls: "wx" },
  discord: { label: "DC", cls: "dc" },
  qqbot: { label: "QQ", cls: "qq" },
  yuanbao: { label: "元宝", cls: "yb" },
  signal: { label: "Signal", cls: "" },
  whatsapp: { label: "WA", cls: "" },
  whatsapp_cloud: { label: "WA", cls: "" },
  cron: { label: "定时", cls: "cron" },
  cli: { label: "本地", cls: "" },
  tui: { label: "本地", cls: "" },
  desktop: { label: "本地", cls: "" },
  webhook: { label: "Hook", cls: "" },
};

function sourceBadge(source?: string): { label: string; cls: string } {
  if (!source) return { label: "", cls: "" };
  const known = SOURCE_LABELS[source];
  if (known) return known;
  return { label: source.slice(0, 3), cls: "" };
}

type TabKey = "all" | "pinned" | "platform" | "cron" | "other";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pinned", label: "置顶" },
  { key: "other", label: "其他" },
  { key: "cron", label: "定时任务" },
  { key: "platform", label: "消息平台" },
];

/** 判断单个会话属于哪个分类 */
function classifySession(s: RestSession): Exclude<TabKey, "all"> {
  if (s.pinned) return "pinned";
  if (s.source === "cron") return "cron";
  if (s.source && PLATFORM_SOURCES.has(s.source)) return "platform";
  return "other";
}

/** 按分类分组（用于"全部" tab） */
function groupSessions(sessions: RestSession[]): { key: TabKey; title: string; items: RestSession[] }[] {
  const order: Exclude<TabKey, "all">[] = ["pinned", "other", "cron", "platform"];
  const buckets: Record<Exclude<TabKey, "all">, RestSession[]> = {
    pinned: [],
    platform: [],
    cron: [],
    other: [],
  };
  for (const s of sessions) {
    buckets[classifySession(s)].push(s);
  }
  const titles: Record<Exclude<TabKey, "all">, string> = {
    pinned: "📌 置顶",
    platform: "💬 消息平台",
    cron: "⏰ 定时任务",
    other: "📄 其他",
  };
  return order
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, title: titles[k], items: buckets[k] }));
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

// ---- 页面 ----------------------------------------------------------------

export default function SessionsPage({ gateway, onOpenSession, onLogout }: Props) {
  const [sessions, setSessions] = useState<RestSession[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connState, setConnState] = useState(gateway.connectionState);
  const [busyPin, setBusyPin] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RestSession | null>(null);
  const [renaming, setRenaming] = useState<RestSession | null>(null);
  const refreshingRef = useRef(false);

  // 全部分组 + 各 tab 数量
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { all: sessions.length, pinned: 0, platform: 0, cron: 0, other: 0 };
    for (const s of sessions) c[classifySession(s)]++;
    return c;
  }, [sessions]);

  // 当前 tab 的条目（全部 → 分组；分类 → 平铺该分类）
  const activeItems = useMemo(() => {
    if (activeTab === "all") return null;
    return sessions.filter((s) => classifySession(s) === activeTab);
  }, [sessions, activeTab]);

  const refresh = useCallback(
    async (silent = false) => {
      if (refreshingRef.current) return; // 防重入（轮询与手动刷新可能重叠）
      refreshingRef.current = true;
      if (!silent) setLoading(true);
      setError("");
      try {
        if (gateway.connectionState !== "open") {
          await gateway.connect();
        }
        const list = await listSessionsRest({ limit: 200, order: "recent" });
        setSessions(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        refreshingRef.current = false;
        if (!silent) setLoading(false);
      }
    },
    [gateway],
  );

  useEffect(() => {
    const off = gateway.onConnectionState((s) => setConnState(s));
    void refresh();
    return off;
  }, [gateway, refresh]);

  // 30s 轮询刷新（仅页面可见时；切回前台立即刷一次）
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const id = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const newChat = async () => {
    setError("");
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const created = await gateway.createSession({
        // 显式指定用户的主模型（serve 默认的免费档会被限流 429，实测验证）
        model: "deepseek-v4-flash",
        provider: "opencode-go",
      });
      // stored id 用于 REST（重命名/删除）；live id 供 ChatPage 直接使用（create 不持久化，resume 会 404）
      onOpenSession(created.stored_session_id, "", created.session_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const togglePin = async (s: RestSession) => {
    setBusyPin(s.id);
    setError("");
    try {
      await setSessionPinnedRest(s.id, !s.pinned);
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, pinned: !s.pinned } : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyPin(null);
    }
  };

  const remove = async (s: RestSession) => {
    setBusyDelete(s.id);
    setError("");
    try {
      await deleteSessionRest(s.id);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyDelete(null);
      setDeleting(null);
    }
  };

  const doRename = async (s: RestSession, title: string) => {
    setRenaming(null);
    setError("");
    try {
      await renameSessionRest(s.id, title);
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, title } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderItem = (s: RestSession) => {
    const badge = sourceBadge(s.source);
    return (
      <li key={s.id} className="session-item" onClick={() => onOpenSession(s.id, s.title ?? "")}>
        <div className="session-main">
          <div className="session-title">
            {s.title || "（无标题）"}
            {badge.label && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
          </div>
          <div className="session-preview">{s.preview || "—"}</div>
        </div>
        <div className="session-side">
          <span className="session-time">{formatTime(s.last_active ?? s.started_at)}</span>
          <div className="session-actions">
            <button
              className="icon-btn"
              aria-label="重命名会话"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(s);
              }}
            >
              ✎
            </button>
            <button
              className="icon-btn"
              disabled={busyPin === s.id}
              aria-label={s.pinned ? "取消置顶" : "置顶"}
              title={s.pinned ? "取消置顶" : "置顶"}
              onClick={(e) => {
                e.stopPropagation();
                void togglePin(s);
              }}
            >
              {s.pinned ? "★" : "☆"}
            </button>
            <button
              className="icon-btn"
              disabled={busyDelete === s.id}
              aria-label="删除会话"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                setDeleting(s);
              }}
            >
              {busyDelete === s.id ? "…" : "✕"}
            </button>
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className="sessions-screen">
      <header className="topbar">
        <div className="topbar-left">
          <h1>会话</h1>
          <span
            className={`conn-dot ${
              connState === "open" ? "ok" : connState === "idle" || connState === "connecting" ? "pending" : "down"
            }`}
            title={connState === "open" ? "已连接" : connState === "idle" || connState === "connecting" ? "连接中…" : "连接断开"}
          />
        </div>
        <button className="btn btn-primary" onClick={newChat}>
          ＋ 新对话
        </button>
      </header>

      {/* 分类 Tab 栏 */}
      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${activeTab === t.key ? "active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
            <span className="tab-count">{counts[t.key]}</span>
          </button>
        ))}
      </nav>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="center-screen"><div className="spinner" /></div>
      ) : activeItems !== null && activeItems.length === 0 ? (
        <div className="empty">
          <p>该分类暂无会话</p>
        </div>
      ) : activeItems !== null ? (
        <ul className="session-list">{activeItems.map(renderItem)}</ul>
      ) : sessions.length === 0 ? (
        <div className="empty">
          <p>暂无会话</p>
          <p className="muted">点「新对话」开始和 Hermes 聊天</p>
        </div>
      ) : (
        <div className="session-groups">
          {groups.map((g) => (
            <section key={g.key} className="session-group">
              <div className="group-header">{g.title}</div>
              <ul className="session-list">{g.items.map(renderItem)}</ul>
            </section>
          ))}
        </div>
      )}

      <footer className="bottom-bar">
        <button className="btn" onClick={onLogout}>
          退出登录
        </button>
      </footer>

      {renaming && (
        <RenameModal
          title="重命名会话"
          initialValue={renaming.title ?? ""}
          placeholder="输入新名字"
          onCancel={() => setRenaming(null)}
          onConfirm={(v) => void doRename(renaming, v)}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="删除会话"
          message={`确定删除「${deleting.title || "（无标题）"}」吗？此操作不可恢复。`}
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </div>
  );
}
