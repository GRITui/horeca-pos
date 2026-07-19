'use strict';

const PREVIEW_LIMIT = 100;
const FILTER_OPS = ['>=', '>', '=', '!=', '<', '<=', 'contains', 'is blank', 'is not blank'];
const BLANK_OPS = ['is blank', 'is not blank'];

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileNameEl = document.getElementById('fileName');
const sheetSelect = document.getElementById('sheetSelect');
const configSection = document.getElementById('configSection');
const groupByBox = document.getElementById('groupByBox');
const metricsBox = document.getElementById('metricsBox');
const condMetricList = document.getElementById('condMetricList');
const addCondMetricBtn = document.getElementById('addCondMetricBtn');
const derivedList = document.getElementById('derivedList');
const addDerivedBtn = document.getElementById('addDerivedBtn');
const labelList = document.getElementById('labelList');
const addLabelBtn = document.getElementById('addLabelBtn');
const filterList = document.getElementById('filterList');
const addFilterBtn = document.getElementById('addFilterBtn');
const sortColSelect = document.getElementById('sortColSelect');
const sortDirSelect = document.getElementById('sortDirSelect');
const topNInput = document.getElementById('topNInput');
const kpiColSelect = document.getElementById('kpiColSelect');
const pivotEnabledCheckbox = document.getElementById('pivotEnabled');
const pivotColDimSelect = document.getElementById('pivotColDim');
const pivotValueColSelect = document.getElementById('pivotValueCol');
const vizChartTypeSelect = document.getElementById('vizChartType');
const vizXColSelect = document.getElementById('vizXCol');
const vizValueColSelect = document.getElementById('vizValueCol');
const vizTopNInput = document.getElementById('vizTopN');
const vizSeriesColSelect = document.getElementById('vizSeriesCol');
const vizStackedCb = document.getElementById('vizStacked');
const vizAxisMinInput = document.getElementById('vizAxisMin');
const vizAxisMaxInput = document.getElementById('vizAxisMax');
const vizAxisUnitSelect = document.getElementById('vizAxisUnit');
const colorScaleEnabledCb = document.getElementById('colorScaleEnabled');
const colorScaleColSelect = document.getElementById('colorScaleCol');
const chartArea = document.getElementById('chartArea');
const vizCanvas = document.getElementById('vizCanvas');
const presetSelect = document.getElementById('presetSelect');
const presetNameInput = document.getElementById('presetNameInput');
const savePresetBtn = document.getElementById('savePresetBtn');
const deletePresetBtn = document.getElementById('deletePresetBtn');
const runBtn = document.getElementById('runBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');
const kpiBar = document.getElementById('kpiBar');
const previewWrap = document.getElementById('previewWrap');
const previewNote = document.getElementById('previewNote');
const joinEnabledCb = document.getElementById('joinEnabled');
const lookupFileBtn = document.getElementById('lookupFileBtn');
const lookupFileInput = document.getElementById('lookupFileInput');
const lookupFileNameEl = document.getElementById('lookupFileName');
const lookupSheetSelect = document.getElementById('lookupSheetSelect');
const joinLeftKeySelect = document.getElementById('joinLeftKey');
const joinRightKeySelect = document.getElementById('joinRightKey');
const joinColsBox = document.getElementById('joinColsBox');

let workbook = null;
let sheetRows = [];
let columns = [];
let numericColumns = [];
let resultRows = null;
let resultSummaryRows = [];
let outputCols = [];
let lookupWorkbook = null;
let lookupRows = [];
let lookupColumns = [];
let lookupNumeric = [];
let addedLookupCols = [];
let pendingJoinConfig = null;
let joinWarning = '';
let joinWarningLevel = '';

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || '';
}

function resetResults() {
  resultRows = null;
  resultSummaryRows = [];
  downloadBtn.hidden = true;
  previewWrap.innerHTML = '';
  previewNote.textContent = '';
  dateBucketsCache = null;
  kpiBar.innerHTML = '';
  destroyVizChart();
  chartArea.hidden = true;
}

/* ---------- formula engine ([Column] refs, + - * / ( ), numbers) ---------- */

function tokenizeFormula(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) throw new Error('missing "]" after "["');
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new Error('empty [] column reference');
      tokens.push({ type: 'ref', name });
      i = end + 1;
    } else if ('+-*/()'.includes(ch)) {
      tokens.push({ type: ch });
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      if (isNaN(num)) throw new Error(`bad number "${src.slice(i, j)}"`);
      tokens.push({ type: 'num', value: num });
      i = j;
    } else {
      throw new Error(`unexpected "${ch}" — use [Column Name], numbers, + - * / ( )`);
    }
  }
  if (tokens.length === 0) throw new Error('formula is empty');
  return tokens;
}

function compileFormula(src) {
  const raw = tokenizeFormula(src);
  // Turn unary minus into (0 - x)
  const tokens = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const prev = raw[i - 1];
    if (t.type === '-' && (!prev || ['+', '-', '*', '/', '('].includes(prev.type))) {
      tokens.push({ type: 'num', value: 0 });
    }
    tokens.push(t);
  }
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const rpn = [];
  const ops = [];
  const refs = new Set();
  for (const t of tokens) {
    if (t.type === 'num') rpn.push(t);
    else if (t.type === 'ref') { rpn.push(t); refs.add(t.name); }
    else if (t.type === '(') ops.push(t);
    else if (t.type === ')') {
      while (ops.length && ops[ops.length - 1].type !== '(') rpn.push(ops.pop());
      if (!ops.length) throw new Error('unbalanced ")"');
      ops.pop();
    } else {
      while (ops.length && prec[ops[ops.length - 1].type] >= prec[t.type]) rpn.push(ops.pop());
      ops.push(t);
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op.type === '(') throw new Error('unbalanced "("');
    rpn.push(op);
  }
  // Simulate the evaluation stack depth so a formula with too few operands for its operators
  // (e.g. "[Revenue] +") is rejected here at compile time, before it can reach runAnalysis's
  // eval loop as an uncaught exception mid-run (evalFormula keeps its own check as a backstop).
  let depth = 0;
  for (const t of rpn) {
    if (t.type === 'num' || t.type === 'ref') depth++;
    else {
      if (depth < 2) throw new Error('missing a value before an operator — check the formula');
      depth--;
    }
  }
  if (depth !== 1) {
    throw new Error('formula does not reduce to a single value — check for a missing operator or value');
  }
  return { rpn, refs: [...refs] };
}

function evalFormula(rpn, values) {
  const st = [];
  for (const t of rpn) {
    if (t.type === 'num') st.push(t.value);
    else if (t.type === 'ref') st.push(Number(values[t.name]) || 0);
    else {
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined) throw new Error('malformed formula');
      if (t.type === '+') st.push(a + b);
      else if (t.type === '-') st.push(a - b);
      else if (t.type === '*') st.push(a * b);
      else st.push(b !== 0 ? a / b : 0);
    }
  }
  if (st.length !== 1) throw new Error('malformed formula');
  return st[0];
}

/* ---------- file loading ---------- */

function loadFile(file) {
  resetResults();
  workbook = null;
  sheetSelect.innerHTML = '';
  sheetSelect.disabled = true;
  configSection.classList.remove('visible');
  fileNameEl.textContent = file.name;
  setStatus('Reading file...');

  const reader = new FileReader();
  reader.onerror = () => setStatus('Could not read the file.', 'error');
  reader.onload = (e) => {
    try {
      workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
    } catch (err) {
      setStatus('Not a valid spreadsheet: ' + err.message, 'error');
      return;
    }
    for (const name of workbook.SheetNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sheetSelect.appendChild(opt);
    }
    if (workbook.SheetNames.includes('Export')) sheetSelect.value = 'Export';
    sheetSelect.disabled = false;
    loadSheet();
  };
  reader.readAsArrayBuffer(file);
}

function loadSheet() {
  resetResults();
  const sheetName = sheetSelect.value;
  sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  if (sheetRows.length === 0) {
    configSection.classList.remove('visible');
    setStatus(`Sheet "${sheetName}" is empty — pick another sheet.`, 'error');
    return;
  }
  columns = Object.keys(sheetRows[0]);
  // `columns` was just rebuilt wholesale from the new main file, so any bookkeeping about which
  // names came from a previously loaded lookup file is now stale — a genuine new main-file column
  // that happens to share a name with an old lookup column must not be treated as a lookup column
  // by a later registerLookupColumnsIntoGlobal() call.
  addedLookupCols = [];

  // A column counts as numeric when every non-empty sampled value parses as a number
  numericColumns = columns.filter((col) => {
    let seen = 0;
    for (const row of sheetRows.slice(0, 200)) {
      const v = row[col];
      if (v === '' || v === null || v === undefined) continue;
      seen++;
      if (typeof v !== 'number' && isNaN(Number(v))) return false;
    }
    return seen > 0;
  });

  buildColumnPickers();
  updateSelectors();
  configSection.classList.add('visible');
  setStatus(`Loaded sheet "${sheetName}": ${sheetRows.length} rows, ${columns.length} columns. Configure the analysis below, then Run.`);
  applyCsmPresetIfPossible();
}

/* ---------- quick-start templates (built-in sample data, no file needed) --------- */

const SAMPLE_TEMPLATES = {
  salesVsTarget: {
    label: 'Sales vs Target',
    rows: [
      { Region: 'Central', Province: 'Bangkok', Sales: 4200000, 'Sales Target': 4000000 },
      { Region: 'Central', Province: 'Ayutthaya', Sales: 800000, 'Sales Target': 700000 },
      { Region: 'Northeast', Province: 'Khon Kaen', Sales: 1500000, 'Sales Target': 1800000 },
      { Region: 'Northeast', Province: 'Nakhon Ratchasima', Sales: 1100000, 'Sales Target': 1200000 },
      { Region: 'East', Province: 'Chonburi', Sales: 2100000, 'Sales Target': 2500000 },
      { Region: 'East', Province: 'Rayong', Sales: 900000, 'Sales Target': 800000 },
      { Region: 'South', Province: 'Phuket', Sales: 1200000, 'Sales Target': 1000000 },
      { Region: 'South', Province: 'Songkhla', Sales: 900000, 'Sales Target': 1100000 },
      { Region: 'North', Province: 'Chiang Mai', Sales: 1800000, 'Sales Target': 1600000 },
      { Region: 'North', Province: 'Chiang Rai', Sales: 700000, 'Sales Target': 650000 },
    ],
    config: {
      groupBy: ['Region'],
      metrics: ['Sales', 'Sales Target'],
      aggs: { Sales: 'sum', 'Sales Target': 'sum' },
      derived: [{ name: '%Achieve', formula: '[Sales] / [Sales Target] * 100' }],
      formats: [{ col: '%Achieve', type: 'percent', decimals: 0 }],
      sortCol: 'Sales', sortDir: 'desc',
      totalRow: true,
      viz: { chart: { type: 'bar', xCol: 'Region', valueCol: 'Sales', unit: 'M', excludeTotals: true } },
    },
  },
  storeRanking: {
    label: 'Store ranking',
    rows: [
      { 'Store Code': '081', 'Store Name': 'Chidlom', Region: 'Central', Sales: 4200000 },
      { 'Store Code': '512', 'Store Name': 'Central World', Region: 'Central', Sales: 3600000 },
      { 'Store Code': '208', 'Store Name': 'Chiang Mai Airport', Region: 'North', Sales: 1800000 },
      { 'Store Code': '226', 'Store Name': 'Khon Kaen Central', Region: 'Northeast', Sales: 1500000 },
      { 'Store Code': '347', 'Store Name': 'Phuket Central', Region: 'South', Sales: 1200000 },
      { 'Store Code': '019', 'Store Name': 'Korat Terminal', Region: 'Northeast', Sales: 1100000 },
      { 'Store Code': '455', 'Store Name': 'Hatyai', Region: 'South', Sales: 900000 },
      { 'Store Code': '133', 'Store Name': 'Rayong Central', Region: 'East', Sales: 900000 },
      { 'Store Code': '102', 'Store Name': 'Ayutthaya Park', Region: 'Central', Sales: 800000 },
      { 'Store Code': '144', 'Store Name': 'Udon Thani', Region: 'Northeast', Sales: 700000 },
    ],
    config: {
      groupBy: ['Store Name'],
      metrics: ['Sales'],
      aggs: { Sales: 'sum' },
      sortCol: 'Sales', sortDir: 'desc',
      topN: 5,
      viz: { chart: { type: 'barh', xCol: 'Store Name', valueCol: 'Sales', unit: 'M' } },
    },
  },
  oosDelist: {
    label: 'OOS / delist candidates',
    rows: [
      { SKU: 'SKU001', Store: 'StoreA', 'Item Qty': 100, "Item Qty Can't Shipped": 5 },
      { SKU: 'SKU001', Store: 'StoreB', 'Item Qty': 80, "Item Qty Can't Shipped": 60 },
      { SKU: 'SKU001', Store: 'StoreC', 'Item Qty': 120, "Item Qty Can't Shipped": 10 },
      { SKU: 'SKU002', Store: 'StoreA', 'Item Qty': 50, "Item Qty Can't Shipped": 2 },
      { SKU: 'SKU002', Store: 'StoreB', 'Item Qty': 60, "Item Qty Can't Shipped": 3 },
      { SKU: 'SKU002', Store: 'StoreC', 'Item Qty': 40, "Item Qty Can't Shipped": 1 },
      { SKU: 'SKU003', Store: 'StoreA', 'Item Qty': 200, "Item Qty Can't Shipped": 150 },
      { SKU: 'SKU003', Store: 'StoreB', 'Item Qty': 180, "Item Qty Can't Shipped": 160 },
      { SKU: 'SKU003', Store: 'StoreC', 'Item Qty': 150, "Item Qty Can't Shipped": 140 },
      { SKU: 'SKU004', Store: 'StoreA', 'Item Qty': 90, "Item Qty Can't Shipped": 4 },
      { SKU: 'SKU004', Store: 'StoreB', 'Item Qty': 70, "Item Qty Can't Shipped": 3 },
      { SKU: 'SKU004', Store: 'StoreC', 'Item Qty': 60, "Item Qty Can't Shipped": 2 },
    ],
    config: {
      groupBy: ['SKU'],
      metrics: ['Item Qty', "Item Qty Can't Shipped"],
      aggs: { 'Item Qty': 'sum', "Item Qty Can't Shipped": 'sum' },
      derived: [{ name: '%OOS', formula: "[Item Qty Can't Shipped] / [Item Qty] * 100" }],
      condMetrics: [{
        name: 'Stores Understocked', type: 'count', valueCol: '',
        conditions: [{ col: "Item Qty Can't Shipped", op: '>=', value: '50' }],
      }],
      filters: [{ col: '%OOS', op: '>=', value: '20' }],
      sortCol: '%OOS', sortDir: 'desc',
      viz: { chart: { type: 'bar', xCol: 'SKU', valueCol: '%OOS' } },
    },
  },
};

// Builds an in-memory workbook from a template's rows and feeds it through the same loadSheet()
// path as a real upload, then applies the template's config and runs the analysis immediately —
// a one-click, no-file-needed way to see the tool work before trusting it with real data.
function loadSampleTemplate(key) {
  const tpl = SAMPLE_TEMPLATES[key];
  if (!tpl) return;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(tpl.rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sample');
  workbook = wb;
  sheetSelect.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = 'Sample';
  opt.textContent = 'Sample';
  sheetSelect.appendChild(opt);
  sheetSelect.value = 'Sample';
  sheetSelect.disabled = false;
  fileNameEl.textContent = `${tpl.label} (sample data)`;
  loadSheet();
  applyConfig(tpl.config);
  runAnalysis();
}

/* ---------- config UI ---------- */

function buildColumnPickers() {
  groupByBox.innerHTML = '';
  metricsBox.innerHTML = '';
  condMetricList.innerHTML = '';
  derivedList.innerHTML = '';
  labelList.innerHTML = '';
  filterList.innerHTML = '';
  document.getElementById('formatList').innerHTML = '';
  // A fresh file load starts every advanced (collapsible) section closed; applyConfig() —
  // called right after by a preset, the CSM auto-preset, or a quick-start template — reopens
  // whichever ones actually end up configured.
  document.getElementById('condMetricsBox').open = false;
  document.getElementById('pivotBox').open = false;
  document.getElementById('vizBox').open = false;
  for (const col of columns) {
    const gbLabel = makeCheckbox('groupby', col);
    gbLabel.appendChild(makeGranSelect(col));
    groupByBox.appendChild(gbLabel);
  }
  for (const col of numericColumns) {
    const label = makeCheckbox('metric', col);
    label.appendChild(makeAggSelect(col));
    metricsBox.appendChild(label);
  }
  if (numericColumns.length === 0) {
    metricsBox.innerHTML = '<span class="muted">No numeric columns detected in this sheet.</span>';
  }
}

function makeCheckbox(kind, col) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.kind = kind;
  cb.value = col;
  cb.addEventListener('change', () => { resetResults(); updateSelectors(); });
  label.appendChild(cb);
  label.appendChild(document.createTextNode(col));
  return label;
}

// Inline "day / week / month" bucket picker shown beside each group-by checkbox
function makeGranSelect(col) {
  const sel = document.createElement('select');
  sel.className = 'gran';
  sel.dataset.col = col;
  for (const opt of ['(none)', 'day', 'week', 'month']) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    sel.appendChild(o);
  }
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', (e) => { e.stopPropagation(); resetResults(); });
  return sel;
}

function checkedValues(kind) {
  return [...document.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((cb) => cb.value);
}

function setChecked(kind, values) {
  for (const cb of document.querySelectorAll(`input[data-kind="${kind}"]`)) {
    cb.checked = values.includes(cb.value);
  }
}

function makeSelect(options, value, cls, placeholder) {
  const sel = document.createElement('select');
  if (cls) sel.className = cls;
  if (placeholder) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    sel.appendChild(o);
  }
  if (value !== undefined && options.includes(value)) sel.value = value;
  else if (placeholder) sel.value = '';
  sel.addEventListener('change', resetResults);
  return sel;
}

function fillSelect(sel, options, placeholder) {
  const cur = sel.value;
  sel.innerHTML = '';
  if (placeholder) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const c of options) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  sel.value = options.includes(cur) ? cur : (placeholder ? '' : sel.value);
}

/* --- conditional metrics (SUMIF / COUNTIF), section 4 --- */

const COND_TYPE_LABELS = {
  sum: 'Sum',
  count: 'Count',
  countDistinct: 'Count distinct',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
};

// "Count" needs no value column — grey it out, matching syncBlankOpValue's pattern for
// "is blank" / "is not blank" filter rows.
function syncCondValueCol(typeSel, valueSel) {
  const isCount = typeSel.value === 'count';
  valueSel.disabled = isCount;
  valueSel.style.opacity = isCount ? '0.5' : '';
}

function addCondMetricBlock(preset) {
  const block = document.createElement('div');
  block.className = 'labelBlock';

  const head = document.createElement('div');
  head.className = 'configRow blockHead';

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Column name, e.g. Central Sales';
  name.className = 'cmName';
  name.value = preset?.name || '';
  name.addEventListener('input', () => { resetResults(); updateSelectors(); });

  const type = makeSelect(Object.keys(COND_TYPE_LABELS), preset?.type || 'sum', 'cmType');
  for (const o of type.options) o.textContent = COND_TYPE_LABELS[o.value] || o.value;

  const valueCol = makeSelect(numericColumns, preset?.valueCol, 'cmValueCol', '(choose column)');
  type.addEventListener('change', () => syncCondValueCol(type, valueCol));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove metric';
  remove.addEventListener('click', () => { block.remove(); resetResults(); updateSelectors(); });

  head.append(
    document.createTextNode('Name'), name,
    document.createTextNode('Type'), type,
    document.createTextNode('of'), valueCol,
    remove
  );

  const conditions = document.createElement('div');
  conditions.className = 'cmConditions';

  const addCond = document.createElement('button');
  addCond.type = 'button';
  addCond.className = 'small';
  addCond.textContent = '+ Add condition';
  addCond.addEventListener('click', () => { addCondConditionRow(conditions); resetResults(); });

  block.append(head, conditions, addCond);
  condMetricList.appendChild(block);

  for (const c of preset?.conditions || []) addCondConditionRow(conditions, c);
  if (!preset || !(preset.conditions || []).length) addCondConditionRow(conditions);

  syncCondValueCol(type, valueCol);
}

function addCondConditionRow(container, preset) {
  const row = document.createElement('div');
  row.className = 'configRow ccRow';

  const col = makeSelect(columns, preset?.col, 'ccCol');
  const op = makeSelect(FILTER_OPS, preset?.op || '>=', 'ccOp');
  const value = document.createElement('input');
  value.type = 'text';
  value.className = 'ccVal';
  value.placeholder = 'value';
  value.value = preset?.value ?? '';
  value.addEventListener('input', resetResults);
  syncBlankOpValue(op, value);
  op.addEventListener('change', () => syncBlankOpValue(op, value));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); resetResults(); });

  row.append(document.createTextNode('where'), col, op, value, remove);
  container.appendChild(row);
}

function readCondMetrics() {
  return [...condMetricList.querySelectorAll('.labelBlock')].map((block) => ({
    name: block.querySelector('.cmName').value.trim(),
    type: block.querySelector('.cmType').value,
    valueCol: block.querySelector('.cmValueCol').value,
    conditions: [...block.querySelectorAll('.ccRow')].map((row) => ({
      col: row.querySelector('.ccCol').value,
      op: row.querySelector('.ccOp').value,
      value: row.querySelector('.ccVal').value.trim(),
    })),
  }));
}

/* --- calculated columns --- */

function addDerivedRow(preset) {
  const cfg = migrateDerived(preset || {});
  const row = document.createElement('div');
  row.className = 'configRow derivedRow';

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Column name';
  name.className = 'dName';
  name.value = cfg.name || '';
  name.addEventListener('input', () => { resetResults(); updateSelectors(); });

  const formula = document.createElement('input');
  formula.type = 'text';
  formula.placeholder = 'e.g. ([Qty Ordered] - [Qty Shipped]) / [Qty Ordered] * 100';
  formula.className = 'formula dFormula';
  formula.value = cfg.formula || '';
  formula.addEventListener('input', resetResults);
  formula.addEventListener('focus', () => { lastFormulaInput = formula; });

  const insert = document.createElement('select');
  insert.className = 'dInsert';
  insert.addEventListener('change', () => {
    if (!insert.value) return;
    const ref = `[${insert.value}]`;
    const pos = formula.selectionStart ?? formula.value.length;
    formula.value = formula.value.slice(0, pos) + ref + formula.value.slice(pos);
    insert.value = '';
    formula.focus();
    resetResults();
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); resetResults(); updateSelectors(); });

  row.append(name, document.createTextNode('='), formula, insert, remove);
  derivedList.appendChild(row);
}

// Old presets stored {name, a, formula: 'A + B', b, pct} — convert to a formula string
function migrateDerived(d) {
  if (d.a === undefined) return d;
  const map = {
    'A + B': `[${d.a}] + [${d.b}]`,
    'A - B': `[${d.a}] - [${d.b}]`,
    'A x B': `[${d.a}] * [${d.b}]`,
    'A / B': `[${d.a}] / [${d.b}]`,
    '(A - B) / A': `([${d.a}] - [${d.b}]) / [${d.a}]`,
  };
  let formula = map[d.formula] || `[${d.a}] + [${d.b}]`;
  if (d.pct) formula += ' * 100';
  return { name: d.name, formula };
}

function readDerived() {
  return [...derivedList.querySelectorAll('.derivedRow')].map((row) => ({
    name: row.querySelector('.dName').value.trim(),
    formula: row.querySelector('.dFormula').value.trim(),
  }));
}

/* --- category (label) columns --- */

function addLabelBlock(preset) {
  const block = document.createElement('div');
  block.className = 'labelBlock';

  const head = document.createElement('div');
  head.className = 'configRow blockHead';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Category column name';
  name.className = 'lName';
  name.value = preset?.name || 'Category';
  name.addEventListener('input', () => { resetResults(); updateSelectors(); });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove column';
  remove.addEventListener('click', () => { block.remove(); resetResults(); updateSelectors(); });
  head.append(name, remove);

  const rules = document.createElement('div');
  rules.className = 'lRules';

  const addRule = document.createElement('button');
  addRule.type = 'button';
  addRule.className = 'small';
  addRule.textContent = '+ Add rule';
  addRule.addEventListener('click', () => { addLabelRule(rules); updateSelectors(); });

  const elseRow = document.createElement('div');
  elseRow.className = 'configRow';
  const elseInput = document.createElement('input');
  elseInput.type = 'text';
  elseInput.placeholder = 'label';
  elseInput.className = 'lElse';
  elseInput.value = preset?.elseLabel ?? '';
  elseInput.addEventListener('input', resetResults);
  elseRow.append(document.createTextNode('otherwise'), spanArrow(), elseInput);

  block.append(head, rules, addRule, elseRow);
  labelList.appendChild(block);

  for (const r of preset?.rules || []) addLabelRule(rules, r);
  if (!preset || !(preset.rules || []).length) addLabelRule(rules);
}

function spanArrow() {
  const s = document.createElement('span');
  s.className = 'arrow';
  s.textContent = '→';
  return s;
}

// "is blank" / "is not blank" need no comparison value — grey the box out
function syncBlankOpValue(opSel, valueInput) {
  const isBlankOp = BLANK_OPS.includes(opSel.value);
  valueInput.disabled = isBlankOp;
  valueInput.placeholder = isBlankOp ? '(no value needed)' : 'value';
  if (isBlankOp) valueInput.value = '';
}

function addLabelRule(container, preset) {
  const row = document.createElement('div');
  row.className = 'configRow labelRule';

  const col = makeSelect(calcSourceNames(), preset?.col, 'lrCol');
  const op = makeSelect(FILTER_OPS, preset?.op || '>=', 'lrOp');
  const value = document.createElement('input');
  value.type = 'text';
  value.placeholder = 'value';
  value.className = 'lrVal';
  value.value = preset?.value ?? '';
  value.addEventListener('input', resetResults);
  syncBlankOpValue(op, value);
  op.addEventListener('change', () => syncBlankOpValue(op, value));
  const label = document.createElement('input');
  label.type = 'text';
  label.placeholder = 'label, e.g. AAA';
  label.className = 'lrLabel';
  label.value = preset?.label ?? '';
  label.addEventListener('input', resetResults);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); resetResults(); });

  row.append(document.createTextNode('when'), col, op, value, spanArrow(), label, remove);
  container.appendChild(row);
}

function readLabels() {
  return [...labelList.querySelectorAll('.labelBlock')].map((block) => ({
    name: block.querySelector('.lName').value.trim(),
    rules: [...block.querySelectorAll('.labelRule')].map((row) => ({
      col: row.querySelector('.lrCol').value,
      op: row.querySelector('.lrOp').value,
      value: row.querySelector('.lrVal').value.trim(),
      label: row.querySelector('.lrLabel').value,
    })),
    elseLabel: block.querySelector('.lElse').value,
  }));
}

/* --- filters --- */

function addFilterRow(preset) {
  const row = document.createElement('div');
  row.className = 'configRow filterRow';

  const col = makeSelect(outputColumnNames(), preset?.col, 'fCol');
  const op = makeSelect(FILTER_OPS, preset?.op || '>=', 'fOp');
  const value = document.createElement('input');
  value.type = 'text';
  value.className = 'fVal';
  value.placeholder = 'value';
  value.value = preset?.value ?? '';
  value.addEventListener('input', resetResults);
  syncBlankOpValue(op, value);
  op.addEventListener('change', () => syncBlankOpValue(op, value));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); resetResults(); });

  row.append(document.createTextNode('Keep rows where'), col, op, value, remove);
  filterList.appendChild(row);
}

function readFilters() {
  return [...filterList.querySelectorAll('.filterRow')].map((row) => ({
    col: row.querySelector('.fCol').value,
    op: row.querySelector('.fOp').value,
    value: row.querySelector('.fVal').value.trim(),
  }));
}

/* --- dependent dropdowns --- */

// Numeric columns a rule or formula can draw from: summed data + conditional metrics + calculated columns
function calcSourceNames() {
  const condNames = readCondMetrics().map((c) => c.name).filter(Boolean);
  const derivedNames = readDerived().map((d) => d.name).filter(Boolean);
  return [...checkedValues('metric'), ...condNames, ...derivedNames];
}

function outputColumnNames() {
  const condNames = readCondMetrics().map((c) => c.name).filter(Boolean);
  const derivedNames = readDerived().map((d) => d.name).filter(Boolean);
  const labelNames = readLabels().map((l) => l.name).filter(Boolean);
  return [...checkedValues('groupby'), ...checkedValues('metric'), ...condNames, ...derivedNames, ...labelNames];
}

/* ---------- pivot (cross-tab) ---------- */

function readPivotConfig() {
  return {
    enabled: pivotEnabledCheckbox.checked,
    colDim: pivotColDimSelect.value,
    valueCol: pivotValueColSelect.value,
  };
}

// Reshapes already-aggregated `rows` (with output columns `cols`) into a cross-tab: distinct
// values of `colDim` become new columns named "<valueCol> — <v>" (em dash), and rows collapse
// to the group-by columns other than `colDim`. Collisions within one bucket are combined with
// the value column's own aggregation choice (core's getAgg/aggregateValues). Returns
// { rows, cols } unchanged when pivot is disabled, or { error } when misconfigured / the
// columns-dimension has more than 40 distinct values.
function applyPivot(rows, cols, groupBy) {
  const cfg = readPivotConfig();
  if (!cfg.enabled) return { rows, cols };
  if (!cfg.colDim || !cfg.valueCol) {
    return {
      error: 'Cross-tab (section 8) is enabled but needs both "Turn into columns" and ' +
        '"Values" selected — pick both, or turn the checkbox off.',
    };
  }
  if (cfg.colDim === cfg.valueCol) {
    return { error: 'Cross-tab: "Turn into columns" and "Values" must be different columns.' };
  }
  if (!cols.includes(cfg.colDim) || !cols.includes(cfg.valueCol)) {
    return { error: 'Cross-tab: the selected column(s) are not part of this result — re-check section 8.' };
  }

  const rowKeyCols = groupBy.filter((c) => c !== cfg.colDim);

  const distinctSeen = new Set();
  const distinct = [];
  for (const row of rows) {
    const v = row[cfg.colDim];
    const key = String(v);
    if (!distinctSeen.has(key)) { distinctSeen.add(key); distinct.push(v); }
  }
  if (distinct.length > 40) {
    return {
      error: `Cross-tab: "${cfg.colDim}" has ${distinct.length} distinct values, more than the ` +
        '40 allowed — pick a column with fewer distinct values.',
    };
  }
  const sortedDistinct = [...distinct].sort((a, b) => String(a).localeCompare(String(b)));
  const bucketColNames = sortedDistinct.map((v) => `${cfg.valueCol} — ${v}`);

  // `rows` are already-aggregated group results, so bucket values collided under one (row,
  // colDim-value) pair are themselves aggregates, not raw source numbers. Re-combining a
  // handful of "count" sub-totals must SUM them (aggregateValues(vals,'count') would instead
  // return vals.length, i.e. how many buckets collided, discarding the real counts) — every
  // other fn is safe to reuse as-is because summing/averaging/min/max of aggregates that share
  // the same fn is the correct re-combination for this structurally-single-collision case.
  const fn = getAgg(cfg.valueCol);
  // Count-distinct sub-totals collide across buckets the same way plain counts do — sum them
  // too, rather than re-running distinct-count semantics over already-aggregated numbers.
  const combineFn = (fn === 'count' || fn === 'countDistinct') ? 'sum' : fn;
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const key = rowKeyCols.map((c) => row[c]).join('');
    let entry = groups.get(key);
    if (!entry) {
      entry = { row: {}, buckets: new Map() };
      for (const c of rowKeyCols) entry.row[c] = row[c];
      groups.set(key, entry);
      order.push(key);
    }
    const dv = String(row[cfg.colDim]);
    if (!entry.buckets.has(dv)) entry.buckets.set(dv, []);
    entry.buckets.get(dv).push(row[cfg.valueCol]);
  }

  const outRows = order.map((key) => {
    const entry = groups.get(key);
    const out = { ...entry.row };
    sortedDistinct.forEach((v, i) => {
      const vals = entry.buckets.get(String(v)) || [];
      out[bucketColNames[i]] = vals.length ? aggregateValues(vals, combineFn) : 0;
    });
    return out;
  });

  return { rows: outRows, cols: [...rowKeyCols, ...bucketColNames] };
}

function updateSelectors() {
  fillSelect(joinLeftKeySelect, columns.filter((c) => !addedLookupCols.includes(c)));
  fillSelect(joinRightKeySelect, lookupColumns);
  const metrics = checkedValues('metric');
  for (const sel of document.querySelectorAll('.dInsert')) {
    fillSelect(sel, metrics, 'Insert column…');
  }
  for (const sel of document.querySelectorAll('.cmValueCol')) {
    fillSelect(sel, numericColumns, '(choose column)');
  }
  for (const sel of document.querySelectorAll('.ccCol')) {
    fillSelect(sel, columns);
  }
  const sources = calcSourceNames();
  for (const sel of document.querySelectorAll('.lrCol')) {
    fillSelect(sel, sources);
  }
  const outCols = outputColumnNames();
  for (const sel of document.querySelectorAll('.fCol')) {
    fillSelect(sel, outCols);
  }
  fillSelect(sortColSelect, outCols, '(none — original order)');
  fillSelect(kpiColSelect, numericOutputNames(), '(auto — top numeric column)');
  fillSelect(pivotColDimSelect, outputColumnNames(), '(none)');
  fillSelect(pivotValueColSelect, numericOutputNames(), '(none)');
  fillSelect(vizXColSelect, outputColumnNames(), '(none)');
  fillSelect(vizValueColSelect, numericOutputNames(), '(none)');
  fillSelect(vizSeriesColSelect, outputColumnNames(), '(none)');
  fillSelect(colorScaleColSelect, numericOutputNames(), '(none)');
  for (const sel of document.querySelectorAll('.fmtCol')) {
    fillSelect(sel, outCols);
  }
  refreshChipBar();
}

/* --- formula chips (drag into a formula, or click to insert) --- */

let lastFormulaInput = null;

function insertIntoFormula(text) {
  let target = lastFormulaInput && document.contains(lastFormulaInput)
    ? lastFormulaInput
    : document.querySelector('.dFormula');
  if (!target) return;
  const pos = target.selectionStart ?? target.value.length;
  target.value = target.value.slice(0, pos) + text + target.value.slice(pos);
  target.focus();
  target.setSelectionRange(pos + text.length, pos + text.length);
  resetResults();
}

function refreshChipBar() {
  const chipBar = document.getElementById('chipBar');
  const chipRow = document.getElementById('chipRow');
  const metrics = checkedValues('metric');
  const condNames = readCondMetrics().map((c) => c.name).filter(Boolean);
  const calcNames = readDerived().map((d) => d.name).filter(Boolean);
  chipRow.innerHTML = '';
  if (metrics.length === 0 && condNames.length === 0 && calcNames.length === 0) {
    chipBar.hidden = true;
    return;
  }
  chipBar.hidden = false;
  for (const { name, cls } of [
    ...metrics.map((m) => ({ name: m, cls: '' })),
    ...condNames.map((c) => ({ name: c, cls: 'calc' })),
    ...calcNames.map((c) => ({ name: c, cls: 'calc' })),
  ]) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (cls ? ' ' + cls : '');
    chip.textContent = `[${name}]`;
    chip.draggable = true;
    chip.title = 'Drag into a formula, or click to insert at the cursor';
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', `[${name}]`);
    });
    chip.addEventListener('click', () => insertIntoFormula(`[${name}]`));
    chipRow.appendChild(chip);
  }
}

/* --- display formats for result columns --- */

const FORMAT_TYPES = ['number', 'percent', 'text'];

function addFormatRow(preset) {
  const row = document.createElement('div');
  row.className = 'configRow formatRow';

  const col = makeSelect(outputColumnNames(), preset?.col, 'fmtCol');
  const type = makeSelect(FORMAT_TYPES, preset?.type || 'number', 'fmtType');
  const dec = makeSelect(['0', '1', '2', '3', '4'], String(preset?.decimals ?? 2), 'fmtDec');
  const decLabel = document.createElement('label');
  decLabel.appendChild(document.createTextNode('decimals:'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => { row.remove(); resetResults(); });

  row.append(document.createTextNode('Show'), col, document.createTextNode('as'), type, decLabel, dec, remove);
  document.getElementById('formatList').appendChild(row);
}

function readFormats() {
  return [...document.querySelectorAll('.formatRow')].map((row) => ({
    col: row.querySelector('.fmtCol').value,
    type: row.querySelector('.fmtType').value,
    decimals: Number(row.querySelector('.fmtDec').value),
  }));
}

function formatMap() {
  const map = new Map();
  for (const f of readFormats()) {
    if (f.col) map.set(f.col, f);
  }
  return map;
}

function formatDisplay(v, fmt) {
  if (!fmt) return v;
  if (fmt.type === 'text') return String(v);
  if (typeof v !== 'number' || !isFinite(v)) return v;
  if (fmt.type === 'percent') return v.toFixed(fmt.decimals) + '%';
  return v.toLocaleString('en-US', { minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals });
}

// Pre-fill the classic CSM delist configuration when its columns are present
function applyCsmPresetIfPossible() {
  const need = ['SKU', 'Store Code', 'Product Name', 'Qty Ordered', 'Qty Shipped', 'QTY Canceled'];
  const lower = new Map(columns.map((c) => [c.trim().toLowerCase(), c]));
  const found = need.map((c) => lower.get(c.toLowerCase()));
  if (found.some((c) => c === undefined)) return;
  const [sku, store, product, ordered, shipped] = found;

  // No default filters: the prefill only sets up grouping and %OOS so every group shows;
  // add conditions in section 7 (e.g. %OOS >= 100) or load a saved preset for the delist list.
  applyConfig({
    groupBy: [sku, store, product],
    metrics: [found[3], found[4], found[5]],
    derived: [{ name: '%OOS', formula: `([${ordered}] - [${shipped}]) / [${ordered}] * 100` }],
    labels: [],
    filters: [],
    sortCol: ordered,
    sortDir: 'desc',
  });
  setStatus('CSM export detected — pre-filled grouping and %OOS with no filters (add conditions in section 7, e.g. %OOS >= 100 for delist candidates, or load a saved preset).');
}

/* ---------- aggregation choice & KPI tiles (core) ---------- */

function makeAggSelect(col) {
  const sel = document.createElement('select');
  sel.className = 'aggSel';
  sel.dataset.col = col;
  for (const opt of [
    ['sum', 'Sum'],
    ['count', 'Count'],
    ['countDistinct', 'Count distinct'],
    ['avg', 'Average'],
    ['min', 'Min'],
    ['max', 'Max'],
  ]) {
    const o = document.createElement('option');
    o.value = opt[0];
    o.textContent = opt[1];
    sel.appendChild(o);
  }
  sel.value = 'sum';
  sel.addEventListener('change', resetResults);
  return sel;
}

function readAggs() {
  const map = {};
  for (const sel of document.querySelectorAll('.aggSel')) {
    map[sel.dataset.col] = sel.value;
  }
  return map;
}

function getAgg(col) {
  return readAggs()[col] || 'sum';
}

function aggregateValues(vals, fn) {
  const nonBlank = vals.filter((v) => v !== '' && v !== null && v !== undefined);
  const nums = nonBlank
    .map((v) => Number(v))
    .filter((v) => !isNaN(v));
  switch (fn) {
    // Skip blanks, matching avg/min/max below (and Excel's own COUNT) rather than counting
    // every row in the group regardless of whether the metric cell was empty.
    case 'count': return nonBlank.length;
    case 'countDistinct': {
      const seen = new Set(nonBlank.map((v) => String(v)));
      return seen.size;
    }
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'sum':
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

// Numeric columns produced in the result: checked metrics + calculated columns (always numeric)
function numericOutputNames() {
  return calcSourceNames();
}

// Whether `col` holds numeric values across `rows` (blanks ignored)
function isNumericCol(rows, col) {
  let seen = 0;
  for (const row of rows) {
    const v = row[col];
    if (v === '' || v === null || v === undefined) continue;
    seen++;
    if (typeof v !== 'number' && isNaN(Number(v))) return false;
  }
  return seen > 0;
}

function applyTopN(rows) {
  const n = Math.floor(Number(topNInput.value));
  if (!n || n < 1) return rows;
  return rows.slice(0, n);
}

function formatKpiNumber(n) {
  if (!isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString();
}

function renderKpis(rows, cols, groupBy) {
  kpiBar.innerHTML = '';
  if (!rows || rows.length === 0) return;
  const numericCols = cols.filter((c) => isNumericCol(rows, c));
  const kpiCol = kpiColSelect.value && numericCols.includes(kpiColSelect.value)
    ? kpiColSelect.value
    : numericCols[0];

  const tiles = [{ label: 'Groups', value: String(rows.length) }];
  if (kpiCol) {
    let total = 0, count = 0, topRow = null, topVal = -Infinity;
    let idCols = (groupBy || []).filter((c) => cols.includes(c) && c !== kpiCol);
    if (idCols.length === 0) idCols = [cols.find((c) => c !== kpiCol) || kpiCol];
    for (const row of rows) {
      const v = Number(row[kpiCol]);
      if (isNaN(v)) continue;
      total += v;
      count++;
      if (v > topVal) { topVal = v; topRow = row; }
    }
    tiles.push({ label: `Total ${kpiCol}`, value: formatKpiNumber(total) });
    if (count > 0) {
      const idLabel = idCols.map((c) => topRow[c]).join(' / ');
      tiles.push({ label: `Average ${kpiCol}`, value: formatKpiNumber(total / count) });
      tiles.push({ label: `Top ${kpiCol}`, value: `${idLabel} — ${formatKpiNumber(topVal)}` });
    }
  }
  for (const t of tiles) {
    const tile = document.createElement('div');
    tile.className = 'kpiTile';
    const val = document.createElement('div');
    val.className = 'kpiValue';
    val.textContent = t.value;
    const label = document.createElement('div');
    label.className = 'kpiLabel';
    label.textContent = t.label;
    tile.append(val, label);
    kpiBar.appendChild(tile);
  }
}

/* ---------- date bucketing ---------- */

// Memoized result of scanning the .gran selects; cleared by resetResults() (called on every
// config-changing action, including the top of runAnalysis()) so a run always sees fresh
// granularity choices without re-scanning the DOM for every row x group-by column.
let dateBucketsCache = null;

// Reads the .gran selects into { groupByCol: "day"|"week"|"month" } (only non-"(none)" entries)
function readDateBuckets() {
  if (dateBucketsCache) return dateBucketsCache;
  const out = {};
  for (const sel of document.querySelectorAll('.gran')) {
    const col = sel.dataset.col;
    const v = sel.value;
    if (col && v && v !== '(none)') out[col] = v;
  }
  dateBucketsCache = out;
  return out;
}

function dateBucketCols() {
  return Object.keys(readDateBuckets());
}

// Accepts an Excel serial date number, a date-like string, or a Date; returns a JS Date or null.
// Serial numbers at or below 10000 (~1927-05-18) are treated as plain numbers, not dates, so a
// bare small number or a 4-digit year-like string passes through bucketValue unchanged instead of
// resolving to a bogus early-1900s date.
function parseCellDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && isFinite(v)) {
    if (v <= 10000) return null;
    const d = new Date(Math.round((v - 25569) * 86400000));
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const num = Number(s);
      if (num > 10000 && num < 100000) {
        const d = new Date(Math.round((num - 25569) * 86400000));
        if (!isNaN(d.getTime())) return d;
      }
      return null; // not a plausible Excel serial, and a bare number isn't a date string either
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    // ISO date-only/date-time strings ("YYYY-MM-DD...") already parse as UTC. Anything else (e.g.
    // "1/5/2026", "Jan 5 2026") parses in the BROWSER'S LOCAL time zone, but formatBucket() below
    // reads the result back with getUTC*() — in any UTC+ zone that silently shifts the bucketed
    // day (and can cross month/year boundaries) versus the date the string named. Re-anchor the
    // local wall-clock reading onto UTC so formatBucket sees the same Y/M/D the string named.
    if (/^\d{4}-\d{2}/.test(s)) return d;
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
  }
  return null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// ISO 8601 week label, e.g. "2026-W28"
function isoWeekLabel(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${pad2(week)}`;
}

function formatBucket(d, gran) {
  const Y = d.getUTCFullYear();
  const M = pad2(d.getUTCMonth() + 1);
  const D = pad2(d.getUTCDate());
  if (gran === 'month') return `${Y}-${M}`;
  if (gran === 'week') return isoWeekLabel(d);
  return `${Y}-${M}-${D}`;
}

// Formats row[col] into its configured bucket label; returns the raw value unchanged when the
// column isn't bucketed or the value can't be parsed as a date.
function bucketValue(col, rawValue) {
  const gran = readDateBuckets()[col];
  if (!gran) return rawValue;
  const d = parseCellDate(rawValue);
  if (!d) return rawValue;
  return formatBucket(d, gran);
}

/* ---------- lookup join (optional second file, joined before grouping) ---------- */

function loadLookupFile(file) {
  lookupWorkbook = null;
  lookupRows = [];
  lookupColumns = [];
  lookupNumeric = [];
  lookupSheetSelect.innerHTML = '';
  lookupSheetSelect.disabled = true;
  lookupFileNameEl.textContent = file.name;
  resetResults();
  setStatus('Reading lookup file...');

  const reader = new FileReader();
  reader.onerror = () => setStatus('Could not read the lookup file.', 'error');
  reader.onload = (e) => {
    try {
      lookupWorkbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
    } catch (err) {
      setStatus('Lookup file is not a valid spreadsheet: ' + err.message, 'error');
      return;
    }
    lookupSheetSelect.innerHTML = '';
    for (const name of lookupWorkbook.SheetNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      lookupSheetSelect.appendChild(opt);
    }
    if (pendingJoinConfig && pendingJoinConfig.sheet && lookupWorkbook.SheetNames.includes(pendingJoinConfig.sheet)) {
      lookupSheetSelect.value = pendingJoinConfig.sheet;
    }
    lookupSheetSelect.disabled = false;
    loadLookupSheet();
  };
  reader.readAsArrayBuffer(file);
}

function loadLookupSheet() {
  resetResults();
  const sheetName = lookupSheetSelect.value;
  if (!lookupWorkbook || !sheetName) return;
  lookupRows = XLSX.utils.sheet_to_json(lookupWorkbook.Sheets[sheetName], { defval: '' });
  if (lookupRows.length === 0) {
    lookupColumns = [];
    lookupNumeric = [];
    buildJoinColsBox();
    registerLookupColumnsIntoGlobal(); // strips any columns registered from a previously loaded lookup sheet
    setStatus(`Lookup sheet "${sheetName}" is empty — pick another sheet.`, 'error');
    return;
  }
  lookupColumns = Object.keys(lookupRows[0]);
  // A lookup column counts as numeric when every non-empty sampled value parses as a number
  lookupNumeric = lookupColumns.filter((col) => {
    let seen = 0;
    for (const row of lookupRows.slice(0, 200)) {
      const v = row[col];
      if (v === '' || v === null || v === undefined) continue;
      seen++;
      if (typeof v !== 'number' && isNaN(Number(v))) return false;
    }
    return seen > 0;
  });

  const pend = pendingJoinConfig;
  const preselect = pend && pend.columns && pend.columns.length ? pend.columns : null;
  buildJoinColsBox(preselect);
  registerLookupColumnsIntoGlobal();

  if (pend) {
    if (lookupColumns.includes(pend.rightKey)) joinRightKeySelect.value = pend.rightKey;
    if (columns.includes(pend.leftKey)) joinLeftKeySelect.value = pend.leftKey;
    joinEnabledCb.checked = !!pend.enabled;
    pendingJoinConfig = null;
  }

  setStatus(
    `Lookup sheet "${sheetName}" loaded: ${lookupRows.length} rows, ${lookupColumns.length} columns available to join.`,
    'success'
  );
}

// Checkbox list of lookup columns to pull into each row. Defaults to "checked" unless `selected`
// (from a restored preset) says otherwise, EXCEPT a lookup column whose name collides with a
// column the main file already has — that defaults to unchecked so it can't silently overwrite
// real data; the user can still opt in explicitly.
function buildJoinColsBox(selected) {
  joinColsBox.innerHTML = '';
  if (lookupColumns.length === 0) {
    joinColsBox.innerHTML = '<span class="muted">Load a lookup file first.</span>';
    return;
  }
  for (const col of lookupColumns) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'joinCol';
    cb.value = col;
    cb.checked = selected ? selected.includes(col) : !columns.includes(col);
    cb.addEventListener('change', () => { pendingJoinConfig = null; resetResults(); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(col));
    if (columns.includes(col)) {
      const note = document.createElement('span');
      note.className = 'muted';
      note.style.marginLeft = '4px';
      note.textContent = '(name matches a main column)';
      label.appendChild(note);
    }
    joinColsBox.appendChild(label);
  }
}

// Makes every lookup column pickable as a group-by / metric / formula source column, replacing
// whatever lookup columns were registered from a previous file/sheet. buildColumnPickers() wipes
// group-by/metric checkboxes AND the conditional-metric / calculated-column / category-column /
// filter lists (it always has, even on a plain main-sheet reload) — but here the column set only
// ever grows, so wiping the user's section 4/5/6/7 config would be a regression, not a
// consequence of columns actually changing shape. Capture everything beforehand and restore it
// after, mirroring applyConfig()'s own restore ordering (groupby/metric -> conditional metrics ->
// derived -> labels -> filters -> sort, with updateSelectors() between each so later rows can see
// earlier ones' names).
function registerLookupColumnsIntoGlobal() {
  columns = columns.filter((c) => !addedLookupCols.includes(c));
  numericColumns = numericColumns.filter((c) => !addedLookupCols.includes(c));

  const newCols = lookupColumns.filter((c) => !columns.includes(c));
  columns = [...columns, ...newCols];
  numericColumns = [...numericColumns, ...newCols.filter((c) => lookupNumeric.includes(c))];
  addedLookupCols = newCols;

  const gb = checkedValues('groupby');
  const mt = checkedValues('metric');
  const condMetrics = readCondMetrics();
  const derived = readDerived();
  const labels = readLabels();
  const filters = readFilters();
  const formats = readFormats();
  const sortCol = sortColSelect.value;
  const sortDir = sortDirSelect.value;

  buildColumnPickers();
  setChecked('groupby', gb);
  setChecked('metric', mt);
  updateSelectors();
  for (const c of condMetrics) addCondMetricBlock(c);
  updateSelectors();
  for (const d of derived) addDerivedRow(d);
  updateSelectors();
  for (const l of labels) addLabelBlock(l);
  updateSelectors();
  for (const f of filters) addFilterRow(f);
  updateSelectors();
  for (const f of formats) addFormatRow(f);
  updateSelectors();
  if (sortCol && outputColumnNames().includes(sortCol)) sortColSelect.value = sortCol;
  sortDirSelect.value = sortDir === 'asc' ? 'asc' : 'desc';
}

function readJoinConfig() {
  return {
    enabled: joinEnabledCb.checked,
    sheet: lookupSheetSelect.value || '',
    leftKey: joinLeftKeySelect.value || '',
    rightKey: joinRightKeySelect.value || '',
    columns: [...joinColsBox.querySelectorAll('.joinCol:checked')].map((cb) => cb.value),
  };
}

// Applies a saved join config to the UI. Works even when no lookup file is loaded yet — in that
// case it stashes the intent in `pendingJoinConfig`, which loadLookupSheet() consults once a
// matching lookup file/sheet is actually loaded. A config with no meaningful join content (e.g.
// `{}` from a legacy preset, or the blank join object every preset now carries via
// collectConfig() even when the user never touched section 7) must NOT be stashed — otherwise it
// would later stomp a join the user configures manually after this call (see applyConfig(), which
// runs this before the rest of the preset/auto-preset restore).
function applyJoinConfigToUI(cfg) {
  joinEnabledCb.checked = !!cfg.enabled;
  if (cfg.leftKey && columns.includes(cfg.leftKey)) joinLeftKeySelect.value = cfg.leftKey;
  if (cfg.rightKey && lookupColumns.includes(cfg.rightKey)) joinRightKeySelect.value = cfg.rightKey;
  if (lookupColumns.length > 0) {
    for (const cb of joinColsBox.querySelectorAll('.joinCol')) {
      cb.checked = (cfg.columns || []).includes(cb.value);
    }
  }
  const meaningful = !!(cfg.enabled || cfg.leftKey || cfg.rightKey || (cfg.columns || []).length);
  pendingJoinConfig = meaningful ? cfg : null;
}

// LEFT join of `rows` onto the lookup sheet by leftKey==rightKey, first match wins, blank on
// miss. Returns `rows` unchanged (a no-op) whenever the join is disabled or not fully configured
// — never throws; instead records a non-fatal message in `joinWarning` for runAnalysis to surface.
function applyJoin(rows) {
  joinWarning = '';
  joinWarningLevel = '';
  const cfg = readJoinConfig();
  if (!cfg.enabled) return rows;
  if (!lookupWorkbook || lookupRows.length === 0) {
    joinWarning = '(Lookup join is enabled but no lookup file/sheet is loaded — join was skipped.)';
    joinWarningLevel = 'error';
    return rows;
  }
  if (!cfg.leftKey || !cfg.rightKey) {
    joinWarning = '(Lookup join is enabled but the match columns are not both set — join was skipped.)';
    joinWarningLevel = 'error';
    return rows;
  }
  if (cfg.columns.length === 0) {
    joinWarning = '(Lookup join is enabled but no lookup columns are selected to bring in — join was skipped.)';
    joinWarningLevel = 'error';
    return rows;
  }
  // Keys are normalized with String(...).trim() on both sides so common export quirks
  // (numeric vs text codes, stray whitespace) don't cause silent 100%-miss joins.
  const index = new Map();
  let duplicateKeys = 0;
  for (const lrow of lookupRows) {
    const k = String(lrow[cfg.rightKey]).trim();
    if (index.has(k)) duplicateKeys++;
    else index.set(k, lrow);
  }
  let matched = 0;
  const out = rows.map((row) => {
    const match = index.get(String(row[cfg.leftKey]).trim());
    if (match) matched++;
    const outRow = { ...row };
    for (const c of cfg.columns) {
      outRow[c] = match ? match[c] : '';
    }
    return outRow;
  });

  const total = rows.length;
  const dupNote = duplicateKeys > 0
    ? ` ${duplicateKeys} duplicate key${duplicateKeys === 1 ? '' : 's'} in lookup, first match used.`
    : '';
  if (total > 0 && matched === 0) {
    joinWarning = `Matched 0 of ${total} rows — check that the key columns have the same format.${dupNote}`;
    joinWarningLevel = 'warning';
  } else {
    joinWarning = `Joined ${matched} of ${total} rows.${dupNote}`;
    joinWarningLevel = 'info';
  }
  return out;
}

/* ---------- charts & conditional formatting (viz) ---------- */

// 13 colors so the series cap's worst case (12 kept + "Other") never repeats a color
const VIZ_PALETTE = [
  '#2d6cdf', '#3a7d44', '#d98c2b', '#a15cc4', '#c94f4f', '#3aa0a0', '#c9a53a', '#6b7bd6',
  '#d46a9e', '#8ab84a', '#b08968', '#9e9e9e', '#54b8e0',
];

let vizChartInstance = null;

function readVizConfig() {
  const type = vizChartTypeSelect.value;
  const axisMinRaw = vizAxisMinInput.value.trim();
  const axisMaxRaw = vizAxisMaxInput.value.trim();
  return {
    chart: {
      type: ['bar', 'barh', 'pie', 'line'].includes(type) ? type : 'none',
      xCol: vizXColSelect.value || '',
      valueCol: vizValueColSelect.value || '',
      topN: vizTopNInput.value ? Number(vizTopNInput.value) : 10,
      excludeBlank: document.getElementById('vizExcludeBlank').checked,
      excludeTotals: document.getElementById('vizExcludeTotals').checked,
      axisMin: axisMinRaw !== '' && !isNaN(Number(axisMinRaw)) ? Number(axisMinRaw) : null,
      axisMax: axisMaxRaw !== '' && !isNaN(Number(axisMaxRaw)) ? Number(axisMaxRaw) : null,
      unit: ['K', 'M', '%'].includes(vizAxisUnitSelect.value) ? vizAxisUnitSelect.value : 'none',
      seriesCol: vizSeriesColSelect.value || '',
      stacked: vizStackedCb.checked,
    },
    colorScale: {
      enabled: colorScaleEnabledCb.checked,
      col: colorScaleColSelect.value || '',
    },
  };
}

function destroyVizChart() {
  if (vizChartInstance) {
    vizChartInstance.destroy();
    vizChartInstance = null;
  }
}

// Renders (or clears) the chart below the preview table. Preview-only — never written to the
// downloaded .xlsx. Destroys any prior Chart.js instance before drawing a new one.
// Total/subtotal rows in retail exports, in English and Thai (รวม = total)
const TOTAL_ROW_RE = /\b(grand\s+)?(sub)?total(s)?\b|\bsum\b|รวม/i;

function renderCharts(rows, cols) {
  destroyVizChart();
  if (typeof Chart === 'undefined') return;
  const cfg = readVizConfig().chart;
  if (!rows || rows.length === 0 || cfg.type === 'none' || !cfg.xCol || !cfg.valueCol) return;
  if (!cols.includes(cfg.xCol) || !cols.includes(cfg.valueCol)) return;

  // A series column splits bar/line charts into one dataset per distinct value; pie ignores it.
  // Series by = the X column is degenerate (one-hot chart), so it is ignored with a note.
  const seriesCol = cfg.type !== 'pie' && cfg.seriesCol && cfg.seriesCol !== cfg.xCol && cols.includes(cfg.seriesCol)
    ? cfg.seriesCol : '';

  // Chart-only exclusions — the result table and download are untouched
  const before = rows.length;
  if (cfg.excludeBlank) {
    rows = rows.filter((r) =>
      String(r[cfg.xCol]).trim() !== '' && (!seriesCol || String(r[seriesCol]).trim() !== ''));
  }
  if (cfg.excludeTotals) {
    rows = rows.filter((r) => !TOTAL_ROW_RE.test(String(r[cfg.xCol])));
  }
  const excluded = before - rows.length;
  const notes = [];
  if (excluded > 0) notes.push(`${excluded} row(s) excluded from the chart (blank/total). The table and download still include them.`);
  if (cfg.type !== 'pie' && cfg.seriesCol && cfg.seriesCol === cfg.xCol) notes.push('"Series by" is ignored because it is the same column as the X axis.');
  document.getElementById('chartNote').textContent = notes.join(' ');
  if (rows.length === 0) return;

  const horizontal = cfg.type === 'barh';

  let labels, datasets;
  if (cfg.type === 'pie') {
    const totals = new Map();
    for (const row of rows) {
      const k = String(row[cfg.xCol]);
      totals.set(k, (totals.get(k) || 0) + (Number(row[cfg.valueCol]) || 0));
    }
    labels = [...totals.keys()];
    const colors = labels.map((_, i) => VIZ_PALETTE[i % VIZ_PALETTE.length]);
    datasets = [{
      label: cfg.valueCol,
      data: [...totals.values()],
      backgroundColor: colors,
      borderColor: colors,
    }];
  } else if (seriesCol) {
    // Sum per (x value, series value); series colored by VIZ_PALETTE in first-seen order
    const xTotals = new Map();      // x -> total across all series (drives Top N ranking)
    const seriesTotals = new Map(); // series -> total (drives the 12-series cap)
    const cells = new Map();        // x -> Map(series -> sum)
    for (const row of rows) {
      const x = String(row[cfg.xCol]);
      const sRaw = String(row[seriesCol]);
      // Blank series values (defval:'' / unmatched join rows) get a visible legend label
      const s = sRaw.trim() === '' ? '(blank)' : sRaw;
      const v = Number(row[cfg.valueCol]) || 0;
      xTotals.set(x, (xTotals.get(x) || 0) + v);
      seriesTotals.set(s, (seriesTotals.get(s) || 0) + v);
      if (!cells.has(x)) cells.set(x, new Map());
      const cell = cells.get(x);
      cell.set(s, (cell.get(s) || 0) + v);
    }

    // Cap at 12 distinct series: keep the 12 largest by total, fold the rest into "Other"
    const MAX_SERIES = 12;
    let seriesNames = [...seriesTotals.keys()];
    if (seriesNames.length > MAX_SERIES) {
      const keep = new Set(
        [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERIES).map((e) => e[0])
      );
      for (const cell of cells.values()) {
        let other = 0;
        for (const [s, v] of [...cell.entries()]) {
          if (!keep.has(s)) { other += v; cell.delete(s); }
        }
        if (other !== 0) cell.set('Other', (cell.get('Other') || 0) + other);
      }
      // Set dedup: if a real series named "Other" was kept, the folded remainder is merged
      // into it (line above) and it must appear only once here — never as two datasets.
      seriesNames = [...new Set([...seriesNames.filter((s) => keep.has(s)), 'Other'])];
    }

    if (cfg.type === 'line') {
      labels = [...xTotals.keys()].sort((a, b) => a.localeCompare(b));
    } else {
      // Top N categories ranked by TOTAL across all series
      const n = cfg.topN && cfg.topN > 0 ? Math.floor(cfg.topN) : 10;
      labels = [...xTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
    }
    datasets = seriesNames.map((s, i) => {
      const color = VIZ_PALETTE[i % VIZ_PALETTE.length];
      return {
        label: s,
        data: labels.map((x) => (cells.get(x) && cells.get(x).get(s)) || 0),
        backgroundColor: color,
        borderColor: color,
        fill: false,
        tension: 0.25,
      };
    });
  } else if (cfg.type === 'line') {
    const sorted = [...rows].sort((a, b) => String(a[cfg.xCol]).localeCompare(String(b[cfg.xCol])));
    labels = sorted.map((r) => String(r[cfg.xCol]));
    datasets = [{
      label: cfg.valueCol,
      data: sorted.map((r) => Number(r[cfg.valueCol]) || 0),
      backgroundColor: '#2d6cdf',
      borderColor: '#2d6cdf',
      fill: false,
      tension: 0.25,
    }];
  } else {
    const n = cfg.topN && cfg.topN > 0 ? Math.floor(cfg.topN) : 10;
    const sorted = [...rows].sort((a, b) => (Number(b[cfg.valueCol]) || 0) - (Number(a[cfg.valueCol]) || 0));
    const top = sorted.slice(0, n);
    labels = top.map((r) => String(r[cfg.xCol]));
    const colors = labels.map((_, i) => VIZ_PALETTE[i % VIZ_PALETTE.length]);
    datasets = [{
      label: cfg.valueCol,
      data: top.map((r) => Number(r[cfg.valueCol]) || 0),
      backgroundColor: colors,
      borderColor: colors,
      fill: false,
      tension: 0.25,
    }];
  }
  if (labels.length === 0) return;

  const textColor = '#bbb';
  const gridColor = '#3a3a3a';
  const unit = cfg.unit;

  let scales = {};
  if (cfg.type !== 'pie') {
    // The value axis is y for vertical bars/line, x for horizontal bars
    const valueAxis = horizontal ? 'x' : 'y';
    const catAxis = horizontal ? 'y' : 'x';
    const stacked = !!seriesCol && cfg.stacked;
    // Ignore min/max if min >= max — fall back to auto rather than a broken axis
    let axisMin = cfg.axisMin;
    let axisMax = cfg.axisMax;
    if (axisMin !== null && axisMax !== null && axisMin >= axisMax) {
      axisMin = null;
      axisMax = null;
    }
    scales[catAxis] = { stacked, ticks: { color: textColor }, grid: { color: gridColor } };
    scales[valueAxis] = {
      stacked,
      ticks: { color: textColor, callback: (v) => formatVizValue(v, unit) },
      grid: { color: gridColor },
    };
    if (axisMin !== null) scales[valueAxis].min = axisMin;
    if (axisMax !== null) scales[valueAxis].max = axisMax;
  }

  chartArea.hidden = false;
  vizChartInstance = new Chart(vizCanvas, {
    type: cfg.type === 'pie' ? 'pie' : cfg.type === 'line' ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: cfg.type === 'pie' || datasets.length > 1, labels: { color: textColor } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = cfg.type === 'pie' ? ctx.parsed : (horizontal ? ctx.parsed.x : ctx.parsed.y);
              return `${ctx.dataset.label}: ${formatVizValue(v, unit)}`;
            },
          },
        },
      },
      scales,
    },
  });
}

// Formats a chart value for axis ticks and tooltips per the Unit select:
// K divides by 1e3, M by 1e6, % appends "%" without scaling. Preview-only.
function formatVizValue(v, unit) {
  if (typeof v !== 'number' || isNaN(v)) return String(v);
  const opts = { maximumFractionDigits: 2 };
  if (unit === 'K') return (v / 1e3).toLocaleString(undefined, opts) + 'K';
  if (unit === 'M') return (v / 1e6).toLocaleString(undefined, opts) + 'M';
  if (unit === '%') return v.toLocaleString(undefined, opts) + '%';
  return v.toLocaleString(undefined, opts);
}

// Low -> high sequential interpolation between the shared dark-theme color-scale endpoints
function colorScaleColor(t) {
  const lo = [0x26, 0x30, 0x4a];
  const hi = [0x2d, 0x6c, 0xdf];
  const rgb = lo.map((c, i) => Math.round(c + (hi[i] - c) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

// Color-scales the chosen numeric column's cells in the just-rendered #previewWrap table
// (low -> high). Preview-only — never written to the downloaded .xlsx.
function applyConditionalFormatting() {
  const cfg = readVizConfig().colorScale;
  if (!cfg.enabled || !cfg.col) return;
  if (!resultRows || resultRows.length === 0 || !outputCols.includes(cfg.col)) return;
  if (!isNumericCol(resultRows, cfg.col)) return;

  const table = previewWrap.querySelector('table');
  if (!table || !table.tBodies[0]) return;
  const colIdx = outputCols.indexOf(cfg.col);
  if (colIdx === -1) return;

  const nums = resultRows.slice(0, PREVIEW_LIMIT)
    .map((r) => Number(r[cfg.col]))
    .filter((v) => !isNaN(v));
  if (nums.length === 0) return;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;

  // Read values from resultRows, not the cell text — display formats may have
  // rewritten cells as strings like "1,234.00" or "50.0%"
  const bodyRows = [...table.tBodies[0].rows];
  for (let i = 0; i < bodyRows.length; i++) {
    const td = bodyRows[i].cells[colIdx];
    const src = resultRows[i];
    if (!td || !src) continue;
    const v = Number(src[cfg.col]);
    if (isNaN(v) || src[cfg.col] === '') continue;
    const t = span === 0 ? 1 : (v - min) / span;
    td.style.background = colorScaleColor(t);
    td.classList.add('colorScaleCell');
  }
}

/* ---------- presets (saved in this browser via localStorage) ---------- */

const PRESET_KEY = 'ega_presets_v1';

function getPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY)) || {};
  } catch {
    return {};
  }
}

function refreshPresetSelect(selected) {
  presetSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— load a saved preset —';
  presetSelect.appendChild(placeholder);
  for (const name of Object.keys(getPresets()).sort()) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    presetSelect.appendChild(o);
  }
  presetSelect.value = selected && getPresets()[selected] ? selected : '';
}

function collectConfig() {
  return {
    join: readJoinConfig(),
    groupBy: checkedValues('groupby'),
    metrics: checkedValues('metric'),
    condMetrics: readCondMetrics(),
    derived: readDerived(),
    labels: readLabels(),
    filters: readFilters(),
    sortCol: sortColSelect.value,
    sortDir: sortDirSelect.value,
    dateBuckets: readDateBuckets(),
    aggs: readAggs(),
    topN: topNInput.value ? Number(topNInput.value) : 0,
    totalRow: document.getElementById('totalRowEnabled').checked,
    avgRow: document.getElementById('avgRowEnabled').checked,
    kpiCol: kpiColSelect.value,
    pivot: readPivotConfig(),
    viz: readVizConfig(),
    formats: readFormats(),
  };
}

// Applies a saved config to the currently loaded file; returns column names it couldn't find
function applyConfig(cfg) {
  resetResults();
  applyJoinConfigToUI(cfg.join || {});
  setChecked('groupby', cfg.groupBy || []);
  setChecked('metric', cfg.metrics || []);
  const dateBuckets = cfg.dateBuckets || {};
  for (const sel of document.querySelectorAll('.gran')) {
    sel.value = dateBuckets[sel.dataset.col] || '(none)';
  }
  dateBucketsCache = null;
  for (const sel of document.querySelectorAll('.aggSel')) {
    sel.value = (cfg.aggs && cfg.aggs[sel.dataset.col]) || 'sum';
  }
  condMetricList.innerHTML = '';
  derivedList.innerHTML = '';
  labelList.innerHTML = '';
  filterList.innerHTML = '';
  document.getElementById('formatList').innerHTML = '';
  updateSelectors();
  for (const c of cfg.condMetrics || []) addCondMetricBlock(c);
  updateSelectors();
  for (const d of cfg.derived || []) addDerivedRow(d);
  updateSelectors();
  for (const l of cfg.labels || []) addLabelBlock(l);
  updateSelectors();
  for (const f of cfg.filters || []) addFilterRow(f);
  updateSelectors();
  for (const f of cfg.formats || []) addFormatRow(f);
  updateSelectors();
  sortColSelect.value = (cfg.sortCol && outputColumnNames().includes(cfg.sortCol)) ? cfg.sortCol : '';
  sortDirSelect.value = cfg.sortDir === 'asc' ? 'asc' : 'desc';
  topNInput.value = cfg.topN ? String(cfg.topN) : '';
  document.getElementById('totalRowEnabled').checked = !!cfg.totalRow;
  document.getElementById('avgRowEnabled').checked = !!cfg.avgRow;
  if (cfg.kpiCol && numericOutputNames().includes(cfg.kpiCol)) kpiColSelect.value = cfg.kpiCol;
  const pivotCfg = cfg.pivot || {};
  pivotEnabledCheckbox.checked = !!pivotCfg.enabled;
  pivotColDimSelect.value = pivotCfg.colDim && outputColumnNames().includes(pivotCfg.colDim) ? pivotCfg.colDim : '';
  pivotValueColSelect.value = pivotCfg.valueCol && numericOutputNames().includes(pivotCfg.valueCol) ? pivotCfg.valueCol : '';
  const vizCfg = cfg.viz || {};
  const vc = vizCfg.chart || {};
  vizChartTypeSelect.value = ['bar', 'barh', 'pie', 'line'].includes(vc.type) ? vc.type : 'none';
  vizXColSelect.value = '';
  if (vc.xCol && outputColumnNames().includes(vc.xCol)) vizXColSelect.value = vc.xCol;
  vizValueColSelect.value = '';
  if (vc.valueCol && numericOutputNames().includes(vc.valueCol)) vizValueColSelect.value = vc.valueCol;
  vizTopNInput.value = vc.topN ? String(vc.topN) : '';
  document.getElementById('vizExcludeBlank').checked = !!vc.excludeBlank;
  document.getElementById('vizExcludeTotals').checked = !!vc.excludeTotals;
  // Old presets lack these fields — default to auto range, no unit, no series, unstacked
  vizAxisMinInput.value = typeof vc.axisMin === 'number' && !isNaN(vc.axisMin) ? String(vc.axisMin) : '';
  vizAxisMaxInput.value = typeof vc.axisMax === 'number' && !isNaN(vc.axisMax) ? String(vc.axisMax) : '';
  vizAxisUnitSelect.value = ['K', 'M', '%'].includes(vc.unit) ? vc.unit : 'none';
  vizSeriesColSelect.value = '';
  if (vc.seriesCol && outputColumnNames().includes(vc.seriesCol)) vizSeriesColSelect.value = vc.seriesCol;
  vizStackedCb.checked = !!vc.stacked;
  const csCfg = vizCfg.colorScale || {};
  colorScaleEnabledCb.checked = !!csCfg.enabled;
  colorScaleColSelect.value = '';
  if (csCfg.col && numericOutputNames().includes(csCfg.col)) colorScaleColSelect.value = csCfg.col;
  // Reopen an advanced section only if this config actually uses it — never hide settings the
  // config just switched on, but a config that leaves one untouched keeps it collapsed.
  document.getElementById('condMetricsBox').open = readCondMetrics().length > 0;
  document.getElementById('pivotBox').open = !!pivotCfg.enabled;
  document.getElementById('vizBox').open = vc.type && vc.type !== 'none';
  return [...(cfg.groupBy || []), ...(cfg.metrics || [])].filter((c) => !columns.includes(c));
}

function savePreset() {
  // A typed name wins; with the name box empty, save onto the preset selected in the dropdown
  const name = presetNameInput.value.trim() || presetSelect.value;
  if (!name) {
    setStatus('Type a name for a new preset, or select an existing preset to update it.', 'error');
    return;
  }
  const presets = getPresets();
  const isNew = !(name in presets);
  presets[name] = collectConfig();
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch (err) {
    setStatus('Could not save the preset — browser storage may be full or blocked.', 'error');
    return;
  }
  refreshPresetSelect(name);
  presetNameInput.value = '';
  setStatus(`Preset "${name}" ${isNew ? 'saved' : 'updated'}. It will be available next time you open this page in this browser.`, 'success');
}

function loadSelectedPreset() {
  const name = presetSelect.value;
  if (!name) return;
  const cfg = getPresets()[name];
  if (!cfg) return;
  const missing = applyConfig(cfg);
  if (missing.length > 0) {
    setStatus(
      `Preset "${name}" loaded, but this file is missing column(s) it uses: ${missing.join(', ')}. ` +
      'Those selections were skipped — review the setup before running.',
      'error'
    );
  } else {
    setStatus(`Preset "${name}" loaded. Review the setup and press Run Analysis.`, 'success');
  }
}

function deleteSelectedPreset() {
  const name = presetSelect.value;
  if (!name) {
    setStatus('Select the preset to delete first.', 'error');
    return;
  }
  const presets = getPresets();
  delete presets[name];
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch (err) {
    setStatus('Could not delete the preset — browser storage may be full or blocked.', 'error');
    return;
  }
  refreshPresetSelect();
  setStatus(`Preset "${name}" deleted.`, 'success');
}

function exportPresets() {
  const presets = getPresets();
  const count = Object.keys(presets).length;
  if (count === 0) {
    setStatus('No saved presets to export yet — save one first.', 'error');
    return;
  }
  const blob = new Blob([JSON.stringify({ ega_presets: presets }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Group-Analyze-Presets.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${count} preset(s) to Group-Analyze-Presets.json. Import it on any other computer.`, 'success');
}

function importPresetsFile(file) {
  const reader = new FileReader();
  reader.onerror = () => setStatus('Could not read the presets file.', 'error');
  reader.onload = (e) => {
    let incoming;
    try {
      const parsed = JSON.parse(e.target.result);
      incoming = parsed.ega_presets;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('wrong shape');
    } catch {
      setStatus('That is not a presets file — expected a Group-Analyze-Presets.json exported from this app.', 'error');
      return;
    }
    const presets = getPresets();
    let added = 0, replaced = 0;
    for (const [name, cfg] of Object.entries(incoming)) {
      if (typeof cfg !== 'object' || cfg === null) continue;
      if (name in presets) replaced++; else added++;
      presets[name] = cfg;
    }
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    } catch (err) {
      setStatus('Could not import presets — browser storage may be full or blocked.', 'error');
      return;
    }
    refreshPresetSelect();
    setStatus(`Imported presets: ${added} new, ${replaced} replaced.`, 'success');
  };
  reader.readAsText(file);
}

/* ---------- analysis ---------- */

function runAnalysis() {
  resetResults();
  const sourceRows = applyJoin(sheetRows);
  const groupBy = checkedValues('groupby');
  const metrics = checkedValues('metric');
  const condMetrics = readCondMetrics();
  const derived = readDerived();
  const labels = readLabels().filter((l) => l.name || l.rules.some((r) => r.value !== ''));

  if (groupBy.length === 0) {
    setStatus('Pick at least one column to group by (section 2).', 'error');
    return;
  }

  for (const cm of condMetrics) {
    if (!cm.name) {
      setStatus('Every conditional metric needs a name (section 4).', 'error');
      return;
    }
    if (cm.type !== 'count' && !cm.valueCol) {
      setStatus(`Conditional metric "${cm.name}" needs a value column (section 4) — only Count can be left without one.`, 'error');
      return;
    }
    const activeConds = cm.conditions.filter((c) => c.col && (c.value !== '' || BLANK_OPS.includes(c.op)));
    if (activeConds.length === 0) {
      setStatus(`Conditional metric "${cm.name}" needs at least one condition with a value filled in (section 4) — with none active it would just duplicate an unconditional metric.`, 'error');
      return;
    }
  }
  const condAggMap = {};
  for (const cm of condMetrics) condAggMap[cm.name] = cm.type;

  // Compile calculated columns; each may reference data columns, conditional metrics, and
  // earlier calculated columns
  const compiled = [];
  const available = new Set(metrics);
  for (const cm of condMetrics) available.add(cm.name);
  for (const d of derived) {
    if (!d.name) {
      setStatus('Every calculated column needs a name (section 5).', 'error');
      return;
    }
    let c;
    try {
      c = compileFormula(d.formula);
    } catch (err) {
      setStatus(`Formula for "${d.name}": ${err.message}`, 'error');
      return;
    }
    const unknown = c.refs.filter((r) => !available.has(r));
    if (unknown.length > 0) {
      setStatus(
        `Formula for "${d.name}" references unknown column(s): ${unknown.join(', ')}.\n` +
        `Available here: ${[...available].join(', ') || '(none — check columns in section 3)'}`,
        'error'
      );
      return;
    }
    compiled.push({ name: d.name, rpn: c.rpn, refs: c.refs });
    available.add(d.name);
  }

  for (const l of labels) {
    if (!l.name) {
      setStatus('Every category column needs a name (section 6).', 'error');
      return;
    }
    for (const r of l.rules) {
      if (r.value !== '' && !available.has(r.col)) {
        setStatus(`Category "${l.name}" has a rule on unknown column "${r.col}".`, 'error');
        return;
      }
    }
  }

  const names = outputColumnNames();
  if (new Set(names).size !== names.length) {
    setStatus('Column names in the result must be unique — rename the duplicated column.', 'error');
    return;
  }

  const grouped = new Map();
  for (const row of sourceRows) {
    const key = groupBy.map((c) => bucketValue(c, row[c])).join('');
    if (!grouped.has(key)) {
      const entry = {};
      for (const c of groupBy) entry[c] = bucketValue(c, row[c]);
      for (const m of metrics) entry[m] = [];
      for (const cm of condMetrics) entry[cm.name] = [];
      grouped.set(key, entry);
    }
    const entry = grouped.get(key);
    for (const m of metrics) entry[m].push(row[m]);
    for (const cm of condMetrics) {
      // Mirrors the filter-row "active condition" rule at readFilters()'s call site: a
      // condition with no column picked, or a blank value on a non-blank op, is ignored
      // rather than failing every row. A row must pass every ACTIVE condition to count.
      const activeConds = cm.conditions.filter((c) => c.col && (c.value !== '' || BLANK_OPS.includes(c.op)));
      const passes = activeConds.every((c) => matches(row[c.col], c.op, c.value));
      if (passes) entry[cm.name].push(cm.type === 'count' ? 1 : row[cm.valueCol]);
    }
  }

  let out = [...grouped.values()];
  const aggMap = readAggs();
  for (const entry of out) {
    for (const m of metrics) {
      const v = aggregateValues(entry[m], aggMap[m] || 'sum');
      // Round to 10dp at rest so binary float noise (e.g. 0.1 + 0.2 → 0.30000000000000004)
      // never reaches the preview table or the downloaded .xlsx. 10dp keeps genuine precision —
      // this is not the 2dp rounding used by the (separately scoped) calculated-column pipeline.
      entry[m] = typeof v === 'number' ? Math.round(v * 1e10) / 1e10 : v;
    }
    for (const cm of condMetrics) {
      const v = aggregateValues(entry[cm.name], cm.type || 'sum');
      entry[cm.name] = typeof v === 'number' ? Math.round(v * 1e10) / 1e10 : v;
    }
  }
  for (const entry of out) {
    for (const c of compiled) {
      try {
        entry[c.name] = Math.round(evalFormula(c.rpn, entry) * 100) / 100;
      } catch (err) {
        setStatus(`Formula for "${c.name}" failed while calculating: ${err.message}`, 'error');
        return;
      }
    }
    for (const l of labels) {
      let assigned = l.elseLabel;
      for (const r of l.rules) {
        if (r.value === '' && !BLANK_OPS.includes(r.op)) continue;
        if (matches(entry[r.col], r.op, r.value)) { assigned = r.label; break; }
      }
      entry[l.name] = assigned;
    }
  }

  const filters = readFilters().filter((f) => f.col && (f.value !== '' || BLANK_OPS.includes(f.op)));
  for (const f of filters) {
    out = out.filter((entry) => matches(entry[f.col], f.op, f.value));
  }

  const sortCol = sortColSelect.value;
  if (sortCol) {
    const dir = sortDirSelect.value === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const preTopNCount = out.length;
  out = applyTopN(out);
  const postTopNCount = out.length;

  const piv = applyPivot(out, names, groupBy);
  if (piv.error) {
    setStatus(piv.error, 'error');
    return;
  }
  out = piv.rows;

  resultRows = out;
  outputCols = piv.cols;
  resultSummaryRows = [];
  // Widen metrics/aggMap with the conditional metrics so computeSummaryRow treats a sum/count
  // conditional metric exactly like a regular sum/count metric (summed across output rows) and
  // leaves avg/min/max/countDistinct conditional metrics blank — no other change needed there.
  const summaryMetrics = [...metrics, ...condMetrics.map((cm) => cm.name)];
  const summaryAggMap = { ...aggMap, ...condAggMap };
  if (document.getElementById('totalRowEnabled').checked) {
    resultSummaryRows.push(computeSummaryRow('Total', out, outputCols, groupBy, summaryMetrics, summaryAggMap, compiled));
  }
  if (document.getElementById('avgRowEnabled').checked) {
    resultSummaryRows.push(computeSummaryRow('Average', out, outputCols, groupBy, summaryMetrics, summaryAggMap, compiled));
  }
  resultSummaryRows = resultSummaryRows.filter(Boolean);
  downloadBtn.hidden = out.length === 0;

  const filterDesc = filters.length
    ? ` matching ${filters.map((f) => `${f.col} ${f.op} ${f.value}`).join(' AND ')}`
    : '';
  const topNDesc = preTopNCount !== postTopNCount
    ? ` (kept top ${postTopNCount} of ${preTopNCount})`
    : '';
  const joinNote = joinWarning ? ` ${joinWarning}` : '';
  const noDataHint = metrics.length === 0
    ? ' No number column is selected — check a number column in section 3 (Data for calculation).'
    : '';
  const emptyNote = out.length === 0 && !noDataHint
    ? ' No rows matched this setup — adjust the filters or grouping above and Run again.'
    : '';
  let statusKind = 'success';
  if (out.length === 0) statusKind = 'warning';
  else if (joinWarningLevel === 'error') statusKind = 'error';
  else if (joinWarningLevel === 'warning') statusKind = 'warning';
  setStatus(
    `Done. ${out.length} group(s)${filterDesc}${topNDesc} ` +
    `(from ${sheetRows.length} rows, ${grouped.size} groups total).${joinNote}${noDataHint}${emptyNote}`,
    statusKind
  );
  renderPreview(out);
  applyConditionalFormatting();
  renderKpis(out, outputCols, groupBy);
  renderCharts(resultRows, outputCols);
}

// Grand-total row for the result: sums quantity-like columns and RECOMPUTES calculated
// columns from the summed inputs (so %OOS of the total is the true weighted figure, not an
// average of percentages). Columns where a total is not meaningful (avg/min/max/count-distinct
// aggregations, category labels, other group keys) stay blank.
function computeSummaryRow(kind, rows, cols, groupBy, metrics, aggMap, compiled) {
  if (rows.length === 0) return null;
  const calcNames = new Set(compiled.map((c) => c.name));
  const total = {};
  const sums = {};
  for (const col of cols) total[col] = '';
  const firstKey = cols.find((c) => groupBy.includes(c)) || cols[0];
  total[firstKey] = kind;

  for (const col of cols) {
    if (col === firstKey || groupBy.includes(col) || calcNames.has(col)) continue;
    if (metrics.includes(col) && !['sum', 'count'].includes(aggMap[col] || 'sum')) continue;
    const vals = rows.map((r) => r[col]).filter((v) => v !== '' && v !== null && v !== undefined);
    if (vals.length === 0 || !vals.every((v) => typeof v === 'number')) continue;
    let s = vals.reduce((a, b) => a + b, 0);
    if (kind === 'Average') s = s / rows.length;
    s = Math.round(s * 1e10) / 1e10;
    if (kind === 'Average') s = Math.round(s * 100) / 100;
    total[col] = s;
    if (metrics.includes(col)) sums[col] = s;
  }

  for (const c of compiled) {
    if (!cols.includes(c.name)) continue;
    // Only recompute when every referenced input has a meaningful total
    if (!(c.refs || []).every((ref) => ref in sums || calcNames.has(ref))) continue;
    try {
      const v = evalFormula(c.rpn, { ...sums, ...total });
      total[c.name] = Math.round(v * 100) / 100;
      sums[c.name] = total[c.name];
    } catch {
      /* leave blank */
    }
  }
  return total;
}

function matches(cell, op, rawValue) {
  if (op === 'is blank' || op === 'is not blank') {
    const blank = cell === null || cell === undefined || String(cell).trim() === '';
    return op === 'is blank' ? blank : !blank;
  }
  const numCell = typeof cell === 'number' ? cell : Number(cell);
  const numValue = Number(rawValue);
  const bothNumeric = !isNaN(numCell) && !isNaN(numValue) && String(cell) !== '';
  if (op === 'contains') {
    return String(cell).toLowerCase().includes(rawValue.toLowerCase());
  }
  const a = bothNumeric ? numCell : String(cell);
  const b = bothNumeric ? numValue : rawValue;
  switch (op) {
    case '>=': return a >= b;
    case '>': return a > b;
    case '=': return a === b || String(cell) === rawValue;
    case '!=': return a !== b && String(cell) !== rawValue;
    case '<': return a < b;
    case '<=': return a <= b;
    default: return true;
  }
}

/* ---------- output ---------- */

function renderPreview(rows) {
  if (rows.length === 0) {
    previewNote.textContent = 'No groups match the conditions — loosen the filters in section 7.';
    return;
  }
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const col of outputCols) {
    const th = document.createElement('th');
    th.textContent = col;
    thead.appendChild(th);
  }
  const fmts = formatMap();
  const tbody = table.createTBody();
  for (const row of rows.slice(0, PREVIEW_LIMIT)) {
    const tr = tbody.insertRow();
    for (const col of outputCols) {
      const td = tr.insertCell();
      td.textContent = formatDisplay(row[col], fmts.get(col));
      if (typeof row[col] === 'number') td.className = 'num';
    }
  }
  for (const summary of resultSummaryRows) {
    const tr = tbody.insertRow();
    tr.className = 'totalRow';
    for (const col of outputCols) {
      const td = tr.insertCell();
      td.textContent = formatDisplay(summary[col], fmts.get(col));
      if (typeof summary[col] === 'number') td.className = 'num';
    }
  }
  previewWrap.appendChild(table);
  previewNote.textContent = rows.length > PREVIEW_LIMIT
    ? `Showing first ${PREVIEW_LIMIT} of ${rows.length} rows — download the Excel file for the full list.`
    : `Showing all ${rows.length} rows.`;
}

function downloadXlsx() {
  if (resultRows == null) return;
  const exportRows = [...resultRows, ...resultSummaryRows];
  const ws = XLSX.utils.json_to_sheet(exportRows, { header: outputCols });

  // Apply display formats as real Excel number formats. Percent stores value/100 with a %
  // format so it displays identically to the preview AND behaves as a true percent in Excel.
  const fmts = formatMap();
  for (const [col, fmt] of fmts) {
    const c = outputCols.indexOf(col);
    if (c === -1) continue;
    const decs = fmt.decimals > 0 ? '.' + '0'.repeat(fmt.decimals) : '';
    for (let r = 1; r <= exportRows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ c, r })];
      if (!cell) continue;
      if (fmt.type === 'text') {
        cell.t = 's';
        cell.v = String(cell.v);
      } else if (cell.t === 'n') {
        if (fmt.type === 'percent') {
          cell.v = cell.v / 100;
          cell.z = '0' + decs + '%';
        } else {
          cell.z = '#,##0' + decs;
        }
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Result');

  // Self-documenting monthly exports: dump the current setup as a second sheet so a downloaded
  // .xlsx can be traced back to the settings that produced it. Result stays the first/active sheet.
  const cfg = collectConfig();
  const configRows = [['Note', 'Excel Group & Analyze settings snapshot']];
  for (const [key, value] of Object.entries(cfg)) {
    configRows.push([key, JSON.stringify(value)]);
  }
  const configWs = XLSX.utils.aoa_to_sheet(configRows);
  XLSX.utils.book_append_sheet(wb, configWs, 'Config');

  XLSX.writeFile(wb, 'Analysis_Result.xlsx');
}

/* ---------- events ---------- */

for (const btn of document.querySelectorAll('#quickStartBox [data-template]')) {
  btn.addEventListener('click', () => loadSampleTemplate(btn.dataset.template));
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) loadFile(fileInput.files[0]);
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) loadFile(e.dataTransfer.files[0]);
});
sheetSelect.addEventListener('change', loadSheet);
lookupFileBtn.addEventListener('click', () => lookupFileInput.click());
lookupFileInput.addEventListener('change', () => {
  if (lookupFileInput.files.length > 0) loadLookupFile(lookupFileInput.files[0]);
});
lookupSheetSelect.addEventListener('change', loadLookupSheet);
// Manual interaction with any join control means the user's intent now lives in the DOM, not in
// a not-yet-applied preset — clear pendingJoinConfig so a later loadLookupSheet() (e.g. loading a
// lookup file after already flipping "Enable lookup join" by hand) cannot stomp it. Programmatic
// updates (loadLookupSheet() setting .checked/.value directly, or a <select> update via .value=)
// do not fire 'change' events in browsers, so this only fires on genuine user input.
joinEnabledCb.addEventListener('change', () => { pendingJoinConfig = null; resetResults(); });
joinLeftKeySelect.addEventListener('change', () => { pendingJoinConfig = null; resetResults(); });
joinRightKeySelect.addEventListener('change', () => { pendingJoinConfig = null; resetResults(); });
presetSelect.addEventListener('change', loadSelectedPreset);
savePresetBtn.addEventListener('click', savePreset);
deletePresetBtn.addEventListener('click', deleteSelectedPreset);
addCondMetricBtn.addEventListener('click', () => { addCondMetricBlock(); updateSelectors(); });
addDerivedBtn.addEventListener('click', () => { addDerivedRow(); updateSelectors(); });
addLabelBtn.addEventListener('click', () => { addLabelBlock(); updateSelectors(); });
addFilterBtn.addEventListener('click', () => { addFilterRow(); updateSelectors(); });
sortColSelect.addEventListener('change', resetResults);
sortDirSelect.addEventListener('change', resetResults);
pivotEnabledCheckbox.addEventListener('change', resetResults);
pivotColDimSelect.addEventListener('change', resetResults);
pivotValueColSelect.addEventListener('change', resetResults);
vizChartTypeSelect.addEventListener('change', resetResults);
vizXColSelect.addEventListener('change', resetResults);
vizValueColSelect.addEventListener('change', resetResults);
vizTopNInput.addEventListener('change', resetResults);
vizSeriesColSelect.addEventListener('change', resetResults);
vizStackedCb.addEventListener('change', resetResults);
vizAxisMinInput.addEventListener('change', resetResults);
vizAxisMaxInput.addEventListener('change', resetResults);
vizAxisUnitSelect.addEventListener('change', resetResults);
document.getElementById('vizExcludeBlank').addEventListener('change', resetResults);
document.getElementById('vizExcludeTotals').addEventListener('change', resetResults);
document.getElementById('totalRowEnabled').addEventListener('change', resetResults);
document.getElementById('avgRowEnabled').addEventListener('change', resetResults);
colorScaleEnabledCb.addEventListener('change', resetResults);
colorScaleColSelect.addEventListener('change', resetResults);
runBtn.addEventListener('click', runAnalysis);
downloadBtn.addEventListener('click', downloadXlsx);
document.getElementById('exportPresetsBtn').addEventListener('click', exportPresets);
document.getElementById('importPresetsBtn').addEventListener('click', () => {
  const input = document.getElementById('importPresetsInput');
  input.value = '';
  input.click();
});
document.getElementById('importPresetsInput').addEventListener('change', (e) => {
  if (e.target.files.length > 0) importPresetsFile(e.target.files[0]);
});
document.getElementById('addFormatBtn').addEventListener('click', () => { addFormatRow(); updateSelectors(); });
document.getElementById('helpBtn').addEventListener('click', () => {
  const panel = document.getElementById('helpPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('downloadChartBtn').addEventListener('click', () => {
  if (!vizChartInstance) return;
  const a = document.createElement('a');
  // Draw onto an opaque dark background so the PNG is readable outside the app
  const src = vizCanvas;
  const copy = document.createElement('canvas');
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext('2d');
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, copy.width, copy.height);
  ctx.drawImage(src, 0, 0);
  a.href = copy.toDataURL('image/png');
  a.download = 'Analysis_Chart.png';
  a.click();
});

refreshPresetSelect();
