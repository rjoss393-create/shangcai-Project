# Service 与 Agent 层接口协议

> 给 Service 层（数据访问）和 Agent 层（智能问答）同学。
> 控制层（controller）只依赖这份契约，**你们按此实现即可，无需了解控制层内部逻辑**。

## 0. 总览

- 契约定义文件：`backend/controller/interfaces.py`（接口签名）+ `backend/controller/schemas.py`（数据模型）
- 实现方式：**鸭子类型（Protocol），不需要继承任何基类**，只要类上有同名异步方法、参数和返回结构一致即可
- 全部方法必须为 **async**（`async def`），控制层一律 `await` 调用
- 需要实现的文件（路径建议）：

| 层 | 文件 | 实现类 | 实现接口 |
|----|------|--------|----------|
| Service | `backend/service/data_service.py` | 任意类名 | `GraphService` |
| Agent | `backend/agent/qa_agent.py` | 任意类名 | `QaAgent` |

- 参考实现：`backend/mock_main.py` 里的 `MockGraphService` / `MockQaAgent`，可直接照着写

> **2026-09-11 更新说明（与 Agent 层新协议对齐）**：
> - 原 `IntentAgent` / `ReasonAgent` 两段式接口**已删除**，检索 + 回答统一由 `QaAgent` 完成；
> - 请求新增 `graph_id` 字段（用户停留在哪本书），页面打开时控制层会调用 `preload` 预热；
> - 问答超时放宽为 **20 秒**（缓存命中平均 2.7s，放宽是为了首次加载图谱不被误杀）；
> - `GraphService` 契约**暂未改动**（待与 service 层对接后再动，见第 9 节待办）。

> **2026-09-12 更新（按 Agent 层《字段.md》修订 GraphData 契约）**：
> - `GraphData` 新增 `graph_id`（Agent 侧必填）/`title`（可选）；节点 `name`/`category` 改为 `label`/`type`，并新增 `page`/`extra`；边新增 `extra`，`relation` 改为**必填**；
> - `QaAgent.answer` 签名改为 **`answer(graph_data, question)`**：每次调用控制层都传入当次现取的**全图数据**（内含 `graph_id`），`preload` 不变。

---

## 1. 数据模型（schemas.py 已定义，直接 import 使用）

```python
from controller.schemas import (
    GraphData, GraphNode, GraphEdge, AnswerResult, RelatedNode
)
```

### GraphNode（图谱节点）—— 2026-09-12 按《字段.md》修订

```python
class GraphNode(BaseModel):
    id: str                    # 节点唯一 ID（超链接 data-node-id 用）
    label: str                 # 节点显示名（检索与答案上标显示用）
    type: str = ""             # concept / formula / chapter / section
    page: int | None = None    # 页码，没有则 null
    media: dict | None = None  # 预留富媒体：{"image_url": "...", "video_url": "..."}，当前无数据
    extra: dict = {}           # 各书特有字段兜底：Agent 不解析，透传给前端
```

### GraphEdge（图谱边）

```python
class GraphEdge(BaseModel):
    source: str                # 起点节点 ID
    target: str                # 终点节点 ID
    relation: str              # 关系名（如 "包含概念" / "相关"），必填
    extra: dict = {}           # 兜底字段，当前无数据
```

### GraphData（图谱子集）

```python
class GraphData(BaseModel):
    graph_id: str = ""         # 图谱标识（《字段.md》必填，控制层转交 Agent 前填充）
    title: str = ""            # 书名（可选，日志/展示用）
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
```

完整格式说明见根目录《字段.md》（Agent 层给定的必要字段文档）。

### AnswerResult（QaAgent.answer 必须返回的结构，Agent 层必读）

格式与根目录《llm返回输出示例.md》一致：

```python
class RelatedNode(BaseModel):
    id: str                    # 节点唯一 ID，与图谱一致
    name: str                  # 节点显示名
    type: str = ""             # concept / formula / chapter / section
    page: int | None = None    # 页码，没有则省略或为 null

class AnswerResult(BaseModel):
    prediction_llm: str = ""                   # 纯文本答案（无上标，用于评估/复制/存档）
    prediction_html: str = ""                  # 带 <sup> 超链接的 HTML 答案
    related_nodes: list[RelatedNode] = []      # 答案中引用的节点清单
    retrieval_count: int = 0                   # 检索命中的候选节点数
    used_count: int = 0                        # 实际使用并标记上标的节点数
```

**硬性约定**：

- `related_nodes[].id` 与 `prediction_html` 中 `data-node-id` **完全一致**；
- 上标序号从 1 开始，对应 `related_nodes[0]`、`related_nodes[1]`…同一节点复用同一序号；
- 答案中未出现的节点不得出现在 `related_nodes`；
- 超链接固定结构：`<sup><a href="/knowledge/{node_id}" data-node-id="{node_id}" data-node-name="{name}" class="kg-node-link">{序号}</a></sup>`；
- **跳转行为由控制层决定**：前端点击上标 → 控制层定位并高亮对应节点，`href` 只是兜底路径，真正读取的是 `data-node-id`。

---

## 2. GraphService —— Service 层实现（3 个方法，未改动）

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
- 匹配范围建议：节点 `label` / `type` / `media` 的模糊（子串）匹配
- 任一关键词命中即算命中；多关键词取并集
- 返回：命中的节点（最多 `limit` 个）+ 与命中节点直接相连的边（保证结果图连通）
- 无命中：返回空 GraphData

---

## 3. QaAgent —— Agent 层实现（2 个方法）

```python
class QaAgent:
    async def preload(self, graph_id: str, graph: GraphData) -> None:
        """页面打开时由控制层调用：加载图谱、建立检索索引（预热）"""

    async def answer(self, graph_data: GraphData, question: str) -> AnswerResult:
        """基于 graph_data 对应图谱回答自然语言问题（检索 + 生成）"""
```

### preload(graph_id, graph)

- 触发时机：页面打开 `/api/graph/load` 时，控制层在**后台**调用（不阻塞页面加载）；
- `graph`：控制层从 `GraphService.get_full_graph()` 拿到的**归一化全图数据**（`GraphData`，`graph_id`/`title` 已由控制层填充），agent 层不需要知道数据文件路径；
- 实现要求：
  - 幂等：同一 `graph_id` 可能被重复调用（页面刷新），已有缓存时应快速返回，不必重建；
  - 缓存：建议把索引/向量缓存下来，让后续 `answer` 走热路径（你本地"缓存不删"的做法就很好，正式环境靠 preload 消除冷启动）；
  - **失败不要抛异常**（控制层在后台调用，异常只会记日志，不影响页面加载）；你内部应捕获可恢复异常。

### answer(graph_data, question)

- `graph_data`：**每次调用由控制层现取的全图数据**（`GraphData`），`graph_id`/`title` 已填充，字段格式见《字段.md》（必填 `graph_id`/`nodes`/`edges`；节点必填 `id`/`label`；边必填 `source`/`target`/`relation`）；
- `question`：用户输入的自然语言问题（长句、疑问句才会走到这里，短关键词走 Service 快通道）；
- 检索 + 回答全部在 agent 内部完成，返回 `AnswerResult`；
- 可按 `graph_data.graph_id` 复用 preload 建好的缓存；缓存未命中也可以现场建立索引（首次会慢，20s 超时已为此放宽）——控制层超时/异常时会自动降级到关键词检索。

### 超时与容错（Agent 层必读）

控制层内置容错机制，你们只需知道后果：

| 参数 | 值 | 说明 |
|------|----|------|
| 问答超时 | **20 秒** | `dispatcher.QA_TIMEOUT_SECONDS`，超时即放弃本次调用并降级 |
| 熔断阈值 | **连续失败 3 次** | 之后熔断器打开，**所有问答调用被短路**，直接走降级 |
| 冷却时间 | **10 秒** | 熔断后 10 秒内不调用 Agent；冷却结束后自动恢复 |
| 预加载 | 无超时 | preload 走后台任务，不算问答超时，也不计入熔断 |

其他约束：

- **Agent 禁止操作视图/前端**：只返回结构化 JSON（`AnswerResult`），动画和渲染由控制层负责；
- **Agent 内部抛出的任何异常都计入熔断失败次数**（视为服务不可用），请捕获你们内部可恢复的异常（如 LLM API 偶发错误），不要让异常冒泡；
- `related_nodes` 数量建议限制在 1~5 个，控制层会逐个取子图用于图谱定位，太多会拖慢响应。

---

## 4. graph_id 约定

- 控制层每个请求都会带 `graph_id`（前端根据用户停留在哪本书传入），并以 `graph.graph_id` / `graph_data.graph_id` 传给 agent 的 `preload` / `answer`；
- **统一编码表**（定义在 `backend/controller/graph_ids.py`，四方共享）：

| graph_id | 图谱 | 数据文件 |
|----------|------|----------|
| `ma` | 并购与重组 | 并购与重组_知识图谱.json |
| `corp_fin` | 公司金融 | 公司金融_知识图谱.json |
| `intl_inv` | 国际投资学 | 国际投资学_知识图谱.json |
| `econ` | 经济综合（跨课程聚合） | 经济综合_知识图谱.json |

- 编码规则：小写英文短码（只含 `[a-z0-9_]`）、与书名措辞解耦（再版改名 ID 不变）、版本不进 ID、**新增只加行不改旧值**；
- agent 层按 `graph_id` 维护自己的缓存字典即可，**只做字典键使用，不要做任何解析**。

---

## 5. 控制层如何调用（时序说明，帮助理解上下文）

```
POST /api/graph/load    → Service.get_full_graph()
                        → 后台任务：QaAgent.preload(graph_id, full_graph)   ← 预热，不阻塞（graph 已填 graph_id/title）
POST /api/graph/click   → Service.get_sub_graph(node_id, depth=1)
POST /api/graph/query   → 短关键词        → Service.search_keywords()          （快通道）
                        → 自然语言长句     → Service.get_full_graph()（补 graph_id/title）
                                          → QaAgent.answer(full_graph, text)
                                          → 按 related_nodes 的 ID 调 Service.get_sub_graph()（图谱定位）
                        → Agent 超时/熔断  → Service.search_keywords()          （降级兜底）
```

---

## 6. 硬性约束汇总（实现前必读）

- 三个文件各实现一个类，方法签名与第 2/3 节完全一致（async、参数名、返回类型）
- `AnswerResult.related_nodes[].id` 与 `prediction_html` 的 `data-node-id` 一一对应，且必须来自本次传入 `graph_data.nodes` 的真实节点 ID
- `get_sub_graph` 遇到未知 node_id 返回空图而不是抛异常
- `search_keywords` 不依赖 LLM，无命中返回空图
- `preload` 幂等、失败不抛异常
- Agent 内部捕获可恢复异常，避免冒泡触发熔断
- 用 mock_main.py 的 `MockGraphService` / `MockQaAgent` 对照过字段结构

---

## 7. 实现清单（写完后自查）

- [ ] `data_service.py` 实现 `GraphService` 三方法（签名不变）
- [ ] `qa_agent.py` 实现 `QaAgent` 两方法：`preload(graph_id, graph)` / `answer(graph_data, question)`
- [ ] `answer` 返回的 `AnswerResult` 与《llm返回输出示例.md》逐字段核对
- [ ] `related_nodes` 的 id 全部来自图谱真实节点
- [ ] preload 幂等且内部吞异常
- [ ] 用 mock_main.py 的两个 Mock 类对照过字段结构

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
from agent.qa_agent import YourQaAgent

app = FastAPI()
app.include_router(create_router(YourGraphService(), YourQaAgent()))
```

### 本地自测

- 启动后访问 http://localhost:8000/docs 调 `/api/graph/query`
- 快速验证 QaAgent：发 `{"text": "解释一下认购期权价值", "graph_id": "corp_fin"}`，若 Agent 正常，响应中 `degraded=false`、`answer` 非空且 `data.nodes` 包含引用节点；若你的实现超 20 秒或抛异常，`degraded=true` 且走关键词兜底

### 契约变更流程

若需要调整接口签名或字段，**先同步控制层同学改 `interfaces.py` / `schemas.py`**，再一起改实现，避免单方面变更导致装配失败。

---

## 9. 待办（控制层与 service 层对接时再改，当前先冻结）

> 以下变更与 Agent 层无关，先列出备忘，等 service 层同学对接时一起执行。

1. **GraphNode 字段契约已定（2026-09-12 按《字段.md》修订）**：`id`/`label`/`type`/`page`/`media`/`extra`，与 graph.json 节点字段一一对应。部分节点的 `original_ocr`/`quality`、经济综合图谱的 `source_books` 等特有字段可放进 `extra` 透传。service 层映射 graph.json 时照此输出即可，契约无需再改。
2. **节点 ID 跨书重复**：四本书的节点 ID 都是 `concept_0001` 这种本地编号，跨书会重复。service 层支持多图谱后，`get_sub_graph` / `search_keywords` 需要增加按 `graph_id` 过滤（接口签名会同步更新，届时通知大家）。
