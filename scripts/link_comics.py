# -*- coding: utf-8 -*-
"""把「知识点小漫画」按章挂到课程图谱的知识点节点上（写节点的 media.comic）。

为什么是「章」粒度：
    每部漫画 6 页 = 1 封面 + 4 个知识点页 + 1 小结页，一部对应教材的一个「部分」，
    每页讲的是**教材的一章**（例：`第14章 债券的价格与收益`、`证券交易机制`）。
    而图谱里最细的 micro（知识点）有 535~900 个，漫画只有 96 页 —— 两者不是 1:1。
    所以按「章」挂：章下**所有知识点节点**都拿到本章那一页漫画，点开即看本章图解。
    这也是页面上唯一能显示的地方（点章/节只下钻、不弹详情面板，只有知识点节点弹面板）。

产物（就地改数据文件，幂等）：
    data/media/graphs/course_graph_investment.json          invest 28 章
    data/media/graphs/course_graph_corporate_finance.json   corp_fin 21 章
    data/layered/intl_inv_layered.json                      intl_inv 13 章

挂上去的字段（前端 js/comic-reader.js 消费）：
    node["media"]["comic"] = {album, page, part, part_no, title, section, course}
    album → data/media/comics.json 里的部（6 页图片清单与标题）

⚠️ LINKS 里的章名必须与图谱里的节点名**逐字相同**（见每门课 CHAPTER_LEVEL 说明）；
   对不上会直接报错退出，不会静默漏挂。

用法：
    E:/python/python.exe scripts/link_comics.py
    E:/python/python.exe scripts/link_comics.py --dry-run     # 只出报告，不写文件
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "data", "media", "comics.json")

# 目标图谱：(graph_id, 数据文件, 章所在层, 章名字段, micro 找父的字段)
TARGETS = [
    ("invest", "data/media/graphs/course_graph_investment.json", "meso", "name", "parent_id"),
    ("corp_fin", "data/media/graphs/course_graph_corporate_finance.json", "meso", "name", "parent_id"),
    ("intl_inv", "data/layered/intl_inv_layered.json", "macro", "label", "parents"),
]

# 部 → 4 个知识点页（页序 2/3/4/5）各自对应的**章名列表**（一章可有多页，一页也可覆盖多章）
LINKS: dict[str, list] = {
    # ---------- 博迪《投资学》第10版 → invest ----------
    "inv_p01": ["投资环境", "资产类别与金融工具", "证券交易机制", "共同基金与投资公司"],
    "inv_p02": ["风险与收益基础", "风险资产配置", "最优风险资产组合", "指数模型"],
    "inv_p03": ["资本资产定价模型", "套利定价与多因素模型", "有效市场假说", "行为金融与技术分析"],
    "inv_p04": ["债券价格与收益", "利率期限结构", "债券组合管理", "债券组合管理"],
    "inv_p05": ["宏观与行业分析", "权益估值模型", "权益估值模型", "财务报表分析"],
    "inv_p06": ["期权市场基础", "期权定价", "期权定价", ["期货市场", "期货互换与风险管理"]],
    "inv_p07": ["投资组合业绩评价", ["投资组合业绩评价", "积极型组合管理"],
                "投资组合业绩评价", "对冲基金"],
    "inv_p08": ["国际分散化投资", "国际分散化投资", "投资政策与CFA框架", "投资政策与CFA框架"],
    # ---------- 布雷利《公司金融》第12版 → corp_fin ----------
    "brealey_p01": ["公司金融导论", "现值计算", "资本投资准则", "资本投资准则"],
    "brealey_p02": ["风险与收益", "资产组合与资产定价", "资本成本", "项目分析"],
    "brealey_p03": ["项目分析", "投资战略与经济租金", "项目分析", "代理问题与薪酬"],
    "brealey_p04": ["市场有效性与行为金融", "公司融资与证券发行", "公司融资与证券发行", "公司融资与证券发行"],
    "brealey_p05": ["股利政策", "资本结构", "资本结构", "融资与估值"],
    "brealey_p06": ["期权与实物期权"] * 4,
    "brealey_p07": ["债务融资"] * 4,
    "brealey_p08": ["风险管理"] * 4,
    "brealey_p09": ["财务计划与营运资本"] * 4,
    "brealey_p10": ["并购与公司治理"] * 4,
    "brealey_p11": ["公司金融总结"] * 4,
    # ---------- 《国际投资学》第二版 → intl_inv（旧分层图谱，章在 macro 层） ----------
    "intl_p01": ["第1章 国际投资导论", "第2章 国际投资理论", "第3章 国际投资主体", "第4章 国际投资决策"],
    "intl_p02": ["第5章 国际直接投资方式", "第5章 国际直接投资方式",
                 "第6章 国际间接投资方式", "第7章 灵活的国际投资方式"],
    "intl_p03": ["第8章 国际投资资金筹集", "第9章 国际投资项目管理",
                 "第9章 国际投资项目管理", "第10章 国际投资税收筹划"],
    "intl_p04": ["第11章 国际投资政策法规", "第11章 国际投资政策法规",
                 "第12章 国际直接投资协调", "第12章 国际直接投资协调"],
    "intl_p05": ["第13章 国际投资与中国"] * 4,
}


def _sniff(path: str) -> tuple[int, str]:
    """探出文件原本的缩进与换行，回写时保持一致（避免整文件假差异）"""
    with open(path, "rb") as fh:
        raw = fh.read()
    nl = "\r\n" if raw.count(b"\r\n") else "\n"
    text = raw.decode("utf-8")
    m = re.search(r"\n( +)\"", text)
    indent = len(m.group(1)) if m else 2
    return indent, nl


def _write_json(path: str, obj) -> None:
    indent, nl = _sniff(path)
    text = json.dumps(obj, ensure_ascii=False, indent=indent)
    if nl == "\r\n":
        text = text.replace("\n", "\r\n")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def _chapter_nodes(graph: dict, level: str, name_key: str) -> list[dict]:
    if "nodes" in graph and any("level" in n for n in graph["nodes"][:5]):
        return [n for n in graph["nodes"] if n.get("level") == level]
    return [n for n in graph["nodes"] if n.get("layer") == level]


def _micro_children(graph: dict, chapter_id: str, parent_key: str) -> list[dict]:
    out = []
    for n in graph["nodes"]:
        if n.get("level", n.get("layer")) != "micro":
            continue
        p = n.get(parent_key)
        if parent_key == "parents":
            if isinstance(p, list) and chapter_id in p:
                out.append(n)
        elif p == chapter_id:
            out.append(n)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印报告，不写文件")
    args = ap.parse_args()

    with open(MANIFEST, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    albums = {a["id"]: a for a in manifest["albums"]}

    # 清单里的页信息（页序号 → 标题 / 小节）
    album_pages: dict[str, dict[int, dict]] = {}
    for aid, a in albums.items():
        album_pages[aid] = {p["index"]: p for p in a["pages"]}

    missing_albums = sorted(set(LINKS) - set(albums))
    if missing_albums:
        sys.exit(f"LINKS 里的部在清单中不存在：{missing_albums}")
    unused = sorted(set(albums) - set(LINKS))
    if unused:
        print(f"[提示] 清单里有 {len(unused)} 部没写挂载表：{unused}")

    for graph_id, rel_path, chapter_level, name_key, parent_key in TARGETS:
        path = os.path.join(ROOT, rel_path)
        with open(path, "r", encoding="utf-8") as fh:
            graph = json.load(fh)

        chapters = _chapter_nodes(graph, chapter_level, name_key)
        by_name = {}
        for c in chapters:
            by_name.setdefault(c.get(name_key), c)

        # 1) 先清空本图所有 media.comic（幂等：改过挂载表也不残留旧值）
        cleared = 0
        for n in graph["nodes"]:
            media = n.get("media")
            if isinstance(media, dict) and media.get("comic"):
                media["comic"] = None
                cleared += 1

        # 2) 按章名逐条挂
        want_chapters: set[str] = set()
        resolved = 0
        missing_names: list[str] = []
        albums_here = [a for a in LINKS if albums[a]["course"] == graph_id]

        for aid in albums_here:
            album = albums[aid]
            for slot, target in enumerate(LINKS[aid]):
                page_no = 2 + slot
                page = album_pages[aid][page_no]
                names = target if isinstance(target, list) else [target]
                for name in names:
                    want_chapters.add(name)
                    chapter = by_name.get(name)
                    if chapter is None:
                        missing_names.append(f"{aid} 第{page_no}页 → 「{name}」")
                        continue
                    payload = dict(
                        album=aid,
                        page=page_no,
                        part=album["title"],
                        part_no=album["part"],
                        title=page["title"],
                        section=page["section"],
                        course=graph_id,
                    )
                    kids = _micro_children(graph, chapter["id"], parent_key)
                    for node in kids:
                        media = node.get("media")
                        if not isinstance(media, dict):
                            media = {"video": None, "animation": None, "comic": None}
                            node["media"] = media
                        media["comic"] = payload
                        resolved += 1

        if missing_names:
            sys.exit(f"[{graph_id}] 有章名在图谱里找不到，请核对 LINKS：\n  " + "\n  ".join(missing_names))

        touched = sum(1 for n in graph["nodes"]
                      if isinstance(n.get("media"), dict) and n["media"].get("comic"))
        blank = [c.get(name_key) for c in chapters if c.get(name_key) not in want_chapters]

        print(f"=== {graph_id}（{os.path.basename(rel_path)}）")
        print(f"    章总数 {len(chapters)}｜本次挂载覆盖 {len(want_chapters)} 章"
              f"｜清理旧值 {cleared} 个节点")
        print(f"    获得漫画的知识点节点：{touched}")
        if blank:
            print(f"    暂无漫画的章：{blank}")

        if not args.dry_run and touched:
            _write_json(path, graph)
            print(f"    已写回 {rel_path}")
        elif not args.dry_run:
            print("    无可写内容，跳过")


if __name__ == "__main__":
    main()
