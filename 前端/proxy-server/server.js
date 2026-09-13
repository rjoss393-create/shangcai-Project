const express = require('express');
const https = require('https');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// ============ 静态文件服务 ============
const websiteRoot = path.join(__dirname, '..', 'SUFE-Knowledge-Galaxy');
app.use(express.static(websiteRoot));

// ============ 是否 A 股 ============
function isAShare(code) {
    return code.startsWith('sh') || code.startsWith('sz');
}

// ============ 新浪 A 股 K 线 ============
function fetchSinaKline(code) {
    return new Promise((resolve, reject) => {
        const query = `symbol=${encodeURIComponent(code)}&scale=5&ma=no&datalen=240`;
        const options = {
            hostname: 'quotes.sina.cn',
            path: `/cn/api/json_v2.php/CN_MarketDataService.getKLineData?${query}`,
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Connection': 'close',
                'Referer': 'https://finance.sina.com.cn/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 15000,
            rejectUnauthorized: false
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('K线 JSON 解析失败')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('K线请求超时')); });
        req.end();
    });
}

// ============ 新浪实时（港股/美股用） ============
function fetchSinaRealtime(code) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'hq.sinajs.cn',
            path: `/list=${encodeURIComponent(code)}`,
            method: 'GET',
            headers: {
                'Referer': 'https://finance.sina.com.cn/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000,
            rejectUnauthorized: false
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                let text;
                try {
                    // 新浪实时接口是 GBK 编码
                    text = new TextDecoder('gbk').decode(buf);
                } catch (e) {
                    text = buf.toString('utf8');
                }
                resolve(text);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('实时请求超时')); });
        req.end();
    });
}

// ============ 解析 A 股 K 线 → 统一格式 ============
function transformSinaData(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const klines = arr.map(item => {
        if (!item.day) return null;
        return `${item.day},${item.open},${item.close},${item.high},${item.low},${item.volume || 0}`;
    }).filter(Boolean);
    return { data: { klines } };
}

// ============ 解析港股/美股实时文本 ============
function parseRealtime(text, code) {
    const m = text.match(/="([^"]*)"/);
    if (!m || !m[1]) return null;
    const p = m[1].split(',');
    if (p.length < 5) return null;

    if (code.startsWith('rt_hk')) {
        // 港股：名称,英文名,今开,昨收,最高,最低,现价,涨跌额,涨跌幅
        return {
            open: parseFloat(p[2]),
            prevClose: parseFloat(p[3]),
            high: parseFloat(p[4]),
            low: parseFloat(p[5]),
            value: parseFloat(p[6]),
            changePercent: parseFloat(p[8])
        };
    } else if (code.startsWith('gb_')) {
        // 美股：名称,现价,涨跌幅,时间,涨跌额,开盘,最高,最低,...
        const value = parseFloat(p[1]);
        const changeAmount = parseFloat(p[4]);
        return {
            value,
            changePercent: parseFloat(p[2]),
            open: parseFloat(p[5]),
            high: parseFloat(p[6]),
            low: parseFloat(p[7]),
            prevClose: value - changeAmount,
            time: p[3]
        };
    }
    return null;
}

// ============ K线代理接口（A股 K 线 / 港美股 实时） ============
app.get('/api/kline', async (req, res) => {
    const secid = req.query.secid || 'sh000001';
    try {
        console.log(`正在帮你去拿: ${secid} 的数据...`);

        let result = null;

        if (isAShare(secid)) {
            // A 股：真实 5 分钟 K 线
            const raw = await fetchSinaKline(secid);
            result = transformSinaData(raw);
        } else {
            // 港股/美股：实时数据 → 用"昨收→现价"两点构造简单K线
            const text = await fetchSinaRealtime(secid);
            console.log('  实时原文片段:', text.slice(0, 150));
            const info = parseRealtime(text, secid);
            if (info && !isNaN(info.value) && !isNaN(info.prevClose)) {
                const today = new Date();
                const ds = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
                // 两点K线，前端会依据最后两条计算涨跌幅 = (value - prevClose)/prevClose
                const klines = [
                    `${ds} 09:30:00,${info.prevClose},${info.prevClose},${info.prevClose},${info.prevClose},0`,
                    `${ds} 15:00:00,${info.value},${info.value},${info.value},${info.value},0`
                ];
                result = { data: { klines } };
            }
        }

        if (result && result.data.klines && result.data.klines.length > 0) {
            console.log(`  ✅ ${secid} 拿到 ${result.data.klines.length} 条数据`);
            res.json(result);
        } else {
            console.warn(`  ⚠️ ${secid} 返回为空`);
            res.status(500).json({ error: '拿数据失败了', detail: '返回数据为空' });
        }
    } catch (error) {
        console.error(`  ❌ ${secid} 失败:`, error.message);
        res.status(500).json({ error: '拿数据失败了', detail: error.message });
    }
});

// ============ 启动 ============
app.listen(3000, () => {
    console.log('========================================');
    console.log('✅ 服务已启动');
    console.log('   网页地址: http://localhost:3000/index.html');
    console.log('   接口测试: http://localhost:3000/api/kline?secid=sh000001');
    console.log('========================================');
});