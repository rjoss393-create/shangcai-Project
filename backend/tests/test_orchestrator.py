"""orchestrator 测试：三个场景 + 降级路径 + 并行取图 + Agent 预热"""
import asyncio
import time

from controller.dispatcher import CircuitBreaker, Dispatcher
from controller.orchestrator import FALLBACK_NOTICE, NO_GRAPH_NOTICE, Orchestrator
from fakes import FakeGraphService, FakeQaAgent


def make_orchestrator(service=None, qa=None, dispatcher=None):
    return Orchestrator(service or FakeGraphService(), qa, dispatcher=dispatcher)


def _types(resp):
    return [a.type.value for a in resp.actions]


async def _await_preloads(o):
    """等待编排器内的全部后台预热任务结束"""
    tasks = list(o._preload_tasks.values())
    if tasks:
        await asyncio.gather(*tasks)


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


class TestPreload:
    async def test_load_schedules_preload_in_background(self):
        qa = FakeQaAgent(preload_delay=0.05)
        o = Orchestrator(FakeGraphService(), qa)
        resp = await o.handle_load_graph(graph_id="gsjr")
        assert resp.code == 0  # 页面加载不等待预热
        await _await_preloads(o)
        assert qa.preload_calls == ["gsjr"]

    async def test_preload_dedup_while_running(self):
        # 预热进行中重复 /load：不重复调用 agent.preload
        qa = FakeQaAgent(preload_delay=0.05)
        o = Orchestrator(FakeGraphService(), qa)
        await o.handle_load_graph(graph_id="gsjr")
        await o.handle_load_graph(graph_id="gsjr")
        await _await_preloads(o)
        assert qa.preload_calls == ["gsjr"]

    async def test_preload_retried_after_completion(self):
        # 预热完成（无论成败）后再 /load：重新预热（agent 缓存幂等，代价低）
        qa = FakeQaAgent()
        o = Orchestrator(FakeGraphService(), qa)
        await o.handle_load_graph(graph_id="gsjr")
        await _await_preloads(o)
        await o.handle_load_graph(graph_id="gsjr")
        await _await_preloads(o)
        assert qa.preload_calls == ["gsjr", "gsjr"]

    async def test_no_graph_id_skips_preload(self):
        qa = FakeQaAgent()
        o = Orchestrator(FakeGraphService(), qa)
        await o.handle_load_graph()
        assert qa.preload_calls == []

    async def test_preload_failure_does_not_break_load(self):
        qa = FakeQaAgent(raise_preload=True)
        o = Orchestrator(FakeGraphService(), qa)
        resp = await o.handle_load_graph(graph_id="gsjr")
        await _await_preloads(o)
        assert resp.code == 0


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
        o = Orchestrator(service, None)
        resp = await o.handle_query("杠杆收购")
        assert service.search_keywords_calls == 1
        assert service.get_sub_graph_calls == []
        assert {n.id for n in resp.data.nodes} == {"n2"}
        assert _types(resp) == ["highlight", "zoom"]

    async def test_nl_query_agent_channel(self):
        service = FakeGraphService()
        qa = FakeQaAgent(related_ids=["n1", "n3"])
        o = Orchestrator(service, qa)
        resp = await o.handle_query("解释一下并购协同效应和国际投资", graph_id="gsjr")
        assert qa.calls == 1
        assert service.get_full_graph_calls == 1   # answer 收全图数据（《字段.md》契约）
        assert qa.last_graph_id == "gsjr"          # 全图数据里已填充 graph_id
        assert set(service.get_sub_graph_calls) == {"n1", "n3"}
        assert {n.id for n in resp.data.nodes} == {"n1", "n2", "n3"}
        assert _types(resp) == ["focus", "highlight", "zoom"]
        assert resp.actions[0].targets == ["n1"]       # 聚焦首个引用节点
        assert set(resp.actions[1].targets) == {"n1", "n3"}
        assert resp.answer is not None
        assert resp.answer.prediction_html
        assert [n.id for n in resp.answer.related_nodes] == ["n1", "n3"]

    async def test_nl_query_related_not_in_graph(self):
        service = FakeGraphService()
        qa = FakeQaAgent(related_ids=["n999"])
        o = Orchestrator(service, qa)
        resp = await o.handle_query("解释一下不存在的节点", graph_id="gsjr")
        assert resp.code == 0
        assert resp.answer is not None
        assert _types(resp) == ["zoom"]  # 无节点可定位，只缩放

    async def test_query_without_qa_agent_falls_back(self):
        service = FakeGraphService()
        o = Orchestrator(service, None)
        resp = await o.handle_query("解释一下并购协同效应")
        assert resp.degraded is True
        assert resp.notice == FALLBACK_NOTICE
        assert service.search_keywords_calls == 1

    async def test_query_without_graph_id_falls_back(self):
        service = FakeGraphService()
        o = Orchestrator(service, FakeQaAgent())
        resp = await o.handle_query("解释一下并购协同效应")
        assert resp.degraded is True
        assert resp.notice == NO_GRAPH_NOTICE
        assert service.search_keywords_calls == 1

    async def test_agent_timeout_falls_back(self):
        service = FakeGraphService()
        qa = FakeQaAgent(delay=0.2)
        dispatcher = Dispatcher(agent_timeout=0.05)
        o = Orchestrator(service, qa, dispatcher=dispatcher)
        resp = await o.handle_query("解释一下并购协同效应", graph_id="gsjr")
        assert resp.degraded is True
        assert service.search_keywords_calls == 1

    async def test_agent_error_falls_back(self):
        service = FakeGraphService()
        qa = FakeQaAgent(raise_error=True)
        o = Orchestrator(service, qa)
        resp = await o.handle_query("解释一下并购协同效应", graph_id="gsjr")
        assert resp.degraded is True
        assert resp.notice == FALLBACK_NOTICE

    async def test_open_breaker_short_circuits_agent(self):
        service = FakeGraphService()
        qa = FakeQaAgent()
        breaker = CircuitBreaker(failure_threshold=1)
        breaker.record_failure()  # 预先置为熔断
        o = Orchestrator(service, qa, dispatcher=Dispatcher(breaker=breaker))
        resp = await o.handle_query("解释一下并购协同效应", graph_id="gsjr")
        assert qa.calls == 0
        assert resp.degraded is True


class TestParallelFetch:
    async def test_related_nodes_fetched_in_parallel(self):
        service = FakeGraphService(delay=0.15)
        qa = FakeQaAgent(related_ids=["n1", "n3"])
        o = Orchestrator(service, qa)
        start = time.perf_counter()
        resp = await o.handle_query("解释一下并购", graph_id="gsjr")
        elapsed = time.perf_counter() - start
        assert {n.id for n in resp.data.nodes} == {"n1", "n2", "n3"}
        assert set(service.get_sub_graph_calls) == {"n1", "n3"}
        # 全图 0.15s + 两个子图并行 0.15s ≈ 0.30s；子图串行需 ~0.45s
        assert elapsed < 0.40

    async def test_single_related_failure_ignored(self):
        service = FakeGraphService(fail_ids={"n3"})
        qa = FakeQaAgent(related_ids=["n1", "n3"])
        o = Orchestrator(service, qa)
        resp = await o.handle_query("解释一下并购", graph_id="gsjr")
        assert resp.code == 0
        assert resp.answer is not None
        assert {n.id for n in resp.data.nodes} == {"n1", "n2"}
