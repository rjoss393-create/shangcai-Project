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
import re
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


# ============================================================
# ★ 清洗（2026-09-15）：上游抽取是"逐页"产出，没有合并重复，导致
#   ① 同一章的页眉在连续页上被抽成多个章节点（"第21章期权估值"×12）
#   ② 目录页整页变成章节点  ③ 表格数字变成"节"（90.75%、139.66）
#   ④ 正文句子、版权页信息变成"概念"
# 这里按规则清洗，命中情况全部写进《数据清洗报告.md》供人工审阅；
# 原始交付文件不改，只影响分层产物。
# ============================================================
R_SEC_NUM    = re.compile(r"^[\d.,]+\s*%?[yY]?$")                         # 90.75% / 43.80 / 139.66
R_MONEY      = re.compile(r"^[\d.,]+\s*(美元|元|亿元|万元)")                # 18.9亿美元
R_DATE       = re.compile(r"^\d{4}\s*[-./年]\s*\d{1,2}")                  # 2017.3.13
R_BARE_SEC   = re.compile(r"^(\d{1,2})\s*[.．]\s*(\d)\s*[.．]?\s*$")       # 5.4 / 2. 4（标题丢失）；小数（26.58）不算
R_TITLED_SEC = re.compile(r"^(\d{1,2})\s*[.．]\s*(\d{1,2})\s+\S")          # 5.2 中国工程机械…
R_SEC_PREFIX = re.compile(r"^(\d{1,2})\s*[.．]\s*(\d{1,2})")                # 只用于"节 → 章"归属（允许 2.6补齐… 无空格）
R_BARE_CH    = re.compile(r"^第\s*[\d一二三四五六七八九十]+\s*章$")          # 第2章（标题丢失）
R_FRONT      = re.compile(r"ISBN|定价|www\.|上架建议|编著|出版社|印刷|版次|CIP|书号|版权所有|"
                          r"责任编辑|责任校对|责任印制|封面设计|装订|经销|开\s*本|印张|字数|"
                          r"社总机|邮\s*编|产品编号")
R_EN_FRAG    = re.compile(r"^[A-Za-z][A-Za-z\s.\-]{0,5}$")                # Graw / WQBOK

FRONT_PAGES = 5        # 前置页（封面/版权/目录）页码范围
SHORT_LABEL = 6        # 概念短于该长度 → 可能是表格小标题，标 quality=low 而不删
MIN_CHAPTERS = 3       # 有效章节点少于此数 → 认为章结构缺失，从节号推导


def is_sentence_fragment(lab: str) -> bool:
    """正文句子碎片：句读结尾、长且含逗号、或句号出现在中间。"""
    if re.search(r"[。！？；，：]$", lab):
        return True
    if len(lab) > 24 and "，" in lab:
        return True
    return "。" in lab[:-1]


def is_title_like(lab: str) -> bool:
    """像节标题的短概念（用于恢复裸节号的标题）：长度合适、不含句读、数字/空格很少。"""
    lab = lab.strip()
    if not (6 <= len(lab) <= 30):
        return False
    if re.search(r"[。！？；，]", lab) or lab.endswith("："):
        return False
    if len(re.findall(r"\d", lab)) > 2 or re.search(r"[①-⑩]", lab):
        return False
    if lab.count(" ") > 1:
        return False
    return not (R_FRONT.search(lab) or R_SEC_NUM.match(lab))


def collapse_repeat(lab: str):
    """标题自重复："5.8 A B C A B C 5.8" → "ABC"；无重复返回 None。"""
    core = re.sub(r"^\d{1,2}\s*[.．]\s*\d{0,2}\s*", "", lab)
    core = re.sub(r"\s*\d{1,2}\s*[.．]?\s*\d{0,2}\s*$", "", core)
    t = re.sub(r"\s+", "", core)
    for k in range(len(t) // 2, 3, -1):
        if t[:k] == t[k:2 * k]:
            return t[:k]
    return None


def title_echo(lab: str, title: str) -> bool:
    """前置页里出现的"书名回声"（如 "并购与重组一 中国案例"），判为封面/版权页残留。"""
    for i in range(len(lab) - 3):
        if lab[i:i + 4] in title:
            return True
    return False


def clean_raw(raw: dict, graph_id: str):
    """清洗原始抽取结果 → (清洗后的 raw, 报告)。原始文件不落盘改动。"""
    nodes = [dict(n) for n in raw.get("nodes", [])]
    edges = [dict(e) for e in raw.get("edges", [])]
    by_page = defaultdict(list)
    for n in nodes:
        by_page[n.get("page")].append(n)

    # 第一遍：从"节号 + 标题"（无歧义形式）收集真实章号，用于校验裸节号
    chapter_nums = set()
    for n in nodes:
        if n.get("type") == "section":
            m = R_TITLED_SEC.match(str(n.get("label") or "").strip())
            if m:
                chapter_nums.add(int(m.group(1)))
    # 章号连续性上限：裸节号的章号不得超过"已知最大章号 + 2"（挡掉 14.5 这类表格小数值）
    max_ch = (max(chapter_nums) + 2) if chapter_nums else 0

    dropped, renamed, flags, fixed_repeat = {}, {}, {}, {}
    for n in nodes:
        t = n.get("type")
        lab = str(n.get("label") or "").strip()
        pg = n.get("page")
        if t == "section":
            m_bare = R_BARE_SEC.match(lab)
            rep_core = collapse_repeat(lab)
            if rep_core:
                pre = re.match(r"^(\d{1,2}\s*[.．]\s*\d{0,2})", lab)
                renamed[n["id"]] = (f"{pre.group(1).strip()} {rep_core}" if pre else rep_core)
                fixed_repeat[n["id"]] = renamed[n["id"]]
                continue
            if m_bare:
                # 裸节号：仅当章号可信（该章存在带标题的节）且同页能找到标题样式的概念时才恢复标题
                cands = [c for c in by_page.get(pg, [])
                         if c.get("type") == "concept" and is_title_like(str(c.get("label") or ""))]
                if cands and 1 <= int(m_bare.group(1)) <= max_ch:
                    renamed[n["id"]] = f"{lab} {str(cands[0].get('label')).strip()}"
                else:
                    dropped[n["id"]] = "节·裸节号(标题已丢失)"
            elif R_SEC_NUM.match(lab) or R_MONEY.match(lab) or R_DATE.match(lab):
                dropped[n["id"]] = "节·表格数字/金额/日期"
            elif is_sentence_fragment(lab):
                dropped[n["id"]] = "节·正文句子碎片"
        elif t == "concept":
            if R_FRONT.search(lab):
                dropped[n["id"]] = "概念·版权页字段"
            elif pg is not None and pg <= FRONT_PAGES and len(lab) <= 8:
                dropped[n["id"]] = "概念·前置页短碎片"
            elif pg is not None and pg <= FRONT_PAGES and title_echo(lab, str(raw.get("title") or "")):
                dropped[n["id"]] = "概念·前置页书名回声"
            elif is_sentence_fragment(lab):
                dropped[n["id"]] = "概念·正文句子碎片"
            elif R_EN_FRAG.match(lab) and not lab.isupper():
                dropped[n["id"]] = "概念·英文碎片"
            elif len(re.sub(r"\s+", "", lab)) <= SHORT_LABEL:
                flags[n["id"]] = "low"
        elif t == "chapter":
            if R_BARE_CH.match(lab):
                dropped[n["id"]] = "章·裸章号(标题已丢失)"

    kept_nodes = [n for n in nodes if n["id"] not in dropped]
    new_nodes, new_edges = [], []

    # ---- 章结构缺失时，从"节号 + 标题"推导章（只认 X.Y 后带标题的，避免把小数值当章号）----
    derived = {}
    if sum(1 for n in kept_nodes if n.get("type") == "chapter") < MIN_CHAPTERS:
        by_num = defaultdict(list)
        for n in kept_nodes:
            if n.get("type") != "section":
                continue
            lab = renamed.get(n["id"], str(n.get("label") or "")).strip()
            m = R_TITLED_SEC.match(lab)
            if m:
                by_num[int(m.group(1))].append(n)
        # 补齐："2.6补齐缺失环节…"这类节号后直接接中文（无空格）的节，按节号归章
        assigned = {num: list(secs) for num, secs in by_num.items()}
        for n in kept_nodes:
            if n.get("type") != "section":
                continue
            lab = renamed.get(n["id"], str(n.get("label") or "")).strip()
            m = R_SEC_PREFIX.match(lab)
            num = int(m.group(1)) if m else None
            if num in assigned and n not in assigned[num]:
                assigned[num].append(n)
        for num in sorted(assigned):
            cid = f"chapter_derived_{num:02d}"
            pages = [x.get("page") for x in assigned[num] if x.get("page") is not None]
            derived[num] = {"id": cid, "节数": len(assigned[num])}
            new_nodes.append({"id": cid, "label": f"第{num}章", "type": "chapter",
                              "page": min(pages) if pages else None})
            for x in assigned[num]:
                new_edges.append({"source": cid, "target": x["id"], "relation": "包含章节"})

    for n in kept_nodes:
        if n["id"] in renamed:
            n["label"] = renamed[n["id"]]
        if n["id"] in flags:
            n["quality"] = flags[n["id"]]
    kept_nodes.extend(new_nodes)
    kept_ids = {n["id"] for n in kept_nodes}

    seen, out_edges = set(), []
    for e in edges + new_edges:
        if e.get("source") not in kept_ids or e.get("target") not in kept_ids:
            continue
        if e.get("source") == e.get("target"):
            continue
        key = (e.get("source"), e.get("target"), e.get("relation"))
        if key in seen:
            continue
        seen.add(key)
        out_edges.append(e)

    report = {
        "原始节点": len(nodes), "原始边": len(edges),
        "清洗后节点": len(kept_nodes), "清洗后边": len(out_edges),
        "删除": dropped, "改名": renamed, "标记low": flags, "推导章": derived,
        "修复标题重复": fixed_repeat,
    }
    cleaned = dict(raw)
    cleaned["nodes"] = kept_nodes
    cleaned["edges"] = out_edges
    return cleaned, report


def format_report(graph_id: str, raw: dict, cleaned: dict, rep: dict) -> str:
    """把清洗结果格式化成 markdown 段落（供人工审阅）。"""
    id2label = {n["id"]: str(n.get("label") or "") for n in raw.get("nodes", [])}
    lines = [f"\n## {graph_id} · {str(raw.get('title') or '')[:40]}\n",
             f"- 节点 **{rep['原始节点']} → {rep['清洗后节点']}**，边 {rep['原始边']} → {rep['清洗后边']}"]
    by_rule = defaultdict(list)
    for nid, rule in rep["删除"].items():
        by_rule[rule].append(id2label.get(nid, nid))
    lines.append("\n| 规则 | 删除数 | 样例 |\n|---|---|---|")
    for rule, items in sorted(by_rule.items(), key=lambda x: -len(x[1])):
        sample = "、".join(f"`{s[:24]}`" for s in items[:4])
        lines.append(f"| {rule} | {len(items)} | {sample} |")
    if rep["改名"]:
        lines.append(f"\n**恢复标题的节**（{len(rep['改名'])} 个）：")
        for nid, new in list(rep["改名"].items())[:10]:
            lines.append(f"- `{id2label.get(nid, nid)[:24]}` → `{new[:40]}`")
    if rep.get("修复标题重复"):
        lines.append(f"\n**标题自重复已修复的节**（{len(rep['修复标题重复'])} 个）：")
        for nid, new in list(rep["修复标题重复"].items())[:10]:
            lines.append(f"- `{id2label.get(nid, nid)[:30]}` → `{new[:40]}`")
    if rep["推导章"]:
        lines.append(f"\n**从节号推导出的章**（{len(rep['推导章'])} 个，原标题在抽取时已丢失）：")
        lines.append("、".join(f"第{k}章({v['节数']}节)" for k, v in sorted(rep["推导章"].items())))
    if rep["标记low"]:
        samples = "、".join(f"`{id2label.get(i, i)[:12]}`" for i in list(rep["标记low"])[:15])
        lines.append(f"\n**标 quality=low 的短概念**（{len(rep['标记low'])} 个，节点保留、标签默认不显示，hover 才显示）：{samples}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="生成分层知识图谱")
    parser.add_argument("--src", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "数据"))
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "layered"))
    parser.add_argument("--only", default=None, help="只处理指定 graph_id（逗号分隔），默认全部")
    parser.add_argument("--dry-run", action="store_true", help="只出清洗报告，不写分层文件")
    parser.add_argument("--no-clean", action="store_true", help="跳过清洗（回到原样生成）")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    only = set(args.only.split(",")) if args.only else None
    report_md = ["# 数据清洗报告\n",
                 "由 `scripts/generate_layered_data.py` 自动生成，供人工审阅；"
                 "原始交付文件不改，清洗只作用于分层产物。\n"]
    for graph_id, fname in GRAPH_FILES.items():
        if only and graph_id not in only:
            continue
        path = os.path.join(args.src, fname)
        if not os.path.exists(path):
            print(f"[跳过] {graph_id}: 源文件缺失 {path}")
            continue
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if args.no_clean:
            cleaned, creport = raw, None
        else:
            cleaned, creport = clean_raw(raw, graph_id)
        layered, stats = build_layered(cleaned, graph_id)
        if creport:
            report_md.append(format_report(graph_id, raw, cleaned, creport))
        if args.dry_run:
            print(f"[dry-run] {graph_id} 清洗后预览：{stats}")
            continue
        out_path = os.path.join(args.out, f"{graph_id}_layered.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(layered, f, ensure_ascii=False, indent=1)
        print(f"[OK] {graph_id} -> {out_path}")
        print("     ", stats)

    if not args.no_clean:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, "数据清洗报告.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(report_md))
        print(f"\n清洗报告已写入 数据清洗报告.md" + ("（dry-run，未改分层文件）" if args.dry_run else ""))


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
        item = {
            "id": nid,
            "label": n.get("label") or n.get("name") or nid,
            "type": t,
            "page": n.get("page"),
            "layer": layer,
            "parents": node_parents[nid],
        }
        if n.get("quality"):
            item["quality"] = n["quality"]      # 清洗标记（low = 短词，前端标签默认不显示）
        out_nodes.append(item)

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
