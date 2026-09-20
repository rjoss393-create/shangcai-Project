"""行情 / 新闻接口测试（/api/kline、/api/news）：外部抓取一律打桩，不出网"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller import media as media_module
from controller.media import create_media_router


@pytest.fixture(autouse=True)
def _clear_news_cache():
    """新闻有 5 分钟内存缓存，逐个用例前清空"""
    media_module._news_cache.update({"data": None, "ts": 0.0})


@pytest.fixture
def client(tmp_path) -> TestClient:
    app = FastAPI()
    app.include_router(create_media_router(str(tmp_path)))
    return TestClient(app)


class TestKline:
    def test_bj899050_via_eastmoney(self, client, monkeypatch):
        """北证50 走东方财富，原样返回其 klines（前端按逗号切分取收盘价）"""
        async def fake() -> list[str]:
            return ["2026-09-18 09:35:00,1000.00,1005.00,1010.00,995.00,123400"]

        monkeypatch.setattr(media_module, "_fetch_eastmoney_kline", fake)
        r = client.get("/api/kline", params={"secid": "bj899050"})
        assert r.status_code == 200
        assert r.json()["data"]["klines"][0].split(",")[2] == "1005.00"

    def test_a_share_via_sina_transformed(self, client, monkeypatch):
        async def fake(code: str) -> list[dict]:
            return [{"day": "2026-09-18 09:35:00", "open": "10.00", "close": "10.50",
                     "high": "10.60", "low": "9.90", "volume": "1000"}]

        monkeypatch.setattr(media_module, "_fetch_sina_kline", fake)
        r = client.get("/api/kline", params={"secid": "sh000001"})
        assert r.status_code == 200
        assert r.json()["data"]["klines"] == ["2026-09-18 09:35:00,10.00,10.50,10.60,9.90,1000"]

    def test_bj899050_falls_back_to_sina(self, client, monkeypatch):
        """东财不可达时（实测 Server disconnected）改用新浪，仍返回可用的 K 线"""
        async def boom() -> list[str]:
            raise RuntimeError("Server disconnected without sending a response")

        async def fake(code: str) -> list[dict]:
            assert code == "bj899050"
            return [{"day": "2026-09-18 14:55:00", "open": "1043.671", "close": "1043.792",
                     "high": "1044.076", "low": "1042.874", "volume": "25382235"}]

        monkeypatch.setattr(media_module, "_fetch_eastmoney_kline", boom)
        monkeypatch.setattr(media_module, "_fetch_sina_kline", fake)
        r = client.get("/api/kline", params={"secid": "bj899050"})
        assert r.status_code == 200
        assert r.json()["data"]["klines"] == ["2026-09-18 14:55:00,1043.671,1043.792,1044.076,1042.874,25382235"]

    def test_upstream_failure_returns_500(self, client, monkeypatch):
        async def boom() -> list[str]:
            raise RuntimeError("域名都超时了")

        monkeypatch.setattr(media_module, "_fetch_eastmoney_kline", boom)
        monkeypatch.setattr(media_module, "_fetch_sina_kline", boom)
        r = client.get("/api/kline", params={"secid": "bj899050"})
        assert r.status_code == 500
        assert "拿数据失败了" in r.json()["detail"]


class TestNews:
    def test_returns_domestic_list_and_caches(self, client, monkeypatch):
        calls = {"n": 0}

        async def fake() -> dict:
            calls["n"] += 1
            return {"domestic": [{"title": "央行降准", "url": "https://example.com/1",
                                  "source": "中国人民银行"}]}

        monkeypatch.setattr(media_module, "_fetch_sina_news", fake)
        first = client.get("/api/news").json()
        second = client.get("/api/news").json()
        assert first["domestic"][0]["title"] == "央行降准"
        assert first == second
        assert calls["n"] == 1                    # 第二次命中缓存，未再抓取

    def test_failure_returns_empty_and_keeps_frontend_static(self, client, monkeypatch):
        async def boom() -> dict:
            raise RuntimeError("新浪超时")

        monkeypatch.setattr(media_module, "_fetch_sina_news", boom)
        r = client.get("/api/news")
        assert r.status_code == 200 and r.json() == {"domestic": []}

    def test_failure_falls_back_to_last_cache(self, client, monkeypatch):
        async def ok() -> dict:
            return {"domestic": [{"title": "旧闻", "url": "https://example.com/old", "source": "新浪"}]}

        monkeypatch.setattr(media_module, "_fetch_sina_news", ok)
        client.get("/api/news")

        async def boom() -> dict:
            raise RuntimeError("新浪超时")

        monkeypatch.setattr(media_module, "_fetch_sina_news", boom)
        media_module._news_cache["ts"] = 0.0      # 让缓存过期，但数据仍在
        assert client.get("/api/news").json()["domestic"][0]["title"] == "旧闻"
