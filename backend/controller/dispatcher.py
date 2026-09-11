"""调度决策器（C4，职责1 + 职责5）：意图解析与智能路由 + 超时/熔断/降级

路由规则（基础版启发式，后续可升级为 LLM 分类器）：
- 结构化请求（节点点击、短关键词）            -> REGULAR：Service 快通道
- 非结构化/自然语言（含疑问词、解释类词等）    -> COMPLEX：Agent 慢通道

容错：
- 每次 Agent 问答调用套 asyncio.wait_for 超时（默认 20s，见 QA_TIMEOUT_SECONDS）；
  Agent 层缓存命中平均 2.7s，放宽避免首次加载图谱时被误杀；
  页面打开时的预加载（preload）走后台任务，不占用本次问答超时。
- 连续失败达到阈值触发熔断（CircuitBreaker），冷却期内直接短路走兜底；
- 兜底：extract_keywords 提取关键词 -> Service.search_keywords 基础检索。
"""
import asyncio
import re
import time
from enum import Enum
from typing import Awaitable, Callable, TypeVar

QA_TIMEOUT_SECONDS = 20.0  # 智能问答超时（Agent 层缓存命中平均 2.7s，首次加载图谱较慢）

T = TypeVar("T")


class RouteKind(str, Enum):
    REGULAR = "regular"   # 结构化查询：走 Service 快通道
    COMPLEX = "complex"   # 非结构化/复杂请求：走 Agent 慢通道


# 自然语言意图的启发式标志（疑问词/解释类词）
_NL_HINTS = (
    "什么是", "是什么", "为什么", "如何", "怎么", "解释", "分析", "比较",
    "区别", "关系", "介绍", "说明", "含义", "概念", "举例", "有哪些",
    "?", "？", "吗", "呢",
)

# 兜底关键词提取的停用词（基础版，后续可换 jieba 分词）
_STOPWORDS = {
    "的", "了", "是", "在", "和", "与", "或", "及", "一个", "什么", "一下",
    "请", "我", "你", "帮", "看看", "这个",
}

_SPLIT_RE = re.compile(r"[\s，。！？、；：,.!?;:()（）\"'“”‘’\-—_]+")


def extract_keywords(text: str, max_keywords: int = 5) -> list[str]:
    """兜底关键词提取：按标点/空白切分 + 停用词过滤。

    中文分词需要 jieba 等额外依赖，此处保持零依赖的简单实现，
    模糊匹配由 Service.search_keywords 负责。
    """
    keywords: list[str] = []
    for seg in _SPLIT_RE.split(text):
        if not seg or seg in _STOPWORDS or seg in keywords:
            continue
        keywords.append(seg)
        if len(keywords) >= max_keywords:
            break
    return keywords


class CircuitBreaker:
    """简易熔断器：连续失败 N 次后打开，冷却期内直接短路（半开后自动恢复）"""

    def __init__(self, failure_threshold: int = 3, cooldown_seconds: float = 10.0):
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if time.monotonic() - self._opened_at >= self.cooldown_seconds:
            self._opened_at = None
            self._failures = 0
            return False
        return True

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._opened_at = time.monotonic()


class Dispatcher:
    def __init__(
        self,
        agent_timeout: float = QA_TIMEOUT_SECONDS,
        breaker: CircuitBreaker | None = None,
    ):
        self.agent_timeout = agent_timeout
        self.breaker = breaker or CircuitBreaker()

    # ---------- 智能路由（职责1） ----------

    def decide_node_click(self, node_id: str) -> RouteKind:
        """节点点击：结构化请求，恒走快通道"""
        return RouteKind.REGULAR

    def decide_text(self, text: str) -> RouteKind:
        """文本请求：启发式判断走快通道还是慢通道"""
        if any(hint in text for hint in _NL_HINTS):
            return RouteKind.COMPLEX
        # 短文本且无标点疑问 -> 视为关键词检索（快通道）
        if len(text) <= 10 and not any(c in text for c in "?？。，,;；"):
            return RouteKind.REGULAR
        return RouteKind.COMPLEX

    # ---------- 超时保护 + 熔断（职责5） ----------

    async def call_agent(self, call: Callable[[], Awaitable[T]]) -> T | None:
        """带超时与熔断统计的 Agent 调用，失败返回 None（由编排器触发降级）。

        注意：Agent 内部异常同样计入熔断失败次数（视为服务不可用），
        但不会吞掉 asyncio.CancelledError。
        """
        if self.breaker.is_open:
            return None
        try:
            result = await asyncio.wait_for(call(), timeout=self.agent_timeout)
        except Exception:
            self.breaker.record_failure()
            return None
        self.breaker.record_success()
        return result
