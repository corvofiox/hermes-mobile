import { useState } from "react";
import { ApiError, checkServer, passwordLoginWithFallback } from "../lib/api";
import { baseCandidates, setBaseUrl } from "../lib/server";

interface Props {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: Props) {
  // 不预填默认服务器地址（避免暴露内网 IP）；由用户手动输入，占位符给出格式示例
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serverOk, setServerOk] = useState<string>("");

  const testServer = async () => {
    const candidates = baseCandidates(serverUrl);
    if (candidates.length === 0) {
      setError("请输入服务器地址");
      return;
    }
    setTesting(true);
    setServerOk("");
    setError("");
    try {
      for (const base of candidates) {
        const result = await checkServer(base);
        if (result.ok) {
          setBaseUrl(base); // 测试成功即记住可用地址
          setServerUrl(base);
          setServerOk(`✓ 已连接 Hermes v${result.version ?? ""}`);
          return;
        }
      }
      // 全部候选失败：报最后一个错误
      const last = await checkServer(candidates[candidates.length - 1]);
      setError(`无法连接服务器：${last.detail ?? "未知错误"}`);
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setServerOk("");
    try {
      // 协议自动探测登录：https → http 回退；无端口默认 9119
      const candidates = baseCandidates(serverUrl);
      if (candidates.length === 0) {
        setError("请输入服务器地址");
        return;
      }
      await passwordLoginWithFallback(username, password, candidates);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `网络错误：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo">◈</div>
        <h1>Hermes Mobile</h1>
        <p className="subtitle">连接你的 Hermes 实例</p>
        <form onSubmit={submit}>
          <div className="server-row">
            <input
              type="text"
              placeholder="http://192.168.x.x:9119"
              autoCapitalize="none"
              autoCorrect="off"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              required
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void testServer()}
              disabled={testing || !serverUrl.trim()}
            >
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
          {serverOk && <div className="server-ok">{serverOk}</div>}
          <input
            type="text"
            placeholder="用户名"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "登录中…" : "登录"}
          </button>
        </form>
        <p className="hint">支持 http/https · 内网/公网地址</p>
      </div>
    </div>
  );
}
