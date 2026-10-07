#!/usr/bin/env python3
"""dev_server.py —— 本地开发/测试用：一份服务同时提供 site/ 静态站与同步 API。

为什么要它：`python3 -m http.server` 只发静态文件，测不了同步；而把同步服务
单独跑在另一个端口，前端又得跨域。这里把两者拼在一个端口上，于是
浏览器里的端到端测试（tools/test_render.mjs 场景 17）可以真的走
「A 设备上传 → B 设备拉取 → 合并」这条链路。

**只用于本地**：没有 HTTPS，也没有 Caddy 的 request_body 限制。
线上是 Caddy 反代 /api/sync → 127.0.0.1:8788。

用法：
    python3 tools/dev_server.py            # http://127.0.0.1:8130
    python3 tools/dev_server.py 9000 /tmp/apt-dev-state
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8130
state = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, '.dev-sync-state')

os.environ['STATE_DIRECTORY'] = state
os.environ['PORT'] = str(port)
os.makedirs(state, exist_ok=True)

sys.path.insert(0, os.path.join(ROOT, 'server'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import sync_proxy as SP                       # noqa: E402
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer   # noqa: E402

SITE = os.path.join(ROOT, 'site')


class DevHandler(SP.H, SimpleHTTPRequestHandler):
    """/api/* 交给同步服务的处理器，其余走静态文件。"""

    def do_GET(self):
        if self.path.startswith('/api/') or self.path == '/healthz':
            return SP.H.do_GET(self)
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_PUT(self):
        if self.path.startswith('/api/'):
            return SP.H.do_PUT(self)
        self.send_error(405, 'method not allowed')

    def do_HEAD(self):
        return SimpleHTTPRequestHandler.do_HEAD(self)

    def log_request(self, code='-', size='-'):
        # 静态请求不刷屏；/api 的仍然按同步服务的隐私规则记
        if self.path.startswith('/api/') or self.path == '/healthz':
            return SP.H.log_request(self, code, size)

    def log_message(self, fmt, *args):
        return

    def translate_path(self, path):
        # 静态根固定在 site/
        p = SimpleHTTPRequestHandler.translate_path(self, path)
        rel = os.path.relpath(p, os.getcwd())
        return os.path.join(SITE, rel)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    os.chdir(SITE)
    SP.db()
    srv = Server(('127.0.0.1', port), DevHandler)
    sys.stderr.write(f'dev_server 启动：http://127.0.0.1:{port}/  静态={SITE}  同步状态={state}\n')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
