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
    { name: '恒生指数', secid: 'rt_hkHSI' },
    { name: '纳斯达克指数', secid: 'gb_ixic' }
];

const DEFAULT_VALUES = {
    '上证指数': 3940.55,
    '深证成指': 13703.21,
    '创业板指数': 3359.72,
    '恒生指数': 25317.18,
    '纳斯达克指数': 18562.34
};

// ===============================
// 4. 缓存管理（localStorage）
// ===============================
const CACHE_KEY_DATA = 'sufe_cache_data';
const CACHE_KEY_HISTORY = 'sufe_cache_history';

function getCachedData() {
    try {
        const raw = localStorage.getItem(CACHE_KEY_DATA);
        return raw ? JSON.parse(raw) : null;
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
                        return { time, price };
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
                            return context.parsed.y.toFixed(2);
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
                x: {
                    grid: { display: false },
                    ticks: {
                        maxTicksLimit: 20,
                        font: { size: 9, family: 'Times New Roman' }
                    }
                }
            }
        }
    });
}

// ===============================
// 10. 更新图表（使用真实K线历史）
// ===============================
function updateChart(stockName) {
    const stockData = cachedData ? cachedData.find(d => d.name === stockName) : null;
    if (stockData) {
        document.getElementById('currentStockName').textContent = stockName;
        document.getElementById('currentStockPrice').textContent = stockData.value;
        const changeClass = stockData.direction === '上涨' ? 'text-up' : 'text-down';
        document.getElementById('currentStockChange').innerHTML =
            `<span class="${changeClass}">${stockData.change}</span>`;
    }

    const history = cachedHistory ? cachedHistory[stockName] : null;
    if (chartInstance && history && history.length > 0) {
        const labels = history.map(p => {
            const d = new Date(p.time);
            return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        });
        const data = history.map(p => p.price);
        chartInstance.data.labels = labels;
        chartInstance.data.datasets[0].label = stockName;
        chartInstance.data.datasets[0].data = data;
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
    void track.offsetHeight;
    const contentWidth = textSpan.scrollWidth;
    const duration = Math.min(Math.max(contentWidth / 60, 10), 60);
    track.style.animationDuration = duration + 's';
    track.style.animation = 'scrollMove linear infinite';

    // B. 表格
    let tableHTML = '';
    dataArray.forEach(item => {
        const changeClass = item.direction === '上涨' ? 'text-up' : 'text-down';
        tableHTML += `
        <tr>
            <td>${item.name}</td>
            <td>${item.value}</td>
            <td>${item.direction}</td>
            <td class="${changeClass}">${item.change}</td>
        </tr>
        `;
    });
    document.getElementById('stock-data').innerHTML = tableHTML;

    // C. 图表
    updateChart(currentSelectedStock);
}

// ===============================
// 12. 股票选项卡切换
// ===============================
function setupStockTabs() {
    const tabs = document.querySelectorAll('.stock-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            tabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            currentSelectedStock = this.dataset.stock;
            if (cachedData) {
                updateChart(currentSelectedStock);
            }
        });
    });
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

// ===============================
// 14. 新闻（硬编码）
// ===============================
const newsDatabase = {
    domestic: {
        economy: [ "中国2026年一季度GDP同比增长5.2%，超市场预期", "CPI同比上涨0.3%，通胀水平温和可控", "制造业PMI连续四个月处于扩张区间" ],
        policy: [ "央行宣布下调存款准备金率0.25个百分点", "财政部发布新一轮减税降费政策清单", "金融监管总局强化资本市场风险防控" ],
        market: [ "A股三大指数集体走高，成交额突破万亿", "北向资金本周净流入超200亿元", "新能源板块领涨，市场情绪明显回暖" ]
    },
    international: {
        "international-economy": [ "IMF上调2026年全球经济增长预期至3.2%", "美国非农就业数据超预期，劳动力市场依然强劲", "欧元区通胀率降至2.1%，接近欧央行目标" ],
        "financial-markets": [ "美联储释放鸽派信号，全球股市应声上涨", "国际金价突破2400美元/盎司，再创历史新高", "美元指数持续走弱，非美货币普遍反弹" ],
        "global-policy": [ "G20财长会议达成共识，协调全球供应链政策", "欧盟正式通过《数字市场法案》最终修正案", "OPEC+宣布延长减产协议至2027年" ]
    }
};

function renderNews(type, category) {
    const list = type === 'domestic' ? document.getElementById('domestic-news') : document.getElementById('international-news');
    const dataArray = newsDatabase[type]?.[category] || ['暂无相关新闻'];
    list.innerHTML = dataArray.map(item => `<li>${item}</li>`).join('');
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
    setupStockTabs();
    startRealtimeLoop();
    if (document.getElementById('job-list')) {
        renderJobs('all');
    }
});
// ===============================
// 书籍数据（共 35 本 · 待填写）
// ===============================
// 封面路径自动生成：assets/books/01.png ~ 35.png
// 字段说明：
//   titleCn  中文书名
//   titleEn  英文书名
//   author   作者（中文名 / 英文名）
//   tags     标签数组，如 ['宏观经济学', '教材']
//   intro    中文简介
//   introEn  英文简介
// ===============================

const BOOK_COVER_DIR = 'assets/books/';
const BOOK_COVER_EXT = '.png';     // ← 扩展名改成 .png（若改成 .jpg 只需改这里）

const BOOKS = [
/* 01 */ { id: 1,  titleCn: '投资学（第十版）', titleEn: 'Investments, 10th Edition', author: '滋维·博迪、亚历克斯·凯恩、艾伦·J.马库斯', tags: ['投资学', '经典教材'], intro: '投资学领域公认的经典教材。系统讲解资产类别与金融工具、风险与收益、资产组合理论、证券分析、衍生品及投资业绩评估，是 CFA 等专业考试的核心参考书。', introEn: '' },
/* 02 */ { id: 2,  titleCn: '公司金融（进阶篇·原书第12版）', titleEn: 'Principles of Corporate Finance, 12th Edition', author: '理查德·A.布雷利 等', tags: ['公司金融', '经典教材'], intro: '公司金融领域经典教材的进阶部分，聚焦资本结构、股利政策、公司治理与并购重组等高级主题，适合已具备金融基础的高年级学生。', introEn: '' },
/* 03 */ { id: 3,  titleCn: '国际投资学（第二版）', titleEn: '', author: '卢勇进、杜奇华、杨立强', tags: ['国际投资', '教材'], intro: '系统介绍国际直接投资与国际间接投资的基本理论、运作方式与政策法规，结合中国企业"走出去"的实践案例。', introEn: '' },
/* 04 */ { id: 4,  titleCn: '并购与重组：中国案例', titleEn: '', author: '蔡荣鑫（编著）', tags: ['并购重组', '案例'], intro: '以中国资本市场真实并购重组事件为案例，剖析交易结构设计、估值定价与并购整合的要点。', introEn: '' },
/* 05 */ { id: 5,  titleCn: '金融理论（视频课程）', titleEn: 'Finance Theory', author: '安德鲁·罗（Andrew Lo）', tags: ['视频课程', '金融理论'], intro: 'MIT 金融理论课程视频（共 23 讲）：现值关系、固定收益证券、股票、远期与期货、期权、风险与收益、投资组合理论、CAPM 与 APT、资本预算与有效市场。', introEn: '' },
/* 06 */ { id: 6,  titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 07 */ { id: 7,  titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 08 */ { id: 8,  titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 09 */ { id: 9,  titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 10 */ { id: 10, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 11 */ { id: 11, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 12 */ { id: 12, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 13 */ { id: 13, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 14 */ { id: 14, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 15 */ { id: 15, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 16 */ { id: 16, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 17 */ { id: 17, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 18 */ { id: 18, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 19 */ { id: 19, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 20 */ { id: 20, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 21 */ { id: 21, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 22 */ { id: 22, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 23 */ { id: 23, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 24 */ { id: 24, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 25 */ { id: 25, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 26 */ { id: 26, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 27 */ { id: 27, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 28 */ { id: 28, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 29 */ { id: 29, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 30 */ { id: 30, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 31 */ { id: 31, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 32 */ { id: 32, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 33 */ { id: 33, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 34 */ { id: 34, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' },
/* 35 */ { id: 35, titleCn: '', titleEn: '', author: '', tags: [], intro: '', introEn: '' }
];

// 自动补全封面路径
BOOKS.forEach(b => {
    b.cover = BOOK_COVER_DIR + String(b.id).padStart(2, '0') + BOOK_COVER_EXT;
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

            return `
            <div class="book-item" data-id="${book.id}">
                <div class="book-cover">
                    <!-- 占位文字写在前面，img 写在后面，谁后写谁在上层 -->
                    <span class="cover-fallback">
                        <span class="fb-no">${no}</span>
                        <span class="fb-label">${label}</span>
                    </span>
                    <img src="${book.cover}" alt="${label}" loading="lazy" draggable="false"
                        onerror="this.style.display='none';">
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
    cover.style.visibility = 'hidden';
    cover.onload = function () { this.style.visibility = 'visible'; };
    cover.onerror = function () { this.style.visibility = 'hidden'; };
    cover.src = book.cover;

    document.getElementById('detailTitleCn').textContent = book.titleCn || ('第 ' + book.id + ' 本 · 待补充');
    document.getElementById('detailTitleEn').textContent = book.titleEn || '';
    document.getElementById('detailAuthor').textContent = book.author ? ('作者：' + book.author) : '作者：待补充';

    const tagsEl = document.getElementById('detailTags');
    tagsEl.innerHTML = (book.tags && book.tags.length)
        ? book.tags.map(t => `<span>${t}</span>`).join('')
        : '';

    document.getElementById('detailIntro').textContent = book.intro || '（中文简介待补充）';
    document.getElementById('detailIntroEn').textContent = book.introEn || '';

    mask.classList.add('show');
    document.body.style.overflow = 'hidden';
    setTimeout(() => renderBookGraph(book.id), 60);
}
// ===============================
// 17.6 书籍详情 · 示例知识图谱
// --------------------------------------------------------------
// 对接后端时，只需改 fetchBookGraph() 一个函数。
// 期望返回格式（与 backend/controller/schemas.GraphData 一致）：
//   {
//     nodes: [{ id, name, category, media }],
//     edges: [{ source, target, relation }]
//   }
// ===============================

const BOOK_GRAPH_API = '/api/graph/book';   // ★ 后端就绪后启用

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
    nodes.push({ id: '__book__', type: 'center', name: '', r: 26 });

    // 一级邻居
    const primaryIds = [];
    for (let i = 0; i < primaryCount; i++) {
        const id = 'p' + i;
        primaryIds.push(id);
        nodes.push({ id, type: 'primary', name: '', r: 13 });
        edges.push({ source: '__book__', target: id, relation: '' });
    }

    // 二级邻居
    for (let i = 0; i < secondaryCount; i++) {
        const id = 's' + i;
        nodes.push({ id, type: 'secondary', name: '', r: 8 });
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

// ---------- 2. 数据层：真实接口（后端就绪后启用） ----------
async function fetchBookGraph(bookId) {
    // ★ 已接后端 /api/graph/book/{bookId}（返回该书的宏观章层小图）
    try {
        const res  = await fetch(`${BOOK_GRAPH_API}/${bookId}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.message || '后端错误');
        const g = json.data || {};
        // 后端契约字段为 label/type；补齐渲染所需 r
        return {
            nodes: (g.nodes || []).map(n => ({ ...n, r: 14 })),
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
        .attr('class', d => `bg-node ${d.type}`);

    nodeEnter.append('circle').attr('r', d => d.r);
    nodeEnter.append('text')
        .attr('class', d => `bg-label ${d.type}`)
        .attr('dy', d => d.r + 14)
        .text(d => d.label || '');

    const nodeMerged = nodeEnter.merge(nodeSel);
    nodeMerged.select('circle').attr('r', d => d.r);
    nodeMerged.select('text').text(d => d.label || '');

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
// 19. 科研论文 · 数据
// ===============================
// 字段说明：
//   journal   期刊名称（英文，斜体展示）
//   year      发表年份
//   type      论文类型标签
//   titleCn   中文标题（财大红）
//   titleEn   英文标题
//   author    作者（建议替换为真实作者，APA 格式）
//   tags      关键词
//   abstract  中文摘要（卡片上截断为 3 行）
//   abstractEn英文摘要（详情页展示）
//   sections  正文分节 [{ h: 小节标题, p: [段落, ...] }]
// ===============================

const PAPERS = [
    {
        id: 1,
        journal: 'Journal of Financial Economics', year: '2025', type: '实证研究',
        titleCn: '中国A股市场的动量与反转效应：基于行业轮动的实证检验',
        titleEn: 'Momentum and Reversal Effects in China\'s A-Share Market: Evidence from Industry Rotation',
        author: 'Zhang, W., Li, H., & Chen, Y.',
        tags: ['资产定价', '动量效应', '行业轮动'],
        abstract: '本文基于 2005—2024 年中国 A 股市场的月度行业组合数据，系统检验了动量与反转效应的存在性及其期限结构。研究发现，在 1 至 6 个月的持有期内，行业组合呈现显著的动量收益；当持有期延长至 12 个月以上时，收益方向发生反转。中介效应检验表明，投资者过度反应与流动性冲击是解释这一期限结构差异的关键机制。',
        abstractEn: 'Using monthly industry portfolio data from China\'s A-share market over 2005–2024, this paper systematically examines the existence and term structure of momentum and reversal effects. We document significant momentum returns over 1–6 month horizons, which reverse beyond 12 months. Mediation tests suggest that investor overreaction and liquidity shocks are the key mechanisms.',
        sections: [
            {
                h: '一、研究背景与问题提出',
                p: [
                    '动量效应自 Jegadeesh 与 Titman（1993）提出以来，始终是资产定价领域的核心议题。然而，新兴市场尤其是中国 A 股市场的动量现象长期存在争议：部分研究记录了显著的中期动量收益，另一些研究则发现收益方向相反。本文认为，分歧的一个重要来源在于既有文献多在公司层面构建组合，忽视了行业轮动这一中国市场的典型特征。',
                    '基于此，本文将研究视角下沉至行业层面，试图回答两个问题：第一，行业组合是否存在稳定的动量与反转效应？第二，若存在，其背后的经济机制是什么？'
                ]
            },
            {
                h: '二、数据来源与研究方法',
                p: [
                    '本文选取 2005 年 1 月至 2024 年 12 月中国 A 股全部上市公司的月度收益率数据，按照申万一级行业分类构建 31 个行业组合。采用重叠组合法构造动量策略，形成期分别为 3、6、9、12 个月，持有期分别为 1、3、6、12、24 个月，并对规模、账面市值比等特征进行正交化处理。',
                    '为识别作用机制，本文进一步构建投资者情绪指数与流动性冲击指标，采用逐步回归的中介效应模型进行检验，并使用 Fama-MacBeth 横截面回归作为稳健性补充。'
                ]
            },
            {
                h: '三、实证结果与稳健性检验',
                p: [
                    '结果显示，当形成期与持有期均为 3 至 6 个月时，赢家组合相对输家组合的月度超额收益约为 0.82%，在 1% 水平上显著；而当持有期延长至 12 个月以上，该收益转负，反转幅度约为 -0.61%/月。中介效应检验表明，投资者情绪对动量收益的贡献约为 34%，流动性冲击约为 21%。',
                    '在剔除 ST 公司、控制行业集中度、更换加权方式以及采用子样本滚动检验后，上述结论保持稳健。'
                ]
            },
            {
                h: '四、结论与启示',
                p: [
                    '本文的证据支持"短期动量、长期反转"的期限结构假说，并揭示其微观机制。对于机构投资者而言，行业层面的动量策略在 3 至 6 个月的调仓周期内具有可操作性；对于监管者而言，应关注情绪驱动的短期价格偏离对市场定价效率的影响。'
                ]
            }
        ]
    },
    {
        id: 2,
        journal: 'Review of Financial Studies', year: '2024', type: '行为金融',
        titleCn: '投资者情绪、交易行为与资产价格泡沫：来自融资融券数据的证据',
        titleEn: 'Investor Sentiment, Trading Behavior, and Asset Price Bubbles: Evidence from Margin Trading Data',
        author: 'Wang, L., & Zhao, M.',
        tags: ['行为金融', '投资者情绪', '融资融券'],
        abstract: '本文利用 2010—2023 年中国融资融券标的股票的日度交易数据，构建了基于换手率、买卖不平衡与杠杆率的复合情绪指标，考察投资者情绪对价格偏离基本面的影响。研究发现，情绪指标每上升一个标准差，个股价格在未来 20 个交易日内相对基本面的偏离度上升约 2.7%，随后在 60 个交易日内出现显著回调。',
        abstractEn: 'Using daily trading data of margin-eligible stocks in China from 2010 to 2023, we construct a composite sentiment index based on turnover, order imbalance, and leverage. A one-standard-deviation increase in sentiment raises the deviation of price from fundamentals by about 2.7% within 20 trading days, followed by a significant reversal within 60 days.',
        sections: [
            {
                h: '一、引言',
                p: [
                    '资产价格泡沫的形成与破裂始终是金融学研究中最具挑战性的问题之一。传统理性预期框架难以解释价格在缺乏基本面信息支撑下的持续偏离，行为金融学则将视角转向投资者情绪这一非理性因素。',
                    '融资融券制度为观察投资者情绪提供了独特的窗口：融资余额的扩张往往伴随乐观情绪的累积，而融券余额则反映了看空力量的变化。本文利用这一制度特征，构建高频情绪指标并检验其对价格泡沫的预测能力。'
                ]
            },
            {
                h: '二、指标构建与识别策略',
                p: [
                    '本文以换手率、买卖委托不平衡、融资买入占比与融券卖出占比四个维度合成情绪指标，采用主成分分析法提取第一主成分，累计方差解释率达 63.8%。随后以个股基本面价值（基于剩余收益模型估计）为基准，计算价格偏离度。',
                    '为缓解内生性问题，本文以标的股票调入调出融资融券名单作为外生冲击，采用双重差分法进行识别。'
                ]
            },
            {
                h: '三、实证发现与政策含义',
                p: [
                    '结果表明，情绪冲击对价格偏离具有显著的正向影响，且该效应在中小市值、机构持股比例较低的股票中更为明显。进一步分析显示，情绪驱动的价格偏离在市场流动性收紧时更容易发生逆转。',
                    '本文的发现为完善融资融券监管、防范系统性风险提供了实证依据，也提示投资者教育在抑制非理性交易中的重要作用。'
                ]
            }
        ]
    },
    {
        id: 3,
        journal: 'Journal of Banking & Finance', year: '2024', type: 'ESG 研究',
        titleCn: 'ESG 评级分歧与股票收益：基于中国市场的经验证据',
        titleEn: 'ESG Rating Divergence and Stock Returns: Evidence from the Chinese Market',
        author: 'Chen, Y., Sun, Q., & Liu, X.',
        tags: ['ESG', '可持续金融', '评级分歧'],
        abstract: '不同评级机构对同一公司的 ESG 评价往往存在显著分歧，本文以 2018—2024 年中国 A 股上市公司为样本，检验评级分歧对股票收益的影响。研究发现，评级分歧越高的股票，其未来收益越低，组合多空收益差约为 0.54%/月，且在信息环境较差的公司中更为显著。',
        abstractEn: 'ESG rating divergence across agencies is substantial. Using Chinese A-share listed firms from 2018 to 2024, we show that stocks with higher rating divergence earn lower future returns, with a long-short spread of about 0.54% per month, concentrated in firms with poor information environments.',
        sections: [
            {
                h: '一、研究动机',
                p: [
                    '随着可持续投资规模迅速扩张，ESG 评级已成为资金配置的重要依据。然而，主要评级机构之间的相关性长期低于 0.5，这种分歧本身即构成了新的不确定性来源。',
                    '本文认为，评级分歧实质上反映了 ESG 信息的模糊性，投资者对模糊信息要求额外的风险补偿，从而影响均衡收益。'
                ]
            },
            {
                h: '二、样本与变量',
                p: [
                    '本文选取六家主流评级机构对中国 A 股上市公司的评级数据，以评级标准差的标准化值度量分歧程度。控制变量包括规模、账面市值比、动量、盈利能力与机构持股比例。',
                    '基准回归采用 Fama-MacBeth 两步法，并通过分组组合分析与因子正交化检验结论的稳健性。'
                ]
            },
            {
                h: '三、结论',
                p: [
                    '本文为"ESG 评级分歧溢价"提供了新兴市场证据，提示投资者在使用 ESG 评级时应关注其背后的度量不确定性，也为监管层推动 ESG 信息披露标准化提供了理论支持。'
                ]
            }
        ]
    },
    {
        id: 4,
        journal: 'Journal of Financial Markets', year: '2023', type: '市场微观结构',
        titleCn: '高频交易对市场流动性与波动性的双重影响',
        titleEn: 'The Dual Impact of High-Frequency Trading on Market Liquidity and Volatility',
        author: 'Liu, J., & Huang, R.',
        tags: ['高频交易', '市场质量', '流动性'],
        abstract: '本文利用中国股指期货市场的高频逐笔数据，识别高频交易活动对市场质量的影响。结果表明，高频交易在正常市场状态下显著收窄买卖价差、提升流动性；但在极端行情中，其撤单行为会加剧短期波动，形成流动性供给的顺周期特征。',
        abstractEn: 'Using high-frequency tick data from China\'s stock index futures market, we identify the impact of HFT activity on market quality. HFT narrows spreads in normal conditions, but its order cancellation behavior amplifies short-term volatility during stress, generating procyclical liquidity provision.',
        sections: [
            {
                h: '一、识别方法与数据',
                p: [
                    '本文以订单撤销率、成交持仓比与报文速率三个维度识别高频交易账户，样本覆盖 2019—2023 年沪深 300 股指期货全部逐笔委托与成交记录。',
                    '为区分流动性与波动性效应，本文采用事件研究法，以重大宏观数据发布为外生冲击窗口。'
                ]
            },
            {
                h: '二、主要发现',
                p: [
                    '在非事件窗口，高频交易参与度每提高 10%，相对买卖价差平均下降 3.1 个基点；在事件窗口内，该效应反转为价差扩大 5.7 个基点，且波动率显著上升。',
                    '进一步分析表明，撤单速度是关键变量：当撤单延迟低于 1 毫秒时，流动性撤出的顺周期性最为明显。'
                ]
            },
            {
                h: '三、监管启示',
                p: [
                    '本文建议在极端行情下引入动态的最小报价停留时间（Minimum Resting Time）机制，以抑制瞬时流动性撤出，兼顾市场效率与稳定。'
                ]
            }
        ]
    },
    {
        id: 5,
        journal: 'Journal of Monetary Economics', year: '2023', type: '宏观金融',
        titleCn: '货币政策冲击、期限溢价与债券市场风险传导',
        titleEn: 'Monetary Policy Shocks, Term Premia, and Risk Transmission in the Bond Market',
        author: 'Zhou, K., & Fang, Y.',
        tags: ['货币政策', '期限溢价', '利率传导'],
        abstract: '本文构建包含时变期限溢价的仿射期限结构模型，识别货币政策冲击在收益率曲线上的传导路径。基于中国银行间市场 2008—2023 年数据的估计显示，政策冲击对短端利率的影响迅速而显著，对长端利率的影响则主要通过期限溢价渠道缓慢释放。',
        abstractEn: 'We estimate an affine term structure model with time-varying term premia to identify the transmission of monetary policy shocks along the yield curve. Using Chinese interbank data from 2008 to 2023, we find that policy shocks affect short rates rapidly, while long-rate responses operate mainly through the term premium channel.',
        sections: [
            {
                h: '一、模型设定',
                p: [
                    '本文在无套利仿射框架下引入宏观因子，允许期限溢价随波动率状态发生区制转换，从而刻画政策冲击在不同市场环境下的异质性传导。'
                ]
            },
            {
                h: '二、估计结果',
                p: [
                    '估计结果显示，政策冲击对 1 年期利率的即期影响约为 18 个基点，而对 10 年期利率的同期影响仅 4 个基点；随着期限延长，期限溢价渠道的贡献由 12% 上升至 61%。',
                    '在流动性紧张区间，长端利率对政策冲击的敏感度显著上升，表明市场状态是传导效率的重要调节变量。'
                ]
            },
            {
                h: '三、政策含义',
                p: [
                    '本文的证据意味着，仅关注短端政策利率不足以判断货币条件的松紧，监管部门应将期限溢价纳入金融条件指数，以更准确地评估政策传导效果。'
                ]
            }
        ]
    },
    {
        id: 6,
        journal: 'Management Science', year: '2025', type: '量化方法',
        titleCn: '基于机器学习的多因子模型构建与因子有效性检验',
        titleEn: 'Machine Learning Approaches to Multi-Factor Model Construction and Factor Validity Testing',
        author: 'Xu, H., & Ma, T.',
        tags: ['机器学习', '因子投资', '资产定价'],
        abstract: '本文比较了 LASSO、随机森林与梯度提升树在横截面收益预测中的表现，并基于中国 A 股 2000—2024 年数据构建多因子模型。结果显示，梯度提升树在样本外 R² 上优于线性模型约 42%，但其超额收益在高交易成本下显著衰减。',
        abstractEn: 'We compare LASSO, random forest, and gradient boosting in cross-sectional return prediction using Chinese A-share data from 2000 to 2024. Gradient boosting outperforms linear models by about 42% in out-of-sample R-squared, yet its alpha decays substantially under realistic transaction costs.',
        sections: [
            {
                h: '一、研究设计',
                p: [
                    '本文选取 96 个候选特征，涵盖估值、动量、质量、成长与流动性五大类，采用滚动窗口进行训练与预测，避免前视偏差。',
                    '为评估经济意义，本文在组合构建中引入换手率约束与交易成本假设，考察策略的净收益表现。'
                ]
            },
            {
                h: '二、实证结果',
                p: [
                    '梯度提升树在预测精度上领先，但其重要性排序显示，模型主要依赖动量与流动性类特征，对估值类因子的利用有限。',
                    '在扣除 20 个基点的单边交易成本后，机器学习策略的年化超额收益由 11.3% 降至 4.1%，而传统多因子组合的衰减幅度仅为 2.6 个百分点。'
                ]
            },
            {
                h: '三、讨论',
                p: [
                    '本文提示，机器学习方法在资产定价中的价值需要结合交易成本与容量约束综合评估，单纯追求统计预测精度可能导致经济意义被高估。'
                ]
            }
        ]
    },
    {
        id: 7,
        journal: 'Journal of Financial and Quantitative Analysis', year: '2022', type: '基金研究',
        titleCn: '公募基金业绩持续性的再检验：能力还是运气？',
        titleEn: 'Re-examining Mutual Fund Performance Persistence: Skill or Luck?',
        author: 'Guo, S., & Tang, W.',
        tags: ['基金绩效', '业绩持续性', 'Bootstrap'],
        abstract: '本文采用 Bootstrap 方法对中国主动权益类基金的业绩持续性进行再检验，分离真正的管理能力与随机运气。结果显示，在扣除费用后仅有约 3.2% 的基金表现出显著的正向能力，而业绩持续性的表面证据主要来源于生存者偏差与风格暴露。',
        abstractEn: 'Using bootstrap methods, we re-examine performance persistence among Chinese actively managed equity funds, separating genuine skill from luck. After fees, only about 3.2% of funds exhibit significant positive skill; apparent persistence is largely driven by survivorship bias and style exposure.',
        sections: [
            {
                h: '一、方法与样本',
                p: [
                    '样本覆盖 2010—2021 年全部存续期超过 36 个月的主动权益基金。本文以四因子模型为基准，通过 10000 次 Bootstrap 重抽样构建"零能力"分布。'
                ]
            },
            {
                h: '二、核心结论',
                p: [
                    '在扣除管理费与交易成本后，基金整体 alpha 的中位数为负；仅有 3.2% 的基金落在零能力分布的右尾 5% 之外。',
                    '分组检验显示，规模较小的基金与投研团队稳定性较高的基金更容易表现出持续性，但该效应在经济意义上有限。'
                ]
            },
            {
                h: '三、对投资者的启示',
                p: [
                    '本文认为，投资者不应简单依据历史业绩挑选基金，而应关注费率结构、风格漂移与团队稳定性等更具信息含量的指标。'
                ]
            }
        ]
    },
    {
        id: 8,
        journal: 'Journal of International Money and Finance', year: '2024', type: '国际金融',
        titleCn: '跨境资本流动、汇率预期与宏观审慎政策有效性',
        titleEn: 'Cross-Border Capital Flows, Exchange Rate Expectations, and the Effectiveness of Macroprudential Policy',
        author: 'He, Q., & Lin, Z.',
        tags: ['国际金融', '资本流动', '宏观审慎'],
        abstract: '本文构建包含异质性预期的小型开放经济模型，评估宏观审慎政策对跨境资本流动的调节效果。基于 18 个新兴经济体 2005—2023 年面板数据的实证结果显示，逆周期资本缓冲能够显著降低资本流动的波动性，但其效果在汇率预期分化程度较高时明显减弱。',
        abstractEn: 'We build a small open economy model with heterogeneous expectations to evaluate macroprudential policy. Panel evidence from 18 emerging economies over 2005–2023 shows that countercyclical capital buffers significantly reduce capital flow volatility, but the effect weakens when exchange rate expectations are highly dispersed.',
        sections: [
            {
                h: '一、理论框架',
                p: [
                    '模型引入两类预期形成机制：基本面交易者与趋势追踪者，两者比例随汇率偏离程度内生化变化，从而刻画预期分化对政策传导的抑制效应。'
                ]
            },
            {
                h: '二、实证检验',
                p: [
                    '本文使用局部投影法（Local Projections）估计政策冲击的动态效应，结果显示，资本缓冲要求提高 1 个百分点，可使资本流动波动率下降约 14%。',
                    '当预期分化指标处于样本上四分位时，该效应下降至 5% 以下，且在控制全球风险因子后依然稳健。'
                ]
            },
            {
                h: '三、政策建议',
                p: [
                    '本文建议，宏观审慎政策应与汇率预期管理形成协同，在预期分化加剧时辅以沟通策略与外汇干预，以提升政策有效性。'
                ]
            }
        ]
    }
];

// ===============================
// 20. 科研论文 · 逻辑
// ===============================
let currentPaperIndex = 0;
let paperSwitching = false;

function padNo(n) {
    return String(n).padStart(2, '0');
}

/* 绘制当前论文卡片 */
function paintPaperCard() {
    const stage = document.getElementById('paperStage');
    if (!stage) return;
    const p = PAPERS[currentPaperIndex];

    stage.innerHTML = `
        <div class="paper-card-top">
            <span class="paper-journal">${p.journal} · ${p.year}</span>
            <span class="paper-type">${p.type}</span>
        </div>
        <h2 class="paper-title-cn">${p.titleCn}</h2>
        <h3 class="paper-title-en">${p.titleEn}</h3>
        <div class="paper-meta">${p.author}</div>
        <div class="paper-divider"></div>
        <p class="paper-abstract"><span class="abstract-label">摘要</span>${p.abstract}</p>
        <div class="paper-tags">${p.tags.map(t => `<span>${t}</span>`).join('')}</div>
        <div class="paper-readmore">点击查看全文<span class="arrow">→</span></div>
    `;
}

/* 更新页码与圆点 */
function paintPaperPager() {
    const curEl = document.getElementById('paperCurrentNo');
    const totalEl = document.getElementById('paperTotalNo');
    const dotsEl = document.getElementById('paperDots');
    if (curEl) curEl.textContent = padNo(currentPaperIndex + 1);
    if (totalEl) totalEl.textContent = padNo(PAPERS.length);

    if (dotsEl) {
        dotsEl.innerHTML = PAPERS.map((_, i) =>
            `<button class="paper-dot${i === currentPaperIndex ? ' active' : ''}"
                     data-index="${i}" aria-label="第 ${i + 1} 篇"></button>`
        ).join('');
    }
}

/* 绘制详情内容 */
function paintPaperDetail(p) {
    document.getElementById('pdJournal').textContent = `${p.journal} · ${p.year} · ${p.type}`;
    document.getElementById('pdTitleCn').textContent = p.titleCn;
    document.getElementById('pdTitleEn').textContent = p.titleEn;
    document.getElementById('pdAuthor').textContent = `作者：${p.author}`;

    document.getElementById('pdTags').innerHTML =
        p.tags.map(t => `<span>${t}</span>`).join('');

    document.getElementById('pdAbstract').textContent = p.abstract;
    document.getElementById('pdAbstractEn').textContent = p.abstractEn || '';

    document.getElementById('pdBody').innerHTML = p.sections.map(sec => `
        <div class="paper-detail-block">
            <h4>${sec.h}</h4>
            ${sec.p.map(par => `<p>${par}</p>`).join('')}
        </div>
    `).join('');
}

function isPaperDetailOpen() {
    const mask = document.getElementById('paperDetailMask');
    return !!(mask && mask.classList.contains('show'));
}

/* 切换论文（dir: 1 下一篇 / -1 上一篇） */
function switchPaper(nextIndex, dir) {
    if (paperSwitching) return;
    const stage = document.getElementById('paperStage');
    if (!stage) return;

    paperSwitching = true;
    const total = PAPERS.length;
    const target = ((nextIndex % total) + total) % total;

    // 滑出：方向与进入方向相反
    stage.style.setProperty('--exit-dir', String(-dir));
    stage.classList.add('paper-fade-out');

    window.setTimeout(() => {
        currentPaperIndex = target;
        paintPaperCard();
        paintPaperPager();

        // 若详情页正打开，同步刷新详情内容
        if (isPaperDetailOpen()) {
            paintPaperDetail(PAPERS[currentPaperIndex]);
            const scroller = document.getElementById('pdScroll');
            if (scroller) scroller.scrollTop = 0;
        }

        // 从反方向滑入
        stage.style.setProperty('--exit-dir', String(dir));
        stage.classList.remove('paper-fade-out');

        window.setTimeout(() => { paperSwitching = false; }, 260);
    }, 240);
}

function goPaperTo(index) {
    if (index === currentPaperIndex) return;
    switchPaper(index, index > currentPaperIndex ? 1 : -1);
}

/* 打开 / 关闭详情 */
function openPaperDetail() {
    const mask = document.getElementById('paperDetailMask');
    if (!mask) return;

    paintPaperDetail(PAPERS[currentPaperIndex]);
    mask.classList.add('show');
    document.body.style.overflow = 'hidden';

    const scroller = document.getElementById('pdScroll');
    if (scroller) scroller.scrollTop = 0;
}

function closePaperDetail() {
    const mask = document.getElementById('paperDetailMask');
    if (!mask || !mask.classList.contains('show')) return;
    mask.classList.remove('show');
    document.body.style.overflow = '';
}

/* 模块初始化 */
(function initPaperModule() {
    function run() {
        const stage = document.getElementById('paperStage');
        if (!stage) return;

        paintPaperCard();
        paintPaperPager();

        // 卡片点击 → 打开详情
        stage.addEventListener('click', openPaperDetail);
        stage.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openPaperDetail();
            }
        });

        // 左右翻页
        const prevBtn = document.getElementById('paperPrev');
        const nextBtn = document.getElementById('paperNext');
        if (prevBtn) prevBtn.addEventListener('click', () => switchPaper(currentPaperIndex - 1, -1));
        if (nextBtn) nextBtn.addEventListener('click', () => switchPaper(currentPaperIndex + 1, 1));

        // 圆点跳转（事件委托）
        const dots = document.getElementById('paperDots');
        if (dots) {
            dots.addEventListener('click', function (e) {
                const dot = e.target.closest('.paper-dot');
                if (!dot) return;
                goPaperTo(Number(dot.dataset.index));
            });
        }

        // 关闭详情
        const mask = document.getElementById('paperDetailMask');
        const closeBtn = document.getElementById('paperDetailClose');
        if (closeBtn) closeBtn.addEventListener('click', closePaperDetail);
        if (mask) {
            mask.addEventListener('click', function (e) {
                if (e.target === mask) closePaperDetail();
            });
        }

        // 键盘：Esc 关闭；← → 翻页
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                closePaperDetail();
                return;
            }
            // 输入框内不响应
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            if (e.key === 'ArrowLeft') switchPaper(currentPaperIndex - 1, -1);
            if (e.key === 'ArrowRight') switchPaper(currentPaperIndex + 1, 1);
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
            </div>
            <div class="study-item-title">${v.title}</div>
            <div class="study-item-author">${v.author}</div>
        `;
        el.addEventListener('click', () => openStudyPlayer(v));
        frag.appendChild(el);
    });
    grid.appendChild(frag);
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