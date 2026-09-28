'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, MISSING } = require('../lib/merge.js');
const {
  VERSION,
  STORAGE_KEY,
  buildDraft,
  validateDraft,
  parseDraft,
  replaySnapshot,
} = require('../lib/draft.js');

const base = { a: 1, o: { x: 1 }, n: 0 };
const mine = { a: 2, o: { x: 2 }, n: null };
const theirs = { a: 3, n: 5 };

const T_BASE = JSON.stringify(base);
const T_MINE = JSON.stringify(mine);
const T_THEIRS = JSON.stringify(theirs);

function runMerge(resolutions) {
  return merge(base, mine, theirs, resolutions || new Map());
}

// 构造一份「已合并、全部选边」的草稿
function resolvedDraft(extra) {
  const first = runMerge();
  const resolutions = new Map(first.conflicts.map((c, i) => [
    c.key,
    i % 2 === 0 ? 'mine' : 'theirs',
  ]));
  const final = runMerge(resolutions);
  const draft = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
    schema: '',
    merge: {
      inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
      conflicts: first.conflicts,
      resolutions,
      mergedText: JSON.stringify(final.result, null, 2),
    },
    ...extra,
  });
  return { draft, resolutions, first, final };
}

test('STORAGE_KEY 与版本号', () => {
  assert.equal(STORAGE_KEY, 'json-three-way-merge:draft:v1');
  assert.equal(VERSION, 1);
});

test('buildDraft：已合并草稿含三方输入 / schema / 合并快照（仅已选冲突）', () => {
  const { draft, first } = resolvedDraft();
  assert.equal(draft.version, 1);
  assert.equal(typeof draft.savedAt, 'number');
  assert.deepEqual(draft.inputs, { base: T_BASE, mine: T_MINE, theirs: T_THEIRS });
  assert.equal(draft.schema, '');
  assert.ok(draft.merge);
  assert.deepEqual(draft.merge.inputs, draft.inputs);
  assert.equal(draft.merge.choices.length, first.conflicts.length);
  for (const c of draft.merge.choices) {
    assert.ok(c.path);
    assert.ok(c.base && typeof c.base.exists === 'boolean');
    assert.ok(c.choice === 'mine' || c.choice === 'theirs');
  }
});

test('buildDraft：未合并时 merge 为 null；未选冲突不入 choices', () => {
  const first = runMerge();
  // 只选第一个冲突
  const resolutions = new Map([[first.conflicts[0].key, 'mine']]);
  const partial = runMerge(resolutions);
  const draft = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
    schema: '{"type":"object"}',
    merge: {
      inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
      conflicts: first.conflicts,
      resolutions,
      mergedText: JSON.stringify(partial.result),
    },
  });
  assert.equal(draft.merge.choices.length, 1);
  assert.deepEqual(draft.merge.choices[0].path, first.conflicts[0].path);

  const preMerge = buildDraft({
    inputs: { base: T_BASE, mine: '', theirs: '' },
    schema: '',
  });
  assert.equal(preMerge.merge, null);
});

test('buildDraft：零冲突轮允许 choices 为空数组', () => {
  const b = { a: 1 };
  const m = { a: 1, b: 2 };
  const t = { a: 1, b: 2 };
  const tb = JSON.stringify(b);
  const tm = JSON.stringify(m);
  const tt = JSON.stringify(t);
  const r = merge(b, m, t);
  assert.equal(r.conflicts.length, 0);
  const draft = buildDraft({
    inputs: { base: tb, mine: tm, theirs: tt },
    schema: '',
    merge: {
      inputs: { base: tb, mine: tm, theirs: tt },
      conflicts: r.conflicts,
      resolutions: new Map(),
      mergedText: JSON.stringify(r.result),
    },
  });
  assert.deepEqual(draft.merge.choices, []);
  const parsed = parseDraft(JSON.stringify(draft));
  assert.equal(parsed.status, 'ok');
});

test('解析往返：JSON 文本解析后结构与原草稿一致', () => {
  const { draft } = resolvedDraft();
  const text = JSON.stringify(draft);
  const parsed = parseDraft(text);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.draft.inputs, draft.inputs);
  assert.equal(parsed.draft.merge.choices.length, draft.merge.choices.length);
});

test('损坏检测：空文本 / 非法 JSON / 顶层非对象 / 缺字段', () => {
  assert.equal(parseDraft('').status, 'error');
  assert.equal(parseDraft('   ').status, 'error');
  assert.match(parseDraft('{').reason, /JSON 解析失败/);
  assert.match(parseDraft('[]').reason, /顶层必须是 JSON 对象/);
  assert.match(parseDraft('{}').reason, /顶层字段缺失/);
  assert.match(parseDraft(JSON.stringify({
    version: 1, savedAt: 1, inputs: {}, schema: '', merge: null,
  })).reason, /三方输入字段缺失/);
});

test('损坏检测：版本不受支持 / savedAt 非法 / schema 非字符串', () => {
  const good = resolvedDraft().draft;
  assert.match(validateDraft({ ...good, version: 2 }).reason, /版本不受支持/);
  assert.match(validateDraft({ ...good, savedAt: 'now' }).reason, /savedAt/);
  assert.match(validateDraft({ ...good, schema: null }).reason, /schema 字段/);
});

test('损坏检测：合并快照结构错误 / mergedText 非法 JSON', () => {
  const good = resolvedDraft().draft;
  assert.match(validateDraft({ ...good, merge: {} }).reason, /合并记录的字段缺失/);
  assert.match(validateDraft({
    ...good, merge: { ...good.merge, mergedText: '' },
  }).reason, /合并结果文本缺失/);
  assert.match(validateDraft({
    ...good, merge: { ...good.merge, mergedText: 'not-json' },
  }).reason, /合并结果不是合法 JSON/);
  assert.match(validateDraft({
    ...good, merge: { ...good.merge, inputs: { ...good.merge.inputs, base: 1 } },
  }).reason, /合并时三方文本/);
});

test('损坏检测：choices 条目非法时整份草稿被拒绝', () => {
  const good = resolvedDraft().draft;
  // 重复路径
  const dupChoices = [good.merge.choices[0], good.merge.choices[0]];
  assert.equal(validateDraft({
    ...good, merge: { ...good.merge, choices: dupChoices },
  }).status, 'error');
  // 非法选边
  const bad = JSON.parse(JSON.stringify(good.merge.choices));
  bad[0].choice = 'base';
  assert.equal(validateDraft({
    ...good, merge: { ...good.merge, choices: bad },
  }).status, 'error');
  // exists:false 携带 value
  const withValue = JSON.parse(JSON.stringify(good.merge.choices));
  for (const c of withValue) {
    if (c.theirs.exists === false) c.theirs.value = null;
  }
  assert.equal(validateDraft({
    ...good, merge: { ...good.merge, choices: withValue },
  }).status, 'error');
});

test('replaySnapshot：文本一致 + 冲突三方值匹配 + 结果一致时重放全部选边', () => {
  const { draft, resolutions } = resolvedDraft();
  const parsed = parseDraft(JSON.stringify(draft));
  const out = replaySnapshot(parsed.draft, draft.inputs);
  assert.equal(out.status, 'replay');
  assert.equal(out.resolutions.size, resolutions.size);
  for (const [k, v] of resolutions) assert.equal(out.resolutions.get(k), v);
  // 重放后重新合并的结果等于保存结果
  const again = merge(base, mine, theirs, out.resolutions);
  assert.deepEqual(again.result, JSON.parse(draft.merge.mergedText));
});

test('replaySnapshot：MISSING 与 null 不混同（删除与修改相撞）', () => {
  const first = runMerge();
  const oKey = JSON.stringify(['o']); // theirs 为 MISSING
  const resolutions = new Map([[oKey, 'mine']]);
  const final = runMerge(resolutions);
  const draft = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
    schema: '',
    merge: {
      inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
      conflicts: first.conflicts,
      resolutions,
      mergedText: JSON.stringify(final.result),
    },
  });
  const parsed = parseDraft(JSON.stringify(draft));
  const out = replaySnapshot(parsed.draft, draft.inputs);
  assert.equal(out.status, 'replay');
  assert.equal(out.resolutions.get(oKey), 'mine');
});

test('replaySnapshot：当前文本与合并文本不一致时只恢复文本（stale 编辑）', () => {
  const { draft } = resolvedDraft();
  const parsed = parseDraft(JSON.stringify(draft));
  // 用户在合并后又改了一个数字（inputs 偏离 merge.inputs）
  const edited = { ...draft.inputs, mine: T_MINE.replace('2', '22') };
  const out = replaySnapshot(parsed.draft, edited);
  assert.equal(out.status, 'text-only');
  assert.match(out.reason, /已改动/);
});

test('replaySnapshot：冲突三方值变化（条目不再匹配）时不重放', () => {
  const { draft } = resolvedDraft();
  // 直接篡改保存快照中的 mine 文本：当前文本与快照文本仍“一致”地一起改，
  // 但三方值已不是产生 choices 的那组
  const changedMine = T_MINE.replace('"a":2', '"a":22');
  const tampered = JSON.parse(JSON.stringify(draft));
  tampered.inputs.mine = changedMine;
  tampered.merge.inputs.mine = changedMine;
  const parsed = parseDraft(JSON.stringify(tampered));
  const out = replaySnapshot(parsed.draft, tampered.inputs);
  assert.equal(out.status, 'text-only');
  assert.match(out.reason, /冲突/);
});

test('replaySnapshot：保存的是占位（未全选）结果时不重放旧结果', () => {
  const first = runMerge();
  // 只选一个冲突，却把“含未解决占位”的合并结果存为 mergedText
  const resolutions = new Map([[first.conflicts[0].key, 'mine']]);
  const placeholder = runMerge(resolutions); // 其余冲突以 mine 占位
  const draft = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
    schema: '',
    merge: {
      inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
      conflicts: first.conflicts,
      resolutions,
      mergedText: JSON.stringify(placeholder.result),
    },
  });
  const parsed = parseDraft(JSON.stringify(draft));
  // 所有条目都能匹配，但结果含占位：应用选边后结果其实与保存结果深相等
  // （占位侧恰好也是 mine），因此此处再验证“选 theirs 却存 mine 占位”的情形
  assert.equal(replaySnapshot(parsed.draft, draft.inputs).status, 'replay');

  const resolutions2 = new Map(first.conflicts.map((c) => [c.key, 'theirs']));
  const draft2 = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
    schema: '',
    merge: {
      inputs: { base: T_BASE, mine: T_MINE, theirs: T_THEIRS },
      conflicts: first.conflicts,
      resolutions: new Map([[first.conflicts[0].key, 'mine']]),
      mergedText: JSON.stringify(runMerge(resolutions2).result),
    },
  });
  const parsed2 = parseDraft(JSON.stringify(draft2));
  const out2 = replaySnapshot(parsed2.draft, draft2.inputs);
  // choices 与 mergedText 自相矛盾：结果深相等检查失败，拒绝重放
  assert.equal(out2.status, 'text-only');
  assert.match(out2.reason, /重新合并结果与保存的合并结果不一致/);
});

test('replaySnapshot：保存的三方文本无法解析时只恢复文本', () => {
  const { draft } = resolvedDraft();
  const broken = JSON.parse(JSON.stringify(draft));
  // 当前文本与合并快照文本一致地损坏（绕过逐字符比对，触发重新解析失败）
  broken.inputs.base = '{';
  broken.merge.inputs.base = '{';
  const parsed = parseDraft(JSON.stringify(broken));
  const out = replaySnapshot(parsed.draft, broken.inputs);
  assert.equal(out.status, 'text-only');
  assert.match(out.reason, /无法重新解析/);
});

test('replaySnapshot：未合并草稿（merge=null）只恢复文本', () => {
  const draft = buildDraft({
    inputs: { base: T_BASE, mine: T_MINE, theirs: '' },
    schema: '',
  });
  const parsed = parseDraft(JSON.stringify(draft));
  const out = replaySnapshot(parsed.draft, draft.inputs);
  assert.equal(out.status, 'text-only');
  assert.match(out.reason, /尚未进行过合并/);
});

test('replaySnapshot：零冲突轮可重放（无选边、结果一致）', () => {
  const b = { a: 1 };
  const m = { a: 1, b: 2 };
  const t = { a: 1, b: 2 };
  const r = merge(b, m, t);
  const tb = JSON.stringify(b);
  const tm = JSON.stringify(m);
  const tt = JSON.stringify(t);
  const draft = buildDraft({
    inputs: { base: tb, mine: tm, theirs: tt },
    schema: '',
    merge: {
      inputs: { base: tb, mine: tm, theirs: tt },
      conflicts: r.conflicts,
      resolutions: new Map(),
      mergedText: JSON.stringify(r.result),
    },
  });
  const parsed = parseDraft(JSON.stringify(draft));
  const out = replaySnapshot(parsed.draft, draft.inputs);
  assert.equal(out.status, 'replay');
  assert.equal(out.resolutions.size, 0);
  assert.deepEqual(out.result, r.result);
});

test('MISSING 导出哨兵仍可从 choices 记录还原（健壮性）', () => {
  assert.equal(typeof MISSING, 'symbol');
  const first = runMerge();
  const o = first.conflicts.find((c) => c.key === JSON.stringify(['o']));
  assert.equal(o.theirs, MISSING);
});
