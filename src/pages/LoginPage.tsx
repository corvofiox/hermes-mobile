import { useState } from "react";
import { ApiError, passwordLogin } from "../lib/api";

interface Props {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await passwordLogin(username, password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "网络错误，请检查服务器地址");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="logo">◈</div>
        <h1>Hermes Mobile</h1>
        <p className="subtitle">连接到你的 Hermes 实例</p>
        <form onSubmit={submit}>
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
      </div>
    </div>
  );
}
