/*
 * 合并结果的 JSON Schema 校验（浏览器 / Node.js 通用）。
 *
 *  - 浏览器侧使用预打包的 Ajv 8（Draft 2020-12）全局变量 window.Ajv2020，
 *    见 vendor/ajv2020.js（由 vendor-src/ajv2020-entry.cjs 经 esbuild 打包，
 *    构建脚本见 package.json 的 build:vendor）。
 *  - Node.js（单元测试）侧直接 require('ajv/dist/2020')。
 *
 * 约定：
 *  - 只支持文档内 $ref（形如 #/$defs/...）；loadSchema 一律拒绝，
 *    绝不发起任何远程请求，引用外部 URI 的 Schema 直接报编译错误。
 *  - 区分两类错误：Schema 本身的 JSON 语法错误（JSON.parse 失败）与
 *    Schema 编译错误（Ajv 拒绝编译，如非法关键字、无法解析的 $ref）。
 *  - 校验错误定位使用 JSON Pointer（RFC 6901）：~ 转义为 ~0、/ 转义为 ~1，
 *    required / additionalProperties 定位到具体字段而非其父对象。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('ajv/dist/2020.js').default);
  } else {
    // 浏览器中 Ajv2020 由 vendor/ajv2020.js 提供（IIFE 全局变量）
    root.SchemaLib = factory(root.Ajv2020);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (Ajv2020Ctor) {
  'use strict';

  // loadSchema 永远拒绝：compileAsync 遇到文档外 $ref 时不会发任何网络请求
  function refuseRemote() {
    return Promise.reject(new Error('不支持远程引用：仅允许文档内 $ref（以 # 开头）'));
  }

  /**
   * 编译一份 Draft 2020-12 JSON Schema。
   * @param {*} schema  JSON.parse 后的 Schema 对象
   * @returns {Promise<{ validate: Function }>}  resolve 得到带 validate(data) 的对象
   *          reject 时 Error.message 为面向用户的编译错误说明
   */
  async function compileSchema(schema) {
    const ajv = new Ajv2020Ctor({
      allErrors: true,      // 一次性收集全部错误
      strict: false,        // Schema 中出现额外关键字时只忽略，不阻断编译
      loadSchema: refuseRemote,
    });
    try {
      const validate = await ajv.compileAsync(schema);
      return { validate };
    } catch (err) {
      // 常见来源：Schema 自身不符合 meta-schema、外部/无法解析的 $ref
      throw new Error(formatCompileError(err));
    }
  }

  function formatCompileError(err) {
    const msg = err && err.message ? String(err.message) : String(err);
    // Ajv 的编译错误通常形如 "schema is invalid: data/... must ..." 或
    // "can't resolve reference ..."，保留其定位信息，仅加中文前缀
    if (/can'?t resolve reference/i.test(msg) || /remote|远程/.test(msg)) {
      return 'Schema 编译错误：$ref 无法解析，仅允许文档内引用（以 # 开头），不请求远程引用。原始信息：' + msg;
    }
    return 'Schema 编译错误：' + msg;
  }

  /* ---------- JSON Pointer 转义 ---------- */

  // JSON Pointer（RFC 6901）：~ 必须先转义为 ~0，再把 / 转义为 ~1
  function escapeToken(token) {
    return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  // instancePath + 具体字段名 -> 定位到字段的 Pointer（根级字段形如 /name）
  function fieldPointer(instancePath, fieldName) {
    return (instancePath || '') + '/' + escapeToken(fieldName);
  }

  /* ---------- 校验错误的人类可读原因 ---------- */

  const KEYWORD_REASONS = {
    required: (e) => `缺少必填字段「${e.params.missingProperty}」`,
    additionalProperties: (e) => `不允许出现额外字段「${e.params.additionalProperty}」`,
    type: (e) => `类型应为 ${typeof e.params.type === 'string' ? e.params.type : (e.params.type || []).join(' 或 ')}`,
    enum: () => '值不在允许的枚举范围内',
    const: () => '值必须等于 const 指定的常量',
    minimum: (e) => `不能小于 ${e.params.limit}`,
    maximum: (e) => `不能大于 ${e.params.limit}`,
    exclusiveMinimum: (e) => `必须大于 ${e.params.limit}`,
    exclusiveMaximum: (e) => `必须小于 ${e.params.limit}`,
    multipleOf: (e) => `必须是 ${e.params.multipleOf} 的整数倍`,
    minLength: () => '长度短于最小值',
    maxLength: () => '长度超过最大值',
    pattern: () => '字符串不匹配要求的正则模式',
    format: (e) => `不符合格式「${e.params.format}」`,
    minItems: () => '数组元素数量少于最小值',
    maxItems: () => '数组元素数量超过最大值',
    uniqueItems: () => '数组元素存在重复',
    contains: () => '数组中缺少必须包含的元素',
    minProperties: () => '属性数量少于最小值',
    maxProperties: () => '属性数量超过最大值',
    propertyNames: () => '存在不符合命名规则的属性名',
    dependencies: (e) => `缺少依赖字段「${e.params.missingProperty}」`,
    $ref: () => '不满足引用（$ref）所指向的子 Schema',
  };

  function reasonOf(e) {
    const fn = KEYWORD_REASONS[e.keyword];
    const detail = fn ? fn(e) : '';
    // 拿不到中文解释时退回 Ajv 自带英文 message，保证任何关键字都有原因
    return detail || (e.message ? String(e.message) : `违反关键字 ${e.keyword}`);
  }

  /**
   * 把一次 validate 产生的 errors 规整为统一结构（输入已确认 validate.errors 非空）。
   * @returns {Array<{pointer: string, keyword: string, reason: string}>}
   */
  function formatErrors(errors) {
    return (errors || []).map((e) => {
      let pointer = e.instancePath || '';
      if (e.keyword === 'required' && e.params && e.params.missingProperty !== undefined) {
        pointer = fieldPointer(pointer, e.params.missingProperty);
      } else if (e.keyword === 'additionalProperties' && e.params && e.params.additionalProperty !== undefined) {
        pointer = fieldPointer(pointer, e.params.additionalProperty);
      }
      return { pointer, keyword: e.keyword, reason: reasonOf(e) };
    });
  }

  /**
   * 用已编译的 validate 校验数据，返回全部错误（通过时为 null）。
   */
  function validateData(validate, data) {
    const ok = validate(data);
    if (ok) return null;
    return formatErrors(validate.errors);
  }

  return { compileSchema, validateData, formatErrors, escapeToken };
});
