"""数据访问服务：从 data/ 目录的图谱 JSON 提供数据（GraphService 协议实现）

- 文件名 → graph_id 映射与 controller/graph_ids.py 的编码一致；
- 各书节点 ID 会重复，三个方法均按 graph_id 过滤；
- 数据文件缺失时服务仍可启动，对应调用抛带说明的 ValueError。
"""
import json
import logging
import os
from typing import Sequence

from controller.schemas import GraphData, GraphEdge, GraphNode

logger = logging.getLogger(__name__)

# graph_id -> 数据文件名（与 controller/graph_ids.py 的 GRAPH_IDS 编码一致；
# service 层不 import controller，避免层间依赖，此处维护同一份文件名映射）
# 数据层分层设计（《数据层分层设计.md》）后，指向 data/layered/ 下的分层文件
GRAPH_FILES: dict[str, str] = {
    "ma": "layered/ma_layered.json",
    "corp_fin": "layered/corp_fin_layered.json",
    "intl_inv": "layered/intl_inv_layered.json",
    "invest": "layered/invest_layered.json",
    "econ": "layered/econ_layered.json",
}


class DataService:
    """基于 data/*.json 文件的图谱数据服务（进程内内存加载）"""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self._graphs: dict[str, GraphData] = {}
        for graph_id, filename in GRAPH_FILES.items():
            path = os.path.join(data_dir, filename)
            if not os.path.exists(path):
                logger.warning("[DataService] 数据文件缺失: %s", path)
                continue
            try:
                self._graphs[graph_id] = self._load_file(path, graph_id)
            except Exception:
                logger.exception("[DataService] 图谱文件解析失败: %s", path)

    # ---------- GraphService 协议 ----------

    async def get_full_graph(self, graph_id: str | None = None) -> GraphData:
        graph = self._require(graph_id)
        # 返回副本，避免调用方改动污染缓存（Agent 传图时尤其重要）
        return graph.model_copy(deep=True)

    async def get_sub_graph(
        self, node_id: str, depth: int = 1, graph_id: str | None = None
    ) -> GraphData:
        graph = self._require(graph_id)
        nodes = {n.id: n for n in graph.nodes}
        if node_id not in nodes:
            return GraphData(graph_id=graph.graph_id, title=graph.title)
        seen = {node_id}
        frontier = {node_id}
        for _ in range(depth):
            neighbors = set()
            for e in graph.edges:
                if e.source in frontier and e.target not in seen:
                    neighbors.add(e.target)
                if e.target in frontier and e.source not in seen:
                    neighbors.add(e.source)
            seen |= neighbors
            frontier = neighbors
        sub_edges = [e for e in graph.edges if e.source in seen and e.target in seen]
        return GraphData(
            graph_id=graph.graph_id,
            title=graph.title,
            nodes=[nodes[nid] for nid in seen],
            edges=sub_edges,
        )

    async def search_keywords(
        self, keywords: Sequence[str], limit: int = 20, graph_id: str | None = None
    ) -> GraphData:
        graph = self._require(graph_id)
        matched_ids = set()
        for kw in keywords:
            if not kw:
                continue
            for node in graph.nodes:
                haystack = node.label + node.type + json.dumps(node.extra, ensure_ascii=False)
                if kw in haystack:
                    matched_ids.add(node.id)
        if not matched_ids:
            return GraphData(graph_id=graph.graph_id, title=graph.title)
        matched_edges = [
            e for e in graph.edges if e.source in matched_ids or e.target in matched_ids
        ]
        nodes = [n for n in graph.nodes if n.id in matched_ids][:limit]
        return GraphData(
            graph_id=graph.graph_id, title=graph.title, nodes=nodes, edges=matched_edges
        )

    # ---------- 内部 ----------

    def _require(self, graph_id: str | None) -> GraphData:
        if graph_id is None:
            raise ValueError(
                "graph_id 必填（可选值: " + ", ".join(self._graphs) + "）"
            )
        graph = self._graphs.get(graph_id)
        if graph is None:
            known = ", ".join(self._graphs) or "（data/ 目录为空，数据层文件尚未就绪）"
            raise ValueError(f"未知 graph_id: {graph_id}（当前可用: {known}）")
        return graph

    @staticmethod
    def _load_file(path: str, graph_id: str) -> GraphData:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)

        # 节点必填 id / label；type/page/layer/media/extra 可缺省（《字段.md》+ 分层设计）
        nodes = []
        for n in raw.get("nodes", []):
            nodes.append(
                GraphNode(
                    id=str(n["id"]),
                    label=n.get("label") or n.get("name") or str(n["id"]),
                    type=n.get("type") or n.get("category", ""),
                    page=n.get("page"),
                    layer=n.get("layer", ""),
                    media=n.get("media"),
                    extra={k: v for k, v in n.items()
                           if k not in {"id", "label", "name", "type", "category",
                                        "page", "layer", "media"}},
                )
            )
        edges = [
            GraphEdge(
                source=str(e["source"]),
                target=str(e["target"]),
                relation=e["relation"],
                layer=e.get("layer", ""),
                extra={k: v for k, v in e.items()
                       if k not in {"source", "target", "relation", "layer"}},
            )
            for e in raw.get("edges", [])
        ]
        return GraphData(
            graph_id=graph_id,
            title=raw.get("title", ""),
            nodes=nodes,
            edges=edges,
        )
