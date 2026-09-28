'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDeletionImpact } = require('../lib/delimpact.js');

test('直接依赖拟删键的其他顶层键被列出，链长为一条边', () => {
  const doc = {
    a: { $ref: '#/b' },
    b: 1,
    c: 2,
  };
  const r = computeDeletionImpact(doc, ['b']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.deleting, ['b']);
  assert.deepEqual(r.affected, [{ key: 'a', chain: ['a', 'b'] }]);
});

test('间接依赖按传递关系列出，链给出完整最短路径', () => {
  const doc = {
    a: { $ref: '#/b' },
    b: { c: { $ref: '#/c' } },
    c: { x: 1 },
    d: 4,
  };
  const r = computeDeletionImpact(doc, ['c']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'b', 'c'] },
    { key: 'b', chain: ['b', 'c'] },
  ]); // d 不依赖 c；a 在 b 之前，保持原结果键序
});

test('受影响列表保持原结果顶层键序，而非链长顺序', () => {
  const doc = {
    z: { $ref: '#/a' },
    a: 1,
    m: 2,
  };
  const r = computeDeletionImpact(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected.map((e) => e.key), ['z']);
});

test('多条等长最短链：按原结果顶层键序取整条链字典序最小者', () => {
  // a 同时引用 b 与 c，b、c 都引用拟删键 d
  // 两条链 a->b->d 与 a->c->d 等长，b 在 c 之前故取 a->b->d
  const doc = {
    a: [{ $ref: '#/b' }, { $ref: '#/c' }],
    b: { $ref: '#/d' },
    c: { $ref: '#/d' },
    d: 1,
  };
  const r = computeDeletionImpact(doc, ['d']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'b', 'd'] },
    { key: 'b', chain: ['b', 'd'] },
    { key: 'c', chain: ['c', 'd'] },
  ]);
});

test('字典序比较看整条链：首个分叉更靠后的链仍以第一个分叉处最小者为准', () => {
  // 对受影响键 x：x->a->...->t 与 x->b->...->t 等长，a 在 b 前，取经 a 的链
  // 即便 a 的下一跳在原结果中很靠后
  const doc = {
    x: { one: { $ref: '#/a' }, two: { $ref: '#/b' } },
    a: { $ref: '#/z' },
    b: { $ref: '#/c' },
    c: { $ref: '#/t' },
    z: { $ref: '#/t' },
    t: 1,
  };
  const r = computeDeletionImpact(doc, ['t']);
  const x = r.affected.find((e) => e.key === 'x');
  assert.deepEqual(x.chain, ['x', 'a', 'z', 't']);
});

test('最短链优先于字典序：更短的链不会被更长但词序更小的链取代', () => {
  // a 直接引用拟删键 d（1 跳）；a 也引用 b，b 引用 d（2 跳）
  const doc = {
    a: { x: { $ref: '#/b' }, y: { $ref: '#/d' } },
    b: { $ref: '#/d' },
    d: 1,
  };
  const r = computeDeletionImpact(doc, ['d']);
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'd'] },
    { key: 'b', chain: ['b', 'd'] },
  ]);
});

test('多个拟删键：每个受影响键取到达最近拟删键的链', () => {
  const doc = {
    a: { $ref: '#/b' },
    b: 1,
    c: { $ref: '#/b' },
    d: 2,
  };
  const r = computeDeletionImpact(doc, ['b', 'd']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.deleting, ['b', 'd']); // 原结果键序
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'b'] },
    { key: 'c', chain: ['c', 'b'] },
  ]);
  // 等距于多个拟删键时，链尾取原结果键序最靠前的拟删键
  const tie = computeDeletionImpact(
    { a: { x: { $ref: '#/b' }, y: { $ref: '#/c' } }, b: 1, c: 2 },
    ['c', 'b'],
  );
  assert.deepEqual(tie.deleting, ['b', 'c']);
  assert.deepEqual(tie.affected[0].chain, ['a', 'b']);
});

test('循环依赖必须收敛：a <-> b 且拟删 c 时正常给出链', () => {
  const doc = {
    a: { toB: { $ref: '#/b' }, toC: { $ref: '#/c' } },
    b: { $ref: '#/a' },
    c: 1,
  };
  const r = computeDeletionImpact(doc, ['c']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'c'] }, // 直连更短，不走环
    { key: 'b', chain: ['b', 'a', 'c'] },
  ]);
});

test('纯环中删除一环：环上其他键都受影响，链沿最短方向到达拟删键', () => {
  const doc = {
    a: { $ref: '#/b' },
    b: { $ref: '#/c' },
    c: { $ref: '#/a' },
  };
  const r = computeDeletionImpact(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [
    { key: 'b', chain: ['b', 'c', 'a'] },
    { key: 'c', chain: ['c', 'a'] },
  ]);
});

test('# 视为依赖全部顶层键：删除任一键，含 # 的键都受影响', () => {
  const doc = {
    a: { $ref: '#' },
    b: 1,
    c: { $ref: '#/b' },
  };
  const r = computeDeletionImpact(doc, ['b']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [
    { key: 'a', chain: ['a', 'b'] }, // a 经 # 直接依赖全部键，直连 b
    { key: 'c', chain: ['c', 'b'] },
  ]);
});

test('仅含自引用的键不影响自身；拟删键自身不在受影响列表', () => {
  const doc = {
    a: { self: { $ref: '#/a' } },
    b: { $ref: '#/a' },
  };
  const r = computeDeletionImpact(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [{ key: 'b', chain: ['b', 'a'] }]);
});

test('没有任何键依赖拟删键：affected 为空', () => {
  const r = computeDeletionImpact({ a: 1, b: 2, c: 3 }, ['c']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, []);
  assert.deepEqual(r.deleting, ['c']);
});

test('非法、无法识别、缺失或外部引用：提示原路径且不产生依赖边', () => {
  const doc = {
    badEscape: { $ref: '#/a~2b' },
    missing: { deep: { $ref: '#/nope' } },
    external: { $ref: 'https://example.com/x.json' },
    unrecognized: { $ref: '#foo' },
    rel: { $ref: 'other.json#/a' },
    good: { $ref: '#/a' },
    a: 1,
  };
  const r = computeDeletionImpact(doc, ['a']);
  assert.equal(r.status, 'ok');
  // 只有合法引用 good 被计入影响
  assert.deepEqual(r.affected, [{ key: 'good', chain: ['good', 'a'] }]);
  assert.equal(r.errors.length, 5);
  assert.equal(r.errors[0].pointer, '/badEscape/$ref');
  assert.match(r.errors[0].reason, /非法转义/);
  assert.equal(r.errors[1].pointer, '/missing/deep/$ref');
  assert.match(r.errors[1].reason, /目标不存在/);
  assert.equal(r.errors[2].pointer, '/external/$ref');
  assert.match(r.errors[2].reason, /外部引用/);
  assert.equal(r.errors[3].pointer, '/unrecognized/$ref');
  assert.match(r.errors[3].reason, /无法识别/);
  assert.equal(r.errors[4].pointer, '/rel/$ref');
  assert.match(r.errors[4].reason, /外部引用/);
});

test('非法引用位于拟删键内部或与依赖无关的键中：仍单独提示原路径', () => {
  const doc = {
    d: { $ref: 'https://example.com/x.json' },
    unrelated: { $ref: '#/nope' },
    a: 1,
  };
  const r = computeDeletionImpact(doc, ['d']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, []);
  assert.equal(r.errors.length, 2);
});

test('数组内部与深层嵌套中的引用都会被扫描', () => {
  const doc = {
    a: [{ deep: [{ $ref: '#/b' }] }],
    list: [1, { x: { $ref: '#/b' } }],
    b: 1,
  };
  const r = computeDeletionImpact(doc, ['b']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected.map((e) => e.key), ['a', 'list']);
});

test('缺失目标的各种形态：不存在、数组越界、非法下标、穿过标量', () => {
  const docs = [
    { s: { $ref: '#/nope' } },
    { s: { $ref: '#/list/5' }, list: [1] },
    { s: { $ref: '#/list/01' }, list: [1] },
    { s: { $ref: '#/list/-' }, list: [1] },
    { s: { $ref: '#/n/b' }, n: 5 },
  ];
  for (const d of docs) {
    const r = computeDeletionImpact(d, Object.keys(d));
    assert.equal(r.status, 'ok');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].reason, /目标不存在/);
  }
});

test('嵌套路径与数组下标：依赖归到目标所属顶层键', () => {
  const doc = {
    a: { $ref: '#/b/c/d' },
    b: { c: { d: 1 } },
    r: { $ref: '#/list/1' },
    list: [10, 20],
  };
  const out = computeDeletionImpact(doc, ['b', 'list']);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.affected, [
    { key: 'a', chain: ['a', 'b'] },
    { key: 'r', chain: ['r', 'list'] },
  ]);
});

test('键名中的 ~ 与 / 按 RFC 6901 转义解析', () => {
  const doc = {
    'a/b': 1,
    'x~y': 2,
    r: [{ $ref: '#/a~1b' }, { $ref: '#/x~0y' }],
  };
  const r = computeDeletionImpact(doc, ['a/b']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [{ key: 'r', chain: ['r', 'a/b'] }]);
});

test('空字符串键：#/ 指向键名为空的顶层键', () => {
  const doc = { '': 1, r: { $ref: '#/' } };
  const r = computeDeletionImpact(doc, ['']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [{ key: 'r', chain: ['r', ''] }]);
});

test('目标为 null / 0 / false / 空字符串也算存在（缺失才提示）', () => {
  for (const v of [null, 0, false, '']) {
    const r = computeDeletionImpact({ s: { $ref: '#/b' }, b: v }, ['b']);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.affected, [{ key: 's', chain: ['s', 'b'] }]);
    assert.deepEqual(r.errors, []);
  }
});

test('非字符串 $ref 被忽略；顶层键名为 $ref 的字符串同样视为引用', () => {
  const ignored = computeDeletionImpact({ a: { $ref: 123 }, b: { $ref: null } }, ['a', 'b']);
  assert.equal(ignored.status, 'ok');
  assert.deepEqual(ignored.affected, []);
  assert.deepEqual(ignored.errors, []);

  const doc = { $ref: '#/a', a: 1, b: 2 };
  const r = computeDeletionImpact(doc, ['a']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [{ key: '$ref', chain: ['$ref', 'a'] }]);
});

test('根结果不是对象：返回 not-object', () => {
  assert.equal(computeDeletionImpact([1, 2], ['a']).status, 'not-object');
  assert.equal(computeDeletionImpact('s', ['a']).status, 'not-object');
  assert.equal(computeDeletionImpact(null, ['a']).status, 'not-object');
  assert.equal(computeDeletionImpact(5, ['a']).status, 'not-object');
});

test('未勾选或勾选的键都不存在：返回 empty', () => {
  assert.equal(computeDeletionImpact({ a: 1 }, []).status, 'empty');
  assert.equal(computeDeletionImpact({ a: 1 }, ['ghost']).status, 'empty');
  assert.equal(computeDeletionImpact({ a: 1 }, undefined).status, 'empty');
});

test('勾选键去重并忽略不存在的键，deleting 保持原结果键序', () => {
  const r = computeDeletionImpact({ a: 1, b: 2 }, ['b', 'a', 'a', 'ghost']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.deleting, ['a', 'b']);
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
  const r = computeDeletionImpact(doc, ['target']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.affected, [{ key: 'deep', chain: ['deep', 'target'] }]);
});
