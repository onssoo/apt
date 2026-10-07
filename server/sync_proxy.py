#!/usr/bin/env python3
"""apt-sync —— APT 的多设备同步服务。见 docs/CONTRACT.md 第 19 章、TASKS M10。

职责：每个家庭成员一个专属 token，各存一份 JSON 文档；**合并由客户端做**
（按 words[].upd 取新、logs 按日并集），服务端只是一个哑存储 + 一个可选的打卡板。

设计要点（硬规则 10：VPS 只有 1.9 GiB，且已跑 Caddy + lababa + PostgreSQL）：
- **仅标准库**，不装依赖
- 只监听 127.0.0.1，由 Caddy 反代
- **token 只存 sha256 前 16 位**，原文不留库，日志里也只有哈希前缀
- 日志只记方法 / 路径 / 状态码 / 字节数 / 用户哈希前缀，**绝不记正文**（M10-6）
- 打卡板默认关闭：只有本人打开后，别人才读得到「今天打卡没有 / 连续几天」
- 体量上限 2 MiB；每 IP 每分钟 120 次，挡住拿 token 撞库

接口：
    GET  /api/sync    Authorization: Bearer <token>
        → 200 {"doc": {...}|null, "updatedAt": 1696…}
    PUT  /api/sync    Authorization: Bearer <token>
        body {"doc": {...}, "board": {"enabled":true,"name":"Mei","done":true,"streak":3}|null}
        → 200 {"ok":true,"updatedAt":1696…}
    GET  /api/board   （不需要 token：只回**主动打开**打卡板的人）
        → 200 {"entries":[{"name":"Mei","done":true,"streak":3,"updatedAt":…}]}
    GET  /healthz     → 200 ok
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = os.environ.get("STATE_DIRECTORY", "/var/lib/apt-sync")
PORT = int(os.environ.get("PORT", "8788"))
MAX_BODY = 2 * 1024 * 1024          # 2 MiB
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
RATE_PER_MIN = int(os.environ.get("RATE_PER_MIN", "120"))
DB = os.path.join(STATE, "sync.db")

os.makedirs(STATE, exist_ok=True)

_lock = threading.Lock()
_db = None


def db():
    """单连接 + 一把锁。家用体量，够了；SQLite 的并发写本来也要串行。"""
    global _db
    if _db is None:
        _db = sqlite3.connect(DB, check_same_thread=False)
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute("""CREATE TABLE IF NOT EXISTS users (
            uid            TEXT PRIMARY KEY,
            doc            TEXT    NOT NULL DEFAULT '',
            updated_at     INTEGER NOT NULL DEFAULT 0,
            board_enabled  INTEGER NOT NULL DEFAULT 0,
            board_name     TEXT    NOT NULL DEFAULT '',
            board_done     INTEGER NOT NULL DEFAULT 0,
            board_streak   INTEGER NOT NULL DEFAULT 0,
            board_updated  INTEGER NOT NULL DEFAULT 0
        )""")
        _db.commit()
    return _db


def uid_of(token):
    """token 只以哈希形式落库；日志里也只出现这个前缀。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


# 每 IP 每分钟计数（内存态，重启清零 —— 挡撞库够用）
_hits = {}
_hits_lock = threading.Lock()


def rate_ok(ip):
    now = int(time.time() // 60)
    with _hits_lock:
        slot, n = _hits.get(ip, (now, 0))
        if slot != now:
            _hits[ip] = (now, 1)
            return True
        if n >= RATE_PER_MIN:
            return False
        _hits[ip] = (now, n + 1)
        return True


class H(BaseHTTPRequestHandler):
    server_version = "apt-sync/1"
    protocol_version = "HTTP/1.1"

    # ---------- 工具 ----------
    def _send(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _token(self):
        h = self.headers.get("Authorization", "")
        if not h.startswith("Bearer "):
            return None
        t = h[7:].strip()
        return t if TOKEN_RE.match(t) else None

    def _drain(self, n):
        """把请求体读掉再回响应。

        不读就直接关连接，客户端会收到 connection reset、根本看不到 413。
        读的量设个硬上限，超过就放弃并关连接（生产上 Caddy 的
        request_body max_size 会先把它挡住，这里是第二道）。
        """
        cap = 16 * 1024 * 1024
        if n > cap:
            self.close_connection = True
            return
        left = n
        while left > 0:
            chunk = self.rfile.read(min(65536, left))
            if not chunk:
                break
            left -= len(chunk)

    def _body(self):
        """返回 (ok, payload)。payload 为 "too-large" 表示体量超限。"""
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return False, None
        if n <= 0:
            return False, None
        if n > MAX_BODY:
            self._drain(n)
            return False, "too-large"
        try:
            return True, json.loads(self.rfile.read(n).decode("utf-8", "replace"))
        except Exception:
            return False, None

    # ---------- 路由 ----------
    def _rate(self):
        """每 IP 每分钟限流，挡住拿 token 撞库。"""
        if rate_ok(self.client_address[0]):
            return True
        self._send(429, {"error": "too many requests"})
        return False

    def do_GET(self):
        if not self._rate():
            return
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self._send(200, {"ok": True})
        if path == "/api/board":
            return self.board()
        if path == "/api/sync":
            return self.sync_get()
        return self._send(404, {"error": "not found"})

    def do_PUT(self):
        if not self._rate():
            return
        if self.path.split("?")[0] == "/api/sync":
            return self.sync_put()
        return self._send(404, {"error": "not found"})

    # ---------- 实现 ----------
    def sync_get(self):
        t = self._token()
        if not t:
            return self._send(401, {"error": "missing or bad token"})
        uid = uid_of(t)
        with _lock:
            row = db().execute("SELECT doc, updated_at FROM users WHERE uid=?", (uid,)).fetchone()
        if not row:
            return self._send(200, {"doc": None, "updatedAt": 0})
        try:
            doc = json.loads(row[0]) if row[0] else None
        except Exception:
            doc = None
        return self._send(200, {"doc": doc, "updatedAt": row[1]})

    def sync_put(self):
        t = self._token()
        if not t:
            return self._send(401, {"error": "missing or bad token"})
        ok, body = self._body()
        if not ok:
            if body == "too-large":
                return self._send(413, {"error": f"body too large (max {MAX_BODY} bytes)"})
            return self._send(400, {"error": "bad json body"})
        doc = body.get("doc")
        if not isinstance(doc, dict):
            return self._send(400, {"error": "doc must be an object"})

        board = body.get("board")
        uid = uid_of(t)
        now = int(time.time() * 1000)
        with _lock:
            c = db()
            c.execute("""INSERT INTO users (uid, doc, updated_at) VALUES (?,?,?)
                         ON CONFLICT(uid) DO UPDATE SET doc=excluded.doc, updated_at=excluded.updated_at""",
                      (uid, json.dumps(doc, ensure_ascii=False), now))
            if isinstance(board, dict):
                c.execute("""UPDATE users SET board_enabled=?, board_name=?, board_done=?,
                             board_streak=?, board_updated=? WHERE uid=?""",
                          (1 if board.get("enabled") else 0,
                           str(board.get("name") or "")[:24],
                           1 if board.get("done") else 0,
                           int(board.get("streak") or 0),
                           now, uid))
            c.commit()
        return self._send(200, {"ok": True, "updatedAt": now})

    def board(self):
        """只返回**自己打开了打卡板**的人。默认全员关闭，所以她不开就没人看得到。"""
        with _lock:
            rows = db().execute("""SELECT board_name, board_done, board_streak, board_updated
                                   FROM users WHERE board_enabled=1
                                   ORDER BY board_streak DESC, board_name ASC""").fetchall()
        return self._send(200, {"entries": [
            {"name": r[0], "done": bool(r[1]), "streak": r[2], "updatedAt": r[3]} for r in rows
        ]})

    # ---------- 日志：绝不记正文（M10-6） ----------
    def log_message(self, fmt, *args):
        return   # 关掉默认日志，统一走下面这条

    def log_request(self, code="-", size="-"):
        try:
            ip = self.client_address[0]
            t = self._token()
            who = uid_of(t)[:8] if t else "-"
            path = self.path.split("?")[0]
            sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {ip} {self.command} "
                             f"{path} {code} {size}B user={who}\n")
        except Exception:
            pass


def main():
    db()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.daemon_threads = True
    sys.stderr.write(f"apt-sync 启动：127.0.0.1:{PORT} db={DB} 限速={RATE_PER_MIN}/分钟\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
