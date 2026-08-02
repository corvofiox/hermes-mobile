# Hermes Mobile — 项目说明

安卓客户端：连接自托管 Hermes Agent（`hermes serve` / dashboard 后端）。

## 架构

- **前端**：React + Vite + TS（移动端优先 UI）
- **协议**：官方 `tui_gateway` JSON-RPC/WebSocket（vendor 拷贝自 `@hermes/shared`，MIT）
- **打包**：Capacitor 8（Android），`server.url` 模式——WebView 加载 NAS 上的前端页面（同源，规避后端 CORS 白名单）
- **构建**：GitHub Actions（ubuntu-latest 自带 Android SDK）→ 产出 debug APK

## 认证与通信流程（协议摘要）

```
① POST /auth/password-login   {provider:"basic", username, password, next:""}
   成功 → 200 {ok,next} + 会话 cookie（hermes_session_at/rt/provider）
② POST /api/auth/ws-ticket    （带 cookie，注意是 POST 不是 GET）
   → {ticket, ttl_seconds}（一次性票据，ttl≈30s）
③ WS   /api/ws?ticket=<ticket>
   服务端先推 gateway.ready 事件，然后按 JSON-RPC id 匹配请求/响应：
   请求 {"id":"m1","method":"session.create","params":{...}}
   响应 {"id":"m1","result":{...}}
   事件 {"method":"event","params":{"type":"message.delta","payload":{...},"session_id":...}}
```

关键方法：`session.create`（**必须显式传 model/provider**，否则继承 serve 默认可能撞免费档限流）、`session.list`、`session.resume`、`session.delete`、`prompt.submit`。
关键事件：`message.start/delta/complete`、`thinking.delta`、`tool.start/complete`、`status.update`。

## 开发

```bash
npm install
npm run dev        # vite dev @ 5173，/api 与 /auth 代理到 192.168.10.10:9119
npm run build      # 产物 dist/
npx cap sync android
```

- 后端地址改 `vite.config.ts` 的 `HERMES_BACKEND`（默认 http://192.168.10.10:9119）
- 生产前端静态目录改 `capacitor.config.ts` 的 `HERMES_MOBILE_SERVER_URL`（默认 http://192.168.10.10:9120，nginx 容器托管）

## 端到端协议验证

`scripts/ws_test.py` 走完 login → ticket → WS → session.create → prompt.submit → message.complete 全链路（用 `.env` 凭据）。
