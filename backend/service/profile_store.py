"""个人状态存储（笔记 / 收藏 / 临时关系 / 筛选条件）—— JSON 文件持久化

数据文件：data/profiles.json（路径由装配方指定，main.py 传 ROOT/data/profiles.json）
结构：

    {"profiles": {
      "zhangsan": {"notes": {...}, "favorites": [...],
                   "tempRelations": [...], "filters": {...}}
    }}

设计取舍：
- 状态结构由前端定义（前端 js/auth.js 的 defaultProfile），后端只做整体存取、
  不解析内部字段，结构演进时后端不用改；
- 只保证顶层四个键存在（老数据 / 空数据补默认骨架），避免前端取
  profile.favorites.length 时拿到 undefined；
- 体量小：整体读入内存，写时整文件落盘（临时文件 + os.replace 原子替换）；
- 与 UserStore 同属数据访问层，不 import controller，避免层间依赖。
"""
import asyncio
import copy
import json
import logging
import os

logger = logging.getLogger(__name__)

# 默认骨架（与前端 defaultProfile 对齐）
DEFAULT_PROFILE: dict = {
    "notes": {},            # { "<type>::<id>": { text, updatedAt } }
    "favorites": [],        # [ { type: paper|video|book|node, id, addedAt } ]
    "tempRelations": [],    # [ { from, to, note, createdAt } ]
    "filters": {            # 各板块筛选条件
        "study": {"tags": [], "order": "asc"},
        "paper": {"journal": None, "year": None, "topic": None},
        "career": {"category": "all"},
    },
}

MAX_PROFILE_BYTES = 1_000_000     # 单个用户的个人状态上限（防超大请求撑爆文件）


def default_profile() -> dict:
    return copy.deepcopy(DEFAULT_PROFILE)


class ProfileStore:
    """个人状态表（内存缓存 + data/profiles.json 落盘），所有公开方法均为协程且并发安全"""

    def __init__(self, path: str):
        self.path = path
        self._profiles: dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._load()

    async def get(self, username: str) -> dict:
        """取某用户的个人状态；从未保存过时返回默认骨架"""
        async with self._lock:
            return copy.deepcopy(self._profiles.get(username) or default_profile())

    async def save(self, username: str, profile: dict) -> None:
        """整体覆盖某用户的个人状态（前端每次改动后全量提交）"""
        if not isinstance(profile, dict):
            raise ValueError("profile 必须是对象")
        payload = json.dumps(profile, ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_PROFILE_BYTES:
            raise ValueError("个人状态数据过大，请精简后再保存")
        async with self._lock:
            self._profiles[username] = self._normalize(profile)
            self._save()

    # ---------- 内部 ----------

    @staticmethod
    def _normalize(profile: dict) -> dict:
        """补齐顶层四个键（内部结构原样保留，由前端负责）"""
        merged = default_profile()
        for key, value in profile.items():
            if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
                merged[key].update(value)
            else:
                merged[key] = value
        return merged

    def _load(self) -> None:
        if not os.path.exists(self.path):
            logger.info("[ProfileStore] 个人状态文件不存在，将于首次保存时创建: %s", self.path)
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception:
            logger.exception("[ProfileStore] 个人状态文件解析失败，本次以空表启动: %s", self.path)
            return
        for username, profile in (raw.get("profiles") or {}).items():
            if isinstance(profile, dict):
                self._profiles[username] = self._normalize(profile)
            else:
                logger.warning("[ProfileStore] 跳过结构异常的记录: %s", username)

    def _save(self) -> None:
        """整表落盘：先写临时文件再原子替换，避免写一半损坏"""
        payload = {"profiles": self._profiles}
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        tmp_path = f"{self.path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.path)
