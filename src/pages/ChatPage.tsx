import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getModelPref, renameSessionRest, setModelPref, type ModelPref } from "../lib/api";
import type { GatewayEvent, HermesGateway } from "../lib/gateway";
import RenameModal from "../components/RenameModal";
import ModelPicker from "../components/ModelPicker";

interface Props {
  gateway: HermesGateway;
  sessionId: string;
  /** 新建会话时由 create 返回的 live id（旧会话打开时不传，走 resume） */
  sessionLiveId?: string;
  sessionTitle: string;
  onBack: () => void;
}

interface Msg {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  error?: boolean;
  /** 用户发送的图片（本地 dataUrl 预览） */
  images?: string[];
}

interface ToolActivity {
  name: string;
  args?: string;
}

interface PendingImage {
  id: number;
  dataUrl: string;
  /** attach 响应文本（纯图片发送时作为 prompt） */
  text: string;
}

/** streaming 期间代码围栏可能未闭合（奇数个 ```），渲染前补齐闭合标记 */
function closeUnclosedFence(text: string): string {
  const opens = (text.match(/```/g) ?? []).length;
  return opens % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/** 代码块：复制按钮 + 等宽渲染 */
function CodeBlock(props: React.ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/WebView）时静默
    }
  };
  return (
    <div className="code-block">
      <button className="code-copy" onClick={copy}>
        {copied ? "✓ 已复制" : "⧉ 复制"}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

export default function ChatPage({ gateway, sessionId, sessionLiveId, sessionTitle, onBack }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connState, setConnState] = useState(gateway.connectionState);
  const [tool, setTool] = useState<ToolActivity | null>(null);
  const [status, setStatus] = useState("");
  const [title, setTitle] = useState(sessionTitle);
  const [renaming, setRenaming] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  /** 历史消息加载中（旧会话 resume 期间显示加载效果，不显示 empty 文案） */
  const [historyLoading, setHistoryLoading] = useState<boolean>(() => !sessionLiveId);
  /** live id 就绪（ref 写入不触发 re-render，需 state 驱动按钮解禁；新会话初始即就绪） */
  const [liveReady, setLiveReady] = useState<boolean>(() => !!sessionLiveId);
  /** 模型偏好（新会话生效）；当前会话的模型由 resume 时服务端决定 */
  const [modelPref, setModelPrefState] = useState<ModelPref>(() => getModelPref());
  const [showModelPicker, setShowModelPicker] = useState(false);
  /** 已附加待发送的图片 */
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  /** 图片源选择弹窗 */
  const [showImageSheet, setShowImageSheet] = useState(false);
  /** 语音识别中（ref 同步副本：listeningState 事件不可靠时用 ref 判断，防 stale） */
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const setListeningBoth = (v: boolean) => {
    listeningRef.current = v;
    setListening(v);
  };
  /** 组件挂载状态（语音 start 多 await 期间返回列表时中断流程，防麦克风悬挂） */
  const mountedRef = useRef(true);
  /** stopVoice 后忽略迟到的 started 事件 */
  const voiceStoppedRef = useRef(false);
  /** 全屏图片预览（dataUrl 或 http URL） */
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const voiceOffRef = useRef<(() => void) | null>(null);
  const msgId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 发送 in-flight 守卫（busy state 异步更新，防连按双发） */
  const sendLockRef = useRef(false);
  /** 语音启动 in-flight 守卫（listening state 异步更新，防连点交错 start） */
  const voiceStartLockRef = useRef(false);
  /** live session_id（resume/create 响应的 session_id），事件过滤/发送/interrupt 都用它 */
  const liveSessionIdRef = useRef<string | null>(null);
  const historyLoaded = useRef(false);
  /** resume 曾成功过（重连后需要 re-resume 恢复 live id） */
  const resumeSucceededRef = useRef(false);
  const resumingRef = useRef(false);
  /** 是否经历过断线（用于区分重连恢复 vs 新会话首挂载） */
  const wasDisconnectedRef = useRef(false);
  /** delta 累积缓冲 + rAF 节流批量 setState */
  const deltaBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const nextId = () => ++msgId.current;

  // 事件订阅：delta 追加到当前 streaming 消息
  useEffect(() => {
    // 事件过滤：仅处理本会话（live session_id）的事件
    const isForThisSession = (ev: GatewayEvent): boolean =>
      ev.session_id === liveSessionIdRef.current;

    const flushDelta = () => {
      rafRef.current = null;
      const text = deltaBufRef.current;
      if (!text) return;
      deltaBufRef.current = "";
      const newId = nextId();
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = { ...last, text: last.text + text };
        } else {
          copy.push({ id: newId, role: "assistant", text, streaming: true });
        }
        return copy;
      });
    };
    const queueDelta = (text: string) => {
      deltaBufRef.current += text;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushDelta);
      }
    };

    const offState = gateway.onConnectionState((s) => setConnState(s));
    const offDelta = gateway.on("message.delta", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { text?: string } | undefined;
      if (!payload?.text) return;
      queueDelta(payload.text);
    });
    const offComplete = gateway.on("message.complete", (ev) => {
      if (!isForThisSession(ev)) return;
      // 先落盘缓冲中的 delta，再收尾（避免 rAF 迟到补一条重复消息）
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      flushDelta();
      const payload = ev.payload as { text?: string; status?: string } | undefined;
      const newId = nextId();
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = {
            ...last,
            text: payload?.text ?? last.text,
            streaming: false,
            error: payload?.status === "error",
          };
        } else if (payload?.text) {
          // 无 streaming 消息（如极短回复）也补一条，不静默丢弃
          copy.push({
            id: newId,
            role: "assistant",
            text: payload.text,
            error: payload?.status === "error",
          });
        }
        return copy;
      });
      setTool(null);
      setStatus("");
      setBusy(false);
    });
    const offToolStart = gateway.on("tool.start", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { name?: string; args?: string } | undefined;
      setTool({ name: payload?.name ?? "工具", args: payload?.args });
      setStatus(`正在执行: ${payload?.name ?? "工具"}`);
    });
    const offToolComplete = gateway.on("tool.complete", (ev) => {
      if (!isForThisSession(ev)) return;
      setTool(null);
      setStatus("");
    });
    const offStatus = gateway.on("status.update", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { message?: string; status?: string } | undefined;
      if (payload?.message) setStatus(payload.message);
    });
    const offError = gateway.on("error", (ev) => {
      if (!isForThisSession(ev)) return;
      const payload = ev.payload as { message?: string } | undefined;
      setStatus(payload?.message ?? "出错了");
      setBusy(false);
    });
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      offState();
      offDelta();
      offComplete();
      offToolStart();
      offToolComplete();
      offStatus();
      offError();
    };
  }, [gateway]);

  // 加载历史（首次打开 / 失败后重试 / 断线重连恢复）
  const doResume = useCallback(async () => {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setHistoryLoading(true);
    setHistoryFailed(false);
    // 清空滞留的 delta 缓冲：重连恢复时旧缓冲可能被 rAF 推成"幽灵转圈消息"
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    deltaBufRef.current = "";
    try {
      if (gateway.connectionState !== "open") {
        await gateway.connect();
      }
      const resumed = await gateway.resumeSession(sessionId);
      liveSessionIdRef.current = resumed.session_id;
      resumeSucceededRef.current = true;
      setLiveReady(true); // resume 完成解禁按钮（触发 re-render）
      const history = Array.isArray(resumed.messages) ? resumed.messages : [];
      const msgs: Msg[] = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: nextId(),
          role: m.role as "user" | "assistant",
          text: String(m.text ?? m.content ?? ""),
        }));
      // 断线重连恢复：会话仍在运行则进入 busy，并用 inflight 快照初始化末条消息；
      // 否则必须复位 busy/tool/status（旧 complete 帧可能丢在断掉的 transport 上，永远等不到）
      if (resumed.running) {
        setBusy(true);
        const inflight = resumed.inflight;
        if (inflight?.assistant && inflight.streaming) {
          msgs.push({ id: nextId(), role: "assistant", text: inflight.assistant, streaming: true });
        }
      } else {
        setBusy(false);
        setTool(null);
        setStatus("");
      }
      setMessages(msgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 新会话未落库时 resume 会 4007/not found：re-resume 场景静默（防 busy 卡死），
      // 并清空失效的 live id（发送按钮自动禁用，避免发送才报 4001）
      if (resumeSucceededRef.current && /not found|4007/i.test(msg)) {
        liveSessionIdRef.current = null;
        setLiveReady(false);
        setBusy(false);
        setTool(null);
        setStatus("会话已过期（未发送过消息的新会话重连后需重新创建）");
      } else {
        resumeSucceededRef.current = false;
        historyLoaded.current = false; // 允许重试按钮重新触发加载
        setHistoryFailed(true);
        setStatus(`历史加载失败：${msg}`);
      }
    } finally {
      resumingRef.current = false;
      setHistoryLoading(false);
    }
  }, [gateway, sessionId]);

  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    if (sessionLiveId) {
      // 新建会话：live id 已由 create 提供，直接使用（create 不持久化 DB 行，resume 会 404）
      liveSessionIdRef.current = sessionLiveId;
      resumeSucceededRef.current = true;
      setLiveReady(true); // 触发 re-render 解禁按钮（ref 写入本身不触发渲染）
      return;
    }
    void doResume();
  }, [gateway, sessionId, sessionLiveId, reloadTick, doResume]);

  // 断线重连成功后：旧 WS 上的 live session 已销毁，重新 resume 恢复 live id 与进行中的回合。
  // 用 wasDisconnectedRef 区分"真断线"与"新会话首挂载的 open 立即回调"：
  // 后者不触发 re-resume（避免新会话未落库的假阳性 4007 和一次多余 RPC）。
  useEffect(() => {
    const off = gateway.onConnectionState((s) => {
      setConnState(s);
      if (s === "closed" || s === "error") wasDisconnectedRef.current = true;
      if (s === "open" && resumeSucceededRef.current && wasDisconnectedRef.current) {
        void doResume();
      }
    });
    return off;
  }, [gateway, doResume]);

  // 自动滚底：仅当用户位于底部附近（<100px）时跟随
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const onScroll = () => {
      setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 卸载时清理语音监听器 + 停止麦克风（防止返回列表后仍在录音）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      voiceOffRef.current?.();
      voiceOffRef.current = null;
      import("@capacitor-community/speech-recognition")
        .then(({ SpeechRecognition }) => SpeechRecognition.stop())
        .catch(() => {
          // 非原生环境无插件，忽略
        });
    };
  }, []);

  useEffect(() => {
    if (!nearBottom) return;
    // auto（非 smooth）：流式高频更新时避免滚动动画排队卡顿
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, status, nearBottom]);

  // textarea 自动增高（max-height 120px，CSS 兜底）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const send = async () => {
    const text = input.trim();
    const hasImages = pendingImages.length > 0;
    // resume 完成前（liveSessionIdRef 未就绪）或 re-resume 进行中禁止发送
    if ((!text && !hasImages) || busy || !liveSessionIdRef.current || resumingRef.current) return;
    if (sendLockRef.current) return; // in-flight 守卫（busy state 更新前连按两次）
    sendLockRef.current = true;
    // 纯图片发送：用 attach 响应文本作为 prompt（服务端行为与桌面端一致）
    const promptText = text || pendingImages[0]?.text || "";
    const imageDataUrls = pendingImages.map((p) => p.dataUrl);
    setInput("");
    setPendingImages([]);
    const newId = nextId();
    setMessages((prev) => [...prev, { id: newId, role: "user", text, images: imageDataUrls }]);
    setBusy(true);
    try {
      await gateway.submitPrompt(liveSessionIdRef.current, promptText);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
      // 发送失败：把刚 push 的用户消息标记 error
      setMessages((prev) => prev.map((m) => (m.id === newId ? { ...m, error: true } : m)));
    } finally {
      sendLockRef.current = false;
    }
  };

  const stop = useCallback(() => {
    const liveId = liveSessionIdRef.current;
    if (!liveId) return;
    // 真正的停止：服务端 session.interrupt，不污染对话
    gateway.interrupt(liveId).catch(() => {
      // 断线/重连期间 interrupt 会失败，给用户可见反馈而不是静默
      setStatus("停止失败：连接已断开，请稍后重试");
    });
  }, [gateway]);

  const doRename = async (name: string) => {
    setRenaming(false);
    try {
      await renameSessionRest(sessionId, name);
      setTitle(name);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  /** 模型选择：持久化偏好（新会话生效） */
  const handleModelSelect = (pref: ModelPref) => {
    setModelPrefState(pref);
    setModelPref(pref);
    setShowModelPicker(false);
    setStatus(`模型已切换为 ${pref.model}（新对话生效）`);
  };

  /** 拍照 / 相册选图 → 压缩 base64 → image.attach_bytes 挂载到会话 */
  const pickImage = async (source: "camera" | "photos") => {
    setShowImageSheet(false);
    const liveId = liveSessionIdRef.current;
    if (!liveId) {
      setStatus("会话未就绪，无法附加图片");
      return;
    }
    try {
      const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
      const photo = await Camera.getPhoto({
        source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
        resultType: CameraResultType.Base64,
        quality: 85,
        width: 1600,
        promptLabelHeader: "选择图片",
        promptLabelPhoto: "从相册选择",
        promptLabelPicture: "拍照",
        promptLabelCancel: "取消",
      });
      if (!photo.base64String) return;
      const fmt = photo.format && /^[a-z0-9]+$/i.test(photo.format) ? photo.format : "jpeg";
      const dataUrl = `data:image/${fmt};base64,${photo.base64String}`;
      const res = await gateway.attachImage(liveId, photo.base64String, `mobile_${Date.now()}.${fmt}`);
      if (res.attached) {
        setPendingImages((prev) => [
          ...prev,
          { id: nextId(), dataUrl, text: res.text ?? `[User attached image: mobile_${Date.now()}]` },
        ]);
      } else {
        setStatus("图片附加失败（服务端未接受）");
      }
    } catch (err) {
      // 用户取消拍照/选图（Camera 抛 "User cancelled"）不算错误
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(msg)) return;
      setStatus(`选择图片失败：${msg}`);
    }
  };

  const removePendingImage = (id: number) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  };

  /** 语音输入：Android 系统语音识别 → 文字填入输入框 */
  const toggleVoice = async () => {
    if (listeningRef.current) {
      await stopVoice();
      return;
    }
    if (voiceStartLockRef.current) return; // 防连点：start 流程进行中忽略第二次点击
    voiceStartLockRef.current = true;
    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      if (!mountedRef.current) return; // 已返回列表，中断流程
      const available = await SpeechRecognition.available();
      if (!mountedRef.current) return;
      if (!available.available) {
        setStatus("当前设备不支持语音识别");
        return;
      }
      const perm = await SpeechRecognition.checkPermissions();
      if (!mountedRef.current) return;
      if (perm.speechRecognition !== "granted") {
        const req = await SpeechRecognition.requestPermissions();
        if (!mountedRef.current) return;
        if (req.speechRecognition !== "granted") {
          setStatus("需要麦克风权限才能使用语音输入");
          return;
        }
      }
      // 先清掉旧监听，避免重复注册累积
      voiceOffRef.current?.();
      voiceOffRef.current = null;
      const offPartial = await SpeechRecognition.addListener("partialResults", (data: { matches: string[] }) => {
        const m = data.matches?.[0];
        if (m) setInput(m);
      });
      const offState = await SpeechRecognition.addListener("listeningState", (data: { status: string }) => {
        if (voiceStoppedRef.current && data.status === "started") return; // 停止后迟到的 started 事件忽略
        setListeningBoth(data.status === "started");
      });
      if (!mountedRef.current) {
        // await 监听注册期间组件已卸载：立即清理，不启动识别
        void offPartial.remove();
        void offState.remove();
        return;
      }
      voiceOffRef.current = () => {
        void offPartial.remove();
        void offState.remove();
      };
      voiceStoppedRef.current = false;
      setListeningBoth(true);
      await SpeechRecognition.start({ language: "zh-CN", partialResults: true, popup: false });
    } catch (err) {
      if (!mountedRef.current) return; // 已卸载，不更新状态
      setListeningBoth(false);
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`语音识别启动失败：${msg}`);
    } finally {
      voiceStartLockRef.current = false;
    }
  };

  const stopVoice = async () => {
    // 显式复位状态（listeningState 事件在部分设备上不可靠，不能依赖事件关闭）
    setListeningBoth(false);
    voiceStoppedRef.current = true;
    voiceStartLockRef.current = true; // 停止进行中禁止立即重开（防 stop/start 竞态）
    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      await SpeechRecognition.stop();
    } catch {
      // 忽略停止失败（插件已卸载/非原生环境）
    } finally {
      voiceStartLockRef.current = false;
    }
    voiceOffRef.current?.();
    voiceOffRef.current = null;
  };

  /** 复制消息文本（长按消息触发） */
  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制到剪贴板");
    } catch {
      setStatus("复制失败");
    }
  };

  const connDotCls =
    connState === "open" ? "ok" : connState === "connecting" || connState === "idle" ? "pending" : "down";
  const connDotTitle =
    connState === "open"
      ? "已连接"
      : connState === "connecting" || connState === "idle"
        ? "连接中…"
        : "连接断开";

  return (
    <div className="chat-screen">
      <header className="topbar">
        <button className="btn" onClick={onBack}>
          ‹ 返回
        </button>
        <div className="topbar-title">
          <button className="title-btn" onClick={() => setRenaming(true)}>
            {title || "新对话"}
          </button>
          <span className={`conn-dot ${connDotCls}`} title={connDotTitle} />
        </div>
        <button className="btn" onClick={stop} disabled={!busy || !liveReady}>
          停止
        </button>
      </header>

      <div className="chat-body" ref={chatBodyRef}>
        {historyLoading && messages.length === 0 && (
          <div className="empty">
            <div className="spinner" />
            <p>正在加载对话…</p>
          </div>
        )}
        {!historyLoading && messages.length === 0 && !historyFailed && (
          <div className="empty">
            <p>开始和 Hermes 对话吧</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`msg ${m.role}${m.error ? " error" : ""}`}
            onContextMenu={(e) => {
              e.preventDefault();
              if (m.text) void copyMessage(m.text);
            }}
          >
            {m.role === "user" ? (
              <div className="bubble user-bubble">
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        className="msg-image"
                        alt="发送的图片"
                        onClick={() => setPreviewImg(src)}
                      />
                    ))}
                  </div>
                )}
                {m.text && <div className="user-text">{m.text}</div>}
                {m.error && <span className="send-failed">⚠️ 发送失败</span>}
              </div>
            ) : (
              <div className="bubble assistant-bubble">
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: CodeBlock,
                      img: ({ src, alt }) => (
                        <img
                          src={src}
                          alt={alt ?? ""}
                          className="md-image"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (src) setPreviewImg(src);
                          }}
                        />
                      ),
                    }}
                  >
                    {m.streaming ? closeUnclosedFence(m.text) : m.text}
                  </ReactMarkdown>
                </div>
                {m.streaming && <span className="cursor" />}
              </div>
            )}
          </div>
        ))}
        {busy && !tool && !status && (
          <div className="thinking">
            <span className="dot" /><span className="dot" /><span className="dot" />
          </div>
        )}
        {status && (
          <div className="status-line">
            <span>{status}</span>
            {historyFailed && (
              <button
                className="btn btn-sm status-retry"
                onClick={() => {
                  setStatus("");
                  setReloadTick((t) => t + 1);
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="composer">
        {/* 模型选择独立一行（小屏不被输入行挤压） */}
        <div className="composer-model-row">
          <button
            className="model-btn"
            title="选择模型（新对话生效）"
            onClick={() => setShowModelPicker(true)}
          >
            <span className="model-btn-name">{modelPref.model}</span>
          </button>
          <span className="composer-model-hint">点此切换模型，新对话生效</span>
        </div>

        {/* 已附加图片预览条（独立一行） */}
        {pendingImages.length > 0 && (
          <div className="pending-images">
            {pendingImages.map((p) => (
              <div key={p.id} className="pending-img-wrap">
                <img src={p.dataUrl} className="pending-img" alt="待发送" />
                <button
                  className="pending-img-remove"
                  onClick={() => removePendingImage(p.id)}
                  aria-label="移除图片"
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="btn btn-sm pending-add" onClick={() => setShowImageSheet(true)}>
              ＋
            </button>
          </div>
        )}
        <div className="composer-row">
          <button
            className="attach-btn"
            title="发送图片"
            onClick={() => setShowImageSheet(true)}
            disabled={!liveReady || resumingRef.current}
          >
            ＋
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            placeholder="输入消息…"
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法组词中的 Enter 不应触发发送
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className={`voice-btn${listening ? " listening" : ""}`}
            title={listening ? "结束语音输入" : "语音输入"}
            onClick={() => void toggleVoice()}
            disabled={busy || !liveReady || resumingRef.current}
          >
            {listening ? "■" : "🎤"}
          </button>
          <button
            className="btn btn-primary send-btn"
            onClick={send}
            disabled={
              busy ||
              (!input.trim() && pendingImages.length === 0) ||
              !liveReady ||
              resumingRef.current
            }
          >
            发送
          </button>
        </div>
      </footer>

      {/* 图片源选择 */}
      {showImageSheet && (
        <div className="sheet-overlay" onClick={() => setShowImageSheet(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">发送图片</div>
            <button className="sheet-item" onClick={() => void pickImage("camera")}>
              📷 拍照
            </button>
            <button className="sheet-item" onClick={() => void pickImage("photos")}>
              🖼 从相册选择
            </button>
            <button className="sheet-item cancel" onClick={() => setShowImageSheet(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 全屏图片预览 */}
      {previewImg && (
        <div className="img-preview-overlay" onClick={() => setPreviewImg(null)}>
          <img src={previewImg} alt="预览" className="img-preview-full" />
          <button className="img-preview-close" onClick={() => setPreviewImg(null)}>
            ✕
          </button>
        </div>
      )}

      {renaming && (
        <RenameModal
          title="重命名会话"
          initialValue={title}
          placeholder="输入新名字"
          onCancel={() => setRenaming(false)}
          onConfirm={(v) => void doRename(v)}
        />
      )}

      {showModelPicker && (
        <ModelPicker
          current={modelPref}
          onSelect={handleModelSelect}
          onCancel={() => setShowModelPicker(false)}
        />
      )}
    </div>
  );
}
