"""API 路由注册（对接 FastAPI）

通过 create_router(...) 工厂注入 Service/Agent 依赖，
在 main.py（应用入口，由其他同学实现）中这样装配：

    from fastapi import FastAPI
    from controller.router import create_router

    app = FastAPI()
    app.include_router(create_router(service, qa_agent))
"""
import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .orchestrator import Orchestrator
from .schemas import GraphData, UnifiedResponse

logger = logging.getLogger(__name__)

# 书架书号 -> graph_id（与前端 BOOKS 数组第 1~4 本对应；
# 书号 5（金融理论视频课程）及 6~35 暂未建图谱，返回空图由前端显示"待接入"占位）
BOOK_GRAPH_MAP: dict[int, str] = {
    1: "invest",
    2: "corp_fin",
    3: "intl_inv",
    4: "ma",
}

# 各图谱里「章」所在的层 —— 书籍详情小图只画章层节点。
#   旧分层图谱（layered/*_layered.json）：章在 macro 层（meso 是「节」）；
#   新版课程知识图谱（course_graph_*.json，2026-09-24 起 invest/corp_fin/ma 在用）：
#   macro 只有 1 个课程根，**章在 meso 层**。取错层会退化成只有一个节点的图。
CHAPTER_LAYER: dict[str, str] = {
    "invest": "meso",
    "corp_fin": "meso",
    "ma": "meso",
    "intl_inv": "macro",
}


class LoadRequest(BaseModel):
    session_id: str | None = None
    graph_id: str | None = None    # 图谱标识：告知 Agent 预热哪本书（可空则跳过预热）


class ClickRequest(BaseModel):
    node_id: str = Field(min_length=1)
    session_id: str | None = None
    graph_id: str | None = None    # 预留：service 层支持多图谱后用于按书过滤节点


class QueryRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    session_id: str | None = None
    graph_id: str | None = None    # 智能问答必填：Agent 按此选择对应书的图谱


def create_router(service, qa_agent=None, **orchestrator_kwargs) -> APIRouter:
    """路由工厂：注入依赖并注册全部图谱 API"""
    orchestrator = Orchestrator(service, qa_agent, **orchestrator_kwargs)
    router = APIRouter(prefix="/api/graph", tags=["graph"])

    @router.post("/load", response_model=UnifiedResponse)
    async def load_graph(req: LoadRequest):
        """页面初始化：加载全图，返回全量数据 + 淡入/缩放指令（后台预热 Agent）"""
        return await orchestrator.handle_load_graph(req.session_id, req.graph_id)

    @router.post("/click", response_model=UnifiedResponse)
    async def click_node(req: ClickRequest):
        """场景1：点击节点，返回局部子图 + 聚焦/淡入淡出指令"""
        return await orchestrator.handle_node_click(req.node_id, req.session_id, req.graph_id)

    @router.post("/query", response_model=UnifiedResponse)
    async def query(req: QueryRequest):
        """场景2/3：文本查询（自然语言走 Agent 慢通道，关键词走快通道，超时自动降级）"""
        return await orchestrator.handle_query(req.text, req.session_id, req.graph_id)

    @router.get("/book/{book_id}", response_model=UnifiedResponse)
    async def book_graph(book_id: int):
        """书籍详情小图：返回该书的宏观章层节点 + 章间相关边。
        未建图谱的书号返回空图（code 仍为 0，前端据此显示占位而非示例图）。"""
        graph_id = BOOK_GRAPH_MAP.get(book_id)
        if graph_id is None:
            return UnifiedResponse(message="该书籍暂无图谱", data=GraphData())
        try:
            graph = await service.get_layer(graph_id, CHAPTER_LAYER.get(graph_id, "macro"))
        except Exception:
            logger.exception("书详情小图获取失败: book_id=%s", book_id)
            return UnifiedResponse(message="图谱数据暂不可用", data=GraphData())
        return UnifiedResponse(data=graph)

    @router.get("/session/{session_id}")
    async def session_info(session_id: str):
        """调试用：查看会话上下文状态"""
        ctx = await orchestrator.context.get(session_id)
        if ctx is None:
            return {"session_id": session_id, "exists": False}
        return {"exists": True, **ctx.to_dict()}

    return router
