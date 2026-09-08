"""统一数据模型（控制层契约）

职责4：统一响应封装 { data: 图谱子集, actions: [动画指令] }。
- AnimationAction 是与前端渲染引擎（视图层）的动画指令契约；
- GraphData / GraphNode / GraphEdge 与 models/graph_model.py 约定对齐，
  待 models 层实现后可替换为共享模型；
- IntentResult / ReasonResult 是 Agent 层必须返回的结构化结果
  （约束：Agent 禁止操作视图，仅返回结构化 JSON）。
"""
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    """图谱节点（字段与 graph.json 约定一致）"""

    id: str
    name: str
    category: str = ""
    # 结点内的富媒体内容：{"text": 文字解释, "images": [...], "videos": [...]}
    media: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    source: str
    target: str
    relation: str = ""


class GraphData(BaseModel):
    """图谱（子）集"""

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


class UnifiedResponse(BaseModel):
    """统一响应：数据 + 动画指令 + 元信息，实现"数据+表现"闭环"""

    code: int = 0                      # 0 成功，非 0 失败
    message: str = "success"
    session_id: str = ""               # 本次请求所属会话
    data: GraphData | None = None      # 图谱子集
    actions: list[AnimationAction] = Field(default_factory=list)
    degraded: bool = False             # 是否已降级（熔断/超时兜底）
    notice: str | None = None          # 提示语，如"已切换到基础检索模式"


class IntentResult(BaseModel):
    """意图识别 Agent 的结构化输出（禁止操作视图，仅返回结构化数据）"""

    intent: str = "query"                       # 如 query / explain / reason
    entities: list[str] = Field(default_factory=list)  # 图谱节点 ID


class ReasonResult(BaseModel):
    """关系推理/摘要 Agent 的结构化输出"""

    summary: str = ""
    related_nodes: list[str] = Field(default_factory=list)
