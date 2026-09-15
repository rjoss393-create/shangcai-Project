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
# 这里按规则清洗，命中情况全部写进《文档/记录/数据清洗报告.md》供人工审阅；
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
R_TAIL_NOISE = re.compile(r"[\s①②③④⑤⑥⑦⑧⑨⑩0-9]+$")                      # 标题尾部的页码/序号残留

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


def clean_chapter_label(lab: str) -> str:
    """章名归一化：去尾部印刷页码、合并汉字间空格、统一"第N章 "写法
    （"第20章 理解期权 3" → "第20章 理解期权"；"第31章 并 购" → "第31章 并购"）。"""
    s = re.sub(r"\s+", " ", str(lab or "")).strip()
    s = re.sub(r"\s*\d+\s*$", "", s)
    s = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])", "", s)
    s = re.sub(r"^(第\s*[\d一二三四五六七八九十]+\s*章)\s*", r"\1 ", s)
    return s.strip()


def is_junk_chapter(lab: str) -> bool:
    """正文句子被抽成"章"：含句末标点/冒号、以标点开头、含逗号且较长、或整体过长。"""
    body = re.sub(r"^第\s*[\d一二三四五六七八九十]+\s*章", "", str(lab or "")).strip()
    if re.search(r"[。！？：]", body) or re.match(r"^[，、；：]", body):
        return True
    if re.search(r"[，；]", body) and len(body) > 14:
        return True
    return len(body) > 40


def strip_tail_noise(lab: str) -> str:
    """去掉标题尾部的页码/序号残留（"6.4 武商联：在疲于奔命中成长 4" → 去掉" 4"）。"""
    core = R_TAIL_NOISE.sub("", lab).strip()
    return core if len(core) >= 6 else lab


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

    dropped, renamed, flags, fixed_repeat, trimmed = {}, {}, {}, {}, {}
    id2node = {n["id"]: n for n in nodes}

    # 第一遍之二：章去重合并 + 剔除句读垃圾章（实测：公司金融 139 个"章"里 107 个是页眉重复，
    # 表现为同一章在连续页被抽成多个节点"第20章 理解期权 3/5/7…"；另有正文句子被抽成"章"）。
    # 合并按（归一化章名 + 页码相距 ≤40 页）分组，保留"有子节点者、页码最小者"，其余 id 指向它。
    child_cnt = defaultdict(int)
    for e in edges:
        child_cnt[e["source"]] += 1
    chapter_merge = {}
    groups = []
    for n in sorted((x for x in nodes if x.get("type") == "chapter"),
                    key=lambda x: (x.get("page") if x.get("page") is not None else 10 ** 9)):
        lab = clean_chapter_label(n.get("label"))
        if is_junk_chapter(lab):
            dropped[n["id"]] = "章·正文句子碎片"
            continue
        bk = tuple(sorted(str(x) for x in (n.get("source_books") or [])))
        key = (bk, re.sub(r"\s+", "", lab))
        page = n.get("page") if n.get("page") is not None else 0
        g = next((g for g in groups if g["key"] == key and page - g["pmax"] <= 40), None)
        if g:
            g["ids"].append(n["id"])
            g["pages"][n["id"]] = page
            g["pmax"] = page
        else:
            groups.append({"key": key, "ids": [n["id"]], "pages": {n["id"]: page}, "pmax": page})
    for g in groups:
        keep = max(g["ids"], key=lambda i: (child_cnt.get(i, 0), -g["pages"][i]))
        for i in g["ids"]:
            if i == keep:
                clean = clean_chapter_label(id2node[i].get("label"))
                if clean != str(id2node[i].get("label") or "").strip():
                    renamed[i] = clean
            else:
                chapter_merge[i] = keep
    # 裸章号（"第2章"）并入同号的带标题章（"第2章 资产类别与金融工具"），避免同一章出现两次
    def bk_of(nid):
        return tuple(sorted(str(x) for x in (id2node[nid].get("source_books") or [])))
    titled_no = {}
    for g in groups:
        lab = clean_chapter_label(id2node[g["ids"][0]].get("label"))
        m = re.match(r"^第\s*(\d+)\s*章\s+(.+)$", lab)
        if m:
            titled_no.setdefault((bk_of(g["ids"][0]), int(m.group(1))), g["ids"][0])
    for g in list(groups):
        lab = clean_chapter_label(id2node[g["ids"][0]].get("label"))
        m = re.match(r"^第\s*(\d+)\s*章$", lab)
        key = (bk_of(g["ids"][0]), int(m.group(1))) if m else None
        if key and key in titled_no:
            target = titled_no[key]
            if target not in g["ids"]:
                for i in g["ids"]:
                    chapter_merge[i] = target
                groups.remove(g)

    if chapter_merge or "章·正文句子碎片" in dropped.values():
        drop_ids = set(chapter_merge) | {i for i, r in dropped.items() if r == "章·正文句子碎片"}
        nodes = [n for n in nodes if n["id"] not in drop_ids]
        for e in edges:
            e["source"] = chapter_merge.get(e["source"], e["source"])
            e["target"] = chapter_merge.get(e["target"], e["target"])
        edges = [e for e in edges if e["source"] != e["target"]]

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
            else:
                stripped = strip_tail_noise(lab)
                if stripped != lab:
                    renamed[n["id"]] = stripped
                    trimmed[n["id"]] = stripped
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
        "修复标题重复": fixed_repeat, "清理尾部杂讯": trimmed, "章去重合并": chapter_merge,
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
    if rep.get("章去重合并"):
        lines.append(f"\n**章去重合并**（{len(rep['章去重合并'])} 个重复章并入保留章）：")
        for old, keep in list(rep["章去重合并"].items())[:10]:
            lines.append(f"- `{id2label.get(old, old)[:26]}` → `{id2label.get(keep, keep)[:26]}`")
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
        report_path = os.path.join(root, "文档", "记录", "数据清洗报告.md")
        with open(report_path, "w", encoding="utf-8") as f:
            f.write("\n".join(report_md))
        print(f"\n清洗报告已写入 文档/记录/数据清洗报告.md" + ("（dry-run，未改分层文件）" if args.dry_run else ""))


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
    # ★ 按"来源书"分组：经济综合是四书融合，各书的页码各自从 1 开始，
    #   混在一起按页码归章会串书（实测把并购的 1.1 归到投资学的第1章）。
    def book_of(n):
        b = n.get("source_books")
        if isinstance(b, list):
            return tuple(sorted(str(x) for x in b))
        return (str(b),) if b else ()

    chapter_pages_by_book = defaultdict(list)
    for nid in chapters:
        p = nodes[nid].get("page")
        if p is not None:
            chapter_pages_by_book[book_of(nodes[nid])].append((int(p), nid))
    for _lst in chapter_pages_by_book.values():
        _lst.sort()
    all_chapter_pages = sorted(p for _lst in chapter_pages_by_book.values() for p in _lst)

    def chapter_by_page(page, book=()):
        if page is None or not all_chapter_pages:
            return None
        pages = chapter_pages_by_book.get(tuple(book)) or all_chapter_pages
        for i, (pg, nid) in enumerate(pages):
            end = pages[i + 1][0] if i + 1 < len(pages) else None
            if page >= pg and (end is None or page < end):
                return nid
        # 页码小于第一章：归第一章；大于最后一章：归最后一章
        return pages[0][1] if page < pages[0][0] else pages[-1][1]

    # ---------- 2. parents 计算 ----------
    sec2chap = {}
    chap2secs = defaultdict(list)
    for e in edges:
        if is_type(e["source"], "chapter") and is_type(e["target"], "section"):
            sec2chap.setdefault(e["target"], e["source"])

    for sid in sections:
        chap = sec2chap.get(sid) or chapter_by_page(nodes[sid].get("page"), book_of(nodes[sid]))
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
                cid = chapter_by_page(page, book_of(nodes[mid]))
                if cid:
                    ps = [cid]
                else:
                    orphan_dropped += 1
                    continue
        node_parents[mid] = ps

    # ---------- 2.5 按节号校正 section→章 归属 ----------
    # 原始数据的"包含小节"边可能缺失或挂错（实测：1.1 没有包含边、2.1 被挂到第1章）。
    # 节号 X.Y 的前缀 X 就是章号，用它校正；只在该章号确实存在时生效。
    chapter_no, fixed_parent = defaultdict(list), 0
    for cid in chapters:
        m = re.match(r"^第\s*(\d+)\s*章", str(nodes[cid].get("label") or ""))
        if m:
            chapter_no[(book_of(nodes[cid]), int(m.group(1)))].append(cid)

    def chapter_for(book, num, page, window=60):
        """校正 section→章 归属：
        - 同书同章号唯一（单本书）→ 直接用该章。注意有些书的章节点页码来自目录页（如投资学全在 p10），
          按页码判定会失效，所以唯一时不做页码校验。
        - 章号重复（经济综合=四书融合，每本书都有"第1章"）→ 只在"该号章里唯一一个与本节
          页码相距 ≤60 页"时才认，避免串书；否则不校正（保留原始边归属）。"""
        cands = chapter_no.get((tuple(book), num))
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]
        if page is None:
            return None
        near = [c for c in cands if abs((nodes[c].get("page") or 0) - page) <= window]
        return near[0] if len(near) == 1 else None

    for sid in sections:
        m = re.match(r"^(\d{1,2})\s*[.．]\s*(\d{1,2})", str(nodes[sid].get("label") or "").strip())
        if m:
            cid = chapter_for(book_of(nodes[sid]), int(m.group(1)), nodes[sid].get("page"))
            if cid and node_parents.get(sid) != [cid]:
                node_parents[sid] = [cid]
                fixed_parent += 1

    # ---------- 2.6 跨书父边修正 ----------
    # 融合图里偶见"公司金融的节挂到国际投资学的章"这类跨书父边（原始边错），
    # 一律不可信：改为同一本书内按页找父（节→章；概念→先找节再找章）。
    cross_book_fixed = 0
    for nid, ps in list(node_parents.items()):
        if not ps or ps[0] not in nodes:
            continue
        nb, pb = book_of(nodes[nid]), book_of(nodes[ps[0]])
        if not (nb and pb and nb != pb):
            continue
        page = nodes[nid].get("page")
        if is_type(nid, "section"):
            newp = chapter_by_page(page, nb)
        else:
            same_book_secs = [x for x in sections if book_of(nodes[x]) == nb]
            newp = section_by_page(same_book_secs, nodes, page) or chapter_by_page(page, nb)
        if newp:
            node_parents[nid] = [newp]
            cross_book_fixed += 1

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
        if n.get("source_books"):
            item["source_books"] = n["source_books"]   # 融合图的来源书（排查用）
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

    # 父子边以 parents 为权威（parents 已按节号校正）：
    # ① 删掉与 parents 矛盾的旧边（实测：原始文件把 2.1 挂在第1章）；
    # ② 补上缺失的边（实测：1.1 在原始文件里没有任何包含边，按边查询会漏节点）。
    REL_BY_TYPE = {"section": "包含小节", "concept": "包含概念", "formula": "包含公式"}
    CONTAIN_REL = set(REL_BY_TYPE.values()) | {"包含"}
    pruned_edges, kept_edges = 0, []
    for e in out_edges:
        if e["relation"] in CONTAIN_REL and e["source"] not in node_parents.get(e["target"], []):
            pruned_edges += 1
            continue
        kept_edges.append(e)
    out_edges = kept_edges
    seen_edges = {(e["source"], e["target"], e["relation"]) for e in out_edges}

    added_parent_edges = 0
    for nid, ps in node_parents.items():
        for p in ps:
            rel = REL_BY_TYPE.get(nodes[nid].get("type"), "包含")
            key = (p, nid, rel)
            if key not in seen_edges:
                seen_edges.add(key)
                added_parent_edges += 1
                out_edges.append({"source": p, "target": nid, "relation": rel, "layer": "hier"})

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
        "按节号校正归属": fixed_parent,
        "补齐父子边": added_parent_edges,
        "删除矛盾父子边": pruned_edges,
        "跨书父边修正": cross_book_fixed,
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
