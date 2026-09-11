"""dispatcher 测试：路由判定 / 关键词提取 / 熔断器 / 超时降级"""
import asyncio
import time

import pytest

from controller.dispatcher import (
    QA_TIMEOUT_SECONDS,
    CircuitBreaker,
    Dispatcher,
    RouteKind,
    extract_keywords,
)


class TestDecide:
    def test_node_click_always_regular(self):
        assert Dispatcher().decide_node_click("n1") == RouteKind.REGULAR

    @pytest.mark.parametrize(
        "text",
        ["什么是并购", "为什么并购", "如何估值", "解释一下协同效应", "A和B的区别？"],
    )
    def test_natural_language_complex(self, text):
        assert Dispatcher().decide_text(text) == RouteKind.COMPLEX

    @pytest.mark.parametrize("text", ["杠杆收购", "并购协同效应", "CAPM"])
    def test_short_keyword_regular(self, text):
        assert Dispatcher().decide_text(text) == RouteKind.REGULAR

    def test_long_text_complex(self):
        # 长文本且无标志词 -> 复杂通道
        text = "请帮我整理一下杠杆收购这个概念涉及到的所有内容"
        assert Dispatcher().decide_text(text) == RouteKind.COMPLEX


class TestExtractKeywords:
    def test_split_and_dedup(self):
        assert extract_keywords("杠杆收购 杠杆收购") == ["杠杆收购"]

    def test_punctuation_split(self):
        assert extract_keywords("杠杆收购，并购重组") == ["杠杆收购", "并购重组"]

    def test_stopwords_removed(self):
        assert extract_keywords("的 杠杆收购 了") == ["杠杆收购"]

    def test_max_keywords(self):
        assert len(extract_keywords("a b c d e f g h", max_keywords=5)) == 5

    def test_all_stopwords_empty(self):
        assert extract_keywords("的 了 是") == []


class TestCircuitBreaker:
    def test_open_after_threshold_failures(self):
        b = CircuitBreaker(failure_threshold=3)
        b.record_failure()
        b.record_failure()
        assert not b.is_open
        b.record_failure()
        assert b.is_open

    def test_success_resets(self):
        b = CircuitBreaker(failure_threshold=2)
        b.record_failure()
        b.record_success()
        b.record_failure()
        assert not b.is_open

    def test_recover_after_cooldown(self):
        b = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.05)
        b.record_failure()
        assert b.is_open
        time.sleep(0.1)
        assert not b.is_open


class TestCallAgent:
    async def test_success(self):
        async def ok():
            return "ok"

        d = Dispatcher()
        assert await d.call_agent(ok) == "ok"

    async def test_exception_counts_failure(self):
        async def boom():
            raise RuntimeError("x")

        d = Dispatcher(breaker=CircuitBreaker(failure_threshold=2))
        assert await d.call_agent(boom) is None
        assert not d.breaker.is_open
        assert await d.call_agent(boom) is None
        assert d.breaker.is_open  # 异常计入熔断失败次数

    async def test_timeout_returns_none(self):
        d = Dispatcher(agent_timeout=0.05)
        assert await d.call_agent(lambda: asyncio.sleep(0.2)) is None
        assert d.breaker.is_open is False  # 一次失败未达默认阈值(3)

    async def test_open_breaker_short_circuits(self):
        b = CircuitBreaker(failure_threshold=1)
        b.record_failure()  # 预先置为熔断
        d = Dispatcher(breaker=b)
        called = []

        async def probe():
            called.append(1)
            return "x"

        assert await d.call_agent(probe) is None
        assert called == []  # 熔断期间根本不调用

    def test_default_timeout_constant(self):
        # Agent 层缓存命中平均 2.7s，放宽避免首次加载图谱被误杀
        assert QA_TIMEOUT_SECONDS == 20.0
