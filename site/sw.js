/* sw.js —— Service Worker。契约见 docs/CONTRACT.md 第 12 章。
 * 策略：
 *   - 页面 /脚本 / 数据：联网优先，失败回退缓存（联网即更新）
 *   - 音频 /api/tts：缓存优先（内容不可变）
 *   ⚠️ ignoreSearch 只用于页面类资源。/api/tts 的查询串就是文本本身，
 *    忽略它会导致所有单词播同一段音频 —— 绝对不能这样做。
 */
const C = 'apt-cache';
const FILES = ['./', './index.html', './logic.js', './sw.js', './manifest.json', './materials.json', './icon.png'];

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

  // 音频与发音代理：内容不可变，缓存优先
  if (url.pathname.indexOf('/audio/') >= 0 || url.pathname.indexOf('/api/tts') >= 0) {
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(res => put(req, res)).catch(() => r))
    );
    return;
  }

  // 页面与数据：联网优先，失败回退缓存。
  // 这里可以忽略查询串（页面带query 也应是同一份资源）。
  e.respondWith(
    fetch(req)
      .then(res => put(req, res))
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});