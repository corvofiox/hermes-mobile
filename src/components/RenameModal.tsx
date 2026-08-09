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
  // 稳定回调引用（父组件内联箭头函数每次渲染都是新引用，避免 effect 反复重挂）
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 物理返回键感知：打开时通知 App（弹窗打开时返回键应关闭弹窗而非退出 App）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: true } }));
    const onCloseRequest = () => onCancelRef.current();
    window.addEventListener("hermes:modal-close-request", onCloseRequest);
    return () => {
      window.removeEventListener("hermes:modal-close-request", onCloseRequest);
      window.dispatchEvent(new CustomEvent("hermes:modal-change", { detail: { open: false } }));
    };
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
            // IME 组合输入（中文输入法候选）期间的 Enter 是选字而非提交
            if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229)) submit();
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
