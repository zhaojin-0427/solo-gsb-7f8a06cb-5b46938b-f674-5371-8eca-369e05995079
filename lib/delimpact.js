/*
 * 删除影响预览（浏览器 / Node.js 通用，无任何依赖）。
 *
 * 冲突全部解决后，用户在合并结果里勾选拟删除的顶层键。本模块扫描整个结果，
 * 建立顶层键之间的本地 $ref 依赖图，列出「直接或间接依赖任一拟删键」的
 * 其他顶层键，并为每个受影响键给出一条最短依赖链：
 *
 *  - 递归扫描顶层属性以及对象、数组内部的字符串 $ref（属性名为 $ref 且值为
 *    字符串），顶层键名为 $ref 时同样视为引用；
 *  - 仅接受 #（指向根，视为依赖全部顶层键）或 #/...（JSON Pointer，RFC 6901
 *    的 ~0 / ~1 解析规则），并确认目标存在；依赖只归到目标所属的顶层键；
 *  - 非法转义、无法识别、缺失目标或外部引用都记入 errors（含所在原路径），
 *    这些引用不产生任何依赖边，即「不计入删除影响」；
 *  - 最短链 = 受影响键到任一拟删键的边数最少的路径；多条等长最短链按原结果
 *    中的顶层键序逐键比较整条链，取字典序最小者；
 *  - 拟删键本身不在受影响列表中；受影响列表保持原结果顶层键序；
 *  - 循环依赖必须收敛：多源 BFS 在有限图上必然结束，回溯最短链时沿距离
 *    严格递减的边行进，不可能绕回已访问节点。
 *
 * 实现说明（面向超深嵌套）：扫描全程显式栈迭代，不用递归，数千层对象链也
 * 不会撑爆调用栈（与 lib/refclosure.js 一致）。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.DelImpactLib = lib;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* ---------- JSON Pointer（RFC 6901） ---------- */

  function escapeSegment(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  // ~ 后只能跟 0 或 1；其余（含末尾孤立的 ~）都是非法转义
  const BAD_ESCAPE_RE = /~(?:[^01]|$)/;

  function unescapeSegment(seg) {
    // 必须先还原 ~1 再还原 ~0，顺序反了会把 ~01 错解成 /
    return seg.replace(/~1/g, '/').replace(/~0/g, '~');
  }

  const ARRAY_INDEX_RE = /^(0|[1-9]\d*)$/;

  /* ---------- $ref 解析与目标确认 ---------- */

  // 把 $ref 字符串解析为指针分段；无法解析时返回带中文说明的 error
  function parseRef(ref) {
    if (ref === '#') return { segments: [] }; // 指向根：依赖全部顶层键
    if (ref.charAt(0) !== '#') {
      return { error: `外部引用「${ref}」：仅支持文档内引用（# 或 #/...），不纳入外部目标` };
    }
    if (ref.charAt(1) !== '/') {
      return { error: `无法识别的引用「${ref}」：仅支持 #（指向根）或 #/...（JSON Pointer）` };
    }
    const segments = [];
    for (const seg of ref.slice(2).split('/')) {
      if (BAD_ESCAPE_RE.test(seg)) {
        return { error: `引用「${ref}」含非法转义「${seg}」：~ 只能写作 ~0，/ 只能写作 ~1` };
      }
      segments.push(unescapeSegment(seg));
    }
    return { segments };
  }

  // 目标是否存在：严格区分「缺失」与 null/0/false 等假值；
  // 数组段标必须是合法下标（0 或不带前导零的数字）且在界内才算存在
  function targetExists(doc, segments) {
    let cur = doc;
    for (const seg of segments) {
      if (isPlainObject(cur)) {
        if (!has(cur, seg)) return false;
        cur = cur[seg];
      } else if (Array.isArray(cur)) {
        if (!ARRAY_INDEX_RE.test(seg)) return false;
        const idx = Number(seg);
        if (idx >= cur.length) return false;
        cur = cur[idx];
      } else {
        return false; // 指针穿过标量
      }
    }
    return true;
  }

  /* ---------- 递归扫描值内的字符串 $ref ---------- */

  // 扫描「属性名 -> 值」：属性名为 $ref 且值为字符串时即一个引用，交给 visit；
  // 否则继续向值内下钻（对象属性与数组元素都扫）。显式栈迭代，超深嵌套不会
  // 撑爆调用栈。键按原顺序入栈（逆序压栈、栈顶弹出），错误因此按文档顺序出现。
  function scanProperty(key, value, pointer, visit) {
    if (key === '$ref' && typeof value === 'string') {
      visit(value, pointer);
      return;
    }
    const stack = [[value, pointer]];
    while (stack.length > 0) {
      const [v, p] = stack.pop();
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) {
          stack.push([v[i], p + '/' + i]);
        }
        continue;
      }
      if (!isPlainObject(v)) continue;
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        const child = v[k];
        const cp = p + '/' + escapeSegment(k);
        if (k === '$ref' && typeof child === 'string') {
          visit(child, cp);
        } else {
          stack.push([child, cp]);
        }
      }
    }
  }

  /* ---------- 顶层键依赖图 ---------- */

  // 扫描整个结果，为每个顶层键收集它「直接依赖」的顶层键集合；
  // 无法解析的引用只记入 errors，不产生边（不计入删除影响）。
  function buildGraph(result, topKeys) {
    const adj = new Map();
    for (const k of topKeys) adj.set(k, new Set());
    const errors = [];

    for (const source of topKeys) {
      const visit = (ref, pointer) => {
        const parsed = parseRef(ref);
        if (parsed.error) {
          errors.push({ pointer, ref, reason: parsed.error });
          return;
        }
        const segments = parsed.segments;
        if (segments.length === 0) {
          // # 指向根：依赖全部顶层键（含自身的自环在距离计算中自然被忽略）
          for (const t of topKeys) adj.get(source).add(t);
          return;
        }
        if (!targetExists(result, segments)) {
          errors.push({ pointer, ref, reason: `引用「${ref}」的目标不存在：合并结果中没有该节点` });
          return;
        }
        adj.get(source).add(segments[0]); // 依赖只归到目标所属顶层键
      };
      scanProperty(source, result[source], '/' + escapeSegment(source), visit);
    }
    return { adj, errors };
  }

  /* ---------- 最短依赖链（多源 BFS + 字典序最小回溯） ---------- */

  // 在反图上从全部拟删键做多源 BFS：dist[k] 即 k 到「最近拟删键」的最短边数，
  // 只有能沿依赖方向到达某拟删键的节点才会拿到距离。循环依赖在有限图上收敛。
  function reverseBfs(adj, topKeys, deletingSet) {
    const rev = new Map();
    for (const k of topKeys) rev.set(k, []);
    for (const a of topKeys) {
      for (const b of adj.get(a)) rev.get(b).push(a);
    }

    const dist = new Map();
    const queue = [];
    for (const d of topKeys) {
      if (deletingSet.has(d)) {
        dist.set(d, 0);
        queue.push(d);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const src of rev.get(cur)) {
        if (!dist.has(src)) {
          dist.set(src, dist.get(cur) + 1);
          queue.push(src);
        }
      }
    }
    return dist;
  }

  // 从受影响键出发，每一步都在「仍能保持最短」的后继里选顶层键序最靠前的键：
  // 等长最短链的首个分叉位置即决定整条链字典序，故贪心逐键最小即得字典序
  // 最小的整条链。距离严格减 1，循环依赖下也不会回头。
  function shortestChain(start, adj, dist, deletingSet, orderIndex) {
    const chain = [start];
    let cur = start;
    while (!deletingSet.has(cur)) {
      let best = null;
      for (const v of adj.get(cur)) {
        if (dist.has(v) && dist.get(v) === dist.get(cur) - 1) {
          if (best === null || orderIndex.get(v) < orderIndex.get(best)) best = v;
        }
      }
      // dist 有限且 cur 非拟删键时，最短路上的下一节点必然存在
      chain.push(best);
      cur = best;
    }
    return chain;
  }

  /**
   * 计算删除影响预览。
   * @param {*} result  合并结果（JSON.parse 后的值）
   * @param {Iterable<string>} deletingKeys  勾选拟删除的顶层键（不存在的键被忽略）
   * @returns {{status:'ok',
   *            deleting:Array<string>,
   *            affected:Array<{key:string, chain:Array<string>}>,
   *            errors:Array<{pointer:string, ref:string, reason:string}>}
   *          |{status:'not-object'}  根结果不是对象，没有顶层键可勾选
   *          |{status:'empty'}       未勾选任何（存在的）顶层键
   *          ok 时 deleting 保持 result 的原键序；affected 同样按原键序排列，
   *          只含非拟删键；chain 为「受影响键 -> … -> 拟删键」的最短依赖链，
   *          多条等长链取按顶层键序比较的字典序最小者；errors 为扫描整个结果
   *          发现的非法 / 缺失 / 外部引用（含所在原路径），它们不产生依赖边。
   */
  function computeDeletionImpact(result, deletingKeys) {
    if (!isPlainObject(result)) return { status: 'not-object' };

    const topKeys = Object.keys(result);
    const deleting = [];
    for (const k of deletingKeys || []) {
      if (typeof k === 'string' && has(result, k) && !deleting.includes(k)) {
        deleting.push(k);
      }
    }
    if (deleting.length === 0) return { status: 'empty' };
    // 删除清单保持原结果键序，而非勾选顺序
    deleting.sort((a, b) => topKeys.indexOf(a) - topKeys.indexOf(b));
    const deletingSet = new Set(deleting);

    const { adj, errors } = buildGraph(result, topKeys);
    const dist = reverseBfs(adj, topKeys, deletingSet);
    const orderIndex = new Map(topKeys.map((k, i) => [k, i]));

    const affected = [];
    for (const k of topKeys) {
      // 拟删键本身（dist 0）与不受影响的键（无有限距离）都不列出
      if (!dist.has(k) || dist.get(k) === 0) continue;
      affected.push({
        key: k,
        chain: shortestChain(k, adj, dist, deletingSet, orderIndex),
      });
    }

    return { status: 'ok', deleting, affected, errors };
  }

  return { computeDeletionImpact, escapeSegment, isPlainObject };
});
