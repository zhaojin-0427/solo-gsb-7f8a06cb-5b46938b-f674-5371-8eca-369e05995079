'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assets = require('../server-assets.js');

const ROOT = path.join(__dirname, '..');

test('预缓存清单中的每个 URL 都映射到存在的静态文件', () => {
  assert.ok(assets.PRECACHE_URLS.includes('/'), '必须缓存入口页面 /');
  assert.ok(assets.PRECACHE_URLS.includes('/vendor/ajv2020.js'), '必须缓存本地 Ajv 包');
  assert.equal(new Set(assets.PRECACHE_URLS).size, assets.PRECACHE_URLS.length, '清单不应有重复项');
  for (const urlPath of assets.PRECACHE_URLS) {
    const filePath = assets.filePathFor(urlPath);
    assert.ok(filePath, `${urlPath} 未映射到文件`);
    assert.ok(fs.existsSync(filePath), `${urlPath} -> ${filePath} 文件不存在`);
    assert.ok(fs.statSync(filePath).size > 0, `${urlPath} 不应为空文件`);
  }
});

test('filePathFor 是白名单：清单外 URL 与路径穿越均返回 null', () => {
  assert.equal(assets.filePathFor('/../server.js'), null);
  assert.equal(assets.filePathFor('/lib/../server.js'), null);
  assert.equal(assets.filePathFor('/sw.js'), null); // SW 本身由 server.js 动态渲染，不预缓存
  assert.equal(assets.filePathFor('/vendor-src/ajv2020-entry.cjs'), null);
});

test('index.html 引用的全部本地脚本与样式都在预缓存清单中，且无遗漏的 lib 文件', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const refs = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (ref.startsWith('/') && !ref.startsWith('//')) refs.push(ref);
  }
  assert.ok(refs.includes('/style.css'));
  assert.ok(refs.includes('/app.js'));
  assert.ok(refs.includes('/vendor/ajv2020.js'));
  for (const ref of refs) {
    assert.ok(assets.PRECACHE_URLS.includes(ref), `index.html 引用了未预缓存的资源：${ref}`);
  }

  const libFiles = fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => '/lib/' + f);
  for (const libFile of libFiles) {
    assert.ok(assets.PRECACHE_URLS.includes(libFile), `${libFile} 未加入预缓存清单`);
    assert.ok(refs.includes(libFile), `${libFile} 未被 index.html 引用`);
  }
});

test('computeVersion 稳定且为 16 位十六进制；任一资源变化版本即变化', () => {
  const v1 = assets.computeVersion();
  const v2 = assets.computeVersion();
  assert.match(v1, /^[0-9a-f]{16}$/);
  assert.equal(v1, v2);

  // 用临时目录构造「仅一个文件内容不同」的镜像，验证哈希随内容变化
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'json-merge-assets-'));
  try {
    for (const urlPath of assets.PRECACHE_URLS) {
      const src = assets.filePathFor(urlPath);
      const dst = assets.filePathFor(urlPath, tmp);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    assert.equal(assets.computeVersion(tmp), v1, '内容完全一致时版本应相同');
    fs.appendFileSync(assets.filePathFor('/app.js', tmp), '\n// version probe\n');
    assert.notEqual(assets.computeVersion(tmp), v1, '资源内容变化后版本哈希必须变化');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderSw 注入版本与清单，产物是语法有效的 Service Worker 且含全部资源', () => {
  const template = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.ok(template.includes('__APP_VERSION__'));
  assert.ok(template.includes('__PRECACHE_URLS__'));

  const rendered = assets.renderSw(template);
  assert.ok(!rendered.includes('__APP_VERSION__'), '版本占位符必须被替换');
  assert.ok(!rendered.includes('__PRECACHE_URLS__'), '清单占位符必须被替换');

  // 仅做语法编译，不执行（self / caches / fetch 为 SW 全局，Node 中不存在）
  assert.doesNotThrow(() => new vm.Script(rendered));

  for (const urlPath of assets.PRECACHE_URLS) {
    assert.ok(rendered.includes(JSON.stringify(urlPath)), `SW 产物缺少资源 ${urlPath}`);
  }
  assert.match(rendered, /json-three-way-merge:/);
  // install 阶段不得自动 skipWaiting；仅在收到页面消息时才调用
  assert.ok(rendered.includes('self.skipWaiting()'));
  const installBlock = rendered.slice(
    rendered.indexOf("self.addEventListener('install'"),
    rendered.indexOf("self.addEventListener('activate'"),
  );
  assert.ok(!installBlock.includes('skipWaiting'), 'install 阶段不得跳过等待，否则会混用新旧版本');
});

/* ---------- 在 Node 中模拟 Service Worker 运行时，执行渲染后的 sw.js ---------- */

function createMockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    text: async () => body,
    clone() { return createMockResponse(body, status); },
  };
}

function createSwEnv(options = {}) {
  const listeners = new Map();
  const cacheStores = new Map(); // cacheName -> Map(pathname -> response)
  const cacheOrder = [];
  const clientMessages = [];
  const client = {
    id: 'client-1',
    postMessage(msg) { clientMessages.push(msg); },
  };

  // 浏览器 Cache API 以完整 URL 匹配；同源下等价于按 pathname 匹配
  function cacheKey(input) {
    const s = String(input && input.url ? input.url : input);
    if (s.startsWith('http')) {
      try { return new URL(s).pathname; } catch { return s; }
    }
    return s;
  }

  const cacheApi = {
    async open(name) {
      if (!cacheStores.has(name)) {
        cacheStores.set(name, new Map());
        cacheOrder.push(name);
      }
      const store = cacheStores.get(name);
      return {
        async put(url, res) { store.set(cacheKey(url), res); },
        async match(url) {
          const key = cacheKey(url);
          return store.has(key) ? store.get(key) : undefined;
        },
      };
    },
    async match(url) {
      // 与浏览器一致：跨所有 Cache 按创建顺序查找首个命中
      const key = cacheKey(url);
      for (const name of cacheOrder) {
        const hit = cacheStores.get(name).get(key);
        if (hit) return hit;
      }
      return undefined;
    },
    async delete(name) {
      const existed = cacheStores.has(name);
      cacheStores.delete(name);
      const i = cacheOrder.indexOf(name);
      if (i >= 0) cacheOrder.splice(i, 1);
      return existed;
    },
    async keys() {
      return cacheOrder.slice();
    },
  };

  const failUrls = new Set(options.failUrls || []);
  const fetchImpl = async (input) => {
    const url = cacheKey(input);
    if (options.fetchAlwaysFails || failUrls.has(url)) {
      throw new TypeError('Failed to fetch: ' + url);
    }
    return createMockResponse('body:' + url);
  };

  const sw = {
    location: { origin: 'http://localhost:8080' },
    skipWaitingCalled: 0,
    claimCalled: 0,
    skipWaiting() { this.skipWaitingCalled += 1; },
    clients: {
      async matchAll() { return [client]; },
      async claim() { sw.claimCalled += 1; },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };

  const sandbox = {
    self: sw,
    caches: cacheApi,
    fetch: fetchImpl,
    URL,
    Response: function (body, init = {}) {
      return createMockResponse(body, init.status || 200);
    },
    console,
  };
  vm.createContext(sandbox);

  function dispatch(type, event) {
    for (const fn of listeners.get(type) || []) fn(event);
  }

  function extendableEvent() {
    const ev = { _promises: [] };
    ev.waitUntil = (p) => ev._promises.push(Promise.resolve(p));
    ev.settled = async () => { await Promise.all(ev._promises); };
    return ev;
  }

  return {
    evalScript(code) { vm.runInContext(code, sandbox, { filename: 'sw.js' }); },
    cacheNames: cacheOrder,
    cacheStores,
    clientMessages,
    sw,
    async install() {
      const ev = extendableEvent();
      dispatch('install', ev);
      await ev.settled();
    },
    async activate() {
      const ev = extendableEvent();
      dispatch('activate', ev);
      await ev.settled();
    },
    async fetchOnce(request) {
      let response;
      dispatch('fetch', {
        request,
        respondWith(r) { response = Promise.resolve(r); },
        waitUntil() {},
      });
      return response;
    },
    // source 缺省时收集对 event.source 的回复；传入共享 client 时消息进 clientMessages
    async message(data, source) {
      const replies = [];
      const ev = extendableEvent();
      ev.data = data;
      ev.source = source || { postMessage(msg) { replies.push(msg); } };
      dispatch('message', ev);
      await ev.settled();
      return source ? clientMessages.slice() : replies;
    },
  };
}

function renderRealSw() {
  const template = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  return assets.renderSw(template);
}

test('SW install：整套资源缓存成功才发 PRECACHE_OK，断网后页面与脚本均由缓存服务', async () => {
  const env = createSwEnv();
  env.evalScript(renderRealSw());

  await env.install();

  const okMsg = env.clientMessages.find((m) => m.type === 'PRECACHE_OK');
  assert.ok(okMsg, '应通知页面整套资源缓存成功');
  assert.match(okMsg.version, /^[0-9a-f]{16}$/);

  const [cacheName] = env.cacheNames;
  assert.match(cacheName, /^json-three-way-merge:[0-9a-f]{16}$/);
  for (const urlPath of assets.PRECACHE_URLS) {
    const cached = env.cacheStores.get(cacheName).get(urlPath);
    assert.ok(cached, `${urlPath} 应已入缓存`);
    assert.equal(cached.status, 200);
  }

  // 缓存优先：安装完成后页面导航与静态资源都返回缓存内容
  const pageResp = await env.fetchOnce({
    method: 'GET', mode: 'navigate', url: 'http://localhost:8080/',
  });
  assert.equal(pageResp.status, 200);
  assert.equal(pageResp.body, 'body:/');
  const altNav = await env.fetchOnce({
    method: 'GET', mode: 'navigate', url: 'http://localhost:8080/index.html',
  });
  assert.equal(altNav.status, 200, '导航 /index.html 应回退使用缓存的 /');
  const jsResp = await env.fetchOnce({
    method: 'GET', mode: 'cors', url: 'http://localhost:8080/lib/draft.js',
  });
  assert.equal(jsResp.status, 200);
  assert.equal(jsResp.body, 'body:/lib/draft.js');

  // 非 GET 与跨域请求不放行给 respondWith（交回浏览器默认网络逻辑）
  const postResp = await env.fetchOnce({
    method: 'POST', mode: 'cors', url: 'http://localhost:8080/api',
  });
  assert.equal(postResp, undefined);
  const crossResp = await env.fetchOnce({
    method: 'GET', mode: 'cors', url: 'https://example.com/x.js',
  });
  assert.equal(crossResp, undefined);

  // 从未完成过资源准备且处于断网：导航给 503 说明页，普通资源给 504
  const envColdOffline = createSwEnv({ fetchAlwaysFails: true });
  envColdOffline.evalScript(renderRealSw());
  const navResp = await envColdOffline.fetchOnce({
    method: 'GET', mode: 'navigate', url: 'http://localhost:8080/',
  });
  assert.equal(navResp.status, 503);
  const assetResp = await envColdOffline.fetchOnce({
    method: 'GET', mode: 'cors', url: 'http://localhost:8080/app.js',
  });
  assert.equal(assetResp.status, 504);
});

test('SW install：任一资源失败则整套放弃（删缓存、通知原因、install 失败），旧版继续可用', async () => {
  const env = createSwEnv({ failUrls: ['/lib/draft.js', '/app.js'] });
  env.evalScript(renderRealSw());

  await assert.rejects(() => env.install(), /precache incomplete/);

  assert.deepEqual(env.cacheNames, [], '半成品缓存必须删除，旧版本缓存继续服务');
  const failMsg = env.clientMessages.find((m) => m.type === 'PRECACHE_FAILED');
  assert.ok(failMsg);
  // 消息对象来自 vm 领域，经 JSON 归一化后再严格比较
  assert.deepEqual(JSON.parse(JSON.stringify(failMsg.failed.map((f) => f.url).sort())),
    ['/app.js', '/lib/draft.js']);
  for (const f of failMsg.failed) assert.ok(f.reason, '每项失败应带原因');
});

test('SW activate：只保留当前版本缓存并 claim；SKIP_WAITING 仅由页面消息触发', async () => {
  const env = createSwEnv();
  env.evalScript(renderRealSw());
  await env.install();
  const [currentCache] = env.cacheNames;

  env.cacheStores.set('json-three-way-merge:0000000000000000', new Map([['/x', true]]));
  env.cacheNames.push('json-three-way-merge:0000000000000000');
  env.cacheStores.set('json-three-way-merge:ffffffffffffffff', new Map());
  env.cacheNames.push('json-three-way-merge:ffffffffffffffff');

  await env.activate();

  assert.deepEqual(env.cacheNames, [currentCache], '旧版本缓存必须清理');
  assert.equal(env.sw.claimCalled, 1);

  assert.equal(env.sw.skipWaitingCalled, 0);
  await env.message({ type: 'SKIP_WAITING' });
  assert.equal(env.sw.skipWaitingCalled, 1, '仅当页面发消息要求换版时才 skipWaiting');
});

test('SW CHECK_CACHE：完整时通过；缓存缺失时联网补齐，断网时如实报告缺失项', async () => {
  const env = createSwEnv();
  env.evalScript(renderRealSw());
  await env.install();

  let replies = await env.message({ type: 'CHECK_CACHE' });
  replies = replies.map((r) => JSON.parse(JSON.stringify(r))); // vm 领域对象归一化
  assert.equal(replies[0].type, 'CACHE_STATUS');
  assert.equal(replies[0].ok, true);
  assert.deepEqual(replies[0].missing, []);
  assert.match(replies[0].version, /^[0-9a-f]{16}$/);

  // 缓存被浏览器回收一项且网络可用：自动补齐后仍报告完整
  const [cacheName] = env.cacheNames;
  env.cacheStores.get(cacheName).delete('/lib/merge.js');
  replies = (await env.message({ type: 'CHECK_CACHE' })).map((r) => JSON.parse(JSON.stringify(r)));
  assert.equal(replies[0].ok, true, '联网补齐后应恢复完整');
  assert.ok(env.cacheStores.get(cacheName).get('/lib/merge.js'));

  // 安装即失败的断网环境：CHECK_CACHE 如实列出全部缺失项，不声称可离线
  const envOffline = createSwEnv({ fetchAlwaysFails: true });
  envOffline.evalScript(renderRealSw());
  await assert.rejects(() => envOffline.install());
  replies = (await envOffline.message({ type: 'CHECK_CACHE' })).map((r) => JSON.parse(JSON.stringify(r)));
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].missing.length, assets.PRECACHE_URLS.length);
});
