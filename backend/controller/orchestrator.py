"""核心编排器（职责2）：调度 Service/Agent，整合结果并维护上下文

标准场景（controller.txt）：
1. handle_load_graph  —— 页面加载：Service.get_full_graph（快通道）
2. handle_node_click  —— 节点点击：Service.get_sub_graph（快通道）
3. handle_query       —— 文本查询：
      自然语言 -> Dispatcher 判定 COMPLEX -> Agent（慢通道，超时降级）
      关键词   -> Dispatcher 判定 REGULAR -> Service.search_keywords（快通道）

每次响应后通过 SessionContextManager 更新会话上下文（焦点/可见集/最近查询）。
"""
import logging
from typing import Sequence

from .assembler import AnimationAssembler
from .context_manager import SessionContextManager
from .dispatcher import Dispatcher, RouteKind, extract_keywords
from .interfaces import GraphService, IntentAgent, ReasonAgent
from .schemas import GraphData, ReasonResult, UnifiedResponse

logger = logging.getLogger(__name__)

FALLBACK_NOTICE = "智能分析暂时不可用，已切换到基础检索模式"


class Orchestrator:
    def __init__(
        self,
        service: GraphService,
        intent_agent: IntentAgent | None = None,
        reason_agent: ReasonAgent | None = None,
        *,
        dispatcher: Dispatcher | None = None,
        context_manager: SessionContextManager | None = None,
        assembler: AnimationAssembler | None = None,
    ):
        self.service = service
        self.intent_agent = intent_agent
        self.reason_agent = reason_agent
        self.dispatcher = dispatcher or Dispatcher()
        self.context = context_manager or SessionContextManager()
        self.assembler = assembler or AnimationAssembler()

    # ---------- 场景入口 ----------

    async def handle_load_graph(self, session_id: str | None = None) -> UnifiedResponse:
        ctx = await self.context.get_or_create(session_id)
        try:
            graph = await self.service.get_full_graph()
        except Exception as exc:
            logger.exception("加载全图失败")
            return self._error(ctx.session_id, f"加载图谱失败: {exc}")
        actions = self.assembler.assemble_load(graph)
        await self.context.update_after_response(
            ctx.session_id, visible_node_ids={n.id for n in graph.nodes}
        )
        return self._ok(ctx.session_id, graph, actions)

    async def handle_node_click(
        self, node_id: str, session_id: str | None = None
    ) -> UnifiedResponse:
        """场景1：节点点击（常规查询，快通道）"""
        ctx = await self.context.get_or_create(session_id)
        previous_visible = set(ctx.visible_node_ids)
        try:
            subgraph = await self.service.get_sub_graph(node_id, depth=1)
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
        self, text: str, session_id: str | None = None
    ) -> UnifiedResponse:
        """场景2/3：文本查询，Dispatcher 判定走快通道还是慢通道"""
        ctx = await self.context.get_or_create(session_id)
        if self.dispatcher.decide_text(text) == RouteKind.REGULAR:
            return await self._handle_keyword_query(ctx.session_id, text)
        return await self._handle_agent_query(ctx.session_id, text, set(ctx.visible_node_ids))

    # ---------- 内部流程 ----------

    async def _handle_keyword_query(
        self,
        session_id: str,
        text: str,
        *,
        notice: str | None = None,
        degraded: bool = False,
    ) -> UnifiedResponse:
        """快通道：关键词检索"""
        keywords = extract_keywords(text)
        if not keywords:
            return self._error(session_id, "未识别出有效关键词")
        try:
            subgraph = await self.service.search_keywords(keywords)
        except Exception as exc:
            logger.exception("关键词检索失败")
            return self._error(session_id, f"检索失败: {exc}")
        actions = self.assembler.assemble_fallback(subgraph)
        await self.context.update_after_response(
            session_id, query=text, visible_node_ids={n.id for n in subgraph.nodes}
        )
        return self._ok(session_id, subgraph, actions, degraded=degraded, notice=notice)

    async def _handle_agent_query(
        self, session_id: str, text: str, previous_visible: set[str]
    ) -> UnifiedResponse:
        """慢通道：意图识别 -> 取局部图 -> 推理摘要；任一步失败则降级"""
        if self.intent_agent is None or self.dispatcher.breaker.is_open:
            return await self._fallback_query(session_id, text)

        intent = await self.dispatcher.call_agent(lambda: self.intent_agent.parse(text))
        if intent is None or not intent.entities:
            return await self._fallback_query(session_id, text)

        # 依实体取局部图，多实体结果合并去重
        subgraphs: list[GraphData] = []
        for entity_id in intent.entities:
            try:
                subgraphs.append(await self.service.get_sub_graph(entity_id, depth=1))
            except Exception:
                logger.warning("获取实体子图失败: %s", entity_id)
        subgraph = self._merge_graphs(subgraphs)

        # 摘要是可选增强：失败不影响主流程
        summary: ReasonResult | None = None
        if self.reason_agent is not None:
            summary = await self.dispatcher.call_agent(
                lambda: self.reason_agent.reason(text, intent.entities)
            )

        actions = self.assembler.assemble_nl_query(
            intent.entities, subgraph, summary, previous_visible
        )
        await self.context.update_after_response(
            session_id, query=text, visible_node_ids={n.id for n in subgraph.nodes}
        )
        return self._ok(session_id, subgraph, actions)

    async def _fallback_query(self, session_id: str, text: str) -> UnifiedResponse:
        """场景3：Agent 超时/熔断/异常 -> 基础关键词检索兜底"""
        return await self._handle_keyword_query(
            session_id, text, notice=FALLBACK_NOTICE, degraded=True
        )

    # ---------- 工具 ----------

    def _ok(
        self,
        session_id: str,
        data: GraphData,
        actions: list,
        *,
        degraded: bool = False,
        notice: str | None = None,
    ) -> UnifiedResponse:
        return UnifiedResponse(
            session_id=session_id, data=data, actions=actions,
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
