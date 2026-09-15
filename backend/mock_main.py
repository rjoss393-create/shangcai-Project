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

from controller.interfaces import GraphService, QaAgent
from controller.router import create_router
from controller.schemas import AnswerResult, GraphData, GraphEdge, GraphNode, RelatedNode

# 模拟 Agent 延迟（秒）：让前端能观察到"慢通道"的加载效果；调 0 可关闭
MOCK_AGENT_DELAY = 0.5

# ---------- 假图谱数据（字段与 graph.json / schemas.GraphNode 约定一致） ----------

_MOCK_NODES: list[GraphNode] = [
    GraphNode(id="n1", label="并购协同效应", type="concept", page=1,
              media={"text": "并购后企业整体价值大于各部分之和的现象，包括经营协同与财务协同。"}),
    GraphNode(id="n2", label="杠杆收购", type="concept", page=2,
              media={"text": "以目标企业资产和未来现金流为担保、大量举债进行的收购方式。"}),
    GraphNode(id="n3", label="并购与重组", type="chapter", page=3,
              media={"text": "课程《并购与重组》：涵盖并购动因、协同效应、估值与反收购策略。"}),
    GraphNode(id="n4", label="资本结构", type="concept", page=4,
              media={"text": "企业长期资本的构成及比例关系，核心理论包括 MM 定理与权衡理论。"}),
    GraphNode(id="n5", label="公司金融", type="chapter", page=5,
              media={"text": "课程《公司金融》：涵盖资本结构、股利政策、公司估值等。"}),
    GraphNode(id="n6", label="汇率风险", type="concept", page=6,
              media={"text": "汇率波动导致国际投资资产价值变动的风险。"}),
    GraphNode(id="n7", label="国际投资", type="chapter", page=7,
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

    async def get_full_graph(self, graph_id: str | None = None) -> GraphData:
        return GraphData(nodes=list(self._nodes.values()), edges=self._edges)

    async def get_sub_graph(
        self, node_id: str, depth: int = 1, graph_id: str | None = None
    ) -> GraphData:
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

    async def search_keywords(
        self, keywords, limit: int = 20, graph_id: str | None = None
    ) -> GraphData:
        matched_ids = set()
        for kw in keywords:
            for node in self._nodes.values():
                haystack = node.label + node.type + str(node.media)
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


class MockQaAgent:
    """假智能问答：匹配文本中出现过的节点名，按 Agent 层 AnswerResult 格式输出。

    输出格式与《文档/协议/llm返回输出示例.md》一致：
    prediction_html 带 <sup><a class="kg-node-link" data-node-id=...> 上标。
    """

    def __init__(self):
        self.preloaded: list[str] = []

    async def preload(self, graph_id: str, graph: GraphData) -> None:
        await asyncio.sleep(MOCK_AGENT_DELAY / 2)  # 模拟建索引耗时
        if graph_id not in self.preloaded:
            self.preloaded.append(graph_id)

    async def answer(self, graph_data: GraphData, question: str) -> AnswerResult:
        await asyncio.sleep(MOCK_AGENT_DELAY)
        pool = graph_data.nodes or _MOCK_NODES
        matched = [n for n in pool if n.label in question]
        if not matched:
            matched = [pool[0]]  # 默认命中第一个节点，保证场景2有图可看
        nodes = [self._to_related(n, i) for i, n in enumerate(matched, start=1)]
        plain = "，".join(f"{n.label}：{(n.media or {}).get('text', '')}" for n in matched)
        html = "根据知识图谱，" + "，".join(self._sup(n, i) for i, n in enumerate(matched, start=1)) + "。"
        return AnswerResult(
            prediction_llm=plain,
            prediction_html=html,
            related_nodes=nodes,
            retrieval_count=len(matched),
            used_count=len(matched),
        )

    @staticmethod
    def _to_related(node: GraphNode, index: int) -> RelatedNode:
        return RelatedNode(id=node.id, name=node.label, type=node.type, page=node.page)

    @staticmethod
    def _sup(node: GraphNode, index: int) -> str:
        return (
            f"{node.label}"
            f'<sup><a href="/knowledge/{node.id}" data-node-id="{node.id}" '
            f'data-node-name="{node.label}" class="kg-node-link">{index}</a></sup>'
        )


# ---------- 装配（与 router.py docstring 中的正式装配方式一致） ----------

service = MockGraphService()
qa_agent = MockQaAgent()

app = FastAPI(title="投资学知识图谱 - Mock 联调服务", version="0.1.0")
app.include_router(create_router(service, qa_agent))

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
