# -*- coding: utf-8 -*-
"""把根目录 知识点小漫画/ 里的三个 PDF 拆成后端数据：按「部」导出图片 + 生成清单。

产物：
    data/media/comics/<dir>/<album>_<n>.jpg    后端托管（进库，22MB）
    data/media/comics.json                     清单（进库），由 /data/comics.json 提供

源文件是**扫描/排版图**：每页恰好一张 JPEG（DCTDecode，1024×1536），没有文字层。
所以这里直接取内嵌图的原始字节，不重新编码（零画质损失、零体积膨胀）。

每「部」固定 6 页：
    第 1 页  封面（部标题 + 副标题 + 4 个关键词条）
    第 2~5 页 知识点页（页首编号 1~4 + 页标题 + 页内小节标题）
    第 6 页  今日知识收获（4 张小结卡）

页标题、部标题、关键词条都是**人工从图上读出来的**（无文字层，无法自动抽取），
硬编码在下面的 ALBUMS 表里；页数与图片尺寸从文件本身读，不靠人工填。

⚠️ 表里的 parts/points 顺序必须与 PDF 里的物理页序一致 —— 图谱挂载
（scripts/link_comics.py）按「部 + 页序号」定位，顺序错了就整体错位。

用法：
    E:/python/python.exe scripts/import_comics.py
"""
from __future__ import annotations

import json
import os
from datetime import datetime

from pypdf import PdfReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "知识点小漫画")
DST_DIR = os.path.join(ROOT, "data", "media", "comics")
MANIFEST = os.path.join(ROOT, "data", "media", "comics.json")

PAGES_PER_PART = 6

# 源 PDF：(文件名, 目录/课程短码)
SOURCES = [
    ("合集_bodi_8部48页.pdf", "inv", "invest", "投资学", "博迪《投资学》第10版"),
    ("合集_brealey_11部66页.pdf", "brealey", "corp_fin", "公司金融", "布雷利《公司金融》第12版"),
    ("合集_intl_5部30页.pdf", "intl", "intl_inv", "国际投资学", "《国际投资学》第二版"),
]

# 每部：部标题 / 副标题 / 封面关键词条 / 4 个知识点页的 (页标题, 页内小节标题)
ALBUMS: dict[str, list[dict]] = {
    "inv": [
        dict(title="绪论：什么是投资", subtitle="金融资产与实物资产",
             chips=["投资环境", "资产类别", "证券交易", "共同基金"],
             points=[("实物资产与金融资产", "投资的定义"), ("资产类别全景", None),
                     ("证券如何交易", "交易机制关键词"), ("共同基金 vs ETF", None)]),
        dict(title="组合理论与实践", subtitle="风险与收益的权衡",
             chips=["风险收益", "资产配置", "马科维茨", "指数模型"],
             points=[("风险与收益入门", None), ("风险厌恶与资产配置", "资本配置决策"),
                     ("马科维茨组合选择", None), ("单指数模型", None)]),
        dict(title="资本市场均衡", subtitle="CAPM·APT·有效市场·行为",
             chips=["CAPM", "APT", "有效市场", "行为金融"],
             points=[("CAPM 资本资产定价模型", None), ("APT 与多因子模型", "套利定价理论"),
                     ("有效市场假说 EMH", None), ("行为金融的批评", "三大批评与异象")]),
        dict(title="固定收益证券", subtitle="债券的世界",
             chips=["债券定价", "期限结构", "久期凸性", "债券管理"],
             points=[("债券的价格与收益", None), ("利率的期限结构", "收益率曲线"),
                     ("久期与凸性", None), ("被动 vs 主动债券管理", None)]),
        dict(title="证券分析", subtitle="从宏观到个股",
             chips=["行业分析", "股利贴现", "市盈率", "财报分析"],
             points=[("自上而下的分析", None), ("股利贴现模型 DDM", None),
                     ("市盈率与相对估值", "市盈率 PE 的两面"), ("财务报表分析", "三张表与 ROE 分解")]),
        dict(title="期权与期货", subtitle="衍生工具的世界",
             chips=["期权策略", "平价关系", "BS 公式", "期货互换"],
             points=[("期权合约与策略", "基本头寸"), ("平价关系与 BS 公式", None),
                     ("二叉树定价", None), ("期货与互换", None)]),
        dict(title="业绩评价与积极管理", subtitle="谁在真创造价值",
             chips=["夏普比率", "选股择时", "特雷纳-布莱克", "对冲基金"],
             points=[("风险调整后的业绩", None), ("选股与择时能力", "怎么检验"),
                     ("特雷纳-布莱克模型", None), ("对冲基金与另类策略", "对冲基金的特点")]),
        dict(title="全球投资与政策", subtitle="视野决定组合",
             chips=["国际分散化", "汇率风险", "投资政策", "资产配置"],
             points=[("投资的国际分散化", "为什么要全球化"), ("汇率与收益分解", None),
                     ("投资政策声明 IPS", None), ("全书收官：投资清单", "从绪论到全球的地图")]),
    ],
    "brealey": [
        dict(title="价值", subtitle="现值·NPV·投资准则",
             chips=["公司目标", "现值", "NPV", "投资准则"],
             points=[("公司金融的目标", "财务经理的三大决策"), ("现值与净现值", None),
                     ("投资准则大家族", None), ("NPV vs IRR vs 回收期", None)]),
        dict(title="风险", subtitle="组合·CAPM·资本成本",
             chips=["风险收益", "组合理论", "CAPM", "资本成本"],
             points=[("风险与收益导论", "两组基本事实"), ("组合理论与 CAPM", None),
                     ("资本成本怎么算", None), ("公司风险 vs 项目风险", None)]),
        dict(title="资本预算的最佳实践", subtitle="项目分析·经济租金·代理",
             chips=["项目分析", "经济租金", "盈亏平衡", "代理问题"],
             points=[("项目分析的现金流陷阱", "六大陷阱"), ("经济租金与竞争优势", None),
                     ("不确定性的三面镜子", None), ("代理问题与激励机制", None)]),
        dict(title="融资决策与市场有效性", subtitle="EMH·融资全景·发行",
             chips=["有效市场", "行为金融", "融资综述", "IPO"],
             points=[("有效市场假说（公司视角）", "三种有效形态"), ("公司如何发行证券", None),
                     ("四种发行方式对比", None), ("公司融资综述", None)]),
        dict(title="股利政策与资本结构", subtitle="MM·权衡·优序融资",
             chips=["股利回购", "MM定理", "权衡理论", "APV"],
             points=[("股利政策：分还是回购？", "两种返还方式"), ("MM 定理：负债无关论", None),
                     ("权衡理论 vs 优序融资", None), ("WACC 法 vs APV 法", None)]),
        dict(title="期权", subtitle="从金融期权到实物期权",
             chips=["看涨看跌", "BS公式", "风险中性", "实物期权"],
             points=[("理解期权", "期权的两面"), ("期权估值", None),
                     ("实物期权：柔性就是钱", None), ("二叉树与风险中性", None)]),
        dict(title="债务融资", subtitle="信用风险·债券品种·租赁",
             chips=["信用风险", "债券品种", "可转债", "租赁"],
             points=[("信用风险与公司债价值", "信用风险三要素"), ("债券品种万花筒", None),
                     ("租赁 vs 借款购买", None), ("久期与利率风险", None)]),
        dict(title="风险管理", subtitle="对冲工具与国际风险",
             chips=["为什么要对冲", "期货互换", "汇率风险", "政治风险"],
             points=[("为什么要管理风险", "公司对冲的四大理由"), ("对冲工具箱", None),
                     ("汇率风险与利率平价", None), ("政治风险与治理风险", None)]),
        dict(title="财务分析与营运资本", subtitle="比率·计划·现金周期",
             chips=["财务比率", "可持续增长", "现金周期", "短期融资"],
             points=[("财务比率体系", "三大类比率"), ("可持续增长率", None),
                     ("营运资本与现金周期", None), ("长期 vs 短期融资", None)]),
        dict(title="并购、公司控制与治理", subtitle="协同·防御·治理模式",
             chips=["并购动机", "协同效应", "防御措施", "公司治理"],
             points=[("并购的动机与幻觉", "合理动机"), ("并购的价值账本", None),
                     ("并购攻防战", None), ("两大治理模式", None)]),
        dict(title="结论：已知与未知", subtitle="财务的确定与争议",
             chips=["可靠结论", "争议地带", "金融箴言", "收官"],
             points=[("财务学的确定地带", "经过验证的基石"), ("争议地带", None),
                     ("公司金融全图", None), ("五条金融箴言", None)]),
    ],
    "intl": [
        dict(title="国际投资基础", subtitle="概念·理论·主体·决策",
             chips=["国际投资", "理论谱系", "跨国公司", "环境评估"],
             points=[("国际投资的概念与分类", "核心概念"), ("国际直接投资理论谱系", None),
                     ("跨国公司：投资主体", "跨国公司概览"), ("投资环境评估方法", None)]),
        dict(title="国际投资方式", subtitle="直接·间接·灵活方式",
             chips=["独资合资", "国际证券", "租赁承包", "风险投资"],
             points=[("直接投资三大形式", None), ("直接投资与非股权安排", "绿地 vs 并购"),
                     ("国际间接投资", "三大间接渠道"), ("灵活的国际投资方式", None)]),
        dict(title="国际投资管理", subtitle="筹资·项目·税收",
             chips=["国际筹资", "项目周期", "可行性研究", "税收筹划"],
             points=[("国际投资资金筹集", "筹资渠道"), ("国际项目管理周期", None),
                     ("国际项目的财务评估", None), ("国际税收筹划", "国际税收核心问题")]),
        dict(title="国际投资政策与协调", subtitle="法规·协定·争端解决",
             chips=["准入政策", "双边协定", "多边机制", "争端解决"],
             points=[("东道国的政策法规", "政策工具箱"), ("双边、区域与多边协定", None),
                     ("投资争端解决路径", None), ("国际直接投资协调", "协调的层次")]),
        dict(title="中国与国际投资", subtitle="引进来·走出去·证券开放",
             chips=["利用外资", "对外投资", "一带一路", "市场开放"],
             points=[("中国利用外商直接投资", "历程三阶段"), ("三资企业对比", None),
                     ("中国对外投资（走出去）", None), ("中国证券市场开放", "开放四通道")]),
    ],
}


def _extract_pages(pdf_path: str) -> list[bytes]:
    """逐页取内嵌图的原始字节（源 PDF 每页恰好一张 JPEG）"""
    reader = PdfReader(pdf_path)
    out: list[bytes] = []
    for idx, page in enumerate(reader.pages, 1):
        xobj = page["/Resources"]["/XObject"].get_object()
        keys = list(xobj.keys())
        if len(keys) != 1:
            raise RuntimeError(f"{os.path.basename(pdf_path)} 第 {idx} 页内嵌对象数异常: {keys}")
        img = xobj[keys[0]].get_object()
        if img.get("/Filter") != "/DCTDecode":
            raise RuntimeError(f"{os.path.basename(pdf_path)} 第 {idx} 页非 JPEG: {img.get('/Filter')}")
        raw = img._data if hasattr(img, "_data") else img.get_data()
        out.append(bytes(raw))
    return out


def main() -> None:
    os.makedirs(DST_DIR, exist_ok=True)
    albums_meta: list[dict] = []
    total_pages = 0

    for file_name, dir_name, course, course_label, book in SOURCES:
        pdf_path = os.path.join(SRC_DIR, file_name)
        if not os.path.exists(pdf_path):
            raise SystemExit(f"源文件缺失：{pdf_path}")

        pages = _extract_pages(pdf_path)
        parts = ALBUMS[dir_name]
        expect = len(parts) * PAGES_PER_PART
        if len(pages) != expect:
            raise SystemExit(f"{file_name} 页数 {len(pages)} ≠ 表里 {len(parts)} 部 × {PAGES_PER_PART}")

        out_dir = os.path.join(DST_DIR, dir_name)
        os.makedirs(out_dir, exist_ok=True)

        for p_idx, part in enumerate(parts, 1):
            album_id = f"{dir_name}_p{p_idx:02d}"
            base = (p_idx - 1) * PAGES_PER_PART
            files: list[str] = []
            for n in range(1, PAGES_PER_PART + 1):
                fname = f"{album_id}_{n}.jpg"
                with open(os.path.join(out_dir, fname), "wb") as fh:
                    fh.write(pages[base + n - 1])
                files.append(fname)

            page_meta = [dict(index=1, role="cover", title=part["title"], section=part["subtitle"])]
            for k, (pt, sec) in enumerate(part["points"]):
                page_meta.append(dict(index=k + 2, role="point", title=pt, section=sec))
            page_meta.append(dict(index=PAGES_PER_PART, role="summary",
                                  title="今日知识收获", section=None))

            albums_meta.append(dict(
                id=album_id,
                course=course,
                course_label=course_label,
                book=book,
                part=p_idx,
                title=part["title"],
                subtitle=part["subtitle"],
                chips=part["chips"],
                dir=f"/assets/comics/{dir_name}",
                files=files,
                pages=page_meta,
                source_file=file_name,
            ))
            total_pages += PAGES_PER_PART

    manifest = dict(
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        source_dir="知识点小漫画/",
        asset_root="/assets/comics",
        pages_per_part=PAGES_PER_PART,
        total_albums=len(albums_meta),
        total_pages=total_pages,
        note="每部 6 页：1 封面 / 2-5 知识点 / 6 小结。页标题为人工读图录入（源文件无文字层）。",
        albums=albums_meta,
    )
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    size = sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(DST_DIR) for f in fs)
    print(f"导出 {len(albums_meta)} 部 / {total_pages} 页 → {DST_DIR}（{size / 1024 / 1024:.1f} MB）")
    print(f"清单 → {MANIFEST}")
    for course in ("invest", "corp_fin", "intl_inv"):
        n = sum(1 for a in albums_meta if a["course"] == course)
        print(f"  {course}: {n} 部")


if __name__ == "__main__":
    main()
