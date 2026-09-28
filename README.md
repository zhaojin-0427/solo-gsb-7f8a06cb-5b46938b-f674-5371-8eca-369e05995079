# JSON 三方合并工具

基于 **Node.js + 原生 HTML/JavaScript** 的 JSON 三方合并网页。粘贴基线（Base）、我的版本（Mine）、对方版本（Theirs）后自动合并，冲突按路径逐项选择解决，全部解决后方可导出，并生成标注每处改动来源的**变更归因清单**。合并计算全部在浏览器内完成，无需任何外部服务；可选使用随项目安装的 **Ajv 8（Draft 2020-12）** 在本地对合并结果做 JSON Schema 校验。

## 功能

- 三栏输入：基线 / 我的版本 / 对方版本，一键合并（支持 `Ctrl/Cmd + Enter`）
- **对象逐键递归合并**；**数组作为整体值**参与比较，不做元素级合并
- 使用哨兵值**严格区分「字段缺失」与 `null`**（删除 null 字段、新增 null 字段都算改动）
- 单方改动、双方相同改动**自动合入**
- 双方不同改动、**删除与修改相撞**时产生冲突：按路径展示基线 / 我的 / 对方三方值（缺失明确标注），逐项选择「采用我的版本」或「采用对方版本」
- 每次选择即时更新合并结果与进度；**存在未解决冲突时禁止导出**
- 导出为 `merged.json` 或复制到剪贴板
- **合并变更归因清单**：冲突全部解决后，按「基线 → 最终结果」列出每处改动的最小路径（对象逐键下钻，数组与类型替换作为整体），标注新增 / 删除 / 替换、基线值、结果值与来源（仅我 / 仅对方 / 双方同改 / 冲突选我 / 冲突选对方）；支持按来源筛选与下载 JSON 清单；改选冲突即时更新，三方输入一旦修改旧清单立即清空
- **导出 JSON Patch（RFC 6902）**：从本轮基线与合并结果生成增量操作数组，可在相同基线上重放；输入被修改后补丁导出自动禁用，重新合并后恢复
- **引用闭包子文档导出**：冲突全部解决且三方输入未改动时，从合并结果的顶层键中勾选至少一个，自动递归纳入值内字符串 `$ref` 的本地引用依赖（仅 `#` 或 `#/...`，按 RFC 6901 `~0`/`~1` 解析并确认目标存在；`#` 指根即纳入全部顶层键，循环引用只处理一次），下载仅含这些键的 `subdoc.json`；导出键保持原结果顺序，非法转义 / 缺失目标 / 外部引用会逐条列出所在路径并禁用下载，绝不生成不完整子文档
- **删除影响预览**：冲突全部解决且三方输入未改动时，勾选合并结果中拟删除的顶层键，页面即时列出因本地 `$ref` 直接或间接依赖这些键而受影响的其他顶层键，并为每个受影响键给出一条最短的「受影响键 → … → 拟删键」依赖链；多条等长最短链按原结果中的顶层键序逐键比较整条链、取字典序最小者。扫描顶层属性以及对象、数组内部的字符串 `$ref`，沿用 `#` 与 `#/...` 的 JSON Pointer（RFC 6901）解析规则，`#`（指向根）视为依赖全部顶层键；循环依赖在有限图上多源 BFS 必然收敛、回溯最短链时沿距离严格递减的边行进不会绕环。非法转义 / 无法识别 / 缺失目标 / 外部引用单独提示所在原路径且**不计入删除影响**；根结果不是对象（数组 / 标量）时提示无法预览；勾选或改选冲突后即时重算，三方输入一旦编辑立即清空预览，重新合并后恢复
- **顶层键改名导出**：冲突全部解决且三方输入未改动时，任选一个合并结果顶层键并填写新键名（**可为空字符串**），即可预览并下载改名后的完整 JSON（`renamed.json`），**原合并结果不变**；新键名与其他已有顶层键重名时报错并禁止下载，与原键名相同则提示无变化。扫描对象与数组中的字符串 `$ref`（仅接受 `#` 或 `#/...`）：依 JSON Pointer（RFC 6901）解码并确认原目标存在，首段等于旧键名时换为新键名并重新按 `~0` / `~1` 转义，其余片段与单独的 `#` 保持原文；非法转义、缺失目标或外部引用逐条标出所在原路径并禁止下载。改选冲突或修改键名即时重算；三方输入一旦编辑立即清空并禁用，重新合并后恢复
- JSON 无效时**指出是哪个输入**并给出错误位置（行/列），对应输入框高亮
- **可选 JSON Schema 校验（Draft 2020-12，Ajv 8）**：
  - Schema 在浏览器本地编译，**只支持文档内 `$ref`（以 `#` 开头），不请求任何远程引用**
  - 分别提示 **Schema 的 JSON 语法错误**与**编译错误**（非法关键字、无法解析的 `$ref` 等）
  - 冲突未全部解决时只显示「待校验」，**绝不校验占位结果**；全部解决后自动校验，通过时显示绿色通过状态
  - 校验失败时列出**全部错误**的实例 **JSON Pointer**、**关键字**与**中文原因**；`required`、`additionalProperties` 定位到具体字段；路径中的 `~`、`/` 按 RFC 6901 转义为 `~0`、`~1`
  - 改选冲突或编辑 Schema 后自动重新校验；三方输入一旦改动，旧结论立即失效，重新合并后才恢复
  - **有 Schema 时只有校验通过才允许**导出完整 JSON、复制结果、导出补丁；Schema 留空时沿用原有规则
- **最少改选建议**：校验失败且冲突已全部选边时，可一键搜索「最少改选方案」——以当前选边为起点，只翻转已有冲突的「我的 / 对方」选择，按翻转个数从少到多（同数按冲突列表索引组合的字典序）枚举，用现有合并与 Ajv 校验找到首个通过的结果；列出需改选的冲突路径与新旧选边，确认后一次应用全部建议并自动刷新合并结果、归因清单与导出门禁；穷尽全部组合仍失败时明确提示无解，冲突超过 10 个时只提示超限；改选冲突、修改三方输入或 Schema 都会立即清除旧建议
- **冲突选择记录（跨轮复用）**：当前轮至少选过一个冲突后，可下载仅含**已选冲突**的记录 `choices.json`——每项保存冲突路径、基线 / 我的 / 对方三值（带存在标记）与选边，**不含完整输入**。重新合并后导入记录，先预览「可复用 / 跳过」条目及跳过原因，再由用户**确认一次应用**：仅当路径与三值和当前冲突完全一致（对象忽略键序、数组保留顺序、缺失与 `null` 不混同）才复用；冲突已消失或内容变化只跳过并说明原因，**绝不覆盖当前已手动选择的冲突**；格式错误、重复路径或非法选边**拒绝整份记录**。应用后同步刷新合并结果、Schema 校验、归因清单与导出门禁；三方输入一旦编辑立即清空导入预览
- **浏览器本地合并草稿（刷新 / 重开可恢复）**：编辑三方输入或可选 Schema、每次选边（含一次应用选择记录与最少改选建议）后都**自动保存**到当前浏览器的 `localStorage`（单键 `json-three-way-merge:draft:v1`，不发送到任何服务器）；草稿含三方输入、可选 Schema、**最近一次合并所用的三方文本**与**本轮已选冲突**。刷新或重新打开页面时弹出「恢复草稿 / 丢弃草稿」提示：恢复后**重新解析并重新合并**，只有当前三方文本与保存的合并文本**逐字符一致**、且冲突路径与基线 / 我的 / 对方三值均匹配，才重放对应选边；保存后输入已改动、冲突已变化或保存结果对不上时**只恢复编辑文本**并要求重新合并——旧结果与旧 Schema 校验结论**绝不直接放行导出**。点「清空」或在提示中点「丢弃」都会删除草稿；草稿损坏（JSON 截断 / 字段缺失 / 版本不受支持等）会说明原因并可一键删除，浏览器拒绝存储（隐私模式 / 配额已满）也只提示原因，**正常合并始终可用**
- **浏览器断网续用（Service Worker 版本化缓存）**：首次在 http://localhost:8080 在线打开后，Service Worker 会把页面、样式、**全部业务脚本与本地打包的 Ajv** 作为**一整套**静态资源预缓存；**只有整套资源全部下载 / 写入成功**，页头才提示「**可离线使用**」，任一资源失败都会说明具体原因（哪个资源、什么错误），首次失败即**不可离线**、更新失败则**继续使用旧版**。此后停止容器、断网或重启电脑，再打开同一地址仍可完成三方合并、Schema 校验、草稿恢复与各类导出（导出是浏览器本地生成文件，无需网络）。静态资源按版本号整体缓存：**新版未整套下载成功时继续使用旧版**；已打开的页面在重载前始终保持同一版本，**绝不混用新旧脚本**，重载（或关闭后重新打开）后才切到新版。缓存中**只有静态资源**，合并草稿仍只保存在浏览器 `localStorage`，换浏览器 / 清除站点数据不会带走

## 离线续用（断网 / 停容器后继续使用）

所有计算（合并、Ajv 校验、各类导出、草稿）都在浏览器本地完成，页面只依赖本站的静态资源。首次在线准备完成后，这些静态资源由 Service Worker（`public/sw.js`）整体缓存，断网或停止容器后重开页面仍可使用全部功能。

### 1. 首次准备（需要联网并保持容器运行）

1. `docker compose up --build`（或 `node server.js`）后，在浏览器打开 **http://localhost:8080**。
2. 页头出现蓝色「正在准备离线资源…」徽标：Service Worker 正在把页面、样式、全部业务脚本（`/lib/*.js`、`/app.js`、`/offline.js`）与本地 Ajv 包（`/vendor/ajv2020.js`）作为一整套预缓存。
3. **整套资源全部成功后**，徽标变绿并显示「**可离线使用**」——此后即可离线。
   - 若任一资源下载 / 写入失败，徽标变红并说明**具体原因**（如「资源 /vendor/ajv2020.js 下载失败（HTTP 500）」），此时还不能离线；旧版仍在时会注明「已继续使用旧版」。修复网络后点徽标上的「**重试准备**」即可重新下载整套资源。
4. Service Worker 仅在安全上下文可用：`http://localhost`（含 `127.0.0.1`）与 `https://` 均可；通过非 localhost 的纯 HTTP 访问时页头会说明不支持离线缓存，在线使用与本地草稿不受影响。

### 2. 离线重开（停止容器 / 断网后）

1. 保持使用**首次准备时的同一浏览器与同一地址**（http://localhost:8080）；缓存与草稿都按浏览器 + 源（origin）隔离。
2. 直接停止容器（`docker compose down` 或停止进程）、断开网络后，在浏览器地址栏重新打开 **http://localhost:8080**（不要用「清除浏览器数据」，也不要换端口 / 域名，否则属于另一个源）。
3. 页面从本地缓存完整加载，三方合并、Schema 校验（Ajv 在本地，不请求任何远程引用）、草稿恢复、merged / patch / attribution / subdoc / renamed / choices 各类导出全部可用；徽标显示「可离线使用（当前已断网）」。
4. 此前保存的合并草稿仍在该浏览器的 `localStorage` 中，重开后照常弹出「恢复草稿 / 丢弃草稿」。**Service Worker 缓存里只有静态资源，不含任何草稿或输入内容**；清除站点数据会同时清掉两者。

> 注意：首次准备**必须在线完成**；从未成功打开过页面的浏览器在断网时无法加载（本地没有任何缓存）。

### 3. 恢复联网后的更新步骤

静态资源采用**版本化整包缓存**，更新规则如下：

1. 升级镜像或修改静态资源后，保持联网重新打开 / 刷新 http://localhost:8080。浏览器按服务器对 `/sw.js` 的 `Cache-Control: no-cache` 回源做**字节检查**，发现新版本的 Service Worker。
2. 新版 SW 在后台**重新下载整套资源**：
   - **整套下载成功**：页头出现蓝色「**新版静态资源已整套缓存完成**」提示；此时**当前已打开的页面仍继续使用旧版**（新旧脚本不会混用），点「**立即重载**」或手动刷新（也可关闭标签页后重新打开）即切到新版。
   - **任一资源下载失败**：新版半套缓存会被整体丢弃，**继续使用旧版**，页头说明失败原因并提供「重试准备」；旧版页面与旧版离线能力不受影响。
3. 维护者发布新静态资源时，需要把 `public/sw.js` 顶部的 `CACHE_VERSION` 加 1，并确保 `PRECACHE_URLS` 与 `public/index.html` 中引用的脚本 / 样式一致（`test/offline.test.js` 会自动核对清单覆盖、文件存在且服务器可 200 获取）。旧版本缓存会在新版页面第一次加载后自动清理，磁盘上只保留一整套。
4. 若需彻底重置（例如调试），在浏览器开发者工具「应用 / Application → Service Workers 与 Cache Storage / 缓存」中注销 Service Worker 并删除 `json-three-way-merge-static-*` 缓存（同时会清空同站点草稿），再在线刷新页面重新准备。


## 快速开始

### 方式一：Docker Compose（推荐，单条命令）

```bash
docker compose up --build
```

### 方式二：Docker

```bash
docker build -t json-three-way-merge .
docker run --rm -p 8080:8080 json-three-way-merge
```

### 方式三：本地 Node.js（≥ 18）

```bash
node server.js        # 或 npm start
```

仓库已包含浏览器端打包产物 `vendor/ajv2020.js`，直接启动即可使用全部功能（离线、无需 `npm install`）。仅在以下场景需要安装依赖：

```bash
npm install           # Ajv 8（运行时依赖，npm test 需要）与 esbuild（打包用，devDependency）
npm run build:vendor  # 修改 vendor-src 后重新生成 vendor/ajv2020.js
npm test
```

## 访问地址

启动后在浏览器打开：**http://localhost:8080**

Docker Compose 命令与端口映射保持不变（`docker compose up --build` 后访问 http://localhost:8080）；Docker 镜像在构建阶段安装全部依赖并打包 Ajv，运行镜像仅保留生产依赖、可离线运行。

端口通过环境变量 `PORT` 配置（默认 `8080`）。如需修改宿主机映射端口，编辑 `docker-compose.yml` 中的 `ports`，例如 `"9000:8080"` 后访问 http://localhost:9000。

## 使用说明

1. 在三个输入框分别粘贴基线、我的版本、对方版本的 JSON（可点「填入示例」快速体验）。
2. 点击「开始合并」。
3. 无冲突时直接得到合并结果；有冲突时在「冲突列表」中逐项查看三方值并选择采用哪一侧，结果实时更新。
4. 全部冲突解决后，「导出 merged.json」「复制结果」「导出 patch.json」按钮变为可用；若合并后又修改了输入，补丁导出会暂时禁用，重新点击「开始合并」后恢复。
5. 全部冲突解决后，「变更归因清单」列出最终 JSON 相对基线的每处改动及其来源；可按来源筛选，或点「下载归因清单 JSON」导出 `attribution.json`。改选任意冲突会同步刷新清单；合并后再修改输入，清单立即清空，重新合并后恢复。
6. （可选）展开「JSON Schema 校验」区粘贴 Draft 2020-12 Schema，或点「填入示例 Schema」；全部冲突解决后自动校验，校验通过才会解锁三个导出按钮。Schema 留空时不影响原有导出规则。
7. 校验未通过且冲突已全部选边时，校验面板下方出现「最少改选建议」：点「搜索最少改选建议」自动寻找翻转次数最少的改选方案，确认后点「应用全部建议」一次改选到位，合并结果、归因清单与导出按钮随即刷新。
8. 全部冲突解决后，「引用闭包子文档导出」区列出合并结果的全部顶层键；勾选至少一个即自动计算本地 `$ref` 引用闭包（被自动纳入的依赖键带「依赖纳入」徽标），点「下载子文档 JSON」导出 `subdoc.json`。存在非法引用时列出所在路径并禁用下载；改选冲突会重算闭包，修改三方输入会立即清空并禁用，重新合并后恢复。
9. 全部冲突解决后，「删除影响预览」区同样列出全部顶层键：勾选拟删除的键（带「拟删除」徽标），即实时列出因本地 `$ref` 直接或间接依赖它们而受影响的其他顶层键（带「受影响」徽标）与最短依赖链；非法 / 缺失 / 外部引用会逐条列出原路径但不计入影响；改选冲突即时重算，修改三方输入立即清空，重新合并后恢复。
10. 全部冲突解决后，「顶层键改名导出」区可任选一个顶层键并填写新键名（可为空字符串）：页面即时预览改名后的完整 JSON，点「下载改名后 JSON」导出 `renamed.json`，原合并结果不变；指向旧键名的本地 `$ref` 首段会同步改写（重新按 `~0` / `~1` 转义），新键名与其他已有键重名时报错并禁止下载，与原键名相同则提示无变化；改选冲突或修改键名即时重算，修改三方输入立即清空并禁用，重新合并后恢复。
11. 本轮至少选过一个冲突后，「冲突选择记录（跨轮复用）」区点「下载选择记录」导出仅含已选冲突的 `choices.json`；修改三方输入并重新点击「开始合并」后，点「导入记录…」选择该文件，页面先列出可复用与跳过的条目及原因，确认后点「确认应用」一次应用全部可复用条目（合并结果、Schema 校验、归因与导出门禁随即刷新）。修改任意三方输入会立即清空导入预览。
12. 编辑输入 / Schema 或选边后进度会自动保存到当前浏览器；刷新或重开页面时按顶部提示点「恢复草稿」（重新解析合并、匹配才重放选边；输入已改动则只恢复文本并要求重新合并）或「丢弃草稿」（立即删除本地草稿）。点「清空」同样会删除草稿。

## JSON Schema 校验（可选，Ajv 8 / Draft 2020-12）

### 校验示例

对合并结果使用下面的 Schema（可点页面上的「填入示例 Schema」获得）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
  },
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "version", "config", "tags"],
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "config": {
      "type": "object",
      "additionalProperties": false,
      "required": ["port", "host"],
      "properties": {
        "port": { "$ref": "#/$defs/port" },
        "host": { "type": "string", "minLength": 1 },
        "debug": { "type": "boolean" }
      }
    },
    "tags": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
  }
}
```

冲突未全部解决时，面板只显示黄色「待校验」（占位结果不参与校验）。解决冲突后：

- 通过：绿色「通过」徽标，提示「合并结果符合 Schema，可以导出。」
- 未通过：红色徽标并列出全部错误，每条包含实例 JSON Pointer、关键字、原因，例如：

| 实例 JSON Pointer | 关键字 | 原因 |
| --- | --- | --- |
| `/version` | `required` | 缺少必填字段「version」 |
| `/config/port` | `maximum` | 不能大于 65535 |
| `/unknown` | `additionalProperties` | 不允许出现额外字段「unknown」 |
| `/a~0b~1c/0/x` | `required` | 缺少必填字段「x」 |

最后一行展示了路径转义：字段名 `a~b/c` 在 Pointer 中写作 `a~0b~1c`（`~` → `~0`、`/` → `~1`）；`required` 与 `additionalProperties` 的 Pointer 会继续落到具体字段，而不是停在父对象。

两类 Schema 问题会被区分提示：

- **JSON 语法错误**：例如缺少逗号，提示「Schema 的 JSON 语法错误」并给出行列位置；
- **编译错误**：JSON 合法但 Schema 不合法，例如 `{"type": "nope"}` 或引用外部地址 `{"$ref": "https://example.com/s.json"}`，提示「Schema 编译错误……」。外部 `$ref` 一律不发起网络请求。

### 失效与重新校验

- 改选任意冲突、编辑 Schema 文本：自动重新编译 / 重新校验；
- 合并完成后再修改任意三方输入：面板转为「待校验」并提示旧结论已失效，导出按钮立即收回，重新点击「开始合并」后恢复；
- 删除 Schema 文本（留空）即关闭校验，回到原有导出规则。

`lib/schema.js` 在 Node.js 中同样可用（Ajv 为常规 npm 依赖），相关行为见 `npm test` 中的 `test/schema.test.js`。

### 最少改选建议（校验失败时）

同时满足以下四个条件时，校验面板下方出现「最少改选建议」区：

1. 三方输入自本轮合并后未改动；
2. Schema 编译成功；
3. 全部冲突都已选边；
4. 当前合并结果校验失败。

**搜索规则**（点「搜索最少改选建议」触发）：

- 仅当冲突不超过 **10 个**时可搜索；超过 10 个只提示超限，不搜索、也**不声称无解**；
- 以当前选边为起点，只翻转已有冲突的「我的 / 对方」选择，不改动任何输入；
- 按**翻转个数从少到多**枚举，翻转数相同时按**冲突列表索引组合的字典序**枚举（如 3 个冲突时两翻转顺序为 `{1,2}`、`{1,3}`、`{2,3}`，编号即冲突列表序号）；
- 每个候选都用现有合并逻辑重新合并、再用已编译的 Ajv 校验，**首个通过**的候选即答案——保证翻转数最少、同数时字典序最小；n 个冲突至多枚举 2ⁿ − 1 种组合（10 个冲突即 1023 种）。

**搜索结果**：

- 找到方案：列出需改选的冲突路径（如 `冲突 1：$.config.port`）与新旧选边（我的版本 → 对方版本），点「**应用全部建议**」一次应用全部改选，随后自动重新合并、重新校验，并同步刷新归因清单与导出门禁；
- 穷尽全部组合仍不通过：明确提示**无解**（仅翻转现有冲突的选边得不到合法结果），需检查三方输入或调整 Schema；
- 没有冲突可翻转（校验失败来自自动合入的内容）：直接说明无法通过改选修复。

**失效规则**：改选任意冲突、修改任意三方输入、编辑 Schema 文本，都会**立即清除**已展示的建议；重新合并或清空亦然。

#### 改选建议示例

点「填入示例」装入示例数据，两个冲突（`$.config.port`、`$.description`）都选「采用我的版本」，再粘贴下面的 Schema（要求端口不低于 9000）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "config": {
      "type": "object",
      "properties": {
        "port": { "type": "integer", "minimum": 9000, "maximum": 65535 }
      }
    }
  }
}
```

校验失败：`/config/port` `minimum` 不能小于 9000。点「搜索最少改选建议」得到：

| 冲突 | 原选边 | 新选边 |
| --- | --- | --- |
| `冲突 1：$.config.port` | 我的版本（8080） | 对方版本（9090） |

点「应用全部建议」后端口变为 9090，校验通过，三个导出按钮解锁。

`lib/suggest.js` 在 Node.js 中同样可用：

```bash
node -e "const { merge } = require('./lib/merge.js'); \
const s = require('./lib/suggest.js'); \
const base = { port: 3000 }; const mine = { port: 8080 }; const theirs = { port: 9090 }; \
const { conflicts } = merge(base, mine, theirs); \
const r = s.suggestMinimalFlips({ base, mine, theirs, conflicts, \
  resolutions: new Map([[conflicts[0].key, 'mine']]), \
  validate: (d) => d.port >= 9000 }); \
console.log(JSON.stringify(r));"
# {"status":"found","flips":[{"index":0,"key":"[\"port\"]","path":["port"],"from":"mine","to":"theirs"}],"attempts":1}
```

- 返回 `status: 'found'`：`flips` 为需翻转的冲突（含冲突列表索引 `index`、路径 `path`、新旧选边 `from` / `to`），`attempts` 为实际尝试的组合数；
- 返回 `status: 'none'`：穷尽全部组合仍不通过；
- 返回 `status: 'too-many'`：冲突数超过上限（默认 10，可用 `maxConflicts` 选项调整），未做任何尝试。

相关行为见 `npm test` 中的 `test/suggest.test.js`。

## JSON Patch 导出（RFC 6902）

全部冲突解决后，「导出 patch.json」生成从**本轮基线**到**合并结果**的增量操作数组，可在任何持有相同基线的地方用任意 RFC 6902 实现重放：

- **对象**：逐键生成 `add` / `remove` / `replace`
- **数组**：用最长公共子序列（LCS）对齐完整元素，按执行时的索引生成数量最少的 `add` / `remove`，不使用 `move` / `copy`；对齐采用线性空间算法（Hirschberg），额外内存随两侧数组长度之和增长，不保留按两侧长度乘积分配的矩阵，上万元素的数组改动也不会撑爆浏览器内存
- **路径**为 JSON Pointer（RFC 6901）：空字符串指根，键名中的 `~`、`/` 分别转义为 `~0`、`~1`
- 严格区分「字段缺失」与 `null`：删除 null 字段生成 `remove`，新增 null 字段生成 `add`
- 合并结果与基线一致时导出空数组 `[]`

### 补丁示例

基线：

```json
{ "name": "demo", "tags": ["a", "b", "c"], "config": { "port": 3000 } }
```

合并结果：

```json
{ "name": "demo", "tags": ["a", "c", "d"], "config": { "port": 8080, "debug": true } }
```

导出的 `patch.json`：

```json
[
  { "op": "remove", "path": "/tags/1" },
  { "op": "add", "path": "/tags/2", "value": "d" },
  { "op": "replace", "path": "/config/port", "value": 8080 },
  { "op": "add", "path": "/config/debug", "value": true }
]
```

将以上操作依序作用于基线即得合并结果。浏览器与 Node 中均可用内置的 `PatchLib.apply(base, ops)` 重放校验：

```bash
node -e "const p = require('./lib/patch.js'); \
const ops = p.diff({ a: 1 }, { a: 2, b: [1, 2] }); \
console.log(JSON.stringify(ops)); \
console.log(JSON.stringify(p.apply({ a: 1 }, ops)));"
# [{"op":"replace","path":"/a","value":2},{"op":"add","path":"/b","value":[1,2]}]
# {"a":2,"b":[1,2]}
```

## 变更归因清单

全部冲突解决后，结果区下方生成「变更归因清单」：按**本轮基线**与**最终结果**列出发生变化的最小路径，供审阅者确认最终 JSON 中每处改动的来源。

- **路径粒度**：基线值与结果值**两者都是对象**时逐键下钻；**数组与类型替换作为整体**，不做元素级展开；对象下钻后不重复列父项
- **路径格式**：JSON Pointer（RFC 6901），空字符串表示根，键名中的 `~`、`/` 分别转义为 `~0`、`~1`
- **每条内容**：改动类型（新增 / 删除 / 替换）、基线值、结果值、来源；字段缺失在页面上明确标注为「（缺失）」，与 `null` 区分
- **来源**共五种：

| 来源 | 含义 |
| --- | --- |
| 仅我 | 只有我修改了该路径 |
| 仅对方 | 只有对方修改了该路径 |
| 双方同改 | 双方做了相同改动（含同时删除）；也包括双方各自把同一位置改成对象后被按键自动合并的情形 |
| 冲突选我 | 该路径（或其祖先）是冲突，最终采用我的版本 |
| 冲突选对方 | 该路径（或其祖先）是冲突，最终采用对方版本 |

- **被放弃的改动不入清单**：冲突未选一侧的改动不会出现在清单中，清单只反映基线 → 最终结果的实际变化
- 改选任意冲突后清单**同步更新**；合并后再修改任意三方输入，旧清单**立即清空**，重新点击「开始合并」后恢复
- 支持**按来源筛选**（下拉框带各来源数量）与**下载 JSON 清单**（`attribution.json`）；清单的生成不依赖 Schema 校验结果

### 归因示例

以页面「填入示例」的数据为例（冲突 `/config/port` 选我的 `8080`、`/description` 选对方的 `"示例应用 v2"`），下载得到的 `attribution.json`：

```json
[
  { "pointer": "/version", "op": "replace", "source": "both", "base": { "exists": true, "value": "1.0.0" }, "result": { "exists": true, "value": "1.1.0" } },
  { "pointer": "/config/port", "op": "replace", "source": "conflict-mine", "base": { "exists": true, "value": 3000 }, "result": { "exists": true, "value": 8080 } },
  { "pointer": "/config/debug", "op": "replace", "source": "theirs", "base": { "exists": true, "value": false }, "result": { "exists": true, "value": true } },
  { "pointer": "/tags", "op": "replace", "source": "both", "base": { "exists": true, "value": ["a", "b"] }, "result": { "exists": true, "value": ["a", "b", "c"] } },
  { "pointer": "/description", "op": "replace", "source": "conflict-theirs", "base": { "exists": true, "value": "示例应用" }, "result": { "exists": true, "value": "示例应用 v2" } },
  { "pointer": "/deprecated", "op": "remove", "source": "theirs", "base": { "exists": true, "value": null }, "result": { "exists": false } },
  { "pointer": "/license", "op": "add", "source": "mine", "base": { "exists": false }, "result": { "exists": true, "value": "MIT" } }
]
```

- `op`：`add`（新增）/ `remove`（删除）/ `replace`（替换）
- `source`：`mine` / `theirs` / `both` / `conflict-mine` / `conflict-theirs`，依次对应 仅我 / 仅对方 / 双方同改 / 冲突选我 / 冲突选对方
- **存在标记**：`base` / `result` 用 `{ "exists": false }` 表示字段缺失（没有 `value` 键），用 `{ "exists": true, "value": null }` 表示值为 `null`——字段缺失与 `null` 绝不混淆

`lib/attribution.js` 在 Node.js 中同样可用：

```bash
node -e "const a = require('./lib/attribution.js'); \
const r = a.attributeMerge({ v: 1 }, { v: 2 }, { v: 2 }); \
console.log(JSON.stringify(a.serializeEntries(r.entries)));"
# [{"pointer":"/v","op":"replace","source":"both","base":{"exists":true,"value":1},"result":{"exists":true,"value":2}}]
```

相关行为见 `npm test` 中的 `test/attribution.test.js`。

## 引用闭包子文档导出

冲突全部解决且三方输入自本轮合并后未改动时，结果区下方出现「引用闭包子文档导出」：列出合并结果的全部顶层键供勾选，勾选至少一个即可下载仅含「所选键 + 本地 `$ref` 引用依赖」的子文档 `subdoc.json`。

- **闭包规则**：递归扫描纳入值中的字符串 `$ref`（对象属性名为 `$ref` 且值为字符串）；仅接受 `#`（指向根，纳入全部顶层键）或 `#/...`（JSON Pointer，按 RFC 6901 的 `~0`、`~1` 规则还原并确认目标存在），再纳入目标所属顶层键，反复处理至闭包稳定
- **循环引用只处理一次**（如 a 引 b、b 引 a 不会死循环）；**导出键保持原结果顺序**；目标值为 `null` / `0` / `false` 也算存在，只有真正缺失才报错
- **绝不生成不完整子文档**：非法转义（如 `#/a~2b`）、缺失目标（如 `#/nope`）或外部引用（如 `https://...`、`other.json#/a`）会逐条列出所在路径并禁用下载
- 根结果不是对象（数组 / 标量）时说明原因，不提供勾选；改选冲突即时重算闭包；修改三方输入立即清空勾选并禁用，重新点击「开始合并」后恢复
- 该导出不依赖 Schema 校验结果（与归因清单一致）

### 引用导出示例

合并结果：

```json
{
  "api": { "endpoint": { "$ref": "#/defs/host" }, "path": "/v1" },
  "defs": { "host": "example.com" },
  "version": "1.1.0"
}
```

勾选 `api`：`$ref` 指向 `#/defs/host`，其目标所属顶层键为 `defs`，闭包自动纳入 `defs`；未被引用的 `version` 不导出。得到的 `subdoc.json`：

```json
{
  "api": { "endpoint": { "$ref": "#/defs/host" }, "path": "/v1" },
  "defs": { "host": "example.com" }
}
```

若合并结果中含非法引用，例如 `"api": { "endpoint": { "$ref": "https://example.com/x.json" } }`，勾选 `api` 后显示错误并禁用下载：

| 所在路径 | 原因 |
| --- | --- |
| `/api/endpoint/$ref` | 外部引用「https://example.com/x.json」：仅支持文档内引用（# 或 #/...），不纳入外部目标 |

`lib/refclosure.js` 在 Node.js 中同样可用：

```bash
node -e "const r = require('./lib/refclosure.js'); \
const out = r.computeRefClosure({ a: { \$ref: '#/b' }, b: 1, c: 2 }, ['a']); \
console.log(JSON.stringify(out));"
# {"status":"ok","keys":["a","b"],"doc":{"a":{"$ref":"#/b"},"b":1}}
```

- 返回 `status: 'ok'`：`keys` 为闭包后的导出键（保持原结果键序），`doc` 为仅含这些键的子文档；
- 返回 `status: 'errors'`：`errors` 逐条给出所在路径（`pointer`）、引用文本（`ref`）与原因（`reason`），不产出 `doc`；
- 返回 `status: 'not-object'` / `'empty'`：根结果不是对象，或未勾选任何存在的顶层键。

相关行为见 `npm test` 中的 `test/refclosure.test.js`。

## 删除影响预览

冲突全部解决且三方输入自本轮合并后未改动时，结果区最下方出现「删除影响预览」：列出合并结果的全部顶层键，勾选拟删除的键后，页面列出**因本地 `$ref` 直接或间接依赖这些键而受影响的其他顶层键**，并为每个受影响键给出一条最短的「受影响键 → … → 拟删键」依赖链。

- **依赖扫描**：扫描每个顶层键的值，递归进入对象属性与数组元素，凡属性名为 `$ref` 且值为字符串（含顶层键名本身就是 `$ref` 的情形）即一个引用；仅接受 `#`（指向根，**视为依赖全部顶层键**）与 `#/...`（JSON Pointer，按 RFC 6901 `~0` / `~1` 解析），并确认目标存在；依赖只归到目标所属的顶层键
- **受影响判定与最短链**：在「顶层键 → 顶层键」依赖图上，能沿依赖方向到达任一拟删键的其他顶层键都受影响；多源 BFS 计算到最近拟删键的最短边数，受影响列表保持原结果顶层键序；多条等长最短链时，按原结果中的顶层键序逐键比较**整条链**、取字典序最小者（即在第一个分叉处选顶层键序最靠前的键）
- **循环依赖必须收敛**：多源 BFS 在有限图上必然结束；回溯最短链时每一步都走到距离严格减 1 的下一节点，绕不回已访问节点，如 `a ↔ b` 成环、拟删 `c`（`a` 同时直引 `c`）时给出 `b → a → c` 而 `a → c` 直连
- **非法引用不计入影响**：非法转义（如 `#/a~2b`）、无法识别（如 `#foo`）、缺失目标（如 `#/nope`、数组越界、穿过标量）或外部引用（如 `https://...`、`other.json#/a`）会单独列出所在**原路径**（如 `/api/endpoint/$ref`）与原因，并明确「不计入删除影响」——它们不产生任何依赖边
- 根结果不是对象（数组 / 标量 / `null`）时提示无法预览，不提供勾选；拟删键本身不在受影响列表；没有任何键依赖拟删键时明确提示删除不会产生引用断链
- 勾选或取消勾选即时重算，**改选冲突后也即时重算**（顶层键集合变化时自动剔除已不存在的勾选）；三方输入一旦编辑立即清空勾选与预览，重新点击「开始合并」后恢复；该预览只读、不修改合并结果，且不依赖 Schema 校验

### 删除预览示例

合并结果：

```json
{
  "api": { "endpoint": { "$ref": "#/defs/host" } },
  "gateway": { "upstream": { "$ref": "#/api" } },
  "defs": { "host": "example.com", "port": { "$ref": "#/defs/host" } },
  "version": "1.1.0"
}
```

勾选拟删除顶层键 `defs`，预览列出：

| 受影响顶层键 | 最短依赖链（受影响键 → … → 拟删键） |
| --- | --- |
| `api` | `api` → `defs` |
| `gateway` | `gateway` → `api` → `defs` |

`defs` 自身不出现；`defs.port` 对 `defs.host` 的引用是拟删键**内部**引用，不影响其他顶层键；与引用闭包无关、也不引用 `defs` 的 `version` 不受影响。

多条等长链按原结果键序取字典序最小者：若 `api` 同时引用 `b` 与 `c`，且 `b`、`c` 都引用拟删键 `defs`，两条链 `api → b → defs` 与 `api → c → defs` 等长，`b` 在原结果中排在 `c` 前，故取 `api → b → defs`。

若结果中含外部引用，例如 `"bad": { "$ref": "https://example.com/x.json" }`，它只在错误区单独提示原路径，不产生依赖边：

| 所在路径 | 原因 |
| --- | --- |
| `/bad/$ref` | 外部引用「https://example.com/x.json」：仅支持文档内引用（# 或 #/...），不纳入外部目标（该引用不计入删除影响） |

`lib/delimpact.js` 在 Node.js 中同样可用：

```bash
node -e "const d = require('./lib/delimpact.js'); \
const doc = { a: { \$ref: '#/b' }, b: { \$ref: '#/c' }, c: 1 }; \
console.log(JSON.stringify(d.computeDeletionImpact(doc, ['c'])));"
# {"status":"ok","deleting":["c"],"affected":[{"key":"a","chain":["a","b","c"]},{"key":"b","chain":["b","c"]}],"errors":[]}
```

- 返回 `status: 'ok'`：`deleting` 为拟删键（保持原结果键序），`affected` 为受影响的其他顶层键（同样按原键序），每项含 `key` 与最短依赖链 `chain`；`errors` 为全部非法 / 缺失 / 外部引用（含 `pointer`、`ref`、`reason`），它们不产生依赖边；
- 返回 `status: 'not-object'` / `'empty'`：根结果不是对象，或未勾选任何存在的顶层键。

相关行为见 `npm test` 中的 `test/delimpact.test.js`。

## 顶层键改名导出

冲突全部解决且三方输入自本轮合并后未改动时，结果区最下方出现「顶层键改名导出」：从下拉框选择一个顶层键、填写新键名（**可为空字符串**），页面即时预览改名后的完整 JSON，点「下载改名后 JSON」导出 `renamed.json`；**原合并结果不变**（主结果区与其他导出不受影响）。

- **键名校验**：新键名与其他已有顶层键重名时**报错并禁止下载**；与原键名相同则提示「无变化」（同名不产生改名，下载保持禁用）；新键名为空字符串是合法选择，即改名为空字符串键
- **$ref 同步改写**：递归扫描整个结果中对象与数组里的字符串 `$ref`（属性名为 `$ref` 且值为字符串，顶层键名为 `$ref` 时同样计入），仅接受 `#` 或 `#/...`：依 JSON Pointer（RFC 6901）解码并确认**原目标存在**；首段等于旧键名时换为新键名并重新按 `~0` / `~1` 转义，**其余片段与单独的 `#` 保持原文不动**；首段不是旧键名的引用整条不变
- **非法引用禁止下载**：非法转义（如 `#/a~2b`）、缺失目标（如 `#/nope`）或外部引用（如 `https://...`、`other.json#/a`）会逐条列出所在**原路径**并禁用下载——即使它们与改名键无关，也绝不导出引用断链的文档
- 改选冲突、改选顶层键或修改新键名都会**即时重算**；三方输入一旦编辑立即清空选择、键名与预览并禁用，重新点击「开始合并」后恢复；根结果不是对象（数组 / 标量）时提示没有顶层键可改名；该导出不依赖 Schema 校验结果

### 改名示例

合并结果：

```json
{
  "api": { "endpoint": { "$ref": "#/defs/host" }, "path": "/v1" },
  "defs": { "host": "example.com" },
  "version": "1.1.0"
}
```

选择顶层键 `defs`，新键名填 `schemas`：`/api/endpoint/$ref` 的首段等于旧键名，被改写为 `#/schemas/host`；`defs` 键本身改名为 `schemas` 且保持原键序位置，其余内容不变。得到的 `renamed.json`：

```json
{
  "api": { "endpoint": { "$ref": "#/schemas/host" }, "path": "/v1" },
  "schemas": { "host": "example.com" },
  "version": "1.1.0"
}
```

新键名含 `~` / `/` 时引用首段会重新转义：把 `defs` 改名为 `a/b` 时，上述引用变为 `#/a~1b/host`；而形如 `#/defs/~01` 的引用改名后写作 `#/schemas/~01`——首段以外的片段保持原文，不重新编码。单独的 `"$ref": "#"` 指向根，不属于任何顶层键，原样保留。

若结果中含非法引用，例如 `"bad": { "$ref": "https://example.com/x.json" }`，即使它与改名键无关，也会标出原路径并禁用下载：

| 所在路径 | 原因 |
| --- | --- |
| `/bad/$ref` | 外部引用「https://example.com/x.json」：仅支持文档内引用（# 或 #/...），改名导出不接受外部引用 |

`lib/keyrename.js` 在 Node.js 中同样可用：

```bash
node -e "const k = require('./lib/keyrename.js'); \
const r = k.renameTopKey({ api: { \$ref: '#/defs' }, defs: 1 }, 'defs', 'schemas'); \
console.log(JSON.stringify(r));"
# {"status":"ok","doc":{"api":{"$ref":"#/schemas"},"schemas":1},"refs":[{"pointer":"/api/$ref","from":"#/defs","to":"#/schemas"}]}
```

- 返回 `status: 'ok'`：`doc` 为改名后的完整文档（原结果不被修改），`refs` 列出被改写的引用（`pointer` 为原文档中的路径、`from` / `to` 为改写前后的引用文本）；
- 返回 `status: 'same'`：新旧键名相同，无变化；`status: 'conflict'`：新键名与其他已有顶层键重名；
- 返回 `status: 'errors'`：`errors` 逐条给出所在原路径（`pointer`）、引用文本（`ref`）与原因（`reason`），不产出 `doc`；
- 返回 `status: 'not-object'` / `'no-key'`：根结果不是对象，或所选顶层键不存在。

相关行为见 `npm test` 中的 `test/keyrename.test.js`。

## 冲突选择记录（跨轮复用）

同一份三方输入需要反复合并（例如重新走一遍评审、输入被脚本重排、换了浏览器 / 机器）时，不必逐个重选冲突：本轮至少选过一个冲突后，可把当前选择下载为记录，下一轮重新合并后导入复用。

- **记录内容**：只含**已选冲突**，每项保存冲突路径（JSON 键路径数组）、基线 / 我的 / 对方三个值（带存在标记）与选边；**不包含任何一份完整输入**
- **存在标记**：字段缺失写作 `{ "exists": false }`（没有 `value` 键），值为 `null` 写作 `{ "exists": true, "value": null }`，缺失与 `null` 绝不混同
- **复用条件**：路径与三方值与当前冲突**完全一致**才复用——对象逐键比较、**忽略键序**；数组逐下标比较、**保留顺序**；缺失（`exists:false`）与 `null` 严格区分
- **只跳过、不覆盖**：当前合并中已消失（没有同路径冲突）或三方值已变化的条目只跳过并逐条说明原因；当前已手动选择的冲突同样跳过，导入**不会覆盖**已有选择
- **整份拒绝**：JSON 语法错误、顶层或条目结构错误、存在标记格式错误、**重复路径**、**非法选边**（只能是 `"mine"` / `"theirs"`）都会拒绝整份记录，不应用其中任何一条
- **一次确认应用**：导入后只展示预览（可复用 N 条 / 跳过 M 条及原因），点「**确认应用**」才一次写入全部可复用条目；应用后自动重新合并、重新校验，并同步刷新归因清单与导出门禁
- **失效规则**：三方输入一旦编辑立即清空导入预览并禁用，重新点击「开始合并」后恢复；新一轮合并、手动改选冲突或应用最少改选建议也会作废旧预览

### 跨轮复用示例

第 1 轮：点「填入示例」、「开始合并」，把两个冲突分别选边（`config.port` 选我的 `8080`、`description` 选对方的「示例应用 v2」），点「下载选择记录」得到 `choices.json`：

```json
{
  "version": 1,
  "choices": [
    {
      "path": ["config", "port"],
      "base": { "exists": true, "value": 3000 },
      "mine": { "exists": true, "value": 8080 },
      "theirs": { "exists": true, "value": 9090 },
      "choice": "mine"
    },
    {
      "path": ["description"],
      "base": { "exists": true, "value": "示例应用" },
      "mine": { "exists": false },
      "theirs": { "exists": true, "value": "示例应用 v2" },
      "choice": "theirs"
    }
  ]
}
```

注意 `/description` 的我的版本为 `{ "exists": false }`（我的侧删除了该字段），而不是 `null`。

第 2 轮（可能在刷新页面、换机器或稍后重新粘贴相同三方输入之后）：再次「开始合并」，在「冲突选择记录」区点「导入记录…」选择 `choices.json`，页面预览：

```
记录共 2 条：可复用 2 条，跳过 0 条。
可复用（2）
  $.config.port → 我的版本
  $.description → 对方版本
[确认应用（2 条）] [取消]
```

点「确认应用」：两个冲突一次选中，合并结果、Schema 校验、归因清单与导出按钮随即刷新，等价于第 1 轮的手动选择。

若第 2 轮输入有变化，预览会如实分流，例如对方把端口改为 `9091`、而某个冲突已经不再出现：

| 记录路径 | 结果 | 原因 |
| --- | --- | --- |
| `$.config.port` | 跳过 | 记录中的三方值与当前冲突不完全一致（对方版本值已变化），不予复用 |
| `$.old.flag` | 跳过 | 当前合并中不存在该路径的冲突（该冲突在本轮已消失） |
| `$.description` | 可复用 | — |

导入前若已手动把 `$.description` 选为我的版本，该条会变为跳过，原因注明「当前已手动选择为『我的版本』，导入不覆盖已有选择」。

`lib/choices.js` 在 Node.js 中同样可用：

```bash
node -e "
const { merge } = require('./lib/merge.js');
const C = require('./lib/choices.js');
const base = { port: 3000 };
const mine = { port: 8080 };
const theirs = { port: 9090 };
// 第 1 轮：选「我的」并导出记录文本
const r1 = merge(base, mine, theirs);
const text = JSON.stringify(C.serializeChoices(r1.conflicts, new Map([[r1.conflicts[0].key, 'mine']])));
// 第 2 轮：重新合并后解析、预览、一次应用
const r2 = merge(base, mine, theirs);
const parsed = C.parseChoicesRecord(text);
const plan = C.planReuse(parsed.entries, r2.conflicts, new Map());
const resolutions = C.applyReuse(new Map(), plan.reusable);
console.log(plan.reusable.length, merge(base, mine, theirs, resolutions).result.port);"
# 1 8080
```

- `serializeChoices(conflicts, resolutions)`：生成记录对象（仅含已选冲突，未选冲突自动排除）；
- `parseChoicesRecord(text)`：严格解析记录文本，返回 `{ status: 'ok', entries }` 或 `{ status: 'error', reason }`——任何格式错误都拒绝整份；
- `planReuse(entries, conflicts, resolutions)`：返回 `{ reusable, skipped }`，`skipped` 逐条带中文 `reason`（已消失 / 三值变化 / 已手动选择）；
- `applyReuse(resolutions, reusable)`：把可复用条目一次写入选择映射（跳过条目不写入、已有选择不覆盖）。

相关行为见 `npm test` 中的 `test/choices.test.js`。

## 浏览器本地合并草稿（刷新 / 重开恢复）

合并做到一半不小心刷新、关错标签页、浏览器崩溃后重开？页面会把当前进度自动保存在**当前浏览器**的 `localStorage` 中（键名 `json-three-way-merge:draft:v1`），不发送到任何服务器；换浏览器、换机器或清除站点数据后不可见。

- **自动保存时机**：编辑任意三方输入或可选 Schema（防抖约 0.3 秒，页面隐藏 / 关闭前再同步落盘一次）、每次点选冲突、一次「确认应用」选择记录或「应用全部建议」之后
- **草稿内容**：三方输入文本、可选 Schema 文本、**最近一次「开始合并」所用的三方文本**、**本轮已选冲突**（路径 + 基线 / 我的 / 对方三值 + 选边）与当时的合并结果 JSON；合并后又改了输入也会保存最新编辑文本，且**不覆盖**合并快照
- **恢复询问**：刷新或重新打开页面时，页面顶部出现提示条（含保存时间与已选冲突数），点「**恢复草稿**」或「**丢弃草稿**」；在提示下直接开始编辑也会自动放弃本次询问并按新内容继续保存
- **安全重放（同时满足才重放选边）**：
  1. 恢复后**重新解析、重新合并**，当前三方文本与保存的「最近一次合并所用文本」**逐字符一致**；
  2. 保存条目的路径与基线 / 我的 / 对方三值在重新合并得到的冲突中**全部匹配**（对象忽略键序、数组保序、缺失与 `null` 不混同）；
  3. 应用保存选边后的重新合并结果与保存的合并结果 JSON **深相等**。
- **输入已改动时只恢复文本**：任一条件不满足，只恢复三方输入与 Schema 文本，**不恢复结果区与任何旧 Schema 校验结论**，提示重新点击「开始合并」；旧结果、旧「通过」状态**不会直接放行**导出 / 复制 / 补丁按钮
- **未合并草稿**：只编辑过输入、还没点过「开始合并」时，草稿不含合并快照，恢复后只填回文本与 Schema
- **清空与丢弃**：点页面「清空」、或在恢复提示中点「丢弃草稿」都会立即删除本地草稿
- **异常说明但不影响合并**：草稿损坏（JSON 截断、字段缺失、版本不受支持、条目非法等）时提示具体原因并可一键「删除损坏草稿」；浏览器拒绝本地存储（隐私 / 无痕模式、站点存储被禁用、配额已满）时提示原因；两种情况下**正常合并功能始终可用**

### 恢复示例

1. 点「填入示例」、「开始合并」，在冲突列表中把 `$.config.port` 选为「我的版本」（另一个冲突先不选）。
2. 直接按 F5 刷新页面（或关闭标签页后重新打开 http://localhost:8080），页面顶部出现：

   > 检测到本浏览器保存的合并草稿（保存于 2026-09-28 15:04:05）：含三方输入、可选 Schema、最近一次合并所用的三方文本与本轮已选 1 个冲突。恢复后会重新解析并合并；仅当当前三方文本与保存的合并文本一致、且冲突路径与基线 / 我的 / 对方三值均匹配时才重放选边；输入已改动则只恢复编辑文本并要求重新合并，旧结果与旧校验状态不会放行导出。
   >
   > **[恢复草稿]** [丢弃草稿]

3. 点「**恢复草稿**」：页面以保存的三方文本重新解析、重新合并，`$.config.port` 自动保持「我的版本」，另一个冲突仍待选择，Schema（若填写过）重新编译并按新结果校验；顶部蓝色提示注明「已重放 1 / 2 个冲突的选边」。
4. 若刷新前在合并之后又改过输入（例如把我的版本里的端口改成 `8081`），恢复时顶部提示变为：

   > 已恢复草稿中的三方输入与可选 Schema，但保存草稿后三方输入已改动，需要重新合并。请重新点击「开始合并」；恢复前的旧合并结果与旧校验结论不会直接放行导出。

   此时只填回文本、不显示旧结果，需重新合并才能导出。

核心判定逻辑在浏览器与 Node.js 中共用 `lib/draft.js`（依赖 `merge.js` 与 `choices.js`）：

```bash
node -e "
const { merge } = require('./lib/merge.js');
const D = require('./lib/draft.js');
const base = { port: 3000 }, mine = { port: 8080 }, theirs = { port: 9090 };
const tb = JSON.stringify(base), tm = JSON.stringify(mine), tt = JSON.stringify(theirs);
const r1 = merge(base, mine, theirs, new Map());
const resolutions = new Map([[r1.conflicts[0].key, 'mine']]);
const r2 = merge(base, mine, theirs, resolutions);
const draft = D.buildDraft({
  inputs: { base: tb, mine: tm, theirs: tt }, schema: '',
  merge: { inputs: { base: tb, mine: tm, theirs: tt },
    conflicts: r1.conflicts, resolutions, mergedText: JSON.stringify(r2.result) },
});
// 刷新后：parseDraft 严格校验，replaySnapshot 重新解析合并并比对
const loaded = D.parseDraft(JSON.stringify(draft));
const v = D.replaySnapshot(loaded.draft, draft.inputs);
console.log(v.status, v.resolutions.size, v.result.port);
// 输入被改过 -> 只恢复文本
console.log(D.replaySnapshot(loaded.draft, { base: tb, mine: tm.replace('8080','8081'), theirs: tt }).status);"
# replay 1 8080
# text-only
```

- `buildDraft({ inputs, schema, merge })`：构造草稿对象；`merge` 缺省 / 为 `null` 表示尚未合并；
- `parseDraft(text)` / `validateDraft(data)`：严格校验，返回 `{ status:'ok', draft }` 或 `{ status:'error', reason }`，允许零冲突轮的空 `choices`；
- `replaySnapshot(draft, currentInputs)`：返回 `{ status:'replay', resolutions, result, conflicts, stats }` 或 `{ status:'text-only', reason }`；
- `STORAGE_KEY`：`json-three-way-merge:draft:v1`。

相关行为见 `npm test` 中的 `test/draft.test.js`。

## 合并规则

| 情形 | 处理 |
| --- | --- |
| 仅一方改动 / 双方改成相同值 / 双方同时删除 | 自动合入 |
| 双方新增同名对象键 | 按键递归合并（基线按空对象处理） |
| 双方改成不同值（含数组内容不同） | 冲突，等待选择 |
| 一方删除、另一方修改 | 冲突（删除 vs 修改），等待选择 |

冲突选择以路径（如 `$.config.port`）为键记录，重新点击「开始合并」会重置所有选择。

## 运行测试

```bash
npm test        # 等价于 node --test test/
```

## 项目结构

```
├── server.js             # 零依赖静态文件服务器（PORT 环境变量，默认 8080；HTML 与 sw.js 带 no-cache 头）
├── lib/merge.js          # 三方合并核心逻辑（浏览器 / Node 共用）
├── lib/patch.js          # JSON Patch（RFC 6902）生成与重放（浏览器 / Node 共用）
├── lib/schema.js         # Schema 编译 / 错误定位封装（Ajv 8，浏览器 / Node 共用）
├── lib/attribution.js    # 变更归因清单生成与导出（浏览器 / Node 共用，依赖 merge.js）
├── lib/suggest.js        # 最少改选建议搜索（浏览器 / Node 共用，依赖 merge.js）
├── lib/refclosure.js     # 引用闭包子文档导出（浏览器 / Node 共用）
├── lib/delimpact.js      # 删除影响预览：顶层键 $ref 依赖图、最短依赖链（浏览器 / Node 共用）
├── lib/keyrename.js      # 顶层键改名导出：改名 + $ref 首段改写（浏览器 / Node 共用）
├── lib/choices.js        # 冲突选择记录：导出 / 严格校验 / 复用预览与应用（浏览器 / Node 共用，依赖 merge.js）
├── lib/draft.js          # 浏览器本地合并草稿：构造 / 严格校验 / 损坏检测 / 安全重放（浏览器 / Node 共用，依赖 merge.js、choices.js）
├── vendor-src/
│   └── ajv2020-entry.cjs # esbuild 打包入口：导出 Ajv 2020 构造器
├── vendor/
│   └── ajv2020.js        # 浏览器端 Ajv 8 打包产物（npm run build:vendor 生成）
├── public/
│   ├── index.html        # 页面
│   ├── sw.js             # 离线续用 Service Worker：整套静态资源版本化预缓存 / 缓存优先（升级时 CACHE_VERSION 加 1）
│   ├── offline.js        # SW 注册与页头离线状态徽标（准备中 / 可离线 / 失败原因 / 新版待重载）
│   ├── app.js            # 交互逻辑（解析、渲染冲突、Schema 校验、改选建议、归因清单、引用闭包导出、删除影响预览、顶层键改名导出、冲突选择记录复用、浏览器本地草稿自动保存与恢复、导出）
│   └── style.css
├── test/merge.test.js    # 合并逻辑单元测试（node:test）
├── test/patch.test.js    # 补丁生成 / 重放单元测试（node:test）
├── test/schema.test.js   # Schema 编译与错误定位单元测试（node:test）
├── test/attribution.test.js # 归因清单单元测试（node:test）
├── test/suggest.test.js  # 最少改选建议单元测试（node:test）
├── test/refclosure.test.js # 引用闭包导出单元测试（node:test）
├── test/delimpact.test.js  # 删除影响预览单元测试（node:test）
├── test/keyrename.test.js  # 顶层键改名导出单元测试（node:test）
├── test/choices.test.js    # 冲突选择记录单元测试（node:test）
├── test/draft.test.js      # 浏览器本地合并草稿：构造 / 损坏检测 / 安全重放单元测试（node:test）
├── test/offline.test.js    # 离线缓存：预缓存清单与页面引用一致性、文件可达、no-cache 头、不 claim / 不运行时写入（node:test）
├── package.json
├── Dockerfile
├── docker-compose.yml
└── .dockerignore
```
