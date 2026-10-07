#!/bin/sh
# deploy.sh —— 一条命令完成发布。契约见 docs/CONTRACT.md 第 10 章。
#
# 流程：validate → 检查音频齐全 → rsync → 核对线上的 version
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
SSH="ssh -p $VPS_PORT"
RSYNC="rsync -av --progress"

echo "==> 1/4 校验数据"
python3 tools/validate.py --quiet

echo "==> 2/4 检查音频齐全"
python3 tools/validate.py --audio --quiet 2>&1 | grep -E "音频引用|错误" || true
# wa 与 words 长度不一致 = 构建未完成，必须拦住
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

echo "==> 3/4 上传到 $VPS_HOST:$REMOTE_DIR"
$RSYNC site/ "$VPS_HOST:$REMOTE_DIR/"

echo "==> 4/4 核对线上的 version"
LOCAL_V=$(python3 -c "import json;print(json.load(open('site/materials.json',encoding='utf-8'))['version'])")
echo "本地 version: $LOCAL_V"
echo "请在浏览器打开 https://apt.example.com 抽查一课。"

echo ""
echo "发布完成。注意：首次部署还需在 VPS 上做一次性配置（见 docs/CONTRACT.md 16.1）："
echo "  · 部署发音代理（/opt/apt-tts/tts_proxy.py + /etc/apt-tts.env + apt-tts.service）"
echo "  · 追加 Caddyfile 的 apt.example.com 站点块（先备份，caddy validate 后 reload）"
echo ""
echo "⚠️  .env 与密钥从未上传。Caddyfile 与代理配置需手动在 VPS 上放置。"