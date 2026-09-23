/* ============================================================
   知识助手 · 场景4 前端
   ------------------------------------------------------------
   已对接后端 /api/graph/query（统一响应契约）：
   answer.prediction_llm → text；answer.related_nodes → nodes
============================================================ */
(function () {
    'use strict';

    // ---------- DOM 引用 ----------
    let fab, panel, body, form, input, closeBtn, sendBtn;
    let inited = false;
    let busy = false;
    let suppressFabClick = false;   // 拖动之后，抑制这次 click

    const API_BASE = 'http://localhost:8000';

    // ============================================================
    // ★ 对接点：调用后端智能问答接口，映射为面板所需格式
    //   {
    //     text:  '回答正文（纯文本，概念名直接写在里面）',
    //     nodes: [{ id: '图谱节点ID', name: '概念名' }, ...],
    //     edges: [['节点A_id', '节点B_id'], ...]   // 用于画证据连线
    //   }
    // ============================================================
    async function callAssistantAPI(question) {
        const G = window.GalaxyEngine;
        const state = (G && G.state) || {};
        const res = await fetch(API_BASE + '/api/graph/query', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                text:       question,
                session_id: state.sessionId || null,
                graph_id:   state.graphId || 'econ'
            })
        });
        if (!res.ok) throw new Error('后端返回 ' + res.status);
        const resp = await res.json();
        if (!resp || resp.code !== 0) {
            throw new Error((resp && resp.message) || '接口返回异常');
        }
        // 智能问答不可用（降级/无答案）时给友好提示
        if (!resp.answer || !resp.answer.prediction_llm) {
            return {
                text:  (resp.notice || '智能问答暂不可用，已切换为基础检索'),
                nodes: [],
                edges: []
            };
        }
        return {
            text:  resp.answer.prediction_llm,
            nodes: (resp.answer.related_nodes || []).map(n => ({ id: n.id, name: n.name })),
            edges: []
        };
    }
    function init() {
        if (inited) return;

        // ---------- 拿 DOM ----------
        fab      = document.getElementById('assistantFab');
        panel    = document.getElementById('assistantPanel');
        body     = document.getElementById('assistantBody');
        form     = document.getElementById('assistantForm');
        input    = document.getElementById('assistantInput');
        closeBtn = document.getElementById('assistantClose');
        sendBtn  = document.getElementById('assistantSend');

        if (!fab || !panel) return;
        inited = true;

        // ---------- 悬浮球：点击开关 + 拖动 ----------
        fab.addEventListener('click', () => {
            if (suppressFabClick) return;   // 刚才在拖动，不算点击
            togglePanel();
        });
        setupFabDrag();

        // ---------- 面板：关闭按钮 + 输入框提交 ----------
        closeBtn.addEventListener('click', closePanel);
        form.addEventListener('submit', e => {
            e.preventDefault();
            handleSubmit();
        });

        // ---------- 示例问题 chip ----------
        document.querySelectorAll('.sample-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                openPanel();
                input.value = chip.dataset.q || chip.textContent.trim();
                handleSubmit();
            });
        });

        // ---------- ★ 常驻提问框（新加的） ----------
        const inlineForm  = document.getElementById('inlineAskForm');
        const inlineInput = document.getElementById('inlineAskInput');
        if (inlineForm && inlineInput) {
            inlineForm.addEventListener('submit', e => {
                e.preventDefault();
                const q = (inlineInput.value || '').trim();
                if (!q || busy) return;
                inlineInput.value = '';

                // 打开右下角面板，稍等面板升起再灌入问题
                openPanel();
                setTimeout(() => {
                    input.value = q;
                    handleSubmit();
                }, 220);
            });
        }

        // ---------- Esc 关闭 ----------
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && panel.classList.contains('show')) closePanel();
        });
    }


    // ---------- 面板开关 ----------
    function openPanel() {
        panel.classList.add('show');
        panel.setAttribute('aria-hidden', 'false');
        setTimeout(() => input && input.focus(), 260);
    }
    function closePanel() {
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden', 'true');
        clearPulse();
    }
    function togglePanel() {
        panel.classList.contains('show') ? closePanel() : openPanel();
    }
        // ---------- 悬浮球拖动 ----------
    function setupFabDrag() {
        // ★ 定位接管：只在「几何有效」时才把 CSS 的 right/bottom 换算成 left/top。
        //   登录态未就绪时，main.js 的 Auth.onChange 会同步回调一次"未登录"，
        //   把悬浮球置为 display:none；此时 getBoundingClientRect() 全为 0，
        //   照搬就会把按钮永久钉死在左上角（悬浮球跑到左上角的根因）。
        //   几何无效就先不接管 —— CSS 的 right/bottom 本来就能自适应窗口，
        //   等用户真正开始拖动（那一刻必然可见）再换算。
        let anchored = false;
        function anchorToLeftTop() {
            if (anchored) return;
            const r = fab.getBoundingClientRect();
            if (!r.width && !r.height) return;      // 不可见：这份零值不可用
            fab.style.left   = r.left + 'px';
            fab.style.top    = r.top  + 'px';
            fab.style.right  = 'auto';
            fab.style.bottom = 'auto';
            anchored = true;
        }
        anchorToLeftTop();

        let dragging = false;
        let moved    = false;
        let startX = 0, startY = 0, startL = 0, startT = 0;

        fab.addEventListener('pointerdown', e => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            anchorToLeftTop();
            dragging = true;
            moved    = false;
            startX = e.clientX;
            startY = e.clientY;
            const r = fab.getBoundingClientRect();
            startL = r.left;
            startT = r.top;
            fab.classList.add('dragging');
            try { fab.setPointerCapture(e.pointerId); } catch (_) {}
        });

        window.addEventListener('pointermove', e => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
            if (!moved) return;

            const w = fab.offsetWidth;
            const h = fab.offsetHeight;
            const nl = Math.max(8, Math.min(window.innerWidth  - w - 8, startL + dx));
            const nt = Math.max(8, Math.min(window.innerHeight - h - 8, startT + dy));
            fab.style.left = nl + 'px';
            fab.style.top  = nt + 'px';
        });

        window.addEventListener('pointerup', () => {
            if (!dragging) return;
            dragging = false;
            fab.classList.remove('dragging');
            if (moved) {
                // 拖动过 → 抑制接下来的 click
                suppressFabClick = true;
                setTimeout(() => { suppressFabClick = false; }, 80);
            }
        });
        window.addEventListener('pointercancel', () => {
            if (!dragging) return;
            dragging = false;
            fab.classList.remove('dragging');
        });

        // 窗口尺寸变化时，保证按钮不出界
        window.addEventListener('resize', () => {
            if (!anchored) return;                  // 未接管：CSS 的 right/bottom 自适应
            const r = fab.getBoundingClientRect();
            if (!r.width && !r.height) return;      // 隐藏态也别拿零值去收敛
            const w = fab.offsetWidth, h = fab.offsetHeight;
            const nl = Math.max(8, Math.min(window.innerWidth  - w - 8, r.left));
            const nt = Math.max(8, Math.min(window.innerHeight - h - 8, r.top));
            fab.style.left = nl + 'px';
            fab.style.top  = nt + 'px';
        });
    }

    // ---------- 提交问题 ----------
    async function handleSubmit() {
        const q = (input.value || '').trim();
        if (!q || busy) return;

        busy = true;
        sendBtn.disabled = true;
        input.value = '';

        // 1) 用户气泡
        appendUserMsg(q);

        // 2) 「思考中」气泡
        const typingEl = appendTyping();

        // 3) 请求（后期对接点）
        let data;
        try {
            data = await callAssistantAPI(q);
        } catch (err) {
            console.warn('[知识助手] 接口失败', err);
            data = { text: '（接口暂时不可用，请稍后再试）', nodes: [], edges: [] };
        }

        // 4) 移除思考中
        typingEl.remove();

        // 5) 图谱心跳闪烁
        if (data.nodes && data.nodes.length) {
            pulseGraphNodes(data.nodes.map(n => n.id));
        }

        // 6) AI 气泡 + 逐字打印
        const { el, textEl } = appendAIMsg();
        await typeText(textEl, data.text, 22);

        // 7) 把回答中的概念名换成可点击 span
        renderConcepts(textEl, data);

        // 8) 「查看图谱证据」按钮
        if (data.nodes && data.nodes.length) {
            appendEvidenceBtn(el, data);
        }

        busy = false;
        sendBtn.disabled = false;
        input.focus();
    }

    // ---------- 消息 DOM ----------
    function appendUserMsg(text) {
        const el = document.createElement('div');
        el.className = 'msg user';
        el.textContent = text;
        body.appendChild(el);
        scrollBottom();
    }

    function appendTyping() {
        const el = document.createElement('div');
        el.className = 'msg ai typing';
        el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        body.appendChild(el);
        scrollBottom();
        return el;
    }

    function appendAIMsg() {
        const el = document.createElement('div');
        el.className = 'msg ai';
        const textEl = document.createElement('div');
        textEl.className = 'ai-text';
        el.appendChild(textEl);
        body.appendChild(el);
        scrollBottom();
        return { el, textEl };
    }

    function appendEvidenceBtn(container, data) {
        const btn = document.createElement('button');
        btn.className = 'assistant-evidence';
        btn.innerHTML = '<span class="ev-icon">🔍</span><span>查看图谱证据</span>';
        btn.addEventListener('click', () => showEvidence(data));
        container.appendChild(btn);
        scrollBottom();
    }

    // ---------- 逐字打印 ----------
    function typeText(el, text, speed) {
        return new Promise(resolve => {
            let i = 0;
            (function step() {
                if (i >= text.length) { resolve(); return; }
                el.textContent += text[i++];
                scrollBottom();
                setTimeout(step, speed);
            })();
        });
    }

    // ---------- 概念链接 ----------
    function renderConcepts(textEl, data) {
        if (!data.nodes || !data.nodes.length) return;

        let html = escapeHtml(textEl.textContent);
        data.nodes.forEach(n => {
            if (!n.name) return;
            const re = new RegExp(escapeRegExp(n.name), 'g');
            html = html.replace(re,
                `<span class="assistant-concept" data-node-id="${n.id}">${n.name}</span>`);
        });
        textEl.innerHTML = html;

        textEl.querySelectorAll('.assistant-concept').forEach(span => {
            span.addEventListener('click', () => {
                const id = span.dataset.nodeId;

                // ★ 先收起对话框，给图谱留出屏幕空间
                closePanel();

                const G = window.GalaxyEngine;
                const sec = document.getElementById('galaxy');
                if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

                // 等滚动/收起动画过去一点，再聚焦节点，避免画面打架
                setTimeout(() => {
                    if (G && G.selectNode) G.selectNode(id);
                }, 420);
            });
        });
    }

    // ---------- 图谱联动 ----------
    function pulseGraphNodes(ids) {
        const G = window.GalaxyEngine;
        if (G && typeof G.pulseNodes === 'function') {
            G.pulseNodes(ids);
            return;
        }
        // 兜底：直接给 SVG 节点加 .pulse 类
        const stage = document.getElementById('galaxyStage');
        if (!stage) return;
        const idSet = new Set(ids);
        stage.querySelectorAll('.g-node').forEach(el => {
            const d = el.__data__;
            if (d && idSet.has(d.id)) el.classList.add('pulse');
        });
        setTimeout(clearPulse, 3200);
    }
    function clearPulse() {
        const stage = document.getElementById('galaxyStage');
        if (!stage) return;
        stage.querySelectorAll('.g-node.pulse').forEach(el => el.classList.remove('pulse'));
    }

    function showEvidence(data) {
        const ids = data.nodes.map(n => n.id);
        const edges = data.edges || [];
         // ★ 先收起对话框
        closePanel();

        // 滚动到星系板块
        const sec = document.getElementById('galaxy');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

        const G = window.GalaxyEngine;
        if (G && typeof G.focusOnNodes === 'function') {
            G.focusOnNodes(ids, edges);
        } else {
            console.info('[知识助手] 图谱未提供 focusOnNodes，降级为仅滚动');
        }
    }

    // ---------- 小工具 ----------
    function scrollBottom() {
        if (!body) return;
        body.scrollTop = body.scrollHeight;
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ---------- 启动 ----------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 对外暴露（方便其他模块或调试时调用）
    window.AssistantPanel = {
        open:  openPanel,
        close: closePanel,
        ask:   (q) => { openPanel(); input.value = q; handleSubmit(); }
    };
})();