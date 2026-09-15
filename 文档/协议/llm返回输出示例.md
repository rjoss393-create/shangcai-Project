# Agent 返回控制层的 `AnswerResult` 格式示例

## 一、完整示例

```json
{
  "prediction_llm": "根据知识图谱，认购期权价值由两个主要部分构成：第一部分是N(d1) * P，即标的股票价格乘以行权概率调整因子；第二部分是N(d2) * PV(EX)，即行权价格现值乘以行权概率调整因子。",
  "prediction_html": "根据知识图谱，认购期权价值<sup><a href=\"/knowledge/concept_2499\" data-node-id=\"concept_2499\" data-node-name=\"认购期权价值\" class=\"kg-node-link\">1</a></sup>由两个主要部分构成：第一部分是N(d1) * P<sup><a href=\"/knowledge/concept_0274\" data-node-id=\"concept_0274\" data-node-name=\"N(d1) * P\" class=\"kg-node-link\">2</a></sup>，即标的股票价格乘以行权概率调整因子；第二部分是N(d2) * PV(EX)<sup><a href=\"/knowledge/concept_0275\" data-node-id=\"concept_0275\" data-node-name=\"N(d2) * PV(EX)\" class=\"kg-node-link\">3</a></sup>，即行权价格现值乘以行权概率调整因子。",
  "related_nodes": [
    {"id": "concept_2499", "name": "认购期权价值", "type": "concept", "page": 365},
    {"id": "concept_0274", "name": "N(d1) * P", "type": "formula", "page": 16},
    {"id": "concept_0275", "name": "N(d2) * PV(EX)", "type": "formula", "page": 16}
  ],
  "retrieval_count": 5,
  "used_count": 3
}
```

## 二、字段说明

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `prediction_llm` | string | 是 | 纯文本答案，无上标，用于评估、复制、存档 |
| `prediction_html` | string | 是 | 带超链接上标的 HTML 答案，供前端渲染 |
| `related_nodes` | array | 是 | 答案中引用的节点清单 |
| `retrieval_count` | int | 否 | 检索命中的候选节点数 |
| `used_count` | int | 否 | 实际使用并标记上标的节点数 |

**`related_nodes` 元素字段**：

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | string | 是 | 节点唯一 ID，与图谱中一致 |
| `name` | string | 是 | 节点显示名 |
| `type` | string | 否 | 节点类型（`concept` / `formula` / `chapter` / `section`） |
| `page` | int | 否 | 页码，若无可省略或为 `null` |

## 三、`prediction_html` 中超链接的结构

每个上标遵循以下固定结构：

```html
<sup><a href="/knowledge/{node_id}" data-node-id="{node_id}" data-node-name="{name}" class="kg-node-link">{序号}</a></sup>
```

| 属性 | 说明 |
| :--- | :--- |
| `href` | 兜底跳转路径，格式 `/knowledge/{node_id}` |
| `data-node-id` | 节点唯一 ID，**前端真正要读的值** |
| `data-node-name` | 节点显示名 |
| `class="kg-node-link"` | 统一 class，前端用于批量绑定事件 |
| 文本内容 | 序号，从 1 开始，对应 `related_nodes` 索引 |

## 四、控制层拿到后怎么用

控制层收到 `AnswerResult` 后：

1. 把 `prediction_html`、`prediction_llm`、`related_nodes` 放进 `UnifiedResponse`，透传给前端。
2. 前端渲染 `prediction_html`，绑定 `.kg-node-link` 的点击事件。
3. 点击时读取 `data-node-id`，决定跳转到高亮、动画还是详情（具体行为由控制层和前端商定）。
4. `related_nodes` 用于前端反查节点详情、联动图谱。

## 五、关键约定

- `related_nodes` 中的 `id` 与 `prediction_html` 中的 `data-node-id` **完全一致**。
- 上标序号从 1 开始，对应 `related_nodes[0]`、`related_nodes[1]`，以此类推。
- 同一节点在答案中多次出现时，复用同一个序号和同一个 `related_nodes` 条目。
- 如果某节点在答案中没出现，不出现在 `related_nodes` 中。

**这份示例可直接发给控制层作为参考。你按此调整 `LLM_Navigator` 的输出即可。**