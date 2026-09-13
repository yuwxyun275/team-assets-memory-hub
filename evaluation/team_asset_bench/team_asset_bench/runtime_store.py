from __future__ import annotations

import json
import sqlite3
import threading
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .ledger import EvidenceLedger
from .models import (
    Asset,
    AssetEvent,
    AssetState,
    ContextPackage,
    Selection,
    SelectionFeatures,
    Task,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SqliteEvidenceLedger(EvidenceLedger):
    """Transactional, idempotent evidence ledger for the runtime service."""

    def __init__(self, path: Path) -> None:
        super().__init__(None)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._db_lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS evidence_events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id TEXT NOT NULL UNIQUE,
              trace_id TEXT NOT NULL,
              task_id TEXT NOT NULL,
              asset_id TEXT NOT NULL,
              state TEXT NOT NULL,
              actor_type TEXT NOT NULL,
              actor_id TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              target TEXT,
              decision TEXT,
              evidence_ref TEXT,
              detail_json TEXT NOT NULL,
              UNIQUE(trace_id, task_id, asset_id, state)
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_evidence_trace ON evidence_events(trace_id, task_id, seq)"
        )
        self._conn.commit()

    def append(
        self,
        *,
        trace_id: str,
        task_id: str,
        asset_id: str,
        state: AssetState,
        actor_type: str,
        actor_id: str,
        target: Optional[str] = None,
        decision: Optional[str] = None,
        evidence_ref: Optional[str] = None,
        detail: Optional[Dict[str, object]] = None,
    ) -> AssetEvent:
        with self._db_lock:
            existing = self._conn.execute(
                """
                SELECT * FROM evidence_events
                WHERE trace_id=? AND task_id=? AND asset_id=? AND state=?
                """,
                (trace_id, task_id, asset_id, state.value),
            ).fetchone()
            if existing is not None:
                return self._row_to_event(existing)
            previous = self.latest_state(trace_id, task_id, asset_id)
            self._validate_transition(previous, state, target, decision, evidence_ref)
            event = AssetEvent(
                event_id=f"evt-{uuid.uuid4().hex[:16]}",
                trace_id=trace_id,
                task_id=task_id,
                asset_id=asset_id,
                state=state,
                actor_type=actor_type,
                actor_id=actor_id,
                timestamp=_utc_now(),
                target=target,
                decision=decision,
                evidence_ref=evidence_ref,
                detail=dict(detail or {}),
            )
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO evidence_events(
                      event_id, trace_id, task_id, asset_id, state, actor_type,
                      actor_id, timestamp, target, decision, evidence_ref, detail_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        event.event_id,
                        event.trace_id,
                        event.task_id,
                        event.asset_id,
                        event.state.value,
                        event.actor_type,
                        event.actor_id,
                        event.timestamp,
                        event.target,
                        event.decision,
                        event.evidence_ref,
                        json.dumps(event.detail, ensure_ascii=False, sort_keys=True),
                    ),
                )
            return event

    def latest_state(self, trace_id: str, task_id: str, asset_id: str) -> Optional[AssetState]:
        with self._db_lock:
            row = self._conn.execute(
                """
                SELECT state FROM evidence_events
                WHERE trace_id=? AND task_id=? AND asset_id=?
                ORDER BY seq DESC LIMIT 1
                """,
                (trace_id, task_id, asset_id),
            ).fetchone()
        return AssetState(str(row["state"])) if row is not None else None

    def events(
        self,
        *,
        trace_id: Optional[str] = None,
        task_id: Optional[str] = None,
        asset_id: Optional[str] = None,
    ) -> List[AssetEvent]:
        clauses: List[str] = []
        values: List[str] = []
        for field, value in (("trace_id", trace_id), ("task_id", task_id), ("asset_id", asset_id)):
            if value is not None:
                clauses.append(f"{field}=?")
                values.append(value)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._db_lock:
            rows = self._conn.execute(
                f"SELECT * FROM evidence_events{where} ORDER BY seq", values
            ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def replace_events(self, events: Iterable[AssetEvent]) -> None:
        with self._db_lock, self._conn:
            self._conn.execute("DELETE FROM evidence_events")
            for event in events:
                self._conn.execute(
                    """
                    INSERT OR IGNORE INTO evidence_events(
                      event_id, trace_id, task_id, asset_id, state, actor_type,
                      actor_id, timestamp, target, decision, evidence_ref, detail_json
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        event.event_id, event.trace_id, event.task_id, event.asset_id,
                        event.state.value, event.actor_type, event.actor_id, event.timestamp,
                        event.target, event.decision, event.evidence_ref,
                        json.dumps(event.detail, ensure_ascii=False, sort_keys=True),
                    ),
                )

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> AssetEvent:
        return AssetEvent(
            event_id=str(row["event_id"]),
            trace_id=str(row["trace_id"]),
            task_id=str(row["task_id"]),
            asset_id=str(row["asset_id"]),
            state=AssetState(str(row["state"])),
            actor_type=str(row["actor_type"]),
            actor_id=str(row["actor_id"]),
            timestamp=str(row["timestamp"]),
            target=row["target"],
            decision=row["decision"],
            evidence_ref=row["evidence_ref"],
            detail=json.loads(str(row["detail_json"] or "{}")),
        )


class RuntimeStore:
    """Durable state needed to resume a trace after orchestrator restart."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS trace_runtime (
              trace_id TEXT PRIMARY KEY,
              package_json TEXT NOT NULL,
              response_json TEXT NOT NULL,
              external_binding_json TEXT NOT NULL,
              profile_json TEXT NOT NULL,
              contract_json TEXT NOT NULL,
              execution_json TEXT NOT NULL,
              candidate_json TEXT,
              comparison_json TEXT,
              updated_at TEXT NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS turn_runtime (
              turn_id TEXT PRIMARY KEY,
              trace_id TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL,
              turn_seq INTEGER NOT NULL,
              task_id TEXT NOT NULL,
              team_id TEXT NOT NULL,
              agent_id TEXT NOT NULL,
              query_hash TEXT NOT NULL,
              query_preview TEXT NOT NULL,
              context_json TEXT NOT NULL,
              receipt_json TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_session ON turn_runtime(session_id, turn_seq)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_task ON turn_runtime(task_id, turn_seq)"
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS asset_feedback (
              feedback_id TEXT PRIMARY KEY,
              turn_id TEXT NOT NULL,
              trace_id TEXT NOT NULL,
              asset_id TEXT NOT NULL,
              signal TEXT NOT NULL,
              source TEXT NOT NULL,
              weight REAL NOT NULL,
              repository TEXT NOT NULL,
              version TEXT NOT NULL,
              task_type TEXT NOT NULL,
              module TEXT NOT NULL,
              reason TEXT NOT NULL,
              evidence_ref TEXT,
              created_at TEXT NOT NULL,
              UNIQUE(turn_id, asset_id, signal, source)
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_feedback_asset ON asset_feedback(asset_id, created_at)"
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ci_runs (
              run_id TEXT PRIMARY KEY,
              trace_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              status TEXT NOT NULL,
              commit_sha TEXT NOT NULL,
              checks_json TEXT NOT NULL,
              changed_paths_json TEXT NOT NULL,
              attestation_json TEXT NOT NULL DEFAULT '{}',
              evidence_ref TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ci_trace ON ci_runs(trace_id, created_at)"
        )
        ci_columns = {
            str(row[1]) for row in self._conn.execute("PRAGMA table_info(ci_runs)").fetchall()
        }
        if "attestation_json" not in ci_columns:
            self._conn.execute(
                "ALTER TABLE ci_runs ADD COLUMN attestation_json TEXT NOT NULL DEFAULT '{}'"
            )
        self._conn.commit()

    def save_trace(
        self,
        trace_id: str,
        *,
        package: ContextPackage,
        response: Dict[str, Any],
        external_binding: Dict[str, str],
        profile: Dict[str, Any],
        contract: Dict[str, Any],
        execution: Dict[str, Any],
        candidate: Optional[Dict[str, Any]] = None,
        comparison: Optional[Dict[str, Any]] = None,
    ) -> None:
        values = (
            trace_id,
            _dump(package.to_dict()),
            _dump(response),
            _dump(external_binding),
            _dump(profile),
            _dump(contract),
            _dump(execution),
            _dump(candidate) if candidate is not None else None,
            _dump(comparison) if comparison is not None else None,
            _utc_now(),
        )
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO trace_runtime(
                  trace_id, package_json, response_json, external_binding_json,
                  profile_json, contract_json, execution_json, candidate_json,
                  comparison_json, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(trace_id) DO UPDATE SET
                  package_json=excluded.package_json,
                  response_json=excluded.response_json,
                  external_binding_json=excluded.external_binding_json,
                  profile_json=excluded.profile_json,
                  contract_json=excluded.contract_json,
                  execution_json=excluded.execution_json,
                  candidate_json=COALESCE(excluded.candidate_json, trace_runtime.candidate_json),
                  comparison_json=COALESCE(excluded.comparison_json, trace_runtime.comparison_json),
                  updated_at=excluded.updated_at
                """,
                values,
            )

    def load_traces(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM trace_runtime ORDER BY updated_at").fetchall()
        result: List[Dict[str, Any]] = []
        for row in rows:
            result.append(
                {
                    "trace_id": str(row["trace_id"]),
                    "package": context_package_from_dict(_load(row["package_json"])),
                    "response": _load(row["response_json"]),
                    "external_binding": _load(row["external_binding_json"]),
                    "profile": _load(row["profile_json"]),
                    "contract": _load(row["contract_json"]),
                    "execution": _load(row["execution_json"]),
                    "candidate": _load(row["candidate_json"]) if row["candidate_json"] else None,
                    "comparison": _load(row["comparison_json"]) if row["comparison_json"] else None,
                }
            )
        return result

    def ping(self) -> bool:
        with self._lock:
            return self._conn.execute("SELECT 1").fetchone()[0] == 1

    def trace_count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM trace_runtime").fetchone()[0])

    def save_turn(self, value: Dict[str, Any]) -> None:
        now = _utc_now()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO turn_runtime(
                  turn_id, trace_id, session_id, turn_seq, task_id, team_id,
                  agent_id, query_hash, query_preview, context_json,
                  receipt_json, status, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(turn_id) DO UPDATE SET
                  query_hash=excluded.query_hash,
                  query_preview=excluded.query_preview,
                  context_json=excluded.context_json,
                  updated_at=excluded.updated_at
                """,
                (
                    str(value["turn_id"]), str(value["trace_id"]), str(value["session_id"]),
                    int(value["turn_seq"]), str(value["task_id"]), str(value["team_id"]),
                    str(value["agent_id"]), str(value["query_hash"]), str(value["query_preview"]),
                    _dump(dict(value.get("context") or {})), None, "active", now, now,
                ),
            )

    def update_turn_receipt(self, trace_id: str, receipt: Dict[str, Any]) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE turn_runtime SET receipt_json=?, updated_at=? WHERE trace_id=?",
                (_dump(receipt), _utc_now(), trace_id),
            )

    def turn_for_trace(self, trace_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM turn_runtime WHERE trace_id=?", (trace_id,)
            ).fetchone()
        return self._turn_row(row) if row is not None else None

    def list_turns(
        self,
        *,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        clauses: List[str] = []
        values: List[str] = []
        if session_id:
            clauses.append("session_id=?")
            values.append(session_id)
        if task_id:
            clauses.append("task_id=?")
            values.append(task_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM turn_runtime{where} ORDER BY turn_seq, created_at", values
            ).fetchall()
        return [self._turn_row(row) for row in rows]

    def close_turn(self, turn_id: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE turn_runtime SET status='closed', updated_at=? WHERE turn_id=?",
                (_utc_now(), turn_id),
            )

    def append_feedback(self, value: Dict[str, Any]) -> bool:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                """
                INSERT OR IGNORE INTO asset_feedback(
                  feedback_id, turn_id, trace_id, asset_id, signal, source,
                  weight, repository, version, task_type, module, reason,
                  evidence_ref, created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    str(value.get("feedback_id") or f"fb-{uuid.uuid4().hex[:16]}"),
                    str(value["turn_id"]), str(value["trace_id"]), str(value["asset_id"]),
                    str(value["signal"]), str(value.get("source") or "explicit"),
                    float(value.get("weight") or 0.0), str(value.get("repository") or "*"),
                    str(value.get("version") or "*"), str(value.get("task_type") or "*"),
                    str(value.get("module") or "*"), str(value.get("reason") or "")[:1200],
                    str(value.get("evidence_ref") or "") or None, _utc_now(),
                ),
            )
        return cursor.rowcount > 0

    def feedback_for_turn(self, turn_id: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM asset_feedback WHERE turn_id=? ORDER BY created_at", (turn_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def contextual_effects(self, task: Task, asset_ids: Iterable[str]) -> Dict[str, float]:
        """Return context-local utility priors with decay and Bayesian shrinkage.

        A signal from another repository/version/module is intentionally weak;
        one negative recommendation can therefore never globally bury an asset.
        """
        ids = [str(item) for item in asset_ids if str(item)]
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM asset_feedback WHERE asset_id IN ({placeholders})",
                ids,
            ).fetchall()
        modules = {path.split("/", 1)[0] for path in task.target_paths if path}
        result: Dict[str, List[float]] = {}
        now = datetime.now(timezone.utc)
        for row in rows:
            match = 0.2
            if str(row["repository"]) in {"*", task.repository}:
                match += 0.25
            if str(row["version"]) in {"*", task.version}:
                match += 0.2
            if str(row["task_type"]) in {"*", task.task_type}:
                match += 0.2
            if str(row["module"]) == "*" or str(row["module"]) in modules:
                match += 0.15
            try:
                created = datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))
                age_days = max(0.0, (now - created).total_seconds() / 86400)
                decay = math.exp(-age_days / 180.0)
            except ValueError:
                decay = 0.5
            source = str(row["source"])
            source_reliability = (
                1.0 if source == "explicit_user"
                else 0.85 if source == "evidence_ledger"
                else 0.6 if source in {"explicit_agent", "explicit_user_or_agent"}
                else 0.0 if source == "implicit_turn_close"
                else 0.6
            )
            result.setdefault(str(row["asset_id"]), []).append(
                float(row["weight"]) * match * decay * source_reliability
            )
        effects: Dict[str, float] = {}
        for asset_id, values in result.items():
            total = sum(values)
            # This is a context-local delta, not a replacement for the asset's
            # reviewed historical prior. Four virtual observations prevent one
            # noisy click from dominating future recommendations.
            effects[asset_id] = round(min(0.35, max(-0.35, 0.45 * total / (4.0 + abs(total)))), 4)
        return effects

    def save_ci_run(self, value: Dict[str, Any]) -> bool:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                """
                INSERT OR IGNORE INTO ci_runs(
                  run_id, trace_id, turn_id, provider, status, commit_sha,
                  checks_json, changed_paths_json, attestation_json, evidence_ref, created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    str(value["run_id"]), str(value["trace_id"]), str(value.get("turn_id") or ""),
                    str(value.get("provider") or "local"), str(value.get("status") or "unknown"),
                    str(value.get("commit_sha") or ""), _dump({"checks": value.get("checks") or []}),
                    _dump({"paths": value.get("changed_paths") or []}),
                    _dump({
                        "pipeline_ref": value.get("pipeline_ref") or "",
                        "provider_event_id": value.get("provider_event_id") or "",
                        "webhook_verified": value.get("webhook_verified") is True,
                        "trusted_for_validation": value.get("trusted_for_validation") is True,
                        "verification_discovery": value.get("verification_discovery") or {},
                        "regression_proof": value.get("regression_proof") or {},
                        "execution_origin": value.get("execution_origin") or "",
                        "runner_identity": value.get("runner_identity") or "",
                    }),
                    str(value["evidence_ref"]),
                    str(value.get("created_at") or _utc_now()),
                ),
            )
        return cursor.rowcount > 0

    def ci_runs(self, trace_id: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM ci_runs WHERE trace_id=? ORDER BY created_at", (trace_id,)
            ).fetchall()
        return [
            ({
                "run_id": str(row["run_id"]),
                "trace_id": str(row["trace_id"]),
                "turn_id": str(row["turn_id"]),
                "provider": str(row["provider"]),
                "status": str(row["status"]),
                "commit_sha": str(row["commit_sha"]),
                "checks": (_load(row["checks_json"]).get("checks") or []),
                "changed_paths": (_load(row["changed_paths_json"]).get("paths") or []),
                "evidence_ref": str(row["evidence_ref"]),
                "created_at": str(row["created_at"]),
            } | (_load(row["attestation_json"]) if row["attestation_json"] else {}))
            for row in rows
        ]

    @staticmethod
    def _turn_row(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "turn_id": str(row["turn_id"]),
            "trace_id": str(row["trace_id"]),
            "session_id": str(row["session_id"]),
            "turn_seq": int(row["turn_seq"]),
            "task_id": str(row["task_id"]),
            "team_id": str(row["team_id"]),
            "agent_id": str(row["agent_id"]),
            "query_hash": str(row["query_hash"]),
            "query_preview": str(row["query_preview"]),
            "context": _load(row["context_json"]),
            "receipt": _load(row["receipt_json"]) if row["receipt_json"] else None,
            "status": str(row["status"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def context_package_from_dict(value: Dict[str, Any]) -> ContextPackage:
    def selections(items: Any) -> List[Selection]:
        result: List[Selection] = []
        for item in items if isinstance(items, list) else []:
            result.append(
                Selection(
                    asset=Asset.from_dict(dict(item["asset"])),
                    score=float(item.get("score", 0)),
                    features=SelectionFeatures(**dict(item.get("features") or {})),
                    selected=bool(item.get("selected")),
                    reasons=[str(reason) for reason in item.get("reasons", [])],
                    rank=int(item.get("rank", 0)),
                )
            )
        return result

    return ContextPackage(
        trace_id=str(value["trace_id"]),
        task=Task.from_dict(dict(value["task"])),
        recalled=selections(value.get("recalled")),
        selected=selections(value.get("selected")),
        rejected=selections(value.get("rejected")),
        token_cost=int(value.get("token_cost", 0)),
        markdown=str(value.get("markdown", "")),
    )


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _load(value: Any) -> Dict[str, Any]:
    parsed = json.loads(str(value or "{}"))
    return parsed if isinstance(parsed, dict) else {}
