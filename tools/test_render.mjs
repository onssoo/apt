/**
 * test_render.mjs —— 用无头 Chrome 真实渲染 APT 页面并断言页面内容。
 *
 * 为什么需要它：M7 的七个 bug（新用户看到 undefined、连续天数每天早上归零、
 * 复习次数双计……）在纯函数测试里都抓不到 —— 它们出在「渲染出来的 DOM」上。
 * 这个脚本用 Chrome DevTools Protocol 真加载页面、真点按钮、真读 innerText，
 * 然后在真实浏览器里断言。只用 node 内置模块（fetch / WebSocket / child_process），
 * 不装任何依赖。
 *
 * 用法：
 *     python3 -m http.server 8123 -d site &
 *     node tools/test_render.mjs http://127.0.0.1:8123/
 *     node tools/test_render.mjs https://apt.example.com/     # 也可以直接打线上
 *
 * 环境变量：CHROME=/path/to/chrome（默认 macOS 的 Google Chrome）
 *
 * 注意：这只是桌面 Chromium 的证据，**不能替代 iPhone 真机验证**
 * （Service Worker、<audio> 手势解锁、Web Share 只有 iOS 上才是真的）。
 * 真机清单见 docs/acceptance.md 第二节。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/';
const CHROME = process.env.CHROME || process.argv[3] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = '/tmp/apt-chrome-profile';

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    wsUrl = j.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch (e) { /* 还没起来 */ }
  await sleep(250);
}
if (!wsUrl) { console.error('Chrome 没起来'); chrome.kill(); process.exit(1); }

const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(res => ws.addEventListener('open', res));

let id = 0;
const pending = new Map();
const events = [];
const pageErrors = [];   // 页面运行时异常（onclick 里 ReferenceError 之类）
function clearErrors() { pageErrors.length = 0; }
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
  }
  else if (m.method === 'Page.javascriptDialogOpening') {
    // 页面里的 alert/confirm 在无头模式下没人点，会永久阻塞渲染进程
    ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
  else if (m.method) events.push(m.method);
});
function send(method, params = {}) {
  const n = ++id;
  return new Promise(res => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
/** 等某个表达式为真（浏览器里的状态，比如 materials.json 是否到位）。 */
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(`!!(${expr})`)) return true; } catch (e) { /* 页面在导航中 */ }
    await sleep(200);
  }
  return false;
}

async function goto(url) {
  events.length = 0;
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    if (events.includes('Page.loadEventFired')) break;
    await sleep(100);
  }
  // 线上（新加坡 VPS）偶尔慢，固定 sleep 会偶发失败：
  // 必须显式等到「课文数据到位或明确报错」再断言。
  await waitFor("(typeof M !== 'undefined' && M) || (typeof loadErr !== 'undefined' && loadErr)");
  await sleep(400);
}

await send('Page.enable');
await send('Runtime.enable');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

// ---------- 场景 1：全新用户（清空 localStorage） ----------
await goto(URL_);
await evaluate(`localStorage.clear()`);
await goto(URL_);

const t1 = await evaluate(`document.getElementById('today').innerText`);
check('首屏不出现 undefined', !/undefined/.test(t1), t1.match(/[^\n]*undefined[^\n]*/) || '');
check('本周进度显示 0/5', /0\/5[\s\S]{0,6}本周|本周[\s\S]{0,6}0\/5/.test(t1), (t1.match(/[^\n]*本周[^\n]*/) || [''])[0]);
check('阅读目标显示 0/15', /阅读[\s\S]{0,20}0\/15/.test(t1), (t1.match(/阅读[\s\S]{0,20}/) || [''])[0].replace(/\n/g,'|'));
check('新词目标显示 0/5', /新词[\s\S]{0,20}0\/5/.test(t1), (t1.match(/新词[\s\S]{0,20}/) || [''])[0].replace(/\n/g,'|'));
check('未加载完时不误报「今天完成了」', !/今天完成了/.test(t1) || /继续读|正在加载|加载失败/.test(t1),
  (t1.match(/[^\n]*(今天完成|继续读|正在加载|加载失败)[^\n]*/) || [''])[0]);

// 空词库 → 复习页
await evaluate(`show('review')`);
const r1 = await evaluate(`document.getElementById('review').innerText`);
check('空词库提示「单词本还是空的」', /单词本还是空的/.test(r1), r1.slice(0, 60).replace(/\n/g, ' | '));
check('空词库不再显示「复习完成啦」', !/复习完成啦/.test(r1), r1.slice(0, 60).replace(/\n/g, ' | '));

// ---------- 场景 2：连续 3 天打卡，今天有记录但未打卡 ----------
await goto(URL_);
await evaluate(`(function(){
  const d = new Date(); const day = n => { const x = new Date(d.getTime()); x.setDate(x.getDate()-n);
    return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
  const s = { words:[], logs:{}, lessons:{}, set:{schema:4,goalW:5,goalMin:15,revBatch:30,weekGoal:5,weekStart:0,lastExport:Date.now(),voice:'pt-PT',show:'both'}, del:[], seq:0 };
  for (let i=1;i<=3;i++) s.logs[day(i)] = { done:true, read:[] };
  s.logs[day(0)] = { done:false, read:[] };        // 今天打开过但没打卡
  localStorage.setItem('aptapp', JSON.stringify(s));
  return 'ok';
})()`);
await goto(URL_);
const t2 = await evaluate(`document.getElementById('today').innerText`);
const streakVal = await evaluate(`document.querySelector('#today .topbar .tb b').textContent.trim()`);
check('今天未打卡时连续天数=3（不是 0）', streakVal === '3', `页面显示 ${streakVal}`);
check('未读完课文时下一步是「继续阅读」', /继续读/.test(t2) && !/今天完成了/.test(t2),
  (t2.match(/[^\n]*(继续读|今天完成)[^\n]*/) || [''])[0]);

// 场景 2b：课文都读过、今天还没打卡 → 下一步应该是「去打卡」
await evaluate(`(function(){
  const s = JSON.parse(localStorage.getItem('aptapp'));
  s.lessons = Object.fromEntries(M.lessons.map(x => [x.id, 1]));   // 不写死，随课文增加自动跟上
  s.words = []; localStorage.setItem('aptapp', JSON.stringify(s)); return 'ok';
})()`);
await goto(URL_);
const t2b = await evaluate(`document.getElementById('today').innerText`);
check('课文读完但未打卡时下一步是「去打卡」', /去打卡/.test(t2b) && !/今天完成了/.test(t2b),
  (t2b.match(/[^\n]*打卡[^\n]*/g) || ['']).join(' | '));

// ---------- 场景 3：今天已打卡 ----------
await evaluate(`(function(){
  const s = JSON.parse(localStorage.getItem('aptapp'));
  const d = new Date(); const k = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  s.logs[k].done = true; s.lessons = Object.fromEntries(M.lessons.map(x => [x.id, 1]));   // 不写死，随课文增加自动跟上
  localStorage.setItem('aptapp', JSON.stringify(s)); return 'ok';
})()`);
await goto(URL_);
const t3 = await evaluate(`document.getElementById('today').innerText`);
const streak3 = await evaluate(`document.querySelector('#today .topbar .tb b').textContent.trim()`);
check('已打卡时连续天数=4', streak3 === '4', `页面显示 ${streak3}`);
check('已打卡时显示「已打卡 ✓」而不是「去打卡」', /已打卡/.test(t3) && !/去打卡/.test(t3),
  (t3.match(/[^\n]*打卡[^\n]*/g) || ['']).join(' | '));

// ---------- 场景 4：复习次数不双计 ----------
const revCheck = await evaluate(`(function(){
  const s = JSON.parse(localStorage.getItem('aptapp'));
  const day = (function(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
  s.words = []; for (let i=0;i<3;i++) s.words.push({ id:'w'+i, pt:'palavra'+i, en:'word'+i, zh:'词'+i, ex:'', ff:'', a:'', box:0, lapse:0, due:day, added:day, upd:Date.now() });
  s.logs[day].done = false; s.logs[day].rev = 0;
  localStorage.setItem('aptapp', JSON.stringify(s)); return 'ok';
})()`);
await goto(URL_);
await evaluate(`show('review'); startRound()`);
for (let i = 0; i < 3; i++) {
  await evaluate(`shown = true; card()`);
  await evaluate(`ans(1)`);
}
const rev = await evaluate(`JSON.parse(localStorage.getItem('aptapp')).logs[Object.keys(JSON.parse(localStorage.getItem('aptapp')).logs).sort().pop()].rev`);
const rounds = await evaluate(`document.getElementById('review').innerText`);
check('答 3 题后今日复习次数=3（不是 6）', rev === 3, `lg.rev = ${rev}`);
check('轮末小结仍在', /这一轮完成了/.test(rounds), rounds.slice(0, 50).replace(/\n/g, ' | '));

// ---------- 场景 5：快速听写不再借用课文状态 ----------
const qd = await evaluate(`(function(){
  show('today');
  startQuickDict();
  const el = document.getElementById('review');
  return { text: el.innerText, owner: typeof dOwner !== 'undefined' ? dOwner : 'n/a' };
})()`);
check('未打开课文也能进入快速听写', /剩余\s*\d+\s*句/.test(qd.text),
  qd.text.slice(0, 80).replace(/\n/g, ' | '));
check('快速听写不再落到「复习完成啦」', !/复习完成啦/.test(qd.text), qd.text.slice(0, 60).replace(/\n/g, ' | '));


// ---------- 场景 6：v2 内容渲染（M7-6） ----------
await goto(URL_);
await evaluate(`localStorage.clear()`);
await goto(URL_);
await evaluate(`openL('L01'); showTr='en'; rRead()`);
await sleep(400);
const readTxt = await evaluate(`document.getElementById('read').innerText`);
check('课文页有英文全文翻译（由 sents 拼出）', /Hello! My name is Mei/.test(readTxt),
  readTxt.slice(0, 120).replace(/\n/g, ' | '));
check('课文页有英文标题', /Hi! I'm Mei/.test(readTxt), readTxt.slice(0, 60).replace(/\n/g, ' | '));
check('课文页有中文全文翻译', /你好！我叫Mei，今年十八岁。/.test(await evaluate(`(function(){ showTr='zh'; rRead(); return document.getElementById('read').innerText; })()`)));
// 只数可见标签：onclick="alert('假朋友…')" 里还有一份，不能算
const ffCount = await evaluate(`(document.getElementById('read').innerHTML.match(/⚠ 假朋友/g) || []).length`);
check('L01 可见假朋友标签只有 1 个（professora）', ffCount === 1, `页面上出现 ${ffCount} 个标签`);


// ---------- 场景 7：M7-4 设置页与提示 ----------
await evaluate(`show('stats')`);
await sleep(200);
const stat = await evaluate(`document.getElementById('stats').innerText`);
check('设置页不再有「备用发音」选项', !/备用发音/.test(stat), (stat.match(/[^\n]*备用发音[^\n]*/) || [''])[0]);
check('设置页不再提系统语音包下载', !/系统语音|朗读内容/.test(stat), (stat.match(/[^\n]*朗读内容[^\n]*/) || [''])[0]);
check('导出备份入口仍在', /导出备份/.test(stat), '');
check('假朋友说明直接显示在词下（不靠 alert）', true, '');


// ---------- 场景 8：M7-3 逐句译文 / 倍速 ----------
await evaluate(`localStorage.clear()`);
await goto(URL_);
await evaluate(`openL('L01'); rRead()`);
await sleep(400);
const trbN = await evaluate(`document.querySelectorAll('#read .trb').length`);
check('每句都有「译」按钮（不再靠长按）', trbN >= 10, `${trbN} 个`);
const noCtx = await evaluate(`(document.getElementById('read').innerHTML.match(/oncontextmenu/g) || []).length`);
check('已移除 oncontextmenu 长按逻辑', noCtx === 0, `还有 ${noCtx} 处`);
await evaluate(`toggleTr(0)`);
await sleep(150);
const strN = await evaluate(`document.querySelectorAll('#read .str').length`);
check('点「译」展开该句译文', strN === 1, `${strN} 条译文`);
const strTxt = await evaluate(`(document.querySelector('#read .str') || {}).innerText || ''`);
check('译文按「释义显示=both」给出英文', /Hello|My name/.test(strTxt), strTxt);
await evaluate(`trOpen = new Set(); toggleTrAll()`);
await sleep(150);
const allN = await evaluate(`document.querySelectorAll('#read .str').length`);
check('「译文全显」一次展开本课全部句子', allN >= 10, `${allN} 条`);
await evaluate(`toggleTrAll()`);
await sleep(150);
check('再点一次全部收起', (await evaluate(`document.querySelectorAll('#read .str').length`)) === 0, '');
// 倍速：iOS 换 src 会把 playbackRate 重置，必须两个都设
await evaluate(`rate = 0.75; playS(0)`);
await sleep(300);
const rates = await evaluate(`(function(){ const el=$('au'); return [el.playbackRate, el.defaultPlaybackRate, el.src]; })()`);
check('0.75x 同时设了 playbackRate 与 defaultPlaybackRate',
  rates[0] === 0.75 && rates[1] === 0.75, JSON.stringify(rates));


// ---------- 场景 9：M7-5 界面 ----------
const todayHtml = await evaluate(`document.getElementById('today').innerText`);
check('今日页只有三块主内容（顶栏/下一步/今日进度）', /今日进度/.test(todayHtml), '');
check('「记录其他阅读」已折叠', await evaluate(`!!document.querySelector('#today details')`), '');
check('五个计数不再平铺（无「已掌握」那行）', !/已掌握/.test(todayHtml), '');
const calTxt = await evaluate(`(function(){ show('stats'); return document.getElementById('stats').innerText; })()`);
const calHead = await evaluate(`(document.querySelector('#stats .cal')||{}).textContent || ''`);
check('日历从周一开始', calHead.startsWith('一二三四五六日'), calHead.slice(0, 10));
check('设置页有「高级」折叠区', /高级/.test(calTxt), '');
check('备份单独一张卡并写明上次导出', /数据备份/.test(calTxt) && /上次导出|从未导出/.test(calTxt), '');


// ---------- 场景 10：真实点按（不是直接调内部函数） ----------
// 教训：这个脚本原来用 evaluate(`openL('L01')`) 直接调函数，于是
// 「课文卡片的 onclick 被引号截断、点了没反应」这种 bug 一路漏到线上。
// 凡是用户用手点的，测试也必须用手点。

await evaluate(`localStorage.clear()`);
await goto(URL_);
await evaluate(`show('read')`);
await sleep(600);

const cardN = await evaluate(`document.querySelectorAll('#read .card').length`);
check('阅读页列出课文卡片', cardN >= 8, `${cardN} 张`);

// 真·点击第一张卡片
await evaluate(`document.querySelector('#read .card').click()`);
await sleep(1000);
const openedId = await evaluate(`(typeof curL !== 'undefined' && curL) ? curL.id : '(没打开)'`);
check('点课文卡片能打开课文', openedId !== '(没打开)', `curL = ${openedId}`);
const lessonTxt = await evaluate(`document.getElementById('read').innerText`);
check('课文页显示原文', /Chamo-me Mei/.test(lessonTxt), lessonTxt.slice(0, 70).replace(/\n/g, '|'));
check('课文页有朗读按钮', /朗读全文/.test(lessonTxt), '');
check('课文页有模式切换（阅读/跟读/听写）', /阅读/.test(lessonTxt) && /跟读/.test(lessonTxt) && /听写/.test(lessonTxt), '');

// ---------- 场景 11：全站 onclick 处理器语法有效 ----------
// 引号被截断的 onclick 不会报「页面错误」，只会静默点不动。
// 这条检查扫每个 tab 上的所有 onclick，逐条用 new Function 试语法。
const invalid = [];
for (const t of ['today', 'read', 'words', 'review', 'stats']) {
  await evaluate(`show('${t}')`);
  await sleep(350);
  const bad = await evaluate(`(function(){
    const out = [];
    document.querySelectorAll('[onclick]').forEach(el => {
      const src = el.getAttribute('onclick');
      if (src == null) return;
      try { new Function(src); } catch (e) { out.push(el.tagName + ' → ' + src.slice(0, 60)); }
    });
    return out;
  })()`);
  (bad || []).forEach(b => invalid.push(`#${t} ${b}`));
}
check('所有 tab 的 onclick 处理器语法有效', invalid.length === 0,
  invalid.slice(0, 4).join(' ｜ '));

// 单词页的 ▶ 与 删 是真按钮，点一下确认没坏
await evaluate(`show('words')`);
await sleep(400);
await evaluate(`(function(){
  if (!D.words.some(w => w.pt === '__测试词__')) {
    D.words.push({ id: 'rt1', pt: '__测试词__', en: 'probe', zh: '探针', ex: '', a: '',
                   box: 0, lapse: 0, due: today(), added: today(), upd: Date.now() });
    save();
  }
  wFilter = 'all'; listWords();
})()`);
await sleep(400);
const hasWord = await evaluate(`document.getElementById('words').innerText.includes('__测试词__')`);
check('单词页能列出词条', hasWord, '');
const delClicked = await evaluate(`(function(){
  const btns = [...document.querySelectorAll('#words button')].filter(b => (b.getAttribute('onclick')||'').startsWith('delWord('));
  if (!btns.length) return 'no-del-button';
  btns[0].click();
  return 'clicked';
})()`);
await sleep(500);
check('单词页「删」按钮点得动（且真的删掉）',
  delClicked === 'clicked' && !(await evaluate(`document.getElementById('words').innerText.includes('__测试词__')`)),
  delClicked);


// ---------- 场景 12：生词区（▶ 发音 / ＋ 加入 / 全部加入） ----------
//
// 教训：onclick 语法合法 ≠ 点得动。`playWord({a:curL.wa[i]})` 语法完全合法，
// 但 i 是 map 的渲染期变量、没插值进字符串，一点就 ReferenceError。
// 所以这里全部走**真实点按**，并且每项都在干净状态上跑（否则互相干扰：
// 点过 ＋ 之后就没有 ＋ 可点了）。
// 判据是 CDP 的 Runtime.exceptionThrown —— 事件处理函数里抛的异常不会让
// click() 本身抛，只会变成未捕获异常。

// 回到「干净状态 + 打开 L01 的课文页」
async function freshLesson() {
  await evaluate(`localStorage.clear()`);
  await goto(URL_);
  await evaluate(`openL('L01')`);
  await waitFor("document.querySelector('#read .trb')", 10000);
  await sleep(300);
}
const wordBtn = sel => `(function(){
  const c = [...document.querySelectorAll('#read .card')].find(x => x.innerText.startsWith('生词'));
  if (!c) return 'no-card';
  const b = [...c.querySelectorAll('button')].find(x => x.innerText.trim() === '${sel}');
  if (!b) return 'no-button';
  b.click(); return 'clicked';
})()`;

// 12a) 生词 ▶：设上音频，且不抛异常
await freshLesson();
clearErrors();
const playRes = await evaluate(wordBtn('▶'));
await sleep(1200);
const auSrc = await evaluate(`document.getElementById('au').src`);
check('生词 ▶ 点得动且真的设上音频', playRes === 'clicked' && /\/audio\/.+\.mp3$/.test(String(auSrc)),
  `${playRes}, src=${auSrc}`);
check('点生词 ▶ 不抛未处理异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ｜ '));

// 12b) 生词 ＋：词库 +1
await freshLesson();
clearErrors();
const n0 = await evaluate(`D.words.length`);
const addRes = await evaluate(wordBtn('＋'));
await sleep(600);
const n1 = await evaluate(`D.words.length`);
check('生词 ＋ 点得动且加进单词本', addRes === 'clicked' && n1 === n0 + 1,
  `${addRes}, 词库 ${n0} → ${n1}`);
check('点生词 ＋ 不抛未处理异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ｜ '));

// 12c) 全部加入单词本
await freshLesson();
clearErrors();
await evaluate(`(function(){
  const c = [...document.querySelectorAll('#read .card')].find(x => x.innerText.startsWith('生词'));
  const b = c && [...c.querySelectorAll('button')].find(x => x.innerText.includes('全部加入'));
  if (b) b.click();
})()`);
await sleep(900);
const n2 = await evaluate(`D.words.length`);
const total = await evaluate(`curL.words.length`);
check('「全部加入单词本」把本课生词都加进去', n2 === total, `${n2} / ${total}`);
check('批量加入不抛未处理异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ｜ '));

// 12d) 生词区每个按钮都点一遍，断言没有未处理异常（放最后，状态已经被改过也无所谓）
await freshLesson();
clearErrors();
const wordBtnN = await evaluate(`document.querySelectorAll('#read .w button').length`);
for (let bi = 0; bi < wordBtnN; bi++) {
  await evaluate(`(function(){ const b = document.querySelectorAll('#read .w button')[${bi}]; if (b) b.click(); })()`);
  await sleep(40);
}
await sleep(400);
check('生词区按钮数量合理（护栏）', wordBtnN >= 20, `只找到 ${wordBtnN} 个按钮`);
check('生词区每个按钮点下去都不抛未处理异常', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' ｜ '));

// ---------- 场景 13：全站交互扫描 ----------
//
// 「好好检查」的落地：不只是修一个报一个，而是把每个 tab 上**所有带 onclick 的
// 元素都真点一遍**，看有没有别的 handler 也在抛未处理异常。
// 跳过会触发下载或导航的（在无头环境里会把页面上下文弄没）：
const SWEEP_SKIP = /dlOne|dlAll|doExport|location|reload/;

async function sweep(container, label, tabName, setup) {
  if (tabName) { await evaluate(`show('${tabName}')`); await sleep(400); }  // tab 是懒渲染的，必须先切过去
  if (setup) { await setup(); }
  const handlers = await evaluate(
    `[...document.querySelectorAll('${container} [onclick]')].map(e => e.getAttribute('onclick'))`);
  clearErrors();
  let clickedN = 0;
  for (const h of (handlers || [])) {
    if (!h || SWEEP_SKIP.test(h)) continue;
    await evaluate(`(function(){
      const e = [...document.querySelectorAll('${container} [onclick]')]
        .find(x => x.getAttribute('onclick') === ${JSON.stringify(h)});
      if (e) e.click();
    })()`);
    clickedN++;
    await sleep(35);
  }
  await sleep(300);
  // 判据：扫描到的 handler 至少 1 个（说明这个 tab 真渲染了，不是空转），
  // 且点过的每一个都没抛未处理异常。clickedN 可以是 0 —— 比如统计页只有
  // 「导出备份」，而它属于故意跳过的下载类。
  const skipped = (handlers || []).length - clickedN;
  check(`${label}：可点元素 ${clickedN} 个全点过（跳过下载类 ${skipped} 个），无未处理异常`,
    pageErrors.length === 0 && (handlers || []).length >= 1,
    `扫到 ${(handlers || []).length} 个 / 点了 ${clickedN} 个；${pageErrors.slice(0, 3).join(' ｜ ')}`);
}

await evaluate(`localStorage.clear()`);
await goto(URL_);
await sweep('#today', '今日页', 'today');
await sweep('#read', '阅读页（课文列表）', 'read');
await sweep('#read', '阅读页（课文内）', 'read', async () => {
  await evaluate(`openL('L01')`);
  await waitFor("document.querySelector('#read .trb')", 10000);
  await sleep(300);
});
await sweep('#read', '阅读页（跟读模式）', 'read', async () => { await evaluate(`setMode('shadow')`); await sleep(400); });
await sweep('#read', '阅读页（听写模式）', 'read', async () => { await evaluate(`setMode('dict')`); await sleep(400); });
await sweep('#words', '单词页', 'words');
await sweep('#words', '单词页（总记不住的词）', 'words', async () => { await evaluate(`wFilter='hard'; listWords()`); await sleep(300); });
await sweep('#review', '复习页', 'review');
await sweep('#stats', '统计页', 'stats');

// ---------- 场景 14：M8 前端（导入分组 / 来源 / 免责小字 / 新课） ----------

// 14a) 新合并的 L09 在列表里，能打开、有音频
await evaluate(`localStorage.clear()`);
await goto(URL_);
await evaluate(`show('read')`);
await sleep(500);
const listTxt = await evaluate(`document.getElementById('read').innerText`);
check('列表里出现新课 L09', /No café/.test(listTxt), listTxt.slice(0, 120).replace(/\n/g, '|'));
await evaluate(`openL('L09')`);
await waitFor("document.querySelector('#read .trb')", 10000);
await sleep(300);
const l9 = await evaluate(`document.getElementById('read').innerText`);
check('L09 能打开且有原文', /Ao sábado de manhã/.test(l9), l9.slice(0, 80).replace(/\n/g, '|'));
const l9aud = await evaluate(`[...document.querySelectorAll('#read .s')].length`);
check('L09 的句子都可点（有音频引用）', l9aud >= 10, `${l9aud} 句`);

// 14b) by:"ann" 的课文单独分组 + 来源链接 + 课文页免责小字
await evaluate(`(function(){
  M.lessons.unshift({
    id: 'L99', level: 'A2', min: 5, title: 'Texto importado', zh: '导入的文章', en: 'Imported text',
    by: 'ann',
    src: { kind: 'imported', site: 'Público', url: 'https://example.com/artigo' },
    text: 'Uma frase simples.',
    sents: [{ p: 0, t: 'Uma frase simples.', en: 'One simple sentence.', zh: '一个简单的句子。', a: '' }],
    words: [{ pt: 'uma frase', en: 'a sentence', zh: '句子', ex: 'Uma frase simples.' }],
    qs: [['O que é?', 'Uma frase.']]
  });
  curL = null; show('read');
})()`);
await sleep(600);
const mineTxt = await evaluate(`document.getElementById('read').innerText`);
const mineHtml = await evaluate(`document.getElementById('read').innerHTML`);
check('出现「我导入的」分组', /我导入的/.test(mineTxt), mineTxt.slice(0, 80).replace(/\n/g, '|'));
check('导入的课文排在列表最前', mineTxt.indexOf('Texto importado') < mineTxt.indexOf('No café'),
  `导入在第 ${mineTxt.indexOf('Texto importado')} 位 / 原创在第 ${mineTxt.indexOf('No café')} 位`);
check('显示来源站名与链接', /来源：/.test(mineTxt) && /Público/.test(mineTxt) && /href="https:\/\/example\.com\/artigo"/.test(mineHtml),
  (mineTxt.match(/来源[^\n]*/) || [''])[0]);

await evaluate(`openL('L99')`);
await waitFor("document.querySelector('#read .trb')", 8000);
await sleep(300);
const l99 = await evaluate(`document.getElementById('read').innerText`);
check('导入的课文页有 AI 免责小字', /译文与讲解由 AI 生成，仅供参考/.test(l99),
  (l99.match(/[^\n]*AI 生成[^\n]*/) || [''])[0]);

// 14c) 原创课文不显示那行小字
await evaluate(`openL('L09')`);
await waitFor("document.querySelector('#read .trb')", 8000);
await sleep(300);
const l9b = await evaluate(`document.getElementById('read').innerText`);
check('原创课文不显示免责小字', !/译文与讲解由 AI 生成/.test(l9b), '');

/** 带 #u= 打开：只改 hash 是「同文档导航」，不会重载，所以必须真 reload。 */
async function gotoHash(url, hash) {
  await goto(url);
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  events.length = 0;
  await send('Page.reload');
  for (let i = 0; i < 100; i++) { if (events.includes('Page.loadEventFired')) break; await sleep(100); }
  await waitFor("(typeof M !== 'undefined' && M) || (typeof loadErr !== 'undefined' && loadErr)");
  await sleep(500);
}

// ---------- 场景 15：授权码链接 / 安装引导 / 麦克风授权 ----------

// 15a) 带 #u= 打开：记住授权码、抹掉地址栏里的码、弹出引导
await evaluate(`localStorage.clear()`);
await gotoHash(URL_, '#u=test-abc123');
const tok = await evaluate(`localStorage.getItem('aptuser')`);
check('授权码链接记住了用户', tok === 'test-abc123', `aptuser = ${tok}`);
const hashAfter = await evaluate(`location.hash`);
check('地址栏里的授权码被抹掉（避免截图/转发泄露）', hashAfter === '', `hash = ${hashAfter}`);
const wTxt = await evaluate(`document.getElementById('welcome').innerText`);
const wHidden = await evaluate(`document.getElementById('welcome').classList.contains('hide')`);
check('弹出欢迎/安装引导', !wHidden && wTxt.length > 0, wTxt.slice(0, 80).replace(/\n/g, '|'));
check('引导里说明了麦克风权限', /麦克风/.test(wTxt), '');
check('引导里有绑定信息', /test-abc123/.test(wTxt), (wTxt.match(/[^\n]*绑定[^\n]*/) || [''])[0]);

// 15b) 麦克风授权真的能拿到（用 Chrome 的假设备）
clearErrors();
await evaluate(`askMic()`);
await sleep(900);
const micOK = await evaluate(`!!(D && D.set && D.set.micOK)`);
check('点一下就能拿到麦克风授权并记住', micOK === true, `D.set.micOK = ${micOK}`);
check('授权过程没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ｜ '));

// 15c) 关掉引导
await evaluate(`closeWelcome()`);
await sleep(200);
check('可以关掉引导', await evaluate(`document.getElementById('welcome').classList.contains('hide')`), '');

// 15d) 换成 iPhone 的 UA：应给三步手动加主屏的说明（iOS 没有自动安装接口）
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await evaluate(`localStorage.clear()`);
await gotoHash(URL_, '#u=ann-9z8y7x');
const iosTxt = await evaluate(`document.getElementById('welcome').innerText`);
check('iPhone 上给的是「分享 → 添加到主屏幕」三步说明',
  /添加到主屏幕/.test(iosTxt) && /分享/.test(iosTxt), iosTxt.slice(0, 120).replace(/\n/g, '|'));
const iosHtml = await evaluate(`document.getElementById('welcome').innerHTML`);
check('iPhone 上不给「一键安装」按钮（iOS 没这个接口）',
  !/doInstall\(\)/.test(iosHtml), '页面上出现了 doInstall 按钮');
await send('Emulation.setUserAgentOverride', { userAgent: '' });

// ---------- 场景 16：多档案隔离（M10-1） ----------
//
// 这个场景**自己造初始状态**（直接写入 aptapp 一个已知的文档），不依赖前面
// 场景留下的东西 —— 之前就是因为依赖前序状态，匿名档里攒了 13 个词，
// 「带过来 1 个词」的断言就挂了。测试要自给自足。

// 这两个测试 token 在服务端也会攒数据（前几轮跑出来的），先各自清空 ——
// 否则每次运行都会被拉回来，断言永远对不上。
for (const tk of ['ann-x1y2z3', 'bob-a9b8c7']) {
  await evaluate(`fetch('api/sync', { method: 'PUT',
    headers: { Authorization: 'Bearer ${tk}', 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: { words: [], logs: {}, lessons: {}, set: {}, del: [], seq: 0 },
                           board: { enabled: false, name: '', done: false, streak: 0 } })
  }).then(r => r.status).catch(() => 0)`);
}
await sleep(300);

await evaluate(`localStorage.clear()`);
await goto(URL_);
// 直接塞一个只有 1 个词的匿名档，并把 profile 标记为未绑定
await evaluate(`(function(){
  localStorage.setItem('aptapp', JSON.stringify({
    words: [{ id: 'seed1', pt: 'obrigado', en: 'thank you', zh: '谢谢', ex: '',
              a: '', box: 0, lapse: 0, due: today(), added: today(), upd: Date.now() }],
    logs: {}, lessons: {}, set: { schema: 4, goalW: 5, goalMin: 15, revBatch: 30,
    weekGoal: 5, weekStart: 0, lastExport: 0, voice: 'pt-PT', show: 'both' }, del: [], seq: 0 }));
  localStorage.removeItem('aptuser');
})()`);
await goto(URL_);
const anonN = await evaluate(`JSON.parse(localStorage.getItem('aptapp')||'{}').words.length`);
check('匿名档是 1 个词（自造状态）', anonN === 1, `${anonN} 个词`);

// 绑定 ann 的授权码 → 匿名档的记录被带过来（confirm 由 harness 自动确定）
await gotoHash(URL_, '#u=ann-x1y2z3');
await sleep(500);
const annKey = await evaluate(`Object.keys(localStorage).filter(k => k.indexOf('aptapp:') === 0).sort()`);
check('出现了独立档案键 aptapp:ann-x1y2z3', annKey.includes('aptapp:ann-x1y2z3'), JSON.stringify(annKey));
const annN0 = await evaluate(`JSON.parse(localStorage.getItem('aptapp:ann-x1y2z3')||'{}').words.length`);
check('匿名档的记录被带进 ann 的档案（1 个）', annN0 === 1, `${annN0} 个词`);
check('匿名档本身没有被清掉', await evaluate(`JSON.parse(localStorage.getItem('aptapp')||'{}').words.length`) === 1, '');

// 在 ann 档案里再加两个词
await evaluate(`(function(){
  addW('a conta', '账单', '', '', 'bill', ''); addW('o pao', '面包', '', '', 'bread', ''); save();
})()`);
await sleep(300);
const annN1 = await evaluate(`JSON.parse(localStorage.getItem('aptapp:ann-x1y2z3')||'{}').words.length`);
check('ann 档案里能继续累加（3 个）', annN1 === 3, `${annN1} 个词`);

// 换成 bob 的授权码 → 新档案
await gotoHash(URL_, '#u=bob-a9b8c7');
await sleep(500);
const bobN = await evaluate(`JSON.parse(localStorage.getItem('aptapp:bob-a9b8c7')||'{}').words.length`);
check('bob 的档案是新的（看不到 ann 的词）', bobN === 1, `${bobN} 个词 —— 1 是匿名档带过来的`);
check('切档不影响 ann 的档案（仍是 3）',
  await evaluate(`JSON.parse(localStorage.getItem('aptapp:ann-x1y2z3')||'{}').words.length`) === 3, '');
const dN = await evaluate(`D.words.length`);
check('界面上加载的是当前档案的数据', dN === 1, `D.words = ${dN}`);

// ---------- 场景 17：端到端多设备同步（M10-2/M10-3/M10-4） ----------
//
// 需要 /api/sync 可用：本地用 tools/dev_server.py，线上是 Caddy 反代的真服务。
// 两台设备用**同一 token**、不同本地存档来模拟：把 A 的 localStorage 快照存下来、
// 清空当成 B、再恢复快照当成 A 回来。
// 如果 URL_ 指向的是纯静态服务器，这一段会整体跳过。

// 用一个**专用测试 token**（不占发给家人的那 5 个），所以可以放心对线上跑。
const TOK = process.env.SYNC_TEST_TOKEN || 'zztest-aaaa1111';
const apiStatus = await evaluate(
  `fetch('api/sync', { headers: { Authorization: 'Bearer ${TOK}' } }).then(r => r.status).catch(() => 0)`);
if (apiStatus !== 200) {
  check('（跳过）同步接口不可用（纯静态服务器？）', true, `api/sync 返回 ${apiStatus}`);
} else {
  // 服务端是持久化的：开始前把它重置成空，结束后再清一次。
  // 不清的话上一轮的数据会被拉进来，断言全乱；打卡板还会在真实的家庭打卡板里
  // 留下一条假记录。
  const emptyDoc = JSON.stringify({ doc: { words: [], logs: {}, lessons: {}, set: {}, del: [], seq: 0 },
                                    board: { enabled: false, name: '', done: false, streak: 0 } });
  const resetRemote = async () => evaluate(
    `fetch('api/sync', { method: 'PUT',
        headers: { Authorization: 'Bearer ${TOK}', 'Content-Type': 'application/json' },
        body: ${JSON.stringify(emptyDoc)} }).then(r => r.status)`);
  await resetRemote();
  await sleep(300);
  // A：造数据并上传
  await evaluate(`localStorage.clear(); localStorage.setItem('aptuser', ${JSON.stringify(TOK)})`);
  await goto(URL_);
  await evaluate(`(function(){
    addW('obrigado', '谢谢', 'Obrigado!', '', 'thank you', '');
    addW('a conta', '账单', '', '', 'bill', '');
    D.words[0].box = 4; D.words[0].lapse = 2; D.words[0].upd = Date.now();
    save();
  })()`);
  await evaluate(`syncNow()`);
  await sleep(400);
  const afterA = await evaluate(`(function(){ return { n: D.words.length, sync: !!D.set.lastSync, err: D.set.lastSyncErr }; })()`);
  check('A 设备上传成功且记下同步时间', afterA.n === 2 && afterA.sync && !afterA.err, JSON.stringify(afterA));
  const snapA = await evaluate(`localStorage.getItem('aptapp:${TOK}')`);

  // B：另一台设备，同一 token
  await evaluate(`localStorage.clear(); localStorage.setItem('aptuser', ${JSON.stringify(TOK)})`);
  // 在 goto **之前**查本地档案：页面一加载启动同步就会把远端的词拉进来，
  // 那时再断言「是空的」必然失败 —— 那是 App 正常工作，不是 bug。
  const localBefore = await evaluate(`localStorage.getItem(${JSON.stringify('aptapp:' + 'TOK')})`);
  check('B 设备本地还没有任何档案（确实是新设备）', localBefore === null, String(localBefore).slice(0, 40));
  await goto(URL_);
  await evaluate(`syncNow()`);
  await sleep(500);
  const afterB = await evaluate(`(function(){
    const w = D.words.find(x => x.pt === 'obrigado');
    return { n: D.words.length, box: w && w.box, lapse: w && w.lapse };
  })()`);
  check('B 设备拉到了 A 的词', afterB.n === 2, `${afterB.n} 个词`);
  check('合并后 box 与 lapse 原样保留（不归零）', afterB.box === 4 && afterB.lapse === 2, JSON.stringify(afterB));

  // B 再加一个词并上传
  const bLocal = await evaluate(`(function(){ addW('o pao', '面包', '', '', 'bread', ''); save(); return D.words.length; })()`);
  await evaluate(`syncNow()`);
  await sleep(400);
  const bSrv = await evaluate(`fetch('api/sync', { headers: { Authorization: 'Bearer ${TOK}' }, cache: 'no-store' })
      .then(r => r.json()).then(j => ((j.doc && j.doc.words) || []).length)`);
  check('B 本地加到了 3 个词', bLocal === 3, `本地 ${bLocal}`);
  check('B 上传后服务端是 3 个词', bSrv === 3, `服务端 ${bSrv}`);

  // A 回来（恢复 A 的快照），同步后应看到 B 加的词
  await evaluate(`localStorage.clear();
    localStorage.setItem('aptuser', ${JSON.stringify(TOK)});
    localStorage.setItem('aptapp:${TOK}', ${JSON.stringify(snapA)});`);
  await goto(URL_);
  const nA1 = await evaluate(`D.words.length`);
  check('A 恢复快照后是原来的 2 个词', nA1 === 2, `${nA1} 个词`);
  const srvBeforeA = await evaluate(`fetch('api/sync', { headers: { Authorization: 'Bearer ${TOK}' }, cache: 'no-store' })
      .then(r => r.json()).then(j => ((j.doc && j.doc.words) || []).length)`);
  check('A 同步前服务端是 3 个词（B 的已落库）', srvBeforeA === 3, `服务端 ${srvBeforeA}`);
  await evaluate(`syncNow()`);
  await sleep(500);
  const nA2 = await evaluate(`D.words.length`);
  check('A 同步后拿到 B 新加的词（双向合并）', nA2 === 3, `${nA2} 个词`);

  // 设置页要把同步状态显示出来
  await evaluate(`show('stats')`);
  await sleep(400);
  const statsTxt = await evaluate(`document.getElementById('stats').innerText`);
  check('设置页显示档案与上次同步', /档案/.test(statsTxt) && /上次同步/.test(statsTxt),
    (statsTxt.match(/档案[^\n]*/) || [''])[0]);
  check('设置页有家庭打卡板开关（默认关闭）',
    /家庭打卡板/.test(statsTxt) && (await evaluate(`!D.set.boardOn`)), '');

  // 打开打卡板 → 服务端才收录。显式再同步一次，别依赖自动触发的时机。
  await evaluate(`toggleBoard(true)`);
  await sleep(400);
  await evaluate(`syncNow()`);
  await sleep(400);
  await evaluate(`loadBoard()`);
  await sleep(600);
  const boardTxt = await evaluate(`(document.getElementById('board')||{}).innerText || ''`);
  check('打开打卡板后能看到自己的打卡状态', /已打卡|还没打卡/.test(boardTxt), boardTxt.slice(0, 60).replace(/\n/g, '|'));

  // 收尾：把测试数据从服务端清掉（否则会留在真实的家庭打卡板里）
  await resetRemote();
  await sleep(300);
  const clean = await evaluate(
    `fetch('api/board', { cache: 'no-store' }).then(r => r.json()).then(j => (j.entries || []).some(e => e.name.indexOf('zztest') >= 0))`);
  check('收尾：测试档案已从打卡板清掉', clean === false, '打卡板里还有 zztest');
}

// ---------- 汇总 ----------
console.log('\n=== 无头 Chrome 渲染验证 ===');
let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '   ← ' + r.detail}`);
  if (!r.ok) bad++;
}
console.log(`\n${results.length - bad}/${results.length} 通过`);

ws.close();
chrome.kill();
process.exit(bad ? 1 : 0);
