import logging
import time
import os
from openai import OpenAI, RateLimitError, APIStatusError
# litellm 仅用于批量调用（get_batch_completion），单次调用直接用 OpenAI client 避免双重重试


# ============================================================
# 全局单例：确保 SentenceTransformer 模型在整个程序生命周期中只加载一次
# ============================================================
_GLOBAL_EMBEDDER = None
_GLOBAL_EMBEDDER_MODEL_NAME = None


def _get_embedder(model_name: str):
    """获取或创建全局唯一的 SentenceTransformer 实例（本地缓存，不联网）"""
    global _GLOBAL_EMBEDDER, _GLOBAL_EMBEDDER_MODEL_NAME
    if _GLOBAL_EMBEDDER is None or _GLOBAL_EMBEDDER_MODEL_NAME != model_name:
        print(f"[Embedding] 首次加载模型: {model_name}（后续将复用）")
        from sentence_transformers import SentenceTransformer
        _GLOBAL_EMBEDDER = SentenceTransformer(model_name, local_files_only=True)
        _GLOBAL_EMBEDDER_MODEL_NAME = model_name
    else:
        print(f"[Embedding] 复用已加载的全局模型实例（无需读硬盘、无需联网）")
    return _GLOBAL_EMBEDDER


class LLM_Backbone():
   def __init__(self, args):
      # 优先从 AGNES 环境变量读取，兜底使用 OPENAI 变量
      api_key = os.environ.get("AGNES_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
      base_url = os.environ.get("AGNES_BASE_URL") or os.environ.get("OPENAI_BASE_URL", None)

      if not api_key:
         raise ValueError("请设置 AGNES_API_KEY 或 OPENAI_API_KEY 环境变量")

      self.client = OpenAI(
         api_key=api_key,
         base_url=base_url
      )
      self.embedding_model = args.embedding_model
      self.completion_model = args.model_name
      self.max_attempt = 2 # number of attempts to get the completion

      # 新增：加载本地 Embedding 模型（全局单例）
      self.embedding_model_name = getattr(args, 'embedding_model', 'all-MiniLM-L6-v2')
      if 'text-embedding' not in self.embedding_model_name.lower():
         try:
            self.local_embedder = _get_embedder(self.embedding_model_name)
         except ImportError:
            print(f"[Warning] sentence-transformers not installed, falling back to OpenAI API for embedding.")
            self.local_embedder = None
      else:
         self.local_embedder = None

   def get_embeddings(self, texts: list):
      """获取文本的向量表示"""
      # 如果使用本地模型
      if self.local_embedder is not None:
         if isinstance(texts, str):
            texts = [texts]
         return self.local_embedder.encode(texts, convert_to_numpy=True).tolist()

      # 否则走 OpenAI API（原有逻辑）
      embeddings = []
      texts_per_batch = 2000
      text_chunks = [texts[i:i + texts_per_batch] for i in range(0, len(texts), texts_per_batch)]

      attempt = 0
      while attempt < self.max_attempt:
         try:
            for chunk in text_chunks:
               chunk_embeddings = self.client.embeddings.create(
               model=self.embedding_model,
               input=chunk
               ) # return [item['embedding'] for item in _['data']]
               embeddings.extend([item.embedding for item in chunk_embeddings.data])
            return embeddings
         except Exception as e:
            logging.error(f"Error occurred: {e}")
            attempt += 1
            time.sleep(1)
      return embeddings
   def get_completion(self, prompt: dict):
      import time as _t
      _t0 = _t.perf_counter()
      messages = [
         {"role": "system", "content": prompt["system"]},
         *prompt["examples"],
         {"role": "user", "content": prompt["prompt"]}
      ]
      _prompt_time = _t.perf_counter() - _t0
      print(f"[TIMING][BACKBONE] prompt构造 {_prompt_time:.3f}s, messages条数={len(messages)}, user内容长度={len(prompt['prompt'])}", flush=True)

      attempt = 0
      while attempt < self.max_attempt:
         try:
            _t_before = _t.perf_counter()
            print(f"[LLM] 即将发起API调用 attempt={attempt+1}, model={self.completion_model}, timeout=15", flush=True)
            _t_api_start = _t.perf_counter()
            resp = self.client.chat.completions.create(
               model=self.completion_model,
               messages=messages,
               temperature=0,
               top_p=0.01,
               logprobs=False,
               timeout=15
            )
            _t_api_end = _t.perf_counter()
            _api_elapsed = _t_api_end - _t_api_start
            _total_wait = _t_api_end - _t_before
            print(f"[TIMING][LLM] API调用耗时 {_api_elapsed:.2f}s, 等待{_total_wait:.2f}s, attempt={attempt+1}", flush=True)
            content = resp.choices[0].message.content
            if not content or not content.strip():
               raise ValueError("Empty response from LLM")
            return content
         except (RateLimitError, APIStatusError) as e:
            logging.error(f"Rate limit / API error (attempt {attempt+1}/{self.max_attempt}): {e}")
            attempt += 1
            if attempt < self.max_attempt:
               wait = min(5 * (2 ** attempt), 60)
               logging.info(f"Rate limited - waiting {wait}s before retry")
               time.sleep(wait)
         except Exception as e:
            logging.error(f"Error occurred: {e}")
            attempt += 1
            if attempt < self.max_attempt:
               time.sleep(1)

   def get_log_probs(self, log_probs: list):
      scores = []
      for item in log_probs:
        top_logprobs = item[0]["top_logprobs"]
        match = False
        for i in range(len(top_logprobs)):
            if top_logprobs[i]["token"] in [" A", "A", "A "]:
                scores.append(top_logprobs[i]["logprob"])
                match = True
                break
        if not match:
            scores.append(-10000.0)
      return scores

   def get_batch_completion(self, prompt: dict, input_batch: list):
      """
      for item in log_probs:
         if item["token"] == "A":
               print(item['logprob'])
      """

      messages = []
      for item in input_batch:
         messages.append(
               [
               {"role": "system", "content": prompt["system"]},
               *prompt["examples"],
               {"role": "user", "content": item}
               ]
          )
      attempt = 0
      while attempt < 5:
         try:
               _ = batch_completion(
               model=self.completion_model,
               messages=messages,
               temperature=0,
               top_p=0.01,
               logprobs=True,
               top_logprobs=5
               )
               contents = [_[i]['choices'][0]['message']['content'] for i in range(len(_))]
               log_probs = [_[i]['choices'][0]['logprobs']['content'] for i in range(len(_))]
               return contents, log_probs

         except Exception as e:
               logging.error(f"Error occurred: {e}")
               attempt += 1
               time.sleep(1)


async def get_embedding(session, texts, model="text-embedding-3-small"):
    api_url = f"https://api.openai.com/v1/embeddings"
    headers = {
        "Authorization": f"Bearer {config['OPENAI_API_KEY']}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "input": texts
    }

    async with session.post(api_url, headers=headers, json=payload) as response:
        if response.status == 200:
            response_data = await response.json()
            return [item['embedding'] for item in response_data['data']]
        else:
            return None


async def query_api(session, args, prompt):
    api_url = f"https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {config['OPENAI_API_KEY']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": args.model_name,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
    }

    attempt = 0
    while attempt < 3: # retry 3 times if exception occurs
        try:
            async with session.post(api_url, headers=headers, json=payload) as response:
                response_data = await response.json()
                response_content = response_data['choices'][0]['message']['content']
                logging.info(f"PROMPT: {prompt}")
                logging.info("===" * 50)
                logging.info(f"RECEIVED RESPONSE: {response_content}")
                return {"prompt": prompt, "response": response_content}
        except Exception as e:
            logging.error(f"Error occurred: {e}")
            attempt += 1
            await asyncio.sleep(1)

    logging.error(f"Failed to get response for query {prompt} after 3 attempts")
    raise APIQueryError("Failed to get a valid response after all retries.")
