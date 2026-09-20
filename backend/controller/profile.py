"""个人状态 API（/api/user/profile）

前端 js/auth.js 约定的前后端边界：登录用户的笔记 / 收藏 / 临时关系 / 筛选条件
整体存取（结构由前端定义，后端不解析内部字段，见 service/profile_store.py）。

- GET  /api/user/profile  -> {code:0, profile:{...}}
- PUT  /api/user/profile  <- {profile:{...}}  -> {code:0, message}
- 两个接口都需要登录态（Authorization: Bearer <token>，令牌校验与 /api/auth 共用）。

装配（main.py，与 auth 路由共用同一个 TokenManager）：

    tokens = TokenManager()
    app.include_router(create_auth_router(user_store, tokens))
    app.include_router(create_profile_router(user_store, profile_store, tokens))
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import MessageResult, TokenManager, make_current_user

logger = logging.getLogger(__name__)


class ProfileResult(BaseModel):
    """个人状态读取结果"""
    code: int = 0
    profile: dict


class ProfileUpdateRequest(BaseModel):
    """个人状态整体提交（前端每次改动后全量提交）"""
    profile: dict


def create_profile_router(user_store, profile_store, token_manager: TokenManager | None = None) -> APIRouter:
    """路由工厂：注入用户存储、个人状态存储与令牌管理器"""
    tokens = token_manager or TokenManager()
    router = APIRouter(prefix="/api/user", tags=["user"])
    current_user = make_current_user(user_store, tokens)

    @router.get("/profile", response_model=ProfileResult)
    async def get_profile(user: dict = Depends(current_user)):
        """当前登录用户的个人状态（从未保存过时返回默认骨架）"""
        return ProfileResult(profile=await profile_store.get(user["username"]))

    @router.put("/profile", response_model=MessageResult)
    async def save_profile(req: ProfileUpdateRequest, user: dict = Depends(current_user)):
        """整体保存个人状态"""
        try:
            await profile_store.save(user["username"], req.profile)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return MessageResult(message="已保存")

    return router
