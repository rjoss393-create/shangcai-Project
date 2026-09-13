"""统一数据模型（控制层契约）

职责4：统一响应封装 { data: 图谱子集, actions: [动画指令] }。
- AnimationAction 是与前端渲染引擎（视图层）的动画指令契约；
- GraphData / GraphNode / GraphEdge 字段格式与 Agent 层《字段.md》约定一致
  （原 models/graph_model.py 共享模型的设想已被该文档取代）；
- AnswerResult / RelatedNode 是智能问答 Agent 层必须返回的结构化结果
  （约束：Agent 禁止操作视图，仅返回结构化 JSON）。
"""
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    """图谱节点（字段与 graph.json 及 Agent 层《字段.md》约定一致）"""

    id: str                                 # 节点唯一 ID（超链接 data-node-id 用）
    label: str                              # 节点显示名（检索与答案上标显示用）
    type: str = ""                          # 节点类型：concept / formula / chapter / section
    page: int | None = None                 # 页码，没有则 null
    # 预留富媒体字段（当前无数据）：{"image_url": "...", "video_url": "..."}
    media: dict[str, Any] | None = None
    # 各书特有字段兜底：Agent 不解析，透传给前端
    extra: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    """图谱边（source / target / relation 必填，见《字段.md》）"""

    source: str                             # 起点节点 ID
    target: str                             # 终点节点 ID
    relation: str                           # 关系名（如 "包含概念" / "相关"）
    extra: dict[str, Any] = Field(default_factory=dict)   # 兜底字段，当前无数据


class GraphData(BaseModel):
    """图谱（子）集（字段与 Agent 层《字段.md》约定一致）

    graph_id / title 传给 Agent 前由控制层填充（《字段.md》：graph_id 必填、
    title 可选）；Service 层返回时二者可为空串（Service 契约未动，暂不感知多图谱）。
    """

    graph_id: str = ""
    title: str = ""
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class ActionType(str, Enum):
    """原子动画动作类型（与前端渲染引擎的契约）"""

    FOCUS = "focus"            # 聚焦到目标节点
    HIGHLIGHT = "highlight"    # 高亮目标节点
    FADE_IN = "fade_in"        # 淡入（新进入视野的节点）
    FADE_OUT = "fade_out"      # 淡出（离开视野的节点）
    EXPAND = "expand"          # 展开
    ZOOM = "zoom"              # 缩放（params: {"mode": "fit" | "in" | "out"}）
    TEXT_POPUP = "text_popup"  # 文本弹窗（params: {"title": str, "text": str}）


class AnimationAction(BaseModel):
    """一条原子动画指令：对 targets 执行 type 动作，参数在 params 中"""

    type: ActionType
    targets: list[str] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class RelatedNode(BaseModel):
    """答案中引用的图谱节点（与 prediction_html 中 data-node-id 一一对应）

    格式由 Agent 层提供（见根目录 llm返回输出示例.md）。
    """

    id: str                            # 节点唯一 ID，与图谱一致
    name: str                          # 节点显示名
    type: str = ""                     # 节点类型：concept / formula / chapter / section
    page: int | None = None            # 页码，没有则省略或为 null


class AnswerResult(BaseModel):
    """智能问答 Agent 的结构化输出（禁止操作视图，仅返回结构化数据）"""

    prediction_llm: str = ""                    # 纯文本答案（无上标，用于评估/复制/存档）
    prediction_html: str = ""                   # 带 <sup> 超链接的 HTML 答案，供前端渲染
    related_nodes: list[RelatedNode] = Field(default_factory=list)
    retrieval_count: int = 0                    # 检索命中的候选节点数
    used_count: int = 0                         # 实际使用并标记上标的节点数


class UnifiedResponse(BaseModel):
    """统一响应：数据 + 动画指令 + 元信息，实现"数据+表现"闭环"""

    code: int = 0                      # 0 成功，非 0 失败
    message: str = "success"
    session_id: str = ""               # 本次请求所属会话
    data: GraphData | None = None      # 图谱子集
    answer: AnswerResult | None = None # 智能问答答案（自然语言查询时返回）
    actions: list[AnimationAction] = Field(default_factory=list)
    degraded: bool = False             # 是否已降级（熔断/超时兜底）
    notice: str | None = None          # 提示语，如"已切换到基础检索模式"
