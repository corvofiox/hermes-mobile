import { useEffect, useState } from "react";
import { getModelOptions, type ModelPref, type ModelProvider } from "../lib/api";

interface Props {
  /** 当前偏好（模型+provider） */
  current: ModelPref;
  onSelect: (pref: ModelPref) => void;
  onCancel: () => void;
}

/** 模型选择弹窗：provider → 模型两级；拉 /api/model/options 实时展示 */
export default function ModelPicker({ current, onSelect, onCancel }: Props) {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 展开的 provider slug（默认展开当前 provider） */
  const [expanded, setExpanded] = useState<string>(current.provider);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opts = await getModelOptions();
        if (cancelled) return;
        setProviders(opts.providers);
        if (!opts.providers.some((p) => p.slug === current.provider)) {
          // 当前 provider 不在列表（如未认证）：展开第一个有模型的
          const first = opts.providers.find((p) => (p.models?.length ?? 0) > 0);
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
  }, [current.provider]);

  const select = (provider: string, model: string) => {
    onSelect({ provider, model });
  };

  return (
    <div className="sheet-overlay" onClick={onCancel}>
      <div className="action-sheet model-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">选择模型（新对话生效）</div>

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
                            onClick={() => select(p.slug, m)}
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
