/* ============================================================
   认证与权限模块 · 前端
   ------------------------------------------------------------
   ★ 解耦说明（前端同学注意）：
     ┌──────────────────────────────────────────────────┐
     │ 前端职责（保留在本文件）：                        │
     │   · 登录页 DOM 渲染与交互                         │
     │   · 导航栏用户区渲染                              │
     │   · 板块权限守卫（未登录拦截）                    │
     │   · 本地状态缓存（token / user / profile）        │
     ├──────────────────────────────────────────────────┤
     │ 后端职责（用 ★ BACKEND 标注，后期交给后端）：      │
     │   · 账号密码校验、注册、Token 签发                │
     │   · 个人状态持久化（笔记 / 收藏 / 临时关系 / 筛选）│
     └──────────────────────────────────────────────────┘

   ★ 后端已接入（2026-09-19）：
     ① CONFIG.USE_MOCK 已改成 false —— 走真实接口
     ② CONFIG.API_BASE 已留空 —— 页面与后端同源（:8000 单端口托管）
     ③ 【Mock 数据层】整段保留未删（USE_MOCK=false 时是死代码，不影响运行；
        等前端负责人确认后再删）

   ★ 后期可拆分：
     · 个人状态（profile）逻辑 → js/profile.js
     · 权限守卫逻辑          → js/permission.js
     · CSS 样式              → css/auth.css（已独立）
============================================================ */
(function () {
    'use strict';

    /* ============================================================
       一、配置区
    ============================================================ */
    const CONFIG = {
        // ★ BACKEND：真实服务地址（留空 = 与前端同源，页面由后端 :8000 托管）
        API_BASE: '',

        // ★ BACKEND：联调开关。true=走本地 Mock；false=走真实接口
        USE_MOCK: false,

        // localStorage Key（前端本地缓存，不涉及后端）
        TOKEN_KEY:   'sufe_auth_token',
        USER_KEY:    'sufe_auth_user',
        PROFILE_KEY: 'sufe_profile_',   // 拼接 userId

        // ★ BACKEND：RESTful 路由（后端同事按此实现即可）
        ROUTES: {
            LOGIN:    '/api/auth/login',      // POST {username, password}
            REGISTER: '/api/auth/register',   // POST {username, password, nickname}
            LOGOUT:   '/api/auth/logout',     // POST {} （Authorization 头带 token）
            ME:       '/api/auth/me',         // GET  （用 token 换用户信息）
            PROFILE:  '/api/user/profile'     // GET / PUT （个人状态）
        }
    };

    /* ============================================================
       二、运行时状态
    ============================================================ */
    const state = {
        user:    null,         // { id, username, nickname, avatar }
        token:   null,
        profile: null,         // 个人状态对象
        isGuest: false,        // 是否游客模式
        listeners: new Set()   // 状态变化订阅者（供其他模块联动）
    };

    /* ============================================================
       三、数据层 · AuthAPI
       ------------------------------------------------------------
       ★ BACKEND：整个对象是前后端唯一接口边界。
         后端就绪后，把每个方法体换成 fetch 调用即可，
         调用方（UI 层）无需任何改动。
    ============================================================ */
    const AuthAPI = {

        /** 统一请求入口（含 token 注入、错误处理） */
        async _request(route, method = 'POST', body = null) {
            // ---------- Mock 分支（后端就绪后删除） ----------
            if (CONFIG.USE_MOCK) {
                return MockServer.handle(route, method, body);
            }

            // ---------- ★ BACKEND：真实请求 ----------
            const headers = { 'Content-Type': 'application/json' };
            if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

            const res = await fetch(CONFIG.API_BASE + route, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined
            });
            if (!res.ok && res.status !== 401 && res.status !== 409) {
                throw new Error('HTTP ' + res.status);
            }
            return await res.json();
        },

        // ---------- 认证 ----------
        login(username, password) {
            return this._request(CONFIG.ROUTES.LOGIN, 'POST', { username, password });
        },
        register(username, password, nickname) {
            return this._request(CONFIG.ROUTES.REGISTER, 'POST',
                { username, password, nickname });
        },
        logout() {
            return this._request(CONFIG.ROUTES.LOGOUT, 'POST', {});
        },
        me() {
            return this._request(CONFIG.ROUTES.ME, 'GET');
        },

        // ---------- 个人状态（★ BACKEND：需登录态） ----------
        getProfile() {
            return this._request(CONFIG.ROUTES.PROFILE, 'GET');
        },
        saveProfile(profile) {
            return this._request(CONFIG.ROUTES.PROFILE, 'PUT', { profile });
        }
    };

    /* ============================================================
       四、Mock 数据层（★ 后端就绪后整段删除）
       ------------------------------------------------------------
       仅用于联调演示，密码用简易 hash 存储（真实场景由后端加密）。
    ============================================================ */
    const MOCK_USERS_KEY = 'sufe_mock_users_db';

    function simpleHash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return 'h' + Math.abs(h).toString(36);
    }

    const MockServer = {
        _loadUsers() {
            try {
                const raw = localStorage.getItem(MOCK_USERS_KEY);
                return raw ? JSON.parse(raw) : {};
            } catch { return {}; }
        },
        _saveUsers(users) {
            localStorage.setItem(MOCK_USERS_KEY, JSON.stringify(users));
        },
        _fakeToken(userId) {
            return 'mock_' + userId + '_' + Date.now().toString(36);
        },
        _delay(ms = 260) {
            return new Promise(r => setTimeout(r, ms));
        },

        async handle(route, method, body) {
            await this._delay();

            // ---------- 登录 ----------
            if (route === CONFIG.ROUTES.LOGIN) {
                const users = this._loadUsers();
                const u = users[body.username];
                if (!u) {
                    return { code: 401, message: '账号不存在，请先注册' };
                }
                if (u.password !== simpleHash(body.password)) {
                    return { code: 401, message: '密码错误' };
                }
                return {
                    code: 0,
                    token: this._fakeToken(u.id),
                    user: { id: u.id, username: u.username, nickname: u.nickname }
                };
            }

            // ---------- 注册 ----------
            if (route === CONFIG.ROUTES.REGISTER) {
                const { username, password, nickname } = body;
                if (!username || !password) {
                    return { code: 400, message: '账号和密码不能为空' };
                }
                if (username.length < 3) {
                    return { code: 400, message: '账号至少 3 个字符' };
                }
                if (password.length < 6) {
                    return { code: 400, message: '密码至少 6 位' };
                }
                const users = this._loadUsers();
                if (users[username]) {
                    return { code: 409, message: '该账号已被注册' };
                }
                const userId = 'u_' + Date.now().toString(36);
                users[username] = {
                    id: userId,
                    username,
                    nickname: nickname || username,
                    password: simpleHash(password),
                    createdAt: Date.now()
                };
                this._saveUsers(users);
                return {
                    code: 0,
                    token: this._fakeToken(userId),
                    user: { id: userId, username, nickname: nickname || username }
                };
            }

            // ---------- 退出 ----------
            if (route === CONFIG.ROUTES.LOGOUT) {
                return { code: 0 };
            }

            // ---------- 获取当前用户 ----------
            if (route === CONFIG.ROUTES.ME) {
                if (!state.user) return { code: 401, message: '未登录' };
                return { code: 0, user: state.user };
            }

            // ---------- 个人状态 ----------
            if (route === CONFIG.ROUTES.PROFILE) {
                if (!state.user) return { code: 401, message: '未登录' };
                if (method === 'GET') {
                    const key = CONFIG.PROFILE_KEY + state.user.id;
                    const raw = localStorage.getItem(key);
                    return {
                        code: 0,
                        profile: raw ? JSON.parse(raw) : defaultProfile()
                    };
                }
                if (method === 'PUT') {
                    const key = CONFIG.PROFILE_KEY + state.user.id;
                    localStorage.setItem(key, JSON.stringify(body.profile));
                    return { code: 0 };
                }
            }

            return { code: 404, message: 'Mock 未实现：' + route };
        }
    };

    /** 个人状态默认结构（★ 后端 schema 对齐点） */
    function defaultProfile() {
        return {
            notes: {},          // { [nodeId]: { text, updatedAt } }
            favorites: [],      // [ { type:'paper'|'video'|'book', id, addedAt } ]
            tempRelations: [],  // [ { from, to, note, createdAt } ]
            filters: {          // 各板块筛选条件
                study:  { tags: [], order: 'asc' },
                paper:  { journal: null, year: null, topic: null },
                career: { category: 'all' }
            }
        };
    }

    /* ============================================================
       五、个人状态管理层（前端缓存 + 后端同步）
       ------------------------------------------------------------
       所有对 profile 的读写都走这里，业务代码不直接碰 localStorage。
       后期拆分到 js/profile.js 时，整段平移即可。
    ============================================================ */
    const Profile = {
        /** 登录后加载（或游客时用空壳） */
        async load() {
            if (!state.user) {
                state.profile = defaultProfile();
                return state.profile;
            }
            try {
                const res = await AuthAPI.getProfile();
                state.profile = res.code === 0 ? res.profile : defaultProfile();
            } catch (e) {
                console.warn('[Profile] 加载失败，使用本地默认', e);
                const key = CONFIG.PROFILE_KEY + state.user.id;
                const raw = localStorage.getItem(key);
                state.profile = raw ? JSON.parse(raw) : defaultProfile();
            }
            // 缓存到本地（离线兜底）
            localStorage.setItem(CONFIG.PROFILE_KEY + state.user.id,
                JSON.stringify(state.profile));
            return state.profile;
        },

        /** 写操作：先改内存 + 本地缓存，再异步同步后端 */
        async sync() {
            if (!state.user || !state.profile) return;
            localStorage.setItem(CONFIG.PROFILE_KEY + state.user.id,
                JSON.stringify(state.profile));
            try {
                await AuthAPI.saveProfile(state.profile);
            } catch (e) {
                console.warn('[Profile] 同步后端失败（已本地保存）', e);
            }
        },

        // ---------- 具体业务操作 ----------
        async setNote(nodeId, text) {
            if (!state.profile) return;
            if (!text) delete state.profile.notes[nodeId];
            else state.profile.notes[nodeId] =
                { text, updatedAt: Date.now() };
            await this.sync();
        },
        getNote(nodeId) {
            return state.profile?.notes?.[nodeId]?.text || '';
        },

        async toggleFavorite(type, id) {
            if (!state.profile) return false;
            const list = state.profile.favorites;
            const idx = list.findIndex(f => f.type === type && f.id === id);
            if (idx >= 0) list.splice(idx, 1);
            else list.push({ type, id, addedAt: Date.now() });
            await this.sync();
            return idx < 0;   // true=已收藏
        },
        isFavorite(type, id) {
            return !!state.profile?.favorites?.some(
                f => f.type === type && f.id === id);
        },

        async setFilter(section, value) {
            if (!state.profile) return;
            state.profile.filters[section] = value;
            await this.sync();
        },
        getFilter(section) {
            return state.profile?.filters?.[section] || null;
        }
    };

    /* ============================================================
       六、视图层 · 登录页
    ============================================================ */
    function buildLoginPage() {
        const el = document.createElement('div');
        el.className = 'auth-page';
        el.id = 'authPage';
        el.innerHTML = `
            <div class="auth-bg">
                <div class="auth-bg-badge"></div>
                <div class="auth-bg-title">SUFE</div>
                <div class="auth-bg-sub">Investment Knowledge Galaxy</div>
            </div>

            <div class="auth-card">
                <div class="auth-brand">
                    <img src="assets/sufe-badge.png" alt="校徽" class="auth-brand-badge">
                    <div class="auth-brand-text">
                        <div class="auth-brand-cn">投资学知识星系</div>
                        <div class="auth-brand-en">SUFE Knowledge Galaxy</div>
                    </div>
                </div>

                <div class="auth-tabs" id="authTabs">
                    <button class="auth-tab active" data-tab="login">登录</button>
                    <button class="auth-tab" data-tab="register">注册</button>
                </div>

                <form class="auth-form" id="authForm" autocomplete="on">
                    <label class="auth-field">
                        <span class="auth-field-label">账号</span>
                        <input type="text" name="username" id="authUsername"
                               placeholder="请输入账号" autocomplete="username"
                               maxlength="32" required>
                    </label>

                    <label class="auth-field" id="authNicknameField" style="display:none;">
                        <span class="auth-field-label">昵称（选填）</span>
                        <input type="text" name="nickname" id="authNickname"
                               placeholder="便于展示的昵称" autocomplete="nickname"
                               maxlength="20">
                    </label>

                    <label class="auth-field">
                        <span class="auth-field-label">密码</span>
                        <input type="password" name="password" id="authPassword"
                               placeholder="请输入密码" autocomplete="current-password"
                               minlength="6" maxlength="64" required>
                    </label>

                    <div class="auth-error" id="authError"></div>

                    <button type="submit" class="auth-submit" id="authSubmit">
                        <span id="authSubmitText">登录</span>
                        <span class="auth-submit-arrow">→</span>
                    </button>
                </form>

                <div class="auth-divider"><span>或</span></div>

                <button class="auth-guest" id="authGuestBtn">
                    <span>游客访问</span>
                    <span class="auth-guest-hint">（可浏览资讯/课程/论文/招聘）</span>
                </button>

                <p class="auth-notice">
                    登录后可查看<strong>知识星系</strong>与<strong>学习资料</strong>，
                    并可保存个人笔记、收藏与筛选条件。
                </p>
            </div>
        `;
        return el;
    }

    /* ============================================================
       七、视图层 · 导航栏用户区
    ============================================================ */
    function ensureNavUserSlot() {
        const brandArea = document.querySelector('.brand-area');
        if (!brandArea) return null;

        // 清理可能残留在导航条里的旧节点（防止上一次热更新残留）
        const oldInNav = document.querySelector('.navigation .nav-user');
        if (oldInNav) oldInNav.remove();

        let slot = brandArea.querySelector('.nav-user');
        if (slot) return slot;

        slot = document.createElement('div');
        slot.className = 'nav-user';
        slot.id = 'navUser';
        brandArea.appendChild(slot);
        return slot;
    }

    function renderNavUser() {
        const slot = ensureNavUserSlot();
        if (!slot) return;

        if (state.user) {
            const initial = (state.user.nickname || state.user.username)
                            .charAt(0).toUpperCase();
            slot.innerHTML = `
                <button class="nav-user-btn" id="navUserBtn">
                    <span class="nav-user-avatar">${initial}</span>
                    <span class="nav-user-name">${escapeHtml(
                        state.user.nickname || state.user.username)}</span>
                    <span class="nav-user-caret">▾</span>
                </button>
                <div class="nav-user-menu" id="navUserMenu">
                    <button class="nav-user-menu-item" data-act="profile">
                        <span>📓</span><span>个人空间</span>
                    </button>
                    <button class="nav-user-menu-item" data-act="logout">
                        <span>↪</span><span>退出登录</span>
                    </button>
                </div>
            `;
            bindNavUserEvents(slot);
        } else {
            slot.innerHTML = `
                <button class="nav-user-btn nav-user-login" id="navLoginBtn">
                    <span>登录 / 注册</span>
                </button>
            `;
            slot.querySelector('#navLoginBtn')
                .addEventListener('click', () => openAuthPage());
        }
    }

    function bindNavUserEvents(slot) {
        const btn  = slot.querySelector('#navUserBtn');
        const menu = slot.querySelector('#navUserMenu');
        if (!btn || !menu) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('show');
        });
        document.addEventListener('click', () => menu.classList.remove('show'));

        menu.querySelectorAll('.nav-user-menu-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.classList.remove('show');
                const act = item.dataset.act;
                if (act === 'logout') await handleLogout();
                if (act === 'profile') openProfilePanel();
            });
        });
    }

    /* ============================================================
       八、视图层 · 权限守卫
       ------------------------------------------------------------
       用法：给需要登录的 <section> 加 data-require-login="true"，
             本模块自动注入遮罩；登录后自动移除。
    ============================================================ */
    function refreshGuards() {
        const guarded = document.querySelectorAll('[data-require-login="true"]');
        guarded.forEach(sec => {
            const exists = sec.querySelector(':scope > .auth-guard');
            const needGuard = !isLoggedIn();

            if (needGuard && !exists) {
                sec.appendChild(buildGuardOverlay(sec.dataset.guardTitle || '该板块'));
            } else if (!needGuard && exists) {
                exists.remove();
            }
                // ★ 新增：已登录时确保不留遮罩残留（哪怕上面逻辑有 bug）
            if (!needGuard) {
                sec.querySelectorAll('.auth-guard').forEach(g => g.remove());
            }
        });
    }

    function buildGuardOverlay(title) {
        const el = document.createElement('div');
        el.className = 'auth-guard';
        el.innerHTML = `
            <div class="auth-guard-card">
                <div class="auth-guard-icon">🔒</div>
                <h3>登录后可查看${escapeHtml(title)}</h3>
                <p>该板块需要登录账号后访问。登录后还可保存个人笔记、
                   收藏与筛选条件，跨设备同步。</p>
                <div class="auth-guard-actions">
                    <button class="auth-guard-login">立即登录</button>
                </div>
            </div>
        `;
        el.querySelector('.auth-guard-login')
            .addEventListener('click', () => openAuthPage('login'));
        return el;
    }

    /* ============================================================
       九、核心流程
    ============================================================ */
    function isLoggedIn() { return !!state.user; }

    /** 打开登录页 */
    function openAuthPage(initialTab = 'login') {
        const page = document.getElementById('authPage');
        if (!page) return;
        page.classList.add('show');
        document.body.style.overflow = 'hidden';
        switchTab(initialTab);
        setTimeout(() => document.getElementById('authUsername')?.focus(), 300);
    }

    function closeAuthPage() {
        const page = document.getElementById('authPage');
        if (!page) return;
        page.classList.remove('show');
        document.body.style.overflow = '';
    }

    function switchTab(tab) {
        const tabs = document.querySelectorAll('.auth-tab');
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        const nickField = document.getElementById('authNicknameField');
        const submitText = document.getElementById('authSubmitText');
        if (tab === 'register') {
            nickField.style.display = '';
            submitText.textContent = '注册';
            document.getElementById('authPassword')
                .setAttribute('autocomplete', 'new-password');
        } else {
            nickField.style.display = 'none';
            submitText.textContent = '登录';
            document.getElementById('authPassword')
                .setAttribute('autocomplete', 'current-password');
        }
        clearAuthError();
    }

    function showAuthError(msg) {
        const el = document.getElementById('authError');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
    }
    function clearAuthError() {
        const el = document.getElementById('authError');
        if (el) { el.textContent = ''; el.classList.remove('show'); }
    }

    async function handleSubmit(e) {
        e.preventDefault();
        clearAuthError();

        const activeTab = document.querySelector('.auth-tab.active')?.dataset.tab || 'login';
        const username  = document.getElementById('authUsername').value.trim();
        const password  = document.getElementById('authPassword').value;
        const nickname  = document.getElementById('authNickname').value.trim();

        if (!username || !password) {
            showAuthError('请填写账号与密码');
            return;
        }

        const submitBtn = document.getElementById('authSubmit');
        submitBtn.disabled = true;

        try {
            const res = activeTab === 'register'
                ? await AuthAPI.register(username, password, nickname)
                : await AuthAPI.login(username, password);

            if (res.code !== 0) {
                showAuthError(res.message || '操作失败');
                return;
            }
            await applyLogin(res.token, res.user);
            closeAuthPage();
            notify(`欢迎，${res.user.nickname || res.user.username}`);
        } catch (err) {
            console.error('[Auth] 提交失败', err);
            showAuthError('网络异常，请稍后再试');
        } finally {
            submitBtn.disabled = false;
        }
    }

    async function applyLogin(token, user) {
        state.token = token;
        state.user  = user;
        state.isGuest = false;
        localStorage.setItem(CONFIG.TOKEN_KEY, token);
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));

        await Profile.load();
        renderNavUser();
        refreshGuards();
        emitChange();
    }

    async function handleLogout() {
        if (!confirm('确定要退出登录吗？')) return;
        try { await AuthAPI.logout(); } catch {}
        state.user = null;
        state.token = null;
        state.profile = null;
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        renderNavUser();
        refreshGuards();
        emitChange();
        notify('已退出登录');
    }

    function handleGuestEnter() {
        state.isGuest = true;
        state.user = null;
        state.token = null;
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        Profile.load();  // 空壳 profile
        renderNavUser();
        refreshGuards();
        closeAuthPage();
        notify('已进入游客模式 · 知识星系与学习资料需登录后查看');
        emitChange();
    }

    /** 页面加载时恢复登录态 */
    async function restoreSession() {
        const token = localStorage.getItem(CONFIG.TOKEN_KEY);
        const rawUser = localStorage.getItem(CONFIG.USER_KEY);
        if (!token || !rawUser) {
            // 未登录 → 打开登录页
            openAuthPage('login');
            return false;
        }
        try {
            const user = JSON.parse(rawUser);
            state.token = token;
            state.user  = user;
            // ★ BACKEND：这里可调用 AuthAPI.me() 校验 token 是否过期
            //           Mock 模式下直接信任本地缓存
            if (!CONFIG.USE_MOCK) {
                const check = await AuthAPI.me();
                if (check.code !== 0) throw new Error('token 失效');
            }
            await Profile.load();
            renderNavUser();
            refreshGuards();
            emitChange();
            return true;
        } catch (e) {
            console.warn('[Auth] 恢复会话失败，回到登录页', e);
            localStorage.removeItem(CONFIG.TOKEN_KEY);
            localStorage.removeItem(CONFIG.USER_KEY);
            openAuthPage('login');
            return false;
        }
    }

    /* ============================================================
       十、对外通知（供其他模块订阅，保持解耦）
       ------------------------------------------------------------
       其他模块用法：
         window.Auth.onChange(({user, isLoggedIn}) => { ... });
    ============================================================ */
    function emitChange() {
        const payload = {
            user: state.user,
            isLoggedIn: isLoggedIn(),
            isGuest: state.isGuest
        };
        state.listeners.forEach(fn => {
            try { fn(payload); } catch (e) { console.warn(e); }
        });
    }
    function onChange(fn) {
        state.listeners.add(fn);
        // 立即回调一次当前状态
        fn({ user: state.user, isLoggedIn: isLoggedIn(), isGuest: state.isGuest });
        return () => state.listeners.delete(fn);
    }

    /** 轻提示（若主页面已有 toast，可替换为全局实现） */
    let _toastTimer = null;
    function notify(msg) {
        let el = document.getElementById('authToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'authToast';
            el.className = 'auth-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        requestAnimationFrame(() => el.classList.add('show'));
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    /* ============================================================
       十一、个人空间面板（收藏 / 笔记 / 筛选）
       ------------------------------------------------------------
       简化版：右侧抽屉式，仅展示汇总。
       ★ 后期可独立成 profile.js 后扩展为完整页面。
    ============================================================ */
    function openProfilePanel() {
        if (!state.user) return openAuthPage('login');
        if (!state.profile) Profile.load().then(openProfilePanel);
        if (document.querySelector('.profile-panel')) return;

        const panel = document.createElement('div');
        panel.className = 'profile-panel';
        panel.innerHTML = `
            <div class="profile-panel-mask"></div>
            <div class="profile-panel-inner">
                <div class="profile-head">
                    <h3>个人空间</h3>
                    <button class="profile-close" aria-label="关闭">×</button>
                </div>
                <div class="profile-user">
                    <div class="profile-avatar">${escapeHtml(
                        (state.user.nickname || state.user.username).charAt(0).toUpperCase())}</div>
                    <div>
                        <div class="profile-name">${escapeHtml(
                            state.user.nickname || state.user.username)}</div>
                        <div class="profile-id">@${escapeHtml(state.user.username)}</div>
                    </div>
                </div>
                <div class="profile-body" id="profileBody"></div>
            </div>
        `;
        document.body.appendChild(panel);
        requestAnimationFrame(() => panel.classList.add('show'));

        panel.querySelector('.profile-close').onclick = () => closeProfilePanel();
        panel.querySelector('.profile-panel-mask').onclick = () => closeProfilePanel();
        renderProfileBody(panel.querySelector('#profileBody'));
    }

    function closeProfilePanel() {
        const p = document.querySelector('.profile-panel');
        if (!p) return;
        p.classList.remove('show');
        setTimeout(() => p.remove(), 320);
    }

    function renderProfileBody(body) {
        const p = state.profile || defaultProfile();
        const favCount = p.favorites.length;
        const noteCount = Object.keys(p.notes || {}).length;

        body.innerHTML = `
            <div class="profile-stats">
                <div class="profile-stat">
                    <div class="profile-stat-num">${favCount}</div>
                    <div class="profile-stat-label">收藏</div>
                </div>
                <div class="profile-stat">
                    <div class="profile-stat-num">${noteCount}</div>
                    <div class="profile-stat-label">笔记</div>
                </div>
                <div class="profile-stat">
                    <div class="profile-stat-num">${(p.tempRelations || []).length}</div>
                    <div class="profile-stat-label">临时关系</div>
                </div>
            </div>
            <p class="profile-tip">
                个人笔记可在「知识星系」节点卡片中添加；<br>
                收藏可在论文 / 视频 / 书籍卡片中切换。
            </p>
        `;
    }

    /* ============================================================
       十二、初始化
       ============================================================ */
    function injectLoginPage() {
        if (document.getElementById('authPage')) return;
        document.body.appendChild(buildLoginPage());
    }

    function bindLoginEvents() {
        const form = document.getElementById('authForm');
        if (form) form.addEventListener('submit', handleSubmit);

        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        const guestBtn = document.getElementById('authGuestBtn');
        if (guestBtn) guestBtn.addEventListener('click', handleGuestEnter);

        // Esc 关闭（登录态已存在时）
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (isLoggedIn() || state.isGuest) closeAuthPage();
        });
    }

    async function init() {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', init, { once: true });
            return;
        }
        injectLoginPage();
        bindLoginEvents();
        renderNavUser();
        refreshGuards();
        await restoreSession();
    }

    /* ============================================================
       十三、对外暴露
    ============================================================ */
    window.Auth = {
        // 状态查询
        isLoggedIn,
        getUser:      () => state.user,
        isGuest:      () => state.isGuest,

        // 视图操作
        open:   openAuthPage,
        close:  closeAuthPage,
        logout: handleLogout,

        // 个人状态 API（业务模块调用）
        profile: {
            load:          () => Profile.load(),
            getNote:       (id) => Profile.getNote(id),
            setNote:       (id, t) => Profile.setNote(id, t),
            isFavorite:    (t, id) => Profile.isFavorite(t, id),
            toggleFavorite:(t, id) => Profile.toggleFavorite(t, id),
            getFilter:     (s) => Profile.getFilter(s),
            setFilter:     (s, v) => Profile.setFilter(s, v)
        },

        // 订阅状态变化
        onChange,

        // ★ BACKEND：供调试时手工切换 mock / 真实接口
        _config: CONFIG,
        _api:    AuthAPI
    };

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();