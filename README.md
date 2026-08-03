# Hermes Mobile

Android 客户端 for [Hermes Agent](https://hermes-agent.nousresearch.com)（自托管 AI Agent）。

连接自托管 Hermes 后端（`hermes serve` / dashboard），提供移动端聊天体验：会话管理、消息发送（文字/图片/文件/语音）、模型切换、流式回复。

## 功能

- 🔐 **自由服务器配置**：任意地址（http/https、内网/公网、IP/域名、自定义端口），协议自动探测（https → http 回退）
- 💬 **消息能力**：文字、图片（拍照/相册）、文件（任意类型，上限 256MB，圆形进度环）、语音输入（系统语音识别）
- 🗂 **会话管理**：分类 tab、搜索、置顶、归档、批量操作（多选删除/归档）、长按菜单
- 🧠 **模型选择**：从认证 provider 实时拉取模型列表，按会话偏好切换
- ⚡ **流式回复**：实时增量渲染、代码块复制、图片预览、消息复制
- 🛡 **安全**：cookie 会话管理、401 自动登出、一次性 WS ticket 鉴权

## 架构

- **前端**：React 18 + Vite + TypeScript（移动端优先 UI）
- **协议**：官方 `tui_gateway` JSON-RPC/WebSocket（vendor 拷贝自 `@hermes/shared`，MIT）
- **打包**：Capacitor 8（Android），前端资源打进 APK，服务器地址由 App 内自由配置
- **构建**：GitHub Actions → debug APK（固定签名密钥，支持覆盖升级）

## 认证与通信流程

```
① POST /auth/password-login   {provider:"basic", username, password, next:""}
   成功 → 200 {ok,next} + 会话 cookie
② POST /api/auth/ws-ticket    （带 cookie，注意是 POST 不是 GET）
   → {ticket, ttl_seconds}（一次性票据，ttl≈30s）
③ WS   /api/ws?ticket=<ticket>
   服务端先推 gateway.ready 事件，然后按 JSON-RPC id 匹配请求/响应：
   请求 {"id":"m1","method":"session.create","params":{...}}
   响应 {"id":"m1","result":{...}}
   事件 {"method":"event","params":{"type":"message.delta","payload":{...},"session_id":...}}
```

关键方法：`session.create`（显式传 model/provider）、`session.resume`、`prompt.submit`、`image.attach_bytes`（图片 base64 直传）、`file.attach`（文件 data_url 上传）、`session.interrupt`。
关键事件：`message.start/delta/complete`、`tool.start/complete`、`status.update`。

## 开发

```bash
npm install
npm run dev        # vite dev @ 5173，/api 与 /auth 代理到 HERMES_BACKEND
npm run build      # 产物 dist/
npx cap sync android
```

后端代理地址：`vite.config.ts` 的 `HERMES_BACKEND` 环境变量（默认 `http://localhost:9119`）。

### 构建 APK

```bash
cd android && ./gradlew assembleDebug
```

CI 使用仓库内 `.keystore/debug.keystore`（标准 Android debug 密钥，密码 `android`）签名，所有版本共享同一签名，支持覆盖升级。

## 环境要求

- 自托管 Hermes 后端（`hermes serve` / dashboard，端口 9119）
- 后端启用 basic 认证（`/auth/password-login`）与 WS ticket 鉴权
- Android 8.0+（Capacitor 8 最低要求）

## 协议说明

- 图片：`image.attach_bytes` base64 直传，作为会话视觉上下文
- 文件：`file.attach` data_url 上传，写入会话 workspace（`.hermes/desktop-attachments/`），以 `@file:` 引用供 agent 文件工具读取；服务端上限 256MB
- 语音：Android 系统语音识别（`@capacitor-community/speech-recognition`）转文字输入

## License

MIT © 2026 Hermes Mobile contributors
