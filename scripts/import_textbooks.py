# -*- coding: utf-8 -*-
"""把根目录 书/ 里的教材转成后端数据：复制到 data/media/textbooks/ 并生成清单。

产物：
    data/media/textbooks/<slug>.<pdf|epub>     后端托管（gitignore，体积大）
    data/media/textbooks.json                  清单（进库），由 /data/textbooks.json 提供

页数 / 章节数 / 文件体积一律从**文件本身**读，不靠人工填；书名与作者用下面的
BOOKS 表做展示用规范化（原始文件名是 z-library 抓取名，含大量垃圾后缀）。

用法：
    E:/python/python.exe scripts/import_textbooks.py
"""
from __future__ import annotations

import json
import os
import shutil
import unicodedata
import zipfile
from datetime import datetime
from xml.etree import ElementTree as ET

from pypdf import PdfReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "书")
DST_DIR = os.path.join(ROOT, "data", "media", "textbooks")
MANIFEST = os.path.join(ROOT, "data", "media", "textbooks.json")

# (原始文件名里的识别串, slug, 中文名, 英文名, 作者, 首版年(不确定填 None), 主题, 一句话说明)
BOOKS = [
    ("an evolutionary theory of economic change", "nelson-winter-1982",
     "经济变迁的演化理论", "An Evolutionary Theory of Economic Change",
     "Richard R. Nelson, Sidney G. Winter", 1982, "技术创新与经济增长",
     "演化经济学的奠基之作，用惯例、搜寻、选择解释技术与产业如何变迁。"),
    ("inside the black box", "rosenberg-1982",
     "黑箱之内：技术与经济学", "Inside the Black Box: Technology and Economics",
     "Nathan Rosenberg", 1982, "技术创新与经济增长",
     "把技术当作内生变量，讲清创新如何发生、为何不以最优方式发生。"),
    ("the lever of riches", "mokyr-1990",
     "财富的杠杆：技术创造力与经济进步", "The Lever of Riches: Technological Creativity and Economic Progress",
     "Joel Mokyr", 1990, "技术创新与经济增长",
     "跨越千年的技术史，回答为什么有的文明持续创新、有的停滞。"),
    ("the gifts of athena", "mokyr-2002",
     "雅典娜的礼物：知识经济的起源", "The Gifts of Athena: Historical Origins of the Knowledge Economy",
     "Joel Mokyr", 2002, "技术创新与经济增长",
     "提出「有用知识」与「工业启蒙」，解释知识存量如何转化为增长。"),
    ("cultures in motion", "rodgers-2014",
     "流动的文化", "Cultures in Motion",
     "Daniel T. Rodgers, Bhavani Raman, Helmut Reimitz (eds.)", 2014, "技术创新与经济增长",
     "从文化流动的视角看观念与制度如何在空间之间传播、杂交与变形。"),
    ("technological revolutions and financial capital", "perez-2002",
     "技术革命与金融资本", "Technological Revolutions and Financial Capital: The Dynamics of Bubbles and Golden Ages",
     "Carlota Perez", 2002, "技术创新与经济增长",
     "技术革命—金融泡沫—黄金时代的周期框架，理解产业与资本市场的共振。"),
    ("the economics of growth", "aghion-howitt-2009",
     "增长经济学", "The Economics of Growth",
     "Philippe Aghion, Peter Howitt", 2009, "技术创新与经济增长",
     "把熊彼特式创新写进增长模型，系统讲清创新、竞争与增长的关系。"),
    ("the rise and fall of american growth", "gordon-2016",
     "美国增长的起落", "The Rise and Fall of American Growth: The U.S. Standard of Living since the Civil War",
     "Robert J. Gordon", 2016, "技术创新与经济增长",
     "用 1870 年以来的生活细节论证：20 世纪那段特殊高增长难以重现。"),
    ("the technology trap", "frey-2019",
     "技术陷阱", "The Technology Trap: Capital, Labor, and Power in the Age of Automation",
     "Carl Benedikt Frey", 2019, "技术创新与经济增长",
     "从工业革命看自动化与就业，讲清技术进步为何会先带来阵痛。"),
    ("deuxieme age de la machine", "brynjolfsson-2014-fr",
     "第二次机器革命（法文版）", "Le Deuxième Âge de la machine (The Second Machine Age)",
     "Erik Brynjolfsson, Andrew McAfee", 2014, "技术创新与经济增长",
     "数字化技术如何重塑生产率、就业与收入分配（法文译本，正文为法文）。"),
    ("the economics of artificial intelligence", "agrawal-2019",
     "人工智能经济学", "The Economics of Artificial Intelligence: An Agenda",
     "Ajay Agrawal, Joshua Gans, Avi Goldfarb (eds.)", 2019, "技术创新与经济增长",
     "AI 作为「预测成本下降」的技术，对劳动、竞争与政策意味着什么。"),
    ("power and progress", "acemoglu-2023",
     "权力与进步", "Power and Progress: Our Thousand-Year Struggle Over Technology and Prosperity",
     "Daron Acemoglu, Simon Johnson", 2023, "技术创新与经济增长",
     "技术本身不保证共享繁荣，取决于权力结构与社会选择。"),
    ("the power of creative destruction", "aghion-2021",
     "创造性破坏的力量", "The Power of Creative Destruction: Economic Upheaval and the Wealth of Nations",
     "Philippe Aghion, Céline Antonin, Simon Bunel", 2021, "技术创新与经济增长",
     "用「创造性破坏」串起增长、不平等、竞争政策与社会流动。"),
    ("grow the pie", "edmans-2020",
     "把饼做大", "Grow the Pie: How Great Companies Deliver Both Purpose and Profit",
     "Alex Edmans", 2020, "公司治理与战略",
     "用实证回应「企业目的 vs 股东利润」之争：长期价值来自做大价值总量。"),
    ("strategic management - a stakeholder approach", "freeman-1984",
     "战略管理：利益相关者方法", "Strategic Management: A Stakeholder Approach",
     "R. Edward Freeman", 1984, "公司治理与战略",
     "利益相关者理论的源头，重构了「企业为谁而经营」的框架。"),
    ("applied mergers and acquisitions", "bruner-2004",
     "应用兼并与收购", "Applied Mergers and Acquisitions",
     "Robert F. Bruner", 2004, "并购重组",
     "并购实务的系统教程：估值、交易结构、谈判、整合与失败教训。"),
    ("mergers, acquisitions, and corporate restructurings", "gaughan-ma",
     "兼并与收购及公司重组", "Mergers, Acquisitions, and Corporate Restructurings",
     "Patrick A. Gaughan", None, "并购重组",
     "并购与重组的全景教材：法律、监管、会计、估值与实证证据。"),
    ("takeovers, restructuring, and corporate governance", "weston-takeovers",
     "接管、重组与公司治理", "Takeovers, Restructuring, and Corporate Governance",
     "J. Fred Weston, Mark L. Mitchell, J. Harold Mulherin", None, "并购重组",
     "从公司治理视角讲接管与重组，是美国并购研究的经典参考。"),
    ("mergers, acquisitions, and other restructuring activities", "depamphilis-ma",
     "兼并与收购及其他重组活动", "Mergers, Acquisitions, and Other Restructuring Activities",
     "Donald M. DePamphilis", None, "并购重组",
     "以流程为主线讲并购全生命周期，案例与实务工具最全的一本。"),
    ("融资、并购与公司控制", "zhousheng-rongzi-binggou",
     "融资、并购与公司控制（第2版）", "",
     "周春生", None, "并购重组",
     "中文教材视角：融资决策、并购交易与公司控制权安排的中国实践。"),

    # ---- 2026-09-23 第二批 12 本（文件名里的空格被去掉了，匹配靠 norm() 压缩后做子串）----
    ("models of bounded rationality", "simon-bounded-rationality",
     "有限理性模型：经济分析与公共政策", "Models of Bounded Rationality: Economic Analysis and Public Policy",
     "Herbert A. Simon", None, "思想与决策基础",
     "有限理性与满意化决策的论文集，行为经济学与组织理论的源头之一。"),
    ("the kelly capital growth investment criterion", "kelly-capital-growth",
     "凯利资本增长投资准则：理论与实践", "The Kelly Capital Growth Investment Criterion: Theory and Practice",
     "Leonard C. MacLean, Edward O. Thorp, William T. Ziemba (eds.)", None, "投资与资产管理",
     "把凯利公式从赌局推广到长期资产配置，讲清对数最优与下注比例的取舍。"),
    ("machine learning in asset pricing", "nagel-ml-asset-pricing",
     "资产定价中的机器学习", "Machine Learning in Asset Pricing",
     "Stefan Nagel", 2021, "投资与资产管理",
     "用机器学习方法做资产定价的实证入门：如何避免过拟合与「伪因子」。"),
    ("machine learning for asset managers", "lopezdeprado-ml-asset-managers",
     "面向资产管理者的机器学习", "Machine Learning for Asset Managers",
     "Marcos M. López de Prado", 2020, "投资与资产管理",
     "面向从业者的精简读本：特征提取、聚类、去噪与组合构建的实操方法。"),
    ("the second machine age", "second-machine-age-en",
     "第二次机器革命", "The Second Machine Age: Work, Progress, and Prosperity in a Time of Brilliant Technologies",
     "Erik Brynjolfsson, Andrew McAfee", 2014, "技术创新与经济增长",
     "英文原版（书架里另有一本法文译本）：数字化技术如何重塑生产率、就业与收入分配。"),
    ("firms, contracts, and financial structure", "hart-1995-firms",
     "企业、契约与财务结构", "Firms, Contracts, and Financial Structure",
     "Oliver Hart", 1995, "公司治理与战略",
     "不完全契约与剩余控制权的经典专著，公司治理与资本结构理论的基石。"),
    ("individualism and economic order", "hayek-individualism",
     "个人主义与经济秩序", "Individualism and Economic Order",
     "F. A. Hayek", 1948, "思想与决策基础",
     "分散知识、自发秩序与市场过程的经典文集，奥地利学派的方法论宣言。"),
    ("cybernetic revolutionaries", "medina-cybernetic-revolutionaries",
     "控制论革命者：智利阿连德时期的技术与政治", "Cybernetic Revolutionaries: Technology and Politics in Allende's Chile",
     "Eden Medina", 2011, "技术创新与经济增长",
     "以 Cybersyn 项目为切口，讲技术设计与政治制度如何相互塑造。"),
    ("why information grows", "hidalgo-why-information-grows",
     "信息为何增长：从原子到经济的秩序演化", "Why Information Grows: The Evolution of Order, from Atoms to Economies",
     "César Hidalgo", 2015, "技术创新与经济增长",
     "用「信息/知识如何被固化进物质」解释经济增长与产业复杂度。"),
    ("information rules", "shapiro-varian-information-rules",
     "信息规则：网络经济的策略指导", "Information Rules: A Strategic Guide to the Network Economy",
     "Carl Shapiro, Hal R. Varian", 1998, "技术创新与经济增长",
     "信息产品的定价、锁定与标准竞争——网络经济学的奠基读物。"),
    ("gdp a brief but affectionate history", "coyle-gdp",
     "GDP：一段简史", "GDP: A Brief but Affectionate History",
     "Diane Coyle", 2014, "思想与决策基础",
     "GDP 这个指标怎么来的、量到了什么、又漏掉了什么。"),
    ("the structure of scientific revolutions", "kuhn-scientific-revolutions",
     "科学革命的结构（50 周年纪念版）", "The Structure of Scientific Revolutions",
     "Thomas S. Kuhn", 1962, "思想与决策基础",
     "范式、常规科学与科学革命——研究方法的元问题，也是「知识图谱」的思想背景。"),
]

LANG_BY_SUFFIX = {"-fr": "fr", "zhousheng": "zh"}


def norm(text: str) -> str:
    """比对文件名用：去掉重音、转小写、**去掉所有非字母数字字符**。

    - 不能直接 ascii-ignore，那会把中文书名整个抹掉；只丢组合附加符号。
    - 还要把空格/下划线/标点一起去掉：后加的那批 z-library 文件名把空格都省了
      （`MachineLearninginAssetPricing`），带空格的识别串会匹配不上。
      Python 里 `str.isalnum()` 对中日韩汉字返回 True，所以中文书名不受影响。
    """
    decomposed = unicodedata.normalize("NFKD", text)
    kept = (ch for ch in decomposed if not unicodedata.combining(ch))
    return "".join(ch for ch in kept if ch.isalnum()).lower()


def pdf_info(path: str) -> dict:
    """从 PDF 本身读页数与文档元数据"""
    info: dict = {"pages": None, "meta_title": None, "meta_author": None}
    try:
        reader = PdfReader(path)
        info["pages"] = len(reader.pages)
        meta = reader.metadata or {}
        info["meta_title"] = (meta.get("/Title") or None)
        info["meta_author"] = (meta.get("/Author") or None)
    except Exception as e:                                   # noqa: BLE001
        print(f"    ! 读 PDF 失败：{e}")
    return info


EPUB_NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def epub_info(path: str) -> dict:
    """从 EPUB 的 OPF 里读书名/作者/语言/章节数（zipfile + ElementTree，不依赖第三方库）"""
    info: dict = {"chapters": None, "meta_title": None, "meta_author": None, "meta_lang": None}
    try:
        with zipfile.ZipFile(path) as z:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            opf_path = container.find(
                ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
            ).get("full-path")
            opf = ET.fromstring(z.read(opf_path))
            info["meta_title"] = (opf.findtext("opf:metadata/dc:title", namespaces=EPUB_NS) or None)
            info["meta_author"] = (opf.findtext("opf:metadata/dc:creator", namespaces=EPUB_NS) or None)
            info["meta_lang"] = (opf.findtext("opf:metadata/dc:language", namespaces=EPUB_NS) or None)
            info["chapters"] = len(opf.findall(".//opf:spine/opf:itemref", namespaces=EPUB_NS))
    except Exception as e:                                   # noqa: BLE001
        print(f"    ! 读 EPUB 失败：{e}")
    return info


def main() -> None:
    if not os.path.isdir(SRC_DIR):
        raise SystemExit(f"源目录不存在：{SRC_DIR}")
    os.makedirs(DST_DIR, exist_ok=True)

    src_files = [f for f in os.listdir(SRC_DIR) if not f.startswith(".")]
    used: set[str] = set()
    books = []

    for keyword, slug, title_cn, title_en, author, year, topic, intro in BOOKS:
        # 两边都要过 norm()：norm 会把空格/标点一起消掉，只归一化文件名就会匹配不上
        key = norm(keyword)
        hits = [f for f in src_files if key in norm(f) and f not in used]
        if not hits:
            raise SystemExit(f"在 书/ 里找不到匹配「{keyword}」的文件")
        if len(hits) > 1:
            raise SystemExit(f"「{keyword}」匹配到多个文件：{hits}")
        src_name = hits[0]
        used.add(src_name)

        ext = os.path.splitext(src_name)[1].lower().lstrip(".")
        if ext not in ("pdf", "epub"):
            raise SystemExit(f"不支持的格式：{src_name}")
        dst_name = f"{slug}.{ext}"
        src_path = os.path.join(SRC_DIR, src_name)
        dst_path = os.path.join(DST_DIR, dst_name)

        size = os.path.getsize(src_path)
        print(f"[{slug}] {dst_name}  {size / 1024 / 1024:.1f} MB  <= {src_name[:60]}…")

        extra = pdf_info(src_path) if ext == "pdf" else epub_info(src_path)
        if not os.path.exists(dst_path) or os.path.getsize(dst_path) != size:
            shutil.copy2(src_path, dst_path)
            print("    已复制")
        else:
            print("    已是最新，跳过复制")

        lang = "en"
        for key, val in LANG_BY_SUFFIX.items():
            if key in slug:
                lang = val
        if extra.get("meta_lang"):
            lang = extra["meta_lang"][:2].lower() or lang

        entry = {
            "id": slug,
            "file": dst_name,
            "type": ext,
            "url": f"/assets/textbooks/{dst_name}",
            "titleCn": title_cn,
            "titleEn": title_en,
            "author": author,
            "year": year,
            "topic": topic,
            "intro": intro,
            "lang": lang,
            "sizeMB": round(size / 1024 / 1024, 1),
            "srcFile": src_name,
        }
        entry.update({k: v for k, v in extra.items() if not k.startswith("meta_")})
        books.append(entry)
        print(f"    页数/章节={entry.get('pages') or entry.get('chapters')}  语言={lang}")

    missing = sorted(set(src_files) - used)
    if missing:
        print("\n⚠️  书/ 里还有未纳入的文件：")
        for m in missing:
            print(f"    {m}")

    manifest = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "根目录 书/",
        "count": len(books),
        "totalMB": round(sum(b["sizeMB"] for b in books), 1),
        "books": books,
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n清单已写入：{MANIFEST}")
    print(f"共 {manifest['count']} 本，合计 {manifest['totalMB']} MB")
    print(f"PDF {sum(1 for b in books if b['type'] == 'pdf')} 本 / "
          f"EPUB {sum(1 for b in books if b['type'] == 'epub')} 本")


if __name__ == "__main__":
    main()
