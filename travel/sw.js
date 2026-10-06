const SHELL_CACHE = 'travel-shell-v2';
const SHARE_CACHE = 'travel-share-html-v2';
const SHELLS = ['/travel/editor.html', '/css/travel.css'];
const NEUTRAL_SHARE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>分享版本待验证</title><body style="font-family:system-ui;background:#07111f;color:#e5eefc;padding:2rem"><h1>无法确认当前发布代次</h1><p>离线状态下不显示旧缓存正文，以避免泄露已撤回的姓名、联系方式或精确位置。联网后重新打开链接。</p><a style="color:#38bdf8" href="/travel/editor.html">返回编辑器</a></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirstShare(request) {
  const cache = await caches.open(SHARE_CACHE);
  try {
    const response = await fetch(request);
    await cache.put(request, response.clone());
    return response;
  } catch {
    // 不回退旧正文：返回不含任何私人数据的代次验证占位页。
    return new Response(NEUTRAL_SHARE, { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  if (url.pathname.endsWith('/travel/share.html')) {
    event.respondWith(networkFirstShare(event.request));
    return;
  }
  if (/\.(css|js|png|jpg|jpeg|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      }))
    );
  }
});

self.addEventListener('message', async (event) => {
  if (event.data?.type === 'PURGE_SHARES') {
    await caches.delete(SHARE_CACHE);
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.postMessage({ type: 'SHARE_PURGED', activeGeneration: event.data.activeGeneration }));
  }
});
