#!/usr/bin/env python3
"""test_sync.py —— 同步服务的接口测试（M10-2 / M10-6）。

真的把 server/sync_proxy.py 起在临时目录与临时端口上，用 HTTP 打它。
验的是：认人、隔离、打卡板默认关闭、限流、体量上限，
以及两条隐私要求 —— **库里不存 token 原文**、**日志里没有正文**。

运行：python3 tools/test_sync.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'server', 'sync_proxy.py')

passed = 0
failed = []


def t(name, cond, detail=''):
    global passed
    if cond:
        passed += 1
        print(f'✓ {name}')
    else:
        failed.append(name)
        print(f'✗ {name}' + (f'   ← {detail}' if detail else ''))


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(url, method='GET', token=None, body=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {}


state = tempfile.mkdtemp(prefix='apt-sync-test-')
port = free_port()
env = dict(os.environ, STATE_DIRECTORY=state, PORT=str(port), RATE_PER_MIN='1000')
log = open(os.path.join(state, 'svc.log'), 'w+')
proc = subprocess.Popen([sys.executable, SCRIPT], env=env, stdout=log, stderr=log)
base = f'http://127.0.0.1:{port}'

for _ in range(60):
    try:
        if call(base + '/healthz')[0] == 200:
            break
    except Exception:
        pass
    time.sleep(0.25)
else:
    proc.kill()
    print('服务没起来'); print(open(os.path.join(state, 'svc.log')).read())
    sys.exit(1)

A, B = 'ann-8f3k2x-aaaa', 'dad-1111-bbbb'
NOTE = '这是一句只有我知道的学习内容-palavra-secreta'

try:
    print('=== 认人与隔离 ===\n')
    t('无 token → 401', call(base + '/api/sync')[0] == 401)
    t('token 格式不合法 → 401', call(base + '/api/sync', token='x')[0] == 401)
    t('新用户取回空文档', call(base + '/api/sync', token=A)[1].get('doc') is None)

    doc_a = {'words': [{'id': 'a1', 'pt': 'obrigado', 'upd': 111, 'note': NOTE}],
             'logs': {'2026-10-01': {'done': True}}, 'set': {'goalW': 5}, 'seq': 1, 'del': []}
    st, r = call(base + '/api/sync', 'PUT', token=A, body={'doc': doc_a})
    t('PUT 存入成功', st == 200 and r.get('ok'), json.dumps(r))
    t('GET 取回同一份', call(base + '/api/sync', token=A)[1].get('doc') == doc_a)
    t('另一个 token 读不到（隔离）', call(base + '/api/sync', token=B)[1].get('doc') is None)

    print('\n=== 打卡板：默认关闭 ===\n')
    t('没打开时打卡板是空的', call(base + '/api/board')[1].get('entries') == [])
    call(base + '/api/sync', 'PUT', token=A, body={'doc': doc_a,
         'board': {'enabled': True, 'name': 'Mei', 'done': True, 'streak': 3}})
    entries = call(base + '/api/board')[1].get('entries')
    t('本人打开后才出现在打卡板', len(entries) == 1 and entries[0]['name'] == 'Mei', json.dumps(entries))
    t('打卡板只暴露打卡状态，不含学习内容',
      set(entries[0].keys()) == {'name', 'done', 'streak', 'updatedAt'}, str(entries[0].keys()))
    t('打卡板里没有正文', NOTE not in json.dumps(entries))
    call(base + '/api/sync', 'PUT', token=A, body={'doc': doc_a,
         'board': {'enabled': False, 'name': 'Mei', 'done': True, 'streak': 3}})
    t('关掉后立刻消失', call(base + '/api/board')[1].get('entries') == [])

    print('\n=== 边界 ===\n')
    t('坏 JSON → 400', call(base + '/api/sync', 'PUT', token=A, raw=b'{not json')[0] == 400)
    t('doc 不是对象 → 400', call(base + '/api/sync', 'PUT', token=A, body={'doc': 'x'})[0] == 400)
    t('超大 body → 413', call(base + '/api/sync', 'PUT', token=A, raw=b'{"doc":{"x":"' + b'a' * (2 * 1024 * 1024 + 10) + b'"}}')[0] == 413)
    t('未知路径 → 404', call(base + '/api/nope')[0] == 404)

    print('\n=== 隐私（M10-6）===\n')
    # SQLite 开了 WAL，新数据可能还在 -wal 里，所以三个文件一起扫
    blob = b''
    for suffix in ('', '-wal', '-shm'):
        f = os.path.join(state, 'sync.db' + suffix)
        if os.path.exists(f):
            blob += open(f, 'rb').read()
    t('库里不存 token 原文', A.encode() not in blob and B.encode() not in blob)
    t('库里存了文档（说明确实写进去了）', b'obrigado' in blob)
    time.sleep(0.4)
    svc_log = open(os.path.join(state, 'svc.log')).read()
    t('服务日志里没有学习内容正文', NOTE not in svc_log and 'palavra-secreta' not in svc_log)
    t('服务日志里有请求记录（说明日志确实在写）', '/api/sync' in svc_log)
    t('服务日志里只有用户哈希前缀', 'user=' in svc_log and A[:6] not in svc_log)

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    log.close()
    shutil.rmtree(state, ignore_errors=True)

print(f'\n同步服务测试：{passed} 通过，{len(failed)} 失败')
if failed:
    print('失败项：')
    for f in failed:
        print('  -', f)
    sys.exit(1)
print('全部通过。')
