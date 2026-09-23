/* ============================================================
   数据库板块（Database Board）
   ------------------------------------------------------------
   两态：
     ① 概览 —— 按原表分组（国际市场 / 中国市场 / 免费公开数据）的
        年鉴式表格：序号 · 数据库 · 提供方 · 主要内容，支持搜索与分组筛选。
     ② 阅读 —— 点击条目名弹出「仿 Excel 工作簿」：标题栏 / 菜单栏 /
        编辑栏 / 列标行号 / 工作表标签 / 状态栏，可选中单元格、切工作表、
        导出 CSV。交互手感对齐「科学研究」板块的 PDF 阅读器。
   数据来自 data/databases.json（字段与措辞照抄《数据库.docx》三张原表）。
   完全外挂：只往 #dbBoardHost 里渲染，不修改 main.js / assistant.js / 后端。
   ============================================================ */
(function () {
    'use strict';

    if (window.__DB_BOARD__) return;
    window.__DB_BOARD__ = true;

    var host = document.getElementById('dbBoardHost');
    if (!host) return;

    /* ---------- 常量 ---------- */
    var DATA_URL = 'data/databases.json';

    /* 后端接口规范（阶段二，与书籍图谱同一套约定，当前未启用）：
       GET /api/databases  →  { code: 0, data: { meta, groups:[{id,name,columns,rows}] } }
       启用方式：把下面 USE_API 置 true，或注入 window.__DB_DATA__ 直接喂数据。 */
    var DB_API = '/api/databases';
    var USE_API = false;

    var ICONS = {
        sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
               'stroke-linecap="round" stroke-linejoin="round">' +
               '<rect x="3.5" y="3" width="17" height="18" rx="2.5"></rect>' +
               '<path d="M3.5 9.5h17M3.5 15h17M9.5 3v18"></path></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round">' +
                '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path></svg>',
        arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round">' +
               '<path d="M7 17L17 7M9 7h8v8"></path></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                  'stroke-linecap="round" stroke-linejoin="round">' +
                  '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"></path></svg>'
    };

    /* ---------- 状态 ---------- */
    var state = {
        groups: [],
        total: 0,
        query: '',
        group: '',
        cur: null,        /* { gi, ri } 当前打开的条目 */
        sheets: [],
        sheetIdx: 0,
        sel: { r: 1, c: 0 },
        lastFocus: null
    };

    /* ============================================================
       工具
    ============================================================ */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    /* 0 → A, 25 → Z, 26 → AA */
    function colLetter(i) {
        var s = '', n = i + 1;
        while (n > 0) {
            var m = (n - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    }

    /* 文件名里不能出现的字符换成间隔号（原始名称仍照原样显示在表格里） */
    function fileBase(name) {
        return String(name).replace(/[\\/:*?"<>|]/g, '·').replace(/\s+/g, ' ').trim();
    }

    /* 各组列名不同（国际市场/中国市场：数据库·提供方·主要内容；
       免费公开数据：数据源·内容），统一映射成 [名称, 提供方, 主要内容] */
    function normalize(g, row) {
        var last = row[row.length - 1];
        if (g.columns.length >= 3) return [row[0], row[1] || '', last];
        return [row[0], '', last];
    }

    function match(g, row) {
        if (!state.query) return true;
        var q = state.query.toLowerCase();
        for (var i = 0; i < row.length; i++) {
            if (String(row[i] || '').toLowerCase().indexOf(q) >= 0) return true;
        }
        return false;
    }

    /* ============================================================
       模板块：概览 + Excel 阅读器（一次性注入，之后只改内容）
    ============================================================ */
    function buildSkeleton() {
        host.innerHTML =
            '<div class="db-toolbar">' +
                '<div class="db-stat">' +
                    '<span class="db-stat-total"><b id="dbTotal">0</b><i>个数据源</i></span>' +
                    '<span class="db-stat-sep"></span>' +
                '</div>' +
                '<label class="db-search">' + ICONS.search +
                    '<input id="dbSearch" type="search" autocomplete="off" ' +
                    'placeholder="搜索数据库 / 提供方 / 内容">' +
                '</label>' +
            '</div>' +
            '<div id="dbGroups"></div>' +
            '<div class="db-empty" id="dbEmpty" style="display:none;">' +
                '没有匹配的数据库，换个关键词试试' +
            '</div>' +
            '<p class="db-foot-tip" id="dbFoot"></p>' +
            /* ---------- Excel 阅读模态 ---------- */
            '<div class="xls-mask" id="xlsMask" aria-hidden="true">' +
                '<div class="xls-panel" role="dialog" aria-modal="true" aria-label="数据库表格">' +
                    '<div class="xls-titlebar">' +
                        '<span class="xls-titlebar-ico">' + ICONS.sheet + '</span>' +
                        '<span class="xls-file-name" id="xlsFileName"></span>' +
                        '<span class="xls-file-ext">XLSX</span>' +
                        '<span class="xls-file-sub" id="xlsFileSub"></span>' +
                        '<span class="xls-titlebar-actions">' +
                            '<button type="button" class="xls-act" id="xlsExport">' +
                                ICONS.download + '<span>导出 CSV</span></button>' +
                            '<button type="button" class="xls-close" id="xlsClose" ' +
                                'aria-label="关闭">×</button>' +
                        '</span>' +
                    '</div>' +
                    '<div class="xls-menubar" aria-hidden="true">' +
                        '<span class="xls-menu-item is-active">开始</span>' +
                        '<span class="xls-menu-item">插入</span>' +
                        '<span class="xls-menu-item">公式</span>' +
                        '<span class="xls-menu-item">数据</span>' +
                        '<span class="xls-menu-item">审阅</span>' +
                        '<span class="xls-menu-item">视图</span>' +
                    '</div>' +
                    '<div class="xls-formulabar">' +
                        '<span class="xls-namebox" id="xlsNameBox">A1</span>' +
                        '<span class="xls-fx">fx</span>' +
                        '<span class="xls-formula" id="xlsFormula"></span>' +
                    '</div>' +
                    '<div class="xls-gridwrap" id="xlsGridWrap" tabindex="0">' +
                        '<table class="xls-grid" id="xlsGrid"></table>' +
                    '</div>' +
                    '<div class="xls-sheetbar">' +
                        '<span class="xls-sheetnav" aria-hidden="true">‹ ›</span>' +
                        '<div class="xls-tabs" id="xlsTabs" role="tablist"></div>' +
                        '<span class="xls-sheetadd" aria-hidden="true">+</span>' +
                    '</div>' +
                    '<div class="xls-statusbar">' +
                        '<span id="xlsStatus">就绪</span>' +
                        '<span class="xls-status-right">' +
                            '<span id="xlsStat"></span>' +
                            '<span class="xls-zoom">—<span class="xls-zoom-bar"></span>+ ' +
                            '<span id="xlsZoom">100%</span></span>' +
                        '</span>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    /* ============================================================
       概览渲染
    ============================================================ */
    function renderToolbar() {
        var box = host.querySelector('.db-stat');
        if (!box) return;
        var chips = '<span class="db-chip' + (state.group ? '' : ' is-active') + '" ' +
            'data-g="" role="button" tabindex="0">全部 <b>' + state.total + '</b></span>';
        state.groups.forEach(function (g) {
            chips += '<span class="db-chip' + (state.group === g.id ? ' is-active' : '') + '" ' +
                'data-g="' + esc(g.id) + '" role="button" tabindex="0">' +
                esc(g.name) + ' <b>' + g.rows.length + '</b></span>';
        });
        box.innerHTML =
            '<span class="db-stat-total"><b>' + state.total + '</b><i>个数据源</i></span>' +
            chips;
    }

    function renderGroups() {
        var wrap = host.querySelector('#dbGroups');
        if (!wrap) return;
        var html = '';
        var shown = 0;

        state.groups.forEach(function (g, gi) {
            if (state.group && state.group !== g.id) return;

            var rows = [];
            g.rows.forEach(function (r, ri) {
                if (match(g, r)) rows.push({ r: r, ri: ri });
            });
            if (!rows.length) return;
            shown += rows.length;

            var cols = ['#'].concat(g.columns).concat(['']);
            var head = '<tr>' + cols.map(function (c, i) {
                var cls = i === 0 ? 'db-c-idx'
                    : (i === 1 ? 'db-c-name'
                    : (i === cols.length - 1 ? 'db-c-act' : ''));
                if (i === g.columns.length) cls = 'db-c-act';
                return '<th class="' + cls + '">' + esc(c) + '</th>';
            }).join('') + '</tr>';

            var body = rows.map(function (o) {
                var cells = '<td class="db-c-idx">' + pad2(o.ri + 1) + '</td>';
                o.r.forEach(function (v, ci) {
                    if (ci === 0) {
                        cells += '<td class="db-c-name">' +
                            '<button type="button" class="db-open" data-gi="' + gi + '" ' +
                            'data-ri="' + o.ri + '" title="打开 ' + esc(fileBase(v)) + '.xlsx">' +
                            '<span class="db-open-ico">' + ICONS.sheet + '</span>' +
                            '<span class="db-open-name">' + esc(v) + '</span>' +
                            '</button></td>';
                    } else {
                        cells += '<td class="' + (ci === 1 ? 'db-c-provider' : '') + '">' +
                            esc(v || '—') + '</td>';
                    }
                });
                cells += '<td class="db-c-act"><span class="db-cta">打开表格' +
                    ICONS.arrow + '</span></td>';
                return '<tr class="db-row">' + cells + '</tr>';
            }).join('');

            html +=
                '<section class="db-group" data-g="' + esc(g.id) + '">' +
                    '<div class="db-group-head">' +
                        '<h3 class="db-group-name">' + esc(g.name) + '</h3>' +
                        '<span class="db-group-count">' + g.rows.length + '</span>' +
                        '<span class="db-group-sub">' + esc(g.subtitle || '') + '</span>' +
                    '</div>' +
                    '<div class="db-table-scroll">' +
                        '<table class="db-table"><thead>' + head + '</thead>' +
                        '<tbody>' + body + '</tbody></table>' +
                    '</div>' +
                '</section>';
        });

        wrap.innerHTML = html;
        var emptyEl = host.querySelector('#dbEmpty');
        if (emptyEl) emptyEl.style.display = shown ? 'none' : 'block';
    }

    function renderFoot() {
        var f = host.querySelector('#dbFoot');
        if (!f) return;
        f.textContent = '共 ' + state.total + ' 个数据源 · 点击表格中的数据库名称即可打开对应的 Excel 表格' +
            '（可选中单元格、切换工作表，并导出为 CSV）。';
    }

    function renderAll() {
        renderToolbar();
        renderGroups();
    }

    /* ============================================================
       Excel 工作簿
    ============================================================ */
    function buildSheets(gi, ri) {
        var g = state.groups[gi];
        var row = g.rows[ri];

        /* 工作表 1 · 档案 */
        var detail = {
            name: '档案',
            cols: [110, 620],
            head: ['字段', '内容'],
            rows: [],
            currentCellRow: -1
        };
        g.columns.forEach(function (c, i) { detail.rows.push([c, row[i]]); });
        detail.rows.push(['所属板块', g.name]);
        detail.rows.push(['序号', pad2(ri + 1) + ' / ' + pad2(g.rows.length)]);

        /* 工作表 2 · 全部数据库（当前条目高亮） */
        var master = {
            name: '全部数据库',
            cols: [92, 56, 210, 232, 300],
            head: ['板块', '序号', '数据库 / 数据源', '提供方', '主要内容'],
            rows: [],
            currentCellRow: -1
        };
        var n = 0;
        state.groups.forEach(function (gg, gi2) {
            gg.rows.forEach(function (r2, ri2) {
                n++;
                var nz = normalize(gg, r2);
                master.rows.push([gg.name, pad2(ri2 + 1), nz[0], nz[1] || '—', nz[2]]);
                if (gi2 === gi && ri2 === ri) master.currentCellRow = master.rows.length; /* +1 补表头行 */
            });
        });
        master.total = n;

        [detail, master].forEach(function (sh) {
            sh.cells = sh.head ? [sh.head].concat(sh.rows) : sh.rows.slice();
        });
        return [detail, master];
    }

    var els = {};   /* 延迟取，skel 注入后再填 */

    function cacheEls() {
        ['xlsMask', 'xlsPanel', 'xlsGrid', 'xlsGridWrap', 'xlsTabs', 'xlsNameBox',
         'xlsFormula', 'xlsStatus', 'xlsStat', 'xlsFileName', 'xlsFileSub',
         'xlsClose', 'xlsExport', 'xlsZoom'].forEach(function (id) {
            els[id] = document.getElementById(id);
        });
    }

    function renderTabs() {
        if (!els.xlsTabs) return;
        els.xlsTabs.innerHTML = state.sheets.map(function (sh, i) {
            return '<button type="button" class="xls-tab' + (i === state.sheetIdx ? ' is-active' : '') +
                '" data-si="' + i + '" role="tab" ' +
                'aria-selected="' + (i === state.sheetIdx) + '">' + esc(sh.name) + '</button>';
        }).join('');
    }

    function renderGrid() {
        var sh = state.sheets[state.sheetIdx];
        if (!sh || !els.xlsGrid) return;

        var widths = sh.cols.slice();
        var totalW = widths.reduce(function (a, b) { return a + b; }, 48);

        var html = '<colgroup><col style="width:48px">' +
            widths.map(function (w) { return '<col style="width:' + w + 'px">'; }).join('') +
            '</colgroup><thead><tr><th class="xls-corner"></th>' +
            widths.map(function (w, i) { return '<th data-c="' + i + '">' + colLetter(i) + '</th>'; }).join('') +
            '</tr></thead><tbody>';

        sh.cells.forEach(function (r, ri) {
            var cls = [];
            if (ri === 0 && sh.head) cls.push('xls-headrow');
            if (sh.currentCellRow === ri) cls.push('is-current');
            html += '<tr data-ri="' + ri + '"' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' +
                '<th class="xls-rownum" data-r="' + (ri + 1) + '">' + (ri + 1) + '</th>';
            for (var c = 0; c < widths.length; c++) {
                html += '<td data-r="' + (ri + 1) + '" data-c="' + c + '">' +
                    esc(r[c] == null ? '' : r[c]) + '</td>';
            }
            html += '</tr>';
        });
        html += '</tbody>';

        els.xlsGrid.style.width = totalW + 'px';
        els.xlsGrid.innerHTML = html;

        els.xlsStat.textContent = '行 ' + sh.cells.length + ' · 列 ' + widths.length +
            (sh.total ? ' · 记录 ' + sh.total + ' 条' : '');

        setSel(1, 0);
        /* 「全部数据库」表：把当前条目滚到视野中间（直接操作 scrollTop，避免惊动整页） */
        if (sh.currentCellRow > 0) {
            var tr = els.xlsGrid.querySelector('tr[data-ri="' + sh.currentCellRow + '"]');
            if (tr) {
                els.xlsGridWrap.scrollTop =
                    Math.max(0, tr.offsetTop - els.xlsGridWrap.clientHeight / 2 + tr.offsetHeight / 2);
            }
        } else {
            els.xlsGridWrap.scrollTop = 0;
        }
        els.xlsGridWrap.scrollLeft = 0;
    }

    /* ---------- 选中态 ---------- */
    function setSel(r, c) {
        var sh = state.sheets[state.sheetIdx];
        if (!sh) return;
        var maxR = sh.cells.length;
        var maxC = sh.cols.length;
        if (r < 1) r = 1;
        if (r > maxR) r = maxR;
        if (c < 0) c = 0;
        if (c > maxC - 1) c = maxC - 1;

        var grid = els.xlsGrid;
        var old = grid.querySelectorAll('.is-sel, .is-selcol, .is-selrow');
        Array.prototype.forEach.call(old, function (el) {
            el.classList.remove('is-sel', 'is-selcol', 'is-selrow');
        });

        var td = grid.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
        if (td) td.classList.add('is-sel');
        var thc = grid.querySelector('thead th[data-c="' + c + '"]');
        if (thc) thc.classList.add('is-selcol');
        var thr = grid.querySelector('tbody th.xls-rownum[data-r="' + r + '"]');
        if (thr) thr.classList.add('is-selrow');

        state.sel = { r: r, c: c };
        els.xlsNameBox.textContent = colLetter(c) + r;
        var txt = td ? (td.textContent || '') : '';
        els.xlsFormula.textContent = txt || '（空单元格）';
        els.xlsFormula.classList.toggle('is-empty', !txt);
        els.xlsStatus.textContent = '已选中 1 个单元格';
    }

    function moveSel(dr, dc) { setSel(state.sel.r + dr, state.sel.c + dc); }

    /* ---------- 打开 / 关闭 ---------- */
    function open(gi, ri) {
        var g = state.groups[gi];
        if (!g || !g.rows[ri]) return false;

        state.cur = { gi: gi, ri: ri };
        state.sheets = buildSheets(gi, ri);
        state.sheetIdx = 0;

        var name = g.rows[ri][0];
        els.xlsFileName.textContent = fileBase(name) + '.xlsx';
        els.xlsFileSub.textContent = '数据库档案 · ' + g.name +
            ' · 第 ' + pad2(ri + 1) + ' / ' + pad2(g.rows.length) + ' 条';

        renderTabs();
        renderGrid();

        state.lastFocus = document.activeElement;
        els.xlsMask.classList.add('show');
        els.xlsMask.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(function () { els.xlsGridWrap.focus(); }, 60);
        return true;
    }

    function close() {
        if (!els.xlsMask.classList.contains('show')) return;
        els.xlsMask.classList.remove('show');
        els.xlsMask.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        state.cur = null;
        if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    }

    function switchSheet(i) {
        if (!state.sheets[i] || i === state.sheetIdx) return;
        state.sheetIdx = i;
        renderTabs();
        renderGrid();
    }

    /* ---------- 导出当前工作表 ---------- */
    function exportCsv() {
        var sh = state.sheets[state.sheetIdx];
        if (!sh || !state.cur) return;
        var g = state.groups[state.cur.gi];
        var base = fileBase(g.rows[state.cur.ri][0]);

        var csv = sh.cells.map(function (r) {
            return sh.cols.map(function (_, c) {
                var v = (r[c] == null ? '' : String(r[c])).replace(/"/g, '""');
                return /[",\n]/.test(v) ? '"' + v + '"' : v;
            }).join(',');
        }).join('\r\n');

        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = base + '_' + sh.name + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);

        els.xlsStatus.textContent = '已导出「' + sh.name + '」为 CSV';
        setTimeout(function () {
            if (els.xlsMask.classList.contains('show')) els.xlsStatus.textContent = '就绪';
        }, 2200);
    }

    /* ============================================================
       事件绑定
    ============================================================ */
    function bind() {
        /* 搜索 */
        var input = host.querySelector('#dbSearch');
        if (input) {
            input.addEventListener('input', function () {
                state.query = this.value.trim();
                renderGroups();
            });
        }

        /* 分组筛选 chip */
        var stat = host.querySelector('.db-stat');
        if (stat) {
            stat.addEventListener('click', function (e) {
                var chip = e.target.closest('.db-chip');
                if (!chip) return;
                state.group = chip.dataset.g || '';
                renderAll();
            });
            stat.addEventListener('keydown', function (e) {
                var chip = e.target.closest('.db-chip');
                if (!chip) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    state.group = chip.dataset.g || '';
                    renderAll();
                }
            });
        }

        /* 打开表格 */
        var groups = host.querySelector('#dbGroups');
        if (groups) {
            groups.addEventListener('click', function (e) {
                var btn = e.target.closest('.db-open');
                if (!btn) return;
                open(+btn.dataset.gi, +btn.dataset.ri);
            });
        }

        if (!els.xlsMask || !els.xlsGrid || !els.xlsGridWrap) return;

        /* 工作表标签 */
        if (els.xlsTabs) {
            els.xlsTabs.addEventListener('click', function (e) {
                var t = e.target.closest('.xls-tab');
                if (t) switchSheet(+t.dataset.si);
            });
        }

        /* 选单元格 */
        els.xlsGrid.addEventListener('click', function (e) {
            var td = e.target.closest('td[data-r]');
            if (!td) return;
            setSel(+td.dataset.r, +td.dataset.c);
        });

        /* 键盘：方向键移格、Home/End、Esc 关闭 */
        els.xlsGridWrap.addEventListener('keydown', function (e) {
            var k = e.key;
            var handled = true;
            if (k === 'ArrowDown') moveSel(1, 0);
            else if (k === 'ArrowUp') moveSel(-1, 0);
            else if (k === 'ArrowRight') moveSel(0, 1);
            else if (k === 'ArrowLeft') moveSel(0, -1);
            else if (k === 'Home') setSel(state.sel.r, 0);
            else if (k === 'End') setSel(state.sel.r, state.sheets[state.sheetIdx].cols.length - 1);
            else handled = false;
            if (handled) {
                e.preventDefault();
                e.stopPropagation();    /* 别让 ←/→ 触发整页切换 */
            }
        });

        /* 关闭：按钮 / 点遮罩 / Esc */
        if (els.xlsClose) els.xlsClose.addEventListener('click', close);
        if (els.xlsExport) els.xlsExport.addEventListener('click', exportCsv);
        els.xlsMask.addEventListener('click', function (e) {
            if (e.target === els.xlsMask) close();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') close();
        });
    }

    /* ============================================================
       取数 + 渲染
    ============================================================ */
    function fetchData() {
        return new Promise(function (resolve, reject) {
            if (window.__DB_DATA__) { resolve(window.__DB_DATA__); return; }
            if (USE_API) {
                fetch(DB_API, { cache: 'no-cache' })
                    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function (j) { resolve(j && j.code === 0 ? j.data : j); }, reject);
                return;
            }
            fetch(DATA_URL, { cache: 'no-cache' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(resolve, reject);
        });
    }

    function fail(err) {
        var load = document.getElementById('dbLoading');
        if (load) {
            load.textContent = '数据清单加载失败（' + (err && err.message ? err.message : err) +
                '）。请通过「启动网页.bat」以本地服务方式打开，或检查 data/databases.json。';
        }
    }

    function start() {
        buildSkeleton();
        cacheEls();
        bind();

        fetchData().then(function (data) {
            state.groups = (data && data.groups) || [];
            state.total = state.groups.reduce(function (a, g) { return a + g.rows.length; }, 0);
            var load = document.getElementById('dbLoading');
            if (load) load.style.display = 'none';
            renderAll();
            renderFoot();
        }).catch(fail);
    }

    /* 对外 API（供其他模块/自检使用） */
    window.DatabaseBoard = {
        open: open,
        close: close,
        switchSheet: switchSheet,
        setQuery: function (q) {
            state.query = q || '';
            var i = host.querySelector('#dbSearch');
            if (i) i.value = state.query;
            renderGroups();
        },
        get data() { return state.groups; },
        get total() { return state.total; },
        get current() { return state.cur; },
        get sheetName() {
            return state.sheets[state.sheetIdx] ? state.sheets[state.sheetIdx].name : null;
        },
        get sheetCount() { return state.sheets.length; },
        DB_API: DB_API
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
