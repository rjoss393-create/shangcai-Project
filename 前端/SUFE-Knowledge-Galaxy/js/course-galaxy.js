/* ============================================================
   课程星系（新增2）
   ------------------------------------------------------------
   依赖：d3 v7（本地 js/d3.min.js，缺失时自动补加载 CDN）
   数据：data/courses.json

   功能：
     ① 课程节点按领域扇区 + 层级半径布局（基础课靠内、进阶课靠外）
     ② 先修关系（贝塞尔曲线 + 箭头）
     ③ 宏观 / 中观 / 微观三级缩放层级
     ④ 悬停详情 tooltip，单击聚焦 + 课程卡片（课程图谱 / 推荐书籍 /
        关联论文期刊 / 章节知识点 / 关联知识节点跳转）
     ⑤ 学习路径高亮 + 已学进度保存（登录用户按账号保存）
     ⑥ 「跳转知识星系」联动 GalaxyEngine，游客引导登录
     ⑦ 顶部选项卡按 graph_id 切换「课程知识图谱」——不自己渲染，
        直接调用知识星系的引擎（GalaxyEngine.loadGraph），
        因此画面、样式、六层钻取与知识星系完全一致；
        某门课程暂无数据时显示同风格的「待接入」空态。
   ============================================================ */
(function () {
    'use strict';

    const DATA_URL    = 'data/courses.json';
    const D3_LOCAL    = 'js/d3.min.js';
    const D3_CDNS     = [
        'https://cdn.jsdelivr.net/npm/d3@7',
        'https://unpkg.com/d3@7/dist/d3.min.js',
        'https://cdn.bootcdn.net/ajax/libs/d3/7.9.0/d3.min.js'
    ];

    /* ★ 旧「课程图谱」（课程节点网络）总开关 —— 已下架，恒为 false。
       它对应的选项卡早已删除，但 `#cgSvg` 里那张彩色课程网络**例图**还会在
       「离开再回到本板块」时被放出来（见 restoreKnowledgeHome 的历史行为），
       用户看到的就成了「最老版本例图」。现在：既不取数也不渲染，
       `#cgSvg` 永远是空的，旧舞台 / 卡片 / 工具栏也永远隐藏。
       将来若要接回这套图，把开关打开即可（渲染代码全在，注释见下）。 */
    const LEGACY_NETWORK = false;

    /* 三级缩放阈值（对应 d3.zoom 的 k 值） */
    const ZOOM_BOUNDS   = { macroMax: 0.75, mesoMax: 1.4 };
    const SCALE_DEFAULT = 0.8;
    const SCALE_MIN     = 0.4;
    const SCALE_MAX     = 3.2;
    const ZOOM_LABEL    = {
        macro: '宏观 · 领域层',
        meso:  '中观 · 课程层',
        micro: '微观 · 知识点层'
    };

    /* 布局参数 */
    const TIER_R      = { '1': 235, '2': 290, '3': 345 };  // 层级半径：基础内、进阶外
    const SECTOR_PAD  = 0.16;                              // 扇区两侧留白（弧度）
    const DOMAIN_LBL_R = 380;

    /* 状态 */
    let svg = null, gRoot = null, gLinks = null, gDomains = null, gNodes = null;
    let data = null;
    let courseById = new Map();
    let domainById = new Map();
    let focusedId = null;
    let activePathId = null;
    let pathMode = false;
    let zoomBehavior = null;
    let currentTransform = d3_transition_identity();
    let inited = false;
    let toastTimer = null;

    function d3_transition_identity() { return { k: SCALE_DEFAULT, x: 0, y: 0 }; }

    /* ------------------------------------------------------------
       工具
    ------------------------------------------------------------ */
    function $(id) { return document.getElementById(id); }

    function showToast(msg) {
        const tip = $('cgGuestTip') || $('cgTooltip');
        if (!tip) return;
        tip.textContent = msg;
        tip.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => tip.classList.remove('show'), 3200);
    }

    function loadScript(src) {
        return new Promise(resolve => {
            const s = document.createElement('script');
            s.src = src;
            s.onload  = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    async function ensureD3() {
        if (typeof d3 !== 'undefined') return true;
        if (await loadScript(D3_LOCAL) && typeof d3 !== 'undefined') return true;
        for (const url of D3_CDNS) {
            if (await loadScript(url) && typeof d3 !== 'undefined') return true;
        }
        return false;
    }

    /* 个人学习状态：已学课程集合（登录用户按账号隔离，游客单独一份） */
    function progressKey() {
        let uid = 'guest';
        try {
            if (window.Auth && Auth.isLoggedIn() && Auth.getUser()) uid = Auth.getUser().id;
        } catch (e) { /* ignore */ }
        return 'cg_progress_' + uid;
    }
    function getProgress() {
        try { return JSON.parse(localStorage.getItem(progressKey()) || '{}'); }
        catch (e) { return {}; }
    }
    function setProgress(p) {
        try { localStorage.setItem(progressKey(), JSON.stringify(p)); } catch (e) { /* ignore */ }
    }
    function isDone(courseId) { return !!getProgress()[courseId]; }
    function toggleDone(courseId) {
        const p = getProgress();
        if (p[courseId]) delete p[courseId]; else p[courseId] = Date.now();
        setProgress(p);
        updatePathProgress();
        renderStates();
    }
    /* 已学课程数（登录用户才持久化，游客仅本次有效提示） */
    function isLoggedInUser() {
        try { return !!(window.Auth && Auth.isLoggedIn()); } catch (e) { return false; }
    }

    /* ------------------------------------------------------------
       数据装配
    ------------------------------------------------------------ */
    async function loadData() {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    }

    function prepare(dataRaw) {
        data = dataRaw;
        courseById = new Map(data.courses.map(c => [c.id, c]));
        domainById = new Map(data.domains.map(d => [d.id, d]));

        // 入度（被多少门课列为先修）→ 节点大小
        const indeg = {};
        data.courses.forEach(c => (c.prereq || []).forEach(pid => { indeg[pid] = (indeg[pid] || 0) + 1; }));

        // 领域扇区：均匀切分整圆，扇区内按层级半径 + 均匀角度摆放
        const TWO_PI = Math.PI * 2;
        const sector = TWO_PI / data.domains.length;
        data.domains.forEach((d, di) => {
            const start = -Math.PI / 2 + sector * di;
            d._mid = start + sector / 2;
            const list = data.courses.filter(c => c.domain === d.id);
            const usable = sector - SECTOR_PAD * 2;
            // 同扇区内：先按层级再按名字排序，保证同层聚拢
            list.sort((a, b) => (+a.tier - +b.tier) || a.name.localeCompare(b.name));
            list.forEach((c, i) => {
                const a = start + SECTOR_PAD + usable * ((i + 0.5) / list.length);
                c._angle = a;
                c._r = TIER_R[c.tier] || TIER_R['2'];
                c._x = c._r * Math.cos(a);
                c._y = c._r * Math.sin(a);
                c._indeg = indeg[c.id] || 0;
                c._chapterCount = (c.chapters || []).reduce((s, p) => s + (p.chapters || []).length, 0);
            });
            d._courses = list;
        });
    }

    /* ------------------------------------------------------------
       渲染
    ------------------------------------------------------------ */
    function initSvg() {
        svg = d3.select('#cgSvg');
        svg.selectAll('*').remove();

        const defs = svg.append('defs');
        // 普通箭头 / 路径高亮箭头
        defs.append('marker').attr('id', 'cgArrow').attr('viewBox', '0 0 10 10')
            .attr('refX', 8).attr('refY', 5).attr('markerWidth', 6).attr('markerHeight', 6)
            .attr('orient', 'auto-start-reverse')
            .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', '#c8b48a');
        defs.append('marker').attr('id', 'cgArrowActive').attr('viewBox', '0 0 10 10')
            .attr('refX', 8).attr('refY', 5).attr('markerWidth', 7).attr('markerHeight', 7)
            .attr('orient', 'auto-start-reverse')
            .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', '#e8a020');

        gRoot = svg.append('g').attr('class', 'cg-root');
        gLinks    = gRoot.append('g').attr('class', 'cg-links');
        gDomains  = gRoot.append('g').attr('class', 'cg-domains');
        gNodes    = gRoot.append('g').attr('class', 'cg-nodes');

        /* 先修关系连线（贝塞尔） */
        const edges = [];
        data.courses.forEach(c => (c.prereq || []).forEach(pid => {
            const p = courseById.get(pid);
            if (p) edges.push({ source: p, target: c });
        }));

        gLinks.selectAll('path').data(edges).join('path')
            .attr('class', 'cg-link')
            .attr('marker-end', 'url(#cgArrow)')
            .attr('d', e => {
                const { source: s, target: t } = e;
                const mx = (s._x + t._x) / 2, my = (s._y + t._y) / 2;
                // 中点沿法线方向偏移，形成平滑弧线
                const dx = t._x - s._x, dy = t._y - s._y;
                const len = Math.hypot(dx, dy) || 1;
                const off = len * 0.14;
                return `M ${s._x},${s._y} Q ${mx - dy / len * off},${my + dx / len * off} ${t._x},${t._y}`;
            });

        /* 领域标签 + 中心标识 */
        gDomains.selectAll('text.domain').data(data.domains).join('text')
            .attr('class', 'cg-domain-label')
            .attr('x', d => DOMAIN_LBL_R * Math.cos(d._mid))
            .attr('y', d => DOMAIN_LBL_R * Math.sin(d._mid) + 5)
            .attr('fill', d => d.color)
            .text(d => d.name);

        gDomains.append('text')
            .attr('class', 'cg-center-label')
            .attr('y', 4)
            .text('SUFE 课程星系');

        /* 课程节点 */
        const node = gNodes.selectAll('g').data(data.courses).join('g')
            .attr('class', d => `cg-node tier-${d.tier}${isDone(d.id) ? ' done' : ''}`)
            .attr('transform', d => `translate(${d._x},${d._y})`);

        node.append('circle').attr('class', 'ring')
            .attr('r', d => 13 + Math.min(d._indeg, 5) * 2.2)
            .attr('fill', d => domainById.get(d.domain)?.color)
            .attr('fill-opacity', 0.88)
            .attr('stroke', '#fff');

        node.append('text').attr('class', 'cg-name')
            .attr('dy', d => (13 + Math.min(d._indeg, 5) * 2.2) + 16)
            .text(d => d.name);

        node.append('text').attr('class', 'cg-sub hidden')
            .attr('dy', d => -(13 + Math.min(d._indeg, 5) * 2.2) - 8)
            .text(d => `${data.tiers[d.tier] || ''} · ${d._chapterCount} 章`);

        node
            .on('mouseenter', function (ev, d) { showTooltip(ev, d, this); })
            .on('mousemove', function (ev, d) { moveTooltip(ev); })
            .on('mouseleave', hideTooltip)
            .on('click', (ev, d) => { ev.stopPropagation(); handleCourseClick(d); });

        /* 交互：缩放 + 平移 */
        zoomBehavior = d3.zoom()
            .scaleExtent([SCALE_MIN, SCALE_MAX])
            .on('zoom', ev => {
                currentTransform = ev.transform;
                gRoot.attr('transform', ev.transform);
                updateZoomUI();
                syncLabels();
            });
        svg.call(zoomBehavior)
            .on('dblclick.zoom', null)
            .on('click', () => closeCard());

        // 初始视图：以舞台中心为原点，默认中观缩放
        const rect = svg.node().getBoundingClientRect();
        svg.call(zoomBehavior.transform,
            d3.zoomIdentity.translate(rect.width / 2, rect.height / 2)
                .scale(SCALE_DEFAULT));
    }

    function zoomLevel() {
        const k = currentTransform.k;
        if (k < ZOOM_BOUNDS.macroMax) return 'macro';
        if (k < ZOOM_BOUNDS.mesoMax)  return 'meso';
        return 'micro';
    }

    function updateZoomUI() {
        const pct = $('cgZoomPct'), name = $('cgZoomName');
        if (pct) pct.textContent = Math.round(currentTransform.k * 100) + '%';
        if (name) name.textContent = ZOOM_LABEL[zoomLevel()];
    }

    /** 按缩放层级切换标签显隐（列表驱动，避免每个节点重复判断） */
    let _labelLevel = null;
    function syncLabels() {
        const lvl = zoomLevel();
        if (_labelLevel === lvl) return;
        _labelLevel = lvl;
        if (!gNodes) return;
        gNodes.selectAll('text.cg-name').classed('hidden', lvl === 'macro');
        gNodes.selectAll('text.cg-sub').classed('hidden', lvl !== 'micro');
        gDomains.selectAll('text.domain').classed('hidden', false);
    }

    /* ------------------------------------------------------------
       悬停详情
    ------------------------------------------------------------ */
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g,
            m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    function showTooltip(ev, d) {
        const tip = $('cgTooltip');
        if (!tip) return;
        const pre = (d.prereq || []).map(pid => courseById.get(pid)?.name).filter(Boolean);
        tip.innerHTML =
            `<div class="tt-name">${esc(d.name)}</div>` +
            `<div class="tt-en">${esc(d.en)} · ${esc(domainById.get(d.domain)?.name || '')} · ${esc(data.tiers[d.tier] || '')}</div>` +
            `<div class="tt-desc">${esc(d.desc)}</div>` +
            (pre.length ? `<div class="tt-pre"><b>先修：</b>${esc(pre.join(' → '))}</div>` : '');
        tip.classList.add('show');
        moveTooltip(ev);
    }

    function moveTooltip(ev) {
        const tip = $('cgTooltip');
        if (!tip) return;
        const stage = $('cgStage').getBoundingClientRect();
        let x = ev.clientX - stage.left + 16;
        let y = ev.clientY - stage.top + 16;
        const r = tip.getBoundingClientRect();
        if (x + r.width  > stage.width  - 10) x = x - r.width  - 28;
        if (y + r.height > stage.height - 10) y = y - r.height - 28;
        tip.style.left = Math.max(8, x) + 'px';
        tip.style.top  = Math.max(8, y) + 'px';
    }

    function hideTooltip() {
        const tip = $('cgTooltip');
        if (tip) tip.classList.remove('show');
    }

    /* ------------------------------------------------------------
       单击课程：聚焦 + 课程卡片
    ------------------------------------------------------------ */
    async function handleCourseClick(d) {
        focusedId = d.id;
        // 缩放并居中该节点
        const rect = svg.node().getBoundingClientRect();
        const k = Math.max(currentTransform.k, 1.25);
        svg.transition().duration(600)
            .call(zoomBehavior.transform,
                d3.zoomIdentity.translate(rect.width / 2, rect.height / 2)
                    .scale(k)
                    .translate(-d._x, -d._y));
        openCard(d);
    }

    function openCard(d) {
        renderCard(d);
        $('cgCard').classList.add('show');
        $('cgCard').setAttribute('aria-hidden', 'false');
        $('cgCardMask').classList.add('show');
    }

    function closeCard() {
        $('cgCard')?.classList.remove('show');
        $('cgCard')?.setAttribute('aria-hidden', 'true');
        $('cgCardMask')?.classList.remove('show');
    }

    /* ---------- 卡片：mini 先修图谱 ---------- */
    function miniGraphSvg(d) {
        const pre  = (d.prereq || []).map(id => courseById.get(id)).filter(Boolean);
        const post = data.courses.filter(c => (c.prereq || []).includes(d.id));
        if (!pre.length && !post.length) {
            return `<div class="cg-mini-empty">该课程暂无先修与后续课程关系</div>`;
        }
        const W = 428, H = 150;
        const colX = { pre: 78, cur: W / 2, post: W - 78 };
        const yOf = (i, n) => 30 + (n <= 1 ? (H - 60) / 2 : (H - 60) * i / (n - 1));
        const nodeR = c => 11 + Math.min(c._indeg, 5) * 1.6;
        let s = `<svg class="cg-mini-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
        const link = (a, b, ax, bx, ya, yb) => {
            const mx = (ax + bx) / 2;
            return `<path class="mg-link" d="M ${ax + nodeR(a)},${ya} C ${mx},${ya} ${mx},${yb} ${bx - nodeR(b)},${yb}"/>`;
        };
        pre.forEach((p, i)  => { s += link(p, d, colX.pre,  colX.cur,  yOf(i, pre.length),  H / 2); });
        post.forEach((p, i) => { s += link(d, p, colX.cur,  colX.post, H / 2, yOf(i, post.length)); });
        const gNode = (c, x, y, cur) => {
            const col = domainById.get(c.domain)?.color || '#811C21';
            return `<g class="mg-node${cur ? ' mg-cur' : ''}" data-course="${c.id}">
                <circle cx="${x}" cy="${y}" r="${nodeR(c)}" fill="${cur ? col : '#fff'}"
                        stroke="${col}" stroke-width="2" fill-opacity="${cur ? 1 : .92}"/>
                <text x="${x}" y="${y + nodeR(c) + 13}">${esc(c.name)}</text>
            </g>`;
        };
        s += `<text class="mg-label" x="${colX.pre}"  y="14">先修课程</text>`;
        s += `<text class="mg-label" x="${colX.cur}"  y="14">当前课程</text>`;
        s += `<text class="mg-label" x="${colX.post}" y="14">后续课程</text>`;
        pre.forEach((p, i)  => s += gNode(p, colX.pre,  yOf(i, pre.length),  false));
        post.forEach((p, i) => s += gNode(p, colX.post, yOf(i, post.length), false));
        s += gNode(d, colX.cur, H / 2, true);
        s += `</svg>`;
        return s;
    }

    /* ---------- 卡片：章节知识点树 ---------- */
    function chaptersHtml(d) {
        if (!d.chapters?.length) return `<div class="cg-mini-empty">章节内容待补充</div>`;
        let h = `<div class="cg-chapters">`;
        d.chapters.forEach(part => {
            h += `<div class="cg-chapter-part">▾ ${esc(part.part)}</div>`;
            (part.chapters || []).forEach(ch => {
                h += `<div class="cg-chapter">${esc(ch.name)}</div>`;
                (ch.sections || []).forEach(sec => {
                    h += `<div class="cg-section-line">${esc(sec.name)}</div>`;
                    if (sec.points?.length) {
                        h += `<div class="cg-points">` +
                            sec.points.map(p => `<em>${esc(p)}</em>`).join('') + `</div>`;
                    }
                });
            });
        });
        return h + `</div>`;
    }

    /* ---------- 卡片：主体 ---------- */
    function renderCard(d) {
        const dom = domainById.get(d.domain);
        const body = $('cgCardBody');
        const done = isDone(d.id);
        body.innerHTML = `
            <div class="cg-head-badge">
                <span class="cg-badge" style="background:${dom?.color || '#811C21'}">${esc(dom?.name || '')}</span>
                <span class="cg-badge tier">${esc(data.tiers[d.tier] || '')}</span>
                ${done ? '<span class="cg-badge tier" style="color:#4A6B3A !important">✓ 已学</span>' : ''}
            </div>
            <h2 class="cg-course-name">${esc(d.name)}</h2>
            <div class="cg-course-en">${esc(d.en)}</div>
            <p class="cg-course-desc">${esc(d.desc)}</p>

            <div class="cg-sec">课程图谱 · 先修关系</div>
            ${miniGraphSvg(d)}

            <div class="cg-sec">推荐书籍</div>
            <div class="cg-book-box">
                <div class="cg-book-icon">📖</div>
                <div>
                    <div class="cg-book-title">${esc(d.book?.title || '')}</div>
                    <div class="cg-book-author">${esc(d.book?.author || '')}</div>
                    <div class="cg-book-en">${esc(d.book?.en || '')}</div>
                </div>
            </div>

            <div class="cg-sec">关联论文 · 三大期刊</div>
            ${(d.papers || []).length ? d.papers.map(p => `
                <div class="cg-paper">
                    <div class="cg-paper-head">
                        <span class="cg-journal-badge ${esc(p.journal)}">${esc(p.journal)}</span>
                        <span class="cg-paper-year">${esc(p.year)}</span>
                    </div>
                    <div class="cg-paper-title">${esc(p.title)}</div>
                    <div class="cg-paper-authors">${esc(p.authors)}</div>
                </div>`).join('')
                : '<div class="cg-mini-empty">基础课程暂无关联论文</div>'}

            <div class="cg-sec">章节 · 节 · 知识点</div>
            ${chaptersHtml(d)}

            <div class="cg-sec">关联知识节点 · 跳转知识星系</div>
            <div class="cg-concepts">
                ${(d.concepts || []).map(id => {
                    const name = knowledgeName(id);
                    return `<button class="cg-concept-chip" data-kp="${esc(id)}">
                        <span>${esc(name)}</span><span class="chip-arrow">⇢</span></button>`;
                }).join('')}
            </div>
            <div class="cg-concept-tip">点击概念按钮，将打开知识星系并定位到对应概念节点（需登录）。</div>

            <div class="cg-actions">
                <button class="cg-action-btn ${done ? 'is-done' : ''}" id="cgToggleDone">
                    ${done ? '✓ 已标记完成（点击撤销）' : '标记此课程为已学'}
                </button>
                <button class="cg-action-btn primary" id="cgCloseCardBtn">关闭卡片</button>
            </div>
        `;

        body.querySelectorAll('.mg-node').forEach(el => {
            el.addEventListener('click', () => {
                const c = courseById.get(el.dataset.course);
                if (c) { closeCard(); handleCourseClick(c); }
            });
        });
        body.querySelectorAll('.cg-concept-chip').forEach(el => {
            el.addEventListener('click', () => jumpToKnowledge(el.dataset.kp));
        });
        $('cgToggleDone')?.addEventListener('click', () => {
            toggleDone(d.id);
            renderCard(d);
            if (!isLoggedInUser()) showToast('游客模式：已学记录仅本次浏览有效，登录后可长期保存');
        });
        $('cgCloseCardBtn')?.addEventListener('click', closeCard);
    }

    /* 关联知识节点名称：优先从已加载的知识星系里取，取不到用缓存表 */
    const KP_NAMES = {
        kp_macro_001: '金融学',        kp_macro_002: '国际金融',
        kp_macro_003: '商业银行经营管理', kp_macro_004: '金融风险管理',
        kp_macro_005: '投资学',        kp_macro_006: '公司金融',
        kp_macro_007: '投资组合管理',   kp_macro_008: '资产定价',
        kp_macro_009: '固定收益证券',   kp_macro_010: '金融衍生工具',
        kp_macro_011: '量化投资',      kp_macro_012: '行为金融学',
        kp_macro_013: '金融市场学',    kp_macro_014: '保险学',
        kp_macro_015: '证券投资学',    kp_macro_016: '投资银行学',
        kp_macro_017: '公司治理',      kp_macro_018: '私募股权投资',
        kp_macro_019: '房地产投资',    kp_macro_020: '基金管理',
        kp_macro_021: '财富管理',      kp_macro_022: '资产配置',
        kp_macro_023: '金融工程学',    kp_macro_024: '金融科技',
        kp_macro_025: '金融计量学',    kp_macro_026: '时间序列分析',
        kp_macro_027: '机器学习',      kp_macro_028: '证券法'
    };
    function knowledgeName(id) {
        const eng = window.GalaxyEngine;
        const node = eng?.state?.nodes?.find(n => n.id === id);
        return node?.label || KP_NAMES[id] || id;
    }

    /* ------------------------------------------------------------
       跳转知识星系（场景4流程5）
    ------------------------------------------------------------ */
    function gotoGalaxyNav() {
        const btn = document.querySelector('.nav-item[data-target="galaxy"]');
        if (btn) btn.click();
        else document.getElementById('galaxy')?.scrollIntoView({ behavior: 'smooth' });
    }

    function jumpToKnowledge(kpId) {
        // ① 登录校验：知识星系板块对游客有登录守卫
        let logged = false;
        try { logged = !!(window.Auth && Auth.isLoggedIn()); } catch (e) { /* ignore */ }
        if (!logged) {
            showToast('查看知识星系需要登录，正在为你打开登录页…');
            setTimeout(() => {
                try { window.Auth?.openAuthPage?.('login'); }
                catch (e) { gotoGalaxyNav(); }
            }, 600);
            return;
        }

        // ② 若知识图谱舞台正嵌入本板块，先归还并恢复总图
        restoreKnowledgeHome();

        // ③ 切到知识星系页面
        gotoGalaxyNav();

        // ④ 联动 GalaxyEngine：确保统一知识星系（v12）已就绪后再聚焦概念节点
        const eng = window.GalaxyEngine;
        if (!eng) { showToast('知识星系引擎未就绪，请稍后重试'); return; }

        const tryFocus = (retries) => {
            if (eng.state.nodes?.some(n => n.id === kpId)) {
                eng.clickNode(kpId);
                return;
            }
            if (retries <= 0) { showToast('未找到对应概念节点'); return; }
            setTimeout(() => tryFocus(retries - 1), 400);
        };

        const ready = (typeof eng.loadGraph === 'function')
            ? eng.loadGraph('v12')
            : Promise.resolve(eng.switchGraph('econ'));
        Promise.resolve(ready).then(() => tryFocus(10));
    }

    /* ------------------------------------------------------------
       学习路径
    ------------------------------------------------------------ */
    function renderPathButtons() {
        const box = $('cgPaths');
        if (!box || !data) return;
        box.querySelectorAll('.cg-path-btn').forEach(b => b.remove());
        data.learningPaths.forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'cg-path-btn';
            btn.dataset.pathId = p.id;
            btn.addEventListener('click', () => togglePath(p.id));
            box.appendChild(btn);
        });
        updatePathProgress();
    }

    function updatePathProgress() {
        document.querySelectorAll('.cg-path-btn').forEach(btn => {
            const p = data?.learningPaths.find(x => x.id === btn.dataset.pathId);
            if (!p) return;
            const doneN = p.courses.filter(isDone).length;
            btn.innerHTML = esc(p.name) +
                `<span class="cg-path-progress">${doneN}/${p.courses.length}</span>`;
            btn.classList.toggle('active', pathMode && activePathId === p.id);
        });
    }

    function togglePath(pathId) {
        if (pathMode && activePathId === pathId) {
            pathMode = false;
            activePathId = null;
        } else {
            pathMode = true;
            activePathId = pathId;
            closeCard();
        }
        updatePathProgress();
        renderStates();
    }

    /** 路径高亮 / 淡化 + 已学状态 */
    function renderStates() {
        if (!gNodes) return;
        let pathSet = null;
        let onPathEdges = null;
        if (pathMode && activePathId) {
            const p = data.learningPaths.find(x => x.id === activePathId);
            pathSet = new Set(p.courses);
            onPathEdges = new Set();
            for (let i = 1; i < p.courses.length; i++) {
                onPathEdges.add(p.courses[i - 1] + '|' + p.courses[i]);
            }
        }

        gNodes.selectAll('g.cg-node')
            .classed('dimmed', d => !!pathSet && !pathSet.has(d.id))
            .classed('done', d => isDone(d.id));

        gLinks.selectAll('path').classed('dimmed', e =>
                !!onPathEdges && !onPathEdges.has(e.source.id + '|' + e.target.id))
            .classed('path-active', e => {
                const on = onPathEdges && onPathEdges.has(e.source.id + '|' + e.target.id);
                return !!on;
            })
            .attr('marker-end', function (e) {
                const on = onPathEdges && onPathEdges.has(e.source.id + '|' + e.target.id);
                return on ? 'url(#cgArrowActive)' : 'url(#cgArrow)';
            });
    }

    /* ------------------------------------------------------------
       课程知识图谱切换（承接原知识星系的多图切换功能）
       知识星系现仅保留总图；公司金融等课程图谱在此切换查看。
       实现：把知识星系的 .galaxy-page 渲染引擎整体移植到本板块，
       切回课程图谱或跳转知识星系时自动归还并恢复总图。
    ------------------------------------------------------------ */
    /* 进入「课程知识图谱」时要藏起来的东西：课程网络图相关 UI。
       （.cg-intro 与 .cg-tabs 保留，它们对知识图谱同样适用）
       原「课程图谱」（课程节点网络）选项卡已从界面上移除，但下面的
       网络图逻辑与 DOM 一并保留，随时可以接回来。 */
    const K_ELEM_SELECTORS = '#course-galaxy .cg-toolbar, #course-galaxy .cg-stage, #course-galaxy .cg-card-mask, #course-galaxy .cg-card';
    let kMode = false;          // 是否处于知识图谱嵌入模式
    let kGraphId = null;
    let galaxyPageEl = null;    // 知识星系渲染容器（含舞台/按钮/时间轴）
    let galaxyHomeEl = null;    // 其原始父节点
    let kHostEl = null;         // 课程星系内的固定嵌入容器

    function setCourseElemsVisible(visible) {
        document.querySelectorAll(K_ELEM_SELECTORS).forEach(el => {
            el.style.display = visible ? '' : 'none';
        });
    }

    /* 旧课程网络 UI 永远隐藏（选项卡下架后它只能是「例图」）：
       进入 / 离开知识图谱模式都一样，杜绝任何露出机会。 */
    function keepLegacyHidden() {
        document.querySelectorAll(K_ELEM_SELECTORS).forEach(el => {
            el.style.display = 'none';
        });
    }

    /**
     * 以 #cgTabs 为锚点执行 DOM 变更，并在变更后补偿滚动位移，
     * 避免大块内容显隐/搬移导致视口"随机跳转"。
     */
    function withScrollAnchor(mutate) {
        const anchor = document.getElementById('cgTabs') ||
                       document.getElementById('course-galaxy');
        if (!anchor) { mutate(); return; }
        const before = anchor.getBoundingClientRect().top;
        const prevBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        mutate();
        const diff = anchor.getBoundingClientRect().top - before;
        if (Math.abs(diff) > 1) window.scrollBy(0, diff);
        document.documentElement.style.scrollBehavior = prevBehavior;
    }

    function initKnowledgeTabs() {
        const box = $('cgTabs');
        if (!box) return;
        galaxyPageEl = document.querySelector('.galaxy-page[data-galaxy-page-content="main"]');
        if (galaxyPageEl) galaxyHomeEl = galaxyPageEl.parentElement;
        kHostEl = document.getElementById('cgKnowledgeHost');

        box.querySelectorAll('.cg-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                /* 课程图谱（课程节点网络）：选项卡已从界面移除，这里保留原能力 */
                if (tab.dataset.mode === 'courses') {
                    box.querySelectorAll('.cg-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    restoreKnowledgeHome();
                    return;
                }
                const gid = tab.dataset.graphId;
                if (!gid) return;
                box.querySelectorAll('.cg-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                enterKnowledge(gid);
            });
        });

        // 用户点导航前往知识星系 → 先把舞台送回家并恢复统一图谱
        const navBtn = document.querySelector('.nav-item[data-target="galaxy"]');
        if (navBtn) navBtn.addEventListener('click', restoreKnowledgeHome);

        activateDefaultCourseTab();
    }

    /* 当前选中的课程选项卡（默认取标了 active 的那个，否则取第一个） */
    function currentCourseTab() {
        return document.querySelector('#cgTabs .cg-tab.active[data-graph-id]')
            || document.querySelector('#cgTabs .cg-tab[data-graph-id]');
    }

    /* 板块每次成为前台，都要确保处在「课程知识图谱」模式：
       等「课程星系」真的被切到前台再加载，避免首页一进来就多拉 2MB 图谱。
       ★ observer 必须**常驻**：以前它跑一次就 disconnect，于是
         「先去知识星系（restoreKnowledgeHome 把 kMode 置 false）再回来」
         没人重新进图谱模式，板块就落回旧课程网络那张例图。 */
    function activateDefaultCourseTab() {
        const sec = document.getElementById('course-galaxy');
        if (!sec) return;
        const isFront = () => !document.body.classList.contains('pgs')
            || sec.classList.contains('pg-active');
        const activate = () => {
            if (!isFront() || kMode) return;
            keepLegacyHidden();
            const def = currentCourseTab();
            if (def) enterKnowledge(def.dataset.graphId);
        };
        if (window.MutationObserver) {
            new MutationObserver(activate).observe(sec, { attributes: true, attributeFilter: ['class'] });
        }
        if (isFront()) activate();
    }

    /* 「待接入」空态：某门课程还没有图谱数据时，占住图谱位置而不是显示别的图 */
    function showKgEmpty(show, gid) {
        const el = document.getElementById('cgKgEmpty');
        if (!el) return;
        if (show) {
            const reg = (window.GalaxyEngine && window.GalaxyEngine.graphRegistry) || {};
            const info = reg[gid] || {};
            const title = document.getElementById('cgKgEmptyTitle');
            if (title) title.textContent = info.label || gid;
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    function enterKnowledge(gid) {
        const eng = window.GalaxyEngine;
        if (!eng) { showToast('知识图谱引擎未就绪，请稍后重试'); return; }
        if (!galaxyPageEl) { showToast('未找到知识图谱容器'); return; }

        if (!kMode) {
            closeCard();
            withScrollAnchor(() => {
                setCourseElemsVisible(false);
                if (kHostEl) { kHostEl.appendChild(galaxyPageEl); kHostEl.hidden = false; }
                else document.getElementById('course-galaxy').appendChild(galaxyPageEl);
            });
            kMode = true;
        }
        kGraphId = gid;

        /* 与知识星系同一套逻辑：按 graph_id 让引擎换图（course-galaxy 不自己渲染） */
        const p = (typeof eng.loadGraph === 'function')
            ? eng.loadGraph(gid)
            : Promise.resolve(eng.switchGraph(gid));

        Promise.resolve(p).then(() => {
            if (kGraphId !== gid) return;
            /* 引擎只画「最后被要的那张图」：若这次请求已被更新的请求取代，
               保持现状即可（别把别人的图谱挡掉，也别误报「待接入」）。 */
            if (eng.state && eng.state.graphId !== gid) return;
            galaxyPageEl.style.display = '';
            showKgEmpty(false);
            /* 这张图可能本来就在画布上（点了空课程再点回来）：引擎走的是
               「已在画布」快路径，这里再兜一次底，确保遮罩不会留下 */
            if (eng.setLoading) eng.setLoading(false);
        }).catch(err => {
            if (kGraphId !== gid) return;
            /* 该课程暂无数据：藏起星图舞台，显示同风格的「待接入」空态 */
            galaxyPageEl.style.display = 'none';
            showKgEmpty(true, gid);
            /* ★ 关掉引擎的加载遮罩：否则那句「星图数据加载失败」会被留在画布里，
               下次切回有数据的课程时看起来就像「这门课也没有数据」 */
            if (eng.setLoading) eng.setLoading(false);
            console.warn('[course-galaxy] 课程图谱不可用：', gid, err && err.message);
        });
    }

    function restoreKnowledgeHome() {
        if (!kMode) return;
        kMode = false;
        kGraphId = null;
        withScrollAnchor(() => {
            if (galaxyHomeEl && galaxyPageEl && galaxyPageEl.parentElement !== galaxyHomeEl) {
                galaxyHomeEl.appendChild(galaxyPageEl);
            }
            if (galaxyPageEl) galaxyPageEl.style.display = '';
            showKgEmpty(false);
            if (kHostEl) kHostEl.hidden = true;
            /* ★ 这里过去是 setCourseElemsVisible(true) —— 正是它把旧课程网络
               那张例图重新放了出来；选项卡已下架，旧 UI 永久隐藏。 */
            keepLegacyHidden();
        });
        /* 把画布换回统一知识星系（v12） */
        const eng = window.GalaxyEngine;
        if (eng && eng.state && eng.state.graphId !== 'v12') {
            const p = (typeof eng.loadGraph === 'function')
                ? eng.loadGraph('v12')
                : Promise.resolve(eng.switchGraph('econ'));
            Promise.resolve(p).catch(() => {});
        }
    }

    /* ------------------------------------------------------------
       入口
    ------------------------------------------------------------ */
    async function init() {
        if (inited) return;
        const stage = $('cgStage');
        if (!stage) return;
        inited = true;

        const ok = await ensureD3();
        if (!ok) { showToast('图谱引擎加载失败（d3 无法访问）'); return; }

        if (!LEGACY_NETWORK) {
            /* 旧课程网络（那张彩色例图）已下架：不取 courses.json、不渲染，
               `#cgSvg` 永远空白，旧舞台 / 卡片 / 工具栏全部隐藏。
               板块里只保留「课程知识图谱」（选项卡 → GalaxyEngine），
               因此这一步不需要等 d3（知识星系的 d3 由 index.html 自带）。 */
            keepLegacyHidden();
            initKnowledgeTabs();
            return;
        }

        try {
            prepare(await loadData());
        } catch (e) {
            console.warn('[course-galaxy] 课程数据加载失败：', e);
            showToast('课程数据加载失败，请检查 data/courses.json');
            /* 课程知识图谱不依赖 courses.json，照样接上选项卡 */
            initKnowledgeTabs();
            return;
        }

        $('cgLoading')?.classList.remove('show');
        initSvg();
        renderPathButtons();
        syncLabels();
        updateZoomUI();

        $('cgCardMask')?.addEventListener('click', closeCard);
        $('cgCardClose')?.addEventListener('click', closeCard);
        $('cgReset')?.addEventListener('click', () => {
            closeCard();
            pathMode = false; activePathId = null;
            updatePathProgress(); renderStates();
            const rect = svg.node().getBoundingClientRect();
            svg.transition().duration(650)
                .call(zoomBehavior.transform,
                    d3.zoomIdentity.translate(rect.width / 2, rect.height / 2)
                        .scale(SCALE_DEFAULT));
        });

        window.addEventListener('resize', () => {
            if (!svg) return;
            // d3.zoom 自适应，仅需重设中心（保持当前缩放）
        });

        /* 登录状态变化 → 已学进度切换账号视图 */
        try {
            window.Auth?.onChange?.(() => { renderStates(); updatePathProgress(); });
        } catch (e) { /* ignore */ }

        initKnowledgeTabs();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* 对外暴露（调试 / 其他板块联动） */
    window.CourseGalaxy = {
        openCourse: id => {
            const c = courseById.get(id);
            if (c && svg) handleCourseClick(c);
        },
        jumpToKnowledge
    };
})();
