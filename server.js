'use strict';

/*
 * 零依赖静态文件服务器：托管合并页面、共享合并库与本地打包的 Ajv。
 * 合并与 Schema 校验全部在浏览器内完成，无需任何外部服务。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

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

function send(res, status, body, contentType) {
  res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
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
