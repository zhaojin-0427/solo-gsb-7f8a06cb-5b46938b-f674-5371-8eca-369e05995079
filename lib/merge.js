/*
 * JSON 三方合并核心逻辑（浏览器 / Node.js 通用，无任何依赖）。
 *
 * 规则：
 *  - 对象逐键递归合并；数组作为整体值比较，不做元素级合并。
 *  - 使用 MISSING 哨兵区分“字段缺失”与 null。
 *  - 单方改动、双方相同改动自动合入。
 *  - 双方不同改动、删除与修改相撞时产生冲突，等待用户按路径选择。
 *
 * 实现说明（面向超深嵌套）：
 *  - 全程使用显式栈迭代，不用递归，数千层对象链也不会撑爆调用栈。
 *  - 先把三方值对齐成一棵“并集骨架”，自底向上一次性算出每个节点的
 *    mine≡theirs / mine≡base / theirs≡base 三个相等标记，再自顶向下合并。
 *    每个子树只比较一次，不会沿对象链每下探一层就重复比较整个剩余子树，
 *    整体复杂度 O(n) 而非 O(n·深度)。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.MergeLib = lib;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 哨兵：表示“该字段不存在”，与 null 严格区分
  const MISSING = Symbol('MergeLib.MISSING');

  // 节点动作：由三个相等标记推出
  const TAKE_MINE = 0;    // 采用我的版本
  const TAKE_THEIRS = 1;  // 采用对方版本
  const DESCEND = 2;      // 双方都是对象：逐键合并
  const CONFLICT = 3;     // 冲突，等待选择

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 深比较；MISSING 只与自身相等，因此 null 与“缺失”永不混淆。
  // 显式栈迭代实现，超深嵌套不会触发 RangeError。
  function deepEqual(a, b) {
    const stack = [[a, b]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      if (x === MISSING || y === MISSING) {
        if (x !== y) return false;
        continue;
      }
      if (x === y) continue;
      if (typeof x !== typeof y) return false;
      if (x === null || y === null) return false;
      const xArr = Array.isArray(x);
      const yArr = Array.isArray(y);
      if (xArr || yArr) {
        if (!xArr || !yArr || x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) stack.push([x[i], y[i]]);
        continue;
      }
      if (typeof x === 'object') {
        const kx = Object.keys(x);
        const ky = Object.keys(y);
        if (kx.length !== ky.length) return false;
        for (const k of kx) {
          if (!has(y, k)) return false;
          stack.push([x[k], y[k]]);
        }
        continue;
      }
      return false;
    }
    return true;
  }

  // 输入均来自 JSON.parse，用 JSON 往返即可安全深拷贝
  function clone(v) {
    if (v === MISSING) return MISSING;
    return JSON.parse(JSON.stringify(v));
  }

  function lookupResolution(resolutions, key) {
    if (!resolutions) return undefined;
    if (resolutions instanceof Map) return resolutions.get(key);
    return resolutions[key];
  }

  /* ---------- 并集骨架：把三方值对齐成一棵树 ---------- */

  // 骨架节点：b/m/t 为该位置三方的值（缺失为 MISSING）；
  // children 为 键 -> 子节点（仅当至少两个成员同为对象或同为数组时存在）；
  // mt/mb/tb 为相等标记，在 computeEqualities 中自底向上算出。
  function makeNode(b, m, t, parent, keyInParent) {
    return {
      b, m, t,
      parent, keyInParent,
      children: null,
      mt: false, mb: false, tb: false,
    };
  }

  // 计算需要展开的子键：对象取键名、数组取下标，其余成员按 MISSING 处理。
  // 只有至少两个成员同为对象（或同为数组）时，才需要子节点来判定相等性。
  function childKeysOf(b, m, t) {
    const bObj = isPlainObject(b);
    const mObj = isPlainObject(m);
    const tObj = isPlainObject(t);
    if ((bObj ? 1 : 0) + (mObj ? 1 : 0) + (tObj ? 1 : 0) >= 2) {
      // 键序保持“基线 -> 我的 -> 对方”，与逐键合并的输出键序一致
      const keys = [];
      const seen = new Set();
      for (const v of [b, m, t]) {
        if (!isPlainObject(v)) continue;
        for (const k of Object.keys(v)) {
          if (!seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
      return { kind: 'object', keys };
    }
    const bArr = Array.isArray(b);
    const mArr = Array.isArray(m);
    const tArr = Array.isArray(t);
    if ((bArr ? 1 : 0) + (mArr ? 1 : 0) + (tArr ? 1 : 0) >= 2) {
      const len = Math.max(
        bArr ? b.length : 0,
        mArr ? m.length : 0,
        tArr ? t.length : 0,
      );
      const keys = [];
      for (let i = 0; i < len; i++) keys.push(i);
      return { kind: 'array', keys };
    }
    return null;
  }

  function childValue(v, key, kind) {
    if (kind === 'object') {
      return isPlainObject(v) && has(v, key) ? v[key] : MISSING;
    }
    return Array.isArray(v) && key < v.length ? v[key] : MISSING;
  }

  // 逐层建骨架；返回按创建顺序（父先于子）排列的全部节点，供自底向上使用
  function buildSkeleton(base, mine, theirs) {
    const root = makeNode(base, mine, theirs, null, undefined);
    const nodes = [root];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const ck = childKeysOf(node.b, node.m, node.t);
      if (!ck) continue;
      const children = new Map();
      for (const k of ck.keys) {
        const child = makeNode(
          childValue(node.b, k, ck.kind),
          childValue(node.m, k, ck.kind),
          childValue(node.t, k, ck.kind),
          node, k,
        );
        children.set(k, child);
        nodes.push(child);
      }
      node.children = children;
    }
    return { root, nodes };
  }

  /* ---------- 相等标记：每个子树只比较一次 ---------- */

  // 利用子节点的相等标记计算本节点的 x≡y（which 为 'mt' | 'mb' | 'tb'）
  function pairEqual(x, y, node, which) {
    if (x === MISSING || y === MISSING) return x === y;
    if (x === y) return true;
    if (typeof x !== typeof y) return false;
    if (x === null || y === null) return false;
    const xArr = Array.isArray(x);
    const yArr = Array.isArray(y);
    if (xArr || yArr) {
      if (!xArr || !yArr || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) {
        if (!node.children.get(i)[which]) return false;
      }
      return true;
    }
    if (typeof x === 'object') {
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      if (kx.length !== ky.length) return false;
      for (const k of kx) {
        // 键数相等时，y 缺键必然体现为对应子节点标记为 false
        if (!node.children.get(k)[which]) return false;
      }
      return true;
    }
    return false;
  }

  // 创建顺序的逆序即“子先于父”，一趟遍历算完全部相等标记
  function computeEqualities(nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      node.mt = pairEqual(node.m, node.t, node, 'mt');
      node.mb = pairEqual(node.m, node.b, node, 'mb');
      node.tb = pairEqual(node.t, node.b, node, 'tb');
    }
  }

  /* ---------- 自顶向下合并 ---------- */

  // 由相等标记推出节点动作；auto 计数只在实际访问到的节点上发生
  function decide(node, stats) {
    // 双方一致（含双方都删除）：直接采用
    if (node.mt) {
      if (!node.mb) stats.auto++;
      return TAKE_MINE;
    }
    // 只有对方改了：采用对方
    if (node.mb) {
      stats.auto++;
      return TAKE_THEIRS;
    }
    // 只有我改了：采用我的
    if (node.tb) {
      stats.auto++;
      return TAKE_MINE;
    }
    // 双方都改了且不同：两侧都是对象则逐键合并
    if (isPlainObject(node.m) && isPlainObject(node.t)) return DESCEND;
    return CONFLICT;
  }

  // 沿父指针还原路径（仅冲突节点需要，数量很少）
  function pathOf(node) {
    const path = [];
    for (let n = node; n.parent !== null; n = n.parent) {
      path.push(n.keyInParent);
    }
    path.reverse();
    return path;
  }

  // 不向下展开的节点：直接采用一侧；冲突时按选择取值或以“我的版本”占位
  function leafValue(node, action, resolutions, conflicts) {
    if (action === TAKE_MINE) return clone(node.m);
    if (action === TAKE_THEIRS) return clone(node.t);
    const path = pathOf(node);
    const key = JSON.stringify(path);
    const choice = lookupResolution(resolutions, key);
    if (choice === 'mine') return clone(node.m);
    if (choice === 'theirs') return clone(node.t);
    conflicts.push({ key, path, base: node.b, mine: node.m, theirs: node.t });
    // 未解决时暂以“我的版本”占位；导出前必须全部解决
    return clone(node.m);
  }

  // 显式栈遍历：仅深入“双方都是对象且三方两两不同”的节点，自底向上拼出结果
  function computeMerge(root, resolutions, conflicts, stats) {
    const rootAction = decide(root, stats);
    if (rootAction !== DESCEND) {
      return leafValue(root, rootAction, resolutions, conflicts);
    }
    const stack = [{
      node: root,
      out: {},
      entries: Array.from(root.children.entries()),
      idx: 0,
      key: undefined,
    }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.idx < frame.entries.length) {
        const entry = frame.entries[frame.idx++];
        const k = entry[0];
        const child = entry[1];
        const action = decide(child, stats);
        if (action === DESCEND) {
          stack.push({
            node: child,
            out: {},
            entries: Array.from(child.children.entries()),
            idx: 0,
            key: k,
          });
        } else {
          const v = leafValue(child, action, resolutions, conflicts);
          if (v !== MISSING) frame.out[k] = v; // 被删除的键不写入结果
        }
      } else {
        stack.pop();
        if (stack.length === 0) return frame.out;
        const parent = stack[stack.length - 1];
        parent.out[frame.key] = frame.out;
      }
    }
    return undefined; // 不可达：根节点为 DESCEND 时循环内必然返回
  }

  /**
   * @param {*} base    基线（JSON.parse 后的值）
   * @param {*} mine    我的版本
   * @param {*} theirs  对方版本
   * @param {Map|Object} [resolutions]  冲突选择：key 为 JSON.stringify(路径数组)，值为 'mine' | 'theirs'
   * @returns {{ result: *, conflicts: Array, stats: { auto: number } }}
   */
  function merge(base, mine, theirs, resolutions) {
    const conflicts = [];
    const stats = { auto: 0 };
    const built = buildSkeleton(base, mine, theirs);
    computeEqualities(built.nodes);
    const result = computeMerge(built.root, resolutions || {}, conflicts, stats);
    return { result, conflicts, stats };
  }

  return { MISSING, merge, deepEqual, isPlainObject };
});
