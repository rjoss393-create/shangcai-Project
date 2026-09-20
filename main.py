"""投资学知识图谱 · 后端统一入口

启动（项目根目录）：uvicorn main:app --reload --port 8000
或双击 启动后端.bat

装配：DataService（数据层） + QaAgentImpl(LLM_Navigator)（Agent 层）
     + create_router（控制层）
     + UserStore + create_auth_router（账号注册/登录/用户管理，data/users.json）
     + ProfileStore + create_profile_router（个人状态：笔记/收藏/筛选，data/profiles.json）
     + create_media_router + mount_site（媒体数据 + 前端页面托管）
启动事件：后台按顺序预热 5 个图谱（4 本书 + 经济综合，
         建图 + 加载/生成 embedding），把首次提问的冷启动成本转移到服务启动阶段。

访问：启动后浏览器打开 http://localhost:8000/ 即为完整网页（页面/数据/接口同一个端口）

分层约定：
- backend/controller  控制层（本仓库既有代码）
- backend/agent、src  Agent 层（Agent 负责人交付，内部代码不动）
- backend/service     数据访问层（读 data/ 的 JSON）
- data/               数据层（纯数据文件）
- data/media/         媒体数据（视频/论文/图书封面/视频清单，由后端托管，见 controller/media.py）
- 前端/               视图层（只放页面自身的 html/css/js/字体/logo，由后端挂载到 /）
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

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from controller.auth import TokenManager, create_auth_router
from controller.graph_ids import GRAPH_IDS
from controller.media import create_media_router, mount_site
from controller.profile import create_profile_router
from controller.router import create_router
from service.data_service import DataService
from service.profile_store import ProfileStore
from service.user_store import UserStore


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


MEDIA_DIR = os.path.join(ROOT, "data", "media")            # 视频/论文/封面/清单
FRONTEND_DIR = os.path.join(ROOT, "前端", "SUFE-Knowledge-Galaxy")   # 页面自身资源

service = DataService(data_dir=os.path.join(ROOT, "data"))
qa_agent = _build_qa_agent()
# 用户账号/权限数据（JSON 文件，首个注册的用户自动成为管理员）
user_store = UserStore(path=os.path.join(ROOT, "data", "users.json"))
# 个人状态（笔记/收藏/临时关系/筛选，按用户整体存取）
profile_store = ProfileStore(path=os.path.join(ROOT, "data", "profiles.json"))
# 令牌管理器：登录（/api/auth）与个人状态（/api/user）共用，重启后需重新登录
token_manager = TokenManager()


async def _preload_all_books() -> None:
    """启动后台任务：按顺序预热 5 个图谱（4 本书 + 经济综合）。单本失败只记日志，不影响服务。"""
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
        logger.info("已在后台启动 5 个图谱的 embedding 预热任务")
        yield
        task.cancel()
    else:
        yield


app = FastAPI(title="投资学知识图谱", version="1.0.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """错误响应补 code/message 字段（前端按 {code, message} 读取提示文案，detail 原样保留）"""
    detail = exc.detail
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.status_code,
            "message": detail if isinstance(detail, str) else "请求有误",
            "detail": detail,
        },
        headers=getattr(exc, "headers", None),
    )


app.include_router(create_router(service, qa_agent))
app.include_router(create_auth_router(user_store, token_manager))
app.include_router(create_profile_router(user_store, profile_store, token_manager))
app.include_router(create_media_router(MEDIA_DIR))

# 跨域放行：页面已由本服务托管（同源），此配置保留给"页面另行托管"的场景
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


# 前端页面托管：必须放在最后（挂在 "/"，先注册的 /api、/assets、/data 路由优先匹配）
mount_site(app, FRONTEND_DIR)
