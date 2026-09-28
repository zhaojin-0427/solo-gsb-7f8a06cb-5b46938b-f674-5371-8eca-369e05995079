'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, MISSING, deepEqual } = require('../lib/merge.js');

test('单方修改自动合入', () => {
  const { result, conflicts } = merge({ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 1, b: 2 });
  assert.deepEqual(result, { a: 1, b: 3 });
  assert.equal(conflicts.length, 0);
});

test('双方相同修改自动合入', () => {
  const { result, conflicts } = merge({ a: 1 }, { a: 2 }, { a: 2 });
  assert.deepEqual(result, { a: 2 });
  assert.equal(conflicts.length, 0);
});

test('双方不同修改产生冲突，可按路径选择', () => {
  const base = { a: 1 };
  const mine = { a: 2 };
  const theirs = { a: 3 };

  const first = merge(base, mine, theirs);
  assert.equal(first.conflicts.length, 1);
  assert.deepEqual(first.conflicts[0].path, ['a']);
  assert.equal(first.conflicts[0].key, '["a"]');

  const useMine = merge(base, mine, theirs, new Map([[first.conflicts[0].key, 'mine']]));
  assert.deepEqual(useMine.result, { a: 2 });
  assert.equal(useMine.conflicts.length, 0);

  const useTheirs = merge(base, mine, theirs, { '[\"a\"]': 'theirs' });
  assert.deepEqual(useTheirs.result, { a: 3 });
});

test('删除与修改相撞产生冲突，且缺失以 MISSING 表示', () => {
  const base = { a: 1, keep: true };
  const mine = { keep: true };            // 我删除了 a
  const theirs = { a: 2, keep: true };    // 对方修改了 a

  const { conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].mine, MISSING);
  assert.equal(conflicts[0].theirs, 2);

  // 选择我的删除：结果中不含 a
  const del = merge(base, mine, theirs, new Map([[conflicts[0].key, 'mine']]));
  assert.deepEqual(del.result, { keep: true });
  assert.ok(!('a' in del.result));

  // 选择对方的修改
  const keep = merge(base, mine, theirs, new Map([[conflicts[0].key, 'theirs']]));
  assert.deepEqual(keep.result, { a: 2, keep: true });
});

test('双方都删除同一字段：自动合入（字段消失）', () => {
  const { result, conflicts } = merge({ a: 1, b: 1 }, { b: 1 }, { b: 1 });
  assert.deepEqual(result, { b: 1 });
  assert.equal(conflicts.length, 0);
});

test('区分字段缺失与 null：删除 null 字段算改动', () => {
  // 基线 a 为 null，我删除了 a，对方未动 → 自动采用我的删除
  const { result, conflicts } = merge({ a: null }, {}, { a: null });
  assert.deepEqual(result, {});
  assert.ok(!('a' in result));
  assert.equal(conflicts.length, 0);
});

test('区分字段缺失与 null：新增 null 字段算改动', () => {
  const { result, conflicts } = merge({}, { a: null }, {});
  assert.deepEqual(result, { a: null });
  assert.ok('a' in result);
  assert.equal(conflicts.length, 0);
});

test('区分字段缺失与 null：删除 vs 改成 1 是冲突而非自动采用', () => {
  // 若把 null 与缺失混为一谈，这里会误判“对方未动”而自动删除
  const { conflicts } = merge({ a: null }, {}, { a: 1 });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].mine, MISSING);
});

test('数组作为整体值比较，不做元素级合并', () => {
  const base = { arr: [1, 2] };
  const mine = { arr: [1, 2, 3] };
  const theirs = { arr: [1, 2, 4] };

  const { conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].path, ['arr']);
  assert.deepEqual(conflicts[0].mine, [1, 2, 3]);
  assert.deepEqual(conflicts[0].theirs, [1, 2, 4]);

  const r = merge(base, mine, theirs, new Map([[conflicts[0].key, 'mine']]));
  assert.deepEqual(r.result, { arr: [1, 2, 3] });
});

test('数组单方修改自动合入', () => {
  const { result, conflicts } = merge({ arr: [1] }, { arr: [1, 2] }, { arr: [1] });
  assert.deepEqual(result, { arr: [1, 2] });
  assert.equal(conflicts.length, 0);
});

test('嵌套对象逐键递归合并', () => {
  const base = { o: { x: 1, y: 1 } };
  const mine = { o: { x: 2, y: 1 } };
  const theirs = { o: { x: 1, y: 2 } };
  const { result, conflicts } = merge(base, mine, theirs);
  assert.deepEqual(result, { o: { x: 2, y: 2 } });
  assert.equal(conflicts.length, 0);
});

test('双方新增同名对象键：按键递归合并而非整体冲突', () => {
  const base = {};
  const mine = { o: { a: 1 } };
  const theirs = { o: { b: 2 } };
  const { result, conflicts } = merge(base, mine, theirs);
  assert.deepEqual(result, { o: { a: 1, b: 2 } });
  assert.equal(conflicts.length, 0);
});

test('根节点为数组时也可合并', () => {
  const { result, conflicts } = merge([1], [1, 2], [1]);
  assert.deepEqual(result, [1, 2]);
  assert.equal(conflicts.length, 0);
});

test('deepEqual：MISSING 不等于 null / undefined / 自身以外任何值', () => {
  assert.equal(deepEqual(MISSING, null), false);
  assert.equal(deepEqual(MISSING, undefined), false);
  assert.equal(deepEqual(MISSING, MISSING), true);
  assert.equal(deepEqual(null, null), true);
});

// 构造 depth 层对象链 {a:{a:...{a:v}}}，迭代实现，自身不占用调用栈
function chain(v, depth) {
  let obj = v;
  for (let i = 0; i < depth; i++) obj = { a: obj };
  return obj;
}

test('超深嵌套对象链（约 3800 层）：合并不抛 RangeError，列出末端冲突', () => {
  const depth = 3800;
  const base = chain(0, depth);
  const mine = chain(1, depth);
  const theirs = chain(2, depth);

  // 三个输入均能解析并分别序列化
  const text = JSON.stringify(base);
  assert.ok(deepEqual(JSON.parse(text), base));

  const first = merge(base, mine, theirs);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].path.length, depth);
  assert.ok(first.conflicts[0].path.every((k) => k === 'a'));
  assert.equal(first.conflicts[0].base, 0);
  assert.equal(first.conflicts[0].mine, 1);
  assert.equal(first.conflicts[0].theirs, 2);
  // 未解决时结果中冲突位置以「我的版本」占位
  assert.ok(deepEqual(first.result, mine));

  // 选边后生成正确结果
  const key = first.conflicts[0].key;
  const useMine = merge(base, mine, theirs, new Map([[key, 'mine']]));
  assert.equal(useMine.conflicts.length, 0);
  assert.ok(deepEqual(useMine.result, mine));

  const useTheirs = merge(base, mine, theirs, new Map([[key, 'theirs']]));
  assert.equal(useTheirs.conflicts.length, 0);
  assert.ok(deepEqual(useTheirs.result, theirs));
});

test('超深嵌套对象链：单方修改与双方相同修改自动合入', () => {
  const depth = 3800;
  // 只有我改了：采用我的
  const onlyMine = merge(chain(0, depth), chain(1, depth), chain(0, depth));
  assert.equal(onlyMine.conflicts.length, 0);
  assert.ok(deepEqual(onlyMine.result, chain(1, depth)));

  // 双方相同改动：自动合入
  const both = merge(chain(0, depth), chain(2, depth), chain(2, depth));
  assert.equal(both.conflicts.length, 0);
  assert.ok(deepEqual(both.result, chain(2, depth)));
});

test('deepEqual：超深嵌套（对象链与数组链）不抛 RangeError', () => {
  const depth = 3800;
  assert.equal(deepEqual(chain(0, depth), chain(0, depth)), true);
  assert.equal(deepEqual(chain(0, depth), chain(1, depth)), false);

  let arrA = 0;
  let arrB = 0;
  for (let i = 0; i < depth; i++) {
    arrA = [arrA];
    arrB = [arrB];
  }
  assert.equal(deepEqual(arrA, arrB), true);
  assert.equal(deepEqual(arrA, [arrB]), false);
});
