interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除等）：确认按钮用红色样式 */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
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
  return (
    <div className="modal-mask" onClick={onCancel}>
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
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
