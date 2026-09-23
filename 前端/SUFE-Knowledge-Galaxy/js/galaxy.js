/* ============================================================
   知识星系 · 雷达环图谱渲染引擎
   依赖：d3 v7（本地 js/d3.min.js，缺失时自动补加载 CDN）

   ★ 字段契约（一切以后端为准，不做映射）：
       节点：{ id, label, type, page, source_books, media? }
       边：  { source, target, relation }
       type ∈ { chapter, section, concept, formula }

   ★ 本次修复（节点/连线/文字全部重叠 Bug）：
       ① layoutGalaxy 重写为「自适应多环带状布局」——
          1911 个节点（1600 个叶子）不再被压在单一圆环上互相叠盖
       ② 标签显隐改为按「缩放层级 + 节点类型」控制，
          并补上此前缺失的 .hidden CSS 规则（旧规则 .zoom-meso.other
          里的 other 类 JS 从未添加过，导致全部标签常显叠加）
       ③ 2896 条边的「关系文字」仅微观层 / 高亮 / 路径时显示
       ④ micro 标签放大到 1.4× 后才显示；mergeGraph 每次合并后
          确定性重排（后端增量返回节点也能正确落位）
============================================================ */
(function () {
    'use strict';

    /* ------------------------------------------------------------
       配置
    ------------------------------------------------------------ */
    const API_BASE = 'http://localhost:8000';
    const D3_CDNS = [
        'https://cdn.jsdelivr.net/npm/d3@7',
        'https://unpkg.com/d3@7/dist/d3.min.js',
        'https://cdn.bootcdn.net/ajax/libs/d3/7.9.0/d3.min.js',
        'https://lib.baomitu.com/d3/7.9.0/d3.min.js'
    ];

    const GRAPH_BASE_PATH = '';

    const GRAPH_SOURCES = {
        'econ':     'galaxy.json',
        'corp_fin': '公司金融_知识图谱.json',
        'intl_inv': '国际投资学_知识图谱.json',
        'ma':       '并购与重组_知识图谱.json',
        'invest':   '投资学_知识图谱.json'
    };

    // （旧 RING_RADIUS / ringOf 半径表已删除：与新布局脱节，
    //   是标签显隐失效、标签全部叠在一起的根源之一）
    const ZOOM_BOUNDS  = { macroMax: 0.4, mesoMax: 0.8 };
    const SCALE_MIN    = 0.28;
    const SCALE_MAX    = 2.0;
    const SCALE_DEFAULT= 0.55;   // 图谱外半径较大，默认稍微缩小保证首屏可读

    function zoomLevelOf(s) {
        if (s <= ZOOM_BOUNDS.macroMax) return 'macro';
        if (s <= ZOOM_BOUNDS.mesoMax)  return 'meso';
        return 'micro';
    }
    const ZOOM_LABEL = {
        macro: '宏观总览层',
        meso:  '中观脉络层',
        micro: '微观聚焦层'
    };

    // 各缩放层级下显示文字标签的节点类型
    // ★ micro 标签默认不渲染（密排时文字互相压盖），悬停/点击节点时由 CSS 单独亮出
    const LABEL_LEVELS = {
        macro: ['domain', 'macro'],
        meso:  ['domain', 'macro', 'meso'],
        micro: ['domain', 'macro', 'meso']
    };

    const CULL = {
        ENABLED:         true,
        BUFFER:          0.35,
        REBIND_THROTTLE: 90,
        TICK_THROTTLE:   24
    };

    /* ------------------------------------------------------------
       状态
    ------------------------------------------------------------ */
    const state = {
        sessionId:      null,
        currentGraphId: 'econ',
        nodes:          [],
        edges:          [],
        visibleIds:     new Set(),
        focusedId:      null,
        highlightedIds: new Set(),

        translateX: 0,
        translateY: 0,
        scale:      SCALE_DEFAULT,
        rotation:   0,
        zoomLevel:  'meso',

        dragging:        false,
        dragMode:        null,
        dragStartX:      0,
        dragStartY:      0,
        dragStartTX:     0,
        dragStartTY:     0,
        dragStartRot:    0,

        selectedIds: [],
        activePath:  null,

        timelineEnabled: false,
        timelineMin:     0,
        timelineMax:     0,
        timelineValue:   null,

        immersive:  false,
        roaming:    false,
        roamAbort:  false
    };

    /* ★ 回归红线②（2026-09-20）：assistant.js / 外部脚本历史上按 state.graphId 读取当前图谱，
       场次迁移后本模块内部统一用 currentGraphId。这里加一层别名，两个名字读写同一份值，
       避免旧调用方拿到 undefined。 */
    Object.defineProperty(state, 'graphId', {
        get()      { return this.currentGraphId; },
        set(v)     { this.currentGraphId = v; },
        enumerable: true,
        configurable: true
    });

    let stage, svg, gRoot, gLinks, gLinkLabels, gNodes;
    let tooltipEl, nodePopupEl;
    
    let toastTimer = null;
    let inited = false;
    let timelineInited = false;

    let lastCullAt = 0;
    let cullScheduled = false;
    let lastTickAt = 0;

    /* ------------------------------------------------------------
       工具
    ------------------------------------------------------------ */
    const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms || 0)));

    function showToast(msg) {
        const el = document.getElementById('galaxyToast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
    }

    function setLoading(on) {
        const el = document.getElementById('galaxyLoading');
        if (el) el.classList.toggle('show', !!on);
    }

    async function api(path, body) {
        const res = await fetch(API_BASE + path, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body || {})
        });
        return res.json();
    }

    /* ------------------------------------------------------------
       数据辅助（直接使用后端字段，不做映射）
    ------------------------------------------------------------ */
    const srcId   = e => (e.source && typeof e.source === 'object') ? e.source.id : e.source;
    const tgtId   = e => (e.target && typeof e.target === 'object') ? e.target.id : e.target;
    const edgeKey = e => `${srcId(e)}|${tgtId(e)}|${e.relation || ''}`;

    function classOf(node) {
        switch (node.type) {
            case 'domain': return 'lvl-domain';
            case 'macro':  return 'lvl-macro';
            case 'meso':   return 'lvl-meso';
            case 'micro':  return 'lvl-micro';
            default:       return 'lvl-micro';
        }
    }

    // 后端未下发 polarity；用 relation 文本推断（仅渲染用途）
    function edgePolarity(e) {
        const rel = String(e.relation || '').toLowerCase();
        if (/抑制|负|阻碍|减弱|降低|削弱/.test(rel)) return 'inhibit';
        if (/促进|正|增强|提高|推动/.test(rel))       return 'promote';
        return 'neutral';
    }

    function getNodeYear(node) {
        if (node.year != null) return +node.year;
        if (node.media && node.media.year != null) return +node.media.year;
        return null;
    }
    function fallbackYear(node) {
        const s = String(node.id) + String(node.label || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return 2010 + (h % 15);
    }

    function resolveEdges() {
        const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
        state.edges.forEach(e => {
            const s = nodeMap.get(srcId(e));
            const t = nodeMap.get(tgtId(e));
            if (s) e.source = s;
            if (t) e.target = t;
        });
    }

    /** 直接使用后端原始结构（不映射字段） */
    function mergeGraph(data, reset) {
        if (!data || !data.nodes) return;

        // 节点/边集合可能变化 → 度缓存失效
        state._degree = null;
        state._typeOf = null;

        if (reset) {
            state.nodes = [];
            state.edges = [];
            state.visibleIds = new Set();
            state.selectedIds = [];
            state.activePath = null;
            state.highlightedIds.clear();
            state.focusedId = null;
        }

        // ★ 2026-09-20：后端把层级放在 extra 里（extra.parents / extra.source_books），
        //   顶层没有 domain / parent_id，这里做回退读取。
        //   - extra.parents      = 父节点 id 列表（数组，取第一个即可）
        //   - extra.source_books = 来源书目（只有「经济综合」图有）
        function backendParent(raw) {
            const ps = raw && raw.extra && raw.extra.parents;
            return (ps && ps.length) ? String(ps[0]) : null;
        }
        function backendDomain(raw) {
            const sb = raw && raw.extra && raw.extra.source_books;
            return (sb && sb.length)
                ? String(sb[0]).replace(/_知识图谱\.json$/, '')
                : '';
        }

        // ★ 回归红线④（2026-09-20）：后端会给概念打质量标记（quality=low 表示
        //   抽取质量偏低的概念，经济综合图里约 672 个）。这类节点默认隐藏标签，
        //   但节点本体仍然保留可点击 —— 只降噪，不删数据。
        //   读取顺序：extra.quality → 顶层 quality（兼容旧 JSON）。
        function qualityOf(raw) {
            if (!raw) return '';
            const q = (raw.extra && raw.extra.quality) ?? raw.quality;
            return q == null ? '' : String(q).toLowerCase();
        }

        // 后端字段 → 前端节点对象（唯一转换点，函数内部使用）
        // ★ 双端字段兼容：
        //   label/name、level/layer 两组字段名都要认，否则换后端数据后
        //   标签会全空、所有节点会被判成 micro（2026-09-20 实测确认）
        function toNode(raw) {
            return {
                id:            String(raw.id),
                label:         raw.name          ?? raw.label ?? '',
                type:          raw.level         ?? raw.layer ?? 'micro',
                domain:        raw.domain        ?? backendDomain(raw),
                parent_id:     raw.parent_id     ?? backendParent(raw),
                domains:       raw.domains       ?? [],
                courses:       raw.courses       ?? [],
                description:   raw.description   ?? '',
                media:         raw.media         ?? null,
                tags:          raw.tags          ?? null,
                teaching_case: raw.teaching_case ?? null,
                quality:       qualityOf(raw),
                x:             typeof raw.x === 'number' ? raw.x : 0,
                y:             typeof raw.y === 'number' ? raw.y : 0,
                _visible:      true
            };
        }

        const nodeMap = new Map(state.nodes.map(n => [n.id, n]));
        data.nodes.forEach(raw => {
            if (!raw || !raw.id) return;
            const id  = String(raw.id);
            const old = nodeMap.get(id);
            const nv  = toNode(raw);
            if (old) {
                // 保留旧的坐标与可见状态，其余字段刷新
                nv.x = typeof raw.x === 'number' ? raw.x : old.x;
                nv.y = typeof raw.y === 'number' ? raw.y : old.y;
                nv._visible = old._visible;
                Object.assign(old, nv);
            } else {
                nodeMap.set(id, nv);
            }
        });
        state.nodes = Array.from(nodeMap.values());

        const edgeMap = new Map(state.edges.map(e => [edgeKey(e), e]));
        (data.edges || []).forEach(raw => {
            if (!raw || !raw.source || !raw.target) return;
            const e = { source: String(raw.source), target: String(raw.target), relation: raw.relation || '' };
            const k = edgeKey(e);
            if (!edgeMap.has(k)) edgeMap.set(k, e);
        });
        state.edges = Array.from(edgeMap.values());

        state.visibleIds = new Set(data.nodes.map(n => String(n.id)));

        // ★ 2026-09-20：补「书 / 域」这一层合成根节点。
        //   新版 layoutGalaxy() 是四层放射布局（domain → macro → meso → micro），
        //   它把「没有 parent_id 的节点」当根。后端数据顶层只有「章」，
        //   若直接当根 → roots 变成几十个，宏环半径按根数放大，整图散到看不见。
        //   补一层根后：econ 得到 4 个（4 本书），单本书图得到 1 个。
        //   同时必须同步 visibleIds，否则合成节点会被 render() 判为不可见而变灰。
        const SYNTH_DOMAIN_PREFIX = '__domain__';
        const hasDomainLevel = state.nodes.some(n => n.type === 'domain');
        if (!hasDomainLevel) {
            const topNodes = state.nodes.filter(n => !n.parent_id);
            const groups = new Map();
            topNodes.forEach(n => {
                // 没有 source_books 的图（投资学 / 公司金融 / 国际投资学 / 并购与重组）
                // 全部归到同一个根，根名用后端给的图标题
                const key = n.domain || (data.title || '全部');
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(n);
            });
            const synth = [];
            groups.forEach((members, key) => {
                const sid = SYNTH_DOMAIN_PREFIX + key;
                synth.push({
                    id: sid, label: key, type: 'domain', domain: key,
                    parent_id: null, domains: [], courses: [],
                    description: '', media: null, tags: null, teaching_case: null,
                    x: 0, y: 0, _visible: true, _synthetic: true
                });
                members.forEach(n => { n.parent_id = sid; });
            });
            if (synth.length) {
                state.nodes = [...synth, ...state.nodes];
                synth.forEach(n => state.visibleIds.add(n.id));
                // 节点集合变了 → 类型/度缓存必须失效
                state._typeOf = null;
                state._degree = null;
            }
        }

        const idSet = new Set(state.nodes.map(n => n.id));
        state.selectedIds = state.selectedIds.filter(id => idSet.has(id));
        if (state.activePath) {
            state.activePath = state.activePath.filter(id => idSet.has(id));
            if (state.activePath.length < 2) state.activePath = null;
        }

        if (!timelineInited) { timelineInited = true; setupTimeline(); }
        state.nodes.forEach(n => { n._visible = true; });

        // ★ 布局是确定性的：每次合并后整体重算。
        //   已有节点坐标不变，后端增量返回的新节点也能自动正确落位
        //   （旧逻辑只在 reset 时布局，增量节点全部堆在原点 (0,0)）
        layoutGalaxy();
    }
    function degreeOf(id) {
        // 度缓存：1911 节点 × 2896 边逐次重算太慢，一次构建 O(E)
        if (!state._degree) {
            const m = new Map();
            state.edges.forEach(e => {
                const s = srcId(e), t = tgtId(e);
                m.set(s, (m.get(s) || 0) + 1);
                m.set(t, (m.get(t) || 0) + 1);
            });
            state._degree = m;
        }
        return state._degree.get(id) || 0;
    }
    function typeOf(id) {
        // 类型缓存：渲染时按边批量查类型，避免每次线性扫描
        if (!state._typeOf) {
            const m = new Map();
            state.nodes.forEach(n => m.set(n.id, n.type || 'micro'));
            state._typeOf = m;
        }
        return state._typeOf.get(id);
    }

    function shortName(label) {
        if (!label) return '';
        return label.length <= 4 ? label : label.slice(0, 4);
    }

    /* ------------------------------------------------------------
       视野裁剪
    ------------------------------------------------------------ */
    function scheduleCull() {
        if (!CULL.ENABLED || cullScheduled) return;
        const now = performance.now();
        if (now - lastCullAt < CULL.REBIND_THROTTLE) return;
        cullScheduled = true;
        requestAnimationFrame(() => {
            cullScheduled = false;
            lastCullAt = performance.now();
            applyCulling();
        });
    }

    function applyCulling() {
        if (!CULL.ENABLED || !svg || !gRoot || !state.nodes.length) return;

        const rect = svg.node().getBoundingClientRect();
        const W = rect.width, H = rect.height;
        if (W < 4 || H < 4) return;

        const cx = W / 2, cy = H / 2;
        const scale = state.scale;
        const rot = state.rotation * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const tx = cx + state.translateX;
        const ty = cy + state.translateY;

        const bufW = W * CULL.BUFFER;
        const bufH = H * CULL.BUFFER;
        const minX = -bufW, maxX = W + bufW;
        const minY = -bufH, maxY = H + bufH;

        let changed = 0;
        for (let i = 0, len = state.nodes.length; i < len; i++) {
            const n = state.nodes[i];
            const wx = n.x || 0, wy = n.y || 0;
            const rx = wx * cos - wy * sin;
            const ry = wx * sin + wy * cos;
            const sx = rx * scale + tx;
            const sy = ry * scale + ty;
            const vis = (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY);
            if (n._visible !== vis) { n._visible = vis; changed++; }
        }

        if (changed === 0) return;
        renderActive();
    }

    /* ------------------------------------------------------------
       渲染
    ------------------------------------------------------------ */
    function getActiveNodes() {
        if (!CULL.ENABLED) return state.nodes;
        return state.nodes.filter(n => n._visible);
    }

    /**
     * ★ 修复 Bug 1：边保留条件由「两端都可见」改成「至少一端可见」。
     *   超出视野那一端交给 SVG 自然裁剪，视觉上相当于线延伸出屏幕。
     */
    function getActiveEdges(activeIds) {
        if (!CULL.ENABLED) return state.edges;
        const ids = activeIds || new Set(getActiveNodes().map(n => n.id));
        return state.edges.filter(e => ids.has(srcId(e)) || ids.has(tgtId(e)));
    }

    function render() {
        if (!gRoot) return;
        resolveEdges();
        renderActive();
        syncStageFocusClass();
        updateStaticLayout();
    }

    function renderActive() {
        if (!gRoot) return;

        const lvl = state.zoomLevel;
        const activeNodes = getActiveNodes();
        const activeIds = new Set(activeNodes.map(n => n.id));
        const activeEdges = getActiveEdges(activeIds);

        /* ---- 节点 ---- */
        const sel = gNodes.selectAll('.g-node').data(activeNodes, d => d.id);
        sel.exit().remove();

        const enter = sel.enter()
            .append('g')
            .style('cursor', 'pointer')
            .on('click', (evt, d) => { evt.stopPropagation(); handleNodeClick(d.id, evt); })
            .on('dblclick', (evt, d) => { evt.stopPropagation(); showNodePopup(d); })
            .on('mouseenter', (evt, d) => { showTooltip(evt, d); highlightNeighbors(d.id); })
            .on('mousemove', moveTooltip)
            .on('mouseleave', () => { hideTooltip(); clearNeighborHighlight(); })
            .on('contextmenu', e => e.preventDefault());

        enter.append('circle').attr('r', 0);
        enter.append('text').attr('class', 'g-label');

        const merged = enter.merge(sel);

        merged.attr('class', d => {
            let c = `g-node ${classOf(d)} zoom-${lvl}`;
            if (!state.visibleIds.has(d.id))         c += ' faded';
            if (state.focusedId === d.id)            c += ' focused';
            if (state.highlightedIds.has(d.id))      c += ' highlighted';
            if (state.selectedIds.includes(d.id))    c += ' selected';
            if (state.activePath && state.activePath.includes(d.id))
                                                     c += ' path-node';
            if (state.timelineEnabled && state.timelineValue != null) {
                const y = getNodeYear(d) ?? d._year ?? null;
                if (y != null && y > state.timelineValue) c += ' time-faded';
            }
            return c;
        });

        merged.select('circle')
            .transition().duration(320)
            .attr('r', visualRadius);

        merged.select('text')
            .attr('class', d => {
                let cls = 'g-label';
                if (d.type === 'domain' || d.type === 'macro') cls += ' ring-core';
                // 按缩放层级决定可见类型（旧逻辑用的 RING_RADIUS 已与新布局脱节）
                const allowed = LABEL_LEVELS[lvl] || LABEL_LEVELS.micro;
                if (!allowed.includes(d.type)) cls += ' hidden';
                // ★ 回归红线④：低质量抽取的概念标签默认隐藏（节点仍可点击）
                if (d.quality === 'low') cls += ' low-q';
                return cls;
            })
            .text(d => lvl === 'macro' ? shortName(d.label) : d.label)
            .attr('dy', d => nodeBaseR(d) + 14);
        merged.attr('data-domain', d => d.domain || '');
        merged.attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
        /* ---- 连线 ---- */
        const lsel = gLinks.selectAll('.g-link').data(activeEdges, edgeKey);
        lsel.exit().remove();
        lsel.enter().append('path').attr('class', 'g-link');

    
        // ★ 直线连接（星座风）
        gLinks.selectAll('.g-link')
            .attr('class', e => {
                    const s = srcId(e), t = tgtId(e);
                    let c = 'g-link';
                    // ★ 两端都是微观节点的连线默认淡化（微观间连线占大头，
                    //   全部实显会糊成乱麻；悬停/选中/路径时由 CSS 恢复显示）
                    if (typeOf(s) === 'micro' && typeOf(t) === 'micro') c += ' sub';
                    if (lvl !== 'macro') {
                        const p = edgePolarity(e);
                        if (p === 'promote') c += ' promote';
                        else if (p === 'inhibit') c += ' inhibit';
                    }
                    if (state.highlightedIds.has(s) || state.highlightedIds.has(t))
                        c += ' highlighted';
                    if (!state.visibleIds.has(s) || !state.visibleIds.has(t))
                        c += ' faded';
                    if (state.activePath && isPathEdge(s, t))
                        c += ' path-active path-flow';
                    if (state.timelineEnabled && state.timelineValue != null) {
                        const sn = state.nodes.find(n => n.id === s);
                        const tn = state.nodes.find(n => n.id === t);
                        const sy = sn ? (getNodeYear(sn) ?? sn._year) : null;
                        const ty = tn ? (getNodeYear(tn) ?? tn._year) : null;
                        if ((sy != null && sy > state.timelineValue) ||
                            (ty != null && ty > state.timelineValue)) {
                            c += ' time-faded';
                        }
                    }
                    return c;
                })
            
                /* ---- 关系标签（只创建「当前确实需要显示」的，避免常驻 DOM） ----
                   ★ 2026-09-20：原先对全部 activeEdges 建 <text> 再靠 CSS 藏，
                     econ 7718 条边 → 7718 个常驻 SVG 元素（占总量 34%），是卡顿主因。
                     改为 data join 前先过滤：只有「高倍微观层」或
                     「两端同时高亮 / 位于当前路径上」才真正创建标签节点。        */
        const labelsNeeded = activeEdges.filter(e => {
            const s = srcId(e), t = tgtId(e);
            if (lvl === 'micro') return true;
            const bothHi = state.highlightedIds.has(s) && state.highlightedIds.has(t);
            const onPath = state.activePath && isPathEdge(s, t);
            return !!(bothHi || onPath);
        });
        const lls = gLinkLabels.selectAll('.g-link-label').data(labelsNeeded, edgeKey);
        lls.exit().remove();
        lls.enter().append('text').attr('class', 'g-link-label');

        gLinkLabels.selectAll('.g-link-label')
            .attr('class', e => {
                const s = srcId(e), t = tgtId(e);
                const bothVisible = state.visibleIds.has(s) && state.visibleIds.has(t);
                return 'g-link-label' + (bothVisible ? '' : ' faded');
            })
            .text(e => e.relation || '')
            .attr('x', e => {
                const s = e.source, t = e.target;
                if (!s || !t || typeof s !== 'object' || typeof t !== 'object') return 0;
                return ((s.x || 0) + (t.x || 0)) / 2;
            })
            .attr('y', e => {
                const s = e.source, t = e.target;
                if (!s || !t || typeof s !== 'object' || typeof t !== 'object') return 0;
                return ((s.y || 0) + (t.y || 0)) / 2;
            });

    }

    function syncStageFocusClass() {
        if (!stage) return;
        const has = !!(state.focusedId ||
                    state.highlightedIds.size ||
                    (state.activePath && state.activePath.length));
        stage.classList.toggle('has-focus', has);
    }

    function isPathEdge(a, b) {
        const p = state.activePath;
        if (!p || p.length < 2) return false;
        for (let i = 0; i < p.length - 1; i++) {
            const x = p[i], y = p[i + 1];
            if ((x === a && y === b) || (x === b && y === a)) return true;
        }
        return false;
    }

    /* ============================================================
    分层放射布局 v2 —— 自适应多环带状布局
    ------------------------------------------------------------
    旧版把每层节点压在固定单一圆环上（micro 环 r=660），
    1600 个叶子节点每点只分到 ~2.6px 弧长（节点直径 13~25px），
    全部叠死、文字糊成一团。

    新版：
      ① domain 根节点均匀分布在内环，每个 domain 占一个扇区；
      ② macro 在扇区内的「宏环」上按子树规模分配角度，
         宏环半径按各域 macro 数量自适应，保证弧向间距；
      ③ meso / micro 以「楔形 + 多子环」带状铺开——
         环容量 = 楔形弧长 ÷ 节点间距，放不下就再起一环，
         任意两节点弧向间距 ≥ 设定 spacing，不再重叠。
    ============================================================ */
    const LEVEL_SIZE = { domain: 26, macro: 17, meso: 11, micro: 6.5, __default__: 6.5 };

    // 各层排布参数：spacing = 同环相邻节点的最小弧向间距
    const LAYOUT_SPACING  = { macro: 92, meso: 72, micro: 32 };
    const LAYOUT_RING_GAP = { meso: 70, micro: 38 };
    const DOMAIN_R        = 85;    // domain 内环半径
    const MACRO_RING_MIN  = 300;   // 宏环最小半径
    const BAND_PAD_RATIO  = 0.06;  // 楔形两侧留白比例，防止跨扇区贴边

    function layoutGalaxy() {
        const byId = new Map(state.nodes.map(n => [n.id, n]));
        const childrenOf = new Map();
        const roots = [];

        state.nodes.forEach(n => {
            const pid = n.parent_id;
            if (pid && byId.has(pid)) {
                if (!childrenOf.has(pid)) childrenOf.set(pid, []);
                childrenOf.get(pid).push(n);
            } else {
                roots.push(n);
            }
        });

        // 兜底：异常数据（无根 / 成环）→ 黄金角螺旋，保证不叠死
        if (!roots.length) {
            state.nodes.forEach((n, i) => {
                const a = i * 2.39996;
                const r = 66 * Math.sqrt(i + 1);
                n.x = r * Math.cos(a);
                n.y = r * Math.sin(a);
                n._depth = 3;
                n._angle = a;
            });
            return;
        }

        // 稳定排序，避免每次重排跳位
        childrenOf.forEach(arr =>
            arr.sort((a, b) => (a.label || '').localeCompare(b.label || ''))
        );

        // 叶子计数
        const leaf = new Map();
        function countLeaf(n) {
            if (leaf.has(n.id)) return leaf.get(n.id);
            const kids = childrenOf.get(n.id) || [];
            const c = kids.length ? kids.reduce((s, k) => s + countLeaf(k), 0) : 1;
            leaf.set(n.id, c);
            return c;
        }
        roots.forEach(countLeaf);

        const TWO_PI = Math.PI * 2;
        const sectorAll = TWO_PI / roots.length;

        // 宏环半径：保证扇区内相邻 macro 弧向间距 ≥ LAYOUT_SPACING.macro
        let rMacro = MACRO_RING_MIN;
        roots.forEach(r => {
            const cnt = Math.max(1, (childrenOf.get(r.id) || []).length);
            rMacro = Math.max(rMacro, cnt * LAYOUT_SPACING.macro / sectorAll);
        });
        rMacro = Math.round(rMacro);
        let maxR = rMacro;

        // 确定性散列（同一节点每次布局结果一致）
        function hash01(s) {
            let h = 0;
            for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
            return (h % 1000) / 1000;
        }

        /**
         * 带状放置：把 children 沿楔形 [a0,a1] 自 rStart 起逐环铺开。
         * 每环容量 = 楔形弧长 ÷ spacing，放不下自动再起一环。
         * 返回本带用到的最外环半径。
         */
        function placeBand(children, a0, a1, rStart, gap, spacing, depth) {
            const pad = Math.min(0.035, (a1 - a0) * BAND_PAD_RATIO);
            const s0 = a0 + pad, s1 = a1 - pad;
            let ring = 0, i = 0;
            while (i < children.length) {
                const r = rStart + ring * gap;
                const cap = Math.max(1, Math.floor((s1 - s0) * r / spacing));
                const take = Math.min(cap, children.length - i);
                for (let k = 0; k < take; k++) {
                    const n = children[i + k];
                    const t = take === 1 ? 0.5 : (k + 0.5) / take;
                    // 确定性角度抖动：一环只放 1 个时避免排成死板的直线
                    const j = (hash01(n.id) - 0.5) * Math.min(0.3, (s1 - s0) * 0.35);
                    const a = s0 + (s1 - s0) * t + j;
                    n.x = r * Math.cos(a);
                    n.y = r * Math.sin(a);
                    n._depth = depth;
                    n._angle = a;
                    if (r > maxR) maxR = r;
                }
                i += take;
                ring++;
            }
            return ring > 0 ? rStart + (ring - 1) * gap : rStart;
        }

        roots.forEach((root, ri) => {
            // ① domain：内环均匀分布
            const aMid = -Math.PI / 2 + sectorAll * (ri + 0.5);
            root.x = DOMAIN_R * Math.cos(aMid);
            root.y = DOMAIN_R * Math.sin(aMid);
            root._depth = 0;
            root._angle = aMid;

            const a0d = -Math.PI / 2 + sectorAll * ri;
            const macros = childrenOf.get(root.id) || [];
            // ★ 注意：countLeaf 接收节点对象（传 root.id 会算成 1，
            //   导致楔形角度暴涨、节点绕圆几百圈后随机叠在一起）
            const domLeaf = countLeaf(root) || 1;

            // ② macro：扇区内按子树叶子数分配角度，落在宏环上
            let cur = a0d;
            macros.forEach(m => {
                const span = sectorAll * (countLeaf(m) / domLeaf);
                const a = cur + span / 2;
                m.x = rMacro * Math.cos(a);
                m.y = rMacro * Math.sin(a);
                m._depth = 1;
                m._angle = a;

                const mesos = childrenOf.get(m.id) || [];
                const mLeaf = countLeaf(m) || 1;

                // ③ meso：在 macro 楔形内带状铺开
                let rMesoOuter = rMacro + 105;
                if (mesos.length) {
                    rMesoOuter = placeBand(mesos, cur, cur + span,
                        rMacro + 105, LAYOUT_RING_GAP.meso, LAYOUT_SPACING.meso, 2);
                }

                // ④ micro：该 macro 下全部 micro 后代按所属 meso 的
                //    楔形中心角排序，整体铺在 meso 带外侧（保持局部性）
                const micros = [];
                let w = cur;
                mesos.forEach(me => {
                    const ws = span * (countLeaf(me) / mLeaf);
                    const wCenter = w + ws / 2;
                    (childrenOf.get(me.id) || []).forEach(mi => {
                        mi._wedgeA = wCenter;
                        micros.push(mi);
                    });
                    w += ws;
                });
                if (micros.length) {
                    micros.sort((x, y) => x._wedgeA - y._wedgeA);
                    placeBand(micros, cur, cur + span,
                        rMesoOuter + 55, LAYOUT_RING_GAP.micro, LAYOUT_SPACING.micro, 3);
                }

                cur += span;
            });
        });

        // 兜底：任何未被放置的节点（层级缺失等）撒到最外环
        state.nodes.forEach(n => {
            if (n._depth == null) {
                const a = hash01(n.id) * TWO_PI;
                const r = maxR + 60 + hash01(n.id + '#') * 80;
                n.x = r * Math.cos(a);
                n.y = r * Math.sin(a);
                n._depth = 3;
                n._angle = a;
                if (r > maxR) maxR = r;
            }
        });

        // 碰撞松弛：网格哈希找近邻对，沿连线方向对称推开，
        // 消除楔形交界处微节点贴边的情况（确定性，几轮即收敛）
        (function relaxCollisions() {
            const MIN_D = 26, ITER = 8, cell = MIN_D;
            state.nodes.forEach((n, i) => { n._idx = i; });
            for (let it = 0; it < ITER; it++) {
                const grid = new Map();
                const gk = (x, y) => Math.floor(x / cell) + '_' + Math.floor(y / cell);
                state.nodes.forEach(n => {
                    const k = gk(n.x, n.y);
                    let b = grid.get(k);
                    if (!b) { b = []; grid.set(k, b); }
                    b.push(n);
                });
                state.nodes.forEach(n => {
                    const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            const bucket = grid.get((gx + dx) + '_' + (gy + dy));
                            if (!bucket) continue;
                            for (const o of bucket) {
                                if (o._idx <= n._idx) continue;   // 每对只处理一次
                                let ddx = n.x - o.x, ddy = n.y - o.y;
                                let d = Math.hypot(ddx, ddy);
                                if (d >= MIN_D) continue;
                                if (d < 1e-6) {                   // 完全重合：确定性微移
                                    ddx = hash01(n.id) - 0.5; ddy = hash01(o.id) - 0.5;
                                    d = Math.hypot(ddx, ddy) || 1;
                                }
                                const push = (MIN_D - d) / 2 + 0.05;
                                const ux = ddx / d, uy = ddy / d;
                                n.x += ux * push; n.y += uy * push;
                                o.x -= ux * push; o.y -= uy * push;
                            }
                        }
                    }
                });
            }
        })();

        maxR = state.nodes.reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y)), maxR);
        state._galaxyMaxR = maxR;
    }

    /* ============================================================
    节点半径（替代原 radiusOf / visualRadius）
    ============================================================ */
    function nodeBaseR(n) {
        const deg = degreeOf(n.id);
        const lvR = LEVEL_SIZE[n.type] ?? LEVEL_SIZE.__default__;
        return lvR + Math.min(deg, 8) * 0.8;
    }
    function visualRadius(n) {
        const base = nodeBaseR(n);
        const lvl = state.zoomLevel;
        if (lvl === 'macro') return base * 0.65;
        if (lvl === 'meso')  return base;
        return base * 1.15;
    }

    /* ============================================================
    展开动画 + 渲染
    ============================================================ */
    let _expandRAF = null;

        /* ------------------------------------------------------------
       静态布局同步（替代原力导向 ticked）
       ------------------------------------------------------------
       layoutGalaxy() 只负责给节点 x/y 赋值；
       本函数把这些坐标"写"进 SVG 的 d 属性 / transform，
       不再有任何物理抖动。
    ------------------------------------------------------------ */
    function updateStaticLayout() {
        if (!gLinks || !gNodes || !gLinkLabels) return;

        const getXY = ref => (ref && typeof ref === 'object')
            ? { x: ref.x || 0, y: ref.y || 0 } : { x: 0, y: 0 };

        // 边：直线连接（星座风）
        gLinks.selectAll('.g-link').each(function (e) {
            const s = getXY(e.source), t = getXY(e.target);
            e._path   = `M${s.x},${s.y} L${t.x},${t.y}`;
            e._labelX = (s.x + t.x) / 2;
            e._labelY = (s.y + t.y) / 2;
            this.setAttribute('d', e._path);
        });

        // 关系标签：居中
        gLinkLabels.selectAll('.g-link-label')
            .attr('x', e => e._labelX || 0)
            .attr('y', e => e._labelY || 0);

        // 节点：translate
        gNodes.selectAll('.g-node')
            .attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
    }

    function startExpandAnimation() {
        if (!gRoot || !gNodes) return;
        if (_expandRAF) cancelAnimationFrame(_expandRAF);

        // 起始态：所有节点缩到原点
        gNodes.selectAll('.g-node')
            .style('transition', 'none')
            .attr('transform', 'translate(0,0)')
            .style('opacity', 0);
        gNodes.selectAll('.g-node circle')
            .style('transition', 'none')
            .attr('r', 0);

        requestAnimationFrame(() => {
            const GROW = 1400;
            const STEP = 260;
            const EASE = 'cubic-bezier(.22,.9,.28,1)';

            gNodes.selectAll('.g-node')
                .style('transition', d =>
                    `transform ${GROW}ms ${EASE} ${(d._depth || 0) * STEP}ms, opacity 600ms ease ${(d._depth || 0) * STEP}ms`)
                .attr('transform', d => `translate(${d.x},${d.y})`)
                .style('opacity', 1);

            gNodes.selectAll('.g-node circle')
                .style('transition', d =>
                    `r ${GROW}ms ${EASE} ${(d._depth || 0) * STEP}ms`)
                .attr('r', visualRadius);

            // ★ 动画结束后清除全部内联样式：
            //   内联 opacity:1 会永久压住 CSS 的 .dimmed/.faded/.time-faded，
            //   内联 transition(带 0~780ms 延迟) 会让悬停变暗错峰拖影 → 闪频感
            setTimeout(() => {
                gNodes.selectAll('.g-node')
                    .style('transition', null)
                    .style('opacity', null);
                gNodes.selectAll('.g-node circle')
                    .style('transition', null);
            }, GROW + 4 * STEP + 120);
        });
    }

    
        /* ------------------------------------------------------------
       视图变换
    ------------------------------------------------------------ */
    function applyTransform() {
        if (!gRoot || !svg) return;
        const rect = svg.node().getBoundingClientRect();
        const cx = rect.width  / 2;
        const cy = rect.height / 2;

        gRoot.attr('transform',
            `translate(${cx + state.translateX},${cy + state.translateY}) ` +
            `scale(${state.scale}) ` +
            `rotate(${state.rotation})`);

        updateZoomLevelUI();
        scheduleCull();
    }

    function updateZoomLevelUI() {
        const pctEl = document.getElementById('galaxyZoomPct');
        if (pctEl) pctEl.textContent = Math.round(state.scale * 100) + '%';

        const lvl = zoomLevelOf(state.scale);
        const nameEl = document.getElementById('galaxyZoomName');
        if (nameEl) nameEl.textContent = ZOOM_LABEL[lvl];

        if (lvl === state.zoomLevel) return;
        state.zoomLevel = lvl;
        if (stage) stage.setAttribute('data-zoom-level', lvl);
        const page = stage && stage.closest('.galaxy-page');
        if (page) page.setAttribute('data-zoom-level', lvl);
        render();
    }

    function animateTo(targetScale, targetTX, targetTY, targetRot, duration) {
        return new Promise(resolve => {
            const startScale = state.scale;
            const startTX    = state.translateX;
            const startTY    = state.translateY;
            const startRot   = state.rotation;
            const t0  = performance.now();
            const dur = duration || 600;

            function step(t) {
                const p = Math.min(1, (t - t0) / dur);
                const e = 1 - Math.pow(1 - p, 3);

                state.scale      = startScale + (targetScale - startScale) * e;
                state.translateX = startTX    + (targetTX    - startTX)    * e;
                state.translateY = startTY    + (targetTY    - startTY)    * e;
                state.rotation   = startRot   + (targetRot   - startRot)   * e;

                applyTransform();
                if (p < 1) requestAnimationFrame(step);
                else resolve();
            }
            requestAnimationFrame(step);
        });
    }

    /* ------------------------------------------------------------
       交互
    ------------------------------------------------------------ */
    function setupInteraction() {
        const svgNode = svg.node();

        svgNode.addEventListener('contextmenu', e => e.preventDefault());
        svgNode.addEventListener('mousedown', e => {
            if (e.button === 2) { e.preventDefault(); e.stopPropagation(); }
        });

        svgNode.addEventListener('pointerdown', e => {
            if (e.target.closest && e.target.closest('.g-node')) return;

            const isRotate = e.button === 2 ||
                            (e.button === 0 && (e.shiftKey || e.altKey));
            const isPan    = e.button === 0 && !e.shiftKey && !e.altKey;

            if (isRotate) {
                e.preventDefault();
                e.stopPropagation();
                try { svgNode.setPointerCapture(e.pointerId); } catch (_) {}
                state.dragging     = true;
                state.dragMode     = 'rotate';
                state.dragStartX   = e.clientX;
                state.dragStartY   = e.clientY;
                state.dragStartRot = state.rotation;
                stage.classList.add('rotating');
            } else if (isPan) {
                state.dragging     = true;
                state.dragMode     = 'pan';
                state.dragStartX   = e.clientX;
                state.dragStartY   = e.clientY;
                state.dragStartTX  = state.translateX;
                state.dragStartTY  = state.translateY;
                stage.classList.add('dragging');
            }
        });

        window.addEventListener('pointermove', e => {
            if (!state.dragging) return;
            const dx = e.clientX - state.dragStartX;
            const dy = e.clientY - state.dragStartY;

            if (state.dragMode === 'pan') {
                state.translateX = state.dragStartTX + dx;
                state.translateY = state.dragStartTY + dy;
            } else if (state.dragMode === 'rotate') {
                state.rotation = state.dragStartRot + dx * 0.35;
            }
            applyTransform();
        });

        window.addEventListener('pointerup', () => {
            if (!state.dragging) return;
            state.dragging = false;
            state.dragMode = null;
            stage.classList.remove('dragging', 'rotating');
            scheduleCull();
        });

        svgNode.addEventListener('wheel', e => {
            e.preventDefault();
            const k = e.deltaY > 0 ? 0.94 : 1.06;
            const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, state.scale * k));
            if (next === state.scale) return;

            const ratio = next / state.scale;
            state.translateX *= ratio;
            state.translateY *= ratio;
            state.scale = next;
            applyTransform();
        }, { passive: false });

        svgNode.addEventListener('click', e => {
            if (e.target.closest && e.target.closest('.g-node')) return;
            if (state.selectedIds.length > 0 ||
                state.activePath ||
                state.focusedId ||
                state.highlightedIds.size) {
                state.selectedIds = [];
                state.activePath  = null;
                dismissPopup();          // ★ 统一清 focusedId + highlightedIds + hidePopup
            }
        });

        window.addEventListener('resize', () => { applyTransform(); scheduleCull(); });

        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;

            // ① 优先关卡片
            if (nodePopupEl && nodePopupEl.classList.contains('show')) {
                dismissPopup();
                return;
            }
            // ② 有聚焦/高亮 → 清选择
            if (state.focusedId || state.highlightedIds.size ||
                state.selectedIds.length || state.activePath) {
                state.selectedIds = [];
                state.activePath  = null;
                dismissPopup();
                return;
            }
            // ③ 最后退沉浸
            if (state.immersive) toggleImmersive();
        });
    }

    /* ------------------------------------------------------------
       Tooltip / Popup
    ------------------------------------------------------------ */
    function showTooltip(evt, d) {
        if (!tooltipEl) return;
        const text = d.description || '';
        if (!text) { hideTooltip(); return; }
        tooltipEl.innerHTML =
            `<div class="tt-title">${d.label}</div>` +
            `<div class="tt-body">${text}</div>`;
        tooltipEl.classList.add('show');
        moveTooltip(evt);
    }
    function moveTooltip(evt) {
        if (!tooltipEl || !tooltipEl.classList.contains('show')) return;
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        let x = evt.clientX - rect.left + 16;
        let y = evt.clientY - rect.top  + 16;
        const maxX = rect.width  - 280;
        const maxY = rect.height - 120;
        if (x > maxX) x = evt.clientX - rect.left - 280;
        if (y > maxY) y = evt.clientY - rect.top  - 130;
        tooltipEl.style.left = x + 'px';
        tooltipEl.style.top  = y + 'px';
    }
    function hideTooltip() {
        if (tooltipEl) tooltipEl.classList.remove('show');
    }

        function showNodePopup(node) {
            if (!nodePopupEl) return;
            const text = node.description || '（暂无说明）';

        const actionsHTML = window.ProfileUI
            ? `<div class="popup-actions">
                   ${window.ProfileUI.favoriteBtnHTML('node', node.id, { variant: 'text' })}
                   ${window.ProfileUI.noteBtnHTML('node', node.id, { variant: 'text' })}
               </div>`
            : '';

        nodePopupEl.innerHTML =
            `<div class="popup-title">${node.label}</div>` +
            `<div class="popup-body">${text}</div>` +
            actionsHTML;

        // 更新笔记弹窗副标题
        nodePopupEl.querySelectorAll('[data-pui-id]').forEach(b => {
            b.dataset.puiTitle = node.label;
        });

        nodePopupEl.classList.add('show');
        if (window.ProfileUI) {
            window.ProfileUI.bindAll(nodePopupEl);
        }
    }
    function hideNodePopup() {
        if (nodePopupEl) nodePopupEl.classList.remove('show');
    }
    /* ------------------------------------------------------------
    邻居高亮：hover 时相邻节点/边发光，无关节点降透明度
    ------------------------------------------------------------ */
    function highlightNeighbors(nodeId) {
        if (!gNodes || !gLinks) return;
        const ids = new Set([nodeId]);
        state.edges.forEach(e => {
            const s = srcId(e), t = tgtId(e);
            if (s === nodeId) ids.add(t);
            if (t === nodeId) ids.add(s);
        });
        gNodes.selectAll('.g-node')
            .classed('related', d => ids.has(d.id) && d.id !== nodeId)
            .classed('self-hover', d => d.id === nodeId)
            .classed('dimmed',  d => !ids.has(d.id));
        gLinks.selectAll('.g-link')
            .classed('related', e => srcId(e) === nodeId || tgtId(e) === nodeId)
            .classed('dimmed',  e => !(ids.has(srcId(e)) && ids.has(tgtId(e))));
    }
    function clearNeighborHighlight() {
        if (!gNodes || !gLinks) return;
        gNodes.selectAll('.g-node')
            .classed('related', false).classed('self-hover', false).classed('dimmed', false);
        gLinks.selectAll('.g-link')
            .classed('related', false).classed('dimmed', false);
    }

    /* ------------------------------------------------------------
    背景星点 + 星云（独立图层，不参与 D3 变换）
    ------------------------------------------------------------ */
    function initStars() {
        const cv = document.getElementById('galaxyStars');
        if (!cv || cv._inited) return;
        cv._inited = true;

        const dpr = window.devicePixelRatio || 1;
        const resize = () => {
            const r = cv.parentElement.getBoundingClientRect();
            cv.width  = r.width  * dpr;
            cv.height = r.height * dpr;
            cv.style.width  = r.width  + 'px';
            cv.style.height = r.height + 'px';
        };
        resize();

        const ctx = cv.getContext('2d');
        // ★ 深空星点风：更密的星场 + 少量带光晕的亮星（模仿参考视频星空）
        const stars = Array.from({ length: 300 }, () => ({
            x: Math.random() * cv.width,
            y: Math.random() * cv.height,
            r: (Math.random() * 1.1 + 0.25) * dpr,
            a: Math.random() * 0.55 + 0.15,
            tw: Math.random() * 6.28,          // 闪烁相位
            sp: Math.random() * 0.9 + 0.35,   // 闪烁速度
            big: Math.random() < 0.05          // 5% 亮星：本体 + 光晕
        }));

        let raf = null, t0 = performance.now();
        let running = false;
        function draw(t) {
            if (!running) return;
            const dt = (t - t0) / 1000;
            const isNight = stage.classList.contains('theme-night');
            ctx.clearRect(0, 0, cv.width, cv.height);
            for (const s of stars) {
                const a = s.a * (0.55 + 0.45 * Math.sin(s.tw + dt * s.sp));
                // 夜晚：淡蓝星光；白天：淡红细点（配合米白底）
                const color = isNight ? `200, 225, 255` : `129, 28, 33`;
                const alpha = isNight ? a : a * 0.30;
                if (s.big && isNight) {
                    // 亮星光晕：外圈低透明大圆（两笔 arc，无 filter 开销）
                    ctx.beginPath();
                    ctx.arc(s.x, s.y, s.r * 3.2, 0, 6.283);
                    ctx.fillStyle = `rgba(${color}, ${alpha * 0.22})`;
                    ctx.fill();
                }
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.big ? s.r * 1.6 : s.r, 0, 6.283);
                ctx.fillStyle = `rgba(${color}, ${alpha})`;
                ctx.fill();
            }
            raf = requestAnimationFrame(draw);
        }
        function startStars() {
            if (running) return;
            running = true;
            t0 = performance.now();
            raf = requestAnimationFrame(draw);
        }
        function stopStars() {
            running = false;
            if (raf) cancelAnimationFrame(raf);
        }
        // ★ 按需动画：板块不在视野 / 页签隐藏时暂停，减轻整体负载
        startStars();
        document.addEventListener('visibilitychange', () => {
            document.hidden ? stopStars() : startStars();
        });
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(entries => {
                entries.forEach(en => en.isIntersecting ? startStars() : stopStars());
            }).observe(cv.parentElement);
        }

        // 容器尺寸变化时重建
        window.addEventListener('resize', () => {
            cancelAnimationFrame(raf);
            resize();
            stars.forEach(s => { s.x = Math.random() * cv.width; s.y = Math.random() * cv.height; });
            raf = requestAnimationFrame(draw);
        });
    }

    /* ------------------------------------------------------------
    星图主题：仅作用于 .galaxy-stage，不污染全站
    ------------------------------------------------------------ */
    function setupGalaxyTheme() {
        const btn = document.getElementById('galaxyTheme');
        if (!btn || !stage) return;
        const KEY = 'sufe_galaxy_theme';
        const saved = localStorage.getItem(KEY) || 'night';

        const apply = (isNight) => {
            stage.classList.toggle('theme-night', isNight);
            // ★ 主题同步到整个星系板块（section + 子页面容器），不只是图谱舞台
            const page = stage.closest('.galaxy-page');
            if (page) page.classList.toggle('theme-night', isNight);
            const sec = stage.closest('.page-section');
            if (sec) sec.classList.toggle('theme-night', isNight);
            btn.classList.toggle('active', isNight);
            const txt = btn.querySelector('span:last-child');
            if (txt) txt.textContent = isNight ? '星图主题 · 深空' : '星图主题 · 浅色';
        };
        apply(saved === 'night');

        btn.addEventListener('click', () => {
            const next = !stage.classList.contains('theme-night');
            apply(next);
            localStorage.setItem(KEY, next ? 'night' : 'day');
        });
    }
        /* 为 popup 注入关闭按钮（幂等，只注入一次） */
    function ensurePopupCloseBtn() {
        if (!nodePopupEl) return;
        if (nodePopupEl.querySelector('.popup-close')) return;
        const btn = document.createElement('button');
        btn.className = 'popup-close';
        btn.setAttribute('aria-label', '关闭');
        btn.textContent = '×';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            hideNodePopup();          // 只关卡片，保留节点高亮
        });
        nodePopupEl.appendChild(btn);
    }

    /* 状态归零式关闭：卡片 + 聚焦 + 高亮一起清 */
    function dismissPopup() {
        hideNodePopup();
        if (state.focusedId || state.highlightedIds.size) {
            state.focusedId = null;
            state.highlightedIds.clear();
            render();
        }
    }

    /* ------------------------------------------------------------
       选择 & BFS
    ------------------------------------------------------------ */
    function toggleNodeSelection(nodeId) {
        const idx = state.selectedIds.indexOf(nodeId);
        if (idx >= 0) {
            state.selectedIds.splice(idx, 1);
        } else {
            if (state.selectedIds.length >= 2) state.selectedIds = [];
            state.selectedIds.push(nodeId);
        }

        if (state.selectedIds.length === 2) {
            const path = findPath(state.selectedIds[0], state.selectedIds[1]);
            if (!path) {
                showToast('这两个节点之间暂无关联路径');
                state.activePath = null;
            } else {
                state.activePath = path;
                showToast(`已找到路径：共 ${path.length} 个节点`);
            }
        } else {
            state.activePath = null;
        }
        render();
    }

    function findPath(a, b) {
        if (a === b) return [a];
        const adj = new Map();
        state.edges.forEach(e => {
            const s = srcId(e), t = tgtId(e);
            if (!adj.has(s)) adj.set(s, []);
            if (!adj.has(t)) adj.set(t, []);
            adj.get(s).push(t);
            adj.get(t).push(s);
        });
        const prev = new Map([[a, null]]);
        const q = [a];
        while (q.length) {
            const n = q.shift();
            if (n === b) break;
            const nb = adj.get(n) || [];
            for (const m of nb) {
                if (!prev.has(m)) { prev.set(m, n); q.push(m); }
            }
        }
        if (!prev.has(b)) return null;
        const path = [];
        let cur = b;
        while (cur != null) { path.unshift(cur); cur = prev.get(cur); }
        return path;
    }

    /* ------------------------------------------------------------
       ★ 修复 Bug 2：本地聚焦（无 sessionId 时的降级路径）
    ------------------------------------------------------------ */
    function localFocusNode(nodeId) {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // 1) 聚焦该节点
        state.focusedId = nodeId;

        // 2) 高亮 1 跳邻居（含自己）
        const neighbors = new Set([nodeId]);
        state.edges.forEach(e => {
            const s = srcId(e), t = tgtId(e);
            if (s === nodeId) neighbors.add(t);
            if (t === nodeId) neighbors.add(s);
        });
        state.highlightedIds = neighbors;

        // 3) 重渲染 + 弹 popup
        render();
        showNodePopup(node);
    }

    async function handleNodeClick(nodeId, evt) {
            // ★ 用户主动点击 → 停止漫游，避免漫游继续抢 popup
        if (state.roaming) {
            state.roamAbort = true;
            // 让漫游循环自己走完当前这一拍
        }

        // Ctrl / Cmd + 点击 → 双节点选择（原有）
        if (evt && (evt.ctrlKey || evt.metaKey)) {
            toggleNodeSelection(nodeId);
            return;
        }

        // ★ 合成节点（书/域层）不在后端图谱里 → 本地聚焦即可，不发请求
        if (String(nodeId).startsWith('__domain__')) { localFocusNode(nodeId); return; }

        // 有 sessionId → 走后端
        if (state.sessionId) {
            try {
                const r = await api('/api/graph/click', {
                    node_id:    nodeId,
                    session_id: state.sessionId,
                    graph_id:   state.currentGraphId      // ★ 后端 _require() 必填
                });
                await handleResponse(r);
                return;
            } catch (e) {
                console.warn('[galaxy] /api/graph/click 失败，降级到本地聚焦：', e);
            }
        }

        // 无 sessionId（本地 JSON 模式）→ 本地聚焦
        localFocusNode(nodeId);
    }

    /* ------------------------------------------------------------
       时间轴
    ------------------------------------------------------------ */
    function setupTimeline() {
        // 后端 galaxy.json 不提供 year 字段，时间轴关闭
        const wrap = document.getElementById('galaxyTimelineWrap');
        if (wrap) wrap.style.display = 'none';
        state.timelineEnabled = false;
        timelineInited = true;
        return;
    }
    /* ------------------------------------------------------------
       自动漫游
    ------------------------------------------------------------ */
    async function startRoam() {
        const btn = document.getElementById('galaxyRoam');

        if (state.roaming) { state.roamAbort = true; return; }
        if (!state.activePath || state.activePath.length < 2) {
            showToast('请先 Ctrl+点击 选中两个节点生成路径');
            return;
        }

        state.roaming = true;
        state.roamAbort = false;
        if (btn) {
            btn.classList.add('active');
            btn.querySelector('span:last-child').textContent = '停止漫游';
        }

        for (const id of state.activePath) {
            if (state.roamAbort) break;
            const node = state.nodes.find(n => n.id === id);
            if (!node) continue;

            await panToNode(node, 1.0, 700);
            showNodePopup(node);
            await sleep(1400);
            hideNodePopup();
        }
        hideNodePopup(); 
        state.roaming = false;
        if (btn) {
            btn.classList.remove('active');
            btn.querySelector('span:last-child').textContent = '自动漫游';
        }
    }

    function panToNode(node, scale, duration) {
        const s = scale || state.scale;
        const r = state.rotation * Math.PI / 180;
        const nx = node.x || 0, ny = node.y || 0;
        const rx = nx * Math.cos(r) - ny * Math.sin(r);
        const ry = nx * Math.sin(r) + ny * Math.cos(r);
        return animateTo(s, -s * rx, -s * ry, state.rotation, duration);
    }

    /* ------------------------------------------------------------
       宏观 / 心跳 / 证据
    ------------------------------------------------------------ */
    function goMacro() {
        state.selectedIds = [];
        state.activePath  = null;
        hideNodePopup();
        animateTo(0.32, 0, 0, 0, 900).then(() => render());
    }

    function pulseNodes(ids, duration) {
        if (!ids || !ids.length || !gNodes) return;
        const idSet = new Set(ids);
        gNodes.selectAll('.g-node').classed('pulse', d => idSet.has(d.id));
        setTimeout(() => {
            gNodes.selectAll('.g-node.pulse').classed('pulse', false);
        }, duration || 3200);
    }

    function focusOnNodes(ids, edges) {
        if (!ids || !ids.length || !gRoot || !svg) return;

        state.highlightedIds = new Set(ids);

        const targets = state.nodes.filter(n => ids.includes(n.id));
        if (!targets.length) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        targets.forEach(n => {
            const x = n.x || 0, y = n.y || 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        });
        const cxW = (minX + maxX) / 2;
        const cyW = (minY + maxY) / 2;

        const rect = svg.node().getBoundingClientRect();
        const spanX = Math.max(120, maxX - minX) + 240;
        const spanY = Math.max(120, maxY - minY) + 240;
        const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX,
            Math.min(rect.width / spanX, rect.height / spanY)));

        const tx = -scale * cxW;
        const ty = -scale * cyW;

        if (edges && edges.length) {
            state.selectedIds = [];
            const first = edges[0];
            state.activePath = (first && first.length >= 2) ? first.slice() : null;
        }

        state.focusedId = ids[0];
        animateTo(scale, tx, ty, 0, 900).then(() => render());
    }

    /* ------------------------------------------------------------
       沉浸模式
    ------------------------------------------------------------ */
    function toggleImmersive() {
        state.immersive = !state.immersive;
        document.body.classList.toggle('immersive', state.immersive);

        const btn = document.getElementById('galaxyImmersive');
        if (btn) {
            btn.classList.toggle('active', state.immersive);
            const t = btn.querySelector('span:last-child');
            if (t) t.textContent = state.immersive ? '退出沉浸' : '沉浸模式';
        }

        requestAnimationFrame(() => {
            applyTransform();
            
        });
    }

    /* ------------------------------------------------------------
       动作执行器
    ------------------------------------------------------------ */
    async function runActions(actions) {
        if (!Array.isArray(actions)) return;
        for (const act of actions) {
            const dur = (act.params && act.params.duration) || 400;
            switch (act.type) {
                case 'fade_in':
                    (act.targets || []).forEach(id => state.visibleIds.add(id));
                    render(); await sleep(dur); break;
                case 'fade_out':
                    (act.targets || []).forEach(id => state.visibleIds.delete(id));
                    render(); await sleep(dur); break;
                case 'focus':
                    state.focusedId = (act.targets && act.targets[0]) || null;
                    render(); await sleep(dur); break;
                case 'highlight':
                    (act.targets || []).forEach(id => state.highlightedIds.add(id));
                    render(); await sleep(dur); break;
                case 'zoom':
                    if (act.params && act.params.mode === 'fit') {
                        animateTo(SCALE_DEFAULT, 0, 0, state.rotation, 600);
                    }
                    await sleep((act.params && act.params.duration) || 600);
                    break;
                case 'text_popup':
                    if (act.params && act.params.text) {
                        showToast(`${act.params.title || '提示'}：${act.params.text}`);
                    }
                    await sleep(300); break;
                case 'expand':
                default:
                    await sleep(100);
            }
        }
    }

    /* ------------------------------------------------------------
       会话流程 & 五图切换
    ------------------------------------------------------------ */
    async function handleResponse(resp) {
        if (!resp) return;
        if (resp.session_id) state.sessionId = resp.session_id;
        if (resp.code !== 0) { showToast(resp.message || '请求失败'); return; }

        state.highlightedIds.clear();
        mergeGraph(resp.data, false);      // 直接用后端结构
        render();
        if (resp.actions?.some(a => a.type === 'fade_in')) startExpandAnimation();
        if (resp.degraded && resp.notice) showToast(resp.notice);
        await runActions(resp.actions);
    }

    async function loadGraphFromFile(graphId) {
        const file = GRAPH_SOURCES[graphId];
        if (!file) return null;
        const url = GRAPH_BASE_PATH + file;
        const res = await fetch(encodeURI(url));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();           // 直接返回原始结构
    }

    async function load() {
        setLoading(true);
        try {
            if (state.currentGraphId) {
                try {
                    const data = await loadGraphFromFile(state.currentGraphId);
                    if (data && data.nodes && data.nodes.length) {
                        mergeGraph(data, true);
                        render();
                        // ★ 从中心"炸开"的入场动画（1 次，之后完全静止）
                        startExpandAnimation();
                        return;
                    }
                } catch (e) {
                    console.warn('[galaxy] 本地图谱加载失败，回退后端：', e.message);
                }
            }

            const r = await api('/api/graph/load', {
                session_id: state.sessionId,
                graph_id:   state.currentGraphId
            });
            await handleResponse(r);
        } catch (e) {
            console.warn('加载图谱失败', e);
            showToast('加载图谱失败，请检查本地 JSON 或后端服务');
        } finally {
            setLoading(false);
        }
    }

    async function switchGraph(graphId) {
        if (!graphId || graphId === state.currentGraphId) return;
        state.currentGraphId = graphId;

        state.translateX = 0;
        state.translateY = 0;
        state.scale = SCALE_DEFAULT;
        state.rotation = 0;
        state.zoomLevel = 'meso';
        state.focusedId = null;
        state.highlightedIds.clear();
        state.selectedIds = [];
        state.activePath = null;
        hideNodePopup();
        timelineInited = false;

    

        state.nodes = [];
        state.edges = [];
        state.visibleIds = new Set();
        if (gNodes)      gNodes.selectAll('*').remove();
        if (gLinks)      gLinks.selectAll('*').remove();
        if (gLinkLabels) gLinkLabels.selectAll('*').remove();

        applyTransform();
        await load();
    }

    function setupGraphTabs() {
        const tabs = document.querySelectorAll('#galaxyTabs .galaxy-tab');
        if (!tabs.length) return;
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const id = tab.dataset.graphId;
                if (!id) return;
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                switchGraph(id);
            });
        });
    }

    async function handleQuery(text) {
        if (!text || !text.trim()) return;
        setLoading(true);
        try {
            const r = await api('/api/graph/query', {
                text:       text.trim(),
                session_id: state.sessionId,
                graph_id:   state.currentGraphId      // ★ 后端 _require() 必填
            });
            await handleResponse(r);
        } catch (e) {
            console.warn('查询失败', e);
            showToast('查询失败，请稍后再试');
        } finally {
            setLoading(false);
        }
    }

    /* ------------------------------------------------------------
       初始化
    ------------------------------------------------------------ */
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
        for (const url of D3_CDNS) {
            const ok = await loadScript(url);
            if (ok && typeof d3 !== 'undefined') return true;
        }
        return false;
    }

    function resetView() {
        state.focusedId = null;
        state.highlightedIds.clear();
        state.selectedIds = [];
        state.activePath  = null;
        hideNodePopup();
        state.timelineValue = state.timelineEnabled ? state.timelineMax : null;
        const slider = document.getElementById('galaxyTimeline');
        if (slider && state.timelineEnabled) slider.value = state.timelineMax;
        const yEl = document.getElementById('galaxyTimelineYear');
        if (yEl && state.timelineEnabled) yEl.textContent = state.timelineMax;

        animateTo(SCALE_DEFAULT, 0, 0, 0, 700).then(() => load());
    }

    async function init() {
        if (inited) return;
        stage = document.getElementById('galaxyStage');
        if (!stage) return;
        inited = true;

        const ok = await ensureD3();
        if (!ok) {
            showToast('图谱引擎加载失败，请检查网络（d3 CDN 无法访问）');
            return;
        }

        svg         = d3.select('#galaxySvg');
        gRoot       = svg.append('g').attr('class', 'g-root');
        gLinks      = gRoot.append('g').attr('class', 'g-links');
        gLinkLabels = gRoot.append('g').attr('class', 'g-link-labels');
        gNodes      = gRoot.append('g').attr('class', 'g-nodes');

        tooltipEl   = document.getElementById('galaxyTooltip');
        nodePopupEl = document.getElementById('galaxyNodePopup');
        ensurePopupCloseBtn();

        stage.setAttribute('data-zoom-level', state.zoomLevel);
        initStars();
        setupGalaxyTheme();

        setupInteraction();
        setupGraphTabs();

        const resetBtn = document.getElementById('galaxyReset');
        if (resetBtn) resetBtn.addEventListener('click', resetView);

        const macroBtn = document.getElementById('galaxyMacro');
        if (macroBtn) macroBtn.addEventListener('click', goMacro);

        const roamBtn = document.getElementById('galaxyRoam');
        if (roamBtn) roamBtn.addEventListener('click', startRoam);

        const immBtn = document.getElementById('galaxyImmersive');
        if (immBtn) immBtn.addEventListener('click', toggleImmersive);

        const immExit = document.getElementById('galaxyImmersiveExit');
        if (immExit) immExit.addEventListener('click', toggleImmersive);

        applyTransform();
        load();
    }

    /* ------------------------------------------------------------
       对外暴露
    ------------------------------------------------------------ */
    window.GalaxyEngine = {
        init,
        load,
        query:      handleQuery,
        clickNode:  (id) => handleNodeClick(id, null),
        selectNode: (id) => toggleNodeSelection(id),
        goMacro,
        roam: startRoam,
        toggleImmersive,
        pulseNodes,
        focusOnNodes,
        switchGraph,
        get state() { return state; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();