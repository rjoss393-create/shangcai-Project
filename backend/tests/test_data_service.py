"""DataService 测试：图谱文件加载与分层取数

重点覆盖两件事（2026-09-24 起 invest / corp_fin / ma 改指向新版课程知识图谱）：

1. **字段归一**：新版课程图谱（course_graph_*.json）的节点用 `name` / `level` /
   `parent_id`，而统一契约用 `label` / `layer`，加载时要兜住
   （`label ← name`、`layer ← level`，其余字段进 extra）。
2. **章的层**：书籍详情小图按「章」取数，新版课程图谱的章在 meso 层、
   旧分层图谱的章在 macro 层（见 controller/router.py 的 CHAPTER_LAYER）。
"""
import json

import pytest

from service.data_service import DataService


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


COURSE_GRAPH = {
    "metadata": {"schema": "course-knowledge-graph", "course_name": "投资学"},
    "nodes": [
        {"id": "inv_macro_001", "name": "投资学", "level": "macro", "parent_id": None},
        {"id": "inv_meso_001", "name": "投资环境", "level": "meso", "parent_id": "inv_macro_001"},
        {"id": "inv_micro_0001", "name": "投资的定义", "level": "micro",
         "parent_id": "inv_meso_001", "description": "投入当前资金或资源……",
         "media": {"video": None, "animation": None,
                   "comic": {"album": "inv_p01", "page": 2}}},
    ],
    "edges": [
        {"source": "inv_macro_001", "target": "inv_meso_001", "relation": "包含"},
    ],
}

LAYERED_GRAPH = {
    "graph_id": "intl_inv",
    "nodes": [
        {"id": "chapter_0029", "label": "第1章 国际投资导论", "type": "chapter",
         "page": 14, "layer": "macro"},
        {"id": "concept_0001", "label": "国际投资", "type": "concept",
         "page": 14, "layer": "micro", "parents": ["chapter_0029"]},
    ],
    "edges": [
        {"source": "chapter_0029", "target": "concept_0001", "relation": "包含概念",
         "layer": "hier"},
    ],
}


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """按 GRAPH_FILES 里登记的文件名铺两份小图，其余文件缺失走 warning 分支"""
    monkeypatch.setattr(
        "service.data_service.GRAPH_FILES",
        {
            "invest": "media/graphs/course_graph_investment.json",
            "intl_inv": "layered/intl_inv_layered.json",
        },
    )
    _write(tmp_path / "media" / "graphs" / "course_graph_investment.json", COURSE_GRAPH)
    _write(tmp_path / "layered" / "intl_inv_layered.json", LAYERED_GRAPH)
    return tmp_path


class TestCourseGraphNormalization:

    def test_label_and_layer_fall_back_to_name_and_level(self, data_dir):
        svc = DataService(str(data_dir))
        g = svc._graphs["invest"]
        assert len(g.nodes) == 3

        micro = next(n for n in g.nodes if n.id == "inv_micro_0001")
        assert micro.label == "投资的定义"     # label ← name
        assert micro.layer == "micro"          # layer ← level
        # parent_id / description 留在 extra 里给前端与 Agent 层用
        assert micro.extra["parent_id"] == "inv_meso_001"
        assert micro.extra["level"] == "micro"
        assert micro.extra["description"].startswith("投入当前资金")
        # media 透传（知识点小漫画挂在 media.comic 上）
        assert micro.media["comic"]["album"] == "inv_p01"
        assert "media" not in micro.extra

    @pytest.mark.asyncio
    async def test_chapter_layer_is_meso_for_course_graph(self, data_dir):
        svc = DataService(str(data_dir))
        graph = await svc.get_layer("invest", "meso")      # CHAPTER_LAYER['invest']
        assert [n.id for n in graph.nodes] == ["inv_meso_001"]

    @pytest.mark.asyncio
    async def test_chapter_layer_is_macro_for_old_layered_graph(self, data_dir):
        svc = DataService(str(data_dir))
        graph = await svc.get_layer("intl_inv", "macro")   # CHAPTER_LAYER['intl_inv']
        assert [n.id for n in graph.nodes] == ["chapter_0029"]

    @pytest.mark.asyncio
    async def test_edges_are_loaded_verbatim(self, data_dir):
        svc = DataService(str(data_dir))
        graph = await svc.get_full_graph("invest")
        assert len(graph.edges) == 1
        assert graph.edges[0].relation == "包含"

    @pytest.mark.asyncio
    async def test_search_keywords_reaches_description(self, data_dir):
        """搜索用的 haystack 含 extra，所以新版图谱的 description 能被搜到"""
        svc = DataService(str(data_dir))
        graph = await svc.search_keywords(["投入当前资金"], graph_id="invest")
        assert [n.id for n in graph.nodes] == ["inv_micro_0001"]


class TestMissingFiles:

    def test_missing_file_does_not_break_startup(self, tmp_path, monkeypatch):
        monkeypatch.setattr("service.data_service.GRAPH_FILES",
                            {"invest": "media/graphs/nope.json"})
        svc = DataService(str(tmp_path))
        assert "invest" not in svc._graphs
        with pytest.raises(ValueError):
            svc._require("invest")
