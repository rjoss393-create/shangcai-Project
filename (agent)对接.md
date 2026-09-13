# Agent 层交付汇报文档

**交付版本**：v1.1  
**交付日期**：2026-09-13  
**交付方**：Agent 层  
**接收方**：控制层、前端、项目负责人


## 一、交付内容

Agent 层对控制层**只暴露一个入口**：

```python
from agent.qa_agent import QaAgentImpl
qa_agent = QaAgentImpl(navigator)
```

控制层通过 `QaAgentImpl` 的 `preload` 和 `answer` 两个方法调用 Agent 层。

### 1.1 目录结构

```
backend/
├── agent/                              # 【适配层】对控制层暴露的接口
│   ├── __init__.py
│   └── qa_agent.py                     # QaAgentImpl
│
├── src/                                # 【核心层】检索 + 推理 + 生成
│   ├── __init__.py
│   ├── llm_navigator.py                # 核心调度器（planning/reasoning/主流程）
│   ├── path_rag.py                     # 检索器（关键词硬匹配 + embedding 兜底）
│   │
│   ├── utils/
│   │   ├── __init__.py
│   │   ├── data_types.py               # Node / Edge / Graph
│   │   ├── llm_backbone.py             # LLM 调用封装
│   │   ├── graph_utils.py              # build_graph
│   │   └── utils.py                    # 通用工具
│   │
│   └── prompts/
│       ├── __init__.py
│       ├── cl_lt_kgqa.py               # 我们实际使用的 prompt
│       ├── cwq.py                      # 备用
│       └── webqsp.py                   # 备用
│
├── run_rag.py                          # 本地测试入口（可选）
└── config.json                         # API Key 配置（可选）
```

### 1.2 各文件职责

| 文件 | 职责 | 是否必交 |
| :--- | :--- | :--- |
| `agent/qa_agent.py` | 实现控制层的 `QaAgent` 协议，做格式转换和异常兜底 | ✅ 必交 |
| `agent/__init__.py` | 包声明 | ✅ 必交 |
| `src/llm_navigator.py` | 核心调度器，planning + reasoning + 主流程 | ✅ 必交 |
| `src/path_rag.py` | 检索器 | ✅ 必交 |
| `src/utils/data_types.py` | 数据结构（Node / Edge / Graph） | ✅ 必交 |
| `src/utils/llm_backbone.py` | LLM 调用封装 | ✅ 必交 |
| `src/utils/graph_utils.py` | networkx 图构建 | ✅ 必交 |
| `src/utils/utils.py` | 通用工具 | ✅ 必交 |
| `src/prompts/cl_lt_kgqa.py` | 我们实际使用的 prompt | ✅ 必交 |
| `src/prompts/cwq.py` / `webqsp.py` | 备用 prompt（当前不用） | 可选 |
| `run_rag.py` | 命令行本地测试工具 | 可选 |
| `config.json` | API Key / Base URL | 可选（控制层有自己配置的话不用给） |

### 1.3 不交付的文件（控制层的）

- `controller/` 全部
- `tests/` 全部
- `mock_main.py`
- `pytest.ini`


## 二、接口说明

### 2.1 `preload(graph_id, graph)` —— 预热（**必须调用**）

**作用**：页面打开时由控制层后台调用，让 Agent 提前完成“建图 + 生成全图 embedding”，把冷启动开销转移到用户看不到的时间段。

**参数**：
- `graph_id: str` —— 图谱标识（如 `corp_fin`）
- `graph: GraphData` —— 控制层从 Service 拿到的全图数据

**返回**：`None`

**幂等**：同一 `graph_id` 重复调用快速返回。

**异常**：内部捕获，不抛给控制层。

### 2.2 `answer(graph_data, question)` —— 问答

**作用**：接收用户问题，返回结构化答案。

**参数**：
- `graph_data: GraphData` —— 全图数据（含 `graph_id`）
- `question: str` —— 用户问题

**返回**：`AnswerResult`

```python
{
  "prediction_llm": "纯文本答案",
  "prediction_html": "带 <sup> 上标的 HTML 答案",
  "related_nodes": [{"id": "...", "name": "...", "type": "...", "page": ...}],
  "retrieval_count": 5,
  "used_count": 3
}
```

**异常**：内部捕获，失败返回空 `AnswerResult`。

### 2.3 控制层装配示例

```python
from controller.router import create_router
from agent.qa_agent import QaAgentImpl
from src.llm_navigator import LLM_Navigator

class NavArgs:
    d = "CL-LT-KGQA"
    embedding_model = "all-MiniLM-L6-v2"
    model_name = "deepseek-chat"
    save_cache = "./cache"
    top_n = 30
    top_k = 5
    max_length = 3
    verifier = "deductive+planning"
    debug = False

navigator = LLM_Navigator(NavArgs())
qa_agent = QaAgentImpl(navigator)

app = FastAPI()
app.include_router(create_router(service, qa_agent))
```

**启动时必须 `cd backend`**，否则 `from controller.xxx` 和 `from src.xxx` 找不到模块。


## 三、性能数据

### 3.1 单题端到端耗时（6 题实测）

| 题 | 问题 | 耗时 |
| :--- | :--- | :--- |
| Q1 | 什么是净现值？ | 3.0s |
| Q2 | 认沽期权与认购期权的主要区别 | 2.8s |
| Q3 | 资本资产定价模型的公式 | 3.3s |
| Q4 | 实物期权有哪几种类型 | 3.2s |
| Q5 | 资本结构与 MM 定理的关系 | 4.5s |
| Q6 | 今天天气怎么样？（超范围） | 2.4s |

**全部 < 5s。**

### 3.2 三本书交叉切换测试

| 序 | 书 | 场景 | 耗时 |
| :--- | :--- | :--- | :--- |
| 1 | 公司金融 | 冷启动 | 3.4s |
| 2 | 国际投资学 | 冷启动 | 6.7s |
| 3 | 经济综合 | 冷启动 | 12.7s |
| 4 | 国际投资学 | 热路径 | 2.3s |
| 5 | 经济综合 | 热路径 | 3.1s |

**冷启动 3~13s（取决于书的节点数），热路径 2~3s。**

### 3.3 各书节点数

| 书 | graph_id | 节点数 | 首次建图耗时 |
| :--- | :--- | :--- | :--- |
| 公司金融 | `corp_fin` | 3020 | ~3s |
| 国际投资学 | `intl_inv` | 1488 | ~3s |
| 经济综合 | `econ` | 4474 | ~8s |


## 四、控制层代码审阅结论（关键）

控制层代码已全部审阅，**对接结构无问题，可以交付**。以下为审阅结论汇总。

### 4.1 对接正确的部分

| 检查项 | 位置 | 结论 |
| :--- | :--- | :--- |
| `QaAgent` 协议签名 | `interfaces.py` | ✅ `preload(graph_id, graph)` / `answer(graph_data, question)`，与 `QaAgentImpl` 完全一致 |
| `GraphData` 字段 | `schemas.py` | ✅ `graph_id` / `title` / `nodes` / `edges` |
| `GraphNode` 字段 | `schemas.py` | ✅ `id` / `label` / `type` / `page` / `media` / `extra` |
| `AnswerResult` 字段 | `schemas.py` | ✅ `prediction_llm` / `prediction_html` / `related_nodes` / `retrieval_count` / `used_count` |
| `RelatedNode` 字段 | `schemas.py` | ✅ `id` / `name` / `type` / `page` |
| preload 调用时机 | `orchestrator._schedule_preload` | ✅ 页面加载时后台异步调用，`try/except` 兜底 |
| `_attach_graph_meta` 补 graph_id | `orchestrator.py` | ✅ 转给 Agent 前把 `graph_id` 和 `title` 补上 |
| `answer` 调用方式 | `orchestrator._handle_agent_query` | ✅ `lambda: self.qa_agent.answer(graph, text)`，参数顺序正确 |
| 超时熔断机制 | `dispatcher.call_agent` | ✅ 20s 超时 + 连续失败熔断 |
| 异常兜底 | `dispatcher.call_agent` | ✅ Agent 抛异常被捕获，返回 None，触发降级 |
| 无 graph_id 时降级 | `orchestrator._handle_agent_query` | ✅ `if not graph_id: 降级` |

### 4.2 需要控制层/前端确认的 5 个点

#### 点 1：`mock_main.py` 装配的是 MockQaAgent，需换成真 Agent

当前 `mock_main.py` 中：

```python
service = MockGraphService()
qa_agent = MockQaAgent()   # ← 这里是 Mock，不是我们的 QaAgentImpl
app.include_router(create_router(service, qa_agent))
```

**问题**：若实际部署也使用此版本，联调打的是 Mock，不是真 Agent。

**需要确认**：本地测试时已改为：

```python
from agent.qa_agent import QaAgentImpl
from src.llm_navigator import LLM_Navigator

navigator = LLM_Navigator(NavArgs())
qa_agent = QaAgentImpl(navigator)
```

**改动位置**：`mock_main.py` 末尾装配段。

#### 点 2：前端调 `/api/graph/load` 必须带 `graph_id`

`router.py` 中 `LoadRequest.graph_id` 为可选；`orchestrator._schedule_preload` 中：

```python
if graph_id is None or self.qa_agent is None:
    return   # graph_id 为空直接跳过预热
```

**后果**：若前端未带 `graph_id`，**preload 不会触发**，用户第一次提问将经历冷启动（5~13s）。

**需要提醒**：打开某本书时，`/api/graph/load` 请求体必须带 `graph_id`。

#### 点 3：前端调 `/api/graph/query` 必须带 `graph_id`

`orchestrator._handle_agent_query` 中：

```python
if not graph_id:
    return await self._handle_keyword_query(
        session_id, text, notice=NO_GRAPH_NOTICE, degraded=True
    )
```

**后果**：若前端未带 `graph_id`，**直接降级走关键词检索**，不会调 Agent。

**需要提醒**：用户提问时，请求体必须带 `graph_id`。

#### 点 4：若控制层调整超时，需同步修改测试断言

`test_dispatcher.py` 中：

```python
def test_default_timeout_constant(self):
    assert QA_TIMEOUT_SECONDS == 20.0
```

若将 `QA_TIMEOUT_SECONDS` 从 20 改为 30，**此测试会失败**。

**需要提醒**：改超时的同时，同步修改 `test_dispatcher.py` 中该断言。

#### 点 5：超时后 Agent 线程不会立即停止（已知限制）

`dispatcher.call_agent` 使用 `asyncio.wait_for`，超时后会 cancel 协程，但 Agent 内部使用 `asyncio.to_thread(...)`，**Python 线程无法被强制中断**。

**后果**：控制层 20s 超时后返回降级，但 Agent 内部的 LLM 调用仍会继续运行（占用线程）。

**结论**：这是 Python 已知限制，不影响功能，仅浪费一次 LLM 调用。**无需修改，知晓即可。**

### 4.3 建议（可选但推荐）

#### 建议 1：`QA_TIMEOUT_SECONDS` 从 20s 放宽到 30s

**理由**：
- 正常热路径 2~3s
- 冷启动 5~13s
- API 波动极端可能 15~20s

20s 边界偏紧，放宽到 30s 更保险。

**改动**：`dispatcher.py` 第 20 行。

**同时**：修改 `test_dispatcher.py` 中对应断言。

#### 建议 2：确认 `mock_main.py` 使用真 Agent

本地测试时，确保 `mock_main.py` 中 `qa_agent = QaAgentImpl(navigator)`。

#### 建议 3：控制层/前端在请求体中携带 `graph_id`

- `/api/graph/load` 必须带 `graph_id`
- `/api/graph/query` 必须带 `graph_id`


## 五、需要控制层配合的事项（汇总）

| # | 事项 | 紧急度 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | **`/api/graph/load` 里调用 `preload`** | 必须 | 控制层代码已实现，但需确认前端传了 `graph_id`，且 `qa_agent` 是真 Agent |
| 2 | **前端 `/api/graph/load` 带 `graph_id`** | 必须 | 否则 preload 不触发 |
| 3 | **前端 `/api/graph/query` 带 `graph_id`** | 必须 | 否则直接降级，不走 Agent |
| 4 | **`QA_TIMEOUT_SECONDS` 放宽到 30s（建议）** | 建议 | 若改，需同步改测试断言 |
| 5 | **`mock_main.py` 装配真 Agent** | 必须 | 否则联调打 Mock |

### 效果

- 做了 1、2、5：用户第一次提问即 2~3s
- 做了 3：自然语言查询走 Agent 通道
- 做了 4：API 波动时更稳定


## 六、契约符合性验收

### 6.1 输入契约（控制层 → Agent）

| 字段 | 符合 |
| :--- | :--- |
| 图级 `graph_id` / `title` / `nodes` / `edges` | ✅ |
| 节点 `id` / `label` / `type` / `page` / `media` / `extra` | ✅ |
| 边 `source` / `target` / `relation` / `extra` | ✅ |

### 6.2 输出契约（Agent → 控制层）

| 字段 | 符合 |
| :--- | :--- |
| `prediction_llm` / `prediction_html` | ✅ |
| `related_nodes[].id` / `name` / `type` / `page` | ✅ |
| `retrieval_count` / `used_count` | ✅ |
| `related_nodes[i].id` 与第 `i+1` 个上标 `data-node-id` 一致 | ✅ |
| 上标序号从 1 开始连续 | ✅ |

### 6.3 方法签名

| 方法 | 符合 |
| :--- | :--- |
| `async def preload(graph_id, graph)` | ✅ |
| `async def answer(graph_data, question)` | ✅ |


## 七、交付清单

### 7.1 代码文件

| 路径 | 说明 |
| :--- | :--- |
| `agent/` | 适配层（全部） |
| `src/` | 核心层（全部） |
| `run_rag.py` | 本地测试（可选） |
| `config.json` | 配置（可选） |

### 7.2 依赖

```
openai
sentence-transformers
networkx
numpy
pydantic
walker
tqdm
```

### 7.3 外部服务

| 服务 | 用途 |
| :--- | :--- |
| DeepSeek API | 调 LLM（`deepseek-chat`） |
| HuggingFace 缓存 | `all-MiniLM-L6-v2` embedding 模型 |

