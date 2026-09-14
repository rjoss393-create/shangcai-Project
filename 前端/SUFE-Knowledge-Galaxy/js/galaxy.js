/* ============================================================
   知识星系 · 雷达环图谱渲染引擎
   依赖：d3 v7（CDN，缺失时自动补加载）
   接口：后端 /api/graph/{load | click | query}
   ------------------------------------------------------------
   场景3 能力（对甲方需求）：
   ① 缩放分层：≤40% 宏观 / 40%-80% 中观 / ≥80% 微观
   ② 右键拖拽旋转视角
   ③ Ctrl+点击选中两节点 → BFS 求路径 → 粒子流动高亮
   ④ 自动漫游：镜头依次经过路径中间节点并弹解释
   ⑤ 回到宏观视角：旋转飞回动画
   ⑥ 底部时间轴：按节点年份依次点亮/淡出
   ⑦ 沉浸模式：隐藏所有外围 UI
============================================================ */
(function () {
    'use strict';

    const API_BASE = 'http://localhost:8000';
    const D3_CDNS  = [
        'https://cdn.jsdelivr.net/npm/d3@7',
        'https://unpkg.com/d3@7/dist/d3.min.js',
        'https://cdn.bootcdn.net/ajax/libs/d3/7.9.0/d3.min.js',
        'https://lib.baomitu.com/d3/7.9.0/d3.min.js'
    ];

    const RING_RADIUS = {
        '课程':       155,
        '概念':       250,
        '__default__': 335
    };

    // ★ 节点配色：红橙黄绿青蓝紫 7 色，按节点 id 哈希稳定分配（刷新/切书不变色）
    const NODE_COLORS = ['#c0392b', '#e67e22', '#f0b400', '#27ae60', '#16a085', '#2980b9', '#8e44ad'];
    function colorIndexOf(node) {
        let h = 0;
        const s = String(node.id || '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % NODE_COLORS.length;
    }

    // ★ 新增：缩放分层阈值（对齐需求 40% / 80%）
    const ZOOM_BOUNDS = { macroMax: 0.4, mesoMax: 0.8 };
    const SCALE_MIN = 0.28;
    const SCALE_MAX = 2.0;
    const SCALE_DEFAULT = 0.7;   // 初始落在中观层

    // ★ 视野裁剪参数（世界坐标）：
    //   视野框 + CULL_RENDER_MARGIN 内 → 渲染集（挂 DOM）
    //   视野框 + CULL_ACTIVE_MARGIN 内 → 活动集（参与力导向，即"附近缓存"，无 DOM）
    //   超出 → 移出活动集（仅保留在全量缓存 allNodes，接近时按原坐标恢复）
    const CULL_RENDER_MARGIN = 300;
    const CULL_ACTIVE_MARGIN = 1200;

    // ★ 新增：缩放时用来计算层级名
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

    // ---------- 全局状态 ----------
    const state = {
        sessionId:      null,
        graphId:        'econ',        // ★ 当前图谱（对应后端 graph_id，默认经济综合）
        // ★ 视野裁剪三级结构：
        //   allNodes/allEdges  全量数据（含 x/y 布局坐标，远端节点仅存这里，接近时恢复）
        //   nodes/edges        活动集：视野 + 活动缓冲带，参与力导向（"附近缓存"）
        //   renderNodes/edges  渲染集：视野 + 渲染缓冲带，真正挂 DOM（"视野框内"）
        allNodes:       [],
        allEdges:       [],
        nodes:          [],
        edges:          [],
        renderNodes:    [],
        renderEdges:    [],
        visibleIds:     new Set(),
        focusedId:      null,
        highlightedIds: new Set(),

        // 视图
        translateX: 0,
        translateY: 0,
        scale:      SCALE_DEFAULT,
        rotation:   0,                 // ★ 新增：旋转角度（deg）
        zoomLevel:  'meso',

        // 交互
        dragging:        false,
        dragMode:        null,         // 'pan' | 'rotate'
        dragStartX:      0,
        dragStartY:      0,
        dragStartTX:     0,
        dragStartTY:     0,
        dragStartRot:    0,

        // ★ 新增：双节点选择 & 路径
        selectedIds: [],
        activePath:  null,             // string[] | null

        // ★ 新增：时间轴
        timelineEnabled: false,
        timelineMin:     0,
        timelineMax:     0,
        timelineValue:   null,

        // ★ 新增：沉浸 / 漫游
        immersive:  false,
        roaming:    false,
        roamAbort:  false
    };

    let stage, svg, gRoot, gLinks, gLinkLabels, gNodes;
    let tooltipEl, nodePopupEl;
    let simulation = null;
    let toastTimer = null;
    let inited = false;
    let timelineInited = false;

    // ---------- 工具 ----------
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

    // ---------- 数据 ----------
    // ★ 后端契约字段为 type（concept/chapter/section/formula），原前端读 category（课程/概念）。
    //   统一改为按 type 映射：章/节视为"课程"核心节点（宏观层突出），概念为概念节点。
    function categoryOf(node) {
        if (node.category) return node.category;
        if (node.type === 'chapter' || node.type === 'section') return '课程';
        if (node.type === 'concept') return '概念';
        return '';
    }
    const ringOf = n => RING_RADIUS[categoryOf(n)] ?? RING_RADIUS.__default__;

    function classOf(node) {
        const c = categoryOf(node);
        if (c === '课程') return 'course';
        if (c === '概念') return 'concept';
        return 'other';
    }

    const srcId   = e => (e.source && typeof e.source === 'object') ? e.source.id : e.source;
    const tgtId   = e => (e.target && typeof e.target === 'object') ? e.target.id : e.target;
    const edgeKey = e => `${srcId(e)}|${tgtId(e)}|${e.relation || ''}`;

    // ★ 新增：边的方向极性（促进/抑制），优先用后端字段，否则从 relation 文本推断
    function edgePolarity(e) {
        if (e.polarity) return String(e.polarity).toLowerCase();
        const rel = String(e.relation || '').toLowerCase();
        if (/抑制|负|阻碍|减弱|降低|削弱/.test(rel)) return 'inhibit';
        if (/促进|正|增强|提高|推动|促进/.test(rel)) return 'promote';
        return 'neutral';
    }

    // ★ 新增：节点年份（用于时间轴），优先 node.year → node.media.year → 稳定伪年份
    function getNodeYear(node) {
        if (node.year != null) return +node.year;
        if (node.media && node.media.year != null) return +node.media.year;
        return null;
    }
    function fallbackYear(node) {
        const s = String(node.id) + String(node.label || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return 2010 + (h % 15);   // 2010 – 2024
    }

    function resolveEdges(edges) {
        // 把边的 source/target 字符串解析为全量缓存中的节点对象（供力导向/坐标读取）
        const nodeMap = new Map(state.allNodes.map(n => [n.id, n]));
        edges.forEach(e => {
            if (typeof e.source === 'string' && nodeMap.has(e.source)) e.source = nodeMap.get(e.source);
            if (typeof e.target === 'string' && nodeMap.has(e.target)) e.target = nodeMap.get(e.target);
        });
    }

    function mergeGraph(data) {
        if (!data || !data.nodes) return;

        const firstLoad = state.allNodes.length === 0;
        const nodeMap = new Map(state.allNodes.map(n => [n.id, n]));
        data.nodes.forEach(n => {
            const old = nodeMap.get(n.id);
            // 保留已有布局坐标：合并时不清空 x/y（裁剪恢复依赖历史坐标）
            if (old) Object.assign(old, n);
            else     nodeMap.set(n.id, { ...n, x: 0, y: 0 });
        });
        state.allNodes = Array.from(nodeMap.values());

        const edgeMap = new Map(state.allEdges.map(e => [edgeKey(e), e]));
        data.edges.forEach(e => {
            const k = edgeKey(e);
            if (!edgeMap.has(k)) edgeMap.set(k, { ...e });
        });
        state.allEdges = Array.from(edgeMap.values());
        rebuildDegree();

        state.visibleIds = new Set(data.nodes.map(n => n.id));

        // ★ 清理失效的选中/路径
        const idSet = new Set(state.allNodes.map(n => n.id));
        state.selectedIds = state.selectedIds.filter(id => idSet.has(id));
        if (state.activePath) {
            state.activePath = state.activePath.filter(id => idSet.has(id));
            if (state.activePath.length < 2) state.activePath = null;
        }

        // ★ 首次拿到数据后初始化时间轴
        if (!timelineInited) {
            timelineInited = true;
            setupTimeline();
        }

        // ★ 按视野重建活动集/渲染集
        updateCulling(true);

        // ★ 首次载入：布局稳定后自动缩放视图到内容包围盒（防止散开后视野中心空白）
        if (firstLoad) {
            _pendingFit = true;
            // 兜底：6 秒后若仍未自动适配（如布局异常停滞），强制适配一次
            setTimeout(() => {
                if (_pendingFit) {
                    _pendingFit = false;
                    fitViewToContent(500);
                }
            }, 6000);
        }
    }

    // ---------- ★ 视野裁剪 ----------
    function worldViewport() {
        // 计算当前视野在世界坐标系下的 AABB（考虑 translate/scale/rotate）
        const rect = svg.node().getBoundingClientRect();
        const cos = Math.cos(-state.rotation * Math.PI / 180);
        const sin = Math.sin(-state.rotation * Math.PI / 180);
        const cxr = state.translateX + rect.width / 2;
        const cyr = state.translateY + rect.height / 2;
        const corners = [
            [0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height],
        ].map(([px, py]) => {
            const dx = (px - cxr) / state.scale;
            const dy = (py - cyr) / state.scale;
            return [dx * cos - dy * sin, dx * sin + dy * cos];
        });
        const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
        return {
            minX: Math.min(...xs), maxX: Math.max(...xs),
            minY: Math.min(...ys), maxY: Math.max(...ys),
        };
    }

    let _renderSet = new Set();   // 上一帧渲染集 id（变化检测用）
    let _cullTick  = 0;

    function updateCulling(forceRender) {
        if (!state.allNodes.length || !svg) return;

        let vp;
        try { vp = worldViewport(); } catch (e) { vp = null; }

        // ★ 兜底：画布尺寸未就绪（0 尺寸 / NaN）时全量渲染，保证图谱可见
        if (!vp || !isFinite(vp.minX) || !isFinite(vp.maxX) ||
            !isFinite(vp.minY) || !isFinite(vp.maxY) ||
            vp.maxX - vp.minX < 2 || vp.maxY - vp.minY < 2) {
            state.renderNodes = state.allNodes;
            state.nodes = state.allNodes;
            state.renderEdges = state.allEdges;
            state.edges = state.allEdges;
            resolveEdges(state.edges);
            if (simulation) simulation.nodes(state.nodes);
            _renderSet = new Set(state.allNodes.map(n => n.id));
            render();
            return;
        }

        const renderIds = new Set(), activeIds = new Set();
        const rmx = CULL_RENDER_MARGIN, amx = CULL_ACTIVE_MARGIN;

        for (const n of state.allNodes) {
            const x = n.x || 0, y = n.y || 0;
            if (x > vp.minX - rmx && x < vp.maxX + rmx &&
                y > vp.minY - rmx && y < vp.maxY + rmx) renderIds.add(n.id);
            if (x > vp.minX - amx && x < vp.maxX + amx &&
                y > vp.minY - amx && y < vp.maxY + amx) activeIds.add(n.id);
        }

        // 聚焦/高亮/选中/路径节点强制进入渲染集（后端 actions 可能指向视野外节点）
        const forceIds = [state.focusedId, ...state.highlightedIds,
                          ...state.selectedIds, ...(state.activePath || [])];
        forceIds.forEach(id => { if (id) renderIds.add(id); });

        state.renderNodes = state.allNodes.filter(n => renderIds.has(n.id));
        state.renderEdges = state.allEdges.filter(e =>
            renderIds.has(srcId(e)) && renderIds.has(tgtId(e)));
        state.nodes = state.allNodes.filter(n => activeIds.has(n.id));
        state.edges = state.allEdges.filter(e =>
            activeIds.has(srcId(e)) && activeIds.has(tgtId(e)));

        // 渲染集变化检测（仅增删时重建 DOM）
        let changed = forceRender ||
            renderIds.size !== _renderSet.size ||
            state.renderNodes.some(n => !_renderSet.has(n.id));
        _renderSet = renderIds;

        // 同步力导向（活动集变化时；不重启 alpha，避免平移时抖动）
        // ★ 顺序关键：必须先换 links 再换 nodes —— d3 的 simulation.nodes() 会按当前
        //   links 重新初始化力，若 links 还指向刚被移出活动集的节点会抛异常杀死模拟器
        if (simulation) {
            resolveEdges(state.edges);
            const activeLinks = state.edges.filter(e =>
                e.source && typeof e.source === 'object' &&
                e.target && typeof e.target === 'object');
            simulation.force('link').links(activeLinks);
            simulation.nodes(state.nodes);
            if (forceRender) simulation.alpha(0.3).restart();   // 合并新数据时轻量重新布局
        }

        if (changed) render();
    }

    function rebuildDegree() {
        // 度数基于全量边预计算，避免每次渲染都遍历全部边（裁剪后渲染更频繁）
        state.degree = new Map();
        state.allEdges.forEach(e => {
            const s = srcId(e), t = tgtId(e);
            state.degree.set(s, (state.degree.get(s) || 0) + 1);
            state.degree.set(t, (state.degree.get(t) || 0) + 1);
        });
    }

    function degreeOf(id) {
        return state.degree ? (state.degree.get(id) || 0) : 0;
    }

    const radiusOf = d => 11 + Math.min(degreeOf(d.id), 5) * 2.0;

    // ★ 新增：宏观层的简称
    function shortName(name) {
        if (!name) return '';
        return name.length <= 4 ? name : name.slice(0, 4);
    }
        // ★ 新增：层级感知的节点半径（图形坐标，会再被 scale 乘一次）
    function visualRadius(d) {
        const base = radiusOf(d);
        const lvl  = state.zoomLevel;
        if (lvl === 'macro') return base * 2.0;    // 补偿 0.28~0.4 的缩放
        if (lvl === 'meso')  return base * 1.25;
        return base;
}

    // ---------- 渲染 ----------
    function render() {
        if (!gRoot) return;

        resolveEdges(state.renderEdges);

        const lvl = state.zoomLevel;

        // ---- 节点（视野裁剪：只对渲染集挂 DOM）----
        const sel = gNodes.selectAll('.g-node').data(state.renderNodes, d => d.id);
        sel.exit().remove();

        const enter = sel.enter()
            .append('g')
            .style('cursor', 'pointer')
            .on('click', (evt, d) => {
                evt.stopPropagation();
                handleNodeClick(d.id, evt);
            })
            .on('mouseenter', (evt, d) => showTooltip(evt, d))
            .on('mousemove', moveTooltip)
            .on('mouseleave', hideTooltip)
            .on('contextmenu', e => e.preventDefault());   // 右键不弹菜单

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
            // ★ 时间轴过滤
            if (state.timelineEnabled && state.timelineValue != null) {
                const y = getNodeYear(d) ?? d._year ?? null;
                if (y != null && y > state.timelineValue) c += ' time-faded';
            }
            return c;
        });

        merged.select('circle')
            .transition().duration(400)
            .attr('r', visualRadius)
            .style('fill', d => NODE_COLORS[colorIndexOf(d)]);

        merged.select('text')
            .attr('class', d => {
                const r = ringOf(d);
                let cls = 'g-label';
                if (r <= 140) cls += ' ring-core';
                // 中观以上：外环隐藏文字（对齐现有待办）
                if (lvl !== 'macro' && r > 200) cls += ' hidden';
                return cls;
            })
            .text(d => lvl === 'macro' ? shortName(d.label) : d.label)
            .attr('dy', d => radiusOf(d) + 16);

        // ---- 连线 ----
        const lsel = gLinks.selectAll('.g-link').data(state.renderEdges, edgeKey);
        lsel.exit().remove();
        lsel.enter().append('path').attr('class', 'g-link');

        gLinks.selectAll('.g-link')
            .attr('class', e => {
                const s = srcId(e), t = tgtId(e);
                let c = 'g-link';

                // 中观及以上显示促进/抑制方向色
                if (lvl !== 'macro') {
                    const p = edgePolarity(e);
                    if (p === 'promote') c += ' promote';
                    else if (p === 'inhibit') c += ' inhibit';
                }

                if (state.highlightedIds.has(s) || state.highlightedIds.has(t))
                    c += ' highlighted';
                if (!state.visibleIds.has(s) || !state.visibleIds.has(t))
                    c += ' faded';

                // ★ 路径高亮 + 粒子流动
                if (state.activePath && isPathEdge(s, t))
                    c += ' path-active path-flow';

                // ★ 时间轴过滤（两端都过了当前年份才显示）
                if (state.timelineEnabled && state.timelineValue != null) {
                    const sn = state.allNodes.find(n => n.id === s);
                    const tn = state.allNodes.find(n => n.id === t);
                    const sy = sn ? (getNodeYear(sn) ?? sn._year) : null;
                    const ty = tn ? (getNodeYear(tn) ?? tn._year) : null;
                    if ((sy != null && sy > state.timelineValue) ||
                        (ty != null && ty > state.timelineValue)) {
                        c += ' time-faded';
                    }
                }
                return c;
            });

        // ---- 关系标签 ----
        const lls = gLinkLabels.selectAll('.g-link-label')
            .data(state.renderEdges, edgeKey);
        lls.exit().remove();
        lls.enter().append('text').attr('class', 'g-link-label');

        gLinkLabels.selectAll('.g-link-label')
            .attr('class', e => {
                const s = srcId(e), t = tgtId(e);
                const bothVisible =
                    state.visibleIds.has(s) && state.visibleIds.has(t);
                let c = 'g-link-label' + (bothVisible ? '' : ' faded');
                // ★ 宏观层不展示关系标签
                if (lvl === 'macro') c += ' faded';
                return c;
            })
            .text(e => e.relation || '');
        syncStageFocusClass();
        runSimulation(false);   // ★ 渲染不重启 alpha：布局只在首次建图/合并新数据时重启，避免"一直动"
    }
        // ★ 新增
    function syncStageFocusClass() {
        if (!stage) return;
        const has = !!(state.focusedId ||
                    state.highlightedIds.size ||
                    (state.activePath && state.activePath.length));
        stage.classList.toggle('has-focus', has);
    }

    // ★ 新增：判断一条边是否属于当前高亮路径
    function isPathEdge(a, b) {
        const p = state.activePath;
        if (!p || p.length < 2) return false;
        for (let i = 0; i < p.length - 1; i++) {
            const x = p[i], y = p[i + 1];
            if ((x === a && y === b) || (x === b && y === a)) return true;
        }
        return false;
    }

    // ---------- 力导向布局 ----------
    function runSimulation(restart) {
        // ★ 布局适度分散（比原版宽松但不过度）：连线距离 110→150、斥力 -420→-460、
        //   碰撞间距 +26→+34、连线强度 0.08→0.06。
        //   注意：斥力过强（如 -560）会让 5000 节点级图谱散得比默认视野还大，
        //   视野中心反而空白——布局范围须配合 fitViewToContent 使用。
        if (typeof d3 === 'undefined') return;

        resolveEdges(state.edges);
        const links = state.edges.filter(e =>
            e.source && typeof e.source === 'object' &&
            e.target && typeof e.target === 'object'
        );

        if (!simulation) {
            simulation = d3.forceSimulation(state.nodes)
                .force('radial',  d3.forceRadial(ringOf, 0, 0).strength(0.85))
                .force('charge',  d3.forceManyBody().strength(-460))
                .force('collide', d3.forceCollide(d => radiusOf(d) + 34).strength(1))
                .force('link',    d3.forceLink(links).id(d => d.id)
                                    .distance(150).strength(0.06))
                .force('confine', confineForce(CULL_CONFINE_RADIUS))
                .on('tick', ticked);
        } else {
            // ★ 顺序关键：先换 links 再换 nodes（同 updateCulling，防 d3 用旧 links 初始化抛异常）
            simulation.force('link').links(links);
            simulation.nodes(state.nodes);
            if (restart) simulation.alpha(0.6).restart();
        }
    }

    function ticked() {
        const getXY = ref => (ref && typeof ref === 'object')
            ? { x: ref.x || 0, y: ref.y || 0 }
            : { x: 0, y: 0 };

        // 只更新渲染集内的边路径（视野裁剪：DOM 里只有渲染集）
        state.renderEdges.forEach(e => {
            const s = getXY(e.source), t = getXY(e.target);
            const dx = t.x - s.x, dy = t.y - s.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len, ny = dx / len;
            const curve = Math.min(38, len * 0.20);
            const cx = (s.x + t.x) / 2 + nx * curve;
            const cy = (s.y + t.y) / 2 + ny * curve;

            e._path = `M${s.x},${s.y} Q${cx},${cy} ${t.x},${t.y}`;
            e._labelX = 0.25 * s.x + 0.5 * cx + 0.25 * t.x;
            e._labelY = 0.25 * s.y + 0.5 * cy + 0.25 * t.y;
        });

        gLinks.selectAll('.g-link').attr('d', e => e._path || '');

        gLinkLabels.selectAll('.g-link-label')
            .attr('x', e => e._labelX || 0)
            .attr('y', e => e._labelY || 0);

        gNodes.selectAll('.g-node')
            .attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);

        // ★ 视野裁剪节流：布局推进时每 15 帧重算一次视野内外
        if ((++_cullTick % 15) === 0) updateCulling(false);

        // ★ 首次载入自动适配：布局推进期间每 40 tick 跟随适配一次，稳定后最终适配一次
        if (_pendingFit && simulation) {
            if (simulation.alpha() < 0.06) {
                _pendingFit = false;
                fitViewToContent(500);
            } else if ((++_fitTick % 40) === 0) {
                fitViewToContent(350);
            }
        }
    }

    // ---------- 视图变换 ----------
    function applyTransform() {
        if (!gRoot || !svg) return;
        const rect = svg.node().getBoundingClientRect();
        const cx = rect.width  / 2;
        const cy = rect.height / 2;

        // ★ 变换顺序：translate → scale → rotate
        gRoot.attr('transform',
            `translate(${cx + state.translateX},${cy + state.translateY}) ` +
            `scale(${state.scale}) ` +
            `rotate(${state.rotation})`);

        updateZoomLevelUI();

        // ★ 视野变化 → 立即重算裁剪（平移/缩放/旋转实时跟手）
        updateCulling(false);
    }

    // ★ 新增：随缩放更新层级指示器 + 触发一次重渲染
    function updateZoomLevelUI() {
        // ① 百分比每次都要更新（与层级解耦）
        const pctEl = document.getElementById('galaxyZoomPct');
        if (pctEl) pctEl.textContent = Math.round(state.scale * 100) + '%';

        // ② 层级名
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

    // ★ 新增：动画插值到目标变换（用于自动漫游 / 回到宏观 / 重置）
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
                const e = 1 - Math.pow(1 - p, 3);   // easeOutCubic

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

    // ---------- ★ 布局围墙（限制整体直径，保证任何缩放下都装得进视野） ----------
    function confineForce(maxR) {
        let nodes = [];
        function force(alpha) {
            for (const n of nodes) {
                const r = Math.hypot(n.x || 0, n.y || 0);
                if (r > maxR && r > 0) {
                    const k = ((r - maxR) / r) * alpha * 3;
                    n.vx -= n.x * k;
                    n.vy -= n.y * k;
                    if (r > maxR * 1.6) {          // 严重越界直接钳位回墙内
                        const s = maxR / r;
                        n.x *= s; n.y *= s;
                    }
                }
            }
        }
        force.initialize = ns => { nodes = ns; };
        return force;
    }
    const CULL_CONFINE_RADIUS = 1400;   // 布局最大半径（世界坐标）

    // ---------- ★ 视图适配内容 ----------
    let _pendingFit = false;   // 加载/切换后等待布局稳定再适配一次
    let _fitTick    = 0;

    function fitViewToContent(duration) {
        if (!svg) return;
        const pts = state.allNodes.filter(n => n.x != null && n.y != null && isFinite(n.x) && isFinite(n.y));
        if (!pts.length) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach(n => {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        });
        const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
        const rect = svg.node().getBoundingClientRect();
        const pad = 90;
        const s = Math.max(SCALE_MIN,
            Math.min(1.2, Math.min(rect.width / (w + pad * 2), rect.height / (h + pad * 2))));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        animateTo(s, -cx * s, -cy * s, state.rotation, duration || 600);
    }

    // ---------- 交互 ----------
    function setupInteraction() {
        const svgNode = svg.node();

        // 屏蔽右键菜单
        svgNode.addEventListener('contextmenu', e => e.preventDefault());
            // ② 保险层：mousedown 阶段就阻止右键，部分 Edge 版本手势基于此事件
        svgNode.addEventListener('mousedown', e => {
            if (e.button === 2) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        svgNode.addEventListener('pointerdown', e => {
            _pendingFit = false;   // 用户介入，停止自动适配
            if (e.target.closest && e.target.closest('.g-node')) return;

            // ★ 旋转：右键 或 Shift/Alt + 左键（备选交互）
            const isRotate = e.button === 2 ||
                            (e.button === 0 && (e.shiftKey || e.altKey));
            const isPan    = e.button === 0 && !e.shiftKey && !e.altKey;


        if (isRotate) {
            e.preventDefault();
            e.stopPropagation();

            // ③ 接管指针，防止被浏览器手势抢走
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
                // 水平拖动每 1px → 0.35°，手感偏细腻
                state.rotation = state.dragStartRot + dx * 0.35;
            }
            applyTransform();
        });

        window.addEventListener('pointerup', () => {
            if (!state.dragging) return;
            state.dragging = false;
            state.dragMode = null;
            stage.classList.remove('dragging', 'rotating');
        });

        // ★ 滚轮缩放：以画布中心为锚点（tx/ty 按比例缩放，锚点不动）
        svgNode.addEventListener('wheel', e => {
            e.preventDefault();
            _pendingFit = false;   // 用户介入，停止自动适配
            const k = e.deltaY > 0 ? 0.94 : 1.06;
            const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, state.scale * k));
            if (next === state.scale) return;

            const ratio = next / state.scale;
            state.translateX *= ratio;
            state.translateY *= ratio;
            state.scale = next;

            applyTransform();
        }, { passive: false });

        // 点击空白 → 清空路径
        svgNode.addEventListener('click', e => {
            if (e.target.closest && e.target.closest('.g-node')) return;
            if (state.selectedIds.length > 0 || state.activePath) {
                state.selectedIds = [];
                state.activePath = null;
                render();
            }
        });

        window.addEventListener('resize', applyTransform);

        // ★ Esc 退出沉浸模式
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && state.immersive) toggleImmersive();
        });
    }

    // ---------- ★ 悬停 tooltip ----------
    function showTooltip(evt, d) {
        if (!tooltipEl) return;
        const text = (d.media && d.media.text) || '';
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
        // 边界约束
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

    // ---------- ★ 双节点选择 + 路径 ----------
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

    // ★ BFS 最短路径
    function findPath(a, b) {
        if (a === b) return [a];
        const adj = new Map();
        state.allEdges.forEach(e => {
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
                if (!prev.has(m)) {
                    prev.set(m, n);
                    q.push(m);
                }
            }
        }
        if (!prev.has(b)) return null;
        const path = [];
        let cur = b;
        while (cur != null) {
            path.unshift(cur);
            cur = prev.get(cur);
        }
        return path;
    }

    // ---------- ★ 时间轴 ----------
    function setupTimeline() {
        const wrap    = document.getElementById('galaxyTimelineWrap');
        const slider  = document.getElementById('galaxyTimeline');
        const yearEl  = document.getElementById('galaxyTimelineYear');
        const resetBtn= document.getElementById('galaxyTimelineReset');
        if (!wrap || !slider || !yearEl) return;

        // 收集年份（缺省用稳定伪年份）
        const years = [];
        state.allNodes.forEach(n => {
            let y = getNodeYear(n);
            if (y == null) { y = fallbackYear(n); n._year = y; }
            years.push(y);
        });
        if (!years.length) { wrap.style.display = 'none'; return; }

        const yMin = Math.min(...years);
        const yMax = Math.max(...years);
        if (yMax === yMin) { wrap.style.display = 'none'; return; }

        state.timelineEnabled = true;
        state.timelineMin = yMin;
        state.timelineMax = yMax;
        state.timelineValue = yMax;

        slider.min = yMin;
        slider.max = yMax;
        slider.step = 1;
        slider.value = yMax;
        yearEl.textContent = yMax;

        wrap.style.display = 'flex';

        slider.addEventListener('input', e => {
            state.timelineValue = +e.target.value;
            yearEl.textContent = state.timelineValue;
            render();
        });
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                state.timelineValue = state.timelineMax;
                slider.value = state.timelineMax;
                yearEl.textContent = state.timelineMax;
                render();
            });
        }
    }

    // ---------- ★ 自动漫游 ----------
    async function startRoam() {
        const btn = document.getElementById('galaxyRoam');

        if (state.roaming) {
            state.roamAbort = true;
            return;
        }
        if (!state.activePath || state.activePath.length < 2) {
            showToast('请先 Ctrl+点击 选中两个节点生成路径');
            return;
        }

        state.roaming = true;
        state.roamAbort = false;
        if (btn) { btn.classList.add('active'); btn.querySelector('span:last-child').textContent = '停止漫游'; }

        for (const id of state.activePath) {
            if (state.roamAbort) break;
            const node = state.allNodes.find(n => n.id === id);
            if (!node) continue;

            await panToNode(node, 1.0, 700);
            showNodePopup(node);
            await sleep(1400);
            hideNodePopup();
        }

        state.roaming = false;
        if (btn) { btn.classList.remove('active'); btn.querySelector('span:last-child').textContent = '自动漫游'; }
    }

    // 把某节点平移到屏幕中心
    function panToNode(node, scale, duration) {
        const s = scale || state.scale;
        const r = state.rotation * Math.PI / 180;
        const nx = node.x || 0, ny = node.y || 0;
        const rx = nx * Math.cos(r) - ny * Math.sin(r);
        const ry = nx * Math.sin(r) + ny * Math.cos(r);
        return animateTo(s, -s * rx, -s * ry, state.rotation, duration);
    }

    function showNodePopup(node) {
        if (!nodePopupEl) return;
        const text = (node.media && node.media.text) || '（暂无说明）';
        nodePopupEl.innerHTML =
            `<div class="popup-title">${node.label}</div>` +
            `<div class="popup-body">${text}</div>`;
        nodePopupEl.classList.add('show');
    }
    function hideNodePopup() {
        if (nodePopupEl) nodePopupEl.classList.remove('show');
    }

    // ---------- ★ 回到宏观视角 ----------
    function goMacro() {
        state.selectedIds = [];
        state.activePath  = null;
        // 目标：scale 落到宏观区（≤0.4），平移归零，旋转归零 → 带"旋转飞回"感觉
        animateTo(0.32, 0, 0, 0, 900).then(() => render());
    }
        // ★ 新增：让一批节点心跳闪烁（场景4用）
    function pulseNodes(ids, duration) {
        if (!ids || !ids.length || !gNodes) return;
        const idSet = new Set(ids);
        gNodes.selectAll('.g-node')
            .classed('pulse', d => idSet.has(d.id));
        // 到时自动清除
        setTimeout(() => {
            gNodes.selectAll('.g-node.pulse').classed('pulse', false);
        }, duration || 3200);
    }

    // ★ 新增：缩放 + 平移到包含指定节点的区域，并高亮证据路径
    function focusOnNodes(ids, edges) {
        if (!ids || !ids.length || !gRoot || !svg) return;

        // 1) 高亮节点
        state.highlightedIds = new Set(ids);

        // 2) 计算包围盒
        const targets = state.allNodes.filter(n => ids.includes(n.id));
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

        // 3) 计算合适缩放（留出边距）
        const rect = svg.node().getBoundingClientRect();
        const spanX = Math.max(120, maxX - minX) + 240;
        const spanY = Math.max(120, maxY - minY) + 240;
        const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX,
            Math.min(rect.width / spanX, rect.height / spanY)));

        // 4) 计算平移：让世界坐标 (cxW, cyW) 落到画布中心
        const tx = -scale * cxW;
        const ty = -scale * cyW;

        // 5) 证据连线：把 edges 转成 activePath
        //    说明：现有路径高亮只支持"一条链"。
        //    若后端返回多条边，将来可扩展 state.evidenceEdges 再改 render。
        if (edges && edges.length) {
            state.selectedIds = [];
            const first = edges[0];
            state.activePath = (first && first.length >= 2) ? first.slice() : null;
        }

        state.focusedId = ids[0];

        // 旋转归零 + 动画飞过去
        animateTo(scale, tx, ty, 0, 900).then(() => render());
    }

    // ---------- ★ 沉浸模式 ----------
    function toggleImmersive() {
        state.immersive = !state.immersive;
        document.body.classList.toggle('immersive', state.immersive);

        const btn = document.getElementById('galaxyImmersive');
        if (btn) {
            btn.classList.toggle('active', state.immersive);
            const t = btn.querySelector('span:last-child');
            if (t) t.textContent = state.immersive ? '退出沉浸' : '沉浸模式';
        }

        // 等布局稳定后再重算（stage 尺寸变了）
        requestAnimationFrame(() => {
            applyTransform();
            if (simulation) simulation.alpha(0.15).restart();
        });
    }

    // ---------- 动作执行器 ----------
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
                        // ★ fit 改为按内容包围盒适配（原实现固定回中观层，节点散开后视野中心可能空白）
                        fitViewToContent(600);
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

    // ---------- 会话流程 ----------
    async function handleResponse(resp) {
        if (!resp) return;
        if (resp.session_id) state.sessionId = resp.session_id;

        if (resp.code !== 0) {
            showToast(resp.message || '请求失败');
            return;
        }

        state.highlightedIds.clear();
        mergeGraph(resp.data);
        render();

        if (resp.degraded && resp.notice) showToast(resp.notice);
        await runActions(resp.actions);
    }

    async function load() {
        setLoading(true);
        try {
            const r = await api('/api/graph/load', {
                session_id: state.sessionId,
                graph_id:   state.graphId
            });
            await handleResponse(r);
        } catch (e) {
            console.warn('加载图谱失败', e);
            showToast('加载图谱失败，请检查后端服务 (localhost:8000)');
        } finally {
            setLoading(false);
        }
    }

    // ★ 切换图谱（图书选择框）：清空画布状态后按新 graph_id 重新加载
    async function switchBook(graphId) {
        if (!graphId || graphId === state.graphId) return;
        state.graphId = graphId;
        state.allNodes = [];
        state.allEdges = [];
        state.nodes = [];
        state.edges = [];
        state.renderNodes = [];
        state.renderEdges = [];
        state.degree = new Map();
        _renderSet = new Set();
        state.visibleIds = new Set();
        state.focusedId = null;
        state.highlightedIds.clear();
        state.selectedIds = [];
        state.activePath = null;
        state.timelineValue = null;
        await load();
    }

    // ★ 点击节点：Ctrl/Cmd 是"选中"，否则走原聚焦 API
    async function handleNodeClick(nodeId, evt) {
        if (evt && (evt.ctrlKey || evt.metaKey)) {
            toggleNodeSelection(nodeId);
            return;
        }
        if (!state.sessionId) return;
        try {
            const r = await api('/api/graph/click', {
                node_id:    nodeId,
                session_id: state.sessionId,
                graph_id:   state.graphId
            });
            await handleResponse(r);
        } catch (e) {
            console.warn('节点点击失败', e);
        }
    }

    async function handleQuery(text) {
        if (!text || !text.trim()) return;
        setLoading(true);
        try {
            const r = await api('/api/graph/query', {
                text:       text.trim(),
                session_id: state.sessionId,
                graph_id:   state.graphId
            });
            await handleResponse(r);
        } catch (e) {
            console.warn('查询失败', e);
            showToast('查询失败，请稍后再试');
        } finally {
            setLoading(false);
        }
    }

    // ---------- 初始化 ----------
    function loadScript(src) {
        return new Promise(resolve => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve(true);
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

        // 初始层级标记
        stage.setAttribute('data-zoom-level', state.zoomLevel);

        setupInteraction();

        const resetBtn = document.getElementById('galaxyReset');
        if (resetBtn) resetBtn.addEventListener('click', resetView);

        const bookSelect = document.getElementById('galaxyBookSelect');
        if (bookSelect) bookSelect.addEventListener('change', () => switchBook(bookSelect.value));

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

    // ---------- 对外暴露 ----------
    window.GalaxyEngine = {
        init,
        load,
        switchBook,                                   // ★ 切换图谱（图书选择框）
        query:     handleQuery,
        clickNode: (id) => handleNodeClick(id, null),
        selectNode:(id) => toggleNodeSelection(id),   // ★ 供知识助手复用
        goMacro,                                       // ★
        roam: startRoam,                               // ★
        toggleImmersive,
        pulseNodes,      // ★ 新增
        focusOnNodes,    // ★ 新增
        // ★ 调试辅助：控制台执行 GalaxyEngine.debug() 查看裁剪三级数量
        debug: () => ({
            allNodes:   state.allNodes.length,
            active:     state.nodes.length,
            rendered:   state.renderNodes.length,
            edges:      { all: state.allEdges.length, active: state.edges.length, rendered: state.renderEdges.length },
            view:       { tx: state.translateX, ty: state.translateY, scale: state.scale, rot: state.rotation },
        }),
        get state() { return state; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();