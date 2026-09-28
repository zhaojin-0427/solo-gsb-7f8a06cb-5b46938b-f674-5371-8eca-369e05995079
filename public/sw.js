'use strict';

/*
 * 离线续用 Service Worker（全站同源、纯静态资源）。
 *
 * 版本化缓存规则：
 *  - 静态资源按 CACHE_VERSION 整体缓存：install 时必须把 PRECACHE_URLS
 *    全部下载成功，才写入整套缓存并提示「可离线使用」；任一资源失败则
 *    删除本次新建的缓存、安装失败，继续沿用旧版本（首次安装则无缓存可用）。
 *  - 不调用 clients.claim()：已打开的页面在重载前始终由旧 SW 控制、
 *    使用旧版资源，绝不混用新旧脚本；重载后才落到新版本。
 *  - 旧版缓存不在 activate 时立即删除——仍打开旧版页面（甚至断网）时
 *    旧 SW 还要靠它响应；直到新 SW 第一次处理新版文档的导航请求时，
 *    才清掉其它版本缓存（此刻加载的必然是同版 HTML + 同版资源）。
 *  - fetch 只对 install 时缓存的那套静态资源走缓存优先，绝不临时写入
 *    其它响应——缓存里只可能有「整套成功」的资源。
 *  - 草稿仍保存在页面的 localStorage，SW 不缓存任何用户数据。
 *
 * 升级静态资源后必须把 CACHE_VERSION 加 1（内容变化也会触发浏览器发现
 * 新 SW），测试 test/offline.test.js 会核对清单与页面引用一致。
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'json-three-way-merge-static-' + CACHE_VERSION;
const SW_PATH = '/sw.js';

// 离线运行所需的全部静态资源：页面、样式、全部业务脚本、本地打包的 Ajv。
// SW 自身（/sw.js）不在清单内：它按服务器的 no-cache 头每次检查更新。
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/offline.js',
  '/vendor/ajv2020.js',
  '/lib/merge.js',
  '/lib/patch.js',
  '/lib/schema.js',
  '/lib/attribution.js',
  '/lib/suggest.js',
  '/lib/refclosure.js',
  '/lib/delimpact.js',
  '/lib/keyrename.js',
  '/lib/choices.js',
  '/lib/draft.js',
];

const PRECACHE_SET = new Set(PRECACHE_URLS);

// 把 fetch 的失败原因整理成中文说明，供页面提示「为什么还不能离线」
function describeFailure(failedUrl, err) {
  const urlPath = failedUrl.replace(/^https?:\/\/[^/]+/, '') || failedUrl;
  const reason = err && err.message ? String(err.message) : String(err || '');
  return `资源 ${urlPath} 下载失败（${reason || '网络错误'}）`;
}

// install：原子化预缓存。先用缓存不可见的方式逐个 fetch，
// 全部成功后才一次性写入新 Cache；任一失败即删除半成品缓存并拒绝安装。
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (err) {
      await notifyPages({
        type: 'precache-error',
        version: CACHE_VERSION,
        isUpdate: Boolean(self.registration.active),
        reason: `无法创建本地缓存：${(err && err.message) || err}`,
      });
      throw err;
    }

    // 先全部下载到内存：任何一个非 OK / 网络错误都中止，绝不留下半套缓存
    const fetched = [];
    for (const url of PRECACHE_URLS) {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // Response 流只能消费一次：clone 一份留给后续 put
        fetched.push([url, resp.clone()]);
      } catch (err) {
        // 下载阶段失败：cache 尚未写入任何条目；保险起见整个删掉
        await caches.delete(CACHE_NAME).catch(() => {});
        await notifyPages({
          type: 'precache-error',
          version: CACHE_VERSION,
          isUpdate: Boolean(self.registration.active),
          reason: describeFailure(url, err),
        });
        throw err;
      }
    }

    try {
      await Promise.all(fetched.map(([url, resp]) => cache.put(url, resp)));
    } catch (err) {
      await caches.delete(CACHE_NAME).catch(() => {});
      await notifyPages({
        type: 'precache-error',
        version: CACHE_VERSION,
        isUpdate: Boolean(self.registration.active),
        reason: `写入本地缓存失败：${(err && err.message) || err}`,
      });
      throw err;
    }

    // 整套资源已就绪：通知所有打开的页面。更新场景下页面会提示
    // 「新版已就绪，重载后生效」，当前页仍保持旧版直到重载。
    await notifyPages({
      type: 'precache-ok',
      version: CACHE_VERSION,
      isUpdate: Boolean(self.registration.active),
    });

    // 跳过 waiting：下次导航 / 重载即由新 SW 接管；不调用 claim，
    // 因此已打开的页面在重载前不会收到新版资源。
    self.skipWaiting();
  })());
});

// activate：不 claim 现有页面，也不立即删旧缓存——旧版页面在重载前
// 仍由旧 SW 控制，其离线响应还要依赖旧版缓存；旧缓存延迟到新 SW
// 第一次处理新版文档导航请求时再清理（见 fetch 处理）
self.addEventListener('activate', () => {
  // 无需 event.waitUntil：没有必须在激活阶段完成的异步工作
});

// 新 SW 第一次响应新版文档导航后，旧版页面已不可能再由本 SW 服务，
// 此刻删除其它版本缓存是安全的
let staleCachesSwept = false;
async function sweepStaleCaches() {
  if (staleCachesSwept) return;
  staleCachesSwept = true;
  try {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('json-three-way-merge-static-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
  } catch {
    // 清理失败不影响响应；下次导航会再试
    staleCachesSwept = false;
  }
}

// fetch：仅处理同源 GET 且属于整套清单的静态资源，缓存优先；
// 清单外请求一律直接走网络，SW 不缓存任何其它内容
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  let key = url.pathname;
  if (key === '/index.html') key = '/';
  // SW 自身永不命中缓存：保证每次都能检查到新版本
  if (url.pathname === SW_PATH) return;
  if (!PRECACHE_SET.has(key) && !PRECACHE_SET.has(url.pathname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: false, cacheName: CACHE_NAME });
    if (cached) {
      // 确认旧版页面已全部切走后再清理旧缓存：在导航请求（HTML 文档）
      // 上触发，意味着浏览器正在加载本版页面，同版资源会随之一起来自本缓存
      if (req.mode === 'navigate') sweepStaleCaches();
      return cached;
    }
    // 缓存尚未就绪（理论上不会发生：未成功安装的 SW 不会接管页面）：
    // 直接走网络，且不写入缓存
    const resp = await fetch(req);
    if (req.mode === 'navigate') sweepStaleCaches();
    return resp;
  })());
});

// 页面查询当前整版缓存是否完整可用
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'offline-status') return;
  event.waitUntil((async () => {
    let ok = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      const have = new Set(keys.map((r) => new URL(r.url).pathname));
      // 「/」与「/index.html」指向同一文档，缓存其一即可
      const normalized = new Set(have);
      if (normalized.has('/index.html')) normalized.add('/');
      if (normalized.has('/')) normalized.add('/index.html');
      ok = PRECACHE_URLS.every((u) => normalized.has(u));
    } catch {
      ok = false;
    }
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: 'offline-status-result', version: CACHE_VERSION, ok });
  })());
});

// 给所有已打开的页面发消息（首次安装时页面可能尚未准备好接收，
// 页面侧另有 registration 事件与 offline-status 查询兜底）
async function notifyPages(message) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) client.postMessage(message);
  } catch {
    // 页面收不到不影响缓存本身的正确性
  }
}
