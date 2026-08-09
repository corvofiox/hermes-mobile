import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除等）：确认按钮用红色样式 */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

/** 轻量确认弹窗（Android WebView 不支持 window.confirm，必须用自定义 modal） */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onCancel,
  onConfirm,
}: Props) {
  /** 确认操作执行中：按钮禁用 + 文案变化，防双击并发（onConfirm 为 async 时 await 后自动复位） */
  const [submitting, setSubmitting] = useState(false);
  // submitting 的 ref 镜像：mask 点击 / 物理返回键守卫用（state 在一次性注册的监听器闭包里会 stale）
  const submittingRef = useRef(false);
  submittingRef.current = submitting;
  // 稳定回调引用（父组件内联箭头函数每次渲染都是新引用，避免 effect 反复重挂）
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // 物理返回键感知：打开时通知 App（弹窗打开时返回键应关闭弹窗而非退出 App）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: true } }));
    const onCloseRequest = () => {
      // submitting 期间禁止关闭（确认请求已在途，物理返回键不打断删除等操作）
      if (submittingRef.current) return;
      onCancelRef.current();
    };
    window.addEventListener("hermes:modal-close-request", onCloseRequest);
    return () => {
      window.removeEventListener("hermes:modal-close-request", onCloseRequest);
      window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: false } }));
    };
  }, []);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-mask"
      onClick={() => {
        // submitting 期间 mask 点击不触发 onCancel（与取消按钮 disabled 行为一致，防误关）
        if (!submittingRef.current) onCancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h3 className="modal-title">{title}</h3>
        <p className="modal-text">{message}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={submitting}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => void handleConfirm()}
            disabled={submitting}
          >
            {submitting ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
