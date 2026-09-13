import logging
import threading
import copy
import re
import json
import time
import wandb
import datetime
from wandb.sdk.data_types.trace_tree import Trace
from tqdm import tqdm
from src import utils
from src.prompts import webqsp as prompt_webqsp
from src.prompts import cwq as prompt_cwq
from src.prompts import cl_lt_kgqa as prompt_cl_lt_kgqa
from src.path_rag import Path_RAG
from src.utils.llm_backbone import LLM_Backbone
from src.utils.data_types import Graph


# ── 辅助函数：LLM JSON 解析 + 标记→HTML 转换 ──────────────────────────────

def parse_llm_json_response(raw_text: str) -> dict:
    """解析LLM返回的JSON，容错处理markdown包裹和多余字符"""
    # 1. 去除可能的markdown json代码块
    raw_text = re.sub(r'```json\s*', '', raw_text)
    raw_text = re.sub(r'```\s*', '', raw_text)
    raw_text = raw_text.strip()

    # 2. 如果LLM只返回了纯文本（极少数情况兜底）
    if not raw_text.startswith('{'):
        # 尝试从纯文本中提取 JSON
        match = re.search(r'\{.*\}', raw_text, re.DOTALL)
        if match:
            raw_text = match.group(0)
        else:
            return {"answer": raw_text, "related_nodes": []}

    # 3. 标准JSON解析
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        # 解析失败，尝试提取answer字段（简单正则）
        match = re.search(r'"answer"\s*:\s*"([^"]*)"', raw_text)
        if match:
            return {"answer": match.group(1), "related_nodes": []}
        return {"answer": raw_text, "related_nodes": []}


def convert_to_html_links(text: str, related_nodes: list = None) -> str:
    """
    将两种格式转换为超链接：
    1. [[节点名]](ID) -> 旧格式
    2. [ID] -> 新格式，从 related_nodes 反查名称
    """
    # 1. 处理旧格式 [[名称]](ID)
    def old_replacer(match):
        name = match.group(1).strip()
        node_id = match.group(2).strip()
        return f'<a href="/knowledge/{node_id}" class="kg-node-link" data-node-id="{node_id}">{name}</a>'
    text = re.sub(r'\[\[(.*?)\]\]\((.*?)\)', old_replacer, text)

    # 2. 处理新格式 [ID]
    if related_nodes:
        id_to_name = {item["id"]: item["name"] for item in related_nodes}
        def new_replacer(match):
            node_id = match.group(1)
            name = id_to_name.get(node_id, node_id)
            return f'<a href="/knowledge/{node_id}" class="kg-node-link" data-node-id="{node_id}">{name}</a>'
        text = re.sub(r'\[(concept_\d+)\]', new_replacer, text)
    else:
        text = re.sub(r'\[(concept_\d+)\]',
                      lambda m: f'<a href="/knowledge/{m.group(1)}" class="kg-node-link" data-node-id="{m.group(1)}">{m.group(1)}</a>', text)
    return text

class LLM_Navigator():
   def __init__(self, args) -> None:
      self.llm_backbone = LLM_Backbone(args)
      self.path_rag_engine = Path_RAG(args)
      self.args = args
      if args.d == "RoG-webqsp" or args.d == "RoG-webqsp-parquet":
         self.prompt_list = prompt_webqsp
      elif args.d == "RoG-cwq":
         self.prompt_list = prompt_cwq
      elif args.d == "CL-LT-KGQA":
         self.prompt_list = prompt_cl_lt_kgqa
      else:
         raise ValueError(f"Unsupported dataset: {args.d}")
      self._new_line_char = "\n" # for formatting the prompt
      self._graph_cache = {}
      self._graph_cache_lock = threading.Lock()

   def rpth_parser(
      self,
      state: dict
   ):
      """
      Reformulate the reasoning path from the agent state
      """
      reasoning_path = state.get("rpth", "")
      reformulate_prompt = copy.copy(self.prompt_list.reasoning_path_parser_prompt)
      reformulate_prompt["prompt"] = reformulate_prompt["prompt"].format(
         reasoning_path=reasoning_path
      )
      reformulate_res = self.llm_backbone.get_completion(reformulate_prompt)
      state["parsed_rpth"] = reformulate_res

   def deductive_termination(
      self,
      state: dict
   ):
      # 合并优化：直接使用原始路径，不再调用 rpth_parser 做二次转换
      reasoning_path = state.get("rpth", "")
      question = state.get("question", "")
      planning_steps = state.get("planning_steps", "")
      declarative_statement = state.get("declarative_statement", "")

      placeholder_entity = reasoning_path.split(" -> ")[-1]
      declarative_statement = declarative_statement.replace("*placeholder*", placeholder_entity).strip(".")

      if self.args.verifier == "enough":
        condition_prompt = copy.copy(self.prompt_list.terminals_prune_single_prompt)
        condition_prompt["prompt"] = condition_prompt["prompt"].format(
            question=question,
            reasoning_path=reasoning_path,
            plan_context=planning_steps,
        )

      elif self.args.verifier == "deductive+planning":
         condition_prompt = copy.copy(self.prompt_list.deductive_verifier_prompt)
         condition_prompt["prompt"] = condition_prompt["prompt"].format(
            reasoning_path=reasoning_path,
            declarative_statement=declarative_statement
         )
      else:
         # fallback: return False (don't terminate)
         return False

      res = self.llm_backbone.get_completion(condition_prompt).replace("Answer: ", "").strip()
      # print("Condition Prompt: ", condition_prompt["prompt"], "Deductive Termination: ", res)

      logging.info("<<<<<<<<")
      logging.info("Deductive Termination Prompt: {}".format(condition_prompt["prompt"]))
      logging.info("Prediction: {}".format(res))
      logging.info(">>>>>>>>")

      if "Yes" in res:
         return True
      elif "No" in res:
         return False
      else:
         return False

   def decide_top_k_candidates(
      self,
      state: dict
   ):

      next_step_candidates = state.get("next_step_candidates", [])
      question = state.get("question", "")
      planning_steps = state.get("planning_steps", "")

      formatted_next_step_candidates = [f"{i+1}: {item}" for i, item in enumerate(next_step_candidates)]
      rating_prompt = copy.copy(self.prompt_list.beam_search_prompt)
      rating_prompt["prompt"] = self.prompt_list.beam_search_prompt["prompt"].format(
         beam_width=self.args.top_k,
         plan_context=planning_steps,
         question=question,
         reasoning_paths=self._new_line_char.join(formatted_next_step_candidates)
      )

      logging.info("<<<<<<<<")
      logging.info("Beam Search Prompt: {}".format(rating_prompt["prompt"]))
      logging.info(">>>>>>>>")

      attempt = 0
      while attempt < 5: # try 5 times if the index is not found or not as expected
         try:
             rating_index = self.llm_backbone.get_completion(rating_prompt)
             rating_index = rating_index.replace("Answer: ", "").strip()
             _ = re.findall(r'\d+', rating_index)
             matched_indices = [int(i)-1 for i in _]

             logging.info("<<<<<<<<")
             logging.info("Top-k Indices: {}".format(matched_indices))
             logging.info(">>>>>>>>")

             # 过滤越界索引，确保只取有效候选
             valid_indices = [i for i in matched_indices if 0 <= i < len(next_step_candidates)]
             if not valid_indices:
                logging.warning("[Fallback] No valid candidate indices, using top-k directly")
                valid_indices = list(range(min(len(next_step_candidates), self.args.top_k)))

             top_k_candidates = [[next_step_candidates[i]] for i in valid_indices[:self.args.top_k]]
             return top_k_candidates

         except Exception as e:
             wait_time = min(2 ** attempt, 30)
             logging.error(f"Error occurred: {e}, retrying in {wait_time}s")
             attempt += 1
             time.sleep(wait_time)

   def _extract_chinese_prefix(self, text: str) -> str:
      """从字符串中提取第一个连续的中文前缀。"""
      if not text:
         return ""
      start = -1
      for i, ch in enumerate(text):
         if '\u4e00' <= ch <= '\u9fff':
            start = i
            break
      if start == -1:
         return ""
      end = start
      for i in range(start, len(text)):
         if '\u4e00' <= text[i] <= '\u9fff':
            end = i + 1
         else:
            break
      return text[start:end]

   def _longest_common_substring(self, a: str, b: str):
      """返回 (最长公共子串, 在 a 中的起始位置)。动态规划，时间复杂度 O(len(a) * len(b))。"""
      if not a or not b:
         return "", -1
      la, lb = len(a), len(b)
      dp = [[0] * (lb + 1) for _ in range(la + 1)]
      max_len = 0
      end_pos_in_a = 0
      for i in range(1, la + 1):
         for j in range(1, lb + 1):
            if a[i - 1] == b[j - 1]:
               dp[i][j] = dp[i - 1][j - 1] + 1
               if dp[i][j] > max_len:
                  max_len = dp[i][j]
                  end_pos_in_a = i
      if max_len == 0:
         return "", -1
      return a[end_pos_in_a - max_len:end_pos_in_a], end_pos_in_a - max_len

   def _normalize_related_nodes(self, raw_nodes: list, node_meta: dict) -> list:
      """
      归一化 LLM 返回的 related_nodes，使其符合 AnswerResult 标准格式：
      [{"id": str, "name": str, "type": str, "page": int|None}, ...]

      规则：
      - 过滤非 dict、空 id、空 name 的元素
      - 按 id 去重（保留首次出现的）
      - 从 node_meta 补 type / page（若缺失则 type="", page=None）
      """
      if not raw_nodes:
         return []

      result = []
      seen_ids = set()
      for item in raw_nodes:
         if not isinstance(item, dict):
            continue
         nid = (item.get("id") or "").strip()
         name = (item.get("name") or "").strip()
         if not nid or not name:
            continue
         if nid in seen_ids:
            continue

         meta = node_meta.get(nid) if node_meta else None
         result.append({
            "id": nid,
            "name": name,
            "type": (meta or {}).get("type", "") if meta else "",
            "page": (meta or {}).get("page") if meta else None,
         })
         seen_ids.add(nid)

      return result

   def _add_superscript_links(self, text: str, related_nodes: list, graph=None) -> str:
      """
      在纯文本中扫描相关节点，在匹配到的位置末尾添加上标超链接。
      四层回退匹配：精确匹配 -> name 的中文前缀 -> label 的中文前缀 -> 最长公共子串。
      """
      if not related_nodes:
         return text

      result = text
      # 从后往前处理，避免位置偏移
      for idx in range(len(related_nodes) - 1, -1, -1):
         node = related_nodes[idx]
         node_id = node.get("id", "")
         name = node.get("name", "")
         if not node_id or not name:
            continue

         # 获取节点原始 label（用于第 3、4 层兜底）
         original_label = ""
         if graph is not None and node_id in graph.nodes:
            original_label = graph.nodes[node_id].attribute or ""

         match_pos = -1
         match_len = 0

         # 第一层：精确匹配 name
         pos = result.find(name)
         if pos != -1:
            match_pos = pos
            match_len = len(name)
         else:
            # 第二层：name 的中文前缀
            prefix = self._extract_chinese_prefix(name)
            if prefix and len(prefix) >= 2:
               pos = result.find(prefix)
               if pos != -1:
                  match_pos = pos
                  match_len = len(prefix)
            # 第三层：原始 label 的中文前缀
            if match_pos == -1:
               label_prefix = self._extract_chinese_prefix(original_label)
               if label_prefix and len(label_prefix) >= 2:
                  pos = result.find(label_prefix)
                  if pos != -1:
                     match_pos = pos
                     match_len = len(label_prefix)
            # 第四层：最长公共子串（>= 3 个中文字符）
            if match_pos == -1 and original_label:
               substr, pos = self._longest_common_substring(result, original_label)
               if pos != -1 and len(substr) >= 3:
                  match_pos = pos
                  match_len = len(substr)

         # 匹配成功，插入上标
         if match_pos != -1 and match_len > 0:
            superscript = (
                f'<sup>'
                f'<a href="/knowledge/{node_id}" '
                f'data-node-id="{node_id}" '
                f'data-node-name="{name}" '
                f'class="kg-node-link">'
                f'{idx + 1}'
                f'</a>'
                f'</sup>'
            )
            result = result[:match_pos + match_len] + superscript + result[match_pos + match_len:]

      return result

   def _find_match_position(self, text: str, node: dict, graph=None):
      """
      在 text 中为 node 找首次匹配位置。
      返回 (pos, length) 或 (-1, 0)。
      四层回退：精确 name -> name 中文前缀 -> label 中文前缀 -> 最长公共子串。
      """
      node_id = node.get("id", "")
      name = node.get("name", "")
      if not node_id or not name:
         return -1, 0

      original_label = ""
      if graph is not None and node_id in graph.nodes:
         original_label = graph.nodes[node_id].attribute or ""

      # 第一层
      pos = text.find(name)
      if pos != -1:
         return pos, len(name)

      # 第二层
      prefix = self._extract_chinese_prefix(name)
      if prefix and len(prefix) >= 2:
         pos = text.find(prefix)
         if pos != -1:
            return pos, len(prefix)

      # 第三层
      label_prefix = self._extract_chinese_prefix(original_label)
      if label_prefix and len(label_prefix) >= 2:
         pos = text.find(label_prefix)
         if pos != -1:
            return pos, len(label_prefix)

      # 第四层
      if original_label:
         substr, pos = self._longest_common_substring(text, original_label)
         if pos != -1 and len(substr) >= 3:
            return pos, len(substr)

      return -1, 0

   def _build_html_with_superscripts(self, text: str, related_nodes: list, graph=None):
      """
      两阶段：先扫描匹配位置，再按位置排序生成连续序号。
      返回 (new_html, new_related_nodes)。
      """
      if not related_nodes:
         return text, []

      # 阶段 1：找匹配位置
      matches = []
      for idx, node in enumerate(related_nodes):
         pos, length = self._find_match_position(text, node, graph)
         if pos >= 0:
            matches.append((pos, length, idx))

      if not matches:
         return text, []

      # 阶段 2：按位置升序、位置相同按长度降序
      matches.sort(key=lambda x: (x[0], -x[1]))

      # 阶段 3：去重叠（长匹配优先）
      occupied = []
      filtered = []
      for pos, length, idx in matches:
         end = pos + length
         overlap = False
         for s, e in occupied:
            if not (end <= s or pos >= e):
               overlap = True
               break
         if not overlap:
            filtered.append((pos, length, idx))
            occupied.append((pos, end))

      if not filtered:
         return text, []

      # 阶段 4：重排 related_nodes
      new_related_nodes = [related_nodes[idx] for (_, _, idx) in filtered]

      # 阶段 5：从后往前插入上标，序号从 1 连续
      result = text
      for new_idx in range(len(filtered) - 1, -1, -1):
         pos, length, _ = filtered[new_idx]
         node = new_related_nodes[new_idx]
         node_id = node["id"]
         name = node["name"]
         superscript = (
             f'<sup>'
             f'<a href="/knowledge/{node_id}" '
             f'data-node-id="{node_id}" '
             f'data-node-name="{name}" '
             f'class="kg-node-link">'
             f'{new_idx + 1}'
             f'</a>'
             f'</sup>'
         )
         result = result[:pos + length] + superscript + result[pos + length:]

      return result, new_related_nodes

   def reasoning(
      self,
      state: dict,
      graph=None
   ):
      import time as _t
      _t0 = _t.perf_counter()
      reasoning_paths = state.get("reasoning_paths", [])
      question = state.get("question", "")
      reasoning_prompt = copy.copy(self.prompt_list.reasoning_prompt)
      reasoning_prompt["prompt"] = reasoning_prompt["prompt"].format(
         question=question,
         reasoning_path=self._new_line_char.join([item[0] for item in reasoning_paths])
      )
      reasoning_res = self.llm_backbone.get_completion(reasoning_prompt)

      logging.info("<<<<<<<<")
      logging.info("Reasoning Prompt: {}".format(reasoning_prompt["prompt"]))
      logging.info("Reasoning Paths: \n{}".format(reasoning_paths))
      logging.info("Prediction: \n{}".format(reasoning_res))
      logging.info(">>>>>>>>")

      # ── 解析 JSON ──
      parsed = parse_llm_json_response(reasoning_res)
      clean_answer = parsed.get("answer", reasoning_res).strip()
      raw_related_nodes = parsed.get("related_nodes", [])

      # ★ 归一化：补 type/page、去重、过滤空字段
      node_meta = state.get("node_meta", {}) or {}
      related_nodes = self._normalize_related_nodes(raw_related_nodes, node_meta)

      # 后处理：按文本出现顺序重排 related_nodes，序号连续
      if related_nodes:
         answer_html, related_nodes = self._build_html_with_superscripts(
            clean_answer, related_nodes, graph
         )
      else:
         answer_html = clean_answer

      # 存入 state
      state['final_answer_raw'] = clean_answer
      state['final_answer_html'] = answer_html
      state['related_nodes'] = related_nodes

      # 去掉可能的 Answer: 前缀
      clean_answer = re.sub(r'^Answer:\s*', '', clean_answer, flags=re.IGNORECASE)

      logging.debug("[reasoning] HTML 答案:\n%s", answer_html)
      logging.debug("[reasoning] related_nodes: %s",
                    json.dumps(related_nodes, ensure_ascii=False))
      print(f"[TIMING][REASONING] 耗时 {_t.perf_counter()-_t0:.2f}s", flush=True)

      return clean_answer

   def planning(
      self,
      state: dict
   ):
      """
      Generate the planning steps for the Beam Search, and the keywords for the Path-RAG
      """
      import time as _t
      _t0 = _t.perf_counter()
      entity = state.get("entity", "")
      question = state.get("question", "")
      plan_prompt = copy.copy(self.prompt_list.plan_prompt)
      plan_prompt["prompt"] = plan_prompt["prompt"].format(
         question=question,
         starting_node=entity
      )

      logging.info("Plan Prompt: {}".format(plan_prompt))
      plan_res = self.llm_backbone.get_completion(plan_prompt).replace("json", "").replace("```", "")
      logging.info("Plan Response: {}".format(plan_res))
      # 容错：尝试解析 JSON，失败则使用默认值
      plan_json = {"keywords": [], "planning_steps": [], "declarative_statement": ""}
      if plan_res and plan_res.strip():
          try:
              plan_json = json.loads(plan_res)
          except json.JSONDecodeError:
              # 提取 JSON 块（从第一个 { 到最后一个 }）
              start = plan_res.find('{')
              end = plan_res.rfind('}')
              if start >= 0 and end > start:
                  try:
                      plan_json = json.loads(plan_res[start:end+1])
                  except json.JSONDecodeError:
                      logging.error("[Planning] Failed to parse plan response as JSON")
              else:
                  logging.error("[Planning] No valid JSON block found in plan response")
      key_words = ", ".join(plan_json.get("keywords", []))
      planning_steps = ", ".join(plan_json.get("planning_steps", []))
      declarative_statement = plan_json.get("declarative_statement", "")

      logging.info("Planning Keywords: {}".format(key_words))
      logging.info("Planning Steps: {}".format(planning_steps))
      logging.info("Declarative Statement: {}".format(declarative_statement))

      state["key_words"] = key_words
      state["planning_steps"] = planning_steps
      state["declarative_statement"] = declarative_statement
      print(f"[TIMING][PLANNING] 耗时 {_t.perf_counter()-_t0:.2f}s", flush=True)

      # print("planning_steps: ", state["planning_steps"])
      # print("key_words: ", state["key_words"])
      # print("declarative_statement: ", state["declarative_statement"])

   def beam_search(
      self,
      data
   ):
      id  = data['id']
      question = data['question']
      hop = data['hop']
      graph = Graph(
         args=self.args,
         graph=utils.build_graph(data["graph"]),
         cache_path=self.args.save_cache,
         id=id,
         embedding_method=self.args.embedding_model,
         replace=False
      )
      answer = data['a_entity']
      starting_entities = data['q_entity']
      pred_list_direct_answer = []
      pred_list_llm_reasoning = []
      reasoning_path_list = []
      ground_reasoning_path_list = data['ground_paths'] # shortest reasoning paths from q_entity to a_entity
      llm_states = {}
      llm_states["question"] = question
      llm_states["hop"] = hop
      llm_states["graph"] = graph
      llm_states["answer"] = answer
      llm_states["starting_entities"] = starting_entities

      logging.info(f"Processing ID: {id}")
      logging.info(f"Question: {question}")
      logging.info(f"Ground Truth: {answer}")
      logging.info(f"Starting Nodes: {starting_entities}")

      root_spans = []

      # ✨ 新增：路径去重与回溯机制
      visited_path_signatures = set()   # 存储已探索路径的签名
      backtrack_stack = []              # 用于回溯的栈
      max_retry_per_step = 3            # 每步最大重试次数

      for node in starting_entities:

         start_time_ms = round(datetime.datetime.now().timestamp() * 1000)

         # initialize the w & B root span
         root_span = Trace(
            name="Beam Searcher",
            kind="agent",
            start_time_ms=start_time_ms,
            metadata={"id": id, "hop": hop, "q_entities": starting_entities, "answer": answer},
         )

         llm_states["entity"] = node
         self.planning(llm_states)
         planning_end_time_ms = round(datetime.datetime.now().timestamp() * 1000)

         planning_span = Trace(
            name="Planner",
            kind="llm",
            start_time_ms=start_time_ms,
            end_time_ms=planning_end_time_ms,
            inputs={"input": llm_states["question"]},
            outputs={"planning_steps": llm_states["planning_steps"], "key_words": llm_states["key_words"], "declarative_statement": llm_states["declarative_statement"]},
         )

         root_span.add_child(planning_span)

         reasoning_paths = [] # final reasoning paths
         active_beam_reasoning_paths = [[node]] # store the reasoning paths for each step, the the length of the list is equal to the number of top-k

         for step in tqdm(range(self.args.max_length + 1), desc="Beam searching...", delay=0.5, leave=False, ascii="░▒█"):

            search_span = Trace(
               name="Searcher",
               kind="llm",
               start_time_ms=start_time_ms,
               inputs={"input": llm_states["key_words"], "reasoning paths": reasoning_paths, "active_beam_reasoning_paths": active_beam_reasoning_paths},
            )

            all_candidates = []

            for rpth in active_beam_reasoning_paths:

               llm_states["rpth"] = rpth[0]

               # if meet the condition, skip the current step
               if step != 0:
                  flag = self.deductive_termination(
                     state=llm_states
                  )
                  if flag:
                     reasoning_paths.append(rpth)
                     continue

               next_step_candidates = self.path_rag_engine.get_path(
                  state=llm_states
               )

               if next_step_candidates: # if there are no next_step_candidates, skip the current step
                  all_candidates.extend(next_step_candidates)

            if not all_candidates:
               break

            # ✨ 新增：代码级路径去重（Reflection 机制）
            filtered_candidates = []
            for candidate in all_candidates:
               signature = candidate
               if signature not in visited_path_signatures:
                  filtered_candidates.append(signature)
               else:
                  logging.info(f"[Reflection] 跳过已探索路径: {signature}")

            if not filtered_candidates:
               # 所有候选都已探索过 → 触发回溯
               logging.info("[Reflection] 无新路径可用，触发回溯")
               if backtrack_stack:
                  logging.info(f"[Reflection] 回溯到上一节点: {backtrack_stack[-1]}")
                  backtrack_stack.pop()
                  continue
               else:
                  # 无路径可回溯，终止搜索
                  logging.info("[Reflection] 无路径可回溯，终止搜索")
                  break


            # 将去重后的候选替换原列表
            all_candidates = filtered_candidates

            if step != self.args.max_length: # if not the last step
                llm_states["next_step_candidates"] = all_candidates
                active_beam_reasoning_paths = self.decide_top_k_candidates(
                      state=llm_states
                )
                # 兜底：如果 LLM 调用失败返回 None，回退到上一步的候选
                if active_beam_reasoning_paths is None or len(active_beam_reasoning_paths) == 0:
                    logging.warning("[Fallback] decide_top_k_candidates returned None/empty")
                    active_beam_reasoning_paths = [[c] for c in all_candidates[:self.args.top_k]]

                logging.info("<<<<<<<<")
                logging.info("Active Beam Reasoning Paths: {}".format(active_beam_reasoning_paths))
                logging.info(">>>>>>>>")

            # 新增：记录已探索路径签名，压入回溯栈
            for rpth in active_beam_reasoning_paths:
                path_signature = rpth[0]
                visited_path_signatures.add(path_signature)
                hub_node = rpth[0].split(" -> ")[-1]
                backtrack_stack.append(hub_node)

            search_span.end_time_ms = round(datetime.datetime.now().timestamp() * 1000)
            search_span.outputs={"reasoning paths": reasoning_paths, "active_beam_reasoning_paths": active_beam_reasoning_paths}

            planning_span.add_child(search_span)

         # if there are no candidates fit the criteria, return the active_beam_raesoning_paths
         if not reasoning_paths:
            reasoning_paths = active_beam_reasoning_paths

         llm_states["reasoning_paths"] = reasoning_paths

         # --------------
         # LLM REASONING
         # --------------
         reasoning_res = self.reasoning(llm_states)
         reasoning_end_time_ms = round(datetime.datetime.now().timestamp() * 1000)

         reasoniong_span = Trace(
            name="Reasoner",
            kind="llm",
            start_time_ms=start_time_ms,
            end_time_ms=reasoning_end_time_ms,
            inputs={"input": llm_states["reasoning_paths"], "question": llm_states["question"]},
            outputs={"response": reasoning_res},
         )

         root_span.add_child(reasoniong_span)
         root_span.add_inputs_and_outputs(
            inputs={"question": llm_states["question"]},
            outputs={"response": reasoning_res}
         )
         root_span.end_time_ms  = reasoning_end_time_ms

         root_spans.append(root_span)

         # Use the parsed answer from reasoning() instead of splitting raw response
         pred_list_llm_reasoning.append(reasoning_res)

         for item in reasoning_paths:
            pred_list_direct_answer.append(item[0].split(" -> ")[-1])
            reasoning_path_list.append(item[0])

      # save the results to a jsonl file
      res =  {
               "id": id,
               "question": question,
               "hop": hop,
               "q_entities": starting_entities,
               "reasoning_path": reasoning_path_list,
               "ground_path": ground_reasoning_path_list,
               "prediction_llm": "\n".join(set(pred_list_llm_reasoning)), # remove duplicate predictions
               "prediction_direct_answer": "\n".join(set(pred_list_direct_answer)),
               "ground_truth": answer,
          }
      return res, root_spans

   def _get_or_create_graph(self, graph_data):
      """
      按 graph_id 缓存 Graph 对象。首次构建，后续复用。
      graph_data: Pydantic GraphData 对象
      """
      import time as _t
      _t0 = _t.perf_counter()
      graph_id = graph_data.graph_id
      cached = self._graph_cache.get(graph_id)
      if cached is not None:
          print(f"[TIMING][GRAPH] 缓存命中 graph_id={graph_id}，耗时 {_t.perf_counter()-_t0:.4f}s", flush=True)
          return cached
      print(f"[TIMING][GRAPH] 缓存未命中，开始构建 graph_id={graph_id}", flush=True)

      with self._graph_cache_lock:
          cached = self._graph_cache.get(graph_id)
          if cached is not None:
             print(f"[TIMING][GRAPH] 缓存命中 graph_id={graph_id}，耗时 {_t.perf_counter()-_t0:.4f}s", flush=True)
             return cached

          triples = [
             (e.source, e.relation, e.target)
             for e in graph_data.edges
          ]
          node_meta = {
             n.id: {
                "label": n.label,
                "type": n.type,
                "page": n.page,
             }
             for n in graph_data.nodes
          }
          graph = Graph(
             args=self.args,
             graph=utils.build_graph(triples),
             node_meta=node_meta,
             graph_id=graph_id,
             cache_path=self.args.save_cache,
             id=graph_id,
             embedding_method=self.args.embedding_model,
             replace=False
          )
          self._graph_cache[graph_id] = graph
          print(f"[TIMING][GRAPH] 建图完成 graph_id={graph_id}，耗时 {_t.perf_counter()-_t0:.2f}s", flush=True)
          return graph

   def fast_retrieve_answer(self, graph_data, question: str):
      """
      核心问答方法。返回 dict（由适配器转 Pydantic AnswerResult）。
      graph_data: Pydantic GraphData 对象
      question: 用户问题
      """
      try:
          _t0 = __import__('time').perf_counter()
          graph = self._get_or_create_graph(graph_data)
          print(f"[STEP] 建图: {__import__('time').perf_counter()-_t0:.2f}s", flush=True)
          _t1 = __import__('time').perf_counter()
          node_meta = {
             n.id: {
                "label": n.label,
                "type": n.type,
                "page": n.page,
             }
             for n in graph_data.nodes
          }

          state = {
             "question": question,
             "entity": "",
             "graph": graph,
             "key_words": "",
             "planning_steps": "",
             "declarative_statement": "",
             "node_meta": node_meta,
          }
          self.planning(state)
          print(f"[STEP] planning(LLM): {__import__('time').perf_counter()-_t1:.2f}s", flush=True)
          _t2 = __import__('time').perf_counter()

          # 语义检索
          seed_nodes = self.path_rag_engine.retrieve_nodes_by_text(
             query_text=state["key_words"],
             original_question=question,
             graph=graph,
             top_k=5
          )
          print(f"[STEP] path_rag检索: {__import__('time').perf_counter()-_t2:.2f}s, 命中{len(seed_nodes)}节点", flush=True)
          _t3 = __import__('time').perf_counter()
          retrieval_count = len(seed_nodes)

          if not seed_nodes:
            return {
               "prediction_llm": "图谱中未找到与问题相关的概念，请尝试换种问法。",
               "prediction_html": "图谱中未找到与问题相关的概念，请尝试换种问法。",
               "related_nodes": [],
               "retrieval_count": 0,
               "used_count": 0,
            }

          # 图谱上下文扩展（每个种子最多扩 3 个同章节点，总数上限 15）
          _te = __import__("time").perf_counter()
          MAX_PER_SEED = 3
          MAX_TOTAL = 15

          expanded_nodes = []
          seen_node_ids = set()

          for seed in seed_nodes:
             if seed["node_id"] not in seen_node_ids:
                expanded_nodes.append(seed)
                seen_node_ids.add(seed["node_id"])

             parent_chapter = seed.get("parent", "")
             if not parent_chapter:
                parent_chapter = self.path_rag_engine._get_parent_chapter(graph, seed["node_id"])

             if parent_chapter:
                chapter_node_id = None
                for nid, node in graph.nodes.items():
                   if node.attribute == parent_chapter:
                      chapter_node_id = nid
                      break
                if chapter_node_id:
                   added_for_this_seed = 0
                   for edge in graph.graph.edges(data=True):
                      if added_for_this_seed >= MAX_PER_SEED:
                         break
                      if edge[0] == chapter_node_id or edge[1] == chapter_node_id:
                         child_node_id = edge[0] if edge[1] == chapter_node_id else edge[1]
                         if child_node_id not in seen_node_ids and child_node_id in graph.nodes:
                            child_label = graph.nodes[child_node_id].attribute
                            if "concept" in child_node_id or "formula" in child_node_id:
                               expanded_nodes.append({
                                  "node_id": child_node_id,
                                  "label": child_label,
                                  "parent": parent_chapter,
                                  "score": 0.0
                               })
                               seen_node_ids.add(child_node_id)
                               added_for_this_seed += 1

          expanded_nodes = expanded_nodes[:MAX_TOTAL]
          print(f"[STEP] 节点扩展: {__import__('time').perf_counter()-_te:.2f}s, 扩展后{len(expanded_nodes)}节点", flush=True)
          _t4 = __import__('time').perf_counter()

          # 组装上下文
          context_lines = ["根据知识图谱检索到的相关概念（节点ID用[]标注）："]
          for i, item in enumerate(expanded_nodes, 1):
             parent_info = "（来自：" + item["parent"] + "）" if item.get("parent") else ""
             context_lines.append(str(i) + ". [" + item["node_id"] + "] " + item["label"] + " " + parent_info)
          context_text = self._new_line_char.join(context_lines)
          print(f"[STEP] 上下文组装: {__import__('time').perf_counter()-_t4:.3f}s, {len(context_text)}字", flush=True)
          _t5 = __import__('time').perf_counter()

          state["reasoning_paths"] = [[context_text]]

          reasoning_res = self.reasoning(state, graph)
          print(f"[STEP] reasoning(LLM): {__import__('time').perf_counter()-_t5:.2f}s", flush=True)
          related_nodes = state.get("related_nodes", [])

          return {
            "prediction_llm": reasoning_res,
            "prediction_html": state.get("final_answer_html", reasoning_res),
            "related_nodes": related_nodes,
            "retrieval_count": retrieval_count,
            "used_count": len(related_nodes),
          }

      except Exception:
          logging.exception("[fast_retrieve_answer] 处理失败")
          return {
             "prediction_llm": "",
             "prediction_html": "",
             "related_nodes": [],
             "retrieval_count": 0,
             "used_count": 0,
         }

   def warmup(self, graph_data):
      """
      预加载：建图 + 加载/生成 embedding，不问答。
      供控制层 preload 调用。
      graph_data: Pydantic GraphData 对象
      """
      try:
         self._get_or_create_graph(graph_data)
      except Exception:
         logging.exception("[warmup] 失败")