/* ============================================================
   个人状态 UI · 收藏按钮 + 笔记入口
   ------------------------------------------------------------
   依赖：window.Auth（js/auth.js）
   
   用法：
     // ① 生成按钮 HTML
     `${ProfileUI.favoriteBtnHTML('paper', paperId)}`
   
     // ② 渲染完 DOM 后统一绑定事件
     ProfileUI.bindAll(containerEl)
   
   type 约定：'paper' | 'video' | 'book' | 'node'
============================================================ */
(function () {
    'use strict';

    // ---------- 图标 ----------
    const ICONS = {
        starOutline: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                        stroke="currentColor" stroke-width="1.8"
                        stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>`,
        starFill: `<svg viewBox="0 0 24 24" width="16" height="16"
                     fill="currentColor" stroke="currentColor"
                     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                     <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                   </svg>`,
        note: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                 stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round">
                 <path d="M12 20h9"/>
                 <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
               </svg>`
    };

    function isLoggedIn() {
        return window.Auth && window.Auth.isLoggedIn();
    }

    // ---------- 未登录拦截 ----------
    function requireLogin(action) {
        if (isLoggedIn()) return true;
        if (window.Auth) window.Auth.open('login');
        setTimeout(() => {
            const el = document.getElementById('profileUiToast') || createToast();
            el.textContent = `登录后才能${action}`;
            el.classList.add('show');
            clearTimeout(el._timer);
            el._timer = setTimeout(() => el.classList.remove('show'), 2600);
        }, 320);
        return false;
    }

    function createToast() {
        const el = document.createElement('div');
        el.id = 'profileUiToast';
        el.className = 'pui-toast';
        document.body.appendChild(el);
        return el;
    }

    function makeNoteKey(type, id) {
        return `${type}::${id}`;
    }

    // ---------- HTML 生成器 ----------
    function favoriteBtnHTML(type, id, opts = {}) {
        const size = opts.size || 'md';
        const variant = opts.variant || 'icon';
        const favorited = isLoggedIn() && window.Auth.profile.isFavorite(type, id);

        const icon = favorited ? ICONS.starFill : ICONS.starOutline;
        const cls = `pui-fav ${favorited ? 'active' : ''} pui-${size} pui-${variant}`;
        const label = variant === 'text'
            ? `<span>${favorited ? '已收藏' : '收藏'}</span>` : '';

        return `<button class="${cls}"
                        data-pui-type="${type}"
                        data-pui-id="${escapeHtml(id)}"
                        title="${favorited ? '取消收藏' : '加入收藏'}"
                        aria-label="收藏">${icon}${label}</button>`;
    }

    function noteBtnHTML(type, id, opts = {}) {
        const size = opts.size || 'md';
        const variant = opts.variant || 'icon';
        const hasNote = isLoggedIn() &&
            !!window.Auth.profile.getNote(makeNoteKey(type, id));

        const icon = ICONS.note;
        const cls = `pui-note ${hasNote ? 'has-note' : ''} pui-${size} pui-${variant}`;
        const label = variant === 'text'
            ? `<span>${hasNote ? '已写笔记' : '写笔记'}</span>` : '';

        return `<button class="${cls}"
                        data-pui-type="${type}"
                        data-pui-id="${escapeHtml(id)}"
                        title="写笔记"
                        aria-label="笔记">${icon}${label}</button>`;
    }

    // ---------- 事件绑定 ----------
    function bindAll(container) {
        if (!container) return;
        container.querySelectorAll('.pui-fav:not([data-pui-bound])').forEach(btn => {
            btn.dataset.puiBound = '1';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                handleFavoriteClick(btn);
            });
        });
        container.querySelectorAll('.pui-note:not([data-pui-bound])').forEach(btn => {
            btn.dataset.puiBound = '1';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                handleNoteClick(btn);
            });
        });
    }

    async function handleFavoriteClick(btn) {
        const type = btn.dataset.puiType;
        const id = btn.dataset.puiId;
        if (!requireLogin('收藏')) return;

        try {
            const isFav = await window.Auth.profile.toggleFavorite(type, id);
            btn.classList.toggle('active', isFav);
            btn.innerHTML = isFav ? ICONS.starFill : ICONS.starOutline;
            if (btn.classList.contains('pui-text')) {
                btn.insertAdjacentHTML('beforeend',
                    `<span>${isFav ? '已收藏' : '收藏'}</span>`);
            }
            btn.title = isFav ? '取消收藏' : '加入收藏';

            const el = document.getElementById('profileUiToast') || createToast();
            el.textContent = isFav ? '已加入收藏' : '已取消收藏';
            el.classList.add('show');
            clearTimeout(el._timer);
            el._timer = setTimeout(() => el.classList.remove('show'), 2000);
        } catch (e) {
            console.warn('[ProfileUI] 收藏失败', e);
        }
    }

    function handleNoteClick(btn) {
        const type = btn.dataset.puiType;
        const id = btn.dataset.puiId;
        if (!requireLogin('写笔记')) return;
        openNoteEditor(type, id, {
            title: btn.dataset.puiTitle || id,
            onSaved: () => {
                const has = !!window.Auth.profile.getNote(makeNoteKey(type, id));
                btn.classList.toggle('has-note', has);
            }
        });
    }

    // ---------- 笔记编辑器 ----------
    let _editorEl = null;

    function openNoteEditor(type, id, opts = {}) {
        closeNoteEditor();

        const key = makeNoteKey(type, id);
        const current = window.Auth.profile.getNote(key) || '';

        const mask = document.createElement('div');
        mask.className = 'pui-note-mask';
        mask.innerHTML = `
            <div class="pui-note-card" role="dialog" aria-modal="true">
                <button class="pui-note-close" aria-label="关闭">×</button>
                <h3 class="pui-note-title">
                    <span class="pui-note-icon">📝</span>
                    <span>我的笔记</span>
                </h3>
                <div class="pui-note-sub">${escapeHtml(opts.title || id)}</div>
                <textarea class="pui-note-input"
                          placeholder="在此记录你的思考、联想或疑问…"
                          maxlength="2000"></textarea>
                <div class="pui-note-tools">
                    <span class="pui-note-count">0 / 2000</span>
                    <div class="pui-note-actions">
                        <button class="pui-note-cancel">取消</button>
                        <button class="pui-note-save">保存</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(mask);
        _editorEl = mask;
        requestAnimationFrame(() => mask.classList.add('show'));

        const ta = mask.querySelector('.pui-note-input');
        const counter = mask.querySelector('.pui-note-count');
        ta.value = current;
        counter.textContent = `${current.length} / 2000`;
        ta.addEventListener('input', () => {
            counter.textContent = `${ta.value.length} / 2000`;
        });
        setTimeout(() => ta.focus(), 220);

        mask.querySelector('.pui-note-close').onclick = closeNoteEditor;
        mask.querySelector('.pui-note-cancel').onclick = closeNoteEditor;
        mask.addEventListener('click', (e) => {
            if (e.target === mask) closeNoteEditor();
        });

        mask.querySelector('.pui-note-save').onclick = async () => {
            const text = ta.value.trim();
            await window.Auth.profile.setNote(key, text);
            if (opts.onSaved) opts.onSaved();

            const el = document.getElementById('profileUiToast') || createToast();
            el.textContent = text ? '笔记已保存' : '笔记已清空';
            el.classList.add('show');
            clearTimeout(el._timer);
            el._timer = setTimeout(() => el.classList.remove('show'), 2000);
            closeNoteEditor();
        };
    }

    function closeNoteEditor() {
        if (!_editorEl) return;
        const el = _editorEl;
        _editorEl = null;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }

    // ---------- 登录态变化时刷新所有按钮 ----------
    function refreshAll() {
        document.querySelectorAll('.pui-fav').forEach(btn => {
            const fav = isLoggedIn() &&
                window.Auth.profile.isFavorite(btn.dataset.puiType, btn.dataset.puiId);
            btn.classList.toggle('active', fav);
            btn.innerHTML = fav ? ICONS.starFill : ICONS.starOutline;
            btn.title = fav ? '取消收藏' : '加入收藏';
        });
        document.querySelectorAll('.pui-note').forEach(btn => {
            const has = isLoggedIn() &&
                !!window.Auth.profile.getNote(makeNoteKey(btn.dataset.puiType, btn.dataset.puiId));
            btn.classList.toggle('has-note', has);
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ---------- 对外暴露 ----------
    window.ProfileUI = {
        favoriteBtnHTML,
        noteBtnHTML,
        bindAll,
        openNoteEditor,
        closeNoteEditor,
        refreshAll
    };

    // ---------- 订阅登录态变化 ----------
    if (window.Auth && window.Auth.onChange) {
        window.Auth.onChange(() => setTimeout(refreshAll, 80));
    }
})();