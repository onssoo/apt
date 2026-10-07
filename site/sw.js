/* sw.js —— Service Worker。契约见 docs/CONTRACT.md 第 12 章。
 * 策略：
 *   - 页面 /脚本 / 数据：联网优先，失败回退缓存（联网即更新）
 *   - 音频 /api/tts：缓存优先（内容不可变）
 *   ⚠️ ignoreSearch 只用于页面类资源。/api/tts 的查询串就是文本本身，
 *    忽略它会导致所有单词播同一段音频 —— 绝对不能这样做。
 */
const C = 'apt-cache-v7';   // v7：新图标（二次元头像 + olá）
                            // v6：M8 课文流水线（导入分组、来源、免责小字、新课文 L09）
                            // v5：修复「生词 ▶ 点不动」（onclick 里的 i 没被插值）
                            // v4：修复「课文卡片点不开」（jid 引号截断 onclick）
                            // v3：M7 质量修复（内容改 v2、逐句译文改点按、页面改版）
                            // v2：清掉可能存了 206 局部响应的旧缓存
const FILES = ['./', './index.html', './logic.js', './sw.js', './manifest.json', './materials.json', './icon.png', './icon-192.png', './icon-180.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))));
});

function put(req, res) {
  if (res && res.ok) {
    const cp = res.clone();
    caches.open(C).then(c => c.put(req, cp));
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 只处理本站资源
  if (url.origin !== self.location.origin) return;

  // ⚠️ 音频**完全不经过 Service Worker**，直接走网络。
  //
  // 原因（实测 2026-10-07）：iOS Safari 播放音频一定发 Range 请求，
  // 服务端返回 206 Partial Content。SW 若把 206 响应存进 Cache，
  // 下次 caches.match 命中后返回的是**局部内容**，
  // Audio 元素拿到残缺数据无法解码 → 完全播不出声音。
  // 浏览器自身的 HTTP 缓存已能处理音频，不必再用 Cache Storage。
  if (url.pathname.indexOf('/audio/') >= 0) {
    return;                     // 不 respondWith = 交给浏览器原生处理
  }

  // 发音代理：POST 且响应不可变，同样不进缓存
  // （保留 respondWith 是为了让 log_skip 生效、避免 POST 进缓存）
  if (url.pathname.indexOf('/api/tts') >= 0) {
    e.respondWith(fetch(req));
    return;
  }

  // 页面与数据：联网优先，失败回退缓存。
  // 这里可以忽略查询串（页面带 query 也应是同一份资源）。
  e.respondWith(
    fetch(req)
      .then(res => put(req, res))
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});