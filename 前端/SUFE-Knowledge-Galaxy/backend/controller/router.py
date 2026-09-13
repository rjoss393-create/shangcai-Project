"""API 路由注册（对接 FastAPI）

通过 create_router(...) 工厂注入 Service/Agent 依赖，
在 main.py（应用入口，由其他同学实现）中这样装配：

    from fastapi import FastAPI
    from controller.router import create_router

    app = FastAPI()
    app.include_router(create_router(service, intent_agent, reason_agent))
"""
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .orchestrator import Orchestrator
from .schemas import UnifiedResponse


class LoadRequest(BaseModel):
    session_id: str | None = None


class ClickRequest(BaseModel):
    node_id: str = Field(min_length=1)
    session_id: str | None = None


class QueryRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    session_id: str | None = None


def create_router(service, intent_agent=None, reason_agent=None, **orchestrator_kwargs) -> APIRouter:
    """路由工厂：注入依赖并注册全部图谱 API"""
    orchestrator = Orchestrator(service, intent_agent, reason_agent, **orchestrator_kwargs)
    router = APIRouter(prefix="/api/graph", tags=["graph"])

    @router.post("/load", response_model=UnifiedResponse)
    async def load_graph(req: LoadRequest):
        """页面初始化：加载全图，返回全量数据 + 淡入/缩放指令"""
        return await orchestrator.handle_load_graph(req.session_id)

    @router.post("/click", response_model=UnifiedResponse)
    async def click_node(req: ClickRequest):
        """场景1：点击节点，返回局部子图 + 聚焦/淡入淡出指令"""
        return await orchestrator.handle_node_click(req.node_id, req.session_id)

    @router.post("/query", response_model=UnifiedResponse)
    async def query(req: QueryRequest):
        """场景2/3：文本查询（自然语言走 Agent 慢通道，关键词走快通道，超时自动降级）"""
        return await orchestrator.handle_query(req.text, req.session_id)

    @router.get("/session/{session_id}")
    async def session_info(session_id: str):
        """调试用：查看会话上下文状态"""
        ctx = await orchestrator.context.get(session_id)
        if ctx is None:
            return {"session_id": session_id, "exists": False}
        return {"exists": True, **ctx.to_dict()}

    return router
