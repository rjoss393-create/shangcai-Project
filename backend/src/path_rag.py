import os
import logging
import multiprocessing as mp
import numpy as np
import time
import networkx as nx
from tqdm import tqdm
from src.utils.data_types import Graph, Node, Edge
from src.utils.llm_backbone import LLM_Backbone

class Path_RAG():
   def __init__(self, args):
      self.llm_backbone = LLM_Backbone(args)
      self.args = args
      
   def cos_simiarlity(self, a: np.array, b: np.array):
      """
      calculate cosine similarity between two vectors
      Parameters:
         a: np.array, representing a single vector
         b: np.array, shape (n_vectors, vector_length), representing multiple vectors
      """
      a = a.reshape(1, -1)
      dot_product = np.dot(a, b.T).flatten()
      norm_a = np.linalg.norm(a)
      norm_b = np.linalg.norm(b, axis=1)
      
      epsilon = 1e-9
      cos_similarities = dot_product / (norm_a * norm_b + epsilon)
      return cos_similarities
   
   def get_entity_edges(
      self, 
      entity: str, 
      graph: Graph
   ) -> list:
      """
      given an entity, find all edges and neighbors
      """
      edges = [] # each edge is an instance of Edge, the attribute can be accessed through edge.attribute, and the embedding can be accessed through edge.embedding
      neighbors = []
      
      if graph.graph.has_node(entity):
         for neighbor in graph.graph.neighbors(entity):
            # relation = graph.edges.get((entity, neighbor), Edge(None, None))
            # neighbor = graph.nodes.get(neighbor, Node(None))
            try:
               relation = graph.edges[(entity, neighbor)]
               # print(f"x: {relation}")
            except KeyError:
               relation = graph.graph[entity][neighbor]['relation']
               print(f"entity: {entity}, neighbor: {neighbor}, relation: {relation}")
               print(f"real_entity and real_neighbor: {[k for k, v, in graph.edges.items()]}")
               # print(f"y: {relation}, {relation in [e.attribute for e in graph.edges.values()]}")
            neighbor = graph.nodes[neighbor]
            if relation not in edges or neighbor not in neighbors: # remove the duplicates
               edges.append(relation)
               neighbors.append(neighbor)

      return edges, neighbors
   
   def has_relation(
      self, 
      graph: Graph,
      entity: str,
      relation: str,
      neighbor: str
   ) -> bool:
      """
      check if the relation exists in the graph
      """
      if graph.graph.has_edge(entity, neighbor):
         if graph.graph[entity][neighbor]['relation'] == relation:
            return True
      return False
   
   def get_relations_neighbors_set_with_ratings(
      self,
      relations: list,
      neighbors: list,
      query_embedding: list,
   ) -> list:
      """
      given a list of relations and neighbors, return top-n relations and neighbors with the corresponding ratings [(relation, 0.9), (relation, 0.8), ...]
      """
      query_embedding = np.array(query_embedding)
      
      relations_embeddings = np.array([relation.embedding for relation in relations])
      neighbors_embeddings = np.array([neighbor.embedding for neighbor in neighbors])
      
      try:
         # calculate cosine similarity
         query_relation_similarity = self.cos_simiarlity(query_embedding, relations_embeddings)
         query_neighbor_similarity = self.cos_simiarlity(query_embedding, neighbors_embeddings)
         
      except Exception as e:
         print(f"query_embeddiong: {query_embedding}")
         print(f"relations: {relations}")
         print(f"neighbors: {neighbors}")
         print(f"relations_embeddings: {relations_embeddings}")
         print(f"neighbors_embeddings: {neighbors_embeddings}")
         print(query_embedding.shape, relations_embeddings.shape, neighbors_embeddings.shape)
      
      # sort the neighbors by similarity
      relations = [(relations[i].attribute, query_relation_similarity[i]) for i in np.argsort(query_relation_similarity)[::-1]]
      
      neighbors = [(neighbors[i].attribute, query_neighbor_similarity[i]) for i in np.argsort(query_neighbor_similarity)[::-1]]
      
      return relations, neighbors
   
   def scoring_path(
      self,
      keyword_embeddings: list,
      rated_relations: list,
      rated_neighbors: list,
      hub_node: str,
      reasoning_path: str,
      graph: Graph
   ) -> list:
      """
      given a list of relations and neighbors with ratings, return top-k relations and neighbors
      """
      # concatenate the relations and neighbors
      rated_paths = [] # [(path, score)]
      seen_paths = [] # store the seen paths [path, path]
      for relation, relation_score in rated_relations:
         for neighbor, neighbor_score in rated_neighbors:
            new_rpth = f"{reasoning_path} -> {relation} -> {neighbor}"
            
            if self.has_relation(
               graph=graph, 
               entity=hub_node, 
               relation=relation,
               neighbor=neighbor
            ) and new_rpth not in seen_paths:            
               
               if self.args.add_hop_information:
                  #TODO using vectorspace to store the embeddings, otherwise the efficiency is pretty low
                  # 1-hop neighbors = relation + neighbor
                  one_hop_relations, one_hop_neighbors = self.get_entity_edges(neighbor, graph)
                  
                  if one_hop_relations and one_hop_neighbors:
                     one_hop_rated_relations, one_hop_rated_neighbors = self.get_relations_neighbors_set_with_ratings(one_hop_relations, one_hop_neighbors, keyword_embeddings)
                     
                  else:
                     # if there is no one-hop neighbors, set the score to 0
                     one_hop_rated_relations, one_hop_rated_neighbors = [(None, 0)], [(None, 0)]
                  
                  # score function for path_rag
                  rpth_score = relation_score + neighbor_score + self.args.alpha * (one_hop_rated_relations[0][1] + one_hop_rated_neighbors[0][1])
                  
               else:
                  rpth_score = relation_score + neighbor_score
                  
               rated_paths.append((new_rpth, rpth_score))
               seen_paths.append(new_rpth)
               
      rated_paths = sorted(rated_paths, key=lambda x: x[1], reverse=True)[:self.args.top_n]
      
      # only return the path
      paths = [path[0] for path in rated_paths]
            
      return paths
   
   def get_path(
      self, 
      state: dict
   ) -> list:
      """
      given a starting entity, find top-k one-step path to the query (keywords)
      """
      graph = state.get("graph", Graph)
      keywords = state.get("key_words", "") # using the keywords generated from llm to represent the query
      reasoning_path = state.get("rpth", "")
      
      hub_node = reasoning_path.split(" -> ")[-1]
      
      relations, neighbors = self.get_entity_edges(hub_node, graph)
      
      #TODO load the embeddings from the vectorspace
      # get embeddings
      embeddings = self.llm_backbone.get_embeddings(keywords)
      
      if relations and neighbors:
         # get relations and neighbors with the corresponding ratings
         rated_relations, rated_neighbors = self.get_relations_neighbors_set_with_ratings(relations, neighbors, embeddings)
      
      else:
         return []
               
      # top-n scoring paths
      paths = self.scoring_path(keyword_embeddings=embeddings, reasoning_path=reasoning_path, rated_relations=rated_relations, rated_neighbors=rated_neighbors, hub_node=hub_node, graph=graph)
      
      return paths

   

   def retrieve_nodes_by_text(self, query_text: str, original_question: str, graph: Graph, top_k: int = 5) -> list:
      """
      方案B核心检索方法：关键词硬匹配做主召回，embedding 仅作为补充兜底。
      修正一：原词加权（original_question 中的词得10分，补充词得1分）
      修正二：仅当候选池无原词命中时才触发 embedding
      """
      if not query_text or not query_text.strip():
         return []

      # 1. 提取关键词
      keyword_list = [kw.strip() for kw in query_text.split(',') if kw.strip()]
      if not keyword_list:
         return []

      # 1b. 区分原词（出现在原始问题中）和补充词
      original_keywords = []
      extended_keywords = []
      for kw in keyword_list:
         if kw and kw in original_question:
            original_keywords.append(kw)
         else:
            extended_keywords.append(kw)

      node_ids = list(graph.nodes.keys())
      node_labels = [graph.nodes[nid].attribute for nid in node_ids]

      # 2. 硬匹配：遍历所有节点，分别统计原词和补充词命中数
      match_candidates = []
      for idx, label in enumerate(node_labels):
         if not label:
            continue
         orig_matched = []
         ext_matched = []
         for kw in original_keywords:
            if kw and kw in label:
               orig_matched.append(kw)
         for kw in extended_keywords:
            if kw and kw in label:
               ext_matched.append(kw)
         if orig_matched or ext_matched:
            total_score = len(orig_matched) * 10 + len(ext_matched) * 1
            match_candidates.append({
               "index": idx,
               "node_id": node_ids[idx],
               "label": label,
               "original_match_count": len(orig_matched),
               "extended_match_count": len(ext_matched),
               "total_score": total_score,
               "matched_original": orig_matched,
               "matched_extended": ext_matched,
            })

      # 3. 检查候选池中是否有命中原词的节点
      has_original_match = any(c["original_match_count"] > 0 for c in match_candidates)

      # 4. 如果候选池 >= top_k 且有原词命中，直接按加权得分降序返回
      if len(match_candidates) >= top_k and has_original_match:
         match_candidates.sort(key=lambda x: x["total_score"], reverse=True)
         results = []
         for c in match_candidates[:top_k]:
            parent = self._get_parent_chapter(graph, c["node_id"])
            results.append({
               "node_id": c["node_id"],
               "label": c["label"],
               "parent": parent,
               "score": float(c["total_score"])
            })
         return results

      # 5. 如果不满足上述条件，检查是否需要 embedding 兜底
      #    条件：候选池为空 OR 候选池无任何原词命中
      need_embedding = (len(match_candidates) == 0) or (not has_original_match)

      all_results = []
      for c in match_candidates:
         parent = self._get_parent_chapter(graph, c["node_id"])
         all_results.append({
            "node_id": c["node_id"],
            "label": c["label"],
            "parent": parent,
            "score": float(c["total_score"])
         })

      if need_embedding:
         matched_node_ids = {c["node_id"] for c in match_candidates}
         need = top_k - len(match_candidates)

         query_embedding = self.llm_backbone.get_embeddings([query_text])[0]
         query_embedding = np.array(query_embedding).reshape(1, -1)
         node_embeddings = np.array([graph.nodes[nid].embedding for nid in node_ids])
         similarities = self.cos_simiarlity(query_embedding, node_embeddings)

         ranked = sorted(
            [(node_ids[i], float(similarities[i])) for i in range(len(node_ids))
             if node_ids[i] not in matched_node_ids],
            key=lambda x: x[1], reverse=True
         )
         supplement = ranked[:need]

         for node_id, sim in supplement:
            if node_id in graph.nodes:
               label = graph.nodes[node_id].attribute
               parent = self._get_parent_chapter(graph, node_id)
               all_results.append({
                  "node_id": node_id,
                  "label": label,
                  "parent": parent,
                  "score": sim
               })

      # 6. 去重并返回 top_k
      seen = set()
      unique_results = []
      for r in all_results:
         if r["node_id"] not in seen:
            seen.add(r["node_id"])
            unique_results.append(r)
      return unique_results[:top_k]

   def _get_parent_chapter(self, graph: Graph, node_id: str) -> str:
      """反向查找节点所属章节：同时查 predecessor 和 successor"""
      try:
         # 1. 先查 predecessors（父→子）
         for pred in graph.graph.predecessors(node_id):
            if pred in graph.nodes:
               pred_label = graph.nodes[pred].attribute
               if "节" in pred_label or "section" in pred_label.lower():
                  return pred_label
         # 2. 再查 successors（子→父）
         for succ in graph.graph.successors(node_id):
            if succ in graph.nodes:
               succ_label = graph.nodes[succ].attribute
               if "节" in succ_label or "section" in succ_label.lower():
                  return succ_label
         # 3. 再查 predecessors 的 chapter
         for pred in graph.graph.predecessors(node_id):
            if pred in graph.nodes:
               pred_label = graph.nodes[pred].attribute
               if "章" in pred_label or "chapter" in pred_label.lower():
                  return pred_label
         # 4. 再查 successors 的 chapter
         for succ in graph.graph.successors(node_id):
            if succ in graph.nodes:
               succ_label = graph.nodes[succ].attribute
               if "章" in succ_label or "chapter" in succ_label.lower():
                  return succ_label
      except Exception:
         pass
      return ""

# import unittest
# import networkx as nx
# import numpy as np
# from unittest.mock import Mock, patch

# with open("config.json", "r") as f:
#     config = json.load(f)
    
# os.environ["OPENAI_API_KEY"] = config["OPENAI_API_KEY"]

# class TestPathRAG(unittest.TestCase):
#    def setUp(self):
#       self.args = Mock()
#       self.args.top_n = 5
#       self.path_rag = Path_RAG(self.args)
#       self.graph = nx.Graph()
#       self.graph.add_edge('A', 'B', relation='relation1')
#       self.graph.add_edge('A', 'C', relation='relation2')

#    @patch.object(LLM_Backbone, 'get_embeddings')
#    def test_get_path(self, mock_get_embeddings):
#       mock_get_embeddings.return_value = [np.array([1, 0]), np.array([0, 1]), np.array([0, -1])]
#       paths = self.path_rag.get_path('A', self.graph, 'query')
#       self.assertEqual(len(paths), self.args.top_n)
#       self.assertTrue(all(isinstance(path, tuple) for path in paths))

#    def test_cos_similarity(self):
#       a = np.array([1, 0])
#       b = np.array([[0, 1], [0, -1]])
#       result = self.path_rag.cos_simiarlity(a, b)
#       self.assertEqual(result.shape, (2,))

#    def test_get_entity_edges(self):
#       edges, neighbors = self.path_rag.get_entity_edges('A', self.graph)
#       self.assertEqual(edges, ['relation1', 'relation2'])
#       self.assertEqual(neighbors, ['B', 'C'])

#    def test_has_relation(self):
#       self.assertTrue(self.path_rag.has_relation(self.graph, 'A', 'relation1', 'B'))
#       self.assertFalse(self.path_rag.has_relation(self.graph, 'A', 'relation3', 'B'))

# if __name__ == '__main__':
#    unittest.main()