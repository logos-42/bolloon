/* Bolloon 手机端 Service Worker — app-shell 缓存, 让 iPhone 可"添加到主屏幕"独立运行 */
const CACHE = 'bolloon-mobile-v1';
const SHELL = [
  './mobile.html',
  './mobile.css',
  './mobile.js',
  './mobile-core.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/favicon-192x192.png',
  './icons/favicon-512x512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  // 跨域 / API / 实时通道不缓存 (registry fetch、WebSocket 等)
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./mobile.html'))),
  );
});
