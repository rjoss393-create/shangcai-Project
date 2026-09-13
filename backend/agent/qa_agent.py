"""QaAgent 适配器：把内部 LLM_Navigator 包装成控制层 QaAgent 协议。

位置：backend/agent/qa_agent.py
依赖：controller.schemas（控制层提供）
"""
import asyncio
import logging

from controller.schemas import AnswerResult, GraphData, RelatedNode

logger = logging.getLogger(__name__)


class QaAgentImpl:
    """实现控制层 QaAgent 协议（preload + answer）"""

    def __init__(self, navigator):
        """
        navigator: LLM_Navigator 实例（由装配方注入）
        """
        self.navigator = navigator

    async def preload(self, graph_id: str, graph: GraphData) -> None:
        """
        预热：页面打开时由控制层后台调用。
        - 只触发建图 + 加载/生成 embedding，不问答
        - 幂等：同 graph_id 重复调用快速返回
        - 不抛异常（控制层会吞掉异常，但我们也不主动抛）
        """
        try:
            await asyncio.to_thread(self.navigator.warmup, graph)
        except Exception:
            logger.exception("[preload] 预热失败: %s", graph_id)

    async def answer(self, graph_data: GraphData, question: str) -> AnswerResult:
        """
        智能问答：接收标准 GraphData + 问题，返回 AnswerResult。
        同步核心逻辑放线程池，避免阻塞事件循环。
        """
        import time as _t
        _t0 = _t.perf_counter()
        print(f"[TIMING][QA_AGENT] 开始处理 question={question[:20]}...", flush=True)
        try:
            result_dict = await asyncio.to_thread(
                self.navigator.fast_retrieve_answer, graph_data, question
            )
            print(f"[TIMING][QA_AGENT] 完成，总耗时 {_t.perf_counter()-_t0:.2f}s", flush=True)
        except Exception:
            logger.exception("[answer] 调用失败")
            return AnswerResult()   # 空结果

        # dict -> Pydantic AnswerResult
        related = [
            RelatedNode(
                id=n["id"],
                name=n["name"],
                type=n.get("type", ""),
                page=n.get("page"),
            )
            for n in result_dict.get("related_nodes", [])
        ]
        return AnswerResult(
            prediction_llm=result_dict.get("prediction_llm", ""),
            prediction_html=result_dict.get("prediction_html", ""),
            related_nodes=related,
            retrieval_count=result_dict.get("retrieval_count", 0),
            used_count=result_dict.get("used_count", 0),
        )
