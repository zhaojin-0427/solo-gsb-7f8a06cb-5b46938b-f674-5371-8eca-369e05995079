/*
 * JSON Patch（RFC 6902）生成与重放（浏览器 / Node.js 通用，无任何依赖）。
 *
 *  - diff(base, target)：生成操作数组，依序作用于 base 后得到 target；
 *    base 与 target 一致时返回空数组。
 *  - 对象逐键生成 add / remove / replace；数组用最长公共子序列（LCS）对齐
 *    完整元素，按执行时的索引生成数量最少的 add / remove，不使用 move / copy。
 *    对齐采用 Hirschberg 线性空间算法，额外内存随两侧长度之和增长，
 *    不再保留按两侧长度乘积分配的矩阵（详见下方“线性空间 LCS”一节）。
 *  - 路径为 JSON Pointer（RFC 6901）：空字符串指根，键名中的 ~ 与 / 分别
 *    转义为 ~0 与 ~1；字段缺失与 null 严格区分（缺失不生成任何操作，
 *    删除 null 字段生成 remove，新增 null 字段生成 add）。
 *  - apply(base, ops)：重放补丁并返回新文档，不改动入参；供本地校验与
 *    在相同基线上重放增量变更。
 *
 * 实现说明（面向超深嵌套）：diff / apply / deepEqual 全程显式栈迭代，
 * 数千层对象链也不会撑爆调用栈；数组对齐的递归深度至多 log2(数组长度)，
 * 同样不受数组规模影响。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.PatchLib = lib;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 输入均来自 JSON.parse，用 JSON 往返即可安全深拷贝
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  // 深比较（迭代实现，超深嵌套不会触发 RangeError）
  function deepEqual(a, b) {
    const stack = [[a, b]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
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

  /* ---------- JSON Pointer（RFC 6901） ---------- */

  function escapeSegment(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function unescapeSegment(seg) {
    // 必须先还原 ~1 再还原 ~0，顺序反了会把 ~01 错解成 /
    return seg.replace(/~1/g, '/').replace(/~0/g, '~');
  }

  function joinPath(path, key) {
    return path + '/' + escapeSegment(key);
  }

  function parsePointer(pointer) {
    if (pointer === '') return []; // 空字符串指根
    if (typeof pointer !== 'string' || pointer.charAt(0) !== '/') {
      throw new Error('非法 JSON Pointer：' + pointer);
    }
    return pointer.slice(1).split('/').map(unescapeSegment);
  }

  /* ---------- diff：生成补丁 ---------- */

  /* ---------- 线性空间 LCS（Hirschberg 算法） ---------- */
  //
  // 目标：只用 O(n + m) 额外内存找出 base 与 target 的一条最长公共子序列
  // （LCS）。旧实现保留 nb×nt 的元素相等表（Uint8，nb·nt 字节）与
  // nb×nt 的 LCS 长度矩阵（Uint32，4·nb·nt 字节），两侧各 9000 个互不
  // 重合的整数时约 405 MB ArrayBuffer；规模再大就可能耗尽浏览器内存。
  //
  // 做法：沿 base 方向二分，用两条滚动行分别从两端做 LCS 动态规划，
  // 取“前向行 + 后向行”之和最大的 target 切分点，再递归对齐左右两段。
  // 每层递归只保留 O(当前段宽) 的行，且同层各段宽度之和不超过两侧长度
  // 之和，因此额外内存 O(n + m)；时间仍为 O(n·m)（每层总面积折半，
  // 全程约 2·nb·nt 次单元格更新）。元素相等一律走完整 deepEqual，
  // 重复元素按序列位置逐一配对，结果仍是一条 LCS，add/remove 数量最少。

  // 元素判等：与 deepEqual 语义一致，但原始值不进入迭代比较，
  // 避免大数组对齐时为每个单元格分配比较栈（输入均来自 JSON.parse）
  function elemEq(x, y) {
    if (x === y) return true;
    if (x === null || y === null) return false;
    const t = typeof x;
    if (t !== typeof y || t !== 'object') return false;
    return deepEqual(x, y);
  }

  // 前向滚动行：写满后 out[j] =
  //   LCS(base[b0 .. b1), target[t0 + 0 .. t0 + j)) 的长度（j = 0..w）。
  // 原地更新：up 为上一行同列值，diag 为更新前的上一行左列值。
  function lcsForwardRow(base, b0, b1, target, t0, w, out) {
    for (let j = 0; j <= w; j++) out[j] = 0;
    for (let i = b0; i < b1; i++) {
      const x = base[i];
      let diag = out[0]; // 上一行的 out[0] 恒为 0
      for (let j = 1; j <= w; j++) {
        const up = out[j];
        if (elemEq(x, target[t0 + j - 1])) {
          out[j] = diag + 1;
        } else if (up >= out[j - 1]) {
          out[j] = up;
        } else {
          out[j] = out[j - 1];
        }
        diag = up;
      }
    }
  }

  // 后向滚动行：写满后 out[j] =
  //   LCS(base[b0 .. b1), target[t0 + j .. t0 + w)) 的长度（j = 0..w）。
  // i 从 b1-1 递减，j 从 w-1 递减原地更新：down 为上一行（i+1）同列值，
  // diag 为更新前的上一行右列值（即 LCS 的右下对角）。
  function lcsBackwardRow(base, b0, b1, target, t0, w, out) {
    for (let j = 0; j <= w; j++) out[j] = 0;
    for (let i = b1 - 1; i >= b0; i--) {
      const x = base[i];
      let diag = out[w]; // 上一行的 out[w] 恒为 0
      for (let j = w - 1; j >= 0; j--) {
        const down = out[j];
        if (elemEq(x, target[t0 + j])) {
          out[j] = diag + 1;
        } else if (down >= out[j + 1]) {
          out[j] = down;
        } else {
          out[j] = out[j + 1];
        }
        diag = down;
      }
    }
  }

  // 递归对齐 base[b0..b1) 与 target[t0..t1)，把 LCS 匹配对的绝对下标
  // 按序追加到 matches。fwd / back 为两条可复用的滚动行缓冲，
  // 容量不小于最长段宽 + 1，全程只分配这两条 O(n + m) 的 ArrayBuffer。
  // 对分沿 base 方向进行，递归深度至多 log2(nb)，无需担心调用栈。
  function alignLcs(base, b0, b1, target, t0, t1, fwd, back, matches) {
    const nb = b1 - b0;
    const w = t1 - t0;
    if (nb === 0 || w === 0) return;
    if (nb === 1) {
      // 基线只剩一个元素：与 target 段中最靠左的相等元素配对
      const x = base[b0];
      for (let j = t0; j < t1; j++) {
        if (elemEq(x, target[j])) {
          matches.push([b0, j]);
          return;
        }
      }
      return;
    }
    const mid = b0 + (nb >> 1);
    lcsForwardRow(base, b0, mid, target, t0, w, fwd);
    lcsBackwardRow(base, mid, b1, target, t0, w, back);
    // cut 使 LCS(base 左半, target[..cut)) + LCS(base 右半, target[cut..))
    // 最大；并列取最左，行为确定、与旧矩阵回溯的产出一致。
    let cut = 0;
    let best = -1;
    for (let j = 0; j <= w; j++) {
      const s = fwd[j] + back[j];
      if (s > best) {
        best = s;
        cut = j;
      }
    }
    alignLcs(base, b0, mid, target, t0, t0 + cut, fwd, back, matches);
    alignLcs(base, mid, b1, target, t0 + cut, t1, fwd, back, matches);
  }

  // 数组差异：先裁去公共前后缀，再对中段做 LCS 对齐。
  // 裁剪不损失操作数最优性（公共前后缀必属于某个 LCS），
  // 追加 / 截尾这类常见编辑因此无需建表。
  function diffArray(base, target, path, ops) {
    const n = base.length;
    const m = target.length;
    let start = 0;
    while (start < n && start < m && deepEqual(base[start], target[start])) start++;
    let endB = n;
    let endT = m;
    while (endB > start && endT > start && deepEqual(base[endB - 1], target[endT - 1])) {
      endB--;
      endT--;
    }
    const nb = endB - start;
    const nt = endT - start;
    if (nb === 0 && nt === 0) return;
    const prefix = path + '/';
    if (nb === 0) {
      // 纯插入：依次在 start, start+1, ... 处 add
      for (let a = 0; a < nt; a++) {
        ops.push({ op: 'add', path: prefix + (start + a), value: clone(target[start + a]) });
      }
      return;
    }
    if (nt === 0) {
      // 纯删除：反复在同一位置 remove，后续元素自动左移
      for (let r = 0; r < nb; r++) {
        ops.push({ op: 'remove', path: prefix + start });
      }
      return;
    }

    // 线性空间 LCS：两条滚动行缓冲（共 2·(nt+1) 个 Uint32）递归复用，
    // 不再分配 nb×nt 的相等表与长度矩阵，额外内存随两侧长度之和增长。
    const fwd = new Uint32Array(nt + 1);
    const back = new Uint32Array(nt + 1);
    const matched = [];
    alignLcs(base, start, endB, target, start, endT, fwd, back, matched);
    // 转回中段内的相对下标，末尾补哨兵收尾
    const matches = matched.map(([mb, mt]) => [mb - start, mt - start]);
    matches.push([nb, nt]);

    // 相邻匹配之间的“空隙”即待删（基线独有）与待增（目标独有）元素；
    // shift 记录此前编辑造成的下标偏移，保证路径是执行时索引。
    // 操作数 = (nb - lcs) + (nt - lcs)，为仅含 add/remove 时的最小值。
    let prevB = 0;
    let prevT = 0;
    let shift = 0;
    for (const [mb, mt] of matches) {
      const removeCount = mb - prevB;
      const addCount = mt - prevT;
      if (removeCount > 0 || addCount > 0) {
        const pos = start + prevB + shift;
        for (let r = 0; r < removeCount; r++) {
          ops.push({ op: 'remove', path: prefix + pos });
        }
        for (let a = 0; a < addCount; a++) {
          ops.push({ op: 'add', path: prefix + (pos + a), value: clone(target[start + prevT + a]) });
        }
        shift += addCount - removeCount;
      }
      prevB = mb + 1;
      prevT = mt + 1;
    }
  }

  /**
   * 生成从 base 到 target 的 RFC 6902 操作数组。
   * @param {*} base   基线（JSON.parse 后的值）
   * @param {*} target 目标（JSON.parse 后的值）
   * @returns {Array<{op: string, path: string, value?: *}>}
   */
  function diff(base, target) {
    const ops = [];
    // 工作项：['diff', b, t, path] 或 ['add', path, value]；
    // 逆序入栈使输出按键序深度优先展开，结果更易读
    const stack = [['diff', base, target, '']];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item[0] === 'add') {
        ops.push({ op: 'add', path: item[1], value: clone(item[2]) });
        continue;
      }
      const b = item[1];
      const t = item[2];
      const path = item[3];
      if (isPlainObject(b) && isPlainObject(t)) {
        // 先移除基线有而目标没有的键（缺失不是 null，不能生成 replace）
        for (const k of Object.keys(b)) {
          if (!has(t, k)) ops.push({ op: 'remove', path: joinPath(path, k) });
        }
        const tKeys = Object.keys(t);
        for (let i = tKeys.length - 1; i >= 0; i--) {
          const k = tKeys[i];
          if (!has(b, k)) {
            stack.push(['add', joinPath(path, k), t[k]]);
          } else {
            stack.push(['diff', b[k], t[k], joinPath(path, k)]);
          }
        }
        continue;
      }
      if (Array.isArray(b) && Array.isArray(t)) {
        diffArray(b, t, path, ops);
        continue;
      }
      if (!deepEqual(b, t)) {
        ops.push({ op: 'replace', path, value: clone(t) });
      }
    }
    return ops;
  }

  /* ---------- apply：重放补丁 ---------- */

  const INDEX_RE = /^(0|[1-9]\d*)$/;

  function arrayIndex(seg, length, allowEnd, pointer) {
    if (!INDEX_RE.test(seg)) {
      throw new Error('非法数组下标 ' + JSON.stringify(seg) + '（' + pointer + '）');
    }
    const idx = Number(seg);
    if (idx > (allowEnd ? length : length - 1)) {
      throw new Error('数组下标越界 ' + JSON.stringify(seg) + '（' + pointer + '）');
    }
    return idx;
  }

  function descend(container, seg, pointer) {
    if (Array.isArray(container)) {
      return container[arrayIndex(seg, container.length, false, pointer)];
    }
    if (isPlainObject(container)) {
      if (!has(container, seg)) throw new Error('路径不存在：' + pointer);
      return container[seg];
    }
    throw new Error('路径穿过标量值：' + pointer);
  }

  // 用 defineProperty 赋值，避免键名为 __proto__ 时改到原型上
  function setOwn(obj, key, value) {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  function applyOne(doc, op) {
    if (!isPlainObject(op) || typeof op.op !== 'string' || typeof op.path !== 'string') {
      throw new Error('非法补丁操作：' + JSON.stringify(op));
    }
    if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') {
      throw new Error('不支持的操作：' + op.op);
    }
    if (op.op !== 'remove' && !has(op, 'value')) {
      throw new Error(op.op + ' 操作缺少 value：' + op.path);
    }
    const segs = parsePointer(op.path);
    if (segs.length === 0) {
      // 根节点：add / replace 直接整体替换
      if (op.op === 'remove') throw new Error('不能移除根节点');
      return clone(op.value);
    }
    let parent = doc;
    for (let i = 0; i < segs.length - 1; i++) {
      parent = descend(parent, segs[i], op.path);
    }
    const key = segs[segs.length - 1];
    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        const idx = key === '-' ? parent.length : arrayIndex(key, parent.length, true, op.path);
        parent.splice(idx, 0, clone(op.value));
      } else {
        const idx = arrayIndex(key, parent.length, false, op.path);
        if (op.op === 'remove') parent.splice(idx, 1);
        else parent[idx] = clone(op.value);
      }
      return doc;
    }
    if (isPlainObject(parent)) {
      if (op.op === 'add') {
        // RFC 6902：目标成员已存在时 add 等价于替换
        setOwn(parent, key, clone(op.value));
      } else {
        // 严格区分缺失与 null：值为 null 的字段视为存在，缺失才报错
        if (!has(parent, key)) {
          throw new Error('要' + (op.op === 'remove' ? '移除' : '替换') + '的字段不存在：' + op.path);
        }
        if (op.op === 'remove') delete parent[key];
        else setOwn(parent, key, clone(op.value));
      }
      return doc;
    }
    throw new Error('路径穿过标量值：' + op.path);
  }

  /**
   * 把补丁依序作用于 base，返回新文档（不改动 base 与 ops）。
   * @param {*} base  基线（JSON.parse 后的值）
   * @param {Array} ops  RFC 6902 操作数组
   * @returns {*} 重放后的文档
   */
  function apply(base, ops) {
    if (!Array.isArray(ops)) throw new Error('补丁必须是操作数组');
    let out = clone(base);
    for (let i = 0; i < ops.length; i++) {
      out = applyOne(out, ops[i]);
    }
    return out;
  }

  return { diff, apply, deepEqual, escapeSegment, unescapeSegment };
});
