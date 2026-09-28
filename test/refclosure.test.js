'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRefClosure, escapeSegment } = require('../lib/refclosure.js');

test('无引用：只导出勾选的键，键序保持原结果顺序', () => {
  const r = computeRefClosure({ a: 1, b: 2, c: 3 }, ['c', 'a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'c']); // 原结果键序，而非勾选顺序
  assert.deepEqual(r.doc, { a: 1, c: 3 });
});

test('本地引用纳入依赖，并传递至闭包稳定', () => {
  const doc = {
    a: { $ref: '#/b' },
    b: { c: { $ref: '#/c' } },
    c: { x: 1 },
    d: 4,
  };
  const r = computeRefClosure(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b', 'c']);
  assert.deepEqual(r.doc, { a: { $ref: '#/b' }, b: { c: { $ref: '#/c' } }, c: { x: 1 } });
  assert.ok(!('d' in r.doc)); // 未被引用的键不导出
});

test('依赖键在原结果中位于勾选键之前时，导出键仍按原结果顺序', () => {
  const doc = { z: { $ref: '#/a' }, a: 1, m: 2 };
  const r = computeRefClosure(doc, ['z']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['z', 'a']);
});

test('循环引用只处理一次：a <-> b 正常收敛', () => {
  const doc = { a: { $ref: '#/b' }, b: { $ref: '#/a' }, c: 1 };
  const r = computeRefClosure(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b']);
});

test('自引用与经 # 的自引用都能收敛', () => {
  const doc = { a: { self: { $ref: '#/a' } }, b: { $ref: '#' } };
  const r = computeRefClosure(doc, ['a', 'b']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b']);
});

test('# 指向根：纳入全部顶层键', () => {
  const doc = { a: { $ref: '#' }, b: 1, c: 2 };
  const r = computeRefClosure(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b', 'c']);
  assert.deepEqual(r.doc, doc);
});

test('嵌套路径与数组下标：纳入目标所属顶层键', () => {
  const doc = {
    a: { $ref: '#/b/c/d' },
    b: { c: { d: 1 } },
    list: [10, 20],
    r: { $ref: '#/list/1' },
  };
  const r = computeRefClosure(doc, ['a', 'r']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b', 'list', 'r']);
});

test('键名中的 ~ 与 / 按 RFC 6901 转义解析；~01 正确还原为 ~1', () => {
  const doc = {
    'a/b': 1,
    'x~y': 2,
    'a~1b': 3,
    r: [{ $ref: '#/a~1b' }, { $ref: '#/x~0y' }, { $ref: '#/a~01b' }],
  };
  const r = computeRefClosure(doc, ['r']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a/b', 'x~y', 'a~1b', 'r']);
});

test('空字符串键：#/ 指向键名为空的顶层键', () => {
  const doc = { '': 1, r: { $ref: '#/' } };
  const r = computeRefClosure(doc, ['r']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['', 'r']);
});

test('目标为 null / 0 / false / 空字符串也算存在（缺失才报错）', () => {
  for (const v of [null, 0, false, '']) {
    const r = computeRefClosure({ s: { $ref: '#/b' }, b: v }, ['s']);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.keys, ['s', 'b']);
  }
});

test('非法转义：报告所在路径并拒绝产出子文档', () => {
  for (const ref of ['#/a~2b', '#/a~', '#/a~1~2b']) {
    const r = computeRefClosure({ s: { $ref: ref } }, ['s']);
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
    [{ s: { $ref: '#/nope' } }, '目标不存在'],
    [{ s: { $ref: '#/list/5' }, list: [1] }, '目标不存在'],
    [{ s: { $ref: '#/list/01' }, list: [1] }, '目标不存在'],
    [{ s: { $ref: '#/list/-' }, list: [1] }, '目标不存在'],
    [{ s: { $ref: '#/n/b' }, n: 5 }, '目标不存在'],
  ];
  for (const [d, msg] of cases) {
    const r = computeRefClosure(d, ['s']);
    assert.equal(r.status, 'errors');
    assert.match(r.errors[0].reason, new RegExp(msg));
  }
});

test('外部引用：非 # 开头一律报错并显示所在路径', () => {
  for (const ref of ['https://example.com/x.json', 'other.json#/a', './x.json', 'a/b']) {
    const r = computeRefClosure({ s: { $ref: ref } }, ['s']);
    assert.equal(r.status, 'errors', ref);
    assert.equal(r.errors[0].pointer, '/s/$ref');
    assert.match(r.errors[0].reason, /外部引用/);
  }
});

test('# 后非 / 的形式（如 #foo）无法识别', () => {
  const r = computeRefClosure({ s: { $ref: '#foo' } }, ['s']);
  assert.equal(r.status, 'errors');
  assert.match(r.errors[0].reason, /无法识别/);
});

test('多个错误全部报告，路径含数组下标与转义键名', () => {
  const doc = {
    a: { $ref: '#/nope' },
    'a/b': [{ c: { $ref: 'https://example.com/x.json' } }],
  };
  const r = computeRefClosure(doc, ['a', 'a/b']);
  assert.equal(r.status, 'errors');
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].pointer, '/a/$ref');
  assert.equal(r.errors[1].pointer, '/a~1b/0/c/$ref');
});

test('根结果不是对象：返回 not-object', () => {
  assert.equal(computeRefClosure([1, 2], ['a']).status, 'not-object');
  assert.equal(computeRefClosure('s', ['a']).status, 'not-object');
  assert.equal(computeRefClosure(null, ['a']).status, 'not-object');
  assert.equal(computeRefClosure(5, ['a']).status, 'not-object');
});

test('未勾选或勾选的键都不存在：返回 empty', () => {
  assert.equal(computeRefClosure({ a: 1 }, []).status, 'empty');
  assert.equal(computeRefClosure({ a: 1 }, ['ghost']).status, 'empty');
  assert.equal(computeRefClosure({ a: 1 }, undefined).status, 'empty');
});

test('勾选键去重并忽略不存在的键', () => {
  const r = computeRefClosure({ a: 1, b: 2 }, ['a', 'a', 'ghost']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a']);
});

test('非字符串 $ref 被忽略；顶层键名为 $ref 的字符串同样视为引用', () => {
  const ignored = computeRefClosure({ a: { $ref: 123 }, b: { $ref: null } }, ['a', 'b']);
  assert.equal(ignored.status, 'ok');
  assert.deepEqual(ignored.keys, ['a', 'b']);

  const doc = { $ref: '#/a', a: 1, b: 2 };
  const r = computeRefClosure(doc, ['$ref']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['$ref', 'a']);
});

test('数组中的引用也会被扫描', () => {
  const doc = { a: [{ deep: [{ $ref: '#/b' }] }], b: 1, c: 2 };
  const r = computeRefClosure(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['a', 'b']);
});

// 构造 depth 层对象链 {a:{a:...{a:v}}}，迭代实现，自身不占用调用栈
function chain(v, depth) {
  let obj = v;
  for (let i = 0; i < depth; i++) obj = { a: obj };
  return obj;
}

test('超深嵌套（约 3800 层）中的引用：扫描不抛 RangeError', () => {
  const depth = 3800;
  const doc = { deep: chain({ $ref: '#/target' }, depth), target: 1 };
  const r = computeRefClosure(doc, ['deep']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.keys, ['deep', 'target']);
});

test('escapeSegment：~ 与 / 分别转义为 ~0 与 ~1', () => {
  assert.equal(escapeSegment('a~b/c'), 'a~0b~1c');
  assert.equal(escapeSegment('plain'), 'plain');
});
