/**
 * make_icon.mjs —— 把 assets/icon.svg 渲染成各尺寸的 PNG。
 *
 * iOS 会用圆角遮罩（superellipse）裁切图标，所以源图是**满幅不透明**的，
 * 圆角由系统自己加。180 是 apple-touch-icon 的标准尺寸，192/512 给 manifest。
 *
 * 用法：node tools/make_icon.mjs
 * 只用 node 内置模块 + 本机 Chrome。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const SITE = path.join(ROOT, 'site');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341;

const TARGETS = [
  ['icon.png', 512],          // manifest 主图标（沿用原文件名，避免动 sw.js 的 FILES）
  ['icon-192.png', 192],      // manifest
  ['icon-180.png', 180],      // apple-touch-icon
];

const svg = readFileSync(SVG, 'utf8');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/apt-icon', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch (e) {}
  if (wsUrl) break;
  await sleep(250);
}
if (!wsUrl) { console.error('Chrome 没起来'); chrome.kill(); process.exit(1); }

const tgt = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
});
const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');

for (const [name, size] of TARGETS) {
  // 把 SVG 包进一个刚好 size×size 的页面，禁用滚动条与外边距
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#00843D}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(SITE, name), Buffer.from(shot.result.data, 'base64'));
  const buf = readFileSync(path.join(SITE, name));
  console.log(`${name.padEnd(14)} ${size}x${size}  ${buf.length} bytes`);
}

ws.close();
chrome.kill();
process.exit(0);
