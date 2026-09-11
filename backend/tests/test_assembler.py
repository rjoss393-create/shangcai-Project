"""assembler 测试：各场景的动画指令序列"""
from controller.assembler import AnimationAssembler
from controller.schemas import GraphData, GraphEdge, GraphNode


def _graph(node_ids, edge_pairs=()):
    nodes = [GraphNode(id=nid, name=nid) for nid in node_ids]
    edges = [GraphEdge(source=s, target=t) for s, t in edge_pairs]
    return GraphData(nodes=nodes, edges=edges)


def _types(actions):
    return [a.type.value for a in actions]


class TestAssembler:
    def test_load(self):
        g = _graph(["n1", "n2"], [("n1", "n2")])
        actions = AnimationAssembler().assemble_load(g)
        assert _types(actions) == ["fade_in", "zoom"]
        assert actions[0].targets == ["n1", "n2"]
        assert actions[1].params["mode"] == "fit"

    def test_node_click_fade_in_new_fade_out_gone(self):
        g = _graph(["n1", "n2"])
        # 无离开节点：focus + fade_in
        actions = AnimationAssembler().assemble_node_click("n2", g, {"n1"})
        assert _types(actions) == ["focus", "fade_in"]
        assert actions[0].targets == ["n2"]
        assert actions[1].targets == ["n2"]
        # n9 离开视野：追加 fade_out
        actions2 = AnimationAssembler().assemble_node_click("n2", g, {"n1", "n9"})
        assert _types(actions2) == ["focus", "fade_in", "fade_out"]
        assert actions2[2].targets == ["n9"]

    def test_qa_focus_and_highlight_related(self):
        g = _graph(["n1", "n2"])
        actions = AnimationAssembler().assemble_qa(["n1", "n2"], g)
        assert _types(actions) == ["focus", "highlight", "zoom"]
        assert actions[0].targets == ["n1"]           # 聚焦首个引用节点
        assert actions[1].targets == ["n1", "n2"]     # 高亮全部引用节点

    def test_qa_related_not_in_subgraph_skipped(self):
        g = _graph(["n1"])
        actions = AnimationAssembler().assemble_qa(["n1", "n999"], g)
        assert _types(actions) == ["focus", "highlight", "zoom"]
        assert actions[1].targets == ["n1"]           # 只高亮子图中存在的

    def test_qa_no_related_nodes(self):
        g = _graph(["n1"])
        actions = AnimationAssembler().assemble_qa([], g)
        assert _types(actions) == ["zoom"]            # 无引用节点只缩放

    def test_fallback(self):
        g = _graph(["n1", "n2"])
        actions = AnimationAssembler().assemble_fallback(g)
        assert _types(actions) == ["highlight", "zoom"]
        assert actions[0].targets == ["n1", "n2"]
