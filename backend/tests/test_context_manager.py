"""context_manager 测试：会话创建/复用/历史路径/TTL 过期"""
import time

from controller.context_manager import MAX_HISTORY_LENGTH, SessionContextManager


class TestSessionContextManager:
    async def test_get_or_create_generates_id(self):
        m = SessionContextManager()
        ctx = await m.get_or_create(None)
        assert ctx.session_id

    async def test_reuse_same_session(self):
        m = SessionContextManager()
        ctx1 = await m.get_or_create("abc")
        ctx2 = await m.get_or_create("abc")
        assert ctx1 is ctx2

    async def test_focus_change_appends_history(self):
        m = SessionContextManager()
        await m.get_or_create("s1")
        await m.update_after_response("s1", focused_node_id="n1")
        await m.update_after_response("s1", focused_node_id="n2")
        await m.update_after_response("s1", focused_node_id="n2")  # 重复焦点不记录
        ctx = await m.get("s1")
        assert ctx.focused_node_id == "n2"
        assert ctx.node_history == ["n1", "n2"]

    async def test_history_capped(self):
        m = SessionContextManager()
        await m.get_or_create("s1")
        for i in range(MAX_HISTORY_LENGTH + 10):
            await m.update_after_response("s1", focused_node_id=f"n{i}")
        ctx = await m.get("s1")
        assert len(ctx.node_history) == MAX_HISTORY_LENGTH
        assert ctx.node_history[-1] == f"n{MAX_HISTORY_LENGTH + 10 - 1}"

    async def test_expired_session_evicted_lazily(self):
        m = SessionContextManager(ttl_seconds=0.05)
        await m.get_or_create("old")
        time.sleep(0.1)
        await m.get_or_create("new")  # 触发惰性清理
        assert await m.get("old") is None
        assert await m.get("new") is not None

    async def test_cleanup_expired_returns_count(self):
        m = SessionContextManager(ttl_seconds=0.05)
        await m.get_or_create("a")
        await m.get_or_create("b")
        time.sleep(0.1)
        assert await m.cleanup_expired() == 2

    async def test_clear(self):
        m = SessionContextManager()
        await m.get_or_create("s1")
        await m.clear("s1")
        assert await m.get("s1") is None

    async def test_update_missing_session_is_noop(self):
        m = SessionContextManager()
        await m.update_after_response("ghost", focused_node_id="n1")  # 不应抛异常
