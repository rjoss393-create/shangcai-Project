/* ============================================================
   页面左右切换（Page Slider）
   ------------------------------------------------------------
   · 把 <main> 下的 .page-section 变成「一页一屏、左右切换」，
     切换时拉下不透明的财大红翻页幕布（带米白页码铭牌）遮住旧页，
     幕布停留期间完成后台换页，再推走露出新页。
   · 完全外挂：不修改 main.js。切换靠重写 Element.prototype.scrollIntoView
     接管（main.js 里跳页用的就是它），删除本文件的 <script> 即恢复原纵向滚动。
   · 页面仍可纵向滚动（main 高度同步为当前页高度），故长页面、回到顶部、
     页内锚点全部照常工作。
   · 切页入口：顶部导航栏（主渠道）、键盘 ←/→、触摸左右滑动、
     浏览器前进后退、URL #hash。
   · 页内不再有左右悬浮箭头，切换一律走导航栏。
   ============================================================ */
(function () {
    'use strict';

    if (window.__PG_SLIDER__) return;
    window.__PG_SLIDER__ = true;

    var mainEl = document.querySelector('main');
    if (!mainEl) return;

    var SECTIONS = Array.prototype.slice.call(mainEl.querySelectorAll(':scope > .page-section'));
    if (SECTIONS.length < 2) return;

    var ORDER = SECTIONS.map(function (s) { return s.id; });
    var TOTAL = ORDER.length;
    var BY_ID = {};
    SECTIONS.forEach(function (s) { BY_ID[s.id] = s; });

    var NAV_LABEL = {};
    var NAV_BY_ID = {};
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
        var id = b.dataset.target;
        if (!id) return;
        NAV_LABEL[id] = (b.textContent || '').trim();
        NAV_BY_ID[id] = b;
    });

    /* 与 css/page-slider.css 的 --pg-anim 保持一致（1.08s + 一点余量） */
    var DURATION = 1100;
    var currentId = null;
    var animating = false;
    var animTimer = null;
    var scrollMemo = Object.create(null);   /* 各页离开时的滚动位置 */

    /* ------------------------------------------------------------
       过渡层：财大红幕布 + 页码铭牌
    ------------------------------------------------------------ */
    var curtain = document.createElement('div');
    curtain.className = 'pg-curtain';
    curtain.setAttribute('aria-hidden', 'true');
    curtain.innerHTML =
        '<div class="pg-veil"></div>' +
        '<div class="pg-card">' +
            '<span class="pg-card-idx"><b></b><i></i></span>' +
            '<span class="pg-card-sep"></span>' +
            '<span class="pg-card-name"></span>' +
        '</div>';
    document.body.appendChild(curtain);
    var cardIdx   = curtain.querySelector('.pg-card-idx b');
    var cardTotal = curtain.querySelector('.pg-card-idx i');
    var cardName  = curtain.querySelector('.pg-card-name');

    /* ------------------------------------------------------------
       顶部进度条
    ------------------------------------------------------------ */
    var progress = document.createElement('div');
    progress.className = 'pg-progress';
    document.body.appendChild(progress);

    /* ------------------------------------------------------------
       工具
    ------------------------------------------------------------ */
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function labelOf(id) {
        if (NAV_LABEL[id]) return NAV_LABEL[id];
        var h = BY_ID[id] && BY_ID[id].querySelector('h1');
        return h ? (h.textContent || '').trim() : id;
    }

    function hashId() {
        var h = (location.hash || '').replace(/^#/, '');
        return BY_ID[h] ? h : null;
    }

    function setScroll(y) {
        var root = document.documentElement;
        var prev = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        window.scrollTo(0, y);
        root.style.scrollBehavior = prev;
    }

    /* main 的高度 = 当前页高度（绝对定位的其它页不参与布局） */
    function syncHeight() {
        var el = BY_ID[currentId];
        if (!el) return;
        var h = el.offsetHeight;
        mainEl.style.minHeight = h + 'px';
    }

    function syncNav() {
        for (var id in NAV_BY_ID) {
            NAV_BY_ID[id].classList.toggle('is-current', id === currentId);
        }
    }

    function syncProgress() {
        var i = ORDER.indexOf(currentId);
        progress.style.width = ((i + 1) / TOTAL * 100).toFixed(2) + '%';
    }

    function setHash(id, fromHash) {
        if (fromHash) return;
        var t = '#' + id;
        if (location.hash === t) return;
        try { history.pushState({ pg: id }, '', t); }
        catch (e) { location.hash = id; }
    }

    function playCurtain(dir, id) {
        var i = ORDER.indexOf(id);
        cardIdx.textContent = pad2(i + 1);
        cardTotal.textContent = '/ ' + pad2(TOTAL);
        cardName.textContent = labelOf(id);
        curtain.setAttribute('data-dir', dir);
        curtain.classList.remove('play');
        void curtain.offsetWidth;          /* 强制重排以重放动画 */
        curtain.classList.add('play');
    }

    /* ------------------------------------------------------------
       核心：切页
    ------------------------------------------------------------ */
    function go(id, opt) {
        opt = opt || {};
        var nextEl = BY_ID[id];
        if (!nextEl || id === currentId || animating) return false;

        var prevEl = currentId ? BY_ID[currentId] : null;
        var pIdx = ORDER.indexOf(currentId);
        var nIdx = ORDER.indexOf(id);
        var dir = opt.dir || (pIdx >= 0 && nIdx < pIdx ? 'prev' : 'next');

        if (currentId) scrollMemo[currentId] = window.scrollY;
        animating = true;
        document.body.setAttribute('data-pg-dir', dir);
        document.body.classList.add('pg-anim');

        /* 离场页：定住当前视觉状态 → 反向淡出 */
        if (prevEl) {
            prevEl.classList.remove('pg-active');
            prevEl.classList.add('pg-leaving');
            prevEl.style.transition = 'none';
            prevEl.style.transform =
                'translate3d(' + (dir === 'next' ? -7 : 7) + '%,0,0) scale(0.982)';
            prevEl.style.opacity = '0';
        }

        /* 入场页：先摆到起始位置，下一帧回落到 CSS 终态（触发过渡） */
        nextEl.style.transition = 'none';
        nextEl.style.transform =
            'translate3d(' + (dir === 'next' ? 9 : -9) + '%,0,0) scale(0.982)';
        nextEl.style.opacity = '0';
        nextEl.classList.add('pg-active');

        currentId = id;
        setScroll(scrollMemo[id] || 0);

        playCurtain(dir, id);
        syncHeight();
        syncNav();
        syncProgress();
        setHash(id, opt.fromHash);

        /* 强制同步重排：把上面写入的「起始态」提交为已计算样式，
           然后立刻清空内联样式，让 CSS 终态 + transition 接管。
           —— 不用双 requestAnimationFrame：在后台标签页 / 无头环境下
           rAF 会被节流甚至不触发，内联的 translate/scale 便会永久残留，
           表现为「整页向左偏移且缩小、不再居中」。 */
        void nextEl.offsetWidth;

        if (prevEl) {
            prevEl.style.transition = '';
            prevEl.style.transform = '';
            prevEl.style.opacity = '';
        }
        nextEl.style.transition = '';
        nextEl.style.transform = '';
        nextEl.style.opacity = '';
        syncHeight();

        clearTimeout(animTimer);
        animTimer = setTimeout(function () {
            if (prevEl) prevEl.classList.remove('pg-leaving');
            document.body.classList.remove('pg-anim');
            /* 清掉方向标记：避免它残留后继续参与 .page-section 的样式计算 */
            document.body.removeAttribute('data-pg-dir');
            animating = false;
            /* 兜底：绝不让任何页面停在偏移态 */
            nextEl.style.transition = '';
            nextEl.style.transform = '';
            nextEl.style.opacity = '';
            syncHeight();
        }, DURATION);

        return true;
    }

    function next() {
        var i = ORDER.indexOf(currentId);
        if (i < 0 || i >= TOTAL - 1) return false;
        return go(ORDER[i + 1], { dir: 'next' });
    }
    function prev() {
        var i = ORDER.indexOf(currentId);
        if (i <= 0) return false;
        return go(ORDER[i - 1], { dir: 'prev' });
    }

    /* ------------------------------------------------------------
       接管 main.js 的 scrollIntoView（跳页）
    ------------------------------------------------------------ */
    var nativeSIV = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
        if (this.classList && this.classList.contains('page-section') && this.id) {
            go(this.id);
            return;
        }
        return nativeSIV.apply(this, arguments);
    };

    /* ------------------------------------------------------------
       入口：导航点击 / 键盘 / 触摸 / 前进后退
    ------------------------------------------------------------ */
    document.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.nav-item');
        if (!btn || !btn.dataset.target) return;
        if (BY_ID[btn.dataset.target]) {
            /* 保留 main.js 的即时反馈，切换由 go() 负责 */
            setTimeout(syncNav, 0);
        }
    }, true);

    document.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        /* 沉浸星图（全屏）时禁止翻页，否则会切到被隐藏的页面 */
        if (document.body.classList.contains('immersive')) return;
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'ArrowRight') { if (next()) e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { if (prev()) e.preventDefault(); }
        else if (e.key === 'Home') { go(ORDER[0], { dir: 'prev' }); }
        else if (e.key === 'End') { go(ORDER[TOTAL - 1], { dir: 'next' }); }
    });

    /* 触摸左右滑动（避开星图 / 书架等自带交互区） */
    var tX = 0, tY = 0, tT = 0, tOk = false;
    var NO_SWIPE = 'svg, #cgStage, #galaxyStage, .bookshelf-wrap, .book-detail, input, textarea, select';
    mainEl.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { tOk = false; return; }
        var t = e.target;
        tOk = !(t.closest && t.closest(NO_SWIPE));
        tX = e.touches[0].clientX;
        tY = e.touches[0].clientY;
        tT = Date.now();
    }, { passive: true });
    mainEl.addEventListener('touchend', function (e) {
        if (!tOk || !e.changedTouches || !e.changedTouches.length) return;
        if (document.body.classList.contains('immersive')) return;
        var dx = e.changedTouches[0].clientX - tX;
        var dy = e.changedTouches[0].clientY - tY;
        if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
        if (Date.now() - tT > 900) return;
        dx < 0 ? next() : prev();
    }, { passive: true });

    window.addEventListener('popstate', function () {
        var id = hashId();
        if (id && id !== currentId) go(id, { fromHash: true });
    });
    window.addEventListener('hashchange', function () {
        var id = hashId();
        if (id && id !== currentId) go(id, { fromHash: true });
    });

    window.addEventListener('resize', syncHeight);

    if (window.ResizeObserver) {
        var ro = new ResizeObserver(function () { syncHeight(); });
        SECTIONS.forEach(function (s) { ro.observe(s); });
    }
    window.addEventListener('load', function () { setTimeout(syncHeight, 120); });

    /* 沉浸星图：全屏时不做页面级溢出处理 */
    if (window.MutationObserver) {
        new MutationObserver(function () {
            if (document.body.classList.contains('immersive')) syncHeight();
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    /* ------------------------------------------------------------
       初始化
    ------------------------------------------------------------ */
    (function init() {
        var activeNav = document.querySelector('.nav-item.active');
        var startId = hashId() || (activeNav && activeNav.dataset.target) || ORDER[0];
        if (!BY_ID[startId]) startId = ORDER[0];

        document.body.classList.add('pgs');
        currentId = startId;
        BY_ID[startId].classList.add('pg-active');
        SECTIONS.forEach(function (s) {
            if (s.id !== startId) s.classList.remove('pg-active');
        });
        syncHeight();
        syncNav();
        syncProgress();
        requestAnimationFrame(function () {
            syncHeight();
            document.body.classList.add('pg-ready');
        });
        setTimeout(syncHeight, 300);
        setTimeout(syncHeight, 1200);
    })();

    /* 对外 API */
    window.PageSlider = {
        go: go,
        next: next,
        prev: prev,
        sync: syncHeight,
        get currentId() { return currentId; },
        get order() { return ORDER.slice(); }
    };
})();
