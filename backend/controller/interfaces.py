"""控制层对外依赖的接口契约（Protocol）

Service 层（data_service.py）与 Agent 层（intent_agent / reason_agent）
由其他同学实现。控制层只依赖这里的抽象接口：
实现方满足协议即可（鸭子类型），无需继承任何基类。
"""
from typing import Protocol, Sequence

from .schemas import GraphData, IntentResult, ReasonResult


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


class IntentAgent(Protocol):
    """意图识别器（对应 agent/intent_agent.py）"""

    async def parse(self, text: str) -> IntentResult:
        """从自然语言中提取意图与实体节点 ID"""
        ...


class ReasonAgent(Protocol):
    """关系推理/摘要生成器（对应 agent/reason_agent.py）"""

    async def reason(self, text: str, entities: Sequence[str]) -> ReasonResult:
        """基于实体生成摘要与关联节点"""
        ...
