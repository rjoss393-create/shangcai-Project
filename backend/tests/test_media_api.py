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


class TestManifests:
    """清单类数据由后端按前端原路径提供（/data/videos.json、/data/courses.json）"""

    def test_videos_manifest(self, client, tmp_path):
        (tmp_path / "videos.json").write_text('{"videos":[{"id":1}]}', encoding="utf-8")
        r = client.get("/data/videos.json")
        assert r.status_code == 200
        assert r.json()["videos"][0]["id"] == 1

    def test_courses_manifest(self, client, tmp_path):
        (tmp_path / "courses.json").write_text('{"domains":[{"id":"econ_base"}]}', encoding="utf-8")
        r = client.get("/data/courses.json")
        assert r.status_code == 200
        assert r.json()["domains"][0]["id"] == "econ_base"

    def test_textbooks_manifest(self, client, tmp_path):
        """教材清单（课程板块「阅读原文」的索引）"""
        (tmp_path / "textbooks.json").write_text(
            '{"count":1,"books":[{"id":"kuhn-scientific-revolutions"}]}', encoding="utf-8")
        r = client.get("/data/textbooks.json")
        assert r.status_code == 200
        assert r.json()["books"][0]["id"] == "kuhn-scientific-revolutions"

    def test_textbook_file_served(self, client, tmp_path):
        """教材原文按前端原相对路径提供：/assets/textbooks/<file>"""
        d = tmp_path / "textbooks"
        d.mkdir()
        (d / "demo.pdf").write_bytes(b"%PDF-1.4 demo")
        r = client.get("/assets/textbooks/demo.pdf")
        assert r.status_code == 200
        assert r.content.startswith(b"%PDF")

    def test_databases_manifest(self, client, tmp_path):
        """数据库板块清单：前端 js/database-board.js 按 data/databases.json 请求"""
        (tmp_path / "databases.json").write_text(
            '{"meta":{"title":"数据库"},"groups":[{"id":"intl","rows":[[]]}]}', encoding="utf-8")
        r = client.get("/data/databases.json")
        assert r.status_code == 200
        assert r.json()["groups"][0]["id"] == "intl"

    def test_databases_api_wraps_unified_envelope(self, client, tmp_path):
        """同一份数据也提供带统一响应外壳的 /api/databases（前端 USE_API=true 时走这条）"""
        (tmp_path / "databases.json").write_text('{"groups":[{"id":"intl"}]}', encoding="utf-8")
        r = client.get("/api/databases")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == 0
        assert body["data"]["groups"][0]["id"] == "intl"

    def test_comics_assets_served_at_original_relative_path(self, client, tmp_path):
        """知识点小漫画图片按前端原相对路径提供：/assets/comics/<dir>/<album>_<n>.jpg"""
        d = tmp_path / "comics" / "inv"
        d.mkdir(parents=True)
        (d / "inv_p01_2.jpg").write_bytes(b"\xff\xd8\xff\xe0 demo jpeg")
        r = client.get("/assets/comics/inv/inv_p01_2.jpg")
        assert r.status_code == 200
        assert r.content.startswith(b"\xff\xd8\xff")

    def test_comics_manifest(self, client, tmp_path):
        """漫画清单：前端 js/comic-reader.js 按 data/comics.json 请求"""
        (tmp_path / "comics.json").write_text(
            '{"pages_per_part":6,"total_albums":1,"albums":[{"id":"inv_p01","part":1}]}',
            encoding="utf-8")
        r = client.get("/data/comics.json")
        assert r.status_code == 200
        assert r.json()["albums"][0]["id"] == "inv_p01"
        assert r.json()["pages_per_part"] == 6

    def test_comics_api_wraps_unified_envelope(self, client, tmp_path):
        """同一份清单也提供带统一响应外壳的 /api/comics"""
        (tmp_path / "comics.json").write_text('{"albums":[{"id":"cf_p06"}]}', encoding="utf-8")
        r = client.get("/api/comics")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == 0
        assert body["data"]["albums"][0]["id"] == "cf_p06"

    def test_course_graph_fallback_served_at_site_root(self, client, tmp_path):
        """课程图谱本地兜底 JSON 按前端原文件名挂在站点根目录"""
        d = tmp_path / "graphs"
        d.mkdir()
        (d / "course_graph_investment.json").write_text(
            '{"nodes":[{"id":"inv_macro_001","level":"macro"}]}', encoding="utf-8")
        r = client.get("/course_graph_investment.json")
        assert r.status_code == 200
        assert r.json()["nodes"][0]["id"] == "inv_macro_001"

    def test_missing_manifest_returns_404(self, client):
        assert client.get("/data/courses.json").status_code == 404
        assert client.get("/data/textbooks.json").status_code == 404
        assert client.get("/data/databases.json").status_code == 404
        assert client.get("/api/databases").status_code == 404
        assert client.get("/data/comics.json").status_code == 404
        assert client.get("/api/comics").status_code == 404
        assert client.get("/course_graph_investment.json").status_code == 404
        assert client.get("/course_graph_mergers.json").status_code == 404
        assert client.get("/course_graph_corporate_finance.json").status_code == 404


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
