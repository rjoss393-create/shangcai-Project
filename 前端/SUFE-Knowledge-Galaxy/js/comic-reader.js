/* ============================================================
   知识点小漫画 · 阅读器（外挂式，配套 css/comic-reader.css）
   ------------------------------------------------------------
   数据来源：
     · 节点上的 media.comic（由 scripts/link_comics.py 按「章」挂到知识点节点上）
         { album: 'inv_p01', page: 2, part: '绪论：什么是投资', part_no: 1,
           title: '实物资产与金融资产', section: '投资的定义', course: 'invest' }
     · 清单 /data/comics.json（24 部 × 6 页的标题与图片文件名，后端 data/media/comics.json）
     · 图片 /assets/comics/<dir>/<album>_<n>.jpg

   两个职责：
     1) 在「知识节点」详情面板（#kgDetail）里补一个入口卡片（.kg-comic）
        —— 谁当前被选中从 window.GalaxyEngine.state.microId 取，不依赖面板里的文字，
           所以第 5/6 层（名词解释 / 深层内容）面板同样能进漫画。
     2) 点开后进全屏遮罩翻页看整部（6 页：封面 / 4 个知识点 / 小结）。

   ★ 键盘：本组件在 window + document 的**捕获阶段**拦 keydown 并
     stopImmediatePropagation()，所以 page-slider（挂在 document 冒泡阶段）收不到
     方向键 —— 无需修改 page-slider.js 的 MODAL_SELECTOR 一行。
     （往那个列表里加常驻元素会把它变成恒真、全站翻页失效，踩过。）

   ★ 整块外挂：删掉 index.html 里的 css/script 两行即完全还原。
   ============================================================ */
(function () {
    'use strict';

    if (window.__COMIC_READER__) return;
    window.__COMIC_READER__ = true;

    var MANIFEST_URL = '/data/comics.json';
    var ASSET_PREFIX = '/assets/comics/';
    var PAGES_PER_PART = 6;

    var state = {
        index: null,      // { <albumId>: album }
        loading: null,    // 清单 Promise（去重）
        album: null,      // 当前打开的一部
        page: 1,          // 当前页（1 起）
        token: 0          // 防止异步串台
    };

    var el = {};
    var bound = false;
    var observer = null;
    var syncBusy = false;

    /* ---------------- 工具 ---------------- */

    function q(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function albumBase(albumId) {
        return String(albumId || '').replace(/_p\d+$/, '');
    }

    function pageUrl(album, n) {
        if (album.files && album.files[n - 1]) return album.dir + '/' + album.files[n - 1];
        return ASSET_PREFIX + albumBase(album.id) + '/' + album.id + '_' + n + '.jpg';
    }

    function pageTitle(album, n) {
        var pages = album.pages || [];
        for (var i = 0; i < pages.length; i++) {
            if (pages[i].index === n) return pages[i].title || '';
        }
        return '';
    }

    /* ---------------- 清单 ---------------- */

    function ensureManifest() {
        if (state.index) return Promise.resolve(state.index);
        if (!state.loading) {
            state.loading = fetch(MANIFEST_URL, { cache: 'force-cache' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (json) {
                    var idx = {};
                    (json.albums || []).forEach(function (a) { idx[a.id] = a; });
                    if (!Object.keys(idx).length) throw new Error('清单为空');
                    state.index = idx;
                    return idx;
                })
                .catch(function (err) {
                    state.loading = null;
                    throw err;
                });
        }
        return state.loading;
    }

    /* 清单拿不到时，用节点上的字段拼一个「只有对应那一页」的部，至少能看图 */
    function fallbackAlbum(comic) {
        var dir = ASSET_PREFIX + albumBase(comic.album);
        var files = [];
        var pages = [];
        for (var i = 1; i <= PAGES_PER_PART; i++) {
            files.push(comic.album + '_' + i + '.jpg');
            pages.push({
                index: i,
                role: i === 1 ? 'cover' : (i === PAGES_PER_PART ? 'summary' : 'point'),
                title: i === comic.page ? comic.title : '',
                section: i === comic.page ? comic.section : null
            });
        }
        return {
            id: comic.album, dir: dir, files: files, pages: pages,
            title: comic.part || '', subtitle: '', part: comic.part_no || 0,
            course: comic.course || '', _fallback: true
        };
    }

    /* ---------------- 当前知识节点上的漫画 ---------------- */

    function currentNode() {
        var eng = window.GalaxyEngine;
        if (!eng || !eng.state) return null;
        var id = eng.state.microId;
        if (!id) return null;
        var nodes = eng.state.nodes || [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i] && nodes[i].id === id) return nodes[i];
        }
        return null;
    }

    function comicOf(node) {
        var m = node && node.media;
        return (m && m.comic && m.comic.album) ? m.comic : null;
    }

    /* ---------------- 详情面板入口 ---------------- */

    function buildEntry(body) {
        var box = document.createElement('div');
        box.className = 'kg-comic';
        box.id = 'kgComicEntry';
        box.hidden = true;
        box.innerHTML =
            '<button class="kg-comic-btn" id="kgComicBtn" type="button">🎨 看图解漫画</button>' +
            '<span class="kg-comic-hint" id="kgComicHint"></span>';
        var badges = q('kgDetailBadges');
        if (badges && badges.parentNode === body) badges.insertAdjacentElement('afterend', box);
        else body.insertBefore(box, body.firstChild);
        q('kgComicBtn').addEventListener('click', function () {
            var c = comicOf(currentNode());
            if (c) open(c.album, c.page);
        });
        return box;
    }

    /* 幂等：内容没变就不写 DOM（否则喂给自己的 MutationObserver 会空转） */
    function syncEntry() {
        var panel = q('kgDetail');
        if (!panel || !bound) return;
        var body = panel.querySelector('.kg-detail-body');
        if (!body) return;

        var comic = panel.classList.contains('show') ? comicOf(currentNode()) : null;
        var entry = q('kgComicEntry');

        if (!comic) {
            if (entry && !entry.hidden) entry.hidden = true;
            return;
        }
        if (!entry) entry = buildEntry(body);

        var hint = q('kgComicHint');
        var txt = '第 ' + comic.part_no + ' 部 · ' + (comic.part || '') +
                  (comic.title ? '｜' + comic.title : '') +
                  (comic.section ? '（' + comic.section + '）' : '');
        if (hint.textContent !== txt) hint.textContent = txt;
        if (entry.hidden) entry.hidden = false;
    }

    function scheduleSync() {
        if (syncBusy) return;
        syncBusy = true;
        requestAnimationFrame(function () {
            syncBusy = false;
            try { syncEntry(); } catch (e) { /* 面板结构异常时静默，不影响主流程 */ }
        });
    }

    function bindPanel() {
        var panel = q('kgDetail');
        if (!panel) return false;
        observer = new MutationObserver(scheduleSync);
        observer.observe(panel, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['class']
        });
        bound = true;
        scheduleSync();
        return true;
    }

    /* ---------------- 阅读器 ---------------- */

    function cacheEl() {
        el.mask = q('comicMask');
        el.img = q('comicImg');
        el.msg = q('comicMsg');
        el.title = q('comicBarTitle');
        el.sub = q('comicBarSub');
        el.badge = q('comicBarBadge');
        el.counter = q('comicCounter');
        el.prev = q('comicPrev');
        el.next = q('comicNext');
        el.close = q('comicClose');
        el.thumbs = q('comicThumbs');
        el.hotL = q('comicHotL');
        el.hotR = q('comicHotR');
    }

    function bindOnce() {
        if (el.prev) el.prev.addEventListener('click', function () { go(-1); });
        if (el.next) el.next.addEventListener('click', function () { go(1); });
        if (el.hotL) el.hotL.addEventListener('click', function () { go(-1); });
        if (el.hotR) el.hotR.addEventListener('click', function () { go(1); });
        if (el.close) el.close.addEventListener('click', close);
        if (el.mask) {
            el.mask.addEventListener('click', function (e) {
                // 点遮罩空白（不是舞台里的图/按钮）关闭
                if (e.target === el.mask) close();
            });
        }
    }

    function render() {
        var album = state.album;
        if (!album) return;
        var n = state.page;
        var url = pageUrl(album, n);

        if (el.badge) el.badge.textContent = (album.course_label || '') ?
            '知识点小漫画 · ' + album.course_label : '知识点小漫画';
        if (el.title) el.title.textContent = '第 ' + (album.part || '') + ' 部 · ' + (album.title || '');
        var sub = pageTitle(album, n);
        if (el.sub) el.sub.textContent = sub ? sub : (album.subtitle || '');
        if (el.counter) el.counter.textContent = n + ' / ' + PAGES_PER_PART;

        if (el.msg) { el.msg.hidden = false; el.msg.textContent = '漫画加载中…'; }
        if (el.img) {
            el.img.hidden = true;
            el.img.onload = function () {
                el.img.hidden = false;
                if (el.msg) el.msg.hidden = true;
            };
            el.img.onerror = function () {
                el.img.hidden = true;
                if (el.msg) { el.msg.hidden = false; el.msg.textContent = '这一页加载失败：' + url; }
            };
            el.img.src = url;
            el.img.alt = '第 ' + (album.part || '') + ' 部 · ' + (sub || '漫画');
        }

        if (el.prev) el.prev.disabled = (n <= 1);
        if (el.next) el.next.disabled = (n >= PAGES_PER_PART);
        if (el.hotL) el.hotL.disabled = (n <= 1);
        if (el.hotR) el.hotR.disabled = (n >= PAGES_PER_PART);

        if (el.thumbs) {
            var cur = el.thumbs.querySelector('.comic-thumb.is-cur');
            if (cur) cur.classList.remove('is-cur');
            var target = el.thumbs.querySelector('[data-page="' + n + '"]');
            if (target) target.classList.add('is-cur');
        }

        // 预取相邻页，翻页不闪
        [n - 1, n + 1].forEach(function (k) {
            if (k < 1 || k > PAGES_PER_PART) return;
            var im = new Image();
            im.src = pageUrl(album, k);
        });
    }

    function buildThumbs(album) {
        if (!el.thumbs) return;
        var html = '';
        for (var i = 1; i <= PAGES_PER_PART; i++) {
            html += '<button class="comic-thumb" type="button" data-page="' + i +
                    '" style="background-image:url(' + pageUrl(album, i) + ')"' +
                    ' aria-label="第 ' + i + ' 页">' +
                    '<span class="comic-thumb-num">' + i + '</span></button>';
        }
        el.thumbs.innerHTML = html;
        el.thumbs.querySelectorAll('.comic-thumb').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.page = Number(btn.dataset.page) || 1;
                render();
            });
        });
    }

    function go(delta) {
        var n = state.page + delta;
        if (n < 1 || n > PAGES_PER_PART) return;
        state.page = n;
        render();
    }

    function open(albumId, page) {
        if (!el.mask) return;
        state.token += 1;
        var token = state.token;

        ensureManifest()
            .then(function (idx) { return idx[albumId] || null; })
            .catch(function () { return null; })
            .then(function (album) {
                if (token !== state.token) return;
                if (!album) {
                    var c = comicOf(currentNode());
                    album = (c && c.album === albumId) ? fallbackAlbum(c) : null;
                }
                if (!album) return;
                state.album = album;
                state.page = Math.min(Math.max(Number(page) || 1, 1), PAGES_PER_PART);
                buildThumbs(album);
                render();
                el.mask.classList.add('is-open');
                document.body.classList.add('comic-open');
                attachGuard();
            });
    }

    function close() {
        state.token += 1;
        if (el.mask) el.mask.classList.remove('is-open');
        document.body.classList.remove('comic-open');
        detachGuard();
    }

    /* ---------------- 键盘守卫 ---------------- */

    function onGuardKey(e) {
        if (!el.mask || !el.mask.classList.contains('is-open')) return;
        // 一律不让事件流到 page-slider（它挂在 document 冒泡阶段）
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
            e.preventDefault(); go(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
            e.preventDefault(); go(-1);
        } else if (e.key === 'Home') {
            e.preventDefault(); state.page = 1; render();
        } else if (e.key === 'End') {
            e.preventDefault(); state.page = PAGES_PER_PART; render();
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

    /* ---------------- 启动 ---------------- */

    function init() {
        cacheEl();
        if (!el.mask) return;      // index.html 里没挂遮罩，整个组件静默退出
        bindOnce();
        if (!bindPanel()) {
            // 面板还没进 DOM（知识星系是懒初始化）——轮询几次再绑
            var tries = 0;
            var timer = setInterval(function () {
                tries += 1;
                if (bindPanel() || tries > 40) clearInterval(timer);
            }, 500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ComicReader = {
        open: open,
        close: close,
        /** 当前节点是否有漫画（调试用） */
        peek: function () { return comicOf(currentNode()); }
    };
})();
