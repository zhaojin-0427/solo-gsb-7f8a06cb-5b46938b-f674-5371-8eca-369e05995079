/*
 * 冲突选择记录（浏览器 / Node.js 通用，依赖 lib/merge.js）。
 *
 * 用途：当前轮至少选过一个冲突后，把「仅含已选冲突」的选择记录导出为 JSON；
 * 重新合并后导入同一记录，先预览可复用 / 跳过的条目，再由用户确认一次应用。
 * 记录只包含每个已选冲突的路径、基线 / 我的 / 对方三值（带存在标记）与选边，
 * 不包含任何一份完整输入。
 *
 * 记录格式：
 *   {
 *     "version": 1,
 *     "choices": [
 *       {
 *         "path": ["config", "port"],
 *         "base":   { "exists": true, "value": 3000 },
 *         "mine":   { "exists": true, "value": 8080 },
 *         "theirs": { "exists": true, "value": 9090 },
 *         "choice": "mine"
 *       }
 *     ]
 *   }
 *
 * 严格规则：
 *  - 存在标记 { exists: false } 表示字段缺失（不得带 value 键）；
 *    { exists: true, value: null } 表示值为 null，缺失与 null 绝不混同。
 *  - 整份校验：顶层结构 / 条目结构 / 存在标记格式错误、重复路径、非法选边
 *    （只能是 "mine" | "theirs"）都拒绝整份记录，不应用其中任何一条。
 *
 * 复用规则（planReuse）：
 *  - 仅当路径与基线 / 我的 / 对方三值与当前冲突「完全一致」时才复用：
 *      · 对象比较忽略键序（逐键按名比较）；
 *      · 数组保留顺序，逐下标比较；
 *      · 字段缺失（MISSING 哨兵）与 null 严格区分。
 *  - 已消失（当前合并没有同路径冲突）或内容变化的条目只跳过并给出原因；
 *    当前已被手动选择的冲突同样跳过，绝不覆盖已有选择。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./merge.js'));
  } else {
    root.ChoicesLib = factory(root.MergeLib);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (MergeLib) {
  'use strict';

  const { MISSING, deepEqual, isPlainObject } = MergeLib;

  const VERSION = 1;
  const SIDES = new Set(['mine', 'theirs']);
  const SIDE_LABELS = { mine: '我的版本', theirs: '对方版本' };
  const VALUE_LABELS = ['基线', '我的版本', '对方版本'];
  const ROOT_KEYS = new Set(['version', 'choices']);
  const ENTRY_KEYS = new Set(['path', 'base', 'mine', 'theirs', 'choice']);
  const MARKER_KEYS_TRUE = new Set(['exists', 'value']);
  const MARKER_KEYS_FALSE = new Set(['exists']);

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function lookupResolution(resolutions, key) {
    if (!resolutions) return undefined;
    if (resolutions instanceof Map) return resolutions.get(key);
    return resolutions[key];
  }

  // 自有键集合必须与 keys 完全一致（多键 / 缺键都算格式错误）
  function hasExactKeys(obj, keys) {
    const actual = Object.keys(obj);
    if (actual.length !== keys.size) return false;
    for (const k of actual) {
      if (!keys.has(k)) return false;
    }
    return true;
  }

  function markExistence(v) {
    return v === MISSING ? { exists: false } : { exists: true, value: v };
  }

  /* ---------- 导出：仅含已选冲突 ---------- */

  /**
   * 从全部冲突与当前选择生成可序列化的记录（只包含已选边的冲突）。
   * @param {Array} conflicts  MergeLib.merge 返回的全部冲突
   * @param {Map|Object} resolutions  冲突选择：key -> 'mine' | 'theirs'
   * @returns {{version: number, choices: Array}}
   */
  function serializeChoices(conflicts, resolutions) {
    const choices = [];
    for (const c of conflicts || []) {
      const choice = lookupResolution(resolutions, c.key);
      if (choice !== 'mine' && choice !== 'theirs') continue; // 未选的冲突不入记录
      choices.push({
        path: c.path.slice(),
        base: markExistence(c.base),
        mine: markExistence(c.mine),
        theirs: markExistence(c.theirs),
        choice,
      });
    }
    return { version: VERSION, choices };
  }

  /* ---------- 导入：严格校验整份记录 ---------- */

  // 仿照页面 formatJsonError：把 V8 报错中的 position 换算为行 / 列
  function formatParseError(err, text) {
    const msg = err && err.message ? err.message : String(err);
    let m = msg.match(/position\s+(\d+)/i);
    if (m) {
      const pos = Number(m[1]);
      const upto = text.slice(0, pos);
      const line = upto.split('\n').length;
      const col = pos - upto.lastIndexOf('\n');
      return `${msg}（约第 ${line} 行第 ${col} 列）`;
    }
    m = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (m) return `${msg}（第 ${m[1]} 行第 ${m[2]} 列）`;
    return msg;
  }

  // 校验一个存在标记；通过时返回解码后的值（缺失为 MISSING），否则返回错误说明
  function decodeMarker(marker, label, at) {
    if (!isPlainObject(marker)) {
      return { error: `${at}的${label}值格式错误：必须是 { "exists": ... } 对象` };
    }
    if (!has(marker, 'exists') || typeof marker.exists !== 'boolean') {
      return { error: `${at}的${label}值格式错误：exists 必须是布尔值` };
    }
    if (marker.exists) {
      if (!hasExactKeys(marker, MARKER_KEYS_TRUE)) {
        return { error: `${at}的${label}值格式错误：exists 为 true 时只能含 exists 与 value 两个键` };
      }
      return { value: marker.value };
    }
    if (!hasExactKeys(marker, MARKER_KEYS_FALSE)) {
      return { error: `${at}的${label}值格式错误：exists 为 false（字段缺失）时不得携带 value 键` };
    }
    return { value: MISSING };
  }

  /**
   * 严格校验 JSON.parse 后的记录对象。任何一处格式错误都拒绝整份记录。
   * @param {*} data
   * @param {{allowEmpty?: boolean}} [options]  allowEmpty 时允许 choices 为空数组
   *        （合并草稿重放：本轮零冲突也需要严格校验）
   * @returns {{status:'ok', entries: Array} | {status:'error', reason: string}}
   */
  function validateChoicesRecord(data, options) {
    const fail = (reason) => ({ status: 'error', reason });
    const allowEmpty = !!(options && options.allowEmpty);

    if (!isPlainObject(data)) {
      return fail('记录格式错误：顶层必须是 JSON 对象（含 version 与 choices）');
    }
    if (!hasExactKeys(data, ROOT_KEYS)) {
      return fail('记录格式错误：顶层只能含 version 与 choices 两个键');
    }
    if (data.version !== VERSION) {
      return fail(`记录格式错误：version 必须为 ${VERSION}（当前：${JSON.stringify(data.version)}）`);
    }
    if (!Array.isArray(data.choices)) {
      return fail('记录格式错误：choices 必须是数组');
    }
    if (data.choices.length === 0 && !allowEmpty) {
      return fail('记录格式错误：choices 为空，记录中没有任何冲突选择条目');
    }

    const entries = [];
    const seen = new Map(); // key -> 条目序号（1 基），用于查重
    for (let idx = 0; idx < data.choices.length; idx++) {
      const item = data.choices[idx];
      const at = `记录第 ${idx + 1} 条`;
      if (!isPlainObject(item)) {
        return fail(`${at}格式错误：每条选择必须是 JSON 对象`);
      }
      if (!hasExactKeys(item, ENTRY_KEYS)) {
        return fail(`${at}格式错误：每条只能含 path、base、mine、theirs、choice 五个键`);
      }
      if (!Array.isArray(item.path) || item.path.some((seg) => typeof seg !== 'string')) {
        return fail(`${at}格式错误：path 必须是字符串数组（JSON 键路径）`);
      }

      const decoded = {};
      for (const [label, k] of [['基线', 'base'], ['我的版本', 'mine'], ['对方版本', 'theirs']]) {
        const r = decodeMarker(item[k], label, at);
        if (r.error) return fail(r.error);
        decoded[k] = r.value;
      }

      if (!SIDES.has(item.choice)) {
        return fail(`${at}选边非法：choice 只能是 "mine" 或 "theirs"（当前：${JSON.stringify(item.choice)}）`);
      }

      const key = JSON.stringify(item.path);
      if (seen.has(key)) {
        return fail(`${at}路径 ${key} 与第 ${seen.get(key)} 条重复：每条路径在记录中只能出现一次`);
      }
      seen.set(key, idx + 1);

      entries.push({
        path: item.path.slice(),
        key,
        base: decoded.base,
        mine: decoded.mine,
        theirs: decoded.theirs,
        choice: item.choice,
      });
    }
    return { status: 'ok', entries };
  }

  /**
   * 解析并严格校验记录文本。
   * @param {string} text  记录 JSON 文本
   * @param {{allowEmpty?: boolean}} [options]  allowEmpty 时允许 choices 为空数组
   * @returns {{status:'ok', entries: Array} | {status:'error', reason: string}}
   *          任何格式错误（含 JSON 语法、结构、重复路径、非法选边）都拒绝整份记录
   */
  function parseChoicesRecord(text, options) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'error', reason: '记录为空：请选择由本工具下载的冲突选择记录文件。' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { status: 'error', reason: '记录文件的 JSON 语法错误：' + formatParseError(err, text) };
    }
    return validateChoicesRecord(data, options);
  }

  /* ---------- 复用预览：逐条判定可复用 / 跳过 ---------- */

  /**
   * 按当前合并的冲突清单与已手动选择情况，逐条规划记录条目的复用方式。
   * @param {Array} entries    parseChoicesRecord 成功返回的条目
   * @param {Array} conflicts  当前轮 MergeLib.merge 返回的全部冲突
   * @param {Map|Object} resolutions  当前已手动做出的选择（不会被覆盖）
   * @returns {{reusable: Array<{key,path,choice}>,
   *            skipped: Array<{key,path,choice,reason}>}}
   *          跳过原因：冲突已消失 / 三方值变化（指明哪一侧）/ 已手动选择不覆盖
   */
  function planReuse(entries, conflicts, resolutions) {
    const byKey = new Map();
    for (const c of conflicts || []) byKey.set(c.key, c);

    const reusable = [];
    const skipped = [];
    for (const e of entries || []) {
      const current = byKey.get(e.key);
      if (!current) {
        skipped.push({
          key: e.key, path: e.path, choice: e.choice,
          reason: '当前合并中不存在该路径的冲突（该冲突在本轮已消失）',
        });
        continue;
      }
      // 三值必须完全一致：对象忽略键序（deepEqual 逐键按名比较）、
      // 数组保序逐下标比较、MISSING 与 null 严格区分
      const changed = [];
      if (!deepEqual(e.base, current.base)) changed.push(VALUE_LABELS[0]);
      if (!deepEqual(e.mine, current.mine)) changed.push(VALUE_LABELS[1]);
      if (!deepEqual(e.theirs, current.theirs)) changed.push(VALUE_LABELS[2]);
      if (changed.length > 0) {
        skipped.push({
          key: e.key, path: e.path, choice: e.choice,
          reason: `记录中的三方值与当前冲突不完全一致（${changed.join('、')}值已变化），不予复用`,
        });
        continue;
      }
      const picked = lookupResolution(resolutions, e.key);
      if (picked === 'mine' || picked === 'theirs') {
        skipped.push({
          key: e.key, path: e.path, choice: e.choice,
          reason: `该冲突当前已手动选择为「${SIDE_LABELS[picked]}」，导入不覆盖已有选择`,
        });
        continue;
      }
      reusable.push({ key: e.key, path: e.path, choice: e.choice });
    }
    return { reusable, skipped };
  }

  /**
   * 一次应用预览中全部可复用条目（仅写入 reusable 列出的路径）。
   * @param {Map} resolutions  当前选择映射（原地写入）
   * @param {Array} reusable   planReuse 返回的 reusable
   * @returns {Map} 同一个 resolutions（便于链式调用 / 测试）
   */
  function applyReuse(resolutions, reusable) {
    for (const r of reusable || []) resolutions.set(r.key, r.choice);
    return resolutions;
  }

  return {
    MISSING,
    VERSION,
    serializeChoices,
    parseChoicesRecord,
    validateChoicesRecord,
    planReuse,
    applyReuse,
  };
});
