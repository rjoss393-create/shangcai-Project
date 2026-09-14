"""控制层对外依赖的接口契约（Protocol）

Service 层（service/data_service.py）与 Agent 层（agent/qa_agent.py）
的抽象接口：实现方满足协议即可（鸭子类型），无需继承任何基类。
QaAgent 为与 Agent 层协议（检索 + 回答都由 Agent 完成）。
"""
from typing import Protocol, Sequence

from .schemas import AnswerResult, GraphData


class GraphService(Protocol):
    """数据访问服务（对应 service/data_service.py）

    2026-09-13 起支持多图谱：三个方法均带可选 graph_id，
    用于在多本书之间定位数据（各书节点 ID 会重复，必须按书过滤）。
    """

    async def get_full_graph(self, graph_id: str | None = None) -> GraphData:
        """读取完整图谱（页面初始化用）；graph_id 指定哪本书，None 由实现决定"""
        ...

    async def get_sub_graph(
        self, node_id: str, depth: int = 1, graph_id: str | None = None
    ) -> GraphData:
        """获取以 node_id 为中心、depth 跳范围内的子图"""
        ...

    async def search_keywords(
        self, keywords: Sequence[str], limit: int = 20, graph_id: str | None = None
    ) -> GraphData:
        """关键词模糊搜索（降级兜底通道）"""
        ...

    async def get_layer(self, graph_id: str, layer: str) -> GraphData:
        """按分层取子集（《数据层分层设计.md》）：返回该层节点 + 该层派生边。
        供书籍详情小图等轻量场景使用。"""
        ...


class QaAgent(Protocol):
    """智能问答 Agent（对应 agent/qa_agent.py，检索 + 回答都在内部完成）

    传给 Agent 的 GraphData 字段格式见根目录《字段.md》（Agent 层给定的必要
    字段文档）：图级必填 graph_id / nodes / edges；节点必填 id / label；
    边必填 source / target / relation。
    """

    async def preload(self, graph_id: str, graph: GraphData) -> None:
        """预热：页面打开时由控制层调用，加载图谱并建立检索索引。

        - graph_id 标识用户当前停留的哪本书，graph 为控制层从
          Service.get_full_graph() 拿到的归一化全图数据
          （graph_id / title 已由控制层填充）；
        - 实现应可缓存、幂等（同一 graph_id 重复调用应快速返回）；
        - 失败不应抛异常导致页面加载失败（控制层在后台调用并吞掉异常）。
        """
        ...

    async def answer(self, graph_data: GraphData, question: str) -> AnswerResult:
        """基于 graph_data 对应图谱回答自然语言问题（检索 + 生成回答）。

        - graph_data 内含 graph_id 标识哪本书（《字段.md》格式），
          控制层每次调用都会传当次取到的全图数据；
        - 返回的 AnswerResult.related_nodes[].id 必须与 prediction_html 中
          data-node-id 完全一致，且是 graph_data.nodes 里的真实节点 ID。
        """
        ...
