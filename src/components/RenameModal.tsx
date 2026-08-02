import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

/** 轻量输入弹窗（Android WebView 不支持 window.prompt，必须用自定义 modal） */
export default function RenameModal({
  title,
  initialValue = "",
  placeholder = "",
  confirmLabel = "确定",
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const v = value.trim();
    if (v) onConfirm(v);
  };

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
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={placeholder}
          maxLength={60}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
