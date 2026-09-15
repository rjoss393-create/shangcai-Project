"""数据层 · 分层知识图谱生成脚本

把 docling 生成的原始知识图谱（章/节/概念/公式 + 包含* 边）加工成分层图谱：

- 宏观层（macro）  ：chapter 节点
- 中观层（meso）   ：section 节点
- 微观层（micro）  ：concept / formula 节点

规则（与《数据层分层设计.md》一致）：
1. 每个节点加 `layer`（macro/meso/micro）和 `parents`（所属章/节的 id 路径）；
2. 章直挂概念保留直挂，parents 只标章；
3. 无任何边的孤节点按 page 页码归入所在章/节，页码缺失则丢弃（仅从分层文件剔除）；
4. 派生"相关"边：章-章共享概念≥3、节-节共享概念≥2、微观层按页序近邻≤3，
   每节点派生边上限 8；
5. 原始包含* 边保留并打标 layer="hier"（供下钻导航用）。

用法：
    python scripts/generate_layered_data.py [--src 源目录] [--out 输出目录]
默认源目录 数据/（书页图谱 JSON + 视频等原始交付文件），输出 data/layered/。
"""
import argparse
import json
import os
import sys
from collections import defaultdict

# graph_id -> 源文件名（与 backend/controller/graph_ids.py 编码一致；invest 为新增书）
GRAPH_FILES = {
    "ma": "并购与重组_知识图谱.json",
    "corp_fin": "公司金融_知识图谱.json",
    "intl_inv": "国际投资学_知识图谱.json",
    "invest": "投资学_知识图谱.json",
    "econ": "经济综合_知识图谱.json",
}

# 派生边规则
CHAPTER_SHARE_MIN = 3      # 两章共享概念 ≥ N 才连"相关"
SECTION_SHARE_MIN = 2      # 两节共享概念 ≥ N 才连"相关"
MICRO_NEIGHBOR = 3         # 微观层每概念按页序连后面 ≤ N 个近邻
DERIVED_EDGE_CAP = 8       # 每个节点派生相关边上限


def main() -> None:
    parser = argparse.ArgumentParser(description="生成分层知识图谱")
    parser.add_argument("--src", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "数据"))
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "layered"))
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for graph_id, fname in GRAPH_FILES.items():
        path = os.path.join(args.src, fname)
        if not os.path.exists(path):
            print(f"[跳过] {graph_id}: 源文件缺失 {path}")
            continue
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        layered, stats = build_layered(raw, graph_id)
        out_path = os.path.join(args.out, f"{graph_id}_layered.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(layered, f, ensure_ascii=False, indent=1)
        print(f"[OK] {graph_id} -> {out_path}")
        print("     ", stats)


def build_layered(raw: dict, graph_id: str):
    """原始图谱 -> 分层图谱 + 统计信息"""
    nodes = {n["id"]: n for n in raw.get("nodes", [])}
    edges = raw.get("edges", [])

    def is_type(nid, t):
        tt = nodes.get(nid, {}).get("type")
        return tt == t if isinstance(t, str) else tt in t

    chapters = sorted((nid for nid in nodes if is_type(nid, "chapter")),
                      key=lambda nid: (nodes[nid].get("page") is None, nodes[nid].get("page") or 0))
    sections = [nid for nid in nodes if is_type(nid, "section")]
    micros = [nid for nid in nodes if nodes[nid].get("type") in ("concept", "formula")]

    # ---------- 1. 章排序与页码范围 ----------
    chapter_pages = []
    for nid in chapters:
        p = nodes[nid].get("page")
        if p is not None:
            chapter_pages.append((int(p), nid))
    chapter_pages.sort()
    chapter_range = {}   # nid -> (start, end) 开区间右端
    for i, (pg, nid) in enumerate(chapter_pages):
        end = chapter_pages[i + 1][0] if i + 1 < len(chapter_pages) else None
        chapter_range[nid] = (pg, end)

    def chapter_by_page(page):
        if page is None:
            return None
        for pg, nid in chapter_pages:
            end = chapter_range[nid][1]
            if page >= pg and (end is None or page < end):
                return nid
        # 页码小于第一章：归第一章；大于最后一章：归最后一章
        if page < chapter_pages[0][0]:
            return chapter_pages[0][1]
        return chapter_pages[-1][1]

    # ---------- 2. parents 计算 ----------
    sec2chap = {}
    chap2secs = defaultdict(list)
    for e in edges:
        if is_type(e["source"], "chapter") and is_type(e["target"], "section"):
            sec2chap.setdefault(e["target"], e["source"])

    for sid in sections:
        chap = sec2chap.get(sid) or chapter_by_page(nodes[sid].get("page"))
        if chap:
            chap2secs[chap].append(sid)

    chap2concepts = defaultdict(list)      # 章直挂概念
    sec2concepts = defaultdict(list)
    for e in edges:
        s, t = e["source"], e["target"]
        if is_type(s, "section") and is_type(t, ("concept", "formula")):
            sec2concepts[s].append(t)
        elif is_type(s, "chapter") and is_type(t, ("concept", "formula")):
            chap2concepts[s].append(t)

    node_parents = {}
    orphan_dropped = 0
    for cid in chapters:
        node_parents[cid] = []
    for sid in sections:
        chap = sec2chap.get(sid) or chapter_by_page(nodes[sid].get("page"))
        node_parents[sid] = [chap] if chap else []
    for mid in micros:
        ps = []
        for e in edges:
            if e["target"] == mid:
                if is_type(e["source"], "section"):
                    ps.append(e["source"])
                elif is_type(e["source"], "chapter"):
                    ps.append(e["source"])
        if not ps:  # 孤节点：按页码归并
            page = nodes[mid].get("page")
            if page is None:
                orphan_dropped += 1
                continue
            # 先找节（节页码在章范围内），再退而求其次找章
            sid = section_by_page(sections, nodes, page)
            if sid:
                ps = [sid]
            else:
                cid = chapter_by_page(page)
                if cid:
                    ps = [cid]
                else:
                    orphan_dropped += 1
                    continue
        node_parents[mid] = ps

    # ---------- 3. 节点输出（layer + parents） ----------
    out_nodes = []
    for nid, n in nodes.items():
        if nid not in node_parents:
            continue  # 已被丢弃
        t = n.get("type")
        layer = {"chapter": "macro", "section": "meso"}.get(t, "micro")
        out_nodes.append({
            "id": nid,
            "label": n.get("label") or n.get("name") or nid,
            "type": t,
            "page": n.get("page"),
            "layer": layer,
            "parents": node_parents[nid],
        })

    # ---------- 4. 边：原始包含* 打 hier 标 + 派生相关边 ----------
    out_edges = []
    seen_edges = set()
    for e in edges:
        if e["source"] in node_parents and e["target"] in node_parents:
            key = (e["source"], e["target"], e["relation"])
            if key not in seen_edges:
                seen_edges.add(key)
                out_edges.append({"source": e["source"], "target": e["target"],
                                  "relation": e["relation"], "layer": "hier"})

    # 章的完整概念集（直挂 + 经节）
    chap_full_concepts = defaultdict(set)
    for cid, sids in chap2secs.items():
        for sid in sids:
            chap_full_concepts[cid] |= set(sec2concepts.get(sid, []))
    for cid, ms in chap2concepts.items():
        chap_full_concepts[cid] |= set(ms)

    def add_derived(a, b, layer):
        if a == b:
            return
        key = (a, b, "相关")
        if key in seen_edges:
            return
        seen_edges.add(key)
        out_edges.append({"source": a, "target": b, "relation": "相关", "layer": layer})

    # 宏观：章-章共享概念
    chap_list = [c for c in chapters if c in node_parents]
    shared = {}
    for i, c1 in enumerate(chap_list):
        for c2 in chap_list[i + 1:]:
            s = len(chap_full_concepts.get(c1, set()) & chap_full_concepts.get(c2, set()))
            if s >= CHAPTER_SHARE_MIN:
                shared[(c1, c2)] = s
    # 每章只保留共享数最高的前 DERIVED_EDGE_CAP 条
    for cid in chap_list:
        cand = sorted(((s, a, b) for (a, b), s in shared.items() if a == cid or b == cid),
                      reverse=True)[:DERIVED_EDGE_CAP]
        for s, a, b in cand:
            add_derived(a, b, "macro")

    # 中观：节-节共享概念
    sec_list = [s for s in sections if s in node_parents]
    sec_shared = {}
    for i, s1 in enumerate(sec_list):
        for s2 in sec_list[i + 1:]:
            s = len(set(sec2concepts.get(s1, [])) & set(sec2concepts.get(s2, [])))
            if s >= SECTION_SHARE_MIN:
                sec_shared[(s1, s2)] = s
    for sid in sec_list:
        cand = sorted(((s, a, b) for (a, b), s in sec_shared.items() if a == sid or b == sid),
                      reverse=True)[:DERIVED_EDGE_CAP]
        for s, a, b in cand:
            add_derived(a, b, "meso")

    # 微观：同一 parent 组内按页码近邻连边（基于最终 parents，含按页码归并的孤节点）
    micro_groups = defaultdict(list)
    for mid in micros:
        if mid not in node_parents:
            continue
        ps = node_parents[mid]
        key = ("sec", ps[0]) if ps and ps[0] in sections else (
            ("chap", ps[0]) if ps and ps[0] in chapters else None)
        if key:
            micro_groups[key].append(mid)
    for key, members in micro_groups.items():
        if len(members) < 2:
            continue
        ms_sorted = sorted(members, key=lambda m: (nodes[m].get("page") is None, nodes[m].get("page") or 0))
        for i, m in enumerate(ms_sorted):
            for m2 in ms_sorted[i + 1:i + 1 + MICRO_NEIGHBOR]:
                add_derived(m, m2, "micro")

    layered = {
        "graph_id": graph_id,
        "title": raw.get("title", ""),
        "schema": "layered-knowledge-graph",
        "version": "1.0",
        "source": raw.get("source"),
        "nodes": out_nodes,
        "edges": out_edges,
    }

    stats = {
        "总节点": len(out_nodes),
        "macro": sum(1 for n in out_nodes if n["layer"] == "macro"),
        "meso": sum(1 for n in out_nodes if n["layer"] == "meso"),
        "micro": sum(1 for n in out_nodes if n["layer"] == "micro"),
        "孤节点丢弃": orphan_dropped,
        "hier边": sum(1 for e in out_edges if e["layer"] == "hier"),
        "macro相关边": sum(1 for e in out_edges if e["layer"] == "macro"),
        "meso相关边": sum(1 for e in out_edges if e["layer"] == "meso"),
        "micro相关边": sum(1 for e in out_edges if e["layer"] == "micro"),
    }
    return layered, stats


def section_by_page(sections, nodes, page):
    """在章内按节页码找覆盖 page 的节；节页码按升序、无页码排除。"""
    sec_pages = []
    for sid in sections:
        p = nodes[sid].get("page")
        if p is not None:
            sec_pages.append((int(p), sid))
    sec_pages.sort()
    for i, (pg, sid) in enumerate(sec_pages):
        end = sec_pages[i + 1][0] if i + 1 < len(sec_pages) else None
        if page >= pg and (end is None or page < end):
            return sid
    if sec_pages and page < sec_pages[0][0]:
        return sec_pages[0][1]
    return None


if __name__ == "__main__":
    main()
