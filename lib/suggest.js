/*
 * 最少改选建议（浏览器 / Node.js 通用，依赖 lib/merge.js）。
 *
 * 当合并结果未通过 Schema 校验、且全部冲突都已选边时，以当前选边为起点，
 * 只翻转已有冲突的「我的 / 对方」选择，搜索能通过校验的最少改选方案：
 *  - 按翻转个数从少到多枚举；翻转数相同时按冲突列表索引组合的字典序枚举；
 *  - 每个冲突只有两种取值，翻转即 mine <-> theirs，一组翻转索引唯一确定
 *    一个候选状态，故 n 个冲突的搜索空间为 2^n - 1 个候选（不含当前状态）；
 *  - 找到首个通过 validate 的候选立即返回，保证翻转数最少、同数时字典序最小；
 *  - 冲突数超过 MAX_CONFLICTS（10）时不搜索，直接报告超限（不声称无解）；
 *  - 穷尽全部组合仍不通过时报告无解。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./merge.js'));
  } else {
    root.SuggestLib = factory(root.MergeLib);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (MergeLib) {
  'use strict';

  const { merge } = MergeLib;

  // 冲突数上限：2^10 - 1 = 1023 种组合是搜索规模的上界
  const MAX_CONFLICTS = 10;

  function lookupResolution(resolutions, key) {
    if (!resolutions) return undefined;
    if (resolutions instanceof Map) return resolutions.get(key);
    return resolutions[key];
  }

  // 归一化当前选边；调用方应保证冲突已全部选边，缺省按 'mine' 兜底
  function sideOf(resolutions, key) {
    return lookupResolution(resolutions, key) === 'theirs' ? 'theirs' : 'mine';
  }

  function flipSide(side) {
    return side === 'mine' ? 'theirs' : 'mine';
  }

  // 按字典序枚举 [0, n) 的全部 k 元下标组合。
  // 生成器实现：找到解即停，后面的组合不再枚举；每次 yield 同一个内部数组，
  // 消费方须立即读取，不得留存引用。
  function* combinations(n, k) {
    const idx = [];
    for (let i = 0; i < k; i++) idx.push(i);
    for (;;) {
      yield idx;
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i--;
      if (i < 0) return;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }

  /**
   * 搜索最少改选建议。
   * @param {Object} opts
   * @param {*} opts.base            基线（JSON.parse 后的值）
   * @param {*} opts.mine            我的版本
   * @param {*} opts.theirs          对方版本
   * @param {Array} opts.conflicts   全部冲突（MergeLib.merge 不传选择时返回的列表，
   *                                 数组顺序即冲突列表索引）
   * @param {Map|Object} opts.resolutions  当前选边：key -> 'mine' | 'theirs'
   * @param {Function} opts.validate 校验函数（如 Ajv 编译出的 validate），
   *                                 传入合并结果、返回是否通过
   * @param {number} [opts.maxConflicts]   冲突数上限，默认 MAX_CONFLICTS
   * @returns {{status:'found', flips:Array<{index:number, key:string, path:Array,
   *             from:'mine'|'theirs', to:'mine'|'theirs'}>, attempts:number}
   *          |{status:'none', attempts:number}
   *          |{status:'too-many', total:number, max:number}}
   *          attempts 为实际校验过的翻转组合数（不含当前状态本身）
   */
  function suggestMinimalFlips(opts) {
    const { base, mine, theirs, conflicts, resolutions, validate } = opts;
    const max = opts.maxConflicts === undefined ? MAX_CONFLICTS : opts.maxConflicts;
    const n = conflicts.length;
    if (n > max) return { status: 'too-many', total: n, max };

    const current = conflicts.map((c) => sideOf(resolutions, c.key));

    // 翻转 0 处：当前结果本已通过则无需改选
    // （调用方通常只在校验失败后搜索，这里兜底保证返回值完整）
    if (validate(merge(base, mine, theirs, resolutions).result)) {
      return { status: 'found', flips: [], attempts: 0 };
    }

    let attempts = 0;
    const trial = new Map();
    for (let k = 1; k <= n; k++) {
      for (const combo of combinations(n, k)) {
        attempts++;
        trial.clear();
        for (let i = 0; i < n; i++) trial.set(conflicts[i].key, current[i]);
        for (const i of combo) trial.set(conflicts[i].key, flipSide(current[i]));
        const { result } = merge(base, mine, theirs, trial);
        if (validate(result)) {
          return {
            status: 'found',
            flips: combo.map((i) => ({
              index: i,
              key: conflicts[i].key,
              path: conflicts[i].path,
              from: current[i],
              to: flipSide(current[i]),
            })),
            attempts,
          };
        }
      }
    }
    return { status: 'none', attempts };
  }

  return { suggestMinimalFlips, MAX_CONFLICTS };
});
