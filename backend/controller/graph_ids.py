"""统一 graph_id 编码表（控制层 / 前端 / Agent 层 / Service 层共享的约定）

规则：
- 小写英文短码，只含 [a-z0-9_]，与书名措辞解耦（书再版改名 ID 不变）；
- 图谱版本信息不进 ID（json 里有 version 字段）；
- 新增图谱只加行、永不改已有值（保证历史缓存/会话不失效）；
- 各实现方按此表硬编码同一份值，收到后只做字典键使用，不做解析。
"""
from typing import Final

# graph_id -> 图谱名称（展示/日志用）
# 4 本书 + 经济综合（经济综合为四书融合图谱）+ v6 统一知识星系（前端 v6 星系引擎数据）；
# 分层文件见 data/layered/
GRAPH_IDS: Final[dict[str, str]] = {
    "ma": "并购与重组",
    "corp_fin": "公司金融",
    "intl_inv": "国际投资学",
    "invest": "投资学",
    "econ": "经济综合",
    "v6": "统一知识星系（v6）",
    "v12": "统一知识星系（v12）",
}

# graph_id -> 数据文件（供数据层/Service 层对照；控制层不读文件，仅作文档）
# ★ 2026-09-24：invest / corp_fin / ma 改用新版课程知识图谱（六层完整版，前端负责人交付，
#   与前端本地兜底同一份文件）；intl_inv 无新版课程图谱，仍用旧分层文件。
#   旧 layered/{invest,corp_fin,ma}_layered.json 保留未删（只抽到部分章），回退指回即可。
GRAPH_FILES: Final[dict[str, str]] = {
    "ma": "media/graphs/course_graph_mergers.json",
    "corp_fin": "media/graphs/course_graph_corporate_finance.json",
    "intl_inv": "layered/intl_inv_layered.json",
    "invest": "media/graphs/course_graph_investment.json",
    "econ": "layered/econ_layered.json",
    "v6": "layered/v6_layered.json",
    "v12": "layered/v12_layered.json",
}


def is_known_graph(graph_id: str) -> bool:
    """是否为已登记图谱（仅用于日志提示，未知值不拒绝，预留扩展）"""
    return graph_id in GRAPH_IDS
