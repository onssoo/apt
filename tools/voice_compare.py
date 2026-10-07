#!/usr/bin/env python3
"""voice_compare.py —— 生成音色盲听对比页（M1-3）。

用途：让她与老师盲听，挑出最像课堂上的那个声音。
做法：3 个 pt-PT 声音 × 2 段文本（一段叙述、一段对话），
     随机编号为 A / B / C，**页面不显示声音名**。
     答案写到 reports/compare_key.txt（不发布）。

用法：
    python3 tools/voice_compare.py
    python3 tools/voice_compare.py --repeat 2   # 每段文本生成 2 个声音做一致性检查
"""
import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
OUT = os.path.join(SITE, "audio")
COMPARE = os.path.join(SITE, "compare")
REPORTS = os.path.join(ROOT, "reports")

VOICES = [
    ("A", "pt-PT-RaquelNeural"),      # 女
    ("B", "pt-PT-DuarteNeural"),      # 男
    ("C", "pt-PT-FernandaNeural"),   # 女
]

# 两段试听文本：一段叙述（模拟课文旁白），一段对话（模拟L07 那种市场场景）
NARRATION = "Olá! Chamo-me Mei e tenho dezoito anos. Sou chinesa, de Zhuhai. Agora vivo em Macau, porque estudo Português na Universidade de Macau. O Português é uma língua bonita, mas um pouco difícil."

DIALOGUE = "— Bom dia! Queria um quilo de laranjas, se faz favor. — Com certeza. Mais alguma coisa? — Sim. Quanto custam estas mangas? — Trinta patacas o quilo. Estão muito doces!"

SAMPLES = [
    {"id": "narr", "label": "第一段（叙述）", "text": NARRATION},
    {"id": "dlg", "label": "第二段（对话）", "text": DIALOGUE},
]

OUT_FMT = "audio-24khz-48kbitrate-mono-mp3"


def load_env():
    p = os.path.join(ROOT, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if v.strip() and k not in os.environ:
                os.environ[k] = v.strip()


def norm(t):
    return re.sub(r"\s+", " ", t.replace("…", " ")).strip()


def synth(text, voice, key, region):
    """按散列命名生成音频；已存在则复用。"""
    name = hashlib.sha1(f"{voice}|{norm(text)}".encode()).hexdigest()[:16] + ".mp3"
    dest = os.path.join(OUT, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return name, 0
    # 对话行剥掉破折号，避免被读出来
    spoken = re.sub(r"^[—–-]\s*", "", text)
    ssml = (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-PT'>"
        f"<voice name='{voice}'>{escape(norm(spoken))}</voice></speak>"
    )
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUT_FMT,
            "User-Agent": "apt-app",
        },
    )
    for wait in (5, 10, 20, 30, 45):
        try:
            data = urllib.request.urlopen(req, timeout=30).read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f"    限速，等 {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise SystemExit(f"Azure 返回 {e.code}：{e.read()[:200]}")
    else:
        raise SystemExit("多次限速，稍后再试")
    with open(dest + ".tmp", "wb") as fp:
        fp.write(data)
    os.replace(dest + ".tmp", dest)
    time.sleep(1.0)
    return name, len(norm(spoken))


HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>音色盲听 · APT</title>
<style>
:root{--c:#00843D;--bg:#f6f7f9;--card:#fff;--t:#222;--mu:#888}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1c1c1e;--t:#eee;--mu:#999}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--t);
 padding:env(safe-area-inset-top) 0 calc(24px + env(safe-area-inset-bottom))}
main{max-width:640px;margin:auto;padding:16px}
h1{font-size:20px;margin:4px 0 8px}
h2{font-size:17px;margin:0 0 12px}
.card{background:var(--card);border-radius:14px;padding:16px;margin-bottom:14px}
.mu{color:var(--mu);font-size:14px;line-height:1.6}
.txt{font-size:17px;line-height:1.7;margin:12px 0}
button{font-size:16px;padding:12px 18px;border:0;border-radius:10px;background:var(--c);color:#fff;
 min-height:44px;margin:4px 6px 4px 0}
.g{background:#8882;color:var(--t)}
.ans{font-size:17px;padding:14px;border:2px solid var(--c);border-radius:10px;display:none;margin-top:12px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sel{background:var(--c)!important;color:#fff!important}
</style>
</head>
<body>
<main>
 <h1>音色盲听</h1>
 <p class="mu">每段文本有 3 个声音，编号 A / B / C。<b>它们不按顺序排列</b>。
 听完两段后选出<b>整体最自然、最像课堂上的</b>那个编号。
 建议和老师一起听，告诉她这是在选上课时的听力口音。</p>

 %(sections)s

 <div class="card">
  <h2>你的选择</h2>
  <p class="mu">第一段选：<span id="s1">—</span>　第二段选：<span id="s2">—</span></p>
  <p class="mu">两个都选同一个的话，说明声音很接近，可以再对比第三段。</p>
  <div id="final" class="ans">
   <b>记下了：<span id="finalPick">—</span></b><br>
   <span class="mu">告诉家长这个编号即可，不要改reports 里的文件。</span>
  </div>
 </div>

 <div class="card">
  <p class="mu" style="margin:0">听不出来很正常。可以多听几遍，
  尤其注意词尾的 s 怎么读、元音怎么弱化——这是欧葡和巴葡最明显的区别。</p>
 </div>
</main>
<script>
const picks = {};
function pick(seg, id, btn){
  picks[seg] = id;
  document.getElementById('s' + seg.slice(-1)).textContent = id;
  // 同段内高亮
  document.querySelectorAll('[data-seg="' + seg + '"]').forEach(b => b.classList.remove('sel'));
  document.querySelectorAll('[data-seg="' + seg + '"][data-id="' + id + '"]').forEach(b => b.classList.add('sel'));
  if (picks.n && picks.d) {
    const f = document.getElementById('final');
    f.style.display = 'block';
    document.getElementById('finalPick').textContent =
      (picks.n === picks.d ? picks.n : picks.n + '（叙述）/ ' + picks.d + '（对话）');
  }
}
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0, help="随机种子；固定则编号可复现")
    args = ap.parse_args()

    load_env()
    key = os.environ.get("AZURE_KEY") or os.environ.get("AZURE_SPEECH_KEY")
    region = os.environ.get("AZURE_REGION") or os.environ.get("AZURE_SPEECH_REGION") or "eastus"
    if not key:
        raise SystemExit("缺AZURE_KEY。先 cp .env.example .env 并填入。")

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(COMPARE, exist_ok=True)
    os.makedirs(REPORTS, exist_ok=True)

    rng = random.Random(args.seed) if args.seed else random.SystemRandom()
    # 编号与声音的映射（随机）
    order = list(VOICES)
    rng.shuffle(order)
    print("编号映射（仅本地保存，页面不显示）：")
    for letter, voice in order:
        print(f"  {letter} = {voice}")

    made = 0
    chars = 0
    sections = []
    keymap = {"voice_map": {l: v for l, v in order}, "samples": {}}

    for s in SAMPLES:
        rows = []
        for letter, voice in order:
            name, n = synth(s["text"], voice, key, region)
            made += 1
            chars += n
            rows.append(
                f'<button class="g" data-seg="{s["id"]}" data-id="{letter}" '
                f'onclick="play(this.dataset.seg,this.dataset.id);'
                f'pick(this.dataset.seg,this.dataset.id,this)">▶ 播放 {letter}</button>'
            )
            keymap["samples"].setdefault(s["id"], {})[letter] = {
                "voice": voice,
                "audio": f"../audio/{name}",
            }
        sections.append(
            f'<div class="card"><h2>{s["label"]}</h2>'
            f'<div class="txt">{escape(s["text"]).replace(chr(10), "<br>")}</div>'
            f'<div class="row">{"".join(rows)}</div></div>'
        )
        print(f"  {s['label']}: 3 个声音就绪")

    # 页面需要知道音频路径与编号对应（不含声音名）
    payload = json.dumps(
        {s["id"]: {l: keymap["samples"][s["id"]][l]["audio"] for l in "ABC"} for s in SAMPLES},
        ensure_ascii=False,
    )
    html = HTML % {"sections": "\n".join(sections)}
    html = html.replace(
        "<script>\nconst picks",
        f"<script>\nconst AUDIO = {payload};\nconst picks",
    )
    # 播放函数用 Audio 对象
    html = html.replace(
        "const picks = {};",
        """const picks = {};
let cur = null;
function play(seg, id){
  if (cur) { cur.pause(); cur = null; }
  const f = (AUDIO[seg] || {})[id];
  if (!f) return;
  cur = new Audio(f);
  cur.play().catch(() => alert('播放失败，请再点一次'));
}""",
    )
    out_html = os.path.join(COMPARE, "index.html")
    io_write(out_html, html)

    # 答案文件（不发布）
    keymap["generated"] = time.strftime("%Y-%m-%d %H:%M")
    keymap["note"] = "页面不显示声音名。选定后把对应 voice 填进 .env 的 VOICE，重跑 build_audio.py。"
    out_key = os.path.join(REPORTS, "compare_key.txt")
    io_write(out_key, json.dumps(keymap, ensure_ascii=False, indent=2))

    print(f"\n✓ 对比页: {out_html}")
    print(f"✓ 答案:   {out_key}（不发布）")
    print(f"本次新合成 {made} 条，消耗字符约 {chars}")
    print("\n下一步：把 index.html 发给她与老师盲听，问出编号后改 .env 的 VOICE，重跑 build_audio.py。")


def io_write(path, text):
    with open(path, "w", encoding="utf-8") as fp:
        fp.write(text)


if __name__ == "__main__":
    main()