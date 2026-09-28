'use strict';

/*
 * 零依赖静态文件服务器：托管合并页面、共享合并库与本地打包的 Ajv。
 * 合并与 Schema 校验全部在浏览器内完成，无需任何外部服务。
 *
 * /sw.js 不直接返回模板文件，而是注入当前资源版本哈希与预缓存清单
 * （见 server-assets.js），用于浏览器端 Service Worker 的版本化离线缓存。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assets = require('./server-assets');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIB_DIR = path.join(ROOT, 'lib');
const VENDOR_DIR = path.join(ROOT, 'vendor');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 启动时校验离线清单与 Service Worker 模板齐备，并算出版本哈希
const SW_TEMPLATE_PATH = path.join(PUBLIC_DIR, 'sw.js');
for (const urlPath of assets.PRECACHE_URLS) {
  const filePath = assets.filePathFor(urlPath);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`离线缓存清单中的资源缺失：${urlPath} -> ${filePath}`);
  }
}
if (!fs.existsSync(SW_TEMPLATE_PATH)) {
  throw new Error('Service Worker 模板缺失：public/sw.js');
}
const SW_TEMPLATE = fs.readFileSync(SW_TEMPLATE_PATH, 'utf8');

function send(res, status, body, contentType, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    // 静态资源由 Service Worker 版本化缓存接管；HTTP 层要求每次回源校验，
    // 避免浏览器 HTTP 缓存拖住 sw.js 与新版本资源
    'Cache-Control': 'no-cache',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  // Service Worker：注入版本哈希与预缓存清单；Cache-Control 尤其不能省略，
  // 否则浏览器可能不检查 sw.js 更新
  if (pathname === '/sw.js') {
    return send(res, 200, assets.renderSw(SW_TEMPLATE), MIME['.js']);
  }

  if (pathname === '/') pathname = '/index.html';

  // 只允许访问 public/、lib/ 与 vendor/ 三个目录
  let baseDir;
  let rel;
  if (pathname.startsWith('/lib/')) {
    baseDir = LIB_DIR;
    rel = pathname.slice('/lib/'.length);
  } else if (pathname.startsWith('/vendor/')) {
    baseDir = VENDOR_DIR;
    rel = pathname.slice('/vendor/'.length);
  } else {
    baseDir = PUBLIC_DIR;
    rel = pathname.replace(/^\/+/, '');
  }

  const filePath = path.join(baseDir, rel);
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    return send(res, 403, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    send(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`JSON 三方合并工具已启动：http://localhost:${PORT}`);
});
