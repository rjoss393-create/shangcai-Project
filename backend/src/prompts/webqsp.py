# -*- coding: utf-8 -*-
plan_prompt = {
   "system": "为了后续更好在知识图谱中检索并解答输入的问题，你的主要任务是分析并拆解输入中描述的问题，起的是在回答问题上的方向引导作用，必须从以下三个维度进行拆解：(1) 'keywords'：问题本身的关键词+解决问题的推理路径中的关键字，确保不遗漏任何潜在推理路径；(2) 'planning_steps'：追踪推理路径所需的详细步骤，把问题的解决拆分成小步骤；(3) 'declarative_statement'：把问题转成陈述句：陈述句= 已有信息（问题已有内容）+ 待填充的答案（*placeholder*），例如问题'牙买加人说什么语言？'转换为陈述句'牙买加人说 *placeholder*。'，保持 *placeholder* 不变；输出格式：json格式，仅输出以下内容，不做多于输出：{\"keywords\": [\"关键词1\",\"关键词2\"...], \"planning_steps\": [\"找到牙买加这个国家\", \"查询该国的官方语言\", \"返回语言名称\"], \"declarative_statement\": \"带*placeholder*的陈述句\"}",
   "examples": [],
   "prompt": "{question}？"
}

reasoning_path_parser_prompt = {
   "system": "将推理路径转换为语义通顺的陈述句。例如推理路径 'Henri Matisse->book.written_work.subjects->Matisse, Picasso' 转换为 'Henri Matisse 写了一本关于马蒂斯和毕加索的书'。",
   "examples": [],
   "prompt": "{reasoning_path}"
}

deductive_verifier_prompt = {
   'system': '验证"结论"是否能从当前"已知信息"推导得出。如果可以，返回 yes，否则返回 no。',
   "examples": [],
   "prompt": "推理路径为：{reasoning_path}（其中路径末端的实体即为答案）。\n结论：{declarative_statement}\n请问结论能否从推理路径中演绎推导得出？如果可以返回 yes，否则返回 no。"
}

terminals_prune_single_prompt = {
   "system": "根据给定的问题以及知识图谱中的起始实体，分别判断以下推理路径是否单独足以回答所给问题，如果足够回答'Yes'，否则回答'No'。",
   "examples": [],
   "prompt": "结合问题的解决步骤{plan_context} 和给定问题 {question}，分别判断以下推理路径{reasoning_path}是否单独能够充分回答问题。回答应为'Yes'或'No'，对应每条推理路径。"
}

beam_search_prompt = {
   "system": "根据给定的问题以及知识图谱中的起始实体，从以下推理路径中选取能够回答问题的路径。",
   "examples": [],
   "prompt": "结合问题的解决步骤 {plan_context} 和给定问题 {question}，从以下候选中选择能引导出充分回答问题的推理路径的 {beam_width} 条路径。\n候选路径：{reasoning_paths}\n只返回所选 {beam_width} 条路径的索引列表（索引从 0 开始）。"
}

reasoning_prompt = {
   "system": "你是一位金融学专业教师，擅长用清晰、简洁的语言回答专业问题。请基于给定的上下文信息回答用户的问题。主要是基于所给信息回答问题，但是如果上下文信息不足以完整回答，可结合你自己的金融学专业知识进行少量适当的补充，确保回答完整、通顺、有逻辑。不可拒绝回答。",
   "examples": [],
   "prompt": "问题：{question}\n\n知识图谱节点信息：\n{reasoning_path}\n\n请输出 JSON 对象，包含两个键，并按以下顺序输出：\n\n第一步，先输出 related_nodes：一个包含 {{\"id\": \"节点ID\", \"name\": \"answer中概念原词\"}} 对象的数组，列出你将要使用的核心概念节点。\n  - 规则 1：如果上下文中存在某节点，其标签（label）包含你在回答中会用到的概念，则必须将其放入 related_nodes。\n  - 规则 2：name 字段填你准备在 answer 中使用的概念原词（短词），不要填上下文里的冗长完整标签。\n\n第二步，再输出 answer：问题的自然语言答案。\n  - 基于 related_nodes 中的概念组织语言， name 字段里的原词必须包含在你的answer中。\n  - 不要提及你检索的信息库是什么，只需给出自然的、完整的答案。\n\n输出格式示例：\n{{\n  \"related_nodes\": [\n    {{\"id\": \"concept_2499\", \"name\": \"资本结构\"}},\n    {{\"id\": \"concept_0274\", \"name\": \"负债和权益\"}}\n  ],\n  \"answer\": \"资本结构是指公司发行的不同证券的混合，主要由负债和权益构成。\"\n}}"
}
