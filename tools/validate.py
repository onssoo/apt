#!/usr/bin/env python3
"""validate.py —— 校验 site/materials.json 与 site/audio 的一致性。

实现 docs/CONTRACT.md 第 6 章（材料数据契约）的全部校验，另加 id 格式与
JSON 语法检查。出错时退出码非 0，并逐条给出课文 id 与字段。

用法：
    python3 tools/validate.py            # 只校验结构与引用
    python3 tools/validate.py --audio    # 额外校验音频文件是否齐全
    python3 tools/validate.py --quiet    # 只在出错时输出
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATERIALS = os.path.join(ROOT, "site", "materials.json")
AUDIO_DIR = os.path.join(ROOT, "site", "audio")

LESSON_ID_RE = re.compile(r"^L\d{2,}$")
LEVELS = ("A1", "A2", "B1", "B2")

# 假朋友白名单（M8）：ff 只能来自这里。Agent 不手写 ff，
# 由 tools/merge_lesson.py 按 pt 自动补；validate 在这里把关。
FF_LIST_PATH = os.path.join(ROOT, "tools", "ff_list.json")


def load_ff_list():
    try:
        d = json.load(open(FF_LIST_PATH, encoding="utf-8"))
        return {k.strip().lower(): v for k, v in (d.get("words") or {}).items()}
    except Exception as e:
        print(f"[警告] 读不到 tools/ff_list.json（{e}），假朋友白名单校验跳过", file=sys.stderr)
        return {}


FF_LIST = load_ff_list()


# ---------- 格式兼容（M6-1） ----------
# 新格式：words 项为对象 {pt, en, zh, ex, ff?}；trans 为对象 {en, zh}
# 旧格式：words 项为数组 [pt, zh, ex?]；trans 为字符串（视为 {zh}）
# 下面三个函数把两者归一，校验与渲染都只面向新格式。

def norm_word(w):
    """把一个生词项归一为 dict。兼容数组与对象两种写法。"""
    if isinstance(w, dict):
        out = {
            "pt": (w.get("pt") or "").strip(),
            "en": (w.get("en") or "").strip(),
            "zh": (w.get("zh") or "").strip(),
            "ex": (w.get("ex") or "").strip(),
        }
        ff = (w.get("ff") or "").strip()
        if ff:
            out["ff"] = ff
        return out
    if isinstance(w, (list, tuple)):
        # 旧格式 [pt, zh, ex?]
        return {
            "pt": str(w[0]).strip() if len(w) > 0 else "",
            "en": "",
            "zh": str(w[1]).strip() if len(w) > 1 else "",
            "ex": str(w[2]).strip() if len(w) > 2 else "",
        }
    return {"pt": "", "en": "", "zh": "", "ex": ""}


def norm_trans(t):
    """把trans 归一为 {en, zh}。字符串视为中文。"""
    if isinstance(t, dict):
        return {
            "en": str(t.get("en") or "").strip(),
            "zh": str(t.get("zh") or "").strip(),
        }
    if isinstance(t, str):
        return {"en": "", "zh": t.strip()}
    return {"en": "", "zh": ""}


# ---------- 欧葡纯度：巴葡用法黑名单（review 2026-10-07 M9 第 1 条） ----------
# AI 生成葡语时最常见的错误是混入巴葡。这里只扫**葡语字段**：
# text / sents[].t / words[].pt / words[].ex / qs。en、zh、note、ff 不扫 ——
# 那些地方本来就会写「巴西说 ônibus」做对照，扫了全是误报。

BR_PATTERNS = [
    (re.compile(r"\bônibus\b", re.I), "巴士：欧葡用 autocarro"),
    (re.compile(r"\btrem\b", re.I), "火车：欧葡用 comboio"),
    (re.compile(r"\bcelular\b", re.I), "手机：欧葡用 telemóvel"),
    (re.compile(r"\bcafé da manhã\b", re.I), "早餐：欧葡用 pequeno-almoço"),
    (re.compile(r"\bgeladeira\b", re.I), "冰箱：欧葡用 frigorífico"),
    (re.compile(r"\bbanheiro\b", re.I), "浴室：欧葡用 casa de banho（欧葡 banheiro 指浴室，不是厕所）"),
    (re.compile(r"\bgarçom\b", re.I), "侍者：欧葡用 empregado de mesa"),
    (re.compile(r"\b(estou|está|estamos|estão|estás|estava)\s+\w+ndo\b", re.I),
     "进行时：欧葡用 estar a + 不定式（estou a fazer），不用 estou fazendo"),
    (re.compile(r"\bvocê\b", re.I), "você：欧葡口语少用，常说 o senhor / a senhora 或省略主语"),
    (re.compile(r"\blegal\b", re.I), "legal：表示「好、酷」是巴葡；欧葡 legal 是「合法的」"),
]


def check_brazilian(iss, tag, l):
    """扫葡语正文里的巴葡用法，只提醒不阻断。"""
    chunks = [("text", str(l.get("text") or ""))]
    for i, sn in enumerate(l.get("sents") or []):
        if isinstance(sn, dict):
            chunks.append((f"sents[{i}].t", str(sn.get("t") or "")))
    for i, w in enumerate(l.get("words") or []):
        nw = norm_word(w)
        chunks.append((f"words[{i}].pt", nw["pt"]))
        if nw["ex"]:
            chunks.append((f"words[{i}].ex", nw["ex"]))
    for i, q in enumerate(l.get("qs") or []):
        if isinstance(q, list):
            for j, part in enumerate(q):
                chunks.append((f"qs[{i}][{j}]", str(part)))

    seen = set()
    for where, text in chunks:
        for rx, why in BR_PATTERNS:
            m = rx.search(text)
            if not m:
                continue
            key = (m.group(0).lower(), why)
            if key in seen:
                continue
            seen.add(key)
            iss.warn(tag, f"{where} 出现巴葡用法 {m.group(0)!r} —— {why}")


def check_sents_alignment(iss, tag, l):
    """sents 作为逐句唯一来源时，同一段的句子拼起来必须与 text 的段落逐字一致。

    这是句子拆分与正文对齐的唯一保证：拆错一个标点，这里就报错。
    """
    sents = l.get("sents")
    if not isinstance(sents, list) or not sents:
        return
    paras = str(l.get("text") or "").split("\n")
    groups = {}
    for i, sn in enumerate(sents):
        if not isinstance(sn, dict):
            continue
        t = str(sn.get("t") or "").strip()
        if not t:
            continue
        groups.setdefault(int(sn.get("p") or 0), []).append(t)

    for p, para in enumerate(paras):
        if not para.strip():
            continue
        if p not in groups:
            iss.err(tag, f"正文第 {p} 段没有对应的 sents（段落号 p 从 0 开始）")
    for p, ts in sorted(groups.items()):
        if p < 0 or p >= len(paras):
            iss.err(tag, f"sents 的段落号 p={p} 超出正文段落数 {len(paras)}")
            continue
        joined = re.sub(r"\s+", " ", " ".join(ts)).strip()
        expect = re.sub(r"\s+", " ", paras[p]).strip()
        if joined != expect:
            iss.err(
                tag,
                f"第 {p} 段句子拼接与正文不一致：\n"
                f"      sents: {joined}\n"
                f"      text : {expect}",
            )

    # 逐句英中是新的目标格式，缺了只是提醒（旧课文还没重写）
    no_en = sum(1 for sn in sents if isinstance(sn, dict) and not str(sn.get("en") or "").strip())
    no_zh = sum(1 for sn in sents if isinstance(sn, dict) and not str(sn.get("zh") or "").strip())
    if no_en:
        iss.warn(tag, f"{no_en}/{len(sents)} 句缺英文（sents[].en）")
    if no_zh:
        iss.warn(tag, f"{no_zh}/{len(sents)} 句缺中文（sents[].zh）")


class Issues:
    """收集问题。按严重程度分两级：error 阻断，warn 仅提示。"""

    def __init__(self):
        self.errors = []
        self.warns = []

    def err(self, where, msg):
        self.errors.append((where, msg))

    def warn(self, where, msg):
        self.warns.append((where, msg))

    def report(self):
        for where, msg in self.errors:
            print(f"[错误] {where}: {msg}", file=sys.stderr)
        for where, msg in self.warns:
            print(f"[提醒] {where}: {msg}")
        n = len(self.errors)
        if n:
            print(f"\n校验未通过：{n} 个错误，{len(self.warns)} 个提醒。", file=sys.stderr)
        elif not self.warns:
            print("校验通过。")
        else:
            print(f"\n校验通过（{len(self.warns)} 个提醒）。")
        return 1 if n else 0


def check_structure(iss):
    """顶层结构与课文数组。"""
    if not os.path.exists(MATERIALS):
        iss.err("materials.json", f"文件不存在：{MATERIALS}")
        return None
    try:
        raw = open(MATERIALS, encoding="utf-8").read()
    except OSError as e:
        iss.err("materials.json", f"读取失败：{e}")
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        iss.err("materials.json", f"JSON 语法错误：第 {e.lineno} 行第 {e.colno} 列：{e.msg}")
        return None

    if not isinstance(data, dict):
        iss.err("materials.json", "顶层必须是对象")
        return None
    if "version" not in data:
        iss.warn("materials.json", "缺 version 字段")
    lessons = data.get("lessons")
    if not isinstance(lessons, list) or not lessons:
        iss.err("materials.json", "lessons 必须是非空数组")
        return None
    return data


def check_lesson(iss, idx, l, seen_ids):
    """单篇课文的字段校验。返回该课是否通过基本校验。"""
    tag = f"L{idx + 1}"

    if not isinstance(l, dict):
        iss.err(tag, "课文项必须是对象")
        return False

    lid = l.get("id")
    if not lid:
        iss.err(tag, "缺 id")
        tag = lid
    else:
        tag = lid
        if not LESSON_ID_RE.match(str(lid)):
            iss.err(tag, f"id 不符合 ^L\\d{{2,}}$：{lid!r}")
        if lid in seen_ids:
            iss.err(tag, f"id 重复：{lid}")
        seen_ids.add(lid)

    for f in ("title", "text"):
        if not l.get(f):
            iss.err(tag, f"缺必填字段 {f}")
    if not l.get("title"):
        return False
    if not isinstance(l.get("text"), str) or not l["text"].strip():
        iss.err(tag, "text 为空")
        return False

    if l.get("level") not in LEVELS:
        iss.warn(tag, f"level 应为 {'/'.join(LEVELS)} 之一，当前 {l.get('level')!r}")

    if not isinstance(l.get("min"), int) or l.get("min", 0) <= 0:
        iss.warn(tag, f"min 应为正整数，当前 {l.get('min')!r}")

    # 来源（M8）：B 改编 / C 导入都必须写 url，便于日后回溯与版权说明
    src = l.get("src")
    if src is not None:
        if not isinstance(src, dict):
            iss.err(tag, "src 必须是对象")
        else:
            kind = str(src.get("kind") or "").strip()
            if kind not in ("original", "adapted", "imported"):
                iss.err(tag, f"src.kind 应为 original/adapted/imported，当前 {kind!r}")
            if kind in ("adapted", "imported") and not str(src.get("url") or "").strip():
                iss.err(tag, f"src.kind={kind} 必须写 src.url（原出处）")

    # 已废弃字段（M8）：trans / trans_lines 由 sents 取代，出现就提醒
    for dead in ("trans", "trans_lines", "en_lines", "zh_lines"):
        if dead in l:
            iss.warn(tag, f"出现已废弃字段 {dead} —— v2 起全文翻译由前端按 sents 拼出，建议删掉")

    # 全文翻译：兼容字符串（旧）与对象（新）。
    # v2 起 sents 是逐句翻译的唯一来源，trans 可以完全不写 —— 前端会用
    # transFromSents() 按段落拼出来。所以只有在 sents 也给不出译文时才提醒。
    paras = len([p for p in str(l.get("text", "")).split("\n") if p.strip()])
    tr = norm_trans(l.get("trans"))
    _ss = [sn for sn in (l.get("sents") or []) if isinstance(sn, dict)]
    sents_en = bool(_ss) and all(str(sn.get("en") or "").strip() for sn in _ss)
    sents_zh = bool(_ss) and all(str(sn.get("zh") or "").strip() for sn in _ss)
    if not tr["en"] and not tr["zh"]:
        if not (sents_en and sents_zh):
            iss.warn(tag, "缺 trans（全文翻译），且 sents 也拼不出完整译文，至少要有一份")
    else:
        if not tr["en"]:
            iss.warn(tag, "trans 缺英文（en）")
        if not tr["zh"]:
            iss.warn(tag, "trans 缺中文（zh）")
        tparas = len([p for p in tr["zh"].split("\n") if p.strip()])
        if tr["zh"] and tparas != paras:
            iss.warn(tag, f"trans.zh 段落数 {tparas} 与正文段落数 {paras} 不一致")

    # 标题英文（可选）
    if not l.get("en"):
        iss.warn(tag, "缺en（标题英文，首批重写后应补上）")

    # 假朋友（M8）：ff 只能来自 tools/ff_list.json 白名单。
    # 以前是「有 ff 就必须有 reviewed」，那要求人工过一眼；现在改成按白名单
    # 自动标注（merge_lesson.py 负责补），所以闸门换成「不在白名单就报错」。
    ff_words = [w for w in (l.get("words") or []) if isinstance(w, dict) and str(w.get("ff") or "").strip()]
    if ff_words:
        print(f"  {tag}含 {len(ff_words)} 个假朋友标注")
        for w in ff_words:
            pt = str(w.get("pt") or "").strip().lower()
            if FF_LIST and pt not in FF_LIST:
                iss.err(tag, f"生词 {w.get('pt')!r} 的 ff 不在 tools/ff_list.json 白名单里。"
                             f"要么删掉 ff，要么把它加进白名单（需人工确认）")

    # 把正文压成单空格形式，供「ex 是否出自正文」比较
    text_flat = re.sub(r"\s+", " ", str(l.get("text") or "")).strip()

    # 生词：每项 [葡语, 释义, 例句?]
    words = l.get("words")
    if not isinstance(words, list) or not words:
        iss.warn(tag, "缺 words（生词卡）")
    else:
        bad = 0
        old_style = 0
        no_en = 0
        ex_bad = 0
        for i, w in enumerate(words):
            if isinstance(w, (list, tuple)):
                old_style += 1
            nw = norm_word(w)
            if not nw["pt"]:
                iss.err(tag, f"words[{i}] 缺葡语：{w!r}")
                bad += 1
                continue
            if not nw["en"] and not nw["zh"]:
                iss.err(tag, f"words[{i}]（{nw['pt']}）英文与中文释义至少要有一份")
                bad += 1
            if not nw["en"]:
                no_en += 1
            # 例句应当是正文里的一句原句（M8）。汇总成一课一条，
            # 否则存量课文里那种「改写过的例句」会一次刷几十条，淹掉别的警告。
            if nw["ex"] and nw["ex"] not in text_flat:
                ex_bad += 1
        if old_style and not bad:
            iss.warn(tag, f"{old_style} 个生词为旧格式（数组），建议重写为对象并补en")
        if no_en and not old_style:
            iss.warn(tag, f"{no_en} 个生词缺英文释义")
        if ex_bad:
            iss.warn(tag, f"{ex_bad}/{len(words)} 个生词的 ex 不是正文原句"
                         f"（新课文请直接复制对应的 sents[].t）")
        if bad == 0 and not 10 <= len(words) <= 14:
            iss.warn(tag, f"生词数 {len(words)}（建议每篇 10 至 14）")

    # 理解题：每项 [问题, 参考答案]
    qs = l.get("qs")
    if not isinstance(qs, list) or not qs:
        iss.warn(tag, "缺 qs（理解问题）")
    else:
        for i, q in enumerate(qs):
            if not isinstance(q, list) or len(q) < 2 or not q[0] or not q[1]:
                iss.err(tag, f"qs[{i}] 格式错误（应为 [问题, 参考答案]）：{q!r}")

    # sents 由构建脚本生成；存在则查字段与引用
    sents = l.get("sents")
    if sents is not None:
        if not isinstance(sents, list):
            iss.err(tag, "sents 必须是数组")
        else:
            no_audio = 0
            for i, sn in enumerate(sents):
                if not isinstance(sn, dict) or not sn.get("t"):
                    iss.err(tag, f"sents[{i}] 缺少 t")
                    continue
                if "a" not in sn:
                    no_audio += 1
                if len(str(sn.get("t") or "")) > 200:
                    iss.warn(tag, f"sents[{i}] 超过 200 字符（{len(str(sn['t']))}），句子太长不利于跟读与听写")
            # 对话段落必须有 sp:"b"，否则全程只有一个声音（M8 补的漏洞）
            paras = str(l.get("text") or "").split("\n")
            dash_paras = [p for p in paras if p.strip().startswith("—")]
            has_b = any(str(sn.get("sp") or "").lower() == "b" for sn in sents if isinstance(sn, dict))
            if dash_paras and not has_b:
                iss.warn(tag, f"有 {len(dash_paras)} 个破折号对话段，但没有任何 sents[] 标 sp:\"b\" —— "
                              f"对话第二角色不会用另一个声音。见 skills/apt-lesson 第 4 节")
            if no_audio:
                iss.warn(tag, f"{no_audio}/{len(sents)} 句未生成音频引用（跑一次 build_audio.py）")
            check_sents_alignment(iss, tag, l)

    check_brazilian(iss, tag, l)
    return True


def check_cross_lesson(iss, lessons):
    """跨课生词重复（M8）。同课内重复算提醒，跨课重复也算提醒 —— 可能是刻意复现，
    但更可能是没查旧课，写课文前应该先看一遍已有的 words[].pt。"""
    first = {}
    for l in lessons:
        tag = l.get("id", "?")
        local = set()
        for w in l.get("words") or []:
            nw = norm_word(w)
            pt = nw["pt"].strip().lower()
            if not pt:
                continue
            if pt in local:
                iss.warn(tag, f"生词 {nw['pt']!r} 在本课里出现了两次")
                continue
            local.add(pt)
            if pt in first:
                iss.warn(tag, f"生词 {nw['pt']!r} 已在 {first[pt]} 出现过（跨课重复）")
            else:
                first[pt] = tag


def check_audio(iss, lessons):
    """校验音频引用指向的文件真实存在。"""
    missing = 0
    total = 0
    for l in lessons:
        tag = l.get("id", "?")
        refs = []
        for sn in l.get("sents") or []:
            if isinstance(sn, dict) and sn.get("a"):
                refs.append(sn["a"])
        for a in l.get("wa") or []:
            if a:
                refs.append(a)
        for r in refs:
            total += 1
            p = os.path.join(ROOT, "site", r)
            if not os.path.exists(p):
                iss.err(tag, f"音频缺失：{r}")
                missing += 1
        # wa 长度须与 words 一致
        wa = l.get("wa")
        words = l.get("words") or []
        if isinstance(wa, list) and len(wa) != len(words):
            iss.err(tag, f"wa 长度 {len(wa)} 与 words 长度 {len(words)} 不一致（构建未完成？）")
    if total:
        print(f"音频引用 {total} 个，缺失 {missing} 个。")
    else:
        iss.warn("audio", "尚无音频引用，先跑 build_audio.py")
    return missing == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", action="store_true", help="额外校验音频文件是否齐全")
    ap.add_argument("--quiet", action="store_true", help="只在出错时输出")
    args = ap.parse_args()

    iss = Issues()
    data = check_structure(iss)
    if data is None:
        return iss.report()

    seen = set()
    for i, l in enumerate(data["lessons"]):
        check_lesson(iss, i, l, seen)

    check_cross_lesson(iss, data["lessons"])

    if args.audio:
        check_audio(iss, data["lessons"])
    elif args.quiet:
        pass

    n = len(data["lessons"])
    if not args.quiet or iss.errors:
        print(f"共 {n} 篇课文。")
    return iss.report()


if __name__ == "__main__":
    sys.exit(main())