# Agent 层接口对接改动记录（2026-09-11）

> 本次改动：控制层与 Agent 层（智能问答）接口协议对接。
> 背景：Agent 层提出 5 条需求，控制层据此完成契约改造。
> 全部 67 个单元测试通过，mock 服务冒烟通过。

## 一、Agent 层需求 → 控制层决策对照

| # | Agent 层需求 | 控制层决策 |
|---|--------------|------------|
| 1 | 检索+回答都由 Agent 完成，控制层传对正确的数据（graph_id 字段） | 新增 `QaAgent` 两方法契约；所有请求新增 `graph_id`；图谱数据由控制层从 Service 层取归一化 `GraphData` 后转交 Agent（Agent 不碰数据文件） |
| 2 | Agent 输出带 `<sup>` 上标超链接的 JSON 答案，跳转行为由控制层决定 | 新增 `AnswerResult`/`RelatedNode` 契约；跳转行为定为：前端读 `data-node-id` 调 `/api/graph/click` → 图谱定位+高亮该节点 |
| 3 | 首次加载图谱慢，建议页面打开时预加载；超时放宽 | `/load` 时后台触发 `QaAgent.preload`（不阻塞页面、同一图谱去重、失败不计熔断）；问答超时 3s → **20s** |
| 4 | 各书图谱字段不一致，必要字段得有 | Agent 拿到的数据由控制层统一为契约结构 `GraphData`；`AnswerResult.related_nodes` 带 `type`/`page`。注：`GraphNode` 缺 `type`/`page` 的补齐属于 service 层对接范围（见待办） |
| 5 | 上标跳转到图谱高亮还是动画？ | **定位高亮**（focus + highlight，相机平滑移动自带动画效果），非独立情节动画 |

## 二、契约变更明细（新旧对比）

| 项 | 旧 | 新 |
|----|----|----|
| Agent 接口 | `IntentAgent.parse(text)` + `ReasonAgent.reason(text, entities)` | `QaAgent.preload(graph_id, graph)` + `QaAgent.answer(graph_id, question)`（原两个接口已删除） |
| 答案模型 | `IntentResult` / `ReasonResult`（已删除） | `AnswerResult`（prediction_llm / prediction_html / related_nodes / retrieval_count / used_count）+ `RelatedNode`（id / name / type / page） |
| 统一响应 | `{code, message, session_id, data, actions, degraded, notice}` | 增加 `answer` 字段（自然语言查询时返回，其余接口为 null） |
| 请求体 | load/click/query 仅 session_id | 三者均增加 `graph_id`（可空；load/query 走智能问答必传，缺省自动降级基础检索并给专门 notice） |
| 问答超时 | 3s（`AGENT_TIMEOUT_SECONDS`） | 20s（`QA_TIMEOUT_SECONDS`；熔断 3 次失败/冷却 10s 不变） |
| 场景2 动画 | highlight + text_popup(摘要) + zoom | focus(首个引用节点) + highlight(全部引用节点) + zoom |
| 页面加载 | 仅取全图 | 额外后台触发 Agent 预热（同一 graph_id 进行中不去重调用；完成后再次 /load 会重新预热，Agent 侧幂等缓存代价低） |
| Service 接口 | — | **未改动**（待与 service 层对接） |

### QaAgent 契约（interfaces.py）

```python
class QaAgent(Protocol):
    async def preload(self, graph_id: str, graph: GraphData) -> None:
        """页面打开时由控制层调用：加载图谱、建立检索索引（幂等，失败不抛异常）"""

    async def answer(self, graph_id: str, question: str) -> AnswerResult:
        """基于 graph_id 对应图谱回答自然语言问题（检索 + 生成）"""
```

### AnswerResult 硬性约定（Agent 层必读）

- `related_nodes[].id` 与 `prediction_html` 中 `data-node-id` **完全一致**，必须是图谱真实节点 ID；
- 上标序号从 1 开始，对应 `related_nodes[0]`、`related_nodes[1]`…同一节点复用同一序号；
- 上标固定结构：`<sup><a href="/knowledge/{node_id}" data-node-id="{node_id}" data-node-name="{name}" class="kg-node-link">{序号}</a></sup>`；
- `related_nodes` 建议 1~5 个（控制层会逐个取子图做图谱定位）。

## 三、代码改动清单

| 文件 | 改动 |
|------|------|
| `backend/controller/interfaces.py` | 删 IntentAgent/ReasonAgent；新增 QaAgent；GraphService 未动 |
| `backend/controller/schemas.py` | 新增 RelatedNode/AnswerResult；UnifiedResponse 加 answer；删 IntentResult/ReasonResult；GraphNode 等未动 |
| `backend/controller/dispatcher.py` | 超时常量改名 `QA_TIMEOUT_SECONDS = 20.0`，注释同步 |
| `backend/controller/assembler.py` | 删 assemble_nl_query；新增 assemble_qa（focus/highlight/zoom） |
| `backend/controller/orchestrator.py` | 构造参数换 qa_agent；load 后台预热（`_schedule_preload`/`_preload`，去重、吞异常）；query 走 answer + 按 related_nodes 并行取子图；缺 graph_id 给 NO_GRAPH_NOTICE 降级 |
| `backend/controller/router.py` | 三请求体加 graph_id（可空）；`create_router(service, qa_agent)` |
| `backend/controller/__init__.py` | 导出 QaAgent/AnswerResult/RelatedNode |
| `backend/mock_main.py` | MockIntentAgent/MockReasonAgent 换成 MockQaAgent（输出与 llm返回输出示例.md 一致） |
| `backend/tests/` | fakes.py 换 FakeQaAgent；test_orchestrator/test_router/test_assembler/test_dispatcher 同步更新；新增预热 5 个用例 |

## 四、测试

```bash
cd backend && python -m pytest -q
# 67 passed
```

冒烟（TestClient）：load(graph_id) → query 返回 `answer.prediction_html`（含 kg-node-link 上标）、`related_nodes`、actions 为 `["focus","highlight","zoom"]`。

## 五、文档同步

- `Service与Agent层接口协议.md`：agent 部分重写（QaAgent/AnswerResult/20s 超时/graph_id/时序），service 部分原样保留，第 9 节列待办
- `对接流程.md`：请求示例加 graph_id、响应加 answer、上标跳转行为说明、prediction_html 防注入提示
- `controller.txt`：场景 2/3 改写、新增场景 0（预热）、接口契约与超时更新

## 六、待办（service 层对接时处理，当前冻结）

1. **GraphNode 补字段**：graph.json 节点有 `type`（concept/formula/chapter/section）和 `page`，当前 GraphNode 缺这两个字段，service 层映射时补齐；
2. **节点 ID 跨书重复**：四本书节点都是 `concept_0001` 式本地编号，跨书重复；service 层支持多图谱后 `get_sub_graph`/`search_keywords` 需按 graph_id 过滤（接口签名届时同步更新）；
3. **graph_id 编码规则**：~~待定~~ 已设计（2026-09-11）：`ma`/`corp_fin`/`intl_inv`/`econ`，常量定义在 `backend/controller/graph_ids.py`，协议文档第 4 节有编码表；待数据层/前端确认（遗留问题：前端是否把"经济综合"当一本书展示，以及是否会有独立《投资学》图谱需加 `invest`）。

## 七、需要同步的人

| 角色 | 需要知道的变更 |
|------|----------------|
| Agent 层 | 按 `QaAgent` + `AnswerResult` 实现（她的输出格式已匹配，基本不用改）；超时 20s；预加载幂等 |
| 前端 | 响应新增 `answer` 字段；请求带 `graph_id`；渲染 prediction_html 时绑定 `.kg-node-link` 点击 → 调 /click 定位高亮；HTML 防注入 |
| Service 层 | 暂无需改动；待办第 1/2 条对接后处理 |
| main.py 入口 | 装配方式变为 `create_router(service, qa_agent)` |
