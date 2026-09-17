"""数据层 · 视频导入脚本

把 数据/ 下的课程视频复制到前端静态目录并生成清单：

- 视频 -> 前端/SUFE-Knowledge-Galaxy/assets/videos/01.mp4 ~ NN.mp4
  （金融理论 Andrew Lo P1-P23 = 01-23；耶鲁公开课 Shiller = 24-45；
   吴恩达 AI for everyone P1-P35 = 46-80）
- 清单 -> 前端/SUFE-Knowledge-Galaxy/data/videos.json
  （前端学习资料区读取：videos 数组 + carousel 推荐 id）

用法：python scripts/import_videos.py [--src 源目录]
"""
import argparse
import glob
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DEFAULT = os.path.join(ROOT, "数据")
OUT_DIR = os.path.join(ROOT, "前端", "SUFE-Knowledge-Galaxy", "assets", "videos")
MANIFEST_PATH = os.path.join(ROOT, "前端", "SUFE-Knowledge-Galaxy", "data", "videos.json")


def collect_entries(src: str):
    """扫描源目录，返回 [(编号, 源路径, 标题, 作者, 标签, 简介)] 按编号排序。"""
    entries = []

    # ---- 金融理论（Andrew Lo）：P1-P23 ----
    lo_paths = []
    for sub in ("金融理论上", "金融理论中", "金融理论下"):
        lo_paths += glob.glob(os.path.join(src, sub, "*.MP4"))
    lo_paths += glob.glob(os.path.join(src, "金融理论-*.MP4"))
    for p in lo_paths:
        name = os.path.basename(p)
        m = re.search(r"P(\d+)\s*(.+)$", name)
        if not m:
            continue
        n = int(m.group(1))
        topic = m.group(2)
        topic = re.sub(r"BV.*$", "", topic, flags=re.I)           # 去掉视频平台编号尾巴（短横线可能是全角）
        topic = re.sub(r"\.MP4$", "", topic, flags=re.I).strip(" -–—._")
        if not topic:
            topic = name
        entries.append((n, p, f"第{n}讲 {topic}", "罗闻全（Andrew Lo）", ["课程", "外语"],
                        f"MIT 金融理论课程第 {n} 讲：{topic}"))

    # ---- 耶鲁大学公开演讲（Robert Shiller）：排在金融理论之后，编号连续（24 起）----
    shiller_paths = []
    for sub in ("耶鲁大学公开演讲（上）", "耶鲁大学公开演讲（下）"):
        shiller_paths += glob.glob(os.path.join(src, sub, "*.MP4"))
    shiller_items = []
    for p in shiller_paths:
        name = os.path.basename(p)
        m = re.search(r"P(\d+)\s*(.+)$", name)
        if not m:
            continue
        n = int(m.group(1))
        topic = m.group(2)
        topic = re.sub(r"\.MP4$", "", topic, flags=re.I).strip(" -–—._")
        topic = re.sub(r"^第\d+课[：:]\s*", "", topic)            # 标题里不再重复"第N课"
        if not topic:
            topic = name
        shiller_items.append((n, p, topic))
    shiller_items.sort(key=lambda x: x[0])
    for i, (n, p, topic) in enumerate(shiller_items):
        base = 24 + i  # 与 P 编号无关，按顺序连续编号，避免源文件缺集导致空洞
        entries.append((base, p, f"第{n}课 {topic}", "罗伯特·希勒（Robert J. Shiller）",
                        ["演讲", "外语"], f"耶鲁大学公开课《金融市场》第 {n} 课：{topic}"))

    # ---- 吴恩达《AI for everyone》给所有人的AI课：排在最后（46 起）----
    # 源文件无逐讲主题（文件名只有 P1-P35），故标题只保留讲次
    ai_items = []
    for p in glob.glob(os.path.join(src, "AI For Everyone", "*.mp4")):
        m = re.search(r"P(\d+)", os.path.basename(p))
        if not m:
            continue
        ai_items.append((int(m.group(1)), p))
    ai_items.sort(key=lambda x: x[0])
    for i, (n, p) in enumerate(ai_items):
        base = 46 + i  # 按讲次顺序连续编号
        entries.append((base, p, f"第{n}讲 给所有人的 AI 课", "吴恩达（Andrew Ng）",
                        ["课程", "人工智能"],
                        f"deeplearning.ai《AI for everyone》第 {n} 讲（中英字幕）：面向所有人的 AI 通识课"))

    entries.sort(key=lambda x: x[0])
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description="导入课程视频到前端静态目录并生成清单")
    parser.add_argument("--src", default=SRC_DEFAULT)
    args = parser.parse_args()

    entries = collect_entries(args.src)
    if not entries:
        print("未找到任何视频文件")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    videos = []
    for num, src_path, title, author, tags, desc in entries:
        no = f"{num:02d}"
        dst = os.path.join(OUT_DIR, f"{no}.mp4")
        if os.path.abspath(src_path) != os.path.abspath(dst) and not os.path.exists(dst):
            shutil.copy2(src_path, dst)
            print(f"[OK] {no}.mp4 <- {os.path.basename(src_path)}")
        videos.append({
            "title": title,
            "author": author,
            "tags": tags,
            "views": "",
            "date": "",
            "desc": desc,
        })

    manifest = {"carousel": [1, 3, 7, 11, 14], "videos": videos}
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n共导入 {len(videos)} 个视频，清单已写入 {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
