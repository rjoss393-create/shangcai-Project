"""媒体资源 / 页面托管路由：把前端所需的数据统一收到后端提供

背景：视频、论文 PDF、图书封面、视频清单这些数据文件原先放在前端目录里，
现全部迁到后端存储 data/media/；前端代码一行未改，仍按原来的相对路径请求，
由本模块把同一路径映射到后端：

    前端请求的路径                        实际来源（后端 data/media/）
    /assets/videos/01.mp4                 data/media/videos/01.mp4
    /assets/videos/46-cover.jpg           data/media/videos/46-cover.jpg
    /assets/papers/jf-01.pdf              data/media/papers/jf-01.pdf
    /assets/books/01.png                  data/media/books/01.png
    /data/videos.json                     data/media/videos.json
    /api/kline?secid=...                  A股/港美股走新浪；北证50(bj899050) 走东方财富
    /api/news                             新浪滚动财经新闻（5 分钟缓存，供首页新闻区）
    /（其余全部）                          前端/SUFE-Knowledge-Galaxy/（页面自身的 html/css/js/字体/logo）

视频/PDF 用 StaticFiles（内部 FileResponse）提供，支持 HTTP Range，
视频进度条可正常拖动。

装配（main.py，挂载必须放在所有 API 路由注册之后）：

    app.include_router(create_media_router(MEDIA_DIR))
    mount_site(app, FRONTEND_DIR)
"""
import datetime
import json
import logging
import math
import os
import time

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

# 前端相对路径 -> data/media/ 下的子目录
MEDIA_MOUNTS: dict[str, str] = {
    "/assets/videos": "videos",
    "/assets/papers": "papers",
    "/assets/books": "books",
}

SINA_KLINE_URL = "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
SINA_REALTIME_URL = "https://hq.sinajs.cn/list="
SINA_HEADERS = {
    "Accept": "*/*",
    "Referer": "https://finance.sina.com.cn/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
}
SINA_TIMEOUT = 15.0

# 北证50：优先走东方财富（多域名轮询，单域名偶发超时），不可达时用新浪兜底
# （新浪 K 线接口同样认 bj899050；2026-09-19 实测东财返回 Server disconnected）
EASTMONEY_KLINE_URLS = (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
    "https://82.push2his.eastmoney.com/api/qt/stock/kline/get",
)
EASTMONEY_HEADERS = {**SINA_HEADERS, "Referer": "https://quote.eastmoney.com/"}
EASTMONEY_TIMEOUT = 10.0
BJ_INDEX_SECID = "bj899050"            # 前端下拉框里的北证50（东财 secid 为 0.899050）
BJ_EASTMONEY_SECID = "0.899050"

# 首页新闻：新浪滚动财经新闻，服务端缓存，失败时返回空列表（前端保留静态数据）
SINA_NEWS_URL = "https://feed.mix.sina.com.cn/api/roll/get"
SINA_NEWS_PARAMS = {"pageid": "155", "lid": "1686", "num": 20, "page": 1, "encode": "utf-8"}
NEWS_CACHE_TTL = 300.0
_news_cache: dict = {"data": None, "ts": 0.0}


def _is_a_share(code: str) -> bool:
    return code.startswith(("sh", "sz"))


async def _fetch_sina_kline(code: str) -> list:
    """A 股 5 分钟 K 线（新浪），返回原始数组"""
    params = {"symbol": code, "scale": "5", "ma": "no", "datalen": "240"}
    async with httpx.AsyncClient(verify=False, timeout=SINA_TIMEOUT, follow_redirects=True) as client:
        resp = await client.get(SINA_KLINE_URL, params=params, headers=SINA_HEADERS)
        resp.raise_for_status()
        return json.loads(resp.text)


async def _fetch_sina_realtime(code: str) -> str:
    """港股/美股实时行情（新浪，GBK 文本）"""
    async with httpx.AsyncClient(verify=False, timeout=SINA_TIMEOUT, follow_redirects=True) as client:
        resp = await client.get(SINA_REALTIME_URL + code, headers=SINA_HEADERS)
        resp.raise_for_status()
        return resp.content.decode("gbk", errors="replace")


def _transform_kline(raw) -> list[str]:
    """原始数组 -> ["日期,开,收,高,低,量", ...]（前端解析格式）"""
    if not isinstance(raw, list):
        return []
    klines = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("day"):
            continue
        klines.append("{},{},{},{},{},{}".format(
            item["day"], item.get("open", 0), item.get("close", 0),
            item.get("high", 0), item.get("low", 0), item.get("volume", 0) or 0,
        ))
    return klines


def _parse_realtime(text: str, code: str) -> dict | None:
    """新浪实时文本 -> 行情字段（港股 rt_hk / 美股 gb_）"""
    start, end = text.find('="'), text.rfind('"')
    if start < 0 or end <= start:
        return None
    parts = text[start + 2:end].split(",")
    if len(parts) < 8:
        return None
    try:
        if code.startswith("rt_hk"):
            # 名称,英文名,今开,昨收,最高,最低,现价,涨跌额,涨跌幅
            return {"open": float(parts[2]), "prevClose": float(parts[3]),
                    "high": float(parts[4]), "low": float(parts[5]),
                    "value": float(parts[6]), "changePercent": float(parts[8])}
        if code.startswith("gb_"):
            # 名称,现价,涨跌幅,时间,涨跌额,开盘,最高,最低
            value, change = float(parts[1]), float(parts[4])
            return {"value": value, "changePercent": float(parts[2]),
                    "open": float(parts[5]), "high": float(parts[6]),
                    "low": float(parts[7]), "prevClose": value - change, "time": parts[3]}
    except (ValueError, IndexError):
        return None
    return None


async def _fetch_eastmoney_kline() -> list[str]:
    """北证50 日K（东方财富），域名轮询；原样返回其 klines（"日期,开,收,高,低,量,..."）"""
    params = {
        "secid": BJ_EASTMONEY_SECID,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "5",
        "fqt": "1",
        "end": "20500101",
        "lmt": "240",
    }
    last_err: Exception | None = None
    for url in EASTMONEY_KLINE_URLS:
        try:
            async with httpx.AsyncClient(timeout=EASTMONEY_TIMEOUT, follow_redirects=True) as client:
                resp = await client.get(url, params=params, headers=EASTMONEY_HEADERS)
                resp.raise_for_status()
                raw = resp.json()
            klines = (raw.get("data") or {}).get("klines") or []
            if klines:
                return klines
            last_err = RuntimeError("返回数据为空")
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"北证50行情获取失败：{last_err}")


async def _fetch_sina_news() -> dict:
    """新浪滚动财经新闻 -> {"domestic": [{title, url, source}]}（国内经济/市场要闻）"""
    async with httpx.AsyncClient(timeout=SINA_TIMEOUT, follow_redirects=True) as client:
        resp = await client.get(SINA_NEWS_URL, params=SINA_NEWS_PARAMS, headers=SINA_HEADERS)
        resp.raise_for_status()
        raw = resp.json()
    items = ((raw.get("result") or {}).get("data")) or []
    return {
        "domestic": [
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "source": item.get("media_name", ""),
            }
            for item in items
            if item.get("title")
        ]
    }


def create_media_router(media_dir: str) -> APIRouter:
    """路由工厂：注入媒体存储目录（data/media/）"""
    router = APIRouter(tags=["media"])

    # 视频 / 论文 / 图书封面：路径与前端原有相对路径一致
    for url_path, sub_dir in MEDIA_MOUNTS.items():
        router.mount(url_path, StaticFiles(directory=os.path.join(media_dir, sub_dir),
                                           check_dir=False), name=f"media{sub_dir}")

    @router.get("/data/videos.json")
    async def video_manifest():
        """学习资料视频清单（原 前端/data/videos.json）"""
        path = os.path.join(media_dir, "videos.json")
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="视频清单缺失：data/media/videos.json")
        return FileResponse(path, media_type="application/json")

    @router.get("/api/kline")
    async def kline(secid: str = "sh000001"):
        """行情数据：A 股/北证50 返回 5 分钟 K 线，港股/美股用今开→现价两点构造（契约同原 proxy-server）"""
        try:
            if secid == BJ_INDEX_SECID:
                try:
                    klines = await _fetch_eastmoney_kline()
                except Exception as e:
                    logger.warning("北证50 东财失败，改用新浪兜底: %s", e)
                    klines = _transform_kline(await _fetch_sina_kline(secid))
            elif _is_a_share(secid):
                klines = _transform_kline(await _fetch_sina_kline(secid))
            else:
                info = _parse_realtime(await _fetch_sina_realtime(secid), secid)
                klines = []
                if info and not math.isnan(info["value"]) and not math.isnan(info["prevClose"]):
                    day = datetime.date.today().isoformat()
                    klines = [
                        f"{day} 09:30:00,{info['prevClose']},{info['prevClose']},"
                        f"{info['prevClose']},{info['prevClose']},0",
                        f"{day} 15:00:00,{info['value']},{info['value']},"
                        f"{info['value']},{info['value']},0",
                    ]
        except Exception as e:
            logger.warning("行情获取失败: secid=%s %s", secid, e)
            raise HTTPException(status_code=500, detail=f"拿数据失败了：{e}")

        if not klines:
            raise HTTPException(status_code=500, detail="拿数据失败了：返回数据为空")
        logger.info("行情获取成功: secid=%s %d 条", secid, len(klines))
        return {"data": {"klines": klines}}

    @router.get("/api/news")
    async def news():
        """首页新闻区：新浪滚动财经新闻 -> {domestic: [{title, url, source}]}

        5 分钟内存缓存；抓取失败时返回上次缓存或空列表（前端会保留页面里的静态新闻）。
        """
        now = time.time()
        cached = _news_cache["data"]
        if cached is not None and now - _news_cache["ts"] < NEWS_CACHE_TTL:
            return cached
        try:
            data = await _fetch_sina_news()
        except Exception as e:
            logger.warning("新闻获取失败: %s", e)
            return cached if cached is not None else {"domestic": []}
        _news_cache["data"] = data
        _news_cache["ts"] = now
        logger.info("新闻获取成功: %d 条", len(data["domestic"]))
        return data

    return router


def mount_site(app, frontend_dir: str) -> None:
    """把前端页面挂到根路径（必须在所有 API 路由之后调用，否则会抢先匹配）。

    只有页面自身的 html/css/js/字体/logo 从这里出，数据一律走上面的接口。
    """
    app.mount("/", StaticFiles(directory=frontend_dir, html=True, check_dir=False), name="site")
