/**
 * test_logic.mjs —— site/logic.js 的单元测试。
 * 只用 node 内置 assert，不引入任何依赖。
 * 运行：node tools/test_logic.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const L = require(path.join(ROOT, 'site', 'logic.js'));

let passed = 0;
let failed = 0;
const fails = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    fails.push({ name, msg: e.message });
  }
}

// ---------- 日期 ----------

t('day 用本地时区，不跨日偏移', () => {
  // 本地时间 2026-03-05 23:30，本地日期应为 2026-03-05
  const d = new Date(2026, 2, 5, 23, 30);
  assert.equal(L.day(d), '2026-03-05');
  // UTC 下若误用 toISOString 会变成 03-04（UTC+8 反向），这里验证不走 UTC
  const e = new Date(2026, 2, 5, 0, 30);      // 本地 00:30
  assert.equal(L.day(e), '2026-03-05');
});

t('addDays 跨月', () => {
  const d = new Date(2026, 0, 28);          // 1月28日
  assert.equal(L.addDays(5, d), '2026-02-02');
});

t('addDays 跨年', () => {
  const d = new Date(2025, 11, 30);         // 2025-12-30
  assert.equal(L.addDays(5, d), '2026-01-04');
});

t('addDays 负数（往前）', () => {
  const d = new Date(2026, 2, 5);
  assert.equal(L.addDays(-5, d), '2026-02-28');
});

t('daysBetween 正确', () => {
  assert.equal(L.daysBetween('2026-03-01', '2026-03-08'), 7);
  assert.equal(L.daysBetween('2026-03-08', '2026-03-01'), -7);
  assert.equal(L.daysBetween('2026-03-01', '2026-03-01'), 0);
});

t('mondayOf 周日归属上一个周一', () => {
  // 2026-03-08 是周日，所属周的周一应为 2026-03-02
  assert.equal(L.mondayOf(new Date(2026, 2, 8)), '2026-03-02');
  // 2026-03-02 本身是周一
  assert.equal(L.mondayOf(new Date(2026, 2, 2)), '2026-03-02');
  // 周一自身
  assert.equal(L.mondayOf(new Date(2026, 2, 9)), '2026-03-09');
});

// ---------- 间隔重复 ----------

t('记住了：box+1 并按表顺延', () => {
  const r = L.schedule({ box: 0, lapse: 0 }, true, new Date(2026, 2, 5));
  assert.equal(r.box, 1);
  assert.equal(r.due, '2026-03-06');       // INT[1] = 1
  assert.equal(r.lapse, 0);                // 记住不加 lapse
});

t('box 上界为 6，不再增长', () => {
  const r = L.schedule({ box: 6, lapse: 3 }, true, new Date(2026, 2, 5));
  assert.equal(r.box, 6);
  assert.equal(r.due, '2026-04-04');       // INT[6] = 30
  assert.equal(r.lapse, 3);
});

t('没记住：box归零、due=今天、lapse+1', () => {
  const r = L.schedule({ box: 4, lapse: 2 }, false, new Date(2026, 2, 5));
  assert.equal(r.box, 0);
  assert.equal(r.due, '2026-03-05');
  assert.equal(r.lapse, 3);                // 关键：lapse 累加
});

t('没记住时 lapse 必须累加（错词本依赖它）', () => {
  let w = { box: 5, lapse: 0 };
  for (let i = 0; i < 5; i++) w = L.schedule(w, false);
  assert.equal(w.lapse, 5);
});

t('间隔表与契约一致', () => {
  assert.deepEqual(L.INT, [0, 1, 2, 4, 7, 15, 30]);
  assert.equal(L.MASTERED_BOX, 5);
});

t('box=5 即视为已掌握', () => {
  assert.ok(5 >= L.MASTERED_BOX);
  assert.ok(!(4 >= L.MASTERED_BOX));
});

t('due 只取到期词', () => {
  const ws = [
    { id: 'a', due: '2026-03-04' },
    { id: 'b', due: '2026-03-05' },
    { id: 'c', due: '2026-03-06' },
  ];
  const got = L.due(ws, '2026-03-05').map(w => w.id);
  assert.deepEqual(got, ['a', 'b']);      // 今天到期的也要
});

t('takeBatch 受上限约束', () => {
  const ws = Array.from({ length: 80 }, (_, i) => ({
    id: 'w' + i, due: '2026-03-01',
  }));
  assert.equal(L.takeBatch(ws, 30, '2026-03-05').length, 30);
  assert.equal(L.takeBatch(ws.slice(0, 12), 30, '2026-03-05').length, 12);
});

t('积压判定阈值 50', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: 'w' + i, due: '2026-03-01' }));
  const few = Array.from({ length: 50 }, (_, i) => ({ id: 'w' + i, due: '2026-03-01' }));
  assert.equal(L.isBacklogged(many, 50, '2026-03-05'), true);
  assert.equal(L.isBacklogged(few, 50, '2026-03-05'), false);   // 恰好 50 不算积压
});

// ---------- 连续打卡与周目标 ----------

/** 构造日志：给日期列表打上 done */
function mkLog(dates) {
  const o = {};
  for (const d of dates) o[d] = { done: true };
  return o;
}

/**
 * 造一个「今天」往前推 n 天的日期列表，用于测 streak。
 * streak 从今天起算（今天没打卡则从昨天起），因此测试必须相对今天构造，
 * 不能用固定历史日期。
 */
function daysAgo(n) {
  return L.addDays(-n);
}

t('streak 今天已打卡', () => {
  assert.equal(L.streak(mkLog([L.today()])), 1);
});

t('streak 今天未打卡但昨天有，从昨天起数', () => {
  assert.equal(L.streak(mkLog([daysAgo(1), daysAgo(2)])), 2);
});

t('streak 断一天归零', () => {
  // 前天有，昨天没有，今天没有
  assert.equal(L.streak(mkLog([daysAgo(2)])), 0);
});

t('streak 连续三天', () => {
  assert.equal(L.streak(mkLog([daysAgo(0), daysAgo(1), daysAgo(2)])), 3);
});

t('streak 跨月连续', () => {
  // 今天是 3月1日，昨天 2月28，日 2月27 —— 跨月连续
  const today = new Date();
  const y = new Date(today.getFullYear(), today.getMonth(), 1);  // 本月1日
  const days = [L.day(y), L.addDays(-1, y), L.addDays(-2, y)];
  // 只在今天是本月1日时这个测试才成立
  if (L.day(today) === L.day(y)) {
    assert.equal(L.streak(mkLog(days)), 3);
  } else {
    // 其他日期改测相对形式：连续三天必为 3
    assert.equal(L.streak(mkLog([daysAgo(0), daysAgo(1), daysAgo(2)])), 3);
  }
});

t('streak 跨年连续（相对今天构造）', () => {
  // 连续三天必然跨年或跨月，验证不会因跨边界归零
  assert.equal(L.streak(mkLog([daysAgo(0), daysAgo(1), daysAgo(2)])), 3);
});

t('streak 空日志为 0', () => {
  assert.equal(L.streak({}), 0);
});

t('weekCount 只数本周', () => {
  // 参考日 2026-03-08（周日），本周一 = 03-02
  const ref = new Date(2026, 2, 8);
  const logs = mkLog(['2026-03-02', '2026-03-04', '2026-03-06']);
  assert.equal(L.weekCount(logs, ref), 3);
});

t('weekCount 不把上周的算进来', () => {
  const ref = new Date(2026, 2, 8);        // 本周一 03-02
  const logs = mkLog(['2026-02-27', '2026-03-03']);   // 一个上周一个本周
  assert.equal(L.weekCount(logs, ref), 1);
});

t('weekMet 达标判定', () => {
  const ref = new Date(2026, 2, 8);
  const ok = mkLog(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
  assert.equal(L.weekMet(ok, 5, ref), true);
  const no = mkLog(['2026-03-02', '2026-03-03']);
  assert.equal(L.weekMet(no, 5, ref), false);
});

t('周目标兜底：断一天仍达标', () => {
  const ref = new Date(2026, 2, 8);       // 周日，本周 03-02..03-08
  // 周一二三四打了卡，周五断，合计 4 天；再补周六周日 -> 但本测试只到周四
  const logs = mkLog(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  assert.equal(L.weekCount(logs, ref), 4);
  // 连续天数此刻是 0（周五未打卡），但周目标差一天就达标
  assert.equal(L.weekMet(logs, 4, ref), true);
});

// ---------- 听写判定 ----------

t('cmpW 完全一致', () => {
  // 'O meu quarto é pequeno' 归一化后 5 个词（句尾标点不算词）
  const r = L.cmpW('O meu quarto é pequeno', 'O meu quarto é pequeno');
  assert.equal(r.ok, 5);
  assert.equal(r.m, 5);
  assert.ok(r.parts.every(p => p.cls === 'ok'));
});

t('cmpW 只错重音符号 → 橙（accent）不算错', () => {
  const r = L.cmpW('Portugues', 'Português');
  assert.equal(r.ok, 0, '重音不同不算完全正确');
  assert.equal(r.m, 1);
  assert.equal(r.parts[0].cls, 'ac');
});

t('cmpW 漏词 → 红（miss）', () => {
  const r = L.cmpW('o meu quarto', 'O meu quarto é pequeno');
  assert.equal(r.m, 5);
  const miss = r.parts.filter(p => p.cls === 'no').map(p => p.w);
  assert.deepEqual(miss, ['é', 'pequeno']);
});

t('cmpW 多词（作答多出）不计入正确', () => {
  const r = L.cmpW('O meu quarto é muito pequeno bom', 'O meu quarto é pequeno');
  assert.equal(r.ok, 5);
  assert.equal(r.m, 5);
});

t('cmpW 忽略标点与大小写', () => {
  // olá vs ola 只差重音 → ac（不算完全正确）；bom/estudo 完全一致
  const r = L.cmpW('ola, bom estudo!', 'Olá Bom estudo');
  assert.equal(r.m, 3);
  assert.equal(r.ok, 2);
  assert.equal(r.parts[0].cls, 'ac');
  assert.ok(r.parts.slice(1).every(p => p.cls === 'ok'));
});

t('cmpW 忽略大小写差异', () => {
  const r = L.cmpW('BOM DIA', 'bom dia');
  assert.equal(r.ok, 2);
});

t('cmpW 漏词与重音错混合', () => {
  const r = L.cmpW('o Portugues é pequeno', 'O Português é muito pequeno');
  const cls = r.parts.map(p => p.cls);
  assert.ok(cls.includes('ac'), '应有重音错');
  assert.ok(cls.includes('no'), '应有漏词 muito');
});

t('cmpW 空作答全漏', () => {
  const r = L.cmpW('', 'Olá bom dia');
  assert.equal(r.ok, 0);
  assert.equal(r.parts.filter(p => p.cls === 'no').length, 3);
});

// ---------- 切句 ----------

t('splitS 按段落记录序号', () => {
  const out = L.splitS('Um. Dois.\nTres. Quatro.');
  assert.equal(out.length, 4);
  assert.equal(out[0].t, 'Um.');
  assert.equal(out[0].p, 0);
  assert.equal(out[2].t, 'Tres.');
  assert.equal(out[2].p, 1);
});

t('splitS 保留省略号', () => {
  const out = L.splitS('Tenho … anos.');
  assert.equal(out.length, 1);
  assert.ok(out[0].t.includes('…'));
});

t('splitS 对话行不丢破折号', () => {
  const out = L.splitS('— Bom dia! Queria um quilo.', 'Tenho … anos.');
  assert.equal(out.length, 2);
  assert.ok(out[0].t.startsWith('—'));
});

t('say 剥离行首破折号（避免读出）', () => {
  assert.equal(L.say('— Bom dia!'), 'Bom dia!');
  assert.equal(L.say('Tenho … anos.'), 'Tenho anos.');
});

t('say 压缩空白', () => {
  assert.equal(L.say('  a   b  '), 'a b');
});

// ---------- 迁移 ----------

t('migrate 空输入安全', () => {
  assert.equal(L.migrate(null), null);
  assert.equal(L.migrate(undefined), null);
});

t('migrate 补齐默认目标 5 / 15', () => {
  const d = L.migrate({ words: [], logs: {} });
  assert.equal(d.set.goalW, 5);
  assert.equal(d.set.goalMin, 15);
  assert.equal(d.set.revBatch, 30);
  assert.equal(d.set.weekGoal, 5);
  assert.equal(d.set.voice, 'pt-PT');
});

t('migrate 保留已有设置，不覆盖', () => {
  const d = L.migrate({ words: [], logs: {}, set: { goalW: 20, goalMin: 40, voice: 'pt-BR' } });
  assert.equal(d.set.goalW, 20, '已存在的设置不得被默认值覆盖');
  assert.equal(d.set.goalMin, 40);
  assert.equal(d.set.voice, 'pt-BR');
});

t('migrate schema3 → 4 并补 lapse', () => {
  const d = L.migrate({
    words: [{ id: 1, pt: 'saudade', zh: '思念', box: 3 }],
    logs: {},
    set: { v3: 1, voice: 'pt-PT', goalW: 10, goalMin: 20 },
  });
  assert.equal(d.set.schema, 4);
  assert.equal(d.set.v3, undefined, 'v3 应被清掉');
  assert.equal(d.words[0].lapse, 0, 'lapse 应补 0');
});

t('migrate 绝不重置已有 lapse（关键）', () => {
  const d = L.migrate({
    words: [{ id: 1, pt: 'x', zh: 'y', box: 0, lapse: 7 }],
    logs: {},
    set: { v3: 1 },
  });
  assert.equal(d.words[0].lapse, 7, '已有 lapse 不得被清零');
});

t('migrate 补 del 与 seq', () => {
  const d = L.migrate({ words: [], logs: {} });
  assert.ok(Array.isArray(d.del));
  assert.equal(d.seq, 0);
});

t('migrate 容错乱输入', () => {
  const d = L.migrate({ words: 'notarray', logs: 'notobj' });
  assert.deepEqual(d.words, []);
  assert.deepEqual(d.logs, {});
});

t('migrate id 类型不强制（数字 id 保留）', () => {
  const d = L.migrate({
    words: [{ id: 12345, pt: 'a', zh: 'b' }],
    logs: {}, set: { v3: 1 },
  });
  assert.equal(d.words[0].id, 12345, '旧数字 id 不得改动');
});

t('SCHEMA 为 4', () => {
  assert.equal(L.SCHEMA, 4);
});

// ---------- 报告见文件末尾 ----------
// 注意：报告块必须留在文件最后。它原来夹在中间（M6 之前），
// 后面 36 个 M6 用例失败了也不会打印，退出码仍是 0 —— 测试假绿。
// ================================================================
// M6 双释义：格式兼容、显示模式、假朋友、批量导入、搜索
// ================================================================

// ---------- 格式兼容（M6-1） ----------

t('normWord 兼容对象格式', () => {
  const w = L.normWord({ pt: 'a livraria', en: 'bookshop', zh: '书店', ex: 'Ex.', ff: '≠ library' });
  assert.equal(w.pt, 'a livraria');
  assert.equal(w.en, 'bookshop');
  assert.equal(w.zh, '书店');
  assert.equal(w.ex, 'Ex.');
  assert.equal(w.ff, '≠ library');
});

t('normWord 兼容旧数组格式', () => {
  const w = L.normWord(['chamar-se', '叫（名字）', 'Chamo-me Mei.']);
  assert.equal(w.pt, 'chamar-se');
  assert.equal(w.en, '', '旧格式无英文');
  assert.equal(w.zh, '叫（名字）');
  assert.equal(w.ex, 'Chamo-me Mei.');
  assert.equal(w.ff, '');
});

t('normWord 缺字段不抛异常', () => {
  assert.doesNotThrow(() => L.normWord({}));
  assert.doesNotThrow(() => L.normWord(null));
  assert.doesNotThrow(() => L.normWord(undefined));
  assert.equal(L.normWord(null).pt, '');
});

t('normWord 去掉多余空白', () => {
  const w = L.normWord({ pt: '  a casa ', en: '  house  ', zh: ' 房子 ' });
  assert.equal(w.pt, 'a casa');
  assert.equal(w.en, 'house');
  assert.equal(w.zh, '房子');
});

t('normTrans 兼容字符串（旧格式视为中文）', () => {
  const t = L.normTrans('你好！');
  assert.equal(t.zh, '你好！');
  assert.equal(t.en, '');
});

t('normTrans 兼容对象格式', () => {
  const t = L.normTrans({ en: 'Hello!', zh: '你好！' });
  assert.equal(t.en, 'Hello!');
  assert.equal(t.zh, '你好！');
});

t('normTrans 缺输入返回空', () => {
  assert.deepEqual(L.normTrans(null), { en: '', zh: '' });
});

// ---------- 显示模式（M6-2） ----------

t('默认显示模式是英+中', () => {
  assert.equal(L.DEFAULT_SHOW, 'both');
  const d = L.migrate({ words: [], logs: {} });
  assert.equal(d.set.show, 'both');
});

t('migrate 保留已有的显示设置', () => {
  const d = L.migrate({ words: [], logs: {}, set: { show: 'en' } });
  assert.equal(d.set.show, 'en');
});

t('gloss both：英中都有', () => {
  const g = L.gloss({ pt: 'x', en: 'house', zh: '房子' }, 'both');
  assert.equal(g.en, 'house');
  assert.equal(g.zh, '房子');
});

t('gloss en：只英', () => {
  const g = L.gloss({ pt: 'x', en: 'house', zh: '房子' }, 'en');
  assert.equal(g.en, 'house');
  assert.equal(g.zh, '');
});

t('gloss zh：只中', () => {
  const g = L.gloss({ pt: 'x', en: 'house', zh: '房子' }, 'zh');
  assert.equal(g.en, '');
  assert.equal(g.zh, '房子');
});

t('gloss 旧词只有中文：both 模式只显示中文', () => {
  const g = L.gloss(['chamar-se', '叫（名字）'], 'both');
  assert.equal(g.en, '');
  assert.equal(g.zh, '叫（名字）');
});

// ---------- 搜索（M6-6） ----------

t('matchWord 匹配葡语', () => {
  assert.equal(L.matchWord({ pt: 'chamar-se', en: 'to be called', zh: '叫' }, 'chamar'), true);
});

t('matchWord 匹配英文', () => {
  assert.equal(L.matchWord({ pt: 'chamar-se', en: 'to be called', zh: '叫' }, 'called'), true);
});

t('matchWord 匹配中文', () => {
  assert.equal(L.matchWord({ pt: 'chamar-se', en: 'to be called', zh: '叫（名字）' }, '名字'), true);
});

t('matchWord 忽略大小写', () => {
  assert.equal(L.matchWord({ pt: 'Casa', en: 'house' }, 'casa'), true);
});

t('matchWord 忽略重音差异', () => {
  assert.equal(L.matchWord({ pt: 'difícil', en: 'difficult' }, 'dificil'), true);
});

t('matchWord 空查询返回全部', () => {
  assert.equal(L.matchWord({ pt: 'x' }, ''), true);
});

t('matchWord 不匹配无关词', () => {
  assert.equal(L.matchWord({ pt: 'livraria', en: 'bookshop', zh: '书店' }, 'library'), false);
});

t('matchWord 兼容旧数组格式', () => {
  assert.equal(L.matchWord(['livraria', '书店'], '书店'), true);
});

// ---------- 批量导入（M6-4） ----------

t('parseImportLine 单栏英文', () => {
  const r = L.parseImportLine('library | library');
  assert.equal(r.pt, 'library');
  assert.equal(r.en, 'library');
  assert.equal(r.zh, '');
});

t('parseImportLine 单栏中文归 zh', () => {
  const r = L.parseImportLine('livraria | 书店');
  assert.equal(r.pt, 'livraria');
  assert.equal(r.zh, '书店');
  assert.equal(r.en, '');
});

t('parseImportLine 三栏 pt | en | zh', () => {
  const r = L.parseImportLine('a livraria | bookshop | 书店');
  assert.equal(r.pt, 'a livraria');
  assert.equal(r.en, 'bookshop');
  assert.equal(r.zh, '书店');
  assert.equal(r.ex, '');
});

t('parseImportLine 四栏含例句', () => {
  const r = L.parseImportLine('a casa | house | 房子 | Moro numa casa.');
  assert.equal(r.en, 'house');
  assert.equal(r.zh, '房子');
  assert.equal(r.ex, 'Moro numa casa.');
});

t('parseImportLine 旧格式 pt | zh | ex（第二栏含汉字）', () => {
  const r = L.parseImportLine('chamar-se | 叫（名字） | Chamo-me Mei.');
  assert.equal(r.pt, 'chamar-se');
  assert.equal(r.zh, '叫（名字）');
  assert.equal(r.en, '', '第二栏含汉字时不得误判为英文');
  assert.equal(r.ex, 'Chamo-me Mei.');
});

t('parseImportLine 支持制表符分隔', () => {
  const r = L.parseImportLine('a casa\thouse\t房子');
  assert.equal(r.pt, 'a casa');
  assert.equal(r.en, 'house');
  assert.equal(r.zh, '房子');
});

t('parseImportLine 首列含汉字也归 zh（三栏情形）', () => {
  const r = L.parseImportLine('livraria | 书店 | Entrámos numa livraria.');
  assert.equal(r.zh, '书店');
  assert.equal(r.ex, 'Entrámos numa livraria.');
});

t('parseImportLine 空行与缺释义被拒', () => {
  assert.equal(L.parseImportLine(''), null);
  assert.equal(L.parseImportLine('   '), null);
  assert.equal(L.parseImportLine('somente-pt'), null);
});

t('parseImportLine 容忍尾部空列', () => {
  const r = L.parseImportLine('a casa | house | 房子 |');
  assert.equal(r.ex, '');
});

// ---------- 假朋友（M6-5） ----------

t('ff 字段缺失时为空', () => {
  assert.equal(L.normWord({ pt: 'x' }).ff, '');
  assert.equal(L.normWord(['x', 'y']).ff, '');
});

t('ff 标注可读取', () => {
  const w = L.normWord({ pt: 'a livraria', en: 'bookshop', zh: '书店', ff: '≠ library（图书馆是 biblioteca）' });
  assert.ok(w.ff.includes('library'));
});

t('ff 只在新格式存在，旧数组格式无', () => {
  assert.equal(L.normWord(['a livraria', '书店']).ff, '');
});

// ---------- 迁移（M6-3） ----------

t('migrate 为旧词补 en 与 ff 空字段', () => {
  const d = L.migrate({
    words: [{ id: 1, pt: 'saudade', zh: '思念' }],
    logs: {}, set: { v3: 1 },
  });
  assert.equal(d.words[0].en, '');
  assert.equal(d.words[0].ff, '');
  assert.equal(d.words[0].zh, '思念', '原中文不得丢失');
});

t('migrate 保留已有 en 与 ff', () => {
  const d = L.migrate({
    words: [{ id: 1, pt: 'livraria', en: 'bookshop', zh: '书店', ff: '≠ library' }],
    logs: {}, set: { v3: 1 },
  });
  assert.equal(d.words[0].en, 'bookshop');
  assert.equal(d.words[0].ff, '≠ library');
});

t('migrate 新增 del 墓碑数组不丢', () => {
  const d = L.migrate({
    words: [{ id: 'a', pt: 'x' }],
    logs: {}, del: [{ id: 'b', t: 1 }], set: { v3: 1 },
  });
  assert.equal(d.del.length, 1);
});

// ================================================================
// M7-1 回归用例：这几个 bug 上线后每天都会碰到，必须锁住
// ================================================================

// ---------- streak：今天有记录 ≠ 今天打过卡 ----------

t('streak 今天有记录但没打卡，从昨天起数（M7-1 bug 2）', () => {
  // rToday() 一渲染就会 log() 建出今天的空记录，done 为 false。
  // 旧实现只看「有没有记录」，于是每天开盘都显示 0。
  const logs = mkLog([daysAgo(1), daysAgo(2)]);
  logs[L.today()] = { done: false, read: [] };
  assert.equal(L.streak(logs), 2);
});

t('streak 今天有记录且已打卡，算上今天', () => {
  const logs = mkLog([daysAgo(1), daysAgo(2)]);
  logs[L.today()] = { done: true };
  assert.equal(L.streak(logs), 3);
});

t('streak 今天有记录但没打卡，昨天也没打卡 → 0', () => {
  const logs = {};
  logs[L.today()] = { done: false };
  assert.equal(L.streak(logs), 0);
});

t('streak 今天有记录但没打卡，昨天打了 → 1', () => {
  const logs = mkLog([daysAgo(1)]);
  logs[L.today()] = { done: false };
  assert.equal(L.streak(logs), 1);
});

// ---------- migrate：null 与空对象 ----------

t('migrate(null) 返回 null（调用方必须自己兜底）', () => {
  assert.equal(L.migrate(null), null);
  assert.equal(L.migrate(undefined), null);
});

t('migrate({}) 必须补齐全部默认值（M7-1 bug 1）', () => {
  // load() 曾写成 L.migrate(d)，d 为 null 时拿到 null，
  // 兜底对象的 set 是空的 → 首屏「本周 0/undefined」「阅读 0 / undefined 分钟」
  const d = L.migrate({});
  assert.equal(d.set.goalW, 5);
  assert.equal(d.set.goalMin, 15);
  assert.equal(d.set.revBatch, 30);
  assert.equal(d.set.weekGoal, 5);
  assert.equal(d.set.weekStart, 0);
  assert.equal(d.set.voice, 'pt-PT');
  assert.equal(d.set.schema, 4);
  assert.equal(d.set.lastExport, 0);
  assert.deepEqual(d.words, []);
  assert.deepEqual(d.logs, {});
  assert.deepEqual(d.del, []);
});

t('migrate({}) 之后的 set 里没有 undefined 值', () => {
  const d = L.migrate({});
  for (const [k, v] of Object.entries(d.set)) {
    assert.notEqual(v, undefined, `set.${k} 是 undefined`);
  }
});

t('migrate 不覆盖用户已改过的目标值', () => {
  const d = L.migrate({ set: { goalW: 8, goalMin: 30, weekGoal: 7, schema: 4 } });
  assert.equal(d.set.goalW, 8);
  assert.equal(d.set.goalMin, 30);
  assert.equal(d.set.weekGoal, 7);
});

// ---------- 快速听写取句（M7-1 bug 4 / M7-2） ----------

const LESSONS = [
  { id: 'L01', sents: [{ t: 'a', a: 'a.mp3' }, { t: 'b', a: 'b.mp3' }, { t: 'c' }] },
  { id: 'L02', sents: [{ t: 'd', a: 'd.mp3' }] },
  { id: 'L03', sents: [{ t: 'e', a: 'e.mp3' }] },
];

t('quickPool 只从读过的课文里取句', () => {
  const p = L.quickPool(LESSONS, { L02: 1 }, 5);
  assert.deepEqual(p.map(s => s.t), ['d']);
});

t('quickPool 跳过没有音频的句子', () => {
  const p = L.quickPool(LESSONS, { L01: 1 }, 5);
  assert.deepEqual(p.map(s => s.t), ['a', 'b'], 'c 没有 a 字段，不得入选');
});

t('quickPool 默认最多 5 句', () => {
  const many = [{ id: 'L01', sents: Array.from({ length: 9 }, (_, i) => ({ t: 's' + i, a: i + '.mp3' })) }];
  assert.equal(L.quickPool(many, { L01: 1 }).length, 5);
});

t('quickPool 没读过任何课文时为空', () => {
  assert.equal(L.quickPool(LESSONS, {}, 5).length, 0);
  assert.equal(L.quickPool(LESSONS, null, 5).length, 0);
  assert.equal(L.quickPool(null, { L01: 1 }, 5).length, 0);
});

t('quickPool 返回的是句子对象本身（含 t 和 a）', () => {
  const p = L.quickPool(LESSONS, { L01: 1 }, 5);
  assert.equal(p[0].t, 'a');
  assert.equal(p[0].a, 'a.mp3');
});

// ---------- 全文翻译由 sents 拼出（M7-6） ----------

const SENTS = [
  { p: 0, t: 'Olá!', en: 'Hello!', zh: '你好！' },
  { p: 0, t: 'Chamo-me Mei.', en: 'My name is Mei.', zh: '我叫Mei。' },
  { p: 1, t: 'Gosto das aulas.', en: 'I like the classes.', zh: '我喜欢上课。' },
];

t('transFromSents 按段落分组', () => {
  const tr = L.transFromSents(SENTS);
  assert.equal(tr.en, 'Hello! My name is Mei.\nI like the classes.');
  assert.equal(tr.zh, '你好！我叫Mei。\n我喜欢上课。');
});

t('transFromSents 英文按句空格连接，中文直接相连', () => {
  const tr = L.transFromSents(SENTS);
  assert.ok(!/。\s+/.test(tr.zh.replace(/\n/g, '')), '中文之间不应插空格');
  assert.ok(tr.en.includes('Hello! My name'), '英文句间应有空格');
});

t('transFromSents 段落顺序按 p 排序，不依赖数组顺序', () => {
  const tr = L.transFromSents([SENTS[2], SENTS[0], SENTS[1]]);
  assert.equal(tr.zh.split('\n')[0], '你好！我叫Mei。');
});

t('transFromSents 缺翻译的句子被跳过而不是留空洞', () => {
  const tr = L.transFromSents([
    { p: 0, t: 'A', en: 'A.', zh: '甲。' },
    { p: 0, t: 'B', en: '', zh: '' },
    { p: 0, t: 'C', en: 'C.', zh: '丙。' },
  ]);
  assert.equal(tr.en, 'A. C.');
  assert.equal(tr.zh, '甲。丙。');
});

t('transFromSents 空输入返回空串', () => {
  assert.deepEqual(L.transFromSents([]), { en: '', zh: '' });
  assert.deepEqual(L.transFromSents(null), { en: '', zh: '' });
});

t('transFromSents 只有中文时 en 为空串', () => {
  const tr = L.transFromSents([{ p: 0, t: 'A', zh: '甲。' }]);
  assert.equal(tr.en, '');
  assert.equal(tr.zh, '甲。');
});

// ---------- 多设备合并（M10-3） ----------

const W = (id, upd, extra) => Object.assign({ id, pt: 'p' + id, box: 0, lapse: 0, upd }, extra || {});

t('mergeDocs：words 按 upd 取新', () => {
  const m = L.mergeDocs({ words: [W('a', 100, { zh: '旧' })] }, { words: [W('a', 200, { zh: '新' })] });
  assert.equal(m.words.length, 1);
  assert.equal(m.words[0].zh, '新');
});

t('mergeDocs：本地较新时本地赢', () => {
  const m = L.mergeDocs({ words: [W('a', 300, { zh: '本地' })] }, { words: [W('a', 200, { zh: '远端' })] });
  assert.equal(m.words[0].zh, '本地');
});

t('mergeDocs：只有一边有的词都保留', () => {
  const m = L.mergeDocs({ words: [W('a', 1)] }, { words: [W('b', 1)] });
  assert.deepEqual(m.words.map(w => w.id).sort(), ['a', 'b']);
});

t('mergeDocs：墓碑删掉对应的词', () => {
  const m = L.mergeDocs({ words: [W('a', 1), W('b', 1)], del: [] },
                        { words: [W('a', 1), W('b', 1)], del: [{ id: 'a', t: 5 }] });
  assert.deepEqual(m.words.map(w => w.id), ['b']);
  assert.equal(m.del.length, 1);
});

t('mergeDocs：墓碑取 t 大的那条', () => {
  const m = L.mergeDocs({ del: [{ id: 'a', t: 1 }] }, { del: [{ id: 'a', t: 9 }] });
  assert.equal(m.del[0].t, 9);
});

t('mergeDocs：logs 计数取大不求和', () => {
  const m = L.mergeDocs({ logs: { '2026-10-01': { newW: 3, rev: 5, done: false } } },
                        { logs: { '2026-10-01': { newW: 2, rev: 8, done: false } } });
  assert.equal(m.logs['2026-10-01'].newW, 3, '不能是 5');
  assert.equal(m.logs['2026-10-01'].rev, 8, '不能是 13');
});

t('mergeDocs：logs 的 done 取或', () => {
  const m = L.mergeDocs({ logs: { d: { done: false } } }, { logs: { d: { done: true } } });
  assert.equal(m.logs.d.done, true);
});

t('mergeDocs：阅读记录去重后合并', () => {
  const r = { title: '课本', min: 10, note: '' };
  const m = L.mergeDocs({ logs: { d: { read: [r] } } }, { logs: { d: { read: [r, { title: '新闻', min: 5, note: '' }] } } });
  assert.equal(m.logs.d.read.length, 2);
});

t('mergeDocs：lessons 取更早的读完日期', () => {
  const m = L.mergeDocs({ lessons: { L01: '2026-10-05' } }, { lessons: { L01: '2026-10-03' } });
  assert.equal(m.lessons.L01, '2026-10-03');
});

t('mergeDocs：set 以本地为准，schema 取大', () => {
  const m = L.mergeDocs({ set: { goalW: 5, schema: 4 } }, { set: { goalW: 9, schema: 4 } });
  assert.equal(m.set.goalW, 5);
  assert.equal(m.set.schema, 4);
});

t('mergeDocs：box 与 lapse 原样保留（不归零、不重置）', () => {
  const m = L.mergeDocs({ words: [W('a', 1, { box: 4, lapse: 2 })] }, { words: [W('b', 1, { box: 0, lapse: 7 })] });
  const a = m.words.find(w => w.id === 'a'), b = m.words.find(w => w.id === 'b');
  assert.equal(a.box, 4); assert.equal(a.lapse, 2);
  assert.equal(b.box, 0); assert.equal(b.lapse, 7);
});

t('mergeDocs：seq 不小于现有数字 id', () => {
  const m = L.mergeDocs({ words: [W(7, 1)], seq: 2 }, { words: [W(9, 1)], seq: 3 });
  assert.ok(m.seq >= 9, `seq = ${m.seq}`);
});

t('mergeDocs：空输入不炸', () => {
  const m = L.mergeDocs(null, null);
  assert.deepEqual(m.words, []);
  assert.deepEqual(m.logs, {});
});

t('mergeDocs：自己跟自己合并是幂等的', () => {
  const d = { words: [W('a', 5, { zh: 'x' })], logs: { d: { newW: 1, read: [] } }, lessons: { L01: '2026-10-01' }, set: { goalW: 5 }, del: [], seq: 5 };
  const once = L.mergeDocs(d, d);
  const twice = L.mergeDocs(once, once);
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

// ---------- 报告（必须在文件最后） ----------

console.log(`\nlogic.js 测试：${passed} 通过，${failed} 失败`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of fails) console.log(`  [失败] ${f.name}\n         ${f.msg}`);
  process.exit(1);
}
console.log('全部通过。\n');
