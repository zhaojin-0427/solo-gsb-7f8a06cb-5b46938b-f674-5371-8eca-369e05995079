'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renameTopKey, escapeSegment } = require('../lib/keyrename.js');

test('基本改名：键序保持原位置，原结果不被修改', () => {
  const result = { a: 1, b: { x: 2 }, c: 3 };
  const r = renameTopKey(result, 'b', 'beta');
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.doc), ['a', 'beta', 'c']);
  assert.deepEqual(r.doc, { a: 1, beta: { x: 2 }, c: 3 });
  assert.deepEqual(r.refs, []);
  // 原合并结果不变
  assert.deepEqual(result, { a: 1, b: { x: 2 }, c: 3 });
  assert.ok(!('beta' in result));
});

test('新键名可为空字符串', () => {
  const r = renameTopKey({ a: 1, b: 2 }, 'a', '');
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.doc), ['', 'b']);
  assert.equal(r.doc[''], 1);
});

test('空字符串旧键名：#/ 的首段为空，改名后指向新键名', () => {
  const result = { '': 1, r: { $ref: '#/' } };
  const r = renameTopKey(result, '', 'x');
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.doc), ['x', 'r']);
  assert.equal(r.doc.r.$ref, '#/x');
});

test('新旧键名相同：same，提示无变化，不产出文档', () => {
  const r = renameTopKey({ a: 1 }, 'a', 'a');
  assert.equal(r.status, 'same');
  assert.equal(r.doc, undefined);
});

test('新键名与其他已有顶层键重名：conflict，不产出文档', () => {
  const r = renameTopKey({ a: 1, b: 2 }, 'a', 'b');
  assert.equal(r.status, 'conflict');
  assert.equal(r.key, 'b');
  assert.equal(r.doc, undefined);
});

test('旧键不存在：no-key；根不是对象：not-object', () => {
  assert.equal(renameTopKey({ a: 1 }, 'ghost', 'x').status, 'no-key');
  assert.equal(renameTopKey({ a: 1 }, 123, 'x').status, 'no-key');
  assert.equal(renameTopKey([1, 2], 'a', 'x').status, 'not-object');
  assert.equal(renameTopKey(null, 'a', 'x').status, 'not-object');
  assert.equal(renameTopKey('s', 'a', 'x').status, 'not-object');
  assert.equal(renameTopKey(5, 'a', 'x').status, 'not-object');
});

test('指向旧键名的 $ref 首段被改写，其余引用保持原文', () => {
  const result = {
    api: { endpoint: { $ref: '#/defs/host' }, self: { $ref: '#/api' } },
    defs: { host: 'example.com' },
    version: '1.1.0',
  };
  const r = renameTopKey(result, 'defs', 'schemas');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.api.endpoint.$ref, '#/schemas/host');
  assert.equal(r.doc.api.self.$ref, '#/api'); // 首段不是 defs：保持原文
  assert.deepEqual(r.refs, [
    { pointer: '/api/endpoint/$ref', from: '#/defs/host', to: '#/schemas/host' },
  ]);
  // 原合并结果不变
  assert.equal(result.api.endpoint.$ref, '#/defs/host');
  assert.deepEqual(Object.keys(result), ['api', 'defs', 'version']);
});

test('改名键自身子树内的自引用同样改写', () => {
  const result = { defs: { host: 'h', self: { $ref: '#/defs/host' } } };
  const r = renameTopKey(result, 'defs', 'schemas');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.schemas.self.$ref, '#/schemas/host');
  assert.deepEqual(r.refs, [
    { pointer: '/defs/self/$ref', from: '#/defs/host', to: '#/schemas/host' },
  ]);
});

test('新键名含 ~ 与 / 时首段按 ~0 / ~1 重新转义', () => {
  const result = {
    old: { sub: 1 },
    r: { $ref: '#/old/sub' },
  };
  const r = renameTopKey(result, 'old', 'a/b~c');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.r.$ref, '#/a~1b~0c/sub');
  assert.deepEqual(r.doc['a/b~c'], { sub: 1 });
});

test('旧键名含 ~ 与 /：引用以转义形式书写也能命中首段', () => {
  const result = {
    'a/b': 1,
    'x~y': 2,
    r: [{ $ref: '#/a~1b' }, { $ref: '#/x~0y' }],
  };
  const r = renameTopKey(result, 'a/b', 'plain');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.r[0].$ref, '#/plain');
  assert.equal(r.doc.r[1].$ref, '#/x~0y'); // 指向 x~y：保持原文
});

test('其余片段保持原义：合法但不规范的转义原文保留，不重新编码', () => {
  // ~01 是合法转义（解码为 ~1），改写首段时其余片段不动
  const result = {
    old: { '~1': 1 },
    r: { $ref: '#/old/~01' },
  };
  const r = renameTopKey(result, 'old', 'new');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.r.$ref, '#/new/~01');
});

test('单独的 # 保持原义，不被改写也不报错', () => {
  const result = { a: { $ref: '#' }, b: 1 };
  const r = renameTopKey(result, 'b', 'c');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.a.$ref, '#');
  assert.deepEqual(r.refs, []);
});

test('数组中的 $ref 也会被扫描并改写，路径含数组下标', () => {
  const result = {
    list: [{ deep: [{ $ref: '#/b' }] }],
    b: 1,
  };
  const r = renameTopKey(result, 'b', 'c');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.list[0].deep[0].$ref, '#/c');
  assert.deepEqual(r.refs, [
    { pointer: '/list/0/deep/0/$ref', from: '#/b', to: '#/c' },
  ]);
});

test('顶层键名为 $ref 的字符串同样视为引用', () => {
  const result = { $ref: '#/a', a: 1 };
  const r = renameTopKey(result, 'a', 'b');
  assert.equal(r.status, 'ok');
  assert.equal(r.doc.$ref, '#/b');
  assert.deepEqual(r.refs, [{ pointer: '/$ref', from: '#/a', to: '#/b' }]);
});

test('目标为 null / 0 / false / 空字符串也算存在（缺失才报错）', () => {
  for (const v of [null, 0, false, '']) {
    const r = renameTopKey({ s: { $ref: '#/b' }, b: v }, 'b', 'c');
    assert.equal(r.status, 'ok');
    assert.equal(r.doc.s.$ref, '#/c');
  }
});

test('非法转义：标出原路径并禁止产出文档', () => {
  for (const ref of ['#/a~2b', '#/a~', '#/a~1~2b']) {
    const r = renameTopKey({ s: { $ref: ref }, a: 1 }, 'a', 'b');
    assert.equal(r.status, 'errors', ref);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].pointer, '/s/$ref');
    assert.equal(r.errors[0].ref, ref);
    assert.match(r.errors[0].reason, /非法转义/);
    assert.equal(r.doc, undefined);
  }
});

test('缺失目标：不存在、数组越界、非法下标、穿过标量都报错', () => {
  const cases = [
    [{ s: { $ref: '#/nope' }, a: 1 }, '目标不存在'],
    [{ s: { $ref: '#/list/5' }, list: [1], a: 1 }, '目标不存在'],
    [{ s: { $ref: '#/list/01' }, list: [1], a: 1 }, '目标不存在'],
    [{ s: { $ref: '#/n/x' }, n: 5, a: 1 }, '目标不存在'],
  ];
  for (const [d, msg] of cases) {
    const r = renameTopKey(d, 'a', 'b');
    assert.equal(r.status, 'errors');
    assert.match(r.errors[0].reason, new RegExp(msg));
  }
});

test('外部引用与无法识别的引用：标出原路径', () => {
  for (const ref of ['https://example.com/x.json', 'other.json#/a', './x.json']) {
    const r = renameTopKey({ s: { $ref: ref }, a: 1 }, 'a', 'b');
    assert.equal(r.status, 'errors', ref);
    assert.equal(r.errors[0].pointer, '/s/$ref');
    assert.match(r.errors[0].reason, /外部引用/);
  }
  const bad = renameTopKey({ s: { $ref: '#foo' }, a: 1 }, 'a', 'b');
  assert.equal(bad.status, 'errors');
  assert.match(bad.errors[0].reason, /无法识别/);
});

test('与改名键无关的键中的非法引用同样阻止导出', () => {
  const result = {
    a: 1,
    bad: { deep: { $ref: '#/nope' } },
  };
  const r = renameTopKey(result, 'a', 'b');
  assert.equal(r.status, 'errors');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].pointer, '/bad/deep/$ref');
  assert.equal(r.doc, undefined);
});

test('多个错误全部报告，路径含数组下标与转义键名', () => {
  const result = {
    a: { $ref: '#/nope' },
    'a/b': [{ c: { $ref: 'other.json#/a' } }],
  };
  const r = renameTopKey(result, 'a', 'z');
  assert.equal(r.status, 'errors');
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].pointer, '/a/$ref');
  assert.equal(r.errors[1].pointer, '/a~1b/0/c/$ref');
});

test('非字符串 $ref 被忽略', () => {
  const r = renameTopKey({ a: { $ref: 123 }, b: { $ref: null } }, 'a', 'c');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.doc, { c: { $ref: 123 }, b: { $ref: null } });
  assert.deepEqual(r.refs, []);
});

test('改名为 __proto__ 也能产出可序列化的自有键', () => {
  const r = renameTopKey({ a: { x: 1 }, b: 2 }, 'a', '__proto__');
  assert.equal(r.status, 'ok');
  assert.equal(JSON.stringify(r.doc), '{"__proto__":{"x":1},"b":2}');
  assert.ok(Object.prototype.hasOwnProperty.call(r.doc, '__proto__'));
});

test('原结果含 __proto__ 自有键时改名不丢失', () => {
  const result = JSON.parse('{"__proto__":{"x":1},"a":2}');
  const r = renameTopKey(result, 'a', 'b');
  assert.equal(r.status, 'ok');
  assert.equal(JSON.stringify(r.doc), '{"__proto__":{"x":1},"b":2}');
});

// 构造 depth 层对象链 {a:{a:...{a:v}}}，迭代实现，自身不占用调用栈
function chain(v, depth) {
  let obj = v;
  for (let i = 0; i < depth; i++) obj = { a: obj };
  return obj;
}

test('超深嵌套（约 3800 层）中的引用：扫描与重建不抛 RangeError', () => {
  const depth = 3800;
  const result = { deep: chain({ $ref: '#/target' }, depth), target: 1 };
  const r = renameTopKey(result, 'target', 't2');
  assert.equal(r.status, 'ok');
  let cur = r.doc.deep;
  for (let i = 0; i < depth; i++) cur = cur.a;
  assert.equal(cur.$ref, '#/t2');
});

test('escapeSegment：~ 与 / 分别转义为 ~0 与 ~1', () => {
  assert.equal(escapeSegment('a~b/c'), 'a~0b~1c');
  assert.equal(escapeSegment('plain'), 'plain');
});
