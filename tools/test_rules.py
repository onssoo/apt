#!/usr/bin/env python3
"""test_rules.py —— 课文流水线的规则测试（validate 的每条新规则 + merge 的行为）。

为什么要有它：M8 加的规则如果只是「跑过一次现有内容没报错」，等于没验。
这里**逐条构造坏数据**，确认该报错的报错、该提醒的提醒；再在沙箱里
真跑 merge_lesson.py，确认编号递增、查重拒绝、假朋友自动补、已有课文不变。

全程在一个临时目录里做（复制 tools/ 与一份 materials.json），
**不碰仓库里的 site/materials.json**。

运行：python3 tools/test_rules.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

passed = 0
failed = []
results = []


def t(name, cond, detail=''):
    global passed
    results.append(('✓' if cond else '✗', name, detail))
    if cond:
        passed += 1
        print(f'✓ {name}')
    else:
        failed.append(name)
        print(f'✗ {name}' + (f'   ← {detail}' if detail else ''))


def make_sandbox(base_lessons):
    """建一个最小仓库：site/materials.json + tools/{validate,merge_lesson,ff_list}"""
    d = tempfile.mkdtemp(prefix='apt-rules-')
    os.makedirs(os.path.join(d, 'site'), exist_ok=True)
    os.makedirs(os.path.join(d, 'tools'), exist_ok=True)
    os.makedirs(os.path.join(d, 'drafts', 'done'), exist_ok=True)
    for f in ('validate.py', 'merge_lesson.py', 'ff_list.json'):
        shutil.copy(os.path.join(ROOT, 'tools', f), os.path.join(d, 'tools', f))
    write_materials(d, base_lessons)
    return d


def write_materials(sandbox, lessons):
    with open(os.path.join(sandbox, 'site', 'materials.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 2, 'lessons': lessons}, f, ensure_ascii=False, indent=1)


def run(sandbox, *args):
    """在沙箱里跑一个脚本，返回 (退出码, 输出)。"""
    p = subprocess.run([sys.executable] + list(args), cwd=sandbox,
                       capture_output=True, text=True)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def lesson(lid='L90', **kw):
    """一篇结构合法的最小课文，供测试按需破坏某一处。"""
    base = {
        'id': lid, 'level': 'A2', 'min': 6,
        'title': 'Título de teste', 'zh': '测试课文', 'en': 'Test lesson',
        'text': 'Bom dia! Como está?\n— Muito bem, obrigado.',
        'note': '测试用语法点。',
        'sents': [
            {'p': 0, 't': 'Bom dia!', 'en': 'Good morning!', 'zh': '早上好！'},
            {'p': 0, 't': 'Como está?', 'en': 'How are you?', 'zh': '您好吗？'},
            {'p': 1, 't': '— Muito bem, obrigado.', 'sp': 'b',
             'en': 'Very well, thank you.', 'zh': '很好，谢谢。'},
        ],
        'words': [{'pt': 'obrigado', 'en': 'thank you', 'zh': '谢谢',
                   'ex': '— Muito bem, obrigado.'}],
        'qs': [['Como está ele?', 'Muito bem.']],
    }
    base.update(kw)
    return base


VALID = lesson('L01')

print('=== A. validate 规则逐条 ===\n')

# A1 结构合法 → 通过
sb = make_sandbox([VALID])
code, out = run(sb, 'tools/validate.py')
t('合法课文：校验通过', code == 0, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A2 段落对不齐 → 硬错误
bad = lesson('L01', sents=[
    {'p': 0, 't': 'Bom dia!', 'en': 'x', 'zh': 'x'},
    {'p': 0, 't': 'Como vai?', 'en': 'x', 'zh': 'x'},          # 与正文不符
    {'p': 1, 't': '— Muito bem, obrigado.', 'sp': 'b', 'en': 'x', 'zh': 'x'},
])
sb = make_sandbox([bad])
code, out = run(sb, 'tools/validate.py')
t('段落对不齐 → 报错且退出码非 0', code != 0 and '段句子拼接与正文不一致' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A3 ff 不在白名单 → 硬错误
bad = lesson('L01')
bad['words'][0]['ff'] = '我自己编的假朋友说明'
sb = make_sandbox([bad])
code, out = run(sb, 'tools/validate.py')
t('ff 不在白名单 → 报错', code != 0 and '白名单' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A4 ff 在白名单 → 通过
ok = lesson('L01')
ok['words'] = [{'pt': 'a livraria', 'en': 'bookshop', 'zh': '书店',
                'ex': '— Muito bem, obrigado.', 'ff': '≠ library。图书馆是 a biblioteca'}]
sb = make_sandbox([ok])
code, out = run(sb, 'tools/validate.py')
t('ff 来自白名单 → 通过', code == 0, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A5 src.kind=adapted 缺 url → 硬错误
sb = make_sandbox([lesson('L01', src={'kind': 'adapted', 'site': 'Público'})])
code, out = run(sb, 'tools/validate.py')
t('adapted 缺 src.url → 报错', code != 0 and 'src.url' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A6 level 允许 B1
sb = make_sandbox([lesson('L01', level='B1')])
code, out = run(sb, 'tools/validate.py')
t('level=B1 不再报警', code == 0 and 'level 应为' not in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A7 level 非法 → 提醒
sb = make_sandbox([lesson('L01', level='C9')])
code, out = run(sb, 'tools/validate.py')
t('level=C9 → 提醒', 'level 应为' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A8 破折号对话段但没有 sp:"b" → 提醒
bad = lesson('L01')
for sn in bad['sents']:
    sn.pop('sp', None)
sb = make_sandbox([bad])
code, out = run(sb, 'tools/validate.py')
t('有对话段却无 sp:"b" → 提醒', 'sp:"b"' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A9 单句超 200 字符 → 提醒
long_t = 'Olá ' * 60 + 'fim.'   # 244 字符，确保超过 200
bad = lesson('L01', text=long_t, sents=[{'p': 0, 't': long_t, 'en': 'x', 'zh': 'x'}],
             words=[{'pt': 'olá', 'en': 'hi', 'zh': '你好', 'ex': long_t}])
sb = make_sandbox([bad])
code, out = run(sb, 'tools/validate.py')
t('单句超 200 字符 → 提醒', '超过 200 字符' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A10 ex 不在正文中 → 提醒
bad = lesson('L01')
bad['words'][0]['ex'] = 'Esta frase não está no texto.'
sb = make_sandbox([bad])
code, out = run(sb, 'tools/validate.py')
t('ex 不在正文中 → 提醒', 'ex 不是正文原句' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A11 跨课生词重复 → 提醒
l1 = lesson('L01')
l2 = lesson('L02')
l2['text'] = 'Outro texto aqui.'
l2['sents'] = [{'p': 0, 't': 'Outro texto aqui.', 'en': 'x', 'zh': 'x'}]
l2['words'] = [{'pt': 'obrigado', 'en': 'thank you', 'zh': '谢谢', 'ex': 'Outro texto aqui.'}]
sb = make_sandbox([l1, l2])
code, out = run(sb, 'tools/validate.py')
t('跨课生词重复 → 提醒', '已在 L01 出现过' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# A12 trans 等废弃字段 → 提醒
sb = make_sandbox([lesson('L01', trans='这是废弃的全文翻译')])
code, out = run(sb, 'tools/validate.py')
t('出现 trans → 提醒已废弃', '已废弃字段 trans' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

print('\n=== B. merge_lesson.py 行为 ===\n')


def draft(lid='auto', **kw):
    d = lesson(lid, **kw)
    return d


def write_draft(sb, name, obj):
    p = os.path.join(sb, 'drafts', name)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    return p


# B1 连续合并两篇 → 编号递增
sb = make_sandbox([VALID])
before = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
for name in ('a.json', 'b.json'):
    d = draft()
    d['text'] = f'Texto {name}.' if name == 'a.json' else f'Outro {name}.'
    d['sents'] = [{'p': 0, 't': d['text'], 'en': 'x', 'zh': 'x'}]
    d['words'] = [{'pt': f'palavra {name}', 'en': 'w', 'zh': '词', 'ex': d['text']}]
    write_draft(sb, name, d)
    code, out = run(sb, 'tools/merge_lesson.py', f'drafts/{name}')
    t(f'合并 {name} 成功', code == 0, out.strip()[-200:])

data = json.load(open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8'))
ids = [l['id'] for l in data['lessons']]
t('连续合并分配 L02、L03', ids == ['L01', 'L02', 'L03'], f'实际 {ids}')
t('草稿已归档到 drafts/done/', sorted(os.listdir(os.path.join(sb, 'drafts', 'done'))) == ['a.json', 'b.json'],
  str(os.listdir(os.path.join(sb, 'drafts', 'done'))))

# 已有课文逐字节未变
old_first = json.loads(before)['lessons'][0]
new_first = data['lessons'][0]
t('已有课文序列化后完全未变',
  json.dumps(old_first, ensure_ascii=False, indent=1) == json.dumps(new_first, ensure_ascii=False, indent=1))
shutil.rmtree(sb, ignore_errors=True)

# B2 正文重复 → 拒绝且不写文件
sb = make_sandbox([VALID])
before = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
d = draft()
d['text'] = VALID['text']            # 与 L01 完全相同
d['sents'] = VALID['sents']
write_draft(sb, 'dup.json', d)
code, out = run(sb, 'tools/merge_lesson.py', 'drafts/dup.json')
after = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
t('正文重复 → 拒绝并入', code != 0 and '拒绝并入' in out, out.strip()[-200:])
t('被拒绝时 materials.json 一字未动', before == after)
shutil.rmtree(sb, ignore_errors=True)

# B3 假朋友：白名单自动补，非白名单自动移除并报告
sb = make_sandbox([VALID])
d = draft()
d['text'] = 'Hoje vou à livraria.'
d['sents'] = [{'p': 0, 't': 'Hoje vou à livraria.', 'en': 'x', 'zh': 'x'}]
d['words'] = [
    {'pt': 'a livraria', 'en': 'bookshop', 'zh': '书店', 'ex': 'Hoje vou à livraria.'},   # 在白名单
    {'pt': 'xpto', 'en': 'x', 'zh': 'x', 'ex': 'Hoje vou à livraria.', 'ff': '我编的'},     # 不在白名单
]
write_draft(sb, 'ff.json', d)
code, out = run(sb, 'tools/merge_lesson.py', 'drafts/ff.json')
t('B3 合并成功', code == 0, out.strip()[-300:])
data = json.load(open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8'))
newl = [l for l in data['lessons'] if l['id'] == 'L02'][0]
t('白名单里的词自动补上 ff', any(w.get('ff') for w in newl['words'] if w['pt'] == 'a livraria'),
  json.dumps(newl['words'], ensure_ascii=False)[:200])
t('非白名单的 ff 被移除', not any(w.get('ff') for w in newl['words'] if w['pt'] == 'xpto'))
t('移除的 ff 在报告里列出', '不在白名单' in out and 'xpto' in out, out.strip()[-300:])
shutil.rmtree(sb, ignore_errors=True)

# B4 --dry-run 不写文件
sb = make_sandbox([VALID])
before = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
d = draft()
d['text'] = 'Texto de dry run.'
d['sents'] = [{'p': 0, 't': d['text'], 'en': 'x', 'zh': 'x'}]
write_draft(sb, 'dry.json', d)
code, out = run(sb, 'tools/merge_lesson.py', 'drafts/dry.json', '--dry-run')
after = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
t('--dry-run 不写文件', code == 0 and before == after and 'dry-run' in out, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

# B5 单篇校验不过 → 不写文件
sb = make_sandbox([VALID])
before = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
d = draft(src={'kind': 'adapted'})          # 缺 url，硬错误
d['text'] = 'Texto com src sem url.'
d['sents'] = [{'p': 0, 't': d['text'], 'en': 'x', 'zh': 'x'}]
write_draft(sb, 'bad.json', d)
code, out = run(sb, 'tools/merge_lesson.py', 'drafts/bad.json')
after = open(os.path.join(sb, 'site', 'materials.json'), encoding='utf-8').read()
t('单篇校验不过 → 拒绝且不写文件', code != 0 and before == after, out.strip()[-200:])
shutil.rmtree(sb, ignore_errors=True)

print('\n=== 结果 ===\n')
for mark, name, detail in results:
    print(f'{mark} {name}' + (f'   ← {detail}' if mark == '✗' and detail else ''))
print(f'\n规则测试：{passed} 通过，{len(failed)} 失败')
if failed:
    print('失败项：')
    for f in failed:
        print('  -', f)
    sys.exit(1)
print('全部通过。')
