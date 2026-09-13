"""动画指令组装器（C3，职责3）

把数据操作（聚焦/高亮/展开等）转换为前端渲染引擎可执行的
原子动画动作序列（AnimationAction，纯数据，不操作视图）。

动作序列约定（与 controller.txt 场景对齐）：
- 场景1 节点点击：focus -> fade_in(新节点) -> fade_out(离开视野的旧节点)
- 场景2 自然语言：highlight(命中实体) -> text_popup(摘要) -> zoom(fit)
- 场景3 降级兜底：highlight(关键词命中) -> zoom(fit)
"""
from .schemas import ActionType, AnimationAction, GraphData, ReasonResult

DEFAULT_DURATION_MS = 400


class AnimationAssembler:
    def _act(self, type_: ActionType, targets=(), **params) -> AnimationAction:
        return AnimationAction(type=type_, targets=list(targets), params=params)

    def assemble_load(self, graph: GraphData) -> list[AnimationAction]:
        """页面初始加载：全图淡入 + 缩放适配视口"""
        return [
            self._act(ActionType.FADE_IN, [n.id for n in graph.nodes], duration=DEFAULT_DURATION_MS),
            self._act(ActionType.ZOOM, mode="fit", duration=600),
        ]

    def assemble_node_click(
        self,
        node_id: str,
        subgraph: GraphData,
        previous_visible: set[str],
    ) -> list[AnimationAction]:
        """场景1：聚焦被点击节点；淡入新节点、淡出离开视野的旧节点"""
        current = {n.id for n in subgraph.nodes}
        new_nodes = sorted(current - previous_visible)
        gone_nodes = sorted(previous_visible - current)
        actions = [self._act(ActionType.FOCUS, [node_id], duration=300)]
        if new_nodes:
            actions.append(self._act(ActionType.FADE_IN, new_nodes, duration=DEFAULT_DURATION_MS))
        if gone_nodes:
            actions.append(self._act(ActionType.FADE_OUT, gone_nodes, duration=DEFAULT_DURATION_MS))
        return actions

    def assemble_nl_query(
        self,
        entity_ids: list[str],
        subgraph: GraphData,
        summary: ReasonResult | None,
        previous_visible: set[str],
    ) -> list[AnimationAction]:
        """场景2：高亮命中实体 + 文本弹窗（摘要）+ 缩放适配"""
        entity_set = set(entity_ids)
        matched = [n.id for n in subgraph.nodes if n.id in entity_set]
        if not matched:
            matched = [n.id for n in subgraph.nodes]
        actions = [self._act(ActionType.HIGHLIGHT, matched, duration=500)]
        if summary and summary.summary:
            actions.append(
                self._act(ActionType.TEXT_POPUP, matched[:1], title="摘要", text=summary.summary)
            )
        actions.append(self._act(ActionType.ZOOM, mode="fit", duration=600))
        return actions

    def assemble_fallback(self, subgraph: GraphData) -> list[AnimationAction]:
        """场景3：降级兜底——基础高亮 + 缩放适配"""
        ids = [n.id for n in subgraph.nodes]
        return [
            self._act(ActionType.HIGHLIGHT, ids, duration=500),
            self._act(ActionType.ZOOM, mode="fit", duration=600),
        ]
