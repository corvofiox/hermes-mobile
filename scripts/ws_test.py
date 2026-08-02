"""Hermes Mobile 端到端协议验证：login → ws-ticket → WS → session.create → prompt.submit → message.delta"""
import asyncio
import json
import time
import urllib.request

# 从 .env 读取凭据（不打印密码）
creds = {}
for line in open("/opt/data/.env"):
    line = line.strip()
    if line.startswith("HERMES_DASHBOARD_BASIC_AUTH_"):
        k, v = line.split("=", 1)
        creds[k] = v.strip().strip('"').strip("'")

BASE = "http://127.0.0.1:5173"  # 走 vite proxy（同源）

# 1. 登录
body = json.dumps({
    "provider": "basic",
    "username": creds["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"],
    "password": creds["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"],
    "next": "",
}).encode()
req = urllib.request.Request(BASE + "/auth/password-login", data=body,
                             headers={"Content-Type": "application/json"})
try:
    resp = urllib.request.urlopen(req)
except urllib.error.HTTPError as e:
    print("LOGIN FAILED:", e.code, e.read()[:200])
    raise SystemExit(1)
login_body = resp.read()
print("1. login:", resp.status, login_body[:120])

# 收集 cookie
cookies = resp.headers.get_all("Set-Cookie")
if not cookies:
    print("!! no Set-Cookie — 登录可能未成功")
cookie_str = "; ".join(c.split(";")[0] for c in cookies)
print("   cookies:", [c.split(";")[0][:24] + "..." for c in cookies])

# 2. ws-ticket（POST！）
req2 = urllib.request.Request(BASE + "/api/auth/ws-ticket", method="POST",
                              headers={"Cookie": cookie_str})
resp2 = urllib.request.urlopen(req2)
ticket_data = json.loads(resp2.read())
ticket = ticket_data["ticket"]
print("2. ws-ticket: ttl=%s ticket=%s..." % (ticket_data.get("ttl_seconds"), ticket[:16]))

# 3. WebSocket 全流程
import websockets


async def main():
    uri = f"ws://127.0.0.1:5173/api/ws?ticket={ticket}"
    async with websockets.connect(uri, max_size=None, open_timeout=15) as ws:
        print("3. WS connected")

        # session.create（跳过 gateway.ready 等事件帧，等 id=m1 的响应）
        # 注意：显式传 model/provider（桌面端行为）——不传会继承 serve 默认(free 档易限流)
        await ws.send(json.dumps({"id": "m1", "method": "session.create",
                                  "params": {"cols": 50, "title": "移动端协议测试", "messages": [],
                                             "model": "deepseek-v4-flash", "provider": "opencode-go"}}))
        frame = None
        for _ in range(5):
            f = json.loads(await ws.recv())
            if f.get("id") == "m1":
                frame = f
                break
            print("   EVENT帧:", f.get("params", {}).get("type", "?"), str(f.get("params", {}))[:60])
        if frame is None or "result" not in frame:
            print("!! session.create 失败:", json.dumps(frame)[:400] if frame else "无响应")
            raise SystemExit(2)
        sid = frame["result"]["session_id"]
        print("   session.create →", frame["result"].get("session_id"),
              "msg_count:", frame["result"].get("message_count"))

        # prompt.submit
        await ws.send(json.dumps({"id": "m2", "method": "prompt.submit",
                                  "params": {"session_id": sid, "text": "用一句话回答：1+1等于几？"}}))

        start = time.time()
        got_delta = False
        got_complete = False
        while time.time() - start < 240:
            raw = await asyncio.wait_for(ws.recv(), timeout=90)
            frame = json.loads(raw)
            if frame.get("id") == "m2":
                print("   prompt.submit ack:", json.dumps(frame.get("result", frame.get("error")))[:100])
                continue
            evt = frame.get("params", {})
            t = evt.get("type", "?")
            if t == "message.delta":
                got_delta = True
                txt = evt.get("payload", {}).get("text", "")
                if len(txt) > 1:
                    print("   DELTA:", repr(txt[-80:]))
            elif t == "message.complete":
                got_complete = True
                print("   COMPLETE:", repr(evt.get("payload", {}).get("text", ""))[:300])
                break
            elif t in ("tool.start", "tool.complete", "status.update", "message.start", "thinking.delta"):
                print("   EVENT:", t, str(evt.get("payload"))[:80])

        print("4. RESULT: delta=%s complete=%s" % (got_delta, got_complete))
        # 清理测试会话
        try:
            await ws.send(json.dumps({"id": "m9", "method": "session.delete", "params": {"session_id": sid}}))
            await ws.recv()
            print("   已删除测试会话", sid)
        except Exception:
            pass


asyncio.run(main())
