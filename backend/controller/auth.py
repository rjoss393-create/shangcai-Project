"""登录鉴权与用户管理 API（/api/auth）

- TokenManager：登录令牌，内存存储（token -> 用户名 + 过期时间，TTL 24h）。
  与 context_manager 一样属"进程内实现"，重启后需重新登录，接口预留 Redis 替换空间；
- create_auth_router(user_store)：注册 注册/登录/登出/我的信息/改密
  + 管理员用户管理接口（列表/改角色/启停/重置密码/删除）；
- 权限：role=admin 的用户才能调用用户管理接口（require_admin 依赖）；
- 口令只由 service/user_store.py 存哈希，响应中绝不出现 password_hash；
- 错误统一用 FastAPI HTTPException：400 参数/业务错误、401 未登录、403 无权限。

装配（main.py）：

    from controller.auth import create_auth_router
    from service.user_store import UserStore

    user_store = UserStore(os.path.join(ROOT, "data", "users.json"))
    app.include_router(create_auth_router(user_store))
"""
import logging
import secrets
import time

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from service.user_store import UserExistsError

logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 24 * 60 * 60    # 登录有效期：24 小时


# ---------- 对外数据模型（不含密码相关字段） ----------

class AuthUser(BaseModel):
    """用户信息（对外）"""
    id: str = ""                    # 与 username 相同（前端个人状态以它为缓存键）
    username: str
    nickname: str = ""              # 展示名，注册时可空（默认与用户名相同）
    role: str                       # admin 管理员 / user 普通用户
    status: str                     # active 正常 / disabled 已停用
    created_at: str = ""


class LoginResult(BaseModel):
    """注册/登录成功的返回：令牌 + 用户信息

    code 字段是给前端的统一信封（0 成功，非 0 与 HTTP 状态码一致），
    与 HTTP 状态码并存：REST 调用方看状态码，页面看 code/message。
    """
    code: int = 0
    token: str
    user: AuthUser
    message: str = "success"


class MeResult(BaseModel):
    """当前登录用户（前端刷新页面后校验令牌用）"""
    code: int = 0
    user: AuthUser


class UserListResult(BaseModel):
    total: int
    users: list[AuthUser] = Field(default_factory=list)


class MessageResult(BaseModel):
    code: int = 0
    message: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    nickname: str | None = None


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class UpdateUserRequest(BaseModel):
    """管理员改用户：两个字段都可空，只传要改的那个"""
    role: str | None = None
    status: str | None = None


class ResetPasswordRequest(BaseModel):
    new_password: str


# ---------- 令牌管理 ----------

class TokenManager:
    """登录令牌（内存存储）：签发 / 校验 / 撤销。token 本身是随机串，不含用户信息"""

    def __init__(self, ttl_seconds: float = TOKEN_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._tokens: dict[str, tuple[str, float]] = {}   # token -> (username, 过期时间戳)

    def issue(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        self._tokens[token] = (username, time.time() + self._ttl)
        return token

    def resolve(self, token: str) -> str | None:
        """token -> 用户名；过期或不存在返回 None（顺带清理过期项）"""
        item = self._tokens.get(token)
        if item is None:
            return None
        username, expires_at = item
        if time.time() > expires_at:
            self._tokens.pop(token, None)
            return None
        return username

    def revoke(self, token: str) -> None:
        self._tokens.pop(token, None)

    def revoke_user(self, username: str) -> int:
        """撤销某用户的全部令牌（改密 / 被停用 / 被删除时调用），返回撤销数量"""
        stale = [t for t, (name, _) in self._tokens.items() if name == username]
        for token in stale:
            self._tokens.pop(token, None)
        return len(stale)


def _bearer_token(authorization: str | None) -> str:
    """从 Authorization: Bearer <token> 头中取出 token"""
    if not authorization:
        raise HTTPException(status_code=401, detail="未登录：缺少 Authorization 请求头")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Authorization 头格式应为 Bearer <token>")
    return token.strip()


def make_current_user(user_store, tokens: TokenManager):
    """构造"当前登录用户"依赖：/api/auth 与 /api/user 两组路由共用同一套令牌校验

    未登录 / 已过期 / 已停用一律 401。
    """
    async def current_user(authorization: str | None = Header(default=None)) -> dict:
        username = tokens.resolve(_bearer_token(authorization))
        if username is None:
            raise HTTPException(status_code=401, detail="登录已失效，请重新登录")
        user = await user_store.get(username)
        if user is None or user["status"] != "active":
            raise HTTPException(status_code=401, detail="账号不存在或已被停用")
        return user

    return current_user


def create_auth_router(user_store, token_manager: TokenManager | None = None) -> APIRouter:
    """路由工厂：注入用户存储（service/user_store.UserStore）与令牌管理器"""
    tokens = token_manager or TokenManager()
    router = APIRouter(prefix="/api/auth", tags=["auth"])
    current_user = make_current_user(user_store, tokens)

    async def require_admin(user: dict = Depends(current_user)) -> dict:
        """依赖：在 current_user 基础上要求管理员身份"""
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="需要管理员权限")
        return user

    # ---------- 注册 / 登录 ----------

    @router.post("/register", response_model=LoginResult)
    async def register(req: RegisterRequest):
        """注册并直接登录。系统第一个注册的用户自动成为管理员（便于初始化）"""
        try:
            user = await user_store.create(req.username, req.password, nickname=req.nickname)
        except UserExistsError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        token = tokens.issue(user["username"])
        message = "注册成功（首位用户已自动成为管理员）" if user["role"] == "admin" else "注册成功"
        return LoginResult(token=token, user=AuthUser(**user), message=message)

    @router.post("/login", response_model=LoginResult)
    async def login(req: LoginRequest):
        """账号密码登录，返回令牌（后续请求带 Authorization: Bearer <token>）"""
        user = await user_store.verify(req.username, req.password)
        if user is None:
            # 不区分"用户不存在"与"密码错误"，避免暴露账号是否注册
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        token = tokens.issue(user["username"])
        return LoginResult(token=token, user=AuthUser(**user))

    @router.post("/logout", response_model=MessageResult)
    async def logout(user: dict = Depends(current_user),
                     authorization: str | None = Header(default=None)):
        """退出登录：撤销当前令牌"""
        tokens.revoke(_bearer_token(authorization))
        return MessageResult(message="已退出登录")

    @router.get("/me", response_model=MeResult)
    async def me(user: dict = Depends(current_user)):
        """当前登录用户信息（前端刷新页面后可用它校验令牌是否仍有效）"""
        return MeResult(user=AuthUser(**user))

    @router.post("/password", response_model=MessageResult)
    async def change_password(req: ChangePasswordRequest, user: dict = Depends(current_user)):
        """修改自己的密码；改完撤销该用户全部令牌，需用新密码重新登录"""
        if await user_store.verify(user["username"], req.old_password) is None:
            raise HTTPException(status_code=400, detail="原密码错误")
        try:
            await user_store.set_password(user["username"], req.new_password)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        tokens.revoke_user(user["username"])
        return MessageResult(message="密码已修改，请使用新密码重新登录")

    # ---------- 用户管理（仅管理员） ----------

    @router.get("/users", response_model=UserListResult)
    async def list_users(_: dict = Depends(require_admin)):
        """用户列表（不含密码哈希）"""
        users = await user_store.list_users()
        return UserListResult(total=len(users), users=[AuthUser(**u) for u in users])

    @router.patch("/users/{username}", response_model=AuthUser)
    async def update_user(username: str, req: UpdateUserRequest,
                          admin: dict = Depends(require_admin)):
        """改角色 / 启停用户；被停用者已签发的令牌立即失效"""
        target = await user_store.get(username)
        if target is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        # 不允许对自己降级/停用：操作者必定是启用中的管理员，只要自己不动手，
        # 系统就至少保留一名可用管理员（不会把自己锁在门外）
        if username == admin["username"] and (req.role == "user" or req.status == "disabled"):
            raise HTTPException(status_code=400, detail="不能降级或停用自己的账号，请让其他管理员操作")
        try:
            user = await user_store.update(username, role=req.role, status=req.status)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if user["status"] != "active":
            tokens.revoke_user(username)
        return AuthUser(**user)

    @router.post("/users/{username}/password", response_model=MessageResult)
    async def reset_password(username: str, req: ResetPasswordRequest,
                             _: dict = Depends(require_admin)):
        """管理员重置某用户密码（用户需用新密码重新登录）"""
        try:
            await user_store.set_password(username, req.new_password)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        tokens.revoke_user(username)
        return MessageResult(message=f"已重置 {username} 的密码")

    @router.delete("/users/{username}", response_model=MessageResult)
    async def delete_user(username: str, admin: dict = Depends(require_admin)):
        """删除用户（不可删除自己，保证系统至少留一名管理员）"""
        if username == admin["username"]:
            raise HTTPException(status_code=400, detail="不能删除自己的账号")
        target = await user_store.get(username)
        if target is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        await user_store.delete(username)
        tokens.revoke_user(username)
        return MessageResult(message=f"已删除用户 {username}")

    return router
