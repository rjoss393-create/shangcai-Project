import json
import argparse
import os
import sys
import time

# Setup HF mirror
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("WANDB_MODE", "disabled")

# Load API config
config_file = os.path.join(os.path.dirname(__file__), "config.json")
if os.path.exists(config_file):
    with open(config_file, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    api_key = os.environ.get("AGNES_API_KEY") or cfg.get("OPENAI_API_KEY", "")
    base_url = os.environ.get("AGNES_BASE_URL") or cfg.get("OPENAI_BASE_URL", None)
    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url

sys.path.insert(0, os.path.dirname(__file__))

from src.llm_navigator import LLM_Navigator
from src import utils
from controller.schemas import GraphData, GraphNode, GraphEdge


GRAPH_ID_MAP = {
    "公司金融": "corp_fin",
    "国际投资学": "intl_inv",
    "并购与重组": "ma",
    "经济综合": "econ",
}

ALLOWED_GRAPH_IDS = {"corp_fin", "intl_inv", "ma", "econ"}


def resolve_graph_id(graph_path: str) -> str:
    """从图谱文件路径推断 graph_id"""
    fname = os.path.basename(graph_path)
    for cn_name, gid in GRAPH_ID_MAP.items():
        if cn_name in fname:
            return gid
    raise ValueError(f"无法从文件名推断 graph_id: {fname}")


def convert_json_to_jsonl(json_path: str, output_path: str = None) -> str:
    """将 JSON 知识图谱转换为三元组 JSONL 格式
    
    Args:
        json_path: 输入 JSON 文件路径
        output_path: 输出 JSONL 文件路径（可选）
    
    Returns:
        JSONL 文件路径
    """
    print(f"正在转换知识图谱：{json_path}")
    
    # 读取 JSON
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 提取节点和边
    # ★ 保留原始 id 作为节点 key，不要换成 label
    triples = []
    for edge in data['edges']:
        h = edge['source']     # 保留 id
        r = edge['relation']
        t = edge['target']     # 保留 id
        triples.append((h, r, t))
    
    # 确定输出路径
    if output_path is None:
        base = os.path.splitext(json_path)[0]
        output_path = base + '_triples.jsonl'
    
    # 写入 JSONL
    with open(output_path, 'w', encoding='utf-8') as f:
        for triple in triples:
            f.write(json.dumps(triple, ensure_ascii=False) + '\n')
    
    print(f"[OK] 转换完成: {len(triples)} 条三元组 -> {output_path}")
    return output_path


def load_triples_from_jsonl(jsonl_path: str) -> list:
    """从 JSONL 文件加载三元组列表"""
    triples = []
    with open(jsonl_path, 'r', encoding='utf-8') as f:
        for line in f:
            triple = json.loads(line.strip())
            triples.append(tuple(triple))
    return triples


def load_json_to_triples(json_path: str) -> list:
    """从 JSON 直接加载三元组（不保存文件）"""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # ★ 保留原始 id
    triples = []
    for edge in data['edges']:
        h = edge['source']
        r = edge['relation']
        t = edge['target']
        triples.append((h, r, t))
    return triples


def load_graph_data(json_path: str, graph_id: str) -> GraphData:
    """从原始 JSON 构造标准 Pydantic GraphData"""
    with open(json_path, 'r', encoding='utf-8') as f:
        raw = json.load(f)

    RESERVED = {"id", "label", "type", "page", "media"}
    nodes = []
    for n in raw.get("nodes", []):
        extra = {k: v for k, v in n.items() if k not in RESERVED}
        nodes.append(GraphNode(
            id=n["id"],
            label=n["label"],
            type=n.get("type", ""),
            page=n.get("page"),
            media=n.get("media"),
            extra=extra,
        ))

    edges = [
        GraphEdge(
            source=e["source"],
            target=e["target"],
            relation=e["relation"],
            extra={},
        )
        for e in raw.get("edges", [])
    ]

    return GraphData(
        graph_id=graph_id,
        title=raw.get("title", ""),
        nodes=nodes,
        edges=edges,
    )


def main():
    parser = argparse.ArgumentParser(description="方案B：基于语义检索的知识问答")
    parser.add_argument("--question", "-q", type=str, required=False, help="用户问题（不指定则仅转换）")
    parser.add_argument("--graph_path", "-g", type=str, required=True, help="JSON图谱路径（支持.json/.jsonl）")
    parser.add_argument("--model", "-m", type=str, default="deepseek-chat", help="LLM模型")
    parser.add_argument("--embedding", "-e", type=str, default="all-MiniLM-L6-v2", help="Embedding模型")
    parser.add_argument("--cache_dir", type=str, default="./cache", help="embedding缓存目录")
    parser.add_argument("--top_k", type=int, default=5, help="检索返回节点数")
    parser.add_argument("--convert_only", action="store_true", help="仅转换格式，不运行问答")
    args = parser.parse_args()
    
    # 确定图谱路径
    graph_path = args.graph_path
    graph_name = os.path.basename(graph_path).replace('.json', '').replace('.jsonl', '')

    # 加载图谱
    print(f"\n正在加载图谱：{graph_path}")
    start_time = time.perf_counter()

    graph_id = resolve_graph_id(graph_path)
    if graph_id not in ALLOWED_GRAPH_IDS:
        raise ValueError(f"graph_id {graph_id} 不在白名单内")

    graph_data = load_graph_data(graph_path, graph_id)
    elapsed_load = time.perf_counter() - start_time
    print(f"[OK] 加载完成: {len(graph_data.nodes)} 节点, "
          f"{len(graph_data.edges)} 边 (耗时 {elapsed_load:.1f}s)\n")

    # 构造 args
    class Args:
        pass
    nav_args = Args()
    nav_args.d = "CL-LT-KGQA"
    nav_args.embedding_model = args.embedding
    nav_args.model_name = args.model
    nav_args.save_cache = args.cache_dir
    nav_args.top_n = 30
    nav_args.top_k = 5
    nav_args.max_length = 3
    nav_args.verifier = "deductive+planning"
    nav_args.debug = True

    navigator = LLM_Navigator(nav_args)

    print(f"\n问题：{args.question}")
    print("-" * 50)
    t0 = time.perf_counter()
    result = navigator.fast_retrieve_answer(graph_data, args.question)
    elapsed = time.perf_counter() - t0

    print(f"\n耗时：{elapsed:.1f}s")
    print(f"\n答案（纯文本）：{result['prediction_llm']}")
    print(f"\n答案（HTML）：{result.get('prediction_html', result['prediction_llm'])}")

    # 保存结果
    output_dir = os.path.join(os.path.dirname(__file__), "results", "rag_output", graph_name, time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(output_dir, exist_ok=True)
    result_file = os.path.join(output_dir, "result.json")
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump({
            "question": args.question,
            "graph": graph_path,
            "model": args.model,
            "embedding": args.embedding,
            "elapsed_s": round(elapsed, 1),
            "load_time_s": round(elapsed_load, 1),
            "node_count": len(graph_data.nodes),
            "edge_count": len(graph_data.edges),
            "result": result,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n结果已保存: {result_file}")
    
    # 生成测试用 HTML 文件
    prediction_html = result.get('prediction_html', result['prediction_llm'])
    test_html_path = os.path.join(output_dir, "test_link.html")
    
    html_content = f'''<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>超链接本地测试</title>
  <style>
    body {{ font-family: sans-serif; padding: 20px; max-width: 900px; }}
    h2 {{ border-bottom: 1px solid #ccc; padding-bottom: 5px; }}
    .box {{ padding: 15px; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 20px; }}
    .kg-node-link {{ color: #1976d2; text-decoration: none; font-weight: bold; }}
    .kg-node-native {{ color: #d32f2f; text-decoration: none; font-weight: bold; }}
    sup {{ font-size: 0.75em; vertical-align: super; }}
  </style>
</head>
<body>
  <h1>超链接测试页</h1>
  <p><strong>问题：</strong>{args.question}</p>

  <h2>模块 A：拦截模式</h2>
  <div class="box" id="answer-intercept">
    {prediction_html}
  </div>

  <h2>模块 B：原生跳转模式</h2>
  <div class="box" id="answer-native">
    {prediction_html}
  </div>

  <script>
    // 模块 A：拦截
    document.querySelectorAll('#answer-intercept .kg-node-link').forEach(link => {{
      link.addEventListener('click', (e) => {{
        e.preventDefault();
        alert('【拦截模式】\\n节点 ID: ' + link.dataset.nodeId + '\\n节点名称: ' + link.dataset.nodeName);
      }});
    }});

    // 模块 B：把 kg-node-link 改成 kg-node-native，让监听器失效，走原生跳转
    document.querySelectorAll('#answer-native .kg-node-link').forEach(link => {{
      link.classList.remove('kg-node-link');
      link.classList.add('kg-node-native');
    }});
  </script>
</body>
</html>'''
    
    with open(test_html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    print(f"测试页已生成: {test_html_path}")
    print("\n请用浏览器打开 test_link.html 进行验证：")
    print("  模块 A（蓝色上标）：点击应弹出节点信息，不跳转")
    print("  模块 B（红色上标）：点击应尝试跳转，显示 404")


if __name__ == "__main__":
    main()
