// 打包入口：只导出 Draft 2020-12 的 Ajv 构造器，供浏览器以全局变量 Ajv2020 使用
module.exports = require('ajv/dist/2020.js').default;
