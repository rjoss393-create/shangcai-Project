"""核心编排器（职责2）：调度 Service/Agent，整合结果并维护上下文

标准场景（controller.txt）：
1. handle_load_graph  —— 页面加载：Service.get_full_graph（快通道）
                         + 后台触发 Agent 预加载（预热图谱，不阻塞页面加载）
2. handle_node_click  —— 节点点击：Service.get_sub_graph（快通道）
3. handle_query       —— 文本查询：
      自然语言 -> Dispatcher 判定 COMPLEX -> Agent 问答（慢通道，超时降级）
      关键词   -> Dispatcher 判定 REGULAR -> Service.search_keywords（快通道）

每次响应后通过 SessionContextManager 更新会话上下文（焦点/可见集/最近查询）。
"""
import asyncio
import logging
from typing import Sequence

from .assembler import AnimationAssembler
from .context_manager import SessionContextManager
from .dispatcher import Dispatcher, RouteKind, extract_keywords
from .graph_ids import GRAPH_IDS
from .interfaces import GraphService, QaAgent
from .schemas import AnswerResult, GraphData, UnifiedResponse

logger = logging.getLogger(__name__)

FALLBACK_NOTICE = "智能分析暂时不可用，已切换到基础检索模式"
NO_GRAPH_NOTICE = "缺少图谱标识（graph_id），智能问答不可用，已切换到基础检索模式"


class Orchestrator:
    def __init__(
        self,
        service: GraphService,
        qa_agent: QaAgent | None = None,
        *,
        dispatcher: Dispatcher | None = None,
        context_manager: SessionContextManager | None = None,
        assembler: AnimationAssembler | None = None,
    ):
        self.service = service
        self.qa_agent = qa_agent
        self.dispatcher = dispatcher or Dispatcher()
        self.context = context_manager or SessionContextManager()
        self.assembler = assembler or AnimationAssembler()
        self._preload_tasks: dict[str, asyncio.Task] = {}

    # ---------- 场景入口 ----------

    async def handle_load_graph(
        self, session_id: str | None = None, graph_id: str | None = None
    ) -> UnifiedResponse:
        ctx = await self.context.get_or_create(session_id)
        try:
            graph = await self.service.get_full_graph(graph_id)
        except Exception as exc:
            logger.exception("加载全图失败")
            return self._error(ctx.session_id, f"加载图谱失败: {exc}")
        self._attach_graph_meta(graph, graph_id)
        actions = self.assembler.assemble_load(graph)
        await self.context.update_after_response(
            ctx.session_id, visible_node_ids={n.id for n in graph.nodes}
        )
        # 后台预热 Agent（页面打开时转移首次提问的冷启动成本）
        self._schedule_preload(graph_id, graph)
        return self._ok(ctx.session_id, graph, actions)

    async def handle_node_click(
        self, node_id: str, session_id: str | None = None, graph_id: str | None = None
    ) -> UnifiedResponse:
        """场景1：节点点击（常规查询，快通道）"""
        ctx = await self.context.get_or_create(session_id)
        previous_visible = set(ctx.visible_node_ids)
        try:
            subgraph = await self.service.get_sub_graph(node_id, depth=1, graph_id=graph_id)
        except Exception as exc:
            logger.exception("获取节点子图失败: %s", node_id)
            return self._error(ctx.session_id, f"获取节点子图失败: {exc}")
        actions = self.assembler.assemble_node_click(node_id, subgraph, previous_visible)
        await self.context.update_after_response(
            ctx.session_id,
            focused_node_id=node_id,
            visible_node_ids={n.id for n in subgraph.nodes},
        )
        return self._ok(ctx.session_id, subgraph, actions)

    async def handle_query(
        self, text: str, session_id: str | None = None, graph_id: str | None = None
    ) -> UnifiedResponse:
        """场景2/3：文本查询，Dispatcher 判定走快通道还是慢通道"""
        ctx = await self.context.get_or_create(session_id)
        if self.dispatcher.decide_text(text) == RouteKind.REGULAR:
            return await self._handle_keyword_query(ctx.session_id, text, graph_id=graph_id)
        return await self._handle_agent_query(ctx.session_id, text, graph_id)

    # ---------- 内部流程 ----------

    async def _handle_keyword_query(
        self,
        session_id: str,
        text: str,
        *,
        graph_id: str | None = None,
        notice: str | None = None,
        degraded: bool = False,
    ) -> UnifiedResponse:
        """快通道：关键词检索"""
        keywords = extract_keywords(text)
        if not keywords:
            return self._error(session_id, "未识别出有效关键词")
        try:
            subgraph = await self.service.search_keywords(keywords, graph_id=graph_id)
        except Exception as exc:
            logger.exception("关键词检索失败")
            return self._error(session_id, f"检索失败: {exc}")
        actions = self.assembler.assemble_fallback(subgraph)
        await self.context.update_after_response(
            session_id, query=text, visible_node_ids={n.id for n in subgraph.nodes}
        )
        return self._ok(session_id, subgraph, actions, degraded=degraded, notice=notice)

    async def _handle_agent_query(
        self, session_id: str, text: str, graph_id: str | None
    ) -> UnifiedResponse:
        """慢通道：Agent 智能问答 -> 为答案引用的节点取子图 -> 定位高亮；失败则降级"""
        if self.qa_agent is None or self.dispatcher.breaker.is_open:
            return await self._fallback_query(session_id, text)
        if not graph_id:
            return await self._handle_keyword_query(
                session_id, text, notice=NO_GRAPH_NOTICE, degraded=True
            )

        # Agent 契约（《字段.md》）：answer 收全图数据（内含 graph_id），取图失败则降级
        try:
            graph = await self.service.get_full_graph(graph_id)
        except Exception:
            logger.exception("获取全图失败，降级关键词检索")
            return await self._fallback_query(session_id, text, graph_id)
        self._attach_graph_meta(graph, graph_id)

        answer: AnswerResult | None = await self.dispatcher.call_agent(
            lambda: self.qa_agent.answer(graph, text)
        )
        if answer is None:
            return await self._fallback_query(session_id, text, graph_id)

        # 按答案引用的节点并行取局部图，合并去重（供图谱画布定位高亮）
        related_ids = [n.id for n in answer.related_nodes]
        subgraph = (
            await self._fetch_entity_subgraphs(related_ids, graph_id)
            if related_ids
            else GraphData()
        )

        actions = self.assembler.assemble_qa(related_ids, subgraph)
        await self.context.update_after_response(
            session_id, query=text, visible_node_ids={n.id for n in subgraph.nodes}
        )
        return self._ok(session_id, subgraph, actions, answer=answer)

    # ---------- 预加载（Agent 预热） ----------

    def _schedule_preload(self, graph_id: str | None, graph: GraphData) -> None:
        """页面打开时后台预热 Agent：不阻塞页面加载，同一图谱去重"""
        if graph_id is None or self.qa_agent is None:
            return
        task = self._preload_tasks.get(graph_id)
        if task is not None and not task.done():
            return
        self._preload_tasks[graph_id] = asyncio.create_task(
            self._preload(graph_id, graph)
        )

    async def _preload(self, graph_id: str, graph: GraphData) -> None:
        """预热失败只记日志：不触发熔断、不影响页面加载（首次提问会变慢而已）"""
        try:
            await self.qa_agent.preload(graph_id, graph)
        except Exception:
            logger.exception("Agent 预热图谱失败: %s", graph_id)

    async def _fallback_query(
        self, session_id: str, text: str, graph_id: str | None = None
    ) -> UnifiedResponse:
        """场景3：Agent 超时/熔断/异常 -> 基础关键词检索兜底"""
        return await self._handle_keyword_query(
            session_id, text, graph_id=graph_id, notice=FALLBACK_NOTICE, degraded=True
        )

    # ---------- 工具 ----------

    @staticmethod
    def _attach_graph_meta(graph: GraphData, graph_id: str | None) -> None:
        """转交 Agent 前补 graph_id / title（《字段.md》：graph_id 必填、title 可选）"""
        if graph_id:
            graph.graph_id = graph_id
            graph.title = GRAPH_IDS.get(graph_id, "")

    async def _fetch_entity_subgraphs(
        self, entity_ids: Sequence[str], graph_id: str | None = None
    ) -> GraphData:
        """并行获取各实体的局部子图并合并去重（单个失败仅告警，不影响其他）"""

        async def _fetch_one(entity_id: str) -> GraphData | None:
            try:
                return await self.service.get_sub_graph(
                    entity_id, depth=1, graph_id=graph_id
                )
            except Exception:
                logger.warning("获取实体子图失败: %s", entity_id)
                return None

        subgraphs = await asyncio.gather(*(_fetch_one(eid) for eid in entity_ids))
        return self._merge_graphs([g for g in subgraphs if g is not None])

    def _ok(
        self,
        session_id: str,
        data: GraphData,
        actions: list,
        *,
        answer: AnswerResult | None = None,
        degraded: bool = False,
        notice: str | None = None,
    ) -> UnifiedResponse:
        return UnifiedResponse(
            session_id=session_id, data=data, answer=answer, actions=actions,
            degraded=degraded, notice=notice,
        )

    def _error(self, session_id: str, message: str) -> UnifiedResponse:
        return UnifiedResponse(code=500, message=message, session_id=session_id)

    @staticmethod
    def _merge_graphs(graphs: Sequence[GraphData]) -> GraphData:
        """合并多个子图（按节点 id、边三元组去重）"""
        nodes: dict[str, object] = {}
        edges: dict[tuple, object] = {}
        for g in graphs:
            for n in g.nodes:
                nodes[n.id] = n
            for e in g.edges:
                edges[(e.source, e.target, e.relation)] = e
        return GraphData(nodes=list(nodes.values()), edges=list(edges.values()))
