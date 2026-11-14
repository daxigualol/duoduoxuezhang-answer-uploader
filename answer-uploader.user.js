// ==UserScript==
// @name         批量答案录入 · 多多学长
// @namespace    local.batch-answer
// @version      1.4.1
// @description  人工选择 100 道题的答案（81–100 多选），批量调用 /api/answer 上传（单选/多选、草稿保存、失败重试）
// @match        https://www.duoduoxuezhang.com/*
// @match        https://duoduoxuezhang.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* 也可以直接复制整个文件，粘贴到网站页面的控制台（F12 → Console）里运行。 */
(function () {
  'use strict';

  const CFG = { TOTAL: 100, STORE: 'ddsx.batchAnswer.v1', HOST_ID: 'ddsx-ba-host' };
  /* 默认题型：81–100 多选，1–80 单选（单格可手动覆盖） */
  const MULTI_FROM = 81;
  const MULTI_TO = 100;
  const defaultMulti = (q) => q >= MULTI_FROM && q <= MULTI_TO;
  const ON_SITE = /(^|\.)duoduoxuezhang\.com$/i.test(location.hostname);
  const API_URL = ON_SITE ? '/api/answer' : 'https://www.duoduoxuezhang.com/api/answer';

  /* =========================================================================
     工具函数
     ========================================================================= */
  const pad3 = (n) => String(n).padStart(3, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /* ---------------------------- 粘贴解析（可单测） ---------------------------- */
  /* @testable:start */
  function normalizeText(s) {
    let t = String(s == null ? '' : s);
    t = t.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    t = t.replace(/\u3000/g, ' ');
    return t.replace(/[第题]/g, ' ');
  }

  function lettersOf(s) {
    const up = normalizeText(s).toUpperCase().replace(/[^A-D]/g, '');
    let out = '';
    for (let i = 0; i < up.length; i++) if (out.indexOf(up[i]) < 0) out += up[i];
    return out.split('').sort().join('');
  }

  /* 快捷录入键位映射：mode='num' 时 1-4 → A-D；mode='alpha' 时 A-D → A-D */
  function keyToOption(key, mode) {
    const k = String(key == null ? '' : key);
    if (mode === 'alpha') {
      const up = k.toUpperCase();
      return up.length === 1 && 'ABCD'.indexOf(up) >= 0 ? up : null;
    }
    return { 1: 'A', 2: 'B', 3: 'C', 4: 'D' }[k] || null;
  }

  function parseAnswerText(text, startAt, total) {
    startAt = startAt || 1;
    total = total || 100;
    const norm = normalizeText(text);
    const map = {};
    const re = /(\d{1,3})\s*[.、:：)．\-–—+]*\s*([A-Da-d]{1,4})/g;
    let m;
    let hit = 0;
    let patternHit = 0;
    while ((m = re.exec(norm)) !== null) {
      patternHit++;
      const q = parseInt(m[1], 10);
      if (q < 1 || q > total) continue;
      const sel = lettersOf(m[2]);
      if (!sel) continue;
      map[q] = sel;
      hit++;
    }
    if (hit) return map;
    // 写了题号但全部越界：不要退回“按顺序填入”，否则会错位
    if (patternHit) return map;
    // 没有任何题号：按顺序依次填入
    const tokens = norm.split(/[^A-Da-d]+/);
    let q = startAt;
    for (let i = 0; i < tokens.length; i++) {
      const sel = lettersOf(tokens[i]);
      if (!sel) continue;
      if (q > total) break;
      map[q] = sel;
      q++;
    }
    return map;
  }
  /* @testable:end */

  /* =========================================================================
     状态
     ========================================================================= */
  function defaultState() {
    return { v: 2, subject: 'computer', year: '2026', delay: 300, autoNext: true, keys: 'num', answers: {} };
  }

  function loadState() {
    const d = defaultState();
    try {
      const s = JSON.parse(localStorage.getItem(CFG.STORE) || 'null');
      if (s && typeof s === 'object') {
        const legacy = !s.v; // 旧草稿：81–100 还没有“多选”默认值，按新规则补上
        if (typeof s.subject === 'string' && s.subject.trim()) d.subject = s.subject.trim();
        if (s.year != null && String(s.year).trim()) d.year = String(s.year).trim();
        if (s.delay != null) d.delay = clampInt(s.delay, 0, 5000, 300);
        d.autoNext = s.autoNext !== false;
        d.keys = s.keys === 'alpha' ? 'alpha' : 'num';
        if (s.answers && typeof s.answers === 'object') {
          Object.keys(s.answers).forEach((k) => {
            const q = parseInt(k, 10);
            if (!(q >= 1 && q <= CFG.TOTAL)) return;
            const v = s.answers[k] || {};
            const sel = lettersOf(v.s);
            if (!sel) return;
            const multi = legacy ? defaultMulti(q) || sel.length > 1 : !!v.m || sel.length > 1;
            d.answers[q] = { s: sel, m: multi };
          });
        }
      }
    } catch (e) {
      /* 忽略损坏的草稿 */
    }
    return d;
  }

  const state = loadState();
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(CFG.STORE, JSON.stringify(state));
      } catch (e) {
        /* 隐私模式下可能不可写 */
      }
    }, 200);
  }

  const currentSubject = () => (state.subject || '').trim() || 'computer';
  const currentYear = () => String(state.year || '').trim() || '2026';
  const questionId = (q) => currentSubject() + '-' + currentYear() + '-' + pad3(q);
  const answerOf = (q) => {
    const a = state.answers[q];
    return a && a.s ? a : null;
  };

  /* =========================================================================
     样式
     ========================================================================= */
  const CSS = `
  *{box-sizing:border-box}
  .fab{position:fixed;right:18px;bottom:18px;pointer-events:auto;z-index:2;border:0;border-radius:999px;
       padding:10px 16px;background:#2563eb;color:#fff;cursor:pointer;
       font:600 13px/1.2 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       box-shadow:0 8px 20px rgba(37,99,235,.42)}
  .fab:hover{background:#1d4ed8}
  .panel{position:fixed;right:18px;bottom:70px;pointer-events:auto;z-index:3;width:452px;
         max-width:calc(100vw - 24px);max-height:88vh;display:flex;flex-direction:column;
         background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;
         box-shadow:0 20px 50px rgba(15,23,42,.28);
         font:13px/1.45 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .panel[hidden]{display:none}
  .hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 12px;
      background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff}
  .hd b{font-size:14px;font-weight:600}
  .hd .sub{display:block;margin-top:2px;font-size:11px;opacity:.82;font-weight:400}
  .icon{background:transparent;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;opacity:.85}
  .icon:hover{opacity:1}
  .warn{margin:8px 10px 0;padding:7px 9px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;
        color:#9a3412;font-size:11.5px;line-height:1.6}
  .warn[hidden]{display:none}
  .tabs{display:flex;gap:4px;padding:8px 10px 0;background:#f8fafc;border-bottom:1px solid #e2e8f0}
  .tabs button{flex:1;border:0;background:transparent;padding:7px 0;cursor:pointer;
               font-size:12px;line-height:1;font-weight:500;font-family:inherit;color:#64748b;border-radius:8px 8px 0 0}
  .tabs button.on{background:#fff;color:#2563eb;font-weight:600;box-shadow:inset 0 -2px 0 #2563eb}
  .scroll{flex:1;overflow:auto;padding:10px 12px}
  .pane[hidden]{display:none}
  .cfg{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
  label{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#475569;white-space:nowrap}
  input[type=text],input[type=number]{border:1px solid #cbd5e1;border-radius:7px;padding:5px 7px;
       font-size:12px;line-height:1.2;font-family:inherit;color:#0f172a;background:#fff;min-width:0;outline:none}
  input[type=text]:focus,input[type=number]:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.15)}
  input.tiny{width:54px;text-align:center}
  input.chk{width:auto}
  .hintline{font-size:11.5px;color:#64748b;line-height:1.7;margin:0 0 8px}
  .hintline code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:0 4px;font-size:11px}
  textarea{width:100%;height:168px;resize:vertical;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;
           font:12px/1.7 ui-monospace,Consolas,"Microsoft YaHei",monospace;color:#0f172a;outline:none}
  textarea:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.15)}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .cell{border:1px solid #e2e8f0;border-radius:8px;padding:3px 4px 4px;background:#fff;outline:none;cursor:default}
  .cell:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.22)}
  .cell .top{display:flex;align-items:center;justify-content:space-between;gap:2px}
  .cell .n{font-size:10px;color:#94a3b8;font-variant-numeric:tabular-nums}
  .cell .mt{padding:0 3px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;color:#cbd5e1;
            font-size:9px;line-height:13px;font-family:inherit;cursor:pointer}
  .cell.multi .mt{background:#fef3c7;border-color:#f59e0b;color:#b45309;font-weight:700}
  .cell .os{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;margin-top:2px}
  .cell .o{padding:3px 0;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;color:#64748b;
           font-size:10.5px;line-height:1.1;font-weight:600;font-family:inherit;cursor:pointer}
  .cell .o:hover{background:#eff6ff;border-color:#bfdbfe}
  .cell .o.on{background:#2563eb;border-color:#2563eb;color:#fff}
  .cell.filled{border-color:#bfdbfe;background:#f8fbff}
  .cell.sep{border-top:2px solid #fbbf24}
  .cell.busy{border-color:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,.2)}
  .cell.ok{border-color:#22c55e;background:#f6fef9}
  .cell.err{border-color:#ef4444;background:#fff6f6}
  .ft{border-top:1px solid #e2e8f0;background:#f8fafc;padding:8px 12px 10px}
  .bar{height:6px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin:2px 0 6px}
  .bar-fill{height:100%;width:0;background:linear-gradient(90deg,#2563eb,#22c55e);transition:width .15s}
  .status{font-size:11.5px;color:#475569;margin-bottom:6px;min-height:16px}
  .btns{display:flex;flex-wrap:wrap;gap:6px}
  button.primary{flex:1;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;
                 padding:8px 10px;font-size:12.5px;line-height:1.2;font-weight:600;font-family:inherit;cursor:pointer}
  button.primary:hover{background:#1d4ed8}
  button.primary:disabled{opacity:.45;cursor:default;background:#2563eb}
  button.mini{border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155;
              padding:7px 10px;font-size:12px;line-height:1.2;font-weight:500;font-family:inherit;cursor:pointer}
  button.mini:hover{background:#f1f5f9}
  button.mini:disabled{opacity:.45;cursor:default}
  button.mini.blue{color:#2563eb;border-color:#bfdbfe;background:#eff6ff}
  button.mini.danger{color:#dc2626;border-color:#fecaca;background:#fff5f5}
  button.mini.danger:hover{background:#fee2e2}
  .seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff}
  .seg button{border:0;background:transparent;color:#475569;padding:5px 9px;cursor:pointer;
              font-size:11.5px;font-weight:600;font-family:inherit;line-height:1.2}
  .seg button+button{border-left:1px solid #e2e8f0}
  .seg button.on{background:#2563eb;color:#fff}
  .log{max-height:92px;overflow:auto;margin-top:6px;padding:6px 8px;border-radius:8px;background:#0f172a;
       color:#cbd5e1;font:11px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
  .log:empty{display:none}
  .log-line{background:transparent}
  .log-line.ok{color:#86efac}
  .log-line.err{color:#fca5a5}
  .log-line.warn{color:#fcd34d}
  .log-line.info{color:#93c5fd}
  .log-line.plain{color:#cbd5e1}
  `;

  /* =========================================================================
     模板
     ========================================================================= */
  const TEMPLATE = `
  <button class="fab" id="fab" type="button">批量答案</button>
  <section class="panel" id="panel" hidden>
    <header class="hd">
      <div><b>批量答案录入</b><span class="sub" id="hdSub"></span></div>
      <button class="icon" id="close" type="button" title="关闭">×</button>
    </header>
    <div class="warn" id="warn" hidden></div>
    <nav class="tabs">
      <button type="button" data-tab="grid" class="on">网格录入</button>
      <button type="button" data-tab="paste">批量粘贴</button>
    </nav>
    <div class="scroll">
      <div class="pane" id="pane-grid">
        <div class="cfg">
          <label>科目 <input id="subject" type="text" spellcheck="false" style="width:104px"></label>
          <label>年份 <input id="year" type="text" spellcheck="false" style="width:66px"></label>
          <span class="hintline" style="margin:0">题号 ID 形如 <code id="idDemo"></code></span>
        </div>
        <div class="cfg">
          <span style="font-size:12px;color:#475569">多选范围</span>
          <input id="mr1" class="tiny" type="number" min="1" max="100" value="81">
          <span style="color:#94a3b8">–</span>
          <input id="mr2" class="tiny" type="number" min="1" max="100" value="100">
          <button id="applyMulti" type="button" class="mini blue">设为多选</button>
          <button id="applySingle" type="button" class="mini">设为单选</button>
        </div>
        <div class="cfg" style="margin-top:-2px">
          <span class="hintline" style="margin:0">默认题型：<b>81–100 多选</b>，1–80 单选</span>
          <button id="resetTypes" type="button" class="mini">恢复默认题型</button>
        </div>
        <div class="cfg">
          <span style="font-size:12px;color:#475569">快捷键</span>
          <span class="seg">
            <button type="button" id="keyNum" class="on">1234</button>
            <button type="button" id="keyAlpha">ABCD</button>
          </span>
          <span class="hintline" id="keyHint" style="margin:0"></span>
        </div>
        <div class="grid" id="grid"></div>
        <p class="hintline" style="margin:8px 0 0">
          共 100 题。单击字母选择答案，再次单击取消；点亮 <b>多</b> 表示多选题（可多选）。
          <code>M</code> 切换多选，方向键移动，<code>Backspace</code> 清空。
        </p>
      </div>
      <div class="pane" id="pane-paste" hidden>
        <p class="hintline">
          每行一题，也可用空格/逗号连写。支持 <code>1.A</code>、<code>2 B</code>、<code>3、ABC</code>、<code>4:AB</code>；
          若整段没有题号，则从下面的“起始题号”开始按顺序填入。
        </p>
        <textarea id="pasteBox" spellcheck="false" placeholder="1.A&#10;2.B&#10;3.ABC&#10;4.D&#10;..."></textarea>
        <div class="cfg" style="margin-top:8px">
          <label>起始题号 <input id="pasteStart" class="tiny" type="number" min="1" max="100" value="1"></label>
          <button id="doPaste" type="button" class="mini blue">解析并填入</button>
          <button id="exportBtn" type="button" class="mini">导出当前答案</button>
          <button id="copyBtn" type="button" class="mini">复制</button>
        </div>
        <div class="hintline" id="pasteHint"></div>
      </div>
    </div>
    <footer class="ft">
      <div class="cfg">
        <label>间隔 <input id="delay" class="tiny" type="number" min="0" max="5000" step="50"> ms</label>
        <label>从第 <input id="startAt" class="tiny" type="number" min="1" max="100" value="1"> 题起</label>
        <label><input id="autoNext" type="checkbox"> 录入后跳下一题</label>
      </div>
      <div class="bar"><div class="bar-fill" id="barFill"></div></div>
      <div class="status" id="status"></div>
      <div class="btns">
        <button id="upload" type="button" class="primary">批量上传</button>
        <button id="test" type="button" class="mini">试传 1 题</button>
        <button id="retry" type="button" class="mini" disabled>重试失败</button>
        <button id="stop" type="button" class="mini" disabled>停止</button>
        <button id="clearAll" type="button" class="mini danger" title="清空全部答案">清空</button>
      </div>
      <div class="log" id="log"></div>
    </footer>
  </section>
  `;

  /* =========================================================================
     运行时
     ========================================================================= */
  let host = null;
  let root = null;
  let cells = {};
  let running = false;
  let stopFlag = false;
  let aborter = null;
  let failedSet = {};

  const $ = (sel) => root.querySelector(sel);

  function setStatus(text) {
    const el = $('#status');
    if (el) el.textContent = text;
  }

  function log(kind, msg, detail) {
    const box = $('#log');
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'log-line ' + kind;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mi = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    let text = '[' + hh + ':' + mi + ':' + ss + '] ' + msg;
    if (detail) text += '  ' + detail;
    line.textContent = text;
    box.appendChild(line);
    while (box.childNodes.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  /* ------------------------------- 网格 ------------------------------- */
  function buildGrid() {
    const grid = $('#grid');
    grid.textContent = '';
    const frag = document.createDocumentFragment();
    cells = {};
    for (let q = 1; q <= CFG.TOTAL; q++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (q === MULTI_FROM || q === MULTI_TO + 1) cell.classList.add('sep');
      cell.tabIndex = 0;
      cell.dataset.q = String(q);
      cell.title = questionId(q);

      const top = document.createElement('div');
      top.className = 'top';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = pad3(q);
      const mt = document.createElement('button');
      mt.type = 'button';
      mt.className = 'mt';
      mt.dataset.act = 'multi';
      mt.textContent = '多';
      mt.title = '切换单选 / 多选';
      top.appendChild(n);
      top.appendChild(mt);

      const os = document.createElement('div');
      os.className = 'os';
      ['A', 'B', 'C', 'D'].forEach((o, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'o';
        b.dataset.act = 'opt';
        b.dataset.o = o;
        b.textContent = o;
        b.title = o + '（' + (i + 1) + ' / ' + o + '）';
        os.appendChild(b);
      });

      cell.appendChild(top);
      cell.appendChild(os);
      frag.appendChild(cell);
      cells[q] = cell;
    }
    grid.appendChild(frag);
    for (let q = 1; q <= CFG.TOTAL; q++) updateCell(q);
  }

  function updateCell(q) {
    const cell = cells[q];
    if (!cell) return;
    const a = state.answers[q] || { s: '', m: defaultMulti(q) };
    const opts = cell.querySelectorAll('.o');
    for (let i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('on', a.s.indexOf(opts[i].dataset.o) >= 0);
    }
    cell.classList.toggle('multi', !!a.m);
    cell.classList.toggle('filled', !!a.s);
    cell.title = questionId(q) + (a.s ? ' · ' + a.s : '');
  }

  function setCellState(q, cls) {
    const c = cells[q];
    if (!c) return;
    c.classList.remove('ok', 'err', 'busy');
    if (cls) c.classList.add(cls);
  }

  function pick(q, o) {
    const a = state.answers[q] || { s: '', m: defaultMulti(q) };
    if (a.m) {
      a.s = a.s.indexOf(o) >= 0 ? a.s.replace(o, '') : lettersOf(a.s + o);
    } else {
      a.s = a.s === o ? '' : o;
    }
    state.answers[q] = a;
    save();
    updateCell(q);
    refreshCounts();
  }

  function toggleMulti(q) {
    const a = state.answers[q] || { s: '', m: defaultMulti(q) };
    a.m = !a.m;
    state.answers[q] = a;
    save();
    updateCell(q);
    refreshCounts();
  }

  function clearAll() {
    if (running) {
      log('warn', '正在上传，请先点“停止”再清空');
      return;
    }
    const n = answeredCount().n;
    if (!n) {
      log('plain', '当前没有已录入的答案，无需清空');
      return;
    }
    if (!confirm('确定清空全部 ' + n + ' 条答案吗？此操作不可撤销。')) return;
    state.answers = {};
    failedSet = {};
    save();
    for (let q = 1; q <= CFG.TOTAL; q++) {
      updateCell(q);
      setCellState(q, null);
    }
    $('#barFill').style.width = '0%';
    $('#retry').disabled = true;
    refreshCounts();
    log('plain', '已清空全部答案');
  }

  function answeredCount() {
    let n = 0;
    let m = 0;
    for (let q = 1; q <= CFG.TOTAL; q++) {
      const a = answerOf(q);
      if (a) {
        n++;
        if (a.m) m++;
      }
    }
    return { n: n, m: m };
  }

  function refreshCounts() {
    const c = answeredCount();
    $('#hdSub').textContent = currentSubject() + ' · ' + currentYear() + ' · 已录入 ' + c.n + '/' + CFG.TOTAL;
    if (!running) setStatus('已录入 ' + c.n + ' / ' + CFG.TOTAL + ' 题（多选 ' + c.m + ' 题）· 待上传 ' + c.n + ' 题');
    $('#idDemo').textContent = questionId(1);
  }

  /* ------------------------------- 粘贴 ------------------------------- */
  function applyParsed(map) {
    let n = 0;
    Object.keys(map).forEach((k) => {
      const q = parseInt(k, 10);
      const sel = map[k];
      if (!(q >= 1 && q <= CFG.TOTAL) || !sel) return;
      state.answers[q] = { s: sel, m: sel.length > 1 || defaultMulti(q) };
      updateCell(q);
      setCellState(q, null);
      n++;
    });
    save();
    refreshCounts();
    return n;
  }

  function doPaste() {
    const text = $('#pasteBox').value;
    if (!text.trim()) {
      $('#pasteHint').textContent = '请先粘贴或输入答案文本。';
      return;
    }
    const start = clampInt($('#pasteStart').value, 1, CFG.TOTAL, 1);
    const map = parseAnswerText(text, start, CFG.TOTAL);
    const n = applyParsed(map);
    if (!n) {
      $('#pasteHint').textContent = '没有解析到答案，请检查格式（例如 1.A 或 3.ABC）。';
      return;
    }
    const keys = Object.keys(map).map((x) => parseInt(x, 10)).sort((a, b) => a - b);
    $('#pasteHint').textContent = '已填入 ' + n + ' 题：' + pad3(keys[0]) + ' – ' + pad3(keys[keys.length - 1]);
    log('info', '粘贴解析：填入 ' + n + ' 题');
    switchTab('grid');
  }

  function exportText() {
    const parts = [];
    for (let q = 1; q <= CFG.TOTAL; q++) {
      const a = answerOf(q);
      if (a) parts.push(q + '.' + a.s);
    }
    return parts.join(' ');
  }

  function doExport() {
    const text = exportText();
    if (!text) {
      $('#pasteHint').textContent = '当前没有已录入的答案。';
      return;
    }
    $('#pasteBox').value = text;
    $('#pasteHint').textContent =
      '已导出 ' + answeredCount().n + ' 题，可全选复制后粘贴到网站面板的“批量粘贴”里。';
  }

  function doCopy() {
    const box = $('#pasteBox');
    if (!box.value.trim()) doExport();
    if (!box.value.trim()) return;
    box.select();
    const done = () => {
      $('#pasteHint').textContent = '已复制到剪贴板。';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(done, () => {
        try {
          document.execCommand('copy');
          done();
        } catch (e) {
          $('#pasteHint').textContent = '复制失败，请手动全选复制。';
        }
      });
    } else {
      try {
        document.execCommand('copy');
        done();
      } catch (e) {
        $('#pasteHint').textContent = '复制失败，请手动全选复制。';
      }
    }
  }

  function switchTab(name) {
    root.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    $('#pane-grid').hidden = name !== 'grid';
    $('#pane-paste').hidden = name !== 'paste';
  }

  /* ------------------------------- 上传 ------------------------------- */
  function judge(res, text) {
    if (!res.ok) return { ok: false, msg: 'HTTP ' + res.status };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const body = String(text || '').trim();
    let j = null;
    if (body.charAt(0) === '{' || body.charAt(0) === '[') {
      try {
        j = JSON.parse(body);
      } catch (e) {
        j = null;
      }
    }
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      if (j.success === false || j.ok === false) return { ok: false, msg: '返回 success/ok=false' };
      const code = j.code !== undefined ? j.code : j.status;
      if (code !== undefined && code !== null) {
        const s = String(code).toLowerCase();
        if (['0', '200', 'ok', 'success', 'true'].indexOf(s) < 0) return { ok: false, msg: 'code=' + code };
      }
      return { ok: true, msg: '' };
    }
    if (ct.indexOf('text/html') >= 0 || /^<!doctype|^<html/i.test(body)) {
      return { ok: false, msg: '返回了 HTML 页面，登录可能已失效' };
    }
    return { ok: true, msg: '' };
  }

  function submitOne(q, sel) {
    const body = JSON.stringify({ questionId: questionId(q), selected: sel });
    const opts = {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.5',
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: body,
      mode: 'cors',
    };
    if (aborter) opts.signal = aborter.signal;
    const t0 = performance.now();
    return fetch(API_URL, opts)
      .then((res) =>
        res.text().then((text) => {
          const v = judge(res, text);
          return { ok: v.ok, status: res.status, msg: v.msg, text: text, ms: Math.round(performance.now() - t0) };
        })
      )
      .catch((err) => {
        if (err && err.name === 'AbortError') return { aborted: true };
        return {
          ok: false,
          status: 0,
          msg: (err && err.message) || String(err),
          text: '',
          ms: Math.round(performance.now() - t0),
        };
      });
  }

  function collectQueue(from) {
    const list = [];
    for (let q = from; q <= CFG.TOTAL; q++) if (answerOf(q)) list.push(q);
    return list;
  }

  function setRunning(on) {
    $('#upload').disabled = on;
    $('#test').disabled = on;
    $('#stop').disabled = !on;
    $('#retry').disabled = on || Object.keys(failedSet).length === 0;
  }

  function updateBar(i, total, ok, bad) {
    $('#barFill').style.width = (total ? Math.round((i * 100) / total) : 0) + '%';
    setStatus('上传中 ' + i + '/' + total + ' · 成功 ' + ok + ' · 失败 ' + bad);
  }

  function runUpload(list, title) {
    if (running || !list.length) return;
    state.delay = clampInt($('#delay').value, 0, 5000, state.delay);
    $('#delay').value = String(state.delay);
    save();
    running = true;
    stopFlag = false;
    failedSet = {};
    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    $('#barFill').style.width = '0%';
    $('#log').textContent = '';
    setRunning(true);
    log('info', title + '：共 ' + list.length + ' 题（间隔 ' + state.delay + 'ms）');

    let i = 0;
    let ok = 0;
    let bad = 0;
    let netFails = 0;
    let finished = false;
    const total = list.length;

    const finish = () => {
      if (finished) return;
      finished = true;
      running = false;
      aborter = null;
      setRunning(false);
      const failedN = Object.keys(failedSet).length;
      const head = stopFlag ? '已停止' : '完成';
      const txt = head + '：成功 ' + ok + ' · 失败 ' + bad;
      setStatus(txt);
      log(bad ? 'warn' : 'info', txt);
      $('#retry').disabled = failedN === 0;
      if (failedN) {
        const qs = Object.keys(failedSet).map(Number).sort((a, b) => a - b);
        log('warn', '失败题号：' + qs.map(pad3).join(', '));
      }
    };

    const step = (idx) => {
      if (stopFlag || idx >= list.length) {
        finish();
        return;
      }
      const q = list[idx];
      const a = answerOf(q);
      if (!a) {
        i++;
        step(idx + 1);
        return;
      }
      setCellState(q, 'busy');
      setStatus('上传中 ' + (i + 1) + '/' + total + ' · 第 ' + pad3(q) + ' 题');
      submitOne(q, a.s).then((r) => {
        if (r.aborted) {
          setCellState(q, null);
          stopFlag = true;
          finish();
          return;
        }
        i++;
        if (r.ok) {
          ok++;
          setCellState(q, 'ok');
          log('ok', pad3(q) + ' ' + a.s + ' → ' + r.status, r.ms + 'ms');
          netFails = 0;
        } else {
          bad++;
          failedSet[q] = 1;
          setCellState(q, 'err');
          const detail = (r.text ? String(r.text) : '').replace(/\s+/g, ' ').slice(0, 150);
          log('err', pad3(q) + ' ' + a.s + ' → ' + (r.msg || 'HTTP ' + r.status), detail);
          netFails = r.status === 0 ? netFails + 1 : 0;
          if (r.status === 401 || r.status === 403) {
            log('warn', '登录状态可能已失效：请刷新页面重新登录后再试');
            if (bad >= 2) stopFlag = true;
          }
          if (netFails >= 3) {
            log('warn', '连续 3 次网络错误，已停止。若提示 Failed to fetch / CORS，请在 www.duoduoxuezhang.com 页面内运行本工具');
            stopFlag = true;
          }
        }
        updateBar(i, total, ok, bad);
        $('#retry').disabled = Object.keys(failedSet).length === 0;
        if (stopFlag) {
          finish();
          return;
        }
        if (state.delay > 0) sleep(state.delay).then(() => step(idx + 1));
        else step(idx + 1);
      });
    };

    step(0);
  }

  /* =========================================================================
     绑定
     ========================================================================= */
  function syncInputs() {
    $('#subject').value = state.subject;
    $('#year').value = state.year;
    $('#delay').value = String(state.delay);
    $('#autoNext').checked = !!state.autoNext;
  }

  function syncKeyMode() {
    const isNum = state.keys !== 'alpha';
    $('#keyNum').classList.toggle('on', isNum);
    $('#keyAlpha').classList.toggle('on', !isNum);
    $('#keyHint').textContent = isNum ? '当前：1=A 2=B 3=C 4=D' : '当前：A / B / C / D';
  }

  function setKeyMode(mode) {
    state.keys = mode === 'alpha' ? 'alpha' : 'num';
    save();
    syncKeyMode();
  }

  function bindAll() {
    $('#fab').addEventListener('click', () => {
      const p = $('#panel');
      p.hidden = !p.hidden;
      if (!p.hidden) refreshCounts();
    });
    $('#close').addEventListener('click', () => {
      $('#panel').hidden = true;
    });

    root.querySelectorAll('.tabs button').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    const grid = $('#grid');
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      const q = parseInt(cell.dataset.q, 10);
      const btn = e.target.closest('button');
      if (!btn) {
        cell.focus();
        return;
      }
      if (btn.dataset.act === 'opt') pick(q, btn.dataset.o);
      else if (btn.dataset.act === 'multi') toggleMulti(q);
    });

    grid.addEventListener('keydown', (e) => {
      const cell = e.target.closest ? e.target.closest('.cell') : null;
      if (!cell) return;
      const q = parseInt(cell.dataset.q, 10);
      const k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const stepN = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : k === 'ArrowDown' ? 4 : -4;
        const nq = q + stepN;
        if (nq >= 1 && nq <= CFG.TOTAL && cells[nq]) cells[nq].focus();
        return;
      }
      if (k === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (q < CFG.TOTAL) cells[q + 1].focus();
        return;
      }
      if (k === 'Backspace' || k === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        const a = state.answers[q] || { s: '', m: defaultMulti(q) };
        a.s = '';
        state.answers[q] = a;
        save();
        updateCell(q);
        refreshCounts();
        return;
      }
      const up = String(k).toUpperCase();
      if (up === 'M') {
        e.preventDefault();
        e.stopPropagation();
        toggleMulti(q);
        return;
      }
      const opt = keyToOption(k, state.keys);
      if (opt) {
        e.preventDefault();
        e.stopPropagation();
        pick(q, opt);
        const cur = state.answers[q];
        const isMulti = !!(cur && cur.m);
        if (state.autoNext && !isMulti && q < CFG.TOTAL) setTimeout(() => cells[q + 1].focus(), 50);
      }
    });

    $('#subject').addEventListener('input', (e) => {
      state.subject = e.target.value;
      save();
      if (e.target.value.trim()) refreshCounts();
    });
    $('#subject').addEventListener('change', (e) => {
      state.subject = e.target.value.trim() || 'computer';
      e.target.value = state.subject;
      save();
      refreshCounts();
    });
    $('#year').addEventListener('input', (e) => {
      state.year = e.target.value;
      save();
      if (e.target.value.trim()) refreshCounts();
    });
    $('#year').addEventListener('change', (e) => {
      state.year = e.target.value.trim() || '2026';
      e.target.value = state.year;
      save();
      refreshCounts();
    });

    $('#applyMulti').addEventListener('click', () => applyRange(true));
    $('#applySingle').addEventListener('click', () => applyRange(false));

    $('#resetTypes').addEventListener('click', () => {
      let trimmed = 0;
      for (let q = 1; q <= CFG.TOTAL; q++) {
        const want = defaultMulti(q);
        const cur = state.answers[q] || { s: '', m: want };
        cur.m = want;
        if (!want && cur.s.length > 1) {
          cur.s = cur.s.charAt(0);
          trimmed++;
        }
        state.answers[q] = cur;
        updateCell(q);
      }
      save();
      refreshCounts();
      log(
        'info',
        '已恢复默认题型：81–100 多选，其余单选' + (trimmed ? '（' + trimmed + ' 题多余字母已截断为首字母）' : '')
      );
    });

    function applyRange(multi) {
      const a = clampInt($('#mr1').value, 1, CFG.TOTAL, 1);
      const b = clampInt($('#mr2').value, 1, CFG.TOTAL, CFG.TOTAL);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let q = lo; q <= hi; q++) {
        const cur = state.answers[q] || { s: '', m: defaultMulti(q) };
        cur.m = multi;
        if (!multi && cur.s.length > 1) cur.s = cur.s.charAt(0);
        state.answers[q] = cur;
        updateCell(q);
      }
      save();
      refreshCounts();
      log('info', pad3(lo) + '–' + pad3(hi) + ' 已设为' + (multi ? '多选' : '单选'));
    }

    $('#doPaste').addEventListener('click', doPaste);
    $('#exportBtn').addEventListener('click', doExport);
    $('#copyBtn').addEventListener('click', doCopy);
    $('#clearAll').addEventListener('click', clearAll);

    $('#delay').addEventListener('change', (e) => {
      state.delay = clampInt(e.target.value, 0, 5000, 300);
      e.target.value = String(state.delay);
      save();
    });
    $('#autoNext').addEventListener('change', (e) => {
      state.autoNext = e.target.checked;
      save();
    });

    $('#keyNum').addEventListener('click', () => setKeyMode('num'));
    $('#keyAlpha').addEventListener('click', () => setKeyMode('alpha'));

    $('#upload').addEventListener('click', () => {
      if (running) return;
      const from = clampInt($('#startAt').value, 1, CFG.TOTAL, 1);
      const list = collectQueue(from);
      if (!list.length) {
        log('warn', '没有可上传的答案，请先录入答案');
        switchTab('grid');
        return;
      }
      const missing = CFG.TOTAL - from + 1 - list.length;
      if (missing > 0 && !confirm('还有 ' + missing + ' 题未作答，仍要上传已作答的 ' + list.length + ' 题吗？')) return;
      runUpload(list, '批量上传');
    });

    $('#test').addEventListener('click', () => {
      if (running) return;
      const from = clampInt($('#startAt').value, 1, CFG.TOTAL, 1);
      const list = collectQueue(from);
      if (!list.length) {
        log('warn', '没有可上传的答案');
        return;
      }
      runUpload(list.slice(0, 1), '试传 1 题');
    });

    $('#stop').addEventListener('click', () => {
      if (!running) return;
      stopFlag = true;
      if (aborter) aborter.abort();
      log('warn', '正在停止…');
    });

    $('#retry').addEventListener('click', () => {
      if (running) return;
      const qs = Object.keys(failedSet).map(Number).sort((a, b) => a - b);
      if (!qs.length) return;
      runUpload(qs, '重试失败项');
    });
  }

  /* =========================================================================
     启动
     ========================================================================= */
  function init() {
    if (document.getElementById(CFG.HOST_ID)) return;
    host = document.createElement('div');
    host.id = CFG.HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' + TEMPLATE;

    buildGrid();
    bindAll();
    syncInputs();
    syncKeyMode();
    refreshCounts();

    if (!ON_SITE) {
      const w = $('#warn');
      w.hidden = false;
      w.textContent =
        '当前不在 duoduoxuezhang.com，上传会被浏览器的跨域策略拦截。可以在这里编辑答案，点“导出当前答案”复制文本，' +
        '再到网站页面上用油猴脚本的“批量粘贴”导入后上传。';
    }

    // 暴露少量调试接口，方便在控制台核对
    window.__batchAnswer = {
      state: state,
      parse: parseAnswerText,
      exportText: exportText,
      questionId: questionId,
      open: () => {
        $('#panel').hidden = false;
        refreshCounts();
      },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
