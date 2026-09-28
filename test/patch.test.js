'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diff, apply, deepEqual } = require('../lib/patch.js');
const { merge } = require('../lib/merge.js');

test('结果未变化时生成空数组', () => {
  assert.deepEqual(diff({ a: 1, b: [1, 2], c: null }, { a: 1, b: [1, 2], c: null }), []);
  assert.deepEqual(diff([1, [2, [3]]], [1, [2, [3]]]), []);
  assert.deepEqual(diff(1, 1), []);
  assert.deepEqual(diff(null, null), []);
  assert.deepEqual(diff({}, {}), []);
  assert.deepEqual(diff([], []), []);
});

test('对象逐键生成 add / remove / replace', () => {
  const base = { a: 1, b: 2, c: 3 };
  const target = { a: 1, b: 20, d: 4 };
  const ops = diff(base, target);
  assert.deepEqual(ops, [
    { op: 'remove', path: '/c' },
    { op: 'replace', path: '/b', value: 20 },
    { op: 'add', path: '/d', value: 4 },
  ]);
  assert.deepEqual(apply(base, ops), target);
});

test('字段缺失不当作 null', () => {
  // 删除 null 字段 → remove（不是 replace 成别的什么）
  assert.deepEqual(diff({ a: null }, {}), [{ op: 'remove', path: '/a' }]);
  // 新增 null 字段 → add 且 value 为 null
  assert.deepEqual(diff({}, { a: null }), [{ op: 'add', path: '/a', value: null }]);
  // 两边都是 null → 无操作
  assert.deepEqual(diff({ a: null }, { a: null }), []);
  // null 与值互变 → replace
  assert.deepEqual(diff({ a: 1 }, { a: null }), [{ op: 'replace', path: '/a', value: null }]);
  assert.deepEqual(diff({ a: null }, { a: 1 }), [{ op: 'replace', path: '/a', value: 1 }]);
  // 重放后键的存在性与目标一致
  const out = apply({ a: null, b: 1 }, diff({ a: null, b: 1 }, { b: 1, c: null }));
  assert.ok(!('a' in out));
  assert.ok('c' in out);
  assert.equal(out.c, null);
});

test('键名中的 ~ 与 / 按 RFC 6901 转义，空键与空字符串根路径正确', () => {
  const base = { 'a/b': 1, 'c~d': 1, '~1': 1, '': 1 };
  const target = { 'a/b': 2, 'c~d': 2, '~1': 2, '': 2 };
  const ops = diff(base, target);
  assert.deepEqual(ops.map((o) => o.path), ['/a~1b', '/c~0d', '/~01', '/']);
  assert.deepEqual(apply(base, ops), target);
});

test('根路径为空字符串：整文档 replace', () => {
  assert.deepEqual(diff(1, 2), [{ op: 'replace', path: '', value: 2 }]);
  assert.deepEqual(diff({ a: 1 }, [1]), [{ op: 'replace', path: '', value: [1] }]);
  assert.deepEqual(diff(null, { a: 1 }), [{ op: 'replace', path: '', value: { a: 1 } }]);
  assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: [1] }]), [1]);
});

test('数组：纯追加生成单个 add，索引即执行时索引', () => {
  const ops = diff([1, 2], [1, 2, 3]);
  assert.deepEqual(ops, [{ op: 'add', path: '/2', value: 3 }]);
  assert.deepEqual(apply([1, 2], ops), [1, 2, 3]);
});

test('数组：纯截尾反复在同一索引 remove', () => {
  const ops = diff([1, 2, 3], [1]);
  assert.deepEqual(ops, [
    { op: 'remove', path: '/1' },
    { op: 'remove', path: '/1' },
  ]);
  assert.deepEqual(apply([1, 2, 3], ops), [1]);
});

test('数组：头部插入', () => {
  const ops = diff([2, 3], [1, 2, 3]);
  assert.deepEqual(ops, [{ op: 'add', path: '/0', value: 1 }]);
  assert.deepEqual(apply([2, 3], ops), [1, 2, 3]);
});

test('数组：LCS 对齐完整元素，生成数量最少的 add/remove（无 move/copy）', () => {
  const base = [1, 2, 3, 4, 5];
  const target = [1, 9, 3, 5, 7];
  const ops = diff(base, target);
  // LCS 为 [1, 3, 5]，最少操作数 = (5 - 3) + (5 - 3) = 4
  assert.equal(ops.length, 4);
  assert.ok(ops.every((o) => o.op === 'add' || o.op === 'remove'));
  assert.deepEqual(ops, [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/1', value: 9 },
    { op: 'remove', path: '/3' },
    { op: 'add', path: '/4', value: 7 },
  ]);
  assert.deepEqual(apply(base, ops), target);
});

test('数组：对象元素作为整体比较，不做元素级合并', () => {
  const ops = diff([{ a: 1 }, { b: 2 }], [{ a: 1 }, { c: 3 }]);
  assert.deepEqual(ops, [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/1', value: { c: 3 } },
  ]);
  assert.deepEqual(apply([{ a: 1 }, { b: 2 }], ops), [{ a: 1 }, { c: 3 }]);
});

test('数组：嵌套数组元素不同则整体 remove + add', () => {
  const ops = diff([[1, 2], [3]], [[1, 2], [3, 4]]);
  assert.deepEqual(ops, [
    { op: 'remove', path: '/1' },
    { op: 'add', path: '/1', value: [3, 4] },
  ]);
  assert.deepEqual(apply([[1, 2], [3]], ops), [[1, 2], [3, 4]]);
});

test('对象键下的数组：路径拼接正确', () => {
  const ops = diff({ arr: [1, 2] }, { arr: [1, 3, 2] });
  assert.deepEqual(ops, [{ op: 'add', path: '/arr/1', value: 3 }]);
  assert.deepEqual(apply({ arr: [1, 2] }, ops), { arr: [1, 3, 2] });
});

test('生成的操作只含 add / remove / replace', () => {
  const cases = [
    [{ a: 1, b: [1, 2, 3] }, { b: [3, 2], c: { d: null } }],
    [[1, 2, 3, 4], [4, 3, 2, 1]],
    [{ x: { y: { z: 1 } } }, { x: { y: { z: [1, 2] } } }],
  ];
  for (const [b, t] of cases) {
    const ops = diff(b, t);
    assert.ok(ops.every((o) => ['add', 'remove', 'replace'].includes(o.op)));
    assert.deepEqual(apply(b, ops), t);
  }
});

test('apply 不改动基线与补丁本身', () => {
  const base = { a: [1, 2], o: { x: 1 } };
  const baseSnap = JSON.stringify(base);
  const ops = diff(base, { a: [2], o: { x: 2, y: 3 } });
  const opsSnap = JSON.stringify(ops);
  const out = apply(base, ops);
  assert.deepEqual(out, { a: [2], o: { x: 2, y: 3 } });
  assert.equal(JSON.stringify(base), baseSnap);
  assert.equal(JSON.stringify(ops), opsSnap);
});

test('apply 严格校验：缺失字段、越界下标、未知操作、缺 value 均报错', () => {
  assert.throws(() => apply({}, [{ op: 'remove', path: '/a' }]), /不存在/);
  assert.throws(() => apply({}, [{ op: 'replace', path: '/a', value: 1 }]), /不存在/);
  assert.throws(() => apply([1], [{ op: 'remove', path: '/5' }]), /越界/);
  assert.throws(() => apply([1], [{ op: 'add', path: '/5', value: 2 }]), /越界/);
  assert.throws(() => apply({}, [{ op: 'move', from: '/a', path: '/b' }]), /不支持/);
  assert.throws(() => apply({}, [{ op: 'add', path: '/a' }]), /value/);
  assert.throws(() => apply({ a: 1 }, [{ op: 'remove', path: '/a/0' }]), /标量/);
  // 值为 null 的字段视为存在，可以 remove / replace
  assert.deepEqual(apply({ a: null }, [{ op: 'remove', path: '/a' }]), {});
  assert.deepEqual(apply({ a: null }, [{ op: 'replace', path: '/a', value: 1 }]), { a: 1 });
  // 数组末尾追加支持 "-" 与 length 下标两种写法
  assert.deepEqual(apply([1], [{ op: 'add', path: '/-', value: 2 }]), [1, 2]);
  assert.deepEqual(apply([1], [{ op: 'add', path: '/1', value: 2 }]), [1, 2]);
  // 对象上 add 已存在的字段等价于替换（RFC 6902）
  assert.deepEqual(apply({ a: 1 }, [{ op: 'add', path: '/a', value: 2 }]), { a: 2 });
});

test('与三方合并集成：补丁作用于本轮基线后得到合并结果', () => {
  const base = { name: 'app', config: { port: 3000, debug: false }, tags: ['a', 'b'], legacy: 1 };
  const mine = { name: 'app', config: { port: 8080, debug: false }, tags: ['a', 'b', 'c'] };
  const theirs = { name: 'app2', config: { port: 3000, debug: true }, tags: ['a', 'b', 'c'] };

  const { result, conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  const ops = diff(base, result);
  assert.deepEqual(apply(base, ops), result);
});

test('与三方合并集成：冲突按路径解决后再生成补丁', () => {
  const base = { a: 1, keep: true };
  const mine = { a: 2, keep: true };
  const theirs = { a: 3, keep: true };

  const first = merge(base, mine, theirs);
  assert.equal(first.conflicts.length, 1);

  const resolved = merge(base, mine, theirs, new Map([[first.conflicts[0].key, 'theirs']]));
  assert.equal(resolved.conflicts.length, 0);
  const ops = diff(base, resolved.result);
  assert.deepEqual(ops, [{ op: 'replace', path: '/a', value: 3 }]);
  assert.deepEqual(apply(base, ops), resolved.result);
});

// 构造 depth 层对象链 {a:{a:...{a:v}}}，迭代实现，自身不占用调用栈
function chain(v, depth) {
  let obj = v;
  for (let i = 0; i < depth; i++) obj = { a: obj };
  return obj;
}

test('超深嵌套对象链（约 3800 层）：diff / apply 不抛 RangeError', () => {
  const depth = 3800;
  const ops = diff(chain(0, depth), chain(1, depth));
  assert.deepEqual(ops, [{ op: 'replace', path: '/a'.repeat(depth), value: 1 }]);
  // assert.deepEqual 自身是递归实现，超深结构用库内的迭代版 deepEqual 校验
  assert.ok(deepEqual(apply(chain(0, depth), ops), chain(1, depth)));
});

// 确定性伪随机数（LCG），保证测试可复现
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomValue(rand, depth) {
  const r = rand();
  if (depth <= 0 || r < 0.35) {
    const c = Math.floor(rand() * 5);
    if (c === 0) return null;
    if (c === 1) return rand() < 0.5;
    if (c === 2) return Math.floor(rand() * 1000) - 500;
    if (c === 3) return 's' + Math.floor(rand() * 10) + (rand() < 0.2 ? '~/' : '');
    return rand() < 0.5 ? 0 : 1.5;
  }
  if (r < 0.7) {
    const arr = [];
    const len = Math.floor(rand() * 5);
    for (let i = 0; i < len; i++) arr.push(randomValue(rand, depth - 1));
    return arr;
  }
  const keys = ['a', 'b', 'c', 'x/y', 'z~w', ''];
  const obj = {};
  const len = Math.floor(rand() * 5);
  for (let i = 0; i < len; i++) {
    const k = keys[Math.floor(rand() * keys.length)] + (rand() < 0.3 ? String(i) : '');
    obj[k] = randomValue(rand, depth - 1);
  }
  return obj;
}

test('随机用例：apply(base, diff(base, target)) 恒等于 target', () => {
  const rand = lcg(20260923);
  for (let i = 0; i < 300; i++) {
    const base = randomValue(rand, 4);
    const target = randomValue(rand, 4);
    const ops = diff(base, target);
    assert.ok(ops.every((o) => ['add', 'remove', 'replace'].includes(o.op)));
    assert.deepEqual(apply(base, ops), target);
    // 基线未被改动
    assert.deepEqual(apply(base, []), base);
  }
});

// 参照实现：朴素的 O(n·m) LCS 长度动态规划，仅用于小规模用例校验
function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = deepEqual(a[i], b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

test('数组：重复元素按序列位置正确配对，操作数最少且可重放', () => {
  const cases = [
    [[1, 2, 1, 2, 1], [2, 1, 2, 1]],
    [['a', 'b', 'a', 'a'], ['a', 'a', 'b', 'a']],
    [[{ v: 1 }, { v: 1 }, { v: 2 }], [{ v: 1 }, { v: 2 }, { v: 1 }]],
    [[1, 1, 1], [1, 1, 1, 1]],
    [[1, 1, 1, 1], [1, 1]],
  ];
  for (const [base, target] of cases) {
    const ops = diff(base, target);
    // 操作数 = (n - lcs) + (m - lcs)，与参照实现的最优值一致
    const lcs = lcsLength(base, target);
    assert.equal(ops.length, base.length + target.length - 2 * lcs);
    assert.ok(ops.every((o) => o.op === 'add' || o.op === 'remove'));
    assert.deepEqual(apply(base, ops), target);
  }
});

test('大数组：9000 个互不重合的整数，线性内存、操作最少、重放一致', () => {
  const N = 9000;
  const base = Array.from({ length: N }, (_, i) => i);
  const target = Array.from({ length: N }, (_, i) => i + N);
  const before = process.memoryUsage().arrayBuffers;
  const ops = diff(base, target);
  const during = process.memoryUsage().arrayBuffers;
  // 对齐不再保留 n×m 矩阵：旧实现此处约需 405 MB ArrayBuffer，
  // 线性空间实现只剩两条滚动行（约 72 KB），留足余量限制在 2 MB 内
  assert.ok(
    during - before < 2 * 1024 * 1024,
    `diff 期间 ArrayBuffer 增长 ${during - before} 字节，应小于 2 MB`,
  );
  // 完全不重合：最少操作数 = 9000 次 remove + 9000 次 add
  assert.equal(ops.length, 2 * N);
  assert.ok(ops.every((o) => o.op === 'add' || o.op === 'remove'));
  assert.deepEqual(apply(base, ops), target);
});
