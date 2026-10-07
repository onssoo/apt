#!/bin/sh
# deploy.sh —— 一条命令完成发布。契约见 docs/CONTRACT.md 第 10 章。
#
# 流程：validate → 检查音频齐全 → rsync → 用 curl 核对线上 materials.json 的 version
#
# ⚠️ 绝不使用 --delete：VPS 上还跑着 lababa 与 PostgreSQL，
#    且远端文件只应由 tools/clean_orphans.py 显式清理。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

# 读 .env（不覆盖已有环境变量）
if [ -f .env ]; then
	set -a
	. ./.env
	set +a
fi

VPS_HOST=${VPS:-ubuntu@203.0.113.10}
VPS_PORT=${VPS_SSH_PORT:-2222}
REMOTE_DIR=${REMOTE_DIR:-/var/www/apt}
SITE_HOST=${SITE_HOST:-apt.example.com}
# 守卫：SITE_HOST 还是 .env.example 里的占位符时，curl 会解析失败并抛一段
# Python traceback，看不出真正原因。这里直接说清楚。
case "$SITE_HOST" in
	*example.com)
		echo "❌ SITE_HOST 还是占位符（${SITE_HOST}）。在 .env 里填上真实域名再发布。" >&2
		exit 1
		;;
esac
# 公网 22 被云镜封了，必须走 ${VPS_SSH_PORT}（默认 2222）。
# 这里以前定义了一个 SSH 变量却从没使用，rsync 默认走 22 端口，脚本根本跑不通。
VPS_KEY=${VPS_SSH_KEY:-}
if [ -n "$VPS_KEY" ]; then
	RSYNC_SSH="ssh -p $VPS_PORT -i $VPS_KEY"
else
	RSYNC_SSH="ssh -p $VPS_PORT"
fi

echo "==> 1/5 校验数据"
python3 tools/validate.py --quiet

echo "==> 2/5 检查音频齐全"
# 这里以前写成 `validate.py --audio ... | grep ... || true`，
# 管道把退出码吃掉了，167 个音频全缺也照样发布。必须让它直接把脚本拦停。
python3 tools/validate.py --audio --quiet
python3 - <<'PY'
import json, sys
M = json.load(open("site/materials.json", encoding="utf-8"))
bad = []
for l in M["lessons"]:
    wa = l.get("wa") or []
    tw = len(l.get("words") or [])
    if len(wa) != tw:
        bad.append(f"{l['id']}: wa {len(wa)} != words {tw}")
    if not l.get("sents") and l.get("text"):
        bad.append(f"{l['id']}: 缺 sents")
if bad:
    print("构建未完成：")
    for b in bad:
        print("  " + b)
    print("先跑 python3 tools/build_audio.py")
    sys.exit(1)
print(f"音频齐全：{len(M['lessons'])} 课")
PY

LOCAL_V=$(python3 -c "import json;print(json.load(open('site/materials.json',encoding='utf-8'))['version'])")
echo "本地 version: $LOCAL_V"

echo "==> 3/5 上传到 $VPS_HOST:$REMOTE_DIR"
rsync -av --progress -e "$RSYNC_SSH" site/ "$VPS_HOST:$REMOTE_DIR/"

echo "==> 4/5 核对线上的 version（${SITE_HOST}）"
# 以前这一步只 echo 本地 version 就结束了，根本没有核对。
# 用 --no-cache 绕开 CDN/浏览器缓存，确保读的是刚上传的那份。
REMOTE_V=$(curl -fsS --max-time 20 -H 'Cache-Control: no-cache' \
  "https://$SITE_HOST/materials.json?x=$(date +%s)" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('version'))")
echo "线上 version: $REMOTE_V"
if [ "$REMOTE_V" != "$LOCAL_V" ]; then
	echo "❌ 线上 version（${REMOTE_V}）与本地（${LOCAL_V}）不一致，发布可能没生效。" >&2
	exit 1
fi

echo "==> 5/5 抽查页面与发音代理"
HEAD=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 "https://$SITE_HOST/")
echo "首页 HTTP $HEAD"
if [ "$HEAD" != "200" ]; then
	echo "❌ 首页不是 200" >&2
	exit 1
fi

echo ""
echo "发布完成。请打开 https://$SITE_HOST 抽查一课（真机验证见 docs/acceptance.md）。"
echo ""
echo "⚠️  .env 与密钥从未上传。Caddyfile 与代理配置需手动在 VPS 上放置。"
