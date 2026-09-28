'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SchemaLib = require('../lib/schema.js');

// 把“编译 + 校验”合成一步，测试用例更短
async function check(schema, data) {
  const { validate } = await SchemaLib.compileSchema(schema);
  return SchemaLib.validateData(validate, data);
}

test('合法文档通过校验时返回 null', async () => {
  const errors = await check(
    { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    { name: 'demo' },
  );
  assert.equal(errors, null);
});

test('支持文档内 $ref（#/$defs/...）', async () => {
  const schema = {
    $defs: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
    type: 'object',
    properties: { port: { $ref: '#/$defs/port' } },
  };
  assert.equal(await check(schema, { port: 8080 }), null);
  const errors = await check(schema, { port: 'big' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].pointer, '/port');
  assert.equal(errors[0].keyword, 'type');
});

test('文档外（远程）$ref 编译失败，且不尝试请求', async () => {
  await assert.rejects(
    () => SchemaLib.compileSchema({
      type: 'object',
      properties: { a: { $ref: 'https://example.com/remote-schema.json' } },
    }),
    /仅允许文档内引用/,
  );
});

test('Schema 非法关键字产生编译错误（与 JSON 语法错误区分）', async () => {
  await assert.rejects(
    () => SchemaLib.compileSchema({ type: 'not-a-type' }),
    /Schema 编译错误/,
  );
});

test('required 错误定位到缺失的具体字段', async () => {
  const errors = await check(
    { type: 'object', required: ['name', 'version'] },
    {},
  );
  const pointers = errors.map((e) => e.pointer).sort();
  assert.deepEqual(pointers, ['/name', '/version']);
  assert.ok(errors.every((e) => e.keyword === 'required'));
  assert.ok(errors[0].reason.includes('必填'));
});

test('additionalProperties 错误定位到多余的具体字段', async () => {
  const errors = await check(
    { type: 'object', additionalProperties: false, properties: { a: {} } },
    { a: 1, ghost: 2 },
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].pointer, '/ghost');
  assert.equal(errors[0].keyword, 'additionalProperties');
  assert.ok(errors[0].reason.includes('额外字段'));
});

test('JSON Pointer 中的 ~ 与 / 正确转义', async () => {
  const errors = await check(
    {
      type: 'object',
      properties: {
        'a~b/c': { type: 'array', items: { type: 'object', required: ['x'] } },
      },
    },
    { 'a~b/c': [{}] },
  );
  assert.equal(errors.length, 1);
  // /a~0b~1c/0/x：键名本身的 ~ -> ~0、/ -> ~1，再拼上缺失字段 x
  assert.equal(errors[0].pointer, '/a~0b~1c/0/x');
  assert.equal(errors[0].keyword, 'required');
});

test('allErrors：一次性返回全部错误', async () => {
  const errors = await check(
    {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
      additionalProperties: false,
    },
    { a: 1, b: 'x', c: 3 },
  );
  // a 类型错误、b 类型错误、c 额外字段：三条都应给出
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((e) => e.pointer).sort(), ['/a', '/b', '/c']);
});

test('根节点错误的 pointer 为空字符串', async () => {
  const errors = await check({ type: 'array' }, { not: 'array' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].pointer, '');
  assert.equal(errors[0].keyword, 'type');
});
