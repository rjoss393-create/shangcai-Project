/* ============================================================
   知识星系 · 分层轨道星图引擎 (v6 数据)
   ------------------------------------------------------------
   设计核心：
   ① 分层钻取代替一锅粥的力导向图 ——
      星系总览(3域·28学科) → 学科星域(10主题环绕) → 主题星团(知识点)
      每层同屏节点 ≤ 30 个，标签永不重叠
   ② 跨领域关系「委婉呈现」——
      总览层：学科间知识边聚合为绕外侧的渐变弧线（默认极淡）
      下层  ：跨域关联收进「星门」——放在视野边缘的门户节点，
              点击即跳转，线不横穿画面
   ③ 数据契约：galaxy_v6_clustered.json
      层级树用 parent_id (domain→macro→meso→micro→explanation)
      知识边 6 种关系：前置/应用/影响/度量/映射/包含(不渲染)
   ④ 兼容：window.GalaxyEngine 对外接口与旧引擎一致
      (selectNode/pulseNodes/focusOnNodes/switchGraph/state)
      知识助手联动不受影响
   ============================================================ */
(function () {
    'use strict';

    /* --------------------------------------------------------
       数据来源（2026-09-21 改为走后端，见 文档/记录/v6图谱接入后端记录.md）
       - GRAPH_ID：后端 controller/graph_ids.py 里登记的统一知识星系图谱
       - API_BASE：与页面同源；若页面不是由后端托管，写成 'http://localhost:8000'
       - 原值 'data/galaxy_v6_clustered.json' 不再使用（避免前端/后端两份数据不同步）
    -------------------------------------------------------- */
    const GRAPH_ID = 'v6';
    const API_BASE = '';
    const DATA_URL = 'data/galaxy_v6_clustered.json';   /* 保留作参考，已不再使用 */

    const DOMAINS = ['宏观金融', '微观金融', '交叉学科'];
    const DOM_VAR = { '宏观金融': '--kg-dom-1', '微观金融': '--kg-dom-2', '交叉学科': '--kg-dom-3' };
    const DOM_EN  = { '宏观金融': 'MACRO FINANCE', '微观金融': 'MICRO FINANCE', '交叉学科': 'INTERDISCIPLINARY' };

    const KNOW_RELS = ['前置', '应用', '影响', '度量', '映射'];
    const REL_DASH   = { '前置': null, '应用': null, '影响': '8 5', '度量': '2 6', '映射': '4 3' };
    const REL_ARROW  = { '前置': 'end', '应用': null, '影响': null, '度量': null, '映射': 'both' };
    const REL_NOTE   = { '前置': '学后先学前', '应用': '前者用于后者', '影响': '前者变动引起后者变动', '度量': '前者量化后者', '映射': '同一概念的不同表述' };

    const VIEW_LABEL = { overview: '星系总览', macro: '学科星域', meso: '主题星团' };
    const VIEW_ORDER = ['overview', 'macro', 'meso'];

    /* --------------------------------------------------------
       状态
    -------------------------------------------------------- */
    const state = {
        loaded: false,
        data: null,
        idx: null,

        view: 'overview',         // overview | macro | meso
        macroId: null,
        mesoId: null,

        viewMode: 'invest',       // invest 投资学视图 | extend 扩展视图
        relOn: new Set(KNOW_RELS),
        crossLinks: true,
        theme: 'light',

        sessionId: null,
        currentGraphId: 'econ',   /* 兼容旧引擎契约（课程星系移植时读写） */
        /* ★ 知识助手提问用的 graph_id（assistant.js 读 state.graphId）。
           画布显示的永远是后端的 v6 图谱，所以这里固定 'v6'，
           不要写成 currentGraphId 的别名 —— course-galaxy.js 跳转时会 switchGraph(...) 改写它。 */
        graphId: 'v6',

        /* 相机 */
        tx: 0, ty: 0, scale: 1
    };

    /* 兼容旧引擎的 state.nodes：course-galaxy.js 用它按 id 找节点 */
    Object.defineProperty(state, 'nodes', {
        get() { return (state.data && state.data.nodes) || []; },
        enumerable: true, configurable: true
    });

    /* --------------------------------------------------------
       DOM
    -------------------------------------------------------- */
    let root, stage, svg, starsCanvas;
    let gView, gSector, gOrbit, gEdges, gGateLines, gNodes, gGates, defs;
    let zoomBehavior;
    let W = 800, H = 640;

    let tooltipEl, detailEl, detailBody, breadcrumbEl, levelBadgeEl;
    let searchInput, searchDrop;

    /* --------------------------------------------------------
       工具
    -------------------------------------------------------- */
    const TAU = Math.PI * 2;
    const deg = d => d * Math.PI / 180;
    function polar(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    function fmtAngle(a) { return (a * 180 / Math.PI + 360) % 360; }

    let PALETTE = {};
    function refreshPalette() {
        const cs = getComputedStyle(root);
        PALETTE = {
            ink:      cs.getPropertyValue('--kg-ink').trim(),
            inkDim:   cs.getPropertyValue('--kg-ink-dim').trim(),
            edge:     cs.getPropertyValue('--kg-edge').trim(),
            gate:     cs.getPropertyValue('--kg-gate').trim(),
            dom1:     cs.getPropertyValue('--kg-dom-1').trim(),
            dom2:     cs.getPropertyValue('--kg-dom-2').trim(),
            dom3:     cs.getPropertyValue('--kg-dom-3').trim()
        };
        PALETTE['宏观金融'] = PALETTE.dom1;
        PALETTE['微观金融'] = PALETTE.dom2;
        PALETTE['交叉学科'] = PALETTE.dom3;
    }

    function domColor(domain) { return PALETTE[domain] || PALETTE.dom1; }

    /* --------------------------------------------------------
       数据加载与索引
    -------------------------------------------------------- */
    function buildIndex(data) {
        const byId = new Map();
        data.nodes.forEach(n => byId.set(n.id, n));

        const domains = [], macros = [], mesos = [], micros = [], explanations = [];
        byId.forEach(n => {
            if (n.level === 'domain') domains.push(n);
            else if (n.level === 'macro') macros.push(n);
            else if (n.level === 'meso') mesos.push(n);
            else if (n.level === 'micro') micros.push(n);
            else if (n.level === 'explanation') explanations.push(n);
        });

        /* 层级树（parent_id） */
        const childrenOf = new Map();          // id -> [child nodes]
        const macroOfMeso = new Map();         // mesoId -> macroId
        const mesoOfMicro = new Map();         // microId -> mesoId
        const macroOfMicro = new Map();
        micros.forEach(m => {
            const meso = byId.get(m.parent_id);
            if (meso && meso.level === 'meso') {
                mesoOfMicro.set(m.id, meso.id);
                const mac = byId.get(meso.parent_id);
                if (mac && mac.level === 'macro') macroOfMicro.set(m.id, mac.id);
            }
        });
        mesos.forEach(m => {
            const mac = byId.get(m.parent_id);
            if (mac && mac.level === 'macro') macroOfMeso.set(m.id, mac.id);
        });
        macros.forEach(mac => {
            const dom = byId.get(mac.parent_id);
            mac._domain = (dom && dom.level === 'domain') ? dom.name : (mac.domain || '交叉学科');
        });
        /* 宏观金融域下的学科按数据修正（mac.domain 字段兜底） */
        macros.forEach(mac => {
            if (!DOMAINS.includes(mac._domain)) mac._domain = mac.domain || '交叉学科';
        });

        mesos.forEach(ms => {
            const arr = childrenOf.get(ms.parent_id) || [];
            arr.push(ms); childrenOf.set(ms.parent_id, arr);
        });
        micros.forEach(mi => {
            const arr = childrenOf.get(mi.parent_id) || [];
            arr.push(mi); childrenOf.set(mi.parent_id, arr);
        });

        /* L5 解释 */
        const explByMicro = new Map();
        explanations.forEach(e => {
            if (e.parent_id) explByMicro.set(e.parent_id, e.content || '');
        });

        /* 知识边（非包含） */
        const knowEdges = [];
        (data.edges || []).forEach(e => {
            if (e.relation === '包含') return;
            const s = byId.get(e.source), t = byId.get(e.target);
            if (!s || !t) return;
            if (s.level !== 'micro' || t.level !== 'micro') return;
            knowEdges.push(e);
        });

        /* micro 邻接 */
        const adjByMicro = new Map();
        knowEdges.forEach(e => {
            if (!adjByMicro.has(e.source)) adjByMicro.set(e.source, []);
            if (!adjByMicro.has(e.target)) adjByMicro.set(e.target, []);
            adjByMicro.get(e.source).push({ edge: e, other: e.target, dir: 'out' });
            adjByMicro.get(e.target).push({ edge: e, other: e.source, dir: 'in' });
        });

        /* 聚合：macro ↔ macro */
        const macroAgg = new Map();   // "a|b"(有序化) -> {a,b,count,rels}
        const mesoAgg = new Map();
        knowEdges.forEach(e => {
            if (e.relation === '包含') return;
            const ms = mesoOfMicro.get(e.source), mt = mesoOfMicro.get(e.target);
            if (!ms || !mt || ms === mt) return;
            const key1 = ms < mt ? ms + '|' + mt : mt + '|' + ms;
            let rec = mesoAgg.get(key1);
            if (!rec) { rec = { a: ms < mt ? ms : mt, b: ms < mt ? mt : ms, count: 0 }; mesoAgg.set(key1, rec); }
            rec.count++;

            const ma = macroOfMeso.get(ms), mb = macroOfMeso.get(mt);
            if (!ma || !mb || ma === mb) return;
            const key2 = ma < mb ? ma + '|' + mb : mb + '|' + ma;
            let rec2 = macroAgg.get(key2);
            if (!rec2) { rec2 = { a: ma < mb ? ma : mb, b: ma < mb ? mb : ma, count: 0 }; macroAgg.set(key2, rec2); }
            rec2.count++;
        });

        /* 学科关联邻居 */
        const macroRel = new Map();
        macroAgg.forEach(rec => {
            if (!macroRel.has(rec.a)) macroRel.set(rec.a, []);
            if (!macroRel.has(rec.b)) macroRel.set(rec.b, []);
            macroRel.get(rec.a).push({ other: rec.b, count: rec.count });
            macroRel.get(rec.b).push({ other: rec.a, count: rec.count });
        });

        /* meso 外部关联（跳星门用） */
        const mesoRel = new Map();
        knowEdges.forEach(e => {
            if (e.relation === '包含') return;
            const ms = mesoOfMicro.get(e.source), mt = mesoOfMicro.get(e.target);
            if (!ms || !mt || ms === mt) return;
            if (!mesoRel.has(ms)) mesoRel.set(ms, []);
            if (!mesoRel.has(mt)) mesoRel.set(mt, []);
            mesoRel.get(ms).push({ other: mt, count: 1, edge: e });
            mesoRel.get(mt).push({ other: ms, count: 1, edge: e });
        });

        /* 总览方位（保持星门空间一致性） */
        const overviewPos = layoutOverviewPositions(macros);

        /* 统计 */
        const bridgeEdges = knowEdges.filter(e => e.is_bridge === true).length;
        const externalMicros = micros.filter(m => m.is_external === true).length;

        return {
            byId, domains, macros, mesos, micros, childrenOf,
            macroOfMeso, mesoOfMicro, macroOfMicro,
            explByMicro, knowEdges, adjByMicro,
            macroAgg, mesoAgg, macroRel, mesoRel,
            overviewPos,
            stats: {
                nodes: data.nodes.length,
                edges: data.edges.length,
                knowEdges: knowEdges.length,
                clusters: new Set(micros.map(m => m.cluster_id)).size,
                bridgeEdges, externalMicros
            }
        };
    }

    /* 总览布局：3 扇区 + 28 学科（双环交错，全局交错避免域边界撞环），
       供各层引用方位 */
    function layoutOverviewPositions(macros) {
        const total = macros.length;
        const pos = new Map();
        let a0 = deg(-90);
        let ringToggle = 0;
        DOMAINS.forEach(dom => {
            const list = macros.filter(m => m._domain === dom);
            const sweep = (list.length / total) * TAU;
            list.forEach((m, i) => {
                const a = a0 + ((i + 0.5) / list.length) * sweep;
                pos.set(m.id, { angle: a, ring: ringToggle++ % 2, count: list.length, sweep, idx: i });
            });
            a0 += sweep;
        });
        return pos;
    }

    /* --------------------------------------------------------
       初始化
    -------------------------------------------------------- */
    function init() {
        root = document.getElementById('kgRoot');
        if (!root) return;
        stage = document.getElementById('galaxyStage');
        svg = d3.select(document.getElementById('galaxySvg'));
        starsCanvas = document.getElementById('kgStars');
        tooltipEl = document.getElementById('kgTooltip');
        detailEl = document.getElementById('kgDetail');
        detailBody = document.getElementById('kgDetailBody');
        breadcrumbEl = document.getElementById('kgBreadcrumb');
        levelBadgeEl = document.getElementById('kgLevelSteps');
        searchInput = document.getElementById('kgSearchInput');
        searchDrop = document.getElementById('kgSearchDrop');

        /* SVG 分层（最外层 gView 承接相机缩放/平移变换） */
        defs = svg.append('defs');
        gView = svg.append('g').attr('class', 'kg-layer-view');
        gSector = gView.append('g').attr('class', 'kg-layer-sector');
        gOrbit = gView.append('g').attr('class', 'kg-layer-orbit');
        gEdges = gView.append('g').attr('class', 'kg-layer-edges');
        gGateLines = gView.append('g').attr('class', 'kg-layer-gatelines');
        gNodes = gView.append('g').attr('class', 'kg-layer-nodes');
        gGates = gView.append('g').attr('class', 'kg-layer-gates');

        /* 缩放平移：直接变换 gView（世界坐标 → 屏幕坐标） */
        zoomBehavior = d3.zoom()
            .scaleExtent([0.45, 2.8])
            .on('zoom', ev => {
                const t = ev.transform;
                state.tx = t.x; state.ty = t.y; state.scale = t.k;
                gView.attr('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
            });
        svg.call(zoomBehavior).on('dblclick.zoom', null);

        /* 背景双击回上一层 */
        svg.on('dblclick', () => { goUp(); });

        /* 尺寸 */
        measure();
        window.addEventListener('resize', debounce(() => {
            measure(); seedStars();
            if (navigator.webdriver) drawStarsFrame(1.2);
            if (state.loaded) render(false);
        }, 220));
        /* 舞台被课程星系移植 / 容器尺寸变化时自动重排 */
        if (window.ResizeObserver) {
            new ResizeObserver(debounce(() => {
                if (!state.loaded || !stage.isConnected) return;
                const rect = stage.getBoundingClientRect();
                if (Math.abs(rect.width - W) > 2 || Math.abs(rect.height - H) > 2) {
                    measure(); seedStars();
                    render(false);
                }
            }, 200)).observe(stage);
        }

        /* 主题 */
        applyTheme(state.theme);

        /* 星空 */
        startStars();

        bindUI();
        load();
    }

    function measure() {
        const rect = stage.getBoundingClientRect();
        W = Math.max(360, rect.width);
        H = Math.max(420, rect.height);
        svg.attr('width', W).attr('height', H);
        sizeStars();
    }

    function debounce(fn, ms) {
        let t = null;
        return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }

    /* --------------------------------------------------------
       数据载入
    -------------------------------------------------------- */
    let loadPromise = null;
    function load() {
        if (loadPromise) return loadPromise;
        const loadingEl = document.getElementById('galaxyLoading');
        loadPromise = fetch(API_BASE + '/api/graph/load', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ graph_id: GRAPH_ID })
            })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(resp => {
                if (!resp || resp.code !== 0) throw new Error((resp && resp.message) || '接口返回异常');
                const d = resp.data || {};
                /* 后端契约 {id,label,page,layer,media,extra} -> v6 引擎原字段名。
                   v6 的原始字段（level/parent_id/content/cluster_id/domain/tags/…）
                   由后端原样保留在 extra 里，这里一行即可还原。 */
                const data = {
                    nodes: (d.nodes || []).map(n =>
                        Object.assign({}, n.extra || {}, { id: n.id, name: n.label })),
                    edges: (d.edges || []).map(e =>
                        Object.assign({}, e.extra || {}, {
                            source: e.source, target: e.target, relation: e.relation
                        }))
                };
                state.data = data;
                state.idx = buildIndex(data);
                state.loaded = true;
                measure();          /* 布局稳定后再测一次，避免早期尺寸偏差 */
                seedStars();
                if (navigator.webdriver) drawStarsFrame(1.2);
                if (loadingEl) loadingEl.classList.add('hide');
                buildSearchIndex();
                renderSidebar();
                render(false);
                applyDeepLink();
            })
            .catch(err => {
                if (loadingEl) loadingEl.textContent = '星图数据加载失败：' + err.message;
                console.error('[知识星系] 数据加载失败', err);
            });
        return loadPromise;
    }

    /* --------------------------------------------------------
       星空背景
       （自动化/无头环境下画一帧静态，避免虚拟时钟被 rAF 烧尽）
    -------------------------------------------------------- */
    let starCtx = null, starList = [], DPR = Math.min(window.devicePixelRatio || 1, 2);
    function sizeStars() {
        if (!starsCanvas) return;
        starsCanvas.width = W * DPR;
        starsCanvas.height = H * DPR;
        starCtx = starsCanvas.getContext('2d');
        starCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    function seedStars() {
        starList = [];
        let s = 42;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const n = Math.round(W * H / 6500);
        for (let i = 0; i < n; i++) {
            starList.push({
                x: rnd() * W, y: rnd() * H,
                r: 0.4 + rnd() * 1.1,
                base: 0.12 + rnd() * 0.30,
                ph: rnd() * TAU,
                sp: 0.4 + rnd() * 0.8
            });
        }
    }
    function drawStarsFrame(t) {
        if (!starCtx) return;
        starCtx.clearRect(0, 0, W, H);
        const dark = root && root.dataset.theme === 'dark';
        const col = dark ? '190,205,255' : '120,112,96';
        for (const st of starList) {
            const a = st.base * (0.75 + 0.25 * Math.sin(t * st.sp + st.ph));
            starCtx.beginPath();
            starCtx.fillStyle = `rgba(${col},${a.toFixed(3)})`;
            starCtx.arc(st.x, st.y, st.r, 0, TAU);
            starCtx.fill();
        }
    }
    function startStars() {
        seedStars();
        /* 自动化环境：静态一帧即可 */
        if (navigator.webdriver) { drawStarsFrame(1.2); return; }
        const t0 = performance.now();
        function frame(t) {
            if (!document.hidden) drawStarsFrame((t - t0) / 1000);
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    /* --------------------------------------------------------
       主题
    -------------------------------------------------------- */
    function applyTheme(theme) {
        state.theme = theme;
        root.dataset.theme = theme;
        refreshPalette();
        const btn = document.getElementById('kgThemeBtn');
        if (btn) btn.querySelector('span:last-child').textContent = theme === 'light' ? '深空模式' : '浅色星图';
        if (state.loaded) render(false);
    }

    /* --------------------------------------------------------
       UI 绑定
    -------------------------------------------------------- */
    function bindUI() {
        document.getElementById('kgThemeBtn').addEventListener('click', () => {
            applyTheme(state.theme === 'light' ? 'dark' : 'light');
        });
        document.getElementById('kgResetBtn').addEventListener('click', () => resetCamera());

        /* 视图模式 */
        document.querySelectorAll('.kg-vm-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === state.viewMode) return;
                state.viewMode = mode;
                document.querySelectorAll('.kg-vm-btn').forEach(b => b.classList.toggle('is-on', b === btn));
                if (state.loaded) render(false);
            });
        });

        /* 关系筛选 */
        document.querySelectorAll('.kg-rel-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const rel = chip.dataset.rel;
                if (state.relOn.has(rel)) state.relOn.delete(rel); else state.relOn.add(rel);
                chip.classList.toggle('is-on', state.relOn.has(rel));
                if (state.loaded) render(false);
            });
        });

        /* 跨域航线 */
        const crossBtn = document.getElementById('kgCrossBtn');
        if (crossBtn) crossBtn.addEventListener('click', () => {
            state.crossLinks = !state.crossLinks;
            crossBtn.classList.toggle('is-on', state.crossLinks);
            if (state.loaded && state.view === 'overview') render(false);
        });

        /* 详情面板关闭 */
        document.getElementById('kgDetailClose').addEventListener('click', hideDetail);

        /* 搜索 */
        searchInput.addEventListener('input', debounce(onSearchInput, 140));
        searchInput.addEventListener('focus', onSearchInput);
        document.addEventListener('click', e => {
            if (!searchDrop.contains(e.target) && e.target !== searchInput) searchDrop.classList.remove('show');
        });

        /* Esc 关闭详情 */
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') hideDetail();
        });

        /* 滚轮在星图区域内缩放（阻止页面跟着滚） */
        svg.on('wheel', ev => { ev.preventDefault(); }, { passive: false });
    }

    function resetCamera() {
        state.tx = 0; state.ty = 0; state.scale = 1;
        svg.transition().duration(600)
            .call(zoomBehavior.transform, d3.zoomIdentity);
    }

    /* --------------------------------------------------------
       深链接：?kgview=macro&kgid=kp_macro_005（可分享指定视图）
       深链接直达时跳过入场动画，保证打开即完整呈现
    -------------------------------------------------------- */
    function applyDeepLink() {
        try {
            const q = new URLSearchParams(location.search);
            const view = q.get('kgview');
            const id = q.get('kgid');
            const theme = q.get('kgtheme');
            if (theme === 'dark' || theme === 'light') {
                root.dataset.theme = theme;
                state.theme = theme;
                refreshPalette();
                const btn = document.getElementById('kgThemeBtn');
                if (btn) btn.querySelector('span:last-child').textContent =
                    theme === 'light' ? '深空模式' : '浅色星图';
            }
            if (!view || !id) return;
            state.deepLink = true;
            if (view === 'macro') enterMacro(id);
            else if (view === 'meso') enterMeso(id);
            else if (view === 'micro') jumpToMicro(id);
            state.deepLink = false;
        } catch (e) { /* 忽略非法参数 */ }
    }

    /* --------------------------------------------------------
       侧栏（学科目录）
    -------------------------------------------------------- */
    function renderSidebar() {
        const box = document.getElementById('kgSidebar');
        if (!box) return;
        const idx = state.idx;
        let html = '<div class="kg-side-head">学科目录 · DICTIONARY</div>';
        DOMAINS.forEach(dom => {
            const list = idx.macros.filter(m => m._domain === dom);
            const microCnt = list.reduce((s, m) => {
                let c = 0;
                (idx.childrenOf.get(m.id) || []).forEach(ms => { c += (idx.childrenOf.get(ms.id) || []).length; });
                return s + c;
            }, 0);
            html += `<div class="kg-side-group">
                <div class="kg-side-group-title">
                    <span class="dot" style="background:${domColor(dom)}"></span>
                    ${dom}<span class="cnt">${list.length} 学科</span>
                </div>`;
            list.forEach(m => {
                let c = 0;
                (idx.childrenOf.get(m.id) || []).forEach(ms => { c += (idx.childrenOf.get(ms.id) || []).length; });
                html += `<button class="kg-side-item" data-macro="${m.id}">
                    ${m.name}<span class="micro-cnt">${c} 点</span></button>`;
            });
            html += `</div>`;
        });
        const st = idx.stats;
        html += `<div class="kg-side-stat">
            <b>${st.nodes}</b> 节点 · <b>${st.knowEdges}</b> 知识关联<br>
            <b>${st.clusters}</b> 知识簇 · <b>${st.externalMicros}</b> 跨学科延伸<br>
            <b>${idx.macros.length}</b> 学科 · <b>${idx.mesos.length}</b> 主题
        </div>`;
        box.innerHTML = html;
        box.querySelectorAll('.kg-side-item').forEach(btn => {
            btn.addEventListener('click', () => enterMacro(btn.dataset.macro));
        });
    }

    function syncSidebar() {
        document.querySelectorAll('.kg-side-item').forEach(btn => {
            btn.classList.toggle('is-active',
                (state.view === 'macro' && btn.dataset.macro === state.macroId) ||
                (state.view === 'meso' && state.idx.macroOfMeso.get(state.mesoId) === btn.dataset.macro));
        });
    }

    /* --------------------------------------------------------
       面包屑 / 层级徽标
    -------------------------------------------------------- */
    function renderBreadcrumb() {
        const idx = state.idx;
        const parts = [];
        parts.push(`<button class="kg-crumb is-home" data-act="home">◉ 星系总览</button>`);
        if (state.view === 'macro' || state.view === 'meso') {
            const mac = idx.byId.get(state.macroId);
            if (mac) {
                parts.push(`<span class="kg-crumb-sep">›</span>`);
                parts.push(`<button class="kg-crumb" data-act="domain" style="color:${domColor(mac._domain)}">${mac._domain}</button>`);
                if (state.view === 'macro') {
                    parts.push(`<span class="kg-crumb-sep">›</span><span class="kg-crumb is-current">${mac.name}</span>`);
                } else {
                    parts.push(`<span class="kg-crumb-sep">›</span>`);
                    parts.push(`<button class="kg-crumb" data-act="macro">${mac.name}</button>`);
                    const ms = idx.byId.get(state.mesoId);
                    parts.push(`<span class="kg-crumb-sep">›</span><span class="kg-crumb is-current">${ms ? ms.name : ''}</span>`);
                }
            }
        }
        breadcrumbEl.innerHTML = parts.join('');
        breadcrumbEl.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                if (act === 'home') goOverview();
                else if (act === 'domain') goOverview();
                else if (act === 'macro') enterMacro(state.macroId);
            });
        });
        /* 层级徽标 */
        if (levelBadgeEl) {
            const cur = VIEW_ORDER.indexOf(state.view);
            levelBadgeEl.querySelectorAll('.lb-step').forEach((d, i) => {
                d.classList.toggle('is-on', i <= cur);
            });
            const nameEl = document.getElementById('kgLevelName');
            if (nameEl) nameEl.textContent = VIEW_LABEL[state.view];
        }
    }

    /* --------------------------------------------------------
       视图渲染主入口
    -------------------------------------------------------- */
    function render(animate) {
        if (!state.loaded) return;
        defs.selectAll('*').remove();
        renderBreadcrumb();
        syncSidebar();
        if (state.view === 'overview') renderOverview(animate);
        else if (state.view === 'macro') renderMacroView(animate);
        else if (state.view === 'meso') renderMesoView(animate);
    }

    function clearLayers() {
        gSector.selectAll('*').remove();
        gOrbit.selectAll('*').remove();
        gEdges.selectAll('*').remove();
        gGateLines.selectAll('*').remove();
        gNodes.selectAll('*').remove();
        gGates.selectAll('*').remove();
    }

    /* 节点/星门入场渐现（d3 transition 走主线程，虚拟时钟可控） */
    function fadeNode(sel, animate, delay) {
        if (animate === false || state.deepLink) { sel.style('opacity', 1); return; }
        sel.style('opacity', 0)
           .transition().duration(450).delay(delay || 0)
           .style('opacity', 1);
    }

    /* ========================================================
       视图一：星系总览
       3 大领域扇区 + 28 学科双环 + 聚合弧线（跨域绕外）
    ======================================================== */
    function renderOverview(animate) {
        clearLayers();
        const idx = state.idx;
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;                  // 基准半径
        const R_IN = u * 0.30, R_OUT = u * 0.965;
        const R2A = u * 0.62, R2B = u * 0.80;
        const pos = idx.overviewPos;

        /* --- 扇区底色 + 领域标签 --- */
        let a0 = deg(-90);
        const domSectors = [];
        DOMAINS.forEach(dom => {
            const list = idx.macros.filter(m => m._domain === dom);
            const sweep = (list.length / idx.macros.length) * TAU;
            const color = domColor(dom);

            /* 环形扇面 */
            const p1 = polar(cx, cy, R_OUT, a0), p2 = polar(cx, cy, R_OUT, a0 + sweep);
            const p3 = polar(cx, cy, R_IN, a0 + sweep), p4 = polar(cx, cy, R_IN, a0);
            const large = sweep > Math.PI ? 1 : 0;
            const dPath = `M${p1[0]},${p1[1]} A${R_OUT},${R_OUT} 0 ${large} 1 ${p2[0]},${p2[1]}
                L${p3[0]},${p3[1]} A${R_IN},${R_IN} 0 ${large} 0 ${p4[0]},${p4[1]} Z`;
            gSector.append('path').attr('class', 'kg-sector')
                .attr('d', dPath).attr('fill', color).attr('opacity', 0.05);

            domSectors.push({ dom, color, mid: a0 + sweep / 2 });
            a0 += sweep;
        });

        /* 领域名：放扇区外缘；在中线 ±18° 内自动滑到外环节点标签的空当，
           配合小字号 + 底色光晕，避免大标题压住学科节点标签 */
        const outerAngles = [];
        idx.macros.forEach(m => {
            const p = pos.get(m.id);
            if (p && p.ring === 1) outerAngles.push(fmtAngle(p.angle));
        });
        function labelClearance(aDeg) {
            let best = 360;
            outerAngles.forEach(n => {
                let d = Math.abs(aDeg - n) % 360;
                if (d > 180) d = 360 - d;
                if (d < best) best = d;
            });
            return best;
        }
        const domLabels = domSectors.slice().sort((a, b) => fmtAngle(a.mid) - fmtAngle(b.mid));
        const domMinGap = deg(30);
        let prevMid = null;
        domLabels.forEach(s => {
            let bestA = fmtAngle(s.mid), bestC = -1;
            for (let off = -18; off <= 18; off += 3) {
                const aD = fmtAngle(s.mid + off * Math.PI / 180);
                const c = labelClearance(aD);
                if (c > bestC) { bestC = c; bestA = aD; }
            }
            s._angle = bestA * Math.PI / 180;
            if (prevMid != null) {
                let dA = fmtAngle(s._angle) - fmtAngle(prevMid);
                if (dA < 0) dA += 360;
                if (dA < 30) s._angle = (fmtAngle(prevMid) + 30) * Math.PI / 180;
            }
            prevMid = s._angle;
        });

        domLabels.forEach(s => {
            const lp = polar(cx, cy, R_OUT + 5, s._angle);
            gSector.append('text').attr('class', 'kg-domain-label')
                .attr('x', lp[0]).attr('y', lp[1] - 3)
                .attr('text-anchor', 'middle').attr('fill', s.color)
                .text(s.dom);
            gSector.append('text').attr('class', 'kg-domain-sublabel')
                .attr('x', lp[0]).attr('y', lp[1] + 13)
                .attr('text-anchor', 'middle')
                .text(DOM_EN[s.dom] || '');
        });

        /* --- 轨道参考圈 --- */
        [R2A, R2B].forEach(R => {
            gOrbit.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R)
                .attr('fill', 'none')
                .attr('stroke', 'var(--kg-orbit)')
                .attr('stroke-dasharray', '1 7')
                .attr('stroke-width', 1);
        });

        /* --- 聚合边 --- */
        const gradDefs = defs.append('g');
        const edgesG = gEdges.append('g');
        idx.macroAgg.forEach(rec => {
            if (!state.relOn.size) return;
            const ma = idx.byId.get(rec.a), mb = idx.byId.get(rec.b);
            if (!ma || !mb) return;
            const pa = pos.get(rec.a), pb = pos.get(rec.b);
            if (!pa || !pb) return;
            const isCross = ma._domain !== mb._domain;
            if (isCross && !state.crossLinks) return;

            const A = polar(cx, cy, pa.ring ? R2B : R2A, pa.angle);
            const B = polar(cx, cy, pb.ring ? R2B : R2A, pb.angle);

            /* 控制点：同域内凹，跨域外绕（低弧、贴中圈，避免穿越外缘标签） */
            let CR;
            if (isCross) {
                let dAng = Math.abs(fmtAngle(pa.angle) - fmtAngle(pb.angle));
                if (dAng > 180) dAng = 360 - dAng;
                CR = Math.min(u * (0.90 + dAng / 180 * 0.08), u * 1.0);
            } else {
                CR = R_IN + (R2A - R_IN) * 0.30;
            }
            const midA = (pa.angle + pb.angle) / 2;
            const C = polar(cx, cy, CR, midA);

            const w = Math.min(1 + Math.log2(1 + rec.count) * 0.85, 3.4) * (isCross ? 0.72 : 1);
            const op = isCross ? 0.20 : 0.42;   /* 默认若隐若现，hover 才亮起 */

            let stroke;
            if (isCross) {
                const gid = 'kgx-' + rec.a.replace(/[^a-z0-9]/gi, '') + rec.b.replace(/[^a-z0-9]/gi, '');
                const g = gradDefs.append('linearGradient').attr('id', gid)
                    .attr('gradientUnits', 'userSpaceOnUse')
                    .attr('x1', A[0]).attr('y1', A[1]).attr('x2', B[0]).attr('y2', B[1]);
                g.append('stop').attr('offset', '0%').attr('stop-color', domColor(ma._domain));
                g.append('stop').attr('offset', '100%').attr('stop-color', domColor(mb._domain));
                stroke = 'url(#' + gid + ')';
            } else {
                stroke = 'var(--kg-edge)';
            }

            edgesG.append('path')
                .attr('class', 'kg-edge' + (isCross ? ' kg-cross' : ''))
                .attr('d', `M${A[0]},${A[1]} Q${C[0]},${C[1]} ${B[0]},${B[1]}`)
                .attr('stroke', stroke)
                .attr('stroke-width', w)
                .attr('opacity', op)
                .attr('data-a', rec.a).attr('data-b', rec.b);
        });

        /* --- 中心恒星 --- */
        const core = gNodes.append('g').attr('class', 'kg-node kg-core');
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.145)
            .attr('fill', 'none').attr('stroke', 'var(--kg-accent)').attr('stroke-width', 1).attr('opacity', 0.35);
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.105)
            .attr('fill', 'none').attr('stroke', 'var(--kg-accent)').attr('stroke-width', 1.5).attr('opacity', 0.55);
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.062)
            .attr('fill', 'var(--kg-accent)').attr('opacity', 0.92);
        core.append('text').attr('class', 'kg-core-label')
            .attr('x', cx).attr('y', cy + u * 0.062 + 24).attr('text-anchor', 'middle')
            .text('投资学知识星系');

        /* --- 学科节点 --- */
        const nodeG = gNodes.append('g');
        idx.macros.forEach((m, i) => {
            const p = pos.get(m.id);
            const R = p.ring ? R2B : R2A;
            const [x, y] = polar(cx, cy, R, p.angle);
            /* 大小 = 下辖知识点数 */
            let c = 0;
            (idx.childrenOf.get(m.id) || []).forEach(ms => { c += (idx.childrenOf.get(ms.id) || []).length; });
            const r = 15 + Math.sqrt(c) * 1.35;
            m._r = r; m._x = x; m._y = y;   /* 缓存，供 hover/跳转 */

            const g = nodeG.append('g')
                .attr('class', 'kg-node g-node')
                .attr('data-id', m.id)
                .attr('transform', `translate(${x},${y})`)
                .style('opacity', 0);

            g.append('circle').attr('class', 'kg-halo').attr('r', r + 7)
                .attr('stroke', domColor(m._domain)).attr('stroke-width', 1);
            g.append('circle').attr('class', 'kg-node-body').attr('r', r)
                .attr('fill', domColor(m._domain));

            /* 标签：内环节点朝内放、外环节点朝外放，内外永不打架 */
            const inward = p.ring === 0;   /* 内环 → 标签朝圆心 */
            const cosA = Math.cos(p.angle), sinA = Math.sin(p.angle);
            let lx = 0, ly = 0, anchor = 'middle';
            if (cosA > 0.35) {
                /* 右侧：朝外 anchor=start / 朝内 anchor=end */
                lx = inward ? -(r + 8) : (r + 8);
                anchor = inward ? 'end' : 'start';
                ly = 4;
            } else if (cosA < -0.35) {
                lx = inward ? (r + 8) : -(r + 8);
                anchor = inward ? 'start' : 'end';
                ly = 4;
            } else if (sinA < 0) {
                /* 上方：朝外向上，朝内向下 */
                ly = inward ? (r + 16) : -(r + 10);
                anchor = 'middle'; lx = 0;
            } else {
                ly = inward ? -(r + 10) : (r + 16);
                anchor = 'middle'; lx = 0;
            }
            g.append('text').attr('class', 'kg-node-label')
                .attr('x', lx).attr('y', ly).attr('text-anchor', anchor)
                .text(m.name);
            g.append('text').attr('class', 'kg-node-sublabel')
                .attr('x', lx).attr('y', ly + 13).attr('text-anchor', anchor)
                .text(c + ' 知识点');

            g.on('mouseenter', () => hotMacro(m.id, true))
             .on('mouseleave', () => hotMacro(m.id, false))
             .on('click', () => enterMacro(m.id));

            fadeNode(g, animate, i * 16);
        });

        /* hover 学科：亮起相关边 */
        function hotMacro(id, on) {
            edgesG.selectAll('.kg-edge').each(function () {
                const el = d3.select(this);
                const hit = el.attr('data-a') === id || el.attr('data-b') === id;
                el.classed('is-hot', on && hit);
                el.classed('is-dim', on && !hit);
            });
            nodeG.selectAll('.kg-node').classed('is-dim', on && function () {
                return this.dataset.id !== id;
            });
            /* 邻居高亮由边亮起自然带动 */
        }
    }

    /* ========================================================
       视图二：学科星域
       中央学科恒星 + 10 主题轨道 + 外圈星门
    ======================================================== */
    function renderMacroView(animate) {
        clearLayers();
        const idx = state.idx;
        const mac = idx.byId.get(state.macroId);
        if (!mac) { goOverview(); return; }
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;
        const R_MESO = u * 0.55;
        const R_GATE = u * 0.88;
        const color = domColor(mac._domain);

        /* 中央学科 */
        const core = gNodes.append('g')
            .attr('class', 'kg-node g-node')
            .attr('transform', `translate(${cx},${cy})`);
        core.append('circle').attr('class', 'kg-halo').attr('r', 46).attr('stroke', color).attr('stroke-width', 1.2);
        core.append('circle').attr('class', 'kg-node-body').attr('r', 34).attr('fill', color);
        core.append('text').attr('class', 'kg-core-label')
            .attr('y', 56).attr('text-anchor', 'middle').text(mac.name);
        core.append('text').attr('class', 'kg-node-sublabel')
            .attr('y', 72).attr('text-anchor', 'middle')
            .text(mac._domain + ' · ' + (idx.childrenOf.get(mac.id) || []).length + ' 主题');

        /* 主题轨道圈 */
        gOrbit.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R_MESO)
            .attr('fill', 'none').attr('stroke', 'var(--kg-orbit)')
            .attr('stroke-dasharray', '1 7');

        /* 主题节点 */
        const mesos = idx.childrenOf.get(mac.id) || [];
        const n = mesos.length;
        const nodeG = gNodes.append('g');
        mesos.forEach((ms, i) => {
            const a = deg(-90) + (i / n) * TAU;
            const [x, y] = polar(cx, cy, R_MESO, a);
            const micros = (idx.childrenOf.get(ms.id) || []).filter(visibleMicro);
            const r = 13 + Math.sqrt(micros.length) * 2.4;
            ms._x = x; ms._y = y; ms._r = r;

            const g = nodeG.append('g').attr('class', 'kg-node g-node')
                .attr('data-id', ms.id)
                .attr('transform', `translate(${x},${y})`)
                .style('opacity', 0);
            g.append('circle').attr('class', 'kg-node-body').attr('r', r)
                .attr('fill', color);
            g.append('text').attr('class', 'kg-node-label')
                .attr('y', r + 15).attr('text-anchor', 'middle').text(ms.name);
            g.append('text').attr('class', 'kg-node-sublabel')
                .attr('y', r + 28).attr('text-anchor', 'middle').text(micros.length + ' 知识点');

            g.on('mouseenter', ev => showTip(ev, ms.name,
                `${mac.name} · ${micros.length} 个知识点<br>点击进入主题星团`))
             .on('mousemove', moveTip)
             .on('mouseleave', hideTip)
             .on('click', () => { hideTip(); enterMeso(ms.id); });

            fadeNode(g, animate, 80 + i * 30);
        });

        /* 主题间聚合边（当前学科内部） */
        const edgesG = gEdges.append('g');
        mesoAggForMacro(mac.id).forEach(rec => {
            const A = rec._a, B = rec._b;
            if (!A || !B) return;
            const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
            const dxc = mx - cx, dyc = my - cy;
            const dl = Math.sqrt(dxc * dxc + dyc * dyc) || 1;
            const CR = dl * 0.42;
            const C = [cx + dxc / dl * CR, cy + dyc / dl * CR];
            const w = Math.min(1 + Math.log2(1 + rec.count) * 0.8, 3.6);
            edgesG.append('path').attr('class', 'kg-edge')
                .attr('d', `M${A.x},${A.y} Q${C[0]},${C[1]} ${B.x},${B.y}`)
                .attr('stroke', 'var(--kg-edge)')
                .attr('stroke-width', w)
                .attr('opacity', 0.9);
        });

        /* --- 星门：与本学科有关联的其它学科 --- */
        renderGates({
            cx, cy, R_GATE, u, animate,
            relItems: (idx.macroRel.get(mac.id) || [])
                .slice().sort((a, b) => b.count - a.count).slice(0, 14)
                .map(r => ({
                    key: r.other,
                    id: r.other,
                    count: r.count,
                    kind: 'macro',
                    label: (idx.byId.get(r.other) || {}).name || '未知学科',
                    sub: (idx.byId.get(r.other) || {})._domain || ''
                })),
            centerLabel: mac.name
        });
    }

    /* 当前学科的 meso 聚合边（含位置缓存） */
    function mesoAggForMacro(macId) {
        const idx = state.idx;
        const mesos = idx.childrenOf.get(macId) || [];
        const set = new Set(mesos.map(m => m.id));
        const out = [];
        idx.mesoAgg.forEach(rec => {
            if (!set.has(rec.a) || !set.has(rec.b)) return;
            out.push({
                a: rec.a, b: rec.b, count: rec.count,
                _a: locate(rec.a), _b: locate(rec.b)
            });
        });
        function locate(mesoId) {
            const ms = idx.byId.get(mesoId);
            if (!ms || ms._x == null) return null;
            return { x: ms._x, y: ms._y };
        }
        return out;
    }

    /* ========================================================
       视图三：主题星团
       中央主题 + 知识点环绕 + 关系线型 + 外部星门
    ======================================================== */
    function renderMesoView(animate) {
        clearLayers();
        const idx = state.idx;
        const ms = idx.byId.get(state.mesoId);
        if (!ms) { goOverview(); return; }
        const mac = idx.byId.get(idx.macroOfMeso.get(state.mesoId)) || { name: '', _domain: '交叉学科' };
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;
        const R_MICRO = u * 0.50;
        const R_GATE = u * 0.86;
        const color = domColor(mac._domain);

        /* 中央主题 */
        const core = gNodes.append('g')
            .attr('class', 'kg-node g-node')
            .attr('transform', `translate(${cx},${cy})`);
        core.append('circle').attr('class', 'kg-halo').attr('r', 36).attr('stroke', color).attr('stroke-width', 1.2);
        core.append('circle').attr('class', 'kg-node-body').attr('r', 26).attr('fill', color);
        core.append('text').attr('class', 'kg-core-label')
            .attr('y', 48).attr('text-anchor', 'middle').text(ms.name);
        core.append('text').attr('class', 'kg-node-sublabel')
            .attr('y', 63).attr('text-anchor', 'middle')
            .text(mac.name);

        /* 知识点 */
        const micros = (idx.childrenOf.get(ms.id) || []).filter(visibleMicro);
        const nm = micros.length;
        const nodeG = gNodes.append('g');
        micros.forEach((mi, i) => {
            const a = deg(-90) + (i / nm) * TAU + (nm === 1 ? 0 : 0);
            const [x, y] = polar(cx, cy, R_MICRO, a);
            const r = 15 + (mi.core ? 3.5 : 0) + (Number(mi.importance) || 0) * 9;
            mi._x = x; mi._y = y; mi._r = r;

            const g = nodeG.append('g').attr('class', 'kg-node g-node')
                .attr('data-id', mi.id)
                .attr('transform', `translate(${x},${y})`)
                .style('opacity', 0);

            if (mi.core) {
                g.append('circle').attr('class', 'kg-halo').attr('r', r + 6)
                    .attr('stroke', color).attr('stroke-width', 1);
            }
            g.append('circle').attr('class', 'kg-node-body').attr('r', r)
                .attr('fill', color)
                .style('fill-opacity', mi.is_external ? 0.22 : 1);
            if (mi.is_external) {
                g.append('circle').attr('r', r).attr('fill', 'none')
                    .attr('stroke', color).attr('stroke-width', 1.4).attr('stroke-dasharray', '3 3');
            }
            g.append('text').attr('class', 'kg-node-label')
                .attr('y', r + 16).attr('text-anchor', 'middle')
                .text(mi.name);

            g.on('mouseenter', ev => {
                    const d = idx.explByMicro.get(mi.id) || mi.description || '';
                    const meta = [];
                    if (mi.cluster_name) meta.push('簇 · ' + mi.cluster_name);
                    if (mi.difficulty) meta.push('难度 ' + '●'.repeat(mi.difficulty) + '○'.repeat(5 - mi.difficulty));
                    if (d) meta.push(d.slice(0, 46) + (d.length > 46 ? '…' : ''));
                    showTip(ev, mi.name, meta.join('<br>') || '点击查看详解');
                })
                .on('mousemove', moveTip)
                .on('mouseleave', hideTip)
                .on('click', () => { hideTip(); selectMicro(mi.id); });

            fadeNode(g, animate, 60 + i * 45);
        });

        /* 知识边（团内） */
        const edgesG = gEdges.append('g');
        const idSet = new Set(micros.map(m => m.id));
        const shown = new Set();
        idx.knowEdges.forEach(e => {
            if (!idSet.has(e.source) || !idSet.has(e.target)) return;
            if (!state.relOn.has(e.relation)) return;
            const key = e.source < e.target ? e.source + '|' + e.target + '|' + e.relation : e.target + '|' + e.source + '|' + e.relation;
            if (shown.has(key)) return;
            shown.add(key);
            drawRelEdge(edgesG, e.source, e.target, e.relation, e.relation_note, e);
        });

        function drawRelEdge(g, sid, tid, rel, note, raw) {
            const s = idx.byId.get(sid), t = idx.byId.get(tid);
            if (!s || !t || s._x == null || t._x == null) return;
            const mx = (s._x + t._x) / 2 - cx, my = (s._y + t._y) / 2 - cy;
            const dl = Math.sqrt(mx * mx + my * my) || 1;
            const C = [cx + mx / dl * (dl * 0.86), cy + my / dl * (dl * 0.86)];
            const arrow = REL_ARROW[rel];
            const path = g.append('path')
                .attr('class', 'kg-edge kg-rel-edge g-node')
                .attr('data-rel', rel)
                .attr('data-s', sid).attr('data-t', tid)
                .attr('d', `M${s._x},${s._y} Q${C[0]},${C[1]} ${t._x},${t._y}`)
                .attr('stroke', 'var(--kg-edge)')
                .attr('stroke-width', 1.6)
                .attr('opacity', 0.9);
            if (REL_DASH[rel]) path.attr('stroke-dasharray', REL_DASH[rel]);
            if (arrow === 'end') path.attr('marker-end', 'url(#kg-arr)');
            if (arrow === 'both') { path.attr('marker-end', 'url(#kg-arr)').attr('marker-start', 'url(#kg-arr-r)'); }
            if (note) {
                path.on('mouseenter', ev => showTip(ev, rel + ' · ' + REL_NOTE[rel] || '', note))
                    .on('mousemove', moveTip)
                    .on('mouseleave', hideTip);
            }
        }

        /* 箭头 marker（中性墨色） */
        const mk = defs.append('marker').attr('id', 'kg-arr')
            .attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
            .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto');
        mk.append('path').attr('d', 'M0,1L9,5L0,9z').attr('style', 'fill:var(--kg-ink-dim)');
        const mk2 = defs.append('marker').attr('id', 'kg-arr-r')
            .attr('viewBox', '0 0 10 10').attr('refX', 1).attr('refY', 5)
            .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto-start-reverse');
        mk2.append('path').attr('d', 'M10,1L1,5L10,9z').attr('style', 'fill:var(--kg-ink-dim)');

        /* --- 星门：外部关联的主题 --- */
        const gateMap = new Map();
        (idx.mesoRel.get(ms.id) || []).forEach(r => {
            if (!gateMap.has(r.other)) gateMap.set(r.other, { count: 0, edges: [] });
            const gm = gateMap.get(r.other);
            gm.count += 1; gm.edges.push(r.edge);
        });
        const gateItems = [...gateMap.entries()]
            .map(([mesoId, gm]) => {
                const t = idx.byId.get(mesoId);
                if (!t) return null;
                const tmac = idx.byId.get(idx.macroOfMeso.get(mesoId));
                return {
                    key: mesoId, id: mesoId, kind: 'meso',
                    count: gm.count,
                    edges: gm.edges,
                    label: t.name,
                    sub: tmac ? tmac.name : ''
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.count - a.count)
            .slice(0, 12);

        renderGates({
            cx, cy, R_GATE, u, animate,
            relItems: gateItems,
            centerLabel: ms.name,
            isMeso: true
        });
    }

    /* --------------------------------------------------------
       星门（跨域 / 跨主题的委婉出口）
    -------------------------------------------------------- */
    function renderGates(opt) {
        const { cx, cy, R_GATE, animate, relItems } = opt;
        if (!relItems.length) return;

        /* 门角度 = 目标在总览中的方位（保持空间连续性），
           再做环形最小间距散开，避免同方向文字叠压 */
        relItems.forEach(it => {
            if (it.kind === 'macro') {
                const p = state.idx.overviewPos.get(it.id);
                it._baseA = p ? p.angle : deg(-90) + (relItems.indexOf(it) / relItems.length) * TAU;
            } else {
                const tmacId = state.idx.macroOfMeso.get(it.id);
                const p = tmacId ? state.idx.overviewPos.get(tmacId) : null;
                it._baseA = p ? p.angle : deg(-90) + (relItems.indexOf(it) / relItems.length) * TAU;
            }
        });
        relItems.sort((a, b) => a._baseA - b._baseA);
        const minGap = deg(17);
        let prevA = null;
        relItems.forEach(it => {
            let a = it._baseA + Math.sin(it._baseA * 7.13) * 0.03;
            if (prevA != null && a - prevA < minGap) a = prevA + minGap;
            it._angle = a;
            prevA = a;
        });

        const gG = gGates.append('g');
        relItems.forEach((it, i) => {
            const a = it._angle;
            const [gx, gy] = polar(cx, cy, R_GATE, a);

            const g = gG.append('g').attr('class', 'kg-gate g-node')
                .attr('data-id', it.id)
                .attr('transform', `translate(${gx},${gy})`)
                .style('opacity', 0);

            /* 连线 */
            const dxf = cx - gx, dyf = cy - gy;
            const mx = (gx + cx) / 2, my = (gy + cy) / 2;
            const nx = -dyf, ny = dxf;
            const nl = Math.sqrt(nx * nx + ny * ny) || 1;
            const bow = 26;
            const C = [mx + nx / nl * bow, my + ny / nl * bow];
            g.append('path').attr('class', 'kg-gate-line')
                .attr('d', `M${gx},${gy} Q${C[0]},${C[1]} ${cx},${cy}`)
                .attr('transform', 'translate(0,0)');

            const r = 13 + Math.min(it.count, 12) * 0.55;
            g.append('circle').attr('class', 'kg-gate-body').attr('r', r);
            g.append('text').attr('class', 'kg-gate-label')
                .attr('y', -r - 7).attr('text-anchor', 'middle').text(it.label);
            g.append('text').attr('class', 'kg-gate-cnt')
                .attr('y', r + 13).attr('text-anchor', 'middle')
                .text(it.sub ? it.sub + ' · ' + it.count + ' 条关联' : it.count + ' 条关联');

            g.on('mouseenter', ev => showTip(ev, '⇢ ' + it.label,
                (it.sub ? it.sub + '<br>' : '') + it.count + ' 条知识关联 · 点击前往'))
             .on('mousemove', moveTip)
             .on('mouseleave', hideTip)
             .on('click', () => {
                 hideTip();
                 if (it.kind === 'macro') enterMacro(it.id);
                 else enterMeso(it.id);
             });

            fadeNode(g, animate, 200 + i * 40);
        });
    }

    /* --------------------------------------------------------
       导航
    -------------------------------------------------------- */
    function goOverview() {
        state.view = 'overview';
        state.macroId = null; state.mesoId = null;
        hideDetail();
        render(true);
        resetCamera();
    }
    function enterMacro(id) {
        const idx = state.idx;
        if (!idx.byId.get(id)) return;
        state.view = 'macro';
        state.macroId = id;
        state.mesoId = null;
        hideDetail();
        render(true);
        resetCamera();
    }
    function enterMeso(id) {
        const idx = state.idx;
        if (!idx.byId.get(id)) return;
        state.view = 'meso';
        state.mesoId = id;
        const mac = idx.macroOfMeso.get(id);
        if (mac) state.macroId = mac;
        hideDetail();
        render(true);
        resetCamera();
    }
    function goUp() {
        if (state.view === 'meso') enterMacro(state.macroId);
        else if (state.view === 'macro') goOverview();
    }

    /* 投资学视图下是否可见（延伸节点仅扩展视图显示） */
    function visibleMicro(m) {
        return state.viewMode === 'extend' ? true : m.is_external !== true;
    }

    /* --------------------------------------------------------
       详情面板
    -------------------------------------------------------- */
    function selectMicro(id) {
        const idx = state.idx;
        const mi = idx.byId.get(id);
        if (!mi) return;
        state.selectedMicro = id;
        nodeG_byId(id).selectAll || null;
        showDetail(mi);
        /* 高亮相关节点 */
        pulseMicro(id);
    }

    function nodeG_byId(id) {
        return gNodes.selectAll('.kg-node').filter(function () { return this.dataset.id === id; });
    }

    function pulseMicro(id) {
        gNodes.selectAll('.kg-node').classed('kg-pulse', function () { return this.dataset.id === id; });
        setTimeout(() => {
            gNodes.selectAll('.kg-node').classed('kg-pulse', false);
        }, 2800);
    }

    function showDetail(mi) {
        const idx = state.idx;
        const meso = idx.byId.get(idx.mesoOfMicro.get(mi.id));
        const mac = idx.byId.get(idx.macroOfMicro.get(mi.id));

        /* 头部 */
        document.getElementById('kgDetailTitle').textContent = mi.name;

        /* 路径 */
        const pathEl = document.getElementById('kgDetailPath');
        pathEl.innerHTML = '';
        const crumbs = [];
        if (mac) crumbs.push({ t: mac._domain, act: 'home' });
        if (mac) crumbs.push({ t: mac.name, act: 'macro' });
        if (meso) crumbs.push({ t: meso.name, act: 'meso' });
        crumbs.forEach((c, i) => {
            if (i) pathEl.insertAdjacentHTML('beforeend', '<span class="kg-crumb-sep">›</span>');
            const b = document.createElement('button');
            b.textContent = c.t;
            b.addEventListener('click', () => {
                if (c.act === 'home') goOverview();
                else if (c.act === 'macro') enterMacro(mac.id);
                else if (c.act === 'meso') enterMeso(meso.id);
            });
            pathEl.appendChild(b);
        });

        /* 徽章 */
        const badgeEl = document.getElementById('kgDetailBadges');
        let bh = '';
        if (mi.is_external) bh += `<span class="kg-badge is-external">跨学科延伸 · ${mi.source_discipline || '外延'}</span>`;
        if (mi.core) bh += `<span class="kg-badge is-core">核心知识点</span>`;
        if (mi.cluster_name) bh += `<span class="kg-badge">${mi.cluster_name}</span>`;
        if (mi.difficulty) bh += `<span class="kg-badge kg-diff" title="难度">${'●'.repeat(mi.difficulty)}${'○'.repeat(5 - mi.difficulty)}</span>`;
        badgeEl.innerHTML = bh;

        /* 学科 + 关键词 */
        const kwEl = document.getElementById('kgDetailKw');
        let kh = '';
        (mi.disciplines || []).forEach(d => { kh += `<span class="kg-badge">${d}</span>`; });
        ((mi.tags && mi.tags.keywords) || []).forEach(k => { kh += `<span class="kg-badge">${k}</span>`; });
        kwEl.innerHTML = kh || '<span class="kg-rel-empty">暂无标签</span>';

        /* 解释（L5） */
        const descEl = document.getElementById('kgDetailDesc');
        const content = idx.explByMicro.get(mi.id) || mi.description || '';
        if (content) descEl.textContent = content;
        else {
            descEl.textContent = '详解内容将在「阶段六 · 纵向扩展」中补充。';
            descEl.classList.add('is-empty');
        }
        descEl.classList.toggle('is-empty', !content);

        /* 重要度 */
        const imp = Number(mi.importance) || 0;
        document.getElementById('kgDetailImpBar').style.width = Math.round(imp * 100) + '%';

        /* sub_nodes */
        const sn = mi.sub_nodes || {};
        const snEl = document.getElementById('kgDetailSub');
        const snItems = [
            ['公式', sn.formulas], ['案例', sn.cases], ['人物', sn.people],
            ['历史', sn.history], ['争议', sn.debates]
        ];
        let sh = '';
        snItems.forEach(([label, arr]) => {
            if (arr && arr.length) arr.forEach(v => { sh += `<span class="kg-subnode">${label} · ${escapeHtml(String(v))}</span>`; });
            else sh += `<span class="kg-subnode is-empty">${label} · 待补充</span>`;
        });
        snEl.innerHTML = sh;

        /* 关联知识（前驱/后继） */
        const relEl = document.getElementById('kgDetailRels');
        const adj = idx.adjByMicro.get(mi.id) || [];
        if (!adj.length) {
            relEl.innerHTML = '<div class="kg-rel-empty">暂无直接关联知识点</div>';
        } else {
            const rels = adj
                .filter(a => state.relOn.has(a.edge.relation))
                .sort((a, b) => (b.edge.confidence || 0) - (a.edge.confidence || 0))
                .slice(0, 14);
            if (!rels.length) rels.push(...adj.slice(0, 14));
            relEl.innerHTML = '';
            rels.forEach(a => {
                const other = idx.byId.get(a.other);
                if (!other) return;
                const otherMeso = idx.byId.get(idx.mesoOfMicro.get(other.id));
                const otherMac = idx.byId.get(idx.macroOfMicro.get(other.id));
                const isCross = otherMac && mac && otherMac.id !== mac.id;
                const rel = a.edge.relation;
                const dirLabel = a.dir === 'out' ? '→ 指向' : '← 来自';
                const color = relColor(rel);
                const btn = document.createElement('button');
                btn.className = 'kg-rel-item' + (isCross ? ' is-cross' : '');
                btn.innerHTML = `<span class="kg-rel-tag" style="background:${color}">${rel} ${dirLabel}</span>
                    <span class="kg-rel-name">${escapeHtml(other.name)}</span>
                    <span class="kg-rel-where">${otherMac ? escapeHtml(otherMac.name) : ''}</span>`;
                btn.addEventListener('click', () => jumpToMicro(other.id));
                relEl.appendChild(btn);
            });
        }

        detailEl.classList.add('show');
    }

    function hideDetail() {
        if (detailEl) detailEl.classList.remove('show');
    }

    function relColor(rel) {
        const cs = getComputedStyle(root);
        const v = cs.getPropertyValue('--kg-rel-' + rel).trim();
        return v || '#888';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    /* 跳转到某个知识点（供详情联动 / 搜索 / assistant） */
    function jumpToMicro(id) {
        const idx = state.idx;
        const mi = idx.byId.get(id);
        if (!mi) return false;
        const mesoId = idx.mesoOfMicro.get(id);
        if (!mesoId) return false;
        enterMeso(mesoId);
        setTimeout(() => {
            selectMicro(id);
            focusNodeVisual(id);
        }, 80);
        return true;
    }

    function focusNodeVisual(id) {
        /* 让节点短暂放大提醒 */
        const n = nodeG_byId(id).select('.kg-node-body');
        if (n.empty()) return;
        const r0 = n.attr('r');
        n.transition().duration(220).attr('r', r0 * 1.5)
            .transition().duration(320).attr('r', r0);
    }

    /* --------------------------------------------------------
       tooltip
    -------------------------------------------------------- */
    function showTip(ev, title, meta) {
        tooltipEl.innerHTML = `<div class="tt-name">${escapeHtml(title)}</div>` +
            (meta ? `<div class="tt-meta">${meta}</div>` : '');
        tooltipEl.classList.add('show');
        moveTip(ev);
    }
    function moveTip(ev) {
        const rect = stage.getBoundingClientRect();
        let x = ev.clientX - rect.left + 14;
        let y = ev.clientY - rect.top + 14;
        const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
        if (x + tw > rect.width - 10) x = ev.clientX - rect.left - tw - 12;
        if (y + th > rect.height - 10) y = ev.clientY - rect.top - th - 12;
        tooltipEl.style.left = x + 'px';
        tooltipEl.style.top = y + 'px';
    }
    function hideTip() { tooltipEl.classList.remove('show'); }

    /* 轻提示（自动消失，替代 alert） */
    let toastTimer = null;
    function showKgToast(msg) {
        if (!root) return;
        let el = root.querySelector('.kg-toast');
        if (!el) {
            el = document.createElement('div');
            el.className = 'kg-toast';
            root.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
    }

    /* --------------------------------------------------------
       搜索
    -------------------------------------------------------- */
    function buildSearchIndex() {
        const idx = state.idx;
        state.searchIdx = idx.micros.map(m => {
            const mac = idx.byId.get(idx.macroOfMicro.get(m.id));
            const meso = idx.byId.get(idx.mesoOfMicro.get(m.id));
            return {
                id: m.id, name: m.name,
                kw: ((m.tags && m.tags.keywords) || []).join(' '),
                path: (mac ? mac.name : '') + ' · ' + (meso ? meso.name : ''),
                mac: mac ? mac.name : '',
                raw: m
            };
        });
    }

    function onSearchInput() {
        const q = (searchInput.value || '').trim().toLowerCase();
        if (!q) { searchDrop.classList.remove('show'); return; }
        const hits = state.searchIdx.filter(it =>
            it.name.toLowerCase().includes(q) || it.kw.toLowerCase().includes(q)
        ).slice(0, 12);
        if (!hits.length) {
            searchDrop.innerHTML = '<div class="kg-search-empty">未找到相关知识点</div>';
        } else {
            searchDrop.innerHTML = hits.map(it =>
                `<div class="kg-search-item" data-id="${it.id}">
                    <div class="si-name">${escapeHtml(it.name)}</div>
                    <div class="si-path">${escapeHtml(it.path)}</div>
                </div>`).join('');
            searchDrop.querySelectorAll('.kg-search-item').forEach(el => {
                el.addEventListener('click', () => {
                    searchDrop.classList.remove('show');
                    searchInput.value = '';
                    jumpToMicro(el.dataset.id);
                });
            });
        }
        searchDrop.classList.add('show');
    }

    /* ============================================================
       对外兼容 API（与旧 GalaxyEngine 一致，知识助手照常联动）
    ============================================================ */
    window.GalaxyEngine = {
        init,
        load,
        /* 旧引擎的 clickNode：course-galaxy.js 跳转会按 id 调它。
           按节点层级分流（domain→总览 / macro→星域 / meso→星团 / micro→知识点）。 */
        clickNode(idOrName) {
            const idx = state.idx;
            const n = idx && idx.byId.get(idOrName);
            if (n) {
                if (n.level === 'macro') enterMacro(n.id);
                else if (n.level === 'meso') enterMeso(n.id);
                else if (n.level === 'micro') jumpToMicro(n.id);
                else if (n.level === 'explanation') jumpToMicro(n.parent_id || n.id);
                else goOverview();
                return;
            }
            this.selectNode(idOrName);
        },
        /* 助手概念点击：按 id 或名称定位 */
        selectNode(idOrName) {
            if (!state.loaded) return;
            const idx = state.idx;
            let mi = idx.byId.get(idOrName);
            if (!mi || mi.level !== 'micro') {
                const q = String(idOrName).trim();
                mi = idx.micros.find(m => m.name === q) ||
                     idx.micros.find(m => m.name.includes(q)) || null;
            }
            if (mi) jumpToMicro(mi.id);
        },
        pulseNodes(ids) {
            if (!state.loaded || !ids || !ids.length) return;
            const set = new Set();
            ids.forEach(x => {
                const idx = state.idx;
                let mi = idx.byId.get(x);
                if (!mi || mi.level !== 'micro') {
                    const q = String(x).trim();
                    const f = idx.micros.find(m => m.name === q || m.name.includes(q));
                    if (f) mi = f;
                }
                if (mi) set.add(mi.id);
            });
            gNodes.selectAll('.kg-node').classed('kg-pulse', function () {
                return set.has(this.dataset.id);
            });
            setTimeout(() => {
                gNodes.selectAll('.kg-node').classed('kg-pulse', false);
            }, 3000);
        },
        focusOnNodes(ids, edges) {
            if (!state.loaded || !ids || !ids.length) return;
            const idx = state.idx;
            const microIds = [];
            ids.forEach(x => {
                let mi = idx.byId.get(x);
                if (!mi || mi.level !== 'micro') {
                    const q = String(x).trim();
                    const f = idx.micros.find(m => m.name === q || m.name.includes(q));
                    if (f) mi = f;
                }
                if (mi) microIds.push(mi.id);
            });
            if (!microIds.length) return;
            /* 聚到包含命中最多的主题 */
            const cnt = new Map();
            microIds.forEach(id => {
                const ms = idx.mesoOfMicro.get(id);
                if (ms) cnt.set(ms, (cnt.get(ms) || 0) + 1);
            });
            const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
            enterMeso(best);
            setTimeout(() => {
                const set = new Set(
                    microIds.filter(id => idx.mesoOfMicro.get(id) === best)
                );
                gNodes.selectAll('.kg-node').classed('kg-pulse', function () {
                    return set.has(this.dataset.id);
                });
                setTimeout(() => {
                    gNodes.selectAll('.kg-node').classed('kg-pulse', false);
                }, 3200);
            }, 120);
        },
        switchGraph(gid) {
            /* v6 为统一知识星系：课程图谱由「课程星系」自有引擎负责，
               此处保持接口契约（currentGraphId 状态位），数据不变时静默降级 */
            const id = gid || 'econ';
            if (id === state.currentGraphId) return Promise.resolve(state.loaded);
            state.currentGraphId = id;
            if (state.loaded && id !== 'econ' && id !== 'invest') {
                const name = { corp_fin: '公司金融', intl_inv: '国际投资学', ma: '并购与重组' }[id] || id;
                showKgToast('「' + name + '」课程图谱数据接入中，当前展示统一知识星系');
            }
            return Promise.resolve(state.loaded);
        },
        goMacro: goOverview,
        get state() { return state; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
