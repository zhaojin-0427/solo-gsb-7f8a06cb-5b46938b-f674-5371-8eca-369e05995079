(function () {
  'use strict';

  const { merge, MISSING } = window.MergeLib;
  const { diff: diffPatch } = window.PatchLib;
  const SchemaLib = window.SchemaLib;
  const { attribute, serializeEntries } = window.AttributionLib;
  const SuggestLib = window.SuggestLib;
  const RefLib = window.RefClosureLib;
  const DelImpactLib = window.DelImpactLib;
  const RenLib = window.KeyRenameLib;
  const ChoicesLib = window.ChoicesLib;
  const DraftLib = window.DraftLib;

  const els = {
    base: document.getElementById('base'),
    mine: document.getElementById('mine'),
    theirs: document.getElementById('theirs'),
    mergeBtn: document.getElementById('mergeBtn'),
    sampleBtn: document.getElementById('sampleBtn'),
    clearBtn: document.getElementById('clearBtn'),
    draftBar: document.getElementById('draftBar'),
    schemaInput: document.getElementById('schemaInput'),
    schemaSection: document.getElementById('schemaSection'),
    schemaSampleBtn: document.getElementById('schemaSampleBtn'),
    error: document.getElementById('error'),
    staleNote: document.getElementById('staleNote'),
    schemaValidation: document.getElementById('schemaValidation'),
    resultSection: document.getElementById('resultSection'),
    statusText: document.getElementById('statusText'),
    conflicts: document.getElementById('conflicts'),
    result: document.getElementById('result'),
    resultNote: document.getElementById('resultNote'),
    exportBtn: document.getElementById('exportBtn'),
    copyBtn: document.getElementById('copyBtn'),
    patchBtn: document.getElementById('patchBtn'),
    exportHint: document.getElementById('exportHint'),
    attrSection: document.getElementById('attrSection'),
    attrFilter: document.getElementById('attrFilter'),
    attrBtn: document.getElementById('attrBtn'),
    attrNote: document.getElementById('attrNote'),
    attrList: document.getElementById('attrList'),
    refSection: document.getElementById('refSection'),
    refBtn: document.getElementById('refBtn'),
    refNote: document.getElementById('refNote'),
    refKeys: document.getElementById('refKeys'),
    refErrors: document.getElementById('refErrors'),
    delSection: document.getElementById('delSection'),
    delNote: document.getElementById('delNote'),
    delKeys: document.getElementById('delKeys'),
    delErrors: document.getElementById('delErrors'),
    delImpact: document.getElementById('delImpact'),
    renSection: document.getElementById('renSection'),
    renBtn: document.getElementById('renBtn'),
    renNote: document.getElementById('renNote'),
    renKey: document.getElementById('renKey'),
    renName: document.getElementById('renName'),
    renErrors: document.getElementById('renErrors'),
    renPreview: document.getElementById('renPreview'),
    choiceSection: document.getElementById('choiceSection'),
    choiceBtn: document.getElementById('choiceBtn'),
    choiceFile: document.getElementById('choiceFile'),
    choiceNote: document.getElementById('choiceNote'),
    choicePreview: document.getElementById('choicePreview'),
  };

  const state = {
    parsed: false,
    base: null,
    mine: null,
    theirs: null,
    allConflicts: [],      // 本次合并的全部冲突（解决后仍保留在列表中，可改选）
    resolutions: new Map(), // key -> 'mine' | 'theirs'
    lastJson: '',
    // 最近一次合并所用的三方文本（草稿重放的一致性依据；合并后输入再改不会更新）
    mergedInputs: null,    // null | { base, mine, theirs }（文本）
    lastPatch: '',         // 本轮基线 -> 合并结果的 RFC 6902 操作数组（JSON 文本）
    stale: false,          // 合并后输入又被编辑：补丁导出禁用、旧校验结论失效，重新合并后恢复
    // 归因清单：冲突全部解决且输入未被修改时生成；否则保持为空
    attribution: [],
    lastAttribution: '',   // serializeEntries 后的 JSON 文本（下载用）
    attrFilter: 'all',     // 来源筛选：'all' 或五种来源之一
    // Schema 校验状态：
    //  ''            未填写 Schema（不校验，沿用原有规则）
    //  'json-error'  Schema 文本 JSON 语法错误
    //  'compiling'   JSON 合法、Ajv 正在编译
    //  'compile-error' Schema 编译错误（非法关键字 / 文档外 $ref 等）
    //  'ready'       编译成功；再由 validationErrors 表示最近一次校验结果
    schemaStatus: '',
    schemaError: '',         // json-error / compile-error 的说明
    validator: null,         // 编译成功后的 validate 函数
    validationErrors: null,  // ready 状态下：null 表示通过，数组表示全部错误
    schemaBlocked: false,    // ready 但当前不应校验（冲突未解决 / 输入已改动）
    compileToken: 0,         // 丢弃过期的异步编译结果
    // 最少改选建议（仅“校验失败 + 冲突全部选边 + 输入未改动”时可搜索）：
    //  null                  无建议（或已被清除）
    //  { status: 'searching' } 正在枚举改选组合
    //  { status: 'found', flips, attempts }  找到最少改选方案，等待用户确认
    //  { status: 'none', attempts }          穷尽全部组合仍不通过（无解）
    // 冲突超过 SuggestLib.MAX_CONFLICTS 时不进入此状态机，面板直接提示超限；
    // 改选冲突、修改三方输入或 Schema 时立即置回 null
    suggestion: null,
    // 引用闭包子文档导出：冲突全部解决且输入未改动时，按勾选的顶层键计算
    // 本地 $ref 引用闭包并导出子文档；输入一改即清空并禁用，重新合并后恢复
    refSelection: new Set(), // 勾选的顶层键
    refClosure: null,        // RefLib.computeRefClosure 的最近结果
    lastSubdoc: '',          // 序列化后的子文档 JSON（下载用）
    // 删除影响预览：冲突全部解决且输入未改动时，勾选拟删除的顶层键即重算；
    // 列出因本地 $ref 直接或间接依赖这些键而受影响的其他顶层键与最短依赖链；
    // 输入一改即清空勾选与预览，重新合并后恢复
    delSelection: new Set(), // 拟删除的顶层键
    delResult: null,         // DelImpactLib.computeDeletionImpact 的最近结果
    lastResult: undefined,   // 本轮合并结果对象（引用闭包导出用）
    // 顶层键改名导出：冲突全部解决且输入未改动时，选一个顶层键并填写新键名
    // （可为空字符串），预览并下载改名后的完整 JSON，原合并结果不变；
    // 改选冲突或键名时重算，输入一改即清空并禁用，重新合并后恢复
    renKey: null,            // 选中的顶层键（旧键名）
    renName: '',             // 新键名（可为空字符串）
    renResult: null,         // RenLib.renameTopKey 的最近结果
    lastRenamed: '',         // 序列化后的改名 JSON（下载用）
    // 冲突选择记录（跨轮复用）：
    //  - 当前轮至少选过一个冲突且输入未改动时，可下载仅含已选冲突的记录；
    //  - 重新合并后导入记录先预览可复用 / 跳过条目，确认后一次应用；
    //  - 三方输入一旦编辑立即清空导入预览，重新合并后可再次导入
    lastChoices: '',         // 序列化后的记录 JSON（下载用）
    choiceImport: null,      // 导入预览：null | { status:'error', reason }
    //                        // | { status:'ready', entries, plan }
  };

  /* ---------- 输入解析与错误提示 ---------- */

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  // 从 JSON.parse 的报错中提取位置，换算为行/列，方便定位
  function formatJsonError(err, text) {
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

  function parseInputs() {
    const fields = [
      ['base', '基线（Base）'],
      ['mine', '我的版本（Mine）'],
      ['theirs', '对方版本（Theirs）'],
    ];
    const out = {};
    for (const [id, label] of fields) {
      const ta = els[id];
      ta.classList.remove('invalid');
      const text = ta.value;
      if (!text.trim()) {
        ta.classList.add('invalid');
        showError(`【${label}】内容为空，请粘贴 JSON 后再合并。`);
        return null;
      }
      try {
        out[id] = JSON.parse(text);
      } catch (err) {
        ta.classList.add('invalid');
        showError(`【${label}】JSON 无效：${formatJsonError(err, text)}`);
        return null;
      }
    }
    return out;
  }

  /* ---------- 展示辅助 ---------- */

  function fmtPath(path) {
    if (path.length === 0) return '$（根节点）';
    let s = '$';
    for (const k of path) {
      s += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']';
    }
    return s;
  }

  function fmtValue(v) {
    return v === MISSING ? '（缺失：该字段在此版本中不存在）' : JSON.stringify(v, null, 2);
  }

  function conflictHint(c) {
    if (c.mine === MISSING && c.theirs !== MISSING) return '删除与修改相撞：我的版本删除了该字段，对方版本修改了它';
    if (c.theirs === MISSING && c.mine !== MISSING) return '删除与修改相撞：对方版本删除了该字段，我的版本修改了它';
    return '双方以不同方式修改了该字段';
  }

  // 校验面板中显示的实例位置：JSON Pointer 原样展示（~ / 已按 RFC 6901 转义）
  function fmtPointer(pointer) {
    return pointer === '' ? '（根节点）' : pointer;
  }

  /* ---------- 合并与渲染 ---------- */

  function doMerge() {
    clearError();
    els.staleNote.hidden = true;
    const parsed = parseInputs();
    if (!parsed) {
      state.parsed = false;
      els.resultSection.hidden = true;
      renderSchemaPanel();
      return;
    }
    state.base = parsed.base;
    state.mine = parsed.mine;
    state.theirs = parsed.theirs;
    state.resolutions = new Map();
    state.stale = false;
    // 记录本组合并所用的三方文本：用于浏览器本地草稿的安全重放
    state.mergedInputs = { base: els.base.value, mine: els.mine.value, theirs: els.theirs.value };
    state.suggestion = null; // 新一轮合并：旧改选建议一并作废
    state.choiceImport = null; // 新一轮合并：上一轮导入预览随之作废（可重新导入）

    // 先用空选择跑一次，拿到全部冲突清单（冲突集合不随选择变化）
    const first = merge(state.base, state.mine, state.theirs, state.resolutions);
    state.allConflicts = first.conflicts;
    state.parsed = true;

    els.resultSection.hidden = false;
    render();
    scheduleDraftSave(); // 已完成一轮合并：立即把合并快照写入浏览器本地草稿
    els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render() {
    if (!state.parsed) return;
    const { result, stats } = merge(state.base, state.mine, state.theirs, state.resolutions);
    const total = state.allConflicts.length;
    const resolved = state.resolutions.size;
    const remaining = total - resolved;

    if (total === 0) {
      els.statusText.textContent = `无冲突：${stats.auto} 处改动已自动合入，可以导出。`;
    } else if (remaining === 0) {
      els.statusText.textContent = `共 ${total} 个冲突，已全部解决；另有 ${stats.auto} 处改动自动合入。可以导出。`;
    } else {
      els.statusText.textContent = `共 ${total} 个冲突：已解决 ${resolved} 个，剩余 ${remaining} 个待选择；另有 ${stats.auto} 处改动自动合入。`;
    }

    renderConflicts();

    state.lastJson = JSON.stringify(result, null, 2);
    state.lastResult = result;
    els.result.textContent = state.lastJson;

    if (remaining > 0) {
      els.resultNote.textContent = '注意：仍有未解决的冲突，结果中冲突位置暂以「我的版本」占位；全部解决后才能导出。';
    } else {
      els.resultNote.textContent = '';
    }

    const conflictsResolved = remaining === 0;

    // 归因清单：冲突全部解决且输入仍为本轮内容时，按基线 -> 最终结果生成；
    // 改选冲突走到这里会同步刷新；输入一旦被修改（stale）则保持清空
    if (conflictsResolved && !state.stale) {
      state.attribution = attribute(
        state.base, state.mine, state.theirs, result, state.allConflicts, state.resolutions,
      );
      state.lastAttribution = JSON.stringify(serializeEntries(state.attribution), null, 2);
    } else {
      state.attribution = [];
      state.lastAttribution = '';
    }

    // Schema 校验只在“冲突全部解决 + 输入为本轮合并内容”时进行；
    // 占位结果永不参与校验。
    if (state.schemaStatus === 'ready') {
      state.schemaBlocked = !conflictsResolved || state.stale;
      if (!state.schemaBlocked) {
        state.validationErrors = SchemaLib.validateData(state.validator, result);
      }
    }

    const schemaActive = state.schemaStatus !== '';
    const schemaGateOk = !schemaActive
      || (state.schemaStatus === 'ready' && !state.schemaBlocked && state.validationErrors === null);

    const canExport = conflictsResolved && schemaGateOk;
    els.exportBtn.disabled = !canExport;
    els.copyBtn.disabled = !canExport;
    // 补丁必须基于「本轮基线」：输入在合并后被修改时禁用，重新合并后恢复
    els.patchBtn.disabled = !canExport || state.stale;

    if (!conflictsResolved) {
      els.exportHint.textContent = `还有 ${remaining} 个冲突未解决，暂不能导出。`;
      state.lastPatch = '';
    } else if (state.schemaStatus === 'ready' && state.schemaBlocked) {
      els.exportHint.textContent = state.stale
        ? '三方输入已修改，旧校验结论已失效；请重新点击「开始合并」恢复校验。'
        : 'Schema 待校验：冲突解决后将自动校验。';
      state.lastPatch = '';
    } else if (state.schemaStatus === 'json-error') {
      els.exportHint.textContent = 'Schema 的 JSON 有语法错误，修复后才能导出。';
      state.lastPatch = '';
    } else if (state.schemaStatus === 'compile-error') {
      els.exportHint.textContent = 'Schema 编译未通过，修复后才能导出。';
      state.lastPatch = '';
    } else if (state.schemaStatus === 'compiling') {
      els.exportHint.textContent = 'Schema 正在编译，完成前暂不能导出。';
      state.lastPatch = '';
    } else if (state.schemaStatus === 'ready' && state.validationErrors !== null) {
      els.exportHint.textContent = `Schema 校验未通过：共 ${state.validationErrors.length} 处错误，全部修复后才能导出。`;
      state.lastPatch = '';
    } else {
      // 从本轮基线与合并结果生成 RFC 6902 操作数组；结果未变化时为空数组 []
      state.lastPatch = JSON.stringify(diffPatch(state.base, result), null, 2);
      els.exportHint.textContent = state.stale
        ? '输入内容已修改：完整结果仍可导出，重新合并后才能导出补丁。'
        : '';
    }

    renderSchemaPanel();
    renderAttribution();
    renderChoices();
    renderRefExport();
    renderDelImpact();
    renderRename();
  }

  function renderConflicts() {
    els.conflicts.innerHTML = '';
    if (state.allConflicts.length === 0) return;

    const title = document.createElement('h2');
    title.textContent = '冲突列表';
    els.conflicts.appendChild(title);

    state.allConflicts.forEach((c, i) => {
      els.conflicts.appendChild(renderConflictCard(c, i));
    });
  }

  function renderConflictCard(c, index) {
    const chosen = state.resolutions.get(c.key);

    const card = document.createElement('div');
    card.className = 'conflict-card' + (chosen ? ' resolved' : '');

    const head = document.createElement('div');
    head.className = 'conflict-head';
    const title = document.createElement('span');
    title.className = 'conflict-path';
    title.textContent = `冲突 ${index + 1}：${fmtPath(c.path)}`;
    const hint = document.createElement('span');
    hint.className = 'conflict-hint';
    hint.textContent = conflictHint(c);
    head.append(title, hint);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'conflict-values';
    const blocks = [
      ['基线', c.base, 'base'],
      ['我的版本', c.mine, 'mine'],
      ['对方版本', c.theirs, 'theirs'],
    ];
    for (const [label, value, cls] of blocks) {
      const box = document.createElement('div');
      box.className = `value-box ${cls}`;
      const h = document.createElement('div');
      h.className = 'value-label';
      h.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = fmtValue(value);
      if (value === MISSING) pre.classList.add('missing');
      box.append(h, pre);
      grid.appendChild(box);
    }
    card.appendChild(grid);

    const choices = document.createElement('div');
    choices.className = 'choices';
    for (const [val, text] of [['mine', '采用我的版本'], ['theirs', '采用对方版本']]) {
      const lab = document.createElement('label');
      lab.className = 'choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'conflict-' + index;
      radio.value = val;
      radio.checked = chosen === val;
      radio.addEventListener('change', () => {
        state.resolutions.set(c.key, val);
        // 改选冲突后旧改选建议立即失效；结果可能变化，render() 中会自动重新校验
        state.suggestion = null;
        // 手动改选后，未应用的导入预览立即作废（预览基于改选前的选择情况）
        state.choiceImport = null;
        render();
        scheduleDraftSave(); // 选边即自动保存进浏览器本地草稿
      });
      lab.append(radio, document.createTextNode(text));
      choices.appendChild(lab);
    }
    card.appendChild(choices);

    return card;
  }

  /* ---------- 变更归因清单 ---------- */

  const SOURCE_LABELS = {
    mine: '仅我',
    theirs: '仅对方',
    both: '双方同改',
    'conflict-mine': '冲突选我',
    'conflict-theirs': '冲突选对方',
  };
  const SOURCE_ORDER = ['mine', 'theirs', 'both', 'conflict-mine', 'conflict-theirs'];
  const OP_LABELS = { add: '新增', remove: '删除', replace: '替换' };

  function fmtAttrValue(v) {
    return v === MISSING ? '（缺失）' : JSON.stringify(v, null, 2);
  }

  // 来源筛选下拉：每次渲染按当前清单重建选项并带上数量
  function renderAttrFilterOptions() {
    const counts = {};
    for (const e of state.attribution) counts[e.source] = (counts[e.source] || 0) + 1;
    const options = [['all', `全部来源（${state.attribution.length}）`]];
    for (const s of SOURCE_ORDER) options.push([s, `${SOURCE_LABELS[s]}（${counts[s] || 0}）`]);

    const sel = els.attrFilter;
    sel.innerHTML = '';
    for (const [val, text] of options) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = options.some(([v]) => v === state.attrFilter) ? state.attrFilter : 'all';
    state.attrFilter = sel.value;
  }

  function renderAttribution() {
    if (!state.parsed) {
      els.attrSection.hidden = true;
      return;
    }
    els.attrSection.hidden = false;
    renderAttrFilterOptions();

    const remaining = state.allConflicts.length - state.resolutions.size;
    const ready = !state.stale && remaining === 0;
    els.attrBtn.disabled = !ready;

    els.attrList.innerHTML = '';
    if (state.stale) {
      els.attrNote.textContent = '三方输入已修改，归因清单已清空；重新点击「开始合并」后重新生成。';
      return;
    }
    if (remaining > 0) {
      els.attrNote.textContent = `还有 ${remaining} 个冲突未解决：全部解决后才会生成归因清单。`;
      return;
    }
    const total = state.attribution.length;
    if (total === 0) {
      els.attrNote.textContent = '基线与最终结果一致，没有任何改动。';
      return;
    }

    const filtered = state.attribution.filter(
      (e) => state.attrFilter === 'all' || e.source === state.attrFilter,
    );
    els.attrNote.textContent = state.attrFilter === 'all'
      ? `共 ${total} 处改动。`
      : `共 ${total} 处改动，当前筛选「${SOURCE_LABELS[state.attrFilter]}」，显示 ${filtered.length} 处。`;
    if (filtered.length === 0) return;

    const wrap = document.createElement('div');
    wrap.className = 'attr-table-wrap';
    const table = document.createElement('table');
    table.className = 'attr-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['路径', '改动', '基线值', '结果值', '来源']) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const e of filtered) tbody.appendChild(renderAttrRow(e));
    table.appendChild(tbody);
    wrap.appendChild(table);
    els.attrList.appendChild(wrap);
  }

  function renderAttrRow(e) {
    const tr = document.createElement('tr');

    const tdPath = document.createElement('td');
    const code = document.createElement('code');
    code.className = 'attr-pointer';
    code.textContent = fmtPointer(e.pointer);
    tdPath.appendChild(code);

    const tdOp = document.createElement('td');
    const op = document.createElement('span');
    op.className = 'attr-badge ' + e.op;
    op.textContent = OP_LABELS[e.op];
    tdOp.appendChild(op);

    const tdBase = document.createElement('td');
    tdBase.appendChild(attrValuePre(e.base));
    const tdResult = document.createElement('td');
    tdResult.appendChild(attrValuePre(e.result));

    const tdSource = document.createElement('td');
    const src = document.createElement('span');
    src.className = 'attr-badge ' + e.source;
    src.textContent = SOURCE_LABELS[e.source];
    tdSource.appendChild(src);

    tr.append(tdPath, tdOp, tdBase, tdResult, tdSource);
    return tr;
  }

  function attrValuePre(v) {
    const pre = document.createElement('pre');
    pre.className = 'attr-value' + (v === MISSING ? ' missing' : '');
    pre.textContent = fmtAttrValue(v);
    return pre;
  }

  /* ---------- 冲突选择记录（跨轮复用） ---------- */

  // 渲染记录区：下载门禁 + 导入预览（预览计划按当前选择情况即时重算，
  // 因此「已手动选择不覆盖」的判定始终基于最新选择）
  function renderChoices() {
    if (!state.parsed) {
      els.choiceSection.hidden = true;
      return;
    }
    els.choiceSection.hidden = false;
    els.choicePreview.innerHTML = '';
    els.choiceNote.classList.remove('choice-error');

    // 三方输入一改：立即清空导入预览并禁用导入，重新合并后恢复
    if (state.stale) {
      state.choiceImport = null;
      state.lastChoices = '';
      els.choiceBtn.disabled = true;
      els.choiceFile.disabled = true;
      els.choiceNote.textContent = '三方输入已修改，冲突选择记录已清空并禁用导入；重新点击「开始合并」后恢复。';
      return;
    }
    els.choiceFile.disabled = false;

    // 下载门禁：当前轮至少选过一个冲突（记录仅含已选冲突，不含完整输入）
    const chosen = state.resolutions.size;
    if (chosen > 0) {
      state.lastChoices = JSON.stringify(
        ChoicesLib.serializeChoices(state.allConflicts, state.resolutions), null, 2,
      );
      els.choiceBtn.disabled = false;
    } else {
      state.lastChoices = '';
      els.choiceBtn.disabled = true;
    }

    const imp = state.choiceImport;
    if (!imp) {
      els.choiceNote.textContent = chosen > 0
        ? `本轮已选 ${chosen} 个冲突：可下载仅含已选冲突的记录（路径、三方值与选边，不含完整输入）；也可导入此前的记录，预览后一次复用相同冲突的选边。`
        : '选择任意冲突后即可下载选择记录；重新合并后可导入此前的记录，先预览可复用与跳过的条目，确认后一次应用。';
      return;
    }
    if (imp.status === 'error') {
      els.choiceNote.textContent = '导入失败：' + imp.reason + '（整份记录被拒绝，未应用任何条目）';
      els.choiceNote.classList.add('choice-error');
      return;
    }

    // ready：按当前冲突与选择情况即时重算复用计划
    imp.plan = ChoicesLib.planReuse(imp.entries, state.allConflicts, state.resolutions);
    const plan = imp.plan;
    const total = imp.entries.length;
    els.choiceNote.textContent = `记录共 ${total} 条：可复用 ${plan.reusable.length} 条，跳过 ${plan.skipped.length} 条。仅当路径与基线 / 我的 / 对方三值和当前冲突完全一致时才复用；确认后一次应用全部可复用条目，不覆盖已手动选择的冲突。`;

    const box = document.createElement('div');
    box.className = 'choice-import';

    if (plan.reusable.length > 0) {
      const head = document.createElement('div');
      head.className = 'choice-group-title';
      head.textContent = `可复用（${plan.reusable.length}）`;
      box.appendChild(head);
      const list = document.createElement('ul');
      list.className = 'suggest-list';
      for (const r of plan.reusable) {
        const li = document.createElement('li');
        const path = document.createElement('code');
        path.className = 'suggest-path';
        path.textContent = fmtPath(r.path);
        const side = document.createElement('span');
        side.className = 'attr-badge ' + r.choice;
        side.textContent = SIDE_LABELS[r.choice];
        li.append(path, document.createTextNode(' → '), side);
        list.appendChild(li);
      }
      box.appendChild(list);
    }

    if (plan.skipped.length > 0) {
      const head = document.createElement('div');
      head.className = 'choice-group-title';
      head.textContent = `跳过（${plan.skipped.length}）`;
      box.appendChild(head);
      const list = document.createElement('ul');
      list.className = 'suggest-list';
      for (const s of plan.skipped) {
        const li = document.createElement('li');
        const path = document.createElement('code');
        path.className = 'suggest-path';
        path.textContent = fmtPath(s.path);
        const reason = document.createElement('span');
        reason.className = 'sv-reason';
        reason.textContent = s.reason;
        li.append(path, document.createTextNode(' '), reason);
        list.appendChild(li);
      }
      box.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'suggest-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'primary';
    apply.textContent = `确认应用（${plan.reusable.length} 条）`;
    apply.disabled = plan.reusable.length === 0;
    apply.addEventListener('click', applyChoiceImport);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => {
      state.choiceImport = null;
      renderChoices();
    });
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = plan.reusable.length === 0
      ? '没有可复用的条目，无需应用。'
      : '应用后自动重新合并、重新校验，并同步刷新归因清单与导出状态。';
    actions.append(apply, cancel, note);
    box.appendChild(actions);

    els.choicePreview.appendChild(box);
  }

  // 选择记录文件：解析 + 严格校验（任何格式错误都拒绝整份），通过后进入预览
  async function onChoiceFile() {
    const file = els.choiceFile.files && els.choiceFile.files[0];
    els.choiceFile.value = ''; // 允许再次选择同一文件
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      state.choiceImport = { status: 'error', reason: '无法读取所选文件，请重试。' };
      renderChoices();
      return;
    }
    const parsed = ChoicesLib.parseChoicesRecord(text);
    state.choiceImport = parsed.status === 'ok'
      ? { status: 'ready', entries: parsed.entries, plan: null }
      : { status: 'error', reason: parsed.reason };
    renderChoices();
  }

  // 确认一次应用全部可复用条目；render() 会重新合并、重新校验，
  // 并同步刷新归因清单与导出门禁
  function applyChoiceImport() {
    const imp = state.choiceImport;
    if (!imp || imp.status !== 'ready' || !imp.plan) return;
    ChoicesLib.applyReuse(state.resolutions, imp.plan.reusable);
    state.choiceImport = null;
    state.suggestion = null; // 选边变化：旧改选建议一并失效
    render();
    scheduleDraftSave();
  }

  /* ---------- 引用闭包子文档导出 ---------- */

  function hasKey(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 根结果不是对象时说明原因：给出当前结果的类型名
  function typeName(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '数组';
    const t = typeof v;
    if (t === 'string') return '字符串';
    if (t === 'number') return '数字';
    if (t === 'boolean') return '布尔值';
    return t;
  }

  function renderRefExport() {
    if (!state.parsed) {
      els.refSection.hidden = true;
      return;
    }
    els.refSection.hidden = false;
    els.refKeys.innerHTML = '';
    els.refErrors.innerHTML = '';
    els.refErrors.hidden = true;

    const remaining = state.allConflicts.length - state.resolutions.size;
    const result = state.lastResult;

    // 三方输入一改：立即清空勾选与闭包结果并禁用，重新合并后恢复
    if (state.stale) {
      state.refSelection.clear();
      state.refClosure = null;
      state.lastSubdoc = '';
      els.refBtn.disabled = true;
      els.refNote.textContent = '三方输入已修改，引用闭包导出已清空并禁用；重新点击「开始合并」后恢复。';
      return;
    }
    if (remaining > 0) {
      state.refClosure = null;
      state.lastSubdoc = '';
      els.refBtn.disabled = true;
      els.refNote.textContent = `还有 ${remaining} 个冲突未解决：全部解决后才能勾选顶层键导出子文档。`;
      return;
    }
    if (!RefLib.isPlainObject(result)) {
      // 根结果不是对象：说明原因，不提供勾选
      state.refSelection.clear();
      state.refClosure = null;
      state.lastSubdoc = '';
      els.refBtn.disabled = true;
      els.refNote.textContent = `合并结果不是对象（当前为${typeName(result)}），没有顶层键可勾选，无法导出引用闭包子文档。`;
      return;
    }

    // 改选冲突可能改变顶层键集合：剔除已不存在的勾选后重算闭包
    for (const k of Array.from(state.refSelection)) {
      if (!hasKey(result, k)) state.refSelection.delete(k);
    }

    const topKeys = Object.keys(result);
    if (topKeys.length === 0) {
      state.refClosure = null;
      state.lastSubdoc = '';
      els.refBtn.disabled = true;
      els.refNote.textContent = '合并结果是不含任何键的空对象，没有可导出的内容。';
      return;
    }

    state.refClosure = state.refSelection.size > 0
      ? RefLib.computeRefClosure(result, state.refSelection)
      : null;
    const closure = state.refClosure;
    state.lastSubdoc = closure && closure.status === 'ok'
      ? JSON.stringify(closure.doc, null, 2)
      : '';
    // 存在非法引用时绝不生成不完整子文档：下载保持禁用
    els.refBtn.disabled = !(closure && closure.status === 'ok');

    if (!closure) {
      els.refNote.textContent = `共 ${topKeys.length} 个顶层键；勾选至少一个后，自动递归纳入值内字符串 $ref 的本地引用依赖（闭包），再下载子文档。`;
    } else if (closure.status === 'errors') {
      els.refNote.textContent = `发现 ${closure.errors.length} 处非法引用，已禁用下载：不会生成不完整的子文档。`;
    } else {
      const auto = closure.keys.length - state.refSelection.size;
      els.refNote.textContent = auto > 0
        ? `已选 ${state.refSelection.size} 个键，闭包后共导出 ${closure.keys.length} 个（自动纳入 ${auto} 个依赖键，以「依赖纳入」徽标标示）。`
        : `已选 ${closure.keys.length} 个键，无额外引用依赖，可直接下载。`;
    }

    const deps = closure && closure.status === 'ok' ? new Set(closure.keys) : new Set();
    for (const k of topKeys) {
      els.refKeys.appendChild(renderRefKey(k, deps.has(k) && !state.refSelection.has(k)));
    }

    // 非法转义 / 缺失目标 / 外部引用：逐条列出所在路径
    if (closure && closure.status === 'errors') {
      els.refErrors.hidden = false;
      for (const e of closure.errors) {
        const li = document.createElement('li');
        const loc = document.createElement('code');
        loc.className = 'sv-pointer';
        loc.textContent = fmtPointer(e.pointer);
        const reason = document.createElement('span');
        reason.className = 'sv-reason';
        reason.textContent = e.reason;
        li.append(loc, document.createTextNode(' '), reason);
        els.refErrors.appendChild(li);
      }
    }
  }

  function renderRefKey(key, depIncluded) {
    const lab = document.createElement('label');
    lab.className = 'ref-key';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.refSelection.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) state.refSelection.add(key);
      else state.refSelection.delete(key);
      renderRefExport(); // 勾选变化即重算闭包
    });
    const code = document.createElement('code');
    code.className = 'ref-key-name';
    code.textContent = key;
    lab.append(cb, code);
    if (depIncluded) {
      const badge = document.createElement('span');
      badge.className = 'attr-badge ref-dep';
      badge.textContent = '依赖纳入';
      lab.appendChild(badge);
    }
    return lab;
  }

  /* ---------- 删除影响预览 ---------- */

  function renderDelImpact() {
    if (!state.parsed) {
      els.delSection.hidden = true;
      return;
    }
    els.delSection.hidden = false;
    els.delKeys.innerHTML = '';
    els.delErrors.innerHTML = '';
    els.delErrors.hidden = true;
    els.delImpact.innerHTML = '';

    const remaining = state.allConflicts.length - state.resolutions.size;
    const result = state.lastResult;

    // 三方输入一改：立即清空勾选与预览，重新合并后恢复
    if (state.stale) {
      state.delSelection.clear();
      state.delResult = null;
      els.delNote.textContent = '三方输入已修改，删除影响预览已清空；重新点击「开始合并」后恢复。';
      return;
    }
    if (remaining > 0) {
      state.delResult = null;
      els.delNote.textContent = `还有 ${remaining} 个冲突未解决：全部解决后才能勾选拟删除的顶层键并预览影响。`;
      return;
    }
    if (!DelImpactLib.isPlainObject(result)) {
      // 根结果不是对象（数组 / 标量）：无法预览，不提供勾选
      state.delSelection.clear();
      state.delResult = null;
      els.delNote.textContent = `合并结果不是对象（当前为${typeName(result)}），没有顶层键可勾选，无法预览删除影响。`;
      return;
    }

    // 改选冲突可能改变顶层键集合：剔除已不存在的勾选后即时重算
    for (const k of Array.from(state.delSelection)) {
      if (!hasKey(result, k)) state.delSelection.delete(k);
    }

    const topKeys = Object.keys(result);
    if (topKeys.length === 0) {
      state.delResult = null;
      els.delNote.textContent = '合并结果是不含任何键的空对象，没有可删除的顶层键。';
      return;
    }

    state.delResult = state.delSelection.size > 0
      ? DelImpactLib.computeDeletionImpact(result, state.delSelection)
      : null;
    const impact = state.delResult;

    // 受影响键集合（用于在勾选列表中打「受影响」徽标）
    const affectedSet = new Set();
    if (impact && impact.status === 'ok') {
      for (const a of impact.affected) affectedSet.add(a.key);
    }
    for (const k of topKeys) {
      els.delKeys.appendChild(renderDelKey(k, affectedSet.has(k)));
    }

    if (!impact) {
      els.delNote.textContent = `共 ${topKeys.length} 个顶层键；勾选拟删除的键后，立即列出因本地 $ref 直接或间接依赖它们而受影响的其他顶层键，并给出一条最短依赖链（受影响键 → … → 拟删键）。`;
      return;
    }

    // 非法、缺失或外部引用：单独提示原路径，不计入删除影响（不产生依赖边）
    if (impact.errors.length > 0) {
      els.delErrors.hidden = false;
      for (const e of impact.errors) {
        const li = document.createElement('li');
        const loc = document.createElement('code');
        loc.className = 'sv-pointer';
        loc.textContent = fmtPointer(e.pointer);
        const reason = document.createElement('span');
        reason.className = 'sv-reason';
        reason.textContent = e.reason + '（该引用不计入删除影响）';
        li.append(loc, document.createTextNode(' '), reason);
        els.delErrors.appendChild(li);
      }
    }

    if (impact.affected.length === 0) {
      els.delNote.textContent = `拟删除 ${impact.deleting.length} 个顶层键：${formatKeyList(impact.deleting)}；没有其他顶层键经本地 $ref 依赖它们，删除不会产生引用断链。`;
      return;
    }

    els.delNote.textContent = `拟删除 ${impact.deleting.length} 个顶层键：${formatKeyList(impact.deleting)}；以下 ${impact.affected.length} 个其他顶层键经本地 $ref 直接或间接依赖拟删键，删除后其引用将断链。每条给出一条最短依赖链，多条等长链取按顶层键序比较字典序最小者。`;
    els.delImpact.appendChild(renderDelImpactTable(impact));
  }

  function renderDelKey(key, affected) {
    const lab = document.createElement('label');
    lab.className = 'ref-key';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.delSelection.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) state.delSelection.add(key);
      else state.delSelection.delete(key);
      renderDelImpact(); // 勾选或改选即即时重算
    });
    const code = document.createElement('code');
    code.className = 'ref-key-name';
    code.textContent = key;
    lab.append(cb, code);
    if (cb.checked) {
      const badge = document.createElement('span');
      badge.className = 'attr-badge remove';
      badge.textContent = '拟删除';
      lab.appendChild(badge);
    } else if (affected) {
      const badge = document.createElement('span');
      badge.className = 'attr-badge ref-dep';
      badge.textContent = '受影响';
      lab.appendChild(badge);
    }
    return lab;
  }

  function formatKeyList(keys) {
    return keys.map((k) => '「' + k + '」').join('、');
  }

  // 依赖链：受影响键 -> … -> 拟删键（链尾用红色徽标标示拟删键）
  function renderDelChain(chain) {
    const wrap = document.createElement('span');
    wrap.className = 'del-chain';
    chain.forEach((k, i) => {
      if (i > 0) wrap.appendChild(document.createTextNode(' → '));
      const code = document.createElement('code');
      code.className = 'ref-key-name' + (i === chain.length - 1 ? ' del-target' : '');
      code.textContent = k;
      wrap.appendChild(code);
    });
    return wrap;
  }

  function renderDelImpactTable(impact) {
    const wrap = document.createElement('div');
    wrap.className = 'attr-table-wrap';
    const table = document.createElement('table');
    table.className = 'attr-table del-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const text of ['受影响顶层键', '最短依赖链（受影响键 → … → 拟删键）']) {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const a of impact.affected) {
      const tr = document.createElement('tr');
      const tdKey = document.createElement('td');
      const code = document.createElement('code');
      code.className = 'attr-pointer';
      code.textContent = a.key;
      tdKey.appendChild(code);
      const tdChain = document.createElement('td');
      tdChain.appendChild(renderDelChain(a.chain));
      tr.append(tdKey, tdChain);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /* ---------- 顶层键改名导出 ---------- */

  // 重建顶层键下拉选项；state.renKey 仍存在时保持选中（键名经 dataset 传递，
  // 空字符串键也能与「未选择」区分）
  function rebuildRenKeyOptions(topKeys) {
    const sel = els.renKey;
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '（请选择顶层键）';
    sel.appendChild(placeholder);
    let selectedIdx = 0;
    topKeys.forEach((k, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1);
      opt.dataset.key = k;
      opt.textContent = k === '' ? '""（空字符串键）' : k;
      sel.appendChild(opt);
      if (state.renKey !== null && k === state.renKey) selectedIdx = i + 1;
    });
    sel.selectedIndex = selectedIdx;
  }

  function setRenameControlsDisabled(disabled) {
    els.renKey.disabled = disabled;
    els.renName.disabled = disabled;
  }

  function resetRenameState() {
    state.renKey = null;
    state.renName = '';
    els.renName.value = '';
    state.renResult = null;
    state.lastRenamed = '';
  }

  function renderRename() {
    if (!state.parsed) {
      els.renSection.hidden = true;
      return;
    }
    els.renSection.hidden = false;
    els.renErrors.innerHTML = '';
    els.renErrors.hidden = true;
    els.renPreview.hidden = true;
    els.renPreview.textContent = '';
    els.renNote.classList.remove('ren-error');

    const remaining = state.allConflicts.length - state.resolutions.size;
    const result = state.lastResult;

    // 三方输入一改：立即清空选择、键名与预览并禁用，重新合并后恢复
    if (state.stale) {
      resetRenameState();
      rebuildRenKeyOptions([]);
      setRenameControlsDisabled(true);
      els.renBtn.disabled = true;
      els.renNote.textContent = '三方输入已修改，顶层键改名导出已清空并禁用；重新点击「开始合并」后恢复。';
      return;
    }
    if (remaining > 0) {
      state.renResult = null;
      state.lastRenamed = '';
      rebuildRenKeyOptions([]);
      setRenameControlsDisabled(true);
      els.renBtn.disabled = true;
      els.renNote.textContent = `还有 ${remaining} 个冲突未解决：全部解决后才能选择顶层键改名导出。`;
      return;
    }
    if (!RenLib.isPlainObject(result)) {
      // 根结果不是对象：没有顶层键可改名
      resetRenameState();
      rebuildRenKeyOptions([]);
      setRenameControlsDisabled(true);
      els.renBtn.disabled = true;
      els.renNote.textContent = `合并结果不是对象（当前为${typeName(result)}），没有顶层键可改名。`;
      return;
    }

    // 改选冲突可能改变顶层键集合：旧键名已不存在时清空选择
    if (state.renKey !== null && !hasKey(result, state.renKey)) {
      state.renKey = null;
    }

    const topKeys = Object.keys(result);
    if (topKeys.length === 0) {
      state.renResult = null;
      state.lastRenamed = '';
      rebuildRenKeyOptions([]);
      setRenameControlsDisabled(true);
      els.renBtn.disabled = true;
      els.renNote.textContent = '合并结果是不含任何键的空对象，没有可改名的顶层键。';
      return;
    }

    setRenameControlsDisabled(false);
    rebuildRenKeyOptions(topKeys);

    if (state.renKey === null) {
      state.renResult = null;
      state.lastRenamed = '';
      els.renBtn.disabled = true;
      els.renNote.textContent = `共 ${topKeys.length} 个顶层键；选择一个键并填写新键名（可为空字符串），即可预览并下载改名后的完整 JSON，原合并结果不变。`;
      return;
    }

    // 改选冲突或修改键名后走到这里：按当前结果与键名即时重算
    const out = RenLib.renameTopKey(result, state.renKey, state.renName);
    state.renResult = out;

    if (out.status === 'ok') {
      state.lastRenamed = JSON.stringify(out.doc, null, 2);
      els.renBtn.disabled = false;
      els.renPreview.hidden = false;
      els.renPreview.textContent = state.lastRenamed;
      els.renNote.textContent = out.refs.length > 0
        ? `已将「${state.renKey}」改名为「${state.renName}」，并同步改写 ${out.refs.length} 处指向旧键名的 $ref；原合并结果不变。`
        : `已将「${state.renKey}」改名为「${state.renName}」；没有指向旧键名的 $ref 需要改写，原合并结果不变。`;
      return;
    }

    state.lastRenamed = '';
    els.renBtn.disabled = true;
    if (out.status === 'same') {
      els.renNote.textContent = '新键名与原键名相同，无变化。';
    } else if (out.status === 'conflict') {
      // 与其他已有键重名：报错并禁止下载
      els.renNote.classList.add('ren-error');
      els.renNote.textContent = `新键名「${state.renName}」与已有顶层键重名，请更换新键名。`;
    } else if (out.status === 'errors') {
      // 非法转义 / 缺失目标 / 外部引用：逐条列出所在原路径并禁用下载
      els.renNote.classList.add('ren-error');
      els.renNote.textContent = `发现 ${out.errors.length} 处非法引用，已禁用下载：不会导出引用断链的文档。`;
      els.renErrors.hidden = false;
      for (const e of out.errors) {
        const li = document.createElement('li');
        const loc = document.createElement('code');
        loc.className = 'sv-pointer';
        loc.textContent = fmtPointer(e.pointer);
        const reason = document.createElement('span');
        reason.className = 'sv-reason';
        reason.textContent = e.reason;
        li.append(loc, document.createTextNode(' '), reason);
        els.renErrors.appendChild(li);
      }
    }
  }

  /* ---------- Schema 面板渲染 ---------- */

  function renderSchemaPanel() {
    const box = els.schemaValidation;
    box.innerHTML = '';

    // 未填写 Schema：整个面板隐藏，沿用原有规则
    if (state.schemaStatus === '') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = 'schema-validation';

    const head = document.createElement('div');
    head.className = 'sv-head';
    const title = document.createElement('span');
    title.className = 'sv-title';
    const badge = document.createElement('span');
    badge.className = 'sv-badge';

    function setHead(text, cls) {
      title.textContent = 'Schema 校验';
      badge.textContent = text;
      badge.className = 'sv-badge ' + cls;
      head.append(title, badge);
      box.appendChild(head);
    }

    if (state.schemaStatus === 'json-error') {
      setHead('Schema JSON 语法错误', 'fail');
      box.classList.add('fail');
      const p = document.createElement('div');
      p.className = 'sv-message';
      p.textContent = state.schemaError;
      box.appendChild(p);
      return;
    }

    if (state.schemaStatus === 'compiling') {
      setHead('编译中…', 'pending');
      box.classList.add('pending');
      const p = document.createElement('div');
      p.className = 'sv-message';
      p.textContent = '正在本地编译 Schema（不访问网络）…';
      box.appendChild(p);
      return;
    }

    if (state.schemaStatus === 'compile-error') {
      setHead('Schema 编译错误', 'fail');
      box.classList.add('fail');
      const p = document.createElement('div');
      p.className = 'sv-message';
      p.textContent = state.schemaError;
      box.appendChild(p);
      return;
    }

    // ready：尚未合并 / 占位结果 / 输入已改动 时只显示“待校验”，绝不校验占位结果
    const waiting = !state.parsed || state.schemaBlocked;
    if (waiting) {
      let why;
      if (!state.parsed) {
        why = '待校验：请先点击「开始合并」，冲突全部解决后将自动校验合并结果。';
      } else if (state.stale) {
        why = '三方输入已修改，旧校验结论已失效；请重新点击「开始合并」后再校验。';
      } else {
        why = '待校验：尚有冲突未解决，占位结果不参与校验，全部解决后自动校验。';
      }
      setHead('待校验', 'pending');
      box.classList.add('pending');
      const p = document.createElement('div');
      p.className = 'sv-message';
      p.textContent = why;
      box.appendChild(p);
      return;
    }

    if (state.validationErrors === null) {
      setHead('通过', 'ok');
      box.classList.add('ok');
      const p = document.createElement('div');
      p.className = 'sv-message';
      p.textContent = '合并结果符合 Schema，可以导出。';
      box.appendChild(p);
      return;
    }

    setHead(`未通过（${state.validationErrors.length} 处错误）`, 'fail');
    box.classList.add('fail');

    // 全部错误逐条列出：实例 JSON Pointer、关键字、原因
    const list = document.createElement('ul');
    list.className = 'sv-errors';
    for (const e of state.validationErrors) {
      const li = document.createElement('li');
      const loc = document.createElement('code');
      loc.className = 'sv-pointer';
      loc.textContent = fmtPointer(e.pointer);
      const kw = document.createElement('span');
      kw.className = 'sv-keyword';
      kw.textContent = e.keyword;
      const reason = document.createElement('span');
      reason.className = 'sv-reason';
      reason.textContent = e.reason;
      li.append(loc, document.createTextNode(' '), kw, document.createTextNode('：'), reason);
      list.appendChild(li);
    }
    box.appendChild(list);

    // 校验失败时提供「最少改选建议」：搜索 / 展示 / 应用都在此区域内完成
    box.appendChild(renderSuggestArea());
  }

  /* ---------- 最少改选建议 ---------- */

  const SIDE_LABELS = { mine: '我的版本', theirs: '对方版本' };

  // 校验失败面板内的建议区：按当前状态渲染 搜索入口 / 超限提示 / 搜索中 / 结果
  function renderSuggestArea() {
    const wrap = document.createElement('div');
    wrap.className = 'suggest-area';

    const head = document.createElement('div');
    head.className = 'suggest-head';
    const title = document.createElement('span');
    title.className = 'suggest-title';
    title.textContent = '最少改选建议';
    head.appendChild(title);
    wrap.appendChild(head);

    const msg = (text) => {
      const p = document.createElement('div');
      p.className = 'suggest-message';
      p.textContent = text;
      wrap.appendChild(p);
    };

    const total = state.allConflicts.length;
    const max = SuggestLib.MAX_CONFLICTS;

    if (total === 0) {
      msg('没有可调整的冲突：校验失败来自自动合入的内容，仅改选无法修复，请检查三方输入或 Schema。');
      return wrap;
    }
    if (total > max) {
      // 超限：只提示，不搜索、不声称无解
      msg(`共 ${total} 个冲突，超过 ${max} 个上限，不提供改选搜索；请手动调整选边后重新校验。`);
      return wrap;
    }

    const s = state.suggestion;
    if (s && s.status === 'searching') {
      msg(`正在搜索改选组合（至多 ${(2 ** total) - 1} 种）…`);
      return wrap;
    }
    if (s && s.status === 'none') {
      msg(`已穷尽全部 ${s.attempts} 种改选组合，仍无法通过 Schema 校验：仅翻转现有 ${total} 个冲突的选边得不到合法结果，请检查三方输入或调整 Schema。`);
      return wrap;
    }
    if (s && s.status === 'found') {
      msg(`找到最少改选方案：改选 ${s.flips.length} 处即可通过校验（按翻转个数从少到多搜索，共尝试 ${s.attempts} 种组合）。`);
      const list = document.createElement('ul');
      list.className = 'suggest-list';
      for (const f of s.flips) {
        const li = document.createElement('li');
        const path = document.createElement('code');
        path.className = 'suggest-path';
        path.textContent = `冲突 ${f.index + 1}：${fmtPath(f.path)}`;
        const from = document.createElement('span');
        from.className = 'attr-badge ' + f.from;
        from.textContent = SIDE_LABELS[f.from];
        const to = document.createElement('span');
        to.className = 'attr-badge ' + f.to;
        to.textContent = SIDE_LABELS[f.to];
        li.append(path, document.createTextNode(' '), from, document.createTextNode(' → '), to);
        list.appendChild(li);
      }
      wrap.appendChild(list);
      const actions = document.createElement('div');
      actions.className = 'suggest-actions';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'primary';
      apply.textContent = '应用全部建议';
      apply.addEventListener('click', applySuggestion);
      const note = document.createElement('span');
      note.className = 'hint';
      note.textContent = '一次应用全部改选，随后自动重新合并、重新校验并刷新归因清单与导出状态。';
      actions.append(apply, note);
      wrap.appendChild(actions);
      return wrap;
    }

    // 尚未搜索：给出入口与规则说明
    const actions = document.createElement('div');
    actions.className = 'suggest-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'minor';
    btn.textContent = '搜索最少改选建议';
    btn.addEventListener('click', runSuggestionSearch);
    actions.appendChild(btn);
    wrap.appendChild(actions);
    msg(`以当前选边为起点，只翻转 ${total} 个已有冲突的「我的 / 对方」选择，按翻转个数从少到多枚举（至多 ${(2 ** total) - 1} 种组合），寻找首个通过 Schema 校验的改选方案。`);
    return wrap;
  }

  function runSuggestionSearch() {
    // 按钮只在“校验失败且未被阻塞”时渲染，这里再兜底一次
    if (state.schemaStatus !== 'ready' || state.schemaBlocked || state.validationErrors === null) return;
    if (state.allConflicts.length > SuggestLib.MAX_CONFLICTS) return;
    state.suggestion = { status: 'searching' };
    renderSchemaPanel();
    // 先让「搜索中」绘制出来，再同步执行搜索（组合数有界：至多 2^10 - 1）
    setTimeout(() => {
      // 等待期间若用户改了选边 / 输入 / Schema，建议已被清除，直接放弃
      if (!state.suggestion || state.suggestion.status !== 'searching') return;
      const outcome = SuggestLib.suggestMinimalFlips({
        base: state.base,
        mine: state.mine,
        theirs: state.theirs,
        conflicts: state.allConflicts,
        resolutions: state.resolutions,
        validate: state.validator,
      });
      // too-many 由渲染层按冲突数直接提示，不会走到这里
      state.suggestion = outcome.status === 'too-many' ? null : outcome;
      renderSchemaPanel();
    }, 30);
  }

  function applySuggestion() {
    const s = state.suggestion;
    if (!s || s.status !== 'found') return;
    // 一次应用全部改选；render() 会重新合并、重新校验，
    // 并同步刷新归因清单与导出门禁
    for (const f of s.flips) state.resolutions.set(f.key, f.to);
    state.suggestion = null;
    state.choiceImport = null; // 批量改选后未应用的导入预览同样作废
    render();
    scheduleDraftSave();
  }

  /* ---------- Schema 输入处理 ---------- */

  // 读取 Schema 文本框并把状态机推进到 compiling（或 json-error / ''）。
  // render() 内部会调用 renderSchemaPanel，故已合并时只调 render() 一处。
  function syncSchemaFromInput() {
    const text = els.schemaInput.value;
    // Schema 一旦变化（含清空），旧改选建议立即失效
    state.suggestion = null;
    if (!text.trim()) {
      state.schemaStatus = '';
      state.schemaError = '';
      state.validator = null;
      state.validationErrors = null;
      state.schemaBlocked = false;
      if (state.parsed) render();
      else renderSchemaPanel();
      return;
    }
    let schemaObj;
    try {
      schemaObj = JSON.parse(text);
    } catch (err) {
      // 第一类错误：Schema 自身的 JSON 语法错误
      state.schemaStatus = 'json-error';
      state.schemaError = 'Schema 的 JSON 语法错误：' + formatJsonError(err, text);
      state.validator = null;
      state.validationErrors = null;
      state.schemaBlocked = false;
      els.schemaInput.classList.add('invalid');
      if (state.parsed) render();
      else renderSchemaPanel();
      return;
    }
    els.schemaInput.classList.remove('invalid');

    const token = ++state.compileToken;
    state.schemaStatus = 'compiling';
    state.schemaError = '';
    state.validator = null;
    state.validationErrors = null;
    state.schemaBlocked = false;
    if (state.parsed) render();
    else renderSchemaPanel();

    SchemaLib.compileSchema(schemaObj).then(
      ({ validate }) => {
        if (token !== state.compileToken) return; // 已被更新的编辑取代
        state.schemaStatus = 'ready';
        state.validator = validate;
        if (state.parsed) render();
        else renderSchemaPanel();
      },
      (err) => {
        if (token !== state.compileToken) return;
        // 第二类错误：JSON 合法但 Ajv 编译失败
        state.schemaStatus = 'compile-error';
        state.schemaError = err && err.message ? err.message : String(err);
        if (state.parsed) render();
        else renderSchemaPanel();
      },
    );
  }

  let schemaInputTimer = null;
  function onSchemaInput() {
    els.schemaInput.classList.remove('invalid');
    // Schema 正在编辑：不等防抖结束，立即撤下旧改选建议
    if (state.suggestion) {
      state.suggestion = null;
      renderSchemaPanel();
    }
    // 输入即时反馈但稍作防抖，避免每次击键都重新编译
    clearTimeout(schemaInputTimer);
    schemaInputTimer = setTimeout(syncSchemaFromInput, 300);
    scheduleDraftSave(); // 可选 Schema 也是草稿的一部分
  }

  /* ---------- 导出 ---------- */

  function downloadResult() {
    download(state.lastJson, 'merged.json');
  }

  function downloadPatch() {
    download(state.lastPatch, 'patch.json');
  }

  function downloadAttribution() {
    download(state.lastAttribution, 'attribution.json');
  }

  function downloadRefExport() {
    download(state.lastSubdoc, 'subdoc.json');
  }

  function downloadRename() {
    download(state.lastRenamed, 'renamed.json');
  }

  function downloadChoices() {
    download(state.lastChoices, 'choices.json');
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(state.lastJson);
      els.exportHint.textContent = '已复制到剪贴板。';
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时退化为选中文本
      const range = document.createRange();
      range.selectNodeContents(els.result);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      els.exportHint.textContent = '已选中结果文本，请按 Ctrl+C 复制。';
    }
  }

  /* ---------- 示例与清空 ---------- */

  const SAMPLE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      port: { type: 'integer', minimum: 1, maximum: 65535 },
    },
    type: 'object',
    additionalProperties: false,
    required: ['name', 'version', 'config', 'tags'],
    properties: {
      name: { type: 'string', minLength: 1 },
      version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
      config: {
        type: 'object',
        additionalProperties: false,
        required: ['port', 'host'],
        properties: {
          port: { $ref: '#/$defs/port' },
          host: { type: 'string', minLength: 1 },
          debug: { type: 'boolean' },
        },
      },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      description: { type: 'string' },
      deprecated: { type: ['string', 'null'] },
      owner: { type: 'string' },
      license: { type: 'string' },
    },
  };

  function fillSample() {
    els.base.value = JSON.stringify({
      name: 'demo-app',
      version: '1.0.0',
      config: { port: 3000, host: '0.0.0.0', debug: false },
      tags: ['a', 'b'],
      description: '示例应用',
      deprecated: null,
      owner: 'team-a',
    }, null, 2);
    els.mine.value = JSON.stringify({
      name: 'demo-app',
      version: '1.1.0',
      config: { port: 8080, host: '0.0.0.0', debug: false },
      tags: ['a', 'b', 'c'],
      deprecated: null,
      owner: 'team-a',
      license: 'MIT',
    }, null, 2);
    els.theirs.value = JSON.stringify({
      name: 'demo-app',
      version: '1.1.0',
      config: { port: 9090, host: '0.0.0.0', debug: true },
      tags: ['a', 'b', 'c'],
      description: '示例应用 v2',
      owner: 'team-a',
    }, null, 2);
    markStale();
    scheduleDraftSave(); // 「填入示例」改写三方输入：草稿同步为最新编辑文本
  }

  function fillSampleSchema() {
    els.schemaSection.open = true;
    els.schemaInput.value = JSON.stringify(SAMPLE_SCHEMA, null, 2);
    els.schemaInput.classList.remove('invalid');
    syncSchemaFromInput();
  }

  function clearAll() {
    els.base.value = '';
    els.mine.value = '';
    els.theirs.value = '';
    els.schemaInput.value = '';
    els.schemaInput.classList.remove('invalid');
    state.parsed = false;
    state.resolutions = new Map();
    state.allConflicts = [];
    state.mergedInputs = null;
    state.lastPatch = '';
    state.attribution = [];
    state.lastAttribution = '';
    state.attrFilter = 'all';
    state.stale = false;
    state.schemaStatus = '';
    state.schemaError = '';
    state.validator = null;
    state.validationErrors = null;
    state.schemaBlocked = false;
    state.compileToken++;
    state.suggestion = null;
    state.refSelection = new Set();
    state.refClosure = null;
    state.lastSubdoc = '';
    state.delSelection = new Set();
    state.delResult = null;
    state.lastResult = undefined;
    state.lastChoices = '';
    state.choiceImport = null;
    resetRenameState();
    rebuildRenKeyOptions([]);
    clearError();
    els.staleNote.hidden = true;
    els.resultSection.hidden = true;
    // 「清空」即用户主动放弃：删除浏览器本地草稿与所有草稿提示
    clearDraftFromStorage();
    hideDraftBar();
    renderSchemaPanel();
    renderAttribution();
    renderChoices();
    renderRefExport();
    renderDelImpact();
    renderRename();
    for (const ta of [els.base, els.mine, els.theirs]) ta.classList.remove('invalid');
  }

  function markStale() {
    if (!state.parsed) return;
    state.stale = true;
    els.staleNote.hidden = false;
    // 输入偏离最近一次合并所用文本：草稿仍持续保存编辑文本，但不再覆盖合并快照，
    // 下次恢复时只能恢复文本、要求重新合并
    scheduleDraftSave();
    // 归因清单基于本轮基线与结果：输入一改即失效，立即清空
    state.attribution = [];
    state.lastAttribution = '';
    // 三方输入一改，旧改选建议同样立即失效
    state.suggestion = null;
    renderAttribution();
    // 引用闭包导出基于本轮合并结果：输入一改即清空勾选并禁用，
    // 重新点击「开始合并」后由 render() 恢复
    renderRefExport();
    // 删除影响预览同样基于本轮合并结果：输入一改即清空勾选与预览，
    // 重新点击「开始合并」后恢复
    renderDelImpact();
    // 顶层键改名导出同样基于本轮合并结果：输入一改即清空选择、键名与预览
    // 并禁用，重新点击「开始合并」后恢复
    renderRename();
    // 冲突选择记录：三方输入一改即清空导入预览并禁用下载 / 导入，
    // 重新点击「开始合并」后恢复
    state.choiceImport = null;
    renderChoices();
    // 输入已偏离本轮基线：补丁若导出将无法在相同基线上重放，立即禁用；
    // 同时使任何已有的 Schema 校验结论失效（结果文本随后也不再更新）。
    els.patchBtn.disabled = true;
    if (state.schemaStatus === 'ready') {
      // 有 Schema：旧的“通过/失败”结论都可能不再成立，立即收回导出/复制，
      // 面板提示重新合并；重新点击「开始合并」后由 render() 恢复。
      state.schemaBlocked = true;
      state.validationErrors = null;
      els.exportBtn.disabled = true;
      els.copyBtn.disabled = true;
      els.exportHint.textContent = '三方输入已修改，旧校验结论已失效；请重新点击「开始合并」。';
      renderSchemaPanel();
    } else if (state.schemaStatus === '') {
      // 无 Schema：沿用原有规则——完整结果与复制仍可用，仅补丁需重新合并
      els.exportBtn.disabled = false;
      els.copyBtn.disabled = false;
      els.exportHint.textContent = '输入内容已修改：完整结果仍可导出，重新合并后才能导出补丁。';
    }
    // json-error / compile-error / compiling：按钮在 render() 中已因
    // Schema 状态禁用，这里保持禁用即可。
  }

  /* ---------- 浏览器本地「合并草稿」（localStorage，仅存于当前浏览器） ---------- */
  /*
   * 草稿内容：三方输入、可选 Schema、最近一次合并所用三方文本（state.mergedInputs）、
   * 本轮已选冲突（state.resolutions，仅已选条目）与当时的合并结果文本。
   * 编辑输入 / Schema、选边、应用导入或改选建议后防抖自动保存；pagehide 前再同步落盘。
   * 刷新或重开页面时弹出「恢复 / 丢弃」提示；恢复时由 DraftLib.replaySnapshot
   * 重新解析、重新合并并逐项校验，不通过则只恢复文本，旧结果与旧校验绝不放行。
   */

  let storage = null;        // localStorage 引用；浏览器拒绝存储时为 null
  let storageError = '';     // 最近一次存储被拒绝的中文原因（'' 表示正常）
  let storageWarned = false; // 失败提示只显示一次，直到下次成功写入
  let draftTimer = null;     // 自动保存防抖
  let pendingDraft = null;   // 打开页面时检测到、等待用户「恢复 / 丢弃」的草稿

  function describeStorageError(err) {
    const name = err && err.name ? err.name : '';
    if (name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || (err && err.code === 22)) {
      return '浏览器本地存储已满（配额超限）：草稿未能写入。可清理浏览器存储后重试；正常合并功能不受影响。';
    }
    return '浏览器拒绝了本地存储（可能处于隐私 / 无痕模式，或该站点的存储被禁用）：草稿本次不会保存，但合并功能可正常使用。';
  }

  // 懒取 localStorage 并做一次最小读写探测（部分隐私模式能取到对象但写入即抛异常）
  function getStorage() {
    if (storage !== null) return storage;
    try {
      storage = window.localStorage;
      const probe = '__json_merge_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
    } catch (err) {
      storage = null;
      storageError = describeStorageError(err);
    }
    return storage;
  }

  function currentInputsText() {
    return { base: els.base.value, mine: els.mine.value, theirs: els.theirs.value };
  }

  function isEmptyInputs(t) {
    return t.base.trim() === '' && t.mine.trim() === '' && t.theirs.trim() === '';
  }

  // 合并后输入再改（stale）也保留旧合并快照：恢复时由 DraftLib 发现
  // 「当前文本 ≠ 合并文本」，从而只恢复文本、要求重新合并
  function buildCurrentDraft() {
    const mergeSpec = (state.parsed && state.mergedInputs)
      ? {
        inputs: state.mergedInputs,
        conflicts: state.allConflicts,
        resolutions: state.resolutions,
        mergedText: state.lastJson,
      }
      : null;
    return DraftLib.buildDraft({
      inputs: currentInputsText(),
      schema: els.schemaInput.value,
      merge: mergeSpec,
    });
  }

  function persistDraft() {
    const ls = getStorage();
    if (!ls) {
      showStorageNotice(storageError);
      return;
    }
    // 未合并且三方与 Schema 全空：不写空草稿（已有则清掉）
    if (!state.parsed && isEmptyInputs(currentInputsText()) && !els.schemaInput.value.trim()) {
      try { ls.removeItem(DraftLib.STORAGE_KEY); } catch { /* 忽略 */ }
      return;
    }
    try {
      ls.setItem(DraftLib.STORAGE_KEY, JSON.stringify(buildCurrentDraft()));
      storageError = '';
      storageWarned = false;
    } catch (err) {
      showStorageNotice(describeStorageError(err));
    }
  }

  function scheduleDraftSave() {
    // 用户在「恢复 / 丢弃」提示下直接开始编辑：视为放弃本次恢复询问，
    // 新编辑随后会作为新草稿保存
    if (pendingDraft) {
      pendingDraft = null;
      hideDraftBar();
    }
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 300);
  }

  // 页面隐藏 / 关闭前同步落盘一次（防抖可能还没触发）
  function flushDraft() {
    // 用户尚未对恢复提示做选择：页面输入框仍是空的，绝不能用空内容覆盖 / 删除草稿
    if (pendingDraft) return;
    clearTimeout(draftTimer);
    persistDraft();
  }

  function clearDraftFromStorage() {
    const ls = getStorage();
    if (!ls) return;
    try { ls.removeItem(DraftLib.STORAGE_KEY); } catch { /* 忽略 */ }
  }

  /* ---------- 草稿提示条 ---------- */

  function hideDraftBar() {
    els.draftBar.hidden = true;
    els.draftBar.innerHTML = '';
    els.draftBar.className = 'draft-bar';
  }

  // kind：prompt（恢复询问，黄）/ corrupt（损坏，红）/ storage（存储被拒，红）/ info（已恢复，蓝）
  function showDraftBar(kind, message, buttons) {
    els.draftBar.hidden = false;
    els.draftBar.className = 'draft-bar ' + kind;
    els.draftBar.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'draft-msg';
    msg.textContent = message;
    els.draftBar.appendChild(msg);
    if (buttons && buttons.length > 0) {
      const wrap = document.createElement('span');
      wrap.className = 'draft-actions';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.text;
        btn.dataset.act = b.act;
        if (b.primary) btn.className = 'primary minor-btn';
        else btn.className = 'minor-btn';
        wrap.appendChild(btn);
      }
      els.draftBar.appendChild(wrap);
    }
  }

  function showStorageNotice(reason) {
    if (storageWarned) return;
    storageWarned = true;
    pendingDraft = null;
    showDraftBar('storage', '本地草稿不可用：' + reason, [
      { act: 'dismiss-storage', text: '知道了' },
    ]);
  }

  function showCorruptDraft(reason) {
    pendingDraft = null;
    showDraftBar('corrupt',
      `浏览器中的合并草稿已损坏，无法恢复：${reason} 损坏草稿不影响正常合并；可直接删除它后继续使用。`,
      [{ act: 'delete-corrupt', text: '删除损坏草稿', primary: true }]);
  }

  function formatSavedAt(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function showRecoveryPrompt(draft) {
    const when = formatSavedAt(draft.savedAt);
    let msg;
    if (draft.merge) {
      const chosen = draft.merge.choices.length;
      msg = `检测到本浏览器保存的合并草稿（保存于 ${when}）：含三方输入、可选 Schema、`
        + `最近一次合并所用的三方文本与本轮已选 ${chosen} 个冲突。恢复后会重新解析并合并；`
        + '仅当当前三方文本与保存的合并文本一致、且冲突路径与基线 / 我的 / 对方三值均匹配时才重放选边；'
        + '输入已改动则只恢复编辑文本并要求重新合并，旧结果与旧校验状态不会放行导出。';
    } else {
      msg = `检测到本浏览器保存的输入草稿（保存于 ${when}）：含三方输入与可选 Schema，`
        + '尚未进行过合并。可恢复这些编辑文本，或丢弃草稿。';
    }
    showDraftBar('prompt', msg, [
      { act: 'restore', text: '恢复草稿', primary: true },
      { act: 'discard', text: '丢弃草稿' },
    ]);
  }

  function showRestoreInfo(message) {
    showDraftBar('info', message, [{ act: 'dismiss-info', text: '知道了' }]);
  }

  // 提示条按钮统一在此分发
  els.draftBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !els.draftBar.contains(btn)) return;
    const act = btn.dataset.act;
    if (act === 'restore' && pendingDraft) {
      const draft = pendingDraft;
      pendingDraft = null;
      restoreDraft(draft);
    } else if (act === 'discard') {
      // 丢弃：删除浏览器中的草稿
      pendingDraft = null;
      clearDraftFromStorage();
      hideDraftBar();
    } else if (act === 'delete-corrupt') {
      clearDraftFromStorage();
      hideDraftBar();
    } else if (act === 'dismiss-storage' || act === 'dismiss-info') {
      hideDraftBar();
    }
  });

  /* ---------- 恢复执行 ---------- */

  function restoreDraft(draft) {
    hideDraftBar();
    // 无论能否重放选边，编辑文本与可选 Schema 都先恢复
    els.base.value = draft.inputs.base;
    els.mine.value = draft.inputs.mine;
    els.theirs.value = draft.inputs.theirs;
    els.schemaInput.value = draft.schema;
    els.schemaInput.classList.remove('invalid');
    for (const ta of [els.base, els.mine, els.theirs]) ta.classList.remove('invalid');

    if (!draft.merge) {
      // 草稿只含编辑文本（从未合并）：不恢复任何结果 / 校验状态
      state.parsed = false;
      els.resultSection.hidden = true;
      els.staleNote.hidden = true;
      syncSchemaFromInput();
      showRestoreInfo('已恢复草稿中的三方输入与可选 Schema（该草稿尚未进行过合并）。请检查内容后点击「开始合并」。');
      scheduleDraftSave();
      return;
    }

    // 重新解析并合并：DraftLib 负责校验「文本一致 + 冲突三值匹配 + 结果一致」
    const verdict = DraftLib.replaySnapshot(draft, currentInputsText());
    if (verdict.status !== 'replay') {
      // 输入已改动 / 冲突不匹配 / 保存结果对不上：只恢复编辑文本，要求重新合并；
      // 不恢复结果区与任何旧校验结论，导出按钮保持禁用
      state.parsed = false;
      els.resultSection.hidden = true;
      els.staleNote.hidden = true;
      syncSchemaFromInput();
      showRestoreInfo(`已恢复草稿中的三方输入与可选 Schema，但${verdict.reason}。`
        + '请重新点击「开始合并」；恢复前的旧合并结果与旧校验结论不会直接放行导出。');
      scheduleDraftSave();
      return;
    }

    // 安全重放：以保存文本重新解析（replay 已验证可解析），载入匹配上的选边
    state.base = JSON.parse(draft.merge.inputs.base);
    state.mine = JSON.parse(draft.merge.inputs.mine);
    state.theirs = JSON.parse(draft.merge.inputs.theirs);
    state.resolutions = verdict.resolutions;
    state.mergedInputs = {
      base: draft.merge.inputs.base,
      mine: draft.merge.inputs.mine,
      theirs: draft.merge.inputs.theirs,
    };
    state.stale = false;
    state.suggestion = null;
    state.choiceImport = null;
    // 冲突集合以重新合并为准（不携带任何旧 UI 状态）
    state.allConflicts = merge(state.base, state.mine, state.theirs, new Map()).conflicts;
    state.parsed = true;

    els.staleNote.hidden = true;
    els.resultSection.hidden = false;
    // Schema 填回后重新编译；编译完成时 render() 会用恢复后的结果重新校验，
    // 旧的通过 / 失败结论一律不继承
    syncSchemaFromInput();
    render();

    const chosen = verdict.resolutions.size;
    const total = state.allConflicts.length;
    const tail = total > 0
      ? `已重放 ${chosen} / ${total} 个冲突的选边。`
      : '本轮无冲突。';
    showRestoreInfo(`已恢复草稿并重新解析、重新合并：当前三方文本与保存的合并文本一致，`
      + `冲突路径与三方值均匹配，${tail} Schema 已重新编译并按新结果校验。`);
    scheduleDraftSave();
    els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 页面加载时读取草稿：可用则提示恢复 / 丢弃；损坏或存储被拒则说明原因，
  // 均不影响正常合并
  function initDraftRecovery() {
    const ls = getStorage();
    if (!ls) {
      showStorageNotice(storageError);
      return;
    }
    let raw;
    try {
      raw = ls.getItem(DraftLib.STORAGE_KEY);
    } catch (err) {
      showStorageNotice(describeStorageError(err));
      return;
    }
    if (raw == null) return;
    const parsed = DraftLib.parseDraft(raw);
    if (parsed.status !== 'ok') {
      showCorruptDraft(parsed.reason);
      return;
    }
    const d = parsed.draft;
    // 未合并且三方与 Schema 全空的草稿：静默清理，不打扰
    if (!d.merge && isEmptyInputs(d.inputs) && !d.schema.trim()) {
      clearDraftFromStorage();
      return;
    }
    pendingDraft = d;
    showRecoveryPrompt(d);
  }

  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });

  /* ---------- 事件绑定 ---------- */

  els.mergeBtn.addEventListener('click', doMerge);
  els.sampleBtn.addEventListener('click', fillSample);
  els.clearBtn.addEventListener('click', clearAll);
  els.exportBtn.addEventListener('click', downloadResult);
  els.copyBtn.addEventListener('click', copyResult);
  els.patchBtn.addEventListener('click', downloadPatch);
  els.attrBtn.addEventListener('click', downloadAttribution);
  els.refBtn.addEventListener('click', downloadRefExport);
  els.renBtn.addEventListener('click', downloadRename);
  els.renKey.addEventListener('change', () => {
    // 选项的 data-key 携带真实键名（空字符串键也能与占位项区分）
    const opt = els.renKey.selectedOptions[0];
    state.renKey = opt && 'key' in opt.dataset ? opt.dataset.key : null;
    renderRename(); // 改选顶层键即重算
  });
  els.renName.addEventListener('input', () => {
    state.renName = els.renName.value;
    renderRename(); // 修改新键名即重算
  });
  els.choiceBtn.addEventListener('click', downloadChoices);
  els.choiceFile.addEventListener('change', onChoiceFile);
  els.attrFilter.addEventListener('change', () => {
    state.attrFilter = els.attrFilter.value;
    renderAttribution();
  });
  els.schemaSampleBtn.addEventListener('click', fillSampleSchema);
  els.schemaInput.addEventListener('input', onSchemaInput);

  for (const ta of [els.base, els.mine, els.theirs]) {
    ta.addEventListener('input', () => {
      ta.classList.remove('invalid');
      markStale();
      scheduleDraftSave(); // 合并前的编辑同样自动保存（此时草稿不含合并快照）
    });
    // Ctrl/Cmd + Enter 快捷合并
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doMerge();
    });
  }

  // 初始渲染一次空 Schema 面板（隐藏状态）
  renderSchemaPanel();
  // 检测浏览器本地草稿并提示恢复 / 丢弃（损坏或存储被拒时只说明原因）
  initDraftRecovery();
})();
