'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, MISSING } = require('../lib/merge.js');
const {
  VERSION,
  serializeChoices,
  parseChoicesRecord,
  validateChoicesRecord,
  planReuse,
  applyReuse,
} = require('../lib/choices.js');

// 示例三方：/a 为标量冲突，/o 为删除与修改相撞（对方删除、我的侧为对象），
// /n 为 0 / null / 5 三方各不相同（值为 null 与缺失必须可区分）
const base = { a: 1, o: { x: 1 }, n: 0 };
const mine = { a: 2, o: { x: 2 }, n: null };
const theirs = { a: 3, n: 5 };

function currentRound(resolutions) {
  return merge(base, mine, theirs, resolutions);
}

test('serializeChoices：仅含已选冲突，带路径 / 三值存在标记 / 选边', () => {
  const { conflicts } = currentRound(new Map());
  const paths = conflicts.map((c) => c.key);
  assert.deepEqual(paths, [JSON.stringify(['a']), JSON.stringify(['o']), JSON.stringify(['n'])]);

  const resolutions = new Map([
    [conflicts[0].key, 'mine'],
    [conflicts[2].key, 'theirs'],
  ]);
  const rec = serializeChoices(conflicts, resolutions);
  assert.equal(rec.version, 1);
  assert.equal(rec.choices.length, 2);
  // 未选择的 /o 不在记录中
  assert.deepEqual(rec.choices.map((c) => c.path), [['a'], ['n']]);
  assert.deepEqual(rec.choices[0], {
    path: ['a'],
    base: { exists: true, value: 1 },
    mine: { exists: true, value: 2 },
    theirs: { exists: true, value: 3 },
    choice: 'mine',
  });
  // /n：基线 0、我的 null、对方 0 —— null 作为值保留存在标记
  assert.deepEqual(rec.choices[1].mine, { exists: true, value: null });
  assert.deepEqual(rec.choices[1].base, { exists: true, value: 0 });
});

test('serializeChoices：删除与修改相撞时缺失为 {exists:false}，且不带 value 键', () => {
  const { conflicts } = currentRound(new Map());
  const oConflict = conflicts.find((c) => c.key === JSON.stringify(['o']));
  assert.equal(oConflict.theirs, MISSING);
  const rec = serializeChoices(conflicts, new Map([[oConflict.key, 'mine']]));
  assert.deepEqual(rec.choices[0].theirs, { exists: false });
  assert.deepEqual(rec.choices[0].mine, { exists: true, value: { x: 2 } });
  assert.ok(!('value' in rec.choices[0].theirs));
});

test('serializeChoices：未选任何冲突时得到空 choices（不会导出，但结构合法）', () => {
  const { conflicts } = currentRound(new Map());
  const rec = serializeChoices(conflicts, new Map());
  assert.deepEqual(rec, { version: 1, choices: [] });
  assert.equal(typeof rec.choices[0], 'undefined');
});

test('导出 → 导入往返：JSON 文本解析后条目与原冲突逐值一致（MISSING 还原）', () => {
  const { conflicts } = currentRound(new Map());
  const resolutions = new Map([
    [conflicts[0].key, 'mine'],
    [conflicts[1].key, 'theirs'],
    [conflicts[2].key, 'mine'],
  ]);
  const text = JSON.stringify(serializeChoices(conflicts, resolutions), null, 2);
  const parsed = parseChoicesRecord(text);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.entries.length, 3);
  const byKey = new Map(parsed.entries.map((e) => [e.key, e]));
  const o = byKey.get(JSON.stringify(['o']));
  assert.equal(o.theirs, MISSING); // 缺失还原为哨兵，而非 null
  assert.deepEqual(o.base, { x: 1 });
  assert.equal(byKey.get(JSON.stringify(['n'])).mine, null); // null 仍是 null
  assert.equal(o.choice, 'theirs');
});

/* ---------- 整份记录的格式校验：任何错误都拒绝整份 ---------- */

function expectError(record, part) {
  const r = typeof record === 'string'
    ? parseChoicesRecord(record)
    : validateChoicesRecord(record);
  assert.equal(r.status, 'error');
  if (part) assert.match(r.reason, part);
  assert.equal(r.entries, undefined);
  return r.reason;
}

test('空文本 / JSON 语法错误：拒绝并给出位置', () => {
  assert.equal(parseChoicesRecord('').status, 'error');
  assert.equal(parseChoicesRecord('   ').status, 'error');
  const reason = expectError('{ "version": 1, ');
  assert.match(reason, /JSON 语法错误/);
});

test('顶层结构错误：非对象、多键、版本错误、choices 非数组、空数组', () => {
  expectError([], /顶层必须是 JSON 对象/);
  expectError(null, /顶层必须是 JSON 对象/);
  assert.equal(validateChoicesRecord('s').reason.match(/顶层必须是 JSON 对象/) !== null, true);
  expectError({ version: 1, choices: [], extra: 1 }, /顶层只能含/);
  expectError({ choices: [] }, /顶层只能含/);
  expectError({ version: 2, choices: [] }, /version 必须为 1/);
  expectError({ version: '1', choices: [] }, /version 必须为 1/);
  expectError({ version: 1, choices: {} }, /choices 必须是数组/);
  expectError({ version: 1, choices: [] }, /choices 为空/);
});

function validEntry(over = {}) {
  return Object.assign({
    path: ['a'],
    base: { exists: true, value: 1 },
    mine: { exists: true, value: 2 },
    theirs: { exists: true, value: 3 },
    choice: 'mine',
  }, over);
}

test('条目结构错误：非对象、多键 / 缺键', () => {
  expectError({ version: 1, choices: [1] }, /第 1 条格式错误：每条选择必须是 JSON 对象/);
  expectError({ version: 1, choices: [null] }, /必须是 JSON 对象/);
  expectError({ version: 1, choices: [validEntry({ extra: 1 })] }, /五个键/);
  const e = validEntry();
  delete e.choice;
  expectError({ version: 1, choices: [e] }, /五个键/);
});

test('path 必须是字符串数组（含根路径空数组合法）', () => {
  expectError({ version: 1, choices: [validEntry({ path: 'a' })] }, /path 必须是字符串数组/);
  expectError({ version: 1, choices: [validEntry({ path: ['a', 1] })] }, /path 必须是字符串数组/);
  expectError({ version: 1, choices: [validEntry({ path: null })] }, /path 必须是字符串数组/);
  // 根冲突：path 为 [] 合法
  const r = validateChoicesRecord({ version: 1, choices: [validEntry({ path: [] })] });
  assert.equal(r.status, 'ok');
  assert.equal(r.entries[0].key, '[]');
});

test('存在标记格式错误：exists 非布尔、true 缺 value / 多键、false 带 value / 多键', () => {
  expectError({ version: 1, choices: [validEntry({ base: { exists: 1, value: 1 } })] }, /exists 必须是布尔值/);
  expectError({ version: 1, choices: [validEntry({ base: { exists: true } })] }, /exists 与 value 两个键/);
  expectError(
    { version: 1, choices: [validEntry({ base: { exists: true, value: 1, x: 2 } })] },
    /exists 与 value 两个键/,
  );
  expectError(
    { version: 1, choices: [validEntry({ base: { exists: false, value: null } })] },
    /不得携带 value 键/,
  );
  expectError(
    { version: 1, choices: [validEntry({ theirs: { exists: false, x: 1 } })] },
    /不得携带 value 键/,
  );
  expectError({ version: 1, choices: [validEntry({ mine: null })] }, /必须是/);
  expectError({ version: 1, choices: [validEntry({ mine: 1 })] }, /必须是/);
  // 错误定位到具体条目与具体一侧
  const reason = expectError(
    { version: 1, choices: [validEntry(), validEntry({ theirs: { exists: 'yes' } })] },
    /对方版本值格式错误/,
  );
  assert.match(reason, /第 2 条/);
});

test('非法选边拒绝整份记录', () => {
  expectError({ version: 1, choices: [validEntry({ choice: 'their' })] }, /选边非法/);
  expectError({ version: 1, choices: [validEntry({ choice: null })] }, /选边非法/);
  expectError({ version: 1, choices: [validEntry({ choice: 'MINE' })] }, /选边非法/);
});

test('重复路径拒绝整份记录（即使内容不同）', () => {
  expectError(
    { version: 1, choices: [validEntry(), validEntry({ choice: 'theirs' })] },
    /重复/,
  );
  // 根路径重复同样拒绝
  expectError(
    { version: 1, choices: [validEntry({ path: [] }), validEntry({ path: [], choice: 'theirs' })] },
    /重复/,
  );
});

test('整份拒绝时不得部分应用：第二条非法，第一条也不进入结果', () => {
  const r = validateChoicesRecord({
    version: 1,
    choices: [validEntry(), validEntry({ choice: 'nope' })],
  });
  assert.equal(r.status, 'error');
  assert.equal(r.entries, undefined);
});

/* ---------- planReuse：可复用 / 跳过 ---------- */

function recordEntries(over = {}) {
  const { conflicts } = currentRound(new Map());
  const byPath = new Map(conflicts.map((c) => [c.key, c]));
  const make = (path, choice) => {
    const c = byPath.get(JSON.stringify(path));
    return {
      path: c.path,
      key: c.key,
      base: c.base,
      mine: c.mine,
      theirs: c.theirs,
      choice,
    };
  };
  return Object.assign({
    a: make(['a'], 'mine'),
    o: make(['o'], 'theirs'),
    n: make(['n'], 'theirs'),
    make,
  }, over);
}

test('完全一致：全部进入 reusable，携带路径与选边', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  const plan = planReuse([E.a, E.o, E.n], conflicts, new Map());
  assert.equal(plan.skipped.length, 0);
  assert.deepEqual(plan.reusable.map((r) => [r.key, r.choice]), [
    [JSON.stringify(['a']), 'mine'],
    [JSON.stringify(['o']), 'theirs'],
    [JSON.stringify(['n']), 'theirs'],
  ]);
});

test('路径在当前冲突中不存在（已消失）：跳过并说明，且不影响其他条目', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  const ghost = Object.assign({}, E.a, { path: ['gone'], key: JSON.stringify(['gone']) });
  const plan = planReuse([ghost, E.o], conflicts, new Map());
  assert.equal(plan.reusable.length, 1);
  assert.equal(plan.reusable[0].key, JSON.stringify(['o']));
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /已消失/);
});

test('任一侧值变化即跳过，并指出是哪一侧变化', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  // 基线变化
  const baseChanged = Object.assign({}, E.a, { base: 999 });
  let plan = planReuse([baseChanged], conflicts, new Map());
  assert.equal(plan.reusable.length, 0);
  assert.match(plan.skipped[0].reason, /基线值已变化/);
  // 我的值变化
  plan = planReuse([Object.assign({}, E.a, { mine: 20 })], conflicts, new Map());
  assert.match(plan.skipped[0].reason, /我的版本值已变化/);
  // 对方值变化
  plan = planReuse([Object.assign({}, E.a, { theirs: 30 })], conflicts, new Map());
  assert.match(plan.skipped[0].reason, /对方版本值已变化/);
  // 多侧同时变化时全部列出
  plan = planReuse([Object.assign({}, E.a, { base: 9, theirs: 30 })], conflicts, new Map());
  assert.match(plan.skipped[0].reason, /基线、对方版本值已变化/);
});

test('缺失与 null 不得混同：缺失一侧变为 null（或反之）即内容不一致', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  // /o 对方原本缺失：记录里写成 exists:true,value:null 必须不被复用
  const missingToNull = Object.assign({}, E.o, { theirs: null });
  let plan = planReuse([missingToNull], conflicts, new Map());
  assert.equal(plan.reusable.length, 0);
  assert.match(plan.skipped[0].reason, /对方版本值已变化/);
  // 反向：当前为 null 的位置（/n 我的），记录写成 exists:false 也不得复用
  const nullToMissing = Object.assign({}, E.n, { mine: MISSING });
  plan = planReuse([nullToMissing], conflicts, new Map());
  assert.equal(plan.reusable.length, 0);
  assert.match(plan.skipped[0].reason, /我的版本值已变化/);
});

test('对象比较忽略键序，数组保留顺序', () => {
  // 我的侧把对象改成另一对象、对方侧改成标量：冲突落在整个对象上，
  // 基线 / 我的两个对象槽位的比较必须忽略键序
  const b1 = { o: { x: 1, y: 2 } };
  const m1 = { o: { x: 2, y: 1 } };
  const t1 = { o: 9 };
  const r1 = merge(b1, m1, t1);
  assert.equal(r1.conflicts.length, 1);
  const oc = r1.conflicts[0];
  assert.deepEqual(oc.path, ['o']);

  const entryReordered = {
    path: oc.path, key: oc.key, choice: 'mine',
    base: { y: 2, x: 1 },
    mine: { y: 1, x: 2 },
    theirs: 9,
  };
  assert.equal(planReuse([entryReordered], r1.conflicts, new Map()).reusable.length, 1);

  // 键序不同且某一键值不同：不可以复用
  const changedValue = Object.assign({}, entryReordered, { base: { y: 2, x: 9 } });
  let plan = planReuse([changedValue], r1.conflicts, new Map());
  assert.equal(plan.reusable.length, 0);
  assert.match(plan.skipped[0].reason, /基线值已变化/);

  // 双方对象键序不同但深相等时自动合入、无冲突（侧面验证键序不敏感）
  const r2 = merge({ o: 1 }, { o: { x: 9, y: 8 } }, { o: { y: 8, x: 9 } });
  assert.equal(r2.conflicts.length, 0);

  // 数组冲突：元素顺序不同即内容不一致
  const ra = merge({ arr: [1, 2] }, { arr: [1, 3] }, { arr: [3, 2] });
  assert.equal(ra.conflicts.length, 1);
  const ac = ra.conflicts[0];
  const arrSwapped = {
    path: ac.path, key: ac.key, choice: 'mine',
    base: [1, 2], mine: [1, 3], theirs: [2, 3], // 对方 [2,3] 与当前 [3,2] 不同
  };
  plan = planReuse([arrSwapped], ra.conflicts, new Map());
  assert.equal(plan.reusable.length, 0);
  assert.match(plan.skipped[0].reason, /对方版本值已变化/);

  // 数组同序同值（即使来源字面顺序不同也无所谓，顺序一致即可）：可复用
  const arrSame = Object.assign({}, arrSwapped, { theirs: [3, 2] });
  assert.equal(planReuse([arrSame], ra.conflicts, new Map()).reusable.length, 1);
});

test('当前已手动选择的冲突：跳过且不覆盖（即使记录选边不同）', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  // 用户已在界面上把 /a 手动选为 theirs；记录要求 mine
  const manual = new Map([[E.a.key, 'theirs']]);
  const plan = planReuse([E.a, E.o], conflicts, manual);
  assert.equal(plan.reusable.length, 1);
  assert.equal(plan.reusable[0].key, E.o.key);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /已手动选择/);
  assert.match(plan.skipped[0].reason, /对方版本/);
  // 原选择保持不变
  assert.equal(manual.get(E.a.key), 'theirs');
});

test('applyReuse：一次写入全部可复用条目，不动跳过条目与既有手动选择', () => {
  const { conflicts } = currentRound(new Map());
  const E = recordEntries();
  const manual = new Map([[E.a.key, 'theirs']]);
  const plan = planReuse([E.a, E.o, E.n], conflicts, manual);
  assert.deepEqual(plan.reusable.map((r) => r.key), [E.o.key, E.n.key]);
  applyReuse(manual, plan.reusable);
  assert.equal(manual.get(E.a.key), 'theirs'); // 未被覆盖
  assert.equal(manual.get(E.o.key), 'theirs');
  assert.equal(manual.get(E.n.key), 'theirs');
});

/* ---------- 跨轮端到端：第一轮导出 → 修改输入后重新合并 → 导入复用 ---------- */

test('跨轮复用：相同冲突自动选边；已消失 / 已变化 / 已手选分别跳过', () => {
  // 第一轮：/a /o /n 三个冲突，用户选 /a=mine、/o=mine、/n=theirs
  const round1 = currentRound(new Map());
  const r1res = new Map([
    [JSON.stringify(['a']), 'mine'],
    [JSON.stringify(['o']), 'mine'],
    [JSON.stringify(['n']), 'theirs'],
  ]);
  const text = JSON.stringify(serializeChoices(round1.conflicts, r1res));

  // 第二轮：/a 冲突原样保留；/o 消失（对方也改成 {x:2}，双方一致自动合入）；
  // /n 内容变化（对方把 5 改成 7）；新增 /new 冲突；并手动先选 /new=theirs
  const base2 = { a: 1, o: { x: 1 }, n: 0 };
  const mine2 = { a: 2, o: { x: 2 }, n: null, new: 'm' };
  const theirs2 = { a: 3, o: { x: 2 }, n: 7, new: 't' };
  const round2 = merge(base2, mine2, theirs2, new Map());
  const keys2 = round2.conflicts.map((c) => c.key);
  assert.ok(keys2.includes(JSON.stringify(['a'])));
  assert.ok(!keys2.includes(JSON.stringify(['o']))); // /o 已消失
  assert.ok(keys2.includes(JSON.stringify(['n'])));
  assert.ok(keys2.includes(JSON.stringify(['new'])));

  const parsed = parseChoicesRecord(text);
  assert.equal(parsed.status, 'ok');
  const manual2 = new Map([[JSON.stringify(['new']), 'theirs']]);
  const plan = planReuse(parsed.entries, round2.conflicts, manual2);
  // /a 可复用；/o 已消失跳过；/n 内容变化跳过
  assert.deepEqual(plan.reusable.map((r) => r.key), [JSON.stringify(['a'])]);
  assert.equal(plan.reusable[0].choice, 'mine');
  const skipReasons = plan.skipped.map((s) => s.key);
  assert.deepEqual(skipReasons.sort(), [JSON.stringify(['n']), JSON.stringify(['o'])]);

  // 应用后重新合并：/a 自动按我的选边，既有手动选择不被动
  applyReuse(manual2, plan.reusable);
  const merged = merge(base2, mine2, theirs2, manual2);
  assert.equal(merged.result.a, 2);
  assert.equal(merged.result.new, 't');
  assert.equal(merged.result.n, null); // /n 未被记录覆盖，占位仍为我的侧（未解决）
});

test('resolutions 也支持普通对象（与 MergeLib 调用约定一致）', () => {
  const { conflicts } = currentRound({});
  const E = recordEntries();
  const plan = planReuse([E.a], conflicts, {});
  assert.equal(plan.reusable.length, 1);
  const resolutions = new Map();
  applyReuse(resolutions, plan.reusable);
  assert.equal(resolutions.get(E.a.key), 'mine');
});
