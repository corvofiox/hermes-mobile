import { useEffect, useRef, useState } from "react";
import type { ModelPref } from "../lib/api";
import {
  REASONING_EFFORTS,
  REASONING_LABELS,
  type HermesGateway,
} from "../lib/gateway";

interface Props {
  /** 当前偏好（模型 + provider + 思考强度） */
  current: ModelPref;
  onSelect: (pref: ModelPref) => void;
  onCancel: () => void;
  /** 复用 ChatPage 的已连接 gateway：拉模型清单走 WS RPC（不依赖 dashboard REST 路由） */
  gateway: HermesGateway;
}

/** provider 行的最小形状（服务端 model.options 的 providers[]） */
interface ProviderRow {
  slug: string;
  name?: string;
  models?: string[];
  warning?: string;
  is_current?: boolean;
}

/** 模型选择弹窗：思考强度（固定档位）+ provider → 模型两级 */
export default function ModelPicker({ current, onSelect, onCancel, gateway }: Props) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 展开的 provider slug（默认展开当前 provider） */
  const [expanded, setExpanded] = useState<string>(current.provider);
  /** 思考强度面板是否展开（默认收起，避免抢模型列表的视觉重心） */
  const [effortOpen, setEffortOpen] = useState(false);
  // 稳定回调引用（父组件内联箭头函数每次渲染都是新引用，避免 effect 反复重挂）
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // 物理返回键感知：打开时通知 App（弹窗打开时返回键应关闭弹窗而非返回/退出）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: true } }));
    const onCloseRequest = () => onCancelRef.current();
    window.addEventListener("hermes:modal-close-request", onCloseRequest);
    return () => {
      window.removeEventListener("hermes:modal-close-request", onCloseRequest);
      window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: false } }));
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 走 WS RPC model.options：与 setSessionModel 同通道，不依赖 dashboard 是否挂载 REST 路由
        const opts = await gateway.getModelOptions();
        if (cancelled) return;
        const rows = opts.providers as unknown as ProviderRow[];
        setProviders(rows);
        if (!rows.some((p) => p.slug === current.provider)) {
          // 当前 provider 不在列表（如未认证）：展开第一个有模型的
          const first = rows.find((p) => (p.models?.length ?? 0) > 0);
          if (first) setExpanded(first.slug);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway, current.provider]);

  /** 仅换思考强度，保留 provider/model（空串 = 清除覆盖、回退全局默认） */
  const selectEffort = (effort: string) => {
    onSelect({ provider: current.provider, model: current.model, effort });
  };

  const currentEffort = current.effort ?? "";

  return (
    <div className="sheet-overlay" onClick={onCancel}>
      <div className="action-sheet model-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">模型与思考强度（本会话生效）</div>

        {/* 思考强度：固定 8 档，不依赖服务端清单 */}
        <div className="effort-section">
          <button
            className={`effort-head${effortOpen ? " open" : ""}`}
            onClick={() => setEffortOpen((v) => !v)}
          >
            <span className="effort-head-label">思考强度</span>
            <span className="effort-head-value">
              {currentEffort
                ? `${REASONING_LABELS[currentEffort] ?? currentEffort}（${currentEffort}）`
                : "跟随默认"}
              <span className="model-chevron">{effortOpen ? "▾" : "▸"}</span>
            </span>
          </button>
          {effortOpen && (
            <div className="effort-grid">
              <button
                className={`effort-item${!currentEffort ? " selected" : ""}`}
                onClick={() => selectEffort("")}
              >
                <span className="effort-item-name">跟随默认</span>
                <span className="effort-item-hint">不覆盖</span>
              </button>
              {REASONING_EFFORTS.map((e) => {
                const selected = currentEffort === e;
                return (
                  <button
                    key={e}
                    className={`effort-item${selected ? " selected" : ""}`}
                    onClick={() => selectEffort(e)}
                  >
                    <span className="effort-item-name">{REASONING_LABELS[e] ?? e}</span>
                    <span className="effort-item-hint">{e}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="model-section-label">模型</div>

        {loading && (
          <div className="model-picker-status">
            <div className="spinner spinner-sm" />
            <span>正在加载模型列表…</span>
          </div>
        )}

        {!loading && error && (
          <div className="model-picker-status error">
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && providers.length === 0 && (
          <div className="model-picker-status">
            <span>暂无可用模型（请先在服务端配置）</span>
          </div>
        )}

        {!loading && !error && (
          <div className="model-providers">
            {providers.map((p) => {
              const models = p.models ?? [];
              const isExpanded = expanded === p.slug;
              const isActive = current.provider === p.slug;
              return (
                <div key={p.slug} className="model-provider">
                  <button
                    className={`model-provider-head${isActive ? " active" : ""}`}
                    onClick={() => setExpanded(isExpanded ? "" : p.slug)}
                  >
                    <span className="model-provider-name">
                      {p.name || p.slug}
                      {isActive && <span className="model-current-tag">当前</span>}
                    </span>
                    <span className="model-provider-count">
                      {models.length > 0 ? `${models.length} 个模型` : "无模型"}
                      <span className="model-chevron">{isExpanded ? "▾" : "▸"}</span>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="model-list">
                      {models.length === 0 && (
                        <div className="model-empty">
                          {p.warning || "该 provider 暂无可用模型"}
                        </div>
                      )}
                      {models.map((m) => {
                        const selected = current.provider === p.slug && current.model === m;
                        return (
                          <button
                            key={m}
                            className={`model-item${selected ? " selected" : ""}`}
                            onClick={() =>
                              onSelect({
                                provider: p.slug,
                                model: m,
                                effort: current.effort,
                              })
                            }
                          >
                            <span className="model-item-name">{m}</span>
                            {selected && <span className="model-item-check">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button className="sheet-item cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
