"""会话上下文管理（C2，职责2）

维护用户当前浏览的图谱上下文：
- focused_node_id  当前聚焦节点
- node_history     历史聚焦路径（供"返回上一步"等场景使用）
- visible_node_ids 当前可见节点集合（供动画指令计算淡入/淡出差集）

当前实现为进程内内存存储，asyncio.Lock 保证并发安全；
后续可替换为 Redis 实现，保持相同接口即可。
"""
import asyncio
import time
import uuid
from dataclasses import dataclass, field

SESSION_TTL_SECONDS = 30 * 60   # 会话过期时间：30 分钟
MAX_HISTORY_LENGTH = 50         # 历史聚焦路径最大长度


@dataclass
class SessionContext:
    session_id: str
    focused_node_id: str | None = None
    node_history: list[str] = field(default_factory=list)
    visible_node_ids: set[str] = field(default_factory=set)
    last_query: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "focused_node_id": self.focused_node_id,
            "node_history": list(self.node_history),
            "visible_node_ids": sorted(self.visible_node_ids),
            "last_query": self.last_query,
            "updated_at": self.updated_at,
        }


class SessionContextManager:
    def __init__(self, ttl_seconds: float = SESSION_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._store: dict[str, SessionContext] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str | None) -> SessionContext:
        """获取会话上下文；不存在则创建（session_id 为空时生成新 ID）"""
        async with self._lock:
            self._evict_expired_locked()
            if session_id and session_id in self._store:
                ctx = self._store[session_id]
                ctx.updated_at = time.time()
                return ctx
            ctx = SessionContext(session_id=session_id or uuid.uuid4().hex)
            self._store[ctx.session_id] = ctx
            return ctx

    async def update_after_response(
        self,
        session_id: str,
        *,
        focused_node_id: str | None = None,
        visible_node_ids: set[str] | None = None,
        query: str | None = None,
    ) -> None:
        """每次响应后由编排器调用，更新焦点、可见集与最近查询"""
        async with self._lock:
            ctx = self._store.get(session_id)
            if ctx is None:
                return
            if focused_node_id is not None:
                if ctx.focused_node_id != focused_node_id:
                    ctx.node_history.append(focused_node_id)
                    if len(ctx.node_history) > MAX_HISTORY_LENGTH:
                        ctx.node_history = ctx.node_history[-MAX_HISTORY_LENGTH:]
                ctx.focused_node_id = focused_node_id
            if visible_node_ids is not None:
                ctx.visible_node_ids = set(visible_node_ids)
            if query is not None:
                ctx.last_query = query
            ctx.updated_at = time.time()

    async def get(self, session_id: str) -> SessionContext | None:
        return self._store.get(session_id)

    async def clear(self, session_id: str) -> None:
        async with self._lock:
            self._store.pop(session_id, None)

    async def cleanup_expired(self) -> int:
        """清理过期会话，返回清理数量"""
        async with self._lock:
            before = len(self._store)
            self._evict_expired_locked()
            return before - len(self._store)

    def _evict_expired_locked(self) -> None:
        now = time.time()
        expired = [
            sid for sid, ctx in self._store.items()
            if now - ctx.updated_at > self._ttl
        ]
        for sid in expired:
            self._store.pop(sid, None)
