from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, Sequence

from .models import Asset, SourceType, Task
from .decision_policy import DecisionPolicy, DEFAULT_POLICY


_LATIN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_./:-]*")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


@dataclass(frozen=True)
class RetrievalSignals:
    bm25: float = 0.0
    vector: float = 0.0
    graph: float = 0.0
    rrf: float = 0.0
    combined: float = 0.0


class HybridAssetRetriever:
    """Permission-postfiltered, source-aware hybrid asset container ranker.

    BM25 and a deterministic sparse-vector cosine are computed over accessible
    asset metadata.  Native embedding/graph scores, when produced by the Hub
    data plane, take precedence via ``asset.native_signals``.  RRF combines
    independent rankings without assuming their raw score scales are equal.

    This is deliberately the *container* retrieval stage.  Wiki pages, memory
    chunks, code symbols and Skill bodies remain in their native stores and are
    fetched after selection through the permission-checked retrieval handle.
    """

    def __init__(self, policy: DecisionPolicy = DEFAULT_POLICY):
        self.policy = policy

    def rank(self, task: Task, assets: Sequence[Asset]) -> Dict[str, RetrievalSignals]:
        if not assets:
            return {}
        query = " ".join([task.title, task.description, task.repository, *task.target_paths])
        query_terms = tokenize(query)
        documents = {asset.asset_id: tokenize(_asset_text(asset)) for asset in assets}
        local_bm25 = _bm25(query_terms, documents)
        bm25 = {
            asset.asset_id: _blend_native(asset.native_signals.get("bm25"), local_bm25.get(asset.asset_id, 0.0))
            for asset in assets
        }
        sparse_vector = _tfidf_cosine(query_terms, documents)
        vector = {
            asset.asset_id: _blend_native(asset.native_signals.get("vector"), sparse_vector.get(asset.asset_id, 0.0))
            for asset in assets
        }
        graph = {asset.asset_id: _graph_score(task, asset, query_terms) for asset in assets}

        rankings: list[tuple[float, list[str]]] = [
            (1.0, _positive_rank(bm25)),
            (0.85 if self.policy.retrieval == "legacy" else 1.0, _positive_rank(vector)),
            (0.75 if self.policy.retrieval == "legacy" else 1.0, _positive_rank(graph)),
        ]
        rrf_raw: Dict[str, float] = defaultdict(float)
        for weight, ranking in rankings:
            for rank, asset_id in enumerate(ranking, start=1):
                rrf_raw[asset_id] += weight / ((60 if self.policy.retrieval == "legacy" else self.policy.rrf_k) + rank)
        rrf = _normalize(rrf_raw)

        result: Dict[str, RetrievalSignals] = {}
        for asset in assets:
            asset_id = asset.asset_id
            bm = bm25.get(asset_id, 0.0)
            vec = vector.get(asset_id, 0.0)
            gr = graph.get(asset_id, 0.0)
            fusion = rrf.get(asset_id, 0.0)
            combined = (bm * 0.34 + vec * 0.24 + gr * 0.16 + fusion * 0.26
                        if self.policy.retrieval == "legacy" else bm if self.policy.retrieval == "bm25" else fusion)
            result[asset_id] = RetrievalSignals(
                bm25=round(bm, 4),
                vector=round(vec, 4),
                graph=round(gr, 4),
                rrf=round(fusion, 4),
                combined=round(combined, 4),
            )
        return result

    @staticmethod
    def recalled_candidates(
        assets: Sequence[Asset],
        signals: Mapping[str, RetrievalSignals],
        *,
        limit: int,
    ) -> list[Asset]:
        ranked = sorted(
            assets,
            key=lambda asset: (-signals.get(asset.asset_id, RetrievalSignals()).combined, asset.asset_id),
        )
        # Keep source diversity at candidate generation time.  Otherwise a
        # large Wiki pool can crowd CodeGraph/Skill/Memory out before the
        # minimum-context selector gets a chance to compare them.
        source_floor: list[Asset] = []
        for source in SourceType:
            source_floor.extend([asset for asset in ranked if asset.source_type is source][:2])
        keep = {asset.asset_id for asset in source_floor}
        for asset in ranked:
            if len(keep) >= max(1, limit):
                break
            keep.add(asset.asset_id)
        return [asset for asset in ranked if asset.asset_id in keep][: max(limit, len(source_floor))]


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    tokens = _LATIN_RE.findall(lowered)
    for segment in _CJK_RE.findall(lowered):
        tokens.append(segment)
        if len(segment) > 1:
            tokens.extend(segment[index:index + 2] for index in range(len(segment) - 1))
    return tokens


def _asset_text(asset: Asset) -> str:
    handle_terms = " ".join(_flatten_strings(asset.retrieval_handle))
    return " ".join([
        asset.title,
        asset.claim,
        asset.action,
        asset.source_ref,
        handle_terms,
        *asset.keywords,
        *asset.paths,
        *asset.tests,
        *asset.risks,
    ])


def _flatten_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _flatten_strings(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            yield from _flatten_strings(item)


def _bm25(query: Sequence[str], documents: Mapping[str, Sequence[str]]) -> Dict[str, float]:
    if not query or not documents:
        return {asset_id: 0.0 for asset_id in documents}
    document_frequency: Counter[str] = Counter()
    lengths: Dict[str, int] = {}
    term_frequencies: Dict[str, Counter[str]] = {}
    for asset_id, terms in documents.items():
        term_frequencies[asset_id] = Counter(terms)
        lengths[asset_id] = len(terms)
        document_frequency.update(set(terms))
    average_length = sum(lengths.values()) / max(1, len(lengths))
    n = len(documents)
    scores: Dict[str, float] = {}
    for asset_id, frequencies in term_frequencies.items():
        score = 0.0
        for term in set(query):
            frequency = frequencies.get(term, 0)
            if frequency <= 0:
                continue
            df = document_frequency.get(term, 0)
            inverse = math.log(1.0 + (n - df + 0.5) / (df + 0.5))
            denominator = frequency + 1.5 * (1.0 - 0.75 + 0.75 * lengths[asset_id] / max(1.0, average_length))
            score += inverse * frequency * 2.5 / denominator
        scores[asset_id] = score
    return _normalize(scores)


def _tfidf_cosine(query: Sequence[str], documents: Mapping[str, Sequence[str]]) -> Dict[str, float]:
    if not query or not documents:
        return {asset_id: 0.0 for asset_id in documents}
    n = len(documents)
    df: Counter[str] = Counter()
    for terms in documents.values():
        df.update(set(terms))
    idf = {term: math.log((n + 1.0) / (count + 1.0)) + 1.0 for term, count in df.items()}
    query_vector = _weighted_vector(Counter(query), idf)
    result: Dict[str, float] = {}
    for asset_id, terms in documents.items():
        vector = _weighted_vector(Counter(terms), idf)
        result[asset_id] = _cosine(query_vector, vector)
    return result


def _weighted_vector(counts: Counter[str], idf: Mapping[str, float]) -> Dict[str, float]:
    return {term: (1.0 + math.log(count)) * idf.get(term, 1.0) for term, count in counts.items() if count > 0}


def _cosine(left: Mapping[str, float], right: Mapping[str, float]) -> float:
    numerator = sum(value * right.get(term, 0.0) for term, value in left.items())
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    return numerator / (left_norm * right_norm) if left_norm and right_norm else 0.0


def _graph_score(task: Task, asset: Asset, query_terms: Sequence[str]) -> float:
    native = asset.native_signals.get("graph")
    if native is not None:
        return max(0.0, min(1.0, native))
    if asset.source_type not in {SourceType.CODE_GRAPH, SourceType.WIKI}:
        return 0.0
    query = set(query_terms)
    structural = set(tokenize(" ".join([*asset.paths, *asset.keywords, asset.source_ref])))
    overlap = len(query & structural) / max(1, len(query | structural))
    exact_path = bool(set(task.target_paths) & set(asset.paths))
    same_module = any(
        requested.split("/", 1)[0] == candidate.split("/", 1)[0]
        for requested in task.target_paths
        for candidate in asset.paths
        if requested and candidate
    )
    bonus = 0.65 if exact_path else (0.35 if same_module else 0.0)
    if asset.source_type is SourceType.WIKI:
        # Wiki graph contribution is only a weak signal unless upstream
        # supplies an actual link-graph score.
        bonus *= 0.45
    return min(1.0, overlap * 2.0 + bonus)


def _blend_native(native: float | None, local: float) -> float:
    if native is None:
        return local
    return max(0.0, min(1.0, native * 0.8 + local * 0.2))


def _positive_rank(scores: Mapping[str, float]) -> list[str]:
    return [asset_id for asset_id, score in sorted(scores.items(), key=lambda item: (-item[1], item[0])) if score > 0]


def _normalize(scores: Mapping[str, float]) -> Dict[str, float]:
    maximum = max(scores.values(), default=0.0)
    if maximum <= 0:
        return {key: 0.0 for key in scores}
    return {key: max(0.0, value / maximum) for key, value in scores.items()}
