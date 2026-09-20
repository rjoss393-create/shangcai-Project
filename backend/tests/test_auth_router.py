"""auth 路由测试：注册 / 登录 / 令牌 / 权限 / 用户管理（TestClient 走完整 ASGI 链路）"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.auth import create_auth_router
from service.user_store import UserStore


@pytest.fixture
def client(tmp_path) -> TestClient:
    app = FastAPI()
    app.include_router(create_auth_router(UserStore(str(tmp_path / "users.json"))))
    return TestClient(app)


def register(client, username, password="pass123"):
    return client.post("/api/auth/register", json={"username": username, "password": password})


def login(client, username, password="pass123"):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestRegister:
    def test_first_user_becomes_admin(self, client):
        r = register(client, "alice")
        assert r.status_code == 200
        body = r.json()
        assert body["user"]["role"] == "admin"
        assert body["token"]
        assert "管理员" in body["message"]

    def test_second_user_is_normal_user(self, client):
        register(client, "alice")
        assert register(client, "bob").json()["user"]["role"] == "user"

    def test_duplicate_username_409(self, client):
        register(client, "alice")
        r = register(client, "alice")
        assert r.status_code == 409                    # 前端按 409 处理"账号已存在"
        assert "已被注册" in r.json()["detail"]

    def test_nickname_and_code_envelope(self, client):
        r = client.post("/api/auth/register",
                        json={"username": "alice", "password": "pass123", "nickname": "爱丽丝"})
        body = r.json()
        assert body["code"] == 0                       # 前端按 code === 0 判成功
        assert body["user"]["nickname"] == "爱丽丝"
        assert body["user"]["id"] == "alice"
        assert register(client, "bob").json()["user"]["nickname"] == "bob"   # 昵称缺省=用户名

    def test_chinese_username_register_and_login(self, client):
        body = register(client, "测试", "123456").json()
        assert body["user"]["username"] == "测试"
        assert login(client, "测试", "123456").status_code == 200

    def test_invalid_input_400(self, client):
        assert register(client, "a").status_code == 400            # 用户名过短
        assert register(client, "with space").status_code == 400   # 用户名含空格
        assert register(client, "alice", "12345").status_code == 400   # 密码过短


class TestLogin:
    def test_login_ok(self, client):
        register(client, "alice")
        r = login(client, "alice")
        assert r.status_code == 200
        assert r.json()["user"]["username"] == "alice"
        assert r.json()["token"]

    def test_login_wrong_password_or_unknown_user_401(self, client):
        register(client, "alice")
        assert login(client, "alice", "wrong123").status_code == 401
        assert login(client, "nobody").status_code == 401

    def test_login_disabled_user_401(self, client):
        admin = register(client, "alice").json()
        register(client, "bob")
        client.patch("/api/auth/users/bob", json={"status": "disabled"}, headers=auth(admin["token"]))
        assert login(client, "bob").status_code == 401

    def test_me_requires_valid_token(self, client):
        token = register(client, "alice").json()["token"]
        assert client.get("/api/auth/me").status_code == 401
        assert client.get("/api/auth/me", headers=auth("bad-token")).status_code == 401
        r = client.get("/api/auth/me", headers=auth(token))
        assert r.status_code == 200
        assert r.json()["code"] == 0 and r.json()["user"]["username"] == "alice"
        assert "password_hash" not in r.json()["user"]

    def test_logout_revokes_token(self, client):
        token = register(client, "alice").json()["token"]
        assert client.post("/api/auth/logout", headers=auth(token)).status_code == 200
        assert client.get("/api/auth/me", headers=auth(token)).status_code == 401

    def test_change_password(self, client):
        token = register(client, "alice").json()["token"]
        r = client.post("/api/auth/password", headers=auth(token),
                        json={"old_password": "wrong123", "new_password": "newpass1"})
        assert r.status_code == 400
        r = client.post("/api/auth/password", headers=auth(token),
                        json={"old_password": "pass123", "new_password": "newpass1"})
        assert r.status_code == 200
        assert client.get("/api/auth/me", headers=auth(token)).status_code == 401   # 旧令牌作废
        assert login(client, "alice", "newpass1").status_code == 200
        assert login(client, "alice", "pass123").status_code == 401


class TestUserManagement:
    def _two_users(self, client):
        admin = register(client, "alice").json()
        bob = register(client, "bob").json()
        return admin, bob

    def test_list_users_admin_only(self, client):
        admin, bob = self._two_users(client)
        assert client.get("/api/auth/users", headers=auth(bob["token"])).status_code == 403
        r = client.get("/api/auth/users", headers=auth(admin["token"]))
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 2
        assert [u["username"] for u in body["users"]] == ["alice", "bob"]
        assert all("password_hash" not in u for u in body["users"])

    def test_update_role_and_status(self, client):
        admin, bob = self._two_users(client)
        r = client.patch("/api/auth/users/bob", json={"role": "admin"}, headers=auth(admin["token"]))
        assert r.status_code == 200 and r.json()["role"] == "admin"
        # 停用后该用户已签发令牌立即失效，且不能登录
        r = client.patch("/api/auth/users/bob", json={"status": "disabled"}, headers=auth(admin["token"]))
        assert r.status_code == 200 and r.json()["status"] == "disabled"
        assert client.get("/api/auth/me", headers=auth(bob["token"])).status_code == 401
        assert login(client, "bob").status_code == 401

    def test_update_unknown_user_404_and_bad_role_400(self, client):
        admin = register(client, "alice").json()
        assert client.patch("/api/auth/users/nobody", json={"role": "admin"},
                            headers=auth(admin["token"])).status_code == 404
        register(client, "bob")
        assert client.patch("/api/auth/users/bob", json={"role": "super"},
                            headers=auth(admin["token"])).status_code == 400

    def test_admin_cannot_demote_or_delete_self(self, client):
        admin = register(client, "alice").json()
        assert client.patch("/api/auth/users/alice", json={"role": "user"},
                            headers=auth(admin["token"])).status_code == 400
        assert client.delete("/api/auth/users/alice",
                             headers=auth(admin["token"])).status_code == 400

    def test_reset_password_and_delete_user(self, client):
        admin, bob = self._two_users(client)
        r = client.post("/api/auth/users/bob/password", json={"new_password": "reset123"},
                        headers=auth(admin["token"]))
        assert r.status_code == 200
        assert client.get("/api/auth/me", headers=auth(bob["token"])).status_code == 401
        assert login(client, "bob", "reset123").status_code == 200

        assert client.delete("/api/auth/users/bob",
                             headers=auth(admin["token"])).status_code == 200
        assert login(client, "bob", "reset123").status_code == 401
        assert client.delete("/api/auth/users/bob",
                             headers=auth(admin["token"])).status_code == 404

    def test_management_requires_admin(self, client):
        register(client, "alice")
        bob = register(client, "bob").json()
        assert client.get("/api/auth/users", headers=auth(bob["token"])).status_code == 403
        assert client.post("/api/auth/users/alice/password", json={"new_password": "hacked1"},
                           headers=auth(bob["token"])).status_code == 403
        assert client.delete("/api/auth/users/alice",
                             headers=auth(bob["token"])).status_code == 403
