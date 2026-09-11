# Service 与 Agent 层接口协议

> 给 Service 层（数据访问）和 Agent 层（LLM 意图/推理）同学。
> 控制层（controller）只依赖这份契约，**你们按此实现即可，无需了解控制层内部逻辑**。

## 0. 总览

- 契约定义文件：`backend/controller/interfaces.py`（接口签名）+ `backend/controller/schemas.py`（数据模型）
- 实现方式：**鸭子类型（Protocol），不需要继承任何基类**，只要类上有同名异步方法、参数和返回结构一致即可
- 全部方法必须为 **async**（`async def`），控制层一律 `await` 调用
- 需要实现的文件（路径建议）：

| 层 | 文件 | 实现类 | 实现接口 |
|----|------|--------|----------|
| Service | `backend/service/data_service.py` | 任意类名 | `GraphService` |
| Agent | `backend/agent/intent_agent.py` | 任意类名 | `IntentAgent` |
| Agent | `backend/agent/reason_agent.py` | 任意类名 | `ReasonAgent` |

- 参考实现：`backend/mock_main.py` 里的 `MockGraphService` / `MockIntentAgent` / `MockReasonAgent`，可直接照着写

---

## 1. 数据模型（schemas.py 已定义，直接 import 使用）

```python
from controller.schemas import (
    GraphData, GraphNode, GraphEdge, IntentResult, ReasonResult
)
```

### GraphNode（图谱节点）

```python
class GraphNode(BaseModel):
    id: str                    # 节点唯一 ID（如 "n1"，与 graph.json 一致）
    name: str                  # 显示名称（如 "并购协同效应"）
    category: str = ""         # 类别（如 "概念" / "课程"）
    media: dict = {}           # 富媒体：{"text": str, "images": [...], "videos": [...]}
```

### GraphEdge（图谱边）

```python
class GraphEdge(BaseModel):
    source: str                # 起点节点 ID
    target: str                # 终点节点 ID
    relation: str = ""         # 关系名（如 "包含" / "相关"）
```

### GraphData（图谱子集，三个 Service 方法的返回类型）

```python
class GraphData(BaseModel):
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
```

### IntentResult（intent_agent 必须返回的结构）

```python
class IntentResult(BaseModel):
    intent: str = "query"             # 意图类型，如 query / explain / reason（预留）
    entities: list[str] = []          # ⚠ 图谱节点 ID 列表（不是名称！）
```

### ReasonResult（reason_agent 必须返回的结构）

```python
class ReasonResult(BaseModel):
    summary: str = ""                 # 生成的自然语言摘要
    related_nodes: list[str] = []     # 关联节点 ID 列表（预留）
```

---

## 2. GraphService —— Service 层实现（3 个方法）

```python
class GraphService:
    async def get_full_graph(self) -> GraphData:
        """读取完整图谱（页面初始化用）"""

    async def get_sub_graph(self, node_id: str, depth: int = 1) -> GraphData:
        """获取以 node_id 为中心、depth 跳范围内的子图"""

    async def search_keywords(self, keywords: Sequence[str], limit: int = 20) -> GraphData:
        """关键词模糊搜索（快通道 + 降级兜底通道）"""
```

### 语义约定

**`get_full_graph`**
- 返回全量图谱。页面加载时调用一次。

**`get_sub_graph(node_id, depth)`**
- `depth=1` 时：中心节点 + 直接邻居，以及这些节点之间的边（控制层只调 depth=1，但请保留 depth 参数）
- 边的过滤规则：**只返回两端节点都在子图节点集内的边**（保证返回的图是连通的）
- 传入不存在的 `node_id`：**返回空的 GraphData（空 nodes/edges），不要抛异常**
- 实现提示：从中心节点出发 BFS depth 层（mock_main.py 里有现成写法）

**`search_keywords(keywords, limit)`**
- 这是**兜底通道**：Agent 超时/熔断时控制层会用切词后的关键词调它，因此它**必须稳定、快速、零外部依赖**（不能依赖 LLM）
- 匹配范围建议：节点 `name` / `category` / `media.text` 的模糊（子串）匹配
- 任一关键词命中即算命中；多关键词取并集
- 返回：命中的节点（最多 `limit` 个）+ 与命中节点直接相连的边（保证结果图连通）
- 无命中：返回空 GraphData

---

## 3. IntentAgent —— Agent 层实现（意图识别）

```python
class IntentAgent:
    async def parse(self, text: str) -> IntentResult:
        """从自然语言中提取意图与实体节点 ID"""
```

### 硬性要求（最重要的一条）

**`entities` 里必须是图谱中真实存在的节点 ID**（与 graph.json 的 id 一致），**不是节点名称**。

- 控制层拿到 entities 后会逐个调 `Service.get_sub_graph(entity_id)` 取图。如果返回的是名称或幻觉出来的 ID，取到的就是空图，前端一片空白。
- 建议 prompt 中把图谱节点清单（id + name）作为候选集给 LLM，要求它只从候选集中选 id。
- 识别不出实体时：返回 `IntentResult(intent="query", entities=[])`（空列表），控制层会自动降级到关键词检索，**不要乱猜**。
- 一个句子多个实体时全部返回，控制层会取并集合并子图。

---

## 4. ReasonAgent —— Agent 层实现（关系推理/摘要）

```python
class ReasonAgent:
    async def reason(self, text: str, entities: Sequence[str]) -> ReasonResult:
        """基于实体生成摘要与关联节点"""
```

- `entities` 是 IntentAgent 识别出的节点 ID 列表
- `summary`：给用户看的一段解释文字（会以"摘要"弹窗展示在前端），用中文
- `related_nodes`：可返回延伸的关联节点 ID（当前为预留字段，控制层暂只消费 summary）
- 该方法是**可选增强**：实现没就绪时控制层传 `None` 跳过；失败也不影响主流程（不会触发降级）

---

## 5. 控制层如何调用（时序说明，帮助理解上下文）

```
POST /api/graph/load    → Service.get_full_graph()
POST /api/graph/click   → Service.get_sub_graph(node_id, depth=1)
POST /api/graph/query   → 短关键词        → Service.search_keywords()          （快通道）
                        → 自然语言长句     → IntentAgent.parse(text)
                                          → 对每个实体 ID 调 Service.get_sub_graph()
                                          → ReasonAgent.reason(text, entities)（可选）
                        → Agent 超时/熔断  → Service.search_keywords()          （降级兜底）
```

---

## 6. 硬性约束（Agent 层必读）

控制层内置容错机制，你们只需知道后果：

| 参数 | 值 | 说明 |
|------|----|------|
| 单次调用超时 | **3 秒** | `dispatcher.AGENT_TIMEOUT_SECONDS`，超时即放弃本次调用 |
| 熔断阈值 | **连续失败 3 次** | 之后熔断器打开，**所有 Agent 调用被短路**，直接走降级 |
| 冷却时间 | **10 秒** | 熔断后 10 秒内不调用 Agent；冷却结束后自动恢复 |

其他约束：

- **Agent 禁止操作视图/前端**：只返回结构化 JSON（IntentResult / ReasonResult），动画和渲染由控制层负责
- **Agent 内部抛出的任何异常都计入熔断失败次数**（视为服务不可用），所以请捕获你们内部可恢复的异常（如 LLM API 偶发错误），不要让异常冒泡
- 返回的 `entities` 数量建议限制在 1~5 个，控制层会逐个取子图，太多会拖慢响应
- Service 层方法没有超时限制，但也别太慢（它们是快通道和兜底，直接决定前端响应速度）

---

## 7. 实现清单（写完后自查）

- [ ] 三个文件各实现一个类，方法签名与第 2/3/4 节完全一致（async、参数名、返回类型）
- [ ] `IntentAgent.parse` 返回的 entities 是真实节点 ID，且只从图谱候选集中选取
- [ ] `get_sub_graph` 遇到未知 node_id 返回空图而不是抛异常
- [ ] `search_keywords` 不依赖 LLM，无命中返回空图
- [ ] 用 mock_main.py 的三个 Mock 类对照过字段结构

---

## 8. 装配与联调

### 环境

```bash
pip install fastapi "pydantic>=2" uvicorn
```

### main.py 装配方式（写入口的同学）

```python
from fastapi import FastAPI
from controller.router import create_router
from service.data_service import YourGraphService
from agent.intent_agent import YourIntentAgent
from agent.reason_agent import YourReasonAgent

app = FastAPI()
app.include_router(create_router(
    YourGraphService(), YourIntentAgent(), YourReasonAgent()
))
```

### 本地自测

- 启动后访问 http://localhost:8000/docs 调 `/api/graph/query`
- 快速验证 IntentAgent：发 `{"text": "解释一下并购协同效应"}`，若 Agent 正常，响应中 `degraded=false` 且 `data.nodes` 非空；若你的实现超 3 秒或抛异常，`degraded=true` 且走关键词兜底

### 契约变更流程

若需要调整接口签名或字段，**先同步控制层同学改 `interfaces.py` / `schemas.py`**，再一起改实现，避免单方面变更导致装配失败。
