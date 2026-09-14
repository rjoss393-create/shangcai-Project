"""离线生成 embedding 缓存脚本

用途：服务启动前，为 data/ 下所有图谱批量生成 embedding .npy 缓存，
     避免后端启动预热时按顺序现算（每本书数千节点，CPU 上较慢）。

用法（项目根目录或 backend/ 下均可）：
    python backend/generate_cache.py            # 只生成缺失 / 节点数不匹配的缓存
    python backend/generate_cache.py --force    # 全部重新生成（数据文件更新后用）

缓存位置：backend/cache/{graph_id}_all-MiniLM-L6-v2/{entity,relation}/*.npy
     与 LLM_Navigator 的 Graph 类读写路径完全一致（目录键 = graph_id，文件名键 = id = graph_id）。
"""
import argparse
import json
import os
import sys
import time

# ---- 环境变量（必须在导入 sentence-transformers 之前设置） ----
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("WANDB_MODE", "disabled")

BACKEND = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BACKEND)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)


def _load_api_config() -> None:
    """LLM_Backbone 构造要求有 API Key（本地 embedding 不调 API，但构造期校验）。
    与 main.py 相同：环境变量优先，backend/config.json 兜底（该文件不入库）。"""
    cfg_path = os.path.join(BACKEND, "config.json")
    if not os.path.exists(cfg_path):
        return
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    for key, env in (("OPENAI_API_KEY", "AGNES_API_KEY"), ("OPENAI_BASE_URL", "AGNES_BASE_URL")):
        if cfg.get(key):
            os.environ.setdefault(env, cfg[key])
            os.environ.setdefault(key, cfg[key])


_load_api_config()

from controller.graph_ids import GRAPH_FILES, GRAPH_IDS
from src import utils
from src.utils.data_types import Graph


class NavArgs:
    """与 main.py._build_qa_agent 相同的 Agent 参数（Graph 构造只用 embedding_model/model_name）"""
    d = "CL-LT-KGQA"
    embedding_model = "all-MiniLM-L6-v2"
    model_name = "deepseek-chat"
    save_cache = os.path.join(BACKEND, "cache")
    top_n = 30
    top_k = 5
    max_length = 3
    verifier = "deductive+planning"
    debug = False


def load_triples_and_meta(path: str):
    """从知识图谱 JSON 提取三元组与节点元信息。
    构造方式与 LLM_Navigator._get_or_create_graph 完全一致（embedding 数量必须对齐，
    否则启动时数量校验不过会重新现算）。"""
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    triples = [(e["source"], e["relation"], e["target"]) for e in raw.get("edges", [])]
    node_meta = {
        n["id"]: {"label": n.get("label", n["id"]), "type": n.get("type", ""), "page": n.get("page")}
        for n in raw.get("nodes", [])
    }
    return triples, node_meta


def main() -> None:
    parser = argparse.ArgumentParser(description="离线生成 embedding 缓存")
    parser.add_argument("--force", action="store_true", help="忽略已有缓存，全部重新生成")
    args = parser.parse_args()

    data_dir = os.path.join(ROOT, "data")
    failed = []
    for graph_id, filename in GRAPH_FILES.items():
        path = os.path.join(data_dir, filename)
        if not os.path.exists(path):
            print(f"[跳过] {graph_id}: 数据文件缺失 {path}")
            continue
        t0 = time.perf_counter()
        try:
            triples, node_meta = load_triples_and_meta(path)
            graph = Graph(
                args=NavArgs(),
                graph=utils.build_graph(triples),
                node_meta=node_meta,
                graph_id=graph_id,
                cache_path=NavArgs.save_cache,
                id=graph_id,
                embedding_method=NavArgs.embedding_model,
                replace=args.force,
            )
            print(f"[OK] {graph_id}（{GRAPH_IDS[graph_id]}）："
                  f"{len(graph.nodes)} 节点 / {len(graph.edges)} 边，"
                  f"耗时 {time.perf_counter() - t0:.1f}s", flush=True)
        except Exception:
            failed.append(graph_id)
            import traceback
            print(f"[失败] {graph_id}（{GRAPH_IDS[graph_id]}）：", flush=True)
            traceback.print_exc()

    if failed:
        print(f"\n共 {len(failed)} 个图谱生成失败: {failed}")
        sys.exit(1)
    print("\n全部完成。后端启动预热将直接加载 .npy 缓存。")


if __name__ == "__main__":
    main()
