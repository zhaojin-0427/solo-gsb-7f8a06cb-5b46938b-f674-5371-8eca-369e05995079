/*
 * 引用闭包子文档导出（浏览器 / Node.js 通用，无任何依赖）。
 *
 * 从合并结果的顶层键中勾选若干键后，计算「所选键 + 本地 $ref 引用依赖」的
 * 闭包，导出仅含这些键的子文档：
 *  - 递归扫描纳入值中的字符串 $ref（对象属性名为 $ref 且值为字符串）；
 *  - 仅接受 #（指向根，纳入全部顶层键）或 #/...（JSON Pointer，RFC 6901），
 *    按 ~0 / ~1 规则还原并确认目标存在，再纳入目标所属顶层键；
 *  - 反复处理至闭包稳定；循环引用只处理一次；导出键保持原结果顺序；
 *  - 非法转义、缺失目标或外部引用都记入错误列表（含所在路径），
 *    存在任何错误时不产出子文档，避免生成不完整结果。
 *
 * 实现说明（面向超深嵌套）：扫描与解析全程显式栈迭代，不用递归，
 * 数千层对象链也不会撑爆调用栈。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.RefClosureLib = lib;
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

  // ~ 必须先转义为 ~0，再把 / 转义为 ~1
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
    if (ref === '#') return { segments: [] }; // 指向根
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

  /* ---------- 递归扫描纳入值中的字符串 $ref ---------- */

  // 扫描「属性名 -> 值」：属性名为 $ref 且值为字符串时即一个引用，交给 visit；
  // 否则继续向值内下钻。显式栈迭代，超深嵌套不会撑爆调用栈。
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

  /**
   * 计算引用闭包子文档。
   * @param {*} result  合并结果（JSON.parse 后的值）
   * @param {Iterable<string>} selectedKeys  勾选的顶层键（至少一个；不存在的键被忽略）
   * @returns {{status:'ok', keys:Array<string>, doc:Object}
   *          |{status:'not-object'}     根结果不是对象，没有顶层键可勾选
   *          |{status:'empty'}          未勾选任何（存在的）顶层键
   *          |{status:'errors', errors:Array<{pointer:string, ref:string, reason:string}>}}
   *          ok 时 keys 保持 result 的原键序；doc 与 result 共享子树（不克隆）。
   *          errors 时绝不产出 doc，避免生成不完整的子文档。
   */
  function computeRefClosure(result, selectedKeys) {
    if (!isPlainObject(result)) return { status: 'not-object' };
    const selected = [];
    for (const k of selectedKeys || []) {
      if (typeof k === 'string' && has(result, k) && !selected.includes(k)) {
        selected.push(k);
      }
    }
    if (selected.length === 0) return { status: 'empty' };

    const included = new Set(selected);
    const scanned = new Set();   // 循环引用只处理一次
    const queue = selected.slice();
    const errors = [];

    const visit = (ref, pointer) => {
      const parsed = parseRef(ref);
      if (parsed.error) {
        errors.push({ pointer, ref, reason: parsed.error });
        return;
      }
      const segments = parsed.segments;
      if (segments.length === 0) {
        // # 指向根：纳入全部顶层键
        for (const k of Object.keys(result)) {
          if (!included.has(k)) {
            included.add(k);
            queue.push(k);
          }
        }
        return;
      }
      if (!targetExists(result, segments)) {
        errors.push({ pointer, ref, reason: `引用「${ref}」的目标不存在：合并结果中没有该节点` });
        return;
      }
      const top = segments[0];
      if (!included.has(top)) {
        included.add(top);
        queue.push(top);
      }
    };

    // 队列只增不减且每个顶层键只扫描一次，闭包必然收敛
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i];
      if (scanned.has(key)) continue;
      scanned.add(key);
      scanProperty(key, result[key], '/' + escapeSegment(key), visit);
    }

    if (errors.length > 0) return { status: 'errors', errors };

    // 导出键保持原结果顺序
    const keys = Object.keys(result).filter((k) => included.has(k));
    const doc = {};
    for (const k of keys) doc[k] = result[k];
    return { status: 'ok', keys, doc };
  }

  return { computeRefClosure, escapeSegment, isPlainObject };
});
