"""用户存储（账号 / 密码 / 权限）—— JSON 文件持久化

数据文件：data/users.json（路径由装配方指定，main.py 传 ROOT/data/users.json）
结构：

    {"users": [
      {"username": "zhangsan", "password_hash": "pbkdf2_sha256$...",
       "role": "admin", "status": "active", "created_at": "2026-09-17T10:00:00+00:00"}
    ]}

设计取舍（详见《文档/设计/登录与用户管理设计.md》）：
- 密码只存 PBKDF2-HMAC-SHA256(随机盐) 哈希，永不存明文（stdlib，无需新依赖）；
- 权限用 role 表达：admin 管理员（可管理用户）/ user 普通用户；
  status 表达启停：active 正常 / disabled 已停用（停用后不能登录）；
- 体量小：整体读入内存，写时整文件落盘（临时文件 + os.replace 原子替换）；
- 与 DataService 同属数据访问层，不 import controller，避免层间依赖。
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

PBKDF2_ITERATIONS = 120_000     # 迭代次数：登录时约几十毫秒，兼顾安全与体验
SALT_BYTES = 16
ROLES = ("admin", "user")
STATUSES = ("active", "disabled")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff]{2,20}$")   # 中文/字母/数字/下划线，2~20 位
MIN_PASSWORD_LENGTH = 6
MAX_PASSWORD_LENGTH = 64


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> str:
    """生成 "算法$迭代次数$盐$哈希" 格式的密码哈希（每次调用盐都不同）"""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """校验密码与存储的哈希是否匹配（任何格式异常一律视为不匹配）"""
    try:
        algo, iterations, salt_hex, digest_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(actual, expected)


class UserStore:
    """用户表（内存缓存 + data/users.json 落盘），所有公开方法均为协程且并发安全"""

    def __init__(self, path: str, *, iterations: int = PBKDF2_ITERATIONS):
        self.path = path
        self._iterations = iterations
        self._users: dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._load()

    # ---------- 查询 ----------

    async def get(self, username: str) -> dict | None:
        async with self._lock:
            user = self._users.get(username)
            return self._public(user) if user else None

    async def list_users(self) -> list[dict]:
        """按注册时间排序的用户列表（不含密码哈希）"""
        async with self._lock:
            users = sorted(self._users.values(), key=lambda u: u["created_at"])
            return [self._public(u) for u in users]

    async def verify(self, username: str, password: str) -> dict | None:
        """校验账号密码：通过返回用户信息，失败（含已停用）返回 None"""
        async with self._lock:
            user = self._users.get(username)
            if user is None or user["status"] != "active":
                return None
            if not verify_password(password, user["password_hash"]):
                return None
            return self._public(user)

    # ---------- 写入 ----------

    async def create(self, username: str, password: str, role: str | None = None) -> dict:
        """注册新用户；role 为 None 时：第一个用户自动成为管理员，其余为普通用户"""
        username = (username or "").strip()
        self._validate_username(username)
        self._validate_password(password)
        async with self._lock:
            if username in self._users:
                raise ValueError("该用户名已被注册")
            if role is None:
                role = "admin" if not self._users else "user"
            if role not in ROLES:
                raise ValueError(f"role 只能是 {'/'.join(ROLES)}")
            user = {
                "username": username,
                "password_hash": hash_password(password, iterations=self._iterations),
                "role": role,
                "status": "active",
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            self._users[username] = user
            self._save()
            return self._public(user)

    async def update(self, username: str, *, role: str | None = None,
                     status: str | None = None) -> dict:
        """修改角色 / 启停状态（管理员接口用）"""
        if role is not None and role not in ROLES:
            raise ValueError(f"role 只能是 {'/'.join(ROLES)}")
        if status is not None and status not in STATUSES:
            raise ValueError(f"status 只能是 {'/'.join(STATUSES)}")
        async with self._lock:
            user = self._users.get(username)
            if user is None:
                raise ValueError("用户不存在")
            if role is not None:
                user["role"] = role
            if status is not None:
                user["status"] = status
            self._save()
            return self._public(user)

    async def set_password(self, username: str, new_password: str) -> dict:
        """重设密码（本人改密 / 管理员重置共用）"""
        self._validate_password(new_password)
        async with self._lock:
            user = self._users.get(username)
            if user is None:
                raise ValueError("用户不存在")
            user["password_hash"] = hash_password(new_password, iterations=self._iterations)
            self._save()
            return self._public(user)

    async def delete(self, username: str) -> bool:
        """删除用户，返回是否存在"""
        async with self._lock:
            if username not in self._users:
                return False
            self._users.pop(username)
            self._save()
            return True

    # ---------- 内部 ----------

    @staticmethod
    def _public(user: dict) -> dict:
        """对外信息：绝不包含 password_hash"""
        return {
            "username": user["username"],
            "role": user["role"],
            "status": user["status"],
            "created_at": user["created_at"],
        }

    @staticmethod
    def _validate_username(username: str) -> None:
        if not USERNAME_PATTERN.match(username):
            raise ValueError("用户名需为 2~20 位中文、字母、数字或下划线")

    @staticmethod
    def _validate_password(password: str) -> None:
        if not isinstance(password, str) or not (MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH):
            raise ValueError(f"密码长度需为 {MIN_PASSWORD_LENGTH}~{MAX_PASSWORD_LENGTH} 位")
        if password.strip() != password or " " in password:
            raise ValueError("密码不能包含空白字符")

    def _load(self) -> None:
        if not os.path.exists(self.path):
            logger.info("[UserStore] 用户文件不存在，将于首次注册时创建: %s", self.path)
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception:
            logger.exception("[UserStore] 用户文件解析失败，本次以空用户表启动: %s", self.path)
            return
        for item in raw.get("users", []):
            username = item.get("username")
            if not username or not item.get("password_hash"):
                logger.warning("[UserStore] 跳过缺少用户名/密码哈希的记录: %s", item)
                continue
            self._users[username] = {
                "username": username,
                "password_hash": item["password_hash"],
                "role": item.get("role") if item.get("role") in ROLES else "user",
                "status": item.get("status") if item.get("status") in STATUSES else "disabled",
                "created_at": item.get("created_at", ""),
            }

    def _save(self) -> None:
        """整表落盘：先写临时文件再原子替换，避免写一半损坏"""
        payload = {"users": [self._users[name] for name in sorted(self._users)]}
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        tmp_path = f"{self.path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, self.path)
