'use strict';

/*
 * 离线缓存清单与 Service Worker 渲染（server.js 与 test/offline.test.js 共用）。
 *
 * - PRECACHE_URLS：离线使用所需的全部静态资源（页面、样式、业务脚本、本地 Ajv）。
 *   清单与 index.html 中的引用必须一致，新增脚本时两处都要更新（有测试守护）。
 * - computeVersion：对清单内全部文件内容取哈希，任一资源变化版本号即变化，
 *   Service Worker 据此切换版本化缓存。
 * - renderSw：把版本号与清单注入 public/sw.js 模板。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

const PRECACHE_URLS = [
  '/',
  '/style.css',
  '/app.js',
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

// URL 路径 -> 磁盘路径（白名单内才映射，杜绝路径穿越）
function filePathFor(urlPath, root = ROOT) {
  if (!PRECACHE_URLS.includes(urlPath)) return null;
  if (urlPath === '/') return path.join(root, 'public', 'index.html');
  if (urlPath.startsWith('/lib/')) return path.join(root, 'lib', urlPath.slice('/lib/'.length));
  if (urlPath.startsWith('/vendor/')) return path.join(root, 'vendor', urlPath.slice('/vendor/'.length));
  return path.join(root, 'public', urlPath);
}

function computeVersion(root = ROOT) {
  const hash = crypto.createHash('sha256');
  for (const urlPath of PRECACHE_URLS) {
    const filePath = filePathFor(urlPath, root);
    hash.update(urlPath + '\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function renderSw(template, root = ROOT) {
  return template
    .replace(/__APP_VERSION__/g, computeVersion(root))
    .replace(/__PRECACHE_URLS__/g, JSON.stringify(PRECACHE_URLS));
}

module.exports = { ROOT, PRECACHE_URLS, filePathFor, computeVersion, renderSw };
