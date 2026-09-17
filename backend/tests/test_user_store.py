"""user_store 测试：账号存储 / 密码哈希 / 权限与启停 / JSON 落盘"""
import pytest

from service.user_store import UserStore, hash_password, verify_password


@pytest.fixture
def store(tmp_path) -> UserStore:
    return UserStore(str(tmp_path / "users.json"))


class TestPasswordHash:
    def test_salted_hash(self):
        h1 = hash_password("secret123")
        h2 = hash_password("secret123")
        assert h1 != h2                          # 同一密码两次哈希不同（盐随机）
        assert "secret123" not in h1
        assert verify_password("secret123", h1) and verify_password("secret123", h2)

    def test_verify_rejects_wrong_and_malformed(self):
        h = hash_password("secret123")
        assert not verify_password("secret124", h)
        assert not verify_password("secret123", "not-a-hash")
        assert not verify_password("secret123", "md5$1$aa$bb")   # 非本算法一律不通过


class TestUserStore:
    async def test_first_user_becomes_admin(self, store):
        alice = await store.create("alice", "pass123")
        bob = await store.create("bob", "pass123")
        assert alice["role"] == "admin"          # 首个用户自动成为管理员
        assert bob["role"] == "user"
        assert alice["status"] == "active"
        assert set(alice) == {"username", "role", "status", "created_at"}   # 不含密码字段

    async def test_duplicate_username(self, store):
        await store.create("alice", "pass123")
        with pytest.raises(ValueError):
            await store.create("alice", "pass456")

    async def test_chinese_username_allowed(self, store):
        user = await store.create("测试", "123456")
        assert (await store.verify("测试", "123456"))["username"] == "测试"
        assert user["role"] == "admin"

    async def test_invalid_username_and_password(self, store):
        for name in ("a", "a" * 21, "with space", "名字!", "a@b"):
            with pytest.raises(ValueError):
                await store.create(name, "pass123")
        for password in ("12345", "x" * 65, "with space"):
            with pytest.raises(ValueError):
                await store.create("alice", password)

    async def test_verify(self, store):
        await store.create("alice", "pass123")
        assert (await store.verify("alice", "pass123"))["username"] == "alice"
        assert await store.verify("alice", "wrong") is None
        assert await store.verify("nobody", "pass123") is None

    async def test_verify_disabled_user(self, store):
        await store.create("alice", "pass123")
        await store.update("alice", status="disabled")
        assert await store.verify("alice", "pass123") is None

    async def test_plaintext_password_not_on_disk(self, store, tmp_path):
        await store.create("alice", "pass123")
        raw = (tmp_path / "users.json").read_text(encoding="utf-8")
        assert "pass123" not in raw
        assert "password_hash" in raw and "pbkdf2_sha256$" in raw

    async def test_persisted_and_reloadable(self, store, tmp_path):
        await store.create("alice", "pass123")
        reloaded = UserStore(str(tmp_path / "users.json"))
        user = await reloaded.verify("alice", "pass123")
        assert user is not None and user["role"] == "admin"

    async def test_set_password_invalidates_old(self, store):
        await store.create("alice", "pass123")
        await store.set_password("alice", "newpass1")
        assert await store.verify("alice", "pass123") is None
        assert await store.verify("alice", "newpass1") is not None

    async def test_update_and_delete(self, store):
        await store.create("alice", "pass123")
        await store.create("bob", "pass123")
        assert (await store.update("bob", role="admin"))["role"] == "admin"
        with pytest.raises(ValueError):
            await store.update("bob", role="super")
        with pytest.raises(ValueError):
            await store.update("nobody", role="admin")
        assert await store.delete("bob") is True
        assert await store.delete("bob") is False
        assert [u["username"] for u in await store.list_users()] == ["alice"]
