#!/usr/bin/env python3
"""build_audio.py —— 读 site/materials.json，按句与生词生成 Azure pt-PT 音频。

设计要点（docs/CONTRACT.md 第 10 章）：
- **幂等**：文件已存在即跳过，不消耗额度。同一句重复跑不会二次计费。
- **命名**：sha1(声音|归一化文本) 前16 位十六进制 + .mp3
- **对话双音色**：以破折号（em dash）开头的行，两个声音交替
- **保留 sents[].zh**：作者提供的逐句翻译原样保留，构建脚本不改
- **原子写**：先写 .tmp 再 os.replace，避免半文件
- **仅标准库**

用法：
    python3 tools/build_audio.py            # 全量（已存在的跳过）
    python3 tools/build_audio.py --limit 1  # 只处理第一篇，调试用
    python3 tools/build_audio.py --slow    # 额外生成 sents[].s 慢速版
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
MATERIALS = os.path.join(SITE, "materials.json")
OUT = os.path.join(SITE, "audio")

SPEECH_HOST = "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
OUTPUT_FMT = "audio-24khz-48kbitrate-mono-mp3"

# 免费层限速后重试的等待秒数
BACKOFF = (10, 20, 30, 45, 60)
INTER_SYNTH_GAP = 1.0   # 每条之间至少间隔 1 秒，避免触发限速


# ---------- 环境 ----------

def load_env():
    """从仓库根的 .env 读配置。已存在的环境变量优先，不覆盖。"""
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if v and k not in os.environ:
                os.environ[k] = v


# ---------- 文本归一化 ----------

def norm(text):
    """送入 TTS 前的归一化：省略号转空格，压缩连续空白。
    不改变大小写与变音符号。"""
    text = text.replace("…", " ").replace("–", " ").replace("—", " ")
    return re.sub(r"\s+", " ", text).strip()


def say(text):
    """朗读文本：剥离行首破折号（对话标记），避免被读出来。"""
    return re.sub(r"^[—–\-]\s*", "", text).strip()


def digest(voice, text):
    """音频文件名：sha1(声音|归一化文本) 前 16 位。"""
    return hashlib.sha1(f"{voice}|{norm(text)}".encode("utf-8")).hexdigest()[:16]


# ---------- 合成 ----------

class TTS:
    def __init__(self, key, region, timeout=30):
        self.key = key
        self.url = SPEECH_HOST.format(region=region)
        self.timeout = timeout
        self.made = 0          # 本次新合成条数
        self.reused = 0# 命中缓存条数
        self.chars = 0         # 本次消耗字符数（对账 Azure 用量）

    def path_for(self, voice, text):
        return os.path.join(OUT, f"{digest(voice, text)}.mp3")

    def synth(self, text, voice):
        """返回 'audio/xxx.mp3'。文件已存在则复用。"""
        text = norm(text)
        if not text:
            return None
        name = f"{digest(voice, text)}.mp3"
        dest = os.path.join(OUT, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            self.reused += 1
            return f"audio/{name}"

        ssml = (
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-PT'>"
            f"<voice name='{voice}'>{escape(text)}</voice></speak>"
        )
        req = urllib.request.Request(
            self.url,
            data=ssml.encode("utf-8"),
            headers={
                "Ocp-Apim-Subscription-Key": self.key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": OUTPUT_FMT,
                "User-Agent": "apt-app",
            },
        )
        last_err = None
        for wait in BACKOFF:
            try:
                data = urllib.request.urlopen(req, timeout=self.timeout).read()
                break
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                if e.code == 429:
                    print(f"    限速，等待 {wait}s 后重试（{text[:40]}...）", file=sys.stderr)
                    time.sleep(wait)
                    continue
                body = e.read()[:200].decode("utf-8", "replace")
                raise SystemExit(
                    f"\nAzure 返回 {e.code}（{last_err}）：{body}\n"
                    f"检查 AZURE_KEY 与 AZURE_REGION 是否属于同一资源。"
                )
            except Exception as e:
                last_err = str(e)
                time.sleep(5)
        else:
            raise SystemExit(f"\n多次重试仍失败：{last_err}")

        tmp = dest + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(data)
        os.replace(tmp, dest)

        self.made += 1
        self.chars += len(text)
        time.sleep(INTER_SYNTH_GAP)
        return f"audio/{name}"

    def synth_slow(self, text, voice):
        """慢速版（0.75x 等效）。用 SSML prosody 直接降速，音质优于放慢播放。"""
        text = norm(text)
        if not text:
            return None
        name = f"{digest(voice, text)}_s.mp3"
        dest = os.path.join(OUT, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            self.reused += 1
            return f"audio/{name}"
        ssml = (
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-PT'>"
            f"<voice name='{voice}'><prosody rate='-25%'>{escape(text)}</prosody></voice></speak>"
        )
        req = urllib.request.Request(
            self.url, data=ssml.encode("utf-8"),
            headers={
                "Ocp-Apim-Subscription-Key": self.key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": OUTPUT_FMT,
                "User-Agent": "apt-app",
            },
        )
        try:
            data = urllib.request.urlopen(req, timeout=self.timeout).read()
        except Exception as e:
            print(f"    慢速版失败（忽略）：{e}", file=sys.stderr)
            return None
        tmp = dest + ".tmp"
        with open(tmp, "wb") as fp:
            fp.write(data)
        os.replace(tmp, dest)
        self.made += 1
        self.chars += len(text)
        return f"audio/{name}"


# ---------- 切句 ----------

SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text, voice_main, voice_second):
    """按换行分段，再按句末标点切句。

    返回 [{t: 原文, p: 段落序号, zh: 该句翻译(可选), speaker: 角色}]
    以 em dash 开头的行视为对话行，两个声音交替。
    """
    out = []
    dlg = 0
    for pidx, para in enumerate(text.split("\n")):
        para = para.strip()
        if not para:
            continue
        speaker = "main"
        if para.startswith("—"):
            speaker = "second" if dlg % 2 else "main"
            dlg += 1
        for s in SENT_SPLIT.split(para):
            if s.strip():
                out.append({"t": s.strip(), "p": pidx, "speaker": speaker})
    return out


def attach_tr(sents, lesson):
    """把作者提供的逐句英/中翻译挂到 sents 上。

    三种来源（按优先级）：
    1. 作者直接在 sents[].en / sents[].zh 里写了 —— 原样保留
    2. 作者提供了 trans_lines 数组，每项 {en?, zh?}，或en_lines + zh_lines —— 按顺序贴
    3. 都没有 —— 留空，前端退回整篇翻译

    新格式（M6）要求逐句英中都有；旧课文只有中文时只贴 zh，不报错。
    """
    # 来源 1：已构建过且带翻译
    if any(sn.get("zh") or sn.get("en") for sn in sents):
        has_en = all(sn.get("en") for sn in sents)
        has_zh = all(sn.get("zh") for sn in sents)
        if has_en and has_zh:
            return "sents[].en + sents[].zh"
        if has_zh:
            return "sents[].zh（缺英文）"
        return "sents[].en（缺中文）"

    # 来源 2：trans_lines [{en?, zh?}] 或 en_lines + zh_lines
    tl = lesson.get("trans_lines")
    en_lines = lesson.get("en_lines")
    zh_lines = lesson.get("zh_lines")   # 旧格式：纯中文数组

    if isinstance(tl, list) and tl:
        if len(tl) != len(sents):
            print(
                f"    [错误] {lesson.get('id')} trans_lines 有 {len(tl)} 项，"
                f"但正文切出 {len(sents)} 句。逐句翻译须与句数一一对应。",
                file=sys.stderr,
            )
            return None
        for sn, item in zip(sents, tl):
            if isinstance(item, dict):
                sn["en"] = (item.get("en") or "").strip()
                sn["zh"] = (item.get("zh") or "").strip()
        return f"trans_lines（{len(tl)} 句）"

    # en_lines + zh_lines（旧格式兼容）
    if isinstance(en_lines, list) or isinstance(zh_lines, list):
        en = en_lines if isinstance(en_lines, list) else []
        zh = zh_lines if isinstance(zh_lines, list) else []
        n = max(len(en), len(zh))
        if n and n != len(sents):
            print(
                f"    [错误] {lesson.get('id')} en_lines/zh_lines 长度"
                f"（{len(en)}/{len(zh)}）与句数 {len(sents)} 不一致。",
                file=sys.stderr,
            )
            return None
        for i, sn in enumerate(sents):
            if i < len(en):
                sn["en"] = en[i].strip()
            if i < len(zh):
                sn["zh"] = zh[i].strip()
        note = []
        if en:
            note.append(f"en_lines（{len(en)}）")
        if zh:
            note.append(f"zh_lines（{len(zh)}）")
        return " + ".join(note)

    return None


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 篇，0 = 全部")
    ap.add_argument("--slow", action="store_true", help="额外生成 sents[].s 慢速版")
    ap.add_argument("--skip-validate", action="store_true", help="跳过校验（调试用）")
    args = ap.parse_args()

    load_env()
    key = os.environ.get("AZURE_KEY")
    region = os.environ.get("AZURE_REGION")
    if not key or not region:
        raise SystemExit("缺 AZURE_KEY 或 AZURE_REGION。先 cp .env.example .env 并填入。")
    voice_main = os.environ.get("VOICE", "pt-PT-RaquelNeural")
    voice_voice2 = os.environ.get("VOICE2", "pt-PT-DuarteNeural")
    slow = args.slow or os.environ.get("SLOW_AUDIO") == "1"

    os.makedirs(OUT, exist_ok=True)

    if not args.skip_validate:
        import subprocess
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "tools", "validate.py"), "--quiet"],
            cwd=ROOT,
        )
        if r.returncode != 0:
            raise SystemExit("校验未通过，先修好 materials.json 再合成（--skip-validate 可跳过）。")

    tts = TTS(key, region)
    data = json.load(open(MATERIALS, encoding="utf-8"))
    lessons = data["lessons"]
    if args.limit:
        lessons = lessons[: args.limit]

    print(f"音色：{voice_main}（对话第二角色 {voice_voice2}）")
    print(f"输出：{OUT}")
    print(f"课文{len(lessons)} 篇\n")

    for l in lessons:
        lid = l.get("id", "?")
        # 构建句子并挂音频
        sents = split_sentences(l["text"], voice_main, voice_voice2)
        zh_note = attach_tr(sents, l)

        for sn in sents:
            v = voice_voice2 if sn["speaker"] == "second" else voice_main
            sn["a"] = tts.synth(say(sn["t"]), v)
            if slow:
                sn["s"] = tts.synth_slow(say(sn["t"]), v)

        # 生词音频，长度须与 words 一致。兼容数组与对象两种写法（M6-1）。
        words = l.get("words") or []
        wa = []
        for w in words:
            pt = w[0] if isinstance(w, (list, tuple)) else (w.get("pt") or "")
            wa.append(tts.synth(pt, voice_main) if pt else None)

        # 就地挂回原对象（out_l 是副本，写它没用）
        l["sents"] = sents
        l["wa"] = wa
        if len(wa) != len(words):
            print(f"    [警告] {lid} 生词音频 {len(wa)} 条与生词 {len(words)} 条不一致")

        note = f"，{zh_note}" if zh_note else ""
        print(f"  {lid} {l.get('title','')}: {len(sents)} 句{note}")

    # 写回 materials.json：只替换 sents 与 wa，作者其他字段原样保留。
    # 注意 --limit 时只处理了前 N 篇，其余课文必须原样带回，不能丢。
    raw = json.load(open(MATERIALS, encoding="utf-8"))
    built = {l["id"]: l for l in lessons}
    for orig in raw["lessons"]:
        lid = orig.get("id")
        if lid in built:
            orig["sents"] = built[lid]["sents"]
            orig["wa"] = built[lid]["wa"]
    json.dump(raw, open(MATERIALS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"\n本次新合成 {tts.made} 条，复用 {tts.reused} 条")
    print(f"本次消耗字符约 {tts.chars}（对账 Azure 门户「指标」页）")
    print("materials.json 已更新（sents 与 wa）。")


if __name__ == "__main__":
    main()