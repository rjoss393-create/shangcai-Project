/* ============================================================
   教材原文阅读（入口在「书籍详情」弹窗里）
   ------------------------------------------------------------
   · 清单与文件都由后端提供：
       GET /data/textbooks.json        -> data/media/textbooks.json（书名/作者/页数/格式/体积）
       GET /assets/textbooks/<file>    -> data/media/textbooks/<file>（StaticFiles，支持 Range）
   · 用法：window.TextbookReader.open('nelson-winter-1982')
     书架上某本书有没有电子版，由 main.js 里 BOOKS 条目的 `textbookId` 字段决定。
   · PDF 直接用 <iframe> 交给浏览器自带阅读器（可滚动、缩放、搜索、跳页）；
     EPUB 用本地化的 epub.js + JSZip 渲染（js/epub.min.js、js/jszip.min.js，禁止外链 CDN）。
   · 完全外挂：删掉 index.html 里 <link css/textbook-reader.css> 与
     <script js/textbook-reader.js>、（以及 main.js 详情弹窗里的那一小段挂载）即完全还原。
   · 阅读遮罩打开期间，用 window 捕获阶段的键盘守卫拦住 ←/→/Home/End，
     避免 page-slider 在遮罩背后偷偷翻页（page-slider 只认 body.immersive，用它副作用太大）。
   ============================================================ */
(function () {
    'use strict';

    if (window.__TB_READER__) return;
    window.__TB_READER__ = true;

    var MANIFEST_URL = '/data/textbooks.json';
    var LIB_JSZIP = 'js/jszip.min.js';
    var LIB_EPUB = 'js/epub.min.js';

    var state = {
        index: null,         // { <id>: book }
        loading: null,       // 清单 Promise（去重）
        type: null,          // 'pdf' | 'epub'
        epubBook: null,
        rendition: null,
        token: 0             // 防止异步加载串台（快速连点两本时）
    };

    var el = {};             // DOM 缓存
    var bound = false;

    /* ---------------- 工具 ---------------- */

    function q(id) { return document.getElementById(id); }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
            document.head.appendChild(s);
        });
    }

    function ensureLib(name) {
        if (name === 'jszip' && window.JSZip) return Promise.resolve();
        if (name === 'epub' && window.ePub) return Promise.resolve();
        if (!state['lib_' + name]) {
            state['lib_' + name] = loadScript(name === 'jszip' ? LIB_JSZIP : LIB_EPUB);
        }
        return state['lib_' + name];
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmtFacts(book) {
        var parts = [];
        if (book.pages) parts.push(book.pages + ' 页');
        if (book.chapters) parts.push(book.chapters + ' 章');
        if (book.sizeMB) parts.push(book.sizeMB + ' MB');
        return parts.join(' · ');
    }

    /* ---------------- 清单 ---------------- */

    function ensureManifest() {
        if (state.index) return Promise.resolve(state.index);
        if (!state.loading) {
            state.loading = fetch(MANIFEST_URL)
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (data) {
                    var idx = {};
                    ((data && data.books) || []).forEach(function (b) { idx[b.id] = b; });
                    state.index = idx;
                    return idx;
                })
                .catch(function (err) {
                    state.loading = null;   // 允许下次重试
                    throw err;
                });
        }
        return state.loading;
    }

    /* ---------------- 遮罩与标题栏 ---------------- */

    function bind() {
        if (bound) return true;
        el.mask = q('tbReaderMask');
        if (!el.mask) return false;

        el.stage = q('tbReaderStage');
        el.barTitle = q('tbReaderTitle');
        el.barSub = q('tbReaderSub');
        el.barPos = q('tbReaderPos');
        el.prev = q('tbReaderPrev');
        el.next = q('tbReaderNext');
        el.openLink = q('tbReaderOpen');

        q('tbReaderClose').addEventListener('click', close);
        el.prev.addEventListener('click', function () { epubGo(-1); });
        el.next.addEventListener('click', function () { epubGo(1); });
        el.mask.addEventListener('click', function (e) {
            if (e.target === el.mask) close();
        });
        bound = true;
        return true;
    }

    function setBar(title, sub, pos) {
        el.barTitle.textContent = title || '';
        el.barSub.textContent = sub || '';
        el.barPos.textContent = pos || '';
    }

    function stageReset() {
        el.stage.innerHTML = '';
    }

    function showMessage(text) {
        stageReset();
        var p = document.createElement('div');
        p.className = 'tb-loading';
        p.textContent = text;
        el.stage.appendChild(p);
    }

    /* EPUB 位置：spine 序号 + 章内页（epub.js 分页模式下章内会再分多页，
       只显示 spine 序号会出现「点了下一页数字不动」的错觉） */
    function epubPos(loc, total) {
        var st = loc && loc.start;
        var d = st && st.displayed;
        var s = '';
        if (st && typeof st.index === 'number' && total) s = (st.index + 1) + ' / ' + total;
        if (d && typeof d.page === 'number' && d.total > 1) {
            s += (s ? '  ·  ' : '') + d.page + '/' + d.total + ' 页';
        }
        return s;
    }

    /* ---------------- 键盘守卫 ---------------- */

    function onGuardKey(e) {
        if (!el.mask.classList.contains('is-open')) return;
        // 一律不让事件流到 page-slider（它挂在 document 上）
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (state.type !== 'epub') return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
            e.preventDefault(); epubGo(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault(); epubGo(-1);
        }
    }

    function attachGuard() {
        document.addEventListener('keydown', onGuardKey, true);
        window.addEventListener('keydown', onGuardKey, true);
    }

    function detachGuard() {
        document.removeEventListener('keydown', onGuardKey, true);
        window.removeEventListener('keydown', onGuardKey, true);
    }

    /* ---------------- 打开一本书 ---------------- */

    function openBook(book) {
        destroyEpub();
        state.type = book.type;
        el.openLink.href = book.url;

        if (book.type === 'pdf') {
            el.prev.hidden = true;
            el.next.hidden = true;
            // 浏览器自带 PDF 阅读器：可滚动/缩放/搜索/跳页，#view=FitH 让首页按宽度铺满
            el.stage.innerHTML = '<iframe class="tb-frame" title="' + escapeHtml(book.titleCn) +
                '" src="' + escapeHtml(book.url) + '#view=FitH"></iframe>';
            setBar(book.titleCn || book.titleEn,
                (book.author || '') + '  ·  ' + fmtFacts(book),
                'PDF · ' + (book.pages ? book.pages + ' 页' : ''));
            return;
        }

        el.prev.hidden = false;
        el.next.hidden = false;
        setBar(book.titleCn || book.titleEn,
            (book.author || '') + '  ·  ' + fmtFacts(book), '');
        showMessage('正在载入 EPUB…');

        var token = state.token;
        Promise.all([ensureLib('jszip'), ensureLib('epub')]).then(function () {
            if (token !== state.token) return;
            if (typeof window.ePub !== 'function') throw new Error('epub.js 未就绪');

            stageReset();          // 清掉「正在载入」提示，别压在正文上
            var epubBook = window.ePub(book.url);
            state.epubBook = epubBook;

            var rendition = epubBook.renderTo(el.stage, {
                width: '100%',
                height: '100%',
                flow: 'paginated',
                spread: 'none',
                allowScriptedContent: false
            });
            state.rendition = rendition;

            rendition.themes.default({
                body: {
                    'font-family': '"Source Han Serif SC","思源宋体",Georgia,serif',
                    'color': '#2b2b28',
                    'background': '#fbfaf7',
                    'line-height': '1.75',
                    'padding': '0 6%'
                },
                img: { 'max-width': '100%', 'height': 'auto' },
                'p': { 'font-size': '15px' },
                /* 目录/交叉引用是 <a>，默认蓝色与站点不搭，统一成财大红 */
                'a': { 'color': '#8f1f24', 'text-decoration': 'none' },
                'a:visited': { 'color': '#8f1f24' },
                'a:hover': { 'text-decoration': 'underline' }
            });

            var total = 0;
            epubBook.ready.then(function () {
                total = epubBook.spine ? epubBook.spine.length : 0;
                el.barPos.textContent = total ? '1 / ' + total : '';
            });

            rendition.on('relocated', function (loc) {
                el.barPos.textContent = epubPos(loc, total);
            });

            rendition.display().then(function () {
                el.barPos.textContent = epubPos(rendition.currentLocation(), total);
            }).catch(function (err) {
                showMessage('这本 EPUB 打不开：' + (err && err.message ? err.message : err) +
                    ' —— 可点右上角「新标签打开」下载后本地查看。');
            });
        }).catch(function (err) {
            if (token !== state.token) return;
            showMessage('EPUB 阅读组件加载失败：' + (err && err.message ? err.message : err));
        });
    }

    /** 打开教材：id 取自 data/media/textbooks.json 的 id 字段 */
    function open(id) {
        if (!bind()) return;
        state.token += 1;
        destroyEpub();

        el.mask.classList.add('is-open');
        attachGuard();
        setBar('教材原文', '', '');
        showMessage('正在读取教材清单…');

        var token = state.token;
        ensureManifest().then(function (idx) {
            if (token !== state.token) return;
            var book = idx[id];
            if (!book) { showMessage('教材清单里没有这本书（id: ' + id + '）'); return; }
            openBook(book);
        }).catch(function (err) {
            if (token !== state.token) return;
            showMessage('教材清单加载失败：' + (err && err.message ? err.message : err) +
                '（需要后端提供 /data/textbooks.json）');
        });
    }

    function epubGo(step) {
        if (!state.rendition) return;
        if (step > 0) state.rendition.next(); else state.rendition.prev();
    }

    function destroyEpub() {
        if (state.rendition) {
            try { state.rendition.destroy(); } catch (e) { /* ignore */ }
            state.rendition = null;
        }
        if (state.epubBook) {
            try { state.epubBook.destroy(); } catch (e) { /* ignore */ }
            state.epubBook = null;
        }
    }

    function close() {
        state.token += 1;
        if (el.mask) el.mask.classList.remove('is-open');
        detachGuard();
        destroyEpub();
        if (el.stage) stageReset();
        state.type = null;
    }

    window.TextbookReader = {
        open: open,
        close: close,
        /** 清单里是否有这本书（异步，只在需要时才用；平时直接看 BOOKS 里的 textbookId） */
        has: function (id) {
            return ensureManifest().then(function (idx) { return !!idx[id]; })
                .catch(function () { return false; });
        },
        get: function (id) {
            return ensureManifest().then(function (idx) { return idx[id] || null; })
                .catch(function () { return null; });
        }
    };
})();
