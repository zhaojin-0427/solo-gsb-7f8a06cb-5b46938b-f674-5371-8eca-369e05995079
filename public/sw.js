'use strict';

/*
 * Service Worker：JSON 三方合并工具的离线缓存。
 *
 * 该文件由 server.js 动态注入两个占位符：
 *   __APP_VERSION__   全部静态资源内容的哈希版本（任一资源变化即变化）
 *   __PRECACHE_URLS__ 必须整套缓存成功的静态资源清单
 *
 * 规则：
 * - install 阶段并行预缓存清单内全部资源；任一失败即放弃本次安装并删除
 *   半成品缓存，旧版本 Service Worker 与旧缓存继续生效（新版未全部下载成功
 *   时继续使用旧版）。
 * - activate 阶段清理其它版本的缓存，并 claim 已打开的页面（新 SW 只会在
 *   用户点击「刷新启用新版本」后经 skipWaiting 激活，或所有标签页关闭后才
 *   激活，因此不会在用户无操作时混用新旧脚本）。
 * - fetch 阶段同源 GET 请求一律缓存优先：页面导航也返回当前版本缓存的
 *   index.html，保证同一次打开拿到的页面与脚本始终来自同一版本。
 * - 不缓存任何业务数据：草稿仍保存在页面的 localStorage 中。
 */

const APP_VERSION = '__APP_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;
const CACHE_PREFIX = 'json-three-way-merge:';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const INDEX_URL = '/';

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    try {
      client.postMessage(message);
    } catch {
      /* 客户端已关闭等，忽略 */
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const failed = [];
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(url, res.clone());
      } catch (err) {
        failed.push({ url, reason: err && err.message ? String(err.message) : String(err) });
      }
    }));

    if (failed.length > 0) {
      // 整套资源未全部缓存成功：删除半成品缓存并让 install 失败，
      // 浏览器保留旧版本 SW 与旧缓存继续服务
      await caches.delete(CACHE_NAME);
      await notifyClients({ type: 'PRECACHE_FAILED', version: APP_VERSION, failed });
      throw new Error('precache incomplete: ' + failed.map((f) => f.url).join(', '));
    }

    await notifyClients({ type: 'PRECACHE_OK', version: APP_VERSION });
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：缓存优先。显式输入 /index.html 也回退到缓存的 '/'
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = (await caches.match(req.url)) || (await caches.match(INDEX_URL));
      if (cached) return cached;
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(INDEX_URL, res.clone());
        }
        return res;
      } catch (err) {
        return new Response(
          '离线状态且缓存中没有该页面：请先在联网（容器运行）时打开一次 http://localhost:8080 完成资源准备。',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }
    })());
    return;
  }

  // 其它静态资源：缓存优先；未命中时回源并补写当前版本缓存
  event.respondWith((async () => {
    const cached = await caches.match(req.url);
    if (cached) return cached;
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req.url, res.clone());
      }
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});

// 列出当前缓存中缺失的预缓存资源；可选联网补齐
async function checkCacheAndRepair() {
  const cache = await caches.open(CACHE_NAME);
  let missing = [];
  for (const url of PRECACHE_URLS) {
    const hit = await cache.match(url);
    if (!hit) missing.push(url);
  }
  if (missing.length === 0) return { ok: true, missing: [] };

  // 缓存被浏览器回收等情况下尝试在线补齐
  const stillMissing = [];
  await Promise.all(missing.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const c = await caches.open(CACHE_NAME);
      await c.put(url, res.clone());
    } catch (err) {
      stillMissing.push({ url, reason: err && err.message ? String(err.message) : '缓存缺失且无法补齐' });
    }
  }));
  return { ok: stillMissing.length === 0, missing: stillMissing };
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const reply = (message) => {
    if (event.source && event.source.postMessage) {
      try { event.source.postMessage(message); } catch { /* 忽略 */ }
    }
  };
  event.waitUntil((async () => {
    if (data.type === 'SKIP_WAITING') {
      // 仅由页面上用户点击「刷新启用新版本」触发
      self.skipWaiting();
    } else if (data.type === 'GET_VERSION') {
      reply({ type: 'VERSION', version: APP_VERSION });
    } else if (data.type === 'CHECK_CACHE') {
      const result = await checkCacheAndRepair();
      reply({ type: 'CACHE_STATUS', version: APP_VERSION, ok: result.ok, missing: result.missing });
    }
  })());
});
