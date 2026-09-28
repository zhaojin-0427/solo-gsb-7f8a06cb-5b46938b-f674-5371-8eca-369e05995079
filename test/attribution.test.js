'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, MISSING } = require('../lib/merge.js');
const { attribute, attributeMerge, serializeEntries } = require('../lib/attribution.js');

// 无冲突场景的便捷入口：合并后计算归因
function run(base, mine, theirs) {
  const first = merge(base, mine, theirs);
  const merged = merge(base, mine, theirs, {});
  return { result: merged.result, entries: attribute(base, mine, theirs, merged.result, first.conflicts, {}) };
}

// 有冲突场景：choices 为按冲突顺序的 'mine' | 'theirs' 数组（或函数）
function resolveAll(base, mine, theirs, choices) {
  const first = merge(base, mine, theirs);
  const resolutions = new Map();
  first.conflicts.forEach((c, i) => {
    resolutions.set(c.key, typeof choices === 'function' ? choices(c) : choices[i]);
  });
  const merged = merge(base, mine, theirs, resolutions);
  return {
    result: merged.result,
    entries: attribute(base, mine, theirs, merged.result, first.conflicts, resolutions),
  };
}

// 每条只留 [路径, 操作, 来源]，便于断言
function brief(entries) {
  return entries.map((e) => [e.pointer, e.op, e.source]);
}

test('对象逐键下钻：仅我 / 仅对方 / 双方同改，父项不重复列出', () => {
  const base = { o: { x: 1, y: 1, z: 1 } };
  const mine = { o: { x: 2, y: 1, z: 9 } };
  const theirs = { o: { x: 1, y: 2, z: 9 } };
  const { entries } = run(base, mine, theirs);
  assert.deepEqual(brief(entries), [
    ['/o/x', 'replace', 'mine'],
    ['/o/y', 'replace', 'theirs'],
    ['/o/z', 'replace', 'both'],
  ]);
  // 下钻后父路径 /o 不再出现
  assert.ok(entries.every((e) => e.pointer !== '/o'));
  assert.equal(entries[0].base, 1);
  assert.equal(entries[0].result, 2);
});

test('条目按基线键序展开，结果新增键排在其后', () => {
  const base = { b: 1, a: 1 };
  const mine = { b: 2, a: 2, n: 1 };
  const theirs = { b: 2, a: 1, n: 1 };
  const { entries } = run(base, mine, theirs);
  assert.deepEqual(entries.map((e) => e.pointer), ['/b', '/a', '/n']);
});

test('新增与删除：缺失用 MISSING 表示，与 null 严格区分', () => {
  const base = { keep: 1, gone: null };
  const mine = { keep: 1, gone: null, added: null }; // 我新增了 null 字段
  const theirs = { keep: 1 };                        // 对方删除了 null 字段
  const { entries } = run(base, mine, theirs);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].pointer, '/gone');
  assert.equal(entries[0].op, 'remove');
  assert.equal(entries[0].base, null);      // 基线值是 null，不是缺失
  assert.equal(entries[0].result, MISSING); // 结果中该字段不存在
  assert.equal(entries[0].source, 'theirs');

  assert.equal(entries[1].pointer, '/added');
  assert.equal(entries[1].op, 'add');
  assert.equal(entries[1].base, MISSING);
  assert.equal(entries[1].result, null);
  assert.equal(entries[1].source, 'mine');
});

test('导出值用存在标记区分字段缺失与 null', () => {
  const base = { gone: null };
  const mine = { gone: null, added: null };
  const theirs = {};
  const { entries } = run(base, mine, theirs);
  const json = serializeEntries(entries);
  assert.deepEqual(json, [
    {
      pointer: '/gone',
      op: 'remove',
      source: 'theirs',
      base: { exists: true, value: null },
      result: { exists: false },
    },
    {
      pointer: '/added',
      op: 'add',
      source: 'mine',
      base: { exists: false },
      result: { exists: true, value: null },
    },
  ]);
  // 缺失标记没有 value 键，与 { exists: true, value: null } 绝不混淆
  assert.ok(!('value' in json[0].result));
  assert.ok(!('value' in json[1].base));
});

test('数组与类型替换作为整体，不做元素级展开', () => {
  const base = { arr: [1, 2], v: { x: 1 } };
  const mine = { arr: [1, 2, 3], v: [1] };
  const theirs = { arr: [1, 2], v: { x: 1 } };
  const { entries } = run(base, mine, theirs);
  assert.deepEqual(brief(entries), [
    ['/arr', 'replace', 'mine'],
    ['/v', 'replace', 'mine'],
  ]);
  assert.deepEqual(entries[0].base, [1, 2]);
  assert.deepEqual(entries[0].result, [1, 2, 3]);
});

test('无改动时清单为空；双方同时删除记为双方同改', () => {
  assert.deepEqual(run({ a: 1 }, { a: 1 }, { a: 1 }).entries, []);
  const { entries } = run({ a: 1, b: 1 }, { b: 1 }, { b: 1 });
  assert.deepEqual(brief(entries), [['/a', 'remove', 'both']]);
});

test('冲突选择决定来源，被放弃一侧的改动不入清单', () => {
  const base = { a: 1 };
  const mine = { a: 2 };
  const theirs = { a: 3 };

  const useMine = resolveAll(base, mine, theirs, ['mine']);
  assert.deepEqual(brief(useMine.entries), [['/a', 'replace', 'conflict-mine']]);
  assert.equal(useMine.entries[0].base, 1);
  assert.equal(useMine.entries[0].result, 2);

  const useTheirs = resolveAll(base, mine, theirs, ['theirs']);
  assert.deepEqual(brief(useTheirs.entries), [['/a', 'replace', 'conflict-theirs']]);
  assert.equal(useTheirs.entries[0].result, 3);
  // 只有一条：被放弃的一侧不另列条目
  assert.equal(useTheirs.entries.length, 1);
});

test('删除与修改相撞：选择删除为 remove，选择修改为 replace', () => {
  const base = { a: 1, keep: true };
  const mine = { keep: true };         // 我删除了 a
  const theirs = { a: 2, keep: true }; // 对方修改了 a

  const del = resolveAll(base, mine, theirs, ['mine']);
  assert.deepEqual(brief(del.entries), [['/a', 'remove', 'conflict-mine']]);
  assert.equal(del.entries[0].base, 1);
  assert.equal(del.entries[0].result, MISSING);

  const keep = resolveAll(base, mine, theirs, ['theirs']);
  assert.deepEqual(brief(keep.entries), [['/a', 'replace', 'conflict-theirs']]);
  assert.equal(keep.entries[0].result, 2);
});

test('冲突子树内的下钻改动同样归因于冲突选择', () => {
  const base = { o: { x: 1 } };
  const mine = { o: { x: 2 } };
  const theirs = { o: 'str' }; // 对方把对象整体改成字符串：冲突在 /o

  // 选我：基线 /o 与结果 /o 都是对象，下钻到 /o/x，来源仍是冲突选我
  const useMine = resolveAll(base, mine, theirs, ['mine']);
  assert.deepEqual(brief(useMine.entries), [['/o/x', 'replace', 'conflict-mine']]);

  // 选对方：类型替换作为整体列在 /o
  const useTheirs = resolveAll(base, mine, theirs, ['theirs']);
  assert.deepEqual(brief(useTheirs.entries), [['/o', 'replace', 'conflict-theirs']]);
  assert.equal(useTheirs.entries[0].result, 'str');
});

test('双方把同一位置改成不同对象：按键自动合并，整体列出来源为双方同改', () => {
  const base = { a: 5 };
  const mine = { a: { x: 1 } };
  const theirs = { a: { y: 2 } };
  const { result, entries } = run(base, mine, theirs);
  assert.deepEqual(result, { a: { x: 1, y: 2 } });
  // 基线不是对象：类型替换作为整体列出
  assert.deepEqual(brief(entries), [['/a', 'replace', 'both']]);
  assert.deepEqual(entries[0].result, { x: 1, y: 2 });
});

test('双方新增同名对象键：基线缺失时整体 add，来源双方同改', () => {
  const base = {};
  const mine = { o: { a: 1 } };
  const theirs = { o: { b: 2 } };
  const { result, entries } = run(base, mine, theirs);
  assert.deepEqual(result, { o: { a: 1, b: 2 } });
  assert.deepEqual(brief(entries), [['/o', 'add', 'both']]);
  assert.equal(entries[0].base, MISSING);
  assert.deepEqual(entries[0].result, { a: 1, b: 2 });
});

test('根路径为空字符串；键名中的 ~ 与 / 按 RFC 6901 转义', () => {
  const root = run(1, 2, 1);
  assert.deepEqual(brief(root.entries), [['', 'replace', 'mine']]);

  const base = { 'a/b': { 'c~d': 1 } };
  const mine = { 'a/b': { 'c~d': 2 } };
  const { entries } = run(base, mine, base);
  assert.deepEqual(brief(entries), [['/a~1b/c~0d', 'replace', 'mine']]);
});

test('attributeMerge：冲突未解决时 entries 为 null，解决后给出清单', () => {
  const base = { a: 1 };
  const mine = { a: 2 };
  const theirs = { a: 3 };

  const unresolved = attributeMerge(base, mine, theirs);
  assert.equal(unresolved.entries, null);
  assert.equal(unresolved.conflicts.length, 1);

  const key = unresolved.conflicts[0].key;
  const resolved = attributeMerge(base, mine, theirs, new Map([[key, 'theirs']]));
  assert.equal(resolved.conflicts.length, 1); // 冲突清单仍是全部冲突
  assert.deepEqual(resolved.result, { a: 3 });
  assert.deepEqual(brief(resolved.entries), [['/a', 'replace', 'conflict-theirs']]);
});

test('README 归因示例（页面示例数据）', () => {
  const base = {
    name: 'demo-app',
    version: '1.0.0',
    config: { port: 3000, host: '0.0.0.0', debug: false },
    tags: ['a', 'b'],
    description: '示例应用',
    deprecated: null,
    owner: 'team-a',
  };
  const mine = {
    name: 'demo-app',
    version: '1.1.0',
    config: { port: 8080, host: '0.0.0.0', debug: false },
    tags: ['a', 'b', 'c'],
    deprecated: null,
    owner: 'team-a',
    license: 'MIT',
  };
  const theirs = {
    name: 'demo-app',
    version: '1.1.0',
    config: { port: 9090, host: '0.0.0.0', debug: true },
    tags: ['a', 'b', 'c'],
    description: '示例应用 v2',
    owner: 'team-a',
  };
  // 冲突：/config/port 选我的 8080，/description 选对方的「示例应用 v2」
  const { entries } = resolveAll(base, mine, theirs, (c) =>
    c.path[c.path.length - 1] === 'port' ? 'mine' : 'theirs',
  );
  assert.deepEqual(serializeEntries(entries), [
    { pointer: '/version', op: 'replace', source: 'both', base: { exists: true, value: '1.0.0' }, result: { exists: true, value: '1.1.0' } },
    { pointer: '/config/port', op: 'replace', source: 'conflict-mine', base: { exists: true, value: 3000 }, result: { exists: true, value: 8080 } },
    { pointer: '/config/debug', op: 'replace', source: 'theirs', base: { exists: true, value: false }, result: { exists: true, value: true } },
    { pointer: '/tags', op: 'replace', source: 'both', base: { exists: true, value: ['a', 'b'] }, result: { exists: true, value: ['a', 'b', 'c'] } },
    { pointer: '/description', op: 'replace', source: 'conflict-theirs', base: { exists: true, value: '示例应用' }, result: { exists: true, value: '示例应用 v2' } },
    { pointer: '/deprecated', op: 'remove', source: 'theirs', base: { exists: true, value: null }, result: { exists: false } },
    { pointer: '/license', op: 'add', source: 'mine', base: { exists: false }, result: { exists: true, value: 'MIT' } },
  ]);
});

// 构造 depth 层对象链 {a:{a:...{a:v}}}，迭代实现，自身不占用调用栈
function chain(v, depth) {
  let obj = v;
  for (let i = 0; i < depth; i++) obj = { a: obj };
  return obj;
}

test('超深嵌套对象链（约 3800 层）：归因不抛 RangeError，路径与来源正确', () => {
  const depth = 3800;
  const base = chain(0, depth);
  const mine = chain(1, depth);
  const theirs = chain(2, depth);

  const first = merge(base, mine, theirs);
  const key = first.conflicts[0].key;
  const resolutions = new Map([[key, 'theirs']]);
  const merged = merge(base, mine, theirs, resolutions);
  const entries = attribute(base, mine, theirs, merged.result, first.conflicts, resolutions);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].pointer, '/a'.repeat(depth));
  assert.equal(entries[0].op, 'replace');
  assert.equal(entries[0].source, 'conflict-theirs');
  assert.equal(entries[0].base, 0);
  assert.equal(entries[0].result, 2);
});
