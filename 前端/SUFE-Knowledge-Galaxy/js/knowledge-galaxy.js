/* ============================================================
   知识星系 · 分层轨道星图引擎 (v12 数据 · 六层钻取)
   ------------------------------------------------------------
   设计核心：
   ① 六层逐级下潜，每层同屏节点有限、标签按同心环错开，互不重叠 ——
      星系总览(5 领域 · 88 学科)
        → 学科星域(该学科的主题簇)
        → 主题星团(主题下的知识点)
        → 知识节点(该知识点的「名词解释」+ 深层内容总览)
        → 名词解释(释义全文 + 其下子内容)
        → 深层内容(案例/公式/人物/历史/争议 全文)
      ★ 后三层都是「点得进去」的正经层级，不是同屏卫星面板。
   ② 跨领域关系「委婉呈现」——
      总览层：学科间知识边聚合为绕外侧的渐变弧线（默认极淡）
      下层  ：跨域关联收进「星门」——放在视野边缘的门户节点，
              点击即跳转，线不横穿画面
   ③ 数据契约：见下方 DATA_SOURCE 注释块（local 本地 JSON / api 后端接口）
      层级树用 parent_id：
        domain(5) → macro(88) → meso(1119) → micro(10326)
                  → explanation(10326) → detail(9565)
      知识边 6 种关系：前置/应用/影响/度量/映射/包含(不渲染)
   ④ 兼容：window.GalaxyEngine 对外接口与旧引擎一致
      (clickNode/selectNode/pulseNodes/focusOnNodes/switchGraph/goMacro/state)
      知识助手 / 课程星系联动不受影响
   ============================================================ */
(function () {
    'use strict';

    /* --------------------------------------------------------
       ★ 数据源契约（与后端对接的唯一开关，改动时请同步《对接文档》）
       ----------------------------------------------------------
       local —— 读 LOCAL_URL（当前默认，静态页面即可独立运行）
       api   —— POST {API_BASE}/api/graph/load {graph_id: GRAPH_ID}
                后端须在 backend/controller/graph_ids.py 里登记 GRAPH_ID
                接口异常或未登记时自动回退 local，页面不会白屏
       合并到后端只需三步：
         ① 后端把本 JSON 原样存入 data/layered/（与 v6 同目录）
         ② 在 backend/controller/graph_ids.py 里加一行 GRAPH_ID 登记
         ③ 切数据源：优先用 window.__KG_DATA_SOURCE__='api'（不改代码），
            或直接把 DATA_SOURCE_DEFAULT 改成 'api'
       后端若按统一契约 {id,label,type,page,layer,media,extra} 返回，
       由 adaptBackendData() 自动还原（原样 JSON 与统一契约两种形态都吃）；
       extra 里必须保留 level / parent_id 这两个字段名（分层树靠它们）。
       ★ state.graphId 恒等于「画布此刻真正显示的那张图」（v12），
         不是 currentGraphId 的别名，switchGraph() 不会改它。
       -------------------------------------------------------- */
    /* ★ DATA_SOURCE 可以在「不改这一行代码」的情况下被覆盖（合并到后端时最省事）：
         ① 页面上加 <script>window.__KG_DATA_SOURCE__='api'</script>（建议后端模板用这个）
         ② URL 追加 ?kgSrc=api（调试/灰度用，如 …/index.html?kgSrc=api）
         ③ 都没有 → 用下面这行的默认值 'local'（静态页面可独立运行）
       取值 'local' = 读 LOCAL_URL；'api' = POST {API_BASE}/api/graph/load。 */
    const DATA_SOURCE_DEFAULT = 'local';
    const DATA_SOURCE = (function () {
        let forced = null;
        try { forced = window.__KG_DATA_SOURCE__; } catch (e) { /* ignore */ }
        if (!forced) {
            const m = /[?&]kgSrc=(local|api)/.exec(
                (typeof location !== 'undefined' && location.search) || '');
            if (m) forced = m[1];
        }
        return (forced === 'api' || forced === 'local') ? forced : DATA_SOURCE_DEFAULT;
    })();
    const GRAPH_ID    = 'v12';                      /* 后端 controller/graph_ids.py 里登记的新图谱 id */
    let API_BASE      = '';                         /* 与页面同源；跨源时写 'http://localhost:8000' */
    try { if (window.__KG_API_BASE__) API_BASE = window.__KG_API_BASE__; } catch (e) { /* ignore */ }
    const LOCAL_URL   = 'data/galaxy_v12.json';     /* 与后端同源的那份 JSON（api 拉不到时兜底） */

    /* 领域：前 3 个是投资学本体（默认视图），后 2 个是扩展域（扩展视图） */
    const DOMAINS_CORE = ['宏观金融', '微观金融', '交叉学科'];
    const DOM_VAR = {
        '宏观金融': '--kg-dom-1', '微观金融': '--kg-dom-2', '交叉学科': '--kg-dom-3',
        '财经扩展': '--kg-dom-4', '跨学科知识': '--kg-dom-5'
    };
    const DOM_EN = {
        '宏观金融': 'MACRO FINANCE', '微观金融': 'MICRO FINANCE', '交叉学科': 'INTERDISCIPLINARY',
        '财经扩展': 'FINANCE EXPANSION', '跨学科知识': 'CROSS-DISCIPLINE'
    };

    const KNOW_RELS = ['前置', '应用', '影响', '度量', '映射'];
    const REL_DASH   = { '前置': null, '应用': null, '影响': '8 5', '度量': '2 6', '映射': '4 3' };
    const REL_ARROW  = { '前置': 'end', '应用': null, '影响': null, '度量': null, '映射': 'both' };
    const REL_NOTE   = { '前置': '学后先学前', '应用': '前者用于后者', '影响': '前者变动引起后者变动', '度量': '前者量化后者', '映射': '同一概念的不同表述' };

    /* 六层视图（顺序即层级徽标的步进顺序） */
    const VIEW_LABEL = {
        overview: '星系总览', macro: '学科星域', meso: '主题星团',
        micro: '知识节点', explanation: '名词解释', detail: '深层内容'
    };
    const VIEW_ORDER = ['overview', 'macro', 'meso', 'micro', 'explanation', 'detail'];

    /* 深层内容类型（detail.detail_type → 图形元数据）
       ★ 颜色契约：六种内容类型各有专属色（css --kg-dt-*），
         与五个领域色完全错开 —— 全站任何层看到同类型节点都是同一个颜色，
         进入对应层后中央主节点也沿用该色 + 同款字形（见 drawContentCore）。 */
    const DT_META = {
        explanation: { label: '释义', glyph: '释', colorVar: '--kg-dt-expl' },
        formula:     { label: '公式', glyph: 'ƒ', colorVar: '--kg-dt-formula' },
        case:        { label: '案例', glyph: '▶', colorVar: '--kg-dt-case' },
        person:      { label: '人物', glyph: '人', colorVar: '--kg-dt-person' },
        history:     { label: '历史', glyph: '史', colorVar: '--kg-dt-history' },
        debate:      { label: '争议', glyph: '辩', colorVar: '--kg-dt-debate' }
    };
    const DT_ORDER = ['explanation', 'formula', 'case', 'person', 'history', 'debate'];
    function dtColor(kind, domainColor) {
        const m = DT_META[kind];
        return (m && m.colorVar) ? 'var(' + m.colorVar + ')' : (domainColor || 'var(--kg-accent)');
    }
    /* 一个知识点下最多展示的深层内容节点（超出部分收进面板列表） */
    const DT_MAX_ON_STAGE = 12;

    /* 同心环半径（相对基准半径 u），环数按同屏节点数自适应 */
    const RING_LEVELS = [
        [0.56],
        [0.40, 0.68],
        [0.33, 0.52, 0.71],
        [0.29, 0.46, 0.63, 0.80],
        [0.26, 0.39, 0.52, 0.65, 0.78]
    ];
    function ringsFor(n) {
        if (n <= 9) return 1;
        if (n <= 20) return 2;
        if (n <= 38) return 3;
        if (n <= 62) return 4;
        return 5;
    }

    /* --------------------------------------------------------
       状态
    -------------------------------------------------------- */
    const state = {
        loaded: false,
        data: null,
        idx: null,

        view: 'overview',         // overview | macro | meso | micro | explanation | detail
        macroId: null,
        mesoId: null,
        microId: null,            /* L4 知识节点（最小知识点） */
        explId: null,             /* L5 名词解释 */
        detailId: null,           /* L6 深层内容（公式/案例/人物/历史/争议） */
        originView: null,         /* 进入 L5/L6 前所在的层 —— 双击返回时回到来源层而非客观上层 */
        originId: null,           /* 来路节点 id —— 进 L5/L6 后只亮它和中心，其余罩半透明遮罩 */

        viewMode: 'invest',       // invest 投资学视图 | extend 扩展视图
        relOn: new Set(KNOW_RELS),
        crossLinks: true,
        theme: 'light',

        sessionId: null,
        currentGraphId: 'econ',   /* 兼容旧引擎契约（课程星系移植时读写） */
        /* ★ 画布此刻真正显示的那张图。只由「画布显示内容」决定，
           不能写成 currentGraphId 的别名（对接约定第六条）。 */
        graphId: GRAPH_ID,

        /* 相机 */
        tx: 0, ty: 0, scale: 1
    };

    /* --------------------------------------------------------
       DOM
    -------------------------------------------------------- */
    let root, stage, svg, starsCanvas;
    let gView, gSector, gOrbit, gEdges, gGateLines, gNodes, gGates, defs;
    let zoomBehavior;
    /* 标签记录：每帧重建，缩放时据此重算「放得下几个字 / 是否显示」 */
    let labelRecs = [];
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
            dom3:     cs.getPropertyValue('--kg-dom-3').trim(),
            dom4:     cs.getPropertyValue('--kg-dom-4').trim(),
            dom5:     cs.getPropertyValue('--kg-dom-5').trim()
        };
        PALETTE['宏观金融'] = PALETTE.dom1;
        PALETTE['微观金融'] = PALETTE.dom2;
        PALETTE['交叉学科'] = PALETTE.dom3;
        PALETTE['财经扩展'] = PALETTE.dom4;
        PALETTE['跨学科知识'] = PALETTE.dom5;
    }

    function domColor(domain) { return PALETTE[domain] || PALETTE.dom1; }

    /* --------------------------------------------------------
       数据加载与索引
    -------------------------------------------------------- */
    function buildIndex(data) {
        const byId = new Map();
        (data.nodes || []).forEach(n => byId.set(n.id, n));

        const domains = [], macros = [], mesos = [], micros = [], explanations = [], details = [];
        byId.forEach(n => {
            /* 兼容旧引擎 / 课程星系的 label 字段（course-galaxy.js 读 n.label） */
            if (n.label == null) n.label = n.name;
            if (n.level === 'domain') domains.push(n);
            else if (n.level === 'macro') macros.push(n);
            else if (n.level === 'meso') mesos.push(n);
            else if (n.level === 'micro') micros.push(n);
            else if (n.level === 'explanation') explanations.push(n);
            else if (n.level === 'detail') details.push(n);
        });

        /* 层级树（parent_id）：通用 childrenOf + 逐层快捷映射 */
        const childrenOf = new Map();
        byId.forEach(n => {
            if (!n.parent_id) return;
            const arr = childrenOf.get(n.parent_id) || [];
            arr.push(n); childrenOf.set(n.parent_id, arr);
        });
        const macroOfMeso = new Map();
        const mesoOfMicro = new Map();
        const macroOfMicro = new Map();
        mesos.forEach(m => {
            const mac = byId.get(m.parent_id);
            if (mac && mac.level === 'macro') macroOfMeso.set(m.id, mac.id);
        });
        micros.forEach(m => {
            const meso = byId.get(m.parent_id);
            if (meso && meso.level === 'meso') {
                mesoOfMicro.set(m.id, meso.id);
                const mac = byId.get(meso.parent_id);
                if (mac && mac.level === 'macro') macroOfMicro.set(m.id, mac.id);
            }
        });

        /* 领域归属 + 领域清单（本体 3 域优先，其余按学科数降序） */
        macros.forEach(mac => {
            const dom = byId.get(mac.parent_id);
            mac._domain = (dom && dom.level === 'domain') ? dom.name : (mac.domain || '交叉学科');
        });
        const domNames = domains.map(d => d.name);
        const macroCntOf = name => macros.filter(m => m._domain === name).length;
        const domOrder = DOMAINS_CORE.filter(d => domNames.includes(d))
            .concat(domNames.filter(d => !DOMAINS_CORE.includes(d))
                .sort((a, b) => macroCntOf(b) - macroCntOf(a)));
        const macrosOfDomain = new Map();
        domOrder.forEach(name => macrosOfDomain.set(name, macros.filter(m => m._domain === name)));

        /* 内容层 L4：名词解释（explanation，micro 的直属子节点，1:1） */
        const expNodeOfMicro = new Map();
        const explByMicro = new Map();
        const microOfExp = new Map();
        explanations.forEach(e => {
            if (!e.parent_id) return;
            expNodeOfMicro.set(e.parent_id, e);
            explByMicro.set(e.parent_id, e.content || '');
            microOfExp.set(e.id, e.parent_id);
        });

        /* 内容层 L5：子内容（detail，挂在知识点下 0-N 条） */
        const detailByMicro = new Map();
        const microOfDetail = new Map();
        details.forEach(d => {
            if (!d.parent_id) return;
            const arr = detailByMicro.get(d.parent_id) || [];
            arr.push(d); detailByMicro.set(d.parent_id, arr);
            microOfDetail.set(d.id, d.parent_id);
        });
        detailByMicro.forEach(arr => arr.sort((a, b) =>
            DT_ORDER.indexOf(a.detail_type) - DT_ORDER.indexOf(b.detail_type)));

        /* 知识边（非包含，且两端都是知识点） */
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

        /* 聚合：meso ↔ meso / macro ↔ macro */
        const macroAgg = new Map();   // "a|b"(有序化) -> {a,b,count}
        const mesoAgg = new Map();
        knowEdges.forEach(e => {
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
            const ms = mesoOfMicro.get(e.source), mt = mesoOfMicro.get(e.target);
            if (!ms || !mt || ms === mt) return;
            if (!mesoRel.has(ms)) mesoRel.set(ms, []);
            if (!mesoRel.has(mt)) mesoRel.set(mt, []);
            mesoRel.get(ms).push({ other: mt, count: 1, edge: e });
            mesoRel.get(mt).push({ other: ms, count: 1, edge: e });
        });

        /* 总览方位（按当前视图模式算；切视图时 recomputeOverviewPos 重算） */
        const overviewPos = layoutOverviewPositions(macros, domOrder, state.viewMode);

        /* 统计 */
        const bridgeEdges = knowEdges.filter(e => e.is_bridge === true).length;
        const externalMicros = micros.filter(m => m.is_external === true).length;

        return {
            byId, domains, macros, mesos, micros, explanations, details,
            childrenOf, domOrder, macrosOfDomain,
            macroOfMeso, mesoOfMicro, macroOfMicro,
            expNodeOfMicro, explByMicro, microOfExp, detailByMicro, microOfDetail,
            knowEdges, adjByMicro,
            macroAgg, mesoAgg, macroRel, mesoRel,
            overviewPos,
            stats: {
                nodes: (data.nodes || []).length,
                edges: (data.edges || []).length,
                knowEdges: knowEdges.length,
                clusters: new Set(micros.map(m => m.cluster_name).filter(Boolean)).size,
                bridgeEdges, externalMicros,
                detailCnt: details.length
            }
        };
    }

    /* 当前视图下可见的领域（扩展视图才含「财经扩展 / 跨学科知识」） */
    function visibleDomains() {
        const idx = state.idx;
        if (!idx) return [];
        return state.viewMode === 'extend'
            ? idx.domOrder
            : idx.domOrder.filter(d => DOMAINS_CORE.includes(d));
    }
    function recomputeOverviewPos() {
        const idx = state.idx;
        if (!idx) return;
        idx.overviewPos = layoutOverviewPositions(idx.macros, idx.domOrder, state.viewMode);
    }

    /* --------------------------------------------------------
       布局工具：同心环
    -------------------------------------------------------- */
    /* 扇区内多环：把 list 铺在 [a0, a0+sweep] 扇形的 rings 个同心环上；
       交错分配（i % rings）→ 每环角度均匀，且同领域节点在角度上连续 */
    function bandLayout(list, a0, sweep, rings) {
        const pos = new Map();
        if (!list.length) return pos;
        const buckets = [];
        for (let i = 0; i < rings; i++) buckets.push([]);
        list.forEach((m, i) => buckets[i % rings].push(m));
        buckets.forEach((arr, ri) => {
            arr.forEach((m, j) => {
                pos.set(m.id, {
                    angle: a0 + ((j + 0.5) / arr.length) * sweep,
                    ring: ri, inRing: arr.length, rings
                });
            });
        });
        return pos;
    }

    /* 全环：n 个节点铺在同心环上（环数自适应），返回每槽位 {ring, angle, R, inRing, rings} */
    function ringLayout(n, u) {
        const rings = ringsFor(n);
        const radii = RING_LEVELS[rings - 1].map(f => f * u);
        const slots = [];
        for (let i = 0; i < n; i++) slots.push({ ring: i % rings, R: radii[i % rings] });
        const inRing = new Array(rings).fill(0);
        slots.forEach(s => inRing[s.ring]++);
        const cursor = new Array(rings).fill(0);
        slots.forEach(s => {
            const k = cursor[s.ring]++;
            s.angle = deg(-90) + ((k + 0.5) / inRing[s.ring]) * TAU;
            s.inRing = inRing[s.ring];
            s.rings = rings;
        });
        return slots;
    }

    /* 节点半径：基础半径按「所在环的弧长间距」夹紧，避免同环粘连 */
    function fitRadius(baseR, R, inRing) {
        const chord = R * TAU / Math.max(inRing, 1);
        return Math.max(4.5, Math.min(baseR, chord * 0.40));
    }

    /* 标签：沿半径朝外，按象限选锚点（复用原总览的避让逻辑） */
    function labelOffset(angle, r, gap) {
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        if (cosA > 0.35) return { x: r + gap, y: 4, anchor: 'start' };
        if (cosA < -0.35) return { x: -(r + gap), y: 4, anchor: 'end' };
        if (sinA < 0) return { x: 0, y: -(r + gap), anchor: 'middle' };
        return { x: 0, y: r + gap + 12, anchor: 'middle' };
    }

    function truncate(s, n) {
        s = String(s || '');
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    /* 数据里数组字段形态不稳（v12 部分节点 keywords/disciplines 是字符串或 null），
       统一收敛成数组，避免 .join/.forEach 直接炸掉 */
    function asArr(v) {
        if (Array.isArray(v)) return v;
        if (v == null || v === '') return [];
        return [v];
    }
    function keywordsOf(n) {
        const t = n && n.tags;
        if (!t) return [];
        return asArr(t.keywords).map(k => String(k)).filter(Boolean);
    }

    /* 总览布局：领域扇区 × 多环交错（供各层引用方位） */
    function layoutOverviewPositions(macros, domOrder, viewMode) {
        const names = viewMode === 'extend' ? domOrder.slice() : domOrder.filter(d => DOMAINS_CORE.includes(d));
        const list = macros.filter(m => names.includes(m._domain));
        const total = list.length || 1;
        const rings = ringsFor(total);
        const pos = new Map();
        let a0 = deg(-90);
        names.forEach(dom => {
            const arr = list.filter(m => m._domain === dom);
            if (!arr.length) return;
            const sweep = (arr.length / total) * TAU;
            bandLayout(arr, a0, sweep, rings).forEach((v, k) => pos.set(k, v));
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
        /* ★ 徽标容器本身（.kg-level-badge），不是里面的计数 span——
           之前错拿 kgLevelSteps，querySelectorAll('.lb-step') 永远为空，点从来不亮 */
        levelBadgeEl = document.querySelector('.kg-level-badge');
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
                refreshLabels();   /* 放大后自动长出新标签，缩小则收束 */
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
       · local：直接读 JSON
       · api  ：POST /api/graph/load { graph_id }，按后端统一契约适配
       两条路都保证 level / parent_id 原样可用（引擎分层树只认这两个字段）
    -------------------------------------------------------- */
    let loadPromise = null;

    /* 后端契约 {id,label,type,page,layer,media,extra} → 引擎字段
       extra 里保留了 level / parent_id / content 等全部原始字段 */
    /* 后端统一契约 {id,label,type,page,layer,media,extra} → 引擎内部形态。
       ★ 兼容两种返回形态（合并期间后端有可能两种都给）：
         ① 统一契约：层级在 extra.level / extra.parent_id
         ② 原样 JSON：字段就平铺在节点上（level / parent_id / content …）
       所以先铺节点本体，再让 extra 覆盖，最后兜住 id / name。
       parent_id 缺失时退到 extra.parents[0]（老版后端只给 parents 数组）。 */
    function adaptBackendData(d) {
        return {
            nodes: (d.nodes || []).map(n => {
                const o = Object.assign({}, n, n.extra || {}, {
                    id: n.id, name: n.label || n.name || n.id
                });
                if (!o.parent_id && Array.isArray(o.parents) && o.parents.length) {
                    o.parent_id = o.parents[0];
                }
                if (!o.level && o.layer) o.level = o.layer;
                return o;
            }),
            edges: (d.edges || []).map(e => {
                const o = Object.assign({}, e, e.extra || {}, {
                    source: e.source || e.from, target: e.target || e.to,
                    relation: e.relation || e.label
                });
                if (!o.relation) o.relation = '关联';
                return o;
            }),
            metadata: d.metadata || null
        };
    }

    function fetchGraph() {
        if (DATA_SOURCE === 'api') {
            return fetch(API_BASE + '/api/graph/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ graph_id: GRAPH_ID })
            })
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(resp => {
                    if (!resp || resp.code !== 0) throw new Error((resp && resp.message) || '接口返回异常');
                    const data = adaptBackendData(resp.data || {});
                    if (!data.nodes.length) throw new Error('图谱为空');
                    return data;
                })
                .catch(err => {
                    /* 后端还没登记这张图谱时，本地 JSON 兜底，页面不至于空白 */
                    console.warn('[知识星系] 后端图谱不可用，回退本地 JSON：', err.message);
                    return fetchLocalGraph();
                });
        }
        return fetchLocalGraph();
    }

    function fetchLocalGraph() {
        return fetch(LOCAL_URL)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    function load() {
        if (loadPromise) return loadPromise;
        const loadingEl = document.getElementById('galaxyLoading');
        loadPromise = fetchGraph()
            .then(data => {
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

        /* 视图模式（投资学视图 3 域 / 扩展视图 5 域）：总览方位需重算 */
        document.querySelectorAll('.kg-vm-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === state.viewMode) return;
                state.viewMode = mode;
                document.querySelectorAll('.kg-vm-btn').forEach(b => b.classList.toggle('is-on', b === btn));
                recomputeOverviewPos();
                renderSidebar();
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

        /* 详情面板：关闭 + 顶栏随时开关 */
        document.getElementById('kgDetailClose').addEventListener('click', hideDetail);
        const tgl = document.getElementById('kgDetailToggle');
        if (tgl) tgl.addEventListener('click', () => {
            if (detailEl.classList.contains('show')) { hideDetail(); return; }
            const idx = state.idx;
            const mi = state.microId ? idx.byId.get(state.microId) : null;
            if (state.view === 'micro' && mi) showDetail(mi);
            else if (state.view === 'explanation' && mi) {
                const exp = idx.byId.get(state.explId) || idx.expNodeOfMicro.get(mi.id);
                if (exp) showExplanationDetail(exp, mi); else if (mi) showDetail(mi);
            } else if (state.view === 'detail' && mi) {
                const d = idx.byId.get(state.detailId);
                if (d) showDetailNode(d, mi); else showDetail(mi);
            } else {
                showKgToast('进入知识节点（第 4 层）后可查看详情面板');
            }
        });

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
       支持六层：overview / macro / meso / micro / explanation / detail
    -------------------------------------------------------- */
    function applyDeepLink() {
        try {
            const q = new URLSearchParams(location.search);
            const view = q.get('kgview');
            const id = q.get('kgid');
            const mode = q.get('kgmode');
            const theme = q.get('kgtheme');
            if (theme === 'dark' || theme === 'light') {
                root.dataset.theme = theme;
                state.theme = theme;
                refreshPalette();
                const btn = document.getElementById('kgThemeBtn');
                if (btn) btn.querySelector('span:last-child').textContent =
                    theme === 'light' ? '深空模式' : '浅色星图';
            }
            if (mode === 'extend' || mode === 'invest') {
                state.viewMode = mode;
                document.querySelectorAll('.kg-vm-btn').forEach(b =>
                    b.classList.toggle('is-on', b.dataset.mode === mode));
                recomputeOverviewPos();
                renderSidebar();
            }
            if (!view || !id) return;
            state.deepLink = true;
            if (view === 'macro') enterMacro(id);
            else if (view === 'meso') enterMeso(id);
            else if (view === 'micro') enterMicro(id);
            else if (view === 'explanation') enterExplanationByMicro(id);
            else if (view === 'detail') enterDetail(id);
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
        const names = visibleDomains();
        let html = '<div class="kg-side-head">学科目录 · DICTIONARY</div>';
        names.forEach(dom => {
            const list = idx.macrosOfDomain.get(dom) || [];
            const domMicro = list.reduce((s, m) => s + microCountOfMacro(m.id), 0);
            html += `<div class="kg-side-group">
                <div class="kg-side-group-title">
                    <span class="dot" style="background:${domColor(dom)}"></span>
                    ${dom}<span class="cnt">${list.length} 学科 · ${domMicro} 知识点</span>
                </div>`;
            list.forEach(m => {
                html += `<button class="kg-side-item" data-macro="${m.id}" title="${escapeHtml(m.name)}">
                    ${escapeHtml(m.name)}<span class="micro-cnt">${microCountOfMacro(m.id)} 点</span></button>`;
            });
            html += `</div>`;
        });
        const st = idx.stats;
        html += `<div class="kg-side-stat">
            <b>${st.nodes.toLocaleString()}</b> 节点 · <b>${st.knowEdges.toLocaleString()}</b> 知识关联<br>
            <b>${idx.macros.length}</b> 学科 · <b>${idx.mesos.length.toLocaleString()}</b> 主题 · <b>${idx.micros.length.toLocaleString()}</b> 知识点<br>
            <b>${idx.explanations.length.toLocaleString()}</b> 名词解释 · <b>${idx.details.length.toLocaleString()}</b> 深层内容<br>
            <b>${st.externalMicros}</b> 跨学科延伸${state.viewMode === 'invest' ? '（扩展视图可见）' : ''}
        </div>`;
        box.innerHTML = html;
        box.querySelectorAll('.kg-side-item').forEach(btn => {
            btn.addEventListener('click', () => enterMacro(btn.dataset.macro));
        });
    }

    function syncSidebar() {
        const idx = state.idx;
        let curMac = state.macroId;
        if (state.microId) curMac = idx.macroOfMicro.get(state.microId) || curMac;
        else if (state.mesoId) curMac = idx.macroOfMeso.get(state.mesoId) || curMac;
        document.querySelectorAll('.kg-side-item').forEach(btn => {
            btn.classList.toggle('is-active',
                state.view !== 'overview' && curMac === btn.dataset.macro);
        });
    }

    /* --------------------------------------------------------
       面包屑 / 层级徽标（六层）
    -------------------------------------------------------- */
    function renderBreadcrumb() {
        const idx = state.idx;
        const v = state.view;
        const parts = [];
        parts.push(`<button class="kg-crumb is-home" data-act="home">◉ 星系总览</button>`);
        const sep = () => parts.push('<span class="kg-crumb-sep">›</span>');
        const link = (txt, act, color) => parts.push(
            `<button class="kg-crumb" data-act="${act}"${color ? ` style="color:${color}"` : ''}>${txt}</button>`);
        const cur = txt => parts.push(`<span class="kg-crumb is-current">${txt}</span>`);

        const mac = state.macroId ? idx.byId.get(state.macroId) : null;
        const ms = state.mesoId ? idx.byId.get(state.mesoId) : null;
        const mi = state.microId ? idx.byId.get(state.microId) : null;
        const isContent = (v === 'micro' || v === 'explanation' || v === 'detail');

        if (v !== 'overview' && mac) {
            sep(); link(mac._domain, 'home', domColor(mac._domain));
            sep(); if (v === 'macro') cur(mac.name); else link(mac.name, 'macro');
        }
        if ((v === 'meso' || isContent) && ms) {
            sep(); if (v === 'meso') cur(ms.name); else link(ms.name, 'meso');
        }
        if (isContent && mi) {
            sep(); if (v === 'micro') cur(mi.name); else link(mi.name, 'micro');
        }
        if (v === 'explanation') {
            sep(); cur('名词解释');
        }
        if (v === 'detail') {
            const exp = idx.expNodeOfMicro.get(state.microId);
            if (exp) { sep(); link('名词解释', 'explanation'); }
            const d = idx.byId.get(state.detailId);
            const dl = d ? (DT_META[d.detail_type] || DT_META.case).label : '深层内容';
            sep(); cur(dl + (d && d.name ? ' · ' + escapeHtml(d.name) : ''));
        }

        breadcrumbEl.innerHTML = parts.join('');
        breadcrumbEl.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.act;
                if (act === 'home') goOverview();
                else if (act === 'macro') enterMacro(state.macroId);
                else if (act === 'meso') enterMeso(state.mesoId);
                else if (act === 'micro') enterMicro(state.microId);
                else if (act === 'explanation') enterExplanationByMicro(state.microId);
            });
        });

        /* 层级徽标（6 步）：走到第几层就亮几个点，当前层额外放大高亮 */
        if (levelBadgeEl) {
            const curIdx = VIEW_ORDER.indexOf(v);
            /* detail 层把「名词解释」那一步也点亮（它确实经过了释义层） */
            levelBadgeEl.querySelectorAll('.lb-step').forEach((d, i) => {
                d.classList.toggle('is-on', i <= curIdx);
                d.classList.toggle('is-cur', i === curIdx);
            });
            const nameEl = document.getElementById('kgLevelName');
            if (nameEl) {
                const stepEl = document.getElementById('kgLevelSteps');
                if (stepEl) stepEl.textContent = (curIdx + 1) + '/' + VIEW_ORDER.length;
                nameEl.textContent = VIEW_LABEL[v] || '';
            }
        }
    }

    /* --------------------------------------------------------
       视图渲染主入口
    -------------------------------------------------------- */
    function render(animate) {
        if (!state.loaded) return;
        defs.selectAll('*').remove();
        labelRecs = [];
        renderBreadcrumb();
        syncSidebar();
        if (state.view === 'overview') renderOverview(animate);
        else if (state.view === 'macro') renderMacroView(animate);
        else if (state.view === 'meso') renderMesoView(animate);
        else if (state.view === 'micro') renderMicroView(animate);
        else if (state.view === 'explanation') renderExplanationView(animate);
        else if (state.view === 'detail') renderDetailView(animate);
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

    /* --------------------------------------------------------
       统一节点绘制（六层通用）
       spots: [{ item, x, y, angle, R, ring, inRing }]
         item = { id, name, sub, color, baseR, glyph, halo, external, data }
       → 返回 { group, spots }，spots 里补齐实际半径 r
    -------------------------------------------------------- */
    function drawNodeList(spots, opt) {
        const nodeG = (opt.gParent || gNodes).append('g');
        const out = [];
        spots.forEach((sp, i) => {
            const it = sp.item;
            const x = sp.x, y = sp.y;
            const inRing = sp.inRing || 1;
            const chord = sp.R * TAU / inRing;                 // 世界坐标弧长间距
            const chordScreen = chord * (state.scale || 1);    // 屏幕坐标间距（缩放后）
            const r = fitRadius(it.baseR || 15, sp.R, inRing);
            const isOuterRing = sp.rings == null || sp.ring === sp.rings - 1;

            const g = nodeG.append('g')
                .attr('class', 'kg-node g-node' + (it.cls ? ' ' + it.cls : ''))
                .attr('data-id', it.id)
                .attr('transform', `translate(${x},${y})`)
                .style('opacity', 0);
            if (it.halo) g.append('circle').attr('class', 'kg-halo')
                .attr('r', r + 6).attr('stroke', it.color).attr('stroke-width', 1);
            if (it.ring) g.append('circle').attr('class', 'kg-ring')
                .attr('r', r + 2.5).attr('fill', 'none')
                .attr('stroke', it.color).attr('stroke-width', 1).attr('opacity', 0.55);
            g.append('circle').attr('class', 'kg-node-body').attr('r', r)
                .attr('fill', it.color)
                .style('fill-opacity', it.external ? 0.22 : 1);
            if (it.external) {
                g.append('circle').attr('r', r).attr('fill', 'none')
                    .attr('stroke', it.color).attr('stroke-width', 1.3)
                    .attr('stroke-dasharray', '3 3');
            }
            if (it.glyph) g.append('text').attr('class', 'kg-glyph')
                .attr('y', Math.min(r * 0.34, 5)).attr('text-anchor', 'middle')
                .style('font-size', Math.max(9, Math.min(r * 1.05, 15)) + 'px')
                .text(it.glyph);
            /* ★ 名字常显：所有节点下方都挂名字（低不透明度，见 css .kg-node-label），
               不再依赖悬停；字号随节点半径，超长截断，tooltip 仍有全文 */
            const font = Math.max(10, Math.min(r * 0.62, 14));
            const maxChars = Math.max(4, Math.round(150 / font));
            const labelEl = g.append('text').attr('class', 'kg-node-label')
                .attr('x', 0).attr('y', r + font + 2).attr('text-anchor', 'middle')
                .style('font-size', font + 'px')
                .text(it.bold ? it.name : truncate(it.name, maxChars));
            /* sub（计数等补充信息）仍在空间充裕时才显示，避免和名字挤在一起 */
            const subEl = it.sub ? g.append('text').attr('class', 'kg-node-sublabel')
                .attr('x', 0).attr('y', r + font * 2 + 6).attr('text-anchor', 'middle') : null;
            const rec = {
                el: labelEl, subEl, name: it.name, sub: it.sub,
                chord, force: !!it.forceLabel || !!it.bold, isOuter: isOuterRing,
                font, maxChars
            };
            labelRecs.push(rec);
            labelFit(rec);
            g.on('mouseenter', ev => {
                    if (opt.tipOf) showTip(ev, it.name, opt.tipOf(it));
                    if (opt.hotOf) opt.hotOf(it);
                })
             .on('mousemove', moveTip)
             .on('mouseleave', () => { hideTip(); if (opt.coolOf) opt.coolOf(it); })
             .on('click', () => { if (opt.clickOf) { hideTip(); opt.clickOf(it); } });

            fadeNode(g, opt.animate, (opt.staggerFrom || 0) + i * (opt.staggerStep == null ? 16 : opt.staggerStep));
            out.push({ item: it, x, y, r, angle: sp.angle, ring: sp.ring, R: sp.R });
        });
        return { group: nodeG, spots: out };
    }

    /* 标签常显（节点下方）：名字永远显示，只在缩放过小时把补充行收起来。
       名字本体不再隐藏 —— 由低不透明度样式保证不喧宾夺主。 */
    function labelFit(rec) {
        const scale = state.scale || 1;
        rec.el.style.display = '';
        rec.el.textContent = rec.force ? rec.name : truncate(rec.name, rec.maxChars || 12);
        if (rec.subEl) {
            const ok = rec.chord * scale >= 92;
            rec.subEl.style.display = ok ? '' : 'none';
            if (ok) rec.subEl.textContent = truncate(rec.sub, Math.round((rec.maxChars || 12) * 0.9));
        }
    }
    function refreshLabels() {
        for (let i = 0; i < labelRecs.length; i++) labelFit(labelRecs[i]);
    }

    /* 一个学科下的知识点总数 */
    function microCountOfMacro(macId) {
        const idx = state.idx;
        return (idx.childrenOf.get(macId) || [])
            .reduce((s, ms) => s + (idx.childrenOf.get(ms.id) || []).length, 0);
    }

    /* ========================================================
       视图一：星系总览
       领域扇区 + 学科多环（投资学视图 3 域 / 扩展视图 5 域）
       + 跨域聚合弧线（绕外，默认极淡）
    ======================================================== */
    function renderOverview(animate) {
        clearLayers();
        const idx = state.idx;
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;                  // 基准半径
        const R_IN = u * 0.32, R_OUT = u * 0.985;
        const names = visibleDomains();
        const pos = idx.overviewPos;
        const total = names.reduce((s, d) => s + (idx.macrosOfDomain.get(d) || []).length, 0) || 1;
        const rings = ringsFor(total);
        const radii = RING_LEVELS[rings - 1].map(f => f * u);

        /* --- 扇区底色 --- */
        let a0 = deg(-90);
        const domSectors = [];
        names.forEach(dom => {
            const list = idx.macrosOfDomain.get(dom) || [];
            if (!list.length) return;
            const sweep = (list.length / total) * TAU;
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

        /* 领域名：放扇区外缘；在中线 ±20° 内自动滑到外环节点标签的空当，
           配合小字号 + 底色光晕，避免大标题压住学科节点标签 */
        const outerAngles = [];
        idx.macros.forEach(m => {
            const p = pos.get(m.id);
            if (p && p.ring === rings - 1) outerAngles.push(fmtAngle(p.angle));
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
        let prevMid = null;
        domLabels.forEach(s => {
            let bestA = fmtAngle(s.mid), bestC = -1;
            for (let off = -20; off <= 20; off += 2) {
                const aD = fmtAngle(s.mid + off * Math.PI / 180);
                const c = labelClearance(aD);
                if (c > bestC) { bestC = c; bestA = aD; }
            }
            s._angle = bestA * Math.PI / 180;
            if (prevMid != null) {
                let dA = fmtAngle(s._angle) - fmtAngle(prevMid);
                if (dA < 0) dA += 360;
                if (dA < 26) s._angle = (fmtAngle(prevMid) + 26) * Math.PI / 180;
            }
            prevMid = s._angle;
        });
        domLabels.forEach(s => {
            const lp = polar(cx, cy, R_OUT - 13, s._angle);
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
        radii.forEach(R => {
            gOrbit.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R)
                .attr('fill', 'none')
                .attr('stroke', 'var(--kg-orbit)')
                .attr('stroke-dasharray', '1 7')
                .attr('stroke-width', 1);
        });

        /* --- 学科节点定位（扇区内多环交错） --- */
        const spots = [];
        idx.macros.forEach(m => {
            const p = pos.get(m.id);
            if (!p) return;
            const R = radii[p.ring];
            const [x, y] = polar(cx, cy, R, p.angle);
            const c = microCountOfMacro(m.id);
            m._x = x; m._y = y; m._r = 0;
            spots.push({
                item: {
                    id: m.id, name: m.name, sub: c + ' 知识点',
                    color: domColor(m._domain),
                    baseR: Math.min(9 + Math.sqrt(c) * 0.9, 20),
                    data: m
                },
                angle: p.angle, R, ring: p.ring, inRing: p.inRing, x, y
            });
        });
        const posOf = new Map(spots.map(s => [s.item.id, s]));

        /* --- 聚合边：同域内凹、跨域绕外 --- */
        const gradDefs = defs.append('g');
        const edgesG = gEdges.append('g');
        if (state.relOn.size) idx.macroAgg.forEach(rec => {
            const ma = idx.byId.get(rec.a), mb = idx.byId.get(rec.b);
            if (!ma || !mb) return;
            const sa = posOf.get(rec.a), sb = posOf.get(rec.b);
            if (!sa || !sb) return;
            const isCross = ma._domain !== mb._domain;
            if (isCross && !state.crossLinks) return;

            const A = [sa.x, sa.y], B = [sb.x, sb.y];

            /* 控制点：同域走「弦中点内凹」（短弧、不穿心），跨域贴外圈绕行 */
            let C;
            if (isCross) {
                let dAng = Math.abs(fmtAngle(sa.angle) - fmtAngle(sb.angle));
                if (dAng > 180) dAng = 360 - dAng;
                const CR = Math.min(u * (0.90 + dAng / 180 * 0.07), u * 0.99);
                C = polar(cx, cy, CR, (sa.angle + sb.angle) / 2);
            } else {
                const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
                const dx = mx - cx, dy = my - cy;
                const dl = Math.hypot(dx, dy) || 1;
                const k = 0.16;                     /* 内凹比例，仅作轻微收束 */
                const nr = dl * (1 - k);
                /* 若弦中点已贴近核心（跨扇区的大跨），改为沿外圈轻弧，避免穿过中心 */
                C = nr >= u * 0.30
                    ? [mx - dx * k, my - dy * k]
                    : polar(cx, cy, u * 0.40, (sa.angle + sb.angle) / 2);
            }

            const w = Math.min(1 + Math.log2(1 + rec.count) * 0.85, 3.4) * (isCross ? 0.72 : 1);
            const op = isCross ? 0.18 : 0.38;   /* 默认若隐若现，hover 才亮起 */

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
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.155)
            .attr('fill', 'none').attr('stroke', 'var(--kg-accent)').attr('stroke-width', 1).attr('opacity', 0.35);
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.112)
            .attr('fill', 'none').attr('stroke', 'var(--kg-accent)').attr('stroke-width', 1.5).attr('opacity', 0.55);
        core.append('circle').attr('cx', cx).attr('cy', cy).attr('r', u * 0.066)
            .attr('fill', 'var(--kg-accent)').attr('opacity', 0.92);
        core.append('text').attr('class', 'kg-core-label')
            .attr('x', cx).attr('y', cy + u * 0.066 + 24).attr('text-anchor', 'middle')
            .text('投资学知识星系');
        core.append('text').attr('class', 'kg-core-sub')
            .attr('x', cx).attr('y', cy + u * 0.066 + 40).attr('text-anchor', 'middle')
            .text(idx.macros.length + ' 学科 · ' + idx.micros.length + ' 知识点 · 六层钻取');

        /* --- 学科节点 --- */
        const nodeR = drawNodeList(spots, {
            cx, cy, animate, gParent: gNodes,
            tipOf: it => {
                const m = it.data;
                const mesoCnt = (idx.childrenOf.get(m.id) || []).length;
                return `${m._domain} · ${mesoCnt} 主题 · ${microCountOfMacro(m.id)} 知识点<br>点击进入学科星域`;
            },
            clickOf: it => enterMacro(it.id),
            hotOf: it => hotMacro(it.id, true),
            coolOf: it => hotMacro(it.id, false),
            staggerStep: 12
        });

        /* hover 学科：亮起相关边 */
        function hotMacro(id, on) {
            edgesG.selectAll('.kg-edge').each(function () {
                const el = d3.select(this);
                const hit = el.attr('data-a') === id || el.attr('data-b') === id;
                el.classed('is-hot', on && hit);
                el.classed('is-dim', on && !hit);
            });
            nodeR.group.selectAll('.kg-node').classed('is-dim', on && function () {
                return this.dataset.id !== id;
            });
        }
    }

    /* ========================================================
       视图二：学科星域
       中央学科恒星 + 主题多环 + 外圈星门（通往关联学科）
    ======================================================== */
    function renderMacroView(animate) {
        clearLayers();
        const idx = state.idx;
        const mac = idx.byId.get(state.macroId);
        if (!mac) { goOverview(); return; }
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;
        const R_GATE = u * 0.92;
        const color = domColor(mac._domain);
        const mesos = idx.childrenOf.get(mac.id) || [];

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
            .text(mac._domain + ' · ' + mesos.length + ' 主题');

        /* 主题轨道圈 */
        const rings = ringsFor(mesos.length);
        const radii = RING_LEVELS[rings - 1].map(f => f * u);
        radii.forEach(R => {
            gOrbit.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R)
                .attr('fill', 'none').attr('stroke', 'var(--kg-orbit)')
                .attr('stroke-dasharray', '1 7');
        });

        /* 主题节点（多环交错） */
        const slots = ringLayout(mesos.length, u);
        const spots = mesos.map((ms, i) => {
            const s = slots[i];
            const [x, y] = polar(cx, cy, s.R, s.angle);
            const micros = (idx.childrenOf.get(ms.id) || []).filter(visibleMicro);
            ms._x = x; ms._y = y;
            return {
                item: {
                    id: ms.id, name: ms.name, sub: micros.length + ' 知识点',
                    color, baseR: 12 + Math.sqrt(micros.length) * 2.0, data: ms
                },
                angle: s.angle, R: s.R, ring: s.ring, inRing: s.inRing, x, y
            };
        });

        /* 主题间聚合边（当前学科内部） */
        const edgesG = gEdges.append('g');
        const posMap = new Map(spots.map(s => [s.item.id, s]));
        idx.mesoAgg.forEach(rec => {
            const A = posMap.get(rec.a), B = posMap.get(rec.b);
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

        drawNodeList(spots, {
            cx, cy, animate, gParent: gNodes,
            tipOf: it => `${mac.name} · ${it.sub}<br>点击进入主题星团`,
            clickOf: it => enterMeso(it.id),
            staggerFrom: 80, staggerStep: 26
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

    /* ========================================================
       视图三：主题星团
       中央主题 + 知识点多环 + 关系线型 + 外部星门
    ======================================================== */
    function renderMesoView(animate) {
        clearLayers();
        const idx = state.idx;
        const ms = idx.byId.get(state.mesoId);
        if (!ms) { goOverview(); return; }
        const mac = idx.byId.get(idx.macroOfMeso.get(state.mesoId)) || { name: '', _domain: '交叉学科' };
        const cx = W / 2, cy = H / 2;
        const u = Math.min(W, H) / 2;
        const R_GATE = u * 0.92;
        const color = domColor(mac._domain);

        /* 知识点（延伸知识点在投资学视图下默认隐藏；若本单位全是延伸节点则照常展示） */
        let micros = (idx.childrenOf.get(ms.id) || []).filter(visibleMicro);
        if (!micros.length) micros = idx.childrenOf.get(ms.id) || [];

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
            .text(mac.name + ' · ' + micros.length + ' 知识点');

        /* 轨道圈 */
        const rings = ringsFor(micros.length);
        const radii = RING_LEVELS[rings - 1].map(f => f * u);
        radii.forEach(R => {
            gOrbit.append('circle').attr('cx', cx).attr('cy', cy).attr('r', R)
                .attr('fill', 'none').attr('stroke', 'var(--kg-orbit)')
                .attr('stroke-dasharray', '1 7');
        });

        /* 知识点定位（多环交错） */
        const slots = ringLayout(micros.length, u);
        const spots = micros.map((mi, i) => {
            const s = slots[i];
            const [x, y] = polar(cx, cy, s.R, s.angle);
            const dtCnt = (idx.detailByMicro.get(mi.id) || []).length;
            mi._x = x; mi._y = y;
            return {
                item: {
                    id: mi.id, name: mi.name,
                    sub: dtCnt ? dtCnt + ' 深层内容' : '暂无深层内容',
                    color,
                    baseR: 11 + (mi.core ? 3 : 0) + (Number(mi.importance) || 0) * 8,
                    external: mi.is_external === true,
                    data: mi
                },
                angle: s.angle, R: s.R, ring: s.ring, inRing: s.inRing, x, y
            };
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

        drawNodeList(spots, {
            cx, cy, animate, gParent: gNodes,
            tipOf: it => {
                const mi = it.data;
                const d = idx.explByMicro.get(mi.id) || mi.description || '';
                const meta = [];
                if (mi.is_external) meta.push('跨学科延伸 · ' + (mi.source_discipline || '外延'));
                if (mi.cluster_name) meta.push('簇 · ' + mi.cluster_name);
                if (d) meta.push(escapeHtml(d.slice(0, 52)) + (d.length > 52 ? '…' : ''));
                meta.push('点击进入知识节点');
                return meta.join('<br>');
            },
            clickOf: it => enterMicro(it.id),
            staggerFrom: 60, staggerStep: 24
        });

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

    /* ========================================================
       内容层公共件（知识节点 / 名词解释 / 深层内容 三层共用）
    ======================================================== */
    function contentCtx(mi, animate) {
        const idx = state.idx;
        const meso = idx.byId.get(idx.mesoOfMicro.get(mi.id));
        const mac = idx.byId.get(idx.macroOfMicro.get(mi.id));
        return {
            idx, mi, meso, mac, animate,
            cx: W / 2, cy: H / 2, u: Math.min(W, H) / 2,
            color: domColor(mac ? mac._domain : '交叉学科'),
            exp: idx.expNodeOfMicro.get(mi.id) || null,
            details: idx.detailByMicro.get(mi.id) || []
        };
    }

    /* 中央恒星：知识点 / 名词解释 / 深层内容 都长这样（文字即内容主体）。
       style = { color, glyph, ring, halo }：
       - 知识节点用领域色；名词解释 / 深层内容主节点必须沿用该内容类型的
         专属色 + 字形（与它在上一层作为卫星节点时的样子一致，避免迷路）。 */
    function drawContentCore(ctx, title, sub, onClick, style) {
        const s = style || {};
        const color = s.color || ctx.color;
        const { cx, cy } = ctx;
        const core = gNodes.append('g')
            .attr('class', 'kg-node g-node kg-core-node')
            .attr('transform', `translate(${cx},${cy})`);
        if (s.halo !== false)
            core.append('circle').attr('class', 'kg-halo').attr('r', 42)
                .attr('stroke', color).attr('stroke-width', 1.2);
        if (s.ring)
            core.append('circle').attr('class', 'kg-ring').attr('r', 33)
                .attr('fill', 'none').attr('stroke', color)
                .attr('stroke-width', 1).attr('opacity', 0.55);
        core.append('circle').attr('class', 'kg-node-body').attr('r', 29).attr('fill', color);
        if (s.glyph)
            core.append('text').attr('class', 'kg-glyph')
                .attr('y', 6).attr('text-anchor', 'middle')
                .style('font-size', '17px').text(s.glyph);
        core.append('text').attr('class', 'kg-core-label')
            .attr('y', 58).attr('text-anchor', 'middle').text(truncate(title, 22));
        if (sub) core.append('text').attr('class', 'kg-node-sublabel')
            .attr('y', 74).attr('text-anchor', 'middle').text(sub);
        if (onClick) core.style('cursor', 'pointer').on('click', onClick);
        fadeNode(core, ctx.animate, 0);
        return core;
    }

    /* 子节点环（释义 + 深层内容，最多两环） */
    function drawContentRing(ctx, items, animate) {
        const { cx, cy, u } = ctx;
        if (!items.length) return null;
        const rings = items.length <= 8 ? 1 : 2;
        const radii = rings === 1 ? [u * 0.50] : [u * 0.38, u * 0.68];
        const buckets = [];
        for (let i = 0; i < rings; i++) buckets.push([]);
        items.forEach((it, i) => buckets[i % rings].push(it));
        const spots = [];
        buckets.forEach((arr, ri) => {
            arr.forEach((it, j) => {
                const a = deg(-90) + ((j + 0.5) / arr.length) * TAU;
                const R = radii[ri];
                const [x, y] = polar(cx, cy, R, a);
                spots.push({ item: it, angle: a, R, ring: ri, inRing: arr.length, x, y });
            });
        });

        /* 中心 → 子节点连线 */
        const eg = gEdges.append('g');
        spots.forEach(sp => {
            eg.append('line').attr('class', 'kg-edge g-node')
                .attr('x1', cx).attr('y1', cy).attr('x2', sp.x).attr('y2', sp.y)
                .attr('stroke', 'var(--kg-edge)').attr('stroke-width', 1.2)
                .attr('opacity', 0.7);
        });

        return drawNodeList(spots, {
            cx, cy, animate, gParent: gNodes,
            tipOf: it => it.tip || '',
            clickOf: it => { if (it.onClick) it.onClick(it); },
            staggerFrom: 90, staggerStep: 45
        });
    }

    /* 一个知识点的「名词解释 + 深层内容」节点清单 */
    function contentChildItems(ctx, opt) {
        const o = opt || {};
        const items = [];
        if (ctx.exp && !o.skipExpl) {
            items.push({
                id: ctx.exp.id, kind: 'explanation', cls: 'kg-node-expl',
                name: '名词解释', sub: '点开看释义全文',
                color: dtColor('explanation', ctx.color), baseR: 20, glyph: '释', ring: true, halo: true,
                tip: '名词解释 · ' + escapeHtml(ctx.mi.name) + '<br>' +
                     escapeHtml((ctx.exp.content || '').slice(0, 56)) + '…<br>点击进入第 5 层',
                onClick: () => enterExplanationByMicro(ctx.mi.id)
            });
        }
        ctx.details.slice(0, DT_MAX_ON_STAGE).forEach(d => {
            const meta = DT_META[d.detail_type] || DT_META.case;
            const nm = d.name || meta.label;
            items.push({
                id: d.id, kind: d.detail_type, cls: 'kg-node-detail',
                name: meta.label + ' · ' + nm, sub: '',
                color: dtColor(d.detail_type, ctx.color), baseR: 14, glyph: meta.glyph,
                tip: meta.label + ' · ' + escapeHtml(nm) + '<br>' +
                     escapeHtml((d.content || '').slice(0, 60)) + '<br>点击进入第 6 层',
                onClick: () => enterDetail(d.id)
            });
        });
        return items;
    }

    /* 关联知识点星门（内容三层共用） */
    function microGateItems(microId, limit) {
        const idx = state.idx;
        const gateMap = new Map();
        (idx.adjByMicro.get(microId) || []).forEach(a => {
            if (!state.relOn.has(a.edge.relation)) return;
            const other = idx.byId.get(a.other);
            if (!other) return;
            const g = gateMap.get(a.other) || { count: 0, rels: new Set() };
            g.count += 1; g.rels.add(a.edge.relation);
            gateMap.set(a.other, g);
        });
        return [...gateMap.entries()]
            .map(([oid, g]) => {
                const o = idx.byId.get(oid);
                if (!o) return null;
                const omac = idx.byId.get(idx.macroOfMicro.get(oid));
                const pos = omac ? idx.overviewPos.get(omac.id) : null;
                return {
                    key: 'm:' + oid, id: oid, kind: 'micro',
                    count: g.count, edges: [...g.rels],
                    label: o.name,
                    sub: omac ? omac.name : '延伸知识点',
                    _posAngle: pos ? pos.angle : undefined
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.count - a.count)
            .slice(0, limit || 10);
    }

    /* ========================================================
       视图四：知识节点（micro · 第 4 层）
       中央知识点恒星 + 「名词解释」入口 + 深层内容节点 + 关联知识点星门
       —— 点「名词解释」下潜第 5 层，点深层内容直接下潜第 6 层
    ======================================================== */
    /* 来源聚焦：进入 L5/L6 后，只保留「来路节点 + 中央恒星」全亮，
       其余卫星节点与星门罩一层半透明遮罩（悬停恢复）——一眼看清自己从哪儿来 */
    function applyOriginFocus(originId) {
        if (!originId) return;
        gNodes.selectAll('.kg-node').classed('is-dim', function () {
            if (this.classList.contains('kg-core-node')) return false;
            return this.dataset.id !== originId;
        });
        gGates.selectAll('.kg-gate').classed('is-dim', true);
    }

    function renderMicroView(animate) {
        clearLayers();
        const idx = state.idx;
        const mi = idx.byId.get(state.microId);
        if (!mi || mi.level !== 'micro') { goOverview(); return; }
        const ctx = contentCtx(mi, animate);
        const { cx, cy, u } = ctx;

        /* ★ 标题用中文名（mi.name），id 只在 tooltip / 面板里出现 */
        drawContentCore(ctx, mi.name, [
            ctx.meso ? ctx.meso.name : (mi.is_external ? '跨学科延伸' : ''),
            (ctx.details.length ? ctx.details.length + ' 条深层内容' : '暂无深层内容')
        ].filter(Boolean).join(' · '), () => showDetail(mi));

        const items = contentChildItems(ctx);
        if (!items.length) {
            gSector.append('text').attr('class', 'kg-sat-empty')
                .attr('x', cx).attr('y', cy - u * 0.30)
                .attr('text-anchor', 'middle')
                .text('该知识点暂无释义 / 深层内容 · 双击空白返回主题星团');
        }
        drawContentRing(ctx, items, animate);

        renderGates({
            cx, cy, R_GATE: u * 0.92, u, animate,
            relItems: microGateItems(mi.id, 10),
            centerLabel: mi.name,
            isMeso: true
        });
    }

    /* ========================================================
       视图五：名词解释（explanation · 第 5 层）
       中央释义恒星 + 其下子内容环 + 关联知识点星门
    ======================================================== */
    function renderExplanationView(animate) {
        clearLayers();
        const idx = state.idx;
        const mi = idx.byId.get(state.microId);
        const exp = idx.byId.get(state.explId) || (mi ? idx.expNodeOfMicro.get(mi.id) : null);
        if (!mi || !exp) { if (mi) enterMicro(mi.id); else goOverview(); return; }
        const ctx = contentCtx(mi, animate);
        const { cx, cy, u } = ctx;
        ctx.exp = exp;

        /* 主节点 = 释义样式：靛蓝 + 「释」字形（与其在上一层的样子一致） */
        const explTitle = (exp.name && exp.name !== '名词解释') ? exp.name : (mi.name + '的解释');
        drawContentCore(ctx, explTitle, [
            '名词解释 · ' + mi.name,
            (ctx.details.length ? ctx.details.length + ' 条子内容' : '暂无子内容')
        ].filter(Boolean).join(' · '), () => showExplanationDetail(exp, mi),
        { color: dtColor('explanation'), glyph: '释', ring: true, halo: true });

        /* 子内容环：深层内容 + 来路节点（从第 4 层直进时补「知识点」回程节点） */
        const items = contentChildItems(ctx, { skipExpl: true });
        if (state.originId === mi.id) {
            items.push({
                id: mi.id, kind: 'micro', cls: 'kg-node-back',
                name: '知识点 · ' + mi.name, sub: '返回第 4 层',
                color: ctx.color, baseR: 17, glyph: '◉',
                tip: '返回知识节点 · ' + escapeHtml(mi.name),
                onClick: () => enterMicro(mi.id)
            });
        }
        if (!items.length) {
            gSector.append('text').attr('class', 'kg-sat-empty')
                .attr('x', cx).attr('y', cy - u * 0.30)
                .attr('text-anchor', 'middle')
                .text('该释义暂无子内容（案例 / 公式 / 人物…）· 双击空白返回知识节点');
        }
        drawContentRing(ctx, items, animate);

        renderGates({
            cx, cy, R_GATE: u * 0.92, u, animate,
            relItems: microGateItems(mi.id, 10),
            centerLabel: exp.name || mi.name,
            isMeso: true
        });
        applyOriginFocus(state.originId);
    }

    /* ========================================================
       视图六：深层内容（detail · 第 6 层）
       中央子内容恒星 + 兄弟内容环（含「名词解释」回程）+ 关联知识点星门
    ======================================================== */
    function renderDetailView(animate) {
        clearLayers();
        const idx = state.idx;
        const d = idx.byId.get(state.detailId);
        if (!d || d.level !== 'detail') { goOverview(); return; }
        const microId = state.microId || idx.microOfDetail.get(d.id);
        const mi = idx.byId.get(microId);
        if (!mi) { goOverview(); return; }
        const ctx = contentCtx(mi, animate);
        const { cx, cy, u } = ctx;
        state.microId = microId;
        const meta = DT_META[d.detail_type] || DT_META.case;

        /* 主节点 = 该内容类型样式（如案例 = 红圈 + ▶），与其卫星形态一致 */
        drawContentCore(ctx, d.name || meta.label,
            meta.label + ' · ' + mi.name, () => showDetailNode(d, mi),
            { color: dtColor(d.detail_type), glyph: meta.glyph, ring: true, halo: true });

        /* 兄弟节点：名词解释回程 + 其余深层内容 */
        const items = [];
        if (ctx.exp) {
            items.push({
                id: ctx.exp.id, kind: 'explanation', cls: 'kg-node-expl',
                name: '名词解释', sub: '返回第 5 层',
                color: dtColor('explanation', ctx.color), baseR: 20, glyph: '释', ring: true, halo: true,
                tip: '名词解释 · ' + escapeHtml(mi.name) + '<br>点击回到第 5 层',
                onClick: () => enterExplanationByMicro(mi.id)
            });
        }
        ctx.details.forEach(x => {
            if (x.id === d.id) return;
            const m2 = DT_META[x.detail_type] || DT_META.case;
            items.push({
                id: x.id, kind: x.detail_type, cls: 'kg-node-detail',
                name: m2.label + ' · ' + (x.name || m2.label), sub: '',
                color: dtColor(x.detail_type, ctx.color), baseR: 13, glyph: m2.glyph,
                tip: m2.label + ' · ' + escapeHtml(x.name || '') + '<br>' +
                     escapeHtml((x.content || '').slice(0, 56)),
                onClick: () => enterDetail(x.id)
            });
        });
        /* 其他知识点：返回本知识点 */
        items.push({
            id: mi.id, kind: 'micro', cls: 'kg-node-back',
            name: '知识点 · ' + mi.name, sub: '返回第 4 层',
            color: ctx.color, baseR: 17, glyph: '◉',
            tip: '返回知识节点 · ' + escapeHtml(mi.name),
            onClick: () => enterMicro(mi.id)
        });
        drawContentRing(ctx, items, animate);

        renderGates({
            cx, cy, R_GATE: u * 0.92, u, animate,
            relItems: microGateItems(mi.id, 10),
            centerLabel: mi.name,
            isMeso: true
        });
        applyOriginFocus(state.originId);
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
            if (it._posAngle != null) { it._baseA = it._posAngle; return; }
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

            /* 星门是「别的知识点的入口」，尺寸明显小于主/卫星节点，
               避免不同层级的节点看起来平级 */
            const r = 10 + Math.min(it.count, 12) * 0.45;
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
                 else if (it.kind === 'micro') enterMicro(it.id);
                 else enterMeso(it.id);
             });

            fadeNode(g, animate, 200 + i * 40);
        });
    }

    /* --------------------------------------------------------
       导航（六层）
    -------------------------------------------------------- */
    function goOverview() {
        state.view = 'overview';
        state.macroId = null; state.mesoId = null;
        state.microId = null; state.explId = null; state.detailId = null;
        state.originView = null; state.originId = null;
        hideDetail();
        render(true);
        resetCamera();
    }
    function enterMacro(id) {
        const idx = state.idx;
        if (!id || !idx.byId.get(id)) return false;
        state.view = 'macro';
        state.macroId = id;
        state.mesoId = null; state.microId = null; state.explId = null; state.detailId = null;
        state.originView = null; state.originId = null;
        hideDetail();
        render(true);
        resetCamera();
        return true;
    }
    function enterMeso(id) {
        const idx = state.idx;
        if (!id || !idx.byId.get(id)) return false;
        state.view = 'meso';
        state.mesoId = id;
        state.microId = null; state.explId = null; state.detailId = null;
        state.originView = null; state.originId = null;
        const mac = idx.macroOfMeso.get(id);
        if (mac) state.macroId = mac;
        hideDetail();
        render(true);
        resetCamera();
        return true;
    }
    /* 进入第 4 层：知识节点（中央知识点 + 释义入口 + 深层内容） */
    function enterMicro(id) {
        const idx = state.idx;
        const mi = idx.byId.get(id);
        if (!mi || mi.level !== 'micro') return false;
        state.view = 'micro';
        state.microId = id;
        state.explId = null; state.detailId = null;
        state.originView = null; state.originId = null;
        const mesoId = idx.mesoOfMicro.get(id);
        state.mesoId = mesoId || null;
        state.macroId = mesoId ? (idx.macroOfMeso.get(mesoId) || null) : null;
        hideDetail();
        render(true);
        resetCamera();
        showDetail(mi);
        return true;
    }
    /* 进入第 5 层：名词解释（按知识点找其释义节点） */
    function enterExplanationByMicro(microId) {
        const idx = state.idx;
        const mi = idx.byId.get(microId);
        if (!mi || mi.level !== 'micro') return false;
        const exp = idx.expNodeOfMicro.get(microId);
        if (!exp) {
            enterMicro(microId);
            showKgToast('该知识点暂无名词解释节点');
            return false;
        }
        state.originView = state.view;          /* 记录从哪层进来，双击空白回哪层 */
        /* 来路节点：从 L4 来=那个知识点；从 L6 来=那个深层内容 */
        state.originId = state.view === 'detail' ? state.detailId : microId;
        state.view = 'explanation';
        state.microId = microId;
        state.explId = exp.id;
        state.detailId = null;
        const mesoId = idx.mesoOfMicro.get(microId);
        state.mesoId = mesoId || null;
        state.macroId = mesoId ? (idx.macroOfMeso.get(mesoId) || null) : null;
        hideDetail();
        render(true);
        resetCamera();
        showExplanationDetail(exp, mi);         /* ★ 进层即弹出释义全文（第 4 层右侧所见的 description） */
        return true;
    }
    /* 进入第 6 层：深层内容（案例 / 公式 / 人物 / 历史 / 争议 全文） */
    function enterDetail(detailId) {
        const idx = state.idx;
        const d = idx.byId.get(detailId);
        if (!d || d.level !== 'detail') return false;
        const microId = idx.microOfDetail.get(d.id) || d.parent_id;
        const mi = idx.byId.get(microId);
        if (!mi) return false;
        state.originView = state.view;          /* 从 L4 直进 L6 时记 originView='micro' */
        /* 来路节点：从 L4 来=那个知识点；从 L5 来=那条名词解释 */
        state.originId = state.view === 'explanation' ? (state.explId || mi.id) : microId;
        state.view = 'detail';
        state.detailId = d.id;
        state.microId = microId;
        state.explId = (idx.expNodeOfMicro.get(microId) || {}).id || null;
        const mesoId = idx.mesoOfMicro.get(microId);
        state.mesoId = mesoId || null;
        state.macroId = mesoId ? (idx.macroOfMeso.get(mesoId) || null) : null;
        hideDetail();
        render(true);
        resetCamera();
        showDetailNode(d, mi);                  /* ★ 进层即弹出该条内容全文 */
        return true;
    }
    /* 双击空白 = 返回「刚刚点击进来的那层」（来源层优先，无来源层再走客观上层） */
    function goUp() {
        if (state.view === 'detail') {
            if (state.originView === 'micro' && enterMicro(state.microId)) return;
            if (!enterExplanationByMicro(state.microId)) enterMicro(state.microId);
        } else if (state.view === 'explanation') {
            if (state.originView === 'detail' && state.detailId) {
                state.originView = null;          /* 用掉来源记录，避免 L5↔L6 来回弹 */
                if (enterDetail(state.detailId)) return;
            }
            if (!enterMicro(state.microId)) goOverview();
        } else if (state.view === 'micro') {
            if (!enterMeso(state.mesoId)) { if (!enterMacro(state.macroId)) goOverview(); }
        } else if (state.view === 'meso') {
            if (!enterMacro(state.macroId)) goOverview();
        } else if (state.view === 'macro') goOverview();
    }

    /* 投资学视图下是否可见（延伸节点仅扩展视图显示） */
    function visibleMicro(m) {
        return state.viewMode === 'extend' ? true : m.is_external !== true;
    }

    /* --------------------------------------------------------
       详情面板（右侧；六层共用，内容随当前层切换）
    -------------------------------------------------------- */
    /* 按 id 自动路由到对应层（面板里的胶囊 / 面包屑都用它） */
    function openNodeById(id) {
        const idx = state.idx;
        const n = idx.byId.get(id);
        if (!n) return false;
        if (n.level === 'detail') return enterDetail(n.id);
        if (n.level === 'explanation') return enterExplanationByMicro(n.parent_id);
        if (n.level === 'micro') return enterMicro(n.id);
        if (n.level === 'meso') return enterMeso(n.id);
        if (n.level === 'macro') return enterMacro(n.id);
        goOverview(); return true;
    }

    function selectMicro(id) {
        const mi = state.idx.byId.get(id);
        if (!mi) return;
        state.selectedMicro = id;
        showDetail(mi);
        pulseNode(id);
    }

    function nodeG_byId(id) {
        return gNodes.selectAll('.kg-node').filter(function () { return this.dataset.id === id; });
    }

    /* 脉冲高亮任意层的节点 */
    function pulseNode(id) {
        if (!id) return;
        gNodes.selectAll('.kg-node').classed('kg-pulse', function () { return this.dataset.id === id; });
        setTimeout(() => {
            gNodes.selectAll('.kg-node').classed('kg-pulse', false);
        }, 2800);
    }
    const pulseMicro = pulseNode;

    /* 面板顶部路径 */
    function renderDetailPath(crumbs) {
        const pathEl = document.getElementById('kgDetailPath');
        if (!pathEl) return;
        pathEl.innerHTML = '';
        crumbs.forEach((c, i) => {
            if (i) pathEl.insertAdjacentHTML('beforeend', '<span class="kg-crumb-sep">›</span>');
            if (c.go) {
                const b = document.createElement('button');
                b.textContent = c.t;
                b.addEventListener('click', c.go);
                pathEl.appendChild(b);
            } else {
                pathEl.insertAdjacentHTML('beforeend',
                    `<span class="kg-crumb is-current">${escapeHtml(c.t)}</span>`);
            }
        });
    }

    /* 知识点的上级路径（域 › 学科 › 主题） */
    function microCrumbs(mi) {
        const idx = state.idx;
        const meso = idx.byId.get(idx.mesoOfMicro.get(mi.id));
        const mac = idx.byId.get(idx.macroOfMicro.get(mi.id));
        const out = [];
        if (mac) out.push({ t: mac._domain, go: goOverview });
        if (mac) out.push({ t: mac.name, go: () => enterMacro(mac.id) });
        if (meso) out.push({ t: meso.name, go: () => enterMeso(meso.id) });
        return out;
    }

    /* 面板：关键词区（学科 / 标签） */
    function fillKeywords(mi) {
        const kwEl = document.getElementById('kgDetailKw');
        let kh = '';
        asArr(mi.disciplines).forEach(d => { kh += `<span class="kg-badge">${escapeHtml(d)}</span>`; });
        keywordsOf(mi).forEach(k => { kh += `<span class="kg-badge">${escapeHtml(k)}</span>`; });
        kwEl.innerHTML = kh || '<span class="kg-rel-empty">暂无标签</span>';
    }

    /* 面板：第 4 层（知识节点） */
    function showDetail(mi) {
        const idx = state.idx;
        const exp = idx.expNodeOfMicro.get(mi.id) || null;
        const details = idx.detailByMicro.get(mi.id) || [];

        document.getElementById('kgDetailTitle').textContent = mi.name;

        const crumbs = microCrumbs(mi);
        crumbs.push({ t: mi.name });
        renderDetailPath(crumbs);

        /* 徽章 */
        const badgeEl = document.getElementById('kgDetailBadges');
        let bh = '<span class="kg-badge is-level">第 4 层 · 知识节点</span>';
        if (mi.is_external) bh += `<span class="kg-badge is-external">跨学科延伸 · ${escapeHtml(mi.source_discipline || '外延')}</span>`;
        if (mi.core) bh += '<span class="kg-badge is-core">核心知识点</span>';
        if (mi.cluster_name) bh += `<span class="kg-badge">簇 · ${escapeHtml(mi.cluster_name)}</span>`;
        if (mi.difficulty) bh += `<span class="kg-badge kg-diff" title="难度">${'●'.repeat(mi.difficulty)}${'○'.repeat(Math.max(0, 5 - mi.difficulty))}</span>`;
        badgeEl.innerHTML = bh;

        fillKeywords(mi);

        /* 释义（第 5 层入口） */
        const descEl = document.getElementById('kgDetailDesc');
        const content = (exp && exp.content) || mi.description || '';
        descEl.textContent = content || '该知识点暂无释义内容。';
        descEl.classList.toggle('is-empty', !content);
        const descSec = descEl.closest('.kg-detail-section');
        if (descSec) {
            let jump = descSec.querySelector('.kg-desc-jump');
            if (!jump) {
                jump = document.createElement('button');
                jump.className = 'kg-desc-jump';
                descSec.appendChild(jump);
            }
            jump.hidden = !exp;
            if (exp) {
                jump.textContent = '进入名词解释 · 第 5 层 ›';
                jump.onclick = () => enterExplanationByMicro(mi.id);
            }
        }

        /* 重要度（只显示/隐藏重要度条本身，「详解」区块必须始终可见） */
        const imp = Number(mi.importance) || 0;
        const impBarEl = document.getElementById('kgDetailImpBar');
        impBarEl.style.width = Math.round(imp * 100) + '%';
        const impWrap = impBarEl.closest('.kg-importance-bar');
        if (impWrap) impWrap.style.display = '';

        /* 扩展内容：释义 + 深层内容，全部可点击下潜 */
        const snEl = document.getElementById('kgDetailSub');
        let sh = '';
        if (exp) {
            sh += `<button class="kg-subnode is-link is-depth" data-id="${exp.id}"` +
                  ` title="${escapeHtml((exp.content || '').slice(0, 150))}">释义 · 名词解释` +
                  `<span class="depth-tag">第5层</span></button>`;
        }
        details.forEach(d => {
            const m2 = DT_META[d.detail_type] || DT_META.case;
            sh += `<button class="kg-subnode is-link is-depth" data-id="${d.id}"` +
                  ` title="${escapeHtml((d.content || '').slice(0, 150))}">${m2.label} · ${escapeHtml(d.name || '')}` +
                  `<span class="depth-tag">第6层</span></button>`;
        });
        /* sub_nodes 里剩余的名字（v12 的 detail 尚未覆盖全部）做只读补位 */
        const sn = mi.sub_nodes || {};
        const legacy = [];
        [['公式', sn.formulas], ['案例', sn.cases], ['人物', sn.people], ['历史', sn.history], ['争议', sn.debates]]
            .forEach(pair => {
                (pair[1] || []).forEach(v => {
                    const nm = (v && typeof v === 'object') ? (v.name || v.title || '') : String(v);
                    if (!nm) return;
                    if (details.some(d => (d.name || '') === nm)) return;
                    legacy.push(pair[0] + ' · ' + nm);
                });
            });
        if (legacy.length) {
            sh += legacy.slice(0, 12).map(t =>
                `<span class="kg-subnode is-empty" title="结构化子内容待后端补齐">${escapeHtml(t)}</span>`).join('');
        }
        if (!sh) sh = '<span class="kg-subnode is-empty">暂无扩展内容</span>';
        snEl.innerHTML = sh;
        snEl.querySelectorAll('.kg-subnode.is-link').forEach(btn => {
            btn.addEventListener('click', () => openNodeById(btn.dataset.id));
        });

        renderRelList(mi);
        detailEl.classList.add('show');
        syncDetailToggle();
    }

    /* 面板：关联知识点列表（各层共用） */
    function renderRelList(mi) {
        const idx = state.idx;
        const relEl = document.getElementById('kgDetailRels');
        const adj = idx.adjByMicro.get(mi.id) || [];
        if (!adj.length) {
            relEl.innerHTML = '<div class="kg-rel-empty">暂无直接关联知识点</div>';
            return;
        }
        const mac = idx.byId.get(idx.macroOfMicro.get(mi.id));
        const rels = adj
            .filter(a => state.relOn.has(a.edge.relation))
            .sort((a, b) => (b.edge.confidence || 0) - (a.edge.confidence || 0))
            .slice(0, 14);
        if (!rels.length) rels.push(...adj.slice(0, 14));
        relEl.innerHTML = '';
        rels.forEach(a => {
            const other = idx.byId.get(a.other);
            if (!other) return;
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
            btn.addEventListener('click', () => enterMicro(other.id));
            relEl.appendChild(btn);
        });
    }

    /* 面板：第 5 / 6 层（名词解释 / 深层内容 全文视图）
       两种节点结构一致：{ name, content } + 同层兄弟，故共用一个渲染器 */
    function showContentDetail(node, mi) {
        const idx = state.idx;
        const isExpl = node.level === 'explanation';
        const meta = isExpl ? DT_META.explanation : (DT_META[node.detail_type] || DT_META.case);
        const kindLabel = isExpl ? '名词解释' : meta.label;
        const layerNo = isExpl ? 5 : 6;
        const exp = idx.expNodeOfMicro.get(mi.id) || null;

        document.getElementById('kgDetailTitle').textContent =
            (isExpl
                ? ((node.name && node.name !== '名词解释') ? node.name : mi.name + '的解释')
                : (node.name || kindLabel));

        /* 路径：域 › 学科 › 主题 › 知识点 › (名词解释) › 当前 */
        const crumbs = microCrumbs(mi);
        crumbs.push({ t: mi.name, go: () => enterMicro(mi.id) });
        if (!isExpl) crumbs.push({ t: '名词解释', go: () => enterExplanationByMicro(mi.id) });
        crumbs.push({ t: kindLabel });
        renderDetailPath(crumbs);

        /* 徽章：层级 + 类型 + 回程 */
        const badgeEl = document.getElementById('kgDetailBadges');
        const dColor = dtColor(isExpl ? 'explanation' : node.detail_type, domColor('交叉学科'));
        badgeEl.innerHTML =
            `<span class="kg-badge is-level">第 ${layerNo} 层</span>` +
            `<span class="kg-badge is-dtype" style="background:${dColor}">${kindLabel}</span>` +
            `<button class="kg-badge is-link" id="kgBadgeBackMicro">知识点 · ${escapeHtml(mi.name)}</button>`;
        const back = document.getElementById('kgBadgeBackMicro');
        if (back) back.addEventListener('click', () => enterMicro(mi.id));

        fillKeywords(mi);

        /* 全文 */
        const descEl = document.getElementById('kgDetailDesc');
        const content = node.content || '';
        descEl.textContent = content || '该条内容暂待补充。';
        descEl.classList.toggle('is-empty', !content);
        const descSec = descEl.closest('.kg-detail-section');
        if (descSec) {
            const jump = descSec.querySelector('.kg-desc-jump');
            if (jump) jump.hidden = true;
        }

        /* ★ 内容层没有重要度字段 → 只隐藏重要度条本身。
           （之前隐藏的是整个「详解」section，把 description 一起藏没了——
             这就是第 5/6 层面板看不到解释内容的根因） */
        const impBarEl2 = document.getElementById('kgDetailImpBar');
        const impWrap2 = impBarEl2.closest('.kg-importance-bar');
        if (impWrap2) impWrap2.style.display = 'none';

        /* 同层兄弟 + 回程 */
        const snEl = document.getElementById('kgDetailSub');
        const details = idx.detailByMicro.get(mi.id) || [];
        let sh = '';
        if (!isExpl && exp) {
            sh += `<button class="kg-subnode is-link is-depth" data-id="${exp.id}">释义 · 名词解释` +
                  `<span class="depth-tag">第5层</span></button>`;
        }
        sh += `<button class="kg-subnode is-home">⌂ 知识节点面板</button>`;
        details.forEach(x => {
            const m2 = DT_META[x.detail_type] || DT_META.case;
            const cur2 = x.id === node.id;
            sh += `<button class="kg-subnode is-link${cur2 ? ' is-cur' : ''}" data-id="${x.id}"` +
                  ` title="${escapeHtml((x.content || '').slice(0, 120))}">${m2.label} · ${escapeHtml(x.name || '')}</button>`;
        });
        if (!isExpl && !details.length) sh += '<span class="kg-subnode is-empty">暂无同层内容</span>';
        snEl.innerHTML = sh;
        snEl.querySelectorAll('.kg-subnode').forEach(btn => {
            if (btn.classList.contains('is-home')) btn.addEventListener('click', () => enterMicro(mi.id));
            else if (btn.classList.contains('is-link') && !btn.classList.contains('is-cur')) {
                btn.addEventListener('click', () => openNodeById(btn.dataset.id));
            }
        });

        renderRelList(mi);
        pulseNode(node.id);
        detailEl.classList.add('show');
        syncDetailToggle();
    }
    function showDetailNode(d, mi) { showContentDetail(d, mi); }
    function showExplanationDetail(exp, mi) { showContentDetail(exp, mi); }

    function hideDetail() {
        if (detailEl) detailEl.classList.remove('show');
        syncDetailToggle();
    }
    /* 顶栏「详情」按钮的点亮态跟随面板开合 */
    function syncDetailToggle() {
        const tgl = document.getElementById('kgDetailToggle');
        if (tgl) tgl.classList.toggle('is-on', !!(detailEl && detailEl.classList.contains('show')));
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

    /* 跳转到任意节点（供详情联动 / 搜索 / 助手）—— 六层自动分流 */
    function jumpToMicro(id) {
        return openNodeById(id);
    }

    /* 关键词 / 名称 / 节点对象 → 节点（助手与课程星系可能传 id，也可能传名字或对象）
       顺序：对象取 id → id 精确 → 名称精确（全层） → 去掉「-解释 / 的解释」后缀再试
             → 名称包含兜底。
       ★ L5 名词解释节点的名字是「<知识点>的解释」，名称精确匹配放在去后缀之前，
         这样助手引用 L5 时能命中释义节点本身（高亮 / 下潜都正确）。 */
    function resolveNode(key) {
        if (key == null || !state.idx) return null;
        const idx = state.idx;

        /* 传对象：优先 id，其次 name / label / title */
        if (typeof key === 'object') {
            if (key.id != null) {
                const byIdHit = idx.byId.get(String(key.id));
                if (byIdHit) return byIdHit;
            }
            key = key.name || key.label || key.title || '';
        }

        const k = String(key).trim();
        if (!k) return null;

        let n = idx.byId.get(k);
        if (n) return n;

        /* 名称精确：宏 → 中 → 微 → 释义 → 深层内容 */
        const pools = [idx.macros, idx.mesos, idx.micros, idx.explanations, idx.details];
        for (const arr of pools) {
            const f = arr.find(m => m.name === k);
            if (f) return f;
        }

        /* L5 名称后缀不稳：v12 是「货币职能的解释」，老包是「货币职能-解释」，
           统一剥掉「(的)解释」再试一次 */
        const bare = k.replace(/[-—·\s]*的?解释?$/, '').trim();
        if (bare && bare !== k) {
            n = idx.byId.get(bare);
            if (n) return n;
            for (const arr of pools) {
                const f = arr.find(m => m.name === bare);
                if (f) return f;
            }
        }

        /* 名称包含兜底（知识点 → 释义 → 深层内容） */
        const soft = [idx.micros, idx.explanations, idx.details, idx.mesos, idx.macros];
        for (const arr of soft) {
            const f = arr.find(m => m.name && m.name.indexOf(k) >= 0);
            if (f) return f;
        }
        return null;
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
                kw: keywordsOf(m).join(' '),
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
       对外兼容 API（与旧 GalaxyEngine 一致，知识助手 / 课程星系照常联动）
       约定（详见《对接文档》）：clickNode / selectNode / pulseNodes /
       focusOnNodes / switchGraph / goMacro / state.nodes / state.graphId
       —— 这层壳不要拆：换引擎内部实现可以，壳要保持。
       六层都支持：domain / macro / meso / micro / explanation / detail
    ============================================================ */
    /* 高亮一组节点：当前层画得出来就直接脉冲，画不出来先跳到它所在的层 */
    function pulseResolved(nodes) {
        const set = new Set(nodes.map(n => n.id));
        /* 命中知识点时，把它在「知识节点层」的释义节点一并点亮
           （助手答案常引用 kp_l4_* 释义节点，这里保证"点了有反应"） */
        nodes.forEach(n => {
            if (n.level === 'micro') {
                const exp = state.idx.expNodeOfMicro.get(n.id);
                if (exp) set.add(exp.id);
            }
        });
        const drawn = gNodes.selectAll('.kg-node').filter(function () {
            return set.has(this.dataset.id);
        });
        if (drawn.empty()) openNodeById(nodes[0].id);
        gNodes.selectAll('.kg-node').classed('kg-pulse', function () {
            return set.has(this.dataset.id);
        });
        clearTimeout(state._pulseTimer);
        state._pulseTimer = setTimeout(() => {
            gNodes.selectAll('.kg-node').classed('kg-pulse', false);
        }, 3000);
    }

    window.GalaxyEngine = {
        init,
        load,
        /* 课程星系 / 助手：按 id 或名称定位，按层级自动分流 */
        clickNode(idOrName) {
            if (!state.loaded) return;
            const n = resolveNode(idOrName);
            if (n) { openNodeById(n.id); return; }
            this.selectNode(idOrName);
        },
        selectNode(idOrName) {
            if (!state.loaded) return;
            const n = resolveNode(idOrName);
            if (!n) return;
            const drawn = nodeG_byId(n.id);
            if (drawn.empty()) {
                openNodeById(n.id);
                pulseNode(n.id);
            } else if (n.level === 'micro') {
                showDetail(n); pulseNode(n.id);
            } else if (n.level === 'explanation') {
                showExplanationDetail(n, state.idx.byId.get(n.parent_id)); pulseNode(n.id);
            } else if (n.level === 'detail') {
                showDetailNode(n, state.idx.byId.get(state.idx.microOfDetail.get(n.id))); pulseNode(n.id);
            } else {
                pulseNode(n.id);
            }
        },
        pulseNodes(ids) {
            if (!state.loaded || !ids || !ids.length) return;
            const nodes = ids.map(resolveNode).filter(Boolean);
            if (nodes.length) pulseResolved(nodes);
        },
        focusOnNodes(ids, edges) {
            if (!state.loaded || !ids || !ids.length) return;
            const idx = state.idx;
            const nodes = ids.map(resolveNode).filter(Boolean);
            if (!nodes.length) return;
            /* 释义 / 深层内容节点归到它所属的知识点 */
            const microOf = n => n.level === 'micro' ? n.id
                : n.level === 'explanation' ? n.parent_id
                    : n.level === 'detail' ? (idx.microOfDetail.get(n.id) || n.parent_id || null)
                        : null;
            const microIds = nodes.map(microOf).filter(Boolean);
            if (!microIds.length) { openNodeById(nodes[0].id); return; }
            /* 聚到包含命中最多的主题 */
            const cnt = new Map();
            microIds.forEach(id => {
                const ms = idx.mesoOfMicro.get(id);
                if (ms) cnt.set(ms, (cnt.get(ms) || 0) + 1);
            });
            if (!cnt.size) { openNodeById(microIds[0]); return; }
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
            /* 画布永远显示统一知识星系（graphId = v12）；各课程图谱由「课程星系」
               自有引擎负责。这里只维护旧契约的状态位（currentGraphId），
               ★ 不动 state.graphId —— 它必须恒等于画布此刻显示的那张图。 */
            const id = gid || 'econ';
            if (id === state.currentGraphId) return Promise.resolve(state.loaded);
            state.currentGraphId = id;
            if (state.loaded && id !== 'econ' && id !== 'invest' && id !== GRAPH_ID) {
                const name = { corp_fin: '公司金融', intl_inv: '国际投资学', ma: '并购与重组' }[id] || id;
                showKgToast('「' + name + '」课程图谱数据接入中，当前展示统一知识星系');
            }
            return Promise.resolve(state.loaded);
        },
        get graphId() { return state.graphId; },
        goMacro: goOverview,
        goUp,                       /* 返回上一层（六层通用） */
        get state() { return state; }
    };

    /* 兼容旧引擎的 state.nodes：course-galaxy.js 用它按 id 找节点、读 label */
    Object.defineProperty(state, 'nodes', {
        get() { return (state.data && state.data.nodes) || []; },
        enumerable: true, configurable: true
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
