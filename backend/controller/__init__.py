"""控制层（Controller Layer）—— 流程编排

职责（controller.txt）：
1. 意图解析与智能路由（C4）        -> dispatcher.DispatchDecision
2. 流程编排与上下文管理（C2）      -> orchestrator.Orchestrator + context_manager
3. 动画指令生成（C3）              -> assembler.AnimationAssembler
4. 统一响应封装 {data, actions}    -> schemas.UnifiedResponse
5. 容错与降级（超时/熔断/兜底）    -> dispatcher.Dispatcher

模块划分：
    router.py           API 路由注册（对接 FastAPI）
    orchestrator.py     核心编排器：调度 Service/Agent，整合结果
    dispatcher.py       调度决策器：C4 智能路由 + 超时/熔断/降级
    context_manager.py  会话状态管理（内存存储，可替换 Redis）
    assembler.py        动画指令组装器：C3
    schemas.py          统一数据模型（响应/动作/图谱结构）
    interfaces.py       Service/Agent 层的接口契约（Protocol）
    auth.py             登录鉴权 + 用户管理 API（/api/auth，令牌内存存储）
"""
from .assembler import AnimationAssembler
from .auth import TokenManager, create_auth_router
from .context_manager import SessionContextManager
from .dispatcher import Dispatcher, RouteKind, extract_keywords
from .interfaces import GraphService, QaAgent
from .orchestrator import Orchestrator
from .router import create_router
from .schemas import (
    ActionType,
    AnimationAction,
    AnswerResult,
    GraphData,
    GraphEdge,
    GraphNode,
    RelatedNode,
    UnifiedResponse,
)

__all__ = [
    "ActionType",
    "AnimationAction",
    "AnimationAssembler",
    "AnswerResult",
    "Dispatcher",
    "GraphData",
    "GraphEdge",
    "GraphNode",
    "GraphService",
    "Orchestrator",
    "QaAgent",
    "RelatedNode",
    "RouteKind",
    "SessionContextManager",
    "TokenManager",
    "UnifiedResponse",
    "create_auth_router",
    "create_router",
    "extract_keywords",
]
