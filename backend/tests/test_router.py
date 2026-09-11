"""router 测试：HTTP 接口层（TestClient 走完整 ASGI 链路）"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.router import create_router
from fakes import FakeGraphService, FakeQaAgent


def make_client():
    app = FastAPI()
    app.include_router(create_router(
        FakeGraphService(), FakeQaAgent(),
    ))
    return TestClient(app)


class TestRouter:
    def test_load(self):
        client = make_client()
        r = client.post("/api/graph/load", json={"graph_id": "gsjr"})
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == 0
        assert body["session_id"]
        assert {n["id"] for n in body["data"]["nodes"]} == {"n1", "n2", "n3"}
        assert [a["type"] for a in body["actions"]] == ["fade_in", "zoom"]
        assert body["answer"] is None

    def test_load_without_graph_id_ok(self):
        client = make_client()
        r = client.post("/api/graph/load", json={})
        assert r.status_code == 200
        assert r.json()["code"] == 0

    def test_click(self):
        client = make_client()
        r = client.post("/api/graph/click", json={"node_id": "n1"})
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == 0
        assert body["actions"][0]["type"] == "focus"
        assert body["actions"][0]["targets"] == ["n1"]

    def test_query_keyword_fast_channel(self):
        client = make_client()
        r = client.post("/api/graph/query", json={"text": "杠杆收购"})
        body = r.json()
        assert body["code"] == 0
        assert [a["type"] for a in body["actions"]] == ["highlight", "zoom"]

    def test_query_nl_with_session_flow(self):
        client = make_client()
        sid = client.post("/api/graph/load",
                          json={"graph_id": "gsjr"}).json()["session_id"]
        r = client.post("/api/graph/query",
                        json={"text": "解释一下并购协同效应",
                              "session_id": sid, "graph_id": "gsjr"})
        body = r.json()
        assert body["session_id"] == sid
        assert body["degraded"] is False
        assert body["answer"] is not None
        assert body["answer"]["prediction_html"]
        assert [n["id"] for n in body["answer"]["related_nodes"]] == ["n1"]
        assert [a["type"] for a in body["actions"]] == ["focus", "highlight", "zoom"]

    def test_query_nl_without_graph_id_degraded(self):
        client = make_client()
        r = client.post("/api/graph/query",
                        json={"text": "解释一下并购协同效应"})
        body = r.json()
        assert body["code"] == 0
        assert body["degraded"] is True
        assert body["answer"] is None

    def test_invalid_request_422(self):
        client = make_client()
        assert client.post("/api/graph/query", json={"text": ""}).status_code == 422
        assert client.post("/api/graph/click", json={}).status_code == 422

    def test_session_info(self):
        client = make_client()
        sid = client.post("/api/graph/load", json={}).json()["session_id"]
        info = client.get(f"/api/graph/session/{sid}").json()
        assert info["exists"] is True
        assert info["visible_node_ids"] == ["n1", "n2", "n3"]
        assert info["focused_node_id"] is None

    def test_session_missing(self):
        client = make_client()
        info = client.get("/api/graph/session/nope").json()
        assert info["exists"] is False
