"""共享测试替身：假 Service / 假 Agent（行为可配置，供各测试文件复用）

测试图谱：n1(并购协同效应) - n2(杠杆收购) - n3(并购与重组)
    n1 --相关-- n2 --包含-- n3
"""
import asyncio

from controller.schemas import (
    AnswerResult,
    GraphData,
    GraphEdge,
    GraphNode,
    RelatedNode,
)

TEST_NODES = {
    "n1": GraphNode(id="n1", name="并购协同效应", category="概念",
                    media={"text": "协同效应解释"}),
    "n2": GraphNode(id="n2", name="杠杆收购", category="概念",
                    media={"text": "杠杆收购解释"}),
    "n3": GraphNode(id="n3", name="并购与重组", category="课程",
                    media={"text": "课程介绍"}),
}
TEST_EDGES = [
    GraphEdge(source="n1", target="n2", relation="相关"),
    GraphEdge(source="n2", target="n3", relation="包含"),
]


class FakeGraphService:
    """可配置的假数据服务，统计各方法调用情况"""

    def __init__(
        self,
        nodes: dict[str, GraphNode] | None = None,
        edges: list[GraphEdge] | None = None,
        *,
        delay: float = 0.0,
        fail_ids: set[str] | None = None,   # 对这些 id 的 get_sub_graph 抛异常
        fail_full: bool = False,            # get_full_graph 抛异常
        fail_search: bool = False,          # search_keywords 抛异常
    ):
        self.nodes = dict(nodes if nodes is not None else TEST_NODES)
        self.edges = list(edges if edges is not None else TEST_EDGES)
        self.delay = delay
        self.fail_ids = fail_ids or set()
        self.fail_full = fail_full
        self.fail_search = fail_search
        self.get_full_graph_calls = 0
        self.get_sub_graph_calls: list[str] = []
        self.search_keywords_calls = 0

    async def get_full_graph(self) -> GraphData:
        self.get_full_graph_calls += 1
        await asyncio.sleep(self.delay)
        if self.fail_full:
            raise RuntimeError("db down")
        return GraphData(nodes=list(self.nodes.values()), edges=self.edges)

    async def get_sub_graph(self, node_id: str, depth: int = 1) -> GraphData:
        self.get_sub_graph_calls.append(node_id)
        await asyncio.sleep(self.delay)
        if node_id in self.fail_ids:
            raise RuntimeError(f"boom: {node_id}")
        if node_id not in self.nodes:
            return GraphData(nodes=[], edges=[])
        seen = {node_id}
        frontier = {node_id}
        for _ in range(depth):
            neighbors = set()
            for e in self.edges:
                if e.source in frontier and e.target not in seen:
                    neighbors.add(e.target)
                if e.target in frontier and e.source not in seen:
                    neighbors.add(e.source)
            seen |= neighbors
            frontier = neighbors
        sub_edges = [e for e in self.edges if e.source in seen and e.target in seen]
        return GraphData(
            nodes=[self.nodes[nid] for nid in seen], edges=sub_edges,
        )

    async def search_keywords(self, keywords, limit: int = 20) -> GraphData:
        self.search_keywords_calls += 1
        await asyncio.sleep(self.delay)
        if self.fail_search:
            raise RuntimeError("db down")
        matched = set()
        for kw in keywords:
            for node in self.nodes.values():
                haystack = node.name + node.category + str(node.media)
                if kw and kw in haystack:
                    matched.add(node.id)
        matched_edges = [
            e for e in self.edges if e.source in matched or e.target in matched
        ]
        return GraphData(
            nodes=[self.nodes[nid] for nid in matched][:limit],
            edges=matched_edges,
        )


class FakeQaAgent:
    """可配置的假智能问答（preload + answer）"""

    def __init__(
        self,
        related_ids: list[str] | None = None,
        *,
        delay: float = 0.0,
        preload_delay: float = 0.0,
        raise_error: bool = False,
        raise_preload: bool = False,
    ):
        self.related_ids = related_ids if related_ids is not None else ["n1"]
        self.delay = delay
        self.preload_delay = preload_delay
        self.raise_error = raise_error
        self.raise_preload = raise_preload
        self.calls = 0
        self.preload_calls: list[str] = []

    async def preload(self, graph_id: str, graph: GraphData) -> None:
        self.preload_calls.append(graph_id)
        await asyncio.sleep(self.preload_delay)
        if self.raise_preload:
            raise RuntimeError("preload down")

    async def answer(self, graph_id: str, question: str) -> AnswerResult:
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.raise_error:
            raise RuntimeError("llm down")
        nodes = [RelatedNode(id=i, name=i) for i in self.related_ids]
        return AnswerResult(
            prediction_llm="测试答案",
            prediction_html='测试答案<sup><a href="/knowledge/n1" '
                           'data-node-id="n1" class="kg-node-link">1</a></sup>',
            related_nodes=nodes,
            retrieval_count=5,
            used_count=len(nodes),
        )
