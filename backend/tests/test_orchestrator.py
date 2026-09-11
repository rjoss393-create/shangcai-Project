"""orchestrator 测试：三个场景 + 降级路径 + 并行取图"""
import time

from controller.dispatcher import CircuitBreaker, Dispatcher
from controller.orchestrator import FALLBACK_NOTICE, Orchestrator
from fakes import FakeGraphService, FakeIntentAgent, FakeReasonAgent


def make_orchestrator(service=None, intent=None, reason=None, dispatcher=None):
    return Orchestrator(service or FakeGraphService(), intent, reason,
                        dispatcher=dispatcher)


def _types(resp):
    return [a.type.value for a in resp.actions]


class TestLoadGraph:
    async def test_load_full_graph(self):
        o = make_orchestrator()
        resp = await o.handle_load_graph()
        assert resp.code == 0
        assert resp.session_id
        assert {n.id for n in resp.data.nodes} == {"n1", "n2", "n3"}
        assert _types(resp) == ["fade_in", "zoom"]
        assert resp.degraded is False

    async def test_load_reuses_session(self):
        o = make_orchestrator()
        r1 = await o.handle_load_graph()
        r2 = await o.handle_load_graph(r1.session_id)
        assert r2.session_id == r1.session_id

    async def test_load_service_error_returns_500(self):
        o = make_orchestrator(service=FakeGraphService(fail_full=True))
        resp = await o.handle_load_graph()
        assert resp.code == 500
        assert resp.data is None
        assert "失败" in resp.message


class TestNodeClick:
    async def test_click_returns_subgraph_and_focus(self):
        o = make_orchestrator()
        resp = await o.handle_node_click("n1")
        assert resp.code == 0
        assert {n.id for n in resp.data.nodes} == {"n1", "n2"}
        assert resp.actions[0].type.value == "focus"
        assert resp.actions[0].targets == ["n1"]
        ctx = await o.context.get(resp.session_id)
        assert ctx.focused_node_id == "n1"

    async def test_click_unknown_node_returns_empty(self):
        o = make_orchestrator()
        resp = await o.handle_node_click("n999")
        assert resp.code == 0
        assert resp.data.nodes == []

    async def test_click_service_error_returns_500(self):
        o = make_orchestrator(service=FakeGraphService(fail_ids={"n1"}))
        resp = await o.handle_node_click("n1")
        assert resp.code == 500


class TestQuery:
    async def test_keyword_query_fast_channel(self):
        service = FakeGraphService()
        o = Orchestrator(service, None, None)
        resp = await o.handle_query("杠杆收购")
        assert service.search_keywords_calls == 1
        assert service.get_sub_graph_calls == []
        assert {n.id for n in resp.data.nodes} == {"n2"}
        assert _types(resp) == ["highlight", "zoom"]

    async def test_nl_query_agent_channel(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=["n1", "n3"])
        reason = FakeReasonAgent()
        o = Orchestrator(service, intent, reason)
        resp = await o.handle_query("解释一下并购协同效应和国际投资")
        assert intent.calls == 1
        assert reason.calls == 1
        assert set(service.get_sub_graph_calls) == {"n1", "n3"}
        assert {n.id for n in resp.data.nodes} == {"n1", "n2", "n3"}
        assert _types(resp) == ["highlight", "text_popup", "zoom"]
        assert resp.actions[0].targets == ["n1", "n3"]

    async def test_nl_query_without_reason_agent(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=["n1"])
        o = Orchestrator(service, intent, None)
        resp = await o.handle_query("解释一下并购协同效应")
        assert _types(resp) == ["highlight", "zoom"]

    async def test_intent_empty_entities_falls_back(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=[])
        o = Orchestrator(service, intent)
        resp = await o.handle_query("解释一下随便说说")
        assert resp.degraded is True
        assert resp.notice == FALLBACK_NOTICE
        assert service.search_keywords_calls == 1

    async def test_intent_timeout_falls_back(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=["n1"], delay=0.2)
        dispatcher = Dispatcher(agent_timeout=0.05)
        o = Orchestrator(service, intent, None, dispatcher=dispatcher)
        resp = await o.handle_query("解释一下并购协同效应")
        assert resp.degraded is True
        assert service.search_keywords_calls == 1

    async def test_intent_error_falls_back(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(raise_error=True)
        o = Orchestrator(service, intent)
        resp = await o.handle_query("解释一下并购协同效应")
        assert resp.degraded is True
        assert resp.notice == FALLBACK_NOTICE

    async def test_open_breaker_short_circuits_agent(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=["n1"])
        breaker = CircuitBreaker(failure_threshold=1)
        breaker.record_failure()  # 预先置为熔断
        o = Orchestrator(service, intent, None, dispatcher=Dispatcher(breaker=breaker))
        resp = await o.handle_query("解释一下并购协同效应")
        assert intent.calls == 0
        assert resp.degraded is True

    async def test_reason_agent_failure_keeps_main_flow(self):
        service = FakeGraphService()
        intent = FakeIntentAgent(entities=["n1"])
        reason = FakeReasonAgent(raise_error=True)
        o = Orchestrator(service, intent, reason)
        resp = await o.handle_query("解释一下并购协同效应")
        assert resp.code == 0
        assert resp.degraded is False
        # 摘要失败 -> 无 text_popup，highlight/zoom 正常
        assert _types(resp) == ["highlight", "zoom"]


class TestParallelFetch:
    async def test_entities_fetched_in_parallel(self):
        service = FakeGraphService(delay=0.15)
        intent = FakeIntentAgent(entities=["n1", "n3"])
        o = Orchestrator(service, intent, None)
        start = time.perf_counter()
        resp = await o.handle_query("解释一下并购")
        elapsed = time.perf_counter() - start
        assert {n.id for n in resp.data.nodes} == {"n1", "n2", "n3"}
        assert set(service.get_sub_graph_calls) == {"n1", "n3"}
        # 串行需 ~0.3s（两个实体各 0.15s），并行应接近单次延迟
        assert elapsed < 0.27

    async def test_single_entity_failure_ignored(self):
        service = FakeGraphService(fail_ids={"n3"})
        intent = FakeIntentAgent(entities=["n1", "n3"])
        o = Orchestrator(service, intent, None)
        resp = await o.handle_query("解释一下并购")
        assert resp.code == 0
        assert {n.id for n in resp.data.nodes} == {"n1", "n2"}
