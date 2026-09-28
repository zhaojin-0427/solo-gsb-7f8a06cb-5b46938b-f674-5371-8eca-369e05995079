'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('../lib/merge.js');
const SuggestLib = require('../lib/suggest.js');

// 构造 n 个互不嵌套的标量冲突：base 全 0、mine 全 1、theirs 全 2，
// 键 k0..k(n-1) 按插入顺序排列，冲突列表索引与键序一致
function makeInputs(n) {
  const base = {};
  const mine = {};
  const theirs = {};
  for (let i = 0; i < n; i++) {
    base['k' + i] = 0;
    mine['k' + i] = 1;
    theirs['k' + i] = 2;
  }
  return { base, mine, theirs };
}

function resolveAll(conflicts, side) {
  return new Map(conflicts.map((c) => [c.key, side]));
}

function search(n, resolutions, validate) {
  const { base, mine, theirs } = makeInputs(n);
  const { conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts.length, n);
  return SuggestLib.suggestMinimalFlips({
    base, mine, theirs, conflicts, resolutions, validate,
  });
}

test('超过 10 个冲突：直接报告超限，不尝试任何校验', () => {
  let calls = 0;
  const r = search(11, undefined, () => { calls++; return true; });
  assert.equal(r.status, 'too-many');
  assert.equal(r.total, 11);
  assert.equal(r.max, 10);
  assert.equal(calls, 0);
});

test('单个翻转即可通过：返回字典序最小的 1 元组合', () => {
  // 只有 k0 取对方（2）才通过；k=1 的第一个组合 {0} 即命中
  const r = search(3, undefined, (d) => d.k0 === 2);
  assert.equal(r.status, 'found');
  assert.equal(r.attempts, 1);
  assert.equal(r.flips.length, 1);
  assert.deepEqual(r.flips[0].path, ['k0']);
  assert.equal(r.flips[0].index, 0);
  assert.equal(r.flips[0].from, 'mine'); // 未选边时按 mine 兜底
  assert.equal(r.flips[0].to, 'theirs');
});

test('枚举顺序：先按翻转个数，同数按索引组合字典序', () => {
  // 需要 k0、k2 都取对方才通过：
  // k=1 的 {0} {1} {2} 全部失败，k=2 依次试 {0,1} 失败后命中 {0,2}
  const r = search(3, undefined, (d) => d.k0 === 2 && d.k2 === 2);
  assert.equal(r.status, 'found');
  assert.equal(r.attempts, 5); // 3 个 1 元组合 + {0,1} + {0,2}
  assert.deepEqual(r.flips.map((f) => f.index), [0, 2]);
  assert.deepEqual(r.flips.map((f) => f.path), [['k0'], ['k2']]);
});

test('从对方翻回我的：from/to 如实记录当前选边', () => {
  const { base, mine, theirs } = makeInputs(2);
  const { conflicts } = merge(base, mine, theirs);
  const r = SuggestLib.suggestMinimalFlips({
    base, mine, theirs, conflicts,
    resolutions: resolveAll(conflicts, 'theirs'),
    validate: (d) => d.k1 === 1, // k1 取我的（1）才通过
  });
  assert.equal(r.status, 'found');
  assert.equal(r.flips.length, 1);
  assert.equal(r.flips[0].from, 'theirs');
  assert.equal(r.flips[0].to, 'mine');
  assert.equal(r.flips[0].key, conflicts[1].key);
});

test('应用建议后的合并结果确实通过校验，且未建议的冲突保持原选边', () => {
  const { base, mine, theirs } = makeInputs(3);
  const { conflicts } = merge(base, mine, theirs);
  const validate = (d) => d.k0 === 2 && d.k2 === 2;
  const resolutions = resolveAll(conflicts, 'mine');
  const r = SuggestLib.suggestMinimalFlips({
    base, mine, theirs, conflicts, resolutions, validate,
  });
  assert.equal(r.status, 'found');

  for (const f of r.flips) resolutions.set(f.key, f.to);
  const { result } = merge(base, mine, theirs, resolutions);
  assert.ok(validate(result));
  assert.deepEqual(result, { k0: 2, k1: 1, k2: 2 }); // k1 未翻转，仍是我的
});

test('穷尽全部组合仍不通过：报告无解，尝试次数为 2^n - 1', () => {
  const r = search(3, undefined, () => false);
  assert.equal(r.status, 'none');
  assert.equal(r.attempts, 7);
});

test('没有冲突且当前结果不通过：搜索空间为空，直接无解', () => {
  const r = search(0, undefined, () => false);
  assert.equal(r.status, 'none');
  assert.equal(r.attempts, 0);
});

test('当前结果本已通过：无需改选（兜底分支）', () => {
  const r = search(2, undefined, () => true);
  assert.equal(r.status, 'found');
  assert.deepEqual(r.flips, []);
  assert.equal(r.attempts, 0);
});

test('resolutions 支持普通对象形式', () => {
  const { base, mine, theirs } = makeInputs(2);
  const { conflicts } = merge(base, mine, theirs);
  const resolutions = {};
  for (const c of conflicts) resolutions[c.key] = 'mine';
  const r = SuggestLib.suggestMinimalFlips({
    base, mine, theirs, conflicts, resolutions,
    validate: (d) => d.k1 === 2,
  });
  assert.equal(r.status, 'found');
  assert.deepEqual(r.flips.map((f) => f.index), [1]);
});

test('删除与修改相撞的冲突同样参与翻转', () => {
  // 我删除了 a，对方改成了 2；Schema 要求 a 必须存在且为 2
  const base = { a: 1, keep: true };
  const mine = { keep: true };
  const theirs = { a: 2, keep: true };
  const { conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts.length, 1);
  const r = SuggestLib.suggestMinimalFlips({
    base, mine, theirs, conflicts,
    resolutions: resolveAll(conflicts, 'mine'), // 当前选我的删除 -> 缺 a
    validate: (d) => d.a === 2,
  });
  assert.equal(r.status, 'found');
  assert.equal(r.flips.length, 1);
  assert.equal(r.flips[0].from, 'mine');
  assert.equal(r.flips[0].to, 'theirs');
});
