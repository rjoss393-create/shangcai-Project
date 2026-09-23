// ===============================
// 1. 导航栏平滑滚动
// ===============================
const navItems = document.querySelectorAll(".nav-item");
navItems.forEach(item => {
    item.addEventListener("click", () => {
        // 先清掉所有 active，给被点击的加上（视觉反馈）
        navItems.forEach(btn => btn.classList.remove("active"));
        item.classList.add("active");

        const targetId = item.dataset.target;
        const targetSection = document.getElementById(targetId);
        if (targetSection) {
            targetSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        // ★ 跳转动画结束后，自动回归原色
        setTimeout(() => {
            item.classList.remove("active");
        }, 500);
    });
});

// ===============================
// 2. 交易时间判断（A股）
// ===============================
function isTradingTime() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const time = hours * 100 + minutes;
    return (time >= 930 && time <= 1130) || (time >= 1300 && time <= 1500);
}

// ===============================
// 3. 指数配置 & 默认数据
// ===============================
const INDEX_CONFIG = [
    { name: '上证指数', secid: 'sh000001' },
    { name: '深证成指', secid: 'sz399001' },
    { name: '创业板指数', secid: 'sz399006' },
    { name: '科创50',         secid: 'sh000688' },   // ★ 新增
    { name: '北证50',         secid: 'bj899050' },   // ★ 新增
    { name: '恒生指数', secid: 'rt_hkHSI' },
    { name: '纳斯达克指数', secid: 'gb_ixic' },
    { name: '道琼斯工业指数', secid: 'gb_dji' }      // ★ 新增
];  // 注：「数据库」已撤销，独立为导航栏板块（见 index.html #database）

const DEFAULT_VALUES = {
    '上证指数': 3940.55,
    '深证成指': 13703.21,
    '创业板指数': 3359.72,
    '科创50':         958.42,      // ★ 新增，占位值，代理通了会被覆盖
    '北证50':         1085.36,     // ★ 新增
    '恒生指数': 25317.18,
    '纳斯达克指数': 18562.34,
    '道琼斯工业指数': 42632.18     // ★ 新增
};

// ===============================
// 4. 缓存管理（localStorage）
// ===============================
const CACHE_KEY_DATA = 'sufe_cache_data';
const CACHE_KEY_HISTORY = 'sufe_cache_history';

function getCachedData() {
    try {
        const raw = localStorage.getItem(CACHE_KEY_DATA);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // ★ 兼容旧缓存：过滤已撤销的「数据库」占位项
        return Array.isArray(parsed) ? parsed.filter(item => item.name !== '数据库') : parsed;
    } catch { return null; }
}
function setCachedData(data) {
    try { localStorage.setItem(CACHE_KEY_DATA, JSON.stringify(data)); } catch {}
}
function getCachedHistory() {
    try {
        const raw = localStorage.getItem(CACHE_KEY_HISTORY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
function setCachedHistory(history) {
    try { localStorage.setItem(CACHE_KEY_HISTORY, JSON.stringify(history)); } catch {}
}

// ===============================
// 5. 全局状态
// ===============================
let cachedData = getCachedData();
let cachedHistory = getCachedHistory();
let currentSelectedStock = '上证指数';
let isFirstLoad = true;
let updating = false;
let lastNonTradingFetch = 0; // 用于控制非交易时段的请求频率

// ===============================
// 6. 首次加载：立即返回缓存或默认数据
// ===============================
async function fetchRealTimeData() {
    if (isFirstLoad) {
        isFirstLoad = false;
        let data = cachedData;
        if (!data) {
            data = INDEX_CONFIG.map(cfg => ({
                name: cfg.name,
                value: DEFAULT_VALUES[cfg.name].toFixed(2),
                direction: '上涨',
                change: '+0.00%'
            }));
        }
        return data;
    }
    return cachedData || INDEX_CONFIG.map(cfg => ({
        name: cfg.name,
        value: DEFAULT_VALUES[cfg.name].toFixed(2),
        direction: '上涨',
        change: '+0.00%'
    }));
}

// ===============================
// 7. 后台更新（无交易时间限制）
// ===============================
async function updateDataInBackground() {
    if (updating) return;
    updating = true;
    try {
        const newData = await fetchDataAndUpdateCache();
        if (newData) {
            updateDashboard(newData);
        }
    } catch (e) {
        console.warn('后台更新失败', e);
    }
    updating = false;
}

// ===============================
// 8. 核心：从代理获取真实K线数据（每个指数独立）
// ===============================
async function fetchDataAndUpdateCache() {
    try {
        const results = await Promise.all(INDEX_CONFIG.map(async (cfg) => {
            // ★ 没有 secid 的占位项，直接返回空数据
            if (!cfg.secid) {
                return {
                    name: cfg.name,
                    value: '—',
                    direction: '',
                    change: '—',
                    history: []
                };
            }

            // 端口已统一为 8000，全部同源请求即可（东财/新浪兜底由服务端路由）
            const url = `/api/kline?secid=${cfg.secid}`;
            try {
                const response = await fetch(url);
                const result = await response.json();
                if (result && result.data && result.data.klines && result.data.klines.length >= 2) {
                    const klines = result.data.klines;
                    // 解析所有K线：格式 "日期时间,开盘,收盘,最高,最低,成交量"
                    const history = klines.map(k => {
                        const parts = k.split(',');
                        // 用 replace 修复日期格式，避免部分浏览器解析失败
                        const timeStr = parts[0].replace(/-/g, '/');
                        const time = new Date(timeStr).getTime();
                        const price = parseFloat(parts[2]); // 收盘价
                        const volume = parseFloat(parts[5]) || 0; // 成交量（折线图下方柱状图用）
                        return { time, price, volume };
                    }).filter(p => !isNaN(p.time) && !isNaN(p.price));

                    // 计算涨跌幅：找到今天最后一条和之前最后一条
                    const todayStr = new Date().toDateString();
                    let todayClose = null;
                    let prevClose = null;
                    for (let i = history.length - 1; i >= 0; i--) {
                        const d = new Date(history[i].time).toDateString();
                        if (d === todayStr && todayClose === null) {
                            todayClose = history[i].price;
                        } else if (d !== todayStr) {
                            prevClose = history[i].price;
                            break;
                        }
                    }
                    // 如果今天没数据（周末/节假日），用最后两条
                    if (todayClose === null || prevClose === null) {
                        todayClose = history[history.length - 1].price;
                        prevClose = history[history.length - 2].price;
                    }
                    const price = todayClose;
                    const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

                    return {
                        name: cfg.name,
                        value: price.toFixed(2),
                        direction: changePercent >= 0 ? '上涨' : '下跌',
                        change: (changePercent >= 0 ? '+' : '') + changePercent.toFixed(2) + '%',
                        history: history
                    };
                } else {
                    throw new Error('K线数据不足');
                }
            } catch (e) {
                console.warn(`${cfg.name} 真实数据获取失败，使用缓存`, e);
                const fallback = cachedData ? cachedData.find(d => d.name === cfg.name) : null;
                if (fallback) {
                    return { ...fallback, history: cachedHistory ? cachedHistory[cfg.name] : [] };
                }
                return {
                    name: cfg.name,
                    value: DEFAULT_VALUES[cfg.name].toFixed(2),
                    direction: '上涨',
                    change: '+0.00%',
                    history: []
                };
            }
        }));

        // 分离数据和历史
        const newData = results.map(({ name, value, direction, change }) => ({ name, value, direction, change }));
        const newHistory = {};
        results.forEach(({ name, history }) => {
            newHistory[name] = history && history.length > 0 ? history : [];
        });

        // 按配置排序
        const orderMap = {};
        INDEX_CONFIG.forEach((cfg, idx) => { orderMap[cfg.name] = idx; });
        newData.sort((a, b) => orderMap[a.name] - orderMap[b.name]);

        // 更新全局缓存
        cachedData = newData;
        cachedHistory = newHistory;
        setCachedData(newData);
        setCachedHistory(newHistory);

        console.log('✅ 真实K线数据更新成功');
        return newData;

    } catch (error) {
        console.warn('整体请求失败，使用缓存', error);
        return cachedData || null;
    }
}

// ===============================
// 9. 图表初始化
// ===============================
let chartInstance = null;

/** 成交量格式化：股/手 → 亿/万（模仿专业网站） */
function formatVolume(v) {
    if (!v || v <= 0) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(Math.round(v));
}

function initChart() {
    const ctx = document.getElementById('stockChart').getContext('2d');
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: currentSelectedStock,
                data: [],
                borderWidth: 2.5,
                pointRadius: 0,
                pointHoverRadius: 5,
                fill: true,
                tension: 0.2,
                segment: {
                    borderColor: ctx => {
                        const p0 = ctx.p0.parsed.y;
                        const p1 = ctx.p1.parsed.y;
                        return p1 >= p0 ? '#891D25' : '#2E7D32';
                    },
                    backgroundColor: ctx => {
                        const p0 = ctx.p0.parsed.y;
                        const p1 = ctx.p1.parsed.y;
                        return p1 >= p0 ? 'rgba(137,29,37,0.15)' : 'rgba(46,125,50,0.15)';
                    }
                }
            }, {
                // ★ 成交量柱状图（压在底部，模仿专业网站下半区）
                type: 'bar',
                label: '成交量',
                data: [],
                yAxisID: 'yVol',
                order: 2,
                barPercentage: 0.62,
                categoryPercentage: 1.0,
                borderWidth: 0,
                // 涨红跌绿：与前一根收盘价比较
                backgroundColor: ctx => {
                    const i = ctx.dataIndex;
                    const prices = ctx.chart.data.datasets[0].data;
                    if (i <= 0 || !prices || prices[i] == null || prices[i - 1] == null) {
                        return 'rgba(160,160,160,0.45)';
                    }
                    return prices[i] >= prices[i - 1]
                        ? 'rgba(137,29,37,0.7)' : 'rgba(46,125,50,0.7)';
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.dataset.type === 'bar') {
                                return '成交量 ' + formatVolume(context.parsed.y);
                            }
                            return '收盘 ' + context.parsed.y.toFixed(2);
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    grid: { color: 'rgba(0,0,0,0.06)' },
                    ticks: {
                        font: { family: 'Times New Roman' },
                        callback: value => value.toFixed(0)
                    }
                },
                // ★ 成交量轴：隐藏刻度与网格，仅靠 max 压缩柱子高度
                yVol: {
                    display: false,
                    beginAtZero: true,
                    grid: { display: false }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        autoSkip: true,
                        maxTicksLimit: 9,
                        maxRotation: 0,
                        font: { size: 10, family: 'Times New Roman' }
                    }
                }
            }
        }
    });
}

// ===============================
// 10. 更新图表（真实K线历史 · 支持三日/单日切换）
// ===============================
let chartRange = 'day3';   // 'day3' = 近三个交易日（默认） | 'day1' = 最近一个交易日

/** 按 chartRange 截取历史数据（基于交易日分组） */
function sliceHistoryByRange(history) {
    if (!history || !history.length) return [];
    const days = [];
    const seen = new Set();
    history.forEach(p => {
        const key = new Date(p.time).toDateString();
        if (!seen.has(key)) { seen.add(key); days.push(key); }
    });
    const keep = new Set(chartRange === 'day1' ? days.slice(-1) : days.slice(-3));
    return history.filter(p => keep.has(new Date(p.time).toDateString()));
}

function updateChart(stockName) {
    const stockData = cachedData ? cachedData.find(d => d.name === stockName) : null;
    if (stockData) {
        document.getElementById('currentStockName').textContent = stockName;
        document.getElementById('currentStockPrice').textContent = stockData.value;
        const changeClass = stockData.direction === '上涨' ? 'text-up' : 'text-down';
        document.getElementById('currentStockChange').innerHTML =
            `<span class="${changeClass}">${stockData.change}</span>`;
    }

    if (!chartInstance) return;

    const history = cachedHistory ? cachedHistory[stockName] : null;

    if (history && history.length > 0) {
        const picked = sliceHistoryByRange(history);
        const labels = picked.map(p => {
            const d = new Date(p.time);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            // 单日：只标时间；三日：标「月/日 时:分」，横轴日期时间一目了然
            return chartRange === 'day1'
                ? `${hh}:${mm}`
                : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
        });
        chartInstance.data.labels = labels;
        chartInstance.data.datasets[0].label = stockName;
        chartInstance.data.datasets[0].data = picked.map(p => p.price);
        // ★ 成交量：动态量轴上限 = 峰值×4，让柱子只占图表下方约 1/4（专业网站样式）
        const vols = picked.map(p => p.volume || 0);
        chartInstance.data.datasets[1].data = vols;
        const volMax = Math.max(...vols, 1);
        chartInstance.options.scales.yVol.max = volMax * 4;
        chartInstance.options.scales.x.ticks.maxTicksLimit = chartRange === 'day1' ? 10 : 9;
        chartInstance.update();
    } else {
        // ★ 关键：没有数据就清空，避免显示上一个指数的残留
        chartInstance.data.labels = [];
        chartInstance.data.datasets[0].label = stockName;
        chartInstance.data.datasets[0].data = [];
        chartInstance.data.datasets[1].data = [];
        chartInstance.update();
    }
}

// ===============================
// 11. 更新所有UI
// ===============================
function updateDashboard(dataArray) {
    if (!dataArray) return;

    // A. 滚动文字
    let scrollText = '';
    dataArray.forEach(item => {
        const changeClass = item.direction === '上涨' ? 'text-up' : 'text-down';
        scrollText += `${item.name} ${item.value} <span class="${changeClass}">${item.change}</span> ｜ `;
    });
    const textSpan = document.getElementById('finance-scroll-text');
    const cloneSpan = document.getElementById('finance-scroll-text-clone');
    textSpan.innerHTML = scrollText;
    cloneSpan.innerHTML = scrollText;

    const track = document.getElementById('finance-scroll-track');
    track.style.animation = 'none';
    void track.offsetHeight;   // 强制回流，保证动画从头开始
    const contentWidth = textSpan.scrollWidth;
    // ★ 修复：时长必须写进 animation 简写里。
    //   先设 animationDuration 再设 animation 简写会被重置为 0s（简写省略的值回退到初始值），
    //   0s + infinite = 每次迭代零长度 → 滚动栏看起来"永远不动"。
    const duration = Math.min(Math.max(contentWidth / 60, 18), 60);
    track.style.animation = `scrollMove ${duration}s linear infinite`;

    // B. 右侧紧凑指数栏（点击切换图表）
    const sideList = document.getElementById('stockSideList');
    if (sideList) {
        sideList.innerHTML = dataArray.map(item => {
            const cls = item.direction === '上涨' ? 'text-up'
                      : (item.direction === '下跌' ? 'text-down' : 'text-dim');
            const active = item.name === currentSelectedStock ? ' active' : '';
            return `
            <button class="side-item${active}" data-stock="${item.name}">
                <span class="si-name">${item.name}</span>
                <span class="si-right">
                    <span class="si-price ${cls}">${item.value}</span>
                    <span class="si-change ${cls}">${item.change}</span>
                </span>
            </button>`;
        }).join('');
    }

    // C. 图表
    updateChart(currentSelectedStock);
}

// ===============================
// 12. 市场交互（指数侧栏切换 + 三日/单日竖排切换）
// ===============================
function selectStock(name) {
    currentSelectedStock = name;
    // 侧栏高亮即时跟随（无需等下一次数据刷新）
    document.querySelectorAll('.side-item').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.stock === name));
    if (cachedData) updateChart(name);
}

function setupMarketControls() {
    // 右侧紧凑指数栏：点击切换图表
    const side = document.getElementById('stockSideList');
    if (side) {
        side.addEventListener('click', e => {
            const btn = e.target.closest('.side-item');
            if (!btn || !btn.dataset.stock) return;
            selectStock(btn.dataset.stock);
        });
    }

    // 图表左侧竖排「三日 / 单日」切换
    const rail = document.getElementById('chartRangeRail');
    if (rail) {
        rail.addEventListener('click', e => {
            const btn = e.target.closest('.range-btn');
            if (!btn || btn.classList.contains('active')) return;
            rail.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chartRange = btn.dataset.range === 'day1' ? 'day1' : 'day3';
            updateChart(currentSelectedStock);
        });
    }
}

// ===============================
// 13. 启动循环（首次立即拉一次真实数据，交易时间每10秒，非交易时间每5分钟）
// ===============================
function startRealtimeLoop() {
    // 立即显示缓存
    fetchRealTimeData().then(data => {
        updateDashboard(data);
    });

    // 页面打开后立刻请求一次真实数据（解决首次打开需要等待的问题）
    setTimeout(() => updateDataInBackground(), 200);

    // 定时轮询
    setInterval(() => {
        if (isTradingTime()) {
            updateDataInBackground();
        } else {
            // 非交易时间：每5分钟刷新一次（为了获取最新收盘价变化）
            const now = Date.now();
            if (now - lastNonTradingFetch > 5 * 60 * 1000) {
                lastNonTradingFetch = now;
                updateDataInBackground();
            }
        }
    }, 10000);
}


// 14. 新闻数据库（固定可跳转版）
// --------------------------------------------------------------
// 字段：{ title, url, source }
//   title   新闻标题
//   url     点击跳转地址（新窗口打开）
//   source  来源机构（显示在标题末尾，灰色小字）
//
// ★ 后续接实时接口时，只需把 renderNews 里的 newsDatabase[type][category]
//   换成来自 /api/news 的返回即可，渲染逻辑完全不变。
// ================================
const newsDatabase = {
    domestic: {
        economy: [
            { title: '国家统计局：2025年国民经济运行总体平稳、稳中有进',
              url: 'https://www.stats.gov.cn/sj/zxfb/',
              source: '国家统计局' },
            { title: '央行：实施适度宽松的货币政策，择机降准降息',
              url: 'http://www.pbc.gov.cn/',
              source: '中国人民银行' },
            { title: '财政部：2025年积极的财政政策提质增效、更可持续',
              url: 'http://www.mof.gov.cn/',
              source: '财政部' }
        ],
        policy: [
            { title: '央行宣布下调金融机构存款准备金率0.5个百分点',
              url: 'http://www.pbc.gov.cn/',
              source: '中国人民银行' },
            { title: '金融监管总局：推动中长期资金入市，打通社保、保险资金入市障碍',
              url: 'https://www.nfra.gov.cn/',
              source: '金融监管总局' },
            { title: '财政部发布新一轮减税降费政策清单，制造业与小微企业为重点',
              url: 'http://www.mof.gov.cn/',
              source: '财政部' }
        ],
        market: [
            { title: 'A股三大指数集体收涨，两市成交额突破1.5万亿元',
              url: 'https://finance.eastmoney.com/',
              source: '东方财富' },
            { title: '北向资金单日净买入超百亿，创年内新高',
              url: 'https://finance.eastmoney.com/',
              source: '东方财富' },
            { title: '科创板做市商扩容至20家，市场流动性有望进一步提升',
              url: 'https://finance.eastmoney.com/',
              source: '东方财富' }
        ]
    },
    international: {
        'international-economy': [
            { title: 'IMF：上调2025年全球经济增长预期至3.3%，中国贡献仍居首位',
              url: 'https://www.imf.org/en/Publications/WEO',
              source: 'IMF' },
            { title: '美国12月非农就业新增25.6万人，远超市场预期',
              url: 'https://www.bls.gov/news.release/empsit.nr0.htm',
              source: 'U.S. BLS' },
            { title: '欧元区12月CPI同比上涨2.4%，通胀继续向目标回落',
              url: 'https://ec.europa.eu/eurostat',
              source: 'Eurostat' }
        ],
        'financial-markets': [
            { title: '美联储维持利率不变，点阵图暗示年内或降息两次',
              url: 'https://www.federalreserve.gov/',
              source: 'Federal Reserve' },
            { title: '国际金价突破2700美元/盎司，再创历史新高',
              url: 'https://www.reuters.com/markets/commodities/',
              source: 'Reuters' },
            { title: '美元指数走弱，非美货币普遍反弹，人民币汇率小幅升值',
              url: 'https://www.reuters.com/markets/currencies/',
              source: 'Reuters' }
        ],
        'global-policy': [
            { title: 'G20财长会议聚焦全球贸易、债务与供应链韧性议题',
              url: 'https://g20.org/',
              source: 'G20' },
            { title: '欧盟宣布对华电动汽车反补贴调查终裁结果，商务部回应',
              url: 'https://ec.europa.eu/',
              source: 'European Commission' },
            { title: 'OPEC+决定延长自愿减产至2025年底，油价小幅震荡',
              url: 'https://www.opec.org/',
              source: 'OPEC' }
        ]
    }
};

function renderNews(type, category) {
    const list = type === 'domestic'
        ? document.getElementById('domestic-news')
        : document.getElementById('international-news');
    if (!list) return;

    const dataArray = newsDatabase[type]?.[category] || [];
    if (dataArray.length === 0) {
        list.innerHTML = '<li>暂无相关新闻</li>';
        return;
    }

    list.innerHTML = dataArray.map(item => {
        const title  = typeof item === 'string' ? item  : (item.title  || '');
        const url    = typeof item === 'string' ? ''    : (item.url    || '');
        const source = typeof item === 'string' ? ''    : (item.source || '');

        const safeTitle  = title.replace(/</g, '&lt;');
        const sourceHtml = source ? `<span class="news-source">· ${source}</span>` : '';

        if (url) {
            return `<li>
                <a href="${url}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>
                ${sourceHtml}
            </li>`;
        }
        return `<li>${safeTitle}${sourceHtml}</li>`;
    }).join('');
}
// ================================
// 14.5 实时新闻加载（失败保留静态数据）
// ================================
let currentDomesticTab = 'economy';
let currentInternationalTab = 'international-economy';

// ★ 经济/金融领域关键词（与后端 /api/news 白名单同源），保证国内新闻只推经济相关
const ECON_KW = /股市|股票|A股|基金|债券|期货|期权|央行|货币|利率|降准|降息|LPR|CPI|GDP|PPI|PMI|汇率|人民币|美元|美联储|银行|证券|券商|投资|融资|IPO|上市|财报|业绩|营收|净利|并购|重组|资本|经济|金融|财政|税务|税收|关税|贸易|进出口|出口|消费|零售|房地产|楼市|地产|创业板|科创板|北交所|港股|美股|中概|大宗商品|黄金|原油|石油|量化|公募|私募|保险|信托|外汇|证监会|交易所|上市公司|市值|分红/;

async function loadNewsFromApi() {
    try {
        const res = await fetch('/api/news', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();

        // 只在返回非空数组时才覆盖，否则保留静态
        if (json.domestic && json.domestic.length > 0) {
            // ★ 经济领域过滤 + 固定 3 条（后端 /api/news 已过滤，此处兼容未重启的旧后端）
            const econ = json.domestic.filter(n => ECON_KW.test((n && n.title) || ''));
            newsDatabase.domestic.economy = econ.slice(0, 3);
        }
        if (json.international && json.international.length > 0) {
            newsDatabase.international['international-economy'] = json.international;
        }

        renderNews('domestic', currentDomesticTab);
        renderNews('international', currentInternationalTab);
        console.log('✅ 实时新闻已加载');
    } catch (e) {
        // 静默失败，页面继续显示静态新闻
        console.warn('实时新闻获取失败，保留静态数据', e);
    }
}
document.querySelectorAll('.news-tabs').forEach(tabsContainer => {
    const type = tabsContainer.dataset.newsType;
    tabsContainer.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            tabsContainer.querySelectorAll('.tab').forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');
            renderNews(type, this.dataset.category);
        });
    });
});
renderNews('domestic', 'economy');
renderNews('international', 'international-economy');

// ===============================
// 15. 职业发展
// ===============================
const jobData = [
    { id:1, title:'投行分析师', company:'中金公司', location:'上海', salary:'30-50K·16薪', category:'investment', tags:['IPO','并购'], link:'https://www.zhipin.com/web/geek/job?query=%E6%8A%95%E8%A1%8C%E5%88%86%E6%9E%90%E5%B8%88&city=101020100' },
    { id:2, title:'风险控制经理', company:'平安银行', location:'深圳', salary:'25-40K·15薪', category:'risk', tags:['信用风险','模型验证'], link:'https://www.zhipin.com/web/geek/job?query=%E9%A3%8E%E9%99%A9%E6%8E%A7%E5%88%B6%E7%BB%8F%E7%90%86&city=101280600' },
    { id:3, title:'量化研究员', company:'幻方量化', location:'北京', salary:'40-70K·14薪', category:'quant', tags:['Python','机器学习'], link:'https://www.zhipin.com/web/geek/job?query=%E9%87%8F%E5%8C%96%E7%A0%94%E7%A9%B6%E5%91%98&city=101010100' },
    { id:4, title:'行业研究员', company:'中信证券', location:'上海', salary:'20-35K·16薪', category:'research', tags:['TMT','消费'], link:'https://www.zhipin.com/web/geek/job?query=%E8%A1%8C%E4%B8%9A%E7%A0%94%E7%A9%B6%E5%91%98&city=101020100' },
    { id:5, title:'金融科技产品经理', company:'蚂蚁集团', location:'杭州', salary:'35-60K·15薪', category:'fintech', tags:['区块链','支付'], link:'https://www.zhipin.com/web/geek/job?query=%E9%87%91%E8%9E%8D%E7%A7%91%E6%8A%80%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101210100' },
    { id:6, title:'投行助理', company:'华泰证券', location:'北京', salary:'18-30K·14薪', category:'investment', tags:['债券','ABS'], link:'https://www.zhipin.com/web/geek/job?query=%E6%8A%95%E8%A1%8C%E5%8A%A9%E7%90%86&city=101010100' },
    { id:7, title:'量化开发工程师', company:'九坤投资', location:'深圳', salary:'45-75K·14薪', category:'quant', tags:['C++','高频交易'], link:'https://www.zhipin.com/web/geek/job?query=%E9%87%8F%E5%8C%96%E5%BC%80%E5%8F%91%E5%B7%A5%E7%A8%8B%E5%B8%88&city=101280600' },
    { id:8, title:'风控建模专家', company:'京东数科', location:'北京', salary:'30-55K·15薪', category:'risk', tags:['评分卡','反欺诈'], link:'https://www.zhipin.com/web/geek/job?query=%E9%A3%8E%E6%8E%A7%E5%BB%BA%E6%A8%A1&city=101010100' },
    { id:9, title:'行业研究助理', company:'广发证券', location:'广州', salary:'15-25K·14薪', category:'research', tags:['汽车','新能源'], link:'https://www.zhipin.com/web/geek/job?query=%E8%A1%8C%E4%B8%9A%E7%A0%94%E7%A9%B6%E5%8A%A9%E7%90%86&city=101280100' },
    { id:10, title:'金融科技开发', company:'腾讯金融科技', location:'深圳', salary:'40-65K·16薪', category:'fintech', tags:['分布式','微服务'], link:'https://www.zhipin.com/web/geek/job?query=%E9%87%91%E8%9E%8D%E7%A7%91%E6%8A%80%E5%BC%80%E5%8F%91&city=101280600' }
];

function renderJobs(category = 'all') {
    const container = document.getElementById('job-list');
    const filtered = category === 'all' ? jobData : jobData.filter(job => job.category === category);
    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">暂无该类别职位</div>';
        return;
    }
    let html = '';
    filtered.forEach(job => {
        html += `
        <div class="job-item" onclick="if('${job.link}' && '${job.link}' !== '#'){window.open('${job.link}', '_blank');}" style="cursor:pointer;">
            <div class="job-info">
                <div class="job-title">${job.title}</div>
                <div class="job-company">${job.company}</div>
                <div class="job-meta">
                    <span>📍 ${job.location}</span>
                    <span>📅 ${job.tags.join('、')}</span>
                </div>
            </div>
            <div class="job-salary">${job.salary}</div>
        </div>
        `;
    });
    container.innerHTML = html;
}

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        renderJobs(this.dataset.category);
    });
});

// ===============================
// 16. 初始化
// ===============================
document.addEventListener('DOMContentLoaded', function() {
    initChart();
    setupMarketControls();
    startRealtimeLoop();
    loadNewsFromApi();
    if (document.getElementById('job-list')) {
        renderJobs('all');
    }
});
// ===============================
// 书籍数据（共 32 本 · 数组顺序 = 书架顺序）
// ===============================
// 字段说明：
//   titleCn    中文书名
//   titleEn    英文书名
//   author     作者（中文名 / 英文名）
//   tags       标签数组，如 ['宏观经济学', '教材']
//   intro      中文简介
//   introEn    英文简介
//   cover      封面路径。写 '' 表示这本就是没有封面图，改用「编号 + 书名」占位。
//              ⚠️ 2026-09-23 重排书架后改成**逐本显式指定**——否则封面路径跟着 id 走，
//              一重排封面就整体错位。
//   textbookId 对应 data/media/textbooks.json 里的 id；配了它，详情弹窗里才会
//              出现「📖 阅读原文」按钮。
// 省略 cover 时仍会按 assets/books/<两位 id>.png 自动补全（兜底，以后加新书可用）。
// ===============================

const BOOK_COVER_DIR = 'assets/books/';
const BOOK_COVER_EXT = '.png';     // ← 扩展名改成 .png（若改成 .jpg 只需改这里）

const BOOKS = [
/* 01 */ { id: 1,  titleCn: '经济变迁的演化理论', titleEn: 'An Evolutionary Theory of Economic Change', author: 'Richard R. Nelson, Sidney G. Winter', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '演化经济学的奠基之作，用惯例、搜寻、选择解释技术与产业如何变迁。', introEn: '', textbookId: 'nelson-winter-1982', cover: BOOK_COVER_DIR + 'tb-nelson-winter-1982.jpg' },
/* 02 */ { id: 2,  titleCn: '黑箱之内：技术与经济学', titleEn: 'Inside the Black Box: Technology and Economics', author: 'Nathan Rosenberg', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '把技术当作内生变量，讲清创新如何发生、为何不以最优方式发生。', introEn: '', textbookId: 'rosenberg-1982', cover: BOOK_COVER_DIR + 'tb-rosenberg-1982.jpg' },
/* 03 */ { id: 3,  titleCn: '财富的杠杆：技术创造力与经济进步', titleEn: 'The Lever of Riches: Technological Creativity and Economic Progress', author: 'Joel Mokyr', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '跨越千年的技术史，回答为什么有的文明持续创新、有的停滞。', introEn: '', textbookId: 'mokyr-1990', cover: BOOK_COVER_DIR + 'tb-mokyr-1990.jpg' },
/* 04 */ { id: 4,  titleCn: '雅典娜的礼物：知识经济的起源', titleEn: 'The Gifts of Athena: Historical Origins of the Knowledge Economy', author: 'Joel Mokyr', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '提出「有用知识」与「工业启蒙」，解释知识存量如何转化为增长。', introEn: '', textbookId: 'mokyr-2002', cover: '' },
/* 05 */ { id: 5, titleCn: '流动的文化', titleEn: 'Cultures in Motion', author: 'Daniel T. Rodgers, Bhavani Raman, Helmut Reimitz (eds.)', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '从文化流动的视角看观念与制度如何在空间之间传播、杂交与变形。', introEn: '', textbookId: 'rodgers-2014', cover: BOOK_COVER_DIR + 'tb-rodgers-2014.jpg' },
/* 06 */ { id: 6, titleCn: '技术革命与金融资本', titleEn: 'Technological Revolutions and Financial Capital: The Dynamics of Bubbles and Golden Ages', author: 'Carlota Perez', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '技术革命—金融泡沫—黄金时代的周期框架，理解产业与资本市场的共振。', introEn: '', textbookId: 'perez-2002', cover: BOOK_COVER_DIR + 'tb-perez-2002.jpg' },
/* 07 */ { id: 7, titleCn: '增长经济学', titleEn: 'The Economics of Growth', author: 'Philippe Aghion, Peter Howitt', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '把熊彼特式创新写进增长模型，系统讲清创新、竞争与增长的关系。', introEn: '', textbookId: 'aghion-howitt-2009', cover: BOOK_COVER_DIR + 'tb-aghion-howitt-2009.jpg' },
/* 08 */ { id: 8, titleCn: '美国增长的起落', titleEn: 'The Rise and Fall of American Growth: The U.S. Standard of Living since the Civil War', author: 'Robert J. Gordon', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '用 1870 年以来的生活细节论证：20 世纪那段特殊高增长难以重现。', introEn: '', textbookId: 'gordon-2016', cover: BOOK_COVER_DIR + 'tb-gordon-2016.jpg' },
/* 09 */ { id: 9, titleCn: '技术陷阱', titleEn: 'The Technology Trap: Capital, Labor, and Power in the Age of Automation', author: 'Carl Benedikt Frey', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '从工业革命看自动化与就业，讲清技术进步为何会先带来阵痛。', introEn: '', textbookId: 'frey-2019', cover: BOOK_COVER_DIR + 'tb-frey-2019.jpg' },
/* 10 */ { id: 10, titleCn: '第二次机器革命（法文版）', titleEn: 'Le Deuxième Âge de la machine (The Second Machine Age)', author: 'Erik Brynjolfsson, Andrew McAfee', tags: ['技术创新与经济增长', '法文版 · EPUB'], intro: '数字化技术如何重塑生产率、就业与收入分配（法文译本，正文为法文）。', introEn: '', textbookId: 'brynjolfsson-2014-fr', cover: BOOK_COVER_DIR + 'tb-brynjolfsson-2014-fr.jpg' },
/* 11 */ { id: 11, titleCn: '人工智能经济学', titleEn: 'The Economics of Artificial Intelligence: An Agenda', author: 'Ajay Agrawal, Joshua Gans, Avi Goldfarb (eds.)', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: 'AI 作为「预测成本下降」的技术，对劳动、竞争与政策意味着什么。', introEn: '', textbookId: 'agrawal-2019', cover: BOOK_COVER_DIR + 'tb-agrawal-2019.jpg' },
/* 12 */ { id: 12, titleCn: '权力与进步', titleEn: 'Power and Progress: Our Thousand-Year Struggle Over Technology and Prosperity', author: 'Daron Acemoglu, Simon Johnson', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '技术本身不保证共享繁荣，取决于权力结构与社会选择。', introEn: '', textbookId: 'acemoglu-2023', cover: BOOK_COVER_DIR + 'tb-acemoglu-2023.jpg' },
/* 13 */ { id: 13, titleCn: '创造性破坏的力量', titleEn: 'The Power of Creative Destruction: Economic Upheaval and the Wealth of Nations', author: 'Philippe Aghion, Céline Antonin, Simon Bunel', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '用「创造性破坏」串起增长、不平等、竞争政策与社会流动。', introEn: '', textbookId: 'aghion-2021', cover: BOOK_COVER_DIR + 'tb-aghion-2021.jpg' },
/* 14 */ { id: 14, titleCn: '把饼做大', titleEn: 'Grow the Pie: How Great Companies Deliver Both Purpose and Profit', author: 'Alex Edmans', tags: ['公司治理与战略', '英文原版 · PDF'], intro: '用实证回应「企业目的 vs 股东利润」之争：长期价值来自做大价值总量。', introEn: '', textbookId: 'edmans-2020', cover: BOOK_COVER_DIR + 'tb-edmans-2020.jpg' },
/* 15 */ { id: 15, titleCn: '战略管理：利益相关者方法', titleEn: 'Strategic Management: A Stakeholder Approach', author: 'R. Edward Freeman', tags: ['公司治理与战略', '英文原版 · PDF'], intro: '利益相关者理论的源头，重构了「企业为谁而经营」的框架。', introEn: '', textbookId: 'freeman-1984', cover: '' },
/* 16 */ { id: 16, titleCn: '应用兼并与收购', titleEn: 'Applied Mergers and Acquisitions', author: 'Robert F. Bruner', tags: ['并购重组', '英文原版 · PDF'], intro: '并购实务的系统教程：估值、交易结构、谈判、整合与失败教训。', introEn: '', textbookId: 'bruner-2004', cover: BOOK_COVER_DIR + 'tb-bruner-2004.jpg' },
/* 17 */ { id: 17, titleCn: '兼并与收购及公司重组', titleEn: 'Mergers, Acquisitions, and Corporate Restructurings', author: 'Patrick A. Gaughan', tags: ['并购重组', '英文原版 · PDF'], intro: '并购与重组的全景教材：法律、监管、会计、估值与实证证据。', introEn: '', textbookId: 'gaughan-ma', cover: BOOK_COVER_DIR + 'tb-gaughan-ma.jpg' },
/* 18 */ { id: 18, titleCn: '接管、重组与公司治理', titleEn: 'Takeovers, Restructuring, and Corporate Governance', author: 'J. Fred Weston, Mark L. Mitchell, J. Harold Mulherin', tags: ['并购重组', '英文原版 · PDF'], intro: '从公司治理视角讲接管与重组，是美国并购研究的经典参考。', introEn: '', textbookId: 'weston-takeovers', cover: BOOK_COVER_DIR + 'tb-weston-takeovers.jpg' },
/* 19 */ { id: 19, titleCn: '兼并与收购及其他重组活动', titleEn: 'Mergers, Acquisitions, and Other Restructuring Activities', author: 'Donald M. DePamphilis', tags: ['并购重组', '英文原版 · PDF'], intro: '以流程为主线讲并购全生命周期，案例与实务工具最全的一本。', introEn: '', textbookId: 'depamphilis-ma', cover: '' },
/* 20 */ { id: 20, titleCn: '融资、并购与公司控制（第2版）', titleEn: '', author: '周春生', tags: ['并购重组', '中文版 · EPUB'], intro: '中文教材视角：融资决策、并购交易与公司控制权安排的中国实践。', introEn: '', textbookId: 'zhousheng-rongzi-binggou', cover: BOOK_COVER_DIR + 'tb-zhousheng-rongzi-binggou.jpg' },
/* 21 */ { id: 21, titleCn: '有限理性模型：经济分析与公共政策', titleEn: 'Models of Bounded Rationality: Economic Analysis and Public Policy', author: 'Herbert A. Simon', tags: ['思想与决策基础', '英文原版 · PDF'], intro: '有限理性与满意化决策的论文集，行为经济学与组织理论的源头之一。', introEn: '', textbookId: 'simon-bounded-rationality', cover: BOOK_COVER_DIR + 'tb-simon-bounded-rationality.jpg' },
/* 22 */ { id: 22, titleCn: '凯利资本增长投资准则：理论与实践', titleEn: 'The Kelly Capital Growth Investment Criterion: Theory and Practice', author: 'Leonard C. MacLean, Edward O. Thorp, William T. Ziemba (eds.)', tags: ['投资与资产管理', '英文原版 · EPUB'], intro: '把凯利公式从赌局推广到长期资产配置，讲清对数最优与下注比例的取舍。', introEn: '', textbookId: 'kelly-capital-growth', cover: BOOK_COVER_DIR + 'tb-kelly-capital-growth.jpg' },
/* 23 */ { id: 23, titleCn: '资产定价中的机器学习', titleEn: 'Machine Learning in Asset Pricing', author: 'Stefan Nagel', tags: ['投资与资产管理', '英文原版 · PDF'], intro: '用机器学习方法做资产定价的实证入门：如何避免过拟合与「伪因子」。', introEn: '', textbookId: 'nagel-ml-asset-pricing', cover: '' },
/* 24 */ { id: 24, titleCn: '面向资产管理者的机器学习', titleEn: 'Machine Learning for Asset Managers', author: 'Marcos M. López de Prado', tags: ['投资与资产管理', '英文原版 · PDF'], intro: '面向从业者的精简读本：特征提取、聚类、去噪与组合构建的实操方法。', introEn: '', textbookId: 'lopezdeprado-ml-asset-managers', cover: BOOK_COVER_DIR + 'tb-lopezdeprado-ml-asset-managers.jpg' },
/* 25 */ { id: 25, titleCn: '第二次机器革命', titleEn: 'The Second Machine Age: Work, Progress, and Prosperity in a Time of Brilliant Technologies', author: 'Erik Brynjolfsson, Andrew McAfee', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '英文原版（书架里另有一本法文译本）：数字化技术如何重塑生产率、就业与收入分配。', introEn: '', textbookId: 'second-machine-age-en', cover: BOOK_COVER_DIR + 'tb-second-machine-age-en.jpg' },
/* 26 */ { id: 26, titleCn: '企业、契约与财务结构', titleEn: 'Firms, Contracts, and Financial Structure', author: 'Oliver Hart', tags: ['公司治理与战略', '英文原版 · PDF'], intro: '不完全契约与剩余控制权的经典专著，公司治理与资本结构理论的基石。', introEn: '', textbookId: 'hart-1995-firms', cover: BOOK_COVER_DIR + 'tb-hart-1995-firms.jpg' },
/* 27 */ { id: 27, titleCn: '个人主义与经济秩序', titleEn: 'Individualism and Economic Order', author: 'F. A. Hayek', tags: ['思想与决策基础', '英文原版 · PDF'], intro: '分散知识、自发秩序与市场过程的经典文集，奥地利学派的方法论宣言。', introEn: '', textbookId: 'hayek-individualism', cover: BOOK_COVER_DIR + 'tb-hayek-individualism.jpg' },
/* 28 */ { id: 28, titleCn: '控制论革命者：智利阿连德时期的技术与政治', titleEn: 'Cybernetic Revolutionaries: Technology and Politics in Allende\'s Chile', author: 'Eden Medina', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '以 Cybersyn 项目为切口，讲技术设计与政治制度如何相互塑造。', introEn: '', textbookId: 'medina-cybernetic-revolutionaries', cover: BOOK_COVER_DIR + 'tb-medina-cybernetic-revolutionaries.jpg' },
/* 29 */ { id: 29, titleCn: '信息为何增长：从原子到经济的秩序演化', titleEn: 'Why Information Grows: The Evolution of Order, from Atoms to Economies', author: 'César Hidalgo', tags: ['技术创新与经济增长', '英文原版 · EPUB'], intro: '用「信息/知识如何被固化进物质」解释经济增长与产业复杂度。', introEn: '', textbookId: 'hidalgo-why-information-grows', cover: BOOK_COVER_DIR + 'tb-hidalgo-why-information-grows.jpg' },
/* 30 */ { id: 30, titleCn: '信息规则：网络经济的策略指导', titleEn: 'Information Rules: A Strategic Guide to the Network Economy', author: 'Carl Shapiro, Hal R. Varian', tags: ['技术创新与经济增长', '英文原版 · PDF'], intro: '信息产品的定价、锁定与标准竞争——网络经济学的奠基读物。', introEn: '', textbookId: 'shapiro-varian-information-rules', cover: BOOK_COVER_DIR + 'tb-shapiro-varian-information-rules.jpg' },
/* 31 */ { id: 31, titleCn: 'GDP：一段简史', titleEn: 'GDP: A Brief but Affectionate History', author: 'Diane Coyle', tags: ['思想与决策基础', '英文原版 · PDF'], intro: 'GDP 这个指标怎么来的、量到了什么、又漏掉了什么。', introEn: '', textbookId: 'coyle-gdp', cover: BOOK_COVER_DIR + 'tb-coyle-gdp.jpg' },
/* 32 */ { id: 32, titleCn: '科学革命的结构（50 周年纪念版）', titleEn: 'The Structure of Scientific Revolutions', author: 'Thomas S. Kuhn', tags: ['思想与决策基础', '英文原版 · PDF'], intro: '范式、常规科学与科学革命——研究方法的元问题，也是「知识图谱」的思想背景。', introEn: '', textbookId: 'kuhn-scientific-revolutions', cover: BOOK_COVER_DIR + 'tb-kuhn-scientific-revolutions.jpg' }
];

// 自动补全封面路径（只补「没写 cover」的；写了空串表示这本就是没有封面图，别覆盖，
// 注意这里必须用 === undefined —— `if (!b.cover)` 会把 '' 也当成没写）
BOOKS.forEach(b => {
    if (b.cover === undefined) {
        b.cover = BOOK_COVER_DIR + String(b.id).padStart(2, '0') + BOOK_COVER_EXT;
    }
});

// ---------- 渲染书架 ----------
function renderBookshelf() {
    const row1 = document.getElementById('bookshelfRow1');
    const row2 = document.getElementById('bookshelfRow2');
    if (!row1 || !row2) return;

    const half = Math.ceil(BOOKS.length / 2);
    const rows = [BOOKS.slice(0, half), BOOKS.slice(half)];

    [row1, row2].forEach((rowEl, idx) => {
        rowEl.innerHTML = rows[idx].map(book => {
            const no = String(book.id).padStart(2, '0');
            const hasTitle = !!book.titleCn;
            const label = hasTitle ? book.titleCn : '待补充';
            const hoverText = hasTitle
                ? book.titleCn
                : `第 ${book.id} 本 · 待补充`;
            // 没有封面图（cover 为空）时干脆不输出 img，免得白打一个 404
            const coverImg = book.cover
                ? `<img src="${book.cover}" alt="${label}" loading="lazy" draggable="false"
                        onerror="this.style.display='none';">`
                : '';

            return `
            <div class="book-item" data-id="${book.id}">
                <div class="book-cover">
                    <!-- 占位文字写在前面，img 写在后面，谁后写谁在上层 -->
                    <span class="cover-fallback">
                        <span class="fb-no">${no}</span>
                        <span class="fb-label">${label}</span>
                    </span>
                    ${coverImg}
                </div>
                <span class="book-name">${hoverText}</span>
            </div>
            `;
        }).join('');
    });
}
// ===============================
// 18. 课程书架 · 独立初始化（兜底）
// ===============================
(function initBookshelfModule() {
    function run() {
        // 只在存在书架时才执行
        if (!document.getElementById('bookshelf')) return;

        if (typeof renderBookshelf === 'function') renderBookshelf();
        if (typeof initBookshelfScroll === 'function') initBookshelfScroll();

        // 详情页关闭事件
        const mask = document.getElementById('bookDetailMask');
        const closeBtn = document.getElementById('detailClose');

        if (closeBtn) closeBtn.addEventListener('click', closeBookDetail);
        if (mask) {
            mask.addEventListener('click', function (e) {
                if (e.target === mask) closeBookDetail();
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeBookDetail();
        });
    }

    // 若 DOM 还在加载，等加载完再跑；否则立刻跑
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
// ===============================
// 17.5 课程书架 · 滚动与详情函数
// ===============================

function initBookshelfScroll() {
    const shelf = document.getElementById('bookshelf');
    const track = document.getElementById('bookshelfTrack');
    if (!shelf || !track) return;

    if (shelf.dataset.scrollInited === '1') return;
    shelf.dataset.scrollInited = '1';

    let target = 0;
    let current = 0;
    let maxScroll = 0;
    let rafId = null;

    let isDragging = false;
    let dragStartX = 0;
    let dragStartTarget = 0;
    let movedDistance = 0;
    let pointerDownTarget = null;   // 记录按下的目标，供 pointerup 判断

    function computeMax() {
        maxScroll = Math.max(0, track.scrollWidth - shelf.clientWidth);
    }
    function apply() {
        track.style.transform = `translate3d(${-current}px, 0, 0)`;
    }
    function tick() {
        const diff = target - current;
        if (Math.abs(diff) < 0.4) { current = target; apply(); rafId = null; return; }
        current += diff * 0.14;
        apply();
        rafId = requestAnimationFrame(tick);
    }
    function requestTick() { if (rafId === null) rafId = requestAnimationFrame(tick); }
    function setTarget(v) { target = Math.max(0, Math.min(maxScroll, v)); requestTick(); }

    // 滚轮 → 水平滚动
    shelf.addEventListener('wheel', function (e) {
        if (maxScroll <= 0) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 18 : 1;
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setTarget(target + dx * unit * 1.5);
    }, { passive: false });

    // pointerdown：只记录起点，不捕获指针
    shelf.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 && e.button !== 1) return;
        isDragging = true;
        movedDistance = 0;
        dragStartX = e.clientX;
        dragStartTarget = target;
        pointerDownTarget = e.target;    // 记下按下的位置
        shelf.classList.add('dragging');
    });

    // pointermove / pointerup 绑到 document
    document.addEventListener('pointermove', function (e) {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        movedDistance = Math.max(movedDistance, Math.abs(dx));
        setTarget(dragStartTarget - dx);
    });

    document.addEventListener('pointerup', function (e) {
        if (!isDragging) return;
        isDragging = false;
        shelf.classList.remove('dragging');

        // 位移小于 6px → 判定为点击
        if (movedDistance <= 6 && pointerDownTarget) {
            const item = pointerDownTarget.closest ? pointerDownTarget.closest('.book-item') : null;
            if (item) openBookDetail(item.dataset.id);
        }
        pointerDownTarget = null;
    });

    document.addEventListener('pointercancel', function () {
        if (!isDragging) return;
        isDragging = false;
        shelf.classList.remove('dragging');
        pointerDownTarget = null;
    });

    window.addEventListener('resize', function () {
        computeMax();
        target = Math.min(target, maxScroll);
        current = Math.min(current, maxScroll);
        apply();
    });
    window.addEventListener('load', computeMax);

    computeMax();
    apply();
    console.log('✅ 书架滚动已初始化，maxScroll =', maxScroll);
}

function openBookDetail(id) {
    const book = BOOKS.find(b => b.id === Number(id));
    if (!book) return;

    const mask = document.getElementById('bookDetailMask');
    const cover = document.getElementById('detailCover');
    const fallback = document.getElementById('detailCoverFallback');

    fallback.textContent = book.titleCn || ('第 ' + book.id + ' 本 · 待补充');
    if (book.cover) {
        cover.style.visibility = 'hidden';
        cover.onload = function () { this.style.visibility = 'visible'; };
        cover.onerror = function () { this.style.visibility = 'hidden'; };
        cover.src = book.cover;
    } else {
        // 没有封面图：连 src 都不给，免得浏览器去请求空地址
        cover.removeAttribute('src');
        cover.style.visibility = 'hidden';
    }

    document.getElementById('detailTitleCn').textContent = book.titleCn || ('第 ' + book.id + ' 本 · 待补充');
    document.getElementById('detailTitleEn').textContent = book.titleEn || '';
    document.getElementById('detailAuthor').textContent = book.author ? ('作者：' + book.author) : '作者：待补充';

    const tagsEl = document.getElementById('detailTags');
    tagsEl.innerHTML = (book.tags && book.tags.length)
        ? book.tags.map(t => `<span>${t}</span>`).join('')
        : '';

    // ★ 收藏 + 笔记操作条
    let actionsEl = document.getElementById('detailActions');
    if (!actionsEl) {
        actionsEl = document.createElement('div');
        actionsEl.id = 'detailActions';
        actionsEl.className = 'detail-actions';
        tagsEl.after(actionsEl);
    }
    if (window.ProfileUI) {
        actionsEl.innerHTML =
            window.ProfileUI.favoriteBtnHTML('book', book.id,
                { variant: 'text' }) +
            window.ProfileUI.noteBtnHTML('book', book.id,
                { variant: 'text' });
        window.ProfileUI.bindAll(actionsEl);
        actionsEl.querySelectorAll('[data-pui-id]').forEach(b => {
            b.dataset.puiTitle = book.titleCn || ('第 ' + book.id + ' 本');
        });
    }

    document.getElementById('detailIntro').textContent = book.intro || '（中文简介待补充）';
    document.getElementById('detailIntroEn').textContent = book.introEn || '';

    // ★ 电子版阅读入口（2026-09-23）：只有配了 textbookId 的书才显示
    renderDetailReadEntry(book, actionsEl);

    mask.classList.add('show');
    document.body.style.overflow = 'hidden';
    setTimeout(() => renderBookGraph(book.id), 60);
}

// ===============================
// 17.5 书籍详情 · 电子版阅读入口
// --------------------------------------------------------------
// 电子版清单在后端 data/media/textbooks.json（由 scripts/import_textbooks.py 生成），
// 正文由 /assets/textbooks/ 提供；点「阅读原文」调 js/textbook-reader.js 的 TextbookReader.open()。
// 想给某本书挂上电子版：在该书 BOOKS 条目里加 textbookId: '清单里的 id' 即可。
// 没有 textbookId 的书统一显示一句「电子版暂未上传」——否则用户会以为按钮漏了
// （例如第 1–5 本只有知识图谱/视频，没有电子书文件）。
// ===============================
function renderDetailReadEntry(book, anchorEl) {
    let el = document.getElementById('detailRead');
    if (!el) {
        el = document.createElement('div');
        el.id = 'detailRead';
        el.className = 'detail-read';
        const anchor = anchorEl || document.getElementById('detailTags');
        if (anchor) anchor.after(el); else return;
    }

    const tid = book.textbookId;
    if (!tid || !window.TextbookReader) {
        el.hidden = false;
        el.innerHTML = '<span class="detail-read-none">电子版暂未上传</span>' +
            '<span class="detail-read-hint">上传后这里会出现「📖 阅读原文」</span>';
        return;
    }

    el.hidden = false;
    el.innerHTML =
        '<button type="button" class="detail-read-btn" id="detailReadBtn">📖 阅读原文</button>' +
        '<span class="detail-read-hint">电子版已在服务器上，直接在这里打开（PDF / EPUB），不用下载</span>';
    el.querySelector('#detailReadBtn').addEventListener('click', function () {
        window.TextbookReader.open(tid);
    });
}
// ===============================
// 17.6 书籍详情 · 知识图谱（宏观章层小图）
// --------------------------------------------------------------
// 对接后端时，只需改 fetchBookGraph() 一个函数。
// 期望返回格式（与 backend/controller/schemas.GraphData 一致）：
//   {
//     nodes: [{ id, label, type, ... }],   // 字段契约见《字段.md》：label/type
//     edges: [{ source, target, relation }]
//   }
// ===============================

// ★ 页面由后端 :8000 单端口托管（同源），用相对路径即可
const BOOK_GRAPH_API = '/api/graph/book';

// ★ 节点七色配色：红橙黄绿青蓝紫，按节点 id 哈希稳定分配（与 galaxy.js 规则一致）
const NODE_COLORS = ['#c0392b', '#e67e22', '#f0b400', '#27ae60', '#16a085', '#2980b9', '#8e44ad'];
function nodeColorOf(node) {
    let h = 0;
    const s = String(node.id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return NODE_COLORS[h % NODE_COLORS.length];
}

// ★ 字段契约统一：后端 type 值域为 concept/chapter/section/formula（《字段.md》，Agent 层依赖），
//   前端样式类为 center/primary/secondary —— 此处做一层映射，不改后端契约。
const TYPE_TO_CLS = { chapter: 'center', section: 'primary', concept: 'secondary', formula: 'secondary' };
function bgClassOf(d) {
    if (d.type === 'center' || d.type === 'primary' || d.type === 'secondary') return d.type; // 兼容示例数据
    return TYPE_TO_CLS[d.type] || 'secondary';
}

let _bgSim = null;
let _bgSvgSel = null;
let _bgRoot = null;
let _bgInited = false;

// ---------- 1. 数据层：本地示例图谱（未命名） ----------
function _bgSeededRandom(seed) {
    let s = (seed || 1) * 9301 + 49297;
    return function () {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
}

function buildSampleBookGraph(bookId) {
    const rand = _bgSeededRandom(bookId);

    const primaryCount   = 5 + Math.floor(rand() * 3);   // 5 ~ 7
    const secondaryCount = 3 + Math.floor(rand() * 4);   // 3 ~ 6

    const nodes = [];
    const edges = [];

    // 中心：当前书籍（name 留空，等后端注入）
    nodes.push({ id: '__book__', type: 'chapter',  role: 'center',    label: '', r: 26 });
    // 一级邻居
    const primaryIds = [];
    for (let i = 0; i < primaryCount; i++) {
        const id = 'p' + i;
        primaryIds.push(id);
        nodes.push({ id,            type: 'concept',  role: 'primary',   label: '', r: 13 });
        edges.push({ source: '__book__', target: id, relation: '' });
    }

    // 二级邻居
    for (let i = 0; i < secondaryCount; i++) {
        const id = 's' + i;
        nodes.push({ id,            type: 'concept',  role: 'secondary', label: '', r: 8 });
        const parent = primaryIds[Math.floor(rand() * primaryIds.length)];
        edges.push({ source: parent, target: id, relation: '' });
    }

    // 一级之间的横向连接（网状感）
    const crossCount = Math.floor(primaryCount / 2);
    let added = 0, guard = 0;
    while (added < crossCount && guard++ < 40) {
        const a = primaryIds[Math.floor(rand() * primaryIds.length)];
        const b = primaryIds[Math.floor(rand() * primaryIds.length)];
        if (a !== b) {
            edges.push({ source: a, target: b, relation: '', weak: true });
            added++;
        }
    }

    return { nodes, edges };
}

// ---------- 2. 数据层：真实接口 ----------
async function fetchBookGraph(bookId) {
    // ★ 已接后端 /api/graph/book/{bookId}（返回该书的宏观章层小图）
    try {
        const res  = await fetch(`${BOOK_GRAPH_API}/${bookId}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.message || '后端错误');
        const g = json.data || {};
        // 后端契约字段为 label/type；补齐渲染层所需的 name/role/r
        return {
            nodes: (g.nodes || []).map(n => ({
                ...n,
                name: n.label || n.name || '',
                role: bgClassOf(n),
                r: n.type === 'chapter' ? 20 : (n.type === 'section' ? 13 : 9),
            })),
            edges: g.edges || [],
        };
    } catch (e) {
        console.warn('[BookGraph] 接口失败，降级为示例数据', e);
        return buildSampleBookGraph(bookId);
    }
}

// ---------- 3. 渲染层 ----------
let _bgZoomBehavior = null;      // ★ 新增：保存 zoom 行为
let _bgLastSize = { w: 0, h: 0 }; // ★ 新增：用于 resize 时保持视图中心

function _bgEnsureSvg() {
    const svgEl = document.getElementById('bookGraphSvg');
    if (!svgEl || typeof d3 === 'undefined') return false;

    if (!_bgInited) {
        _bgSvgSel = d3.select(svgEl);
        _bgSvgSel.selectAll('*').remove();
        _bgRoot = _bgSvgSel.append('g').attr('class', 'bg-root');
        _bgRoot.append('g').attr('class', 'bg-links');
        _bgRoot.append('g').attr('class', 'bg-nodes');

        // ★ 新增：缩放行为
        _bgZoomBehavior = d3.zoom()
            .scaleExtent([0.4, 3])          // 缩放范围 40% ~ 300%
            .on('zoom', (evt) => {
                if (_bgRoot) _bgRoot.attr('transform', evt.transform);
            })
            // ★ 关键：拖节点时不触发缩放/平移
            .filter((evt) => {
                if (evt.type === 'dblclick') return false;
                const t = evt.target;
                return !(t && t.closest && t.closest('.bg-node'));
            });

        _bgSvgSel.call(_bgZoomBehavior)
            // 双击空白：重置视图
            .on('dblclick.zoom', null)
            .on('dblclick.reset', () => {
                const { w, h } = _bgLastSize;
                _bgSvgSel.transition().duration(450).call(
                    _bgZoomBehavior.transform,
                    d3.zoomIdentity.translate(w / 2, h / 2).scale(1)
                );
            });

        _bgInited = true;
    }
    _bgResize();
    return true;
}

function _bgResize() {
    if (!_bgSvgSel || !_bgZoomBehavior) return;

    const box = _bgSvgSel.node().parentElement.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;

    const prevW = _bgLastSize.w;
    const prevH = _bgLastSize.h;
    _bgLastSize = { w: box.width, h: box.height };

    _bgSvgSel
        .attr('viewBox', `0 0 ${box.width} ${box.height}`)
        .attr('preserveAspectRatio', 'xMidYMid meet');

    const curT = d3.zoomTransform(_bgSvgSel.node());

    if (prevW === 0 || prevH === 0) {
        // 首次：把 (0,0) 平移到画布中心
        _bgSvgSel.call(
            _bgZoomBehavior.transform,
            d3.zoomIdentity.translate(box.width / 2, box.height / 2).scale(1)
        );
    } else if (prevW !== box.width || prevH !== box.height) {
        // 尺寸变化：保持 k 不变，仅补偿中心位移
        const dx = (box.width  - prevW) / 2;
        const dy = (box.height - prevH) / 2;
        _bgSvgSel.call(_bgZoomBehavior.transform, curT.translate(dx, dy));
    }
}

async function renderBookGraph(bookId) {
    if (!_bgEnsureSvg()) return;

       // ★ 新增：每打开一本书，把视图重置到中心 scale=1
    if (_bgZoomBehavior && _bgSvgSel) {
        const { w, h } = _bgLastSize;
        _bgSvgSel.call(
            _bgZoomBehavior.transform,
            d3.zoomIdentity.translate(w / 2, h / 2).scale(1)
        );
    }


    if (_bgSim) { _bgSim.stop(); _bgSim = null; }

    const loadingEl = document.getElementById('bookGraphLoading');
    if (loadingEl) loadingEl.classList.add('show');

    const data = await fetchBookGraph(bookId);

    if (loadingEl) loadingEl.classList.remove('show');
    if (!data || !data.nodes) return;

    // 复制一份，避免污染源数据
    const nodes = data.nodes.map(n => ({ ...n }));
    const links = data.edges.map(e => ({ ...e }));

    _bgSim = d3.forceSimulation(nodes)
        .force('link',    d3.forceLink(links).id(d => d.id)
                            .distance(l => l.weak ? 90 : 70)
                            .strength(l => l.weak ? 0.15 : 0.6))
        .force('charge',  d3.forceManyBody().strength(-220))
        .force('collide', d3.forceCollide(d => d.r + 10))
        .force('center',  d3.forceCenter(0, 0));

    // ---- 连线 ----
    const linkSel = _bgRoot.select('.bg-links')
        .selectAll('.bg-link')
        .data(links, d => `${d.source.id || d.source}|${d.target.id || d.target}`);
    linkSel.exit().remove();
    const linkMerged = linkSel.enter().append('line')
        .attr('class', 'bg-link')
        .merge(linkSel)
        .attr('class', d => 'bg-link' + (d.weak ? ' weak' : ''));

    // ---- 节点 ----
    const nodeSel = _bgRoot.select('.bg-nodes')
        .selectAll('.bg-node')
        .data(nodes, d => d.id);
    nodeSel.exit().remove();

    const nodeEnter = nodeSel.enter()
        .append('g')
        .attr('class', d => `bg-node ${d.role || 'secondary'}`)

    nodeEnter.append('circle').attr('r', d => d.r);
    nodeEnter.append('text')
        .attr('class', d => `bg-label ${d.type}`)
        .attr('dy', d => d.r + 14)
        .text(d => d.name || '');

    const nodeMerged = nodeEnter.merge(nodeSel);
    nodeMerged.select('circle')
        .attr('r', d => d.r)
        .style('fill', d => nodeColorOf(d));   // ★ 七色配色（id 哈希稳定分配）
    nodeMerged.select('text').text(d => d.name || '');

    // ---- 拖拽节点 ----
    nodeMerged.call(
        d3.drag()
            .on('start', (evt, d) => {
                if (!evt.active) _bgSim.alphaTarget(0.3).restart();
                d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (evt, d) => { d.fx = evt.x; d.fy = evt.y; })
            .on('end', (evt, d) => {
                if (!evt.active) _bgSim.alphaTarget(0);
                d.fx = null; d.fy = null;
            })
    );

    // ---- tick ----
    _bgSim.on('tick', () => {
        linkMerged
            .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        nodeMerged.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

function clearBookGraph() {
    if (_bgSim) { _bgSim.stop(); _bgSim = null; }
    // ★ 关键：把初始化状态也一并复位，
    //   下次打开新书时 _bgEnsureSvg 会重新建 <g class="bg-links"> / <g class="bg-nodes">
    if (_bgSvgSel) _bgSvgSel.selectAll('*').remove();

    _bgRoot        = null;
    _bgInited      = false;
    _bgZoomBehavior = null;
    _bgLastSize    = { w: 0, h: 0 };
    
}

// 窗口缩放时重算 SVG 尺寸（仅当详情页打开时）
window.addEventListener('resize', () => {
    const mask = document.getElementById('bookDetailMask');
    if (mask && mask.classList.contains('show')) _bgResize();
});

function closeBookDetail() {
    const mask = document.getElementById('bookDetailMask');
    if (!mask || !mask.classList.contains('show')) return;
    mask.classList.remove('show');
    document.body.style.overflow = '';
    clearBookGraph();   // ★ 新增
}

// 书架初始化（独立于其他模块，防止被别处的 return 提前中断）
(function initBookshelfModule() {
    function run() {
        if (!document.getElementById('bookshelf')) return;
        if (typeof renderBookshelf === 'function') renderBookshelf();
        if (typeof initBookshelfScroll === 'function') initBookshelfScroll();

        const mask = document.getElementById('bookDetailMask');
        const closeBtn = document.getElementById('detailClose');

        if (closeBtn) closeBtn.addEventListener('click', closeBookDetail);
        if (mask) {
            mask.addEventListener('click', function (e) {
                if (e.target === mask) closeBookDetail();
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeBookDetail();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
// ===============================
// 19. 科学研究 · 三大顶刊数据
// ===============================
// 字段说明：
//   title     论文标题（英文，蓝色链接）
//   authors   作者（黑色）
//   source    实际出处（可选；不填则显示所属期刊名）
//   year      年份
//   volume    卷号
//   issue     期号
//   pages     页码
//   cited     引用次数（红色，暂缺填 0 → 显示"—"）
//   tags      关键词（红色小标签）
//   pdf       PDF 路径（相对根目录）
//
// ★ PDF 命名约定：
//     按 assets/papers/{期刊}-{序号}.pdf 命名，全部 13 篇已放入（2026-09-15）
//     例：jf-01.pdf、jfe-03.pdf、rfs-04.pdf
//     rfs 共 5 篇；文件不存在时，点击会自动提示"待补充"，不会报错
// ===============================

const JOURNALS = {

    /* ---------------- JF ---------------- */
    jf: {
        abbr: 'JF',
        nameEn: 'The Journal of Finance',
        nameCn: '《金融学杂志》',
        meta: 'American Finance Association · Est. 1946',
        desc: '金融学历史最悠久、影响力最广的顶级期刊之一，由美国金融学会主办。' +
              '覆盖资产定价、公司金融、金融市场微观结构、行为金融等全部核心方向，' +
              '是金融学界公认的三大顶刊之一。',
        papers: [
            {
                title: 'Interest Rates and Return on Equity of Deposit Money Banks in Nigeria (1990–2024)',
                authors: 'Ekujereonye, B., Ndugbu, M. O., & Otiwu, K. C.',
                source: 'Journal of Finance, Governance and Strategic Studies',
                year: 2026, volume: '9', issue: '1', pages: '',
                cited: 0,
                tags: ['利率', '银行盈利', '尼日利亚'],
                pdf: 'assets/papers/jf-01.pdf'
            },
            {
                title: 'An Empirical Study on Implementation of AI & ML in Stock Market Prediction',
                authors: 'Venkatarathnam, N., & Goranta, L. R.',
                source: 'Indian Journal of Information Sources and Services',
                year: 2024, volume: '14', issue: '4', pages: '165–174',
                cited: 0,
                tags: ['人工智能', '机器学习', '股票预测'],
                pdf: 'assets/papers/jf-02.pdf'
            },
            {
                title: 'Presidential Address: Corporate Finance and Reality',
                authors: 'Graham, J. R.',
                source: 'The Journal of Finance',
                year: 2022, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['公司金融', '资本配置', '实地调研'],
                pdf: 'assets/papers/jf-03.pdf'
            },
            {
                title: 'From Prediction to Decision: AI-Augmented Risk Systems and Capital Allocation in Regulated Financial Institutions',
                authors: 'Shivakumar, S.',
                source: 'Working Paper (BridgeYield)',
                year: '', volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['AI 风控', '资本配置', '合规'],
                pdf: 'assets/papers/jf-04.pdf'
            }
        ]
    },

    /* ---------------- JFE ---------------- */
    jfe: {
        abbr: 'JFE',
        nameEn: 'Journal of Financial Economics',
        nameCn: '《金融经济学杂志》',
        meta: 'Elsevier · Est. 1974',
        desc: '公司金融与金融经济学领域的旗舰期刊，以发表具有长期影响力的理论' +
              '与实证研究著称。代理理论、资本结构、股利政策、并购重组等经典文献' +
              '多首发于此。',
        papers: [
            {
                title: 'Dual Peer Effects and Cross-Stock Predictability',
                authors: 'Avramov, D., Ge, S., Li, S., & Linton, O.',
                source: 'Working Paper (Jan 2026)',
                year: 2026, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['同行效应', '横截面预测'],
                pdf: 'assets/papers/jfe-01.pdf'
            },
            {
                title: 'Agency Cost of Free Cash Flow, Capital Allocation, and Payouts',
                authors: 'DeAngelo, H., Kahle, K., & Skinner, D. J.',
                source: 'Working Paper (May 2025)',
                year: 2025, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['代理成本', '自由现金流', '股利政策'],
                pdf: 'assets/papers/jfe-02.pdf'
            },
            {
                title: 'Policy Uncertainty Reduces Green Innovation',
                authors: 'Wang, M., Wurgler, J., & Zhang, H.',
                source: 'Working Paper (Oct 2025)',
                year: 2025, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['政策不确定性', '绿色创新'],
                pdf: 'assets/papers/jfe-03.pdf'
            },
            {
                title: 'The Invention of Corporate Governance',
                authors: 'Ma, Y., & Shleifer, A.',
                source: 'NBER Working Paper 33710',
                year: 2025, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['公司治理', '金融史'],
                pdf: 'assets/papers/jfe-04.pdf'
            }
        ]
    },

    /* ---------------- RFS ---------------- */
    rfs: {
        abbr: 'RFS',
        nameEn: 'Review of Financial Studies',
        nameCn: '《金融研究评论》',
        meta: 'Society for Financial Studies · Est. 1988',
        desc: '金融学三大顶刊中最年轻的一本，由金融研究学会主办。以理论创新与' +
              '严谨实证并重，在行为金融、市场微观结构、国际金融、金融计量等' +
              '方向持续产出高影响力成果。',
        papers: [
            {
                title: 'Long Rates, Life Insurers, and Credit Spreads',
                authors: 'Li, Z.',
                source: 'Working Paper (Aug 2026)',
                year: 2026, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['长期利率', '信用利差', '保险公司'],
                pdf: 'assets/papers/rfs-01.pdf'
            },
            {
                title: 'Beliefs and Portfolios: Causal Evidence',
                authors: 'Beutel, J., & Weber, M.',
                source: 'NBER Working Paper 34489',
                year: 2025, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['信念', '资产组合'],
                pdf: 'assets/papers/rfs-02.pdf'
            },
            {
                title: 'Government Intervention in the Financial Market',
                authors: 'Wang, J.',
                source: 'NBER Working Paper 33827',
                year: 2025, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['政府干预', '金融市场'],
                pdf: 'assets/papers/rfs-03.pdf'
            },
            {
                title: 'In Safe Hands: The Financial and Real Impact of Investor Composition Over the Credit Cycle',
                authors: 'Coppola, A.',
                source: 'Working Paper (Jun 2024)',
                year: 2024, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['投资者结构', '信用周期', '债券'],
                pdf: 'assets/papers/rfs-04.pdf'
            },
            {
                title: 'Effects of Credit Expansions on Stock Market Booms and Busts',
                authors: 'Hansman, C., Hong, H., Jiang, W., Liu, Y.-J., & Meng, J.-J.',
                source: 'NBER Working Paper 24586',
                year: 2018, volume: '', issue: '', pages: '',
                cited: 0,
                tags: ['信贷扩张', '股市泡沫'],
                pdf: 'assets/papers/rfs-05.pdf'
            }
        ]
    }
};

// ===============================
// 20. 科学研究 · 交互逻辑
// ===============================

let currentJournalKey = null;

/* ---------- 工具：转义 ---------- */
function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

/* ---------- 渲染期刊列表 ---------- */
function renderJournal(key) {
    const j = JOURNALS[key];
    if (!j) return;
    currentJournalKey = key;

    // 头部
    document.getElementById('jdAbbr').textContent    = j.abbr;
    document.getElementById('jdName').textContent    = j.nameEn;
    document.getElementById('jdNameCn').textContent  = j.nameCn;
    document.getElementById('jdMeta').textContent    = j.meta;
    document.getElementById('jdDesc').textContent    = j.desc;

    // 排序（按引用次数降序）
    const papers = j.papers.slice().sort((a, b) => (b.cited || 0) - (a.cited || 0));

    document.getElementById('jdCount').textContent = `共 ${papers.length} 篇文献`;

    // 列表
    const listEl = document.getElementById('scholarList');
    listEl.innerHTML = papers.map((p, idx) => {
        const srcParts = [];
        if (p.year)   srcParts.push(escHtml(p.year));
        if (p.volume) srcParts.push(`Vol. ${escHtml(p.volume)}`);
        if (p.issue)  srcParts.push(`No. ${escHtml(p.issue)}`);
        if (p.pages)  srcParts.push(`pp. ${escHtml(p.pages)}`);

        // ★ source 字段：论文实际出处（多数是工作论文/其他期刊，非三大顶刊，避免误导）
        const srcName = p.source || j.nameEn;
        const srcLine = srcParts.length
            ? `<div class="si-source"><span class="si-journal">${escHtml(srcName)}</span>，${srcParts.join('，')}</div>`
            : `<div class="si-source"><span class="si-journal">${escHtml(srcName)}</span></div>`;

        const tagsHtml = (p.tags && p.tags.length)
            ? `<div class="si-tags">${p.tags.map(t => `<span>${escHtml(t)}</span>`).join('')}</div>`
            : '';

        const hasPdf = !!(p.pdf && p.pdf.length);

        return `
        <div class="scholar-item" data-idx="${idx}">
            <div class="si-main">
                <div class="si-title" data-idx="${idx}">${escHtml(p.title)}</div>
                <div class="si-authors">${escHtml(p.authors)}</div>
                ${srcLine}
                ${tagsHtml}
            </div>
            <div class="si-side">
                <div class="si-cite">
                    <b>${p.cited ? p.cited.toLocaleString('en-US') : '—'}</b>
                    cited by
                </div>
                <div class="si-actions">
                    ${window.ProfileUI ? window.ProfileUI.favoriteBtnHTML('paper', `${key}::${p.title}`, { size: 'sm' }) : ''}
                    ${window.ProfileUI ? window.ProfileUI.noteBtnHTML('paper', `${key}::${p.title}`, { size: 'sm' }) : ''}
                    <button class="si-pdf-btn" data-idx="${idx}" ${hasPdf ? '' : 'disabled style="opacity:.45;cursor:not-allowed;"'}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                            stroke="currentColor" stroke-width="1.8"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        <span>${hasPdf ? 'PDF 原文' : '待补充'}</span>
                    </button>
                </div>
            </div>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                         stroke="currentColor" stroke-width="1.8"
                         stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                    <span>${hasPdf ? 'PDF 原文' : '待补充'}</span>
                </button>
            </div>
        </div>`;
    }).join('');
    if (window.ProfileUI) window.ProfileUI.bindAll(listEl);

    // 绑定：标题点击 / PDF 按钮点击
    listEl.querySelectorAll('.si-title, .si-pdf-btn').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.idx);
            const paper = papers[idx];
            if (!paper || !paper.pdf) {
                showPaperToast('该论文 PDF 待补充');
                return;
            }
            openPdf(paper);
        });
    });
}

/* ---------- 简易 toast ---------- */
let _paperToastTimer = null;
function showPaperToast(msg) {
    let el = document.getElementById('paperToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'paperToast';
        el.style.cssText = `
            position:fixed; left:50%; top:32px; transform:translateX(-50%) translateY(-12px);
            padding:10px 24px; border-radius:20px;
            background:rgba(129,28,33,.94); color:#fff;
            font-family:"Source Han Serif SC","思源宋体",serif;
            font-size:13.5px; letter-spacing:.5px;
            opacity:0; pointer-events:none;
            transition:.32s; z-index:1200;
            box-shadow:0 10px 30px rgba(129,28,33,.35);`;
        document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(_paperToastTimer);
    _paperToastTimer = setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(-12px)';
    }, 2200);
}

/* ---------- PDF 模态 ---------- */
async function checkPdfExists(url) {
    try {
        const res = await fetch(encodeURI(url), { method: 'HEAD' });
        if (res.ok) return true;
        // 部分服务器不支持 HEAD，退回 Range GET
        if (res.status === 405) {
            const r2 = await fetch(encodeURI(url), {
                method: 'GET',
                headers: { 'Range': 'bytes=0-0' }
            });
            return r2.ok || r2.status === 206;
        }
        return false;
    } catch {
        return false;
    }
}

async function openPdf(paper) {
    const mask     = document.getElementById('pdfMask');
    const frame    = document.getElementById('pdfFrame');
    const fallback = document.getElementById('pdfFallback');
    const fbText   = document.getElementById('pdfFallbackText');
    const titleEl  = document.getElementById('pdfTitle');
    const openLink = document.getElementById('pdfOpenNew');

    if (!mask || !frame) return;

    const url = encodeURI(paper.pdf);
    // ★ 2026-09-15：每次打开都用带时间戳的新地址 + #page=1，关掉浏览器内置 PDF 阅读器的
    //   "回到上次阅读位置"（同一 URL 会被它记住上次滚动位置）
    const viewUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() + '#page=1';


    titleEl.textContent = paper.title;
    openLink.href = url;

    // 先显示 loading 态
    fallback.style.display = 'none';
    frame.style.display = 'block';
    frame.src = 'about:blank';

    mask.classList.add('show');
    document.body.style.overflow = 'hidden';

    const exists = await checkPdfExists(paper.pdf);

    if (exists) {
        frame.src = viewUrl;
    } else {
        frame.style.display = 'none';
        fallback.style.display = 'flex';
        fbText.textContent = '原文 PDF 待补充';
    }
}

function closePdf() {
    const mask  = document.getElementById('pdfMask');
    const frame = document.getElementById('pdfFrame');
    if (!mask || !mask.classList.contains('show')) return;

    mask.classList.remove('show');
    document.body.style.overflow = '';

    // 延迟清空，避免关闭动画中白屏闪烁
    setTimeout(() => {
        if (frame) frame.src = 'about:blank';
    }, 320);
}

/* ---------- 视图切换 ---------- */
function showJournalDetail(key) {
    const ov = document.getElementById('journalOverview');
    const dt = document.getElementById('journalDetail');
    if (!ov || !dt) return;

    renderJournal(key);
    ov.style.display = 'none';
    dt.style.display = 'block';

    // 平滑滚动到板块顶部
    const sec = document.getElementById('paper');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showJournalOverview() {
    const ov = document.getElementById('journalOverview');
    const dt = document.getElementById('journalDetail');
    if (!ov || !dt) return;

    dt.style.display = 'none';
    ov.style.display = 'block';

    const sec = document.getElementById('paper');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- 模块初始化 ---------- */
(function initJournalModule() {
    function run() {
        const svg = document.querySelector('.journal-triangle');
        if (!svg) return;

        // 扇区点击 / 键盘
        svg.querySelectorAll('.jt-sector').forEach(sec => {
            sec.addEventListener('click', () => showJournalDetail(sec.dataset.journal));
            sec.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showJournalDetail(sec.dataset.journal);
                }
            });
        });

        // 返回按钮
        const backBtn = document.getElementById('journalBack');
        if (backBtn) backBtn.addEventListener('click', showJournalOverview);

        // PDF 关闭（按钮 / 点遮罩 / Esc）
        const pdfMask  = document.getElementById('pdfMask');
        const pdfClose = document.getElementById('pdfClose');
        if (pdfClose) pdfClose.addEventListener('click', closePdf);
        if (pdfMask) {
            pdfMask.addEventListener('click', e => {
                if (e.target === pdfMask) closePdf();
            });
        }
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closePdf();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
// ---------- 时长工具 ----------
function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

// 同一 src 只探测一次（同页面内缓存）
const _durationCache = new Map();

// 探测单个视频的真实时长（只加载元数据，不下载整个文件）
function probeVideoDuration(v) {
    if (!v || !v.src) return Promise.resolve(null);

    // 命中缓存
    if (_durationCache.has(v.src)) {
        const cached = _durationCache.get(v.src);
        if (cached) {
            v.duration = cached;
            updateDurationInDOM(v);
        }
        return Promise.resolve(cached);
    }

    return new Promise(resolve => {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        el.src = v.src;

        let finished = false;
        const finish = (dur) => {
            if (finished) return;
            finished = true;

            // 清理，避免内存占用
            try {
                el.removeAttribute('src');
                el.load();
            } catch (_) {}

            if (dur) {
                v.duration = dur;
                _durationCache.set(v.src, dur);
                updateDurationInDOM(v);
            } else {
                // 探测失败：保留 JSON 里的 duration（如果有）或留空
                _durationCache.set(v.src, null);
            }
            resolve(dur);
        };

        el.addEventListener('loadedmetadata', () => {
            finish(formatDuration(el.duration));
        });
        el.addEventListener('error', () => finish(null));

        // 兜底超时（8 秒还没加载出元数据就放弃）
        setTimeout(() => finish(null), 8000);
    });
}

// 探测成功后同步刷新页面上的时长显示
function updateDurationInDOM(v) {
    // 网格封面角标
    const badge = document.querySelector(
        `.study-item[data-id="${v.id}"] .study-duration`
    );
    if (badge) badge.textContent = v.duration || '';

    // 播放页标题下方的统计信息（如果里面有写时长）
    const statsEl = document.getElementById('spStats');
    if (statsEl && statsEl.dataset.videoId === String(v.id)) {
        // 假设 spStats 里包含了时长，可以在这里重绘
        // 目前的实现里 spStats 只有 views + date，不用改；预留
    }
}
// ===============================
// 21. 学习资料 · 视频清单加载（外置 JSON 版）
// ===============================
// 约定：
//   清单 → data/videos.json
//   视频 → assets/videos/01.mp4 ~ NN.mp4
//   封面 → assets/videos/01-cover.jpg（可选，自动探测 .jpg/.png/.jpeg/.webp）
//
// 加新视频只需：
//   ① 丢视频进 assets/videos/，命名为下一个编号
//   ② 在 data/videos.json 的 videos 数组末尾追加一条
// ===============================
const VIDEO_MANIFEST_URL = 'data/videos.json';
const LOCAL_VIDEO_DIR    = 'assets/videos/';
const LOCAL_VIDEO_EXT    = '.mp4';
const LOCAL_COVER_EXTS   = ['.jpg', '.png', '.jpeg', '.webp'];

let VIDEO_DATA   = [];    // 由 loadVideoManifest 填充
let CAROUSEL_IDS = [];    // 轮播推荐的视频 id

// 清单加载失败时的兜底（假设目录里有 N 个视频，信息用占位）
const FALLBACK_VIDEO_COUNT = 23;

function buildFallbackData() {
    return Array.from({ length: FALLBACK_VIDEO_COUNT }, (_, i) => {
        const id = i + 1;
        const no = String(id).padStart(2, '0');
        return {
            id,
            title: `视频 ${no}`,
            author: '待补充',
            tags: [],
            duration: '',
            views: '',
            date: '',
            desc: '（该视频信息待补充，请检查 data/videos.json 是否可正常访问）',
            src: `${LOCAL_VIDEO_DIR}${no}${LOCAL_VIDEO_EXT}`,
            cover: '',
            _no: no
        };
    });
}

async function loadVideoManifest() {
    try {
        const res = await fetch(VIDEO_MANIFEST_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const manifest = await res.json();

        const list = Array.isArray(manifest) ? manifest : (manifest.videos || []);
        if (!list.length) throw new Error('videos 数组为空');

        VIDEO_DATA = list.map((raw, idx) => {
            const id = Number.isFinite(raw.id) ? raw.id : (idx + 1);
            const no = String(id).padStart(2, '0');
            return {
                id,
                title:    raw.title    || `视频 ${no}`,
                author:   raw.author   || '未署名',
                tags:     Array.isArray(raw.tags) ? raw.tags : [],
                duration: raw.duration || '',
                views:    raw.views    || '',
                date:     raw.date     || '',
                desc:     raw.desc     || '',
                src:      raw.src || `${LOCAL_VIDEO_DIR}${no}${LOCAL_VIDEO_EXT}`,
                cover:    raw.cover || '',
                _no:      no
            };
        });

        if (Array.isArray(manifest.carousel) && manifest.carousel.length) {
            CAROUSEL_IDS = manifest.carousel;
        } else {
            CAROUSEL_IDS = VIDEO_DATA.slice(0, 5).map(v => v.id);
        }

        VIDEO_DATA.forEach(probeCover);
        console.log(`✅ 学习资料：已加载 ${VIDEO_DATA.length} 个视频`);
        return true;

    } catch (e) {
        console.warn('[学习资料] 清单加载失败，使用兜底数据：', e.message);
        VIDEO_DATA = buildFallbackData();
        CAROUSEL_IDS = VIDEO_DATA.slice(0, 5).map(v => v.id);
        VIDEO_DATA.forEach(probeCover);
        return false;
    }
}

// 探测本地封面
function probeCover(v) {
    if (v.cover) return;
    tryCover(`${LOCAL_VIDEO_DIR}${v._no}-cover`, 0, v);
}
function tryCover(base, idx, v) {
    if (idx >= LOCAL_COVER_EXTS.length) {
        v.cover = `https://picsum.photos/seed/sufe-video-${v.id}/640/360`;
        return;
    }
    const url = base + LOCAL_COVER_EXTS[idx];
    const img = new Image();
    img.onload = () => { v.cover = url; refreshVideoCover(v.id); };
    img.onerror = () => tryCover(base, idx + 1, v);
    img.src = url;
}
function refreshVideoCover(id) {
    const v = VIDEO_DATA.find(x => x.id === id);
    if (!v) return;
    const gridImg = document.querySelector(`.study-item[data-id="${id}"] .study-item-cover img`);
    if (gridImg) gridImg.src = v.cover;
    const cIdx = CAROUSEL_IDS.indexOf(id);
    if (cIdx >= 0) {
        const slideImg = document.querySelector(`.carousel-slide:nth-child(${cIdx + 1}) img`);
        if (slideImg) slideImg.src = v.cover;
    }
}

// 依次探测 .jpg → .png → .jpeg → .webp
function tryNextCover(base, idx, videoObj) {
    if (idx >= LOCAL_COVER_EXTS.length) return;   // 全都不存在，保留 picsum 占位
    const probe = new Image();
    probe.onload = () => { videoObj.cover = base + LOCAL_COVER_EXTS[idx]; refreshVideoCover(videoObj.id); };
    probe.onerror = () => tryNextCover(base, idx + 1, videoObj);
    probe.src = base + LOCAL_COVER_EXTS[idx];
}

// 封面异步更新后，同步刷新已渲染的 DOM
function refreshVideoCover(id) {
    const v = VIDEO_DATA.find(x => x.id === id);
    if (!v) return;

    // 网格里的封面
    const gridImg = document.querySelector(`.study-item[data-id="${id}"] .study-item-cover img`);
    if (gridImg) gridImg.src = v.cover;

    // 轮播里的封面
    carouselItems.forEach((item, i) => {
        if (item.id === id) {
            const slideImg = document.querySelector(`.carousel-slide:nth-child(${i + 1}) img`);
            if (slideImg) slideImg.src = v.cover;
        }
    });
}

// ===============================
// 22. 学习资料 · 状态
// ===============================
let studyActiveTags = new Set();
let studySortAsc = true;

// ===============================
// 23. 学习资料 · 筛选与排序
// ===============================
function getFilteredVideos() {
    let list = VIDEO_DATA.slice();
    if (studyActiveTags.size > 0) {
        list = list.filter(v => v.tags.some(t => studyActiveTags.has(t)));
    }
    list.sort((a, b) => studySortAsc ? a.id - b.id : b.id - a.id);
    return list;
}

// ===============================
// 24. 学习资料 · 渲染视频网格
// ===============================
function renderStudyVideos() {
    const grid = document.getElementById('studyGrid');
    const emptyEl = document.getElementById('studyEmpty');
    if (!grid) return;

    // 清除旧视频项（保留轮播）
    grid.querySelectorAll('.study-item').forEach(el => el.remove());

    const list = getFilteredVideos();

    if (list.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    list.forEach(v => {
        const el = document.createElement('div');
        el.className = 'study-item';
        el.dataset.id = v.id;
        el.innerHTML = `
            <div class="study-item-cover">
                <img src="${v.cover}" alt="${v.title}" loading="lazy" draggable="false">
                ${v.duration ? `<span class="study-duration">${v.duration}</span>` : ''}
                <div class="study-item-fav-wrap">
                    ${window.ProfileUI ? window.ProfileUI.favoriteBtnHTML('video', v.id, { size: 'sm' }) : ''}
                </div>
            </div>
            <div class="study-item-title">${v.title}</div>
            <div class="study-item-author">${v.author}</div>
        `;
        el.addEventListener('click', () => openStudyPlayer(v));
        frag.appendChild(el);
    });
    grid.appendChild(frag);
    if (window.ProfileUI) window.ProfileUI.bindAll(grid);
}

// ===============================
// 25. 学习资料 · 自翻页轮播
// ===============================
let carouselTimer = null;
let carouselIdx = 0;
let carouselItems = [];

function initStudyCarousel() {
    const carousel = document.getElementById('studyCarousel');
    const track = document.getElementById('carouselTrack');
    const dotsEl = document.getElementById('carouselDots');
    const titleEl = document.getElementById('carouselTitle');
    const subEl = document.getElementById('carouselSub');
    if (!carousel || !track) return;

    carouselItems = CAROUSEL_IDS
        .map(id => VIDEO_DATA.find(v => v.id === id))
        .filter(Boolean);
    if (!carouselItems.length) carouselItems = VIDEO_DATA.slice(0, 5);
    if (!carouselItems.length) return;

    track.innerHTML = carouselItems.map(v => `
        <div class="carousel-slide">
            <img src="${v.cover}" alt="${v.title}" draggable="false">
        </div>
    `).join('');

    dotsEl.innerHTML = carouselItems.map((_, i) =>
        `<button class="carousel-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="第 ${i + 1} 张"></button>`
    ).join('');

    function goTo(i) {
        carouselIdx = ((i % carouselItems.length) + carouselItems.length) % carouselItems.length;
        track.style.transform = `translateX(-${carouselIdx * 100}%)`;
        titleEl.textContent = carouselItems[carouselIdx].title;
        subEl.textContent = carouselItems[carouselIdx].author;
        dotsEl.querySelectorAll('.carousel-dot').forEach((d, di) =>
            d.classList.toggle('active', di === carouselIdx));
    }

    function startAuto() {
        clearInterval(carouselTimer);
        carouselTimer = setInterval(() => goTo(carouselIdx + 1), 4000);
    }
    function stopAuto() { clearInterval(carouselTimer); }

    // 圆点点击
    dotsEl.addEventListener('click', (e) => {
        const dot = e.target.closest('.carousel-dot');
        if (!dot) return;
        e.stopPropagation();
        goTo(Number(dot.dataset.index));
        startAuto();
    });

    // 悬停暂停
    carousel.addEventListener('mouseenter', stopAuto);
    carousel.addEventListener('mouseleave', startAuto);

    // 点击轮播 → 打开当前视频
    carousel.addEventListener('click', () => openStudyPlayer(carouselItems[carouselIdx]));

    goTo(0);
    startAuto();
}

// ===============================
// 26. 学习资料 · 播放页
// ===============================
function openStudyPlayer(video) {
    const mask = document.getElementById('studyPlayerMask');
    const videoEl = document.getElementById('studyPlayerVideo');
    const placeholder = document.getElementById('spPlaceholder');
    if (!mask || !videoEl) return;

    document.getElementById('spHeadTitle').textContent = video.title;
    document.getElementById('spTitle').textContent = video.title;
    document.getElementById('spAuthor').textContent = video.author;
    document.getElementById('spStats').textContent = `${video.views} 次播放 · ${video.date}`;
    document.getElementById('spTags').innerHTML = video.tags.map(t => `<span>${t}</span>`).join('');
    document.getElementById('spDesc').textContent = video.desc;
        // ★ 收藏 + 笔记操作条
    const spActionsWrap = document.createElement('div');
    spActionsWrap.className = 'sp-actions';
    if (window.ProfileUI) {
        spActionsWrap.innerHTML =
            window.ProfileUI.favoriteBtnHTML('video', video.id,
                { variant: 'text', size: 'sm' }) +
            window.ProfileUI.noteBtnHTML('video', video.id,
                { variant: 'text', size: 'sm' });
        document.getElementById('spTags').after(spActionsWrap);
        window.ProfileUI.bindAll(spActionsWrap);
        // 更新笔记按钮的 dataset.puiTitle（可选，用于弹窗副标题）
        spActionsWrap.querySelectorAll('[data-pui-id]').forEach(b => {
            b.dataset.puiTitle = video.title;
        });
    }
    // 重置倍速
    videoEl.playbackRate = 1;
    document.querySelectorAll('#spSpeed .speed-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.speed === '1');
    });

        // 清理旧的事件监听（防止多次打开时叠加）
    videoEl.onerror = null;
    videoEl.onloadeddata = null;

    if (video.src) {
        videoEl.style.display = '';
        placeholder.style.display = 'none';
        videoEl.poster = video.cover;
        videoEl.src = video.src;

        // ★ 加载失败（404 / 格式不支持）→ 显示占位提示
        videoEl.onerror = () => {
            videoEl.style.display = 'none';
            placeholder.style.display = 'flex';
            // 顺手把占位文案改成更有信息的
            const tipEl = placeholder.querySelector('span');
            if (tipEl) tipEl.textContent = '视频尚未上传 · 请联系管理员';
        };

        // ★ 加载成功 → 确保占位隐藏
        videoEl.onloadeddata = () => {
            videoEl.style.display = '';
            placeholder.style.display = 'none';
        };
    } else {
        videoEl.style.display = 'none';
        placeholder.style.display = 'flex';
        videoEl.removeAttribute('src');
        videoEl.load();
        const tipEl = placeholder.querySelector('span');
        if (tipEl) tipEl.textContent = '视频内容待补充';
    }

    // 滚动区回到顶部
    const info = mask.querySelector('.study-player-info');
    if (info) info.scrollTop = 0;

    mask.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeStudyPlayer() {
    const mask = document.getElementById('studyPlayerMask');
    const videoEl = document.getElementById('studyPlayerVideo');
    if (!mask || !mask.classList.contains('show')) return;

    if (videoEl) {
        try { videoEl.pause(); } catch (_) {}
        videoEl.currentTime = 0;
    }
    mask.classList.remove('show');
    document.body.style.overflow = '';
}

// ===============================
// 27. 学习资料 · 模块初始化（异步加载清单版）
// ===============================
(function initStudyModule() {

    // ---------- 事件绑定（和数据无关，先绑上） ----------
    function bindStudyEvents() {

        // ① 标签筛选（可叠加多选）
        const tagsWrap = document.getElementById('studyTags');
        if (tagsWrap) {
            tagsWrap.addEventListener('click', (e) => {
                const btn = e.target.closest('.study-tag');
                if (!btn) return;
                const tag = btn.dataset.tag;
                if (studyActiveTags.has(tag)) {
                    studyActiveTags.delete(tag);
                    btn.classList.remove('active');
                } else {
                    studyActiveTags.add(tag);
                    btn.classList.add('active');
                }
                renderStudyVideos();
            });
        }

        // ② 清空所有标签
        const resetBtn = document.getElementById('studyReset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                studyActiveTags.clear();
                if (tagsWrap) {
                    tagsWrap.querySelectorAll('.study-tag')
                        .forEach(b => b.classList.remove('active'));
                }
                renderStudyVideos();
            });
        }

        // ③ 正序 / 倒序切换
        document.querySelectorAll('.study-sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.study-sort-btn')
                    .forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                studySortAsc = btn.dataset.order === 'asc';
                renderStudyVideos();
            });
        });

        // ④ 播放页倍速按钮
        const speedWrap = document.getElementById('spSpeed');
        if (speedWrap) {
            speedWrap.addEventListener('click', (e) => {
                const btn = e.target.closest('.speed-btn');
                if (!btn) return;
                const videoEl = document.getElementById('studyPlayerVideo');
                const speed = parseFloat(btn.dataset.speed);
                if (videoEl) videoEl.playbackRate = speed;
                speedWrap.querySelectorAll('.speed-btn')
                    .forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        }

        // ⑤ 关闭播放页（按钮 / 点遮罩 / Esc）
        const closeBtn = document.getElementById('studyPlayerClose');
        const mask = document.getElementById('studyPlayerMask');
        if (closeBtn) closeBtn.addEventListener('click', closeStudyPlayer);
        if (mask) {
            mask.addEventListener('click', (e) => {
                if (e.target === mask) closeStudyPlayer();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeStudyPlayer();
        });
    }

    // ---------- 主流程（异步） ----------
    async function run() {
        const grid = document.getElementById('studyGrid');
        if (!grid) return;

        // 1) 绑事件
        bindStudyEvents();

        // 2) 加载清单
        await loadVideoManifest();

        // 3) 先渲染（此时时长可能是 JSON 里的旧值或空）
        initStudyCarousel();
        renderStudyVideos();

        // 4) ★ 异步探测所有视频的真实时长，逐个刷新角标
        //    不 await，让页面先显示出来；时长探测完会自动更新
        probeAllDurations();
    }

    // 探测全部视频时长（串行 + 小间隔，避免瞬间打出太多请求）
    async function probeAllDurations() {
        for (const v of VIDEO_DATA) {
            await probeVideoDuration(v);
            // 每个之间留 30ms，减少并发压力，也让 UI 更新更顺滑
            await new Promise(r => setTimeout(r, 30));
        }
    }
    // ★ 缺失了这一段 ★
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
// ===============================
// 28. 回到顶部按钮
// ===============================
(function initBackTop() {
    function run() {
        const btn = document.getElementById('backTop');
        if (!btn) return;

        // 滚动超过 400px 才显示
        function onScroll() {
            if (window.scrollY > 400) {
                btn.classList.add('show');
            } else {
                btn.classList.remove('show');
            }
        }

        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();   // 初始状态

        btn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }
})();
// ===============================
// 29. 认证模块联动（★ 新增1）
// ===============================
// 说明：其余板块无需任何改动，auth.js 会自动接管登录页/导航栏/守卫。
// 下面只是让"知识助手"等模块知道当前是否登录，做条件渲染示范。
(function bindAuthIntegration() {
    if (!window.Auth) return;

    window.Auth.onChange(({ user, isLoggedIn }) => {
        // 示例：未登录时禁用悬浮球（知识助手需要图谱联动）
        const fab = document.getElementById('assistantFab');
        if (fab) {
            fab.style.display = isLoggedIn ? '' : 'none';
        }

        // 示例：登录态变化后刷新个人筛选（学习资料板块）
        if (typeof studyActiveTags !== 'undefined') {
            const saved = window.Auth.profile.getFilter('study');
            if (saved && Array.isArray(saved.tags)) {
                studyActiveTags.clear();
                saved.tags.forEach(t => studyActiveTags.add(t));
            }
        }

        console.log('[Auth] 状态变化：', isLoggedIn ? '已登录' : '未登录',
                    user ? `(${user.nickname || user.username})` : '');
    });
})();
// ===============================
// 30. 深色主题（★ 新增，同新版前端）
// ===============================
(function initTheme() {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() {
        document.body.classList.toggle('theme-night', mq.matches);
    }
    apply();
    mq.addEventListener('change', apply);
})();
(function initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    const KEY = 'sufe_theme';
    const saved = localStorage.getItem(KEY);

    if (saved === 'night')      document.body.classList.add('theme-night');
    else if (saved === 'day')   document.body.classList.remove('theme-night');
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
        document.body.classList.add('theme-night');

    if (!btn) return;
    btn.addEventListener('click', () => {
        const isNight = document.body.classList.toggle('theme-night');
        localStorage.setItem(KEY, isNight ? 'night' : 'day');
    });
})();