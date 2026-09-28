/*
 * 顶层键改名导出（浏览器 / Node.js 通用，无任何依赖）。
 *
 * 冲突全部解决后，把合并结果的某个顶层键改名为新键名（可为空字符串），
 * 导出改名后的完整 JSON；原合并结果不被修改：
 *  - 新键名与其他已有顶层键重名：status: 'conflict'，不产出文档；
 *    新旧键名相同：status: 'same'，提示无变化；
 *  - 递归扫描对象与数组中的字符串 $ref（属性名为 $ref 且值为字符串，
 *    顶层键名为 $ref 时同样视为引用），仅接受 # 或 #/...：
 *      · 依 JSON Pointer（RFC 6901）解码并确认原目标在合并结果中存在；
 *      · 首段等于旧键名时换为新键名并重新按 ~0 / ~1 转义，
 *        其余片段与单独的 # 都保持原文不动；
 *      · 非法转义、缺失目标或外部引用都记入 errors（含所在原路径），
 *        存在任何错误时不产出文档（status: 'errors'），绝不导出引用
 *        断链的文档——即使非法引用与改名键无关；
 *  - 改名后的键保持原键序位置；doc 为全新对象，与结果共享不可变标量。
 *
 * 实现说明（面向超深嵌套）：扫描、改写与重建全程显式栈迭代，不用递归，
 * 数千层对象链也不会撑爆调用栈（与 lib/refclosure.js 一致）。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = lib;
  } else {
    root.KeyRenameLib = lib;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 写入自有属性：__proto__ 走普通赋值会改到原型上（键会丢失），
  // 必须用 defineProperty 定义，保证任意新键名都能原样进文档
  function setKey(obj, key, value) {
    if (key === '__proto__') {
      Object.defineProperty(obj, key, {
        value, writable: true, enumerable: true, configurable: true,
      });
    } else {
      obj[key] = value;
    }
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
      return { error: `外部引用「${ref}」：仅支持文档内引用（# 或 #/...），改名导出不接受外部引用` };
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

  /**
   * 计算顶层键改名后的完整文档。
   * @param {*} result  合并结果（JSON.parse 后的值）
   * @param {string} oldKey  要改名的顶层键
   * @param {string} newKey  新键名（可为空字符串）
   * @returns {{status:'ok', doc:Object, refs:Array<{pointer:string, from:string, to:string}>}
   *          |{status:'not-object'}            根结果不是对象，没有顶层键可改名
   *          |{status:'no-key'}                oldKey 不是 result 的顶层键
   *          |{status:'same'}                  新旧键名相同，无变化
   *          |{status:'conflict', key:string}  新键名与其他已有顶层键重名
   *          |{status:'errors', errors:Array<{pointer:string, ref:string, reason:string}>}}
   *          ok 时 doc 为全新对象（原结果不被修改），改名键保持原键序位置；
   *          refs 为被改写的 $ref 列表，pointer 为原文档中的路径。
   *          errors 时绝不产出 doc，避免导出引用断链的文档。
   */
  function renameTopKey(result, oldKey, newKey) {
    if (!isPlainObject(result)) return { status: 'not-object' };
    if (typeof oldKey !== 'string' || !has(result, oldKey)) return { status: 'no-key' };
    if (typeof newKey !== 'string') newKey = newKey == null ? '' : String(newKey);
    if (newKey === oldKey) return { status: 'same' };
    if (has(result, newKey)) return { status: 'conflict', key: newKey };

    const errors = [];
    const refs = [];
    const escapedNew = escapeSegment(newKey);

    // 处理一个字符串 $ref：返回应写入新文档的字符串；
    // 无法解析或目标缺失时记入 errors 并返回原文（文档最终会被丢弃）
    const rewriteRef = (ref, pointer) => {
      const parsed = parseRef(ref);
      if (parsed.error) {
        errors.push({ pointer, ref, reason: parsed.error });
        return ref;
      }
      const segments = parsed.segments;
      if (segments.length === 0) return ref; // 单独的 # 保持原义
      if (!targetExists(result, segments)) {
        errors.push({ pointer, ref, reason: `引用「${ref}」的目标不存在：合并结果中没有该节点` });
        return ref;
      }
      if (segments[0] !== oldKey) return ref; // 首段不是旧键名：整条保持原文
      // 首段换成新键名（重新按 ~0 / ~1 转义），其余片段保持原文
      const rest = ref.slice(2).split('/').slice(1);
      let to = '#/' + escapedNew;
      for (const seg of rest) to += '/' + seg;
      refs.push({ pointer, from: ref, to });
      return to;
    };

    // 显式栈迭代：边扫描边重建。任务项 [key, value, parent, slot, pointer]：
    // key/value 为原属性名与值（数组元素 key 为 null）；parent/slot 指明克隆
    // 结果写回新容器的位置（slot 为数组下标或对象键）；pointer 为原文档中的
    // 路径（错误报告用，始终按旧键名计算）。
    const doc = {};
    const tasks = [];
    const topKeys = Object.keys(result);
    for (let i = topKeys.length - 1; i >= 0; i--) {
      const k = topKeys[i];
      tasks.push([k, result[k], doc, k === oldKey ? newKey : k, '/' + escapeSegment(k)]);
    }
    while (tasks.length > 0) {
      const [key, value, parent, slot, pointer] = tasks.pop();
      if (key === '$ref' && typeof value === 'string') {
        setKey(parent, slot, rewriteRef(value, pointer));
        continue;
      }
      if (Array.isArray(value)) {
        const copy = new Array(value.length);
        assign(parent, slot, copy);
        for (let i = value.length - 1; i >= 0; i--) {
          tasks.push([null, value[i], copy, i, pointer + '/' + i]);
        }
        continue;
      }
      if (isPlainObject(value)) {
        const copy = {};
        assign(parent, slot, copy);
        const keys = Object.keys(value);
        for (let i = keys.length - 1; i >= 0; i--) {
          const ck = keys[i];
          tasks.push([ck, value[ck], copy, ck, pointer + '/' + escapeSegment(ck)]);
        }
        continue;
      }
      assign(parent, slot, value); // 标量不可变，直接复用
    }

    if (errors.length > 0) return { status: 'errors', errors };
    return { status: 'ok', doc, refs };
  }

  // 数组下标走普通赋值，对象键走 setKey（防 __proto__ 键丢失）
  function assign(parent, slot, value) {
    if (typeof slot === 'number') parent[slot] = value;
    else setKey(parent, slot, value);
  }

  return { renameTopKey, escapeSegment, isPlainObject };
});
