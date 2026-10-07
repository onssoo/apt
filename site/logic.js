/* logic.js —— 纯函数层。不得触碰 DOM、localStorage、网络。
 * 这些函数被 index.html 与 tools/test_logic.mjs 共用，
 * 因此必须保持无副作用，方便在 node 下直接测试。
 * 契约见 docs/CONTRACT.md 第 11 章。
 */
(function (root) {
'use strict';

// ---------- 日期 ----------

/** 本地日期 → YYYY-MM-DD（不走 UTC，避免跨时区错日） */
function day(d) {
  const t = d || new Date();
  const s = new Date(t.getTime() - t.getTimezoneOffset() * 60000);
  return s.toISOString().slice(0, 10);
}

/** 今天 */
function today() { return day(new Date()); }

/** 今天 + n 天 → YYYY-MM-DD */
function addDays(n, from) {
  const d = from ? new Date(from.getTime()) : new Date();
  d.setDate(d.getDate() + n);
  return day(d);
}

/** a、b 两个 YYYY-MM-DD 相差的天数（b - a） */
function daysBetween(a, b) {
  const pa = Date.parse(a + 'T00:00:00');
  const pb = Date.parse(b + 'T00:00:00');
  return Math.round((pb - pa) / 86400000);
}

/** 周一为一周之首：返回该日期所在周的周一 */
function mondayOf(d) {
  const t = d ? new Date(d.getTime()) : new Date();
  const dow = (t.getDay() + 6) % 7;// 周一=0
  t.setDate(t.getDate() - dow);
  return day(t);
}

// ---------- 间隔重复 ----------

/** 各熟练度对应的复习间隔（天）。下标即box。 */
const INT = [0, 1, 2, 4, 7, 15, 30];

/** 「已掌握」口径：box >= 5（与统计页一致，不是 6） */
const MASTERED_BOX = 5;

/**
 * 复习调度。
 * 记住了 → box+1（上限 6），due = 今天 + INT[新box]
 * 没记住 → box = 0，due = 今天
 * 注意：没记住的词由调用方放回队尾（当日必现），本函数只算日期。
 */
function schedule(word, remembered, refDate) {
  const base = refDate ? new Date(refDate.getTime()) : new Date();
  const box = remembered ? Math.min((word.box | 0) + 1, 6) : 0;
  return {
    box: box,
    due: addDays(INT[box], base),
    lapse: (word.lapse | 0) + (remembered ? 0 : 1),
  };
}

/** 到期词（due <= 今天）。 */
function due(words, refDay) {
  const t = refDay || today();
  return (words || []).filter(w => w.due <= t);
}

/** 是否处于积压（待复习超过 threshold 个）。积压时暂停加新词。 */
function isBacklogged(words, threshold, refDay) {
  return due(words, refDay).length > (threshold || 50);
}

/** 取一轮队列：到期的前 limit 个，不足则全取。 */
function takeBatch(words, limit, refDay) {
  const d = due(words, refDay);
  return d.length > limit ? d.slice(0, limit) : d;
}

/**
 * 按段落把逐句翻译拼成全文翻译。
 *
 * sents 是逐句翻译的唯一来源（M7-6）：不再单独维护 trans / trans_lines，
 * 否则同一份译文存三遍迟早对不上。英文按句以空格连接，中文直接相连。
 */
function transFromSents(sents) {
  const P = {};
  (sents || []).forEach(s => {
    if (!s || !s.t) return;
    const p = s.p || 0;
    (P[p] = P[p] || []).push(s);
  });
  const en = [], zh = [];
  Object.keys(P).map(Number).sort((a, b) => a - b).forEach(p => {
    const g = P[p];
    const e = g.map(s => (s.en || '').trim()).filter(Boolean).join(' ');
    const z = g.map(s => (s.zh || '').trim()).filter(Boolean).join('');
    if (e) en.push(e);
    if (z) zh.push(z);
  });
  return { en: en.join('\n'), zh: zh.join('\n') };
}

/**
 * 快速听写的取句池：从「她读过的课文」里收集带音频的句子。
 * 纯函数，不打乱顺序（洗牌由调用方做），便于测试。
 * @param lessons 材料里的课文数组
 * @param readIds 已读课文表（D.lessons），键为课文 id
 * @param n 取多少句，默认 5
 */
function quickPool(lessons, readIds, n) {
  const out = [];
  (lessons || []).forEach(l => {
    if (!l || !readIds || !readIds[l.id]) return;
    (l.sents || []).forEach(s => { if (s && s.a) out.push(s); });
  });
  return out.slice(0, n > 0 ? n : 5);
}

// ---------- 连续打卡 ----------

/**
 * 连续打卡天数。
 * 今天已打卡则从今天起数；否则从昨天起数（今天还没开始，不算断）。
 *
 * 注意不能写成「今天有没有记录」：rToday() 每次渲染都会 log() 建出
 * 今天的空记录，所以记录总是存在但 done 为 false。必须看 done。
 */
function streak(logs, refDate) {
  const L = logs || {};
  const t = refDate ? new Date(refDate.getTime()) : new Date();
  if (!(L[day(t)] && L[day(t)].done)) t.setDate(t.getDate() - 1);
  let n = 0;
  while (L[day(t)] && L[day(t)].done) {
    n++;
    t.setDate(t.getDate() - 1);
  }
  return n;
}

/**
 * 周达标天数：本周一至今天之间 done 为真的天数。
 * 断一天不清零 —— 这是连续天数的兜底。
 */
function weekCount(logs, refDate) {
  const L = logs || {};
  const base = refDate ? new Date(refDate.getTime()) : new Date();
  const mon = mondayOf(base);              // YYYY-MM-DD
  const todayStr = day(base);
  let n = 0;
  const cur = new Date(mon + 'T00:00:00');  // 本地时间零点，避免时区偏移
  while (day(cur) <= todayStr) {
    const k = day(cur);
    if (L[k] && L[k].done) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

/** 本周是否已达标（weekCount >= goal）。 */
function weekMet(logs, goal, refDate) {
  return weekCount(logs, refDate) >= (goal || 5);
}

// ---------- 听写判定 ----------

/** 归一化：转小写、去标点（保留字母数字空白与连字符）、按空白切词。 */
function nrm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** 去变音符号（NFD 分解后丢掉组合记号）。 */
function base(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * 逐词比对作答与参考句。
 * 完全一致 → ok；去重音后一致 → accent（重音符号错）；不一致或缺失 → miss。
 * 返回 {html, ok, m}，m 为参考词数。
 */
function cmpW(ans, ref) {
  const a = nrm(ans);
  const b = nrm(ref);
  const n = a.length;
  const m = b.length;

  // 最长公共子序列：L[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const L = [];
  for (let i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = base(a[i]) === base(b[j]) ? L[i + 1][j + 1] + 1
                                          : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  let ok = 0;
  while (j < m) {
    if (i < n && base(a[i]) === base(b[j])) {
      const exact = a[i] === b[j];
      if (exact) ok++;
      out.push({ cls: exact ? 'ok' : 'ac', w: b[j] });
      i++; j++;
    } else if (i < n && L[i + 1][j] >= L[i][j + 1]) {
      i++;                                  // 作答里多出来的词，跳过
    } else {
      out.push({ cls: 'no', w: b[j] });// 参考里有、作答里没有
      j++;
    }
  }
  return { parts: out, ok: ok, m: m };
}

// ---------- 切句 ----------

/**
 * 现场切句（materials.json 缺 sents 时的兜底）。
 * 按换行分段，按句末标点切；记录段落序号。
 * 返回 [{t, p}]
 */
function splitS(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let p = 0; p < lines.length; p++) {
    const para = lines[p].trim();
    if (!para) continue;
    const parts = para.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
    for (const s of parts) {
      const t = s.trim();
      if (t) out.push({ t: t, p: p });
    }
  }
  return out;
}

/** 送入 TTS 前的文本清洗：省略号与破折号转空格，压缩空白。 */
function say(s) {
  return String(s || '').replace(/^[—–-]\s*/, '').replace(/…/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---------- 双释义（M6） ----------

/**
 * 释义显示模式。
 * 'both'  → 英文为主，中文淡色在下（默认）
 * 'en'    → 只英
 * 'zh'    → 只中
 */
const DEFAULT_SHOW = 'both';

/**
 * 归一化一个生词条目，兼容两种数据格式（M6-1）。
 * 新格式 {pt, en, zh, ex, ff?}；旧格式 [pt, zh, ex?]
 */
function normWord(w) {
  if (w && typeof w === 'object' && !Array.isArray(w)) {
    return {
      pt: String(w.pt || '').trim(),
      en: String(w.en || '').trim(),
      zh: String(w.zh || '').trim(),
      ex: String(w.ex || '').trim(),
      ff: String(w.ff || '').trim(),
    };
  }
  if (Array.isArray(w)) {
    return {
      pt: String(w[0] || '').trim(),
      en: '',
      zh: String(w[1] || '').trim(),
      ex: String(w[2] || '').trim(),
      ff: '',
    };
  }
  return { pt: '', en: '', zh: '', ex: '', ff: '' };
}

/**
 * 归一化全文翻译，兼容两种格式。
 * 新格式 {en, zh}；旧格式字符串（视为中文）。
 */
function normTrans(t) {
  if (t && typeof t === 'object') {
    return { en: String(t.en || '').trim(), zh: String(t.zh || '').trim() };
  }
  if (typeof t === 'string') return { en: '', zh: t.trim() };
  return { en: '', zh: '' };
}

/**
 * 按显示模式取出该显示的释义。
 * 返回 {en, zh}，不显示的一侧为空串。
 */
function gloss(word, mode) {
  const w = normWord(word);
  const m = mode || DEFAULT_SHOW;
  return {
    en: (m === 'zh') ? '' : w.en,
    zh: (m === 'en') ? '' : w.zh,
  };
}

/** 搜索匹配：pt / en / zh 任一命中即可（大小写与重音不敏感）。 */
function matchWord(w, q) {
  if (!q) return true;
  const n = normWord(w);
  const needle = base(q).toLowerCase();
  return [n.pt, n.en, n.zh].some(x => x && base(x).toLowerCase().includes(needle));
}

/**
 * 批量导入的行解析（M6-4）。支持三种写法：
 *   pt |释义                 → 第二栏含汉字归zh，否则归 en
 *   pt | en | zh             → 三栏
 *   pt | en | zh | ex        → 四栏
 *   pt | zh | ex（旧）       → 第二栏含汉字时视为旧格式
 * 返回 {pt, en, zh, ex, ff}
 */
function parseImportLine(line) {
  const cells = String(line || '').split(/\t|\|/).map(x => x.trim());
  const out = { pt: '', en: '', zh: '', ex: '', ff: '' };
  if (!cells[0]) return null;
  out.pt = cells[0];
  const rest = cells.slice(1).filter(x => x !== '');

  if (rest.length === 0) return null;

  // 含汉字的一律视为中文
  const hasHan = s => /[\u4e00-\u9fff]/.test(s);

  if (rest.length === 1) {
    if (hasHan(rest[0])) out.zh = rest[0];else out.en = rest[0];
    return out;
  }

  if (hasHan(rest[0])) {
    // 旧格式 pt | zh | ex
    out.zh = rest[0];
    out.ex = rest[1] || '';
    return out;
  }

  // 三栏及以上：pt | en | zh [| ex]
  out.en = rest[0];
  out.zh = rest[1] || '';
  out.ex = rest[2] || '';
  return out;
}

/**
 * 数据结构迁移。所有结构变更集中在这里，按 set.schema 递增。
 * 入参为 localStorage 读出的文档，返回迁移后的文档（不改原对象）。
 *
 * 硬规则（docs/TASKS.md 第 13 条）：
 * - lapse 只增不减，任何情况下都不重置
 * - box 与 lapse 语义不同，禁止一起清零
 */
const SCHEMA = 4;

function migrate(d) {
  if (!d || typeof d !== 'object') return null;
  d.words = Array.isArray(d.words) ? d.words : [];
  d.logs = (d.logs && typeof d.logs === 'object') ? d.logs : {};
  d.lessons = (d.lessons && typeof d.lessons === 'object') ? d.lessons : {};
  d.del = Array.isArray(d.del) ? d.del : [];
  d.set = (d.set && typeof d.set === 'object') ? d.set : {};

  // 默认值：5 词 / 15 分钟（原 10/20 偏高，见 DESIGN 14.1）
  if (!d.set.voice) d.set.voice = 'pt-PT';
  if (!(d.set.goalW > 0)) d.set.goalW = 5;
  if (!(d.set.goalMin > 0)) d.set.goalMin = 15;
  if (!(d.set.revBatch > 0)) d.set.revBatch = 30;
  if (!(d.set.weekGoal > 0)) d.set.weekGoal = 5;
  if (d.set.weekStart == null) d.set.weekStart = 0;
  if (!d.set.lastExport) d.set.lastExport = 0;
  if (!d.set.show) d.set.show = 'both';       //释义显示：英+中（默认）
  d.seq = d.seq || 0;

  // 旧版只有 set.v3，视为 schema 3
  const from = d.set.schema || (d.set.v3 ? 3 : 0);
  if (from < 4) {
    for (const w of d.words) {
      // lapse 只增不减：缺失时补 0，绝不重置已有值
      if (typeof w.lapse !== 'number' || w.lapse < 0) w.lapse = 0;
      // box 缺省补 0
      if (typeof w.box !== 'number') w.box = 0;
      // M6：英文释义与假朋友标注（可选字段，缺失即无）
      if (typeof w.en !== 'string') w.en = '';
      if (typeof w.ff !== 'string') w.ff = '';
    }
    d.set.schema = 4;
    delete d.set.v3;
  }

  return d;
}

// ---------- 多设备合并（M10-3） ----------

/**
 * 合并两份文档（本地 + 远端）。规则：
 * - words：按 id 并集，`upd` 大的赢；没有 upd 当 0
 * - del：墓碑按 id 并集，t 取大；合并后按墓碑删掉对应单词
 * - logs：按日并集。计数（newW/rev/sh/dc）**取大不求和** —— 两台设备各自
 *   练过同一天，求和会翻倍；阅读记录按 (标题,分钟,笔记) 去重后合并；done 取或
 * - lessons：同一课取**更早**的读完日期
 * - set：设置是每台设备自己的偏好，**以本地为准**；schema 取大
 * - seq：取大，并且不小于现有数字 id 的最大值，避免新词撞号
 *
 * 硬规则：`box` 是熟练度、`lapse` 是历史失败次数，合并只做「整条取新」，
 * 任何情况下都不去掉、不归零、不重置。
 */
function mergeDocs(a, b) {
  const A = a || {}, B = b || {};
  const out = { words: [], logs: {}, lessons: {}, set: {}, del: [], seq: 0 };

  out.set = Object.assign({}, B.set || {}, A.set || {});     // 本地优先
  out.set.schema = Math.max((A.set || {}).schema | 0, (B.set || {}).schema | 0) || SCHEMA;

  const delMap = new Map();
  [].concat(A.del || [], B.del || []).forEach(d => {
    if (!d || d.id == null) return;
    const k = String(d.id), cur = delMap.get(k);
    if (!cur || (d.t | 0) > (cur.t | 0)) delMap.set(k, { id: d.id, t: d.t | 0 });
  });
  out.del = [...delMap.values()];

  const wMap = new Map();
  const putWord = w => {
    if (!w || w.id == null) return;
    const k = String(w.id), cur = wMap.get(k);
    if (!cur || (w.upd | 0) >= (cur.upd | 0)) wMap.set(k, w);
  };
  (B.words || []).forEach(putWord);
  (A.words || []).forEach(putWord);
  out.words = [...wMap.values()].filter(w => !delMap.has(String(w.id)));

  const days = new Set([].concat(Object.keys(A.logs || {}), Object.keys(B.logs || {})));
  days.forEach(d => {
    const x = (A.logs || {})[d] || {}, y = (B.logs || {})[d] || {};
    const read = [], seen = new Set();
    [].concat(x.read || [], y.read || []).forEach(r => {
      const k = [r && r.title, r && r.min, r && r.note].join('\u0001');
      if (seen.has(k)) return;
      seen.add(k); read.push(r);
    });
    const day = {
      read,
      newW: Math.max(x.newW | 0, y.newW | 0),
      rev: Math.max(x.rev | 0, y.rev | 0),
      sh: Math.max(x.sh | 0, y.sh | 0),
      dc: Math.max(x.dc | 0, y.dc | 0),
      done: !!(x.done || y.done),
    };
    const at = Math.max(x.checkinAt | 0, y.checkinAt | 0);
    if (at) day.checkinAt = at;
    out.logs[d] = day;
  });

  const lids = new Set([].concat(Object.keys(A.lessons || {}), Object.keys(B.lessons || {})));
  lids.forEach(id => {
    const x = (A.lessons || {})[id], y = (B.lessons || {})[id];
    out.lessons[id] = (x && y) ? (x < y ? x : y) : (x || y);
  });

  let maxNum = 0;
  out.words.forEach(w => { const n = Number(w.id); if (Number.isFinite(n)) maxNum = Math.max(maxNum, n); });
  out.seq = Math.max(A.seq | 0, B.seq | 0, maxNum);
  return out;
}

// ---------- 导出 ----------

const API = {
  day: day, today: today, addDays: addDays, daysBetween: daysBetween,
  mondayOf: mondayOf,
  INT: INT, MASTERED_BOX: MASTERED_BOX,
  schedule: schedule, due: due, isBacklogged: isBacklogged, takeBatch: takeBatch,
  quickPool: quickPool,
  streak: streak, weekCount: weekCount, weekMet: weekMet,
  nrm: nrm, base: base, cmpW: cmpW,
  splitS: splitS, say: say,
  DEFAULT_SHOW: DEFAULT_SHOW,
  normWord: normWord, normTrans: normTrans, gloss: gloss,
  transFromSents: transFromSents,
  matchWord: matchWord, parseImportLine: parseImportLine,
  migrate: migrate, SCHEMA: SCHEMA,
  mergeDocs: mergeDocs,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.Logic = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);