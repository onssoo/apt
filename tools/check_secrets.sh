#!/bin/sh
# check_secrets.sh —— 提交前扫描密钥泄漏。
# 用法：作为 git pre-commit 钩子运行，或手动 `sh tools/check_secrets.sh`
# 规则来自 CONTRACT 13.1：密钥不进前端、不入仓库。
# 退出码：0 = 干净；1 = 命中，拒绝提交。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

# 只扫会被提交的内容：工作区文件 + 暂存区新增行
TARGETS="site tools server docs .env.example deploy.sh"

# 高危模式。分两类，避免误报：
#  A) 显式赋值/携带真值：AZURE_KEY=<40+字符>、头名后面跟着长串、真值片段
#  B) 通用高熵串：40+ 位十六进制、43+ 位base64/url-safe（Azure key 正是 86 字符 base64url）
# 注意：代码里写 "Ocp-Apim-Subscription-Key": self.key 是**头名 + 变量**，
#  不是凭据，因此A 类要求赋值号或冒号后紧跟长串，不匹配单纯的头名出现。
PATTERNS='(AZURE_KEY|SPEECH_KEY|API_KEY|SECRET)[[:space:]]*[=:][[:space:]]*['"'"'"]?[A-Za-z0-9_.-]{20,}|Ocp-Apim-Subscription-Key[[:space:]]*['"'"'"]?[[:space:]]*:[[:space:]]*['"'"'"]?[A-Za-z0-9]{20,}|api\.cognitive\.microsoft\.com/[a-z0-9-]+\.key|[A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{43,}'

FOUND=0

# 排除项：
#  - check_secrets.sh 自身（模式串定义）
#  - ^docs/（文档里的头名与示例是说明文字）
#  - env.example（只有变量名）
#  - iOS 音频解锁用的常量 base64：以 UklGR 开头，是 RIFF/WAV 文件头，不是凭据。
#    静音音频从 1 帧换成 0.1 秒真实数据后，base64 变长（约 2 KB），会撞上
#    43+ 位 base64 的通用规则，因此按前缀整体排除。
EXCLUDE='check_secrets\.sh|env\.example|^docs/|data:audio/wav;base64,UklGR'
# 注：AZURE_KEY 的真值只允许出现在 .env（已 gitignore）与 VPS 的 /etc/apt-tts.env。

echo "check_secrets: 扫描 ${TARGETS} ..."
HITS=$(grep -rInE "$PATTERNS" $TARGETS 2>/dev/null | grep -vE "$EXCLUDE" || true)
if [ -n "$HITS" ]; then
	echo "$HITS"
	FOUND=1
fi

# 暂存区里逐行查（能抓到已 git add 但工作区已改干净的情况）
# 逐文件处理：先拿文件名，再只对该文件的新增行套用模式与排除规则。
# 这样能正确处理 "+++ b/路径" 这种自引用行（内容行不带文件名）。
if git diff --cached --name-only 2>/dev/null | grep -q .; then
	git diff --cached --name-only 2>/dev/null | while read -r f; do
		case "$f" in
			tools/check_secrets.sh) continue ;;   # 自身
			docs/*|.env.example) continue ;;       # 说明文字
		esac
		# 该文件新增行中命中模式、且不在排除白名单里的
		git diff --cached -U0 -- "$f" 2>/dev/null \
			| grep -E '^\+' \
			| grep -vE '^\+\+\+' \
			| grep -E "$PATTERNS" \
			| grep -vE "$EXCLUDE" \
			| grep -vE 'UklGRiQAAABXQVZFZm10IB' \
			| sed "s|^|[暂存区 $f] |"
	done > "$ROOT/.secrets_staged" || true
	if [ -s "$ROOT/.secrets_staged" ]; then
		cat "$ROOT/.secrets_staged"
		FOUND=1
	fi
	rm -f "$ROOT/.secrets_staged"
fi

# .env 必须不存在于索引中
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
	echo "check_secrets: 错误 —— .env 已被 git 跟踪，必须先 git rm --cached .env"
	FOUND=1
fi

if [ "$FOUND" -ne 0 ]; then
	echo ""
	echo "拒绝提交：检测到疑似密钥。"
	echo "真值请写进 .env（已在 .gitignore 中）与 VPS 的 /etc/apt-tts.env。"
	exit 1
fi

echo "check_secrets: 干净"
exit 0