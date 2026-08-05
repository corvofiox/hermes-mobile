import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  bulkArchiveSessionsRest,
  bulkDeleteSessionsRest,
  deleteSessionRest,
  getModelPref,
  listSessionsRest,
  renameSessionRest,
  searchSessionsRest,
  setSessionArchivedRest,
  setSessionPinnedRest,
  type RestSession,
} from "../lib/api";
import type { HermesGateway } from "../lib/gateway";
import RenameModal from "../components/RenameModal";
import ConfirmModal from "../components/ConfirmModal";

interface Props {
  gateway: HermesGateway;
  /** 当前分类 tab（App 提升状态，退出对话返回时保持） */
  activeTab: SessionTabKey;
  onTabChange: (tab: SessionTabKey) => void;
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

export type SessionTabKey = TabKey;

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

// ---- 长按手势（pointer 计时，移动端友好）--------------------------------

interface LongPress {
  timer: ReturnType<typeof setTimeout> | null;
  startX: number;
  startY: number;
}

/** 为会话项挂载长按检测：长按 450ms 且位移 < 12px 触发 onLongPress，并抑制随后的 click */
function useLongPress(onLongPress: () => void) {
  const state = useRef<LongPress>({ timer: null, startX: 0, startY: 0 });
  const fired = useRef(false);
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;

  const clearTimer = () => {
    if (state.current.timer) {
      clearTimeout(state.current.timer);
      state.current.timer = null;
    }
  };

  useEffect(() => clearTimer, []);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      fired.current = false;
      state.current.startX = e.clientX;
      state.current.startY = e.clientY;
      clearTimer();
      state.current.timer = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(12);
        cbRef.current();
      }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!state.current.timer) return;
      if (Math.hypot(e.clientX - state.current.startX, e.clientY - state.current.startY) > 12) {
        clearTimer();
      }
    },
    onPointerUp: clearTimer,
    onPointerLeave: clearTimer,
    /** 触摸滚动被系统接管（如 WebView 滚动容器拦截）时取消挂起的长按 */
    onPointerCancel: clearTimer,
    /** 长按已触发：click 应被抑制（打开会话） */
    suppressClick: () => fired.current,
  };
}

// ---- 页面 ----------------------------------------------------------------

/** 读取本地记录的会话最后消息（列表标题显示最新对话；服务端 preview 为首条消息不可用） */
function getLastMessage(sessionId: string): string {
  try {
    return localStorage.getItem(`hermes.session.lastmsg.${sessionId}`) ?? "";
  } catch {
    return "";
  }
}

/** 删除会话时清理本地最后消息记录 */
function clearLastMessage(sessionId: string): void {
  try {
    localStorage.removeItem(`hermes.session.lastmsg.${sessionId}`);
  } catch {
    // 忽略
  }
}

export default function SessionsPage({ gateway, activeTab, onTabChange, onOpenSession, onLogout }: Props) {
  const [sessions, setSessions] = useState<RestSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connState, setConnState] = useState(gateway.connectionState);
  const [busyPin, setBusyPin] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RestSession | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [renaming, setRenaming] = useState<RestSession | null>(null);
  /** 长按菜单目标会话 */
  const [menuFor, setMenuFor] = useState<RestSession | null>(null);
  /** 批量删除确认弹窗 */
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  /** 多选（批量操作）模式 */
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 搜索 */
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RestSession[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        const list = await listSessionsRest({ order: "recent", archived: "exclude" });
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
      if (document.visibilityState === "visible") {
        void refresh(true);
      }
    };
    const id = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // 搜索：300ms debounce + 序号守卫（旧请求迟到不覆盖新结果）
  const searchSeqRef = useRef(0);
  useEffect(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current += 1; // 使 in-flight 旧请求作废
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchSessionsRest(q, 30);
        if (seq !== searchSeqRef.current) return; // 已发出新查询，丢弃旧结果
        setSearchResults(results);
      } catch (err) {
        if (seq !== searchSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setSearchResults([]);
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  // 退出多选模式时清空选择
  useEffect(() => {
    if (!multiMode) setSelected(new Set());
  }, [multiMode]);

  /** 切换 tab：多选模式下清空选择（避免跨列表误操作） */
  const switchTab = (key: TabKey) => {
    if (multiMode) {
      setSelected(new Set());
    }
    onTabChange(key);
  };

  const newChat = async () => {
    setError("");
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const pref = getModelPref();
      const created = await gateway.createSession({
        // 用用户选择的模型偏好（serve 默认的免费档会被限流 429，实测验证）
        model: pref.model,
        provider: pref.provider,
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
      const patch = (prev: RestSession[]) => prev.map((x) => (x.id === s.id ? { ...x, pinned: !s.pinned } : x));
      setSessions((prev) => patch(prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyPin(null);
    }
  };

  const toggleArchive = async (s: RestSession) => {
    setError("");
    try {
      await setSessionArchivedRest(s.id, true);
      // 归档后从列表移除（App 不提供归档查看/恢复入口）
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (s: RestSession) => {
    setBusyDelete(s.id);
    setError("");
    try {
      await deleteSessionRest(s.id);
      clearLastMessage(s.id);
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
      const patch = (prev: RestSession[]) => prev.map((x) => (x.id === s.id ? { ...x, title } : x));
      setSessions((prev) => patch(prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- 批量操作 ----

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitMultiMode = () => {
    setMultiMode(false);
    setSelected(new Set());
  };

  const bulkArchive = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setError("");
    const { done, failedIds } = await bulkArchiveSessionsRest(ids, true);
    if (failedIds.length > 0) {
      setError(`部分归档失败（${done}/${ids.length}）`);
    }
    // 只对成功项更新 UI（失败项保留在列表中，避免"幽灵消失"后被轮询拉回）
    const succeeded = new Set(ids.filter((id) => !failedIds.includes(id)));
    setSessions((prev) => prev.filter((x) => !succeeded.has(x.id)));
    exitMultiMode();
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    setError("");
    try {
      const { deleted } = await bulkDeleteSessionsRest(ids);
      // 服务端对不存在的 id 静默跳过（可能已被其他端删除）——跳过项在服务端已不存在，
      // 从 UI 移除同样正确；全部移除不会造成"幽灵消失"
      if (deleted < ids.length) {
        setError(`部分会话已被其他端删除（实际删除 ${deleted} 个）`);
      }
      setSessions((prev) => prev.filter((x) => !selected.has(x.id)));
      ids.forEach(clearLastMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkDeleting(false);
      exitMultiMode();
    }
  };

  const renderItem = (s: RestSession) => {
    const badge = sourceBadge(s.source);
    const selectedFlag = multiMode && selected.has(s.id);
    return (
      <SessionItem
        key={s.id}
        s={s}
        badge={badge}
        multiMode={multiMode}
        selectedFlag={selectedFlag}
        busyPin={busyPin}
        // 搜索结果行无 pinned 字段（服务端结构），隐藏星标避免状态误导
        hideActions={searchActive}
        onOpen={() => onOpenSession(s.id, s.title ?? "")}
        onLongPress={() => setMenuFor(s)}
        onTogglePin={() => void togglePin(s)}
        onToggleSelect={() => toggleSelect(s.id)}
      />
    );
  };

  const searchActive = searchQuery.trim().length > 0;

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
        {multiMode ? (
          <button className="btn" onClick={exitMultiMode}>
            完成
          </button>
        ) : (
          <div className="topbar-actions">
            <button
              className="btn"
              onClick={() => {
                setMultiMode(true);
                setSearchQuery("");
              }}
            >
              ☑ 选择
            </button>
            <button className="btn btn-primary" onClick={newChat}>
              ＋ 新对话
            </button>
          </div>
        )}
      </header>

      {/* 搜索框（多选模式隐藏） */}
      {!multiMode && (
        <div className="search-bar">
          <input
            className="search-input"
            type="search"
            value={searchQuery}
            placeholder="搜索会话标题与内容…"
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchActive && (
            <button className="search-clear" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>
      )}

      {/* 分类 Tab 栏（搜索激活时隐藏） */}
      {!searchActive && (
        <nav className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${activeTab === t.key ? "active" : ""}`}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
              <span className="tab-count">{counts[t.key]}</span>
            </button>
          ))}
        </nav>
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      {searchActive ? (
        searching ? (
          <div className="center-screen"><div className="spinner" /></div>
        ) : searchResults.length === 0 ? (
          <div className="empty">
            <p>没有找到「{searchQuery.trim()}」相关会话</p>
          </div>
        ) : (
          <ul className="session-list">{searchResults.map(renderItem)}</ul>
        )
      ) : loading ? (
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

      {/* 批量操作底部栏 */}
      {multiMode && (
        <div className="bulk-bar">
          <span className="bulk-count">已选 {selected.size} 项</span>
          <button
            className="btn"
            disabled={selected.size === 0 || bulkDeleting}
            onClick={() => void bulkArchive()}
          >
            归档
          </button>
          <button
            className="btn btn-danger"
            disabled={selected.size === 0 || bulkDeleting}
            onClick={() => {
              setBulkConfirmOpen(true);
            }}
          >
            删除
          </button>
        </div>
      )}

      <footer className="bottom-bar">
        <button className="btn" onClick={onLogout}>
          退出登录
        </button>
      </footer>

      {/* 长按菜单（ActionSheet） */}
      {menuFor && (
        <div className="sheet-overlay" onClick={() => setMenuFor(null)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{menuFor.title || "（无标题）"}</div>
            <button
              className="sheet-item"
              onClick={() => {
                const target = menuFor;
                setMenuFor(null);
                setRenaming(target);
              }}
            >
              ✎ 重命名
            </button>
            <button
              className="sheet-item"
              onClick={() => {
                const target = menuFor;
                setMenuFor(null);
                void togglePin(target);
              }}
              // 搜索结果行无 pinned 字段（服务端结构），隐藏置顶项避免标签误导
              style={typeof menuFor.pinned !== "boolean" ? { display: "none" } : undefined}
            >
              {menuFor.pinned ? "★ 取消置顶" : "☆ 置顶"}
            </button>
            <button
              className="sheet-item"
              onClick={() => {
                const target = menuFor;
                setMenuFor(null);
                void toggleArchive(target);
              }}
            >
              🗄 归档
            </button>
            <button
              className="sheet-item"
              onClick={() => {
                setMenuFor(null);
                setMultiMode(true);
                toggleSelect(menuFor.id);
              }}
            >
              ☑ 多选
            </button>
            <button
              className="sheet-item danger"
              onClick={() => {
                const target = menuFor;
                setMenuFor(null);
                setDeleting(target);
              }}
            >
              ✕ 删除
            </button>
            <button className="sheet-item cancel" onClick={() => setMenuFor(null)}>
              取消
            </button>
          </div>
        </div>
      )}

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

      {bulkConfirmOpen && (
        <ConfirmModal
          title="批量删除"
          message={`确定删除选中的 ${selected.size} 个会话吗？此操作不可恢复。`}
          confirmLabel="删除"
          danger
          onCancel={() => setBulkConfirmOpen(false)}
          onConfirm={() => {
            setBulkConfirmOpen(false);
            void bulkDelete();
          }}
        />
      )}
    </div>
  );
}

// ---- 会话列表项（独立组件：长按手势需要稳定 hook 挂载点） ----------------

interface SessionItemProps {
  s: RestSession;
  badge: { label: string; cls: string };
  multiMode: boolean;
  selectedFlag: boolean;
  busyPin: string | null;
  /** 搜索模式：隐藏星标（搜索结果行无 pinned 字段） */
  hideActions?: boolean;
  onOpen: () => void;
  onLongPress: () => void;
  onTogglePin: () => void;
  onToggleSelect: () => void;
}

function SessionItem({
  s,
  badge,
  multiMode,
  selectedFlag,
  busyPin,
  hideActions,
  onOpen,
  onLongPress,
  onTogglePin,
  onToggleSelect,
}: SessionItemProps) {
  const lp = useLongPress(onLongPress);
  return (
    <li
      className={`session-item${selectedFlag ? " selected" : ""}${multiMode ? " multi" : ""}`}
      onClick={() => {
        if (lp.suppressClick()) return; // 长按刚触发，忽略本次 click
        if (multiMode) {
          onToggleSelect();
          return;
        }
        onOpen();
      }}
      onPointerDown={lp.onPointerDown}
      onPointerMove={lp.onPointerMove}
      onPointerUp={lp.onPointerUp}
      onPointerLeave={lp.onPointerLeave}
      onPointerCancel={lp.onPointerCancel}
      onContextMenu={(e) => {
        e.preventDefault(); // 屏蔽 WebView 系统长按菜单
        if (!multiMode) onLongPress();
      }}
    >
      {multiMode && (
        <span className={`check-box${selectedFlag ? " checked" : ""}`}>{selectedFlag ? "✓" : ""}</span>
      )}
      <div className="session-main">
        <div className="session-title">
          {/* 标题显示最新对话：本地记录的最后消息优先；无记录（未在本机打开过的会话）回退原标题 */}
          {getLastMessage(s.id) || s.title || "（无标题）"}
          {badge.label && <span className={`badge ${badge.cls}`}>{badge.label}</span>}
        </div>
      </div>
      <div className="session-side">
        <span className="session-time">{formatTime(s.last_active ?? s.started_at)}</span>
        {!multiMode && !hideActions && (
          <button
            className="icon-btn"
            disabled={busyPin === s.id}
            aria-label={s.pinned ? "取消置顶" : "置顶"}
            title={s.pinned ? "取消置顶" : "置顶"}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            onPointerDown={(e) => e.stopPropagation()} // 阻止长按冒泡到 li
          >
            {s.pinned ? "★" : "☆"}
          </button>
        )}
      </div>
    </li>
  );
}
