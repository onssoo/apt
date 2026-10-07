#!/usr/bin/env python3
"""merge_lesson.py —— 把一篇课文草稿安全并入 site/materials.json。

为什么要有这个脚本：materials.json 已经 50KB，让 Agent 或人手改，迟早会弄坏
别的课文。所以约定是 **Agent 只写 drafts/<slug>.json，由这里负责并入**。

它做五件事：
1. 给 id 为 "auto" 的草稿分配下一个 L 编号
2. **按 tools/ff_list.json 白名单自动补假朋友**（Agent 不手写 ff）
3. 拒绝与已有课文正文重复的草稿
4. 用 validate.py 的同一套规则校验单篇，有硬错误就不写文件
5. 并入后把草稿移到 drafts/done/

用法：
    python3 tools/merge_lesson.py drafts/mercado.json
    python3 tools/merge_lesson.py drafts/mercado.json --dry-run

仅标准库。校验逻辑直接复用 tools/validate.py，不另写一套规则。
"""
import argparse
import json
import os
import re
import shutil
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MATERIALS = os.path.join(ROOT, "site", "materials.json")
DRAFTS = os.path.join(ROOT, "drafts")
DONE = os.path.join(DRAFTS, "done")

sys.path.insert(0, os.path.join(ROOT, "tools"))
import validate as V  # noqa: E402


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def flat(s):
    """压成单空格形式，用于正文查重与比较。"""
    return re.sub(r"\s+", " ", str(s or "")).strip()


def next_id(lessons):
    """下一个可用编号：取已有最大数字 +1，三位数自动变 L100。"""
    mx = 0
    for l in lessons:
        m = re.match(r"^L(\d+)$", str(l.get("id") or ""))
        if m:
            mx = max(mx, int(m.group(1)))
    return "L%02d" % (mx + 1)


def apply_ff(lesson, ff_list):
    """按白名单自动补 ff；顺手清掉不在白名单里的 ff（Agent 不许手写）。

    返回 (补上的, 移除的)。移除的要在报告里列出来当「候选假朋友」，
    由人决定是否加进白名单 —— 不能静默丢掉。
    """
    added, removed = [], []
    for w in lesson.get("words") or []:
        if not isinstance(w, dict):
            continue
        pt = str(w.get("pt") or "").strip()
        key = pt.lower()
        if key in ff_list:
            want = ff_list[key]
            if str(w.get("ff") or "").strip() != want:
                w["ff"] = want
                added.append(pt)
        elif str(w.get("ff") or "").strip():
            removed.append((pt, w["ff"]))
            del w["ff"]
    return added, removed


def find_duplicate(lesson, lessons):
    """正文（压成单空格后）与已有课文重复就拒绝。"""
    t = flat(lesson.get("text"))
    if not t:
        return None
    for l in lessons:
        if flat(l.get("text")) == t:
            return l.get("id")
        # 前 120 字相同也当作重复（防止改几个字就重录一遍音频）
        if len(t) > 120 and flat(l.get("text"))[:120] == t[:120]:
            return l.get("id")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft", help="草稿 JSON（单个课文对象）")
    ap.add_argument("--dry-run", action="store_true", help="只检查，不写文件")
    ap.add_argument("--keep", action="store_true", help="并入后不移动草稿")
    args = ap.parse_args()

    if not os.path.exists(args.draft):
        raise SystemExit(f"找不到草稿：{args.draft}")

    draft = load(args.draft)
    if isinstance(draft, list):
        raise SystemExit("草稿必须是**一个**课文对象，不是数组。多篇请分次合并。")

    data = load(MATERIALS)
    lessons = data.get("lessons") or []
    old_lessons_text = json.dumps(lessons, ensure_ascii=False, indent=1)

    # --- 1. 编号 ---
    lid = str(draft.get("id") or "").strip()
    if lid in ("", "auto"):
        lid = next_id(lessons)
    elif any(str(l.get("id")) == lid for l in lessons):
        raise SystemExit(f"id {lid} 已被占用；把草稿的 id 写成 \"auto\" 让脚本分配")
    draft["id"] = lid

    # --- 2. 假朋友：按白名单自动补 ---
    ff_added, ff_removed = apply_ff(draft, V.FF_LIST)

    # --- 3. 查重 ---
    dup = find_duplicate(draft, lessons)
    if dup:
        raise SystemExit(f"正文与已有课文 {dup} 重复（或前 120 字相同），拒绝并入。"
                         f"同一篇内容不需要第二份，旧音频也会白重录。")

    # --- 4. 单篇校验：直接复用 validate.py 的规则 ---
    iss = V.Issues()
    ok = V.check_lesson(iss, len(lessons), draft, {l.get("id") for l in lessons})
    if not ok or iss.errors:
        print(f"\n❌ {lid} 校验未通过，materials.json 未改动：", file=sys.stderr)
        for where, msg in iss.errors:
            print(f"   [错误] {where}: {msg}", file=sys.stderr)
        for where, msg in iss.warns:
            print(f"   [提醒] {where}: {msg}", file=sys.stderr)
        return 1
    for where, msg in iss.warns:
        print(f"   [提醒] {where}: {msg}")

    if args.dry_run:
        print(f"\n（dry-run）{lid} 校验通过，未写文件。")
        return 0

    # --- 5. 并入：确认已有课文的序列化字节完全没变 ---
    lessons.append(draft)
    new_lessons_text = json.dumps(lessons[:-1], ensure_ascii=False, indent=1)
    if new_lessons_text != old_lessons_text:
        raise SystemExit("内部检查失败：已有课文的序列化内容发生了变化，已放弃写入。")

    data["lessons"] = lessons
    tmp = MATERIALS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MATERIALS)

    # --- 6. 归档草稿 ---
    if not args.keep:
        os.makedirs(DONE, exist_ok=True)
        dest = os.path.join(DONE, os.path.basename(args.draft))
        shutil.move(args.draft, dest)
        print(f"草稿已归档：{os.path.relpath(dest, ROOT)}")

    print(f"\n✅ 已并入 {lid}（{draft.get('title')}）")
    if ff_added:
        print(f"   自动标注假朋友 {len(ff_added)} 个：{'、'.join(ff_added)}")
    if ff_removed:
        print(f"   ⚠️ 移除了 {len(ff_removed)} 个不在白名单的 ff（请人工判断是否加入 tools/ff_list.json）：")
        for pt, ff in ff_removed:
            print(f"      · {pt}：{ff[:60]}")
    print("\n下一步：")
    print("  python3 tools/validate.py --audio")
    print("  python3 tools/build_audio.py")
    print("  ./deploy.sh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
