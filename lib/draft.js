/*
 * 浏览器本地「合并草稿」（浏览器 / Node.js 通用，依赖 merge.js 与 choices.js）。
 *
 * 用途：页面把正在处理的三方输入、可选 Schema、最近一次合并所用的三方文本
 * 及本轮已选冲突存入 localStorage；刷新或重新打开页面时由页面提示恢复或丢弃。
 * 本库只负责：草稿的构造、严格校验、损坏检测与「安全重放」判定；
 * 实际读写 localStorage、渲染提示条与重新合并由 public/app.js 完成。
 *
 * 草稿格式（JSON.stringify 后存于 localStorage 的单个键）：
 *   {
 *     "version": 1,
 *     "savedAt": 1730000000000,
 *     "inputs": { "base": "...", "mine": "...", "theirs": "..." },
 *     "schema": "",
 *     "merge": {
 *       "inputs": { "base": "...", "mine": "...", "theirs": "..." },
 *       "choices": [ ...ChoicesLib v1 记录条目，允许空数组（零冲突轮）... ],
 *       "mergedText": "{ ... 当时合并结果的 JSON 文本 ... }"
 *     }
 *   }
 *
 * 安全重放规则（replaySnapshot）——只有同时满足才重放对应选边：
 *  1. 当前三方文本与保存的「最近一次合并所用三方文本」逐字符一致；
 *  2. 用保存的三方文本重新解析、重新合并，保存条目的路径与基线 / 我的 /
 *     对方三值都能在当前冲突中匹配（复用 ChoicesLib.planReuse）；
 *  3. 应用保存选边后的重新合并结果与保存的 mergedText 深相等。
 * 任一条不满足，调用方只恢复编辑文本，要求用户重新合并；旧结果与旧校验
 * 状态绝不直接放行导出。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./merge.js'), require('./choices.js'));
  } else {
    root.DraftLib = factory(root.MergeLib, root.ChoicesLib);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (MergeLib, ChoicesLib) {
  'use strict';

  const { merge, deepEqual, isPlainObject } = MergeLib;

  const VERSION = 1;
  const STORAGE_KEY = 'json-three-way-merge:draft:v1';

  const FIELD_IDS = ['base', 'mine', 'theirs'];
  const ROOT_KEYS = new Set(['version', 'savedAt', 'inputs', 'schema', 'merge']);
  const INPUTS_KEYS = new Set(FIELD_IDS);
  const MERGE_KEYS = new Set(['inputs', 'choices', 'mergedText']);

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function hasExactKeys(obj, keys) {
    const actual = Object.keys(obj);
    if (actual.length !== keys.size) return false;
    for (const k of actual) {
      if (!keys.has(k)) return false;
    }
    return true;
  }

  function isInputsShape(v) {
    return isPlainObject(v)
      && hasExactKeys(v, INPUTS_KEYS)
      && FIELD_IDS.every((id) => typeof v[id] === 'string');
  }

  /* ---------- 构造 ---------- */

  /**
   * 构造一份草稿对象（纯数据，可 JSON.stringify）。
   * @param {{inputs:{base:string,mine:string,theirs:string}, schema:string,
   *          merge?: {inputs:{...}, resolutions: Map|Object, conflicts: Array,
   *                   mergedText: string}|null, savedAt?: number}} spec
   *        merge 为 null/缺省表示尚未进行过合并（仅保存编辑文本）
   */
  function buildDraft(spec) {
    const inputs = spec && spec.inputs;
    if (!isInputsShape(inputs)) {
      throw new TypeError('buildDraft：inputs 必须是含 base/mine/theirs 三个字符串的对象');
    }
    const schema = typeof spec.schema === 'string' ? spec.schema : '';
    const draft = {
      version: VERSION,
      savedAt: Number.isFinite(spec.savedAt) ? spec.savedAt : Date.now(),
      inputs: {
        base: inputs.base,
        mine: inputs.mine,
        theirs: inputs.theirs,
      },
      schema,
      merge: null,
    };
    const m = spec.merge;
    if (m) {
      if (!isInputsShape(m.inputs)) {
        throw new TypeError('buildDraft：merge.inputs 必须是含 base/mine/theirs 三个字符串的对象');
      }
      if (typeof m.mergedText !== 'string') {
        throw new TypeError('buildDraft：merge.mergedText 必须是字符串');
      }
      // 仅保留本轮已选冲突（未选的不入草稿）；允许零冲突时为空数组
      const record = ChoicesLib.serializeChoices(m.conflicts || [], m.resolutions || new Map());
      draft.merge = {
        inputs: {
          base: m.inputs.base,
          mine: m.inputs.mine,
          theirs: m.inputs.theirs,
        },
        choices: record.choices,
        mergedText: m.mergedText,
      };
    }
    return draft;
  }

  /* ---------- 解析与严格校验 ---------- */

  /**
   * 严格校验 JSON.parse 后的草稿对象。
   * @returns {{status:'ok', draft: object} | {status:'error', reason: string}}
   */
  function validateDraft(data) {
    const fail = (reason) => ({ status: 'error', reason });

    if (!isPlainObject(data)) {
      return fail('草稿已损坏：顶层必须是 JSON 对象');
    }
    if (!hasExactKeys(data, ROOT_KEYS)) {
      return fail('草稿已损坏：顶层字段缺失或含有多余字段');
    }
    if (data.version !== VERSION) {
      return fail(`草稿版本不受支持（version=${JSON.stringify(data.version)}），无法恢复`);
    }
    if (typeof data.savedAt !== 'number' || !Number.isFinite(data.savedAt)) {
      return fail('草稿已损坏：保存时间 savedAt 缺失或非法');
    }
    if (!isInputsShape(data.inputs)) {
      return fail('草稿已损坏：三方输入字段缺失或不是字符串');
    }
    if (typeof data.schema !== 'string') {
      return fail('草稿已损坏：schema 字段缺失或不是字符串');
    }

    if (data.merge !== null) {
      const m = data.merge;
      if (!isPlainObject(m) || !hasExactKeys(m, MERGE_KEYS)) {
        return fail('草稿已损坏：最近一次合并记录的字段缺失或含有多余字段');
      }
      if (!isInputsShape(m.inputs)) {
        return fail('草稿已损坏：合并时三方文本字段缺失或不是字符串');
      }
      if (typeof m.mergedText !== 'string' || m.mergedText.trim() === '') {
        return fail('草稿已损坏：合并结果文本缺失');
      }
      let savedMerged;
      try {
        savedMerged = JSON.parse(m.mergedText);
      } catch (err) {
        return fail('草稿已损坏：保存的合并结果不是合法 JSON（'
          + (err && err.message ? err.message : String(err)) + '）');
      }
      // choices 复用选择记录的严格校验；与下载记录不同，草稿允许空数组（零冲突轮）
      const record = ChoicesLib.validateChoicesRecord(
        { version: ChoicesLib.VERSION, choices: m.choices },
        { allowEmpty: true },
      );
      if (record.status === 'error') {
        return fail(record.reason);
      }
      return {
        status: 'ok',
        draft: { ...data, merge: { ...m, savedMerged, entries: record.entries } },
      };
    }
    return { status: 'ok', draft: data };
  }

  /**
   * 解析并严格校验草稿文本。
   * @param {string} text
   * @returns {{status:'ok', draft: object} | {status:'error', reason: string}}
   */
  function parseDraft(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'error', reason: '草稿为空' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { status: 'error', reason: '草稿 JSON 解析失败：'
        + (err && err.message ? err.message : String(err)) };
    }
    return validateDraft(data);
  }

  /* ---------- 恢复 ---------- */

  // 两组三方文本是否逐字符一致
  function textsEqual(savedInputs, currentInputs) {
    return FIELD_IDS.every((id) => savedInputs[id] === currentInputs[id]);
  }

  /**
   * 评估草稿能否安全重放：重新解析保存的合并文本、重新合并，并比对冲突与结果。
   *
   * @param {object} draft  validateDraft 成功后的草稿
   * @param {{base:string,mine:string,theirs:string}} currentInputs
   *        页面当前三方文本（恢复时等于草稿 inputs，但仍逐字符比对 merge.inputs）
   * @returns {{status:'replay', resolutions: Map, result: *, conflicts: Array, stats: object}
   *          |{status:'text-only', reason: string}}
   *
   * replay：文本一致、冲突路径与三方值全部匹配、结果与保存的合并文本深相等；
   *         resolutions 只含匹配上的选边（其余冲突留待用户选择）。
   * text-only：任一条件不满足——调用方只恢复文本并要求重新合并。
   */
  function replaySnapshot(draft, currentInputs) {
    const textOnly = (reason) => ({ status: 'text-only', reason });
    const m = draft && draft.merge;
    if (!m) return textOnly('草稿只保存了编辑文本，尚未进行过合并');
    if (!isInputsShape(currentInputs)) return textOnly('当前输入不可用');

    // 条件 1：当前三方文本必须与最近一次合并所用文本逐字符一致
    if (!textsEqual(m.inputs, currentInputs)) {
      return textOnly('保存草稿后三方输入已改动，需要重新合并');
    }

    let base;
    let mine;
    let theirs;
    try {
      base = JSON.parse(m.inputs.base);
      mine = JSON.parse(m.inputs.mine);
      theirs = JSON.parse(m.inputs.theirs);
    } catch (err) {
      return textOnly('保存的三方文本无法重新解析（'
        + (err && err.message ? err.message : String(err)) + '）');
    }

    // 先用空选择重新合并，拿到当前冲突清单，再逐条匹配保存的选边
    const first = merge(base, mine, theirs, new Map());
    const plan = ChoicesLib.planReuse(m.entries, first.conflicts, new Map());

    // 条件 2：每个保存条目都必须匹配当前冲突（路径 + 三方值），否则不重放选边
    if (plan.skipped.length > 0) {
      return textOnly('保存的冲突与重新合并得到的冲突不完全一致（'
        + plan.skipped.length + ' 条路径或三方值已变化），需要重新合并');
    }

    const resolutions = ChoicesLib.applyReuse(new Map(), plan.reusable);

    // 条件 3：应用选边后的结果必须与保存的合并文本深相等；
    // 不一致（如旧结果是占位结果）只恢复文本，绝不放行旧结果
    const recomputed = merge(base, mine, theirs, resolutions);
    if (!deepEqual(recomputed.result, m.savedMerged)) {
      return textOnly('重新合并结果与保存的合并结果不一致，需要重新合并');
    }

    return {
      status: 'replay',
      resolutions,
      result: recomputed.result,
      conflicts: recomputed.conflicts,
      stats: recomputed.stats,
    };
  }

  return {
    VERSION,
    STORAGE_KEY,
    buildDraft,
    validateDraft,
    parseDraft,
    replaySnapshot,
    textsEqual,
  };
});
