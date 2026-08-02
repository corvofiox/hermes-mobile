import { useState } from "react";
import { ApiError, checkServer, passwordLogin } from "../lib/api";
import { normalizeBaseUrl, setBaseUrl } from "../lib/server";

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
    const url = normalizeBaseUrl(serverUrl);
    setServerUrl(url);
    setTesting(true);
    setServerOk("");
    setError("");
    const result = await checkServer(url);
    setTesting(false);
    if (result.ok) {
      setServerOk(`✓ 已连接 Hermes v${result.version ?? ""}`);
    } else {
      setError(`无法连接服务器：${result.detail ?? "未知错误"}`);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setServerOk("");
    try {
      // 保存服务器地址后再登录（登录请求走新地址）
      setBaseUrl(normalizeBaseUrl(serverUrl));
      await passwordLogin(username, password);
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
