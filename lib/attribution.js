/*
 * 合并变更归因清单（浏览器 / Node.js 通用，依赖 lib/merge.js）。
 *
 * 冲突全部解决后，按「基线 -> 最终结果」列出发生变化的最小路径：
 *  - 两者（基线值与结果值）都是对象时逐键下钻；数组与类型替换作为整体，
 *    不做元素级展开；对象下钻后不重复列父项。
 *  - 路径为 JSON Pointer（RFC 6901）：空字符串指根，键名中的 ~、/ 分别
 *    转义为 ~0、~1。
 *  - 每条包含操作（add / remove / replace）、基线值、结果值与来源：
 *      mine            仅我改了
 *      theirs          仅对方改了
 *      both            双方同改（相同改动 / 同时删除；含双方各自把同一位置
 *                      改成对象后被按键自动合并的情形）
 *      conflict-mine   该路径（或其祖先）是冲突，最终采用我的版本
 *      conflict-theirs 该路径（或其祖先）是冲突，最终采用对方版本
 *  - 被放弃的改动（冲突未选一侧）不入清单：清单只反映基线 -> 最终结果
 *    的实际变化。
 *  - 字段缺失用 MISSING 哨兵表示，与 null 严格区分；导出时用
 *    { exists: false } 与 { exists: true, value: null } 区分（见 serializeEntries）。
 *
 * 实现说明（面向超深嵌套）：全程显式栈迭代，不用递归，数千层对象链
 * 也不会撑爆调用栈。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./merge.js'));
  } else {
    root.AttributionLib = factory(root.MergeLib);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (MergeLib) {
  'use strict';

  const { MISSING, deepEqual, isPlainObject, merge } = MergeLib;

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* ---------- JSON Pointer（RFC 6901） ---------- */

  // ~ 必须先转义为 ~0，再把 / 转义为 ~1
  function escapeSegment(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function joinPointer(pointer, key) {
    return pointer + '/' + escapeSegment(key);
  }

  function pointerOf(path) {
    let pointer = '';
    for (const seg of path) pointer = joinPointer(pointer, seg);
    return pointer;
  }

  function lookupResolution(resolutions, key) {
    if (!resolutions) return undefined;
    if (resolutions instanceof Map) return resolutions.get(key);
    return resolutions[key];
  }

  // 冲突路径（JSON Pointer）-> 选择（'mine' | 'theirs'）。
  // 未选择的冲突不进入映射；调用方应保证冲突已全部解决后再生成清单。
  function conflictChoiceMap(conflicts, resolutions) {
    const map = new Map();
    for (const c of conflicts || []) {
      const choice = lookupResolution(resolutions, c.key);
      if (choice === 'mine' || choice === 'theirs') {
        map.set(pointerOf(c.path), choice);
      }
    }
    return map;
  }

  // 取 v 的子键值；v 不是对象或没有该键时为 MISSING
  function childOf(v, key) {
    return isPlainObject(v) && has(v, key) ? v[key] : MISSING;
  }

  // 非冲突来源：由三方在该路径上的值推出
  function autoSource(b, m, t) {
    if (deepEqual(m, t)) return 'both';   // 双方同改（含同时删除）
    if (deepEqual(m, b)) return 'theirs'; // 我没动：仅对方改了
    if (deepEqual(t, b)) return 'mine';   // 对方没动：仅我改了
    // 双方都改且不同，但都是对象、被按键自动合并（仅当基线不是对象、
    // 合并结果作为整体列出时才会走到这里）
    return 'both';
  }

  /**
   * 按基线与最终结果计算归因清单。
   * @param {*} base    基线（JSON.parse 后的值）
   * @param {*} mine    我的版本
   * @param {*} theirs  对方版本
   * @param {*} result  最终结果（冲突全部解决后的合并结果）
   * @param {Array} conflicts  全部冲突（MergeLib.merge 不传选择时返回的列表）
   * @param {Map|Object} resolutions  冲突选择：key -> 'mine' | 'theirs'
   * @returns {Array<{pointer: string, op: 'add'|'remove'|'replace',
   *                  base: *, result: *,
   *                  source: 'mine'|'theirs'|'both'|'conflict-mine'|'conflict-theirs'}>}
   *          base / result 中的 MISSING 表示该字段在对应版本中不存在
   */
  function attribute(base, mine, theirs, result, conflicts, resolutions) {
    const choices = conflictChoiceMap(conflicts, resolutions);
    const entries = [];
    // 显式栈迭代：超深嵌套不会撑爆调用栈；子键逆序入栈使输出按键序展开
    const stack = [{ b: base, m: mine, t: theirs, r: result, pointer: '', choice: null }];
    while (stack.length > 0) {
      const f = stack.pop();
      // 冲突路径优先：冲突子树内的所有改动都归因于这次选择
      const choice = choices.get(f.pointer) || f.choice;
      if (isPlainObject(f.b) && isPlainObject(f.r)) {
        // 基线与结果都是对象：逐键下钻（基线键序在前，结果新增键在后）
        const keys = Object.keys(f.b);
        const seen = new Set(keys);
        for (const k of Object.keys(f.r)) {
          if (!seen.has(k)) keys.push(k);
        }
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i];
          stack.push({
            b: childOf(f.b, k),
            m: childOf(f.m, k),
            t: childOf(f.t, k),
            r: childOf(f.r, k),
            pointer: joinPointer(f.pointer, k),
            choice,
          });
        }
        continue;
      }
      // 数组、类型替换、标量：作为整体比较；一致则不产生条目
      if (deepEqual(f.b, f.r)) continue;
      entries.push({
        pointer: f.pointer,
        op: f.b === MISSING ? 'add' : (f.r === MISSING ? 'remove' : 'replace'),
        base: f.b,
        result: f.r,
        source: choice === 'mine' ? 'conflict-mine'
          : choice === 'theirs' ? 'conflict-theirs'
          : autoSource(f.b, f.m, f.t),
      });
    }
    return entries;
  }

  /**
   * 合并并给出归因清单。
   * @returns {{ result: *, conflicts: Array, stats: Object, entries: Array|null }}
   *          仍有未解决冲突时 entries 为 null（此时不应展示清单）
   */
  function attributeMerge(base, mine, theirs, resolutions) {
    const probe = merge(base, mine, theirs);
    const { result, stats } = merge(base, mine, theirs, resolutions);
    const allResolved = probe.conflicts.every(
      (c) => lookupResolution(resolutions, c.key) !== undefined,
    );
    const entries = allResolved
      ? attribute(base, mine, theirs, result, probe.conflicts, resolutions)
      : null;
    return { result, conflicts: probe.conflicts, stats, entries };
  }

  /* ---------- 导出：用存在标记区分字段缺失与 null ---------- */

  function markExistence(v) {
    return v === MISSING ? { exists: false } : { exists: true, value: v };
  }

  /**
   * 把归因条目转换为可安全 JSON 序列化的导出形态：
   * 基线值 / 结果值包一层存在标记——缺失为 { exists: false }（没有 value 键），
   * 值为 null 为 { exists: true, value: null }，两者绝不混淆。
   */
  function serializeEntries(entries) {
    return entries.map((e) => ({
      pointer: e.pointer,
      op: e.op,
      source: e.source,
      base: markExistence(e.base),
      result: markExistence(e.result),
    }));
  }

  return { MISSING, attribute, attributeMerge, serializeEntries, escapeSegment };
});
