# -*- coding: utf-8 -*-
"""把前端负责人的 v6 统一知识星系数据转成后端分层数据契约

源文件：原为 newcssSUFE-Knowledge-Galaxy/data/galaxy_v6_clustered.json
        （交付包已于 2026-09-22 合并进 前端/ 后删除；原始 JSON 备份在
        E:/galaxy_probe/backup_root_packages_2026-09-22/newcssSUFE-Knowledge-Galaxy/data/）
        产物 data/layered/v6_layered.json 已入库，通常无需重跑；若默认路径不存在，用参数显式传源路径。
产物  ：data/layered/v6_layered.json（与 data/layered/*.json 同构，供 DataService 直接加载）

字段映射（v6 -> 后端 {id,label,type,page,layer,media,extra}）：
    id          -> id            （原样，kp_* 命名空间）
    name        -> label         （契约里叫 label，检索与答案上标显示用）
    level       -> type / layer  （domain / macro / meso / micro / explanation 原值保留）
    parent_id   -> parents: [parent_id]  （后端/前端约定：父节点写数组；同时在 extra 保留
                                          原名 parent_id，方便日后 v6 引擎直接读）
    —           -> page = None   （v6 没有页码，3661/3661 全空；"定位到教材第 N 页"能力缺失）
    media       -> None          （v6 的 media 全是 {video:null,animation:null,comic:null}）
    其余字段    -> 原样保留（落进 extra，Agent 不解析、透传前端）

边映射：source/target/relation 原样；relation == "包含" 的边 layer="hier"（原始包含边），
        其余按两端点中更细的层级标注 macro/meso/micro（对齐 econ_layered.json 的约定）。

用法：
    E:/python/python.exe scripts/import_v6_galaxy.py            # 用默认路径
    E:/python/python.exe scripts/import_v6_galaxy.py <源> <目标>  # 覆盖路径
"""
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_SRC = os.path.join(
    ROOT, "newcssSUFE-Knowledge-Galaxy", "data", "galaxy_v6_clustered.json"
)
DEFAULT_DST = os.path.join(ROOT, "data", "layered", "v6_layered.json")

GRAPH_ID = "v6"
TITLE = "统一知识星系（v6）"

# 契约里已有专名、不进 extra 的键
CONTRACT_KEYS = {"id", "label", "name", "type", "category", "page", "layer", "media"}
# v6 内部字段名 -> 落库时用的名字（避免与契约键名冲突）
RENAME = {}

# 值为 None / 空串 / 空列表 / 空字典时直接丢弃，减小体积（缺字段与空值在前端等价）
DROP_IF_EMPTY = True

LEVEL_DEPTH = {"domain": 0, "macro": 1, "meso": 2, "micro": 3, "explanation": 4}


def _empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {} or v is False


def convert_node(raw: dict) -> dict:
    nid = str(raw["id"])
    level = raw.get("level") or ""
    parent_id = raw.get("parent_id") or None

    node = {
        "id": nid,
        "label": raw.get("name") or raw.get("label") or nid,
        "type": level,
        "page": None,          # v6 全无页码，契约允许 null
        "layer": level,        # domain / macro / meso / micro / explanation
        "media": None,
        # 后端与前端既有约定：父节点写数组；v6 是单亲，包成一个元素的数组
        "parents": [parent_id] if parent_id else [],
    }
    if parent_id:
        node["parent_id"] = parent_id          # 保留 v6 原名，方便 v6 引擎直读
    node["level"] = level                      # 保留 v6 原名

    for k, v in raw.items():
        if k in CONTRACT_KEYS or k == "parent_id":
            continue
        if DROP_IF_EMPTY and _empty(v):
            continue
        node[RENAME.get(k, k)] = v
    return node


def convert_edge(raw: dict, depth_of: dict) -> dict:
    src = str(raw["source"])
    tgt = str(raw["target"])
    relation = raw.get("relation") or "相关"
    if relation == "包含":
        layer = "hier"
    else:
        layer = max(
            (k for k in (depth_of.get(src), depth_of.get(tgt)) if k is not None),
            default=0,
        )
        layer = {v: k for k, v in LEVEL_DEPTH.items()}.get(layer, "")
    edge = {
        "source": src,
        "target": tgt,
        "relation": relation,
        "layer": layer,
    }
    for k, v in raw.items():
        if k in {"source", "target", "relation", "layer"}:
            continue
        if DROP_IF_EMPTY and _empty(v):
            continue
        edge[k] = v
    return edge


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DST

    if not os.path.exists(src):
        print("[错误] 源文件不存在: %s" % src)
        return 1

    with open(src, "r", encoding="utf-8") as f:
        raw = json.load(f)

    raw_nodes = raw.get("nodes", [])
    raw_edges = raw.get("edges", [])
    print("[读取] %s" % src)
    print("        节点 %d / 边 %d" % (len(raw_nodes), len(raw_edges)))

    nodes = [convert_node(n) for n in raw_nodes]
    ids = {n["id"] for n in nodes}

    # 校验：父节点必须存在，边端点必须存在（源数据已保证，这里防手改）
    missing_parent = [
        n["id"] for n in nodes
        if n.get("parent_id") and n["parent_id"] not in ids
    ]
    if missing_parent:
        print("[错误] 有 %d 个节点的 parent_id 指向不存在的节点，前 5 个: %s"
              % (len(missing_parent), missing_parent[:5]))
        return 1
    bad_ends = [
        e for e in raw_edges
        if str(e["source"]) not in ids or str(e["target"]) not in ids
    ]
    if bad_ends:
        print("[错误] 有 %d 条边的端点不存在" % len(bad_ends))
        return 1
    print("[校验] 父节点引用与边端点全部有效")

    depth_of = {n["id"]: LEVEL_DEPTH.get(n["layer"], 3) for n in nodes}
    edges = [convert_edge(e, depth_of) for e in raw_edges]

    out = {
        "graph_id": GRAPH_ID,
        "title": TITLE,
        "schema": "layered-knowledge-graph",
        "version": "1.0",
        "source": [os.path.basename(src)],
        "nodes": nodes,
        "edges": edges,
    }
    if raw.get("metadata"):
        out["source_metadata"] = raw["metadata"]

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    # ---------- 统计 ----------
    roots = [n for n in nodes if not n["parents"]]
    print("\n[产出] %s  (%.2f MB)" % (dst, os.path.getsize(dst) / 1024 / 1024))
    print("        节点 %d / 边 %d" % (len(nodes), len(edges)))
    print("        layer 分布: %s" % dict(Counter(n["layer"] for n in nodes)))
    print("        边 layer 分布: %s" % dict(Counter(e["layer"] for e in edges)))
    print("        根节点（无 parent）%d 个: %s"
          % (len(roots), dict(Counter(n["layer"] for n in roots))))
    if roots:
        others = [n for n in roots if n["layer"] != "domain"]
        if others:
            print("          其中 %d 个非 domain 根（v6 扩展节点，源数据就没有 parent），例如 %s"
                  % (len(others), [n["id"] for n in others[:3]]))
    print("        page 非空: %d / %d（v6 无页码，此列恒为 null）"
          % (sum(1 for n in nodes if n["page"] is not None), len(nodes)))
    print("        extra 平均键数: %.1f"
          % (sum(len([k for k in n if k not in
                      ("id", "label", "type", "page", "layer", "media")]) for n in nodes)
             / max(len(nodes), 1)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
