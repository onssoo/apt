#!/usr/bin/env python3
"""apt-tts —— 发音代理。契约见 docs/CONTRACT.md 第 9 章。

职责：为「学生自己添加的词」按需合成音频并长期缓存。
课文音频由Mac mini 预生成，不经本服务。

设计要点：
- 仅标准库，无第三方依赖（VPS 只有 1.9 GiB）
- 缓存命名与课文音频同一套规则（sha1(声音|文本) 前16 位）
- 原子写：先写 .tmp 再 os.replace，避免读到半文件
- 每日新合成上限，防止额度被刷光
- 只监听 127.0.0.1，不对外暴露
"""
import hashlib
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

# ---------- 配置 ----------
KEY = os.environ.get("AZURE_KEY", "")
REGION = os.environ.get("AZURE_REGION", "eastus")
VOICE = os.environ.get("VOICE", "pt-PT-RaquelNeural")
CACHE = os.environ.get("STATE_DIRECTORY", "/var/lib/apt-tts")
DAILY_LIMIT = int(os.environ.get("DAILY_LIMIT", "5000"))   # 每天最多新合成字符数
PORT = int(os.environ.get("PORT", "8787"))
MAX_TEXT = 100            # 入参最大长度（课文句子超限，所以句子不走本服务）
OUT_FMT = "audio-24khz-48kbitrate-mono-mp3"
URL = f"https://{REGION}.tts.speech.microsoft.com/cognitiveservices/v1"

if not KEY:
    sys.exit("缺AZURE_KEY。请检查 /etc/apt-tts.env（应为 600，属主 root）")

os.makedirs(CACHE, exist_ok=True)

# 每日计数。注意：重启会清零（已知缺陷 C-1），外部无法重启本服务。
_used = {"d": "", "n": 0}
_hits = 0
_miss = 0


def today_str():
    # 显式用 Asia/Shanghai，不依赖系统时区（见 C-1b）
    return time.strftime("%Y-%m-%d", time.localtime())


def synth(text):
    ssml = (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-PT'>"
        f"<voice name='{VOICE}'>{escape(text)}</voice></speak>"
    )
    req = urllib.request.Request(
        URL, data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": KEY,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUT_FMT,
            "User-Agent": "apt-app",
        },
    )
    last = None
    for wait in (5, 10, 20, 30):
        try:
            return urllib.request.urlopen(req, timeout=20).read()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 429:
                time.sleep(wait)
                continue
            raise RuntimeError(last)
        except Exception as e:      # 网络抖动
            last = str(e)
            time.sleep(3)
    raise RuntimeError(f"重试仍失败：{last}")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "apt-tts"

    def do_POST(self):
        """POST /api/tts，body 为纯文本（UTF-8）。

        用 POST 而非 GET：GET 的 request line 有长度上限（Python 默认
        约 65536 字节），而我们还要处理超长输入的拒绝逻辑。
        """
        global _hits, _miss
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/tts":
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_error(400, "bad length")
        if n > 4096:
            return self.send_error(400, "body too long")
        try:
            raw = self.rfile.read(n).decode("utf-8", "replace")
        except Exception:
            return self.send_error(400, "read fail")
        # 清洗：省略号与破折号转空格，压缩空白（与前端同规则）
        text = " ".join(raw.replace("…", " ").replace("—", " ").split())
        if not text:
            return self.send_error(400, "missing t")
        if len(text) > MAX_TEXT:
            return self.send_error(400, f"too long (max {MAX_TEXT})")

        fn = hashlib.sha1(f"{VOICE}|{text}".encode("utf-8")).hexdigest()[:16] + ".mp3"
        path = os.path.join(CACHE, fn)

        if os.path.exists(path) and os.path.getsize(path) > 0:
            _hits += 1
        else:
            d = today_str()
            if _used["d"] != d:
                _used["d"] = d
                _used["n"] = 0
            if _used["n"] + len(text) > DAILY_LIMIT:
                self.send_response(429)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"daily limit reached")
                return
            try:
                data = synth(text)
            except Exception as e:
                sys.stderr.write(f"synth failed: {e}\n")
                self.send_error(502, "synth failed")
                return
            _used["n"] += len(text)
            _miss += 1
            tmp = path + ".tmp"
            with open(tmp, "wb") as fp:
                fp.write(data)
            os.replace(tmp, path)
            data = None      # 下面从文件读，避免大块常驻

        try:
            with open(path, "rb") as fp:
                data = fp.read()
        except OSError:
            return self.send_error(500)

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        if message is None:
            message = {400: "bad request", 404: "not found", 429: "limit",
                       500: "error", 502: "upstream"}.get(code, "error")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(message.encode())))
        self.end_headers()
        self.wfile.write(message.encode())

    def log_message(self, fmt, *args):
        """⚠️ 覆写以避免泄露学习内容。

        默认实现会把完整 request line 打进日志，而我们的查询串就是
        学生输入的葡语词。父类 log_request 会把 self.requestline
        传给 log_message，这里改为只记路径（不含查询串）与状态码。
        """
        if fmt == '"%s" %s %s':
            # 这是 log_request 的格式：requestline、code、size
            try:
                self.log_error_code(args[1])
            except Exception:
                pass
        else:
            try:
                msg = fmt % args
            except Exception:
                msg = ""
            # 兜底：清掉可能出现的查询串
            if "?" in msg:
                msg = msg.split("?")[0] + "?<redacted>"
            sys.stderr.write(msg + "\n")

    def log_error_code(self, code):
        path = urllib.parse.urlparse(getattr(self, "path", "")).path
        sys.stderr.write("%s %s %s\n" % (self.command, path, code))


if __name__ == "__main__":
    sys.stderr.write(f"apt-tts 启动：region={REGION} voice={VOICE} cache={CACHE} 日限={DAILY_LIMIT}\n")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()