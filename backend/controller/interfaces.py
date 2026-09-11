"""控制层对外依赖的接口契约（Protocol）

Service 层（data_service.py）与 Agent 层（qa_agent.py）
由其他同学实现。控制层只依赖这里的抽象接口：
实现方满足协议即可（鸭子类型），无需继承任何基类。

注意：GraphService 契约暂未与 service 层同学最终对齐，请勿改动；
QaAgent 为与 Agent 层新协议（检索 + 回答都由 Agent 完成）。
"""
from typing import Protocol, Sequence

from .schemas import AnswerResult, GraphData


class GraphService(Protocol):
    """数据访问服务（对应 service/data_service.py）"""

    async def get_full_graph(self) -> GraphData:
        """读取完整图谱（页面初始化用）"""
        ...

    async def get_sub_graph(self, node_id: str, depth: int = 1) -> GraphData:
        """获取以 node_id 为中心、depth 跳范围内的子图"""
        ...

    async def search_keywords(self, keywords: Sequence[str], limit: int = 20) -> GraphData:
        """关键词模糊搜索（降级兜底通道）"""
        ...


class QaAgent(Protocol):
    """智能问答 Agent（对应 agent/qa_agent.py，检索 + 回答都在内部完成）"""

    async def preload(self, graph_id: str, graph: GraphData) -> None:
        """预热：页面打开时由控制层调用，加载图谱并建立检索索引。

        - graph_id 标识用户当前停留的哪本书，graph 为控制层从
          Service.get_full_graph() 拿到的归一化全图数据；
        - 实现应可缓存、幂等（同一 graph_id 重复调用应快速返回）；
        - 失败不应抛异常导致页面加载失败（控制层在后台调用并吞掉异常）。
        """
        ...

    async def answer(self, graph_id: str, question: str) -> AnswerResult:
        """基于 graph_id 对应图谱回答自然语言问题（检索 + 生成回答）。"""
        ...
