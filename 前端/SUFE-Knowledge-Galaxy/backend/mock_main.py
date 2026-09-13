"""Mock 联调服务器（仅供前后端联调，不进正式代码）

main.py / data_service / intent_agent / reason_agent 就绪前，
用假实现启动完整 HTTP 服务，让视图层同学可以先行联调。

启动方式（在 backend/ 目录下）：
    uvicorn mock_main:app --reload --port 8000

- Swagger 文档：http://localhost:8000/docs
- 已开启 CORS（允许所有来源），前端 dev server 可直接跨域调用
- 真实 Service/Agent 就绪后，把 create_router(...) 的三参数换成真实实现即可
"""
import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from controller.interfaces import GraphService, IntentAgent, ReasonAgent
from controller.router import create_router
from controller.schemas import GraphData, GraphEdge, GraphNode, IntentResult, ReasonResult

# 模拟 Agent 延迟（秒）：让前端能观察到"慢通道"的加载效果；调 0 可关闭
MOCK_AGENT_DELAY = 0.5

# ---------- 假图谱数据（字段与 graph.json / schemas.GraphNode 约定一致） ----------

_MOCK_NODES: list[GraphNode] = [
    GraphNode(id="n1", name="并购协同效应", category="概念",
              media={"text": "并购后企业整体价值大于各部分之和的现象，包括经营协同与财务协同。"}),
    GraphNode(id="n2", name="杠杆收购", category="概念",
              media={"text": "以目标企业资产和未来现金流为担保、大量举债进行的收购方式。"}),
    GraphNode(id="n3", name="并购与重组", category="课程",
              media={"text": "课程《并购与重组》：涵盖并购动因、协同效应、估值与反收购策略。"}),
    GraphNode(id="n4", name="资本结构", category="概念",
              media={"text": "企业长期资本的构成及比例关系，核心理论包括 MM 定理与权衡理论。"}),
    GraphNode(id="n5", name="公司金融", category="课程",
              media={"text": "课程《公司金融》：涵盖资本结构、股利政策、公司估值等。"}),
    GraphNode(id="n6", name="汇率风险", category="概念",
              media={"text": "汇率波动导致国际投资资产价值变动的风险。"}),
    GraphNode(id="n7", name="国际投资", category="课程",
              media={"text": "课程《国际投资》：涵盖跨国资本流动、汇率风险与政治风险。"}),
]

_MOCK_EDGES: list[GraphEdge] = [
    GraphEdge(source="n3", target="n1", relation="包含"),
    GraphEdge(source="n3", target="n2", relation="包含"),
    GraphEdge(source="n1", target="n2", relation="相关"),
    GraphEdge(source="n5", target="n4", relation="包含"),
    GraphEdge(source="n5", target="n3", relation="相关"),
    GraphEdge(source="n7", target="n6", relation="包含"),
    GraphEdge(source="n5", target="n7", relation="相关"),
]


class MockGraphService:
    """假数据服务：内存图谱 + 一跳子图 + 模糊关键词检索"""

    def __init__(self):
        self._nodes = {n.id: n for n in _MOCK_NODES}
        self._edges = list(_MOCK_EDGES)

    async def get_full_graph(self) -> GraphData:
        return GraphData(nodes=list(self._nodes.values()), edges=self._edges)

    async def get_sub_graph(self, node_id: str, depth: int = 1) -> GraphData:
        if node_id not in self._nodes:
            return GraphData(nodes=[], edges=[])
        # 广度优先收集 depth 跳内的节点
        seen = {node_id}
        frontier = {node_id}
        for _ in range(depth):
            neighbors = set()
            for e in self._edges:
                if e.source in frontier and e.target not in seen:
                    neighbors.add(e.target)
                if e.target in frontier and e.source not in seen:
                    neighbors.add(e.source)
            seen |= neighbors
            frontier = neighbors
        sub_edges = [
            e for e in self._edges if e.source in seen and e.target in seen
        ]
        return GraphData(
            nodes=[self._nodes[nid] for nid in seen], edges=sub_edges,
        )

    async def search_keywords(self, keywords, limit: int = 20) -> GraphData:
        matched_ids = set()
        for kw in keywords:
            for node in self._nodes.values():
                haystack = node.name + node.category + str(node.media)
                if kw and kw in haystack:
                    matched_ids.add(node.id)
        if not matched_ids:
            return GraphData(nodes=[], edges=[])
        # 命中节点 + 直接关联的边，让结果图是连通的
        matched_edges = [
            e for e in self._edges
            if e.source in matched_ids or e.target in matched_ids
        ]
        return GraphData(
            nodes=[self._nodes[nid] for nid in matched_ids][:limit],
            edges=matched_edges,
        )


class MockIntentAgent:
    """假意图识别：抽取文本中出现过的节点名 -> 节点 ID；无命中则给默认实体"""

    async def parse(self, text: str) -> IntentResult:
        await asyncio.sleep(MOCK_AGENT_DELAY)
        entities = [n.id for n in _MOCK_NODES if n.name in text]
        if not entities:
            entities = ["n1"]  # 默认命中"并购协同效应"，保证场景2有图可看
        return IntentResult(intent="query", entities=entities)


class MockReasonAgent:
    """假摘要生成：返回一段固定格式摘要"""

    async def reason(self, text: str, entities) -> ReasonResult:
        await asyncio.sleep(MOCK_AGENT_DELAY)
        names = [self._id2name(e) for e in entities if e in self._id2name_map]
        return ReasonResult(
            summary=f"[Mock 摘要] 关于「{'、'.join(names)}」：这是假摘要占位，"
                    f"真实推理结果待 reason_agent 就绪后替换。",
            related_nodes=entities,
        )

    _id2name_map = {n.id: n.name for n in _MOCK_NODES}

    @classmethod
    def _id2name(cls, entity_id: str) -> str:
        return cls._id2name_map.get(entity_id, entity_id)


# ---------- 装配（与 router.py docstring 中的正式装配方式一致） ----------

service = MockGraphService()
intent_agent = MockIntentAgent()
reason_agent = MockReasonAgent()

app = FastAPI(title="投资学知识图谱 - Mock 联调服务", version="0.1.0")
app.include_router(create_router(service, intent_agent, reason_agent))

# 联调期间放开跨域，方便前端 dev server（如 Vite :5173）直接调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "mock"}
