"""个人状态测试：ProfileStore 存取 + /api/user/profile 路由（登录态 / 默认骨架 / 落盘）"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.auth import TokenManager, create_auth_router
from controller.profile import create_profile_router
from service.profile_store import ProfileStore
from service.user_store import UserStore


@pytest.fixture
def store(tmp_path) -> ProfileStore:
    return ProfileStore(str(tmp_path / "profiles.json"))


@pytest.fixture
def client(tmp_path) -> TestClient:
    """auth 与 profile 两组路由共用同一个 TokenManager（与 main.py 装配一致）"""
    app = FastAPI()
    user_store = UserStore(str(tmp_path / "users.json"))
    profile_store = ProfileStore(str(tmp_path / "profiles.json"))
    tokens = TokenManager()
    app.include_router(create_auth_router(user_store, tokens))
    app.include_router(create_profile_router(user_store, profile_store, tokens))
    return TestClient(app)


def register(client, username, password="pass123") -> str:
    return client.post("/api/auth/register", json={"username": username, "password": password}).json()["token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestProfileStore:
    async def test_default_profile_for_new_user(self, store):
        profile = await store.get("alice")
        assert set(profile) == {"notes", "favorites", "tempRelations", "filters"}
        assert profile["favorites"] == [] and profile["notes"] == {}
        assert profile["filters"]["study"] == {"tags": [], "order": "asc"}

    async def test_save_and_get_roundtrip(self, store):
        saved = {"notes": {"paper::jf-01": {"text": "重点看第 3 节", "updatedAt": 1}},
                 "favorites": [{"type": "paper", "id": "jf-01", "addedAt": 1}],
                 "tempRelations": [], "filters": {"career": {"category": "bank"}}}
        await store.save("alice", saved)
        got = await store.get("alice")
        assert got["notes"]["paper::jf-01"]["text"] == "重点看第 3 节"
        assert got["favorites"][0]["id"] == "jf-01"
        assert got["filters"]["career"] == {"category": "bank"}
        assert got["filters"]["paper"] == {"journal": None, "year": None, "topic": None}   # 其余板块保留默认

    async def test_missing_top_level_keys_filled(self, store):
        """前端只提交了部分键时，其余键补默认骨架（避免前端读 favorites.length 报错）"""
        await store.save("alice", {"favorites": [{"type": "video", "id": "01", "addedAt": 1}]})
        got = await store.get("alice")
        assert got["notes"] == {} and got["tempRelations"] == [] and got["filters"]["study"]["order"] == "asc"

    async def test_users_are_isolated(self, store):
        await store.save("alice", {"favorites": [{"type": "book", "id": "01", "addedAt": 1}]})
        assert (await store.get("bob"))["favorites"] == []

    async def test_reject_non_dict_and_oversized(self, store):
        with pytest.raises(ValueError):
            await store.save("alice", [1, 2, 3])
        with pytest.raises(ValueError):
            await store.save("alice", {"notes": {"n": {"text": "x" * 1_100_000}}})

    async def test_persisted_and_reloadable(self, store, tmp_path):
        await store.save("alice", {"favorites": [{"type": "paper", "id": "rfs-01", "addedAt": 7}]})
        reloaded = ProfileStore(str(tmp_path / "profiles.json"))
        assert (await reloaded.get("alice"))["favorites"][0]["id"] == "rfs-01"


class TestProfileRouter:
    def test_requires_login(self, client):
        assert client.get("/api/user/profile").status_code == 401
        assert client.get("/api/user/profile", headers=auth("bad-token")).status_code == 401
        assert client.put("/api/user/profile", json={"profile": {}},
                          headers=auth("bad-token")).status_code == 401

    def test_get_returns_default_skeleton(self, client):
        token = register(client, "alice")
        body = client.get("/api/user/profile", headers=auth(token)).json()
        assert body["code"] == 0
        assert body["profile"]["favorites"] == [] and body["profile"]["notes"] == {}

    def test_put_then_get(self, client):
        token = register(client, "alice")
        profile = {"notes": {"node::n1": {"text": "并购协同", "updatedAt": 5}},
                   "favorites": [{"type": "video", "id": "03", "addedAt": 5}],
                   "tempRelations": [{"from": "n1", "to": "n2", "note": "对比", "createdAt": 5}],
                   "filters": {"study": {"tags": ["金融"], "order": "desc"}}}
        r = client.put("/api/user/profile", json={"profile": profile}, headers=auth(token))
        assert r.status_code == 200 and r.json()["code"] == 0

        got = client.get("/api/user/profile", headers=auth(token)).json()["profile"]
        assert got["notes"]["node::n1"]["text"] == "并购协同"
        assert got["filters"]["study"] == {"tags": ["金融"], "order": "desc"}

    def test_profile_is_per_user(self, client):
        alice, bob = register(client, "alice"), register(client, "bob")
        client.put("/api/user/profile",
                   json={"profile": {"favorites": [{"type": "book", "id": "07", "addedAt": 1}]}},
                   headers=auth(alice))
        assert client.get("/api/user/profile", headers=auth(bob)).json()["profile"]["favorites"] == []
