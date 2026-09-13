"""投资学知识图谱 · 后端统一入口

启动（项目根目录）：uvicorn main:app --reload --port 8000
或双击 启动后端.bat

装配：DataService（数据层） + QaAgentImpl(LLM_Navigator)（Agent 层）
     + create_router（控制层）
启动事件：后台按顺序预热 4 本书（建图 + 加载/生成 embedding），
         把首次提问的冷启动成本转移到服务启动阶段。

分层约定：
- backend/controller  控制层（本仓库既有代码）
- backend/agent、src  Agent 层（Agent 负责人交付，内部代码不动）
- backend/service     数据访问层（读 data/ 的 JSON）
- data/               数据层（纯数据文件）
- 前端/               视图层（独立运行，proxy-server 3000 端口）
"""
import asyncio
import json
import logging
import os
import sys
from contextlib import asynccontextmanager

# ---- 环境变量（必须在导入 Agent 层代码之前设置） ----
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("WANDB_MODE", "disabled")

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("main")


def _load_api_config() -> None:
    """API Key：环境变量优先；本地 config.json 兜底（该文件不入库）"""
    cfg_path = os.path.join(BACKEND, "config.json")
    if not os.path.exists(cfg_path):
        logger.warning("未找到 backend/config.json 且未设置 AGNES_API_KEY，Agent 将不可用")
        return
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    for key, env in (("OPENAI_API_KEY", "AGNES_API_KEY"), ("OPENAI_BASE_URL", "AGNES_BASE_URL")):
        if cfg.get(key):
            os.environ.setdefault(env, cfg[key])
            os.environ.setdefault(key, cfg[key])


_load_api_config()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from controller.graph_ids import GRAPH_IDS
from controller.router import create_router
from service.data_service import DataService


def _build_qa_agent():
    """构造真 Agent（QaAgentImpl + LLM_Navigator）；失败返回 None（降级关键词检索）"""
    try:
        from agent.qa_agent import QaAgentImpl
        from src.llm_navigator import LLM_Navigator

        class NavArgs:
            d = "CL-LT-KGQA"
            embedding_model = "all-MiniLM-L6-v2"
            model_name = "deepseek-chat"
            save_cache = os.path.join(BACKEND, "cache")   # embedding .npy 缓存目录
            top_n = 30
            top_k = 5
            max_length = 3
            verifier = "deductive+planning"
            debug = False

        navigator = LLM_Navigator(NavArgs())
        return QaAgentImpl(navigator)
    except Exception:
        logger.exception("Agent 层初始化失败（缺少依赖或 API Key），智能问答将降级为基础检索")
        return None


service = DataService(data_dir=os.path.join(ROOT, "data"))
qa_agent = _build_qa_agent()


async def _preload_all_books() -> None:
    """启动后台任务：按顺序预热 4 本书。单本失败只记日志，不影响服务。"""
    for graph_id in GRAPH_IDS:
        if qa_agent is None:
            return
        try:
            graph = await service.get_full_graph(graph_id)
            await qa_agent.preload(graph_id, graph)
            logger.info("[preload] %s 预热完成（%d 节点 / %d 边）",
                        graph_id, len(graph.nodes), len(graph.edges))
        except Exception:
            logger.exception("[preload] %s 预热失败", graph_id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if qa_agent is not None:
        task = asyncio.create_task(_preload_all_books())
        logger.info("已在后台启动 4 本书的 embedding 预热任务")
        yield
        task.cancel()
    else:
        yield


app = FastAPI(title="投资学知识图谱", version="1.0.0", lifespan=lifespan)
app.include_router(create_router(service, qa_agent))

# 前端（proxy-server :3000）跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "agent": qa_agent is not None}
